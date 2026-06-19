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
// PERSISTENCE
// -----------
// Active plugin selection is owned entirely by dataLoader.js, which saves to
// 'es_sb_active_plugins' and restores it in initDefaultPlugins(). This file
// does NOT maintain its own storage key — it syncs _activePlugins from the
// 'pluginsChanged' event (which carries e.detail.active) and delegates all
// saves through DataLoader._setActivePluginsSilent().
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

// Ordered list of active plugin outputNames (first = primary).
// This is kept in sync with dataLoader.js via the pluginsChanged event.
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
 * Delegates to DataLoader._refreshLocalOnly() so attribute coercion,
 * outfitMap integer counts, mass/drag merging etc. are handled in one
 * place and never duplicated here.
 */
function _refreshLocalBuilds() {
    if (window.DataLoader && typeof window.DataLoader._refreshLocalOnly === 'function') {
        window.DataLoader._refreshLocalOnly();
        return;
    }
    if (window.DataLoader && typeof window.DataLoader.refreshLocalBuilds === 'function') {
        window.DataLoader.refreshLocalBuilds();
    }
}

/**
 * Persist the current active list through DataLoader so both systems
 * share a single storage key ('es_sb_active_plugins').
 */
function _persistActivePlugins() {
    if (window.DataLoader && typeof window.DataLoader._setActivePluginsSilent === 'function') {
        window.DataLoader._setActivePluginsSilent(_activePlugins);
    }
}

// ── DOM injection ──────────────────────────────────────────────────────────

