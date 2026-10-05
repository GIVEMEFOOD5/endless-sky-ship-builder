'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  pluginRefs.js — which plugins a ship-builder design depends on
//
//  Used by the parser (to flag shared ships and fleets when a plugin is
//  removed) and by the site (to show "needs plugin X" on ships). A design
//  refers to plugins through:
//    • _sourcePlugin / _sourceShip — the game ship it was started from
//    • outfits[].pluginId, or the "plugin::name" internalId
//  Plugins are named either by plugin_id ("Source/folder") or by the folder
//  (output_name), depending on where the item was picked — both are matched.
//
//  missingFor(design, removed) → [{ plugin_id, display_name, repository,
//    removed_at, uses: [item names] }]
// ═══════════════════════════════════════════════════════════════════════════

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PluginRefs = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const clean = v => String(v ?? '').replace(/^"|"$/g, '');

  /** [[pluginKey, itemName], …] for one design. */
  function refsOf(design) {
    const out = [];
    if (!design || typeof design !== 'object') return out;
    if (design._sourcePlugin) out.push([design._sourcePlugin, design._sourceShip || design.name || 'ship']);
    const add = (name, info) => {
      if (!info || typeof info !== 'object') return;
      let key = info.pluginId || null;
      if (!key && typeof info.internalId === 'string' && info.internalId.includes('::')) key = info.internalId.split('::')[0];
      if (key) out.push([key, clean(name || info.name)]);
    };
    const outs = design.outfits;
    if (Array.isArray(outs)) for (const o of outs) add(o && o.name, o);
    else if (outs && typeof outs === 'object') for (const [n, v] of Object.entries(outs)) add(n, v);
    return out;
  }

  /** Index removed_plugins rows by every name a design might use for them. */
  function indexRemoved(rows) {
    const map = new Map();
    for (const r of rows || []) {
      if (!r || !r.plugin_id) continue;
      map.set(r.plugin_id, r);
      if (r.output_name && !map.has(r.output_name)) map.set(r.output_name, r);
    }
    return map;
  }

  function missingFor(design, removedIndex) {
    if (!removedIndex || !removedIndex.size) return [];
    const byPlugin = new Map();
    for (const [key, item] of refsOf(design)) {
      const r = removedIndex.get(key);
      if (!r) continue;
      if (!byPlugin.has(r.plugin_id)) byPlugin.set(r.plugin_id, {
        plugin_id: r.plugin_id, display_name: r.display_name || r.output_name || r.plugin_id,
        source_name: r.source_name || null, repository: r.repository || null, removed_at: r.removed_at || null, uses: [],
      });
      const entry = byPlugin.get(r.plugin_id);
      if (item && !entry.uses.includes(item)) entry.uses.push(item);
    }
    return [...byPlugin.values()];
  }

  return { refsOf, indexRemoved, missingFor };
});
