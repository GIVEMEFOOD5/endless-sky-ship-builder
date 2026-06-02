'use strict';

// ─── TooltipBinder.js ─────────────────────────────────────────────────────────
//
// Bridges window.attrDefs.tooltips (produced by attributeParser.js) into the
// existing data-tooltip / initTooltips() system already in the frontend.
//
// How it works:
//   1. get(key) — looks up a tooltip string for any attribute key.
//      Tries the exact key first, then a handful of normalised variants so
//      display labels like "Hull Repair Rate" match the stored key
//      "hull repair rate", and weapon-panel suffixes like "DPS" are stripped.
//
//   2. stamp(element, key) — sets element.dataset.tooltip = text if found.
//      Safe to call unconditionally; does nothing when no match.
//
//   3. bindRows(root?) — scans the DOM under `root` (default: document) for
//      .ad-row and .compare-col__row elements that already have a
//      data-tooltip-key or whose .ad-label/.compare-col__key child text can
//      be used as a key.  Sets data-tooltip on any that match.
//      Called automatically on DOMContentLoaded and whenever the compare
//      panel opens (via MutationObserver).
//
// Usage in row-building code (AttributeDisplay.js, CompareDisplay.js etc.):
//
//   const tip = window.TooltipBinder.get(attrKey);
//   if (tip) row.dataset.tooltip = tip;
//
// Or just call window.TooltipBinder.stamp(row, attrKey) and it handles the
// null-check itself.
// ─────────────────────────────────────────────────────────────────────────────

window.TooltipBinder = (() => {

    // ── Key normalisation ─────────────────────────────────────────────────────

    function _norm(raw) {
        return String(raw ?? '')
            .toLowerCase()
            .replace(/:$/, '')      // strip trailing colon (tooltips.txt style)
            .replace(/\s+/g, ' ')   // collapse whitespace
            .trim();
    }

    // Resolved once on first call to get()
    function _tips() {
        return window.attrDefs?.tooltips ?? {};
    }

    // Try a sequence of progressively-simplified keys until one hits.
    // This handles the mismatches between display labels and stored keys:
    //   "Hull Repair Rate"     → "hull repair rate"           ✓ direct match
    //   "Total DPS"            → no match → try without known suffixes
    //   "ion damage / second"  → direct match in tooltips obj  ✓
    //   "Shield DPS"           → strip " dps" → "shield"? no → try "shield damage" → no
    //                          → falls through gracefully
    function _lookup(raw) {
        const tips = _tips();
        if (!raw || !tips) return null;

        const key = _norm(raw);
        if (!key) return null;

        // 1. Direct match
        if (tips[key]) return tips[key];

        // 2. Strip common display suffixes added by the frontend
        const suffixStripped = key
            .replace(/\s+dps$/i, '')
            .replace(/\s+\/s$/i, '')
            .replace(/\s+per second$/i, '')
            .replace(/\s+per frame$/i, '')
            .replace(/\s+energy\/s$/i, ' energy')
            .replace(/\s+heat\/s$/i,   ' heat')
            .trim();
        if (suffixStripped !== key && tips[suffixStripped]) return tips[suffixStripped];

        // 3. Weapon-panel: try appending "/ second" or "/ shot"
        for (const sfx of [' / second', ' / shot']) {
            if (tips[key + sfx]) return tips[key + sfx];
        }

        // 4. Strip leading four-space indent (some tooltips.txt keys have it)
        const trimmed = key.replace(/^\s+/, '');
        if (trimmed !== key && tips[trimmed]) return tips[trimmed];

        // 5. "X damage" → try without " damage" suffix (e.g. "ion damage" → "ion")
        //    and vice-versa
        if (key.endsWith(' damage') && tips[key.replace(/ damage$/, '')])
            return tips[key.replace(/ damage$/, '')];
        if (!key.endsWith(' damage') && tips[key + ' damage'])
            return tips[key + ' damage'];

        return null;
    }

    // ── Public: get ───────────────────────────────────────────────────────────

    function get(key) {
        return _lookup(key) ?? null;
    }

    // ── Public: stamp ─────────────────────────────────────────────────────────
    // Sets element.dataset.tooltip if a tip is found; removes stale ones otherwise.

    function stamp(element, key) {
        if (!element) return;
        const tip = _lookup(key ?? element.dataset.tooltipKey ?? element.textContent);
        if (tip) {
            element.dataset.tooltip = tip;
        } else {
            // Don't overwrite a tooltip that was set by other means (e.g. custom description)
            if (element.dataset.tooltipAuto) delete element.dataset.tooltip;
        }
        if (tip) element.dataset.tooltipAuto = '1'; // mark as auto-set so we can clean it up
    }

    // ── Public: bindRows ──────────────────────────────────────────────────────
    // Scans the subtree for attribute rows and stamps tooltips on them.

    const ROW_SELECTOR = [
        '.ad-row',
        '.compare-col__row',
        '.compare-table__key',
        '[data-tooltip-key]',
    ].join(', ');

    function _keyFromRow(el) {
        // Prefer explicit data-tooltip-key
        if (el.dataset.tooltipKey) return el.dataset.tooltipKey;
        // For .ad-row: child .ad-label holds the attribute name
        const label = el.querySelector('.ad-label, .compare-col__key');
        if (label) return label.textContent;
        // Table key cell: textContent is the label
        if (el.classList.contains('compare-table__key')) return el.textContent;
        return el.textContent;
    }

    function bindRows(root) {
        const tips = _tips();
        if (!tips || !Object.keys(tips).length) return; // not loaded yet

        const container = root ?? document;
        container.querySelectorAll(ROW_SELECTOR).forEach(el => {
            // Skip rows that already have a manually-set tooltip (not auto-set)
            if (el.dataset.tooltip && !el.dataset.tooltipAuto) return;
            stamp(el, _keyFromRow(el));
        });
    }

    // ── Auto-bind on load ─────────────────────────────────────────────────────

    function _autoInit() {
        // Initial bind (in case attrDefs is already loaded)
        bindRows();

        // Re-bind whenever new rows appear (compare panel, modal tabs etc.)
        const obs = new MutationObserver(mutations => {
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    // Bind the subtree of any added element
                    if (node.matches?.(ROW_SELECTOR)) {
                        stamp(node, _keyFromRow(node));
                    } else if (node.querySelector) {
                        bindRows(node);
                    }
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });

        // Also re-bind when attrDefs finishes loading (it may arrive after DOM)
        // Poll briefly then give up — avoids a hard dependency on load order
        let attempts = 0;
        const poll = setInterval(() => {
            attempts++;
            const tips = _tips();
            if (Object.keys(tips).length) {
                bindRows();
                clearInterval(poll);
            }
            if (attempts > 40) clearInterval(poll); // give up after ~4s
        }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _autoInit);
    } else {
        _autoInit();
    }

    return { get, stamp, bindRows };

})();
