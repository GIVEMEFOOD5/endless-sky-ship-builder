// speciesResolver.js
// Resolves species/government for ships, variants, and outfits parsed from
// Endless Sky data files.
//
// How it works:
//   During parsing, parser.js calls collectFleet(), collectNpcRef(),
//   collectShipyard(), collectOutfitter(), collectPlanet(), and setSourceFile()
//   to feed raw data in. After all files are parsed and variants processed,
//   parser.js calls attachSpecies() to stamp species onto every item.
//
// Resolution pipeline (in priority order):
//   1. Folder  — parent folder of the .txt file matches a known government name
//   2. Reference — ship appears in fleet/npc/mission blocks; majority-vote government
//   3. Chain   — shipyard/outfitter → planet → government
//   4. Fallback — plugin name
//
// Confidence values written to each item:
//   "folder" | "reference" | "outfitter" | "inherited" | "fallback"
//
// To adjust what counts as a non-species government (Pirate, Merchant, etc.),
// edit the NON_SPECIES array below.

'use strict';

// ─── Non-species governments ──────────────────────────────────────────────────
// These are factions/roles in Endless Sky, not actual species.
// Ships used exclusively by these governments will fall through to the next step.
// Add any new ones here as the game or plugins introduce them.

const NON_SPECIES = [
  'Uninhabited',
  'Pirate',
  'Merchant',
  'Bounty Hunter',
  'Independent',
  'Derelict',
  'Hostile',
  'Civilian',
  'Escort',
  'Ruin',
  'Ruin-World',
  'Ruin-Nation',
  'Remnant Fighter',
  'Temporary',
  'Disaster',
  'Plague',
  'Neutral',
  'Wormhole',
  'Test Dummy',
];

const NON_SPECIES_LOWER = new Set(NON_SPECIES.map(g => g.toLowerCase()));

function isNonSpecies(govt) {
  return NON_SPECIES_LOWER.has(govt.toLowerCase());
}


// ─── SpeciesResolver class ────────────────────────────────────────────────────

class SpeciesResolver {
  constructor() {
    this.reset();
  }

  // Call this when starting a new repository parse so state doesn't bleed
  // across repositories.
  reset() {
    // { government: string, shipNames: string[] }[]
    this.fleets = [];

    // { government: string, shipName: string }[]  — from mission npc blocks
    this.npcRefs = [];

    // shipyardName → shipName[]
    this.shipyards = {};

    // outfitterName → outfitName[]
    this.outfitters = {};

    // { name, government, shipyards: string[], outfitters: string[] }[]
    this.planets = [];

    // itemName → parent folder name of the .txt file it was defined in
    this.sourceFiles = {};
  }


  // ─── Data collection (called from parser.js during parsing) ────────────────

  // Record which folder a ship or outfit was defined in.
  // filePath: absolute path to the .txt file
  // dataDir:  absolute path to the plugin's data/ directory
  // itemName: ship or outfit name string
  // Record which parent folder an item was defined in.
  // parentFolder: the immediate subdirectory of dataDir the file lives in,
  //               e.g. "human" for data/human/ships.txt
  //               Pass null if the file is directly in dataDir (no subfolder).
  setSourceFileFolder(itemName, parentFolder) {
    if (parentFolder) this.sourceFiles[itemName] = parentFolder;
  }

  // Record a named fleet block.
  collectFleet(government, shipNames) {
    if (government && shipNames.length) {
      this.fleets.push({ government, shipNames: [...shipNames] });
    }
  }

  // Record a single ship→government mapping from a mission npc block.
  collectNpcRef(government, shipName) {
    if (government && shipName) {
      this.npcRefs.push({ government, shipName });
    }
  }

  // Record a shipyard listing.
  collectShipyard(name, shipNames) {
    if (!this.shipyards[name]) this.shipyards[name] = [];
    this.shipyards[name].push(...shipNames);
  }

  // Record an outfitter listing.
  collectOutfitter(name, outfitNames) {
    if (!this.outfitters[name]) this.outfitters[name] = [];
    this.outfitters[name].push(...outfitNames);
  }

  // Record a planet with its government and marketplace listings.
  collectPlanet(name, government, shipyards, outfitters) {
    this.planets.push({ name, government, shipyards, outfitters });
  }


  // ─── Internal helpers ───────────────────────────────────────────────────────

  // Build a Set of lowercase folder names seen across all source files.
  // A government name that matches one of these is treated as a real species.
  _folderSpeciesSet() {
    const folders = new Set();
    for (const folder of Object.values(this.sourceFiles)) {
      if (folder) folders.add(folder.toLowerCase());
    }
    return folders;
  }

