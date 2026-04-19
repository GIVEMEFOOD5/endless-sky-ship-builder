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
  const DL = window.DataLoader;
  if (DL && DL.isReady()) {
    sbAllShips   = DL.getAllShips().map(s => ({ ...s, _pn: s._pluginName, _pd: s._pluginDisplay }));
    sbAllOutfits = DL.getAllOutfits().map(o => ({ ...o, _pn: o._pluginName, _pd: o._pluginDisplay }));
    const defKeys = DL.getAttrKeys();
    sbAttrKeys   = [...new Set([..._SB_ATTR_FALLBACK, ...defKeys])].sort();
  } else {
    // DataLoader not ready yet — use fallback keys, empty ship/outfit lists
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
function sbSave() {
  try { localStorage.setItem(SB_STORAGE_KEY, JSON.stringify(sbFleet)); } catch(e) {}
}
function sbLoad() {
  try { const d = localStorage.getItem(SB_STORAGE_KEY); if (d) sbFleet = JSON.parse(d); }
  catch(e) { sbFleet = []; }
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

  // Attributes — skip nested objects (e.g. weapon sub-block, licenses)
  if (src.attributes && typeof src.attributes === 'object') {
    for (const [k, v] of Object.entries(src.attributes)) {
      if (typeof v !== 'object') s.attributes[k] = String(v);
    }
  }
  // drag / mass may also live at top-level in some parser outputs
  if (src.drag != null) s.drag = String(src.drag);
  if (src.mass != null) s.mass = String(src.mass);

  // ── Outfits ───────────────────────────────────────────────
  // Handle: outfitMap { "Name": count }, outfits (array or object map)
  const outfitSource = src.outfitMap || src.outfits;
  if (outfitSource && typeof outfitSource === 'object' && !Array.isArray(outfitSource)) {
    for (const [n, c] of Object.entries(outfitSource)) {
      s.outfits.push({ name: n.startsWith('"') ? n : `"${n}"`, count: Number(c) || 1 });
    }
  } else if (Array.isArray(outfitSource)) {
    const map = {};
    for (const o of outfitSource) {
      const n = typeof o === 'string' ? o : (o.name || '');
      const c = (typeof o === 'object' && o.count) ? o.count : 1;
      map[n] = (map[n] || 0) + Number(c);
    }
    for (const [n, c] of Object.entries(map)) {
      s.outfits.push({ name: n.startsWith('"') ? n : `"${n}"`, count: c });
    }
  }

  // ── Guns ─────────────────────────────────────────────────
  // gun key may be "gun", "over", or "weapon" depending on parser
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
  // Handle both array form and scalar "small explosion": 40 form
  const explodeSrc = src.explode || [];
  for (const e of explodeSrc) {
    s.explode.push({
      name:  typeof e === 'string' ? `"${e}"` : `"${e.name || 'tiny explosion'}"`,
      count: e.count || 1,
    });
  }
  // Also pick up named explosion scalars at top level e.g. "small explosion": 40
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

// ── Outfit space helpers ──────────────────────────────────
/** Look up an outfit's "outfit space" cost from allData. Returns 0 if unknown. */
function sbGetOutfitSize(outfitName) {
  // outfitName may be quoted e.g. `"Blaster"` — strip quotes for lookup
  const raw = outfitName.replace(/^"|"$/g, '').trim();
  for (const o of sbAllOutfits) {
    if ((o.name || '') === raw || (o.displayName || '') === raw) {
      return Math.abs(Number((o.attributes && o.attributes['outfit space']) || 0));
    }
  }
  return 0;
}

/** Total outfit space consumed by all installed outfits. */
function sbUsedOutfitSpace() {
  if (!sbCurrentShip) return 0;
  return (sbCurrentShip.outfits || []).reduce((total, o) => {
    return total + sbGetOutfitSize(o.name) * (parseInt(o.count) || 1);
  }, 0);
}

/** Max outfit space from ship attributes. */
function sbMaxOutfitSpace() {
  if (!sbCurrentShip) return 0;
  return Number((sbCurrentShip.attributes || {})['outfit space']) || 0;
}

function sbUpdateQuickStats() {
  const el = document.getElementById('quick-stats');
  if (!el || !sbCurrentShip) return;
  const s = sbCurrentShip, a = s.attributes || {};
  const used = sbUsedOutfitSpace();
  const max  = sbMaxOutfitSpace();
  const pct  = max > 0 ? Math.min(100, Math.round(used / max * 100)) : 0;
  const overLimit = max > 0 && used > max;
  const spaceColor = overLimit ? 'var(--c-danger-hi)' : (pct > 90 ? 'var(--c-warn-text)' : 'var(--c-accent-text)');

  const qs = [
    { label:'Shields',       value: a.shields            || '—' },
    { label:'Hull',          value: a.hull               || '—' },
    { label:'Mass',          value: s.mass || a.mass     || '—' },
    { label:'Engine Cap.',   value: a['engine capacity'] || '—' },
    { label:'Weapon Cap.',   value: a['weapon capacity'] || '—' },
    { label:'Guns',          value: (s.guns||[]).length },
    { label:'Turrets',       value: (s.turrets||[]).length },
    { label:'Drones',        value: (s.drones||[]).length },
    { label:'Fighters',      value: (s.fighters||[]).length },
    { label:'Engines',       value: (s.engines||[]).length },
  ];
  el.innerHTML = qs.map(q =>
    `<div class="qs-card"><div class="qs-label">${q.label}</div><div class="qs-value">${q.value}</div></div>`
  ).join('') + (max > 0 ? `
    <div class="qs-card qs-card--wide" style="grid-column:1/-1;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
        <div class="qs-label">Outfit Space</div>
        <div class="qs-value" style="color:${spaceColor};font-size:1rem;">
          ${used} / ${max}${overLimit ? ' ⚠ OVER' : ''}
        </div>
      </div>
      <div class="sb-space-bar-track">
        <div class="sb-space-bar-fill" style="width:${pct}%;background:${overLimit?'var(--c-danger-hi)':pct>90?'#f59e0b':'var(--c-accent)'};"></div>
      </div>
    </div>` : '');

  // Also update the outfit space bar inside the outfits tab if it exists
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
  const attrs = sbCurrentShip.attributes || {};
  const keys  = Object.keys(attrs);
  if (!keys.length) {
    el.innerHTML = '<div style="color:var(--c-text-muted);font-size:0.88rem;font-style:italic;padding:10px 0;">No attributes. Click "+ Add Attribute" to add one.</div>';
    return;
  }
  const assigned = new Set();
  let html = '';
  for (const [group, gkeys] of Object.entries(SB_ATTR_GROUPS)) {
    const present = gkeys.filter(k => k in attrs);
    if (!present.length) continue;
    html += `<div class="attr-section"><div class="attr-section-title">${group}</div>`;
    for (const k of present) { assigned.add(k); html += sbAttrRow(k, attrs[k]); }
    html += '</div>';
  }
  const other = keys.filter(k => !assigned.has(k));
  if (other.length) {
    html += '<div class="attr-section"><div class="attr-section-title">Other</div>';
    for (const k of other) html += sbAttrRow(k, attrs[k]);
    html += '</div>';
  }
  el.innerHTML = html;
}
function sbAttrRow(k, v) {
  const sk = esc(k), sv = esc(String(v));
  const hint = sbAttrHint(k);
  const tip  = hint ? ` title="${esc(hint)}"` : '';
  return `<div class="attr-row">
    <span class="attr-key"${tip}>${sk}</span>
    <input class="attr-val-input" type="text" value="${sv}" data-key="${sk}"
      onchange="sbUpdateAttrVal(this)" onblur="sbUpdateAttrVal(this)">
    <button class="btn btn-danger btn-xs" onclick="sbRemoveAttr('${sk.replace(/'/g,"\\'")}')">✕</button>
  </div>`;
}
function sbUpdateAttrVal(inp) {
  sbCurrentShip.attributes[inp.dataset.key] = inp.value;
  sbUpdateQuickStats(); sbRenderRaw();
}
function sbRemoveAttr(k) {
  delete sbCurrentShip.attributes[k];
  sbRenderAttrList(); sbUpdateQuickStats(); sbRenderRaw();
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
  sbCurrentShip.attributes[k] = v;
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

/** Render the outfit space bar inside the outfits tab header */
function sbRenderOutfitSpaceBar() {
  const el = document.getElementById('outfit-space-bar-wrap');
  if (!el || !sbCurrentShip) return;
  const used = sbUsedOutfitSpace();
  const max  = sbMaxOutfitSpace();
  if (max <= 0) { el.style.display = 'none'; return; }
  el.style.display = '';
  const pct       = Math.min(100, Math.round(used / max * 100));
  const remaining = max - used;
  const over      = used > max;
  const barColor  = over ? 'var(--c-danger-hi)' : pct > 90 ? '#f59e0b' : 'var(--c-accent)';
  const textColor = over ? 'var(--c-danger-hi)' : pct > 90 ? 'var(--c-warn-text)' : 'var(--c-accent-text)';
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
      <span style="font-size:0.78rem;font-weight:700;color:#63b3ed;text-transform:uppercase;letter-spacing:.1em;">Outfit Space</span>
      <span style="font-size:0.9rem;font-weight:700;color:${textColor};font-variant-numeric:tabular-nums;">
        ${used} / ${max} <span style="font-size:0.76rem;color:var(--c-text-dim);">(${remaining >= 0 ? remaining + ' free' : Math.abs(remaining) + ' over'})</span>
        ${over ? '<span style="color:var(--c-danger-hi);margin-left:6px;">⚠ OVER LIMIT</span>' : ''}
      </span>
    </div>
    <div class="sb-space-bar-track">
      <div class="sb-space-bar-fill" style="width:${pct}%;background:${barColor};"></div>
    </div>`;
}

function sbRenderOutfitsList() {
  const outfits = sbCurrentShip.outfits || [];
  const emptyEl = document.getElementById('outfits-empty');
  if (emptyEl) emptyEl.style.display = outfits.length ? 'none' : 'block';
  const el = document.getElementById('outfits-list');
  if (!el) return;

  el.innerHTML = outfits.map((o, i) => {
    const size     = sbGetOutfitSize(o.name);
    const count    = parseInt(o.count) || 1;
    const totalSz  = size * count;
    const sizeTag  = size > 0
      ? `<span class="sb-outfit-size" title="Outfit space per unit">${size} sp${count > 1 ? ` × ${count} = ${totalSz}` : ''}</span>`
      : '';
    return `<div class="outfit-item">
      <span class="outfit-item__name" title="${esc(o.name)}">${esc(o.name)}</span>
      ${sizeTag}
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
  const name  = document.getElementById('new-outfit-name').value.trim();
  const count = parseInt(document.getElementById('new-outfit-count').value) || 1;
  if (!name) { sbToast('Please enter an outfit name.', 'danger'); return; }
  const quoted = name.startsWith('"') ? name : `"${name}"`;
  if (!sbCheckOutfitSpace(quoted, count)) return;
  sbCurrentShip.outfits.push({ name: quoted, count });
  closeModal('modal-add-outfit');
  sbRenderOutfitsList(); sbUpdateQuickStats(); sbRenderRaw();
}
function sbUpdateOutfitCount(i, v) {
  const newCount = parseInt(v) || 1;
  const oldCount = sbCurrentShip.outfits[i].count || 1;
  const diff     = newCount - oldCount;
  if (diff > 0) {
    const name = sbCurrentShip.outfits[i].name;
    if (!sbCheckOutfitSpace(name, diff)) {
      // Revert the input
      const inputs = document.querySelectorAll('.outfit-item__count');
      if (inputs[i]) inputs[i].value = oldCount;
      return;
    }
  }
  sbCurrentShip.outfits[i].count = newCount;
  sbRenderOutfitsList(); sbUpdateQuickStats(); sbRenderRaw();
}
function sbRemoveOutfit(i) {
  sbCurrentShip.outfits.splice(i, 1);
  sbRenderOutfitsList(); sbUpdateQuickStats(); sbRenderRaw();
}

/**
 * Check whether adding `count` of `outfitName` fits within outfit space.
 * Shows a toast warning but does NOT block if outfit space is 0 (unknown).
 * Returns true if ok to proceed, false if blocked.
 */
function sbCheckOutfitSpace(outfitName, count) {
  const max  = sbMaxOutfitSpace();
  if (max <= 0) return true; // no limit defined — always allow
  const size    = sbGetOutfitSize(outfitName);
  if (size <= 0) return true; // outfit size unknown — allow but can't check
  const used    = sbUsedOutfitSpace();
  const adding  = size * count;
  const newUsed = used + adding;
  if (newUsed > max) {
    const remaining = max - used;
    sbToast(
      `Not enough outfit space. Need ${adding}, have ${remaining >= 0 ? remaining : 0} free.`,
      'danger'
    );
    return false;
  }
  return true;
}

// ── Outfit picker (live data) ─────────────────────────────
function sbOpenOutfitPicker() {
  const list = document.getElementById('sb-outfit-picker-list');
  const max  = sbMaxOutfitSpace();
  const used = sbUsedOutfitSpace();
  const free = max > 0 ? max - used : Infinity;

  const byPlugin = {};
  for (const o of sbAllOutfits) {
    const key = o._pd || o._pn || 'Unknown';
    (byPlugin[key] = byPlugin[key] || []).push(o);
  }

  // Update space info in picker header
  const spaceInfoEl = document.getElementById('sb-outfit-picker-space');
  if (spaceInfoEl && max > 0) {
    spaceInfoEl.textContent = `${used} / ${max} used — ${free} free`;
    spaceInfoEl.style.color = used > max ? 'var(--c-danger-hi)' : 'var(--c-text-muted)';
    spaceInfoEl.style.display = '';
  } else if (spaceInfoEl) {
    spaceInfoEl.style.display = 'none';
  }

  list.innerHTML = Object.entries(byPlugin).map(([plugin, outfits]) => `
    <div class="sb-picker-group">
      <div class="sb-picker-group-label">${esc(plugin)}</div>
      ${outfits.map(o => {
        const cat      = o.category || '';
        const cost     = o.cost ? `${Number(o.cost).toLocaleString()} cr` : '';
        const size     = Math.abs(Number((o.attributes && o.attributes['outfit space']) || 0));
        const sizeTag  = size > 0 ? `<span class="sb-picker-size${size > free ? ' sb-picker-size--over' : ''}">${size} sp</span>` : '';
        const encoded  = btoa(unescape(encodeURIComponent(o.name || o.displayName || '')));
        const encodedSize = btoa(String(size));
        return `<div class="sb-picker-row${size > free && max > 0 ? ' sb-picker-row--over' : ''}"
          onclick="sbAddOutfitFromPicker('${encoded}','${encodedSize}')">
          <span class="sb-picker-name">${esc(o.name || o.displayName || 'Unknown')}</span>
          <span class="sb-picker-meta">${esc([cat, cost].filter(Boolean).join(' · '))}${sizeTag}</span>
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
function sbAddOutfitFromPicker(encoded, encodedSize) {
  const rawName = decodeURIComponent(escape(atob(encoded)));
  const count   = parseInt(document.getElementById('sb-outfit-count-input').value) || 1;
  const quoted  = rawName.startsWith('"') ? rawName : `"${rawName}"`;
  if (!sbCheckOutfitSpace(quoted, count)) return;
  const existing = sbCurrentShip.outfits.find(o => o.name === quoted);
  if (existing) existing.count += count;
  else sbCurrentShip.outfits.push({ name: quoted, count });
  closeModal('modal-sb-outfit-picker');
  sbRenderOutfitsList(); sbUpdateQuickStats(); sbRenderRaw();
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

/** Bays show coords + launchEffect (read-only label), no weapon override */
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
  const T = '\t', L = [];
  L.push(`ship "${s.name||'Unnamed'}"${s.variant ? ' '+s.variant : ''}`);
  if (s.plural)    L.push(`${T}plural "${s.plural}"`);
  if (s.sprite)    L.push(`${T}sprite "${s.sprite}"`);
  if (s.thumbnail) L.push(`${T}thumbnail "${s.thumbnail}"`);
  const attrs = s.attributes || {};
  if (Object.keys(attrs).length || s.mass || s.drag) {
    L.push(`${T}attributes`);
    if (attrs.category != null) L.push(`${T}${T}category "${attrs.category}"`);
    if (s.mass) L.push(`${T}${T}mass ${s.mass}`);
    if (s.drag) L.push(`${T}${T}drag ${s.drag}`);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'category' || v === '' || v == null) continue;
      const needsQ = /[^0-9.\-]/.test(String(v)) && !/^-?[0-9]+(\.[0-9]+)?$/.test(String(v));
      L.push(`${T}${T}${k} ${needsQ ? `"${v}"` : v}`);
    }
  }
  if ((s.outfits||[]).length) {
    L.push(`${T}outfits`);
    for (const o of s.outfits) L.push(`${T}${T}${o.name}${(parseInt(o.count)||1)>1?' '+o.count:''}`);
  }
  for (const g of (s.guns     ||[])) L.push(`${T}gun ${g.coords||'0 0'}${g.over?' '+g.over:''}`);
  for (const g of (s.turrets  ||[])) L.push(`${T}turret ${g.coords||'0 0'}${g.over?' '+g.over:''}`);
  for (const _ of (s.drones   ||[])) L.push(`${T}drone`);
  for (const _ of (s.fighters ||[])) L.push(`${T}fighter`);
  for (const l of (s.leaks    ||[])) L.push(`${T}leak ${l}`);
  for (const e of (s.explode  ||[])) L.push(`${T}explode ${e.name}${e.count>1?' '+e.count:''}`);
  for (const e of (s.finalExplode||[])) L.push(`${T}"final explode" ${e.name}${e.count>1?' '+e.count:''}`);
  if (s.description) L.push(`${T}description "${s.description.replace(/\n/g,`\n${T}description `)}"`);
  for (const l of (s.extraLines||[])) L.push(l);
  return L.join('\n');
}

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
    .then(()=>sbToast('Copied!','success')).catch(()=>sbToast('Copy failed.','danger'));
}

// ═══════════════════════════════════════════════════════════
//  ES PARSER
// ═══════════════════════════════════════════════════════════
function sbParseES(text) {
  const ships = []; let cur = null, block = null;
  const flush = () => { if (cur) ships.push(cur); };
  for (const raw of text.split('\n')) {
    const t = raw.trim(); if (!t || t.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const m = t.match(/^ship\s+("([^"]+)"|(\S+))\s*(.*)$/);
      if (m) { flush(); cur = sbBlank(); cur.name = m[2]||m[3]||''; cur.variant = (m[4]||'').trim(); block = null; continue; }
      flush(); cur = null; continue;
    }
    if (!cur) continue;
    if (indent === 1) {
      block = null;
      if (t.startsWith('sprite '))         { cur.sprite      = sbStripQ(t.slice(7));  continue; }
      if (t.startsWith('thumbnail '))       { cur.thumbnail   = sbStripQ(t.slice(10)); continue; }
      if (t.startsWith('plural '))          { cur.plural      = sbStripQ(t.slice(7));  continue; }
      if (t.startsWith('description '))     { cur.description = (cur.description?cur.description+'\n':'')+sbStripQ(t.slice(12)); continue; }
      if (t === 'attributes')               { block='attributes'; continue; }
      if (t === 'outfits')                  { block='outfits';    continue; }
      if (t.startsWith('gun '))             { sbPHP(cur,'guns',t.slice(4));        continue; }
      if (t.startsWith('turret '))          { sbPHP(cur,'turrets',t.slice(7));     continue; }
      if (t.startsWith('drone'))            { cur.drones.push({coords:'',over:''}); continue; }
      if (t.startsWith('fighter'))          { cur.fighters.push({coords:'',over:''}); continue; }
      if (t.startsWith('leak '))            { cur.leaks.push(t.slice(5)); continue; }
      if (t.startsWith('explode '))         { sbPEx(cur,'explode',t.slice(8));     continue; }
      if (t.startsWith('"final explode" ')) { sbPEx(cur,'finalExplode',t.slice(16)); continue; }
      cur.extraLines.push(raw); continue;
    }
    if (indent >= 2 && block === 'attributes') {
      const p = sbTok(t); if (p.length) cur.attributes[p[0]] = p.slice(1).join(' ');
      continue;
    }
    if (indent >= 2 && block === 'outfits') {
      const p = sbTok(t); if (p.length) cur.outfits.push({ name: p[0].startsWith('"')?p[0]:`"${p[0]}"`, count: parseInt(p[1])||1 });
      continue;
    }
    cur.extraLines.push(raw);
  }
  flush(); return ships;
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
//  SAVE
// ═══════════════════════════════════════════════════════════
function saveShip() {
  onBuilderChange();
  if (!sbCurrentShip.name) { sbToast('Ship must have a name.', 'danger'); document.getElementById('ship-name').focus(); return; }
  if (sbEditIdx === -1) { sbFleet.push(JSON.parse(JSON.stringify(sbCurrentShip))); sbEditIdx = sbFleet.length - 1; }
  else sbFleet[sbEditIdx] = JSON.parse(JSON.stringify(sbCurrentShip));
  sbSave();
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

  // Use DataLoader to get live data — triggers load if not already running
  if (window.DataLoader) {
    window.DataLoader.onReady(() => {
      sbRefreshLiveData();
      sbToast('Game data loaded — ship & outfit pickers ready.', 'success');
    });
  } else {
    // DataLoader not present on this page — silently fall back to empty lists
    console.warn('[shipBuilder] dataLoader.js not loaded — outfit/ship pickers will be empty.');
  }

  // Also refresh on the custom event in case DataLoader was already ready
  // before this listener registered
  document.addEventListener('dataLoaded', () => sbRefreshLiveData());
});