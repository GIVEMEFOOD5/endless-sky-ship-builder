// ComputedStats.js
// Computes effective ship stats entirely from attributeDefinitions.json.
// Zero hardcoded attribute names, formulas, or stacking rules.
//
// Everything comes from:
//   attrDefs.attributes[key].stacking          — how to combine outfit contributions
//   attrDefs.shipFunctions[fn].formulas         — C++ formulas for derived values
//   attrDefs.shipDisplay.energyHeatTable        — energy/heat display rows
//   attrDefs.shipDisplay.intermediateVars       — intermediate formula variables
//
// Public API:
//   initComputedStats(attrDefs)          — call once attrDefs is loaded
//   clearComputedCache()                 — call when switching plugins
//   getComputedStats(ship, pluginId)     — returns flat object of all effective values
//   getComputedStat(ship, pluginId, key) — single value lookup
//   getComputedSorterFields()            — field descriptors for Sorter.js

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _attrDefs = null;
let _cache    = {};

// ---------------------------------------------------------------------------
// Init / cache control
// ---------------------------------------------------------------------------

function initComputedStats(attrDefs, baseUrl) {
    _attrDefs = attrDefs;
    _cache    = {};
    if (baseUrl) ensurePluginOrder(baseUrl);
}

function clearComputedCache() {
    _cache = {};
    const allData = window.allData || {};
    for (const [pluginId, pluginData] of Object.entries(allData)) {
        const cacheKey = `_mergedOutfitIndex_${pluginId}`;
        delete pluginData[cacheKey];
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
            for (const { outputName } of pluginList) {
                _pluginOrder.push(outputName);
            }
        }
    } catch (_) {
        _pluginOrder = [];
    }
}

function buildSinglePluginIndex(pluginId) {
    const pluginData = window.allData?.[pluginId];
    if (!pluginData) return {};
    if (!pluginData._outfitIndex) {
        pluginData._outfitIndex = {};
        (pluginData.outfits || []).forEach(o => {
            if (o.name) pluginData._outfitIndex[o.name] = o;
        });
    }
    return pluginData._outfitIndex;
}

function getOutfitIndex(pluginId) {
    const allData = window.allData || {};
    const cacheKey = `_mergedOutfitIndex_${pluginId}`;
    const pluginData = allData[pluginId];
    if (pluginData?.[cacheKey]) return pluginData[cacheKey];

    const merged = {};
    const order = _pluginOrder || [];
    const allPluginIds = Object.keys(allData);
    const searchOrder = [
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

        const massVal  = String(parseFloat((attrs || {})['mass'] ?? 0));
        const eCap     = String(parseFloat((attrs || {})['energy capacity'] ?? 0));
        const fCap     = String(parseFloat((attrs || {})['fuel capacity'] ?? 0));
        const coolEff  = resolvedFns?.['CoolingEfficiency'] != null
                           ? String(resolvedFns['CoolingEfficiency']) : '1';

        js = js
            .replace(/\bMAXIMUM_TEMPERATURE\b/g, '100')
            .replace(/numeric_limits<[^>]+>::max\(\)/g, '1e308')
            .replace(/cargo\.Used\(\)/g, '0')
            .replace(/attributes\.Mass\(\)/g, massVal)
            .replace(/\bcarriedMass\b/g, '0')
            .replace(/(?<!\[)\bmass\b(?!\])/g, massVal)
            .replace(/\bwithAfterburner\b/g, '0')
            .replace(/\bslowness\b/g,        '0')
            .replace(/\bdisruption\b/g,       '0')
            .replace(/\bionization\b/g,       '0')
            .replace(/\bscrambling\b/g,       '0')
            .replace(/\bhullDelay\b/g,        '0')
            .replace(/\bshieldDelay\b/g,      '0')
            .replace(/\bminimumHull\b/g, String(
                parseFloat((attrs || {})['threshold percentage'] ?? 0) *
                parseFloat((attrs || {})['hull'] ?? 0)
            ))
            .replace(/\bcoolingEfficiency\b/g, coolEff)
            .replace(/\benergy\b(?=\s*[-+*/]|\s*[;),]|\s*$)/g, eCap)
            .replace(/\bfuel\b(?=\s*[-+*/]|\s*[;),]|\s*$)/g,   fCap);

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

        js = js.replace(/__MATH_(max|min)__\(/g, 'Math.$1(');

        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + js + ');')();
        return typeof result === 'number' && isFinite(result) ? result : NaN;
    } catch (_) {
        return NaN;
    }
}

