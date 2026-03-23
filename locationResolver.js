'use strict';

// ---------------------------------------------------------------------------
// LocationResolver
//
// Collects raw game-data references during parsing and resolves them into a
// per-entity "Locations" block grouped by plugin and then by category
// (Planets / Systems).
//
// Output shape attached to each ship / variant / outfit:
//
//   locations: {
//     "Endless Sky": {
//       Planets: ["Earth", "Poisonwood"],
//       Systems: ["Sol", "Betelgeuse"]
//     },
//     "my-plugin": {
//       Planets: ["New Hope"],
//       Systems: ["Alpha Centauri"]
//     }
//   }
//
// If a ship/outfit is referenced nowhere:
//   locations: {
//     "my-plugin": { "_deprecated/unused": true }
//   }
//
// ---------------------------------------------------------------------------

class LocationResolver {
  constructor() { this.reset(); }

  reset() {
    // ── Raw data stores ──────────────────────────────────────────────────────

    // Named fleets: { name, shipNames[], pluginId }
    // Anonymous inline fleets are handled via npcRefs.
    this.fleets = [];

    // { fleetName, systemName, pluginId }
    this.fleetSystems = [];

    // { planetName, systemName, pluginId }
    this.planetSystems = [];

    // Shipyard listings: { yardName, shipNames[], pluginId }
    this.shipyardEntries = [];

    // Planet → shipyard(s): { planetName, yardNames[], pluginId }
    this.planetShipyards = [];

    // Planet → outfitter(s): { planetName, outfitterNames[], pluginId }
    this.planetOutfitters = [];

    // Outfitter listings: { outfitterName, outfitNames[], pluginId }
    this.outfitterEntries = [];

    // Mission NPC ship refs: { missionName, shipName, pluginId }
    this.missionNpcShips = [];

    // Mission "give outfit" refs: { missionName, outfitName, count, pluginId }
    this.missionGiveOutfits = [];

    // Mission shipyard-add refs: { missionName, yardName, pluginId }
    // (missions can add a shipyard to a planet via "add shipyard")
    this.missionShipyardAdds = [];

    // Mission planet-add shipyard refs: { planetName, yardName, pluginId }
    // (events / missions can modify planets to add shipyards)
    this.eventPlanetShipyardAdds = [];

    // Ships and their outfit lists: { shipName, outfitName, pluginId }
    this.shipOutfitRefs = [];
  }

  // ── Collectors (called from parser) ─────────────────────────────────────────

  /**
   * A top-level named fleet block.
   * fleet "Human Merchant"
   *   government "Republic"
   *   variant
   *     "Bulk Freighter" 2
   */
  collectFleet(fleetName, shipNames, pluginId) {
    if (!fleetName) return;
    this.fleets.push({ name: fleetName, shipNames: [...shipNames], pluginId: pluginId ?? null });
  }

  /**
   * A system block's fleet reference.
   * system Sol
   *   fleet "Human Merchant" 100
   */
  collectFleetInSystem(fleetName, systemName, pluginId) {
    if (!fleetName || !systemName) return;
    this.fleetSystems.push({ fleetName, systemName, pluginId: pluginId ?? null });
  }

  /**
   * A planet found inside a system block.
   * system Sol
   *   object Earth
   *     planet Earth
   */
  collectPlanetInSystem(planetName, systemName, pluginId) {
    if (!planetName || !systemName) return;
    this.planetSystems.push({ planetName, systemName, pluginId: pluginId ?? null });
  }

  /**
   * A named shipyard block listing.
   * shipyard "Betelgeuse Shipyard"
   *   "Bulk Freighter"
   */
  collectShipyard(yardName, shipNames, pluginId) {
    if (!yardName) return;
    this.shipyardEntries.push({ yardName, shipNames: [...shipNames], pluginId: pluginId ?? null });
  }

  /**
   * A planet block referencing shipyards / outfitters.
   * planet Earth
   *   shipyard "Betelgeuse Shipyard"
   *   outfitter "Ammo"
   */
  collectPlanet(planetName, yardNames, outfitterNames, pluginId) {
    if (!planetName) return;
    this.planetShipyards.push({ planetName, yardNames: [...yardNames], pluginId: pluginId ?? null });
    this.planetOutfitters.push({ planetName, outfitterNames: [...outfitterNames], pluginId: pluginId ?? null });
  }

