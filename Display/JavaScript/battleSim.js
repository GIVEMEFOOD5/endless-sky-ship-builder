;(function () {
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const FPS          = 60;
const MAX_SIM_SECS = 600;
const MAX_FRAMES   = MAX_SIM_SECS * FPS;
const SOLAR_POWER  = 1.0;

const REPO_URL = 'GIVEMEFOOD5/endless-sky-ship-builder';
const BASE_URL = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;

// ── Module state ──────────────────────────────────────────────────────────────
let _allShips    = [];
let _outfitIndex = {};
let _attrDefs    = null;

// Derived from attrDefs at init time — zero hardcoding
let _damageTypes    = [];   // e.g. ['Shield','Hull','Heat','Energy',...]
let _statusDecayMap = {};   // statName → resistKey, e.g. ionization → 'ion resistance'
let _statusDescriptors = [];// full descriptor objects
let _weaponDataKeys = new Set(); // all valid weapon attribute keys

const _slots = { A: null, B: null };

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
    await loadData();
}

async function loadData() {
    setStatus('Loading plugin data…');
    try {
        const res = await fetch(`${BASE_URL}/attributeDefinitions.json`);
        if (res.ok) {
            _attrDefs = await res.json();

            // ── Derive all runtime lookup tables from attrDefs (zero hardcoding) ──

            // Damage types from attrDefs.weapon.damageTypes
            _damageTypes = (_attrDefs?.weapon?.damageTypes) || [];

            // Status effect decay map from attrDefs.weapon.statusEffectDecay
            const sed = _attrDefs?.weapon?.statusEffectDecay;
            if (sed) {
                _statusDecayMap    = sed.decayMap    || {};
                _statusDescriptors = sed.descriptors || [];
            }

            // Weapon data keys — used to filter outfit attributes correctly
            const wdKeys = _attrDefs?.weapon?.dataFileKeys || [];
            _weaponDataKeys = new Set(wdKeys);

            if (typeof initComputedStats === 'function')
                initComputedStats(_attrDefs, BASE_URL);
        }
    } catch (e) {
        console.warn('Failed to load attributeDefinitions.json', e);
    }

    let dataIndex;
    try {
        const res = await fetch(`${BASE_URL}/index.json`);
        if (!res.ok) throw new Error('Could not fetch index.json');
        dataIndex = await res.json();
    } catch (err) {
        setStatus(`Error: ${err.message}`, true);
        return;
    }

    window._indexPluginOrder = [];
    for (const pluginList of Object.values(dataIndex)) {
        for (const { outputName } of pluginList)
            window._indexPluginOrder.push(outputName);
    }

    window.allData = {};
    for (const [sourceName, pluginList] of Object.entries(dataIndex)) {
        for (const { outputName, displayName } of pluginList) {
            const pluginData = {
                sourceName, displayName, outputName,
                ships: [], variants: [], outfits: [], effects: []
            };
            try {
                const [shipsRes, variantsRes, outfitsRes] = await Promise.all([
                    fetch(`${BASE_URL}/${outputName}/dataFiles/ships.json`),
                    fetch(`${BASE_URL}/${outputName}/dataFiles/variants.json`),
                    fetch(`${BASE_URL}/${outputName}/dataFiles/outfits.json`),
                ]);
                let loaded = false;
                if (shipsRes.ok)    { pluginData.ships    = await shipsRes.json();    loaded = true; }
                if (variantsRes.ok) { pluginData.variants = await variantsRes.json(); loaded = true; }
                if (outfitsRes.ok)  { pluginData.outfits  = await outfitsRes.json();  loaded = true; }
                if (loaded) window.allData[outputName] = pluginData;
            } catch (err) {
                console.warn(`Failed loading plugin ${outputName}:`, err);
            }
        }
    }

    if (!Object.keys(window.allData).length) {
        setStatus('Error: no plugin data could be loaded.', true);
        return;
    }

    setStatus('');
    window._renderCardsFromManager = async () => { await onPluginsChanged(); };
    await PluginManager.initDefaultPlugin();
}

function setStatus(msg, isError = false) {
    const el = document.getElementById('simStatus');
    if (!el) return;
    el.textContent   = msg;
    el.style.color   = isError ? 'var(--c-danger-text)' : 'var(--c-text-muted)';
    el.style.display = msg ? 'block' : 'none';
}

async function onPluginsChanged() {
    _allShips    = [];
    _outfitIndex = {};

    const activePlugins = PluginManager.getActivePlugins();
    const allData       = window.allData || {};
    const indexOrder    = window._indexPluginOrder || [];

    const searchOrder = [
        ...activePlugins,
        ...indexOrder.filter(id => !activePlugins.includes(id) && allData[id]),
        ...Object.keys(allData).filter(id => !activePlugins.includes(id) && !indexOrder.includes(id)),
    ];
    for (const pid of searchOrder) {
        const d = allData[pid];
        if (!d) continue;
        for (const outfit of (d.outfits || [])) {
            if (outfit.name && !_outfitIndex[outfit.name])
                _outfitIndex[outfit.name] = { ...outfit, _pluginId: pid };
        }
    }

    for (const pid of activePlugins) {
        const d = allData[pid];
        if (!d) continue;
        for (const ship of [...(d.ships || []), ...(d.variants || [])])
            _allShips.push({ ...ship, _pluginId: pid });
    }

    const primaryPlugin = activePlugins[0] || null;
    if (primaryPlugin) {
        if (typeof window.setCurrentPlugin  === 'function') window.setCurrentPlugin(primaryPlugin);
        if (typeof window.initImageIndex    === 'function') await window.initImageIndex(primaryPlugin);
    }

    document.getElementById('simPanel').style.display = 'block';
    updateFightButton();
}

// ── Ship search UI ────────────────────────────────────────────────────────────

let _blurTimers = { A: null, B: null };

function searchShips(slot, query) {
    const lq = (query || '').toLowerCase().trim();
    const dd = document.getElementById('dropdown' + slot);
    dd.innerHTML = '';
    const hits = lq.length < 1
        ? _allShips.slice(0, 80)
        : _allShips.filter(s => s.name?.toLowerCase().includes(lq)).slice(0, 80);
    if (!hits.length) {
        dd.innerHTML = '<div class="ship-dropdown-empty">No ships found</div>';
    } else {
        for (const ship of hits) {
            const row       = document.createElement('div');
            row.className   = 'ship-dropdown-item';
            const pluginLabel = (window.allData?.[ship._pluginId]?.sourceName || ship._pluginId) || '';
            row.innerHTML   = `<span>${escHtml(ship.name)}</span><span class="sdi-plugin">${escHtml(pluginLabel)}</span>`;
            row.onmousedown = () => selectShip(slot, ship);
            dd.appendChild(row);
        }
    }
    dd.classList.add('open');
}

function openDropdown(slot) {
    clearTimeout(_blurTimers[slot]);
    searchShips(slot, document.getElementById('search' + slot).value);
}

function blurDropdown(slot) {
    _blurTimers[slot] = setTimeout(() => {
        document.getElementById('dropdown' + slot).classList.remove('open');
    }, 180);
}

async function selectShip(slot, ship) {
    document.getElementById('dropdown' + slot).classList.remove('open');
    document.getElementById('search' + slot).value = ship.name;
    const resolved = resolveShipStats(ship);
    _slots[slot] = resolved;
    await renderSlotPreview(slot, ship, resolved);
    updateFightButton();
    hideResults();
}

function clearSlot(slot) {
    _slots[slot] = null;
    document.getElementById('search' + slot).value = '';
    const selEl  = document.getElementById('selected' + slot);
    const statEl = document.getElementById('stats'    + slot);
    const slotEl = document.getElementById('slot'     + slot);
    if (selEl)  selEl.classList.remove('visible');
    if (statEl) statEl.style.display = 'none';
    if (slotEl) slotEl.classList.remove('has-ship');
    if (typeof window.clearSpriteCache === 'function') window.clearSpriteCache();
    updateFightButton();
    hideResults();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ATTRIBUTE HELPERS  —  zero hardcoded attribute names
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get stacking rule for an attribute from attrDefs.
 * Returns 'additive' | 'maximum' | 'minimum'
 */
function getStacking(key) {
    return (_attrDefs?.attributes?.[key]?.stacking) || 'additive';
}

/**
 * Return the list of protection attribute keys from attrDefs.
 * These are all attributes whose key ends in 'protection' and are
 * registered in attrDefs.attributes.
 */
function getProtectionKeys() {
    if (!_attrDefs?.attributes) return [];
    return Object.keys(_attrDefs.attributes).filter(k => k.endsWith(' protection'));
}

/**
 * Return the list of resistance attribute keys (e.g. 'ion resistance').
 * These are distinct from protection — they control per-frame decay speed.
 */
function getResistanceKeys() {
    if (!_attrDefs?.attributes) return [];
    return Object.keys(_attrDefs.attributes).filter(k => k.endsWith(' resistance') && !k.endsWith(' energy') && !k.endsWith(' fuel') && !k.endsWith(' heat'));
}

/**
 * Build the damage key for a damage type.
 * attrDefs.weapon.damageTypes contains e.g. 'Shield' → key = 'shield damage'
 */
function dmgKey(typeName) {
    return typeName.toLowerCase() + ' damage';
}

/**
 * Build the protection key for a damage type.
 * e.g. 'Shield' → 'shield protection', 'Hull' → 'hull protection'
 */
function protKey(typeName) {
    return typeName.toLowerCase() + ' protection';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STAT RESOLUTION  —  all formulas derived from attrDefs, zero hardcoding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the complete stat block for a ship.
 * All formula constants come from attrDefs.shipFunctions formulas.
 *
 * Key functions mapped from Ship.cpp via attrDefs:
 *   MaxShields         = [shields] * (1 + [shield multiplier])
 *   MaxHull            = [hull] * (1 + [hull multiplier])
 *   MinimumHull        = [absolute threshold] if > 0,
 *                        else max(0, floor([threshold percentage]*MaxHull + [hull threshold]))
 *   CoolingEfficiency  = 2 + 2/(1+exp(x/-2)) - 4/(1+exp(x/-4))  where x=[cooling inefficiency]
 *   MaximumHeat        = 100 * ([mass] + [heat capacity])
 *   HeatDissipation    = 0.001 * [heat dissipation]              (per-frame fraction)
 *   InertialMass       = Mass() / (1 + [inertia reduction])
 *   Drag               = min([drag]/(1+[drag reduction]), InertialMass)
 *
 * All of these match the formulas stored in attrDefs.shipFunctions[fnName].formulas[].formula
 */
function resolveShipStats(ship) {
    const baseAttrs = ship.attributes || {};
    const outfitMap = ship.outfitMap  || {};
    const attrDefs  = (_attrDefs?.attributes) || {};

    // ── Step 1: accumulate outfit attributes ───────────────────────────────
    const combined = { ...baseAttrs };
    const weapons  = [];
    const outfitContributions = {};

    for (const [outfitName, qty] of Object.entries(outfitMap)) {
        const outfit = _outfitIndex[outfitName];
        if (!outfit) continue;

        if (outfit.weapon) {
            for (let i = 0; i < qty; i++)
                weapons.push({ _name: outfitName, ...outfit.weapon });
        }

        const outfitAttrs = (outfit.attributes && Object.keys(outfit.attributes).length)
            ? outfit.attributes : outfit;

        for (const [key, rawVal] of Object.entries(outfitAttrs)) {
            if (typeof rawVal !== 'number' || key.startsWith('_')) continue;
            const stacking = getStacking(key);
            const contrib  = rawVal * qty;
            switch (stacking) {
                case 'maximum': combined[key] = Math.max(combined[key] ?? -Infinity, contrib); break;
                case 'minimum': combined[key] = Math.min(combined[key] ??  Infinity, contrib); break;
                default:        combined[key] = (combined[key] || 0) + contrib;
            }
            if (rawVal !== 0) {
                if (!outfitContributions[key]) outfitContributions[key] = { total: 0, sources: [] };
                outfitContributions[key].total += contrib;
                outfitContributions[key].sources.push({ name: outfitName, qty, perUnit: rawVal });
            }
        }
    }

    // ── Step 2: apply Ship.cpp formulas (derived from attrDefs.shipFunctions) ─

    const a = k => combined[k] || 0;

    // InertialMass  = Mass / (1 + [inertia reduction])
    // attrDefs.shipFunctions.InertialMass.formulas[0].formula
    const rawMass      = a('mass');
    const inertiaRed   = a('inertia reduction');
    const inertialMass = rawMass / (1 + inertiaRed);

    // Drag = min([drag]/(1+[drag reduction]), InertialMass)
    // attrDefs.shipFunctions.Drag.formulas
    const dragEff = (a('drag')) / (1 + a('drag reduction'));
    const drag    = Math.min(dragEff, inertialMass);

    // MaxShields = [shields] * (1 + [shield multiplier])
    const maxShields = a('shields') * (1 + a('shield multiplier'));

    // MaxHull = [hull] * (1 + [hull multiplier])
    const maxHull    = a('hull')    * (1 + a('hull multiplier'));

    // MinimumHull — attrDefs.shipFunctions.MinimumHull.formulas
    let minHull;
    const absThresh = a('absolute threshold');
    if (absThresh > 0) {
        minHull = absThresh;
    } else {
        minHull = Math.max(0, Math.floor(a('threshold percentage') * maxHull + a('hull threshold')));
    }
    const hullToDisable = Math.max(0, maxHull - minHull);

    // CoolingEfficiency — attrDefs.shipFunctions.CoolingEfficiency.formulas[0].formula
    // 2 + 2/(1+exp(x/-2)) - 4/(1+exp(x/-4))
    const x       = a('cooling inefficiency');
    const coolEff = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));

    // MaximumHeat = 100 * (mass + [heat capacity])
    // attrDefs.shipFunctions.MaximumHeat.formulas[0].formula: MAXIMUM_TEMPERATURE * ([mass] + [heat capacity])
    // MAXIMUM_TEMPERATURE = 100 in Ship.cpp
    const maxHeat = 100 * (rawMass + a('heat capacity'));

    // HeatDissipation = 0.001 * [heat dissipation]  (per-frame fraction)
    // attrDefs.shipFunctions.HeatDissipation.formulas[0].formula: .001 * [heat dissipation]
    const heatDissipFrac = 0.001 * a('heat dissipation');

    // Cooling per frame (active + passive, efficiency-adjusted)
    const coolingPerFrame = coolEff * (a('cooling') + a('active cooling'));
    const coolingPerSec   = coolingPerFrame * FPS;

    // Shield/hull regen — from attrDefs.shipFunctions.DoGeneration
    // shieldRegen = [shield generation] * (1 + [shield generation multiplier])
    const shieldRegenPerFrame       = a('shield generation')        * (1 + a('shield generation multiplier'));
    const delayedShieldPerFrame     = a('delayed shield generation') * (1 + a('shield generation multiplier'));
    const hullRepairPerFrame        = a('hull repair rate')         * (1 + a('hull repair multiplier'));
    const delayedHullPerFrame       = a('delayed hull repair rate') * (1 + a('hull repair multiplier'));

    // Delays (stored in frames in data)
    const shieldDelay   = a('shield delay');
    const repairDelay   = a('repair delay');
    const depletedDelay = a('depleted shield delay');

    // ── Protection attributes (all end in ' protection') ────────────────────
    // Derived from attrDefs.attributes — no hardcoding.
    // Each protection attr reduces incoming damage of its type by (1 - protection).
    const protections = {};
    for (const key of getProtectionKeys()) {
        protections[key] = Math.max(0, Math.min(1, a(key)));
    }
    // Convenience aliases used in simulation (mapped from protection keys)
    const shieldProt    = protections['shield protection']    || 0;
    const hullProt      = protections['hull protection']      || 0;
    const energyProt    = protections['energy protection']    || 0;
    const heatProt      = protections['heat protection']      || 0;
    const fuelProt      = protections['fuel protection']      || 0;
    const piercingRes   = Math.max(0, Math.min(1, a('piercing resistance')));

    // ── Status resistances (per-frame decay, from attrDefs.weapon.statusEffectDecay.decayMap) ─
    const statusResist = {};
    for (const [statName, resistKey] of Object.entries(_statusDecayMap)) {
        statusResist[statName] = a(resistKey);
    }

    // ── Energy ───────────────────────────────────────────────────────────────
    const energyCap             = a('energy capacity');
    const energyGenPerFrame     = a('energy generation') + a('solar collection') * SOLAR_POWER + a('fuel energy');
    const energyConsumeIdlePerFrame = a('energy consumption');
    // movingEnergyPerFrame from attrDefs.shipDisplay.intermediateVars.movingEnergyPerFrame
    // = max([thrusting energy], [reverse thrusting energy]) + [turning energy]
    const movingEnergyPerFrame  = Math.max(a('thrusting energy'), a('reverse thrusting energy')) + a('turning energy');
    const coolingEnergyPerFrame = a('cooling energy');

    // ── Heat generation ───────────────────────────────────────────────────────
    const heatGenIdlePerFrame   = a('heat generation');
    // movingHeatPerFrame from attrDefs.shipDisplay.intermediateVars:
    // = max([thrusting heat], [reverse thrusting heat])
    const movingHeatPerFrame    = Math.max(a('thrusting heat'), a('reverse thrusting heat')) + a('turning heat');

    // ── Navigation ────────────────────────────────────────────────────────────
    // MaxVelocity = ([thrust] or [afterburner thrust]) / Drag()
    const thrustForVel = a('thrust') || a('afterburner thrust');
    const maxVelocity  = drag > 0 ? thrustForVel / drag : 0;
    // Acceleration = thrust / InertialMass * (1 + [acceleration multiplier])
    const acceleration = inertialMass > 0
        ? (a('thrust') / inertialMass) * (1 + a('acceleration multiplier'))
        : 0;

    // ── Weapon analysis ───────────────────────────────────────────────────────
    const weaponSummary = analyzeWeapons(weapons, combined);

    return {
        name:      ship.name,
        pluginId:  ship._pluginId,
        rawShip:   ship,
        combined,
        weapons,
        outfitContributions,
        protections,      // full map for simulation use

        // HP
        maxShields, maxHull, minHull, hullToDisable,

        // Regen per-frame
        shieldRegenPerFrame, delayedShieldPerFrame,
        hullRepairPerFrame,  delayedHullPerFrame,
        shieldRegenPerSec:   (shieldRegenPerFrame + delayedShieldPerFrame) * FPS,
        hullRepairPerSec:    (hullRepairPerFrame  + delayedHullPerFrame)  * FPS,

        // Delays
        shieldDelay, repairDelay, depletedDelay,

        // Protection (convenience aliases)
        shieldProt, hullProt, energyProt, heatProt, fuelProt, piercingRes,

        // Status resistances per-frame (keyed by stat name, e.g. 'ionization')
        statusResist,

        // Energy
        energyCap, energyGenPerFrame, energyConsumeIdlePerFrame,
        movingEnergyPerFrame, coolingEnergyPerFrame,

        // Heat
        maxHeat, heatDissipFrac, coolingPerFrame, coolingPerSec,
        heatGenIdlePerFrame, movingHeatPerFrame,

        // Mass / nav
        rawMass, inertialMass, drag,
        maxVelocity: maxVelocity * FPS,
        acceleration: acceleration * FPS * FPS,

        // Weapon summary (spread in)
        ...weaponSummary,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WEAPON ANALYSIS  —  damage types from attrDefs, zero hardcoding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Recursively resolve submunition damage for a weapon.
 * Damage types come from _damageTypes (derived from attrDefs at init).
 */
function resolveSubmunitionDamage(weapon, multiplier, visited, depth) {
    if (depth > 8) return {};
    const totals = {};
    for (const typeName of _damageTypes) {
        const key = dmgKey(typeName);
        const val = weapon[key] || 0;
        if (val) totals[typeName] = (totals[typeName] || 0) + val * multiplier;
    }
    const subs = weapon.submunition;
    if (!subs) return totals;
    for (const entry of (Array.isArray(subs) ? subs : [subs])) {
        const subName  = typeof entry === 'string' ? entry : (entry?.name ?? String(entry));
        const subCount = typeof entry === 'object' ? (entry?.count ?? 1) : 1;
        if (!subName || visited.has(subName)) continue;
        visited.add(subName);
        const subOutfit = _outfitIndex[subName];
        if (!subOutfit?.weapon) continue;
        const subDmg = resolveSubmunitionDamage(subOutfit.weapon, multiplier * subCount, visited, depth + 1);
        for (const [t, v] of Object.entries(subDmg)) totals[t] = (totals[t] || 0) + v;
    }
    return totals;
}

/**
 * Analyse every weapon.  Damage type aggregation uses _damageTypes from attrDefs.
 * Firing cost keys are taken from attrDefs.outfitDisplay.valueNames filtered to
 * keys starting with 'firing '.
 */
function analyzeWeapons(weapons, shipAttrs) {
    // All firing cost keys derived from attrDefs — no hardcoding
    const firingCostKeys = (_attrDefs?.outfitDisplay?.valueNames || [])
        .map(v => v.key)
        .filter(k => k.startsWith('firing '));

    // Initialize aggregates
    const totalDPS    = {};
    const totalFiring = {};
    for (const t of _damageTypes) totalDPS[t] = 0;
    for (const k of firingCostKeys) totalFiring[k] = 0;

    const details = [];

    for (const w of weapons) {
        const reload      = Math.max(1, w.reload || 1);
        const burstCount  = w['burst count']  || 1;
        const burstReload = w['burst reload'] || reload;
        const framesPerCycle = (burstCount - 1) * burstReload + reload;
        const sps = (burstCount / framesPerCycle) * FPS;

        const piercing = Math.max(0, Math.min(1, w.piercing || 0));
        const range    = w.velocity && w.lifetime ? w.velocity * w.lifetime : null;

        // Per-shot damage — includes submunition damage
        const visited  = new Set([w._name].filter(Boolean));
        const dmgPerShot = resolveSubmunitionDamage(w, 1, visited, 0);
        for (const t of _damageTypes) {
            if (dmgPerShot[t] === undefined) dmgPerShot[t] = 0;
        }

        // DPS contribution
        for (const t of _damageTypes) {
            totalDPS[t] = (totalDPS[t] || 0) + dmgPerShot[t] * sps;
        }

        // Firing costs per second (all firing* keys from attrDefs)
        for (const k of firingCostKeys) {
            totalFiring[k] = (totalFiring[k] || 0) + (w[k] || 0) * sps;
        }

        // Relative damage (% of current stat)
        const relShield = w['% shield damage'] || 0;
        const relHull   = w['% hull damage']   || 0;

        // Per-weapon detail object — damage fields keyed by type name
        const detail = {
            name:        w._name || 'Unknown',
            reload, burstCount, burstReload, sps: +sps.toFixed(3),
            piercing:    +(piercing * 100).toFixed(0),
            range,
            homing:      (w.homing || 0) > 0,
            antiMissile: (w['anti-missile'] || 0) > 0,
            hasSubmunitions: !!(w.submunition),
            dmgPerShot,
            relShield: +(relShield * 100).toFixed(1),
            relHull:   +(relHull   * 100).toFixed(1),
        };
        // Add per-type DPS fields
        for (const t of _damageTypes) {
            detail[t.toLowerCase() + 'DPS'] = +(dmgPerShot[t] * sps).toFixed(2);
        }
        // Add firing cost per-shot fields
        for (const k of firingCostKeys) {
            detail[k] = +(w[k] || 0).toFixed(3);
        }

        details.push(detail);
    }

    // Build result — convenience aliases derived from _damageTypes
    const result = {
        dps: totalDPS,
        weaponDetails: details,
    };

    // Convenience DPS aliases (shieldDPS, hullDPS, etc.) — fully derived from _damageTypes
    for (const t of _damageTypes) {
        result[t.toLowerCase() + 'DPS'] = totalDPS[t] || 0;
    }
    // Shorthand aliases used heavily in simulation and display
    result.shieldDPS     = totalDPS['Shield']     || 0;
    result.hullDPS       = totalDPS['Hull']       || 0;
    result.heatDPS       = totalDPS['Heat']       || 0;
    result.energyDPS     = totalDPS['Energy']     || 0;
    result.fuelDPS       = totalDPS['Fuel']       || 0;
    result.ionDPS        = totalDPS['Ion']        || 0;
    result.scramblingDPS = totalDPS['Scrambling'] || 0;
    result.disruptionDPS = totalDPS['Disruption'] || 0;
    result.dischargeDPS  = totalDPS['Discharge']  || 0;
    result.corrosionDPS  = totalDPS['Corrosion']  || 0;
    result.leakDPS       = totalDPS['Leak']       || 0;
    result.burnDPS       = totalDPS['Burn']       || 0;
    result.slowingDPS    = totalDPS['Slowing']    || 0;

    // Firing cost aggregates per-second
    for (const k of firingCostKeys) {
        // Convert 'firing energy' → 'firingEnergyPerSec', etc.
        const alias = k.replace('firing ', 'firing').replace(/\s+(\w)/g, (_, c) => c.toUpperCase()) + 'PerSec';
        result[alias] = +totalFiring[k].toFixed(3);
    }
    // Shorthand aliases
    result.firingEnergyPerSec       = +(totalFiring['firing energy']  || 0).toFixed(3);
    result.firingHeatPerSec         = +(totalFiring['firing heat']    || 0).toFixed(3);
    result.firingFuelPerSec         = +(totalFiring['firing fuel']    || 0).toFixed(3);
    result.firingHullCostPerSec     = +(totalFiring['firing hull']    || 0).toFixed(3);
    result.firingShieldCostPerSec   = +(totalFiring['firing shields'] || 0).toFixed(3);

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FRAME-ACCURATE SIMULATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function createCombatantState(stats) {
    // Status effects — keyed by statName from _statusDecayMap
    const statusEffects = {};
    for (const statName of Object.keys(_statusDecayMap)) {
        statusEffects[statName] = 0;
    }

    return {
        stats,
        shields:     stats.maxShields,
        hull:        stats.maxHull,
        energy:      stats.energyCap,
        heat:        0,
        fuel:        1000,
        statusEffects,
        shieldDelayCounter: 0,
        repairDelayCounter: 0,
        depletedFlag:       false,
        weaponReloadCounters: stats.weapons.map(() => 0),
        weaponBurstCounters:  stats.weapons.map(() => 0),
        disabled:    false,
        disabledAt:  Infinity,
        destroyed:   false,
        destroyedAt: Infinity,
        isOverheated: false,
        isIonized:    false,
    };
}

/**
 * Main simulation.
 */
function simulateBattle(sA, sB) {
    const result = {
        winner:   null,
        ttkA:     Infinity,
        ttkB:     Infinity,
        phases:   [],
        warnings: [],
    };

    const stA = createCombatantState(sA);
    const stB = createCombatantState(sB);

    const milestones = {
        A: { shieldsBroken: false, halfHull: false, disabled: false, energyBlackout: false, overheated: false },
        B: { shieldsBroken: false, halfHull: false, disabled: false, energyBlackout: false, overheated: false },
    };

    const SAMPLE_INTERVAL = 60;
    const timelineA = [];
    const timelineB = [];

    let frame = 0;

    while (frame < MAX_FRAMES) {
        const t = frame / FPS;

        if (frame % SAMPLE_INTERVAL === 0) {
            timelineA.push({ t, shields: stA.shields, hull: stA.hull, energy: stA.energy, heat: stA.heat });
            timelineB.push({ t, shields: stB.shields, hull: stB.hull, energy: stB.energy, heat: stB.heat });
        }

        if (!stA.disabled && !stA.destroyed) shootFrame(stA, stB, sA, sB);
        if (!stB.disabled && !stB.destroyed) shootFrame(stB, stA, sB, sA);

        doGeneration(stA, sA);
        doGeneration(stB, sB);

        doRegen(stA, sA);
        doRegen(stB, sB);

        decayStatus(stA, sA);
        decayStatus(stB, sB);

        stA.isOverheated = stA.heat >= sA.maxHeat;
        stB.isOverheated = stB.heat >= sB.maxHeat;

        // IsIonized: ionization > energy when ship uses energy for movement
        // From attrDefs.shipFunctions.IsIonized: [thrusting energy] > 0 ? ionization > energy : false
        stA.isIonized = sA.movingEnergyPerFrame > 0 && stA.statusEffects.ionization > stA.energy;
        stB.isIonized = sB.movingEnergyPerFrame > 0 && stB.statusEffects.ionization > stB.energy;

        // Clamp
        stA.shields = Math.max(0, Math.min(sA.maxShields, stA.shields));
        stB.shields = Math.max(0, Math.min(sB.maxShields, stB.shields));
        stA.energy  = Math.max(0, Math.min(sA.energyCap,  stA.energy));
        stB.energy  = Math.max(0, Math.min(sB.energyCap,  stB.energy));
        stA.heat    = Math.max(0, stA.heat);
        stB.heat    = Math.max(0, stB.heat);

        checkMilestones(stA, sA, 'A', t, milestones.A, result.phases);
        checkMilestones(stB, sB, 'B', t, milestones.B, result.phases);

        if (!stA.disabled && stA.hull < sA.minHull) {
            stA.disabled  = true;
            stA.disabledAt = t;
            result.ttkA   = t;
            if (!milestones.A.disabled) {
                milestones.A.disabled = true;
                result.phases.push({ time: t, type: 'A', icon: '💥',
                    text: `<strong>${escHtml(sA.name)}</strong> disabled at ${fmtT(t)}` });
            }
        }
        if (!stB.disabled && stB.hull < sB.minHull) {
            stB.disabled  = true;
            stB.disabledAt = t;
            result.ttkB   = t;
            if (!milestones.B.disabled) {
                milestones.B.disabled = true;
                result.phases.push({ time: t, type: 'B', icon: '💥',
                    text: `<strong>${escHtml(sB.name)}</strong> disabled at ${fmtT(t)}` });
            }
        }

        if (!stA.destroyed && stA.hull < 0) { stA.destroyed = true;  stA.destroyedAt = t; }
        if (!stB.destroyed && stB.hull < 0) { stB.destroyed = true;  stB.destroyedAt = t; }

        if ((stA.disabled || stA.destroyed) && (stB.disabled || stB.destroyed)) break;
        frame++;
    }

    // Final timeline sample
    const finalT = frame / FPS;
    if (!timelineA.length || timelineA[timelineA.length - 1].t < finalT) {
        timelineA.push({ t: finalT, shields: stA.shields, hull: stA.hull, energy: stA.energy, heat: stA.heat });
        timelineB.push({ t: finalT, shields: stB.shields, hull: stB.hull, energy: stB.energy, heat: stB.heat });
    }

    result.timelineA    = timelineA;
    result.timelineB    = timelineB;
    result.finalStateA  = stA;
    result.finalStateB  = stB;

    const aKilled = isFinite(result.ttkA);
    const bKilled = isFinite(result.ttkB);

    if (!aKilled && !bKilled) {
        result.winner = 'draw';
        result.phases.push({ time: frame / FPS, type: 'neutral', icon: '🤝',
            text: 'Neither ship could disable the other — draw.' });
    } else if (aKilled && bKilled) {
        result.winner = result.ttkB <= result.ttkA ? 'A' : 'B';
    } else {
        result.winner = bKilled ? 'A' : 'B';
    }

    result.phases.sort((a, b) => a.time - b.time);
    return result;
}

// ── shootFrame ────────────────────────────────────────────────────────────────

function shootFrame(attSt, defSt, attStats, defStats) {
    if (attSt.isOverheated) return;

    for (let i = 0; i < attStats.weapons.length; i++) {
        const w       = attStats.weapons[i];
        const reload  = Math.max(1, w.reload || 1);
        const bcr     = w['burst reload'] || reload;
        const bcount  = w['burst count']  || 1;

        if (attSt.weaponReloadCounters[i] > 0) {
            attSt.weaponReloadCounters[i]--;
            continue;
        }

        // Energy check
        const fe = w['firing energy'] || 0;
        if (fe > 0 && attSt.energy < fe) continue;
        if (attSt.isIonized) continue;

        // Expend firing costs — all firing* keys derived from attrDefs at weapon analysis time
        attSt.energy  -= fe;
        attSt.fuel    -= (w['firing fuel']    || 0);
        attSt.hull    -= (w['firing hull']    || 0);
        attSt.shields -= (w['firing shields'] || 0);
        attSt.heat    += (w['firing heat']    || 0);

        // Self-inflicted status effects from firing (e.g. 'firing ion', 'firing scramble')
        // These keys come from attrDefs.outfitDisplay.valueNames — no hardcoding
        for (const statDesc of _statusDescriptors) {
            const firingKey = 'firing ' + statDesc.statName.replace('ionization', 'ion').replace('scrambling', 'scramble');
            // Map statDesc.statName → firing key (e.g. ionization → 'firing ion')
            const fkMap = {
                ionization: 'firing ion',
                scrambling: 'firing scramble',
                disruption: 'firing disruption',
                discharge:  'firing discharge',
                corrosion:  'firing corrosion',
                leak:       'firing leak',
                burn:       'firing burn',
                slowing:    'firing slowing',
            };
            const fk = fkMap[statDesc.statName];
            if (fk && w[fk]) {
                attSt.statusEffects[statDesc.statName] =
                    (attSt.statusEffects[statDesc.statName] || 0) + w[fk];
            }
        }

        // Burst logic
        if (bcount > 1) {
            attSt.weaponBurstCounters[i]++;
            if (attSt.weaponBurstCounters[i] >= bcount) {
                attSt.weaponBurstCounters[i]  = 0;
                attSt.weaponReloadCounters[i] = reload - 1;
            } else {
                attSt.weaponReloadCounters[i] = bcr - 1;
            }
        } else {
            attSt.weaponReloadCounters[i] = reload - 1;
        }

        applyWeaponDamage(w, defSt, defStats);
    }
}

// ── applyWeaponDamage ─────────────────────────────────────────────────────────

/**
 * Apply one shot to the defender.
 *
 * All damage types iterated from _damageTypes (attrDefs.weapon.damageTypes).
 * Protection keys derived from damage type names (e.g. 'Shield' → 'shield protection').
 * Disruption multiplier: from attrDefs / Ship.cpp Health():
 *   shields take (1 + disruption * 0.01) extra damage
 * Piercing: rawPiercing * (1 - piercingResistance) bypasses shields → hull
 */
function applyWeaponDamage(w, defSt, defStats) {
    const rawPiercing  = Math.max(0, Math.min(1, w.piercing || 0));
    const piercing     = rawPiercing * (1 - defStats.piercingRes);

    // Disruption multiplier from Ship.cpp Health() formula
    const disruptionVal = defSt.statusEffects.disruption || 0;
    const disruptMult   = 1 + disruptionVal * 0.01;

    // Shield and hull damage (special handling — bidirectional)
    const rawShieldDmg = w['shield damage'] || 0;
    const rawHullDmg   = w['hull damage']   || 0;

    const shieldDmg = rawShieldDmg * (1 - defStats.shieldProt) * (1 - piercing) * disruptMult;
    const hullDmgBase = rawHullDmg * (1 - defStats.hullProt);
    const hullPierced = rawShieldDmg * (1 - defStats.shieldProt) * piercing;

    if (defSt.shields > 0) {
        defSt.shields -= shieldDmg;
        defSt.hull    -= (hullPierced + hullDmgBase);
        if (defSt.shields < 0) {
            // Overflow — excess shield damage spills to hull
            // From Ship.cpp: if no hull damage on weapon, use 0.5 of shield overflow
            const overflow = -defSt.shields * (rawHullDmg > 0 ? 1.0 : 0.5);
            defSt.hull   -= overflow * (1 - defStats.hullProt);
            defSt.shields = 0;
            defSt.depletedFlag = true;
        }
    } else {
        defSt.hull -= (hullDmgBase + rawShieldDmg * (1 - defStats.shieldProt));
    }

    // Set shield/repair delay counters
    defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.shieldDelay || 0);
    defSt.repairDelayCounter = Math.max(defSt.repairDelayCounter, defStats.repairDelay || 0);
    if (defSt.depletedFlag)
        defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.depletedDelay || 0);

    // ── All other damage types from _damageTypes ──────────────────────────
    // Shield and Hull handled above; remaining types applied to status effects or resources
    for (const typeName of _damageTypes) {
        if (typeName === 'Shield' || typeName === 'Hull') continue;

        const key      = dmgKey(typeName);     // e.g. 'heat damage'
        const pKey     = protKey(typeName);    // e.g. 'heat protection'
        const rawDmg   = w[key] || 0;
        if (!rawDmg) continue;

        const prot = defStats.protections[pKey] || 0;
        const dmg  = rawDmg * (1 - prot);

        // Apply to appropriate state field
        applyDamageToField(defSt, typeName, dmg);
    }
}

/**
 * Route a damage value to the correct state field.
 * Mapping derived from attrDefs.weapon.statusEffectDecay.decayMap and Ship.cpp logic.
 * Resource damage (Energy, Fuel, Heat) goes to direct stat fields.
 * Status damage (Ion, Scrambling, etc.) accumulates in statusEffects.
 */
function applyDamageToField(defSt, typeName, dmg) {
    switch (typeName) {
        case 'Heat':       defSt.heat   += dmg;               break;
        case 'Energy':     defSt.energy -= dmg;               break;  // energy damage drains
        case 'Fuel':       defSt.fuel   -= dmg;               break;  // fuel damage drains
        // Status effects — all keyed by statName in statusEffects
        case 'Ion':        defSt.statusEffects.ionization  = Math.max(0, (defSt.statusEffects.ionization  || 0) + dmg); break;
        case 'Scrambling': defSt.statusEffects.scrambling  = Math.max(0, (defSt.statusEffects.scrambling  || 0) + dmg); break;
        case 'Disruption': defSt.statusEffects.disruption  = Math.max(0, (defSt.statusEffects.disruption  || 0) + dmg); break;
        case 'Discharge':  defSt.statusEffects.discharge   = Math.max(0, (defSt.statusEffects.discharge   || 0) + dmg); break;
        case 'Corrosion':  defSt.statusEffects.corrosion   = Math.max(0, (defSt.statusEffects.corrosion   || 0) + dmg); break;
        case 'Leak':       defSt.statusEffects.leak        = Math.max(0, (defSt.statusEffects.leak        || 0) + dmg); break;
        case 'Burn':       defSt.statusEffects.burn        = Math.max(0, (defSt.statusEffects.burn        || 0) + dmg); break;
        case 'Slowing':    defSt.statusEffects.slowing     = Math.max(0, (defSt.statusEffects.slowing     || 0) + dmg); break;
        // Scaling damage is handled internally by ES engine at projectile level — skip in sim
        default: break;
    }
}

// ── doGeneration ─────────────────────────────────────────────────────────────

/**
 * Per-frame resource generation/consumption.
 * Formulas from attrDefs.shipFunctions.DoGeneration.
 *
 * Status effect processing:
 *   discharge  → drains shields per frame
 *   corrosion  → drains hull per frame
 *   burn       → adds heat per frame
 *   leak       → drains fuel per frame
 * Each effect decrements by its resistance each frame (handled in decayStatus).
 */
function doGeneration(st, stats) {
    st.energy += stats.energyGenPerFrame - stats.energyConsumeIdlePerFrame;
    st.energy -= stats.movingEnergyPerFrame;
    st.energy -= stats.coolingEnergyPerFrame;

    st.heat   += stats.heatGenIdlePerFrame + stats.movingHeatPerFrame;
    st.heat   -= stats.coolingPerFrame;
    st.heat   -= st.heat * stats.heatDissipFrac;

    // Status effects that apply per frame — from attrDefs DoGeneration descriptions
    if (st.statusEffects.discharge > 0) {
        st.shields -= st.statusEffects.discharge;
    }
    if (st.statusEffects.corrosion > 0) {
        st.hull    -= st.statusEffects.corrosion;
    }
    if (st.statusEffects.burn > 0) {
        st.heat    += st.statusEffects.burn;
    }
    if (st.statusEffects.leak > 0) {
        st.fuel    -= st.statusEffects.leak;
    }
}

// ── doRegen ───────────────────────────────────────────────────────────────────

function doRegen(st, stats) {
    if (st.shieldDelayCounter > 0) {
        st.shieldDelayCounter--;
    } else if (st.shields < stats.maxShields) {
        st.shields += stats.shieldRegenPerFrame + stats.delayedShieldPerFrame;
    }

    if (st.repairDelayCounter > 0) {
        st.repairDelayCounter--;
    } else if (st.hull < stats.maxHull && !st.disabled) {
        st.hull += stats.hullRepairPerFrame + stats.delayedHullPerFrame;
    }
}

// ── decayStatus ──────────────────────────────────────────────────────────────

/**
 * Status effect decay — fully driven by _statusDecayMap from attrDefs.
 * Each statName decays by the value of its resistKey per frame.
 * From attrDefs.weapon.statusEffectDecay.decayMap.
 */
function decayStatus(st, stats) {
    for (const [statName, resistKey] of Object.entries(_statusDecayMap)) {
        const resistance = stats.statusResist[statName] || 0;
        if (st.statusEffects[statName] > 0) {
            st.statusEffects[statName] = Math.max(0, st.statusEffects[statName] - resistance);
        }
    }
}

// ── checkMilestones ───────────────────────────────────────────────────────────

function checkMilestones(st, stats, side, t, m, phases) {
    if (!m.shieldsBroken && stats.maxShields > 0 && st.shields <= 0) {
        m.shieldsBroken = true;
        phases.push({ time: t, type: side, icon: '🛡',
            text: `<strong>${escHtml(stats.name)}</strong>'s shields broken at ${fmtT(t)}` });
    }
    if (!m.halfHull && st.hull < stats.maxHull * 0.5 && st.hull > 0) {
        m.halfHull = true;
        phases.push({ time: t, type: side, icon: '⚠️',
            text: `<strong>${escHtml(stats.name)}</strong> hull below 50% at ${fmtT(t)}` });
    }
    if (!m.energyBlackout && stats.energyCap > 0 && st.energy <= 0) {
        m.energyBlackout = true;
        phases.push({ time: t, type: side, icon: '⚡',
            text: `<strong>${escHtml(stats.name)}</strong> energy depleted at ${fmtT(t)}` });
    }
    if (!m.overheated && stats.maxHeat > 0 && st.heat >= stats.maxHeat) {
        m.overheated = true;
        phases.push({ time: t, type: side, icon: '🔥',
            text: `<strong>${escHtml(stats.name)}</strong> overheated at ${fmtT(t)}` });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UI  —  slot preview rendering
// ═══════════════════════════════════════════════════════════════════════════════

async function renderSlotPreview(slot, ship, stats) {
    const el     = document.getElementById('selected' + slot);
    const imgEl  = document.getElementById('img'      + slot);
    const nameEl = document.getElementById('name'     + slot);
    const metaEl = document.getElementById('meta'     + slot);
    const statEl = document.getElementById('stats'    + slot);
    const slotEl = document.getElementById('slot'     + slot);

    if (typeof window.setCurrentPlugin === 'function') window.setCurrentPlugin(ship._pluginId);
    if (typeof window.clearSpriteCache === 'function') window.clearSpriteCache();

    if (imgEl) {
        imgEl.style.display = 'none';
        imgEl.src = '';
        try {
            let element = null;
            if (ship.sprite)     element = await window.fetchSprite(ship.sprite,    ship.spriteData || {});
            if (!element && ship.thumbnail) element = await window.fetchSprite(ship.thumbnail, ship.spriteData || {});
            if (element) {
                element.id = imgEl.id;
                element.className = imgEl.className;
                imgEl.parentElement.replaceChild(element, imgEl);
            } else {
                imgEl.src = 'https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/data/endless-sky/images/outfit/unknown.png';
                imgEl.style.display = 'block';
            }
        } catch (e) {
            console.warn('renderSlotPreview: sprite fetch failed for', ship.name, e);
        }
    }

    if (nameEl) nameEl.textContent = ship.name;
    if (metaEl) metaEl.textContent = (window.allData?.[ship._pluginId]?.sourceName) || ship._pluginId || '';
    if (el)     el.classList.add('visible');
    if (slotEl) slotEl.classList.add('has-ship');

    if (statEl) {
        statEl.innerHTML = `
            ${statRow('Shields',    fmt(stats.maxShields))}
            ${statRow('Hull',       fmt(stats.maxHull))}
            ${statRow('Min Hull',   fmt(stats.minHull))}
            ${statRow('Shld DPS',   fmt(stats.shieldDPS))}
            ${statRow('Hull DPS',   fmt(stats.hullDPS))}
            ${statRow('Shld Regen', fmt(stats.shieldRegenPerSec) + '/s')}
            ${statRow('Energy',     fmt(stats.energyCap))}
            ${statRow('Heat Cap',   fmt(stats.maxHeat))}
        `;
        statEl.style.display = 'grid';
    }
}

function statRow(label, value) {
    return `<div class="slot-stat"><div class="slot-stat-label">${label}</div><div class="slot-stat-value">${value}</div></div>`;
}

function updateFightButton() {
    const btn = document.getElementById('fightBtn');
    if (btn) btn.disabled = !(_slots.A && _slots.B);
}

function hideResults() {
    const el = document.getElementById('simResults');
    if (el) el.style.display = 'none';
}

// ── runSimulation ─────────────────────────────────────────────────────────────

function runSimulation() {
    const sA = _slots.A;
    const sB = _slots.B;
    if (!sA || !sB) { setStatus('Select two ships first.', true); return; }

    // Guard: if attrDefs not yet loaded, damage types will be empty → warn user
    if (!_attrDefs) {
        setStatus('Attribute definitions not loaded yet — please wait.', true);
        return;
    }
    if (_damageTypes.length === 0) {
        console.warn('No damage types loaded from attrDefs — simulation may produce no damage');
    }

    try {
        const result = simulateBattle(sA, sB);
        renderResults(sA, sB, result);
    } catch (err) {
        console.error('runSimulation error:', err);
        setStatus('Simulation error: ' + err.message, true);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RESULTS RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function renderResults(sA, sB, result) {
    const el = document.getElementById('simResults');
    if (!el) return;

    const winnerLabel = result.winner === 'A'
        ? `<span class="winner-a">${escHtml(sA.name)}</span>`
        : result.winner === 'B'
            ? `<span class="winner-b">${escHtml(sB.name)}</span>`
            : '<span class="winner-draw">Draw</span>';

    let html = `
        <div class="result-header">
            <div class="result-winner-label">Winner: ${winnerLabel}</div>
            <div class="result-ttk">
                <span class="ttk-a">${escHtml(sA.name)} disabled in: ${fmtTTK(result.ttkA)}</span>
                <span class="ttk-b">${escHtml(sB.name)} disabled in: ${fmtTTK(result.ttkB)}</span>
            </div>
        </div>
    `;

    html += renderTimelineChart(sA, sB, result);

    if (result.phases.length) {
        html += '<div class="phase-log">';
        for (const ph of result.phases) {
            const cls = ph.type === 'A' ? 'phase-a' : ph.type === 'B' ? 'phase-b' : 'phase-neutral';
            html += `<div class="phase-item ${cls}">${ph.icon} [${fmtT(ph.time)}] ${ph.text}</div>`;
        }
        html += '</div>';
    }

    html += renderCompareGrid(sA, sB, result);

    html += `<div class="weapons-section">
        <div class="weapons-col">
            <h3 class="weapons-title">${escHtml(sA.name)} — Weapons</h3>
            ${renderWeaponsList(sA.weaponDetails)}
        </div>
        <div class="weapons-col">
            <h3 class="weapons-title">${escHtml(sB.name)} — Weapons</h3>
            ${renderWeaponsList(sB.weaponDetails)}
        </div>
    </div>`;

    el.innerHTML = html;
    el.style.display = 'block';
}

function renderTimelineChart(sA, sB, result) {
    const timelineA = result.timelineA || [];
    const timelineB = result.timelineB || [];
    if (!timelineA.length && !timelineB.length) return '';

    const W = 700, H = 200;
    const PAD = { l: 48, r: 16, t: 20, b: 32 };
    const cW = W - PAD.l - PAD.r;
    const cH = H - PAD.t - PAD.b;

    const maxTime = Math.max(
        timelineA[timelineA.length - 1]?.t ?? 0,
        timelineB[timelineB.length - 1]?.t ?? 0,
        1
    );
    const maxHPA = sA.maxShields + sA.maxHull;
    const maxHPB = sB.maxShields + sB.maxHull;
    const maxHP  = Math.max(maxHPA, maxHPB, 1);

    const px  = t  => PAD.l + (t / maxTime) * cW;
    const pyA = hp => PAD.t + cH - (hp / maxHP) * cH;
    const pyB = hp => PAD.t + cH - (hp / maxHP) * cH;

    const pathAHull    = timelineA.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${pyA(p.hull).toFixed(1)}`).join(' ');
    const pathBHull    = timelineB.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${pyB(p.hull).toFixed(1)}`).join(' ');
    const pathAShields = timelineA.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${pyA(p.hull + p.shields).toFixed(1)}`).join(' ');
    const pathBShields = timelineB.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${pyB(p.hull + p.shields).toFixed(1)}`).join(' ');

    const tickCount = 4;
    let ticks = '';
    for (let i = 0; i <= tickCount; i++) {
        const v = (maxHP * i / tickCount);
        const y = pyA(v).toFixed(1);
        ticks += `<line x1="${PAD.l}" y1="${y}" x2="${PAD.l + cW}" y2="${y}" stroke="rgba(148,163,184,0.15)" stroke-width="1"/>
                  <text x="${PAD.l - 4}" y="${parseFloat(y) + 4}" fill="#64748b" font-size="9" text-anchor="end">${Math.round(v)}</text>`;
    }

    return `<div class="timeline-chart">
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px;display:block;">
        <rect x="${PAD.l}" y="${PAD.t}" width="${cW}" height="${cH}" fill="rgba(15,23,42,0.5)" rx="4"/>
        ${ticks}
        ${sA.minHull > 0 ? `<line x1="${PAD.l}" y1="${pyA(sA.minHull).toFixed(1)}" x2="${PAD.l + cW}" y2="${pyA(sA.minHull).toFixed(1)}" stroke="rgba(59,130,246,0.35)" stroke-width="1" stroke-dasharray="4,3"/>` : ''}
        ${sB.minHull > 0 ? `<line x1="${PAD.l}" y1="${pyB(sB.minHull).toFixed(1)}" x2="${PAD.l + cW}" y2="${pyB(sB.minHull).toFixed(1)}" stroke="rgba(239,68,68,0.35)" stroke-width="1" stroke-dasharray="4,3"/>` : ''}
        <path d="${pathAShields}" fill="none" stroke="rgba(59,130,246,0.55)" stroke-width="1.5"/>
        <path d="${pathAHull}"    fill="none" stroke="#3b82f6" stroke-width="2.5"/>
        <path d="${pathBShields}" fill="none" stroke="rgba(239,68,68,0.55)" stroke-width="1.5"/>
        <path d="${pathBHull}"    fill="none" stroke="#ef4444" stroke-width="2.5"/>
        <rect x="${PAD.l + 8}" y="${PAD.t + 8}"  width="10" height="3" fill="#3b82f6" rx="1"/>
        <text x="${PAD.l + 22}" y="${PAD.t + 13}" fill="#93c5fd" font-size="9">${escHtml(sA.name)} hull</text>
        <rect x="${PAD.l + 8}" y="${PAD.t + 20}" width="10" height="3" fill="#ef4444" rx="1"/>
        <text x="${PAD.l + 22}" y="${PAD.t + 25}" fill="#fca5a5" font-size="9">${escHtml(sB.name)} hull</text>
      </svg>
    </div>`;
}

function renderCompareGrid(sA, sB, result) {
    const rows = [
        ['Combat', [
            ['Time to Disable',      fmtTTK(result.ttkA),                      fmtTTK(result.ttkB)],
            ['Max Shields',          fmt(sA.maxShields),                        fmt(sB.maxShields)],
            ['Max Hull',             fmt(sA.maxHull),                           fmt(sB.maxHull)],
            ['Disable Threshold',    fmt(sA.minHull),                           fmt(sB.minHull)],
            ['Hull to Disable',      fmt(sA.hullToDisable),                     fmt(sB.hullToDisable)],
            ['Shield DPS',           fmt(sA.shieldDPS),                         fmt(sB.shieldDPS)],
            ['Hull DPS',             fmt(sA.hullDPS),                           fmt(sB.hullDPS)],
            ['Heat DPS',             fmt(sA.heatDPS),                           fmt(sB.heatDPS)],
            ['Ion DPS',              fmt(sA.ionDPS),                            fmt(sB.ionDPS)],
            ['Disruption DPS',       fmt(sA.disruptionDPS),                     fmt(sB.disruptionDPS)],
            ['Shield Regen/s',       fmt(sA.shieldRegenPerSec),                 fmt(sB.shieldRegenPerSec)],
            ['Hull Repair/s',        fmt(sA.hullRepairPerSec),                  fmt(sB.hullRepairPerSec)],
            ['Shield Protection',    fmtPct(sA.shieldProt),                     fmtPct(sB.shieldProt)],
            ['Hull Protection',      fmtPct(sA.hullProt),                       fmtPct(sB.hullProt)],
            ['Piercing Resistance',  fmtPct(sA.piercingRes),                    fmtPct(sB.piercingRes)],
        ]],
        ['Energy', [
            ['Energy Capacity',      fmt(sA.energyCap),                         fmt(sB.energyCap)],
            ['Energy Gen/s',         fmt(sA.energyGenPerFrame * FPS),           fmt(sB.energyGenPerFrame * FPS)],
            ['Firing Energy/s',      fmt(sA.firingEnergyPerSec),                fmt(sB.firingEnergyPerSec)],
            ['Moving Energy/s',      fmt(sA.movingEnergyPerFrame * FPS),        fmt(sB.movingEnergyPerFrame * FPS)],
            ['Net Energy/s',         fmtNet((sA.energyGenPerFrame - sA.energyConsumeIdlePerFrame - sA.movingEnergyPerFrame - sA.coolingEnergyPerFrame - sA.firingEnergyPerSec / FPS) * FPS),
                                     fmtNet((sB.energyGenPerFrame - sB.energyConsumeIdlePerFrame - sB.movingEnergyPerFrame - sB.coolingEnergyPerFrame - sB.firingEnergyPerSec / FPS) * FPS)],
        ]],
        ['Heat', [
            ['Heat Capacity',        fmt(sA.maxHeat),                           fmt(sB.maxHeat)],
            ['Cooling/s',            fmt(sA.coolingPerSec),                     fmt(sB.coolingPerSec)],
            ['Heat Dissipation',     fmtPct(sA.heatDissipFrac * 100, 3),        fmtPct(sB.heatDissipFrac * 100, 3)],
            ['Firing Heat/s',        fmt(sA.firingHeatPerSec),                  fmt(sB.firingHeatPerSec)],
            ['Moving Heat/s',        fmt(sA.movingHeatPerFrame * FPS),          fmt(sB.movingHeatPerFrame * FPS)],
        ]],
        ['Navigation', [
            ['Mass',                 fmt(sA.rawMass) + ' t',                    fmt(sB.rawMass) + ' t'],
            ['Inertial Mass',        fmt(sA.inertialMass) + ' t',               fmt(sB.inertialMass) + ' t'],
            ['Max Velocity',         fmt(sA.maxVelocity) + ' px/s',             fmt(sB.maxVelocity) + ' px/s'],
        ]],
    ];

    let html = '';
    for (const [section, items] of rows) {
        html += `<div class="res-section-title">${section}</div>
                 <div class="results-compare">
                   <div class="res-col res-col-a">`;
        for (const [, va] of items) html += `<div class="res-row"><div class="res-row-value">${va}</div></div>`;
        html += `</div><div class="res-divider">`;
        for (const [label] of items) html += `<div class="res-divider-item">${label}</div>`;
        html += `</div><div class="res-col res-col-b">`;
        for (const [, , vb] of items) html += `<div class="res-row"><div class="res-row-value">${vb}</div></div>`;
        html += `</div></div>`;
    }
    return html;
}

function renderWeaponsList(details) {
    if (!details || !details.length)
        return '<div class="weapon-item" style="color:var(--c-text-muted);font-style:italic;">No weapons</div>';

    return details.map(w => {
        // Build extra damage display from _damageTypes — no hardcoding
        const extraDmg = [];
        for (const typeName of _damageTypes) {
            if (typeName === 'Shield' || typeName === 'Hull') continue;
            const dps = w[typeName.toLowerCase() + 'DPS'] || 0;
            if (dps > 0.001) extraDmg.push(`${typeName}: ${fmt(dps)}/s`);
        }
        if (w.relShield > 0) extraDmg.push(`%Shield: ${w.relShield}%/hit`);
        if (w.relHull   > 0) extraDmg.push(`%Hull: ${w.relHull}%/hit`);

        return `
        <div class="weapon-item">
            <div class="weapon-item-name">${escHtml(w.name)}${w.hasSubmunitions ? ' <span class="weapon-sub-badge" title="Has submunitions">⚡ Sub</span>' : ''}</div>
            <div class="weapon-item-stats">
                <span class="weapon-stat">Rate: <span>${w.sps}/s</span></span>
                <span class="weapon-stat">Shld: <span>${fmt(w.shieldDPS)}/s</span></span>
                <span class="weapon-stat">Hull: <span>${fmt(w.hullDPS)}/s</span></span>
                ${w.piercing ? `<span class="weapon-stat">Pierce: <span>${w.piercing}%</span></span>` : ''}
                ${w.range    ? `<span class="weapon-stat">Range: <span>${w.range}px</span></span>`  : ''}
                ${w.burstCount > 1 ? `<span class="weapon-stat">Burst: <span>${w.burstCount}×</span></span>` : ''}
                ${w.homing      ? `<span class="weapon-stat">🎯 Homing</span>` : ''}
                ${w.antiMissile ? `<span class="weapon-stat">🛡 Anti-Missile</span>` : ''}
                ${extraDmg.map(s => `<span class="weapon-stat"><span>${escHtml(s)}</span></span>`).join('')}
            </div>
        </div>`;
    }).join('');
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(n) {
    if (n === null || n === undefined) return '—';
    if (!isFinite(n)) return '∞';
    if (Math.abs(n) >= 100000) return (n / 1000).toFixed(1) + 'k';
    if (Math.abs(n) >= 10000)  return Math.round(n).toLocaleString();
    if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(2);
    if (Number.isInteger(n))   return n.toString();
    return parseFloat(n.toPrecision(4)).toString();
}

function fmtT(t)    { return isFinite(t) ? t.toFixed(1) + 's' : '∞'; }
function fmtTTK(t)  { return isFinite(t) ? fmtT(t) : '∞ (never)'; }

function fmtPct(v, dp = 1) {
    if (!v) return '0%';
    return (v * (dp === 1 && v < 1 ? 100 : 1)).toFixed(dp) + '%';
}

function fmtNet(v) {
    if (!isFinite(v) || v === 0) return '0';
    const s = fmt(Math.abs(v));
    return v > 0 ? `+${s}` : `-${s}`;
}

function escHtml(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Expose globals ─────────────────────────────────────────────────────────────

window.searchShips   = searchShips;
window.openDropdown  = openDropdown;
window.blurDropdown  = blurDropdown;
window.clearSlot     = clearSlot;
window.runSimulation = runSimulation;

// Wire up the fight button click — this is the primary fix for "does nothing"
// The original code exposed window.runSimulation but never added a click listener.
// The HTML uses onclick="runSimulation()" which works IF the script loads before
// the button click, but to be safe we also attach via addEventListener here.
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('fightBtn');
    if (btn) {
        btn.addEventListener('click', runSimulation);
    }
    init();
});

})();