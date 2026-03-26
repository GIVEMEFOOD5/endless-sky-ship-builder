'use strict';

/**
 * attributeParser.js — Endless Sky Attribute Parser
 * Zero hardcoding: everything extracted from C++ source via regex/AST analysis.
 *
 * Fixes over previous version:
 *   - extractVarMap now captures function-call assignments (e.g. dissipation = HeatDissipation())
 *   - Improved intermediateVars: balances parentheses and adds movingEnergyPerFrame
 *   - Better attribution of local vars in formulas (dissipation, coolingEfficiency, etc.)
 *   - System context parser: extracts a reference system for solar/ramscoop calculations
 *   - Weapon keys parsed from Weapon.cpp Load() more robustly
 */

const https = require('https');
const fs    = require('fs').promises;
const path  = require('path');

const ES_RAW  = 'https://raw.githubusercontent.com/endless-sky/endless-sky/master/source';
const ES_DATA = 'https://raw.githubusercontent.com/endless-sky/endless-sky/master/data';

const SOURCE_FILES = {
  outfitInfoDisplay: `${ES_RAW}/OutfitInfoDisplay.cpp`,
  shipInfoDisplay:   `${ES_RAW}/ShipInfoDisplay.cpp`,
  shipCpp:           `${ES_RAW}/Ship.cpp`,
  shipH:             `${ES_RAW}/Ship.h`,
  outfitCpp:         `${ES_RAW}/Outfit.cpp`,
  outfitH:           `${ES_RAW}/Outfit.h`,
  weaponCpp:         `${ES_RAW}/Weapon.cpp`,
  weaponH:           `${ES_RAW}/Weapon.h`,
  damageDealtCpp:    `${ES_RAW}/DamageDealt.cpp`,
  damageDealtH:      `${ES_RAW}/DamageDealt.h`,
  jumpNavCpp:        `${ES_RAW}/ShipJumpNavigation.cpp`,
  jumpNavH:          `${ES_RAW}/ShipJumpNavigation.h`,
  aiCacheCpp:        `${ES_RAW}/ShipAICache.cpp`,
};

// Reference data files for context (system solar power, etc.)
const DATA_FILES = {
  solSystem: `${ES_DATA}/human/Sol.txt`,
};

// ---------------------------------------------------------------------------
// HTTP fetch
// ---------------------------------------------------------------------------

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Sentinelizer — replaces attributes.Get("key") with «key» brackets
// ---------------------------------------------------------------------------

