'use strict';

// ═══════════════════════════════════════════════════════════
//  dataLoader.js  —  Endless Sky Ship Builder / Data Viewer
//
//  Loads all plugin data from GitHub, manages active plugin
//  selection, and synthesises a "Local Builds" pseudo-plugin
//  from localStorage saved ships.
//
//  Public API on window.DataLoader:
//    .load()                      → Promise — start/await loading
//    .onReady(fn)                 → register ready callback
//    .isReady()                   → boolean
//    .getPlugins()                → all loaded plugins
//    .getActivePlugins()          → ordered active outputNames
//    .setActivePlugins(arr)       → set active set, fires 'pluginsChanged'
//    .initDefaultPlugins()        → activate default (endless-sky) + local
//    .getAllShips()               → ships from active plugins + local builds
//    .getAllOutfits()             → outfits from active plugins
//    .getAllEffects()             → effects from active plugins
//    .getAttrKeys()              → sorted attribute keys from attrDefs
//    .getAttrDef(key)            → single attribute definition
//    .getAttrHint(key)           → "unit · stacking" string
//    .refreshLocalBuilds()       → re-read localStorage fleet + fire pluginsChanged
//    ._refreshLocalOnly()        → re-read localStorage fleet silently (no event)
//
//  Custom events fired on document:
//    'dataLoaded'      — all remote data fetched
//    'dataLoadError'   — fetch failed
//    'pluginsChanged'  — active plugin selection changed
// ═══════════════════════════════════════════════════════════

