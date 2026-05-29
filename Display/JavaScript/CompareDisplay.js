'use strict';

// ─── CompareDisplay.js ────────────────────────────────────────────────────────
//
// Renders the compare bar and panel.
//
// Attribute data gathered per item in four layers:
//   1. Effective attrs  — base ship attrs + all outfit contributions accumulated
//                         (same method as shipBuilderStats._buildEffectiveAttrs)
//   2. Raw hardpoints   — gun/turret/bay/engine counts
//   3. Computed stats   — ComputedStats.getComputedStats (_fn_*, _derived_*, _ws_*)
//   4. Heat derived     — totalHeatCapacity, maxSustainableHeatProd
//                         (same formulas as shipBuilderStats._computeHeatDerived)
//   5. Weapon detail    — per-weapon rate fields + per-second firing costs/DPS
//                         (same approach as shipBuilderStats._weaponDetailSection)
//   6. Ammo consumption — rounds/s per ammo type
//
// Both views group rows under the same sections AttributeDisplay uses.
// ─────────────────────────────────────────────────────────────────────────────

window.CompareDisplay = (() => {

    let _panelOpen = false;
    let _viewMode  = 'columns';

    const MAX_TEMP = 100; // MAXIMUM_TEMPERATURE in Ship.cpp — same as SBS

    // ── Section ordering (matches AttributeDisplay + SBS groups) ─────────────

    const SECTION_ORDER = [
        'General', 'Shields & Hull', 'Energy', 'Engines', 'Jump',
        'Cargo', 'Crew', 'Scanning', 'Cloaking', 'Resistance', 'Protection',
        'Hardpoints', 'Heat (derived)', 'Weapon DPS', 'Ammo Consumption',
        'Weapon Detail', 'Derived Stats', 'Other',
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

    const _attrDefs  = () => window.attrDefs || null;

    function _fmt(v) {
        if (window.AttributeDisplay?.fmtNum) return window.AttributeDisplay.fmtNum(v);
        if (typeof v !== 'number') return String(v);
        if (Number.isInteger(v) && Math.abs(v) >= 10000) return v.toLocaleString();
        return parseFloat(v.toPrecision(4)).toString();
    }

    function _getAttrRecord(key) {
        const defs  = _attrDefs();
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

    function _getDisplayUnit(key)         { return _getAttrRecord(key)?.displayUnit        ?? ''; }
    function _getDisplayMultiplier(key)   { return _getAttrRecord(key)?.displayMultiplier   ?? 1; }

    function _labelOf(key) {
        let s = key;
        if (s.startsWith('_fn_'))                  s = s.slice(4);
        else if (s.startsWith('_derived_energy_')) s = s.slice('_derived_energy_'.length) + ' Energy/s';
        else if (s.startsWith('_derived_heat_'))   s = s.slice('_derived_heat_'.length)   + ' Heat/s';
        else if (s.startsWith('_derived_'))        s = s.slice('_derived_'.length);
        else if (s.startsWith('_sys_'))            s = s.slice('_sys_'.length).replace(/_/g, ' ') + ' (system)';
        else if (s.startsWith('_ws_dps_'))         s = s.slice('_ws_dps_'.length).replace(/_/g, ' ') + ' DPS';
        else if (s === '_ws_totalDps')             return 'Total DPS';
        else if (s === '_ws_shieldDps')            return 'Shield DPS';
        else if (s === '_ws_hullDps')              return 'Hull DPS';
        else if (s === '_ws_weaponCount')          return 'Weapon Types';
        else if (s === '_ws_totalWeaponMounts')    return 'Total Weapon Mounts';
        else if (s === '_outfitMass')              return 'Outfit Mass';
        else if (s === '_totalOutfitCost')         return 'Total Outfit Cost';
        else if (s === '_totalOutfits')            return 'Total Outfits';
        return s.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')
                .replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase()).trim();
    }

    // ── Outfit index ──────────────────────────────────────────────────────────
    // Merged across all loaded plugins — same approach as SBS._buildOutfitIndex

    function _buildOutfitIndex() {
        const allData = window.allData || {};
        const merged  = {};
        for (const pd of Object.values(allData))
            (pd.outfits || []).forEach(o => { if (o.name && !merged[o.name]) merged[o.name] = o; });
        return merged;
    }

    // ── Effective attributes ──────────────────────────────────────────────────
    // Base ship attrs + accumulated outfit contributions.
    // Mirrors SBS._buildEffectiveAttrs exactly.

    const _META_KEYS = new Set([
        'name','display name','category','series','index','cost','thumbnail','sprite',
        'description','pluginId','weapon','governments','locations',
        '_internalId','_pluginId','_hash','_pn','_pd','_isVariant','_compareTab',
        '_variantPluginId','displayName','spriteData','attributes',
        'leaks','engines','guns','turrets','bays','reverseEngines','steeringEngines',
        'outfitMap','outfits',
    ]);

    function _buildEffectiveAttrs(item, outfitIdx) {
        const eff = {};

        // Start from base attributes
        const attrs = item.attributes || {};
        for (const [k, v] of Object.entries(attrs)) {
            if (typeof v === 'number')       eff[k] = v;
            else if (typeof v === 'string')  { const n = parseFloat(v); if (!isNaN(n)) eff[k] = n; }
        }

        // Accumulate outfit contributions
        const outfitSource = item.outfitMap || item.outfits || {};
        const entries = Array.isArray(outfitSource)
            ? outfitSource.map(e => [e.name || '', typeof e.count === 'number' ? e.count : 1])
            : Object.entries(outfitSource).map(([name, qv]) => [
                name,
                typeof qv === 'object' ? (parseInt(qv.count) || 1) : (Number(qv) || 1)
              ]);

        for (const [name, count] of entries) {
            const outfit = outfitIdx[name];
            if (!outfit) continue;
            // Pull numeric fields from outfit (flat or .attributes)
            const src = (outfit.attributes && Object.keys(outfit.attributes).length)
                ? { ...outfit, ...outfit.attributes }
                : outfit;
            for (const [key, rawVal] of Object.entries(src)) {
                if (_META_KEYS.has(key) || key.startsWith('_')) continue;
                if (typeof rawVal !== 'number' || rawVal === 0)  continue;
                eff[key] = (eff[key] || 0) + rawVal * count;
            }
        }

        return eff;
    }

    // ── Heat derived ──────────────────────────────────────────────────────────
    // totalHeatCapacity      = (shipMass + outfitMass) × MAX_TEMP
    // maxSustainableHeatProd = (totalMass + heatCap) × heatDiss × 6
    // Mirrors SBS._computeHeatDerived exactly.

    function _computeHeatDerived(item, eff, outfitIdx) {
        const shipMass = parseFloat(item.attributes?.mass ?? item.mass ?? 0) || 0;

        let outfitMassSum = 0;
        const outfitSource = item.outfitMap || item.outfits || {};
        const entries = Array.isArray(outfitSource)
            ? outfitSource.map(e => [e.name || '', typeof e.count === 'number' ? e.count : 1])
            : Object.entries(outfitSource).map(([name, qv]) => [
                name,
                typeof qv === 'object' ? (parseInt(qv.count) || 1) : (Number(qv) || 1)
              ]);

        for (const [name, count] of entries) {
            const outfit = outfitIdx[name];
            if (!outfit) continue;
            const massKey = Object.keys(outfit).find(k => k.toLowerCase() === 'mass');
            if (massKey && typeof outfit[massKey] === 'number')
                outfitMassSum += outfit[massKey] * count;
        }

        const totalMass   = shipMass + outfitMassSum;
        const heatCapKey  = Object.keys(eff).find(k => k.toLowerCase() === 'heat capacity');
        const heatDissKey = Object.keys(eff).find(k => k.toLowerCase().includes('heat dissipation'));
        const heatCap     = (heatCapKey  && typeof eff[heatCapKey]  === 'number') ? eff[heatCapKey]  : 0;
        const heatDiss    = (heatDissKey && typeof eff[heatDissKey] === 'number') ? eff[heatDissKey] : 0;

        return {
            totalHeatCapacity:      totalMass > 0 ? totalMass * MAX_TEMP : null,
            maxSustainableHeatProd: (heatDiss > 0 && (totalMass + heatCap) > 0)
                                        ? (totalMass + heatCap) * heatDiss * 6
                                        : null,
        };
    }

    // ── Weapon data ───────────────────────────────────────────────────────────
    // Fleet DPS summary + per-weapon detail rows.
    // Per-weapon detail mirrors SBS._weaponDetailSection.

    function _buildWeaponData(item, outfitIdx) {
        if (!window.WeaponStats) return null;

        const outfitSource = item.outfitMap || item.outfits || {};
        const outfitMap    = {};
        const entries = Array.isArray(outfitSource)
            ? outfitSource.map(e => [e.name || '', typeof e.count === 'number' ? e.count : 1])
            : Object.entries(outfitSource).map(([name, qv]) => [
                name,
                typeof qv === 'object' ? (parseInt(qv.count) || 1) : (Number(qv) || 1)
              ]);

        for (const [name, count] of entries)
            if (name) outfitMap[name] = (outfitMap[name] || 0) + count;

        try {
            const stats = window.WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx);
            if (stats) stats._outfitIdx = outfitIdx;
            return stats;
        } catch (_) { return null; }
    }

    // Per-weapon detail: rate/behaviour fields (from raw weapon object)
    // + per-second computed values (DPS, firing costs).
    // Returns array of { label, value, unit } — one entry per field.

    function _weaponDetailRows(outfitName, count, outfit, profile) {
        const w        = outfit.weapon || {};
        const attrMeta = _attrDefs()?.attributes || {};
        const sps      = profile.shotsPerSecond || 0;
        const rows     = [];

        if (count > 1) rows.push({ label: 'Count', value: `×${count}`, unit: '' });

        // A) Rate / behaviour fields — skip firing costs and damage (shown per-sec below)
        const weapSkip = new Set(['sprite','spriteData','sound','hit effect','fire effect',
            'die effect','live effect','submunition','submunitions','stream','cluster',
            'hardpoint sprite','hardpoint offset','icon','ammunition','ammo']);

        for (const [key, val] of Object.entries(w).sort((a, b) => a[0].localeCompare(b[0]))) {
            const lk = key.toLowerCase();
            if (weapSkip.has(lk))          continue;
            if (lk.startsWith('firing '))  continue; // → per-sec section
            if (lk.endsWith(' damage'))    continue; // → DPS section
            if (val === null || val === undefined) continue;

            let display = null;
            if (typeof val === 'boolean')      display = val ? '✓' : '✗';
            else if (typeof val === 'number' && val !== 0) {
                const meta = attrMeta[key] || {};
                display = _fmt(val * (meta.displayMultiplier ?? 1));
            }
            else if (typeof val === 'string' && val.trim()) display = val.trim();
            else if (Array.isArray(val) && val.length)
                display = val.map(el =>
                    typeof el === 'object' ? (el.type ?? el.name ?? JSON.stringify(el)) : String(el)
                ).join(', ');
            else if (typeof val === 'object' && val)
                display = val.type ?? val.name ?? JSON.stringify(val);

            if (display === null) continue;
            const meta = attrMeta[key] || {};
            rows.push({ label: _labelOf(key), value: display, unit: meta.displayUnit ?? '' });
        }

        // B) Per-second computed
        rows.push({ label: '— Per Second —', value: '', unit: '' }); // divider
        rows.push({ label: 'Shots/s', value: _fmt(sps), unit: '' });
        if (profile.effectiveRange)
            rows.push({ label: 'Range', value: _fmt(profile.effectiveRange), unit: 'px' });
        for (const [dmgKey, dps] of Object.entries(profile.dpsBreakdown || {}).sort())
            if (dps) rows.push({ label: _labelOf(dmgKey.replace(/ damage$/, '')) + ' DPS', value: _fmt(dps), unit: '/s' });
        for (const [costKey, costVal] of Object.entries(profile.firingCosts || {}).sort())
            if (costVal) rows.push({ label: _labelOf(costKey.replace(/^firing /, '')) + '/s', value: _fmt(costVal * sps), unit: '' });

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

    // ── Build rich attribute map for one item ─────────────────────────────────
    // Returns: { sectionName: [ {key, label, value, unit}, ... ] }

    function _buildAttrMap(item) {
        const sections   = {};
        const seen       = new Set();
        const outfitIdx  = _buildOutfitIndex();
        const isShip     = !!(item.attributes && typeof item.attributes === 'object');

        function push(key, rawVal, sectionOverride) {
            if (SKIP_KEYS.has(key))                          return;
            if (seen.has(key))                               return;
            if (rawVal === null || rawVal === undefined)     return;
            if (typeof rawVal === 'object')                  return;
            seen.add(key);
            const section = sectionOverride || _getSection(key);
            const mult    = _getDisplayMultiplier(key);
            const unit    = _getDisplayUnit(key);
            const display = typeof rawVal === 'number' ? _fmt(rawVal * mult) : String(rawVal);
            if (!sections[section]) sections[section] = [];
            sections[section].push({ key, label: _labelOf(key), value: display, unit });
        }

        function pushRaw(section, key, label, value, unit) {
            if (seen.has(key)) return;
            seen.add(key);
            if (!sections[section]) sections[section] = [];
            sections[section].push({ key, label, value, unit: unit || '' });
        }

        if (isShip) {
            // ── 1. Effective attributes (base + outfit contributions) ──────────
            const eff = _buildEffectiveAttrs(item, outfitIdx);
            for (const [k, v] of Object.entries(eff)) push(k, v);

            // ── 2. Hardpoints ─────────────────────────────────────────────────
            if (item.guns?.length)           pushRaw('Hardpoints', 'Guns',            'Guns',            String(item.guns.length), '');
            if (item.turrets?.length)        pushRaw('Hardpoints', 'Turrets',         'Turrets',         String(item.turrets.length), '');
            if (item.engines?.length)        pushRaw('Hardpoints', 'Engines',         'Engines',         String(item.engines.length), '');
            if (item.reverseEngines?.length) pushRaw('Hardpoints', 'ReverseEngines',  'Reverse Engines', String(item.reverseEngines.length), '');
            if (item.bays?.length) {
                const byType = {};
                item.bays.forEach(b => { byType[b.type || 'Bay'] = (byType[b.type || 'Bay'] || 0) + 1; });
                Object.entries(byType).forEach(([t, n]) => pushRaw('Hardpoints', `${t} Bays`, `${t} Bays`, String(n), ''));
            }

            // ── 3. Heat derived (SBS formulas) ────────────────────────────────
            const hd = _computeHeatDerived(item, eff, outfitIdx);
            if (hd.totalHeatCapacity != null)
                pushRaw('Heat (derived)', '_hd_totalHeatCap', 'Total Heat Capacity', _fmt(hd.totalHeatCapacity), '');
            if (hd.maxSustainableHeatProd != null)
                pushRaw('Heat (derived)', '_hd_maxSustHeat', 'Max Sustainable Heat/s', _fmt(hd.maxSustainableHeatProd), '/s');

            // ── 4. Weapon data (fleet DPS + per-weapon detail) ─────────────────
            const wData = _buildWeaponData(item, outfitIdx);
            if (wData && wData.weaponCount) {
                // Fleet DPS summary
                const dpsS = 'Weapon DPS';
                pushRaw(dpsS, '_ws_totalDps',         'Total DPS',         _fmt(wData.totalDps),          'dmg/s');
                pushRaw(dpsS, '_ws_shieldDps',        'Shield DPS',        _fmt(wData.shieldDps),         'dmg/s');
                pushRaw(dpsS, '_ws_hullDps',          'Hull DPS',          _fmt(wData.hullDps),           'dmg/s');
                pushRaw(dpsS, '_ws_weaponCount',      'Weapon Types',      String(wData.weaponCount),     '');
                pushRaw(dpsS, '_ws_totalMounts',      'Total Mounts',      String(wData.totalWeaponMounts), '');
                for (const [dmgKey, val] of Object.entries(wData.dpsByType || {}))
                    if (val) pushRaw(dpsS, `_ws_dps_${dmgKey}`, _labelOf(`_ws_dps_${dmgKey.replace(/\s+/g,'_')}`), _fmt(val), 'dmg/s');

                // Ammo consumption
                if (wData.hasAmmoWeapons) {
                    for (const a of (wData.ammoRequired || []))
                        pushRaw('Ammo Consumption', `_ammo_${a.ammoOutfitName}`,
                            a.ammoOutfitName, _fmt(a.totalShotsPerSecond), 'rounds/s');
                }

                // Per-weapon detail
                for (const w of (wData.weapons || [])) {
                    const outfit = outfitIdx[w.outfitName];
                    if (!outfit?.weapon) continue;
                    const detailRows = _weaponDetailRows(w.outfitName, w.count, outfit, w.profile);
                    const sectionKey = `Weapon: ${w.outfitName}`;
                    if (!sections[sectionKey]) sections[sectionKey] = [];
                    for (const r of detailRows) {
                        const k = `_wd_${w.outfitName}_${r.label}`;
                        if (seen.has(k)) continue;
                        seen.add(k);
                        sections[sectionKey].push({ key: k, label: r.label, value: r.value, unit: r.unit });
                    }
                    // Ensure weapon detail sections appear in order after 'Weapon Detail'
                    if (!SECTION_ORDER.includes(sectionKey)) SECTION_ORDER.push(sectionKey);
                }
            }

        } else {
            // ── Outfit ────────────────────────────────────────────────────────
            for (const [k, v] of Object.entries(item)) {
                if (SKIP_KEYS.has(k) || typeof v === 'object') continue;
                push(k, v);
            }

            if (item.weapon && typeof item.weapon === 'object') {
                const weapSkip = new Set(['sprite','spriteData','sound','hit effect','fire effect',
                    'die effect','submunition','submunitions','stream','cluster',
                    'hardpoint sprite','hardpoint offset','icon','ammunition','ammo']);
                for (const [wk, wv] of Object.entries(item.weapon)) {
                    if (weapSkip.has(wk) || typeof wv === 'object' || Array.isArray(wv)) continue;
                    push(wk, wv, 'Weapon DPS');
                }

                if (window.WeaponStats) {
                    const profile = window.WeaponStats.getOutfitWeaponStats(item, outfitIdx);
                    if (profile) {
                        const dS = 'Weapon DPS';
                        if (profile.totalDps)       pushRaw(dS, '_ws_totalDps',    'Total DPS',   _fmt(profile.totalDps),          'dmg/s');
                        if (profile.shieldDps)      pushRaw(dS, '_ws_shieldDps',   'Shield DPS',  _fmt(profile.shieldDps),         'dmg/s');
                        if (profile.hullDps)        pushRaw(dS, '_ws_hullDps',     'Hull DPS',    _fmt(profile.hullDps),           'dmg/s');
                        if (profile.effectiveRange) pushRaw(dS, '_ws_range',       'Range',       _fmt(profile.effectiveRange),    'px');
                        if (profile.shotsPerSecond) pushRaw(dS, '_ws_sps',         'Fire Rate',   _fmt(profile.shotsPerSecond),    'shots/s');
                        // Firing costs per second
                        for (const [costKey, costVal] of Object.entries(profile.firingCosts || {}))
                            if (costVal) pushRaw(dS, `_ws_cost_${costKey}`,
                                _labelOf(costKey.replace(/^firing /, '')) + '/s',
                                _fmt(costVal * profile.shotsPerSecond), '');
                    }
                }
            }
        }

        // ── 5. Computed stats (_fn_*, _derived_*, _sys_*) ─────────────────────
        try {
            let computed = null;
            if (isShip && window.ComputedStats?.isReady())
                computed = window.ComputedStats.getComputedStats(item, item._pluginId);
            else if (!isShip && window.ComputedStats?.isReady()) {
                const flat = Object.fromEntries(Object.entries(item).filter(([, v]) => typeof v === 'number'));
                computed = window.ComputedStats.getComputedStatsForAttrs(flat);
            }

            if (computed) {
                for (const [k, v] of Object.entries(computed)) {
                    if (COMPUTED_SKIP.has(k) || seen.has(k)) continue;
                    if (v === null || v === undefined || (typeof v === 'number' && (isNaN(v) || v === 0))) continue;
                    if (typeof v === 'object') continue;

                    const isComputedKey = k.startsWith('_fn_')  || k.startsWith('_derived_') ||
                                          k.startsWith('_sys_') || k.startsWith('_ws_')       ||
                                          k.startsWith('_total') || k === '_outfitMass';
                    if (!isComputedKey) continue;

                    seen.add(k);
                    let section = 'Derived Stats';
                    if (k.startsWith('_ws_'))                       section = 'Weapon DPS';
                    else if (k === '_outfitMass' || k === '_totalOutfitCost') section = 'General';

                    let display = v;
                    if (k.startsWith('_fn_')) {
                        const fnName = k.slice(4);
                        const scale  = _attrDefs()?.shipFunctions?.[fnName]?.displayScale;
                        if (scale) display = v * scale;
                    }

                    const unit = (k.startsWith('_ws_') && k.includes('Dps')) ? 'dmg/s' : '';
                    if (!sections[section]) sections[section] = [];
                    sections[section].push({ key: k, label: _labelOf(k), value: _fmt(display), unit });
                }
            }
        } catch (_) {}

        return sections;
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

    // ── Columns view ──────────────────────────────────────────────────────────

    function _renderColumns(container, items) {
        const attrMaps = items.map(_buildAttrMap);

        const grid = document.createElement('div');
        grid.className = 'compare-columns';
        grid.style.gridTemplateColumns = `repeat(${items.length}, minmax(240px, 1fr))`;

        items.forEach((item, idx) => {
            const col = document.createElement('div');
            col.className = 'compare-col';

            // Header
            const header = document.createElement('div');
            header.className = 'compare-col__header';

            const removeBtn = document.createElement('button');
            removeBtn.className   = 'compare-col__remove';
            removeBtn.textContent = '× Remove';
            removeBtn.onclick     = () => window.CompareManager.remove(item);

            const imgEl = document.createElement('div');
            imgEl.className = 'compare-col__img';
            _loadThumb(item, imgEl);

            const nameEl = document.createElement('div');
            nameEl.className   = 'compare-col__name';
            nameEl.textContent = item['display name'] || item.name || 'Unknown';

            const subEl = document.createElement('div');
            subEl.className   = 'compare-col__sub';
            subEl.textContent = item['display name']
                ? item.name
                : (item.attributes?.category || item.category || '');

            header.appendChild(removeBtn);
            header.appendChild(imgEl);
            header.appendChild(nameEl);
            if (subEl.textContent) header.appendChild(subEl);
            col.appendChild(header);

            // Sections
            const sectionMap = attrMaps[idx];
            const orderedSections = [
                ...SECTION_ORDER.filter(s => sectionMap[s]),
                ...Object.keys(sectionMap).filter(s => !SECTION_ORDER.includes(s)),
            ];

            for (const section of orderedSections) {
                const rows = sectionMap[section];
                if (!rows?.length) continue;

                const secHeader = document.createElement('div');
                secHeader.className   = 'compare-col__section';
                secHeader.textContent = section;
                col.appendChild(secHeader);

                for (const { label, value, unit } of rows) {
                    // Divider row (weapon detail separator)
                    if (label.startsWith('—') && !value) {
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
                    v.className   = 'compare-col__val';
                    v.textContent = unit ? `${value} ${unit}` : value;
                    row.appendChild(k);
                    row.appendChild(v);
                    col.appendChild(row);
                }
            }

            grid.appendChild(col);
        });

        container.appendChild(grid);
    }

    // ── Table view ────────────────────────────────────────────────────────────

    function _renderTable(container, items) {
        const attrMaps = items.map(_buildAttrMap);

        const sectionKeyOrder = [];
        const seenSectionKeys = new Set();

        const allSections = [
            ...SECTION_ORDER,
            ...new Set(attrMaps.flatMap(m => Object.keys(m))),
        ].filter((s, i, a) => a.indexOf(s) === i);

        for (const section of allSections) {
            let sectionAdded = false;
            for (const map of attrMaps) {
                for (const { key, label } of (map[section] || [])) {
                    const sk = section + '::' + key;
                    if (seenSectionKeys.has(sk)) continue;
                    seenSectionKeys.add(sk);
                    if (!sectionAdded) {
                        sectionKeyOrder.push({ isSectionHeader: true, section });
                        sectionAdded = true;
                    }
                    sectionKeyOrder.push({ isSectionHeader: false, section, key, label });
                }
            }
        }

        const lookups = attrMaps.map(map => {
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

        // Header
        const thead   = document.createElement('thead');
        const headRow = document.createElement('tr');
        const corner  = document.createElement('th');
        corner.className   = 'compare-table__corner';
        corner.textContent = 'Attribute';
        headRow.appendChild(corner);

        items.forEach(item => {
            const th = document.createElement('th');
            th.className = 'compare-table__item-header';

            const img = document.createElement('div');
            img.className = 'compare-table__thumb';
            _loadThumb(item, img);

            const nameEl = document.createElement('div');
            nameEl.className   = 'compare-table__item-name';
            nameEl.textContent = item['display name'] || item.name || 'Unknown';

            const subEl = document.createElement('div');
            subEl.className   = 'compare-table__item-sub';
            subEl.textContent = item['display name']
                ? item.name
                : (item.attributes?.category || item.category || '');

            const removeBtn = document.createElement('button');
            removeBtn.className   = 'compare-col__remove';
            removeBtn.textContent = '× Remove';
            removeBtn.onclick     = () => window.CompareManager.remove(item);

            th.appendChild(removeBtn);
            th.appendChild(img);
            th.appendChild(nameEl);
            if (subEl.textContent) th.appendChild(subEl);
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        // Body
        const tbody  = document.createElement('tbody');
        let rowIdx   = 0;

        for (const entry of sectionKeyOrder) {
            if (entry.isSectionHeader) {
                const tr = document.createElement('tr');
                tr.className = 'compare-table__section-row';
                const td = document.createElement('td');
                td.colSpan       = items.length + 1;
                td.className     = 'compare-table__section-header';
                td.textContent   = entry.section;
                tr.appendChild(td);
                tbody.appendChild(tr);
                continue;
            }

            // Skip divider rows in table view
            if (entry.label?.startsWith('—')) continue;

            const sk = entry.section + '::' + entry.key;
            const tr = document.createElement('tr');
            tr.className = rowIdx % 2 === 0 ? 'compare-table__row--even' : 'compare-table__row--odd';
            rowIdx++;

            const keyTd = document.createElement('td');
            keyTd.className   = 'compare-table__key';
            keyTd.textContent = entry.label;
            tr.appendChild(keyTd);

            items.forEach((_, i) => {
                const td = document.createElement('td');
                td.className   = 'compare-table__val';
                td.textContent = lookups[i][sk] ?? '—';
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        wrap.appendChild(table);
        container.appendChild(wrap);
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
        closePanel();
    }

    return { init, togglePanel, openPanel, closePanel, setViewMode, clearAll };

})();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.CompareDisplay.init());
} else {
    window.CompareDisplay.init();
}
