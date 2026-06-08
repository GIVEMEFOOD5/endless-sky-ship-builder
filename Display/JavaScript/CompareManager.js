'use strict';

// ─── CompareManager.js ────────────────────────────────────────────────────────
//
// Manages the compare list state: singles and groups.
//
// List entries are either:
//   Single: { ...itemData, _compareTab, _isGroup: false }
//   Group:  { _isGroup: true, _groupId, name, members: [{ item, qty }] }
//
// Rules:
//   • Ships/variants and outfits are separate groups (type group: 'ship'/'outfit')
//   • Switching tabs silently hides the other group's list
//   • No item limit
//
// Events dispatched on window:
//   'compareListChanged'  — whenever the visible list or active group changes
// ─────────────────────────────────────────────────────────────────────────────

window.CompareManager = (() => {

    let _stores = { ship: [], outfit: [] };
    let _activeGroup = 'ship';
    let _nextGroupId = 1;

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

    function _idOf(item) {
        if (item._isGroup) return '__group__' + item._groupId;
        const tab  = item._compareTab || '';
        const name = String(item.name || '');
        return name + '|' + tab;
    }

    // ── Public API — singles ──────────────────────────────────────────────────

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
        _activeGroup = group;
        _dispatch();
    }

    function add(item, tab) {
        item = Object.assign({}, item, { _compareTab: tab, _isGroup: false });
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

    // ── Public API — groups ───────────────────────────────────────────────────
    //
    // members: [{ item, qty }]  — item must already have _compareTab stamped on it

    function addGroup(name, members) {
        if (!members || members.length === 0) return null;
        const tab   = members[0].item._compareTab || 'outfits';
        const group = _tabToGroup(tab);
        const entry = {
            _isGroup:  true,
            _groupId:  _nextGroupId++,
            _compareTab: tab,
            name,
            members:   members.map(m => ({ item: m.item, qty: Math.max(1, m.qty || 1) })),
        };
        _stores[group].push(entry);
        if (group === _activeGroup) _dispatch();
        return entry;
    }

    function updateGroup(groupId, name, members) {
        for (const store of Object.values(_stores)) {
            const idx = store.findIndex(i => i._isGroup && i._groupId === groupId);
            if (idx !== -1) {
                store[idx] = Object.assign({}, store[idx], {
                    name,
                    members: members.map(m => ({ item: m.item, qty: Math.max(1, m.qty || 1) })),
                });
                _dispatch();
                return;
            }
        }
    }

    function removeGroup(groupId) {
        for (const key of Object.keys(_stores))
            _stores[key] = _stores[key].filter(i => !(i._isGroup && i._groupId === groupId));
        _dispatch();
    }

    function getGroup(groupId) {
        for (const store of Object.values(_stores)) {
            const g = store.find(i => i._isGroup && i._groupId === groupId);
            if (g) return g;
        }
        return null;
    }

    return {
        isInList, add, remove, clear, clearAll, toggle,
        getItems, getCount, getGroupType, setActiveTab,
        addGroup, updateGroup, removeGroup, getGroup,
    };

})();