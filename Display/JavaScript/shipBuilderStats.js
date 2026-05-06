'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderStats.js  —  Live Stats Panel for Ship Builder
//
//  INTEGRATION
//  ─────────────────────────────────────────────────────────────────────────────
//  1. Add a mount point to shipBuilder.html, at the bottom of #builder-view
//     (just before the closing </div><!-- /builder-view -->):
//
//         <div id="sbs-panel-mount"></div>
//
//  2. Load scripts at the bottom of shipBuilder.html, AFTER the existing ones:
//
//         <script src="../JavaScript/weaponStats.js"></script>
//         <script src="../JavaScript/computedStats.js"></script>
//         <script src="../JavaScript/shipBuilderStats.js"></script>
//
//  3. Add ONE call at the very END of the DOMContentLoaded block in
//     shipBuilder.js (after the pluginsChanged / dataLoaded listeners):
//
//         SBS.hookIntoBuilder();
//
//  Done. The panel auto-mounts, auto-hooks every mutation point, and
//  recomputes on every change.
// ═══════════════════════════════════════════════════════════════════════════════

const SBS = (() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────────────────────

    let _panel      = null;
    let _activeTab  = 'combat';
    let _rafPending = false;
    let _hooked     = false;

    // ─────────────────────────────────────────────────────────────────────────
    //  HOOK INTO BUILDER
    //
    //  Wraps every shipBuilder.js function that mutates sbCurrentShip so that
    //  a refresh fires automatically after each change.
    // ─────────────────────────────────────────────────────────────────────────

    function hookIntoBuilder() {
        if (_hooked) return;
        _hooked = true;

        const TARGETS = [
            // Attributes
            'sbUpdateAttrVal', 'sbRemoveAttr', 'confirmAddAttr',
            // Outfits
            'sbUpdateOutfitCount', 'sbRemoveOutfit',
            'sbAddOutfitFromPicker', 'confirmAddOutfit',
            // Hardpoints / engines
            'sbRemoveHP', 'addGunTurret', 'sbUpdateHP',
            // Weapon sub-block
            'sbUpdateWeaponField',
            // Explosion / leak effects
            'sbUpdateExplode', 'sbRemoveExplode',
            'sbAddEffectFromPicker', 'sbUpdateLeak', 'sbRemoveLeak',
            // Identity fields
            'onBuilderChange',
            // Ship-level load events
            'importRaw', 'sbPickShip', 'sbEditFleetShip',
            'newShip', 'openOutfitExisting', 'openEditExisting',
        ];

        for (const fnName of TARGETS) {
            if (typeof window[fnName] !== 'function') continue;
            const orig = window[fnName];
            window[fnName] = function (...args) {
                const result = orig.apply(this, args);
                // Use rAF so the original fully finishes mutating state first
                requestAnimationFrame(() => refresh());
                return result;
            };
        }

        // Also react to identity input fields immediately
        document.addEventListener('input', e => {
            const id = e.target?.id;
            if (id === 'ship-name' || id === 'ship-variant' || id === 'ship-plural') {
                requestAnimationFrame(() => refresh());
            }
        });

        console.log('[SBS] Hooked into builder — live stats active.');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  REFRESH  — debounced via rAF; called after every mutation
    // ─────────────────────────────────────────────────────────────────────────

    function refresh() {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => {
            _rafPending = false;
            if (!_panel) _mount();
            if (!_panel) return;

            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            const builderHidden = document.getElementById('builder-view')
                                           ?.classList.contains('hidden');
            if (!ship || builderHidden) return;

            // Clear ComputedStats cache so the re-compute reflects latest state
            if (typeof ComputedStats !== 'undefined') ComputedStats.clearCache();

            _renderContent(ship);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  OUTFIT INDEX  — merged across all loaded plugins
    //
    //  Remote plugin data stores outfit stats under outfit.attributes.
    //  We flatten that sub-object to the top level so both ComputedStats
    //  and our own accumulator can read the values uniformly.
    // ─────────────────────────────────────────────────────────────────────────

    function _buildOutfitIndex() {
        const allData   = window.allData || {};
        const sbOutfits = (typeof sbAllOutfits !== 'undefined') ? sbAllOutfits : [];
        const merged    = {};

        const allOutfits = [
            ...Object.values(allData).flatMap(p => p?.outfits || []),
            ...sbOutfits,
        ];

        for (const o of allOutfits) {
            const name = (o.name || o.displayName || '').replace(/^"|"$/g, '').trim();
            if (!name || name in merged) continue;

            // Flatten attributes sub-object to top level
            const flat = { ...o };
            if (o.attributes && typeof o.attributes === 'object') {
                for (const [k, v] of Object.entries(o.attributes)) {
                    if (!(k in flat)) flat[k] = v;
                }
            }
            flat.name = name;
            merged[name] = flat;
        }

        return merged;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  EFFECTIVE ATTRIBUTES
    //
    //  Produces a single flat attribute map: ship base attrs PLUS every
    //  contribution from every installed outfit.  This is the input for both
    //  ComputedStats formula evaluation and our direct stat reads.
    // ─────────────────────────────────────────────────────────────────────────

    const _META = new Set([
        'name','category','series','index','cost','thumbnail','sprite',
        'description','pluginId','weapon','governments','locations',
        '_internalId','_pluginId','_hash','_pn','_pd','_isVariant',
        'displayName','spriteData','attributes',
    ]);

    function _buildEffectiveAttrs(ship, outfitIdx) {
        // Start with the ship's own base attributes
        const eff = {};
        for (const [k, v] of Object.entries(ship.attributes || {})) {
            if (typeof v === 'number') eff[k] = v;
            else if (typeof v === 'string') {
                const n = parseFloat(v);
                if (!isNaN(n)) eff[k] = n;
            }
        }
        // mass and drag are stored separately on sbCurrentShip
        if (ship.mass && ship.mass !== '') eff['mass'] = parseFloat(ship.mass) || 0;
        if (ship.drag && ship.drag !== '') eff['drag'] = parseFloat(ship.drag) || 0;

        // Accumulate outfit contributions
        for (const entry of (ship.outfits || [])) {
            const name  = (entry.name || '').replace(/^"|"$/g, '').trim();
            const count = parseInt(entry.count) || 1;
            const o = outfitIdx[name];
            if (!o) continue;

            for (const [key, rawVal] of Object.entries(o)) {
                if (_META.has(key))              continue;
                if (key.startsWith('_'))          continue;
                if (typeof rawVal !== 'number')   continue;
                if (rawVal === 0)                 continue;
                eff[key] = (eff[key] || 0) + rawVal * count;
            }
        }

        return eff;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  COMPUTED STATS
    // ─────────────────────────────────────────────────────────────────────────

    function _computeStats(ship, outfitIdx) {
        const eff = _buildEffectiveAttrs(ship, outfitIdx);

        if (typeof ComputedStats !== 'undefined' && ComputedStats.isReady()) {
            try {
                // getComputedStatsForAttrs takes a bare attr map — perfect here
                // because we've already accumulated outfits ourselves.
                const cs = ComputedStats.getComputedStatsForAttrs(eff);
                // Merge so we keep raw keys too (cs might not expose all attrs)
                return { ...eff, ...cs };
            } catch (e) {
                console.warn('[SBS] ComputedStats error:', e);
            }
        }
        return eff;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  WEAPON STATS
    // ─────────────────────────────────────────────────────────────────────────

    function _computeWeaponStats(ship, outfitIdx) {
        if (typeof WeaponStats === 'undefined') return null;
        try {
            // Convert internal array outfits to the name→count map WeaponStats needs
            const outfitMap = {};
            for (const entry of (ship.outfits || [])) {
                const name  = (entry.name || '').replace(/^"|"$/g, '').trim();
                const count = parseInt(entry.count) || 1;
                if (name) outfitMap[name] = (outfitMap[name] || 0) + count;
            }
            return WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx);
        } catch (e) {
            console.warn('[SBS] WeaponStats error:', e);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  DOM MOUNT
    // ─────────────────────────────────────────────────────────────────────────

    function _mount() {
        const mount = document.getElementById('sbs-panel-mount');
        if (!mount) {
            console.warn('[SBS] Mount point #sbs-panel-mount not found. Add it to shipBuilder.html.');
            return;
        }

        const tabDefs = [
            { id: 'combat',   label: '🛡 Combat'  },
            { id: 'movement', label: '🚀 Movement' },
            { id: 'power',    label: '⚡ Power'    },
            { id: 'weapons',  label: '🔫 Weapons'  },
            { id: 'crew',     label: '👤 Misc'     },
        ];
        const tabsHtml = tabDefs.map(t =>
            `<button class="sbs-tab${t.id === _activeTab ? ' sbs-tab--active' : ''}" data-sbs-tab="${t.id}">${t.label}</button>`
        ).join('');

        mount.innerHTML = `
<div id="sbs-root" class="sbs-root">
    <div class="sbs-header">
        <span class="sbs-title">📊 Live Ship Stats</span>
        <div class="sbs-tabs">${tabsHtml}</div>
        <button class="sbs-collapse-btn" id="sbs-collapse-btn" title="Toggle stats panel">▲</button>
    </div>
    <div class="sbs-body" id="sbs-body">
        <div id="sbs-content" class="sbs-content">
            <div class="sbs-empty">Add attributes or outfits to see live stats.</div>
        </div>
    </div>
</div>
<style id="sbs-style">${_CSS}</style>`;

        _panel = document.getElementById('sbs-root');

        _panel.querySelectorAll('.sbs-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                _activeTab = btn.dataset.sbsTab;
                _panel.querySelectorAll('.sbs-tab').forEach(b => b.classList.remove('sbs-tab--active'));
                btn.classList.add('sbs-tab--active');
                refresh();
            });
        });

        document.getElementById('sbs-collapse-btn').addEventListener('click', () => {
            const body = document.getElementById('sbs-body');
            const btn  = document.getElementById('sbs-collapse-btn');
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? '' : 'none';
            btn.textContent    = isHidden ? '▲' : '▼';
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  RENDER
    // ─────────────────────────────────────────────────────────────────────────

    function _renderContent(ship) {
        const el = document.getElementById('sbs-content');
        if (!el) return;

        const outfitIdx  = _buildOutfitIndex();
        const computed   = _computeStats(ship, outfitIdx);
        const weaponData = _computeWeaponStats(ship, outfitIdx);

        let html = '';
        switch (_activeTab) {
            case 'combat':   html = _tabCombat(computed);              break;
            case 'movement': html = _tabMovement(computed);            break;
            case 'power':    html = _tabPower(computed);               break;
            case 'weapons':  html = _tabWeapons(weaponData, computed); break;
            case 'crew':     html = _tabCrew(computed);                break;
        }

        el.innerHTML = html || `<div class="sbs-empty">No data available for this section yet.</div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  VALUE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    // Read a value — prefers _fn_ computed key, falls back to raw attr key
    function _get(c, fnKey, rawKey) {
        if (fnKey) {
            const v = c[`_fn_${fnKey}`];
            if (v != null && !isNaN(v) && v !== 0) return v;
        }
        if (rawKey != null) {
            const v = parseFloat(c[rawKey] ?? '');
            if (!isNaN(v) && v !== 0) return v;
        }
        return null;
    }

    function _fmt(v) {
        if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '—';
        if (typeof v !== 'number') return String(v);
        if (Number.isInteger(v) && Math.abs(v) >= 1000) return v.toLocaleString();
        return parseFloat(v.toPrecision(4)).toString();
    }

    function _coloured(v, positiveIsGood) {
        if (v === null || v === undefined || isNaN(v)) return '—';
        const good  = positiveIsGood ? v >= 0 : v <= 0;
        const color = good ? 'var(--sbs-pos)' : 'var(--sbs-neg)';
        return `<span style="color:${color};font-weight:700">${_fmt(v)}</span>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HTML HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    function _card(label, value, unit, highlight) {
        // Skip cards with no meaningful value
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && (isNaN(value) || value === 0)) return '';

        const cls     = highlight ? ' sbs-card--hi' : '';
        const unitTag = unit ? `<span class="sbs-unit">${_esc(unit)}</span>` : '';
        const fmtVal  = typeof value === 'string' ? value : _fmt(value);
        return `<div class="sbs-card${cls}">
    <div class="sbs-label">${_esc(label)}</div>
    <div class="sbs-value">${fmtVal}${unitTag}</div>
</div>`;
    }

    function _section(title, content) {
        if (!content || !content.trim()) return '';
        return `<div class="sbs-section">
    <div class="sbs-section-title">${_esc(title)}</div>
    <div class="sbs-cards">${content}</div>
</div>`;
    }

    function _tableSection(title, tableHtml) {
        if (!tableHtml) return '';
        return `<div class="sbs-section">
    <div class="sbs-section-title">${_esc(title)}</div>
    <div class="sbs-table-wrap">${tableHtml}</div>
</div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: COMBAT
    // ─────────────────────────────────────────────────────────────────────────

    function _tabCombat(c) {
        const shields    = _get(c, 'MaxShields',      'shields');
        const hull       = _get(c, 'MaxHull',         'hull');
        const heatDiss   = _get(c, 'HeatDissipation', 'heat dissipation');
        const idleHeat   = _get(c, 'IdleHeat',        null);
        const maxHeat    = _get(c, 'MaximumHeat',     null);
        const shRegen    = (parseFloat(c['shield generation'] ?? 0) * 60) || null;
        const hullRepair = (parseFloat(c['hull repair rate']  ?? 0) * 60) || null;
        const idlePct    = (idleHeat && maxHeat) ? idleHeat / maxHeat * 100  : null;
        const ttfSh      = (shields && shRegen)  ? shields  / shRegen        : null;
        const ttfHull    = (hull && hullRepair)  ? hull     / hullRepair     : null;

        let main = '';
        main += _card('Max Shields',      shields,    'hp',  !!shields);
        main += _card('Max Hull',         hull,       'hp',  !!hull);
        main += _card('Shield Regen',     shRegen,    '/s');
        main += _card('Hull Repair',      hullRepair, '/s');
        main += _card('Heat Dissipation', heatDiss,   '');
        main += _card('Max Heat',         maxHeat,    '');
        main += _card('Idle Heat',        idleHeat,   '');
        if (idlePct  !== null) main += _card('Idle Heat %',   idlePct,   '%');
        if (ttfSh    !== null) main += _card('TTF Shields',   ttfSh,     's');
        if (ttfHull  !== null) main += _card('TTF Hull',      ttfHull,   's');

        // Shield/hull specific modifiers
        const modKeys = [
            ['shield delay',              'Shield Delay'],
            ['depleted shield delay',     'Depleted Delay'],
            ['repair delay',              'Repair Delay'],
            ['disabled repair rate',      'Disabled Repair'],
            ['hull multiplier',           'Hull Multiplier'],
            ['shield multiplier',         'Shield Multiplier'],
            ['hull repair multiplier',    'Hull Repair ×'],
            ['shield generation multiplier', 'Shield Gen ×'],
        ];
        let modCards = '';
        for (const [key, label] of modKeys) {
            const v = parseFloat(c[key] ?? 0) || null;
            if (v) modCards += _card(label, v, '');
        }

        // Damage protections
        const protKeys = [
            ['shield protection',       'Shield Prot.'],
            ['hull protection',         'Hull Prot.'],
            ['energy protection',       'Energy Prot.'],
            ['fuel protection',         'Fuel Prot.'],
            ['heat protection',         'Heat Prot.'],
            ['force protection',        'Force Prot.'],
            ['piercing protection',     'Piercing Prot.'],
            ['disruption protection',   'Disruption Prot.'],
        ];
        let protCards = '';
        for (const [key, label] of protKeys) {
            const v = parseFloat(c[key] ?? 0) || null;
            if (v) protCards += _card(label, v, '');
        }

        // Status resistances
        const resistKeys = [
            ['ion resistance',        'Ion'],
            ['scramble resistance',   'Scramble'],
            ['disruption resistance', 'Disruption'],
            ['slowing resistance',    'Slowing'],
            ['burn resistance',       'Burn'],
            ['discharge resistance',  'Discharge'],
            ['corrosion resistance',  'Corrosion'],
            ['leak resistance',       'Leak'],
        ];
        let resistCards = '';
        for (const [key, label] of resistKeys) {
            const v = parseFloat(c[key] ?? 0) || null;
            if (v) resistCards += _card(label + ' Resist', v, '');
        }

        return _section('Combat', main)
             + (modCards    ? _section('Combat Modifiers', modCards)    : '')
             + (protCards   ? _section('Damage Protection', protCards)  : '')
             + (resistCards ? _section('Status Resistances', resistCards) : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: MOVEMENT
    // ─────────────────────────────────────────────────────────────────────────

    function _tabMovement(c) {
        const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;

        let main = '';
        main += _card('Max Velocity',  _get(c, 'MaxVelocity',        null), '',    true);
        main += _card('Acceleration',  _get(c, 'Acceleration',       null), '',    true);
        main += _card('Turn Rate',     _get(c, 'TurnRate',           null), '°/s', true);
        main += _card('Drag',          _get(c, 'Drag',               'drag'), '');
        main += _card('Mass',
            _get(c, 'Mass', 'mass') ?? (parseFloat(ship?.mass ?? 0) || null),
            't');
        main += _card('Inertial Mass', _get(c, 'InertialMass',       null), '');

        // Raw forces — useful when formula evaluation not yet available
        let rawCards = '';
        const thr  = parseFloat(c['thrust']         ?? 0) || null;
        const tur  = parseFloat(c['turn']            ?? 0) || null;
        const revT = parseFloat(c['reverse thrust']  ?? 0) || null;
        if (thr)  rawCards += _card('Thrust',         thr,  '');
        if (tur)  rawCards += _card('Turn Force',     tur,  '');
        if (revT) rawCards += _card('Reverse Thrust', revT, '');

        // Reverse computed stats
        let revCards = '';
        revCards += _card('Rev. Max Vel.',  _get(c, 'MaxReverseVelocity',  null), '');
        revCards += _card('Rev. Accel.',    _get(c, 'ReverseAcceleration', null), '');

        // Afterburner
        let abCards = '';
        const abThrust = parseFloat(c['afterburner thrust']  ?? 0) || null;
        const abFuel   = parseFloat(c['afterburner fuel']    ?? 0) || null;
        const abHeat   = parseFloat(c['afterburner heat']    ?? 0) || null;
        const abEnergy = parseFloat(c['afterburner energy']  ?? 0) || null;
        if (abThrust) abCards += _card('AB Thrust',    abThrust,       '');
        if (abFuel)   abCards += _card('AB Fuel/s',    abFuel   * 60,  '/s');
        if (abHeat)   abCards += _card('AB Heat/s',    abHeat   * 60,  '/s');
        if (abEnergy) abCards += _card('AB Energy/s',  abEnergy * 60,  '/s');

        return _section('Movement', main)
             + (rawCards.trim()  ? _section('Raw Forces (accumulated)',   rawCards)  : '')
             + (revCards.trim()  ? _section('Reverse Thrust',             revCards)  : '')
             + (abCards.trim()   ? _section('Afterburner',                abCards)   : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: POWER
    // ─────────────────────────────────────────────────────────────────────────

    function _tabPower(c) {
        const eCap    = parseFloat(c['energy capacity']     ?? 0) || null;
        const fCap    = parseFloat(c['fuel capacity']       ?? 0) || null;
        const eGen    = (parseFloat(c['energy generation']  ?? 0) * 60) || null;
        const eCon    = (parseFloat(c['energy consumption'] ?? 0) * 60) || null;
        const solar   = (parseFloat(c['solar collection']   ?? 0) * 60) || null;
        const ramsco  = parseFloat(c['ramscoop']            ?? 0) || null;
        const cooling = (parseFloat(c['cooling']            ?? 0) * 60) || null;
        const coolEff = _get(c, 'CoolingEfficiency', null);
        const eNet    = (eGen !== null || eCon !== null) ? ((eGen ?? 0) - (eCon ?? 0)) : null;

        let main = '';
        main += _card('Energy Cap.',       eCap,    'J',   !!eCap);
        main += _card('Generation',        eGen,    '/s',  eGen  > 0);
        main += _card('Consumption',       eCon,    '/s');
        if (eNet !== null) {
            main += `<div class="sbs-card${eNet >= 0 ? ' sbs-card--hi' : ' sbs-card--warn'}">
    <div class="sbs-label">Net Energy/s</div>
    <div class="sbs-value">${_coloured(eNet, true)}<span class="sbs-unit">/s</span></div>
</div>`;
        }
        main += _card('Fuel Cap.',         fCap,    '');
        main += _card('Solar Collect.',    solar,   '/s');
        main += _card('Ramscoop',          ramsco,  '');
        main += _card('Cooling',           cooling, '/s');
        main += _card('Cool. Efficiency',  coolEff, '');

        // Derived energy usage per action (from ComputedStats intermediate vars)
        let dECards = '';
        let dHCards = '';
        for (const [key, val] of Object.entries(c)) {
            if (!val || typeof val !== 'number' || isNaN(val) || val === 0) continue;
            if (key.startsWith('_derived_energy_')) {
                const label = key.slice('_derived_energy_'.length).replace(/_/g, ' ');
                dECards += _card(_capWords(label) + ' Energy', val, '/s');
            } else if (key.startsWith('_derived_heat_')) {
                const label = key.slice('_derived_heat_'.length).replace(/_/g, ' ');
                dHCards += _card(_capWords(label) + ' Heat', val, '/s');
            }
        }

        return _section('Power', main)
             + (dECards ? _section('Energy Usage (computed)', dECards) : '')
             + (dHCards ? _section('Heat Generation (computed)', dHCards) : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: WEAPONS
    // ─────────────────────────────────────────────────────────────────────────

    function _tabWeapons(wData, computed) {
        // Capacity context at the top
        const wCap = parseFloat(computed['weapon capacity'] ?? 0) || null;
        const eCap = parseFloat(computed['engine capacity'] ?? 0) || null;
        const oCap = parseFloat(computed['outfit space']    ?? 0) || null;
        let capCards = '';
        if (wCap) capCards += _card('Weapon Capacity', wCap, '');
        if (eCap) capCards += _card('Engine Capacity', eCap, '');
        if (oCap) capCards += _card('Outfit Space',    oCap, '');
        const capSection = capCards ? _section('Installed Capacity', capCards) : '';

        if (!wData || !wData.weaponCount) {
            return capSection + `<div class="sbs-section"><div class="sbs-empty">No weapons installed, or weapon data not available yet.</div></div>`;
        }

        // Summary
        let sumCards = '';
        sumCards += _card('Total DPS',    wData.totalDps,          'dps', wData.totalDps  > 0);
        sumCards += _card('Shield DPS',   wData.shieldDps,         'dps', wData.shieldDps > 0);
        sumCards += _card('Hull DPS',     wData.hullDps,           'dps', wData.hullDps   > 0);
        sumCards += _card('Weapon Types', wData.weaponCount,       '');
        sumCards += _card('Total Mounts', wData.totalWeaponMounts, '');

        // DPS by damage type
        let typeCards = '';
        for (const [key, val] of Object.entries(wData.dpsByType || {})) {
            if (!val) continue;
            typeCards += _card(_capWords(key.replace(/ damage$/, '')) + ' DPS', val, 'dps');
        }

        // Per-weapon table
        const rows = (wData.weapons || []).map(w => {
            const range   = w.profile.effectiveRange ? `${_fmt(w.profile.effectiveRange)} px` : '—';
            const sps     = _fmt(w.profile.shotsPerSecond);
            const badges  = [
                w.profile.isHoming      ? `<span class="sbs-badge sbs-badge--blue">HOMING</span>`  : '',
                w.profile.hasAmmo       ? `<span class="sbs-badge sbs-badge--amber">AMMO</span>`   : '',
                w.profile.isAntiMissile ? `<span class="sbs-badge sbs-badge--red">A-M</span>`      : '',
            ].join('');
            const countTag = w.count > 1 ? `<span class="sbs-wt-count">×${w.count}</span>` : '';
            return `<tr>
    <td class="sbs-wt-name">${_esc(w.outfitName)} ${countTag}${badges}</td>
    <td class="sbs-wt-num">${sps}/s</td>
    <td class="sbs-wt-num">${range}</td>
    <td class="sbs-wt-num sbs-wt-dps">${_fmt(w.scaledDps)}</td>
</tr>`;
        }).join('');

        const weaponTable = `<table class="sbs-table">
    <thead><tr>
        <th>Weapon</th>
        <th style="text-align:right">Shots/s</th>
        <th style="text-align:right">Range</th>
        <th style="text-align:right">DPS</th>
    </tr></thead>
    <tbody>${rows}</tbody>
</table>`;

        // Ammo requirements
        let ammoCards = '';
        if (wData.hasAmmoWeapons) {
            for (const a of (wData.ammoRequired || [])) {
                ammoCards += _card(
                    _esc(a.ammoOutfitName),
                    _fmt(a.totalShotsPerSecond),
                    'rounds/s used'
                );
            }
        }

        return capSection
             + _section('DPS Summary', sumCards)
             + (typeCards ? _section('DPS by Damage Type', typeCards) : '')
             + _tableSection('Installed Weapons', weaponTable)
             + (ammoCards ? _section('⚠ Ammo Consumed', ammoCards) : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: CREW & MISC
    // ─────────────────────────────────────────────────────────────────────────

    function _tabCrew(c) {
        let main = '';
        main += _card('Required Crew', _get(c, 'RequiredCrew', 'required crew'), '');
        main += _card('Bunks',         parseFloat(c['bunks']        ?? 0) || null, '');
        main += _card('Cargo Space',   parseFloat(c['cargo space']  ?? 0) || null, 't');
        main += _card('Fuel Cap.',     parseFloat(c['fuel capacity']?? 0) || null, '');
        main += _card('Cost',          parseFloat(c['cost']         ?? 0) || null, 'cr');
        main += _card('Cloak Speed',   _get(c, 'CloakingSpeed', null), '');

        // Cloaking energy/fuel
        let cloakCards = '';
        const cloakE = parseFloat(c['cloaking energy'] ?? 0) || null;
        const cloakF = parseFloat(c['cloaking fuel']   ?? 0) || null;
        const cloakH = parseFloat(c['cloaking heat']   ?? 0) || null;
        if (cloakE) cloakCards += _card('Cloak Energy', cloakE, '/s');
        if (cloakF) cloakCards += _card('Cloak Fuel',   cloakF, '/s');
        if (cloakH) cloakCards += _card('Cloak Heat',   cloakH, '/s');

        // Navigation
        let navCards = '';
        const jFuel  = parseFloat(c['jump fuel']  ?? 0) || null;
        const jRange = parseFloat(c['jump range'] ?? 0) || null;
        const hyp    = parseFloat(c['hyperdrive'] ?? 0) || null;
        const jDrive = parseFloat(c['jump drive'] ?? 0) || null;
        if (jFuel)  navCards += _card('Jump Fuel',   jFuel,  '');
        if (jRange) navCards += _card('Jump Range',  jRange, '');
        if (hyp)    navCards += _card('Hyperdrive',  hyp,    '');
        if (jDrive) navCards += _card('Jump Drive',  jDrive, '');

        // Scanning
        let scanCards = '';
        for (const key of ['cargo scan power','outfit scan power',
                           'tactical scan power','asteroid scan power']) {
            const v = parseFloat(c[key] ?? 0);
            if (!v) continue;
            scanCards += _card(_capWords(key.replace(' power', '')) + ' Range',
                               100 * Math.sqrt(v), 'px');
        }
        const si = parseFloat(c['scan interference'] ?? 0);
        if (si) scanCards += _card('Scan Evasion', si / (1 + si) * 100, '%');

        // Any remaining _fn_ keys we haven't shown in other tabs
        const SHOWN = new Set([
            'MaxShields','MaxHull','HeatDissipation','IdleHeat','MaximumHeat',
            'MaxVelocity','Acceleration','TurnRate','MaxReverseVelocity',
            'ReverseAcceleration','Drag','Mass','InertialMass','DragForce',
            'CoolingEfficiency','RequiredCrew','CloakingSpeed','MinimumHull',
        ]);
        let extraCards = '';
        for (const [key, val] of Object.entries(c)) {
            if (!key.startsWith('_fn_')) continue;
            const fnName = key.slice(4);
            if (SHOWN.has(fnName)) continue;
            if (!val || isNaN(val)) continue;
            const label = fnName.replace(/([A-Z])/g, ' $1').trim();
            extraCards += _card(label, val, '');
        }

        return _section('Crew & General', main)
             + (cloakCards.trim() ? _section('Cloaking',       cloakCards) : '')
             + (navCards.trim()   ? _section('Navigation',     navCards)   : '')
             + (scanCards.trim()  ? _section('Scanning',       scanCards)  : '')
             + (extraCards.trim() ? _section('Other Computed', extraCards) : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  UTILS
    // ─────────────────────────────────────────────────────────────────────────

    function _capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
    function _capWords(s) { return s.split(' ').map(_capFirst).join(' '); }
    function _esc(s)      {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CSS (injected once into the page)
    // ─────────────────────────────────────────────────────────────────────────

    const _CSS = `
/* ─── SBS Root ────────────────────────────────────────────────────────────── */
#sbs-root {
    --sbs-bg:      #0d1826;
    --sbs-sur:     #162033;
    --sbs-sur2:    #1d2d45;
    --sbs-bdr:     rgba(99,179,237,0.16);
    --sbs-acc:     #63b3ed;
    --sbs-acc2:    #38bdf8;
    --sbs-txt:     #e2e8f0;
    --sbs-mut:     #64748b;
    --sbs-dim:     #3d526b;
    --sbs-pos:     #4ade80;
    --sbs-neg:     #f87171;
    --sbs-r:       8px;
    --sbs-rsm:     5px;
    margin-top: 28px;
    border: 1px solid var(--sbs-bdr);
    border-radius: var(--sbs-r);
    background: var(--sbs-bg);
    overflow: hidden;
    box-shadow: 0 6px 32px rgba(0,0,0,0.45),
                inset 0 1px 0 rgba(99,179,237,0.06);
}

/* ─── Header ──────────────────────────────────────────────────────────────── */
#sbs-root .sbs-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--sbs-sur);
    border-bottom: 1px solid var(--sbs-bdr);
    flex-wrap: wrap;
}
#sbs-root .sbs-title {
    font-size: 0.72rem;
    font-weight: 800;
    color: var(--sbs-acc);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    white-space: nowrap;
    flex-shrink: 0;
}
#sbs-root .sbs-tabs {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
}
#sbs-root .sbs-tab {
    padding: 3px 10px;
    border-radius: var(--sbs-rsm);
    border: 1px solid var(--sbs-bdr);
    background: transparent;
    color: var(--sbs-mut);
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    transition: background .12s, color .12s, border-color .12s;
    white-space: nowrap;
}
#sbs-root .sbs-tab:hover {
    background: var(--sbs-sur2);
    color: var(--sbs-txt);
    border-color: rgba(99,179,237,0.5);
}
#sbs-root .sbs-tab--active {
    background: #1d4ed8;
    color: #fff;
    border-color: #1d4ed8;
}
#sbs-root .sbs-collapse-btn {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: var(--sbs-rsm);
    border: 1px solid var(--sbs-bdr);
    background: transparent;
    color: var(--sbs-mut);
    font-size: 0.7rem;
    cursor: pointer;
    flex-shrink: 0;
    transition: color .12s, border-color .12s;
}
#sbs-root .sbs-collapse-btn:hover { color: var(--sbs-txt); border-color: var(--sbs-acc); }

/* ─── Body ────────────────────────────────────────────────────────────────── */
#sbs-root .sbs-body {
    padding: 14px 14px 18px;
    max-height: 400px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--sbs-dim) transparent;
}
#sbs-root .sbs-body::-webkit-scrollbar       { width: 5px; }
#sbs-root .sbs-body::-webkit-scrollbar-track { background: transparent; }
#sbs-root .sbs-body::-webkit-scrollbar-thumb { background: var(--sbs-dim); border-radius: 3px; }
#sbs-root .sbs-content { display: flex; flex-direction: column; gap: 16px; }
#sbs-root .sbs-empty {
    color: var(--sbs-mut);
    font-size: 0.82rem;
    font-style: italic;
    padding: 14px 0;
    text-align: center;
}

