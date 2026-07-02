'use strict';

// ─── CompareDisplay.js ────────────────────────────────────────────────────────
//
// Renders the compare bar and panel.
//
// Per-item attribute layers:
//   1. Effective attrs  — base ship attrs + all outfit contributions
//   2. Hardpoints       — gun/turret/bay/engine counts
//   3. Heat derived     — totalHeatCawpacity, maxSustainableHeatProd
//   4. Weapon DPS       — fleet summary + per-weapon detail
//   5. Per-outfit detail — Outfit: <name> sections for every installed outfit
//   6. Computed stats   — _fn_*, _derived_*, _ws_* from ComputedStats
//
// Quantity multiplier:
//   Each item has a ×N spinner in its column/table header.
//   All numeric stats are multiplied by that quantity before display.
//   Useful for comparing e.g. ×2 of one outfit vs ×1 of another.
//
// Base vs With-Outfits display:
//   For ships, each section first shows base-only values (ship attrs alone).
//   If any values differ once outfits are included, a "(with outfits)" sub-section
//   appears immediately after showing only the changed/new rows.
// ─────────────────────────────────────────────────────────────────────────────

window.CompareDisplay = (() => {

    let _panelOpen = false;
    let _viewMode  = 'columns';
    let _quantities = {}; // qKey(item) → integer ≥ 1
    // Per-member qtys inside a group: groupId + '|' + memberIndex → integer ≥ 1
    let _groupMemberQtys = {};

    const MAX_TEMP = 100;

    const PER_DIVISOR_KEYS = [
        { key: 'outfit space',    label: 'Outfit Space'    },
        { key: 'cargo space',     label: 'Cargo Space'     },
        { key: 'weapon capacity', label: 'Weapon Capacity' },
        { key: 'engine capacity', label: 'Engine Capacity' },
        { key: 'mass',            label: 'Mass'            },
    ];

    function _signedPerDivisor(numerator, ratio) {
        if (ratio === 0 || isNaN(ratio)) return ratio;
        const mag = Math.abs(ratio);
        return numerator < 0 ? -mag : mag;
    }
    
    const SECTION_ORDER = [
        'General', 'Shields & Hull', 'Energy', 'Engines', 'Jump',
        'Cargo', 'Crew', 'Scanning', 'Cloaking', 'Resistance', 'Protection',
        'Hardpoints', 'Heat (derived)', 'Weapon DPS', 'Weapon DPS — Efficiency',
        'Ammo Consumption', 'Derived Stats', 'Other', 'Attribute Efficiency',
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

    function _inferSection(key) {
        const k = key.toLowerCase();
        for (const [re, s] of SECTION_PATTERNS) if (re.test(k)) return s;
        return 'Other';
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    const _attrDefs = () => window.attrDefs || null;

    function _fmt(v) {
        if (window.AttributeDisplay?.fmtNum) return window.AttributeDisplay.fmtNum(v);
        if (typeof v !== 'number') return String(v);
        if (Number.isInteger(v) && Math.abs(v) >= 10000) return v.toLocaleString();
        return parseFloat(v.toPrecision(4)).toString();
    }

    function _getAttrRecord(key) {
        const defs = _attrDefs();
        if (!defs) return null;
        const attrs = defs.attributes || {};
        return attrs[key] || attrs[key?.toLowerCase()] || null;
    }

    function _getSection(key) {
        const rec = _getAttrRecord(key);
        if (rec) {
            const fns = rec.usedInShipFunctions || [];
            if (fns.some(f => /MaxVelocity|Acceleration|TurnRate|Drag|InertialMass|Reverse/.test(f))) {
                const k = key.toLowerCase();
                if (/thrust|turn|reverse|afterburner|engine/.test(k)) return 'Engines';
                if (/drag|inertia/.test(k)) return 'General';
            }
            if (fns.some(f => /MaxShields|MaxHull|MinimumHull/.test(f))) return 'Shields & Hull';
            if (fns.some(f => /IdleHeat|CoolingEfficiency|HeatDissipation|MaximumHeat/.test(f))) return 'Energy';
            if (fns.some(f => /CloakingSpeed/.test(f))) return 'Cloaking';
            if (fns.some(f => /Jump|Nav/.test(f))) return 'Jump';
            if (rec.isWeaponStat) return 'Weapon DPS';
        }
        return _inferSection(key);
    }

    function _getDisplayUnit(key)       { return _getAttrRecord(key)?.displayUnit       ?? ''; }
    function _getDisplayMultiplier(key) { return _getAttrRecord(key)?.displayMultiplier ?? 1; }

    // Infer a per-second unit for computed _fn_ keys where the attrDefs don't
    // supply one but the key name implies a rate.
    const _FN_RATE_RE = /rate|per.?second|generation|consumption|dissipation|production|output|input|recharge|repair/i;
    function _inferFnUnit(fnName) {
        const rec = _attrDefs()?.shipFunctions?.[fnName];
        if (rec?.displayUnit) return rec.displayUnit;
        if (_FN_RATE_RE.test(fnName)) return '/s';
        return '';
    }

    // Pretty label for any key including computed/internal ones
    function _labelOf(key) {
        let s = key;
        if (s.startsWith('_fn_'))                  s = s.slice(4);
        else if (s.startsWith('_derived_energy_')) s = s.slice('_derived_energy_'.length) + ' Energy/s';
        else if (s.startsWith('_derived_heat_'))   s = s.slice('_derived_heat_'.length)   + ' Heat/s';
        else if (s.startsWith('_derived_'))        s = s.slice('_derived_'.length);
        else if (s.startsWith('_sys_'))            s = s.slice('_sys_'.length).replace(/_/g, ' ') + ' (system)';
        else if (s === '_ws_totalDps')             return 'Total DPS';
        else if (s === '_ws_shieldDps')            return 'Shield DPS';
        else if (s === '_ws_hullDps')              return 'Hull DPS';
        else if (s === '_ws_weaponCount')          return 'Weapon Types';
        else if (s === '_ws_totalWeaponMounts')    return 'Total Weapon Mounts';
        else if (s === '_outfitMass')              return 'Outfit Mass';
        else if (s === '_totalOutfitCost')         return 'Total Outfit Cost';
        else if (s === '_totalOutfits')            return 'Total Outfits';
        else if (s.startsWith('_ws_dps_')) {
            s = s.slice('_ws_dps_'.length).replace(/_/g, ' ');
            s = s.replace(/\s*damage\s*$/, '').trim() + ' DPS';
        }
        return s.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')
                .replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase()).trim();
    }

    // ── Quantity helpers ──────────────────────────────────────────────────────

    function _qKey(item) {
        return (item.name || '') + '|' + (item._compareTab || '');
    }

    function _getQty(item) {
        return _quantities[_qKey(item)] || 1;
    }

    function _setQty(item, n) {
        _quantities[_qKey(item)] = Math.max(1, Math.floor(n) || 1);
        _renderPanelContent();
    }

    // ── Group member qty helpers ─────────────────────────────────────────────

    function _gmKey(groupId, idx) { return groupId + '|' + idx; }

    function _getGroupMemberQty(groupId, idx) {
        return _groupMemberQtys[_gmKey(groupId, idx)] || 1;
    }

    function _setGroupMemberQty(groupId, idx, n) {
        _groupMemberQtys[_gmKey(groupId, idx)] = Math.max(1, Math.floor(n) || 1);
        _renderPanelContent();
    }

    // ── Outfit index ──────────────────────────────────────────────────────────

    function _buildOutfitIndex() {
        const allData = window.allData || {};
        const merged  = {};
        for (const pd of Object.values(allData))
            (pd.outfits || []).forEach(o => { if (o.name && !merged[o.name]) merged[o.name] = o; });
        return merged;
    }

    // ── Effective attributes ──────────────────────────────────────────────────

    const _META_KEYS = new Set([
        'name','display name','category','series','index','cost','thumbnail','sprite',
        'description','pluginId','weapon','governments','locations',
        '_internalId','_pluginId','_hash','_pn','_pd','_isVariant','_compareTab',
        '_variantPluginId','displayName','spriteData','attributes',
        'leaks','engines','guns','turrets','bays','reverseEngines','steeringEngines',
        'outfitMap','outfits',
    ]);

    // Build effective attrs. If outfitIdx is null/omitted, only base ship attrs are used.
    function _buildEffectiveAttrs(item, outfitIdx) {
        const eff = {};
        const attrs = item.attributes || {};
        for (const [k, v] of Object.entries(attrs)) {
            if (typeof v === 'number')      eff[k] = v;
            else if (typeof v === 'string') { const n = parseFloat(v); if (!isNaN(n)) eff[k] = n; }
        }

        if (!outfitIdx) return eff; // base-only — stop here

        const outfitSource = item.outfitMap || item.outfits || {};
        const entries = _outfitEntries(outfitSource);
        for (const [name, count] of entries) {
            const outfit = outfitIdx[name];
            if (!outfit) continue;
            const src = (outfit.attributes && Object.keys(outfit.attributes).length)
                ? { ...outfit, ...outfit.attributes } : outfit;
            for (const [key, rawVal] of Object.entries(src)) {
                if (_META_KEYS.has(key) || key.startsWith('_')) continue;
                if (typeof rawVal !== 'number' || rawVal === 0)  continue;
                eff[key] = (eff[key] || 0) + rawVal * count;
            }
        }
        return eff;
    }

    // Normalise outfit map / array into [[name, count], ...]
    function _outfitEntries(src) {
        if (Array.isArray(src))
            return src.map(e => [e.name || '', typeof e.count === 'number' ? e.count : 1]);
        return Object.entries(src).map(([name, qv]) => [
            name,
            typeof qv === 'object' ? (parseInt(qv.count) || 1) : (Number(qv) || 1)
        ]);
    }

    // ── Heat derived ──────────────────────────────────────────────────────────

    function _computeHeatDerived(item, eff, outfitIdx) {
        const shipMass = parseFloat(item.attributes?.mass ?? item.mass ?? 0) || 0;
        let outfitMassSum = 0;
        if (outfitIdx) {
            for (const [name, count] of _outfitEntries(item.outfitMap || item.outfits || {})) {
                const outfit  = outfitIdx[name];
                if (!outfit) continue;
                const massKey = Object.keys(outfit).find(k => k.toLowerCase() === 'mass');
                if (massKey && typeof outfit[massKey] === 'number')
                    outfitMassSum += outfit[massKey] * count;
            }
        }
        const totalMass   = shipMass + outfitMassSum;
        const heatCapKey  = Object.keys(eff).find(k => k.toLowerCase() === 'heat capacity');
        const heatDissKey = Object.keys(eff).find(k => k.toLowerCase().includes('heat dissipation'));
        const heatCap     = heatCapKey  ? (eff[heatCapKey]  || 0) : 0;
        const heatDiss    = heatDissKey ? (eff[heatDissKey] || 0) : 0;
        return {
            totalHeatCapacity:      totalMass > 0 ? totalMass * MAX_TEMP : null,
            maxSustainableHeatProd: (heatDiss > 0 && (totalMass + heatCap) > 0)
                                        ? (totalMass + heatCap) * heatDiss * 6 : null,
        };
    }

    // ── Weapon data ───────────────────────────────────────────────────────────

    function _buildWeaponData(item, outfitIdx) {
        if (!window.WeaponStats) return null;
        const outfitMap = {};
        for (const [name, count] of _outfitEntries(item.outfitMap || item.outfits || {}))
            if (name) outfitMap[name] = (outfitMap[name] || 0) + count;
        try {
            const stats = window.WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx);
            if (stats) stats._outfitIdx = outfitIdx;
            return stats;
        } catch (_) { return null; }
    }

    // ── Per-weapon detail rows ────────────────────────────────────────────────

    function _weaponDetailRows(outfitName, count, outfit, profile, qty) {
        qty = (typeof qty === 'number' && qty >= 1) ? qty : 1;
        const w   = outfit.weapon || {};
        const sps = profile.shotsPerSecond || 0;
        const rows = [];

        // ── 1. Count ──────────────────────────────────────────────────────────
        rows.push({ label: 'Count', value: `×${count * qty}`, unit: '' });

        // ── 2. Flat outfit-level attrs (mass, cost, outfit space, etc.) ───────
        // These are the non-weapon keys on the outfit object itself.
        const outfitAttrSkip = new Set([
            'name','display name','description','sprite','thumbnail','spriteData',
            '_pluginId','_internalId','_compareTab','_hash','_variantPluginId',
            'locations','governments','weapon','outfitMap','outfits',
            'leaks','engines','guns','turrets','bays','reverseEngines','steeringEngines',
        ]);
        const src = (outfit.attributes && Object.keys(outfit.attributes).length)
            ? { ...outfit, ...outfit.attributes } : outfit;

        const flatRows = [];
        for (const [key, val] of Object.entries(src)) {
            if (outfitAttrSkip.has(key) || key.startsWith('_')) continue;
            if (typeof val === 'object' || Array.isArray(val))   continue;
            let display = null;
            let unit    = '';
            if (typeof val === 'boolean') {
                display = val ? '✓' : '✗';
            } else if (typeof val === 'number' && val !== 0) {
                const mult = _getDisplayMultiplier(key);
                display = _fmt(val * count * qty * mult);
                unit    = _getDisplayUnit(key);
            } else if (typeof val === 'string' && val.trim()) {
                display = val.trim();
            }
            if (display === null) continue;
            flatRows.push({ label: _labelOf(key), value: display, unit });
        }
        flatRows.sort((a, b) => a.label.localeCompare(b.label));
        rows.push(...flatRows);

        // ── 3. Weapon sub-object raw stats ────────────────────────────────────
        const weapSkip = new Set(['sprite','spriteData','sound','hit effect','fire effect',
            'die effect','live effect','submunition','submunitions','stream','cluster',
            'hardpoint sprite','hardpoint offset','icon','ammunition','ammo']);

        rows.push({ label: '— Weapon Stats —', value: '', unit: '', isDivider: true });

        for (const [key, val] of Object.entries(w).sort((a, b) => a[0].localeCompare(b[0]))) {
            const lk = key.toLowerCase();
            if (weapSkip.has(lk))         continue;
            if (lk.startsWith('firing ')) continue;
            if (lk.endsWith(' damage'))   continue;
            if (val === null || val === undefined) continue;

            let display = null;
            if (typeof val === 'boolean')                    display = val ? '✓' : '✗';
            else if (typeof val === 'number' && val !== 0) {
                // Weapon sub-object attrs are per-projectile constants — never
                // scale by count or qty. Only outfit-level attrs (mass, cost etc)
                // scale with count * qty.
                display = _fmt(val * (_getDisplayMultiplier(key) ?? 1));
            }
            else if (typeof val === 'string' && val.trim()) display = val.trim();
            else if (Array.isArray(val) && val.length)
                display = val.map(el => typeof el === 'object' ? (el.type ?? el.name ?? JSON.stringify(el)) : String(el)).join(', ');
            else if (typeof val === 'object' && val)
                display = val.type ?? val.name ?? JSON.stringify(val);

            if (display === null) continue;
            rows.push({ label: _labelOf(key), value: display, unit: _getDisplayUnit(key) });
        }

        // ── 4. Per-second DPS / firing costs ─────────────────────────────────
        rows.push({ label: '— Per Second —', value: '', unit: '', isDivider: true });
        rows.push({ label: 'Shots/s', value: _fmt(sps), unit: '' });
        if (profile.effectiveRange)
            rows.push({ label: 'Range', value: _fmt(profile.effectiveRange), unit: 'px' });

        for (const [dmgKey, dps] of Object.entries(profile.dpsBreakdown || {}).sort())
            if (dps) {
                const label = _labelOf(dmgKey.replace(/ damage$/, '')) + ' DPS';
                rows.push({ label, value: _fmt(dps * count * qty), unit: 'dmg/s' });
            }

        for (const [costKey, costVal] of Object.entries(profile.firingCosts || {}).sort())
            if (costVal) {
                const label = _labelOf(costKey.replace(/^firing /, '')) + '/s';
                rows.push({ label, value: _fmt(costVal * sps * count * qty), unit: '' });
            }

        // ── 5. Computed _fn_ / _derived_ stats for this outfit ────────────────
        if (window.ComputedStats?.isReady()) {
            try {
                const flat = {};
                for (const [k, v] of Object.entries(src))
                    if (typeof v === 'number') flat[k] = v;
                const computed = window.ComputedStats.getComputedStatsForAttrs(flat);
                if (computed) {
                    const computedRows = [];
                    for (const [k, v] of Object.entries(computed)) {
                        if (v === null || v === undefined) continue;
                        if (typeof v === 'number' && (isNaN(v) || v === 0)) continue;
                        if (typeof v === 'object') continue;
                        const isComputedKey = k.startsWith('_fn_') || k.startsWith('_derived_') ||
                                              k.startsWith('_sys_');
                        if (!isComputedKey) continue;
                        let display = v;
                        let unit    = '';
                        if (k.startsWith('_fn_')) {
                            const fnName = k.slice(4);
                            const scale  = _attrDefs()?.shipFunctions?.[fnName]?.displayScale;
                            if (scale) display = v * scale;
                            unit = _inferFnUnit(fnName);
                            if (typeof display === 'number') display = display * count * qty;
                        } else if (k.startsWith('_derived_energy_') || k.startsWith('_derived_heat_')) {
                            if (typeof display === 'number') display = display * count * qty;
                            unit = k.startsWith('_derived_energy_') ? 'e/s' : 'h/s';
                        } else if (k.startsWith('_derived_') || k.startsWith('_sys_')) {
                            if (typeof display === 'number') display = display * count * qty;
                            if (k.startsWith('_sys_')) unit = '/s';
                        }
                        computedRows.push({
                            label: _labelOf(k),
                            value: typeof display === 'number' ? _fmt(display) : String(display),
                            unit,
                        });
                    }
                    if (computedRows.length) {
                        computedRows.sort((a, b) => a.label.localeCompare(b.label));
                        rows.push({ label: '— Computed /s —', value: '', unit: '', isDivider: true });
                        rows.push(...computedRows);
                    }
                }
            } catch (_) {}
        }

        return rows;
    }

    // ── Per-outfit detail rows ────────────────────────────────────────────────
    // Builds attribute rows for a single outfit install, including computed
    // _fn_ / _derived_ stats for that outfit's flat numeric attributes.
    // Keys that belong to the weapon sub-object are skipped here (they live in
    // the Weapon: <name> section instead).

    const _OUTFIT_DETAIL_SKIP = new Set([
        'name','display name','description','sprite','thumbnail','spriteData',
        '_pluginId','_internalId','_compareTab','_hash','_variantPluginId',
        'locations','governments','weapon','outfitMap','outfits',
        'leaks','engines','guns','turrets','bays','reverseEngines','steeringEngines',
    ]);

    function _outfitDetailRows(outfitName, count, outfit, qty) {
        const rows = [];

        // Count header
        rows.push({ label: 'Count', value: `×${count * qty}`, unit: '', isHeader: false });

        // Flat numeric attributes
        const src = (outfit.attributes && Object.keys(outfit.attributes).length)
            ? { ...outfit, ...outfit.attributes } : outfit;

        const attrRows = [];
        for (const [key, val] of Object.entries(src)) {
            if (_OUTFIT_DETAIL_SKIP.has(key) || key.startsWith('_')) continue;
            if (typeof val === 'object' || Array.isArray(val))        continue;

            let display = null;
            let unit    = '';

            if (typeof val === 'boolean') {
                display = val ? '✓' : '✗';
            } else if (typeof val === 'number' && val !== 0) {
                const mult = _getDisplayMultiplier(key);
                display = _fmt(val * count * qty * mult);
                unit    = _getDisplayUnit(key);
            } else if (typeof val === 'string' && val.trim()) {
                display = val.trim();
            }

            if (display === null) continue;
            attrRows.push({ label: _labelOf(key), value: display, unit, key });
        }

        attrRows.sort((a, b) => a.label.localeCompare(b.label));
        rows.push(...attrRows);

        // Computed _fn_ / _derived_ stats for this outfit
        if (window.ComputedStats?.isReady()) {
            try {
                const flat = {};
                for (const [k, v] of Object.entries(src))
                    if (typeof v === 'number') flat[k] = v;

                const outfitAttrKeys = new Set(Object.keys(flat));
                let computed = window.ComputedStats.getComputedStatsForAttrs(flat);

                if (computed && window.attrDefs) {
                    const fns     = window.attrDefs.shipFunctions              || {};
                    const intVars = window.attrDefs.shipDisplay?.intermediateVars || {};
                    const sysF    = window.attrDefs.systemAwareFormulas           || {};

                    for (const k of Object.keys(computed)) {
                        if (k.startsWith('_fn_')) {
                            const fnDef = fns[k.slice(4)];
                            if (!fnDef) { delete computed[k]; continue; }
                            const reads = fnDef.attributesRead || [];
                            if (reads.length === 0) { delete computed[k]; continue; }
                            const matchingReads = reads.filter(a => outfitAttrKeys.has(a));
                            if (matchingReads.length === 0) { delete computed[k]; continue; }
                            if (matchingReads.length < 2 && reads.length > 1) {
                                delete computed[k]; continue;
                            }
                            continue;
                        }
                        if (k.startsWith('_derived_')) {
                            const stripped = k
                                .replace(/^_derived_energy_/, '')
                                .replace(/^_derived_heat_/, '')
                                .replace(/^_derived_/, '');
                            const formula = intVars[stripped];
                            if (!formula) { delete computed[k]; continue; }
                            const refs = [...formula.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
                            if (refs.length === 0) { delete computed[k]; continue; }
                            if (!refs.some(a => outfitAttrKeys.has(a))) { delete computed[k]; continue; }
                            continue;
                        }
                        if (k.startsWith('_sys_')) {
                            const formula = sysF[k.slice(5).replace(/_/g, ' ')]?.formula;
                            if (!formula) { delete computed[k]; continue; }
                            const refs = [...formula.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
                            if (refs.length === 0) { delete computed[k]; continue; }
                            if (!refs.some(a => outfitAttrKeys.has(a))) { delete computed[k]; continue; }
                            continue;
                        }
                    }
                }

                if (computed) {
                    const computedRows = [];
                    for (const [k, v] of Object.entries(computed)) {
                        if (v === null || v === undefined) continue;
                        if (typeof v === 'number' && (isNaN(v) || v === 0)) continue;
                        if (typeof v === 'object') continue;
                        const isComputedKey = k.startsWith('_fn_') || k.startsWith('_derived_') ||
                                              k.startsWith('_sys_');
                        if (!isComputedKey) continue;

                        let display = v;
                        let unit    = '';

                        if (k.startsWith('_fn_')) {
                            const fnName = k.slice(4);
                            const fnDef  = window.attrDefs?.shipFunctions?.[fnName];
                            const scale  = fnDef?.displayScale;
                            display = (typeof scale === 'number' && scale !== 0 && scale !== 1)
                                ? v * scale
                                : v;
                            unit = _inferFnUnit(fnName);
                            if (typeof display === 'number') display = display * count * qty;
                        } else if (k.startsWith('_derived_energy_')) {
                            if (typeof display === 'number') display = display * count * qty;
                            unit = 'e/s';
                        } else if (k.startsWith('_derived_heat_')) {
                            if (typeof display === 'number') display = display * count * qty;
                            unit = 'h/s';
                        } else if (k.startsWith('_derived_')) {
                            if (typeof display === 'number') display = display * count * qty;
                        } else if (k.startsWith('_sys_')) {
                            if (typeof display === 'number') display = display * count * qty;
                            unit = '/s';
                        }

                        computedRows.push({
                            label: _labelOf(k),
                            value: typeof display === 'number' ? _fmt(display) : String(display),
                            unit,
                            key: k,
                        });
                    }

                    if (computedRows.length) {
                        computedRows.sort((a, b) => a.label.localeCompare(b.label));
                        rows.push({ label: '— Computed /s —', value: '', unit: '', isDivider: true });
                        rows.push(...computedRows);
                    }
                }
            } catch (_) {}
        }

        return rows;
    }

    // ── Skip sets ─────────────────────────────────────────────────────────────

    const SKIP_KEYS = new Set([
        'name','display name','description','sprite','thumbnail','spriteData',
        '_pluginId','_internalId','_compareTab','_hash','_variantPluginId',
        'locations','governments','hardpoint sprite','steering flare sprite',
        'flare sprite','reverse flare sprite','afterburner effect','projectile',
        'weapon','leaks','engines','guns','turrets','bays','reverseEngines',
        'steeringEngines','outfitMap','outfits',
    ]);

    const COMPUTED_SKIP = new Set(['_ws_hasAmmoWeapons','_totalOutfits']);


    function _buildGroupAttrMap(group, includeOutfits = true) {
        const isShipGroup = window.CompareManager.getGroupType() === 'ship';

        const resolvedMembers = group.members.map((m, i) => ({
            item: m.item,
            qty:  _getGroupMemberQty(group._groupId, i),
        }));

        // ── Combined top-level stats ──────────────────────────────────────────
        const combined = {};

        for (const { item, qty } of resolvedMembers) {
            const useOutfits = isShipGroup ? includeOutfits : true;
            const memberMap  = _buildAttrMap(item, qty, useOutfits);

            for (const [section, rows] of Object.entries(memberMap)) {
                if (_isDetailSection(section)) continue;
                if (section.startsWith('Member: ')) continue;

                for (const { key, label, value, unit } of rows) {
                    if (!combined[key]) {
                        const n = _parseDisplayNum(value);
                        combined[key] = {
                            label, unit, section,
                            numeric:  n !== null,
                            rawSum:   n !== null ? n : null,
                            strValue: n === null ? value : null,
                        };
                    } else if (combined[key].numeric) {
                        const n = _parseDisplayNum(value);
                        if (n !== null) combined[key].rawSum += n;
                    }
                }
            }
        }

        const sections = {};
        for (const [key, entry] of Object.entries(combined)) {
            const s = entry.section;
            if (!sections[s]) sections[s] = [];
            sections[s].push({
                key,
                label: entry.label,
                value: entry.numeric ? _fmt(entry.rawSum) : entry.strValue,
                unit:  entry.unit || '',
            });
        }

        // ── Outfit / Weapon detail sections ───────────────────────────────────
        // Build per-outfit rows with count=1, qty=1 so NO stats are scaled.
        // Apply the same _od_ / _wd_ key prefixes that _buildAttrMap uses so
        // the table view aligns group columns with single-ship columns correctly.
        // Only the Count row is replaced with the real summed count.

        if (includeOutfits) {
            const outfitIdx = _buildOutfitIndex();

            // sectionKey → { rows (count=1,qty=1, correct prefixed keys), countSum }
            const detailSections = {};

            for (const { item, qty } of resolvedMembers) {
                const outfitSource = item.outfitMap || item.outfits || {};
                const entries      = _outfitEntries(outfitSource);

                for (const [outfitName, installCount] of entries) {
                    if (!outfitName) continue;
                    const outfit = outfitIdx[outfitName];
                    if (!outfit)    continue;

                    const isWeapon   = outfit.weapon && typeof outfit.weapon === 'object';
                    const sectionKey = isWeapon
                        ? `Weapon: ${outfitName}`
                        : `Outfit: ${outfitName}`;

                    if (!detailSections[sectionKey]) {
                        // Generate rows with count=1 and qty=1 — completely unscaled
                        let rawRows;
                        if (isWeapon && window.WeaponStats) {
                            try {
                                const profile = window.WeaponStats.getOutfitWeaponStats(outfit, outfitIdx);
                                rawRows = profile
                                    ? _weaponDetailRows(outfitName, 1, outfit, profile, 1)
                                    : _outfitDetailRows(outfitName, 1, outfit, 1);
                            } catch (_) {
                                rawRows = _outfitDetailRows(outfitName, 1, outfit, 1);
                            }
                        } else {
                            rawRows = _outfitDetailRows(outfitName, 1, outfit, 1);
                        }

                        // Apply the same key prefixes _buildAttrMap uses so the
                        // table view can align these rows with single-ship columns.
                        const prefix = isWeapon ? `_wd_${outfitName}_` : `_od_${outfitName}_`;
                        const prefixedRows = rawRows.map(r => ({
                            ...r,
                            key: prefix + r.label,
                        }));

                        detailSections[sectionKey] = {
                            prefixedRows,
                            countSum: 0,
                        };

                        if (!SECTION_ORDER.includes(sectionKey))
                            SECTION_ORDER.push(sectionKey);
                    }

                    // Accumulate real count: install count × ship qty
                    detailSections[sectionKey].countSum += installCount * qty;
                }
            }

            // Emit each section with the Count row replaced by the real total
            for (const [sectionKey, { prefixedRows, countSum }] of Object.entries(detailSections)) {
                sections[sectionKey] = prefixedRows.map(row =>
                    row.label === 'Count' ? { ...row, value: `×${countSum}` } : row
                );
            }
        }

        return sections;
    }
    
    // ── Build attribute map for one item ──────────────────────────────────────
    // qty: integer multiplier applied to all numeric values
    // includeOutfits: if false, only base ship attrs are used (no outfit contributions)
    function _buildAttrMap(item, qty, includeOutfits = true) {
        qty = (typeof qty === 'number' && qty >= 1) ? qty : 1;

        const sections  = {};
        const seen      = new Set();
        const outfitIdx = _buildOutfitIndex();
        const isShip    = !!(item.attributes && typeof item.attributes === 'object');

        const effectiveOutfitIdx = (isShip && !includeOutfits) ? null : outfitIdx;

        function push(key, rawVal, sectionOverride) {
            if (SKIP_KEYS.has(key) || seen.has(key))    return;
            if (rawVal === null || rawVal === undefined) return;
            if (typeof rawVal === 'object')             return;
            seen.add(key);
            const section  = sectionOverride || _getSection(key);
            const mult     = _getDisplayMultiplier(key);
            const unit     = _getDisplayUnit(key);
            const entry    = _getAttrRecord(key);

            // isWeaponDataKey covers both true weapon behaviour keys (reload, velocity,
            // lifetime etc — should NOT scale with qty) AND ship movement attrs that
            // happen to also be used in weapon data (turn, thrust — SHOULD scale).
            // Distinguish them: if the attr has usedInShipFunctions it is a ship stat
            // that scales with qty. Pure weapon behaviour keys have no usedInShipFunctions.
            const isShipMovementAttr = entry?.usedInShipFunctions?.length > 0;
            const isBehaviourKey = entry?.isWeaponDataKey && !entry?.isWeaponStat && !isShipMovementAttr;

            const scaledVal = (typeof rawVal === 'number' && !isBehaviourKey)
                ? rawVal * qty
                : rawVal;
            const display = typeof scaledVal === 'number' ? _fmt(scaledVal * mult) : String(scaledVal);
            if (!sections[section]) sections[section] = [];
            sections[section].push({ key, label: _labelOf(key), value: display, unit });
        }

        function pushRaw(section, key, label, value, unit) {
            if (seen.has(key)) return;
            seen.add(key);
            if (!sections[section]) sections[section] = [];
            sections[section].push({ key, label, value, unit: unit || '' });
        }

        function pushRawScaled(section, key, label, rawNum, unit) {
            if (seen.has(key)) return;
            seen.add(key);
            if (!sections[section]) sections[section] = [];
            const display = typeof rawNum === 'number' ? _fmt(rawNum * qty) : String(rawNum);
            sections[section].push({ key, label, value: display, unit: unit || '' });
        }

        if (isShip) {
            // 1. Effective attributes
            const eff = _buildEffectiveAttrs(item, effectiveOutfitIdx);
            for (const [k, v] of Object.entries(eff)) push(k, v);

            // 2. Hardpoints
            if (item.guns?.length)           pushRaw('Hardpoints', 'Guns',           'Guns',            String(item.guns.length * qty), '');
            if (item.turrets?.length)        pushRaw('Hardpoints', 'Turrets',        'Turrets',         String(item.turrets.length * qty), '');
            if (item.engines?.length)        pushRaw('Hardpoints', 'Engines',        'Engines',         String(item.engines.length * qty), '');
            if (item.reverseEngines?.length) pushRaw('Hardpoints', 'ReverseEngines', 'Reverse Engines', String(item.reverseEngines.length * qty), '');
            if (item.bays?.length) {
                const byType = {};
                item.bays.forEach(b => { byType[b.type || 'Bay'] = (byType[b.type || 'Bay'] || 0) + 1; });
                Object.entries(byType).forEach(([t, n]) => pushRaw('Hardpoints', `${t} Bays`, `${t} Bays`, String(n * qty), ''));
            }

            // 3. Heat derived
            const hd = _computeHeatDerived(item, eff, effectiveOutfitIdx);
            if (hd.totalHeatCapacity != null)
                pushRawScaled('Heat (derived)', '_hd_totalHeatCap', 'Total Heat Capacity',    hd.totalHeatCapacity,      '');
            if (hd.maxSustainableHeatProd != null)
                pushRawScaled('Heat (derived)', '_hd_maxSustHeat',  'Max Sustainable Heat/s', hd.maxSustainableHeatProd, '/s');

            // 4. Weapon DPS + per-weapon sections
            if (includeOutfits) {
                const wData = _buildWeaponData(item, outfitIdx);
                if (wData && wData.weaponCount) {
                    const dS = 'Weapon DPS';
                    pushRawScaled(dS, '_ws_totalDps',   'Total DPS',   wData.totalDps,  'dmg/s');
                    pushRawScaled(dS, '_ws_shieldDps',  'Shield DPS',  wData.shieldDps, 'dmg/s');
                    pushRawScaled(dS, '_ws_hullDps',    'Hull DPS',    wData.hullDps,   'dmg/s');
                    pushRaw(dS, '_ws_weaponCount', 'Weapon Types',  String(wData.weaponCount), '');
                    pushRaw(dS, '_ws_totalMounts', 'Total Mounts',  String(wData.totalWeaponMounts * qty), '');

                    for (const [dmgKey, val] of Object.entries(wData.dpsByType || {}).sort())
                        if (val) {
                            const safeKey = `_ws_dps_${dmgKey.replace(/\s+/g, '_')}`;
                            const label   = _labelOf(dmgKey.replace(/ damage$/, '')) + ' DPS';
                            pushRawScaled(dS, safeKey, label, val, 'dmg/s');
                        }

                    if (wData.hasAmmoWeapons)
                        for (const a of (wData.ammoRequired || []))
                            pushRawScaled('Ammo Consumption', `_ammo_${a.ammoOutfitName}`,
                                a.ammoOutfitName, a.totalShotsPerSecond, 'rounds/s');

                    // Per-weapon detail sections — stats at count=1 qty=1, only Count scaled
                    for (const w of (wData.weapons || [])) {
                        const outfit = outfitIdx[w.outfitName];
                        if (!outfit?.weapon) continue;
                        const sectionKey = `Weapon: ${w.outfitName}`;
                        if (!sections[sectionKey]) sections[sectionKey] = [];
                        if (!SECTION_ORDER.includes(sectionKey)) SECTION_ORDER.push(sectionKey);

                        const detailRows = _weaponDetailRows(w.outfitName, 1, outfit, w.profile, 1);

                        for (const r of detailRows) {
                            const k = `_wd_${w.outfitName}_${r.label}`;
                            if (seen.has(k)) continue;
                            seen.add(k);

                            const value = r.label === 'Count'
                                ? `×${w.count * qty}`
                                : r.value;

                            sections[sectionKey].push({
                                key:   k,
                                label: r.label,
                                value,
                                unit:  r.unit || '',
                                ...(r.isDivider ? { isDivider: true } : {}),
                            });
                        }
                    }
                }

                // 5. Per-outfit detail sections — stats at count=1 qty=1, only Count scaled
                const outfitSource  = item.outfitMap || item.outfits || {};
                const outfitEntries = _outfitEntries(outfitSource);
                outfitEntries.sort((a, b) => a[0].localeCompare(b[0]));

                for (const [outfitName, count] of outfitEntries) {
                    if (!outfitName) continue;
                    const outfit = outfitIdx[outfitName];
                    if (!outfit)    continue;
                    if (outfit.weapon && typeof outfit.weapon === 'object') continue;

                    const sectionKey = `Outfit: ${outfitName}`;
                    if (!sections[sectionKey]) sections[sectionKey] = [];
                    if (!SECTION_ORDER.includes(sectionKey)) SECTION_ORDER.push(sectionKey);

                    const detailRows = _outfitDetailRows(outfitName, 1, outfit, 1);

                    for (const r of detailRows) {
                        const k = `_od_${outfitName}_${r.label}`;
                        if (seen.has(k)) continue;
                        seen.add(k);

                        const value = r.label === 'Count'
                            ? `×${count * qty}`
                            : r.value;

                        sections[sectionKey].push({
                            key:   k,
                            label: r.label,
                            value,
                            unit:  r.unit || '',
                            ...(r.isDivider ? { isDivider: true } : {}),
                        });
                    }
                }
            }

        } else {
            // Outfit — flat structure; push() handles qty scaling for direct attrs.
            for (const [k, v] of Object.entries(item)) {
                if (SKIP_KEYS.has(k) || typeof v === 'object') continue;
                push(k, v);
            }

            // Per-divisor efficiency for top-level outfit attributes (cost,
            // mass, capacities, etc.) — these are static quantities, not
            // per-shot, so dividing them directly is meaningful as-is.
            const attrEffSection = 'Attribute Efficiency';
            for (const [k, v] of Object.entries(item)) {
                if (SKIP_KEYS.has(k) || typeof v !== 'number' || v === 0) continue;
                const mult      = _getDisplayMultiplier(k);
                const numerator = v * mult;
                for (const { key: divKey, label: divLabel } of PER_DIVISOR_KEYS) {
                    if (k === divKey) continue;
                    const divisor = item[divKey];
                    if (typeof divisor !== 'number' || divisor === 0) continue;
                    const ratio = _signedPerDivisor(numerator, numerator / divisor);
                    pushRaw(
                        attrEffSection,
                        `_attr_${k.replace(/\s+/g, '_')}_per_${divKey.replace(/\s+/g, '_')}`,
                        `${_labelOf(k)} per ${divLabel}`,
                        _fmt(ratio),
                        _getDisplayUnit(k)
                    );
                }
            }

            // Per-divisor efficiency for CALCULATED per-second weapon values —
            // fire rate and firing costs, sourced from WeaponStats exactly like
            // the "Weapon DPS" section above. Deliberately NOT looping over raw
            // item.weapon attributes here: damage is already covered (as DPS)
            // in "Weapon DPS — Efficiency", and things like inaccuracy, velocity,
            // and blast radius are per-projectile constants with no meaningful
            // per-second form — dividing those by mass is the same "per shot"
            // confusion we removed from Sorter.js.
            if (item.weapon && typeof item.weapon === 'object' && window.WeaponStats) {
                const profile = window.WeaponStats.getOutfitWeaponStats(item, outfitIdx);
                if (profile) {
                    const sps = profile.shotsPerSecond || 0;

                    if (sps) {
                        for (const { key: divKey, label: divLabel } of PER_DIVISOR_KEYS) {
                            const divisor = item[divKey];
                            if (typeof divisor !== 'number' || divisor === 0) continue;
                            const ratio = _signedPerDivisor(sps, sps / divisor);
                            pushRaw(attrEffSection,
                                `_wcalc_sps_per_${divKey.replace(/\s+/g, '_')}`,
                                `Fire Rate per ${divLabel}`, _fmt(ratio), 'shots/s');
                        }
                    }

                    for (const [costKey, costVal] of Object.entries(profile.firingCosts || {})) {
                        if (!costVal) continue;
                        const perSecond = costVal * sps;
                        const label = _labelOf(costKey.replace(/^firing /, '')) + '/s';
                        for (const { key: divKey, label: divLabel } of PER_DIVISOR_KEYS) {
                            const divisor = item[divKey];
                            if (typeof divisor !== 'number' || divisor === 0) continue;
                            const ratio = _signedPerDivisor(perSecond, perSecond / divisor);
                            pushRaw(attrEffSection,
                                `_wcalc_${costKey.replace(/\s+/g, '_')}_per_${divKey.replace(/\s+/g, '_')}`,
                                `${label} per ${divLabel}`, _fmt(ratio), '');
                        }
                    }

                    // ── Restored: DPS per divisor (Weapon DPS — Efficiency) ─────
                    const dpsEffSection = 'Weapon DPS — Efficiency';
                    if (profile.totalDps) {
                        for (const { key: divKey, label: divLabel } of PER_DIVISOR_KEYS) {
                            const divisor = item[divKey];
                            if (typeof divisor !== 'number' || divisor === 0) continue;
                            const ratio = _signedPerDivisor(profile.totalDps, profile.totalDps / divisor);
                            pushRaw(dpsEffSection, `_ws_totalDps_per_${divKey.replace(/\s+/g,'_')}`,
                                `Total DPS per ${divLabel}`, _fmt(ratio), 'dmg/s');
                        }
                    }
                    if (profile.shieldDps) {
                        for (const { key: divKey, label: divLabel } of PER_DIVISOR_KEYS) {
                            const divisor = item[divKey];
                            if (typeof divisor !== 'number' || divisor === 0) continue;
                            const ratio = _signedPerDivisor(profile.shieldDps, profile.shieldDps / divisor);
                            pushRaw(dpsEffSection, `_ws_shieldDps_per_${divKey.replace(/\s+/g,'_')}`,
                                `Shield DPS per ${divLabel}`, _fmt(ratio), 'dmg/s');
                        }
                    }
                    if (profile.hullDps) {
                        for (const { key: divKey, label: divLabel } of PER_DIVISOR_KEYS) {
                            const divisor = item[divKey];
                            if (typeof divisor !== 'number' || divisor === 0) continue;
                            const ratio = _signedPerDivisor(profile.hullDps, profile.hullDps / divisor);
                            pushRaw(dpsEffSection, `_ws_hullDps_per_${divKey.replace(/\s+/g,'_')}`,
                                `Hull DPS per ${divLabel}`, _fmt(ratio), 'dmg/s');
                        }
                    }
                    for (const [dmgKey, dps] of Object.entries(profile.dpsBreakdown || {}).sort()) {
                        if (!dps) continue;
                        for (const { key: divKey, label: divLabel } of PER_DIVISOR_KEYS) {
                            const divisor = item[divKey];
                            if (typeof divisor !== 'number' || divisor === 0) continue;
                            const ratio  = _signedPerDivisor(dps, dps / divisor);
                            const safeKey = `_ws_dps_${dmgKey.replace(/\s+/g, '_')}_per_${divKey.replace(/\s+/g,'_')}`;
                            const label   = _labelOf(dmgKey.replace(/ damage$/, '')) + ` DPS per ${divLabel}`;
                            pushRaw(dpsEffSection, safeKey, label, _fmt(ratio), 'dmg/s');
                        }
                    }
                }
            }
            
            if (item.weapon && typeof item.weapon === 'object') {
                const weapSkip = new Set(['sprite','spriteData','sound','hit effect','fire effect',
                    'die effect','submunition','submunitions','stream','cluster',
                    'hardpoint sprite','hardpoint offset','icon','ammunition','ammo']);

                for (const [wk, wv] of Object.entries(item.weapon)) {
                    if (weapSkip.has(wk) || typeof wv === 'object' || Array.isArray(wv)) continue;
                    // Weapon sub-object values are per-projectile constants — never
                    // scale by qty. Use pushRaw with pre-formatted display value.
                    if (seen.has(wk)) continue;
                    seen.add(wk);
                    const mult = _getDisplayMultiplier(wk);
                    const unit = _getDisplayUnit(wk);
                    let display;
                    if (typeof wv === 'boolean') {
                        display = wv ? '✓' : '✗';
                    } else if (typeof wv === 'number') {
                        display = _fmt(wv * mult);
                    } else {
                        display = String(wv);
                    }
                    const section = 'Weapon DPS';
                    if (!sections[section]) sections[section] = [];
                    sections[section].push({ key: wk, label: _labelOf(wk), value: display, unit });
                }

                if (window.WeaponStats) {
                    const profile = window.WeaponStats.getOutfitWeaponStats(item, outfitIdx);
                    if (profile) {
                        const dS = 'Weapon DPS';
                        if (profile.totalDps)       pushRawScaled(dS, '_ws_totalDps',  'Total DPS',  profile.totalDps,       'dmg/s');
                        if (profile.shieldDps)      pushRawScaled(dS, '_ws_shieldDps', 'Shield DPS', profile.shieldDps,      'dmg/s');
                        if (profile.hullDps)        pushRawScaled(dS, '_ws_hullDps',   'Hull DPS',   profile.hullDps,        'dmg/s');
                        if (profile.effectiveRange) pushRaw(dS, '_ws_range', 'Range', _fmt(profile.effectiveRange), 'px');
                        if (profile.shotsPerSecond) pushRawScaled(dS, '_ws_sps', 'Fire Rate', profile.shotsPerSecond, 'shots/s');
                        for (const [dmgKey, dps] of Object.entries(profile.dpsBreakdown || {}).sort())
                            if (dps) {
                                const safeKey = `_ws_dps_${dmgKey.replace(/\s+/g, '_')}`;
                                const label   = _labelOf(dmgKey.replace(/ damage$/, '')) + ' DPS';
                                pushRawScaled(dS, safeKey, label, dps, 'dmg/s');
                            }
                        for (const [costKey, costVal] of Object.entries(profile.firingCosts || {}).sort())
                            if (costVal) {
                                const label = _labelOf(costKey.replace(/^firing /, '')) + '/s';
                                pushRawScaled(dS, `_ws_cost_${costKey.replace(/\s+/g,'_')}`, label,
                                    costVal * profile.shotsPerSecond, '');
                            }
                    }
                }
            }
        }

        // 6. Computed stats (_fn_*, _derived_*, _sys_*) for the whole ship/outfit
        try {
            let computed = null;
            let effectiveAttrKeys = null;
            const itemContext = isShip ? 'ship'
                : (item.weapon && typeof item.weapon === 'object') ? 'weapon'
                : 'outfit';

            if (isShip && window.ComputedStats?.isReady()) {
                computed = window.ComputedStats.getComputedStats(item, item._pluginId);
                const eff = _buildEffectiveAttrs(item, effectiveOutfitIdx);
                effectiveAttrKeys = new Set(Object.keys(eff));
            } else if (!isShip && window.ComputedStats?.isReady()) {
                const OUTFIT_META_SKIP = new Set([
                    'name','category','series','index','cost','thumbnail','sprite',
                    'description','pluginId','governments','locations',
                    '_internalId','_pluginId','_hash',
                ]);
                const flat = {};
                for (const [k, v] of Object.entries(item)) {
                    if (OUTFIT_META_SKIP.has(k)) continue;
                    if (typeof v === 'number') flat[k] = v;
                }
                // Only use top-level outfit attrs for filtering — NOT weapon sub-object
                // attrs (like projectile turn, velocity, lifetime) since those are weapon
                // behaviour keys flagged isWeaponDataKey, not ship stat drivers.
                effectiveAttrKeys = new Set(Object.keys(flat));
                computed = window.ComputedStats.getComputedStatsForAttrs(flat);
            }

            // Filter computed keys — only keep values whose driving attributes
            // are actually present on this item.
            // For pure outfits: require 2+ attributesRead matches to avoid
            // ship-aggregate functions firing on single incidental attr matches.
            if (computed && effectiveAttrKeys && window.attrDefs) {
                const fns     = window.attrDefs.shipFunctions              || {};
                const intVars = window.attrDefs.shipDisplay?.intermediateVars || {};
                const sysF    = window.attrDefs.systemAwareFormulas           || {};

                for (const k of Object.keys(computed)) {
                    if (k.startsWith('_fn_')) {
                        const fnDef = fns[k.slice(4)];
                        if (!fnDef) { delete computed[k]; continue; }
                        const reads = fnDef.attributesRead || [];
                        if (reads.length === 0) { delete computed[k]; continue; }
                        const matchingReads = reads.filter(a => effectiveAttrKeys.has(a));
                        if (matchingReads.length === 0) { delete computed[k]; continue; }
                        // For pure outfits and weapon outfits: require 2+ matching reads
                        // so ship-aggregate fns don't fire on a single attr match.
                        if (!isShip && matchingReads.length < 2 && reads.length > 1) {
                            delete computed[k]; continue;
                        }
                        continue;
                    }
                    if (k.startsWith('_derived_')) {
                        const stripped = k
                            .replace(/^_derived_energy_/, '')
                            .replace(/^_derived_heat_/, '')
                            .replace(/^_derived_/, '');
                        const formula = intVars[stripped];
                        if (!formula) { delete computed[k]; continue; }
                        const refs = [...formula.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
                        if (refs.length === 0) { delete computed[k]; continue; }
                        if (!refs.some(a => effectiveAttrKeys.has(a))) { delete computed[k]; continue; }
                        continue;
                    }
                    if (k.startsWith('_sys_')) {
                        const formula = sysF[k.slice(5).replace(/_/g, ' ')]?.formula;
                        if (!formula) { delete computed[k]; continue; }
                        const refs = [...formula.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
                        if (refs.length === 0) { delete computed[k]; continue; }
                        if (!refs.some(a => effectiveAttrKeys.has(a))) { delete computed[k]; continue; }
                        continue;
                    }
                }
            }

            if (computed) {
                for (const [k, v] of Object.entries(computed)) {
                    if (COMPUTED_SKIP.has(k) || seen.has(k)) continue;
                    if (v === null || v === undefined) continue;
                    if (typeof v === 'number' && (isNaN(v) || v === 0)) continue;
                    if (typeof v === 'object') continue;

                    const isComputedKey =
                        k.startsWith('_fn_')      ||
                        k.startsWith('_derived_') ||
                        k.startsWith('_sys_')     ||
                        k.startsWith('_ws_')      ||
                        k.startsWith('_total')    ||
                        k === '_outfitMass';
                    if (!isComputedKey) continue;

                    seen.add(k);

                    let section = 'Derived Stats';
                    if (k.startsWith('_ws_'))                                 section = 'Weapon DPS';
                    else if (k === '_outfitMass' || k === '_totalOutfitCost') section = 'General';

                    let display = v;
                    let unit    = '';

                    if (k.startsWith('_fn_')) {
                        const fnName = k.slice(4);
                        const fnDef  = window.attrDefs?.shipFunctions?.[fnName];
                        const scale  = fnDef?.displayScale;
                        display = (typeof scale === 'number' && scale !== 0 && scale !== 1)
                            ? v * scale
                            : v;
                        unit = _inferFnUnit(fnName);
                    } else if (k.startsWith('_derived_energy_')) {
                        unit = 'e/s';
                    } else if (k.startsWith('_derived_heat_')) {
                        unit = 'h/s';
                    } else if (k.startsWith('_sys_')) {
                        unit = '/s';
                    } else if (k.startsWith('_ws_') && k.toLowerCase().includes('dps')) {
                        unit = 'dmg/s';
                    }

                    if (typeof display === 'number') display = display * qty;

                    if (!sections[section]) sections[section] = [];
                    sections[section].push({
                        key:   k,
                        label: _labelOf(k),
                        value: typeof display === 'number' ? _fmt(display) : String(display),
                        unit,
                    });
                }
            }
        } catch (_) {}

        return sections;
    }
    
    // ── Diff two section maps ─────────────────────────────────────────────────
    // Returns a map of section → rows that differ (changed value or new key).
    // Only used for ships — outfits have no sub-outfit layering.

    function _diffSectionMaps(baseMap, outfitMap) {
        const diff = {};
        // All sections present in the outfit map
        for (const [section, outfitRows] of Object.entries(outfitMap)) {
            const baseRows  = baseMap[section] || [];
            const baseLookup = {};
            for (const r of baseRows) baseLookup[r.key] = r.value + (r.unit ? ' ' + r.unit : '');

            const changedRows = [];
            for (const r of outfitRows) {
                const outfitDisplayVal = r.value + (r.unit ? ' ' + r.unit : '');
                const baseDisplayVal   = baseLookup[r.key];
                // Row is "changed" if value differs OR it is brand new (not in base)
                if (outfitDisplayVal !== baseDisplayVal) {
                    changedRows.push(r);
                }
            }
            if (changedRows.length) diff[section] = changedRows;
        }
        return diff;
    }

    // ── Colouring engine ──────────────────────────────────────────────────────

    // Keys that are always lower-is-better regardless of other signals.
    const _ALWAYS_LOWER_BETTER = new Set([
        'mass', 'drag', 'cost',
        'energy consumption', 'fuel consumption', 'heat generation',
        'cooling energy', 'cooling inefficiency',
        'required crew', 'mandatory crew',
    ]);

    // Prefixes that indicate an attribute is a *cost* paid while performing
    // an action. Combined with a cost suffix this reliably identifies lower-
    // is-better attrs without needing to enumerate every one individually.
    const _COST_PREFIX_RE = /^(firing |thrusting |turning |afterburner |reverse thrusting |cloaking |delayed shield |delayed hull )/;

    // Suffixes that mark resource consumption (as opposed to generation).
    const _COST_SUFFIX_RE = / (energy|heat|fuel|shields|hull)$/;

    // Prefixes for resistance *costs* not already caught by isStatusResistanceCost.
    // (All the "*  resistance energy/fuel/heat" keys have isStatusResistanceCost=true
    // in the JSON so they are handled separately, but this catches any gaps.)
    const _RESISTANCE_COST_RE = /^(burn|corrosion|discharge|disruption|ion|scramble|slowing|leak) resistance (energy|fuel|heat)$/;

    // Determine whether lower is better for a given attribute key.
    // attrRecord is the entry from window.attrDefs.attributes[key], or null.
    // label is the display label (used only as a fallback for computed keys).
    function _isLowerBetter(key, label) {
        // Skip colouring for capacity/slot keys — they're consumed as negatives
        // and the sign already encodes direction; colouring would be misleading.
        const rec = _getAttrRecord(key);

        // 1. Explicit JSON flags
        if (rec?.isStatusResistanceCost) return true;
        if (rec?.isExpectedNegative)     return false; // handled separately

        // 2. Delay attributes (wait time in seconds = bad to have more of)
        if (rec?.displayUnit === 's')    return true;

        // 3. Hard-coded always-lower set
        if (_ALWAYS_LOWER_BETTER.has(key)) return true;

        // 4. Action-cost pattern: prefix + cost suffix
        //    e.g. "thrusting energy", "firing heat", "cloaking fuel",
        //         "afterburner shields", "delayed shield energy"
        if (_COST_PREFIX_RE.test(key) && _COST_SUFFIX_RE.test(key)) return true;

        // 5. Resistance costs not already caught by flag
        if (_RESISTANCE_COST_RE.test(key)) return true;

        // 6. "shield energy", "hull energy", "shield heat", "hull heat",
        //    "shield fuel", "hull fuel" — costs of regen/repair, NOT outputs.
        //    Distinguished from "shield generation" / "hull repair rate" by suffix.
        if (/^(shield|hull) (energy|heat|fuel)$/.test(key)) return true;

        // 7. Fallback for computed/internal keys: use label heuristic
        if (key.startsWith('_')) {
            const l = (label || key).toLowerCase();
            if (/(cost|consumption|heat gen|delay|mass)/.test(l)) return true;
        }

        return false;
    }

    // Parse a display string like "1,234.5 dmg/s" → 1234.5, or null if not numeric.
    function _parseDisplayNum(str) {
        if (typeof str !== 'string' || str === '—' || str === '') return null;
        const cleaned = str.replace(/,/g, '').trim().split(/\s+/)[0];
        if (cleaned.startsWith('×')) return parseFloat(cleaned.slice(1));
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
    }

    // Given an array of numeric values (some may be null = missing), return
    // an array of colour classes.
    // Rules:
    //   • Missing (null) → '' always
    //   • All present values the same → all 'compare-val--best'
    //   • Otherwise: best group → 'compare-val--best', worst → 'compare-val--worst'
    //   • lowerBetter inverts which end is "best"
    function _colourClasses(nums, lowerBetter) {
        const present = nums.filter(n => n !== null);
        if (present.length < 1) return nums.map(() => '');
        const min = Math.min(...present);
        const max = Math.max(...present);
        if (min === max) return nums.map(n => n === null ? '' : 'compare-val--best');
        const bestVal  = lowerBetter ? min : max;
        const worstVal = lowerBetter ? max : min;
        return nums.map(n => {
            if (n === null)     return '';
            if (n === bestVal)  return 'compare-val--best';
            if (n === worstVal) return 'compare-val--worst';
            return '';
        });
    }

    // Helper: get the raw numeric value for a key from a map array entry.
    function _getRawFromMaps(maps, itemIdx, key) {
        for (const rows of Object.values(maps[itemIdx])) {
            const r = rows.find(r => r.key === key);
            if (r) return _parseDisplayNum(r.value);
        }
        return null;
    }

    // Build a colour-class lookup for all rows across all items.
    //   colourMap[key]          → [class_item0, class_item1, ...]   (base rows)
    //   colourMap['wo::' + key] → [class_item0, class_item1, ...]   (with-outfits rows)
    //
    // With-outfits rule: if ANY item changed a key in the wo layer, ALL items
    // contribute their wo value (falling back to base if unchanged) for that
    // comparison. Items that don't have the value at all stay uncoloured.
    // Sections whose names start with these prefixes are per-item detail blocks
    // (individual outfit / weapon breakdowns) and should not be coloured.
    function _isDetailSection(section) {
        return section.startsWith('Outfit: ') || section.startsWith('Weapon: ');
    }

    function _buildColourMap(baseMaps, outfitMaps, diffMaps, itemCount) {
        const allBaseKeys = new Map();
        for (const map of baseMaps)
            for (const [section, rows] of Object.entries(map))
                if (!_isDetailSection(section))
                    for (const { key, label } of rows)
                        if (!allBaseKeys.has(key)) allBaseKeys.set(key, label);

        const allWoKeys = new Map();
        for (const dMap of diffMaps)
            for (const [section, rows] of Object.entries(dMap))
                if (!_isDetailSection(section))
                    for (const { key, label } of rows)
                        if (!allWoKeys.has(key)) allWoKeys.set(key, label);

        const colourMap = {};

        for (const [key, label] of allBaseKeys) {
            const nums = Array.from({ length: itemCount }, (_, i) =>
                _getRawFromMaps(baseMaps, i, key));
            colourMap[key] = _colourClasses(nums, _isLowerBetter(key, label));
        }

        for (const [key, label] of allWoKeys) {
            const nums = Array.from({ length: itemCount }, (_, i) => {
                const n = _getRawFromMaps(outfitMaps, i, key);
                return n !== null ? n : _getRawFromMaps(baseMaps, i, key);
            });
            colourMap['wo::' + key] = _colourClasses(nums, _isLowerBetter(key, label));
        }

        return colourMap;
    }

    // ── DOM bootstrap ─────────────────────────────────────────────────────────

    function init() {
        _injectBar();
        _injectPanel();
        window.addEventListener('compareListChanged', () => {
            _refreshBar();
            if (_panelOpen) _renderPanelContent();
        });
    }

    // ── Bottom bar ────────────────────────────────────────────────────────────

    function _injectBar() {
        const bar = document.createElement('div');
        bar.id        = 'compareBar';
        bar.className = 'compare-bar';
        bar.innerHTML = `
            <div class="compare-bar__left">
                <span class="compare-bar__icon">⚖</span>
                <div class="compare-bar__scroll" id="compareBarScroll">
                    <span class="compare-bar__label" id="compareBarLabel">Compare — nothing selected</span>
                    <div class="compare-bar__chips" id="compareBarChips"></div>
                </div>
            </div>
            <div class="compare-bar__right">
                <button class="compare-bar__clear" id="compareBarClear" onclick="window.CompareDisplay.clearAll()">Clear</button>
                <button class="compare-bar__open"  id="compareBarOpen"  onclick="window.CompareDisplay.togglePanel()">
                    <span id="compareBarOpenLabel">Open Compare ▲</span>
                </button>
            </div>
        `;
        document.body.appendChild(bar);
        _refreshBar();
    }

    function _refreshBar() {
        const items     = window.CompareManager.getItems();
        const count     = items.length;
        const label     = document.getElementById('compareBarLabel');
        const chips     = document.getElementById('compareBarChips');
        const clearBtn  = document.getElementById('compareBarClear');
        const openBtn   = document.getElementById('compareBarOpen');
        const openLabel = document.getElementById('compareBarOpenLabel');
        const bar       = document.getElementById('compareBar');
        if (!label) return;

        const groupType = window.CompareManager.getGroupType();
        const groupStr  = groupType === 'ship' ? 'ships/variants' : 'outfits';
        label.textContent = count === 0
            ? 'Compare — nothing selected'
            : `Compare — ${count} ${groupStr}`;

        chips.innerHTML = '';
        items.forEach(item => {
            const chip = document.createElement('span');
            chip.className = 'compare-bar__chip';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = item['display name'] || item.name || '?';
            chip.appendChild(nameSpan);
            const x = document.createElement('button');
            x.className   = 'compare-bar__chip-remove';
            x.textContent = '×';
            x.onclick = (e) => { e.stopPropagation(); window.CompareManager.remove(item); };
            chip.appendChild(x);
            chips.appendChild(chip);
        });

        clearBtn.style.display = count > 0 ? '' : 'none';
        openBtn.style.display  = count > 1 ? '' : 'none';
        openLabel.textContent  = _panelOpen ? 'Close Compare ▼' : 'Open Compare ▲';
        bar.classList.toggle('compare-bar--has-items', count > 0);

        // "Create Group" button
        let createGroupBtn = document.getElementById('compareCreateGroup');
        const singles = items.filter(i => !i._isGroup);
        if (!createGroupBtn) {
            createGroupBtn = document.createElement('button');
            createGroupBtn.id        = 'compareCreateGroup';
            createGroupBtn.className = 'compare-bar__create-group';
            createGroupBtn.textContent = '+ Group';
            const rightBar = document.getElementById('compareBarClear');
            if (rightBar?.parentNode) rightBar.parentNode.insertBefore(createGroupBtn, rightBar);
        }
        createGroupBtn.style.display = singles.length >= 2 ? '' : 'none';
        createGroupBtn.onclick = () => _openGroupBuilder(null);
    }
    
    // ── Panel ─────────────────────────────────────────────────────────────────

    function _injectPanel() {
        const panel = document.createElement('div');
        panel.id        = 'comparePanel';
        panel.className = 'compare-panel';
        panel.innerHTML = `
            <div class="compare-panel__header">
                <h2 class="compare-panel__title">⚖ Compare</h2>
                <div class="compare-panel__controls">
                    <div class="compare-toggle" id="compareToggle">
                        <button class="compare-toggle__btn compare-toggle__btn--active" data-mode="columns" onclick="window.CompareDisplay.setViewMode('columns')">Columns</button>
                        <button class="compare-toggle__btn" data-mode="table" onclick="window.CompareDisplay.setViewMode('table')">Table</button>
                    </div>
                    <button class="compare-panel__close" onclick="window.CompareDisplay.togglePanel()">✕</button>
                </div>
            </div>
            <div class="compare-panel__body" id="comparePanelBody">
                <p class="compare-empty">Add at least two items to compare.</p>
            </div>
        `;
        document.body.appendChild(panel);
    }

    function _renderPanelContent() {
        const body  = document.getElementById('comparePanelBody');
        const items = window.CompareManager.getItems();
        if (!body) return;
        body.innerHTML = '';
        if (items.length < 2) {
            body.innerHTML = '<p class="compare-empty">Add at least two items to compare.</p>';
            return;
        }

        if (_viewMode === 'columns') _renderColumns(body, items);
        else                         _renderTable(body, items);
    }

    // Resolve the attr map for any list entry — single item or group
    function _resolveAttrMap(entry, qty, includeOutfits) {
        if (entry._isGroup) return _buildGroupAttrMap(entry);
        return includeOutfits
            ? _buildAttrMap(entry, qty, includeOutfits)
            : _buildAttrMap(entry, qty, false);
    }

    // ── Quantity control widget ───────────────────────────────────────────────

    function _makeQtyControl(item) {
        const wrap = document.createElement('div');
        wrap.className = 'compare-qty';

        const dec = document.createElement('button');
        dec.className   = 'compare-qty__btn';
        dec.textContent = '−';
        dec.title       = 'Decrease quantity';

        const display = document.createElement('span');
        display.className = 'compare-qty__val';
        display.textContent = `×${_getQty(item)}`;

        const inc = document.createElement('button');
        inc.className   = 'compare-qty__btn';
        inc.textContent = '+';
        inc.title       = 'Increase quantity';

        dec.onclick = () => {
            const newQty = _getQty(item) - 1;
            _setQty(item, newQty);
            display.textContent = `×${_getQty(item)}`;
        };

        inc.onclick = () => {
            const newQty = _getQty(item) + 1;
            _setQty(item, newQty);
            display.textContent = `×${_getQty(item)}`;
        };

        wrap.appendChild(dec);
        wrap.appendChild(display);
        wrap.appendChild(inc);
        return wrap;
    }

    // ── Section row renderer (shared by columns view) ─────────────────────────

    // colourMap: output of _buildColourMap. itemIdx: which column this is.
    // withOutfits: use 'wo::key' colour lookup instead of 'key'.
    function _appendSectionRows(col, rows, colourMap, itemIdx, withOutfits) {
        for (const rowData of rows) {
            const { key, label, value, unit, isDivider } = rowData;

            // Group member quantity spinner row
            if (rowData._isGroupMemberQtyRow) {
                const row = document.createElement('div');
                row.className = 'compare-col__row compare-col__row--qty';
                const k = document.createElement('div');
                k.className   = 'compare-col__key';
                k.textContent = label;
                const qCtrl = _makeGroupMemberQtyControl(rowData._groupId, rowData._memberIdx, value);
                row.appendChild(k);
                row.appendChild(qCtrl);
                col.appendChild(row);
                continue;
            }

            if ((label.startsWith('—') && !value) || isDivider) {
                const div = document.createElement('div');
                div.className   = 'compare-col__divider';
                div.textContent = label;
                col.appendChild(div);
                continue;
            }
            const row = document.createElement('div');
            row.className = 'compare-col__row';
            const k = document.createElement('div');
            k.className   = 'compare-col__key';
            k.textContent = label;
            const v = document.createElement('div');
            let colourCls = '';
            if (colourMap && key) {
                const lookup = colourMap[withOutfits ? 'wo::' + key : key];
                colourCls = (lookup && itemIdx < lookup.length) ? lookup[itemIdx] : '';
            }
            v.className   = 'compare-col__val' + (colourCls ? ' ' + colourCls : '');
            v.textContent = unit ? `${value} ${unit}` : value;
            row.appendChild(k);
            row.appendChild(v);
            col.appendChild(row);
        }
    }

    // Inline qty spinner for a group member (no panel re-render on every keypress)
    function _makeGroupMemberQtyControl(groupId, memberIdx, currentDisplay) {
        const wrap = document.createElement('div');
        wrap.className = 'compare-qty';

        const dec = document.createElement('button');
        dec.className = 'compare-qty__btn';
        dec.textContent = '−';

        const display = document.createElement('span');
        display.className = 'compare-qty__val';
        display.textContent = `×${_getGroupMemberQty(groupId, memberIdx)}`;

        const inc = document.createElement('button');
        inc.className = 'compare-qty__btn';
        inc.textContent = '+';

        dec.onclick = () => {
            const n = _getGroupMemberQty(groupId, memberIdx) - 1;
            _setGroupMemberQty(groupId, memberIdx, n);
            display.textContent = `×${_getGroupMemberQty(groupId, memberIdx)}`;
        };
        inc.onclick = () => {
            const n = _getGroupMemberQty(groupId, memberIdx) + 1;
            _setGroupMemberQty(groupId, memberIdx, n);
            display.textContent = `×${_getGroupMemberQty(groupId, memberIdx)}`;
        };

        wrap.appendChild(dec);
        wrap.appendChild(display);
        wrap.appendChild(inc);
        return wrap;
    }

    // ── Columns view ──────────────────────────────────────────────────────────

    function _renderColumns(container, items) {
        const isShipGroup = window.CompareManager.getGroupType() === 'ship';

        const baseMaps   = items.map(entry => entry._isGroup
            ? _buildGroupAttrMap(entry, false)
            : (isShipGroup ? _buildAttrMap(entry, _getQty(entry), false)
                           : _buildAttrMap(entry, _getQty(entry), true)));
        const outfitMaps = items.map(entry => entry._isGroup
            ? _buildGroupAttrMap(entry, true)
            : (isShipGroup ? _buildAttrMap(entry, _getQty(entry), true)
                           : _buildAttrMap(entry, _getQty(entry), true)));
        const diffMaps   = isShipGroup
            ? items.map((entry, i) => _diffSectionMaps(baseMaps[i], outfitMaps[i]))
            : items.map(() => ({}));

        const colourMap = _buildColourMap(baseMaps, outfitMaps, diffMaps, items.length);

        const grid = document.createElement('div');
        grid.className = 'compare-columns';
        grid.style.gridTemplateColumns = `repeat(${items.length}, minmax(240px, 1fr))`;

        items.forEach((item, idx) => {
            const col = document.createElement('div');
            col.className = 'compare-col' + (item._isGroup ? ' compare-col--group' : '');

            // Header
            const header = document.createElement('div');
            header.className = 'compare-col__header';

            const removeBtn = document.createElement('button');
            removeBtn.className   = 'compare-col__remove';
            removeBtn.textContent = '× Remove';
            removeBtn.onclick     = () => item._isGroup
                ? window.CompareManager.removeGroup(item._groupId)
                : window.CompareManager.remove(item);

            const nameEl = document.createElement('div');
            nameEl.className   = 'compare-col__name';
            nameEl.textContent = item._isGroup ? item.name : (item['display name'] || item.name || 'Unknown');

            header.appendChild(removeBtn);

            if (item._isGroup) {
                header.appendChild(nameEl);

                const groupMeta = document.createElement('div');
                groupMeta.className = 'compare-col__group-meta';

                const memberCount = document.createElement('div');
                memberCount.className   = 'compare-col__member-count';
                memberCount.textContent = `${item.members.length} item${item.members.length !== 1 ? 's' : ''}`;

                const editBtn = document.createElement('button');
                editBtn.className   = 'compare-col__edit-group';
                editBtn.textContent = '✎ Edit group';
                editBtn.onclick     = () => _openGroupBuilder(item);

                groupMeta.appendChild(memberCount);
                groupMeta.appendChild(editBtn);
                header.appendChild(groupMeta);

                // Member list with per-member qty spinners
                const memberList = document.createElement('div');
                memberList.className = 'compare-col__member-list';

                item.members.forEach((m, i) => {
                    const memberName = m.item['display name'] || m.item.name || `Member ${i + 1}`;

                    const row = document.createElement('div');
                    row.className = 'compare-col__member-row';

                    const nameSpan = document.createElement('span');
                    nameSpan.className   = 'compare-col__member-name';
                    nameSpan.textContent = memberName;

                    const qtyWrap = document.createElement('div');
                    qtyWrap.className = 'compare-qty compare-qty--sm';

                    const dec = document.createElement('button');
                    dec.className   = 'compare-qty__btn';
                    dec.textContent = '−';

                    const display = document.createElement('span');
                    display.className   = 'compare-qty__val';
                    display.textContent = `×${_getGroupMemberQty(item._groupId, i)}`;

                    const inc = document.createElement('button');
                    inc.className   = 'compare-qty__btn';
                    inc.textContent = '+';

                    dec.onclick = () => {
                        const n = _getGroupMemberQty(item._groupId, i) - 1;
                        _setGroupMemberQty(item._groupId, i, n);
                        display.textContent = `×${_getGroupMemberQty(item._groupId, i)}`;
                    };
                    inc.onclick = () => {
                        const n = _getGroupMemberQty(item._groupId, i) + 1;
                        _setGroupMemberQty(item._groupId, i, n);
                        display.textContent = `×${_getGroupMemberQty(item._groupId, i)}`;
                    };

                    qtyWrap.appendChild(dec);
                    qtyWrap.appendChild(display);
                    qtyWrap.appendChild(inc);

                    row.appendChild(nameSpan);
                    row.appendChild(qtyWrap);
                    memberList.appendChild(row);
                });

                header.appendChild(memberList);
            } else {
                const imgEl = document.createElement('div');
                imgEl.className = 'compare-col__img';
                _loadThumb(item, imgEl);
                const subEl = document.createElement('div');
                subEl.className   = 'compare-col__sub';
                subEl.textContent = item['display name']
                    ? item.name
                    : (item.attributes?.category || item.category || '');
                const qtyCtrl = _makeQtyControl(item);
                header.appendChild(imgEl);
                header.appendChild(nameEl);
                if (subEl.textContent) header.appendChild(subEl);
                header.appendChild(qtyCtrl);
            }
            col.appendChild(header);

            // Sections — use base map as the canonical section list
            const sectionMap = baseMaps[idx];
            const diffMap    = diffMaps[idx];

            const orderedSections = [
                ...SECTION_ORDER.filter(s => sectionMap[s] || outfitMaps[idx][s]),
                ...Object.keys(outfitMaps[idx]).filter(s =>
                    !SECTION_ORDER.includes(s) && !sectionMap[s]),
            ].filter((s, i, a) => a.indexOf(s) === i);

            for (const section of orderedSections) {
                const baseRows   = sectionMap[section] || [];
                const diffRows   = diffMap[section]    || [];

                // Only render the section block if there's something to show
                if (!baseRows.length && !diffRows.length) continue;

                // Base section header + rows
                if (baseRows.length) {
                    const secHeader = document.createElement('div');
                    secHeader.className   = 'compare-col__section';
                    secHeader.textContent = section;
                    col.appendChild(secHeader);
                    _appendSectionRows(col, baseRows, colourMap, idx, false);
                }

                // (with outfits) sub-section — only if there are differences
                if (diffRows.length) {
                    const subHeader = document.createElement('div');
                    subHeader.className   = 'compare-col__section compare-col__section--with-outfits';
                    subHeader.textContent = `${section} (with outfits)`;
                    col.appendChild(subHeader);
                    _appendSectionRows(col, diffRows, colourMap, idx, true);
                }

                // Edge case: section only exists in outfit map (entirely new section from outfits)
                if (!baseRows.length && diffRows.length === 0) {
                    const outfitOnlyRows = outfitMaps[idx][section] || [];
                    if (outfitOnlyRows.length) {
                        const subHeader = document.createElement('div');
                        subHeader.className   = 'compare-col__section compare-col__section--with-outfits';
                        subHeader.textContent = `${section} (with outfits)`;
                        col.appendChild(subHeader);
                        _appendSectionRows(col, outfitOnlyRows, colourMap, idx, true);
                    }
                }
            }

            grid.appendChild(col);
        });

        container.appendChild(grid);
    }

    // ── Table view ────────────────────────────────────────────────────────────

    function _renderTable(container, items) {
        const isShipGroup = window.CompareManager.getGroupType() === 'ship';

        // Groups must use _buildGroupAttrMap; singles use _buildAttrMap
        const baseMaps   = items.map(item => item._isGroup
            ? _buildGroupAttrMap(item, false)
            : (isShipGroup ? _buildAttrMap(item, _getQty(item), false)
                           : _buildAttrMap(item, _getQty(item), true)));
        const outfitMaps = items.map(item => item._isGroup
            ? _buildGroupAttrMap(item, true)
            : (isShipGroup ? _buildAttrMap(item, _getQty(item), true)
                           : _buildAttrMap(item, _getQty(item), true)));
        const diffMaps   = isShipGroup
            ? items.map((item, i) => _diffSectionMaps(baseMaps[i], outfitMaps[i]))
            : items.map(() => ({}));

        const colourMap = _buildColourMap(baseMaps, outfitMaps, diffMaps, items.length);

        // Build the ordered list of row entries, interleaving base sections and
        // their (with outfits) sub-sections immediately after.
        const sectionKeyOrder = [];
        const seenSectionKeys = new Set();

        const allSections = [
            ...SECTION_ORDER,
            ...new Set([
                ...baseMaps.flatMap(m => Object.keys(m)),
                ...outfitMaps.flatMap(m => Object.keys(m)),
            ]),
        ].filter((s, i, a) => a.indexOf(s) === i);

        for (const section of allSections) {
            let baseSectionAdded = false;
            for (const map of baseMaps) {
                for (const { key, label } of (map[section] || [])) {
                    const sk = section + '::' + key;
                    if (seenSectionKeys.has(sk)) continue;
                    seenSectionKeys.add(sk);
                    if (!baseSectionAdded) {
                        sectionKeyOrder.push({ isSectionHeader: true, section, withOutfits: false });
                        baseSectionAdded = true;
                    }
                    sectionKeyOrder.push({ isSectionHeader: false, section, key, label, withOutfits: false });
                }
            }

            let diffSectionAdded = false;
            for (const dMap of diffMaps) {
                for (const { key, label } of (dMap[section] || [])) {
                    const sk = section + '::wo::' + key;
                    if (seenSectionKeys.has(sk)) continue;
                    seenSectionKeys.add(sk);
                    if (!diffSectionAdded) {
                        sectionKeyOrder.push({ isSectionHeader: true, section, withOutfits: true });
                        diffSectionAdded = true;
                    }
                    sectionKeyOrder.push({ isSectionHeader: false, section, key, label, withOutfits: true });
                }
            }

            if (!baseSectionAdded) {
                let outfitOnlySectionAdded = false;
                for (const map of outfitMaps) {
                    for (const { key, label } of (map[section] || [])) {
                        const sk = section + '::wo::' + key;
                        if (seenSectionKeys.has(sk)) continue;
                        seenSectionKeys.add(sk);
                        if (!outfitOnlySectionAdded) {
                            sectionKeyOrder.push({ isSectionHeader: true, section, withOutfits: true });
                            outfitOnlySectionAdded = true;
                        }
                        sectionKeyOrder.push({ isSectionHeader: false, section, key, label, withOutfits: true });
                    }
                }
            }
        }

        const baseLookups = baseMaps.map(map => {
            const lut = {};
            for (const [section, rows] of Object.entries(map))
                for (const { key, value, unit } of rows)
                    lut[section + '::' + key] = unit ? `${value} ${unit}` : value;
            return lut;
        });
        const outfitLookups = outfitMaps.map(map => {
            const lut = {};
            for (const [section, rows] of Object.entries(map))
                for (const { key, value, unit } of rows)
                    lut[section + '::' + key] = unit ? `${value} ${unit}` : value;
            return lut;
        });

        const wrap = document.createElement('div');
        wrap.className = 'compare-table-wrap';

        const table = document.createElement('table');
        table.className = 'compare-table';

        const thead   = document.createElement('thead');
        const headRow = document.createElement('tr');
        const corner  = document.createElement('th');
        corner.className   = 'compare-table__corner';
        corner.textContent = 'Attribute';
        headRow.appendChild(corner);

        items.forEach(item => {
            const th = document.createElement('th');
            th.className = 'compare-table__item-header';

            const removeBtn = document.createElement('button');
            removeBtn.className   = 'compare-col__remove';
            removeBtn.textContent = '× Remove';
            removeBtn.onclick     = () => item._isGroup
                ? window.CompareManager.removeGroup(item._groupId)
                : window.CompareManager.remove(item);
            th.appendChild(removeBtn);

            if (item._isGroup) {
                // Group header — name + member list with per-member qty spinners
                const nameEl = document.createElement('div');
                nameEl.className   = 'compare-table__item-name';
                nameEl.textContent = item.name || 'Group';
                th.appendChild(nameEl);

                const memberList = document.createElement('div');
                memberList.className = 'compare-col__member-list';

                item.members.forEach((m, i) => {
                    const memberName = m.item['display name'] || m.item.name || `Member ${i + 1}`;

                    const row = document.createElement('div');
                    row.className = 'compare-col__member-row';

                    const nameSpan = document.createElement('span');
                    nameSpan.className   = 'compare-col__member-name';
                    nameSpan.textContent = memberName;

                    const qtyWrap = document.createElement('div');
                    qtyWrap.className = 'compare-qty compare-qty--sm';

                    const dec = document.createElement('button');
                    dec.className   = 'compare-qty__btn';
                    dec.textContent = '−';

                    const display = document.createElement('span');
                    display.className   = 'compare-qty__val';
                    display.textContent = `×${_getGroupMemberQty(item._groupId, i)}`;

                    const inc = document.createElement('button');
                    inc.className   = 'compare-qty__btn';
                    inc.textContent = '+';

                    dec.onclick = () => {
                        const n = _getGroupMemberQty(item._groupId, i) - 1;
                        _setGroupMemberQty(item._groupId, i, n);
                        display.textContent = `×${_getGroupMemberQty(item._groupId, i)}`;
                    };
                    inc.onclick = () => {
                        const n = _getGroupMemberQty(item._groupId, i) + 1;
                        _setGroupMemberQty(item._groupId, i, n);
                        display.textContent = `×${_getGroupMemberQty(item._groupId, i)}`;
                    };

                    qtyWrap.appendChild(dec);
                    qtyWrap.appendChild(display);
                    qtyWrap.appendChild(inc);
                    row.appendChild(nameSpan);
                    row.appendChild(qtyWrap);
                    memberList.appendChild(row);
                });

                th.appendChild(memberList);

                const editBtn = document.createElement('button');
                editBtn.className   = 'compare-col__edit-group';
                editBtn.style.marginTop = '8px';
                editBtn.textContent = '✎ Edit group';
                editBtn.onclick     = () => _openGroupBuilder(item);
                th.appendChild(editBtn);

            } else {
                // Single item header — thumb + name + sub + qty spinner
                const img = document.createElement('div');
                img.className = 'compare-table__thumb';
                _loadThumb(item, img);

                const nameEl = document.createElement('div');
                nameEl.className   = 'compare-table__item-name';
                nameEl.textContent = item['display name'] || item.name || 'Unknown';

                const subEl = document.createElement('div');
                subEl.className   = 'compare-table__item-sub';
                subEl.textContent = item['display name']
                    ? item.name : (item.attributes?.category || item.category || '');

                const qtyCtrl = _makeQtyControl(item);

                th.appendChild(img);
                th.appendChild(nameEl);
                if (subEl.textContent) th.appendChild(subEl);
                th.appendChild(qtyCtrl);
            }

            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody  = document.createElement('tbody');
        let rowIdx   = 0;

        for (const entry of sectionKeyOrder) {
            if (entry.isSectionHeader) {
                const tr = document.createElement('tr');
                tr.className = entry.withOutfits
                    ? 'compare-table__section-row compare-table__section-row--with-outfits'
                    : 'compare-table__section-row';
                const td = document.createElement('td');
                td.colSpan   = items.length + 1;
                td.className = entry.withOutfits
                    ? 'compare-table__section-header compare-table__section-header--with-outfits'
                    : 'compare-table__section-header';
                td.textContent = entry.withOutfits
                    ? `${entry.section} (with outfits)`
                    : entry.section;
                tr.appendChild(td);
                tbody.appendChild(tr);
                continue;
            }

            if (entry.label?.startsWith('—')) continue;

            const sk   = entry.section + '::' + entry.key;
            const tr   = document.createElement('tr');
            tr.className  = (rowIdx % 2 === 0 ? 'compare-table__row--even' : 'compare-table__row--odd') +
                            (entry.withOutfits ? ' compare-table__row--with-outfits' : '');
            rowIdx++;

            const keyTd = document.createElement('td');
            keyTd.className   = 'compare-table__key' + (entry.withOutfits ? ' compare-table__key--with-outfits' : '');
            keyTd.textContent = entry.label;
            tr.appendChild(keyTd);

            const anyDiff = entry.withOutfits &&
                diffMaps.some(dMap => (dMap[entry.section] || []).some(r => r.key === entry.key));

            items.forEach((_, i) => {
                const td = document.createElement('td');
                let cellText = '—';
                if (entry.withOutfits) {
                    if (anyDiff) {
                        cellText = outfitLookups[i][sk] ?? (baseLookups[i][sk] ?? '—');
                    } else {
                        cellText = '—';
                    }
                } else {
                    cellText = baseLookups[i][sk] ?? '—';
                }
                const colourKey = entry.withOutfits ? 'wo::' + entry.key : entry.key;
                const lookup    = colourMap[colourKey];
                const colourCls = (lookup && i < lookup.length) ? lookup[i] : '';
                const applyCls  = (cellText === '—') ? '' : colourCls;
                td.className   = 'compare-table__val' +
                    (entry.withOutfits ? ' compare-table__val--with-outfits' : '') +
                    (applyCls ? ' ' + applyCls : '');
                td.textContent = cellText;
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        wrap.appendChild(table);
        container.appendChild(wrap);
    }

    // ── Group builder modal ───────────────────────────────────────────────────
    //
    // Used for both Create (existingGroup = null) and Edit (existingGroup = group).
    // Shows all current singles as checkboxes; lets user name the group.

    function _openGroupBuilder(existingGroup) {
        // Remove any existing modal
        const old = document.getElementById('compareGroupModal');
        if (old) old.remove();

        const items   = window.CompareManager.getItems();
        const singles = items.filter(i => !i._isGroup);

        const overlay = document.createElement('div');
        overlay.id        = 'compareGroupModal';
        overlay.className = 'compare-modal-overlay';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:10000',
            'display:flex', 'align-items:center', 'justify-content:center',
            'background:rgba(0,0,0,0.65)', 'backdrop-filter:blur(2px)',
        ].join(';');

        const modal = document.createElement('div');
        modal.className = 'compare-modal';

        // Detect dark/light: check body bg, then html bg, then fall back to dark
        const _detectDark = () => {
            for (const el of [document.body, document.documentElement]) {
                const bg = getComputedStyle(el).backgroundColor;
                const m  = bg.match(/\d+/g);
                if (m && !(parseInt(m[3] ?? '1') === 0)) {
                    return (parseInt(m[0]) + parseInt(m[1]) + parseInt(m[2])) / 3 < 128;
                }
                // Also check explicit style
                if (el.style.background || el.style.backgroundColor) {
                    const s = (el.style.background + el.style.backgroundColor).toLowerCase();
                    if (s.includes('#f') || s.includes('white') || s.includes('255,255')) return false;
                }
            }
            // Try reading a CSS variable as a proxy
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--bg') ||
                           getComputedStyle(document.documentElement).getPropertyValue('--background') || '';
            if (accent.includes('#f') || accent.includes('255')) return false;
            return true; // default to dark
        };
        const isDark = _detectDark();

        modal.style.cssText = [
            'display:flex', 'flex-direction:column', 'gap:1rem',
            'min-width:340px', 'max-width:520px', 'width:90vw',
            'max-height:80vh', 'overflow-y:auto',
            'padding:1.5rem', 'border-radius:10px',
            'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
            isDark ? 'background:#1e2028' : 'background:#f5f6fa',
            isDark ? 'color:#e8e8e8'     : 'color:#1a1a1a',
            isDark ? 'border:1px solid #3a3d4a' : 'border:1px solid #c8cad0',
        ].join(';');

        const title = document.createElement('h3');
        title.className   = 'compare-modal__title';
        title.textContent = existingGroup ? 'Edit Group' : 'Create Group';
        title.style.cssText = 'margin:0;font-size:1.1rem;font-weight:600;';

        // Name input
        const nameWrap = document.createElement('div');
        nameWrap.className = 'compare-modal__field';
        nameWrap.style.cssText = 'display:flex;flex-direction:column;gap:.3rem;';
        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Group name';
        nameLabel.style.cssText = 'font-size:.8rem;opacity:.7;';
        const nameInput = document.createElement('input');
        nameInput.type      = 'text';
        nameInput.className = 'compare-modal__input';
        nameInput.style.cssText = [
            'padding:.4rem .7rem','border-radius:5px','font-size:.9rem',
            'background:' + (isDark ? '#2a2d38' : '#fff'),
            'color:'      + (isDark ? '#e8e8e8' : '#1a1a1a'),
            'border:1px solid ' + (isDark ? '#4a4d5a' : '#c0c2c8'),
            'outline:none',
        ].join(';');
        nameInput.value     = existingGroup ? existingGroup.name : 'Group ' + (Date.now() % 1000);
        nameInput.placeholder = 'Group name…';
        nameWrap.appendChild(nameLabel);
        nameWrap.appendChild(nameInput);

        // Member list — for edit mode show existing members; for create show current singles
        const listWrap = document.createElement('div');
        listWrap.className = 'compare-modal__list';
        listWrap.style.cssText = [
            'display:flex','flex-direction:column','gap:.35rem',
            'max-height:300px','overflow-y:auto',
            'padding:.5rem','border-radius:6px',
            'border:1px solid ' + (isDark ? '#3a3d4a' : '#d0d2d8'),
            'background:' + (isDark ? '#161820' : '#eef0f5'),
        ].join(';');

        const listTitle = document.createElement('div');
        listTitle.className   = 'compare-modal__list-title';
        listTitle.textContent = 'Select items to include:';
        listTitle.style.cssText = 'font-size:.75rem;opacity:.6;padding-bottom:.2rem;';
        listWrap.appendChild(listTitle);

        // Build the candidate pool
        // For create: all singles currently in compare list
        // For edit: all singles in compare list; pre-check those already in the group
        const existingNames = new Set(
            existingGroup ? existingGroup.members.map(m => m.item.name + '|' + (m.item._compareTab || '')) : []
        );
        const existingQtyMap = {};
        if (existingGroup) {
            existingGroup.members.forEach((m, i) => {
                const k = m.item.name + '|' + (m.item._compareTab || '');
                existingQtyMap[k] = _getGroupMemberQty(existingGroup._groupId, i);
            });
        }

        const checkboxes = []; // { item, checkbox, qtyInput }
        singles.forEach(item => {
            const itemKey = item.name + '|' + (item._compareTab || '');
            const row = document.createElement('div');
            row.className = 'compare-modal__item-row';
            row.style.cssText = 'display:flex;align-items:center;gap:.5rem;padding:.2rem .3rem;border-radius:4px;';

            const cb = document.createElement('input');
            cb.type    = 'checkbox';
            cb.checked = !existingGroup || existingNames.has(itemKey);
            cb.style.cssText = 'cursor:pointer;flex-shrink:0;';

            const lbl = document.createElement('span');
            lbl.className   = 'compare-modal__item-label';
            lbl.textContent = item['display name'] || item.name || '?';
            lbl.style.cssText = 'flex:1;font-size:.88rem;cursor:pointer;';
            lbl.onclick = () => { cb.checked = !cb.checked; };

            const qtyWrap = document.createElement('div');
            qtyWrap.className = 'compare-modal__item-qty';

            const qDec = document.createElement('button');
            qDec.textContent = '−';
            qDec.className   = 'compare-qty__btn';

            const qVal = document.createElement('span');
            qVal.className   = 'compare-qty__val';
            const initQty    = existingQtyMap[itemKey] || 1;
            qVal.textContent = `×${initQty}`;
            let currentQty   = initQty;

            const qInc = document.createElement('button');
            qInc.textContent = '+';
            qInc.className   = 'compare-qty__btn';

            qDec.onclick = () => { currentQty = Math.max(1, currentQty - 1); qVal.textContent = `×${currentQty}`; };
            qInc.onclick = () => { currentQty = currentQty + 1;               qVal.textContent = `×${currentQty}`; };

            qtyWrap.appendChild(qDec);
            qtyWrap.appendChild(qVal);
            qtyWrap.appendChild(qInc);

            row.appendChild(cb);
            row.appendChild(lbl);
            row.appendChild(qtyWrap);
            listWrap.appendChild(row);
            checkboxes.push({ item, checkbox: cb, getQty: () => currentQty });
        });

        if (singles.length === 0) {
            const empty = document.createElement('div');
            empty.className   = 'compare-modal__empty';
            empty.textContent = 'No individual items in compare list to group.';
            listWrap.appendChild(empty);
        }

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.className = 'compare-modal__btns';
        btnRow.style.cssText = 'display:flex;gap:.5rem;justify-content:flex-end;padding-top:.25rem;';

        const _btnBase = 'padding:.4rem 1rem;border-radius:5px;cursor:pointer;font-size:.85rem;border:none;font-weight:500;';
        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'compare-modal__btn compare-modal__btn--cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = _btnBase + (isDark ? 'background:#2a2d38;color:#c0c2c8;' : 'background:#d8dae0;color:#333;');
        cancelBtn.onclick     = () => overlay.remove();

        const confirmBtn = document.createElement('button');
        confirmBtn.className   = 'compare-modal__btn compare-modal__btn--confirm';
        confirmBtn.textContent = existingGroup ? 'Save' : 'Create Group';
        confirmBtn.style.cssText = _btnBase + 'background:#3a7bd5;color:#fff;';
        confirmBtn.onclick     = () => {
            const selected = checkboxes
                .filter(c => c.checkbox.checked)
                .map(c => ({ item: c.item, qty: c.getQty() }));
            if (selected.length === 0) {
                nameInput.setCustomValidity('Select at least one item.');
                nameInput.reportValidity();
                return;
            }
            const name = nameInput.value.trim() || 'Group';
            if (existingGroup) {
                // Rebuild group member qty map with new indices
                const newQtys = {};
                selected.forEach((s, i) => { newQtys[existingGroup._groupId + '|' + i] = s.qty; });
                Object.assign(_groupMemberQtys, newQtys);
                // Clear old indices beyond new length
                for (let i = selected.length; i < existingGroup.members.length + 10; i++)
                    delete _groupMemberQtys[existingGroup._groupId + '|' + i];
                window.CompareManager.updateGroup(existingGroup._groupId, name, selected);
            } else {
                const group = window.CompareManager.addGroup(name, selected);
                if (group) {
                    // Seed the qty map with chosen quantities
                    selected.forEach((s, i) => {
                        _groupMemberQtys[group._groupId + '|' + i] = s.qty;
                    });
                }
            }
            overlay.remove();
            _renderPanelContent();
        };

        // Delete button for edit mode
        if (existingGroup) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className   = 'compare-modal__btn compare-modal__btn--delete';
            deleteBtn.textContent = 'Delete Group';
            deleteBtn.style.cssText = _btnBase + 'background:#c0392b;color:#fff;margin-right:auto;';
            deleteBtn.onclick     = () => {
                window.CompareManager.removeGroup(existingGroup._groupId);
                overlay.remove();
            };
            btnRow.appendChild(deleteBtn);
        }

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(confirmBtn);

        modal.appendChild(title);
        modal.appendChild(nameWrap);
        modal.appendChild(listWrap);
        modal.appendChild(btnRow);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Close on overlay click outside modal
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        nameInput.focus();
        nameInput.select();
    }

    // ── Sprite thumbnail ──────────────────────────────────────────────────────

    function _loadThumb(item, container) {
        container.innerHTML = '<div class="compare-thumb-placeholder"></div>';
        const spritePath = item.thumbnail || item.sprite;
        if (!spritePath || !window.fetchSprite) return;
        window.fetchSprite(spritePath, null).then(el => {
            if (!el) return;
            el.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
            container.innerHTML = '';
            container.appendChild(el);
        }).catch(() => {});
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function togglePanel() {
        _panelOpen = !_panelOpen;
        const panel = document.getElementById('comparePanel');
        if (panel) panel.classList.toggle('compare-panel--open', _panelOpen);
        _refreshBar();
        if (_panelOpen) _renderPanelContent();
    }

    function openPanel()  { if (!_panelOpen) togglePanel(); }
    function closePanel() { if (_panelOpen)  togglePanel(); }

    function setViewMode(mode) {
        _viewMode = mode;
        document.querySelectorAll('.compare-toggle__btn').forEach(btn => {
            btn.classList.toggle('compare-toggle__btn--active', btn.dataset.mode === mode);
        });
        _renderPanelContent();
    }

    function clearAll() {
        window.CompareManager.clear();
        _quantities = {};
        _groupMemberQtys = {};
        closePanel();
    }

    function openGroupBuilder() { _openGroupBuilder(null); }

    return { init, togglePanel, openPanel, closePanel, setViewMode, clearAll, openGroupBuilder };

})();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.CompareDisplay.init());
} else {
    window.CompareDisplay.init();
}
