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
//       Systems: ["Sol", "Betelgeuse"],
//       EventFleetChanges: ["..."],        ← NEW, see below
//       TriggeredByMissionEvents: ["..."], ← NEW, see below
//       Persons: ["Cap'n Pester"]          ← NEW, see below
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
// ── CHANGELOG (mission/event parsing pass) ──────────────────────────────────
//   - Added: collectMissionEventTrigger — records "mission X can trigger
//     event Y" (from an `event "Y"` action line inside a mission).
//   - Added: collectEventSystemFleetChange — records "event X adds/removes
//     fleet Y in system Z" (from a `system "Z"` > `add/remove fleet "Y"`
//     sub-block inside an event).
//   - Added: collectEventPlanetOutfitterChange — the outfitter counterpart
//     to the existing (now generalized) shipyard-add tracking; previously
//     there was no tracking at all for `add outfitter`/`remove outfitter`.
//   - Added: collectEventPlanetShipyardChange — a traceable, event-name +
//     action-tagged sibling to the existing collectEventPlanetShipyardAdd.
//     collectEventPlanetShipyardAdd is KEPT EXACTLY AS BEFORE (still
//     unconditionally merges into the base "this planet sells here" data,
//     since that's how it already behaved) — the new method is purely
//     additive, for a new "EventFleetChanges"-style traceability category,
//     and does not change any existing resolution behavior.
//   - Added: two new output categories on ship/outfit location results —
//     "EventFleetChanges" (which events add/remove this ship's fleet from
//     which systems) and "TriggeredByMissionEvents" (which of the missions
//     already listed under "Missions" are known to trigger an event, and
//     which event).
//   - NEW (person-block pass): collectPerson / collectPersonSystem — the
//     location-side counterpart to SpeciesResolver.collectPerson. Records
//     which `person "X"` blocks a ship belongs to, and which system(s) (if
//     any — persons.txt entries often use a `system "X"` line to restrict
//     where a unique ship spawns) that person is tied to. Surfaced as a
//     new "Persons" category on the ship's location output, and any known
//     system is merged into the existing "Systems" set the same way a
//     fleet's spawn systems already are.
// ─────────────────────────────────────────────────────────────────────────

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
    // KEPT AS-IS — still unconditional, still what _buildYardToPlanets
    // merges into the base "this planet sells here" data. See
    // collectEventPlanetShipyardChange below for the new, traceable,
    // NON-merged sibling of this.
    this.eventPlanetShipyardAdds = [];

    // NEW — { planetName, yardName, action: 'add'|'remove', eventName, pluginId }
    // Traceable version: every shipyard change an event causes, tagged
    // with WHICH event caused it and whether it's an add or a remove.
    // Deliberately NOT merged into planetShipyards/yardToPlanets — unlike
    // eventPlanetShipyardAdds above, these are surfaced as their own
    // "EventFleetChanges"-style category rather than folded into the
    // base "always true" location data, since a remove can't be
    // expressed as a subtraction from a Set built elsewhere without
    // assuming an application order this resolver has no way to know.
    this.eventPlanetShipyardChanges = [];

    // NEW — { planetName, outfitterName, action: 'add'|'remove', eventName, pluginId }
    // Outfitter counterpart to eventPlanetShipyardChanges. 'add' actions
    // ALSO feed into _buildOutfitterToPlanets (see below) the same way
    // eventPlanetShipyardAdds feeds _buildYardToPlanets — there was
    // previously no equivalent tracking for outfitters at all.
    this.eventPlanetOutfitterChanges = [];

    // NEW — { eventName, systemName, fleetName, action: 'add'|'remove', rate, pluginId }
    // "Event X adds/removes fleet Y in system Z" — the raw half of the
    // event → fleet → government join (the other half, fleet → government,
    // lives in SpeciesResolver.fleets; EndlessSkyParser.
    // resolveEventGovernmentImpact() does the actual join).
    this.eventSystemFleetChanges = [];

    // NEW — { missionName, eventName, pluginId }
    // "Mission X can trigger event Y" (from an `event "Y"` action line
    // inside the mission's on offer/on accept/on complete/etc body).
    this.missionEventTriggers = [];

    // NEW — { personName, shipName, pluginId }
    // "person X" block includes ship Y". The location-side counterpart of
    // SpeciesResolver.persons.
    this.personShips = [];

    // NEW — { personName, systemName, pluginId }
    // "person X" is restricted to spawning in system Y (from a `system
    // "Y"` line inside the person block). A person may have zero, one, or
    // (rarely) more than one system line; all are recorded.
    this.personSystems = [];

    // Ships and their outfit lists: { shipName, outfitName, pluginId, shipPluginId }
    // NOTE: `pluginId` here is the plugin that OWNS the outfit being carried
    // (resolved via _resolveOutfitPluginId at collection time / backfilled by
    // resolveAllOutfitPluginIds afterwards) — NOT the plugin the ship itself
    // belongs to. This distinction is what lets outfit-location resolution
    // correctly scope "which ships carry MY outfit" vs. "which ships carry
    // a same-named outfit from some other plugin".
    //
    // `shipPluginId` is the plugin that OWNS the ship/variant itself. This is
    // what must be used when filing a carrying-ship under a plugin key in the
    // output — using `pluginId` (the outfit's plugin) there would mislabel
    // ships that live in a different plugin than the outfit they carry.
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

  // NEW
  collectEventPlanetShipyardChange(planetName, yardName, action, eventName, pluginId) {
    if (!planetName || !yardName || !action) return;
    this.eventPlanetShipyardChanges.push({
      planetName, yardName, action, eventName: eventName ?? null, pluginId: pluginId ?? null,
    });
  }

  // NEW
  collectEventPlanetOutfitterChange(planetName, outfitterName, action, eventName, pluginId) {
    if (!planetName || !outfitterName || !action) return;
    this.eventPlanetOutfitterChanges.push({
      planetName, outfitterName, action, eventName: eventName ?? null, pluginId: pluginId ?? null,
    });
  }

  // NEW
  collectEventSystemFleetChange(eventName, systemName, fleetName, action, rate, pluginId) {
    if (!eventName || !systemName || !fleetName || !action) return;
    this.eventSystemFleetChanges.push({
      eventName, systemName, fleetName, action, rate: rate ?? null, pluginId: pluginId ?? null,
    });
  }

  // NEW
  collectMissionEventTrigger(missionName, eventName, pluginId) {
    if (!missionName || !eventName) return;
    this.missionEventTriggers.push({ missionName, eventName, pluginId: pluginId ?? null });
  }

  /**
   * NEW. Records that a `person "X"` block includes ship `shipName`.
   * Called once per ship in the person block (see parser.js
   * parsePersonBlock), mirroring collectMissionNpcShip's shape/behavior.
   */
  collectPerson(personName, shipName, pluginId) {
    if (!personName || !shipName) return;
    this.personShips.push({ personName, shipName, pluginId: pluginId ?? null });
  }

  /**
   * NEW. Records that person `personName` is tied to `systemName` (from a
   * `system "X"` line inside the person block). Not every person has one —
   * plenty roam freely with no system restriction — so this simply isn't
   * called for those.
   */
  collectPersonSystem(personName, systemName, pluginId) {
    if (!personName || !systemName) return;
    this.personSystems.push({ personName, systemName, pluginId: pluginId ?? null });
  }

  // `pluginId` = the plugin that owns the OUTFIT being carried.
  // `shipPluginId` = the plugin that owns the SHIP/variant carrying it.
  collectShipOutfit(shipName, outfitName, pluginId, shipPluginId) {
    if (!shipName || !outfitName) return;
    this.shipOutfitRefs.push({
      shipName,
      outfitName,
      pluginId: pluginId ?? null,
      shipPluginId: shipPluginId ?? null,
    });
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

    // Unconditional base behavior — unchanged from before this pass.
    for (const { planetName, yardName, pluginId } of this.eventPlanetShipyardAdds)
      add(yardName, planetName, pluginId);

    return map;
  }

  _buildOutfitterToPlanets() {
    const map = new Map();

    const add = (outfitterName, planetName, pluginId) => {
      if (!map.has(outfitterName)) map.set(outfitterName, new Map());
      const byPlugin = map.get(outfitterName);
      const key = pluginId ?? '__unknown__';
      if (!byPlugin.has(key)) byPlugin.set(key, new Set());
      byPlugin.get(key).add(planetName);
    };

    for (const { planetName, outfitterNames, pluginId } of this.planetOutfitters)
      for (const o of outfitterNames) add(o, planetName, pluginId);

    // NEW — 'add' actions from events feed in the same way
    // eventPlanetShipyardAdds feeds _buildYardToPlanets. There was
    // previously no equivalent for outfitters at all.
    for (const { planetName, outfitterName, action, pluginId } of this.eventPlanetOutfitterChanges)
      if (action === 'add') add(outfitterName, planetName, pluginId);

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

  /**
   * Merge only the slice of a `name → Map<pluginId, Set<value>>` lookup
   * that belongs to one specific plugin, instead of every plugin that
   * happens to share that name.
   *
   * Fleet/shipyard/outfitter names are a single global namespace here
   * (`this.fleets`, `this.shipyards`, `this.outfitters` are all keyed by
   * name only), so two unrelated plugins that both declare, say, a
   * `fleet "Merchant Fleet"` or `shipyard "Independent Shipyard"` end up
   * sharing one bucket in the by-name maps built above. Iterating every
   * plugin in that bucket (as the code used to) meant Plugin B's spawn
   * systems / sale planets would silently attach to Plugin A's fleet/yard
   * match, and vice versa. Restricting to `pluginId` keeps each plugin's
   * same-named declaration isolated from every other plugin's.
   */
  _mergeOwnPluginOnly(result, byPluginMap, category, pluginId) {
    if (!byPluginMap) return;
    const key = pluginId ?? '__unknown__';
    const values = byPluginMap.get(key);
    if (!values || !values.size) return;
    if (!result[key]) result[key] = {};
    if (!result[key][category]) result[key][category] = new Set();
    for (const v of values) result[key][category].add(v);
  }

  /**
   * NEW helper. Formats event-driven fleet changes for a given fleet name
   * into human-readable strings, and merges them under `category` for the
   * fleet's own plugin — matching the string-Set output convention every
   * other category in this file already uses (Planets/Systems/Missions/...).
   */
  _mergeEventFleetChanges(result, fleetName, fleetPluginId, category) {
    const matches = this.eventSystemFleetChanges.filter(c => c.fleetName === fleetName);
    if (!matches.length) return;
    const key = fleetPluginId ?? '__unknown__';
    for (const c of matches) {
      if (!result[key]) result[key] = {};
      if (!result[key][category]) result[key][category] = new Set();
      const rateStr = c.action === 'add' && c.rate != null ? ` (rate ${c.rate})` : '';
      result[key][category].add(
        `${c.action === 'add' ? 'Adds' : 'Removes'} fleet in "${c.systemName}" via event "${c.eventName}"${rateStr}`
      );
    }
  }

  /**
   * NEW helper. For every mission name already recorded under a "Missions"
   * category, checks whether that mission is known to trigger an event
   * (missionEventTriggers) and, if so, records it under a separate
   * "TriggeredByMissionEvents" category — additive, doesn't change the
   * existing "Missions" Set's shape.
   */
  _mergeMissionEventTriggers(result, missionNamesByPlugin, category) {
    for (const [pluginId, missionNames] of missionNamesByPlugin) {
      for (const missionName of missionNames) {
        const triggers = this.missionEventTriggers.filter(
          t => t.missionName === missionName && t.pluginId === pluginId
        );
        if (!triggers.length) continue;
        const key = pluginId ?? '__unknown__';
        if (!result[key]) result[key] = {};
        if (!result[key][category]) result[key][category] = new Set();
        for (const t of triggers) {
          result[key][category].add(`"${missionName}" → event "${t.eventName}"`);
        }
      }
    }
  }

  /**
   * NEW helper. For every `person "X"` block that includes `shipName`
   * (scoped to `ownerPluginId`, same rule as every other exact-name match
   * in this file), records the person's name under a "Persons" category
   * and merges any system(s) that person is restricted to into "Systems"
   * — the same way a fleet's own spawn systems already get merged in.
   */
  _mergePersons(result, shipName, ownerPluginId) {
    for (const ref of this.personShips) {
      if (ref.shipName !== shipName) continue;
      if (ref.pluginId !== ownerPluginId) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Persons']) result[key]['Persons'] = new Set();
      result[key]['Persons'].add(ref.personName);

      const systems = this.personSystems.filter(
        s => s.personName === ref.personName && s.pluginId === ref.pluginId
      );
      if (systems.length) {
        if (!result[key]['Systems']) result[key]['Systems'] = new Set();
        for (const s of systems) result[key]['Systems'].add(s.systemName);
      }
    }
  }

  // ── Ship / variant location resolution ──────────────────────────────────────

  /**
   * Resolve all location data for a ship or variant.
   * Matches only on the exact shipName — no base-name fallback whatsoever.
   */
_resolveShipLocations(shipName, ownerPluginId) {
    const result = {};
    const fleetToSystems  = this._buildFleetToSystems();
    const yardToPlanets   = this._buildYardToPlanets();
    const planetToSystems = this._buildPlanetToSystems();

    // Track mission names found for this ship, per plugin, so
    // _mergeMissionEventTriggers can cross-reference them afterwards.
    const missionNamesByPlugin = new Map();
    const trackMission = (pluginId, missionName) => {
      const key = pluginId ?? '__unknown__';
      if (!missionNamesByPlugin.has(key)) missionNamesByPlugin.set(key, new Set());
      missionNamesByPlugin.get(key).add(missionName);
    };

    for (const fleet of this.fleets) {
      if (!fleet.shipNames.includes(shipName)) continue;
      if (fleet.pluginId !== ownerPluginId) continue;
      // Only take the Systems this SAME fleet (fleet.pluginId) spawns in —
      // not every plugin's same-named fleet. See _mergeOwnPluginOnly.
      this._mergeOwnPluginOnly(result, fleetToSystems.get(fleet.name), 'Systems', fleet.pluginId);
      // NEW: event-driven add/remove of this same fleet, anywhere.
      this._mergeEventFleetChanges(result, fleet.name, fleet.pluginId, 'EventFleetChanges');
    }

    for (const yard of this.shipyardEntries) {
      if (!yard.shipNames.includes(shipName)) continue;
      if (yard.pluginId !== ownerPluginId) continue;
      const planetsByPlugin = yardToPlanets.get(yard.yardName);
      if (!planetsByPlugin) continue;
      // Only take planets that reference THIS shipyard entry's own plugin —
      // not every plugin's same-named shipyard. See _mergeOwnPluginOnly.
      const key = yard.pluginId ?? '__unknown__';
      const planets = planetsByPlugin.get(key);
      if (!planets || !planets.size) continue;
      if (!result[key]) result[key] = {};
      if (!result[key]['Planets']) result[key]['Planets'] = new Set();
      for (const planet of planets) {
        result[key]['Planets'].add(planet);
        // Which system a planet sits in is a physical fact that may
        // legitimately be declared by a different plugin than the one
        // selling this ship (e.g. a mod adds a planet/shipyard to the
        // vanilla system "Sol") — so this lookup is intentionally left
        // unscoped, unlike the name-keyed fleet/yard/outfitter lookups.
        const sysMap = planetToSystems.get(planet);
        if (sysMap) this._mergeInto(result, sysMap, 'Systems', key);
      }
    }

    for (const ref of this.missionNpcShips) {
      if (ref.shipName !== shipName) continue;
      if (ref.pluginId !== ownerPluginId) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Missions']) result[key]['Missions'] = new Set();
      result[key]['Missions'].add(ref.missionName);
      trackMission(ref.pluginId, ref.missionName);
    }

    for (const ref of this.missionGiveShips) {
      if (ref.shipName !== shipName) continue;
      if (ref.pluginId !== ownerPluginId) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Missions']) result[key]['Missions'] = new Set();
      result[key]['Missions'].add(ref.missionName);
      trackMission(ref.pluginId, ref.missionName);
    }

    // NEW: for every mission already found above, note if it's known to
    // trigger an event.
    this._mergeMissionEventTriggers(result, missionNamesByPlugin, 'TriggeredByMissionEvents');

    // NEW: person "X" blocks that include this ship, plus any system(s)
    // that person is restricted to.
    this._mergePersons(result, shipName, ownerPluginId);

    return result;
}

  // ── Outfit location resolution ───────────────────────────────────────────────

  /**
   * Resolve all location data for an outfit.
   *
   * `ownerPluginId` is the plugin that OWNS this specific outfit (i.e. the
   * outfit object's own `_pluginId`). It is used to scope every ship-carrying
   * match to refs whose resolved outfit-pluginId matches this outfit — not
   * just any ref with a matching outfit NAME. Without this scoping, two
   * different plugins defining a same-named outfit (e.g. both have a
   * "Blaster") would leak each other's ships into the wrong outfit's
   * location data.
   */
  _resolveOutfitLocations(outfitName, ownerPluginId) {
    const result = {};
    const outfitterToPlanets = this._buildOutfitterToPlanets();
    const yardToPlanets      = this._buildYardToPlanets();
    const planetToSystems    = this._buildPlanetToSystems();
    const fleetToSystems     = this._buildFleetToSystems();

    const missionNamesByPlugin = new Map();
    const trackMission = (pluginId, missionName) => {
      const key = pluginId ?? '__unknown__';
      if (!missionNamesByPlugin.has(key)) missionNamesByPlugin.set(key, new Set());
      missionNamesByPlugin.get(key).add(missionName);
    };

    // ── 1. Outfitter listings → planets ─────────────────────────────────────
    // NOTE: intentionally NOT scoped to ownerPluginId — an outfitter block in
    // one plugin can legitimately sell an outfit defined in another plugin
    // (cross-plugin references by name are a normal pattern here). Scoping
    // this to ownerPluginId would hide legitimate cross-plugin listings.
    //
    // It IS however scoped to `entry.pluginId` (the specific outfitter block
    // that lists this outfit) rather than every plugin sharing that
    // outfitter's name — outfitter names ("Free Market", "General Store")
    // collide across plugins constantly, and two unrelated outfitters with
    // the same name are not the same shop.
    for (const entry of this.outfitterEntries) {
      if (!entry.outfitNames.includes(outfitName)) continue;

      const planetsByPlugin = outfitterToPlanets.get(entry.outfitterName);
      if (!planetsByPlugin) continue;

      const key = entry.pluginId ?? '__unknown__';
      const planets = planetsByPlugin.get(key);
      if (!planets || !planets.size) continue;

      if (!result[key]) result[key] = {};
      if (!result[key]['Planets']) result[key]['Planets'] = new Set();
      if (!result[key]['Outfitters']) result[key]['Outfitters'] = new Set();
      result[key]['Outfitters'].add(entry.outfitterName);
      for (const planet of planets) result[key]['Planets'].add(planet);
    }

    // ── 1b. NEW — event-driven outfitter add/remove for outfitters that
    //       list this outfit, tagged with the causing event.
    for (const entry of this.outfitterEntries) {
      if (!entry.outfitNames.includes(outfitName)) continue;
      const changes = this.eventPlanetOutfitterChanges.filter(
        c => c.outfitterName === entry.outfitterName && c.pluginId === entry.pluginId
      );
      if (!changes.length) continue;
      const key = entry.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['EventOutfitterChanges']) result[key]['EventOutfitterChanges'] = new Set();
      for (const c of changes) {
        result[key]['EventOutfitterChanges'].add(
          `${c.action === 'add' ? 'Adds to' : 'Removes from'} "${c.planetName}" via event "${c.eventName}"`
        );
      }
    }

    // ── 2. Ships that carry THIS outfit → shipyards → planets → systems ─────
    // Scoped to ownerPluginId so a same-named outfit from a different plugin
    // never contributes ships here.
    const shipsWithOutfit = new Set(
      this.shipOutfitRefs
        .filter(r => r.outfitName === outfitName && r.pluginId === ownerPluginId)
        .map(r => r.shipName)
    );

    for (const shipName of shipsWithOutfit) {
      // Record the ships themselves — re-filtered by ownerPluginId as well,
      // so a ship carrying two same-named-but-different-plugin outfits only
      // gets recorded under the outfit that actually matches. Filed under
      // the SHIP's own plugin (shipPluginId), not the outfit's plugin —
      // otherwise a ship from a different plugin than the outfit it
      // carries would get mislabeled under the outfit's plugin.
      for (const ref of this.shipOutfitRefs) {
        if (ref.outfitName !== outfitName) continue;
        if (ref.shipName !== shipName) continue;
        if (ref.pluginId !== ownerPluginId) continue;
        const key = ref.shipPluginId ?? '__unknown__';
        if (!result[key]) result[key] = {};
        if (!result[key]['Ships']) result[key]['Ships'] = new Set();
        result[key]['Ships'].add(shipName);
      }

      // Shipyard path for that ship → planets. Scoped to each shipyard
      // entry's own plugin — see the note on section 1 above; shipyard
      // names collide across plugins just as readily as outfitter names.
      for (const yard of this.shipyardEntries) {
        if (!yard.shipNames.includes(shipName)) continue;
        const planetsByPlugin = yardToPlanets.get(yard.yardName);
        if (!planetsByPlugin) continue;
        const key = yard.pluginId ?? '__unknown__';
        const planets = planetsByPlugin.get(key);
        if (!planets || !planets.size) continue;
        if (!result[key]) result[key] = {};
        if (!result[key]['ShipyardPlanets']) result[key]['ShipyardPlanets'] = new Set();
        for (const planet of planets) result[key]['ShipyardPlanets'].add(planet);
      }

      // Fleet path for that ship → systems. Scoped to each fleet entry's
      // own plugin, for the same reason (fleet names collide too).
      for (const fleet of this.fleets) {
        if (!fleet.shipNames.includes(shipName)) continue;
        this._mergeOwnPluginOnly(result, fleetToSystems.get(fleet.name), 'Systems', fleet.pluginId);
        // NEW: event-driven add/remove of that fleet.
        this._mergeEventFleetChanges(result, fleet.name, fleet.pluginId, 'EventFleetChanges');
      }
    }

    // ── 3. Mission "give outfit" references — scoped to ownerPluginId ───────
    for (const ref of this.missionGiveOutfits) {
      if (ref.outfitName !== outfitName) continue;
      if (ref.pluginId !== ownerPluginId) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Missions']) result[key]['Missions'] = new Set();
      result[key]['Missions'].add(ref.missionName);
      trackMission(ref.pluginId, ref.missionName);
    }

    // NEW: for every mission already found above, note if it's known to
    // trigger an event.
    this._mergeMissionEventTriggers(result, missionNamesByPlugin, 'TriggeredByMissionEvents');

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
      // Keep the full pluginId (sourceName/folderName) exactly as stored.
      // Only substitute __unknown__ entries with the pluginName fallback.
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
      const raw = this._resolveShipLocations(ship.name, ship._pluginId);
      ship.locations = this._finalise(raw, pluginName);
    }
    for (const variant of variants) {
      const raw = this._resolveShipLocations(variant.name, variant._variantPluginId);
      variant.locations = this._finalise(raw, pluginName);
    }
    for (const outfit of outfits) {
      const raw = this._resolveOutfitLocations(outfit.name, outfit._pluginId);
      outfit.locations = this._finalise(raw, pluginName);
    }
}
}

module.exports = LocationResolver;