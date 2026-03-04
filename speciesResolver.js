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

    // Strip variant suffix: "Carrier (Alpha)" → "Carrier"
    const baseName = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();
    const isVariant = baseName !== shipName;

    // Fleet and shipyard lookups use EXACT name only.
    // A fleet listing "Carrier" refers to the base hull, not "Carrier (Alpha)".
    // Letting the base name match here would bleed base ship governments into
    // unrelated variants (e.g. Republic/Syndicate into Alpha variants).
    for (const fleet of this.fleets)
      if (fleet.shipNames.includes(shipName))
        govts.add(fleet.government);

    // NPC refs use both exact name and base name, because missions reference
    // ships by their type name: ship "Carrier (Alpha)" "Giftbringer" stores
    // "Carrier (Alpha)" directly, but ship "Carrier" "Bob" stores "Carrier"
    // which should match a base ship lookup.
    for (const ref of this.npcRefs)
      if (ref.government)
        if (ref.shipName === shipName || ref.shipName === baseName)
          govts.add(ref.government);

    // Shipyard → planet → government chain: exact name only (same reason as fleets)
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
      // First: look up by the full variant name e.g. "Carrier (Alpha)".
      // _governmentsForShip also strips the suffix internally, so this covers
      // npcRefs/fleets that stored "Carrier (Alpha)" OR "Carrier".
      const govts = this._governmentsForShip(variant.name);

      // Only fall back to the base ship lookup if the variant-specific lookup
      // found nothing. Merging both unconditionally causes base ship governments
      // (e.g. Republic, Syndicate for "Carrier") to bleed into variants that
      // belong to a completely different government (e.g. "Carrier (Alpha)" → Alpha).
      if (govts.size === 0) {
        for (const g of this._governmentsForShip(variant.baseShip ?? variant.name))
          govts.add(g);
      }

      if (govts.size === 0)
        for (const g of this._outfitFallbackGovernments(variant.outfitMap))
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