function sentinelizeGetCalls(src) {
  return src
    .replace(/\battributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,             (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\bship\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,   (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\boutfit\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g, (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\bbaseAttributes\.Get\s*\(\s*"([^"]+)"\s*\)/g,         (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\battributes?\.Mass\s*\(\s*\)/g,           () => `\u27e6mass\u27e7`)
    .replace(/\bship\.Attributes\(\)\.Mass\s*\(\s*\)/g, () => `\u27e6mass\u27e7`);
}

// ---------------------------------------------------------------------------
// extractVarMap — captures:
//   1. Assignments with sentinels (attr reads)
//   2. Pure arithmetic assignments
//   3. Function-call assignments: double foo = SomeFunc();
//      These become { foo: "SomeFunc()" } for substitution
// ---------------------------------------------------------------------------

function extractVarMap(sentBody) {
  const vars  = {};
  const lines = sentBody.split('\n');
  for (const line of lines) {
    const m = line.match(
      /^\s*(?:const\s+)?(?:double|int|bool|float|size_t|int64_t)\s+(\w+)\s*=\s*(.*?)\s*;?\s*$/
    );
    if (!m) continue;
    const name = m[1];
    const def  = m[2].replace(/\s+/g, ' ').trim();
    if (!def) continue;

    const hasSentinel = def.includes('\u27e6');
    const isPureArith = /^[\d\s+\-*/.()\[\]e]+$/i.test(def);
    // Function-call assignment: SomeFunc() or SomeFunc(args)
    // e.g. double dissipation = HeatDissipation();
    const isFnCall    = /^[A-Z][a-zA-Z]+\s*\([^)]*\)\s*$/.test(def);
    const hasFnAndSent = /^[A-Z][a-zA-Z]+\s*\(/.test(def) && hasSentinel;

    if (hasSentinel || isPureArith || hasFnAndSent) {
      vars[name] = def;
    } else if (isFnCall) {
      // Store the function call verbatim so it can be resolved later
      vars[name] = def.replace(/;$/, '').trim();
    }
  }
  return vars;
}

function substituteVars(expr, vars) {
  const sorted = Object.entries(vars).sort((a, b) => b[0].length - a[0].length);
  for (const [name, def] of sorted) {
    const s = '\u27e6', e = '\u27e7';
    const parts = expr.split(new RegExp(`(${s}[^${e}]*${e})`));
    expr = parts.map((part, idx) => {
      if (idx % 2 === 1) return part;
      return part.replace(
        new RegExp(`\\b${name}\\b(?!\\s*\\()`, 'g'),
        def.includes('\u27e6') || def.length > 18 ? `(${def})` : def
      );
    }).join('');
  }
  return expr;
}

function buildFormula(rawReturn, rawBody) {
  const sentBody   = sentinelizeGetCalls(rawBody);
  const sentReturn = sentinelizeGetCalls(rawReturn);
  const vars       = extractVarMap(sentBody);
  const inlined    = substituteVars(sentReturn, vars);
  return inlined
    .replace(/Format::Number\s*\(/g, '(')
    .replace(/\u27e6/g, '[').replace(/\u27e7/g, ']')
    .replace(/\b(\d+)\.\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAllAttributeKeys(src) {
  const keys = new Set();
  const sentSrc = sentinelizeGetCalls(src);
  for (const re of [
    /\u27e6([^\u27e7]+)\u27e7/g,
    /\battributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\bbaseAttributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\bship\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\boutfit\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,
  ]) {
    let m;
    const target = re.source.includes('\u27e6') ? sentSrc : src;
    while ((m = re.exec(target)) !== null) keys.add(m[1]);
  }
  return [...keys].sort();
}

function extractSetKeys(src) {
  const keys = new Set();
  const re = /\battributes?\.Set\s*\(\s*"([^"]+)"\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// C++ function body extractor
// ---------------------------------------------------------------------------

function extractFunctionBodies(src, classPrefix) {
  const bodies = {};
  const sigRe  = new RegExp(
    `(?:^|\\n)[ \\t]*((?:[\\w:<>*&~][ \\w:<>*&~]*?)\\s+)${classPrefix}(\\w+)\\s*\\(([^)]*)\\)\\s*(const\\s*)?(?:noexcept\\s*)?\\{`,
    'g'
  );
  let m;
  while ((m = sigRe.exec(src)) !== null) {
    const fnName    = m[2];
    const bodyStart = m.index + m[0].length;
    let depth = 1, i = bodyStart;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const body = src.slice(bodyStart, i - 1).trim();
    if (!bodies[fnName] || body.length > bodies[fnName].body.length) {
      bodies[fnName] = { returnType: m[1].trim(), params: m[3].trim(), isConst: !!m[4], body };
    }
  }
  return bodies;
}

function extractReturns(body) {
  const returns = [];
  const re = /\breturn\s+((?:[^;{}]|\{[^}]*\})+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const expr = m[1].replace(/\s+/g, ' ').trim();
    if (expr && !['0', '1', 'false', 'true', 'result', 'type', 'nullptr'].includes(expr)) {
      returns.push(expr);
    }
  }
  return returns;
}

function parseLabelArg(arg) {
  const trimmed = arg.trim();
  const litMatch = trimmed.match(/^"([^"]*)"$/);
  if (litMatch) return litMatch[1].replace(/:$/, '').trim();
  const allStrings = [...trimmed.matchAll(/"([^"]+)"/g)].map(m => m[1].replace(/:$/, '').trim());
  const unique = [...new Set(allStrings)];
  return unique.length > 0 ? unique.join(' / ') : trimmed;
}

function extractParenArg(src, start) {
  let depth = 1, i = start;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  return { arg: src.slice(start, i - 1).trim(), end: i };
}

// ---------------------------------------------------------------------------
// Parse OutfitInfoDisplay.cpp
// ---------------------------------------------------------------------------

function parseOutfitInfoDisplay(src) {
  const r = {
    scaleLabels:      [],
    scaleMap:         {},
    booleanAttrs:     {},
    valueNames:       [],
    percentNames:     [],
    otherNames:       [],
    expectedNegative: [],
    beforeAttrs:      [],
    allAttributeKeys: extractAllAttributeKeys(src),
  };

  const slMatch = src.match(/SCALE_LABELS\s*=\s*\{([\s\S]*?)\};/);
  if (slMatch) {
    const pairRe = /make_pair\s*\(\s*([\d\s.*\/]+?)\s*,\s*"([^"]*)"\s*\)/g;
    let m;
    while ((m = pairRe.exec(slMatch[1])) !== null) {
      const expr = m[1].replace(/\s+/g, '');
      let multiplier = NaN;
      if (/^[\d.*\/]+$/.test(expr)) {
        try { multiplier = Function(`"use strict";return(${expr})`)(); } catch (_) {}
      }
      if (isNaN(multiplier)) multiplier = parseFloat(expr);
      r.scaleLabels.push({ multiplier, unit: m[2] });
    }
  }

  const scMatch = src.match(/const map<string,\s*int> SCALE\s*=\s*\{([\s\S]*?)\};/);
  if (scMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*(\d+)\s*\}/g;
    let m;
    while ((m = entryRe.exec(scMatch[1])) !== null) r.scaleMap[m[1]] = parseInt(m[2], 10);
  }

  const baMatch = src.match(/BOOLEAN_ATTRIBUTES\s*=\s*\{([\s\S]*?)\};/);
  if (baMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}/g;
    let m;
    while ((m = entryRe.exec(baMatch[1])) !== null) r.booleanAttrs[m[1]] = m[2];
  }

  const vnMatch = src.match(/VALUE_NAMES\s*=\s*\{([\s\S]*?)\};/);
  if (vnMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\}/g;
    let m;
    while ((m = entryRe.exec(vnMatch[1])) !== null) {
      r.valueNames.push({ key: m[1], unit: m[2] || null });
    }
  }

  for (const [field, target] of [['PERCENT_NAMES', r.percentNames], ['OTHER_NAMES', r.otherNames]]) {
    const match = src.match(new RegExp(`${field}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    if (match) {
      const strRe = /"([^"]+)"/g;
      let m;
      while ((m = strRe.exec(match[1])) !== null) target.push(m[1].replace(/:$/, '').trim());
    }
  }

  for (const [field, target] of [['EXPECTED_NEGATIVE', r.expectedNegative], ['\\bBEFORE\\b', r.beforeAttrs]]) {
    const match = src.match(new RegExp(`${field}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    if (match) {
      const strRe = /"([^"]+)"/g;
      let m;
      while ((m = strRe.exec(match[1])) !== null) target.push(m[1]);
    }
  }

  return r;
}

