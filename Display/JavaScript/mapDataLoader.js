'use strict';

// ═══════════════════════════════════════════════════════════
//  mapDataLoader.js  —  Endless Sky Ship Builder / Systems Map
//
//  STAGE 1 of the map pipeline: GRAB THE DATA, PUSH IT FORWARD.
//  This file's only job is fetching raw map data (systems /
//  galaxies / wormholes) per plugin and handing it, unmodified,
//  to whoever asks for it. It does NOT reshape, merge, or
//  compute anything — see mapDataFormatter.js for that.
//
//  Mirrors dataLoader.js's plugin-discovery pattern (data/index.json)
//  so the Systems page lists exactly the same plugins as every other
//  page, but only downloads the (large) map files for plugins that
//  are actually active — ships/outfits/effects are never touched here.
//
//  LOCAL HOST SUPPORT
//  -------------------
//  When this page is served from localhost/127.0.0.1/file-relative
//  dev servers, data is read from the repo's own `data/` folder
//  (two levels up from Display/HTML) instead of GitHub raw. This
//  means local edits to data/*.json show up immediately without
//  waiting on a commit + the monthly Action, and the page still
//  works with no network access at all. Anywhere else (GitHub Pages,
//  production) it falls back to raw.githubusercontent.com, same as
//  dataLoader.js.
//
//  SLIM FILES (forward-compatible)
//  --------------------------------
//  Full `systems.json` files can be tens of megabytes (they carry the
//  entire objectTree, descriptions, etc. — none of which the map
//  needs). This loader always tries a slim companion file first:
//      dataFiles/systemsMap.json   →  [{name,pos,government,links,attributes}, ...]
//      dataFiles/galaxiesMap.json  →  [{name,pos,sprite}, ...]
//  and transparently falls back to the full `systems.json` /
//  `galaxies.json` if the slim file doesn't exist (404). If the
//  parser is ever updated to emit these slim files (recommended —
//  see README note in this repo's mapParser.js), every page using
//  this loader gets the bandwidth win for free, no code changes
//  needed elsewhere.
//
//  Public API on window.MapDataLoader:
//    .discoverPlugins()            → Promise<{sourceName: [{outputName, displayPluginName}]}>
//    .loadPlugins(outputNames)     → Promise<Map<outputName, RawPluginMapData>>
//    .getCached(outputName)        → RawPluginMapData | null
//    .isCached(outputName)         → boolean
//    .clearCache()                 → drop everything and refetch next time
//
//  RawPluginMapData shape:
//    { outputName, sourceName, displayName,
//      systems: [...], galaxies: [...], wormholes: [...],
//      slim: boolean }   // true if the slim map files were used
//
//  Custom events fired on document:
//    'mapDataLoadStart'   { detail: { outputNames } }
//    'mapPluginLoaded'    { detail: { outputName, index, total } }
//    'mapPluginLoadError' { detail: { outputName, message } }
//    'mapDataLoadEnd'     { detail: { loaded: [outputName, ...] } }
// ═══════════════════════════════════════════════════════════

(function () {

const REPO_URL = 'GIVEMEFOOD5/endless-sky-ship-builder';

// ── Environment detection: local dev server vs. production ─────
function _isLocalHost() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '' || location.protocol === 'file:';
}

// Display/HTML/Systems.html → ../../data is the repo's data/ folder.
const BASE_URL = _isLocalHost()
    ? '../../data'
    : `https://raw.githubusercontent.com/${REPO_URL}/main/data`;

// ── Internal state ───────────────────────────────────────────
const _cache = new Map(); // outputName -> RawPluginMapData
let _pluginIndex = null;  // data/index.json, cached once per page load

function _fireEvent(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
}

// ── Plugin discovery (same source of truth as dataLoader.js) ───
async function discoverPlugins() {
    if (_pluginIndex) return _pluginIndex;
    const res = await fetch(`${BASE_URL}/index.json`);
    if (!res.ok) throw new Error(`Could not load ${BASE_URL}/index.json`);
    _pluginIndex = await res.json();
    return _pluginIndex;
}

function _findPluginMeta(index, outputName) {
    for (const [sourceName, list] of Object.entries(index)) {
        const hit = list.find(p => p.outputName === outputName);
        if (hit) return { sourceName, displayName: hit.displayPluginName || outputName };
    }
    return { sourceName: outputName, displayName: outputName };
}

// ── Fetch helpers ────────────────────────────────────────────
async function _fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, status: res.status };
    try {
        return { ok: true, data: await res.json() };
    } catch (err) {
        return { ok: false, status: 'parse-error', error: err };
    }
}

