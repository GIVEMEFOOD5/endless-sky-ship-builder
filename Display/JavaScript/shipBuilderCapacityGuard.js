'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderCapacityGuard.js  —  Capacity Violation Prevention
//
//  INTEGRATION
//  ─────────────────────────────────────────────────────────────────────────────
//  Load AFTER shipBuilder.js in shipBuilder.html (already the case):
//
//      <script src="../JavaScript/shipBuilder.js"></script>
//      <script src="../JavaScript/shipBuilderAttrValidation.js"></script>
//      <script src="../JavaScript/shipBuilderCapacityGuard.js"></script>
//
//  DESIGN
//  ─────────────────────────────────────────────────────────────────────────────
//  This guard does NOT maintain its own capacity accounting.
//  It delegates entirely to shipBuilder.js's own functions:
//
//    sbUsedCapacity(key)     — current used amount for a capacity key
//    sbShipCapacity(key)     — current maximum for a capacity key
//    sbGetOutfitCapacityEffect(name, key) — per-outfit effect on a key
//    sbCheckOutfitSpace(name, count)      — full addition check (used for adds)
//
//  This guarantees the guard and the displayed capacity bars always agree.
//
//  WHAT IS GUARDED
//  ─────────────────────────────────────────────────────────────────────────────
//  Removals / reductions (smart bulk removal):
//    sbRemoveOutfit(i)           Smart bulk: removes as many copies as safely
//                                possible; shows modal explaining what stayed.
//    sbUpdateOutfitCount(i, n)   Decrease: same smart bulk logic.
//                                Increase: delegates to sbCheckOutfitSpace.
//    sbRemoveAttr(key)           Blocks if removing a capacity attr would
//                                leave installed outfits over their limit.
//    sbUpdateAttrVal(inp)        Blocks reductions of capacity attrs that
//                                would leave outfits over their limit.
//
//  Additions:
//    sbAddOutfitFromPicker()     Two-pass check: sbCheckOutfitSpace handles the
//    confirmAddOutfit()          four capacity keys; we add a second pass that
//                                checks every other attribute the outfit affects
//                                (e.g. heat dissipation) and blocks if any would
//                                go illegally negative. Sign rules come from
//                                AttrValidation so nothing is hardcoded.
//    addGunTurret(type)          Blocks adding gun/turret hardpoints beyond
//                                the ship's gun ports / turret mounts attr.
//    confirmAddAttr()            Blocks setting a capacity attr to a value
//                                lower than what's currently in use.
//
//  SMART BULK REMOVAL
//  ─────────────────────────────────────────────────────────────────────────────
//  When the user removes an outfit that provides capacity to others, instead
//  of a hard block the guard finds the minimum copies needed to keep all other
//  outfits legal, removes the surplus, then shows a modal explaining the result.
//
// ═══════════════════════════════════════════════════════════════════════════════

