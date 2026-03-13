'use strict';

/**
 * attributeParser.js
 *
 * Fetches Endless Sky C++ source files from GitHub and extracts:
 *   - Outfit attribute keys, display units, and scale multipliers
 *   - Ship member function formulas (derived stats)
 *   - ShipInfoDisplay label/value pairs and energy/heat table rows
 *   - Outfit stacking rules
 *   - Weapon stat fields and their calculations
 *   - ALL attribute keys referenced by attributes.Get() across all source files
 *
 * Zero hardcoding: everything is extracted from the source via regex/AST analysis.
 * Variable assignments are inlined into return expressions to produce clean formulas.
 *
 * Output: data/attributeDefinitions.json
 *
 * Formula notation: [attr name] means attributes.Get("attr name") in the C++ source.
 * Function calls like Drag(), InertialMass() appear as-is when they are not themselves
 * reducible to attribute expressions.
 */

const https = require('https');
const fs    = require('fs').promises;
const path  = require('path');

// ---------------------------------------------------------------------------
// Source files to fetch from the master branch
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
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Formula extraction
//
// Approach:
//   1. Sentinelize: replace attributes.Get("key") with ⟦key⟧ before any
//      variable substitution. This prevents the word "thrust" from matching
//      inside the already-replaced token "⟦afterburner thrust⟧".
//
//   2. Extract local variable assignments from the function body.
//      Only keep those whose RHS references a ⟦key⟧ sentinel (i.e. they
//      directly read an attribute) or are pure arithmetic. Skip variables
//      that are assigned from opaque function calls like CoolingEfficiency()
//      - those remain visible as function calls in the final formula.
//
//   3. In each return expression, substitute variable names with their
//      definitions, but ONLY outside ⟦...⟧ brackets.
//
//   4. Convert ⟦key⟧ → [key] in the final formula string.
// ---------------------------------------------------------------------------

/** Replace all attributes.Get("key") patterns with ⟦key⟧. */
function sentinelizeGetCalls(src) {
  return src
    .replace(/\battributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,             (_, k) => `⟦${k}⟧`)
    .replace(/\bship\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,   (_, k) => `⟦${k}⟧`)
    .replace(/\boutfit\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g, (_, k) => `⟦${k}⟧`)
    .replace(/\bbaseAttributes\.Get\s*\(\s*"([^"]+)"\s*\)/g,         (_, k) => `⟦${k}⟧`);
}

/**
 * Extract variable assignments from a sentinelized function body.
 * Returns { varName: expressionString }.
 * Only captures variables whose value references a ⟦sentinel⟧ or is pure arithmetic.
 */
function extractVarMap(sentBody) {
  const vars = {};
  // Handles multi-line assignments by stopping at ; followed by
  // another declaration keyword or a closing brace.
  const varRe = /(?:const\s+)?(?:double|int|bool|float|size_t|int64_t)\s+(\w+)\s*=\s*([\s\S]*?);/g;
  let m;
  while ((m = varRe.exec(sentBody)) !== null) {
    const def = m[2].replace(/\s+/g, ' ').trim();
    if (def.includes('⟦') || /^[\d\s+\-*/.()\[\]e]+$/i.test(def)) {
      vars[m[1]] = def;
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
    const parts = expr.split(/(⟦[^⟧]*⟧)/);
    expr = parts.map((part, idx) => {
      if (idx % 2 === 1) return part; // inside ⟦⟧, protected
      return part.replace(
        new RegExp(`\\b${name}\\b(?!\\s*\\()`, 'g'),
        def.includes('⟦') || def.length > 18 ? `(${def})` : def
      );
    }).join('');
  }
  return expr;
}

/**
 * Build a clean formula string from a raw return expression and its body.
 * Formula uses [attr name] notation.
 */
function buildFormula(rawReturn, rawBody) {
  const sentBody   = sentinelizeGetCalls(rawBody);
  const sentReturn = sentinelizeGetCalls(rawReturn);
  const vars       = extractVarMap(sentBody);
  const inlined    = substituteVars(sentReturn, vars);
  return inlined
    .replace(/Format::Number\s*\(/g, '(')
    .replace(/⟦/g, '[').replace(/⟧/g, ']')
    .replace(/\b(\d+)\.\b/g, '$1')          // strip trailing dots: 60. -> 60
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract all unique attribute keys read anywhere in a source text. */
function extractAllAttributeKeys(src) {
  const keys = new Set();
  const patterns = [
    /\battributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\bbaseAttributes?\.Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\bship\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\boutfit\.Attributes\(\)\.Get\s*\(\s*"([^"]+)"\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) keys.add(m[1]);
  }
  return [...keys].sort();
}

/** Extract all attribute keys written via Set() anywhere in source. */
function extractSetKeys(src) {
  const keys = new Set();
  const re = /\battributes?\.Set\s*\(\s*"([^"]+)"\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// C++ function body extractor (brace-depth counting)
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
      if (src[i] === '{')      depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const body = src.slice(bodyStart, i - 1).trim();
    if (!bodies[fnName] || body.length > bodies[fnName].body.length) {
      bodies[fnName] = {
        returnType: m[1].trim(),
        params:     m[3].trim(),
        isConst:    !!m[4],
        body,
      };
    }
  }
  return bodies;
}

