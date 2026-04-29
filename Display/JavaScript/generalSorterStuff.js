// Sorter.js
// Builds sortable field lists from data actually present in:
//   ships.json    — ship base attributes (item.attributes.*)
//   variants.json — same structure as ships
//   outfits.json  — top-level numeric fields only (no attributes sub-object)
//
// Three sources of fields:
//   1. STATIC_FIELDS_SHIPS  — every numeric key that appears in item.attributes
//                             across all ships/variants in the real data
//   2. STATIC_FIELDS_OUTFITS — every top-level numeric key in outfits
//   3. HARDPOINT_FIELDS     — gun/turret/bay/engine port counts (ships/variants)
//
// Computed fields (getComputedStats) are kept for ship/variant tabs because
// ComputedStats.js accumulates installed outfits and derives effective stats.
//
// Multi-plugin: items carry _pluginId set by PluginManager.getMergedItems.
// getFieldValue() uses item._pluginId when calling getComputedStats.

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeSorters       = [];
let sorterCurrentTab    = 'ships';
let sorterPickerPending = [];
let _sorterItems        = [];
let _sorterAttrDefs     = null;
let _sorterPluginId     = null;

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
// Static field definitions — derived from scanning the actual JSON data files.
//
// SHIPS / VARIANTS: all numeric keys found under item.attributes across
// every ship and variant in ships.json + variants.json.
//
// OUTFITS: all top-level numeric keys found in outfits.json (outfits do NOT
// have an attributes sub-object; their stats live directly on the item).
// ---------------------------------------------------------------------------

const SHIP_ATTRIBUTE_KEYS = [
    'active cooling',
    'anchor point',
    'asteroid mount',
    'asteroid mount am',
    'asteroid mount jd',
    'asteroid scan power',
    'atmosphere scan',
    'atmospheric scan',
    'automaton',
    'bunks',
    'burn protection',
    'cargo capacity',
    'cargo scan efficiency',
    'cargo scan power',
    'cargo space',
    'cloak',
    'cloak phasing',
    'cloaked communication',
    'cloaked firing',
    'cloaked regen multiplier',
    'cloaked repair multiplier',
    'cloaked scanning',
    'cloaked shield permeability',
    'cloaking energy',
    'cloaking fuel',
    'cooling',
    'cooling energy',
    'core crystal',
    'corrosion protection',
    'corrosion resistance',
    'cost',
    'crew equivalent',
    'crystal projector',
    'delayed hull repair rate',
    'discharge protection',
    'disruption protection',
    'disruption resistance',
    'disruption resistance energy',
    'disruption resistance heat',
    'drag',
    'drill lock',
    'drill port',
    'drill spar',
    'energy capacity',
    'energy generation',
    'energy protection',
    'engine capacity',
    'force protection',
    'fuel capacity',
    'fuel generation',
    'fuel protection',
    'gaslining',
    'heat dissipation',
    'heat generation',
    'heat protection',
    'hull',
    'hull energy',
    'hull heat',
    'hull protection',
    'hull repair',
    'hull repair energy',
    'hull repair rate',
    'hyperdrive',
    'inscrutable',
    'ion protection',
    'ion resistance',
    'jump drive',
    'jump fuel',
    'jump speed',
    "ka'sei",
    'leak protection',
    'mass',
    'multimodal armor',
    'outfit scan efficiency',
    'outfit scan opacity',
    'outfit scan power',
    'outfit space',
    'overheat damage rate',
    'overheat damage threshold',
    'piercing protection',
    'quantum keystone',
    'radar jamming',
    'ramscoop',
    'remnant node',
    'repair delay',
    'required crew',
    'reverse thrust',
    'reverse thrusting energy',
    'reverse thrusting heat',
    'scan interference',
    'scram drive',
    'scramble protection',
    'scramble resistance',
    'scrambling resistance',
    'self destruct',
    'shield energy',
    'shield generation',
    'shield heat',
    'shield protection',
    'shields',
    'shooting star',
    'silent jumps',
    'slowing protection',
    'slowing resistance',
    'solar collection',
    'solar heat',
    'spinal mount',
    'tactical scan power',
    'threshold percentage',
    'thrust',
    'thrusting energy',
    'thrusting heat',
    'turn',
    'turning energy',
    'turning heat',
    'waterlining',
    'weapon capacity',
];

