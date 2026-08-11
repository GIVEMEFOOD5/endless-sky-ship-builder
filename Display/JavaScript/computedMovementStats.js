;(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  computedMovementStats.js
//
//  Single job: wrap window.MovementStats.compute() and flatten its output
//  into flat "_mv_<path>" → number keys, for computedStats.js to merge into
//  its own output. Nothing else — no labels, no display units, no row
//  building, no UI awareness. Those are display-layer concerns, handled the
//  same way ComputedStats.js already handles them for _fn_/_derived_/_sys_
//  keys (generated on the fly by whatever screen renders them).
//
//  Does NOT modify movementStats.js — read-only dependency.
//
//  Called ONLY by computedStats.js. Nothing else should call this directly.
//
//  PUBLIC API
//  ──────────
//  ComputedMovementStats.isReady() → boolean
//  ComputedMovementStats.getMovementStats(combinedAttrs) → flat Object
// ═══════════════════════════════════════════════════════════════════════════

function isReady() {
    return !!(window.MovementStats && window.MovementStats.isReady && window.MovementStats.isReady());
}

// Recursively flattens a MovementStats profile object into "_mv_a_b_c" keys.
//   - Skips booleans, strings, arrays — the computed-stats map is numeric only.
//   - Skips zero/null/undefined so attribute-less items don't produce a wall
//     of meaningless zeroes.
//   - Nested objects (thrustCostsPerSec, sustainedCombat, cloakCostsPerSec,
//     ...) flatten one path deeper, joined with "_".
function _flatten(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'boolean' || typeof v === 'string') continue;
        if (Array.isArray(v)) continue;
        const path = prefix ? `${prefix}_${k}` : k;
        if (typeof v === 'number') {
            if (v !== 0) out[`_mv_${path}`] = v;
        } else if (typeof v === 'object') {
            _flatten(v, path, out);
        }
    }
    return out;
}

function getMovementStats(combinedAttrs) {
    if (!isReady() || !combinedAttrs) return {};
    let profile;
    try { profile = window.MovementStats.compute(combinedAttrs); }
    catch (_) { return {}; }
    if (!profile) return {};
    return _flatten(profile, '', {});
}

window.ComputedMovementStats = { isReady, getMovementStats };

})();
