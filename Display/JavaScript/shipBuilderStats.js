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
//         <script src="../JavaScript/attributeSections.js"></script>
//         <script src="../JavaScript/itemStats.js"></script>
//         <script src="../JavaScript/shipBuilderStats.js"></script>
//
//  3. Add ONE call at the very END of the DOMContentLoaded block:
//         SBS.hookIntoBuilder();
//
//  DESIGN PHILOSOPHY
//  ─────────────────────────────────────────────────────────────────────────────
//  All calculation — outfit contribution merging, weapon DPS, heat-derived
//  values — is delegated to window.ItemStats (see ItemStats.js), the same
//  backend AttributeDisplay.js and CompareDisplay.js use. This file's own
//  code is limited to two things ItemStats can't know about:
//    1. Adapting the ship builder's in-progress, not-yet-saved data shapes
//       (ship.outfits as an array of {name: '"Quoted Name"', count}, mass/
//       drag as separate top-level string fields, sbAllOutfits as outfits
//       the user is still editing and hasn't saved to window.allData yet)
//       into the plain {attributes, outfits} shape ItemStats expects.
//    2. The live tab UI itself (cards, sections, accordions).
//
//  Section/tab grouping is delegated to the shared AttributeSections module
//  (window.AttributeSections, also used internally by ItemStats), so this
//  panel groups attributes identically to CompareDisplay.js and
//  AttributeDisplay.js. Each tab below names the canonical section(s) (from
//  AttributeSections.SECTION_ORDER) it draws from — AttributeSections.classify()
//  decides membership. Where a tab splits a canonical section into finer
//  visual sub-cards (e.g. "Shields & Hull" → separate Shields and Hull
//  cards), `subFilter` is a purely COSMETIC narrowing of an already-resolved
//  set of keys — it never re-decides which section/tab an attribute belongs to.
//
//  "Other"      tab = attributes whose canonical section isn't referenced
//                      by any named tab below.
//  "Everything" tab = ALL attributes (plus weapon DPS) with no filtering.
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
    //  TAB DEFINITIONS
    // ─────────────────────────────────────────────────────────────────────────

    const TAB_DEFS = [
        {
            id: 'combat',
            label: '🛡 Combat',
            sections: [
                { title: '🛡 Shields',            canonical: ['Shields & Hull'], subFilter: /shield/i },
                { title: '🔧 Hull',               canonical: ['Shields & Hull'], subFilter: /hull/i },
                { title: '🔥 Heat & Cooling',     canonical: ['Energy'], subFilter: /heat|cool|temperature/i },
                { title: '⚡ Damage Protections', canonical: ['Protection'] },
                { title: '🧪 Status Resistances', canonical: ['Resistance'] },
                { title: '⏱ Regen Delays',        canonical: ['Shields & Hull'], subFilter: /delay/i },
                { title: '🎯 Threshold',          canonical: ['Shields & Hull'], subFilter: /threshold/i },
            ],
        },
        {
            id: 'movement',
            label: '🚀 Movement',
            sections: [
                { title: '⚖ Mass & Inertia',   canonical: ['General', 'Engines'], subFilter: /mass|drag|inertia/i },
                { title: '🔹 Thrust',            canonical: ['Engines'], subFilter: /thrust/i },
                { title: '🔁 Reverse Thrust',    canonical: ['Engines'], subFilter: /reverse/i },
                { title: '🔥 Afterburner',       canonical: ['Engines'], subFilter: /afterburner/i },
                { title: '↪ Turning',            canonical: ['Engines'], subFilter: /turn/i },
            ],
        },
        {
            id: 'power',
            label: '⚡ Power',
            sections: [
                { title: '⚡ Energy',   canonical: ['Energy'], subFilter: /(^|\s)energy(\s|$)/i },
                { title: '⛽ Fuel',     canonical: ['Energy'], subFilter: /fuel/i },
                { title: '☀ Solar',    canonical: ['Energy'], subFilter: /solar/i },
                { title: '🌀 Ramscoop', canonical: ['Energy'], subFilter: /ramscoop/i },
                { title: '🔥 Heat',    canonical: ['Energy'], subFilter: /heat|cool|temperature/i },
            ],
        },
        {
            id: 'weapons',
            label: '🔫 Weapons',
            // weapon tab uses custom renderer (_tabWeapons) — sections here
            // are only used for the Capacity card; see capSec below.
            sections: [
                { title: '📦 Capacity',        canonical: ['Cargo', 'Engines', 'Hardpoints'], subFilter: /capacity|outfit space|gun port|turret/i },
                { title: '💥 Damage & Firing', canonical: ['Weapon DPS'], subFilter: /damage|firing/i },
                { title: '🎯 Tracking',        canonical: ['Weapon DPS'], subFilter: /tracking/i },
                { title: '💥 Piercing',        canonical: ['Weapon DPS'], subFilter: /piercing/i },
                { title: '🔧 Anti-Missile',    canonical: ['Weapon DPS'], subFilter: /anti-missile/i },
            ],
        },
        {
            id: 'crew',
            label: '👤 Misc',
            sections: [
                { title: '👥 Crew',        canonical: ['Crew'] },
                { title: '📦 Cargo',       canonical: ['Cargo'], subFilter: /cargo/i },
                { title: '📦 Capacity',    canonical: ['Cargo', 'Engines', 'Hardpoints', 'Crew'], subFilter: /capacity|outfit space|gun port|turret|bunks/i },
                { title: '🛸 Cloaking',    canonical: ['Cloaking'] },
                { title: '🧭 Navigation',  canonical: ['Jump'] },
                { title: '🔭 Scanning',    canonical: ['Scanning'] },
            ],
        },
    ];

    // Every canonical section referenced by any tab above — used to decide
    // what counts as "Other" (i.e. not shown under any named tab).
    const _coveredCanonicalSections = (() => {
        const set = new Set();
        for (const tab of TAB_DEFS)
            for (const sec of tab.sections)
                for (const c of sec.canonical)
                    set.add(c);
        return set;
    })();

    // Returns true if a key's canonical section (per AttributeSections) is
    // covered by a named tab.
    function _isCovered(attrDefs, key) {
        return _coveredCanonicalSections.has(window.AttributeSections.classify(attrDefs, key));
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
            if (window.ComputedStats?.clearCache) window.ComputedStats.clearCache();
            _renderContent(ship);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  BUILDER-SHAPE ADAPTERS
    //
    //  Everything below in this section exists ONLY to translate the ship
    //  builder's in-progress data shapes into the plain {attributes, outfits}
    //  shape window.ItemStats expects. No formulas or classification logic
    //  live here — they're one call away in ItemStats.
    // ─────────────────────────────────────────────────────────────────────────

    // Outfit index = every saved outfit (across all plugins, via ItemStats)
    // PLUS whatever the user is still editing in the builder itself
    // (sbAllOutfits) that hasn't been saved to window.allData yet. Saved
    // outfits take priority on a name collision, matching the original
    // builder behaviour (a still-editing draft shouldn't clobber the
    // canonical saved version of an outfit with the same name).
    function _buildOutfitIndex() {
        const merged = window.ItemStats.buildOutfitIndex();
        const sbOutfits = (typeof sbAllOutfits !== 'undefined') ? sbAllOutfits : [];
        for (const o of sbOutfits) {
            const name = (o.name || o.displayName || '').replace(/^"|"$/g, '').trim();
            if (!name || name in merged) continue;
            merged[name] = o;
        }
        return merged;
    }

    // Normalizes a builder ship object into the plain shape ItemStats
    // functions expect: `attributes` (with mass/drag folded in from their
    // separate top-level string fields) and `outfits` (array of
    // {name, count} with quote-wrapped names trimmed and counts parsed).
    function _normalizedShipItem(ship) {
        const attributes = { ...(ship.attributes || {}) };
        if (ship.mass !== undefined && ship.mass !== '') attributes.mass = parseFloat(ship.mass) || 0;
        if (ship.drag !== undefined && ship.drag !== '') attributes.drag = parseFloat(ship.drag) || 0;

        const outfits = (ship.outfits || [])
            .map(entry => ({
                name: (entry.name || '').replace(/^"|"$/g, '').trim(),
                count: parseInt(entry.count) || 1,
            }))
            .filter(e => e.name);

        return { attributes, outfits };
    }

    // Base ship attrs + every installed outfit's numeric attribute
    // contributions, merged. Delegates entirely to ItemStats.buildEffectiveAttrs.
    function _buildEffectiveAttrs(ship, outfitIdx) {
        return window.ItemStats.buildEffectiveAttrs(_normalizedShipItem(ship), outfitIdx);
    }

    // Fleet weapon DPS summary + per-weapon profiles. Delegates to
    // ItemStats.getShipWeaponData, which itself wraps window.WeaponStats.
    function _computeWeaponStats(ship, outfitIdx) {
        try { return window.ItemStats.getShipWeaponData(_normalizedShipItem(ship), outfitIdx); }
        catch (e) { console.warn('[SBS] WeaponStats error:', e); return null; }
    }

    // Total heat capacity / max sustainable heat production. Delegates to
    // ItemStats.getHeatDerivedRows and reshapes the row list back into the
    // {totalHeatCapacity, maxSustainableHeatProd} pair this file's render
    // functions already expect, so nothing downstream needs to change.
    function _computeHeatDerived(eff, ship, outfitIdx) {
        const rows  = window.ItemStats.getHeatDerivedRows(_normalizedShipItem(ship), eff, outfitIdx);
        const byKey = Object.fromEntries(rows.map(r => [r.key, r.raw]));
        return {
            totalHeatCapacity:      byKey['_hd_totalHeatCap'] ?? null,
            maxSustainableHeatProd: byKey['_hd_maxSustHeat']  ?? null,
        };
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
    //  RENDER DISPATCH
    // ─────────────────────────────────────────────────────────────────────────

    function _renderContent(ship) {
        const el = document.getElementById('sbs-content');
        if (!el) return;

        const outfitIdx   = _buildOutfitIndex();
        const eff          = _buildEffectiveAttrs(ship, outfitIdx);
        const wData         = _computeWeaponStats(ship, outfitIdx);
        const ad           = window.attrDefs || null;
        const heatDerived  = _computeHeatDerived(eff, ship, outfitIdx);

        let html = '';
        if (_activeTab === 'other') {
            html = _tabOther(eff, ad, ship);
        } else if (_activeTab === 'everything') {
            html = _tabEverything(eff, ad, ship, wData, heatDerived);
        } else if (_activeTab === 'weapons') {
            html = _tabWeapons(wData, eff, ad, outfitIdx);
        } else {
            const tabDef = TAB_DEFS.find(t => t.id === _activeTab);
            if (tabDef) html = _tabKeyword(eff, ad, tabDef, heatDerived);
        }

        el.innerHTML = html || `<div class="sbs-empty">No data available.</div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GENERIC CANONICAL-SECTION TAB RENDERER
    //
    //  For each visual sub-card in the tabDef, collect every attr key from
    //  eff whose AttributeSections.classify() result is one of the card's
    //  `canonical` sections, then (optionally) narrow that set with a purely
    //  cosmetic `subFilter` regex — e.g. splitting "Shields & Hull" into a
    //  Shields card and a Hull card. Membership itself is never re-decided
    //  here; it's always AttributeSections.classify()'s call.
    // ─────────────────────────────────────────────────────────────────────────

    function _tabKeyword(eff, ad, tabDef, heatDerived) {
        let html = '';

        for (const sec of tabDef.sections) {
            let matchedKeys = window.AttributeSections.keysInSections(ad, eff, sec.canonical);
            if (sec.subFilter) matchedKeys = matchedKeys.filter(k => sec.subFilter.test(k));
            matchedKeys.sort((a, b) => a.localeCompare(b));

            let cards = '';
            for (const key of matchedKeys) {
                const raw = eff[key];
                if (typeof raw !== 'number' || raw === 0) continue;
                const rec  = window.ItemStats.getAttrRecord(ad, key);
                const mult = rec?.displayMultiplier ?? 1;
                const unit = rec?.displayUnit        ?? '';
                cards += _card(window.ItemStats.labelForKey(key), raw * mult, unit);
            }

            // Inject derived heat values into any heat/cooling/temperature card
            const isHeatSection = sec.canonical.includes('Energy') &&
                sec.subFilter && /heat|cool/i.test(sec.subFilter.source);
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
    //  1. Ship-level capacity cards — same canonical section + subFilter as
    //     the "weapons" tab definition above (capSec below), so they stay in
    //     sync automatically if that definition ever changes.
    //
    //  2. Fleet DPS summary from ItemStats.getShipWeaponData (wraps WeaponStats).
    //
    //  3. Per-weapon detail accordion — for each installed weapon outfit we
    //     walk the raw outfit.weapon object and display EVERY field found on
    //     it via ItemStats.getRawAttributeRows, regardless of what those
    //     fields are. No hardcoded key list.
    //
    //  Computed values from the WeaponStats profile (shots/s, range, DPS
    //  breakdown) are appended after the raw fields under a "── Per Second
    //  ──" divider so nothing is lost.
    // ─────────────────────────────────────────────────────────────────────────

    function _weaponDetailSection(outfitName, count, outfit, profile, ad) {
        const w   = outfit.weapon || {};
        const sps = profile.shotsPerSecond || 0;

        // ── A) Rate / behaviour fields from raw weapon object ──────────────
        // Per-shot firing costs (start with "firing ") and damage values
        // (end with " damage") are handled in section B instead.
        const skip = new Set();
        for (const key of Object.keys(w)) {
            const lk = key.toLowerCase();
            if (lk.startsWith('firing ') || lk.endsWith(' damage')) skip.add(key);
        }
        const rateRows = window.ItemStats.getRawAttributeRows(ad, w, { skip })
            .map(r => ({ label: r.label, display: r.value, unit: r.unit }))
            .sort((a, b) => a.label.localeCompare(b.label));

        // ── B) Per-second computed values ──────────────────────────────────
        const perSecRows = [];
        perSecRows.push({ label: 'Shots/s', display: window.ItemStats.fmtNum(sps), unit: '' });
        if (profile.effectiveRange)
            perSecRows.push({ label: 'Effective Range', display: window.ItemStats.fmtNum(profile.effectiveRange), unit: 'px' });
        for (const [dmgKey, dps] of Object.entries(profile.dpsBreakdown || {}).sort((a, b) => a[0].localeCompare(b[0])))
            if (dps) perSecRows.push({ label: window.ItemStats.labelForKey(dmgKey.replace(/ damage$/, '')) + ' DPS', display: window.ItemStats.fmtNum(dps), unit: '/s' });
        for (const [costKey, costVal] of Object.entries(profile.firingCosts || {}).sort((a, b) => a[0].localeCompare(b[0])))
            if (costVal) perSecRows.push({ label: window.ItemStats.labelForKey(costKey.replace(/^firing /, '')) + ' Cost', display: window.ItemStats.fmtNum(costVal * sps), unit: '/s' });

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

    function _tabWeapons(wData, eff, ad, outfitIdx) {
        // ── Capacity section — same canonical sections + subFilter used by
        // the "weapons" tab definition above, so this stays in sync
        // automatically if that definition changes.
        const capSec = TAB_DEFS.find(t => t.id === 'weapons').sections[0];
        let capKeys = window.AttributeSections.keysInSections(ad, eff, capSec.canonical);
        if (capSec.subFilter) capKeys = capKeys.filter(k => capSec.subFilter.test(k));
        capKeys.sort();
        let capCards = '';
        for (const key of capKeys) {
            const raw = eff[key];
            if (typeof raw !== 'number' || raw === 0) continue;
            const rec = window.ItemStats.getAttrRecord(ad, key);
            capCards += _card(window.ItemStats.labelForKey(key), raw * (rec?.displayMultiplier ?? 1), rec?.displayUnit ?? '');
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
            if (val) typeCards += _card(window.ItemStats.labelForKey(key.replace(/ damage$/, '')) + ' DPS', val, 'dps');

        let ammoCards = '';
        if (wData.hasAmmoWeapons)
            for (const a of (wData.ammoRequired || []))
                ammoCards += _card(_esc(a.ammoOutfitName), window.ItemStats.fmtNum(a.totalShotsPerSecond), 'rounds/s');

        // ── Per-weapon detail sections ─────────────────────────────────────
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
    //  Shows every key in eff whose canonical section (per AttributeSections)
    //  isn't referenced by any named tab. Applies displayMultiplier +
    //  displayUnit from attrDefs. Also shows string attributes from the base
    //  ship that don't match any covered section.
    // ─────────────────────────────────────────────────────────────────────────

    function _tabOther(eff, ad, ship) {
        const uncoveredKeys = Object.keys(eff)
            .filter(key => !_isCovered(ad, key) && !key.startsWith('_'))
            .sort();

        let cards = '';
        for (const key of uncoveredKeys) {
            const raw = eff[key];
            if (typeof raw !== 'number' || raw === 0) continue;
            const rec = window.ItemStats.getAttrRecord(ad, key);
            cards += _card(window.ItemStats.labelForKey(key), raw * (rec?.displayMultiplier ?? 1), rec?.displayUnit ?? '');
        }

        // String attrs from base ship not covered
        const strEntries = Object.entries(ship.attributes || {})
            .filter(([key, val]) => typeof val === 'string' && val && !_isCovered(ad, key))
            .sort((a, b) => a[0].localeCompare(b[0]));

        for (const [key, val] of strEntries)
            cards += `<div class="sbs-card"><div class="sbs-label">${_esc(window.ItemStats.labelForKey(key))}</div><div class="sbs-value" style="font-size:.78rem">${_esc(val)}</div></div>`;

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
        // All numeric keys sorted
        const allKeys = Object.keys(eff)
            .filter(key => !key.startsWith('_') && typeof eff[key] === 'number' && eff[key] !== 0)
            .sort();

        let cards = '';
        for (const key of allKeys) {
            const raw = eff[key];
            const rec = window.ItemStats.getAttrRecord(ad, key);
            cards += _card(window.ItemStats.labelForKey(key), raw * (rec?.displayMultiplier ?? 1), rec?.displayUnit ?? '');
        }

        // String attributes
        const strEntries = Object.entries(ship.attributes || {})
            .filter(([key, val]) => typeof val === 'string' && val && !key.startsWith('_'))
            .sort((a, b) => a[0].localeCompare(b[0]));

        for (const [key, val] of strEntries)
            cards += `<div class="sbs-card"><div class="sbs-label">${_esc(window.ItemStats.labelForKey(key))}</div><div class="sbs-value" style="font-size:.78rem">${_esc(val)}</div></div>`;

        // Weapon DPS block
        let wCards = '';
        if (wData && wData.weaponCount) {
            wCards += _card('Total DPS',    wData.totalDps,          'dps');
            wCards += _card('Shield DPS',   wData.shieldDps,         'dps');
            wCards += _card('Hull DPS',     wData.hullDps,           'dps');
            wCards += _card('Weapon Types', wData.weaponCount,       '');
            wCards += _card('Total Mounts', wData.totalWeaponMounts, '');
            for (const [key, val] of Object.entries(wData.dpsByType || {}))
                if (val) wCards += _card(window.ItemStats.labelForKey(key.replace(/ damage$/, '')) + ' DPS', val, 'dps');
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
    //  HTML HELPERS  (pure presentation — no calculation)
    // ─────────────────────────────────────────────────────────────────────────

    function _card(label, value, unit, highlight) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && (isNaN(value) || value === 0)) return '';
        const cls     = highlight ? ' sbs-card--hi' : '';
        const unitTag = unit ? `<span class="sbs-unit">${_esc(unit)}</span>` : '';
        const fmtVal  = typeof value === 'string' ? value : window.ItemStats.fmtNum(value);
        return `<div class="sbs-card${cls}"><div class="sbs-label">${_esc(label)}</div><div class="sbs-value">${fmtVal}${unitTag}</div></div>`;
    }

    function _section(title, content) {
        if (!content || !content.trim()) return '';
        return `<div class="sbs-section"><div class="sbs-section-title">${_esc(title)}</div><div class="sbs-cards">${content}</div></div>`;
    }

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
