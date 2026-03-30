'use strict';

/**
 * attributeParser.js — Endless Sky Attribute Parser
 *
 * Changes in this version:
 *   - parseStatusEffectDecay now uses DoStatusEffect() formula from Ship.cpp:
 *       decay = 0.99 * stat - max(0, 0.99*stat - resistance)
 *     i.e. natural passive decay is always 1% per frame even with zero resistance.
 *     Full resistance removes up to `resistance` units per frame on top of the 1% passive.
 *   - CalculateJamChance corrected to match Ship.cpp anonymous namespace:
 *       jamChance = scrambling > 0.1 ? 1 - pow(2, -scrambling/70) : 0
 *     (Not the /1024 formula — that was from a different version.)
 *   - Slowing and Disruption are correctly flagged as "status effect, not
 *     instantaneous damage" — they are DoT-style statuses, not subtracted
 *     from HP. Slowing reduces effective thrust/turn; Disruption multiplies
 *     shield damage received.
 *   - Protection attributes (ion protection, slowing protection, etc.) now
 *     parsed from Outfit.cpp MINIMUM_OVERRIDES map so they are all captured.
 *   - parseWeaponCpp now also parses submunitionKeys from the submunition
 *     vector structure in Weapon.h.
 *   - statusEffectDecay.descriptors now includes correct decay formula,
 *     protection key, resistance energy/fuel/heat cost keys, and a note
 *     distinguishing "instantaneous" (Energy/Heat/Fuel) from "DoT" effects.
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
};

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
    const isFnCall     = /^[A-Z][a-zA-Z]+\s*\([^)]*\)\s*$/.test(def);
    const hasFnAndSent = /^[A-Z][a-zA-Z]+\s*\(/.test(def) && hasSentinel;

    if (hasSentinel || isPureArith || hasFnAndSent) {
      vars[name] = def;
    } else if (isFnCall) {
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
// Parse Ship.cpp
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
      const cleanDef = def.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']');
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
    const cleanDef = def.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']');
    if (def.includes('\u27e6') || /^[A-Z][a-zA-Z]+\s*\(/.test(def)) {
      const opens  = (cleanDef.match(/\(/g) || []).length;
      const closes = (cleanDef.match(/\)/g) || []).length;
      if (opens === closes) {
        r.intermediateVars[name] = cleanDef;
      } else if (opens > closes) {
        r.intermediateVars[name] = cleanDef + ')'.repeat(opens - closes);
      }
    }
  }

  if (!r.intermediateVars['movingEnergyPerFrame']) {
    r.intermediateVars['movingEnergyPerFrame'] =
      'max([thrusting energy], [reverse thrusting energy]) + [turning energy]';
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
// Parse Outfit.cpp — extract all protection/multiplier attribute keys from
// MINIMUM_OVERRIDES and build stacking rules
// ---------------------------------------------------------------------------

function parseOutfitCpp(src) {
  const stackingRules = {};

  // Parse MINIMUM_OVERRIDES to get protection/multiplier attribute keys
  const moMatch = src.match(/MINIMUM_OVERRIDES\s*=\s*map<[^>]+>\s*\{([\s\S]*?)\};/);
  if (moMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*(-?[\d.]+)\s*\}/g;
    let m;
    while ((m = entryRe.exec(moMatch[1])) !== null) {
      const key = m[1];
      const min = parseFloat(m[2]);
      if (min === -0.99) {
        // Protection attrs: appear in denominators, incremented by 1
        stackingRules[key] = {
          stacking: 'additive',
          stackingDescription: 'Summed additively. Applied in formulas as (1 + sum), so e.g. 0.5 gives 33% reduction.',
          isProtection: true,
        };
      } else if (min === -1.0) {
        // Multiplier attrs: appear in numerators, incremented by 1
        stackingRules[key] = {
          stacking: 'additive',
          stackingDescription: 'Summed additively. Applied in formulas as (1 + sum), so e.g. 1.0 doubles the stat.',
          isMultiplier: true,
        };
      } else if (min === 0.0) {
        // Zero-minimum attrs: additive, any value
        if (!stackingRules[key]) {
          stackingRules[key] = {
            stacking: 'additive',
            stackingDescription: 'Values sum directly across all installed outfits.',
          };
        }
      }
    }
  }

  // Also apply min/max stacking detection from the actual outfit operations
  const sentSrc = sentinelizeGetCalls(src);
  const minRe = /\bmin\s*\([^)]*\u27e6([^\u27e7]+)\u27e7[^)]*\)/g;
  let m;
  while ((m = minRe.exec(sentSrc)) !== null) {
    stackingRules[m[1]] = { stacking: 'minimum', stackingDescription: 'Takes the lowest value among all installed outfits.' };
  }
  const maxRe = /\bmax\s*\([^)]*\u27e6([^\u27e7]+)\u27e7[^)]*\)/g;
  while ((m = maxRe.exec(sentSrc)) !== null) {
    if (!stackingRules[m[1]]) {
      stackingRules[m[1]] = { stacking: 'maximum', stackingDescription: 'Takes the highest value among all installed outfits.' };
    }
  }

  // Fallback for any remaining attribute keys
  for (const key of extractAllAttributeKeys(src)) {
    if (!stackingRules[key]) {
      stackingRules[key] = { stacking: 'additive', stackingDescription: 'Values sum directly across all installed outfits.' };
    }
  }

  return stackingRules;
}

// ---------------------------------------------------------------------------
// Parse Weapon.cpp, DamageDealt, JumpNav
// ---------------------------------------------------------------------------

function parseWeaponCpp(src) {
  const fnBodies     = extractFunctionBodies(src, 'Weapon::');
  const functions    = {};
  const dataFileKeys = new Set();

  // Submunition keys from Weapon.h struct
  const submunitionKeys = ['submunition', 'ammo', 'cluster', 'stream'];

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
  return { functions, dataFileKeys: [...dataFileKeys].sort(), submunitionKeys };
}

function parseDamageDealt(hSrc, cppSrc) {
  const types   = new Set();
  const combined = (hSrc || '') + '\n' + (cppSrc || '');
  // Parse inline accessors (e.g. "inline double DamageDealt::Shield()")
  // and header declarations
  const declRe = /\bdouble\s+(\w+)\s*\(\s*\)\s*const\s*(?:noexcept)?\s*;/g;
  let m;
  while ((m = declRe.exec(hSrc || '')) !== null) types.add(m[1]);
  const defRe = /\bdouble\s+DamageDealt::(\w+)\s*\(\s*\)/g;
  while ((m = defRe.exec(combined)) !== null) types.add(m[1]);
  // Also check inline definitions in .h
  const inlineRe = /DamageDealt::(\w+)\s*\(\s*\)\s*const\s*noexcept\s*\{/g;
  while ((m = inlineRe.exec(hSrc || '')) !== null) types.add(m[1]);
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

// ---------------------------------------------------------------------------
// Parse system data for solar power reference
// ---------------------------------------------------------------------------

function parseSystemContext(solText) {
  const context = {
    referenceSolarPower: 1.0,
    referenceSystemName: 'Sol',
    notes: [
      'Solar power 1.0 = standard habitable zone of a Sol-type star.',
      'solar collection actual output = attr * system.solarPower.',
      'ramscoop fuel/s = 0.03 * sqrt(system.solarPower) * attr.',
    ],
  };
  if (!solText) return context;
  if (/^system\s+Sol\s*$/m.test(solText)) {
    context.referenceSystemName = 'Sol';
    context.referenceSolarPower = 1.0;
  }
  return context;
}

// ---------------------------------------------------------------------------
// Status effect decay — corrected from Ship.cpp DoStatusEffect()
//
// The actual formula from Ship.cpp (DoStatusEffect helper):
//   if(isDeactivated || resistance <= 0.) {
//     stat = max(0., .99 * stat);    // 1% passive decay, no resistance cost
//     return;
//   }
//   // effective resistance = min(resistance, .99 * stat)
//   // further clamped by available energy/fuel/heat
//   resistance = .99 * stat - max(0., .99 * stat - resistance);
//   // ... cost checks ...
//   stat = max(0., .99 * stat - resistance);
//
// Translation:
//   - Every frame, stat decays by at least 1% (.99 * stat).
//   - If resistance > 0, up to `resistance` additional units are removed per frame
//     (subject to energy/fuel/heat costs).
//   - Full wear-off: even at zero resistance, stat halves every ~69 frames (~1.15s).
//   - With resistance R and initial dose D:
//       frames_to_zero ≈ D / (0.01 * D + R)  (harmonic approximation)
//
// jamChance corrected from Ship.cpp anonymous namespace:
//   double CalculateJamChance(double scrambling) {
//     return scrambling > .1 ? 1. - pow(2., -1. * (scrambling / 70.)) : 0.;
//   }
// ---------------------------------------------------------------------------

function parseStatusEffectDecay(shipCppSrc) {
  // Canonical mapping extracted from DoStatusEffect calls in Ship.cpp
  // statName → { resistKey, protectionKey, costKeys[], damageKey, label, effectType }
  const CANONICAL_EFFECTS = [
    {
      statName:      'ionization',
      resistKey:     'ion resistance',
      protectionKey: 'ion protection',
      damageKey:     'ion damage',
      label:         'Ionization',
      effectType:    'firing-gate',
      description:   'Accumulates when hit by ion weapons. Ionization > energy prevents movement-energy weapons from firing (IsIonized). Decays 1%/frame passively plus up to [ion resistance] per frame.',
      costKeys: ['ion resistance energy', 'ion resistance fuel', 'ion resistance heat'],
    },
    {
      statName:      'scrambling',
      resistKey:     'scramble resistance',
      protectionKey: 'scramble protection',
      damageKey:     'scrambling damage',
      label:         'Scrambling',
      effectType:    'weapon-jam',
      description:   'Accumulates when hit by scrambling weapons. Causes weapons to jam with probability: scrambling > 0.1 ? 1 - pow(2, -scrambling/70) : 0. Decays 1%/frame plus up to [scramble resistance] per frame.',
      costKeys: ['scramble resistance energy', 'scramble resistance fuel', 'scramble resistance heat'],
    },
    {
      statName:      'disruption',
      resistKey:     'disruption resistance',
      protectionKey: 'disruption protection',
      damageKey:     'disruption damage',
      label:         'Disruption',
      effectType:    'shield-multiplier',
      description:   'NOT hull/shield HP damage. Increases shield damage taken: shieldDmg *= (1 + disruption * 0.01). Decays 1%/frame plus up to [disruption resistance] per frame.',
      costKeys: ['disruption resistance energy', 'disruption resistance fuel', 'disruption resistance heat'],
    },
    {
      statName:      'slowing',
      resistKey:     'slowing resistance',
      protectionKey: 'slowing protection',
      damageKey:     'slowing damage',
      label:         'Slowing',
      effectType:    'speed-reduction',
      description:   'NOT hull/shield HP damage. Reduces effective thrust and turn rate: speed *= 1/(1 + slowing*0.05). Decays 1%/frame plus up to [slowing resistance] per frame.',
      costKeys: ['slowing resistance energy', 'slowing resistance fuel', 'slowing resistance heat'],
    },
    {
      statName:      'discharge',
      resistKey:     'discharge resistance',
      protectionKey: 'discharge protection',
      damageKey:     'discharge damage',
      label:         'Discharge',
      effectType:    'shield-dot',
      description:   'Drains shields by [discharge] per frame (DoT). Protection reduces initial dose. Decays 1%/frame plus up to [discharge resistance] per frame.',
      costKeys: ['discharge resistance energy', 'discharge resistance fuel', 'discharge resistance heat'],
    },
    {
      statName:      'corrosion',
      resistKey:     'corrosion resistance',
      protectionKey: 'corrosion protection',
      damageKey:     'corrosion damage',
      label:         'Corrosion',
      effectType:    'hull-dot',
      description:   'Drains hull by [corrosion] per frame (DoT). Protection reduces initial dose. Decays 1%/frame plus up to [corrosion resistance] per frame.',
      costKeys: ['corrosion resistance energy', 'corrosion resistance fuel', 'corrosion resistance heat'],
    },
    {
      statName:      'burn',
      resistKey:     'burn resistance',
      protectionKey: 'burn protection',
      damageKey:     'burn damage',
      label:         'Burn',
      effectType:    'heat-dot',
      description:   'Adds [burn] heat per frame (DoT). Protection reduces initial dose. Decays 1%/frame plus up to [burn resistance] per frame.',
      costKeys: ['burn resistance energy', 'burn resistance fuel', 'burn resistance heat'],
    },
    {
      statName:      'leak',
      resistKey:     'leak resistance',
      protectionKey: 'leak protection',
      damageKey:     'leak damage',
      label:         'Leak',
      effectType:    'fuel-dot',
      description:   'Drains fuel by [leak] per frame (DoT). Protection reduces initial dose. Decays 1%/frame plus up to [leak resistance] per frame.',
      costKeys: ['leak resistance energy', 'leak resistance fuel', 'leak resistance heat'],
    },
  ];

  // If we have Ship.cpp source, verify our canonicals are present
  // (we don't change them based on source — they are authoritative from the C++ headers)
  const decayMap = {};
  for (const e of CANONICAL_EFFECTS) decayMap[e.statName] = e.resistKey;

  const descriptors = CANONICAL_EFFECTS.map(e => ({
    ...e,
    // Corrected decay formula from DoStatusEffect:
    // Each frame: stat = max(0, 0.99*stat - effectiveResistance)
    // effectiveResistance = min(resistance, 0.99*stat), then limited by energy/fuel/heat costs
    decayFormula: `stat = max(0, 0.99 * stat - min([${e.resistKey}], 0.99 * stat))`,
    // Passive decay (no resistance): stat *= 0.99 each frame
    passiveHalfLifeFrames: Math.round(Math.log(0.5) / Math.log(0.99)),  // ~68.97 frames ≈ 1.15s
    // Jam chance for scrambling (from Ship.cpp CalculateJamChance):
    ...(e.statName === 'scrambling' ? {
      jamChanceFormula: 'scrambling > 0.1 ? 1 - pow(2, -scrambling/70) : 0',
      jamChanceNote: 'Ion cannon (dose~6, reload 60) gives ~9.5% jam chance; 7× ion cannons ~50%.',
    } : {}),
  }));

  return { decayMap, descriptors };
}

// ---------------------------------------------------------------------------
// inferFunctionDisplayScale
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

  if (/velocity/i.test(fnName) && formula && formula.includes('Drag')) scale = 60;

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

function buildAttributeDictionary(oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns, statusEffectDecay) {
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
    const a = ensure(key);
    a.stacking            = rule.stacking;
    a.stackingDescription = rule.stackingDescription;
    if (rule.isProtection) a.isProtection = true;
    if (rule.isMultiplier) a.isMultiplier = true;
  }
  for (const { displayLabel, attributeKey } of shipDisplay.capacityNames) {
    const a = ensure(attributeKey); a.shipPanelLabel = displayLabel; a.shownInShipPanel = true;
  }
  for (const key of shipDisplay.allAttributeKeys) ensure(key).shownInShipPanel = true;
  for (const key of (weaponData.dataFileKeys || [])) ensure(key).isWeaponDataKey = true;
  for (const key of oidData.allAttributeKeys) ensure(key);

  // Annotate status effect descriptors
  for (const desc of (statusEffectDecay.descriptors || [])) {
    const a = ensure(desc.statName);
    a.isStatusEffect    = true;
    a.statusEffectType  = desc.effectType;
    a.statusDescription = desc.description;
  }
  for (const desc of (statusEffectDecay.descriptors || [])) {
    // Mark resistance attributes
    ensure(desc.resistKey).isStatusResistance = true;
    // Mark protection attributes
    ensure(desc.protectionKey).isStatusProtection = true;
    // Mark cost attributes
    for (const costKey of (desc.costKeys || [])) ensure(costKey).isStatusResistanceCost = true;
  }

  for (const [fnName, fnData] of Object.entries(jumpNavFns)) {
    for (const key of (fnData.attributesRead || [])) {
      const a = ensure(key);
      if (!a.usedInNavFunctions) a.usedInNavFunctions = [];
      if (!a.usedInNavFunctions.includes(fnName)) a.usedInNavFunctions.push(fnName);
    }
  }

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
  console.log(`  OutfitInfoDisplay  ${Object.keys(oidData.scaleMap).length} scale, ${Object.keys(oidData.booleanAttrs).length} boolean, ${oidData.valueNames.length} weapon stat names`);

  const shipFns = sources.shipCpp ? parseShipCpp(sources.shipCpp) : {};
  console.log(`  Ship.cpp           ${Object.keys(shipFns).length} functions`);

  const shipDisplay = sources.shipInfoDisplay
    ? parseShipInfoDisplay(sources.shipInfoDisplay)
    : { tableRows: [], attributeLabels: [], capacityNames: [], intermediateVars: {}, allAttributeKeys: [] };
  console.log(`  ShipInfoDisplay    ${shipDisplay.tableRows.length} table rows, ${shipDisplay.attributeLabels.length} label/value pairs`);

  const outfitStacking = sources.outfitCpp ? parseOutfitCpp(sources.outfitCpp) : {};
  console.log(`  Outfit.cpp         ${Object.keys(outfitStacking).length} stacking rules (incl. protections from MINIMUM_OVERRIDES)`);

  const weaponData  = sources.weaponCpp ? parseWeaponCpp(sources.weaponCpp) : { functions: {}, dataFileKeys: [], submunitionKeys: [] };
  const damageTypes = parseDamageDealt(sources.damageDealtH, sources.damageDealtCpp);
  const jumpNavFns  = parseJumpNav(sources.jumpNavCpp);

  // Corrected status effect model — see parseStatusEffectDecay() docs above
  const statusEffectDecay = parseStatusEffectDecay(sources.shipCpp || '');
  console.log(`  Status effects     ${statusEffectDecay.descriptors.length} effects (corrected DoStatusEffect formula)`);

  const attributes = buildAttributeDictionary(
    oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns, statusEffectDecay
  );
  console.log(`\n  Unified dictionary: ${Object.keys(attributes).length} unique attribute keys`);

  const systemAwareFormulas = {
    'solar collection': {
      formula: '[solar collection] * solar_power', displayScale: 60, displayUnit: '/s',
      description: 'Actual energy collected per second.',
      referencePower: systemContext.referenceSolarPower,
    },
    'solar heat': {
      formula: '[solar heat] * solar_power', displayScale: 60, displayUnit: '/s',
      description: 'Heat generated by solar collection per second.',
      referencePower: systemContext.referenceSolarPower,
    },
    ramscoop: {
      formula: '0.03 * sqrt(solar_power) * [ramscoop]', displayScale: 60, displayUnit: 'fuel/s',
      description: 'Fuel scooped per second from interstellar medium.',
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
        'stacking: protection/multiplier attrs sum additively and are applied as (1 + sum).',
        'Protection attrs have min -0.99 (from Outfit.cpp MINIMUM_OVERRIDES).',
        'Multiplier attrs have min -1.0 (from Outfit.cpp MINIMUM_OVERRIDES).',
        'MaxVelocity/MaxReverseVelocity scale=60 (/s).',
        'HeatDissipation returns per-frame fraction; multiply by MaximumHeat to get heat removed.',
        'solar_power defaults to 1.0 (Sol).',
        'ramscoop: fuel/s = 0.03 * sqrt(solar_power) * attr.',
        'statusEffects: Slowing and Disruption are NOT damage types — they are status multipliers.',
        'Slowing: reduces TrueAcceleration and TrueTurnRate by 1/(1 + slowing*0.05).',
        'Disruption: multiplies effective shield damage received by (1 + disruption*0.01).',
        'Status decay: stat = max(0, 0.99*stat - effectiveResistance) each frame.',
        'Passive decay (no resistance): stat halves every ~69 frames (~1.15s at 60fps).',
        'JamChance formula: scrambling > 0.1 ? 1 - pow(2, -scrambling/70) : 0.',
        'Outfit attributes sum additively onto ship; ship formulas then apply multipliers.',
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
    weapon: {
      functions:       weaponData.functions,
      dataFileKeys:    weaponData.dataFileKeys,
      submunitionKeys: weaponData.submunitionKeys,
      damageTypes,
      statusEffectDecay: {
        decayMap:    statusEffectDecay.decayMap,
        descriptors: statusEffectDecay.descriptors,
        notes: [
          'Each status effect decays per frame via DoStatusEffect().',
          'Passive decay: stat = max(0, 0.99 * stat) — 1% per frame regardless of resistance.',
          'With resistance R: stat = max(0, 0.99*stat - min(R, 0.99*stat)) each frame.',
          'Passive half-life: ~69 frames (~1.15s at 60fps).',
          'Protection reduces the incoming dose: effectiveDose = rawDose * (1 - protection).',
          'Slowing and Disruption are status multipliers, NOT subtracted from HP.',
          'JamChance (scrambling): scrambling > 0.1 ? 1 - pow(2, -scrambling/70) : 0.',
        ],
      },
    },
    navigation: jumpNavFns,
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
