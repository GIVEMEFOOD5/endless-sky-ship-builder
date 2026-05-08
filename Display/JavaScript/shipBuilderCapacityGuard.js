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
//  WHAT IT DOES
//  ─────────────────────────────────────────────────────────────────────────────
//  Guards every action that could violate capacity limits in either direction:
//
//  REMOVAL GUARDS (block or smart-trim):
//    sbRemoveOutfit(i)          — smart bulk removal if outfit provides capacity
//    sbUpdateOutfitCount(i, n)  — blocks count decreases that would violate
//    sbRemoveAttr(key)          — blocks removal of capacity-defining attrs
//    sbUpdateAttrVal(inp)       — blocks reductions of capacity attrs
//
//  ADDITION GUARDS (block if would exceed):
//    sbAddOutfitFromPicker()    — blocks adding an outfit that costs more than
//    confirmAddOutfit()           available space in any capacity dimension
//    addGunTurret()             — blocks adding gun/turret ports that exceed
//                                 weapon capacity
//    confirmAddAttr()           — blocks adding an attr that costs capacity
//    sbUpdateAttrVal(inp)       — blocks increases that cost capacity
//
//  SMART BULK REMOVAL
//  ─────────────────────────────────────────────────────────────────────────────
//  When removing an outfit that provides capacity (e.g. 100 battery packs that
//  each grant outfit space), the guard calculates the minimum number of copies
//  needed to keep all other outfits legal, removes the rest, then shows a modal
//  explaining what was removed and what had to stay.
//
//  CAPACITY KEY DISCOVERY
//  ─────────────────────────────────────────────────────────────────────────────
//  All capacity keys are discovered at runtime — nothing is hardcoded.
//  A key is treated as a "capacity" key when:
//    - The ship has a positive base value for it (defines a maximum), AND
//    - At least one installed outfit has a non-zero value for it (either
//      consuming or providing that resource).
//
// ═══════════════════════════════════════════════════════════════════════════════

