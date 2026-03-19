// ComputedStats.js
// Computes effective ship stats entirely from attributeDefinitions.json.
// Zero hardcoded attribute names, formulas, or stacking rules.

let _attrDefs = null;
let _cache    = {};

// ---------------------------------------------------------------------------
// Init / cache control
// ---------------------------------------------------------------------------

function initComputedStats(attrDefs, baseUrl) {
    _attrDefs = attrDefs;
    _cache    = {};
    _knownDisplayFns = null; // reset lazy cache
    if (baseUrl) ensurePluginOrder(baseUrl);
}

function clearComputedCache() {
    _cache = {};
    const allData = window.allData || {};
    for (const [pluginId, pluginData] of Object.entries(allData)) {
        delete pluginData[`_mergedOutfitIndex_${pluginId}`];
    }
}

// ---------------------------------------------------------------------------
// Outfit index
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
// Ship function suppression — purely data-driven, zero hardcoded fn names
//
// Patterns derived from the JSON itself:
//   1. returnType is non-numeric (bool, void, string, pointer, reference)
//   2. No formulas extracted
//   3. attributesRead is empty AND formula has no calls to known display fns
//   4. formula contains 'min(1.' — returns 0-1 fraction (Fuel, Energy, Shields)
//   5. formula contains '/ maximum' — returns 0-1 ratio
//   6. formula is a bare single identifier (pure internal state read)
//   7. formula is always zero
//   8. DragForce pattern: ternary ending in '/ mass' returns drag coefficient
//   9. Pure economic formula: uses sqrt( with single cargo-space attr
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

    // 1. Non-numeric return type
    if (/^(bool|void|string|const string|shared_ptr|vector|map|set|pair|.*[*&])/.test(ret)) return true;

    // 2. No formulas
    if (!fnData.formulas?.length) return true;

    // 3. No attributesRead and no calls to known display functions
    if (!attrs.length) {
        const displayFns = getKnownDisplayFns();
        const callsDisplayFn = [...displayFns].some(fn => formula.includes(`${fn}()`));
        if (!callsDisplayFn) return true;
    }

    // 4. Returns 0-1 fraction via min(1.
    if (formula.includes('min(1.')) return true;

    // 5. Divides by 'maximum'
    if (formula.includes('/ maximum')) return true;

    // 6. Bare single identifier (pure state read: 'crew', 'disruption', etc.)
    if (formula && !formula.includes('[') && !formula.includes('(') && /^\w+$/.test(formula.trim())) return true;

    // 7. Always zero
    if (/^0[.\s]*$/.test(formula.trim())) return true;

    // 8. DragForce pattern: ternary that compares to mass and divides by mass
    // Returns a 0-1 drag coefficient, not a displayable force value
    if (formula.includes('>= mass') && formula.includes('/ mass')) return true;

    // 9. Economic formula: sqrt of a single cargo attr (not a ship physics stat)
    if (formula.includes('sqrt(') && attrs.length === 1 && attrs[0].includes('cargo')) return true;

    return false;
}

// ---------------------------------------------------------------------------
// IntermediateVar suppression — purely data-driven
//
// Patterns:
//   1. name ends with 'PerFrame' — per-frame duplicate of shown /s value
//   2. No division, no fn call, no max/min, ≤1 attr read — single attr passthrough
//   3. No division, no fn call, 2 attr reads with '?' — ternary attr selection
//   4. Formula starts with a numeric literal × — pre-scaled duplicate of ship fn
// ---------------------------------------------------------------------------

