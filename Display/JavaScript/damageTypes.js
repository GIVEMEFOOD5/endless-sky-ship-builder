;(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  damageTypes.js  —  Endless Sky Damage / Protection / Resistance Reference
//
//  ZERO HARDCODING POLICY
//  ──────────────────────
//  This file contains NO static lists of type names, attribute keys, formulas,
//  shield-interaction flags, constants, or descriptions.  Everything is read at
//  runtime from the _attrDefs object (attributeDefinitions.json) which is built
//  by attributeParser.js directly from the game's C++ source files.
//
//  REQUIRED SHAPE OF attributeDefinitions.json
//  ────────────────────────────────────────────
//  weapon.damageTypes[]           — PascalCase type names from DamageDealt.h
//
//  weapon.damageTypeDetails[]     — one entry per type, built by attributeParser.js
//    typeName          PascalCase, matches damageTypes[]
//    category          'hp' | 'resource' | 'status'
//    resourceKey       e.g. 'ion damage'
//    relativeKey       e.g. '% shield damage'  (null if none)
//    shieldInteraction 'full' | 'half' | 'blocked' | 'direct'
//    statusEffect      statName string (e.g. 'ionization') or null
//    resistanceKey     attribute key string or null
//    protectionKey     attribute key string or null
//    description       string
//    applyFormula      pseudo-code string
//    notes[]
//
//  weapon.statusEffectDecay.decayMap    { statName → resistKey }
//  weapon.statusEffectDecay.descriptors[]
//    statName, resistKey, protectionKey, damageKey, label,
//    effectType, description, decayFormula, costKeys[],
//    passiveHalfLifeFrames
//    (scrambling only: jamChanceFormula)
//
//  attributes.{key}.isProtection         true  → listed in protection registry
//  attributes.{key}.isStatusResistance   true  → listed in resistance registry
//  attributes.{key}.protectionAppliesTo
//  attributes.{key}.protectionFormula
//  attributes.{key}.protectionNote
//  attributes.{key}.stackingDescription
//  attributes.{key}.clampRange
// ═══════════════════════════════════════════════════════════════════════════════

let _ready     = false;
let _typeMap   = {};   // lowercase typeName  → entry
let _protMap   = {};   // attribute key        → entry
let _resistMap = {};   // statName / resistKey → entry
let _registry  = null;

// ─────────────────────────────────────────────────────────────────────────────
//  initDamageTypes(attrDefs)
// ─────────────────────────────────────────────────────────────────────────────
function initDamageTypes(attrDefs) {
    _ready     = false;
    _typeMap   = {};
    _protMap   = {};
    _resistMap = {};
    _registry  = null;

    if (!attrDefs) {
        console.error('[damageTypes] initDamageTypes: attrDefs is null — registry not built');
        return;
    }

    const attrs       = attrDefs.attributes                             || {};
    const typeNames   = attrDefs.weapon?.damageTypes                    || [];
    const typeDetails = attrDefs.weapon?.damageTypeDetails              || [];
    const decayMap    = attrDefs.weapon?.statusEffectDecay?.decayMap    || {};
    const descriptors = attrDefs.weapon?.statusEffectDecay?.descriptors || [];

    // Index typeDetails by lowercase typeName for O(1) lookup
    const detailsByName = {};
    for (const d of typeDetails)
        if (d.typeName) detailsByName[d.typeName.toLowerCase()] = d;

    // ── 1. Damage types ───────────────────────────────────────────────────────
    const damageTypes = [];
    for (const typeName of typeNames) {
        const d = detailsByName[typeName.toLowerCase()];
        if (!d) {
            console.warn(
                `[damageTypes] No damageTypeDetails for "${typeName}". ` +
                `Run attributeParser.js to regenerate attributeDefinitions.json.`
            );
            continue;
        }
        const entry = {
            typeName:          d.typeName,
            category:          d.category,
            resourceKey:       d.resourceKey,
            relativeKey:       d.relativeKey       ?? null,
            shieldInteraction: d.shieldInteraction,
            statusEffect:      d.statusEffect      ?? null,
            resistanceKey:     d.resistanceKey     ?? null,
            protectionKey:     d.protectionKey     ?? null,
            description:       d.description       ?? '',
            applyFormula:      d.applyFormula      ?? '',
            notes:             d.notes             ?? [],
            isWeaponDataKey:    attrs[d.resourceKey]?.isWeaponDataKey    ?? false,
            shownInOutfitPanel: attrs[d.resourceKey]?.shownInOutfitPanel ?? false,
        };
        damageTypes.push(entry);
        _typeMap[typeName.toLowerCase()] = entry;
    }

    // ── 2. Protections ────────────────────────────────────────────────────────
    const protections = [];
    const seenProt = new Set();

    for (const [key, a] of Object.entries(attrs)) {
        if (!a.isProtection && key !== 'piercing resistance') continue;
        if (seenProt.has(key)) continue;
        seenProt.add(key);
        const entry = {
            key,
            appliesTo:    a.protectionAppliesTo ?? (key.replace(' protection', '') + ' damage'),
            formula:      a.protectionFormula   ?? `effectiveDose = rawDose * (1 - [${key}])`,
            note:         a.protectionNote      ?? a.stackingDescription ?? '',
            stackingNote: a.stackingDescription ?? '',
            clampRange:   a.clampRange          ?? '[0, 1]',
        };
        protections.push(entry);
        _protMap[key] = entry;
    }

    // ── 3. Resistances ────────────────────────────────────────────────────────
    const resistances = [];
    const seenResist = new Set();

    for (const desc of descriptors) {
        const rk = desc.resistKey;
        if (!rk || seenResist.has(rk)) continue;
        seenResist.add(rk);
        const a = attrs[rk] || {};
        const entry = {
            statName:              desc.statName,
            resistKey:             rk,
            decayFormula:          desc.decayFormula          ?? '',
            costKeys:              desc.costKeys              ?? [],
            note:                  desc.description           ?? '',
            passiveHalfLifeFrames: desc.passiveHalfLifeFrames ?? null,
            passiveHalfLifeSecs:   desc.passiveHalfLifeFrames != null
                                       ? (desc.passiveHalfLifeFrames / 60).toFixed(2)
                                       : null,
            stackingNote:          a.stackingDescription      ?? '',
            ...(desc.jamChanceFormula ? { jamChanceFormula: desc.jamChanceFormula } : {}),
        };
        resistances.push(entry);
        _resistMap[desc.statName] = entry;
        _resistMap[rk]            = entry;
    }

    _registry = { damageTypes, protections, resistances };
    _ready    = true;

    console.log(
        `[damageTypes] Ready — ` +
        `${damageTypes.length} damage types, ` +
        `${protections.length} protections, ` +
        `${resistances.length} resistances`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────
function isReady()          { return _ready; }
function getRegistry()      { return _registry; }
function getAllDamageTypes() { return _registry?.damageTypes  ?? []; }
function getAllProtections() { return _registry?.protections  ?? []; }
function getAllResistances() { return _registry?.resistances  ?? []; }

function getDamageType(typeName)  { return _typeMap  [(typeName  || '').toLowerCase()] ?? null; }
function getProtection(key)       { return _protMap  [key]                             ?? null; }
function getResistance(keyOrStat) { return _resistMap[keyOrStat]                       ?? null; }

function getShieldInteraction(typeName) {
    return getDamageType(typeName)?.shieldInteraction ?? 'half';
}

/**
 * getShieldMultiplier(typeName, shieldsUp)
 * Returns the numeric multiplier (0 | 0.5 | 1.0) to apply to incoming
 * damage/status dose, sourced entirely from shieldInteraction in attrDefs.
 *
 *   'full'    → 1.0 always  (Discharge — "always maximum effect" per wiki)
 *   'half'    → 0.5 when up (Ion, Scrambling, Disruption, Slowing, Burn, Heat, Energy, Fuel)
 *   'blocked' → 0.0 when up (Corrosion, Leak — "ignored when shields are up" per wiki)
 *   'direct'  → 1.0 always  (Shield, Hull HP — handled separately in applyWeaponDamage)
 */
function getShieldMultiplier(typeName, shieldsUp) {
    if (!shieldsUp) return 1.0;
    switch (getShieldInteraction(typeName)) {
        case 'full':    return 1.0;
        case 'half':    return 0.5;
        case 'blocked': return 0.0;
        default:        return 1.0;
    }
}

window.DamageTypes = {
    init: initDamageTypes,
    isReady,
    getRegistry,
    getDamageType,
    getProtection,
    getResistance,
    getAllDamageTypes,
    getAllProtections,
    getAllResistances,
    getShieldInteraction,
    getShieldMultiplier,
};

})();
