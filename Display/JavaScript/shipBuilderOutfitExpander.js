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

    const pluginId = outfit._pluginId || outfit._pn || null;

    // ── Tabs — same logic as DataViewer.getAvailableTabs ──────────────────
    const tabs = [{ id: 'attributes', label: 'Attributes' }];
    if (outfit.locations && Object.keys(outfit.locations).length > 0)
        tabs.push({ id: 'locations', label: 'Locations' });
    if (outfit.thumbnail)
        tabs.push({ id: 'thumbnail', label: 'Thumbnail' });
    if (outfit.weapon?.['hardpoint sprite'])
        tabs.push({ id: 'hardpointSprite', label: 'Hardpoint' });
    if (outfit.sprite || outfit.weapon?.sprite)
        tabs.push({ id: 'sprite', label: 'Sprite' });

    const panelId = 'oe-panel-' + Math.random().toString(36).slice(2);

    // ── Tab bar HTML ───────────────────────────────────────────────────────
    const tabBarHtml = tabs.length > 1
        ? `<div class="oe-modal-tabs">
            ${tabs.map((t, i) =>
                `<button class="oe-modal-tab${i === 0 ? ' active' : ''}"
                    data-panel="${panelId}" data-tab="${t.id}"
                    onclick="OutfitExpander._switchTab(this,'${panelId}')">
                    ${_esc(t.label)}
                </button>`
            ).join('')}
           </div>`
        : '';

    // ── Tab pane stubs — content loaded on demand ──────────────────────────
    const panesHtml = tabs.map((t, i) =>
        `<div class="oe-tab-pane${i === 0 ? ' oe-tab-pane--active' : ''}"
              data-panel="${panelId}" data-tab="${t.id}"
              data-loaded="false">
         </div>`
    ).join('');

    // ── Description ────────────────────────────────────────────────────────
    const desc = outfit.description || (outfit.attributes || {}).description || '';
    const descHtml = desc
        ? `<div class="${CLS.description}">${_esc(desc)}</div>`
        : '';

    const html = `
<div class="${CLS.panel}" data-panel-id="${panelId}" data-outfit-name="${_esc((outfit.name || '').replace(/^"|"$/g, ''))}">
    ${tabBarHtml}
    <div class="oe-tab-panes">
        ${panesHtml}
    </div>
    ${descHtml}
</div>`;

    return html;
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

    // Called when a tab button is clicked
function _switchTab(btn, panelId) {
    const panel   = document.querySelector(`[data-panel-id="${panelId}"]`);
    if (!panel) return;
    const tabId   = btn.dataset.tab;

    // Update active tab button
    panel.querySelectorAll('.oe-modal-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tabId)
    );

    // Show correct pane
    panel.querySelectorAll('.oe-tab-pane').forEach(p => {
        p.classList.toggle('oe-tab-pane--active', p.dataset.tab === tabId);
    });

    // Load content if not already loaded
    const pane = panel.querySelector(`.oe-tab-pane[data-tab="${tabId}"]`);
    if (pane && pane.dataset.loaded === 'false') {
        _loadTabContent(panel, pane, tabId);
    }
}

