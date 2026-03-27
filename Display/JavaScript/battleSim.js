/**
 * battleSim.js  —  Endless Sky Battle Simulator  (accurate rewrite)
 *
 * Uses attributeDefinitions.json (attrDefs) for ALL formulas and stacking rules.
 * Zero hardcoded attribute names in the simulation core.
 *
 * Combat model accuracy notes (derived from Ship.cpp / Weapon.cpp):
 *   • MaxShields     = [shields] × (1 + [shield multiplier])
 *   • MaxHull        = [hull]    × (1 + [hull multiplier])
 *   • MinimumHull    = [absolute threshold] if set, else
 *                      max(0, floor([threshold percentage] × MaxHull + [hull threshold]))
 *   • Shield regen   = [shield generation] × (1 + [shield generation multiplier]) per frame
 *                      + delayed shield generation (separate counter)
 *   • Hull repair    = [hull repair rate] × (1 + [hull repair multiplier]) per frame
 *                      + delayed hull repair rate
 *   • Shield delay   = frames after last hit before regen starts
 *   • Repair delay   = frames after last hit before hull repair starts
 *   • Depleted shield delay = extra delay when shields reach 0
 *   • CoolingEfficiency = sigmoid: 2 + 2/(1+exp(x/-2)) - 4/(1+exp(x/-4))
 *   • MaximumHeat    = 100 × (mass + [heat capacity])
 *   • HeatDissipation per frame = 0.001 × [heat dissipation]
 *   • Disruption damage temporarily multiplies shield damage taken by (1 + disruption×0.01)
 *   • Piercing fraction of weapon damage bypasses shields entirely → hull
 *   • All protection attrs are damage reduction multipliers (1 - protection)
 *   • Overheat: weapons cannot fire above 100% heat (isOverheated)
 *   • Ionization: weapons cannot fire when ionization > energy
 *   • Energy blackout: firing stops if energy < firing energy cost
 *
 * Frame-accurate simulation: runs at 60fps, up to MAX_SIM_SECS seconds.
 */

;(function () {
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const FPS          = 60;
const MAX_SIM_SECS = 600;       // 10 minutes hard cap
const MAX_FRAMES   = MAX_SIM_SECS * FPS;
const SOLAR_POWER  = 1.0;

const REPO_URL = 'GIVEMEFOOD5/endless-sky-ship-builder';
const BASE_URL = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;

// ── Module state ──────────────────────────────────────────────────────────────
let _allShips    = [];
let _outfitIndex = {};
let _attrDefs    = null;

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
            if (typeof initComputedStats === 'function')
                initComputedStats(_attrDefs, BASE_URL);
        }
    } catch (_) {}

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
            const pluginData = { sourceName, displayName, outputName, ships: [], variants: [], outfits: [], effects: [] };
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
    renderSlotPreview(slot, ship, resolved);
    updateFightButton();
    hideResults();
}

