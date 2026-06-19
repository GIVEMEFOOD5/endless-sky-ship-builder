'use strict';

// ═══════════════════════════════════════════════════════════
//  saveManager.js
//  Depends on: esSaveParser.js  (must be loaded first)
//
//  localStorage keys:
//    esSaveReader_registry      — JSON array of save metadata entries:
//                                   { id, label, pilotName, importedAt }
//    esSaveReader_save_<id>     — full parsed save object for that id
//    esSaveReader_currentSave   — string id of the currently active save
// ═══════════════════════════════════════════════════════════

// ── Storage keys ─────────────────────────────────────────────────────────────
const LS_REGISTRY    = 'esSaveReader_registry';
const LS_SAVE_PREFIX = 'esSaveReader_save_';
const LS_CURRENT     = 'esSaveReader_currentSave';

// ── In-memory state ───────────────────────────────────────────────────────────
let parsedSave  = null;   // currently displayed save object
let currentId   = null;   // id of the currently active save
let activeFilter = '';
let activeSort   = 'default';

// ── Helpers ───────────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n) {
  if (n == null) return '\u2014';
  return Math.round(n).toLocaleString();
}

function formatDate(d) {
  if (!d) return '\u2014';
  const parts = d.trim().split(/\s+/);
  if (parts.length === 3) {
    const [day, month, year] = parts;
    const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${day} ${months[parseInt(month)] || month} ${year}`;
  }
  return d;
}

function formatPlaytime(seconds) {
  if (!seconds) return '\u2014';
  return Math.floor(seconds / 3600).toLocaleString() + ' hrs';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, type = '') {
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── Error display ─────────────────────────────────────────────────────────────
function showError(msg) {
  const box = el('errorBox');
  box.textContent = msg;
  box.classList.remove('hidden');
}
function clearError() {
  el('errorBox').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════
//  LOCAL STORAGE — registry & saves
// ═══════════════════════════════════════════════════════════

function loadRegistry() {
  try {
    return JSON.parse(localStorage.getItem(LS_REGISTRY) || '[]');
  } catch { return []; }
}

function saveRegistry(registry) {
  try { localStorage.setItem(LS_REGISTRY, JSON.stringify(registry)); } catch (e) {
    toast('localStorage full — could not save registry.', 'danger');
  }
}

function loadSaveById(id) {
  try {
    const raw = localStorage.getItem(LS_SAVE_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function persistSave(id, data) {
  try {
    localStorage.setItem(LS_SAVE_PREFIX + id, JSON.stringify(data));
    return true;
  } catch (e) {
    toast('localStorage full — save could not be stored.', 'danger');
    return false;
  }
}

function deleteSaveById(id) {
  localStorage.removeItem(LS_SAVE_PREFIX + id);
  const registry = loadRegistry().filter(r => r.id !== id);
  saveRegistry(registry);
  if (localStorage.getItem(LS_CURRENT) === id) {
    localStorage.removeItem(LS_CURRENT);
  }
}

function setCurrentId(id) {
  currentId = id;
  if (id) {
    localStorage.setItem(LS_CURRENT, id);
  } else {
    localStorage.removeItem(LS_CURRENT);
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ═══════════════════════════════════════════════════════════
//  FILE HANDLING
// ═══════════════════════════════════════════════════════════

async function handleFile(file) {
  clearError();
  if (!file.name.toLowerCase().endsWith('.txt')) {
    showError('That doesn\u2019t look like a .txt save file. Endless Sky save files are exported as plain text.');
    return;
  }
  try {
    const text = await file.text();
    const parsed = parseESSaveFile(text);
    if (!parsed.ships.length && !parsed.pilot.name) {
      showError('No pilot or ship data was found in this file. Make sure it\u2019s an unmodified Endless Sky save.');
      return;
    }

    // Build registry entry
    const id    = generateId();
    const label = parsed.pilot.name || file.name.replace(/\.txt$/i, '') || 'Unknown Pilot';

    // Check for duplicate pilot name — offer to overwrite
    const registry = loadRegistry();
    const existing = registry.find(r => r.pilotName === parsed.pilot.name && parsed.pilot.name);
    if (existing) {
      if (!confirm(`A save for "${parsed.pilot.name}" already exists. Replace it with this newer file?`)) return;
      deleteSaveById(existing.id);
    }

    // Store
    const ok = persistSave(id, parsed);
    if (!ok) return;

    const entry = {
      id,
      label,
      pilotName: parsed.pilot.name || '',
      importedAt: new Date().toISOString(),
    };
    const updatedRegistry = loadRegistry();
    updatedRegistry.push(entry);
    saveRegistry(updatedRegistry);

    // Switch to it
    switchToSave(id);
    toast(`Loaded \u201c${label}\u201d \u2014 ${parsed.ships.length} ship(s) found.`, 'success');

    // Reset file input so the same file can be re-uploaded
    el('fileInput').value = '';
  } catch (err) {
    showError('Could not parse this file: ' + err.message);
    console.error(err);
  }
}

// ═══════════════════════════════════════════════════════════
//  SAVE SWITCHING
// ═══════════════════════════════════════════════════════════

function switchToSave(id) {
  const data = loadSaveById(id);
  if (!data) {
    toast('Could not load that save from storage.', 'danger');
    return;
  }
  parsedSave = data;
  setCurrentId(id);
  activeFilter = '';
  activeSort   = 'default';
  el('searchInput').value  = '';
  el('sortSelect').value   = 'default';
  renderSavesLibrary();
  renderResults();
}

function removeCurrentSave() {
  if (!currentId) return;
  const registry = loadRegistry();
  const entry = registry.find(r => r.id === currentId);
  const name = entry ? entry.label : 'this save';
  if (!confirm(`Remove \u201c${name}\u201d from storage? This cannot be undone.`)) return;
  deleteSaveById(currentId);
  parsedSave = null;
  currentId  = null;
  el('results').classList.add('hidden');
  el('exportJsonBtn').classList.add('hidden');
  el('removeSaveBtn').classList.add('hidden');
  renderSavesLibrary();
  toast(`\u201c${name}\u201d removed.`, 'danger');
}

// ═══════════════════════════════════════════════════════════
//  SAVES LIBRARY (the list of stored saves with switch/delete)
// ═══════════════════════════════════════════════════════════

function renderSavesLibrary() {
  const container = el('savesLibrary');
  if (!container) return;
  const registry = loadRegistry();

  if (!registry.length) {
    container.innerHTML = `<div class="ld-empty" style="padding:12px 0 4px;">No saves stored yet. Upload a file below to get started.</div>`;
    return;
  }

  container.innerHTML = registry.map(entry => {
    const isActive = entry.id === currentId;
    const date = new Date(entry.importedAt);
    const dateStr = isNaN(date) ? '' : date.toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });

    return `
      <div class="list-row" style="justify-content:space-between; flex-wrap:nowrap; gap:12px; margin-bottom:6px;
        ${isActive ? 'border-color:var(--c-accent); background:rgba(59,130,246,0.08);' : ''}">
        <div style="display:flex; flex-direction:column; gap:2px; min-width:0; flex:1;">
          <span style="font-size:0.92rem; font-weight:600; color:${isActive ? 'var(--c-accent-text)' : 'var(--c-text-mid)'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${isActive ? '\u25B6\uFE0E ' : ''}${esc(entry.label)}
          </span>
          <span style="font-size:0.75rem; color:var(--c-text-dim);">Imported ${esc(dateStr)}</span>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0; align-items:center;">
          ${!isActive ? `<button class="btn btn-secondary" style="padding:6px 14px; font-size:0.82rem;"
            onclick="switchToSave('${entry.id}')">View</button>` : `<span style="font-size:0.75rem; color:var(--c-accent-text); font-weight:600;">Active</span>`}
          <button class="btn-remove" onclick="confirmDeleteSave('${entry.id}', '${esc(entry.label).replace(/'/g, "\\'")}')">Remove</button>
        </div>
      </div>`;
  }).join('');
}

function confirmDeleteSave(id, label) {
  if (!confirm(`Remove \u201c${label}\u201d from storage? This cannot be undone.`)) return;
  deleteSaveById(id);
  if (id === currentId) {
    parsedSave = null;
    currentId  = null;
    el('results').classList.add('hidden');
    el('exportJsonBtn').classList.add('hidden');
    el('removeSaveBtn').classList.add('hidden');
  }
  renderSavesLibrary();
  toast(`\u201c${label}\u201d removed.`, 'danger');
}

// ═══════════════════════════════════════════════════════════
//  RESULTS RENDERING
// ═══════════════════════════════════════════════════════════

function renderResults() {
  el('exportJsonBtn').classList.remove('hidden');
  el('removeSaveBtn').classList.remove('hidden');
  el('results').classList.remove('hidden');

  el('pilotName').textContent = '\uD83D\uDC64 ' + (parsedSave.pilot.name || 'Unnamed Pilot');
  const loc = [parsedSave.pilot.planet, parsedSave.pilot.system].filter(Boolean).join(', ');
  el('pilotMeta').textContent = [
    loc ? 'Location: ' + loc : null,
    parsedSave.pilot.date ? 'Date: ' + formatDate(parsedSave.pilot.date) : null,
    parsedSave.pilot.playtime ? 'Played: ' + formatPlaytime(parsedSave.pilot.playtime) : null,
  ].filter(Boolean).join('   \u00B7   ');

  renderStatStrip();
  renderFleetGrid();
  renderCargoStorage();
  renderAccountLicenses();

  // Reset to fleet tab
  document.querySelectorAll('#resultTabs .tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  el('resultTabs').querySelector('[data-tab="fleet"]').classList.add('active');
  el('tab-fleet').classList.remove('hidden');
}

// ── Stat strip ────────────────────────────────────────────────────────────────
function renderStatStrip() {
  const ships = parsedSave.ships;
  const active = ships.filter(s => !s._parked).length;
  const parked = ships.length - active;
  const totalOutfits = ships.reduce((sum, s) => sum + s.outfits.reduce((a, o) => a + (o.count || 1), 0), 0);

  const cells = [
    { label: 'Credits',          value: (parsedSave.account.credits || 0).toLocaleString() },
    { label: 'Combat Score',     value: (parsedSave.account.score   || 0).toLocaleString() },
    { label: 'Ships',            value: ships.length },
    { label: 'Active',           value: active },
    { label: 'Parked',           value: parked },
    { label: 'Outfits Carried',  value: totalOutfits },
    { label: 'Licenses',         value: parsedSave.licenses.length },
  ];
  el('statStrip').innerHTML = cells.map(c => `
    <div class="stat-card">
      <div class="stat-value">${esc(String(c.value))}</div>
      <div class="stat-label">${esc(c.label)}</div>
    </div>`).join('');
}

// ── Fleet grid ────────────────────────────────────────────────────────────────
function getFilteredSortedShips() {
  let ships = parsedSave.ships.map((s, i) => ({ ship: s, idx: i }));

  if (activeFilter) {
    const q = activeFilter.toLowerCase();
    ships = ships.filter(({ ship }) =>
      (ship._customName || '').toLowerCase().includes(q) ||
      (ship._modelName  || '').toLowerCase().includes(q) ||
      (ship._system     || '').toLowerCase().includes(q) ||
      (ship._planet     || '').toLowerCase().includes(q)
    );
  }

  switch (activeSort) {
    case 'name':   ships.sort((a, b) => (a.ship._customName||'').localeCompare(b.ship._customName||'')); break;
    case 'model':  ships.sort((a, b) => (a.ship._modelName ||'').localeCompare(b.ship._modelName ||'')); break;
    case 'hull':   ships.sort((a, b) => (b.ship._hull  || 0) - (a.ship._hull  || 0)); break;
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
      ? `<span style="font-size:0.7rem;background:var(--c-warn);color:var(--c-warn-text);padding:2px 8px;border-radius:10px;font-weight:600;white-space:nowrap;">Parked</span>`
      : `<span style="font-size:0.7rem;background:var(--c-success);color:var(--c-success-text);padding:2px 8px;border-radius:10px;font-weight:600;white-space:nowrap;">Active</span>`;
    const outfitCount = ship.outfits.reduce((sum, o) => sum + (o.count || 1), 0);
    const loc = [ship._planet, ship._system].filter(Boolean).join(', ');

    return `<div class="fleet-card" data-idx="${idx}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div class="fleet-card__name">${esc(ship._customName || ship._modelName)}</div>
        ${statusBadge}
      </div>
      <div class="fleet-card__variant">${esc(ship._modelName)}</div>
      <div class="fleet-card__stats">
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Hull</div><div class="fleet-card__stat-value">${fmtNum(ship._hull)}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Shields</div><div class="fleet-card__stat-value">${fmtNum(ship._shields)}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Outfits</div><div class="fleet-card__stat-value">${outfitCount}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Crew</div><div class="fleet-card__stat-value">${ship._crew ?? '\u2014'}</div></div>
      </div>
      <div class="internal-name" style="margin-top:12px;padding-bottom:0;">${esc(loc || '\u2014')}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.fleet-card').forEach(card => {
    card.addEventListener('click', () => openShipModal(parseInt(card.dataset.idx)));
  });
}

