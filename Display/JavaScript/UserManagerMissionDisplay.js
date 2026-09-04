'use strict';

// ═══════════════════════════════════════════════════════════
//  UserManagerMissionDisplay.js  —  front-end renderer
//
//  Same job as before: ask MissionLoader for data and push it
//  onto the page. No parsing, no formatting, no plugin-selection
//  logic of its own — that all now lives in generalPluginStuff.js
//  (window.PluginManager), the app's shared picker module.
//
//  One addition since last time: after MissionLoader hands back the
//  formatted catalog, it's run through MissionStatusHelper.decorateMissions()
//  — the "helper" layer — which attaches a `.status` (in progress /
//  available / completed / failed / declined / mixed / not encountered)
//  to each mission by cross-referencing whatever save is currently
//  loaded via the save reader page. This file still doesn't do any of
//  that cross-referencing itself — it just renders whatever `.status`
//  it's handed, the same way it already renders whatever `.bodyHtml`
//  it's handed.
//
//  Load order this file depends on:
//    1. generalPluginStuff.js    (defines window.PluginManager)
//    2. missionLoader.js         (defines window.MissionLoader,
//                                  and the window.DataLoader shim
//                                  generalPluginStuff.js talks to)
//    3. missionStatusHelper.js   (defines window.MissionStatusHelper —
//                                  OPTIONAL: if not loaded, status
//                                  badges are simply skipped, nothing
//                                  else breaks)
//    4. this file
// ═══════════════════════════════════════════════════════════

