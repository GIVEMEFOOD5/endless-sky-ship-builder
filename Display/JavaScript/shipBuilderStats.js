'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderStats.js  —  Live Stats Panel for Ship Builder
//
//  Renders a live, updating stats panel at the bottom of the ship builder.
//  Reads from:
//    • ComputedStats.getComputedStats(ship, pluginId)  — all derived engine stats
//    • WeaponStats.getShipWeaponStats(ship, outfitIndex) — DPS breakdown
//    • sbCurrentShip directly for raw attribute quick-reads
//
//  HOW TO INTEGRATE
//  ─────────────────
//  1. Drop this file next to shipBuilder.js and load it AFTER the other scripts:
//       <script src="../JavaScript/weaponStats.js"></script>
//       <script src="../JavaScript/computedStats.js"></script>
//       <script src="../JavaScript/shipBuilderStats.js"></script>
//
//  2. Add a mount point at the bottom of #builder-view in shipBuilder.html,
//     just before the closing </div><!-- /builder-view -->:
//       <div id="sbs-panel-mount"></div>
//
//  3. Call  SBS.refresh()  anywhere sbCurrentShip changes.  The easiest way is
//     to append it to the existing sbUpdateQuickStats() in shipBuilder.js:
//       function sbUpdateQuickStats() {
//           … existing code …
//           SBS.refresh();
//       }
//
//  That's it.  The panel self-initialises on DOMContentLoaded.
// ═══════════════════════════════════════════════════════════════════════════════

