'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  saveShipPicker.js — choose a ship to add to a save, or to refit one with
//
//  Three groups, in this order:
//    1. Your ships     — every ship in your builder fleets, plus ships you've
//                        shared from your account (private or public)
//    2. Shared by other pilots — public ships only (the database only
//                        returns public, non-hidden ships of other users)
//    3. Game ships     — ships and variants from the plugins loaded here
//
//  window.SaveShipPicker.open({ mode: 'add'|'refit', title, onPick(choice) })
//  choice = { kind: 'build', build, label, from }  |  { kind: 'game', ship, label, from }
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const PAGE = 30;
  let state = null;

  function gameShips() {
    const local = window.DataLoader?.LOCAL_PLUGIN_ID || '__local_builds__';
    const seen = new Set(), out = [];
    for (const [id, p] of Object.entries(window.allData || {})) {
      if (id === local || p._placeholder) continue;
      for (const s of [...(p.ships || []), ...(p.variants || [])]) {
        if (!s || !s.name || seen.has(s.name)) continue;
        seen.add(s.name);
        out.push({ kind: 'game', ship: s, label: s.name,
          sub: [s.attributes?.category || (s.baseShip ? `variant of ${s.baseShip}` : ''), p.displayName || id].filter(Boolean).join(' · ') });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  async function yourShips() {
    const out = [], ids = new Set();
    if (window.FleetStore) {
      for (const f of window.FleetStore.list()) {
        for (const b of window.FleetStore.get(f.id).ships || []) {
          ids.add(String(b.id));
          out.push({ kind: 'build', build: b, label: b.name || b.variant || 'Unnamed ship',
            sub: [b.attributes?.category, `fleet “${f.name}”`].filter(Boolean).join(' · ') });
        }
      }
    }
    const me = window.EsAuth?.getCurrentUser();
    if (me && window.supabaseClient) {
      const { data } = await window.supabaseClient.from('saved_ships').select('id, name, is_public, source_ship_id, build_data').eq('user_id', me.id).order('updated_at', { ascending: false });
      for (const r of data || []) {
        if (r.source_ship_id && ids.has(String(r.source_ship_id))) continue;   // already listed from a fleet
        out.push({ kind: 'build', build: { ...(r.build_data || {}), name: r.build_data?.name || r.name }, label: r.name,
          sub: [r.build_data?.attributes?.category, r.is_public ? 'shared publicly' : 'saved privately'].filter(Boolean).join(' · ') });
      }
    }
    return out;
  }

  async function sharedShips(query) {
    const sb = window.supabaseClient;
    if (!sb) return [];
    const me = window.EsAuth?.getCurrentUser();
    let q = sb.from('saved_ships').select('id, name, user_id, build_data, updated_at').eq('is_public', true).order('updated_at', { ascending: false }).limit(100);
    if (me) q = q.neq('user_id', me.id);
    if (query) q = q.ilike('name', `%${query.replace(/[\\%_]/g, c => '\\' + c)}%`);
    const { data, error } = await q;
    if (error) return [];
    const userIds = [...new Set((data || []).map(r => r.user_id))];
    const { data: profs } = userIds.length ? await sb.from('profiles').select('id, username').in('id', userIds) : { data: [] };
    const nameOf = id => (profs || []).find(p => p.id === id)?.username || 'a pilot';
    return (data || []).map(r => ({ kind: 'build', build: { ...(r.build_data || {}), name: r.build_data?.name || r.name }, label: r.name,
      sub: [r.build_data?.attributes?.category, `by ${nameOf(r.user_id)}`].filter(Boolean).join(' · ') }));
  }

  // ── modal ────────────────────────────────────────────────────────────────
  function ensure() {
    let m = document.getElementById('ssp-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'ssp-modal'; m.className = 'modal-overlay';
    m.innerHTML = `
      <div class="modal-box" style="width:min(720px,96vw);max-height:90vh;display:flex;flex-direction:column;">
        <div class="modal-header"><div class="modal-title" id="ssp-title">Add a ship</div>
          <button class="modal-close" data-close aria-label="Close">×</button></div>
        <input class="text-input" id="ssp-search" placeholder="Search ships by name or category…" autocomplete="off" style="margin-bottom:12px;">
        <div id="ssp-body" style="overflow-y:auto;flex:1;min-height:200px;"></div>
      </div>`;
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && m.classList.contains('active')) close(); });
    document.body.appendChild(m);
    let t = null;
    m.querySelector('#ssp-search').addEventListener('input', e => {
      state.query = e.target.value.trim();
      state.limits = { yours: PAGE, shared: PAGE, game: PAGE };
      renderBody();
      clearTimeout(t);
      t = setTimeout(async () => { const q = state && state.query; const r = await sharedShips(q); if (state && state.query === q) { state.shared = r; renderBody(); } }, 350);
    });
    return m;
  }
  function close() { document.getElementById('ssp-modal')?.classList.remove('active'); state = null; }

  function matches(item) {
    const q = (state.query || '').toLowerCase();
    return !q || item.label.toLowerCase().includes(q) || (item.sub || '').toLowerCase().includes(q);
  }

  function group(key, title, items, emptyText) {
    if (items === null) return `<h3 class="ssp-h">${h(title)}</h3><p class="ssp-empty">Loading…</p>`;
    const list = items.filter(matches);
    const shown = list.slice(0, state.limits[key]);
    return `<h3 class="ssp-h">${h(title)} <span style="font-weight:400;color:var(--c-text-dim);">(${list.length})</span></h3>
      ${shown.length ? shown.map(it => `
        <div class="list-row" style="margin-bottom:6px;">
          <span class="list-row__label">${h(it.label)}<span style="display:block;font-size:0.78rem;color:var(--c-text-dim);">${h(it.sub || '')}</span></span>
          <button class="btn btn-primary btn-sm" data-pick="${key}:${items.indexOf(it)}">${state.mode === 'refit' ? 'Refit with this' : 'Add'}</button>
        </div>`).join('') : `<p class="ssp-empty">${h(emptyText)}</p>`}
      ${list.length > shown.length ? `<button class="btn btn-secondary btn-sm" data-more="${key}" style="margin-bottom:10px;">Show ${Math.min(PAGE, list.length - shown.length)} more</button>` : ''}`;
  }

  function renderBody() {
    if (!state) return;
    const body = document.getElementById('ssp-body');
    const loggedIn = !!window.EsAuth?.getCurrentUser();
    body.innerHTML = `<style>.ssp-h{font-size:0.95rem;margin:12px 0 8px;}.ssp-h:first-child{margin-top:0;}.ssp-empty{color:var(--c-text-dim);font-size:0.85rem;margin:0 0 10px;}</style>` +
      group('yours', 'Your ships', state.yours, state.query ? 'None of your ships match.' : 'Ships you build in the ship builder show up here.') +
      group('shared', 'Shared by other pilots', state.shared, loggedIn || state.shared?.length ? 'No shared ships match.' : 'No shared ships match.') +
      group('game', 'Game ships', state.game, 'No game ships match — check which plugins are active.');
    body.onclick = e => {
      const more = e.target.closest('[data-more]');
      if (more) { state.limits[more.dataset.more] += PAGE; renderBody(); return; }
      const pick = e.target.closest('[data-pick]');
      if (!pick) return;
      const [key, i] = pick.dataset.pick.split(':');
      const item = state[key][Number(i)];
      const cb = state.onPick;
      close();
      cb({ ...item, from: key });
    };
  }

  async function open({ mode = 'add', title, onPick }) {
    const m = ensure();
    state = { mode, onPick, query: '', limits: { yours: PAGE, shared: PAGE, game: PAGE }, yours: null, shared: null, game: gameShips() };
    document.getElementById('ssp-title').textContent = title || (mode === 'refit' ? 'Refit with…' : 'Add a ship');
    m.querySelector('#ssp-search').value = '';
    m.classList.add('active');
    renderBody();
    setTimeout(() => m.querySelector('#ssp-search').focus(), 30);
    const [yours, shared] = await Promise.all([yourShips().catch(() => []), sharedShips('').catch(() => [])]);
    if (!state) return;
    state.yours = yours; state.shared = shared;
    renderBody();
  }

  window.SaveShipPicker = { open };
})();
