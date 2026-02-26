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
    if (government && shipNames.length) {
      this.knownGovernments.add(government);
      this.fleets.push({ government, shipNames: [...shipNames] });
    }
  }
  collectNpcRef(government, shipName) {
    if (government && shipName) {
      this.knownGovernments.add(government);
      this.npcRefs.push({ government, shipName });
    }
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
    const baseName = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();
    for (const fleet of this.fleets)
      if (fleet.shipNames.includes(shipName) || fleet.shipNames.includes(baseName))
        govts.add(fleet.government);
    for (const ref of this.npcRefs)
      if (ref.shipName === shipName || ref.shipName === baseName)
        govts.add(ref.government);
    for (const [yard, shipList] of Object.entries(this.shipyards)) {
      if (!shipList.includes(shipName) && !shipList.includes(baseName)) continue;
      for (const planet of this.planets)
        if (planet.shipyards.includes(yard) && planet.government)
          govts.add(planet.government);
    }
    return govts;
  }
  _governmentsForOutfit(outfitName) {
    const govts = new Set();
    for (const [outfitter, outfitList] of Object.entries(this.outfitters)) {
      if (!outfitList.includes(outfitName)) continue;
      for (const planet of this.planets)
        if (planet.outfitters.includes(outfitter) && planet.government)
          govts.add(planet.government);
    }
    for (const [shipName, outfitList] of Object.entries(this.shipOutfits)) {
      if (!outfitList.includes(outfitName)) continue;
      for (const g of this._governmentsForShip(shipName))
        govts.add(g);
    }
    // Filter to only governments confirmed across all parsed plugins
    return new Set([...govts].filter(g => this.knownGovernments.has(g)));
  }
  _outfitFallbackGovernments(outfitMap) {
    const govts = new Set();
    if (!outfitMap) return govts;
    for (const outfitName of Object.keys(outfitMap))
      for (const g of this._governmentsForOutfit(outfitName))
        if (this.knownGovernments.has(g))
          govts.add(g);
    return govts;
  }
  // pluginName is used as a last-resort fallback government when nothing else matches
  attachSpecies(ships, variants, outfits, pluginName) {
    const toObj = govts => {
      const obj = {};
      for (const g of govts) obj[g] = true;
      return obj;
    };

    for (const ship of ships) {
      const govts = this._governmentsForShip(ship.name);
      if (govts.size === 0)
        for (const g of this._outfitFallbackGovernments(ship.outfitMap))
          govts.add(g);
      // Last resort: use the plugin name so nothing is left ungoverned
      if (govts.size === 0 && pluginName)
        govts.add(pluginName);
      ship.governments = toObj(govts);
    }

    for (const variant of variants) {
      const merged = new Set([
        ...this._governmentsForShip(variant.name),
        ...this._governmentsForShip(variant.baseShip ?? variant.name)
      ]);
      if (merged.size === 0)
        for (const g of this._outfitFallbackGovernments(variant.outfitMap))
          merged.add(g);
      // Last resort: use the plugin name
      if (merged.size === 0 && pluginName)
        merged.add(pluginName);
      variant.governments = toObj(merged);
    }

    for (const outfit of outfits) {
      const govts = this._governmentsForOutfit(outfit.name);
      // Last resort: use the plugin name
      if (govts.size === 0 && pluginName)
        govts.add(pluginName);
      outfit.governments = toObj(govts);
    }
  }
}
module.exports = SpeciesResolver;
