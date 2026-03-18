// Sorter.js
// Manages a multi-field sorter with ascending/descending per field,
// average display, and a pop-up picker. Items missing a field sort to the bottom.

// ---------------------------------------------------------------------------
// Attribute definitions per tab
// ---------------------------------------------------------------------------

const SORTER_FIELDS = {
    ships: [
        { key: 'attributes.cost',               label: 'Cost' },
        { key: 'attributes.shields',             label: 'Shields' },
        { key: 'attributes.hull',                label: 'Hull' },
        { key: 'attributes.mass',                label: 'Mass' },
        { key: 'attributes.drag',                label: 'Drag' },
        { key: 'attributes.heat dissipation',    label: 'Heat Dissipation' },
        { key: 'attributes.fuel capacity',       label: 'Fuel Capacity' },
        { key: 'attributes.ramscoop',            label: 'Ramscoop' },
        { key: 'attributes.cargo space',         label: 'Cargo Space' },
        { key: 'attributes.outfit space',        label: 'Outfit Space' },
        { key: 'attributes.weapon capacity',     label: 'Weapon Capacity' },
        { key: 'attributes.engine capacity',     label: 'Engine Capacity' },
        { key: 'attributes.required crew',       label: 'Required Crew' },
        { key: 'attributes.bunks',               label: 'Bunks' },
        { key: 'attributes.shield generation',   label: 'Shield Generation' },
        { key: 'attributes.shield energy',       label: 'Shield Energy' },
        { key: 'attributes.hull repair rate',    label: 'Hull Repair Rate' },
        { key: 'attributes.hull energy',         label: 'Hull Energy' },
        { key: 'attributes.cloak',               label: 'Cloak' },
        { key: 'attributes.cloaking energy',     label: 'Cloaking Energy' },
        { key: 'attributes.cloaking fuel',       label: 'Cloaking Fuel' },
        { key: 'attributes.force protection',    label: 'Force Protection' },
        { key: 'attributes.heat protection',     label: 'Heat Protection' },
        { key: 'attributes.ion resistance',      label: 'Ion Resistance' },
        { key: 'attributes.scramble resistance', label: 'Scramble Resistance' },
        { key: 'attributes.slowing resistance',  label: 'Slowing Resistance' },
        { key: 'attributes.outfit scan power',   label: 'Outfit Scan Power' },
        { key: 'attributes.tactical scan power', label: 'Tactical Scan Power' },
        // Computed helpers
        { key: '_gunCount',    label: 'Gun Ports',    computed: item => (item.guns    || []).length },
        { key: '_turretCount', label: 'Turret Ports', computed: item => (item.turrets || []).length },
        { key: '_bayCount',    label: 'Bay Count',    computed: item => (item.bays    || []).length },
    ],
    variants: [
        { key: 'attributes.cost',             label: 'Cost' },
        { key: 'attributes.shields',          label: 'Shields' },
        { key: 'attributes.hull',             label: 'Hull' },
        { key: 'attributes.mass',             label: 'Mass' },
        { key: 'attributes.drag',             label: 'Drag' },
        { key: 'attributes.cargo space',      label: 'Cargo Space' },
        { key: 'attributes.outfit space',     label: 'Outfit Space' },
        { key: 'attributes.weapon capacity',  label: 'Weapon Capacity' },
        { key: 'attributes.engine capacity',  label: 'Engine Capacity' },
        { key: 'attributes.required crew',    label: 'Required Crew' },
        { key: 'attributes.bunks',            label: 'Bunks' },
        { key: '_gunCount',    label: 'Gun Ports',    computed: item => (item.guns    || []).length },
        { key: '_turretCount', label: 'Turret Ports', computed: item => (item.turrets || []).length },
    ],
    outfits: [
        { key: 'attributes.cost',                label: 'Cost' },
        { key: 'attributes.mass',                label: 'Mass' },
        { key: 'attributes.outfit space',        label: 'Outfit Space' },
        { key: 'attributes.shields',             label: 'Shields' },
        { key: 'attributes.hull',                label: 'Hull' },
        { key: 'attributes.shield generation',   label: 'Shield Generation' },
        { key: 'attributes.hull repair rate',    label: 'Hull Repair Rate' },
        { key: 'attributes.energy capacity',     label: 'Energy Capacity' },
        { key: 'attributes.energy generation',   label: 'Energy Generation' },
        { key: 'attributes.heat generation',     label: 'Heat Generation' },
        { key: 'attributes.cooling',             label: 'Cooling' },
        { key: 'attributes.thrust',              label: 'Thrust' },
        { key: 'attributes.turn',                label: 'Turn' },
        { key: 'attributes.afterburner thrust',  label: 'Afterburner Thrust' },
        { key: 'attributes.engine capacity',     label: 'Engine Capacity' },
        { key: 'attributes.weapon capacity',     label: 'Weapon Capacity' },
        { key: 'attributes.cargo space',         label: 'Cargo Space' },
        { key: 'attributes.fuel capacity',       label: 'Fuel Capacity' },
        { key: 'attributes.ramscoop',            label: 'Ramscoop' },
        { key: 'attributes.drag',                label: 'Drag' },
        { key: 'attributes.bunks',               label: 'Bunks' },
        { key: 'attributes.required crew',       label: 'Required Crew' },
        { key: 'attributes.ion resistance',      label: 'Ion Resistance' },
        { key: 'attributes.disruption resistance', label: 'Disruption Resistance' },
        { key: 'attributes.slowing resistance',  label: 'Slowing Resistance' },
        { key: 'attributes.force protection',    label: 'Force Protection' },
        { key: 'attributes.heat protection',     label: 'Heat Protection' },
    ],
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeSorters  = [];   // [{ key, label, dir: 'asc'|'desc', computed? }]
let sorterPickerPending = []; // keys staged in the popup before confirming

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFieldValue(item, field) {
    if (field.computed) return field.computed(item);
    // Support dot-paths like "attributes.cost"
    return field.key.split('.').reduce((obj, k) => (obj != null ? obj[k] : undefined), item);
}

function formatValue(val) {
    if (val == null || val === undefined) return '—';
    if (typeof val === 'number') {
        return val >= 1000 ? val.toLocaleString() : val;
    }
    return val;
}

function getFieldsForTab(tab) {
    return SORTER_FIELDS[tab] || SORTER_FIELDS.ships;
}

// ---------------------------------------------------------------------------
// Core sort — applied to whatever array filterItems produces
// ---------------------------------------------------------------------------

function applySorters(items) {
    if (activeSorters.length === 0) return items;

    return [...items].sort((a, b) => {
        for (const sorter of activeSorters) {
            const field = getFieldsForTab(currentTab).find(f => f.key === sorter.key);
            if (!field) continue;

            const av = getFieldValue(a, field);
            const bv = getFieldValue(b, field);

            const aMissing = av == null || av === undefined;
            const bMissing = bv == null || bv === undefined;

            // Missing values always go to bottom regardless of direction
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
// Render the active sorters box
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

        // Drag handle + label
        const label = document.createElement('span');
        label.className = 'sorter-label';
        label.textContent = sorter.label;

        // Average badge
        const avg = document.createElement('span');
        avg.className = 'sorter-avg';
        avg.textContent = `avg: ${computeAverage(sorter)}`;

        // Direction toggle
        const dirBtn = document.createElement('button');
        dirBtn.className = 'sorter-dir-btn';
        dirBtn.textContent = sorter.dir === 'asc' ? '↑ Asc' : '↓ Desc';
        dirBtn.title = 'Toggle direction';
        dirBtn.onclick = () => {
            sorter.dir = sorter.dir === 'asc' ? 'desc' : 'asc';
            renderSorterBox();
            if (typeof filterItems === 'function') filterItems();
        };

        // Move up
        const upBtn = document.createElement('button');
        upBtn.className = 'sorter-move-btn';
        upBtn.textContent = '▲';
        upBtn.title = 'Move up';
        upBtn.disabled = idx === 0;
        upBtn.onclick = () => {
            [activeSorters[idx - 1], activeSorters[idx]] = [activeSorters[idx], activeSorters[idx - 1]];
            renderSorterBox();
            if (typeof filterItems === 'function') filterItems();
        };

        // Move down
        const downBtn = document.createElement('button');
        downBtn.className = 'sorter-move-btn';
        downBtn.textContent = '▼';
        downBtn.title = 'Move down';
        downBtn.disabled = idx === activeSorters.length - 1;
        downBtn.onclick = () => {
            [activeSorters[idx], activeSorters[idx + 1]] = [activeSorters[idx + 1], activeSorters[idx]];
            renderSorterBox();
            if (typeof filterItems === 'function') filterItems();
        };

        // Remove
        const removeBtn = document.createElement('button');
        removeBtn.className = 'sorter-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove sorter';
        removeBtn.onclick = () => {
            activeSorters.splice(idx, 1);
            renderSorterBox();
            if (typeof filterItems === 'function') filterItems();
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

// ---------------------------------------------------------------------------
// Average calculation across currently visible items
// ---------------------------------------------------------------------------

let _lastSorterItems = [];

function setSorterItems(items) {
    _lastSorterItems = items;
    renderSorterBox(); // refresh averages when data changes
}

function computeAverage(sorter) {
    const field = getFieldsForTab(currentTab).find(f => f.key === sorter.key);
    if (!field || _lastSorterItems.length === 0) return '—';

    const vals = _lastSorterItems
        .map(item => getFieldValue(item, field))
        .filter(v => v != null && typeof v === 'number');

    if (vals.length === 0) return '—';
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return avg >= 1000 ? avg.toLocaleString(undefined, { maximumFractionDigits: 0 }) : avg.toFixed(2);
}

// ---------------------------------------------------------------------------
// Picker popup
// ---------------------------------------------------------------------------

function openSorterPicker() {
    sorterPickerPending = activeSorters.map(s => s.key); // pre-tick already active

    const overlay = document.getElementById('sorterPickerOverlay');
    const list    = document.getElementById('sorterPickerList');
    const search  = document.getElementById('sorterPickerSearch');

    if (!overlay || !list) return;

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
    const fields = getFieldsForTab(currentTab);

    // Add newly ticked fields (preserve existing dir)
    sorterPickerPending.forEach(key => {
        if (!activeSorters.find(s => s.key === key)) {
            const field = fields.find(f => f.key === key);
            if (field) activeSorters.push({ ...field, dir: 'desc' });
        }
    });

    // Remove unticked fields
    activeSorters = activeSorters.filter(s => sorterPickerPending.includes(s.key));

    closeSorterPicker();
    renderSorterBox();
    if (typeof filterItems === 'function') filterItems();
}

function renderPickerList(query) {
    const list   = document.getElementById('sorterPickerList');
    const fields = getFieldsForTab(currentTab);
    const lq     = query.toLowerCase();

    list.innerHTML = '';

    fields
        .filter(f => f.label.toLowerCase().includes(lq))
        .forEach(field => {
            const row = document.createElement('div');
            row.className = 'sorter-picker-row';

            const checkbox = document.createElement('input');
            checkbox.type    = 'checkbox';
            checkbox.id      = `sp-${field.key}`;
            checkbox.checked = sorterPickerPending.includes(field.key);
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    sorterPickerPending.push(field.key);
                } else {
                    sorterPickerPending = sorterPickerPending.filter(k => k !== field.key);
                }
            };

            const label = document.createElement('label');
            label.htmlFor     = `sp-${field.key}`;
            label.textContent = field.label;

            row.appendChild(checkbox);
            row.appendChild(label);
            list.appendChild(row);
        });
}

// ---------------------------------------------------------------------------
// Tab change hook — call this from your switchTab function
// ---------------------------------------------------------------------------

function onSorterTabChange(tab) {
    currentTab    = tab;
    activeSorters = [];
    renderSorterBox();
}

// ---------------------------------------------------------------------------
// Global exports
// ---------------------------------------------------------------------------

window.applySorters       = applySorters;
window.renderSorterBox    = renderSorterBox;
window.setSorterItems     = setSorterItems;
window.openSorterPicker   = openSorterPicker;
window.closeSorterPicker  = closeSorterPicker;
window.confirmSorterPicker = confirmSorterPicker;
window.renderPickerList   = renderPickerList;
window.onSorterTabChange  = onSorterTabChange;
