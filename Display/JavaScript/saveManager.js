'use strict';

// ═══════════════════════════════════════════════════════════
//  saveManager.js
//
//  Responsibilities:
//    - Persist multiple parsed Endless Sky saves in localStorage
//    - Track which save is "current" in its own separate key
//    - Drive all UI rendering for savereader.html
//
//  Depends on esSaveParser.js (must be loaded first) for
//  parseESSaveFile(). This file does NOT parse save text itself —
//  parsing logic stays in esSaveParser.js.
//
//  ── localStorage keys ──────────────────────────────────────
//    ES_SM_REGISTRY   →  JSON array of save summaries:
//                         [{ id, label, pilotName, importedAt }]
//    ES_SM_SAVE_<id>  →  JSON of the full parsed save object
//    ES_SM_CURRENT    →  JSON of just the active save's id (string)
//                         kept in its own key, separate from the
//                         registry/save data, as requested.
// ═══════════════════════════════════════════════════════════

const SM_REGISTRY_KEY = 'ES_SM_REGISTRY';
const SM_SAVE_PREFIX  = 'ES_SM_SAVE_';
const SM_CURRENT_KEY  = 'ES_SM_CURRENT';

let parsedSave    = null;   // the currently-loaded parsed save object
let currentSaveId = null;   // id of the currently-loaded save
let activeFilter  = '';
let activeSort    = 'default';

const el = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════
//  STORAGE LAYER
// ═══════════════════════════════════════════════════════════

