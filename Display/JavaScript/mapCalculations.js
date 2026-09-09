'use strict';

// ═══════════════════════════════════════════════════════════
//  mapCalculations.js  —  Endless Sky Ship Builder / Systems Map
//
//  STAGE 3 of the map pipeline: CALCULATIONS & METHODS.
//  Camera/viewport math, hit-testing, search ranking, government
//  colour assignment, link-segment building, and level-of-detail
//  decisions. Everything here is a pure function or plain-data
//  camera object — nothing in this file touches the DOM or a
//  canvas context. mapDisplay.js is the only file allowed to draw.
//
//  Public API on window.MapCalculations:
//    .createCamera()
//    .fitToSystems(systems, viewportW, viewportH, opts?)
//    .worldToScreen(cam, x, y, viewportW, viewportH)
//    .screenToWorld(cam, sx, sy, viewportW, viewportH)
//    .zoomAt(cam, factor, sx, sy, viewportW, viewportH)
//    .findNearest(systems, worldX, worldY, maxWorldDist)
//    .visibleSystems(systems, cam, viewportW, viewportH, margin?)
//    .buildLinkSegments(systemsByName)
//    .buildGovernmentPalette(systems)
//    .search(systemsArr, query, limit?)
//    .lod(cam)
//    .clampScale(scale)
//    .evaluateMissionFilter(filterEntries, system)   → boolean
//    .buildMissionIndex(missions, systemsArr)        → MissionIndex
//    .buildStarTable(formattedStars)                 → Map<sprite, StarAttributes>
//    .computeSolarAttributes(system, starTable)      → {power, wind, stars}
// ═══════════════════════════════════════════════════════════

