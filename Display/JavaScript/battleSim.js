;(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  battleSim.js  —  Endless Sky Battle Simulator
//  Enhanced for accuracy against the actual ES combat system.
//
//  Key improvements over previous version:
//   1. Burst-fire: burstReload used mid-burst, full reload only after burst ends
//   2. Heat: overheat blocks ONLY weapons (not movement), ship cools & resumes
//   3. Ion/scrambling: correctly gates per-weapon energy-cost firing
//   4. Scrambling jam probability: dose/(dose+1024) per shot (from AICache)
//   5. Disruption multiplier: shieldDmg *= (1 + disruption * 0.01)
//   6. Piercing: effectivePiercing = weaponPiercing * (1 - piercingResistance)
//   7. Shield overflow bleed: 50% if no hull weapon, 100% if hull weapon present
//   8. Relative damage (% shield/hull) applied to current HP at time of hit
//   9. Status effect protections reduce initial dose (ion protection, etc.)
//  10. Firing costs: energy/heat/hull/shields/fuel consumed per shot
//  11. Self-inflicted firing status effects (firing ion, etc.)
//  12. CoolingEfficiency sigmoid correctly applied to cooling per frame
//  13. doGeneration matches Ship.cpp DoGeneration order exactly
//  14. Damage accounting for winner projected survival
// ═══════════════════════════════════════════════════════════════════════════════

const FPS          = 60;
const MAX_SIM_SECS = 600;
const MAX_FRAMES   = MAX_SIM_SECS * FPS;
const SOLAR_POWER  = 1.0;
// Shield overflow: if weapon has no hull damage, only 50% bleeds through (Ship.cpp TakeDamage)
const SHIELD_BLEED_FRACTION = 0.5;

const REPO_URL = 'GIVEMEFOOD5/endless-sky-ship-builder';
const BASE_URL = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;

// ── Module state ──────────────────────────────────────────────────────────────
let _allShips          = [];
let _outfitIndex       = {};
let _attrDefs          = null;
let _damageTypes       = [];
let _statusDecayMap    = {};
let _statusDescriptors = [];
let _weaponDataKeys    = new Set();

const _slots = { A: null, B: null };

// Firing status keys (self-inflicted): statName → weapon key
const FIRING_STATUS_MAP = {
    ionization: 'firing ion',
    scrambling: 'firing scramble',
    disruption: 'firing disruption',
    discharge:  'firing discharge',
    corrosion:  'firing corrosion',
    leak:       'firing leak',
    burn:       'firing burn',
    slowing:    'firing slowing',
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
    const resEl = document.getElementById('simResults');
    if (resEl) resEl.style.display = 'none';
    await loadData();
}

async function loadData() {
    setStatus('Loading plugin data…');
    try {
        const res = await fetch(`${BASE_URL}/attributeDefinitions.json`);
        if (res.ok) {
            _attrDefs          = await res.json();
            _damageTypes       = _attrDefs?.weapon?.damageTypes || [];
            const sed          = _attrDefs?.weapon?.statusEffectDecay;
            _statusDecayMap    = sed?.decayMap    || {};
            _statusDescriptors = sed?.descriptors || [];
            _weaponDataKeys    = new Set(_attrDefs?.weapon?.dataFileKeys || []);
            if (typeof initComputedStats === 'function')
                initComputedStats(_attrDefs, BASE_URL);
        }
    } catch (e) { console.warn('Failed to load attributeDefinitions.json', e); }

    let dataIndex;
    try {
        const res = await fetch(`${BASE_URL}/index.json`);
        if (!res.ok) throw new Error('Could not fetch index.json');
        dataIndex = await res.json();
    } catch (err) { setStatus(`Error: ${err.message}`, true); return; }

    window._indexPluginOrder = [];
    for (const pluginList of Object.values(dataIndex))
        for (const { outputName } of pluginList)
            window._indexPluginOrder.push(outputName);

    window.allData = {};
    for (const [, pluginList] of Object.entries(dataIndex)) {
        for (const { outputName, displayName, sourceName } of pluginList) {
            const pluginData = { sourceName, displayName, outputName,
                                 ships: [], variants: [], outfits: [] };
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
            } catch (err) { console.warn(`Failed loading plugin ${outputName}:`, err); }
        }
    }

    if (!Object.keys(window.allData).length) {
        setStatus('Error: no plugin data could be loaded.', true); return;
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
    _allShips = []; _outfitIndex = {};
    const activePlugins = PluginManager.getActivePlugins();
    const allData       = window.allData || {};
    const indexOrder    = window._indexPluginOrder || [];
    const searchOrder   = [
        ...activePlugins,
        ...indexOrder.filter(id => !activePlugins.includes(id) && allData[id]),
        ...Object.keys(allData).filter(id => !activePlugins.includes(id) && !indexOrder.includes(id)),
    ];
    for (const pid of searchOrder) {
        const d = allData[pid];
        if (!d) continue;
        for (const outfit of (d.outfits || []))
            if (outfit.name && !_outfitIndex[outfit.name])
                _outfitIndex[outfit.name] = { ...outfit, _pluginId: pid };
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
const _blurTimers = { A: null, B: null };

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
            const row = document.createElement('div');
            row.className = 'ship-dropdown-item';
            const pl = (window.allData?.[ship._pluginId]?.sourceName || ship._pluginId) || '';
            row.innerHTML = `<span>${escHtml(ship.name)}</span>
                             <span class="sdi-plugin">${escHtml(pl)}</span>`;
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
    _blurTimers[slot] = setTimeout(() =>
        document.getElementById('dropdown' + slot).classList.remove('open'), 180);
}

async function selectShip(slot, ship) {
    document.getElementById('dropdown' + slot).classList.remove('open');
    document.getElementById('search'   + slot).value = ship.name;
    const resolved = resolveShipStats(ship);
    _slots[slot]   = resolved;
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
//  ATTRIBUTE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getStacking(key) {
    return (_attrDefs?.attributes?.[key]?.stacking) || 'additive';
}
function getProtectionKeys() {
    if (!_attrDefs?.attributes) return [];
    return Object.keys(_attrDefs.attributes).filter(k => k.endsWith(' protection'));
}
const dmgKey    = t => t.toLowerCase() + ' damage';
const protKey   = t => t.toLowerCase() + ' protection';
const relDmgKey = t => '% ' + t.toLowerCase() + ' damage';

// ═══════════════════════════════════════════════════════════════════════════════
//  STAT RESOLUTION  — mirrors Ship.cpp formulas from attrDefs
// ═══════════════════════════════════════════════════════════════════════════════

function resolveShipStats(ship) {
    const combined            = { ...(ship.attributes || {}) };
    const weapons             = [];
    const outfitContributions = {};

    for (const [outfitName, qty] of Object.entries(ship.outfitMap || {})) {
        const outfit = _outfitIndex[outfitName];
        if (!outfit) continue;
        if (outfit.weapon)
            for (let i = 0; i < qty; i++)
                weapons.push({ _name: outfitName, ...outfit.weapon });

        const attrs = (outfit.attributes && Object.keys(outfit.attributes).length)
            ? outfit.attributes : outfit;

        for (const [key, rawVal] of Object.entries(attrs)) {
            if (typeof rawVal !== 'number' || key.startsWith('_')) continue;
            const contrib = rawVal * qty;
            switch (getStacking(key)) {
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

    const a = k => combined[k] || 0;

    // Ship.cpp: InertialMass() = Mass() / (1 + [inertia reduction])
    const rawMass      = a('mass');
    const inertialMass = rawMass / (1 + a('inertia reduction'));
    // Ship.cpp: Drag() = min([drag]/(1+[drag reduction]), InertialMass())
    const drag         = Math.min(a('drag') / (1 + a('drag reduction')), inertialMass);

    // Ship.cpp: MaxShields/MaxHull with multiplier
    const maxShields = a('shields') * (1 + a('shield multiplier'));
    const maxHull    = a('hull')    * (1 + a('hull multiplier'));

    // Ship.cpp: MinimumHull()
    const absThresh = a('absolute threshold');
    const minHull   = absThresh > 0
        ? absThresh
        : Math.max(0, Math.floor(a('threshold percentage') * maxHull + a('hull threshold')));

    // Ship.cpp: CoolingEfficiency() sigmoid
    const x       = a('cooling inefficiency');
    const coolEff = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));

    // Ship.cpp: MaximumHeat = 100 * (mass + [heat capacity])
    const maxHeat        = 100 * (rawMass + a('heat capacity'));
    // Ship.cpp: HeatDissipation = 0.001 * [heat dissipation]
    const heatDissipFrac = 0.001 * a('heat dissipation');
    // Effective cooling per frame
    const coolingPerFrame = coolEff * (a('cooling') + a('active cooling'));

    // Regen per frame (DoGeneration)
    const shieldRegenPerFrame   = a('shield generation')         * (1 + a('shield generation multiplier'));
    const delayedShieldPerFrame = a('delayed shield generation') * (1 + a('shield generation multiplier'));
    const hullRepairPerFrame    = a('hull repair rate')          * (1 + a('hull repair multiplier'));
    const delayedHullPerFrame   = a('delayed hull repair rate')  * (1 + a('hull repair multiplier'));

    // Protections — clamped [0,1]
    const protections = {};
    for (const key of getProtectionKeys())
        protections[key] = Math.max(0, Math.min(1, a(key)));
    const shieldProt  = protections['shield protection']  || 0;
    const hullProt    = protections['hull protection']    || 0;
    const piercingRes = Math.max(0, Math.min(1, a('piercing resistance')));

    // Status resistances (decay per frame)
    const statusResist = {};
    for (const [statName, resistKey] of Object.entries(_statusDecayMap))
        statusResist[statName] = Math.max(0, a(resistKey));

    // Energy
    const energyCap                 = a('energy capacity');
    const energyGenPerFrame         = a('energy generation')
                                    + a('solar collection') * SOLAR_POWER
                                    + a('fuel energy');
    const energyConsumeIdlePerFrame = a('energy consumption');
    const movingEnergyPerFrame      = Math.max(a('thrusting energy'), a('reverse thrusting energy'))
                                    + a('turning energy');
    const coolingEnergyPerFrame     = a('cooling energy');

    // Heat
    const heatGenIdlePerFrame = a('heat generation');
    const movingHeatPerFrame  = Math.max(a('thrusting heat'), a('reverse thrusting heat'))
                              + a('turning heat');

    // Navigation
    const thrustForVel = a('thrust') || a('afterburner thrust');
    const maxVelocity  = drag > 0 ? thrustForVel / drag : 0;
    const acceleration = inertialMass > 0
        ? (a('thrust') / inertialMass) * (1 + a('acceleration multiplier')) : 0;

    return {
        name: ship.name, pluginId: ship._pluginId, rawShip: ship,
        combined, weapons, outfitContributions, protections,
        maxShields, maxHull, minHull,
        hullToDisable: Math.max(0, maxHull - minHull),
        shieldRegenPerFrame, delayedShieldPerFrame, hullRepairPerFrame, delayedHullPerFrame,
        shieldRegenPerSec: (shieldRegenPerFrame + delayedShieldPerFrame) * FPS,
        hullRepairPerSec:  (hullRepairPerFrame  + delayedHullPerFrame)  * FPS,
        shieldDelay: a('shield delay'), repairDelay: a('repair delay'),
        depletedDelay: a('depleted shield delay'),
        shieldProt, hullProt, piercingRes, statusResist,
        energyCap, energyGenPerFrame, energyConsumeIdlePerFrame,
        movingEnergyPerFrame, coolingEnergyPerFrame,
        maxHeat, heatDissipFrac, coolingPerFrame, coolingPerSec: coolingPerFrame * FPS,
        heatGenIdlePerFrame, movingHeatPerFrame, coolEff,
        rawMass, inertialMass, drag,
        maxVelocity: maxVelocity * FPS,
        acceleration: acceleration * FPS * FPS,
        ...analyzeWeapons(weapons),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WEAPON ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

function resolveSubmunitionDamage(weapon, multiplier, visited, depth) {
    if (depth > 8) return {};
    const totals = {};
    for (const typeName of _damageTypes) {
        const val = weapon[dmgKey(typeName)] || 0;
        if (val) totals[typeName] = (totals[typeName] || 0) + val * multiplier;
    }
    const subs = weapon.submunition;
    if (!subs) return totals;
    for (const entry of (Array.isArray(subs) ? subs : [subs])) {
        const subName  = typeof entry === 'string' ? entry : (entry?.name ?? String(entry));
        const subCount = typeof entry === 'object'  ? (entry?.count ?? 1) : 1;
        if (!subName || visited.has(subName)) continue;
        const newVisited = new Set(visited);
        newVisited.add(subName);
        const sub = _outfitIndex[subName];
        if (!sub?.weapon) continue;
        const subDmg = resolveSubmunitionDamage(sub.weapon, multiplier * subCount, newVisited, depth + 1);
        for (const [t, v] of Object.entries(subDmg))
            totals[t] = (totals[t] || 0) + v;
    }
    return totals;
}

function analyzeWeapons(weapons) {
    const firingCostKeys = (_attrDefs?.outfitDisplay?.valueNames || [])
        .map(v => v.key).filter(k => k.startsWith('firing '));
    const totalDPS    = {};
    const totalFiring = {};
    for (const t of _damageTypes) totalDPS[t]    = 0;
    for (const k of firingCostKeys) totalFiring[k] = 0;
    const details = [];

    for (const w of weapons) {
        const reload      = Math.max(1, w.reload || 1);
        const burstCount  = w['burst count']  || 1;
        const burstReload = w['burst reload'] || reload;
        // Frames per full burst cycle
        const framesPerCycle = (burstCount - 1) * burstReload + reload;
        const sps            = (burstCount / framesPerCycle) * FPS;

        const piercing = Math.max(0, Math.min(1, w.piercing || 0));
        const visited  = new Set([w._name].filter(Boolean));
        const dmgPerShot = resolveSubmunitionDamage(w, 1, visited, 0);
        for (const t of _damageTypes) if (dmgPerShot[t] === undefined) dmgPerShot[t] = 0;

        for (const t of _damageTypes)
            totalDPS[t] = (totalDPS[t] || 0) + dmgPerShot[t] * sps;
        for (const k of firingCostKeys)
            totalFiring[k] = (totalFiring[k] || 0) + (w[k] || 0) * sps;

        const detail = {
            name: w._name || 'Unknown', reload, burstCount, burstReload, framesPerCycle,
            sps: +sps.toFixed(3), piercing: +(piercing * 100).toFixed(0),
            range: (w.velocity && w.lifetime) ? w.velocity * w.lifetime : null,
            homing: (w.homing || 0) > 0, antiMissile: (w['anti-missile'] || 0) > 0,
            hasSubmunitions: !!(w.submunition), dmgPerShot,
            relShield: +((w['% shield damage'] || 0) * 100).toFixed(1),
            relHull:   +((w['% hull damage']   || 0) * 100).toFixed(1),
        };
        for (const t of _damageTypes)
            detail[t.toLowerCase() + 'DPS'] = +(dmgPerShot[t] * sps).toFixed(2);
        details.push(detail);
    }

    const result = { dps: totalDPS, weaponDetails: details };
    for (const t of _damageTypes) result[t.toLowerCase() + 'DPS'] = totalDPS[t] || 0;
    result.shieldDPS     = totalDPS['Shield']     || 0;
    result.hullDPS       = totalDPS['Hull']       || 0;
    result.heatDPS       = totalDPS['Heat']       || 0;
    result.ionDPS        = totalDPS['Ion']        || 0;
    result.disruptionDPS = totalDPS['Disruption'] || 0;
    result.firingEnergyPerSec     = +(totalFiring['firing energy']  || 0).toFixed(3);
    result.firingHeatPerSec       = +(totalFiring['firing heat']    || 0).toFixed(3);
    result.firingFuelPerSec       = +(totalFiring['firing fuel']    || 0).toFixed(3);
    result.firingHullCostPerSec   = +(totalFiring['firing hull']    || 0).toFixed(3);
    result.firingShieldCostPerSec = +(totalFiring['firing shields'] || 0).toFixed(3);
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COMBAT SIMULATION
// ═══════════════════════════════════════════════════════════════════════════════

function createCombatantState(stats) {
    const statusEffects = {};
    for (const statName of Object.keys(_statusDecayMap)) statusEffects[statName] = 0;
    return {
        stats,
        shields: stats.maxShields,
        hull:    stats.maxHull,
        energy:  stats.energyCap,
        heat:    0,
        fuel:    1000,
        statusEffects,
        shieldDelayCounter: 0,
        repairDelayCounter: 0,
        depletedFlag:       false,
        weaponReloadCounters: stats.weapons.map(() => 0),
        weaponBurstCounters:  stats.weapons.map(() => 0),
        disabled:    false, disabledAt:  Infinity,
        destroyed:   false, destroyedAt: Infinity,
        isOverheated: false,
        isIonized:    false,
        totalShieldDamageReceived: 0,
        totalHullDamageReceived:   0,
    };
}

function simulateBattle(sA, sB) {
    const result = {
        winner: null,
        ttkA: Infinity, ttkB: Infinity,
        projectedTtkA: null, projectedTtkB: null,
        phases: [], warnings: [],
    };
    const stA = createCombatantState(sA);
    const stB = createCombatantState(sB);
    const milestones = {
        A: { shieldsBroken: false, halfHull: false, disabled: false, energyBlackout: false, overheated: false },
        B: { shieldsBroken: false, halfHull: false, disabled: false, energyBlackout: false, overheated: false },
    };
    const timelineA = [], timelineB = [];
    let frame = 0;

    while (frame < MAX_FRAMES) {
        const t = frame / FPS;
        if (frame % 60 === 0) {
            timelineA.push({ t, shields: stA.shields, hull: stA.hull, energy: stA.energy, heat: stA.heat });
            timelineB.push({ t, shields: stB.shields, hull: stB.hull, energy: stB.energy, heat: stB.heat });
        }

        const preShieldsA = stA.shields, preHullA = stA.hull;
        const preShieldsB = stB.shields, preHullB = stB.hull;

        if (!stA.disabled && !stA.destroyed) shootFrame(stA, stB, sA, sB);
        if (!stB.disabled && !stB.destroyed) shootFrame(stB, stA, sB, sA);

        stA.totalShieldDamageReceived += Math.max(0, preShieldsA - stA.shields);
        stA.totalHullDamageReceived   += Math.max(0, preHullA   - stA.hull);
        stB.totalShieldDamageReceived += Math.max(0, preShieldsB - stB.shields);
        stB.totalHullDamageReceived   += Math.max(0, preHullB   - stB.hull);

        doGeneration(stA, sA); doGeneration(stB, sB);
        doRegen(stA, sA);      doRegen(stB, sB);
        decayStatusEffects(stA, sA); decayStatusEffects(stB, sB);

        // IsOverheated: heat >= MaximumHeat — weapons blocked, movement still allowed
        stA.isOverheated = stA.heat >= sA.maxHeat;
        stB.isOverheated = stB.heat >= sB.maxHeat;
        // IsIonized: ionization > energy AND ship uses energy for movement
        stA.isIonized = sA.movingEnergyPerFrame > 0 && (stA.statusEffects.ionization || 0) > stA.energy;
        stB.isIonized = sB.movingEnergyPerFrame > 0 && (stB.statusEffects.ionization || 0) > stB.energy;

        stA.shields = Math.max(0, Math.min(sA.maxShields, stA.shields));
        stB.shields = Math.max(0, Math.min(sB.maxShields, stB.shields));
        stA.energy  = Math.max(0, Math.min(sA.energyCap,  stA.energy));
        stB.energy  = Math.max(0, Math.min(sB.energyCap,  stB.energy));
        stA.heat    = Math.max(0, stA.heat);
        stB.heat    = Math.max(0, stB.heat);

        checkMilestones(stA, sA, 'A', t, milestones.A, result.phases);
        checkMilestones(stB, sB, 'B', t, milestones.B, result.phases);

        if (!stA.disabled && stA.hull < sA.minHull) {
            stA.disabled = true; stA.disabledAt = t; result.ttkA = t;
            if (!milestones.A.disabled) { milestones.A.disabled = true;
                result.phases.push({ time: t, type: 'A', icon: '💥',
                    text: `<strong>${escHtml(sA.name)}</strong> disabled at ${fmtT(t)}` }); }
        }
        if (!stB.disabled && stB.hull < sB.minHull) {
            stB.disabled = true; stB.disabledAt = t; result.ttkB = t;
            if (!milestones.B.disabled) { milestones.B.disabled = true;
                result.phases.push({ time: t, type: 'B', icon: '💥',
                    text: `<strong>${escHtml(sB.name)}</strong> disabled at ${fmtT(t)}` }); }
        }
        if (!stA.destroyed && stA.hull < 0) { stA.destroyed = true; stA.destroyedAt = t; }
        if (!stB.destroyed && stB.hull < 0) { stB.destroyed = true; stB.destroyedAt = t; }
        if ((stA.disabled || stA.destroyed) && (stB.disabled || stB.destroyed)) break;
        frame++;
    }

    const finalT = frame / FPS;
    if (!timelineA.length || timelineA[timelineA.length-1].t < finalT) {
        timelineA.push({ t: finalT, shields: stA.shields, hull: stA.hull, energy: stA.energy, heat: stA.heat });
        timelineB.push({ t: finalT, shields: stB.shields, hull: stB.hull, energy: stB.energy, heat: stB.heat });
    }
    result.timelineA = timelineA; result.timelineB = timelineB;
    result.finalStateA = stA; result.finalStateB = stB;

    const aKilled = isFinite(result.ttkA), bKilled = isFinite(result.ttkB);
    if (!aKilled && !bKilled) {
        result.winner = 'draw';
        result.phases.push({ time: finalT, type: 'neutral', icon: '🤝',
            text: 'Neither ship could disable the other — draw.' });
    } else if (aKilled && bKilled) {
        result.winner = result.ttkB <= result.ttkA ? 'A' : 'B';
    } else {
        result.winner = bKilled ? 'A' : 'B';
    }

    if (aKilled && !bKilled && result.ttkA > 0) {
        const avgS = stB.totalShieldDamageReceived / result.ttkA;
        const avgH = stB.totalHullDamageReceived   / result.ttkA;
        result.projectedTtkB = projectSurvival(sB, stB, avgS, avgH);
    }
    if (bKilled && !aKilled && result.ttkB > 0) {
        const avgS = stA.totalShieldDamageReceived / result.ttkB;
        const avgH = stA.totalHullDamageReceived   / result.ttkB;
        result.projectedTtkA = projectSurvival(sA, stA, avgS, avgH);
    }

    result.phases.sort((a, b) => a.time - b.time);
    return result;
}

// ── shootFrame ────────────────────────────────────────────────────────────────
function shootFrame(attSt, defSt, attStats) {
    // Overheated: weapons offline, ship still moves (Ship.cpp behaviour)
    if (attSt.isOverheated) return;

    for (let i = 0; i < attStats.weapons.length; i++) {
        const w = attStats.weapons[i];
        if (attSt.weaponReloadCounters[i] > 0) { attSt.weaponReloadCounters[i]--; continue; }

        const reload      = Math.max(1, w.reload || 1);
        const burstCount  = w['burst count']  || 1;
        const burstReload = w['burst reload'] || reload;

        // Energy gate (Ship.cpp CanFire)
        const firingEnergy = w['firing energy'] || 0;
        if (firingEnergy > 0 && attSt.energy < firingEnergy) continue;

        // Ionized gate: weapons requiring energy are blocked when ionized
        if (attSt.isIonized && firingEnergy > 0) continue;

        // Scrambling jam: probability = scrambling / (scrambling + 1024)
        // From ShipAICache.cpp CalculateJamChance
        const scrambling = attSt.statusEffects.scrambling || 0;
        if (scrambling > 0) {
            const jamChance = scrambling / (scrambling + 1024);
            if (Math.random() < jamChance) {
                advanceBurst(attSt, i, burstCount, burstReload, reload);
                continue;
            }
        }

        // Consume firing costs
        attSt.energy  -= firingEnergy;
        attSt.fuel    -= (w['firing fuel']    || 0);
        attSt.hull    -= (w['firing hull']    || 0);
        attSt.shields -= (w['firing shields'] || 0);
        attSt.heat    += (w['firing heat']    || 0);

        // Self-inflicted status effects
        for (const [statName, firingKey] of Object.entries(FIRING_STATUS_MAP)) {
            const val = w[firingKey] || 0;
            if (val > 0)
                attSt.statusEffects[statName] = (attSt.statusEffects[statName] || 0) + val;
        }

        applyWeaponDamage(w, defSt, defSt.stats);
        advanceBurst(attSt, i, burstCount, burstReload, reload);
    }
}

function advanceBurst(attSt, i, burstCount, burstReload, reload) {
    if (burstCount > 1) {
        attSt.weaponBurstCounters[i]++;
        if (attSt.weaponBurstCounters[i] >= burstCount) {
            attSt.weaponBurstCounters[i]  = 0;
            attSt.weaponReloadCounters[i] = reload - 1;
        } else {
            attSt.weaponReloadCounters[i] = burstReload - 1;
        }
    } else {
        attSt.weaponReloadCounters[i] = reload - 1;
    }
}

// ── applyWeaponDamage — matches Ship.cpp TakeDamage + DamageDealt ─────────────
function applyWeaponDamage(w, defSt, defStats) {
    // Disruption amplifies shield damage: shieldDmg *= (1 + disruption * 0.01)
    const disruptMult = 1 + (defSt.statusEffects.disruption || 0) * 0.01;

    // Effective piercing after target's piercing resistance
    const effectivePiercing = Math.max(0, Math.min(1, w.piercing || 0))
                            * (1 - defStats.piercingRes);

    // Relative (%) damage — uses current HP, clamped to max
    const relShieldDmg = (w['% shield damage'] || 0)
                       * Math.min(Math.max(0, defSt.shields), defStats.maxShields);
    const relHullDmg   = (w['% hull damage']   || 0)
                       * Math.min(Math.max(0, defSt.hull),    defStats.maxHull);

    const rawShieldDmg = (w['shield damage'] || 0) + relShieldDmg;
    const rawHullDmg   = (w['hull damage']   || 0) + relHullDmg;

    // Shield damage after protection and disruption boost
    const shieldDmgTotal  = rawShieldDmg * (1 - defStats.shieldProt) * disruptMult;
    // Hull damage after protection
    const hullDmgAfterProt = rawHullDmg  * (1 - defStats.hullProt);

    // Pierced damage: bypasses shields directly to hull
    const hullPiercedDmg   = shieldDmgTotal * effectivePiercing;
    const shieldDmgApplied = shieldDmgTotal * (1 - effectivePiercing);

    if (defSt.shields > 0) {
        defSt.shields -= shieldDmgApplied;
        defSt.hull    -= hullPiercedDmg + hullDmgAfterProt;

        // Shield overflow bleeds to hull
        // ES: if weapon has hull damage → 100% bleed; else 50%
        if (defSt.shields < 0) {
            const bleed = (rawHullDmg > 0) ? 1.0 : SHIELD_BLEED_FRACTION;
            defSt.hull    += defSt.shields * bleed * (1 - defStats.hullProt);
            defSt.shields  = 0;
            defSt.depletedFlag = true;
        }
    } else {
        // Shields already gone — all shield + hull damage hits hull
        defSt.hull -= hullDmgAfterProt + rawShieldDmg * (1 - defStats.shieldProt);
    }

    // Update delay counters
    defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.shieldDelay   || 0);
    defSt.repairDelayCounter = Math.max(defSt.repairDelayCounter, defStats.repairDelay   || 0);
    if (defSt.depletedFlag)
        defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.depletedDelay || 0);

    // Non-shield/hull damage types
    for (const typeName of _damageTypes) {
        if (typeName === 'Shield' || typeName === 'Hull' || typeName === 'Scaling') continue;
        const raw = w[dmgKey(typeName)] || 0;
        const rel = w[relDmgKey(typeName)] || 0;
        const dmg = (raw + rel);
        if (!dmg) continue;
        const prot = defStats.protections[protKey(typeName)] || 0;
        applyStatusDamage(defSt, typeName, dmg * (1 - prot));
    }
}

function applyStatusDamage(defSt, typeName, dmg) {
    switch (typeName) {
        case 'Heat':       defSt.heat   += dmg; break;
        case 'Energy':     defSt.energy -= dmg; break;
        case 'Fuel':       defSt.fuel   -= dmg; break;
        case 'Ion':        defSt.statusEffects.ionization  = Math.max(0, (defSt.statusEffects.ionization  || 0) + dmg); break;
        case 'Scrambling': defSt.statusEffects.scrambling  = Math.max(0, (defSt.statusEffects.scrambling  || 0) + dmg); break;
        case 'Disruption': defSt.statusEffects.disruption  = Math.max(0, (defSt.statusEffects.disruption  || 0) + dmg); break;
        case 'Discharge':  defSt.statusEffects.discharge   = Math.max(0, (defSt.statusEffects.discharge   || 0) + dmg); break;
        case 'Corrosion':  defSt.statusEffects.corrosion   = Math.max(0, (defSt.statusEffects.corrosion   || 0) + dmg); break;
        case 'Leak':       defSt.statusEffects.leak        = Math.max(0, (defSt.statusEffects.leak        || 0) + dmg); break;
        case 'Burn':       defSt.statusEffects.burn        = Math.max(0, (defSt.statusEffects.burn        || 0) + dmg); break;
        case 'Slowing':    defSt.statusEffects.slowing     = Math.max(0, (defSt.statusEffects.slowing     || 0) + dmg); break;
        default: break;
    }
}

// ── doGeneration — mirrors Ship.cpp DoGeneration ──────────────────────────────
function doGeneration(st, stats) {
    st.energy += stats.energyGenPerFrame
               - stats.energyConsumeIdlePerFrame
               - stats.movingEnergyPerFrame
               - stats.coolingEnergyPerFrame;
    st.heat   += stats.heatGenIdlePerFrame
               + stats.movingHeatPerFrame
               - stats.coolingPerFrame;
    // Multiplicative heat dissipation
    st.heat   -= st.heat * stats.heatDissipFrac;

    // Status effect per-frame tick damage
    if ((st.statusEffects.discharge || 0) > 0) st.shields -= st.statusEffects.discharge;
    if ((st.statusEffects.corrosion || 0) > 0) st.hull    -= st.statusEffects.corrosion;
    if ((st.statusEffects.burn      || 0) > 0) st.heat    += st.statusEffects.burn;
    if ((st.statusEffects.leak      || 0) > 0) st.fuel    -= st.statusEffects.leak;
}

// ── doRegen — shield and hull regen with delay counters ──────────────────────
function doRegen(st, stats) {
    if (st.shieldDelayCounter > 0) st.shieldDelayCounter--;
    else if (st.shields < stats.maxShields)
        st.shields += stats.shieldRegenPerFrame + stats.delayedShieldPerFrame;

    if (st.repairDelayCounter > 0) st.repairDelayCounter--;
    else if (st.hull < stats.maxHull && !st.disabled)
        st.hull += stats.hullRepairPerFrame + stats.delayedHullPerFrame;
}

// ── decayStatusEffects — each effect decays by its resistance per frame ───────
function decayStatusEffects(st, stats) {
    for (const [statName, resistPerFrame] of Object.entries(stats.statusResist)) {
        if ((st.statusEffects[statName] || 0) > 0 && resistPerFrame > 0)
            st.statusEffects[statName] = Math.max(0, st.statusEffects[statName] - resistPerFrame);
    }
}

// ── checkMilestones ────────────────────────────────────────────────────────────
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
            text: `<strong>${escHtml(stats.name)}</strong> overheated — weapons offline at ${fmtT(t)}` });
    }
}