function smGetRegistry() {
  try {
    const raw = localStorage.getItem(SM_REGISTRY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('[saveManager] Could not read registry:', e);
    return [];
  }
}

function smSetRegistry(list) {
  try {
    localStorage.setItem(SM_REGISTRY_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.warn('[saveManager] Could not write registry:', e);
    return false;
  }
}

function smGetSaveData(id) {
  try {
    const raw = localStorage.getItem(SM_SAVE_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[saveManager] Could not read save', id, e);
    return null;
  }
}

function smSetSaveData(id, data) {
  try {
    localStorage.setItem(SM_SAVE_PREFIX + id, JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn('[saveManager] Could not write save', id, e);
    return false;
  }
}

function smDeleteSaveData(id) {
  try {
    localStorage.removeItem(SM_SAVE_PREFIX + id);
  } catch (e) { /* ignore */ }
}

// "Current save" pointer lives in its own dedicated key, separate
// from the registry and from any individual save's data.
function smGetCurrentId() {
  try {
    const raw = localStorage.getItem(SM_CURRENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function smSetCurrentId(id) {
  try {
    localStorage.setItem(SM_CURRENT_KEY, JSON.stringify(id));
  } catch (e) { /* ignore */ }
}
function smClearCurrentId() {
  try {
    localStorage.removeItem(SM_CURRENT_KEY);
  } catch (e) { /* ignore */ }
}

function smMakeId() {
  return 'save_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Add a freshly-parsed save to storage and make it current.
function smAddSave(parsed, originalFileName) {
  const id = smMakeId();
  const summary = {
    id,
    label: parsed.pilot.name || originalFileName || 'Unnamed Save',
    pilotName: parsed.pilot.name || '',
    importedAt: Date.now(),
  };
  const registry = smGetRegistry();
  registry.push(summary);
  smSetRegistry(registry);
  smSetSaveData(id, parsed);
  smSetCurrentId(id);
  return id;
}

function smRemoveSave(id) {
  const registry = smGetRegistry().filter(s => s.id !== id);
  smSetRegistry(registry);
  smDeleteSaveData(id);
  if (smGetCurrentId() === id) {
    smClearCurrentId();
  }
}

// ═══════════════════════════════════════════════════════════
//  PLUGIN MATCHING
//
//  The save file's `plugins` block only lists the bare folder/internal
//  name the game wrote (e.g. "DAIS", "Rumskib", "compact_layout") — no
//  repository info.
//
//  Each loaded plugin's data now lives at data/<pluginName>/pluginData.json,
//  so <pluginName> (the folder name) is the plugin's outputName/key in
//  window.allData — the same role it played before, just a different
//  fetch path inside dataLoader.js. plugins.json (at the repo root) maps
//  a save's bare plugin name to a GitHub repository URL, which we use as
//  a last-resort identity check when the name itself doesn't line up.
//
//  We try several matching strategies, since the save's name, the data
//  folder's name, and the in-game display name don't always agree:
// ═══════════════════════════════════════════════════════════

const PLUGIN_REGISTRY_URL = '../plugins.json';

let _pluginRegistryCache = null;

async function smLoadPluginRegistry() {
  if (_pluginRegistryCache) return _pluginRegistryCache;
  try {
    const res = await fetch(PLUGIN_REGISTRY_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    _pluginRegistryCache = Array.isArray(json.plugins) ? json.plugins : [];
  } catch (e) {
    console.warn('[saveManager] Could not load plugins.json:', e);
    _pluginRegistryCache = [];
  }
  return _pluginRegistryCache;
}

// Normalise a name for loose comparison: lowercase, strip punctuation/spaces.
function _smNormalisePluginName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['’"()]/g, '')
    .replace(/[\s_-]+/g, '');
}

// Strip a trailing "-main" / "-master" (GitHub's default branch zip suffix)
// from a folder/output name before comparing, and also return the
// "-main" variant of a save name so we can check both directions.
function _smStripBranchSuffix(name) {
  return String(name || '').replace(/-(main|master)$/i, '');
}
function _smWithMainSuffix(name) {
  return String(name || '') + '-main';
}

// A loaded plugin's display label may come through as `displayPluginName`
// (read from inside data/<pluginName>/pluginData.json), the older
// `displayName` field (from index.json), or simply `name`. Check all three
// so matching doesn't silently break if dataLoader.js's field name changes.
// Returns '' if none are present — callers fall back to the folder name
// themselves, since not every plugin folder has a pluginData.json to
// read a name from in the first place.
function _smDisplayLabel(data) {
  return data?.displayPluginName || data?.displayName || data?.name || '';
}

// Extract the "owner/repo" slug from a GitHub URL for identity comparison.
function _smRepoSlug(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!m) return '';
  return (m[1] + '/' + m[2]).toLowerCase().replace(/\.git$/, '');
}

/**
 * Given the list of bare plugin names from a save file, returns:
 *   {
 *     matched:   [{ saveName, outputName, sourceName, displayName, matchedBy }],
 *     unmatched: [{ saveName, reason }]   // reason: 'not-in-registry' | 'not-loaded'
 *   }
 *
 * Match strategy, tried in this order for every save plugin name:
 *   1. Exact (normalised) match against the loaded plugin's outputName —
 *      this is the literal name of its folder under data/
 *      (e.g. data/DAIS/pluginData.json → outputName "DAIS").
 *   2. Same, but allowing either side to carry a "-main"/"-master" suffix —
 *      covers folders saved as GitHub's default-branch zip name (e.g. "DAIS-main").
 *   3. Exact (normalised) match against the loaded plugin's display label —
 *      checks displayPluginName (from pluginData.json), displayName
 *      (from index.json), and plain name — whichever field the loaded
 *      plugin actually carries.
 *   4. Registry lookup (plugins.json) → repository URL → repo slug →
 *      match against outputName containing that slug. This is the fallback
 *      for cases where the save's name, the folder name, and the display
 *      name all differ from one another.
 *
 * "matched" means we found a loaded plugin (window.allData key) that
 * corresponds to the save's plugin name. "unmatched" means none of the
 * four strategies found a loaded plugin for it.
 */
async function smMatchSavePlugins(saveNames) {
  const registry = await smLoadPluginRegistry();
  const allData  = (window.allData || {});
  const localId  = window.DataLoader?.LOCAL_PLUGIN_ID || '__local_builds__';
  const loadedEntries = Object.entries(allData).filter(([id]) => id !== localId);

  const matched   = [];
  const unmatched = [];

  for (const saveName of saveNames) {
    const normSave       = _smNormalisePluginName(saveName);
    const normSaveStrip  = _smNormalisePluginName(_smStripBranchSuffix(saveName));
    const normSaveMain   = _smNormalisePluginName(_smWithMainSuffix(saveName));

    let foundEntry = null;
    let matchedBy  = null;

    // 1 — Direct match against outputName (the literal data/<pluginName> folder name)
    foundEntry = loadedEntries.find(([outputName]) =>
      _smNormalisePluginName(outputName) === normSave
    );
    if (foundEntry) matchedBy = 'folder-name';

    // 2 — Match allowing a "-main"/"-master" suffix on either side
    if (!foundEntry) {
      foundEntry = loadedEntries.find(([outputName]) => {
        const normOutput      = _smNormalisePluginName(outputName);
        const normOutputStrip = _smNormalisePluginName(_smStripBranchSuffix(outputName));
        return normOutput === normSaveMain || normOutputStrip === normSave || normOutputStrip === normSaveStrip;
      });
      if (foundEntry) matchedBy = 'folder-name-main-suffix';
    }

    // 3 — Match against the plugin's display label (displayPluginName / displayName / name)
    if (!foundEntry) {
      foundEntry = loadedEntries.find(([, data]) =>
        _smNormalisePluginName(_smDisplayLabel(data)) === normSave
      );
      if (foundEntry) matchedBy = 'display-name';
    }

    // 4 — Registry fallback: save name → plugins.json → repository → repo slug
    if (!foundEntry) {
      const regEntry = registry.find(r => _smNormalisePluginName(r.name) === normSave);
      if (regEntry) {
        const targetSlug = _smRepoSlug(regEntry.repository);
        foundEntry = loadedEntries.find(([outputName]) =>
          targetSlug && outputName.toLowerCase().includes(targetSlug)
        );
        if (!foundEntry) {
          // Also try matching the registry entry's own name against sourceName
          foundEntry = loadedEntries.find(([, data]) =>
            _smNormalisePluginName(data.sourceName) === normSave
          );
        }
        if (foundEntry) matchedBy = 'registry';
      } else if (!foundEntry) {
        unmatched.push({ saveName, reason: 'not-in-registry' });
        continue;
      }
    }

    if (foundEntry) {
      const [outputName, data] = foundEntry;
      matched.push({
        saveName,
        outputName,
        sourceName: data.sourceName || outputName,
        displayName: _smDisplayLabel(data) || outputName,
        matchedBy,
      });
    } else {
      unmatched.push({ saveName, reason: 'not-loaded' });
    }
  }

  return { matched, unmatched };
}

/**
 * Activates the matched plugins (plus Local Builds, handled automatically
 * by DataLoader.setActivePlugins) via the existing plugin system, so the
 * Ship Builder / Data Viewer picks them up exactly as if chosen by hand
 * through the plugin picker.
 */
function smActivateMatchedPlugins(matched) {
  if (!matched.length) return false;
  if (!window.DataLoader || typeof window.DataLoader.setActivePlugins !== 'function') {
    console.warn('[saveManager] DataLoader.setActivePlugins is not available on this page.');
    return false;
  }
  const outputNames = matched.map(m => m.outputName);
  window.DataLoader.setActivePlugins(outputNames);
  return true;
}

// ═══════════════════════════════════════════════════════════
//  BOOTSTRAP — restore last-open save on page load
// ═══════════════════════════════════════════════════════════

function smBootstrap() {
  renderSavesLibrary();

  const curId = smGetCurrentId();
  if (curId) {
    const data = smGetSaveData(curId);
    if (data) {
      parsedSave = data;
      currentSaveId = curId;
      renderResults();
      return;
    }
    // Pointer referenced a save that no longer exists in storage — clear it.
    smClearCurrentId();
  }
}

// ═══════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════

let _toastTimer = null;
function toast(msg, type = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ═══════════════════════════════════════════════════════════
//  FILE HANDLING / UPLOAD
// ═══════════════════════════════════════════════════════════

const fileInput = el('fileInput');
const dropzone  = el('dropzone');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

['dragover', 'dragenter'].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--c-accent)';
    dropzone.style.background = 'rgba(59,130,246,0.10)';
  })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.style.borderColor = '';
    dropzone.style.background = '';
  })
);
dropzone.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

function showError(msg) {
  const box = el('errorBox');
  box.textContent = msg;
  box.classList.remove('hidden');
}
function clearError() {
  el('errorBox').classList.add('hidden');
}

async function handleFile(file) {
  clearError();
  if (!file.name.toLowerCase().endsWith('.txt')) {
    showError('That doesn\u2019t look like a .txt save file. Endless Sky save files are exported as plain text.');
    return;
  }
  try {
    const text = await file.text();
    const parsed = parseESSaveFile(text); // from esSaveParser.js
    if (!parsed.ships.length && !parsed.pilot.name) {
      showError('No pilot or ship data was found in this file. Make sure it\u2019s an unmodified Endless Sky save.');
      return;
    }

    const baseName = file.name.replace(/\.txt$/i, '');
    const id = smAddSave(parsed, baseName);

    parsedSave    = parsed;
    currentSaveId = id;

    fileInput.value = '';
    renderSavesLibrary();
    renderResults();
    toast('Save file loaded — ' + parsed.ships.length + ' ship(s) found.', 'success');
  } catch (err) {
    showError('Could not parse this file: ' + err.message);
    console.error(err);
  }
}

// ═══════════════════════════════════════════════════════════
//  SAVES LIBRARY (list of stored saves + switching)
// ═══════════════════════════════════════════════════════════

function renderSavesLibrary() {
  const wrap = el('savesLibrary');
  const registry = smGetRegistry();

  if (!registry.length) {
    wrap.innerHTML = `<div class="ld-empty" style="padding:10px 0;">No saves stored yet — upload one below.</div>`;
    return;
  }

  wrap.innerHTML = registry
    .slice()
    .sort((a, b) => b.importedAt - a.importedAt)
    .map(s => {
      const isCurrent = s.id === currentSaveId;
      return `<div class="list-row" data-save-id="${esc(s.id)}" style="${isCurrent ? 'border-color:var(--c-accent); background:rgba(59,130,246,0.10);' : ''} margin-bottom:8px; cursor:pointer;">
        <span class="list-row__label">
          ${esc(s.label)}
          ${isCurrent ? '<span style="margin-left:8px; font-size:0.72rem; background:var(--c-success); color:var(--c-success-text); padding:2px 8px; border-radius:10px; font-weight:600;">Current</span>' : ''}
        </span>
        <span style="font-size:0.78rem; color:var(--c-text-dim); margin-right:8px;">${esc(formatImportedAt(s.importedAt))}</span>
        <button class="btn-remove sm-delete-btn" data-save-id="${esc(s.id)}" title="Delete this save">✕</button>
      </div>`;
    })
    .join('');

  wrap.querySelectorAll('.list-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.sm-delete-btn')) return; // handled separately
      switchToSave(row.dataset.saveId);
    });
  });
  wrap.querySelectorAll('.sm-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      confirmDeleteSave(btn.dataset.saveId);
    });
  });
}

function formatImportedAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function switchToSave(id) {
  if (id === currentSaveId) return;
  const data = smGetSaveData(id);
  if (!data) {
    toast('That save could not be loaded — it may have been removed.', 'danger');
    renderSavesLibrary();
    return;
  }
  parsedSave    = data;
  currentSaveId = id;
  smSetCurrentId(id);
  renderSavesLibrary();
  renderResults();
  toast('Switched save.', 'success');
}

function confirmDeleteSave(id) {
  const registry = smGetRegistry();
  const entry = registry.find(s => s.id === id);
  const label = entry ? entry.label : 'this save';
  if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;

  const wasCurrent = id === currentSaveId;
  smRemoveSave(id);

  if (wasCurrent) {
    parsedSave    = null;
    currentSaveId = null;
    el('results').classList.add('hidden');
    el('resultButtons').querySelectorAll('button').forEach(b => b.classList.add('hidden'));
  }

  renderSavesLibrary();
  toast('Save removed.', 'success');
}

// ═══════════════════════════════════════════════════════════
//  RENDERING — RESULTS
// ═══════════════════════════════════════════════════════════

function renderResults() {
  el('exportJsonBtn').classList.remove('hidden');
  el('removeSaveBtn').classList.remove('hidden');
  el('results').classList.remove('hidden');

  el('pilotName').textContent = '👤 ' + (parsedSave.pilot.name || 'Unnamed Pilot');
  const loc = [parsedSave.pilot.planet, parsedSave.pilot.system].filter(Boolean).join(', ');
  el('pilotMeta').textContent = [
    loc ? 'Location: ' + loc : null,
    parsedSave.pilot.date ? 'Date: ' + formatDate(parsedSave.pilot.date) : null,
    parsedSave.pilot.playtime ? 'Played: ' + formatPlaytime(parsedSave.pilot.playtime) : null,
  ].filter(Boolean).join('   ·   ');

  renderStatStrip();
  renderFleetGrid();
  renderCargoStorage();
  renderAccountLicenses();
  renderPluginsPanel();
}

