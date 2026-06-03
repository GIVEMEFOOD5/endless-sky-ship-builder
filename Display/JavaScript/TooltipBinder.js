'use strict';

// ─── TooltipBinder.js ─────────────────────────────────────────────────────────
//
// Bridges window.attrDefs.tooltips (produced by attributeParser.js) into the
// existing data-tooltip / initTooltips() system already in the frontend.
//
// Key problem solved:
//   Display labels like "Hull DPS" must NOT fall back to the bare key "hull"
//   (which is the hull-strength stat), they should resolve to
//   "hull damage / second" from the tooltips file, or return null.
//   The lookup tries increasingly specific keys before any suffix stripping,
//   and never strips a suffix if it would land on a known bare stat name.
//
// Usage:
//   const tip = window.TooltipBinder.get(attrKey);
//   if (tip) row.dataset.tooltip = tip;
//
//   — or —
//   window.TooltipBinder.stamp(row, attrKey);   // null-safe one-liner
// ─────────────────────────────────────────────────────────────────────────────

window.TooltipBinder = (() => {

    // ── Known bare stat names that must NOT be used as fallbacks ─────────────
    // If stripping a suffix would land on one of these, we stop rather than
    // returning the wrong tooltip (e.g. "Hull DPS" must not get the "hull"
    // strength description).
    const BARE_STAT_NAMES = new Set([
        'hull', 'shields', 'mass', 'drag', 'thrust', 'turn', 'cost',
        'bunks', 'cargo space', 'fuel capacity', 'energy capacity',
        'outfit space', 'weapon capacity', 'engine capacity',
        'heat', 'energy', 'fuel', 'armor', 'cloak',
    ]);

    // ── Key normalisation ─────────────────────────────────────────────────────

    function _norm(raw) {
        return String(raw ?? '')
            .toLowerCase()
            .replace(/:$/, '')       // strip trailing colon (tooltips.txt style)
            .replace(/\s+/g, ' ')    // collapse whitespace
            .trim();
    }

    function _tips() {
        return window.attrDefs?.tooltips ?? {};
    }

    // ── Core lookup ───────────────────────────────────────────────────────────
    // Tries keys from most-specific to least-specific.
    // Never lets a DPS/damage label fall through to a bare stat name.

    function _lookup(raw) {
        const tips = _tips();
        if (!raw) return null;

        const key = _norm(raw);
        if (!key) return null;

        // 1. Direct match (covers exact attribute keys and display labels that
        //    already match a tooltip key, e.g. "hull repair rate", "shields")
        if (key in tips) return tips[key] || null;

        // 2. DPS-type labels: "Hull DPS", "Shield DPS", "Ion DPS", etc.
        //    Try '<base> damage / second', '<base> damage / shot', '<base> / second'
        //    in that order.  Do NOT fall through to bare base — that would give
        //    the hull-strength tooltip for "Hull DPS".
        const dpsMatch = key.match(/^(.+?)\s+dps$/i);
        if (dpsMatch) {
            const base = dpsMatch[1].trim();
            const candidates = [
                base + ' damage / second',
                base + ' damage / shot',
                base + ' / second',
                base + ' / shot',
                base + ' damage',
            ];
            for (const c of candidates) {
                if (c in tips) return tips[c] || null;
            }
            return null;   // intentional: no fallback to bare base
        }

        // 3. "/s" suffix labels: "Energy/s", "Heat/s" etc.
        const slashSMatch = key.match(/^(.+?)\s+\/s$/i);
        if (slashSMatch) {
            const base = slashSMatch[1].trim();
            if ((base + ' / second') in tips) return tips[base + ' / second'] || null;
            // Only fall back to bare base if it's not an ambiguous stat name
            if (base in tips && !BARE_STAT_NAMES.has(base)) return tips[base] || null;
            return null;
        }

        // 4. Weapon-panel keys already contain "/ second" or "/ shot" —
        //    try appending them to the key as-is
        for (const sfx of [' / second', ' / shot']) {
            if ((key + sfx) in tips) return tips[key + sfx] || null;
        }

        // 5. Strip tightly-defined display suffixes (not DPS — handled above)
        //    Only strip if the result is not a bare stat name.
        const suffixReplacements = [
            [/\s+energy\/s$/i,  ' energy'],
            [/\s+heat\/s$/i,    ' heat'],
            [/\s+per second$/i, ''],
            [/\s+per frame$/i,  ''],
        ];
        for (const [re, repl] of suffixReplacements) {
            if (re.test(key)) {
                const stripped = key.replace(re, repl).trim();
                if (stripped && (stripped in tips) && !BARE_STAT_NAMES.has(stripped))
                    return tips[stripped] || null;
            }
        }

        // 6. Attribute keys ending in " damage" that have no tooltip of their own:
        //    try the bare name (e.g. "ion damage" → "ion") — but only for
        //    damage keys, not for stat names.
        if (key.endsWith(' damage') && !BARE_STAT_NAMES.has(key)) {
            const bare = key.replace(/ damage$/, '');
            if (bare in tips && !BARE_STAT_NAMES.has(bare)) return tips[bare] || null;
        }

        return null;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** get(key) → string | null */
    function get(key) {
        return _lookup(key) ?? null;
    }

    /**
     * stamp(element, key?)
     * Sets element.dataset.tooltip if a tip is found.
     * Marks auto-set tooltips so they can be replaced on re-bind.
     */
    function stamp(element, key) {
        if (!element) return;
        const tip = _lookup(key ?? element.dataset.tooltipKey ?? element.textContent);
        if (tip) {
            element.dataset.tooltip    = tip;
            element.dataset.tooltipAuto = '1';
        } else if (element.dataset.tooltipAuto) {
            // Clean up a previously auto-set tooltip that no longer matches
            delete element.dataset.tooltip;
            delete element.dataset.tooltipAuto;
        }
    }

    // ── bindRows ──────────────────────────────────────────────────────────────

    const ROW_SELECTOR = [
        '.ad-row',
        '.compare-col__row',
        '.compare-table__key',
        '[data-tooltip-key]',
    ].join(', ');

    function _keyFromRow(el) {
        if (el.dataset.tooltipKey) return el.dataset.tooltipKey;
        const label = el.querySelector('.ad-label, .compare-col__key');
        if (label) return label.textContent;
        if (el.classList.contains('compare-table__key')) return el.textContent;
        return el.textContent;
    }

    function bindRows(root) {
        const tips = _tips();
        if (!tips || !Object.keys(tips).length) return;
        const container = root ?? document;
        container.querySelectorAll(ROW_SELECTOR).forEach(el => {
            if (el.dataset.tooltip && !el.dataset.tooltipAuto) return;
            stamp(el, _keyFromRow(el));
        });
    }

    // ── Auto-init ─────────────────────────────────────────────────────────────

    function _autoInit() {
        bindRows();

        const obs = new MutationObserver(mutations => {
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.(ROW_SELECTOR)) {
                        stamp(node, _keyFromRow(node));
                    } else if (node.querySelector) {
                        bindRows(node);
                    }
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });

        // Poll until attrDefs is loaded (handles async load order)
        let attempts = 0;
        const poll = setInterval(() => {
            attempts++;
            if (Object.keys(_tips()).length) { bindRows(); clearInterval(poll); }
            if (attempts > 40) clearInterval(poll);
        }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _autoInit);
    } else {
        _autoInit();
    }

    return { get, stamp, bindRows };

})();
