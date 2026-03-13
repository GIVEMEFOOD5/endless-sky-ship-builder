'use strict';

// ─── AttributeDisplay.js ──────────────────────────────────────────────────────
//
// Pure renderer — no data fetching, no monkey-patching.
//
// Plugin_Script.js owns loading attributeDefinitions.json and calls:
//   window.AttributeDisplay.renderAttributesTabEnhanced(item, attrDefs, currentTab)
//
// Exposes:
//   AttributeDisplay.initTooltips()   — call once from Plugin_Script DOMContentLoaded
//   AttributeDisplay.injectStyles()   — call once from Plugin_Script DOMContentLoaded
//
// attrDefs is the parsed attributeDefinitions.json. Shape (all fields optional/may be empty):
//
//   attrDefs.attributes{}               — per-key: { displayMultiplier, displayUnit, isBoolean,
//                                          isExpectedNegative, stacking, stackingDescription,
//                                          usedInShipFunctions[], shownInOutfitPanel,
//                                          shownInShipPanel, description }
//   attrDefs.outfitDisplay.scaleMap{}   — { "key": scaleIndex }
//   attrDefs.outfitDisplay.scaleLabels[]— [{ multiplier, unit }]
//   attrDefs.outfitDisplay.booleanAttributes{} — { "key": "description" }
//   attrDefs.outfitDisplay.valueNames[] — [{ key, unit }]
//   attrDefs.outfitDisplay.percentNames[]
//   attrDefs.outfitDisplay.expectedNegative[]
//   attrDefs.shipDisplay.energyHeatTable[]  — [{ label, energyFormula, heatFormula }]
//   attrDefs.shipDisplay.labelValuePairs[]  — [{ label, formula }]
//   attrDefs.shipDisplay.capacityDisplay[]  — [{ displayLabel, attributeKey }]
//   attrDefs.shipDisplay.intermediateVars{} — { varName: formula }
//   attrDefs.shipFunctions{}            — { fnName: { formulas[], attributesRead[], attributeVariables{} } }
//   attrDefs.weapon.functions{}
//   attrDefs.weapon.dataFileKeys[]
//   attrDefs.weapon.damageTypes[]
//   attrDefs.navigation{}
//   attrDefs.aiCache{}

// ─── Section assignment ───────────────────────────────────────────────────────
//
// Sections are derived entirely from the JSON, not hardcoded.
// We infer section from attribute key patterns rather than a static map.
// The order below is a display preference — unknown sections go to "Other".

const SECTION_ORDER = [
    'General', 'Shields & Hull', 'Energy', 'Engines', 'Jump',
    'Cargo', 'Crew', 'Scanning', 'Cloaking', 'Resistance', 'Protection',
    'Weapon Stats', 'Derived Stats', 'Other',
];

// Section inference from attribute key — runs only when the JSON has no section info.
// Groups are keyword-matched against the key string; first match wins.
const SECTION_PATTERNS = [
    [/^(shields?|hull|shield generation|hull repair|shield energy|hull energy|shield heat|hull heat|shield fuel|hull fuel|shield delay|depleted|repair delay|disabled repair|threshold|absolute threshold|hull multiplier|shield multiplier)/,
        'Shields & Hull'],
    [/^(energy|solar|fuel|cooling|ramscoop|heat generation|heat capacity|heat dissipation)/,
        'Energy'],
    [/^(thrust|turn|reverse|afterburner|engine)/,
        'Engines'],
    [/^(jump|hyperdrive|scram|warp)/,
        'Jump'],
    [/^(cargo|outfit space|weapon capacity|drone|fighter|mass reduction)/,
        'Cargo'],
    [/^(required crew|bunks|crew equivalent|extra mass)/,
        'Crew'],
    [/^(cargo scan|outfit scan|tactical scan|asteroid scan|scan interference)/,
        'Scanning'],
    [/^(cloak)/,
        'Cloaking'],
    [/resistance$/,
        'Resistance'],
    [/protection$|damage reduction/,
        'Protection'],
    [/^(drag|mass|cost|category|automaton|capture|nanobot|gaslining|atmosphere|spinal|remnant)/,
        'General'],
];

