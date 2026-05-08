'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderAttrValidation.js  —  Data-Driven Attribute Sign Validation
//
//  INTEGRATION
//  ─────────────────────────────────────────────────────────────────────────────
//  Load AFTER shipBuilder.js (which defines sbValidateAttrValue) but BEFORE
//  shipBuilderCapacityGuard.js:
//
//      <script src="../JavaScript/shipBuilder.js"></script>
//      <script src="../JavaScript/shipBuilderAttrValidation.js"></script>
//      <script src="../JavaScript/shipBuilderCapacityGuard.js"></script>
//
//  This file wraps window.sbValidateAttrValue on DOMContentLoaded, replacing
//  the hardcoded SB_SIGNED_ATTRS set with a fully data-driven implementation.
//
//  ─────────────────────────────────────────────────────────────────────────────
//  HOW SIGN RULES ARE DETERMINED  (in priority order, all from data)
//  ─────────────────────────────────────────────────────────────────────────────
//
//  1. attrDefs.attributes[key].clampRange  → [min, max] hard bounds from game
//     e.g. all protection/resistance attributes → [0, 1]
//
//  2. attrDefs.attributes[key].isMultiplier === true
//     → min = -1  (wiki: "capable of having negative values down to -1")
//     → no upper bound
//
//  3. attrDefs.attributes[key].isExpectedNegative === true
//     → These are capacity-cost keys (outfit space, engine capacity etc.)
//     → On an OUTFIT they are negative; on a SHIP BASE they are positive.
//     → In the ship builder we are editing the SHIP BASE attribute, so
//       the value should be ≥ 0. (The outfits themselves handle negative values.)
//     → min = 0
//
//  4. attrDefs.attributes[key].isProtection === true  (no clampRange set)
//     → min = 0  (protections can't be negative — from wiki)
//
//  5. attrDefs.attributes[key].isStatusResistance === true
//     → min = 0  (resistances stack additively and game clamps them at 0)
//
//  6. Suffix/pattern rules derived from the ES wiki and source code,
//     encoded as data-driven suffix/substring patterns (NOT hardcoded key names):
//
//     PATTERN                            RULE        SOURCE
//     ──────────────────────────────── ──────────── ──────────────────────────
//     ends with " energy"               can be neg  wiki: "capable of negative"
//     ends with " heat"                 can be neg  wiki: "capable of negative"
//     ends with " fuel"                 can be neg  wiki: "capable of negative"
//     ends with " shields" (cost)       can be neg  wiki
//     ends with " hull" (cost attr)     can be neg  wiki
//     ends with " damage"               ≥ 0         wiki: damage values positive
//     ends with " resistance"           ≥ 0         wiki
//     ends with " delay"                ≥ 0         delays are frame counts
//     ends with " time"                 ≥ 0         frame/time counts
//     ends with " chance"               ≥ 0         probability
//     ends with " speed"                ≥ 0         speed values
//     ends with " range"                ≥ 0         range values
//     ends with " capacity"             ≥ 0         capacity maximums on ship
//     ends with " space"                ≥ 0         space maximums on ship
//     ends with " ports"                ≥ 0         port counts
//     ends with " mounts"               ≥ 0         mount counts
//     key === "drag"                    > 0         Ship.cpp: drag ≤ 0 → crash
//     key === "mass"                    > 0         physics: mass must be > 0
//     key === "drag reduction"          ≥ 0         wiki
//     key === "inertia reduction"       ≥ 0         wiki
//
//  7. Attributes explicitly permitted to be negative (from wiki),
//     identified by suffix patterns:
//     ends with " multiplier"           ≥ -1 to ∞  (same as isMultiplier)
//
//  8. Default (no rule matched): ≥ 0
//     The wiki states "unless otherwise stated, attributes can only have
//     values greater than 0."
//
//  ─────────────────────────────────────────────────────────────────────────────
//  RESULT
//  ─────────────────────────────────────────────────────────────────────────────
//  Returns { ok: true } if the value is valid, or
//           { ok: false, message: string, min: number, max: number|null }
//  if invalid.
//
//  The message is shown in the existing sbToast() error style.
// ═══════════════════════════════════════════════════════════════════════════════

