'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderOutfitExpander.js  —  Expandable Outfit Detail Panels
//
//  INTEGRATION
//  ─────────────────────────────────────────────────────────────────────────────
//  Load AFTER all other builder scripts:
//
//      <script src="../JavaScript/shipBuilder.js"></script>
//      <script src="../JavaScript/shipBuilderRequiredAttrs.js"></script>
//      <script src="../JavaScript/shipBuilderAttrValidation.js"></script>
//      <script src="../JavaScript/shipBuilderCapacityGuard.js"></script>
//      <script src="../JavaScript/computedStats.js"></script>
//      <script src="../JavaScript/shipBuilderStats.js"></script>
//      <script src="../JavaScript/shipBuilderOutfitExpander.js"></script>
//
//  WHAT THIS DOES
//  ─────────────────────────────────────────────────────────────────────────────
//  Adds a ▶ expand toggle to:
//
//    1. Every installed-outfit row in the ship builder outfit list
//       (#outfits-list .outfit-item)
//
//    2. Every outfit row in the outfit picker modal
//       (#sb-outfit-picker-list .sb-picker-row)
//
//  Clicking the toggle expands a detail panel directly below the row showing:
//    • The outfit image (thumbnail → sprite → initials fallback)
//    • Every computed stat from ComputedStats.getComputedStatsForAttrs()
//      grouped exactly as attrDefs defines them (displayUnit, displayMultiplier)
//    • Raw numeric attributes that have no computed equivalent
//    • A description if present on the outfit object
//
//  All stat keys, groupings, multipliers, and units come from window.attrDefs —
//  zero hardcoded attribute names or display rules.
//
//  DESIGN
//  ─────────────────────────────────────────────────────────────────────────────
//  • CSS tokens are all var(--c-*) / var(--r-*) from main.css — nothing hardcoded
//  • One expanded panel at a time per context (installed list vs picker)
//  • Panel is injected as a sibling <div> immediately after the row wrapper
//  • Works even if ComputedStats is not ready — falls back to raw attrs only
//  • Re-hooks automatically whenever sbRenderOutfitsList or sbOpenOutfitPicker
//    re-renders their lists (both are patched below)
// ═══════════════════════════════════════════════════════════════════════════════