// ---------------------------------------------------------------------------
// Step 1: accumulateOutfits
//
// FIX 4: Removed premature 'additive-then-multiply' post-loop multiplication.
//
// The old code had a Step 2 that applied: result[key] = result[key] * (1 + sum)
// for all 'additive-then-multiply' keys (shield multiplier, hull multiplier, etc.).
// This was wrong because the ship function formulas (MaxShields, MaxHull, TurnRate,
// Acceleration) already apply the multiplication themselves:
//   MaxShields() = [shields] * (1 + [shield multiplier])
//
// Applying the multiplication here AND in the formula caused double-inflation.
//
// Fix: 'additive-then-multiply' keys now simply sum additively during outfit
// accumulation. The stacking label is preserved as documentation of the
// overall effect, but accumulation only does the additive part.
// ---------------------------------------------------------------------------

function accumulateOutfits(baseAttrs, outfitMap, outfitIdx) {
    const attrDefs = _attrDefs?.attributes || {};
    const result   = {};

    // Seed result from base ship attributes (numeric values only)
    for (const [key, val] of Object.entries(baseAttrs)) {
        if (typeof val === 'number') result[key] = val;
    }

    // Walk each outfit × quantity
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

            const def      = attrDefs[key];
            const stacking = def?.stacking || 'additive';
            const contrib  = rawVal * qty;

            switch (stacking) {
                case 'maximum':
                    result[key] = Math.max(result[key] ?? -Infinity, contrib);
                    break;
                case 'minimum':
                    result[key] = Math.min(result[key] ?? Infinity, contrib);
                    break;
                case 'additive-then-multiply':
                    // FIX 4: accumulate additively only — the multiplication is
                    // performed once inside the ship function formula (e.g. MaxShields).
                    // Fall through to additive.
                    /* falls through */
                default: // 'additive'
                    result[key] = (result[key] || 0) + contrib;
                    break;
            }
        }

        if (typeof outfit.cost === 'number') {
            result['_totalOutfitCost'] = (result['_totalOutfitCost'] || 0) + outfit.cost * qty;
        }
        if (typeof outfit.mass === 'number') {
            result['_outfitMass'] = (result['_outfitMass'] || 0) + outfit.mass * qty;
        }
    }

    result['_totalOutfits'] = Object.values(outfitMap || {}).reduce((s, q) => s + q, 0);

    return result;
    // NOTE: the old Step 2 multiplierContribs loop has been intentionally removed.
}

