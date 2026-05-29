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
//   _internalId is the gold standard — variants always have a unique one.
//   If absent, fall back to name + '|' + tab so that e.g. "Rano Ek" on the
//   ships tab and "Rano Ek" on the variants tab are treated as distinct items,
//   and two different variants that share a display name are also distinct.
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

    // Build a stable unique key for an item.
    // _internalId is always preferred — it is unique per variant even when
    // two variants share the same name.
    // Fallback uses name + tab so that a ship and a same-named variant are
    // not considered the same item.
    function _idOf(item) {
        if (item._internalId) return 'id:' + String(item._internalId);
        const tab = item._compareTab || '';
        return 'n:' + String(item.name || '') + '|' + tab;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    // item should already have _compareTab stamped on it (done at card creation
    // in DataViewer.js) so the key is always fully qualified.
    function isInList(item) {
        const id = _idOf(item);
        return _stores.ship.some(i => _idOf(i) === id) ||
               _stores.outfit.some(i => _idOf(i) === id);
    }

    function getGroupType() { return _activeGroup; }
    function getItems()     { return [..._stores[_activeGroup]]; }
    function getCount()     { return _stores[_activeGroup].length; }

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
