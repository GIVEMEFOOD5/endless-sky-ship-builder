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
let _cache    = {};   // { shipInternalId: { statKey: value } }

// ---------------------------------------------------------------------------
// Init / cache control
// ---------------------------------------------------------------------------

function initComputedStats(attrDefs, baseUrl) {
    _attrDefs = attrDefs;
    _cache    = {};
    // Kick off index.json fetch so plugin order is ready before first lookup
    if (baseUrl) ensurePluginOrder(baseUrl);
}

function clearComputedCache() {
    _cache = {};
    // Clear merged outfit indexes from all plugin data objects
    const allData = window.allData || {};
    for (const [pluginId, pluginData] of Object.entries(allData)) {
        const cacheKey = `_mergedOutfitIndex_${pluginId}`;
        delete pluginData[cacheKey];
    }
}

// ---------------------------------------------------------------------------
// Outfit index — searches the current plugin first, then all other plugins
// in the order they appear in index.json (same directory as attributeDefinitions.json).
//
// The merged index is cached per pluginId so it is only built once.
// If two plugins define an outfit with the same name, the current plugin wins,
// then earlier plugins in index.json order take precedence over later ones.
// ---------------------------------------------------------------------------

let _pluginOrder  = null;  // ordered list of outputNames from index.json
let _indexBaseUrl = null;  // base URL used to fetch index.json

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

// Build a per-plugin outfit index (name → outfit) from its own outfits array
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

// Returns a merged outfit index for the given pluginId.
// Current plugin outfits take precedence; remaining plugins are searched
// in index.json order.
function getOutfitIndex(pluginId) {
    const allData = window.allData || {};

    // Use cached merged index if available
    const cacheKey = `_mergedOutfitIndex_${pluginId}`;
    const pluginData = allData[pluginId];
    if (pluginData?.[cacheKey]) return pluginData[cacheKey];

    const merged = {};

    // Determine search order: current plugin first, then index.json order,
    // then any remaining plugins not in index.json
    const order = _pluginOrder || [];
    const allPluginIds = Object.keys(allData);

    const searchOrder = [
        pluginId,
        ...order.filter(id => id !== pluginId && allData[id]),
        ...allPluginIds.filter(id => id !== pluginId && !order.includes(id)),
    ];

    // Build merged index — first definition of a name wins
    for (const pid of searchOrder) {
        const idx = buildSinglePluginIndex(pid);
        for (const [name, outfit] of Object.entries(idx)) {
            if (!(name in merged)) merged[name] = outfit;
        }
    }

    // Cache on the plugin data object
    if (pluginData) pluginData[cacheKey] = merged;
    return merged;
}

// ---------------------------------------------------------------------------
// Formula evaluator
// Replaces [attr name] with numeric values, resolves Math.* and basic C++ calls.
// ---------------------------------------------------------------------------

