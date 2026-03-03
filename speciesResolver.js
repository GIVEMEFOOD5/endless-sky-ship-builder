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
    // Always register the government as known — even if no ship names were
    // collected from this fleet block (ships may be in shipyards/variants).
    this.knownGovernments.add(government);
    if (shipNames.length) {
      this.fleets.push({ government, shipNames: [...shipNames] });
    }
  }

  collectNpcRef(government, shipName) {
    if (!shipName) return;
    if (government) {
      this.knownGovernments.add(government);
    }
    // Store every ship seen in a mission NPC block regardless of whether it
    // has an explicit government. Null-government entries are skipped in the
    // direct government lookup but still exist so we can attempt outfit-based
    // fallback resolution — previously these were silently dropped entirely.
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

    // Build the set of names to match against:
    //   "Falcon (Combat)" → also try "Falcon"
    //   "Falcon"          → just "Falcon"
    const baseName = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();
    const names = baseName !== shipName
      ? [shipName, baseName]
      : [shipName];

    // Fleet membership
    for (const fleet of this.fleets)
      for (const n of names)
        if (fleet.shipNames.includes(n))
          govts.add(fleet.government);

    // Mission NPC references — only use entries with a known government
    for (const ref of this.npcRefs)
      if (ref.government)
        for (const n of names)
          if (ref.shipName === n)
            govts.add(ref.government);

    // Shipyard → planet → government chain
    for (const [yard, shipList] of Object.entries(this.shipyards)) {
      if (!names.some(n => shipList.includes(n))) continue;
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
      if (govts.size === 0 && pluginName)
        govts.add(pluginName);
      ship.governments = toObj(govts);
    }

    for (const variant of variants) {
      // Resolve by full variant name first, then fall back to base ship name.
      // _governmentsForShip internally also strips the variant suffix, so
      // "Falcon (Combat)" will match npcRefs/fleets storing "Falcon".
      const merged = new Set([
        ...this._governmentsForShip(variant.name),
        ...this._governmentsForShip(variant.baseShip ?? variant.name),
      ]);
      if (merged.size === 0)
        for (const g of this._outfitFallbackGovernments(variant.outfitMap))
          merged.add(g);
      if (merged.size === 0 && pluginName)
        merged.add(pluginName);
      variant.governments = toObj(merged);
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