(function () {

const MIN_SCALE = 0.03;
const MAX_SCALE = 24;

const PALETTE = [
    '#5ee1c9', '#e2b93b', '#e2607a', '#7f9ce8', '#a06be0', '#e08a4d',
    '#4dc0e0', '#c9e04d', '#e04d4d', '#6be0a0', '#e04dc4', '#8fa3c2',
    '#d1d1d1', '#4de08f', '#e0a54d', '#6d8ce0', '#e04d8f', '#4de0d1',
    '#c47fe0', '#e0d14d', '#4d7fe0', '#e07f4d', '#7fe04d', '#e04d67',
];
const UNINHABITED_COLOR = '#4a5670';

// ── Star attribute table (baseline) ─────────────────────────
//
// Every star sprite's Power and Wind values, straight from the real
// endless-sky/endless-sky repo's data/stars.txt (fetched and
// transcribed directly from source — not estimated). A system's
// total Solar Power / Solar Wind is the SUM of every star object it
// contains (confirmed on the project's own MapData wiki page: "If a
// system has multiple stars, then the values of each star are added
// together"). Power affects both solar-collection AND solar-heat ship
// outfits; Wind affects ramscoop fuel regen — see computeSolarAttributes().
//
// This is a FALLBACK. Since the parser fix accompanying this feature,
// every plugin now emits its own dataFiles/stars.json with the exact
// same shape (see mapDataFormatter.formatStars()) — including vanilla's
// own numbers, and anything a mod adds or overrides. buildStarTable()
// merges fetched data over this baseline, so a mod's custom "star/xyz"
// sprite works correctly even before this table is ever touched, and
// vanilla numbers stay correct even if a plugin run hasn't happened yet.
const BASELINE_STAR_TABLE = {
    "star/o0": { power: 4.2, wind: 0.46, icon: "map/o-large-star", habitable: 13720, mass: 85750 },
    "star/o3": { power: 3.9, wind: 0.46, icon: "map/o-large-star", habitable: 11500, mass: 71875 },
    "star/o5": { power: 3.6, wind: 0.47, icon: "map/o-large-star", habitable: 10000, mass: 62500 },
    "star/o8": { power: 3.3, wind: 0.48, icon: "map/o-large-star", habitable: 8650, mass: 54062.5 },
    "star/b0": { power: 3.1, wind: 0.49, icon: "map/b-large-star", habitable: 7000, mass: 43750 },
    "star/b3": { power: 2.8, wind: 0.5, icon: "map/b-large-star", habitable: 6300, mass: 39375 },
    "star/b5": { power: 2.5, wind: 0.51, icon: "map/b-large-star", habitable: 5600, mass: 35000 },
    "star/b8": { power: 2.2, wind: 0.52, icon: "map/b-large-star", habitable: 5000, mass: 31250 },
    "star/a0": { power: 2, wind: 0.53, icon: "map/a-star", habitable: 3650, mass: 22812.5 },
    "star/a3": { power: 1.85, wind: 0.54, icon: "map/a-star", habitable: 3400, mass: 21250 },
    "star/a5": { power: 1.7, wind: 0.55, icon: "map/a-star", habitable: 3200, mass: 20000 },
    "star/a8": { power: 1.5, wind: 0.56, icon: "map/a-star", habitable: 3000, mass: 18750 },
    "star/f0": { power: 1.4, wind: 0.57, icon: "map/f-star", habitable: 2560, mass: 16000 },
    "star/f3": { power: 1.3, wind: 0.59, icon: "map/f-star", habitable: 2200, mass: 13750 },
    "star/f5": { power: 1.2, wind: 0.6, icon: "map/f-star", habitable: 1715, mass: 10718.75 },
    "star/f8": { power: 1.1, wind: 0.62, icon: "map/f-star", habitable: 1310, mass: 8187.5 },
    "star/g0": { power: 1, wind: 0.64, icon: "map/g-star", habitable: 1080, mass: 6750 },
    "star/g3": { power: 0.95, wind: 0.66, icon: "map/g-star", habitable: 700, mass: 4375 },
    "star/g5": { power: 0.9, wind: 0.69, icon: "map/g-star", habitable: 625, mass: 3906.25 },
    "star/g8": { power: 0.85, wind: 0.72, icon: "map/g-star", habitable: 550, mass: 3437.5 },
    "star/k0": { power: 0.8, wind: 0.75, icon: "map/k-small-star", habitable: 490, mass: 3062.5 },
    "star/k3": { power: 0.76, wind: 0.78, icon: "map/k-small-star", habitable: 450, mass: 2812.5 },
    "star/k5": { power: 0.72, wind: 0.82, icon: "map/k-small-star", habitable: 425, mass: 2656.25 },
    "star/k8": { power: 0.7, wind: 0.86, icon: "map/k-small-star", habitable: 370, mass: 2312.5 },
    "star/m0": { power: 0.66, wind: 0.9, icon: "map/m-dwarf-star", habitable: 320, mass: 2000 },
    "star/m3": { power: 0.64, wind: 0.95, icon: "map/m-dwarf-star", habitable: 230, mass: 1437.5 },
    "star/m5": { power: 0.61, wind: 1.05, icon: "map/m-dwarf-star", habitable: 160, mass: 1000 },
    "star/m8": { power: 0.6, wind: 1.1, icon: "map/m-dwarf-star", habitable: 135, mass: 843.75 },
    "star/f5-old": { power: 0.8, wind: 0.9, icon: "map/f-old-star", habitable: 3430, mass: 10718.75 },
    "star/g0-old": { power: 0.7, wind: 1.0, icon: "map/g-old-star", habitable: 2160, mass: 6750 },
    "star/g5-old": { power: 0.65, wind: 1.1, icon: "map/g-old-star", habitable: 1250, mass: 3906.25 },
    "star/k0-old": { power: 0.62, wind: 1.3, icon: "map/k-old-star", habitable: 980, mass: 3062.5 },
    "star/k5-old": { power: 0.6, wind: 1.5, icon: "map/k-old-star", habitable: 950, mass: 2656.25 },
    "star/o-giant": { power: 4.8, wind: 1.5, icon: "map/o-giant-star", habitable: 22300, mass: 139375 },
    "star/b-giant": { power: 3.7, wind: 1.6, icon: "map/b-giant-star", habitable: 11350, mass: 70937.5 },
    "star/a-giant": { power: 2.6, wind: 1.7, icon: "map/a-giant-star", habitable: 7900, mass: 49375 },
    "star/f-giant": { power: 2.0, wind: 1.8, icon: "map/f-giant-star", habitable: 5600, mass: 35000 },
    "star/g-giant": { power: 1.6, wind: 1.9, icon: "map/g-giant-star", habitable: 4050, mass: 25312.5 },
    "star/k-giant": { power: 1.4, wind: 2, icon: "map/k-giant-star", habitable: 3000, mass: 18750 },
    "star/m-giant": { power: 1.2, wind: 2.1, icon: "map/m-giant-star", habitable: 2300, mass: 14375 },
    "star/o-supergiant": { power: 5.2, wind: 2.5, icon: "map/o-supergiant-star", habitable: 33450, mass: 209062.5 },
    "star/b-supergiant": { power: 4.1, wind: 2.6, icon: "map/b-supergiant-star", habitable: 17025, mass: 106406.25 },
    "star/a-supergiant": { power: 3, wind: 2.7, icon: "map/a-supergiant-star", habitable: 11850, mass: 74062.5 },
    "star/f-supergiant": { power: 2.4, wind: 2.8, icon: "map/f-supergiant-star", habitable: 8400, mass: 52500 },
    "star/g-supergiant": { power: 2, wind: 2.9, icon: "map/g-supergiant-star", habitable: 6075, mass: 37968.75 },
    "star/k-supergiant": { power: 1.8, wind: 3, icon: "map/k-supergiant-star", habitable: 4500, mass: 28125 },
    "star/m-supergiant": { power: 1.6, wind: 3.1, icon: "map/m-supergiant-star", habitable: 3450, mass: 21562.5 },
    "star/a-eater": { power: 1.84, wind: 0.45, icon: "map/a-star", habitable: 3000, mass: 18750 },
    "star/carbon": { power: 0.1, wind: 10, icon: "map/carbon-star", habitable: 3000, mass: 18750 },
    "star/nova": { power: 0.2, wind: 8, icon: "map/nova-star", habitable: 10, mass: 31250 },
    "star/nova-old": { power: 0.3, wind: 6, icon: "map/nova-old-star", habitable: 10, mass: 31250 },
    "star/nova-small": { power: 0.2, wind: 4, icon: "map/nova-small-star", habitable: 10, mass: 25000 },
    "star/wr": { power: 5, wind: 4, icon: "map/wr-star", habitable: 50000, mass: 31250 },
    "star/protostar-orange": { power: 0.5, wind: 3, icon: "map/k-small-star", habitable: 550, mass: 3437.5 },
    "star/protostar-yellow": { power: 0.4, wind: 5, icon: "map/g-small-star", habitable: 370, mass: 2312.5 },
    "star/patir": { power: 0.2, wind: 8, icon: "map/patir-star", habitable: 10, mass: 31250 },
    "star/neutron": { power: 4, wind: 0.4, icon: "map/neutron-star", habitable: 10, mass: 31250 },
    "star/neutron-small": { power: 2, wind: 0.2, icon: "map/small-neutron-star", habitable: 10, mass: 31250 },
    "star/magnetar": { power: 4, wind: 0.8, icon: "map/magnetar-star", habitable: 10, mass: 31250 },
    "star/black-hole": { power: 0, wind: 0, icon: "map/black-hole-star", habitable: 10000, mass: 62500 },
    "star/small-black-hole": { power: 0, wind: 0, icon: "map/small-black-hole-star", habitable: 10000, mass: 35000 },
    "star/coal-black-hole": { power: 0, wind: 0, icon: "map/coal-black-hole-star", habitable: 10000, mass: 62500 },
    "star/twilight-black-hole": { power: 2.4, wind: 0.3, icon: "map/twilight-black-hole-star", habitable: 10000, mass: 62500 },
    "star/big black hole": { power: null, wind: null, icon: "map/big black hole", habitable: 10000, mass: 625000 },
    "star/black hole 3": { power: null, wind: null, icon: "map/black hole 3", habitable: 10000, mass: 62500 },
    "star/black hole 4": { power: null, wind: null, icon: "map/black hole 4", habitable: 10000, mass: 62500 },
    "star/black hole 5": { power: null, wind: null, icon: "map/black hole 5", habitable: 10000, mass: 62500 },
    "star/black hole 6": { power: null, wind: null, icon: "map/black hole 6", habitable: 10000, mass: 62500 },
    "star/black hole corona": { power: null, wind: null, icon: "map/black hole corona", habitable: 10000, mass: 62500 },
    "star/black hole star": { power: null, wind: null, icon: "map/black hole star", habitable: 10000, mass: 62500 },
    "star/black-hole-still": { power: null, wind: null, icon: "map/black-hole-still", habitable: 10000, mass: 62500 },
    "star/o-dwarf": { power: 1.1, wind: 0.5, icon: "map/o-small-star", habitable: 1325, mass: 8281.25 },
    "star/b-dwarf": { power: 1, wind: 0.6, icon: "map/b-small-star", habitable: 1125, mass: 7031.25 },
    "star/a-dwarf": { power: 0.9, wind: 0.7, icon: "map/a-small-star", habitable: 750, mass: 4687.5 },
    "star/f-dwarf": { power: 0.8, wind: 0.8, icon: "map/f-small-star", habitable: 355, mass: 2218.75 },
    "star/g-dwarf": { power: 0.7, wind: 0.9, icon: "map/g-small-star", habitable: 150, mass: 937.5 },
    "star/k-dwarf": { power: 0.6, wind: 1, icon: "map/k-small-star", habitable: 100, mass: 625 },
    "star/m-dwarf": { power: 0.5, wind: 1.2, icon: "map/m-small-star", habitable: 35, mass: 218.75 },
    "star/l-dwarf": { power: 0.4, wind: 1.3, icon: "map/brown-dwarf-star", habitable: 30, mass: 187.5 },
    "planet/browndwarf-l": { power: 0.4, wind: 0.5, icon: null, habitable: 10, mass: 125 },
    "planet/browndwarf-l-rogue": { power: 0.4, wind: 0.5, icon: "map/brown-dwarf-star", habitable: 10, mass: 125 },
    "planet/browndwarf-t": { power: 0.3, wind: 0.4, icon: null, habitable: 10, mass: 125 },
    "planet/browndwarf-t-rogue": { power: 0.3, wind: 0.4, icon: "map/brown-dwarf-star", habitable: 10, mass: 125 },
    "planet/browndwarf-y": { power: 0.1, wind: 0.3, icon: null, habitable: 10, mass: 125 },
    "planet/browndwarf-y-rogue": { power: 0.1, wind: 0.3, icon: "map/brown-dwarf-star", habitable: 10, mass: 125 },
    "star/m4": { power: 0.62, wind: 1.0, icon: "map/m-small-star", habitable: null, mass: null },
    "star/giant": { power: 1.4, wind: 2, icon: "map/m-star", habitable: null, mass: null },
};


// ── Camera ───────────────────────────────────────────────────

function createCamera() {
    return { x: 0, y: 0, scale: 1 };
}

function clampScale(scale) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Centres and scales the camera to fit the bulk of the given systems.
 * Uses the 1st–98.5th percentile of coordinates rather than the true
 * min/max, so a handful of far-flung outlier systems (deep-space
 * "beyond" clusters, distant plugin additions) don't force the whole
 * galaxy down to a speck — the user can still pan out to them.
 */
function fitToSystems(systems, viewportW, viewportH, opts) {
    const cam = createCamera();
    if (!systems || systems.length === 0) return cam;

    const pad = (opts && opts.padding) ?? 0.88;
    // A handful of systems in "beyond"-style deep-space clusters can sit
    // thousands of units from the main galaxy. 2nd/96th trims those out
    // of the *default* fit reliably (verified against both the vanilla
    // 694-system set and the ~3.6k-system all-plugins set) while still
    // leaving them reachable by panning out or using search.
    const lo = (opts && opts.lowerPercentile) ?? 0.02;
    const hi = (opts && opts.upperPercentile) ?? 0.96;

    const xs = systems.map(s => s.x).sort((a, b) => a - b);
    const ys = systems.map(s => s.y).sort((a, b) => a - b);
    const pct = (arr, q) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * q)))];

    const minX = pct(xs, lo), maxX = pct(xs, hi);
    const minY = pct(ys, lo), maxY = pct(ys, hi);
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);

    cam.scale = clampScale(Math.min(viewportW / bw, viewportH / bh) * pad);
    cam.x = (minX + maxX) / 2;
    cam.y = (minY + maxY) / 2;
    return cam;
}

