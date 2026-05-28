'use strict';

// ─── CompareManager.js ────────────────────────────────────────────────────────
//
// Manages the compare list state.
//
// Rules:
//   • Ships and variants can be compared together (type group: 'ship')
//   • Outfits are a separate group (type group: 'outfit')
//   • Switching tabs silently hides the other group's list and restores it
//     when you switch back — no clearing, no prompts
//   • Items persist until explicitly removed or cleared
//   • No item limit
//
// Events dispatched on window:
//   'compareListChanged'  — whenever the visible list or active group changes
// ─────────────────────────────────────────────────────────────────────────────

window.CompareManager = (() => {

    // Two independent stores, one per group
    let _stores = { ship: [], outfit: [] };

    // Which group is currently visible in the UI
    // Driven by setActiveTab() calls from DataViewer's switchTab()
    let _activeGroup = 'ship'; // 'ship' | 'outfit'

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _tabToGroup(tab) {
        if (tab === 'ships' || tab === 'variants') return 'ship';
        if (tab === 'outfits') return 'outfit';
        return 'ship';
    }

    function _dispatch() {
        window.dispatchEvent(new CustomEvent('compareListChanged', {
            detail: {
                items:     [..._stores[_activeGroup]],
                groupType: _activeGroup
            }
        }));
    }

    // Unique ID per item — uses _internalId when available (variants have one),
    // otherwise name + tab to avoid base-ship name collisions across tabs.
    function _idOf(item) {
        if (item._internalId) return item._internalId;
        return (item.name || '') + '|' + (item._compareTab || '');
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function isInList(item) {
        // Check both stores so card buttons stay accurate regardless of active tab
        const id = _idOf(item);
        return _stores.ship.some(i => _idOf(i) === id) ||
               _stores.outfit.some(i => _idOf(i) === id);
    }

    function getGroupType() { return _activeGroup; }
    function getItems()     { return [..._stores[_activeGroup]]; }
    function getCount()     { return _stores[_activeGroup].length; }

    /**
     * Called by DataViewer's switchTab() so we know which group to surface.
     * Silently swaps the visible list — no prompt, no clearing.
     */
    function setActiveTab(tab) {
        const group = _tabToGroup(tab);
        if (group === _activeGroup) return;
        _activeGroup = group;
        _dispatch();
    }

    function add(item, tab) {
        item = Object.assign({}, item, { _compareTab: tab });
        const group = _tabToGroup(tab);
        const store = _stores[group];

        if (store.some(i => _idOf(i) === _idOf(item))) return false;

        store.push(item);
        if (group === _activeGroup) _dispatch();
        return true;
    }

    function remove(item) {
        const id = _idOf(item);
        _stores.ship   = _stores.ship.filter(i => _idOf(i) !== id);
        _stores.outfit = _stores.outfit.filter(i => _idOf(i) !== id);
        _dispatch();
    }

    function clear() {
        _stores[_activeGroup] = [];
        _dispatch();
    }

    function clearAll() {
        _stores = { ship: [], outfit: [] };
        _dispatch();
    }

    function toggle(item, tab) {
        if (isInList(item)) { remove(item); return false; }
        return add(item, tab);
    }

    return { isInList, add, remove, clear, clearAll, toggle,
             getItems, getCount, getGroupType, setActiveTab };

})();
