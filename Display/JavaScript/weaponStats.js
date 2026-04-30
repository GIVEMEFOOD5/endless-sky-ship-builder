'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  weaponStats.js  —  Endless Sky Weapon DPS & Range Calculator
// ═══════════════════════════════════════════════════════════════════════════════
//
//  Provides two public surfaces:
//
//  1. OUTFIT PANEL  —  getOutfitWeaponStats(outfit, outfitIndex)
//     For a single weapon outfit: full DPS breakdown through the complete
//     submunition tree, effective range (furthest any payload can reach),
//     ammo requirement, firing costs, and per-damage-type breakdown.
//
//  2. SHIP PANEL  —  getShipWeaponStats(ship, outfitIndex)
//     For a configured ship: total DPS across all installed weapon outfits
//     (multiplied by installed count), summed per damage type, plus a
//     per-weapon breakdown for the detail panel.
//
//  DESIGN RULES
//  ─────────────
//  · Zero hardcoded damage type names or weapon attribute keys.
//    Damage keys are discovered by scanning for keys ending in ' damage'
//    on the weapon block (matching the actual data format confirmed in
//    complete.json).
//  · Negative damage values on a parent weapon that also has submunitions
//    are treated as "reduced impact damage" (the real payload is in the
//    submunition tree) — they are included as-is since the game applies them.
//  · Submunition count = length of the offset array for 'submunition X' keys,
//    or 1 for a plain string 'submunition' value.
//  · homing key is an object in this dataset (not an integer); isHoming is
//    checked via truthiness.
//  · FPS = 60 (Endless Sky standard).
//  · Used exclusively by ComputedStats.js — not a standalone module.
//
//  DEPENDENCIES
//  ─────────────
//  None at module level. DamageTypes (window.DamageTypes) is used optionally
//  for shield-interaction metadata if available; all calculations work without it.
//
// ═══════════════════════════════════════════════════════════════════════════════