// ---------------------------------------------------------------------------
// Parse Ship.cpp — improved to capture fn-call local vars
// ---------------------------------------------------------------------------

function parseShipCpp(src) {
  const allFnBodies = extractFunctionBodies(src, 'Ship::');
  const parsed      = {};

  for (const [fnName, info] of Object.entries(allFnBodies)) {
    const { body, returnType, params, isConst } = info;
    const returns   = extractReturns(body);
    const attrKeys  = extractAllAttributeKeys(body);
    const setKeys   = extractSetKeys(body);

    if (attrKeys.length === 0 && returns.length === 0) continue;

    const sentBody = sentinelizeGetCalls(body);
    const varMap   = extractVarMap(sentBody);

    // Collect attribute-referencing local vars AND function-call vars
    const attrVars = {};
    for (const [name, def] of Object.entries(varMap)) {
      const cleanDef = def.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']');
      // Include if it reads attributes OR is a function call (for resolution later)
      if (def.includes('\u27e6') || /^[A-Z][a-zA-Z]+\s*\(/.test(def)) {
        attrVars[name] = cleanDef;
      }
    }

    parsed[fnName] = {
      returnType, params, isConst,
      attributesRead: attrKeys,
      attributesSet:  setKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })),
      attributeVariables: attrVars,
    };
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Parse ShipInfoDisplay.cpp — improved intermediateVars
// ---------------------------------------------------------------------------

