'use strict';

// ═══════════════════════════════════════════════════════════
//  mapDisplay.js  —  Endless Sky Ship Builder / Systems Map
//
//  STAGE 4 of the map pipeline: DISPLAY IT INTELLIGENTLY.
//  Owns the canvas, draws systems/links/labels at a level of detail
//  chosen by mapCalculations.js, wires up mouse AND touch input
//  (pan, pinch-zoom, tap, hover), renders the legend/search/tooltip
//  UI, and shows loading progress while mapDataLoader.js fetches
//  (potentially large) per-plugin map files.
//
//  Dependencies (must be loaded before this file):
//    mapDataLoader.js      — window.MapDataLoader
//    mapDataFormatter.js   — window.MapDataFormatter
//    mapCalculations.js    — window.MapCalculations
//    generalPluginStuff.js — window.PluginManager  (which plugins are active)
//    dataLoader.js         — window.DataLoader     (populates window.allData
//                             so the shared plugin picker has something to list)
//
//  INTEGRATION WITH GeneralPluginStuff
//  ------------------------------------
//  generalPluginStuff.js owns "which plugins are active" sitewide and
//  calls `window._renderCardsFromManager(resetTab)` every time that
//  selection changes (plugin added/removed/reordered, or on first
//  load). This file defines that hook: on every call, it asks
//  PluginManager for the current active list, downloads/merges just
//  those plugins' map data, and redraws. No other page logic needs
//  to know the map exists.
// ═══════════════════════════════════════════════════════════

