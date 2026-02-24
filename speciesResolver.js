'use strict';
class SpeciesResolver {
  constructor() {
    this.reset();
  }

  reset() {
    this.fleets     = [];
    this.npcRefs    = [];
    this.shipyards  = {};
    this.outfitters = {};
    this.planets    = [];
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

  /**
   * Call this when parsing a ship's `outfits` block so that
   * outfit → ship → government resolution works.
   * @param {string}   shipName
   * @param {string[]} outfitNames
   */
  collectShipOutfits(shipName, outfitNames) {
    if (!outfitNames.length) return;
    if (!this.shipOutfits[shipName]) this.shipOutfits[shipName] = [];
    this.shipOutfits[shipName].push(...outfitNames);
  }

  // ─── Internal Helpers ───────────────────────────────

  /**
   * Returns a Set of government strings associated with a ship name,
   * drawn from fleet references, NPC references, and shipyard→planet chains.
   * @param {string} shipName
   * @returns {Set<string>}
   */
  _governmentsForShip(shipName) {
    const govts = new Set();

    // Fleet + mission/NPC references
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

  /**
   * Returns a Set of government strings associated with an outfit name,
   * drawn from outfitter→planet chains and ships that carry the outfit.
   * @param {string} outfitName
   * @returns {Set<string>}
   */
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

    // Ships that carry this outfit → their governments
    for (const [shipName, outfitList] of Object.entries(this.shipOutfits)) {
      if (!outfitList.includes(outfitName)) continue;
      for (const g of this._governmentsForShip(shipName)) {
        govts.add(g);
      }
    }

    return govts;
  }

  // ─── Bulk Attachment ────────────────────────────────

  /**
   * Attaches a `governments` array to every ship, variant, and outfit.
   * Each entry is [governmentName, true] to match the expected output format.
   * @param {object[]} ships
   * @param {object[]} variants
   * @param {object[]} outfits
   */
  attachSpecies(ships, variants, outfits) {
    for (const ship of ships) {
      ship.governments = [...this._governmentsForShip(ship.name)].map(g => [g, true]);
    }
    for (const variant of variants) {
      // Variants inherit their base ship's governments
      variant.governments = [...this._governmentsForShip(variant.baseShip ?? variant.name)].map(g => [g, true]);
    }
    for (const outfit of outfits) {
      outfit.governments = [...this._governmentsForOutfit(outfit.name)].map(g => [g, true]);
    }
  }
}

module.exports = SpeciesResolver;
