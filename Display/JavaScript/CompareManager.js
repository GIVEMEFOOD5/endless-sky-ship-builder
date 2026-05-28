'use strict';

// ─── CompareManager.js ────────────────────────────────────────────────────────
//
// Manages the compare list state.
//
// Rules:
//   • Ships and variants can be compared together (type group: 'ship')
//   • Outfits are a separate group (type group: 'outfit')
//   • Switching groups clears the previous list (with a confirm prompt)
//   • Items persist until explicitly removed or cleared
//   • Max 8 items at once (keeps UI sane)
//
// Events dispatched on window:
//   'compareListChanged'  — whenever the list is mutated
// ─────────────────────────────────────────────────────────────────────────────

window.CompareManager = (() => {

    const MAX_ITEMS = 8;

    // Internal state
    let _items      = [];   // array of item objects
    let _groupType  = null; // 'ship' | 'outfit' | null

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _tabToGroup(tab) {
        if (tab === 'ships' || tab === 'variants') return 'ship';
        if (tab === 'outfits') return 'outfit';
        return null;
    }

    function _itemGroup(item) {
        // Outfits have a flat 'category', ships/variants have attributes.category
        if (item._compareTab) return _tabToGroup(item._compareTab);
        if (item.attributes)  return 'ship';
        return 'outfit';
    }

    function _dispatch() {
        window.dispatchEvent(new CustomEvent('compareListChanged', {
            detail: { items: [..._items], groupType: _groupType }
        }));
    }

    function _idOf(item) {
        return item._internalId || item.name || JSON.stringify(item).slice(0, 80);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function isInList(item) {
        const id = _idOf(item);
        return _items.some(i => _idOf(i) === id);
    }

    function canAdd(item) {
        if (_items.length >= MAX_ITEMS) return false;
        if (_groupType === null)        return true;
        return _itemGroup(item) === _groupType;
    }

    function getGroupType()  { return _groupType; }
    function getItems()      { return [..._items]; }
    function getCount()      { return _items.length; }

    /**
     * Add an item. If the item belongs to a different group, prompt the user
     * to confirm switching (which clears the existing list).
     * Returns true if added, false if rejected.
     */
    function add(item, tab) {
        // Stamp the tab so we know the group even after tab switches
        item = Object.assign({}, item, { _compareTab: tab });

        if (isInList(item)) return false;

        const incoming = _itemGroup(item);

        if (_groupType !== null && incoming !== _groupType) {
            const groupLabel = _groupType === 'ship' ? 'ships/variants' : 'outfits';
            const confirmed  = window.confirm(
                `You're currently comparing ${groupLabel}.\n\n` +
                `Outfits and ships cannot be compared together.\n\n` +
                `Clear the current compare list and start a new one?`
            );
            if (!confirmed) return false;
            _items     = [];
            _groupType = null;
        }

        if (_items.length >= MAX_ITEMS) {
            alert(`You can compare at most ${MAX_ITEMS} items at once.`);
            return false;
        }

        _groupType = incoming;
        _items.push(item);
        _dispatch();
        return true;
    }

    function remove(item) {
        const id = _idOf(item);
        _items = _items.filter(i => _idOf(i) !== id);
        if (_items.length === 0) _groupType = null;
        _dispatch();
    }

    function clear() {
        _items     = [];
        _groupType = null;
        _dispatch();
    }

    function toggle(item, tab) {
        if (isInList(item)) { remove(item); return false; }
        return add(item, tab);
    }

    return { isInList, canAdd, add, remove, clear, toggle, getItems, getCount, getGroupType };

})();
