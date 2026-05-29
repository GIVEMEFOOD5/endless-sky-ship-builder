'use strict';

// ─── CompareDisplay.js ────────────────────────────────────────────────────────
//
// Renders the compare bar and panel.
// Fully integrated with ComputedStats, AttributeDisplay, and WeaponStats.
//
// Attribute data is gathered in three layers per item:
//   1. Raw attrs (from item.attributes for ships, or flat item for outfits)
//   2. Computed stats from ComputedStats.getComputedStats / getComputedStatsForAttrs
//   3. Weapon DPS summary from WeaponStats (ships only, via computed _ws_* keys)
//
// Both views group rows by the same sections AttributeDisplay uses.
// ─────────────────────────────────────────────────────────────────────────────

window.CompareDisplay = (() => {

    let _panelOpen = false;
    let _viewMode  = 'columns';

    // Section ordering matches AttributeDisplay.js SECTION_ORDER
    const SECTION_ORDER = [
        'General', 'Shields & Hull', 'Energy', 'Engines', 'Jump',
        'Cargo', 'Crew', 'Scanning', 'Cloaking', 'Resistance', 'Protection',
        'Hardpoints', 'Weapon DPS', 'Derived Stats', 'Other',
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

    function _getDisplayUnit(key) {
        return _getAttrRecord(key)?.displayUnit ?? '';
    }

    function _getDisplayMultiplier(key) {
        return _getAttrRecord(key)?.displayMultiplier ?? 1;
    }

    function _labelOf(key) {
        // Computed key prettification
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

    // ── Build rich attribute map for one item ─────────────────────────────────
    // Returns: { sectionName: [ {key, label, value, unit}, ... ] }

    const SKIP_KEYS = new Set([
        'name','display name','description','sprite','thumbnail','spriteData',
        '_pluginId','_internalId','_compareTab','_hash','_variantPluginId',
        'locations','governments','hardpoint sprite','steering flare sprite',
        'flare sprite','reverse flare sprite','afterburner effect','projectile',
        'weapon','leaks','engines','guns','turrets','bays','reverseEngines',
        'steeringEngines','outfitMap','outfits',
    ]);

    const COMPUTED_SKIP = new Set([
        '_ws_hasAmmoWeapons','_totalOutfits',
    ]);

    function _buildAttrMap(item) {
        const sections = {};
        const seen     = new Set();

        function push(key, rawVal, sectionOverride) {
            if (SKIP_KEYS.has(key))     return;
            if (seen.has(key))          return;
            if (rawVal === null || rawVal === undefined) return;
            if (typeof rawVal === 'object') return;

            seen.add(key);
            const section = sectionOverride || _getSection(key);
            const mult    = _getDisplayMultiplier(key);
            const unit    = _getDisplayUnit(key);
            const display = typeof rawVal === 'number'
                ? _fmt(rawVal * mult)
                : String(rawVal);

            if (!sections[section]) sections[section] = [];
            sections[section].push({ key, label: _labelOf(key), value: display, unit });
        }

        const isShip = !!(item.attributes && typeof item.attributes === 'object');

        // ── 1. Raw attributes ─────────────────────────────────────────────────
        if (isShip) {
            const attrs = item.attributes || {};
            for (const [k, v] of Object.entries(attrs)) {
                if (typeof v === 'object') continue;
                push(k, v);
            }

            // Hardpoints summary
            const hp = [];
            if (item.guns?.length)           hp.push({ key: 'Guns',             label: 'Guns',             value: String(item.guns.length),           unit: '' });
            if (item.turrets?.length)        hp.push({ key: 'Turrets',          label: 'Turrets',          value: String(item.turrets.length),         unit: '' });
            if (item.engines?.length)        hp.push({ key: 'Engines',          label: 'Engines',          value: String(item.engines.length),         unit: '' });
            if (item.reverseEngines?.length) hp.push({ key: 'Reverse Engines',  label: 'Reverse Engines',  value: String(item.reverseEngines.length),  unit: '' });
            if (item.bays?.length) {
                const byType = {};
                item.bays.forEach(b => { byType[b.type || 'Bay'] = (byType[b.type || 'Bay'] || 0) + 1; });
                Object.entries(byType).forEach(([t, n]) => hp.push({ key: `${t} Bays`, label: `${t} Bays`, value: String(n), unit: '' }));
            }
            if (hp.length) {
                sections['Hardpoints'] = hp;
                hp.forEach(h => seen.add(h.key));
            }

        } else {
            // Outfit — flat structure
            for (const [k, v] of Object.entries(item)) {
                if (SKIP_KEYS.has(k)) continue;
                if (typeof v === 'object') continue;
                push(k, v);
            }
            // Weapon stats from weapon sub-object
            if (item.weapon && typeof item.weapon === 'object') {
                const weapSkip = new Set(['sprite','spriteData','sound','hit effect','fire effect',
                    'die effect','submunition','submunitions','stream','cluster','hardpoint sprite',
                    'hardpoint offset','icon','ammunition','ammo']);
                for (const [wk, wv] of Object.entries(item.weapon)) {
                    if (weapSkip.has(wk) || typeof wv === 'object' || Array.isArray(wv)) continue;
                    push(wk, wv, 'Weapon DPS');
                }

                // DPS from WeaponStats if available
                if (window.WeaponStats) {
                    // Build outfit index on the fly
                    const allData = window.allData || {};
                    const idx = {};
                    for (const pd of Object.values(allData))
                        (pd.outfits || []).forEach(o => { if (o.name && !idx[o.name]) idx[o.name] = o; });
                    const profile = window.WeaponStats.getOutfitWeaponStats(item, idx);
                    if (profile) {
                        const dpsSection = sections['Weapon DPS'] || (sections['Weapon DPS'] = []);
                        const dpsKey = k => !seen.has(k);
                        if (dpsKey('_ws_totalDps') && profile.totalDps) {
                            dpsSection.push({ key: '_ws_totalDps', label: 'Total DPS', value: _fmt(profile.totalDps), unit: 'dmg/s' });
                            seen.add('_ws_totalDps');
                        }
                        if (dpsKey('_ws_shieldDps') && profile.shieldDps) {
                            dpsSection.push({ key: '_ws_shieldDps', label: 'Shield DPS', value: _fmt(profile.shieldDps), unit: 'dmg/s' });
                            seen.add('_ws_shieldDps');
                        }
                        if (dpsKey('_ws_hullDps') && profile.hullDps) {
                            dpsSection.push({ key: '_ws_hullDps', label: 'Hull DPS', value: _fmt(profile.hullDps), unit: 'dmg/s' });
                            seen.add('_ws_hullDps');
                        }
                        if (dpsKey('_ws_range') && profile.effectiveRange) {
                            dpsSection.push({ key: '_ws_range', label: 'Range', value: _fmt(profile.effectiveRange), unit: 'px' });
                            seen.add('_ws_range');
                        }
                        if (dpsKey('_ws_shotsPerSecond') && profile.shotsPerSecond) {
                            dpsSection.push({ key: '_ws_shotsPerSecond', label: 'Fire Rate', value: _fmt(profile.shotsPerSecond), unit: 'shots/s' });
                            seen.add('_ws_shotsPerSecond');
                        }
                    }
                }
            }
        }

        // ── 2. Computed stats ─────────────────────────────────────────────────
        let computed = null;
        try {
            if (isShip && window.ComputedStats?.isReady()) {
                computed = window.ComputedStats.getComputedStats(item, item._pluginId);
            } else if (!isShip && window.ComputedStats?.isReady()) {
                const attrs = Object.fromEntries(
                    Object.entries(item).filter(([, v]) => typeof v === 'number')
                );
                computed = window.ComputedStats.getComputedStatsForAttrs(attrs);
            }
        } catch (_) {}

        if (computed) {
            for (const [k, v] of Object.entries(computed)) {
                if (COMPUTED_SKIP.has(k)) continue;
                if (seen.has(k)) continue;
                if (v === null || v === undefined || (typeof v === 'number' && (isNaN(v) || v === 0))) continue;
                if (typeof v === 'object') continue;

                const isComputedKey = k.startsWith('_fn_')      || k.startsWith('_derived_') ||
                                      k.startsWith('_sys_')      || k.startsWith('_ws_')      ||
                                      k.startsWith('_total')     || k === '_outfitMass';
                if (!isComputedKey) continue;

                seen.add(k);

                // Section routing for computed keys
                let section = 'Derived Stats';
                if (k.startsWith('_ws_'))        section = 'Weapon DPS';
                else if (k === '_outfitMass' ||
                         k === '_totalOutfitCost') section = 'General';

                // Apply display scale for _fn_ keys
                let display = v;
                if (k.startsWith('_fn_')) {
                    const fnName = k.slice(4);
                    const fnData = _attrDefs()?.shipFunctions?.[fnName];
                    if (fnData?.displayScale) display = v * fnData.displayScale;
                }

                const unit = k.startsWith('_ws_') && k.includes('Dps') ? 'dmg/s' : '';
                if (!sections[section]) sections[section] = [];
                sections[section].push({ key: k, label: _labelOf(k), value: _fmt(display), unit });
            }
        }

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
                        <button class="compare-toggle__btn" data-mode="table"   onclick="window.CompareDisplay.setViewMode('table')">Table</button>
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
        // Build attr maps for all items upfront
        const attrMaps = items.map(_buildAttrMap);

        const grid = document.createElement('div');
        grid.className = 'compare-columns';
        grid.style.gridTemplateColumns = `repeat(${items.length}, minmax(240px, 1fr))`;

        items.forEach((item, idx) => {
            const col = document.createElement('div');
            col.className = 'compare-col';

            // ── Header ────────────────────────────────────────────────────────
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

            // ── Sections + rows ───────────────────────────────────────────────
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

        // Build ordered list of [section, key, label] across all items
        const sectionKeyOrder = [];
        const seenSectionKeys = new Set();

        const allSections = [
            ...SECTION_ORDER,
            ...new Set(attrMaps.flatMap(m => Object.keys(m))).values(),
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

        // Build per-item lookup: section+key → value string
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

        // ── Header ────────────────────────────────────────────────────────────
        const thead   = document.createElement('thead');
        const headRow = document.createElement('tr');
        const cornerTh = document.createElement('th');
        cornerTh.className   = 'compare-table__corner';
        cornerTh.textContent = 'Attribute';
        headRow.appendChild(cornerTh);

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

        // ── Body ──────────────────────────────────────────────────────────────
        const tbody = document.createElement('tbody');
        let rowIdx  = 0;

        for (const entry of sectionKeyOrder) {
            if (entry.isSectionHeader) {
                const tr = document.createElement('tr');
                tr.className = 'compare-table__section-row';
                const td = document.createElement('td');
                td.colSpan   = items.length + 1;
                td.className = 'compare-table__section-header';
                td.textContent = entry.section;
                tr.appendChild(td);
                tbody.appendChild(tr);
                continue;
            }

            const sk  = entry.section + '::' + entry.key;
            const tr  = document.createElement('tr');
            tr.className = rowIdx % 2 === 0 ? 'compare-table__row--even' : 'compare-table__row--odd';
            rowIdx++;

            const keyTd = document.createElement('td');
            keyTd.className   = 'compare-table__key';
            keyTd.textContent = entry.label;
            tr.appendChild(keyTd);

            items.forEach((_, i) => {
                const td  = document.createElement('td');
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
