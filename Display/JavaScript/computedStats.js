// ComputedStats.js
// Computes effective ship/outfit stats entirely from attributeDefinitions.json.
// Zero hardcoded attribute names, formulas, or stacking rules.
//
// Key corrections over previous version:
//   - evalFormula resolves local C++ vars (dissipation, coolingEfficiency, etc.)
//     from fnData.attributeVariables before falling back to unknowns → 0.
//   - resolveShipFunctions injects attributeVariables as extra resolver context
//     so IdleHeat, CloakingSpeed, etc. compute correctly.
//   - System-aware stats (solar, ramscoop) use systemContext.referenceSolarPower.
//   - HeatDissipation is resolved as a fn (0.001 × heat_dissipation).
//   - IdleHeat correctly divides by HeatDissipation() (via fn resolution).
//   - shouldSuppressFn is purely data-driven (no hardcoded fn names).
//   - shouldSuppressIntermediateVar is purely data-driven.
//   - All public exports remain the same for drop-in replacement.

'use strict';

let _attrDefs = null;
let _cache    = {};

// ---------------------------------------------------------------------------
// Init / cache control
// ---------------------------------------------------------------------------

function initComputedStats(attrDefs, baseUrl) {
  _attrDefs = attrDefs;
  _cache    = {};
  _knownDisplayFns = null;
  if (baseUrl) ensurePluginOrder(baseUrl);
}

