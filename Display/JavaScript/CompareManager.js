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
// ID strategy:
//   Variants share a base ship _internalId (e.g. "plugin::Korath Dredger")
//   so we CANNOT rely on _internalId alone to distinguish them.
//   Instead we always use:  name + '|' + tab
//   which is unique because variant names are unique (e.g. "Korath Dredger (Digger)")
//   and ships/variants live on different tabs.
//
// Events dispatched on window:
//   'compareListChanged'  — whenever the visible list or active group changes
// ─────────────────────────────────────────────────────────────────────────────

window.CompareManager = (() => {

    let _stores = { ship: [], outfit: [] };
    let _activeGroup = 'ship';

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _tabToGroup(tab) {
        if (tab === 'ships' || tab === 'variants') return 'ship';
        if (tab === 'outfits') return 'outfit';
        return 'ship';
    }

    function _dispatch() {
        window.dispatchEvent(new CustomEvent('compareListChanged', {
            detail: { items: [..._stores[_activeGroup]], groupType: _activeGroup }
        }));
    }

    // Always use name + tab — this is the only truly unique key for variants
    // since all variants of a ship share the same _internalId as the base ship.
    function _idOf(item) {
        const tab  = item._compareTab || '';
        const name = String(item.name || '');
        return name + '|' + tab;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    // item must have _compareTab stamped on it before calling this
    // (done at card creation time in DataViewer.js)
    function isInList(item) {
        const id = _idOf(item);
        return _stores.ship.some(i => _idOf(i) === id) ||
               _stores.outfit.some(i => _idOf(i) === id);
    }

    function getGroupType() { return _activeGroup; }
    function getItems()     { return [..._stores[_activeGroup]]; }
    function getCount()     { return _stores[_activeGroup].length; }

    // Called by DataViewer's switchTab() on every tab change.
    // Always dispatches so the bar hides/shows correctly even when
    // switching between ships and variants (same group, bar still refreshes).
    function setActiveTab(tab) {
        const group = _tabToGroup(tab);
        _activeGroup = group;
        _dispatch(); // always dispatch — keeps bar in sync on every tab switch
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