const CapacityGuard = (() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    //  HIGHLIGHT CONTROL
    // ─────────────────────────────────────────────────────────────────────────

    const HIGHLIGHT_MS = 3500;
    let _highlightTimer = null;

    function _highlightViolations(violatedKeys) {
        _clearHighlights();
        if (!violatedKeys.length) return;
        const panel = document.getElementById('sbs-root');
        if (!panel) return;
        const lowerKeys = violatedKeys.map(k => k.toLowerCase());
        panel.querySelectorAll('.sbs-card').forEach(card => {
            const labelEl = card.querySelector('.sbs-label');
            if (!labelEl) return;
            const labelText = labelEl.textContent.toLowerCase();
            if (lowerKeys.some(k => labelText.includes(k)))
                card.classList.add('sbs-card--violation');
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
    // ─────────────────────────────────────────────────────────────────────────

    function _getOutfitAttrVal(outfitName, key) {
        if (typeof sbGetOutfitAttrValue === 'function')
            return sbGetOutfitAttrValue(outfitName, key) || 0;
        if (typeof sbFindOutfit !== 'function') return 0;
        const o = sbFindOutfit(outfitName);
        if (!o) return 0;
        const raw = (o.attributes && o.attributes[key] != null)
            ? o.attributes[key] : o[key];
        const n = Number(raw);
        return isNaN(n) ? 0 : n;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CAPACITY KEY DISCOVERY
    //
    //  A key is a capacity key when:
    //    - The ship's base attribute value for it is positive (defines a max).
    //    - At least one installed outfit has a non-zero value for it.
    //
    //  Covers both consumers (negative outfit value) AND providers (positive
    //  outfit value that grants extra capacity to others).
    // ─────────────────────────────────────────────────────────────────────────

    function _discoverCapacityKeys(ship) {
        const keys = new Set();
        const attrs = ship.attributes || {};

        for (const entry of (ship.outfits || [])) {
            const name = (entry.name || '').replace(/^"|"$/g, '');
            if (typeof sbFindOutfit !== 'function') break;
            const outfit = sbFindOutfit(name);
            if (!outfit) continue;

            const sources = [outfit.attributes || {}, outfit];
            for (const src of sources) {
                for (const [key, rawVal] of Object.entries(src)) {
                    if (typeof rawVal !== 'number' && typeof rawVal !== 'string') continue;
                    const n = Number(rawVal);
                    if (isNaN(n) || n === 0) continue;
                    const shipBase = Number(attrs[key]);
                    if (!isNaN(shipBase) && shipBase > 0) keys.add(key);
                }
            }
        }

        return keys;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SIMULATE USED CAPACITY
    //
    //  Sums the cost (negative outfit values) across all outfits in outfitList.
    //  Positive outfit values (providers) are handled separately in
    //  _getEffectiveMax — they do NOT appear in the "used" total.
    // ─────────────────────────────────────────────────────────────────────────

    function _simulateUsed(outfitList, capacityKeys) {
        const used = {};
        for (const key of capacityKeys) used[key] = 0;

        for (const entry of outfitList) {
            const name  = (entry.name || '').replace(/^"|"$/g, '');
            const count = parseInt(entry.count) || 1;
            for (const key of capacityKeys) {
                const effect = _getOutfitAttrVal(name, key);
                // Only negative values are costs; positive ones raise the ceiling
                if (effect < 0) used[key] += (-effect) * count;
            }
        }

        return used;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  EFFECTIVE MAX
    //
    //  The ceiling = ship base value + capacity granted by outfit providers.
    //  Only positive outfit values for the key count toward the maximum.
    // ─────────────────────────────────────────────────────────────────────────

    function _getEffectiveMax(key, hypotheticalAttrs, hypotheticalOutfits) {
        const base = Number((hypotheticalAttrs || {})[key]);
        let max = isNaN(base) ? 0 : base;

        for (const entry of (hypotheticalOutfits || [])) {
            const name  = (entry.name || '').replace(/^"|"$/g, '');
            const count = parseInt(entry.count) || 1;
            const effect = _getOutfitAttrVal(name, key);
            if (effect > 0) max += effect * count;
        }

        return Math.max(0, max);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CHECK VIOLATIONS
    //
    //  Returns array of { key, used, max, over } for every capacity exceeded.
    // ─────────────────────────────────────────────────────────────────────────

    function _checkViolations(outfitList, capacityKeys, hypotheticalAttrs) {
        if (!capacityKeys.size) return [];
        const used = _simulateUsed(outfitList, capacityKeys);
        const violations = [];
        for (const key of capacityKeys) {
            const max = _getEffectiveMax(key, hypotheticalAttrs, outfitList);
            if (max <= 0) continue;
            const u = used[key];
            if (u > max) violations.push({ key, used: u, max, over: u - max });
        }
        return violations;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CHECK SINGLE OUTFIT ADDITION
    //
    //  Returns violations that would result from adding `count` copies of
    //  `outfitName` to the current ship state.
    // ─────────────────────────────────────────────────────────────────────────

    function _checkAddViolations(ship, outfitName, count) {
        count = count || 1;
        const capKeys = _discoverCapacityKeys(ship);

        // Build a hypothetical outfit list with the new outfit appended
        const existing = (ship.outfits || []).map(o => ({ ...o }));
        const existingEntry = existing.find(
            o => (o.name || '').replace(/^"|"$/g, '') === outfitName
        );
        if (existingEntry) {
            existingEntry.count = (parseInt(existingEntry.count) || 1) + count;
        } else {
            existing.push({ name: outfitName, count });
        }

        // Also discover any NEW capacity keys introduced by this outfit
        // (the outfit might reference a key not yet on any installed outfit)
        const attrs = ship.attributes || {};
        if (typeof sbFindOutfit === 'function') {
            const o = sbFindOutfit(outfitName);
            if (o) {
                const sources = [o.attributes || {}, o];
                for (const src of sources) {
                    for (const [key, rawVal] of Object.entries(src)) {
                        const n = Number(rawVal);
                        if (isNaN(n) || n === 0) continue;
                        const shipBase = Number(attrs[key]);
                        if (!isNaN(shipBase) && shipBase > 0) capKeys.add(key);
                    }
                }
            }
        }

        if (!capKeys.size) return [];
        return _checkViolations(existing, capKeys, attrs);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SMART BULK REMOVAL
    //
    //  Called when removing outfit[i] would violate capacity because it provides
    //  capacity that other outfits depend on.
    //
    //  Algorithm:
    //    1. Determine how many copies of outfit[i] are genuinely needed to keep
    //       all other outfits legal (binary search over count 0..oldCount).
    //    2. If minNeeded === oldCount → none can be removed → show hard block.
    //    3. If minNeeded < oldCount  → remove (oldCount - minNeeded) copies,
    //       update the outfit count (or remove entirely if minNeeded === 0),
    //       then show an info modal explaining what happened.
    //
    //  Returns true if any removal was performed (caller should not call
    //  the original function), false if nothing was changed.
    // ─────────────────────────────────────────────────────────────────────────

    function _smartBulkRemove(ship, i, originalFn) {
        const outfits    = ship.outfits || [];
        const target     = outfits[i];
        const targetName = (target.name || '').replace(/^"|"$/g, '');
        const oldCount   = parseInt(target.count) || 1;
        const capKeys    = _discoverCapacityKeys(ship);

        // Find the minimum number of copies needed so remaining outfits don't violate.
        // We binary-search keepCount in [0, oldCount-1].
        // keepCount = number of this outfit we KEEP.
        let minNeeded = oldCount; // pessimistic start

        for (let keepCount = 0; keepCount < oldCount; keepCount++) {
            // Hypothetical outfit list: outfit[i] has keepCount copies
            const hypo = outfits.map((o, idx) => {
                if (idx !== i) return { ...o };
                return { ...o, count: keepCount };
            }).filter(o => (parseInt(o.count) || 0) > 0);

            const violations = _checkViolations(hypo, capKeys, ship.attributes || {});
            if (!violations.length) {
                minNeeded = keepCount;
                break;
            }
        }

        if (minNeeded === oldCount) {
            // Cannot remove any — hard block
            const violations = _checkViolations(
                outfits.filter((_, idx) => idx !== i).map(o => ({ ...o })),
                capKeys,
                ship.attributes || {}
            );
            _showModal(`remove "${targetName}"`, violations, null);
            _highlightViolations(violations.map(v => v.key));
            _sbsRefresh();
            return true; // blocked — caller must not proceed
        }

        const removedCount = oldCount - minNeeded;

        if (minNeeded === 0) {
            // Can remove all — call original to remove entirely
            originalFn.call(window, i);
        } else {
            // Reduce count to minNeeded
            // Update directly on ship.outfits then call sbUpdateOutfitCount if available
            if (typeof sbUpdateOutfitCount === 'function') {
                // Temporarily bypass the guard wrapper by calling the stored original
                // We need the raw shipBuilder function here.  Since we wrapped it,
                // we call it via the CapacityGuard bypass path: set count directly.
                ship.outfits[i].count = minNeeded;
                // Re-render the outfit list if the builder exposes a render function
                if (typeof sbRenderOutfits === 'function') sbRenderOutfits();
                else if (typeof renderOutfits === 'function') renderOutfits();
            } else {
                ship.outfits[i].count = minNeeded;
            }
        }

        // Show info modal
        _showModal(
            null,
            null,
            {
                type:    'partial',
                name:    targetName,
                removed: removedCount,
                kept:    minNeeded,
            }
        );

        _sbsRefresh();
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SBS REFRESH HELPER
    // ─────────────────────────────────────────────────────────────────────────

    function _sbsRefresh() {
        if (typeof SBS !== 'undefined' && typeof SBS.refresh === 'function')
            SBS.refresh();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbRemoveOutfit(i)
    //
    //  If the outfit being removed provides capacity, attempt smart bulk removal.
    //  If it only consumes capacity (or has no capacity effect), still check
    //  that removing it doesn't somehow violate limits.
    // ─────────────────────────────────────────────────────────────────────────

    function _guardRemoveOutfit(originalFn) {
        return function(i) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, i);

            const outfits = ship.outfits || [];
            const target  = outfits[i];
            if (!target) return originalFn.call(this, i);

            const targetName  = (target.name || '').replace(/^"|"$/g, '');
            const capKeys     = _discoverCapacityKeys(ship);

            // Check if this outfit provides capacity for any key
            const providesCapacity = [...capKeys].some(
                key => _getOutfitAttrVal(targetName, key) > 0
            );

            const hypotheticalOutfits = outfits
                .filter((_, idx) => idx !== i)
                .map(o => ({ ...o }));

            const violations = _checkViolations(
                hypotheticalOutfits, capKeys, ship.attributes || {}
            );

            if (!violations.length) {
                // No violation — allow normally
                return originalFn.call(this, i);
            }

            if (providesCapacity) {
                // Smart bulk removal: remove as many copies as safely possible
                _smartBulkRemove(ship, i, originalFn);
                return;
            }

            // Hard block — outfit consumes capacity and removal would still violate
            // (this is unusual but possible with complex multi-key interactions)
            _showModal(`remove "${targetName}"`, violations, null);
            _highlightViolations(violations.map(v => v.key));
            _sbsRefresh();
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbUpdateOutfitCount(i, newCount)
    //
    //  Decreases: check if reducing a provider shrinks the max below used.
    //             Use smart bulk logic if the outfit is a provider.
    //  Increases: check if adding more of a consumer would exceed capacity.
    // ─────────────────────────────────────────────────────────────────────────

    function _guardUpdateOutfitCount(originalFn) {
        return function(i, newCountRaw) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, i, newCountRaw);

            const newCount = Math.max(1, parseInt(newCountRaw) || 1);
            const outfits  = ship.outfits || [];
            const target   = outfits[i];
            if (!target) return originalFn.call(this, i, newCountRaw);

            const oldCount   = parseInt(target.count) || 1;
            const targetName = (target.name || '').replace(/^"|"$/g, '');

            if (newCount === oldCount) return originalFn.call(this, i, newCountRaw);

            const hypotheticalOutfits = outfits.map((o, idx) =>
                idx === i ? { ...o, count: newCount } : { ...o }
            );
            const capKeys = _discoverCapacityKeys(ship);

            // For an increase, also discover new keys the added copies might introduce
            if (newCount > oldCount && typeof sbFindOutfit === 'function') {
                const o = sbFindOutfit(targetName);
                if (o) {
                    const attrs = ship.attributes || {};
                    for (const src of [o.attributes || {}, o]) {
                        for (const [key, rawVal] of Object.entries(src)) {
                            const n = Number(rawVal);
                            if (isNaN(n) || n === 0) continue;
                            const shipBase = Number(attrs[key]);
                            if (!isNaN(shipBase) && shipBase > 0) capKeys.add(key);
                        }
                    }
                }
            }

            const violations = _checkViolations(
                hypotheticalOutfits, capKeys, ship.attributes || {}
            );

            if (!violations.length) return originalFn.call(this, i, newCountRaw);

            if (newCount < oldCount) {
                // Decrease violation — try smart partial removal
                _smartBulkRemove(ship, i, (idx) => {
                    // originalFn for full removal — only reached if minNeeded===0
                    originalFn.call(window, idx);
                });
            } else {
                // Increase violation — hard block
                _showModal(`increase "${targetName}" to ${newCount}`, violations, null);
                const inputs = document.querySelectorAll('.outfit-item__count');
                if (inputs[i]) inputs[i].value = oldCount;
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
            }
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbAddOutfitFromPicker / confirmAddOutfit
    //
    //  Intercepts the two pathways by which a new outfit is added so that
    //  adding an outfit that would exceed any capacity is blocked upfront.
    //
    //  Both functions are wrapped identically — they are called with no
    //  arguments (they read picker state internally), so we re-read the
    //  selected outfit name from the picker before checking.
    // ─────────────────────────────────────────────────────────────────────────

    function _guardAddOutfit(originalFn) {
        return function(...args) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.apply(this, args);

            // Try to determine the outfit being added.
            // The picker typically sets a global like sbSelectedOutfit or
            // stores the name in a data attribute on the confirm button.
            let outfitName = null;
            if (typeof sbSelectedOutfit !== 'undefined' && sbSelectedOutfit)
                outfitName = String(sbSelectedOutfit).replace(/^"|"$/g, '').trim();
            if (!outfitName) {
                const btn = document.getElementById('confirm-add-outfit');
                outfitName = btn?.dataset?.outfitName?.replace(/^"|"$/g, '').trim() || null;
            }
            if (!outfitName) {
                // Can't determine outfit — allow and let shipBuilder validate
                return originalFn.apply(this, args);
            }

            const violations = _checkAddViolations(ship, outfitName, 1);
            if (violations.length) {
                _showModal(`add "${outfitName}"`, violations, null);
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
                return; // block
            }

            return originalFn.apply(this, args);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: addGunTurret(type)
    //
    //  Adding a gun port or turret mount consumes weapon capacity.
    //  The function is called with a type string ('gun' or 'turret').
    // ─────────────────────────────────────────────────────────────────────────

    function _guardAddGunTurret(originalFn) {
        return function(type, ...rest) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, type, ...rest);

            // Determine which attribute this port type consumes.
            // The game uses "gun ports" and "turret mounts" as capacity keys.
            const keyMap = {
                gun:    'gun ports',
                turret: 'turret mounts',
            };
            const costKey = keyMap[(type || '').toLowerCase()];
            if (!costKey) return originalFn.call(this, type, ...rest);

            const attrs   = ship.attributes || {};
            const current = Number(attrs[costKey]) || 0;
            // Count currently used ports of this type from ship hardpoints
            const hpArray = ship.hardpoints || ship.guns || ship.turrets || [];
            // Fallback: count from ship's existing gun/turret attributes
            // The ship builder tracks gun/turret counts separately; if we can
            // read them, compare directly.
            const usedKey   = type === 'gun' ? 'guns' : 'turrets';
            const usedCount = Number(attrs[usedKey]) || 0;
            const maxCount  = current;

            if (maxCount > 0 && usedCount >= maxCount) {
                _showModal(
                    `add ${type} port`,
                    [{ key: costKey, used: usedCount + 1, max: maxCount, over: 1 }],
                    null
                );
                _highlightViolations([costKey]);
                _sbsRefresh();
                return; // block
            }

            return originalFn.call(this, type, ...rest);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: confirmAddAttr
    //
    //  Adding a ship attribute that costs capacity (e.g. a negative-valued
    //  attribute, or one that reduces an existing maximum).
    // ─────────────────────────────────────────────────────────────────────────

    function _guardConfirmAddAttr(originalFn) {
        return function(...args) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.apply(this, args);

            // Read the key and value from the add-attr form
            const keyInput = document.getElementById('new-attr-key')
                          || document.querySelector('[data-attr-key-input]');
            const valInput = document.getElementById('new-attr-value')
                          || document.querySelector('[data-attr-val-input]');

            const key = keyInput?.value?.trim() || '';
            const val = parseFloat(valInput?.value);

            if (!key || isNaN(val)) return originalFn.apply(this, args);

            // If the new attribute is being ADDED to the ship (not already present),
            // simulate the post-add state and check capacity
            const hypotheticalAttrs = { ...(ship.attributes || {}), [key]: val };
            const outfits  = ship.outfits || [];
            const capKeys  = _discoverCapacityKeys(ship);

            // If new attr introduces a new capacity key with a positive value,
            // that's fine (increases max). If it's negative or reduces an existing
            // positive value, check.
            const existingVal = Number((ship.attributes || {})[key]);
            const isReduction = !isNaN(existingVal) && val < existingVal;
            const isNewNeg    = isNaN(existingVal) && val < 0;

            if (!isReduction && !isNewNeg) return originalFn.apply(this, args);

            if (capKeys.has(key) || isReduction) {
                const violations = _checkViolations(outfits, new Set([...capKeys, key]), hypotheticalAttrs);
                if (violations.length) {
                    _showModal(`set "${key}" to ${val}`, violations, null);
                    _highlightViolations(violations.map(v => v.key));
                    _sbsRefresh();
                    return; // block
                }
            }

            return originalFn.apply(this, args);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbRemoveAttr(key)
    // ─────────────────────────────────────────────────────────────────────────

    function _guardRemoveAttr(originalFn) {
        return function(key) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, key);

            const currentVal = Number((ship.attributes || {})[key]);
            if (isNaN(currentVal) || currentVal <= 0)
                return originalFn.call(this, key);

            const hypotheticalAttrs = { ...(ship.attributes || {}) };
            delete hypotheticalAttrs[key];

            const outfits     = ship.outfits || [];
            const capKeys     = _discoverCapacityKeys(ship);
            const keysToCheck = new Set([...capKeys, key]);

            if (!keysToCheck.size) return originalFn.call(this, key);

            const violations = _checkViolations(outfits, keysToCheck, hypotheticalAttrs);
            if (violations.length) {
                _showModal(`remove attribute "${key}"`, violations, null);
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
                return;
            }

            return originalFn.call(this, key);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbUpdateAttrVal(inp)
    //
    //  Guards both REDUCTIONS (existing) and INCREASES that cost capacity
    //  (e.g. increasing a cost-type attribute that counts against a limit).
    // ─────────────────────────────────────────────────────────────────────────

    function _guardUpdateAttrVal(originalFn) {
        return function(inp) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, inp);

            const key    = inp.dataset.key;
            const newVal = parseFloat(inp.value);
            const oldVal = parseFloat((ship.attributes || {})[key]);

            if (!key || isNaN(newVal) || isNaN(oldVal) || newVal === oldVal)
                return originalFn.call(this, inp);

            const hypotheticalAttrs = { ...(ship.attributes || {}), [key]: newVal };
            const outfits = ship.outfits || [];
            const capKeys = _discoverCapacityKeys(ship);

            // Reduction of a capacity-providing attribute
            if (newVal < oldVal && capKeys.has(key)) {
                const violations = _checkViolations(outfits, capKeys, hypotheticalAttrs);
                if (violations.length) {
                    _showModal(`reduce "${key}" to ${newVal}`, violations, null);
                    inp.value = String(oldVal);
                    _highlightViolations(violations.map(v => v.key));
                    _sbsRefresh();
                    return;
                }
            }

            // Increase of a capacity-consuming attribute (e.g. increasing a cost field)
            if (newVal > oldVal) {
                const violations = _checkViolations(outfits, capKeys, hypotheticalAttrs);
                if (violations.length) {
                    _showModal(`increase "${key}" to ${newVal}`, violations, null);
                    inp.value = String(oldVal);
                    _highlightViolations(violations.map(v => v.key));
                    _sbsRefresh();
                    return;
                }
            }

            return originalFn.call(this, inp);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  STYLES & MODAL
    // ─────────────────────────────────────────────────────────────────────────

    const MODAL_ID = 'modal-cap-guard';

    function _injectStyles() {
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
#modal-cap-guard .cap-guard-partial-info {
    padding: 10px 14px;
    border-radius: var(--r-sm, 6px);
    background: rgba(129, 200, 252, 0.10);
    border: 1px solid rgba(129, 200, 252, 0.25);
    font-size: 0.86rem;
    color: var(--c-text-mid, #cbd5e0);
    margin-bottom: 12px;
}
#modal-cap-guard .cap-guard-partial-info strong {
    color: var(--c-info-hi, #90cdf4);
}
#modal-cap-guard .cap-guard-hint {
    font-size: 0.82rem;
    color: var(--c-text-muted, #64748b);
    margin: 0;
}`;
            document.head.appendChild(style);
        }

        if (!document.getElementById(MODAL_ID)) {
            const wrap = document.createElement('div');
            wrap.innerHTML = `
<div id="modal-cap-guard" class="modal-overlay">
  <div class="modal-box" style="width:min(440px,96vw);">
    <div class="modal-header">
      <div class="modal-title" id="cap-guard-modal-title">Cannot Make Change</div>
      <button class="modal-close"
        onclick="document.getElementById('modal-cap-guard').classList.remove('active')">×</button>
    </div>
    <p class="confirm-text" id="cap-guard-modal-action" style="margin-bottom:12px;"></p>
    <div id="cap-guard-modal-partial"></div>
    <ul class="cap-guard-violations" id="cap-guard-modal-list"></ul>
    <p class="cap-guard-hint" id="cap-guard-modal-hint"></p>
    <div class="btn-group btn-group-right" style="margin-top:16px;">
      <button class="btn btn-secondary"
        onclick="document.getElementById('modal-cap-guard').classList.remove('active')">OK</button>
    </div>
  </div>
</div>`;
            document.body.appendChild(wrap.firstElementChild);
            document.getElementById(MODAL_ID).addEventListener('click', function(e) {
                if (e.target === this) this.classList.remove('active');
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SHOW MODAL
    //
    //  Three modes:
    //    1. Hard block:   actionDesc + violations list
    //    2. Partial:      partialInfo object { type:'partial', name, removed, kept }
    //    3. Both:         not currently used but supported
    // ─────────────────────────────────────────────────────────────────────────

    function _showModal(actionDesc, violations, partialInfo) {
        _injectStyles();

        const titleEl   = document.getElementById('cap-guard-modal-title');
        const actionEl  = document.getElementById('cap-guard-modal-action');
        const listEl    = document.getElementById('cap-guard-modal-list');
        const partialEl = document.getElementById('cap-guard-modal-partial');
        const hintEl    = document.getElementById('cap-guard-modal-hint');

        // Reset all sections
        if (partialEl) partialEl.innerHTML = '';
        if (listEl)    listEl.innerHTML    = '';
        if (hintEl)    hintEl.textContent  = '';
        if (actionEl)  actionEl.textContent = '';

        if (partialInfo && partialInfo.type === 'partial') {
            // Partial removal info modal
            if (titleEl)  titleEl.textContent = 'Partial Removal';
            if (actionEl) actionEl.textContent =
                `Not all copies of "${partialInfo.name}" could be removed.`;

            if (partialEl) {
                const keptLine = partialInfo.kept > 0
                    ? `<strong>${partialInfo.kept}</strong> cop${partialInfo.kept === 1 ? 'y' : 'ies'} must remain to support other installed outfits.`
                    : '';
                partialEl.innerHTML = `
<div class="cap-guard-partial-info">
  <strong>${partialInfo.removed}</strong> cop${partialInfo.removed === 1 ? 'y' : 'ies'} of
  "${partialInfo.name}" ${partialInfo.removed === 1 ? 'was' : 'were'} removed.
  ${keptLine}
</div>`;
            }
            if (hintEl) hintEl.textContent =
                'Remove outfits that depend on this capacity first to free up more.';

        } else {
            // Hard block modal
            if (titleEl)  titleEl.textContent  = 'Cannot Make Change';
            if (actionEl) actionEl.textContent =
                `This action would exceed capacity: ${actionDesc}`;

            if (listEl && violations && violations.length) {
                listEl.innerHTML = violations.map(v => {
                    const name = v.key.split(' ')
                        .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                    return `<li>
                        <span class="cgv-name">${name}</span>
                        <span class="cgv-nums">${v.used.toFixed(0)} used / ${v.max.toFixed(0)} max &nbsp;(${v.over.toFixed(0)} over)</span>
                    </li>`;
                }).join('');
            }
            if (hintEl) hintEl.textContent =
                'Remove other outfits first to free up space.';
        }

        document.getElementById(MODAL_ID).classList.add('active');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  INSTALL
    // ─────────────────────────────────────────────────────────────────────────

    function install() {
        _injectStyles();

        const wrap = (name, guardFn) => {
            if (typeof window[name] === 'function') {
                window[name] = guardFn(window[name]);
                return true;
            }
            return false;
        };

        wrap('sbRemoveOutfit',        _guardRemoveOutfit);
        wrap('sbUpdateOutfitCount',   _guardUpdateOutfitCount);
        wrap('sbRemoveAttr',          _guardRemoveAttr);
        wrap('sbUpdateAttrVal',       _guardUpdateAttrVal);
        wrap('sbAddOutfitFromPicker', _guardAddOutfit);
        wrap('confirmAddOutfit',      _guardAddOutfit);
        wrap('addGunTurret',          _guardAddGunTurret);
        wrap('confirmAddAttr',        _guardConfirmAddAttr);

        console.log('[CapacityGuard] Installed on 8 functions.');
    }

    return { install };

})();

document.addEventListener('DOMContentLoaded', () => {
    CapacityGuard.install();
});
