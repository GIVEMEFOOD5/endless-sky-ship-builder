'use strict';

// ─── AttributeDisplay.js ─────────────────────────────────────────────────────
// Pure renderer. Plugin_Script.js owns loading attributeDefinitions.json.

// ─── Section assignment ───────────────────────────────────────────────────────

const SECTION_ORDER = [
    'General', 'Shields & Hull', 'Energy', 'Engines', 'Jump',
    'Cargo', 'Crew', 'Scanning', 'Cloaking', 'Resistance', 'Protection',
    'Weapon Stats', 'Derived Stats', 'Other',
];

const SECTION_PATTERNS = [
    [/^(shields?|hull|shield generation|hull repair|shield energy|hull energy|shield heat|hull heat|shield fuel|hull fuel|shield delay|depleted|repair delay|disabled repair|threshold|absolute threshold|hull multiplier|shield multiplier)/, 'Shields & Hull'],
    [/^(energy|solar|fuel|cooling|ramscoop|heat generation|heat capacity|heat dissipation)/, 'Energy'],
    [/^(thrust|turn|reverse|afterburner|engine)/, 'Engines'],
    [/^(jump|hyperdrive|scram|warp)/, 'Jump'],
    [/^(cargo|outfit space|weapon capacity|drone|fighter|mass reduction)/, 'Cargo'],
    [/^(required crew|bunks|crew equivalent|extra mass)/, 'Crew'],
    [/^(cargo scan|outfit scan|tactical scan|asteroid scan|scan interference)/, 'Scanning'],
    [/^(cloak)/, 'Cloaking'],
    [/resistance$/, 'Resistance'],
    [/protection$|damage reduction/, 'Protection'],
    [/^(drag|mass|cost|category|automaton|capture|nanobot|gaslining|atmosphere|spinal|remnant)/, 'General'],
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

function getLabel(key) {
    return key.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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
    return inferSection(key);
}

function getStacking(attrDefs, key) {
    const rec = getAttrRecord(attrDefs, key);
    return rec ? { rule: rec.stacking, description: rec.stackingDescription } : null;
}

// ─── Formula evaluator (display-side) ────────────────────────────────────────

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
        const massVal = String(parseFloat((attrs || {})['mass'] ?? 0));
        js = js
            .replace(/\bMAXIMUM_TEMPERATURE\b/g, '100')
            .replace(/cargo\.Used\(\)/g, '0')
            .replace(/attributes\.Mass\(\)/g, massVal)
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
        const partialResolver = Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, String(v)]));
        let val = evalFormula(formula, attrs, partialResolver);

        // Guard: CoolingEfficiency must be 0–2
        if (fnName === 'CoolingEfficiency' && (isNaN(val) || val < 0 || val > 2)) {
            const x = parseFloat((attrs || {})['cooling inefficiency'] ?? 0);
            val = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));
        }

        cache[fnName] = isNaN(val) ? 0 : val;
        return cache[fnName];
    }

    // FIX 3: Mass first so CloakingSpeed resolves correctly
    const coreOrder = [
        'Mass', 'Drag', 'DragForce', 'InertialMass',
        'HeatDissipation', 'MaximumHeat', 'CoolingEfficiency',
        'MaxShields', 'MaxHull', 'MinimumHull',
        'CloakingSpeed',
    ];
    for (const fn of coreOrder) resolve(fn, 0);
    for (const fnName of Object.keys(fns)) {
        if (cache[fnName] === undefined) resolve(fnName, 0);
    }
    return cache;
}

function computedKeyToLabel(key) {
    let s = key;
    if (s.startsWith('_fn_'))                  s = s.slice(4);
    else if (s.startsWith('_derived_energy_')) s = s.slice('_derived_energy_'.length) + ' Energy/s';
    else if (s.startsWith('_derived_heat_'))   s = s.slice('_derived_heat_'.length)   + ' Heat/s';
    else if (s.startsWith('_derived_'))        s = s.slice('_derived_'.length);
    else if (s.startsWith('_total'))           s = s.slice(1);
    else if (s.startsWith('_'))                s = s.slice(1);
    return s.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase()).trim();
}

