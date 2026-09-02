// missionParser.js - Endless Sky mission/job-board DEFINITION parser
// (plugin-source side only)
//
// REWRITE: previously this file used one hand-written regex per field it
// cared about (cargo, payment, deadline, source/destination, give ship/
// outfit...) and silently walked past every line that didn't match one of
// those regexes. That meant conversation text, `choice`/`branch`/`label`/
// `goto`, `action` blocks, `karma`, `log`, `clearance`, `blocked`, and any
// future/unknown keyword were parsed into nothing - present in the source
// file, absent from the output.
//
// This version instead walks the mission body generically by INDENTATION
// ALONE, with no hardcoded list of "known" keywords: every line becomes
//   { key, values, children }
// where `key` is the line's first token, `values` is every remaining token
// on that line (numbers coerced, quoted phrases kept whole - so a line with
// several values like `event "X" 60 420` keeps ALL of them, not just the
// first), and `children` is the same shape recursively for whatever is
// indented one level deeper (or null if nothing is). A bare quoted/backtick
// dialogue line with no separate keyword (e.g. a conversation text line)
// becomes its own entry with that text AS the key and empty values - there
// is no separate "line" or "text" field name used elsewhere, so every
// single line in the file is captured the exact same shape, however deeply
// nested, however many values it carries.
//
// `mission.raw` holds this complete, nothing-left-out tree. On top of that,
// this module still derives the same typed/convenient fields as before
// (cargo, passengers, payment, rewards, source/destination, npc detection,
// event triggers...) by WALKING `raw` rather than re-scanning text, so nothing
// needs to be parsed twice and the derived fields can never disagree with
// what's actually in `raw`.

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Indentation + tokenizing helpers
// ---------------------------------------------------------------------------

function indentOf(line) {
  return line.length - line.replace(/^\t+/, '').length;
}

/**
 * Tokenize one already-trimmed line the way Endless Sky's own data-file
 * reader does: a "..." or `...` or '...' run is ONE token (spaces inside
 * don't split it), everything else splits on whitespace. This is the only
 * place that needs to understand ES syntax - everything above this just
 * consumes whatever tokens come out.
 */
function tokenizeESLine(line) {
  const tokens = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    const ch = line[i];
    if (ch === '"' || ch === '`' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n && line[j] !== quote) j++;
      tokens.push(line.slice(i + 1, j));
      i = (j < n) ? j + 1 : j;
    } else {
      let j = i;
      while (j < n && !/\s/.test(line[j])) j++;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

function coerceToken(tok) {
  if (tok !== '' && /^-?\d+(\.\d+)?$/.test(tok)) return parseFloat(tok);
  return tok;
}

/**
 * Build the generic { key, values, children } tree for every line at
 * exactly `baseIndent` starting at `startIdx`, recursing into deeper
 * indentation as children. Comment lines (`#...`) and blank lines are
 * skipped entirely (never produce an entry). Returns [entries, nextIndex].
 */
function parseIndentTree(lines, startIdx, baseIndent) {
  const entries = [];
  let i = startIdx;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim()) { i++; continue; }
    const indent = indentOf(raw);
    if (indent < baseIndent) break;
    const stripped = raw.trim();
    if (stripped.startsWith('#')) { i++; continue; }

    const tokens = tokenizeESLine(stripped);
    const key = tokens.length > 0 ? tokens[0] : stripped;
    const values = tokens.slice(1).map(coerceToken);
    i++;

    // Peek past blank lines to see whether a deeper-indented child block
    // follows this line (blank lines between a header and its first child,
    // e.g. before a `label`, are common and must not break the nesting).
    let k = i;
    while (k < lines.length && !lines[k].trim()) k++;
    let children = null;
    if (k < lines.length && indentOf(lines[k]) > baseIndent) {
      const [childEntries, ni] = parseIndentTree(lines, k, indentOf(lines[k]));
      children = childEntries;
      i = ni;
    }
    entries.push({ key, values, children });
  }
  return [entries, i];
}