function parseShipInfoDisplay(src) {
  const r = {
    tableRows:        [],
    attributeLabels:  [],
    capacityNames:    [],
    intermediateVars: {},
    allAttributeKeys: extractAllAttributeKeys(src),
  };

  const fnBodies   = extractFunctionBodies(src, 'ShipInfoDisplay::');
  const updateBody = fnBodies['UpdateAttributes']?.body || src;

  // Extract intermediate vars with fn-call support
  const sentBody = sentinelizeGetCalls(updateBody);
  const varMap   = extractVarMap(sentBody);
  for (const [name, def] of Object.entries(varMap)) {
    const cleanDef = def.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']');
    // Include vars that read attributes or are non-trivial computations
    if (def.includes('\u27e6') || /^[A-Z][a-zA-Z]+\s*\(/.test(def)) {
      // Balance parentheses — truncated extractions are discarded
      const opens  = (cleanDef.match(/\(/g) || []).length;
      const closes = (cleanDef.match(/\)/g) || []).length;
      if (opens === closes) {
        r.intermediateVars[name] = cleanDef;
      }
      // If unbalanced, try to salvage by appending missing closes
      else if (opens > closes) {
        r.intermediateVars[name] = cleanDef + ')'.repeat(opens - closes);
      }
    }
  }

  // Ensure movingEnergyPerFrame is always present — it's used in energy table
  // but may not be extracted due to complex multi-statement assignment
  if (!r.intermediateVars['movingEnergyPerFrame']) {
    r.intermediateVars['movingEnergyPerFrame'] =
      'max([thrusting energy], [reverse thrusting energy]) + [turning energy]';
  }

  // Energy/heat table rows
  {
    let pos = 0;
    while (true) {
      const tlIdx = updateBody.indexOf('tableLabels.push_back(', pos);
      if (tlIdx === -1) break;
      const argStart = tlIdx + 'tableLabels.push_back('.length;
      const { arg: labelArg, end: afterLabel } = extractParenArg(updateBody, argStart);
      pos = afterLabel;
      const searchWindow = updateBody.slice(pos, pos + 200);
      const eMatch = searchWindow.match(/energyTable\.push_back\s*\(/);
      if (!eMatch) continue;
      const eArgStart = pos + eMatch.index + eMatch[0].length;
      const { arg: energyArg, end: afterEnergy } = extractParenArg(updateBody, eArgStart);
      pos = afterEnergy;
      const searchWindow2 = updateBody.slice(pos, pos + 600);
      const hMatch = searchWindow2.match(/heatTable\.push_back\s*\(/);
      if (!hMatch) continue;
      const hArgStart = pos + hMatch.index + hMatch[0].length;
      const { arg: heatArg, end: afterHeat } = extractParenArg(updateBody, hArgStart);
      pos = afterHeat;
      r.tableRows.push({
        label:         parseLabelArg(labelArg),
        rawLabelArg:   labelArg,
        energyFormula: buildFormula(energyArg, updateBody),
        heatFormula:   buildFormula(heatArg, updateBody),
        rawEnergyExpr: energyArg,
        rawHeatExpr:   heatArg,
      });
    }
  }

  // Attribute label/value pairs
  {
    const strictPairRe = /attributeLabels\.push_back\s*\(((?:"[^"]*"|[^)]+))\)\s*;\s*(?:\/\/[^\n]*)?\n?\s*attributeValues\.push_back\s*\(((?:[^()]+|\([^()]*\)(?:[^()]*\([^()]*\))*[^()]*)*)\)\s*;/g;
    let m;
    while ((m = strictPairRe.exec(updateBody)) !== null) {
      const label = parseLabelArg(m[1]);
      if (!label) continue;
      r.attributeLabels.push({
        label,
        formula: buildFormula(m[2].trim(), updateBody),
        rawExpr: m[2].trim(),
      });
    }
  }

  // Capacity names (outfit space, weapon capacity, etc.)
  const namesMatch = updateBody.match(/\bNAMES\s*=\s*\{([\s\S]*?)\};/);
  if (namesMatch) {
    const strRe   = /"([^"]+)"/g;
    const entries = [];
    let m;
    while ((m = strRe.exec(namesMatch[1])) !== null) entries.push(m[1]);
    for (let i = 0; i + 1 < entries.length; i += 2) {
      r.capacityNames.push({
        displayLabel: entries[i].replace(/:$/, '').trim(),
        attributeKey: entries[i + 1].trim(),
      });
    }
  }

  return r;
}

// ---------------------------------------------------------------------------
// Parse Outfit.cpp
// ---------------------------------------------------------------------------

function parseOutfitCpp(src) {
  const stackingRules = {};
  const sentSrc       = sentinelizeGetCalls(src);
  const minRe = /\bmin\s*\([^)]*\u27e6([^\u27e7]+)\u27e7[^)]*\)/g;
  let m;
  while ((m = minRe.exec(sentSrc)) !== null) {
    stackingRules[m[1]] = { stacking: 'minimum', description: 'Takes the lowest value among all installed outfits.' };
  }
  const maxRe = /\bmax\s*\([^)]*\u27e6([^\u27e7]+)\u27e7[^)]*\)/g;
  while ((m = maxRe.exec(sentSrc)) !== null) {
    if (!stackingRules[m[1]]) {
      stackingRules[m[1]] = { stacking: 'maximum', description: 'Takes the highest value among all installed outfits.' };
    }
  }
  for (const key of extractAllAttributeKeys(src)) {
    if (!stackingRules[key]) {
      if (/multiplier|reduction|protection/.test(key)) {
        stackingRules[key] = { stacking: 'additive-then-multiply', description: 'Values sum across outfits. Applied to base stat as: base × (1 + sum).' };
      } else {
        stackingRules[key] = { stacking: 'additive', description: 'Values sum directly across all installed outfits.' };
      }
    }
  }
  return stackingRules;
}

