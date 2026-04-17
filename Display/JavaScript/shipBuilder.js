// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════
const STORAGE_KEY = 'es_ship_builder_v3';

let fleet = [];
let editIdx = -1;
let currentShip = null;

// ═══════════════════════════════════════════════════════════
//  SHIP STRUCTURE
// ═══════════════════════════════════════════════════════════
function blankShip() {
  return {
    id: Date.now() + Math.random(),
    name: '',
    variant: '',
    plural: '',
    sprite: '',
    thumbnail: '',
    description: '',
    drag: '',
    mass: '',
    attributes: {},
    outfits: [],
    guns: [],
    turrets: [],
    drones: [],
    fighters: [],
    leaks: [],
    explode: [],
    finalExplode: [],
    extraLines: [],
  };
}

// ═══════════════════════════════════════════════════════════
//  PERSISTENCE
// ═══════════════════════════════════════════════════════════
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(fleet)); } catch(e) {}
}
function load() {
  try {
    const d = localStorage.getItem(STORAGE_KEY);
    if (d) fleet = JSON.parse(d);
  } catch(e) { fleet = []; }
}

// ═══════════════════════════════════════════════════════════
//  FLEET PAGE
// ═══════════════════════════════════════════════════════════
function renderFleet() {
  const grid = document.getElementById('fleet-grid');
  if (!grid) return;
  if (!fleet.length) {
    grid.innerHTML = `<div class="fleet-empty"><div class="fleet-empty__icon">🛸</div><p>No ships yet. Create your first ship or import from Endless Sky data files.</p></div>`;
    return;
  }
  grid.innerHTML = fleet.map((s, i) => {
    const attrs = s.attributes || {};
    return `<div class="fleet-card" onclick="editShip(${i})">
      <div class="fleet-card__name">${esc(s.name||'Unnamed Ship')}</div>
      <div class="fleet-card__variant">${s.variant ? esc(s.variant) : '<em style="color:var(--c-text-dim)">No variant</em>'}</div>
      <div class="fleet-card__stats">
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Shields</div><div class="fleet-card__stat-value">${attrs.shields||'—'}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Hull</div><div class="fleet-card__stat-value">${attrs.hull||'—'}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Category</div><div class="fleet-card__stat-value" style="font-size:0.8rem;">${attrs.category||'—'}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Outfits</div><div class="fleet-card__stat-value">${(s.outfits||[]).length}</div></div>
      </div>
      <div class="fleet-card__actions" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-sm" onclick="editShip(${i})">✏️ Edit</button>
        <button class="btn btn-secondary btn-sm" onclick="duplicateShip(${i})">⧉ Copy</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDelete(${i})">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function newShip() {
  editIdx = -1;
  currentShip = blankShip();
  populateBuilder();
  showBuilderView();
}
function editShip(i) {
  editIdx = i;
  currentShip = JSON.parse(JSON.stringify(fleet[i]));
  populateBuilder();
  showBuilderView();
}
function duplicateShip(i) {
  const copy = JSON.parse(JSON.stringify(fleet[i]));
  copy.id = Date.now() + Math.random();
  copy.variant = (copy.variant || '') + ' (Copy)';
  fleet.push(copy);
  save();
  renderFleet();
  toast('Ship duplicated!', 'success');
}
function confirmDelete(i) {
  document.getElementById('confirm-text').textContent = `Delete "${fleet[i].name || 'Unnamed Ship'}"? This cannot be undone.`;
  document.getElementById('confirm-ok-btn').onclick = () => {
    fleet.splice(i, 1);
    save();
    closeModal('modal-confirm');
    renderFleet();
    toast('Ship deleted.', 'danger');
  };
  openModal('modal-confirm');
}

// ── View switching (builder vs fleet within the page) ──
function showBuilderView() {
  const fleetView = document.getElementById('fleet-view');
  const builderView = document.getElementById('builder-view');
  if (fleetView) fleetView.classList.add('hidden');
  if (builderView) builderView.classList.remove('hidden');
}
function showFleetView() {
  const fleetView = document.getElementById('fleet-view');
  const builderView = document.getElementById('builder-view');
  if (builderView) builderView.classList.add('hidden');
  if (fleetView) fleetView.classList.remove('hidden');
  renderFleet();
}

// ═══════════════════════════════════════════════════════════
//  BUILDER: POPULATE & SYNC
// ═══════════════════════════════════════════════════════════
function populateBuilder() {
  const s = currentShip;
  const titleEl = document.getElementById('builder-page-title');
  if (titleEl) titleEl.textContent = editIdx === -1 ? '✏️ New Ship' : `✏️ Editing: ${s.name||'Ship'}`;
  document.getElementById('ship-name').value = s.name||'';
  document.getElementById('ship-variant').value = s.variant||'';
  document.getElementById('ship-plural').value = s.plural||'';
  document.getElementById('ship-sprite').value = s.sprite||'';
  document.getElementById('ship-thumbnail').value = s.thumbnail||'';
  document.getElementById('ship-description').value = s.description||'';
  document.getElementById('ship-drag').value = s.drag||'';
  document.getElementById('ship-mass').value = s.mass||'';
  renderAttrList();
  renderOutfitsList();
  renderGunsTurrets();
  renderExplodeLists();
  rawEditDirty = false;
  renderRawOutput();
  updateQuickStats();
  // reset tabs
  document.querySelectorAll('.builder-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.builder-tab-content').forEach(t => t.classList.remove('active'));
  const firstTab = document.querySelector('.builder-tab[data-tab="attributes"]');
  if (firstTab) firstTab.classList.add('active');
  const firstContent = document.getElementById('tab-attributes');
  if (firstContent) firstContent.classList.add('active');
}

function onBuilderChange() {
  if (!currentShip) return;
  const s = currentShip;
  s.name = document.getElementById('ship-name').value.trim();
  s.variant = document.getElementById('ship-variant').value.trim();
  s.plural = document.getElementById('ship-plural').value.trim();
  s.sprite = document.getElementById('ship-sprite').value.trim();
  s.thumbnail = document.getElementById('ship-thumbnail').value.trim();
  s.description = document.getElementById('ship-description').value;
  s.drag = document.getElementById('ship-drag').value.trim();
  s.mass = document.getElementById('ship-mass').value.trim();
  const titleEl = document.getElementById('builder-page-title');
  if (titleEl) titleEl.textContent = editIdx === -1 ? '✏️ New Ship' : `✏️ Editing: ${s.name||'Ship'}`;
  updateQuickStats();
  renderRawOutput();
}

function updateQuickStats() {
  const el = document.getElementById('quick-stats');
  if (!el || !currentShip) return;
  const s = currentShip;
  const a = s.attributes||{};
  const qs = [
    {label:'Shields', value: a.shields||'—'},
    {label:'Hull', value: a.hull||'—'},
    {label:'Mass', value: s.mass || a['mass']||'—'},
    {label:'Engines', value: a['engine capacity']||'—'},
    {label:'Weapons', value: a['weapon capacity']||'—'},
    {label:'Outfits', value: (s.outfits||[]).reduce((acc,o)=>acc+parseInt(o.count||1),0)},
  ];
  el.innerHTML = qs.map(q =>
    `<div class="qs-card"><div class="qs-label">${q.label}</div><div class="qs-value">${q.value}</div></div>`
  ).join('');
}

// ── TABS ──
function initBuilderTabs() {
  document.querySelectorAll('.builder-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.builder-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.builder-tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'raw') renderRawOutput();
    });
  });
}

// ═══════════════════════════════════════════════════════════
//  ATTRIBUTES
// ═══════════════════════════════════════════════════════════
const ATTR_GROUPS = {
  'Identity': ['category','mass','drag','required crew','bunks','cargo space','fuel capacity'],
  'Combat': ['shields','hull','hull repair rate','shield generation','shield energy','hull energy','hull heat','cloaking','cloak','cloak fuel','cloak heat'],
  'Movement': ['thrust','thruster energy','thruster heat','turn','turning energy','turning heat','reverse thrust','reverse thruster energy','reverse thruster heat','afterburner thrust','afterburner fuel','afterburner heat','afterburner effect'],
  'Power': ['heat dissipation','energy capacity','solar collection','ramscoop','ion resistance'],
  'Capacity': ['engine capacity','weapon capacity','outfit space','gun ports','turret mounts'],
  'Economy': ['cost'],
};
const ALL_ATTR_KEYS = [...new Set(Object.values(ATTR_GROUPS).flat())];

function renderAttrList() {
  const el = document.getElementById('attr-list');
  if (!el || !currentShip) return;
  const attrs = currentShip.attributes||{};
  const keys = Object.keys(attrs);
  if (!keys.length) {
    el.innerHTML = '<div style="color:var(--c-text-muted);font-size:0.88rem;font-style:italic;padding:10px 0;">No attributes. Click "+ Add Attribute" to add one.</div>';
    return;
  }
  const assigned = new Set();
  let html = '';
  for (const [group, gkeys] of Object.entries(ATTR_GROUPS)) {
    const present = gkeys.filter(k => k in attrs);
    if (!present.length) continue;
    html += `<div class="attr-section"><div class="attr-section-title">${group}<span></span></div>`;
    for (const k of present) { assigned.add(k); html += attrRowHtml(k, attrs[k]); }
    html += '</div>';
  }
  const other = keys.filter(k => !assigned.has(k));
  if (other.length) {
    html += `<div class="attr-section"><div class="attr-section-title">Other<span></span></div>`;
    for (const k of other) html += attrRowHtml(k, attrs[k]);
    html += '</div>';
  }
  el.innerHTML = html;
}

function attrRowHtml(k, v) {
  const safeK = esc(k); const safeV = esc(String(v));
  return `<div class="attr-row">
    <span class="attr-key" title="${safeK}">${safeK}</span>
    <input class="attr-val-input" type="text" value="${safeV}" data-key="${safeK}" onchange="updateAttrVal(this)" onblur="updateAttrVal(this)">
    <button class="btn btn-danger btn-xs" onclick="removeAttr('${safeK.replace(/'/g,"\\'")}')" title="Remove">✕</button>
  </div>`;
}
function updateAttrVal(inp) {
  const k = inp.dataset.key;
  currentShip.attributes[k] = inp.value;
  updateQuickStats(); renderRawOutput();
}
function removeAttr(k) {
  delete currentShip.attributes[k];
  renderAttrList(); updateQuickStats(); renderRawOutput();
}
let addingAttrType = 'attribute';
function openAddAttr(type) {
  addingAttrType = type;
  document.getElementById('new-attr-key').value = '';
  document.getElementById('new-attr-val').value = '';
  document.getElementById('attr-key-ac').classList.remove('open');
  openModal('modal-add-attr');
  setTimeout(() => document.getElementById('new-attr-key').focus(), 80);
}
function confirmAddAttr() {
  const k = document.getElementById('new-attr-key').value.trim();
  const v = document.getElementById('new-attr-val').value.trim();
  if (!k) { toast('Please enter an attribute key.', 'danger'); return; }
  currentShip.attributes[k] = v;
  closeModal('modal-add-attr');
  renderAttrList(); updateQuickStats(); renderRawOutput();
}
function attrKeyAc(val) {
  const ac = document.getElementById('attr-key-ac');
  const matches = ALL_ATTR_KEYS.filter(k => k.toLowerCase().includes(val.toLowerCase()));
  if (!val || !matches.length) { ac.classList.remove('open'); return; }
  ac.innerHTML = matches.slice(0,12).map(k => `<div class="ac-item" onclick="selectAttrKey('${esc(k)}')">${esc(k)}</div>`).join('');
  ac.classList.add('open');
}
function selectAttrKey(k) {
  document.getElementById('new-attr-key').value = k;
  document.getElementById('attr-key-ac').classList.remove('open');
  document.getElementById('new-attr-val').focus();
}

// ═══════════════════════════════════════════════════════════
//  OUTFITS
// ═══════════════════════════════════════════════════════════
function renderOutfitsList() {
  const outfits = currentShip.outfits||[];
  const emptyEl = document.getElementById('outfits-empty');
  if (emptyEl) emptyEl.style.display = outfits.length ? 'none' : 'block';
  const el = document.getElementById('outfits-list');
  if (!el) return;
  el.innerHTML = outfits.map((o, i) =>
    `<div class="outfit-item">
      <span class="outfit-item__name" title="${esc(o.name)}">${esc(o.name)}</span>
      <input class="outfit-item__count" type="number" min="1" value="${esc(String(o.count||1))}" onchange="updateOutfitCount(${i},this.value)">
      <button class="btn btn-danger btn-xs" onclick="removeOutfit(${i})">✕</button>
    </div>`
  ).join('');
}
function openAddOutfit() {
  document.getElementById('new-outfit-name').value = '';
  document.getElementById('new-outfit-count').value = '1';
  openModal('modal-add-outfit');
  setTimeout(() => document.getElementById('new-outfit-name').focus(), 80);
}
function confirmAddOutfit() {
  const name = document.getElementById('new-outfit-name').value.trim();
  const count = parseInt(document.getElementById('new-outfit-count').value)||1;
  if (!name) { toast('Please enter an outfit name.', 'danger'); return; }
  const quotedName = name.startsWith('"') ? name : `"${name}"`;
  currentShip.outfits.push({ name: quotedName, count });
  closeModal('modal-add-outfit');
  renderOutfitsList(); updateQuickStats(); renderRawOutput();
}
function updateOutfitCount(i, v) {
  currentShip.outfits[i].count = parseInt(v)||1;
  renderRawOutput();
}
function removeOutfit(i) {
  currentShip.outfits.splice(i,1);
  renderOutfitsList(); renderRawOutput();
}

// ═══════════════════════════════════════════════════════════
//  GUNS / TURRETS / DRONES / FIGHTERS
// ═══════════════════════════════════════════════════════════
function renderGunsTurrets() {
  renderHardpointList('guns', 'guns-list', 'gun');
  renderHardpointList('turrets', 'turrets-list', 'turret');
  renderHardpointList('drones', 'drones-list', 'drone');
  renderHardpointList('fighters', 'fighters-list', 'fighter');
  renderLeaksList();
}
function renderHardpointList(field, elId, label) {
  const el = document.getElementById(elId);
  if (!el) return;
  const items = currentShip[field]||[];
  el.innerHTML = items.length ? items.map((g,i) =>
    `<div class="outfit-item" style="gap:4px;">
      <input class="text-input" style="flex:1;padding:4px 6px;font-size:0.78rem;" type="text" value="${esc(g.coords||'')}" placeholder="x y" onchange="updateHardpoint('${field}',${i},'coords',this.value)">
      <input class="text-input" style="width:130px;padding:4px 6px;font-size:0.78rem;" type="text" value="${esc(g.over||'')}" placeholder='outfit "Name"' onchange="updateHardpoint('${field}',${i},'over',this.value)">
      <button class="btn btn-danger btn-xs" onclick="removeHardpoint('${field}',${i})">✕</button>
    </div>`
  ).join('') : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">No ${label}s defined.</div>`;
}
function addGunTurret(type) {
  const field = type === 'gun' ? 'guns' : type === 'turret' ? 'turrets' : type === 'drone' ? 'drones' : 'fighters';
  if (!currentShip[field]) currentShip[field] = [];
  currentShip[field].push({coords:'0 0', over:''});
  renderGunsTurrets(); renderRawOutput();
}
function updateHardpoint(field, i, prop, val) {
  currentShip[field][i][prop] = val; renderRawOutput();
}
function removeHardpoint(field, i) {
  currentShip[field].splice(i,1); renderGunsTurrets(); renderRawOutput();
}
function renderLeaksList() {
  const el = document.getElementById('leaks-list');
  if (!el) return;
  const leaks = currentShip.leaks||[];
  el.innerHTML = leaks.map((l,i) =>
    `<div class="outfit-item">
      <span class="outfit-item__name">${esc(l)}</span>
      <button class="btn btn-danger btn-xs" onclick="removeLeak(${i})">✕</button>
    </div>`
  ).join('') || '<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:4px 0;">No leaks defined.</div>';
}
function addLeak() {
  const v = document.getElementById('leak-input').value.trim();
  if (!v) return;
  if (!currentShip.leaks) currentShip.leaks = [];
  currentShip.leaks.push(v);
  document.getElementById('leak-input').value = '';
  renderLeaksList(); renderRawOutput();
}
function removeLeak(i) { currentShip.leaks.splice(i,1); renderLeaksList(); renderRawOutput(); }

// ═══════════════════════════════════════════════════════════
//  EXPLODE
// ═══════════════════════════════════════════════════════════
function renderExplodeLists() {
  renderExplodeList('explode', 'explode-list');
  renderExplodeList('finalExplode', 'final-explode-list');
}
function renderExplodeList(field, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const items = currentShip[field]||[];
  el.innerHTML = items.length ? items.map((e,i) =>
    `<div class="outfit-item">
      <input class="text-input" style="flex:1;padding:4px 6px;font-size:0.82rem;" type="text" value="${esc(e.name||'')}" placeholder='"tiny explosion"' onchange="updateExplode('${field}',${i},'name',this.value)">
      <input class="text-input" style="width:60px;padding:4px 6px;font-size:0.82rem;" type="number" min="1" value="${esc(String(e.count||1))}" onchange="updateExplode('${field}',${i},'count',this.value)">
      <button class="btn btn-danger btn-xs" onclick="removeExplode('${field}',${i})">✕</button>
    </div>`
  ).join('') : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">None.</div>`;
}
function addExplodeEffect(type) {
  const field = type === 'explode' ? 'explode' : 'finalExplode';
  if (!currentShip[field]) currentShip[field] = [];
  currentShip[field].push({name:'"tiny explosion"', count:1});
  renderExplodeLists(); renderRawOutput();
}
function updateExplode(field, i, prop, val) {
  currentShip[field][i][prop] = prop === 'count' ? (parseInt(val)||1) : val;
  renderRawOutput();
}
function removeExplode(field, i) { currentShip[field].splice(i,1); renderExplodeLists(); renderRawOutput(); }

// ═══════════════════════════════════════════════════════════
//  ES FORMAT GENERATOR
// ═══════════════════════════════════════════════════════════
function generateES(s) {
  const T = '\t';
  let lines = [];

  const namePart = `"${s.name||'Unnamed'}"`;
  const variantPart = s.variant ? ` ${s.variant}` : '';
  lines.push(`ship ${namePart}${variantPart}`);

  if (s.plural) lines.push(`${T}plural "${s.plural}"`);
  if (s.sprite) lines.push(`${T}sprite "${s.sprite}"`);
  if (s.thumbnail) lines.push(`${T}thumbnail "${s.thumbnail}"`);

  const attrs = s.attributes||{};
  const attrKeys = Object.keys(attrs);
  if (attrKeys.length || s.mass || s.drag) {
    lines.push(`${T}attributes`);
    if (attrs.category !== undefined) lines.push(`${T}${T}category "${attrs.category}"`);
    if (s.mass) lines.push(`${T}${T}mass ${s.mass}`);
    if (s.drag) lines.push(`${T}${T}drag ${s.drag}`);
    for (const k of attrKeys) {
      if (k === 'category') continue;
      const v = attrs[k];
      if (v === '' || v === undefined) continue;
      const needsQuote = /[^0-9.\-]/.test(String(v)) && !/^-?[0-9]+(\.[0-9]+)?$/.test(String(v));
      lines.push(`${T}${T}${k} ${needsQuote ? `"${v}"` : v}`);
    }
  }

  const outfits = s.outfits||[];
  if (outfits.length) {
    lines.push(`${T}outfits`);
    for (const o of outfits) {
      const countPart = (parseInt(o.count)||1) > 1 ? ` ${o.count}` : '';
      lines.push(`${T}${T}${o.name}${countPart}`);
    }
  }

  for (const g of (s.guns||[])) {
    const overPart = g.over ? ` ${g.over}` : '';
    lines.push(`${T}gun ${g.coords||'0 0'}${overPart}`);
  }
  for (const g of (s.turrets||[])) {
    const overPart = g.over ? ` ${g.over}` : '';
    lines.push(`${T}turret ${g.coords||'0 0'}${overPart}`);
  }
  for (const g of (s.drones||[])) lines.push(`${T}drone`);
  for (const g of (s.fighters||[])) lines.push(`${T}fighter`);

  for (const l of (s.leaks||[])) lines.push(`${T}leak ${l}`);

  for (const e of (s.explode||[])) {
    const cPart = e.count > 1 ? ` ${e.count}` : '';
    lines.push(`${T}explode ${e.name}${cPart}`);
  }
  for (const e of (s.finalExplode||[])) {
    const cPart = e.count > 1 ? ` ${e.count}` : '';
    lines.push(`${T}"final explode" ${e.name}${cPart}`);
  }

  if (s.description) {
    const desc = s.description.replace(/\n/g, `\n${T}description `);
    lines.push(`${T}description "${desc}"`);
  }

  for (const l of (s.extraLines||[])) lines.push(l);

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════
//  RAW OUTPUT / EDIT
// ═══════════════════════════════════════════════════════════
let rawEditDirty = false;
function renderRawOutput() {
  if (rawEditDirty) return;
  const el = document.getElementById('raw-output');
  if (!el || !currentShip) return;
  el.value = generateES(currentShip);
}
function onRawEdit() { rawEditDirty = true; }
function importRaw() {
  const text = document.getElementById('raw-output').value;
  const parsed = parseES(text);
  if (!parsed.length) { toast('Could not parse ship data.', 'danger'); return; }
  Object.assign(currentShip, parsed[0]);
  rawEditDirty = false;
  populateBuilder();
  toast('Imported from raw text.', 'success');
}

// ═══════════════════════════════════════════════════════════
//  ES PARSER
// ═══════════════════════════════════════════════════════════
function parseES(text) {
  const lines = text.split('\n');
  const ships = [];
  let cur = null, block = null;

  function flushShip() { if (cur) ships.push(cur); }

  for (let raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      const m = trimmed.match(/^ship\s+("([^"]+)"|(\S+))\s*(.*)$/);
      if (m) {
        flushShip();
        cur = blankShip();
        cur.name = m[2]||m[3]||'';
        cur.variant = m[4]||'';
        block = null;
        continue;
      }
      flushShip(); cur = null; continue;
    }

    if (!cur) continue;

    if (indent === 1) {
      block = null;
      if (trimmed.startsWith('sprite '))      { cur.sprite = stripQ(trimmed.slice(7)); continue; }
      if (trimmed.startsWith('thumbnail '))   { cur.thumbnail = stripQ(trimmed.slice(10)); continue; }
      if (trimmed.startsWith('plural '))      { cur.plural = stripQ(trimmed.slice(7)); continue; }
      if (trimmed.startsWith('description ')) { cur.description = (cur.description ? cur.description+'\n':'')+stripQ(trimmed.slice(12)); continue; }
      if (trimmed === 'attributes')           { block = 'attributes'; continue; }
      if (trimmed === 'outfits')              { block = 'outfits'; continue; }
      if (trimmed.startsWith('gun '))         { parseHardpointLine(cur, 'guns', trimmed.slice(4)); continue; }
      if (trimmed.startsWith('turret '))      { parseHardpointLine(cur, 'turrets', trimmed.slice(7)); continue; }
      if (trimmed.startsWith('drone'))        { cur.drones.push({coords:'',over:''}); continue; }
      if (trimmed.startsWith('fighter'))      { cur.fighters.push({coords:'',over:''}); continue; }
      if (trimmed.startsWith('leak '))        { cur.leaks.push(trimmed.slice(5)); continue; }
      if (trimmed.startsWith('explode '))     { parseExplodeLine(cur, 'explode', trimmed.slice(8)); continue; }
      if (trimmed.startsWith('"final explode" ')) { parseExplodeLine(cur, 'finalExplode', trimmed.slice(16)); continue; }
      cur.extraLines.push(line);
      continue;
    }

    if (indent >= 2 && block === 'attributes') {
      const parts = tokenise(trimmed);
      if (!parts.length) continue;
      cur.attributes[parts[0]] = parts.slice(1).join(' ');
      continue;
    }
    if (indent >= 2 && block === 'outfits') {
      const parts = tokenise(trimmed);
      if (!parts.length) continue;
      const name = parts[0].startsWith('"') ? parts[0] : `"${parts[0]}"`;
      cur.outfits.push({name, count: parseInt(parts[1])||1});
      continue;
    }
    cur.extraLines.push(line);
  }
  flushShip();
  return ships;
}

function parseHardpointLine(cur, field, rest) {
  const parts = tokenise(rest);
  cur[field].push({coords: parts.slice(0,2).join(' '), over: parts.slice(2).join(' ')});
}
function parseExplodeLine(cur, field, rest) {
  const parts = tokenise(rest);
  if (!cur[field]) cur[field] = [];
  cur[field].push({name: parts[0]||'"tiny explosion"', count: parseInt(parts[1])||1});
}
function tokenise(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === ' ' || str[i] === '\t') { i++; continue; }
    if (str[i] === '"') {
      const end = str.indexOf('"', i+1);
      if (end === -1) { tokens.push(str.slice(i)); break; }
      tokens.push(str.slice(i, end+1));
      i = end+1;
    } else {
      let j = i;
      while (j < str.length && str[j] !== ' ' && str[j] !== '\t') j++;
      tokens.push(str.slice(i, j)); i = j;
    }
  }
  return tokens;
}
function stripQ(s) {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1,-1);
  return s;
}