function formatDate(d) {
  if (!d) return '—';
  const parts = d.trim().split(/\s+/);
  if (parts.length === 3) {
    const [day, month, year] = parts;
    const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${day} ${months[parseInt(month)] || month} ${year}`;
  }
  return d;
}
function formatPlaytime(seconds) {
  if (!seconds) return '—';
  return Math.floor(seconds / 3600).toLocaleString() + ' hrs';
}
function fmtNum(n) {
  if (n == null) return '—';
  return Math.round(n).toLocaleString();
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderStatStrip() {
  const ships = parsedSave.ships;
  const active = ships.filter(s => !s._parked).length;
  const parked = ships.length - active;
  const totalOutfits = ships.reduce((sum, s) => sum + s.outfits.reduce((a, o) => a + (o.count || 1), 0), 0);

  const cells = [
    { label: 'Credits', value: (parsedSave.account.credits || 0).toLocaleString() },
    { label: 'Combat Score', value: (parsedSave.account.score || 0).toLocaleString() },
    { label: 'Ships', value: ships.length },
    { label: 'Active', value: active },
    { label: 'Parked', value: parked },
    { label: 'Outfits Carried', value: totalOutfits },
    { label: 'Licenses', value: parsedSave.licenses.length },
  ];
  el('statStrip').innerHTML = cells.map(c => `
    <div class="stat-card">
      <div class="stat-value">${esc(String(c.value))}</div>
      <div class="stat-label">${esc(c.label)}</div>
    </div>`).join('');
}

function getFilteredSortedShips() {
  let ships = parsedSave.ships.map((s, i) => ({ ship: s, idx: i }));

  if (activeFilter) {
    const q = activeFilter.toLowerCase();
    ships = ships.filter(({ ship }) =>
      (ship._customName || '').toLowerCase().includes(q) ||
      (ship._modelName || '').toLowerCase().includes(q) ||
      (ship._system || '').toLowerCase().includes(q) ||
      (ship._planet || '').toLowerCase().includes(q)
    );
  }

  switch (activeSort) {
    case 'name':   ships.sort((a, b) => (a.ship._customName || '').localeCompare(b.ship._customName || '')); break;
    case 'model':  ships.sort((a, b) => (a.ship._modelName || '').localeCompare(b.ship._modelName || '')); break;
    case 'hull':   ships.sort((a, b) => (b.ship._hull || 0) - (a.ship._hull || 0)); break;
    case 'parked': ships.sort((a, b) => (b.ship._parked ? 1 : 0) - (a.ship._parked ? 1 : 0)); break;
  }
  return ships;
}

function renderFleetGrid() {
  const grid = el('fleetGrid');
  const list = getFilteredSortedShips();

  if (!list.length) {
    grid.innerHTML = `<div class="fleet-empty"><div class="fleet-empty__icon">🛸</div>
      <p>No ships match your search.</p></div>`;
    return;
  }

  grid.innerHTML = list.map(({ ship, idx }) => {
    const statusBadge = ship._parked
      ? `<span style="font-size:0.7rem; background:var(--c-warn); color:var(--c-warn-text); padding:2px 8px; border-radius:10px; font-weight:600; white-space:nowrap;">Parked</span>`
      : `<span style="font-size:0.7rem; background:var(--c-success); color:var(--c-success-text); padding:2px 8px; border-radius:10px; font-weight:600; white-space:nowrap;">Active</span>`;
    const outfitCount = ship.outfits.reduce((sum, o) => sum + (o.count || 1), 0);
    const loc = [ship._planet, ship._system].filter(Boolean).join(', ');

    return `<div class="fleet-card" data-idx="${idx}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div class="fleet-card__name">${esc(ship._customName || ship._modelName)}</div>
        ${statusBadge}
      </div>
      <div class="fleet-card__variant">${esc(ship._modelName)}</div>
      <div class="fleet-card__stats">
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Hull</div><div class="fleet-card__stat-value">${fmtNum(ship._hull)}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Shields</div><div class="fleet-card__stat-value">${fmtNum(ship._shields)}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Outfits</div><div class="fleet-card__stat-value">${outfitCount}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Crew</div><div class="fleet-card__stat-value">${ship._crew ?? '—'}</div></div>
      </div>
      <div class="internal-name" style="margin-top:12px; padding-bottom:0;">${esc(loc || '—')}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.fleet-card').forEach(card => {
    card.addEventListener('click', () => openShipModal(parseInt(card.dataset.idx)));
  });
}

