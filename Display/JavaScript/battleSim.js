/**
 * BattleSim.js
 * Endless Sky Battle Simulator
 *
 * Analytical combat model — no frame-by-frame loop needed for the core
 * prediction, but uses a lightweight phase simulation for the timeline.
 *
 * All formulas derived from ES C++ source (Ship.cpp, Weapon.cpp).
 * Zero hardcoded ship/outfit names.
 *
 * Dependencies:
 *   ComputedStats.js  — resolveShipFunctions, accumulateOutfits, evalFormula
 *   generalPluginStuff.js — PluginManager, allData
 */
(function () {
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const FPS         = 60;
const SOLAR_POWER = 1.0;
const MAX_SIM_SECS = 3600;

const REPO_URL = 'GIVEMEFOOD5/endless-sky-ship-builder';
const BASE_URL = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;

// ── State ────────────────────────────────────────────────────────────────────
let _allShips    = [];
let _outfitIndex = {};
let _attrDefs    = null;

const _slots = { A: null, B: null };

// ── Data loading (mirrors DataViewer.loadData exactly) ────────────────────────

async function loadData() {
    setStatus('Loading plugin data…');

    // attrDefs
    try {
        const res = await fetch(`${BASE_URL}/attributeDefinitions.json`);
        if (res.ok) {
            _attrDefs = await res.json();
            if (typeof initComputedStats === 'function') initComputedStats(_attrDefs, BASE_URL);
        }
    } catch (_) {}

    // index.json — determines plugin list and order
    let dataIndex;
    try {
        const res = await fetch(`${BASE_URL}/index.json`);
        if (!res.ok) throw new Error('Could not fetch index.json');
        dataIndex = await res.json();
    } catch (err) {
        setStatus(`Error: ${err.message}`, true);
        return;
    }

    // Record index order for outfit fallback lookup
    window._indexPluginOrder = [];
    for (const pluginList of Object.values(dataIndex)) {
        for (const { outputName } of pluginList)
            window._indexPluginOrder.push(outputName);
    }

    // Load all plugins (same logic as DataViewer)
    window.allData = {};
    for (const [sourceName, pluginList] of Object.entries(dataIndex)) {
        for (const { outputName, displayName } of pluginList) {
            const pluginData = {
                sourceName, displayName, outputName,
                ships: [], variants: [], outfits: [], effects: [],
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

    // Hook _renderCardsFromManager so PluginManager can notify us of changes
    window._renderCardsFromManager = async () => { await onPluginsChanged(); };

    await PluginManager.initDefaultPlugin();
}

function setStatus(msg, isError = false) {
    let el = document.getElementById('simStatus');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--c-danger-text)' : 'var(--c-text-muted)';
    el.style.display = msg ? 'block' : 'none';
}

// ── Init (entry point) ────────────────────────────────────────────────────────

async function init() {
    await loadData();
}

async function onPluginsChanged() {
    // Rebuild ship + outfit lists from active plugins
    _allShips    = [];
    _outfitIndex = {};

    const activePlugins = PluginManager.getActivePlugins();
    const allData       = window.allData || {};
    const indexOrder    = window._indexPluginOrder || [];

    // Build outfit index: active plugins first, then index order
    const searchOrder = [
        ...activePlugins,
        ...indexOrder.filter(id => !activePlugins.includes(id) && allData[id]),
        ...Object.keys(allData).filter(id => !activePlugins.includes(id) && !indexOrder.includes(id)),
    ];
    for (const pid of searchOrder) {
        const d = allData[pid];
        if (!d) continue;
        for (const outfit of (d.outfits || [])) {
            if (outfit.name && !_outfitIndex[outfit.name]) {
                _outfitIndex[outfit.name] = { ...outfit, _pluginId: pid };
            }
        }
    }

    // Collect ships from active plugins
    for (const pid of activePlugins) {
        const d = allData[pid];
        if (!d) continue;
        for (const ship of [...(d.ships || []), ...(d.variants || [])]) {
            _allShips.push({ ...ship, _pluginId: pid });
        }
    }

    document.getElementById('simPanel').style.display = 'block';
    updateFightButton();
}

// ── Ship search ───────────────────────────────────────────────────────────────

let _blurTimers = { A: null, B: null };

function searchShips(slot, query) {
    const lq  = (query || '').toLowerCase().trim();
    const dd  = document.getElementById('dropdown' + slot);
    dd.innerHTML = '';

    const hits = lq.length < 1
        ? _allShips.slice(0, 80)
        : _allShips.filter(s => s.name?.toLowerCase().includes(lq)).slice(0, 80);

    if (!hits.length) {
        dd.innerHTML = '<div class="ship-dropdown-empty">No ships found</div>';
    } else {
        for (const ship of hits) {
            const row = document.createElement('div');
            row.className = 'ship-dropdown-item';
            const pluginLabel = (window.allData?.[ship._pluginId]?.sourceName || ship._pluginId) || '';
            row.innerHTML = `<span>${escHtml(ship.name)}</span><span class="sdi-plugin">${escHtml(pluginLabel)}</span>`;
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

    // Resolve stats
    const stats = resolveShipStats(ship);
    _slots[slot] = stats;

    renderSlotPreview(slot, ship, stats);
    updateFightButton();

    // Clear old results
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

// ── Ship stat resolution ──────────────────────────────────────────────────────

function resolveShipStats(ship) {
    // 1. Accumulate outfit attributes
    const baseAttrs = ship.attributes || {};
    const outfitMap = ship.outfitMap  || {};

    const attrDefs  = _attrDefs?.attributes || {};
    const combined  = { ...baseAttrs };

    // Collect weapons as separate list
    const weapons = [];

    for (const [outfitName, qty] of Object.entries(outfitMap)) {
        const outfit = _outfitIndex[outfitName];
        if (!outfit) continue;

        // Weapon outfits
        if (outfit.weapon) {
            for (let i = 0; i < qty; i++) weapons.push({ name: outfitName, ...outfit.weapon });
        }

        // Attribute accumulation (mirrors ComputedStats.accumulateOutfits)
        const outfitAttrs = (outfit.attributes && Object.keys(outfit.attributes).length)
            ? outfit.attributes : outfit;
        for (const [key, rawVal] of Object.entries(outfitAttrs)) {
            if (typeof rawVal !== 'number' || key.startsWith('_')) continue;
            const stacking = attrDefs[key]?.stacking || 'additive';
            const contrib  = rawVal * qty;
            if (stacking === 'maximum') combined[key] = Math.max(combined[key] ?? -Infinity, contrib);
            else if (stacking === 'minimum') combined[key] = Math.min(combined[key] ?? Infinity, contrib);
            else combined[key] = (combined[key] || 0) + contrib;
        }
    }

    // 2. Resolve ship functions (use ComputedStats if available, else inline)
    const fnCache = resolveCoreFns(combined);

    // 3. Build the stats object
    const mass         = combined['mass'] || 1;
    const inertiaRed   = combined['inertia reduction'] || 0;
    const inertialMass = mass / (1 + inertiaRed);
    const dragRaw      = combined['drag'] || 0;
    const dragEff      = dragRaw / (1 + (combined['drag reduction'] || 0));
    const drag         = Math.min(dragEff, mass);

    const maxShields   = (combined['shields'] || 0) * (1 + (combined['shield multiplier'] || 0));
    const maxHull      = (combined['hull'] || 0) * (1 + (combined['hull multiplier'] || 0));

    // Disable threshold
    const threshPct    = combined['threshold percentage'] || 0;
    const hullThresh   = combined['hull threshold'] || 0;
    const absThresh    = combined['absolute threshold'] || 0;
    let minHull;
    if (absThresh) minHull = absThresh;
    else minHull = Math.max(0, Math.floor(threshPct * maxHull + hullThresh));

    // Shield generation per second (in combat, regen only works when NOT being hit)
    const shieldRegen  = (combined['shield generation'] || 0) * FPS;
    const hullRepair   = (combined['hull repair rate']  || 0) * FPS;
    const shieldDelay  = combined['shield delay']  || 0; // frames
    const repairDelay  = combined['repair delay']  || 0;

    // Protection factors
    const shieldProt   = Math.max(0, 1 - (combined['shield protection'] || 0));
    const hullProt     = Math.max(0, 1 - (combined['hull protection']   || 0));

    // Energy
    const energyCap    = combined['energy capacity'] || 0;
    const energyGen    = ((combined['energy generation'] || 0)
                        + (combined['solar collection'] || 0) * SOLAR_POWER
                        + (combined['fuel energy']      || 0)) * FPS;

    // Heat
    const maxHeat      = 100 * (mass + (combined['heat capacity'] || 0));
    const heatGenIdle  = (combined['heat generation'] || 0) * FPS;
    const coolEff      = computeCoolingEfficiency(combined['cooling inefficiency'] || 0);
    const coolingPerS  = coolEff * ((combined['cooling'] || 0) + (combined['active cooling'] || 0)) * FPS;
    const heatDissPct  = 0.001 * (combined['heat dissipation'] || 0); // fraction/frame
    const heatDissPerS = heatDissPct * maxHeat * FPS; // heat units/sec dissipated at full heat

    // Weapon DPS computation
    const weaponStats  = analyzeWeapons(weapons, combined);

    return {
        name:        ship.name,
        pluginId:    ship._pluginId,
        rawShip:     ship,
        combined,
        weapons,

        // HP
        maxShields, maxHull, minHull,
        hullToDisable: Math.max(0, maxHull - minHull),

        // Regen
        shieldRegen, hullRepair,
        shieldDelay, repairDelay,

        // Protection
        shieldProt, hullProt,

        // Energy
        energyCap, energyGen,
        energyConsumeMoving: ((combined['thrusting energy'] || 0) + (combined['turning energy'] || 0)) * FPS,
        energyConsumeIdle:   (combined['energy consumption'] || 0) * FPS,

        // Heat
        maxHeat, heatGenIdle, coolingPerS, heatDissPerS,
        heatConsumeMoving: ((combined['thrusting heat'] || 0) + (combined['turning heat'] || 0)) * FPS,

        // Weapons
        ...weaponStats,

        // Navigation (for display)
        mass, inertialMass, drag,
        acceleration: drag ? combined['thrust'] / inertialMass * (1 + (combined['acceleration multiplier'] || 0)) : 0,
        maxVelocity:  drag ? combined['thrust'] / drag * FPS : 0,
    };
}

// ── Weapon analysis ───────────────────────────────────────────────────────────

function analyzeWeapons(weapons, shipAttrs) {
    if (!weapons.length) return {
        shieldDPS: 0, hullDPS: 0,
        firingEnergyPerSec: 0, firingHeatPerSec: 0, firingFuelPerSec: 0,
        weaponDetails: [],
    };

    let shieldDPS  = 0;
    let hullDPS    = 0;
    let firingE    = 0;
    let firingH    = 0;
    let firingFuel = 0;
    const details  = [];

    for (const w of weapons) {
        const reload   = Math.max(1, w.reload || 1);
        const sps      = FPS / reload; // shots per second

        // Raw damage per shot
        const shieldDmg  = (w['shield damage'] || 0);
        const hullDmg    = (w['hull damage']   || 0);
        const piercing   = Math.max(0, Math.min(1, w['piercing'] || 0));

        // Piercing: (piercing) fraction bypasses shields and hits hull directly
        // (1-piercing) hits shields normally
        // hull always takes (1-piercing)*hull_dmg after shields are down + piercing*hull_dmg
        const shieldContrib = shieldDmg * (1 - piercing) * sps;
        const hullContrib   = (hullDmg + shieldDmg * piercing) * sps;
        // (Note: when shields are up, hullContrib is from piercing only)

        shieldDPS += shieldContrib;
        hullDPS   += hullContrib;
        firingE   += (w['firing energy'] || 0) * sps;
        firingH   += (w['firing heat']   || 0) * sps;
        firingFuel+= (w['firing fuel']   || 0) * sps;

        details.push({
            name:        w.name || 'Unknown Weapon',
            reload,
            sps:         +sps.toFixed(2),
            shieldDPS:   +shieldContrib.toFixed(1),
            hullDPS:     +(hullDmg * sps).toFixed(1),
            piercingPct: +(piercing * 100).toFixed(0),
            range:        w.velocity && w.lifetime ? +(w.velocity * w.lifetime).toFixed(0) : null,
            firingE:     +(w['firing energy'] || 0).toFixed(1),
            firingH:     +(w['firing heat']   || 0).toFixed(1),
            homing:      (w['homing'] || 0) > 0,
            antiMissile: (w['anti-missile'] || 0) > 0,
        });
    }

    return {
        shieldDPS:         +shieldDPS.toFixed(2),
        hullDPS:           +hullDPS.toFixed(2),
        firingEnergyPerSec:+firingE.toFixed(2),
        firingHeatPerSec:  +firingH.toFixed(2),
        firingFuelPerSec:  +firingFuel.toFixed(2),
        weaponDetails:     details,
    };
}

// ── Core fn helpers ───────────────────────────────────────────────────────────

function computeCoolingEfficiency(inefficiency) {
    const x = inefficiency;
    return 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));
}

function resolveCoreFns(attrs) {
    // Minimal inline resolution (full version in ComputedStats.js)
    const mass         = attrs['mass'] || 1;
    const inertiaRed   = attrs['inertia reduction'] || 0;
    const inertialMass = mass / (1 + inertiaRed);
    const dragRaw      = attrs['drag'] || 0;
    const dragEff      = dragRaw / (1 + (attrs['drag reduction'] || 0));
    return { Mass: mass, InertialMass: inertialMass, Drag: Math.min(dragEff, mass) };
}

// ── Simulation ────────────────────────────────────────────────────────────────

function simulateBattle(sA, sB) {
    // Returns detailed battle result
    const result = {
        winner: null,  // 'A', 'B', or 'draw'
        ttkA: Infinity, // time (seconds) for B to kill A
        ttkB: Infinity, // time (seconds) for A to kill B
        phases: [],
        energyWarningA: null,
        energyWarningB: null,
        heatWarningA: null,
        heatWarningB: null,
    };

    const phases = result.phases;

    // ── Energy sustainability checks ─────────────────────────────────────────
    // Total energy consumption while fighting and maneuvering
    const totalEnergyConsumA = sA.energyConsumeIdle + sA.energyConsumeMoving + sA.firingEnergyPerSec;
    const totalEnergyConsumB = sB.energyConsumeIdle + sB.energyConsumeMoving + sB.firingEnergyPerSec;
    const netEnergyA = sA.energyGen - totalEnergyConsumA;
    const netEnergyB = sB.energyGen - totalEnergyConsumB;

    if (netEnergyA < 0 && sA.energyCap > 0) {
        const timeBlackout = sA.energyCap / Math.abs(netEnergyA);
        result.energyWarningA = timeBlackout;
        phases.push({
            time: timeBlackout,
            type: 'A',
            text: `<strong>${escHtml(sA.name)}</strong> runs out of energy and weapons go offline (${fmt(timeBlackout)}s)`,
        });
    }
    if (netEnergyB < 0 && sB.energyCap > 0) {
        const timeBlackout = sB.energyCap / Math.abs(netEnergyB);
        result.energyWarningB = timeBlackout;
        phases.push({
            time: timeBlackout,
            type: 'B',
            text: `<strong>${escHtml(sB.name)}</strong> runs out of energy and weapons go offline (${fmt(timeBlackout)}s)`,
        });
    }

    // ── Heat sustainability checks ────────────────────────────────────────────
    // Heat rate = idle + moving + firing - cooling - passive dissipation
    // Passive dissipation depends on current heat; at equilibrium it equals production.
    // For overheat time, use worst case: dissipation based on starting heat = 0.

    const heatRateA = sA.heatGenIdle + sA.heatConsumeMoving + sA.firingHeatPerSec - sA.coolingPerS;
    const heatRateB = sB.heatGenIdle + sB.heatConsumeMoving + sB.firingHeatPerSec - sB.coolingPerS;

    // Net heat (including passive dissipation at average half-heat)
    const netHeatA = heatRateA - sA.heatDissPerS * 0.5;
    const netHeatB = heatRateB - sB.heatDissPerS * 0.5;

    if (netHeatA > 0 && sA.maxHeat > 0) {
        const timeOverheat = sA.maxHeat / netHeatA;
        result.heatWarningA = timeOverheat;
        phases.push({
            time: timeOverheat,
            type: 'A',
            text: `<strong>${escHtml(sA.name)}</strong> overheats and loses combat effectiveness (${fmt(timeOverheat)}s)`,
        });
    }
    if (netHeatB > 0 && sB.maxHeat > 0) {
        const timeOverheat = sB.maxHeat / netHeatB;
        result.heatWarningB = timeOverheat;
        phases.push({
            time: timeOverheat,
            type: 'B',
            text: `<strong>${escHtml(sB.name)}</strong> overheats and loses combat effectiveness (${fmt(timeOverheat)}s)`,
        });
    }

    // ── TTK calculation ────────────────────────────────────────────────────────
    // Phase 1: Breaking shields
    // In sustained combat, shield regen is suppressed if shield_delay is short
    // (attacker fires at ~1–2s intervals at most, shield_delay = e.g. 45 frames = 0.75s)
    // If shieldDelay (frames) < average time between shots (frames) → regen occurs
    // Average time between shots ≈ reload of fastest weapon
    // For safety, assume regen is suppressed if DPS > 0

    const bDpsToAShields = sB.shieldDPS * sA.shieldProt;
    const bDpsToAHull    = sB.hullDPS   * sA.hullProt;
    const aDpsToBShields = sA.shieldDPS * sB.shieldProt;
    const aDpsToBHull    = sA.hullDPS   * sB.hullProt;

    // Effective regen: only applies if DPS < regen (attacker can't suppress)
    const aShieldNetRegen = (bDpsToAShields > sA.shieldRegen) ? 0 : sA.shieldRegen;
    const bShieldNetRegen = (aDpsToBShields > sB.shieldRegen) ? 0 : sB.shieldRegen;

    // Net DPS after regen
    const bNetDpsToAShields = bDpsToAShields - aShieldNetRegen;
    const aDpsNetToBShields = aDpsToBShields - bShieldNetRegen;

    // Time to break shields
    let tA_shields_broken = Infinity;
    let tB_shields_broken = Infinity;

    if (sA.maxShields > 0 && bNetDpsToAShields > 0) {
        tA_shields_broken = sA.maxShields / bNetDpsToAShields;
        phases.push({
            time: tA_shields_broken,
            type: 'A',
            text: `<strong>${escHtml(sA.name)}</strong>'s shields are broken (${fmt(tA_shields_broken)}s)`,
        });
    } else if (sA.maxShields <= 0) {
        tA_shields_broken = 0; // no shields
    }

    if (sB.maxShields > 0 && aDpsNetToBShields > 0) {
        tB_shields_broken = sB.maxShields / aDpsNetToBShields;
        phases.push({
            time: tB_shields_broken,
            type: 'B',
            text: `<strong>${escHtml(sB.name)}</strong>'s shields are broken (${fmt(tB_shields_broken)}s)`,
        });
    } else if (sB.maxShields <= 0) {
        tB_shields_broken = 0;
    }

    // Phase 2: Hull damage
    // After shields are broken, hull damage begins
    // Hull DPS = hull_dps (direct) + shield_dps * piercing (was already in hullDPS)
    // But now shields are gone, so all shield_dps becomes hull_dps too
    const bFullDpsToAHull = (sB.shieldDPS + sB.hullDPS) * sA.hullProt;
    const aFullDpsToBHull = (sA.shieldDPS + sA.hullDPS) * sB.hullProt;

    // Effective hull regen: hull repair applies unless suppressed
    // Hull repair delay is typically much longer than shield delay (45 frames vs 100+)
    // Assume hull repair is always suppressed in sustained combat for simplicity
    const aHullNetRegen = 0; // bFullDpsToAHull > sA.hullRepair ? 0 : sA.hullRepair;
    const bHullNetRegen = 0; // aFullDpsToBHull > sB.hullRepair ? 0 : sB.hullRepair;

    const bNetDpsToAHull = bFullDpsToAHull - aHullNetRegen;
    const aNetDpsToBHull = aFullDpsToBHull - bHullNetRegen;

    // Total TTK
    if (bNetDpsToAHull > 0 && isFinite(tA_shields_broken)) {
        result.ttkA = tA_shields_broken + sA.hullToDisable / bNetDpsToAHull;
        phases.push({
            time: result.ttkA,
            type: 'A',
            text: `<strong>${escHtml(sA.name)}</strong> is disabled (hull at ${fmt(sA.minHull)}) (${fmt(result.ttkA)}s)`,
        });
    } else if (sA.maxShields <= 0 && bNetDpsToAHull > 0) {
        result.ttkA = sA.hullToDisable / bNetDpsToAHull;
    }

    if (aNetDpsToBHull > 0 && isFinite(tB_shields_broken)) {
        result.ttkB = tB_shields_broken + sB.hullToDisable / aNetDpsToBHull;
        phases.push({
            time: result.ttkB,
            type: 'B',
            text: `<strong>${escHtml(sB.name)}</strong> is disabled (hull at ${fmt(sB.minHull)}) (${fmt(result.ttkB)}s)`,
        });
    } else if (sB.maxShields <= 0 && aNetDpsToBHull > 0) {
        result.ttkB = sB.hullToDisable / aNetDpsToBHull;
    }

    // ── Determine winner ──────────────────────────────────────────────────────
    const eff_ttkA = result.ttkA; // time for B to kill A
    const eff_ttkB = result.ttkB; // time for A to kill B

    if (!isFinite(eff_ttkA) && !isFinite(eff_ttkB)) {
        result.winner = 'draw';
        phases.push({ time: MAX_SIM_SECS, type: 'neutral', text: 'Neither ship can disable the other — draw.' });
    } else if (!isFinite(eff_ttkA)) {
        // A cannot be killed, B can
        result.winner = 'A';
    } else if (!isFinite(eff_ttkB)) {
        // B cannot be killed, A can
        result.winner = 'B';
    } else if (eff_ttkB < eff_ttkA) {
        result.winner = 'A'; // A kills B first
    } else if (eff_ttkA < eff_ttkB) {
        result.winner = 'B'; // B kills A first
    } else {
        result.winner = 'draw'; // simultaneous
    }

    // Sort phases by time
    result.phases.sort((a, b) => a.time - b.time);

    return result;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function renderSlotPreview(slot, ship, stats) {
    const el     = document.getElementById('selected' + slot);
    const imgEl  = document.getElementById('img' + slot);
    const nameEl = document.getElementById('name' + slot);
    const metaEl = document.getElementById('meta' + slot);
    const statEl = document.getElementById('stats' + slot);
    const slotEl = document.getElementById('slot' + slot);

    // Try to get ship image using the GitHub Pages image URL (same pattern as DataViewer)
    const pluginId = ship._pluginId;
    const allData  = window.allData || {};
    let imgSrc = '';
    try {
        if (ship.sprite) {
            const spritePath = ship.sprite.replace(/\s+/g, '_');
            imgSrc = `https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/data/${pluginId}/images/${spritePath}.png`;
        }
    } catch (_) {}

    imgEl.src   = imgSrc;
    imgEl.style.display = imgSrc ? 'block' : 'none';
    nameEl.textContent  = ship.name;
    metaEl.textContent  = allData[pluginId]?.sourceName || pluginId || '';
    el.classList.add('visible');
    slotEl.classList.add('has-ship');

    // Mini stats
    statEl.innerHTML = `
        ${statRow('Shields',    fmt(stats.maxShields))}
        ${statRow('Hull',       fmt(stats.maxHull))}
        ${statRow('Shield DPS', fmt(stats.shieldDPS))}
        ${statRow('Hull DPS',   fmt(stats.hullDPS))}
        ${statRow('Energy/s',   fmt(stats.energyGen))}
        ${statRow('Heat cap',   fmt(stats.maxHeat))}
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

// ── Run simulation ─────────────────────────────────────────────────────────────

function runSimulation() {
    const sA = _slots.A;
    const sB = _slots.B;
    if (!sA || !sB) return;

    document.getElementById('simLoading').classList.add('visible');
    hideResults();

    // Defer so loading indicator can paint
    setTimeout(() => {
        try {
            const result = simulateBattle(sA, sB);
            renderResults(sA, sB, result);
        } finally {
            document.getElementById('simLoading').classList.remove('visible');
        }
    }, 60);
}

// ── Results rendering ─────────────────────────────────────────────────────────

function renderResults(sA, sB, result) {
    const panel = document.getElementById('resultsPanel');

    // ── Winner ──
    const winnerEl    = document.getElementById('resultWinnerName');
    const subtitleEl  = document.getElementById('resultSubtitle');
    winnerEl.className = 'result-winner-name';

    if (result.winner === 'A') {
        winnerEl.textContent  = sA.name;
        winnerEl.classList.add('result-winner-a');
        subtitleEl.textContent = `Disables ${sB.name} in ${fmt(result.ttkB)}s — survives for ${isFinite(result.ttkA) ? fmt(result.ttkA) + 's' : '∞'}`;
    } else if (result.winner === 'B') {
        winnerEl.textContent  = sB.name;
        winnerEl.classList.add('result-winner-b');
        subtitleEl.textContent = `Disables ${sA.name} in ${fmt(result.ttkA)}s — survives for ${isFinite(result.ttkB) ? fmt(result.ttkB) + 's' : '∞'}`;
    } else {
        winnerEl.textContent  = 'Draw';
        winnerEl.classList.add('result-winner-draw');
        subtitleEl.textContent = 'Neither ship can disable the other at these stats.';
    }

    // ── Timeline bars ──
    const tA = isFinite(result.ttkA) ? result.ttkA : null;
    const tB = isFinite(result.ttkB) ? result.ttkB : null;
    const maxT = Math.max(tA || 0, tB || 0) || 1;

    const pctA = tA ? Math.min(95, (tA / maxT) * 50) : 50;  // A's survival bar (left)
    const pctB = tB ? Math.min(95, (tB / maxT) * 50) : 50;  // B's survival bar (right)

    document.getElementById('timelineBarA').style.width   = pctA + '%';
    document.getElementById('timelineBarB').style.width   = pctB + '%';
    document.getElementById('timelineLabelA').textContent = tA ? fmt(tA) + 's' : '∞';
    document.getElementById('timelineLabelB').textContent = tB ? fmt(tB) + 's' : '∞';

    // ── Stats comparison ──
    document.getElementById('compareGrid').innerHTML = renderCompareGrid(sA, sB, result);

    // ── Weapon breakdown ──
    document.getElementById('weaponsGrid').innerHTML = `
        <div>
            <div class="weapons-col-title weapons-col-title-a">${escHtml(sA.name)} Weapons</div>
            ${renderWeaponsList(sA.weaponDetails)}
        </div>
        <div>
            <div class="weapons-col-title weapons-col-title-b">${escHtml(sB.name)} Weapons</div>
            ${renderWeaponsList(sB.weaponDetails)}
        </div>
    `;

    // ── Phases ──
    const phaseListEl = document.getElementById('phaseList');
    if (result.phases.length === 0) {
        phaseListEl.innerHTML = '<div class="phase-item phase-neutral"><span class="phase-text">No significant events — stalemate from the start.</span></div>';
    } else {
        phaseListEl.innerHTML = result.phases.map(p => `
            <div class="phase-item phase-${p.type}">
                <span class="phase-time">${p.time >= MAX_SIM_SECS ? '∞' : fmt(p.time) + 's'}</span>
                <span class="phase-text">${p.text}</span>
            </div>
        `).join('');
    }

    panel.classList.add('visible');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCompareGrid(sA, sB, result) {
    const rows = [
        ['Combat', [
            ['TTK (how long they survive)', fmtTTK(result.ttkA), fmtTTK(result.ttkB)],
            ['Max Shields', fmt(sA.maxShields), fmt(sB.maxShields)],
            ['Max Hull', fmt(sA.maxHull), fmt(sB.maxHull)],
            ['Disable Hull Threshold', fmt(sA.minHull), fmt(sB.minHull)],
            ['Hull to Disable', fmt(sA.hullToDisable), fmt(sB.hullToDisable)],
            ['Shield DPS', fmt(sA.shieldDPS), fmt(sB.shieldDPS)],
            ['Hull DPS (vs naked hull)', fmt(sA.hullDPS), fmt(sB.hullDPS)],
            ['Shield Regen/s', fmt(sA.shieldRegen), fmt(sB.shieldRegen)],
            ['Hull Repair/s', fmt(sA.hullRepair), fmt(sB.hullRepair)],
        ]],
        ['Energy', [
            ['Energy Capacity', fmt(sA.energyCap), fmt(sB.energyCap)],
            ['Energy Gen/s', fmt(sA.energyGen), fmt(sB.energyGen)],
            ['Firing Energy/s', fmt(sA.firingEnergyPerSec), fmt(sB.firingEnergyPerSec)],
            ['Energy (moving+firing)', fmt(sA.energyConsumeMoving + sA.firingEnergyPerSec), fmt(sB.energyConsumeMoving + sB.firingEnergyPerSec)],
            ['Time to Blackout', result.energyWarningA ? fmt(result.energyWarningA) + 's' : '∞', result.energyWarningB ? fmt(result.energyWarningB) + 's' : '∞'],
        ]],
        ['Heat', [
            ['Heat Capacity', fmt(sA.maxHeat), fmt(sB.maxHeat)],
            ['Cooling/s', fmt(sA.coolingPerS), fmt(sB.coolingPerS)],
            ['Firing Heat/s', fmt(sA.firingHeatPerSec), fmt(sB.firingHeatPerSec)],
            ['Time to Overheat', result.heatWarningA ? fmt(result.heatWarningA) + 's' : '∞', result.heatWarningB ? fmt(result.heatWarningB) + 's' : '∞'],
        ]],
        ['Navigation', [
            ['Mass', fmt(sA.mass), fmt(sB.mass)],
            ['Max Velocity', fmt(sA.maxVelocity) + ' px/s', fmt(sB.maxVelocity) + ' px/s'],
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
    if (!details || !details.length) {
        return '<div class="weapon-item" style="color:var(--c-text-muted);font-style:italic;">No weapons</div>';
    }
    return details.map(w => `
        <div class="weapon-item">
            <div class="weapon-item-name">${escHtml(w.name)}</div>
            <div class="weapon-item-stats">
                <span class="weapon-stat">Rate: <span>${w.sps}/s</span></span>
                <span class="weapon-stat">Shld DPS: <span>${w.shieldDPS}</span></span>
                <span class="weapon-stat">Hull DPS: <span>${w.hullDPS}</span></span>
                ${w.piercingPct ? `<span class="weapon-stat">Pierce: <span>${w.piercingPct}%</span></span>` : ''}
                ${w.range       ? `<span class="weapon-stat">Range: <span>${w.range}px</span></span>` : ''}
                ${w.homing      ? `<span class="weapon-stat">🎯 Homing</span>` : ''}
                ${w.antiMissile ? `<span class="weapon-stat">🛡 Anti-Missile</span>` : ''}
            </div>
        </div>
    `).join('');
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(n) {
    if (n === null || n === undefined) return '—';
    if (!isFinite(n)) return '∞';
    if (Math.abs(n) >= 10000) return Math.round(n).toLocaleString();
    if (Number.isInteger(n)) return n.toString();
    return parseFloat(n.toPrecision(4)).toString();
}

function fmtTTK(t) {
    if (!isFinite(t)) return '∞ (never disabled)';
    return fmt(t) + 's';
}

function escHtml(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Expose globals ─────────────────────────────────────────────────────────────

window.searchShips    = searchShips;
window.openDropdown   = openDropdown;
window.blurDropdown   = blurDropdown;
window.clearSlot      = clearSlot;
window.runSimulation  = runSimulation;

// Boot
document.addEventListener('DOMContentLoaded', init);

})();
