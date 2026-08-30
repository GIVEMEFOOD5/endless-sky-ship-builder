'use strict';

// ── CHANGELOG (mission/event parsing pass) ──────────────────────────────────
//   - Extended: collectFleet(government, shipNames, pluginId, fleetName)
//     now ALSO stores the fleet's own NAME. Previously only LocationResolver
//     knew a fleet's name (for spawn-system lookups) and only this file knew
//     its government — with no single record holding both. That combined
//     record is what EndlessSkyParser.resolveEventGovernmentImpact() needs
//     to answer "which government does event X actually affect", so a named
//     `fleet "X"` reference inside an npc block can be resolved to both a
//     ship list AND a government in one step (see parser.js
//     resolveAllNpcFleetRefs()).
//   - Added: collectEventGovernmentAttitudeChange — records "event X changes
//     government G's attitude toward government H to value V" (from a
//     `government "G"` > `"attitude toward"` > `"H" V` sub-block inside an
//     event). Previously not tracked at all.
//   - Added: ship/variant/outfit objects now also get a `governmentEvents`
//     array (sibling to the existing `governments` object) listing any
//     event-driven attitude changes affecting a government that entity
//     belongs to. Empty array when there are none — doesn't change the
//     shape or meaning of the existing `governments` field.
//   - NEW (person-block pass): collectPerson — records that a `person "X"`
//     block (persons.txt-style unique/named ships) directly assigns a
//     government to one or more specific ship names. Unlike fleets/NPCs,
//     a person's government is authoritative on its own — it isn't looked
//     up via a shipyard/planet chain, it's stated right there in the block.
//     Feeds the SAME `npcRefs` list collectNpcRef already populates (so
//     _governmentsForShip resolves it with zero new lookup logic), plus a
//     dedicated `persons` array for traceability/debugging.
// ─────────────────────────────────────────────────────────────────────────

class SpeciesResolver {
  constructor() { this.reset(); }
  reset() {
    // { government, shipNames, pluginId, name }
    // `name` (the fleet's own name, e.g. "Marauder Raid") is optional and
    // may be null for callers that don't have/need it — only
    // resolveAllNpcFleetRefs()'s named-fleet-reference lookup and
    // resolveEventGovernmentImpact()'s join actually require it to be set.
    this.fleets           = [];
    this.npcRefs          = [];   // { government, shipName,  pluginId }
    this.shipyards        = {};   // name → [{ shipName, pluginId }]
    this.outfitters       = {};   // name → [{ outfitName, pluginId }]
    this.planets           = [];   // { name, government, shipyards, outfitters, pluginId }
    this.shipOutfits      = {};   // shipName → [{ outfitName, pluginId }]  (pluginId = owner of the SHIP)
    this.knownGovernments = new Set();

    // NEW — { eventName, government, towardGovernment, value, pluginId }
    this.eventGovernmentAttitudeChanges = [];

    // NEW — { personName, government, shipName, pluginId }
    // One entry per (person, ship) pair — a person block can name more
    // than one ship. Kept purely for traceability/debugging; the actual
    // government resolution for these ships happens via the matching
    // collectNpcRef() call made alongside every collectPerson() call (see
    // parser.js parsePersonBlock), so _governmentsForShip needs no changes.
    this.persons = [];
  }

  // ── Collectors (accept pluginId) ─────────────────────────────────────────────

  /**
   * `fleetName` is a new, optional 4th parameter (default null so every
   * existing call site that doesn't pass it keeps working unchanged). When
   * the caller has it (parser.js's parseFleetBlock always does now), it's
   * stored alongside government/shipNames so a fleet can later be looked
   * up by NAME and have both its government and ship list available in one
   * record — see the changelog note above.
   */
  /**
   * FIXED: previously `if (!government) return;` at the top silently
   * discarded the ENTIRE call whenever government was missing — which is
   * exactly what happens when a fleet is REOPENED (e.g. from inside an
   * event, via `add variant`) without restating its `government` line.
   * That's valid Endless Sky syntax (a reopening patches/extends the
   * existing fleet; it doesn't need to repeat every field) but meant every
   * ship added by such a reopening, and the reopening's contribution to
   * that fleet's government tagging, vanished entirely with no warning.
   *
   * Now: an entry is always recorded as long as there are ship names,
   * with `government: null` when unknown. resolveFleetGovernmentGaps()
   * (below) backfills those nulls afterwards by matching against another
   * entry sharing the same fleet name + plugin (or, failing that, the
   * same name in any plugin) that DOES have a government — same
   * plugin-priority pattern already used elsewhere in this file/parser.js.
   */
  collectFleet(government, shipNames, pluginId, fleetName = null) {
    if (!shipNames.length) return;
    if (government) this.knownGovernments.add(government);
    this.fleets.push({
      government: government ?? null,
      shipNames: [...shipNames],
      pluginId: pluginId ?? null,
      name: fleetName ?? null,
    });
  }

