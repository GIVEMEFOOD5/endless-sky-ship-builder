'use strict';

class SpeciesResolver {
  constructor() {
    this.reset();
  }

  reset() {
    this.fleets = [];
    this.npcRefs = [];
    this.shipyards = {};
    this.outfitters = {};
    this.planets = [];

    // NEW: ship → outfits installed in it
    this.shipOutfits = {}; 
  }

  // ─── Collection ─────────────────────────────────────

  collectFleet(government, shipNames) {
    if (government && shipNames.length) {
      this.fleets.push({ government, shipNames: [...shipNames] });
    }
  }

  collectNpcRef(government, shipName) {
    if (government && shipName) {
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
    this.planets.push({ name, government, shipyards, outfitters });
  }

  // NEW: call this when parsing ships
  collectShipOutfits(shipName, outfitNames) {
    if (!this.shipOutfits[shipName]) this.shipOutfits[shipName] = [];
    this.shipOutfits[shipName].push(...outfitNames);
  }

  // ─── Internal Helpers ───────────────────────────────

  _governmentsForShip(shipName) {
    const govts = new Set();

    // Fleet + mission references
    for (const fleet of this.fleets) {
      if (fleet.shipNames.includes(shipName)) {
        govts.add(fleet.government);
      }
    }

    for (const ref of this.npcRefs) {
      if (ref.shipName === shipName) {
        govts.add(ref.government);
      }
    }

    // Shipyard → planet → government
    for (const [yard, shipList] of Object.entries(this.shipyards)) {
      if (!shipList.includes(shipName)) continue;

      for (const planet of this.planets) {
        if (planet.shipyards.includes(yard) && planet.government) {
          govts.add(planet.government);
        }
      }
    }

    return govts;
  }

  _governmentsForOutfit(outfitName) {
    const govts = new Set();

    // Outfitter → planet → government
    for (const [outfitter, outfitList] of Object.entries(this.outfitters)) {
      if (!outfitList.includes(outfitName)) continue;

      for (const planet of this.planets) {
        if (planet.outfitters.includes(outfitter) && planet.government) {
          govts.add(planet.government);
        }
      }
    }

    // Ships that use this outfit
    for (const [shipName, outfitList] of Object.entries(this.shipOutfits)) {
      if (outfitList.includes(outfitName)) {
        const shipGovts = this._governmentsForShip(shipName);
        for (const g of shipGovts) govts.add(g);
      }
    }

    return govts;
  }

  // ─── Bulk Attachment ───────────────────────────────

  attachSpecies(ships, variants, outfits) {

    // Ships
    for (const ship of ships) {
      const govts = this._governmentsForShip(ship.name);
      ship.governments = [...govts].map(g => [g, true]);
    }

    // Variants (treated same as ships)
    for (const variant of variants) {
      const govts = this._governmentsForShip(variant.name);
      variant.governments = [...govts].map(g => [g, true]);
    }

    // Outfits
    for (const outfit of outfits) {
      const govts = this._governmentsForOutfit(outfit.name);
      outfit.governments = [...govts].map(g => [g, true]);
    }
  }
}

module.exports = SpeciesResolver;