// ---------------------------------------------------------------------------
// Step 2: resolveShipFunctions
//
// FIX 3: Mass() must resolve before CloakingSpeed().
// The PRIORITY list now starts with 'Mass' so that CloakingSpeed's formula
//   [cloak] + [cloak by mass] * 1000 / Mass()
// correctly divides by the ship's real mass rather than 0.
//
// After parser FIX 3 (sentinelizing attributes.Mass()), Ship::Mass() will
// have attributesRead: ["mass"] in the JSON, so it will be parsed and
// available as a resolvable function here.
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
            if (cache[depName] !== undefined) {
                substitutions[depName] = cache[depName];
            } else if (fns[depName]) {
                substitutions[depName] = smartDefault(formula, m[0]);
            }
        }
        return evalFormula(formula, attrs, substitutions);
    }

    // FIX 3: Mass is first — it must resolve before CloakingSpeed and any
    // other function that calls Mass() in its formula.
    const PRIORITY = [
        'Mass',             // FIX 3: must be first
        'Drag', 'DragForce', 'InertialMass',
        'CoolingEfficiency', 'HeatDissipation', 'MaximumHeat',
        'MaxShields', 'MaxHull', 'MinimumHull',
        'TurnRate', 'Acceleration', 'MaxVelocity',
        'ReverseAcceleration', 'MaxReverseVelocity',
        'CloakingSpeed',    // after Mass
        'RequiredCrew',
    ];

    // First pass: resolve priority functions in explicit order
    for (const fnName of PRIORITY) {
        const fn = fns[fnName];
        if (!fn?.formulas?.length) continue;
        const formula = fn.formulas[fn.formulas.length - 1].formula;
        const val = resolveFormula(formula);
        if (!isNaN(val)) {
            cache[fnName] = val;
            done.add(fnName);
        }
    }

    // Second pass: remaining functions via iterative dependency loop
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
            let depMatch;
            let allDepsResolved = true;
            while ((depMatch = fnCallRe.exec(formula)) !== null) {
                if (fns[depMatch[1]] && !done.has(depMatch[1])) {
                    allDepsResolved = false;
                    break;
                }
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
// Step 3: resolveDerivedValues
//
// FIX 5: varCache starts as a copy of fnCache, so evalFormula can substitute
// resolved ship function results (CoolingEfficiency, Mass, etc.) when
// evaluating intermediate variables like:
//   activeCooling = CoolingEfficiency() * ([cooling] + [active cooling])
//
// Previously, varCache only accumulated other intermediate vars, so
// CoolingEfficiency() in the activeCooling formula was left unresolved
// and stripped to 0 by evalFormula's PascalCase fallback.
// ---------------------------------------------------------------------------

function resolveDerivedValues(attrs, fnCache) {
    const derived  = {};
    const display  = _attrDefs?.shipDisplay || {};
    const intVars  = display.intermediateVars || {};
    const table    = display.energyHeatTable  || [];

    // FIX 5: seed varCache with all resolved ship function values so that
    // PascalCase() calls inside intermediate var formulas get real numbers.
    const varCache = { ...fnCache };

    const maxPasses    = Object.keys(intVars).length + 1;
    const resolvedVars = new Set();
    let changed = true;
    let pass    = 0;

    while (changed && pass < maxPasses) {
        changed = false;
        pass++;

        for (const [varName, formula] of Object.entries(intVars)) {
            if (resolvedVars.has(varName)) continue;

            // FIX 5: pass varCache as resolvedFns — includes CoolingEfficiency,
            // Mass, etc. so they substitute correctly rather than falling back to 0.
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

    // Energy/heat table rows — pass full varCache so activeCooling feeds in
    for (const row of table) {
        if (!row.label) continue;
        const eVal = evalFormula(row.energyFormula, attrs, varCache);
        const hVal = evalFormula(row.heatFormula,   attrs, varCache);
        const safeLabel = row.label.replace(/[^a-zA-Z0-9]/g, '_');
        if (!isNaN(eVal) && eVal !== 0) derived[`_derived_energy_${safeLabel}`] = eVal;
        if (!isNaN(hVal) && hVal !== 0) derived[`_derived_heat_${safeLabel}`]   = hVal;
    }

    // Ship function results
    const fns = _attrDefs?.shipFunctions || {};
    for (const [fnName, fnData] of Object.entries(fns)) {
        if (fnCache[fnName] === undefined) continue;
        if (!fnData.attributesRead?.length) continue;
        derived[`_fn_${fnName}`] = fnCache[fnName];
    }

    return derived;
}

// ---------------------------------------------------------------------------
// Main: getComputedStats
// ---------------------------------------------------------------------------

function getComputedStats(ship, pluginId) {
    const id = ship._internalId || ship.name;
    if (_cache[id]) return _cache[id];

    const baseAttrs = ship.attributes || {};
    const outfitIdx = getOutfitIndex(pluginId);

    const result = accumulateOutfits(baseAttrs, ship.outfitMap || {}, outfitIdx);

    for (const [key, val] of Object.entries(ship)) {
        if (typeof val === 'number' && !key.startsWith('_') && !(key in result)) {
            result[key] = val;
        }
    }

    const fnCache = resolveShipFunctions(result);
    const derived = resolveDerivedValues(result, fnCache);

    Object.assign(result, derived);

    _cache[id] = result;
    return result;
}

// ---------------------------------------------------------------------------
// Convenience: single stat lookup
// ---------------------------------------------------------------------------

function getComputedStat(ship, pluginId, statKey) {
    return getComputedStats(ship, pluginId)?.[statKey];
}

// ---------------------------------------------------------------------------
// Sorter field descriptors
// ---------------------------------------------------------------------------

function getComputedSorterFields() {
    if (!_attrDefs) return [];

    const fields  = [];
    const display = _attrDefs.shipDisplay || {};

    for (const varName of Object.keys(display.intermediateVars || {})) {
        const id    = `_derived_${varName}`;
        const label = varName
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, c => c.toUpperCase())
            .trim() + ' (computed)';
        fields.push({ id, key: id, label, path: null, isComputed: true });
    }

    for (const row of (display.energyHeatTable || [])) {
        if (!row.label) continue;
        const safeLabel = row.label.replace(/[^a-zA-Z0-9]/g, '_');
        const baseLabel = row.label.charAt(0).toUpperCase() + row.label.slice(1);
        fields.push({
            id:         `_derived_energy_${safeLabel}`,
            key:        `_derived_energy_${safeLabel}`,
            label:      `${baseLabel} Energy/s (computed)`,
            path:       null,
            isComputed: true,
        });
        fields.push({
            id:         `_derived_heat_${safeLabel}`,
            key:        `_derived_heat_${safeLabel}`,
            label:      `${baseLabel} Heat/s (computed)`,
            path:       null,
            isComputed: true,
        });
    }

    const fns = _attrDefs.shipFunctions || {};
    for (const [fnName, fnData] of Object.entries(fns)) {
        if (!fnData.attributesRead?.length) continue;
        const id    = `_fn_${fnName}`;
        const label = fnName
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, c => c.toUpperCase())
            .trim() + ' (computed)';
        fields.push({ id, key: id, label, path: null, isComputed: true });
    }

    return fields;
}

// ---------------------------------------------------------------------------
// Debug helpers
// ---------------------------------------------------------------------------

function debugComputedStats(pluginId, shipName) {
    const plugin = window.allData?.[pluginId];
    if (!plugin) { console.error('Plugin not found:', pluginId, '| Available:', Object.keys(window.allData || {})); return; }
    const ship = (plugin.ships || []).find(s => s.name === shipName) || (plugin.variants || []).find(s => s.name === shipName);
    if (!ship) { console.error('Ship not found:', shipName); return; }
    if (!_attrDefs) { console.error('attrDefs not loaded — initComputedStats not called yet'); return; }
    console.log('attrDefs loaded:', !!_attrDefs);
    console.log('outfitMap:', ship.outfitMap);
    const idx = getOutfitIndex(pluginId);
    console.log('outfit index size:', Object.keys(idx).length);
    const firstOutfit = Object.keys(ship.outfitMap || {})[0];
    if (firstOutfit) console.log('first outfit lookup:', firstOutfit, '→', idx[firstOutfit] ? 'FOUND' : 'MISSING');
    const stats = getComputedStats(ship, pluginId);
    console.log('computed stats keys:', Object.keys(stats).length);
    console.log('sample derived keys:', Object.keys(stats).filter(k => k.startsWith('_derived_') || k.startsWith('_fn_')).slice(0, 10));
    return stats;
}

window.debugComputedStats = debugComputedStats;

function debugFnResolution(pluginId, shipName) {
    const plugin = window.allData?.[pluginId];
    const ship   = (plugin?.ships || []).find(s => s.name === shipName);
    if (!ship) { console.error('Ship not found'); return; }
    if (!_attrDefs) { console.error('attrDefs null'); return; }

    const baseAttrs = ship.attributes || {};
    const outfitIdx = getOutfitIndex(pluginId);
    const attrs     = accumulateOutfits(baseAttrs, ship.outfitMap || {}, outfitIdx);

    console.log('--- Key attrs ---');
    ['mass','drag','drag reduction','inertia reduction','thrust','turn','shields','hull',
     'shield multiplier','hull multiplier','energy capacity','fuel capacity'].forEach(k => {
        console.log(`  ${k}:`, attrs[k]);
    });

    const fns = _attrDefs.shipFunctions || {};
    console.log('--- Testing each formula ---');

    const testCache = {};
    // FIX 3: Mass first
    const PRIORITY = ['Mass','Drag','DragForce','InertialMass','CoolingEfficiency',
        'HeatDissipation','MaximumHeat','MaxShields','MaxHull','MinimumHull',
        'RequiredCrew','TurnRate','Acceleration','MaxVelocity','CloakingSpeed'];

    for (const fnName of PRIORITY) {
        const fn = fns[fnName];
        if (!fn?.formulas?.length) { console.log(`  ${fnName}: no formulas`); continue; }
        const formula = fn.formulas[fn.formulas.length - 1].formula;
        const val = evalFormula(formula, attrs, testCache);
        console.log(`  ${fnName}: formula="${formula.slice(0,80)}" → ${val}`);
        if (!isNaN(val)) testCache[fnName] = val;
    }
}
window.debugFnResolution = debugFnResolution;

window.initComputedStats       = initComputedStats;
window.clearComputedCache      = clearComputedCache;
window.getComputedStats        = getComputedStats;
window.getComputedStat         = getComputedStat;
window.getComputedSorterFields = getComputedSorterFields;