  collectNpcRef(government, shipName, pluginId) {
    if (!shipName) return;
    if (government) this.knownGovernments.add(government);
    this.npcRefs.push({ government: government ?? null, shipName, pluginId: pluginId ?? null });
  }

  collectShipyard(name, shipNames, pluginId) {
    if (!this.shipyards[name]) this.shipyards[name] = [];
    for (const shipName of shipNames)
      this.shipyards[name].push({ shipName, pluginId: pluginId ?? null });
  }

  collectOutfitter(name, outfitNames, pluginId) {
    if (!this.outfitters[name]) this.outfitters[name] = [];
    for (const outfitName of outfitNames)
      this.outfitters[name].push({ outfitName, pluginId: pluginId ?? null });
  }

  collectPlanet(name, government, shipyards, outfitters, pluginId) {
    if (government) this.knownGovernments.add(government);
    this.planets.push({ name, government, shipyards, outfitters, pluginId: pluginId ?? null });
  }

  /**
   * NEW. Records that an event changes one government's attitude toward
   * another. `value` is the raw attitude number as written in the data
   * file (typically -1 to 1, but stored as-is without clamping/validation
   * — this resolver doesn't interpret game balance, only records facts).
   */
  collectEventGovernmentAttitudeChange(eventName, government, towardGovernment, value, pluginId) {
    if (!eventName || !government || !towardGovernment) return;
    this.eventGovernmentAttitudeChanges.push({
      eventName,
      government,
      towardGovernment,
      value: value ?? null,
      pluginId: pluginId ?? null,
    });
  }

  /**
   * NEW. Records that a `person "X"` block assigns `government` directly
   * to `shipName`. Called once per ship in the person block (see parser.js
   * parsePersonBlock), alongside a matching collectNpcRef() call so the
   * existing _governmentsForShip() npcRefs scan picks it up with no
   * further changes needed here. This method only exists to keep a
   * separate, traceable record of which person block was responsible.
   */
  collectPerson(personName, government, shipName, pluginId) {
    if (!personName || !shipName) return;
    if (government) this.knownGovernments.add(government);
    this.persons.push({
      personName,
      government: government ?? null,
      shipName,
      pluginId: pluginId ?? null,
    });
  }

  /**
   * Record outfits installed on a ship or variant.
   *
   * speciesShipName  — always the base ship name, used for government chain
   *                    resolution (base ship → government → outfit government).
   * variantShipName  — the full variant name when called from a variant context,
   *                    or null for base ships. When provided, outfits are stored
   *                    under the variant's own name so government lookups for the
   *                    variant reflect only its own outfit load, not the base ship's.
   *
   * `pluginId` here is the plugin that owns the SHIP/variant carrying the
   * outfit (parser.js passes `this._currentPluginId`, which at collection
   * time is whichever plugin's ship block is currently being parsed) — NOT
   * the outfit's own plugin. This is what lets outfit→ship government
   * resolution scope correctly to the right copy of a same-named ship.
   */
  collectShipOutfits(speciesShipName, outfitNames, pluginId, variantShipName = null) {
    if (!outfitNames.length) return;
    const storeName = variantShipName ?? speciesShipName;
    if (!this.shipOutfits[storeName]) this.shipOutfits[storeName] = [];
    for (const outfitName of outfitNames)
      this.shipOutfits[storeName].push({ outfitName, pluginId: pluginId ?? null });
  }