  /**
   * A named outfitter block listing.
   * outfitter "Ammo"
   *   "Sidewinder Missile"
   */
  collectOutfitter(outfitterName, outfitNames, pluginId) {
    if (!outfitterName) return;
    this.outfitterEntries.push({ outfitterName, outfitNames: [...outfitNames], pluginId: pluginId ?? null });
  }

  /**
   * An NPC ship reference inside a mission block.
   * mission "Rescue"
   *   npc
   *     ship "Bulk Freighter" "Bob"
   */
  collectMissionNpcShip(missionName, shipName, pluginId) {
    if (!missionName || !shipName) return;
    this.missionNpcShips.push({ missionName, shipName, pluginId: pluginId ?? null });
  }

  /**
   * A "give outfit" or "outfit" reward inside a mission block.
   * mission "Reward"
   *   on complete
   *     outfit "Sidewinder Missile" 30
   */
  collectMissionGiveOutfit(missionName, outfitName, count, pluginId) {
    if (!missionName || !outfitName) return;
    this.missionGiveOutfits.push({ missionName, outfitName, count: count ?? 1, pluginId: pluginId ?? null });
  }

  /**
   * An "add shipyard" or "shipyard" line inside a mission / event planet block,
   * linking a shipyard to a planet dynamically.
   * event "Liberate Earth"
   *   planet Earth
   *     add shipyard "Betelgeuse Shipyard"
   */
  collectEventPlanetShipyardAdd(planetName, yardName, pluginId) {
    if (!planetName || !yardName) return;
    this.eventPlanetShipyardAdds.push({ planetName, yardName, pluginId: pluginId ?? null });
  }