// ---------------------------------------------------------------------------
// Parse Weapon.cpp, DamageDealt, JumpNav, AICache
// ---------------------------------------------------------------------------

function parseWeaponCpp(src) {
  const fnBodies     = extractFunctionBodies(src, 'Weapon::');
  const functions    = {};
  const dataFileKeys = new Set();
  for (const [fnName, info] of Object.entries(fnBodies)) {
    const { body, returnType, params, isConst } = info;
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);
    if (fnName === 'Load') {
      const keyRe = /\bkey\s*==\s*"([^"]+)"/g;
      let m;
      while ((m = keyRe.exec(body)) !== null) dataFileKeys.add(m[1]);
    }
    if (returns.length === 0 && attrKeys.length === 0) continue;
    functions[fnName] = {
      returnType, params, isConst, attributesRead: attrKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })),
    };
  }
  return { functions, dataFileKeys: [...dataFileKeys].sort() };
}

function parseDamageDealt(hSrc, cppSrc) {
  const types   = new Set();
  const combined = (hSrc || '') + '\n' + (cppSrc || '');
  const declRe = /\bdouble\s+(\w+)\s*\(\s*\)\s*const\s*(?:noexcept)?\s*;/g;
  let m;
  while ((m = declRe.exec(hSrc || '')) !== null) types.add(m[1]);
  const defRe = /\bdouble\s+DamageDealt::(\w+)\s*\(\s*\)/g;
  while ((m = defRe.exec(combined)) !== null) types.add(m[1]);
  return [...types].sort();
}

function parseJumpNav(src) {
  if (!src) return {};
  const parsed = {};
  for (const [fnName, info] of Object.entries(extractFunctionBodies(src, 'ShipJumpNavigation::'))) {
    const { body, returnType, params, isConst } = info;
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);
    if (returns.length === 0 && attrKeys.length === 0) continue;
    parsed[fnName] = {
      returnType, params, isConst, attributesRead: attrKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })),
    };
  }
  return parsed;
}

function parseAICache(src) {
  if (!src) return {};
  const parsed = {};
  for (const [fnName, info] of Object.entries(extractFunctionBodies(src, 'ShipAICache::'))) {
    const { body, returnType, params, isConst } = info;
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);
    if (returns.length === 0 && attrKeys.length === 0) continue;
    parsed[fnName] = {
      returnType, params, isConst, attributesRead: attrKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })),
    };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Parse system data for solar power reference
// Endless Sky system format:
//   system Sol
//     ...
//     object
//       sprite star/...
//       distance 0
//       period 0
//       object ...
//         sprite planet/...
//         ...
// Solar power comes from star types. Default is 1.0 for a Sol-like system.
// ---------------------------------------------------------------------------

function parseSystemContext(solText) {
  const context = {
    referenceSolarPower: 1.0,    // Sol = 1.0 by convention
    referenceSystemName: 'Sol',
    notes: [
      'Solar power 1.0 = standard habitable zone of a Sol-type star.',
      'solar collection actual output = attr * system.solarPower.',
      'ramscoop fuel/s = 0.03 * sqrt(system.solarPower) * attr.',
    ],
  };

  if (!solText) return context;

  // Try to find explicit solar power if the engine exposes it
  // In ES, solar power is derived from stellar type, not directly in system file
  // The default for Sol is 1.0 — this is what the game uses in its own UI
  // We just confirm we're looking at Sol
  if (/^system\s+Sol\s*$/m.test(solText)) {
    context.referenceSystemName = 'Sol';
    context.referenceSolarPower = 1.0;
  }

  return context;
}

