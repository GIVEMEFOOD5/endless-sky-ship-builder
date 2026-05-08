'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderStats.js  —  Live Stats Panel for Ship Builder
//
//  INTEGRATION
//  ─────────────────────────────────────────────────────────────────────────────
//  1. Add mount point to shipBuilder.html:
//         <div id="sbs-panel-mount"></div>
//
//  2. Load AFTER the existing scripts in shipBuilder.html:
//         <script src="../JavaScript/weaponStats.js"></script>
//         <script src="../JavaScript/computedStats.js"></script>
//         <script src="../JavaScript/shipBuilderStats.js"></script>
//
//  3. Add ONE call at the very END of the DOMContentLoaded block:
//         SBS.hookIntoBuilder();
//
//  DESIGN PHILOSOPHY
//  ─────────────────────────────────────────────────────────────────────────────
//  Zero hardcoded attribute names. All grouping is driven by substring matching
//  against the keys in window.attrDefs.attributes. Each named tab section is
//  defined only by a set of keyword tokens — any attribute key that contains
//  one of those tokens lands in that section (case-insensitive).
//
//  Values are allowed to appear in multiple sections (by design).
//
//  "Other"    tab = attributes NOT matched by any keyword group.
//  "Everything" tab = ALL attributes (plus weapon DPS) with no filtering.
// ═══════════════════════════════════════════════════════════════════════════════

