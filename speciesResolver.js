'use strict';
class SpeciesResolver {
  constructor() {
    this.reset();
  }

  reset() {
    this.fleets      = [];
    this.npcRefs     = [];
    this.shipyards   = {};
    this.outfitters  = {};
    this.planets     = [];
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
   * Returns a Set of government strings associated with a ship name.
   * Checks fleet refs, NPC refs (including variant-named ships from missions
   * e.g. "Carrier (Alpha)"), and shipyard → planet chains.
   * For variant names, also checks the bare base name before the parenthesis.
   * @param {string} shipName
   * @returns {Set<string>}
   */
  _governmentsForShip(shipName) {
    const govts = new Set();

    // Strip variant suffix so "Carrier (Alpha)" also matches as "Carrier"
    const baseName = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();

    // Fleet references
    for (const fleet of this.fleets) {
      if (fleet.shipNames.includes(shipName) || fleet.shipNames.includes(baseName)) {
        govts.add(fleet.government);
      }
    }

    // NPC references — mission NPCs use the variant name as the ship type,
    // e.g.  ship "Carrier (Alpha)" "Giftbringer"
    // so we match on both the full variant name and the stripped base name
    for (const ref of this.npcRefs) {
      if (ref.shipName === shipName || ref.shipName === baseName) {
        govts.add(ref.government);
      }
    }

    // Shipyard → planet → government
    for (const [yard, shipList] of Object.entries(this.shipyards)) {
      if (!shipList.includes(shipName) && !shipList.includes(baseName)) continue;
      for (const planet of this.planets) {
        if (planet.shipyards.includes(yard) && planet.government) {
          govts.add(planet.government);
        }
      }
    }

    return govts;
  }

  /**
   * Returns a Set of government strings associated with an outfit name.
   * Checks outfitter → planet chains and ships that carry the outfit.
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
   * Each entry is [governmentName, true].
   * @param {object[]} ships
   * @param {object[]} variants
   * @param {object[]} outfits
   */
  attachSpecies(ships, variants, outfits) {
    for (const ship of ships) {
      ship.governments = [...this._governmentsForShip(ship.name)].map(g => [g, true]);
    }

    // Variants: merge governments found by variant display name (e.g. "Carrier (Alpha)"
    // which appears in mission NPC blocks) with those found by the base ship name
    // (which appears in fleet/shipyard blocks)
    for (const variant of variants) {
      const byVariant = this._governmentsForShip(variant.name);
      const byBase    = this._governmentsForShip(variant.baseShip ?? variant.name);
      variant.governments = [...new Set([...byVariant, ...byBase])].map(g => [g, true]);
    }

    for (const outfit of outfits) {
      outfit.governments = [...this._governmentsForOutfit(outfit.name)].map(g => [g, true]);
    }
  }
}

module.exports = SpeciesResolver;
