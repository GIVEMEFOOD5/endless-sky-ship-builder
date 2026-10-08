'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  autoFitting/afOptimizer.js — find a strong fit for a goal
//
//  Starting from the bare hull (plus anything you ask it to keep, e.g. a
//  hyperdrive), it repeatedly adds the outfit that improves the goal's score
//  the most per ton of outfit space, until nothing helps; then it tries
//  taking each outfit out again and swapping in better ones, a few rounds.
//  Space, weapon/engine capacity and gun/turret mounts are hard limits.
//
//  Scores are "effective" — a weapon only counts as much as the ship can
//  power and cool it, so the optimiser adds generators, batteries and
//  coolers by itself:
//    energy factor  = share of the energy bill the ship can pay, or how long
//                     the batteries hold out (vs. a target fight length)
//    heat factor    = 100% / where the heat settles, once that's over 100%
//    mobility       = penalty below the minimum turn rate / speed you set
//
//  Goals:
//    dps      — weapon damage (primary, secondary or both)
//    accel    — acceleration, keeping a usable turn rate
//    speed    — top speed, keeping a usable turn rate
//    bunks    — bunks (crew/passengers)
//    cargo    — cargo space
//    tank     — time to be destroyed by an enemy damage mix (shield vs
//               hull damage share, from chosen enemies or an average)
//    general  — a balance of damage, speed, turning, toughness and cargo,
//               measured against the hull's stock loadout
//
//  window.AfOptimizer / module.exports. Needs AfStats.
// ═══════════════════════════════════════════════════════════════════════════

