'use strict';

// ═══════════════════════════════════════════════════════════
//  shipBuilder.js
//  Three modes:
//    'new'    — create a ship from scratch
//    'edit'   — edit an existing parsed/saved ship
//    'outfit' — outfit an existing ship (starts on outfits tab)
// ═══════════════════════════════════════════════════════════

const SB_STORAGE_KEY = 'es_ship_builder_v4';

let sbFleet       = [];
let sbEditIdx     = -1;
let sbCurrentShip = null;
let sbMode        = 'new';

// Live data mirrors from DataViewer
let sbAllShips   = [];
let sbAllOutfits = [];
let sbAttrKeys   = [];  // sorted list of all known attribute keys

// ═══════════════════════════════════════════════════════════
//  PLUGIN SELECTOR
//  Self-contained implementation using DataLoader's API.
//  Mirrors the pattern in generalPluginStuff.js but is
//  scoped to the Ship Builder page only.
// ═══════════════════════════════════════════════════════════

// Snapshot taken when the picker opens — restored on Cancel
let _sbPluginPickerSnapshot = [];

/**
 * Render the active plugin list in #activePluginList.
 * Matches the sorter-row style used by generalPluginStuff.js.
 */
function sbRenderActivePluginList() {
  const box = document.getElementById('activePluginList');
  if (!box || !window.DataLoader) return;

  const active = window.DataLoader.getActivePlugins();
  const LOCAL  = window.DataLoader.LOCAL_PLUGIN_ID;

  if (!active.length) {
    box.innerHTML = '<span class="sorter-empty">No plugins selected.</span>';
    return;
  }

  box.innerHTML = '';

  active.forEach((outputName, idx) => {
    const isLocal = outputName === LOCAL;
    const allData = window.allData || {};
    const d       = allData[outputName];
    let label;
    if (isLocal) {
      label = '📦 Local Builds';
    } else if (d) {
      label = d.sourceName === d.displayName ? d.sourceName : `${d.sourceName} › ${d.displayName}`;
    } else {
      label = outputName;
    }

    const row = document.createElement('div');
    row.className = 'sorter-row' + (isLocal ? ' sorter-row--local' : '');
    row.dataset.plugin = outputName;

    const labelEl = document.createElement('span');
    labelEl.className   = 'sorter-label';
    labelEl.textContent = label;

    // Local Builds is always pinned first — no reorder/remove
    if (isLocal) {
      const pin = document.createElement('span');
      pin.className   = 'sorter-pin-badge';
      pin.textContent = '📌 pinned first';
      pin.title       = 'Local Builds always appears first';
      row.appendChild(labelEl);
      row.appendChild(pin);
      box.appendChild(row);
      return;
    }

    const localOffset     = active.includes(LOCAL) ? 1 : 0;
    const isFirstNonLocal = idx === localOffset;
    const isLastNonLocal  = idx === active.length - 1;

    const upBtn = document.createElement('button');
    upBtn.className   = 'sorter-move-btn';
    upBtn.textContent = '▲';
    upBtn.title       = 'Move up (higher priority)';
    upBtn.disabled    = isFirstNonLocal;
    upBtn.onclick = () => {
      const cur = [...window.DataLoader.getActivePlugins()];
      [cur[idx - 1], cur[idx]] = [cur[idx], cur[idx - 1]];
      window.DataLoader.setActivePlugins(cur);
    };

    const downBtn = document.createElement('button');
    downBtn.className   = 'sorter-move-btn';
    downBtn.textContent = '▼';
    downBtn.title       = 'Move down (lower priority)';
    downBtn.disabled    = isLastNonLocal;
    downBtn.onclick = () => {
      const cur = [...window.DataLoader.getActivePlugins()];
      [cur[idx], cur[idx + 1]] = [cur[idx + 1], cur[idx]];
      window.DataLoader.setActivePlugins(cur);
    };

    const removeBtn = document.createElement('button');
    removeBtn.className   = 'sorter-remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title       = 'Remove plugin';
    removeBtn.onclick = () => {
      const cur      = [...window.DataLoader.getActivePlugins()];
      const nonLocal = cur.filter(p => p !== LOCAL);
      if (nonLocal.length <= 1) {
        sbToast('At least one plugin must remain active.', 'danger');
        return;
      }
      const next = cur.filter(p => p !== outputName);
      window.DataLoader.setActivePlugins(next);
    };

    row.appendChild(labelEl);
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    row.appendChild(removeBtn);
    box.appendChild(row);
  });
}

/**
 * Open the plugin picker modal.
 * Takes a snapshot so Cancel can restore the previous selection.
 */
function sbOpenPluginPicker() {
  if (!window.DataLoader) { sbToast('Data not loaded yet.', 'danger'); return; }
  _sbPluginPickerSnapshot = [...window.DataLoader.getActivePlugins()];
  sbRenderPluginPickerList('');
  document.getElementById('sb-plugin-picker-search').value = '';
  openModal('modal-sb-plugin-picker');
  setTimeout(() => document.getElementById('sb-plugin-picker-search').focus(), 80);
}

function sbCancelPluginPicker() {
  // Restore snapshot
  if (_sbPluginPickerSnapshot.length) {
    window.DataLoader.setActivePlugins([..._sbPluginPickerSnapshot]);
  }
  _sbPluginPickerSnapshot = [];
  closeModal('modal-sb-plugin-picker');
}

function sbConfirmPluginPicker() {
  _sbPluginPickerSnapshot = [];
  closeModal('modal-sb-plugin-picker');
  // setActivePlugins fires pluginsChanged which triggers sbRefreshLiveData + re-render
}

/**
 * Render the grouped plugin list inside the picker modal.
 * Mirrors the layout of generalPluginStuff.js _renderPluginPickerList.
 */
function sbRenderPluginPickerList(query) {
  const list = document.getElementById('sb-plugin-picker-list');
  if (!list || !window.DataLoader) return;
  list.innerHTML = '';

  const lq     = (query || '').toLowerCase().trim();
  const active = window.DataLoader.getActivePlugins();
  const LOCAL  = window.DataLoader.LOCAL_PLUGIN_ID;
  const allData = window.allData || {};

  // ── Local Builds section ───────────────────────────────────────────────────
  const localPlugin = allData[LOCAL];
  const localMatchesQuery = !lq || 'local builds'.includes(lq);
  if (localPlugin && (localPlugin.ships || []).length > 0 && localMatchesQuery) {
    const header = document.createElement('div');
    header.className   = 'plugin-picker-group-header plugin-picker-group-header--local';
    header.textContent = '📦 Local Builds';
    list.appendChild(header);

    const isActive  = active.includes(LOCAL);
    const shipCount = (localPlugin.ships || []).length;

    const row = document.createElement('div');
    row.className   = 'plugin-picker-row plugin-picker-row--local' + (isActive ? ' active' : '');
    row.dataset.plugin = LOCAL;

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = isActive;
    cb.style.cssText = 'cursor:pointer;accent-color:#3b82f6;width:16px;height:16px;flex-shrink:0;';
    cb.onclick  = e => e.stopPropagation();
    cb.onchange = () => {
      const cur = [...window.DataLoader.getActivePlugins()];
      if (cb.checked) {
        if (!cur.includes(LOCAL)) cur.unshift(LOCAL);
      } else {
        const idx = cur.indexOf(LOCAL);
        if (idx !== -1) cur.splice(idx, 1);
      }
      window.DataLoader.setActivePlugins(cur);
      row.classList.toggle('active', window.DataLoader.getActivePlugins().includes(LOCAL));
    };

    const dot = document.createElement('span');
    dot.className = 'plugin-picker-active-dot';

    const lbl = document.createElement('span');
    lbl.className   = 'plugin-picker-row-label';
    lbl.textContent = `Local Builds (${shipCount} ship${shipCount !== 1 ? 's' : ''})`;

    row.appendChild(cb);
    row.appendChild(dot);
    row.appendChild(lbl);
    row.onclick = () => cb.click();
    list.appendChild(row);
  }

  // ── Remote plugin groups ───────────────────────────────────────────────────
  const groups = {};
  for (const [outputName, data] of Object.entries(allData)) {
    if (outputName === LOCAL) continue;
    const src = data.sourceName || outputName;
    (groups[src] = groups[src] || []).push({ outputName, data });
  }

  let anyRemoteVisible = false;
  for (const [sourceName, plugins] of Object.entries(groups)) {
    const visible = lq
      ? plugins.filter(p =>
          p.data.displayName.toLowerCase().includes(lq) ||
          sourceName.toLowerCase().includes(lq))
      : plugins;
    if (!visible.length) continue;
    anyRemoteVisible = true;

    const header = document.createElement('div');
    header.className   = 'plugin-picker-group-header';
    header.textContent = sourceName;
    list.appendChild(header);

    for (const { outputName, data } of visible) {
      const isActive = active.includes(outputName);

      const row = document.createElement('div');
      row.className   = 'plugin-picker-row' + (isActive ? ' active' : '');
      row.dataset.plugin = outputName;

      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = isActive;
      cb.style.cssText = 'cursor:pointer;accent-color:#3b82f6;width:16px;height:16px;flex-shrink:0;';
      cb.onclick  = e => e.stopPropagation();
      cb.onchange = () => {
        const cur      = [...window.DataLoader.getActivePlugins()];
        const nonLocal = cur.filter(p => p !== LOCAL);
        if (!cb.checked) {
          if (nonLocal.length <= 1 && nonLocal[0] === outputName) {
            // Must keep at least one remote plugin
            cb.checked = true;
            row.classList.add('active');
            sbToast('At least one plugin must remain active.', 'danger');
            return;
          }
          const idx = cur.indexOf(outputName);
          if (idx !== -1) cur.splice(idx, 1);
        } else {
          if (!cur.includes(outputName)) cur.push(outputName);
        }
        window.DataLoader.setActivePlugins(cur);
        row.classList.toggle('active', window.DataLoader.getActivePlugins().includes(outputName));
      };

      const dot = document.createElement('span');
      dot.className = 'plugin-picker-active-dot';

      const lbl = document.createElement('span');
      lbl.className   = 'plugin-picker-row-label';
      lbl.textContent = plugins.length === 1 ? sourceName : data.displayName;

      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(lbl);
      row.onclick = () => cb.click();
      list.appendChild(row);
    }
  }

  const localRendered = localPlugin && (localPlugin.ships || []).length > 0 && localMatchesQuery;
  if (!localRendered && !anyRemoteVisible) {
    const empty = document.createElement('p');
    empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:0.9rem;padding:12px 10px;';
    empty.textContent   = 'No matching plugins.';
    list.appendChild(empty);
  }
}

function sbFilterPluginPicker(val) {
  sbRenderPluginPickerList(val);
}