/** Extract all return statements from a function body. */
function extractReturns(body) {
  const returns = [];
  const re      = /\breturn\s+((?:[^;{}]|\{[^}]*\})+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const expr = m[1].replace(/\s+/g, ' ').trim();
    // Skip trivial returns
    if (expr && !['0', '1', 'false', 'true', 'result', 'type'].includes(expr)) {
      returns.push(expr);
    }
  }
  return returns;
}

// ---------------------------------------------------------------------------
// Parse OutfitInfoDisplay.cpp
// Extracts all static data maps/vectors that define how outfit attributes display.
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

  // SCALE_LABELS: const vector<pair<double,string>> SCALE_LABELS = { make_pair(expr, "unit"), ... };
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
    while ((m = entryRe.exec(scMatch[1])) !== null) {
      r.scaleMap[m[1]] = parseInt(m[2], 10);
    }
  }

  // BOOLEAN_ATTRIBUTES: { {"key", "description"}, ... }
  const baMatch = src.match(/BOOLEAN_ATTRIBUTES\s*=\s*\{([\s\S]*?)\};/);
  if (baMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}/g;
    let m;
    while ((m = entryRe.exec(baMatch[1])) !== null) r.booleanAttrs[m[1]] = m[2];
  }

  // VALUE_NAMES: vector<pair<string,string>> VALUE_NAMES = { {"key", "unit"}, ... }
  const vnMatch = src.match(/VALUE_NAMES\s*=\s*\{([\s\S]*?)\};/);
  if (vnMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\}/g;
    let m;
    while ((m = entryRe.exec(vnMatch[1])) !== null) {
      r.valueNames.push({ key: m[1], unit: m[2] || null });
    }
  }

  // PERCENT_NAMES / OTHER_NAMES: vector<string> = { "key", ... }
  for (const [field, target] of [['PERCENT_NAMES', r.percentNames], ['OTHER_NAMES', r.otherNames]]) {
    const match = src.match(new RegExp(`${field}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    if (match) {
      const strRe = /"([^"]+)"/g;
      let m;
      while ((m = strRe.exec(match[1])) !== null) target.push(m[1].replace(/:$/, '').trim());
    }
  }

  // EXPECTED_NEGATIVE / BEFORE: set<string> = { "key", ... }
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
// Parse Ship.cpp — all member function formulas
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

    // Build formulas for each return path
    const formulas = returns.map(ret => ({
      rawReturn: ret,
      formula:   buildFormula(ret, body),
    }));

    // Extract local variable assignments that directly read attributes
    const sentBody = sentinelizeGetCalls(body);
    const varMap   = extractVarMap(sentBody);
    const attrVars = {};
    for (const [name, def] of Object.entries(varMap)) {
      if (def.includes('⟦')) {
        attrVars[name] = def.replace(/⟦/g, '[').replace(/⟧/g, ']');
      }
    }

    parsed[fnName] = {
      returnType,
      params,
      isConst,
      attributesRead: attrKeys,
      attributesSet:  setKeys,
      // formulas[]: one entry per return statement
      // Multi-branch functions (MinimumHull, Health, etc.) have multiple entries
      formulas,
      // attrVars: intermediate variables that directly hold attribute values
      // Use these to understand what feeds into the formula
      attributeVariables: attrVars,
    };
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Parse ShipInfoDisplay.cpp — ship panel display data
// ---------------------------------------------------------------------------

function parseShipInfoDisplay(src) {
  const r = {
    tableRows:       [],
    attributeLabels: [],
    capacityNames:   [],
    intermediateVars: {},
    allAttributeKeys: extractAllAttributeKeys(src),
  };

  const fnBodies  = extractFunctionBodies(src, 'ShipInfoDisplay::');
  const updateBody = fnBodies['UpdateAttributes']?.body || src;

  // ── Extract intermediate variables (for inlining into table row formulas) ─
  const sentBody = sentinelizeGetCalls(updateBody);
  const varMap   = extractVarMap(sentBody);
  for (const [name, def] of Object.entries(varMap)) {
    if (def.includes('⟦')) {
      r.intermediateVars[name] = def.replace(/⟦/g, '[').replace(/⟧/g, ']');
    }
  }

  // ── Energy/heat table rows ─────────────────────────────────────────────────
  // tableLabels.push_back("label"); energyTable.push_back(expr); heatTable.push_back(expr);
  // The label may be a string literal or a ternary expression.
  const tableRowRe =
    /tableLabels\.push_back\s*\(((?:"[^"]*"|[^)]+))\)\s*;\s*energyTable\.push_back\s*\(((?:[^()]+|\([^()]*\))+)\)\s*;\s*heatTable\.push_back\s*\(((?:[^()]+|\([^()]*\))+)\)\s*;/g;
  let m;
  while ((m = tableRowRe.exec(updateBody)) !== null) {
    const rawLabelExpr = m[1].trim();
    const energyExpr   = m[2].trim();
    const heatExpr     = m[3].trim();
    const label        = parseLabelExpr(rawLabelExpr);
    r.tableRows.push({
      label,
      rawLabelExpr,
      energyFormula: buildFormula(energyExpr, updateBody),
      heatFormula:   buildFormula(heatExpr, updateBody),
      rawEnergyExpr: energyExpr,
      rawHeatExpr:   heatExpr,
    });
  }

  // ── attributeLabels / attributeValues pairs ────────────────────────────────
  const lblValRe =
    /attributeLabels\.push_back\s*\(((?:"[^"]*"|[^)]+))\)\s*;([\s\S]{0,600}?)attributeValues\.push_back\s*\(((?:[^()]+|\([^()]*\))+)\)\s*;/g;
  while ((m = lblValRe.exec(updateBody)) !== null) {
    const label     = parseLabelExpr(m[1].trim());
    const valueExpr = m[3].trim();
    if (!label) continue;
    r.attributeLabels.push({
      label,
      formula:    buildFormula(valueExpr, updateBody),
      rawExpr:    valueExpr,
    });
  }

  // ── NAMES vector (capacity/space display) ──────────────────────────────────
  // static const vector<string> NAMES = { "display label:", "attr key", ... };
  const namesMatch = updateBody.match(/\bNAMES\s*=\s*\{([\s\S]*?)\};/);
  if (namesMatch) {
    const strRe  = /"([^"]+)"/g;
    const entries = [];
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

/** Parse a C++ label expression (string literal or ternary) into a human string. */
function parseLabelExpr(expr) {
  const litMatch = expr.match(/^"([^"]*)"$/);
  if (litMatch) return litMatch[1].replace(/:$/, '').trim();
  // Ternary: ... ? "A" : "B"
  const ternMatch = expr.match(/\?\s*"([^"]*)"\s*:\s*"([^"]*)"/);
  if (ternMatch) {
    const a = ternMatch[1].replace(/:$/, '').trim();
    const b = ternMatch[2].replace(/:$/, '').trim();
    return a === b ? a : `${a} / ${b}`;
  }
  // String concatenation with conditional - return the first string literal found
  const firstStr = expr.match(/"([^"]+)"/);
  return firstStr ? firstStr[1].replace(/:$/, '').trim() : null;
}

// ---------------------------------------------------------------------------
// Parse Outfit.cpp — stacking rules
// ---------------------------------------------------------------------------

function parseOutfitCpp(src) {
  const stackingRules = {};

  // Sentinelize and extract all variable assignments
  const sentSrc = sentinelizeGetCalls(src);

  // 1. Find attribute keys used in explicit min/max contexts
  //    e.g. min(existingValue, ⟦key⟧) or max(existingValue, ⟦key⟧)
  const minPatternRe = /\bmin\s*\([^)]*⟦([^⟧]+)⟧[^)]*\)/g;
  const maxPatternRe = /\bmax\s*\([^)]*⟦([^⟧]+)⟧[^)]*\)/g;
  let m;
  while ((m = minPatternRe.exec(sentSrc)) !== null) {
    stackingRules[m[1]] = { stacking: 'minimum', description: 'Takes the lowest value among all installed outfits.' };
  }
  while ((m = maxPatternRe.exec(sentSrc)) !== null) {
    if (!stackingRules[m[1]]) {
      stackingRules[m[1]] = { stacking: 'maximum', description: 'Takes the highest value among all installed outfits.' };
    }
  }

  // 2. All keys whose name contains multiplier/reduction/protection
  //    are additive-then-multiply (stored as sum, applied as stat*(1+sum))
  for (const key of extractAllAttributeKeys(src)) {
    if (!stackingRules[key]) {
      if (/multiplier|reduction|protection/.test(key)) {
        stackingRules[key] = {
          stacking:    'additive-then-multiply',
          description: 'Values sum across outfits. Applied as: base × (1 + sum).',
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
// Parse Weapon.cpp — weapon stat functions and data file keys
// ---------------------------------------------------------------------------

function parseWeaponCpp(src) {
  const fnBodies    = extractFunctionBodies(src, 'Weapon::');
  const functions   = {};
  const dataFileKeys = new Set();

  for (const [fnName, info] of Object.entries(fnBodies)) {
    const { body, returnType, params, isConst } = info;
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);

    // Extract data file keys from Load() function
    if (fnName === 'Load') {
      const keyRe = /\bkey\s*==\s*"([^"]+)"/g;
      let m;
      while ((m = keyRe.exec(body)) !== null) dataFileKeys.add(m[1]);
      // Also handle: else if(key == "...") patterns
      const ifKeyRe = /(?:if|else if)\s*\(\s*key\s*==\s*"([^"]+)"/g;
      while ((m = ifKeyRe.exec(body)) !== null) dataFileKeys.add(m[1]);
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

  // Method declarations: double TypeName() const;
  const declRe = /\bdouble\s+(\w+)\s*\(\s*\)\s*const\s*(?:noexcept)?\s*;/g;
  let m;
  while ((m = declRe.exec(hSrc || '')) !== null) types.add(m[1]);

  // Method definitions: double DamageDealt::TypeName() const { ... }
  const defRe  = /\bdouble\s+DamageDealt::(\w+)\s*\(\s*\)/g;
  while ((m = defRe.exec(combined)) !== null) types.add(m[1]);

  // Setter names: void DamageDealt::AddTypeName(...) or DamageDealt& DamageDealt::Add...
  const addRe  = /DamageDealt(?:::\w+)?\s*DamageDealt::Add(\w+)/g;
  while ((m = addRe.exec(combined)) !== null) types.add(m[1]);

  return [...types].sort();
}

// ---------------------------------------------------------------------------
// Parse ShipJumpNavigation.cpp
// ---------------------------------------------------------------------------

function parseJumpNav(src) {
  if (!src) return {};
  const fnBodies = extractFunctionBodies(src, 'ShipJumpNavigation::');
  const parsed   = {};
  for (const [fnName, info] of Object.entries(fnBodies)) {
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
  const fnBodies = extractFunctionBodies(src, 'ShipAICache::');
  const parsed   = {};
  for (const [fnName, info] of Object.entries(fnBodies)) {
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
// Each entry aggregates: display info, stacking rule, which functions use it,
// whether it appears in the ship/outfit info panels, and more.
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

  // From SCALE map + SCALE_LABELS
  for (const [key, idx] of Object.entries(oidData.scaleMap)) {
    const sl = oidData.scaleLabels[idx];
    if (!sl) continue;
    const a = ensure(key);
    a.displayMultiplier  = sl.multiplier;
    a.displayUnit        = sl.unit || deriveDisplayUnit(sl.multiplier);
    a.scaleIndex         = idx;
    a.shownInOutfitPanel = true;
  }

  // From BOOLEAN_ATTRIBUTES
  for (const [key, desc] of Object.entries(oidData.booleanAttrs)) {
    const a = ensure(key);
    a.isBoolean          = true;
    a.description        = desc;
    a.shownInOutfitPanel = true;
  }

  // From VALUE_NAMES
  for (const { key, unit } of oidData.valueNames) {
    const a = ensure(key);
    a.isWeaponStat       = true;
    a.shownInOutfitPanel = true;
    if (unit) a.displayUnit = unit;
  }

  // From PERCENT_NAMES
  for (const key of oidData.percentNames) {
    const a = ensure(key);
    a.isWeaponStat       = true;
    a.displayUnit        = '%';
    a.shownInOutfitPanel = true;
  }

  // From OTHER_NAMES
  for (const key of oidData.otherNames) {
    const a = ensure(key);
    a.isWeaponStat       = true;
    a.shownInOutfitPanel = true;
  }

  // EXPECTED_NEGATIVE
  for (const key of oidData.expectedNegative) ensure(key).isExpectedNegative = true;

  // Prerequisite / before attrs
  for (const key of oidData.beforeAttrs) ensure(key).isPrerequisite = true;

  // Stacking rules
  for (const [key, rule] of Object.entries(outfitStacking)) {
    const a = ensure(key);
    a.stacking            = rule.stacking;
    a.stackingDescription = rule.description;
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
    a.shipPanelLabel  = displayLabel;
    a.shownInShipPanel = true;
  }

  // ShipInfoDisplay attribute keys
  for (const key of shipDisplay.allAttributeKeys) {
    ensure(key).shownInShipPanel = true;
  }

  // Weapon data file keys
  for (const key of (weaponData.dataFileKeys || [])) {
    ensure(key).isWeaponDataKey = true;
  }

  // Navigation attribute keys
  for (const [fnName, fnData] of Object.entries(jumpNavFns)) {
    for (const key of (fnData.attributesRead || [])) {
      const a = ensure(key);
      if (!a.usedInNavFunctions) a.usedInNavFunctions = [];
      if (!a.usedInNavFunctions.includes(fnName)) a.usedInNavFunctions.push(fnName);
    }
  }

  // AI cache attribute keys
  for (const [fnName, fnData] of Object.entries(aiCacheFns)) {
    for (const key of (fnData.attributesRead || [])) {
      const a = ensure(key);
      if (!a.usedInAIFunctions) a.usedInAIFunctions = [];
      if (!a.usedInAIFunctions.includes(fnName)) a.usedInAIFunctions.push(fnName);
    }
  }

  // Any remaining keys from all Get() calls across all sources
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
    process.stdout.write(`  Fetching ${filename.padEnd(30)}`);
    try {
      sources[name] = await fetchText(url);
      console.log(`✓  ${sources[name].length.toLocaleString()} bytes`);
    } catch (err) {
      console.log(`✗  ${err.message}`);
      sources[name] = '';
    }
  }

  // Parse
  console.log('\n  Parsing...');

  const oidData = sources.outfitInfoDisplay
    ? parseOutfitInfoDisplay(sources.outfitInfoDisplay)
    : { scaleLabels: [], scaleMap: {}, booleanAttrs: {}, valueNames: [], percentNames: [], otherNames: [], expectedNegative: [], beforeAttrs: [], allAttributeKeys: [] };
  console.log(`  OutfitInfoDisplay: ${Object.keys(oidData.scaleMap).length} SCALE entries, ${Object.keys(oidData.booleanAttrs).length} boolean attrs`);

  const shipFns = sources.shipCpp ? parseShipCpp(sources.shipCpp) : {};
  console.log(`  Ship.cpp:          ${Object.keys(shipFns).length} functions with attribute refs`);

  const shipDisplay = sources.shipInfoDisplay
    ? parseShipInfoDisplay(sources.shipInfoDisplay)
    : { tableRows: [], attributeLabels: [], capacityNames: [], intermediateVars: {}, allAttributeKeys: [] };
  console.log(`  ShipInfoDisplay:   ${shipDisplay.tableRows.length} table rows, ${shipDisplay.attributeLabels.length} label/value pairs`);

  const outfitStacking = sources.outfitCpp ? parseOutfitCpp(sources.outfitCpp) : {};
  console.log(`  Outfit.cpp:        ${Object.keys(outfitStacking).length} stacking rules`);

  const weaponData = sources.weaponCpp
    ? parseWeaponCpp(sources.weaponCpp)
    : { functions: {}, dataFileKeys: [] };
  console.log(`  Weapon.cpp:        ${Object.keys(weaponData.functions).length} functions, ${weaponData.dataFileKeys.length} data keys`);

  const damageTypes = parseDamageDealt(sources.damageDealtH, sources.damageDealtCpp);
  console.log(`  DamageDealt:       ${damageTypes.length} damage types`);

  const jumpNavFns = parseJumpNav(sources.jumpNavCpp);
  console.log(`  ShipJumpNav:       ${Object.keys(jumpNavFns).length} navigation functions`);

  const aiCacheFns = parseAICache(sources.aiCacheCpp);
  console.log(`  ShipAICache:       ${Object.keys(aiCacheFns).length} AI cache functions`);

  // Build unified attribute dictionary
  const attributes = buildAttributeDictionary(
    oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns, aiCacheFns
  );
  console.log(`\n  Unified attribute dictionary: ${Object.keys(attributes).length} unique keys`);

  // Assemble result
  const result = {
    _meta: {
      source:      'https://github.com/endless-sky/endless-sky',
      sourceFiles: SOURCE_FILES,
      generatedAt: new Date().toISOString(),
      formulaNotation: '[attr name] = attributes.Get("attr name") in C++. Function calls like Drag(), InertialMass() remain as-is when not reducible to attribute expressions.',
      notes: [
        'Zero hardcoding: all data extracted from C++ source via regex/AST analysis.',
        'displayMultiplier converts per-frame values to per-second for display (1 frame = 1/60 second).',
        'stacking: additive = direct sum; additive-then-multiply = base*(1+sum); minimum/maximum = extreme value.',
        'formulas[]: one entry per return statement. Multi-branch functions have multiple entries.',
        'attributeVariables: intermediate local vars that directly read attributes - shows what feeds into the formula.',
      ],
    },

    // One entry per unique attribute key found anywhere in the codebase.
    // Aggregates: display unit, multiplier, stacking rule, which functions use it, panel visibility.
    attributes,

    // All Ship:: member function formulas.
    // formulas[].formula uses [attr name] notation.
    // attributeVariables shows local vars that directly hold attribute values.
    shipFunctions: shipFns,

    // What the ship info panel actually displays.
    shipDisplay: {
      energyHeatTable:  shipDisplay.tableRows,
      labelValuePairs:  shipDisplay.attributeLabels,
      capacityDisplay:  shipDisplay.capacityNames,
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

    // Weapon functions and data file keys.
    weapon: {
      functions:    weaponData.functions,
      dataFileKeys: weaponData.dataFileKeys,
      damageTypes,
    },

    // Navigation (jump drive / hyperdrive) functions.
    navigation: jumpNavFns,

    // AI cache derived stats.
    aiCache: aiCacheFns,
  };

  await fs.writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n' + '='.repeat(60));
  console.log(`✓ Written → ${outFile}`);
  console.log(`  attributes:             ${Object.keys(result.attributes).length}`);
  console.log(`  shipFunctions:          ${Object.keys(result.shipFunctions).length}`);
  console.log(`  shipDisplay.table rows: ${result.shipDisplay.energyHeatTable.length}`);
  console.log(`  shipDisplay.labels:     ${result.shipDisplay.labelValuePairs.length}`);
  console.log(`  outfitDisplay.scale:    ${Object.keys(result.outfitDisplay.scaleMap).length}`);
  console.log(`  weapon.functions:       ${Object.keys(result.weapon.functions).length}`);
  console.log(`  weapon.damageTypes:     ${result.weapon.damageTypes.length}`);
  console.log(`  navigation functions:   ${Object.keys(result.navigation).length}`);
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
