// missionParser.js - Endless Sky mission/job-board DEFINITION parser
// (plugin-source side only - see endless-sky-mission-parsing-guide.md §1-2, §5.1, §6, §11-12)
//
// Sibling module to parser.js and mapParser.js, same conventions:
//   - tab-indent block walking
//   - bare-or-quoted-or-backtick name matching everywhere a name can appear
//   - every mission gets a stable `_pluginId` + `_internalId`
//     (`${pluginId}::${name}`), mirroring EndlessSkyParser._registerShip.
//   - every NESTED named item a mission carries (a reward outfit, a reward
//     ship, a stopover/waypoint/source/destination planet reference) is
//     written as { name, count, pluginId, internalId } rather than a bare
//     string - pluginId/internalId for these start out null (the mission's
//     own plugin doesn't necessarily define the outfit/ship/planet being
//     referenced) and are filled in by the resolve*() cross-reference passes
//     below, once every plugin's ships/outfits/planets are known.
//
// Unlike ships, missions genuinely CAN be redeclared with the same name by
// more than one plugin as a deliberate patch (see guide §12.1) - so unlike
// mapParser's additive-merge model, this module keeps every parsed mission
// as its own object (missions are not merged into one shared node the way
// systems/planets are) and instead surfaces same-name collisions explicitly
// via resolveCollisions() for human review, per guide §12.4.

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Local helpers (duplicated from parser.js rather than required from it, to
// avoid a circular require - parser.js requires THIS file, not vice versa).
// ---------------------------------------------------------------------------

function indentOf(line) {
  return line.length - line.replace(/^\t+/, '').length;
}

function skipIndentedBlock(lines, i, baseIndent) {
  i++;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (indentOf(l) <= baseIndent) break;
    i++;
  }
  return i;
}

/** Bare-or-quoted-or-backtick single name token right after `keyword`,
 *  with optional trailing content captured as `rest`. Mirrors the
 *  `give ship`/`give outfit` bare-name fix already applied in parser.js. */
function matchNamedLinePrefix(stripped, keyword) {
  const re = new RegExp(`^${keyword}\\s+(?:"([^"]+)"|\`([^\`]+)\`|(\\S+))(?:\\s+(.*))?$`);
  const m = stripped.match(re);
  if (!m) return null;
  return { name: m[1] ?? m[2] ?? m[3] ?? null, rest: (m[4] || '').trim() };
}

function matchNamedLine(stripped, keyword) {
  const r = matchNamedLinePrefix(stripped, keyword);
  return r ? r.name : null;
}

/** Generic nested key/value block reader for location filters
 *  (`source`/`destination` sub-blocks like `government "X"` / `near "Y" 5`)
 *  and other free-form condition bags. Simplified sibling of parser.js's
 *  parseBlock / mapParser.js's parseGenericBlock. */