// ── Cargo & storage ───────────────────────────────────────────────────────────
function renderCargoStorage() {
  const cargoEntries = Object.entries(parsedSave.cargo.outfits || {});
  el('cargoList').innerHTML = cargoEntries.length
    ? `<div class="ld-pills">${cargoEntries.map(([name, count]) =>
        `<span class="ld-pill">${esc(name)}${count > 1 ? ` \xD7${count}` : ''}</span>`).join('')}</div>`
    : `<div class="ld-empty">No cargo carried.</div>`;

  const storage = parsedSave.storage || [];
  el('storageList').innerHTML = storage.length
    ? storage.map(s => {
        const entries = Object.entries(s.cargo.outfits || {});
        return `<div class="ld-plugin-block ld-plugin-active" style="margin-bottom:14px;">
          <div class="ld-plugin-header" style="cursor:default;">
            <span class="ld-plugin-name">${esc(s.planet)}</span>
            <span class="ld-plugin-badge" style="background:var(--c-success);color:var(--c-success-text);">${entries.length} item${entries.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="ld-plugin-content-wrapper">
            ${entries.length
              ? `<div class="ld-pills">${entries.map(([name, count]) =>
                  `<span class="ld-pill">${esc(name)}${count > 1 ? ` \xD7${count}` : ''}</span>`).join('')}</div>`
              : `<div class="ld-unused">Nothing stored here.</div>`}
          </div>
        </div>`;
      }).join('')
    : `<div class="ld-empty">No planetary storage recorded.</div>`;
}