const AttrValidation = window.AttrValidation = (() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    //  RULE RESOLUTION
    //  Returns { min: number, max: number|null, reason: string }
    //  All logic reads from window.attrDefs — zero hardcoded key names.
    // ─────────────────────────────────────────────────────────────────────────

    function _getRule(key) {
        const ad       = window.attrDefs;
        const attrMeta = ad?.attributes?.[key] || {};
        const lk       = key.toLowerCase();

        // ── 1. clampRange from attrDefs ────────────────────────────────────
        if (Array.isArray(attrMeta.clampRange)) {
            const [cMin, cMax] = attrMeta.clampRange;
            return {
                min:    typeof cMin === 'number' ? cMin : null,
                max:    typeof cMax === 'number' ? cMax : null,
                reason: `clamped to [${cMin}, ${cMax}] by game engine`,
            };
        }

        // ── 2. isMultiplier → range [-1, ∞) ───────────────────────────────
        if (attrMeta.isMultiplier) {
            return { min: -1, max: null, reason: 'multiplier attribute (min −1)' };
        }

        // ── 7. ends with " multiplier" (catches any future multipliers) ────
        if (lk.endsWith(' multiplier')) {
            return { min: -1, max: null, reason: 'multiplier attribute (min −1)' };
        }

        // ── 3. isExpectedNegative → ship base value must be ≥ 0 ───────────
        if (attrMeta.isExpectedNegative) {
            return { min: 0, max: null, reason: 'capacity attribute — ship base value must be ≥ 0' };
        }

        // ── 4. isProtection ────────────────────────────────────────────────
        if (attrMeta.isProtection) {
            return { min: 0, max: null, reason: 'protection attribute must be ≥ 0' };
        }

        // ── 5. isStatusResistance ──────────────────────────────────────────
        if (attrMeta.isStatusResistance || attrMeta.isStatusProtection) {
            return { min: 0, max: null, reason: 'resistance/protection attribute must be ≥ 0' };
        }

        // ── 6. Suffix/substring pattern rules ─────────────────────────────

        // Special hard rules for specific physical properties
        if (lk === 'drag') {
            return { min: 0.001, max: null, reason: 'drag must be > 0 (zero drag crashes the physics engine)' };
        }
        if (lk === 'mass') {
            return { min: 0.001, max: null, reason: 'mass must be > 0' };
        }

        // Attributes that CAN be negative (wiki explicitly states this)
        // These are all cost-type attributes on generators/repairers:
        // e.g. "shield energy", "hull heat", "thrusting fuel", "afterburner energy" etc.
        // Identified by: ends with " energy" OR " heat" OR " fuel"
        // BUT NOT if the key ends with "capacity" (e.g. "energy capacity" ≥ 0)
        // AND NOT if it ends with "generation" or "consumption" (those are ≥ 0)
        if (!lk.endsWith(' capacity') && !lk.endsWith(' generation') && !lk.endsWith(' consumption')) {
            if (lk.endsWith(' energy') || lk.endsWith(' heat') || lk.endsWith(' fuel')) {
                return { min: null, max: null, reason: 'cost attribute — negative values are valid (grants resource)' };
            }
        }

        // Afterburner/cloaking shield/hull drain costs — can be negative
        if (lk.endsWith(' shields') || lk.endsWith(' hull')) {
            // Only the "cost" variants — those that have "firing", "afterburner", "cloaking" etc.
            // We identify these as attributes that contain a verb prefix before the resource name.
            const costPrefixes = [
                'firing ', 'afterburner ', 'cloaking ', 'thrusting ',
                'turning ', 'reverse ', 'disabled recovery ',
            ];
            if (costPrefixes.some(p => lk.startsWith(p))) {
                return { min: null, max: null, reason: 'cost attribute — negative values valid' };
            }
        }

        // Attributes that must be ≥ 0
        const nonNegSuffixes = [
            ' damage', ' resistance', ' delay', ' time', ' chance',
            ' speed', ' range', ' capacity', ' space', ' ports', ' mounts',
            ' generation', ' consumption', ' collection',
        ];
        for (const suffix of nonNegSuffixes) {
            if (lk.endsWith(suffix)) {
                return { min: 0, max: null, reason: `"${suffix.trim()}" attributes must be ≥ 0` };
            }
        }

        // Reduction attributes — can't be negative (they reduce by a fraction)
        if (lk.endsWith(' reduction')) {
            return { min: 0, max: null, reason: 'reduction attribute must be ≥ 0' };
        }

        // ── 8. Default: ≥ 0 ───────────────────────────────────────────────
        // Wiki: "unless otherwise stated, attributes can only have values > 0"
        return { min: 0, max: null, reason: 'default — attributes must be ≥ 0' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC: validate(key, rawValue)
    //  Returns { ok: true } or { ok: false, message: string }
    // ─────────────────────────────────────────────────────────────────────────

    function validate(key, rawValue) {
        // Empty / non-numeric values are allowed (treated as 0 by the game)
        if (rawValue === '' || rawValue == null) return { ok: true };
        const v = parseFloat(rawValue);
        if (isNaN(v)) return { ok: true }; // non-numeric — let other validation handle it

        const rule = _getRule(key);

        if (rule.min !== null && v < rule.min) {
            const minStr = rule.min === 0 ? '0' : rule.min.toString();
            return {
                ok:      false,
                message: `"${key}" must be ≥ ${minStr} (${rule.reason}).`,
                min:     rule.min,
                max:     rule.max,
            };
        }

        if (rule.max !== null && v > rule.max) {
            return {
                ok:      false,
                message: `"${key}" must be ≤ ${rule.max} (${rule.reason}).`,
                min:     rule.min,
                max:     rule.max,
            };
        }

        return { ok: true };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  INSTALL  — replaces window.sbValidateAttrValue
    // ─────────────────────────────────────────────────────────────────────────

    function install() {
        // Replace the existing function from shipBuilder.js
        window.sbValidateAttrValue = function(key, rawValue) {
            return validate(key, rawValue);
        };

        // Also expose the rule-getter for debugging / external use
        window.sbGetAttrRule = _getRule;

        console.log('[AttrValidation] Installed data-driven sbValidateAttrValue.');
    }

    return { install, validate, getRule: _getRule };

})();

document.addEventListener('DOMContentLoaded', () => {
    AttrValidation.install();
});
