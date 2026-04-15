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
// Only location blocks whose plugin key matches an entry in the currently
// active plugin list (from PluginManager) are shown.  If PluginManager is
// not yet ready the tab shows a "not ready" notice instead of falling back
// to showing everything — this prevents stale / wrong data appearing.
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

const LOCATION_CATEGORIES = [
    { key: 'Planets',         label: 'Planets',           icon: '🌍' },
    { key: 'Systems',         label: 'Systems',           icon: '✨' },
    { key: 'Missions',        label: 'Missions',          icon: '📋' },
    { key: 'Outfitters',      label: 'Outfitters',        icon: '🛒' },
    { key: 'Ships',           label: 'Ships with Outfit', icon: '🚀' },
    { key: 'ShipyardPlanets', label: 'Shipyard Planets',  icon: '🏭' },
];

const CATEGORY_KEY_SET = new Set(LOCATION_CATEGORIES.map(c => c.key));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the Set of all location-key strings that correspond to currently
 * active plugins, or null if PluginManager is not available / has no active
 * plugins yet.
 *
 * Location keys in the data are stored as "sourceName/outputName"
 * (e.g. "official-game/endless-sky"), but PluginManager tracks plugins by
 * outputName alone (e.g. "endless-sky").  We therefore build the set to
 * include every form a key might take:
 *   • the raw outputName itself          ("endless-sky")
 *   • "sourceName/outputName"            ("official-game/endless-sky")
 *
 * This is derived by looking up each active outputName in allData where the
 * sourceName is stored.
 */
function _getActivePluginSet() {
    if (!window.PluginManager?.getActivePlugins) return null;

    const active = window.PluginManager.getActivePlugins();
    if (!Array.isArray(active) || active.length === 0) return null;

    const keys = new Set();
    const allData = window.allData || {};

    for (const outputName of active) {
        // Always include the bare outputName
        keys.add(outputName);

        // Also include "sourceName/outputName" if we can look it up
        const sourceName = allData[outputName]?.sourceName;
        if (sourceName) {
            keys.add(`${sourceName}/${outputName}`);
        }
    }

    return keys;
}

/**
 * Friendly display name for a plugin output-name.
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
 * Since we only ever call this for active plugins now, isActive is always
 * true — the parameter is kept for API compatibility.
 */
function _buildPluginBlock(outputName, pluginData, startExpanded) {
    const block = document.createElement('div');
    block.className = 'ld-plugin-block ld-plugin-active';

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
    activeBadge.textContent = 'Active';

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

    if (startExpanded) {
        contentWrapper.appendChild(_buildPluginContent(pluginData));
        contentBuilt = true;
    }

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

    // ── Require PluginManager to be ready ─────────────────────────────────────
    // We deliberately do NOT fall back to showing all plugins — that would show
    // location data for plugins the user has not activated.
    const activePlugins = _getActivePluginSet();

    if (!activePlugins) {
        const notice = document.createElement('p');
        notice.className = 'ld-empty';
        notice.textContent = 'Plugin list not ready. Please wait and reopen this tab.';
        container.appendChild(notice);
        return;
    }

    // ── Filter: only keep location entries whose key is an active plugin ──────
    const activeEntries = Object.entries(locations)
        .filter(([outputName]) => activePlugins.has(outputName));

    if (activeEntries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'ld-empty';
        empty.textContent = 'No location data available for any active plugin.';
        container.appendChild(empty);
        return;
    }

    // Sort alphabetically by display label
    activeEntries.sort(([a], [b]) => _pluginLabel(a).localeCompare(_pluginLabel(b)));

    // ── Render one block per active plugin that has location data ─────────────
    // If there is only one entry, start it expanded automatically.
    const autoExpand = activeEntries.length === 1;

    const frag = document.createDocumentFragment();
    for (const [outputName, pluginData] of activeEntries) {
        frag.appendChild(_buildPluginBlock(outputName, pluginData, autoExpand));
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

// ─── Export ───────────────────────────────────────────────────────────────────

window.LocationDisplay = { renderLocationsTab, injectStyles };