function renderCargoStorage() {
  const cargoEntries = Object.entries(parsedSave.cargo.outfits || {});
  el('cargoList').innerHTML = cargoEntries.length
    ? `<div class="ld-pills">${cargoEntries.map(([name, count]) =>
        `<span class="ld-pill">${esc(name)}${count > 1 ? ` ×${count}` : ''}</span>`).join('')}</div>`
    : `<div class="ld-empty">No cargo carried.</div>`;

  const storage = parsedSave.storage || [];
  el('storageList').innerHTML = storage.length
    ? storage.map(s => {
        const entries = Object.entries(s.cargo.outfits || {});
        return `<div class="ld-plugin-block ld-plugin-active" style="margin-bottom:14px;">
          <div class="ld-plugin-header" style="cursor:default;">
            <span class="ld-plugin-name">${esc(s.planet)}</span>
            <span class="ld-plugin-badge" style="background:var(--c-success); color:var(--c-success-text);">${entries.length} item${entries.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="ld-plugin-content-wrapper">
            ${entries.length
              ? `<div class="ld-pills">${entries.map(([name, count]) =>
                  `<span class="ld-pill">${esc(name)}${count > 1 ? ` ×${count}` : ''}</span>`).join('')}</div>`
              : `<div class="ld-unused">Nothing stored here.</div>`}
          </div>
        </div>`;
      }).join('')
    : `<div class="ld-empty">No planetary storage recorded.</div>`;
}

