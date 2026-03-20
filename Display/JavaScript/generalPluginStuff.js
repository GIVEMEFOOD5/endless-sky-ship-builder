(function () {
'use strict';

// ---------------------------------------------------------------------------
// PluginManager.js
//
// Replaces the single `currentPlugin` string with an ordered array of active
// plugins. Handles:
//   - The plugin picker overlay (add plugins via the grouped list)
//   - The active-plugin list UI (reorder with ▲▼, remove with ✕)
//   - Merging items from all active plugins into a single array (with _pluginId
//     tag on every item so ComputedStats / Sorter can still work per-item)
//   - Notifying Plugin_Script.js when the active set changes
//
// Dependencies (must be loaded before this file):
//   Plugin_Script.js  — provides allData, renderCards(), updateStats(),
//                       setSorterPluginId(), setCurrentPlugin(), setEffectPlugin(),
//                       clearComputedCache()
// ---------------------------------------------------------------------------

// ── State ──────────────────────────────────────────────────────────────────

// Ordered list of active plugin outputNames (first = primary)
let _activePlugins = [];

// ── Helpers ────────────────────────────────────────────────────────────────

function _allData() {
    return window.allData || {};
}

function _label(outputName) {
    const d = _allData()[outputName];
    if (!d) return outputName;
    return d.sourceName === d.displayName ? d.sourceName : `${d.sourceName} › ${d.displayName}`;
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
 */
function getPrimaryPlugin() {
    return _activePlugins[0] || null;
}

/**
 * Merge items from all active plugins for a given tab.
 * Each item gets a `_pluginId` property so ComputedStats can resolve outfits.
 * Items from earlier plugins in the list come first.
 */
function getMergedItems(tab) {
    const allData = _allData();
    const merged = [];
    for (const outputName of _activePlugins) {
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
 * If plugins is empty, does nothing.
 */
async function setActivePlugins(plugins) {
    if (!Array.isArray(plugins) || plugins.length === 0) return;
    _activePlugins = plugins.filter(p => _allData()[p]);
    if (_activePlugins.length === 0) return;
    await _notifyChange();
}

/**
 * Called after data loads — selects the first available plugin.
 */
async function initDefaultPlugin() {
    const keys = Object.keys(_allData());
    if (keys.length === 0) return;
    _activePlugins = [keys[0]];
    // First load: reset to ships tab
    const primary = getPrimaryPlugin();
    if (typeof window.setCurrentPlugin === 'function') window.setCurrentPlugin(primary);
    if (typeof window.setEffectPlugin  === 'function') window.setEffectPlugin(primary);
    if (typeof window.setSorterPluginId === 'function') window.setSorterPluginId(primary);
    if (typeof window.clearComputedCache === 'function') window.clearComputedCache();
    _renderActiveList();
    _updateMergedStats();
    await _renderMergedCards(true); // true = reset to ships tab
}
}

// ── Internal: notify the rest of the app ──────────────────────────────────

async function _notifyChange() {
    const primary = getPrimaryPlugin();
    if (!primary) return;

    // Image / effect grabbers use the primary plugin for index priority
    if (typeof window.setCurrentPlugin === 'function') window.setCurrentPlugin(primary);
    if (typeof window.setEffectPlugin  === 'function') window.setEffectPlugin(primary);

    // Sorter: primary plugin used when no per-item _pluginId available
    if (typeof window.setSorterPluginId === 'function') window.setSorterPluginId(primary);

    // Clear computed-stats cache so stale cross-plugin data doesn't linger
    if (typeof window.clearComputedCache === 'function') window.clearComputedCache();

    // Update the active-plugin label area
    _renderActiveList();

    // Refresh picker list highlights if open
    _refreshPickerHighlights();

    // Update stats bar and re-render cards (preserve current tab)
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
    // Plugin_Script.renderCards() will call getMergedItems() instead of
    // allData[currentPlugin][tab] — see the patched renderCards() below.
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
        const row = document.createElement('div');
        row.className = 'sorter-row';
        row.dataset.plugin = outputName;

        const label = document.createElement('span');
        label.className   = 'sorter-label';
        label.textContent = _label(outputName);

        const upBtn = document.createElement('button');
        upBtn.className   = 'sorter-move-btn';
        upBtn.textContent = '▲';
        upBtn.title       = 'Move up (higher priority)';
        upBtn.disabled    = idx === 0;
        upBtn.onclick = async () => {
            [_activePlugins[idx - 1], _activePlugins[idx]] = [_activePlugins[idx], _activePlugins[idx - 1]];
            await _notifyChange();
        };

        const downBtn = document.createElement('button');
        downBtn.className   = 'sorter-move-btn';
        downBtn.textContent = '▼';
        downBtn.title       = 'Move down (lower priority)';
        downBtn.disabled    = idx === _activePlugins.length - 1;
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
            if (_activePlugins.length === 0) {
                // Keep at least one plugin — re-add the removed one
                _activePlugins = [outputName];
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
    _renderPluginPickerList('');
    document.getElementById('pluginPickerOverlay').classList.add('plugin-overlay-visible');
    const search = document.getElementById('pluginPickerSearch');
    if (search) { search.value = ''; search.focus(); }
}

function closePluginPicker() {
    document.getElementById('pluginPickerOverlay').classList.remove('plugin-overlay-visible');
}

function _refreshPickerHighlights() {
    document.querySelectorAll('#pluginPickerList .plugin-picker-row').forEach(row => {
        const isActive = _activePlugins.includes(row.dataset.plugin);
        row.classList.toggle('active', isActive);
    });
}

function _renderPluginPickerList(query) {
    const list = document.getElementById('pluginPickerList');
    if (!list) return;
    list.innerHTML = '';

    const lq = (query || '').toLowerCase().trim();
    const allData = _allData();

    // Build source groups
    const groups = {};
    for (const [outputName, data] of Object.entries(allData)) {
        const src = data.sourceName;
        if (!groups[src]) groups[src] = [];
        groups[src].push({ outputName, data });
    }

    let anyVisible = false;

    for (const [sourceName, plugins] of Object.entries(groups)) {
        const visible = lq
            ? plugins.filter(p =>
                p.data.displayName.toLowerCase().includes(lq) ||
                sourceName.toLowerCase().includes(lq))
            : plugins;

        if (visible.length === 0) continue;
        anyVisible = true;

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
            checkbox.onclick = e => e.stopPropagation(); // let row handle toggle
            checkbox.onchange = async () => {
                if (checkbox.checked) {
                    if (!_activePlugins.includes(outputName)) {
                        _activePlugins.push(outputName);
                    }
                } else {
                    const idx = _activePlugins.indexOf(outputName);
                    if (idx !== -1) _activePlugins.splice(idx, 1);
                    // Ensure at least one plugin remains
                    if (_activePlugins.length === 0) {
                        _activePlugins = [outputName];
                        checkbox.checked = true;
                        row.classList.add('active');
                        return;
                    }
                }
                row.classList.toggle('active', _activePlugins.includes(outputName));
                _renderActiveList();
                _updateMergedStats();
                // Don't re-render cards on every tick — wait for Done
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

    if (!anyVisible) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:0.9rem;padding:12px 10px;';
        empty.textContent = 'No matching plugins.';
        list.appendChild(empty);
    }
}

async function confirmPluginPicker() {
    closePluginPicker();
    // Ensure at least one active plugin
    if (_activePlugins.length === 0) {
        const first = Object.keys(_allData())[0];
        if (first) _activePlugins = [first];
    }
    await _notifyChange();
}

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
};

// Also expose picker functions directly for onclick= attributes in HTML
window.openPluginPicker    = openPluginPicker;
window.closePluginPicker   = closePluginPicker;
window.confirmPluginPicker = confirmPluginPicker;
window.renderPluginPickerList = _renderPluginPickerList;

})();
