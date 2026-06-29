// Sorter.js
//
// Builds sortable field lists by scanning ONLY the items currently on screen.
// No attribute names are hardcoded anywhere. Every field offered in the picker
// was found on at least one currently-visible item.
//
// ── Data layout (from the actual JSON files) ────────────────────────────────
//
//   ships / variants
//     Numeric stats live under  item.attributes.*
//     Outfit list lives at      item.outfits  (key→ {count, pluginId})
//     Plugin identity lives at  item._pluginId  (always set in source JSON)
//     Stable cache key at       item._internalId
//
//   outfits
//     Numeric stats live at     item.*  (top-level — NO .attributes sub-object)
//     Weapon sub-stats live at  item.weapon.*  (present on ~40% of outfits)
//
//   effects / other
//     Numeric stats live at     item.*  (top-level)
//
// ── Computed fields (ships / variants only) ──────────────────────────────────
//
//   ComputedStats.getComputedStats(ship, pluginId) accumulates installed
//   outfits and runs the ship-function formulas from attributeDefinitions.json.
//   Results are keyed  _fn_*, _derived_*, _sys_*  and exposed via
//   getComputedSorterFields() which returns  { id, key, label, isComputed:true }.
//
//   getFieldValue() resolves these by calling getComputedStats with the item's
//   own _pluginId so multi-plugin setups work correctly.
//
// ── Accumulated attribute fields (ships / variants only) ─────────────────────
//
//   accumulateOutfits() in ComputedStats.js produces a flat numeric map of all
//   base attributes + outfit contributions stacked together. Any key that is
//   numeric in that result (and not a _fn_/_derived_/_sys_ computed key) is
//   offered as an "Accumulated (with outfits)" field.  These are discovered by
//   calling getComputedStats() on each visible ship and scanning the result —
//   so the list is always driven entirely by what is on screen.
//
// ── Per-outfit-space fields (outfits tab only) ────────────────────────────────
//
//   For each numeric top-level outfit attribute discovered by the normal raw
//   outfit scan (other than 'outfit space' itself), a second derived field is
//   offered that divides that attribute by the item's own 'outfit space'
//   value — e.g. "Mass per Outfit Space", "Fuel Capacity per Outfit Space".
//   This re-uses the exact same key/path discovered during the raw scan, so
//   it stays fully dynamic: no attribute names are hardcoded, and any new
//   numeric outfit attribute that appears in the data automatically gets a
//   matching per-space field. Items without a usable 'outfit space' value
//   (e.g. licenses) simply resolve to no value for these fields, the same way
//   any other missing stat does.
//
// ── Field cache ──────────────────────────────────────────────────────────────
//
//   The field list for each tab is cached keyed by tab name.
//   setSorterItems() deletes the current tab's cache entry so the next
//   getFieldsForTab() call re-scans from the fresh item set.

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeSorters       = [];
let sorterCurrentTab    = 'ships';
let sorterPickerPending = [];
let _sorterItems        = [];   // post-filter items currently on screen
let _sorterAttrDefs     = null;
let _sorterPluginId     = null; // fallback when item has no own _pluginId
let _cachedOutfitIndex  = null;

// ---------------------------------------------------------------------------
// Skip sets — structural / metadata keys that are never sortable.
// ---------------------------------------------------------------------------

const SKIP_TOP_LEVEL = new Set([
    'name', 'description', 'category', 'thumbnail', 'sprite',
    'display name', 'plural', 'series',
    'flare sprite', 'flare sprite data', 'flare sound',
    'reverse flare sprite', 'reverse flare sprite data', 'reverse flare sound',
    'steering flare sprite', 'steering flare sprite data', 'steering flare sound',
    'flotsam sprite', 'afterburner effect', 'jump effect',
    'governments', 'locations', 'licenses', 'linked',
    'pluginId', '_pluginId', '_internalId', '_hash',
    'weapon', 'ammo',
]);

const SKIP_WEAPON = new Set([
    'sprite', 'sprite data', 'hardpoint sprite', 'icon',
    'hit effect', 'fire effect', 'die effect', 'live effect', 'target effect',
    'sound', 'stream', 'cluster', 'submunition', 'ammo',
]);

// Prefixes that mark keys produced by ComputedStats derived/fn/sys resolution.
const COMPUTED_PREFIXES = ['_fn_', '_derived_', '_sys_'];

function isComputedKey(key) {
    return COMPUTED_PREFIXES.some(p => key.startsWith(p));
}

// Key used as the divisor for "per outfit space" fields. This is just a
// normal top-level numeric outfit attribute — it is discovered the same way
// as every other raw outfit field by the scan below. Naming it here only
// tells the per-space pass which already-discovered field to divide by; it
// does not add anything that wasn't already going to be scanned.
const OUTFIT_SPACE_KEY = 'outfit space';

// ---------------------------------------------------------------------------
// Attribute display multiplier helper
//
// attributeDefinitions.json stores raw per-frame values. The displayMultiplier
// converts them to the human-readable unit shown in-game and in AttributeDisplay:
//   ×60    → /s   (shield generation, energy generation, cooling, etc.)
//   ×3600  → /s²  (thrust, reverse thrust, afterburner thrust)
//   ×6000  → %/s  (resistances, status effects, turn, etc.)
//   ×100   → %    (multipliers, protections)
//   ×0.016 → s    (delay attributes)
// ---------------------------------------------------------------------------

function _getDisplayMultiplier(key) {
    if (!_sorterAttrDefs) return 1;
    const def = (_sorterAttrDefs.attributes || {})[key];
    return (def && typeof def.displayMultiplier === 'number' && def.displayMultiplier !== 0)
        ? def.displayMultiplier
        : 1;
}

