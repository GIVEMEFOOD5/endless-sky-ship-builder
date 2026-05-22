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
// Intentionally minimal: the typeof === 'number' guard handles everything
// else; these exist only to avoid iterating into known object-valued keys.
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
// Accumulated attribute keys from accumulateOutfits() never start with these.
const COMPUTED_PREFIXES = ['_fn_', '_derived_', '_sys_'];

function isComputedKey(key) {
    return COMPUTED_PREFIXES.some(p => key.startsWith(p));
}

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
//
// Iterates the current on-screen items and collects every numeric key as a
// sortable field descriptor. Nothing is predeclared.
//
// For ships/variants this now also scans getComputedStats() output (the
// accumulated result including outfits) to discover "accumulated attribute"
// fields — keys that exist in the post-outfit-stacking attribute map but are
// NOT _fn_/_derived_/_sys_ computed keys.  These are labelled "(with outfits)"
// to distinguish them from the raw base-only "(base)" fields.
//
// Returns arrays (all sorted alphabetically by label):
//   shipBaseFields  — from item.attributes.* (ships/variants, base only)
//   shipAccumFields — from getComputedStats() accumulated attrs (with outfits)
//   outfitFields    — from item.*            (outfits, top-level)
//   weaponFields    — from item.weapon.*     (outfits with a weapon sub-object)
//   effectFields    — from item.*            (effects / other tabs)
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
                const reload = parseFloat(item.weapon.reload ?? 1) || 1;
                const sps    = 60 / reload;

                for (const [key, val] of Object.entries(item.weapon)) {
                    if (SKIP_WEAPON.has(key))    continue;
                    if (typeof val !== 'number') continue;
                    if (/^[A-Z]/.test(key))      continue;

                    // ── Per-shot field (existing behaviour) ──────────────────
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

// ── DPS field for damage keys — only if weapon has explicit reload ────
if (key.endsWith(' damage') && item.weapon.reload != null) {
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
//
// getComputedSorterFields() (from ComputedStats.js) returns descriptors like:
//   { id: '_fn_MaxShields', key: '_fn_MaxShields', label: '...', isComputed: true }
//
// We spread useComputed: true onto each so getFieldValue can detect them with
// either flag — isComputed (from ComputedStats) or useComputed (set here).
// ---------------------------------------------------------------------------

function buildComputedFields() {
    if (typeof getComputedSorterFields !== 'function') return [];
    return getComputedSorterFields().map(f => ({ ...f, useComputed: true }));
}

// ---------------------------------------------------------------------------
// Hardpoint count pseudo-fields (ships / variants only)
//
// These use an inline computed fn rather than a path lookup.
// They carry { computed: fn } but NOT isComputed / useComputed, so they are
// cleanly separated from ComputedStats-derived fields in the picker grouping.
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
        // Order: physics-computed first, then accumulated attrs, then base-only, then hardpoints
        for (const f of buildComputedFields())      add(f);
        for (const f of shipAccumFields)            add(f);
        for (const f of shipBaseFields)             add(f);
        for (const { id, label, fn } of HARDPOINT_FIELDS) {
            add({ id, key: id, label, computed: fn });
        }

    } else if (isOutfits) {
        // Order: outfit attributes first, then weapon stats
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
    _sorterPluginId = pluginId;
    _cachedOutfitIndex = null;
    clearFieldCache();
    if (typeof clearComputedCache === 'function') clearComputedCache();
}

/**
 * Called by filterItems() with the post-filter visible items.
 * Deletes the current tab's field cache so the picker rebuilds from
 * exactly what is on screen right now.
 */
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
//   1. field.computed(item)                  — hardpoint count lambda
//   2. getComputedStats(item, pluginId)[key] — _fn_/_derived_/_sys_ physics stats
//   3. getComputedStats(item, pluginId)[key] — accumulated attr (with outfits)
//      flagged by field.useAccum === true
//   4. Walk field.path on the raw item       — base attributes or top-level
// ---------------------------------------------------------------------------

function getFieldValue(item, field) {

// 0. Weapon DPS fields — resolved via WeaponStats
if (field.isDps && typeof window.WeaponStats !== 'undefined') {
    if (!item.weapon) return undefined;
    const profile = window.WeaponStats.getOutfitWeaponStats(item, _getOutfitIndex());
    if (!profile) return undefined;
    const dpsKey = field.key + ' damage';
    return profile.dpsBreakdown?.[dpsKey] ?? undefined;
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
        // Apply DPS multiplier if present (weapon damage DPS fields)
        if (typeof obj === 'number' && field.dpsMultiplier) {
            return obj * field.dpsMultiplier;
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
            if (aMissing) return 1;   // items without this field sink to bottom
            if (bMissing) return -1;

            const diff = sorter.dir === 'asc' ? av - bv : bv - av;
            if (diff !== 0) return diff;
        }
        return 0;
    });
}