function renderAccountLicenses() {
  const a = parsedSave.account;
  const cells = [
    { label: 'Credits', value: (a.credits || 0).toLocaleString() },
    { label: 'Combat Score', value: (a.score || 0).toLocaleString() },
    ...Object.entries(a.salaries || {}).map(([k, v]) => ({ label: 'Salary: ' + k, value: v.toLocaleString() + ' cr' })),
  ];
  el('accountGrid').innerHTML = cells.map(c => `
    <div class="attribute">
      <div class="attribute-name">${esc(c.label)}</div>
      <div class="attribute-value">${esc(String(c.value))}</div>
    </div>`).join('');

  el('licenseList').innerHTML = parsedSave.licenses.length
    ? parsedSave.licenses.map(l => `<span class="ld-pill">${esc(l)}</span>`).join('')
    : `<div class="ld-empty">No licenses recorded.</div>`;
}

// ═══════════════════════════════════════════════════════════
//  PLUGINS PANEL — match this save's plugin list against the
//  registry + currently loaded data, and offer to activate them.
// ═══════════════════════════════════════════════════════════

// Resolves once window.DataLoader has finished its initial load (or
// immediately if DataLoader isn't present at all / already ready).
// Without this, matching can run while remote plugin data is still being
// fetched, making every plugin look unmatched even though it's about to load.
function smWaitForDataLoader(timeoutMs = 15000) {
  return new Promise(resolve => {
    if (!window.DataLoader || typeof window.DataLoader.isReady !== 'function') {
      resolve(false); // no DataLoader on this page at all
      return;
    }
    if (window.DataLoader.isReady()) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    if (typeof window.DataLoader.onReady === 'function') {
      window.DataLoader.onReady(() => finish(true));
    }
    document.addEventListener('dataLoadError', () => finish(false), { once: true });
    setTimeout(() => finish(window.DataLoader.isReady ? window.DataLoader.isReady() : false), timeoutMs);
  });
}

