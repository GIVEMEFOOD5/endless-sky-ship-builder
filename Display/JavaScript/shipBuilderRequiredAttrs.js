'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderRequiredAttrs.js  —  Required / Protected Attribute Enforcement
//                                  + Outfit-Mode Full-Width Layout
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
//  HOW REQUIRED ATTRIBUTES ARE DETERMINED  (zero hardcoded key names)
//  ─────────────────────────────────────────────────────────────────────────────
//  Required keys are derived entirely from window.attrDefs at install time
//  using three signals from the JSON data:
//
//    1. meta.isExpectedNegative === true
//       Capacity keys (outfit space, engine capacity, weapon capacity, etc.)
//       The outfit pays the negative cost; the ship base value must be ≥ 0.
//
//    2. meta.shownInShipPanel === true
//       Attributes the game shows in its own ship info panel.  These are
//       the fundamental stats every ship is expected to have defined.
//
//    3. meta.usedInShipFunctions includes 'FinishLoading', 'Drag', or
//       'DragForce'  — Ship.cpp reads these at load time or for core physics,
//       so they must exist on the ship.
//
//  Weapon-only / status-effect / boolean flags are excluded automatically
//  because they never appear on the ship panel and are not read at load time.
//
//  HARDCODED VALUES (design decisions, not derivable from data)
//  ─────────────────────────────────────────────────────────────────────────────
//  Only the default values are hardcoded, keyed by the attribute name so
//  they are easy to find and change.  Every other key name comes from the data.
//
//  OUTFIT MODE LAYOUT
//  ─────────────────────────────────────────────────────────────────────────────
//  When sbMode === 'outfit', the identity and description sidebar panels are
//  already hidden by shipBuilder.js.  However, the .builder-layout grid still
//  reserves the 320px sidebar column, leaving a blank gap.
//
//  This module adds/removes a CSS class  .builder-layout--outfit-mode  on the
//  .builder-layout element whenever the mode changes.  That class collapses the
//  sidebar column to zero so the main content panel spans the full width,
//  matching the space that the identity fields normally occupy.
//
//  The class is toggled by patching sbPopulateBuilder(), which is the single
//  function that runs every time the builder view opens or switches mode.
// ═══════════════════════════════════════════════════════════════════════════════

