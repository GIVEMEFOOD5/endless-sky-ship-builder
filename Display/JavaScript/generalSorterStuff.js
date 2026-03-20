// Sorter.js
// Builds sortable field lists from:
//   1. attributeDefinitions.json  — all defined game attributes
//   2. ComputedStats fields        — derived values (effective shields, regen/s etc.)
//   3. Raw item scanning           — any numeric field found on actual loaded items
//
// For ship/variant tabs, sorting uses getComputedStats() so values reflect
// the ship's installed outfits, not just base attributes.
//
// Multi-plugin: items carry a _pluginId property (set by PluginManager.getMergedItems).
// getFieldValue() uses item._pluginId when calling getComputedStats so each item
// is evaluated against its own plugin's outfit index.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeSorters          = [];
let sorterCurrentTab       = 'ships';
let sorterPickerPending    = [];
let _sorterItems           = [];
let _sorterAttrDefs        = null;
let _sorterPluginId        = null;  // primary plugin — fallback when item has no _pluginId

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyToId(key) {
    return key.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function toTitleCase(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Field building
// ---------------------------------------------------------------------------

function scanItemsForExtraFields(items, tab, knownIds) {
    const extras    = {};
    const isShipLike = tab === 'ships' || tab === 'variants';

    const SKIP_KEYS = new Set([
        'name','description','sprite','thumbnail','projectile',
        'afterburner effect','flare sprite','reverse flare sprite',
        'steering flare sprite','_internalId','_pluginId','_hash',
        'final explode','outfitMap','governments','licenses',
        'weapon','engines','reverseEngines','steeringEngines',
        'guns','turrets','bays','spriteData',
    ]);

    const sample = items.slice(0, 100);

    for (const item of sample) {
        for (const [key, val] of Object.entries(item)) {
            if (SKIP_KEYS.has(key)) continue;
            if (typeof val !== 'number') continue;
            const id = keyToId(key);
            if (knownIds.has(id) || extras[id]) continue;
            extras[id] = { id, key, label: toTitleCase(key), path: [key] };
        }

        if (isShipLike && item.attributes && typeof item.attributes === 'object') {
            for (const [key, val] of Object.entries(item.attributes)) {
                if (typeof val !== 'number') continue;
                const id = keyToId(key);
                if (knownIds.has(id) || extras[id]) continue;
                extras[id] = { id, key, label: toTitleCase(key), path: ['attributes', key] };
            }
        }
    }

    return Object.values(extras);
}

function buildFieldsForTab(tab, items) {
    const defs       = _sorterAttrDefs?.attributes || {};
    const isShipLike = tab === 'ships' || tab === 'variants';
    const fields     = [];
    const seenIds    = new Set();

    for (const [key, def] of Object.entries(defs)) {
        if (def.isBoolean)    continue;
        if (def.isWeaponStat) continue;

        const id    = keyToId(key);
        const label = toTitleCase(key);

        if (isShipLike) {
            fields.push({ id, key, label, path: ['attributes', key], useComputed: true });
        } else {
            fields.push({ id, key, label, path: [key] });
        }
        seenIds.add(id);
    }

    if (isShipLike && typeof getComputedSorterFields === 'function') {
        getComputedSorterFields().forEach(f => {
            if (!seenIds.has(f.id)) {
                fields.push({ ...f, useComputed: true });
                seenIds.add(f.id);
            }
        });
    }

    if (items && items.length > 0) {
        scanItemsForExtraFields(items, tab, seenIds).forEach(f => {
            fields.push(f);
            seenIds.add(f.id);
        });
    }

    if (isShipLike) {
        [
            { id: '_gunCount',    label: 'Gun Ports',     fn: i => (i.guns    || []).length },
            { id: '_turretCount', label: 'Turret Ports',  fn: i => (i.turrets || []).length },
            { id: '_bayCount',    label: 'Bay Count',     fn: i => (i.bays    || []).length },
            { id: '_engineCount', label: 'Engine Points', fn: i => (i.engines || []).length },
        ].forEach(({ id, label, fn }) => {
            if (!seenIds.has(id)) {
                fields.push({ id, key: id, label, computed: fn });
                seenIds.add(id);
            }
        });
    }

    fields.sort((a, b) => a.label.localeCompare(b.label));
    return fields;
}

const _fieldCache = {};

function getFieldsForTab(tab) {
    if (!_fieldCache[tab]) {
        _fieldCache[tab] = buildFieldsForTab(tab, _sorterItems);
    }
    return _fieldCache[tab];
}

function clearFieldCache() {
    Object.keys(_fieldCache).forEach(k => delete _fieldCache[k]);
}

// ---------------------------------------------------------------------------
// Public setters called from Plugin_Script.js
// ---------------------------------------------------------------------------

function setSorterAttrDefs(defs) {
    _sorterAttrDefs = defs;
    clearFieldCache();
}

function setSorterPluginId(pluginId) {
    _sorterPluginId = pluginId;
    clearFieldCache();
    if (typeof clearComputedCache === 'function') clearComputedCache();
}

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

function getFieldValue(item, field) {
    // Inline computed (port counts etc.)
    if (field.computed) return field.computed(item);

    // Use computed stats engine for ship-like tabs.
    // KEY CHANGE: prefer item._pluginId over the global _sorterPluginId so that
    // ships from secondary plugins are evaluated against their own outfit index.
    if (field.useComputed && typeof getComputedStats === 'function') {
        const pluginId = item._pluginId || _sorterPluginId;
        if (pluginId) {
            const stats = getComputedStats(item, pluginId);
            const val   = stats[field.key];
            if (val !== undefined) return val;
            // Fall through to path lookup if key not in computed stats
        }
    }

    // Default: walk the path
    if (field.path) {
        return field.path.reduce((obj, k) => (obj != null ? obj[k] : undefined), item);
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
    return val;
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

function setSorterItems(items) {
    _sorterItems = items || [];
    delete _fieldCache[sorterCurrentTab];
    renderSorterBox();
}

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
// Render active sorter box
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

    sorterPickerPending.forEach(id => {
        if (!activeSorters.find(s => s.id === id)) {
            const field = fields.find(f => f.id === id);
            if (field) {
                activeSorters.push({
                    id:          field.id,
                    key:         field.key,
                    label:       field.label,
                    path:        field.path,
                    computed:    field.computed,
                    useComputed: field.useComputed,
                    dir:         'desc',
                });
            }
        }
    });

    activeSorters = activeSorters.filter(s => sorterPickerPending.includes(s.id));

    closeSorterPicker();
    renderSorterBox();
    await _triggerFilterItems();
}

function renderPickerList(query) {
    const list = document.getElementById('sorterPickerList');
    if (!list) return;

    const fields = getFieldsForTab(sorterCurrentTab);
    const lq     = query.toLowerCase().trim();

    list.innerHTML = '';

    const filtered = lq
        ? fields.filter(f =>
            f.label.toLowerCase().includes(lq) ||
            f.key.toLowerCase().includes(lq))
        : fields;

    if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:0.9rem;padding:8px;';
        empty.textContent   = 'No matching fields.';
        list.appendChild(empty);
        return;
    }

    const derived = filtered.filter(f => f.isComputed);
    const normal  = filtered.filter(f => !f.isComputed);

    const renderGroup = (groupFields, groupLabel) => {
        if (groupFields.length === 0) return;

        if (groupLabel) {
            const header = document.createElement('div');
            header.style.cssText =
                'color:#63b3ed;font-size:11px;font-weight:700;letter-spacing:.1em;' +
                'text-transform:uppercase;padding:8px 8px 4px;margin-top:4px;' +
                'border-top:1px solid rgba(59,130,246,0.2);';
            header.textContent = groupLabel;
            list.appendChild(header);
        }

        groupFields.forEach(field => {
            const row = document.createElement('div');
            row.className = 'sorter-picker-row';

            const checkbox       = document.createElement('input');
            checkbox.type        = 'checkbox';
            checkbox.id          = `sp-${field.id}`;
            checkbox.checked     = sorterPickerPending.includes(field.id);
            checkbox.onchange    = () => {
                if (checkbox.checked) {
                    if (!sorterPickerPending.includes(field.id)) sorterPickerPending.push(field.id);
                } else {
                    sorterPickerPending = sorterPickerPending.filter(id => id !== field.id);
                }
            };

            const lbl         = document.createElement('label');
            lbl.htmlFor       = `sp-${field.id}`;
            lbl.textContent   = field.label;

            row.onclick = (e) => { if (e.target !== checkbox) checkbox.click(); };
            row.appendChild(checkbox);
            row.appendChild(lbl);
            list.appendChild(row);
        });
    };

    renderGroup(derived, derived.length > 0 ? '⚡ Computed (with outfits)' : null);
    renderGroup(normal,  derived.length > 0 ? 'Base Attributes' : null);
}

// ---------------------------------------------------------------------------
// Tab change
// ---------------------------------------------------------------------------

function onSorterTabChange(tab) {
    sorterCurrentTab = tab;
    activeSorters    = [];
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