/* ─── Section ─────────────────────────────────────────────────────────────── */
#sbs-root .sbs-section { display: flex; flex-direction: column; gap: 7px; }
#sbs-root .sbs-section-title {
    font-size: 0.63rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--sbs-acc);
    border-bottom: 1px solid var(--sbs-bdr);
    padding-bottom: 3px;
}
#sbs-root .sbs-cards { display: flex; flex-wrap: wrap; gap: 5px; }

/* ─── Stat cards ──────────────────────────────────────────────────────────── */
#sbs-root .sbs-card {
    display: flex;
    flex-direction: column;
    background: var(--sbs-sur);
    border: 1px solid var(--sbs-bdr);
    border-radius: var(--sbs-rsm);
    padding: 5px 10px 6px;
    min-width: 80px;
    transition: border-color .12s, background .12s;
}
#sbs-root .sbs-card:hover {
    border-color: rgba(99,179,237,0.4);
    background: var(--sbs-sur2);
}
#sbs-root .sbs-card--hi {
    border-color: rgba(99,179,237,0.35);
    background: var(--sbs-sur2);
}
#sbs-root .sbs-card--warn {
    border-color: rgba(248,113,113,0.35);
}
#sbs-root .sbs-label {
    font-size: 0.58rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--sbs-mut);
    margin-bottom: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
