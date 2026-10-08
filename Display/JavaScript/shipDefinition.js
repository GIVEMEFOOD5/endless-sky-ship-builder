'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  shipDefinition.js — turns a ship design into a `ship` block for a save
//
//  Two kinds of source:
//
//  • Ship builder designs (fleets, shared ships) — written out in full, the
//    same way the builder's own export (sbGenerateES) does. If the design
//    started from a game ship (`_sourceShip`), the block is written in
//    variant form `ship "<that model>" "<design name>"` so the game still
//    knows the model and fills in anything the design leaves out
//    (description, thumbnail, …) from it.
//
//  • Game ships and variants (window.allData) — written as a variant of the
//    base model with just its outfit list: `ship "Falcon" "Falcon (Heavy)"`
//    + `outfits`. This is exactly how the game defines variants itself: on
//    load it copies attributes, sprite and hardpoints from the base model
//    and mounts the weapons on free hardpoints (Ship::Load / FinishLoading).
//
//  maxLevels() works out full shields / hull / fuel and required crew from
//  the design's attributes plus its outfits, so a new or refitted ship
//  starts repaired, refuelled and crewed.
//
//  window.ShipDefinition (browser) / module.exports (Node)
// ═══════════════════════════════════════════════════════════════════════════

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShipDefinition = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const node = (tokens, children = []) => ({ tokens: tokens.map(String), children });
  const clean = v => String(v ?? '').replace(/^"([^"]*)"$/, '$1');
  const isNum = v => /^-?[0-9]*\.?[0-9]+(e[-+]?\d+)?$/i.test(String(v).trim());

  function outfitList(outfits) {
    if (!outfits) return [];
    if (Array.isArray(outfits)) return outfits.map(o => [clean(o.name), parseInt(o.count) || 1]).filter(([n]) => n);
    return Object.entries(outfits).map(([n, v]) => [clean(n), typeof v === 'object' && v ? (parseInt(v.count) || 1) : (Number(v) || 1)]).filter(([n]) => n);
  }

  // { key: [true | [values…], …] } → child nodes (builder hardpoint extras)
  function attrsToNodes(attrs) {
    const out = [];
    for (const [k, occs] of Object.entries(attrs || {})) {
      for (const occ of (occs || [])) {
        if (occ === true) out.push(node([k]));
        else if (Array.isArray(occ)) out.push(node([k, ...occ.map(String)]));
      }
    }
    return out;
  }
  function takeInline(attrs, key) {
    if (!attrs || !attrs[key] || !attrs[key].length) return { value: null, rest: attrs };
    const [first, ...more] = attrs[key];
    const rest = { ...attrs };
    if (more.length) rest[key] = more; else delete rest[key];
    return { value: first === true ? null : first.join(' '), rest };
  }
  const coords = c => String(c || '0 0').trim().split(/\s+/).slice(0, 2).concat(['0', '0']).slice(0, 2);

  /**
   * Builder design → ship node.
   * @param {object} b      builder ship (map- or array-style outfits)
   * @param {Set<string>} [knownModels]  game ship names; enables variant form
   */
  function fromBuild(b, knownModels) {
    const model = b._sourceShip && (!knownModels || knownModels.has(b._sourceShip)) ? b._sourceShip : null;
    const label = b.name || b.variant || 'Custom ship';
    const head = model ? ['ship', model, b.variant ? `${label} ${b.variant}`.trim() : label] : ['ship', label];
    const kids = [];
    // Ship::Save writes "display name" on its own line when it differs from the model name
    const displayName = (b.attributes && b.attributes['display name']) || '';
    if (displayName && displayName !== (model || label)) kids.push(node(['display name', displayName]));
    if (b.plural) kids.push(node(['plural', b.plural]));
    if (b.sprite) kids.push(node(['sprite', b.sprite]));
    if (b.thumbnail) kids.push(node(['thumbnail', b.thumbnail]));

    const a = b.attributes || {};
    const attrNode = node(['attributes']);
    if (a.category != null && a.category !== '') attrNode.children.push(node(['category', a.category]));
    if (a.licenses && typeof a.licenses === 'object') {
      const lic = Object.keys(a.licenses);
      if (lic.length) attrNode.children.push(node(['licenses'], lic.map(l => node([l]))));
    }
    if (b.mass !== undefined && b.mass !== '') attrNode.children.push(node(['mass', b.mass]));
    if (b.drag !== undefined && b.drag !== '') attrNode.children.push(node(['drag', b.drag]));
    for (const [k, v] of Object.entries(a)) {
      if (['category', 'licenses', 'mass', 'drag', 'weapon', 'display name'].includes(k) || v === '' || v == null || typeof v === 'object') continue;
      attrNode.children.push(node([k, String(v)]));
    }
    const w = b.weapon || {};
    const wKids = ['blast radius', 'shield damage', 'hull damage', 'hit force'].filter(k => Number(w[k])).map(k => node([k, w[k]]));
    if (wKids.length) attrNode.children.push(node(['weapon'], wKids));
    if (attrNode.children.length) kids.push(attrNode);

    const outs = outfitList(b.outfits);
    if (outs.length) kids.push(node(['outfits'], outs.map(([n, c]) => node(c > 1 ? [n, c] : [n]))));

    for (const e of b.engines || []) {
      const [x, y] = coords(e.coords);
      const { value: zoom, rest } = takeInline(e.attrs, 'zoom');
      const kw = e.type === 'reverse' ? 'reverse engine' : e.type === 'steering' ? 'steering engine' : 'engine';
      kids.push(node(zoom ? [kw, x, y, zoom] : [kw, x, y], attrsToNodes(rest)));
    }
    for (const [kw, list] of [['gun', b.guns], ['turret', b.turrets]]) {
      for (const g of list || []) {
        const [x, y] = coords(g.coords);
        const over = clean(g.over).trim();
        kids.push(node(over ? [kw, x, y, over] : [kw, x, y], attrsToNodes(g.attrs)));
      }
    }
    for (const [cat, list] of [['Drone', b.drones], ['Fighter', b.fighters]]) {
      for (const d of list || []) {
        const [x, y] = coords(d.coords);
        const bay = node(d.position ? ['bay', cat, x, y, d.position] : ['bay', cat, x, y], attrsToNodes(d.attrs));
        if (d.launchEffect) bay.children.unshift(node(['launch effect', d.launchEffect]));
        kids.push(bay);
      }
    }
    for (const l of b.leaks || []) if (l && l.name) kids.push(node(['leak', l.name, parseInt(l.openChance) || 0, parseInt(l.spreadChance) || 0]));
    for (const e of b.explode || []) if (e && e.name) kids.push(node((parseInt(e.count) || 1) > 1 ? ['explode', e.name, e.count] : ['explode', e.name]));
    for (const e of b.finalExplode || []) if (e && e.name) kids.push(node(['final explode', e.name]));
    if (b.description) for (const para of String(b.description).split('\n')) if (para.trim()) kids.push(node(['description', para]));
    return node(head, kids);
  }

  /** Game ship (allData ships[] entry) or variant (allData variants[] entry, has .baseShip) → ship node. */
  function fromGameShip(s) {
    const base = s.baseShip || s.name;
    const variantName = s.baseShip ? (s.variant || s.name) : s.name;
    const kids = [];
    const outs = outfitList(s.outfits || s.outfitMap);
    if (outs.length) kids.push(node(['outfits'], outs.map(([n, c]) => node(c > 1 ? [n, c] : [n]))));
    return node(['ship', base, variantName], kids);
  }

  /**
   * Full shields, hull, fuel and the crew it needs, from the design's own
   * attributes (or its base model's) plus every installed outfit.
   * @param {object} attrs           ship attributes (flat)
   * @param {Array<[name,count]>} outfits
   * @param {Map<string, object>} outfitIndex  name → outfit (flat attributes)
   */
  function maxLevels(attrs, outfits, outfitIndex) {
    const sum = key => {
      let v = Number(attrs?.[key]) || 0;
      for (const [n, c] of outfits || []) v += (Number(outfitIndex?.get(n)?.[key]) || 0) * c;
      return v;
    };
    return {
      shields: Math.max(0, sum('shields')),
      hull: Math.max(0, sum('hull')),
      fuel: Math.max(0, sum('fuel capacity')),
      crew: Math.max(0, Math.round(Number(attrs?.['required crew']) || 0) + Math.round((outfits || []).reduce((n, [o, c]) => n + (Number(outfitIndex?.get(o)?.['required crew']) || 0) * c, 0))),
    };
  }

  return { fromBuild, fromGameShip, maxLevels, outfitList };
});