// ── projectSurvival ────────────────────────────────────────────────────────────
function projectSurvival(stats, finalState, avgShieldDps, avgHullDps) {
    if (avgShieldDps <= 0 && avgHullDps <= 0) return Infinity;
    let shields = Math.max(0, finalState.shields);
    let hull    = Math.max(stats.minHull, finalState.hull);
    const shieldRegenPerSec = (stats.shieldRegenPerFrame + stats.delayedShieldPerFrame) * FPS;
    const hullRegenPerSec   = (stats.hullRepairPerFrame  + stats.delayedHullPerFrame)  * FPS;
    const STEP = 0.5;
    for (let elapsed = 0; elapsed < 3600; elapsed += STEP) {
        shields -= avgShieldDps * STEP;
        if (shields < 0) { hull += shields * SHIELD_BLEED_FRACTION; shields = 0; }
        hull    -= avgHullDps * STEP;
        shields  = Math.min(stats.maxShields, shields + shieldRegenPerSec * STEP);
        hull     = Math.min(stats.maxHull,    hull    + hullRegenPerSec   * STEP);
        if (hull < stats.minHull) return elapsed;
    }
    return Infinity;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UI — slot preview
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
        imgEl.style.display = 'none'; imgEl.src = '';
        try {
            let element = null;
            if (ship.sprite)        element = await window.fetchSprite(ship.sprite,     ship.spriteData || {});
            if (!element && ship.thumbnail) element = await window.fetchSprite(ship.thumbnail, ship.spriteData || {});
            if (element) {
                element.id = imgEl.id; element.className = imgEl.className;
                imgEl.parentElement.replaceChild(element, imgEl);
            } else {
                imgEl.src = 'https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/data/endless-sky/images/outfit/unknown.png';
                imgEl.style.display = 'block';
            }
        } catch (e) { console.warn('Sprite fetch failed for', ship.name, e); }
    }

    if (nameEl) nameEl.textContent = ship.name;
    if (metaEl) metaEl.textContent = (window.allData?.[ship._pluginId]?.sourceName) || ship._pluginId || '';
    if (el)     el.classList.add('visible');
    if (slotEl) slotEl.classList.add('has-ship');

    if (statEl) {
        statEl.innerHTML = [
            ['Shields',    fmt(stats.maxShields)],
            ['Hull',       fmt(stats.maxHull)],
            ['Min Hull',   fmt(stats.minHull)],
            ['Shld DPS',   fmt(stats.shieldDPS)],
            ['Hull DPS',   fmt(stats.hullDPS)],
            ['Shld Regen', fmt(stats.shieldRegenPerSec) + '/s'],
            ['Energy',     fmt(stats.energyCap)],
            ['Heat Cap',   fmt(stats.maxHeat)],
        ].map(([l, v]) => `<div class="slot-stat">
            <div class="slot-stat-label">${l}</div>
            <div class="slot-stat-value">${v}</div>
        </div>`).join('');
        statEl.style.display = 'grid';
    }
}

