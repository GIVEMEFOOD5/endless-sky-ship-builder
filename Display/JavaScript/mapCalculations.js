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
    MIN_SCALE,
    MAX_SCALE,
};

})();