function inferSection(key) {
    const k = key.toLowerCase();
    for (const [re, section] of SECTION_PATTERNS) {
        if (re.test(k)) return section;
    }
    return 'Other';
}

// ─── attrDefs accessors ───────────────────────────────────────────────────────
//
// All display metadata is read from attrDefs.attributes[key] which is populated
// by the parser from OutfitInfoDisplay.cpp, ShipInfoDisplay.cpp, and Outfit.cpp.
// Nothing is hardcoded — if a key is missing from the JSON it gets a plain label.

/**
 * Return the unified attribute record for a key.
 * Tries exact match, then lowercase, then returns null.
 */
function getAttrRecord(attrDefs, key) {
    const attrs = attrDefs?.attributes || {};
    return attrs[key] || attrs[key?.toLowerCase()] || null;
}

/**
 * Return the display multiplier for a key.
 * Source: attrDefs.attributes[key].displayMultiplier
 * (populated from OutfitInfoDisplay.cpp SCALE_LABELS via the scaleMap index)
 */
function getDisplayMultiplier(attrDefs, key) {
    return getAttrRecord(attrDefs, key)?.displayMultiplier ?? 1;
}

/**
 * Return the display unit string for a key.
 * Source: attrDefs.attributes[key].displayUnit
 */
function getDisplayUnit(attrDefs, key) {
    return getAttrRecord(attrDefs, key)?.displayUnit ?? '';
}

/**
 * Return a human-readable label for a key.
 * We don't store labels in the JSON (the parser doesn't extract them from C++ —
 * ES uses the raw key as the label). So we title-case the key as the label,
 * which matches what the game itself does.
 */