const SBS = (() => {
    'use strict';

    const FPS      = 60;
    const MAX_TEMP = 100; // MAXIMUM_TEMPERATURE in Ship.cpp

    // ─────────────────────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────────────────────

    let _panel      = null;
    let _activeTab  = 'combat';
    let _rafPending = false;
    let _hooked     = false;

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB DEFINITIONS
    //
    //  Each tab (except "other" and "everything") declares:
    //    sections: [ { title, tokens: [string, ...] }, ... ]
    //
    //  A token is a lowercase substring. Any attribute key that contains ANY of
    //  a section's tokens is shown under that section.  Tokens are matched
    //  against the full lowercased key, so "shield" matches "shield generation",
    //  "shield energy", "cloaking shields", etc.
    //
    //  A key can appear in multiple sections — that's intentional.
    //
    //  The set of ALL tokens across ALL named tabs forms _coveredTokens. Any key
    //  NOT containing any covered token lands in "Other".
    // ─────────────────────────────────────────────────────────────────────────

    const TAB_DEFS = [
        {
            id: 'combat',
            label: '🛡 Combat',
            sections: [
                { title: '🛡 Shields',            tokens: ['shield'] },
                { title: '🔧 Hull',               tokens: ['hull'] },
                { title: '🔥 Heat & Cooling',     tokens: ['heat', 'cooling', 'temperature'] },
                { title: '⚡ Damage Protections', tokens: ['protection'] },
                { title: '🧪 Status Resistances', tokens: ['resistance'] },
                { title: '⏱ Regen Delays',        tokens: ['delay'] },
                { title: '🎯 Threshold',          tokens: ['threshold'] },
            ],
        },
        {
            id: 'movement',
            label: '🚀 Movement',
            sections: [
                { title: '⚖ Mass & Inertia',   tokens: ['mass', 'inertia', 'drag'] },
                { title: '🔹 Thrust',            tokens: ['thrust', 'thrusting'] },
                { title: '🔁 Reverse Thrust',    tokens: ['reverse'] },
                { title: '🔥 Afterburner',       tokens: ['afterburner'] },
                { title: '↪ Turning',            tokens: ['turn', 'turning'] },
            ],
        },
        {
            id: 'power',
            label: '⚡ Power',
            sections: [
                { title: '⚡ Energy',   tokens: ['energy'] },
                { title: '⛽ Fuel',     tokens: ['fuel'] },
                { title: '☀ Solar',    tokens: ['solar'] },
                { title: '🌀 Ramscoop', tokens: ['ramscoop'] },
                { title: '🔥 Heat',    tokens: ['heat', 'cooling', 'temperature'] },
            ],
        },
        {
            id: 'weapons',
            label: '🔫 Weapons',
            // weapon tab uses custom renderer — sections here only for capacity
            sections: [
                { title: '📦 Capacity',       tokens: ['weapon capacity', 'engine capacity', 'outfit space', 'gun port', 'turret'] },
                { title: '💥 Damage & Firing', tokens: ['damage', 'firing'] },
                { title: '🎯 Tracking',        tokens: ['tracking'] },
                { title: '💥 Piercing',        tokens: ['piercing'] },
                { title: '🔧 Anti-Missile',    tokens: ['anti-missile'] },
            ],
        },
        {
            id: 'crew',
            label: '👤 Misc',
            sections: [
                { title: '👥 Crew',        tokens: ['crew'] },
                { title: '📦 Cargo',       tokens: ['cargo'] },
                { title: '📦 Capacity',    tokens: ['outfit space', 'engine capacity', 'weapon capacity', 'gun port', 'turret mount', 'bunks'] },
                { title: '🛸 Cloaking',    tokens: ['cloak'] },
                { title: '🧭 Navigation',  tokens: ['jump', 'hyperdrive', 'scram drive', 'jump drive', 'nav'] },
                { title: '🔭 Scanning',    tokens: ['scan'] },
            ],
        },
    ];

    // Build a flat set of ALL tokens used by named tabs (for "Other" exclusion)
    const _allNamedTokens = (() => {
        const set = new Set();
        for (const tab of TAB_DEFS)
            for (const sec of tab.sections)
                for (const tok of sec.tokens)
                    set.add(tok.toLowerCase());
        return set;
    })();

    // Returns true if a key is "covered" by the named tabs
    function _isCovered(key) {
        const lk = key.toLowerCase();
        for (const tok of _allNamedTokens)
            if (lk.includes(tok)) return true;
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HOOK INTO BUILDER
    // ─────────────────────────────────────────────────────────────────────────

    function hookIntoBuilder() {
        if (_hooked) return;
        _hooked = true;

        const TARGETS = [
            'sbUpdateAttrVal', 'sbRemoveAttr', 'confirmAddAttr',
            'sbUpdateOutfitCount', 'sbRemoveOutfit',
            'sbAddOutfitFromPicker', 'confirmAddOutfit',
            'sbRemoveHP', 'addGunTurret', 'sbUpdateHP',
            'sbUpdateWeaponField',
            'sbUpdateExplode', 'sbRemoveExplode',
            'sbAddEffectFromPicker', 'sbUpdateLeak', 'sbRemoveLeak',
            'onBuilderChange',
            'importRaw', 'sbPickShip', 'sbEditFleetShip',
            'newShip', 'openOutfitExisting', 'openEditExisting',
        ];

        for (const fnName of TARGETS) {
            if (typeof window[fnName] !== 'function') continue;
            const orig = window[fnName];
            window[fnName] = function (...args) {
                const result = orig.apply(this, args);
                requestAnimationFrame(() => refresh());
                return result;
            };
        }

        document.addEventListener('input', e => {
            const id = e.target?.id;
            if (id === 'ship-name' || id === 'ship-variant' || id === 'ship-plural')
                requestAnimationFrame(() => refresh());
        });

        console.log('[SBS] Hooked into builder.');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  REFRESH
    // ─────────────────────────────────────────────────────────────────────────

    function refresh() {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => {
            _rafPending = false;
            if (!_panel) _mount();
            if (!_panel) return;
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            const builderHidden = document.getElementById('builder-view')?.classList.contains('hidden');
            if (!ship || builderHidden) return;
            if (typeof ComputedStats !== 'undefined') ComputedStats.clearCache();
            _renderContent(ship);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  OUTFIT INDEX
    // ─────────────────────────────────────────────────────────────────────────

    function _buildOutfitIndex() {
        const allData   = window.allData || {};
        const sbOutfits = (typeof sbAllOutfits !== 'undefined') ? sbAllOutfits : [];
        const merged    = {};
        for (const o of [
            ...Object.values(allData).flatMap(p => p?.outfits || []),
            ...sbOutfits,
        ]) {
            const name = (o.name || o.displayName || '').replace(/^"|"$/g, '').trim();
            if (!name || name in merged) continue;
            const flat = { ...o };
            if (o.attributes && typeof o.attributes === 'object')
                for (const [k, v] of Object.entries(o.attributes))
                    if (!(k in flat)) flat[k] = v;
            flat.name = name;
            merged[name] = flat;
        }
        return merged;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  EFFECTIVE ATTRIBUTES  — base ship attrs + all outfit contributions
    // ─────────────────────────────────────────────────────────────────────────

    const _META = new Set([
        'name','category','series','index','cost','thumbnail','sprite',
        'description','pluginId','weapon','governments','locations',
        '_internalId','_pluginId','_hash','_pn','_pd','_isVariant',
        'displayName','spriteData','attributes',
    ]);

    function _buildEffectiveAttrs(ship, outfitIdx) {
        const eff = {};
        for (const [k, v] of Object.entries(ship.attributes || {})) {
            if (typeof v === 'number') eff[k] = v;
            else if (typeof v === 'string') { const n = parseFloat(v); if (!isNaN(n)) eff[k] = n; }
        }
        if (ship.mass && ship.mass !== '') eff['mass'] = parseFloat(ship.mass) || 0;
        if (ship.drag && ship.drag !== '') eff['drag'] = parseFloat(ship.drag) || 0;

        for (const entry of (ship.outfits || [])) {
            const name  = (entry.name || '').replace(/^"|"$/g, '').trim();
            const count = parseInt(entry.count) || 1;
            const o = outfitIdx[name];
            if (!o) continue;
            for (const [key, rawVal] of Object.entries(o)) {
                if (_META.has(key) || key.startsWith('_')) continue;
                if (typeof rawVal !== 'number' || rawVal === 0) continue;
                eff[key] = (eff[key] || 0) + rawVal * count;
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
            const outfitMap = {};
            for (const entry of (ship.outfits || [])) {
                const name  = (entry.name || '').replace(/^"|"$/g, '').trim();
                const count = parseInt(entry.count) || 1;
                if (name) outfitMap[name] = (outfitMap[name] || 0) + count;
            }
            const stats = WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx);
            // Attach the raw outfit index so _tabWeapons can read all weapon fields
            if (stats) stats._outfitIdx = outfitIdx;
            return stats;
        } catch (e) { console.warn('[SBS] WeaponStats error:', e); return null; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  DOM MOUNT
    // ─────────────────────────────────────────────────────────────────────────

    function _mount() {
        const mount = document.getElementById('sbs-panel-mount');
        if (!mount) { console.warn('[SBS] Mount point #sbs-panel-mount not found.'); return; }

        const tabDefs = [
            ...TAB_DEFS.map(t => ({ id: t.id, label: t.label })),
            { id: 'other',      label: '📋 Other'      },
            { id: 'everything', label: '🌐 Everything' },
        ];

        mount.innerHTML = `
<div id="sbs-root" class="sbs-root">
    <div class="sbs-header">
        <span class="sbs-title">📊 Live Ship Stats</span>
        <div class="sbs-tabs">${tabDefs.map(t =>
            `<button class="sbs-tab${t.id === _activeTab ? ' sbs-tab--active' : ''}" data-sbs-tab="${t.id}">${t.label}</button>`
        ).join('')}</div>
        <button class="sbs-collapse-btn" id="sbs-collapse-btn" title="Toggle stats panel">▲</button>
    </div>
    <div class="sbs-body" id="sbs-body">
        <div id="sbs-content" class="sbs-content">
            <div class="sbs-empty">Add attributes or outfits to see live stats.</div>
        </div>
    </div>
</div>`;

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
    //  DERIVED HEAT VALUES
    //
    //  All key lookups use substring matching — zero hardcoding.
    //
    //  heatCapAttr  = first key in eff whose lowercased form is exactly
    //                 "heat capacity" (raw attribute, NOT computed max-heat).
    //  heatDissAttr = first key in eff whose lowercased form contains
    //                 "heat dissipation".
    //
    //  totalMass    = ship base mass  +  sum of (outfit.mass * count) for every
    //                 installed outfit that has a numeric mass field.
    //                 This is ship+outfit combined mass, NOT the physics
    //                 inertial mass (which may be reduced by inertia reduction).
    //
    //  Derived:
    //    totalHeatCapacity      = totalMass * MAX_TEMP
    //
    //    maxSustainableHeatProd = (totalMass + heatCapAttr) * heatDiss * 6
    //        Maximum heat/s the ship can produce while staying in equilibrium.
    // ─────────────────────────────────────────────────────────────────────────

    function _computeHeatDerived(eff, ship, outfitIdx) {
        // Ship base mass
        const shipMass = parseFloat(ship.mass) || 0;

        // Sum outfit masses (each outfit may carry a numeric 'mass' field)
        let outfitMassSum = 0;
        for (const entry of (ship.outfits || [])) {
            const name  = (entry.name || '').replace(/^"|"$/g, '').trim();
            const count = parseInt(entry.count) || 1;
            const o = outfitIdx[name];
            if (!o) continue;
            // Find the mass key on the outfit object (case-insensitive exact match)
            const massKey = Object.keys(o).find(k => k.toLowerCase() === 'mass');
            if (massKey && typeof o[massKey] === 'number') outfitMassSum += o[massKey] * count;
        }

        const totalMass = shipMass + outfitMassSum;

        // Heat capacity attribute (exact key name "heat capacity" in eff)
        const heatCapKey  = Object.keys(eff).find(k => k.toLowerCase() === 'heat capacity');
        const heatDissKey = Object.keys(eff).find(k => k.toLowerCase().includes('heat dissipation'));

        const heatCap  = (heatCapKey  && typeof eff[heatCapKey]  === 'number') ? eff[heatCapKey]  : 0;
        const heatDiss = (heatDissKey && typeof eff[heatDissKey] === 'number') ? eff[heatDissKey] : 0;

        const totalHeatCapacity      = totalMass > 0 ? totalMass * MAX_TEMP : null;
        const maxSustainableHeatProd = (heatDiss > 0 && (totalMass + heatCap) > 0)
            ? (totalMass + heatCap) * heatDiss * 6
            : null;

        return { totalHeatCapacity, maxSustainableHeatProd };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  RENDER DISPATCH
    // ─────────────────────────────────────────────────────────────────────────

    function _renderContent(ship) {
        const el = document.getElementById('sbs-content');
        if (!el) return;

        const outfitIdx  = _buildOutfitIndex();
        const eff        = _buildEffectiveAttrs(ship, outfitIdx);
        const wData      = _computeWeaponStats(ship, outfitIdx);
        const ad         = window.attrDefs || null;
        const heatDerived = _computeHeatDerived(eff, ship, outfitIdx);

        let html = '';
        if (_activeTab === 'other') {
            html = _tabOther(eff, ad, ship);
        } else if (_activeTab === 'everything') {
            html = _tabEverything(eff, ad, ship, wData, heatDerived);
        } else if (_activeTab === 'weapons') {
            html = _tabWeapons(wData, eff, ad);
        } else {
            const tabDef = TAB_DEFS.find(t => t.id === _activeTab);
            if (tabDef) html = _tabKeyword(eff, ad, tabDef, heatDerived);
        }

        el.innerHTML = html || `<div class="sbs-empty">No data available.</div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GENERIC KEYWORD-GROUPED TAB RENDERER
    //
    //  For each section in the tabDef, collect every attr key from eff that
    //  contains at least one of the section's tokens (case-insensitive match on
    //  the full lowercased key).  Apply displayMultiplier from attrDefs if
    //  present.  Show the sum of all matched values with their displayUnit.
    // ─────────────────────────────────────────────────────────────────────────

    // Tokens that identify a section as heat-related — derived heat cards are
    // appended to any section whose tokens overlap with this set.
    const _HEAT_SECTION_TOKENS = new Set(['heat', 'cooling', 'temperature']);

    function _tabKeyword(eff, ad, tabDef, heatDerived) {
        const attrMeta = ad?.attributes || {};
        let html = '';

        for (const sec of tabDef.sections) {
            const lowerTokens = sec.tokens.map(t => t.toLowerCase());

            // Collect keys that match any token
            const matchedKeys = Object.keys(eff).filter(key => {
                const lk = key.toLowerCase();
                return lowerTokens.some(tok => lk.includes(tok));
            });

            // Sort matched keys alphabetically
            matchedKeys.sort((a, b) => a.localeCompare(b));

            let cards = '';
            for (const key of matchedKeys) {
                const raw  = eff[key];
                if (typeof raw !== 'number' || raw === 0) continue;
                const meta = attrMeta[key] || {};
                const mult = meta.displayMultiplier ?? 1;
                const unit = meta.displayUnit        ?? '';
                const val  = raw * mult;
                cards += _card(_capWords(key), val, unit);
            }

            // Inject derived heat values into any heat/cooling/temperature section
            const isHeatSection = lowerTokens.some(tok => _HEAT_SECTION_TOKENS.has(tok));
            if (isHeatSection && heatDerived) {
                if (heatDerived.totalHeatCapacity != null)
                    cards += _card('Total Heat Capacity (calc)', heatDerived.totalHeatCapacity, '', true);
                if (heatDerived.maxSustainableHeatProd != null)
                    cards += _card('Max Sustainable Heat/s (calc)', heatDerived.maxSustainableHeatProd, '/s', true);
            }

            if (cards) html += _section(sec.title, cards);
        }

        return html || `<div class="sbs-empty">No ${tabDef.label} attributes found.</div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: WEAPONS
    //
    //  Three tiers of data:
    //
    //  1. Ship-level capacity cards (keyword-matched from eff, same as before).
    //
    //  2. Fleet DPS summary from WeaponStats (computed totals).
    //
    //  3. Per-weapon detail accordion — for each installed weapon outfit we walk
    //     the raw outfit.weapon object and display EVERY field found on it,
    //     regardless of what those fields are.  No hardcoded key list.
    //
    //     Field rendering rules (all driven by the raw value type, no hardcoding):
    //       - numeric               → _fmt(value), with attrDefs unit if known
    //       - boolean / 0/1 flag   → shown as ✓ / ✗
    //       - string               → shown as-is
    //       - plain object         → JSON.stringify (submunition entries, etc.)
    //       - array                → each element on its own row
    //
    //     Fields whose value is an empty array, null, undefined, or 0 are omitted.
    //     The key is formatted with _capWords for readability.
    //
    //  Computed values from WeaponStats profile (shots/s, range, DPS breakdown)
    //  are appended after the raw fields under a "── Computed ──" divider so
    //  nothing is lost.
    // ─────────────────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────────────
    //  _weaponDetailSection
    //
    //  Shows ONLY computed/per-second values for a weapon — no raw per-shot data.
    //
    //  Two groups of rows:
    //
    //  A) "Rate" values — fields on the raw weapon object that are NOT per-shot
    //     firing costs and NOT damage values.  These describe the weapon's
    //     behaviour (reload, velocity, lifetime, inaccuracy, homing strength,
    //     tracking, turn, etc.) and are shown as-is since they are not multiplied
    //     by shots/s in the game.  Boolean/flag values are shown as ✓.
    //     Identified by exclusion: any key that does NOT end in " damage" and
    //     does NOT start with "firing " is a rate/behaviour value.
    //     Submunition/ammo reference fields (arrays/objects/strings that point to
    //     other outfits) are shown as text.
    //
    //  B) "Per-second" values — computed from WeaponStats profile:
    //       • Shots/s
    //       • Effective range
    //       • DPS per damage type  (already per-second from WeaponStats)
    //       • Firing costs × shots/s  → energy/s, heat/s, fuel/s, etc.
    // ─────────────────────────────────────────────────────────────────────────

    function _weaponDetailSection(outfitName, count, outfit, profile, ad) {
        const w        = outfit.weapon || {};
        const attrMeta = ad?.attributes || {};
        const sps      = profile.shotsPerSecond || 0;

        // ── A) Rate / behaviour fields from raw weapon object ──────────────
        // Skip keys that are per-shot costs (start with "firing ") or damage
        // values (end with " damage") — those are handled in section B.
        // Also skip non-scalar reference fields we can't meaningfully display
        // as a number (submunitions arrays are shown as text though).
        const rateRows = [];
        for (const [key, val] of Object.entries(w).sort((a, b) => a[0].localeCompare(b[0]))) {
            const lk = key.toLowerCase();
            if (lk.startsWith('firing '))   continue; // per-shot cost → section B
            if (lk.endsWith(' damage'))     continue; // damage → shown as DPS in B
            if (val === null || val === undefined) continue;

            let display = null;
            if (typeof val === 'boolean')       display = val ? '✓' : '✗';
            else if (typeof val === 'number')   { if (val !== 0) display = _fmt(val); }
            else if (typeof val === 'string')   display = val.trim() || null;
            else if (Array.isArray(val)) {
                if (val.length) display = val.map(el =>
                    typeof el === 'object' ? (el.type ?? el.name ?? JSON.stringify(el)) : String(el)
                ).join(', ');
            } else if (typeof val === 'object') {
                // e.g. legacy submunition object — show name/type if present
                display = val.type ?? val.name ?? JSON.stringify(val);
            }

            if (display === null) continue;
            const meta = attrMeta[key] || {};
            rateRows.push({ label: _capWords(key), display, unit: meta.displayUnit ?? '' });
        }

        // ── B) Per-second computed values ──────────────────────────────────
        const perSecRows = [];
        perSecRows.push({ label: 'Shots/s', display: _fmt(sps), unit: '' });
        if (profile.effectiveRange)
            perSecRows.push({ label: 'Effective Range', display: _fmt(profile.effectiveRange), unit: 'px' });
        // DPS breakdown — already per-second from WeaponStats
        for (const [dmgKey, dps] of Object.entries(profile.dpsBreakdown || {}).sort((a,b) => a[0].localeCompare(b[0])))
            if (dps) perSecRows.push({ label: _capWords(dmgKey.replace(/ damage$/, '')) + ' DPS', display: _fmt(dps), unit: '/s' });
        // Firing costs × shots/s
        for (const [costKey, costVal] of Object.entries(profile.firingCosts || {}).sort((a,b) => a[0].localeCompare(b[0])))
            if (costVal) perSecRows.push({ label: _capWords(costKey.replace(/^firing /, '')) + ' Cost', display: _fmt(costVal * sps), unit: '/s' });

        // ── Build HTML ─────────────────────────────────────────────────────
        const countLabel = count > 1 ? ` <span class="sbs-wt-count">×${count}</span>` : '';
        const badges = [
            profile.isHoming      ? '<span class="sbs-badge sbs-badge--blue">HOMING</span>' : '',
            profile.hasAmmo       ? '<span class="sbs-badge sbs-badge--amber">AMMO</span>'  : '',
            profile.isAntiMissile ? '<span class="sbs-badge sbs-badge--red">A-M</span>'     : '',
        ].join('');

        const mkRow = (label, display, unit, highlight) => {
            const style = highlight ? ' style="color:var(--sbs-pos)"' : '';
            const unitTag = unit ? `<span class="sbs-unit"> ${_esc(unit)}</span>` : '';
            return `<tr><td class="sbs-wt-name"${style}>${_esc(label)}</td><td class="sbs-wt-num">${_esc(display)}${unitTag}</td></tr>`;
        };

        const rateHtml    = rateRows.map(r    => mkRow(r.label, r.display, r.unit, false)).join('');
        const perSecHtml  = perSecRows.map(r  => mkRow(r.label, r.display, r.unit, true)).join('');
        const divider     = rateHtml && perSecHtml
            ? `<tr><td colspan="2" style="padding:4px 6px;font-size:.7rem;opacity:.5;border-top:1px solid var(--sbs-border)">── Per Second ──</td></tr>`
            : '';

        return `
<div class="sbs-section">
  <div class="sbs-section-title">🔫 ${_esc(outfitName)}${countLabel} ${badges}</div>
  <div class="sbs-table-wrap">
    <table class="sbs-table">
      <tbody>
        ${rateHtml}
        ${divider}
        ${perSecHtml}
      </tbody>
    </table>
  </div>
</div>`;
    }

    function _tabWeapons(wData, eff, ad) {
        const attrMeta = ad?.attributes || {};

        // ── Capacity section (keyword-matched from eff) ────────────────────
        const capTokens = TAB_DEFS.find(t => t.id === 'weapons').sections[0].tokens;
        const capKeys = Object.keys(eff)
            .filter(key => capTokens.some(tok => key.toLowerCase().includes(tok)))
            .sort();
        let capCards = '';
        for (const key of capKeys) {
            const raw = eff[key];
            if (typeof raw !== 'number' || raw === 0) continue;
            const meta = attrMeta[key] || {};
            capCards += _card(_capWords(key), raw * (meta.displayMultiplier ?? 1), meta.displayUnit ?? '');
        }
        const capSection = capCards ? _section('📦 Capacity', capCards) : '';

        if (!wData || !wData.weaponCount)
            return capSection + `<div class="sbs-section"><div class="sbs-empty">No weapons installed.</div></div>`;

        // ── Fleet DPS summary ──────────────────────────────────────────────
        let sumCards = '';
        sumCards += _card('Total DPS',    wData.totalDps,          'dps', wData.totalDps  > 0);
        sumCards += _card('Shield DPS',   wData.shieldDps,         'dps', wData.shieldDps > 0);
        sumCards += _card('Hull DPS',     wData.hullDps,           'dps', wData.hullDps   > 0);
        sumCards += _card('Weapon Types', wData.weaponCount,       '');
        sumCards += _card('Total Mounts', wData.totalWeaponMounts, '');

        let typeCards = '';
        for (const [key, val] of Object.entries(wData.dpsByType || {}))
            if (val) typeCards += _card(_capWords(key.replace(/ damage$/, '')) + ' DPS', val, 'dps');

        let ammoCards = '';
        if (wData.hasAmmoWeapons)
            for (const a of (wData.ammoRequired || []))
                ammoCards += _card(_esc(a.ammoOutfitName), _fmt(a.totalShotsPerSecond), 'rounds/s');

        // ── Per-weapon detail sections ─────────────────────────────────────
        const outfitIdx = wData._outfitIdx || {};
        let detailHtml = '';
        for (const w of (wData.weapons || [])) {
            const outfit = outfitIdx[w.outfitName];
            if (!outfit) continue;
            detailHtml += _weaponDetailSection(w.outfitName, w.count, outfit, w.profile, ad);
        }

        return capSection
             + _section('📊 Fleet DPS Summary', sumCards)
             + (typeCards  ? _section('💥 DPS by Type',    typeCards)  : '')
             + (ammoCards  ? _section('⚠ Ammo Required',  ammoCards)  : '')
             + detailHtml;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: OTHER
    //
    //  Shows every key in eff that does NOT contain any of the named-tab tokens.
    //  Applies displayMultiplier + displayUnit from attrDefs.
    //  Also shows string attributes from the base ship that don't match any token.
    // ─────────────────────────────────────────────────────────────────────────

    function _tabOther(eff, ad, ship) {
        const attrMeta = ad?.attributes || {};

        const uncoveredKeys = Object.keys(eff)
            .filter(key => !_isCovered(key) && !key.startsWith('_'))
            .sort();

        let cards = '';
        for (const key of uncoveredKeys) {
            const raw = eff[key];
            if (typeof raw !== 'number' || raw === 0) continue;
            const meta = attrMeta[key] || {};
            const val  = raw * (meta.displayMultiplier ?? 1);
            cards += _card(_capWords(key), val, meta.displayUnit ?? '');
        }

        // String attrs from base ship not covered
        const strEntries = Object.entries(ship.attributes || {})
            .filter(([key, val]) => typeof val === 'string' && val && !_isCovered(key))
            .sort((a, b) => a[0].localeCompare(b[0]));

        for (const [key, val] of strEntries)
            cards += `<div class="sbs-card"><div class="sbs-label">${_esc(_capWords(key))}</div><div class="sbs-value" style="font-size:.78rem">${_esc(val)}</div></div>`;

        if (!cards)
            return `<div class="sbs-empty">No additional attributes found.</div>`;

        return `<div class="sbs-section"><div class="sbs-section-title">📋 Uncategorised Attributes</div><div class="sbs-cards">${cards}</div></div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: EVERYTHING
    //
    //  Shows ALL numeric attributes in eff (with displayMultiplier applied),
    //  PLUS weapon DPS data, sorted alphabetically.
    //  Excludes the raw 'weapon' object on the ship itself (non-numeric anyway).
    //  Internal keys (_*) are excluded.
    // ─────────────────────────────────────────────────────────────────────────

    function _tabEverything(eff, ad, ship, wData, heatDerived) {
        const attrMeta = ad?.attributes || {};

        // All numeric keys sorted
        const allKeys = Object.keys(eff)
            .filter(key => !key.startsWith('_') && typeof eff[key] === 'number' && eff[key] !== 0)
            .sort();

        let cards = '';
        for (const key of allKeys) {
            const raw  = eff[key];
            const meta = attrMeta[key] || {};
            const val  = raw * (meta.displayMultiplier ?? 1);
            cards += _card(_capWords(key), val, meta.displayUnit ?? '');
        }

        // String attributes
        const strEntries = Object.entries(ship.attributes || {})
            .filter(([key, val]) => typeof val === 'string' && val && !key.startsWith('_'))
            .sort((a, b) => a[0].localeCompare(b[0]));

        for (const [key, val] of strEntries)
            cards += `<div class="sbs-card"><div class="sbs-label">${_esc(_capWords(key))}</div><div class="sbs-value" style="font-size:.78rem">${_esc(val)}</div></div>`;

        // Weapon DPS block
        let wCards = '';
        if (wData && wData.weaponCount) {
            wCards += _card('Total DPS',    wData.totalDps,          'dps');
            wCards += _card('Shield DPS',   wData.shieldDps,         'dps');
            wCards += _card('Hull DPS',     wData.hullDps,           'dps');
            wCards += _card('Weapon Types', wData.weaponCount,       '');
            wCards += _card('Total Mounts', wData.totalWeaponMounts, '');
            for (const [key, val] of Object.entries(wData.dpsByType || {}))
                if (val) wCards += _card(_capWords(key.replace(/ damage$/, '')) + ' DPS', val, 'dps');
        }

        // Derived heat values
        let hCards = '';
        if (heatDerived) {
            if (heatDerived.totalHeatCapacity != null)
                hCards += _card('Total Heat Capacity (calc)', heatDerived.totalHeatCapacity, '', true);
            if (heatDerived.maxSustainableHeatProd != null)
                hCards += _card('Max Sustainable Heat/s (calc)', heatDerived.maxSustainableHeatProd, '/s', true);
        }

        if (!cards && !wCards && !hCards)
            return `<div class="sbs-empty">No attributes found.</div>`;

        return (cards  ? `<div class="sbs-section"><div class="sbs-section-title">🌐 All Attributes</div><div class="sbs-cards">${cards}</div></div>` : '')
             + (hCards ? `<div class="sbs-section"><div class="sbs-section-title">🔥 Derived Heat</div><div class="sbs-cards">${hCards}</div></div>` : '')
             + (wCards ? `<div class="sbs-section"><div class="sbs-section-title">🔫 Weapon DPS</div><div class="sbs-cards">${wCards}</div></div>` : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  VALUE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    function _fmt(v, dp) {
        if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '—';
        if (typeof v !== 'number') return String(v);
        if (dp !== undefined) return v.toFixed(dp);
        if (Number.isInteger(v) && Math.abs(v) >= 1000) return v.toLocaleString();
        return parseFloat(v.toPrecision(4)).toString();
    }

    function _coloured(v, positiveIsGood) {
        if (v === null || v === undefined || isNaN(v)) return '—';
        const color = (positiveIsGood ? v >= 0 : v <= 0) ? 'var(--sbs-pos)' : 'var(--sbs-neg)';
        return `<span style="color:${color};font-weight:700">${_fmt(v)}</span>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HTML HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    function _card(label, value, unit, highlight) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && (isNaN(value) || value === 0)) return '';
        const cls     = highlight ? ' sbs-card--hi' : '';
        const unitTag = unit ? `<span class="sbs-unit">${_esc(unit)}</span>` : '';
        const fmtVal  = typeof value === 'string' ? value : _fmt(value);
        return `<div class="sbs-card${cls}"><div class="sbs-label">${_esc(label)}</div><div class="sbs-value">${fmtVal}${unitTag}</div></div>`;
    }

    function _section(title, content) {
        if (!content || !content.trim()) return '';
        return `<div class="sbs-section"><div class="sbs-section-title">${_esc(title)}</div><div class="sbs-cards">${content}</div></div>`;
    }

    function _tableSection(title, tableHtml) {
        if (!tableHtml) return '';
        return `<div class="sbs-section"><div class="sbs-section-title">${_esc(title)}</div><div class="sbs-table-wrap">${tableHtml}</div></div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  UTILS
    // ─────────────────────────────────────────────────────────────────────────

    function _capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
    function _capWords(s) { return String(s).split(' ').map(_capFirst).join(' '); }
    function _esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    return { refresh, hookIntoBuilder, _mount };

})();

document.addEventListener('DOMContentLoaded', () => { SBS._mount(); });
