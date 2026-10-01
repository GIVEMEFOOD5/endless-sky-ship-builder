'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  saveEditor.js — "Edit save" tab on UserManager.html
//
//  Edits the save's ORIGINAL text (kept by saveVault.js) through the
//  lossless esSaveFile.js reader, so everything the editor doesn't touch is
//  written back exactly as the game wrote it. Every change is kept as the
//  save's edited version; "Download edited save" gives a .txt the game can
//  load, and "Revert to original" throws the edits away.
//
//  Also adds to the saves library: which saves are kept in the account,
//  saves from the account that aren't on this device yet, and an upload
//  prompt for saves that are only in this browser.
//
//  Load after saveManager.js, esSaveFile.js and saveVault.js.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  if (!window.EsSaveFile || !window.SaveVault) { console.warn('[SaveEditor] esSaveFile.js / saveVault.js missing'); return; }
  const V = window.SaveVault;
  const E = window.EsSaveFile;
  const $ = id => document.getElementById(id);
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const say = (m, t) => (typeof toast === 'function' ? toast(m, t) : console.log(m));
  const loggedIn = () => !!(window.EsAuth && window.EsAuth.getCurrentUser());

  // ── capture the original text of every new upload ────────────────────────
  let pendingText = null;
  const origHandleFile = window.handleFile;
  window.handleFile = async function (file) {
    try { pendingText = await file.text(); } catch (_) { pendingText = null; }
    try { return await origHandleFile.apply(this, arguments); } finally { pendingText = null; }
  };
  const origAddSave = window.smAddSave;
  window.smAddSave = function (parsed, name) {
    const id = origAddSave.apply(this, arguments);
    if (pendingText != null) {
      V.put(id, { original: pendingText, label: parsed?.pilot?.name || name, parsed })
        .then(() => { renderCloudLibrary(); if (id === currentSaveId) loadEditor(); })
        .catch(err => say('Could not store the original save text: ' + err.message, 'danger'));
    }
    return id;
  };
  const origRemoveSave = window.smRemoveSave;
  window.smRemoveSave = function (id) {
    origRemoveSave.apply(this, arguments);
    V.remove(id).catch(() => {});
    renderCloudLibrary();
  };
  const origRenderResults = window.renderResults;
  window.renderResults = function () {
    const r = origRenderResults.apply(this, arguments);
    ensureTab();
    if (activeTab() === 'edit') loadEditor();
    return r;
  };
  const origRenderLibrary = window.renderSavesLibrary;
  window.renderSavesLibrary = function () {
    const r = origRenderLibrary.apply(this, arguments);
    renderCloudLibrary();
    return r;
  };

  // ── cloud library (under the saves list) ─────────────────────────────────
  let cloudRenderSeq = 0;
  async function renderCloudLibrary() {
    const lib = $('savesLibrary');
    if (!lib) return;
    let box = $('sv-cloud');
    if (!box) { box = document.createElement('div'); box.id = 'sv-cloud'; lib.insertAdjacentElement('afterend', box); }
    const seq = ++cloudRenderSeq;
    const registry = typeof smGetRegistry === 'function' ? smGetRegistry() : [];

    // badges on the existing rows
    const local = {};
    for (const s of registry) local[s.id] = await V.get(s.id).catch(() => null);
    if (seq !== cloudRenderSeq) return;
    lib.querySelectorAll('.list-row[data-save-id]').forEach(row => {
      const rec = local[row.dataset.saveId];
      const label = row.querySelector('.list-row__label');
      if (!label || label.querySelector('.sv-badge')) return;
      const b = document.createElement('span');
      b.className = 'sv-badge';
      b.style.cssText = 'margin-left:8px;font-size:0.72rem;color:var(--c-text-dim);';
      b.textContent = !rec ? '· view only (re-upload to edit)' : rec.cloud ? '· ☁ in your account' : rec.edited ? '· edited' : '';
      if (rec && rec.edited && rec.cloud) b.textContent = '· edited · ☁ in your account';
      label.appendChild(b);
    });

    if (!loggedIn()) {
      box.innerHTML = `<p style="font-size:0.82rem;color:var(--c-text-dim);margin:0 0 16px;">Saves are kept in this browser only. Log in to keep them in your account and open them on any device.</p>`;
      return;
    }
    let rows = [], missing = [];
    try { [rows, missing] = await Promise.all([V.listAccountSaves(), V.localIdsMissingFromAccount()]); }
    catch (err) { box.innerHTML = `<p style="color:var(--c-danger-text);font-size:0.85rem;">Could not reach your account: ${h(err.message)}</p>`; return; }
    if (seq !== cloudRenderSeq) return;
    const here = new Set(registry.map(s => s.id));
    const remoteOnly = rows.filter(r => !here.has(r.id));
    const uploadable = missing.filter(id => here.has(id));

    box.innerHTML = `
      ${uploadable.length ? `
        <div class="list-row" style="margin-bottom:10px;border-style:dashed;">
          <span class="list-row__label">${uploadable.length} save${uploadable.length === 1 ? ' is' : 's are'} only in this browser.</span>
          <button class="btn btn-primary btn-sm" id="sv-upload-all">Upload to my account</button>
        </div>` : ''}
      ${remoteOnly.length ? `
        <div style="font-size:0.85rem;color:var(--c-text-mid);margin:6px 0;">In your account, not on this device:</div>
        ${remoteOnly.map(r => `
          <div class="list-row" style="margin-bottom:8px;">
            <span class="list-row__label">${h(r.label)}${r.has_edits ? ' <span style="font-size:0.72rem;color:var(--c-text-dim);">· edited</span>' : ''}</span>
            <span style="font-size:0.78rem;color:var(--c-text-dim);margin-right:8px;">${h(new Date(r.updated_at).toLocaleDateString())}</span>
            <button class="btn btn-secondary btn-sm sv-fetch" data-id="${h(r.id)}">Open here</button>
            <button class="btn-remove sv-cloud-del" data-id="${h(r.id)}" title="Delete from your account">✕</button>
          </div>`).join('')}` : ''}`;

    const up = $('sv-upload-all');
    if (up) up.onclick = async () => {
      up.disabled = true; up.textContent = 'Uploading…';
      let ok = 0;
      for (const id of uploadable) { try { await V.uploadToAccount(id); ok++; } catch (e) { console.warn(e); } }
      say(`Uploaded ${ok} save${ok === 1 ? '' : 's'} to your account.`, ok ? 'success' : 'danger');
      renderCloudLibrary();
    };
    box.querySelectorAll('.sv-fetch').forEach(b => b.onclick = async () => {
      const row = rows.find(r => r.id === b.dataset.id);
      b.disabled = true; b.textContent = 'Opening…';
      try {
        const { original, edited } = await V.downloadFromAccount(row);
        const parsed = parseESSaveFile(edited || original);
        // register under the SAME id so it stays linked to the account copy
        const registry = smGetRegistry();
        registry.push({ id: row.id, label: row.label, pilotName: row.pilot_name || '', importedAt: Date.parse(row.created_at) || Date.now() });
        smSetRegistry(registry);
        smSetSaveData(row.id, parsed);
        smSetCurrentId(row.id);
        parsedSave = parsed; currentSaveId = row.id;
        renderSavesLibrary(); renderResults();
        say(`Opened "${row.label}".`, 'success');
      } catch (err) { say(err.message, 'danger'); b.disabled = false; b.textContent = 'Open here'; }
    });
    box.querySelectorAll('.sv-cloud-del').forEach(b => b.onclick = async () => {
      const row = rows.find(r => r.id === b.dataset.id);
      if (!confirm(`Delete "${row.label}" from your account? This cannot be undone.`)) return;
      await V.remove(row.id);
      renderCloudLibrary();
      say('Deleted from your account.', 'success');
    });
  }

  // ── tab plumbing ─────────────────────────────────────────────────────────
  function ensureTab() {
    const tabs = $('resultTabs');
    if (!tabs || tabs.querySelector('[data-tab="edit"]')) return;
    const tab = document.createElement('div');
    tab.className = 'tab'; tab.dataset.tab = 'edit'; tab.textContent = '✏️ Edit save';
    tabs.appendChild(tab);
    const pane = document.createElement('div');
    pane.className = 'tab-content hidden'; pane.id = 'tab-edit';
    $('results').appendChild(pane);
    tab.addEventListener('click', () => {
      document.querySelectorAll('#resultTabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      tab.classList.add('active'); pane.classList.remove('hidden');
      loadEditor();
    });
    // the original tabs don't know about this pane — hide it when they're clicked
    tabs.querySelectorAll('.tab:not([data-tab="edit"])').forEach(t => t.addEventListener('click', () => pane.classList.add('hidden')));
  }
  const activeTab = () => document.querySelector('#resultTabs .tab.active')?.dataset.tab;

  // ── editor state ─────────────────────────────────────────────────────────
  let doc = null;          // EsSaveFile.SaveFile
  let docId = null;
  let hasEdits = false;
  let saveTimer = null;
  let openShip = null;     // index whose outfit list is expanded
  let condFilter = '';

  async function loadEditor() {
    const pane = $('tab-edit');
    if (!pane || !currentSaveId) return;
    const rec = await V.get(currentSaveId).catch(() => null);
    if (!rec) { renderNoOriginal(pane); return; }
    docId = currentSaveId;
    doc = E.SaveFile.fromText(rec.edited || rec.original);
    hasEdits = !!rec.edited;
    render();
  }

  function renderNoOriginal(pane) {
    pane.innerHTML = `
      <section class="panel">
        <h2 class="section-title">Upload the save file again to edit it</h2>
        <p style="color:var(--c-text-mid);">This save was imported before editing was available, so its original text wasn't kept. Choose the same .txt file and it will be attached to this save.</p>
        <input type="file" id="sv-reattach" accept=".txt" class="text-input" style="max-width:420px;">
      </section>`;
    $('sv-reattach').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const text = await f.text();
      const parsed = parseESSaveFile(text);
      if ((parsed.pilot.name || '') !== (parsedSave.pilot.name || '') &&
          !confirm(`That file is for "${parsed.pilot.name}", but this save is "${parsedSave.pilot.name}". Attach it anyway?`)) return;
      await V.put(currentSaveId, { original: text, label: parsed.pilot.name, parsed });
      smSetSaveData(currentSaveId, parsed); parsedSave = parsed;
      origRenderResults(); ensureTab(); loadEditor(); renderCloudLibrary();
      say('Save file attached — you can edit it now.', 'success');
    };
  }

  // Apply a change: persist the edited text, refresh the other tabs.
  function changed(message) {
    hasEdits = true;
    clearTimeout(saveTimer);
    const id = docId;
    const snapshot = doc.toString();
    saveTimer = setTimeout(async () => {
      try {
        const parsed = parseESSaveFile(snapshot);
        await V.setEdited(id, snapshot, parsed);
        if (id === currentSaveId) {
          smSetSaveData(id, parsed); parsedSave = parsed;
          origRenderResults(); ensureTab();
        }
        setStatus(loggedIn() ? 'Changes saved in your account' : 'Changes saved in this browser');
        renderCloudLibrary();
      } catch (err) { setStatus('Could not save changes: ' + err.message, true); }
    }, 400);
    setStatus('Saving…');
    render();
    if (message) say(message, 'success');
  }
  function setStatus(text, bad) {
    const s = $('sv-status');
    if (s) { s.textContent = text; s.style.color = bad ? 'var(--c-danger-text)' : 'var(--c-text-dim)'; }
  }

  // ── datalists from loaded game data ──────────────────────────────────────
  function dataNames(kind) {
    const out = new Set();
    for (const p of Object.values(window.allData || {})) for (const x of (p[kind] || [])) if (x && x.name) out.add(x.name);
    return [...out].sort();
  }
  // Built once and kept outside the editor pane, which is re-rendered often.
  function datalists() {
    if (!$('sv-outfit-names')) {
      const dl = document.createElement('datalist');
      dl.id = 'sv-outfit-names';
      dl.innerHTML = dataNames('outfits').map(n => `<option value="${h(n)}">`).join('');
      document.body.appendChild(dl);
    }
    return '';
  }

  // ── render ───────────────────────────────────────────────────────────────
  const numIn = (attr, value, extra = '') =>
    `<input type="number" class="text-input" style="width:100px;" ${attr} value="${h(value)}" ${extra}>`;

  function render() {
    const pane = $('tab-edit');
    if (!pane || !doc) return;
    const p = doc.pilot, d = doc.date || { day: 1, month: 1, year: 3013 };
    const ships = doc.ships;
    const cargo = doc.cargo;
    const conds = Object.entries(doc.conditions);
    const shown = conds.filter(([k]) => !condFilter || k.toLowerCase().includes(condFilter.toLowerCase())).slice(0, 200);

    pane.innerHTML = datalists() + `
      <section class="panel" style="margin-bottom:20px;display:flex;flex-wrap:wrap;align-items:center;gap:12px;">
        <button class="btn btn-primary" data-act="download">⬇ Download edited save</button>
        <button class="btn btn-secondary" data-act="revert"${hasEdits ? '' : ' disabled'}>Revert to original</button>
        <span id="sv-status" style="font-size:0.85rem;color:var(--c-text-dim);">${hasEdits ? 'This save has edits.' : 'No edits yet — changes save automatically.'}</span>
        <p style="flex-basis:100%;margin:0;font-size:0.8rem;color:var(--c-text-dim);">Close Endless Sky before replacing a save file, and keep a copy of the original.</p>
      </section>

      <section class="panel" style="margin-bottom:20px;">
        <h2 class="section-title">Pilot</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;">
          <label>First name<input class="text-input" data-f="first" value="${h(p.first)}"></label>
          <label>Last name<input class="text-input" data-f="last" value="${h(p.last)}"></label>
          <label>Credits<input class="text-input" data-f="credits" inputmode="numeric" value="${h(String(doc.credits))}"></label>
          <label>Day${numIn('data-f="day" min="1" max="31"', d.day)}</label>
          <label>Month${numIn('data-f="month" min="1" max="12"', d.month)}</label>
          <label>Year${numIn('data-f="year" min="1"', d.year)}</label>
          <label>System<input class="text-input" data-f="system" value="${h(doc.system || '')}"></label>
          <label>Planet<input class="text-input" data-f="planet" value="${h(doc.planet || '')}"></label>
        </div>
      </section>

      <section class="panel" style="margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
          <h2 class="section-title" style="margin:0;">Ships (${ships.length})</h2>
          ${window.SaveShipPicker ? '<button class="btn btn-primary btn-sm" data-act="addship">＋ Add a ship</button>' : ''}
        </div>
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem;">
          <thead><tr style="text-align:left;color:var(--c-text-dim);">
            <th>Flagship</th><th>Name</th><th>Model</th><th>Crew</th><th>Fuel</th><th>Shields</th><th>Hull</th><th>Parked</th><th></th>
          </tr></thead>
          <tbody>
          ${ships.map(s => `
            <tr data-ship="${s.index}" style="border-top:1px solid var(--c-border);">
              <td><input type="radio" name="sv-flag" data-s="flagship"${s.isFlagship ? ' checked' : ''} aria-label="Make flagship"></td>
              <td><input class="text-input" data-s="name" value="${h(s.name)}" style="min-width:140px;"></td>
              <td>${h(s.model)}</td>
              <td>${numIn('data-s="crew" min="0" step="1"', s.crew)}</td>
              <td>${numIn('data-s="fuel" min="0"', s.fuel)}</td>
              <td>${numIn('data-s="shields" min="0"', s.shields)}</td>
              <td>${numIn('data-s="hull" min="0"', s.hull)}</td>
              <td><input type="checkbox" data-s="parked"${s.parked ? ' checked' : ''} aria-label="Parked"></td>
              <td style="white-space:nowrap;">
                <button class="btn btn-secondary btn-sm" data-act="outfits">${openShip === s.index ? 'Hide outfits' : 'Outfits'}</button>
                ${window.SaveShipPicker ? '<button class="btn btn-secondary btn-sm" data-act="refit" title="Replace this ship\'s design with one of yours, a shared one or a game ship">Refit</button>' : ''}
                <button class="btn btn-secondary btn-sm" data-act="dup">Duplicate</button>
                <button class="btn btn-danger btn-sm" data-act="rmship">Remove</button>
              </td>
            </tr>
            ${openShip === s.index ? `<tr data-ship="${s.index}"><td colspan="9">${outfitEditor(s)}</td></tr>` : ''}`).join('')}
          </tbody>
        </table></div>
      </section>

      <section class="panel" style="margin-bottom:20px;">
        <h2 class="section-title">Cargo</h2>
        ${itemTable('cargo-c', 'Commodity', cargo.commodities, 'tons')}
        ${itemTable('cargo-o', 'Outfit', cargo.outfits, 'count', 'sv-outfit-names')}
      </section>

      <section class="panel" style="margin-bottom:20px;">
        <h2 class="section-title">Licenses</h2>
        <div class="ld-pills" style="margin-bottom:10px;">
          ${doc.licenses.map(l => `<span class="ld-pill">${h(l)} <button class="btn-remove" data-act="rmlic" data-name="${h(l)}" aria-label="Remove ${h(l)}">✕</button></span>`).join('') || '<span style="color:var(--c-text-dim);">No licenses.</span>'}
        </div>
        <div style="display:flex;gap:8px;"><input class="text-input" id="sv-new-lic" placeholder="License name, e.g. City-Ship" style="max-width:280px;">
          <button class="btn btn-secondary btn-sm" data-act="addlic">Add license</button></div>
      </section>

      <section class="panel" style="margin-bottom:20px;">
        <h2 class="section-title">Reputation</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px;">
          ${Object.entries(doc.reputations).map(([g, v]) => `
            <label style="display:flex;align-items:center;justify-content:space-between;gap:8px;">${h(g)}
              <input type="number" class="text-input" data-rep="${h(g)}" value="${h(v)}" style="width:110px;"></label>`).join('')}
        </div>
      </section>

      <section class="panel" style="margin-bottom:20px;">
        <h2 class="section-title">Missions</h2>
        ${doc.missions.length ? doc.missions.map((m, i) => `
          <div class="list-row" style="margin-bottom:6px;">
            <span class="list-row__label">${h(m.displayName)}
              <span style="font-size:0.75rem;color:var(--c-text-dim);">${m.kind === 'mission' ? 'accepted' : m.kind}${m.destination ? ' · to ' + h(m.destination) : ''}</span></span>
            <button class="btn btn-danger btn-sm" data-act="rmmission" data-i="${i}">Remove</button>
          </div>`).join('') : '<p style="color:var(--c-text-dim);">No missions in this save.</p>'}
        <label style="display:flex;gap:8px;align-items:center;margin-top:8px;font-size:0.85rem;">
          <input type="checkbox" id="sv-mission-conds"> Also clear the removed mission's offered/active/done/failed/declined history</label>
      </section>

      <section class="panel">
        <h2 class="section-title">Conditions (${conds.length})</h2>
        <p style="font-size:0.8rem;color:var(--c-text-dim);margin-top:0;">Story progress flags. Setting one to 0 removes it. Changing these can break missions — only edit ones you understand.</p>
        <input class="text-input" id="sv-cond-filter" placeholder="Search conditions…" value="${h(condFilter)}" style="max-width:320px;margin-bottom:10px;">
        <div>${shown.map(([k, v]) => `
          <div class="list-row" style="margin-bottom:4px;">
            <span class="list-row__label" style="word-break:break-word;">${h(k)}</span>
            <input type="number" class="text-input" data-cond="${h(k)}" value="${h(v)}" style="width:110px;">
            <button class="btn-remove" data-act="rmcond" data-name="${h(k)}" aria-label="Remove ${h(k)}">✕</button>
          </div>`).join('')}
          ${conds.length > shown.length ? `<p style="font-size:0.8rem;color:var(--c-text-dim);">Showing ${shown.length} of ${conds.length} — search to narrow down.</p>` : ''}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          <input class="text-input" id="sv-new-cond" placeholder="New condition name" style="max-width:280px;">
          <input type="number" class="text-input" id="sv-new-cond-val" value="1" style="width:90px;">
          <button class="btn btn-secondary btn-sm" data-act="addcond">Add condition</button>
        </div>
      </section>`;
    bind(pane);
  }

  function outfitEditor(s) {
    const entries = Object.entries(s.outfits);
    return `<div style="padding:10px 0 14px;">
      ${entries.map(([n, c]) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <input type="number" class="text-input" data-outfit="${h(n)}" value="${c}" min="0" step="1" style="width:80px;">
          <span>${h(n)}</span></div>`).join('') || '<p style="color:var(--c-text-dim);">No outfits installed.</p>'}
      <div style="display:flex;gap:8px;margin-top:8px;">
        <input class="text-input" list="sv-outfit-names" id="sv-add-outfit" placeholder="Outfit name" style="max-width:300px;">
        <input type="number" class="text-input" id="sv-add-outfit-n" value="1" min="1" style="width:80px;">
        <button class="btn btn-secondary btn-sm" data-act="addoutfit">Install</button>
      </div>
      <p style="font-size:0.78rem;color:var(--c-text-dim);">Installed weapons are not mounted on hardpoints automatically — the game assigns free hardpoints when it loads the ship.</p>
    </div>`;
  }

  function itemTable(kind, label, items, unit, list) {
    return `<div style="margin-bottom:14px;">
      <div style="font-weight:600;margin-bottom:6px;">${label}s</div>
      ${Object.entries(items).map(([n, c]) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <input type="number" class="text-input" data-item="${kind}" data-name="${h(n)}" value="${c}" min="0" step="1" style="width:90px;">
          <span>${h(n)}</span></div>`).join('') || `<p style="color:var(--c-text-dim);margin:0 0 6px;">None.</p>`}
      <div style="display:flex;gap:8px;">
        <input class="text-input" id="sv-add-${kind}" placeholder="${label} name"${list ? ` list="${list}"` : ''} style="max-width:260px;">
        <input type="number" class="text-input" id="sv-add-${kind}-n" value="1" min="1" style="width:90px;" aria-label="${unit}">
        <button class="btn btn-secondary btn-sm" data-act="additem" data-kind="${kind}">Add</button>
      </div></div>`;
  }

  // ── events ───────────────────────────────────────────────────────────────
  const nonNeg = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

  function bind(pane) {
    pane.onchange = e => {
      const t = e.target;
      try {
        if (t.dataset.f) return pilotField(t);
        const row = t.closest('[data-ship]');
        if (t.dataset.s && row) return shipField(doc.ship(Number(row.dataset.ship)), t);
        if (t.dataset.outfit !== undefined && row) {
          const n = nonNeg(t.value); if (n === null) return render();
          doc.ship(Number(row.dataset.ship)).setOutfit(t.dataset.outfit, Math.trunc(n));
          return changed();
        }
        if (t.dataset.item) {
          const n = nonNeg(t.value); if (n === null) return render();
          if (t.dataset.item === 'cargo-c') doc.setCargoCommodity(t.dataset.name, n); else doc.setCargoOutfit(t.dataset.name, n);
          return changed();
        }
        if (t.dataset.rep !== undefined) { const n = Number(t.value); if (!Number.isFinite(n)) return render(); doc.setReputation(t.dataset.rep, n); return changed(); }
        if (t.dataset.cond !== undefined) { doc.setCondition(t.dataset.cond, Math.trunc(Number(t.value) || 0)); return changed(); }
      } catch (err) { say(err.message, 'danger'); render(); }
    };
    const filter = $('sv-cond-filter');
    if (filter) filter.oninput = () => {
      condFilter = filter.value;
      const pos = filter.selectionStart;
      render();
      const f2 = $('sv-cond-filter'); f2.focus(); f2.setSelectionRange(pos, pos);
    };
    pane.onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const row = b.closest('[data-ship]');
      const ship = row ? doc.ship(Number(row.dataset.ship)) : null;
      try {
        switch (b.dataset.act) {
          case 'download': return download();
          case 'revert': return revert();
          case 'outfits': openShip = openShip === ship.index ? null : ship.index; return render();
          case 'dup': doc.duplicateShip(ship.index, `${ship.name || ship.model} (copy)`); return changed('Ship duplicated.');
          case 'addship':
            return window.SaveShipPicker.open({ mode: 'add', title: 'Add a ship to this save', onPick: c => applyPicked(c, null) });
          case 'refit':
            return window.SaveShipPicker.open({ mode: 'refit', title: `Refit “${ship.name || ship.model}” with…`, onPick: c => applyPicked(c, ship.index) });
          case 'rmship':
            if (!confirm(`Remove "${ship.name || ship.model}" from this save? Its cargo goes with it.`)) return;
            doc.removeShip(ship.index); openShip = null; return changed('Ship removed.');
          case 'addoutfit': {
            const name = $('sv-add-outfit').value.trim(); const n = Math.trunc(nonNeg($('sv-add-outfit-n').value) || 0);
            if (!name || !n) return;
            doc.ship(openShip).setOutfit(name, (doc.ship(openShip).outfits[name] || 0) + n);
            return changed(`Installed ${n} × ${name}.`);
          }
          case 'additem': {
            const kind = b.dataset.kind; const name = $(`sv-add-${kind}`).value.trim();
            const n = Math.trunc(nonNeg($(`sv-add-${kind}-n`).value) || 0);
            if (!name || !n) return;
            const cur = doc.cargo[kind === 'cargo-c' ? 'commodities' : 'outfits'][name] || 0;
            if (kind === 'cargo-c') doc.setCargoCommodity(name, cur + n); else doc.setCargoOutfit(name, cur + n);
            return changed(`Added ${n} × ${name}.`);
          }
          case 'rmlic': doc.removeLicense(b.dataset.name); return changed();
          case 'addlic': { const v = $('sv-new-lic').value.trim(); if (!v) return; doc.addLicense(v); return changed(`Added license ${v}.`); }
          case 'rmcond': doc.deleteCondition(b.dataset.name); return changed();
          case 'addcond': {
            const k = $('sv-new-cond').value.trim(); if (!k) return;
            doc.setCondition(k, Math.trunc(Number($('sv-new-cond-val').value) || 0)); return changed(`Set ${k}.`);
          }
          case 'rmmission': {
            const m = doc.missions[Number(b.dataset.i)];
            if (!m || !confirm(`Remove the mission "${m.displayName}"? Any cargo or passengers it put on your ships are removed too.`)) return;
            doc.removeMission(m.id, { kinds: [m.kind], conditions: $('sv-mission-conds').checked });
            return changed('Mission removed.');
          }
        }
      } catch (err) { say(err.message, 'danger'); render(); }
    };
  }

  // ── add / refit from the ship picker ─────────────────────────────────────
  function gameIndex() {
    const ships = new Map(), outfits = new Map();
    for (const p of Object.values(window.allData || {})) {
      for (const s of p.ships || []) if (s && s.name && !ships.has(s.name)) ships.set(s.name, s);
      for (const o of p.outfits || []) if (o && o.name && !outfits.has(o.name)) outfits.set(o.name, o);
    }
    return { ships, outfits };
  }

  function applyPicked(choice, refitIndex) {
    const D = window.ShipDefinition;
    if (!D || !doc) return;
    const { ships, outfits } = gameIndex();
    let def, attrs, outs;
    if (choice.kind === 'game') {
      def = D.fromGameShip(choice.ship);
      attrs = (choice.ship.baseShip ? ships.get(choice.ship.baseShip)?.attributes : choice.ship.attributes) || {};
      outs = D.outfitList(choice.ship.outfits);
    } else {
      def = D.fromBuild(choice.build, new Set(ships.keys()));
      attrs = { ...(choice.build._sourceShip ? ships.get(choice.build._sourceShip)?.attributes : {}), ...(choice.build.attributes || {}) };
      outs = D.outfitList(choice.build.outfits);
    }
    const levels = D.maxLevels(attrs, outs, outfits);
    const unknown = outs.map(([n]) => n).filter(n => !outfits.has(n));
    const warn = unknown.length ? `\n\n${unknown.length} outfit${unknown.length === 1 ? ' isn’t' : 's aren’t'} in the plugins loaded here (${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? '…' : ''}) — the game will drop ${unknown.length === 1 ? 'it' : 'them'} unless that plugin is installed.` : '';

    try {
      if (refitIndex === null) {
        const name = prompt(`Name for the new ship (it starts at ${doc.planet || doc.system || 'your location'}, repaired and fuelled):${warn}`, choice.label);
        if (name === null) return;
        doc.addShip(def, { name: name.trim() || choice.label, levels });
        return changed(`Added “${name.trim() || choice.label}” to the save.`);
      }
      const target = doc.ship(refitIndex);
      if (!confirm(`Refit “${target.name || target.model}” as ${choice.label}?\n\nIts design and installed outfits are replaced (outfits it had aren’t kept anywhere). It keeps its name, location and history, and is repaired, refuelled and crewed.${warn}`)) return;
      doc.replaceShipDefinition(refitIndex, def, { levels });
      openShip = null;
      return changed(`Refitted “${target.name || target.model}”.`);
    } catch (err) { say(err.message, 'danger'); }
  }

  function pilotField(t) {
    const v = t.value.trim();
    switch (t.dataset.f) {
      case 'first': case 'last': {
        const p = doc.pilot;
        if (!v) { say('The pilot needs a first and last name.', 'danger'); return render(); }
        doc.setPilot(t.dataset.f === 'first' ? v : p.first, t.dataset.f === 'last' ? v : p.last);
        return changed();
      }
      case 'credits':
        if (!/^-?\d+$/.test(v)) { say('Credits must be a whole number.', 'danger'); return render(); }
        doc.setCredits(v); return changed();
      case 'day': case 'month': case 'year': {
        const d = { ...(doc.date || { day: 1, month: 1, year: 3013 }), [t.dataset.f]: Math.trunc(Number(v)) };
        const max = new Date(Date.UTC(2000, d.month, 0)).getUTCDate();
        if (!(d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= max && d.year >= 1)) { say('That date does not exist.', 'danger'); return render(); }
        doc.setDate(d.day, d.month, d.year); return changed();
      }
      case 'system': if (!v) return render(); doc.setLocation(v, doc.planet); return changed();
      case 'planet': doc.setLocation(doc.system, v || null); return changed();
    }
  }

  function shipField(s, t) {
    switch (t.dataset.s) {
      case 'flagship': doc.setFlagshipIndex(s.index); return changed(`${s.name || s.model} is now your flagship.`);
      case 'name': s.name = t.value; return changed();
      case 'parked':
        if (t.checked && s.isFlagship) { say('Your flagship cannot be parked — choose another flagship first.', 'danger'); return render(); }
        s.parked = t.checked; return changed();
      default: {
        const n = nonNeg(t.value); if (n === null) { say('Enter a number of 0 or more.', 'danger'); return render(); }
        s[t.dataset.s] = t.dataset.s === 'crew' ? Math.trunc(n) : n; return changed();
      }
    }
  }

  function download() {
    const problems = doc.validate();
    if (problems.length && !confirm(`This save has problems the game may not like:\n\n• ${problems.join('\n• ')}\n\nDownload anyway?`)) return;
    const p = doc.pilot;
    const name = `${p.first} ${p.last}`.trim().replace(/[\\/:*?"<>|]+/g, '') || 'save';
    const url = URL.createObjectURL(new Blob([doc.toString()], { type: 'text/plain' }));
    Object.assign(document.createElement('a'), { href: url, download: `${name}.txt` }).click();
    URL.revokeObjectURL(url);
    say(`Downloaded ${name}.txt`, 'success');
  }

  async function revert() {
    if (!confirm('Throw away all edits to this save and go back to the file you uploaded?')) return;
    const rec = await V.revert(docId);
    doc = E.SaveFile.fromText(rec.original);
    hasEdits = false;
    const parsed = parseESSaveFile(rec.original);
    smSetSaveData(docId, parsed); parsedSave = parsed;
    origRenderResults(); ensureTab();
    render();
    say('Reverted to the original save.', 'success');
  }
  // registered last: onAuthChange calls back immediately
  if (window.EsAuth) window.EsAuth.onAuthChange(() => { renderCloudLibrary(); if (activeTab() === 'edit') loadEditor(); });
})();
