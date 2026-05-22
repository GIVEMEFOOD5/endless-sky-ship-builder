// Sorter.js
//
// Builds sortable field lists by scanning ONLY the items currently on screen.
// No attribute names are hardcoded anywhere. Every field offered in the picker
// was found on at least one currently-visible item.
//
// ── Data layout (from the actual JSON files) ────────────────────────────────
//
//   ships / variants
//     Numeric stats live under  item.attributes.*
//     Outfit list lives at      item.outfits  (key→ {count, pluginId})
//     Plugin identity lives at  item._pluginId  (always set in source JSON)
//     Stable cache key at       item._internalId
//
//   outfits
//     Numeric stats live at     item.*  (top-level — NO .attributes sub-object)
//     Weapon sub-stats live at  item.weapon.*  (present on ~40% of outfits)
//
//   effects / other
//     Numeric stats live at     item.*  (top-level)
//
// ── Computed fields (ships / variants only) ──────────────────────────────────
//
//   ComputedStats.getComputedStats(ship, pluginId) accumulates installed
//   outfits and runs the ship-function formulas from attributeDefinitions.json.
//   Results are keyed  _fn_*, _derived_*, _sys_*  and exposed via
//   getComputedSorterFields() which returns  { id, key, label, isComputed:true }.
//
//   getFieldValue() resolves these by calling getComputedStats with the item's
//   own _pluginId so multi-plugin setups work correctly.
//
// ── Accumulated attribute fields (ships / variants only) ─────────────────────
//
//   accumulateOutfits() in ComputedStats.js produces a flat numeric map of all
//   base attributes + outfit contributions stacked together. Any key that is
//   numeric in that result (and not a _fn_/_derived_/_sys_ computed key) is
//   offered as an "Accumulated (with outfits)" field.  These are discovered by
//   calling getComputedStats() on each visible ship and scanning the result —
//   so the list is always driven entirely by what is on screen.
//
// ── Field cache ──────────────────────────────────────────────────────────────
//
//   The field list for each tab is cached keyed by tab name.
//   setSorterItems() deletes the current tab's cache entry so the next
//   getFieldsForTab() call re-scans from the fresh item set.

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeSorters       = [];
let sorterCurrentTab    = 'ships';
let sorterPickerPending = [];
let _sorterItems        = [];   // post-filter items currently on screen
let _sorterAttrDefs     = null;
let _sorterPluginId     = null; // fallback when item has no own _pluginId
let _cachedOutfitIndex  = null;

// ---------------------------------------------------------------------------
// Skip sets — structural / metadata keys that are never sortable.
// ---------------------------------------------------------------------------

const SKIP_TOP_LEVEL = new Set([
    'name', 'description', 'category', 'thumbnail', 'sprite',
    'display name', 'plural', 'series',
    'flare sprite', 'flare sprite data', 'flare sound',
    'reverse flare sprite', 'reverse flare sprite data', 'reverse flare sound',
    'steering flare sprite', 'steering flare sprite data', 'steering flare sound',
    'flotsam sprite', 'afterburner effect', 'jump effect',
    'governments', 'locations', 'licenses', 'linked',
    'pluginId', '_pluginId', '_internalId', '_hash',
    'weapon', 'ammo',
]);

const SKIP_WEAPON = new Set([
    'sprite', 'sprite data', 'hardpoint sprite', 'icon',
    'hit effect', 'fire effect', 'die effect', 'live effect', 'target effect',
    'sound', 'stream', 'cluster', 'submunition', 'ammo',
]);

// Prefixes that mark keys produced by ComputedStats derived/fn/sys resolution.
const COMPUTED_PREFIXES = ['_fn_', '_derived_', '_sys_'];

function isComputedKey(key) {
    return COMPUTED_PREFIXES.some(p => key.startsWith(p));
}

// ---------------------------------------------------------------------------
// Outfit index cache
// ---------------------------------------------------------------------------

