'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderCapacityGuard.js  —  Capacity Violation Prevention
//
//  INTEGRATION
//  ─────────────────────────────────────────────────────────────────────────────
//  Load AFTER shipBuilder.js in shipBuilder.html:
//
//      <script src="../JavaScript/shipBuilder.js"></script>
//      <script src="../JavaScript/shipBuilderCapacityGuard.js"></script>
//
//  No other changes needed — this file wraps the existing global functions
//  sbRemoveOutfit, sbUpdateOutfitCount, and sbRemoveAttr automatically on
//  DOMContentLoaded.
//
//  WHAT IT DOES
//  ─────────────────────────────────────────────────────────────────────────────
//  Before any action that could leave installed outfits over their capacity
//  limits, this guard:
//
//    1. Simulates the post-action state entirely (no side effects).
//    2. Checks every capacity key that exists on the current ship against the
//       sum of outfit costs after the action.
//    3. If any capacity would go negative (i.e. used > max), it:
//         a. Blocks the action entirely (returns false / does not call original).
//         b. Shows a descriptive alert listing every violated capacity.
//         c. Highlights the violating stat cards in the SBS stats panel (if
//            present) by adding the CSS class `sbs-card--violation` to any card
//            whose label matches the violated capacity name.
//    4. The highlight auto-clears after 3 seconds.
//
//  CAPACITY KEYS
//  ─────────────────────────────────────────────────────────────────────────────
//  Capacity keys are NOT hardcoded. They are discovered at runtime by scanning
//  all outfit attributes on the current ship and finding any key whose net
//  contribution across all outfits is negative (i.e. it's a consumable resource).
//  The ship's base attribute value for that key is used as the maximum.
//
//  This means any modded capacity attribute (e.g. "drone capacity") is
//  automatically protected without any code changes here.
//
//  GUARD SCOPE
//  ─────────────────────────────────────────────────────────────────────────────
//  Three operations are guarded:
//
//    sbRemoveOutfit(i)
//      Simulates removal of outfit[i] entirely.
//      Blocked if: any remaining outfit's total cost exceeds the remaining max
//      after accounting for the space/capacity the removed outfit was providing.
//
//    sbUpdateOutfitCount(i, newCount)
//      Only guarded on DECREASE (adding is already checked by sbCheckOutfitSpace).
//      Blocked if: reducing the count of an outfit that provides capacity would
//      leave other outfits over their limits.
//
//    sbRemoveAttr(key)
//      Blocked if: removing a capacity-defining attribute (e.g. "outfit space")
//      would leave installed outfits exceeding the remaining capacity.
//      Also blocked if removing a non-capacity attribute that is a maximum value
//      for something that would then be exceeded.
//
// ═══════════════════════════════════════════════════════════════════════════════

