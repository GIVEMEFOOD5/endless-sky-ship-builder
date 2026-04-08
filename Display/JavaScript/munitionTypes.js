;(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  munitionTypes.js  —  Endless Sky Munition Analysis Module
// ═══════════════════════════════════════════════════════════════════════════════
//
//  OVERVIEW
//  ────────
//  This module analyses every weapon (outfit with a "weapon" block) loaded into
//  the outfit index and classifies it across five orthogonal axes:
//
//    1. ANTI-MISSILE   — weapons that intercept projectiles in flight
//    2. TRACKING       — homing/guidance system type and effective tracking score
//    3. MISSILE STRENGTH — a projectile's resistance to interception
//    4. AMMO & STORAGE — what consumable each weapon requires and where it comes from
//    5. SUBMUNITIONS   — recursive payload chains (submunition trees)
//
//  NO HARDCODING POLICY (mirrors damageTypes.js / battleSim.js)
//  All field names are read from the outfit data or from attrDefs where available.
//  The only compile-time constants here are the canonical weapon-block key names
//  that are defined by the Endless Sky data file format itself (Weapon.cpp Load),
//  which cannot change without breaking all existing save files.
//
//  DEPENDENCIES
//  ────────────
//  Requires window.DamageTypes to be ready (for damage-type lookups on submunitions).
//  Reads _outfitIndex (the flat map of outfitName → outfit) from the calling scope
//  via the getter function passed to MunitionTypes.init().
//
//  PUBLIC API
//  ──────────
//  MunitionTypes.init(getOutfitIndex, attrDefs)
//      Must be called once after outfit data is loaded.
//      getOutfitIndex: () => { [name]: outfit }  — live getter, not a snapshot.
//      attrDefs: the parsed attributeDefinitions object (may be null).
//
//  MunitionTypes.analyseWeapon(weapon, outfitName)  → MunitionProfile
//      Full profile for a single weapon block.
//
//  MunitionTypes.analyseOutfit(outfit)  → MunitionProfile | null
//      Convenience wrapper; returns null if outfit has no weapon block.
//
//  MunitionTypes.buildRegistry()  → MunitionRegistry
//      Scans every outfit in the index and returns categorised lists.
//
//  MunitionTypes.getAmmoTree(outfitName)  → AmmoNode | null
//      Resolves the full ammo-supply chain for a given weapon outfit.
//
//  MunitionTypes.resolveSubmunitionTree(weapon, rootName)  → SubTree
//      Recursively resolves the submunition DAG (depth-limited to 12).
//
//  MunitionTypes.formatProfile(profile)  → string
//      Human-readable summary for debugging / display.
//
// ═══════════════════════════════════════════════════════════════════════════════

// ── Internal state ────────────────────────────────────────────────────────────
let _getOutfitIndex = () => ({});
let _attrDefs       = null;
let _ready          = false;

// ── Constants (data-file format keys — from Weapon.cpp Load) ─────────────────

// Tracking / guidance keys present in the weapon block
const TRACKING_KEYS = [
    'homing',             // integer 0-4+; general homing level
    'tracking',           // generic tracking score (0–1 fraction)
    'optical tracking',   // tracks heat/visual signatures
    'infrared tracking',  // tracks engine heat
    'radar tracking',     // tracks radar cross-section; jammed by scrambling
];

// Anti-missile intercept key
const ANTI_MISSILE_KEY = 'anti-missile';

// Missile strength key (projectile side of interception)
const MISSILE_STRENGTH_KEY = 'missile strength';

// Ammo consumption key in the weapon block
// Ammo detection uses dual-format scan — see _buildAmmoProfile

// Firing-cost keys that represent consumable expenditure (not outfit attributes)
const FIRING_COST_KEYS = [
    'firing energy',
    'firing heat',
    'firing fuel',
    'firing hull',
    'firing shields',
];

// Firing status-injection keys (carried on the shooter, not the target)
const FIRING_STATUS_KEYS = [
    'firing ion',
    'firing scramble',
    'firing disruption',
    'firing discharge',
    'firing corrosion',
    'firing leak',
    'firing burn',
    'firing slowing',
];

// Submunition structural keys
const SUBMUNITION_KEYS = ['submunition', 'cluster', 'stream'];

// Burst / reload timing keys
const TIMING_KEYS = ['reload', 'burst count', 'burst reload'];

// Range / flight keys
const FLIGHT_KEYS = ['velocity', 'lifetime', 'range', 'turn', 'acceleration',
                     'drag', 'hardpoint angle', 'safe range'];

// Proximity / trigger keys
const TRIGGER_KEYS = ['trigger radius', 'blast radius', 'hit force',
                      'split range', 'missile strength'];

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * init(getOutfitIndex, attrDefs)
 *
 * @param {() => Object} getOutfitIndex  — returns the live outfit index map
 * @param {Object|null}  attrDefs        — attributeDefinitions.json parsed object
 */
function init(getOutfitIndex, attrDefs) {
    if (typeof getOutfitIndex !== 'function')
        throw new Error('[MunitionTypes] init: getOutfitIndex must be a function');
    _getOutfitIndex = getOutfitIndex;
    _attrDefs       = attrDefs || null;
    _ready          = true;
    console.log('[MunitionTypes] Ready.');
}

function isReady() { return _ready; }

// ═══════════════════════════════════════════════════════════════════════════════
//  CORE ANALYSIS  —  analyseWeapon(weapon, outfitName)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MunitionProfile shape:
 * {
 *   outfitName:    string,
 *   isWeapon:      true,
 *
 *   // ── Anti-missile ────────────────────────────────────────────────────
 *   antiMissile: {
 *     isAntiMissile:   boolean,    // true if anti-missile > 0
 *     strength:        number,     // raw anti-missile value
 *     interceptChance: number,     // against a target with missileStrength=0 (=1.0 max)
 *     notes:           string[],
 *   },
 *
 *   // ── Tracking / homing ───────────────────────────────────────────────
 *   tracking: {
 *     isHoming:          boolean,
 *     homingLevel:       number,   // integer from 'homing' key
 *     homingDescription: string,   // plain-English level name
 *     trackingScore:     number,   // effective 0–1 combined tracking fraction
 *     trackingBreakdown: [{ key, value, contribution }],
 *     turningRate:       number,   // 'turn' key — how fast the projectile steers
 *     acceleration:      number,   // 'acceleration' key
 *     drag:              number,   // 'drag' key on projectile
 *   },
 *
 *   // ── Missile strength ────────────────────────────────────────────────
 *   missileStrength: {
 *     value:        number,   // 'missile strength' key on this weapon
 *     survivalOdds: string,   // human-readable vs common AM values
 *     notes:        string[],
 *   },
 *
 *   // ── Ammo & storage ──────────────────────────────────────────────────
 *   ammo: {
 *     hasAmmo:          boolean,
 *     ammoOutfitName:   string|null,    // name of the outfit that IS the ammo
 *     ammoStorageKey:   string|null,    // attribute key used as ammo counter
 *     ammoPerShot:      number,         // how many ammo units consumed per shot
 *     firingCosts:      { [key]: number }, // energy/heat/fuel/hull/shields per shot
 *     firingStatusInj:  { [key]: number }, // status injected onto self per shot
 *     ammoOutfitDetails: Object|null,   // the ammo outfit record (if found)
 *     storageCapacityKey: string|null,  // attribute that provides storage space
 *   },
 *
 *   // ── Submunitions ────────────────────────────────────────────────────
 *   submunitions: {
 *     hasSubmunitions: boolean,
 *     isCluster:       boolean,   // 'cluster' structural flag
 *     isStream:        boolean,   // 'stream' structural flag
 *     tree:            SubTree,   // see resolveSubmunitionTree()
 *     totalDamageTypes: string[], // all damage types present across the full tree
 *     maxDepth:         number,
 *     leafCount:        number,   // total individual sub-projectiles
 *   },
 *
 *   // ── Timing & range ──────────────────────────────────────────────────
 *   timing: {
 *     reload:           number,
 *     burstCount:       number,
 *     burstReload:      number,
 *     shotsPerSecond:   number,   // sustained (accounting for burst cycle)
 *     burstDuration:    number,   // frames for a full burst
 *   },
 *   range: {
 *     velocity:     number,
 *     lifetime:     number,
 *     effectiveRange: number,    // velocity * lifetime (pixels)
 *     safeRange:    number,
 *     blastRadius:  number,
 *     triggerRadius: number,
 *     splitRange:   number,
 *   },
 *
 *   // ── Classification tags ─────────────────────────────────────────────
 *   tags: string[],   // e.g. ['homing', 'anti-missile', 'burst', 'submunition', ...]
 * }
 */
function analyseWeapon(weapon, outfitName) {
    if (!weapon || typeof weapon !== 'object')
        return null;

    const w = weapon;
    const name = outfitName || w._name || '(unknown)';

    // ── Anti-missile ──────────────────────────────────────────────────────────
    const amStr   = w[ANTI_MISSILE_KEY] || 0;
    const antiMissile = _buildAntiMissileProfile(amStr);

    // ── Tracking ─────────────────────────────────────────────────────────────
    const tracking = _buildTrackingProfile(w);

    // ── Missile strength ─────────────────────────────────────────────────────
    const missileStrength = _buildMissileStrengthProfile(w);

    // ── Ammo ─────────────────────────────────────────────────────────────────
    const ammo = _buildAmmoProfile(w, name);

    // ── Submunitions ─────────────────────────────────────────────────────────
    const submunitions = _buildSubmunitionProfile(w, name);

    // ── Timing ───────────────────────────────────────────────────────────────
    const reload      = Math.max(1, w.reload      || 1);
    const burstCount  = Math.max(1, w['burst count']  || 1);
    const burstReload = Math.max(1, w['burst reload'] || reload);
    const framesPerCycle = burstCount > 1
        ? (burstCount - 1) * burstReload + reload
        : reload;
    const shotsPerSecond = (burstCount / framesPerCycle) * 60; // FPS = 60

    // ── Range ────────────────────────────────────────────────────────────────
    const velocity   = w.velocity   || 0;
    const lifetime   = w.lifetime   || 0;
    const effectiveRange = velocity * lifetime;

    // ── Tags ─────────────────────────────────────────────────────────────────
    const tags = _buildTags(w, antiMissile, tracking, missileStrength, submunitions, burstCount, ammo);

    return {
        outfitName:    name,
        isWeapon:      true,
        antiMissile,
        tracking,
        missileStrength,
        ammo,
        submunitions,
        timing: {
            reload, burstCount, burstReload,
            shotsPerSecond: +shotsPerSecond.toFixed(3),
            burstDuration:  burstCount > 1 ? (burstCount - 1) * burstReload : 0,
        },
        range: {
            velocity,
            lifetime,
            effectiveRange,
            safeRange:     w['safe range']     || 0,
            blastRadius:   w['blast radius']   || 0,
            triggerRadius: w['trigger radius'] || 0,
            splitRange:    w['split range']    || 0,
        },
        tags,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  _buildAntiMissileProfile
// ─────────────────────────────────────────────────────────────────────────────
//
//  From Ship.cpp / Weapon.cpp: the intercept check is a random draw.
//  When an AM weapon fires at a missile the game resolves:
//
//      roll = Random::Real() * (antiMissile + missileStrength)
//      if roll < antiMissile  →  missile destroyed
//
//  i.e.  P(intercept) = antiMissile / (antiMissile + missileStrength)
//
//  For a missile with strength 0:  P = 1.0 (guaranteed)
//  For equal values:               P = 0.5
//
//  Anti-missile weapons are unusual because they DO NOT use the normal
//  weapon reload/shoot loop — the game fires them reactively when a
//  missile enters range each frame. They cannot also be regular weapons.
// ─────────────────────────────────────────────────────────────────────────────
function _buildAntiMissileProfile(amStr) {
    const isAntiMissile = amStr > 0;
    const notes = [];
    if (isAntiMissile) {
        notes.push(
            `Intercept formula: P = antiMissile / (antiMissile + missileStrength)`,
            `vs missile strength 0: P = 1.0 (guaranteed)`,
            `vs missile strength ${amStr}: P = 0.50 (even match)`,
            `vs missile strength ${amStr * 3}: P = ${(amStr / (amStr + amStr * 3)).toFixed(2)}`,
            `Anti-missile weapons fire reactively each frame at missiles in range — ` +
            `they do NOT go through the normal weapon reload loop.`,
        );
    }
    return {
        isAntiMissile,
        strength:        amStr,
        interceptChance: isAntiMissile ? 1.0 : 0,  // vs strength-0 missile
        notes,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  _buildTrackingProfile
// ─────────────────────────────────────────────────────────────────────────────
//
//  Homing in Endless Sky works on a 0–4 integer scale (the 'homing' key)
//  plus fractional per-type tracking scores.  The effective guidance is
//  the maximum of all tracking fractions (they do not add together).
//
//  Homing levels (from Weapon.h / Weapon.cpp):
//    0 — unguided (no homing key or homing = 0)
//    1 — partial:   tracking * straight-line intercept
//    2 — seeking:   turns toward target each frame using 'turn'
//    3 — infrared:  as seeking but only tracks engine heat
//    4 — scrambled: as seeking but tracking degrades under scrambling
//
//  The distinct tracking fraction keys each represent a sensor modality.
//  The game picks whichever is highest (or the combined 'tracking' key).
//
//  'turn' (degrees/frame) — how fast the projectile can steer.
//  High turn = tight tracking; low turn = wide sweeping arcs.
// ─────────────────────────────────────────────────────────────────────────────
const HOMING_LEVEL_NAMES = [
    'Unguided',
    'Partial (straight-line intercept)',
    'Seeking (steers toward target)',
    'Infrared-seeking (tracks engine heat)',
    'Radar-seeking (disrupted by scrambling)',
];

function _buildTrackingProfile(w) {
    const homingLevel = Math.floor(w.homing || 0);
    const isHoming    = homingLevel > 0;

    const breakdown = [];
    let bestScore = 0;

    for (const key of TRACKING_KEYS) {
        if (key === 'homing') continue;   // integer level, not a 0-1 score
        const val = w[key] || 0;
        if (val > 0) {
            breakdown.push({ key, value: val, contribution: val });
            if (val > bestScore) bestScore = val;
        }
    }

    // 'tracking' is the generic fallback fraction (0–1)
    // optical/infrared/radar are alternate sensor types; game uses whichever applies
    // effective score = best available (they are not summed)
    const trackingScore = bestScore;

    return {
        isHoming,
        homingLevel,
        homingDescription: HOMING_LEVEL_NAMES[Math.min(homingLevel, HOMING_LEVEL_NAMES.length - 1)]
                         || `Level ${homingLevel}`,
        trackingScore:     +trackingScore.toFixed(4),
        trackingBreakdown: breakdown,
        turningRate:   w.turn         || 0,
        acceleration:  w.acceleration || 0,
        drag:          w.drag         || 0,
        notes: isHoming ? [
            `'turn' (${w.turn || 0} deg/frame) governs how sharply the missile steers.`,
            `Tracking score ${(trackingScore * 100).toFixed(1)}% = fraction of frames the ` +
            `missile actively homes. At 1.0 it homes every frame.`,
            breakdown.length > 1
                ? `Multiple sensor types present; game uses the best applicable type for the target.`
                : '',
        ].filter(Boolean) : [],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  _buildMissileStrengthProfile
// ─────────────────────────────────────────────────────────────────────────────
//
//  'missile strength' on a WEAPON means its projectiles are that hard to shoot
//  down. The interception formula (see _buildAntiMissileProfile) is symmetric:
//
//      P(AM intercepts) = antiMissile / (antiMissile + missileStrength)
//
//  So missileStrength = 0  →  any AM weapon intercepts 100%
//     missileStrength = X  →  needs AM >= X for even odds
//
//  Note: "missile strength 0" AND "homing 0" means it is just a kinetic bolt —
//  it cannot be shot down (no missile to track) unless it has missile strength > 0.
//  Anti-missile weapons in the vanilla game only trigger against homing projectiles
//  OR against any projectile with missile strength > 0.
// ─────────────────────────────────────────────────────────────────────────────
function _buildMissileStrengthProfile(w) {
    const value = w[MISSILE_STRENGTH_KEY] || 0;
    const notes = [];

    if (value > 0) {
        notes.push(
            `Requires AM strength > ${value} for >50% intercept chance.`,
            `P(survive single AM shot) = missileStrength / (AM + missileStrength)`,
            `Example: vs AM-20 this missile has ${(value / (20 + value) * 100).toFixed(1)}% survival.`,
            `Example: vs AM-${value} this missile has 50.0% survival (even match).`,
        );
    } else {
        notes.push(
            value === 0 && (w.homing || 0) > 0
                ? `Homing missile with strength 0 — any AM weapon guarantees interception.`
                : `Non-missile projectile (missile strength 0, not homing) — ` +
                  `anti-missile weapons do not normally target this.`,
        );
    }

    return { value, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
//  _buildAmmoProfile
// ─────────────────────────────────────────────────────────────────────────────
//
//  Endless Sky ammunition works as follows (from Weapon.cpp / Outfit.cpp):
//
//  A weapon with an 'ammo' key consumes one unit of the named outfit per shot.
//  The ammo outfit defines a storage attribute (usually "<name> capacity" or
//  just the outfit's presence in the cargo/installed list acts as the counter).
//  In the data files the ammo outfit itself contributes e.g. "Javelin" +1 to
//  the ship's attribute set.  The weapon's 'ammo' block references that outfit
//  name so the engine knows to decrement it.
//
//  Some weapons consume ammo at a rate other than 1/shot (burst weapons may
//  consume 1 per burst-shot, not 1 per burst cycle).
//
//  Firing costs (energy/heat/fuel/hull/shields) are separate from ammo —
//  they are consumed each time the weapon fires regardless of ammo type.
//
//  'ammoStored' on the outfit record is the compiled storage amount.
// ─────────────────────────────────────────────────────────────────────────────
function _buildAmmoProfile(w, outfitName) {
    // In the ES data-file / ship-builder JSON there are two ammo formats:
    //
    // FORMAT A — single ammo, 1 per shot:
    //   weapon: { ammo: "Javelin" }
    //   The key is literally "ammo" and the value is the outfit name string.
    //
    // FORMAT B — explicit count:
    //   weapon: { "Javelin": 2 }
    //   The ammo outfit name IS the key; the value is the per-shot count (number).
    //   value === true also means 1 (boolean from some parsers).
    //
    // We check FORMAT A first, then scan all keys for FORMAT B.

    const index = _getOutfitIndex();

    let ammoOutfitName    = null;
    let ammoPerShot       = 1;
    let ammoOutfitDetails = null;
    let storageCapacityKey = null;

    // ── FORMAT A: weapon.ammo = "OutfitName" ─────────────────────────────────
    const rawAmmoField = w['ammo'];
    if (typeof rawAmmoField === 'string' && rawAmmoField.length > 0) {
        ammoOutfitName    = rawAmmoField;
        ammoPerShot       = 1;
        ammoOutfitDetails = index[ammoOutfitName] || null;
    }

    // ── FORMAT B: weapon["OutfitName"] = count|true ──────────────────────────
    // Only run if FORMAT A didn't match.
    if (!ammoOutfitName) {
        for (const key of Object.keys(w)) {
            if (key === 'ammo') continue;          // already checked above
            const val = w[key];
            if (val === false || val === 0 || val === null || val === undefined) continue;
            if (typeof val !== 'number' && val !== true) continue;

            const candidate = index[key];
            if (!candidate) continue;

            // Confirm it is an ammo outfit via any of the three conventions:
            //   (a) explicit ammoStored field
            //   (b) category === 'Ammunition'
            //   (c) own-name attribute (e.g. outfit "Javelin" has attribute "Javelin" = N)
            // NEW — add negative-capacity check:
            const isAmmo =
                candidate.category === 'Ammunition' ||
                (typeof candidate.ammoStored === 'number' && candidate.ammoStored > 0) ||
                (typeof candidate.attributes?.[key] === 'number' && candidate.attributes[key] > 0) ||
                (() => {
                    // negative-capacity ammo: has a "* capacity": -1 attribute
                    const entries = Object.entries(candidate.attributes || {});
                    return entries.some(([k, v]) => k.endsWith(' capacity') && typeof v === 'number' && v < 0) ||
                           Object.keys(candidate).some(k =>
                               !['name','category','cost','mass','thumbnail','description',
                                 'weapon','attributes','_pluginId','series','index'].includes(k) &&
                               k.endsWith(' capacity') && typeof candidate[k] === 'number' && candidate[k] < 0
                           );
                })();
            if (!isAmmo) continue;

            ammoOutfitName    = key;
            ammoPerShot       = val === true ? 1 : Math.max(1, Math.round(val));
            ammoOutfitDetails = candidate;
            break;   // weapons never reference more than one ammo type
        }
    }

    // Resolve storage details if we found an ammo outfit
    if (ammoOutfitName && !ammoOutfitDetails)
        ammoOutfitDetails = index[ammoOutfitName] || null;

    if (ammoOutfitDetails) {
        if (typeof ammoOutfitDetails.ammoStored === 'number' && ammoOutfitDetails.ammoStored > 0)
            storageCapacityKey = 'ammoStored';
        else if (ammoOutfitDetails.attributes?.[ammoOutfitName] > 0)
            storageCapacityKey = ammoOutfitName;
        else
            storageCapacityKey = ammoOutfitName;
    }

    const hasAmmo = ammoOutfitName !== null;

    // Firing costs
    const firingCosts = {};
    for (const key of FIRING_COST_KEYS) {
        const val = w[key] || 0;
        if (val) firingCosts[key] = val;
    }

    // Firing status injections (applied to the attacker, not the target)
    const firingStatusInj = {};
    for (const key of FIRING_STATUS_KEYS) {
        const val = w[key] || 0;
        if (val) firingStatusInj[key] = val;
    }

    return {
        hasAmmo,
        ammoOutfitName,
        ammoStorageKey:  storageCapacityKey,
        ammoPerShot,
        firingCosts:     Object.keys(firingCosts).length     ? firingCosts     : null,
        firingStatusInj: Object.keys(firingStatusInj).length ? firingStatusInj : null,
        ammoOutfitDetails,
        storageCapacityKey,
        notes: _buildAmmoNotes(hasAmmo, ammoOutfitName, ammoPerShot, firingCosts, ammoOutfitDetails),
    };
}

function _buildAmmoNotes(hasAmmo, ammoOutfitName, ammoPerShot, firingCosts, ammoOutfitDetails) {
    const notes = [];
    if (hasAmmo) {
        notes.push(`Consumes ${ammoPerShot} × "${ammoOutfitName}" per shot.`);
        if (ammoOutfitDetails) {
            const stored = ammoOutfitDetails.ammoStored;
            if (typeof stored === 'number' && stored > 0)
                notes.push(`Each "${ammoOutfitName}" outfit unit provides ${stored} rounds of storage.`);
            const cat = ammoOutfitDetails.category;
            if (cat) notes.push(`Ammo category: ${cat}.`);
        } else {
            notes.push(`Ammo outfit "${ammoOutfitName}" not found in current outfit index — may be from a different plugin.`);
        }
    } else {
        notes.push(`No ammo requirement — fires indefinitely as long as firing costs are met.`);
    }
    const costSummary = Object.entries(firingCosts || {})
        .map(([k, v]) => `${k.replace('firing ', '')}: ${v}`)
        .join(', ');
    if (costSummary) notes.push(`Per-shot resource costs: ${costSummary}.`);
    return notes;
}

// ─────────────────────────────────────────────────────────────────────────────
//  _buildSubmunitionProfile  +  resolveSubmunitionTree
// ─────────────────────────────────────────────────────────────────────────────
//
//  A "submunition" entry in the weapon block means that when the projectile
//  hits (or detonates), it spawns additional projectiles.  These can be:
//
//    submunition "Outfit Name"           — spawns 1 copy
//    submunition "Outfit Name" 4         — spawns 4 copies
//    submunition { name: ..., count: N } — compiled object form
//
//  Submunitions can themselves have submunitions (cluster bombs, etc.).
//  The game caps this at a reasonable depth in practice.
//
//  'cluster' flag — all submunitions fire at once in a spread pattern
//  'stream'  flag — submunitions release one per frame over 'lifetime' frames
//
//  SubTree node shape:
//  {
//    name:        string,
//    count:       number,    // how many spawn
//    depth:       number,
//    weapon:      Object|null,   // weapon block of this submunition outfit
//    outfit:      Object|null,   // full outfit record
//    children:    SubTree[],
//    damageTypes: string[],      // damage types at THIS node only
//    totalDamageContribution: { [type]: number }  // scaled by count * parent counts
//  }
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SUBMUNITION_DEPTH = 12;

/**
 * _resolveSubmunitionRefs(w)  →  Array<{ subName, subCount }>
 *
 * Dual-format submunition parsing (internal to munitionTypes):
 *
 * FORMAT A: w.submunition = "Name" | { name, count } | array of those
 * FORMAT B: w["OutfitName"] = count | true  (outfit name as key)
 *
 * Returns array of { subName, subCount } pairs.
 */
function _resolveSubmunitionRefs(w) {
    const results = [];

    // FORMAT A
    const rawSub = w.submunition;
    if (rawSub != null) {
        const entries = Array.isArray(rawSub) ? rawSub : [rawSub];
        for (const entry of entries) {
            const subName  = typeof entry === 'string' ? entry
                           : typeof entry === 'object' ? (entry?.name ?? null) : null;
            const subCount = typeof entry === 'object' && entry !== null
                           ? (entry.count ?? 1) : 1;
            if (subName) results.push({ subName, subCount });
        }
        if (results.length > 0) return results;
    }

    // FORMAT A2: "submunition <OutfitName>" key with array of offset objects
    // e.g. "submunition Speck": [{"offset": -3}, {"offset": 3}]
    for (const key of Object.keys(w)) {
        if (!key.startsWith('submunition ')) continue;
        const subName = key.slice('submunition '.length).trim();
        if (!subName) continue;
        const val = w[key];
        // val is an array of offset objects — count = array length
        const subCount = Array.isArray(val) ? val.length
                       : typeof val === 'number' ? Math.max(1, val)
                       : 1;
        results.push({ subName, subCount });
    }
    if (results.length > 0) return results;

    // FORMAT B: outfit name as key with numeric count
    const index = _getOutfitIndex();
    for (const key of Object.keys(w)) {
        if (key === 'submunition') continue;
        if (key.startsWith('submunition ')) continue; // already handled above
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;

        const outfit = index[key];
        if (!outfit?.weapon) continue;

        const isAmmo =
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0)
         || outfit.category === 'Ammunition'
         || (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0);
        if (isAmmo) continue;

        const subCount = val === true ? 1 : Math.max(1, Math.round(val));
        results.push({ subName: key, subCount });
    }

    return results;
}

function resolveSubmunitionTree(weapon, rootName, _visited, _depth, _multiplier) {
    const visited    = _visited    || new Set([rootName].filter(Boolean));
    const depth      = _depth      || 0;
    const multiplier = _multiplier || 1;

    if (!weapon || depth > MAX_SUBMUNITION_DEPTH) return null;

    const subRefs = _resolveSubmunitionRefs(weapon);
    if (!subRefs.length) return { name: rootName, count: 1, depth, weapon, children: [], leaf: true, multiplier };

    const children = [];

    for (const { subName, subCount: subCount } of subRefs) {

        if (!subName) continue;
        if (visited.has(subName)) {
            children.push({ name: subName, count: subCount, depth: depth + 1,
                            weapon: null, children: [], cycleRef: true, multiplier: multiplier * subCount });
            continue;
        }

        const nv = new Set(visited);
        nv.add(subName);

        const index    = _getOutfitIndex();
        const subOutfit = index[subName] || null;
        const subWeapon = subOutfit?.weapon || null;

        const child = resolveSubmunitionTree(
            subWeapon, subName, nv, depth + 1, multiplier * subCount
        );

        children.push({
            ...(child || {}),
            name:   subName,
            count:  subCount,
            depth:  depth + 1,
            weapon: subWeapon,
            outfit: subOutfit,
            multiplier: multiplier * subCount,
        });
    }

    return {
        name:     rootName,
        count:    1,
        depth,
        weapon,
        children,
        leaf:     children.length === 0,
        multiplier,
    };
}

function _flattenTree(node, out) {
    if (!node) return;
    out.push(node);
    for (const child of (node.children || [])) _flattenTree(child, out);
}

function _buildSubmunitionProfile(w, outfitName) {
    const isCluster = !!(w.cluster);
    const isStream  = !!(w.stream);
    const hasSubmunitions = _resolveSubmunitionRefs(w).length > 0;

    if (!hasSubmunitions) {
        return {
            hasSubmunitions: false,
            isCluster, isStream,
            tree: null,
            totalDamageTypes: [],
            maxDepth:  0,
            leafCount: 0,
        };
    }

    const tree = resolveSubmunitionTree(w, outfitName);

    // Collect all damage types across every node
    const allDmgTypes = new Set();
    const nodes       = [];
    _flattenTree(tree, nodes);

    let maxDepth  = 0;
    let leafCount = 0;

    for (const node of nodes) {
        if (node.depth > maxDepth) maxDepth = node.depth;
        if (node.leaf || (!node.children || node.children.length === 0)) leafCount += node.count || 1;
        const nw = node.weapon;
        if (!nw) continue;
        // Collect damage type keys (Shield damage, Hull damage, etc.)
        for (const key of Object.keys(nw)) {
            const lower = key.toLowerCase();
            if (lower.endsWith(' damage') && !lower.startsWith('%')) {
                const typeName = key.replace(/ damage$/i, '');
                allDmgTypes.add(typeName);
            }
        }
    }

    return {
        hasSubmunitions: true,
        isCluster,
        isStream,
        tree,
        totalDamageTypes: [...allDmgTypes].sort(),
        maxDepth,
        leafCount,
        notes: _buildSubmunitionNotes(isCluster, isStream, maxDepth, leafCount, tree),
    };
}

function _buildSubmunitionNotes(isCluster, isStream, maxDepth, leafCount, tree) {
    const notes = [];
    if (isCluster) notes.push(`CLUSTER: all submunitions release simultaneously in a spread.`);
    if (isStream)  notes.push(`STREAM: submunitions released one per frame over the lifetime.`);
    if (maxDepth > 1) notes.push(`Multi-stage payload: ${maxDepth} level(s) of nesting.`);
    if (leafCount > 1) notes.push(`Total end-stage projectiles per shot: ${leafCount}.`);
    return notes;
}

// ─────────────────────────────────────────────────────────────────────────────
//  _buildTags
// ─────────────────────────────────────────────────────────────────────────────
function _buildTags(w, antiMissile, tracking, missileStrength, submunitions, burstCount, ammo) {
    const tags = [];
    if (antiMissile.isAntiMissile)        tags.push('anti-missile');
    if (tracking.isHoming)                tags.push('homing');
    if (tracking.homingLevel >= 3)        tags.push('infrared-tracking');
    if (tracking.homingLevel >= 4)        tags.push('radar-tracking');
    if (missileStrength.value > 0)        tags.push('missile');
    if (submunitions.hasSubmunitions)     tags.push('submunition');
    if (submunitions.isCluster)           tags.push('cluster');
    if (submunitions.isStream)            tags.push('stream');
    if (burstCount > 1)                   tags.push('burst');
    if (w['blast radius'] > 0)            tags.push('aoe');
    if ((w.piercing || 0) > 0)            tags.push('piercing');
    if (w['safe range'] > 0)             tags.push('safe-range');
    if ((w['trigger radius'] || 0) > 0)  tags.push('proximity-fused');
    if (ammo && ammo.hasAmmo)              tags.push('ammo');
    return tags;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONVENIENCE WRAPPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * analyseOutfit(outfit)
 * Wraps analyseWeapon; returns null if the outfit has no weapon block.
 */
function analyseOutfit(outfit) {
    if (!outfit?.weapon) return null;
    return analyseWeapon(outfit.weapon, outfit.name);
}

/**
 * getAmmoTree(outfitName)
 *
 * Returns a nested structure describing the full ammo-supply chain:
 * {
 *   outfitName:         string,
 *   weaponProfile:      MunitionProfile | null,
 *   ammoOutfitName:     string | null,
 *   ammoOutfit:         Object | null,
 *   ammoPerShot:        number,
 *   storageCapacityKey: string | null,
 *   roundsPerStorageUnit: number | null,   // ammoStored value if found
 * }
 */
function getAmmoTree(outfitName) {
    const index  = _getOutfitIndex();
    const outfit = index[outfitName];
    if (!outfit?.weapon) return null;

    const profile = analyseWeapon(outfit.weapon, outfitName);
    const ammo    = profile.ammo;

    let roundsPerStorageUnit = null;
    if (ammo.ammoOutfitDetails) {
        const stored = ammo.ammoOutfitDetails.ammoStored;
        if (typeof stored === 'number') roundsPerStorageUnit = stored;
        else {
            // Try reading from the outfit's own attribute (compiled form)
            const attrVal = ammo.ammoOutfitDetails[ammo.ammoOutfitName];
            if (typeof attrVal === 'number') roundsPerStorageUnit = attrVal;
        }
    }

    return {
        outfitName,
        weaponProfile:        profile,
        ammoOutfitName:       ammo.ammoOutfitName,
        ammoOutfit:           ammo.ammoOutfitDetails,
        ammoPerShot:          ammo.ammoPerShot,
        storageCapacityKey:   ammo.storageCapacityKey,
        roundsPerStorageUnit,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REGISTRY  —  buildRegistry()
// ═══════════════════════════════════════════════════════════════════════════════
//
//  Scans every outfit in the index and builds categorised lists.
//
//  MunitionRegistry shape:
//  {
//    antiMissileWeapons:  MunitionProfile[],   // sorted by AM strength desc
//    homingWeapons:       MunitionProfile[],   // sorted by tracking score desc
//    missilesWithStrength: MunitionProfile[],  // sorted by missile strength desc
//    ammoWeapons:         MunitionProfile[],   // weapons that consume ammo
//    freeWeapons:         MunitionProfile[],   // weapons with no ammo requirement
//    submunitionWeapons:  MunitionProfile[],   // weapons with submunition blocks
//    burstWeapons:        MunitionProfile[],   // weapons with burst count > 1
//    allWeapons:          MunitionProfile[],   // every weapon outfit
//    ammoOutfits:         Object[],            // outfits that ARE ammo (no weapon)
//    summary: {
//      total, antiMissile, homing, withMissileStrength,
//      withAmmo, withSubmunitions, withBurst,
//    },
//  }
// ─────────────────────────────────────────────────────────────────────────────
function buildRegistry() {
    const index  = _getOutfitIndex();
    const all    = [];
    const ammoOutfits = [];

    for (const [name, outfit] of Object.entries(index)) {
        if (!outfit) continue;
        if (outfit.weapon) {
            const profile = analyseWeapon(outfit.weapon, name);
            if (profile) all.push(profile);
        } else if (outfit.category === 'Ammunition' ||
                   (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0)) {
            ammoOutfits.push(outfit);
        }
    }

    const antiMissileWeapons   = all.filter(p => p.antiMissile.isAntiMissile)
        .sort((a, b) => b.antiMissile.strength - a.antiMissile.strength);

    const homingWeapons        = all.filter(p => p.tracking.isHoming)
        .sort((a, b) => b.tracking.trackingScore - a.tracking.trackingScore
                     || b.tracking.homingLevel   - a.tracking.homingLevel);

    const missilesWithStrength = all.filter(p => p.missileStrength.value > 0)
        .sort((a, b) => b.missileStrength.value - a.missileStrength.value);

    const ammoWeapons          = all.filter(p => p.ammo.hasAmmo);
    const freeWeapons          = all.filter(p => !p.ammo.hasAmmo);
    const submunitionWeapons   = all.filter(p => p.submunitions.hasSubmunitions)
        .sort((a, b) => b.submunitions.leafCount - a.submunitions.leafCount);

    const burstWeapons         = all.filter(p => p.timing.burstCount > 1)
        .sort((a, b) => b.timing.burstCount - a.timing.burstCount);

    return {
        antiMissileWeapons,
        homingWeapons,
        missilesWithStrength,
        ammoWeapons,
        freeWeapons,
        submunitionWeapons,
        burstWeapons,
        allWeapons:   all,
        ammoOutfits,
        summary: {
            total:                all.length,
            antiMissile:          antiMissileWeapons.length,
            homing:               homingWeapons.length,
            withMissileStrength:  missilesWithStrength.length,
            withAmmo:             ammoWeapons.length,
            withSubmunitions:     submunitionWeapons.length,
            withBurst:            burstWeapons.length,
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FORMATTING  —  formatProfile(profile)
// ═══════════════════════════════════════════════════════════════════════════════

function formatProfile(profile) {
    if (!profile) return '(null profile)';

    const lines = [
        `╔══ ${profile.outfitName} ${'═'.repeat(Math.max(0, 48 - profile.outfitName.length))}`,
        `║  Tags: ${profile.tags.join(', ') || 'none'}`,
        `║`,
    ];

    // Anti-missile
    if (profile.antiMissile.isAntiMissile) {
        lines.push(`║  ANTI-MISSILE`);
        lines.push(`║    Strength: ${profile.antiMissile.strength}`);
        for (const n of profile.antiMissile.notes) lines.push(`║    · ${n}`);
        lines.push(`║`);
    }

    // Tracking
    if (profile.tracking.isHoming) {
        lines.push(`║  TRACKING`);
        lines.push(`║    Homing level: ${profile.tracking.homingLevel} — ${profile.tracking.homingDescription}`);
        lines.push(`║    Effective tracking score: ${(profile.tracking.trackingScore * 100).toFixed(1)}%`);
        lines.push(`║    Turn rate: ${profile.tracking.turningRate} deg/frame`);
        for (const bd of profile.tracking.trackingBreakdown)
            lines.push(`║      ${bd.key}: ${bd.value}`);
        lines.push(`║`);
    }

    // Missile strength
    if (profile.missileStrength.value > 0) {
        lines.push(`║  MISSILE STRENGTH: ${profile.missileStrength.value}`);
        for (const n of profile.missileStrength.notes) lines.push(`║    · ${n}`);
        lines.push(`║`);
    }

    // Ammo
    lines.push(`║  AMMO`);
    if (profile.ammo.hasAmmo) {
        lines.push(`║    Outfit:      ${profile.ammo.ammoOutfitName}`);
        lines.push(`║    Per shot:    ${profile.ammo.ammoPerShot}`);
        lines.push(`║    Storage key: ${profile.ammo.storageCapacityKey || '(same as outfit name)'}`);
        if (profile.ammo.ammoOutfitDetails)
            lines.push(`║    Rounds/unit: ${profile.ammo.ammoOutfitDetails.ammoStored ?? '?'}`);
    } else {
        lines.push(`║    No ammo required.`);
    }
    if (profile.ammo.firingCosts) {
        lines.push(`║    Firing costs:`);
        for (const [k, v] of Object.entries(profile.ammo.firingCosts))
            lines.push(`║      ${k}: ${v}`);
    }
    lines.push(`║`);

    // Submunitions
    if (profile.submunitions.hasSubmunitions) {
        lines.push(`║  SUBMUNITIONS`);
        lines.push(`║    Max depth: ${profile.submunitions.maxDepth}`);
        lines.push(`║    Leaf projectiles: ${profile.submunitions.leafCount}`);
        lines.push(`║    Damage types: ${profile.submunitions.totalDamageTypes.join(', ') || 'none detected'}`);
        if (profile.submunitions.isCluster) lines.push(`║    MODE: cluster (simultaneous spread)`);
        if (profile.submunitions.isStream)  lines.push(`║    MODE: stream (one per frame)`);
        _formatSubTree(profile.submunitions.tree, lines, '║    ');
        lines.push(`║`);
    }

    // Timing
    const t = profile.timing;
    lines.push(`║  TIMING: reload=${t.reload} burst=${t.burstCount}×${t.burstReload} → ${t.shotsPerSecond}/s`);

    // Range
    const r = profile.range;
    if (r.effectiveRange > 0)
        lines.push(`║  RANGE: ${r.velocity} px/f × ${r.lifetime} f = ${r.effectiveRange} px`);
    if (r.blastRadius > 0)   lines.push(`║    Blast radius: ${r.blastRadius}`);
    if (r.triggerRadius > 0) lines.push(`║    Trigger radius: ${r.triggerRadius}`);

    lines.push(`╚${'═'.repeat(52)}`);
    return lines.join('\n');
}

function _formatSubTree(node, lines, indent) {
    if (!node) return;
    const marker = node.leaf ? '◆' : '▼';
    lines.push(`${indent}${marker} ${node.name} ×${node.count || 1}` +
               (node.cycleRef ? ' [CYCLE REF]' : ''));
    for (const child of (node.children || []))
        _formatSubTree(child, lines, indent + '  ');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INTERCEPTION CALCULATOR  (utility exported for UI use)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * calcInterceptChance(antiMissileStrength, missileStrength)
 * Returns the probability [0, 1] that an AM shot with the given strength
 * intercepts a missile with the given strength, per Endless Sky's formula:
 *   P = antiMissile / (antiMissile + missileStrength)
 */
function calcInterceptChance(antiMissileStrength, missileStrength) {
    const am = Math.max(0, antiMissileStrength  || 0);
    const ms = Math.max(0, missileStrength || 0);
    if (am === 0) return 0;
    if (ms === 0) return 1;
    return am / (am + ms);
}

/**
 * calcEffectiveTrackingScore(weapon)
 * Returns the effective 0–1 tracking fraction for a weapon block.
 * Mirrors the logic in _buildTrackingProfile without building the full object.
 */
function calcEffectiveTrackingScore(weapon) {
    let best = 0;
    for (const key of TRACKING_KEYS) {
        if (key === 'homing') continue;
        const val = (weapon && weapon[key]) || 0;
        if (val > best) best = val;
    }
    return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

window.MunitionTypes = {
    // Lifecycle
    init,
    isReady,

    // Analysis
    analyseWeapon,
    analyseOutfit,
    resolveSubmunitionTree,
    getAmmoTree,
    buildRegistry,
    formatProfile,

    // Utilities
    calcInterceptChance,
    calcEffectiveTrackingScore,

    // Constants (read-only copies for external inspection)
    TRACKING_KEYS:       [...TRACKING_KEYS],
    ANTI_MISSILE_KEY,
    MISSILE_STRENGTH_KEY,
    FIRING_COST_KEYS:    [...FIRING_COST_KEYS],
    FIRING_STATUS_KEYS:  [...FIRING_STATUS_KEYS],
    SUBMUNITION_KEYS:    [...SUBMUNITION_KEYS],
    MAX_SUBMUNITION_DEPTH,
    HOMING_LEVEL_NAMES:  [...HOMING_LEVEL_NAMES],
};

})();