function parseGenericBlock(lines, startIdx, baseIndent) {
  const data = {};
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const indent = indentOf(line);
    if (indent <= baseIndent) break;
    const stripped = line.trim();
    if (i + 1 < lines.length && indentOf(lines[i + 1]) > indent) {
      const key = stripped.replace(/^["'`]([^"'`]+)["'`]$/, '$1');
      const [nd, ni] = parseGenericBlock(lines, i + 1, indent);
      if (key in data) {
        if (!Array.isArray(data[key])) data[key] = [data[key]];
        data[key].push(nd);
      } else data[key] = nd;
      i = ni; continue;
    }
    const parts = stripped.match(/^"([^"]+)"\s*(.*)$/) || stripped.match(/^`([^`]+)`\s*(.*)$/);
    const key = parts ? parts[1] : stripped.split(/\s+/)[0];
    const restStr = parts ? parts[2] : stripped.slice(key.length).trim();
    const rest = restStr === '' ? true : (isNaN(Number(restStr)) ? restStr.replace(/["`]/g, '') : Number(restStr));
    if (key in data) {
      if (!Array.isArray(data[key])) data[key] = [data[key]];
      data[key].push(rest);
    } else data[key] = rest;
    i++;
  }
  return [data, i];
}

/** Named nested-reference shape reused throughout - { name, count, pluginId,
 *  internalId }. pluginId/internalId start null for anything that refers to
 *  an entity potentially owned by ANOTHER plugin (outfits, ships, planets) -
 *  filled in later by this module's resolve*() passes. `count` defaults to 1
 *  and is summed if the same name is added again (e.g. two `give outfit`
 *  lines for the same outfit under different triggers). */
function namedRef(name, extra = {}) {
  return { name, count: 1, pluginId: null, internalId: null, ...extra };
}

function hashMission(mission) {
  const relevant = {
    displayName: mission.displayName,
    locations: mission.locations,
    repeatable: mission.repeatable,
    repeatLimit: mission.repeatLimit,
    minor: mission.minor,
    priority: mission.priority,
    invisible: mission.invisible,
    illegal: mission.illegal,
    deadline: mission.deadline,
    cargo: mission.cargo,
    passengers: mission.passengers,
    payment: mission.payment,
    source: mission.source,
    destination: mission.destination,
    stopovers: mission.stopovers,
    waypoints: mission.waypoints,
    rewards: mission.rewards,
    hasNpcObjective: mission.hasNpcObjective,
  };
  return crypto.createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 12);
}

const LOCATION_TAGS = new Set([
  'job', 'landing', 'assisting', 'boarding', 'shipyard',
  'outfitter', '"job board"', 'entering', 'transition',
]);

const TRIGGER_NAMES = ['offer', 'accept', 'decline', 'defer', 'fail', 'abort', 'visit', 'stopover', 'waypoint', 'complete', 'enter'];

// Heuristic keywords for §11.1's "recurring salary/income toggle" detection.
const SIDE_EFFECT_KEYWORDS = /salary|income|wage/i;

// ---------------------------------------------------------------------------
class EndlessSkyMissionParser {
  constructor() {
    this.missions = [];
    this.missionById = new Map();    // internalId -> mission (never collides)
    this.missionsByName = new Map(); // bare name -> mission[] (collision-prone, by design - see §12.2)

    this._sourcePriority = new Map();
    this.collisions = []; // filled by resolveCollisions()
  }

  setSourcePriority(sources) {
    this._sourcePriority.clear();
    sources.forEach((source, index) => this._sourcePriority.set(source.name, index));
  }

  _registerMission(mission, pluginId) {
    const internalId = `${pluginId}::${mission.name}`;
    mission._pluginId = pluginId;
    mission._internalId = internalId;
    mission._hash = hashMission(mission);
    mission.sourcePlugin = pluginId;

    this.missionById.set(internalId, mission);
    if (!this.missionsByName.has(mission.name)) this.missionsByName.set(mission.name, []);
    this.missionsByName.get(mission.name).push(mission);
    return internalId;
  }

  // =========================================================================
  // Shared 1/2/3-number range resolver for `cargo`/`passengers`
  // (guide §2.3 - fixed / uniform / negative-binomial).
  // =========================================================================
  _resolveRangeSpec(commodity, nums) {
    const clean = nums.filter(n => !Number.isNaN(n));
    const base = commodity !== null ? { commodity } : {};
    if (clean.length === 0) return { ...base, min: 0, max: 0, mode: 'fixed', nbParams: null };
    if (clean.length === 1) {
      return { ...base, min: clean[0], max: clean[0], mode: 'fixed', nbParams: null };
    }
    if (clean.length === 2) {
      return { ...base, min: clean[0], max: clean[1], mode: 'uniform', nbParams: null };
    }
    const [n1, r, p] = clean;
    const mean = n1 + (r * (1 - p)) / p;
    const variance = p > 0 ? (r * (1 - p)) / (p * p) : 0;
    const softMax = Math.round(mean + 3 * Math.sqrt(variance));
    return {
      ...base, min: n1, max: null, expected: Math.round(mean), softMax,
      mode: 'negative-binomial', nbParams: { r, p },
    };
  }

  // =========================================================================
  // mission "<name>" ... - full definition parse (guide §1, §5.1, §6, §11.5)
  // =========================================================================
  parseMissionBlock(lines, i, pluginId) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^mission\s+"([^"]+)"/) || headerLine.match(/^mission\s+`([^`]+)`/);
    const missionName = nameMatch ? nameMatch[1] : null;
    const baseIndent = indentOf(lines[i]);
    if (!missionName) return [null, skipIndentedBlock(lines, i, baseIndent)];

    const mission = {
      name: missionName,
      displayName: null,
      locations: [],
      repeatable: false,
      repeatLimit: null,
      minor: false,
      priority: false,
      invisible: false,
      illegal: null,
      deadline: null,
      cargo: null,
      passengers: null,
      payment: { apparentPayment: null, triggers: {} },
      source: null,
      destination: null,
      stopovers: [],  // [{name,count,pluginId,internalId}]
      waypoints: [],  // [{name,count,pluginId,internalId}]
      rewards: {
        outfits: [], // [{name,count,pluginId,internalId,grantedIn}]
        ships: [],   // [{name(model),count,pluginId,internalId,grantedIn,customName}]
      },
      hasNpcObjective: false,
      conditionSideEffects: [], // [{condition, op, trigger}]
      eventTriggers: [], // event "X" action lines, same idea as parser.js's collectMissionEventTrigger
    };

    i++;
    let currentTrigger = null;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const indent = indentOf(line);
      if (indent <= baseIndent) break;
      const stripped = line.trim();

      if (indent === baseIndent + 1) {
        currentTrigger = null; // left whatever `on ...` block we might have been in

        if (LOCATION_TAGS.has(stripped)) { mission.locations.push(stripped.replace(/["]/g, '')); i++; continue; }
        if (stripped === 'minor')     { mission.minor = true; i++; continue; }
        if (stripped === 'priority')  { mission.priority = true; i++; continue; }
        if (stripped === 'invisible') { mission.invisible = true; i++; continue; }

        if (stripped === 'repeat' || stripped.startsWith('repeat ')) {
          mission.repeatable = true;
          const m = stripped.match(/^repeat\s+(\d+)/);
          mission.repeatLimit = m ? parseInt(m[1], 10) : null;
          i++; continue;
        }

        const nameM = stripped.match(/^name\s+"([^"]+)"/) || stripped.match(/^name\s+`([^`]+)`/);
        if (nameM) { mission.displayName = nameM[1]; i++; continue; }

        const apparentM = stripped.match(/^"apparent payment"\s+(-?[\d.]+)/);
        if (apparentM) { mission.payment.apparentPayment = parseFloat(apparentM[1]); i++; continue; }

        const illegalM = stripped.match(/^illegal\s+(-?\d+)(?:\s+"([^"]+)")?/);
        if (illegalM) {
          mission.illegal = { fine: parseInt(illegalM[1], 10), message: illegalM[2] || null };
          i++; continue;
        }

        if (stripped.startsWith('deadline')) {
          const deadlineM = stripped.match(/^deadline(?:\s+(-?\d+))?(?:\s+(-?\d+))?/);
          mission.deadline = mission.deadline || { days: 0, multiplier: 2 };
          if (deadlineM[1] != null) mission.deadline.days += parseInt(deadlineM[1], 10);
          if (deadlineM[2] != null) mission.deadline.multiplier = parseInt(deadlineM[2], 10);
          i++; continue;
        }

        // cargo (random|<name>) n1 [n2 [prob]] - may have `illegal`/`stealth`
        // indented children, which we skip (not needed for cost math).
        const cargoM = stripped.match(/^cargo\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(.+))?$/);
        if (cargoM) {
          const commodity = cargoM[1] ?? cargoM[2] ?? cargoM[3];
          const nums = (cargoM[4] || '').trim().split(/\s+/).filter(Boolean).map(Number);
          mission.cargo = this._resolveRangeSpec(commodity, nums);
          if (i + 1 < lines.length && indentOf(lines[i + 1]) > indent) {
            i = skipIndentedBlock(lines, i, indent); continue;
          }
          i++; continue;
        }

        const passM = stripped.match(/^passengers(?:\s+(.+))?$/);
        if (passM) {
          const nums = (passM[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);
          mission.passengers = this._resolveRangeSpec(null, nums);
          i++; continue;
        }

        if (stripped.startsWith('source')) {
          const [srcRef, ni] = this._parseLocationRef(lines, i, indent, 'source');
          mission.source = srcRef; i = ni; continue;
        }
        if (stripped.startsWith('destination')) {
          const [dstRef, ni] = this._parseLocationRef(lines, i, indent, 'destination');
          mission.destination = dstRef; i = ni; continue;
        }
        if (stripped.startsWith('stopover')) {
          const [stopRef, ni] = this._parseLocationRef(lines, i, indent, 'stopover');
          if (stopRef.type === 'planet') mission.stopovers.push(namedRef(stopRef.value));
          i = ni; continue;
        }
        if (stripped.startsWith('waypoint')) {
          const [wpRef, ni] = this._parseLocationRef(lines, i, indent, 'waypoint');
          if (wpRef.type === 'planet') mission.waypoints.push(namedRef(wpRef.value));
          i = ni; continue;
        }

        const onM = stripped.match(/^on\s+(offer|accept|decline|defer|fail|abort|visit|stopover|waypoint|complete|enter)\b(?:\s+"([^"]+)"|\s+`([^`]+)`)?/);
        if (onM) {
          currentTrigger = 'on' + onM[1][0].toUpperCase() + onM[1].slice(1);
          mission.payment.triggers[currentTrigger] = mission.payment.triggers[currentTrigger] || [];
          i++; continue;
        }
      }

      // ── Trigger-body lines (indent >= baseIndent + 2, inside an `on X` block) ──
      if (currentTrigger && indent >= baseIndent + 2) {
        if (stripped.startsWith('payment')) {
          const nums = stripped.replace(/^payment/, '').trim().split(/\s+/).filter(Boolean).map(Number);
          const [base, multiplier] = nums.length === 0 ? [0, 150]
                                    : nums.length === 1 ? [nums[0], 0]
                                    : [nums[0], nums[1]];
          mission.payment.triggers[currentTrigger].push({ base, multiplier });
          i++; continue;
        }

        // give/take outfit — bare or quoted name, optional count (may be negative for "take").
        const outfitM =
          stripped.match(/^(give|take)\s+outfit\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(-?\d+))?\s*$/) ||
          stripped.match(/^outfit\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(-?\d+))?\s*$/);
        if (outfitM) {
          const isTakeForm = outfitM[1] === 'take';
          const nameIdx = outfitM.length === 6 ? [2, 3, 4] : [1, 2, 3];
          const countIdx = outfitM.length === 6 ? 5 : 4;
          const outfitName = outfitM[nameIdx[0]] ?? outfitM[nameIdx[1]] ?? outfitM[nameIdx[2]];
          let count = outfitM[countIdx] ? parseInt(outfitM[countIdx], 10) : 1;
          if (isTakeForm) count = -Math.abs(count);
          if (outfitName && count > 0) {
            mission.rewards.outfits.push(namedRef(outfitName, { count, grantedIn: currentTrigger }));
          }
          // count <= 0 ("take away") lines are matched but not added to
          // rewards — flagged here, not silently dropped without a trace:
          // they simply don't represent player-facing value to gain.
          i++; continue;
        }

        // give/take ship — bare or quoted model name, optional bare-or-quoted custom name.
        const shipM =
          stripped.match(/^(give|take)\s+ship\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(?:"([^"]*)"|`([^`]*)`|(\S+)))?\s*$/) ||
          stripped.match(/^ship\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(?:"([^"]*)"|`([^`]*)`|(\S+)))?\s*$/);
        if (shipM) {
          // Full regex-match arrays: verb form captures 7 groups (length 8:
          // index 0 is the whole match + 7 groups); bare form captures 6
          // groups (length 7). Branch on that, not on group VALUES, since
          // an unnamed give (no verb) can have all-undefined captures too.
          const withVerb = shipM.length === 8;
          const isTakeForm = withVerb && shipM[1] === 'take';
          const model = withVerb ? (shipM[2] ?? shipM[3] ?? shipM[4]) : (shipM[1] ?? shipM[2] ?? shipM[3]);
          const customName = withVerb ? (shipM[5] ?? shipM[6] ?? null) : (shipM[4] ?? shipM[5] ?? null);
          if (model && !isTakeForm) {
            mission.rewards.ships.push(namedRef(model, { grantedIn: currentTrigger, customName: customName || null }));
          }
          i++; continue;
        }

        if (stripped === 'npc' || stripped.startsWith('npc ')) {
          mission.hasNpcObjective = true;
          i = skipIndentedBlock(lines, i, indent); continue;
        }

        const evM = stripped.match(/^event\s+"([^"]+)"(?:\s+-?\d+(?:\s+-?\d+)?)?\s*$/) ||
                    stripped.match(/^event\s+`([^`]+)`(?:\s+-?\d+(?:\s+-?\d+)?)?\s*$/);
        if (evM) { mission.eventTriggers.push(evM[1]); i++; continue; }

        // Best-effort recurring-income/expense heuristic (guide §11.1):
        // `<condition> (=|+=|-=) <value>` where the condition name reads
        // like a salary/income/wage toggle.
        const condM = stripped.match(/^(?:"([^"]+)"|`([^`]+)`)\s*(=|\+=|-=)\s*(-?[\d.]+)/);
        if (condM) {
          const condition = condM[1] ?? condM[2];
          if (SIDE_EFFECT_KEYWORDS.test(condition)) {
            mission.conditionSideEffects.push({ condition, op: condM[3], trigger: currentTrigger });
          }
          i++; continue;
        }
      }

      // Anything else at any indent (npc bodies already skipped above,
      // dialog/conversation text, `to offer` condition lines, etc.) - not
      // needed for cost/reward math, intentionally not parsed further.
      i++;
    }

    return [mission, i];
  }

  /** `source`/`destination`/`stopover`/`waypoint` can each be either a
   *  literal planet name (bare or quoted) or an indented location-filter
   *  sub-block (government/attributes/near/distance/...). */
  _parseLocationRef(lines, i, baseIndent, keyword) {
    const stripped = lines[i].trim();
    const nameOnly = stripped.match(new RegExp(`^${keyword}\\s+(?:"([^"]+)"|\`([^\`]+)\`|(\\S+))\\s*$`));
    const hasNestedBlock = i + 1 < lines.length && indentOf(lines[i + 1]) > baseIndent;
    if (nameOnly && !hasNestedBlock) {
      return [{ type: 'planet', value: nameOnly[1] ?? nameOnly[2] ?? nameOnly[3] }, i + 1];
    }
    if (hasNestedBlock) {
      const [filterData, ni] = parseGenericBlock(lines, i + 1, baseIndent);
      return [{ type: 'filter', value: filterData }, ni];
    }
    return [{ type: 'filter', value: null }, i + 1];
  }

  // =========================================================================
  // Registration + collision detection (guide §12.2)
  // =========================================================================

  register(mission, pluginId) {
    this._registerMission(mission, pluginId);
    this.missions.push(mission);
    return mission;
  }

  /** Flags every mission name defined by more than one plugin, diffing
   *  content via the structural hash (identical redeclaration vs. real
   *  conflict) and applying the same best-effort, plugins.json-order
   *  resolution heuristic ships already get - advisory only, see guide
   *  §12.3 for why this can never be a guarantee of real in-game behavior. */
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
      const winner = ranked[ranked.length - 1]; // "later in priority order overrides" per mapParser-design.md §3

      let fieldDiffs = null;
      if (!contentIdentical) {
        fieldDiffs = {};
        const keys = ['payment', 'cargo', 'passengers', 'destination', 'source', 'illegal', 'deadline', 'rewards'];
        for (const k of keys) {
          const vals = entries.map(e => JSON.stringify(e[k]));
          if (new Set(vals).size > 1) fieldDiffs[k] = entries.map((e, idx) => ({ pluginId: e._pluginId, value: e[k] }));
        }
      }

      // Heuristic-only "deliberate patch vs unrelated clash" label (guide §12.3).
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
  // AND the entities they reference (ships/outfits via parser.js,
  // planets via mapParser.js).
  // =========================================================================

  /** Fill in pluginId/internalId on reward outfit/ship refs by looking them
   *  up in EndlessSkyParser's own registries. `shipParser` is the
   *  EndlessSkyParser instance from parser.js (has .outfitsByName,
   *  .shipsByName, and ._resolveOutfitPluginId already built). */
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

  /** Fill in pluginId/internalId on source/destination/stopover/waypoint
   *  literal-planet references by looking them up in mapParser's planet
   *  registry (mapParser.planets: Map<name, planetNode>). */
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

  /** Per-plugin slice, same convention as ships.json/outfits.json in parser.js. */
  toPluginSlice(pluginId) {
    return this.missions.filter(m => m._pluginId === pluginId);
  }
}

module.exports = EndlessSkyMissionParser;