async function renderPluginsPanel() {
  const box = el('pluginsPanel');
  if (!box) return;

  const names = parsedSave.plugins || [];
  if (!names.length) {
    box.innerHTML = `<div class="ld-empty">No plugins were recorded in this save.</div>`;
    return;
  }

  if (!window.DataLoader) {
    box.innerHTML = `<div class="ld-empty">Plugin data isn\u2019t available on this page (dataLoader.js isn\u2019t loaded), so plugins from this save can\u2019t be matched here.</div>`;
    return;
  }

  box.innerHTML = `<div class="ld-empty" style="padding:10px 0;">Loading plugin data\u2026</div>`;
  await smWaitForDataLoader();

  box.innerHTML = `<div class="ld-empty" style="padding:10px 0;">Checking plugins against loaded data…</div>`;

  const { matched, unmatched } = await smMatchSavePlugins(names);

  const matchedHtml = matched.length
    ? `<div class="ld-pills" style="margin-bottom:10px;">${matched.map(m =>
        `<span class="ld-pill" title="${esc(m.outputName)}">✅ ${esc(m.displayName)}</span>`).join('')}</div>`
    : `<div class="ld-empty" style="padding:4px 0 10px;">None of this save's plugins are currently loaded.</div>`;

  const unmatchedHtml = unmatched.length
    ? `<div class="ld-pills">${unmatched.map(u =>
        `<span class="ld-pill" style="opacity:0.6;" title="${u.reason === 'not-in-registry' ? 'Not found in the plugin registry' : 'Found in the registry, but no data is loaded for it'}">⚠️ ${esc(u.saveName)}</span>`).join('')}</div>`
    : '';

  box.innerHTML = `
    <div class="ad-section-title" style="margin-top:0;">Installed in this save (${names.length})</div>
    ${matchedHtml}
    ${unmatched.length ? `
      <div class="ad-section-title">Could not match (${unmatched.length})</div>
      ${unmatchedHtml}
      <p style="font-size:0.8rem; color:var(--c-text-dim); margin-top:8px;">
        These are listed in the save but either aren't in the plugin registry, or no data is currently loaded for them on this page.
      </p>
    ` : ''}
    <div class="button-group" style="margin-top:16px;">
      ${matched.length ? `<button class="btn btn-primary" id="activatePluginsBtn">Activate ${matched.length} matched plugin${matched.length !== 1 ? 's' : ''}</button>` : ''}
      <button class="btn btn-secondary" id="recheckPluginsBtn">Re-check plugins</button>
    </div>
  `;

  const activateBtn = el('activatePluginsBtn');
  if (activateBtn) {
    activateBtn.addEventListener('click', () => {
      const ok = smActivateMatchedPlugins(matched);
      if (ok) {
        toast('Activated ' + matched.length + ' plugin(s) from this save.', 'success');
      } else {
        toast('Could not activate plugins — plugin system isn\u2019t available on this page.', 'danger');
      }
    });
  }

  const recheckBtn = el('recheckPluginsBtn');
  if (recheckBtn) {
    recheckBtn.addEventListener('click', () => renderPluginsPanel());
  }
}

// ═══════════════════════════════════════════════════════════
//  SHIP DETAIL MODAL
// ═══════════════════════════════════════════════════════════

