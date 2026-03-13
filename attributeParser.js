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
//
// Strategy:
//   1. Sentinelize: replace ALL attributes.Get("key") calls with ⟦key⟧ BEFORE
//      any variable substitution. This prevents "thrust" from matching inside
//      the already-replaced token "⟦afterburner thrust⟧".
//
//   2. Extract local variable assignments. Only keep vars whose RHS contains a
//      ⟦sentinel⟧ (directly reads an attribute) or is pure arithmetic.
//      Skip vars assigned from opaque calls like CoolingEfficiency() - these
//      remain as readable function-call references in the final formula.
//
//   3. Substitute variable names in return expressions ONLY outside ⟦...⟧
//      brackets (using split-and-rejoin to protect sentinels).
//
//   4. Convert ⟦key⟧ → [key] in the final output.
// ---------------------------------------------------------------------------

/** Replace all attributes.Get("key") patterns with ⟦key⟧ sentinel. */
function sentinelizeGetCalls(src) {
  return src
    .replace(/\battributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,             (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\bship\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,   (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\boutfit\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g, (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\bbaseAttributes\.Get\s*\(\s*"([^"]+)"\s*\)/g,         (_, k) => `\u27e6${k}\u27e7`);
}

/**
 * Extract variable assignments from a sentinelized body.
 * Returns { varName: expressionString }.
 * Only includes vars whose value contains a sentinel or is pure arithmetic.
 */
function extractVarMap(sentBody) {
  const vars = {};
  const varRe = /(?:const\s+)?(?:double|int|bool|float|size_t|int64_t)\s+(\w+)\s*=\s*([\s\S]*?);/g;
  let m;
  while ((m = varRe.exec(sentBody)) !== null) {
    const def = m[2].replace(/\s+/g, ' ').trim();
    if (def.includes('\u27e6') || /^[\d\s+\-*/.()\[\]e]+$/i.test(def)) {
      vars[m[1]] = def;
    }
  }
  return vars;
}

/**
 * Substitute variable names in expr, but ONLY outside ⟦...⟧ protected regions.
 * Uses split-and-rejoin to avoid touching sentinelized attribute names.
 */
function substituteVars(expr, vars) {
  const sorted = Object.entries(vars).sort((a, b) => b[0].length - a[0].length);
  for (const [name, def] of sorted) {
    const sentinel = '\u27e6', endSentinel = '\u27e7';
    const parts = expr.split(new RegExp(`(${sentinel}[^${endSentinel}]*${endSentinel})`));
    expr = parts.map((part, idx) => {
      if (idx % 2 === 1) return part; // inside ⟦...⟧, protected
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
 * Output uses [attr name] notation for all attribute reads.
 */
function buildFormula(rawReturn, rawBody) {
  const sentBody   = sentinelizeGetCalls(rawBody);
  const sentReturn = sentinelizeGetCalls(rawReturn);
  const vars       = extractVarMap(sentBody);
  const inlined    = substituteVars(sentReturn, vars);
  return inlined
    .replace(/Format::Number\s*\(/g, '(')
    .replace(/\u27e6/g, '[').replace(/\u27e7/g, ']')
    .replace(/\b(\d+)\.\b/g, '$1')   // strip trailing dots from literals: 60. → 60
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collect all unique attribute keys referenced via Get() anywhere in a source text. */
function extractAllAttributeKeys(src) {
  const keys = new Set();
  for (const re of [
    /\battributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\bbaseAttributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\bship\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\boutfit\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,
  ]) {
    let m;
    while ((m = re.exec(src)) !== null) keys.add(m[1]);
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
// Finds all `RetType Class::FnName(params) [const] { ... }` via brace-counting.
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

/**
 * Parse a C++ push_back label argument into a human-readable string.
 * Handles: "literal string", simple ternary, and nested ternary.
 * For conditional labels, collects all string literals and joins with " / ".
 */
function parseLabelArg(arg) {
  const trimmed = arg.trim();
  // Simple string literal
  const litMatch = trimmed.match(/^"([^"]*)"$/);
  if (litMatch) return litMatch[1].replace(/:$/, '').trim();
  // Extract all string literals from any ternary expression and deduplicate
  const allStrings = [...trimmed.matchAll(/"([^"]+)"/g)].map(m => m[1].replace(/:$/, '').trim());
  const unique = [...new Set(allStrings)];
  return unique.length > 0 ? unique.join(' / ') : trimmed;
}

/**
 * Extract a parenthesised argument from a source string starting at `start` index,
 * using brace-depth counting. Returns { arg: string, end: number }.
 */
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
// All static data maps/vectors extracted purely from the source text.
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

  // SCALE_LABELS: const vector<pair<double,string>> SCALE_LABELS = { make_pair(expr,"unit"), ... };
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

  // SCALE: const map<string,int> SCALE = { {"key", index}, ... };
  const scMatch = src.match(/const map<string,\s*int> SCALE\s*=\s*\{([\s\S]*?)\};/);
  if (scMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*(\d+)\s*\}/g;
    let m;
    while ((m = entryRe.exec(scMatch[1])) !== null) r.scaleMap[m[1]] = parseInt(m[2], 10);
  }

  // BOOLEAN_ATTRIBUTES: { {"key", "description"}, ... }
  const baMatch = src.match(/BOOLEAN_ATTRIBUTES\s*=\s*\{([\s\S]*?)\};/);
  if (baMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}/g;
    let m;
    while ((m = entryRe.exec(baMatch[1])) !== null) r.booleanAttrs[m[1]] = m[2];
  }

  // VALUE_NAMES: vector<pair<string,string>> = { {"key","unit"}, ... }
  const vnMatch = src.match(/VALUE_NAMES\s*=\s*\{([\s\S]*?)\};/);
  if (vnMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\}/g;
    let m;
    while ((m = entryRe.exec(vnMatch[1])) !== null) {
      r.valueNames.push({ key: m[1], unit: m[2] || null });
    }
  }

  // PERCENT_NAMES, OTHER_NAMES: vector<string> = { "key", ... }
  for (const [field, target] of [['PERCENT_NAMES', r.percentNames], ['OTHER_NAMES', r.otherNames]]) {
    const match = src.match(new RegExp(`${field}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    if (match) {
      const strRe = /"([^"]+)"/g;
      let m;
      while ((m = strRe.exec(match[1])) !== null) target.push(m[1].replace(/:$/, '').trim());
    }
  }

  // EXPECTED_NEGATIVE, BEFORE: set<string> = { "key", ... }
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

    // Extract intermediate variables that directly read attributes
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
      // One entry per return statement. Multi-branch functions have multiple.
      formulas: returns.map(ret => ({
        rawReturn: ret,
        formula:   buildFormula(ret, body),
      })),
      // Intermediate variables that directly hold attribute values.
      // Useful for understanding what feeds into a formula.
      attributeVariables: attrVars,
    };
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Parse ShipInfoDisplay.cpp — extract ship panel display data
//
// Three things are extracted:
//   A) Energy/heat table rows (idle, moving, firing, shields/hull, net, max)
//      Uses paren-depth counting to handle nested ternary label expressions.
//   B) attributeLabels / attributeValues strict pairs (immediate succession only)
//   C) NAMES capacity vector (alternating display-label / attribute-key pairs)
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

  // ── Extract intermediate variables ────────────────────────────────────────
  const sentBody = sentinelizeGetCalls(updateBody);
  const varMap   = extractVarMap(sentBody);
  for (const [name, def] of Object.entries(varMap)) {
    if (def.includes('\u27e6')) {
      r.intermediateVars[name] = def.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']');
    }
  }

  // ── A) Energy/heat table rows via paren-depth counting ────────────────────
  // This handles nested ternary label expressions like:
  // (shieldEnergy && hullEnergy) ? "shields / hull:" : hullEnergy ? "repairing hull:" : "charging shields:"
  {
    let pos = 0;
    while (true) {
      const tlIdx = updateBody.indexOf('tableLabels.push_back(', pos);
      if (tlIdx === -1) break;
      const argStart = tlIdx + 'tableLabels.push_back('.length;
      const { arg: labelArg, end: afterLabel } = extractParenArg(updateBody, argStart);
      pos = afterLabel;

      // Look for energyTable.push_back within 200 chars
      const searchWindow = updateBody.slice(pos, pos + 200);
      const eMatch = searchWindow.match(/energyTable\.push_back\s*\(/);
      if (!eMatch) continue;
      const eArgStart = pos + eMatch.index + eMatch[0].length;
      const { arg: energyArg, end: afterEnergy } = extractParenArg(updateBody, eArgStart);
      pos = afterEnergy;

      // Look for heatTable.push_back within 600 chars (allows for intervening assignments)
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

  // ── B) attributeLabels / attributeValues strict pairs ─────────────────────
  // "Strict" means attributeValues immediately follows attributeLabels with no
  // intervening attributeLabels.push_back. This prevents wrong pairing.
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

  // ── C) NAMES capacity vector ───────────────────────────────────────────────
  // static const vector<string> NAMES = { "display label:", "attr key", ... };
  // Entries alternate: display label then attribute key.
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

  // Explicit minimum stacking: min(..., ⟦key⟧, ...)
  const minRe = /\bmin\s*\([^)]*\u27e6([^\u27e7]+)\u27e7[^)]*\)/g;
  let m;
  while ((m = minRe.exec(sentSrc)) !== null) {
    stackingRules[m[1]] = { stacking: 'minimum', description: 'Takes the lowest value among all installed outfits.' };
  }

  // Explicit maximum stacking: max(..., ⟦key⟧, ...)
  const maxRe = /\bmax\s*\([^)]*\u27e6([^\u27e7]+)\u27e7[^)]*\)/g;
  while ((m = maxRe.exec(sentSrc)) !== null) {
    if (!stackingRules[m[1]]) {
      stackingRules[m[1]] = { stacking: 'maximum', description: 'Takes the highest value among all installed outfits.' };
    }
  }

  // Classify remaining keys by name pattern
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
// Parse Weapon.cpp — weapon stat functions and data-file keys
// ---------------------------------------------------------------------------

function parseWeaponCpp(src) {
  const fnBodies    = extractFunctionBodies(src, 'Weapon::');
  const functions   = {};
  const dataFileKeys = new Set();

  for (const [fnName, info] of Object.entries(fnBodies)) {
    const { body, returnType, params, isConst } = info;
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);

    // Extract data-file keys from the Load() function
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
// Parse DamageDealt.h/cpp — damage type names
// ---------------------------------------------------------------------------

function parseDamageDealt(hSrc, cppSrc) {
  const types   = new Set();
  const combined = (hSrc || '') + '\n' + (cppSrc || '');

  // Method declarations in header: double TypeName() const;
  const declRe = /\bdouble\s+(\w+)\s*\(\s*\)\s*const\s*(?:noexcept)?\s*;/g;
  let m;
  while ((m = declRe.exec(hSrc || '')) !== null) types.add(m[1]);

  // Method definitions: double DamageDealt::TypeName()
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
// Build unified attribute dictionary
//
// One entry per unique attribute key found anywhere across all parsed sources.
// Aggregates: display info, stacking rule, which functions reference it,
// which panels show it, and more.
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

  // Which Ship:: functions read each attribute
  for (const [fnName, fnData] of Object.entries(shipFns)) {
    for (const key of (fnData.attributesRead || [])) {
      const a = ensure(key);
      if (!a.usedInShipFunctions) a.usedInShipFunctions = [];
      if (!a.usedInShipFunctions.includes(fnName)) a.usedInShipFunctions.push(fnName);
    }
  }

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

  // Fetch all source files
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

  // Parse each source
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

  // Build unified attribute dictionary
  const attributes = buildAttributeDictionary(
    oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns, aiCacheFns
  );
  console.log(`\n  Unified dictionary: ${Object.keys(attributes).length} unique attribute keys`);

  // Assemble final output
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
      ],
    },

    // One entry per unique attribute key found anywhere in the codebase.
    // Fields: displayMultiplier, displayUnit, isBoolean, isWeaponStat, isExpectedNegative,
    //         stacking, stackingDescription, usedInShipFunctions, shownInOutfitPanel,
    //         shownInShipPanel, isWeaponDataKey, usedInNavFunctions, usedInAIFunctions
    attributes,

    // All Ship:: member functions that reference attributes.
    // formulas[]: one per return statement. attributeVariables: local vars reading attrs.
    shipFunctions: shipFns,

    // What the ship info panel shows.
    shipDisplay: {
      // 6 rows: idle, moving, firing, shields/hull, net change, max
      energyHeatTable:  shipDisplay.tableRows,
      // label/value pairs shown below the table
      labelValuePairs:  shipDisplay.attributeLabels,
      // capacity display (outfit space, weapon capacity, etc.)
      capacityDisplay:  shipDisplay.capacityNames,
      // intermediate variables used in the table row formulas
      intermediateVars: shipDisplay.intermediateVars,
    },

    // Raw extracted data from the outfit info panel.
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

    // Weapon system.
    weapon: {
      functions:    weaponData.functions,
      dataFileKeys: weaponData.dataFileKeys,
      damageTypes,
    },

    // Navigation (jump/hyperdrive) functions.
    navigation: jumpNavFns,

    // AI cache derived combat stats.
    aiCache: aiCacheFns,
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