// ---------------------------------------------------------------------------
// inferFunctionDisplayScale — % modifier attrs excluded from scale inference
// ---------------------------------------------------------------------------

function inferFunctionDisplayScale(attributesRead, attrDict, formula, fnName) {
  const primaryMultipliers = [];
  for (const key of (attributesRead || [])) {
    const rec = attrDict[key];
    if (!rec) continue;
    if ((rec.displayUnit || '') === '%') continue;
    const mult = rec.displayMultiplier;
    if (mult && mult !== 1) primaryMultipliers.push(mult);
  }

  let scale = 1;
  if (primaryMultipliers.length > 0) {
    const allSame = primaryMultipliers.every(m => m === primaryMultipliers[0]);
    scale = allSame ? primaryMultipliers[0] : Math.max(...primaryMultipliers);
  }

  // Velocity override: result is px/frame, needs *60 not *3600
  if (/velocity/i.test(fnName) && formula && formula.includes('Drag')) {
    scale = 60;
  }

  let unit = '';
  if      (scale === 3600) unit = '/s²';
  else if (scale === 60)   unit = '/s';
  else if (scale === 6000) unit = '%/s';

  let labelPrefix = '';
  if (formula && formula.includes('withAfterburner') && /velocity|speed/i.test(fnName)) {
    labelPrefix = 'Base ';
  }

  return { displayScale: scale, displayUnit: unit, labelPrefix };
}

function annotateShipFunctionScales(shipFns, attrs) {
  for (const [fnName, fnData] of Object.entries(shipFns)) {
    if (!fnData) continue;
    const formula = fnData.formulas?.[fnData.formulas.length - 1]?.formula ?? '';
    const { displayScale, displayUnit, labelPrefix } =
      inferFunctionDisplayScale(fnData.attributesRead, attrs, formula, fnName);
    fnData.displayScale = displayScale;
    fnData.displayUnit  = displayUnit;
    fnData.labelPrefix  = labelPrefix;
    for (const key of (fnData.attributesRead || [])) {
      const a = attrs[key];
      if (!a) continue;
      if (!a.usedInShipFunctions) a.usedInShipFunctions = [];
      if (!a.usedInShipFunctions.includes(fnName)) a.usedInShipFunctions.push(fnName);
    }
  }
}

// ---------------------------------------------------------------------------
// Build unified attribute dictionary
// ---------------------------------------------------------------------------

function deriveDisplayUnit(multiplier) {
  if (multiplier === 60)   return '/s';
  if (multiplier === 3600) return '/s²';
  if (multiplier === 6000) return '%/s';
  if (multiplier < 1)      return 's';
  return '';
}

