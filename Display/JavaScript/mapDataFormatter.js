'use strict';

// ═══════════════════════════════════════════════════════════
//  mapDataFormatter.js  —  Endless Sky Ship Builder / Systems Map
//
//  STAGE 2 of the map pipeline: FORMAT THE DATA.
//  Takes the raw, per-plugin arrays handed over by mapDataLoader.js
//  (whatever shape mapParser.js happens to output that week — this
//  file is deliberately defensive about missing/renamed fields since
//  the parser is under active development) and reshapes them into a
//  single lean, merged structure the rest of the map pipeline can
//  rely on without knowing anything about plugins.
//
//  MERGE MODEL (mirrors mapParser.js's own doc comment)
//  ------------------------------------------------------
//  A system can be touched by more than one active plugin (an
//  overhaul mod editing a vanilla system's government, a small mod
//  only adding a link). So systems merge ADDITIVELY, in the same
//  order the plugins are active (PluginManager's order — first
//  plugin in the active list has lowest priority, matching parser.js
//  processing plugins.json top-to-bottom):
//    - links                → union, de-duplicated by name
//    - attributes           → union, de-duplicated
//    - government, pos      → last plugin to define it wins
//    - name / displayName   → first plugin to define it wins (stable identity)
//  Every merged system keeps `_definedBy` (every plugin that touched
//  it) so the display layer can show provenance on hover.
//
//  Public API on window.MapDataFormatter:
//    .formatSystems(pluginDataMap, activeOrder) → Map<name, FormattedSystem>
//    .formatGalaxies(pluginDataMap)             → FormattedGalaxy[]
//    .formatWormholes(pluginDataMap)            → FormattedWormholeLink[]
//
//  FormattedSystem shape:
//    { name, x, y, government, attributes: string[],
//      links: string[], wormhole: boolean, hasPlanets: boolean,
//      definedBy: string[] }
// ═══════════════════════════════════════════════════════════

(function () {

// ── Small defensive readers (parser output shape drifts sometimes) ──

function _readName(raw) {
    return raw?.name ?? raw?.displayName ?? null;
}

function _readPos(raw) {
    const p = raw?.pos;
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    return { x: p.x, y: p.y };
}

function _readLinkNames(raw) {
    const links = raw?.links;
    if (!Array.isArray(links)) return [];
    return links
        .map(l => (typeof l === 'string' ? l : l?.name))
        .filter(Boolean);
}

function _readAttributes(raw) {
    const attrs = raw?.attributes;
    if (!Array.isArray(attrs)) return [];
    return attrs.filter(a => typeof a === 'string');
}

function _readGovernment(raw) {
    const g = raw?.government;
    return (typeof g === 'string' && g.trim()) ? g.trim() : 'Uninhabited';
}

// ── Systems ──────────────────────────────────────────────────

/**
 * @param {Map<string, RawPluginMapData>} pluginDataMap  keyed by outputName
 * @param {string[]} activeOrder  outputNames in PluginManager priority order
 *                                (index 0 = lowest priority, last = highest)
 * @returns {Map<string, FormattedSystem>}
 */
function formatSystems(pluginDataMap, activeOrder) {
    const merged = new Map();

    for (const outputName of activeOrder) {
        const plugin = pluginDataMap.get(outputName);
        if (!plugin || !Array.isArray(plugin.systems)) continue;

        for (const raw of plugin.systems) {
            const name = _readName(raw);
            // Labels (e.g. "label core") and namesless nodes aren't real
            // systems — mapParser.js stores galaxy background labels in
            // the galaxies array, but some plugin output has historically
            // leaked them into systems too. Skip anything without a
            // usable position; it can't be placed on the map anyway.
            const pos = _readPos(raw);
            if (!name || !pos) continue;

            const linkNames = _readLinkNames(raw);
            const attrs = _readAttributes(raw);
            const government = _readGovernment(raw);
            const hasPlanets = Array.isArray(raw.planets) && raw.planets.length > 0;

            let entry = merged.get(name);
            if (!entry) {
                entry = {
                    name,
                    x: pos.x, y: pos.y,
                    government,
                    attributes: new Set(attrs),
                    links: new Set(linkNames),
                    wormhole: false,
                    hasPlanets,
                    definedBy: [],
                };
                merged.set(name, entry);
            } else {
                // Scalar fields: last write (highest-priority active plugin) wins.
                entry.x = pos.x;
                entry.y = pos.y;
                entry.government = government;
                entry.hasPlanets = entry.hasPlanets || hasPlanets;
                // List fields: union.
                attrs.forEach(a => entry.attributes.add(a));
                linkNames.forEach(l => entry.links.add(l));
            }
            if (!entry.definedBy.includes(outputName)) entry.definedBy.push(outputName);
        }
    }

    // Freeze Sets into arrays for a plain, serialisable-looking result.
    const out = new Map();
    for (const [name, e] of merged) {
        out.set(name, {
            name: e.name,
            x: e.x, y: e.y,
            government: e.government,
            attributes: [...e.attributes],
            links: [...e.links],
            wormhole: e.wormhole,
            hasPlanets: e.hasPlanets,
            definedBy: e.definedBy,
        });
    }
    return out;
}

/** Marks systems that are one end of a wormhole link (for a distinct display treatment). */
function applyWormholeFlags(systemsMap, wormholeLinks) {
    for (const link of wormholeLinks) {
        const from = systemsMap.get(link.from);
        const to = systemsMap.get(link.to);
        if (from) from.wormhole = true;
        if (to) to.wormhole = true;
    }
    return systemsMap;
}

// ── Galaxies (background cluster labels / sprites) ──────────

function formatGalaxies(pluginDataMap) {
    const seen = new Map();
    for (const plugin of pluginDataMap.values()) {
        if (!Array.isArray(plugin.galaxies)) continue;
        for (const raw of plugin.galaxies) {
            const name = _readName(raw);
            const pos = _readPos(raw);
            if (!name || !pos) continue;
            // Skip pure background-label sprites ("label core", "label deep"...)
            // — they clutter the legend without being navigable systems.
            const isLabel = /^label\b/i.test(name);
            seen.set(name, { name, x: pos.x, y: pos.y, sprite: raw.sprite || null, isLabel });
        }
    }
    return [...seen.values()];
}

// ── Wormholes ────────────────────────────────────────────────

function formatWormholes(pluginDataMap) {
    const out = [];
    const seen = new Set();
    for (const plugin of pluginDataMap.values()) {
        if (!Array.isArray(plugin.wormholes)) continue;
        for (const w of plugin.wormholes) {
            const links = Array.isArray(w.links) ? w.links : [];
            for (const l of links) {
                if (!l?.from || !l?.to) continue;
                const key = `${l.from}→${l.to}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ from: l.from, to: l.to, name: w.name || null });
            }
        }
    }
    return out;
}

window.MapDataFormatter = {
    formatSystems,
    formatGalaxies,
    formatWormholes,
    applyWormholeFlags,
};

})();
