'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  mapSaveState.js — shows the Systems map as the selected pilot sees it
//
//  When a save is open in "Saves & Account" and the "As <pilot> sees it"
//  layer is on (default), this replays the save's `changes` block onto the
//  merged map data exactly the way the game does on load
//  (UniverseObjects::Change): most entries are just `event "Name"`, which
//  are looked up in the `game_events` table (raw event text written by
//  parser.js) and their system/planet/government/link changes applied.
//
//  Applied: system government, position (new systems), links, attributes,
//  hidden / inaccessible / shrouded, planets added/removed; planet
//  government, spaceport, shipyard, outfitter; government colours;
//  top-level link / unlink. Systems that are hidden or inaccessible and
//  that this pilot has never visited are left off the map.
//  Missions: a mission is hidden once it has been offered as many times as
//  it can repeat (non-repeatable: once) — the same rule as Mission::CanOffer.
//
//  With the layer off the map is the plain data-file universe, every
//  mission included.
//
//  Needs esSaveFile.js; saveVault.js for the save text (saves imported
//  before editing existed only give mission history, not map changes).
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const PREF_KEY = 'es_map_pilot_view';
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const readJSON = k => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (_) { return null; } };

  let pilotView = localStorage.getItem(PREF_KEY) !== '0';
  let ctx = null;             // { id, label, pilot, doc|null, conditions, visitedSystems:Set }
  let notesBySystem = new Map();
  let summary = null;
  let lastMap = null;          // { systemsByName, pluginDataMap, activeOutputNames } after apply()
  const eventCache = new Map(); // "plugin_id\0name" → raw text

  // ── which save is selected ───────────────────────────────────────────────
  async function loadSelectedSave() {
    const id = readJSON('ES_SM_CURRENT');
    if (!id) return null;
    const entry = (readJSON('ES_SM_REGISTRY') || []).find(s => s.id === id);
    const parsed = readJSON('ES_SM_SAVE_' + id);
    let text = null;
    if (window.SaveVault) { try { text = await window.SaveVault.text(id); } catch (_) { /* no IndexedDB */ } }
    const doc = text && window.EsSaveFile ? window.EsSaveFile.SaveFile.fromText(text) : null;
    const pilot = doc ? `${doc.pilot.first} ${doc.pilot.last}`.trim() : (parsed?.pilot?.name || entry?.label || 'this pilot');
    return {
      id, label: entry?.label || pilot, pilot, doc,
      conditions: doc ? doc.conditions : (parsed?.pilot?.conditions || {}),
      visitedSystems: new Set(doc ? doc.visitedSystems : []),
    };
  }

  // ── event definitions ────────────────────────────────────────────────────
  async function fetchEvents(names, activeOutputNames) {
    const wanted = [...names].filter(n => ![...eventCache.keys()].some(k => k.endsWith('\u0000' + n)));
    const sb = window.supabaseClient;
    if (!sb) return;
    const { data: plugins } = await sb.from('plugins').select('plugin_id, output_name').in('output_name', activeOutputNames);
    const order = activeOutputNames.map(o => (plugins || []).find(p => p.output_name === o)?.plugin_id).filter(Boolean);
    if (wanted.length) {
      for (let i = 0; i < wanted.length; i += 150) {
        const { data, error } = await sb.from('game_events').select('plugin_id, name, raw')
          .in('name', wanted.slice(i, i + 150)).in('plugin_id', order);
        if (error) { console.warn('[MapSaveState] game_events unavailable:', error.message); summary = { ...(summary || {}), eventsUnavailable: true }; return order; }
        for (const r of data || []) eventCache.set(`${r.plugin_id}\u0000${r.name}`, r.raw);
      }
    }
    return order;
  }
  // Every active plugin's definition of an event, in plugin order (later
  // plugins extend/override earlier ones, as the game loads them).
  function eventChangeNodes(name, pluginOrder) {
    const out = [];
    for (const pid of pluginOrder) {
      const raw = eventCache.get(`${pid}\u0000${name}`);
      if (!raw) continue;
      const { root } = window.EsSaveFile.parse(raw);
      for (const ev of root.children.filter(n => n.tokens && n.tokens[0] === 'event')) {
        for (const c of ev.children) {
          if (!c.tokens) continue;
          if (['date', 'visit', 'unvisit', 'visit planet', 'unvisit planet', 'save raw changes'].includes(c.tokens[0])) continue;
          out.push(c);
        }
      }
    }
    return out;
  }

  // ── prepare (async) — called before the map is rebuilt ───────────────────
  async function prepare(activeOutputNames) {
    ctx = await loadSelectedSave();
    summary = null;
    renderToggle();
    if (!ctx || !pilotView) return;
    const changes = ctx.doc ? (ctx.doc.top('changes')?.children || []).filter(n => n.tokens) : [];
    const refs = new Set();
    const collect = nodes => { for (const n of nodes) if (n.tokens[0] === 'event' && n.tokens[1]) refs.add(n.tokens[1]); };
    collect(changes);
    ctx.changes = changes;
    ctx.pluginOrder = await fetchEvents(refs, activeOutputNames) || [];
    // events can reference events — one more round catches almost all
    const nested = new Set();
    for (const r of refs) for (const n of eventChangeNodes(r, ctx.pluginOrder)) if (n.tokens[0] === 'event' && n.tokens[1] && !refs.has(n.tokens[1])) nested.add(n.tokens[1]);
    if (nested.size) await fetchEvents(nested, activeOutputNames);
  }

  // ── apply (sync) — mutates the freshly formatted map data ────────────────
  function apply({ systemsByName, planetsBySystem, governmentColors, pluginDataMap, activeOutputNames }) {
    notesBySystem = new Map();
    lastMap = null;
    if (!ctx || !pilotView) { document.dispatchEvent(new CustomEvent('mapSaveStateApplied')); return; }
    const note = (sys, text) => { if (!notesBySystem.has(sys)) notesBySystem.set(sys, []); notesBySystem.get(sys).push(text); };

    // base flags (not part of the formatted systems)
    const flags = new Map();
    for (const out of activeOutputNames) {
      for (const raw of pluginDataMap.get(out)?.systems || []) if (raw?.name && raw.flags) flags.set(raw.name, { ...raw.flags });
    }
    const planetByName = new Map();
    for (const s of systemsByName.values()) for (const p of s.planets || []) planetByName.set(p.name, p);

    let applied = 0, missingEvents = 0;
    const seen = new Set();
    const run = nodes => {
      for (const n of nodes) {
        const [key, a, b] = n.tokens;
        if (key === 'event' && a) {
          if (seen.has(a)) continue;             // guard against loops
          seen.add(a);
          const kids = eventChangeNodes(a, ctx.pluginOrder);
          if (!kids.length) missingEvents++;
          run(kids);
          seen.delete(a);
          continue;
        }
        if (key === 'system' && a) { applySystem(a, n); applied++; }
        else if (key === 'planet' && a) { applyPlanet(a, n); applied++; }
        else if (key === 'government' && a) { applyGovernment(a, n); applied++; }
        else if ((key === 'link' || key === 'unlink') && a && b) {
          const s1 = systemsByName.get(a), s2 = systemsByName.get(b);
          for (const [x, y] of [[s1, b], [s2, a]]) if (x) {
            const set = new Set(x.links);
            if (key === 'link') set.add(y); else set.delete(y);
            x.links = [...set];
          }
          note(a, `${key === 'link' ? 'New jump link to' : 'Jump link removed to'} ${b}`);
          note(b, `${key === 'link' ? 'New jump link to' : 'Jump link removed to'} ${a}`);
          applied++;
        }
      }
    };

    function sysFor(name, node) {
      let s = systemsByName.get(name);
      if (s) return s;
      const pos = node.children.find(c => c.tokens && c.tokens[0] === 'pos');
      if (!pos) return null;
      s = { name, x: Number(pos.tokens[1]), y: Number(pos.tokens[2]), government: 'Uninhabited', attributes: [], links: [],
            wormhole: false, hasPlanets: false, planets: [], objectTree: [], ramscoopModifier: null, habitableOverride: null,
            definedBy: ['(appeared in this save)'] };
      systemsByName.set(name, s);
      note(name, 'This system appeared through a story event.');
      return s;
    }

    function applySystem(name, node) {
      const s = sysFor(name, node);
      if (!s) return;
      const f = flags.get(name) || {};
      // System::Load's `shouldOverwrite` list, as the parser read it (fallback: today's list)
      const overwrite = new Set(window.GameKeys ? window.GameKeys.gameRule('universeChanges.systemOverwriteKeys',
        ['asteroids', 'attributes', 'belt', 'fleet', 'link', 'object', 'hazard']) : ['asteroids', 'attributes', 'belt', 'fleet', 'link', 'object', 'hazard']);
      let links = new Set(s.links), attrs = new Set(s.attributes);
      for (const c of node.children) {
        if (!c.tokens) continue;
        const add = c.tokens[0] === 'add', remove = c.tokens[0] === 'remove';
        const key = c.tokens[(add || remove) ? 1 : 0];
        const vals = c.tokens.slice((add || remove) ? 2 : 1);
        const removeAll = remove && !vals.length && !(key === 'object' && c.children.length);
        const overwriteAll = !add && !remove && overwrite.has(key);
        if (removeAll || overwriteAll) {
          if (key === 'link') links.clear();
          if (key === 'attributes') attrs.clear();
          if (key === 'government') s.government = 'Uninhabited';
          if (key === 'object') { for (const p of s.planets) planetByName.delete(p.name); s.planets = []; }
          if (['hidden', 'inaccessible', 'shrouded'].includes(key)) f[key] = false;
          overwrite.delete(key);
          if (removeAll) continue;
        }
        if (key === 'government' && vals[0]) {
          if (s.government !== vals[0]) note(name, `Government is now ${vals[0]} (was ${s.government})`);
          s.government = vals[0];
        } else if (key === 'pos' && vals.length >= 2) { s.x = Number(vals[0]); s.y = Number(vals[1]); }
        else if (key === 'link' && vals[0]) {
          if (remove) { if (links.delete(vals[0])) note(name, `Jump link removed to ${vals[0]}`); }
          else if (!links.has(vals[0])) { links.add(vals[0]); note(name, `New jump link to ${vals[0]}`); }
        } else if (key === 'attributes') { for (const v of vals) remove ? attrs.delete(v) : attrs.add(v); }
        else if (['hidden', 'inaccessible', 'shrouded'].includes(key)) {
          const before = !!f[key];
          f[key] = !remove;
          if (before !== f[key]) note(name, remove ? `No longer ${key}` : `Now ${key}`);
        } else if (key === 'object') {
          const names = [];
          const walk = n => { if (n.tokens && n.tokens[0] === 'object' && n.tokens[1]) names.push(n.tokens[1]); for (const k of n.children || []) walk(k); };
          walk({ tokens: ['object', vals[0]], children: c.children });
          for (const pn of names) {
            if (remove) {
              if (s.planets.some(p => p.name === pn)) note(name, `${pn} is gone`);
              s.planets = s.planets.filter(p => p.name !== pn);
            } else if (!s.planets.some(p => p.name === pn)) {
              const p = planetByName.get(pn) || { name: pn, systemName: name, government: null, hasSpaceport: false, hasShipyard: false,
                hasOutfitter: false, wormhole: null, attributes: [], landscapes: [], sprite: null, definedBy: [] };
              p.systemName = name;
              s.planets.push(p); planetByName.set(pn, p);
              note(name, `${pn} appeared`);
            }
          }
          s.hasPlanets = s.planets.length > 0;
        }
      }
      s.links = [...links]; s.attributes = [...attrs];
      flags.set(name, f);
    }

    function applyPlanet(name, node) {
      const p = planetByName.get(name);
      if (!p) return;
      const sys = p.systemName;
      // Planet::Load's `shouldOverwrite` list (parser), e.g. spaceport/port/attributes
      const overwrite = new Set(window.GameKeys ? window.GameKeys.gameRule('universeChanges.planetOverwriteKeys',
        ['attributes', 'description', 'spaceport', 'port', 'landscape']) : ['attributes', 'description', 'spaceport', 'port', 'landscape']);
      for (const c of node.children) {
        if (!c.tokens) continue;
        const add = c.tokens[0] === 'add', remove = c.tokens[0] === 'remove';
        const key = c.tokens[(add || remove) ? 1 : 0];
        const vals = c.tokens.slice((add || remove) ? 2 : 1);
        const removeAll = remove && !vals.length || (!add && !remove && vals[0] === 'clear');
        // first plain line of an overwrite key replaces what was there
        if (!add && !remove && overwrite.has(key)) {
          overwrite.delete(key);
          if (key === 'attributes') p.attributes = [];
        }
        if (key === 'government') {
          if (removeAll) p.government = null;
          else if (vals[0]) { if (p.government !== vals[0]) note(sys, `${name}: government is now ${vals[0]}`); p.government = vals[0]; }
        } else if (key === 'spaceport' || key === 'port') {
          const was = p.hasSpaceport; p.hasSpaceport = !removeAll;
          if (was !== p.hasSpaceport) note(sys, `${name}: spaceport ${p.hasSpaceport ? 'opened' : 'closed'}`);
        } else if (key === 'shipyard' || key === 'outfitter') {
          const flag = key === 'shipyard' ? 'hasShipyard' : 'hasOutfitter';
          p._saleLists = p._saleLists || {};
          const lists = p._saleLists[key] = p._saleLists[key] || new Set();
          if (removeAll) { p[flag] = false; lists.clear(); note(sys, `${name}: ${key} closed`); }
          else if (remove && vals[0]) { lists.delete(vals[0]); note(sys, `${name}: ${key} no longer sells “${vals[0]}”`); }
          else if (vals[0]) { lists.add(vals[0]); if (!p[flag]) note(sys, `${name}: ${key} opened`); else note(sys, `${name}: ${key} now sells “${vals[0]}”`); p[flag] = true; }
        } else if (key === 'attributes') {
          const set = new Set(p.attributes || []);
          if (removeAll) set.clear();
          for (const v of vals) remove ? set.delete(v) : set.add(v);
          p.attributes = [...set];
        }
      }
    }

    function applyGovernment(name, node) {
      const col = node.children.find(c => c.tokens && c.tokens[0] === 'color' && c.tokens.length >= 4);
      if (!col) return;
      const rgb = col.tokens.slice(1, 4).map(Number);
      if (rgb.every(Number.isFinite)) governmentColors.set(name, { ...(governmentColors.get(name) || {}), color: rgb });
    }

    run(ctx.changes || []);

    // hidden / inaccessible systems the pilot hasn't found stay off the map
    let hiddenCount = 0;
    for (const [name, f] of flags) {
      if ((f.hidden || f.inaccessible) && !ctx.visitedSystems.has(name) && systemsByName.has(name)) {
        systemsByName.delete(name); hiddenCount++;
      }
    }
    // keep the planet → system grouping used by mission placement in sync
    planetsBySystem.clear();
    for (const s of systemsByName.values()) if (s.planets.length) planetsBySystem.set(s.name, s.planets);

    summary = { ...(summary || {}), applied, missingEvents, hiddenCount, hasText: !!ctx.doc, missionsHidden: 0 };
    lastMap = { systemsByName, pluginDataMap, activeOutputNames };
    document.dispatchEvent(new CustomEvent('mapSaveStateApplied'));
  }

  // Non-repeatable (or repeat-limited) missions already offered as often as
  // they can be are gone for this pilot.
  function filterMissions(missions, pluginDataMap, activeOutputNames) {
    if (!ctx || !pilotView) return missions;
    const limit = new Map();
    for (const out of activeOutputNames) {
      for (const raw of pluginDataMap.get(out)?.missions || []) {
        if (!raw?.name) continue;
        limit.set(raw.name, raw.repeatable ? (Number(raw.repeatLimit) || 0) : 1);
      }
    }
    const cond = ctx.conditions || {};
    const count = n => { const v = cond[n]; return typeof v === 'number' ? v : (v ? 1 : 0); };
    const kept = missions.filter(m => {
      const lim = limit.has(m.name) ? limit.get(m.name) : (m.repeatable ? 0 : 1);
      return !(lim > 0 && count(`${m.name}: offered`) >= lim);
    });
    if (summary) summary.missionsHidden = missions.length - kept.length;
    return kept;
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  function renderToggle() {
    const layers = document.querySelector('.map-layers');
    if (!layers) return;
    let row = document.getElementById('mapPilotViewRow');
    if (!row) {
      row = document.createElement('label');
      row.id = 'mapPilotViewRow';
      row.className = 'map-toggle-row';
      row.innerHTML = '<input type="checkbox" id="mapPilotViewToggle"><span id="mapPilotViewLabel"></span>';
      layers.appendChild(row);
      row.querySelector('input').addEventListener('change', e => {
        pilotView = e.target.checked;
        localStorage.setItem(PREF_KEY, pilotView ? '1' : '0');
        if (typeof window._renderCardsFromManager === 'function') window._renderCardsFromManager(false);
      });
    }
    const input = row.querySelector('input');
    input.checked = pilotView && !!ctx;
    input.disabled = !ctx;
    row.title = ctx ? 'On: the galaxy as it is in this save. Off: the default galaxy from the data files, with every mission.'
                    : 'Open a save in Saves & Account to see the galaxy as that pilot sees it.';
    document.getElementById('mapPilotViewLabel').textContent = ctx ? `👤 As ${ctx.pilot} sees it` : '👤 As your pilot sees it (no save open)';
  }

  function subtitleSuffix() {
    if (!ctx || !pilotView || !summary) return '';
    const bits = [`showing ${ctx.pilot}'s galaxy`];
    if (!summary.hasText) bits.push('re-upload this save to include story changes');
    else if (summary.eventsUnavailable) bits.push('story changes unavailable until the parser has stored events');
    else if (summary.missingEvents) bits.push(`${summary.missingEvents} story event${summary.missingEvents === 1 ? '' : 's'} not found in the active plugins`);
    if (summary.hiddenCount) bits.push(`${summary.hiddenCount} undiscovered system${summary.hiddenCount === 1 ? '' : 's'} hidden`);
    if (summary.missionsHidden) bits.push(`${summary.missionsHidden} finished mission${summary.missionsHidden === 1 ? '' : 's'} hidden`);
    return ' · ' + bits.join(' · ');
  }

  function detailsHtml(system) {
    const notes = notesBySystem.get(system.name);
    if (!notes || !notes.length || !ctx || !pilotView) return '';
    return `<div class="map-details-section"><h3>Changed in ${h(ctx.pilot)}'s save</h3>
      <ul style="margin:0;padding-left:18px;color:var(--c-text-mid);font-size:0.88rem;">${[...new Set(notes)].map(n => `<li>${h(n)}</li>`).join('')}</ul></div>`;
  }

  // re-render when the selected save changes in another tab
  window.addEventListener('storage', e => {
    if (e.key === 'ES_SM_CURRENT' && typeof window._renderCardsFromManager === 'function') window._renderCardsFromManager(false);
  });
  document.addEventListener('DOMContentLoaded', renderToggle);

  window.MapSaveState = { prepare, apply, filterMissions, detailsHtml, subtitleSuffix, isActive: () => !!(ctx && pilotView),
    context: () => ctx, lastMap: () => lastMap };
})();