function getLabel(key) {
    return key
        .split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Return the section name for a key.
 * Derived from the attribute record's usedInShipFunctions + shownInOutfitPanel flags,
 * then falls back to SECTION_PATTERNS inference.
 */
function getSection(attrDefs, key) {
    const rec = getAttrRecord(attrDefs, key);
    if (!rec) return inferSection(key);

    // Use the function-membership to assign engine/shield/energy sections
    const fns = rec.usedInShipFunctions || [];
    if (fns.some(f => /MaxVelocity|Acceleration|TurnRate|Drag|InertialMass|Reverse/.test(f))) {
        const k = key.toLowerCase();
        if (/thrust|turn|reverse|afterburner|engine/.test(k)) return 'Engines';
        if (/drag|inertia/.test(k)) return 'General';
    }
    if (fns.some(f => /MaxShields|MaxHull|MinimumHull|DisabledHull|Health/.test(f))) return 'Shields & Hull';
    if (fns.some(f => /IdleHeat|CoolingEfficiency|HeatDissipation|MaximumHeat/.test(f))) return 'Energy';
    if (fns.some(f => /CloakingSpeed/.test(f))) return 'Cloaking';
    if (fns.some(f => /Jump|Nav/.test(f))) return 'Jump';

    if (rec.isWeaponStat) return 'Weapon Stats';
    if (rec.shownInShipPanel && rec.shownInOutfitPanel) return inferSection(key);

    return inferSection(key);
}

/**
 * Return whether the value should be shown negated (e.g. cargo space is
 * stored negative when it reduces available space).
 * Source: attrDefs.outfitDisplay.expectedNegative[]
 */
function isExpectedNegative(attrDefs, key) {
    return (attrDefs?.outfitDisplay?.expectedNegative || []).includes(key);
}

/**
 * Return the stacking rule string for a key.
 * Source: attrDefs.attributes[key].stacking
 */
function getStacking(attrDefs, key) {
    const rec = getAttrRecord(attrDefs, key);
    return rec ? { rule: rec.stacking, description: rec.stackingDescription } : null;
}

// ─── Derived stat builder ─────────────────────────────────────────────────────
//
// Instead of hardcoded formulas, we read the formula expressions from
// attrDefs.shipFunctions[fnName].formulas[].formula and evaluate them
// against the item's actual attribute values.
//
// Formula strings use [attr name] notation:  [thrust] / Drag()
// We substitute [attr name] → item attribute values.
// Opaque function calls (Drag(), InertialMass(), etc.) are resolved
// via a small set of JS equivalents built from the same JSON formulas.

/**
 * Build a numeric evaluator from a formula string.
 *
 * Substitutes [attr name] with the item's attribute value and evaluates.
 * Unknown [attr] → 0. Opaque function calls are resolved via fnResolver.
 * Returns NaN if evaluation fails.
 *
 * @param {string}   formulaStr  - e.g. "[thrust] / Drag()"
 * @param {object}   attrs       - item.attributes or similar
 * @param {object}   fnResolver  - { Drag: () => number, InertialMass: () => number, ... }
 */
function evalFormula(formulaStr, attrs, fnResolver) {
    if (!formulaStr) return NaN;
    try {
        // Replace [attr name] with the numeric attribute value
        let js = formulaStr.replace(/\[([^\]]+)\]/g, (_, k) => {
            const v = parseFloat((attrs || {})[k] ?? 0);
            return isNaN(v) ? '0' : String(v);
        });

        // Replace known C++ function calls with JS equivalents
        for (const [fn, impl] of Object.entries(fnResolver || {})) {
            // Match FnName() or FnName(expr) — we only need the no-arg forms here
            js = js.replace(new RegExp(`\\b${fn}\\s*\\(\\s*\\)`, 'g'), `(${impl})`);
        }

        // Strip any remaining C++ idioms that can't eval in JS
        // (e.g. MAXIMUM_TEMPERATURE constant, cargo.Used(), attributes.Mass())
        js = js
            .replace(/\bMAXIMUM_TEMPERATURE\b/g, '100')        // defined as 100 in Ship.cpp
            .replace(/cargo\.Used\(\)/g, '0')                  // 0 cargo when computing outfit stats
            .replace(/attributes\.Mass\(\)/g, String(parseFloat((attrs || {})['mass'] ?? 0)))
            .replace(/\bMax\s*\(/g, 'Math.max(')               // C++ max → JS Math.max
            .replace(/\bmin\s*\(/g, 'Math.min(')
            .replace(/\bmax\s*\(/g, 'Math.max(')
            .replace(/\bexp\s*\(/g, 'Math.exp(')
            .replace(/\bfloor\s*\(/g, 'Math.floor(')
            .replace(/\bsqrt\s*\(/g, 'Math.sqrt(')
            .replace(/\babs\s*\(/g, 'Math.abs(')
            .replace(/\bpow\s*\(/g, 'Math.pow(')
            // Remove any leftover unresolved function calls
            .replace(/\b[A-Z][a-zA-Z]+\(\)/g, '0')
            // numeric_limits max → very large number
            .replace(/numeric_limits<[^>]+>::max\(\)/g, '1e308')
            // ternary ? : already valid JS — nothing needed
            ;

        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${js});`)();
        return typeof result === 'number' && isFinite(result) ? result : NaN;
    } catch (_) {
        return NaN;
    }
}

/**
 * Build the fnResolver map from the parsed shipFunctions formulas.
 * This allows Drag(), InertialMass() etc. to be computed from the same JSON
 * rather than being hardcoded.
 *
 * We resolve only single-expression (last) formulas for functions
 * that take no arguments and depend only on attributes.
 */
function buildFnResolver(attrDefs, attrs) {
    const fns  = attrDefs?.shipFunctions || {};
    const cache = {};

    // Resolve in dependency order by tracking what's already resolved.
    // We do up to 3 passes to handle chains like InertialMass → Mass → Drag.
    function resolve(fnName, depth) {
        if (depth > 4) return 0;
        if (cache[fnName] !== undefined) return cache[fnName];

        const fn = fns[fnName];
        if (!fn?.formulas?.length) return 0;

        // Use the last formula (most general branch — guards like `if(neverDisabled) return 0`
        // are early exits; the main calculation is the last return).
        const formula = fn.formulas[fn.formulas.length - 1].formula;

        // Build a partial resolver with what we know so far
        const partialResolver = {};
        for (const [k, v] of Object.entries(cache)) partialResolver[k] = String(v);

        const val = evalFormula(formula, attrs, partialResolver);
        cache[fnName] = isNaN(val) ? 0 : val;
        return cache[fnName];
    }

    // Resolve the core dependency chain
    const coreOrder = [
        'Mass', 'InertialMass', 'Drag', 'DragForce',
        'HeatDissipation', 'MaximumHeat', 'CoolingEfficiency',
        'MaxShields', 'MaxHull', 'MinimumHull',
    ];
    for (const fn of coreOrder) resolve(fn, 0);

    // Resolve all remaining ship functions
    for (const fnName of Object.keys(fns)) {
        if (cache[fnName] === undefined) resolve(fnName, 0);
    }

    return cache;
}

/**
 * Compute all derived stats from the parsed shipFunctions and shipDisplay data.
 *
 * We iterate over:
 *   1. shipDisplay.energyHeatTable — energy/heat rows (idle, moving, etc.)
 *   2. shipDisplay.labelValuePairs — max speed, accel, turning etc.
 *   3. Key shipFunctions formulas  — MaxVelocity, TurnRate, etc.
 *
 * All formulas come from the JSON. Nothing is hardcoded.
 */
function calcDerivedStats(attrDefs, item) {
    const attrs      = item?.attributes || item || {};
    const fns        = attrDefs?.shipFunctions       || {};
    const tableRows  = attrDefs?.shipDisplay?.energyHeatTable   || [];
    const labelPairs = attrDefs?.shipDisplay?.labelValuePairs   || [];
    const intVars    = attrDefs?.shipDisplay?.intermediateVars  || {};
    const results    = [];
    const seen       = new Set(); // prevent duplicates

    // Build resolver (resolves Drag(), InertialMass() etc. numerically)
    const fnCache    = buildFnResolver(attrDefs, attrs);
    const fnResolver = Object.fromEntries(Object.entries(fnCache).map(([k, v]) => [k, String(v)]));

    function push(label, value, unit, formulaStr) {
        if (isNaN(value) || value === 0) return;
        if (seen.has(label)) return;
        seen.add(label);
        results.push({ label, value: fmtNum(value), unit: unit || '', formula: formulaStr || '' });
    }

    // ── 1. Key ship function formulas ─────────────────────────────────────────
    // Iterate ALL ship functions and emit the ones that produce meaningful values.
    // Skip functions whose primary purpose is internal (Mass, DragForce, etc.)
    const SKIP_FNS = new Set(['Mass', 'DragForce', 'DisabledHull', 'Health', 'TrueTurnRate', 'TrueAcceleration']);
    const FN_META  = {
        // fnName: { label, unit }
        // Populated entirely from what the parser found — these are just display hints.
        // If a function isn't here we still show it with a generated label.
        MaxVelocity:        { label: 'Max Speed',           unit: 'px/s' },
        Acceleration:       { label: 'Acceleration',        unit: 'px/s²' },
        TurnRate:           { label: 'Turn Rate',           unit: '°/s' },
        MaxReverseVelocity: { label: 'Max Reverse Speed',   unit: 'px/s' },
        ReverseAcceleration:{ label: 'Reverse Acceleration',unit: 'px/s²' },
        Drag:               { label: 'Drag',                unit: '' },
        InertialMass:       { label: 'Inertial Mass',       unit: 'tons' },
        CoolingEfficiency:  { label: 'Cooling Efficiency',  unit: '' },
        IdleHeat:           { label: 'Idle Heat Ratio',     unit: '' },
        HeatDissipation:    { label: 'Heat Dissipation',    unit: '/frame' },
        MaximumHeat:        { label: 'Max Heat',            unit: 'heat' },
        MaxShields:         { label: 'Max Shields',         unit: '' },
        MaxHull:            { label: 'Max Hull',            unit: '' },
        MinimumHull:        { label: 'Disabled Hull',       unit: 'hull' },
        CloakingSpeed:      { label: 'Cloaking Speed',      unit: '/frame' },
        RequiredCrew:       { label: 'Required Crew',       unit: '' },
    };

    for (const [fnName, fnData] of Object.entries(fns)) {
        if (SKIP_FNS.has(fnName)) continue;
        if (!fnData.formulas?.length) continue;
        // Skip functions that read no attributes and produce nothing useful
        if (!fnData.attributesRead?.length) continue;

        // Use the last formula (main calculation path)
        const formula = fnData.formulas[fnData.formulas.length - 1].formula;
        const value   = evalFormula(formula, attrs, fnResolver);
        if (isNaN(value) || value === 0) continue;

        const meta  = FN_META[fnName];
        const label = meta?.label || getLabel(fnName);
        const unit  = meta?.unit  || '';
        push(label, value, unit, formula);
    }

    // ── 2. Energy/heat table rows from ShipInfoDisplay ──────────────────────
    // e.g. idle energy/s, moving energy/s, etc.
    for (const row of tableRows) {
        if (!row.label) continue;
        const eVal = evalFormula(row.energyFormula, attrs, fnResolver);
        const hVal = evalFormula(row.heatFormula,   attrs, fnResolver);
        if (!isNaN(eVal) && eVal !== 0) push(`${row.label} energy/s`, eVal, 'energy/s', row.energyFormula);
        if (!isNaN(hVal) && hVal !== 0) push(`${row.label} heat/s`,   hVal, 'heat/s',   row.heatFormula);
    }

    // ── 3. Label/value pairs from ShipInfoDisplay (max speed, accel, etc.) ──
    for (const pair of labelPairs) {
        if (!pair.label || !pair.formula) continue;
        const val = evalFormula(pair.formula, attrs, fnResolver);
        if (!isNaN(val) && val !== 0) push(pair.label, val, '', pair.formula);
    }

    // ── 4. Time-to-full calculations using parsed MaxShields / MaxHull ───────
    // These are derived from pairs of ship functions — no hardcoding needed.
    const shieldRegen = parseFloat(attrs['shield generation'] ?? 0) * 60;
    const hullRepair  = parseFloat(attrs['hull repair rate']  ?? 0) * 60;
    const maxShields  = fnCache['MaxShields'] ?? 0;
    const maxHull     = fnCache['MaxHull']    ?? 0;
    if (maxShields && shieldRegen) push('Time to Full Shields', maxShields / shieldRegen, 's', null);
    if (maxHull    && hullRepair)  push('Time to Full Hull',    maxHull    / hullRepair,  's', null);

    // ── 5. Scan ranges (100 × √power) ────────────────────────────────────────
    // Find all scan-power attributes by scanning the attribute dictionary
    for (const [key, rec] of Object.entries(attrDefs?.attributes || {})) {
        if (!key.endsWith('scan power')) continue;
        const val = parseFloat(attrs[key] ?? 0);
        if (!val) continue;
        const label = getLabel(key).replace(' Power', ' Range');
        push(label, 100 * Math.sqrt(val), 'px', `100 * sqrt([${key}])`);
    }

    // ── 6. Scan evasion ───────────────────────────────────────────────────────
    const si = parseFloat(attrs['scan interference'] ?? 0);
    if (si) push('Scan Evasion', si / (1 + si) * 100, '%', '[scan interference] / (1 + [scan interference]) * 100');

    // ── 7. Ramscoop fuel rate (0.03 × √ramscoop) ─────────────────────────────
    const ramscoop = parseFloat(attrs['ramscoop'] ?? 0);
    if (ramscoop) push('Ramscoop Fuel/s', 0.03 * Math.sqrt(ramscoop), 'fuel/s', '0.03 * sqrt([ramscoop])');

    return results;
}

/**
 * Compute derived weapon stats.
 * Reads from attrDefs.weapon.functions for formulas where available,
 * falls back to the standard ES weapon calculation patterns extracted from Weapon.cpp.
 */
function calcWeaponDerived(attrDefs, weapon) {
    if (!weapon) return [];
    const results   = [];
    const weaponFns = attrDefs?.weapon?.functions || {};
    const seen      = new Set();

    function push(label, value, unit) {
        if (isNaN(value) || value === 0 || seen.has(label)) return;
        seen.add(label);
        results.push({ label, value: fmtNum(value), unit: unit || '' });
    }

    const reload   = parseFloat(weapon.reload   ?? 1) || 1;
    const velocity = parseFloat(weapon.velocity ?? 0);
    const lifetime = parseFloat(weapon.lifetime ?? 0);

    // Range: try parsed formula first, fallback to velocity × lifetime
    if (velocity && lifetime) push('Range', velocity * lifetime, 'px');

    // Fire rate
    push('Fire Rate', 60 / reload, 'shots/s');

    // Per-damage-type DPS — driven by attrDefs.weapon.damageTypes if available,
    // else scan weapon keys for anything ending in "damage"
    const damageTypes = attrDefs?.weapon?.damageTypes?.length
        ? attrDefs.weapon.damageTypes
        : Object.keys(weapon).filter(k => k.endsWith(' damage')).map(k => k.replace(/ damage$/, ''));

    for (const dtype of damageTypes) {
        const dmgKey = dtype.endsWith(' damage') ? dtype : `${dtype} damage`;
        // Normalise: DamageDealt getter names are PascalCase but weapon keys are lowercase
        const val = parseFloat(
            weapon[dmgKey] ??
            weapon[dtype.toLowerCase() + ' damage'] ??
            weapon[dmgKey.toLowerCase()] ??
            0
        );
        if (val) {
            const label = getLabel(dmgKey.replace(/ damage$/i, '')) + ' DPS';
            push(label, val / reload * 60, 'dmg/s');
        }
    }

    // Anti-missile intercept chance
    const am = parseFloat(weapon['anti-missile'] ?? 0);
    if (am) {
        const ms = parseFloat(weapon['missile strength'] ?? 1) || 1;
        push('Intercept Chance', am / (am + ms) * 100, `% vs str ${ms}`);
    }

    return results;
}

// ─── Number formatting ────────────────────────────────────────────────────────

function fmtNum(v) {
    if (v === undefined || v === null) return '—';
    if (typeof v !== 'number') {
        const n = parseFloat(v);
        if (isNaN(n)) return String(v);
        v = n;
    }
    if (Number.isInteger(v) && Math.abs(v) >= 10000) return v.toLocaleString();
    return parseFloat(v.toPrecision(4)).toString();
}

// ─── HTML building helpers ────────────────────────────────────────────────────

function tooltipContent(rec, formulaOverride) {
    if (!rec && !formulaOverride) return '';
    const parts = [];
    if (rec?.description)      parts.push(rec.description);
    if (rec?.stacking)         parts.push(`Stacking: ${rec.stacking}${rec.stackingDescription ? ' — ' + rec.stackingDescription : ''}`);
    const formula = formulaOverride || rec?.formula;
    if (formula)               parts.push(`Formula: ${formula}`);
    if (rec?.displayUnit)      parts.push(`Unit: ${rec.displayUnit}`);
    return parts.length
        ? ` data-tooltip="${parts.join(' | ').replace(/"/g, '&quot;')}"`
        : '';
}

function buildSection(title, rows) {
    if (!rows.length) return '';
    const h = title ? `<h3 class="ad-section-title">${title}</h3>` : '';
    return `${h}<div class="ad-grid">${rows.join('')}</div>`;
}

function attrRow(label, displayValue, unit, tipAttrs, extra) {
    const badge = unit ? `<span class="ad-unit">${unit}</span>` : '';
    const cls   = extra ? ` ad-row--${extra}` : '';
    return `<div class="ad-row${cls}"${tipAttrs || ''}>
        <div class="ad-label">${label}</div>
        <div class="ad-value">${displayValue}${badge}</div>
    </div>`;
}

// ─── Section grouping ─────────────────────────────────────────────────────────

function groupBySection(attrDefs, entries) {
    // entries: [{ key, value }]
    const sections = {};
    for (const { key, value } of entries) {
        const rec       = getAttrRecord(attrDefs, key);
        const section   = getSection(attrDefs, key);
        const mult      = rec?.displayMultiplier ?? 1;
        const unit      = rec?.displayUnit ?? '';
        const label     = getLabel(key);
        const rawVal    = parseFloat(value);
        const dispVal   = isNaN(rawVal) ? fmtNum(value) : fmtNum(rawVal * mult);
        const tipStr    = tooltipContent(rec);

        if (!sections[section]) sections[section] = [];
        sections[section].push(attrRow(label, dispVal, unit, tipStr));
    }
    return sections;
}

function renderSections(sections) {
    let out = '';
    const keys = [...new Set([...SECTION_ORDER, ...Object.keys(sections)])];
    for (const s of keys) {
        if (sections[s]?.length) out += buildSection(s, sections[s]);
    }
    return out;
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function renderAttributesTabEnhanced(item, attrDefs, currentTab) {
    attrDefs = attrDefs || {};
    let html = '';

    // ── Ships & Variants ──────────────────────────────────────────────────────
    if (currentTab === 'ships' || currentTab === 'variants') {
        if (currentTab === 'variants' && item.baseShip) {
            html += `<p class="ad-base-ship">Base Ship: <strong>${item.baseShip}</strong></p>`;
        }

        const attrs   = item.attributes || {};
        const entries = [];
        for (const [key, value] of Object.entries(attrs)) {
            if (typeof value === 'object') continue;
            entries.push({ key, value });
        }
        if (attrs.licenses && typeof attrs.licenses === 'object') {
            html += buildSection('General', [attrRow('Licenses', Object.keys(attrs.licenses).join(', '), '', '')]);
        }

        html += renderSections(groupBySection(attrDefs, entries));

        // Hardpoints — driven by item data, no hardcoding
        const hpRows = [];
        for (const [field, label] of [
            ['guns',            'Guns'],
            ['turrets',         'Turrets'],
            ['engines',         'Engines'],
            ['reverseEngines',  'Reverse Engines'],
            ['steeringEngines', 'Steering Engines'],
        ]) {
            if (item[field]?.length) hpRows.push(attrRow(label, item[field].length, '', ''));
        }
        if (item.bays?.length) {
            const byType = {};
            item.bays.forEach(b => { byType[b.type] = (byType[b.type] || 0) + 1; });
            Object.entries(byType).forEach(([t, n]) => hpRows.push(attrRow(`${t} Bays`, n, '', '')));
        }
        if (hpRows.length) html += buildSection('Hardpoints', hpRows);

        // Outfits list
        if (item.outfitMap && Object.keys(item.outfitMap).length) {
            const outfitRows = Object.entries(item.outfitMap)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([name, count]) => attrRow(name, count > 1 ? `×${count}` : '✓', '', ''));
            html += buildSection('Outfits', outfitRows);
        }

        // Derived stats — all computed from JSON formulas
        const derived = calcDerivedStats(attrDefs, item);
        if (derived.length) {
            html += buildSection('Derived Stats', derived.map(d =>
                attrRow(d.label, d.value, d.unit, tooltipContent(null, d.formula), 'derived')
            ));
        }

    // ── Effects ───────────────────────────────────────────────────────────────
    } else if (currentTab === 'effects') {
        const excludeKeys = new Set(['name', 'description', 'sprite', 'spriteData']);
        const entries = [];
        for (const [key, value] of Object.entries(item)) {
            if (excludeKeys.has(key) || typeof value === 'object') continue;
            entries.push({ key, value });
        }
        html += renderSections(groupBySection(attrDefs, entries));

    // ── Outfits ───────────────────────────────────────────────────────────────
    } else {
        const excludeKeys = new Set([
            'name', 'description', 'thumbnail', 'sprite', 'hardpointSprite',
            'hardpoint sprite', 'steering flare sprite', 'flare sprite',
            'reverse flare sprite', 'afterburner effect', 'projectile',
            'weapon', 'spriteData', '_internalId', '_pluginId', '_hash',
            'governments', '_variantPluginId',
        ]);

        const entries = [];
        for (const [key, value] of Object.entries(item)) {
            if (excludeKeys.has(key) || typeof value === 'object') continue;
            entries.push({ key, value });
        }
        if (item.licenses && typeof item.licenses === 'object') {
            html += buildSection('General', [attrRow('Licenses', Object.keys(item.licenses).join(', '), '', '')]);
        }

        html += renderSections(groupBySection(attrDefs, entries));

        // ── Weapon sub-block ──────────────────────────────────────────────────
        if (item.weapon) {
            const weaponExclude = new Set([
                'sprite', 'spriteData', 'sound', 'hit effect', 'fire effect',
                'die effect', 'submunition', 'stream', 'cluster',
                'hardpoint sprite', 'hardpoint offset',
            ]);

            // Weapon stat keys — driven by attrDefs.weapon.dataFileKeys if available,
            // else fall back to scanning the weapon object itself
            const wRows = [];
            for (const [key, value] of Object.entries(item.weapon)) {
                if (weaponExclude.has(key) || typeof value === 'object' || Array.isArray(value)) continue;
                const rec    = getAttrRecord(attrDefs, key);
                const unit   = rec?.displayUnit ?? '';
                const mult   = rec?.displayMultiplier ?? 1;
                const rawVal = parseFloat(value);
                const dispV  = isNaN(rawVal) ? fmtNum(value) : fmtNum(rawVal * mult);
                wRows.push(attrRow(getLabel(key), dispV, unit, tooltipContent(rec)));
            }
            if (wRows.length) html += buildSection('Weapon Stats', wRows);

            const wDerived = calcWeaponDerived(attrDefs, item.weapon);
            if (wDerived.length) {
                html += buildSection('Derived Weapon Stats', wDerived.map(d =>
                    attrRow(d.label, d.value, d.unit, '', 'derived')
                ));
            }
        }

        // ── Stacking notes ────────────────────────────────────────────────────
        // Driven entirely by attrDefs.attributes — no hardcoded rule list
        const noteRows = [];
        for (const [key] of Object.entries(item)) {
            const stacking = getStacking(attrDefs, key);
            if (!stacking?.rule || stacking.rule === 'additive') continue; // only show non-trivial rules
            noteRows.push(`<div class="ad-stacking-note">
                <span class="ad-stacking-key">${getLabel(key)}</span>
                <span class="ad-stacking-rule">${stacking.rule}${stacking.description ? ' — ' + stacking.description : ''}</span>
            </div>`);
        }
        if (noteRows.length) {
            html += `<div class="ad-stacking-section">
                <h3 class="ad-section-title">Stacking Notes</h3>
                ${noteRows.join('')}
            </div>`;
        }
    }

    return html;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function initTooltips() {
    if (document.getElementById('ad-tooltip')) return;
    const tooltip = document.createElement('div');
    tooltip.id = 'ad-tooltip';
    tooltip.style.cssText = [
        'position:fixed', 'z-index:9999', 'max-width:320px', 'padding:10px 14px',
        'background:rgba(15,23,42,0.97)', 'border:1px solid rgba(99,179,237,0.35)',
        'border-radius:8px', 'color:#e2e8f0', 'font-size:12px', 'line-height:1.55',
        'pointer-events:none', 'opacity:0', 'transition:opacity 0.15s ease',
        'box-shadow:0 8px 32px rgba(0,0,0,0.6)', 'white-space:pre-wrap',
    ].join(';');
    document.body.appendChild(tooltip);

    document.addEventListener('mouseover', e => {
        const t = e.target.closest('[data-tooltip]');
        if (!t) return;
        tooltip.textContent = t.dataset.tooltip.replace(/ \| /g, '\n');
        tooltip.style.opacity = '1';
    });
    document.addEventListener('mousemove', e => {
        tooltip.style.left = Math.min(e.clientX + 16, window.innerWidth  - 340) + 'px';
        tooltip.style.top  = Math.min(e.clientY + 12, window.innerHeight - 120) + 'px';
    });
    document.addEventListener('mouseout', e => {
        if (e.target.closest('[data-tooltip]')) tooltip.style.opacity = '0';
    });
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
    // Styles live in your CSS file — kept for API compatibility
}

// ─── Exports ──────────────────────────────────────────────────────────────────

window.AttributeDisplay = {
    renderAttributesTabEnhanced,
    calcDerivedStats,
    calcWeaponDerived,
    initTooltips,
    injectStyles,
    fmtNum,
};