;(function () {

const FPS              = 60;
const MAX_SUB_DEPTH    = 12;

// ─────────────────────────────────────────────────────────────────────────────
//  Damage key discovery
//  Scans a weapon block for all keys ending in ' damage'.
//  Returns an array of { key, value } for non-zero entries.
// ─────────────────────────────────────────────────────────────────────────────
function _getDamageEntries(weapon) {
    if (!weapon || typeof weapon !== 'object') return [];
    const entries = [];
    for (const [key, val] of Object.entries(weapon)) {
        if (typeof val !== 'number') continue;
        if (!key.endsWith(' damage'))  continue;
        if (val === 0)                 continue;
        entries.push({ key, value: val });
    }
    return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Submunition ref extraction
//
//  Handles both formats present in the data:
//
//  FORMAT A: weapon.submunition = "OutfitName"  (string → count 1)
//  FORMAT B: weapon["submunition OutfitName"] = [{offset}, ...]  (array → count = length)
//            weapon["submunition OutfitName"] = {offset}         (object → count 1)
//
//  Returns Array<{ name: string, count: number }>
// ─────────────────────────────────────────────────────────────────────────────
function _getSubmunitionRefs(weapon) {
    const refs = [];
    if (!weapon) return refs;

    // FORMAT A: plain string
    if (typeof weapon.submunition === 'string' && weapon.submunition.length > 0) {
        refs.push({ name: weapon.submunition, count: 1 });
        return refs;
    }

    // FORMAT B: "submunition <OutfitName>" keys
    for (const key of Object.keys(weapon)) {
        if (!key.startsWith('submunition ')) continue;
        const subName = key.slice('submunition '.length).trim();
        if (!subName) continue;
        const val = weapon[key];
        let count = 1;
        if (Array.isArray(val))             count = val.length;
        else if (typeof val === 'object' && val !== null) count = 1;
        else if (typeof val === 'number')   count = Math.max(1, val);
        refs.push({ name: subName, count });
    }

    return refs;
}

// ─────────────────────────────────────────────────────────────────────────────
//  _calcProjectileRange(weapon)
//
//  Returns the effective range of a single projectile in pixels.
//  Priority: range override > (velocity override OR velocity) × lifetime
// ─────────────────────────────────────────────────────────────────────────────
function _calcProjectileRange(weapon) {
    if (!weapon) return 0;
    if (weapon['range override']) return weapon['range override'];
    const velocity = weapon['velocity override'] || weapon.velocity || 0;
    const lifetime = weapon.lifetime || 0;
    return velocity * lifetime;
}

//
//  Sustained shots/s accounting for burst cycles:
//    single shot:  sps = 1 / reload × FPS
//    burst:        sps = burstCount / ((burstCount-1)×burstReload + reload) × FPS
// ─────────────────────────────────────────────────────────────────────────────
function _resolveShotsPerSecond(weapon) {
    const reload      = Math.max(1, weapon.reload       || 1);
    const burstCount  = Math.max(1, weapon['burst count']  || 1);
    const burstReload = Math.max(1, weapon['burst reload'] || reload);
    const framesPerCycle = burstCount > 1
        ? (burstCount - 1) * burstReload + reload
        : reload;
    return (burstCount / framesPerCycle) * FPS;
}

// ─────────────────────────────────────────────────────────────────────────────
//  _resolveSubmunitionDamage(weapon, outfitIndex, visited, depth)
//
//  Recursively accumulates scaled damage-per-shot across the full submunition
//  tree. Returns:
//  {
//    damagePerShot:   { [damageKey]: number },  // total scaled by counts
//    maxAdditionalRange: number,                 // deepest child's velocity×lifetime
//    subCount:        number,                    // total leaf projectiles
//  }
//
//  The parent weapon's own damage is included (even if negative — the game
//  applies it on impact before the submunition spawns).
// ─────────────────────────────────────────────────────────────────────────────
function _resolveSubmunitionDamage(weapon, outfitIndex, visited, depth) {
    visited = visited || new Set();
    depth   = depth   || 0;

    const result = {
        damagePerShot:      {},
        maxAdditionalRange: 0,
        subCount:           1,  // this projectile itself
    };

    if (!weapon || depth > MAX_SUB_DEPTH) return result;

    // ── Own damage at this node ───────────────────────────────────────────────
    for (const { key, value } of _getDamageEntries(weapon)) {
        result.damagePerShot[key] = (result.damagePerShot[key] || 0) + value;
    }

    // ── Recurse into submunitions ─────────────────────────────────────────────
    const refs = _getSubmunitionRefs(weapon);
    if (refs.length === 0) return result;

    let totalSubLeaves = 0;

    for (const { name, count } of refs) {
        if (visited.has(name)) continue;

        const subOutfit = outfitIndex[name];
        const subWeapon = subOutfit?.weapon || null;

        // Range contribution: this submunition travels from where parent detonates
        const subRange = _calcProjectileRange(subWeapon);

        if (subRange > result.maxAdditionalRange) {
            result.maxAdditionalRange = subRange;
        }

        const childVisited = new Set(visited);
        childVisited.add(name);

        const childResult = _resolveSubmunitionDamage(subWeapon, outfitIndex, childVisited, depth + 1);

        // Scale child damage by how many copies spawn
        for (const [key, val] of Object.entries(childResult.damagePerShot)) {
            result.damagePerShot[key] = (result.damagePerShot[key] || 0) + val * count;
        }

        // Accumulate the deepest additional range through child chains
        const childTotalAdditional = subRange + childResult.maxAdditionalRange;
        if (childTotalAdditional > result.maxAdditionalRange) {
            result.maxAdditionalRange = childTotalAdditional;
        }

        totalSubLeaves += childResult.subCount * count;
    }

    if (totalSubLeaves > 0) result.subCount = totalSubLeaves;

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
//  _calcWeaponProfile(weapon, outfitName, outfitIndex)
//
//  Core calculation for a single weapon block. Returns a WeaponProfile:
//  {
//    outfitName:      string,
//    isAntiMissile:   boolean,
//    isHoming:        boolean,
//    hasAmmo:         boolean,
//    ammoOutfitName:  string|null,
//    ammoPerShot:     number,
//    firingCosts:     { [key]: number }|null,
//    shotsPerSecond:  number,
//    effectiveRange:  number,      // px — parent range + deepest submunition range
//    parentRange:     number,      // px — velocity × lifetime of parent only
//    hasSubmunitions: boolean,
//    subLeafCount:    number,
//    damagePerShot:   { [damageKey]: number },   // full tree, scaled
//    dpsBreakdown:    { [damageKey]: number },   // damagePerShot × shotsPerSecond
//    totalDps:        number,                    // sum of all dps values
//    shieldDps:       number,                    // shield damage key only
//    hullDps:         number,                    // hull damage key only
//  }
// ─────────────────────────────────────────────────────────────────────────────
function _calcWeaponProfile(weapon, outfitName, outfitIndex) {
    const w = weapon;

    const isAntiMissile = (w['anti-missile'] || 0) > 0;
    const isHoming      = !!(w.homing);
    const sps           = _resolveShotsPerSecond(w);

    // Ammo
    const ammoOutfitName = typeof w.ammo === 'string' ? w.ammo : null;
    const ammoPerShot    = 1; // always 1 in this dataset format

    // Firing costs (energy/heat/fuel/hull/shields per shot)
    const COST_KEYS = ['firing energy', 'firing heat', 'firing fuel', 'firing hull', 'firing shields'];
    const firingCosts = {};
    for (const key of COST_KEYS) {
        const val = w[key] || 0;
        if (val) firingCosts[key] = val;
    }

    // Parent range — range override takes precedence over velocity × lifetime.
    // velocity override replaces velocity for display purposes but lifetime still applies.
    const parentRange = _calcProjectileRange(w);

    // Full damage tree + additional range from submunitions
    const treeResult    = _resolveSubmunitionDamage(w, outfitIndex, new Set([outfitName]), 0);
    const effectiveRange = parentRange + treeResult.maxAdditionalRange;

    // DPS = damage per shot × shots per second
    const dpsBreakdown = {};
    let   totalDps     = 0;

    for (const [key, val] of Object.entries(treeResult.damagePerShot)) {
        const dps = val * sps;
        dpsBreakdown[key] = dps;
        totalDps += dps;
    }

    return {
        outfitName,
        isAntiMissile,
        isHoming,
        hasAmmo:         ammoOutfitName !== null,
        ammoOutfitName,
        ammoPerShot,
        firingCosts:     Object.keys(firingCosts).length ? firingCosts : null,
        shotsPerSecond:  +sps.toFixed(4),
        effectiveRange:  +effectiveRange.toFixed(1),
        parentRange:     +parentRange.toFixed(1),
        hasSubmunitions: _getSubmunitionRefs(w).length > 0,
        subLeafCount:    treeResult.subCount,
        damagePerShot:   treeResult.damagePerShot,
        dpsBreakdown,
        totalDps:        +totalDps.toFixed(4),
        shieldDps:       +(dpsBreakdown['shield damage'] || 0).toFixed(4),
        hullDps:         +(dpsBreakdown['hull damage']   || 0).toFixed(4),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC API 1:  getOutfitWeaponStats(outfit, outfitIndex)
//
//  Outfit panel — single weapon outfit.
//  Returns null if the outfit has no weapon block or is an anti-missile weapon
//  (anti-missile weapons don't have conventional DPS; they have intercept chance).
//
//  Returns OutfitWeaponStats:
//  {
//    outfitName:      string,
//    isAntiMissile:   boolean,
//    isHoming:        boolean,
//    hasAmmo:         boolean,
//    ammoOutfitName:  string|null,     // name of required ammo outfit
//    ammoPerShot:     number,
//    firingCosts:     { [key]: number }|null,
//    shotsPerSecond:  number,
//    effectiveRange:  number,          // full chain range in pixels
//    parentRange:     number,          // launcher/gun range only
//    hasSubmunitions: boolean,
//    subLeafCount:    number,          // total projectiles per shot (all levels)
//    damagePerShot:   { [dmgKey]: number },
//    dpsBreakdown:    { [dmgKey]: number },
//    totalDps:        number,
//    shieldDps:       number,
//    hullDps:         number,
//    // Anti-missile specific (only present if isAntiMissile):
//    antiMissileStrength: number,
//  }
// ═══════════════════════════════════════════════════════════════════════════════
function getOutfitWeaponStats(outfit, outfitIndex) {
    if (!outfit?.weapon) return null;

    const profile = _calcWeaponProfile(outfit.weapon, outfit.name, outfitIndex || {});

    // Add anti-missile strength for the panel to display
    if (profile.isAntiMissile) {
        profile.antiMissileStrength = outfit.weapon['anti-missile'] || 0;
    }

    return profile;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC API 2:  getShipWeaponStats(ship, outfitIndex)
//
//  Ship panel — all weapons installed on a ship.
//  Respects installed counts from ship.outfits (new { count, pluginId } format).
//
//  Returns ShipWeaponStats:
//  {
//    // Per-weapon breakdown (for detail panel)
//    weapons: [
//      {
//        outfitName:    string,
//        count:         number,      // how many are installed
//        profile:       OutfitWeaponStats,
//        scaledDps:     number,      // totalDps × count
//        scaledByType:  { [dmgKey]: number },
//      }
//    ],
//
//    // Ship totals
//    totalDps:          number,      // sum across all weapons × counts
//    shieldDps:         number,      // shield damage component only
//    hullDps:           number,      // hull damage component only
//    dpsByType:         { [dmgKey]: number },   // all damage types summed
//
//    // Meta
//    weaponCount:       number,      // distinct weapon outfit types
//    totalWeaponMounts: number,      // sum of all counts
//    hasAmmoWeapons:    boolean,
//    ammoRequired:      [{ outfitName, ammoOutfit, perShot, totalShotsPerSecond }],
//  }
// ═══════════════════════════════════════════════════════════════════════════════
function getShipWeaponStats(ship, outfitIndex) {
    const idx         = outfitIndex || {};
    const outfitMap   = ship.outfits || ship.outfitMap || {};
    const weapons     = [];
    const dpsByType   = {};
    const ammoMap     = {};  // ammoOutfitName → accumulated info

    for (const [outfitName, qtyVal] of Object.entries(outfitMap)) {
        const count  = typeof qtyVal === 'object'
            ? (parseInt(qtyVal.count) || 1)
            : (Number(qtyVal) || 1);

        const outfit = idx[outfitName];
        if (!outfit?.weapon) continue;

        const profile = _calcWeaponProfile(outfit.weapon, outfitName, idx);

        // Scale DPS by installed count
        const scaledByType = {};
        for (const [key, val] of Object.entries(profile.dpsBreakdown)) {
            scaledByType[key] = val * count;
            dpsByType[key]    = (dpsByType[key] || 0) + val * count;
        }

        const scaledDps = profile.totalDps * count;

        weapons.push({
            outfitName,
            count,
            profile,
            scaledDps:  +scaledDps.toFixed(4),
            scaledByType,
        });

        // Track ammo requirements
        if (profile.hasAmmo && profile.ammoOutfitName) {
            const aName = profile.ammoOutfitName;
            if (!ammoMap[aName]) {
                ammoMap[aName] = {
                    ammoOutfitName:      aName,
                    ammoOutfit:          idx[aName] || null,
                    perShot:             profile.ammoPerShot,
                    totalShotsPerSecond: 0,
                };
            }
            ammoMap[aName].totalShotsPerSecond += profile.shotsPerSecond * count;
        }
    }

    // Sort weapons by scaled DPS descending for display
    weapons.sort((a, b) => b.scaledDps - a.scaledDps);

    const totalDps  = weapons.reduce((s, w) => s + w.scaledDps, 0);
    const shieldDps = dpsByType['shield damage'] || 0;
    const hullDps   = dpsByType['hull damage']   || 0;

    return {
        weapons,
        totalDps:          +totalDps.toFixed(4),
        shieldDps:         +shieldDps.toFixed(4),
        hullDps:           +hullDps.toFixed(4),
        dpsByType:         _roundObj(dpsByType),
        weaponCount:       weapons.length,
        totalWeaponMounts: weapons.reduce((s, w) => s + w.count, 0),
        hasAmmoWeapons:    Object.keys(ammoMap).length > 0,
        ammoRequired:      Object.values(ammoMap).map(a => ({
            ...a,
            totalShotsPerSecond: +a.totalShotsPerSecond.toFixed(4),
        })),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utility: round all values in a flat object to 4dp
// ─────────────────────────────────────────────────────────────────────────────
function _roundObj(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = +v.toFixed(4);
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Integration hook for ComputedStats.js
//
//  resolveWeaponStats(attrs, outfitMap, outfitIndex)
//
//  Called from within ComputedStats.getComputedStats() after accumulateOutfits().
//  Injects _ws_* keys into the computed result object:
//
//    _ws_totalDps          — total ship DPS (all weapons × counts)
//    _ws_shieldDps         — shield damage DPS
//    _ws_hullDps           — hull damage DPS
//    _ws_dps_{dmgKey}      — per-type DPS (e.g. _ws_dps_shield_damage)
//    _ws_weaponCount       — distinct weapon outfit types
//    _ws_totalWeaponMounts — sum of all weapon install counts
//    _ws_hasAmmoWeapons    — 1 if any weapon needs ammo, 0 otherwise
//
//  Also stores the full ShipWeaponStats object under _weaponStats for
//  the UI to use without re-parsing.
// ═══════════════════════════════════════════════════════════════════════════════
function resolveWeaponStats(outfitMap, outfitIndex) {
    const ship        = { outfits: outfitMap };
    const stats       = getShipWeaponStats(ship, outfitIndex);
    const flat        = {};

    flat['_ws_totalDps']          = stats.totalDps;
    flat['_ws_shieldDps']         = stats.shieldDps;
    flat['_ws_hullDps']           = stats.hullDps;
    flat['_ws_weaponCount']       = stats.weaponCount;
    flat['_ws_totalWeaponMounts'] = stats.totalWeaponMounts;
    flat['_ws_hasAmmoWeapons']    = stats.hasAmmoWeapons ? 1 : 0;

    for (const [key, val] of Object.entries(stats.dpsByType)) {
        const safe = key.replace(/\s+/g, '_');
        flat[`_ws_dps_${safe}`] = val;
    }

    // Store full structured result for UI panels
    flat['_weaponStats'] = stats;

    return flat;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Export
// ═══════════════════════════════════════════════════════════════════════════════

const WeaponStats = {
    getOutfitWeaponStats,
    getShipWeaponStats,
    resolveWeaponStats,
    // Expose internals for testing
    _calcWeaponProfile,
    _getSubmunitionRefs,
    _getDamageEntries,
    _resolveShotsPerSecond,
    _resolveSubmunitionDamage,
};

if (typeof window !== 'undefined') window.WeaponStats = WeaponStats;
if (typeof module !== 'undefined' && module.exports) module.exports = WeaponStats;

})();