const OUTFIT_KEYS = [
    'active cooling',
    'afterburner energy',
    'afterburner fuel',
    'afterburner heat',
    'afterburner shields',
    'afterburner thrust',
    'anchor point',
    'asteroid mount',
    'asteroid mount 2',
    'asteroid mount 3',
    'asteroid mount 4',
    'asteroid mount am',
    'asteroid mount jd',
    'asteroid mount small',
    'asteroid scan power',
    'atmosphere scan',
    'automaton',
    'bunks',
    'capture attack',
    'capture defense',
    'cargo scan efficiency',
    'cargo scan opacity',
    'cargo scan power',
    'cargo space',
    'cloak',
    'cloaked regen multiplier',
    'cloaked repair multiplier',
    'cloaking energy',
    'cloaking fuel',
    'cooling',
    'cooling energy',
    'cooling inefficiency',
    'core crystal',
    'corrosion protection',
    'cost',
    'crystal projector',
    'delayed shield energy',
    'delayed shield generation',
    'delayed shield heat',
    'depleted shield delay',
    'disruption protection',
    'drag',
    'drag reduction',
    'drill lock',
    'drill port',
    'drill spar',
    'emp torpedo capacity',
    'energy capacity',
    'energy consumption',
    'energy generation',
    'engine capacity',
    'finisher capacity',
    'firelight missile capacity',
    'firestorm torpedo capacity',
    'flotsam chance',
    'force protection',
    'fuel capacity',
    'fuel generation',
    'fuel protection',
    'gatling round capacity',
    'gun ports',
    'heat capacity',
    'heat dissipation',
    'heat generation',
    'holographic entertainment',
    'hull energy',
    'hull energy multiplier',
    'hull heat',
    'hull protection',
    'hull repair multiplier',
    'hull repair rate',
    'hyperdrive',
    'illegal',
    'inertia reduction',
    'inscrutable',
    'ion protection',
    'ion resistance',
    'javelin capacity',
    'jump drive',
    'jump fuel',
    'jump range',
    'jump speed',
    'lasing power',
    'magnetic nozzle',
    'mass',
    'meteor capacity',
    'minelayer capacity',
    'multimodal armor',
    'nanite upgrades',
    'nettle capacity',
    'operating costs',
    'ophrys capacity',
    'optical jamming',
    'orchid capacity',
    'outfit scan efficiency',
    'outfit scan opacity',
    'outfit scan power',
    'outfit space',
    'overheat damage rate',
    'piercer capacity',
    'piercing protection',
    'quantum keystone',
    'radar jamming',
    'railgun slug capacity',
    'ramscoop',
    'reactor upgrades',
    'relay upgrades',
    'required crew',
    'reverse thrust',
    'reverse thrusting energy',
    'reverse thrusting heat',
    'rocket capacity',
    'scan brightness',
    'scan interference',
    'scram drive',
    'scramble resistance',
    'shield connection point',
    'shield delay',
    'shield energy',
    'shield energy multiplier',
    'shield fuel',
    'shield generation',
    'shield generation multiplier',
    'shield heat',
    'shield protection',
    'shooting star',
    'sidewinder capacity',
    'slowing protection',
    'slowing resistance',
    'solar cell',
    'solar collection',
    'solar heat',
    'speck capacity',
    'spike capacity',
    'spinal mount',
    'star tail capacity',
    'swarm capacity',
    'tactical scan power',
    'teciimach canister capacity',
    'thrust',
    'thrusting energy',
    'thrusting fuel',
    'thrusting heat',
    'thunderhead capacity',
    'torpedo capacity',
    'tracker capacity',
    'turn',
    'turning energy',
    'turning heat',
    'turret mounts',
    'typhoon capacity',
    'unique',
    'unplunderable',
    'weapon capacity',
];

// ---------------------------------------------------------------------------
// Hardpoint counts — ships/variants only, derived from array lengths
// ---------------------------------------------------------------------------

const HARDPOINT_FIELDS = [
    { id: '_gunCount',            label: 'Gun Ports',          fn: i => (i.guns            || []).length },
    { id: '_turretCount',         label: 'Turret Ports',       fn: i => (i.turrets         || []).length },
    { id: '_bayCount',            label: 'Bay Count',          fn: i => (i.bays            || []).length },
    { id: '_engineCount',         label: 'Engine Points',      fn: i => (i.engines         || []).length },
    { id: '_reverseEngineCount',  label: 'Reverse Eng. Points',fn: i => (i.reverseEngines  || []).length },
    { id: '_steeringEngineCount', label: 'Steering Eng. Points',fn: i => (i.steeringEngines || []).length },
];

// ---------------------------------------------------------------------------
// Field building
// ---------------------------------------------------------------------------

/**
 * Build computed fields from ComputedStats.js (ship/variant tabs only).
 * These call getComputedStats() and reflect installed outfits.
 */
function buildComputedFields() {
    if (typeof getComputedSorterFields !== 'function') return [];
    return getComputedSorterFields().map(f => ({ ...f, useComputed: true }));
}

/**
 * Master field builder for a given tab.
 *
 * Ships / Variants:
 *   - Base attribute fields from SHIP_ATTRIBUTE_KEYS  (path: ['attributes', key])
 *   - Computed fields from getComputedSorterFields()
 *   - Hardpoint count pseudo-fields
 *
 * Outfits:
 *   - Top-level numeric fields from OUTFIT_KEYS  (path: [key])
 *   No computed fields — ComputedStats only models ships.
 *
 * Effects:
 *   - Scanned dynamically from the live item list (effects have no fixed schema).
 */
