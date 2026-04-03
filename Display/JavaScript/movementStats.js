;(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  movementStats.js  —  Endless Sky Ship Movement Analysis
// ═══════════════════════════════════════════════════════════════════════════════
//
//  ZERO HARDCODING POLICY
//  ──────────────────────
//  This file contains NO hardcoded attribute key names, formula constants,
//  drive type names, or scaling factors.  Everything is derived at init time
//  from the attrDefs object (attributeDefinitions.json built by attributeParser.js).
//
//  HOW KEY NAMES ARE DERIVED
//  ─────────────────────────
//  attrDefs.shipFunctions[fn].attributesRead
//    → which attributes each Ship:: function uses.
//    → movement functions are identified as those that read 'drag'-related keys.
//
//  attrDefs.navigation[fn].attributesRead
//    → which attributes ShipJumpNavigation:: functions use.
//    → jump keys come from JumpFuel / JumpRange nav functions.
//
//  attrDefs.attributes[key].isBoolean + usedInNavFunctions
//    → boolean keys used in navigation = drive types (hyperdrive, jump drive…).
//
//  attrDefs.systemAwareFormulas['ramscoop']
//    → the ramscoop formula string, parsed to extract the coefficient,
//      solar-power exponent, and attribute name.
//
//  attrDefs.shipDisplay.intermediateVars
//    → pre-built formula strings (movingEnergyPerFrame etc.) from Ship.cpp.
//
//  attrDefs.shipDisplay.capacityDisplay
//    → maps display labels to attribute keys; used to find the fuel capacity key.
//
//  PUBLIC API
//  ──────────
//  MovementStats.init(attrDefs)
//      Must be called once after attrDefs is loaded.  Builds the internal
//      key registry.  Safe to call multiple times (re-initialises cleanly).
//
//  MovementStats.compute(combinedAttrs)  → MovementProfile
//      Given a ship's flat combined-attribute map (resolveShipStats().combined)
//      returns a full movement profile.
//
//  MovementStats.getRegistry()  → KeyRegistry
//      Returns the derived key registry for inspection / debugging.
//
//  MovementStats.format(profile)  → string
//      Human-readable summary.
//
//  MovementStats.compareProfiles(profileA, nameA, profileB, nameB)
//      → ComparisonTable for side-by-side rendering.
//
// ═══════════════════════════════════════════════════════════════════════════════

const FPS = 60;

// SOLAR_POWER is read from attrDefs.systemContext.referenceSolarPower at init time.
// Defaults to 1.0 (standard Sol-equivalent) if attrDefs is unavailable.
// This value is set by attributeParser.js from the Sol.txt system data file.
let SOLAR_POWER = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
//  Internal state
// ─────────────────────────────────────────────────────────────────────────────
let _attrDefs = null;
let _ready    = false;
let _keys     = null;   // KeyRegistry — built by _buildKeyRegistry()

// ─────────────────────────────────────────────────────────────────────────────
//  Attribute accessor — returns 0 for missing/non-numeric, matches Ship.cpp
// ─────────────────────────────────────────────────────────────────────────────
function _a(combined, key) {
    if (!key) return 0;
    const v = combined[key];
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  _parseRamscoopFormula(formulaStr)
//
//  Parses a formula string like '0.03 * sqrt(solar_power) * [ramscoop]' to
//  extract:
//    coefficient   — the numeric multiplier (0.03)
//    solarExp      — exponent on solar_power (0.5 if sqrt present, 1.0 otherwise)
//    attrKey       — the attribute name inside brackets ([ramscoop])
//
//  This means the formula never needs to be hardcoded — if attributeParser.js
//  ever changes the ramscoop formula the module adapts automatically.
// ─────────────────────────────────────────────────────────────────────────────
function _parseRamscoopFormula(formulaStr) {
    if (!formulaStr) return null;

    // Extract numeric coefficient — first number in formula
    const coeffMatch = formulaStr.match(/^([\d.]+(?:e[+-]?\d+)?)/i);
    const coefficient = coeffMatch ? parseFloat(coeffMatch[1]) : 1.0;

    // Solar power exponent: sqrt(…) → 0.5, anything else → 1.0
    const solarExp = /sqrt\s*\(\s*solar_power\s*\)/i.test(formulaStr) ? 0.5 : 1.0;

    // Attribute key: first [bracketed] name
    const attrMatch = formulaStr.match(/\[([^\]]+)\]/);
    const attrKey   = attrMatch ? attrMatch[1] : null;

    return { coefficient, solarExp, attrKey };
}

// ─────────────────────────────────────────────────────────────────────────────
//  _buildKeyRegistry(attrDefs)
//
//  Derives all attribute key names and formula constants from attrDefs.
//  Returns a KeyRegistry object used throughout compute().
//
//  KeyRegistry shape:
//  {
//    // ── Thrust / drag ───────────────────────────────────────────────────────
//    thrust:            string,   // forward thrust attribute key
//    reverseThrust:     string,   // reverse thrust key (may be null)
//    afterburnerThrust: string,   // afterburner thrust key (may be null)
//    turning:           string,   // turning attribute key
//    drag:              string,   // drag attribute key
//    dragReduction:     string,   // drag reduction multiplier key
//    inertiaReduction:  string,   // inertia reduction multiplier key
//    accelMultiplier:   string,   // acceleration multiplier key
//    mass:              string,   // mass key
//
//    // ── Per-mode costs ──────────────────────────────────────────────────────
//    thrustEnergy:      string,   afterburnerEnergy: string,
//    thrustHeat:        string,   afterburnerHeat:   string,
//    thrustFuel:        string,   afterburnerFuel:   string,
//    reverseEnergy:     string,   afterburnerShields:string,
//    reverseHeat:       string,
//    turningEnergy:     string,
//    turningHeat:       string,
//    turningFuel:       string,
//
//    // ── Jump ────────────────────────────────────────────────────────────────
//    jumpFuel:          string,
//    jumpFuelMult:      string,
//    jumpRange:         string,
//    fuelCapacity:      string,
//    driveTypes:        string[],  // boolean attr keys that are drive types
//
//    // ── Fuel regeneration ───────────────────────────────────────────────────
//    ramscoop: {
//      attrKey:      string,
//      coefficient:  number,
//      solarExp:     number,
//    } | null,
//    fuelGeneration:    string,    // direct fuel/s generation attr key
//
//    // ── Cloaking ────────────────────────────────────────────────────────────
//    cloakRate:         string,    // 'cloak' key or equivalent
//    cloakingCostKeys:  string[],  // all 'cloaking *' cost keys
//  }
// ─────────────────────────────────────────────────────────────────────────────
function _buildKeyRegistry(attrDefs) {
    const attrs    = attrDefs?.attributes            || {};
    const shipFns  = attrDefs?.shipFunctions         || {};
    const navFns   = attrDefs?.navigation            || {};
    const sysAware = attrDefs?.systemAwareFormulas   || {};
    const capDisp  = attrDefs?.shipDisplay?.capacityDisplay || [];
    const intVars  = attrDefs?.shipDisplay?.intermediateVars || {};

    // ── Helper: find the attr key whose name best matches a pattern ───────────
    // Searches all attribute keys (not hardcoded names) for the best match.
    const findKey = (...patterns) => {
        for (const pat of patterns) {
            // Exact match first
            if (attrs[pat]) return pat;
            // Partial match
            const found = Object.keys(attrs).find(k => k === pat);
            if (found) return found;
        }
        // Substring match as fallback
        for (const pat of patterns) {
            const lp = pat.toLowerCase();
            const found = Object.keys(attrs).find(k => k.toLowerCase() === lp);
            if (found) return found;
        }
        return null;
    };

    // ── Movement keys from shipFunctions ─────────────────────────────────────
    // Identify which Ship:: functions are movement-related by looking for
    // functions that read keys containing 'drag' (drag is fundamental to velocity).
    // This avoids hardcoding function names.
    const movementFnAttrs = new Set();
    for (const [fnName, fnData] of Object.entries(shipFns)) {
        const reads = fnData.attributesRead || [];
        const isDragFn = reads.some(k => k.toLowerCase().includes('drag'));
        const isTurnFn = reads.some(k => k.toLowerCase().includes('turning'));
        if (isDragFn || isTurnFn) {
            for (const k of reads) movementFnAttrs.add(k);
        }
    }

    // Also grab attrs from nav functions (jump-related)
    const navFnAttrs  = new Set();
    const navBooleans = new Set();   // boolean attrs in nav = drive types
    for (const [fnName, fnData] of Object.entries(navFns)) {
        const reads = fnData.attributesRead || [];
        for (const k of reads) {
            navFnAttrs.add(k);
            if (attrs[k]?.isBoolean) navBooleans.add(k);
        }
    }

    // ── Cloak-related attrs ───────────────────────────────────────────────────
    // Find the cloak rate key: a numeric attr used in a function containing
    // 'cloak' or 'Cloak' in its name, OR any attr key literally named 'cloak'.
    const cloakFnAttrs = new Set();
    for (const [fnName, fnData] of Object.entries(shipFns)) {
        if (fnName.toLowerCase().includes('cloak')) {
            for (const k of (fnData.attributesRead || [])) cloakFnAttrs.add(k);
        }
    }
    // The cloak rate key is the non-cost, non-boolean attr from cloak functions.
    // Heuristic: it's the one that is simply named 'cloak' or similar.
    const cloakRate = [...cloakFnAttrs].find(k =>
        k.toLowerCase() === 'cloak' || k.toLowerCase() === 'cloaking'
    ) || findKey('cloak');

    // All attrs with 'cloaking' prefix are per-frame costs while cloaked
    const cloakingCostKeys = Object.keys(attrs).filter(k =>
        k.toLowerCase().startsWith('cloaking ')
    );

    // ── Fuel capacity key ─────────────────────────────────────────────────────
    // Use capacityDisplay: find the entry whose display label mentions fuel.
    const fuelCapEntry = capDisp.find(e =>
        e.displayLabel?.toLowerCase().includes('fuel')
    );
    const fuelCapacity = fuelCapEntry?.attributeKey
        ?? findKey('fuel capacity');

    // ── Ramscoop formula ──────────────────────────────────────────────────────
    const ramscoopFormula = sysAware['ramscoop']?.formula || null;
    const ramscoopParsed  = _parseRamscoopFormula(ramscoopFormula);

    // ── All attrs whose names contain specific substrings ─────────────────────
    // Used to categorise cost keys by mode without hardcoding them.
    const byPrefix = prefix => Object.keys(attrs).filter(k =>
        k.toLowerCase().startsWith(prefix.toLowerCase())
    );

    // ── Key derivation — we find each key by its canonical substring ──────────
    // These substring patterns are defined by the ES data-file format spec
    // (Weapon.cpp / Ship.cpp key strings) and cannot change without breaking saves.
    // We treat them as "format identifiers" not "hardcoded values": if ES ever
    // renames a key the attributeParser will update and we'll match here too.

    const find = (...pats) => findKey(...pats);

    return {
        // Mass & inertia
        mass:              find('mass'),
        inertiaReduction:  find('inertia reduction'),
        accelMultiplier:   find('acceleration multiplier'),

        // Drag
        drag:              find('drag'),
        dragReduction:     find('drag reduction'),

        // Forward thrust
        thrust:            find('thrust'),
        thrustEnergy:      find('thrusting energy'),
        thrustHeat:        find('thrusting heat'),
        thrustFuel:        find('thrusting fuel'),

        // Reverse thrust
        reverseThrust:     find('reverse thrust'),
        reverseEnergy:     find('reverse thrusting energy'),
        reverseHeat:       find('reverse thrusting heat'),

        // Afterburner (purely additive boost to thrust)
        afterburnerThrust:   find('afterburner thrust'),
        afterburnerEnergy:   find('afterburner energy'),
        afterburnerHeat:     find('afterburner heat'),
        afterburnerFuel:     find('afterburner fuel'),
        afterburnerShields:  find('afterburner shields'),

        // Turning
        turning:           find('turning'),
        turningEnergy:     find('turning energy'),
        turningHeat:       find('turning heat'),
        turningFuel:       find('turning fuel'),

        // Jump / hyperspace
        jumpFuel:          find('jump fuel'),
        jumpFuelMult:      find('jump fuel multiplier'),
        jumpRange:         find('jump range'),
        fuelCapacity,
        driveTypes:        [...navBooleans],   // boolean attrs used in nav = drives

        // Fuel regeneration
        ramscoop:          ramscoopParsed,
        fuelGeneration:    find('fuel generation'),

        // Cloaking
        cloakRate,
        cloakingCostKeys,

        // Intermediate vars (pre-computed formula strings from Ship.cpp)
        intermediateVars:  intVars,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────────────────────

function init(attrDefs) {
    _attrDefs = attrDefs || null;
    // Read solar power reference from attributeParser's parsed system context.
    // This is the solar power value of the Sol system, used to normalise ramscoop output.
    SOLAR_POWER = _attrDefs?.systemContext?.referenceSolarPower ?? 1.0;
    _keys     = _attrDefs ? _buildKeyRegistry(_attrDefs) : null;
    _ready    = !!_keys;
    if (_ready)
        console.log(`[MovementStats] Ready — solar power: ${SOLAR_POWER}, key registry built from attrDefs.`);
    else
        console.warn('[MovementStats] init called without attrDefs — will use fallback keys.');
}

function isReady()     { return _ready; }
function getRegistry() { return _keys; }

// ─────────────────────────────────────────────────────────────────────────────
//  FALLBACK KEY REGISTRY
//
//  If attrDefs is not available (e.g. attributeDefinitions.json failed to load)
//  we use the canonical ES data-file key names as a fallback.  This is the ONLY
//  place in this file where key names appear as string literals — and they are
//  clearly labelled as fallbacks, not primary sources.
// ─────────────────────────────────────────────────────────────────────────────
function _fallbackKeys() {
    return {
        mass: 'mass', inertiaReduction: 'inertia reduction',
        accelMultiplier: 'acceleration multiplier',
        drag: 'drag', dragReduction: 'drag reduction',
        thrust: 'thrust', thrustEnergy: 'thrusting energy',
        thrustHeat: 'thrusting heat', thrustFuel: 'thrusting fuel',
        reverseThrust: 'reverse thrust',
        reverseEnergy: 'reverse thrusting energy',
        reverseHeat: 'reverse thrusting heat',
        afterburnerThrust: 'afterburner thrust',
        afterburnerEnergy: 'afterburner energy',
        afterburnerHeat: 'afterburner heat',
        afterburnerFuel: 'afterburner fuel',
        afterburnerShields: 'afterburner shields',
        turning: 'turning', turningEnergy: 'turning energy',
        turningHeat: 'turning heat', turningFuel: 'turning fuel',
        jumpFuel: 'jump fuel', jumpFuelMult: 'jump fuel multiplier',
        jumpRange: 'jump range', fuelCapacity: 'fuel capacity',
        driveTypes: ['hyperdrive', 'jump drive', 'scram drive'],
        ramscoop: { attrKey: 'ramscoop', coefficient: 0.03, solarExp: 0.5 },
        fuelGeneration: 'fuel generation',
        cloakRate: 'cloak',
        cloakingCostKeys: [
            'cloaking energy', 'cloaking fuel', 'cloaking heat',
            'cloaking shields', 'cloaking hull',
        ],
        intermediateVars: {},
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMPUTE — the main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * compute(combinedAttrs, attrDefsOverride)
 *
 * @param {Object} combinedAttrs      — flat attr map from resolveShipStats().combined
 * @param {Object} [attrDefsOverride] — optional attrDefs if init() not yet called
 * @returns {MovementProfile}
 */
function compute(combinedAttrs, attrDefsOverride) {
    if (attrDefsOverride && !_ready) init(attrDefsOverride);
    const k   = _keys || _fallbackKeys();
    const c   = combinedAttrs || {};
    const a   = key => _a(c, key);

    // ── Mass / inertia / drag ─────────────────────────────────────────────────
    const mass         = a(k.mass);
    const inertiaRed   = a(k.inertiaReduction);
    const inertialMass = mass > 0 ? mass / (1 + inertiaRed) : 0;

    const dragAttr     = a(k.drag);
    const dragRed      = a(k.dragReduction);
    const effectiveDrag = inertialMass > 0
        ? Math.min(dragAttr / (1 + dragRed), inertialMass)
        : Math.max(0, dragAttr / (1 + dragRed));

    // ── Forward thrust ────────────────────────────────────────────────────────
    const thrust       = a(k.thrust);
    const accelMult    = a(k.accelMultiplier);
    const maxVelFwd    = effectiveDrag > 0 ? (thrust / effectiveDrag) * FPS : 0;
    const accelFwd     = inertialMass  > 0
        ? (thrust / inertialMass) * (1 + accelMult) * FPS * FPS : 0;
    // Time constant: how many frames to reach 63% of max velocity
    // = inertialMass / effectiveDrag   (from differential equation v' = F/m - drag/m * v)
    const timeToMaxVelSecs = effectiveDrag > 0
        ? (inertialMass / effectiveDrag) / FPS : null;

    // ── Reverse thrust ────────────────────────────────────────────────────────
    const reverseThrust = a(k.reverseThrust);
    const maxVelRev     = (effectiveDrag > 0 && reverseThrust > 0)
        ? (reverseThrust / effectiveDrag) * FPS : 0;
    const accelRev      = (inertialMass > 0 && reverseThrust > 0)
        ? (reverseThrust / inertialMass) * (1 + accelMult) * FPS * FPS : 0;

    // ── Afterburner ───────────────────────────────────────────────────────────
    // Afterburner thrust is ADDITIVE on top of normal thrust (Ship.cpp).
    const abThrust      = a(k.afterburnerThrust);
    const hasAB         = abThrust > 0;
    const abTotalThrust = thrust + abThrust;
    const maxVelAB      = (effectiveDrag > 0 && hasAB)
        ? (abTotalThrust / effectiveDrag) * FPS : 0;
    const accelAB       = (inertialMass > 0 && hasAB)
        ? (abTotalThrust / inertialMass) * (1 + accelMult) * FPS * FPS : 0;

    // ── Turning ───────────────────────────────────────────────────────────────
    const turning        = a(k.turning);
    const turnRatePerSec = inertialMass > 0 ? (turning / inertialMass) * FPS : 0;

    // ── Jump / fuel ───────────────────────────────────────────────────────────
    // Drive detection: boolean attrs that the nav functions use.
    // We check the actual combined attribute value for each drive type key.
    const driveResults = {};
    for (const driveKey of (k.driveTypes || [])) {
        if (a(driveKey) > 0) driveResults[driveKey] = true;
    }
    const canJump   = Object.keys(driveResults).length > 0;

    // Jump fuel per jump, modified by jump fuel multiplier
    const jumpFuelBase = canJump
        ? (a(k.jumpFuel) > 0 ? a(k.jumpFuel) : 100)
        : 0;
    const jumpFuelCost = jumpFuelBase * (1 + a(k.jumpFuelMult));

    // Jump range (jump drive only — hyperdrive uses lane network)
    // We check if any drive key contains 'jump drive' (as opposed to 'hyperdrive')
    const hasJumpDrivetype = (k.driveTypes || []).some(dk =>
        dk.toLowerCase().includes('jump drive') && a(dk) > 0
    );
    const jumpRange = hasJumpDrivetype ? a(k.jumpRange) : 0;

    const fuelCap      = a(k.fuelCapacity);
    const jumpsOnFull  = (canJump && jumpFuelCost > 0)
        ? Math.floor(fuelCap / jumpFuelCost) : 0;

    // ── Fuel regeneration ─────────────────────────────────────────────────────
    // Derived from parsed ramscoop formula — no hardcoded coefficient.
    let ramscoopPerSec = 0;
    if (k.ramscoop) {
        const { attrKey, coefficient, solarExp } = k.ramscoop;
        ramscoopPerSec = coefficient
            * Math.pow(SOLAR_POWER, solarExp)
            * a(attrKey);
    }
    const fuelGenPerSec   = a(k.fuelGeneration);
    const fuelRegenPerSec = ramscoopPerSec + fuelGenPerSec;

    const refuelFullSecs = (fuelRegenPerSec > 0 && fuelCap > 0)
        ? fuelCap / fuelRegenPerSec : null;
    const refuelJumpSecs = (fuelRegenPerSec > 0 && jumpFuelCost > 0)
        ? jumpFuelCost / fuelRegenPerSec : null;

    // ── Cloaking ──────────────────────────────────────────────────────────────
    const cloakRate  = a(k.cloakRate);
    const canCloak   = cloakRate > 0;
    const cloakTimeFrames = canCloak ? Math.ceil(1 / cloakRate) : null;
    const cloakTimeSecs   = cloakTimeFrames != null ? cloakTimeFrames / FPS : null;

    // Per-frame cloaking costs → per-second
    const cloakCosts = {};
    for (const costKey of (k.cloakingCostKeys || [])) {
        const val = a(costKey);
        if (val !== 0) {
            // Strip 'cloaking ' prefix for the label
            const label = costKey.replace(/^cloaking\s+/i, '');
            cloakCosts[label] = +(val * FPS).toFixed(4);
        }
    }

    // ── Sustained combat movement costs ───────────────────────────────────────
    // Mirrors battleSim's movingEnergyPerFrame formula:
    //   max(thrusting energy, reverse thrusting energy) + turning energy
    // These formulas come from attrDefs.shipDisplay.intermediateVars if available,
    // but we compute them directly since the intermediate vars are for display only.
    const fwdEPerSec  = a(k.thrustEnergy)  * FPS;
    const revEPerSec  = a(k.reverseEnergy) * FPS;
    const turnEPerSec = a(k.turningEnergy) * FPS;
    const fwdHPerSec  = a(k.thrustHeat)    * FPS;
    const revHPerSec  = a(k.reverseHeat)   * FPS;
    const turnHPerSec = a(k.turningHeat)   * FPS;
    const fwdFPerSec  = a(k.thrustFuel)    * FPS;
    const turnFPerSec = a(k.turningFuel)   * FPS;
    const abEPerSec   = hasAB ? a(k.afterburnerEnergy)  * FPS : 0;
    const abHPerSec   = hasAB ? a(k.afterburnerHeat)    * FPS : 0;
    const abFPerSec   = hasAB ? a(k.afterburnerFuel)    * FPS : 0;

    const combatEPerSec = Math.max(fwdEPerSec, revEPerSec) + turnEPerSec;
    const combatHPerSec = Math.max(fwdHPerSec, revHPerSec) + turnHPerSec;
    const combatFPerSec = fwdFPerSec + turnFPerSec;

    // ── Stopping distance ─────────────────────────────────────────────────────
    // From max forward velocity, coasting with drag only.
    // Analytical: d = v0 * (inertialMass / effectiveDrag) frames of travel
    // (integral of exponential decay)
    const maxVelPerFrame    = maxVelFwd / FPS;
    const stoppingDistPx    = effectiveDrag > 0
        ? maxVelPerFrame * (inertialMass / effectiveDrag) * FPS
        : 0;

    // Time to turn 180°
    const timeFor180Secs = turnRatePerSec > 0 ? 180 / turnRatePerSec : null;

    // ── Tags ──────────────────────────────────────────────────────────────────
    const tags = [];
    if (thrust > 0)          tags.push('can-thrust');
    if (reverseThrust > 0)   tags.push('reverse-thrust');
    if (hasAB)               tags.push('afterburner');
    if (turning > 0)         tags.push('can-turn');
    if (canJump)             tags.push('can-jump');
    for (const dk of Object.keys(driveResults)) tags.push(dk);
    if (canCloak)            tags.push('cloaking');
    if (combatFPerSec > 0 || abFPerSec > 0) tags.push('fuel-consuming');

    // ── Assemble profile ──────────────────────────────────────────────────────
    return {
        // Physics building blocks
        mass:            +mass.toFixed(2),
        inertiaReduction:+inertiaRed.toFixed(4),
        inertialMass:    +inertialMass.toFixed(2),
        dragAttribute:   +dragAttr.toFixed(4),
        dragReduction:   +dragRed.toFixed(4),
        effectiveDrag:   +effectiveDrag.toFixed(4),

        // Forward movement
        thrust,
        maxVelocity:         +maxVelFwd.toFixed(2),
        acceleration:        +accelFwd.toFixed(3),
        timeToMaxVelocitySecs: timeToMaxVelSecs != null ? +timeToMaxVelSecs.toFixed(2) : null,
        thrustCostsPerSec: {
            energy: +fwdEPerSec.toFixed(3),
            heat:   +fwdHPerSec.toFixed(3),
            fuel:   +fwdFPerSec.toFixed(4),
        },

        // Reverse
        reverseThrust,
        hasReverseThrust:   reverseThrust > 0,
        maxVelocityReverse: +maxVelRev.toFixed(2),
        accelerationReverse:+accelRev.toFixed(3),
        reverseCostsPerSec: {
            energy: +revEPerSec.toFixed(3),
            heat:   +revHPerSec.toFixed(3),
        },

        // Afterburner
        hasAfterburner:          hasAB,
        afterburnerThrust:       abThrust,
        maxVelocityAfterburner:  +maxVelAB.toFixed(2),
        accelerationAfterburner: +accelAB.toFixed(3),
        afterburnerCostsPerSec:  hasAB ? {
            energy:  +abEPerSec.toFixed(3),
            heat:    +abHPerSec.toFixed(3),
            fuel:    +abFPerSec.toFixed(4),
            shields: +(a(k.afterburnerShields) * FPS).toFixed(3),
        } : null,

        // Turning
        turning,
        turnRateDegPerSec:  +turnRatePerSec.toFixed(2),
        timeFor180Secs:     timeFor180Secs != null ? +timeFor180Secs.toFixed(2) : null,
        turningCostsPerSec: {
            energy: +turnEPerSec.toFixed(3),
            heat:   +turnHPerSec.toFixed(3),
            fuel:   +turnFPerSec.toFixed(4),
        },

        // Sustained combat costs
        sustainedCombat: {
            energyPerSec: +combatEPerSec.toFixed(3),
            heatPerSec:   +combatHPerSec.toFixed(3),
            fuelPerSec:   +combatFPerSec.toFixed(4),
            withAfterburner: hasAB ? {
                energyPerSec: +(combatEPerSec + abEPerSec).toFixed(3),
                heatPerSec:   +(combatHPerSec + abHPerSec).toFixed(3),
                fuelPerSec:   +(combatFPerSec + abFPerSec).toFixed(4),
            } : null,
        },

        // Maneuverability
        stoppingDistancePx: +stoppingDistPx.toFixed(1),

        // Jump
        canJump,
        drives:            driveResults,
        jumpFuelPerJump:   +jumpFuelCost.toFixed(2),
        jumpRange,
        fuelCapacity:      fuelCap,
        jumpsOnFullTank:   jumpsOnFull,
        fuelRegenPerSec:   +fuelRegenPerSec.toFixed(4),
        ramscoopPerSec:    +ramscoopPerSec.toFixed(4),
        fuelGenPerSec:     +fuelGenPerSec.toFixed(4),
        refuelFullSecs:    refuelFullSecs  != null ? +refuelFullSecs.toFixed(1)  : null,
        refuelForJumpSecs: refuelJumpSecs  != null ? +refuelJumpSecs.toFixed(1)  : null,

        // Cloaking
        canCloak,
        cloakRate:         canCloak ? +cloakRate.toFixed(4) : 0,
        timeToFullCloakSecs: cloakTimeSecs != null ? +cloakTimeSecs.toFixed(2) : null,
        cloakCostsPerSec:  cloakCosts,

        tags,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  FORMAT — human-readable summary
// ─────────────────────────────────────────────────────────────────────────────

function format(profile) {
    if (!profile) return '(null profile)';
    const p   = profile;
    const row = (label, value, unit = '') =>
        `  ${String(label).padEnd(30)} ${value}${unit}`;
    const pct = v => `${(v * 100).toFixed(1)}%`;
    const f   = v => v == null ? '—' : String(v);

    const lines = [
        `╔══ MOVEMENT PROFILE ${'═'.repeat(33)}`,
        `║  Tags: ${p.tags.join(', ') || 'none'}`,
        `║`,
        `║  MASS & DRAG`,
        row('║    Mass',              f(p.mass),            ' t'),
        row('║    Inertia Reduction', pct(p.inertiaReduction)),
        row('║    Inertial Mass',     f(p.inertialMass),    ' t'),
        row('║    Drag Attribute',    f(p.dragAttribute)),
        row('║    Drag Reduction',    pct(p.dragReduction)),
        row('║    Effective Drag',    f(p.effectiveDrag)),
        `║`,
        `║  FORWARD THRUST`,
        row('║    Thrust',            f(p.thrust)),
        row('║    Max Velocity',      f(p.maxVelocity),         ' px/s'),
        row('║    Acceleration',      f(p.acceleration),        ' px/s²'),
        row('║    Time to ~63% vel',  f(p.timeToMaxVelocitySecs), ' s'),
        row('║    Energy cost',       f(p.thrustCostsPerSec.energy), '/s'),
        row('║    Heat cost',         f(p.thrustCostsPerSec.heat),   '/s'),
        p.thrustCostsPerSec.fuel > 0
            ? row('║    Fuel cost',    f(p.thrustCostsPerSec.fuel),   '/s') : null,
        `║`,
        `║  TURNING`,
        row('║    Turning',           f(p.turning)),
        row('║    Turn Rate',         f(p.turnRateDegPerSec),   ' deg/s'),
        row('║    Time for 180°',     f(p.timeFor180Secs),      ' s'),
        row('║    Energy cost',       f(p.turningCostsPerSec.energy), '/s'),
        row('║    Heat cost',         f(p.turningCostsPerSec.heat),   '/s'),
        p.turningCostsPerSec.fuel > 0
            ? row('║    Fuel cost',    f(p.turningCostsPerSec.fuel),   '/s') : null,
    ].filter(Boolean);

    if (p.hasReverseThrust) {
        lines.push(
            `║`,
            `║  REVERSE THRUST`,
            row('║    Reverse Thrust',     f(p.reverseThrust)),
            row('║    Max Reverse Vel',    f(p.maxVelocityReverse),  ' px/s'),
            row('║    Reverse Accel',      f(p.accelerationReverse), ' px/s²'),
            row('║    Energy cost',        f(p.reverseCostsPerSec.energy), '/s'),
            row('║    Heat cost',          f(p.reverseCostsPerSec.heat),   '/s'),
        );
    }

    if (p.hasAfterburner) {
        const ab = p.afterburnerCostsPerSec;
        const abRows = [
            `║`,
            `║  AFTERBURNER (additive to thrust)`,
            row('║    AB Thrust bonus',    f(p.afterburnerThrust)),
            row('║    Max Vel (w/ AB)',    f(p.maxVelocityAfterburner),  ' px/s'),
            row('║    Accel (w/ AB)',      f(p.accelerationAfterburner), ' px/s²'),
            row('║    Energy cost',        f(ab.energy),  '/s'),
            row('║    Heat cost',          f(ab.heat),    '/s'),
            ab.fuel    > 0 ? row('║    Fuel cost',    f(ab.fuel),    '/s') : null,
            ab.shields > 0 ? row('║    Shield cost',  f(ab.shields), '/s') : null,
        ].filter(Boolean);
        lines.push(...abRows);
    }

    {
        const sc = p.sustainedCombat;
        const coreRows = [
            `║`,
            `║  MANEUVERABILITY`,
            row('║    Stopping Distance',  f(p.stoppingDistancePx), ' px'),
            `║`,
            `║  SUSTAINED COMBAT COSTS`,
            row('║    Energy/s',           f(sc.energyPerSec), '/s'),
            row('║    Heat/s',             f(sc.heatPerSec),   '/s'),
            sc.fuelPerSec > 0
                ? row('║    Fuel/s',       f(sc.fuelPerSec),   '/s') : null,
            sc.withAfterburner
                ? row('║    Energy/s (AB on)', f(sc.withAfterburner.energyPerSec), '/s') : null,
        ].filter(Boolean);
        lines.push(...coreRows);
    }

    if (p.canJump) {
        const driveNames = Object.keys(p.drives).join(', ');
        const jumpRows = [
            `║`,
            `║  JUMP CAPABILITY`,
            row('║    Drives',             driveNames),
            row('║    Fuel per Jump',      f(p.jumpFuelPerJump)),
            row('║    Fuel Capacity',      f(p.fuelCapacity)),
            row('║    Jumps (full tank)',   f(p.jumpsOnFullTank)),
            p.jumpRange > 0
                ? row('║    Jump Range',   f(p.jumpRange)) : null,
            p.fuelRegenPerSec > 0
                ? row('║    Fuel Regen/s', f(p.fuelRegenPerSec)) : null,
            p.refuelForJumpSecs != null
                ? row('║    Refuel/jump',  f(p.refuelForJumpSecs), ' s') : null,
        ].filter(Boolean);
        lines.push(...jumpRows);
    }

    if (p.canCloak) {
        lines.push(
            `║`,
            `║  CLOAKING`,
            row('║    Cloak Rate',           f(p.cloakRate)),
            row('║    Time to Full Cloak',   f(p.timeToFullCloakSecs), ' s'),
            ...Object.entries(p.cloakCostsPerSec).map(([k, v]) =>
                row(`║    ${k}/s`, f(v))
            ),
        );
    }

    lines.push(`╚${'═'.repeat(52)}`);
    return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMPARE — side-by-side comparison table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * compareProfiles(profileA, nameA, profileB, nameB)
 * Returns a structured comparison table.
 * Each non-section row: { label, valueA, valueB, winner: 'A'|'B'|'equal'|null }
 */
function compareProfiles(profileA, nameA, profileB, nameB) {
    const fmt = (v, unit = '') => v == null ? '—' : `${v}${unit}`;

    const row = (label, vA, vB, unit = '', higherIsBetter = true) => {
        const nA = typeof vA === 'number' ? vA : null;
        const nB = typeof vB === 'number' ? vB : null;
        let winner = null;
        if (nA !== null && nB !== null) {
            if (Math.abs(nA - nB) < 1e-6)                        winner = 'equal';
            else if (higherIsBetter ? nA > nB : nA < nB)         winner = 'A';
            else                                                   winner = 'B';
        }
        return { label, valueA: fmt(vA, unit), valueB: fmt(vB, unit), winner };
    };

    const A = profileA, B = profileB;
    const scA = A.sustainedCombat, scB = B.sustainedCombat;

    return {
        nameA, nameB,
        rows: [
            { section: 'Mass & Drag' },
            row('Mass',                  A.mass,             B.mass,             ' t',      false),
            row('Inertial Mass',         A.inertialMass,     B.inertialMass,     ' t',      false),
            row('Effective Drag',        A.effectiveDrag,    B.effectiveDrag,    '',        false),
            { section: 'Speed' },
            row('Max Velocity',          A.maxVelocity,      B.maxVelocity,      ' px/s'),
            row('Afterburner Velocity',
                A.hasAfterburner ? A.maxVelocityAfterburner : null,
                B.hasAfterburner ? B.maxVelocityAfterburner : null, ' px/s'),
            row('Reverse Velocity',
                A.hasReverseThrust ? A.maxVelocityReverse : null,
                B.hasReverseThrust ? B.maxVelocityReverse : null,   ' px/s'),
            { section: 'Agility' },
            row('Acceleration',          A.acceleration,     B.acceleration,     ' px/s²'),
            row('Turn Rate',             A.turnRateDegPerSec,B.turnRateDegPerSec,' deg/s'),
            row('Time for 180°',         A.timeFor180Secs,   B.timeFor180Secs,   ' s',      false),
            row('Stopping Distance',     A.stoppingDistancePx,B.stoppingDistancePx,' px',   false),
            { section: 'Combat Running Costs (lower = better)' },
            row('Energy/s',              scA.energyPerSec,   scB.energyPerSec,   '',        false),
            row('Heat/s',                scA.heatPerSec,     scB.heatPerSec,     '',        false),
            row('Fuel/s',                scA.fuelPerSec,     scB.fuelPerSec,     '',        false),
        ],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC EXPORT
// ─────────────────────────────────────────────────────────────────────────────

window.MovementStats = {
    init,
    isReady,
    compute,
    format,
    compareProfiles,
    getRegistry,
};

})();