function _injectPickerOverlay() {
    if (document.getElementById('pluginPickerOverlay')) return;

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

function getActivePlugins() {
    return [..._activePlugins];
}

/**
 * Returns the primary plugin (first non-local in the list), or null.
 * Local Builds is skipped as primary — it has no sprites/effects.
 */
function getPrimaryPlugin() {
    const nonLocal = _activePlugins.find(p => p !== LOCAL_PLUGIN_ID);
    return nonLocal || _activePlugins[0] || null;
}

/**
 * Merge items from all active plugins for a given tab.
 * Local Builds ships are always merged first.
 * Each item gets a `_pluginId` property so ComputedStats can resolve outfits.
 */
function getMergedItems(tab) {
    _refreshLocalBuilds();

    const allData = _allData();

    const ordered = [
        ..._activePlugins.filter(p => p === LOCAL_PLUGIN_ID),
        ..._activePlugins.filter(p => p !== LOCAL_PLUGIN_ID),
    ];

    const merged = [];
    for (const outputName of ordered) {
        const pluginData = allData[outputName];
        if (!pluginData) continue;

        if (outputName === LOCAL_PLUGIN_ID && tab !== 'ships' && tab !== 'variants') continue;

        let items = [];
        if      (tab === 'ships')    items = pluginData.ships    || [];
        else if (tab === 'variants') items = pluginData.variants || [];
        else if (tab === 'outfits')  items = pluginData.outfits  || [];
        else if (tab === 'effects')  items = pluginData.effects  || [];

        for (const item of items) {
            merged.push({ ...item, _pluginId: outputName });
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

    if (_localBuildsHasShips() && !filtered.includes(LOCAL_PLUGIN_ID)) {
        filtered.unshift(LOCAL_PLUGIN_ID);
    }

    _activePlugins = filtered;
    if (_activePlugins.length === 0) return;

    _persistActivePlugins();
    await _notifyChange();
}

/**
 * Called after data loads — selects the first available plugin.
 * NOTE: dataLoader.js calls initDefaultPlugins() internally and fires
 * pluginsChanged with the restored/default selection. This function is
 * the fallback path called by DataViewer.js and the ship builder page.
 * It does NOT attempt to restore from localStorage — that is dataLoader's job.
 */
async function initDefaultPlugin() {
    _refreshLocalBuilds();

    // If _activePlugins is already populated (restored by DataLoader.initDefaultPlugins
    // via pluginsChanged), don't overwrite it — just trigger a render.
    if (_activePlugins.length > 0) {
        const primary = getPrimaryPlugin();
        if (typeof window.setCurrentPlugin  === 'function') window.setCurrentPlugin(primary);
        if (typeof window.setEffectPlugin   === 'function') window.setEffectPlugin(primary);
        if (typeof window.setSorterPluginId === 'function') window.setSorterPluginId(primary);
        if (typeof window.clearComputedCache === 'function') window.clearComputedCache();
        _renderActiveList();
        _updateMergedStats();
        await _renderMergedCards(true);
        return;
    }

    // Nothing restored yet — fall back to first available plugin
    const keys = Object.keys(_allData()).filter(k => k !== LOCAL_PLUGIN_ID);

    if (_localBuildsHasShips()) _activePlugins.push(LOCAL_PLUGIN_ID);
    if (keys.length > 0)        _activePlugins.push(keys[0]);

    if (_activePlugins.length === 0) return;

    const primary = getPrimaryPlugin();
    if (typeof window.setCurrentPlugin  === 'function') window.setCurrentPlugin(primary);
    if (typeof window.setEffectPlugin   === 'function') window.setEffectPlugin(primary);
    if (typeof window.setSorterPluginId === 'function') window.setSorterPluginId(primary);
    if (typeof window.clearComputedCache === 'function') window.clearComputedCache();
    _renderActiveList();
    _updateMergedStats();
    await _renderMergedCards(true);
}

// ── Internal: notify the rest of the app ──────────────────────────────────

async function _notifyChange() {
    // Persist via DataLoader so both systems share one key
    _persistActivePlugins();

    const primary = getPrimaryPlugin();
    if (!primary) return;

    if (window.DataLoader && typeof window.DataLoader.setActivePlugins === 'function') {
        window.DataLoader._setActivePluginsSilent?.(_activePlugins)
            ?? window.DataLoader.setActivePlugins(_activePlugins);
    }

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

        const localOffset     = _activePlugins.includes(LOCAL_PLUGIN_ID) ? 1 : 0;
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
            const nonLocal = _activePlugins.filter(p => p !== LOCAL_PLUGIN_ID);
            if (nonLocal.length === 0) {
                _activePlugins.splice(idx, 0, outputName); // re-add — must keep one
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
    // Restore the snapshot — user cancelled
    _activePlugins  = [..._pickerSnapshot];
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

            const isActive  = _activePlugins.includes(LOCAL_PLUGIN_ID);
            const shipCount = (localPlugin.ships || []).length;

            const row = document.createElement('div');
            row.className      = 'plugin-picker-row plugin-picker-row--local' + (isActive ? ' active' : '');
            row.dataset.plugin = LOCAL_PLUGIN_ID;

            const checkbox = document.createElement('input');
            checkbox.type    = 'checkbox';
            checkbox.checked = isActive;
            checkbox.style.cssText = 'cursor:pointer;accent-color:#3b82f6;width:16px;height:16px;flex-shrink:0;';
            checkbox.onclick  = e => e.stopPropagation();
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    if (!_activePlugins.includes(LOCAL_PLUGIN_ID)) {
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
        if (outputName === LOCAL_PLUGIN_ID) continue;
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
        header.className   = 'plugin-picker-group-header';
        header.textContent = sourceName;
        list.appendChild(header);

        for (const { outputName, data } of visible) {
            const isActive = _activePlugins.includes(outputName);

            const row = document.createElement('div');
            row.className      = 'plugin-picker-row' + (isActive ? ' active' : '');
            row.dataset.plugin = outputName;

            const checkbox = document.createElement('input');
            checkbox.type    = 'checkbox';
            checkbox.checked = isActive;
            checkbox.style.cssText = 'cursor:pointer;accent-color:#3b82f6;width:16px;height:16px;flex-shrink:0;';
            checkbox.onclick  = e => e.stopPropagation();
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    if (!_activePlugins.includes(outputName)) {
                        _activePlugins.push(outputName);
                    }
                } else {
                    const idx = _activePlugins.indexOf(outputName);
                    if (idx !== -1) _activePlugins.splice(idx, 1);
                    // Must keep at least one remote plugin active
                    if (_activePlugins.filter(p => p !== LOCAL_PLUGIN_ID).length === 0) {
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

    // Empty state
    const localRendered = localPlugin &&
        (localPlugin.ships || []).length > 0 &&
        (!lq || 'local builds'.includes(lq));
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

    if (_localBuildsHasShips()) {
        const idx = _activePlugins.indexOf(LOCAL_PLUGIN_ID);
        if (idx > 0) {
            _activePlugins.splice(idx, 1);
            _activePlugins.unshift(LOCAL_PLUGIN_ID);
        }
    }

    if (_activePlugins.filter(p => p !== LOCAL_PLUGIN_ID).length === 0) {
        const first = Object.keys(_allData()).find(k => k !== LOCAL_PLUGIN_ID);
        if (first) _activePlugins.push(first);
    }

    await _notifyChange();
}

// ── Event listeners ────────────────────────────────────────────────────────

// pluginsChanged is fired by dataLoader.js with e.detail.active containing
// the authoritative active plugin list (already restored from localStorage).
// We sync our local _activePlugins from it so both systems stay in step.
document.addEventListener('pluginsChanged', (e) => {
    _refreshLocalBuilds();

    // Sync from DataLoader's authoritative list if provided
    if (e.detail?.active && Array.isArray(e.detail.active)) {
        _activePlugins = [...e.detail.active];
    }

    // If local now has ships and isn't in the list, prepend it
    if (_localBuildsHasShips() && !_activePlugins.includes(LOCAL_PLUGIN_ID)) {
        _activePlugins.unshift(LOCAL_PLUGIN_ID);
        // Persist the updated list and notify without firing pluginsChanged again
        _persistActivePlugins();
    }

    _renderActiveList();
    _updateMergedStats();
});

// dataLoaded fires after all remote data is fetched. By this point
// dataLoader.js has already called initDefaultPlugins() which restored the
// saved selection and fired pluginsChanged — so _activePlugins is already set.
// We only need to ensure a remote plugin is present as a safety net.
document.addEventListener('dataLoaded', async () => {
    _refreshLocalBuilds();

    const hasRemote = _activePlugins.some(p => p !== LOCAL_PLUGIN_ID);
    if (!hasRemote) {
        const firstRemote = Object.keys(_allData()).find(k => k !== LOCAL_PLUGIN_ID);
        if (firstRemote) {
            _activePlugins.push(firstRemote);
            await _notifyChange();
        }
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