const CapacityGuard = (() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    //  CAPACITY KEY LIST
    //
    //  Mirrors SB_CAPACITY_ATTRS in shipBuilder.js exactly so accounting is
    //  always identical to what the capacity bars display.
    // ─────────────────────────────────────────────────────────────────────────

    const CAPACITY_KEYS = [
        'outfit space',
        'engine capacity',
        'weapon capacity',
        'cargo space',
    ];

    // ─────────────────────────────────────────────────────────────────────────
    //  HIGHLIGHT CONTROL
    // ─────────────────────────────────────────────────────────────────────────

    const HIGHLIGHT_MS = 3500;
    let _highlightTimer = null;

    function _highlightViolations(violatedKeys) {
        _clearHighlights();
        if (!violatedKeys || !violatedKeys.length) return;
        const panel = document.getElementById('sbs-root');
        if (!panel) return;
        const lowerKeys = violatedKeys.map(k => k.toLowerCase());
        panel.querySelectorAll('.sbs-card').forEach(card => {
            const labelEl = card.querySelector('.sbs-label');
            if (!labelEl) return;
            if (lowerKeys.some(k => labelEl.textContent.toLowerCase().includes(k)))
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
    //  SBS REFRESH HELPER
    // ─────────────────────────────────────────────────────────────────────────

    function _sbsRefresh() {
        if (typeof SBS !== 'undefined' && typeof SBS.refresh === 'function')
            SBS.refresh();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CORE VIOLATION CHECK — hypothetical outfit list
    //
    //  Uses sbGetOutfitCapacityEffect (from shipBuilder.js) and sbShipCapacity
    //  so the numbers are identical to what the capacity bars show.
    //
    //  hypotheticalOutfits: array of { name, count } — the post-action state
    //  Returns: array of { key, used, max, over }
    // ─────────────────────────────────────────────────────────────────────────

    function _checkViolations(hypotheticalOutfits) {
        const violations = [];

        for (const key of CAPACITY_KEYS) {
            const max = sbShipCapacity(key);
            if (max <= 0) continue;

            let used = 0;
            for (const entry of hypotheticalOutfits) {
                const name   = (entry.name || '').replace(/^"|"$/g, '');
                const count  = parseInt(entry.count) || 1;
                const effect = sbGetOutfitCapacityEffect(name, key);
                // Same formula as sbUsedCapacity: net cost = -effect * count
                used += (-effect) * count;
            }
            used = Math.max(0, used);

            if (used > max) {
                violations.push({ key, used, max, over: used - max });
            }
        }

        return violations;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  VIOLATION CHECK — after an attribute value change
    //
    //  Keeps the current outfit list but substitutes a different max for one
    //  capacity key. Used when testing attr removal or reduction.
    //
    //  overrides: { [capacityKey]: newMaxValue }  (use 0 to simulate removal)
    // ─────────────────────────────────────────────────────────────────────────

    function _checkViolationsWithAttrOverrides(overrides) {
        if (!sbCurrentShip) return [];
        const violations = [];

        for (const key of CAPACITY_KEYS) {
            const max = (key in overrides) ? (Number(overrides[key]) || 0) : sbShipCapacity(key);
            if (max <= 0) continue;

            // Outfit list hasn't changed — use shipBuilder's current used value
            const used = sbUsedCapacity(key);
            if (used > max) {
                violations.push({ key, used, max, over: used - max });
            }
        }

        return violations;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SMART BULK REMOVAL
    //
    //  Finds the minimum number of copies of outfits[i] needed so all other
    //  outfits remain within capacity, removes the surplus, shows a modal.
    //
    //  outfits:    sbCurrentShip.outfits (live reference)
    //  i:          index of outfit to reduce
    //  originalFn: original sbRemoveOutfit (for full removal when minNeeded===0)
    // ─────────────────────────────────────────────────────────────────────────

    function _smartBulkRemove(outfits, i, originalFn) {
        const target     = outfits[i];
        const targetName = (target.name || '').replace(/^"|"$/g, '');
        const oldCount   = parseInt(target.count) || 1;

        // Walk keepCount from 0 upward; stop at the first count that causes
        // no violation — that is the minimum needed.
        let minNeeded = oldCount; // pessimistic: assume we must keep all

        for (let keepCount = 0; keepCount < oldCount; keepCount++) {
            const hypo = outfits
                .map((o, idx) => idx === i ? { ...o, count: keepCount } : { ...o })
                .filter(o => (parseInt(o.count) || 0) > 0);

            if (!_checkViolations(hypo).length) {
                minNeeded = keepCount;
                break;
            }
        }

        if (minNeeded === oldCount) {
            // Cannot remove even one copy — hard block
            const hypoWithout = outfits.filter((_, idx) => idx !== i).map(o => ({ ...o }));
            _showModal(`remove "${targetName}"`, _checkViolations(hypoWithout), null);
            _highlightViolations(CAPACITY_KEYS);
            _sbsRefresh();
            return;
        }

        const removedCount = oldCount - minNeeded;

        if (minNeeded === 0) {
            // All copies safe to remove — use original function for clean teardown
            originalFn.call(window, i);
        } else {
            // Reduce count in-place and re-render
            sbCurrentShip.outfits[i].count = minNeeded;
            sbRenderOutfitsList();
            sbRenderGunsTurrets();
            sbUpdateQuickStats();
            sbRenderRaw();
        }

        _showModal(null, null, {
            type:    'partial',
            name:    targetName,
            removed: removedCount,
            kept:    minNeeded,
        });
        _sbsRefresh();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbRemoveOutfit(i)
    // ─────────────────────────────────────────────────────────────────────────

    function _guardRemoveOutfit(originalFn) {
        return function(i) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, i);

            const outfits = ship.outfits || [];
            const target  = outfits[i];
            if (!target) return originalFn.call(this, i);

            const targetName = (target.name || '').replace(/^"|"$/g, '');

            const hypoWithout = outfits
                .filter((_, idx) => idx !== i)
                .map(o => ({ ...o }));

            const violations = _checkViolations(hypoWithout);

            if (!violations.length) {
                return originalFn.call(this, i); // no problem — allow
            }

            // Outfit provides capacity that others depend on — try smart removal
            const providesCapacity = CAPACITY_KEYS.some(
                key => sbGetOutfitCapacityEffect(targetName, key) > 0
            );

            if (providesCapacity) {
                _smartBulkRemove(outfits, i, originalFn);
            } else {
                _showModal(`remove "${targetName}"`, violations, null);
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
            }
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbUpdateOutfitCount(i, newCount)
    // ─────────────────────────────────────────────────────────────────────────

    function _guardUpdateOutfitCount(originalFn) {
        return function(i, newCountRaw) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, i, newCountRaw);

            const newCount = Math.max(1, parseInt(newCountRaw) || 1);
            const outfits  = ship.outfits || [];
            const target   = outfits[i];
            if (!target) return originalFn.call(this, i, newCountRaw);

            const oldCount = parseInt(target.count) || 1;
            if (newCount === oldCount) return originalFn.call(this, i, newCountRaw);

            if (newCount > oldCount) {
                // Increase — sbCheckOutfitSpace handles the block inside originalFn
                const result = originalFn.call(this, i, newCountRaw);
                _sbsRefresh();
                return result;
            }

            // Decrease — simulate and check
            const hypo = outfits.map((o, idx) =>
                idx === i ? { ...o, count: newCount } : { ...o }
            );
            const violations = _checkViolations(hypo);

            if (!violations.length) {
                return originalFn.call(this, i, newCountRaw);
            }

            _smartBulkRemove(outfits, i, (idx) => originalFn.call(window, idx));
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbRemoveAttr(key)
    // ─────────────────────────────────────────────────────────────────────────

    function _guardRemoveAttr(originalFn) {
        return function(key) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, key);

            if (!CAPACITY_KEYS.includes(key)) return originalFn.call(this, key);

            const violations = _checkViolationsWithAttrOverrides({ [key]: 0 });

            if (violations.length) {
                _showModal(`remove attribute "${key}"`, violations, null);
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
                return; // block
            }

            return originalFn.call(this, key);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbUpdateAttrVal(inp)
    // ─────────────────────────────────────────────────────────────────────────

    function _guardUpdateAttrVal(originalFn) {
        return function(inp) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, inp);

            const key    = inp.dataset.key;
            const newVal = parseFloat(inp.value);
            const oldVal = sbShipCapacity(key); // current max from builder

            if (!CAPACITY_KEYS.includes(key)) return originalFn.call(this, inp);
            if (isNaN(newVal) || newVal >= oldVal) return originalFn.call(this, inp);

            const violations = _checkViolationsWithAttrOverrides({ [key]: newVal });

            if (violations.length) {
                _showModal(`reduce "${key}" to ${newVal}`, violations, null);
                inp.value = String(oldVal); // restore displayed value
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
                return; // block
            }

            return originalFn.call(this, inp);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: confirmAddAttr
    // ─────────────────────────────────────────────────────────────────────────

    function _guardConfirmAddAttr(originalFn) {
        return function(...args) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.apply(this, args);

            const keyEl = document.getElementById('new-attr-key');
            const valEl = document.getElementById('new-attr-val');
            const key   = keyEl?.value?.trim() || '';
            const val   = parseFloat(valEl?.value);

            // Only guard capacity keys being set to a lower value than current
            if (!CAPACITY_KEYS.includes(key) || isNaN(val))
                return originalFn.apply(this, args);

            const currentMax = sbShipCapacity(key);
            if (val >= currentMax) return originalFn.apply(this, args);

            const violations = _checkViolationsWithAttrOverrides({ [key]: val });

            if (violations.length) {
                _showModal(`set "${key}" to ${val}`, violations, null);
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
                return; // block
            }

            return originalFn.apply(this, args);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: addGunTurret(type)
    // ─────────────────────────────────────────────────────────────────────────

    function _guardAddGunTurret(originalFn) {
        return function(type, ...rest) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, type, ...rest);

            // Only guard gun and turret hardpoints
            const attrKey = type === 'gun'    ? 'gun ports'
                          : type === 'turret' ? 'turret mounts'
                          : null;
            if (!attrKey) return originalFn.call(this, type, ...rest);

            const maxPorts = Number((ship.attributes || {})[attrKey]) || 0;
            if (maxPorts <= 0) return originalFn.call(this, type, ...rest); // no attr = no limit

            const field        = type === 'gun' ? 'guns' : 'turrets';
            const currentCount = (ship[field] || []).length;

            if (currentCount >= maxPorts) {
                _showModal(
                    `add ${type} port`,
                    [{ key: attrKey, used: currentCount + 1, max: maxPorts, over: 1 }],
                    null
                );
                _highlightViolations([attrKey]);
                _sbsRefresh();
                return; // block
            }

            return originalFn.call(this, type, ...rest);
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  ATTRIBUTE-LEVEL ADDITION CHECK
    //
    //  sbCheckOutfitSpace (inside shipBuilder) only checks the four capacity
    //  keys. It has no knowledge of attributes like heat dissipation that can
    //  be driven negative by outfit effects (e.g. "Outfitter Expansion").
    //
    //  This function computes the net effect on EVERY attribute of adding
    //  `count` copies of `outfitName` to the current ship, then checks
    //  whether any attribute that must stay non-negative would go negative.
    //
    //  Sign rules come from AttrValidation.getRule (shipBuilderAttrValidation.js)
    //  so we never hardcode attribute names here.
    //
    //  Returns array of { key, currentNet, wouldBe, deficit } for violations.
    // ─────────────────────────────────────────────────────────────────────────

    function _checkAttrViolationsOnAdd(outfitName, count) {
        if (!sbCurrentShip) return [];

        const outfit = sbFindOutfit(outfitName);
        if (!outfit) return [];

        // Collect every numeric attribute the outfit touches
        const outfitAttrs = {};
        for (const src of [outfit.attributes || {}, outfit]) {
            for (const [k, v] of Object.entries(src)) {
                const n = Number(v);
                if (!isNaN(n) && n !== 0) outfitAttrs[k] = n;
            }
        }

        if (!Object.keys(outfitAttrs).length) return [];

        const violations = [];

        for (const [key, perUnitEffect] of Object.entries(outfitAttrs)) {
            // Skip non-attribute fields
            if (['name','displayName','category','cost','thumbnail','sprite',
                 'description','pluginId','weapon','_pn','_pd'].includes(key)) continue;

            const totalEffect = perUnitEffect * count;

            // Only care about effects that make an attribute DECREASE
            if (totalEffect >= 0) continue;

            // Compute the current net value of this attribute on the ship
            // = ship base value + sum of all currently installed outfit contributions
            const shipBase = Number((sbCurrentShip.attributes || {})[key]) || 0;
            let outfitNet = 0;
            for (const entry of (sbCurrentShip.outfits || [])) {
                const n = (entry.name || '').replace(/^"|"$/g, '');
                const c = parseInt(entry.count) || 1;
                outfitNet += sbGetOutfitAttrValue(n, key) * c;
            }
            const currentNet = shipBase + outfitNet;
            const wouldBe    = currentNet + totalEffect;

            // Only flag if the result would be negative AND the attribute must
            // stay non-negative according to AttrValidation rules
            if (wouldBe >= 0) continue;

            // Use AttrValidation if available, otherwise default to min=0
            let min = 0;
            if (typeof AttrValidation !== 'undefined' && typeof AttrValidation.getRule === 'function') {
                const rule = AttrValidation.getRule(key);
                // If min is null the attribute is allowed to go negative — skip
                if (rule.min === null) continue;
                min = rule.min;
            }

            if (wouldBe < min) {
                violations.push({
                    key,
                    currentNet,
                    wouldBe,
                    deficit: min - wouldBe,
                });
            }
        }

        return violations;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GUARD: sbAddOutfitFromPicker / confirmAddOutfit
    //
    //  sbCheckOutfitSpace (called inside the original functions) handles the
    //  four capacity keys. We add a second pass here that checks every other
    //  attribute the outfit affects, blocking if any would go illegally negative.
    // ─────────────────────────────────────────────────────────────────────────

    function _guardAddOutfit(originalFn) {
        return function(...args) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.apply(this, args);

            // Determine outfit name and count from whichever modal is active.
            // sbAddOutfitFromPicker encodes payload in args[0] (base64 JSON).
            // confirmAddOutfit reads directly from DOM inputs.
            let outfitName = null;
            let count      = 1;

            if (args[0] && typeof args[0] === 'string') {
                // sbAddOutfitFromPicker path
                try {
                    const payload = JSON.parse(decodeURIComponent(escape(atob(args[0]))));
                    outfitName = (payload.name || '').replace(/^"|"$/g, '').trim();
                } catch(e) {}
                const countEl = document.getElementById('sb-outfit-count-input');
                count = parseInt(countEl?.value) || 1;
            } else {
                // confirmAddOutfit path
                const nameEl  = document.getElementById('new-outfit-name');
                const countEl = document.getElementById('new-outfit-count');
                outfitName = (nameEl?.value || '').trim().replace(/^"|"$/g, '');
                count      = parseInt(countEl?.value) || 1;
            }

            if (!outfitName) return originalFn.apply(this, args);

            // Check non-capacity attribute violations (capacity is handled by
            // sbCheckOutfitSpace inside the original function)
            const attrViolations = _checkAttrViolationsOnAdd(outfitName, count);

            if (attrViolations.length) {
                _showModal(
                    `add ${count > 1 ? count + '× ' : ''}"${outfitName}"`,
                    attrViolations.map(v => ({
                        key:  v.key,
                        used: -v.wouldBe,          // how far below zero it would go
                        max:  Math.max(0, v.currentNet), // current value (the "budget")
                        over: v.deficit,
                    })),
                    null
                );
                _highlightViolations(attrViolations.map(v => v.key));
                _sbsRefresh();
                return; // block — do not call original
            }

            const result = originalFn.apply(this, args);
            _sbsRefresh();
            return result;
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
    background: rgba(252,129,129,0.12) !important;
    animation: cap-guard-pulse 0.4s ease-in-out 3;
}
@keyframes cap-guard-pulse {
    0%,100% { outline-color: var(--c-danger-hi, #fc8181); }
    50%      { outline-color: transparent; }
}
#modal-cap-guard .cap-guard-violations {
    margin: 4px 0 14px; padding: 0; list-style: none;
}
#modal-cap-guard .cap-guard-violations li {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 6px 10px; margin-bottom: 5px;
    border-radius: var(--r-sm, 6px);
    background: rgba(252,129,129,0.10);
    border: 1px solid rgba(252,129,129,0.25);
    font-size: 0.86rem; color: var(--c-text-mid, #cbd5e0);
}
#modal-cap-guard .cgv-name {
    font-weight: 700; color: var(--c-danger-hi, #fc8181);
}
#modal-cap-guard .cgv-nums {
    font-variant-numeric: tabular-nums; font-size: 0.82rem;
    color: var(--c-text-dim, #718096); white-space: nowrap; margin-left: 12px;
}
#modal-cap-guard .cap-guard-partial-info {
    padding: 10px 14px; margin-bottom: 12px;
    border-radius: var(--r-sm, 6px);
    background: rgba(129,200,252,0.10);
    border: 1px solid rgba(129,200,252,0.25);
    font-size: 0.86rem; color: var(--c-text-mid, #cbd5e0);
}
#modal-cap-guard .cap-guard-partial-info strong { color: var(--c-info-hi, #90cdf4); }
#modal-cap-guard .cap-guard-hint {
    font-size: 0.82rem; color: var(--c-text-muted, #64748b); margin: 0;
}`;
            document.head.appendChild(style);
        }

        if (!document.getElementById(MODAL_ID)) {
            const wrap = document.createElement('div');
            wrap.innerHTML = `
<div id="modal-cap-guard" class="modal-overlay">
  <div class="modal-box" style="width:min(440px,96vw);">
    <div class="modal-header">
      <div class="modal-title" id="cgm-title">Cannot Make Change</div>
      <button class="modal-close"
        onclick="document.getElementById('modal-cap-guard').classList.remove('active')">×</button>
    </div>
    <p class="confirm-text" id="cgm-action" style="margin-bottom:12px;"></p>
    <div id="cgm-partial"></div>
    <ul class="cap-guard-violations" id="cgm-list"></ul>
    <p class="cap-guard-hint" id="cgm-hint"></p>
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

    function _capWords(s) {
        return String(s).split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    function _showModal(actionDesc, violations, partialInfo) {
        _injectStyles();

        const titleEl   = document.getElementById('cgm-title');
        const actionEl  = document.getElementById('cgm-action');
        const listEl    = document.getElementById('cgm-list');
        const partialEl = document.getElementById('cgm-partial');
        const hintEl    = document.getElementById('cgm-hint');

        if (partialEl) partialEl.innerHTML = '';
        if (listEl)    listEl.innerHTML    = '';
        if (actionEl)  actionEl.textContent = '';
        if (hintEl)    hintEl.textContent   = '';

        if (partialInfo?.type === 'partial') {
            if (titleEl)  titleEl.textContent = 'Partial Removal';
            if (actionEl) actionEl.textContent =
                `Not all copies of "${partialInfo.name}" could be removed.`;

            if (partialEl) {
                const keptLine = partialInfo.kept > 0
                    ? ` <strong>${partialInfo.kept}</strong> cop${partialInfo.kept === 1 ? 'y' : 'ies'} must remain to support other installed outfits.`
                    : '';
                partialEl.innerHTML = `<div class="cap-guard-partial-info">
                    <strong>${partialInfo.removed}</strong>
                    cop${partialInfo.removed === 1 ? 'y' : 'ies'} removed.${keptLine}
                </div>`;
            }
            if (hintEl) hintEl.textContent =
                'Remove outfits that depend on this capacity first to free up more.';

        } else {
            if (titleEl)  titleEl.textContent  = 'Cannot Make Change';
            if (actionEl) actionEl.textContent =
                `This action would exceed capacity: ${actionDesc}`;

            if (listEl && violations?.length) {
                listEl.innerHTML = violations.map(v => `<li>
                    <span class="cgv-name">${_capWords(v.key)}</span>
                    <span class="cgv-nums">
                        ${Math.round(v.used)} used / ${Math.round(v.max)} max
                        &nbsp;(${Math.round(v.over)} over)
                    </span>
                </li>`).join('');
            }
            if (hintEl) hintEl.textContent = 'Remove other outfits first to free up space.';
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
            } else {
                console.warn(`[CapacityGuard] ${name} not found — skipping.`);
            }
        };

        wrap('sbRemoveOutfit',        _guardRemoveOutfit);
        wrap('sbUpdateOutfitCount',   _guardUpdateOutfitCount);
        wrap('sbRemoveAttr',          _guardRemoveAttr);
        wrap('sbUpdateAttrVal',       _guardUpdateAttrVal);
        wrap('confirmAddAttr',        _guardConfirmAddAttr);
        wrap('addGunTurret',          _guardAddGunTurret);
        wrap('sbAddOutfitFromPicker', _guardAddOutfit);
        wrap('confirmAddOutfit',      _guardAddOutfit);

        console.log('[CapacityGuard] Installed on 8 functions.');
    }

    return { install };

})();

document.addEventListener('DOMContentLoaded', () => {
    CapacityGuard.install();
});
