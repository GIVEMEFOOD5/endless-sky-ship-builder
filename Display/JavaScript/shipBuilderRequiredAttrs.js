'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderRequiredAttrs.js  —  Required / Protected Attribute Enforcement
//
//  INTEGRATION
//  ─────────────────────────────────────────────────────────────────────────────
//  Load AFTER shipBuilder.js but BEFORE shipBuilderAttrValidation.js:
//
//      <script src="../JavaScript/shipBuilder.js"></script>
//      <script src="../JavaScript/shipBuilderRequiredAttrs.js"></script>
//      <script src="../JavaScript/shipBuilderAttrValidation.js"></script>
//      <script src="../JavaScript/shipBuilderCapacityGuard.js"></script>
//      <script src="../JavaScript/shipBuilderStats.js"></script>
//
//  Then add ONE call at the END of the DOMContentLoaded block in shipBuilder.js
//  (or shipBuilder.html), after SBS.hookIntoBuilder():
//
//      RequiredAttrs.install();
//
//  WHAT THIS DOES
//  ─────────────────────────────────────────────────────────────────────────────
//  1. Defines a canonical list of required attributes with their default values.
//
//  2. Patches sbBlank() so every new ship starts with all required attributes
//     already present at their default values.
//
//  3. Patches sbRemoveAttr() so attempting to remove a required attribute is
//     blocked with a toast message instead of silently succeeding.
//
//  4. Patches sbRenderAttrList() so the ✕ remove button is hidden (replaced
//     with a locked icon) for required attributes, giving the user a clear
//     visual signal before they even try to remove one.
//
//  5. Patches sbShipFromParsed() so that when a ship is imported from game
//     data or pasted ES text, any missing required attributes are backfilled
//     with their defaults — without overwriting values that are already there.
//
//  REQUIRED ATTRIBUTE DEFAULTS
//  ─────────────────────────────────────────────────────────────────────────────
//  mass             1       hull             1
//  drag             0       shields          0
//  category         ""      cost             1
//  heat dissipation 0.5     cargo space      1
//  outfit space     1       weapon capacity  1
//  engine capacity  1
// ═══════════════════════════════════════════════════════════════════════════════