const OutfitExpander = (() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    //  CONSTANTS
    // ─────────────────────────────────────────────────────────────────────────

    // CSS class names — only place class names are defined
    const CLS = {
        toggle:        'oe-toggle',
        panel:         'oe-panel',
        panelOpen:     'oe-panel--open',
        img:           'oe-img',
        imgWrap:       'oe-img-wrap',
        imgInitials:   'oe-img-initials',
        statGrid:      'oe-stat-grid',
        statCard:      'oe-stat-card',
        statLabel:     'oe-stat-label',
        statValue:     'oe-stat-value',
        statUnit:      'oe-stat-unit',
        groupTitle:    'oe-group-title',
        description:   'oe-description',
        noStats:       'oe-no-stats',
        wrapper:       'oe-wrapper',       // wraps row + panel so they stay together
        pickerWrapper: 'oe-picker-wrapper',
    };

    // Keys we never show — internal/meta fields
    const META_KEYS = new Set([
        'name','displayName','category','series','index','cost','thumbnail',
        'sprite','description','pluginId','weapon','governments','locations',
        '_internalId','_pluginId','_hash','_pn','_pd','_isVariant',
        'spriteData','attributes',
    ]);

    // Tracks which panel is currently open in each context
    const _openPanels = {
        installed: null,   // { wrapper, toggle }
        picker:    null,
    };

    // ─────────────────────────────────────────────────────────────────────────
    //  OUTFIT LOOKUP  — same approach as shipBuilder.js
    // ─────────────────────────────────────────────────────────────────────────

    function _findOutfit(name) {
        const clean = name.replace(/^"|"$/g, '').trim();

        // 1. sbFindOutfit from shipBuilder.js (respects live data)
        if (typeof sbFindOutfit === 'function') {
            const found = sbFindOutfit(clean);
            if (found) return found;
        }

        // 2. Walk window.allData directly as a fallback
        const allData = window.allData || {};
        for (const pluginData of Object.values(allData)) {
            const outfits = pluginData.outfits || [];
            const found   = outfits.find(o =>
                (o.name || o.displayName || '').replace(/^"|"$/g, '').trim() === clean
            );
            if (found) return found;
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  FLAT ATTRIBUTE MAP  — merges outfit.attributes sub-object + top-level
    // ─────────────────────────────────────────────────────────────────────────

    function _flatAttrs(outfit) {
        if (!outfit) return {};
        const result = {};
        // Top-level numeric fields first
        for (const [k, v] of Object.entries(outfit)) {
            if (META_KEYS.has(k) || k.startsWith('_')) continue;
            if (typeof v === 'number') result[k] = v;
        }
        // attributes sub-object overrides (remote plugin JSON format)
        for (const [k, v] of Object.entries(outfit.attributes || {})) {
            if (META_KEYS.has(k) || k.startsWith('_')) continue;
            if (typeof v === 'number') result[k] = v;
            else if (typeof v === 'string') {
                const n = parseFloat(v);
                if (!isNaN(n)) result[k] = n;
            }
        }
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  COMPUTED STATS  — calls ComputedStats if available
    // ─────────────────────────────────────────────────────────────────────────

    function _computeStats(attrs) {
        if (
            typeof ComputedStats !== 'undefined' &&
            typeof ComputedStats.getComputedStatsForAttrs === 'function' &&
            ComputedStats.isReady()
        ) {
            try {
                return ComputedStats.getComputedStatsForAttrs(attrs);
            } catch (e) {
                console.warn('[OutfitExpander] ComputedStats error:', e);
            }
        }
        return { ...attrs };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  FORMAT  — mirrors _fmt in shipBuilderStats.js
    // ─────────────────────────────────────────────────────────────────────────

    function _fmt(v) {
        if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '—';
        if (typeof v !== 'number') return String(v);
        if (Number.isInteger(v) && Math.abs(v) >= 1000) return v.toLocaleString();
        return parseFloat(v.toPrecision(4)).toString();
    }

    function _esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function _capWords(s) {
        return String(s).split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  STAT PANEL HTML  — fully driven by attrDefs
    // ─────────────────────────────────────────────────────────────────────────

function _buildStatPanel(outfit) {
    if (!outfit) return `<div class="${CLS.panel}"><div class="${CLS.noStats}">Outfit data not found.</div></div>`;
    return `<div class="${CLS.panel}">
        <div class="${CLS.imgWrap}">
            <div class="${CLS.imgInitials}">${_esc(
                (outfit.name || '?').replace(/^"|"$/g, '').trim()
                    .split(/\s+/).slice(0,2).map(w => w[0] || '').join('').toUpperCase()
            )}</div>
        </div>
        <div class="oe-stats-body"></div>
    </div>`;
}

function _populatePanel(panel, outfit) {
    const pluginId = outfit._pluginId || outfit._pn || null;

    const imgWrap    = panel.querySelector('.' + CLS.imgWrap);
    const spritePath = outfit.thumbnail || outfit.sprite || null;

    if (spritePath && typeof window.fetchSprite === 'function' && imgWrap) {
        if (pluginId && typeof window.setCurrentPlugin === 'function') {
            window.setCurrentPlugin(pluginId);
        }
        if (typeof window.initImageIndex === 'function') {
            window.initImageIndex(pluginId || undefined);
        }
        window.fetchSprite(spritePath, outfit.spriteData || {})
            .then(element => {
                if (!element || !imgWrap.isConnected) return;
                element.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
                imgWrap.innerHTML = '';
                imgWrap.appendChild(element);
            })
            .catch(() => {});
    }

    const statsBody = panel.querySelector('.oe-stats-body');
    if (!statsBody) return;

    if (!window.AttributeDisplay?.renderAttributesTabEnhanced || !window.attrDefs) {
        statsBody.innerHTML = '<div class="oe-no-stats">Stats unavailable — data still loading.</div>';
        return;
    }

    // ── Normalise the outfit so both AttributeDisplay and ComputedStats
    //    can find all attributes regardless of whether the data came from
    //    a remote plugin (attributes sub-object) or local build (top-level).
    //
    //    AttributeDisplay (outfits branch) reads Object.entries(item) for
    //    top-level keys, so we merge attributes sub-object up to top level.
    //
    //    ComputedStats.getComputedStats reads item.attributes OR top-level
    //    numeric keys, so we also preserve the sub-object.
    //
    //    We also ensure _pluginId is set so calcDerivedStats doesn't skip
    //    the getComputedStats call.
    // ──────────────────────────────────────────────────────────────────────

    const subAttrs  = outfit.attributes || {};
    const normalised = { ...outfit };   // shallow copy — don't mutate original

    // Merge sub-object attributes up to top level (only if not already present)
    for (const [k, v] of Object.entries(subAttrs)) {
        if (!(k in normalised)) normalised[k] = v;
    }

    // Ensure attributes sub-object is also present (ComputedStats reads it)
    if (!normalised.attributes) normalised.attributes = subAttrs;

    // Ensure _pluginId so calcDerivedStats doesn't skip getComputedStats
    if (!normalised._pluginId && pluginId) normalised._pluginId = pluginId;

    // If ComputedStats is ready, pre-warm getComputedStats so calcDerivedStats
    // hits the cache instead of recomputing from scratch
    if (
        typeof window.getComputedStats === 'function' &&
        typeof window.ComputedStats    !== 'undefined' &&
        window.ComputedStats.isReady() &&
        normalised._pluginId
    ) {
        try {
            window.getComputedStats(normalised, normalised._pluginId);
        } catch (e) {
            console.warn('[OE] ComputedStats pre-warm error:', e);
        }
    }

    statsBody.innerHTML = window.AttributeDisplay.renderAttributesTabEnhanced(
        normalised, window.attrDefs, 'outfits', normalised._pluginId
    );
}
    
    // ─────────────────────────────────────────────────────────────────────────
    //  TOGGLE LOGIC
    // ─────────────────────────────────────────────────────────────────────────

    function _closePanel(context) {
        const state = _openPanels[context];
        if (!state) return;
        const { wrapper, toggle } = state;
        const panel = wrapper.querySelector('.' + CLS.panel);
        if (panel) {
            panel.classList.remove(CLS.panelOpen);
            // Remove after transition
            panel.addEventListener('transitionend', () => panel.remove(), { once: true });
            setTimeout(() => { if (panel.parentNode) panel.remove(); }, 320);
        }
        toggle.textContent  = '▶';
        toggle.setAttribute('aria-expanded', 'false');
        _openPanels[context] = null;
    }
    
function _openPanel(context, wrapper, toggle, outfitName) {
    _closePanel(context);

    const outfit = _findOutfit(outfitName);
    if (!outfit && !outfitName) return;

    const div       = document.createElement('div');
    div.innerHTML   = _buildStatPanel(outfit || { name: outfitName });
    const panel     = div.firstElementChild;
    wrapper.appendChild(panel);

    // Populate image + stats now the panel is in the DOM
    if (outfit) _populatePanel(panel, outfit);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => panel.classList.add(CLS.panelOpen));
    });

    toggle.textContent = '▼';
    toggle.setAttribute('aria-expanded', 'true');
    _openPanels[context] = { wrapper, toggle };
}

    function _handleToggle(context, wrapper, toggle, outfitName) {
        const isOpen = toggle.getAttribute('aria-expanded') === 'true';
        if (isOpen) {
            _closePanel(context);
        } else {
            _openPanel(context, wrapper, toggle, outfitName);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HOOK: installed outfit list  (#outfits-list)
    //
    //  sbRenderOutfitsList outputs flat .outfit-item divs.  We wrap each in a
    //  .oe-wrapper, then inject the toggle button into the row itself.
    //  We do this post-render via a MutationObserver + direct call after patch.
    // ─────────────────────────────────────────────────────────────────────────

    function _hookInstalledList() {
        const listEl = document.getElementById('outfits-list');
        if (!listEl) return;

        // Process each .outfit-item that hasn't been wrapped yet
        listEl.querySelectorAll('.outfit-item:not([data-oe-hooked])').forEach(item => {
            item.setAttribute('data-oe-hooked', '1');

            // Extract outfit name from the .outfit-item__name span
            const nameEl = item.querySelector('.outfit-item__name');
            if (!nameEl) return;
            const outfitName = nameEl.getAttribute('title') || nameEl.textContent.trim();

            // Inject toggle button at the start of the row
            const btn = document.createElement('button');
            btn.className    = CLS.toggle + ' oe-toggle--installed';
            btn.textContent  = '▶';
            btn.title        = 'Show outfit details';
            btn.setAttribute('aria-expanded', 'false');
            btn.type         = 'button';

            // Wrap item + future panel in a wrapper div
            const wrapper = document.createElement('div');
            wrapper.className = CLS.wrapper;
            item.parentNode.insertBefore(wrapper, item);
            wrapper.appendChild(item);

            item.insertBefore(btn, item.firstChild);

            btn.addEventListener('click', e => {
                e.stopPropagation();
                _handleToggle('installed', wrapper, btn, outfitName);
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HOOK: outfit picker rows  (#sb-outfit-picker-list)
    // ─────────────────────────────────────────────────────────────────────────

    function _hookPickerList() {
        const listEl = document.getElementById('sb-outfit-picker-list');
        if (!listEl) return;

        listEl.querySelectorAll('.sb-picker-row:not([data-oe-hooked])').forEach(row => {
            row.setAttribute('data-oe-hooked', '1');

            const nameEl = row.querySelector('.sb-picker-name');
            if (!nameEl) return;
            const outfitName = nameEl.textContent.trim();

            // Inject toggle at the very end of the row (after all existing children)
            const btn = document.createElement('button');
            btn.className   = CLS.toggle + ' oe-toggle--picker';
            btn.textContent = '▶';
            btn.title       = 'Show outfit details';
            btn.setAttribute('aria-expanded', 'false');
            btn.type        = 'button';

            // Wrap row + future panel
            const wrapper = document.createElement('div');
            wrapper.className = CLS.pickerWrapper;
            row.parentNode.insertBefore(wrapper, row);
            wrapper.appendChild(row);

            // Stop the row's own click from firing when the button is clicked
            row.appendChild(btn);

            btn.addEventListener('click', e => {
                e.stopPropagation(); // don't trigger sbAddOutfitFromPicker
                _handleToggle('picker', wrapper, btn, outfitName);
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PATCH builder functions so hooks re-run after every render
    // ─────────────────────────────────────────────────────────────────────────

    function _patchBuilderFunctions() {
        // Installed list re-rendered by sbRenderOutfitsList
        if (typeof window.sbRenderOutfitsList === 'function') {
            const orig = window.sbRenderOutfitsList;
            window.sbRenderOutfitsList = function (...args) {
                const r = orig.apply(this, args);
                // Close open panel first (index may have shifted)
                _openPanels.installed = null;
                requestAnimationFrame(_hookInstalledList);
                return r;
            };
        }

        // Picker list re-rendered by sbOpenOutfitPicker
        if (typeof window.sbOpenOutfitPicker === 'function') {
            const orig = window.sbOpenOutfitPicker;
            window.sbOpenOutfitPicker = function (...args) {
                const r = orig.apply(this, args);
                _openPanels.picker = null;
                requestAnimationFrame(_hookPickerList);
                return r;
            };
        }

        // Also hook after picker search filter changes (rows toggled visible/hidden)
        if (typeof window.sbFilterOutfitPicker === 'function') {
            const orig = window.sbFilterOutfitPicker;
            window.sbFilterOutfitPicker = function (...args) {
                const r = orig.apply(this, args);
                requestAnimationFrame(_hookPickerList);
                return r;
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  STYLES
    // ─────────────────────────────────────────────────────────────────────────

    function _injectStyles() {
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  INSTALL
    // ─────────────────────────────────────────────────────────────────────────

    function install() {
        _injectStyles();
        _patchBuilderFunctions();

        // Hook any list that's already rendered (e.g. if builder opened before install)
        requestAnimationFrame(() => {
            _hookInstalledList();
            _hookPickerList();
        });

        console.log('[OutfitExpander] Installed.');
    }

    return { install };

})();

document.addEventListener('DOMContentLoaded', () => {
    OutfitExpander.install();
});
