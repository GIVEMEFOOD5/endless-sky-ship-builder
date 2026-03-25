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

    // Mission "give ship" refs: { missionName, shipName, pluginId }
    this.missionGiveShips = [];

    // Mission planet-add shipyard refs: { planetName, yardName, pluginId }
    // (events / missions can modify planets to add shipyards)
    this.eventPlanetShipyardAdds = [];

    // Ships and their outfit lists: { shipName, outfitName, pluginId }
    this.shipOutfitRefs = [];
  }

  // ── Collectors (called from parser) ─────────────────────────────────────────

  collectFleet(fleetName, shipNames, pluginId) {
    if (!fleetName) return;
    this.fleets.push({ name: fleetName, shipNames: [...shipNames], pluginId: pluginId ?? null });
  }

  collectFleetInSystem(fleetName, systemName, pluginId) {
    if (!fleetName || !systemName) return;
    this.fleetSystems.push({ fleetName, systemName, pluginId: pluginId ?? null });
  }

  collectPlanetInSystem(planetName, systemName, pluginId) {
    if (!planetName || !systemName) return;
    this.planetSystems.push({ planetName, systemName, pluginId: pluginId ?? null });
  }

  collectShipyard(yardName, shipNames, pluginId) {
    if (!yardName) return;
    this.shipyardEntries.push({ yardName, shipNames: [...shipNames], pluginId: pluginId ?? null });
  }

  collectPlanet(planetName, yardNames, outfitterNames, pluginId) {
    if (!planetName) return;
    this.planetShipyards.push({ planetName, yardNames: [...yardNames], pluginId: pluginId ?? null });
    this.planetOutfitters.push({ planetName, outfitterNames: [...outfitterNames], pluginId: pluginId ?? null });
  }

  collectOutfitter(outfitterName, outfitNames, pluginId) {
    if (!outfitterName) return;
    this.outfitterEntries.push({ outfitterName, outfitNames: [...outfitNames], pluginId: pluginId ?? null });
  }

  collectMissionNpcShip(missionName, shipName, pluginId) {
    if (!missionName || !shipName) return;
    this.missionNpcShips.push({ missionName, shipName, pluginId: pluginId ?? null });
  }

  collectMissionGiveOutfit(missionName, outfitName, count, pluginId) {
    if (!missionName || !outfitName) return;
    this.missionGiveOutfits.push({ missionName, outfitName, count: count ?? 1, pluginId: pluginId ?? null });
  }

  collectMissionGiveShip(missionName, shipName, pluginId) {
    if (!missionName || !shipName) return;
    this.missionGiveShips.push({ missionName, shipName, pluginId: pluginId ?? null });
  }

  collectEventPlanetShipyardAdd(planetName, yardName, pluginId) {
    if (!planetName || !yardName) return;
    this.eventPlanetShipyardAdds.push({ planetName, yardName, pluginId: pluginId ?? null });
  }

  collectShipOutfit(shipName, outfitName, pluginId) {
    if (!shipName || !outfitName) return;
    this.shipOutfitRefs.push({ shipName, outfitName, pluginId: pluginId ?? null });
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  _buildPlanetToSystems() {
    const map = new Map();
    for (const { planetName, systemName, pluginId } of this.planetSystems) {
      if (!map.has(planetName)) map.set(planetName, new Map());
      const byPlugin = map.get(planetName);
      const key = pluginId ?? '__unknown__';
      if (!byPlugin.has(key)) byPlugin.set(key, new Set());
      byPlugin.get(key).add(systemName);
    }
    return map;
  }

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

  _buildYardToPlanets() {
    const map = new Map();

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
   * Resolve all location data for a ship or variant.
   * Matches only on the exact shipName — no base-name fallback whatsoever.
   */
  _resolveShipLocations(shipName) {
    const result = {};
    const fleetToSystems  = this._buildFleetToSystems();
    const yardToPlanets   = this._buildYardToPlanets();
    const planetToSystems = this._buildPlanetToSystems();

    // ── 1. Named fleet membership → systems ─────────────────────────────────
    for (const fleet of this.fleets) {
      if (!fleet.shipNames.includes(shipName)) continue;

      const systemsByPlugin = fleetToSystems.get(fleet.name);
      if (systemsByPlugin) {
        this._mergeInto(result, systemsByPlugin, 'Systems', fleet.pluginId);
      }
    }

    // ── 2. Shipyard listings → planets and their systems ────────────────────
    for (const yard of this.shipyardEntries) {
      if (!yard.shipNames.includes(shipName)) continue;

      const planetsByPlugin = yardToPlanets.get(yard.yardName);
      if (!planetsByPlugin) continue;

      for (const [pluginKey, planets] of planetsByPlugin) {
        const effectiveKey = pluginKey === '__unknown__' ? (yard.pluginId ?? '__unknown__') : pluginKey;
        if (!result[effectiveKey]) result[effectiveKey] = {};
        if (!result[effectiveKey]['Planets']) result[effectiveKey]['Planets'] = new Set();
        for (const planet of planets) {
          result[effectiveKey]['Planets'].add(planet);
          const sysMap = planetToSystems.get(planet);
          if (sysMap) this._mergeInto(result, sysMap, 'Systems', effectiveKey);
        }
      }
    }

    // ── 3. Mission NPC references — exact name match only ───────────────────
    for (const ref of this.missionNpcShips) {
      if (ref.shipName !== shipName) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Missions']) result[key]['Missions'] = new Set();
      result[key]['Missions'].add(ref.missionName);
    }

    // ── 4. Mission "give ship" references ──────────────────────────────────
    for (const ref of this.missionGiveShips) {
      if (ref.shipName !== shipName) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Missions']) result[key]['Missions'] = new Set();
      result[key]['Missions'].add(ref.missionName);
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

    // ── 2. Ships that carry this outfit → shipyards → planets → systems ─────
    const shipsWithOutfit = new Set(
      this.shipOutfitRefs
        .filter(r => r.outfitName === outfitName)
        .map(r => r.shipName)
    );

    for (const shipName of shipsWithOutfit) {
      // Record the ships themselves
      for (const ref of this.shipOutfitRefs) {
        if (ref.outfitName !== outfitName || ref.shipName !== shipName) continue;
        const key = ref.pluginId ?? '__unknown__';
        if (!result[key]) result[key] = {};
        if (!result[key]['Ships']) result[key]['Ships'] = new Set();
        result[key]['Ships'].add(shipName);
      }

      // Shipyard path for that ship → planets
      for (const yard of this.shipyardEntries) {
        if (!yard.shipNames.includes(shipName)) continue;
        const planetsByPlugin = yardToPlanets.get(yard.yardName);
        if (!planetsByPlugin) continue;

        for (const [pluginKey, planets] of planetsByPlugin) {
          const effectiveKey = pluginKey === '__unknown__' ? (yard.pluginId ?? '__unknown__') : pluginKey;
          if (!result[effectiveKey]) result[effectiveKey] = {};
          if (!result[effectiveKey]['ShipyardPlanets']) result[effectiveKey]['ShipyardPlanets'] = new Set();
          for (const planet of planets) result[effectiveKey]['ShipyardPlanets'].add(planet);
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
          out[key][cat] = values;
        }
      }
    }
    return out;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  attachLocations(ships, variants, outfits, pluginName) {
    for (const ship of ships) {
      const raw = this._resolveShipLocations(ship.name);
      ship.locations = this._finalise(raw, pluginName);
    }

    for (const variant of variants) {
      const raw = this._resolveShipLocations(variant.name);
      variant.locations = this._finalise(raw, pluginName);
    }

    for (const outfit of outfits) {
      const raw = this._resolveOutfitLocations(outfit.name);
      outfit.locations = this._finalise(raw, pluginName);
    }
  }
}

module.exports = LocationResolver;
