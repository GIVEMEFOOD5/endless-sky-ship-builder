'use strict';

// ═══════════════════════════════════════════════════════════
//  display.js  —  front-end renderer
//
//  This file does exactly one job: ask MissionLoader for data
//  and push it onto the page. It never touches a raw mission
//  object, never formats a field, never walks a tree — all of
//  that already happened in missionLoader.js. If a field looks
//  wrong, fix it there; this file just renders whatever it's
//  handed.
// ═══════════════════════════════════════════════════════════

(function () {

const listEl          = document.getElementById('missionList');
const statusEl         = document.getElementById('status');
const searchInput      = document.getElementById('searchInput');
const countLabel       = document.getElementById('countLabel');
const pluginToggleBtn  = document.getElementById('pluginToggleBtn');
const pluginPanel      = document.getElementById('pluginPanel');
const pluginGroups     = document.getElementById('pluginGroups');
const pluginSearchInput = document.getElementById('pluginSearchInput');
const pluginAllBtn     = document.getElementById('pluginAllBtn');
const pluginNoneBtn    = document.getElementById('pluginNoneBtn');

// ── Wire up the loader's events ─────────────────────────────
document.addEventListener('missionsLoadStart', () => {
    if (statusEl) statusEl.textContent = 'Loading missions…';
});
document.addEventListener('missionsLoaded', () => {
    if (statusEl) statusEl.remove();
    searchInput.disabled = false;
    pluginToggleBtn.disabled = false;
});
document.addEventListener('missionsLoadError', (e) => {
    if (statusEl) statusEl.textContent = 'Could not load mission data: ' + e.detail.message;
});
document.addEventListener('missionPluginsChanged', () => {
    renderAll();
    renderPluginPanel();
});

searchInput.addEventListener('input', renderAll);

// ── Plugin selector ──────────────────────────────────────────
pluginToggleBtn.addEventListener('click', () => {
    pluginPanel.classList.toggle('hidden');
    pluginToggleBtn.classList.toggle('active', !pluginPanel.classList.contains('hidden'));
    if (!pluginPanel.classList.contains('hidden')) renderPluginPanel();
});

pluginSearchInput.addEventListener('input', () => renderPluginPanel());

pluginAllBtn.addEventListener('click', () => {
    MissionLoader.setActivePlugins(MissionLoader.getPlugins().map(p => p.outputName));
});
pluginNoneBtn.addEventListener('click', () => {
    MissionLoader.setActivePlugins([]);
});

// One delegated listener handles every checkbox, however many plugins load.
pluginGroups.addEventListener('change', (e) => {
    const checkbox = e.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    const active = new Set(MissionLoader.getActivePlugins());
    if (checkbox.checked) active.add(checkbox.value);
    else active.delete(checkbox.value);
    MissionLoader.setActivePlugins([...active]);
});

function renderPluginPanel() {
    const plugins = MissionLoader.getPlugins();
    const active = new Set(MissionLoader.getActivePlugins());
    const q = pluginSearchInput.value.trim().toLowerCase();

    pluginToggleBtn.textContent = `Plugins (${active.size}/${plugins.length})`;

    // Group by sourceName, same grouping the rest of the app uses.
    const groups = {};
    plugins.forEach(p => {
        if (q && !p.displayName.toLowerCase().includes(q) && !p.sourceName.toLowerCase().includes(q)) return;
        (groups[p.sourceName] = groups[p.sourceName] || []).push(p);
    });

    const sourceNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    if (sourceNames.length === 0) {
        pluginGroups.innerHTML = '<p class="empty">No matching plugins.</p>';
        return;
    }

    pluginGroups.innerHTML = sourceNames.map(source => {
        const rows = groups[source].map(p => {
            const label = groups[source].length === 1 ? source : p.displayName;
            return `
              <label class="plugin-row${p.missionCount === 0 ? ' zero' : ''}">
                <input type="checkbox" value="${escAttr(p.outputName)}" ${active.has(p.outputName) ? 'checked' : ''}>
                <span class="plugin-row-name">${esc(label)}</span>
                <span class="plugin-row-count">${p.missionCount}</span>
              </label>`;
        }).join('');
        return `<div class="plugin-group-header">${esc(source)}</div>${rows}`;
    }).join('');
}

function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(str) {
    return esc(str).replace(/"/g, '&quot;');
}

// Event delegation: one listener handles every card's expand/collapse
// and every raw-structure toggle, however many cards get rendered.
listEl.addEventListener('click', (e) => {
    const toggle = e.target.closest('.raw-toggle');
    if (toggle) {
        const box = toggle.nextElementSibling;
        box.classList.toggle('open');
        toggle.textContent = (box.classList.contains('open') ? '▾' : '▸') + ' View full raw structure';
        return;
    }
    const head = e.target.closest('.mission-head');
    if (head) head.parentElement.classList.toggle('open');
});

// ── Kick off loading ─────────────────────────────────────────
MissionLoader.load().catch(() => { /* missionsLoadError already fired */ });

// ── Render ────────────────────────────────────────────────────
function renderAll() {
    const missions = MissionLoader.getAllMissions();
    const q = searchInput.value.trim().toLowerCase();
    const filtered = q ? missions.filter(m => m.searchText.includes(q)) : missions;

    countLabel.textContent = `${filtered.length} mission${filtered.length === 1 ? '' : 's'}`;
    listEl.innerHTML = filtered.length
        ? filtered.map(cardHtml).join('')
        : '<p class="empty">No missions match.</p>';
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