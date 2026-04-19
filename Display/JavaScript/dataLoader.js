'use strict';

// ═══════════════════════════════════════════════════════════
//  dataLoader.js
//
//  Standalone data loader for the Endless Sky Data Viewer.
//  Fetches all plugin data from GitHub and exposes it via:
//
//    window.allData    — { [outputName]: { displayName, ships, variants, outfits, effects } }
//    window.attrDefs   — parsed attributeDefinitions.json
//
//  Usage:
//    <script src="../JavaScript/dataLoader.js"></script>
//
//  Then call:
//    window.DataLoader.load()           — starts loading, returns a Promise
//    window.DataLoader.onReady(fn)      — register a callback for when data is ready
//    window.DataLoader.isReady()        — returns true if data has loaded
//    window.DataLoader.getAllShips()    — flat array of all ships + variants across all plugins
//    window.DataLoader.getAllOutfits()  — flat array of all outfits across all plugins
//    window.DataLoader.getPlugins()     — array of { outputName, displayName, sourceName }
//
//  The loader fires a CustomEvent 'dataLoaded' on document when complete,
//  and 'dataLoadError' on failure.
// ═══════════════════════════════════════════════════════════

(function () {

    const REPO_URL = 'GIVEMEFOOD5/endless-sky-ship-builder';
    const BASE_URL = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;

    let _ready     = false;
    let _loading   = false;
    let _callbacks = [];

    // ── Internal state ───────────────────────────────────────
    window.allData  = window.allData  || {};
    window.attrDefs = window.attrDefs || null;

    // ── Public API ───────────────────────────────────────────
    window.DataLoader = {

        /**
         * Start loading all data. Safe to call multiple times — only
         * loads once. Returns a Promise that resolves when complete.
         */
        load() {
            if (_ready)   return Promise.resolve(window.allData);
            if (_loading) return new Promise(resolve => _callbacks.push(() => resolve(window.allData)));
            return _doLoad();
        },

        /**
         * Register a callback that fires as soon as data is ready.
         * If data is already loaded, fires immediately.
         */
        onReady(fn) {
            if (_ready) { fn(window.allData); return; }
            _callbacks.push(fn);
            // Auto-trigger load if not started
            if (!_loading) _doLoad();
        },

        /** Returns true if data has finished loading. */
        isReady() { return _ready; },

        /** Flat array of every ship and variant across all active plugins. */
        getAllShips() {
            const ships = [];
            for (const [outputName, plugin] of Object.entries(window.allData)) {
                for (const s of (plugin.ships || [])) {
                    ships.push({ ...s, _pluginName: outputName, _pluginDisplay: plugin.displayName || outputName });
                }
                for (const s of (plugin.variants || [])) {
                    ships.push({ ...s, _pluginName: outputName, _pluginDisplay: plugin.displayName || outputName, _isVariant: true });
                }
            }
            return ships;
        },

        /** Flat array of every outfit across all active plugins. */
        getAllOutfits() {
            const outfits = [];
            for (const [outputName, plugin] of Object.entries(window.allData)) {
                for (const o of (plugin.outfits || [])) {
                    outfits.push({ ...o, _pluginName: outputName, _pluginDisplay: plugin.displayName || outputName });
                }
            }
            return outfits;
        },

        /** Flat array of every effect across all active plugins. */
        getAllEffects() {
            const effects = [];
            for (const [outputName, plugin] of Object.entries(window.allData)) {
                for (const e of (plugin.effects || [])) {
                    effects.push({ ...e, _pluginName: outputName, _pluginDisplay: plugin.displayName || outputName });
                }
            }
            return effects;
        },

        /** List of loaded plugins. */
        getPlugins() {
            return Object.entries(window.allData).map(([outputName, p]) => ({
                outputName,
                displayName: p.displayName || outputName,
                sourceName:  p.sourceName  || outputName,
                shipCount:    (p.ships    || []).length,
                variantCount: (p.variants || []).length,
                outfitCount:  (p.outfits  || []).length,
                effectCount:  (p.effects  || []).length,
            }));
        },

        /** All attribute definition keys as a sorted array. */
        getAttrKeys() {
            if (!window.attrDefs || !window.attrDefs.attributes) return [];
            return Object.keys(window.attrDefs.attributes).sort();
        },

        /** Get a single attribute definition object by key. */
        getAttrDef(key) {
            if (!window.attrDefs || !window.attrDefs.attributes) return null;
            return window.attrDefs.attributes[key] || null;
        },

        /** Get a short hint string for an attribute key (unit + stacking). */
        getAttrHint(key) {
            const def = this.getAttrDef(key);
            if (!def) return '';
            const parts = [];
            if (def.displayUnit) parts.push(def.displayUnit);
            if (def.stacking)    parts.push(def.stacking);
            return parts.join(' · ');
        },
    };

    // ── Internal load function ───────────────────────────────
    async function _doLoad() {
        _loading = true;
        _fireEvent('dataLoadStart');

        try {
            // 1 — Attribute definitions
            try {
                const res = await fetch(`${BASE_URL}/attributeDefinitions.json`);
                if (res.ok) window.attrDefs = await res.json();
            } catch (_) {
                console.warn('[DataLoader] Could not load attributeDefinitions.json');
            }

            // 2 — Index
            const indexRes = await fetch(`${BASE_URL}/index.json`);
            if (!indexRes.ok) throw new Error('Could not load data/index.json');
            const dataIndex = await indexRes.json();

            window.allData = {};

            // 3 — Load each plugin
            for (const [sourceName, pluginList] of Object.entries(dataIndex)) {
                for (const { outputName, displayName } of pluginList) {
                    const plugin = {
                        sourceName,
                        displayName: displayName || outputName,
                        outputName,
                        ships: [], variants: [], outfits: [], effects: [],
                    };
                    let loaded = false;

                    try {
                        const base = `${BASE_URL}/${outputName}/dataFiles`;
                        const [shipsRes, variantsRes, outfitsRes, effectsRes] = await Promise.all([
                            fetch(`${base}/ships.json`),
                            fetch(`${base}/variants.json`),
                            fetch(`${base}/outfits.json`),
                            fetch(`${base}/effects.json`),
                        ]);

                        if (shipsRes.ok)    { plugin.ships    = await shipsRes.json();    loaded = true; }
                        if (variantsRes.ok) { plugin.variants = await variantsRes.json(); loaded = true; }
                        if (outfitsRes.ok)  { plugin.outfits  = await outfitsRes.json();  loaded = true; }
                        if (effectsRes.ok)  { plugin.effects  = await effectsRes.json();  loaded = true; }

                        if (loaded) {
                            window.allData[outputName] = plugin;
                        } else {
                            console.warn(`[DataLoader] ${outputName}: no data files found, skipping`);
                        }
                    } catch (err) {
                        console.warn(`[DataLoader] Failed loading plugin "${outputName}":`, err);
                    }
                }
            }

            const hasData = Object.values(window.allData).some(p =>
                p.ships.length > 0 || p.variants.length > 0 || p.outfits.length > 0
            );
            if (!hasData) throw new Error('No data could be loaded from any plugin');

            _ready = true;
            _loading = false;

            // Notify all registered callbacks
            for (const fn of _callbacks) {
                try { fn(window.allData); } catch(e) { console.error('[DataLoader] callback error:', e); }
            }
            _callbacks = [];

            _fireEvent('dataLoaded', { allData: window.allData, attrDefs: window.attrDefs });

            return window.allData;

        } catch (error) {
            _loading = false;
            console.error('[DataLoader] Load failed:', error);
            _fireEvent('dataLoadError', { message: error.message });
            throw error;
        }
    }

    function _fireEvent(name, detail = {}) {
        document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
    }

})();