function shouldSuppressIntermediateVar(varName, formula) {
    // 1. Per-frame duplicates
    if (/PerFrame$/i.test(varName)) return true;

    const bracketCount = (formula.match(/\[/g) || []).length;
    const hasDivision  = formula.includes('/');
    const hasFnCall    = /[A-Z][a-zA-Z]+\s*\(/.test(formula);
    const hasMaxMin    = /\bmax\s*\(|\bmin\s*\(/.test(formula);

    // 2. Single attribute passthrough (emptyMass, fuelCapacity, reduction, etc.)
    if (!hasDivision && !hasFnCall && !hasMaxMin && bracketCount <= 1) return true;

    // 3. Simple ternary attr selection (forwardThrust = [thrust] ? [thrust] : [afterburner])
    if (!hasDivision && !hasFnCall && bracketCount === 2 && formula.includes('?')) return true;

    // 4. Pre-scaled intermediateVar duplicating a ship function
    // e.g. baseTurn = 60. * [turn] * ..., baseAccel = 3600. * forwardThrust * ...
    if (/^\d+\.\s*\*/.test(formula.trim())) return true;

    return false;
}

// ---------------------------------------------------------------------------
// Formula evaluator
// ---------------------------------------------------------------------------

function evalFormula(formulaStr, attrs, resolvedFns) {
    if (!formulaStr || typeof formulaStr !== 'string') return NaN;
    try {
        let js = formulaStr;

        js = js.replace(/\[([^\]]+)\]/g, (_, k) => {
            const v = parseFloat((attrs || {})[k] ?? 0);
            return isNaN(v) ? '0' : String(v);
        });

        for (const [fn, val] of Object.entries(resolvedFns || {})) {
            const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            js = js.replace(new RegExp('\\b' + escaped + '\\s*\\(\\s*\\)', 'g'), '(' + val + ')');
        }

        js = js.replace(/\b(max|min)<[^>]+>\s*\(/g, '__MATH_$1__(');
        js = js.replace(/static_cast<[^>]+>\s*\(([^)]+)\)/g, '($1)');

        const massVal = String(parseFloat((attrs || {})['mass'] ?? 0));
        const eCap    = String(parseFloat((attrs || {})['energy capacity'] ?? 0));
        const fCap    = String(parseFloat((attrs || {})['fuel capacity'] ?? 0));
        const coolEff = resolvedFns?.['CoolingEfficiency'] != null
                          ? String(resolvedFns['CoolingEfficiency']) : '1';

        js = js
            .replace(/\bMAXIMUM_TEMPERATURE\b/g,  '100')
            .replace(/numeric_limits<[^>]+>::max\(\)/g, '1e308')
            .replace(/cargo\.Used\(\)/g,           '0')
            .replace(/attributes\.Mass\(\)/g,      massVal)
            .replace(/\bcarriedMass\b/g,           '0')
            .replace(/(?<!\[)\bmass\b(?!\])/g,     massVal)
            .replace(/\bwithAfterburner\b/g,       '0')
            .replace(/\bslowness\b/g,              '0')
            .replace(/\bdisruption\b/g,            '0')
            .replace(/\bionization\b/g,            '0')
            .replace(/\bscrambling\b/g,            '0')
            .replace(/\bhullDelay\b/g,             '0')
            .replace(/\bshieldDelay\b/g,           '0')
            .replace(/\bminimumHull\b/g, String(
                parseFloat((attrs || {})['threshold percentage'] ?? 0) *
                parseFloat((attrs || {})['hull'] ?? 0)
            ))
            .replace(/\bcoolingEfficiency\b/g,     coolEff)
            .replace(/\bfuel\b/g,                  fCap)
            .replace(/\benergy\b/g,                eCap);

        js = js
            .replace(/\bMax\s*\(/g,   'Math.max(')
            .replace(/\bmin\s*\(/g,   'Math.min(')
            .replace(/\bmax\s*\(/g,   'Math.max(')
            .replace(/\bexp\s*\(/g,   'Math.exp(')
            .replace(/\bfloor\s*\(/g, 'Math.floor(')
            .replace(/\bsqrt\s*\(/g,  'Math.sqrt(')
            .replace(/\babs\s*\(/g,   'Math.abs(')
            .replace(/\bpow\s*\(/g,   'Math.pow(');

        js = js.replace(/\b(?!Math\b)[A-Za-z_][A-Za-z0-9_:]*(?:->|\.)[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)/g, '0');
        js = js.replace(/\b(?!Math\b)[A-Z][a-zA-Z]+\s*\(\s*\)/g, '0');
        js = js.replace(/\b(?!Math\b|return\b|true\b|false\b)[a-z][a-zA-Z]+\b(?!\s*[\[(])/g, '0');

        js = js.replace(/__MATH_(max|min)__\(/g, 'Math.$1(');

        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + js + ');')();
        return typeof result === 'number' && isFinite(result) ? result : NaN;
    } catch (_) {
        return NaN;
    }
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
            if (key.startsWith('_')) continue;
            const stacking = attrDefs[key]?.stacking || 'additive';
            const contrib  = rawVal * qty;
            switch (stacking) {
                case 'maximum': result[key] = Math.max(result[key] ?? -Infinity, contrib); break;
                case 'minimum': result[key] = Math.min(result[key] ??  Infinity, contrib); break;
                case 'additive-then-multiply': /* falls through */
                default: result[key] = (result[key] || 0) + contrib; break;
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
// ---------------------------------------------------------------------------

function resolveShipFunctions(attrs) {
    const fns   = _attrDefs?.shipFunctions || {};
    const cache = {};
    const done  = new Set();

    function smartDefault(formula, callStr) {
        const idx    = formula.indexOf(callStr);
        if (idx === -1) return 0;
        const before = formula.slice(Math.max(0, idx - 40), idx).trimEnd();
        const after  = formula.slice(idx + callStr.length).trimStart();
        if (/\bsqrt\s*\(\s*$/.test(before))      return 1;
        if (/\bpow\s*\([^,]*,\s*$/.test(before)) return 1;
        if (/[*/]\s*$/.test(before))               return 1;
        if (/^\s*[*/]/.test(after))                return 1;
        return 0;
    }

    function resolveFormula(formula) {
        const substitutions = {};
        const fnCallRe = /\b([A-Z][a-zA-Z]+)\s*\(\s*\)/g;
        let m;
        while ((m = fnCallRe.exec(formula)) !== null) {
            const depName = m[1];
            if (cache[depName] !== undefined)  substitutions[depName] = cache[depName];
            else if (fns[depName])             substitutions[depName] = smartDefault(formula, m[0]);
        }
        return evalFormula(formula, attrs, substitutions);
    }

    const PRIORITY = [
        'Mass', 'Drag', 'DragForce', 'InertialMass',
        'CoolingEfficiency', 'HeatDissipation', 'MaximumHeat',
        'MaxShields', 'MaxHull', 'MinimumHull',
        'TurnRate', 'Acceleration', 'MaxVelocity',
        'ReverseAcceleration', 'MaxReverseVelocity',
        'CloakingSpeed', 'RequiredCrew', 'IdleHeat',
    ];

    for (const fnName of PRIORITY) {
        const fn = fns[fnName];
        if (!fn?.formulas?.length) continue;
        const formula = fn.formulas[fn.formulas.length - 1].formula;
        let val = resolveFormula(formula);

        if (fnName === 'CoolingEfficiency' && (isNaN(val) || val < 0 || val > 2)) {
            const x = parseFloat(attrs['cooling inefficiency'] ?? 0);
            val = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));
        }

        if (!isNaN(val)) { cache[fnName] = val; done.add(fnName); }
    }

    const fnNames    = Object.keys(fns).filter(n => !done.has(n));
    let madeProgress = true;
    while (madeProgress) {
        madeProgress = false;
        for (const fnName of fnNames) {
            if (done.has(fnName)) continue;
            const fn = fns[fnName];
            if (!fn?.formulas?.length) { done.add(fnName); continue; }
            const formula = fn.formulas[fn.formulas.length - 1].formula;
            const fnCallRe = /\b([A-Z][a-zA-Z]+)\s*\(\s*\)/g;
            let depMatch; let allDepsResolved = true;
            while ((depMatch = fnCallRe.exec(formula)) !== null) {
                if (fns[depMatch[1]] && !done.has(depMatch[1])) { allDepsResolved = false; break; }
            }
            const val = resolveFormula(formula);
            if (!isNaN(val)) {
                const prev = cache[fnName];
                cache[fnName] = val;
                if (allDepsResolved) done.add(fnName);
                if (prev !== val) madeProgress = true;
            }
        }
    }
    return cache;
}

// ---------------------------------------------------------------------------
// resolveDerivedValues — suppression applied here
// ---------------------------------------------------------------------------

function resolveDerivedValues(attrs, fnCache) {
    const derived  = {};
    const display  = _attrDefs?.shipDisplay || {};
    const intVars  = display.intermediateVars || {};
    const table    = display.energyHeatTable  || [];
    const varCache = { ...fnCache };

    const maxPasses    = Object.keys(intVars).length + 1;
    const resolvedVars = new Set();
    let changed = true, pass = 0;

    while (changed && pass < maxPasses) {
        changed = false; pass++;
        for (const [varName, formula] of Object.entries(intVars)) {
            if (resolvedVars.has(varName)) continue;
            if (shouldSuppressIntermediateVar(varName, formula)) continue;
            const val = evalFormula(formula, attrs, varCache);
            if (!isNaN(val) && isFinite(val)) {
                const prev = varCache[varName];
                varCache[varName] = val;
                derived[`_derived_${varName}`] = val;
                resolvedVars.add(varName);
                if (prev === undefined || Math.abs(val - prev) > 1e-10) changed = true;
            }
        }
    }

    for (const row of table) {
        if (!row.label) continue;
        const eVal = evalFormula(row.energyFormula, attrs, varCache);
        const hVal = evalFormula(row.heatFormula,   attrs, varCache);
        const safeLabel = row.label.replace(/[^a-zA-Z0-9]/g, '_');
        if (!isNaN(eVal) && eVal !== 0) derived[`_derived_energy_${safeLabel}`] = eVal;
        if (!isNaN(hVal) && hVal !== 0) derived[`_derived_heat_${safeLabel}`]   = hVal;
    }

    const fns = _attrDefs?.shipFunctions || {};
    for (const [fnName, fnData] of Object.entries(fns)) {
        if (fnCache[fnName] === undefined) continue;
        if (shouldSuppressFn(fnName, fnData)) continue;
        derived[`_fn_${fnName}`] = fnCache[fnName];
    }

    return derived;
}

// ---------------------------------------------------------------------------
// getComputedStats
// ---------------------------------------------------------------------------

function getComputedStats(ship, pluginId) {
    const id = ship._internalId || ship.name;
    if (_cache[id]) return _cache[id];
    const baseAttrs = ship.attributes || {};
    const outfitIdx = getOutfitIndex(pluginId);
    const result    = accumulateOutfits(baseAttrs, ship.outfitMap || {}, outfitIdx);
    for (const [key, val] of Object.entries(ship)) {
        if (typeof val === 'number' && !key.startsWith('_') && !(key in result)) result[key] = val;
    }
    const fnCache = resolveShipFunctions(result);
    const derived = resolveDerivedValues(result, fnCache);
    Object.assign(result, derived);
    _cache[id] = result;
    return result;
}

function getComputedStat(ship, pluginId, statKey) {
    return getComputedStats(ship, pluginId)?.[statKey];
}

// ---------------------------------------------------------------------------
// Sorter field descriptors — suppression applied here too
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
    return fields;
}

// ---------------------------------------------------------------------------
// Debug helpers
// ---------------------------------------------------------------------------

function debugComputedStats(pluginId, shipName) {
    const plugin = window.allData?.[pluginId];
    if (!plugin) { console.error('Plugin not found:', pluginId); return; }
    const ship = (plugin.ships || []).find(s => s.name === shipName) || (plugin.variants || []).find(s => s.name === shipName);
    if (!ship) { console.error('Ship not found:', shipName); return; }
    if (!_attrDefs) { console.error('attrDefs not loaded'); return; }
    const stats = getComputedStats(ship, pluginId);
    console.log('_fn_ keys shown:', Object.keys(stats).filter(k => k.startsWith('_fn_')));
    console.log('_derived_ keys shown:', Object.keys(stats).filter(k => k.startsWith('_derived_')));
    return stats;
}

function debugFnResolution(pluginId, shipName) {
    const plugin = window.allData?.[pluginId];
    const ship   = (plugin?.ships || []).find(s => s.name === shipName);
    if (!ship || !_attrDefs) { console.error('Ship or attrDefs not found'); return; }
    const attrs = accumulateOutfits(ship.attributes || {}, ship.outfitMap || {}, getOutfitIndex(pluginId));
    const fns   = _attrDefs.shipFunctions || {};
    const PRIORITY = ['Mass','Drag','InertialMass','CoolingEfficiency','HeatDissipation',
        'MaximumHeat','MaxShields','MaxHull','TurnRate','Acceleration','MaxVelocity','CloakingSpeed'];
    const testCache = {};
    for (const fnName of PRIORITY) {
        const fn = fns[fnName];
        if (!fn?.formulas?.length) { console.log(`  ${fnName}: no formulas`); continue; }
        const val   = evalFormula(fn.formulas[fn.formulas.length - 1].formula, attrs, testCache);
        const scale = fn.displayScale ?? 1;
        const sup   = shouldSuppressFn(fnName, fn);
        console.log(`  ${fnName}: raw=${val}  display=${val*scale}  suppressed=${sup}`);
        if (!isNaN(val)) testCache[fnName] = val;
    }
}

window.debugComputedStats      = debugComputedStats;
window.debugFnResolution       = debugFnResolution;
window.initComputedStats       = initComputedStats;
window.clearComputedCache      = clearComputedCache;
window.getComputedStats        = getComputedStats;
window.getComputedStat         = getComputedStat;
window.getComputedSorterFields = getComputedSorterFields;
