'use strict';
class SpeciesResolver {
  constructor() { this.reset(); }
  reset() {
    this.fleets           = [];   // { government, shipNames, pluginId }
    this.npcRefs          = [];   // { government, shipName,  pluginId }
    this.shipyards        = {};   // name → [{ shipName, pluginId }]
    this.outfitters       = {};   // name → [{ outfitName, pluginId }]
    this.planets          = [];   // { name, government, shipyards, outfitters, pluginId }
    this.shipOutfits      = {};   // shipName → [{ outfitName, pluginId }]
    this.knownGovernments = new Set();
  }

  // ── Collectors (now accept pluginId) ────────────────────────────────────────

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

  collectShipOutfits(shipName, outfitNames, pluginId) {
    if (!outfitNames.length) return;
    if (!this.shipOutfits[shipName]) this.shipOutfits[shipName] = [];
    for (const outfitName of outfitNames)
      this.shipOutfits[shipName].push({ outfitName, pluginId: pluginId ?? null });
  }

  // ── Internal lookups ─────────────────────────────────────────────────────────
  // Each returns a Map<pluginId, Set<government>> so callers know the source.

  _governmentsForShip(shipName) {
    // pluginId → Set<government>
    const result = new Map();

    const add = (pluginId, government) => {
      const key = pluginId ?? '__unknown__';
      if (!result.has(key)) result.set(key, new Set());
      result.get(key).add(government);
    };

    // Strip variant suffix: "Carrier (Alpha)" → "Carrier"
    const baseName = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();

    // Fleet listings: exact name only
    for (const fleet of this.fleets)
      if (fleet.shipNames.includes(shipName))
        add(fleet.pluginId, fleet.government);

    // NPC refs: match exact name OR base name
    for (const ref of this.npcRefs)
      if (ref.government)
        if (ref.shipName === shipName || ref.shipName === baseName)
          add(ref.pluginId, ref.government);

    // Shipyard → planet → government chain: exact name only
    for (const [yard, entries] of Object.entries(this.shipyards)) {
      const matchingEntries = entries.filter(e => e.shipName === shipName);
      if (!matchingEntries.length) continue;
      for (const planet of this.planets) {
        if (!planet.shipyards.includes(yard) || !planet.government) continue;
        // Use the pluginId of the planet (the government-assigning side)
        for (const e of matchingEntries)
          add(planet.pluginId ?? e.pluginId, planet.government);
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

    // Outfitter → planet → government chain
    for (const [outfitter, entries] of Object.entries(this.outfitters)) {
      const matchingEntries = entries.filter(e => e.outfitName === outfitName);
      if (!matchingEntries.length) continue;
      for (const planet of this.planets) {
        if (!planet.outfitters.includes(outfitter) || !planet.government) continue;
        for (const e of matchingEntries)
          add(planet.pluginId ?? e.pluginId, planet.government);
      }
    }

    // Ship outfit → ship government chain
    for (const [shipName, entries] of Object.entries(this.shipOutfits)) {
      const matchingEntries = entries.filter(e => e.outfitName === outfitName);
      if (!matchingEntries.length) continue;
      for (const [pluginId, govts] of this._governmentsForShip(shipName)) {
        for (const g of govts) {
          // Carry the pluginId from the ship lookup; fall back to outfit entry's pluginId
          const effectivePlugin = pluginId !== '__unknown__'
            ? pluginId
            : (matchingEntries[0]?.pluginId ?? null);
          add(effectivePlugin, g);
        }
      }
    }

    // Filter to only governments confirmed across all parsed plugins
    for (const [pluginId, govts] of result) {
      for (const g of govts)
        if (!this.knownGovernments.has(g))
          govts.delete(g);
      if (!govts.size) result.delete(pluginId);
    }

    return result;
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
    /**
     * Convert a Map<pluginId, Set<government>> into the nested output object.
     * Falls back to pluginName-keyed entry if the map is empty.
     */
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
      const byPlugin = this._governmentsForShip(ship.name);
      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      ship.governments = toObj(byPlugin);
    }

    for (const variant of variants) {
      // Full variant name first; fall back to base ship name only if nothing found
      let byPlugin = this._governmentsForShip(variant.name);
      if (byPlugin.size === 0)
        byPlugin = this._governmentsForShip(variant.baseShip ?? variant.name);
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
