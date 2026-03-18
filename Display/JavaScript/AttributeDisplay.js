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

const SECTION_ORDER = [
    'General', 'Shields & Hull', 'Energy', 'Engines', 'Jump',
    'Cargo', 'Crew', 'Scanning', 'Cloaking', 'Resistance', 'Protection',
    'Weapon Stats', 'Derived Stats', 'Other',
];

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

function getAttrRecord(attrDefs, key) {
    const attrs = attrDefs?.attributes || {};
    return attrs[key] || attrs[key?.toLowerCase()] || null;
}

function getDisplayMultiplier(attrDefs, key) {
    return getAttrRecord(attrDefs, key)?.displayMultiplier ?? 1;
}

function getDisplayUnit(attrDefs, key) {
    return getAttrRecord(attrDefs, key)?.displayUnit ?? '';
}

function getLabel(key) {
    return key
        .split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

function getSection(attrDefs, key) {
    const rec = getAttrRecord(attrDefs, key);
    if (!rec) return inferSection(key);

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

function isExpectedNegative(attrDefs, key) {
    return (attrDefs?.outfitDisplay?.expectedNegative || []).includes(key);
}

function getStacking(attrDefs, key) {
    const rec = getAttrRecord(attrDefs, key);
    return rec ? { rule: rec.stacking, description: rec.stackingDescription } : null;
}

// ─── Derived stat builder ─────────────────────────────────────────────────────

function evalFormula(formulaStr, attrs, fnResolver) {
    if (!formulaStr) return NaN;
    try {
        let js = formulaStr.replace(/\[([^\]]+)\]/g, (_, k) => {
            const v = parseFloat((attrs || {})[k] ?? 0);
            return isNaN(v) ? '0' : String(v);
        });

        for (const [fn, impl] of Object.entries(fnResolver || {})) {
            js = js.replace(new RegExp(`\\b${fn}\\s*\\(\\s*\\)`, 'g'), `(${impl})`);
        }

        js = js
            .replace(/\bMAXIMUM_TEMPERATURE\b/g, '100')
            .replace(/cargo\.Used\(\)/g, '0')
            .replace(/attributes\.Mass\(\)/g, String(parseFloat((attrs || {})['mass'] ?? 0)))
            .replace(/\bMax\s*\(/g, 'Math.max(')
            .replace(/\bmin\s*\(/g, 'Math.min(')
            .replace(/\bmax\s*\(/g, 'Math.max(')
            .replace(/\bexp\s*\(/g, 'Math.exp(')
            .replace(/\bfloor\s*\(/g, 'Math.floor(')
            .replace(/\bsqrt\s*\(/g, 'Math.sqrt(')
            .replace(/\babs\s*\(/g, 'Math.abs(')
            .replace(/\bpow\s*\(/g, 'Math.pow(')
            .replace(/\b[A-Z][a-zA-Z]+\(\)/g, '0')
            .replace(/numeric_limits<[^>]+>::max\(\)/g, '1e308');

        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${js});`)();
        return typeof result === 'number' && isFinite(result) ? result : NaN;
    } catch (_) {
        return NaN;
    }
}

function buildFnResolver(attrDefs, attrs) {
    const fns   = attrDefs?.shipFunctions || {};
    const cache = {};

    function resolve(fnName, depth) {
        if (depth > 4) return 0;
        if (cache[fnName] !== undefined) return cache[fnName];

        const fn = fns[fnName];
        if (!fn?.formulas?.length) return 0;

        const formula = fn.formulas[fn.formulas.length - 1].formula;
        const partialResolver = {};
        for (const [k, v] of Object.entries(cache)) partialResolver[k] = String(v);

        const val = evalFormula(formula, attrs, partialResolver);
        cache[fnName] = isNaN(val) ? 0 : val;
        return cache[fnName];
    }

    const coreOrder = [
        'Mass', 'InertialMass', 'Drag', 'DragForce',
        'HeatDissipation', 'MaximumHeat', 'CoolingEfficiency',
        'MaxShields', 'MaxHull', 'MinimumHull',
    ];
    for (const fn of coreOrder) resolve(fn, 0);
    for (const fnName of Object.keys(fns)) {
        if (cache[fnName] === undefined) resolve(fnName, 0);
    }

    return cache;
}

/**
 * Convert a _derived_* or _fn_* computed stat key into a human-readable label.
 * Driven entirely by the key name — no hardcoded lookup table.
 */
function computedKeyToLabel(key) {
    // _fn_MaxShields      → "Max Shields"
    // _derived_shieldRegen → "Shield Regen"
    // _derived_energy_idle → "Idle Energy/s"
    // _derived_heat_idle   → "Idle Heat/s"
    let s = key;
    if (s.startsWith('_fn_'))             s = s.slice(4);
    else if (s.startsWith('_derived_energy_')) s = s.slice('_derived_energy_'.length) + ' Energy/s';
    else if (s.startsWith('_derived_heat_'))   s = s.slice('_derived_heat_'.length)   + ' Heat/s';
    else if (s.startsWith('_derived_'))        s = s.slice('_derived_'.length);
    else if (s.startsWith('_total'))           s = s.slice(1); // _totalOutfitCost → totalOutfitCost
    else if (s.startsWith('_'))                s = s.slice(1);

    // camelCase / PascalCase → Title Case with spaces
    return s
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^./, c => c.toUpperCase())
        .trim();
}

/**
 * calcDerivedStats — formula-driven derived values from shipFunctions JSON.
 * Now also merges in computed stats from ComputedStats.js (outfit-aware values).
 *
 * @param {object} attrDefs   — parsed attributeDefinitions.json
 * @param {object} item       — the ship/variant object
 * @param {string} pluginId   — current plugin ID (for getComputedStats lookup)
 */
function calcDerivedStats(attrDefs, item, pluginId) {
    const attrs      = item?.attributes || item || {};
    const fns        = attrDefs?.shipFunctions       || {};
    const tableRows  = attrDefs?.shipDisplay?.energyHeatTable   || [];
    const labelPairs = attrDefs?.shipDisplay?.labelValuePairs   || [];
    const results    = [];
    const seen       = new Set();

    const fnCache    = buildFnResolver(attrDefs, attrs);
    const fnResolver = Object.fromEntries(Object.entries(fnCache).map(([k, v]) => [k, String(v)]));

    function push(label, value, unit, formulaStr, isComputedOutfit) {
        if (isNaN(value) || value === 0) return;
        if (seen.has(label)) return;
        seen.add(label);
        results.push({
            label,
            value:          fmtNum(value),
            unit:           unit || '',
            formula:        formulaStr || '',
            isComputedOutfit: !!isComputedOutfit,
        });
    }

    // ── 1. Key ship function formulas ─────────────────────────────────────────
    const SKIP_FNS = new Set(['Mass', 'DragForce', 'DisabledHull', 'Health', 'TrueTurnRate', 'TrueAcceleration']);
    const FN_META  = {
        MaxVelocity:         { label: 'Max Speed',            unit: 'px/s'  },
        Acceleration:        { label: 'Acceleration',         unit: 'px/s²' },
        TurnRate:            { label: 'Turn Rate',            unit: '°/s'   },
        MaxReverseVelocity:  { label: 'Max Reverse Speed',    unit: 'px/s'  },
        ReverseAcceleration: { label: 'Reverse Acceleration', unit: 'px/s²' },
        Drag:                { label: 'Drag',                 unit: ''      },
        InertialMass:        { label: 'Inertial Mass',        unit: 'tons'  },
        CoolingEfficiency:   { label: 'Cooling Efficiency',   unit: ''      },
        IdleHeat:            { label: 'Idle Heat Ratio',      unit: ''      },
        HeatDissipation:     { label: 'Heat Dissipation',     unit: '/frame'},
        MaximumHeat:         { label: 'Max Heat',             unit: 'heat'  },
        MaxShields:          { label: 'Max Shields',          unit: ''      },
        MaxHull:             { label: 'Max Hull',             unit: ''      },
        MinimumHull:         { label: 'Disabled Hull',        unit: 'hull'  },
        CloakingSpeed:       { label: 'Cloaking Speed',       unit: '/frame'},
        RequiredCrew:        { label: 'Required Crew',        unit: ''      },
    };

    for (const [fnName, fnData] of Object.entries(fns)) {
        if (SKIP_FNS.has(fnName)) continue;
        if (!fnData.formulas?.length) continue;
        if (!fnData.attributesRead?.length) continue;

        const formula = fnData.formulas[fnData.formulas.length - 1].formula;
        const value   = evalFormula(formula, attrs, fnResolver);
        if (isNaN(value) || value === 0) continue;

        const meta  = FN_META[fnName];
        push(meta?.label || getLabel(fnName), value, meta?.unit || '', formula);
    }

    // ── 2. Energy/heat table rows ─────────────────────────────────────────────
    for (const row of tableRows) {
        if (!row.label) continue;
        const eVal = evalFormula(row.energyFormula, attrs, fnResolver);
        const hVal = evalFormula(row.heatFormula,   attrs, fnResolver);
        if (!isNaN(eVal) && eVal !== 0) push(`${row.label} energy/s`, eVal, 'energy/s', row.energyFormula);
        if (!isNaN(hVal) && hVal !== 0) push(`${row.label} heat/s`,   hVal, 'heat/s',   row.heatFormula);
    }

    // ── 3. Label/value pairs ──────────────────────────────────────────────────
    for (const pair of labelPairs) {
        if (!pair.label || !pair.formula) continue;
        const val = evalFormula(pair.formula, attrs, fnResolver);
        if (!isNaN(val) && val !== 0) push(pair.label, val, '', pair.formula);
    }

    // ── 4. Time-to-full ───────────────────────────────────────────────────────
    const shieldRegen = parseFloat(attrs['shield generation'] ?? 0) * 60;
    const hullRepair  = parseFloat(attrs['hull repair rate']  ?? 0) * 60;
    const maxShields  = fnCache['MaxShields'] ?? 0;
    const maxHull     = fnCache['MaxHull']    ?? 0;
    if (maxShields && shieldRegen) push('Time to Full Shields', maxShields / shieldRegen, 's');
    if (maxHull    && hullRepair)  push('Time to Full Hull',    maxHull    / hullRepair,  's');

    // ── 5. Scan ranges ────────────────────────────────────────────────────────
    for (const [key, rec] of Object.entries(attrDefs?.attributes || {})) {
        if (!key.endsWith('scan power')) continue;
        const val = parseFloat(attrs[key] ?? 0);
        if (!val) continue;
        push(getLabel(key).replace(' Power', ' Range'), 100 * Math.sqrt(val), 'px', `100 * sqrt([${key}])`);
    }

    // ── 6. Scan evasion ───────────────────────────────────────────────────────
    const si = parseFloat(attrs['scan interference'] ?? 0);
    if (si) push('Scan Evasion', si / (1 + si) * 100, '%');

    // ── 7. Ramscoop ───────────────────────────────────────────────────────────
    const ramscoop = parseFloat(attrs['ramscoop'] ?? 0);
    if (ramscoop) push('Ramscoop Fuel/s', 0.03 * Math.sqrt(ramscoop), 'fuel/s');

    // ── 8. Computed stats from ComputedStats.js (outfit-aware) ───────────────
    //
    // Iterates ALL keys in the computed result that start with _derived_ or _fn_
    // or are outfit summary keys (_totalOutfits, _totalOutfitCost, _outfitMass).
    // Labels are generated dynamically from the key name — no hardcoded table.
    if (pluginId && typeof getComputedStats === 'function') {
        const computed = getComputedStats(item, pluginId);

        for (const [statKey, val] of Object.entries(computed)) {
            // Only expose computed/derived keys, not raw attribute values
            // (raw attrs are already shown in the main attribute sections)
            const isComputedKey =
                statKey.startsWith('_derived_') ||
                statKey.startsWith('_fn_')      ||
                statKey.startsWith('_total')    ||
                statKey === '_outfitMass';

            if (!isComputedKey) continue;
            if (val == null || (typeof val === 'number' && (isNaN(val) || val === 0))) continue;

            const label = computedKeyToLabel(statKey);

            // If a base-only entry with the same label already exists, upgrade it
            if (seen.has(label)) {
                const existing = results.find(r => r.label === label);
                if (existing) {
                    existing.value            = fmtNum(val);
                    existing.isComputedOutfit = true;
                }
                continue;
            }

            seen.add(label);
            results.push({
                label,
                value:            fmtNum(val),
                unit:             '',   // units not in attrDefs for derived keys
                formula:          '',
                isComputedOutfit: true,
            });
        }
    }

    return results;
}

// ─── Weapon chain renderer ───────────────────────────────────────────────────
//
// Recursively follows ammo → submunition chains, rendering each level as its
// own section. Accumulates total damage across the full chain and shows a
// summary at the end.
//
// Chain lookup: ammo/submunition values are outfit names. We look them up in
// window.allData using the current pluginId (falling back to other plugins).

function lookupOutfit(name, pluginId) {
    const allData = window.allData || {};
    // Search current plugin first, then others
    const order = [pluginId, ...Object.keys(allData).filter(k => k !== pluginId)];
    for (const pid of order) {
        const outfit = (allData[pid]?.outfits || []).find(o => o.name === name);
        if (outfit) return outfit;
    }
    return null;
}

function renderWeaponStats(attrDefs, weapon, sectionTitle, outfitContext) {
    // outfitContext: the parent outfit object (for submunitions), so we can
    // show its description, cost, mass etc. alongside the weapon stats.
    const excludeWeapon = new Set([
        'sprite', 'spriteData', 'sound', 'hit effect', 'fire effect',
        'die effect', 'live effect', 'submunition', 'ammo', 'stream',
        'cluster', 'hardpoint sprite', 'hardpoint offset', 'icon',
    ]);
    const excludeOutfit = new Set([
        'name', 'weapon', 'sprite', 'spriteData', 'thumbnail',
        'description', 'flare sprite', 'steering flare sprite',
        'reverse flare sprite', 'afterburner effect',
    ]);

    let html = '';
    const wRows = [];

    // ── Outfit-level context (cost, mass, description) ────────────────────────
    if (outfitContext) {
        if (outfitContext.description) {
            wRows.push(`<div class="ad-description">${outfitContext.description}</div>`);
        }
        for (const [key, value] of Object.entries(outfitContext)) {
            if (excludeOutfit.has(key)) continue;
            if (typeof value === 'object' || Array.isArray(value)) continue;
            const rec    = getAttrRecord(attrDefs, key);
            const unit   = rec?.displayUnit ?? '';
            const mult   = rec?.displayMultiplier ?? 1;
            const rawVal = parseFloat(value);
            const dispV  = isNaN(rawVal) ? fmtNum(value) : fmtNum(rawVal * mult);
            wRows.push(attrRow(getLabel(key), dispV, unit, tooltipContent(rec)));
        }
    }

    // ── Weapon stats ──────────────────────────────────────────────────────────
    for (const [key, value] of Object.entries(weapon)) {
        if (excludeWeapon.has(key)) continue;

        // Arrays (e.g. multiple live effects) — show each entry
        if (Array.isArray(value)) {
            for (const v of value) {
                if (typeof v === 'object') continue;
                wRows.push(attrRow(getLabel(key), String(v), '', ''));
            }
            continue;
        }

        if (typeof value === 'object') continue;

        const rec    = getAttrRecord(attrDefs, key);
        const unit   = rec?.displayUnit ?? '';
        const mult   = rec?.displayMultiplier ?? 1;
        const rawVal = parseFloat(value);
        const dispV  = isNaN(rawVal) ? fmtNum(value) : fmtNum(rawVal * mult);
        wRows.push(attrRow(getLabel(key), dispV, unit, tooltipContent(rec)));
    }

    // ── Effect lists (hit effect, fire effect etc.) ───────────────────────────
    for (const effectKey of ['hit effect', 'fire effect', 'die effect', 'live effect']) {
        const val = weapon[effectKey];
        if (!val) continue;
        const entries = Array.isArray(val) ? val : [val];
        for (const e of entries) {
            if (typeof e === 'object') {
                // { name: "...", count: N }
                const label = `${getLabel(effectKey)}: ${e.name ?? e}`;
                const count = e.count ?? 1;
                wRows.push(attrRow(label, count > 1 ? String(count) : '✓', '', ''));
            } else if (typeof e === 'string') {
                wRows.push(attrRow(`${getLabel(effectKey)}: ${e}`, '✓', '', ''));
            } else if (typeof e === 'number') {
                wRows.push(attrRow(getLabel(effectKey), String(e), '', ''));
            }
        }
    }

    if (wRows.length) html += buildSection(sectionTitle, wRows);

    const wDerived = calcWeaponDerived(attrDefs, weapon);
    if (wDerived.length) {
        html += buildSection(`${sectionTitle} — Derived`, wDerived.map(d =>
            attrRow(d.label, d.value, d.unit, '', 'derived')
        ));
    }

    return html;
}

/**
 * Accumulate all damage values from a weapon object.
 * Returns { 'shield damage': n, 'hull damage': n, ... }
 */
function collectDamage(weapon, multiplier) {
    multiplier = multiplier ?? 1;
    const dmg = {};
    for (const [key, val] of Object.entries(weapon || {})) {
        if (typeof val !== 'number') continue;
        if (key.endsWith(' damage') || key === 'anti-missile' || key === 'blast radius') {
            dmg[key] = (dmg[key] || 0) + val * multiplier;
        }
    }
    return dmg;
}

function mergeInto(target, source) {
    for (const [k, v] of Object.entries(source)) {
        target[k] = (target[k] || 0) + v;
    }
}

/**
 * Recursively render weapon → ammo → submunition chain.
 * visited prevents infinite loops on circular references.
 */
function renderWeaponChain(attrDefs, weapon, pluginId) {
    if (!weapon) return '';

    let html = '';
    const totalDamage = {};
    const visited = new Set();

    // Each entry in the queue: { weapon, outfit, title, multiplier, depth }
    // outfit = the parent outfit object (null for the root weapon)
    const queue = [{ weapon, outfit: null, title: 'Weapon Stats', multiplier: 1, depth: 0 }];
    const sections = []; // collect in order for rendering

    while (queue.length > 0) {
        const { weapon: w, outfit: o, title, multiplier, depth } = queue.shift();

        // Render this weapon level
        sections.push({ weapon: w, outfit: o, title, multiplier });

        // Accumulate its damage into totals
        mergeInto(totalDamage, collectDamage(w, multiplier));

        // ── Follow submunition chain ──────────────────────────────────────────
        // After parser fix, submunition is always an array of { name, count }
        const sub = w.submunition;
        if (sub && depth < 8) {
            const entries = Array.isArray(sub)
                ? sub
                : [{ name: String(sub), count: 1 }];

            for (const entry of entries) {
                const subName  = entry?.name ?? String(entry);
                const subCount = entry?.count ?? 1;
                if (!subName || visited.has(subName)) continue;
                visited.add(subName);

                const subOutfit = lookupOutfit(subName, pluginId);
                if (subOutfit?.weapon) {
                    queue.push({
                        weapon:     subOutfit.weapon,
                        outfit:     subOutfit,
                        title:      `Submunition: ${subName}${subCount > 1 ? ` ×${subCount}` : ''}`,
                        multiplier: multiplier * subCount,
                        depth:      depth + 1,
                    });
                }
            }
        }

        // ── Follow ammo chain ─────────────────────────────────────────────────
        // ammo is a string outfit name — the ammo outfit may itself have a weapon
        const ammoVal = w.ammo;
        if (ammoVal && typeof ammoVal === 'string' && depth < 8) {
            if (!visited.has(ammoVal)) {
                visited.add(ammoVal);
                const ammoOutfit = lookupOutfit(ammoVal, pluginId);
                if (ammoOutfit?.weapon) {
                    queue.push({
                        weapon:     ammoOutfit.weapon,
                        outfit:     ammoOutfit,
                        title:      `Ammo: ${ammoVal}`,
                        multiplier: multiplier,
                        depth:      depth + 1,
                    });
                }
            }
        }
    }

    // ── Render all collected sections ─────────────────────────────────────────
    for (const { weapon: w, outfit: o, title } of sections) {
        html += renderWeaponStats(attrDefs, w, title, o);
    }

    // ── Total damage summary (only if there were sub-levels) ─────────────────
    if (sections.length > 1 && Object.keys(totalDamage).length > 0) {
        const totalRows = Object.entries(totalDamage)
            .filter(([, v]) => v !== 0)
            .map(([key, val]) => attrRow(getLabel(key), fmtNum(val), '', ''));
        if (totalRows.length) {
            html += buildSection('Total Damage (full chain)', totalRows);
        }
    }

    return html;
}

/**
 * Compute derived weapon stats.
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

    if (velocity && lifetime) push('Range', velocity * lifetime, 'px');
    push('Fire Rate', 60 / reload, 'shots/s');

    const damageTypes = attrDefs?.weapon?.damageTypes?.length
        ? attrDefs.weapon.damageTypes
        : Object.keys(weapon).filter(k => k.endsWith(' damage')).map(k => k.replace(/ damage$/, ''));

    for (const dtype of damageTypes) {
        const dmgKey = dtype.endsWith(' damage') ? dtype : `${dtype} damage`;
        const val = parseFloat(
            weapon[dmgKey] ??
            weapon[dtype.toLowerCase() + ' damage'] ??
            weapon[dmgKey.toLowerCase()] ??
            0
        );
        if (val) {
            push(getLabel(dmgKey.replace(/ damage$/i, '')) + ' DPS', val / reload * 60, 'dmg/s');
        }
    }

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

/**
 * @param {object} item        — ship, variant, outfit or effect object
 * @param {object} attrDefs    — parsed attributeDefinitions.json
 * @param {string} currentTab  — 'ships' | 'variants' | 'outfits' | 'effects'
 * @param {string} [pluginId]  — current plugin ID, used for computed stats lookup
 */
function renderAttributesTabEnhanced(item, attrDefs, currentTab, pluginId) {
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

        // Hardpoints
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

        // Derived stats — formula-driven + outfit-aware computed values
        // pluginId is passed through so getComputedStats() can resolve outfits
        const derived = calcDerivedStats(attrDefs, item, pluginId);
        if (derived.length) {
            // Split into two groups for clarity:
            //   1. Base-only derived (from formulas, no outfit contribution)
            //   2. Outfit-aware computed (marked with ⚡)
            const baseRows     = derived
                .filter(d => !d.isComputedOutfit)
                .map(d => attrRow(d.label, d.value, d.unit, tooltipContent(null, d.formula), 'derived'));

            const computedRows = derived
                .filter(d => d.isComputedOutfit)
                .map(d => {
                    const tip = d.formula
                        ? `Includes installed outfit contributions | Formula: ${d.formula}`
                        : 'Includes installed outfit contributions';
                    return attrRow(`⚡ ${d.label}`, d.value, d.unit, tooltipContent(null, tip), 'derived');
                });

            if (baseRows.length)     html += buildSection('Derived Stats', baseRows);
            if (computedRows.length) html += buildSection('Derived Stats (with Outfits)', computedRows);
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

        // Weapon sub-block — including ammo and submunition chains
        if (item.weapon) {
            html += renderWeaponChain(attrDefs, item.weapon, pluginId);
        }

        // Stacking notes
        const noteRows = [];
        for (const [key] of Object.entries(item)) {
            const stacking = getStacking(attrDefs, key);
            if (!stacking?.rule || stacking.rule === 'additive') continue;
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

// ─── Styles ───────────────────────────────────────────────----------------------------------------------------------------────

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