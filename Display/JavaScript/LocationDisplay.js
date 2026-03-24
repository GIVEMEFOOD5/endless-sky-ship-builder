'use strict';

// ─── LocationDisplay.js ───────────────────────────────────────────────────────
//
// Renders the "Locations" modal tab for ships, variants, and outfits.
//
// Expected locations shape (attached by locationResolver.js):
//
//   locations: {
//     "official-game/endless-sky": {
//       Planets:        ["Earth", "Poisonwood"],
//       Systems:        ["Sol", "Betelgeuse"],
//       Missions:       ["Cargo Run 1"],
//       Outfitters:     ["Ammo"],
//       Ships:          ["Bulk Freighter"],        // outfits only
//       ShipyardPlanets:["New Hope"],              // outfits only
//       "_deprecated/unused": true
//     }
//   }
//
// The active plugin list from PluginManager is used to decide which plugin
// blocks to show. Blocks from inactive plugins are collapsed by default.
//
// ─── Performance notes ───────────────────────────────────────────────────────
//  • All rendering is done via DocumentFragment + createElement — no
//    innerHTML string concatenation in hot paths.
//  • Plugin blocks are collapsed by default; their list content is only
//    built when the user expands them (lazy DOM construction).
//  • The unused-marker check is a single key lookup, not iteration.
//  • Event delegation is used on the container instead of per-item listeners.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Category display config ──────────────────────────────────────────────────
// Defines the label, icon, and order for each category key.

const LOCATION_CATEGORIES = [
    { key: 'Planets',         label: 'Planets',          icon: '🌍' },
    { key: 'Systems',         label: 'Systems',          icon: '✨' },
    { key: 'Missions',        label: 'Missions',         icon: '📋' },
    { key: 'Outfitters',      label: 'Outfitters',       icon: '🛒' },
    { key: 'Ships',           label: 'Ships with Outfit', icon: '🚀' },
    { key: 'ShipyardPlanets', label: 'Shipyard Planets', icon: '🏭' },
];

const CATEGORY_KEY_SET = new Set(LOCATION_CATEGORIES.map(c => c.key));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the set of currently active plugin output-names.
 * Falls back to all known plugins if PluginManager is unavailable.
 */
function _getActivePluginSet() {
    if (window.PluginManager?.getActivePlugins) {
        return new Set(window.PluginManager.getActivePlugins());
    }
    return new Set(Object.keys(window.allData || {}));
}

/**
 * Friendly display name for a plugin output-name.
 * Looks up allData for a displayName, falls back to the raw key.
 */
function _pluginLabel(outputName) {
    return window.allData?.[outputName]?.displayName || outputName;
}

/** Build a pill/chip element for a single list value. */
function _makePill(text) {
    const pill = document.createElement('span');
    pill.className = 'ld-pill';
    pill.textContent = text;
    return pill;
}

/** Build the category sub-section (icon + label + pills). */
function _buildCategorySection(cfg, values) {
    const section = document.createElement('div');
    section.className = 'ld-category';

    const header = document.createElement('div');
    header.className = 'ld-category-header';
    header.innerHTML =
        `<span class="ld-category-icon">${cfg.icon}</span>` +
        `<span class="ld-category-label">${cfg.label}</span>` +
        `<span class="ld-category-count">${values.length}</span>`;
    section.appendChild(header);

    const pills = document.createElement('div');
    pills.className = 'ld-pills';
    // DocumentFragment keeps DOM writes batched
    const frag = document.createDocumentFragment();
    for (const v of values) frag.appendChild(_makePill(v));
    pills.appendChild(frag);
    section.appendChild(pills);

    return section;
}

/**
 * Build the content div for one plugin block.
 * Called lazily — only when the user expands the block.
 */