(function () {

const listEl        = document.getElementById('missionList');
const statusEl       = document.getElementById('status');
const searchInput    = document.getElementById('searchInput');
const countLabel     = document.getElementById('countLabel');
// Both optional — only used if present in the page's HTML. See the
// bottom of this file for the exact markup to add for each.
const statusFilterEl = document.getElementById('statusFilterSelect');
const noSaveNoticeEl = document.getElementById('noSaveNotice');

const HAS_STATUS_HELPER = typeof window.MissionStatusHelper !== 'undefined';

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

searchInput.addEventListener('input', applyFiltersAndRender);
if (statusFilterEl) statusFilterEl.addEventListener('change', applyFiltersAndRender);

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
    refreshMissions();
};

// The current save lives in localStorage, set by a DIFFERENT page (the
// Save Reader). If that page is open in another tab and the save gets
// switched while this page is sitting idle, the 'storage' event is how
// this tab finds out — localStorage doesn't push updates any other way.
if (HAS_STATUS_HELPER) {
    window.addEventListener('storage', (e) => {
        if (e.key === 'ES_SM_CURRENT' || (e.key && e.key.startsWith('ES_SM_SAVE_'))) {
            refreshMissions();
        }
    });
}

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

// The full decorated catalog, recomputed only when the underlying data
// actually changes (initial load, active-plugin change) — NOT on every
// keystroke. Decorating 8000+ missions means running MissionStatusHelper
// over the whole save's condition set each time, and re-reading + JSON-
// parsing the save from localStorage on top of that; doing that per
// keystroke in the search box would make typing visibly laggy for no
// reason, since the save and catalog aren't changing while someone types.
let allDecoratedMissions = [];

// ── Status badge styling ─────────────────────────────────────
// Maps MissionStatusHelper.STATUS values to a CSS modifier class and a
// short badge label (the full label with counts/history still shows in
// the card body's field grid — this is just the at-a-glance version).
const STATUS_BADGE = HAS_STATUS_HELPER ? {
    [MissionStatusHelper.STATUS.IN_PROGRESS]:     { cls: 'active',    text: 'In progress' },
    [MissionStatusHelper.STATUS.AVAILABLE]:       { cls: 'available', text: 'Available' },
    [MissionStatusHelper.STATUS.DONE]:            { cls: 'done',      text: 'Completed' },
    [MissionStatusHelper.STATUS.FAILED]:          { cls: 'failed',    text: 'Failed' },
    [MissionStatusHelper.STATUS.DECLINED]:        { cls: 'declined',  text: 'Declined' },
    [MissionStatusHelper.STATUS.MIXED]:           { cls: 'mixed',     text: 'Mixed history' },
    [MissionStatusHelper.STATUS.OFFERED_ONLY]:    { cls: 'offered',   text: 'Offered' },
    // NOT_ENCOUNTERED deliberately has no entry — the vast majority of a
    // full mission catalog will be this, and a badge on every single card
    // would be pure noise. No entry here = no badge rendered (see
    // statusBadgeHtml below), not an error.
} : {};

function statusBadgeHtml(m) {
    if (!m.status) return '';
    const badge = STATUS_BADGE[m.status.status];
    if (!badge) return '';
    return `<span class="mission-status-badge mission-status-badge--${badge.cls}" title="${esc(m.status.label)}">${esc(badge.text)}</span>`;
}

function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Render ────────────────────────────────────────────────────
// Expensive: pulls the full catalog from MissionLoader and, if available,
// decorates every mission with its save-file status. Only call this when
// the underlying data actually changed — see allDecoratedMissions above.
function refreshMissions() {
    let missions = MissionLoader.getAllMissions();

    if (HAS_STATUS_HELPER) {
        const save = MissionStatusHelper.getCurrentSave();
        missions = MissionStatusHelper.decorateMissions(missions, save);
        // Fold the status label into search text too, so typing "failed"
        // or "in progress" filters the list without a dedicated control.
        missions.forEach(m => { m.searchText = `${m.searchText} ${m.status.label}`.toLowerCase(); });
        if (noSaveNoticeEl) noSaveNoticeEl.classList.toggle('hidden', !!save);
    } else if (noSaveNoticeEl) {
        noSaveNoticeEl.classList.add('hidden');
    }

    allDecoratedMissions = missions;
    applyFiltersAndRender();
}

// Cheap: just search text + status dropdown over the already-decorated
// catalog. Safe to call on every keystroke.
function applyFiltersAndRender() {
    const q = searchInput.value.trim().toLowerCase();
    let filtered = q ? allDecoratedMissions.filter(m => m.searchText.includes(q)) : allDecoratedMissions;

    const statusPick = statusFilterEl ? statusFilterEl.value : '';
    if (statusPick && HAS_STATUS_HELPER) {
        filtered = statusPick === 'has_status'
            ? filtered.filter(m => m.status.status !== MissionStatusHelper.STATUS.NOT_ENCOUNTERED)
            : filtered.filter(m => m.status.status === statusPick);
    }

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
          <span class="mission-head-right">
            ${statusBadgeHtml(m)}
            <span class="mission-plugin">${m.pluginHtml}</span>
          </span>
        </div>
        <div class="mission-body">${m.bodyHtml}</div>
      </div>`;
}

// ═══════════════════════════════════════════════════════════
//  Optional HTML this file looks for (both are safe to omit — status
//  badges/filtering just won't appear if they're not on the page):
//
//  Status filter dropdown, next to the search box:
//    <select id="statusFilterSelect">
//      <option value="">All statuses</option>
//      <option value="has_status">Has any save data</option>
//      <option value="in_progress">In progress</option>
//      <option value="available_not_accepted">Available</option>
//      <option value="completed_successfully">Completed</option>
//      <option value="completed_unsuccessfully">Failed</option>
//      <option value="declined">Declined</option>
//      <option value="mixed">Mixed history</option>
//      <option value="offered_only">Offered only</option>
//    </select>
//
//  "No save loaded" notice, shown only when MissionStatusHelper has no
//  current save to cross-reference against:
//    <p id="noSaveNotice" class="hidden">
//      No save loaded — status badges need a save imported on the Save
//      Reader page first.
//    </p>
// ═══════════════════════════════════════════════════════════

})();