// ─── Functions to skip displaying — data-driven ───────────────────────────────
// These are internal Ship:: helpers that return non-numeric or non-useful values.
// Detected from returnType extracted by the parser — no hardcoded name list.

function shouldSkipFn(fnName, fnData) {
    const retType = (fnData.returnType || '').trim();
    // Skip void, bool, string, pointer returns
    if (/^(bool|void|string|.*\*|.*&)/.test(retType)) return true;
    // Skip functions with no attribute reads (pure state accessors)
    if (!fnData.attributesRead?.length) return true;
    // Skip functions with no formula
    if (!fnData.formulas?.length) return true;
    return false;
}

// ─── calcDerivedStats — FIX 1 & 2 revised ────────────────────────────────────
// Reads displayScale/displayUnit/labelPrefix from JSON (written by parser).
// No hardcoded FN_META. No hardcoded SKIP_FNS.

function calcDerivedStats(attrDefs, item, pluginId) {
    const attrs      = item?.attributes || item || {};
    const fns        = attrDefs?.shipFunctions       || {};
    const tableRows  = attrDefs?.shipDisplay?.energyHeatTable   || [];
    const labelPairs = attrDefs?.shipDisplay?.labelValuePairs   || [];
    const results    = [];
    const seen       = new Set();

    const fnCache    = buildFnResolver(attrDefs, attrs);
    const fnResolver = Object.fromEntries(Object.entries(fnCache).map(([k, v]) => [k, String(v)]));

    function push(label, rawValue, displayScale, unit, formulaStr, isComputedOutfit) {
        const scale = (typeof displayScale === 'number' && displayScale > 0) ? displayScale : 1;
        const value = rawValue * scale;
        if (isNaN(value) || value === 0) return;
        if (seen.has(label)) return;
        seen.add(label);
        results.push({ label, value: fmtNum(value), unit: unit || '', formula: formulaStr || '', isComputedOutfit: !!isComputedOutfit });
    }

    // ── 1. Ship function formulas — data-driven ───────────────────────────────
    for (const [fnName, fnData] of Object.entries(fns)) {
        if (shouldSkipFn(fnName, fnData)) continue;

        const formula = fnData.formulas[fnData.formulas.length - 1].formula;
        const rawVal  = evalFormula(formula, attrs, fnResolver);
        if (isNaN(rawVal) || rawVal === 0) continue;

        const scale  = fnData.displayScale  ?? 1;
        const unit   = fnData.displayUnit   ?? '';
        const prefix = fnData.labelPrefix   ?? '';

        const baseLabel = fnName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
        push(prefix + baseLabel, rawVal, scale, unit, formula);
    }

    // ── 2. Energy/heat table rows ─────────────────────────────────────────────
    for (const row of tableRows) {
        if (!row.label) continue;
        const eVal = evalFormula(row.energyFormula, attrs, fnResolver);
        const hVal = evalFormula(row.heatFormula,   attrs, fnResolver);
        if (!isNaN(eVal) && eVal !== 0) push(`${row.label} energy/s`, eVal, 1, 'energy/s', row.energyFormula);
        if (!isNaN(hVal) && hVal !== 0) push(`${row.label} heat/s`,   hVal, 1, 'heat/s',   row.heatFormula);
    }

    // ── 3. Label/value pairs from ShipInfoDisplay ─────────────────────────────
    for (const pair of labelPairs) {
        if (!pair.label || !pair.formula) continue;
        const val = evalFormula(pair.formula, attrs, fnResolver);
        if (!isNaN(val) && val !== 0) push(pair.label, val, 1, '', pair.formula);
    }

    // ── 4. Time-to-full ───────────────────────────────────────────────────────
    const shieldRegen = parseFloat(attrs['shield generation'] ?? 0) * 60;
    const hullRepair  = parseFloat(attrs['hull repair rate']  ?? 0) * 60;
    const maxShields  = fnCache['MaxShields'] ?? 0;
    const maxHull     = fnCache['MaxHull']    ?? 0;
    if (maxShields && shieldRegen) push('Time to Full Shields', maxShields / shieldRegen, 1, 's');
    if (maxHull    && hullRepair)  push('Time to Full Hull',    maxHull    / hullRepair,  1, 's');

    // ── 5. Scan ranges ────────────────────────────────────────────────────────
    for (const [key] of Object.entries(attrDefs?.attributes || {})) {
        if (!key.endsWith('scan power')) continue;
        const val = parseFloat(attrs[key] ?? 0);
        if (!val) continue;
        push(getLabel(key).replace(' Power', ' Range'), 100 * Math.sqrt(val), 1, 'px', `100 * sqrt([${key}])`);
    }

    // ── 6. Scan evasion ───────────────────────────────────────────────────────
    const si = parseFloat(attrs['scan interference'] ?? 0);
    if (si) push('Scan Evasion', si / (1 + si) * 100, 1, '%');

    // ── 7. Ramscoop ───────────────────────────────────────────────────────────
    const ramscoop = parseFloat(attrs['ramscoop'] ?? 0);
    if (ramscoop) push('Ramscoop Fuel/s', 0.03 * Math.sqrt(ramscoop), 1, 'fuel/s');

    // ── 8. Computed stats from ComputedStats.js (outfit-aware) ───────────────
    if (pluginId && typeof getComputedStats === 'function') {
        const computed = getComputedStats(item, pluginId);
        for (const [statKey, val] of Object.entries(computed)) {
            const isComputedKey = statKey.startsWith('_derived_') || statKey.startsWith('_fn_') || statKey.startsWith('_total') || statKey === '_outfitMass';
            if (!isComputedKey) continue;
            if (val == null || (typeof val === 'number' && (isNaN(val) || val === 0))) continue;
            const label = computedKeyToLabel(statKey);

            // For _fn_ keys, apply the displayScale from the JSON
            let displayVal = val;
            if (statKey.startsWith('_fn_')) {
                const fnName  = statKey.slice(4);
                const fnData  = fns[fnName];
                const scale   = fnData?.displayScale ?? 1;
                displayVal    = val * scale;
            }

            if (seen.has(label)) {
                const existing = results.find(r => r.label === label);
                if (existing) { existing.value = fmtNum(displayVal); existing.isComputedOutfit = true; }
                continue;
            }
            seen.add(label);
            results.push({ label, value: fmtNum(displayVal), unit: fns[statKey.slice(4)]?.displayUnit ?? '', formula: '', isComputedOutfit: true });
        }
    }

    return results;
}

