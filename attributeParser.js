'use strict';

/**
 * attributeParser.js
 *
 * Fetches Endless Sky C++ source files from GitHub and extracts:
 *   - All outfit attribute keys, display units, scale multipliers
 *   - All Ship:: member function formulas (derived stats)
 *   - ShipInfoDisplay energy/heat table rows and label/value pairs
 *   - Outfit stacking rules
 *   - Weapon stat functions and data-file keys
 *   - All attribute keys referenced anywhere across the codebase
 *
 * Zero hardcoding: everything is extracted from C++ source via regex/AST analysis.
 * Variable assignments are inlined into return expressions to produce clean formulas.
 *
 * Formula notation: [attr name] means attributes.Get("attr name") in C++.
 * Opaque function calls (Drag(), InertialMass(), etc.) remain as-is when they
 * are not themselves reducible to attribute expressions.
 *
 * Output: data/attributeDefinitions.json
 */

const https = require('https');
const fs    = require('fs').promises;
const path  = require('path');

// ---------------------------------------------------------------------------
// Source files to fetch
// ---------------------------------------------------------------------------

const ES_RAW = 'https://raw.githubusercontent.com/endless-sky/endless-sky/master/source';

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
// Formula extraction helpers
// ---------------------------------------------------------------------------

/**
 * Replace all attributes.Get("key") patterns with ⟦key⟧ sentinel.
 *
 * FIX 3: Also treats attributes.Mass() as a read of the "mass" attribute.
 * This ensures Ship::Mass() gets attributesRead: ["mass"] in the JSON,
 * which allows CloakingSpeed() to resolve correctly via Mass().
 */
function sentinelizeGetCalls(src) {
  return src
    .replace(/\battributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,             (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\bship\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,   (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\boutfit\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g, (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\bbaseAttributes\.Get\s*\(\s*"([^"]+)"\s*\)/g,         (_, k) => `\u27e6${k}\u27e7`)
    // FIX 3: treat attributes.Mass() as a read of the "mass" attribute key.
    // This ensures Ship::Mass() and any formula using attributes.Mass()
    // shows up with attributesRead: ["mass"] rather than being dropped.
    .replace(/\battributes?\.Mass\s*\(\s*\)/g,             () => `\u27e6mass\u27e7`)
    .replace(/\bship\.Attributes\(\)\.Mass\s*\(\s*\)/g,   () => `\u27e6mass\u27e7`);
}

/**
 * Extract variable assignments from a sentinelized body.
 * Returns { varName: expressionString }.
 *
 * FIX 5: Extended filter to also capture vars whose RHS starts with a
 * PascalCase() call and contains a sentinel. This captures expressions like:
 *   activeCooling = CoolingEfficiency() * (⟦cooling⟧ + ⟦active cooling⟧)
 * which were previously dropped because the filter only checked for pure
 * sentinel-only or pure-arithmetic RHS values.
 *
 * Also switched to line-by-line matching to avoid multi-line regex greediness
 * issues that could truncate multi-line RHS expressions at the wrong semicolon.
 */
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

    const hasSentinel  = def.includes('\u27e6');
    const isPureArith  = /^[\d\s+\-*/.()\[\]e]+$/i.test(def);
    // FIX 5: also accept RHS that starts with a PascalCase fn call AND has
    // a sentinel anywhere (e.g. activeCooling = CoolingEfficiency() * (⟦...⟧))
    const hasFnAndSent = /^[A-Z][a-zA-Z]+\s*\(/.test(def) && hasSentinel;

    if (hasSentinel || isPureArith || hasFnAndSent) {
      vars[name] = def;
    }
  }

  return vars;
}

/**
 * Substitute variable names in expr, but ONLY outside ⟦...⟧ protected regions.
 */
function substituteVars(expr, vars) {
  const sorted = Object.entries(vars).sort((a, b) => b[0].length - a[0].length);
  for (const [name, def] of sorted) {
    const sentinel = '\u27e6', endSentinel = '\u27e7';
    const parts = expr.split(new RegExp(`(${sentinel}[^${endSentinel}]*${endSentinel})`));
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

/**
 * Build a clean formula from a raw return expression and its surrounding body.
 */
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

/** Collect all unique attribute keys referenced via Get() anywhere in a source text. */
function extractAllAttributeKeys(src) {
  const keys = new Set();
  // Also pick up the sentinelized mass token after FIX 3
  const sentSrc = sentinelizeGetCalls(src);
  for (const re of [
    /\u27e6([^\u27e7]+)\u27e7/g,   // already-sentinelized (picks up ⟦mass⟧ too)
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

/** Collect all attribute keys written via Set() anywhere in a source text. */
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

/** Extract all return expressions from a function body. */
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
// Parse Ship.cpp — extract all member function formulas
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
    const attrVars = {};
    for (const [name, def] of Object.entries(varMap)) {
      if (def.includes('\u27e6')) {
        attrVars[name] = def.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']');
      }
    }

    parsed[fnName] = {
      returnType,
      params,
      isConst,
      attributesRead: attrKeys,
      attributesSet:  setKeys,
      formulas: returns.map(ret => ({
        rawReturn: ret,
        formula:   buildFormula(ret, body),
      })),
      attributeVariables: attrVars,
    };
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Parse ShipInfoDisplay.cpp
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

  const sentBody = sentinelizeGetCalls(updateBody);
  const varMap   = extractVarMap(sentBody);
  for (const [name, def] of Object.entries(varMap)) {
    if (def.includes('\u27e6')) {
      r.intermediateVars[name] = def.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']');
    }
  }

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

  const namesMatch = updateBody.match(/\bNAMES\s*=\s*\{([\s\S]*?)\};/);
  if (namesMatch) {
    const strRe  = /"([^"]+)"/g;
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
// Parse Outfit.cpp — attribute stacking rules
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
        stackingRules[key] = {
          stacking:    'additive-then-multiply',
          description: 'Values sum across outfits. Applied to base stat as: base × (1 + sum).',
        };
      } else {
        stackingRules[key] = {
          stacking:    'additive',
          description: 'Values sum directly across all installed outfits.',
        };
      }
    }
  }

  return stackingRules;
}

