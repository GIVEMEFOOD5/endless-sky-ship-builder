'use strict';
class SpeciesResolver {
  constructor() { this.reset(); }
  reset() {
    this.fleets           = [];   // { government, shipNames, pluginId }
    this.npcRefs          = [];   // { government, shipName,  pluginId }
    this.shipyards        = {};   // name → [{ shipName, pluginId }]
    this.outfitters       = {};   // name → [{ outfitName, pluginId }]
    this.planets          = [];   // { name, government, shipyards, outfitters, pluginId }
    this.shipOutfits      = {};   // shipName → [{ outfitName, pluginId }]  (pluginId = owner of the SHIP)
    this.knownGovernments = new Set();
  }

  // ── Collectors (accept pluginId) ─────────────────────────────────────────────

  collectFleet(government, shipNames, pluginId) {
    if (!government) return;
    this.knownGovernments.add(government);
    if (shipNames.length) {
      this.fleets.push({ government, shipNames: [...shipNames], pluginId: pluginId ?? null });
    }
  }

  collectNpcRef(government, shipName, pluginId) {
    if (!shipName) return;
    if (government) this.knownGovernments.add(government);
    this.npcRefs.push({ government: government ?? null, shipName, pluginId: pluginId ?? null });
  }

  collectShipyard(name, shipNames, pluginId) {
    if (!this.shipyards[name]) this.shipyards[name] = [];
    for (const shipName of shipNames)
      this.shipyards[name].push({ shipName, pluginId: pluginId ?? null });
  }

  collectOutfitter(name, outfitNames, pluginId) {
    if (!this.outfitters[name]) this.outfitters[name] = [];
    for (const outfitName of outfitNames)
      this.outfitters[name].push({ outfitName, pluginId: pluginId ?? null });
  }

  collectPlanet(name, government, shipyards, outfitters, pluginId) {
    if (government) this.knownGovernments.add(government);
    this.planets.push({ name, government, shipyards, outfitters, pluginId: pluginId ?? null });
  }

  /**
   * Record outfits installed on a ship or variant.
   *
   * speciesShipName  — always the base ship name, used for government chain
   *                    resolution (base ship → government → outfit government).
   * variantShipName  — the full variant name when called from a variant context,
   *                    or null for base ships. When provided, outfits are stored
   *                    under the variant's own name so government lookups for the
   *                    variant reflect only its own outfit load, not the base ship's.
   *
   * `pluginId` here is the plugin that owns the SHIP/variant carrying the
   * outfit (parser.js passes `this._currentPluginId`, which at collection
   * time is whichever plugin's ship block is currently being parsed) — NOT
   * the outfit's own plugin. This is what lets outfit→ship government
   * resolution scope correctly to the right copy of a same-named ship.
   */
  collectShipOutfits(speciesShipName, outfitNames, pluginId, variantShipName = null) {
    if (!outfitNames.length) return;
    const storeName = variantShipName ?? speciesShipName;
    if (!this.shipOutfits[storeName]) this.shipOutfits[storeName] = [];
    for (const outfitName of outfitNames)
      this.shipOutfits[storeName].push({ outfitName, pluginId: pluginId ?? null });
  }

  // ── Internal lookups ─────────────────────────────────────────────────────────
  // Each returns a Map<pluginId, Set<government>>.

  /**
   * Resolve the governments associated with a ship (or variant) by name.
   *
   * `ownerPluginId`, when provided, restricts fleet/NPC/shipyard matches to
   * data declared by that same plugin. This matters because ship names
   * collide across independently-authored plugins far more often than one
   * might expect ("Shuttle", "Fighter", "Freighter", etc. are common reuse
   * targets for reskins/rebalances) — without this scoping, an unrelated
   * plugin's fleet that happens to use the same ship name would incorrectly
   * tag this ship with that plugin's government.
   *
   * Pass `null` (the default) to search across all plugins — used
   * deliberately for the variant→base-ship fallback, where the base ship is
   * very often defined by a *different* plugin (e.g. vanilla) than the one
   * that added the variant.
   */
  _governmentsForShip(shipName, ownerPluginId = null) {
    const result = new Map();

    const add = (pluginId, government) => {
      const key = pluginId ?? '__unknown__';
      if (!result.has(key)) result.set(key, new Set());
      result.get(key).add(government);
    };

    // Strip variant suffix: "Carrier (Alpha)" → "Carrier"
    const baseName = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();

    // Fleet listings: exact name only, scoped to ownerPluginId when known.
    for (const fleet of this.fleets) {
      if (!fleet.shipNames.includes(shipName)) continue;
      if (ownerPluginId != null && fleet.pluginId !== ownerPluginId) continue;
      add(fleet.pluginId, fleet.government);
    }

    // NPC refs: match exact name OR base name, same scoping rule.
    for (const ref of this.npcRefs) {
      if (!ref.government) continue;
      if (ref.shipName !== shipName && ref.shipName !== baseName) continue;
      if (ownerPluginId != null && ref.pluginId !== ownerPluginId) continue;
      add(ref.pluginId, ref.government);
    }

    // Shipyard → planet → government chain: exact ship name only.
    //
    // A shipyard "sells" this ship only if the shipyard-entry (this plugin's
    // `shipyard "X"` block listing the ship) and the planet's reference to
    // that same-named shipyard both come from the SAME plugin. Without this
    // check, two unrelated plugins that each happen to define a shipyard
    // called e.g. "Independent Shipyard" (shipyards/outfitters are keyed
    // globally by name here) would leak each other's ships/governments —
    // Plugin B's planet would appear to "sell" Plugin A's ship.
    for (const [yard, entries] of Object.entries(this.shipyards)) {
      const matchingEntries = entries.filter(e => e.shipName === shipName);
      if (!matchingEntries.length) continue;
      for (const planet of this.planets) {
        if (!planet.shipyards.includes(yard) || !planet.government) continue;
        for (const e of matchingEntries) {
          if ((e.pluginId ?? null) !== (planet.pluginId ?? null)) continue;
          if (ownerPluginId != null && e.pluginId !== ownerPluginId) continue;
          add(planet.pluginId, planet.government);
        }
      }
    }

    return result;
  }