function buildFieldsForTab(tab, items) {
    const isShipLike = tab === 'ships' || tab === 'variants';
    const allFields  = [];
    const seenIds    = new Set();

    const addField = (f) => {
        if (!seenIds.has(f.id)) {
            allFields.push(f);
            seenIds.add(f.id);
        }
    };

    if (isShipLike) {
        // ── Base attributes (item.attributes.key) ────────────────────────────
        for (const key of SHIP_ATTRIBUTE_KEYS) {
            const id    = 'raw_attr_' + keyToId(key);
            const label = toTitleCase(key) + ' (base)';
            addField({ id, key, label, path: ['attributes', key], raw: true });
        }

        // ── Computed fields (with outfit accumulation) ───────────────────────
        for (const f of buildComputedFields()) {
            addField(f);
        }

        // ── Hardpoint counts ─────────────────────────────────────────────────
        for (const { id, label, fn } of HARDPOINT_FIELDS) {
            addField({ id, key: id, label, computed: fn });
        }

    } else if (tab === 'outfits') {
        // ── Top-level outfit fields (item.key) ───────────────────────────────
        for (const key of OUTFIT_KEYS) {
            const id    = 'raw_' + keyToId(key);
            const label = toTitleCase(key);
            addField({ id, key, label, path: [key], raw: true });
        }

    } else {
        // ── Effects or unknown tab: scan the live items ──────────────────────
        if (items && items.length > 0) {
            for (const item of items) {
                for (const [key, val] of Object.entries(item)) {
                    if (typeof val !== 'number') continue;
                    if (key.startsWith('_'))     continue;
                    const id = 'raw_' + keyToId(key);
                    if (seenIds.has(id)) continue;
                    addField({ id, key, label: toTitleCase(key), path: [key], raw: true });
                }
            }
        }
    }

    // Sort: computed fields first (grouped), then alphabetical within each group
    allFields.sort((a, b) => {
        const aComp = !!(a.isComputed || a.computed);
        const bComp = !!(b.isComputed || b.computed);
        if (aComp !== bComp) return aComp ? -1 : 1;
        return a.label.localeCompare(b.label);
    });

    return allFields;
}

// ---------------------------------------------------------------------------
// Field cache
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
    clearFieldCache();
    if (typeof clearComputedCache === 'function') clearComputedCache();
}

function setSorterItems(items) {
    _sorterItems = items || [];
    // Invalidate the effects cache only — ships/outfits use static lists
    if (sorterCurrentTab !== 'ships' && sorterCurrentTab !== 'variants' && sorterCurrentTab !== 'outfits') {
        delete _fieldCache[sorterCurrentTab];
    }
    renderSorterBox();
}

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

/**
 * Resolution order:
 *  1. field.computed(item)              — hardpoint count lambdas
 *  2. getComputedStats(item, pluginId)  — derived/fn stats with outfit accumulation
 *  3. Walk field.path on raw item       — base attributes or top-level keys
 */
function getFieldValue(item, field) {
    // 1. Inline computed (port counts etc.)
    if (field.computed) return field.computed(item);

    // 2. Computed stats (uses getComputedStats with outfit accumulation)
    if ((field.isComputed || field.useComputed) && typeof getComputedStats === 'function') {
        const pluginId = item._pluginId || _sorterPluginId;
        if (pluginId) {
            const stats = getComputedStats(item, pluginId);
            const val   = stats?.[field.key];
            if (val !== undefined && val !== null) return val;
        }
    }

    // 3. Walk the path on the raw item
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

    for (const id of sorterPickerPending) {
        if (!activeSorters.find(s => s.id === id)) {
            const field = fields.find(f => f.id === id);
            if (field) {
                activeSorters.push({
                    id:          field.id,
                    key:         field.key,
                    label:       field.label,
                    path:        field.path     || null,
                    computed:    field.computed  || null,
                    useComputed: field.useComputed || false,
                    isComputed:  field.isComputed  || false,
                    dir:         'desc',
                });
            }
        }
    }

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
            (f.key && f.key.toLowerCase().includes(lq)))
        : fields;

    if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:0.9rem;padding:8px;';
        empty.textContent   = 'No matching fields.';
        list.appendChild(empty);
        return;
    }

    const computedFields = filtered.filter(f => f.isComputed || f.computed);
    const rawFields      = filtered.filter(f => !f.isComputed && !f.computed);

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

        for (const field of groupFields) {
            const row = document.createElement('div');
            row.className = 'sorter-picker-row';

            const checkbox    = document.createElement('input');
            checkbox.type     = 'checkbox';
            checkbox.id       = `sp-${field.id}`;
            checkbox.checked  = sorterPickerPending.includes(field.id);
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    if (!sorterPickerPending.includes(field.id)) sorterPickerPending.push(field.id);
                } else {
                    sorterPickerPending = sorterPickerPending.filter(id => id !== field.id);
                }
            };

            const lbl       = document.createElement('label');
            lbl.htmlFor     = `sp-${field.id}`;
            lbl.textContent = field.label;

            row.onclick = (e) => { if (e.target !== checkbox) checkbox.click(); };
            row.appendChild(checkbox);
            row.appendChild(lbl);
            list.appendChild(row);
        }
    };

    renderGroup(computedFields, computedFields.length > 0 ? '⚡ Computed (with outfits)' : null);
    renderGroup(rawFields,      rawFields.length > 0      ? 'Base / Raw Attributes'      : null);
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
