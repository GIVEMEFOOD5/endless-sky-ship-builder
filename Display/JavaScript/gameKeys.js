'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  gameKeys.js — key lists the site used to hard-code, now read from what
//  the parser extracted from the game's source (window.attrDefs, which
//  dataLoader.js fills from the attribute_* tables).
//
//  Every function takes the old hard-coded list as its fallback, so a page
//  still works if attrDefs hasn't loaded yet or an older parse lacks the
//  data — and as soon as the parser has run, game updates flow through
//  without editing the site.
//
//    capacityKeys(fb)        attributes Ship::FinishLoading refuses to let go
//                            negative (outfit space, cargo space, weapon /
//                            engine capacity, …) → shipRequirement.min === 0
//    statusEffects(fb)       [{ statName, damageKey, resistKey, label }]
//                            from weapon.statusEffectDecay (Ship.cpp)
//    firingStatusMap(fb)     { statName: 'firing <x>' } — the self-inflicted
//                            status a weapon applies to its shooter
//    firingStatusKeys(fb)    the 'firing <x>' keys above
//    firingCostKeys(fb)      'firing <resource>' keys (energy, fuel, heat,
//                            hull, shields …) from Weapon.cpp's key list
//    trackingKeys(fb)        homing + every '* tracking' weapon key
//    derivedConditions()     { named:Set, prefixed:[] } conditions the game
//                            computes instead of storing (PlayerInfo / AI)
//    gameRule(path, fb)      any value under attrDefs.gameRules
//
//  For pages that don't load dataLoader.js, loadGameRules() fetches just
//  the `gameRules` section from attribute_calculations.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const defs = () => window.attrDefs || null;
  let fetchedRules = null;

  function capacityKeys(fallback) {
    const attrs = defs()?.attributes;
    if (!attrs) return fallback;
    const keys = Object.entries(attrs)
      .filter(([, a]) => a?.shipRequirement && a.shipRequirement.min === 0 && a.shipRequirement.minExclusive === false
                       && a.shipRequirement.level !== 'engineDerived')
      .map(([k]) => k);
    if (!keys.length) return fallback;
    // keep the familiar order for the ones we already knew, new ones after
    const order = new Map((fallback || []).map((k, i) => [k, i]));
    return keys.sort((a, b) => (order.has(a) ? order.get(a) : 999) - (order.has(b) ? order.get(b) : 999) || a.localeCompare(b));
  }

  function statusEffects(fallback) {
    const d = defs()?.weapon?.statusEffectDecay?.descriptors;
    if (!Array.isArray(d) || !d.length) return fallback;
    return d.filter(x => x && x.damageKey && x.resistKey).map(x => ({
      statName: x.statName, damageKey: x.damageKey, resistKey: x.resistKey, protectionKey: x.protectionKey || null,
      label: x.label || x.statName,
    }));
  }

  // 'ion resistance' → 'firing ion', 'scramble resistance' → 'firing scramble'
  function firingStatusMap(fallback) {
    const effects = statusEffects(null);
    const keys = new Set(defs()?.weapon?.dataFileKeys || []);
    if (!effects || !keys.size) return fallback;
    const out = {};
    for (const e of effects) {
      const k = 'firing ' + e.resistKey.replace(/ resistance$/, '');
      if (keys.has(k)) out[e.statName] = k;
    }
    return Object.keys(out).length ? out : fallback;
  }
  function firingStatusKeys(fallback) {
    const m = firingStatusMap(null);
    return m ? Object.values(m) : fallback;
  }

  // Remaining 'firing X' keys whose X is something a ship spends — a damage
  // type's resource (energy, fuel, heat, hull, shield…). 'firing force' is
  // recoil, not a cost, so it doesn't match any damage type and is left out.
  function firingCostKeys(fallback) {
    const keys = defs()?.weapon?.dataFileKeys;
    const types = defs()?.weapon?.damageTypeDetails;
    if (!Array.isArray(keys) || !Array.isArray(types)) return fallback;
    const status = new Set(firingStatusKeys([]));
    const resources = types.filter(t => t && (t.category === 'resource' || t.category === 'hp') && t.resourceKey)
      .map(t => t.resourceKey.replace(/ damage$/, ''));
    const out = keys.filter(k => k.startsWith('firing ') && !status.has(k) &&
      resources.some(r => k.slice(7) === r || k.slice(7) === r + 's'));
    return out.length ? out : fallback;
  }

  function trackingKeys(fallback) {
    const keys = defs()?.weapon?.dataFileKeys;
    if (!Array.isArray(keys)) return fallback;
    const out = keys.filter(k => k === 'homing' || k === 'tracking' || / tracking$/.test(k));
    return out.length ? ['homing', ...out.filter(k => k !== 'homing')].filter((k, i, a) => a.indexOf(k) === i) : fallback;
  }

  function gameRule(path, fallback) {
    let v = defs()?.gameRules || fetchedRules;
    for (const p of String(path).split('.')) { if (v == null) break; v = v[p]; }
    return v == null ? fallback : v;
  }

  function derivedConditions() {
    const d = gameRule('derivedConditions', null);
    if (!d) return null;
    return { named: new Set(d.named || []), prefixed: (d.prefixed || []).slice().sort((a, b) => b.length - a.length) };
  }

  async function loadGameRules() {
    if (defs()?.gameRules) return defs().gameRules;
    if (fetchedRules) return fetchedRules;
    const sb = window.supabaseClient;
    if (!sb) return null;
    const { data, error } = await sb.from('attribute_calculations').select('value').eq('section', 'gameRules').maybeSingle();
    if (!error && data) fetchedRules = data.value;
    return fetchedRules;
  }

  window.GameKeys = {
    capacityKeys, statusEffects, firingStatusMap, firingStatusKeys, firingCostKeys, trackingKeys,
    derivedConditions, gameRule, loadGameRules,
  };
})();