// ═══════════════════════════════════════════════════════════
//  DATA BRIDGE
// ═══════════════════════════════════════════════════════════
// Fallback attr keys used before/if attrDefs fails to load
const _SB_ATTR_FALLBACK = [
  'category','mass','drag','required crew','bunks','cargo space','fuel capacity','cost',
  'shields','hull','hull repair rate','shield generation','shield energy','hull energy',
  'hull heat','heat dissipation','energy capacity','energy generation','energy consumption',
  'solar collection','ramscoop','fuel generation','fuel consumption',
  'thrust','thrusting energy','thrusting heat','turn','turning energy','turning heat',
  'reverse thrust','afterburner thrust','afterburner fuel','afterburner heat','afterburner energy',
  'engine capacity','weapon capacity','outfit space','gun ports','turret mounts',
  'hyperdrive','jump drive','jump fuel','jump range','scram drive',
  'cloak','cloaking energy','cloaking fuel','cloaking heat',
];

function sbRefreshLiveData() {
  _sbOutfitLookup = null; // clear lookup cache
  const DL = window.DataLoader;
  if (DL && DL.isReady()) {
    // getAllShips / getAllOutfits already filter to active plugins
    sbAllShips   = DL.getAllShips().map(s => ({ ...s, _pn: s._pluginName, _pd: s._pluginDisplay }));
    sbAllOutfits = DL.getAllOutfits().map(o => ({ ...o, _pn: o._pluginName, _pd: o._pluginDisplay }));
    const defKeys = DL.getAttrKeys();
    sbAttrKeys   = [...new Set([..._SB_ATTR_FALLBACK, ...defKeys])].sort();
  } else {
    sbAllShips   = [];
    sbAllOutfits = [];
    sbAttrKeys   = [..._SB_ATTR_FALLBACK].sort();
  }
}

function sbAttrHint(key) {
  if (window.DataLoader) return window.DataLoader.getAttrHint(key);
  return '';
}

// ═══════════════════════════════════════════════════════════
//  BLANK SHIP
// ═══════════════════════════════════════════════════════════
function sbBlank() {
  return {
    id: Date.now() + Math.random(),
    name: '', variant: '', plural: '', sprite: '', thumbnail: '',
    description: '', drag: '', mass: '',
    attributes: {}, outfits: [],
    guns: [], turrets: [], drones: [], fighters: [], engines: [],
    leaks: [], explode: [], finalExplode: [], extraLines: [],
    _sourceShip: null, _sourcePlugin: null,
  };
}

// ═══════════════════════════════════════════════════════════
//  PERSISTENCE
// ═══════════════════════════════════════════════════════════
// sbSave() — convert internal array to map format before writing
function sbSave() {
    const toStore = sbFleet.map(ship => ({
        ...ship,
        outfits: Object.fromEntries(
            (ship.outfits || []).map(o => [
                o.name.replace(/^"|"$/g, ''),
                { count: o.count ?? 1, pluginId: o.pluginId ?? null }
            ])
        )
    }));
    try { localStorage.setItem(SB_STORAGE_KEY, JSON.stringify(toStore)); } catch(e) {}
}

// sbLoad() — convert map format back to internal array on load
function sbLoad() {
    try {
        const d = localStorage.getItem(SB_STORAGE_KEY);
        if (d) {
            const raw = JSON.parse(d);
            sbFleet = raw.map(ship => ({
                ...ship,
                outfits: typeof ship.outfits === 'object' && !Array.isArray(ship.outfits)
                    ? Object.entries(ship.outfits).map(([name, val]) => ({
                        name,
                        count:    typeof val === 'object' ? (val.count    ?? 1)    : (Number(val) || 1),
                        pluginId: typeof val === 'object' ? (val.pluginId ?? null) : null,
                    }))
                    : (ship.outfits || [])  // graceful fallback for old array-format saves
            }));
        }
    } catch(e) { sbFleet = []; }
}