// ---------------------------------------------------------------------------
// Parse Weapon.cpp
// ---------------------------------------------------------------------------

function parseWeaponCpp(src) {
  const fnBodies    = extractFunctionBodies(src, 'Weapon::');
  const functions   = {};
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
      returnType,
      params,
      isConst,
      attributesRead: attrKeys,
      formulas: returns.map(ret => ({
        rawReturn: ret,
        formula:   buildFormula(ret, body),
      })),
    };
  }

  return { functions, dataFileKeys: [...dataFileKeys].sort() };
}

// ---------------------------------------------------------------------------
// Parse DamageDealt.h/cpp
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parse ShipJumpNavigation.cpp
// ---------------------------------------------------------------------------

function parseJumpNav(src) {
  if (!src) return {};
  const parsed = {};
  for (const [fnName, info] of Object.entries(extractFunctionBodies(src, 'ShipJumpNavigation::'))) {
    const { body, returnType, params, isConst } = info;
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);
    if (returns.length === 0 && attrKeys.length === 0) continue;
    parsed[fnName] = {
      returnType, params, isConst,
      attributesRead: attrKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })),
    };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Parse ShipAICache.cpp
// ---------------------------------------------------------------------------

function parseAICache(src) {
  if (!src) return {};
  const parsed = {};
  for (const [fnName, info] of Object.entries(extractFunctionBodies(src, 'ShipAICache::'))) {
    const { body, returnType, params, isConst } = info;
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);
    if (returns.length === 0 && attrKeys.length === 0) continue;
    parsed[fnName] = {
      returnType, params, isConst,
      attributesRead: attrKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })),
    };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// FIX 1 & 2: inferFunctionDisplayScale
//
// Derives the per-frame → per-second display scale for a ship function's
// output entirely from the displayMultipliers of the attributes it reads.
//
// Rules (zero hardcoding):
//   - Collect displayMultiplier for every attribute the function reads.
//   - If ALL collected multipliers are equal → that is the output scale.
//   - If mixed → take the minimum (conservative, avoids over-scaling).
//   - If none → scale = 1 (dimensionless result, e.g. MaxShields, MaxHull).
//
// displayUnit is inferred from scale to match the SCALE_LABELS pattern:
//   3600 → /s²  (acceleration)
//    60  → /s   (velocity, rates)
//   6000 → %/s
//      1 → ''   (dimensionless)
//
// labelPrefix: if the formula contains "withAfterburner" AND the function
// name contains "Velocity" or "Speed", it's labelled "Base " to clarify
// that afterburner contribution is excluded (withAfterburner is zeroed
// during base stat evaluation).
// ---------------------------------------------------------------------------

function inferFunctionDisplayScale(attributesRead, attrDict, formula, fnName) {
  const multipliers = [];
  for (const key of (attributesRead || [])) {
    const m = attrDict[key]?.displayMultiplier;
    if (m && m !== 1) multipliers.push(m);
  }

  let scale = 1;
  if (multipliers.length > 0) {
    const allSame = multipliers.every(m => m === multipliers[0]);
    scale = allSame ? multipliers[0] : Math.min(...multipliers);
  }

  let unit = '';
  if      (scale === 3600) unit = '/s²';
  else if (scale === 60)   unit = '/s';
  else if (scale === 6000) unit = '%/s';

  let labelPrefix = '';
  if (
    formula &&
    formula.includes('withAfterburner') &&
    /velocity|speed/i.test(fnName)
  ) {
    labelPrefix = 'Base ';
  }

  return { displayScale: scale, displayUnit: unit, labelPrefix };
}