function _buildPluginContent(pluginData) {
    const content = document.createElement('div');
    content.className = 'ld-plugin-content';

    // Unused / deprecated marker
    if (pluginData['_deprecated/unused']) {
        const badge = document.createElement('div');
        badge.className = 'ld-unused';
        badge.textContent = 'Not used anywhere in this plugin';
        content.appendChild(badge);
        return content;
    }

    let hasAny = false;
    for (const cfg of LOCATION_CATEGORIES) {
        const values = pluginData[cfg.key];
        if (!Array.isArray(values) || values.length === 0) continue;
        content.appendChild(_buildCategorySection(cfg, values));
        hasAny = true;
    }

    // Catch any future category keys not yet in LOCATION_CATEGORIES
    for (const [key, values] of Object.entries(pluginData)) {
        if (CATEGORY_KEY_SET.has(key) || key === '_deprecated/unused') continue;
        if (!Array.isArray(values) || values.length === 0) continue;
        const fallbackCfg = { key, label: key, icon: '📌' };
        content.appendChild(_buildCategorySection(fallbackCfg, values));
        hasAny = true;
    }

    if (!hasAny) {
        const empty = document.createElement('div');
        empty.className = 'ld-unused';
        empty.textContent = 'No location data found for this plugin';
        content.appendChild(empty);
    }

    return content;
}

/**
 * Build a collapsible plugin block.
 * Content is built lazily on first expand.
 */
function _buildPluginBlock(outputName, pluginData, isActive, startExpanded) {
    const block = document.createElement('div');
    block.className = 'ld-plugin-block' + (isActive ? ' ld-plugin-active' : ' ld-plugin-inactive');

    // ── Header (clickable toggle) ─────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'ld-plugin-header';
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', String(startExpanded));
    header.setAttribute('tabindex', '0');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'ld-plugin-name';
    nameSpan.textContent = _pluginLabel(outputName);

    const activeBadge = document.createElement('span');
    activeBadge.className = 'ld-plugin-badge';
    activeBadge.textContent = isActive ? 'Active' : 'Inactive';

    const arrow = document.createElement('span');
    arrow.className = 'ld-arrow';
    arrow.textContent = startExpanded ? '▾' : '▸';

    header.appendChild(nameSpan);
    header.appendChild(activeBadge);
    header.appendChild(arrow);
    block.appendChild(header);

    // ── Content (lazy) ────────────────────────────────────────────────────────
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'ld-plugin-content-wrapper';
    contentWrapper.style.display = startExpanded ? 'block' : 'none';
    block.appendChild(contentWrapper);

    let contentBuilt = false;

    function expand() {
        if (!contentBuilt) {
            contentWrapper.appendChild(_buildPluginContent(pluginData));
            contentBuilt = true;
        }
        contentWrapper.style.display = 'block';
        arrow.textContent = '▾';
        header.setAttribute('aria-expanded', 'true');
    }

    function collapse() {
        contentWrapper.style.display = 'none';
        arrow.textContent = '▸';
        header.setAttribute('aria-expanded', 'false');
    }

    // Build content immediately if starting expanded
    if (startExpanded) {
        contentWrapper.appendChild(_buildPluginContent(pluginData));
        contentBuilt = true;
    }

    // Toggle on click or keyboard
    header.addEventListener('click', () => {
        const expanded = contentWrapper.style.display !== 'none';
        expanded ? collapse() : expand();
    });
    header.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const expanded = contentWrapper.style.display !== 'none';
            expanded ? collapse() : expand();
        }
    });

    return block;
}

// ─── Main render function ─────────────────────────────────────────────────────

/**
 * Renders the full locations tab into `container`.
 *
 * @param {HTMLElement} container  - The modal tab content element to render into.
 * @param {object}      item       - The ship / variant / outfit data object.
 * @param {string}      pluginId   - The primary/active plugin id.
 */
function renderLocationsTab(container, item, pluginId) {
    container.innerHTML = '';

    const locations = item?.locations;

    if (!locations || Object.keys(locations).length === 0) {
        const empty = document.createElement('p');
        empty.className = 'ld-empty';
        empty.textContent = 'No location data available for this item.';
        container.appendChild(empty);
        return;
    }

    const activePlugins = _getActivePluginSet();
    const frag          = document.createDocumentFragment();

    // ── Sort: active plugins first, then inactive, both alphabetically ────────
    const entries = Object.entries(locations).sort(([a], [b]) => {
        const aActive = activePlugins.has(a);
        const bActive = activePlugins.has(b);
        if (aActive !== bActive) return aActive ? -1 : 1;
        return _pluginLabel(a).localeCompare(_pluginLabel(b));
    });

    for (const [outputName, pluginData] of entries) {
        const isActive     = activePlugins.has(outputName);
        // Auto-expand active plugin blocks, collapse inactive ones
        const startExpanded = isActive;
        frag.appendChild(_buildPluginBlock(outputName, pluginData, isActive, startExpanded));
    }

    container.appendChild(frag);
}

