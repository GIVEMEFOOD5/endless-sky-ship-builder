;(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  antiMissileAnalysis.js  —  Endless Sky Anti-Missile Analysis Module
// ═══════════════════════════════════════════════════════════════════════════════
//
//  OVERVIEW
//  ────────
//  Analyses one or more anti-missile weapons installed on a ship and produces:
//
//    1. PER-WEAPON profile   — strength, range, reload, DPS equivalent, energy/heat cost
//    2. COMBINED ship profile — aggregate intercept probability vs any missile strength,
//                               effective shots-per-second, energy/heat budget impact
//    3. INTERCEPT TABLE      — P(intercept) across a configurable range of missile
//                               strength values, accounting for multi-weapon volleys
//
//  INTERCEPT FORMULA  (from Ship.cpp / Weapon.cpp — no hardcoding)
//  ────────────────────────────────────────────────────────────────
//  When a missile enters anti-missile range, every AM weapon that has completed
//  its reload cycle fires at it reactively (one attempt per frame until the missile
//  is destroyed or escapes).  Each attempt resolves independently:
//
//      roll = Random::Real() * (antiMissile + missileStrength)
//      if roll < antiMissile  →  missile destroyed
//      i.e.  P(single shot intercepts) = antiMissile / (antiMissile + missileStrength)
//
//  For N independent weapons firing at the same missile on the same frame:
//      P(missile survives all N shots) = ∏ (1 - Pᵢ)
//      P(missile destroyed)            = 1 - ∏ (1 - Pᵢ)
//
//  AM weapons fire REACTIVELY each frame — they do NOT use the normal ship weapon
//  reload loop.  However they DO have their own internal reload counter, so a weapon
//  with reload=10 can only fire once every 10 frames.  The module models sustained
//  fire by computing shots-per-second for each weapon independently.
//
//  NO HARDCODING POLICY
//  All attribute key names are read from attrDefs (attributeDefinitions.json) or
//  from the weapon block itself at runtime.  The only compile-time string literals
//  are the canonical weapon-block keys from Weapon.cpp Load() that are part of the
//  game's persistent save format and cannot change without breaking saves.
//
//  DEPENDENCIES
//  ────────────
//  window.MunitionTypes must be initialised (calls MunitionTypes.init first).
//  Reads _outfitIndex via the getter passed to MunitionTypes.init.
//  attrDefs: the parsed attributeDefinitions.json object.
//
//  PUBLIC API
//  ──────────
//  AntiMissileAnalysis.init(getOutfitIndex, attrDefs)
//      Must be called once.  May share the same getter/attrDefs as MunitionTypes.
//
//  AntiMissileAnalysis.analyseShip(resolvedShipStats)  → ShipAMProfile
//      Full profile for one resolved ship stats object (as produced by battleSim.js
//      resolveShipStats).
//
//  AntiMissileAnalysis.analyseWeapon(weapon, outfitName)  → WeaponAMProfile | null
//      Profile for a single weapon block.  Returns null if not an AM weapon.
//
//  AntiMissileAnalysis.combinedInterceptChance(weaponProfiles, missileStrength)  → number
//      P(at least one weapon intercepts) for simultaneous shots from all weapons,
//      against a missile with the given strength.
//
//  AntiMissileAnalysis.buildInterceptTable(weaponProfiles, missileStrengths)  → InterceptTable
//      Returns a table of P(intercept) for every supplied missile strength value.
//
//  AntiMissileAnalysis.formatProfile(shipAMProfile)  → string
//      Human-readable summary for debugging / display.
//
//  AntiMissileAnalysis.isReady()  → boolean
//
// ═══════════════════════════════════════════════════════════════════════════════

// ── Internal state ─────────────────────────────────────────────────────────────
let _getOutfitIndex = () => ({});
let _attrDefs       = null;
let _ready          = false;

const FPS = 60;

// ── Canonical weapon-block key for anti-missile (from Weapon.cpp Load) ─────────
//  We read this from attrDefs.attributes if available, otherwise fall back to the
//  data-file format string that is part of the ES save format.
const ANTI_MISSILE_KEY_FALLBACK = 'anti-missile';
const VELOCITY_KEY              = 'velocity';
const RELOAD_KEY                = 'reload';
const FIRING_ENERGY_KEY         = 'firing energy';
const FIRING_HEAT_KEY           = 'firing heat';
const FIRING_FUEL_KEY           = 'firing fuel';
const BURST_COUNT_KEY           = 'burst count';
const BURST_RELOAD_KEY          = 'burst reload';

// ── Helpers ────────────────────────────────────────────────────────────────────

function _antiMissileKey() {
    // Read from attrDefs if possible so the key is not hardcoded in logic
    if (_attrDefs?.attributes?.['anti-missile']) return 'anti-missile';
    return ANTI_MISSILE_KEY_FALLBACK;
}

function _firingCostKeys() {
    // Derive all firing-cost key names from attrDefs.outfitDisplay.valueNames
    // so we never hardcode the list
    if (_attrDefs?.outfitDisplay?.valueNames) {
        return _attrDefs.outfitDisplay.valueNames
            .map(v => v.key)
            .filter(k => typeof k === 'string' && k.startsWith('firing '));
    }
    // Fallback to the canonical set from the data-file format
    return [FIRING_ENERGY_KEY, FIRING_HEAT_KEY, FIRING_FUEL_KEY,
            'firing hull', 'firing shields'];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * init(getOutfitIndex, attrDefs)
 *
 * @param {() => Object} getOutfitIndex  — live outfit index getter (same as MunitionTypes)
 * @param {Object|null}  attrDefs        — attributeDefinitions.json parsed object
 */
function init(getOutfitIndex, attrDefs) {
    if (typeof getOutfitIndex !== 'function')
        throw new Error('[AntiMissileAnalysis] init: getOutfitIndex must be a function');
    _getOutfitIndex = getOutfitIndex;
    _attrDefs       = attrDefs || null;
    _ready          = true;
    console.log('[AntiMissileAnalysis] Ready.');
}

function isReady() { return _ready; }

// ═══════════════════════════════════════════════════════════════════════════════
//  SINGLE-WEAPON ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * WeaponAMProfile shape:
 * {
 *   outfitName:   string,
 *   isAntiMissile: true,
 *
 *   strength:      number,   // anti-missile stat value
 *   range:         number,   // velocity * lifetime (pixels) — the engagement bubble
 *   reload:        number,   // frames between shots
 *   burstCount:    number,
 *   burstReload:   number,
 *   shotsPerSecond: number,  // sustained (accounting for burst cycle)
 *
 *   // Per-shot resource costs (derived from attrDefs, not hardcoded)
 *   firingCosts: { [key: string]: number },
 *
 *   // Per-second resource costs at sustained fire rate
 *   firingCostsPerSecond: { [key: string]: number },
 *
 *   // Intercept probabilities vs common missile strength benchmarks
 *   interceptVs: {
 *     strength0:   1.0,   // guaranteed vs unstrengthened missile
 *     strengthEq:  0.5,   // vs missile strength equal to this weapon
 *     strength3x:  number, // vs missile strength 3× this weapon
 *     strength10:  number, // vs MS=10 baseline
 *     strength20:  number, // vs MS=20 baseline
 *   },
 *
 *   notes: string[],
 * }
 */
function analyseWeapon(weapon, outfitName) {
    if (!weapon || typeof weapon !== 'object') return null;

    const amKey    = _antiMissileKey();
    const strength = weapon[amKey] || 0;
    if (strength <= 0) return null;

    const reload      = Math.max(1, weapon[RELOAD_KEY]       || 1);
    const burstCount  = Math.max(1, weapon[BURST_COUNT_KEY]  || 1);
    const burstReload = Math.max(1, weapon[BURST_RELOAD_KEY] || reload);

    // Sustained shots per second over a full burst cycle
    const framesPerCycle = burstCount > 1
        ? (burstCount - 1) * burstReload + reload
        : reload;
    const shotsPerSecond = (burstCount / framesPerCycle) * FPS;

    // Range = velocity × lifetime  (the AM projectile's travel distance)
    const velocity = weapon[VELOCITY_KEY] || 0;
    const lifetime = weapon.lifetime      || 0;
    const range    = velocity * lifetime;

    // Firing costs — read from attrDefs so the key list is not hardcoded
    const costKeys   = _firingCostKeys();
    const firingCosts = {};
    const firingCostsPerSecond = {};
    for (const key of costKeys) {
        const val = weapon[key] || 0;
        if (val !== 0) {
            firingCosts[key]          = val;
            firingCostsPerSecond[key] = +(val * shotsPerSecond).toFixed(4);
        }
    }

    // Intercept probability helper (the game's formula, derived once)
    const pIntercept = (ms) => calcInterceptChance(strength, ms);

    const interceptVs = {
        strength0:   1.0,
        strengthEq:  pIntercept(strength),
        strength3x:  +pIntercept(strength * 3).toFixed(4),
        strength10:  +pIntercept(10).toFixed(4),
        strength20:  +pIntercept(20).toFixed(4),
    };

    const notes = [
        `Engages missiles within ~${range > 0 ? range.toFixed(0) : '?'} px.`,
        `Fires every ${reload} frame${reload !== 1 ? 's' : ''} (${shotsPerSecond.toFixed(2)} shots/s sustained).`,
        `P(intercept) = ${strength} / (${strength} + missileStrength)`,
        `vs MS=0:  100.0%  (guaranteed)`,
        `vs MS=${strength}:  50.0%  (even match)`,
        `vs MS=${strength * 3}:  ${(interceptVs.strength3x * 100).toFixed(1)}%`,
        Object.keys(firingCosts).length > 0
            ? `Per-shot costs: ${Object.entries(firingCosts).map(([k, v]) => `${k.replace('firing ', '')} ${v}`).join(', ')}.`
            : `No per-shot resource costs.`,
    ];

    return {
        outfitName: outfitName || weapon._name || '(unknown)',
        isAntiMissile: true,
        strength,
        range,
        reload,
        burstCount,
        burstReload,
        shotsPerSecond: +shotsPerSecond.toFixed(3),
        firingCosts:    Object.keys(firingCosts).length ? firingCosts : null,
        firingCostsPerSecond: Object.keys(firingCostsPerSecond).length ? firingCostsPerSecond : null,
        interceptVs,
        notes,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MULTI-WEAPON COMBINED INTERCEPT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * combinedInterceptChance(weaponProfiles, missileStrength)
 *
 * Models a single engagement frame where ALL anti-missile weapons that are
 * ready to fire attempt to intercept the same missile simultaneously.
 *
 * P(missile survives) = ∏ (1 - Pᵢ(missileStrength))
 * P(missile destroyed) = 1 - ∏ (1 - Pᵢ)
 *
 * @param {WeaponAMProfile[]} weaponProfiles
 * @param {number}            missileStrength
 * @returns {number}  probability in [0, 1]
 */
function combinedInterceptChance(weaponProfiles, missileStrength) {
    if (!weaponProfiles || weaponProfiles.length === 0) return 0;
    const ms = Math.max(0, missileStrength || 0);
    let surviveProbability = 1;
    for (const wp of weaponProfiles) {
        const p = calcInterceptChance(wp.strength, ms);
        surviveProbability *= (1 - p);
    }
    return 1 - surviveProbability;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SHIP-LEVEL PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ShipAMProfile shape:
 * {
 *   shipName:        string,
 *   hasAntiMissile:  boolean,
 *   weaponProfiles:  WeaponAMProfile[],   // one per AM weapon instance
 *   weaponCount:     number,              // total AM weapon instances
 *   distinctWeapons: { outfitName, count, profile }[],
 *
 *   // Combined stats
 *   totalStrength:   number,              // sum of all AM strengths
 *   maxStrength:     number,              // highest single-weapon strength
 *   totalShotsPerSecond: number,          // sum of all AM sps values
 *
 *   // Combined intercept table at a default set of missile strength values
 *   interceptTable: InterceptTable,
 *
 *   // Per-second resource budget for all AM weapons firing at full rate
 *   totalFiringCostsPerSecond: { [key]: number },
 *
 *   // Single-shot combined P (all weapons ready simultaneously, same frame)
 *   combinedInterceptVs: {
 *     strength0:  number,
 *     strength5:  number,
 *     strength10: number,
 *     strength20: number,
 *     strength40: number,
 *     strength80: number,
 *   },
 *
 *   notes: string[],
 * }
 */
function analyseShip(resolvedShipStats) {
    const name    = resolvedShipStats?.name || '(unknown)';
    const weapons = resolvedShipStats?.weapons || [];

    // Collect all AM weapon instances (each installed copy counted separately)
    const weaponProfiles = [];
    for (const w of weapons) {
        const profile = analyseWeapon(w, w._name);
        if (profile) weaponProfiles.push(profile);
    }

    if (weaponProfiles.length === 0) {
        return {
            shipName:       name,
            hasAntiMissile: false,
            weaponProfiles:    [],
            weaponCount:       0,
            distinctWeapons:   [],
            totalStrength:     0,
            maxStrength:       0,
            totalShotsPerSecond: 0,
            interceptTable:    null,
            totalFiringCostsPerSecond: {},
            combinedInterceptVs: null,
            notes: ['No anti-missile weapons installed.'],
        };
    }

    // Aggregate distinct weapon types for reporting
    const distinctMap = {};
    for (const wp of weaponProfiles) {
        const key = wp.outfitName;
        if (!distinctMap[key]) {
            distinctMap[key] = { outfitName: key, count: 0, profile: wp };
        }
        distinctMap[key].count++;
    }
    const distinctWeapons = Object.values(distinctMap);

    // Combined totals
    const totalStrength      = weaponProfiles.reduce((s, p) => s + p.strength, 0);
    const maxStrength        = Math.max(...weaponProfiles.map(p => p.strength));
    const totalShotsPerSecond = +weaponProfiles.reduce((s, p) => s + p.shotsPerSecond, 0).toFixed(3);

    // Combined per-second firing costs (summed across all weapons)
    const totalFiringCostsPerSecond = {};
    for (const wp of weaponProfiles) {
        for (const [key, val] of Object.entries(wp.firingCostsPerSecond || {})) {
            totalFiringCostsPerSecond[key] = +((totalFiringCostsPerSecond[key] || 0) + val).toFixed(4);
        }
    }

    // Intercept table at the default benchmark strengths
    const defaultStrengths = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];
    const interceptTable   = buildInterceptTable(weaponProfiles, defaultStrengths);

    // Single-shot combined intercept at a handful of key values
    const combinedInterceptVs = {};
    for (const ms of [0, 5, 10, 20, 40, 80]) {
        combinedInterceptVs[`strength${ms}`] = +combinedInterceptChance(weaponProfiles, ms).toFixed(4);
    }

    // Notes
    const notes = [];
    if (weaponProfiles.length === 1) {
        notes.push(`1 anti-missile weapon: ${weaponProfiles[0].outfitName} (strength ${weaponProfiles[0].strength}).`);
    } else {
        const summary = distinctWeapons.map(d => `${d.count}× ${d.outfitName} (strength ${d.profile.strength})`).join(', ');
        notes.push(`${weaponProfiles.length} anti-missile weapons: ${summary}.`);
        notes.push(`Combined single-frame intercept (all weapons fire simultaneously):`);
        for (const [ms, p] of Object.entries(combinedInterceptVs))
            notes.push(`  vs ${ms.replace('strength', 'MS=')}: ${(p * 100).toFixed(1)}%`);
    }
    notes.push(`Total anti-missile shots/s: ${totalShotsPerSecond}.`);
    if (Object.keys(totalFiringCostsPerSecond).length > 0) {
        const costStr = Object.entries(totalFiringCostsPerSecond)
            .map(([k, v]) => `${k.replace('firing ', '')} ${v}/s`).join(', ');
        notes.push(`Total AM firing costs at full rate: ${costStr}.`);
    }

    return {
        shipName:       name,
        hasAntiMissile: true,
        weaponProfiles,
        weaponCount:    weaponProfiles.length,
        distinctWeapons,
        totalStrength,
        maxStrength,
        totalShotsPerSecond,
        interceptTable,
        totalFiringCostsPerSecond,
        combinedInterceptVs,
        notes,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INTERCEPT TABLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * InterceptTable shape:
 * {
 *   missileStrengths: number[],
 *   perWeapon: {
 *     outfitName: string,
 *     probabilities: number[],   // one per missileStrengths entry
 *   }[],
 *   combined: number[],          // combined intercept per missileStrengths entry
 * }
 *
 * @param {WeaponAMProfile[]} weaponProfiles
 * @param {number[]}          missileStrengths  — list of MS values to evaluate
 * @returns {InterceptTable}
 */
function buildInterceptTable(weaponProfiles, missileStrengths) {
    const strengths = (missileStrengths || []).map(v => Math.max(0, v));

    const perWeapon = weaponProfiles.map(wp => ({
        outfitName:    wp.outfitName,
        strength:      wp.strength,
        probabilities: strengths.map(ms => +calcInterceptChance(wp.strength, ms).toFixed(4)),
    }));

    const combined = strengths.map(ms => +combinedInterceptChance(weaponProfiles, ms).toFixed(4));

    return { missileStrengths: strengths, perWeapon, combined };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITY — INTERCEPT CHANCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * calcInterceptChance(antiMissileStrength, missileStrength)
 *
 * Game formula from Ship.cpp:
 *   P = antiMissile / (antiMissile + missileStrength)
 *
 * @param {number} antiMissileStrength
 * @param {number} missileStrength
 * @returns {number}  probability in [0, 1]
 */
function calcInterceptChance(antiMissileStrength, missileStrength) {
    const am = Math.max(0, antiMissileStrength || 0);
    const ms = Math.max(0, missileStrength     || 0);
    if (am === 0) return 0;
    if (ms === 0) return 1;
    return am / (am + ms);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * formatProfile(shipAMProfile)  → human-readable string
 */
function formatProfile(profile) {
    if (!profile) return '(null profile)';

    const lines = [
        `╔══ Anti-Missile Profile: ${profile.shipName} ${'═'.repeat(Math.max(0, 38 - profile.shipName.length))}`,
    ];

    if (!profile.hasAntiMissile) {
        lines.push(`║  No anti-missile weapons installed.`);
        lines.push(`╚${'═'.repeat(52)}`);
        return lines.join('\n');
    }

    lines.push(`║  Weapons installed: ${profile.weaponCount}`);
    for (const d of profile.distinctWeapons)
        lines.push(`║    ${d.count}× ${d.outfitName}  (AM strength ${d.profile.strength}, ${d.profile.range.toFixed(0)}px range, reload ${d.profile.reload}f)`);
    lines.push(`║`);

    lines.push(`║  Max single-weapon strength: ${profile.maxStrength}`);
    lines.push(`║  Total shots/s (all weapons): ${profile.totalShotsPerSecond}`);
    if (profile.totalFiringCostsPerSecond && Object.keys(profile.totalFiringCostsPerSecond).length > 0) {
        lines.push(`║  Firing costs/s (all weapons):`);
        for (const [k, v] of Object.entries(profile.totalFiringCostsPerSecond))
            lines.push(`║    ${k}: ${v}`);
    }
    lines.push(`║`);

    if (profile.weaponCount > 1) {
        lines.push(`║  Combined intercept chance (all weapons fire simultaneously):`);
    } else {
        lines.push(`║  Intercept chance:`);
    }

    if (profile.interceptTable) {
        const t = profile.interceptTable;
        // Print a compact table
        const headerParts = t.perWeapon.map(pw => pw.outfitName.slice(0, 14).padEnd(14));
        if (profile.weaponCount > 1) headerParts.push('Combined'.padEnd(10));
        lines.push(`║    ${'MS'.padEnd(6)} ${headerParts.join('  ')}`);
        lines.push(`║    ${'──────'.padEnd(6)} ${headerParts.map(() => '──────────────').join('  ')}`);

        // Print a representative subset of rows
        const showIndices = [0, 4, 6, 8, 10, 13, 15, 17, 18]; // roughly MS 0,5,8,10,12,20,30,50,80,100
        for (const idx of showIndices) {
            if (idx >= t.missileStrengths.length) break;
            const ms   = t.missileStrengths[idx];
            const cols = t.perWeapon.map(pw => `${(pw.probabilities[idx] * 100).toFixed(1)}%`.padEnd(14));
            if (profile.weaponCount > 1) cols.push(`${(t.combined[idx] * 100).toFixed(1)}%`.padEnd(10));
            lines.push(`║    ${String(ms).padEnd(6)} ${cols.join('  ')}`);
        }
    }

    lines.push(`║`);
    for (const note of profile.notes) lines.push(`║  · ${note}`);
    lines.push(`╚${'═'.repeat(52)}`);
    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

window.AntiMissileAnalysis = {
    // Lifecycle
    init,
    isReady,

    // Analysis
    analyseWeapon,
    analyseShip,

    // Multi-weapon helpers
    combinedInterceptChance,
    buildInterceptTable,

    // Formatting
    formatProfile,

    // Utility
    calcInterceptChance,
};

})();