(function () {

const { MapDataLoader, MapDataFormatter, MapCalculations } = window;

// ── DOM refs (grabbed lazily — Systems.html defines these ids) ──
let canvas, ctx, wrap;
let searchInput, resultsEl, legendListEl, tooltipEl, subtitleEl, loadingEl, loadingBarEl;

let dpr = Math.min(window.devicePixelRatio || 1, 2);

// ── Map state (rebuilt every time the active plugin set changes) ──
let systemsByName = new Map();  // FormattedSystem, keyed by name
let systemsArr = [];            // same data, as an array (perf: avoid Map iteration in hot paths)
let galaxies = [];
let linkSegments = [];
let govPalette = { names: [], counts: {}, colors: {} };
const activeGovFilters = new Set(); // governments currently hidden by the legend

let cam = MapCalculations.createCamera();
let hovered = null;
let selected = null;
let hasFitCamera = false;

// ═══════════════════════════════════════════════════════════
//  Bootstrapping
// ═══════════════════════════════════════════════════════════

function _grabDom() {
    canvas = document.getElementById('mapCanvas');
    ctx = canvas.getContext('2d');
    wrap = document.getElementById('mapWrap');
    searchInput = document.getElementById('mapSearchInput');
    resultsEl = document.getElementById('mapSearchResults');
    legendListEl = document.getElementById('mapLegendList');
    tooltipEl = document.getElementById('mapTooltip');
    subtitleEl = document.getElementById('mapSubtitle');
    loadingEl = document.getElementById('mapLoading');
    loadingBarEl = document.getElementById('mapLoadingBar');
}

function init() {
    _grabDom();
    _wireCanvasInput();
    _wireSearch();
    _wireControls();
    _wireLoadProgress();
    window.addEventListener('resize', _resizeCanvas);
    _resizeCanvas();

    if (!window.DataLoader) {
        _showError('dataLoader.js must be loaded before mapDisplay.js');
        return;
    }
    // Ships/outfits are irrelevant to the map, but DataLoader populates
    // window.allData with plugin metadata, which is what the shared
    // plugin picker (PluginManager) reads to build its list.
    window.DataLoader.onReady(() => {
        window.PluginManager.initDefaultPlugin();
    });
    window.DataLoader.load().catch(err => _showError(err.message));

    document.addEventListener('dataLoadError', e => {
        _showError(`Could not load plugin list: ${e.detail?.message || 'unknown error'}`);
    });
}

// This is the hook generalPluginStuff.js calls on every plugin-selection change.
window._renderCardsFromManager = async function (resetView) {
    const active = window.PluginManager.getActivePlugins()
        .filter(id => id !== window.PluginManager.LOCAL_PLUGIN_ID); // no ship builds on a starmap
    if (active.length === 0) {
        _showError('No plugins selected — pick at least one from "Select Plugins".');
        return;
    }
    await _loadAndRender(active, resetView);
};

async function _loadAndRender(activeOutputNames, resetView) {
    _setLoading(true, activeOutputNames.length);
    try {
        const pluginDataMap = await MapDataLoader.loadPlugins(activeOutputNames);

        systemsByName = MapDataFormatter.formatSystems(pluginDataMap, activeOutputNames);
        const wormholeLinks = MapDataFormatter.formatWormholes(pluginDataMap);
        MapDataFormatter.applyWormholeFlags(systemsByName, wormholeLinks);
        const planetsBySystem = MapDataFormatter.formatPlanets(pluginDataMap, activeOutputNames);
        MapDataFormatter.attachPlanets(systemsByName, planetsBySystem);
        galaxies = MapDataFormatter.formatGalaxies(pluginDataMap).filter(g => !g.isLabel);

        systemsArr = [...systemsByName.values()];
        linkSegments = MapCalculations.buildLinkSegments(systemsByName);
        govPalette = MapCalculations.buildGovernmentPalette(systemsArr);

        activeGovFilters.clear();
        govPalette.names.forEach(g => activeGovFilters.add(g));

        _renderLegend();
        _updateSubtitle(activeOutputNames);

        if (resetView || !hasFitCamera) {
            cam = MapCalculations.fitToSystems(systemsArr, canvas.clientWidth, canvas.clientHeight);
            hasFitCamera = true;
            selected = null;
        }
        _draw();
    } catch (err) {
        console.error('[mapDisplay] render failed:', err);
        _showError(err.message);
    } finally {
        _setLoading(false);
    }
}

// ═══════════════════════════════════════════════════════════
//  Loading UI (these files can be large — show real progress)
// ═══════════════════════════════════════════════════════════

function _wireLoadProgress() {
    document.addEventListener('mapPluginLoaded', e => {
        const { index, total } = e.detail;
        if (loadingBarEl) loadingBarEl.style.width = `${Math.round(((index + 1) / total) * 100)}%`;
    });
}

function _setLoading(isLoading, total) {
    if (!loadingEl) return;
    loadingEl.style.display = isLoading ? 'flex' : 'none';
    if (isLoading && loadingBarEl) loadingBarEl.style.width = '4%';
}

function _showError(message) {
    if (subtitleEl) subtitleEl.textContent = `⚠ ${message}`;
}

function _updateSubtitle(activeOutputNames) {
    if (!subtitleEl) return;
    const slimNote = [...systemsByName.values()].length
        ? ''
        : '';
    subtitleEl.textContent =
        `${systemsArr.length} systems · ${govPalette.names.length} governments · ` +
        `${activeOutputNames.length} plugin${activeOutputNames.length === 1 ? '' : 's'} active`;
}

// ═══════════════════════════════════════════════════════════
//  Legend
// ═══════════════════════════════════════════════════════════

function _renderLegend() {
    if (!legendListEl) return;
    legendListEl.innerHTML = '';
    govPalette.names.forEach(g => {
        const row = document.createElement('div');
        row.className = 'map-legend-row';
        row.innerHTML = `
            <span class="map-legend-dot" style="background:${govPalette.colors[g]}"></span>
            <span class="map-legend-name">${g}</span>
            <span class="map-legend-count">${govPalette.counts[g]}</span>
        `;
        row.addEventListener('click', () => {
            if (activeGovFilters.has(g)) { activeGovFilters.delete(g); row.classList.add('off'); }
            else { activeGovFilters.add(g); row.classList.remove('off'); }
            _draw();
        });
        legendListEl.appendChild(row);
    });
}

// ═══════════════════════════════════════════════════════════
//  Canvas sizing
// ═══════════════════════════════════════════════════════════

function _resizeCanvas() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    _draw();
}

// ═══════════════════════════════════════════════════════════
//  Drawing
// ═══════════════════════════════════════════════════════════

function _visibleSet() {
    return systemsArr.filter(s => activeGovFilters.has(s.government));
}

function _draw() {
    if (!ctx) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Cheap deterministic starfield — no allocations, no Math.random per frame.
    ctx.fillStyle = '#0d1220';
    for (let i = 0; i < 140; i++) {
        const sx = (i * 197) % w, sy = (i * 271) % h;
        ctx.globalAlpha = 0.22 + (i % 5) * 0.07;
        ctx.fillRect(sx, sy, 1, 1);
    }
    ctx.globalAlpha = 1;

    const visible = _visibleSet();
    const visibleNames = new Set(visible.map(s => s.name));
    const { nodeRadius, linkWidth, showAllLabels } = MapCalculations.lod(cam);

    // Links
    ctx.lineWidth = linkWidth;
    ctx.strokeStyle = 'rgba(60,78,110,0.45)';
    ctx.beginPath();
    for (const seg of linkSegments) {
        if (!visibleNames.has(seg.a.name) || !visibleNames.has(seg.b.name)) continue;
        const p1 = MapCalculations.worldToScreen(cam, seg.a.x, seg.a.y, w, h);
        const p2 = MapCalculations.worldToScreen(cam, seg.b.x, seg.b.y, w, h);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();

    // Nodes
    for (const s of visible) {
        const p = MapCalculations.worldToScreen(cam, s.x, s.y, w, h);
        if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;
        ctx.beginPath();
        ctx.fillStyle = govPalette.colors[s.government] || '#888';
        ctx.arc(p.x, p.y, s.wormhole ? nodeRadius * 1.3 : nodeRadius, 0, Math.PI * 2);
        ctx.fill();
        if (s.wormhole) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(180,140,255,0.85)';
            ctx.lineWidth = 1;
            ctx.arc(p.x, p.y, nodeRadius * 1.3 + 2, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    // Hovered / selected highlight rings + always-on labels
    [selected, hovered].forEach((s, idx) => {
        if (!s || !visibleNames.has(s.name)) return;
        const p = MapCalculations.worldToScreen(cam, s.x, s.y, w, h);
        ctx.beginPath();
        ctx.strokeStyle = idx === 0 ? '#ffffff' : '#5ee1c9';
        ctx.lineWidth = 1.5;
        ctx.arc(p.x, p.y, nodeRadius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = '#e8edf7';
        ctx.fillText(s.name, p.x + nodeRadius + 7, p.y + 4);
    });

    // At high zoom, label everything visible (intelligent LOD — avoids
    // an unreadable wall of text when zoomed out to the whole galaxy).
    if (showAllLabels) {
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(200,210,230,0.75)';
        for (const s of visible) {
            if (s === selected || s === hovered) continue;
            const p = MapCalculations.worldToScreen(cam, s.x, s.y, w, h);
            if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;
            ctx.fillText(s.name, p.x + nodeRadius + 5, p.y + 3);
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  Input — mouse (desktop) + touch (mobile), same camera ops
// ═══════════════════════════════════════════════════════════

function _wireCanvasInput() {
    let dragging = false, moved = false, lastX = 0, lastY = 0;

    canvas.addEventListener('mousedown', e => {
        dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
        canvas.classList.add('grabbing');
    });
    window.addEventListener('mouseup', () => { dragging = false; canvas.classList.remove('grabbing'); });
    window.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        if (dragging) {
            const dx = e.clientX - lastX, dy = e.clientY - lastY;
            if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
            cam.x -= dx / cam.scale;
            cam.y -= dy / cam.scale;
            lastX = e.clientX; lastY = e.clientY;
            _draw();
            _hideTooltip();
            return;
        }
        _updateHover(sx, sy, e.clientX, e.clientY);
    });
    canvas.addEventListener('click', () => {
        if (moved) return;
        if (hovered) { selected = hovered; _draw(); }
    });
    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        cam = MapCalculations.zoomAt(cam, factor, sx, sy, canvas.clientWidth, canvas.clientHeight);
        _draw();
    }, { passive: false });

    // ── Touch: one finger pans, two fingers pinch-zoom, a tap selects ──
    let touchMode = null; // 'pan' | 'pinch'
    let touchLastX = 0, touchLastY = 0, touchMoved = false;
    let pinchStartDist = 0, pinchStartScale = 1, pinchMidX = 0, pinchMidY = 0;

    function _dist(t0, t1) {
        return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    }
    function _mid(t0, t1, rect) {
        return { x: (t0.clientX + t1.clientX) / 2 - rect.left, y: (t0.clientY + t1.clientY) / 2 - rect.top };
    }

    canvas.addEventListener('touchstart', e => {
        const rect = canvas.getBoundingClientRect();
        if (e.touches.length === 1) {
            touchMode = 'pan'; touchMoved = false;
            touchLastX = e.touches[0].clientX; touchLastY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            touchMode = 'pinch';
            pinchStartDist = _dist(e.touches[0], e.touches[1]);
            pinchStartScale = cam.scale;
            const mid = _mid(e.touches[0], e.touches[1], rect);
            pinchMidX = mid.x; pinchMidY = mid.y;
        }
    }, { passive: true });

    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        if (touchMode === 'pan' && e.touches.length === 1) {
            const dx = e.touches[0].clientX - touchLastX, dy = e.touches[0].clientY - touchLastY;
            if (Math.abs(dx) + Math.abs(dy) > 3) touchMoved = true;
            cam.x -= dx / cam.scale;
            cam.y -= dy / cam.scale;
            touchLastX = e.touches[0].clientX; touchLastY = e.touches[0].clientY;
            _draw();
        } else if (touchMode === 'pinch' && e.touches.length === 2) {
            const dist = _dist(e.touches[0], e.touches[1]);
            const factor = (dist / (pinchStartDist || dist)) * pinchStartScale / cam.scale;
            cam = MapCalculations.zoomAt(cam, factor, pinchMidX, pinchMidY, canvas.clientWidth, canvas.clientHeight);
            _draw();
        }
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
        if (touchMode === 'pan' && !touchMoved && e.changedTouches.length === 1) {
            const rect = canvas.getBoundingClientRect();
            const sx = e.changedTouches[0].clientX - rect.left, sy = e.changedTouches[0].clientY - rect.top;
            const world = MapCalculations.screenToWorld(cam, sx, sy, canvas.clientWidth, canvas.clientHeight);
            const thresh = (MapCalculations.lod(cam).nodeRadius + 10) / cam.scale;
            const nearest = MapCalculations.findNearest(_visibleSet(), world.x, world.y, thresh);
            if (nearest) {
                selected = nearest;
                _showTooltip(nearest, e.changedTouches[0].clientX, e.changedTouches[0].clientY);
                _draw();
            }
        }
        touchMode = null;
    });
}

function _updateHover(sx, sy, clientX, clientY) {
    const world = MapCalculations.screenToWorld(cam, sx, sy, canvas.clientWidth, canvas.clientHeight);
    const thresh = (MapCalculations.lod(cam).nodeRadius + 6) / cam.scale;
    const nearest = MapCalculations.findNearest(_visibleSet(), world.x, world.y, thresh);
    if (nearest !== hovered) { hovered = nearest; _draw(); }
    if (nearest) _showTooltip(nearest, clientX, clientY);
    else _hideTooltip();
}

// ═══════════════════════════════════════════════════════════
//  Tooltip
// ═══════════════════════════════════════════════════════════

function _showTooltip(s, clientX, clientY) {
    if (!tooltipEl) return;
    const links = s.links.length ? s.links.slice(0, 6).join(', ') + (s.links.length > 6 ? '…' : '') : '—';
    tooltipEl.innerHTML = `
        <b>${s.name}</b><br>
        <span class="map-tooltip-gov">${s.government}</span>
        ${s.wormhole ? '<span class="map-tooltip-badge">wormhole</span>' : ''}
        <div class="map-tooltip-links">links: ${links}</div>
        ${_planetsHtml(s.planets)}
        <div class="map-tooltip-source">from: ${s.definedBy.join(', ')}</div>
    `;
    tooltipEl.style.display = 'block';
    const wrapRect = wrap.getBoundingClientRect();
    tooltipEl.style.left = Math.min(clientX - wrapRect.left + 14, wrapRect.width - 250) + 'px';
    tooltipEl.style.top = (clientY - wrapRect.top + 14) + 'px';
}

/**
 * Renders the planets.json data actually attached to this system:
 * each planet's own government (which can differ from the system's —
 * e.g. a pirate-held world in an otherwise Republic system) plus
 * small badges for shipyard/outfitter/spaceport access.
 */
function _planetsHtml(planets) {
    if (!planets || planets.length === 0) return '';
    const rows = planets.slice(0, 6).map(p => {
        const badges = [
            p.hasSpaceport ? 'port' : null,
            p.hasShipyard ? 'shipyard' : null,
            p.hasOutfitter ? 'outfitter' : null,
        ].filter(Boolean).join(' · ');
        const govNote = p.government ? ` <span class="map-tooltip-planet-gov">(${p.government})</span>` : '';
        return `<div class="map-tooltip-planet">• ${p.name}${govNote}${badges ? ` — ${badges}` : ''}</div>`;
    }).join('');
    const more = planets.length > 6 ? `<div class="map-tooltip-planet">…and ${planets.length - 6} more</div>` : '';
    return `<div class="map-tooltip-planets">${rows}${more}</div>`;
}

function _hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
//  Search
// ═══════════════════════════════════════════════════════════

function _wireSearch() {
    if (!searchInput) return;
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        if (!q) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; return; }
        const matches = MapCalculations.search(_visibleSet(), q, 20);
        resultsEl.innerHTML = matches.map(s =>
            `<div data-n="${s.name.replace(/"/g, '&quot;')}"><b>${s.name}</b><span>${s.government}</span></div>`
        ).join('');
        resultsEl.style.display = matches.length ? 'block' : 'none';
    });
    resultsEl.addEventListener('click', e => {
        const row = e.target.closest('div[data-n]');
        if (!row) return;
        const s = systemsByName.get(row.getAttribute('data-n'));
        if (!s) return;
        selected = s;
        cam.x = s.x; cam.y = s.y; cam.scale = Math.max(cam.scale, 3);
        resultsEl.style.display = 'none';
        searchInput.value = s.name;
        searchInput.blur(); // dismiss the mobile keyboard
        _draw();
    });
}

// ═══════════════════════════════════════════════════════════
//  Zoom / reset controls
// ═══════════════════════════════════════════════════════════

function _wireControls() {
    const zoomIn = document.getElementById('mapZoomIn');
    const zoomOut = document.getElementById('mapZoomOut');
    const reset = document.getElementById('mapReset');
    const w = () => canvas.clientWidth, h = () => canvas.clientHeight;
    if (zoomIn) zoomIn.addEventListener('click', () => {
        cam = MapCalculations.zoomAt(cam, 1.3, w() / 2, h() / 2, w(), h());
        _draw();
    });
    if (zoomOut) zoomOut.addEventListener('click', () => {
        cam = MapCalculations.zoomAt(cam, 1 / 1.3, w() / 2, h() / 2, w(), h());
        _draw();
    });
    if (reset) reset.addEventListener('click', () => {
        cam = MapCalculations.fitToSystems(systemsArr, w(), h());
        selected = null;
        _draw();
    });
}

document.addEventListener('DOMContentLoaded', init);

})();