#sbs-root .sbs-value {
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--sbs-txt);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
#sbs-root .sbs-unit {
    font-size: 0.6rem;
    font-weight: 400;
    color: var(--sbs-mut);
    margin-left: 2px;
}

/* ─── Weapon table ────────────────────────────────────────────────────────── */
#sbs-root .sbs-table-wrap { overflow-x: auto; }
#sbs-root .sbs-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.76rem;
}
#sbs-root .sbs-table th {
    color: var(--sbs-mut);
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 4px 8px;
    border-bottom: 1px solid var(--sbs-bdr);
    font-weight: 700;
    white-space: nowrap;
}
#sbs-root .sbs-table td {
    padding: 5px 8px;
    color: var(--sbs-txt);
    border-bottom: 1px solid rgba(99,179,237,0.06);
    vertical-align: middle;
}
#sbs-root .sbs-table tbody tr:hover td { background: var(--sbs-sur2); }
#sbs-root .sbs-wt-name  { font-weight: 600; }
#sbs-root .sbs-wt-num   { text-align: right; font-variant-numeric: tabular-nums; color: var(--sbs-mut); }
#sbs-root .sbs-wt-dps   { color: var(--sbs-acc2) !important; font-weight: 700; }
#sbs-root .sbs-wt-count { font-size: 0.68rem; color: var(--sbs-mut); margin-left: 2px; }

/* ─── Badges ──────────────────────────────────────────────────────────────── */
#sbs-root .sbs-badge {
    display: inline-block;
    font-size: 0.55rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    padding: 1px 4px;
    border-radius: 3px;
    vertical-align: middle;
    margin-left: 3px;
    line-height: 1.4;
}
#sbs-root .sbs-badge--blue  { background:rgba(59,130,246,0.2);  color:#93c5fd; border:1px solid rgba(59,130,246,0.35); }
#sbs-root .sbs-badge--amber { background:rgba(251,191,36,0.15); color:#fcd34d; border:1px solid rgba(251,191,36,0.35); }
#sbs-root .sbs-badge--red   { background:rgba(239,68,68,0.15);  color:#fca5a5; border:1px solid rgba(239,68,68,0.35); }
`;

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    return { refresh, hookIntoBuilder, _mount };

})();

// ── Auto-mount on DOMContentLoaded ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    SBS._mount();
});
