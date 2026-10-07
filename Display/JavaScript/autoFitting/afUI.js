'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  autoFitting/afUI.js — the "⚡ Auto-fit" window in the ship builder
//
//  Pick a goal, choose which outfits count as "available to you" (factions,
//  buying, stealing with its story consequences, mission rewards, licences,
//  what you already own), set the turning/speed you won't go below, and it
//  builds the best fit it can for the hull you're editing — with the
//  stats before/after, where to get every outfit, what stealing would cost
//  and how to undo that, and warnings (energy, heat, fuel, ammo uptimes).
//
//  Needs: AfStats, AfPool, AfOptimizer, shipBuilder.js (sbCurrentShip …),
//         ShipDefinition (for enemy ships' loadouts).
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const S = () => window.AfStats, P = () => window.AfPool, O = () => window.AfOptimizer;
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (n, d = 0) => (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: d });

  const GOALS = [
    ['counter', '🎯 Beat an enemy'], ['dps', '💥 Damage'], ['accel', '🚀 Acceleration'], ['speed', '⚡ Top speed'], ['tank', '🛡 Tank'],
    ['cargo', '📦 Cargo'], ['bunks', '🛏 Bunks'], ['general', '⚖ All-round'],
  ];

  let ui = null;   // state while the window is open

  // ── data helpers ─────────────────────────────────────────────────────────
  function outfitIndex() {
    const m = new Map();
    for (const p of Object.values(window.AfStats.activeData())) for (const o of p.outfits || []) if (o && o.name && !m.has(o.name)) m.set(o.name, o);
    return m;
  }
  function designOutfits(design) {
    return (design.outfits || []).map(o => [String(o.name).replace(/^"([^"]*)"$/, '$1'), Number(o.count) || 1]);
  }
  function allShips() {
    const m = new Map();
    for (const p of Object.values(window.AfStats.activeData())) for (const s of [...(p.ships || []), ...(p.variants || [])]) if (s && s.name && !m.has(s.name)) m.set(s.name, s);
    return m;
  }
  function shipLoadout(s, ships) {
    const D = window.ShipDefinition;
    const outs = D ? D.outfitList(s.outfits) : [];
    const hull = s.baseShip ? ships.get(s.baseShip) : s;
    return { base: S().hullAttrs(hull || s), outs };
  }
  /** Damage mix of chosen enemies (or of every armed ship, weighted by damage). */
  function enemyProfile(names) {
    const ships = allShips(), idx = outfitIndex();
    const pick = names && names.length ? names.map(n => ships.get(n)).filter(Boolean) : [...ships.values()];
    const ds = [];
    for (const s of pick) {
      try { const { base, outs } = shipLoadout(s, ships); const d = S().derive(base, outs, idx); if (d.dps.total > 0) ds.push(d); } catch (_) {}
    }
    return O().damageProfile(ds);
  }

  // Ship names as players know them: display name first, internal name after.
  const SN = () => window.ShipNames;
  const shipLabel = name => { const s = allShips().get(name); return s && SN() ? SN().label(s) : name; };
  const shipHtml = name => { const s = allShips().get(name); return s && SN() ? SN().html(s) : h(name); };
  function shipOptions() {
    // the box searches both names (browsers match the value and the label)
    return [...allShips().values()].sort((a, b) => shipLabel(a.name).localeCompare(shipLabel(b.name)))
      .map(s => { const l = shipLabel(s.name); return `<option value="${h(s.name)}"${l !== s.name ? ` label="${h(l)} — ${h(s.name)}"` : ''}>`; }).join('');
  }

  // ── window ───────────────────────────────────────────────────────────────
  function modal() {
    let m = document.getElementById('af-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'af-modal'; m.className = 'modal-overlay';
    m.innerHTML = `<div class="modal-box" style="width:min(760px,96vw);max-height:92dvh;overflow-y:auto;">
      <div class="modal-header"><div class="modal-title">⚡ Auto-fit</div>
        <button class="modal-close" data-af="close" aria-label="Close">×</button></div>
      <div id="af-body"></div></div>`;
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-af="close"]')) return close();
      const b = e.target.closest('[data-af]');
      if (!b) return;
      const act = b.dataset.af;
      if (act === 'goal') { ui.goal = b.dataset.goal; ui.result = null; render(); }
      else if (act === 'run') run();
      else if (act === 'apply') apply();
      else if (act === 'fac-all') { ui.factions = new Set(ui.ctx.factions.map(f => f.name)); render(); }
      else if (act === 'fac-none') { ui.factions = new Set(); render(); }
      else if (act === 'fac-visited') { ui.factions = new Set(ui.ctx.factions.filter(f => f.visited).map(f => f.name)); render(); }
      else if (act === 'enemy-rm') { ui.enemies = ui.enemies.filter(n => n !== b.dataset.name); ui.result = null; render(); }
      else if (act === 'foe-rm') { ui.foe.ships = ui.foe.ships.filter(n => n !== b.dataset.name); refreshFoe(); render(); }
    });
    m.addEventListener('change', e => {
      const t = e.target;
      if (!ui) return;
      if (t.dataset.fac) { t.checked ? ui.factions.add(t.dataset.fac) : ui.factions.delete(t.dataset.fac); return; }
      if (t.id === 'af-weapons') ui.opts.weapons = t.value;
      else if (t.id === 'af-minturn') ui.opts.minTurn = Number(t.value) || 0;
      else if (t.id === 'af-minspeed') ui.opts.minSpeed = Number(t.value) || 0;
      else if (t.id === 'af-fight') ui.opts.fightSeconds = Math.max(5, Number(t.value) || 60);
      else if (t.name && t.name.startsWith('af-f-')) {
        ui.filters[t.name.slice(5)] = t.type === 'checkbox' ? t.checked : t.value;
        if (t.name === 'af-f-allowPlunder') render();   // shows/hides the stealing policy
      }
      else if (t.id === 'af-foe-gov') { ui.foe.government = t.value; ui.foe.ships = []; refreshFoe(); render(); }
      else if (t.id === 'af-foe-add' && t.value) { if (!ui.foe.ships.includes(t.value)) ui.foe.ships.push(t.value); t.value = ''; refreshFoe(); render(); }
      else if (t.id === 'af-foe-count') { ui.foe.count = Math.max(1, Math.min(10, Number(t.value) || 1)); ui.result = null; }
      else if (t.id === 'af-foe-speed') { ui.foe.matchSpeed = t.checked; ui.result = null; }
      else if (t.id === 'af-enemy-add' && t.value) {
        if (!ui.enemies.includes(t.value)) ui.enemies.push(t.value);
        t.value = ''; ui.result = null; render();
      }
    });
    document.body.appendChild(m);
    return m;
  }
  function close() { document.getElementById('af-modal')?.classList.remove('active'); ui = null; }

  async function open() {
    if (!S() || !P() || !O()) return;
    if (typeof onBuilderChange === 'function') onBuilderChange();
    const design = typeof sbCurrentShip !== 'undefined' ? sbCurrentShip : null;
    if (!design) return;
    const base = S().hullAttrs(design);
    const idx = outfitIndex();
    const current = S().derive(base, designOutfits(design), idx);
    ui = {
      design, base, idx, current, ctx: null, loading: true, result: null, goal: 'general', enemies: [],
      opts: { weapons: 'both', minTurn: 0, minSpeed: 0, fightSeconds: 60 },
      peers: null,
      foe: { government: '', ships: [], count: 2, matchSpeed: false, profile: null, describe: null },
      filters: { allowBuy: true, visitedOnly: false, allowPlunder: false, plunderPolicy: 'fixable', allowMissions: false, requireLicences: true, includeOwned: true },
      factions: null,
    };
    // Handling to aim for: what similar ships (class & weight) manage, not a fixed number
    try { ui.peers = window.AfPeers ? window.AfPeers.reference(design) : null; } catch (_) { ui.peers = null; }
    ui.opts.minTurn = Math.round(ui.peers ? ui.peers.turn : current.turnRate);
    ui.opts.minSpeed = Math.round(ui.peers ? ui.peers.speed : current.maxSpeed);
    modal().classList.add('active');
    render();
    try { ui.ctx = await P().load(); }
    catch (err) { ui.error = 'Could not load outfit availability: ' + err.message; }
    if (!ui) return;
    ui.loading = false;
    const visited = ui.ctx?.factions.filter(f => f.visited).map(f => f.name) || [];
    ui.factions = new Set(visited.length ? visited : (ui.ctx?.factions || []).map(f => f.name));
    ui.filters.visitedOnly = false;
    render();
  }

  // ── render ───────────────────────────────────────────────────────────────
  function render() {
    const body = document.getElementById('af-body');
    if (!ui || !body) return;
    const c = ui.current, d = ui.design, save = ui.ctx?.save;
    const tab = ([id, label]) => `<button class="btn btn-${ui.goal === id ? 'primary' : 'secondary'} btn-sm" data-af="goal" data-goal="${id}">${label}</button>`;
    const chk = (k, label, hint) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:4px 0;font-size:0.86rem;">
      <input type="checkbox" name="af-f-${k}"${ui.filters[k] ? ' checked' : ''}><span>${label}${hint ? `<span style="display:block;font-size:0.76rem;color:var(--c-text-dim);">${hint}</span>` : ''}</span></label>`;
    const T = window.AfThreat;
    const goalOptions = {
      counter: !T ? '' : (() => {
        const govs = T.governments();
        const f = ui.foe;
        return `<div style="font-size:0.86rem;">
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            <label>Government <select id="af-foe-gov" class="text-input" style="width:auto;display:inline-block;">
              <option value="">— pick one —</option>
              ${govs.map(g => `<option value="${h(g.name)}"${f.government === g.name ? ' selected' : ''}>${h(g.name)} (${g.ships} ships)</option>`).join('')}</select></label>
            <span style="color:var(--c-text-dim);">or specific ships:</span>
            <input id="af-foe-add" class="text-input" list="af-enemy-list" placeholder="Add a ship…" style="max-width:220px;">
            <datalist id="af-enemy-list">${shipOptions()}</datalist>
          </div>
          ${f.ships.length ? `<div style="margin-top:6px;">${f.ships.map(n => `<span class="ld-pill" style="margin:2px;">${shipHtml(n)} <button class="btn-remove" data-af="foe-rm" data-name="${h(n)}" aria-label="Remove">✕</button></span>`).join('')}</div>` : ''}
          ${!govs.length ? '<div style="color:var(--c-warn-text,#fbbf24);margin-top:6px;">No government data yet — run the Parse workflow once, or add specific ships.</div>' : ''}
          <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;">
            <label>How many at once <input id="af-foe-count" type="number" min="1" max="10" class="text-input" value="${f.count}" style="width:64px;display:inline-block;"></label>
            ${f.profile ? `<label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="af-foe-speed"${f.matchSpeed ? ' checked' : ''}> At least as fast as them (~${fmt(f.profile.defence.speed)}) — so they can't run or chase you down</label>` : ''}
          </div>
          ${f.profile ? `<div style="margin-top:10px;padding:10px 12px;border:1px solid var(--c-border);border-radius:8px;">
            <div style="font-weight:600;margin-bottom:4px;">What you're up against (${f.profile.count} ship${f.profile.count === 1 ? '' : 's'})</div>
            <ul style="margin:0;padding-left:18px;">${f.describe.lines.map(l => `<li>${h(l)}</li>`).join('')}</ul>
            ${f.describe.priorities.length ? `<div style="margin-top:6px;">The fit will look for: <strong>${h(f.describe.priorities.join(', '))}</strong> — and weapons that suit their shields and hull.</div>` : ''}
            <div style="margin-top:4px;color:var(--c-text-dim);font-size:0.78rem;">Hardest hitters: ${f.profile.worst.map(w => h(shipLabel(w.name))).join(', ')}</div>
          </div>` : (f.government || f.ships.length ? '<p style="color:var(--c-text-dim);">None of those ships could be measured.</p>' : '')}
        </div>`;
      })(),
      dps: `<label style="font-size:0.86rem;">Weapons <select id="af-weapons" class="text-input" style="width:auto;display:inline-block;margin-left:6px;">
          ${[['both', 'Primary and secondary'], ['primary', 'Primary only (guns & turrets)'], ['secondary', 'Secondary only (missiles, launchers)']]
            .map(([v, l]) => `<option value="${v}"${ui.opts.weapons === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`,
      tank: `<div style="font-size:0.86rem;">Protect against
          ${ui.enemies.length ? ui.enemies.map(n => `<span class="ld-pill" style="margin:2px;">${h(n)} <button class="btn-remove" data-af="enemy-rm" data-name="${h(n)}" aria-label="Remove">✕</button></span>`).join('') : '<em style="color:var(--c-text-dim);">the average damage of every armed ship</em>'}
          <input id="af-enemy-add" class="text-input" list="af-enemy-list" placeholder="Add an enemy ship…" style="margin-top:6px;">
          <datalist id="af-enemy-list">${shipOptions()}</datalist></div>`,
    };
    body.innerHTML = `
      <p style="margin:0 0 10px;font-size:0.86rem;color:var(--c-text-mid);">Fitting <strong>${h(d.name || 'this ship')}</strong>${d._sourceShip ? ` (${h(shipLabel(d._sourceShip))} hull)` : ''}.
        ${save ? `Using <strong>${h(save.pilot)}</strong>'s save for what you can reach.` : 'Open a save on Saves &amp; Account and it will use where you\'ve been, your licences and reputations.'}
        <span style="display:block;font-size:0.78rem;color:var(--c-text-dim);">Only outfits and ships from your selected plugins are used (${Object.keys(window.AfStats.activeData()).filter(k => k !== '__local_builds__').map(h).join(', ') || 'none'}) — change them with ☰ Select Plugins.</span></p>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">${GOALS.map(tab).join('')}</div>
      ${goalOptions[ui.goal] || ''}

      <details style="margin-top:12px;" ${ui.result ? '' : 'open'}><summary style="cursor:pointer;font-weight:600;">Limits</summary>
        <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:0.86rem;">
          <label>Turn at least <input id="af-minturn" type="number" class="text-input" value="${ui.opts.minTurn}" style="width:80px;display:inline-block;"> °/s</label>
          ${ui.goal !== 'speed' && ui.goal !== 'accel' ? `<label>Speed at least <input id="af-minspeed" type="number" class="text-input" value="${ui.opts.minSpeed}" style="width:80px;display:inline-block;"></label>` : ''}
          <label>Fight length <input id="af-fight" type="number" class="text-input" value="${ui.opts.fightSeconds}" style="width:70px;display:inline-block;"> s</label>
        </div>
        <div style="font-size:0.78rem;color:var(--c-text-dim);margin-top:6px;">${peerNote()}</div>
        <div style="font-size:0.76rem;color:var(--c-text-dim);margin-top:4px;">Batteries may cover a fight that long; flying around must be sustainable.</div>
      </details>

      <details style="margin-top:10px;" ${ui.result ? '' : 'open'}><summary style="cursor:pointer;font-weight:600;">Where outfits can come from</summary>
        ${ui.loading ? '<p>Loading what\'s available…</p>' : ui.error ? `<p style="color:var(--c-danger-text);">${h(ui.error)}</p>` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:4px 16px;margin-top:6px;">
          <div>
            ${chk('allowBuy', 'Buy from outfitters')}
            ${save ? chk('visitedOnly', 'Only outfitters I\'ve visited') : ''}
            ${chk('allowPlunder', 'Steal (plunder) from ships', 'Boarding or destroying ships costs reputation with whoever flies them.')}
            ${ui.filters.allowPlunder ? `<select name="af-f-plunderPolicy" class="text-input" style="margin:2px 0 6px 28px;width:calc(100% - 28px);">
              ${[['safe', 'Only when it costs nothing (they\'re already hostile)'], ['fixable', 'Also when a story mission I haven\'t done repairs it'], ['any', 'Anything — I don\'t mind the reputation hit']]
                .map(([v, l]) => `<option value="${v}"${ui.filters.plunderPolicy === v ? ' selected' : ''}>${l}</option>`).join('')}</select>` : ''}
            ${chk('allowMissions', 'Mission rewards')}
            ${save ? chk('requireLicences', 'Only outfits my licences allow') : ''}
            ${save ? chk('includeOwned', 'Outfits I already own') : ''}
          </div>
          <div>
            <div style="font-size:0.86rem;margin:4px 0;">Factions / species
              <button class="btn btn-secondary btn-sm" data-af="fac-all">All</button>
              <button class="btn btn-secondary btn-sm" data-af="fac-none">None</button>
              ${save ? '<button class="btn btn-secondary btn-sm" data-af="fac-visited">Ones I\'ve met</button>' : ''}</div>
            <div style="max-height:150px;overflow-y:auto;border:1px solid var(--c-border);border-radius:6px;padding:4px 8px;">
              ${ui.ctx.factions.map(f => `<label style="display:flex;gap:6px;align-items:center;font-size:0.82rem;margin:2px 0;">
                <input type="checkbox" data-fac="${h(f.name)}"${ui.factions.has(f.name) ? ' checked' : ''}> ${h(f.name)}
                <span style="color:var(--c-text-dim);">${f.count}${f.visited ? ' · met' : ''}</span></label>`).join('')}
            </div>
          </div>
        </div>`}
      </details>

      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
        <button class="btn btn-primary" data-af="run"${ui.loading ? ' disabled' : ''}>${ui.running ? 'Working…' : ui.result ? 'Fit again' : 'Find the best fit'}</button>
        ${ui.result ? '<button class="btn btn-secondary" data-af="apply">Use this fit</button>' : ''}
      </div>
      ${ui.notice ? `<p style="color:var(--c-warn-text,#fbbf24);margin:8px 0 0;">${h(ui.notice)}</p>` : ''}
      <div id="af-result">${ui.result ? resultHtml() : ''}</div>`;
  }

  function peerNote() {
    const p = ui.peers;
    if (!p) return 'No similar ships to compare with, so these start at this ship\'s current handling — change them if you like.';
    const src = Object.entries(p.bySource).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'game' ? 'base game' : k === 'plugin' ? 'plugin' : 'of your own'}`).join(', ');
    const t = Math.round(p.turn), sp = Math.round(p.speed);
    const why = p.basis === 'same class and weight' ? `${h(p.category)}s weighing ${fmt(p.mass.min)}–${fmt(p.mass.max)} t`
      : p.basis === 'same class' ? `${h(p.category)}s (no others this weight)` : `ships weighing ${fmt(p.mass.min)}–${fmt(p.mass.max)} t`;
    return `These start at what similar ships manage: a typical (median) turn of <strong>${t}°/s</strong> and top speed of <strong>${sp}</strong>,
      from ${p.count} ${why} — ${src}. Closest: ${p.examples.map(n => h(shipLabel(n))).join(', ')}.`;
  }

  function statRows(a, b) {
    const rows = [
      ['Damage / s', a.dps.total, b.dps.total], ['  primary', a.dps.primary, b.dps.primary], ['  secondary', a.dps.secondary, b.dps.secondary],
      ['Top speed', a.maxSpeed, b.maxSpeed], ['Acceleration', a.acceleration, b.acceleration], ['Turning °/s', a.turnRate, b.turnRate],
      ['Shields', a.shields, b.shields], ['Shield regen / s', a.shieldRegen, b.shieldRegen], ['Hull', a.hull, b.hull], ['Hull repair / s', a.hullRegen, b.hullRegen],
      ['Cargo', a.cargo, b.cargo], ['Bunks', a.bunks, b.bunks], ['Jumps of fuel', a.fuel.jumps, b.fuel.jumps],
      ['Energy / s in a fight', a.energy.perSec.fighting, b.energy.perSec.fighting], ['Heat in a fight', a.heat.equilibriumPct.fighting, b.heat.equilibriumPct.fighting, '%'],
      ['Outfit cost', a.cost, b.cost],
    ];
    return rows.map(([l, x, y, unit]) => {
      const diff = y - x, better = l.startsWith('Heat') || l === 'Outfit cost' ? diff < 0 : diff > 0;
      return `<tr><td style="padding:3px 8px 3px 0;">${h(l)}</td><td style="text-align:right;">${fmt(x, 1)}${unit || ''}</td>
        <td style="text-align:right;font-weight:600;">${fmt(y, 1)}${unit || ''}</td>
        <td style="text-align:right;color:${Math.abs(diff) < 1e-6 ? 'var(--c-text-dim)' : better ? 'var(--c-success-text, #4ade80)' : 'var(--c-danger-text, #f87171)'};">${Math.abs(diff) < 1e-6 ? '—' : (diff > 0 ? '+' : '') + fmt(diff, 1)}</td></tr>`;
    }).join('');
  }

  function resultHtml() {
    const r = ui.result, d = r.derived;
    const icon = { buy: '🛒', plunder: '⚔', mission: '📜', owned: '📦', keep: '📌' };
    const rows = r.outfits.map(([n, k]) => {
      const src = r.access.get(n) || {};
      return `<tr><td style="padding:3px 8px 3px 0;">${k}× ${h(n)}</td><td style="font-size:0.78rem;color:var(--c-text-dim);">${icon[src.how] || ''} ${h(src.note || '')}</td></tr>`;
    }).join('');
    const steals = [...r.access.values()].filter(a => a.how === 'plunder' && a.steal);
    const stealNotes = [...new Map(steals.map(a => [a.steal.gov, a.steal])).values()].map(v => {
      if (v.status === 'hostile') return `<li>Stealing from <strong>${h(v.gov)}</strong> ships costs nothing more — you're already hostile to them (reputation ${fmt(v.rep, 1)}).</li>`;
      if (v.status === 'fixable') return `<li>Stealing from <strong>${h(v.gov)}</strong> ships lowers your reputation with them, but you can repair it:
        ${v.fix.map(f => `<em>${h(f.label)}</em> (${f.kind}${f.op === '+=' ? `, +${f.value}` : `, sets it to ${f.value}`}${f.via && f.via.length ? `, started by ${h(f.via.join(' / '))}` : ''})`).join('; ')} — you haven't done ${v.fix.length === 1 ? 'it' : 'these'} yet.</li>`;
      if (v.status === 'costly') return `<li>Stealing from <strong>${h(v.gov)}</strong> ships lowers your reputation with them, and nothing left in your story raises it again.</li>`;
      return `<li>Stealing from <strong>${h(v.gov)}</strong> ships may cost reputation — open a save to check.${v.fix && v.fix.length ? ` Missions that raise it: ${v.fix.map(f => h(f.label)).join(', ')}.` : ''}</li>`;
    }).join('');
    const warns = S().warnings(d);
    const col = { error: 'var(--c-danger-text, #f87171)', warn: 'var(--c-warn-text, #fbbf24)', info: 'var(--c-text-mid)' };
    return `
      <h3 style="margin:18px 0 6px;font-size:1rem;">Result</h3>
      <div style="overflow-x:auto;"><table style="width:100%;font-size:0.84rem;border-collapse:collapse;">
        <thead><tr><th style="text-align:left;">&nbsp;</th><th style="text-align:right;">Now</th><th style="text-align:right;">Auto-fit</th><th style="text-align:right;">Change</th></tr></thead>
        <tbody>${statRows(ui.current, d)}</tbody></table></div>
      ${r.counterNotes ? `<div style="margin:12px 0 0;padding:10px 12px;border:1px solid var(--c-border);border-radius:8px;font-size:0.86rem;">
        <div style="font-weight:600;margin-bottom:4px;">Against ${h(ui.foe.ships.length ? ui.foe.ships.map(shipLabel).join(', ') : ui.foe.government)}</div>
        <ul style="margin:0;padding-left:18px;">${r.counterNotes.map(l => `<li>${l}</li>`).join('')}</ul>
        <div style="margin-top:4px;color:var(--c-text-dim);font-size:0.76rem;">An estimate from each side's average damage, defences, missiles vs anti-missile/jamming, range and speed — not a full battle simulation.</div></div>` : ''}
      ${warns.length ? `<ul style="margin:10px 0 0;padding-left:18px;font-size:0.84rem;">${warns.map(w => `<li style="color:${col[w.level]};">${h(w.text)}</li>`).join('')}</ul>` : ''}
      ${stealNotes ? `<h4 style="margin:14px 0 4px;font-size:0.9rem;">Stealing and your story</h4><ul style="margin:0;padding-left:18px;font-size:0.84rem;">${stealNotes}</ul>` : ''}
      ${r.suggestions && r.suggestions.length ? `<h4 style="margin:14px 0 4px;font-size:0.9rem;">To push it further</h4>
        <ul style="margin:0;padding-left:18px;font-size:0.84rem;">${r.suggestions.map(s => `<li>${s}</li>`).join('')}</ul>` : ''}
      <h4 style="margin:14px 0 4px;font-size:0.9rem;">Outfits (${r.outfits.reduce((s, [, k]) => s + k, 0)})</h4>
      <div style="overflow-x:auto;"><table style="width:100%;font-size:0.84rem;">${rows}</table></div>`;
  }

  function refreshFoe() {
    const T = window.AfThreat; if (!T || !ui) return;
    ui.result = null;
    const ships = T.shipsFor({ government: ui.foe.ships.length ? '' : ui.foe.government, ships: ui.foe.ships });
    ui.foe.profile = ships.length ? T.profile(ships) : null;
    ui.foe.describe = ui.foe.profile ? T.describe(ui.foe.profile) : null;
  }

  // ── run ──────────────────────────────────────────────────────────────────
  function candidates() {
    const f = { ...ui.filters, factions: ui.factions && ui.factions.size ? ui.factions : null };
    const access = new Map(), list = [];
    for (const e of ui.ctx.list) {
      const a = P().access(ui.ctx, e, f);
      if (!a.ok) continue;
      access.set(e.name, a);
      list.push({ name: e.name, outfit: e.outfit, unique: e.unique, isAmmo: e.isAmmo, maxCount: a.maxCount });
    }
    return { list, access };
  }

  function run() {
    if (!ui || ui.loading) return;
    ui.notice = null;
    ui.running = true; render();
    setTimeout(() => {
      try {
        const { list, access } = candidates();
        // keep the jump drive / hyperdrive the ship already has (a fit that can't leave the system is no use)
        const mine = designOutfits(ui.design);
        const keep = mine.filter(([n]) => { const a = ui.idx.get(n)?.attributes || {}; return a.hyperdrive || a['jump drive']; });
        for (const [n] of keep) if (!access.has(n)) { access.set(n, { how: 'keep', note: 'Kept from your current fit' }); const o = ui.idx.get(n); if (o) list.push({ name: n, outfit: o }); }
        if (!keep.length) {
          const hd = list.find(c => (c.outfit.attributes || {}).hyperdrive);
          if (hd) keep.push([hd.name, 1]);
        }
        const opts = { ...ui.opts };
        if (ui.goal === 'tank') opts.profile = enemyProfile(ui.enemies);
        if (ui.goal === 'speed' || ui.goal === 'accel') delete opts.minSpeed;
        if (ui.goal === 'counter') {
          if (!ui.foe.profile) { ui.running = false; ui.notice = 'Pick a government or some ships to fit against first.'; render(); return; }
          opts.counter = window.AfThreat.makeCounter(ui.foe.profile, ui.foe.count);
          if (ui.foe.matchSpeed) opts.minSpeed = Math.max(opts.minSpeed || 0, Math.round(ui.foe.profile.defence.speed));
        }
        const r = O().optimize({ base: ui.base, candidates: list, goal: ui.goal, options: opts, keep, reference: mine, referenceIndex: ui.idx });
        r.access = access;
        r.counterNotes = ui.goal === 'counter' ? window.AfThreat.explain(ui.current, r.derived, ui.foe.profile, ui.foe.count) : null;
        r.suggestions = ui.goal === 'general' ? suggestions(r, list) : [];
        if (ui.goal === 'tank') r.suggestions.unshift(`Damage it's built against: ${Math.round(opts.profile.shield * 100)}% shield damage, ${Math.round(opts.profile.hull * 100)}% hull damage${ui.enemies.length ? ` (${h(ui.enemies.map(shipLabel).join(', '))})` : ' (average of every armed ship)'}.`);
        ui.result = r;
      } catch (err) {
        console.error(err);
        ui.result = null;
        ui.error = 'Auto-fit failed: ' + err.message;
      }
      ui.running = false;
      render();
    }, 30);
  }

  // For the all-round build: the single best swap or addition toward each feature.
  function suggestions(r, list) {
    const out = [];
    const base = ui.base, idx = ui.idx;
    const now = r.derived;
    const metric = {
      'more damage': d => d.dps.total, 'more speed': d => d.maxSpeed, 'faster turning': d => d.turnRate,
      'more shields': d => d.shields + d.shieldRegen * 30, 'more cargo': d => d.cargo,
    };
    const unit = { 'more damage': ' dps', 'more speed': ' speed', 'faster turning': '°/s', 'more shields': ' shield (incl. 30 s regen)', 'more cargo': ' cargo' };
    for (const [label, f] of Object.entries(metric)) {
      let best = null;
      // remove one outfit (not the hyperdrive) and add one candidate in its place
      const removable = r.outfits.filter(([n]) => { const a = idx.get(n)?.attributes || {}; return !(a.hyperdrive || a['jump drive']); });
      for (const [rm] of [[null], ...removable]) {
        const outs = r.outfits.map(([n, k]) => [n, n === rm ? k - 1 : k]).filter(([, k]) => k > 0);
        for (const c of list) {
          if (c.isAmmo) continue;
          const trial = [...outs];
          const i = trial.findIndex(([n]) => n === c.name);
          if (i >= 0) trial[i] = [c.name, trial[i][1] + 1]; else trial.push([c.name, 1]);
          const d = S().derive(base, trial, idx);
          if (S().warnings(d).some(w => w.level === 'error' && /^Over /.test(w.text))) continue;
          const gain = f(d) - f(now);
          if (gain > 0 && (!best || gain > best.gain)) best = { gain, add: c.name, rm };
        }
      }
      if (best) out.push(`For ${label}: ${best.rm ? `swap 1× ${h(best.rm)} for` : 'add'} 1× ${h(best.add)} (+${fmt(best.gain, 1)}${unit[label]}).`);
    }
    return out;
  }

  // ── apply to the ship being edited ──────────────────────────────────────
  function apply() {
    if (!ui || !ui.result || typeof sbCurrentShip === 'undefined') return;
    const idx = ui.idx;
    if (window.BuilderExtras) window.BuilderExtras.snapshot();   // so ↶ Undo brings the old fit back
    const ship = sbCurrentShip;
    ship.outfits = ui.result.outfits.map(([name, count]) => {
      const o = idx.get(name);
      const pluginId = o && (o._pluginName || o._pn || o.pluginId) || null;
      return { name, count, pluginId, internalId: pluginId ? `${pluginId}::${name}` : null };
    });
    for (const hp of [...(ship.guns || []), ...(ship.turrets || [])]) hp.over = '';
    if (typeof sbAutoSlotWeapons === 'function') for (const [name, count] of ui.result.outfits) sbAutoSlotWeapons(name, count, idx.get(name));
    close();
    if (typeof sbPopulateBuilder === 'function') sbPopulateBuilder();
    if (typeof sbToast === 'function') sbToast('Auto-fit applied — press Save Ship to keep it (or ↶ Undo).', 'success');
  }

  window.AfUI = { open };
})();