// Loads content into a pane — mirrors DataViewer.switchModalTab
function _loadTabContent(panel, pane, tabId) {
    pane.dataset.loaded = 'true';
    const outfitName    = panel.dataset.outfitName;
    const outfit        = _findOutfit(outfitName);
    if (!outfit) {
        pane.innerHTML = `<div class="${CLS.noStats}">Outfit data not found.</div>`;
        return;
    }

    const pluginId = outfit._pluginId || outfit._pn || null;

    if (tabId === 'attributes') {
        // Use AttributeDisplay.renderAttributesTabEnhanced exactly like DataViewer
        if (window.AttributeDisplay?.renderAttributesTabEnhanced && window.attrDefs) {
            pane.innerHTML = window.AttributeDisplay.renderAttributesTabEnhanced(
                outfit, window.attrDefs, 'outfits', pluginId
            );
        } else {
            // Fallback — plain attribute grid matching DataViewer's fallback
            const skip = new Set([
                'name','description','thumbnail','sprite','hardpoint sprite',
                'weapon','spriteData','_pluginId','_pn','_pd',
            ]);
            const attrs = { ...outfit, ...(outfit.attributes || {}) };
            let html = '<div class="attribute-grid">';
            for (const [key, value] of Object.entries(attrs)) {
                if (skip.has(key) || key.startsWith('_') || typeof value === 'object') continue;
                html += `<div class="attribute">
                    <div class="attribute-name">${_esc(key)}</div>
                    <div class="attribute-value">${_esc(String(value))}</div>
                </div>`;
            }
            html += '</div>';
            if (outfit.weapon) {
                const wSkip = new Set(['sprite','spriteData','sound','hit effect',
                    'fire effect','die effect','submunition','stream','cluster']);
                html += '<h3 style="color:#93c5fd;margin-top:20px;">Weapon Stats</h3><div class="attribute-grid">';
                for (const [key, value] of Object.entries(outfit.weapon)) {
                    if (!wSkip.has(key) && typeof value !== 'object' && !Array.isArray(value))
                        html += `<div class="attribute">
                            <div class="attribute-name">${_esc(key)}</div>
                            <div class="attribute-value">${_esc(String(value))}</div>
                        </div>`;
                }
                html += '</div>';
            }
            pane.innerHTML = html;
        }
        return;
    }

    if (tabId === 'locations') {
        if (window.LocationDisplay) {
            window.LocationDisplay.renderLocationsTab(pane, outfit, pluginId);
        } else {
            pane.innerHTML = `<div class="${CLS.noStats}">Location display not available.</div>`;
        }
        return;
    }

    // Image tabs — same path map as DataViewer
    const pathMap = {
        thumbnail:       outfit.thumbnail,
        sprite:          outfit.sprite || outfit.weapon?.sprite,
        hardpointSprite: outfit.weapon?.['hardpoint sprite'],
    };

    const spritePath = pathMap[tabId];
    if (!spritePath) {
        pane.innerHTML = `<div class="${CLS.noStats}">No image available.</div>`;
        return;
    }

    pane.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:12px;">Loading…</p>';

    // Use fetchSprite exactly as DataViewer does
    if (typeof window.fetchSprite === 'function') {
    window.fetchSprite(spritePath, outfit.spriteData || {}).then(element => {
    pane.innerHTML = '';
    if (element) {
        element.style.cssText = 'max-width:100%;max-height:200px;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;justify-content:center;align-items:center;padding:12px;background:rgba(15,23,42,0.5);border-radius:8px;';
        wrap.appendChild(element);
        pane.appendChild(wrap);
    } else {
        // Same fallback as DataViewer._loadSpriteForCard
        const img = document.createElement('img');
        img.src = 'https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/data/endless-sky/images/outfit/unknown.png';
        img.style.cssText = 'max-width:100%;max-height:200px;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;justify-content:center;align-items:center;padding:12px;background:rgba(15,23,42,0.5);border-radius:8px;';
        wrap.appendChild(img);
        pane.appendChild(wrap);
    }
}).catch(() => {
    pane.innerHTML = `<div class="${CLS.noStats}">Image failed to load.</div>`;
});
    } else {
        pane.innerHTML = `<div class="${CLS.noStats}">Image loader not available.</div>`;
    }
}
    
    function _openPanel(context, wrapper, toggle, outfitName) {
    _closePanel(context);

    const outfit = _findOutfit(outfitName);
    if (!outfit && !outfitName) return;

    const panelHtml = _buildStatPanel(outfit || { name: outfitName });
    const div       = document.createElement('div');
    div.innerHTML   = panelHtml;
    const panel     = div.firstElementChild;
    wrapper.appendChild(panel);

    // Load the first tab (attributes) immediately — it won't auto-load otherwise
    const firstPane = panel.querySelector('.oe-tab-pane');
    if (firstPane && firstPane.dataset.loaded === 'false') {
        _loadTabContent(panel, firstPane, firstPane.dataset.tab);
    }

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

    return { install, _switchTab };

})();

document.addEventListener('DOMContentLoaded', () => {
    OutfitExpander.install();
});