  // Majority-vote a government from a list, excluding non-species entries.
  // Tie-breaks alphabetically for deterministic results.
  // Returns null if nothing survives the filter.
  _majorityGovernment(governments) {
    const filtered = governments.filter(g => !isNonSpecies(g));
    if (!filtered.length) return null;
    const counts = {};
    for (const g of filtered) counts[g] = (counts[g] || 0) + 1;
    const sorted = Object.entries(counts).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    return sorted[0][0];
  }

  // All governments that reference shipName in fleet or npc blocks.
  _governmentsForShip(shipName) {
    const govts = [];
    for (const fleet of this.fleets) {
      if (fleet.shipNames.includes(shipName)) govts.push(fleet.government);
    }
    for (const ref of this.npcRefs) {
      if (ref.shipName === shipName) govts.push(ref.government);
    }
    return govts;
  }

  // Governments reachable via:  outfit → outfitter → planet → government
  _governmentsForOutfit(outfitName) {
    const govts = [];
    for (const [outfitterName, outfitList] of Object.entries(this.outfitters)) {
      if (!outfitList.includes(outfitName)) continue;
      for (const planet of this.planets) {
        if (planet.outfitters.includes(outfitterName) && planet.government) {
          govts.push(planet.government);
        }
      }
    }
    return govts;
  }

  // Governments reachable via:  ship → shipyard → planet → government
  _governmentsForShipyard(shipName) {
    const govts = [];
    for (const [shipyardName, shipList] of Object.entries(this.shipyards)) {
      if (!shipList.includes(shipName)) continue;
      for (const planet of this.planets) {
        if (planet.shipyards.includes(shipyardName) && planet.government) {
          govts.push(planet.government);
        }
      }
    }
    return govts;
  }


  // ─── Core resolution ────────────────────────────────────────────────────────

  // Resolve species for a single item.
  // mode:        "ship" | "outfit"
  // pluginName:  used as the final fallback label
  // folderSet:   Set of lowercase folder names (pass result of _folderSpeciesSet())
  //
  // Returns { species: string, confidence: string }
  resolve(itemName, mode, pluginName, folderSet) {
    // Step 1 — parent folder matches a known government/species
    const folder = this.sourceFiles[itemName];
    if (folder && folderSet.has(folder.toLowerCase())) {
      const species = folder.replace(/\b\w/g, c => c.toUpperCase());
      return { species, confidence: 'folder' };
    }

    // Step 2 — fleet / npc / mission references
    const refGovts = this._governmentsForShip(itemName);
    if (refGovts.length) {
      const species = this._majorityGovernment(refGovts);
      if (species) return { species, confidence: 'reference' };
    }

    // Step 3 — shipyard / outfitter → planet → government
    const chainGovts = mode === 'outfit'
      ? this._governmentsForOutfit(itemName)
      : this._governmentsForShipyard(itemName);
    if (chainGovts.length) {
      const species = this._majorityGovernment(chainGovts);
      if (species) return { species, confidence: 'outfitter' };
    }

    // Step 4 — fallback to plugin name
    return { species: pluginName, confidence: 'fallback' };
  }


  // ─── Bulk attachment ────────────────────────────────────────────────────────

  // Stamp species onto all ships, variants, and outfits.
  // ships/variants/outfits: the arrays from parser state
  // pluginName: fallback label
  attachSpecies(ships, variants, outfits, pluginName) {
    const folderSet = this._folderSpeciesSet();

    for (const ship of ships) {
      const { species, confidence } = this.resolve(ship.name, 'ship', pluginName, folderSet);
      ship.species           = species;
      ship.speciesConfidence = confidence;
    }

    for (const variant of variants) {
      // Variants inherit from their base ship first — most reliable signal.
      // Only fall through if the base itself only has a fallback.
      const base = ships.find(s => s.name === variant.baseShip);
      if (base?.species && base.speciesConfidence !== 'fallback') {
        variant.species           = base.species;
        variant.speciesConfidence = 'inherited';
      } else {
        // Try resolving the variant name via references
        const { species, confidence } = this.resolve(variant.name, 'ship', pluginName, folderSet);
        variant.species           = species;
        variant.speciesConfidence = confidence;
      }
    }

    for (const outfit of outfits) {
      const { species, confidence } = this.resolve(outfit.name, 'outfit', pluginName, folderSet);
      outfit.species           = species;
      outfit.speciesConfidence = confidence;
    }
  }
}

module.exports = SpeciesResolver;