(function (root, factory) {
  const api = factory(typeof module !== 'undefined' && module.exports ? require('./afStats.js') : root.AfStats);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AfOptimizer = api;
})(typeof self !== 'undefined' ? self : this, function (S) {
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const clamp01 = x => Math.max(0, Math.min(1, x));

  // ── candidate preparation ────────────────────────────────────────────────
  function prepare(c) {
    const a = c.outfit.attributes || c.outfit;
    const vec = {};
    for (const [k, v] of Object.entries(a)) if (typeof v === 'number' && k !== 'index') vec[k] = v;
    const ws = S.weaponStats(c.outfit);
    const weapon = ws ? { name: c.name, secondary: S.isSecondary(c.outfit), ...ws } : null;
    const space = Math.max(1, -num(vec['outfit space']));
    // an outfit that takes no space and no slot of any kind could be added
    // forever — allow just one of those
    const usesSlot = Object.entries(vec).some(([k, v]) => v < 0 && !MAY_BE_NEGATIVE.has(k));
    const limit = Number.isFinite(c.maxCount) ? c.maxCount : Infinity;   // e.g. only what you own
    return { ...c, vec, weapon, space, maxCount: Math.min(limit, usesSlot ? Infinity : 1) };
  }

  // ── a fit being built: totals kept incrementally ─────────────────────────
  function emptyFit(base) {
    const t = {};
    for (const [k, v] of Object.entries(base)) if (typeof v === 'number') t[k] = v;
    return { t, counts: new Map(), weapons: new Map() };
  }
  function addTo(fit, c, n = 1) {
    for (const [k, v] of Object.entries(c.vec)) fit.t[k] = (fit.t[k] || 0) + v * n;
    fit.counts.set(c.name, (fit.counts.get(c.name) || 0) + n);
    if (fit.counts.get(c.name) <= 0) fit.counts.delete(c.name);
    if (c.weapon) {
      const cur = fit.weapons.get(c.name);
      const count = (cur ? cur.count : 0) + n;
      if (count > 0) fit.weapons.set(c.name, { ...c.weapon, count }); else fit.weapons.delete(c.name);
    }
  }
  function cloneFit(f) { return { t: { ...f.t }, counts: new Map(f.counts), weapons: new Map(f.weapons) }; }
  function outfitsOf(f) { return [...f.counts.entries()]; }
  // Totals that may legitimately go below zero (an outfit can cool or
  // generate instead of using). Anything else below zero means a limit was
  // broken: outfit space, weapon/engine capacity, mounts, and the special
  // slots some outfits need ("anchor point", "multimodal armor", ammo
  // capacity …), which work the same way.
  const MAY_BE_NEGATIVE = new Set(['heat generation', 'energy consumption', 'solar heat', 'thrusting heat',
    'turning heat', 'reverse thrusting heat', 'cooling energy', 'shield heat', 'hull heat', 'afterburner heat']);
  function fits(t) {
    for (const [k, v] of Object.entries(t)) if (v < -1e-9 && !MAY_BE_NEGATIVE.has(k)) return false;
    return true;
  }
  function derived(base, f) { return S.fromTotals(base, f.t, [...f.weapons.values()], outfitsOf(f)); }

  // ── shared factors ───────────────────────────────────────────────────────
  const FLOOR = 0.02;   // factors never hit zero, so the first engine/weapon still shows a gain
  // Fights are short, so batteries may cover a shortfall for `target`
  // seconds; flying around has to be sustainable (generators, not batteries).
  function energyFactor(d, situation, target) {
    const per = d.energy.perSec[situation];
    if (per >= 0) return 1;
    const t = d.raw;
    const income = ((t['energy generation'] || 0) + (t['solar collection'] || 0)) * 60;
    const bill = income - per;                          // what it would need to break even
    const ratio = bill > 0 ? income / bill : 0;
    if (situation !== 'fighting') return Math.max(FLOOR, clamp01(ratio));
    const hold = d.energy.capacity / -per;               // seconds the batteries cover the gap
    return Math.max(FLOOR, clamp01(Math.max(ratio, Math.min(1, hold / target))));
  }
  function heatFactor(d, situation) {
    const p = d.heat.equilibriumPct[situation];
    return p <= 100 ? 1 : 100 / p;
  }
  function mobility(d, o) {
    let m = 1;
    if (o.minTurn && d.turnRate < o.minTurn) m *= Math.pow(Math.max(FLOOR, d.turnRate / o.minTurn), 2);
    if (o.minSpeed && d.maxSpeed < o.minSpeed) m *= Math.pow(Math.max(FLOOR, d.maxSpeed / o.minSpeed), 2);
    // keep a usable hold: expansions and big outfits mustn't eat all the cargo space
    if (o.minCargo && d.cargo < o.minCargo) m *= Math.pow(Math.max(FLOOR, Math.max(0, d.cargo) / o.minCargo), 2);
    return m;
  }
  function basics(d) {
    let m = 1;
    if (d.requiredCrew > d.bunks) m *= 0.3;
    if (d.fuel.jumps < 1) m *= 0.2;
    if (d.energy.perSec.idle < 0) m *= 0.5;
    return m;
  }
  function ehp(d, profile, regenSeconds = 30) {
    const sh = d.shields + d.shieldRegen * regenSeconds, hu = d.hull + d.hullRegen * regenSeconds;
    const ps = Math.max(0.05, profile.shield), ph = Math.max(0.05, profile.hull);
    return sh / ps + hu / ph;     // seconds under 1 dps of that mix
  }

  // ── goal scores ──────────────────────────────────────────────────────────
  function scorer(goal, o, ref) {
    const fight = o.fightSeconds || 60;
    switch (goal) {
      case 'dps': return d => {
        const sel = o.weapons === 'primary' ? d.dps.primary : o.weapons === 'secondary' ? d.dps.secondary : d.dps.total;
        // secondaries only count while their ammo lasts
        let ammoF = 1;
        if (o.weapons !== 'primary' && d.ammo.length) ammoF = d.ammo.reduce((m, a) => Math.min(m, a.seconds == null ? 1 : clamp01(a.seconds / fight)), 1);
        return (sel + 0.001) * (o.weapons === 'secondary' ? ammoF : 1) * energyFactor(d, 'fighting', fight) * energyFactor(d, 'flying', fight) * heatFactor(d, 'fighting') * mobility(d, o) * basics(d);
      };
      case 'accel': return d => (d.acceleration + 0.001) * energyFactor(d, 'flying', fight) * heatFactor(d, 'flying') * mobility(d, { minTurn: o.minTurn }) * basics(d);
      case 'speed': return d => (d.maxSpeed + 0.001) * energyFactor(d, 'flying', fight) * heatFactor(d, 'flying') * mobility(d, { minTurn: o.minTurn }) * basics(d);
      case 'bunks': return d => (d.bunks + 0.001 * d.maxSpeed) * energyFactor(d, 'flying', fight) * heatFactor(d, 'flying') * mobility(d, o) * (d.fuel.jumps < 1 ? 0.2 : 1) * (d.energy.perSec.idle < 0 ? 0.5 : 1);
      case 'cargo': return d => (d.cargo + 0.001 * d.maxSpeed) * energyFactor(d, 'flying', fight) * heatFactor(d, 'flying') * mobility(d, o) * basics(d);
      case 'tank': return d => ehp(d, o.profile || { shield: 0.5, hull: 0.5 }) * energyFactor(d, 'fighting', fight) * energyFactor(d, 'flying', fight) * heatFactor(d, 'fighting') * mobility(d, o) * basics(d);
      case 'counter': return d => o.counter(d, { energyFactor, heatFactor, mobility: dd => mobility(dd, o), basics, fight });
      case 'general': default: return d => {
        const r = (v, v0) => Math.max(0.05, v) / Math.max(1, v0);
        return Math.pow(r(d.dps.total, ref.dps), 0.30) * Math.pow(r(d.maxSpeed, ref.speed), 0.20) * Math.pow(r(d.turnRate, ref.turn), 0.15)
          * Math.pow(r(ehp(d, { shield: 0.5, hull: 0.5 }), ref.ehp), 0.25) * Math.pow(r(d.cargo + 1, ref.cargo + 1), 0.10)
          * energyFactor(d, 'fighting', fight) * energyFactor(d, 'flying', fight) * heatFactor(d, 'fighting') * mobility(d, o) * basics(d);
      };
    }
  }

  /**
   * @param {object} p
   *   base        hull attributes (AfStats.hullAttrs)
   *   candidates  [{ name, outfit, unique, how, note, steal }]
   *   goal        'dps'|'accel'|'speed'|'bunks'|'cargo'|'tank'|'general'
   *   options     { weapons, minTurn, minSpeed, fightSeconds, profile, maxSteps }
   *   keep        [[name, count]] always installed (e.g. the hyperdrive)
   *   reference   stock fit [[name, count]] — the "general" goal's yardstick
   */
  function optimize(p) {
    const o = p.options || {};
    const base = p.base;
    const cands = p.candidates.map(prepare);
    const byName = new Map(cands.map(c => [c.name, c]));
    // only weapons of the requested kind are worth considering for a damage build
    const usable = cands.filter(c => {
      if (!c.weapon) return true;
      if (p.goal === 'dps' && o.weapons === 'primary') return !c.weapon.secondary;
      if (p.goal === 'dps' && o.weapons === 'secondary') return c.weapon.secondary;
      if (p.goal !== 'dps' && p.goal !== 'general' && p.goal !== 'tank' && p.goal !== 'counter') return !!c.weapon.antiMissile;
      return true;
    });

    let ref = { dps: 1, speed: 1, turn: 1, ehp: 1, cargo: 0 };
    // All-round's yardstick: typical ships of the same class and weight (AfPeers) when
    // known — otherwise this hull's own stock loadout
    const peerRef = o.peerRef && o.peerRef.speed > 0 ? o.peerRef : null;
    if (p.reference && p.reference.length) {
      const f0 = emptyFit(base);
      for (const [n, k] of p.reference) { const c = byName.get(n) || (p.referenceIndex && p.referenceIndex.get(n) && prepare({ name: n, outfit: p.referenceIndex.get(n) })); if (c) addTo(f0, c, k); }
      const d0 = derived(base, f0);
      ref = { dps: d0.dps.total, speed: d0.maxSpeed, turn: d0.turnRate, ehp: ehp(d0, { shield: 0.5, hull: 0.5 }), cargo: d0.cargo };
    }
    if (peerRef) ref = {
      dps: Math.max(1, peerRef.dps), speed: peerRef.speed, turn: peerRef.turn, cargo: Math.max(0, peerRef.cargo),
      // AfPeers' toughness is shields + hull + 30 s regen; ehp() weighs a 50/50 damage mix (÷0.5 each side)
      ehp: Math.max(1, peerRef.ehp / 0.5),
    };
    const score = scorer(p.goal, o, ref);

    let fit = emptyFit(base);
    for (const [n, k] of p.keep || []) { const c = byName.get(n); if (c) addTo(fit, c, k); }

    // a launcher is only worth its ammo: add launcher + a full load together
    const ammoFor = c => {
      if (!c.weapon || !c.weapon.ammo) return null;
      const ammo = byName.get(c.weapon.ammo);
      if (!ammo) return null;
      const capKey = Object.keys(ammo.vec).find(k => / capacity$/.test(k) && ammo.vec[k] < 0);
      const per = capKey ? Math.floor((c.vec[capKey] || 0) / -ammo.vec[capKey]) : 0;
      return per > 0 ? { ammo, per } : null;
    };
    const tryAdd = (f, c) => {
      const g = cloneFit(f);
      addTo(g, c, 1);
      const a = ammoFor(c);
      if (a) {
        let n = a.per;
        addTo(g, a.ammo, n);
        while (n > 0 && !fits(g.t)) { addTo(g, a.ammo, -1); n--; }
      }
      return fits(g.t) ? g : null;
    };

    // "Support" outfits: the best steering, engine, generator, battery and
    // cooler per ton. Adding one useful outfit often costs turning, energy
    // or heat, so each candidate is also tried together with one support
    // outfit — otherwise the build stalls just above a minimum turn rate.
    const perTon = (c, k) => (c.vec[k] || 0) / c.space;
    const top = (k, n = 2) => usable.filter(c => (c.vec[k] || 0) > 0 && !c.weapon && !c.isAmmo)
      .sort((a, b) => perTon(b, k) - perTon(a, k)).slice(0, n);
    const support = [...new Set([...top('turn'), ...top('thrust'), ...top('energy generation'), ...top('solar collection', 1),
      ...top('energy capacity'), ...top('cooling'), ...top('active cooling', 1)])];

    let cur = score(derived(base, fit));
    const maxSteps = o.maxSteps || 400;
    const log = [];
    const can = c => (fit.counts.get(c.name) || 0) < (c.unique ? 1 : c.maxCount);
    const growStep = (pool = usable, pairs = true) => {
      let best = null, bestGain = 0;
      for (const c of pool) {
        if (c.isAmmo || !can(c)) continue;
        const g = tryAdd(fit, c);
        if (!g) continue;
        const s = score(derived(base, g));
        let gain = (s - cur) / c.space;
        let pick = { g, s, c, label: c.name };
        if (gain <= 0 && pairs) {
          for (const sup of support) {
            if (sup === c || (g.counts.get(sup.name) || 0) >= (sup.unique ? 1 : sup.maxCount)) continue;
            const g2 = tryAdd(g, sup);
            if (!g2) continue;
            const s2 = score(derived(base, g2));
            const gain2 = (s2 - cur) / (c.space + sup.space);
            if (gain2 > gain) { gain = gain2; pick = { g: g2, s: s2, c, label: `${c.name} + ${sup.name}` }; }
          }
        }
        if (gain > bestGain + 1e-12) { bestGain = gain; best = pick; }
      }
      if (!best) return false;
      fit = best.g; cur = best.s; if (!quiet) log.push(`+ ${best.label}`);
      return true;
    };
    let quiet = false;

    // ── Capacity expanders ────────────────────────────────────────────────
    // Outfits like "Outfits Expansion" (+15 outfit space, −20 cargo, a little
    // less heat dissipation) or a plugin's extra weapon capacity / mounts do
    // nothing on their own — their value is what the freed room lets you fit,
    // minus their own costs. So when the build stalls, each expander is tried
    // with a look-ahead: add it, fill the new room as usual, and keep it only
    // if the finished result scores better than without it.
    const consumed = new Set();
    for (const c of usable) for (const [k, v] of Object.entries(c.vec)) if (v < 0 && !MAY_BE_NEGATIVE.has(k)) consumed.add(k);
    const expanders = usable.filter(c => !c.isAmmo && !c.weapon && Object.entries(c.vec).some(([k, v]) => v > 0 && consumed.has(k)));
    const LOOKAHEAD = 20, POOL = 60;
    // What would be worth adding if there were room? (score with space limits lifted)
    const roomyPool = () => {
      const roomy = cloneFit(fit);
      for (const k of consumed) roomy.t[k] = (roomy.t[k] || 0) + 1e6;
      const base0 = score(derived(base, roomy));
      const ranked = [];
      for (const c of usable) {
        if (c.isAmmo || !can(c) || expanders.includes(c)) continue;
        const g = cloneFit(roomy); addTo(g, c, 1);
        const gain = score(derived(base, g)) - base0;
        if (gain > 0) ranked.push([gain / c.space, c]);
      }
      return ranked.sort((a, b) => b[0] - a[0]).slice(0, POOL).map(x => x[1]);
    };
    const expandStep = () => {
      if (!expanders.length) return false;
      const startFit = fit, startCur = cur;
      const pool = roomyPool();
      if (!pool.length) return false;           // nothing would use the room anyway
      let best = null;
      for (const e of expanders) {
        if (!can(e)) continue;
        const g = tryAdd(startFit, e);
        if (!g) continue;
        quiet = true;
        fit = g; cur = score(derived(base, g));
        for (let i = 0; i < LOOKAHEAD && growStep(pool, false); i++);
        quiet = false;
        if (cur > startCur * (1 + 1e-6) + 1e-9 && (!best || cur > best.cur)) best = { fit, cur, e };
        fit = startFit; cur = startCur;
      }
      if (!best) return false;
      fit = best.fit; cur = best.cur;
      log.push(`+ ${best.e.name} (for the room it frees) and what fills it`);
      return true;
    };
    const growAll = () => {
      let any = false;
      for (let round = 0; round < 50; round++) {
        let grew = false;
        for (let step = 0; step < maxSteps && growStep(); step++) grew = true;
        if (expandStep()) grew = true;
        if (!grew) break;
        any = true;
      }
      return any;
    };
    growAll();

    // clean-up: drop anything that doesn't pull its weight, then refill
    for (let round = 0; round < 3; round++) {
      let changed = false;
      for (const [name] of [...fit.counts.entries()]) {
        const c = byName.get(name);
        if (!c || (p.keep || []).some(([n]) => n === name)) continue;
        const g = cloneFit(fit); addTo(g, c, -1);
        if (!fits(g.t)) continue;               // e.g. taking out an expander would overfill the ship
        const s = score(derived(base, g));
        if (s >= cur - 1e-9) { fit = g; cur = s; changed = true; log.push(`- ${name}`); }
      }
      if (growAll()) changed = true;
      if (!changed) break;
    }

    const outfits = outfitsOf(fit).filter(([, k]) => k > 0);
    const d = derived(base, fit);
    return { outfits, derived: d, score: cur, log, sources: outfits.map(([n]) => byName.get(n)).filter(Boolean) };
  }

  /** Average damage mix (shield vs hull share) of a set of armed fits. */
  function damageProfile(fitsDerived) {
    let sh = 0, hu = 0;
    for (const d of fitsDerived) { sh += d.dps.shield; hu += d.dps.hull; }
    const tot = sh + hu;
    return tot > 0 ? { shield: sh / tot, hull: hu / tot, dps: tot / Math.max(1, fitsDerived.length) } : { shield: 0.5, hull: 0.5, dps: 0 };
  }

  return { optimize, damageProfile, scorer };
});
