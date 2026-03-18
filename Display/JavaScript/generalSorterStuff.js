// Sorter.js
// Builds sortable field lists from two sources:
//   1. attributeDefinitions.json  — all defined game attributes
//   2. Raw item scanning          — any numeric field found on actual loaded items
//      (catches cost, mass, and any plugin-specific fields not in attrDefs)
// No hardcoded attribute lists anywhere.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeSorters          = [];
let sorterCurrentTab       = 'ships';
let sorterPickerPending    = [];
let _sorterItems           = [];
let _sorterAttrDefs        = null;

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

/**
 * Scan a sample of items to find every numeric field not already covered by
 * attrDefs. Returns an array of field descriptors.
 *
 * For ships:   checks item.* (top level) and item.attributes.*
 * For outfits: checks item.* (top level) only
 */
function scanItemsForExtraFields(items, tab, knownIds) {
    const extras = {};
    const isShipLike = tab === 'ships' || tab === 'variants';

    // Sample up to 100 items so this stays fast
    const sample = items.slice(0, 100);

    const SKIP_KEYS = new Set([
        'name', 'description', 'sprite', 'thumbnail', 'projectile',
        'afterburner effect', 'flare sprite', 'reverse flare sprite',
        'steering flare sprite', '_internalId', '_pluginId', '_hash',
        'final explode', 'outfitMap', 'governments', 'licenses',
        'weapon', 'engines', 'reverseEngines', 'steeringEngines',
        'guns', 'turrets', 'bays', 'spriteData',
    ]);

    for (const item of sample) {
        // Scan top-level numeric fields (cost, mass, etc.)
        for (const [key, val] of Object.entries(item)) {
            if (SKIP_KEYS.has(key)) continue;
            if (typeof val !== 'number') continue;
            const id = keyToId(key);
            if (knownIds.has(id)) continue;
            if (!extras[id]) {
                extras[id] = {
                    id,
                    key,
                    label: toTitleCase(key),
                    path: [key],
                };
            }
        }

        // For ships: also scan item.attributes.* for any numeric fields
        // not already picked up from attrDefs (plugin-specific attrs)
        if (isShipLike && item.attributes && typeof item.attributes === 'object') {
            for (const [key, val] of Object.entries(item.attributes)) {
                if (typeof val !== 'number') continue;
                const id = keyToId(key);
                if (knownIds.has(id)) continue;
                if (!extras[id]) {
                    extras[id] = {
                        id,
                        key,
                        label: toTitleCase(key),
                        path: ['attributes', key],
                    };
                }
            }
        }
    }

    return Object.values(extras);
}

/**
 * Build the full field list for a tab.
 * Called the first time a tab is accessed after items are available.
 */
function buildFieldsForTab(tab, items) {
    const defs      = _sorterAttrDefs?.attributes || {};
    const isShipLike = tab === 'ships' || tab === 'variants';
    const fields    = [];
    const seenIds   = new Set();

    // ── 1. Pull numeric fields from attrDefs ──────────────────────────────
    for (const [key, def] of Object.entries(defs)) {
        if (def.isBoolean)    continue;  // booleans aren't sortable numbers
        if (def.isWeaponStat) continue;  // weapon stats live on weapon sub-object

        const id    = keyToId(key);
        const label = toTitleCase(key);

        if (isShipLike) {
            fields.push({ id, key, label, path: ['attributes', key] });
        } else {
            // Outfits: most attrs are flat on the item
            fields.push({ id, key, label, path: [key] });
        }
        seenIds.add(id);
    }

    // ── 2. Scan actual items for any numeric fields not in attrDefs ───────
    if (items && items.length > 0) {
        const extras = scanItemsForExtraFields(items, tab, seenIds);
        extras.forEach(f => {
            fields.push(f);
            seenIds.add(f.id);
        });
    }

    // ── 3. Computed helpers for ship-like tabs ────────────────────────────
    if (isShipLike) {
        const computed = [
            { id: '_gunCount',    key: '_gunCount',    label: 'Gun Ports',     computed: item => (item.guns    || []).length },
            { id: '_turretCount', key: '_turretCount', label: 'Turret Ports',  computed: item => (item.turrets || []).length },
            { id: '_bayCount',    key: '_bayCount',    label: 'Bay Count',     computed: item => (item.bays    || []).length },
            { id: '_engineCount', key: '_engineCount', label: 'Engine Points', computed: item => (item.engines || []).length },
        ];
        computed.forEach(f => {
            if (!seenIds.has(f.id)) {
                fields.push(f);
                seenIds.add(f.id);
            }
        });
    }

    // ── 4. Sort alphabetically for UX ─────────────────────────────────────
    fields.sort((a, b) => a.label.localeCompare(b.label));
    return fields;
}