function worldToScreen(cam, x, y, viewportW, viewportH) {
    return {
        x: (x - cam.x) * cam.scale + viewportW / 2,
        y: (y - cam.y) * cam.scale + viewportH / 2,
    };
}

function screenToWorld(cam, sx, sy, viewportW, viewportH) {
    return {
        x: (sx - viewportW / 2) / cam.scale + cam.x,
        y: (sy - viewportH / 2) / cam.scale + cam.y,
    };
}

/** Zooms the camera by `factor`, keeping the world point under (sx,sy) fixed on screen. */
function zoomAt(cam, factor, sx, sy, viewportW, viewportH) {
    const before = screenToWorld(cam, sx, sy, viewportW, viewportH);
    const next = { ...cam, scale: clampScale(cam.scale * factor) };
    const after = screenToWorld(next, sx, sy, viewportW, viewportH);
    next.x += before.x - after.x;
    next.y += before.y - after.y;
    return next;
}

// ── Hit-testing / culling ───────────────────────────────────

function findNearest(systems, worldX, worldY, maxWorldDist) {
    let best = null;
    let bestD2 = maxWorldDist * maxWorldDist;
    for (const s of systems) {
        const dx = s.x - worldX, dy = s.y - worldY;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
}

function visibleSystems(systems, cam, viewportW, viewportH, margin) {
    const m = margin ?? 24;
    return systems.filter(s => {
        const p = worldToScreen(cam, s.x, s.y, viewportW, viewportH);
        return p.x >= -m && p.x <= viewportW + m && p.y >= -m && p.y <= viewportH + m;
    });
}

// ── Links ────────────────────────────────────────────────────

/**
 * Builds each jump-link once (A→B and B→A collapse to a single segment),
 * skipping links that point at a system not present in the current
 * (filtered/merged) set — e.g. a link into a plugin the user turned off.
 */
function buildLinkSegments(systemsByName) {
    const segments = [];
    const seen = new Set();
    for (const s of systemsByName.values()) {
        for (const linkName of s.links) {
            const target = systemsByName.get(linkName);
            if (!target) continue;
            const key = s.name < linkName ? `${s.name}\u0000${linkName}` : `${linkName}\u0000${s.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            segments.push({ a: s, b: target });
        }
    }
    return segments;
}

// ── Government colour palette ───────────────────────────────

function buildGovernmentPalette(systems) {
    const counts = {};
    for (const s of systems) counts[s.government] = (counts[s.government] || 0) + 1;
    const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const colors = {};
    let paletteIdx = 0;
    for (const g of names) {
        if (g === 'Uninhabited' || g === 'None' || g === '') {
            colors[g] = UNINHABITED_COLOR;
        } else {
            colors[g] = PALETTE[paletteIdx % PALETTE.length];
            paletteIdx++;
        }
    }
    return { names, counts, colors };
}

// ── Search ───────────────────────────────────────────────────

/**
 * Simple, cheap ranking: exact match first, then starts-with, then
 * contains. Good enough for a few thousand system names with no
 * fuzzy-matching library and no build step.
 */
function search(systemsArr, query, limit) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const s of systemsArr) {
        const n = s.name.toLowerCase();
        let score;
        if (n === q) score = 0;
        else if (n.startsWith(q)) score = 1;
        else if (n.includes(q)) score = 2;
        else continue;
        scored.push({ s, score });
    }
    scored.sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name));
    return scored.slice(0, limit ?? 20).map(x => x.s);
}

// ── Level of detail ──────────────────────────────────────────

/**
 * Central place for "how much detail at this zoom" decisions, so
 * mapDisplay.js doesn't scatter magic numbers through its draw loop.
 */
function lod(cam) {
    return {
        nodeRadius: Math.max(1.6, Math.min(5, cam.scale * 3.2)),
        linkWidth: Math.max(0.4, Math.min(1.1, cam.scale * 0.6)),
        showAllLabels: cam.scale > 0.9,
        showFocusLabels: true, // hovered/selected system always labelled
    };
}

// ── Solar attributes (Power / Wind — "ramscoop" and "heat") ─
//
// "Ramscoop" and "heat" aren't separate numbers Endless Sky tracks —
// they're both downstream of a system's total Solar Wind and Solar
// Power. This merges the baseline table with whatever a plugin's own
// stars.json contributes, then sums across every star object in a
// system to get those two totals.

/**
 * Merges fetched per-plugin star data over the hardcoded baseline —
 * fetched wins, so a mod can override a vanilla star type's numbers
 * or add an entirely new sprite. Call once per active-plugin-set
 * change, same as everything else in the pipeline, not per frame.
 */
function buildStarTable(formattedStars) {
    const table = new Map(Object.entries(BASELINE_STAR_TABLE));
    if (formattedStars) for (const [sprite, attrs] of formattedStars) table.set(sprite, attrs);
    return table;
}

/**
 * Walks a system's objectTree looking for star objects — identified
 * by "is this object's sprite a key in the star table", which is the
 * ES wiki's own classification rule in practice (a sprite only has
 * Power/Wind numbers at all if it's a star), and correctly catches
 * the handful of vanilla "stars" that are actually sprited under
 * "planet/" (brown dwarfs) rather than "star/" — a plain prefix check
 * would miss those.
 *
 * Returns null (not zeros) when no star in the system is recognised
 * by the table at all, so the display layer can say "unknown" rather
 * than a possibly-wrong "0" for a mod's custom star this table (even
 * merged with that plugin's own stars.json) still doesn't cover.
 */
function computeSolarAttributes(system, starTable) {
    const stars = [];
    const walk = (nodes) => {
        for (const obj of (nodes || [])) {
            const attrs = starTable.get(obj.sprite);
            if (attrs) stars.push({ sprite: obj.sprite, ...attrs });
            walk(obj.children);
        }
    };
    walk(system.objectTree);

    if (stars.length === 0) return { power: null, wind: null, stars: [] };

    let power = 0, wind = 0, anyPowerKnown = false, anyWindKnown = false;
    for (const s of stars) {
        if (s.power != null) { power += s.power; anyPowerKnown = true; }
        if (s.wind != null) { wind += s.wind; anyWindKnown = true; }
    }
    return {
        power: anyPowerKnown ? power : null,
        wind: anyWindKnown ? wind : null,
        stars,
    };
}


//
// A job-board mission's `source` is often a FILTER, not one fixed
// planet — e.g. "any planet in a system with the 'avgi diaspora'
// attribute" — so the game can offer a fresh, randomised job every
// time you land somewhere matching. `evaluateMissionFilter` re-checks
// that same filter against one of our systems.
//
// HONEST LIMITATION: Endless Sky's mission-location filters also
// support `near <system> <min> <max>` (jump-distance from a named
// system), `distance <min> <max>` (jump-distance from wherever the
// mission is currently being offered), and `neighbor { ... }`
// (any adjacent system matches). Jump-distance requires walking the
// whole link graph outward, and `distance` specifically depends on
// a "current system" this map has no concept of. Implementing those
// exactly risks confidently-wrong pins, so this evaluator supports
// the two unambiguous, position-independent filter keys — `attributes`
// and `government` — plus `not`, and treats `near`/`distance`/`neighbor`
// as automatically satisfied (permissive). That means filter-matched
// systems are an UPPER BOUND — every system shown genuinely could host
// the job, but a few more may be filtered out in-game by a proximity
// clause this doesn't evaluate. buildMissionIndex() additionally
// requires at least one spaceport-bearing planet before counting a
// system at all (jobs can't be offered anywhere you can't land), which
// is what keeps fully-permissive filters from lighting up every
// uninhabited system in the galaxy. mapDisplay.js labels the remaining
// approximation clearly rather than presenting it as exact.

function evaluateMissionFilter(filterEntries, system) {
    if (!Array.isArray(filterEntries) || filterEntries.length === 0) return true; // no constraints = matches anywhere
    // Sibling entries at the same level all have to hold (AND).
    return filterEntries.every(entry => _evalFilterEntry(entry, system));
}

/** Falls back to computing the union of a system's planets' attributes
 *  when it hasn't already been precomputed onto `system._planetAttributes`
 *  (buildMissionIndex precomputes it once per system for performance). */
function _planetAttributeSet(system) {
    const set = new Set();
    for (const p of (system.planets || [])) {
        for (const a of (p.attributes || [])) set.add(a);
    }
    return set;
}

function _evalFilterEntry(entry, system) {
    const { key, values, children } = entry;
    switch (key) {
        case 'attributes': {
            // One `attributes` line matches if the system OR any of its
            // planets has ANY of the listed attributes (ES tests both
            // levels) — OR within the line; separate `attributes` lines
            // AND together via the .every() in evaluateMissionFilter.
            const planetAttrs = system._planetAttributes || _planetAttributeSet(system);
            return values.some(v => system.attributes.includes(v) || planetAttrs.has(v));
        }

        case 'government':
            return values.includes(system.government);

        case 'not':
            // `not` wraps a nested filter (its own children) — matches if
            // that nested filter does NOT match.
            return !evaluateMissionFilter(children || [], system);

        case 'near':
        case 'distance':
        case 'neighbor':
            // Not evaluated — see the limitation note above. Permissive.
            return true;

        default:
            // Unknown/future filter key: permissive rather than silently
            // over-excluding systems as the parser's filter vocabulary grows.
            return true;
    }
}

// ── Mission index ───────────────────────────────────────────
//
// Builds, once per active-plugin-set change (not per frame), everything
// mapDisplay.js needs to draw mission markers and answer "what starts
// here?" on hover:
//   - concreteBySystem: systems with a mission whose source resolved to
//     exactly one system (both job-board and story missions land here).
//   - genericJobMatchCount: for filter-sourced JOB missions only (the
//     vast majority of job-board content), how many distinct job
//     templates COULD spawn at each system. Story missions with a
//     filter source aren't indexed here — there are hundreds of them
//     and, unlike jobs, they aren't the thing being toggled.
//   - stats: totals for the legend/subtitle.

function buildMissionIndex(missions, systemsArr) {
    const concreteBySystem = new Map(); // systemName -> { jobs: FormattedMission[], story: FormattedMission[] }
    const genericJobMatchCount = new Map(); // systemName -> count
    const genericJobFilters = missions.filter(m => m.isJob && m.sourceType === 'filter');

    let concreteJobs = 0, concreteStory = 0;

    for (const m of missions) {
        if (m.sourceType !== 'planet' || !m.sourceSystem) continue;
        if (!concreteBySystem.has(m.sourceSystem)) concreteBySystem.set(m.sourceSystem, { jobs: [], story: [] });
        const bucket = concreteBySystem.get(m.sourceSystem);
        if (m.isJob) { bucket.jobs.push(m); concreteJobs++; }
        else { bucket.story.push(m); concreteStory++; }
    }

    if (genericJobFilters.length > 0) {
        for (const system of systemsArr) {
            // Baseline rule regardless of any filter: a job can only be
            // offered where you can land at a spaceport. This alone
            // correctly excludes uninhabited/spaceport-less systems even
            // when a filter's other clauses are fully permissive (e.g. a
            // template with only a `near`/`distance` constraint, which
            // this evaluator can't check — see evaluateMissionFilter's
            // doc comment).
            const hasSpaceport = (system.planets || []).some(p => p.hasSpaceport);
            if (!hasSpaceport) continue;

            system._planetAttributes = _planetAttributeSet(system); // precomputed once, not per filter
            let count = 0;
            for (const m of genericJobFilters) {
                if (evaluateMissionFilter(m.sourceFilter, system)) count++;
            }
            if (count > 0) genericJobMatchCount.set(system.name, count);
        }
    }

    return {
        concreteBySystem,
        genericJobMatchCount,
        stats: {
            total: missions.length,
            concreteJobs,
            concreteStory,
            genericJobTemplates: genericJobFilters.length,
            unplaceable: missions.length - concreteJobs - concreteStory - genericJobFilters.length
                - missions.filter(m => !m.isJob && m.sourceType === 'filter').length,
        },
    };
}

window.MapCalculations = {
    createCamera,
    fitToSystems,
    worldToScreen,
    screenToWorld,
    zoomAt,
    findNearest,
    visibleSystems,
    buildLinkSegments,
    buildGovernmentPalette,
    search,
    lod,
    clampScale,
    evaluateMissionFilter,
    buildMissionIndex,
    buildStarTable,
    computeSolarAttributes,
    BASELINE_STAR_TABLE,
    MIN_SCALE,
    MAX_SCALE,
};

})();