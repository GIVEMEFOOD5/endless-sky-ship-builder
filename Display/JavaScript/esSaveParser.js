'use strict';

// ═══════════════════════════════════════════════════════════
//  esSaveParser.js
//
//  Parses an Endless Sky save file and returns a structured
//  object containing:
//    - pilot       : top-level pilot metadata
//    - ships       : array of ship objects in shipBuilder format
//    - storage     : per-planet stored cargo/outfits
//    - licenses    : array of license strings
//    - account     : credits, score, salaries, history
//    - cargo       : player's carried cargo/outfits
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

  const qv = rest.match(/^"([^"]+)"$/) || rest.match(/^`([^`]+)`$/) || rest.match(/^'([^']+)'$/);
  if (qv) return [key, [qv[1]]];

  const qvPlus = rest.match(/^"([^"]+)"\s+(.+)$/) ||
                 rest.match(/^`([^`]+)`\s+(.+)$/) ||
                 rest.match(/^'([^']+)'\s+(.+)$/);
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

// ── Blank ship (matches shipBuilder internal format) ─────────────────────────
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
//  Returns { pilot, ships, storage, licenses, account, cargo }
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
    storage: [],        // [{ planet, cargo: { outfits: {name→count}, commodities: {} } }]
    licenses: [],
    plugins: [],         // installed plugin names, exactly as written in the save file
    account: { credits: 0, score: 0, salaries: {}, history: [] },
    cargo: { outfits: {}, commodities: {} },
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

      // Reset all block flags
      attrBlock = false; outfitBlock = false; attrSub = null;
      lastHP = null; lastBayArr = null; lastBayIdx = -1;
      inSpriteBlock = false;
      storageEntry = null; inStorageCargo = false; inStorageOutfits = false;
      inAccountSalaries = false; inAccountHistory = false;
      inTopCargo = false; inTopCargoOutfits = false;
      inReputation = false; inConditions = false;

      topBlock = key0;

      // ── ship ──
      if (key0 === 'ship') {
        cur = _esBlankShip();
        // model name is toks[1]; save files don't have variants at this line
        cur._modelName = _esName(toks[1] || '');
        cur.name       = cur._modelName;
        continue;
      }

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
      if (key0 === 'mission')            { topBlock = 'mission'; continue; }  // skip
      if (key0 === 'event')              { topBlock = 'event'; continue; }    // skip
      if (key0 === 'changes')            { topBlock = 'changes'; continue; }  // skip
      if (key0 === 'economy')            { topBlock = 'economy'; continue; }  // skip
      if (key0 === 'visited')            { /* skip */ continue; }

      // anything else at top level → store raw
      result.pilot.raw[key0] = toks.slice(1).join(' ');
      continue;
    }

    // ════════════════════════════════════════════════════════
    //  SKIP BLOCKS we don't parse deeply
    // ════════════════════════════════════════════════════════
    if (topBlock === 'mission' || topBlock === 'event' ||
        topBlock === 'changes' || topBlock === 'economy') {
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