// ---------------------------------------------------------------------------
// Outfit index cache
//
// IMPORTANT: this index is shared by BOTH tabs (ships' WeaponStats firing-cost
// lookups, and outfits' weapon DPS/range resolution) so that submunition
// references resolve against the SAME merged outfit set everywhere. It is
// intentionally built to mirror ComputedStats._getOutfitIndex()'s priority
// order as closely as possible from outside that module (current plugin
// first, since ComputedStats._getOutfitIndex is private and not exported):
// the active plugin's own outfits win any name collision, then everything
// else is merged in on a first-seen basis. This cannot be byte-for-byte
// identical to ComputedStats' internal _pluginOrder-based merge (that field
// is private), but it removes the previous behavior where the outfits tab
// used a totally separate, differently-ordered merge (or window._outfitIndex)
// than the ships tab — which could pick a different same-named submunition
// outfit between tabs in multi-plugin setups with name collisions.
// ---------------------------------------------------------------------------

function _getOutfitIndex() {
    if (_cachedOutfitIndex) return _cachedOutfitIndex;

    const allData = window.allData || {};
    const merged  = {};

    // 1. Current plugin's own outfits first — matches ComputedStats giving the
    //    ship/outfit's own plugin priority over every other loaded plugin.
    const ownPluginData = _sorterPluginId ? allData[_sorterPluginId] : null;
    if (ownPluginData) {
        for (const o of (ownPluginData.outfits || []))
            if (o.name && !(o.name in merged)) merged[o.name] = o;
    }

    // 2. Everything else, first-seen-wins, as a fallback merge.
    for (const [pid, pd] of Object.entries(allData)) {
        if (pid === _sorterPluginId) continue;
        for (const o of (pd.outfits || []))
            if (o.name && !(o.name in merged)) merged[o.name] = o;
    }

    _cachedOutfitIndex = merged;
    return _cachedOutfitIndex;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyToId(key) {
    return key.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function toTitleCase(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Dynamic field scanner
// ---------------------------------------------------------------------------

function scanFieldsFromItems(tab, items) {
    const isShipLike = tab === 'ships' || tab === 'variants';
    const isOutfits  = tab === 'outfits';

    const shipBaseSeen   = new Set();
    const shipAccumSeen  = new Set();
    const outfitSeen     = new Set();
    const weaponSeen     = new Set();
    const effectSeen     = new Set();
    const perSpaceSeen   = new Set();

    const shipBaseFields  = [];
    const shipAccumFields = [];
    const outfitFields    = [];
    const weaponFields    = [];
    const effectFields    = [];
    const perSpaceFields  = [];

    for (const item of (items || [])) {

        if (isShipLike) {
            // ── Raw base attributes (item.attributes.*) ───────────────────────
            const attrs = item.attributes;
            if (attrs && typeof attrs === 'object') {
                for (const [key, val] of Object.entries(attrs)) {
                    if (typeof val !== 'number') continue;
                    const id = 'raw_attr_' + keyToId(key);
                    if (shipBaseSeen.has(id)) continue;
                    shipBaseSeen.add(id);
                    const mult = _getDisplayMultiplier(key);
                    shipBaseFields.push({
                        id,
                        key,
                        label:             toTitleCase(key) + ' (base)',
                        path:              ['attributes', key],
                        raw:               true,
                        group:             'shipBase',
                        displayMultiplier: mult,
                    });
                }
            }

            // ── Accumulated attributes (via getComputedStats) ─────────────────
            if (typeof getComputedStats === 'function') {
                const pluginId = item._pluginId || _sorterPluginId;
                if (pluginId) {
                    const computed = getComputedStats(item, pluginId);
                    if (computed && typeof computed === 'object') {
                        for (const [key, val] of Object.entries(computed)) {
                            if (typeof val !== 'number')   continue;
                            if (key.startsWith('_'))        continue;
                            if (isComputedKey(key))         continue;
                            const id = 'accum_attr_' + keyToId(key);
                            if (shipAccumSeen.has(id))      continue;
                            shipAccumSeen.add(id);
                            const mult = _getDisplayMultiplier(key);
                            shipAccumFields.push({
                                id,
                                key,
                                label:             toTitleCase(key) + ' (with outfits)',
                                path:              null,
                                useAccum:          true,
                                raw:               false,
                                group:             'shipAccum',
                                displayMultiplier: mult,
                            });
                        }

                        // ── Explicit per-second weapon DPS fields from WeaponStats ──
                        // Always offered once ANY weapon-bearing outfit contributes to
                        // this ship's stats — not gated on a literal `_ws_dps_*` key
                        // being present on THIS particular item, so submunition-only
                        // launchers (whose own _ws_dps_* breakdown keys are still
                        // produced by WeaponStats, since it walks the submunition tree)
                        // are never silently excluded from the picker.
                        const WS_FIELDS = [
                            { wsKey: '_ws_totalDps',         label: 'Total DPS (with outfits)'         },
                            { wsKey: '_ws_shieldDps',        label: 'Shield DPS (with outfits)'        },
                            { wsKey: '_ws_hullDps',          label: 'Hull DPS (with outfits)'          },
                            { wsKey: '_ws_shieldHullDps',    label: 'Shield + Hull DPS (with outfits)' },
                            { wsKey: '_ws_weaponCount',      label: 'Weapon Types (with outfits)'      },
                            { wsKey: '_ws_totalWeaponMounts',label: 'Total Weapon Mounts'              },
                        ];
                        // Also add any _ws_dps_* breakdown keys dynamically. These are
                        // produced by WeaponStats.resolveWeaponStats() from
                        // dpsByType, which is itself summed from each outfit's
                        // _calcWeaponProfile().dpsBreakdown — i.e. already walks
                        // submunitions correctly, no change needed here to pick that up.
                        for (const key of Object.keys(computed)) {
                            if (!key.startsWith('_ws_dps_')) continue;
                            const dmgType = key.slice('_ws_dps_'.length).replace(/_/g, ' ');
                            WS_FIELDS.push({
                                wsKey: key,
                                label: toTitleCase(dmgType) + ' DPS (with outfits)',
                            });
                        }

                        for (const { wsKey, label } of WS_FIELDS) {
                            // _ws_shieldHullDps is synthesized on read (see getFieldValue),
                            // not present on `computed` itself, so don't gate its field
                            // entry on computed[wsKey] existing.
                            const isSynthetic = wsKey === '_ws_shieldHullDps';
                            if (!isSynthetic && computed[wsKey] == null) continue;
                            const id = 'ship_ws_' + keyToId(wsKey);
                            if (shipAccumSeen.has(id)) continue;
                            shipAccumSeen.add(id);
                            shipAccumFields.push({
                                id,
                                key:              wsKey,
                                label,
                                path:             null,
                                useAccum:         !isSynthetic,
                                isShieldHullDpsShip: isSynthetic,
                                raw:              false,
                                group:            'shipAccum',
                                displayMultiplier: 1, // _ws_ keys are already /s
                            });
                        }

                        // ── Firing costs per second from WeaponStats ──────────────
                        // _derived_energy_firing and _derived_heat_firing are zero in
                        // attrDefs because the JSON formula is hardcoded 0.
                        // Get real values from WeaponStats weapon profiles instead.
                        if (window.WeaponStats) {
                            const outfitMap = item.outfitMap || item.outfits || {};
                            const outfitIdx = _getOutfitIndex();
                            const wsStats   = window.WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx);

                            // Aggregate firing costs across all weapons
                            let firingEnergy = 0, firingHeat = 0, firingFuel = 0;
                            for (const w of (wsStats.weapons || [])) {
                                const fc = w.profile?.firingCosts;
                                if (!fc) continue;
                                const sps = w.profile.shotsPerSecond * w.count;
                                firingEnergy += (fc['firing energy'] || 0) * sps;
                                firingHeat   += (fc['firing heat']   || 0) * sps;
                                firingFuel   += (fc['firing fuel']   || 0) * sps;
                            }

                            const FIRING_FIELDS = [
                                { id: 'ship_firing_energy_ps', key: '_firing_energy_ps', label: 'Firing Energy/s (with outfits)', val: firingEnergy },
                                { id: 'ship_firing_heat_ps',   key: '_firing_heat_ps',   label: 'Firing Heat/s (with outfits)',   val: firingHeat   },
                                { id: 'ship_firing_fuel_ps',   key: '_firing_fuel_ps',   label: 'Firing Fuel/s (with outfits)',   val: firingFuel   },
                            ];
                            for (const { id, key, label, val } of FIRING_FIELDS) {
                                if (!val || shipAccumSeen.has(id)) continue;
                                shipAccumSeen.add(id);
                                shipAccumFields.push({
                                    id,
                                    key,
                                    label,
                                    path:              null,
                                    useAccum:          false,
                                    isFiringCost:      true,
                                    firingCostVal:     val,
                                    raw:               false,
                                    group:             'shipAccum',
                                    displayMultiplier: 1,
                                });
                            }
                        }
                    }
                }
            }

        } else if (isOutfits) {
            // ── Top-level numeric outfit fields ──────────────────────────────
            for (const [key, val] of Object.entries(item)) {
                if (SKIP_TOP_LEVEL.has(key)) continue;
                if (typeof val !== 'number')  continue;
                if (key.startsWith('_'))       continue;

                const id = 'raw_' + keyToId(key);
                if (!outfitSeen.has(id)) {
                    outfitSeen.add(id);
                    const mult = _getDisplayMultiplier(key);
                    outfitFields.push({
                        id,
                        key,
                        label:             toTitleCase(key),
                        path:              [key],
                        raw:               true,
                        group:             'outfit',
                        displayMultiplier: mult,
                    });
                }

                // ── Per-outfit-space variant ──────────────────────────────────
                // Built from the SAME raw key just discovered above — not a
                // separate hardcoded list, so any numeric outfit attribute
                // automatically gets a matching "per Outfit Space" field.
                // Skips the space attribute itself (dividing it by itself is
                // meaningless), and is only offered once some currently-visible
                // item actually has a usable (nonzero numeric) 'outfit space'
                // value to divide by — items that lack one (e.g. licenses)
                // just won't produce a value for it at read time either way.
                if (key === OUTFIT_SPACE_KEY) continue;
                const perSpaceId = 'per_space_' + keyToId(key);
                if (perSpaceSeen.has(perSpaceId)) continue;
                if (typeof item[OUTFIT_SPACE_KEY] !== 'number' || item[OUTFIT_SPACE_KEY] === 0) continue;
                perSpaceSeen.add(perSpaceId);
                const mult = _getDisplayMultiplier(key);
                perSpaceFields.push({
                    id:                perSpaceId,
                    key,
                    label:             toTitleCase(key) + ' per Outfit Space',
                    path:              [key],
                    raw:               false,
                    isPerOutfitSpace:  true,
                    group:             'outfitPerSpace',
                    displayMultiplier: mult,
                });
            }

            // ── Numeric fields inside item.weapon ────────────────────────────
            if (item.weapon && typeof item.weapon === 'object') {
                for (const [key, val] of Object.entries(item.weapon)) {
                    if (SKIP_WEAPON.has(key))    continue;
                    if (typeof val !== 'number') continue;
                    if (/^[A-Z]/.test(key))      continue;

                    // ── Per-shot field ───────────────────────────────────────
                    const id = 'weapon_' + keyToId(key);
                    if (!weaponSeen.has(id)) {
                        weaponSeen.add(id);
                        weaponFields.push({
                            id,
                            key,
                            label: toTitleCase(key),
                            path:  ['weapon', key],
                            raw:   true,
                            group: 'weapon',
                        });
                    }
                }

                // ── Computed weapon summary fields ───────────────────────────
                // Added unconditionally once item.weapon exists, regardless of
                // which literal keys that weapon's own JSON happens to carry.
                // This is what lets pure-launcher outfits (reload + submunition
                // pointer, no damage keys of their own) still offer Hull/Shield/
                // Total DPS — those are resolved via WeaponStats._calcWeaponProfile,
                // which walks the submunition tree regardless of what's on the
                // launcher's own weapon block.
                if (!weaponSeen.has('weapon_computed_totalDps')) {
                    weaponSeen.add('weapon_computed_totalDps');
                    weaponFields.push({ id: 'weapon_computed_totalDps',  key: 'totalDps',       label: 'Total DPS',        path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_shieldDps', key: 'shieldDps',      label: 'Shield DPS',       path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_hullDps',   key: 'hullDps',        label: 'Hull DPS',         path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_shieldHullDps', key: 'shieldHullDps', label: 'Shield + Hull DPS', path: null, group: 'weapon', isShieldHullDps: true });
                    weaponFields.push({ id: 'weapon_computed_range',     key: 'effectiveRange', label: 'Effective Range',  path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_sps',       key: 'shotsPerSecond', label: 'Shots Per Second', path: null, group: 'weapon', isOutfitComputed: true });
                }

                // ── Per-damage-type DPS fields ────────────────────────────────
                // Resolved via WeaponStats._calcWeaponProfile(...).dpsBreakdown,
                // which is keyed by every `<x> damage` key found ANYWHERE in the
                // submunition tree (not just on this outfit's own weapon block).
                // Offered unconditionally (one entry per known damage type) so a
                // page of pure launchers still lists "Hull Damage DPS" etc. in the
                // picker, instead of only showing up when some visible outfit
                // happens to carry that literal key on its own JSON.
                if (window.WeaponStats && !weaponSeen.has('weapon_dps_known_types')) {
                    weaponSeen.add('weapon_dps_known_types');
                    const DPS_DAMAGE_TYPES = [
                        'shield', 'hull', 'minable', 'fuel', 'heat', 'energy',
                        'ion', 'scrambling', 'slowing', 'disruption',
                        'discharge', 'corrosion', 'leak', 'burn',
                    ];
                    for (const dmgType of DPS_DAMAGE_TYPES) {
                        const dpsId = 'weapon_dps_' + keyToId(dmgType);
                        if (weaponSeen.has(dpsId)) continue;
                        weaponSeen.add(dpsId);
                        weaponFields.push({
                            id:    dpsId,
                            key:   dmgType,
                            label: toTitleCase(dmgType) + ' DPS',
                            path:  null,
                            raw:   false,
                            group: 'weapon',
                            isDps: true,
                        });
                    }
                }
            }

        } else {
            // ── Top-level numeric fields for effects / other tabs ────────────
            for (const [key, val] of Object.entries(item)) {
                if (typeof val !== 'number') continue;
                if (key.startsWith('_'))      continue;
                const id = 'raw_' + keyToId(key);
                if (effectSeen.has(id)) continue;
                effectSeen.add(id);
                effectFields.push({
                    id,
                    key,
                    label: toTitleCase(key),
                    path:  [key],
                    raw:   true,
                    group: 'effect',
                });
            }
        }
    }

    const alpha = (a, b) => a.label.localeCompare(b.label);
    return {
        shipBaseFields:  shipBaseFields.sort(alpha),
        shipAccumFields: shipAccumFields.sort(alpha),
        outfitFields:    outfitFields.sort(alpha),
        weaponFields:    weaponFields.sort(alpha),
        effectFields:    effectFields.sort(alpha),
        perSpaceFields:  perSpaceFields.sort(alpha),
    };
}

// ---------------------------------------------------------------------------
// Computed fields (ships / variants only)
// ---------------------------------------------------------------------------

function buildComputedFields() {
    if (typeof getComputedSorterFields !== 'function') return [];
    return getComputedSorterFields().map(f => ({ ...f, useComputed: true }));
}

// ---------------------------------------------------------------------------
// Hardpoint count pseudo-fields (ships / variants only)
// ---------------------------------------------------------------------------

const HARDPOINT_FIELDS = [
    { id: '_gunCount',            label: 'Gun Ports',            fn: i => (i.guns            || []).length },
    { id: '_turretCount',         label: 'Turret Ports',         fn: i => (i.turrets         || []).length },
    { id: '_bayCount',            label: 'Bay Count',            fn: i => (i.bays            || []).length },
    { id: '_engineCount',         label: 'Engine Points',        fn: i => (i.engines         || []).length },
    { id: '_reverseEngineCount',  label: 'Reverse Eng. Points',  fn: i => (i.reverseEngines  || []).length },
    { id: '_steeringEngineCount', label: 'Steering Eng. Points', fn: i => (i.steeringEngines || []).length },
];

// ---------------------------------------------------------------------------
// Master field list for a tab
// ---------------------------------------------------------------------------

function buildFieldsForTab(tab, items) {
    const isShipLike = tab === 'ships' || tab === 'variants';
    const isOutfits  = tab === 'outfits';

    const { shipBaseFields, shipAccumFields, outfitFields, weaponFields, effectFields, perSpaceFields } =
        scanFieldsFromItems(tab, items);

    const all    = [];
    const seenId = new Set();
    const add    = f => { if (!seenId.has(f.id)) { all.push(f); seenId.add(f.id); } };

    if (isShipLike) {
        for (const f of buildComputedFields())      add(f);
        for (const f of shipAccumFields)            add(f);
        for (const f of shipBaseFields)             add(f);
        for (const { id, label, fn } of HARDPOINT_FIELDS) {
            add({ id, key: id, label, computed: fn });
        }

    } else if (isOutfits) {
        for (const f of outfitFields)   add(f);
        for (const f of weaponFields)   add(f);
        for (const f of perSpaceFields) add(f);

    } else {
        for (const f of effectFields) add(f);
    }

    return all;
}

// ---------------------------------------------------------------------------
// Field cache — per tab, rebuilt when items change
// ---------------------------------------------------------------------------

const _fieldCache = {};

function getFieldsForTab(tab) {
    if (!_fieldCache[tab]) {
        _fieldCache[tab] = buildFieldsForTab(tab, _sorterItems);
    }
    return _fieldCache[tab];
}

function clearFieldCache() {
    for (const k of Object.keys(_fieldCache)) delete _fieldCache[k];
}

// ---------------------------------------------------------------------------
// Public setters
// ---------------------------------------------------------------------------

function setSorterAttrDefs(defs) {
    _sorterAttrDefs = defs;
    clearFieldCache();
}

function setSorterPluginId(pluginId) {
    _sorterPluginId    = pluginId;
    _cachedOutfitIndex = null;
    clearFieldCache();
    if (typeof clearComputedCache === 'function') clearComputedCache();
}

function setSorterItems(items) {
    _sorterItems = items || [];
    delete _fieldCache[sorterCurrentTab];
    renderSorterBox();
    if (typeof stampSorterValues === 'function') stampSorterValues();
}

// ---------------------------------------------------------------------------
// Value extraction
//
// Resolution order:
//   0a-iii. isPerOutfitSpace — raw outfit attribute divided by that same
//           item's own 'outfit space' value
//   0a-ii. isShieldHullDps / isShieldHullDpsShip — synthesized Shield+Hull DPS
//   0a-i.  isFiringCost   — WeaponStats firing-cost aggregation
//   0a.    isOutfitComputed  — WeaponStats profile fields (range, sps, totalDps…)
//   0b.    isDps             — per-damage-type DPS, via WeaponStats._calcWeaponProfile
//   1.     field.computed    — hardpoint count lambda
//   2.     isComputed/useComputed — _fn_/_derived_/_sys_ via getComputedStats
//   3.     useAccum          — accumulated attr (base + outfits) via getComputedStats
//   4.     field.path        — raw path walk on the item
//
// NOTE: submunition resolution for BOTH tabs now goes exclusively through
// WeaponStats (_calcWeaponProfile / getShipWeaponStats / resolveWeaponStats)
// and ComputedStats (getComputedStats). Sorter.js no longer re-implements any
// submunition-tree walking itself — it only calls into those two modules and
// reads the fields they already expose. This removes the previous duplicate,
// buggier walker that used a single shared `visited` Set across sibling
// branches (which could undercount weapons whose submunition tree reconverges
// on a shared outfit reached via more than one path).
// ---------------------------------------------------------------------------

function getFieldValue(item, field) {

    // 0a-iii. Per-outfit-space ratio — OUTFITS tab.
    // Walks field.path on the raw item to get the numerator (same walk as
    // case 4 below), then divides by this item's own 'outfit space' value,
    // read fresh from the item rather than anything cached at scan time.
    if (field.isPerOutfitSpace) {
        const space = item[OUTFIT_SPACE_KEY];
        if (typeof space !== 'number' || space === 0) return undefined;
        let obj = item;
        for (const k of field.path) {
            if (obj == null) return undefined;
            obj = obj[k];
        }
        if (typeof obj !== 'number') return undefined;
        const mult = field.displayMultiplier || _getDisplayMultiplier(field.key);
        return (obj * mult) / space;
    }

    // 0a-ii. Shield + Hull DPS — OUTFITS tab.
    // Sourced from WeaponStats._calcWeaponProfile(...), the exact same call
    // isOutfitComputed uses for shieldDps/hullDps individually — just summed.
    if (field.isShieldHullDps) {
        if (!item.weapon || !window.WeaponStats) return undefined;
        const profile = window.WeaponStats._calcWeaponProfile(item.weapon, item.name, _getOutfitIndex());
        if (!profile) return undefined;
        const shieldDps = profile.shieldDps ?? 0;
        const hullDps   = profile.hullDps   ?? 0;
        return (shieldDps || hullDps) ? shieldDps + hullDps : undefined;
    }

    // 0a-ii. Shield + Hull DPS — SHIPS tab.
    // Sourced from getComputedStats(...)['_ws_shieldDps'] + ['_ws_hullDps'],
    // which ComputedStats already populates (via WeaponStats.resolveWeaponStats)
    // by walking every outfit's full submunition tree. No new computation here,
    // just summing two fields ComputedStats already exposes.
    if (field.isShieldHullDpsShip) {
        if (typeof getComputedStats !== 'function') return undefined;
        const pluginId = item._pluginId || _sorterPluginId;
        if (!pluginId) return undefined;
        const stats = getComputedStats(item, pluginId);
        if (!stats) return undefined;
        const shieldDps = stats['_ws_shieldDps'] ?? 0;
        const hullDps   = stats['_ws_hullDps']   ?? 0;
        return (shieldDps || hullDps) ? shieldDps + hullDps : undefined;
    }

    // 0a-i. Firing cost fields (energy/heat/fuel per second from WeaponStats)
    if (field.isFiringCost) {
        // Value was pre-computed at scan time and stored on the field descriptor.
        // Re-compute live here so it reflects the actual item being evaluated.
        if (!window.WeaponStats) return undefined;
        const outfitMap = item.outfitMap || item.outfits || {};
        const outfitIdx = _getOutfitIndex();
        const wsStats   = window.WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx);
        let firingEnergy = 0, firingHeat = 0, firingFuel = 0;
        for (const w of (wsStats.weapons || [])) {
            const fc = w.profile?.firingCosts;
            if (!fc) continue;
            const sps = w.profile.shotsPerSecond * w.count;
            firingEnergy += (fc['firing energy'] || 0) * sps;
            firingHeat   += (fc['firing heat']   || 0) * sps;
            firingFuel   += (fc['firing fuel']   || 0) * sps;
        }
        if (field.key === '_firing_energy_ps') return firingEnergy || undefined;
        if (field.key === '_firing_heat_ps')   return firingHeat   || undefined;
        if (field.key === '_firing_fuel_ps')   return firingFuel   || undefined;
        return undefined;
    }

    // 0a. Outfit computed weapon profile (range, sps, totalDps, shieldDps, hullDps)
    if (field.isOutfitComputed) {
        if (!item.weapon || !window.WeaponStats) return undefined;
        const profile = window.WeaponStats.getOutfitWeaponStats(item, _getOutfitIndex());
        if (!profile) return undefined;
        return profile[field.key] ?? undefined;
    }

    // 0b. Weapon DPS per damage type — OUTFITS tab.
    // Delegates entirely to WeaponStats._calcWeaponProfile(...).dpsBreakdown,
    // which walks the full submunition tree (cycle-guarded with a per-branch
    // cloned `visited` Set, depth-capped at 8) exactly the same way the ships
    // tab's _ws_dps_* fields do. Sorter.js does not walk submunitions itself.
    if (field.isDps) {
        if (!item.weapon || !window.WeaponStats) return undefined;
        const profile = window.WeaponStats._calcWeaponProfile(item.weapon, item.name, _getOutfitIndex());
        if (!profile) return undefined;
        const dmgKey = field.key + ' damage';
        const val = profile.dpsBreakdown?.[dmgKey];
        return (val != null && val !== 0) ? val : undefined;
    }

    // 1. Inline computed (hardpoint counts)
    if (field.computed) return field.computed(item);

    // 2. ComputedStats — _fn_/_derived_/_sys_ physics stats
    if ((field.isComputed || field.useComputed) && typeof getComputedStats === 'function') {
        const pluginId = item._pluginId || _sorterPluginId;
        if (pluginId) {
            const stats = getComputedStats(item, pluginId);
            const val   = stats?.[field.key];
            if (val != null) {
                // _fn_ keys need displayScale applied (ComputedStats stores raw value)
                if (field.key.startsWith('_fn_') && _sorterAttrDefs) {
                    const fnName = field.key.slice(4);
                    const fnData = (_sorterAttrDefs.shipFunctions || {})[fnName];
                    const scale  = fnData?.displayScale ?? 1;
                    return val * scale;
                }
                return val;
            }
        }
    }

    // 3. Accumulated attribute (base + outfit contributions stacked)
    if (field.useAccum && typeof getComputedStats === 'function') {
        const pluginId = item._pluginId || _sorterPluginId;
        if (pluginId) {
            const stats = getComputedStats(item, pluginId);
            const val   = stats?.[field.key];
            if (val != null) {
                const mult = field.displayMultiplier || _getDisplayMultiplier(field.key);
                return val * mult;
            }
        }
    }

    // 4. Walk path on the raw item
    if (field.path && field.path.length > 0) {
        let obj = item;
        for (const k of field.path) {
            if (obj == null) return undefined;
            obj = obj[k];
        }
        if (typeof obj === 'number') {
            const mult = field.displayMultiplier || _getDisplayMultiplier(field.key || (field.path[field.path.length - 1]));
            return obj * mult;
        }
        return obj;
    }

    return undefined;
}

function formatAvgValue(val) {
    if (val == null) return '—';
    if (typeof val === 'number') {
        if (val >= 10000) return val.toLocaleString(undefined, { maximumFractionDigits: 0 });
        if (Number.isInteger(val)) return val.toLocaleString();
        return val.toFixed(2);
    }
    return String(val);
}

// ---------------------------------------------------------------------------
// Core sort
// ---------------------------------------------------------------------------

function applySorters(items) {
    if (activeSorters.length === 0) return items;

    const fields = getFieldsForTab(sorterCurrentTab);

    return [...items].sort((a, b) => {
        for (const sorter of activeSorters) {
            const field = fields.find(f => f.id === sorter.id);
            if (!field) continue;

            const av = getFieldValue(a, field);
            const bv = getFieldValue(b, field);

            const aMissing = av == null || (typeof av === 'number' && isNaN(av));
            const bMissing = bv == null || (typeof bv === 'number' && isNaN(bv));

            if (aMissing && bMissing) continue;
            if (aMissing) return 1;
            if (bMissing) return -1;

            const diff = sorter.dir === 'asc' ? av - bv : bv - av;
            if (diff !== 0) return diff;
        }
        return 0;
    });
}

// ---------------------------------------------------------------------------
// Average calculation
// ---------------------------------------------------------------------------

function computeAverage(sorter) {
    const fields = getFieldsForTab(sorterCurrentTab);
    const field  = fields.find(f => f.id === sorter.id);
    if (!field || _sorterItems.length === 0) return '—';

    const vals = _sorterItems
        .map(item => getFieldValue(item, field))
        .filter(v => v != null && typeof v === 'number' && !isNaN(v));

    if (vals.length === 0) return '—';
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return formatAvgValue(avg);
}

// ---------------------------------------------------------------------------
// Render active sorter pills
// ---------------------------------------------------------------------------

async function renderSorterBox() {
    const box = document.getElementById('sorterActiveList');
    if (!box) return;

    if (activeSorters.length === 0) {
        box.innerHTML = '<span class="sorter-empty">No sorters active. Click "Add Sorter" to begin.</span>';
        return;
    }

    box.innerHTML = '';

    activeSorters.forEach((sorter, idx) => {
        const row = document.createElement('div');
        row.className = 'sorter-row';

        const label = document.createElement('span');
        label.className   = 'sorter-label';
        label.textContent = sorter.label;

        const avg = document.createElement('span');
        avg.className   = 'sorter-avg';
        avg.textContent = `avg: ${computeAverage(sorter)}`;

        const dirBtn = document.createElement('button');
        dirBtn.className   = 'sorter-dir-btn';
        dirBtn.textContent = sorter.dir === 'asc' ? '↑ Asc' : '↓ Desc';
        dirBtn.onclick = async () => {
            sorter.dir = sorter.dir === 'asc' ? 'desc' : 'asc';
            renderSorterBox();
            await _triggerFilterItems();
        };

        const upBtn = document.createElement('button');
        upBtn.className   = 'sorter-move-btn';
        upBtn.textContent = '▲';
        upBtn.disabled    = idx === 0;
        upBtn.onclick = async () => {
            [activeSorters[idx - 1], activeSorters[idx]] = [activeSorters[idx], activeSorters[idx - 1]];
            renderSorterBox();
            await _triggerFilterItems();
        };

        const downBtn = document.createElement('button');
        downBtn.className   = 'sorter-move-btn';
        downBtn.textContent = '▼';
        downBtn.disabled    = idx === activeSorters.length - 1;
        downBtn.onclick = async () => {
            [activeSorters[idx], activeSorters[idx + 1]] = [activeSorters[idx + 1], activeSorters[idx]];
            renderSorterBox();
            await _triggerFilterItems();
        };

        const removeBtn = document.createElement('button');
        removeBtn.className   = 'sorter-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.onclick = async () => {
            activeSorters.splice(idx, 1);
            renderSorterBox();
            await _triggerFilterItems();
        };

        row.appendChild(label);
        row.appendChild(avg);
        row.appendChild(dirBtn);
        row.appendChild(upBtn);
        row.appendChild(downBtn);
        row.appendChild(removeBtn);
        box.appendChild(row);
    });
}

async function _triggerFilterItems() {
    if (typeof filterItems === 'function') await filterItems();
}

// ---------------------------------------------------------------------------
// Picker popup
// ---------------------------------------------------------------------------

function openSorterPicker() {
    sorterPickerPending = activeSorters.map(s => s.id);

    const overlay = document.getElementById('sorterPickerOverlay');
    const search  = document.getElementById('sorterPickerSearch');
    if (!overlay) return;

    search.value = '';
    renderPickerList('');
    overlay.classList.add('sorter-overlay-visible');
    search.focus();
}

function closeSorterPicker() {
    const overlay = document.getElementById('sorterPickerOverlay');
    if (overlay) overlay.classList.remove('sorter-overlay-visible');
}

async function confirmSorterPicker() {
    const fields = getFieldsForTab(sorterCurrentTab);

    for (const id of sorterPickerPending) {
        if (!activeSorters.find(s => s.id === id)) {
            const field = fields.find(f => f.id === id);
            if (field) {
                activeSorters.push({
                    id:               field.id,
                    key:              field.key,
                    label:            field.label,
                    path:             field.path             || null,
                    computed:         field.computed         || null,
                    useComputed:      field.useComputed      || false,
                    isComputed:       field.isComputed       || false,
                    useAccum:         field.useAccum         || false,
                    isDps:            field.isDps            || false,
                    isOutfitComputed: field.isOutfitComputed || false,
                    isFiringCost:     field.isFiringCost     || false,
                    isShieldHullDps:     field.isShieldHullDps     || false,
                    isShieldHullDpsShip: field.isShieldHullDpsShip || false,
                    isPerOutfitSpace:    field.isPerOutfitSpace    || false,
                    displayMultiplier: field.displayMultiplier || 1,
                    dir:              'desc',
                });
            }
        }
    }

    activeSorters = activeSorters.filter(s => sorterPickerPending.includes(s.id));

    closeSorterPicker();
    renderSorterBox();
    await _triggerFilterItems();
}

// ---------------------------------------------------------------------------
// Stamp sorter values onto cards
// ---------------------------------------------------------------------------

function stampSorterValues() {
    const container = document.getElementById('cardsContainer');
    if (!container) return;

    container.querySelectorAll('.sorter-badges').forEach(el => { el.innerHTML = ''; });

    if (activeSorters.length === 0) return;

    const fields = getFieldsForTab(sorterCurrentTab);

    for (const card of container.querySelectorAll('.card')) {
        const itemId = card.dataset.itemId;
        if (!itemId) continue;

        const item = _sorterItems.find(
            i => (i._internalId || i.name || '') == itemId
        );
        if (!item) continue;

        const badgeArea = card.querySelector('.sorter-badges');
        if (!badgeArea) continue;

        for (const sorter of activeSorters) {
            const field = fields.find(f => f.id === sorter.id);
            if (!field) continue;

            const val = getFieldValue(item, field);
            if (val == null) continue;

            const badge = document.createElement('div');
            badge.className = 'sorter-badge';
            badge.innerHTML = `<span class="sorter-badge-label">${field.label}</span>`
                            + `<span class="sorter-badge-value">${formatAvgValue(val)}</span>`;
            badgeArea.appendChild(badge);
        }
    }
}

// ---------------------------------------------------------------------------
// Picker list renderer
// ---------------------------------------------------------------------------

function renderPickerList(query) {
    const list = document.getElementById('sorterPickerList');
    if (!list) return;

    const fields = getFieldsForTab(sorterCurrentTab);
    const lq     = query.toLowerCase().trim();

    list.innerHTML = '';

    const filtered = lq
        ? fields.filter(f =>
            f.label.toLowerCase().includes(lq) ||
            (f.key && f.key.toLowerCase().includes(lq)))
        : fields;

    if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:0.9rem;padding:8px;';
        empty.textContent   = 'No matching fields.';
        list.appendChild(empty);
        return;
    }

    let groups;

    if (sorterCurrentTab === 'ships' || sorterCurrentTab === 'variants') {
        const computed  = filtered.filter(f => f.isComputed || f.useComputed);
        const accum     = filtered.filter(f => (f.useAccum || f.isShieldHullDpsShip) && !f.isComputed && !f.useComputed);
        const hardpoint = filtered.filter(f => f.computed && !f.isComputed && !f.useComputed && !f.useAccum);
        const base      = filtered.filter(f => !f.isComputed && !f.useComputed && !f.computed && !f.useAccum && !f.isShieldHullDpsShip);

        groups = [
            { label: '⚡ Computed — Physics (with outfits)',     fields: computed  },
            { label: '📦 Accumulated Attributes (with outfits)', fields: accum     },
            { label: '🔩 Base Attributes (hull only)',            fields: base      },
            { label: '🎯 Hardpoints',                            fields: hardpoint },
        ];

    } else if (sorterCurrentTab === 'outfits') {
        const outfitAttrs    = filtered.filter(f => f.group === 'outfit');
        const perSpace       = filtered.filter(f => f.group === 'outfitPerSpace');
        const weaponPerShot  = filtered.filter(f => f.group === 'weapon' && !f.isDps && !f.isOutfitComputed && !f.isShieldHullDps);
        const weaponDps      = filtered.filter(f => f.group === 'weapon' && f.isDps);
        const weaponComputed = filtered.filter(f => f.group === 'weapon' && (f.isOutfitComputed || f.isShieldHullDps));

        groups = [
            { label: 'Outfit Attributes',                fields: outfitAttrs    },
            { label: '📐 Efficiency (per Outfit Space)',  fields: perSpace       },
            { label: '⚡ Weapon — Computed Stats',        fields: weaponComputed },
            { label: '💥 Weapon — DPS',                   fields: weaponDps      },
            { label: '🎯 Weapon — Per Shot',              fields: weaponPerShot  },
        ];

    } else {
        groups = [{ label: null, fields: filtered }];
    }

    for (const { label: groupLabel, fields: groupFields } of groups) {
        if (groupFields.length === 0) continue;

        if (groupLabel) {
            const header = document.createElement('div');
            header.style.cssText =
                'color:#63b3ed;font-size:11px;font-weight:700;letter-spacing:.1em;' +
                'text-transform:uppercase;padding:8px 8px 4px;margin-top:4px;' +
                'border-top:1px solid rgba(59,130,246,0.2);';
            header.textContent = groupLabel;
            list.appendChild(header);
        }

        for (const field of groupFields) {
            const row = document.createElement('div');
            row.className = 'sorter-picker-row';

            const checkbox    = document.createElement('input');
            checkbox.type     = 'checkbox';
            checkbox.id       = `sp-${field.id}`;
            checkbox.checked  = sorterPickerPending.includes(field.id);
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    if (!sorterPickerPending.includes(field.id))
                        sorterPickerPending.push(field.id);
                } else {
                    sorterPickerPending = sorterPickerPending.filter(id => id !== field.id);
                }
            };

            const lbl       = document.createElement('label');
            lbl.htmlFor     = `sp-${field.id}`;
            lbl.textContent = field.label;

            row.onclick = e => { if (e.target !== checkbox) checkbox.click(); };
            row.appendChild(checkbox);
            row.appendChild(lbl);
            list.appendChild(row);
        }
    }
}

// ---------------------------------------------------------------------------
// Tab change
// ---------------------------------------------------------------------------

function onSorterTabChange(tab) {
    sorterCurrentTab = tab;
    activeSorters    = [];
    delete _fieldCache[tab];
    renderSorterBox();
}

// ---------------------------------------------------------------------------
// Global exports
// ---------------------------------------------------------------------------

window.applySorters        = applySorters;
window.setSorterItems      = setSorterItems;
window.setSorterAttrDefs   = setSorterAttrDefs;
window.setSorterPluginId   = setSorterPluginId;
window.renderSorterBox     = renderSorterBox;
window.openSorterPicker    = openSorterPicker;
window.closeSorterPicker   = closeSorterPicker;
window.confirmSorterPicker = confirmSorterPicker;
window.renderPickerList    = renderPickerList;
window.onSorterTabChange   = onSorterTabChange;
window.stampSorterValues   = stampSorterValues;
