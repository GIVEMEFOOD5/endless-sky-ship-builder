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

    // Unique ID per item.
    // Priority:
    //   1. _internalId  — most reliable, set by the data pipeline
    //   2. name only    — used for isInList() lookups where _compareTab may not
    //                     be set yet (e.g. freshly rendered cards, local-storage
    //                     items). Two items with the same name in different tabs
    //                     are intentionally treated as the same logical ship.
    function _idOf(item) {
        if (item._internalId) return String(item._internalId);
        return String(item.name || '');
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function isInList(item) {
        const id = _idOf(item);
        return _stores.ship.some(i => _idOf(i) === id) ||
               _stores.outfit.some(i => _idOf(i) === id);
    }

    function getGroupType() { return _activeGroup; }
    function getItems()     { return [..._stores[_activeGroup]]; }
    function getCount()     { return _stores[_activeGroup].length; }

    /**
     * Called by DataViewer's switchTab() — silently swaps the visible list.
     */
    function setActiveTab(tab) {
        const group = _tabToGroup(tab);
        if (group === _activeGroup) return;
        _activeGroup = group;
        _dispatch();
    }

    function add(item, tab) {
        // Stamp a copy with the originating tab
        item = Object.assign({}, item, { _compareTab: tab });
        const group = _tabToGroup(tab);
        const store = _stores[group];

        // Deduplicate by _idOf
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
