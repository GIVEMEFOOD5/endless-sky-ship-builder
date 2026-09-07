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

// ── Mission source filters ──────────────────────────────────
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
    MIN_SCALE,
    MAX_SCALE,
};

})();