// Cache keyed by tab. Invalidated when attrDefs or items change.
const _fieldCache = {};

function getFieldsForTab(tab) {
    if (!_fieldCache[tab]) {
        // Build with current _sorterItems as the sample
        _fieldCache[tab] = buildFieldsForTab(tab, _sorterItems);
    }
    return _fieldCache[tab];
}

function clearFieldCache() {
    Object.keys(_fieldCache).forEach(k => delete _fieldCache[k]);
}

// ---------------------------------------------------------------------------
// Public: receive attrDefs from Plugin_Script.js
// ---------------------------------------------------------------------------

function setSorterAttrDefs(defs) {
    _sorterAttrDefs = defs;
    clearFieldCache();
}

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

function getFieldValue(item, field) {
    if (field.computed) return field.computed(item);
    return field.path.reduce((obj, k) => (obj != null ? obj[k] : undefined), item);
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

            // Missing always sinks to the bottom regardless of direction
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
    // Rebuild field cache for the current tab now that we have real items,
    // so any extra scanned fields appear immediately
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

function renderSorterBox() {
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
        label.className = 'sorter-label';
        label.textContent = sorter.label;

        const avg = document.createElement('span');
        avg.className = 'sorter-avg';
        avg.textContent = `avg: ${computeAverage(sorter)}`;

        const dirBtn = document.createElement('button');
        dirBtn.className = 'sorter-dir-btn';
        dirBtn.textContent = sorter.dir === 'asc' ? '↑ Asc' : '↓ Desc';
        dirBtn.onclick = () => {
            sorter.dir = sorter.dir === 'asc' ? 'desc' : 'asc';
            renderSorterBox();
            _triggerFilterItems();
        };

        const upBtn = document.createElement('button');
        upBtn.className = 'sorter-move-btn';
        upBtn.textContent = '▲';
        upBtn.disabled = idx === 0;
        upBtn.onclick = () => {
            [activeSorters[idx - 1], activeSorters[idx]] = [activeSorters[idx], activeSorters[idx - 1]];
            renderSorterBox();
            _triggerFilterItems();
        };

        const downBtn = document.createElement('button');
        downBtn.className = 'sorter-move-btn';
        downBtn.textContent = '▼';
        downBtn.disabled = idx === activeSorters.length - 1;
        downBtn.onclick = () => {
            [activeSorters[idx], activeSorters[idx + 1]] = [activeSorters[idx + 1], activeSorters[idx]];
            renderSorterBox();
            _triggerFilterItems();
        };

        const removeBtn = document.createElement('button');
        removeBtn.className = 'sorter-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.onclick = () => {
            activeSorters.splice(idx, 1);
            renderSorterBox();
            _triggerFilterItems();
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

function _triggerFilterItems() {
    if (typeof filterItems === 'function') filterItems();
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

function confirmSorterPicker() {
    const fields = getFieldsForTab(sorterCurrentTab);

    sorterPickerPending.forEach(id => {
        if (!activeSorters.find(s => s.id === id)) {
            const field = fields.find(f => f.id === id);
            if (field) {
                activeSorters.push({
                    id:       field.id,
                    key:      field.key,
                    label:    field.label,
                    path:     field.path,
                    computed: field.computed,
                    dir:      'desc',
                });
            }
        }
    });

    activeSorters = activeSorters.filter(s => sorterPickerPending.includes(s.id));

    closeSorterPicker();
    renderSorterBox();
    _triggerFilterItems();
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

    filtered.forEach(field => {
        const row = document.createElement('div');
        row.className = 'sorter-picker-row';

        const checkbox = document.createElement('input');
        checkbox.type     = 'checkbox';
        checkbox.id       = `sp-${field.id}`;
        checkbox.checked  = sorterPickerPending.includes(field.id);
        checkbox.onchange = () => {
            if (checkbox.checked) {
                if (!sorterPickerPending.includes(field.id)) {
                    sorterPickerPending.push(field.id);
                }
            } else {
                sorterPickerPending = sorterPickerPending.filter(id => id !== field.id);
            }
        };

        const lbl     = document.createElement('label');
        lbl.htmlFor   = `sp-${field.id}`;
        lbl.textContent = field.label;

        // Click anywhere on the row toggles the checkbox
        row.onclick = (e) => { if (e.target !== checkbox) checkbox.click(); };

        row.appendChild(checkbox);
        row.appendChild(lbl);
        list.appendChild(row);
    });
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
window.renderSorterBox     = renderSorterBox;
window.openSorterPicker    = openSorterPicker;
window.closeSorterPicker   = closeSorterPicker;
window.confirmSorterPicker = confirmSorterPicker;
window.renderPickerList    = renderPickerList;
window.onSorterTabChange   = onSorterTabChange;