function openShipModal(idx) {
  const ship = parsedSave.ships[idx];
  const a = ship.attributes || {};

  el('modalShipName').textContent = ship._customName || ship._modelName;
  el('modalShipSub').textContent = `${ship._modelName} · ${ship._parked ? 'Parked' : 'Active'} at ${ship._planet || 'unknown'}${ship._system ? ', ' + ship._system : ''}`;

  const quickStats = [
    { label: 'Hull', value: fmtNum(ship._hull) },
    { label: 'Shields', value: fmtNum(ship._shields) },
    { label: 'Fuel', value: fmtNum(ship._fuel) },
    { label: 'Crew', value: ship._crew ?? '—' },
    { label: 'Guns', value: ship.guns.length },
    { label: 'Turrets', value: ship.turrets.length },
    { label: 'Fighter Bays', value: ship.fighters.length },
    { label: 'Drone Bays', value: ship.drones.length },
  ];

  const outfitChips = ship.outfits.length
    ? `<div class="ld-pills">${ship.outfits.map(o =>
        `<span class="ld-pill">${esc(o.name)}${o.count > 1 ? ` ×${o.count}` : ''}</span>`).join('')}</div>`
    : `<div class="ld-empty">No outfits installed.</div>`;

  const gunList    = ship.guns.length    ? ship.guns.map(g => g.over ? esc(g.over) : '(empty mount)').join(', ') : null;
  const turretList = ship.turrets.length ? ship.turrets.map(t => t.over ? esc(t.over) : '(empty mount)').join(', ') : null;

  const attrKeys = Object.keys(a).filter(k => k !== 'licenses');
  const attrCells = attrKeys.map(k => `
    <div class="attribute">
      <div class="attribute-name">${esc(k)}</div>
      <div class="attribute-value">${esc(String(a[k]))}</div>
    </div>`).join('');

  const leakRows = ship.leaks.length
    ? ship.leaks.map(l => `<div class="ad-row"><span class="ad-label">${esc(l.name)}</span><span class="ad-value">open ${l.openChance}% · spread ${l.spreadChance}%</span></div>`).join('')
    : null;
  const explodeStr      = ship.explode.length ? ship.explode.map(e => `${esc(e.name)} ×${e.count}`).join(', ') : null;
  const finalExplodeStr = ship.finalExplode.length ? ship.finalExplode.map(e => `${esc(e.name)} ×${e.count}`).join(', ') : null;

  el('modalBody').innerHTML = `
    <div class="attribute-grid" style="margin-bottom:25px;">
      ${quickStats.map(q => `
        <div class="attribute">
          <div class="attribute-name">${esc(q.label)}</div>
          <div class="attribute-value">${esc(String(q.value))}</div>
        </div>`).join('')}
    </div>

    <div class="ad-section-title">Hardpoints</div>
    ${gunList ? `<div class="ad-row"><span class="ad-label">Guns</span><span class="ad-value">${gunList}</span></div>` : ''}
    ${turretList ? `<div class="ad-row"><span class="ad-label">Turrets</span><span class="ad-value">${turretList}</span></div>` : ''}
    ${(!gunList && !turretList) ? `<div class="ld-empty">None recorded.</div>` : ''}

    <div class="ad-section-title">Outfits</div>
    ${outfitChips}

    ${attrKeys.length ? `
      <div class="ad-section-title">Attributes</div>
      <div class="attribute-grid">${attrCells}</div>
    ` : ''}

    ${(leakRows || explodeStr || finalExplodeStr) ? `
      <div class="ad-section-title">Effects</div>
      ${leakRows || ''}
      ${explodeStr ? `<div class="ad-row"><span class="ad-label">Explode</span><span class="ad-value">${explodeStr}</span></div>` : ''}
      ${finalExplodeStr ? `<div class="ad-row"><span class="ad-label">Final explode</span><span class="ad-value">${finalExplodeStr}</span></div>` : ''}
    ` : ''}
  `;

  el('shipModal').classList.add('active');
}

el('modalCloseBtn').addEventListener('click', () => el('shipModal').classList.remove('active'));
el('shipModal').addEventListener('click', e => {
  if (e.target === el('shipModal')) el('shipModal').classList.remove('active');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') el('shipModal').classList.remove('active');
});

// ═══════════════════════════════════════════════════════════
//  SEARCH / SORT CONTROLS
// ═══════════════════════════════════════════════════════════

el('searchInput').addEventListener('input', e => {
  activeFilter = e.target.value;
  renderFleetGrid();
});
el('sortSelect').addEventListener('change', e => {
  activeSort = e.target.value;
  renderFleetGrid();
});

// ═══════════════════════════════════════════════════════════
//  RESULT BUTTONS — export / remove
// ═══════════════════════════════════════════════════════════

el('exportJsonBtn').addEventListener('click', () => {
  if (!parsedSave) return;
  const blob = new Blob([JSON.stringify(parsedSave, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (parsedSave.pilot.name || 'fleet').replace(/\s+/g, '_') + '_parsed.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported parsed JSON.', 'success');
});

el('removeSaveBtn').addEventListener('click', () => {
  if (!currentSaveId) return;
  confirmDeleteSave(currentSaveId);
});

// ═══════════════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════════════

document.querySelectorAll('#resultTabs .tab').forEach(tabEl => {
  tabEl.addEventListener('click', () => {
    document.querySelectorAll('#resultTabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    tabEl.classList.add('active');
    el('tab-' + tabEl.dataset.tab).classList.remove('hidden');
  });
});

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', smBootstrap);