  /**
   * NEW. Backfills `government: null` fleet entries created by a
   * government-less REOPENING of an existing fleet (see the changelog
   * note on collectFleet above). Must run AFTER every file/plugin has
   * been parsed — same reasoning as parser.js's resolveAllNpcFleetRefs:
   * a fleet's original, government-bearing definition may be parsed
   * before OR after a government-less reopening of the same name.
   */
  resolveFleetGovernmentGaps() {
    let resolved = 0, stillUnresolved = 0;
    for (const entry of this.fleets) {
      if (entry.government) continue;
      if (!entry.name) { stillUnresolved++; continue; }
      let source = this.fleets.find(f => f.name === entry.name && f.pluginId === entry.pluginId && f.government);
      if (!source) source = this.fleets.find(f => f.name === entry.name && f.government);
      if (source) {
        entry.government = source.government;
        this.knownGovernments.add(source.government);
        resolved++;
      } else {
        stillUnresolved++;
        console.warn(`    ⚠ Fleet "${entry.name}" (plugin ${entry.pluginId}) has ships but no government could be found in any of its definitions.`);
      }
    }
    console.log(`  Fleet government-gap resolution: ${resolved} resolved, ${stillUnresolved} unresolved`);
  }

  /**
   * NEW. The planet-side counterpart to resolveFleetGovernmentGaps() above,
   * for the exact same reason: a planet reopened from inside an event
   * (e.g. `event "X" > planet "Y" > add shipyard "Z"`) creates its OWN
   * planet record — each call to parsePlanetBlock starts a fresh, empty
   * `shipyards`/`government` — and that reopening almost never restates
   * the planet's `government` line, since all it's doing is adding a
   * shipyard/outfitter.
   *
   * `_governmentsForShip`'s shipyard → planet → government chain requires
   * the matching shipyard name AND a non-null government to be present on
   * the SAME planet record. Without this backfill, a ship added to a
   * shipyard purely via an event's `add shipyard` line would never
   * resolve to a government at all — the record with the shipyard has
   * `government: null`, and the record with the government doesn't list
   * the newly-added shipyard.
   *
   * This backfills `government: null` planet records by copying the
   * government from another record sharing the same planet name (+ same
   * plugin, preferred; falling back to any plugin) that DOES have one —
   * same plugin-priority pattern as resolveFleetGovernmentGaps and
   * resolveAllNpcFleetRefs. Must run AFTER every file/plugin has been
   * parsed, for the same reason: a planet's original, government-bearing
   * definition may be parsed before OR after an event that reopens it.
   */
  resolvePlanetGovernmentGaps() {
    let resolved = 0, stillUnresolved = 0;
    for (const entry of this.planets) {
      if (entry.government) continue;
      let source = this.planets.find(p => p.name === entry.name && p.pluginId === entry.pluginId && p.government);
      if (!source) source = this.planets.find(p => p.name === entry.name && p.government);
      if (source) {
        entry.government = source.government;
        this.knownGovernments.add(source.government);
        resolved++;
      } else {
        stillUnresolved++;
        console.warn(`    ⚠ Planet "${entry.name}" (plugin ${entry.pluginId}) has shipyards/outfitters listed but no government could be found in any of its definitions.`);
      }
    }
    console.log(`  Planet government-gap resolution: ${resolved} resolved, ${stillUnresolved} unresolved`);
  }

  // ── Internal lookups ─────────────────────────────────────────────────────────
  // Each returns a Map<pluginId, Set<government>>.