// ---------------------------------------------------------------------------
// Average calculation (over currently visible items)
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

    // Add newly ticked fields (preserving all properties needed by getFieldValue)
    for (const id of sorterPickerPending) {
        if (!activeSorters.find(s => s.id === id)) {
            const field = fields.find(f => f.id === id);
            if (field) {
                activeSorters.push({
                    id:          field.id,
                    key:         field.key,
                    label:       field.label,
                    path:        field.path        || null,
                    computed:    field.computed     || null,
                    useComputed: field.useComputed  || false,
                    isComputed:  field.isComputed   || false,
                    useAccum:    field.useAccum     || false,   // ← new
                    isDps:       field.isDps        || false,
                    dir:         'desc',
                });
            }
        }
    }

    // Remove unticked fields
    activeSorters = activeSorters.filter(s => sorterPickerPending.includes(s.id));

    closeSorterPicker();
    renderSorterBox();
    await _triggerFilterItems();
}

function stampSorterValues() {
    const container = document.getElementById('cardsContainer');
    if (!container) return;

    // Clear all existing badges first
    container.querySelectorAll('.sorter-badges').forEach(el => { el.innerHTML = ''; });

    if (activeSorters.length === 0) return;

    const fields = getFieldsForTab(sorterCurrentTab);

    for (const card of container.querySelectorAll('.card')) {
        // Retrieve the item reference stored at card-creation time
        const item = _cardItemMap?.get ? undefined : null; 
        // _cardItemMap is in DataViewer.js scope — use the dataset id to find the item
        const itemId = card.dataset.itemId;
        if (!itemId) continue;

        // Find the item in _sorterItems by matching _internalId or name
        const item2 = _sorterItems.find(
            i => (i._internalId || i.name || '') == itemId
        );
        if (!item2) continue;

        const badgeArea = card.querySelector('.sorter-badges');
        if (!badgeArea) continue;

        for (const sorter of activeSorters) {
            const field = fields.find(f => f.id === sorter.id);
            if (!field) continue;

            const val = getFieldValue(item2, field);
            console.log('field:', field.label, 'key:', field.key, 'val:', val, 'isComputed:', field.isComputed, 'useComputed:', field.useComputed);
            
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
//
// Groups for ships / variants:
//   ⚡ Computed (physics, with outfits) — isComputed || useComputed
//   Accumulated Attributes (with outfits) — useAccum === true (plain numerics)
//   Base Attributes (hull only)          — raw scanned fields from item.attributes
//   Hardpoints                           — inline computed fns (f.computed, not isComputed)
//
// Groups for outfits:
//   Outfit Attributes          — top-level numeric fields
//   Weapon Stats               — item.weapon.* numeric fields
//
// Effects / other: ungrouped.
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
        // Physics computed = ComputedStats _fn_/_derived_/_sys_ keys
        const computed  = filtered.filter(f => f.isComputed || f.useComputed);
        // Accumulated attribute = base + outfits stacked, plain numeric key
        const accum     = filtered.filter(f => f.useAccum && !f.isComputed && !f.useComputed);
        // Hardpoint = has f.computed fn but is NOT a ComputedStats field
        const hardpoint = filtered.filter(f => f.computed && !f.isComputed && !f.useComputed && !f.useAccum);
        // Base-only = raw item.attributes scan, no outfit stacking
        const base      = filtered.filter(f => !f.isComputed && !f.useComputed && !f.computed && !f.useAccum);

        groups = [
            { label: '⚡ Computed — Physics (with outfits)',    fields: computed  },
            { label: '📦 Accumulated Attributes (with outfits)', fields: accum     },
            { label: '🔩 Base Attributes (hull only)',           fields: base      },
            { label: '🎯 Hardpoints',                           fields: hardpoint },
        ];

    } else if (sorterCurrentTab === 'outfits') {
        groups = [
            { label: 'Outfit Attributes', fields: filtered.filter(f => f.group === 'outfit') },
            { label: 'Weapon Stats',      fields: filtered.filter(f => f.group === 'weapon') },
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
// Tab change — clear active sorters and invalidate field cache for new tab
// ---------------------------------------------------------------------------

function onSorterTabChange(tab) {
    sorterCurrentTab = tab;
    activeSorters    = [];
    delete _fieldCache[tab]; // will rescan when new tab's items arrive
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
