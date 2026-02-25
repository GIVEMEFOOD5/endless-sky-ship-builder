'use strict';
class SpeciesResolver {
  constructor() { this.reset(); }

  reset() {
    this.fleets      = [];
    this.npcRefs     = [];
    this.shipyards   = {};
    this.outfitters  = {};
    this.planets     = [];
    this.shipOutfits = {};
  }

  collectFleet(government, shipNames) {
    if (government && shipNames.length)
      this.fleets.push({ government, shipNames: [...shipNames] });
  }
  collectNpcRef(government, shipName) {
    if (government && shipName)
      this.npcRefs.push({ government, shipName });
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
    return govts;
  }

  attachSpecies(ships, variants, outfits) {
    for (const ship of ships)
      ship.governments = [...this._governmentsForShip(ship.name)].map(g => [g, true]);
    for (const variant of variants) {
      const byVariant = this._governmentsForShip(variant.name);
      const byBase    = this._governmentsForShip(variant.baseShip ?? variant.name);
      variant.governments = [...new Set([...byVariant, ...byBase])].map(g => [g, true]);
    }
    for (const outfit of outfits)
      outfit.governments = [...this._governmentsForOutfit(outfit.name)].map(g => [g, true]);
  }
}
module.exports = SpeciesResolver;