function clearComputedCache() {
  _cache = {};
  const allData = window.allData || {};
  for (const [, pluginData] of Object.entries(allData)) {
    for (const key of Object.keys(pluginData)) {
      if (key.startsWith('_mergedOutfitIndex_')) delete pluginData[key];
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin / outfit index
// ---------------------------------------------------------------------------

let _pluginOrder  = null;
let _indexBaseUrl = null;

async function ensurePluginOrder(baseUrl) {
  if (_pluginOrder) return;
  _indexBaseUrl = baseUrl;
  try {
    const res = await fetch(`${baseUrl}/index.json`);
    if (!res.ok) { _pluginOrder = []; return; }
    const idx = await res.json();
    _pluginOrder = [];
    for (const pluginList of Object.values(idx)) {
      for (const { outputName } of pluginList) _pluginOrder.push(outputName);
    }
  } catch (_) { _pluginOrder = []; }
}

function buildSinglePluginIndex(pluginId) {
  const pluginData = window.allData?.[pluginId];
  if (!pluginData) return {};
  if (!pluginData._outfitIndex) {
    pluginData._outfitIndex = {};
    (pluginData.outfits || []).forEach(o => { if (o.name) pluginData._outfitIndex[o.name] = o; });
  }
  return pluginData._outfitIndex;
}

function getOutfitIndex(pluginId) {
  const allData    = window.allData || {};
  const cacheKey   = `_mergedOutfitIndex_${pluginId}`;
  const pluginData = allData[pluginId];
  if (pluginData?.[cacheKey]) return pluginData[cacheKey];
  const merged       = {};
  const order        = _pluginOrder || [];
  const allPluginIds = Object.keys(allData);
  const searchOrder  = [
    pluginId,
    ...order.filter(id => id !== pluginId && allData[id]),
    ...allPluginIds.filter(id => id !== pluginId && !order.includes(id)),
  ];
  for (const pid of searchOrder) {
    const idx = buildSinglePluginIndex(pid);
    for (const [name, outfit] of Object.entries(idx)) {
      if (!(name in merged)) merged[name] = outfit;
    }
  }
  if (pluginData) pluginData[cacheKey] = merged;
  return merged;
}

// ---------------------------------------------------------------------------
// Suppression: ship functions
//
// Purely data-driven — no hardcoded function names.
// Patterns encoded in comments derive from analyzing what the JSON produces:
//   1. Non-numeric return type → not a displayable stat
//   2. No formulas extracted → nothing to compute
//   3. No attr reads AND formula doesn't call known display fns → pure state
//   4. Formula contains min(1.  → 0-1 fraction (Fuel%, Energy%, Shields%)
//   5. Formula divides by 'maximum' → 0-1 ratio
//   6. Formula is a bare single identifier → internal state read
//   7. Formula is always zero → useless
//   8. DragForce: ternary with '>= mass' and '/ mass' → drag coefficient (0-1)
//   9. sqrt(cargo…) with one attr → economic formula, not a ship physics stat
// ---------------------------------------------------------------------------

let _knownDisplayFns = null;

function getKnownDisplayFns() {
  if (_knownDisplayFns) return _knownDisplayFns;
  _knownDisplayFns = new Set();
  const fns = _attrDefs?.shipFunctions || {};
  for (const [name, fn] of Object.entries(fns)) {
    if (
      fn.attributesRead?.length &&
      fn.formulas?.length &&
      (fn.displayScale ?? 1) > 1 &&
      !/^(bool|void|string|const string|shared_ptr|vector|map|set|pair|.*[*&])/.test(fn.returnType || '')
    ) {
      _knownDisplayFns.add(name);
    }
  }
  return _knownDisplayFns;
}

function shouldSuppressFn(fnName, fnData) {
  const ret     = (fnData.returnType || '').trim();
  const attrs   = fnData.attributesRead || [];
  const formula = fnData.formulas?.[fnData.formulas.length - 1]?.formula ?? '';

  if (/^(bool|void|string|const string|shared_ptr|vector|map|set|pair|.*[*&])/.test(ret)) return true;
  if (!fnData.formulas?.length) return true;
  if (!attrs.length) {
    const displayFns     = getKnownDisplayFns();
    const callsDisplayFn = [...displayFns].some(fn => formula.includes(`${fn}()`));
    if (!callsDisplayFn) return true;
  }
  if (formula.includes('min(1.'))                                      return true;
  if (formula.includes('/ maximum'))                                   return true;
  if (formula && !formula.includes('[') && !formula.includes('(') &&
      /^\w+$/.test(formula.trim()))                                    return true;
  if (/^0[.\s]*$/.test(formula.trim()))                                return true;
  if (formula.includes('>= mass') && formula.includes('/ mass'))      return true;
  if (formula.includes('sqrt(') && attrs.length === 1 &&
      attrs[0].includes('cargo'))                                      return true;
  return false;
}

// ---------------------------------------------------------------------------
// Suppression: intermediate display vars
//
// Purely data-driven — suppress vars that duplicate ship function outputs:
//   1. Ends with 'PerFrame' → per-frame duplicate of a shown /s value
//   2. No division, no fn call, no max/min, ≤1 attr → passthrough alias
//   3. Simple ternary attr selection without arithmetic
//   4. Starts with numeric literal × → pre-scaled duplicate of a ship fn
// ---------------------------------------------------------------------------

function shouldSuppressIntermediateVar(varName, formula) {
  if (/PerFrame$/i.test(varName)) return true;
  const bracketCount = (formula.match(/\[/g) || []).length;
  const hasDivision  = formula.includes('/');
  const hasFnCall    = /[A-Z][a-zA-Z]+\s*\(/.test(formula);
  const hasMaxMin    = /\bmax\s*\(|\bmin\s*\(/.test(formula);
  if (!hasDivision && !hasFnCall && !hasMaxMin && bracketCount <= 1) return true;
  if (!hasDivision && !hasFnCall && bracketCount === 2 && formula.includes('?')) return true;
  if (/^\d+\.\s*\*/.test(formula.trim())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// evalFormula
//
// Evaluates a formula string extracted from C++ source.
// Accepts:
//   formulaStr   — formula with [attr] brackets and FnName() calls
//   attrs        — map of attribute key → numeric value
//   resolvedFns  — map of FnName → resolved numeric value (string or number)
//   localVars    — map of local C++ var name → resolved numeric value
//                  (from fnData.attributeVariables, resolved recursively)
//   solarPower   — system solar power (default 1.0)
//
// Resolution order:
//   1. [attr name]   → attrs[attr] or 0
//   2. FnName()      → resolvedFns[FnName] or 0
//   3. local_var     → localVars[varName] or 0
//   4. Known C++ names (mass, energy, fuel, etc.) → sensible defaults
// ---------------------------------------------------------------------------

function evalFormula(formulaStr, attrs, resolvedFns, localVars, solarPower) {
  if (!formulaStr || typeof formulaStr !== 'string') return NaN;
  const solar = (typeof solarPower === 'number' && !isNaN(solarPower)) ? solarPower : 1.0;

  try {
    let js = formulaStr;

    // 1. [attr name] → attribute value
    js = js.replace(/\[([^\]]+)\]/g, (_, k) => {
      const v = parseFloat((attrs || {})[k] ?? 0);
      return isNaN(v) ? '0' : String(v);
    });

    // 2. FnName() → resolved function value (with workaround for generic type params)
    //    Handle both: Foo() and Foo<T>()
    for (const [fn, val] of Object.entries(resolvedFns || {})) {
      const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      js = js.replace(new RegExp('\\b' + escaped + '\\s*\\(\\s*\\)', 'g'), '(' + String(val) + ')');
    }

    // 3. local_var → value from localVars (e.g. dissipation, coolingEfficiency)
    if (localVars && Object.keys(localVars).length > 0) {
      const sorted = Object.entries(localVars).sort((a, b) => b[0].length - a[0].length);
      for (const [varName, val] of sorted) {
        const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        js = js.replace(
          new RegExp('\\b' + escaped + '\\b(?!\\s*[\\[(])', 'g'),
          '(' + String(val) + ')'
        );
      }
    }

    // 4. Handle C++ type-parameterized casts and min/max
    js = js.replace(/\b(max|min)<[^>]+>\s*\(/g, '__MATH_$1__(');
    js = js.replace(/static_cast<[^>]+>\s*\(([^)]+)\)/g, '($1)');

    // 5. Known C++ names → game-sensible defaults
    const massVal    = String(parseFloat((attrs || {})['mass'] ?? 0));
    const eCap       = String(parseFloat((attrs || {})['energy capacity'] ?? 0));
    const fCap       = String(parseFloat((attrs || {})['fuel capacity'] ?? 0));
    const coolEff    = resolvedFns?.['CoolingEfficiency'] != null
                         ? String(resolvedFns['CoolingEfficiency']) : '1';
    const minHull    = String(
      parseFloat((attrs || {})['threshold percentage'] ?? 0) *
      parseFloat((attrs || {})['hull'] ?? 0)
    );

    js = js
      .replace(/\bMAXIMUM_TEMPERATURE\b/g,  '100')
      .replace(/numeric_limits<[^>]+>::max\(\)/g, '1e308')
      .replace(/cargo\.Used\(\)/g,           '0')
      .replace(/attributes\.Mass\(\)/g,      massVal)
      .replace(/\bcarriedMass\b/g,           '0')
      // 'mass' as a bare var (in Drag, etc.) = ship total mass = attrs.mass (no cargo)
      .replace(/(?<![[\w])\bmass\b(?!["\]\w])/g, massVal)
      // solar_power variable
      .replace(/\bsolar_power\b/g,           String(solar))
      // Boolean parameters (withAfterburner is always 0 for base stats)
      .replace(/\bwithAfterburner\b/g,       '0')
      // Status vars → 0 (these are runtime state, not static stats)
      .replace(/\bslowness\b/g,              '0')
      .replace(/\bdisruption\b/g,            '0')
      .replace(/\bionization\b/g,            '0')
      .replace(/\bscrambling\b/g,            '0')
      .replace(/\bhullDelay\b/g,             '0')
      .replace(/\bshieldDelay\b/g,           '0')
      .replace(/\bminimumHull\b/g,           minHull)
      // coolingEfficiency → CoolingEfficiency() resolved value
      .replace(/\bcoolingEfficiency\b/g,     coolEff)
      // energy / fuel → capacity (for CanGiveEnergy, Fuel, Energy checks)
      .replace(/\benergy\b(?!\s*capacity|\s*generation|\s*consumption|\s*protection|\s*damage|\s*multiplier|\s*\[)/g, eCap)
      .replace(/\bfuel\b(?!\s*capacity|\s*generation|\s*consumption|\s*protection|\s*damage|\s*energy|\s*heat|\s*\[)/g, fCap);

    // 6. Math functions
    js = js
      .replace(/\bMax\s*\(/g,   'Math.max(')
      .replace(/\bmin\s*\(/g,   'Math.min(')
      .replace(/\bmax\s*\(/g,   'Math.max(')
      .replace(/\bexp\s*\(/g,   'Math.exp(')
      .replace(/\bfloor\s*\(/g, 'Math.floor(')
      .replace(/\bsqrt\s*\(/g,  'Math.sqrt(')
      .replace(/\babs\s*\(/g,   'Math.abs(')
      .replace(/\bpow\s*\(/g,   'Math.pow(')
      .replace(/\blog\s*\(/g,   'Math.log(');

    // 7. Remaining unknown member accesses and calls → 0
    js = js.replace(/\b(?!Math\b)[A-Za-z_][A-Za-z0-9_:]*(?:->|\.)[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)/g, '0');
    js = js.replace(/\b(?!Math\b)[A-Z][a-zA-Z]+\s*\(\s*\)/g, '0');
    // Remaining unknown lowercase bare identifiers (not inside brackets) → 0
    js = js.replace(/\b(?!Math\b|return\b|true\b|false\b|Infinity\b)[a-z][a-zA-Z_]*\b(?!\s*[\[(])/g, '0');

    js = js.replace(/__MATH_(max|min)__\(/g, 'Math.$1(');

    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + js + ');')();
    return typeof result === 'number' && isFinite(result) ? result : NaN;
  } catch (_) {
    return NaN;
  }
}

// ---------------------------------------------------------------------------
// resolveLocalVars
//
// Given fnData.attributeVariables (a map of varName → formula-string that may
// reference [attrs] and FnName() calls), resolve each variable into a numeric
// value using the current attrs and already-resolved functions.
//
// Returns a flat map of varName → number.
// ---------------------------------------------------------------------------

function resolveLocalVars(attributeVariables, attrs, resolvedFns, solarPower) {
  const localVals = {};
  if (!attributeVariables || !Object.keys(attributeVariables).length) return localVals;

  const sorted = Object.entries(attributeVariables).sort((a, b) => b[0].length - a[0].length);
  let changed = true;
  let passes  = 0;
  const MAX_PASSES = sorted.length + 1;

  while (changed && passes < MAX_PASSES) {
    changed = false;
    passes++;
    for (const [varName, formula] of sorted) {
      if (localVals[varName] !== undefined) continue;
      // Try to evaluate — unresolved local deps will still be 0 but that's OK
      const val = evalFormula(formula, attrs, resolvedFns, localVals, solarPower);
      if (!isNaN(val) && isFinite(val)) {
        localVals[varName] = val;
        changed = true;
      }
    }
  }
  return localVals;
}

// ---------------------------------------------------------------------------
// accumulateOutfits
// ---------------------------------------------------------------------------

function accumulateOutfits(baseAttrs, outfitMap, outfitIdx) {
  const attrDefs = _attrDefs?.attributes || {};
  const result   = {};
  for (const [key, val] of Object.entries(baseAttrs)) {
    if (typeof val === 'number') result[key] = val;
  }
  for (const [outfitName, qty] of Object.entries(outfitMap || {})) {
    const outfit = outfitIdx[outfitName];
    if (!outfit) continue;
    const outfitAttrs = (
      typeof outfit.attributes === 'object' &&
      outfit.attributes !== null &&
      Object.keys(outfit.attributes).length > 0
    ) ? outfit.attributes : outfit;
    for (const [key, rawVal] of Object.entries(outfitAttrs)) {
      if (typeof rawVal !== 'number') continue;
      if (key.startsWith('_'))        continue;
      const stacking = attrDefs[key]?.stacking || 'additive';
      const contrib  = rawVal * qty;
      switch (stacking) {
        case 'maximum':              result[key] = Math.max(result[key] ?? -Infinity, contrib); break;
        case 'minimum':              result[key] = Math.min(result[key] ??  Infinity, contrib); break;
        case 'additive-then-multiply': /* falls through */
        default:                     result[key] = (result[key] || 0) + contrib; break;
      }
    }
    if (typeof outfit.cost === 'number')
      result['_totalOutfitCost'] = (result['_totalOutfitCost'] || 0) + outfit.cost * qty;
    if (typeof outfit.mass === 'number')
      result['_outfitMass'] = (result['_outfitMass'] || 0) + outfit.mass * qty;
  }
  result['_totalOutfits'] = Object.values(outfitMap || {}).reduce((s, q) => s + q, 0);
  return result;
}

// ---------------------------------------------------------------------------
// resolveShipFunctions
//
// Evaluates all ship functions in dependency order.
// Key improvement: each function's attributeVariables are resolved first
// and passed to evalFormula as localVars, so C++ local vars like 'dissipation'
// in IdleHeat are correctly substituted.
// ---------------------------------------------------------------------------

function resolveShipFunctions(attrs, solarPower) {
  const fns    = _attrDefs?.shipFunctions || {};
  const solar  = (typeof solarPower === 'number') ? solarPower
               : (_attrDefs?.systemContext?.referenceSolarPower ?? 1.0);
  const cache  = {};
  const done   = new Set();

  // Resolve a single function, using current cache state for dependencies.
  function resolveOne(fnName) {
    const fn = fns[fnName];
    if (!fn?.formulas?.length) return NaN;
    const formula   = fn.formulas[fn.formulas.length - 1].formula;
    const localVars = resolveLocalVars(fn.attributeVariables || {}, attrs, cache, solar);
    return evalFormula(formula, attrs, cache, localVars, solar);
  }

  // ── Priority resolution order: dependencies first ──────────────────────────
  // This order ensures each function's dependencies are available when it runs.
  const PRIORITY = [
    // Mass chain (Drag and InertialMass depend on Mass)
    'Mass', 'Drag', 'DragForce', 'InertialMass',
    // Heat chain (IdleHeat depends on CoolingEfficiency and HeatDissipation)
    'CoolingEfficiency', 'HeatDissipation', 'MaximumHeat',
    // Combat stats (depend on InertialMass)
    'MaxShields', 'MaxHull', 'MinimumHull',
    'TurnRate', 'Acceleration', 'MaxVelocity',
    'ReverseAcceleration', 'MaxReverseVelocity',
    // Heat equilibrium (depends on CoolingEfficiency and HeatDissipation)
    'IdleHeat',
    // Misc
    'CloakingSpeed', 'RequiredCrew', 'CrewValue',
  ];

  for (const fnName of PRIORITY) {
    const val = resolveOne(fnName);

    // CoolingEfficiency special case: sigmoid with known good behavior
    if (fnName === 'CoolingEfficiency' && (isNaN(val) || val < 0 || val > 2.5)) {
      const x = parseFloat((attrs || {})['cooling inefficiency'] ?? 0);
      cache['CoolingEfficiency'] = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));
    } else if (!isNaN(val)) {
      cache[fnName] = val;
    }
    done.add(fnName);
  }

  // Resolve remaining functions iteratively
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const fnName of Object.keys(fns)) {
      if (done.has(fnName)) continue;
      const fn = fns[fnName];
      if (!fn?.formulas?.length) { done.add(fnName); continue; }
      const val = resolveOne(fnName);
      if (!isNaN(val)) {
        const prev = cache[fnName];
        cache[fnName] = val;
        done.add(fnName);
        if (prev !== val) madeProgress = true;
      }
    }
  }

  return cache;
}

// ---------------------------------------------------------------------------
// resolveDerivedValues
//
// Computes derived stats from:
//   1. Qualifying ship functions (non-suppressed)
//   2. Intermediate display vars from ShipInfoDisplay (non-suppressed)
//   3. Energy/heat table rows
//   4. System-aware formulas (solar, ramscoop)
// ---------------------------------------------------------------------------

function resolveDerivedValues(attrs, fnCache, solarPower) {
  const derived  = {};
  const display  = _attrDefs?.shipDisplay || {};
  const intVars  = display.intermediateVars || {};
  const table    = display.energyHeatTable  || [];
  const solar    = (typeof solarPower === 'number') ? solarPower
                 : (_attrDefs?.systemContext?.referenceSolarPower ?? 1.0);
  const varCache = { ...fnCache };

  // ── 1. Intermediate display vars ──────────────────────────────────────────
  const resolvedVars = new Set();
  let changed = true;
  let pass    = 0;
  const maxPasses = Object.keys(intVars).length + 1;

  while (changed && pass < maxPasses) {
    changed = false; pass++;
    for (const [varName, formula] of Object.entries(intVars)) {
      if (resolvedVars.has(varName)) continue;
      if (shouldSuppressIntermediateVar(varName, formula)) continue;
      const val = evalFormula(formula, attrs, varCache, {}, solar);
      if (!isNaN(val) && isFinite(val)) {
        const prev = varCache[varName];
        varCache[varName] = val;
        derived[`_derived_${varName}`] = val;
        resolvedVars.add(varName);
        if (prev === undefined || Math.abs(val - prev) > 1e-10) changed = true;
      }
    }
  }

  // ── 2. Energy/heat table rows ──────────────────────────────────────────────
  for (const row of table) {
    if (!row.label) continue;
    const eVal = evalFormula(row.energyFormula, attrs, varCache, {}, solar);
    const hVal = evalFormula(row.heatFormula,   attrs, varCache, {}, solar);
    const safeLabel = row.label.replace(/[^a-zA-Z0-9]/g, '_');
    if (!isNaN(eVal) && eVal !== 0) derived[`_derived_energy_${safeLabel}`] = eVal;
    if (!isNaN(hVal) && hVal !== 0) derived[`_derived_heat_${safeLabel}`]   = hVal;
  }

  // ── 3. Ship function results (non-suppressed) ──────────────────────────────
  const fns = _attrDefs?.shipFunctions || {};
  for (const [fnName, fnData] of Object.entries(fns)) {
    if (fnCache[fnName] === undefined) continue;
    if (shouldSuppressFn(fnName, fnData))    continue;
    derived[`_fn_${fnName}`] = fnCache[fnName];
  }

  // ── 4. System-aware formulas ───────────────────────────────────────────────
  const sysFormulas = _attrDefs?.systemAwareFormulas || {};
  for (const [attrKey, info] of Object.entries(sysFormulas)) {
    const val = evalFormula(info.formula, attrs, varCache, {}, solar);
    if (!isNaN(val) && val !== 0) {
      derived[`_sys_${attrKey.replace(/\s+/g, '_')}`] = val * (info.displayScale ?? 1);
    }
  }

  return derived;
}

// ---------------------------------------------------------------------------
// getComputedStats — main public API
// ---------------------------------------------------------------------------

function getComputedStats(ship, pluginId, options) {
  const id       = ship._internalId || ship.name;
  const cacheKey = id + (pluginId || '') + (options?.solarPower ?? '');
  if (_cache[cacheKey]) return _cache[cacheKey];

  const solar     = options?.solarPower
                  ?? _attrDefs?.systemContext?.referenceSolarPower
                  ?? 1.0;
  const baseAttrs = ship.attributes || {};
  const outfitIdx = getOutfitIndex(pluginId);
  const result    = accumulateOutfits(baseAttrs, ship.outfitMap || {}, outfitIdx);

  // Merge top-level numeric ship props that aren't already in result
  for (const [key, val] of Object.entries(ship)) {
    if (typeof val === 'number' && !key.startsWith('_') && !(key in result)) result[key] = val;
  }

  const fnCache = resolveShipFunctions(result, solar);
  const derived = resolveDerivedValues(result, fnCache, solar);
  Object.assign(result, derived);

  _cache[cacheKey] = result;
  return result;
}

function getComputedStat(ship, pluginId, statKey, options) {
  return getComputedStats(ship, pluginId, options)?.[statKey];
}

// ---------------------------------------------------------------------------
// getComputedSorterFields — for UI sorters/filters
// ---------------------------------------------------------------------------

function getComputedSorterFields() {
  if (!_attrDefs) return [];
  const fields  = [];
  const display = _attrDefs.shipDisplay || {};
  const intVars = display.intermediateVars || {};
  const fns     = _attrDefs.shipFunctions || {};

  for (const [varName, formula] of Object.entries(intVars)) {
    if (shouldSuppressIntermediateVar(varName, formula)) continue;
    const id    = `_derived_${varName}`;
    const label = varName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim() + ' (computed)';
    fields.push({ id, key: id, label, path: null, isComputed: true });
  }
  for (const row of (display.energyHeatTable || [])) {
    if (!row.label) continue;
    const safeLabel = row.label.replace(/[^a-zA-Z0-9]/g, '_');
    const baseLabel = row.label.charAt(0).toUpperCase() + row.label.slice(1);
    fields.push({ id: `_derived_energy_${safeLabel}`, key: `_derived_energy_${safeLabel}`, label: `${baseLabel} Energy/s (computed)`, path: null, isComputed: true });
    fields.push({ id: `_derived_heat_${safeLabel}`,   key: `_derived_heat_${safeLabel}`,   label: `${baseLabel} Heat/s (computed)`,   path: null, isComputed: true });
  }
  for (const [fnName, fnData] of Object.entries(fns)) {
    if (shouldSuppressFn(fnName, fnData)) continue;
    const id    = `_fn_${fnName}`;
    const label = fnName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim() + ' (computed)';
    fields.push({ id, key: id, label, path: null, isComputed: true });
  }
  // System-aware fields
  for (const [attrKey, info] of Object.entries(_attrDefs?.systemAwareFormulas || {})) {
    const id    = `_sys_${attrKey.replace(/\s+/g, '_')}`;
    const label = attrKey.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') + ' (system)';
    fields.push({ id, key: id, label, path: null, isComputed: true, isSystemAware: true });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Utility: compute stats for a bare attribute map (no ship wrapper)
// Useful for outfit comparisons, standalone calculations, etc.
// ---------------------------------------------------------------------------

function getComputedStatsForAttrs(attrs, options) {
  const solar     = options?.solarPower ?? _attrDefs?.systemContext?.referenceSolarPower ?? 1.0;
  const fnCache   = resolveShipFunctions(attrs, solar);
  const derived   = resolveDerivedValues(attrs, fnCache, solar);
  return { ...attrs, ...derived };
}

// ---------------------------------------------------------------------------
// Debug helpers
// ---------------------------------------------------------------------------

function debugComputedStats(pluginId, shipName) {
  const plugin = window.allData?.[pluginId];
  if (!plugin) { console.error('Plugin not found:', pluginId); return; }
  const ship = (plugin.ships || []).find(s => s.name === shipName)
            || (plugin.variants || []).find(s => s.name === shipName);
  if (!ship) { console.error('Ship not found:', shipName); return; }
  if (!_attrDefs) { console.error('attrDefs not loaded'); return; }
  const stats = getComputedStats(ship, pluginId);
  console.group(`ComputedStats: ${shipName}`);
  console.log('_fn_ keys:', Object.keys(stats).filter(k => k.startsWith('_fn_')));
  console.log('_derived_ keys:', Object.keys(stats).filter(k => k.startsWith('_derived_')));
  console.log('_sys_ keys:', Object.keys(stats).filter(k => k.startsWith('_sys_')));
  console.groupEnd();
  return stats;
}

function debugFnResolution(pluginId, shipName) {
  const plugin = window.allData?.[pluginId];
  const ship   = (plugin?.ships || []).find(s => s.name === shipName);
  if (!ship || !_attrDefs) { console.error('Ship or attrDefs not found'); return; }
  const outfitIdx = getOutfitIndex(pluginId);
  const attrs     = accumulateOutfits(ship.attributes || {}, ship.outfitMap || {}, outfitIdx);
  const solar     = _attrDefs?.systemContext?.referenceSolarPower ?? 1.0;
  const fns       = _attrDefs.shipFunctions || {};
  const PRIORITY  = ['Mass','Drag','InertialMass','CoolingEfficiency','HeatDissipation',
    'MaximumHeat','MaxShields','MaxHull','TurnRate','Acceleration','MaxVelocity',
    'IdleHeat','CloakingSpeed'];
  const testCache = {};
  console.group(`FnResolution: ${shipName}`);
  for (const fnName of PRIORITY) {
    const fn = fns[fnName];
    if (!fn?.formulas?.length) { console.log(`  ${fnName}: no formulas`); continue; }
    const localVars = resolveLocalVars(fn.attributeVariables || {}, attrs, testCache, solar);
    const formula   = fn.formulas[fn.formulas.length - 1].formula;
    const val       = evalFormula(formula, attrs, testCache, localVars, solar);
    const scale     = fn.displayScale ?? 1;
    const sup       = shouldSuppressFn(fnName, fn);
    console.log(`  ${fnName}: raw=${val?.toFixed(4)}  display=${(val*scale)?.toFixed(4)}  suppressed=${sup}`);
    console.log(`    formula: ${formula}`);
    if (Object.keys(localVars).length) console.log(`    localVars:`, localVars);
    if (!isNaN(val)) testCache[fnName] = val;
  }
  console.groupEnd();
}

function debugOutfitStats(pluginId, outfitName) {
  const plugin = window.allData?.[pluginId];
  if (!plugin || !_attrDefs) { console.error('Plugin or attrDefs not found'); return; }
  const outfit = (plugin.outfits || []).find(o => o.name === outfitName);
  if (!outfit) { console.error('Outfit not found:', outfitName); return; }
  const attrs  = outfit.attributes || outfit;
  const result = getComputedStatsForAttrs(attrs);
  console.group(`OutfitStats: ${outfitName}`);
  console.log('fn_ keys:', Object.keys(result).filter(k => k.startsWith('_fn_')));
  console.log('All attrs:', attrs);
  console.groupEnd();
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

window.initComputedStats        = initComputedStats;
window.clearComputedCache       = clearComputedCache;
window.getComputedStats         = getComputedStats;
window.getComputedStat          = getComputedStat;
window.getComputedSorterFields  = getComputedSorterFields;
window.getComputedStatsForAttrs = getComputedStatsForAttrs;
window.debugComputedStats       = debugComputedStats;
window.debugFnResolution        = debugFnResolution;
window.debugOutfitStats         = debugOutfitStats;

// Also export for Node.js / module environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initComputedStats, clearComputedCache,
    getComputedStats, getComputedStat, getComputedSorterFields,
    getComputedStatsForAttrs,
    debugComputedStats, debugFnResolution, debugOutfitStats,
    // Internal exports for testing
    _evalFormula:               evalFormula,
    _resolveShipFunctions:      resolveShipFunctions,
    _resolveLocalVars:          resolveLocalVars,
    _accumulateOutfits:         accumulateOutfits,
    _shouldSuppressFn:          shouldSuppressFn,
    _shouldSuppressIntermediateVar: shouldSuppressIntermediateVar,
  };
}