const RequiredAttrs = (() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    //  SIGNALS used to derive required keys from window.attrDefs
    //  All are property names on the attribute metadata objects — no key names.
    // ─────────────────────────────────────────────────────────────────────────

    // Signal 3: ship functions whose attributesRead list implies load-time need
    const CORE_SHIP_FUNCTIONS = new Set(['FinishLoading', 'Drag', 'DragForce']);

    // ─────────────────────────────────────────────────────────────────────────
    //  DEFAULT VALUES  ← only hardcoded values in this file
    //
    //  Keys here that don't end up in the required set are silently ignored,
    //  so this map can be broader than the derived set without causing errors.
    //
    //  Rules (per user spec):
    //    - mass, hull, cost, and all capacity/space keys → '1'
    //    - heat dissipation                              → '0.5'
    //    - drag, shields, category                       → '0' / ''
    //    - everything else required but not listed here  → '0'
    // ─────────────────────────────────────────────────────────────────────────

    const DEFAULTS_BY_KEY = {
        'mass':             '1',
        'hull':             '1',
        'cost':             '1',
        'cargo space':      '1',
        'outfit space':     '1',
        'weapon capacity':  '1',
        'engine capacity':  '1',
        'gun ports':        '0',
        'turret mounts':    '0',
        'drag':             '0',
        'shields':          '0',
        'category':         '',
        'heat dissipation': '0.5',
    };

    const DEFAULT_FALLBACK = '0'; // for any required key not listed above

    // ─────────────────────────────────────────────────────────────────────────
    //  CSS class toggled on .builder-layout in outfit mode
    // ─────────────────────────────────────────────────────────────────────────

    const OUTFIT_MODE_CLASS = 'builder-layout--outfit-mode';

    // ─────────────────────────────────────────────────────────────────────────
    //  STATE  — populated at install time once attrDefs is available
    // ─────────────────────────────────────────────────────────────────────────

    let _requiredKeys   = new Set();   // derived from attrDefs
    let _requiredList   = [];          // [ { key, special, defaultValue }, … ]

    // ─────────────────────────────────────────────────────────────────────────
    //  DERIVE REQUIRED KEYS from window.attrDefs
    // ─────────────────────────────────────────────────────────────────────────

    function _deriveRequiredKeys() {
        const ad = window.attrDefs;
        if (!ad || !ad.attributes) {
            console.warn('[RequiredAttrs] window.attrDefs not available — falling back to empty set.');
            return new Set();
        }

        const attrs   = ad.attributes;
        const derived = new Set();

        for (const [key, meta] of Object.entries(attrs)) {
            // Exclude weapon-stat-only attributes — they live on the weapon
            // sub-object, not the ship's base attributes.
            if (meta.isWeaponStat || meta.isWeaponDataKey) continue;

            // Exclude boolean flags — they're present/absent, not numeric.
            if (meta.isBoolean) continue;

            // Exclude pure status-effect trackers (ionization, scrambling…)
            if (meta.isStatusEffect) continue;

            // Signal 1: capacity key
            if (meta.isExpectedNegative) { derived.add(key); continue; }

            // Signal 2: shown in the game's ship info panel
            if (meta.shownInShipPanel)   { derived.add(key); continue; }

            // Signal 3: read by core ship functions at load / physics time
            const fns = meta.usedInShipFunctions || [];
            if (fns.some(fn => CORE_SHIP_FUNCTIONS.has(fn))) {
                derived.add(key);
            }
        }

        // Also scan shipFunctions directly for FinishLoading.attributesRead
        // (catches keys that may not have shownInShipPanel set)
        const shipFns = ad.shipFunctions || {};
        for (const fnName of CORE_SHIP_FUNCTIONS) {
            const fn = shipFns[fnName];
            if (fn && Array.isArray(fn.attributesRead)) {
                for (const k of fn.attributesRead) {
                    // Apply the same exclusions
                    const meta = attrs[k];
                    if (!meta) continue;
                    if (meta.isWeaponStat || meta.isWeaponDataKey) continue;
                    if (meta.isBoolean || meta.isStatusEffect) continue;
                    derived.add(k);
                }
            }
        }

        return derived;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  BUILD _requiredList from the derived key set
    //
    //  'special' controls where the value lives on the ship object:
    //    'mass' / 'drag' → ship.mass / ship.drag  (top-level fields)
    //    'attr'          → ship.attributes[key]
    // ─────────────────────────────────────────────────────────────────────────

    function _buildRequiredList(keys) {
        return [...keys].map(key => ({
            key,
            special:      key === 'mass' ? 'mass' : key === 'drag' ? 'drag' : 'attr',
            defaultValue: DEFAULTS_BY_KEY.hasOwnProperty(key)
                              ? DEFAULTS_BY_KEY[key]
                              : DEFAULT_FALLBACK,
        }));
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC: isRequired(key)
    // ─────────────────────────────────────────────────────────────────────────

    function isRequired(key) {
        return _requiredKeys.has(key);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  BACKFILL  — adds missing required attrs to a ship object in-place.
    //  Never overwrites an existing non-empty value.
    // ─────────────────────────────────────────────────────────────────────────

    function _backfill(ship) {
        if (!ship) return;
        ship.attributes = ship.attributes || {};

        for (const def of _requiredList) {
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
    //  OUTFIT-MODE LAYOUT  — collapse / restore sidebar column
    // ─────────────────────────────────────────────────────────────────────────

    function _applyLayoutMode(mode) {
        const layout = document.querySelector('.builder-layout');
        if (!layout) return;
        if (mode === 'outfit') {
            layout.classList.add(OUTFIT_MODE_CLASS);
        } else {
            layout.classList.remove(OUTFIT_MODE_CLASS);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PATCH: sbBlank()
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
    // ─────────────────────────────────────────────────────────────────────────

    function _patchRemoveAttr() {
        if (typeof window.sbRemoveAttr !== 'function') {
            console.warn('[RequiredAttrs] sbRemoveAttr not found — skipping patch.');
            return;
        }
        const orig = window.sbRemoveAttr;
        window.sbRemoveAttr = function (key) {
            if (_requiredKeys.has(key)) {
                if (typeof sbToast === 'function')
                    sbToast(`"${key}" is required on every ship and cannot be removed.`, 'danger');
                return;
            }
            return orig.apply(this, arguments);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PATCH: sbRenderAttrList()
    //  After the list renders, swap ✕ buttons for 🔒 icons on required rows.
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

        el.querySelectorAll('.attr-row').forEach(row => {
            const btn = row.querySelector('button');
            if (!btn) return;
            // Extract the key name from onclick="sbRemoveAttr('key')"
            const match = (btn.getAttribute('onclick') || '').match(/sbRemoveAttr\(['"](.+?)['"]\)/);
            if (!match || !_requiredKeys.has(match[1])) return;
            btn.outerHTML = `<span class="ra-locked-icon" title="${match[1]} is required and cannot be removed">🔒</span>`;
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PATCH: sbPopulateBuilder()
    //  After populating, apply the correct layout class for the current mode.
    // ─────────────────────────────────────────────────────────────────────────

    function _patchPopulateBuilder() {
        if (typeof window.sbPopulateBuilder !== 'function') {
            console.warn('[RequiredAttrs] sbPopulateBuilder not found — skipping patch.');
            return;
        }
        const orig = window.sbPopulateBuilder;
        window.sbPopulateBuilder = function () {
            orig.apply(this, arguments);
            // sbMode is a global set by shipBuilder.js before sbPopulateBuilder runs
            const mode = (typeof sbMode !== 'undefined') ? sbMode : null;
            _applyLayoutMode(mode);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  STYLES
    // ─────────────────────────────────────────────────────────────────────────

    function _injectStyles() {
        if (document.getElementById('required-attrs-styles')) return;
        const style = document.createElement('style');
        style.id = 'required-attrs-styles';
        style.textContent = `

/* ── Locked attribute icon ───────────────────────────────────────── */
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

/* ── Outfit-mode: collapse sidebar, span full width ──────────────── */
/*
   .builder-layout is a CSS grid with two columns:
       grid-template-columns: 320px 1fr   (from main.css line 2574)

   In outfit mode the sidebar panels (#sidebar-identity, #sidebar-description)
   are already hidden by shipBuilder.js (display:none).  We change the grid so
   that first column takes zero space, letting the main panel fill the full row.

   We use grid-template-columns rather than hiding the sidebar wrapper so that
   any padding/gap on .builder-layout doesn't leave a phantom gap either.
*/
.builder-layout.builder-layout--outfit-mode {
    grid-template-columns: 0 1fr;
    gap: 0 0;
}

/*
   The sidebar div itself still exists in the DOM (shipBuilder.js hides its
   children, not the wrapper).  Clamp it to zero so it doesn't peek through.
*/
.builder-layout.builder-layout--outfit-mode .builder-sidebar {
    width: 0;
    min-width: 0;
    overflow: hidden;
    padding: 0;
    gap: 0;
}

/*
   On narrow screens the grid already collapses to a single column, so the
   outfit-mode class has nothing extra to do — keep behaviour identical.
*/
@media (max-width: 900px) {
    .builder-layout.builder-layout--outfit-mode {
        grid-template-columns: 1fr;
    }
    .builder-layout.builder-layout--outfit-mode .builder-sidebar {
        width: auto;
        overflow: visible;
    }
}
`;
        document.head.appendChild(style);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  INSTALL
    // ─────────────────────────────────────────────────────────────────────────

    function install() {
        _injectStyles();

        // Derive required keys — attrDefs may or may not be ready yet.
        // If it isn't, we try again on DOMContentLoaded and once more on the
        // dataLoaded event that DataLoader fires when plugins finish loading.
        function _init() {
            _requiredKeys = _deriveRequiredKeys();
            _requiredList = _buildRequiredList(_requiredKeys);
            console.log(
                '[RequiredAttrs] Protecting ' + _requiredKeys.size + ' attributes:',
                [..._requiredKeys].sort().join(', ')
            );
        }

        _init(); // attempt immediately (works if attrDefs is inline in HTML)

        // Re-derive once live data arrives (DataLoader fires 'dataLoaded')
        document.addEventListener('dataLoaded', () => {
            _init();
            // Re-lock any already-rendered rows
            _lockRequiredRows();
        });

        _patchBlank();
        _patchShipFromParsed();
        _patchRemoveAttr();
        _patchRenderAttrList();
        _patchPopulateBuilder();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    return { install, isRequired, backfill: _backfill };

})();

document.addEventListener('DOMContentLoaded', () => {
    RequiredAttrs.install();
});