  /**
   * Resolve the governments associated with a ship (or variant) by name.
   *
   * `ownerPluginId`, when provided, restricts fleet/NPC/shipyard matches to
   * data declared by that same plugin. This matters because ship names
   * collide across independently-authored plugins far more often than one
   * might expect ("Shuttle", "Fighter", "Freighter", etc. are common reuse
   * targets for reskins/rebalances) — without this scoping, an unrelated
   * plugin's fleet that happens to use the same ship name would incorrectly
   * tag this ship with that plugin's government.
   *
   * Pass `null` (the default) to search across all plugins — used
   * deliberately for the variant→base-ship fallback, where the base ship is
   * very often defined by a *different* plugin (e.g. vanilla) than the one
   * that added the variant.
   */
  _governmentsForShip(shipName, ownerPluginId = null) {
    const result = new Map();

    const add = (pluginId, government) => {
      const key = pluginId ?? '__unknown__';
      if (!result.has(key)) result.set(key, new Set());
      result.get(key).add(government);
    };

    // Strip variant suffix: "Carrier (Alpha)" → "Carrier"
    const baseName = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();

    // Fleet listings: exact name only, scoped to ownerPluginId when known.
    for (const fleet of this.fleets) {
      if (!fleet.shipNames.includes(shipName)) continue;
      if (ownerPluginId != null && fleet.pluginId !== ownerPluginId) continue;
      add(fleet.pluginId, fleet.government);
    }

    // NPC refs: match exact name OR base name, same scoping rule.
    // (This is also where `person` block government assignments resolve —
    // parser.js's parsePersonBlock feeds them into npcRefs via
    // collectNpcRef() so they're picked up by this exact same loop.)
    for (const ref of this.npcRefs) {
      if (!ref.government) continue;
      if (ref.shipName !== shipName && ref.shipName !== baseName) continue;
      if (ownerPluginId != null && ref.pluginId !== ownerPluginId) continue;
      add(ref.pluginId, ref.government);
    }

    // Shipyard → planet → government chain: exact ship name only.
    //
    // A shipyard "sells" this ship only if the shipyard-entry (this plugin's
    // `shipyard "X"` block listing the ship) and the planet's reference to
    // that same-named shipyard both come from the SAME plugin. Without this
    // check, two unrelated plugins that each happen to define a shipyard
    // called e.g. "Independent Shipyard" (shipyards/outfitters are keyed
    // globally by name here) would leak each other's ships/governments —
    // Plugin B's planet would appear to "sell" Plugin A's ship.
    for (const [yard, entries] of Object.entries(this.shipyards)) {
      const matchingEntries = entries.filter(e => e.shipName === shipName);
      if (!matchingEntries.length) continue;
      for (const planet of this.planets) {
        if (!planet.shipyards.includes(yard) || !planet.government) continue;
        for (const e of matchingEntries) {
          if ((e.pluginId ?? null) !== (planet.pluginId ?? null)) continue;
          if (ownerPluginId != null && e.pluginId !== ownerPluginId) continue;
          add(planet.pluginId, planet.government);
        }
      }
    }

    return result;
  }

  _governmentsForOutfit(outfitName) {
    const result = new Map();

    const add = (pluginId, government) => {
      const key = pluginId ?? '__unknown__';
      if (!result.has(key)) result.set(key, new Set());
      result.get(key).add(government);
    };

    // Outfitter → planet → government chain.
    // Same same-plugin requirement as the shipyard chain above, and for the
    // same reason: outfitter names ("Free Market", "General Store", ...)
    // collide across plugins constantly.
    for (const [outfitter, entries] of Object.entries(this.outfitters)) {
      const matchingEntries = entries.filter(e => e.outfitName === outfitName);
      if (!matchingEntries.length) continue;
      for (const planet of this.planets) {
        if (!planet.outfitters.includes(outfitter) || !planet.government) continue;
        for (const e of matchingEntries) {
          if ((e.pluginId ?? null) !== (planet.pluginId ?? null)) continue;
          add(planet.pluginId, planet.government);
        }
      }
    }

    // Ship outfit → ship government chain.
    // shipOutfits may be keyed by either a base ship name or a variant name.
    // Each entry records which plugin owns the *ship* carrying the outfit
    // (see collectShipOutfits), so we scope each lookup to that specific
    // plugin rather than searching all plugins for a same-named ship.
    for (const [shipName, entries] of Object.entries(this.shipOutfits)) {
      const matchingEntries = entries.filter(e => e.outfitName === outfitName);
      if (!matchingEntries.length) continue;

      const shipOwnerPluginIds = new Set(matchingEntries.map(e => e.pluginId ?? null));
      for (const shipOwnerPluginId of shipOwnerPluginIds) {
        for (const [pluginId, govts] of this._governmentsForShip(shipName, shipOwnerPluginId)) {
          for (const g of govts) {
            const effectivePlugin = pluginId !== '__unknown__'
              ? pluginId
              : (shipOwnerPluginId ?? null);
            add(effectivePlugin, g);
          }
        }
      }
    }

    this._filterToKnownGovernments(result);
    return result;
  }