// ═══════════════════════════════════════════════════════════
//  VIEW SWITCHING
// ═══════════════════════════════════════════════════════════
function showFleetView() {
  document.getElementById('fleet-view').classList.remove('hidden');
  document.getElementById('builder-view').classList.add('hidden');
  renderFleet();
  renderExportChecklist();
}
function showBuilderView() {
  document.getElementById('fleet-view').classList.add('hidden');
  document.getElementById('builder-view').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
//  FLEET RENDER
// ═══════════════════════════════════════════════════════════
function renderFleet() {
  const grid = document.getElementById('fleet-grid');
  if (!grid) return;
  if (!sbFleet.length) {
    grid.innerHTML = `<div class="fleet-empty"><div class="fleet-empty__icon">🛸</div>
      <p>No ships yet. Create a new ship, outfit an existing one, or import ES data.</p></div>`;
    return;
  }
  grid.innerHTML = sbFleet.map((s, i) => {
    const a = s.attributes || {};
    const src = s._sourceShip ? `<span class="badge badge-blue" style="font-size:0.65rem;margin-left:6px;">based on ${esc(s._sourceShip)}</span>` : '';
    return `<div class="fleet-card" onclick="sbEditFleetShip(${i})">
      <div class="fleet-card__name">${esc(s.name || 'Unnamed Ship')}${src}</div>
      <div class="fleet-card__variant">${s.variant ? esc(s.variant) : '<em style="color:var(--c-text-dim)">No variant</em>'}</div>
      <div class="fleet-card__stats">
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Shields</div><div class="fleet-card__stat-value">${a.shields||'—'}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Hull</div><div class="fleet-card__stat-value">${a.hull||'—'}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Category</div><div class="fleet-card__stat-value" style="font-size:0.8rem;">${a.category||'—'}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Outfits</div><div class="fleet-card__stat-value">${(s.outfits||[]).length}</div></div>
      </div>
      <div class="fleet-card__actions" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-sm"   onclick="sbEditFleetShip(${i})">✏️ Edit</button>
        <button class="btn btn-secondary btn-sm" onclick="sbDuplicate(${i})">⧉ Copy</button>
        <button class="btn btn-danger btn-sm"    onclick="sbConfirmDelete(${i})">🗑</button>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════
//  MODE ENTRY POINTS (called from HTML buttons)
// ═══════════════════════════════════════════════════════════
function newShip() {
  sbRefreshLiveData();
  sbMode = 'new'; sbEditIdx = -1;
  sbCurrentShip = sbBlank();
  sbPopulateBuilder();
  showBuilderView();
}

function openOutfitExisting() {
  sbRefreshLiveData();
  if (!sbAllShips.length) { sbToast('No ship data loaded yet.', 'danger'); return; }
  sbMode = 'outfit';
  sbOpenShipPicker();
}

function openEditExisting() {
  sbRefreshLiveData();
  if (!sbAllShips.length) { sbToast('No ship data loaded yet.', 'danger'); return; }
  sbMode = 'edit';
  sbOpenShipPicker();
}

function sbEditFleetShip(i) {
  sbRefreshLiveData();
  sbMode = 'edit'; sbEditIdx = i;
  sbCurrentShip = JSON.parse(JSON.stringify(sbFleet[i]));
  sbPopulateBuilder();
  showBuilderView();
}

function sbDuplicate(i) {
  const c = JSON.parse(JSON.stringify(sbFleet[i]));
  c.id = Date.now() + Math.random();
  c.variant = (c.variant || '') + ' (Copy)';
  sbFleet.push(c); sbSave(); renderFleet();
  sbToast('Ship duplicated!', 'success');
}

function sbConfirmDelete(i) {
  document.getElementById('confirm-text').textContent =
    `Delete "${sbFleet[i].name || 'Unnamed Ship'}"? This cannot be undone.`;
  document.getElementById('confirm-ok-btn').onclick = () => {
    sbFleet.splice(i, 1); sbSave();
    closeModal('modal-confirm'); renderFleet();
    sbToast('Ship deleted.', 'danger');
  };
  openModal('modal-confirm');
}

// ═══════════════════════════════════════════════════════════
//  SHIP PICKER (pick from allData)
// ═══════════════════════════════════════════════════════════
function sbOpenShipPicker() {
  const title = document.getElementById('sb-ship-picker-title');
  if (title) title.textContent = sbMode === 'outfit' ? 'Choose a Ship to Outfit' : 'Choose a Ship to Edit';

  const list = document.getElementById('sb-ship-picker-list');
  const byPlugin = {};
  for (const s of sbAllShips) {
    const key = s._pd || s._pn || 'Unknown';
    (byPlugin[key] = byPlugin[key] || []).push(s);
  }

  list.innerHTML = Object.entries(byPlugin).map(([plugin, ships]) => `
    <div class="sb-picker-group">
      <div class="sb-picker-group-label">${esc(plugin)}</div>
      ${ships.map(s => {
        const cat = (s.attributes && s.attributes.category) || '';
        const varTag = s._isVariant ? ' <em style="font-size:0.78em;color:var(--c-text-dim)">(variant)</em>' : '';
        // Safely encode the ship data as a base64 string to avoid HTML attribute escaping issues
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(s))));
        return `<div class="sb-picker-row" onclick="sbPickShip('${encoded}')">
          <span class="sb-picker-name">${esc(s.name || 'Unknown')}${varTag}</span>
          <span class="sb-picker-meta">${esc(cat)}</span>
        </div>`;
      }).join('')}
    </div>`).join('');

  document.getElementById('sb-ship-picker-search').value = '';
  openModal('modal-sb-ship-picker');
}

function sbFilterShipPicker(val) {
  const q = val.toLowerCase();
  document.querySelectorAll('#sb-ship-picker-list .sb-picker-row').forEach(r => {
    r.style.display = r.querySelector('.sb-picker-name').textContent.toLowerCase().includes(q) ? '' : 'none';
  });
  document.querySelectorAll('#sb-ship-picker-list .sb-picker-group').forEach(g => {
    g.style.display = [...g.querySelectorAll('.sb-picker-row')].some(r => r.style.display !== 'none') ? '' : 'none';
  });
}

function sbPickShip(encoded) {
  closeModal('modal-sb-ship-picker');
  const src = JSON.parse(decodeURIComponent(escape(atob(encoded))));
  sbCurrentShip = sbShipFromParsed(src);
  sbEditIdx = -1;
  sbPopulateBuilder();
  showBuilderView();
  if (sbMode === 'outfit') sbSwitchTab('outfits');
}

function sbShipFromParsed(src) {
  const s = sbBlank();
  s.name        = src.name        || '';
  s.variant     = src.variant     || '';
  s.plural      = src.plural      || '';
  s.sprite      = src.sprite      || '';
  s.thumbnail   = src.thumbnail   || '';
  s.description = src.description || '';
  s._sourceShip   = src.name || null;
  s._sourcePlugin = src._pn  || null;

  // Attributes — keep nested objects for licenses and weapon sub-blocks
  if (src.attributes && typeof src.attributes === 'object') {
    for (const [k, v] of Object.entries(src.attributes)) {
      if (k === 'mass' || k === 'drag') continue; // handled separately below
      // Preserve licenses and weapon as objects
      if ((k === 'licenses' || k === 'weapon') && typeof v === 'object') {
        s.attributes[k] = v;
      } else if (typeof v !== 'object') {
        s.attributes[k] = String(v);
      }
    }
  }
  // drag / mass may also live at top-level in some parser outputs
  const rawMass = src.mass ?? src.attributes?.mass;
  const rawDrag = src.drag ?? src.attributes?.drag;
  if (rawMass != null && rawMass !== '') s.mass = String(rawMass);
  if (rawDrag != null && rawDrag !== '') s.drag = String(rawDrag);

  // ── Outfits ───────────────────────────────────────────────
  const sourcePluginId = src._pn || src._pluginName || null;
  const outfitSource = src.outfits || src.outfitMap;
  if (outfitSource && typeof outfitSource === 'object' && !Array.isArray(outfitSource)) {
    for (const [n, val] of Object.entries(outfitSource)) {
      const cleanName = n.replace(/^"|"$/g, '');
      const count    = typeof val === 'object' ? (parseInt(val.count) || 1)       : (Number(val) || 1);
      const pluginId = typeof val === 'object' ? (val.pluginId || sourcePluginId)  : sourcePluginId;
      s.outfits.push({ name: cleanName, count, pluginId });
    }
  }

  // ── Guns ─────────────────────────────────────────────────
  for (const g of (src.guns || [])) {
    const coords = [g.x, g.y].filter(v => v != null).join(' ') || '0 0';
    const over   = g.gun || g.over || g.weapon || '';
    s.guns.push({ coords, over });
  }

  // ── Turrets ───────────────────────────────────────────────
  for (const g of (src.turrets || [])) {
    const coords = [g.x, g.y].filter(v => v != null).join(' ') || '0 0';
    const over   = g.turret || g.over || g.weapon || '';
    s.turrets.push({ coords, over });
  }

  // ── Engines ───────────────────────────────────────────────
  for (const e of (src.engines || [])) {
    s.engines.push({
      coords: [e.x, e.y].filter(v => v != null).join(' ') || '0 0',
      zoom:   e.zoom != null ? String(e.zoom) : '',
      angle:  e.angle != null ? String(e.angle) : '',
    });
  }

  // ── Bays (drones / fighters) ──────────────────────────────
  for (const b of (src.bays || [])) {
    const coords       = [b.x, b.y].filter(v => v != null).join(' ') || '0 0';
    const launchEffect = b['launch effect'] || '';
    if (b.type === 'Fighter' || b.category === 'fighter') {
      s.fighters.push({ coords, launchEffect });
    } else if (b.type === 'Drone' || b.category === 'drone') {
      s.drones.push({ coords, launchEffect });
    }
  }

  // ── Explode ───────────────────────────────────────────────
  const explodeSrc = src.explode || [];
  for (const e of explodeSrc) {
    s.explode.push({
      name:  typeof e === 'string' ? `"${e}"` : `"${e.name || 'tiny explosion'}"`,
      count: e.count || 1,
    });
  }
  for (const key of ['small explosion','medium explosion','large explosion','huge explosion']) {
    if (src[key] != null) s.explode.push({ name: `"${key}"`, count: Number(src[key]) });
  }

  const finalSrc = src.finalExplode || src['final explode'] || [];
  if (typeof finalSrc === 'string') {
    s.finalExplode.push({ name: `"${finalSrc}"`, count: 1 });
  } else {
    for (const e of (Array.isArray(finalSrc) ? finalSrc : [])) {
      s.finalExplode.push({ name: typeof e === 'string' ? `"${e}"` : `"${e.name || 'final explosion large'}"`, count: e.count || 1 });
    }
  }

  // Auto-slot all outfits into empty gun/turret ports.
  sbAutoSlotAllOutfits(s);

  return s;
}

// ═══════════════════════════════════════════════════════════
//  BUILDER POPULATE
// ═══════════════════════════════════════════════════════════
function sbPopulateBuilder() {
  const s = sbCurrentShip;
  const modeLabel = { new: '✏️ New Ship', edit: '✏️ Edit Ship', outfit: '🔧 Outfit Ship' }[sbMode] || '';
  const titleEl = document.getElementById('builder-page-title');
  if (titleEl) titleEl.textContent = s.name ? `${modeLabel}: ${s.name}` : modeLabel;

  const subtitleEl = document.getElementById('builder-page-subtitle');
  if (subtitleEl) subtitleEl.textContent = {
    new:    'Define your ship from scratch.',
    edit:   'Edit attributes, metadata, and hardpoints.',
    outfit: 'Manage outfits on this ship.',
  }[sbMode] || '';

  // Sidebar visibility
  const idSide = document.getElementById('sidebar-identity');
  const deSide = document.getElementById('sidebar-description');
  if (idSide) idSide.style.display = sbMode === 'outfit' ? 'none' : '';
  if (deSide) deSide.style.display = sbMode === 'outfit' ? 'none' : '';

  // Mode badge
  const badge = document.getElementById('sb-mode-badge');
  if (badge) {
    badge.className = 'badge ' + ({ new:'badge-blue', edit:'badge-green', outfit:'badge-purple' }[sbMode] || 'badge-blue');
    badge.textContent = sbMode.toUpperCase();
    badge.style.display = '';
  }

  document.getElementById('ship-name').value        = s.name        || '';
  document.getElementById('ship-variant').value     = s.variant     || '';
  document.getElementById('ship-plural').value      = s.plural      || '';
  document.getElementById('ship-sprite').value      = s.sprite      || '';
  document.getElementById('ship-thumbnail').value   = s.thumbnail   || '';
  document.getElementById('ship-description').value = s.description || '';
  document.getElementById('ship-drag').value        = s.drag        || '';
  document.getElementById('ship-mass').value        = s.mass        || '';

  sbRenderAttrList();
  sbRenderOutfitsList();
  sbRenderGunsTurrets();
  sbRenderExplodeLists();
  sbRawDirty = false;
  sbRenderRaw();
  sbUpdateQuickStats();
  sbSwitchTab(sbMode === 'outfit' ? 'outfits' : 'attributes');
}

function onBuilderChange() {
  if (!sbCurrentShip) return;
  const s = sbCurrentShip;
  s.name        = document.getElementById('ship-name').value.trim();
  s.variant     = document.getElementById('ship-variant').value.trim();
  s.plural      = document.getElementById('ship-plural').value.trim();
  s.sprite      = document.getElementById('ship-sprite').value.trim();
  s.thumbnail   = document.getElementById('ship-thumbnail').value.trim();
  s.description = document.getElementById('ship-description').value;
  s.drag        = document.getElementById('ship-drag').value.trim();
  s.mass        = document.getElementById('ship-mass').value.trim();
  const titleEl = document.getElementById('builder-page-title');
  const modeLabel = { new: '✏️ New Ship', edit: '✏️ Edit Ship', outfit: '🔧 Outfit Ship' }[sbMode] || '';
  if (titleEl) titleEl.textContent = s.name ? `${modeLabel}: ${s.name}` : modeLabel;
  sbUpdateQuickStats();
  sbRenderRaw();
}

// ═══════════════════════════════════════════════════════════
//  CAPACITY TRACKING
// ═══════════════════════════════════════════════════════════

// Attributes whose value on an OUTFIT affects ship capacity.
const SB_CAPACITY_ATTRS = {
  'outfit space':    'outfit space',
  'engine capacity': 'engine capacity',
  'weapon capacity': 'weapon capacity',
  'cargo space':     'cargo space',
};

// Build a fast name→outfit lookup once data is loaded.
let _sbOutfitLookup = null;
function sbGetOutfitLookup() {
  if (_sbOutfitLookup) return _sbOutfitLookup;
  _sbOutfitLookup = {};
  for (const o of sbAllOutfits) {
    const name = (o.name || o.displayName || '').trim().replace(/^"|"$/g, '');
    if (!name) continue;
    _sbOutfitLookup[name] = o;
  }
  return _sbOutfitLookup;
}

function sbFindOutfit(outfitName) {
  const lookup = sbGetOutfitLookup();
  return lookup[outfitName.replace(/^"|"$/g, '')] || null;
}

function sbGetOutfitCapacityEffect(outfitName, capacityKey) {
  const o = sbFindOutfit(outfitName);
  if (!o) return 0;
  let val = o[capacityKey];
  if (val == null && o.attributes) val = o.attributes[capacityKey];
  if (val == null) return 0;
  const n = Number(val);
  if (isNaN(n) || n === 0) return 0;
  return n;
}

function sbGetOutfitCapacityCost(outfitName, capacityKey) {
  const effect = sbGetOutfitCapacityEffect(outfitName, capacityKey);
  return effect < 0 ? Math.abs(effect) : 0;
}

function sbGetOutfitSize(outfitName) {
  return sbGetOutfitCapacityCost(outfitName, 'outfit space');
}

function sbUsedCapacity(capacityKey) {
  if (!sbCurrentShip) return 0;
  const net = (sbCurrentShip.outfits || []).reduce((total, o) => {
    const effect = sbGetOutfitCapacityEffect(o.name, capacityKey);
    return total + (-(effect)) * (parseInt(o.count) || 1);
  }, 0);
  return Math.max(0, net);
}

function sbUsedOutfitSpace()    { return sbUsedCapacity('outfit space'); }
function sbUsedEngineCapacity() { return sbUsedCapacity('engine capacity'); }
function sbUsedWeaponCapacity() { return sbUsedCapacity('weapon capacity'); }
function sbUsedCargoSpace()     { return sbUsedCapacity('cargo space'); }

function sbShipCapacity(key) {
  if (!sbCurrentShip) return 0;
  return Number((sbCurrentShip.attributes || {})[key]) || 0;
}
function sbMaxOutfitSpace()    { return sbShipCapacity('outfit space'); }
function sbMaxEngineCapacity() { return sbShipCapacity('engine capacity'); }
function sbMaxWeaponCapacity() { return sbShipCapacity('weapon capacity'); }
function sbMaxCargoSpace()     { return sbShipCapacity('cargo space'); }

function sbCapacityBarHTML(label, used, max) {
  if (max <= 0) return '';
  const remaining = max - used;
  const pct       = Math.min(100, Math.round(used / max * 100));
  const over      = used > max;
  const barColor  = over ? 'var(--c-danger-hi)' : pct > 90 ? '#f59e0b' : 'var(--c-accent)';
  const textColor = over ? 'var(--c-danger-hi)' : pct > 90 ? 'var(--c-warn-text)' : 'var(--c-accent-text)';
  return `
    <div class="sb-cap-bar" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
        <span style="font-size:0.72rem;font-weight:700;color:#63b3ed;text-transform:uppercase;letter-spacing:.1em;">${label}</span>
        <span style="font-size:0.82rem;font-weight:700;color:${textColor};font-variant-numeric:tabular-nums;">
          ${used} / ${max}
          <span style="font-size:0.72rem;color:var(--c-text-dim);font-weight:400;margin-left:4px;">
            ${remaining >= 0 ? remaining + ' free' : Math.abs(remaining) + ' over'}${over ? ' ⚠' : ''}
          </span>
        </span>
      </div>
      <div class="sb-space-bar-track">
        <div class="sb-space-bar-fill" style="width:${pct}%;background:${barColor};"></div>
      </div>
    </div>`;
}

function sbRenderOutfitSpaceBar() {
  const el = document.getElementById('outfit-space-bar-wrap');
  if (!el || !sbCurrentShip) return;

  const bars = [
    { label: 'Outfit Space',     used: sbUsedOutfitSpace(),    max: sbMaxOutfitSpace() },
    { label: 'Engine Capacity',  used: sbUsedEngineCapacity(), max: sbMaxEngineCapacity() },
    { label: 'Weapon Capacity',  used: sbUsedWeaponCapacity(), max: sbMaxWeaponCapacity() },
    { label: 'Cargo Space',      used: sbUsedCargoSpace(),     max: sbMaxCargoSpace() },
  ].filter(b => b.max > 0);

  if (!bars.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = bars.map(b => sbCapacityBarHTML(b.label, b.used, b.max)).join('');
}

// ═══════════════════════════════════════════════════════════
//  ATTRIBUTE VALIDATION
// ═══════════════════════════════════════════════════════════

const SB_SIGNED_ATTRS = new Set([
  'shield protection','hull protection','energy protection','fuel protection',
  'heat protection','force protection','piercing protection',
  'shield permeability','high shield permeability','low shield permeability',
  'cloaked shield permeability',
  'shield damage','hull damage','energy damage','fuel damage','heat damage',
  'ion damage','scrambling damage','slowing damage','disruption damage',
  'discharge damage','corrosion damage','burn damage','leak damage',
  'relative shield damage','relative hull damage','relative energy damage',
  'relative fuel damage','relative heat damage','relative minable damage',
  '% shield damage','% hull damage','% energy damage','% fuel damage',
  '% heat damage','% minable damage',
  'firing energy','firing fuel','firing heat','firing shields','firing hull',
  'relative firing energy','relative firing fuel','relative firing heat',
  'relative firing shields','relative firing hull',
  'outfit space','engine capacity','weapon capacity','cargo space',
  'gun ports','turret mounts',
  'drag reduction','inertia reduction','acceleration multiplier',
  'turn multiplier','hull multiplier','shield multiplier',
  'hull repair multiplier','shield generation multiplier',
  'mass','drag',
]);

function sbValidateAttrValue(key, rawValue) {
  const v = parseFloat(rawValue);
  if (isNaN(v)) return { ok: true };
  if (SB_SIGNED_ATTRS.has(key)) return { ok: true };
  if (v < 0) {
    return {
      ok: false,
      message: `"${key}" cannot be negative. Use a value ≥ 0.`
    };
  }
  return { ok: true };
}

const SB_HARDPOINT_KEYS = {
  'gun ports':     { field: 'guns',    label: 'gun' },
  'turret mounts': { field: 'turrets', label: 'turret' },
};

function sbSyncHardpoints(key, newVal) {
  const hp = SB_HARDPOINT_KEYS[key];
  if (!hp) return false;
  const target  = parseInt(newVal) || 0;
  const current = (sbCurrentShip[hp.field] || []).length;
  if (target > current) {
    const toAdd = target - current;
    sbCurrentShip[hp.field] = sbCurrentShip[hp.field] || [];
    for (let i = 0; i < toAdd; i++) {
      sbCurrentShip[hp.field].push({ coords: '0 0', over: '' });
    }
    sbToast(`Added ${toAdd} ${hp.label} port${toAdd > 1 ? 's' : ''} at 0 0 — set coordinates in Guns & Turrets tab`, 'success');
    sbRenderGunsTurrets();
    return true;
  }
  return false;
}

function sbAutoSlotWeapons(outfitName, count, outfitObj) {
  if (!outfitObj) return;
  const gunCost     = _sbGetPortCost(outfitObj, 'gun ports');
  const turretCost  = _sbGetPortCost(outfitObj, 'turret mounts');
  if (gunCost > 0)    _sbFillEmptyPorts(sbCurrentShip.guns,    outfitName, gunCost * count);
  if (turretCost > 0) _sbFillEmptyPorts(sbCurrentShip.turrets, outfitName, turretCost * count);
}

function _sbGetPortCost(outfitObj, portKey) {
  let val = outfitObj[portKey];
  if (val == null && outfitObj.attributes) val = outfitObj.attributes[portKey];
  if (val == null) return 0;
  const n = Number(val);
  return n < 0 ? Math.abs(n) : 0;
}

function _sbFillEmptyPorts(hardpoints, outfitName, needed) {
  if (!hardpoints || needed <= 0) return;
  const clean = outfitName.replace(/^"|"$/g, '');
  let filled = 0;
  for (const hp of hardpoints) {
    if (filled >= needed) break;
    if (!hp.over || hp.over.trim() === '') {
      hp.over = clean;
      filled++;
    }
  }
}

function sbUpdateAttrVal(inp) {
  const key = inp.dataset.key;
  const val = inp.value;
  const check = sbValidateAttrValue(key, val);
  if (!check.ok) {
    sbToast(check.message, 'danger');
    if (key === 'mass') inp.value = String(sbCurrentShip.mass ?? '');
    else if (key === 'drag') inp.value = String(sbCurrentShip.drag ?? '');
    else inp.value = String(sbCurrentShip.attributes[key] ?? '');
    inp.style.borderColor = 'var(--c-danger-hi)';
    setTimeout(() => { inp.style.borderColor = ''; }, 1500);
    return;
  }
  inp.style.borderColor = '';

  if (key === 'mass') {
    sbCurrentShip.mass = val;
    const massEl = document.getElementById('ship-mass');
    if (massEl && massEl !== inp) massEl.value = val;
  } else if (key === 'drag') {
    sbCurrentShip.drag = val;
    const dragEl = document.getElementById('ship-drag');
    if (dragEl && dragEl !== inp) dragEl.value = val;
  } else {
    sbCurrentShip.attributes[key] = val;
    const changed = sbSyncHardpoints(key, val);
    if (changed) sbRenderAttrList();
  }

  sbUpdateQuickStats();
  sbRenderOutfitSpaceBar();
  sbRenderRaw();
}

function sbRemoveAttr(k) {
  if (k === 'mass') {
    sbCurrentShip.mass = '';
    const massEl = document.getElementById('ship-mass');
    if (massEl) massEl.value = '';
  } else if (k === 'drag') {
    sbCurrentShip.drag = '';
    const dragEl = document.getElementById('ship-drag');
    if (dragEl) dragEl.value = '';
  } else {
    delete sbCurrentShip.attributes[k];
  }
  sbRenderAttrList(); sbUpdateQuickStats(); sbRenderRaw();
}

function sbUpdateQuickStats() {
  const el = document.getElementById('quick-stats');
  if (!el || !sbCurrentShip) return;
  const s  = sbCurrentShip;
  const a  = s.attributes || {};

  const oUsed = sbUsedOutfitSpace(),    oMax = sbMaxOutfitSpace();
  const eUsed = sbUsedEngineCapacity(), eMax = sbMaxEngineCapacity();
  const wUsed = sbUsedWeaponCapacity(), wMax = sbMaxWeaponCapacity();
  const cUsed = sbUsedCargoSpace(),     cMax = sbMaxCargoSpace();

  function capVal(used, max) {
    if (max <= 0) return '—';
    const over = used > max;
    const color = over ? 'var(--c-danger-hi)' : 'var(--c-accent-text)';
    return `<span style="color:${color}">${used}/${max}</span>`;
  }

  const qs = [
    { label: 'Shields',       value: a.shields            || '—' },
    { label: 'Hull',          value: a.hull               || '—' },
    { label: 'Mass',          value: s.mass || a.mass     || '—' },
    { label: 'Outfit Space',  value: capVal(oUsed, oMax) },
    { label: 'Engine Cap.',   value: capVal(eUsed, eMax) },
    { label: 'Weapon Cap.',   value: capVal(wUsed, wMax) },
    { label: 'Cargo Space',   value: capVal(cUsed, cMax) },
    { label: 'Guns',          value: (s.guns     || []).length },
    { label: 'Turrets',       value: (s.turrets  || []).length },
    { label: 'Drones',        value: (s.drones   || []).length },
    { label: 'Fighters',      value: (s.fighters || []).length },
    { label: 'Engines',       value: (s.engines  || []).length },
  ];

  el.innerHTML = qs.map(q =>
    `<div class="qs-card"><div class="qs-label">${q.label}</div><div class="qs-value">${q.value}</div></div>`
  ).join('');

  sbRenderOutfitSpaceBar();
}


// ── Tabs ──────────────────────────────────────────────────
function sbSwitchTab(name) {
  document.querySelectorAll('.builder-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.builder-tab-content').forEach(t => t.classList.remove('active'));
  const btn = document.querySelector(`.builder-tab[data-tab="${name}"]`);
  const cnt = document.getElementById(`tab-${name}`);
  if (btn) btn.classList.add('active');
  if (cnt) cnt.classList.add('active');
  if (name === 'raw') sbRenderRaw();
}
function initBuilderTabs() {
  document.querySelectorAll('.builder-tab').forEach(btn => {
    btn.addEventListener('click', () => sbSwitchTab(btn.dataset.tab));
  });
}

// ═══════════════════════════════════════════════════════════
//  ATTRIBUTES
// ═══════════════════════════════════════════════════════════
const SB_ATTR_GROUPS = {
  'Identity':  ['category','mass','drag','required crew','bunks','cargo space','fuel capacity','cost'],
  'Combat':    ['shields','hull','hull repair rate','shield generation','shield energy','hull energy','hull heat','heat dissipation','energy capacity'],
  'Movement':  ['thrust','thrusting energy','thrusting heat','turn','turning energy','turning heat','reverse thrust','reverse thrusting energy','reverse thrusting heat','afterburner thrust','afterburner fuel','afterburner heat','afterburner energy'],
  'Power':     ['energy generation','energy consumption','solar collection','ramscoop','fuel generation','fuel consumption'],
  'Capacity':  ['engine capacity','weapon capacity','outfit space','gun ports','turret mounts'],
  'Drives':    ['hyperdrive','jump drive','jump fuel','jump range','scram drive'],
  'Cloaking':  ['cloak','cloaking energy','cloaking fuel','cloaking heat'],
};

function sbRenderAttrList() {
  const el = document.getElementById('attr-list');
  if (!el || !sbCurrentShip) return;
  const s     = sbCurrentShip;
  const attrs = s.attributes || {};

  const syntheticAttrs = { ...attrs };
  if (s.mass && s.mass !== '') syntheticAttrs['mass'] = s.mass;
  if (s.drag && s.drag !== '') syntheticAttrs['drag'] = s.drag;

  const allKeys = Object.keys(syntheticAttrs);
  if (!allKeys.length) {
    el.innerHTML = '<div style="color:var(--c-text-muted);font-size:0.88rem;font-style:italic;padding:10px 0;">No attributes. Click "+ Add Attribute" to add one.</div>';
    return;
  }

  const assigned = new Set();
  let html = '';
  for (const [group, gkeys] of Object.entries(SB_ATTR_GROUPS)) {
    const present = gkeys.filter(k => k in syntheticAttrs);
    if (!present.length) continue;
    html += `<div class="attr-section"><div class="attr-section-title">${group}</div>`;
    for (const k of present) {
      assigned.add(k);
      const v = (k === 'mass') ? s.mass : (k === 'drag') ? s.drag : attrs[k];
      html += sbAttrRow(k, v);
    }
    html += '</div>';
  }

  const other = allKeys.filter(k => !assigned.has(k) && k !== 'mass' && k !== 'drag');
  if (other.length) {
    html += '<div class="attr-section"><div class="attr-section-title">Other</div>';
    for (const k of other) html += sbAttrRow(k, attrs[k]);
    html += '</div>';
  }
  el.innerHTML = html;
}

function sbAttrRow(k, v) {
  const sk = esc(k), sv = esc(String(v ?? ''));
  const hint = sbAttrHint(k);
  const tip  = hint ? ` title="${esc(hint)}"` : '';
  return `<div class="attr-row">
    <span class="attr-key"${tip}>${sk}</span>
    <input class="attr-val-input" type="text" value="${sv}" data-key="${sk}"
      onchange="sbUpdateAttrVal(this)" onblur="sbUpdateAttrVal(this)">
    <button class="btn btn-danger btn-xs" onclick="sbRemoveAttr('${sk.replace(/'/g,"\\'")}')">✕</button>
  </div>`;
}

function openAddAttr() {
  document.getElementById('new-attr-key').value = '';
  document.getElementById('new-attr-val').value = '';
  document.getElementById('attr-key-ac').classList.remove('open');
  openModal('modal-add-attr');
  setTimeout(() => document.getElementById('new-attr-key').focus(), 80);
}
function confirmAddAttr() {
  const k = document.getElementById('new-attr-key').value.trim();
  const v = document.getElementById('new-attr-val').value.trim();
  if (!k) { sbToast('Please enter a key.', 'danger'); return; }
  const check = sbValidateAttrValue(k, v);
  if (!check.ok) { sbToast(check.message, 'danger'); return; }

  if (k === 'mass') {
    sbCurrentShip.mass = v;
    const massEl = document.getElementById('ship-mass');
    if (massEl) massEl.value = v;
  } else if (k === 'drag') {
    sbCurrentShip.drag = v;
    const dragEl = document.getElementById('ship-drag');
    if (dragEl) dragEl.value = v;
  } else {
    sbCurrentShip.attributes[k] = v;
    sbSyncHardpoints(k, v);
  }

  closeModal('modal-add-attr');
  sbRenderAttrList(); sbUpdateQuickStats(); sbRenderRaw();
}
function attrKeyAc(val) {
  const ac = document.getElementById('attr-key-ac');
  const matches = sbAttrKeys.filter(k => k.toLowerCase().includes(val.toLowerCase()));
  if (!val || !matches.length) { ac.classList.remove('open'); return; }
  ac.innerHTML = matches.slice(0, 16).map(k => {
    const hint = sbAttrHint(k);
    return `<div class="ac-item" onclick="sbSelectAttrKey('${esc(k).replace(/'/g,"\\'")}')">
      ${esc(k)}${hint ? `<span style="color:var(--c-text-dim);font-size:0.74rem;margin-left:8px;">${esc(hint)}</span>` : ''}
    </div>`;
  }).join('');
  ac.classList.add('open');
}
function sbSelectAttrKey(k) {
  document.getElementById('new-attr-key').value = k;
  document.getElementById('attr-key-ac').classList.remove('open');
  document.getElementById('new-attr-val').focus();
}

// ═══════════════════════════════════════════════════════════
//  OUTFITS
// ═══════════════════════════════════════════════════════════

function sbRenderOutfitsList() {
  const outfits = sbCurrentShip.outfits || [];
  const emptyEl = document.getElementById('outfits-empty');
  if (emptyEl) emptyEl.style.display = outfits.length ? 'none' : 'block';
  const el = document.getElementById('outfits-list');
  if (!el) return;

  el.innerHTML = outfits.map((o, i) => {
    const count   = parseInt(o.count) || 1;
    const rawName = o.name.replace(/^"|"$/g, '');

    const capDefs = [
      { key: 'outfit space',    label: 'sp' },
      { key: 'engine capacity', label: 'eng' },
      { key: 'weapon capacity', label: 'wpn' },
      { key: 'cargo space',     label: 'cargo' },
    ];
    const costTags = capDefs
      .map(c => {
        const effect = sbGetOutfitCapacityEffect(rawName, c.key);
        if (effect === 0) return '';
        const total = Math.abs(effect) * count;
        const isGrant = effect > 0;
        const style = isGrant
          ? 'background:rgba(72,187,120,0.15);color:#68d391;border-color:rgba(72,187,120,0.3);'
          : '';
        const prefix = isGrant ? '+' : '';
        return `<span class="sb-outfit-size" title="${isGrant ? 'grants' : 'uses'} ${c.key}" style="${style}">${prefix}${Math.abs(effect)}${count > 1 ? `×${count}=${prefix}${total}` : ''} ${c.label}</span>`;
      })
      .filter(Boolean)
      .join('');

    return `<div class="outfit-item">
      <span class="outfit-item__name" title="${esc(rawName)}">${esc(rawName)}</span>
      ${costTags}
      <input class="outfit-item__count" type="number" min="1" value="${esc(String(count))}"
        onchange="sbUpdateOutfitCount(${i},this.value)">
      <button class="btn btn-danger btn-xs" onclick="sbRemoveOutfit(${i})">✕</button>
    </div>`;
  }).join('');

  sbRenderOutfitSpaceBar();
}

function openAddOutfit() {
  sbRefreshLiveData();
  if (sbAllOutfits.length) {
    sbOpenOutfitPicker();
  } else {
    document.getElementById('new-outfit-name').value  = '';
    document.getElementById('new-outfit-count').value = '1';
    openModal('modal-add-outfit');
    setTimeout(() => document.getElementById('new-outfit-name').focus(), 80);
  }
}

function confirmAddOutfit() {
  const rawName = document.getElementById('new-outfit-name').value.trim().replace(/^"|"$/g, '');
  const count   = parseInt(document.getElementById('new-outfit-count').value) || 1;
  if (!rawName) { sbToast('Please enter an outfit name.', 'danger'); return; }
  if (!sbCheckOutfitSpace(rawName, count)) return;
  sbCurrentShip.outfits.push({ name: rawName, count, pluginId: null });
  const outfitObj = sbFindOutfit(rawName);
  sbAutoSlotWeapons(rawName, count, outfitObj);
  closeModal('modal-add-outfit');
  sbRenderOutfitsList(); sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw();
}

function sbUpdateOutfitCount(i, v) {
  const newCount = parseInt(v) || 1;
  const oldCount = parseInt(sbCurrentShip.outfits[i].count) || 1;
  const diff     = newCount - oldCount;
  const rawName  = sbCurrentShip.outfits[i].name.replace(/^"|"$/g, '');

  if (diff > 0) {
    if (!sbCheckOutfitSpace(rawName, diff)) {
      const inputs = document.querySelectorAll('.outfit-item__count');
      if (inputs[i]) inputs[i].value = oldCount;
      return;
    }
    const outfitObj = sbFindOutfit(rawName);
    sbAutoSlotWeapons(rawName, diff, outfitObj);
  } else if (diff < 0) {
    _sbUnslotWeapons(rawName, Math.abs(diff));
  }

  sbCurrentShip.outfits[i].count = newCount;
  sbRenderOutfitsList(); sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw();
}

function sbRemoveOutfit(i) {
  const outfit   = sbCurrentShip.outfits[i];
  const rawName  = outfit.name.replace(/^"|"$/g, '');
  const count    = parseInt(outfit.count) || 1;
  _sbUnslotWeapons(rawName, count);
  sbCurrentShip.outfits.splice(i, 1);
  sbRenderOutfitsList(); sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw();
}

function _sbUnslotWeapons(outfitName, count) {
  const clean = outfitName.replace(/^"|"$/g, '');
  let remaining = count;
  for (const arr of [sbCurrentShip.guns, sbCurrentShip.turrets]) {
    for (let i = (arr||[]).length - 1; i >= 0 && remaining > 0; i--) {
      if ((arr[i].over || '').replace(/^"|"$/g, '').trim() === clean) {
        arr[i].over = '';
        remaining--;
      }
    }
  }
}

function sbAutoSlotAllOutfits(s) {
  if (!sbAllOutfits.length) return;
  for (const o of (s.outfits || [])) {
    const rawName  = o.name.replace(/^"|"$/g, '');
    const outfitObj = sbFindOutfit(rawName);
    if (!outfitObj) continue;
    const count = parseInt(o.count) || 1;
    const gunCost    = _sbGetPortCost(outfitObj, 'gun ports');
    const turretCost = _sbGetPortCost(outfitObj, 'turret mounts');
    if (gunCost    > 0) _sbFillEmptyPorts(s.guns,    rawName, gunCost    * count);
    if (turretCost > 0) _sbFillEmptyPorts(s.turrets, rawName, turretCost * count);
  }
}

function _sbEmptyPortCount(hardpoints) {
  return (hardpoints || []).filter(hp => !hp.over || hp.over.trim() === '').length;
}

function sbCheckOutfitSpace(outfitName, count) {
  const capacityChecks = [
    { key: 'outfit space',    label: 'Outfit space',    max: sbMaxOutfitSpace(),    used: sbUsedOutfitSpace() },
    { key: 'engine capacity', label: 'Engine capacity', max: sbMaxEngineCapacity(), used: sbUsedEngineCapacity() },
    { key: 'weapon capacity', label: 'Weapon capacity', max: sbMaxWeaponCapacity(), used: sbUsedWeaponCapacity() },
    { key: 'cargo space',     label: 'Cargo space',     max: sbMaxCargoSpace(),     used: sbUsedCargoSpace() },
  ];
  for (const c of capacityChecks) {
    if (c.max <= 0) continue;
    const effect = sbGetOutfitCapacityEffect(outfitName, c.key);
    if (effect >= 0) continue;
    const cost    = Math.abs(effect);
    const adding  = cost * count;
    const newUsed = c.used + adding;
    if (newUsed > c.max) {
      const free = Math.max(0, c.max - c.used);
      sbToast(`Not enough ${c.label}. Need ${adding}, have ${free} free.`, 'danger');
      return false;
    }
  }

  const outfitObj = sbFindOutfit(outfitName);
  if (outfitObj) {
    const gunCost    = _sbGetPortCost(outfitObj, 'gun ports');
    const turretCost = _sbGetPortCost(outfitObj, 'turret mounts');

    if (gunCost > 0) {
      const needed    = gunCost * count;
      const freeGuns  = _sbEmptyPortCount(sbCurrentShip.guns);
      if (freeGuns < needed) {
        sbToast(
          `Not enough gun ports. Need ${needed} empty port${needed > 1 ? 's' : ''}, only ${freeGuns} available.`,
          'danger'
        );
        return false;
      }
    }

    if (turretCost > 0) {
      const needed       = turretCost * count;
      const freeTurrets  = _sbEmptyPortCount(sbCurrentShip.turrets);
      if (freeTurrets < needed) {
        sbToast(
          `Not enough turret mounts. Need ${needed} empty mount${needed > 1 ? 's' : ''}, only ${freeTurrets} available.`,
          'danger'
        );
        return false;
      }
    }
  }

  return true;
}

// ── Outfit picker (live data) ─────────────────────────────
function sbOpenOutfitPicker() {
  const list = document.getElementById('sb-outfit-picker-list');

  const caps = {
    'outfit space':    sbMaxOutfitSpace()    - sbUsedOutfitSpace(),
    'engine capacity': sbMaxEngineCapacity() - sbUsedEngineCapacity(),
    'weapon capacity': sbMaxWeaponCapacity() - sbUsedWeaponCapacity(),
    'cargo space':     sbMaxCargoSpace()     - sbUsedCargoSpace(),
  };

  const spaceInfoEl = document.getElementById('sb-outfit-picker-space');
  if (spaceInfoEl) {
    const lines = [];
    if (sbMaxOutfitSpace()    > 0) lines.push(`Outfit: ${caps['outfit space']} free`);
    if (sbMaxEngineCapacity() > 0) lines.push(`Engine: ${caps['engine capacity']} free`);
    if (sbMaxWeaponCapacity() > 0) lines.push(`Weapon: ${caps['weapon capacity']} free`);
    if (sbMaxCargoSpace()     > 0) lines.push(`Cargo: ${caps['cargo space']} free`);
    const freeGuns    = _sbEmptyPortCount(sbCurrentShip.guns);
    const freeTurrets = _sbEmptyPortCount(sbCurrentShip.turrets);
    if ((sbCurrentShip.guns    || []).length > 0) lines.push(`Guns: ${freeGuns} port${freeGuns !== 1 ? 's' : ''} free`);
    if ((sbCurrentShip.turrets || []).length > 0) lines.push(`Turrets: ${freeTurrets} mount${freeTurrets !== 1 ? 's' : ''} free`);
    if (lines.length) {
      spaceInfoEl.textContent = lines.join('  ·  ');
      spaceInfoEl.style.display = '';
    } else {
      spaceInfoEl.style.display = 'none';
    }
  }

  const byPlugin = {};
  for (const o of sbAllOutfits) {
    const key = o._pd || o._pn || 'Unknown';
    (byPlugin[key] = byPlugin[key] || []).push(o);
  }

  const freeGunsForPicker    = _sbEmptyPortCount(sbCurrentShip.guns);
  const freeTurretsForPicker = _sbEmptyPortCount(sbCurrentShip.turrets);
  const hasGunPorts    = (sbCurrentShip.guns    || []).length > 0;
  const hasTurretPorts = (sbCurrentShip.turrets || []).length > 0;

  list.innerHTML = Object.entries(byPlugin).map(([plugin, outfits]) => `
    <div class="sb-picker-group">
      <div class="sb-picker-group-label">${esc(plugin)}</div>
      ${outfits.map(o => {
        const name  = o.name || o.displayName || '';
        const cat   = o.category || '';
        const cost  = o.cost ? `${Number(o.cost).toLocaleString()} cr` : '';

        const costBadges = [];
        let wouldBlock = false;

        for (const [capKey, free] of Object.entries(caps)) {
          const effect  = sbGetOutfitCapacityEffect(name, capKey);
          if (effect === 0) continue;
          const maxVal  = sbShipCapacity(capKey);
          if (maxVal <= 0) continue;

          const shortLabels = {
            'outfit space':'sp','engine capacity':'eng',
            'weapon capacity':'wpn','cargo space':'cargo'
          };

          if (effect < 0) {
            const capCost = Math.abs(effect);
            const over = capCost > free;
            if (over) wouldBlock = true;
            costBadges.push(
              `<span class="sb-picker-size${over ? ' sb-picker-size--over' : ''}">${capCost} ${shortLabels[capKey]||capKey}</span>`
            );
          } else {
            costBadges.push(
              `<span class="sb-picker-size" style="background:rgba(72,187,120,0.15);color:#68d391;border-color:rgba(72,187,120,0.3);">+${effect} ${shortLabels[capKey]||capKey}</span>`
            );
          }
        }

        const gunCost    = _sbGetPortCost(o, 'gun ports');
        const turretCost = _sbGetPortCost(o, 'turret mounts');
        if (gunCost > 0 && hasGunPorts) {
          const over = gunCost > freeGunsForPicker;
          if (over) wouldBlock = true;
          costBadges.push(
            `<span class="sb-picker-size${over ? ' sb-picker-size--over' : ''}">${gunCost} gun${gunCost > 1 ? 's' : ''}</span>`
          );
        }
        if (turretCost > 0 && hasTurretPorts) {
          const over = turretCost > freeTurretsForPicker;
          if (over) wouldBlock = true;
          costBadges.push(
            `<span class="sb-picker-size${over ? ' sb-picker-size--over' : ''}">${turretCost} turret${turretCost > 1 ? 's' : ''}</span>`
          );
        }

        const pluginId = o._pn || null;
        const encoded  = btoa(unescape(encodeURIComponent(JSON.stringify({ name, pluginId }))));
        return `<div class="sb-picker-row${wouldBlock ? ' sb-picker-row--over' : ''}"
          onclick="sbAddOutfitFromPicker('${encoded}')">
          <span class="sb-picker-name">${esc(name || 'Unknown')}</span>
          <span class="sb-picker-meta" style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
            ${esc([cat, cost].filter(Boolean).join(' · '))}
            ${costBadges.join('')}
          </span>
        </div>`;
      }).join('')}
    </div>`).join('');

  document.getElementById('sb-outfit-picker-search').value = '';
  document.getElementById('sb-outfit-count-input').value   = '1';
  openModal('modal-sb-outfit-picker');
}
function sbFilterOutfitPicker(val) {
  const q = val.toLowerCase();
  document.querySelectorAll('#sb-outfit-picker-list .sb-picker-row').forEach(r => {
    r.style.display = r.querySelector('.sb-picker-name').textContent.toLowerCase().includes(q) ? '' : 'none';
  });
  document.querySelectorAll('#sb-outfit-picker-list .sb-picker-group').forEach(g => {
    g.style.display = [...g.querySelectorAll('.sb-picker-row')].some(r => r.style.display !== 'none') ? '' : 'none';
  });
}
function sbAddOutfitFromPicker(encoded) {
  const payload  = JSON.parse(decodeURIComponent(escape(atob(encoded))));
  const rawName  = payload.name.replace(/^"|"$/g, '');
  const pluginId = payload.pluginId || null;
  const count    = parseInt(document.getElementById('sb-outfit-count-input').value) || 1;
  if (!sbCheckOutfitSpace(rawName, count)) return;
  const existing = sbCurrentShip.outfits.find(o => o.name === rawName);
  if (existing) {
    existing.count += count;
    if (!existing.pluginId && pluginId) existing.pluginId = pluginId;
  } else {
    sbCurrentShip.outfits.push({ name: rawName, count, pluginId });
  }
  const outfitObj = sbFindOutfit(rawName);
  sbAutoSlotWeapons(rawName, count, outfitObj);
  closeModal('modal-sb-outfit-picker');
  sbRenderOutfitsList(); sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw();
}

// ═══════════════════════════════════════════════════════════
//  GUNS / TURRETS / BAYS
// ═══════════════════════════════════════════════════════════
function sbRenderGunsTurrets() {
  sbRenderHP('guns',    'guns-list',    'gun',     true);
  sbRenderHP('turrets', 'turrets-list', 'turret',  true);
  sbRenderBays('drones',   'drones-list',   'drone');
  sbRenderBays('fighters', 'fighters-list', 'fighter');
  sbRenderEngines();
  sbRenderLeaks();
}

function sbRenderHP(field, elId, label, showOver) {
  const el = document.getElementById(elId); if (!el) return;
  const items = sbCurrentShip[field] || [];
  const count = items.length;
  const header = count > 0
    ? `<div class="sb-hp-count-badge">${count} ${label}${count !== 1 ? 's' : ''}</div>`
    : '';
  el.innerHTML = header + (items.length ? items.map((g, i) =>
    `<div class="outfit-item" style="gap:4px;">
      <span class="sb-hp-idx">${i + 1}</span>
      <input class="text-input" style="flex:1;padding:4px 6px;font-size:0.78rem;"
        type="text" value="${esc(g.coords||'')}" placeholder="x y"
        onchange="sbUpdateHP('${field}',${i},'coords',this.value)">
      ${showOver ? `<input class="text-input" style="width:140px;padding:4px 6px;font-size:0.78rem;"
        type="text" value="${esc(g.over||'')}" placeholder='outfit "Name"'
        onchange="sbUpdateHP('${field}',${i},'over',this.value)">` : ''}
      <button class="btn btn-danger btn-xs" onclick="sbRemoveHP('${field}',${i})">✕</button>
    </div>`
  ).join('') : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">No ${label}s defined.</div>`);
}