(function () {

const REPO_URL   = 'GIVEMEFOOD5/endless-sky-ship-builder';
const BASE_URL   = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;
const LOCAL_KEY  = 'es_ship_builder_v4';
const LOCAL_PLUGIN_ID = '__local_builds__';
const DEFAULT_PLUGIN  = 'official-game/endless-sky';

// ── Internal state ─────────────────────────────────────────
let _ready          = false;
let _loading        = false;
let _callbacks      = [];
let _activePlugins  = [];

window.allData  = window.allData  || {};
window.attrDefs = window.attrDefs || null;

// ── Attribute value coercion ───────────────────────────────
//
// shipBuilder.js stores ALL attribute values as strings in localStorage
// (e.g. shields: "400", not shields: 400). battleSim.js and other consumers
// expect numbers. This helper converts a flat attributes object so every
// value that looks like a plain number becomes one, while genuine string
// values (e.g. category: "Light Warship") stay as strings.
// Nested objects (licenses, weapon) are left untouched.

function _coerceAttrs(attrs) {
    if (!attrs || typeof attrs !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'object') {
            // Preserve nested objects (licenses, weapon sub-block) as-is
            out[k] = v;
            continue;
        }
        const str = String(v).trim();
        const n   = Number(str);
        // Only coerce if the whole string is a valid finite number
        out[k] = (str !== '' && isFinite(n)) ? n : str;
    }
    return out;
}

// ── Parse outfit map from raw localStorage ship data ───────
//
// sbSave() always writes outfits as a plain object (map):
//   { "Hyperdrive": { count: 1, pluginId: "..." }, ... }
// sbLoad() converts this back to an array for shipBuilder's UI.
// _buildLocalPlugin reads directly from localStorage, so it always
// sees the map format. This helper normalises both formats into a
// consistent { name → { count, pluginId } } map object.

function _normaliseOutfitMap(outfits) {
    if (!outfits) return {};

    // Array format (e.g. loaded from sbFleet): [{ name, count, pluginId }]
    if (Array.isArray(outfits)) {
        const map = {};
        for (const o of outfits) {
            const name = (o.name || '').replace(/^"|"$/g, '');
            if (!name) continue;
            map[name] = {
                count:    parseInt(o.count)   || 1,
                pluginId: o.pluginId          || null,
            };
        }
        return map;
    }

    // Map format (direct from localStorage JSON):
    // { "Name": { count, pluginId } } or legacy { "Name": number }
    if (typeof outfits === 'object') {
        const map = {};
        for (const [rawName, val] of Object.entries(outfits)) {
            const name = rawName.replace(/^"|"$/g, '');
            if (!name) continue;
            map[name] = typeof val === 'object'
                ? { count: parseInt(val.count) || 1, pluginId: val.pluginId || null }
                : { count: Number(val) || 1,          pluginId: null };
        }
        return map;
    }

    return {};
}

// ── Local builds pseudo-plugin ─────────────────────────────
//
// FIX: The local plugin now carries an `outfits` index populated from
// the outfit maps of all active remote plugins. This means
// ComputedStats.getOutfitIndex(LOCAL_PLUGIN_ID) can find outfit
// attribute data when accumulating stats for local ships.
// Without this, every outfit lookup returned undefined and all
// computed stats were zero.

function _buildLocalPlugin() {
    let fleet = [];
    try {
        const raw = localStorage.getItem(LOCAL_KEY);
        if (raw) fleet = JSON.parse(raw);
    } catch (_) {}

    const ships = fleet.map(s => {
        const rawAttrs = Object.assign({}, s.attributes || {});
        if (s.mass != null && s.mass !== '') rawAttrs.mass = s.mass;
        if (s.drag != null && s.drag !== '') rawAttrs.drag = s.drag;
        const attributes = _coerceAttrs(rawAttrs);

        // FIX: normalise outfits into a consistent map regardless of
        // whether localStorage holds map or array format.
        const outfitsMap = _normaliseOutfitMap(s.outfits);

        return {
            name:        s.name || 'Unnamed',
            variant:     s.variant || '',
            sprite:      s.sprite || '',
            thumbnail:   s.thumbnail || '',
            description: s.description || '',
            attributes,
            // FIX: provide both keys; ComputedStats uses outfitMap || outfits
            outfits:   outfitsMap,
            outfitMap: outfitsMap,
            guns: (s.guns || []).map(g => ({
                x:   parseFloat((g.coords || '0 0').split(' ')[0]) || 0,
                y:   parseFloat((g.coords || '0 0').split(' ')[1]) || 0,
                gun: g.over || '',
            })),
            turrets: (s.turrets || []).map(g => ({
                x:      parseFloat((g.coords || '0 0').split(' ')[0]) || 0,
                y:      parseFloat((g.coords || '0 0').split(' ')[1]) || 0,
                turret: g.over || '',
            })),
            bays: [
                ...(s.drones || []).map(b => ({
                    type:            'Drone',
                    x:               parseFloat((b.coords || '0 0').split(' ')[0]) || 0,
                    y:               parseFloat((b.coords || '0 0').split(' ')[1]) || 0,
                    'launch effect': b.launchEffect || '',
                })),
                ...(s.fighters || []).map(b => ({
                    type:            'Fighter',
                    x:               parseFloat((b.coords || '0 0').split(' ')[0]) || 0,
                    y:               parseFloat((b.coords || '0 0').split(' ')[1]) || 0,
                    'launch effect': b.launchEffect || '',
                })),
            ],
            engines: (s.engines || []).map(e => ({
                x:    parseFloat((e.coords || '0 0').split(' ')[0]) || 0,
                y:    parseFloat((e.coords || '0 0').split(' ')[1]) || 0,
                zoom: parseFloat(e.zoom) || 1,
            })),
            _isLocalBuild: true,
            _localId: s.id,
        };
    });

    // FIX: populate the local plugin's outfits array from ALL active remote
    // plugins so ComputedStats.getOutfitIndex can find outfit attribute data.
    // This is only needed for the outfit index lookup — not for display.
    const remoteOutfits = [];
    for (const [id, plugin] of Object.entries(window.allData)) {
        if (id === LOCAL_PLUGIN_ID) continue;
        for (const o of (plugin.outfits || [])) {
            remoteOutfits.push(o);
        }
    }

    return {
        sourceName:  'Local Builds',
        displayName: 'Local Builds',
        outputName:  LOCAL_PLUGIN_ID,
        ships,
        variants: [],
        // FIX: include remote outfits so the outfit index is populated
        outfits:  remoteOutfits,
        effects:  [],
        _isLocal: true,
    };
}

function _refreshLocalPlugin() {
    window.allData[LOCAL_PLUGIN_ID] = _buildLocalPlugin();
}

// ── Helpers ─────────────────────────────────────────────────
function _activeData() {
    const result = {};
    for (const id of _activePlugins) {
        if (id === LOCAL_PLUGIN_ID) {
            result[id] = _buildLocalPlugin(); // always fresh
        } else if (window.allData[id]) {
            result[id] = window.allData[id];
        }
    }
    return result;
}

function _fireEvent(name, detail = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
}

// ── Public API ──────────────────────────────────────────────
window.DataLoader = {

    load() {
        if (_ready)   return Promise.resolve(window.allData);
        if (_loading) return new Promise(resolve => _callbacks.push(() => resolve(window.allData)));
        return _doLoad();
    },

    onReady(fn) {
        if (_ready) { fn(window.allData); return; }
        _callbacks.push(fn);
        if (!_loading) _doLoad();
    },

    isReady() { return _ready; },

    // ── Plugin management ──────────────────────────────────
    getPlugins() {
        const local = _buildLocalPlugin();
        const remote = Object.entries(window.allData)
            .filter(([id]) => id !== LOCAL_PLUGIN_ID)
            .map(([id, p]) => ({
                outputName:   id,
                displayName:  p.displayName || id,
                sourceName:   p.sourceName  || id,
                shipCount:    (p.ships    || []).length,
                variantCount: (p.variants || []).length,
                outfitCount:  (p.outfits  || []).length,
                effectCount:  (p.effects  || []).length,
                isDefault:    id === DEFAULT_PLUGIN,
                isLocal:      false,
            }));
        return [
            {
                outputName:   LOCAL_PLUGIN_ID,
                displayName:  'Local Builds',
                sourceName:   'Local Builds',
                shipCount:    local.ships.length,
                variantCount: 0,
                outfitCount:  0,
                effectCount:  0,
                isLocal:      true,
                isDefault:    false,
            },
            ...remote,
        ];
    },

    getActivePlugins() { return [..._activePlugins]; },

    setActivePlugins(arr) {
        const withLocal = arr.includes(LOCAL_PLUGIN_ID) ? arr : [LOCAL_PLUGIN_ID, ...arr];
        _activePlugins = withLocal.filter(id =>
            id === LOCAL_PLUGIN_ID || window.allData[id]
        );
        _saveActivePlugins();
        _fireEvent('pluginsChanged', { active: [..._activePlugins] });
    },

    initDefaultPlugins() {
        const saved = _loadActivePlugins();
        console.log('[DataLoader] initDefaultPlugins — saved:', saved);
        console.log('[DataLoader] allData keys:', Object.keys(window.allData));
        if (saved && saved.length > 0) {
            const valid = saved.filter(id =>
                id === LOCAL_PLUGIN_ID
                    ? !!(window.allData[LOCAL_PLUGIN_ID]?.ships?.length > 0)
                    : !!window.allData[id]
            );
            if (valid.length > 0) {
                _activePlugins = valid;
                _fireEvent('pluginsChanged', { active: [..._activePlugins] });
                return;
            }
        }
        const defaultRemote = window.allData[DEFAULT_PLUGIN]
            ? DEFAULT_PLUGIN
            : Object.keys(window.allData).find(k => k !== LOCAL_PLUGIN_ID);
        _activePlugins = defaultRemote
            ? [LOCAL_PLUGIN_ID, defaultRemote]
            : [LOCAL_PLUGIN_ID];
        _saveActivePlugins();
        _fireEvent('pluginsChanged', { active: [..._activePlugins] });
    },

    // ── Data accessors (active plugins only) ──────────────
    getAllShips() {
        const ships = [];
        for (const [id, plugin] of Object.entries(_activeData())) {
            const display = plugin.displayName || id;
            const isLocal = id === LOCAL_PLUGIN_ID;
            for (const s of (plugin.ships || []))
                ships.push({ ...s, _pluginName: id, _pluginDisplay: display, _isLocal: isLocal });
            for (const s of (plugin.variants || []))
                ships.push({ ...s, _pluginName: id, _pluginDisplay: display, _isVariant: true, _isLocal: isLocal });
        }
        return ships;
    },

    getAllOutfits() {
        const outfits = [];
        for (const [id, plugin] of Object.entries(_activeData())) {
            if (id === LOCAL_PLUGIN_ID) continue;
            const display = plugin.displayName || id;
            for (const o of (plugin.outfits || []))
                outfits.push({ ...o, _pluginName: id, _pluginDisplay: display });
        }
        return outfits;
    },

    getAllEffects() {
        const effects = [];
        for (const [id, plugin] of Object.entries(_activeData())) {
            if (id === LOCAL_PLUGIN_ID) continue;
            const display = plugin.displayName || id;
            for (const e of (plugin.effects || []))
                effects.push({ ...e, _pluginName: id, _pluginDisplay: display });
        }
        return effects;
    },

    // Fire pluginsChanged so all listeners (generalPluginStuff, shipBuilder) refresh
    refreshLocalBuilds() {
        _refreshLocalPlugin();
        _fireEvent('pluginsChanged', { active: [..._activePlugins] });
    },

    // Silent refresh — updates window.allData[LOCAL_PLUGIN_ID] WITHOUT firing
    // pluginsChanged. Used by generalPluginStuff.js to avoid infinite event loops.
    _refreshLocalOnly() {
        _refreshLocalPlugin();
    },

    // ── Attribute helpers ──────────────────────────────────
    getAttrKeys() {
        if (!window.attrDefs || !window.attrDefs.attributes) return [];
        return Object.keys(window.attrDefs.attributes).sort();
    },

    getAttrDef(key) {
        if (!window.attrDefs || !window.attrDefs.attributes) return null;
        return window.attrDefs.attributes[key] || null;
    },

    getAttrHint(key) {
        const def = this.getAttrDef(key);
        if (!def) return '';
        const parts = [];
        if (def.displayUnit) parts.push(def.displayUnit);
        if (def.stacking)    parts.push(def.stacking);
        return parts.join(' · ');
    },

    _setActivePluginsSilent(arr) {
        _activePlugins = arr.filter(id => id === LOCAL_PLUGIN_ID || window.allData[id]);
        _saveActivePlugins();
    },

    LOCAL_PLUGIN_ID,
    DEFAULT_PLUGIN,
};

// ── Persistence for active plugin selection ─────────────────
const _ACTIVE_KEY = 'es_sb_active_plugins';
function _saveActivePlugins() {
    try { localStorage.setItem(_ACTIVE_KEY, JSON.stringify(_activePlugins)); } catch(_) {}
}
function _loadActivePlugins() {
    try { return JSON.parse(localStorage.getItem(_ACTIVE_KEY)); } catch(_) { return null; }
}

// ── Remote data loader ───────────────────────────────────────
//
// Was: one fetch() per plugin per file (ships.json, outfits.json, ...) —
// hundreds of requests, downloading every plugin whether it was used or
// not. Now: one bulk query per TABLE, across every plugin at once, then
// grouped client-side into the exact same window.allData[outputName]
// shape everything downstream (shipBuilder.js, computedStats.js, etc.)
// already expects. Ships/outfits/variants are still small enough in
// total to load eagerly like this; if that ever changes, this is the
// place to switch to per-plugin filtered queries instead (see
// mapDataLoader.js for that pattern, which already loads on demand).
async function _doLoad() {
    _loading = true;
    _fireEvent('dataLoadStart');

    // Seed local builds immediately so it's always available
    _refreshLocalPlugin();

    try {
        // 1 — Attribute definitions. Config/formula data, not entity data —
        // parked as one JSON blob in app_config rather than split into
        // relational columns, since nothing joins against it.
        try {
            const { data, error } = await window.supabaseClient
                .from('app_config').select('value').eq('key', 'attributeDefinitions').maybeSingle();
            if (!error && data) window.attrDefs = data.value;
        } catch (_) {
            console.warn('[DataLoader] Could not load attributeDefinitions from app_config');
        }

        const { fetchAllRows } = window.SupabaseHelpers;

        // 2 — Bulk-fetch every table Supabase holds for ships/outfits/effects
        const [pluginRows, shipRows, variantRows, outfitRows, effectRows, shipOutfitRows, variantOutfitRows] =
            await Promise.all([
                fetchAllRows('plugins'),
                fetchAllRows('ships'),
                fetchAllRows('variants'),
                fetchAllRows('outfits'),
                fetchAllRows('effects'),
                fetchAllRows('ship_outfits'),
                fetchAllRows('variant_outfits'),
            ]);

        const pluginByPluginId = new Map(pluginRows.map(p => [p.plugin_id, p]));
        const outfitById       = new Map(outfitRows.map(o => [o.id, o]));

        // ship_outfits/variant_outfits are junction rows (ship_id, outfit_id,
        // count) — this rebuilds them into the { "Outfit Name": {count,
        // pluginId, internalId} } map shape a ship object used to carry
        // directly, so reconstructShip() below can attach it exactly as
        // shipBuilder.js and computedStats.js already expect.
        function buildOutfitMaps(junctionRows, ownerKey) {
            const byOwner = new Map();
            for (const row of junctionRows) {
                const outfit = outfitById.get(row.outfit_id);
                if (!outfit) continue;
                if (!byOwner.has(row[ownerKey])) byOwner.set(row[ownerKey], {});
                byOwner.get(row[ownerKey])[outfit.name] = {
                    count: row.count,
                    pluginId: outfit.plugin_id,
                    internalId: outfit.internal_id,
                };
            }
            return byOwner;
        }
        const shipOutfitsByShipId       = buildOutfitMaps(shipOutfitRows, 'ship_id');
        const variantOutfitsByVariantId = buildOutfitMaps(variantOutfitRows, 'variant_id');

        function reconstructShip(row, outfitsByOwnerId) {
            const h  = row.hardpoints || {};
            const ex = row.explosions || {};
            return {
                name: row.name,
                sprite: row.sprite,
                thumbnail: row.thumbnail,
                description: row.description,
                attributes: row.attributes || {},
                guns: h.guns || [], turrets: h.turrets || [], bays: h.bays || [],
                engines: h.engines || [], leaks: h.leaks || [],
                reverseEngines: h.reverseEngines || [], steeringEngines: h.steeringEngines || [],
                'tiny explosion': ex.tiny, 'small explosion': ex.small,
                'medium explosion': ex.medium, 'large explosion': ex.large,
                'huge explosion': ex.huge, 'final explode': ex.final,
                locations: row.locations || {},
                outfits: outfitsByOwnerId.get(row.id) || {},
                _pluginId: row.plugin_id,
                _internalId: row.internal_id,
            };
        }
        function reconstructVariant(row) {
            const v = reconstructShip(row, variantOutfitsByVariantId);
            v.baseShip = row.base_ship_name;
            v._variantPluginId = row.variant_plugin_id;
            return v;
        }
        function reconstructOutfit(row) {
            // Note: outfits use non-underscore "pluginId"/"internalId" — this
            // matches the original JSON output's (slightly inconsistent)
            // naming, kept as-is so nothing downstream that reads o.pluginId
            // (vs. a ship's s._pluginId) silently breaks.
            return {
                ...(row.attributes || {}),
                name: row.name, category: row.category, cost: row.cost, mass: row.mass,
                thumbnail: row.thumbnail, description: row.description,
                pluginId: row.plugin_id, internalId: row.internal_id,
            };
        }
        function reconstructEffect(row) {
            return {
                name: row.name, sprite: row.sprite, sound: row.sound,
                lifetime: row.lifetime,
                'random angle': row.random_angle, 'random frame rate': row.random_frame_rate,
                'random spin': row.random_spin, 'random velocity': row.random_velocity,
                'velocity scale': row.velocity_scale,
                spriteData: row.sprite_data, 'sprite data': row.sprite_data,
                pluginId: row.plugin_id,
            };
        }

        // 3 — Group everything by plugin, matching the old per-plugin-folder shape
        for (const p of pluginRows) {
            window.allData[p.output_name] = {
                sourceName: p.source_name,
                displayName: p.display_name || p.output_name,
                outputName: p.output_name,
                ships: [], variants: [], outfits: [], effects: [],
            };
        }
        function pluginBucketFor(row) {
            const plugin = pluginByPluginId.get(row.plugin_id);
            return plugin ? window.allData[plugin.output_name] : null;
        }
        for (const row of shipRows)    { const b = pluginBucketFor(row); if (b) b.ships.push(reconstructShip(row, shipOutfitsByShipId)); }
        for (const row of variantRows) { const b = pluginBucketFor(row); if (b) b.variants.push(reconstructVariant(row)); }
        for (const row of outfitRows)  { const b = pluginBucketFor(row); if (b) b.outfits.push(reconstructOutfit(row)); }
        for (const row of effectRows)  { const b = pluginBucketFor(row); if (b) b.effects.push(reconstructEffect(row)); }

        const hasData = Object.values(window.allData).some(p =>
            (p.ships?.length > 0) || (p.variants?.length > 0) || (p.outfits?.length > 0)
        );
        if (!hasData) throw new Error('No data could be loaded from Supabase');

        _ready   = true;
        _loading = false;

        // FIX: rebuild local plugin now that remote outfits are loaded,
        // so the local plugin's outfit index is populated for ComputedStats.
        _refreshLocalPlugin();

        window.DataLoader.initDefaultPlugins();

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

})();