  _governmentsForOutfit(outfitName) {
    const result = new Map();

    const add = (pluginId, government) => {
      const key = pluginId ?? '__unknown__';
      if (!result.has(key)) result.set(key, new Set());
      result.get(key).add(government);
    };

    // Outfitter → planet → government chain.
    // Same same-plugin requirement as the shipyard chain above, and for the
    // same reason: outfitter names ("Free Market", "General Store", ...)
    // collide across plugins constantly.
    for (const [outfitter, entries] of Object.entries(this.outfitters)) {
      const matchingEntries = entries.filter(e => e.outfitName === outfitName);
      if (!matchingEntries.length) continue;
      for (const planet of this.planets) {
        if (!planet.outfitters.includes(outfitter) || !planet.government) continue;
        for (const e of matchingEntries) {
          if ((e.pluginId ?? null) !== (planet.pluginId ?? null)) continue;
          add(planet.pluginId, planet.government);
        }
      }
    }

    // Ship outfit → ship government chain.
    // shipOutfits may be keyed by either a base ship name or a variant name.
    // Each entry records which plugin owns the *ship* carrying the outfit
    // (see collectShipOutfits), so we scope each lookup to that specific
    // plugin rather than searching all plugins for a same-named ship.
    for (const [shipName, entries] of Object.entries(this.shipOutfits)) {
      const matchingEntries = entries.filter(e => e.outfitName === outfitName);
      if (!matchingEntries.length) continue;

      const shipOwnerPluginIds = new Set(matchingEntries.map(e => e.pluginId ?? null));
      for (const shipOwnerPluginId of shipOwnerPluginIds) {
        for (const [pluginId, govts] of this._governmentsForShip(shipName, shipOwnerPluginId)) {
          for (const g of govts) {
            const effectivePlugin = pluginId !== '__unknown__'
              ? pluginId
              : (shipOwnerPluginId ?? null);
            add(effectivePlugin, g);
          }
        }
      }
    }

    this._filterToKnownGovernments(result);
    return result;
  }

  /**
   * Drop any government name that was never actually declared anywhere
   * (e.g. via a `fleet`, `npc`, or `planet` block) — guards against typos
   * or partial-data artifacts surviving into the output. Mutates and
   * returns `byPlugin` in place.
   */
  _filterToKnownGovernments(byPlugin) {
    for (const [pluginId, govts] of byPlugin) {
      for (const g of govts)
        if (!this.knownGovernments.has(g))
          govts.delete(g);
      if (!govts.size) byPlugin.delete(pluginId);
    }
    return byPlugin;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Attach government data to ships, variants, and outfits.
   *
   * Output shape — ship.governments:
   * {
   *   "Plugin A": { "Human": true },
   *   "Plugin B": { "Hai": true, "Republic": true }
   * }
   *
   * pluginName is the last-resort fallback when no government can be determined.
   */
  attachSpecies(ships, variants, outfits, pluginName) {
    const toObj = (byPlugin) => {
      if (byPlugin.size === 0) {
        if (!pluginName) return {};
        return { [pluginName]: { [pluginName]: true } };
      }
      const obj = {};
      for (const [pluginId, govts] of byPlugin) {
        const key = pluginId === '__unknown__' ? (pluginName ?? '__unknown__') : pluginId;
        if (!obj[key]) obj[key] = {};
        for (const g of govts) obj[key][g] = true;
      }
      return obj;
    };

    for (const ship of ships) {
      const byPlugin = this._governmentsForShip(ship.name, ship._pluginId ?? null);
      this._filterToKnownGovernments(byPlugin);
      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      ship.governments = toObj(byPlugin);
    }

    for (const variant of variants) {
      // Full variant name first, scoped to the variant's own plugin (a
      // fleet/NPC referencing a specific variant name is virtually always
      // declared by the same plugin that defines the variant).
      let byPlugin = this._governmentsForShip(variant.name, variant._variantPluginId ?? null);
      this._filterToKnownGovernments(byPlugin);

      // Fall back to the base ship's government, deliberately UNSCOPED —
      // the base ship is very often defined by a different plugin (e.g. a
      // vanilla ship reskinned by a mod), so restricting this search to the
      // variant's own plugin would make the fallback never find anything.
      if (byPlugin.size === 0) {
        byPlugin = this._governmentsForShip(variant.baseShip ?? variant.name, null);
        this._filterToKnownGovernments(byPlugin);
      }

      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      variant.governments = toObj(byPlugin);
    }

    for (const outfit of outfits) {
      const byPlugin = this._governmentsForOutfit(outfit.name);
      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      outfit.governments = toObj(byPlugin);
    }
  }
}
module.exports = SpeciesResolver;