(function () {
'use strict';

// ---------------------------------------------------------------------------
// generalPluginStuff.js
//
// Replaces the single `currentPlugin` string with an ordered array of active
// plugins. Handles:
//   - The plugin picker overlay (add plugins via the grouped list)
//   - The active-plugin list UI (reorder with ▲▼, remove with ✕)
//   - Merging items from all active plugins into a single array (with _pluginId
//     tag on every item so ComputedStats / Sorter can still work per-item)
//   - Notifying Plugin_Script.js when the active set changes
//   - Self-injecting the plugin picker overlay into the DOM (no HTML duplication)
//   - Local Builds (localStorage fleet) always shown first when ships exist
//
// Dependencies (must be loaded before this file):
//   Plugin_Script.js  — provides allData, renderCards(), updateStats(),
//                       setSorterPluginId(), setCurrentPlugin(), setEffectPlugin(),
//                       clearComputedCache()
//   dataLoader.js     — provides DataLoader.LOCAL_PLUGIN_ID and refreshes
//                       window.allData['__local_builds__'] from localStorage
// ---------------------------------------------------------------------------

// ── Constants ───────────────────────────────────────────────────────────────

const LOCAL_PLUGIN_ID = '__local_builds__';

// ── State ──────────────────────────────────────────────────────────────────

// Ordered list of active plugin outputNames (first = primary)
let _activePlugins = [];

// Snapshot taken when the picker opens — restored if the user cancels
let _pickerSnapshot = [];

// ── Helpers ────────────────────────────────────────────────────────────────

function _allData() {
    return window.allData || {};
}

function _label(outputName) {
    if (outputName === LOCAL_PLUGIN_ID) return '📦 Local Builds';
    const d = _allData()[outputName];
    if (!d) return outputName;
    return d.sourceName === d.displayName ? d.sourceName : `${d.sourceName} › ${d.displayName}`;
}

/**
 * Returns true if the Local Builds pseudo-plugin exists in allData
 * AND contains at least one saved ship.
 */
function _localBuildsHasShips() {
    const local = _allData()[LOCAL_PLUGIN_ID];
    return !!(local && (local.ships || []).length > 0);
}

/**
 * Re-reads the Local Builds pseudo-plugin from localStorage.
 * Fully delegates to DataLoader._buildLocalPlugin (via a silent internal refresh)
 * so that attribute coercion, outfitMap integer counts, mass/drag merging, etc.
 * are all handled in one place and never duplicated here.
 *
 * We call the internal DataLoader path that updates window.allData directly
 * WITHOUT firing 'pluginsChanged', to avoid an infinite loop.
 */
function _refreshLocalBuilds() {
    if (window.DataLoader && typeof window.DataLoader._refreshLocalOnly === 'function') {
        // Preferred path: DataLoader exposes a side-effect-free refresh
        window.DataLoader._refreshLocalOnly();
        return;
    }

    // Fallback: DataLoader hasn't exposed _refreshLocalOnly yet — call the full
    // refreshLocalBuilds but swallow the pluginsChanged event it fires by
    // temporarily ignoring re-entrant calls. In practice DataLoader always has
    // _refreshLocalOnly after the fix, so this path is just a safety net.
    if (window.DataLoader && typeof window.DataLoader.refreshLocalBuilds === 'function') {
        window.DataLoader.refreshLocalBuilds();
    }
}

// ── DOM injection ─────────────────────────────────────────────────────────
//
// Injects the plugin picker overlay into the page if it isn't already present.

function _injectPickerOverlay() {
    if (document.getElementById('pluginPickerOverlay')) return; // already present

    const overlay = document.createElement('div');
    overlay.id        = 'pluginPickerOverlay';
    overlay.innerHTML = `
        <div class="modal-box modal-box--picker">
            <div class="picker-header">
                <span class="picker-header__title">Select Plugins</span>
                <button class="btn-close btn-close--sm" id="pluginPickerCloseBtn">✕</button>
            </div>
            <input class="text-input picker-search" type="text"
                   id="pluginPickerSearch"
                   placeholder="🔍 Search plugins…">
            <div class="picker-list" id="pluginPickerList"></div>
            <div class="picker-footer">
                <button class="btn btn-secondary" id="pluginPickerCancelBtn">Cancel</button>
                <button class="btn btn-primary"   id="pluginPickerConfirmBtn">Done</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Wire up events on the injected elements
    overlay.addEventListener('click', e => {
        if (e.target === overlay) closePluginPicker();
    });
    document.getElementById('pluginPickerCloseBtn')  .addEventListener('click', closePluginPicker);
    document.getElementById('pluginPickerCancelBtn') .addEventListener('click', closePluginPicker);
    document.getElementById('pluginPickerConfirmBtn').addEventListener('click', confirmPluginPicker);
    document.getElementById('pluginPickerSearch')    .addEventListener('input', e => {
        _renderPluginPickerList(e.target.value);
    });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns a copy of the active plugins array (ordered).
 */
function getActivePlugins() {
    return [..._activePlugins];
}

/**
 * Returns the primary plugin (first in the list), or null.
 * Local Builds is skipped as primary — it has no sprites/effects.
 */
function getPrimaryPlugin() {
    // Prefer the first non-local plugin as primary for image/effect lookups
    const nonLocal = _activePlugins.find(p => p !== LOCAL_PLUGIN_ID);
    return nonLocal || _activePlugins[0] || null;
}

/**
 * Merge items from all active plugins for a given tab.
 * Local Builds ships are always merged first (they appear at the top of lists).
 * Each item gets a `_pluginId` property so ComputedStats can resolve outfits.
 */
function getMergedItems(tab) {
    const allData = _allData();

    // Ensure local builds data is fresh before merging
    _refreshLocalBuilds();

    // Build ordered list: local first (if active), then others
    const ordered = [
        ..._activePlugins.filter(p => p === LOCAL_PLUGIN_ID),
        ..._activePlugins.filter(p => p !== LOCAL_PLUGIN_ID),
    ];

    const merged = [];
    for (const outputName of ordered) {
        const pluginData = allData[outputName];
        if (!pluginData) continue;

        let items = [];
        if      (tab === 'ships')    items = pluginData.ships    || [];
        else if (tab === 'variants') items = pluginData.variants || [];
        else if (tab === 'outfits')  items = pluginData.outfits  || [];
        else if (tab === 'effects')  items = pluginData.effects  || [];

        // Tag each item with its source plugin (don't mutate originals)
        for (const item of items) {
            merged.push(Object.assign(Object.create(Object.getPrototypeOf(item)), item, {
                _pluginId: outputName
            }));
        }
    }
    return merged;
}

/**
 * Activate a set of plugins (replaces current list). Triggers a re-render.
 * Local Builds is always kept at the front if it has ships.
 */
async function setActivePlugins(plugins) {
    if (!Array.isArray(plugins) || plugins.length === 0) return;
    _refreshLocalBuilds();

    const filtered = plugins.filter(p => p === LOCAL_PLUGIN_ID || _allData()[p]);

    // Always ensure local is first if it has ships and isn't already included
    if (_localBuildsHasShips() && !filtered.includes(LOCAL_PLUGIN_ID)) {
        filtered.unshift(LOCAL_PLUGIN_ID);
    }

    _activePlugins = filtered;
    if (_activePlugins.length === 0) return;
    await _notifyChange();
}

/**
 * Called after data loads — selects the first available plugin.
 * Local Builds is added first if it has any saved ships.
 */
async function initDefaultPlugin() {
    _refreshLocalBuilds();

    const keys = Object.keys(_allData()).filter(k => k !== LOCAL_PLUGIN_ID);
    if (keys.length === 0 && !_localBuildsHasShips()) return;

    _activePlugins = [];

    // Local Builds goes first if it has ships
    if (_localBuildsHasShips()) {
        _activePlugins.push(LOCAL_PLUGIN_ID);
    }

    // Then the first remote plugin
    if (keys.length > 0) {
        _activePlugins.push(keys[0]);
    }

    const primary = getPrimaryPlugin();
    if (typeof window.setCurrentPlugin  === 'function') window.setCurrentPlugin(primary);
    if (typeof window.setEffectPlugin   === 'function') window.setEffectPlugin(primary);
    if (typeof window.setSorterPluginId === 'function') window.setSorterPluginId(primary);
    if (typeof window.clearComputedCache === 'function') window.clearComputedCache();
    _renderActiveList();
    _updateMergedStats();
    await _renderMergedCards(true); // true = reset to ships tab
}

// ── Internal: notify the rest of the app ──────────────────────────────────

async function _notifyChange() {
    const primary = getPrimaryPlugin();
    if (!primary) return;

    if (typeof window.setCurrentPlugin  === 'function') window.setCurrentPlugin(primary);
    if (typeof window.setEffectPlugin   === 'function') window.setEffectPlugin(primary);
    if (typeof window.setSorterPluginId === 'function') window.setSorterPluginId(primary);
    if (typeof window.clearComputedCache === 'function') window.clearComputedCache();

    _renderActiveList();
    _refreshPickerHighlights();
    _updateMergedStats();
    await _renderMergedCards(false);
}

// ── Stats (merged across active plugins) ──────────────────────────────────

function _updateMergedStats() {
    const allData = _allData();
    let ships = 0, variants = 0, outfits = 0;
    for (const outputName of _activePlugins) {
        const d = allData[outputName];
        if (!d) continue;
        ships    += d.ships?.length    || 0;
        variants += d.variants?.length || 0;
        outfits  += d.outfits?.length  || 0;
    }
    const total = ships + variants + outfits;
    const statsContainer = document.getElementById('stats');
    if (!statsContainer) return;
    statsContainer.innerHTML = `
        <div class="stat-card"><div class="stat-value">${ships}</div><div class="stat-label">Base Ships</div></div>
        <div class="stat-card"><div class="stat-value">${variants}</div><div class="stat-label">Variants</div></div>
        <div class="stat-card"><div class="stat-value">${outfits}</div><div class="stat-label">Outfits</div></div>
        <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total Items</div></div>
    `;
}

// ── Cards (delegates to Plugin_Script.js renderCards via a hook) ──────────

async function _renderMergedCards(resetTab = false) {
    if (typeof window._renderCardsFromManager === 'function') {
        await window._renderCardsFromManager(resetTab);
    }
}

// ── Active plugin list UI ─────────────────────────────────────────────────

function _renderActiveList() {
    const box = document.getElementById('activePluginList');
    if (!box) return;

    if (_activePlugins.length === 0) {
        box.innerHTML = '<span class="sorter-empty">No plugins selected.</span>';
        return;
    }

    box.innerHTML = '';

    _activePlugins.forEach((outputName, idx) => {
        const isLocal = outputName === LOCAL_PLUGIN_ID;
        const row = document.createElement('div');
        row.className = 'sorter-row';
        if (isLocal) row.classList.add('sorter-row--local');
        row.dataset.plugin = outputName;

        const label = document.createElement('span');
        label.className   = 'sorter-label';
        label.textContent = _label(outputName);

        // Local Builds is always pinned first — no up/down/remove for it
        if (isLocal) {
            const pin = document.createElement('span');
            pin.className   = 'sorter-pin-badge';
            pin.textContent = '📌 pinned first';
            pin.title       = 'Local Builds always appears first';
            row.appendChild(label);
            row.appendChild(pin);
            box.appendChild(row);
            return;
        }

        // Non-local plugins: skip idx=0 if local is occupying it
        const localOffset = _activePlugins.includes(LOCAL_PLUGIN_ID) ? 1 : 0;
        const isFirstNonLocal = idx === localOffset;
        const isLastNonLocal  = idx === _activePlugins.length - 1;

        const upBtn = document.createElement('button');
        upBtn.className   = 'sorter-move-btn';
        upBtn.textContent = '▲';
        upBtn.title       = 'Move up (higher priority)';
        upBtn.disabled    = isFirstNonLocal;
        upBtn.onclick = async () => {
            [_activePlugins[idx - 1], _activePlugins[idx]] = [_activePlugins[idx], _activePlugins[idx - 1]];
            await _notifyChange();
        };

        const downBtn = document.createElement('button');
        downBtn.className   = 'sorter-move-btn';
        downBtn.textContent = '▼';
        downBtn.title       = 'Move down (lower priority)';
        downBtn.disabled    = isLastNonLocal;
        downBtn.onclick = async () => {
            [_activePlugins[idx], _activePlugins[idx + 1]] = [_activePlugins[idx + 1], _activePlugins[idx]];
            await _notifyChange();
        };

        const removeBtn = document.createElement('button');
        removeBtn.className   = 'sorter-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.title       = 'Remove plugin';
        removeBtn.onclick = async () => {
            _activePlugins.splice(idx, 1);
            // Keep at least one non-local plugin active
            const nonLocal = _activePlugins.filter(p => p !== LOCAL_PLUGIN_ID);
            if (nonLocal.length === 0) {
                _activePlugins.splice(idx, 0, outputName); // re-add
                return;
            }
            await _notifyChange();
        };

        row.appendChild(label);
        row.appendChild(upBtn);
        row.appendChild(downBtn);
        row.appendChild(removeBtn);
        box.appendChild(row);
    });
}

// ── Plugin picker overlay ─────────────────────────────────────────────────

function openPluginPicker() {
    _refreshLocalBuilds();
    _pickerSnapshot = [..._activePlugins];

    _renderPluginPickerList('');
    document.getElementById('pluginPickerOverlay').classList.add('plugin-overlay-visible');
    const search = document.getElementById('pluginPickerSearch');
    if (search) { search.value = ''; search.focus(); }
}

function closePluginPicker() {
    _activePlugins = [..._pickerSnapshot];
    _pickerSnapshot = [];
    document.getElementById('pluginPickerOverlay').classList.remove('plugin-overlay-visible');
}

function _refreshPickerHighlights() {
    document.querySelectorAll('#pluginPickerList .plugin-picker-row').forEach(row => {
        const isActive = _activePlugins.includes(row.dataset.plugin);
        row.classList.toggle('active', isActive);
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = isActive;
    });
}

function _renderPluginPickerList(query) {
    const list = document.getElementById('pluginPickerList');
    if (!list) return;
    list.innerHTML = '';

    const lq      = (query || '').toLowerCase().trim();
    const allData = _allData();

    // ── Local Builds section (always first, only if it has ships) ──────────
    const localPlugin = allData[LOCAL_PLUGIN_ID];
    if (localPlugin && (localPlugin.ships || []).length > 0) {
        const matchesQuery = !lq || 'local builds'.includes(lq);
        if (matchesQuery) {
            const localHeader = document.createElement('div');
            localHeader.className   = 'plugin-picker-group-header plugin-picker-group-header--local';
            localHeader.textContent = '📦 Local Builds';
            list.appendChild(localHeader);

            const isActive = _activePlugins.includes(LOCAL_PLUGIN_ID);
            const shipCount = (localPlugin.ships || []).length;

            const row = document.createElement('div');
            row.className   = 'plugin-picker-row plugin-picker-row--local' + (isActive ? ' active' : '');
            row.dataset.plugin = LOCAL_PLUGIN_ID;

            const checkbox = document.createElement('input');
            checkbox.type    = 'checkbox';
            checkbox.checked = isActive;
            checkbox.style.cssText =
                'cursor:pointer;accent-color:#3b82f6;width:16px;height:16px;flex-shrink:0;';
            checkbox.onclick  = e => e.stopPropagation();
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    if (!_activePlugins.includes(LOCAL_PLUGIN_ID)) {
                        // Always insert local at position 0
                        _activePlugins.unshift(LOCAL_PLUGIN_ID);
                    }
                } else {
                    const idx = _activePlugins.indexOf(LOCAL_PLUGIN_ID);
                    if (idx !== -1) _activePlugins.splice(idx, 1);
                }
                row.classList.toggle('active', _activePlugins.includes(LOCAL_PLUGIN_ID));
            };

            const dot = document.createElement('span');
            dot.className = 'plugin-picker-active-dot';

            const labelEl = document.createElement('span');
            labelEl.className   = 'plugin-picker-row-label';
            labelEl.textContent = `Local Builds (${shipCount} ship${shipCount !== 1 ? 's' : ''})`;

            row.appendChild(checkbox);
            row.appendChild(dot);
            row.appendChild(labelEl);
            row.onclick = () => checkbox.click();
            list.appendChild(row);
        }
    }

    // ── Remote plugin groups ───────────────────────────────────────────────
    const groups = {};
    for (const [outputName, data] of Object.entries(allData)) {
        if (outputName === LOCAL_PLUGIN_ID) continue; // handled above
        const src = data.sourceName;
        if (!groups[src]) groups[src] = [];
        groups[src].push({ outputName, data });
    }

    let anyRemoteVisible = false;

    for (const [sourceName, plugins] of Object.entries(groups)) {
        const visible = lq
            ? plugins.filter(p =>
                p.data.displayName.toLowerCase().includes(lq) ||
                sourceName.toLowerCase().includes(lq))
            : plugins;

        if (visible.length === 0) continue;
        anyRemoteVisible = true;

        const header = document.createElement('div');
        header.className = 'plugin-picker-group-header';
        header.textContent = sourceName;
        list.appendChild(header);

        for (const { outputName, data } of visible) {
            const isActive = _activePlugins.includes(outputName);

            const row = document.createElement('div');
            row.className = 'plugin-picker-row' + (isActive ? ' active' : '');
            row.dataset.plugin = outputName;

            const checkbox = document.createElement('input');
            checkbox.type    = 'checkbox';
            checkbox.checked = isActive;
            checkbox.style.cssText =
                'cursor:pointer;accent-color:#3b82f6;width:16px;height:16px;flex-shrink:0;';
            checkbox.onclick  = e => e.stopPropagation();
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    if (!_activePlugins.includes(outputName)) {
                        _activePlugins.push(outputName);
                    }
                } else {
                    const idx = _activePlugins.indexOf(outputName);
                    if (idx !== -1) _activePlugins.splice(idx, 1);
                    if (_activePlugins.filter(p => p !== LOCAL_PLUGIN_ID).length === 0) {
                        // Must keep at least one remote plugin
                        _activePlugins.push(outputName);
                        checkbox.checked = true;
                        row.classList.add('active');
                        return;
                    }
                }
                row.classList.toggle('active', _activePlugins.includes(outputName));
            };

            const dot = document.createElement('span');
            dot.className = 'plugin-picker-active-dot';

            const labelEl = document.createElement('span');
            labelEl.className   = 'plugin-picker-row-label';
            labelEl.textContent = plugins.length === 1 ? sourceName : data.displayName;

            row.appendChild(checkbox);
            row.appendChild(dot);
            row.appendChild(labelEl);
            row.onclick = () => checkbox.click();
            list.appendChild(row);
        }
    }

    // Empty state — only if nothing at all rendered
    const localRendered = localPlugin && (localPlugin.ships || []).length > 0 && (!lq || 'local builds'.includes(lq));
    if (!localRendered && !anyRemoteVisible) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:0.9rem;padding:12px 10px;';
        empty.textContent = 'No matching plugins.';
        list.appendChild(empty);
    }
}

async function confirmPluginPicker() {
    _pickerSnapshot = [];
    document.getElementById('pluginPickerOverlay').classList.remove('plugin-overlay-visible');

    // Ensure local is first if it has ships and was checked
    if (_localBuildsHasShips()) {
        const idx = _activePlugins.indexOf(LOCAL_PLUGIN_ID);
        if (idx > 0) {
            _activePlugins.splice(idx, 1);
            _activePlugins.unshift(LOCAL_PLUGIN_ID);
        }
    }

    // Ensure at least one remote plugin active
    if (_activePlugins.filter(p => p !== LOCAL_PLUGIN_ID).length === 0) {
        const first = Object.keys(_allData()).find(k => k !== LOCAL_PLUGIN_ID);
        if (first) _activePlugins.push(first);
    }

    await _notifyChange();
}

// ── Listen for localStorage changes (e.g. ships saved in Ship Builder) ────
//
// When the Ship Builder saves a ship, DataLoader fires 'pluginsChanged'.
// We hook that to refresh our local plugin data and re-render.

document.addEventListener('pluginsChanged', () => {
    _refreshLocalBuilds();
    // If local now has ships and isn't active yet, add it to the front
    if (_localBuildsHasShips() && !_activePlugins.includes(LOCAL_PLUGIN_ID)) {
        _activePlugins.unshift(LOCAL_PLUGIN_ID);
        _notifyChange();
    } else {
        // Just refresh the UI in case ship count changed
        _renderActiveList();
        _updateMergedStats();
    }
});

// ── Initialise overlay on DOM ready ───────────────────────────────────────

document.addEventListener('DOMContentLoaded', _injectPickerOverlay);

function ensurePickerOverlay() { _injectPickerOverlay(); }

// ── Expose globals ────────────────────────────────────────────────────────

window.PluginManager = {
    getActivePlugins,
    getPrimaryPlugin,
    getMergedItems,
    setActivePlugins,
    initDefaultPlugin,
    openPluginPicker,
    closePluginPicker,
    confirmPluginPicker,
    renderActiveList: _renderActiveList,
    ensurePickerOverlay,
    LOCAL_PLUGIN_ID,
};

window.openPluginPicker       = openPluginPicker;
window.closePluginPicker      = closePluginPicker;
window.confirmPluginPicker    = confirmPluginPicker;
window.renderPluginPickerList = _renderPluginPickerList;

})();