function _getOutfitIndex() {
    if (_cachedOutfitIndex) return _cachedOutfitIndex;
    if (window._outfitIndex && Object.keys(window._outfitIndex).length > 0) {
        _cachedOutfitIndex = window._outfitIndex;
        return _cachedOutfitIndex;
    }
    const merged = {};
    for (const pd of Object.values(window.allData || {}))
        for (const o of (pd.outfits || []))
            if (o.name) merged[o.name] = o;
    _cachedOutfitIndex = merged;
    return _cachedOutfitIndex;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyToId(key) {
    return key.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function toTitleCase(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Dynamic field scanner
// ---------------------------------------------------------------------------

function scanFieldsFromItems(tab, items) {
    const isShipLike = tab === 'ships' || tab === 'variants';
    const isOutfits  = tab === 'outfits';

    const shipBaseSeen   = new Set();
    const shipAccumSeen  = new Set();
    const outfitSeen     = new Set();
    const weaponSeen     = new Set();
    const effectSeen     = new Set();

    const shipBaseFields  = [];
    const shipAccumFields = [];
    const outfitFields    = [];
    const weaponFields    = [];
    const effectFields    = [];

    for (const item of (items || [])) {

        if (isShipLike) {
            // ── Raw base attributes (item.attributes.*) ───────────────────────
            const attrs = item.attributes;
            if (attrs && typeof attrs === 'object') {
                for (const [key, val] of Object.entries(attrs)) {
                    if (typeof val !== 'number') continue;
                    const id = 'raw_attr_' + keyToId(key);
                    if (shipBaseSeen.has(id)) continue;
                    shipBaseSeen.add(id);
                    shipBaseFields.push({
                        id,
                        key,
                        label: toTitleCase(key) + ' (base)',
                        path:  ['attributes', key],
                        raw:   true,
                        group: 'shipBase',
                    });
                }
            }

            // ── Accumulated attributes (via getComputedStats) ─────────────────
            if (typeof getComputedStats === 'function') {
                const pluginId = item._pluginId || _sorterPluginId;
                if (pluginId) {
                    const computed = getComputedStats(item, pluginId);
                    if (computed && typeof computed === 'object') {
                        for (const [key, val] of Object.entries(computed)) {
                            if (typeof val !== 'number')   continue;
                            if (key.startsWith('_'))        continue;
                            if (isComputedKey(key))         continue;
                            const id = 'accum_attr_' + keyToId(key);
                            if (shipAccumSeen.has(id))      continue;
                            shipAccumSeen.add(id);
                            shipAccumFields.push({
                                id,
                                key,
                                label: toTitleCase(key) + ' (with outfits)',
                                path:        null,
                                useAccum:    true,
                                raw:         false,
                                group:       'shipAccum',
                            });
                        }

                        // ── Explicit per-second weapon DPS fields from WeaponStats ──
                        const WS_FIELDS = [
                            { wsKey: '_ws_totalDps',         label: 'Total DPS (with outfits)'    },
                            { wsKey: '_ws_shieldDps',         label: 'Shield DPS (with outfits)'   },
                            { wsKey: '_ws_hullDps',           label: 'Hull DPS (with outfits)'     },
                            { wsKey: '_ws_weaponCount',       label: 'Weapon Types (with outfits)' },
                            { wsKey: '_ws_totalWeaponMounts', label: 'Total Weapon Mounts'         },
                        ];
                        // Also add any _ws_dps_* breakdown keys dynamically
                        for (const key of Object.keys(computed)) {
                            if (!key.startsWith('_ws_dps_')) continue;
                            const dmgType = key.slice('_ws_dps_'.length).replace(/_/g, ' ');
                            WS_FIELDS.push({
                                wsKey: key,
                                label: toTitleCase(dmgType) + ' DPS (with outfits)',
                            });
                        }

                        for (const { wsKey, label } of WS_FIELDS) {
                            if (computed[wsKey] == null) continue;
                            const id = 'ship_ws_' + keyToId(wsKey);
                            if (shipAccumSeen.has(id)) continue;
                            shipAccumSeen.add(id);
                            shipAccumFields.push({
                                id,
                                key:      wsKey,
                                label,
                                path:     null,
                                useAccum: true,
                                raw:      false,
                                group:    'shipAccum',
                            });
                        }
                    }
                }
            }

        } else if (isOutfits) {
            // ── Top-level numeric outfit fields ──────────────────────────────
            for (const [key, val] of Object.entries(item)) {
                if (SKIP_TOP_LEVEL.has(key)) continue;
                if (typeof val !== 'number')  continue;
                if (key.startsWith('_'))       continue;
                const id = 'raw_' + keyToId(key);
                if (outfitSeen.has(id)) continue;
                outfitSeen.add(id);
                outfitFields.push({
                    id,
                    key,
                    label: toTitleCase(key),
                    path:  [key],
                    raw:   true,
                    group: 'outfit',
                });
            }

            // ── Numeric fields inside item.weapon ────────────────────────────
            if (item.weapon && typeof item.weapon === 'object') {
                for (const [key, val] of Object.entries(item.weapon)) {
                    if (SKIP_WEAPON.has(key))    continue;
                    if (typeof val !== 'number') continue;
                    if (/^[A-Z]/.test(key))      continue;

                    // ── Per-shot field ───────────────────────────────────────
                    const id = 'weapon_' + keyToId(key);
                    if (!weaponSeen.has(id)) {
                        weaponSeen.add(id);
                        weaponFields.push({
                            id,
                            key,
                            label: toTitleCase(key),
                            path:  ['weapon', key],
                            raw:   true,
                            group: 'weapon',
                        });
                    }

                    // ── DPS field for damage keys ────────────────────────────
                    // Only added when the weapon has an explicit reload (not a submunition)
                    if (key.endsWith(' damage')) {
                        const dpsId = 'weapon_dps_' + keyToId(key);
                        if (!weaponSeen.has(dpsId)) {
                            weaponSeen.add(dpsId);
                            weaponFields.push({
                                id:    dpsId,
                                key:   key.replace(/ damage$/, ''),
                                label: toTitleCase(key.replace(/ damage$/, '')) + ' DPS',
                                path:  null,
                                raw:   false,
                                group: 'weapon',
                                isDps: true,
                            });
                        }
                    }
                }

                // ── Computed weapon summary fields ───────────────────────────
                if (!weaponSeen.has('weapon_computed_totalDps')) {
                    weaponSeen.add('weapon_computed_totalDps');
                    weaponFields.push({ id: 'weapon_computed_totalDps',  key: 'totalDps',       label: 'Total DPS',        path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_shieldDps', key: 'shieldDps',      label: 'Shield DPS',       path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_hullDps',   key: 'hullDps',        label: 'Hull DPS',         path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_range',     key: 'effectiveRange', label: 'Effective Range',  path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_sps',       key: 'shotsPerSecond', label: 'Shots Per Second', path: null, group: 'weapon', isOutfitComputed: true });
                }
            }

        } else {
            // ── Top-level numeric fields for effects / other tabs ────────────
            for (const [key, val] of Object.entries(item)) {
                if (typeof val !== 'number') continue;
                if (key.startsWith('_'))      continue;
                const id = 'raw_' + keyToId(key);
                if (effectSeen.has(id)) continue;
                effectSeen.add(id);
                effectFields.push({
                    id,
                    key,
                    label: toTitleCase(key),
                    path:  [key],
                    raw:   true,
                    group: 'effect',
                });
            }
        }
    }

    const alpha = (a, b) => a.label.localeCompare(b.label);
    return {
        shipBaseFields:  shipBaseFields.sort(alpha),
        shipAccumFields: shipAccumFields.sort(alpha),
        outfitFields:    outfitFields.sort(alpha),
        weaponFields:    weaponFields.sort(alpha),
        effectFields:    effectFields.sort(alpha),
    };
}

// ---------------------------------------------------------------------------
// Computed fields (ships / variants only)
// ---------------------------------------------------------------------------

function buildComputedFields() {
    if (typeof getComputedSorterFields !== 'function') return [];
    return getComputedSorterFields().map(f => ({ ...f, useComputed: true }));
}

// ---------------------------------------------------------------------------
// Hardpoint count pseudo-fields (ships / variants only)
// ---------------------------------------------------------------------------

const HARDPOINT_FIELDS = [
    { id: '_gunCount',            label: 'Gun Ports',            fn: i => (i.guns            || []).length },
    { id: '_turretCount',         label: 'Turret Ports',         fn: i => (i.turrets         || []).length },
    { id: '_bayCount',            label: 'Bay Count',            fn: i => (i.bays            || []).length },
    { id: '_engineCount',         label: 'Engine Points',        fn: i => (i.engines         || []).length },
    { id: '_reverseEngineCount',  label: 'Reverse Eng. Points',  fn: i => (i.reverseEngines  || []).length },
    { id: '_steeringEngineCount', label: 'Steering Eng. Points', fn: i => (i.steeringEngines || []).length },
];

// ---------------------------------------------------------------------------
// Master field list for a tab
// ---------------------------------------------------------------------------

function buildFieldsForTab(tab, items) {
    const isShipLike = tab === 'ships' || tab === 'variants';
    const isOutfits  = tab === 'outfits';

    const { shipBaseFields, shipAccumFields, outfitFields, weaponFields, effectFields } =
        scanFieldsFromItems(tab, items);

    const all    = [];
    const seenId = new Set();
    const add    = f => { if (!seenId.has(f.id)) { all.push(f); seenId.add(f.id); } };

    if (isShipLike) {
        for (const f of buildComputedFields())      add(f);
        for (const f of shipAccumFields)            add(f);
        for (const f of shipBaseFields)             add(f);
        for (const { id, label, fn } of HARDPOINT_FIELDS) {
            add({ id, key: id, label, computed: fn });
        }

    } else if (isOutfits) {
        for (const f of outfitFields) add(f);
        for (const f of weaponFields) add(f);

    } else {
        for (const f of effectFields) add(f);
    }

    return all;
}

// ---------------------------------------------------------------------------
// Field cache — per tab, rebuilt when items change
// ---------------------------------------------------------------------------

const _fieldCache = {};

function getFieldsForTab(tab) {
    if (!_fieldCache[tab]) {
        _fieldCache[tab] = buildFieldsForTab(tab, _sorterItems);
    }
    return _fieldCache[tab];
}

function clearFieldCache() {
    for (const k of Object.keys(_fieldCache)) delete _fieldCache[k];
}

// ---------------------------------------------------------------------------
// Public setters
// ---------------------------------------------------------------------------

function setSorterAttrDefs(defs) {
    _sorterAttrDefs = defs;
    clearFieldCache();
}

function setSorterPluginId(pluginId) {
    _sorterPluginId    = pluginId;
    _cachedOutfitIndex = null;
    clearFieldCache();
    if (typeof clearComputedCache === 'function') clearComputedCache();
}

function setSorterItems(items) {
    _sorterItems = items || [];
    delete _fieldCache[sorterCurrentTab];
    renderSorterBox();
    if (typeof stampSorterValues === 'function') stampSorterValues();
}

// ---------------------------------------------------------------------------
// Value extraction
//
// Resolution order:
//   0a. isOutfitComputed  — WeaponStats profile fields (range, sps, totalDps…)
//   0b. isDps             — per-damage-type DPS via 60/reload * submunition tree
//   1.  field.computed    — hardpoint count lambda
//   2.  isComputed/useComputed — _fn_/_derived_/_sys_ via getComputedStats
//   3.  useAccum          — accumulated attr (base + outfits) via getComputedStats
//   4.  field.path        — raw path walk on the item
// ---------------------------------------------------------------------------

function getFieldValue(item, field) {

    // 0a. Outfit computed weapon profile (range, sps, totalDps, shieldDps, hullDps)
    if (field.isOutfitComputed) {
        if (!item.weapon || !window.WeaponStats) return undefined;
        const profile = window.WeaponStats.getOutfitWeaponStats(item, _getOutfitIndex());
        if (!profile) return undefined;
        return profile[field.key] ?? undefined;
    }

    // 0b. Weapon DPS — mirrors AttributeDisplay: 60/reload * full submunition tree damage
    if (field.isDps) {
        if (!item.weapon) return undefined;
        if (item.weapon.reload == null) return undefined; // submunitions have no reload

        const weapon  = item.weapon;
        const reload  = parseFloat(weapon.reload) || 1;
        const sps     = 60 / reload;
        const outfitIndex = _getOutfitIndex();
        const visited = new Set([item.name].filter(Boolean));

        function collectDamage(w, multiplier, depth) {
            if (depth > 8) return 0;
            const dmgKey = field.key + ' damage';
            let total    = (parseFloat(w[dmgKey]) || 0) * multiplier;

            if (!window.WeaponStats) return total;
            const refs = window.WeaponStats._getSubmunitionRefs(w, outfitIndex);
            for (const { subName, subCount } of refs) {
                if (visited.has(subName)) continue;
                const subOutfit = outfitIndex[subName];
                if (!subOutfit?.weapon) continue;
                visited.add(subName);
                total += collectDamage(subOutfit.weapon, multiplier * subCount, depth + 1);
            }
            return total;
        }

        const totalDmgPerShot = collectDamage(weapon, 1, 0);
        if (!totalDmgPerShot) return undefined;
        return totalDmgPerShot * sps;
    }

    // 1. Inline computed (hardpoint counts)
    if (field.computed) return field.computed(item);

    // 2. ComputedStats — _fn_/_derived_/_sys_ physics stats
    if ((field.isComputed || field.useComputed) && typeof getComputedStats === 'function') {
        const pluginId = item._pluginId || _sorterPluginId;
        if (pluginId) {
            const stats = getComputedStats(item, pluginId);
            const val   = stats?.[field.key];
            if (val != null) return val;
        }
    }

    // 3. Accumulated attribute (base + outfit contributions stacked)
    if (field.useAccum && typeof getComputedStats === 'function') {
        const pluginId = item._pluginId || _sorterPluginId;
        if (pluginId) {
            const stats = getComputedStats(item, pluginId);
            const val   = stats?.[field.key];
            if (val != null) return val;
        }
    }

    // 4. Walk path on the raw item
    if (field.path && field.path.length > 0) {
        let obj = item;
        for (const k of field.path) {
            if (obj == null) return undefined;
            obj = obj[k];
        }
        return obj;
    }

    return undefined;
}

function formatAvgValue(val) {
    if (val == null) return '—';
    if (typeof val === 'number') {
        if (val >= 10000) return val.toLocaleString(undefined, { maximumFractionDigits: 0 });
        if (Number.isInteger(val)) return val.toLocaleString();
        return val.toFixed(2);
    }
    return String(val);
}

// ---------------------------------------------------------------------------
// Core sort
// ---------------------------------------------------------------------------

function applySorters(items) {
    if (activeSorters.length === 0) return items;

    const fields = getFieldsForTab(sorterCurrentTab);

    return [...items].sort((a, b) => {
        for (const sorter of activeSorters) {
            const field = fields.find(f => f.id === sorter.id);
            if (!field) continue;

            const av = getFieldValue(a, field);
            const bv = getFieldValue(b, field);

            const aMissing = av == null || (typeof av === 'number' && isNaN(av));
            const bMissing = bv == null || (typeof bv === 'number' && isNaN(bv));

            if (aMissing && bMissing) continue;
            if (aMissing) return 1;
            if (bMissing) return -1;

            const diff = sorter.dir === 'asc' ? av - bv : bv - av;
            if (diff !== 0) return diff;
        }
        return 0;
    });
}

// ---------------------------------------------------------------------------
// Average calculation
// ---------------------------------------------------------------------------

function computeAverage(sorter) {
    const fields = getFieldsForTab(sorterCurrentTab);
    const field  = fields.find(f => f.id === sorter.id);
    if (!field || _sorterItems.length === 0) return '—';

    const vals = _sorterItems
        .map(item => getFieldValue(item, field))
        .filter(v => v != null && typeof v === 'number' && !isNaN(v));

    if (vals.length === 0) return '—';
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return formatAvgValue(avg);
}

// ---------------------------------------------------------------------------
// Render active sorter pills
// ---------------------------------------------------------------------------

async function renderSorterBox() {
    const box = document.getElementById('sorterActiveList');
    if (!box) return;

    if (activeSorters.length === 0) {
        box.innerHTML = '<span class="sorter-empty">No sorters active. Click "Add Sorter" to begin.</span>';
        return;
    }

    box.innerHTML = '';

    activeSorters.forEach((sorter, idx) => {
        const row = document.createElement('div');
        row.className = 'sorter-row';

        const label = document.createElement('span');
        label.className   = 'sorter-label';
        label.textContent = sorter.label;

        const avg = document.createElement('span');
        avg.className   = 'sorter-avg';
        avg.textContent = `avg: ${computeAverage(sorter)}`;

        const dirBtn = document.createElement('button');
        dirBtn.className   = 'sorter-dir-btn';
        dirBtn.textContent = sorter.dir === 'asc' ? '↑ Asc' : '↓ Desc';
        dirBtn.onclick = async () => {
            sorter.dir = sorter.dir === 'asc' ? 'desc' : 'asc';
            renderSorterBox();
            await _triggerFilterItems();
        };

        const upBtn = document.createElement('button');
        upBtn.className   = 'sorter-move-btn';
        upBtn.textContent = '▲';
        upBtn.disabled    = idx === 0;
        upBtn.onclick = async () => {
            [activeSorters[idx - 1], activeSorters[idx]] = [activeSorters[idx], activeSorters[idx - 1]];
            renderSorterBox();
            await _triggerFilterItems();
        };

        const downBtn = document.createElement('button');
        downBtn.className   = 'sorter-move-btn';
        downBtn.textContent = '▼';
        downBtn.disabled    = idx === activeSorters.length - 1;
        downBtn.onclick = async () => {
            [activeSorters[idx], activeSorters[idx + 1]] = [activeSorters[idx + 1], activeSorters[idx]];
            renderSorterBox();
            await _triggerFilterItems();
        };

        const removeBtn = document.createElement('button');
        removeBtn.className   = 'sorter-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.onclick = async () => {
            activeSorters.splice(idx, 1);
            renderSorterBox();
            await _triggerFilterItems();
        };

        row.appendChild(label);
        row.appendChild(avg);
        row.appendChild(dirBtn);
        row.appendChild(upBtn);
        row.appendChild(downBtn);
        row.appendChild(removeBtn);
        box.appendChild(row);
    });
}

async function _triggerFilterItems() {
    if (typeof filterItems === 'function') await filterItems();
}

// ---------------------------------------------------------------------------
// Picker popup
// ---------------------------------------------------------------------------

function openSorterPicker() {
    sorterPickerPending = activeSorters.map(s => s.id);

    const overlay = document.getElementById('sorterPickerOverlay');
    const search  = document.getElementById('sorterPickerSearch');
    if (!overlay) return;

    search.value = '';
    renderPickerList('');
    overlay.classList.add('sorter-overlay-visible');
    search.focus();
}

function closeSorterPicker() {
    const overlay = document.getElementById('sorterPickerOverlay');
    if (overlay) overlay.classList.remove('sorter-overlay-visible');
}

async function confirmSorterPicker() {
    const fields = getFieldsForTab(sorterCurrentTab);

    for (const id of sorterPickerPending) {
        if (!activeSorters.find(s => s.id === id)) {
            const field = fields.find(f => f.id === id);
            if (field) {
                activeSorters.push({
                    id:               field.id,
                    key:              field.key,
                    label:            field.label,
                    path:             field.path             || null,
                    computed:         field.computed         || null,
                    useComputed:      field.useComputed      || false,
                    isComputed:       field.isComputed       || false,
                    useAccum:         field.useAccum         || false,
                    isDps:            field.isDps            || false,
                    isOutfitComputed: field.isOutfitComputed || false,
                    dir:              'desc',
                });
            }
        }
    }

    activeSorters = activeSorters.filter(s => sorterPickerPending.includes(s.id));

    closeSorterPicker();
    renderSorterBox();
    await _triggerFilterItems();
}

// ---------------------------------------------------------------------------
// Stamp sorter values onto cards
// ---------------------------------------------------------------------------

function stampSorterValues() {
    const container = document.getElementById('cardsContainer');
    if (!container) return;

    container.querySelectorAll('.sorter-badges').forEach(el => { el.innerHTML = ''; });

    if (activeSorters.length === 0) return;

    const fields = getFieldsForTab(sorterCurrentTab);

    for (const card of container.querySelectorAll('.card')) {
        const itemId = card.dataset.itemId;
        if (!itemId) continue;

        const item = _sorterItems.find(
            i => (i._internalId || i.name || '') == itemId
        );
        if (!item) continue;

        const badgeArea = card.querySelector('.sorter-badges');
        if (!badgeArea) continue;

        for (const sorter of activeSorters) {
            const field = fields.find(f => f.id === sorter.id);
            if (!field) continue;

            const val = getFieldValue(item, field);
            if (val == null) continue;

            const badge = document.createElement('div');
            badge.className = 'sorter-badge';
            badge.innerHTML = `<span class="sorter-badge-label">${field.label}</span>`
                            + `<span class="sorter-badge-value">${formatAvgValue(val)}</span>`;
            badgeArea.appendChild(badge);
        }
    }
}

// ---------------------------------------------------------------------------
// Picker list renderer
// ---------------------------------------------------------------------------

function renderPickerList(query) {
    const list = document.getElementById('sorterPickerList');
    if (!list) return;

    const fields = getFieldsForTab(sorterCurrentTab);
    const lq     = query.toLowerCase().trim();

    list.innerHTML = '';

    const filtered = lq
        ? fields.filter(f =>
            f.label.toLowerCase().includes(lq) ||
            (f.key && f.key.toLowerCase().includes(lq)))
        : fields;

    if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:0.9rem;padding:8px;';
        empty.textContent   = 'No matching fields.';
        list.appendChild(empty);
        return;
    }

    let groups;

    if (sorterCurrentTab === 'ships' || sorterCurrentTab === 'variants') {
        const computed  = filtered.filter(f => f.isComputed || f.useComputed);
        const accum     = filtered.filter(f => f.useAccum && !f.isComputed && !f.useComputed);
        const hardpoint = filtered.filter(f => f.computed && !f.isComputed && !f.useComputed && !f.useAccum);
        const base      = filtered.filter(f => !f.isComputed && !f.useComputed && !f.computed && !f.useAccum);

        groups = [
            { label: '⚡ Computed — Physics (with outfits)',     fields: computed  },
            { label: '📦 Accumulated Attributes (with outfits)', fields: accum     },
            { label: '🔩 Base Attributes (hull only)',            fields: base      },
            { label: '🎯 Hardpoints',                            fields: hardpoint },
        ];

    } else if (sorterCurrentTab === 'outfits') {
        const outfitAttrs    = filtered.filter(f => f.group === 'outfit');
        const weaponPerShot  = filtered.filter(f => f.group === 'weapon' && !f.isDps && !f.isOutfitComputed);
        const weaponDps      = filtered.filter(f => f.group === 'weapon' && f.isDps);
        const weaponComputed = filtered.filter(f => f.group === 'weapon' && f.isOutfitComputed);

        groups = [
            { label: 'Outfit Attributes',          fields: outfitAttrs    },
            { label: '⚡ Weapon — Computed Stats',  fields: weaponComputed },
            { label: '💥 Weapon — DPS',             fields: weaponDps      },
            { label: '🎯 Weapon — Per Shot',        fields: weaponPerShot  },
        ];

    } else {
        groups = [{ label: null, fields: filtered }];
    }

    for (const { label: groupLabel, fields: groupFields } of groups) {
        if (groupFields.length === 0) continue;

        if (groupLabel) {
            const header = document.createElement('div');
            header.style.cssText =
                'color:#63b3ed;font-size:11px;font-weight:700;letter-spacing:.1em;' +
                'text-transform:uppercase;padding:8px 8px 4px;margin-top:4px;' +
                'border-top:1px solid rgba(59,130,246,0.2);';
            header.textContent = groupLabel;
            list.appendChild(header);
        }

        for (const field of groupFields) {
            const row = document.createElement('div');
            row.className = 'sorter-picker-row';

            const checkbox    = document.createElement('input');
            checkbox.type     = 'checkbox';
            checkbox.id       = `sp-${field.id}`;
            checkbox.checked  = sorterPickerPending.includes(field.id);
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    if (!sorterPickerPending.includes(field.id))
                        sorterPickerPending.push(field.id);
                } else {
                    sorterPickerPending = sorterPickerPending.filter(id => id !== field.id);
                }
            };

            const lbl       = document.createElement('label');
            lbl.htmlFor     = `sp-${field.id}`;
            lbl.textContent = field.label;

            row.onclick = e => { if (e.target !== checkbox) checkbox.click(); };
            row.appendChild(checkbox);
            row.appendChild(lbl);
            list.appendChild(row);
        }
    }
}

// ---------------------------------------------------------------------------
// Tab change
// ---------------------------------------------------------------------------

function onSorterTabChange(tab) {
    sorterCurrentTab = tab;
    activeSorters    = [];
    delete _fieldCache[tab];
    renderSorterBox();
}

// ---------------------------------------------------------------------------
// Global exports
// ---------------------------------------------------------------------------

window.applySorters        = applySorters;
window.setSorterItems      = setSorterItems;
window.setSorterAttrDefs   = setSorterAttrDefs;
window.setSorterPluginId   = setSorterPluginId;
window.renderSorterBox     = renderSorterBox;
window.openSorterPicker    = openSorterPicker;
window.closeSorterPicker   = closeSorterPicker;
window.confirmSorterPicker = confirmSorterPicker;
window.renderPickerList    = renderPickerList;
window.onSorterTabChange   = onSorterTabChange;
window.stampSorterValues   = stampSorterValues;