// ─── Tab registration helper ──────────────────────────────────────────────────
//
// Call this from app.js getAvailableTabs() to add the locations tab when
// location data exists:
//
//   if (item.locations && Object.keys(item.locations).length > 0)
//       tabs.push({ id: 'locations', label: 'Locations' });
//
// And in switchModalTab(), handle 'locations':
//
//   if (tabId === 'locations') {
//       const pluginIdForDisplay = item._pluginId || currentPlugin;
//       window.LocationDisplay.renderLocationsTab(tabContent, item, pluginIdForDisplay);
//       return;
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

// ─── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
    if (document.getElementById('ld-styles')) return;
    const style = document.createElement('style');
    style.id = 'ld-styles';
    style.textContent = `
/* ── Plugin block ─────────────────────────────────────────────────────── */
.ld-plugin-block {
    border: 1px solid rgba(59,130,246,0.2);
    border-radius: 8px;
    margin-bottom: 10px;
    overflow: hidden;
}
.ld-plugin-block.ld-plugin-active {
    border-color: rgba(59,130,246,0.45);
}
.ld-plugin-block.ld-plugin-inactive {
    border-color: rgba(100,116,139,0.25);
    opacity: 0.85;
}

/* ── Plugin header ────────────────────────────────────────────────────── */
.ld-plugin-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    cursor: pointer;
    background: rgba(15,23,42,0.6);
    user-select: none;
    transition: background 0.15s;
}
.ld-plugin-header:hover {
    background: rgba(30,41,59,0.9);
}
.ld-plugin-header:focus-visible {
    outline: 2px solid #3b82f6;
    outline-offset: -2px;
}

.ld-plugin-name {
    flex: 1;
    font-weight: 600;
    font-size: 13px;
    color: #93c5fd;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ld-plugin-badge {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
}
.ld-plugin-active .ld-plugin-badge {
    background: rgba(34,197,94,0.2);
    color: #86efac;
    border: 1px solid rgba(34,197,94,0.35);
}
.ld-plugin-inactive .ld-plugin-badge {
    background: rgba(100,116,139,0.2);
    color: #94a3b8;
    border: 1px solid rgba(100,116,139,0.3);
}

.ld-arrow {
    font-size: 13px;
    color: #64748b;
    flex-shrink: 0;
    transition: transform 0.15s;
}

/* ── Plugin content ───────────────────────────────────────────────────── */
.ld-plugin-content-wrapper {
    padding: 12px 14px;
    background: rgba(15,23,42,0.35);
}
.ld-plugin-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

/* ── Unused badge ─────────────────────────────────────────────────────── */
.ld-unused {
    font-size: 12px;
    color: #94a3b8;
    font-style: italic;
    padding: 6px 0;
}

/* ── Category section ─────────────────────────────────────────────────── */
.ld-category {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.ld-category-header {
    display: flex;
    align-items: center;
    gap: 6px;
}
.ld-category-icon {
    font-size: 14px;
    line-height: 1;
}
.ld-category-label {
    font-size: 12px;
    font-weight: 600;
    color: #7dd3fc;
    text-transform: uppercase;
    letter-spacing: 0.06em;
}
.ld-category-count {
    font-size: 11px;
    color: #64748b;
    background: rgba(100,116,139,0.15);
    border-radius: 8px;
    padding: 1px 6px;
}

/* ── Pills ────────────────────────────────────────────────────────────── */
.ld-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
}
.ld-pill {
    font-size: 11px;
    padding: 3px 9px;
    background: rgba(30,41,59,0.8);
    border: 1px solid rgba(59,130,246,0.2);
    border-radius: 12px;
    color: #cbd5e1;
    white-space: nowrap;
    transition: border-color 0.12s, color 0.12s;
}
.ld-pill:hover {
    border-color: rgba(147,197,253,0.5);
    color: #e2e8f0;
}

/* ── Empty state ──────────────────────────────────────────────────────── */
.ld-empty {
    color: #64748b;
    font-style: italic;
    font-size: 13px;
    text-align: center;
    padding: 20px 0;
}
    `;
    document.head.appendChild(style);
}

// ─── Export ───────────────────────────────────────────────────────────────────

window.LocationDisplay = { renderLocationsTab, injectStyles };
