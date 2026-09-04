'use strict';

// ═══════════════════════════════════════════════════════════
//  esSaveParser.js
//
//  Parses an Endless Sky save file and returns a structured
//  object containing:
//    - pilot       : top-level pilot metadata
//    - ships       : array of ship objects in shipBuilder format
//    - missions    : array of mission blocks currently sitting in the
//                    save file's "mission" section — see the caveat
//                    below, this is NOT simply "the player's active
//                    missions"
//    - events      : array of pending/scheduled event blocks (alias for
//                    blocks.event) — see GENERIC BLOCK CAPTURE below
//    - changes     : array of applied world-state change blocks (alias
//                    for blocks.changes) — see GENERIC BLOCK CAPTURE below
//    - blocks      : { <block name>: [{ name, raw }] } for every top-level
//                    block this file doesn't have a dedicated parser for —
//                    event, changes, economy, visited, and anything a
//                    future save format adds. See GENERIC BLOCK CAPTURE.
//    - storage     : per-planet stored cargo/outfits
//    - licenses    : array of license strings
//    - account     : credits, score, salaries, history
//    - cargo       : player's carried cargo/outfits
//
//  MISSION BLOCK PARSING — read this before trusting `missions` blindly
//  -----------------------------------------------------------------
//  Endless Sky's own save-file guide is explicit that the "mission"
//  section holds BOTH the player's genuinely active/accepted missions
//  AND missions that are merely "available" — their `to offer`
//  conditions already passed, but the player hasn't landed/visited the
//  spaceport to actually be offered them yet. There is no dedicated
//  flag inside the block itself that cleanly says "this one is
//  accepted" vs "this one is just queued." So: a name showing up here
//  means "this save is currently holding a live copy of this mission's
//  data," not "the player is definitely working on it right now."
//
//  Each entry is `{ name, raw }`:
//    - name : the mission's internal identifier — the quoted string
//             immediately after `mission`, e.g. `mission "FW Katya 1"`.
//             This is the SAME string Endless Sky uses to build the
//             "<name>: offered/active/done/failed/declined" condition
//             keys in pilot.conditions, and the SAME string missionLoader.js
//             calls `.name` on a parsed mission — so it's the join key
//             for cross-referencing, not necessarily what's shown to
//             the player (that's the `name` sub-line inside the block,
//             folded into `raw` like everything else in this block).
//    - raw  : the full { key, values, children } tree of everything
//             inside the block — same shape missionParser.js uses for
//             plugin mission data — so nothing in the block is lost
//             even though this parser doesn't special-case any of it
//             (cargo already loaded, remaining deadline days, etc. are
//             all in here if present, just not pulled onto named
//             fields the way ship attributes are).
//
//  Reconciling this with pilot.conditions (which DOES reliably tell you
//  offered/active/done/failed/declined COUNTS) is deliberately left to
//  the consumer — see missionStatusHelper.js, which combines "does a
//  mission block exist" with "is its `<name>: active` condition > 0"
//  to make a higher-confidence call, rather than this parser asserting
//  a status it can't actually be sure of from the block alone.
//
//  GENERIC BLOCK CAPTURE
//  -----------------------------------------------------------------
//  Every other top-level block this file doesn't have a purpose-built
//  parser for — `event`, `changes`, `economy`, `visited`, and anything
//  a future save format adds — is captured the same way `mission` is:
//  the whole block, verbatim, as a { key, values, children } tree, so
//  nothing is silently dropped just because this parser doesn't know
//  what to do with it yet. These land in `result.blocks[blockName]`,
//  an array of `{ name, raw }` (name is the block's own quoted
//  argument if it has one, e.g. `event "Some Event"` → name: "Some
//  Event"; blocks with no argument like `changes`/`visited` get
//  name: null). `result.events` and `result.changes` are just
//  convenience aliases onto `blocks.event` / `blocks.changes`.
//  A flat `key → first-line-text` view of every such block ALSO still
//  lands in `pilot.raw`, same as before this existed, for simple
//  single-line lookups that don't care about full fidelity.
//
//  Ships are returned in the same internal format used by
//  shipBuilder.js:
//  {
//    id, name, customName, variant, plural, sprite, thumbnail,
//    description, mass, drag,
//    attributes: {},
//    weapon: { 'blast radius', 'shield damage', 'hull damage', 'hit force' },
//    outfits:      [{ name, count, pluginId }],
//    guns:         [{ coords, over, extra }],
//    turrets:      [{ coords, over, extra }],
//    drones:       [{ coords, launchEffect, extra }],
//    fighters:     [{ coords, launchEffect, extra }],
//    engines:      [{ coords, zoom, angle, gimbal, over, under, extra }],
//    reverseEngines: [{ coords, zoom, angle, gimbal, over, under, extra }],
//    steeringEngines:[{ coords, zoom, angle, gimbal, over, under, side, extra }],
//    leaks:        [{ name, openChance, spreadChance }],
//    explode:      [{ name, count }],
//    finalExplode: [{ name, count }],
//    extraLines:   [],
//    // Save-file-only fields:
//    _modelName,   // the ship type/model e.g. "Peregrine"
//    _customName,  // the named ship e.g. "Great Fox"
//    _uuid,
//    _swizzle,
//    _crew,
//    _fuel,
//    _shields,
//    _hull,
//    _position,    // { x, y }
//    _system,
//    _planet,
//    _parked,
//    _formation,
//    _sourceShip,
//    _sourcePlugin,
//  }
//
//  `extra` on every hardpoint entry (guns/turrets/engines/reverseEngines/
//  steeringEngines/bays) is a generic, non-hardcoded attribute bag using
//  EXACTLY the same naming convention as the main data parser (parser.js):
//    - multiple numbers on ONE sub-block line (e.g. `arc -90 50`) become
//      a nested object: { arc: { arc_1: -90, arc_2: 50 } }
//    - the same attribute key appearing again on a LATER, separate line
//      becomes a flat sibling key: "hit force", "hit force_2", ...
//    - a single value stays a plain scalar: { zoom: 1 }
//  This is what lets a ship round-trip through save-file import → the ship
//  builder → raw ES text export without losing or corrupting any
//  hardpoint/weapon attribute, however unusual.
// ═══════════════════════════════════════════════════════════