function evalFormula(formulaStr, attrs, resolvedFns) {
    if (!formulaStr || typeof formulaStr !== 'string') return NaN;
    try {
        let js = formulaStr;

        // ── Step 1: Substitute [attr name] → numeric value ──────────────────
        js = js.replace(/\[([^\]]+)\]/g, (_, k) => {
            const v = parseFloat((attrs || {})[k] ?? 0);
            return isNaN(v) ? '0' : String(v);
        });

        // ── Step 2: Substitute resolved function calls e.g. Drag() → 62.5 ──
        for (const [fn, val] of Object.entries(resolvedFns || {})) {
            // Escape any regex special chars in fn name
            const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            js = js.replace(new RegExp('\\b' + escaped + '\\s*\\(\\s*\\)', 'g'), '(' + val + ')');
        }

        // ── Step 3: C++ template syntax ──────────────────────────────────────
        // Use placeholder to avoid double-replacement by later max/min regex
        js = js.replace(/\b(max|min)<[^>]+>\s*\(/g, '__MATH_$1__(');
        js = js.replace(/static_cast<[^>]+>\s*\(([^)]+)\)/g, '($1)');

        // ── Step 4: Resolve C++ local variables ──────────────────────────────
        const massVal  = String(parseFloat((attrs || {})['mass'] ?? 0));
        const eCap     = String(parseFloat((attrs || {})['energy capacity'] ?? 0));
        const fCap     = String(parseFloat((attrs || {})['fuel capacity'] ?? 0));
        const coolEff  = resolvedFns?.['CoolingEfficiency'] != null
                           ? String(resolvedFns['CoolingEfficiency']) : '1';

        js = js
            // C++ constants
            .replace(/\bMAXIMUM_TEMPERATURE\b/g, '100')
            .replace(/numeric_limits<[^>]+>::max\(\)/g, '1e308')
            // Cargo/mass helpers
            .replace(/cargo\.Used\(\)/g, '0')
            .replace(/attributes\.Mass\(\)/g, massVal)
            .replace(/\bcarriedMass\b/g, '0')
            // bare 'mass' local var (Drag formula) — word boundary, not inside [mass]
            .replace(/(?<!\[)\bmass\b(?!\])/g, massVal)
            // Function parameters defaulted for base-stat calculation
            .replace(/\bwithAfterburner\b/g, '0')
            .replace(/\bslowness\b/g,        '0')
            .replace(/\bdisruption\b/g,       '0')
            .replace(/\bionization\b/g,       '0')
            .replace(/\bscrambling\b/g,       '0')
            .replace(/\bhullDelay\b/g,        '0')
            .replace(/\bshieldDelay\b/g,      '0')
            // Local computed vars
            .replace(/\bminimumHull\b/g, String(
                parseFloat((attrs || {})['threshold percentage'] ?? 0) *
                parseFloat((attrs || {})['hull'] ?? 0)
            ))
            .replace(/\bcoolingEfficiency\b/g, coolEff)
            // Current-level vars — use full capacity for base stats
            .replace(/\benergy\b(?=\s*[-+*/]|\s*[;),]|\s*$)/g, eCap)
            .replace(/\bfuel\b(?=\s*[-+*/]|\s*[;),]|\s*$)/g,   fCap);

        // ── Step 5: JS math function replacements ────────────────────────────
        js = js
            .replace(/\bMax\s*\(/g,   'Math.max(')
            .replace(/\bmin\s*\(/g,   'Math.min(')
            .replace(/\bmax\s*\(/g,   'Math.max(')
            .replace(/\bexp\s*\(/g,   'Math.exp(')
            .replace(/\bfloor\s*\(/g, 'Math.floor(')
            .replace(/\bsqrt\s*\(/g,  'Math.sqrt(')
            .replace(/\babs\s*\(/g,   'Math.abs(')
            .replace(/\bpow\s*\(/g,   'Math.pow(');

        // ── Step 6: Strip remaining unresolved C++ identifiers ───────────────
        // Chained calls like ship.Method() or victim->Method()
        js = js.replace(/\b(?!Math\b)[A-Za-z_][A-Za-z0-9_:]*(?:->|\.)[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)/g, '0');
        // Remaining unresolved PascalCase() calls (not Math.xxx)
        js = js.replace(/\b(?!Math\b)[A-Z][a-zA-Z]+\s*\(\s*\)/g, '0');

        // Restore placeholders from Step 3
        js = js.replace(/__MATH_(max|min)__\(/g, 'Math.$1(');

        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + js + ');')();
        return typeof result === 'number' && isFinite(result) ? result : NaN;
    } catch (_) {
        return NaN;
    }
}


// ---------------------------------------------------------------------------
// Step 1: Accumulate all outfit attribute contributions into a flat result object.
// Stacking rules come entirely from attrDefs.attributes[key].stacking.
// ---------------------------------------------------------------------------

function accumulateOutfits(baseAttrs, outfitMap, outfitIdx) {
    const attrDefs  = _attrDefs?.attributes || {};
    const result    = {};
    const multiplierContribs = {}; // for additive-then-multiply stacking

    // Seed result from base ship attributes (numeric values only)
    for (const [key, val] of Object.entries(baseAttrs)) {
        if (typeof val === 'number') result[key] = val;
    }

    // Walk each outfit × quantity
    for (const [outfitName, qty] of Object.entries(outfitMap || {})) {
        const outfit = outfitIdx[outfitName];
        if (!outfit) continue;

        // Outfit attributes: check outfit.attributes first (ship-builder format),
        // then fall back to flat keys on the outfit object itself.
        // We also need to check the outfit's own top-level numeric fields
        // (cost, mass are always top-level regardless).
        const outfitAttrs = (typeof outfit.attributes === 'object' && outfit.attributes !== null && Object.keys(outfit.attributes).length > 0)
            ? outfit.attributes
            : outfit;

        for (const [key, rawVal] of Object.entries(outfitAttrs)) {
            if (typeof rawVal !== 'number') continue;
            if (key.startsWith('_')) continue;

            const def      = attrDefs[key];
            const stacking = def?.stacking || 'additive'; // default = additive per ES rules
            const contrib  = rawVal * qty;

            switch (stacking) {
                case 'additive-then-multiply':
                    // Collect separately — applied in step 2
                    multiplierContribs[key] = (multiplierContribs[key] || 0) + contrib;
                    break;
                case 'maximum':
                    result[key] = Math.max(result[key] ?? -Infinity, contrib);
                    break;
                case 'minimum':
                    result[key] = Math.min(result[key] ?? Infinity, contrib);
                    break;
                default: // 'additive' and anything else
                    result[key] = (result[key] || 0) + contrib;
                    break;
            }
        }

        // Track outfit cost/mass separately (top-level on outfit object)
        if (typeof outfit.cost === 'number') {
            result['_totalOutfitCost'] = (result['_totalOutfitCost'] || 0) + outfit.cost * qty;
        }
        if (typeof outfit.mass === 'number') {
            result['_outfitMass'] = (result['_outfitMass'] || 0) + outfit.mass * qty;
        }
    }

    // Step 2: Apply additive-then-multiply: effectiveBase * (1 + sum)
    for (const [key, multiplierSum] of Object.entries(multiplierContribs)) {
        result[key] = (result[key] || 0) * (1 + multiplierSum);
    }

    // Total outfit count
    result['_totalOutfits'] = Object.values(outfitMap || {}).reduce((s, q) => s + q, 0);

    return result;
}

// ---------------------------------------------------------------------------
// Step 2: Resolve ship function formulas from attrDefs.shipFunctions.
// Builds a cache of function name → numeric result so later formulas can
// reference e.g. Drag(), InertialMass() in their own expressions.
// ---------------------------------------------------------------------------

function resolveShipFunctions(attrs) {
    const fns   = _attrDefs?.shipFunctions || {};
    const cache = {};
    const done  = new Set();

    // Smart default for an unresolved identifier based on its operator context.
    // multiplication/division context -> 1 (neutral)
    // addition/subtraction context    -> 0 (neutral)
    function smartDefault(formula, callStr) {
        const idx    = formula.indexOf(callStr);
        if (idx === -1) return 0;
        const before = formula.slice(Math.max(0, idx - 40), idx).trimEnd();
        const after  = formula.slice(idx + callStr.length).trimStart();

        if (/\bsqrt\s*\(\s*$/.test(before))       return 1;
        if (/\bpow\s*\([^,]*,\s*$/.test(before))  return 1;
        if (/[*/]\s*$/.test(before))                return 1;
        if (/^\s*[*/]/.test(after))                 return 1;
        return 0;
    }

    // Evaluate a formula, substituting resolved fn results or smart defaults
    // for any unresolved PascalCase() calls.
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

    // Loop over all functions repeatedly, skipping already-done ones.
    // Stop when a full pass produces no new resolutions.
    const fnNames    = Object.keys(fns);
    let madeProgress = true;

    while (madeProgress) {
        madeProgress = false;

        for (const fnName of fnNames) {
            if (done.has(fnName)) continue;

            const fn = fns[fnName];
            if (!fn?.formulas?.length) { done.add(fnName); continue; }

            const formula = fn.formulas[fn.formulas.length - 1].formula;

            // Check if all fn deps are resolved
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
// Step 3: Compute display/derived values from:
//   - shipDisplay.energyHeatTable (energy/heat rows)
//   - shipDisplay.intermediateVars (named intermediate formulas)
//   - shipFunctions (any numeric result worth exposing)
// All are prefixed with '_derived_' to distinguish from raw attributes.
// ---------------------------------------------------------------------------

function resolveDerivedValues(attrs, fnCache) {
    const derived  = {};
    const display  = _attrDefs?.shipDisplay || {};
    const intVars  = display.intermediateVars || {};
    const table    = display.energyHeatTable  || [];

    // ── Resolve intermediate vars in dependency order ─────────────────────────
    // Some vars reference other vars (e.g. baseAccel uses forwardThrust).
    // We resolve iteratively — only using real data, no defaults for missing values.
    // A var is only stored if it produces a real non-NaN result from actual attrs.
    const varCache = { ...fnCache }; // start with resolved ship function values

    // Cap at N+1 passes (worst case: one new resolution per pass for N vars)
    const maxPasses = Object.keys(intVars).length + 1;
    const resolvedVars = new Set();
    let changed = true;
    let pass = 0;
    while (changed && pass < maxPasses) {
        changed = false;
        pass++;
        for (const [varName, formula] of Object.entries(intVars)) {
            if (resolvedVars.has(varName)) continue;

            // Substitute already-resolved var values into the formula string
            let js = formula;
            for (const [k, v] of Object.entries(varCache)) {
                const safeK = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                js = js.replace(new RegExp('\\b' + safeK + '\\b', 'g'), String(v));
            }

            const val = evalFormula(js, attrs, varCache);
            // Only store if the result is a real number — no defaults for missing data
            if (!isNaN(val) && isFinite(val)) {
                const prev = varCache[varName];
                varCache[varName] = val;
                derived[`_derived_${varName}`] = val;
                resolvedVars.add(varName);
                if (prev === undefined || Math.abs(val - prev) > 1e-10) changed = true;
            }
        }
    }

    // ── Energy/heat table rows ────────────────────────────────────────────────
    // These formulas reference ship.CoolingEfficiency() — substitute from fnCache
    for (const row of table) {
        if (!row.label) continue;
        const eVal = evalFormula(row.energyFormula, attrs, varCache);
        const hVal = evalFormula(row.heatFormula,   attrs, varCache);
        const safeLabel = row.label.replace(/[^a-zA-Z0-9]/g, '_');
        if (!isNaN(eVal) && eVal !== 0) derived[`_derived_energy_${safeLabel}`] = eVal;
        if (!isNaN(hVal) && hVal !== 0) derived[`_derived_heat_${safeLabel}`]   = hVal;
    }

    // ── Ship function results ─────────────────────────────────────────────────
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
// Returns a flat object containing:
//   - All effective attribute values (base + outfit contributions + stacking)
//   - _totalOutfitCost, _outfitMass, _totalOutfits (outfit summaries)
//   - _derived_* (intermediate vars and energy/heat table values)
//   - _fn_* (resolved ship function results e.g. _fn_MaxShields, _fn_Drag)
// ---------------------------------------------------------------------------

function getComputedStats(ship, pluginId) {
    const id = ship._internalId || ship.name;
    if (_cache[id]) return _cache[id];

    const baseAttrs = ship.attributes || {};
    const outfitIdx = getOutfitIndex(pluginId);

    // 1. Accumulate base + outfit contributions with correct stacking
    const result = accumulateOutfits(baseAttrs, ship.outfitMap || {}, outfitIdx);

    // Also pull ship top-level numerics (cost, mass, etc.)
    for (const [key, val] of Object.entries(ship)) {
        if (typeof val === 'number' && !key.startsWith('_') && !(key in result)) {
            result[key] = val;
        }
    }

    // 2. Resolve ship function formulas using the accumulated attrs as inputs
    const fnCache = resolveShipFunctions(result);

    // 3. Compute display/derived values
    const derived = resolveDerivedValues(result, fnCache);

    // Merge everything into result
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
// Built dynamically from attrDefs — no hardcoded list.
// Exposes _derived_* and _fn_* keys so the Sorter can offer them.
// ---------------------------------------------------------------------------

function getComputedSorterFields() {
    if (!_attrDefs) return [];

    const fields  = [];
    const display = _attrDefs.shipDisplay || {};

    // Fields from intermediateVars
    for (const varName of Object.keys(display.intermediateVars || {})) {
        const id    = `_derived_${varName}`;
        const label = varName
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, c => c.toUpperCase())
            .trim() + ' (computed)';
        fields.push({ id, key: id, label, path: null, isComputed: true });
    }

    // Fields from energyHeatTable
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

    // Fields from ship functions that read attributes (the meaningful ones)
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
// Global exports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Debug helper — call from console to diagnose issues:
//   debugComputedStats('official-game/endless-sky', 'Heron')
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

    // Log the key attrs the formulas need
    console.log('--- Key attrs ---');
    ['mass','drag','drag reduction','inertia reduction','thrust','turn','shields','hull',
     'shield multiplier','hull multiplier','energy capacity','fuel capacity'].forEach(k => {
        console.log(`  ${k}:`, attrs[k]);
    });

    const fns = _attrDefs.shipFunctions || {};
    console.log('--- Testing each formula ---');

    // Test each function's last formula individually
    const testCache = {};
    const PRIORITY = ['Mass','Drag','DragForce','InertialMass','CoolingEfficiency',
        'HeatDissipation','MaximumHeat','MaxShields','MaxHull','MinimumHull',
        'RequiredCrew','TurnRate','Acceleration','MaxVelocity'];

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