  /**
   * Drop any government name that was never actually declared anywhere
   * (e.g. via a `fleet`, `npc`, `person`, or `planet` block) — guards
   * against typos or partial-data artifacts surviving into the output.
   * Mutates and returns `byPlugin` in place.
   */
  _filterToKnownGovernments(byPlugin) {
    for (const [pluginId, govts] of byPlugin) {
      for (const g of govts)
        if (!this.knownGovernments.has(g))
          govts.delete(g);
      if (!govts.size) byPlugin.delete(pluginId);
    }
    return byPlugin;
  }

  /**
   * NEW. Given a flat set of government names (e.g. the ones already
   * resolved for a ship/variant/outfit), returns a sorted array of
   * human-readable strings describing any event-driven attitude change
   * that involves one of those governments — as either the government
   * whose attitude changes, or the government it's changing an attitude
   * toward. Returns [] if there are none.
   */
  _eventChangesForGovernments(governmentNames) {
    if (!governmentNames || governmentNames.size === 0) return [];
    const lines = new Set();
    for (const c of this.eventGovernmentAttitudeChanges) {
      if (!governmentNames.has(c.government) && !governmentNames.has(c.towardGovernment)) continue;
      lines.add(
        `Event "${c.eventName}": ${c.government} attitude toward ${c.towardGovernment} → ${c.value}`
      );
    }
    return [...lines].sort();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Attach government data to ships, variants, and outfits.
   *
   * Output shape — ship.governments:
   * {
   *   "Plugin A": { "Human": true },
   *   "Plugin B": { "Hai": true, "Republic": true }
   * }
   *
   * NEW — ship.governmentEvents (sibling field, always an array, [] when
   * there are no matches):
   * [
   *   "Event \"Free Worlds Reveal\": Free Worlds attitude toward Republic → -0.3"
   * ]
   *
   * pluginName is the last-resort fallback when no government can be determined.
   */
  attachSpecies(ships, variants, outfits, pluginName) {
    const toObj = (byPlugin) => {
      if (byPlugin.size === 0) {
        if (!pluginName) return {};
        return { [pluginName]: { [pluginName]: true } };
      }
      const obj = {};
      for (const [pluginId, govts] of byPlugin) {
        const key = pluginId === '__unknown__' ? (pluginName ?? '__unknown__') : pluginId;
        if (!obj[key]) obj[key] = {};
        for (const g of govts) obj[key][g] = true;
      }
      return obj;
    };

    // NEW: flatten every government name across all plugins in a byPlugin
    // map into one Set, for the event-change lookup (event attitude
    // changes aren't plugin-scoped the way ship/outfit ownership is — an
    // event in any plugin can affect a government however it's declared).
    const flattenGovs = (byPlugin) => {
      const flat = new Set();
      for (const govts of byPlugin.values()) for (const g of govts) flat.add(g);
      return flat;
    };

    for (const ship of ships) {
      const byPlugin = this._governmentsForShip(ship.name, ship._pluginId ?? null);
      this._filterToKnownGovernments(byPlugin);
      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      ship.governments = toObj(byPlugin);
      ship.governmentEvents = this._eventChangesForGovernments(flattenGovs(byPlugin));
    }

    for (const variant of variants) {
      // Full variant name first, scoped to the variant's own plugin (a
      // fleet/NPC referencing a specific variant name is virtually always
      // declared by the same plugin that defines the variant).
      let byPlugin = this._governmentsForShip(variant.name, variant._variantPluginId ?? null);
      this._filterToKnownGovernments(byPlugin);

      // Fall back to the base ship's government, deliberately UNSCOPED —
      // the base ship is very often defined by a different plugin (e.g. a
      // vanilla ship reskinned by a mod), so restricting this search to the
      // variant's own plugin would make the fallback never find anything.
      if (byPlugin.size === 0) {
        byPlugin = this._governmentsForShip(variant.baseShip ?? variant.name, null);
        this._filterToKnownGovernments(byPlugin);
      }

      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      variant.governments = toObj(byPlugin);
      variant.governmentEvents = this._eventChangesForGovernments(flattenGovs(byPlugin));
    }

    for (const outfit of outfits) {
      const byPlugin = this._governmentsForOutfit(outfit.name);
      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      outfit.governments = toObj(byPlugin);
      outfit.governmentEvents = this._eventChangesForGovernments(flattenGovs(byPlugin));
    }
  }
}
module.exports = SpeciesResolver;