const RequiredAttrs = (() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    //  REQUIRED ATTRIBUTE DEFINITIONS
    //
    //  key          : the exact attribute key used in sbCurrentShip
    //  defaultValue : string (matches how shipBuilder stores attr values)
    //  special      : 'mass' | 'drag' | 'attr' — where to write the value
    //                 'mass' and 'drag' live on the ship object directly;
    //                 everything else goes into ship.attributes
    // ─────────────────────────────────────────────────────────────────────────

    const REQUIRED = [
        { key: 'mass',             defaultValue: '1',   special: 'mass' },
        { key: 'drag',             defaultValue: '0',   special: 'drag' },
        { key: 'hull',             defaultValue: '1',   special: 'attr' },
        { key: 'shields',          defaultValue: '0',   special: 'attr' },
        { key: 'category',         defaultValue: '',    special: 'attr' },
        { key: 'cost',             defaultValue: '1',   special: 'attr' },
        { key: 'heat dissipation', defaultValue: '0.5', special: 'attr' },
        { key: 'cargo space',      defaultValue: '1',   special: 'attr' },
        { key: 'outfit space',     defaultValue: '1',   special: 'attr' },
        { key: 'weapon capacity',  defaultValue: '1',   special: 'attr' },
        { key: 'engine capacity',  defaultValue: '1',   special: 'attr' },
    ];

    // Fast lookup set for guard checks
    const REQUIRED_KEYS = new Set(REQUIRED.map(r => r.key));

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC: isRequired(key) — used by other modules if needed
    // ─────────────────────────────────────────────────────────────────────────

    function isRequired(key) {
        return REQUIRED_KEYS.has(key);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  BACKFILL  — adds missing required attrs to a ship object in-place.
    //  Never overwrites an existing value.
    // ─────────────────────────────────────────────────────────────────────────

    function _backfill(ship) {
        if (!ship) return;
        ship.attributes = ship.attributes || {};

        for (const def of REQUIRED) {
            if (def.special === 'mass') {
                if (ship.mass === undefined || ship.mass === null || ship.mass === '')
                    ship.mass = def.defaultValue;
            } else if (def.special === 'drag') {
                if (ship.drag === undefined || ship.drag === null || ship.drag === '')
                    ship.drag = def.defaultValue;
            } else {
                if (ship.attributes[def.key] === undefined || ship.attributes[def.key] === null)
                    ship.attributes[def.key] = def.defaultValue;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PATCH: sbBlank()
    //  Wraps the original so every new blank ship gets required attrs prefilled.
    // ─────────────────────────────────────────────────────────────────────────

    function _patchBlank() {
        if (typeof window.sbBlank !== 'function') {
            console.warn('[RequiredAttrs] sbBlank not found — skipping patch.');
            return;
        }
        const orig = window.sbBlank;
        window.sbBlank = function () {
            const ship = orig.apply(this, arguments);
            _backfill(ship);
            return ship;
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PATCH: sbShipFromParsed(src)
    //  After the original builds the ship from imported data, backfill any
    //  required attrs that the source ship didn't have.
    // ─────────────────────────────────────────────────────────────────────────

    function _patchShipFromParsed() {
        if (typeof window.sbShipFromParsed !== 'function') {
            console.warn('[RequiredAttrs] sbShipFromParsed not found — skipping patch.');
            return;
        }
        const orig = window.sbShipFromParsed;
        window.sbShipFromParsed = function (src) {
            const ship = orig.apply(this, arguments);
            _backfill(ship);
            return ship;
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PATCH: sbRemoveAttr(key)
    //  Block removal of any required attribute with a toast.
    // ─────────────────────────────────────────────────────────────────────────

    function _patchRemoveAttr() {
        if (typeof window.sbRemoveAttr !== 'function') {
            console.warn('[RequiredAttrs] sbRemoveAttr not found — skipping patch.');
            return;
        }
        const orig = window.sbRemoveAttr;
        window.sbRemoveAttr = function (key) {
            if (REQUIRED_KEYS.has(key)) {
                if (typeof sbToast === 'function')
                    sbToast(`"${key}" is required on every ship and cannot be removed.`, 'danger');
                return; // block
            }
            return orig.apply(this, arguments);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PATCH: sbRenderAttrList()
    //  After the list renders, replace the ✕ button with a 🔒 icon on every
    //  required attribute row so the user has a clear visual signal.
    //
    //  We use a MutationObserver approach: patch the render function itself
    //  so we can post-process the DOM immediately after innerHTML is set.
    // ─────────────────────────────────────────────────────────────────────────

    function _patchRenderAttrList() {
        if (typeof window.sbRenderAttrList !== 'function') {
            console.warn('[RequiredAttrs] sbRenderAttrList not found — skipping patch.');
            return;
        }
        const orig = window.sbRenderAttrList;
        window.sbRenderAttrList = function () {
            orig.apply(this, arguments);
            _lockRequiredRows();
        };
    }

    function _lockRequiredRows() {
        const el = document.getElementById('attr-list');
        if (!el) return;

        // Each attr row has a button with onclick="sbRemoveAttr('key')"
        // We find rows where the button's onclick references a required key.
        el.querySelectorAll('.attr-row').forEach(row => {
            const btn = row.querySelector('button');
            if (!btn) return;

            // Extract the key from the onclick attribute string
            const onclickStr = btn.getAttribute('onclick') || '';
            const match = onclickStr.match(/sbRemoveAttr\(['"](.+?)['"]\)/);
            if (!match) return;

            const key = match[1];
            if (!REQUIRED_KEYS.has(key)) return;

            // Replace the remove button with a locked indicator
            btn.outerHTML = `<span class="ra-locked-icon" title="${key} is required and cannot be removed">🔒</span>`;
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  STYLES
    // ─────────────────────────────────────────────────────────────────────────

    function _injectStyles() {
        if (document.getElementById('required-attrs-styles')) return;
        const style = document.createElement('style');
        style.id = 'required-attrs-styles';
        style.textContent = `
.ra-locked-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    font-size: 0.78rem;
    opacity: 0.55;
    cursor: default;
    flex-shrink: 0;
}
`;
        document.head.appendChild(style);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  INSTALL
    // ─────────────────────────────────────────────────────────────────────────

    function install() {
        _injectStyles();
        _patchBlank();
        _patchShipFromParsed();
        _patchRemoveAttr();
        _patchRenderAttrList();
        console.log('[RequiredAttrs] Installed — protecting:', [...REQUIRED_KEYS].join(', '));
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    return { install, isRequired, backfill: _backfill };

})();

document.addEventListener('DOMContentLoaded', () => {
    RequiredAttrs.install();
});
