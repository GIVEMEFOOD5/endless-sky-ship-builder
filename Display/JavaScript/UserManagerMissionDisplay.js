'use strict';

// ═══════════════════════════════════════════════════════════
//  UserManagerMissionDisplay.js  —  front-end renderer
//
//  Same job as before: ask MissionLoader for data and push it
//  onto the page. No parsing, no formatting, no plugin-selection
//  logic of its own — that all now lives in generalPluginStuff.js
//  (window.PluginManager), the app's shared picker module.
//
//  Load order this file depends on:
//    1. generalPluginStuff.js  (defines window.PluginManager)
//    2. missionLoader.js       (defines window.MissionLoader,
//                                and the window.DataLoader shim
//                                generalPluginStuff.js talks to)
//    3. this file
// ═══════════════════════════════════════════════════════════

(function () {

const listEl     = document.getElementById('missionList');
const statusEl    = document.getElementById('status');
const searchInput = document.getElementById('searchInput');
const countLabel  = document.getElementById('countLabel');

// ── Loader events ────────────────────────────────────────────
document.addEventListener('missionsLoadStart', () => {
    if (statusEl) statusEl.textContent = 'Loading missions…';
});
document.addEventListener('missionsLoaded', () => {
    if (statusEl) statusEl.remove();
    searchInput.disabled = false;
});
document.addEventListener('missionsLoadError', (e) => {
    if (statusEl) statusEl.textContent = 'Could not load mission data: ' + e.detail.message;
});

searchInput.addEventListener('input', renderAll);

// Event delegation: one listener handles every card's expand/collapse
// and every raw-structure toggle, however many cards get rendered.
listEl.addEventListener('click', (e) => {
    const toggle = e.target.closest('.mission-raw-toggle');
    if (toggle) {
        const box = toggle.nextElementSibling;
        if (box.dataset.lazy === '1') {
            // Build the raw tree only now, on first expand — see
            // missionLoader.js's RAW_TREE_NODE_CAP comment for why.
            const card = toggle.closest('.mission-card');
            const m = currentMissions.get(card.dataset.id);
            box.innerHTML = (m && m.raw)
                ? MissionLoader.renderRawTree(m.raw)
                : '<div class="mission-empty">(no raw data)</div>';
            delete box.dataset.lazy;
        }
        box.classList.toggle('open');
        toggle.textContent = (box.classList.contains('open') ? '▾' : '▸') + ' View full raw structure';
        return;
    }
    const head = e.target.closest('.mission-head');
    if (head) head.parentElement.classList.toggle('open');
});

// ── PluginManager hook ───────────────────────────────────────
// generalPluginStuff.js calls this every time the active plugin set
// changes — from the picker, from reordering, or from removing a plugin
// in the active list. It's the ONE place display refreshes get triggered
// from now; we don't listen for 'pluginsChanged' ourselves.
window._renderCardsFromManager = async function (/* resetTab */) {
    renderAll();
};

// ── Bootstrap ────────────────────────────────────────────────
MissionLoader.load()
    .then(() => {
        window.PluginManager.ensurePickerOverlay();
        return window.PluginManager.initDefaultPlugin();
    })
    .catch(() => { /* missionsLoadError already fired and shown */ });

// Looked up by id when a card's raw-tree toggle is clicked, so we don't
// have to stuff raw mission data into the HTML string itself.
let currentMissions = new Map();

// ── Render ────────────────────────────────────────────────────
function renderAll() {
    const missions = MissionLoader.getAllMissions();
    const q = searchInput.value.trim().toLowerCase();
    const filtered = q ? missions.filter(m => m.searchText.includes(q)) : missions;

    currentMissions = new Map(filtered.map(m => [m.id, m]));

    countLabel.textContent = `${filtered.length} mission${filtered.length === 1 ? '' : 's'}`;
    listEl.innerHTML = filtered.length
        ? filtered.map(cardHtml).join('')
        : '<p class="mission-empty">No missions match.</p>';
}

function cardHtml(m) {
    return `
      <div class="mission-card" data-id="${m.id}">
        <div class="mission-head">
          <span class="mission-title">${m.titleHtml}</span>
          <span class="mission-plugin">${m.pluginHtml}</span>
        </div>
        <div class="mission-body">${m.bodyHtml}</div>
      </div>`;
}

})();