// ── Account & licenses ────────────────────────────────────────────────────────
function renderAccountLicenses() {
  const a = parsedSave.account;
  const cells = [
    { label: 'Credits',      value: (a.credits || 0).toLocaleString() },
    { label: 'Combat Score', value: (a.score   || 0).toLocaleString() },
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
//  SHIP DETAIL MODAL
// ═══════════════════════════════════════════════════════════

function openShipModal(idx) {
  const ship = parsedSave.ships[idx];
  const a    = ship.attributes || {};

  el('modalShipName').textContent = ship._customName || ship._modelName;
  el('modalShipSub').textContent  = `${ship._modelName} \u00B7 ${ship._parked ? 'Parked' : 'Active'} at ${ship._planet || 'unknown'}${ship._system ? ', ' + ship._system : ''}`;

  const quickStats = [
    { label: 'Hull',         value: fmtNum(ship._hull) },
    { label: 'Shields',      value: fmtNum(ship._shields) },
    { label: 'Fuel',         value: fmtNum(ship._fuel) },
    { label: 'Crew',         value: ship._crew ?? '\u2014' },
    { label: 'Guns',         value: ship.guns.length },
    { label: 'Turrets',      value: ship.turrets.length },
    { label: 'Fighter Bays', value: ship.fighters.length },
    { label: 'Drone Bays',   value: ship.drones.length },
  ];

  const outfitChips = ship.outfits.length
    ? `<div class="ld-pills">${ship.outfits.map(o =>
        `<span class="ld-pill">${esc(o.name)}${o.count > 1 ? ` \xD7${o.count}` : ''}</span>`).join('')}</div>`
    : `<div class="ld-empty">No outfits installed.</div>`;

  const gunList    = ship.guns.length    ? ship.guns.map(g    => g.over ? esc(g.over)    : '(empty mount)').join(', ') : null;
  const turretList = ship.turrets.length ? ship.turrets.map(t => t.over ? esc(t.over)    : '(empty mount)').join(', ') : null;

  const attrKeys  = Object.keys(a).filter(k => k !== 'licenses');
  const attrCells = attrKeys.map(k => `
    <div class="attribute">
      <div class="attribute-name">${esc(k)}</div>
      <div class="attribute-value">${esc(String(a[k]))}</div>
    </div>`).join('');

  const leakRows = ship.leaks.length
    ? ship.leaks.map(l =>
        `<div class="ad-row"><span class="ad-label">${esc(l.name)}</span><span class="ad-value">open ${l.openChance}% \u00B7 spread ${l.spreadChance}%</span></div>`
      ).join('')
    : null;
  const explodeStr      = ship.explode.length      ? ship.explode.map(e      => `${esc(e.name)} \xD7${e.count}`).join(', ') : null;
  const finalExplodeStr = ship.finalExplode.length ? ship.finalExplode.map(e => `${esc(e.name)} \xD7${e.count}`).join(', ') : null;

  el('modalBody').innerHTML = `
    <div class="attribute-grid" style="margin-bottom:25px;">
      ${quickStats.map(q => `
        <div class="attribute">
          <div class="attribute-name">${esc(q.label)}</div>
          <div class="attribute-value">${esc(String(q.value))}</div>
        </div>`).join('')}
    </div>

    <div class="ad-section-title">Hardpoints</div>
    ${gunList    ? `<div class="ad-row"><span class="ad-label">Guns</span><span class="ad-value">${gunList}</span></div>` : ''}
    ${turretList ? `<div class="ad-row"><span class="ad-label">Turrets</span><span class="ad-value">${turretList}</span></div>` : ''}
    ${!gunList && !turretList ? `<div class="ld-empty">None recorded.</div>` : ''}

    <div class="ad-section-title">Outfits</div>
    ${outfitChips}

    ${attrKeys.length ? `
      <div class="ad-section-title">Attributes</div>
      <div class="attribute-grid">${attrCells}</div>` : ''}

    ${leakRows || explodeStr || finalExplodeStr ? `
      <div class="ad-section-title">Effects</div>
      ${leakRows || ''}
      ${explodeStr      ? `<div class="ad-row"><span class="ad-label">Explode</span><span class="ad-value">${explodeStr}</span></div>` : ''}
      ${finalExplodeStr ? `<div class="ad-row"><span class="ad-label">Final explode</span><span class="ad-value">${finalExplodeStr}</span></div>` : ''}` : ''}
  `;

  el('shipModal').classList.add('active');
}

// ═══════════════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════════════

function exportCurrentSave() {
  if (!parsedSave) return;
  const blob = new Blob([JSON.stringify(parsedSave, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (parsedSave.pilot.name || 'fleet').replace(/\s+/g, '_') + '_parsed.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported parsed JSON.', 'success');
}

// ═══════════════════════════════════════════════════════════
//  INIT — wire up all DOM events on DOMContentLoaded
// ═══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

  // ── Dropzone / file input ───────────────────────────────
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
      dropzone.style.background  = 'rgba(59,130,246,0.10)';
    })
  );
  ['dragleave', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.style.borderColor = '';
      dropzone.style.background  = '';
    })
  );
  dropzone.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // ── Result action buttons ───────────────────────────────
  el('exportJsonBtn').addEventListener('click', exportCurrentSave);
  el('removeSaveBtn').addEventListener('click', removeCurrentSave);

  // ── Tab switching ───────────────────────────────────────
  document.querySelectorAll('#resultTabs .tab').forEach(tabEl => {
    tabEl.addEventListener('click', () => {
      document.querySelectorAll('#resultTabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      tabEl.classList.add('active');
      el('tab-' + tabEl.dataset.tab).classList.remove('hidden');
    });
  });

  // ── Search & sort ───────────────────────────────────────
  el('searchInput').addEventListener('input', e => {
    activeFilter = e.target.value;
    renderFleetGrid();
  });
  el('sortSelect').addEventListener('change', e => {
    activeSort = e.target.value;
    renderFleetGrid();
  });

  // ── Ship modal close ────────────────────────────────────
  el('modalCloseBtn').addEventListener('click', () => el('shipModal').classList.remove('active'));
  el('shipModal').addEventListener('click', e => {
    if (e.target === el('shipModal')) el('shipModal').classList.remove('active');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') el('shipModal').classList.remove('active');
  });

  // ── Restore state from localStorage ────────────────────
  renderSavesLibrary();

  const savedCurrentId = localStorage.getItem(LS_CURRENT);
  if (savedCurrentId) {
    const data = loadSaveById(savedCurrentId);
    if (data) {
      parsedSave = data;
      currentId  = savedCurrentId;
      el('exportJsonBtn').classList.remove('hidden');
      el('removeSaveBtn').classList.remove('hidden');
      renderResults();
    } else {
      // Saved id is stale — clear it
      localStorage.removeItem(LS_CURRENT);
    }
  }
});
