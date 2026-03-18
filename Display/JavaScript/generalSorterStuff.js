// Sorter.js
// Dynamically builds sortable field lists from attributeDefinitions.json.
// Attribute keys are used as IDs with spaces removed (e.g. "shield generation" → "shieldgeneration").
// No hardcoded attribute lists — all come from attrDefs at runtime.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeSorters          = [];   // [{ id, key, label, path, dir, computed? }]
let sorterCurrentTab       = 'ships';
let sorterPickerPending    = [];   // ids staged in popup before confirming
let _sorterItems           = [];   // last filtered item set, for avg calculation
let _sorterAttrDefs        = null; // reference to window.attrDefs / passed-in defs

// ---------------------------------------------------------------------------
// Field building — called lazily so attrDefs is loaded by then
// ---------------------------------------------------------------------------

function keyToId(key) {
    // Remove all spaces and special chars that would break DOM IDs
    return key.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function toTitleCase(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Build the flat field list for a given tab from attrDefs.
 * Ships / variants: attributes.* fields + computed helpers.
 * Outfits: same pool, filtered to shownInOutfitPanel.
 * For ships we include everything that is numeric and not a weapon-only key.
 */
function buildFieldsForTab(tab) {
    const defs = _sorterAttrDefs?.attributes || {};
    const fields = [];

    // Decide which defs to include based on tab
    const isShipLike = tab === 'ships' || tab === 'variants';

    for (const [key, def] of Object.entries(defs)) {
        // Skip boolean and weapon-only stats — they aren't sortable numbers on an item
        if (def.isBoolean)    continue;
        if (def.isWeaponStat) continue;

        if (tab === 'outfits') {
            if (!def.shownInOutfitPanel) continue;
        }
        // For ships/variants include everything numeric that appears on a ship
        // (shownInShipPanel, usedInShipFunctions, or general attributes)

        const id    = keyToId(key);
        const label = toTitleCase(key);

        if (isShipLike) {
            // Ship attributes live under item.attributes.*
            fields.push({
                id,
                key,
                label,
                path: ['attributes', key],
            });
        } else {
            // Outfit attributes live flat on the item (not nested under attributes)
            fields.push({
                id,
                key,
                label,
                path: [key],
            });
        }
    }

    // Add a top-level cost field for outfits (lives at item.cost, not item.attributes.cost)
    if (tab === 'outfits') {
        fields.unshift({ id: 'cost', key: 'cost', label: 'Cost', path: ['cost'] });
        fields.unshift({ id: 'mass', key: 'mass', label: 'Mass', path: ['mass'] });
    }

    // Computed helpers for ships
    if (isShipLike) {
        fields.push({ id: '_gunCount',    key: '_gunCount',    label: 'Gun Ports',    computed: item => (item.guns    || []).length });
        fields.push({ id: '_turretCount', key: '_turretCount', label: 'Turret Ports', computed: item => (item.turrets || []).length });
        fields.push({ id: '_bayCount',    key: '_bayCount',    label: 'Bay Count',    computed: item => (item.bays    || []).length });
        fields.push({ id: '_engineCount', key: '_engineCount', label: 'Engine Points',computed: item => (item.engines || []).length });
    }

    // Sort alphabetically for picker UX
    fields.sort((a, b) => a.label.localeCompare(b.label));
    return fields;
}

// Cache so we don't rebuild every keypress
const _fieldCache = {};
function getFieldsForTab(tab) {
    if (!_fieldCache[tab]) {
        _fieldCache[tab] = buildFieldsForTab(tab);
    }
    return _fieldCache[tab];
}

/** Clear cache when attrDefs is set (called from setSorterAttrDefs) */
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
    // Walk dot-path: ['attributes', 'shields'] → item.attributes.shields
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
// Core sort — pass your filtered array through this before rendering
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

            const aMissing = av == null || av === undefined || (typeof av === 'number' && isNaN(av));
            const bMissing = bv == null || bv === undefined || (typeof bv === 'number' && isNaN(bv));

            // Items missing a field always go to the bottom regardless of direction
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
// Average calculation across currently visible items
// ---------------------------------------------------------------------------

function setSorterItems(items) {
    _sorterItems = items || [];
    renderSorterBox(); // refresh averages whenever filtered set changes
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
        dirBtn.title = 'Toggle direction';
        dirBtn.onclick = () => {
            sorter.dir = sorter.dir === 'asc' ? 'desc' : 'asc';
            renderSorterBox();
            _triggerFilterItems();
        };

        const upBtn = document.createElement('button');
        upBtn.className = 'sorter-move-btn';
        upBtn.textContent = '▲';
        upBtn.title = 'Move up (higher priority)';
        upBtn.disabled = idx === 0;
        upBtn.onclick = () => {
            [activeSorters[idx - 1], activeSorters[idx]] = [activeSorters[idx], activeSorters[idx - 1]];
            renderSorterBox();
            _triggerFilterItems();
        };

        const downBtn = document.createElement('button');
        downBtn.className = 'sorter-move-btn';
        downBtn.textContent = '▼';
        downBtn.title = 'Move down (lower priority)';
        downBtn.disabled = idx === activeSorters.length - 1;
        downBtn.onclick = () => {
            [activeSorters[idx], activeSorters[idx + 1]] = [activeSorters[idx + 1], activeSorters[idx]];
            renderSorterBox();
            _triggerFilterItems();
        };

        const removeBtn = document.createElement('button');
        removeBtn.className = 'sorter-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove sorter';
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
    // Pre-populate pending with whatever is already active
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

    // Add newly ticked fields (default dir: desc so biggest first)
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

    // Remove unticked fields
    activeSorters = activeSorters.filter(s => sorterPickerPending.includes(s.id));

    closeSorterPicker();
    renderSorterBox();
    _triggerFilterItems();
}

function renderPickerList(query) {
    const list   = document.getElementById('sorterPickerList');
    if (!list) return;

    const fields = getFieldsForTab(sorterCurrentTab);
    const lq     = query.toLowerCase().trim();

    list.innerHTML = '';

    const filtered = lq
        ? fields.filter(f => f.label.toLowerCase().includes(lq) || f.key.toLowerCase().includes(lq))
        : fields;

    if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:0.9rem;padding:8px;';
        empty.textContent = 'No matching fields.';
        list.appendChild(empty);
        return;
    }

    filtered.forEach(field => {
        const row = document.createElement('div');
        row.className = 'sorter-picker-row';

        const checkbox = document.createElement('input');
        checkbox.type    = 'checkbox';
        checkbox.id      = `sp-${field.id}`;
        checkbox.checked = sorterPickerPending.includes(field.id);
        checkbox.onchange = () => {
            if (checkbox.checked) {
                if (!sorterPickerPending.includes(field.id)) {
                    sorterPickerPending.push(field.id);
                }
            } else {
                sorterPickerPending = sorterPickerPending.filter(id => id !== field.id);
            }
        };

        const lbl = document.createElement('label');
        lbl.htmlFor     = `sp-${field.id}`;
        lbl.textContent = field.label;

        // Click anywhere on the row to toggle
        row.onclick = (e) => {
            if (e.target !== checkbox) checkbox.click();
        };

        row.appendChild(checkbox);
        row.appendChild(lbl);
        list.appendChild(row);
    });
}

// ---------------------------------------------------------------------------
// Tab change — call this from switchTab() in Plugin_Script.js
// ---------------------------------------------------------------------------

function onSorterTabChange(tab) {
    sorterCurrentTab = tab;
    activeSorters    = [];   // reset sorters when tab changes (fields are different)
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