/**
 * Loads one plugin's map data, preferring slim files and falling back
 * to the full parser output. Never throws for a single missing file —
 * missing pieces just come back as empty arrays so one bad plugin
 * doesn't block the others.
 */
async function _loadOnePlugin(outputName, meta) {
    const base = `${BASE_URL}/${outputName}/dataFiles`;

    let systems = [];
    let slim = false;
    const slimSystems = await _fetchJson(`${base}/systemsMap.json`);
    if (slimSystems.ok) {
        systems = slimSystems.data;
        slim = true;
    } else {
        const fullSystems = await _fetchJson(`${base}/systems.json`);
        if (fullSystems.ok) systems = fullSystems.data;
    }

    let galaxies = [];
    const slimGalaxies = await _fetchJson(`${base}/galaxiesMap.json`);
    if (slimGalaxies.ok) {
        galaxies = slimGalaxies.data;
    } else {
        const fullGalaxies = await _fetchJson(`${base}/galaxies.json`);
        if (fullGalaxies.ok) galaxies = fullGalaxies.data;
    }

    const wormholesRes = await _fetchJson(`${base}/wormholes.json`);
    const wormholes = wormholesRes.ok ? wormholesRes.data : [];

    return {
        outputName,
        sourceName: meta.sourceName,
        displayName: meta.displayName,
        systems, galaxies, wormholes,
        slim,
    };
}

/**
 * Loads (or returns cached copies of) every outputName requested.
 * Fetches run sequentially per-plugin (not Promise.all) so the
 * 'mapPluginLoaded' progress events arrive in a sane order for a
 * loading UI — these files are large enough that progress matters,
 * especially on mobile connections.
 */
async function loadPlugins(outputNames) {
    const wanted = [...new Set(outputNames)].filter(Boolean);
    _fireEvent('mapDataLoadStart', { outputNames: wanted });

    const index = await discoverPlugins();
    const results = new Map();

    for (let i = 0; i < wanted.length; i++) {
        const outputName = wanted[i];
        if (_cache.has(outputName)) {
            results.set(outputName, _cache.get(outputName));
            _fireEvent('mapPluginLoaded', { outputName, index: i, total: wanted.length, cached: true });
            continue;
        }
        try {
            const meta = _findPluginMeta(index, outputName);
            const data = await _loadOnePlugin(outputName, meta);
            _cache.set(outputName, data);
            results.set(outputName, data);
            _fireEvent('mapPluginLoaded', { outputName, index: i, total: wanted.length, cached: false });
        } catch (err) {
            console.warn(`[MapDataLoader] Failed loading "${outputName}":`, err);
            _fireEvent('mapPluginLoadError', { outputName, message: err.message });
        }
    }

    _fireEvent('mapDataLoadEnd', { loaded: [...results.keys()] });
    return results;
}

function getCached(outputName) { return _cache.get(outputName) || null; }
function isCached(outputName) { return _cache.has(outputName); }
function clearCache() { _cache.clear(); }

window.MapDataLoader = {
    discoverPlugins,
    loadPlugins,
    getCached,
    isCached,
    clearCache,
    BASE_URL,
};

})();