  /**
   * An outfit installed in a ship's outfit section.
   * ship "Bulk Freighter"
   *   outfits
   *     "Sidewinder Missile" 30
   */
  collectShipOutfit(shipName, outfitName, pluginId) {
    if (!shipName || !outfitName) return;
    this.shipOutfitRefs.push({ shipName, outfitName, pluginId: pluginId ?? null });
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /** Map planetName → Set<systemName> (from planetSystems) */
  _buildPlanetToSystems() {
    const map = new Map(); // planetName → Map<pluginId, Set<systemName>>
    for (const { planetName, systemName, pluginId } of this.planetSystems) {
      if (!map.has(planetName)) map.set(planetName, new Map());
      const byPlugin = map.get(planetName);
      const key = pluginId ?? '__unknown__';
      if (!byPlugin.has(key)) byPlugin.set(key, new Set());
      byPlugin.get(key).add(systemName);
    }
    return map;
  }

  /** Map fleetName → Map<pluginId, Set<systemName>> */
  _buildFleetToSystems() {
    const map = new Map();
    for (const { fleetName, systemName, pluginId } of this.fleetSystems) {
      if (!map.has(fleetName)) map.set(fleetName, new Map());
      const byPlugin = map.get(fleetName);
      const key = pluginId ?? '__unknown__';
      if (!byPlugin.has(key)) byPlugin.set(key, new Set());
      byPlugin.get(key).add(systemName);
    }
    return map;
  }

  /** Map yardName → Map<pluginId, Set<planetName>>
   *  Includes both static planet→shipyard links and dynamic event adds. */
  _buildYardToPlanets() {
    const map = new Map(); // yardName → Map<pluginId, Set<planetName>>

    const add = (yardName, planetName, pluginId) => {
      if (!map.has(yardName)) map.set(yardName, new Map());
      const byPlugin = map.get(yardName);
      const key = pluginId ?? '__unknown__';
      if (!byPlugin.has(key)) byPlugin.set(key, new Set());
      byPlugin.get(key).add(planetName);
    };

    for (const { planetName, yardNames, pluginId } of this.planetShipyards)
      for (const y of yardNames) add(y, planetName, pluginId);

    for (const { planetName, yardName, pluginId } of this.eventPlanetShipyardAdds)
      add(yardName, planetName, pluginId);

    return map;
  }

  /** Map outfitterName → Map<pluginId, Set<planetName>> */
  _buildOutfitterToPlanets() {
    const map = new Map();
    for (const { planetName, outfitterNames, pluginId } of this.planetOutfitters) {
      for (const o of outfitterNames) {
        if (!map.has(o)) map.set(o, new Map());
        const byPlugin = map.get(o);
        const key = pluginId ?? '__unknown__';
        if (!byPlugin.has(key)) byPlugin.set(key, new Set());
        byPlugin.get(key).add(planetName);
      }
    }
    return map;
  }

  // ── Core merge utility ────────────────────────────────────────────────────────

  /**
   * Merge a Map<pluginId, Set<value>> into a result object keyed by pluginId.
   * result shape: { pluginId: { category: Set<string> } }
   */
  _mergeInto(result, byPlugin, category, fallbackPlugin) {
    for (const [rawKey, values] of byPlugin) {
      const key = rawKey === '__unknown__' ? (fallbackPlugin ?? '__unknown__') : rawKey;
      if (!result[key]) result[key] = {};
      if (!result[key][category]) result[key][category] = new Set();
      for (const v of values) result[key][category].add(v);
    }
  }

  // ── Ship / variant location resolution ──────────────────────────────────────

  /**
   * Resolve all location data for a ship (or variant base name).
   * Returns a raw result object: { pluginId: { Planets: Set, Systems: Set } }
   */
  _resolveShipLocations(shipName, baseName) {
    const result = {};
    const fleetToSystems  = this._buildFleetToSystems();
    const yardToPlanets   = this._buildYardToPlanets();
    const planetToSystems = this._buildPlanetToSystems();

    // ── 1. Named fleet membership → systems ─────────────────────────────────
    for (const fleet of this.fleets) {
      // Match exact name or base name (for variants)
      if (!fleet.shipNames.includes(shipName) &&
          !(baseName && fleet.shipNames.includes(baseName))) continue;

      const systemsByPlugin = fleetToSystems.get(fleet.name);
      if (systemsByPlugin) {
        this._mergeInto(result, systemsByPlugin, 'Systems', fleet.pluginId);
      }
    }

    // ── 2. Shipyard listings → planets and their systems ────────────────────
    for (const yard of this.shipyardEntries) {
      if (!yard.shipNames.includes(shipName) &&
          !(baseName && yard.shipNames.includes(baseName))) continue;

      const planetsByPlugin = yardToPlanets.get(yard.yardName);
      if (!planetsByPlugin) continue;

      for (const [pluginKey, planets] of planetsByPlugin) {
        const effectiveKey = pluginKey === '__unknown__' ? (yard.pluginId ?? '__unknown__') : pluginKey;
        if (!result[effectiveKey]) result[effectiveKey] = {};
        if (!result[effectiveKey]['Planets']) result[effectiveKey]['Planets'] = new Set();
        for (const planet of planets) {
          result[effectiveKey]['Planets'].add(planet);
          // Also resolve that planet's system(s)
          const sysMap = planetToSystems.get(planet);
          if (sysMap) this._mergeInto(result, sysMap, 'Systems', effectiveKey);
        }
      }
    }

    // ── 3. Mission NPC references ────────────────────────────────────────────
    const missionNames = new Set();
    for (const ref of this.missionNpcShips) {
      const stripped = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();
      if (ref.shipName === shipName || ref.shipName === stripped ||
          (baseName && (ref.shipName === baseName))) {
        missionNames.add(`mission:${ref.missionName}`);
        const key = ref.pluginId ?? '__unknown__';
        if (!result[key]) result[key] = {};
        if (!result[key]['Missions']) result[key]['Missions'] = new Set();
        result[key]['Missions'].add(ref.missionName);
      }
    }

    return result;
  }

  // ── Outfit location resolution ───────────────────────────────────────────────

  _resolveOutfitLocations(outfitName) {
    const result = {};
    const outfitterToPlanets = this._buildOutfitterToPlanets();
    const yardToPlanets      = this._buildYardToPlanets();
    const planetToSystems    = this._buildPlanetToSystems();
    const fleetToSystems     = this._buildFleetToSystems();

    // ── 1. Outfitter listings → planets ─────────────────────────────────────
    for (const entry of this.outfitterEntries) {
      if (!entry.outfitNames.includes(outfitName)) continue;

      const planetsByPlugin = outfitterToPlanets.get(entry.outfitterName);
      if (!planetsByPlugin) continue;

      for (const [pluginKey, planets] of planetsByPlugin) {
        const effectiveKey = pluginKey === '__unknown__' ? (entry.pluginId ?? '__unknown__') : pluginKey;
        if (!result[effectiveKey]) result[effectiveKey] = {};
        if (!result[effectiveKey]['Planets']) result[effectiveKey]['Planets'] = new Set();
        if (!result[effectiveKey]['Outfitters']) result[effectiveKey]['Outfitters'] = new Set();
        result[effectiveKey]['Outfitters'].add(entry.outfitterName);
        for (const planet of planets) result[effectiveKey]['Planets'].add(planet);
      }
    }

    // ── 2. Ships that carry this outfit → shipyards those ships are sold at
    //        → planets of those shipyards → systems of those planets ──────────
    const shipsWithOutfit = new Set(
      this.shipOutfitRefs
        .filter(r => r.outfitName === outfitName)
        .map(r => r.shipName)
    );

    for (const shipName of shipsWithOutfit) {
      // Track the ships themselves
      for (const ref of this.shipOutfitRefs) {
        if (ref.outfitName !== outfitName || ref.shipName !== shipName) continue;
        const key = ref.pluginId ?? '__unknown__';
        if (!result[key]) result[key] = {};
        if (!result[key]['Ships']) result[key]['Ships'] = new Set();
        result[key]['Ships'].add(shipName);
      }

      // Shipyard path for that ship → planets → systems
      for (const yard of this.shipyardEntries) {
        if (!yard.shipNames.includes(shipName)) continue;
        const planetsByPlugin = yardToPlanets.get(yard.yardName);
        if (!planetsByPlugin) continue;

        for (const [pluginKey, planets] of planetsByPlugin) {
          const effectiveKey = pluginKey === '__unknown__' ? (yard.pluginId ?? '__unknown__') : pluginKey;
          if (!result[effectiveKey]) result[effectiveKey] = {};
          if (!result[effectiveKey]['ShipyardPlanets']) result[effectiveKey]['ShipyardPlanets'] = new Set();
          for (const planet of planets) {
            result[effectiveKey]['ShipyardPlanets'].add(planet);
          }
        }
      }

      // Fleet path for that ship → systems
      for (const fleet of this.fleets) {
        if (!fleet.shipNames.includes(shipName)) continue;
        const systemsByPlugin = fleetToSystems.get(fleet.name);
        if (!systemsByPlugin) continue;
        this._mergeInto(result, systemsByPlugin, 'Systems', fleet.pluginId);
      }
    }

    // ── 3. Mission "give outfit" references ──────────────────────────────────
    for (const ref of this.missionGiveOutfits) {
      if (ref.outfitName !== outfitName) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Missions']) result[key]['Missions'] = new Set();
      result[key]['Missions'].add(ref.missionName);
    }

    return result;
  }

  // ── Serialisation helper ─────────────────────────────────────────────────────

  /**
   * Convert a raw result { pluginId: { Category: Set<string> } }
   * into the final JSON-safe shape { pluginId: { Category: [...] } }
   * with Sets → sorted arrays.
   * If result is empty, marks the entity as deprecated/unused.
   */
  _finalise(result, pluginName) {
    if (Object.keys(result).length === 0) {
      const key = pluginName ?? '__unknown__';
      return { [key]: { '_deprecated/unused': true } };
    }

    const out = {};
    for (const [pluginId, categories] of Object.entries(result)) {
      const key = pluginId === '__unknown__' ? (pluginName ?? '__unknown__') : pluginId;
      if (!out[key]) out[key] = {};
      for (const [cat, values] of Object.entries(categories)) {
        if (values instanceof Set) {
          out[key][cat] = [...values].sort();
        } else {
          out[key][cat] = values; // boolean flags like _deprecated/unused
        }
      }
    }
    return out;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Attach `.locations` to every ship, variant, and outfit.
   * Call this after all plugins have been parsed (same timing as attachSpecies).
   *
   * @param {object[]} ships
   * @param {object[]} variants
   * @param {object[]} outfits
   * @param {string}   pluginName  - fallback plugin label for unused entities
   */
  attachLocations(ships, variants, outfits, pluginName) {
    for (const ship of ships) {
      const raw = this._resolveShipLocations(ship.name, null);
      ship.locations = this._finalise(raw, pluginName);
    }

    for (const variant of variants) {
      // Try full variant name first, then fall back to base ship name
      let raw = this._resolveShipLocations(variant.name, variant.baseShip ?? null);
      if (Object.keys(raw).length === 0 && variant.baseShip) {
        raw = this._resolveShipLocations(variant.baseShip, null);
      }
      variant.locations = this._finalise(raw, pluginName);
    }

    for (const outfit of outfits) {
      const raw = this._resolveOutfitLocations(outfit.name);
      outfit.locations = this._finalise(raw, pluginName);
    }
  }
}

module.exports = LocationResolver;