/** Recursively visit every entry in a tree (entry itself, then its
 *  children, depth-first) - used to find things like `event "X"` or
 *  `payment ...` no matter how deep inside conversation/action/branch
 *  nesting they are. */
function walkAll(entries, visit) {
  if (!entries) return;
  for (const entry of entries) {
    visit(entry);
    if (entry.children) walkAll(entry.children, visit);
  }
}

function findTop(entries, key) {
  return entries.find(e => e.key === key) || null;
}
function findAllTop(entries, key) {
  return entries.filter(e => e.key === key);
}

function hashTree(entries) {
  return crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

/** Named nested-reference shape - { name, count, pluginId, internalId }.
 *  pluginId/internalId start null for anything that may be owned by
 *  ANOTHER plugin (outfits, ships, planets) - filled in later by this
 *  module's resolve*() passes against other parsers' registries. */
function namedRef(name, extra = {}) {
  return { name, count: 1, pluginId: null, internalId: null, ...extra };
}

const LOCATION_TAGS = new Set([
  'job', 'landing', 'assisting', 'boarding', 'shipyard',
  'outfitter', 'job board', 'entering', 'transition',
]);

const ON_TRIGGER_NAMES = new Set([
  'offer', 'accept', 'decline', 'defer', 'fail', 'abort',
  'visit', 'stopover', 'waypoint', 'complete', 'enter',
]);

// Keys handled explicitly by the typed-field derivation below - everything
// else at the top level of a mission body falls through into the generic
// `flags` bag instead of being silently dropped.
const TOP_LEVEL_HANDLED_KEYS = new Set([
  'name', 'description', 'cargo', 'passengers', 'source', 'destination',
  'stopover', 'waypoint', 'npc', 'on', 'to', 'repeat', 'illegal', 'deadline',
  'apparent payment',
]);

const SIDE_EFFECT_KEYWORDS = /salary|income|wage/i;

// ---------------------------------------------------------------------------
class EndlessSkyMissionParser {
  constructor() {
    this.missions = [];
    this.missionById = new Map();
    this.missionsByName = new Map();

    this._sourcePriority = new Map();
    this.collisions = [];
  }

  setSourcePriority(sources) {
    this._sourcePriority.clear();
    sources.forEach((source, index) => this._sourcePriority.set(source.name, index));
  }

  _registerMission(mission, pluginId) {
    const internalId = `${pluginId}::${mission.name}`;
    mission._pluginId = pluginId;
    mission._internalId = internalId;
    mission._hash = hashTree(mission.raw);
    mission.sourcePlugin = pluginId;
    this.missionById.set(internalId, mission);
    if (!this.missionsByName.has(mission.name)) this.missionsByName.set(mission.name, []);
    this.missionsByName.get(mission.name).push(mission);
    return internalId;
  }

  register(mission, pluginId) {
    this._registerMission(mission, pluginId);
    this.missions.push(mission);
    return mission;
  }

  // =========================================================================
  // 1/2/3-number range resolver for `cargo`/`passengers`
  // (fixed / uniform / negative-binomial).
  // =========================================================================
  _resolveRangeSpec(commodity, nums) {
    const clean = nums.filter(n => typeof n === 'number' && !Number.isNaN(n));
    const base = commodity !== null ? { commodity } : {};
    if (clean.length === 0) return { ...base, min: 0, max: 0, mode: 'fixed', nbParams: null };
    if (clean.length === 1) return { ...base, min: clean[0], max: clean[0], mode: 'fixed', nbParams: null };
    if (clean.length === 2) return { ...base, min: clean[0], max: clean[1], mode: 'uniform', nbParams: null };
    const [n1, r, p] = clean;
    const mean = n1 + (r * (1 - p)) / p;
    const variance = p > 0 ? (r * (1 - p)) / (p * p) : 0;
    const softMax = Math.round(mean + 3 * Math.sqrt(variance));
    return { ...base, min: n1, max: null, expected: Math.round(mean), softMax, mode: 'negative-binomial', nbParams: { r, p } };
  }

  // =========================================================================
  // mission "<name>" ... - parse the header, build the full generic tree
  // for everything under it, then derive typed fields from that tree.
  // =========================================================================
  parseMissionBlock(lines, i, pluginId) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^mission\s+"([^"]+)"/) || headerLine.match(/^mission\s+`([^`]+)`/);
    const missionName = nameMatch ? nameMatch[1] : null;
    const baseIndent = indentOf(lines[i]);
    if (!missionName) {
      // Not a real mission header - skip whatever block follows so the
      // caller's line index still advances sensibly.
      const [, ni] = parseIndentTree(lines, i + 1, baseIndent + 1);
      return [null, ni];
    }

    const [raw, ni] = parseIndentTree(lines, i + 1, baseIndent + 1);

    const mission = {
      name: missionName,
      displayName: null,
      description: null,
      raw,
      locations: [],
      flags: {},
      repeatable: false,
      repeatLimit: null,
      illegal: null,
      deadline: null,
      cargo: null,
      passengers: null,
      conditions: {},        // { offer: [...raw...], complete: [...], fail: [...], accept: [...], display: [...] }
      payment: { apparentPayment: null, triggers: {} },
      source: null,
      destination: null,
      stopovers: [],
      waypoints: [],
      rewards: { outfits: [], ships: [] },
      hasNpcObjective: false,
      npcCount: 0,
      conditionSideEffects: [],
      eventTriggers: [],
    };

    this._deriveFields(mission, raw);
    return [mission, ni];
  }

  _deriveFields(mission, raw) {
    for (const entry of raw) {
      const { key, values, children } = entry;

      if (key === 'name') { mission.displayName = values[0] ?? null; continue; }
      if (key === 'description') { mission.description = values[0] ?? null; continue; }

      if (LOCATION_TAGS.has(key) && values.length === 0 && !children) {
        mission.locations.push(key);
        continue;
      }

      if (key === 'repeat') {
        mission.repeatable = true;
        mission.repeatLimit = typeof values[0] === 'number' ? values[0] : null;
        continue;
      }

      if (key === 'illegal') {
        mission.illegal = { fine: values[0] ?? null, message: values[1] ?? null };
        continue;
      }

      if (key === 'deadline') {
        mission.deadline = mission.deadline || { days: 0, multiplier: 2 };
        if (typeof values[0] === 'number') mission.deadline.days += values[0];
        if (typeof values[1] === 'number') mission.deadline.multiplier = values[1];
        continue;
      }

      if (key === 'apparent payment') {
        mission.payment.apparentPayment = typeof values[0] === 'number' ? values[0] : null;
        continue;
      }

      if (key === 'cargo') {
        const commodity = values[0] ?? null;
        mission.cargo = this._resolveRangeSpec(commodity, values.slice(1));
        continue;
      }

      if (key === 'passengers') {
        mission.passengers = this._resolveRangeSpec(null, values);
        continue;
      }

      if (key === 'source' || key === 'destination') {
        const ref = this._locationRefFromEntry(entry);
        mission[key] = ref;
        continue;
      }
      if (key === 'stopover') {
        const ref = this._locationRefFromEntry(entry);
        if (ref && ref.type === 'planet') mission.stopovers.push(namedRef(ref.value));
        continue;
      }
      if (key === 'waypoint') {
        const ref = this._locationRefFromEntry(entry);
        if (ref && ref.type === 'planet') mission.waypoints.push(namedRef(ref.value));
        continue;
      }

      if (key === 'npc') {
        mission.hasNpcObjective = true;
        mission.npcCount++;
        continue;
      }

      if (key === 'to') {
        // `to offer` / `to complete` / `to fail` / `to accept` / `to display` -
        // condition sets. Kept as the raw sub-tree, since these are boolean
        // trees (has/not/or/and/random</>=) that vary arbitrarily in shape.
        const condName = values[0] ?? 'unknown';
        mission.conditions[condName] = children || [];
        continue;
      }

      if (key === 'on') {
        const triggerRaw = values[0] ?? 'unknown';
        const triggerKey = 'on' + triggerRaw.charAt(0).toUpperCase() + triggerRaw.slice(1);
        this._deriveTrigger(mission, triggerKey, entry);
        continue;
      }

      // Anything not explicitly modeled above still isn't dropped - it goes
      // into the generic flags bag under its own literal key, so `autosave`,
      // `clearance`, `blocked "..."`, `mark "X"` (repeatable, becomes an
      // array), `karma ++`, `log "..."`, etc. are all still present in the
      // output even though this module has no bespoke field for them.
      if (!TOP_LEVEL_HANDLED_KEYS.has(key)) {
        const value = children ? children : (values.length === 0 ? true : (values.length === 1 ? values[0] : values));
        if (key in mission.flags) {
          if (!Array.isArray(mission.flags[key])) mission.flags[key] = [mission.flags[key]];
          mission.flags[key].push(value);
        } else {
          mission.flags[key] = value;
        }
      }
    }
  }

  _locationRefFromEntry(entry) {
    const { values, children } = entry;
    if (!children && values.length >= 1) return { type: 'planet', value: values[0] };
    if (children) return { type: 'filter', value: children };
    return { type: 'filter', value: [] };
  }

  /** Walk one `on <trigger>` entry's ENTIRE subtree (conversation, choice,
   *  branch, label, action - however deep) collecting payment lines, event
   *  triggers, and give/outfit/ship reward grants that belong to it. Since
   *  `npc` blocks are always siblings of `on` triggers (never nested inside
   *  one), this walk naturally never wanders into fleet/ship DEFINITIONS and
   *  mistakes them for reward grants. */
  _deriveTrigger(mission, triggerKey, onEntry) {
    mission.payment.triggers[triggerKey] = mission.payment.triggers[triggerKey] || [];

    walkAll(onEntry.children, (entry) => {
      const { key, values } = entry;

      if (key === 'payment') {
        const nums = values.filter(v => typeof v === 'number');
        const [base, multiplier] = nums.length === 0 ? [0, 150]
                                  : nums.length === 1 ? [nums[0], 0]
                                  : [nums[0], nums[1]];
        mission.payment.triggers[triggerKey].push({ base, multiplier });
        return;
      }

      if (key === 'event') {
        mission.eventTriggers.push({
          name: values[0] ?? null,
          delayDays: typeof values[1] === 'number' ? values[1] : null,
          delayDaysMax: typeof values[2] === 'number' ? values[2] : null,
          trigger: triggerKey,
        });
        return;
      }

      // Bare `outfit "Name" [count]` (the modern action-effect form - a
      // negative count means "take away") or `give outfit ...`.
      if (key === 'outfit' || (key === 'give' && values[0] === 'outfit')) {
        const isGiveForm = key === 'give';
        const name = isGiveForm ? values[1] : values[0];
        const countRaw = isGiveForm ? values[2] : values[1];
        const count = typeof countRaw === 'number' ? countRaw : 1;
        if (name && count > 0) {
          mission.rewards.outfits.push(namedRef(name, { count, grantedIn: triggerKey }));
        }
        // count <= 0 ("take away") is captured in `raw` in full; not added
        // to rewards since it isn't player-facing value gained.
        return;
      }

      if (key === 'give' && values[0] === 'ship') {
        const model = values[1] ?? null;
        const customName = values[2] ?? null;
        if (model) mission.rewards.ships.push(namedRef(model, { grantedIn: triggerKey, customName }));
        return;
      }

      const condMatch = typeof key === 'string' && values.length >= 1 &&
        (values[0] === '=' || values[0] === '+=' || values[0] === '-=' || values[0] === '>?=' || values[0] === '<?=');
      if (condMatch && SIDE_EFFECT_KEYWORDS.test(key)) {
        mission.conditionSideEffects.push({ condition: key, op: values[0], trigger: triggerKey });
      }
    });
  }

  // =========================================================================
  // Registration + collision detection
  // =========================================================================

  resolveCollisions() {
    this.collisions = [];
    for (const [name, entries] of this.missionsByName) {
      if (entries.length < 2) continue;
      const hashes = new Set(entries.map(m => m._hash));
      const contentIdentical = hashes.size === 1;

      const ranked = [...entries].sort((a, b) => {
        const pa = this._sourcePriority.get(this._sourceNameOf(a._pluginId)) ?? Infinity;
        const pb = this._sourcePriority.get(this._sourceNameOf(b._pluginId)) ?? Infinity;
        return pa - pb;
      });
      const winner = ranked[ranked.length - 1];

      let fieldDiffs = null;
      if (!contentIdentical) {
        fieldDiffs = {};
        const keys = ['payment', 'cargo', 'passengers', 'destination', 'source', 'illegal', 'deadline', 'rewards'];
        for (const k of keys) {
          const vals = entries.map(e => JSON.stringify(e[k]));
          if (new Set(vals).size > 1) fieldDiffs[k] = entries.map(e => ({ pluginId: e._pluginId, value: e[k] }));
        }
      }

      let guessedIntent = 'possible-unrelated-clash';
      if (contentIdentical) guessedIntent = 'identical-redeclaration';
      else {
        const descsMatch = new Set(entries.map(e => e.displayName)).size === 1;
        const destsMatch = new Set(entries.map(e => JSON.stringify(e.destination))).size === 1;
        if (descsMatch && destsMatch) guessedIntent = 'possible-deliberate-patch';
      }

      this.collisions.push({
        name,
        collidesAcross: entries.map(e => e._pluginId),
        contentIdentical,
        fieldDiffs,
        guessedIntent,
        resolvedByPluginPriorityOrder: winner._pluginId,
      });
    }
    return this.collisions;
  }

  _sourceNameOf(pluginId) {
    return pluginId ? pluginId.split('/')[0] : null;
  }

  // =========================================================================
  // Cross-reference passes - run AFTER every plugin has parsed both missions
  // AND the entities they reference (ships/outfits via parser.js, planets
  // via mapParser.js).
  // =========================================================================

  resolveRewardPluginIds(shipParser) {
    let resolved = 0, missing = 0;
    for (const mission of this.missions) {
      for (const ref of mission.rewards.outfits) {
        const pid = shipParser._resolveOutfitPluginId
          ? shipParser._resolveOutfitPluginId(ref.name, mission._pluginId)
          : null;
        if (pid) { ref.pluginId = pid; ref.internalId = `${pid}::${ref.name}`; resolved++; }
        else missing++;
      }
      for (const ref of mission.rewards.ships) {
        const candidates = shipParser.shipsByName ? shipParser.shipsByName.get(ref.name) : null;
        if (candidates && candidates.length) {
          const local = candidates.find(s => s._pluginId === mission._pluginId);
          const chosen = local || candidates[0];
          ref.pluginId = chosen._pluginId;
          ref.internalId = chosen._internalId;
          resolved++;
        } else missing++;
      }
    }
    return { resolved, missing };
  }

  resolvePlanetRefs(mapParser) {
    let resolved = 0, missing = 0;
    const resolveOne = (ref) => {
      const planet = mapParser.planets.get(ref.name);
      if (planet) { ref.pluginId = planet._pluginId; ref.internalId = planet._internalId; resolved++; }
      else missing++;
    };
    for (const mission of this.missions) {
      if (mission.source && mission.source.type === 'planet') {
        mission.source = { type: 'planet', ref: namedRef(mission.source.value) };
        resolveOne(mission.source.ref);
      }
      if (mission.destination && mission.destination.type === 'planet') {
        mission.destination = { type: 'planet', ref: namedRef(mission.destination.value) };
        resolveOne(mission.destination.ref);
      }
      for (const ref of mission.stopovers) resolveOne(ref);
      for (const ref of mission.waypoints) resolveOne(ref);
    }
    return { resolved, missing };
  }

  // =========================================================================
  // Output
  // =========================================================================

  toJSON() {
    return this.missions;
  }

  toPluginSlice(pluginId) {
    return this.missions.filter(m => m._pluginId === pluginId);
  }
}

module.exports = EndlessSkyMissionParser;
module.exports.parseIndentTree = parseIndentTree;
module.exports.tokenizeESLine = tokenizeESLine;
module.exports.walkAll = walkAll;