// ═══════════════════════════════════════════════════════════
//  SAVE SHIP
// ═══════════════════════════════════════════════════════════
function saveShip() {
  onBuilderChange();
  if (!currentShip.name) { toast('Ship must have a name.', 'danger'); document.getElementById('ship-name').focus(); return; }
  if (editIdx === -1) {
    fleet.push(JSON.parse(JSON.stringify(currentShip)));
    editIdx = fleet.length - 1;
  } else {
    fleet[editIdx] = JSON.parse(JSON.stringify(currentShip));
  }
  save();
  const titleEl = document.getElementById('builder-page-title');
  if (titleEl) titleEl.textContent = `✏️ Editing: ${currentShip.name}`;
  toast('Ship saved!', 'success');
}

// ═══════════════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════════════
function renderExportChecklist() {
  const cl = document.getElementById('export-checklist');
  if (!cl) return;
  if (!fleet.length) { cl.innerHTML = '<div style="color:var(--c-text-muted);font-style:italic;">No ships in fleet.</div>'; return; }
  cl.innerHTML = fleet.map((s, i) =>
    `<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--r-sm);background:var(--c-surface-3);margin-bottom:6px;cursor:pointer;">
      <input type="checkbox" id="export-chk-${i}" checked style="accent-color:var(--c-accent);width:16px;height:16px;">
      <span style="font-size:0.92rem;color:var(--c-text-mid);">${esc(s.name||'Unnamed')} <span style="color:var(--c-text-dim);font-size:0.82rem;">${esc(s.variant||'')}</span></span>
    </label>`
  ).join('');
}
function getExportText() {
  return fleet.filter((_,i) => document.getElementById(`export-chk-${i}`)?.checked)
    .map(s => generateES(s)).join('\n\n');
}
function generateExport() {
  const el = document.getElementById('export-output');
  if (el) el.textContent = getExportText() || '(No ships selected)';
}
function copyExport() {
  const t = getExportText();
  if (!t) { toast('Nothing to copy.', 'danger'); return; }
  navigator.clipboard.writeText(t).then(()=>toast('Copied!','success')).catch(()=>toast('Copy failed.','danger'));
}
function downloadExport() {
  const t = getExportText();
  if (!t) { toast('Nothing to export.', 'danger'); return; }
  downloadText(t, 'ships.txt');
  toast('Downloaded ships.txt', 'success');
}
function exportAll() {
  const t = fleet.map(s => generateES(s)).join('\n\n');
  if (!t) { toast('No ships to export.', 'danger'); return; }
  downloadText(t, 'fleet.txt');
  toast('Downloaded fleet.txt', 'success');
}
function downloadText(text, filename) {
  const blob = new Blob([text], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════
//  IMPORT
// ═══════════════════════════════════════════════════════════
function openImport() {
  document.getElementById('import-text').value = '';
  openModal('modal-import');
}
function doImport() {
  const text = document.getElementById('import-text').value;
  const parsed = parseES(text);
  if (!parsed.length) { toast('Could not parse any ships.', 'danger'); return; }
  for (const s of parsed) {
    s.id = Date.now() + Math.random();
    fleet.push(s);
  }
  save();
  closeModal('modal-import');
  renderFleet();
  toast(`Imported ${parsed.length} ship(s)!`, 'success');
}

// ═══════════════════════════════════════════════════════════
//  COPY RAW OUTPUT
// ═══════════════════════════════════════════════════════════
function copyOutput() {
  const text = document.getElementById('raw-output').value;
  navigator.clipboard.writeText(text).then(()=>toast('Copied!','success')).catch(()=>toast('Copy failed.','danger'));
}

// ═══════════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ═══════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════
let toastTimer = null;
function toast(msg, type='') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' '+type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2800);
}

// ═══════════════════════════════════════════════════════════
//  UTIL
// ═══════════════════════════════════════════════════════════
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  load();
  renderFleet();
  initBuilderTabs();

  // Modal close on backdrop click
  document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); });
  });

  // Escape closes modals
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(o => closeModal(o.id));
    }
  });

  // Attr modal enter key
  const attrKeyEl = document.getElementById('new-attr-key');
  const attrValEl = document.getElementById('new-attr-val');
  if (attrKeyEl) attrKeyEl.addEventListener('keydown', e => { if (e.key === 'Enter') confirmAddAttr(); });
  if (attrValEl) attrValEl.addEventListener('keydown', e => { if (e.key === 'Enter') confirmAddAttr(); });

  // Export page: populate checklist when visible
  const exportChecklist = document.getElementById('export-checklist');
  if (exportChecklist) renderExportChecklist();
});