function updateFightButton() {
    const btn = document.getElementById('fightBtn');
    if (btn) btn.disabled = !(_slots.A && _slots.B);
}

function hideResults() {
    const el = document.getElementById('simResults');
    if (el) el.style.display = 'none';
}

function runSimulation() {
    const sA = _slots.A, sB = _slots.B;
    if (!sA || !sB) { setStatus('Select two ships first.', true); return; }
    if (!_attrDefs) { setStatus('Attribute definitions not loaded — please wait.', true); return; }
    const loadEl = document.getElementById('simLoading');
    const resEl  = document.getElementById('simResults');
    if (loadEl) { loadEl.style.display = 'block'; loadEl.classList.add('visible'); }
    if (resEl)  resEl.style.display = 'none';
    setTimeout(() => {
        try {
            const result = simulateBattle(sA, sB);
            renderResults(sA, sB, result);
        } catch (err) {
            console.error('runSimulation error:', err);
            setStatus('Simulation error: ' + err.message, true);
        } finally {
            if (loadEl) { loadEl.style.display = 'none'; loadEl.classList.remove('visible'); }
        }
    }, 30);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RESULTS RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function renderResults(sA, sB, result) {
    const resEl = document.getElementById('simResults');
    if (!resEl) return;

    const winnerNameEl = document.getElementById('resultWinnerName');
    const subtitleEl   = document.getElementById('resultSubtitle');
    if (winnerNameEl) {
        winnerNameEl.className = result.winner === 'A' ? 'result-winner-name result-winner-a'
                               : result.winner === 'B' ? 'result-winner-name result-winner-b'
                               : 'result-winner-name result-winner-draw';
        winnerNameEl.textContent = result.winner === 'A' ? sA.name
                                 : result.winner === 'B' ? sB.name : 'Draw';
    }
    if (subtitleEl) {
        subtitleEl.innerHTML = `${buildTtkString(sA.name, result.ttkA, result.projectedTtkA)}&nbsp;&nbsp;·&nbsp;&nbsp;${buildTtkString(sB.name, result.ttkB, result.projectedTtkB)}`;
    }

    const effA = isFinite(result.ttkA) ? result.ttkA
        : (result.projectedTtkA != null && isFinite(result.projectedTtkA)) ? result.projectedTtkA : MAX_SIM_SECS;
    const effB = isFinite(result.ttkB) ? result.ttkB
        : (result.projectedTtkB != null && isFinite(result.projectedTtkB)) ? result.projectedTtkB : MAX_SIM_SECS;
    const maxT = Math.max(effA, effB, 1);

    const barA = document.getElementById('timelineBarA');
    const barB = document.getElementById('timelineBarB');
    const lblA = document.getElementById('timelineLabelA');
    const lblB = document.getElementById('timelineLabelB');
    if (barA) barA.style.width = Math.round(Math.min((effA / maxT) * 50, 50)) + '%';
    if (barB) barB.style.width = Math.round(Math.min((effB / maxT) * 50, 50)) + '%';
    if (lblA) lblA.textContent = isFinite(result.ttkA) ? fmtT(result.ttkA)
        : (result.projectedTtkA != null && isFinite(result.projectedTtkA)) ? '~' + fmtT(result.projectedTtkA) : '∞';
    if (lblB) lblB.textContent = isFinite(result.ttkB) ? fmtT(result.ttkB)
        : (result.projectedTtkB != null && isFinite(result.projectedTtkB)) ? '~' + fmtT(result.projectedTtkB) : '∞';

    const chartEl = document.getElementById('hpChartContainer');
    if (chartEl) chartEl.innerHTML = buildHpChart(sA, sB, result);

    const compareEl = document.getElementById('compareGrid');
    if (compareEl) compareEl.innerHTML = buildCompareGrid(sA, sB, result);

    const weaponsEl = document.getElementById('weaponsGrid');
    if (weaponsEl) {
        weaponsEl.innerHTML =
            `<div><div class="weapons-col-title weapons-col-title-a">${escHtml(sA.name)}</div>${buildWeaponsList(sA.weaponDetails)}</div>
             <div><div class="weapons-col-title weapons-col-title-b">${escHtml(sB.name)}</div>${buildWeaponsList(sB.weaponDetails)}</div>`;
    }

    const phaseEl = document.getElementById('phaseList');
    if (phaseEl) {
        const phases = [...result.phases];
        if (result.winner === 'A' && result.projectedTtkA != null) {
            const pttk = result.projectedTtkA;
            phases.push({ time: result.ttkB + (isFinite(pttk) ? pttk : 0), type: 'A', icon: '📊',
                text: isFinite(pttk) ? `<strong>${escHtml(sA.name)}</strong> projected to survive ~${fmtT(pttk)} more under continued fire`
                                     : `<strong>${escHtml(sA.name)}</strong> projected to outlast continued fire — regen outpaces damage` });
        }
        if (result.winner === 'B' && result.projectedTtkB != null) {
            const pttk = result.projectedTtkB;
            phases.push({ time: result.ttkA + (isFinite(pttk) ? pttk : 0), type: 'B', icon: '📊',
                text: isFinite(pttk) ? `<strong>${escHtml(sB.name)}</strong> projected to survive ~${fmtT(pttk)} more under continued fire`
                                     : `<strong>${escHtml(sB.name)}</strong> projected to outlast continued fire — regen outpaces damage` });
        }
        phaseEl.innerHTML = phases.length
            ? phases.map(ph => {
                const cls = ph.type === 'A' ? 'phase-A' : ph.type === 'B' ? 'phase-B' : 'phase-neutral';
                return `<div class="phase-item ${cls}">
                    <span class="phase-icon">${ph.icon}</span>
                    <span class="phase-time">${fmtT(ph.time)}</span>
                    <span class="phase-text">${ph.text}</span>
                </div>`;
              }).join('')
            : '<div class="phase-item phase-neutral">No notable events recorded.</div>';
    }

    resEl.style.display = 'block';
    resEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildTtkString(name, ttk, projectedTtk) {
    const n = escHtml(name);
    if (isFinite(ttk)) return `${n} disabled in ${fmtT(ttk)}`;
    if (projectedTtk == null) return `${n} survived`;
    if (!isFinite(projectedTtk)) return `${n} survived (regen &gt; damage)`;
    return `${n} survived · ~${fmtT(projectedTtk)} projected`;
}

// ── HP chart ──────────────────────────────────────────────────────────────────
function buildHpChart(sA, sB, result) {
    const tlA = result.timelineA || [], tlB = result.timelineB || [];
    if (!tlA.length && !tlB.length) return '';
    const W=560, H=180, PL=44, PR=12, PT=14, PB=28;
    const cW=W-PL-PR, cH=H-PT-PB;
    const maxTime = Math.max(tlA.length?tlA[tlA.length-1].t:0, tlB.length?tlB[tlB.length-1].t:0, 1);
    const maxHP   = Math.max(sA.maxShields+sA.maxHull, sB.maxShields+sB.maxHull, 1);
    const px = t  => PL + (t/maxTime)*cW;
    const py = hp => PT + cH - (hp/maxHP)*cH;
    const pathAH = tlA.map((p,i)=>`${i?'L':'M'}${px(p.t).toFixed(1)},${py(p.hull).toFixed(1)}`).join(' ');
    const pathBH = tlB.map((p,i)=>`${i?'L':'M'}${px(p.t).toFixed(1)},${py(p.hull).toFixed(1)}`).join(' ');
    const pathAS = tlA.map((p,i)=>`${i?'L':'M'}${px(p.t).toFixed(1)},${py(p.hull+p.shields).toFixed(1)}`).join(' ');
    const pathBS = tlB.map((p,i)=>`${i?'L':'M'}${px(p.t).toFixed(1)},${py(p.hull+p.shields).toFixed(1)}`).join(' ');
    const yTicks = [0,0.5,1].map(f => {
        const v=maxHP*f, y=py(v).toFixed(1), lb=v>=1000?(v/1000).toFixed(1)+'k':Math.round(v).toString();
        return `<line x1="${PL}" y1="${y}" x2="${PL+cW}" y2="${y}" stroke="rgba(148,163,184,0.12)" stroke-width="1"/>
                <text x="${PL-4}" y="${+y+4}" fill="#64748b" font-size="10" text-anchor="end">${lb}</text>`;
    }).join('');
    const xTicks = [0,0.5,1].map(f => {
        const t=maxTime*f, x=px(t).toFixed(1);
        return `<text x="${x}" y="${PT+cH+14}" fill="#64748b" font-size="10" text-anchor="middle">${t.toFixed(1)}s</text>`;
    }).join('');
    const threshA = sA.minHull>0 ? `<line x1="${PL}" y1="${py(sA.minHull).toFixed(1)}" x2="${PL+cW}" y2="${py(sA.minHull).toFixed(1)}" stroke="rgba(59,130,246,0.4)" stroke-width="1" stroke-dasharray="4,3"/>` : '';
    const threshB = sB.minHull>0 ? `<line x1="${PL}" y1="${py(sB.minHull).toFixed(1)}" x2="${PL+cW}" y2="${py(sB.minHull).toFixed(1)}" stroke="rgba(239,68,68,0.4)" stroke-width="1" stroke-dasharray="4,3"/>` : '';
    const trunc=(s,n)=>s.length>n?s.slice(0,n-1)+'…':s;
    const lx=PL+cW-4;
    const legend=`<rect x="${lx-80}" y="${PT+4}" width="8" height="3" fill="#3b82f6" rx="1"/>
        <text x="${lx-68}" y="${PT+9}" fill="#93c5fd" font-size="10" text-anchor="start">${escHtml(trunc(sA.name,18))}</text>
        <rect x="${lx-80}" y="${PT+16}" width="8" height="3" fill="#ef4444" rx="1"/>
        <text x="${lx-68}" y="${PT+21}" fill="#fca5a5" font-size="10" text-anchor="start">${escHtml(trunc(sB.name,18))}</text>`;
    return `<div class="hp-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;display:block;height:auto;">
        <rect x="${PL}" y="${PT}" width="${cW}" height="${cH}" fill="rgba(15,23,42,0.5)" rx="4"/>
        ${yTicks}${xTicks}${threshA}${threshB}
        <path d="${pathAS}" fill="none" stroke="rgba(59,130,246,0.35)" stroke-width="1.5"/>
        <path d="${pathAH}" fill="none" stroke="#3b82f6" stroke-width="2.5"/>
        <path d="${pathBS}" fill="none" stroke="rgba(239,68,68,0.35)" stroke-width="1.5"/>
        <path d="${pathBH}" fill="none" stroke="#ef4444" stroke-width="2.5"/>
        ${legend}
      </svg></div>`;
}

// ── Stats comparison grid ──────────────────────────────────────────────────────
function buildCompareGrid(sA, sB, result) {
    const ttkStrA = isFinite(result.ttkA) ? fmtTTK(result.ttkA)
        : result.projectedTtkA != null ? (isFinite(result.projectedTtkA) ? `~${fmtT(result.projectedTtkA)} (proj.)` : '∞ (regen wins)') : '∞ (survived)';
    const ttkStrB = isFinite(result.ttkB) ? fmtTTK(result.ttkB)
        : result.projectedTtkB != null ? (isFinite(result.projectedTtkB) ? `~${fmtT(result.projectedTtkB)} (proj.)` : '∞ (regen wins)') : '∞ (survived)';

    const sections = [
        ['Combat', [
            ['Time to Disable',   ttkStrA,                                   ttkStrB],
            ['Max Shields',       fmt(sA.maxShields),                        fmt(sB.maxShields)],
            ['Max Hull',          fmt(sA.maxHull),                           fmt(sB.maxHull)],
            ['Disable Threshold', fmt(sA.minHull),                           fmt(sB.minHull)],
            ['Shield DPS',        fmt(sA.shieldDPS),                         fmt(sB.shieldDPS)],
            ['Hull DPS',          fmt(sA.hullDPS),                           fmt(sB.hullDPS)],
            ['Shield Regen/s',    fmt(sA.shieldRegenPerSec),                 fmt(sB.shieldRegenPerSec)],
            ['Hull Repair/s',     fmt(sA.hullRepairPerSec),                  fmt(sB.hullRepairPerSec)],
            ['Shield Prot.',      fmtPct(sA.shieldProt),                     fmtPct(sB.shieldProt)],
            ['Hull Prot.',        fmtPct(sA.hullProt),                       fmtPct(sB.hullProt)],
            ['Pierce Resist.',    fmtPct(sA.piercingRes),                    fmtPct(sB.piercingRes)],
        ]],
        ['Energy & Heat', [
            ['Energy Cap.',       fmt(sA.energyCap),                         fmt(sB.energyCap)],
            ['Energy Gen/s',      fmt(sA.energyGenPerFrame*FPS),             fmt(sB.energyGenPerFrame*FPS)],
            ['Firing Energy/s',   fmt(sA.firingEnergyPerSec),                fmt(sB.firingEnergyPerSec)],
            ['Net Energy/s',
                fmtNet((sA.energyGenPerFrame-sA.energyConsumeIdlePerFrame-sA.movingEnergyPerFrame-sA.coolingEnergyPerFrame-sA.firingEnergyPerSec/FPS)*FPS),
                fmtNet((sB.energyGenPerFrame-sB.energyConsumeIdlePerFrame-sB.movingEnergyPerFrame-sB.coolingEnergyPerFrame-sB.firingEnergyPerSec/FPS)*FPS)],
            ['Heat Capacity',     fmt(sA.maxHeat),                           fmt(sB.maxHeat)],
            ['Cooling/s',         fmt(sA.coolingPerSec),                     fmt(sB.coolingPerSec)],
            ['Firing Heat/s',     fmt(sA.firingHeatPerSec),                  fmt(sB.firingHeatPerSec)],
            ['Cool Efficiency',   sA.coolEff.toFixed(3),                     sB.coolEff.toFixed(3)],
        ]],
        ['Navigation', [
            ['Mass',              fmt(sA.rawMass)+' t',                      fmt(sB.rawMass)+' t'],
            ['Inertial Mass',     fmt(sA.inertialMass)+' t',                 fmt(sB.inertialMass)+' t'],
            ['Max Velocity',      fmt(sA.maxVelocity)+' px/s',               fmt(sB.maxVelocity)+' px/s'],
        ]],
    ];

    return sections.map(([section, items]) => {
        const colA      = items.map(([,va])   => `<div class="res-row"><div class="res-row-value">${va}</div></div>`).join('');
        const colDiv    = items.map(([label]) => `<div class="res-divider-item">${label}</div>`).join('');
        const colB      = items.map(([,,vb])  => `<div class="res-row"><div class="res-row-value">${vb}</div></div>`).join('');
        const mobileRows = items.map(([label,va,vb]) =>
            `<div class="res-row-mobile">
                <span class="res-row-mobile__label">${label}</span>
                <span class="res-row-mobile__val-a">${va}</span>
                <span class="res-row-mobile__val-b">${vb}</span>
             </div>`).join('');
        return `<div class="res-section-title">${section}</div>
        <div class="results-compare">
            <div class="res-col res-col-a">${colA}</div>
            <div class="res-divider">${colDiv}</div>
            <div class="res-col res-col-b">${colB}</div>
            ${mobileRows}
        </div>`;
    }).join('');
}

// ── Weapons list ───────────────────────────────────────────────────────────────
function buildWeaponsList(details) {
    if (!details?.length)
        return '<div class="weapon-item" style="color:var(--c-text-muted);font-style:italic;padding:8px 0;">No weapons</div>';
    return details.map(w => {
        const extra = [];
        for (const typeName of _damageTypes) {
            if (typeName==='Shield'||typeName==='Hull') continue;
            const dps = w[typeName.toLowerCase()+'DPS']||0;
            if (dps>0.001) extra.push(`${typeName}: ${fmt(dps)}/s`);
        }
        if (w.relShield>0) extra.push(`%Shld: ${w.relShield}%/hit`);
        if (w.relHull>0)   extra.push(`%Hull: ${w.relHull}%/hit`);
        return `<div class="weapon-item">
            <div class="weapon-item-name">${escHtml(w.name)}${w.hasSubmunitions?`<span style="color:var(--c-accent-text);font-size:0.7em;margin-left:4px;">⚡sub</span>`:''}</div>
            <div class="weapon-item-stats">
                <span class="weapon-stat">Rate:<span>${w.sps}/s</span></span>
                <span class="weapon-stat">Shld:<span>${fmt(w.shieldDPS)}/s</span></span>
                <span class="weapon-stat">Hull:<span>${fmt(w.hullDPS)}/s</span></span>
                ${w.piercing?`<span class="weapon-stat">Pierce:<span>${w.piercing}%</span></span>`:''}
                ${w.range?`<span class="weapon-stat">Range:<span>${w.range}px</span></span>`:''}
                ${w.burstCount>1?`<span class="weapon-stat">Burst:<span>${w.burstCount}×</span></span>`:''}
                ${w.homing?`<span class="weapon-stat">🎯 Homing</span>`:''}
                ${w.antiMissile?`<span class="weapon-stat">🛡 A-M</span>`:''}
                ${extra.map(s=>`<span class="weapon-stat">${escHtml(s)}</span>`).join('')}
            </div>
        </div>`;
    }).join('');
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmt(n) {
    if (n===null||n===undefined) return '—';
    if (!isFinite(n)) return '∞';
    if (Math.abs(n)>=100000) return (n/1000).toFixed(1)+'k';
    if (Math.abs(n)>=10000)  return Math.round(n).toLocaleString();
    if (Math.abs(n)<0.01&&n!==0) return n.toExponential(2);
    if (Number.isInteger(n)) return n.toString();
    return parseFloat(n.toPrecision(4)).toString();
}
function fmtT(t)   { return isFinite(t) ? t.toFixed(1)+'s' : '∞'; }
function fmtTTK(t) { return isFinite(t) ? fmtT(t) : '∞ (never)'; }
function fmtPct(v, dp=1) { if (!v) return '0%'; return (v*(dp===1&&v<1?100:1)).toFixed(dp)+'%'; }
function fmtNet(v) { if (!isFinite(v)||v===0) return '0'; return (v>0?'+':'')+fmt(v); }
function escHtml(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Globals ────────────────────────────────────────────────────────────────────
window.searchShips   = searchShips;
window.openDropdown  = openDropdown;
window.blurDropdown  = blurDropdown;
window.clearSlot     = clearSlot;
window.runSimulation = runSimulation;

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('fightBtn');
    if (btn) btn.addEventListener('click', runSimulation);
    init();
});

})();