// ---------------------------------------------------------------------------
// FIX 1 & 2: annotateShipFunctionScales
//
// Writes displayScale, displayUnit, labelPrefix into each shipFunctions entry
// and updates usedInShipFunctions on each attribute.
// Called at the end of buildAttributeDictionary after attrs is fully seeded.
// ---------------------------------------------------------------------------

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
      if (!a.usedInShipFunctions.includes(fnName)) {
        a.usedInShipFunctions.push(fnName);
      }
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

  // SCALE map + SCALE_LABELS
  for (const [key, idx] of Object.entries(oidData.scaleMap)) {
    const sl = oidData.scaleLabels[idx];
    if (!sl) continue;
    const a = ensure(key);
    a.displayMultiplier  = sl.multiplier;
    a.displayUnit        = sl.unit || deriveDisplayUnit(sl.multiplier);
    a.scaleIndex         = idx;
    a.shownInOutfitPanel = true;
  }

  // Boolean attributes
  for (const [key, desc] of Object.entries(oidData.booleanAttrs)) {
    const a = ensure(key);
    a.isBoolean = true; a.description = desc; a.shownInOutfitPanel = true;
  }

  // VALUE_NAMES (weapon damage stats)
  for (const { key, unit } of oidData.valueNames) {
    const a = ensure(key);
    a.isWeaponStat = true; a.shownInOutfitPanel = true;
    if (unit) a.displayUnit = unit;
  }

  // PERCENT_NAMES
  for (const key of oidData.percentNames) {
    const a = ensure(key);
    a.isWeaponStat = true; a.displayUnit = '%'; a.shownInOutfitPanel = true;
  }

  // OTHER_NAMES
  for (const key of oidData.otherNames) {
    const a = ensure(key);
    a.isWeaponStat = true; a.shownInOutfitPanel = true;
  }

  // EXPECTED_NEGATIVE
  for (const key of oidData.expectedNegative) ensure(key).isExpectedNegative = true;

  // Prerequisite attrs
  for (const key of oidData.beforeAttrs) ensure(key).isPrerequisite = true;

  // Stacking rules
  for (const [key, rule] of Object.entries(outfitStacking)) {
    const a = ensure(key);
    a.stacking = rule.stacking; a.stackingDescription = rule.description;
  }

  // NOTE: usedInShipFunctions is now handled by annotateShipFunctionScales below.
  // The old loop has been removed to avoid duplication.

  // ShipInfoDisplay capacity NAMES
  for (const { displayLabel, attributeKey } of shipDisplay.capacityNames) {
    const a = ensure(attributeKey);
    a.shipPanelLabel = displayLabel; a.shownInShipPanel = true;
  }

  // ShipInfoDisplay Get() keys
  for (const key of shipDisplay.allAttributeKeys) ensure(key).shownInShipPanel = true;

  // Weapon data-file keys
  for (const key of (weaponData.dataFileKeys || [])) ensure(key).isWeaponDataKey = true;

  // Navigation functions
  for (const [fnName, fnData] of Object.entries(jumpNavFns)) {
    for (const key of (fnData.attributesRead || [])) {
      const a = ensure(key);
      if (!a.usedInNavFunctions) a.usedInNavFunctions = [];
      if (!a.usedInNavFunctions.includes(fnName)) a.usedInNavFunctions.push(fnName);
    }
  }

  // AI cache functions
  for (const [fnName, fnData] of Object.entries(aiCacheFns)) {
    for (const key of (fnData.attributesRead || [])) {
      const a = ensure(key);
      if (!a.usedInAIFunctions) a.usedInAIFunctions = [];
      if (!a.usedInAIFunctions.includes(fnName)) a.usedInAIFunctions.push(fnName);
    }
  }

  // All remaining Get() keys from OutfitInfoDisplay
  for (const key of oidData.allAttributeKeys) ensure(key);

  // FIX 1 & 2: annotate ship functions with displayScale, displayUnit, labelPrefix
  // and populate usedInShipFunctions on each attribute.
  // Must run AFTER all attrs are seeded so displayMultiplier lookups work.
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

  console.log('\n  Parsing...');

  const oidData = sources.outfitInfoDisplay
    ? parseOutfitInfoDisplay(sources.outfitInfoDisplay)
    : { scaleLabels: [], scaleMap: {}, booleanAttrs: {}, valueNames: [], percentNames: [], otherNames: [], expectedNegative: [], beforeAttrs: [], allAttributeKeys: [] };
  console.log(`  OutfitInfoDisplay  ${Object.keys(oidData.scaleMap).length} SCALE, ${Object.keys(oidData.booleanAttrs).length} boolean, ${oidData.valueNames.length} weapon stat names`);

  const shipFns = sources.shipCpp ? parseShipCpp(sources.shipCpp) : {};
  console.log(`  Ship.cpp           ${Object.keys(shipFns).length} functions with attribute references`);

  const shipDisplay = sources.shipInfoDisplay
    ? parseShipInfoDisplay(sources.shipInfoDisplay)
    : { tableRows: [], attributeLabels: [], capacityNames: [], intermediateVars: {}, allAttributeKeys: [] };
  console.log(`  ShipInfoDisplay    ${shipDisplay.tableRows.length} table rows, ${shipDisplay.attributeLabels.length} label/value pairs, ${shipDisplay.capacityNames.length} capacity names`);

  const outfitStacking = sources.outfitCpp ? parseOutfitCpp(sources.outfitCpp) : {};
  console.log(`  Outfit.cpp         ${Object.keys(outfitStacking).length} stacking rules`);

  const weaponData = sources.weaponCpp
    ? parseWeaponCpp(sources.weaponCpp)
    : { functions: {}, dataFileKeys: [] };
  console.log(`  Weapon.cpp         ${Object.keys(weaponData.functions).length} functions, ${weaponData.dataFileKeys.length} data-file keys`);

  const damageTypes = parseDamageDealt(sources.damageDealtH, sources.damageDealtCpp);
  console.log(`  DamageDealt        ${damageTypes.length} damage types`);

  const jumpNavFns = parseJumpNav(sources.jumpNavCpp);
  console.log(`  ShipJumpNavigation ${Object.keys(jumpNavFns).length} navigation functions`);

  const aiCacheFns = parseAICache(sources.aiCacheCpp);
  console.log(`  ShipAICache        ${Object.keys(aiCacheFns).length} AI cache functions`);

  const attributes = buildAttributeDictionary(
    oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns, aiCacheFns
  );
  console.log(`\n  Unified dictionary: ${Object.keys(attributes).length} unique attribute keys`);

  const result = {
    _meta: {
      source:      'https://github.com/endless-sky/endless-sky',
      sourceFiles: SOURCE_FILES,
      generatedAt: new Date().toISOString(),
      formulaNotation: [
        '[attr name] = attributes.Get("attr name") in C++.',
        'Function calls like Drag(), InertialMass() remain as-is when not reducible to attribute expressions.',
        'Multi-branch functions (MinimumHull, Health, etc.) have one formula entry per return statement.',
      ],
      notes: [
        'Zero hardcoding: all data extracted from C++ source via regex/AST analysis.',
        'displayMultiplier converts per-frame game values to per-second for display (1 frame = 1/60 s).',
        'stacking: additive = direct sum; additive-then-multiply = base*(1+sum); minimum/maximum = extreme.',
        'attributeVariables: intermediate local vars that directly read attributes (shows formula inputs).',
        'FIX 1&2: shipFunctions entries now carry displayScale, displayUnit, labelPrefix for correct unit display.',
        'FIX 3: attributes.Mass() sentinelized as [mass] so Mass() resolves correctly in CloakingSpeed.',
        'FIX 5: extractVarMap captures PascalCase()-leading RHS with sentinels (e.g. activeCooling).',
      ],
    },

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

    weapon: {
      functions:    weaponData.functions,
      dataFileKeys: weaponData.dataFileKeys,
      damageTypes,
    },

    navigation: jumpNavFns,
    aiCache:    aiCacheFns,
  };

  await fs.writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n' + '='.repeat(60));
  console.log(`✓  Written → ${outFile}`);
  console.log(`   attributes         ${Object.keys(result.attributes).length}`);
  console.log(`   shipFunctions      ${Object.keys(result.shipFunctions).length}`);
  console.log(`   energyHeatTable    ${result.shipDisplay.energyHeatTable.length} rows`);
  console.log(`   labelValuePairs    ${result.shipDisplay.labelValuePairs.length}`);
  console.log(`   outfitDisplay.scale ${Object.keys(result.outfitDisplay.scaleMap).length} attrs`);
  console.log(`   weapon.functions   ${Object.keys(result.weapon.functions).length}`);
  console.log(`   weapon.damageTypes ${result.weapon.damageTypes.length}`);
  console.log(`   navigation fns     ${Object.keys(result.navigation).length}`);
  console.log('='.repeat(60) + '\n');

  return result;
}

if (require.main === module) {
  parseAttributes().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = { parseAttributes };