const CapacityGuard = (() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    //  HIGHLIGHT CONTROL
    //  Adds `sbs-card--violation` to any SBS stat card whose label text
    //  matches (case-insensitive substring) one of the violated capacity names.
    //  Auto-removes after HIGHLIGHT_MS milliseconds.
    // ─────────────────────────────────────────────────────────────────────────

    const HIGHLIGHT_MS = 3500;
    let _highlightTimer = null;

    function _highlightViolations(violatedKeys) {
        // Clear any previous highlights
        _clearHighlights();

        if (!violatedKeys.length) return;

        const panel = document.getElementById('sbs-root');
        if (!panel) return;

        const lowerKeys = violatedKeys.map(k => k.toLowerCase());

        panel.querySelectorAll('.sbs-card').forEach(card => {
            const labelEl = card.querySelector('.sbs-label');
            if (!labelEl) return;
            const labelText = labelEl.textContent.toLowerCase();
            if (lowerKeys.some(k => labelText.includes(k))) {
                card.classList.add('sbs-card--violation');
            }
        });

        clearTimeout(_highlightTimer);
        _highlightTimer = setTimeout(_clearHighlights, HIGHLIGHT_MS);
    }

    function _clearHighlights() {
        document.querySelectorAll('.sbs-card--violation')
            .forEach(el => el.classList.remove('sbs-card--violation'));
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  OUTFIT ATTRIBUTE LOOKUP
    //  Uses the existing sbGetOutfitAttrValue helper from shipBuilder.js.
    //  Falls back to direct lookup if that function isn't available.
    // ─────────────────────────────────────────────────────────────────────────

    function _getOutfitAttrVal(outfitName, key) {
        if (typeof sbGetOutfitAttrValue === 'function')
            return sbGetOutfitAttrValue(outfitName, key) || 0;

        // Fallback: manual lookup
        if (typeof sbFindOutfit !== 'function') return 0;
        const o = sbFindOutfit(outfitName);
        if (!o) return 0;
        const raw = (o.attributes && o.attributes[key] != null)
            ? o.attributes[key]
            : o[key];
        const n = Number(raw);
        return isNaN(n) ? 0 : n;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CAPACITY KEY DISCOVERY
    //
    //  Returns a Set of attribute keys that are "capacity" keys — defined as:
    //  any key for which at least one installed outfit has a NEGATIVE value
    //  (meaning it consumes that resource) AND the ship has a positive base
    //  value for that key (meaning it defines the maximum).
    //
    //  This is fully data-driven: no key names are hardcoded.
    // ─────────────────────────────────────────────────────────────────────────

    function _discoverCapacityKeys(ship) {
        const keys = new Set();
        const attrs = ship.attributes || {};

        for (const entry of (ship.outfits || [])) {
            const name = (entry.name || '').replace(/^"|"$/g, '');
            if (typeof sbFindOutfit !== 'function') break;
            const outfit = sbFindOutfit(name);
            if (!outfit) continue;

            // Check both attributes sub-object and top-level keys
            const sources = [outfit.attributes || {}, outfit];
            for (const src of sources) {
                for (const [key, rawVal] of Object.entries(src)) {
                    if (typeof rawVal !== 'number' && typeof rawVal !== 'string') continue;
                    const n = Number(rawVal);
                    if (isNaN(n) || n >= 0) continue; // only negative values = capacity costs
                    // Ship must have a positive base value for this key to be a cap
                    const shipBase = Number(attrs[key]);
                    if (!isNaN(shipBase) && shipBase > 0) keys.add(key);
                }
            }
        }

        return keys;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SIMULATE: compute used capacity for a hypothetical outfit list
    //
    //  outfitList: [ { name, count }, ... ]
    //  Returns: { [capacityKey]: usedAmount }
    // ─────────────────────────────────────────────────────────────────────────

    function _simulateUsed(outfitList, capacityKeys) {
        const used = {};
        for (const key of capacityKeys) used[key] = 0;

        for (const entry of outfitList) {
            const name  = (entry.name || '').replace(/^"|"$/g, '');
            const count = parseInt(entry.count) || 1;
            for (const key of capacityKeys) {
                const effect = _getOutfitAttrVal(name, key);
                // Negative effect = consumes capacity; positive = provides capacity
                // Net cost = -(effect) * count
                used[key] += (-effect) * count;
            }
        }

        // Clamp to 0 minimum (negative used = surplus, not a violation)
        for (const key of capacityKeys)
            if (used[key] < 0) used[key] = 0;

        return used;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GET MAX for a capacity key after a hypothetical attribute state
    //
    //  hypotheticalAttrs: the ship's attributes object after the proposed change
    // ─────────────────────────────────────────────────────────────────────────

    function _getMax(key, hypotheticalAttrs) {
        const n = Number((hypotheticalAttrs || {})[key]);
        return isNaN(n) ? 0 : Math.max(0, n);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CHECK: given a hypothetical outfit list and attribute set, return all
    //  violations as an array of { key, used, max, over } objects.
    // ─────────────────────────────────────────────────────────────────────────

    function _checkViolations(outfitList, capacityKeys, hypotheticalAttrs) {
        if (!capacityKeys.size) return [];
        const used = _simulateUsed(outfitList, capacityKeys);
        const violations = [];
        for (const key of capacityKeys) {
            const max  = _getMax(key, hypotheticalAttrs);
            if (max <= 0) continue; // no cap defined — skip
            const u = used[key];
            if (u > max) violations.push({ key, used: u, max, over: u - max });
        }
        return violations;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  FORMAT ALERT MESSAGE
    // ─────────────────────────────────────────────────────────────────────────

    function _capLabel(key) {
        return key.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }



    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbRemoveOutfit(i)
    //
    //  Simulate removing outfit[i] entirely and check if remaining outfits
    //  still fit within the (possibly reduced) capacity.
    // ─────────────────────────────────────────────────────────────────────────

    function _guardRemoveOutfit(originalFn) {
        return function(i) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, i);

            const outfits = ship.outfits || [];
            const target  = outfits[i];
            if (!target) return originalFn.call(this, i);

            // Build hypothetical outfit list without outfit[i]
            const hypotheticalOutfits = outfits
                .filter((_, idx) => idx !== i)
                .map(o => ({ ...o }));

            // Capacity keys from the ORIGINAL list (in case the removed outfit
            // itself provides capacity — that's the dangerous case)
            const capKeys = _discoverCapacityKeys(ship);

            // We also need to include keys provided by the outfit being removed
            // that are positive (i.e. it was granting capacity to others).
            // These are found by checking the outfit for positive values of any
            // key that other outfits consume.
            const removedName = (target.name || '').replace(/^"|"$/g, '');
            const removedCount = parseInt(target.count) || 1;

            // After removal, the effective max for each key changes if the outfit
            // was providing extra capacity via positive attribute values.
            // We simulate the post-removal attribute state by computing net attr
            // contributions.  Since the ship's BASE attributes are in
            // ship.attributes, and outfits can ALSO add to capacity attributes
            // (positive effect = grants capacity), we need the post-removal net.
            //
            // Approach: use the existing ship.attributes as the base max, but
            // also factor in any capacity granted by outfits that REMAIN.
            // The existing sbShipCapacity() reads ship.attributes only, which
            // is correct since outfit-granted capacity is already included in
            // sbUsedCapacity's net calculation.  We replicate that here.

            const violations = _checkViolations(
                hypotheticalOutfits,
                capKeys,
                ship.attributes || {}
            );

            if (violations.length) {
                _showModal(`remove "${removedName}"`, violations);
                _highlightViolations(violations.map(v => v.key));
                // Trigger SBS refresh so highlights appear in the panel
                if (typeof SBS !== 'undefined' && typeof SBS.refresh === 'function')
                    SBS.refresh();
                return; // block
            }

            return originalFn.call(this, i);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbUpdateOutfitCount(i, newCount)
    //
    //  Only intercepts DECREASES. Increasing is already guarded by
    //  sbCheckOutfitSpace in shipBuilder.js.
    //
    //  A decrease matters when the outfit being reduced PROVIDES capacity
    //  (positive value for a capacity key), because reducing its count shrinks
    //  the effective maximum available to other outfits.
    // ─────────────────────────────────────────────────────────────────────────

    function _guardUpdateOutfitCount(originalFn) {
        return function(i, newCountRaw) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, i, newCountRaw);

            const newCount = parseInt(newCountRaw) || 1;
            const outfits  = ship.outfits || [];
            const target   = outfits[i];
            if (!target) return originalFn.call(this, i, newCountRaw);

            const oldCount = parseInt(target.count) || 1;

            // Only guard decreases
            if (newCount >= oldCount) return originalFn.call(this, i, newCountRaw);

            // Build hypothetical list with the new count
            const hypotheticalOutfits = outfits.map((o, idx) =>
                idx === i ? { ...o, count: newCount } : { ...o }
            );

            const capKeys = _discoverCapacityKeys(ship);
            const violations = _checkViolations(
                hypotheticalOutfits,
                capKeys,
                ship.attributes || {}
            );

            if (violations.length) {
                const targetName = (target.name || '').replace(/^"|"$/g, '');
                _showModal(`reduce "${targetName}" to ${newCount}`, violations);
                _highlightViolations(violations.map(v => v.key));
                // Reset the count input back to its old value
                const inputs = document.querySelectorAll('.outfit-item__count');
                if (inputs[i]) inputs[i].value = oldCount;
                if (typeof SBS !== 'undefined' && typeof SBS.refresh === 'function')
                    SBS.refresh();
                return; // block
            }

            return originalFn.call(this, i, newCountRaw);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbRemoveAttr(key)
    //
    //  If the attribute being removed is one that defines a capacity maximum
    //  (e.g. "outfit space", "engine capacity", or any modded equivalent),
    //  simulate setting it to 0 and check if installed outfits would violate.
    // ─────────────────────────────────────────────────────────────────────────

    function _guardRemoveAttr(originalFn) {
        return function(key) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, key);

            // Check if this key is currently a positive capacity attribute
            const currentVal = Number((ship.attributes || {})[key]);
            if (isNaN(currentVal) || currentVal <= 0) {
                // Not a capacity-defining attribute — allow freely
                return originalFn.call(this, key);
            }

            // Simulate attributes with this key removed
            const hypotheticalAttrs = { ...(ship.attributes || {}) };
            delete hypotheticalAttrs[key];

            const outfits = ship.outfits || [];
            const capKeys = _discoverCapacityKeys(ship);

            if (!capKeys.has(key) && !capKeys.size) {
                // No capacity keys discovered — allow
                return originalFn.call(this, key);
            }

            // Make sure we check the key being removed even if not yet discovered
            const keysToCheck = new Set([...capKeys, key]);

            const violations = _checkViolations(
                outfits,
                keysToCheck,
                hypotheticalAttrs
            );

            if (violations.length) {
                _showModal(`remove attribute "${key}"`, violations);
                _highlightViolations(violations.map(v => v.key));
                if (typeof SBS !== 'undefined' && typeof SBS.refresh === 'function')
                    SBS.refresh();
                return; // block
            }

            return originalFn.call(this, key);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbUpdateAttrVal — intercept REDUCTIONS of capacity attributes
    //
    //  If a capacity attribute (e.g. "outfit space") is being reduced to a
    //  value lower than what installed outfits need, block it.
    // ─────────────────────────────────────────────────────────────────────────

    function _guardUpdateAttrVal(originalFn) {
        return function(inp) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, inp);

            const key      = inp.dataset.key;
            const newVal   = parseFloat(inp.value);
            const oldVal   = parseFloat((ship.attributes || {})[key]);

            // Only guard if: key exists, is numeric, and new value is LESS
            if (!key || isNaN(newVal) || isNaN(oldVal) || newVal >= oldVal) {
                return originalFn.call(this, inp);
            }

            // Simulate the reduced attribute value
            const hypotheticalAttrs = { ...(ship.attributes || {}), [key]: newVal };
            const outfits  = ship.outfits || [];
            const capKeys  = _discoverCapacityKeys(ship);

            if (!capKeys.has(key)) {
                // Not a capacity key — allow
                return originalFn.call(this, inp);
            }

            const violations = _checkViolations(outfits, capKeys, hypotheticalAttrs);

            if (violations.length) {
                _showModal(`reduce "${key}" to ${newVal}`, violations);
                // Restore input to old value
                inp.value = String(oldVal);
                _highlightViolations(violations.map(v => v.key));
                if (typeof SBS !== 'undefined' && typeof SBS.refresh === 'function')
                    SBS.refresh();
                return; // block
            }

            return originalFn.call(this, inp);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  INJECT CSS for sbs-card--violation if not already present
    // ─────────────────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────────────
    //  MODAL  — matches the existing modal-box / modal-header / confirm-text
    //  style used by modal-confirm in shipBuilder.html
    // ─────────────────────────────────────────────────────────────────────────

    const MODAL_ID = 'modal-cap-guard';

    function _injectStyles() {
        // ── CSS ────────────────────────────────────────────────────────────
        if (!document.getElementById('cap-guard-styles')) {
            const style = document.createElement('style');
            style.id = 'cap-guard-styles';
            style.textContent = `
.sbs-card--violation {
    outline: 2px solid var(--c-danger-hi, #fc8181) !important;
    background: rgba(252, 129, 129, 0.12) !important;
    animation: cap-guard-pulse 0.4s ease-in-out 3;
}
@keyframes cap-guard-pulse {
    0%   { outline-color: var(--c-danger-hi, #fc8181); }
    50%  { outline-color: transparent; }
    100% { outline-color: var(--c-danger-hi, #fc8181); }
}
#modal-cap-guard .cap-guard-violations {
    margin: 4px 0 16px;
    padding: 0;
    list-style: none;
}
#modal-cap-guard .cap-guard-violations li {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 6px 10px;
    margin-bottom: 5px;
    border-radius: var(--r-sm, 6px);
    background: rgba(252, 129, 129, 0.10);
    border: 1px solid rgba(252, 129, 129, 0.25);
    font-size: 0.86rem;
    color: var(--c-text-mid, #cbd5e0);
}
#modal-cap-guard .cap-guard-violations li .cgv-name {
    font-weight: 700;
    color: var(--c-danger-hi, #fc8181);
}
#modal-cap-guard .cap-guard-violations li .cgv-nums {
    font-variant-numeric: tabular-nums;
    font-size: 0.82rem;
    color: var(--c-text-dim, #718096);
    white-space: nowrap;
    margin-left: 12px;
}
#modal-cap-guard .cap-guard-hint {
    font-size: 0.82rem;
    color: var(--c-text-muted, #64748b);
    margin: 0;
}`;
            document.head.appendChild(style);
        }

        // ── Modal HTML ────────────────────────────────────────────────────
        if (!document.getElementById(MODAL_ID)) {
            const wrap = document.createElement('div');
            wrap.innerHTML = `
<div id="modal-cap-guard" class="modal-overlay">
  <div class="modal-box" style="width:min(420px,96vw);">
    <div class="modal-header">
      <div class="modal-title" id="cap-guard-modal-title">Cannot Make Change</div>
      <button class="modal-close" onclick="document.getElementById('modal-cap-guard').classList.remove('active')">×</button>
    </div>
    <p class="confirm-text" id="cap-guard-modal-action" style="margin-bottom:12px;"></p>
    <ul class="cap-guard-violations" id="cap-guard-modal-list"></ul>
    <p class="cap-guard-hint">Remove other outfits first to free up space.</p>
    <div class="btn-group btn-group-right" style="margin-top:16px;">
      <button class="btn btn-secondary"
        onclick="document.getElementById('modal-cap-guard').classList.remove('active')">OK</button>
    </div>
  </div>
</div>`;
            document.body.appendChild(wrap.firstElementChild);

            // Close on backdrop click — same behaviour as other modals
            document.getElementById(MODAL_ID).addEventListener('click', function(e) {
                if (e.target === this) this.classList.remove('active');
            });
        }
    }

    // Show the capacity-guard modal with the given action description and violations
    function _showModal(actionDesc, violations) {
        _injectStyles(); // ensure modal exists (safe to call multiple times)

        const titleEl  = document.getElementById('cap-guard-modal-title');
        const actionEl = document.getElementById('cap-guard-modal-action');
        const listEl   = document.getElementById('cap-guard-modal-list');

        if (titleEl)  titleEl.textContent  = 'Cannot Make Change';
        if (actionEl) actionEl.textContent = `This action would exceed capacity: ${actionDesc}`;

        if (listEl) {
            listEl.innerHTML = violations.map(v => {
                const name = v.key.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                return `<li>
                    <span class="cgv-name">${name}</span>
                    <span class="cgv-nums">${v.used.toFixed(0)} used / ${v.max.toFixed(0)} max &nbsp;(${v.over.toFixed(0)} over)</span>
                </li>`;
            }).join('');
        }

        document.getElementById(MODAL_ID).classList.add('active');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  INSTALL — wraps the four global functions from shipBuilder.js
    // ─────────────────────────────────────────────────────────────────────────

    function install() {
        _injectStyles();

        if (typeof window.sbRemoveOutfit === 'function')
            window.sbRemoveOutfit = _guardRemoveOutfit(window.sbRemoveOutfit);

        if (typeof window.sbUpdateOutfitCount === 'function')
            window.sbUpdateOutfitCount = _guardUpdateOutfitCount(window.sbUpdateOutfitCount);

        if (typeof window.sbRemoveAttr === 'function')
            window.sbRemoveAttr = _guardRemoveAttr(window.sbRemoveAttr);

        if (typeof window.sbUpdateAttrVal === 'function')
            window.sbUpdateAttrVal = _guardUpdateAttrVal(window.sbUpdateAttrVal);

        console.log('[CapacityGuard] Installed on sbRemoveOutfit, sbUpdateOutfitCount, sbRemoveAttr, sbUpdateAttrVal.');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    return { install };

})();

document.addEventListener('DOMContentLoaded', () => {
    CapacityGuard.install();
});