// ─── Weapon chain renderer ───────────────────────────────────────────────────

function lookupOutfit(name, pluginId) {
    const allData = window.allData || {};
    const order = [pluginId, ...Object.keys(allData).filter(k => k !== pluginId)];
    for (const pid of order) {
        const outfit = (allData[pid]?.outfits || []).find(o => o.name === name);
        if (outfit) return outfit;
    }
    return null;
}

function renderWeaponStats(attrDefs, weapon, sectionTitle, outfitContext) {
    const excludeWeapon = new Set(['sprite','spriteData','sound','hit effect','fire effect','die effect','live effect','submunition','ammo','stream','cluster','hardpoint sprite','hardpoint offset','icon']);
    const excludeOutfit = new Set(['name','weapon','sprite','spriteData','thumbnail','description','flare sprite','steering flare sprite','reverse flare sprite','afterburner effect']);
    let html = '';
    const wRows = [];

    if (outfitContext) {
        if (outfitContext.description) wRows.push(`<div class="ad-description">${outfitContext.description}</div>`);
        for (const [key, value] of Object.entries(outfitContext)) {
            if (excludeOutfit.has(key) || typeof value === 'object' || Array.isArray(value)) continue;
            const rec    = getAttrRecord(attrDefs, key);
            const unit   = rec?.displayUnit ?? '';
            const mult   = rec?.displayMultiplier ?? 1;
            const rawVal = parseFloat(value);
            const dispV  = isNaN(rawVal) ? fmtNum(value) : fmtNum(rawVal * mult);
            wRows.push(attrRow(getLabel(key), dispV, unit, tooltipContent(rec)));
        }
    }

    for (const [key, value] of Object.entries(weapon)) {
        if (excludeWeapon.has(key)) continue;
        if (Array.isArray(value)) {
            for (const v of value) { if (typeof v !== 'object') wRows.push(attrRow(getLabel(key), String(v), '', '')); }
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

    for (const effectKey of ['hit effect','fire effect','die effect','live effect']) {
        const val = weapon[effectKey];
        if (!val) continue;
        const entries = Array.isArray(val) ? val : [val];
        for (const e of entries) {
            if (typeof e === 'object') wRows.push(attrRow(`${getLabel(effectKey)}: ${e.name ?? e}`, (e.count ?? 1) > 1 ? String(e.count) : '✓', '', ''));
            else if (typeof e === 'string') wRows.push(attrRow(`${getLabel(effectKey)}: ${e}`, '✓', '', ''));
            else if (typeof e === 'number') wRows.push(attrRow(getLabel(effectKey), String(e), '', ''));
        }
    }

    if (wRows.length) html += buildSection(sectionTitle, wRows);
    const wDerived = calcWeaponDerived(attrDefs, weapon);
    if (wDerived.length) html += buildSection(`${sectionTitle} — Derived`, wDerived.map(d => attrRow(d.label, d.value, d.unit, '', 'derived')));
    return html;
}

function collectDamage(weapon, multiplier = 1) {
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
    for (const [k, v] of Object.entries(source)) target[k] = (target[k] || 0) + v;
}

function renderWeaponChain(attrDefs, weapon, pluginId) {
    if (!weapon) return '';
    let html = '';
    const totalDamage = {};
    const visited = new Set();
    const queue   = [{ weapon, outfit: null, title: 'Weapon Stats', multiplier: 1, depth: 0 }];
    const sections = [];

    while (queue.length > 0) {
        const { weapon: w, outfit: o, title, multiplier, depth } = queue.shift();
        sections.push({ weapon: w, outfit: o, title, multiplier });
        mergeInto(totalDamage, collectDamage(w, multiplier));

        const sub = w.submunition;
        if (sub && depth < 8) {
            const entries = Array.isArray(sub) ? sub : [{ name: String(sub), count: 1 }];
            for (const entry of entries) {
                const subName  = entry?.name ?? String(entry);
                const subCount = entry?.count ?? 1;
                if (!subName || visited.has(subName)) continue;
                visited.add(subName);
                const subOutfit = lookupOutfit(subName, pluginId);
                if (subOutfit?.weapon) queue.push({ weapon: subOutfit.weapon, outfit: subOutfit, title: `Submunition: ${subName}${subCount > 1 ? ` ×${subCount}` : ''}`, multiplier: multiplier * subCount, depth: depth + 1 });
            }
        }

        const ammoVal = w.ammo;
        if (ammoVal && typeof ammoVal === 'string' && depth < 8 && !visited.has(ammoVal)) {
            visited.add(ammoVal);
            const ammoOutfit = lookupOutfit(ammoVal, pluginId);
            if (ammoOutfit?.weapon) queue.push({ weapon: ammoOutfit.weapon, outfit: ammoOutfit, title: `Ammo: ${ammoVal}`, multiplier, depth: depth + 1 });
        }
    }

    for (const { weapon: w, outfit: o, title } of sections) html += renderWeaponStats(attrDefs, w, title, o);

    if (sections.length > 1 && Object.keys(totalDamage).length > 0) {
        const totalRows = Object.entries(totalDamage).filter(([, v]) => v !== 0).map(([key, val]) => attrRow(getLabel(key), fmtNum(val), '', ''));
        if (totalRows.length) html += buildSection('Total Damage (full chain)', totalRows);
    }

    return html;
}

function calcWeaponDerived(attrDefs, weapon) {
    if (!weapon) return [];
    const results = [];
    const seen    = new Set();
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
        const val = parseFloat(weapon[dmgKey] ?? weapon[dtype.toLowerCase() + ' damage'] ?? weapon[dmgKey.toLowerCase()] ?? 0);
        if (val) push(getLabel(dmgKey.replace(/ damage$/i, '')) + ' DPS', val / reload * 60, 'dmg/s');
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
    if (typeof v !== 'number') { const n = parseFloat(v); if (isNaN(n)) return String(v); v = n; }
    if (Number.isInteger(v) && Math.abs(v) >= 10000) return v.toLocaleString();
    return parseFloat(v.toPrecision(4)).toString();
}

// ─── HTML building helpers ────────────────────────────────────────────────────

function tooltipContent(rec, formulaOverride) {
    if (!rec && !formulaOverride) return '';
    const parts = [];
    if (rec?.description) parts.push(rec.description);
    if (rec?.stacking)    parts.push(`Stacking: ${rec.stacking}${rec.stackingDescription ? ' — ' + rec.stackingDescription : ''}`);
    const formula = formulaOverride || rec?.formula;
    if (formula)          parts.push(`Formula: ${formula}`);
    if (rec?.displayUnit) parts.push(`Unit: ${rec.displayUnit}`);
    return parts.length ? ` data-tooltip="${parts.join(' | ').replace(/"/g, '&quot;')}"` : '';
}

function buildSection(title, rows) {
    if (!rows.length) return '';
    const h = title ? `<h3 class="ad-section-title">${title}</h3>` : '';
    return `${h}<div class="ad-grid">${rows.join('')}</div>`;
}

function attrRow(label, displayValue, unit, tipAttrs, extra) {
    const badge = unit ? `<span class="ad-unit">${unit}</span>` : '';
    const cls   = extra ? ` ad-row--${extra}` : '';
    return `<div class="ad-row${cls}"${tipAttrs || ''}><div class="ad-label">${label}</div><div class="ad-value">${displayValue}${badge}</div></div>`;
}

// ─── Section grouping ─────────────────────────────────────────────────────────

function groupBySection(attrDefs, entries) {
    const sections = {};
    for (const { key, value } of entries) {
        const rec     = getAttrRecord(attrDefs, key);
        const section = getSection(attrDefs, key);
        const mult    = rec?.displayMultiplier ?? 1;
        const unit    = rec?.displayUnit ?? '';
        const rawVal  = parseFloat(value);
        const dispVal = isNaN(rawVal) ? fmtNum(value) : fmtNum(rawVal * mult);
        if (!sections[section]) sections[section] = [];
        sections[section].push(attrRow(getLabel(key), dispVal, unit, tooltipContent(rec)));
    }
    return sections;
}

function renderSections(sections) {
    let out = '';
    const keys = [...new Set([...SECTION_ORDER, ...Object.keys(sections)])];
    for (const s of keys) { if (sections[s]?.length) out += buildSection(s, sections[s]); }
    return out;
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function renderAttributesTabEnhanced(item, attrDefs, currentTab, pluginId) {
    attrDefs = attrDefs || {};
    let html = '';

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

        const hpRows = [];
        for (const [field, label] of [['guns','Guns'],['turrets','Turrets'],['engines','Engines'],['reverseEngines','Reverse Engines'],['steeringEngines','Steering Engines']]) {
            if (item[field]?.length) hpRows.push(attrRow(label, item[field].length, '', ''));
        }
        if (item.bays?.length) {
            const byType = {};
            item.bays.forEach(b => { byType[b.type] = (byType[b.type] || 0) + 1; });
            Object.entries(byType).forEach(([t, n]) => hpRows.push(attrRow(`${t} Bays`, n, '', '')));
        }
        if (hpRows.length) html += buildSection('Hardpoints', hpRows);

        if (item.outfitMap && Object.keys(item.outfitMap).length) {
            const outfitRows = Object.entries(item.outfitMap).sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => attrRow(name, count > 1 ? `×${count}` : '✓', '', ''));
            html += buildSection('Outfits', outfitRows);
        }

        const derived = calcDerivedStats(attrDefs, item, pluginId);
        if (derived.length) {
            const baseRows = derived.filter(d => !d.isComputedOutfit).map(d => attrRow(d.label, d.value, d.unit, tooltipContent(null, d.formula), 'derived'));
            const computedRows = derived.filter(d => d.isComputedOutfit).map(d => {
                const tip = d.formula ? `Includes installed outfit contributions | Formula: ${d.formula}` : 'Includes installed outfit contributions';
                return attrRow(`⚡ ${d.label}`, d.value, d.unit, tooltipContent(null, tip), 'derived');
            });
            if (baseRows.length)     html += buildSection('Derived Stats', baseRows);
            if (computedRows.length) html += buildSection('Derived Stats (with Outfits)', computedRows);
        }

    } else if (currentTab === 'effects') {
        const excludeKeys = new Set(['name','description','sprite','spriteData']);
        const entries = [];
        for (const [key, value] of Object.entries(item)) {
            if (excludeKeys.has(key) || typeof value === 'object') continue;
            entries.push({ key, value });
        }
        html += renderSections(groupBySection(attrDefs, entries));

    } else {
        const excludeKeys = new Set(['name','description','thumbnail','sprite','hardpointSprite','hardpoint sprite','steering flare sprite','flare sprite','reverse flare sprite','afterburner effect','projectile','weapon','spriteData','_internalId','_pluginId','_hash','governments','_variantPluginId']);
        const entries = [];
        for (const [key, value] of Object.entries(item)) {
            if (excludeKeys.has(key) || typeof value === 'object') continue;
            entries.push({ key, value });
        }
        if (item.licenses && typeof item.licenses === 'object') {
            html += buildSection('General', [attrRow('Licenses', Object.keys(item.licenses).join(', '), '', '')]);
        }
        html += renderSections(groupBySection(attrDefs, entries));

        if (item.weapon) html += renderWeaponChain(attrDefs, item.weapon, pluginId);

        const noteRows = [];
        for (const [key] of Object.entries(item)) {
            const stacking = getStacking(attrDefs, key);
            if (!stacking?.rule || stacking.rule === 'additive') continue;
            noteRows.push(`<div class="ad-stacking-note"><span class="ad-stacking-key">${getLabel(key)}</span><span class="ad-stacking-rule">${stacking.rule}${stacking.description ? ' — ' + stacking.description : ''}</span></div>`);
        }
        if (noteRows.length) {
            html += `<div class="ad-stacking-section"><h3 class="ad-section-title">Stacking Notes</h3>${noteRows.join('')}</div>`;
        }
    }

    return html;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function initTooltips() {
    if (document.getElementById('ad-tooltip')) return;
    const tooltip = document.createElement('div');
    tooltip.id = 'ad-tooltip';
    tooltip.style.cssText = ['position:fixed','z-index:9999','max-width:320px','padding:10px 14px','background:rgba(15,23,42,0.97)','border:1px solid rgba(99,179,237,0.35)','border-radius:8px','color:#e2e8f0','font-size:12px','line-height:1.55','pointer-events:none','opacity:0','transition:opacity 0.15s ease','box-shadow:0 8px 32px rgba(0,0,0,0.6)','white-space:pre-wrap'].join(';');
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

function injectStyles() { /* Styles live in CSS file */ }

// ─── Exports ──────────────────────────────────────────────────────────────────

window.AttributeDisplay = {
    renderAttributesTabEnhanced,
    calcDerivedStats,
    calcWeaponDerived,
    initTooltips,
    injectStyles,
    fmtNum,
};