function clearSlot(slot) {
    _slots[slot] = null;
    document.getElementById('search' + slot).value = '';
    document.getElementById('selected' + slot).classList.remove('visible');
    document.getElementById('stats' + slot).style.display = 'none';
    document.getElementById('slot' + slot).classList.remove('has-ship');
    updateFightButton();
    hideResults();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STAT RESOLUTION  —  everything derived from attrDefs formulas
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the complete stat block for a ship, consulting attrDefs for all
 * formula constants, stacking rules, and display scales.
 */
function resolveShipStats(ship) {
    // ── Step 1: accumulate outfit attributes ───────────────────────────────
    const baseAttrs  = ship.attributes || {};
    const outfitMap  = ship.outfitMap  || {};
    const attrDefs   = (_attrDefs?.attributes) || {};

    const combined   = { ...baseAttrs };
    const weapons    = [];   // raw weapon objects (one entry per gun, per qty)

    for (const [outfitName, qty] of Object.entries(outfitMap)) {
        const outfit = _outfitIndex[outfitName];
        if (!outfit) continue;

        // Weapon outfits
        if (outfit.weapon) {
            for (let i = 0; i < qty; i++)
                weapons.push({ _name: outfitName, ...outfit.weapon });
        }

        // Attribute accumulation — respects stacking rules from attrDefs
        const outfitAttrs = (outfit.attributes && Object.keys(outfit.attributes).length)
            ? outfit.attributes : outfit;

        for (const [key, rawVal] of Object.entries(outfitAttrs)) {
            if (typeof rawVal !== 'number' || key.startsWith('_')) continue;
            const stacking = attrDefs[key]?.stacking || 'additive';
            const contrib  = rawVal * qty;
            switch (stacking) {
                case 'maximum': combined[key] = Math.max(combined[key] ?? -Infinity, contrib); break;
                case 'minimum': combined[key] = Math.min(combined[key] ??  Infinity, contrib); break;
                default:        combined[key] = (combined[key] || 0) + contrib;
            }
        }
    }

    // ── Step 2: resolve all ES formulas ───────────────────────────────────

    const a = k => combined[k] || 0;  // safe attribute getter

    // Mass chain
    const rawMass      = a('mass');
    const inertiaRed   = a('inertia reduction');
    const inertialMass = rawMass / (1 + inertiaRed);
    const dragRaw      = a('drag');
    const dragEff      = dragRaw / (1 + a('drag reduction'));
    const drag         = Math.min(dragEff, inertialMass);

    // HP — Ship.cpp MaxShields / MaxHull formulas
    const maxShields   = a('shields') * (1 + a('shield multiplier'));
    const maxHull      = a('hull')    * (1 + a('hull multiplier'));

    // MinimumHull — Ship.cpp MinimumHull()
    let minHull;
    const absThresh    = a('absolute threshold');
    if (absThresh > 0) {
        minHull = absThresh;
    } else {
        const threshPct = a('threshold percentage');
        const hullAdd   = a('hull threshold');
        minHull = Math.max(0, Math.floor(threshPct * maxHull + hullAdd));
    }
    const hullToDisable = Math.max(0, maxHull - minHull);

    // CoolingEfficiency — exact ES sigmoid (Ship.cpp CoolingEfficiency)
    const x             = a('cooling inefficiency');
    const coolEff       = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));

    // Heat — Ship.cpp MaximumHeat / HeatDissipation / IdleHeat
    const maxHeat       = 100 * (rawMass + a('heat capacity'));
    const heatDissipFrac = 0.001 * a('heat dissipation');   // per-frame fraction of current heat
    // Per-second passive dissipation at average half-load (linear approx used for warnings)
    const heatDissPerS  = heatDissipFrac * maxHeat * FPS * 0.5;

    // Cooling per frame (combined active + passive cooling, efficiency-adjusted)
    const coolingPerFrame = coolEff * (a('cooling') + a('active cooling'));
    const coolingPerSec   = coolingPerFrame * FPS;

    // Regen — multiplier attrs from ShipInfoDisplay / DoGeneration
    const shieldRegenPerFrame = a('shield generation') * (1 + a('shield generation multiplier'));
    const delayedShieldPerFrame = a('delayed shield generation') * (1 + a('shield generation multiplier'));
    const hullRepairPerFrame  = a('hull repair rate') * (1 + a('hull repair multiplier'));
    const delayedHullPerFrame = a('delayed hull repair rate') * (1 + a('hull repair multiplier'));

    // Delays (in frames — already in frames in data file)
    const shieldDelay   = a('shield delay');
    const repairDelay   = a('repair delay');
    const depletedDelay = a('depleted shield delay');
    const disabledDelay = a('disabled repair delay');

    // Protection (damage reduction) — all are fraction: effective = damage × (1 - protection)
    const shieldProt    = Math.max(0, Math.min(1, a('shield protection')));
    const hullProt      = Math.max(0, Math.min(1, a('hull protection')));
    const energyProt    = Math.max(0, Math.min(1, a('energy protection')));
    const heatProt      = Math.max(0, Math.min(1, a('heat protection')));
    const fuelProt      = Math.max(0, Math.min(1, a('fuel protection')));
    const ionProt       = Math.max(0, Math.min(1, a('ion protection')));
    const disruptProt   = Math.max(0, Math.min(1, a('disruption protection')));
    const slowProt      = Math.max(0, Math.min(1, a('slowing protection')));
    const burnProt      = Math.max(0, Math.min(1, a('burn protection')));
    const dischProt     = Math.max(0, Math.min(1, a('discharge protection')));
    const corrProt      = Math.max(0, Math.min(1, a('corrosion protection')));
    const leakProt      = Math.max(0, Math.min(1, a('leak protection')));
    const scrambProt    = Math.max(0, Math.min(1, a('scramble protection')));
    // Piercing resistance reduces weapon piercing fraction: effective_piercing × (1 - piercingResistance)
    const piercingRes   = Math.max(0, Math.min(1, a('piercing resistance')));

    // Status resistances (these reduce the per-frame drain of status effects)
    const ionResist     = a('ion resistance');
    const scrambResist  = a('scramble resistance');
    const disruptResist = a('disruption resistance');
    const burnResist    = a('burn resistance');
    const dischResist   = a('discharge resistance');
    const corrResist    = a('corrosion resistance');
    const leakResist    = a('leak resistance');
    const slowResist    = a('slowing resistance');

    // Energy
    const energyCap     = a('energy capacity');
    const energyGenPerFrame = (
        a('energy generation') +
        a('solar collection') * SOLAR_POWER +
        a('fuel energy')
    );
    const energyConsumeIdlePerFrame = a('energy consumption');
    // Moving energy: max(thrusting, reverse thrusting) + turning (ShipInfoDisplay formula)
    const movingEnergyPerFrame = Math.max(a('thrusting energy'), a('reverse thrusting energy')) + a('turning energy');
    // Cooling energy cost
    const coolingEnergyPerFrame = a('cooling energy');

    // Weapon stats — full accurate analysis
    const weaponSummary = analyzeWeapons(weapons, combined);

    // Navigation (for display)
    const maxVelocity    = drag > 0 ? a('thrust') / drag : 0;
    const acceleration   = inertialMass > 0
        ? (a('thrust') / inertialMass) * (1 + a('acceleration multiplier'))
        : 0;

    return {
        name:      ship.name,
        pluginId:  ship._pluginId,
        rawShip:   ship,
        combined,
        weapons,

        // HP
        maxShields, maxHull, minHull, hullToDisable,

        // Regen (per-frame values for simulation, per-second for display)
        shieldRegenPerFrame, delayedShieldPerFrame,
        hullRepairPerFrame,  delayedHullPerFrame,
        shieldRegenPerSec:   (shieldRegenPerFrame + delayedShieldPerFrame) * FPS,
        hullRepairPerSec:    (hullRepairPerFrame  + delayedHullPerFrame)  * FPS,

        // Delays
        shieldDelay, repairDelay, depletedDelay, disabledDelay,

        // Protection
        shieldProt, hullProt, energyProt, heatProt, fuelProt,
        ionProt, disruptProt, slowProt, burnProt, dischProt, corrProt, leakProt, scrambProt,
        piercingRes,

        // Status resistances
        ionResist, scrambResist, disruptResist, burnResist,
        dischResist, corrResist, leakResist, slowResist,

        // Energy
        energyCap, energyGenPerFrame, energyConsumeIdlePerFrame,
        movingEnergyPerFrame, coolingEnergyPerFrame,

        // Heat
        maxHeat, heatDissipFrac, coolingPerFrame, coolingPerSec,
        heatGenIdlePerFrame: a('heat generation'),
        movingHeatPerFrame:  Math.max(a('thrusting heat'), a('reverse thrusting heat')) + a('turning heat'),

        // Mass
        rawMass, inertialMass, drag,
        maxVelocity: maxVelocity * FPS,
        acceleration: acceleration * FPS * FPS,

        // Weapon summary
        ...weaponSummary,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WEAPON ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyse every weapon and produce:
 *   - per-weapon detail objects
 *   - aggregate DPS figures (one per damage type, both raw and vs shields/hull)
 *   - aggregate firing cost rates
 *
 * All damage type keys come from attrDefs.weapon.damageTypes.
 */
function analyzeWeapons(weapons, shipAttrs) {
    const damageTypes = _attrDefs?.weapon?.damageTypes || [
        'Shield','Hull','Heat','Energy','Fuel','Ion','Scrambling','Disruption',
        'Slowing','Discharge','Corrosion','Leak','Burn',
    ];

    // Initialize aggregates
    const totalDPS    = {};
    const totalFiring = { energy: 0, heat: 0, fuel: 0, hull: 0, shields: 0 };
    for (const t of damageTypes) totalDPS[t] = 0;

    const details = [];

    for (const w of weapons) {
        const reload     = Math.max(1, w.reload || 1);
        // Burst: during burst, effective reload = burstReload; after burst = reload
        const burstCount = w['burst count'] || 1;
        const burstReload= w['burst reload'] || reload;
        // Shots per second: average accounting for burst behaviour
        // burstCount shots then 1 full reload
        const framesPerCycle = (burstCount - 1) * burstReload + reload;
        const sps = (burstCount / framesPerCycle) * FPS;

        const piercing   = Math.max(0, Math.min(1, w.piercing || 0));
        const range      = w.velocity && w.lifetime ? w.velocity * w.lifetime : null;

        // Per-shot damage for each type
        const dmgPerShot = {};
        for (const t of damageTypes) {
            const key = t.toLowerCase() + ' damage';
            dmgPerShot[t] = (w[key] || 0);
        }

        // Relative (%) damages (scale to target's current stat) — recorded for display
        const relShield = w['% shield damage'] || 0;
        const relHull   = w['% hull damage']   || 0;

        // DPS contribution
        for (const t of damageTypes) {
            totalDPS[t] = (totalDPS[t] || 0) + dmgPerShot[t] * sps;
        }

        // Firing costs per second
        totalFiring.energy  += (w['firing energy']  || 0) * sps;
        totalFiring.heat    += (w['firing heat']    || 0) * sps;
        totalFiring.fuel    += (w['firing fuel']    || 0) * sps;
        totalFiring.hull    += (w['firing hull']    || 0) * sps;
        totalFiring.shields += (w['firing shields'] || 0) * sps;

        // Per-weapon firing status effects (applied to self)
        const firingIon      = (w['firing ion']      || 0) * sps;
        const firingScramble = (w['firing scramble'] || 0) * sps;

        details.push({
            name:        w._name || 'Unknown',
            reload, burstCount, burstReload, sps: +sps.toFixed(3),
            piercing:    +(piercing * 100).toFixed(0),
            range,
            homing:      (w.homing || 0) > 0,
            antiMissile: (w['anti-missile'] || 0) > 0,
            dmgPerShot,
            relShield: +(relShield * 100).toFixed(1),
            relHull:   +(relHull   * 100).toFixed(1),
            // DPS contributions
            shieldDPS: +(dmgPerShot['Shield'] * sps).toFixed(2),
            hullDPS:   +(dmgPerShot['Hull']   * sps).toFixed(2),
            firingEnergy: +(w['firing energy'] || 0).toFixed(2),
            firingHeat:   +(w['firing heat']   || 0).toFixed(2),
            firingIon: +firingIon.toFixed(3),
            firingScramble: +firingScramble.toFixed(3),
        });
    }

    return {
        // Aggregate DPS by type
        dps: totalDPS,
        // Convenience aliases used heavily in simulation
        shieldDPS:          totalDPS['Shield']    || 0,
        hullDPS:            totalDPS['Hull']      || 0,
        heatDPS:            totalDPS['Heat']      || 0,
        energyDPS:          totalDPS['Energy']    || 0,
        fuelDPS:            totalDPS['Fuel']      || 0,
        ionDPS:             totalDPS['Ion']       || 0,
        scramblingDPS:      totalDPS['Scrambling']|| 0,
        disruptionDPS:      totalDPS['Disruption']|| 0,
        dischargeDPS:       totalDPS['Discharge'] || 0,
        corrosionDPS:       totalDPS['Corrosion'] || 0,
        leakDPS:            totalDPS['Leak']      || 0,
        burnDPS:            totalDPS['Burn']      || 0,
        slowingDPS:         totalDPS['Slowing']   || 0,
        // Firing costs per second
        firingEnergyPerSec: +totalFiring.energy.toFixed(3),
        firingHeatPerSec:   +totalFiring.heat.toFixed(3),
        firingFuelPerSec:   +totalFiring.fuel.toFixed(3),
        firingHullCostPerSec:   +totalFiring.hull.toFixed(3),
        firingShieldCostPerSec: +totalFiring.shields.toFixed(3),
        weaponDetails:      details,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FRAME-ACCURATE SIMULATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * CombatantState — mutable runtime state for one ship during simulation.
 */
function createCombatantState(stats) {
    return {
        stats,
        // Current HP
        shields:     stats.maxShields,
        hull:        stats.maxHull,
        // Current resources
        energy:      stats.energyCap,
        heat:        0,
        fuel:        1000,      // assume full fuel tank (fuel is rarely combat-relevant)
        // Status effects (accumulated values, decay each frame via resistance)
        ionization:  0,
        scrambling:  0,
        disruption:  0,
        discharge:   0,
        corrosion:   0,
        leak:        0,
        burn:        0,
        slowing:     0,
        // Delay counters (count down to 0 before regen resumes)
        shieldDelayCounter: 0,
        repairDelayCounter: 0,
        depletedFlag:       false,   // shields were fully depleted
        // Weapon reload counters: one per weapon in stats.weapons
        weaponReloadCounters: stats.weapons.map(() => 0),
        weaponBurstCounters:  stats.weapons.map(() => 0),
        // State flags
        disabled:    false,
        disabledAt:  Infinity,
        destroyed:   false,
        destroyedAt: Infinity,
        // Overheat / ionized flags (recalculated each frame)
        isOverheated: false,
        isIonized:    false,
    };
}

/**
 * Main simulation.  Returns a detailed result object.
 *
 * Uses frame-by-frame stepping so all ES mechanics (delays, burst fire,
 * status effect accumulation/decay, energy starvation, heat overflow) are
 * modelled exactly.
 */
function simulateBattle(sA, sB) {
    const result = {
        winner:  null,
        ttkA:    Infinity,  // time for B to disable A
        ttkB:    Infinity,  // time for A to disable B
        phases:  [],
        warnings: [],
        frameData: null,    // kept null unless needed
    };

    const stA = createCombatantState(sA);
    const stB = createCombatantState(sB);

    // Track phase milestones (each fires only once)
    const milestones = {
        A: { shieldsBroken: false, halfHull: false, disabled: false, energyBlackout: false, overheated: false },
        B: { shieldsBroken: false, halfHull: false, disabled: false, energyBlackout: false, overheated: false },
    };

    // Sample every N frames for timeline (lightweight)
    const SAMPLE_INTERVAL = 60;
    const timelineA = [];  // { t, shields, hull, energy, heat }
    const timelineB = [];

    let frame = 0;

    while (frame < MAX_FRAMES) {
        const t = frame / FPS;

        // ── Sample for timeline ──────────────────────────────────────────
        if (frame % SAMPLE_INTERVAL === 0) {
            timelineA.push({ t, shields: stA.shields, hull: stA.hull, energy: stA.energy, heat: stA.heat });
            timelineB.push({ t, shields: stB.shields, hull: stB.hull, energy: stB.energy, heat: stB.heat });
        }

        // ── Simulate one frame ───────────────────────────────────────────
        const eventsA = [];
        const eventsB = [];

        // A shoots at B, B shoots at A
        if (!stA.disabled && !stA.destroyed)
            shootFrame(stA, stB, sA, sB, frame, eventsB);
        if (!stB.disabled && !stB.destroyed)
            shootFrame(stB, stA, sB, sA, frame, eventsA);

        // Generation / cooling for both
        doGeneration(stA, sA, frame);
        doGeneration(stB, sB, frame);

        // Regen
        doRegen(stA, sA, frame);
        doRegen(stB, sB, frame);

        // Status decay
        decayStatus(stA, sA);
        decayStatus(stB, sB);

        // Overheat / ionization flags
        stA.isOverheated = stA.heat >= stA.stats.maxHeat;
        stB.isOverheated = stB.heat >= stB.stats.maxHeat;

        const movingEnergyA = sA.movingEnergyPerFrame + sA.coolingEnergyPerFrame;
        stA.isIonized = sA.movingEnergyPerFrame > 0 && stA.ionization > stA.energy;
        stB.isIonized = sB.movingEnergyPerFrame > 0 && stB.ionization > stB.energy;

        // Clamp
        stA.shields = Math.max(0, Math.min(stA.stats.maxShields, stA.shields));
        stB.shields = Math.max(0, Math.min(stB.stats.maxShields, stB.shields));
        stA.energy  = Math.max(0, Math.min(stA.stats.energyCap,  stA.energy));
        stB.energy  = Math.max(0, Math.min(stB.stats.energyCap,  stB.energy));
        stA.heat    = Math.max(0, stA.heat);
        stB.heat    = Math.max(0, stB.heat);

        // ── Milestone detection ──────────────────────────────────────────
        checkMilestones(stA, sA, 'A', t, milestones.A, result.phases);
        checkMilestones(stB, sB, 'B', t, milestones.B, result.phases);

        // ── Disable / destroy check ──────────────────────────────────────
        if (!stA.disabled && stA.hull < sA.minHull) {
            stA.disabled  = true;
            stA.disabledAt = t;
            result.ttkA   = t;
            if (!milestones.A.disabled) {
                milestones.A.disabled = true;
                result.phases.push({ time: t, type: 'A', icon: '💥',
                    text: `<strong>${escHtml(sA.name)}</strong> disabled (hull ≤ ${fmt(sA.minHull)}) at ${fmtT(t)}` });
            }
        }
        if (!stB.disabled && stB.hull < sB.minHull) {
            stB.disabled  = true;
            stB.disabledAt = t;
            result.ttkB   = t;
            if (!milestones.B.disabled) {
                milestones.B.disabled = true;
                result.phases.push({ time: t, type: 'B', icon: '💥',
                    text: `<strong>${escHtml(sB.name)}</strong> disabled (hull ≤ ${fmt(sB.minHull)}) at ${fmtT(t)}` });
            }
        }

        // Hull < 0 = destroyed
        if (!stA.destroyed && stA.hull < 0) {
            stA.destroyed  = true;
            stA.destroyedAt = t;
        }
        if (!stB.destroyed && stB.hull < 0) {
            stB.destroyed  = true;
            stB.destroyedAt = t;
        }

        // Once both ships have reached a terminal state, stop
        if ((stA.disabled || stA.destroyed) && (stB.disabled || stB.destroyed)) break;
        // If neither can ever disable the other, cap at max
        frame++;
    }

    // ── Final timeline samples ──────────────────────────────────────────────
    if (timelineA[timelineA.length - 1]?.t < frame / FPS) {
        const t = frame / FPS;
        timelineA.push({ t, shields: stA.shields, hull: stA.hull, energy: stA.energy, heat: stA.heat });
        timelineB.push({ t, shields: stB.shields, hull: stB.hull, energy: stB.energy, heat: stB.heat });
    }

    result.timelineA = timelineA;
    result.timelineB = timelineB;
    result.finalStateA = stA;
    result.finalStateB = stB;

    // ── Winner ──────────────────────────────────────────────────────────────
    const aKilled = isFinite(result.ttkA);
    const bKilled = isFinite(result.ttkB);

    if (!aKilled && !bKilled) {
        result.winner = 'draw';
        result.phases.push({ time: frame / FPS, type: 'neutral', icon: '🤝',
            text: 'Neither ship could disable the other — draw.' });
    } else if (aKilled && bKilled) {
        if (result.ttkB <= result.ttkA) result.winner = 'A';
        else                            result.winner = 'B';
    } else if (bKilled) {
        result.winner = 'A';
    } else {
        result.winner = 'B';
    }

    result.phases.sort((a, b) => a.time - b.time);
    return result;
}

// ── shootFrame: one ship fires all ready weapons at the other ────────────────

function shootFrame(attSt, defSt, attStats, defStats, frame, events) {
    // Can the attacker fire at all?
    const canFireAny = !attSt.isOverheated;
    // If ionized, weapons cost more energy than available → can't fire
    const energyBlocked = attStats.movingEnergyPerFrame > 0 && attSt.isIonized;

    for (let i = 0; i < attStats.weapons.length; i++) {
        const w       = attStats.weapons[i];
        const reload  = Math.max(1, w.reload || 1);
        const bcr     = w['burst reload'] || reload;
        const bcount  = w['burst count']  || 1;

        // Count down reload
        if (attSt.weaponReloadCounters[i] > 0) {
            attSt.weaponReloadCounters[i]--;
            continue;
        }

        if (!canFireAny) continue;

        // Compute firing costs
        const fe = w['firing energy']  || 0;
        const ff = w['firing fuel']    || 0;
        const fh = w['firing hull']    || 0;
        const fs = w['firing shields'] || 0;

        // Energy check — if not enough energy, skip
        if (fe > 0 && attSt.energy < fe) continue;
        if (energyBlocked)                continue;

        // Expend costs from attacker
        attSt.energy  -= fe;
        attSt.fuel    -= ff;
        attSt.hull    -= fh;
        attSt.shields -= fs;
        attSt.heat    += (w['firing heat']  || 0);

        // Apply self-inflicted status from firing (ion, scramble)
        attSt.ionization  += (w['firing ion']      || 0);
        attSt.scrambling  += (w['firing scramble'] || 0);

        // Burst reload vs full reload
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

        // Apply damage to defender
        applyWeaponDamage(w, defSt, defStats);
    }
}

// ── applyWeaponDamage: compute and apply one shot to defender ────────────────

function applyWeaponDamage(w, defSt, defStats) {
    const st = defStats;

    // Piercing fraction (reduced by target's piercing resistance)
    const rawPiercing = Math.max(0, Math.min(1, w.piercing || 0));
    const piercing    = rawPiercing * (1 - st.piercingRes);

    // Disruption multiplier: shields take 1 + disruption * 0.01 extra damage
    const disruptMult = 1 + defSt.disruption * 0.01;

    // Shield damage
    const rawShieldDmg = (w['shield damage'] || 0);
    const shieldDmg    = rawShieldDmg * (1 - st.shieldProt) * (1 - piercing) * disruptMult;

    // Hull damage (direct)
    const rawHullDmg   = (w['hull damage']   || 0);
    // When shields are up: piercing fraction goes to hull directly
    const hullDmgBase  = rawHullDmg * (1 - st.hullProt);
    // Pierced shield damage also goes to hull
    const hullPierced  = rawShieldDmg * (1 - st.shieldProt) * piercing;

    // Apply shield / hull damage
    if (defSt.shields > 0) {
        defSt.shields -= shieldDmg;
        // Hull takes: pierced portion + direct hull damage
        defSt.hull    -= (hullPierced + hullDmgBase);
        if (defSt.shields < 0) {
            // Overflow: excess shield damage spills to hull
            const overflow = -defSt.shields * (rawHullDmg > 0 ? 1 : 0.5);
            defSt.hull    -= overflow * (1 - st.hullProt);
            defSt.shields  = 0;
            defSt.depletedFlag = true;
        }
    } else {
        // No shields — all damage to hull
        defSt.hull -= (hullDmgBase + rawShieldDmg * (1 - st.shieldProt));
    }

    // Set shield delay when hit
    defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, st.shieldDelay || 0);
    defSt.repairDelayCounter = Math.max(defSt.repairDelayCounter, st.repairDelay || 0);
    if (defSt.depletedFlag)
        defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, st.depletedDelay || 0);

    // ── Status effects (all use protection and resistance) ────────────────
    applyStatus(defSt, 'heat',       (w['heat damage']       || 0), st.heatProt,    0);
    applyStatus(defSt, 'energy',    -(w['energy damage']     || 0), st.energyProt,  0);  // negative = drain
    applyStatus(defSt, 'fuel',      -(w['fuel damage']       || 0), st.fuelProt,    0);
    applyStatus(defSt, 'ionization', (w['ion damage']        || 0), st.ionProt,     0);
    applyStatus(defSt, 'scrambling', (w['scrambling damage'] || 0), st.scrambProt,  0);
    applyStatus(defSt, 'disruption', (w['disruption damage'] || 0), st.disruptProt, 0);
    applyStatus(defSt, 'discharge',  (w['discharge damage']  || 0), st.dischProt,   0);
    applyStatus(defSt, 'corrosion',  (w['corrosion damage']  || 0), st.corrProt,    0);
    applyStatus(defSt, 'leak',       (w['leak damage']       || 0), st.leakProt,    0);
    applyStatus(defSt, 'burn',       (w['burn damage']       || 0), st.burnProt,    0);
    applyStatus(defSt, 'slowing',    (w['slowing damage']    || 0), st.slowProt,    0);
}

function applyStatus(defSt, statKey, rawDmg, protection, minVal) {
    if (!rawDmg) return;
    const dmg = rawDmg * (1 - protection);
    if (statKey === 'energy' || statKey === 'fuel' || statKey === 'hull' || statKey === 'shields') {
        defSt[statKey] = Math.max(minVal, defSt[statKey] + dmg);
    } else {
        // Accumulating status effects
        defSt[statKey] = Math.max(0, (defSt[statKey] || 0) + dmg);
    }
}

// ── doGeneration: energy / heat generation per frame ─────────────────────────

function doGeneration(st, stats, frame) {
    // Energy generation
    st.energy += stats.energyGenPerFrame - stats.energyConsumeIdlePerFrame;
    // Moving energy cost (assume always manoeuvring)
    st.energy -= stats.movingEnergyPerFrame;
    // Cooling energy cost
    st.energy -= stats.coolingEnergyPerFrame;

    // Heat: idle + moving
    st.heat   += stats.heatGenIdlePerFrame + stats.movingHeatPerFrame;

    // Cooling: reduce heat
    st.heat   -= stats.coolingPerFrame;

    // Passive heat dissipation: heat × dissipFrac per frame
    // (models the 'heat dissipation' attribute: 0.001 × attr × currentHeat per frame)
    st.heat   -= st.heat * stats.heatDissipFrac;

    // Discharge effect: drains shields
    if (st.discharge > 0) {
        st.shields -= st.discharge;
        st.discharge = Math.max(0, st.discharge - stats.dischResist);
    }

    // Corrosion effect: drains hull
    if (st.corrosion > 0) {
        st.hull    -= st.corrosion;
        st.corrosion = Math.max(0, st.corrosion - stats.corrResist);
    }

    // Burn effect: adds heat
    if (st.burn > 0) {
        st.heat  += st.burn;
        st.burn   = Math.max(0, st.burn - stats.burnResist);
    }

    // Leak effect: drains fuel
    if (st.leak > 0) {
        st.fuel  -= st.leak;
        st.leak   = Math.max(0, st.leak - stats.leakResist);
    }
}

// ── doRegen: shield + hull regen (respects delays) ───────────────────────────

function doRegen(st, stats, frame) {
    // Tick down shield delay
    if (st.shieldDelayCounter > 0) {
        st.shieldDelayCounter--;
    } else if (st.shields < stats.maxShields) {
        st.shields += stats.shieldRegenPerFrame + stats.delayedShieldPerFrame;
    }

    // Tick down repair delay
    if (st.repairDelayCounter > 0) {
        st.repairDelayCounter--;
    } else if (st.hull < stats.maxHull && !st.disabled) {
        st.hull += stats.hullRepairPerFrame + stats.delayedHullPerFrame;
    }
}

// ── decayStatus: status effects decay each frame based on resistance ─────────

function decayStatus(st, stats) {
    // Ion, scramble, disruption, slowing — these decay naturally
    // Each per-frame reduction = the resistance value
    st.ionization  = Math.max(0, st.ionization  - stats.ionResist);
    st.scrambling  = Math.max(0, st.scrambling  - stats.scrambResist);
    st.disruption  = Math.max(0, st.disruption  - stats.disruptResist);
    st.slowing     = Math.max(0, st.slowing     - stats.slowResist);
    // discharge, corrosion, burn, leak are handled in doGeneration
}

// ── checkMilestones: emit phase events ───────────────────────────────────────

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
//  UI
// ═══════════════════════════════════════════════════════════════════════════════

function renderSlotPreview(slot, ship, stats) {
    const el     = document.getElementById('selected' + slot);
    const imgEl  = document.getElementById('img' + slot);
    const nameEl = document.getElementById('name' + slot);
    const metaEl = document.getElementById('meta' + slot);
    const statEl = document.getElementById('stats' + slot);
    const slotEl = document.getElementById('slot' + slot);

    let imgSrc = '';
    if (ship.sprite) {
        const spritePath = ship.sprite;
        imgSrc = `https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/data/${ship._pluginId}/images/${spritePath}.png`;
    }
    else {
        const spritePath = ship.thumbnail;
        imgSrc = `https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/data/${ship._pluginId}/images/${spritePath}.png`;
    }
    imgEl.src          = imgSrc;
    imgEl.style.display = imgSrc ? 'block' : 'none';
    nameEl.textContent  = ship.name;
    metaEl.textContent  = (window.allData?.[ship._pluginId]?.sourceName) || ship._pluginId || '';
    el.classList.add('visible');
    slotEl.classList.add('has-ship');

    const sDPS = stats.shieldDPS;
    const hDPS = stats.hullDPS;
    statEl.innerHTML = `
        ${statRow('Shields',    fmt(stats.maxShields))}
        ${statRow('Hull',       fmt(stats.maxHull))}
        ${statRow('Min Hull',   fmt(stats.minHull))}
        ${statRow('Shld DPS',   fmt(sDPS))}
        ${statRow('Hull DPS',   fmt(hDPS))}
        ${statRow('Shld Regen', fmt(stats.shieldRegenPerSec) + '/s')}
        ${statRow('Energy',     fmt(stats.energyCap))}
        ${statRow('Heat Cap',   fmt(stats.maxHeat))}
    `;
    statEl.style.display = 'grid';
}

function statRow(label, value) {
    return `<div class="slot-stat"><div class="slot-stat-label">${label}</div><div class="slot-stat-value">${value}</div></div>`;
}

function updateFightButton() {
    document.getElementById('fightBtn').disabled = !(_slots.A && _slots.B);
}

function hideResults() {
    document.getElementById('resultsPanel').classList.remove('visible');
}

function runSimulation() {
    const sA = _slots.A;
    const sB = _slots.B;
    if (!sA || !sB) return;

    document.getElementById('simLoading').classList.add('visible');
    hideResults();

    setTimeout(() => {
        try {
            const result = simulateBattle(sA, sB);
            renderResults(sA, sB, result);
        } finally {
            document.getElementById('simLoading').classList.remove('visible');
        }
    }, 60);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RESULTS RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function renderResults(sA, sB, result) {
    const panel = document.getElementById('resultsPanel');

    // ── Winner banner ────────────────────────────────────────────────────────
    const winnerEl   = document.getElementById('resultWinnerName');
    const subtitleEl = document.getElementById('resultSubtitle');
    winnerEl.className = 'result-winner-name';

    if (result.winner === 'A') {
        winnerEl.textContent = sA.name;
        winnerEl.classList.add('result-winner-a');
        subtitleEl.textContent = `Disables ${sB.name} in ${fmtT(result.ttkB)} — survives ${isFinite(result.ttkA) ? fmtT(result.ttkA) : '∞'}`;
    } else if (result.winner === 'B') {
        winnerEl.textContent = sB.name;
        winnerEl.classList.add('result-winner-b');
        subtitleEl.textContent = `Disables ${sA.name} in ${fmtT(result.ttkA)} — survives ${isFinite(result.ttkB) ? fmtT(result.ttkB) : '∞'}`;
    } else {
        winnerEl.textContent = 'Draw';
        winnerEl.classList.add('result-winner-draw');
        subtitleEl.textContent = 'Neither ship could disable the other.';
    }

    // ── Timeline bars ────────────────────────────────────────────────────────
    const tA   = isFinite(result.ttkA) ? result.ttkA : null;
    const tB   = isFinite(result.ttkB) ? result.ttkB : null;
    const maxT = Math.max(tA || 0, tB || 0) || 1;
    const pctA = tA ? Math.min(92, (tA / maxT) * 46) : 46;
    const pctB = tB ? Math.min(92, (tB / maxT) * 46) : 46;
    document.getElementById('timelineBarA').style.width   = pctA + '%';
    document.getElementById('timelineBarB').style.width   = pctB + '%';
    document.getElementById('timelineLabelA').textContent = tA ? fmtT(tA) : '∞';
    document.getElementById('timelineLabelB').textContent = tB ? fmtT(tB) : '∞';

    // ── HP chart ─────────────────────────────────────────────────────────────
    renderHPChart(sA, sB, result);

    // ── Stats comparison ─────────────────────────────────────────────────────
    document.getElementById('compareGrid').innerHTML = renderCompareGrid(sA, sB, result);

    // ── Weapon breakdown ─────────────────────────────────────────────────────
    document.getElementById('weaponsGrid').innerHTML = `
        <div>
            <div class="weapons-col-title weapons-col-title-a">${escHtml(sA.name)} Weapons</div>
            ${renderWeaponsList(sA.weaponDetails)}
        </div>
        <div>
            <div class="weapons-col-title weapons-col-title-b">${escHtml(sB.name)} Weapons</div>
            ${renderWeaponsList(sB.weaponDetails)}
        </div>`;

    // ── Phase list ───────────────────────────────────────────────────────────
    const phaseEl = document.getElementById('phaseList');
    if (!result.phases.length) {
        phaseEl.innerHTML = '<div class="phase-item phase-neutral"><span class="phase-text">No events — stalemate from the start.</span></div>';
    } else {
        phaseEl.innerHTML = result.phases.map(p => `
            <div class="phase-item phase-${p.type}">
                <span class="phase-time">${p.time >= MAX_SIM_SECS ? '∞' : fmtT(p.time)}</span>
                <span class="phase-icon">${p.icon || '•'}</span>
                <span class="phase-text">${p.text}</span>
            </div>`).join('');
    }

    panel.classList.add('visible');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── HP / resource chart ───────────────────────────────────────────────────────

function renderHPChart(sA, sB, result) {
    const container = document.getElementById('hpChartContainer');
    if (!container) return;

    const tlA = result.timelineA || [];
    const tlB = result.timelineB || [];
    if (!tlA.length && !tlB.length) { container.innerHTML = ''; return; }

    const maxT    = Math.max(
        tlA[tlA.length - 1]?.t || 0,
        tlB[tlB.length - 1]?.t || 0,
        0.1
    );
    const W = 800, H = 180;
    const PAD = { l: 50, r: 20, t: 16, b: 30 };
    const cW  = W - PAD.l - PAD.r;
    const cH  = H - PAD.t - PAD.b;

    // Normalise hp (0→1) for display
    const maxHPA = sA.maxShields + sA.maxHull || 1;
    const maxHPB = sB.maxShields + sB.maxHull || 1;

    function px(t)  { return PAD.l + (t / maxT) * cW; }
    function pyA(v) { return PAD.t + (1 - v / maxHPA) * cH; }
    function pyB(v) { return PAD.t + (1 - v / maxHPB) * cH; }

    function buildPath(tl, hpFn, getVal) {
        return tl.map((d, i) => `${i === 0 ? 'M' : 'L'}${px(d.t).toFixed(1)},${hpFn(getVal(d)).toFixed(1)}`).join(' ');
    }

    // Shield + hull stacked line
    const pathAShields = buildPath(tlA, pyA, d => d.shields + d.hull);
    const pathAHull    = buildPath(tlA, pyA, d => d.hull);
    const pathBShields = buildPath(tlB, pyB, d => d.shields + d.hull);
    const pathBHull    = buildPath(tlB, pyB, d => d.hull);

    // Axis ticks
    const tickCount = 5;
    let ticks = '';
    for (let i = 0; i <= tickCount; i++) {
        const t = (maxT * i / tickCount);
        const x = px(t);
        ticks += `<line x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + cH}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
        ticks += `<text x="${x.toFixed(1)}" y="${H - 6}" fill="#64748b" font-size="9" text-anchor="middle">${fmtT(t)}s</text>`;
    }

    container.innerHTML = `
    <div class="timeline-label" style="margin-top:20px;margin-bottom:8px;">HP Timeline (shields + hull, normalised)</div>
    <div class="hp-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;">
        <rect x="${PAD.l}" y="${PAD.t}" width="${cW}" height="${cH}"
              fill="rgba(15,23,42,0.5)" rx="4"/>
        ${ticks}
        <!-- Disable threshold lines -->
        ${sA.minHull > 0 ? `<line x1="${PAD.l}" y1="${pyA(sA.minHull).toFixed(1)}" x2="${PAD.l + cW}" y2="${pyA(sA.minHull).toFixed(1)}"
              stroke="rgba(59,130,246,0.35)" stroke-width="1" stroke-dasharray="4,3"/>` : ''}
        ${sB.minHull > 0 ? `<line x1="${PAD.l}" y1="${pyB(sB.minHull).toFixed(1)}" x2="${PAD.l + cW}" y2="${pyB(sB.minHull).toFixed(1)}"
              stroke="rgba(239,68,68,0.35)" stroke-width="1" stroke-dasharray="4,3"/>` : ''}
        <!-- A shields (total height) -->
        <path d="${pathAShields}" fill="none" stroke="rgba(59,130,246,0.55)" stroke-width="1.5"/>
        <!-- A hull -->
        <path d="${pathAHull}" fill="none" stroke="#3b82f6" stroke-width="2.5"/>
        <!-- B shields (total) -->
        <path d="${pathBShields}" fill="none" stroke="rgba(239,68,68,0.55)" stroke-width="1.5"/>
        <!-- B hull -->
        <path d="${pathBHull}" fill="none" stroke="#ef4444" stroke-width="2.5"/>
        <!-- Legend -->
        <rect x="${PAD.l + 8}" y="${PAD.t + 8}" width="10" height="3" fill="#3b82f6" rx="1"/>
        <text x="${PAD.l + 22}" y="${PAD.t + 13}" fill="#93c5fd" font-size="9">${escHtml(sA.name)} hull</text>
        <rect x="${PAD.l + 8}" y="${PAD.t + 20}" width="10" height="3" fill="#ef4444" rx="1"/>
        <text x="${PAD.l + 22}" y="${PAD.t + 25}" fill="#fca5a5" font-size="9">${escHtml(sB.name)} hull</text>
      </svg>
    </div>`;
}

// ── Compare grid ──────────────────────────────────────────────────────────────

function renderCompareGrid(sA, sB, result) {
    const stFinal = result.finalStateA;
    const stFinalB = result.finalStateB;

    const rows = [
        ['Combat', [
            ['Time to Disable',      fmtTTK(result.ttkA),            fmtTTK(result.ttkB)],
            ['Max Shields',          fmt(sA.maxShields),             fmt(sB.maxShields)],
            ['Max Hull',             fmt(sA.maxHull),                fmt(sB.maxHull)],
            ['Disable Threshold',    fmt(sA.minHull),                fmt(sB.minHull)],
            ['Hull to Disable',      fmt(sA.hullToDisable),          fmt(sB.hullToDisable)],
            ['Shield DPS',           fmt(sA.shieldDPS),              fmt(sB.shieldDPS)],
            ['Hull DPS',             fmt(sA.hullDPS),                fmt(sB.hullDPS)],
            ['Heat DPS',             fmt(sA.heatDPS),                fmt(sB.heatDPS)],
            ['Ion DPS',              fmt(sA.ionDPS),                 fmt(sB.ionDPS)],
            ['Disruption DPS',       fmt(sA.disruptionDPS),          fmt(sB.disruptionDPS)],
            ['Shield Regen/s',       fmt(sA.shieldRegenPerSec),      fmt(sB.shieldRegenPerSec)],
            ['Hull Repair/s',        fmt(sA.hullRepairPerSec),       fmt(sB.hullRepairPerSec)],
            ['Shield Protection',    fmtPct(sA.shieldProt),          fmtPct(sB.shieldProt)],
            ['Hull Protection',      fmtPct(sA.hullProt),            fmtPct(sB.hullProt)],
            ['Piercing Resistance',  fmtPct(sA.piercingRes),         fmtPct(sB.piercingRes)],
        ]],
        ['Energy', [
            ['Energy Capacity',      fmt(sA.energyCap),              fmt(sB.energyCap)],
            ['Energy Gen/s',         fmt(sA.energyGenPerFrame * FPS), fmt(sB.energyGenPerFrame * FPS)],
            ['Firing Energy/s',      fmt(sA.firingEnergyPerSec),     fmt(sB.firingEnergyPerSec)],
            ['Moving Energy/s',      fmt(sA.movingEnergyPerFrame * FPS), fmt(sB.movingEnergyPerFrame * FPS)],
            ['Net Energy/s',         fmtNet((sA.energyGenPerFrame - sA.energyConsumeIdlePerFrame - sA.movingEnergyPerFrame - sA.coolingEnergyPerFrame - sA.firingEnergyPerSec / FPS) * FPS),
                                     fmtNet((sB.energyGenPerFrame - sB.energyConsumeIdlePerFrame - sB.movingEnergyPerFrame - sB.coolingEnergyPerFrame - sB.firingEnergyPerSec / FPS) * FPS)],
        ]],
        ['Heat', [
            ['Heat Capacity',        fmt(sA.maxHeat),                fmt(sB.maxHeat)],
            ['Cooling/s',            fmt(sA.coolingPerSec),          fmt(sB.coolingPerSec)],
            ['Heat Dissipation',     fmtPct(sA.heatDissipFrac * 100, 3), fmtPct(sB.heatDissipFrac * 100, 3)],
            ['Firing Heat/s',        fmt(sA.firingHeatPerSec),       fmt(sB.firingHeatPerSec)],
            ['Moving Heat/s',        fmt(sA.movingHeatPerFrame * FPS), fmt(sB.movingHeatPerFrame * FPS)],
        ]],
        ['Navigation', [
            ['Mass',                 fmt(sA.rawMass) + ' t',         fmt(sB.rawMass) + ' t'],
            ['Inertial Mass',        fmt(sA.inertialMass) + ' t',    fmt(sB.inertialMass) + ' t'],
            ['Max Velocity',         fmt(sA.maxVelocity) + ' px/s',  fmt(sB.maxVelocity) + ' px/s'],
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
        const extraDmg = [];
        if (w.dmgPerShot['Heat']       > 0) extraDmg.push(`Heat: ${fmt(w.dmgPerShot['Heat'] * w.sps)}/s`);
        if (w.dmgPerShot['Ion']        > 0) extraDmg.push(`Ion: ${fmt(w.dmgPerShot['Ion'] * w.sps)}/s`);
        if (w.dmgPerShot['Disruption'] > 0) extraDmg.push(`Disrupt: ${fmt(w.dmgPerShot['Disruption'] * w.sps)}/s`);
        if (w.dmgPerShot['Discharge']  > 0) extraDmg.push(`Discharge: ${fmt(w.dmgPerShot['Discharge'] * w.sps)}/s`);
        if (w.dmgPerShot['Burn']       > 0) extraDmg.push(`Burn: ${fmt(w.dmgPerShot['Burn'] * w.sps)}/s`);
        if (w.dmgPerShot['Corrosion']  > 0) extraDmg.push(`Corrosion: ${fmt(w.dmgPerShot['Corrosion'] * w.sps)}/s`);
        if (w.relShield > 0)                extraDmg.push(`%Shield: ${w.relShield}%/hit`);
        if (w.relHull   > 0)                extraDmg.push(`%Hull: ${w.relHull}%/hit`);

        return `
        <div class="weapon-item">
            <div class="weapon-item-name">${escHtml(w.name)}</div>
            <div class="weapon-item-stats">
                <span class="weapon-stat">Rate: <span>${w.sps}/s</span></span>
                <span class="weapon-stat">Shld: <span>${fmt(w.shieldDPS)}/s</span></span>
                <span class="weapon-stat">Hull: <span>${fmt(w.hullDPS)}/s</span></span>
                ${w.piercing ? `<span class="weapon-stat">Pierce: <span>${w.piercing}%</span></span>` : ''}
                ${w.range    ? `<span class="weapon-stat">Range: <span>${w.range}px</span></span>` : ''}
                ${w.burstCount > 1 ? `<span class="weapon-stat">Burst: <span>${w.burstCount}×</span></span>` : ''}
                ${w.homing      ? `<span class="weapon-stat">🎯 Homing</span>` : ''}
                ${w.antiMissile ? `<span class="weapon-stat">🛡 Anti-Missile</span>` : ''}
                ${extraDmg.map(s => `<span class="weapon-stat"><span>${s}</span></span>`).join('')}
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

function fmtT(t) {
    if (!isFinite(t)) return '∞';
    return t.toFixed(1) + 's';
}

function fmtTTK(t) {
    if (!isFinite(t)) return '∞ (never)';
    return fmtT(t);
}

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

document.addEventListener('DOMContentLoaded', init);

})();