const SBS = (() => {

    // ── Constants ──────────────────────────────────────────────────────────────

    const SECTIONS = [
        {
            id:    'combat',
            label: '🛡 Combat',
            icon:  '🛡',
            rows: [
                { label: 'Max Shields',       fn: 'MaxShields',    unit: 'hp',   raw: 'shields' },
                { label: 'Max Hull',          fn: 'MaxHull',       unit: 'hp',   raw: 'hull' },
                { label: 'Shield Regen',      derived: 'shieldRegen',   unit: '/s',  calc: a => (parseFloat(a['shield generation'] ?? 0) * 60) || null },
                { label: 'Hull Repair',       derived: 'hullRepair',    unit: '/s',  calc: a => (parseFloat(a['hull repair rate'] ?? 0) * 60) || null },
                { label: 'Heat Dissipation',  fn: 'HeatDissipation', unit: '' },
                { label: 'Idle Heat',         fn: 'IdleHeat',      unit: '' },
            ],
        },
        {
            id:    'movement',
            label: '🚀 Movement',
            icon:  '🚀',
            rows: [
                { label: 'Max Velocity',      fn: 'MaxVelocity',        unit: '' },
                { label: 'Acceleration',      fn: 'Acceleration',       unit: '' },
                { label: 'Turn Rate',         fn: 'TurnRate',           unit: '°/s' },
                { label: 'Rev. Velocity',     fn: 'MaxReverseVelocity', unit: '' },
                { label: 'Rev. Accel.',       fn: 'ReverseAcceleration',unit: '' },
                { label: 'Drag',              fn: 'Drag',               unit: '' },
                { label: 'Mass',              fn: 'Mass',               unit: 't',  raw: 'mass' },
            ],
        },
        {
            id:    'power',
            label: '⚡ Power',
            icon:  '⚡',
            rows: [
                { label: 'Energy Cap.',       raw: 'energy capacity',   unit: 'J' },
                { label: 'Generation',        derived: 'eGen',   unit: '/s', calc: a => (parseFloat(a['energy generation'] ?? 0) * 60) || null },
                { label: 'Consumption',       derived: 'eCon',   unit: '/s', calc: a => (parseFloat(a['energy consumption'] ?? 0) * 60) || null },
                { label: 'Fuel Cap.',         raw: 'fuel capacity',     unit: '' },
                { label: 'Cooling',           derived: 'cooling', unit: '/s', calc: a => (parseFloat(a['cooling'] ?? 0) * 60) || null },
                { label: 'Cooling Efficiency',fn: 'CoolingEfficiency',  unit: '' },
            ],
        },
        {
            id:    'weapons',
            label: '🔫 Weapons',
            icon:  '🔫',
            rows: null, // dynamically built from WeaponStats
        },
        {
            id:    'crew',
            label: '👤 Crew & Misc',
            icon:  '👤',
            rows: [
                { label: 'Required Crew',     fn: 'RequiredCrew',    unit: '',    raw: 'required crew' },
                { label: 'Bunks',             raw: 'bunks',          unit: '' },
                { label: 'Cargo',             raw: 'cargo space',    unit: 't' },
                { label: 'Fuel Capacity',     raw: 'fuel capacity',  unit: '' },
                { label: 'Cost',              raw: 'cost',           unit: 'cr' },
            ],
        },
    ];

    // Mapping from ComputedStats _fn_ keys we want to display
    const FN_MAP = new Map([
        ['MaxShields',           { label: 'Max Shields',         unit: 'hp'  }],
        ['MaxHull',              { label: 'Max Hull',            unit: 'hp'  }],
        ['HeatDissipation',      { label: 'Heat Dissipation',    unit: ''    }],
        ['IdleHeat',             { label: 'Idle Heat',           unit: ''    }],
        ['MaximumHeat',          { label: 'Maximum Heat',        unit: ''    }],
        ['MaxVelocity',          { label: 'Max Velocity',        unit: ''    }],
        ['Acceleration',         { label: 'Acceleration',        unit: ''    }],
        ['TurnRate',             { label: 'Turn Rate',           unit: '°/s' }],
        ['MaxReverseVelocity',   { label: 'Rev. Velocity',       unit: ''    }],
        ['ReverseAcceleration',  { label: 'Rev. Accel.',         unit: ''    }],
        ['Drag',                 { label: 'Drag',                unit: ''    }],
        ['Mass',                 { label: 'Mass',                unit: 't'   }],
        ['InertialMass',         { label: 'Inertial Mass',       unit: ''    }],
        ['CoolingEfficiency',    { label: 'Cooling Efficiency',  unit: ''    }],
        ['RequiredCrew',         { label: 'Required Crew',       unit: ''    }],
        ['CloakingSpeed',        { label: 'Cloak Speed',         unit: ''    }],
    ]);

    // ── State ──────────────────────────────────────────────────────────────────

    let _panel       = null;
    let _activeTab   = 'combat';
    let _rafPending  = false;
    let _lastShipId  = null;

    // ── DOM Bootstrap ──────────────────────────────────────────────────────────

    function _mount() {
        const mount = document.getElementById('sbs-panel-mount');
        if (!mount) {
            console.warn('[SBS] Mount point #sbs-panel-mount not found. Add it to shipBuilder.html.');
            return;
        }
        mount.innerHTML = _panelShell();
        _panel = document.getElementById('sbs-root');
        _bindTabs();
    }

    function _panelShell() {
        const tabs = SECTIONS.map(s =>
            `<button class="sbs-tab${s.id === _activeTab ? ' sbs-tab--active' : ''}"
                     data-sbs-tab="${s.id}">${s.label}</button>`
        ).join('');

        return `
<div id="sbs-root" class="sbs-root">
    <div class="sbs-header">
        <span class="sbs-title">📊 Live Ship Stats</span>
        <div class="sbs-tabs">${tabs}</div>
        <button class="sbs-collapse-btn" id="sbs-collapse-btn" title="Toggle panel" onclick="SBS._toggleCollapse()">▲</button>
    </div>
    <div class="sbs-body" id="sbs-body">
        <div class="sbs-content" id="sbs-content">
            <div class="sbs-placeholder">Save or build a ship to see computed stats.</div>
        </div>
    </div>
</div>
<style>${_css()}</style>`;
    }

    function _bindTabs() {
        if (!_panel) return;
        _panel.querySelectorAll('.sbs-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                _activeTab = btn.dataset.sbsTab;
                _panel.querySelectorAll('.sbs-tab').forEach(b => b.classList.remove('sbs-tab--active'));
                btn.classList.add('sbs-tab--active');
                _renderContent();
            });
        });
    }

    // ── Public: refresh ────────────────────────────────────────────────────────

    function refresh() {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => {
            _rafPending = false;
            if (!_panel) _mount();
            if (!_panel) return;
            if (typeof sbCurrentShip === 'undefined' || !sbCurrentShip) return;
            _renderContent();
        });
    }

    // ── Collapse ───────────────────────────────────────────────────────────────

    function _toggleCollapse() {
        const body = document.getElementById('sbs-body');
        const btn  = document.getElementById('sbs-collapse-btn');
        if (!body) return;
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        if (btn) btn.textContent = collapsed ? '▲' : '▼';
    }

    // ── Main render ────────────────────────────────────────────────────────────

    function _renderContent() {
        const content = document.getElementById('sbs-content');
        if (!content || typeof sbCurrentShip === 'undefined' || !sbCurrentShip) return;

        const ship = sbCurrentShip;

        // Build effective attributes: base ship attrs + accumulated outfit attrs
        const computed   = _getComputed(ship);
        const weaponData = _getWeaponData(ship);

        let html = '';

        switch (_activeTab) {
            case 'combat':   html = _renderCombat(computed, ship.attributes || {}); break;
            case 'movement': html = _renderMovement(computed, ship.attributes || {}); break;
            case 'power':    html = _renderPower(computed, ship.attributes || {}); break;
            case 'weapons':  html = _renderWeapons(weaponData, ship); break;
            case 'crew':     html = _renderCrew(computed, ship.attributes || {}); break;
            default:         html = _renderAllFns(computed); break;
        }

        content.innerHTML = html || '<div class="sbs-placeholder">No data for this section yet.</div>';
    }

    // ── Computed stats helper ──────────────────────────────────────────────────

    function _getComputed(ship) {
        if (typeof ComputedStats === 'undefined' || !ComputedStats.isReady()) {
            return {};
        }
        try {
            const pluginId = _resolvePluginId(ship);
            return ComputedStats.getComputedStats(ship, pluginId) || {};
        } catch (e) {
            console.warn('[SBS] ComputedStats error:', e);
            return {};
        }
    }

    function _resolvePluginId(ship) {
        // Prefer the ship's own source plugin; fall back to local builds
        if (ship._sourcePlugin) return ship._sourcePlugin;
        if (window.DataLoader?.LOCAL_PLUGIN_ID) return window.DataLoader.LOCAL_PLUGIN_ID;
        return '__local_builds__';
    }

    function _getWeaponData(ship) {
        if (typeof WeaponStats === 'undefined') return null;
        try {
            const pluginId  = _resolvePluginId(ship);
            const outfitIdx = _buildOutfitIndex(pluginId);

            // WeaponStats.getShipWeaponStats expects outfits as a map of name→count
            // Our internal format is an array of {name, count} — convert it
            const outfitMap = {};
            for (const o of (ship.outfits || [])) {
                const n = (o.name || '').replace(/^"|"$/g, '');
                if (n) outfitMap[n] = (outfitMap[n] || 0) + (parseInt(o.count) || 1);
            }
            const shipProxy = { outfits: outfitMap };
            return WeaponStats.getShipWeaponStats(shipProxy, outfitIdx);
        } catch (e) {
            console.warn('[SBS] WeaponStats error:', e);
            return null;
        }
    }

    function _buildOutfitIndex(pluginId) {
        const allData = window.allData || {};
        const merged  = {};
        // Use pluginId-first ordering (same as ComputedStats._getOutfitIndex)
        const order   = [pluginId, ...Object.keys(allData).filter(k => k !== pluginId)];
        for (const pid of order) {
            for (const o of (allData[pid]?.outfits || [])) {
                if (o.name && !(o.name in merged)) merged[o.name] = o;
            }
        }
        // Also include sbAllOutfits from shipBuilder (live mirror)
        if (typeof sbAllOutfits !== 'undefined') {
            for (const o of sbAllOutfits) {
                const n = (o.name || '').replace(/^"|"$/g, '');
                if (n && !(n in merged)) merged[n] = o;
            }
        }
        return merged;
    }

    // ── Section renderers ──────────────────────────────────────────────────────

    function _val(computed, fnKey, attrs, rawKey) {
        // 1. Try computed _fn_ key first (most accurate — includes outfits)
        const fnResult = computed[`_fn_${fnKey}`];
        if (fnResult != null && !isNaN(fnResult) && fnResult !== 0) return fnResult;
        // 2. Try raw attribute from ship base attrs
        if (rawKey != null) {
            const rv = parseFloat((attrs || {})[rawKey] ?? '');
            if (!isNaN(rv) && rv !== 0) return rv;
        }
        return null;
    }

    function _fmtNum(v) {
        if (v === null || v === undefined || isNaN(v)) return '—';
        if (Number.isInteger(v) && Math.abs(v) >= 10000) return v.toLocaleString();
        return parseFloat(v.toPrecision(4)).toString();
    }

    function _statCard(label, value, unit, highlight) {
        const cls = highlight ? ' sbs-card--hi' : '';
        const unitHtml = unit ? `<span class="sbs-card-unit">${unit}</span>` : '';
        return `<div class="sbs-card${cls}">
    <div class="sbs-card-label">${label}</div>
    <div class="sbs-card-value">${_fmtNum(value)}${unitHtml}</div>
</div>`;
    }

    function _statCardRaw(label, value, unit) {
        const unitHtml = unit ? `<span class="sbs-card-unit">${unit}</span>` : '';
        return `<div class="sbs-card">
    <div class="sbs-card-label">${label}</div>
    <div class="sbs-card-value">${value}${unitHtml}</div>
</div>`;
    }

    function _sectionWrap(title, cardsHtml) {
        if (!cardsHtml) return '';
        return `<div class="sbs-section">
    <div class="sbs-section-title">${title}</div>
    <div class="sbs-cards">${cardsHtml}</div>
</div>`;
    }

    // ── Combat ──────────────────────────────────────────────────────────────────

    function _renderCombat(computed, attrs) {
        const shields    = _val(computed, 'MaxShields',       attrs, 'shields');
        const hull       = _val(computed, 'MaxHull',          attrs, 'hull');
        const heatDiss   = _val(computed, 'HeatDissipation',  attrs, 'heat dissipation');
        const idleHeat   = _val(computed, 'IdleHeat',         attrs);
        const maxHeat    = _val(computed, 'MaximumHeat',      attrs);
        const shieldRegen = (parseFloat(attrs['shield generation'] ?? 0) * 60) || null;
        const hullRepair  = (parseFloat(attrs['hull repair rate']   ?? 0) * 60) || null;

        // Time-to-full derived values
        const ttfShields = (shields && shieldRegen) ? shields / shieldRegen : null;
        const ttfHull    = (hull    && hullRepair)  ? hull    / hullRepair  : null;

        // Idle heat percentage
        const idleHeatPct = (idleHeat && maxHeat) ? (idleHeat / maxHeat * 100) : null;

        let cards = '';
        cards += _statCard('Max Shields',      shields,      'hp',  shields > 0);
        cards += _statCard('Max Hull',         hull,         'hp',  hull > 0);
        cards += _statCard('Shield Regen',     shieldRegen,  '/s');
        cards += _statCard('Hull Repair',      hullRepair,   '/s');
        cards += _statCard('Heat Dissipation', heatDiss,     '');
        cards += _statCard('Idle Heat',        idleHeat,     '');
        if (idleHeatPct !== null) cards += _statCard('Idle Heat %',   idleHeatPct,  '%');
        if (maxHeat     !== null) cards += _statCard('Maximum Heat',  maxHeat,      '');
        if (ttfShields  !== null) cards += _statCard('TTF Shields',   ttfShields,   's');
        if (ttfHull     !== null) cards += _statCard('TTF Hull',      ttfHull,      's');

        // Status resistances
        const resistKeys = [
            ['ion resistance',         'Ion Resist'],
            ['scramble resistance',    'Scramble Resist'],
            ['disruption resistance',  'Disruption Resist'],
            ['slowing resistance',     'Slow Resist'],
            ['burn resistance',        'Burn Resist'],
            ['discharge resistance',   'Discharge Resist'],
            ['corrosion resistance',   'Corrosion Resist'],
            ['leak resistance',        'Leak Resist'],
        ];
        let resistCards = '';
        for (const [key, label] of resistKeys) {
            const v = parseFloat(attrs[key] ?? 0);
            if (v) resistCards += _statCard(label, v, '');
        }

        let html = _sectionWrap('Combat Stats', cards);
        if (resistCards) html += _sectionWrap('Status Resistances', resistCards);
        return html;
    }

    // ── Movement ───────────────────────────────────────────────────────────────

    function _renderMovement(computed, attrs) {
        const maxVel   = _val(computed, 'MaxVelocity',         attrs);
        const accel    = _val(computed, 'Acceleration',        attrs);
        const turn     = _val(computed, 'TurnRate',            attrs);
        const revVel   = _val(computed, 'MaxReverseVelocity',  attrs);
        const revAcc   = _val(computed, 'ReverseAcceleration', attrs);
        const drag     = _val(computed, 'Drag',                attrs, 'drag');
        const mass     = _val(computed, 'Mass',                attrs, 'mass') || parseFloat(sbCurrentShip?.mass ?? 0) || null;
        const inerMass = _val(computed, 'InertialMass',        attrs);

        let cards = '';
        cards += _statCard('Max Velocity',   maxVel,   '',    maxVel  > 0);
        cards += _statCard('Acceleration',   accel,    '',    accel   > 0);
        cards += _statCard('Turn Rate',      turn,     '°/s', turn    > 0);
        cards += _statCard('Rev. Velocity',  revVel,   '');
        cards += _statCard('Rev. Accel.',    revAcc,   '');
        cards += _statCard('Drag',           drag,     '');
        cards += _statCard('Mass',           mass,     't',   mass    > 0);
        cards += _statCard('Inertial Mass',  inerMass, '');

        // Afterburner
        const abThrust = parseFloat(attrs['afterburner thrust']  ?? 0) || null;
        const abFuel   = parseFloat(attrs['afterburner fuel']    ?? 0) || null;
        let abCards = '';
        if (abThrust) abCards += _statCard('AB Thrust', abThrust, '');
        if (abFuel)   abCards += _statCard('AB Fuel/s', abFuel * 60, '/s');

        let html = _sectionWrap('Movement Stats', cards);
        if (abCards) html += _sectionWrap('Afterburner', abCards);
        return html;
    }

    // ── Power ──────────────────────────────────────────────────────────────────

    function _renderPower(computed, attrs) {
        const eCap    = parseFloat(attrs['energy capacity']    ?? 0) || null;
        const fCap    = parseFloat(attrs['fuel capacity']      ?? 0) || null;
        const eGen    = (parseFloat(attrs['energy generation'] ?? 0) * 60) || null;
        const eCon    = (parseFloat(attrs['energy consumption']?? 0) * 60) || null;
        const solar   = (parseFloat(attrs['solar collection']  ?? 0) * 60) || null;
        const ramscoop= parseFloat(attrs['ramscoop']           ?? 0) || null;
        const cooling = (parseFloat(attrs['cooling']           ?? 0) * 60) || null;
        const coolEff = _val(computed, 'CoolingEfficiency', attrs);

        // Net energy: generation - consumption  (per second)
        const eNet = ((eGen ?? 0) - (eCon ?? 0)) || null;

        let cards = '';
        cards += _statCard('Energy Cap.',     eCap,    'J',    eCap  > 0);
        cards += _statCard('Generation',      eGen,    '/s',   eGen  > 0);
        cards += _statCard('Consumption',     eCon,    '/s');
        if (eNet !== null) {
            const isPositive = eNet >= 0;
            cards += _statCardRaw(
                'Net Energy/s',
                `<span style="color:${isPositive ? 'var(--sbs-pos)' : 'var(--sbs-neg)'}">${_fmtNum(eNet)}</span>`,
                '/s'
            );
        }
        cards += _statCard('Fuel Cap.',       fCap,    '');
        cards += _statCard('Solar',           solar,   '/s');
        cards += _statCard('Ramscoop',        ramscoop,'');
        cards += _statCard('Cooling',         cooling, '/s');
        cards += _statCard('Cool. Efficiency',coolEff, '');

        // Derived energy costs from intermediates
        const derivedPower = [];
        for (const [key, val] of Object.entries(computed)) {
            if (!key.startsWith('_derived_energy_')) continue;
            const label = key.replace('_derived_energy_', '').replace(/_/g, ' ');
            if (val && !isNaN(val)) derivedPower.push({ label, val });
        }
        let derivedCards = '';
        for (const { label, val } of derivedPower)
            derivedCards += _statCard(_capFirst(label) + ' Energy', val, '/s');

        let html = _sectionWrap('Power Stats', cards);
        if (derivedCards) html += _sectionWrap('Energy Costs (computed)', derivedCards);
        return html;
    }

    // ── Weapons ────────────────────────────────────────────────────────────────

    function _renderWeapons(wData, ship) {
        if (!wData || !wData.weaponCount) {
            return `<div class="sbs-section">
    <div class="sbs-section-title">Weapons</div>
    <div class="sbs-placeholder">No weapons installed with calculable DPS.</div>
</div>`;
        }

        // Summary cards
        let summaryCards = '';
        summaryCards += _statCard('Total DPS',      wData.totalDps,   'dps', wData.totalDps  > 0);
        summaryCards += _statCard('Shield DPS',     wData.shieldDps,  'dps', wData.shieldDps > 0);
        summaryCards += _statCard('Hull DPS',       wData.hullDps,    'dps', wData.hullDps   > 0);
        summaryCards += _statCard('Weapon Types',   wData.weaponCount,'');
        summaryCards += _statCard('Total Mounts',   wData.totalWeaponMounts, '');

        // DPS by type breakdown
        let dpsTypeCards = '';
        for (const [key, val] of Object.entries(wData.dpsByType || {})) {
            if (!val) continue;
            const label = key.replace(/ damage$/, '').split(' ').map(_capFirst).join(' ') + ' DPS';
            dpsTypeCards += _statCard(label, val, 'dps');
        }

        // Per-weapon table
        let weaponRows = wData.weapons.map(w => {
            const rangeStr  = w.profile.effectiveRange ? _fmtNum(w.profile.effectiveRange) + ' px' : '—';
            const homingBadge = w.profile.isHoming ? '<span class="sbs-badge sbs-badge--blue">HOMING</span>' : '';
            const ammoBadge   = w.profile.hasAmmo   ? `<span class="sbs-badge sbs-badge--amber">AMMO</span>` : '';
            const antiMBadge  = w.profile.isAntiMissile ? '<span class="sbs-badge sbs-badge--red">A-M</span>' : '';
            return `<tr>
    <td class="sbs-wt-name">${w.outfitName}${w.count > 1 ? ` <span class="sbs-wt-count">×${w.count}</span>` : ''}
        ${homingBadge}${ammoBadge}${antiMBadge}
    </td>
    <td class="sbs-wt-num">${_fmtNum(w.profile.shotsPerSecond)}</td>
    <td class="sbs-wt-num">${rangeStr}</td>
    <td class="sbs-wt-num sbs-wt-dps">${_fmtNum(w.scaledDps)}</td>
</tr>`;
        }).join('');

        const weaponTable = weaponRows ? `
<div class="sbs-section">
    <div class="sbs-section-title">Installed Weapons</div>
    <table class="sbs-weapon-table">
        <thead><tr>
            <th>Weapon</th><th>Shots/s</th><th>Range</th><th>DPS</th>
        </tr></thead>
        <tbody>${weaponRows}</tbody>
    </table>
</div>` : '';

        // Ammo requirements
        let ammoHtml = '';
        if (wData.hasAmmoWeapons && wData.ammoRequired?.length) {
            const ammoCards = wData.ammoRequired.map(a =>
                _statCard(`${a.ammoOutfitName}`, a.totalShotsPerSecond, 'shots/s consumed')
            ).join('');
            ammoHtml = _sectionWrap('⚠ Ammo Required', ammoCards);
        }

        return _sectionWrap('Weapon Summary', summaryCards)
             + (dpsTypeCards ? _sectionWrap('DPS by Type', dpsTypeCards) : '')
             + weaponTable
             + ammoHtml;
    }

    // ── Crew & Misc ────────────────────────────────────────────────────────────

    function _renderCrew(computed, attrs) {
        const reqCrew  = _val(computed, 'RequiredCrew', attrs, 'required crew');
        const bunks    = parseFloat(attrs['bunks']          ?? 0) || null;
        const cargo    = parseFloat(attrs['cargo space']    ?? 0) || null;
        const fuelCap  = parseFloat(attrs['fuel capacity']  ?? 0) || null;
        const cost     = parseFloat(attrs['cost']           ?? 0) || null;
        const cloakSpd = _val(computed, 'CloakingSpeed', attrs);
        const jumpFuel = parseFloat(attrs['jump fuel']      ?? 0) || null;
        const jumpRange= parseFloat(attrs['jump range']     ?? 0) || null;

        let cards = '';
        cards += _statCard('Required Crew',   reqCrew,   '');
        cards += _statCard('Bunks',           bunks,     '');
        cards += _statCard('Cargo Space',     cargo,     't');
        cards += _statCard('Fuel Capacity',   fuelCap,   '');
        cards += _statCard('Cost',            cost,      'cr');
        if (cloakSpd) cards += _statCard('Cloak Speed',  cloakSpd,  '');

        let navCards = '';
        if (jumpFuel)  navCards += _statCard('Jump Fuel',  jumpFuel,  '');
        if (jumpRange) navCards += _statCard('Jump Range', jumpRange, '');

        // Any _fn_ keys we haven't covered in other tabs
        const shownFns = new Set(['MaxShields','MaxHull','HeatDissipation','IdleHeat',
            'MaximumHeat','MaxVelocity','Acceleration','TurnRate','MaxReverseVelocity',
            'ReverseAcceleration','Drag','Mass','InertialMass','CoolingEfficiency',
            'RequiredCrew','CloakingSpeed']);
        let extraCards = '';
        for (const [key, val] of Object.entries(computed)) {
            if (!key.startsWith('_fn_')) continue;
            const fnName = key.slice(4);
            if (shownFns.has(fnName)) continue;
            if (!val || isNaN(val)) continue;
            const info = FN_MAP.get(fnName);
            const label = info?.label ?? fnName.replace(/([A-Z])/g, ' $1').trim();
            const unit  = info?.unit  ?? '';
            extraCards += _statCard(label, val, unit);
        }

        let html = _sectionWrap('Crew & Misc', cards);
        if (navCards)   html += _sectionWrap('Navigation', navCards);
        if (extraCards) html += _sectionWrap('Other Computed', extraCards);
        return html;
    }

    // ── All fns fallback ───────────────────────────────────────────────────────

    function _renderAllFns(computed) {
        let cards = '';
        for (const [key, val] of Object.entries(computed)) {
            if (!key.startsWith('_fn_')) continue;
            if (!val || isNaN(val)) continue;
            const fnName = key.slice(4);
            const info   = FN_MAP.get(fnName);
            const label  = info?.label ?? fnName.replace(/([A-Z])/g, ' $1').trim();
            cards += _statCard(label, val, info?.unit ?? '');
        }
        return _sectionWrap('All Computed Stats', cards);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _capFirst(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // ── CSS ────────────────────────────────────────────────────────────────────

    function _css() {
        return `
/* ── SBS Panel ─────────────────────────────────────────────────────────────── */
:root {
    --sbs-bg:          #0f172a;
    --sbs-surface:     #1e293b;
    --sbs-surface2:    #263347;
    --sbs-border:      rgba(99,179,237,0.18);
    --sbs-accent:      #63b3ed;
    --sbs-accent2:     #38bdf8;
    --sbs-text:        #e2e8f0;
    --sbs-muted:       #64748b;
    --sbs-dim:         #475569;
    --sbs-pos:         #4ade80;
    --sbs-neg:         #f87171;
    --sbs-warn:        #fbbf24;
    --sbs-tab-active:  #1d4ed8;
    --sbs-r:           8px;
    --sbs-r-sm:        5px;
}

.sbs-root {
    margin-top: 28px;
    border: 1px solid var(--sbs-border);
    border-radius: var(--sbs-r);
    background: var(--sbs-bg);
    overflow: hidden;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(99,179,237,0.08);
}

.sbs-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    background: var(--sbs-surface);
    border-bottom: 1px solid var(--sbs-border);
    flex-wrap: wrap;
}

.sbs-title {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--sbs-accent);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    white-space: nowrap;
    margin-right: 4px;
}

.sbs-tabs {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    flex: 1;
}

.sbs-tab {
    padding: 4px 11px;
    border-radius: var(--sbs-r-sm);
    border: 1px solid var(--sbs-border);
    background: transparent;
    color: var(--sbs-muted);
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
}

.sbs-tab:hover {
    background: var(--sbs-surface2);
    color: var(--sbs-text);
    border-color: var(--sbs-accent);
}

.sbs-tab--active {
    background: var(--sbs-tab-active);
    color: #fff;
    border-color: var(--sbs-tab-active);
}

.sbs-collapse-btn {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: var(--sbs-r-sm);
    border: 1px solid var(--sbs-border);
    background: transparent;
    color: var(--sbs-muted);
    font-size: 0.7rem;
    cursor: pointer;
    flex-shrink: 0;
}

.sbs-collapse-btn:hover { color: var(--sbs-text); border-color: var(--sbs-accent); }

.sbs-body {
    padding: 14px 16px 16px;
    max-height: 420px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--sbs-dim) transparent;
}

.sbs-body::-webkit-scrollbar       { width: 5px; }
.sbs-body::-webkit-scrollbar-track { background: transparent; }
.sbs-body::-webkit-scrollbar-thumb { background: var(--sbs-dim); border-radius: 3px; }

.sbs-content { display: flex; flex-direction: column; gap: 18px; }

.sbs-placeholder {
    color: var(--sbs-muted);
    font-size: 0.84rem;
    font-style: italic;
    padding: 16px 0;
    text-align: center;
}

/* ── Sections ──────────────────────────────────────────────────────────────── */

.sbs-section { display: flex; flex-direction: column; gap: 8px; }

.sbs-section-title {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--sbs-accent);
    border-bottom: 1px solid var(--sbs-border);
    padding-bottom: 4px;
    margin-bottom: 2px;
}

.sbs-cards {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

/* ── Stat cards ────────────────────────────────────────────────────────────── */

.sbs-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    background: var(--sbs-surface);
    border: 1px solid var(--sbs-border);
    border-radius: var(--sbs-r-sm);
    padding: 6px 10px;
    min-width: 90px;
    max-width: 160px;
    transition: border-color 0.15s;
}

.sbs-card:hover { border-color: var(--sbs-accent); }

.sbs-card--hi {
    border-color: rgba(99,179,237,0.4);
    background: var(--sbs-surface2);
}

.sbs-card-label {
    font-size: 0.62rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--sbs-muted);
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
}

.sbs-card-value {
    font-size: 0.92rem;
    font-weight: 700;
    color: var(--sbs-text);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.sbs-card-unit {
    font-size: 0.65rem;
    font-weight: 400;
    color: var(--sbs-muted);
    margin-left: 3px;
}

/* ── Weapon table ──────────────────────────────────────────────────────────── */

.sbs-weapon-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
}

.sbs-weapon-table th {
    text-align: left;
    color: var(--sbs-muted);
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 4px 8px;
    border-bottom: 1px solid var(--sbs-border);
    font-weight: 600;
}

.sbs-weapon-table td {
    padding: 5px 8px;
    color: var(--sbs-text);
    border-bottom: 1px solid rgba(99,179,237,0.07);
    vertical-align: middle;
}

.sbs-weapon-table tbody tr:hover td { background: var(--sbs-surface2); }

.sbs-wt-name { font-weight: 600; max-width: 220px; }
.sbs-wt-num  { text-align: right; font-variant-numeric: tabular-nums; color: var(--sbs-muted); }
.sbs-wt-dps  { color: var(--sbs-accent2) !important; font-weight: 700; }
.sbs-wt-count { font-size: 0.7rem; color: var(--sbs-muted); margin-left: 3px; }

/* ── Badges ────────────────────────────────────────────────────────────────── */

.sbs-badge {
    display: inline-block;
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 1px 5px;
    border-radius: 3px;
    vertical-align: middle;
    margin-left: 4px;
}

.sbs-badge--blue  { background: rgba(59,130,246,0.25); color: #93c5fd; border: 1px solid rgba(59,130,246,0.4); }
.sbs-badge--amber { background: rgba(251,191,36,0.2);  color: #fcd34d; border: 1px solid rgba(251,191,36,0.4); }
.sbs-badge--red   { background: rgba(239,68,68,0.2);   color: #fca5a5; border: 1px solid rgba(239,68,68,0.4); }
`;
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    return { refresh, _toggleCollapse, _mount };

})();

// ── Auto-init ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    SBS._mount();
});