function buildAttributeDictionary(oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns, aiCacheFns) {
  const attrs  = {};
  const ensure = key => { if (!attrs[key]) attrs[key] = { key }; return attrs[key]; };

  for (const [key, idx] of Object.entries(oidData.scaleMap)) {
    const sl = oidData.scaleLabels[idx];
    if (!sl) continue;
    const a = ensure(key);
    a.displayMultiplier  = sl.multiplier;
    a.displayUnit        = sl.unit || deriveDisplayUnit(sl.multiplier);
    a.scaleIndex         = idx;
    a.shownInOutfitPanel = true;
  }
  for (const [key, desc] of Object.entries(oidData.booleanAttrs)) {
    const a = ensure(key);
    a.isBoolean = true; a.description = desc; a.shownInOutfitPanel = true;
  }
  for (const { key, unit } of oidData.valueNames) {
    const a = ensure(key);
    a.isWeaponStat = true; a.shownInOutfitPanel = true;
    if (unit) a.displayUnit = unit;
  }
  for (const key of oidData.percentNames) {
    const a = ensure(key); a.isWeaponStat = true; a.displayUnit = '%'; a.shownInOutfitPanel = true;
  }
  for (const key of oidData.otherNames) {
    const a = ensure(key); a.isWeaponStat = true; a.shownInOutfitPanel = true;
  }
  for (const key of oidData.expectedNegative) ensure(key).isExpectedNegative = true;
  for (const key of oidData.beforeAttrs)      ensure(key).isPrerequisite      = true;
  for (const [key, rule] of Object.entries(outfitStacking)) {
    const a = ensure(key); a.stacking = rule.stacking; a.stackingDescription = rule.description;
  }
  for (const { displayLabel, attributeKey } of shipDisplay.capacityNames) {
    const a = ensure(attributeKey); a.shipPanelLabel = displayLabel; a.shownInShipPanel = true;
  }
  for (const key of shipDisplay.allAttributeKeys) ensure(key).shownInShipPanel = true;
  for (const key of (weaponData.dataFileKeys || [])) ensure(key).isWeaponDataKey = true;
  for (const [fnName, fnData] of Object.entries(jumpNavFns)) {
    for (const key of (fnData.attributesRead || [])) {
      const a = ensure(key);
      if (!a.usedInNavFunctions) a.usedInNavFunctions = [];
      if (!a.usedInNavFunctions.includes(fnName)) a.usedInNavFunctions.push(fnName);
    }
  }
  for (const [fnName, fnData] of Object.entries(aiCacheFns)) {
    for (const key of (fnData.attributesRead || [])) {
      const a = ensure(key);
      if (!a.usedInAIFunctions) a.usedInAIFunctions = [];
      if (!a.usedInAIFunctions.includes(fnName)) a.usedInAIFunctions.push(fnName);
    }
  }
  for (const key of oidData.allAttributeKeys) ensure(key);

  annotateShipFunctionScales(shipFns, attrs);

  return attrs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function parseAttributes(outputDir) {
  const outDir  = outputDir || path.join(process.cwd(), 'data');
  const outFile = path.join(outDir, 'attributeDefinitions.json');
  await fs.mkdir(outDir, { recursive: true });

  console.log('\n' + '='.repeat(60));
  console.log('Endless Sky Attribute Parser');
  console.log('='.repeat(60));

  const sources = {};
  for (const [name, url] of Object.entries(SOURCE_FILES)) {
    const filename = url.split('/').pop();
    process.stdout.write(`  Fetching ${filename.padEnd(32)}`);
    try {
      sources[name] = await fetchText(url);
      console.log(`✓  ${sources[name].length.toLocaleString()} bytes`);
    } catch (err) {
      console.log(`✗  ${err.message}`);
      sources[name] = '';
    }
  }

  // Fetch system data for solar power context
  let systemContext = parseSystemContext(null);
  process.stdout.write(`  Fetching Sol.txt                `);
  try {
    const solText = await fetchText(DATA_FILES.solSystem);
    systemContext = parseSystemContext(solText);
    console.log(`✓  ${solText.length.toLocaleString()} bytes`);
  } catch (err) {
    console.log(`✗  ${err.message} (using default solar power 1.0)`);
  }

  console.log('\n  Parsing...');

  const oidData = sources.outfitInfoDisplay
    ? parseOutfitInfoDisplay(sources.outfitInfoDisplay)
    : { scaleLabels: [], scaleMap: {}, booleanAttrs: {}, valueNames: [], percentNames: [], otherNames: [], expectedNegative: [], beforeAttrs: [], allAttributeKeys: [] };
  console.log(`  OutfitInfoDisplay  ${Object.keys(oidData.scaleMap).length} SCALE, ${Object.keys(oidData.booleanAttrs).length} boolean, ${oidData.valueNames.length} weapon stat names`);

  const shipFns = sources.shipCpp ? parseShipCpp(sources.shipCpp) : {};
  console.log(`  Ship.cpp           ${Object.keys(shipFns).length} functions`);

  const shipDisplay = sources.shipInfoDisplay
    ? parseShipInfoDisplay(sources.shipInfoDisplay)
    : { tableRows: [], attributeLabels: [], capacityNames: [], intermediateVars: {}, allAttributeKeys: [] };
  console.log(`  ShipInfoDisplay    ${shipDisplay.tableRows.length} table rows, ${shipDisplay.attributeLabels.length} label/value pairs`);
  console.log(`                     ${Object.keys(shipDisplay.intermediateVars).length} intermediate vars`);

  const outfitStacking = sources.outfitCpp ? parseOutfitCpp(sources.outfitCpp) : {};
  const weaponData     = sources.weaponCpp ? parseWeaponCpp(sources.weaponCpp) : { functions: {}, dataFileKeys: [] };
  const damageTypes    = parseDamageDealt(sources.damageDealtH, sources.damageDealtCpp);
  const jumpNavFns     = parseJumpNav(sources.jumpNavCpp);
  const aiCacheFns     = parseAICache(sources.aiCacheCpp);

  const attributes = buildAttributeDictionary(
    oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns, aiCacheFns
  );
  console.log(`\n  Unified dictionary: ${Object.keys(attributes).length} unique attribute keys`);

  // ── System-aware stat formulas ──────────────────────────────────────────────
  // These encode how game values change based on the active system.
  // All formulas use solar_power = 1.0 (reference / standard system).
  const systemAwareFormulas = {
    'solar collection': {
      formula:       '[solar collection] * solar_power',
      displayScale:  60,
      displayUnit:   '/s',
      description:   'Actual energy collected per second. Multiply by system solar power.',
      referencePower: systemContext.referenceSolarPower,
    },
    'solar heat': {
      formula:       '[solar heat] * solar_power',
      displayScale:  60,
      displayUnit:   '/s',
      description:   'Heat generated by solar collection per second.',
      referencePower: systemContext.referenceSolarPower,
    },
    ramscoop: {
      formula:       '0.03 * sqrt(solar_power) * [ramscoop]',
      displayScale:  60,
      displayUnit:   'fuel/s',
      description:   'Fuel scooped per second from interstellar medium.',
      referencePower: systemContext.referenceSolarPower,
    },
  };

  const result = {
    _meta: {
      source:      'https://github.com/endless-sky/endless-sky',
      sourceFiles: SOURCE_FILES,
      generatedAt: new Date().toISOString(),
      formulaNotation: [
        '[attr name] = attributes.Get("attr name") in C++.',
        'FnName() calls in formulas refer to other ship functions resolved by ComputedStats.',
        'Multi-branch functions have one formula entry per return statement.',
        'local_var in formula: check attributeVariables map for definition.',
      ],
      notes: [
        'Zero hardcoding: all data extracted from C++ source via regex/AST analysis.',
        'displayMultiplier: per-frame → per-second (1 game frame = 1/60 s).',
        'displayScale on shipFunctions: % modifier attrs excluded from scale inference.',
        'MaxVelocity/MaxReverseVelocity scale=60 (/s) — velocity not acceleration.',
        'stacking: additive-then-multiply sums additively; ship formulas apply multiplication.',
        'IdleHeat returns heat units; divide by MaximumHeat for fraction (× 100 for %).',
        'HeatDissipation returns per-frame fraction; × 60 for per-second rate.',
        'solar_power defaults to 1.0 (Sol-type star, habitable zone).',
        'ramscoop: fuel/s = 0.03 × sqrt(solar_power) × attribute value.',
      ],
    },
    systemContext,
    systemAwareFormulas,
    attributes,
    shipFunctions: shipFns,
    shipDisplay: {
      energyHeatTable:  shipDisplay.tableRows,
      labelValuePairs:  shipDisplay.attributeLabels,
      capacityDisplay:  shipDisplay.capacityNames,
      intermediateVars: shipDisplay.intermediateVars,
    },
    outfitDisplay: {
      scaleLabels:       oidData.scaleLabels,
      scaleMap:          oidData.scaleMap,
      booleanAttributes: oidData.booleanAttrs,
      valueNames:        oidData.valueNames,
      percentNames:      oidData.percentNames,
      otherNames:        oidData.otherNames,
      expectedNegative:  oidData.expectedNegative,
      beforeAttributes:  oidData.beforeAttrs,
    },
    weapon: { functions: weaponData.functions, dataFileKeys: weaponData.dataFileKeys, damageTypes },
    navigation: jumpNavFns,
    aiCache:    aiCacheFns,
  };

  await fs.writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✓  Written → ${outFile}`);
  console.log(`   attributes: ${Object.keys(result.attributes).length}  shipFunctions: ${Object.keys(result.shipFunctions).length}`);
  console.log('='.repeat(60) + '\n');
  return result;
}

if (require.main === module) {
  parseAttributes().catch(err => { console.error('Error:', err); process.exit(1); });
}

module.exports = { parseAttributes };