function sbRenderBays(field, elId, label) {
  const el = document.getElementById(elId); if (!el) return;
  const items = sbCurrentShip[field] || [];
  const count = items.length;
  const header = count > 0
    ? `<div class="sb-hp-count-badge">${count} ${label} bay${count !== 1 ? 's' : ''}</div>`
    : '';
  el.innerHTML = header + (items.length ? items.map((b, i) =>
    `<div class="outfit-item" style="gap:4px;">
      <span class="sb-hp-idx">${i + 1}</span>
      <input class="text-input" style="flex:1;padding:4px 6px;font-size:0.78rem;"
        type="text" value="${esc(b.coords||'')}" placeholder="x y"
        onchange="sbUpdateHP('${field}',${i},'coords',this.value)">
      <input class="text-input" style="width:160px;padding:4px 6px;font-size:0.78rem;"
        type="text" value="${esc(b.launchEffect||'')}" placeholder='launch effect'
        onchange="sbUpdateHP('${field}',${i},'launchEffect',this.value)">
      <button class="btn btn-danger btn-xs" onclick="sbRemoveHP('${field}',${i})">✕</button>
    </div>`
  ).join('') : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">No ${label} bays defined.</div>`);
}

function sbRenderEngines() {
  const el = document.getElementById('engines-list'); if (!el) return;
  const items = sbCurrentShip.engines || [];
  const count = items.length;
  const header = count > 0
    ? `<div class="sb-hp-count-badge">${count} engine point${count !== 1 ? 's' : ''}</div>`
    : '';
  el.innerHTML = header + (items.length ? items.map((e, i) =>
    `<div class="outfit-item" style="gap:4px;">
      <span class="sb-hp-idx">${i + 1}</span>
      <input class="text-input" style="flex:1;padding:4px 6px;font-size:0.78rem;"
        type="text" value="${esc(e.coords||'')}" placeholder="x y"
        onchange="sbUpdateHP('engines',${i},'coords',this.value)">
      <input class="text-input" style="width:68px;padding:4px 6px;font-size:0.78rem;"
        type="number" step="0.1" value="${esc(e.zoom||'')}" placeholder="zoom"
        onchange="sbUpdateHP('engines',${i},'zoom',this.value)">
      <button class="btn btn-danger btn-xs" onclick="sbRemoveHP('engines',${i})">✕</button>
    </div>`
  ).join('') : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">No engine points defined.</div>`);
}

function addGunTurret(type) {
  if (type === 'engine') {
    (sbCurrentShip.engines = sbCurrentShip.engines || []).push({ coords:'0 0', zoom:'', angle:'' });
    sbRenderEngines(); sbRenderRaw(); return;
  }
  if (type === 'drone' || type === 'fighter') {
    const field = type === 'drone' ? 'drones' : 'fighters';
    (sbCurrentShip[field] = sbCurrentShip[field] || []).push({ coords:'0 0', launchEffect:'' });
    sbRenderBays(field, `${field}-list`, type); sbRenderRaw(); return;
  }
  const field = { gun:'guns', turret:'turrets' }[type];
  if (!field) return;
  (sbCurrentShip[field] = sbCurrentShip[field] || []).push({ coords:'0 0', over:'' });
  sbRenderHP(field, `${field}-list`, type, true); sbRenderRaw();
}
function sbUpdateHP(f, i, p, v) { sbCurrentShip[f][i][p] = v; sbRenderRaw(); }
function sbRemoveHP(f, i) {
  sbCurrentShip[f].splice(i,1);
  sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw();
}

function sbRenderLeaks() {
  const el = document.getElementById('leaks-list'); if (!el) return;
  const leaks = sbCurrentShip.leaks || [];
  el.innerHTML = leaks.map((l,i) =>
    `<div class="outfit-item">
      <span class="outfit-item__name">${esc(l)}</span>
      <button class="btn btn-danger btn-xs" onclick="sbRemoveLeak(${i})">✕</button>
    </div>`
  ).join('') || '<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:4px 0;">No leaks.</div>';
}
function addLeak() {
  const v = document.getElementById('leak-input').value.trim(); if (!v) return;
  (sbCurrentShip.leaks = sbCurrentShip.leaks || []).push(v);
  document.getElementById('leak-input').value = '';
  sbRenderLeaks(); sbRenderRaw();
}
function sbRemoveLeak(i) { sbCurrentShip.leaks.splice(i,1); sbRenderLeaks(); sbRenderRaw(); }

// ═══════════════════════════════════════════════════════════
//  EXPLODE
// ═══════════════════════════════════════════════════════════
function sbRenderExplodeLists() {
  sbRenderExplodeList('explode',      'explode-list');
  sbRenderExplodeList('finalExplode', 'final-explode-list');
}
function sbRenderExplodeList(field, elId) {
  const el = document.getElementById(elId); if (!el) return;
  const items = sbCurrentShip[field] || [];
  el.innerHTML = items.length ? items.map((e,i) =>
    `<div class="outfit-item">
      <input class="text-input" style="flex:1;padding:4px 6px;font-size:0.82rem;"
        type="text" value="${esc(e.name||'')}" placeholder='"tiny explosion"'
        onchange="sbUpdateExplode('${field}',${i},'name',this.value)">
      <input class="text-input" style="width:60px;padding:4px 6px;font-size:0.82rem;"
        type="number" min="1" value="${esc(String(e.count||1))}"
        onchange="sbUpdateExplode('${field}',${i},'count',this.value)">
      <button class="btn btn-danger btn-xs" onclick="sbRemoveExplode('${field}',${i})">✕</button>
    </div>`
  ).join('') : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">None.</div>`;
}
function addExplodeEffect(type) {
  const field = type === 'explode' ? 'explode' : 'finalExplode';
  (sbCurrentShip[field] = sbCurrentShip[field] || []).push({ name:'"tiny explosion"', count:1 });
  sbRenderExplodeLists(); sbRenderRaw();
}
function sbUpdateExplode(f, i, p, v) {
  sbCurrentShip[f][i][p] = p==='count' ? (parseInt(v)||1) : v; sbRenderRaw();
}
function sbRemoveExplode(f, i) { sbCurrentShip[f].splice(i,1); sbRenderExplodeLists(); sbRenderRaw(); }

// ═══════════════════════════════════════════════════════════
//  ES GENERATOR
// ═══════════════════════════════════════════════════════════
function sbGenerateES(s) {
  const T  = '\t';
  const TT = '\t\t';
  const L  = [];

  L.push(`ship "${s.name || 'Unnamed'}"${s.variant ? ' ' + s.variant : ''}`);
  if (s.plural)    L.push(`${T}plural "${s.plural}"`);
  if (s.sprite)    L.push(`${T}sprite "${s.sprite}"`);
  if (s.thumbnail) L.push(`${T}thumbnail "${s.thumbnail}"`);

  const attrs    = s.attributes || {};
  const attrKeys = Object.keys(attrs);
  const hasMass  = s.mass && s.mass !== '';
  const hasDrag  = s.drag && s.drag !== '';

  if (attrKeys.length || hasMass || hasDrag) {
    L.push(`${T}attributes`);

    if (attrs.category != null) {
      L.push(`${TT}category "${attrs.category}"`);
    }

    if (attrs.licenses && typeof attrs.licenses === 'object') {
      const licKeys = Object.keys(attrs.licenses);
      if (licKeys.length) {
        L.push(`${TT}licenses`);
        for (const lic of licKeys) L.push(`${TT}${T}"${lic}"`);
      }
    }

    if (hasMass) L.push(`${TT}mass ${s.mass}`);
    if (hasDrag) L.push(`${TT}drag ${s.drag}`);

    const SKIP = new Set(['category', 'licenses', 'mass', 'drag', 'weapon']);
    for (const k of attrKeys) {
      if (SKIP.has(k)) continue;
      const v = attrs[k];
      if (v === '' || v == null) continue;
      const vStr   = String(v);
      const isNum  = /^-?[0-9]*\.?[0-9]+$/.test(vStr);
      const valOut = isNum ? vStr : `"${vStr}"`;
      L.push(`${TT}"${k}" ${valOut}`);
    }

    if (attrs.weapon && typeof attrs.weapon === 'object') {
      L.push(`${TT}weapon`);
      for (const [wk, wv] of Object.entries(attrs.weapon)) {
        if (wv === '' || wv == null) continue;
        const wvStr  = String(wv);
        const wIsNum = /^-?[0-9]*\.?[0-9]+$/.test(wvStr);
        L.push(`${TT}${T}"${wk}" ${wIsNum ? wvStr : `"${wvStr}"`}`);
      }
    }
  }

  if ((s.outfits || []).length) {
    L.push(`${T}outfits`);
    for (const o of s.outfits) {
      const count    = parseInt(o.count) || 1;
      const quoted   = o.name.startsWith('"') ? o.name : `"${o.name}"`;
      L.push(`${TT}${quoted}${count > 1 ? ' ' + count : ''}`);
    }
  }

  for (const e of (s.engines || [])) {
    const parts = (e.coords || '0 0').split(/\s+/);
    const x = parts[0] || '0', y = parts[1] || '0';
    const zoom = e.zoom && e.zoom !== '' ? ` ${e.zoom}` : '';
    L.push(`${T}engine ${x} ${y}${zoom}`);
  }

  for (const g of (s.guns || [])) {
    const raw  = (g.over || '').trim().replace(/^"|"$/g, '');
    const over = raw ? ` "${raw}"` : '';
    L.push(`${T}gun ${g.coords || '0 0'}${over}`);
  }

  for (const g of (s.turrets || [])) {
    const raw  = (g.over || '').trim().replace(/^"|"$/g, '');
    const over = raw ? ` "${raw}"` : '';
    L.push(`${T}turret ${g.coords || '0 0'}${over}`);
  }

  for (const d of (s.drones || [])) {
    const parts = (d.coords || '0 0').split(/\s+/);
    L.push(`${T}bay "Drone" ${parts[0] || '0'} ${parts[1] || '0'}`);
    if (d.launchEffect) L.push(`${TT}"launch effect" "${d.launchEffect}"`);
  }
  for (const f of (s.fighters || [])) {
    const parts = (f.coords || '0 0').split(/\s+/);
    L.push(`${T}bay "Fighter" ${parts[0] || '0'} ${parts[1] || '0'}`);
    if (f.launchEffect) L.push(`${TT}"launch effect" "${f.launchEffect}"`);
  }

  for (const l of (s.leaks || [])) L.push(`${T}leak ${l}`);

  for (const e of (s.explode || [])) {
    const count = parseInt(e.count) || 1;
    L.push(`${T}explode ${e.name}${count > 1 ? ' ' + count : ''}`);
  }

  for (const e of (s.finalExplode || [])) {
    L.push(`${T}"final explode" ${e.name}`);
  }

  if (s.description) {
    const paras = s.description.split(/\n/);
    for (const para of paras) {
      if (para.trim() !== '') L.push(`${T}description "${para}"`);
    }
  }

  for (const l of (s.extraLines || [])) L.push(l);

  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════
//  ES PARSER
// ═══════════════════════════════════════════════════════════
function sbParseES(text) {
  const ships = []; let cur = null;
  let block = null;
  let subblock = null;
  let lastBay = null;

  const flush = () => { if (cur) ships.push(cur); };

  for (const raw of text.split('\n')) {
    const t      = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      const m = t.match(/^ship\s+("([^"]+)"|(\S+))\s*(.*)$/);
      if (m) {
        flush();
        cur = sbBlank();
        cur.name    = m[2] || m[3] || '';
        cur.variant = (m[4] || '').trim();
        block = null; subblock = null; lastBay = null;
        continue;
      }
      flush(); cur = null; continue;
    }
    if (!cur) continue;

    if (indent === 1) {
      block = null; subblock = null; lastBay = null;

      if (t.startsWith('sprite '))           { cur.sprite      = sbStripQ(t.slice(7));  continue; }
      if (t.startsWith('thumbnail '))        { cur.thumbnail   = sbStripQ(t.slice(10)); continue; }
      if (t.startsWith('plural '))           { cur.plural      = sbStripQ(t.slice(7));  continue; }
      if (t === 'attributes')                { block = 'attributes'; continue; }
      if (t === 'outfits')                   { block = 'outfits';    continue; }

      if (t.startsWith('description ')) {
        const para = sbStripQ(t.slice(12));
        cur.description = cur.description ? cur.description + '\n' + para : para;
        continue;
      }

      if (t.startsWith('engine ')) {
        const p = sbTok(t.slice(7));
        cur.engines.push({
          coords: p.slice(0, 2).join(' '),
          zoom:   p[2] || '',
          angle:  p[3] || '',
        });
        continue;
      }

      if (t.startsWith('gun '))    { sbPHP(cur, 'guns',    t.slice(4)); continue; }
      if (t.startsWith('turret ')) { sbPHP(cur, 'turrets', t.slice(7)); continue; }

      if (t.startsWith('bay ')) {
        const p    = sbTok(t.slice(4));
        const type = sbStripQ(p[0] || '');
        const coords = p.slice(1, 3).join(' ');
        if (type === 'Fighter') {
          cur.fighters.push({ coords, launchEffect: '' });
          lastBay = { field: 'fighters', idx: cur.fighters.length - 1 };
        } else {
          cur.drones.push({ coords, launchEffect: '' });
          lastBay = { field: 'drones', idx: cur.drones.length - 1 };
        }
        continue;
      }

      if (t === 'drone')   { cur.drones.push({ coords: '', launchEffect: '' }); continue; }
      if (t === 'fighter') { cur.fighters.push({ coords: '', launchEffect: '' }); continue; }

      if (t.startsWith('leak '))             { cur.leaks.push(t.slice(5)); continue; }
      if (t.startsWith('explode '))          { sbPEx(cur, 'explode',      t.slice(8));  continue; }
      if (t.startsWith('"final explode" '))  { sbPEx(cur, 'finalExplode', t.slice(16)); continue; }

      cur.extraLines.push(raw); continue;
    }

    if (indent === 2) {
      if (lastBay && t.startsWith('"launch effect"')) {
        const p   = sbTok(t);
        const val = sbStripQ(p[1] || '');
        cur[lastBay.field][lastBay.idx].launchEffect = val;
        continue;
      }

      if (block === 'attributes') {
        const p = sbTok(t);
        if (!p.length) continue;
        const key = sbStripQ(p[0]);

        if (key === 'licenses') { subblock = 'licenses'; continue; }
        if (key === 'weapon')   { subblock = 'weapon';   cur.attributes.weapon = {}; continue; }

        const val = p.slice(1).join(' ');
        if (key === 'mass') { cur.mass = val; continue; }
        if (key === 'drag') { cur.drag = val; continue; }
        cur.attributes[key] = val;
        continue;
      }

      if (block === 'outfits') {
        const p = sbTok(t);
        if (p.length) {
          const name  = p[0].startsWith('"') ? p[0] : `"${p[0]}"`;
          cur.outfits.push({ name, count: parseInt(p[1]) || 1, pluginId: null });
        }
        continue;
      }

      cur.extraLines.push(raw); continue;
    }

    if (indent === 3 && block === 'attributes') {
      const p   = sbTok(t);
      const key = sbStripQ(p[0] || '');
      const val = p.slice(1).join(' ');

      if (subblock === 'licenses') {
        cur.attributes.licenses = cur.attributes.licenses || {};
        cur.attributes.licenses[key] = true;
        continue;
      }
      if (subblock === 'weapon') {
        cur.attributes.weapon = cur.attributes.weapon || {};
        cur.attributes.weapon[key] = val;
        continue;
      }
    }

    cur.extraLines.push(raw);
  }
  flush();
  return ships;
}
function sbPHP(cur, f, rest) { const p=sbTok(rest); cur[f].push({coords:p.slice(0,2).join(' '),over:p.slice(2).join(' ')}); }
function sbPEx(cur, f, rest) { const p=sbTok(rest); (cur[f]=cur[f]||[]).push({name:p[0]||'"tiny explosion"',count:parseInt(p[1])||1}); }
function sbTok(str) {
  const t=[]; let i=0;
  while(i<str.length){
    if(str[i]===' '||str[i]==='\t'){i++;continue;}
    if(str[i]==='"'){const e=str.indexOf('"',i+1);if(e===-1){t.push(str.slice(i));break;}t.push(str.slice(i,e+1));i=e+1;}
    else{let j=i;while(j<str.length&&str[j]!==' '&&str[j]!=='\t')j++;t.push(str.slice(i,j));i=j;}
  }
  return t;
}
function sbStripQ(s){s=s.trim();return(s.startsWith('"')&&s.endsWith('"'))?s.slice(1,-1):s;}

// ═══════════════════════════════════════════════════════════
//  RAW TAB
// ═══════════════════════════════════════════════════════════
let sbRawDirty = false;
function sbRenderRaw() {
  if (sbRawDirty) return;
  const el = document.getElementById('raw-output');
  if (el && sbCurrentShip) el.value = sbGenerateES(sbCurrentShip);
}
function onRawEdit() { sbRawDirty = true; }
function importRaw() {
  const parsed = sbParseES(document.getElementById('raw-output').value);
  if (!parsed.length) { sbToast('Could not parse ship data.', 'danger'); return; }
  Object.assign(sbCurrentShip, parsed[0]);
  sbRawDirty = false;
  sbPopulateBuilder();
  sbToast('Imported from raw text.', 'success');
}
function copyOutput() {
  navigator.clipboard.writeText(document.getElementById('raw-output').value)
    .then(() => sbToast('Copied!', 'success')).catch(() => sbToast('Copy failed.', 'danger'));
}

function saveShip() {
  onBuilderChange();
  if (!sbCurrentShip.name) { sbToast('Ship must have a name.', 'danger'); document.getElementById('ship-name').focus(); return; }
  if (sbEditIdx === -1) { sbFleet.push(JSON.parse(JSON.stringify(sbCurrentShip))); sbEditIdx = sbFleet.length - 1; }
  else sbFleet[sbEditIdx] = JSON.parse(JSON.stringify(sbCurrentShip));
  sbSave();
  if (window.DataLoader && window.DataLoader.refreshLocalBuilds) {
    window.DataLoader.refreshLocalBuilds();
  }
  const titleEl = document.getElementById('builder-page-title');
  if (titleEl) titleEl.textContent = `✏️ Editing: ${sbCurrentShip.name}`;
  sbToast('Ship saved!', 'success');
}

// ═══════════════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════════════
function renderExportChecklist() {
  const cl = document.getElementById('export-checklist'); if (!cl) return;
  if (!sbFleet.length) { cl.innerHTML='<div style="color:var(--c-text-muted);font-style:italic;">No ships in fleet.</div>'; return; }
  cl.innerHTML = sbFleet.map((s,i) =>
    `<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--r-sm);background:var(--c-surface-3);margin-bottom:6px;cursor:pointer;">
      <input type="checkbox" id="export-chk-${i}" checked style="accent-color:var(--c-accent);width:16px;height:16px;">
      <span style="font-size:0.92rem;color:var(--c-text-mid);">${esc(s.name||'Unnamed')} <span style="color:var(--c-text-dim);font-size:0.82rem;">${esc(s.variant||'')}</span></span>
    </label>`
  ).join('');
}
function sbGetExportText() {
  return sbFleet.filter((_,i)=>document.getElementById(`export-chk-${i}`)?.checked).map(s=>sbGenerateES(s)).join('\n\n');
}
function generateExport() { const el=document.getElementById('export-output'); if(el) el.textContent=sbGetExportText()||'(No ships selected)'; }
function copyExport()     { const t=sbGetExportText(); if(!t){sbToast('Nothing to copy.','danger');return;} navigator.clipboard.writeText(t).then(()=>sbToast('Copied!','success')).catch(()=>sbToast('Copy failed.','danger')); }
function downloadExport() { const t=sbGetExportText(); if(!t){sbToast('Nothing to export.','danger');return;} sbDL(t,'ships.txt'); sbToast('Downloaded ships.txt','success'); }
function exportAll()      { const t=sbFleet.map(s=>sbGenerateES(s)).join('\n\n'); if(!t){sbToast('No ships.','danger');return;} sbDL(t,'fleet.txt'); sbToast('Downloaded fleet.txt','success'); }
function sbDL(text, name) { const u=URL.createObjectURL(new Blob([text],{type:'text/plain'})); Object.assign(document.createElement('a'),{href:u,download:name}).click(); URL.revokeObjectURL(u); }

// ═══════════════════════════════════════════════════════════
//  IMPORT (paste)
// ═══════════════════════════════════════════════════════════
function openImport() { document.getElementById('import-text').value=''; openModal('modal-import'); }
function doImport() {
  const parsed = sbParseES(document.getElementById('import-text').value);
  if (!parsed.length) { sbToast('Could not parse any ships.', 'danger'); return; }
  for (const s of parsed) { s.id = Date.now()+Math.random(); sbFleet.push(s); }
  sbSave(); closeModal('modal-import'); renderFleet(); renderExportChecklist();
  sbToast(`Imported ${parsed.length} ship(s)!`, 'success');
}

// ═══════════════════════════════════════════════════════════
//  MODALS / TOAST / UTIL
// ═══════════════════════════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

let _sbToastTimer = null;
function sbToast(msg, type='') {
  const el = document.getElementById('toast'); if (!el) return;
  el.textContent = msg;
  el.className   = 'toast show' + (type ? ' '+type : '');
  clearTimeout(_sbToastTimer);
  _sbToastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  sbLoad();
  renderFleet();
  renderExportChecklist();
  initBuilderTabs();

  document.querySelectorAll('.modal-overlay').forEach(o =>
    o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); })
  );
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.active').forEach(o => closeModal(o.id));
  });

  const akEl = document.getElementById('new-attr-key');
  const avEl = document.getElementById('new-attr-val');
  if (akEl) akEl.addEventListener('keydown', e => { if (e.key==='Enter') confirmAddAttr(); });
  if (avEl) avEl.addEventListener('keydown', e => { if (e.key==='Enter') confirmAddAttr(); });

  if (window.DataLoader) {
    window.DataLoader.onReady(() => {
      sbRefreshLiveData();
      sbRenderActivePluginList();
      sbToast('Game data loaded — ship & outfit pickers ready.', 'success');
    });
  } else {
    console.warn('[shipBuilder] dataLoader.js not loaded — outfit/ship pickers will be empty.');
  }

  // Re-render plugin list and live data whenever the active plugin set changes.
  // This fires when:
  //   - DataLoader.initDefaultPlugins() selects the default on first load
  //   - User confirms the plugin picker
  //   - User reorders or removes a plugin via the sorter rows
  //   - A ship is saved (pluginsChanged is fired to refresh Local Builds)
  document.addEventListener('pluginsChanged', () => {
    sbRefreshLiveData();
    sbRenderActivePluginList();
    // Re-render plugin picker list if it's currently open so checkboxes stay in sync
    const pickerOpen = document.getElementById('modal-sb-plugin-picker')?.classList.contains('active');
    if (pickerOpen) {
      const searchVal = document.getElementById('sb-plugin-picker-search')?.value || '';
      sbRenderPluginPickerList(searchVal);
    }
  });

  document.addEventListener('dataLoaded', () => {
    sbRefreshLiveData();
    sbRenderActivePluginList();
  });
});
