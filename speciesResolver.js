'use strict';
class SpeciesResolver {
  constructor() { this.reset(); }
  reset() {
    this.fleets           = [];
    this.npcRefs          = [];
    this.shipyards        = {};
    this.outfitters       = {};
    this.planets          = [];
    this.shipOutfits      = {};
    this.knownGovernments = new Set();
  }

  collectFleet(government, shipNames) {
    if (!government) return;
    this.knownGovernments.add(government);
    if (shipNames.length) {
      this.fleets.push({ government, shipNames: [...shipNames] });
    }
  }

  collectNpcRef(government, shipName) {
    if (!shipName) return;
    if (government) this.knownGovernments.add(government);
    this.npcRefs.push({ government: government ?? null, shipName });
  }

  collectShipyard(name, shipNames) {
    if (!this.shipyards[name]) this.shipyards[name] = [];
    this.shipyards[name].push(...shipNames);
  }

  collectOutfitter(name, outfitNames) {
    if (!this.outfitters[name]) this.outfitters[name] = [];
    this.outfitters[name].push(...outfitNames);
  }

  collectPlanet(name, government, shipyards, outfitters) {
    if (government) this.knownGovernments.add(government);
    this.planets.push({ name, government, shipyards, outfitters });
  }

  collectShipOutfits(shipName, outfitNames) {
    if (!outfitNames.length) return;
    if (!this.shipOutfits[shipName]) this.shipOutfits[shipName] = [];
    this.shipOutfits[shipName].push(...outfitNames);
  }

  _governmentsForShip(shipName) {
    const govts = new Set();

    // Strip variant suffix: "Carrier (Alpha)" → "Carrier"
    const baseName = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();

    // Fleet and shipyard lookups: exact name only.
    // A fleet listing "Carrier" refers to the base hull, not "Carrier (Alpha)".
    // Using the base name here would bleed base ship governments into unrelated variants.
    for (const fleet of this.fleets)
      if (fleet.shipNames.includes(shipName))
        govts.add(fleet.government);

    // NPC refs: match exact name OR base name.
    // Missions store the full type name e.g. "Carrier (Alpha)", but a mission that
    // just says ship "Carrier" "Bob" stores "Carrier" which should match base lookups.
    for (const ref of this.npcRefs)
      if (ref.government)
        if (ref.shipName === shipName || ref.shipName === baseName)
          govts.add(ref.government);

    // Shipyard → planet → government chain: exact name only
    for (const [yard, shipList] of Object.entries(this.shipyards)) {
      if (!shipList.includes(shipName)) continue;
      for (const planet of this.planets)
        if (planet.shipyards.includes(yard) && planet.government)
          govts.add(planet.government);
    }

    return govts;
  }

  _governmentsForOutfit(outfitName) {
    const govts = new Set();

    // Outfitter → planet → government chain
    for (const [outfitter, outfitList] of Object.entries(this.outfitters)) {
      if (!outfitList.includes(outfitName)) continue;
      for (const planet of this.planets)
        if (planet.outfitters.includes(outfitter) && planet.government)
          govts.add(planet.government);
    }

    // Ship outfit → ship government chain
    for (const [shipName, outfitList] of Object.entries(this.shipOutfits)) {
      if (!outfitList.includes(outfitName)) continue;
      for (const g of this._governmentsForShip(shipName))
        govts.add(g);
    }

    // Filter to only governments confirmed across all parsed plugins
    return new Set([...govts].filter(g => this.knownGovernments.has(g)));
  }

  // pluginName is the last-resort fallback when no government can be determined.
  // For multi-plugin repos it is the subfolder name; for single-plugin repos it
  // is the source name from plugins.json — both passed in as outputName by main().
  attachSpecies(ships, variants, outfits, pluginName) {
    const toObj = govts => {
      const obj = {};
      for (const g of govts) obj[g] = true;
      return obj;
    };

    for (const ship of ships) {
      const govts = this._governmentsForShip(ship.name);
      if (govts.size === 0 && pluginName)
        govts.add(pluginName);
      ship.governments = toObj(govts);
    }

    for (const variant of variants) {
      // Look up by full variant name first (e.g. "Carrier (Alpha)").
      // Only fall back to base ship name if nothing found — prevents base ship
      // governments bleeding into variants belonging to a different faction.
      const govts = this._governmentsForShip(variant.name);
      if (govts.size === 0)
        for (const g of this._governmentsForShip(variant.baseShip ?? variant.name))
          govts.add(g);
      if (govts.size === 0 && pluginName)
        govts.add(pluginName);
      variant.governments = toObj(govts);
    }

    for (const outfit of outfits) {
      const govts = this._governmentsForOutfit(outfit.name);
      if (govts.size === 0 && pluginName)
        govts.add(pluginName);
      outfit.governments = toObj(govts);
    }
  }
}
module.exports = SpeciesResolver;