// ── Tokeniser ────────────────────────────────────────────────────────────────
// Splits a line into tokens, respecting "quoted strings" and `backtick strings`
function _esTok(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === ' ' || c === '\t') { i++; continue; }

    if (c === '"') {
      const end = str.indexOf('"', i + 1);
      if (end === -1) { tokens.push(str.slice(i)); break; }
      tokens.push(str.slice(i, end + 1)); // keep quotes
      i = end + 1;
      continue;
    }

    if (c === '`') {
      const end = str.indexOf('`', i + 1);
      if (end === -1) { tokens.push(str.slice(i)); break; }
      // backtick strings: strip backticks, keep inner content as-is
      tokens.push(str.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    // bare word
    let j = i;
    while (j < str.length && str[j] !== ' ' && str[j] !== '\t') j++;
    tokens.push(str.slice(i, j));
    i = j;
  }
  return tokens;
}

// Strip surrounding quotes from a single token
function _esStrip(s) {
  if (!s) return '';
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// Return a clean display name (strip quotes, trim)
function _esName(tok) {
  return _esStrip(tok || '');
}

// ── Generic numeric-aware attribute-line parser / merger ─────────────────────
// Mirrors parser.js's parseNumericAwareLine + mergeAttributeValue exactly, so
// every hardpoint/weapon attribute captured from a save file uses the same
// naming convention as the main plugin-data parser. Kept as a self-contained
// copy (rather than a shared import) since this file also runs standalone in
// Node via module.exports, with no guarantee parser.js is loaded alongside it.

// Parse a single attribute line into [key, values], where `values` is always
// an array — one entry per number/word found — so the caller can tell
// "one line with several numbers" apart from "a single value".
function _esAttrLine(stripped) {
  let key, rest;
  const qk = stripped.match(/^"([^"]+)"\s*(.*)$/) ||
             stripped.match(/^`([^`]+)`\s*(.*)$/) ||
             stripped.match(/^'([^']+)'\s*(.*)$/);
  if (qk) {
    key = qk[1]; rest = qk[2].trim();
  } else {
    const sp = stripped.indexOf(' ');
    if (sp === -1) { key = stripped; rest = ''; }
    else { key = stripped.slice(0, sp); rest = stripped.slice(sp + 1).trim(); }
  }
  if (!key) return null;
  if (rest === '') return [key, [true]];

  const qv = rest.match(/^"([^"]*)"$/) || rest.match(/^`([^`]*)`$/) || rest.match(/^'([^']*)'$/);
  if (qv) return [key, [qv[1]]];

  const qvPlus = rest.match(/^"([^"]*)"\s+(.+)$/) ||
                 rest.match(/^`([^`]*)`\s+(.+)$/) ||
                 rest.match(/^'([^']*)'\s+(.+)$/);
  if (qvPlus) return [key, [qvPlus[1]]];

  const tokens = rest.split(/\s+/);
  const isNumericToken = t => /^-?[\d.]+$/.test(t);
  if (tokens.every(isNumericToken)) {
    return [key, tokens.map(t => parseFloat(t))];
  }

  return [key, [rest]];
}

// Merge a parsed occurrence into an attribute bag:
//   - multiple values from ONE line  → nested { key: { key_1, key_2, ... } }
//   - the SAME key on a later line   → flat sibling { key, key_2, ... }
function _esMergeAttr(data, key, values) {
  let outerKey = key;
  if (outerKey in data) {
    let n = 2;
    while ((`${key}_${n}`) in data) n++;
    outerKey = `${key}_${n}`;
  }
  if (values.length === 1) {
    data[outerKey] = values[0];
  } else {
    const nested = {};
    values.forEach((v, idx) => { nested[`${outerKey}_${idx + 1}`] = v; });
    data[outerKey] = nested;
  }
}

// ── Generic indentation tree builder (for mission blocks) ────────────────────
// Mission blocks in a save file can contain essentially anything a plugin's
// own mission definition can (conversations, choices, nested "to complete"
// trees, arbitrary actions) — far more variety than this file's hand-rolled
// ship/attribute state machine is built to special-case. Rather than trying
// to enumerate every possible mission sub-structure here too, this builds
// the exact same generic { key, values, children } tree shape
// missionParser.js already uses for plugin mission data, so a mission block
// round-trips with full fidelity regardless of what's inside it.
//
// `rawLines` is an array of { indent, text } for every line strictly inside
// the mission block (i.e. everything after the `mission "Name"` line itself,
// up to but not including the next indent-0 line). `baseIndent` is the
// indent level of those immediate children (normally 1).
function _esBuildRawTree(rawLines, baseIndent) {
  // Turn each line into { indent, key, values } using the same per-line
  // parser as attribute lines (handles quoted/backtick keys, numeric vs
  // string values) — NOT the ship attribute merger, since mission blocks
  // are trees, not flat bags, so sibling repeats stay as separate entries
  // rather than being merged into "_2"/"_3" suffixes.
  const parsedLines = rawLines.map(({ indent, text }) => {
    // ES's mission grammar has a small, fixed set of bare TWO-WORD
    // structural keywords ("to offer", "on complete", etc.) that are
    // never quoted (quoting would defeat their special meaning to the
    // game's own parser). _esAttrLine's generic "split at the first
    // space" rule would wrongly treat these as key="to"/value="offer" —
    // so they're special-cased here first, before falling through to
    // the generic attribute-line parser for everything else.
    const bareTwoWord = text.match(/^(to|on)\s+([a-zA-Z][a-zA-Z]*)\b\s*(.*)$/);
    if (bareTwoWord) {
      const [, lead, second, rest] = bareTwoWord;
      const key = `${lead} ${second}`;
      // A trailing argument, e.g. `on enter "Some System"`, becomes the
      // value; a bare structural line like `to offer` has none.
      const values = rest ? [_esName(rest)] : [];
      return { indent, key, values };
    }
    const [key, values] = _esAttrLine(text) || [text, []];
    return { indent, key, values: values === true ? [] : (Array.isArray(values) ? values.filter(v => v !== true) : []) };
  });

  // Stack-based tree build: track the most recently created node at each
  // depth so a line can be attached as a child of whichever ancestor is
  // still open at (line.indent - 1).
  const root = [];
  const stack = [{ indent: baseIndent - 1, children: root }];

  for (const line of parsedLines) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= line.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const node = { key: line.key, values: line.values, children: [] };
    parent.children.push(node);
    stack.push({ indent: line.indent, children: node.children, node });
  }

  // Drop the empty `children: []` arrays we pre-allocated on leaf nodes so
  // this matches missionParser.js's convention of omitting `children`
  // entirely (rather than an empty array) on entries with no sub-lines.
  const prune = nodes => {
    for (const n of nodes) {
      if (n.children.length) prune(n.children);
      else delete n.children;
    }
  };
  prune(root);
  return root;
}


function _esBlankShip() {
  return {
    id: Date.now() + Math.random(),
    // Identity
    name: '',         // model/class name e.g. "Peregrine"
    customName: '',   // in-game pilot-given name e.g. "Great Fox"
    variant: '',
    plural: '',
    sprite: '',
    thumbnail: '',
    description: '',
    mass: '',
    drag: '',
    // Stats
    attributes: {},
    weapon: { 'blast radius': 0, 'shield damage': 0, 'hull damage': 0, 'hit force': 0 },
    // Loadout
    outfits: [],
    // Hardpoints
    guns: [],
    turrets: [],
    drones: [],
    fighters: [],
    engines: [],
    reverseEngines: [],
    steeringEngines: [],
    // Effects
    leaks: [],
    explode: [],
    finalExplode: [],
    extraLines: [],
    // Save-file metadata
    _modelName: '',
    _customName: '',
    _uuid: '',
    _swizzle: null,
    _crew: null,
    _fuel: null,
    _shields: null,
    _hull: null,
    _position: null,
    _system: '',
    _planet: '',
    _parked: false,
    _formation: '',
    _groups: null,       // fleet hotkey group(s) — see pendingGroups note in parseESSaveFile
    _sourceShip: null,
    _sourcePlugin: null,
  };
}

// ── Engine/hardpoint sub-block reader ────────────────────────────────────────
// After pushing a new engine/reverseEngine/steeringEngine/gun/turret entry,
// subsequent indented lines carry arbitrary attributes (zoom, angle, gimbal,
// arc, under, over, left, right, or anything else a plugin/save might use).
// Everything lands in `extra` (see the naming convention note at the top of
// this file); a handful of well-known keys are ALSO mirrored onto dedicated
// convenience fields so existing code that reads e.g. `e.zoom`/`e.angle`
// directly keeps working unchanged.
function _esMakeEngineEntry(coords) {
  return { coords, zoom: '', angle: '', gimbal: '', over: false, under: false, extra: {} };
}
function _esMakeSteeringEntry(coords) {
  return { coords, zoom: '', angle: '', gimbal: '', over: false, under: false, side: '', extra: {} };
}

// ── Bay sub-block reader ─────────────────────────────────────────────────────
// After a bay line, indented children may carry: angle, "launch effect", and
// potentially anything else (over/under/left/right/parallel...) which lands
// in `extra`.
function _esMakeBayEntry(coords) {
  return { coords, angle: '', launchEffect: '', extra: {} };
}

// ═══════════════════════════════════════════════════════════
//  MAIN PARSE FUNCTION
//  Returns { pilot, ships, missions, events, changes, blocks, storage,
//            licenses, plugins, account, cargo }
//  — see GENERIC BLOCK CAPTURE note below for `blocks`/`events`/`changes`.
// ═══════════════════════════════════════════════════════════
function parseESSaveFile(text) {
  const lines = text.split('\n');

  // ── Result containers ──
  const result = {
    pilot: {
      name: '',
      originalName: '',
      date: '',
      system: '',
      planet: '',
      playtime: null,
      flagshipIndex: null,
      reputations: {},
      conditions: {},
      raw: {},          // other top-level key→value pairs we don't specially handle
    },
    ships: [],
    missions: [],        // see "MISSION BLOCK PARSING" below for shape + caveats
    storage: [],        // [{ planet, cargo: { outfits: {name→count}, commodities: {} } }]
    licenses: [],
    plugins: [],         // installed plugin names, exactly as written in the save file
    account: { credits: 0, score: 0, salaries: {}, history: [] },
    cargo: { outfits: {}, commodities: {} },
    // Everything else: every top-level block name this parser doesn't have
    // a dedicated handler for (event, changes, economy, visited, and
    // whatever else shows up in future save formats) lands here, keyed by
    // block name, as an array of { name, raw } — same generic tree shape
    // as `missions`. `name` is the block's quoted argument if it has one
    // (e.g. `event "Some Event"` → name: "Some Event"); blocks with no
    // argument (e.g. `changes`, `visited`) get name: null. See "GENERIC
    // BLOCK CAPTURE" note below.
    blocks: {},
  };

  // ── Parser state ──
  let topBlock    = null;   // current top-level block name
  let cur         = null;   // current ship being built
  let attrBlock   = false;  // inside ship > attributes
  let outfitBlock = false;  // inside ship > outfits
  let attrSub     = null;   // 'licenses' | 'weapon' | null
  let lastHP      = null;   // { type:'engine'|'reverseEngine'|'steeringEngine'|'gun'|'turret'|'bay', arr, idx }
  let lastBayArr  = null;   // pointer to the bay array being filled
  let lastBayIdx  = -1;

  // Sprite sub-block: indent-2 lines under sprite/thumbnail are sprite params, skip them
  let inSpriteBlock = false;

  // storage parser state
  let storageEntry   = null;   // { planet, cargo }
  let inStorageCargo = false;
  let inStorageOutfits = false;

  // account parser state
  let inAccountSalaries = false;
  let inAccountHistory  = false;

  // cargo (player carried) parser state
  let inTopCargo       = false;
  let inTopCargoOutfits = false;

  // reputation block
  let inReputation = false;

  // conditions block
  let inConditions = false;

  // mission block capture — see "MISSION BLOCK PARSING" note at the top of
  // this file for why this captures a generic tree rather than special-
  // casing fields the way the ship parser does. `mission` is handled as
  // its own named case (rather than falling into the fully generic bucket
  // below) purely so `result.missions` stays a first-class, obviously-
  // named field for missionStatusHelper.js to read.
  let missionName   = null;   // identifier of the mission currently being captured
  // `groups N` is written as its OWN top-level line immediately before the
  // `ship` line it applies to — confirmed against a real save file, this
  // is not a child of the ship block. Stashed here and consumed by the
  // very next ship, if any.
  let pendingGroups = null;
  let missionBuffer = [];     // [{ indent, text }] for every line inside it so far

  // ── GENERIC BLOCK CAPTURE ──
  // Any top-level block whose keyword isn't one of the special-cased ones
  // above (ship/pilot/date/system/planet/playtime/flagship index/
  // reputation with/conditions/licenses/plugins/account/storage/cargo/
  // mission) falls through to here. Rather than maintaining a hand-rolled
  // buffer+flag pair per block type — which is what `missionBuffer` above
  // already is, and which doesn't scale to "capture literally everything
  // I haven't thought of" — this is ONE buffer used for whichever such
  // block is currently open, keyed by its block name (event, changes,
  // economy, visited, or anything else a future save format adds).
  let genericBlockName = null;   // e.g. 'event', 'changes', 'visited'
  let genericBlockArg  = null;   // the block's own quoted argument, if any
  let genericBuffer    = [];     // [{ indent, text }] for the currently open block

  // ── Line iterator ──
  for (let li = 0; li < lines.length; li++) {
    const raw    = lines[li];
    const t      = raw.trim();
    if (!t || t.startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    const toks   = _esTok(t);
    const key0   = _esStrip(toks[0] || '');

    // ════════════════════════════════════════════════════════
    //  TOP LEVEL  (indent === 0)
    // ════════════════════════════════════════════════════════
    if (indent === 0) {
      // Close any open ship
      if (cur) { result.ships.push(cur); cur = null; }

      // Close any open mission capture
      if (missionName !== null) {
        result.missions.push({ name: missionName, raw: _esBuildRawTree(missionBuffer, 1) });
        missionName   = null;
        missionBuffer = [];
      }

      // Close any open generic block capture
      if (genericBlockName !== null) {
        (result.blocks[genericBlockName] = result.blocks[genericBlockName] || [])
          .push({ name: genericBlockArg, raw: _esBuildRawTree(genericBuffer, 1) });
        genericBlockName = null;
        genericBlockArg  = null;
        genericBuffer    = [];
      }

      // Reset all block flags
      attrBlock = false; outfitBlock = false; attrSub = null;
      lastHP = null; lastBayArr = null; lastBayIdx = -1;
      inSpriteBlock = false;
      storageEntry = null; inStorageCargo = false; inStorageOutfits = false;
      inAccountSalaries = false; inAccountHistory = false;
      inTopCargo = false; inTopCargoOutfits = false;
      inReputation = false; inConditions = false;

      topBlock = key0;
      // Clear any stashed `groups` value unless this line is what it was
      // waiting for (either the ship it belongs to, or another `groups`
      // line for a different ship) — see pendingGroups declaration above.
      if (key0 !== 'ship' && key0 !== 'groups') pendingGroups = null;

      // ── ship ──
      if (key0 === 'ship') {
        cur = _esBlankShip();
        // model name is toks[1]; save files don't have variants at this line
        cur._modelName = _esName(toks[1] || '');
        cur.name       = cur._modelName;
        cur._groups    = pendingGroups;
        pendingGroups  = null;
        continue;
      }

      if (key0 === 'groups') { pendingGroups = toks[1] != null ? _esName(toks[1]) : null; continue; }

      // ── pilot header fields ──
      if (key0 === 'pilot')              { result.pilot.name         = toks.slice(1).map(_esName).join(' '); continue; }
      if (key0 === 'original name')    { result.pilot.originalName = toks.slice(1).map(_esName).join(' '); continue; }
      if (key0 === 'date')               { result.pilot.date         = toks.slice(1).join(' '); continue; }
      if (key0 === 'system')             { result.pilot.system       = _esName(toks[1]); continue; }
      if (key0 === 'planet')             { result.pilot.planet       = _esName(toks[1]); continue; }
      if (key0 === 'playtime')           { result.pilot.playtime     = parseFloat(toks[1]) || 0; continue; }
      if (key0 === 'flagship index')   { result.pilot.flagshipIndex= parseInt(toks[1]) || 0; continue; }
      if (key0 === 'reputation with')  { inReputation = true; continue; }
      if (key0 === 'conditions')         { inConditions = true; continue; }
      if (key0 === 'licenses')           { topBlock = 'licenses'; continue; }
      if (key0 === 'plugins')            { topBlock = 'plugins'; continue; }
      if (key0 === 'account')            { topBlock = 'account'; continue; }
      if (key0 === 'storage')            { topBlock = 'storage'; continue; }
      if (key0 === 'cargo')              { inTopCargo = true; topBlock = 'cargo'; continue; }
      if (key0 === 'mission') {
        // Start capturing this block's lines verbatim — finalised into
        // result.missions the next time we hit an indent-0 line (handled
        // above) or at end-of-file (handled after the loop).
        topBlock    = 'mission';
        missionName = _esName(toks[1] || '');
        missionBuffer = [];
        continue;
      }
      // event / changes / economy / visited (and anything else) all fall
      // through to the generic capture immediately below — no dedicated
      // per-name branch needed.

      // Anything not specially handled above — event, changes, economy,
      // visited, and any block name a future save format adds — gets
      // captured in full via the generic mechanism instead of being
      // dropped. Also still record a flat single-line view in pilot.raw
      // for anything that turns out to have no children at all, so
      // existing simple lookups against pilot.raw keep working.
      result.pilot.raw[key0] = toks.slice(1).join(' ');
      genericBlockName = key0;
      genericBlockArg  = toks[1] != null ? _esName(toks[1]) : null;
      genericBuffer    = [];
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  CAPTURE BLOCKS we don't have a dedicated parser for
    // ════════════════════════════════════════════════════════
    if (topBlock === 'mission') {
      // Capture verbatim for _esBuildRawTree() rather than discarding —
      // see the MISSION BLOCK PARSING note at the top of this file.
      missionBuffer.push({ indent, text: t });
      continue;
    }
    if (genericBlockName !== null) {
      genericBuffer.push({ indent, text: t });
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  REPUTATION  (indent 1)
    // ════════════════════════════════════════════════════════
    if (inReputation && indent === 1) {
      const faction = _esName(toks[0]);
      const val     = parseFloat(toks[1]) || 0;
      result.pilot.reputations[faction] = val;
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  CONDITIONS  (indent 1)
    // ════════════════════════════════════════════════════════
    if (inConditions && indent === 1) {
      const ckey = _esName(toks[0]);
      const cval = toks[1] != null ? (parseFloat(toks[1]) || toks[1]) : true;
      result.pilot.conditions[ckey] = cval;
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  LICENSES  (indent 1)
    // ════════════════════════════════════════════════════════
    if (topBlock === 'licenses' && indent === 1) {
      result.licenses.push(_esName(toks[0]));
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  PLUGINS  (indent 1)
    //  Save file lists bare/quoted plugin names only, e.g.:
    //    plugins
    //        DAIS
    //        "KGS (Kai's GIMPed Stuff)"
    //        Rumskib
    //  No version/count info — just the names as the game wrote them.
    // ════════════════════════════════════════════════════════
    if (topBlock === 'plugins' && indent === 1) {
      result.plugins.push(_esName(toks[0]));
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  ACCOUNT  (indents 1-2)
    // ════════════════════════════════════════════════════════
    if (topBlock === 'account') {
      if (indent === 1) {
        inAccountSalaries = false;
        inAccountHistory  = false;
        if (key0 === 'credits')           { result.account.credits = parseInt(toks[1]) || 0; continue; }
        if (key0 === 'score')             { result.account.score   = parseInt(toks[1]) || 0; continue; }
        if (key0 === 'salaries income') { inAccountSalaries = true; continue; }
        if (key0 === 'history')           { inAccountHistory  = true; continue; }
        continue;
      }
      if (indent === 2) {
        if (inAccountSalaries) { result.account.salaries[_esName(toks[0])] = parseInt(toks[1]) || 0; continue; }
        if (inAccountHistory)  { result.account.history.push(parseInt(toks[0]) || 0); continue; }
      }
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  TOP-LEVEL CARGO  (indents 1-2)
    // ════════════════════════════════════════════════════════
    if (topBlock === 'cargo') {
      if (indent === 1) {
        inTopCargoOutfits = (key0 === 'outfits');
        continue;
      }
      if (indent === 2 && inTopCargoOutfits) {
        const oname = _esName(toks[0]);
        const ocount = parseInt(toks[1]) || 1;
        result.cargo.outfits[oname] = (result.cargo.outfits[oname] || 0) + ocount;
        continue;
      }
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  STORAGE  (indents 1-4)
    // ════════════════════════════════════════════════════════
    if (topBlock === 'storage') {
      if (indent === 1) {
        // new planet
        storageEntry = { planet: _esName(toks[1]), cargo: { outfits: {}, commodities: {} } };
        result.storage.push(storageEntry);
        inStorageCargo   = false;
        inStorageOutfits = false;
        continue;
      }
      if (indent === 2 && key0 === 'cargo')   { inStorageCargo = true; inStorageOutfits = false; continue; }
      if (indent === 3 && key0 === 'outfits') { inStorageOutfits = true; continue; }
      if (indent === 4 && storageEntry && inStorageOutfits) {
        const oname  = _esName(toks[0]);
        const ocount = parseInt(toks[1]) || 1;
        storageEntry.cargo.outfits[oname] = (storageEntry.cargo.outfits[oname] || 0) + ocount;
        continue;
      }
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  SHIP BLOCK
    // ════════════════════════════════════════════════════════
    if (!cur) continue;

    // ── INDENT 1 ─────────────────────────────────────────────
    if (indent === 1) {
      // Leaving any sub-blocks
      attrBlock   = false;
      outfitBlock = false;
      attrSub     = null;
      lastHP      = null;
      lastBayArr  = null;
      lastBayIdx  = -1;
      inSpriteBlock = false;

      if (key0 === 'name')       { cur._customName = _esName(toks[1]); cur.customName = cur._customName; continue; }
      if (key0 === 'plural')     { cur.plural    = _esName(toks[1]); continue; }
      if (key0 === 'thumbnail')  { cur.thumbnail = _esName(toks[1]); continue; }
      if (key0 === 'uuid')       { cur._uuid     = toks[1] || ''; continue; }
      if (key0 === 'swizzle')    { cur._swizzle  = parseInt(toks[1]) || 0; continue; }
      if (key0 === 'crew')       { cur._crew     = parseInt(toks[1]) || 0; continue; }
      if (key0 === 'fuel')       { cur._fuel     = parseFloat(toks[1]) || 0; continue; }
      if (key0 === 'shields')    { cur._shields  = parseFloat(toks[1]) || 0; continue; }
      if (key0 === 'hull')       { cur._hull     = parseFloat(toks[1]) || 0; continue; }
      if (key0 === 'system')     { cur._system   = _esName(toks[1]); continue; }
      if (key0 === 'planet')     { cur._planet   = _esName(toks[1]); continue; }
      if (key0 === 'parked')     { cur._parked   = true; continue; }
      if (key0 === 'formation')  { cur._formation = _esName(toks[1]); continue; }

      if (key0 === 'position') {
        cur._position = { x: parseFloat(toks[1]) || 0, y: parseFloat(toks[2]) || 0 };
        continue;
      }

      if (key0 === 'sprite') {
        cur.sprite    = _esName(toks[1]);
        inSpriteBlock = true;   // next indent-2 lines are sprite animation params
        continue;
      }

      if (key0 === 'description') {
        const para = _esName(toks.slice(1).join(' '));
        cur.description = cur.description ? cur.description + '\n' + para : para;
        continue;
      }

      if (key0 === 'attributes') { attrBlock = true; continue; }
      if (key0 === 'outfits')    { outfitBlock = true; continue; }

      // ── engine / reverse engine / steering engine ──
      if (key0 === 'engine') {
        const coords = toks.slice(1, 3).join(' ');
        const entry  = _esMakeEngineEntry(coords);
        // Optional inline zoom as a 3rd token: `engine x y [zoom]`
        if (toks[3] != null && toks[3] !== '') {
          const z = parseFloat(toks[3]);
          if (!isNaN(z)) { entry.zoom = z; entry.extra.zoom = z; }
        }
        cur.engines.push(entry);
        lastHP = { type: 'engine', arr: cur.engines, idx: cur.engines.length - 1 };
        continue;
      }
      if (key0 === 'reverse engine') {
        const coords = toks.slice(1, 3).join(' ');
        const entry  = _esMakeEngineEntry(coords);
        if (toks[3] != null && toks[3] !== '') {
          const z = parseFloat(toks[3]);
          if (!isNaN(z)) { entry.zoom = z; entry.extra.zoom = z; }
        }
        cur.reverseEngines.push(entry);
        lastHP = { type: 'reverseEngine', arr: cur.reverseEngines, idx: cur.reverseEngines.length - 1 };
        continue;
      }
      if (key0 === 'steering engine') {
        const coords = toks.slice(1, 3).join(' ');
        const entry  = _esMakeSteeringEntry(coords);
        if (toks[3] != null && toks[3] !== '') {
          const z = parseFloat(toks[3]);
          if (!isNaN(z)) { entry.zoom = z; entry.extra.zoom = z; }
        }
        cur.steeringEngines.push(entry);
        lastHP = { type: 'steeringEngine', arr: cur.steeringEngines, idx: cur.steeringEngines.length - 1 };
        continue;
      }

      // ── gun / turret ──
      if (key0 === 'gun') {
        const coords = toks.slice(1, 3).join(' ');
        const over   = toks[3] ? _esName(toks[3]) : '';
        cur.guns.push({ coords, over, extra: {} });
        lastHP = { type: 'gun', arr: cur.guns, idx: cur.guns.length - 1 };
        continue;
      }
      if (key0 === 'turret') {
        const coords = toks.slice(1, 3).join(' ');
        const over   = toks[3] ? _esName(toks[3]) : '';
        cur.turrets.push({ coords, over, extra: {} });
        lastHP = { type: 'turret', arr: cur.turrets, idx: cur.turrets.length - 1 };
        continue;
      }

      // ── bay ──
      if (key0 === 'bay') {
        const bayType  = _esName(toks[1] || '');
        const coords   = toks.slice(2, 4).join(' ');
        const entry    = _esMakeBayEntry(coords);
        if (bayType === 'Fighter') {
          cur.fighters.push(entry);
          lastBayArr = cur.fighters;
          lastBayIdx = cur.fighters.length - 1;
        } else {
          // Drone or anything else
          cur.drones.push(entry);
          lastBayArr = cur.drones;
          lastBayIdx = cur.drones.length - 1;
        }
        lastHP = null;  // bay sub-lines handled separately
        continue;
      }

      // ── leak ──
      // Format is a fixed, well-known triple: leak "effectName" openChance
      // spreadChance. Both numbers are captured directly by position (not
      // through the generic attribute parser) since there's no ambiguity
      // to resolve here — this shape never had the "only the first number
      // survives" bug that affected open-ended attributes like `arc`.
      if (key0 === 'leak') {
        cur.leaks.push({
          name:         _esName(toks[1] || ''),
          openChance:   parseInt(toks[2]) || 0,
          spreadChance: parseInt(toks[3]) || 0,
        });
        continue;
      }

      // ── explode / final explode ──
      if (key0 === 'explode') {
        cur.explode.push({
          name:  _esName(toks[1] || 'tiny explosion'),
          count: parseInt(toks[2]) || 1,
        });
        continue;
      }
      if (key0 === 'final explode') {
        cur.finalExplode.push({
          name:  _esName(toks[1] || ''),
          count: parseInt(toks[2]) || 1,
        });
        continue;
      }

      // Anything else at indent-1 inside a ship → extraLines
      cur.extraLines.push(raw);
      continue;
    }

    // ── INDENT 2 ─────────────────────────────────────────────
    if (indent === 2) {

      // Sprite animation sub-params — just skip
      if (inSpriteBlock) continue;

      // ── engine / turret / gun sub-properties ──
      // Every value is captured generically into `extra` using the same
      // nested-object (multi-number-on-one-line) / flat-sibling (repeated
      // key) convention as parser.js. A handful of well-known keys are
      // ALSO mirrored onto dedicated convenience fields — but only for
      // engines/reverse/steering engines, where there's no naming clash.
      // For guns/turrets, `over` already means "the outfit mounted here"
      // (captured from the gun/turret line itself), so a bare `over` or
      // `under` flag underneath one is kept ONLY in `extra` to avoid
      // silently overwriting the outfit name with a boolean.
      if (lastHP && lastHP.arr) {
        const entry = lastHP.arr[lastHP.idx];
        entry.extra = entry.extra || {};
        const parsed = _esAttrLine(t);
        if (parsed) {
          const [k, v] = parsed;
          _esMergeAttr(entry.extra, k, v);
          if (lastHP.type !== 'gun' && lastHP.type !== 'turret') {
            const scalar = v.length === 1 ? v[0] : null;
            if (k === 'zoom'   && scalar != null && entry.zoom   === '') entry.zoom   = scalar;
            if (k === 'angle'  && scalar != null && entry.angle  === '') entry.angle  = scalar;
            if (k === 'gimbal' && scalar != null && entry.gimbal === '') entry.gimbal = scalar;
            if (k === 'over')  entry.over  = true;
            if (k === 'under') entry.under = true;
            if (lastHP.type === 'steeringEngine') {
              if (k === 'left')  entry.side = 'left';
              if (k === 'right') entry.side = 'right';
            }
          }
          continue;
        }
      }

      // ── bay sub-properties ──
      if (lastBayArr && lastBayIdx >= 0) {
        const bayEntry = lastBayArr[lastBayIdx];
        bayEntry.extra = bayEntry.extra || {};
        const parsed = _esAttrLine(t);
        if (parsed) {
          const [k, v] = parsed;
          const scalar = v.length === 1 ? v[0] : null;
          if (k === 'launch effect') { bayEntry.launchEffect = scalar != null ? scalar : v.join(' '); continue; }
          if (k === 'angle' && bayEntry.angle === '' && scalar != null) { bayEntry.angle = scalar; continue; }
          _esMergeAttr(bayEntry.extra, k, v);
          continue;
        }
      }

      // ── attributes block ──
      if (attrBlock) {
        if (!toks.length) continue;

        if (key0 === 'licenses') { attrSub = 'licenses'; cur.attributes.licenses = cur.attributes.licenses || {}; continue; }
        if (key0 === 'weapon')   {
          attrSub = 'weapon';
          // _esBlankShip() pre-fills cur.weapon with placeholder zeros for
          // the 4 well-known fields. If we merge real values into that
          // object as-is, _esMergeAttr sees "blast radius" already
          // present (as the placeholder 0) and wrongly treats the first
          // REAL value as a second occurrence, shifting everything into
          // "_2"/"_3". Since we now know this ship actually has its own
          // weapon block, clear the placeholder first so the real values
          // land on their plain, unsuffixed keys.
          cur.weapon = {};
          continue;
        }
        // sprite / flare / sound sub-entries inside attributes — just skip
        if (key0 === 'flare sprite' || key0 === 'reverse flare sprite' ||
            key0 === 'steering flare sprite' || key0 === 'flare sound' ||
            key0 === 'reverse flare sound' || key0 === 'steering flare sound') {
          attrSub = 'spriteParam'; continue;
        }
        if (attrSub === 'spriteParam') {
          // Check if still at indent 2 — this line IS at indent 2, so it's a new attr
          // (the frame rate sub-line would be at indent 3, handled below)
          attrSub = null;
        }

        const valStr = toks.slice(1).join(' ');
        if (key0 === 'mass') { cur.mass = valStr; continue; }
        if (key0 === 'drag') { cur.drag = valStr; continue; }
        cur.attributes[key0] = valStr;
        continue;
      }

      // ── outfits block ──
      if (outfitBlock) {
        // toks[0] is the outfit name (may be quoted or bare or backtick-stripped)
        const oname  = _esName(toks[0]);
        const ocount = parseInt(toks[1]) || 1;
        // Check if we already have this outfit (aggregate duplicates)
        const existing = cur.outfits.find(o => o.name === oname);
        if (existing) {
          existing.count += ocount;
        } else {
          cur.outfits.push({ name: oname, count: ocount, pluginId: null });
        }
        continue;
      }

      // fallthrough
      cur.extraLines.push(raw);
      continue;
    }

    // ── INDENT 3 ─────────────────────────────────────────────
    if (indent === 3) {
      if (attrBlock) {
        if (attrSub === 'licenses') {
          cur.attributes.licenses[_esName(toks[0])] = true;
          continue;
        }
        if (attrSub === 'weapon') {
          // Same generic, nested/sibling-naming attribute merge as the
          // outfit weapon blocks in parser.js — a ship's own `weapon`
          // block (self-destruct/collision damage) can in principle carry
          // multi-number or repeated attributes too, and this keeps every
          // value instead of silently dropping all but the first number.
          const parsed = _esAttrLine(t);
          if (parsed) {
            const [k, v] = parsed;
            _esMergeAttr(cur.weapon, k, v);
          }
          continue;
        }
        // sub-params of flare sprites (frame rate, rewind, etc.) — skip
        continue;
      }
      // Steering engine left/right can appear at indent 3 in some formats
      if (lastHP && lastHP.type === 'steeringEngine') {
        const entry = lastHP.arr[lastHP.idx];
        if (key0 === 'left')  { entry.side = 'left';  entry.extra.left  = true; continue; }
        if (key0 === 'right') { entry.side = 'right'; entry.extra.right = true; continue; }
      }
      cur.extraLines.push(raw);
      continue;
    }

    // Deeper indents — skip / extraLines
    if (cur) cur.extraLines.push(raw);
  }

  // Don't forget the last ship
  if (cur) result.ships.push(cur);
  // ...or the last mission, if the file ends mid-block
  if (missionName !== null) {
    result.missions.push({ name: missionName, raw: _esBuildRawTree(missionBuffer, 1) });
  }
  // ...or the last generically-captured block
  if (genericBlockName !== null) {
    (result.blocks[genericBlockName] = result.blocks[genericBlockName] || [])
      .push({ name: genericBlockArg, raw: _esBuildRawTree(genericBuffer, 1) });
  }

  // Convenience aliases onto generic-block names callers are most likely to
  // want directly, without digging into `result.blocks`.
  result.events  = result.blocks.event  || [];
  result.changes = result.blocks.changes || [];

  // "available job" is a DISTINCT keyword from "mission" in real save
  // files — confirmed against an actual save, not assumed: `mission "X"`
  // is a genuinely held mission (has a uuid, and if any NPCs/on-enter
  // triggers were set up when it was accepted, those are serialised too);
  // `"available job" "X"` is a job-board candidate whose `to offer` roll
  // already passed but that the player has NOT accepted — it carries none
  // of that accepted-state machinery, just the template fields. So these
  // get their own first-class field rather than being just another
  // generic block, since missionStatusHelper.js needs to tell them apart
  // reliably, not guess.
  result.availableJobs = result.blocks['available job'] || [];

  // `visited` / `visited planet` are NOT a block-with-children in real
  // save files — confirmed against an actual save — they're hundreds of
  // separate single-line top-level entries, one per system/planet, e.g.
  // `visited "1 Axis"` / `"visited planet" Ada`. The generic capture above
  // already handles that correctly (each one starts and immediately closes
  // its own zero-child "block"), so this just flattens the result into
  // the plain string lists a consumer actually wants.
  result.visitedSystems = (result.blocks.visited || []).map(b => b.name).filter(Boolean);
  result.visitedPlanets = (result.blocks['visited planet'] || []).map(b => b.name).filter(Boolean);

  // `harvested` is a single block listing flat material names with no
  // values — flatten to a plain string list for the same reason.
  result.harvested = ((result.blocks.harvested || [])[0]?.raw || []).map(n => n.key);

  return result;
}

// ═══════════════════════════════════════════════════════════
//  CONVENIENCE HELPERS
// ═══════════════════════════════════════════════════════════

// Convert a parsed save-file ship into the exact shape shipBuilder.js
// uses internally (for dropping into sbFleet directly).
function saveShipToBuilderFormat(ship) {
  return {
    id:          ship.id,
    name:        ship._modelName,     // model/class name used by shipBuilder as "name"
    customName:  ship._customName,    // pilot-assigned name — extra field not in original format
    variant:     ship.variant   || '',
    plural:      ship.plural    || '',
    sprite:      ship.sprite    || '',
    thumbnail:   ship.thumbnail || '',
    description: ship.description || '',
    mass:        ship.mass || '',
    drag:        ship.drag || '',
    attributes:  { ...ship.attributes },
    weapon:      { ...ship.weapon },
    outfits:     ship.outfits.map(o => ({ ...o })),
    guns:        ship.guns.map(g => ({ coords: g.coords, over: g.over, extra: { ...(g.extra || {}) } })),
    turrets:     ship.turrets.map(g => ({ coords: g.coords, over: g.over, extra: { ...(g.extra || {}) } })),
    drones:      ship.drones.map(d => ({ coords: d.coords, launchEffect: d.launchEffect, extra: { ...(d.extra || {}) } })),
    fighters:    ship.fighters.map(f => ({ coords: f.coords, launchEffect: f.launchEffect, extra: { ...(f.extra || {}) } })),
    engines:     ship.engines.map(e => ({ coords: e.coords, zoom: e.zoom, angle: e.angle, gimbal: e.gimbal, extra: { ...(e.extra || {}) } })),
    reverseEngines:  ship.reverseEngines.map(e => ({ coords: e.coords, zoom: e.zoom, angle: e.angle, gimbal: e.gimbal, extra: { ...(e.extra || {}) } })),
    steeringEngines: ship.steeringEngines.map(e => ({ coords: e.coords, zoom: e.zoom, angle: e.angle, gimbal: e.gimbal, side: e.side, extra: { ...(e.extra || {}) } })),
    leaks:       ship.leaks.map(l => ({ ...l })),
    explode:     ship.explode.map(e => ({ ...e })),
    finalExplode: ship.finalExplode.map(e => ({ ...e })),
    extraLines:  [...ship.extraLines],
    _sourceShip:   ship._modelName || null,
    _sourcePlugin: null,
    // Save-file fields preserved
    _uuid:       ship._uuid,
    _swizzle:    ship._swizzle,
    _crew:       ship._crew,
    _fuel:       ship._fuel,
    _shields:    ship._shields,
    _hull:       ship._hull,
    _position:   ship._position,
    _system:     ship._system,
    _planet:     ship._planet,
    _parked:     ship._parked,
    _formation:  ship._formation,
  };
}

// ── Browser entry point ───────────────────────────────────────────────────────
// Call parseESSaveFile(text) directly, or use parseSaveFileFromInput() if you
// have a file <input> element.
async function parseSaveFileFromInput(fileInput) {
  const file = fileInput.files[0];
  if (!file) throw new Error('No file selected');
  const text = await file.text();
  return parseESSaveFile(text);
}

// ── Node.js entry point ───────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseESSaveFile, saveShipToBuilderFormat, parseSaveFileFromInput, _esAttrLine, _esMergeAttr };
}
