;(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  battleSim.js  —  Endless Sky Battle Simulator  (Multi-Team Edition)
//
//  ARCHITECTURE OVERVIEW
//  ─────────────────────
//  Teams are stored in _teams[], each team has:
//    { id, name, color, ships: [ { shipData, count, resolved } ] }
//
//  When simulating, each team's ships are merged into a single composite
//  "super-combatant" (stats scaled by count) and teams fight each other.
//
//  For 2-team battles the full timeline/chart is generated.
//  For N-team (N>2) battles a round-robin matrix is computed and displayed.
//
//  ZERO HARDCODING POLICY — all damage types, protection keys, resistance keys
//  and status effect names are read from attributeDefinitions.json via
//  _attrDefs exactly as the original battleSim.js did.
// ═══════════════════════════════════════════════════════════════════════════════

const FPS          = 60;
const MAX_SIM_SECS = 6000;
const MAX_FRAMES   = MAX_SIM_SECS * FPS;
const SOLAR_POWER  = 1.0;
const SHIELD_BLEED_FRACTION = 0.5;

const REPO_URL = 'GIVEMEFOOD5/endless-sky-ship-builder';
const BASE_URL = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;

let _allShips          = [];
let _outfitIndex       = {};
let _attrDefs          = null;
let _damageTypes       = [];
let _statusDecayMap    = {};
let _statusDescriptors = [];
let _weaponDataKeys    = new Set();

// ── TEAM STATE ─────────────────────────────────────────────────────────────────
// Each team: { id:string, name:string, color:string, ships:[{shipData,count,resolved}] }
let _teams = [];
let _nextTeamId = 1;

// Palette of colours for teams — extended to 30 entries
const TEAM_PALETTE = [
    '#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7',
    '#06b6d4','#f43f5e','#84cc16','#fb923c','#8b5cf6',
    '#14b8a6','#ec4899','#eab308','#6366f1','#10b981',
    '#f97316','#d946ef','#0ea5e9','#dc2626','#16a34a',
    '#7c3aed','#0891b2','#db2777','#ca8a04','#059669',
    '#4f46e5','#9333ea','#0284c7','#b91c1c','#15803d',
];

// ─────────────────────────────────────────────────────────────────────────────
//  FIRING_STATUS_MAP — built from _attrDefs if possible, fallback list kept
//  purely as a key-mapping reference that is only used in shootFrame.
// ─────────────────────────────────────────────────────────────────────────────
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

const FIRING_RESOURCE_KEYS = ['firing energy', 'firing fuel', 'firing hull', 'firing shields'];
function resourceLabel(key) { return key.replace(/^firing\s+/, ''); }

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
    hideResults();
    await loadData();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fetch helpers (unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_PREFIX      = `es-sim:${REPO_URL}:`;
const MAX_FETCH_RETRIES = 4;

async function cachedFetchJSON(url) {
    const cacheKey = CACHE_PREFIX + url;
    try { const c = sessionStorage.getItem(cacheKey); if (c) return JSON.parse(c); } catch (_) {}
    let lastErr;
    for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = Math.pow(2, attempt) * 500;
            setStatus(`Rate limited — retrying in ${(delay/1000).toFixed(1)}s… (${attempt}/${MAX_FETCH_RETRIES})`);
            await new Promise(r => setTimeout(r, delay));
        }
        try {
            const res = await fetch(url);
            if (res.status === 429) { lastErr = new Error('429'); continue; }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            try { sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch (_) {}
            return data;
        } catch (err) { lastErr = err; if (!err.message.includes('429')) throw err; }
    }
    throw lastErr ?? new Error(`Failed to fetch ${url}`);
}

async function cachedFetchJSONSoft(url) {
    const cacheKey = CACHE_PREFIX + url;
    try { const c = sessionStorage.getItem(cacheKey); if (c) return JSON.parse(c); } catch (_) {}
    for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
        try {
            const res = await fetch(url);
            if (res.status === 429) continue;
            if (res.status === 404 || !res.ok) return null;
            const data = await res.json();
            try { sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch (_) {}
            return data;
        } catch (_) { return null; }
    }
    return null;
}

async function loadData() {
    setStatus('Loading plugin data…');
    try {
        const attrDefs = await cachedFetchJSON(`${BASE_URL}/attributeDefinitions.json`);
        if (attrDefs) {
            _attrDefs          = attrDefs;
            _damageTypes       = _attrDefs?.weapon?.damageTypes || [];
            const sed          = _attrDefs?.weapon?.statusEffectDecay;
            _statusDecayMap    = sed?.decayMap    || {};
            _statusDescriptors = sed?.descriptors || [];
            _weaponDataKeys    = new Set(_attrDefs?.weapon?.dataFileKeys || []);
            if (typeof initComputedStats === 'function') initComputedStats(_attrDefs, BASE_URL);
            if (typeof window.DamageTypes?.init === 'function') window.DamageTypes.init(_attrDefs);
            if (typeof window.MunitionTypes?.init === 'function') window.MunitionTypes.init(() => _outfitIndex, _attrDefs);
        }
    } catch (e) { console.warn('Failed to load attributeDefinitions.json:', e.message); }

    let dataIndex;
    try { dataIndex = await cachedFetchJSON(`${BASE_URL}/index.json`); }
    catch (err) { setStatus(`Error: ${err.message}`, true); return; }

    window._indexPluginOrder = [];
    for (const pluginList of Object.values(dataIndex))
        for (const { outputName } of pluginList)
            window._indexPluginOrder.push(outputName);

    window.allData = {};
    for (const [, pluginList] of Object.entries(dataIndex)) {
        for (const { outputName, displayName, sourceName } of pluginList) {
            const pluginData = { sourceName, displayName, outputName, ships:[], variants:[], outfits:[] };
            try {
                const base = `${BASE_URL}/${outputName}/dataFiles`;
                const [ships, variants, outfits] = await Promise.all([
                    cachedFetchJSONSoft(`${base}/ships.json`),
                    cachedFetchJSONSoft(`${base}/variants.json`),
                    cachedFetchJSONSoft(`${base}/outfits.json`),
                ]);
                let loaded = false;
                if (ships)    { pluginData.ships    = ships;    loaded = true; }
                if (variants) { pluginData.variants = variants; loaded = true; }
                if (outfits)  { pluginData.outfits  = outfits;  loaded = true; }
                if (loaded) window.allData[outputName] = pluginData;
            } catch (err) { console.warn(`Failed loading plugin ${outputName}:`, err); }
        }
    }

    if (!Object.keys(window.allData).length) { setStatus('Error: no plugin data loaded.', true); return; }
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
        const d = allData[pid]; if (!d) continue;
        for (const outfit of (d.outfits || []))
            if (outfit.name && !_outfitIndex[outfit.name])
                _outfitIndex[outfit.name] = { ...outfit, _pluginId: pid };
    }
    for (const pid of activePlugins) {
        const d = allData[pid]; if (!d) continue;
        for (const ship of [...(d.ships || []), ...(d.variants || [])])
            _allShips.push({ ...ship, _pluginId: pid });
    }
    const primaryPlugin = activePlugins[0] || null;
    if (primaryPlugin) {
        if (typeof window.setCurrentPlugin  === 'function') window.setCurrentPlugin(primaryPlugin);
        if (typeof window.initImageIndex    === 'function') await window.initImageIndex(primaryPlugin);
    }
    document.getElementById('simPanel').style.display = 'block';
    renderAllTeams();
    updateSimButton();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ATTRIBUTE HELPERS  (identical to original)
// ═══════════════════════════════════════════════════════════════════════════════

function getStacking(key) { return (_attrDefs?.attributes?.[key]?.stacking) || 'additive'; }
function getProtectionKeys() {
    if (!_attrDefs?.attributes) return [];
    return Object.keys(_attrDefs.attributes).filter(k => k.endsWith(' protection'));
}
function getResistanceKeys() {
    if (!_attrDefs?.attributes) return [];
    return Object.keys(_attrDefs.attributes).filter(k => k.endsWith(' resistance'));
}

const dmgKey    = t => t.toLowerCase() + ' damage';
const protKey   = t => t.toLowerCase() + ' protection';
const relDmgKey = t => '% ' + t.toLowerCase() + ' damage';

// ═══════════════════════════════════════════════════════════════════════════════
//  OUTFIT ATTRIBUTE EXTRACTION  (identical to original)
// ═══════════════════════════════════════════════════════════════════════════════

const OUTFIT_META_KEYS = new Set([
    '_pluginId','name','displayName','pluralName','category',
    'weapon','attributes','description','thumbnail','sprite',
    'licenses','series','index','ammoStored','cost','mass',
    'flareSprites','reverseFlareSprites','steeringFlareSprites',
    'flareSounds','jumpEffects','hyperSounds','jumpSounds',
    'flotsamSprite','ammo','isDefined',
]);

function extractOutfitAttributes(outfit) {
    const merged = {};
    for (const [key, val] of Object.entries(outfit)) {
        if (OUTFIT_META_KEYS.has(key)) continue;
        if (typeof val === 'number') merged[key] = val;
    }
    if (outfit.attributes && typeof outfit.attributes === 'object')
        for (const [key, val] of Object.entries(outfit.attributes))
            if (typeof val === 'number') merged[key] = val;
    return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STAT RESOLUTION  (identical to original)
// ═══════════════════════════════════════════════════════════════════════════════

function resolveShipStats(ship) {
    const combined            = { ...(ship.attributes || {}) };
    const weapons             = [];
    const outfitContributions = {};

    for (const [outfitName, qty] of Object.entries(ship.outfitMap || {})) {
        const outfit = _outfitIndex[outfitName];
        if (!outfit) continue;
        if (outfit.weapon)
            for (let i = 0; i < qty; i++) weapons.push({ _name: outfitName, ...outfit.weapon });
        const attrs = extractOutfitAttributes(outfit);
        for (const [key, rawVal] of Object.entries(attrs)) {
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
    const rawMass      = a('mass');
    const inertialMass = rawMass / (1 + a('inertia reduction'));
    const drag         = Math.min(a('drag') / (1 + a('drag reduction')), inertialMass);
    const maxShields   = a('shields') * (1 + a('shield multiplier'));
    const maxHull      = a('hull')    * (1 + a('hull multiplier'));
    const absThresh    = a('absolute threshold');
    const minHull      = absThresh > 0
        ? absThresh
        : Math.max(0, Math.floor(a('threshold percentage') * maxHull + a('hull threshold')));

    const x           = a('cooling inefficiency');
    const coolEff     = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));
    const maxHeat     = 100 * (rawMass + a('heat capacity'));
    const heatDissipFrac     = 0.001 * a('heat dissipation');
    const coolingPerFrame    = coolEff * (a('cooling') + a('active cooling'));
    const shieldRegenPerFrame   = a('shield generation')         * (1 + a('shield generation multiplier'));
    const delayedShieldPerFrame = a('delayed shield generation') * (1 + a('shield generation multiplier'));
    const hullRepairPerFrame    = a('hull repair rate')          * (1 + a('hull repair multiplier'));
    const delayedHullPerFrame   = a('delayed hull repair rate')  * (1 + a('hull repair multiplier'));

    const protections = {};
    for (const key of getProtectionKeys()) protections[key] = Math.max(0, Math.min(1, a(key)));
    const shieldProt  = protections['shield protection'] || 0;
    const hullProt    = protections['hull protection']   || 0;
    const piercingRes = Math.max(0, Math.min(1, a('piercing resistance')));
    const statusResist = {};
    for (const [statName, resistKey] of Object.entries(_statusDecayMap))
        statusResist[statName] = Math.max(0, a(resistKey));

    const energyCap              = a('energy capacity');
    const energyGenPerFrame      = a('energy generation') + a('solar collection') * SOLAR_POWER + a('ram scoop');
    const energyConsumeIdlePerFrame = a('energy consumption');
    const movingEnergyPerFrame   = a('thrusting energy') + a('turning energy') + a('afterburner energy');
    const coolingEnergyPerFrame  = a('cooling energy');
    const heatGenIdlePerFrame    = a('heat generation');
    const movingHeatPerFrame     = a('thrusting heat') + a('turning heat') + a('afterburner heat');
    const fuelCap                = a('fuel capacity');
    const fuelRegenPerFrame      = a('fuel generation') + a('ram scoop') * 0;

    const ammoInventory = {};
    for (const [outfitName, qty] of Object.entries(ship.outfitMap || {})) {
        const outfit = _outfitIndex[outfitName];
        if (!outfit) continue;
        const isAmmoOutfit =
            outfit.category === 'Ammunition' ||
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) ||
            (typeof outfit.attributes?.[outfitName] === 'number' && outfit.attributes[outfitName] > 0);
        if (!isAmmoOutfit) continue;
        let roundsPerUnit = 0;
        if (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) roundsPerUnit = outfit.ammoStored;
        if (roundsPerUnit === 0) {
            const attrs = extractOutfitAttributes(outfit);
            if (typeof attrs[outfitName] === 'number' && attrs[outfitName] > 0) roundsPerUnit = attrs[outfitName];
        }
        if (roundsPerUnit === 0) roundsPerUnit = 1;
        ammoInventory[outfitName] = (ammoInventory[outfitName] || 0) + roundsPerUnit * qty;
    }

    const thrustForVel = a('thrust') || a('afterburner thrust');
    const maxVelocity  = drag > 0 ? thrustForVel / drag : 0;
    const acceleration = inertialMass > 0 ? (a('thrust') / inertialMass) * (1 + a('acceleration multiplier')) : 0;

    return {
        name: ship.name, pluginId: ship._pluginId, rawShip: ship,
        combined, weapons, outfitContributions, protections,
        maxShields, maxHull, minHull,
        hullToDisable: Math.max(0, maxHull - minHull),
        shieldRegenPerFrame, delayedShieldPerFrame,
        hullRepairPerFrame,  delayedHullPerFrame,
        shieldRegenPerSec: (shieldRegenPerFrame + delayedShieldPerFrame) * FPS,
        hullRepairPerSec:  (hullRepairPerFrame  + delayedHullPerFrame)  * FPS,
        shieldDelay: a('shield delay'), repairDelay: a('repair delay'),
        depletedDelay: a('depleted shield delay'),
        shieldProt, hullProt, piercingRes, statusResist,
        energyCap, energyGenPerFrame, energyConsumeIdlePerFrame,
        movingEnergyPerFrame, coolingEnergyPerFrame,
        maxHeat, heatDissipFrac, coolingPerFrame, coolingPerSec: coolingPerFrame * FPS,
        heatGenIdlePerFrame, movingHeatPerFrame, coolEff,
        fuelCap, fuelRegenPerFrame,
        rawMass, inertialMass, drag,
        maxVelocity: maxVelocity * FPS,
        acceleration: acceleration * FPS * FPS,
        ammoInventory,
        ...analyzeWeapons(weapons),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COMPOSITE STATS — merges N copies of a ship (or N different ships) into one
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * mergeTeamStats(teamShipEntries)
 * teamShipEntries: [{ resolved: shipStats, count: number }, ...]
 *
 * Returns a combined stats object where all numeric totals are scaled by count.
 * Protection/resistance values are NOT simply summed — they are averaged weighted
 * by count (since they are fractions, not additive buffs).
 * The name is the team name, set by the caller.
 */
function mergeTeamStats(entries) {
    if (!entries.length) return null;
    const totalCount = entries.reduce((s, e) => s + e.count, 0);

    // Additive fields — sum × count
    const addFields = [
        'maxShields','maxHull','minHull','hullToDisable',
        'shieldRegenPerFrame','delayedShieldPerFrame',
        'hullRepairPerFrame','delayedHullPerFrame',
        'shieldRegenPerSec','hullRepairPerSec',
        'energyCap','energyGenPerFrame','energyConsumeIdlePerFrame',
        'movingEnergyPerFrame','coolingEnergyPerFrame',
        'maxHeat','coolingPerFrame','coolingPerSec',
        'heatGenIdlePerFrame','movingHeatPerFrame',
        'fuelCap','fuelRegenPerFrame',
        'rawMass','inertialMass',
        'shieldDPS','hullDPS','heatDPS','ionDPS','disruptionDPS','slowingDPS',
        'firingEnergyPerSec','firingHeatPerSec','firingFuelPerSec',
        'firingHullCostPerSec','firingShieldCostPerSec',
    ];

    // Protection / resistance — weighted average by count
    const protFields = ['shieldProt','hullProt','piercingRes'];

    // Build merged
    const merged = {};
    for (const f of addFields) {
        merged[f] = entries.reduce((s, e) => s + (e.resolved[f] || 0) * e.count, 0);
    }
    for (const f of protFields) {
        merged[f] = entries.reduce((s, e) => s + (e.resolved[f] || 0) * e.count, 0) / totalCount;
    }

    // Protections map — weighted average
    const allProtKeys = new Set();
    for (const e of entries) for (const k of Object.keys(e.resolved.protections || {})) allProtKeys.add(k);
    merged.protections = {};
    for (const k of allProtKeys) {
        merged.protections[k] = entries.reduce((s, e) => s + (e.resolved.protections?.[k] || 0) * e.count, 0) / totalCount;
    }

    // Status resistances — weighted average
    merged.statusResist = {};
    const allStatNames = new Set();
    for (const e of entries) for (const k of Object.keys(e.resolved.statusResist || {})) allStatNames.add(k);
    for (const k of allStatNames) {
        merged.statusResist[k] = entries.reduce((s, e) => s + (e.resolved.statusResist?.[k] || 0) * e.count, 0) / totalCount;
    }

    // Weapons — replicate × count for each ship entry
    merged.weapons = [];
    for (const e of entries)
        for (let c = 0; c < e.count; c++)
            for (const w of e.resolved.weapons) merged.weapons.push(w);

    // Weapon details (for display) — also replicated
    merged.weaponDetails = [];
    for (const e of entries)
        for (let c = 0; c < e.count; c++)
            for (const wd of (e.resolved.weaponDetails || [])) merged.weaponDetails.push(wd);

    // Ammo inventory — sum × count
    merged.ammoInventory = {};
    for (const e of entries) {
        for (const [k, v] of Object.entries(e.resolved.ammoInventory || {}))
            merged.ammoInventory[k] = (merged.ammoInventory[k] || 0) + v * e.count;
    }

    // Timing fields — take worst-case (max) so defences are correctly modelled
    merged.shieldDelay    = entries.reduce((m, e) => Math.max(m, e.resolved.shieldDelay    || 0), 0);
    merged.repairDelay    = entries.reduce((m, e) => Math.max(m, e.resolved.repairDelay    || 0), 0);
    merged.depletedDelay  = entries.reduce((m, e) => Math.max(m, e.resolved.depletedDelay  || 0), 0);

    // Heat dissipation fraction — weighted average
    merged.heatDissipFrac = entries.reduce((s, e) => s + (e.resolved.heatDissipFrac || 0) * e.count, 0) / totalCount;
    merged.coolEff        = entries.reduce((s, e) => s + (e.resolved.coolEff        || 0) * e.count, 0) / totalCount;

    // DPS map
    merged.dps = {};
    for (const t of _damageTypes)
        merged.dps[t] = entries.reduce((s, e) => s + (e.resolved.dps?.[t] || 0) * e.count, 0);

    // Per-type DPS convenience fields
    for (const t of _damageTypes)
        merged[t.toLowerCase() + 'DPS'] = merged.dps[t] || 0;

    // Name set by caller
    merged.name        = '?';
    merged.pluginId    = null;
    merged.rawShip     = entries[0].resolved.rawShip;   // for ammo display only
    merged._teamShips  = entries;                        // reference for display

    return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WEAPON HELPERS  (unchanged from original)
// ═══════════════════════════════════════════════════════════════════════════════

function resolveSubmunitionRefs(w) {
    const results = [];
    const rawSub = w.submunition;
    if (rawSub != null) {
        const entries = Array.isArray(rawSub) ? rawSub : [rawSub];
        for (const entry of entries) {
            const subName  = typeof entry === 'string' ? entry
                           : typeof entry === 'object' ? (entry?.name ?? null) : null;
            const subCount = typeof entry === 'object' && entry !== null ? (entry.count ?? 1) : 1;
            if (subName) results.push({ subName, subCount });
        }
        if (results.length > 0) return results;
    }
    for (const key of Object.keys(w)) {
        if (!key.startsWith('submunition ')) continue;
        const subName = key.slice('submunition '.length).trim();
        if (!subName) continue;
        const val = w[key];
        const subCount = Array.isArray(val) ? val.length : typeof val === 'number' ? Math.max(1, val) : 1;
        results.push({ subName, subCount });
    }
    if (results.length > 0) return results;
    for (const key of Object.keys(w)) {
        if (key === 'submunition' || key.startsWith('submunition ')) continue;
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;
        const outfit = _outfitIndex[key];
        if (!outfit?.weapon) continue;
        const isAmmo =
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0)
         || outfit.category === 'Ammunition'
         || (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0);
        if (isAmmo) continue;
        const subCount = val === true ? 1 : Math.max(1, Math.round(val));
        results.push({ subName: key, subCount });
    }
    return results;
}

function resolveEffectiveRange(w, visited, depth, inheritedVelocity) {
    if (depth > 8) return null;
    const vel      = (w.velocity || 0) > 0 ? (w.velocity || 0) : (inheritedVelocity || 0);
    const life     = w.lifetime  || 0;
    const ownRange = vel * life;
    const subs = resolveSubmunitionRefs(w);
    if (!subs.length) return ownRange > 0 ? ownRange : null;
    let maxSubRange = 0, anySubHasRange = false;
    for (const { subName } of subs) {
        if (visited && visited.has(subName)) continue;
        const subOutfit = _outfitIndex[subName];
        if (!subOutfit?.weapon) continue;
        const nv = new Set(visited || []); nv.add(subName);
        const subRange = resolveEffectiveRange(subOutfit.weapon, nv, depth + 1, vel);
        if (subRange !== null) { anySubHasRange = true; if (subRange > maxSubRange) maxSubRange = subRange; }
    }
    const total = ownRange + maxSubRange;
    return (total > 0 || anySubHasRange) ? total : null;
}

function resolveSubmunitionDamage(weapon, multiplier, visited, depth) {
    if (depth > 8) return {};
    const totals = {};
    for (const typeName of _damageTypes) {
        const val = weapon[dmgKey(typeName)] || 0;
        if (val) totals[typeName] = (totals[typeName] || 0) + val * multiplier;
    }
    for (const { subName, subCount } of resolveSubmunitionRefs(weapon)) {
        if (visited.has(subName)) continue;
        const nv = new Set(visited); nv.add(subName);
        const sub = _outfitIndex[subName];
        if (!sub?.weapon) continue;
        const subDmg = resolveSubmunitionDamage(sub.weapon, multiplier * subCount, nv, depth + 1);
        for (const [t, v] of Object.entries(subDmg)) totals[t] = (totals[t] || 0) + v;
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
        const munitionInfo   = window.MunitionTypes?.analyseWeapon?.(w, w._name) ?? null;
        const reload         = Math.max(1, w.reload || 1);
        const burstCount     = w['burst count']  || 1;
        const burstReload    = w['burst reload'] || reload;
        const framesPerCycle = (burstCount - 1) * burstReload + reload;
        const sps            = (burstCount / framesPerCycle) * FPS;
        const piercing       = Math.max(0, Math.min(1, w.piercing || 0));
        const visited        = new Set([w._name].filter(Boolean));
        const dmgPerShot     = resolveSubmunitionDamage(w, 1, visited, 0);
        for (const t of _damageTypes) if (dmgPerShot[t] === undefined) dmgPerShot[t] = 0;
        for (const t of _damageTypes) totalDPS[t] = (totalDPS[t] || 0) + dmgPerShot[t] * sps;
        for (const k of firingCostKeys) totalFiring[k] = (totalFiring[k] || 0) + (w[k] || 0) * sps;

        const detail = {
            name: w._name || 'Unknown', munition: munitionInfo,
            reload, burstCount, burstReload, framesPerCycle,
            sps: +sps.toFixed(3), piercing: +(piercing * 100).toFixed(0),
            range: resolveEffectiveRange(w, new Set([w._name].filter(Boolean)), 0, 0),
            homing: (w.homing || 0) > 0, antiMissile: (w['anti-missile'] || 0) > 0,
            hasSubmunitions: resolveSubmunitionRefs(w).length > 0, dmgPerShot,
            relShield: +((w['% shield damage'] || 0) * 100).toFixed(1),
            relHull:   +((w['% hull damage']   || 0) * 100).toFixed(1),
        };
        for (const t of _damageTypes) detail[t.toLowerCase() + 'DPS'] = +(dmgPerShot[t] * sps).toFixed(2);
        details.push(detail);
    }

    const result = { dps: totalDPS, weaponDetails: details };
    for (const t of _damageTypes) result[t.toLowerCase() + 'DPS'] = totalDPS[t] || 0;
    result.shieldDPS     = totalDPS['Shield']     || 0;
    result.hullDPS       = totalDPS['Hull']       || 0;
    result.heatDPS       = totalDPS['Heat']       || 0;
    result.ionDPS        = totalDPS['Ion']        || 0;
    result.disruptionDPS = totalDPS['Disruption'] || 0;
    result.slowingDPS    = totalDPS['Slowing']    || 0;
    result.firingEnergyPerSec     = +(totalFiring['firing energy']  || 0).toFixed(3);
    result.firingHeatPerSec       = +(totalFiring['firing heat']    || 0).toFixed(3);
    result.firingFuelPerSec       = +(totalFiring['firing fuel']    || 0).toFixed(3);
    result.firingHullCostPerSec   = +(totalFiring['firing hull']    || 0).toFixed(3);
    result.firingShieldCostPerSec = +(totalFiring['firing shields'] || 0).toFixed(3);
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AMMO / FIRING HELPERS  (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

function _isNegativeCapacityAmmo(outfit, outfitName) {
    const attrs = extractOutfitAttributes(outfit);
    for (const [key, val] of Object.entries(attrs))
        if (key.endsWith(' capacity') && typeof val === 'number' && val < 0) return true;
    return false;
}

function resolveAmmoRef(w) {
    const rawAmmoField = w['ammo'];
    if (typeof rawAmmoField === 'string' && rawAmmoField.length > 0)
        return { ammoName: rawAmmoField, ammoCount: 1 };
    for (const key of Object.keys(w)) {
        if (key === 'ammo') continue;
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;
        const outfit = _outfitIndex[key];
        if (outfit) {
            const isAmmo =
                outfit.category === 'Ammunition' ||
                (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) ||
                (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0) ||
                _isNegativeCapacityAmmo(outfit, key);
            if (!isAmmo) continue;
            return { ammoName: key, ammoCount: val === true ? 1 : Math.max(1, Math.round(val)) };
        }
        if (typeof val === 'number' && val >= 1 && !_weaponDataKeys.has(key))
            return { ammoName: key, ammoCount: Math.max(1, Math.round(val)) };
    }
    return null;
}

function canWeaponFire(w, st, stats) {
    const fe = w['firing energy'] || 0;
    if (fe > 0 && (st.isIonized || st.energy < fe)) return 'firing energy';
    const ff = w['firing fuel'] || 0;
    if (ff > 0 && st.fuel < ff) return 'firing fuel';
    const fh = w['firing hull'] || 0;
    if (fh > 0 && st.hull - fh < stats.minHull) return 'firing hull';
    const fs = w['firing shields'] || 0;
    if (fs > 0 && st.shields < fs) return 'firing shields';
    const ammoRef = resolveAmmoRef(w);
    if (ammoRef?.ammoName) {
        const have = st.ammoInventory[ammoRef.ammoName] ?? 0;
        if (have < ammoRef.ammoCount) return 'ammo:' + ammoRef.ammoName;
    }
    return null;
}

function consumeFiringCosts(w, st) {
    st.energy  -= (w['firing energy']  || 0);
    st.fuel    -= (w['firing fuel']    || 0);
    st.hull    -= (w['firing hull']    || 0);
    st.shields -= (w['firing shields'] || 0);
    st.heat    += (w['firing heat']    || 0);
    const ammoRef = resolveAmmoRef(w);
    if (ammoRef?.ammoName && st.ammoInventory[ammoRef.ammoName] != null)
        st.ammoInventory[ammoRef.ammoName] =
            Math.max(0, st.ammoInventory[ammoRef.ammoName] - ammoRef.ammoCount);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SUSTAIN EVENT TRACKING  (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

function _isAmmoReason(r) { return typeof r === 'string' && r.startsWith('ammo:'); }

const STALL_CONFIRM_FRAMES  = 2 * 60;
const RESUME_CONFIRM_FRAMES = 1 * 60;

function createSustainState(stats) {
    const resourceState = {};
    for (const key of FIRING_RESOURCE_KEYS) {
        resourceState[key] = { reported:false, stallFrames:0, resumeFrames:0, reportedNames:[] };
    }
    return { resourceState, ammoExhausted: new Set() };
}

function checkWeaponSustainEvents(st, stats, side, t, sus, phases) {
    const weapons = stats.weapons;
    if (!weapons.length) return;
    for (let i = 0; i < weapons.length; i++) {
        const w      = weapons[i];
        const reason = canWeaponFire(w, st, stats);
        if (!_isAmmoReason(reason)) continue;
        const name     = w._name || ('Weapon '+(i+1));
        const ammoName = reason.slice(5);
        const key      = name + '::' + ammoName;
        if (!sus.ammoExhausted.has(key)) {
            sus.ammoExhausted.add(key);
            phases.push({
                time: t, type: side, icon: '📦',
                text: `<strong>${escHtml(stats.name)}</strong>'s ` +
                      `<em>${escHtml(name)}</em> ran out of <em>${escHtml(ammoName)}</em> at ${fmtT(t)} — offline`,
            });
        }
    }
    for (const key of FIRING_RESOURCE_KEYS) {
        const rs = sus.resourceState[key];
        const blocked = [];
        for (let i = 0; i < weapons.length; i++) {
            const w = weapons[i];
            if ((w[key] || 0) === 0) continue;
            if (canWeaponFire(w, st, stats) === key) blocked.push(w._name || ('Weapon '+(i+1)));
        }
        if (blocked.length > 0) {
            rs.stallFrames++; rs.resumeFrames = 0;
            if (!rs.reported && rs.stallFrames === STALL_CONFIRM_FRAMES) {
                rs.reported = true; rs.reportedNames = [...new Set(blocked)];
                const label   = resourceLabel(key);
                const nameStr = rs.reportedNames.map(n => `<em>${escHtml(n)}</em>`).join(', ');
                const verb    = rs.reportedNames.length === 1 ? 'is' : 'are';
                phases.push({ time:t, type:side, icon:'⚠️',
                    text:`<strong>${escHtml(stats.name)}</strong>'s ${nameStr} ${verb} unable to sustain — ${escHtml(label)} low at ${fmtT(t)}` });
            }
        } else {
            rs.resumeFrames++; rs.stallFrames = 0;
            if (rs.reported && rs.resumeFrames === RESUME_CONFIRM_FRAMES) {
                rs.reported = false;
                const label   = resourceLabel(key);
                const nameStr = rs.reportedNames.map(n => `<em>${escHtml(n)}</em>`).join(', ');
                const verb    = rs.reportedNames.length === 1 ? 'has' : 'have';
                phases.push({ time:t, type:side, icon:'🔄',
                    text:`<strong>${escHtml(stats.name)}</strong>'s ${nameStr} ${verb} resumed — ${escHtml(label)} restored at ${fmtT(t)}` });
                rs.reportedNames = [];
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COMBAT SIMULATION CORE  (2-team, unchanged logic)
// ═══════════════════════════════════════════════════════════════════════════════

function createCombatantState(stats) {
    const statusEffects = {};
    for (const statName of Object.keys(_statusDecayMap)) statusEffects[statName] = 0;
    return {
        stats,
        shields: stats.maxShields, hull: stats.maxHull,
        energy: stats.energyCap, heat: 0,
        fuel: stats.fuelCap > 0 ? stats.fuelCap : 0,
        ammoInventory: { ...(stats.ammoInventory || {}) },
        statusEffects,
        shieldDelayCounter: 0, repairDelayCounter: 0, depletedFlag: false,
        weaponReloadCounters: stats.weapons.map(() => 0),
        weaponBurstCounters:  stats.weapons.map(() => 0),
        disabled: false, disabledAt: Infinity,
        destroyed: false, destroyedAt: Infinity,
        isOverheated: false, isIonized: false,
        totalShieldDamageReceived: 0, totalHullDamageReceived: 0,
    };
}

function simulateBattle(sA, sB) {
    const result = { winner:null, ttkA:Infinity, ttkB:Infinity,
        projectedTtkA:null, projectedTtkB:null, phases:[], warnings:[] };
    const stA = createCombatantState(sA);
    const stB = createCombatantState(sB);
    const susA = createSustainState(sA), susB = createSustainState(sB);
    const milestones = {
        A: { shieldsBroken:false, halfHull:false, disabled:false, energyBlackout:false, overheated:false, heavilySlowed:false },
        B: { shieldsBroken:false, halfHull:false, disabled:false, energyBlackout:false, overheated:false, heavilySlowed:false },
    };
    const timelineA = [], timelineB = [];
    let frame = 0;

    while (frame < MAX_FRAMES) {
        const t = frame / FPS;
        if (frame % 6 === 0) {
            timelineA.push({ t, shields:stA.shields, hull:stA.hull, energy:stA.energy, heat:stA.heat });
            timelineB.push({ t, shields:stB.shields, hull:stB.hull, energy:stB.energy, heat:stB.heat });
        }
        if (!stA.disabled && !stA.destroyed) checkWeaponSustainEvents(stA, sA, 'A', t, susA, result.phases);
        if (!stB.disabled && !stB.destroyed) checkWeaponSustainEvents(stB, sB, 'B', t, susB, result.phases);

        const preShieldsA=stA.shields, preHullA=stA.hull;
        const preShieldsB=stB.shields, preHullB=stB.hull;
        if (!stA.disabled && !stA.destroyed) shootFrame(stA, stB, sA);
        if (!stB.disabled && !stB.destroyed) shootFrame(stB, stA, sB);
        stA.totalShieldDamageReceived += Math.max(0, preShieldsA - stA.shields);
        stA.totalHullDamageReceived   += Math.max(0, preHullA   - stA.hull);
        stB.totalShieldDamageReceived += Math.max(0, preShieldsB - stB.shields);
        stB.totalHullDamageReceived   += Math.max(0, preHullB   - stB.hull);

        doGeneration(stA, sA); doGeneration(stB, sB);
        doRegen(stA, sA);      doRegen(stB, sB);
        decayStatusEffects(stA, sA); decayStatusEffects(stB, sB);
        stA.isOverheated = stA.heat >= sA.maxHeat;
        stB.isOverheated = stB.heat >= sB.maxHeat;
        stA.isIonized    = sA.movingEnergyPerFrame > 0 && (stA.statusEffects.ionization || 0) > stA.energy;
        stB.isIonized    = sB.movingEnergyPerFrame > 0 && (stB.statusEffects.ionization || 0) > stB.energy;
        stA.shields = Math.max(0, Math.min(sA.maxShields, stA.shields));
        stB.shields = Math.max(0, Math.min(sB.maxShields, stB.shields));
        stA.energy  = Math.max(0, Math.min(sA.energyCap,  stA.energy));
        stB.energy  = Math.max(0, Math.min(sB.energyCap,  stB.energy));
        stA.heat = Math.max(0, stA.heat);
        stB.heat = Math.max(0, stB.heat);
        if (sA.fuelCap > 0) stA.fuel = Math.max(0, Math.min(sA.fuelCap, stA.fuel));
        if (sB.fuelCap > 0) stB.fuel = Math.max(0, Math.min(sB.fuelCap, stB.fuel));

        checkMilestones(stA, sA, 'A', t, milestones.A, result.phases);
        checkMilestones(stB, sB, 'B', t, milestones.B, result.phases);

        if (!stA.disabled && stA.hull < sA.minHull) {
            stA.disabled = true; stA.disabledAt = t; result.ttkA = t;
            if (!milestones.A.disabled) { milestones.A.disabled = true;
                result.phases.push({ time:t, type:'A', icon:'💥',
                    text:`<strong>${escHtml(sA.name)}</strong> disabled at ${fmtT(t)}` }); }
        }
        if (!stB.disabled && stB.hull < sB.minHull) {
            stB.disabled = true; stB.disabledAt = t; result.ttkB = t;
            if (!milestones.B.disabled) { milestones.B.disabled = true;
                result.phases.push({ time:t, type:'B', icon:'💥',
                    text:`<strong>${escHtml(sB.name)}</strong> disabled at ${fmtT(t)}` }); }
        }
        if (!stA.destroyed && stA.hull < 0) { stA.destroyed = true; stA.destroyedAt = t; }
        if (!stB.destroyed && stB.hull < 0) { stB.destroyed = true; stB.destroyedAt = t; }
        if ((stA.disabled || stA.destroyed) && (stB.disabled || stB.destroyed)) break;
        frame++;
    }

    const finalT = frame / FPS;
    if (!timelineA.length || timelineA[timelineA.length-1].t < finalT) {
        timelineA.push({ t:finalT, shields:stA.shields, hull:stA.hull, energy:stA.energy, heat:stA.heat });
        timelineB.push({ t:finalT, shields:stB.shields, hull:stB.hull, energy:stB.energy, heat:stB.heat });
    }
    result.timelineA = timelineA; result.timelineB = timelineB;
    result.finalStateA = stA;     result.finalStateB = stB;

    const aKilled=isFinite(result.ttkA), bKilled=isFinite(result.ttkB);
    if (!aKilled && !bKilled) {
        result.winner = 'draw';
        result.phases.push({ time:finalT, type:'neutral', icon:'🤝', text:'Neither side could disable the other — draw.' });
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

function shootFrame(attSt, defSt, attStats) {
    if (attSt.isOverheated) return;
    for (let i = 0; i < attStats.weapons.length; i++) {
        const w = attStats.weapons[i];
        if (attSt.weaponReloadCounters[i] > 0) { attSt.weaponReloadCounters[i]--; continue; }
        const reload = Math.max(1, w.reload || 1);
        const burstCount  = w['burst count']  || 1;
        const burstReload = w['burst reload'] || reload;
        if (canWeaponFire(w, attSt, attStats) !== null) { advanceBurst(attSt, i, burstCount, burstReload, reload); continue; }
        const scrambling = attSt.statusEffects.scrambling || 0;
        if (scrambling > 0.1 && Math.random() < (1 - Math.pow(2, -scrambling / 70))) {
            advanceBurst(attSt, i, burstCount, burstReload, reload); continue;
        }
        consumeFiringCosts(w, attSt);
        for (const [statName, firingKey] of Object.entries(FIRING_STATUS_MAP)) {
            const val = w[firingKey] || 0;
            if (val > 0) attSt.statusEffects[statName] = (attSt.statusEffects[statName] || 0) + val;
        }
        const visited = new Set([w._name].filter(Boolean));
        applyWeaponDamage(w, defSt, defSt.stats, 1, visited, 0);
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

function applyWeaponDamage(w, defSt, defStats, multiplier, visited, depth) {
    multiplier = multiplier || 1; depth = depth || 0;
    if (depth > 8) return;
    _applyDirectDamage(w, defSt, defStats, multiplier);
    const subRefs = resolveSubmunitionRefs(w);
    if (!subRefs.length) return;
    for (const { subName, subCount } of subRefs) {
        if (!subName || (visited && visited.has(subName))) continue;
        const subOutfit = _outfitIndex[subName];
        if (!subOutfit?.weapon) continue;
        const nv = new Set(visited || []); nv.add(subName);
        applyWeaponDamage(subOutfit.weapon, defSt, defStats, multiplier * subCount, nv, depth + 1);
    }
}

function _applyDirectDamage(w, defSt, defStats, multiplier) {
    const disruptMult       = 1 + (defSt.statusEffects.disruption || 0) * 0.01;
    const effectivePiercing = Math.max(0, Math.min(1, w.piercing || 0)) * (1 - defStats.piercingRes);
    const relShieldDmg = (w['% shield damage'] || 0) * Math.min(Math.max(0, defSt.shields), defStats.maxShields) * multiplier;
    const relHullDmg   = (w['% hull damage']   || 0) * Math.min(Math.max(0, defSt.hull),    defStats.maxHull)    * multiplier;
    const rawShieldDmg = (w['shield damage'] || 0) * multiplier + relShieldDmg;
    const rawHullDmg   = (w['hull damage']   || 0) * multiplier + relHullDmg;
    const hasAnyDmg = rawShieldDmg > 0 || rawHullDmg > 0
        || _damageTypes.some(t => (w[dmgKey(t)] || 0) + (w[relDmgKey(t)] || 0) > 0);
    if (!hasAnyDmg) return;

    const shieldDmgTotal   = rawShieldDmg * (1 - defStats.shieldProt) * disruptMult;
    const hullDmgAfterProt = rawHullDmg   * (1 - defStats.hullProt);
    const hullPiercedDmg   = shieldDmgTotal * effectivePiercing;
    const shieldDmgApplied = shieldDmgTotal * (1 - effectivePiercing);

    if (defSt.shields > 0) {
        defSt.shields -= shieldDmgApplied;
        defSt.hull    -= hullPiercedDmg;
        if (defSt.shields < 0) {
            const overflow = -defSt.shields; defSt.shields = 0;
            defSt.hull -= overflow * (1 - defStats.hullProt);
            defSt.hull -= hullDmgAfterProt;
        }
    } else {
        defSt.hull -= hullDmgAfterProt + rawShieldDmg * (1 - defStats.shieldProt);
    }

    defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.shieldDelay  || 0);
    defSt.repairDelayCounter = Math.max(defSt.repairDelayCounter, defStats.repairDelay  || 0);
    if (defSt.depletedFlag)
        defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.depletedDelay || 0);

    const shieldsUp = defSt.shields > 0;
    for (const typeName of _damageTypes) {
        if (typeName === 'Shield' || typeName === 'Hull') continue;
        const raw = (w[dmgKey(typeName)] || 0) * multiplier;
        const rel = (w[relDmgKey(typeName)] || 0) * multiplier;
        const totalDmg = raw + rel;
        if (!totalDmg) continue;
        const prot       = defStats.protections[protKey(typeName)] || 0;
        const shieldMult = window.DamageTypes?.getShieldMultiplier(typeName, shieldsUp) ?? 1.0;
        const effectiveDmg = totalDmg * (1 - prot) * shieldMult;
        if (effectiveDmg > 0) applyStatusOrInstantDamage(defSt, typeName, effectiveDmg);
    }
}

function applyStatusOrInstantDamage(defSt, typeName, dmg) {
    switch (typeName) {
        case 'Energy':     defSt.energy -= dmg; break;
        case 'Heat':       defSt.heat   += dmg; break;
        case 'Fuel':       defSt.fuel   -= dmg; break;
        case 'Discharge':  defSt.statusEffects.discharge  = Math.max(0, (defSt.statusEffects.discharge  || 0) + dmg); break;
        case 'Corrosion':  defSt.statusEffects.corrosion  = Math.max(0, (defSt.statusEffects.corrosion  || 0) + dmg); break;
        case 'Burn':       defSt.statusEffects.burn       = Math.max(0, (defSt.statusEffects.burn       || 0) + dmg); break;
        case 'Leak':       defSt.statusEffects.leak       = Math.max(0, (defSt.statusEffects.leak       || 0) + dmg); break;
        case 'Ion':        defSt.statusEffects.ionization = Math.max(0, (defSt.statusEffects.ionization || 0) + dmg); break;
        case 'Scrambling': defSt.statusEffects.scrambling = Math.max(0, (defSt.statusEffects.scrambling || 0) + dmg); break;
        case 'Disruption': defSt.statusEffects.disruption = Math.max(0, (defSt.statusEffects.disruption || 0) + dmg); break;
        case 'Slowing':    defSt.statusEffects.slowing    = Math.max(0, (defSt.statusEffects.slowing    || 0) + dmg); break;
        default: break;
    }
}

function doGeneration(st, stats) {
    st.energy += stats.energyGenPerFrame - stats.energyConsumeIdlePerFrame
               - stats.movingEnergyPerFrame - stats.coolingEnergyPerFrame;
    st.heat   += stats.heatGenIdlePerFrame + stats.movingHeatPerFrame - stats.coolingPerFrame;
    st.heat   -= st.heat * stats.heatDissipFrac;
    if (stats.fuelRegenPerFrame > 0) st.fuel += stats.fuelRegenPerFrame;
    if ((st.statusEffects.discharge || 0) > 0) st.shields -= st.statusEffects.discharge;
    if ((st.statusEffects.corrosion || 0) > 0) st.hull    -= st.statusEffects.corrosion;
    if ((st.statusEffects.burn      || 0) > 0) st.heat    += st.statusEffects.burn;
    if ((st.statusEffects.leak      || 0) > 0) st.fuel    -= st.statusEffects.leak;
}

function doRegen(st, stats) {
    if (st.shieldDelayCounter > 0) st.shieldDelayCounter--;
    else if (st.shields < stats.maxShields)
        st.shields += stats.shieldRegenPerFrame + stats.delayedShieldPerFrame;
    if (st.repairDelayCounter > 0) st.repairDelayCounter--;
    else if (st.hull < stats.maxHull && !st.disabled)
        st.hull += stats.hullRepairPerFrame + stats.delayedHullPerFrame;
}

function decayStatusEffects(st, stats) {
    for (const statName of Object.keys(_statusDecayMap)) {
        const cur = st.statusEffects[statName] || 0;
        if (cur <= 0) continue;
        const passive        = 0.99 * cur;
        const resistPerFrame = stats.statusResist[statName] || 0;
        st.statusEffects[statName] = Math.max(0, passive - Math.min(resistPerFrame, passive));
    }
}

function checkMilestones(st, stats, side, t, m, phases) {
    if (!m.shieldsBroken && stats.maxShields > 0 && st.shields <= 0) {
        m.shieldsBroken = true;
        phases.push({ time:t, type:side, icon:'🛡', text:`<strong>${escHtml(stats.name)}</strong>'s shields broken at ${fmtT(t)}` });
    }
    if (!m.halfHull && st.hull < stats.maxHull * 0.5 && st.hull > 0) {
        m.halfHull = true;
        phases.push({ time:t, type:side, icon:'⚠️', text:`<strong>${escHtml(stats.name)}</strong> hull below 50% at ${fmtT(t)}` });
    }
    if (!m.energyBlackout && stats.energyCap > 0 && st.energy <= 0) {
        m.energyBlackout = true;
        phases.push({ time:t, type:side, icon:'⚡', text:`<strong>${escHtml(stats.name)}</strong> energy depleted at ${fmtT(t)}` });
    }
    if (!m.overheated && stats.maxHeat > 0 && st.heat >= stats.maxHeat) {
        m.overheated = true;
        phases.push({ time:t, type:side, icon:'🔥', text:`<strong>${escHtml(stats.name)}</strong> overheated at ${fmtT(t)}` });
    }
    if (!m.heavilySlowed && (st.statusEffects.slowing || 0) >= 20) {
        m.heavilySlowed = true;
        const pct = Math.round((1 - 1/(1+(st.statusEffects.slowing||0)*0.05))*100);
        phases.push({ time:t, type:side, icon:'🐌',
            text:`<strong>${escHtml(stats.name)}</strong> heavily slowed (~${pct}%) at ${fmtT(t)}` });
    }
}

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
//  TEAM MANAGEMENT  (new)
// ═══════════════════════════════════════════════════════════════════════════════

function createTeam(name) {
    const idx  = _teams.length;
    const id   = 'team_' + (_nextTeamId++);
    const color = TEAM_PALETTE[idx % TEAM_PALETTE.length];
    const team  = { id, name, color, ships: [] };
    _teams.push(team);
    return team;
}

function removeTeam(teamId) {
    _teams = _teams.filter(t => t.id !== teamId);
    renderAllTeams();
    updateSimButton();
    hideResults();
}

function addShipToTeam(teamId, shipData, count) {
    const team = _teams.find(t => t.id === teamId);
    if (!team) return;
    const resolved = resolveShipStats(shipData);
    if (typeof window.MovementStats?.compute === 'function')
        resolved.movementProfile = window.MovementStats.compute(resolved.combined);
    team.ships.push({ shipData, count: Math.max(1, count), resolved });
    renderTeamCard(team);
    updateSimButton();
    hideResults();
}

function removeShipFromTeam(teamId, shipIdx) {
    const team = _teams.find(t => t.id === teamId);
    if (!team) return;
    team.ships.splice(shipIdx, 1);
    renderTeamCard(team);
    updateSimButton();
    hideResults();
}

function updateShipCount(teamId, shipIdx, newCount) {
    const team = _teams.find(t => t.id === teamId);
    if (!team || !team.ships[shipIdx]) return;
    team.ships[shipIdx].count = Math.max(1, parseInt(newCount) || 1);
    updateSimButton();
    hideResults();
}

function renameTeam(teamId, newName) {
    const team = _teams.find(t => t.id === teamId);
    if (team) team.name = newName || team.name;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SHIP SEARCH  (adapted for team-based targeting)
// ═══════════════════════════════════════════════════════════════════════════════

const _blurTimers = {};

function searchShipsForTeam(teamId, query) {
    const lq = (query || '').toLowerCase().trim();
    const dd = document.getElementById('dropdown_' + teamId);
    if (!dd) return;
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
            row.innerHTML = `<span>${escHtml(ship.name)}</span><span class="sdi-plugin">${escHtml(pl)}</span>`;
            row.onmousedown = () => {
                const countEl = document.getElementById('addCount_' + teamId);
                const count   = parseInt(countEl?.value) || 1;
                addShipToTeam(teamId, ship, count);
                const inputEl = document.getElementById('search_' + teamId);
                if (inputEl) inputEl.value = '';
                dd.classList.remove('open');
            };
            dd.appendChild(row);
        }
    }
    dd.classList.add('open');
}

function openTeamDropdown(teamId) {
    clearTimeout(_blurTimers[teamId]);
    searchShipsForTeam(teamId, document.getElementById('search_' + teamId)?.value);
}

function blurTeamDropdown(teamId) {
    _blurTimers[teamId] = setTimeout(() => {
        document.getElementById('dropdown_' + teamId)?.classList.remove('open');
    }, 180);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RENDERING — TEAM CARDS  (new)
// ═══════════════════════════════════════════════════════════════════════════════

function renderAllTeams() {
    const container = document.getElementById('teamsContainer');
    if (!container) return;
    container.innerHTML = '';
    for (const team of _teams) {
        const card = createTeamCardElement(team);
        container.appendChild(card);
    }
    const addBtn = document.getElementById('addTeamBtn');
    if (addBtn) addBtn.style.display = _teams.length >= 30 ? 'none' : '';
}

function renderTeamCard(team) {
    const existing = document.getElementById('teamCard_' + team.id);
    if (!existing) { renderAllTeams(); return; }
    const fresh = createTeamCardElement(team);
    existing.replaceWith(fresh);
}

function createTeamCardElement(team) {
    const el = document.createElement('div');
    el.className = 'team-card';
    el.id = 'teamCard_' + team.id;
    el.style.setProperty('--team-color', team.color);

    const totalShips = team.ships.reduce((s, e) => s + e.count, 0);

    // Header
    const header = document.createElement('div');
    header.className = 'team-card-header';
    header.innerHTML = `
        <div class="team-color-dot" style="background:${team.color}"></div>
        <input class="team-name-input" value="${escHtml(team.name)}" 
               placeholder="Team name"
               onchange="renameTeam('${team.id}', this.value)">
        <span class="team-ship-count">${totalShips} ship${totalShips !== 1 ? 's' : ''}</span>
        <button class="team-remove-btn" title="Remove team" onclick="removeTeam('${team.id}')">✕</button>
    `;
    el.appendChild(header);

    // Ship list
    const shipList = document.createElement('div');
    shipList.className = 'team-ship-list';
    if (team.ships.length === 0) {
        shipList.innerHTML = '<div class="team-no-ships">No ships added yet</div>';
    } else {
        team.ships.forEach((entry, idx) => {
            const row = document.createElement('div');
            row.className = 'team-ship-row';
            const stats = entry.resolved;
            row.innerHTML = `
                <div class="team-ship-info">
                    <div class="team-ship-name">${escHtml(entry.shipData.name)}</div>
                    <div class="team-ship-stats">
                        <span>Shld ${fmt(stats.maxShields)}</span>
                        <span>Hull ${fmt(stats.maxHull)}</span>
                        <span>sDPS ${fmt(stats.shieldDPS)}</span>
                        <span>hDPS ${fmt(stats.hullDPS)}</span>
                    </div>
                </div>
                <div class="team-ship-controls">
                    <label class="team-count-label">×</label>
                    <input class="team-count-input" type="number" min="1" max="9999"
                           value="${entry.count}"
                           onchange="updateShipCount('${team.id}', ${idx}, this.value)"
                           oninput="updateShipCount('${team.id}', ${idx}, this.value)">
                    <button class="team-ship-remove" title="Remove" onclick="removeShipFromTeam('${team.id}', ${idx})">🗑</button>
                </div>
            `;
            shipList.appendChild(row);
        });
    }
    el.appendChild(shipList);

    // Add ship search
    const addSection = document.createElement('div');
    addSection.className = 'team-add-section';
    addSection.innerHTML = `
        <div class="team-add-row">
            <div class="ship-search-wrap" style="flex:1;">
                <input type="text" id="search_${team.id}" class="team-search-input"
                       placeholder="🔍 Add ship…" autocomplete="off"
                       oninput="searchShipsForTeam('${team.id}', this.value)"
                       onfocus="openTeamDropdown('${team.id}')"
                       onblur="blurTeamDropdown('${team.id}')">
                <div class="ship-dropdown" id="dropdown_${team.id}"></div>
            </div>
            <label class="team-count-label" style="margin:0 4px;">×</label>
            <input class="team-count-input" id="addCount_${team.id}" type="number" min="1" max="9999" value="1" style="width:60px;">
        </div>
    `;
    el.appendChild(addSection);

    return el;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SIMULATION RUNNER  (multi-team)
// ═══════════════════════════════════════════════════════════════════════════════

function updateSimButton() {
    const btn = document.getElementById('fightBtn');
    if (!btn) return;
    const validTeams = _teams.filter(t => t.ships.length > 0 && t.ships.some(e => e.count > 0));
    btn.disabled = validTeams.length < 2;
    btn.textContent = validTeams.length >= 2
        ? `⚔ SIMULATE BATTLE (${validTeams.length} teams)`
        : '⚔ SIMULATE BATTLE';
}

function hideResults() {
    const el = document.getElementById('simResults');
    if (el) el.style.display = 'none';
}

function runSimulation() {
    if (!_attrDefs) { setStatus('Attribute definitions not loaded — please wait.', true); return; }
    if (!window.DamageTypes?.isReady()) { setStatus('Damage type registry not ready — please wait.', true); return; }

    const validTeams = _teams.filter(t => t.ships.length > 0 && t.ships.some(e => e.count > 0));
    if (validTeams.length < 2) { setStatus('Add ships to at least 2 teams first.', true); return; }

    const loadEl = document.getElementById('simLoading');
    const resEl  = document.getElementById('simResults');
    if (loadEl) { loadEl.style.display = 'block'; loadEl.classList.add('visible'); }
    if (resEl)  resEl.style.display = 'none';

    setTimeout(() => {
        try {
            // Build composite stats for each team
            const teamStats = validTeams.map(team => {
                const entries = team.ships.filter(e => e.count > 0).map(e => ({ resolved: e.resolved, count: e.count }));
                const merged  = mergeTeamStats(entries);
                merged.name   = team.name;
                merged.color  = team.color;
                merged._team  = team;
                return merged;
            });

            if (teamStats.length === 2) {
                // Full detail 1v1 battle
                const result = simulateBattle(teamStats[0], teamStats[1]);
                renderResults2Team(teamStats[0], teamStats[1], result);
            } else {
                // Round-robin matrix for N teams
                renderResultsMatrix(teamStats);
            }
        } catch (err) {
            console.error('runSimulation error:', err);
            setStatus('Simulation error: ' + err.message, true);
        } finally {
            if (loadEl) { loadEl.style.display = 'none'; loadEl.classList.remove('visible'); }
        }
    }, 30);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RESULTS RENDERING — 2-TEAM  (adapted from original)
// ═══════════════════════════════════════════════════════════════════════════════

function renderResults2Team(sA, sB, result) {
    const resEl = document.getElementById('simResults');
    if (!resEl) return;

    const winnerNameEl = document.getElementById('resultWinnerName');
    const subtitleEl   = document.getElementById('resultSubtitle');
    if (winnerNameEl) {
        winnerNameEl.className = 'result-winner-name';
        winnerNameEl.style.color = result.winner === 'A' ? sA.color
                                 : result.winner === 'B' ? sB.color : '#94a3b8';
        winnerNameEl.textContent = result.winner === 'A' ? sA.name
                                 : result.winner === 'B' ? sB.name : 'Draw';
    }
    if (subtitleEl)
        subtitleEl.innerHTML =
            `${buildTtkString(sA.name, result.ttkA, result.projectedTtkA)}&nbsp;&nbsp;·&nbsp;&nbsp;${buildTtkString(sB.name, result.ttkB, result.projectedTtkB)}`;

    const effA = isFinite(result.ttkA) ? result.ttkA : (result.projectedTtkA ?? MAX_SIM_SECS);
    const effB = isFinite(result.ttkB) ? result.ttkB : (result.projectedTtkB ?? MAX_SIM_SECS);
    const maxT = Math.max(effA, effB, 1);

    const barA = document.getElementById('timelineBarA');
    const barB = document.getElementById('timelineBarB');
    const lblA = document.getElementById('timelineLabelA');
    const lblB = document.getElementById('timelineLabelB');
    if (barA) { barA.style.width = Math.round(Math.min((effA/maxT)*50,50))+'%'; barA.style.background = sA.color; }
    if (barB) { barB.style.width = Math.round(Math.min((effB/maxT)*50,50))+'%'; barB.style.background = sB.color; }
    if (lblA) lblA.textContent = isFinite(result.ttkA) ? fmtT(result.ttkA)
        : (result.projectedTtkA != null && isFinite(result.projectedTtkA)) ? '~'+fmtT(result.projectedTtkA) : '∞';
    if (lblB) lblB.textContent = isFinite(result.ttkB) ? fmtT(result.ttkB)
        : (result.projectedTtkB != null && isFinite(result.projectedTtkB)) ? '~'+fmtT(result.projectedTtkB) : '∞';

    const chartEl = document.getElementById('hpChartContainer');
    if (chartEl) chartEl.innerHTML = buildHpChart(sA, sB, result);

    const compareEl = document.getElementById('compareGrid');
    if (compareEl) compareEl.innerHTML = buildCompareGrid(sA, sB, result);

    const weaponsEl = document.getElementById('weaponsGrid');
    if (weaponsEl) weaponsEl.innerHTML =
        `<div>
            <div class="weapons-col-title" style="color:${sA.color}">${escHtml(sA.name)}</div>
            ${buildWeaponsList(sA.weaponDetails)}
        </div>
        <div>
            <div class="weapons-col-title" style="color:${sB.color}">${escHtml(sB.name)}</div>
            ${buildWeaponsList(sB.weaponDetails)}
        </div>`;

    const phaseEl = document.getElementById('phaseList');
    if (phaseEl) {
        const phases = [...result.phases];
        if (result.winner==='A' && result.projectedTtkA != null) {
            const p=result.projectedTtkA;
            phases.push({ time:result.ttkB+(isFinite(p)?p:0), type:'A', icon:'📊',
                text: isFinite(p)
                    ? `<strong>${escHtml(sA.name)}</strong> projected ~${fmtT(p)} more survival`
                    : `<strong>${escHtml(sA.name)}</strong> — regen outpaces continued damage` });
        }
        if (result.winner==='B' && result.projectedTtkB != null) {
            const p=result.projectedTtkB;
            phases.push({ time:result.ttkA+(isFinite(p)?p:0), type:'B', icon:'📊',
                text: isFinite(p)
                    ? `<strong>${escHtml(sB.name)}</strong> projected ~${fmtT(p)} more survival`
                    : `<strong>${escHtml(sB.name)}</strong> — regen outpaces continued damage` });
        }
        phases.sort((a, b) => a.time - b.time);
        phaseEl.innerHTML = phases.length
            ? phases.map(ph => {
                const teamColor = ph.type==='A' ? sA.color : ph.type==='B' ? sB.color : '#94a3b8';
                return `<div class="phase-item" style="border-left-color:${teamColor}">
                    <span class="phase-icon">${ph.icon}</span>
                    <span class="phase-time">${fmtT(ph.time)}</span>
                    <span class="phase-text">${ph.text}</span>
                </div>`;
              }).join('')
            : '<div class="phase-item phase-neutral">No notable events recorded.</div>';
    }

    // Show the 2-team timeline section, hide matrix
    document.getElementById('timelineSection').style.display = '';
    document.getElementById('matrixSection').style.display   = 'none';

    resEl.style.display = 'block';
    resEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RESULTS RENDERING — N-TEAM MATRIX
// ═══════════════════════════════════════════════════════════════════════════════

function renderResultsMatrix(teamStats) {
    const resEl = document.getElementById('simResults');
    if (!resEl) return;

    // Run all pair-wise battles
    const n = teamStats.length;
    const matrix = []; // matrix[i][j] = result of team[i] vs team[j]
    for (let i = 0; i < n; i++) {
        matrix[i] = [];
        for (let j = 0; j < n; j++) {
            if (i === j) { matrix[i][j] = null; continue; }
            matrix[i][j] = simulateBattle(teamStats[i], teamStats[j]);
        }
    }

    // Compute win counts
    const wins = teamStats.map(() => 0);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const r = matrix[i][j];
            if (r.winner === 'A') wins[i]++;
        }
    }

    // Sort by wins desc
    const ranked = teamStats.map((ts, i) => ({ ts, wins: wins[i], idx: i }))
        .sort((a, b) => b.wins - a.wins);

    // Winner display
    const winnerNameEl = document.getElementById('resultWinnerName');
    const subtitleEl   = document.getElementById('resultSubtitle');
    const top = ranked[0];
    if (winnerNameEl) {
        winnerNameEl.className    = 'result-winner-name';
        winnerNameEl.style.color  = top.ts.color;
        winnerNameEl.textContent  = top.ts.name;
    }
    if (subtitleEl)
        subtitleEl.innerHTML = ranked.map((r, pos) =>
            `<span style="color:${r.ts.color}; font-weight:${pos===0?'bold':'normal'}">${pos+1}. ${escHtml(r.ts.name)} — ${r.wins}/${n-1} wins</span>`
        ).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

    // Matrix table
    const matEl = document.getElementById('matrixSection');
    if (matEl) {
        let html = `<div class="timeline-label" style="margin-top:16px">1v1 Match Matrix</div>
        <div class="matrix-scroll"><table class="battle-matrix">
        <thead><tr><th></th>`;
        for (const ts of teamStats) html += `<th style="color:${ts.color}">${escHtml(ts.name)}</th>`;
        html += `</tr></thead><tbody>`;
        for (let i = 0; i < n; i++) {
            html += `<tr><td class="matrix-row-label" style="color:${teamStats[i].color}">${escHtml(teamStats[i].name)}</td>`;
            for (let j = 0; j < n; j++) {
                if (i === j) { html += `<td class="matrix-self">—</td>`; continue; }
                const r = matrix[i][j];
                const won = r.winner === 'A';
                const draw = r.winner === 'draw';
                const ttk  = isFinite(r.ttkB) ? fmtT(r.ttkB) : '∞';
                html += `<td class="matrix-cell ${won?'matrix-win':draw?'matrix-draw':'matrix-loss'}" title="${escHtml(teamStats[i].name)} vs ${escHtml(teamStats[j].name)}">
                    <span class="matrix-result">${won?'✓':draw?'~':'✗'}</span>
                    <span class="matrix-ttk">${won||draw?ttk:fmtT(r.ttkA)}</span>
                </td>`;
            }
            html += `</tr>`;
        }
        html += `</tbody></table></div>`;

        // Rankings
        html += `<div class="timeline-label" style="margin-top:18px">Rankings</div><div class="ranking-list">`;
        for (const r of ranked) {
            html += `<div class="ranking-item">
                <span class="ranking-pos">#${ranked.indexOf(r)+1}</span>
                <span class="ranking-color-dot" style="background:${r.ts.color}"></span>
                <span class="ranking-name" style="color:${r.ts.color}">${escHtml(r.ts.name)}</span>
                <span class="ranking-wins">${r.wins}/${n-1} wins</span>
                <span class="ranking-dps">sDPS ${fmt(r.ts.shieldDPS)} · hDPS ${fmt(r.ts.hullDPS)}</span>
                <span class="ranking-ehp">Shld ${fmt(r.ts.maxShields)} · Hull ${fmt(r.ts.maxHull)}</span>
            </div>`;
        }
        html += `</div>`;
        matEl.innerHTML = html;
        matEl.style.display = '';
    }

    // Combat phases (merged from all matchups)
    const allPhases = [];
    for (let i = 0; i < n; i++) {
        for (let j = i+1; j < n; j++) {
            const r = matrix[i][j];
            for (const ph of r.phases) {
                allPhases.push({
                    ...ph,
                    matchup: `${teamStats[i].name} vs ${teamStats[j].name}`,
                    color: ph.type==='A' ? teamStats[i].color : ph.type==='B' ? teamStats[j].color : '#94a3b8',
                });
            }
        }
    }
    allPhases.sort((a, b) => a.time - b.time);

    const phaseEl = document.getElementById('phaseList');
    if (phaseEl) {
        phaseEl.innerHTML = allPhases.length
            ? allPhases.slice(0, 60).map(ph =>
                `<div class="phase-item" style="border-left-color:${ph.color}">
                    <span class="phase-icon">${ph.icon}</span>
                    <span class="phase-time">${fmtT(ph.time)}</span>
                    <span class="phase-text"><em style="font-size:0.8em;color:#64748b">[${escHtml(ph.matchup)}]</em> ${ph.text}</span>
                </div>`
              ).join('')
            : '<div class="phase-item phase-neutral">No notable events.</div>';
    }

    document.getElementById('timelineSection').style.display = 'none';
    document.getElementById('hpChartContainer').innerHTML    = '';
    document.getElementById('compareGrid').innerHTML         = '';
    document.getElementById('weaponsGrid').innerHTML         = '';
    document.getElementById('matrixSection').style.display   = '';

    resEl.style.display = 'block';
    resEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HP CHART  (unchanged logic, adapted for dynamic colours)
// ═══════════════════════════════════════════════════════════════════════════════

function buildHpChart(sA, sB, result) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const tlA = (result.timelineA || []).map(p => ({...p}));
    const tlB = (result.timelineB || []).map(p => ({...p}));
    if (!tlA.length && !tlB.length) return '';

    const W=560, H=200, PL=48, PR=12, PT=14, PB=28;
    const cW=W-PL-PR, cH=H-PT-PB;
    const deathA=isFinite(result.ttkA)?result.ttkA:Infinity;
    const deathB=isFinite(result.ttkB)?result.ttkB:Infinity;
    const firstDeath=Math.min(deathA,deathB);
    const lastPoint  = tl => tl.length ? tl[tl.length-1].t : 0;
    const maxTime = Math.max(isFinite(firstDeath)?firstDeath:Math.max(lastPoint(tlA),lastPoint(tlB)), 0.1);
    const maxHP = Math.max(sA.maxShields+sA.maxHull, sB.maxShields+sB.maxHull, 1);
    const px = t  => PL + clamp(t,  0, maxTime) / maxTime * cW;
    const py = hp => PT + cH - clamp(hp, 0, maxHP) / maxHP * cH;

    function clip(tl, iS, iH) {
        if (!tl.length) return [];
        const out=[];
        if (tl[0].t>0) out.push({ t:0, shields:iS, hull:iH });
        for (let i=0; i<tl.length; i++) {
            const p=tl[i];
            if (p.t<=maxTime) { out.push(p); }
            else {
                const prev=tl[i-1]||out[out.length-1];
                if (prev && prev.t<maxTime) {
                    const dt=p.t-prev.t; const r=dt>0?(maxTime-prev.t)/dt:0;
                    out.push({ t:maxTime, shields:prev.shields+(p.shields-prev.shields)*r, hull:prev.hull+(p.hull-prev.hull)*r });
                }
                break;
            }
        }
        if (out.length===1) out.push({...out[0],t:out[0].t+0.001});
        return out;
    }

    const cA=clip(tlA,sA.maxShields,sA.maxHull);
    const cB=clip(tlB,sB.maxShields,sB.maxHull);
    if (!cA.length && !cB.length) return '';

    function makePaths(tl) {
        if (!tl.length) return { hull:'', shieldArea:'' };
        const hull = tl.map((p,i) => `${i?'L':'M'}${px(p.t).toFixed(1)},${py(Math.max(0,p.hull)).toFixed(1)}`).join(' ');
        const hasShields = tl.some(p=>p.shields>0);
        let shieldArea='';
        if (hasShields) {
            const fwd=tl.map((p,i)=>`${i===0?'M':'L'}${px(p.t).toFixed(1)},${py(Math.max(0,p.hull)+Math.max(0,p.shields)).toFixed(1)}`).join(' ');
            const rev=[...tl].reverse().map(p=>`L${px(p.t).toFixed(1)},${py(Math.max(0,p.hull)).toFixed(1)}`).join(' ');
            shieldArea=`${fwd} ${rev} Z`;
        }
        return { hull, shieldArea };
    }

    const pA=makePaths(cA), pB=makePaths(cB);

    // Parse hex color to rgba
    function hexToRgba(hex, alpha) {
        const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    const colorA = sA.color || '#3b82f6';
    const colorB = sB.color || '#ef4444';

    const yTicks=[0,0.5,1].map(f=>{
        const v=maxHP*f, y=py(v).toFixed(1);
        const lb=v>=1000?(v/1000).toFixed(1)+'k':Math.round(v).toString();
        return `<line x1="${PL}" y1="${y}" x2="${PL+cW}" y2="${y}" stroke="rgba(148,163,184,0.12)" stroke-width="1"/>` +
               `<text x="${PL-4}" y="${+y+4}" fill="#64748b" font-size="10" text-anchor="end">${lb}</text>`;
    }).join('');
    const xTicks=[0,0.5,1].map(f=>{
        const t=maxTime*f, x=px(t).toFixed(1);
        return `<text x="${x}" y="${PT+cH+14}" fill="#64748b" font-size="10" text-anchor="middle">${t.toFixed(1)}s</text>`;
    }).join('');
    const threshLine=(minHull,color)=>minHull>0
        ?`<line x1="${PL}" y1="${py(minHull).toFixed(1)}" x2="${PL+cW}" y2="${py(minHull).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>`:
        '';
    const trunc=(s,n)=>s.length>n?s.slice(0,n-1)+'…':s;
    const lx=PL+cW-4;
    const legend=
        `<rect x="${lx-82}" y="${PT+2}" width="8" height="3" fill="${colorA}" rx="1"/>` +
        `<text x="${lx-70}" y="${PT+8}" fill="${colorA}" font-size="10">${escHtml(trunc(sA.name,18))}</text>` +
        `<rect x="${lx-82}" y="${PT+16}" width="8" height="3" fill="${colorB}" rx="1"/>` +
        `<text x="${lx-70}" y="${PT+22}" fill="${colorB}" font-size="10">${escHtml(trunc(sB.name,18))}</text>`;

    return `<div class="hp-chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;display:block;height:auto;">
            <rect x="${PL}" y="${PT}" width="${cW}" height="${cH}" fill="rgba(15,23,42,0.5)" rx="4"/>
            ${yTicks}${xTicks}
            ${threshLine(sA.minHull, hexToRgba(colorA, 0.5))}
            ${threshLine(sB.minHull, hexToRgba(colorB, 0.5))}
            ${pA.shieldArea ? `<path d="${pA.shieldArea}" fill="${hexToRgba(colorA,0.12)}" stroke="none"/>` : ''}
            ${pA.hull       ? `<path d="${pA.hull}"  fill="none" stroke="${colorA}" stroke-width="2.5"/>` : ''}
            ${pB.shieldArea ? `<path d="${pB.shieldArea}" fill="${hexToRgba(colorB,0.12)}" stroke="none"/>` : ''}
            ${pB.hull       ? `<path d="${pB.hull}"  fill="none" stroke="${colorB}" stroke-width="2.5"/>` : ''}
            ${legend}
        </svg>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COMPARE GRID  (adapted for dynamic colors)
// ═══════════════════════════════════════════════════════════════════════════════

function buildCompareGrid(sA, sB, result) {
    const ttkStrA = isFinite(result.ttkA) ? fmtTTK(result.ttkA)
        : result.projectedTtkA != null ? (isFinite(result.projectedTtkA) ? `~${fmtT(result.projectedTtkA)} (proj.)` : '∞ (regen wins)') : '∞ (survived)';
    const ttkStrB = isFinite(result.ttkB) ? fmtTTK(result.ttkB)
        : result.projectedTtkB != null ? (isFinite(result.projectedTtkB) ? `~${fmtT(result.projectedTtkB)} (proj.)` : '∞ (regen wins)') : '∞ (survived)';

    const allProtKeys = new Set([...Object.keys(sA.protections), ...Object.keys(sB.protections), 'piercing resistance']);
    const protRows = [];
    for (const key of [...allProtKeys].sort()) {
        const va = key==='piercing resistance' ? sA.piercingRes : (sA.protections[key]||0);
        const vb = key==='piercing resistance' ? sB.piercingRes : (sB.protections[key]||0);
        if (va===0 && vb===0) continue;
        protRows.push([key.replace(/\b\w/g,l=>l.toUpperCase()), fmtPct(va), fmtPct(vb)]);
    }

    const energyGenA=(sA.energyGenPerFrame||0)*FPS, energyGenB=(sB.energyGenPerFrame||0)*FPS;
    const idleConsumeA=((sA.energyConsumeIdlePerFrame||0)+(sA.coolingEnergyPerFrame||0))*FPS;
    const idleConsumeB=((sB.energyConsumeIdlePerFrame||0)+(sB.coolingEnergyPerFrame||0))*FPS;
    const moveEnergyA=(sA.movingEnergyPerFrame||0)*FPS, moveEnergyB=(sB.movingEnergyPerFrame||0)*FPS;
    const fireEnergyA=sA.firingEnergyPerSec||0, fireEnergyB=sB.firingEnergyPerSec||0;
    const netA=energyGenA-idleConsumeA-moveEnergyA-fireEnergyA;
    const netB=energyGenB-idleConsumeB-moveEnergyB-fireEnergyB;
    const fuelGenA=(sA.fuelRegenPerFrame||0)*FPS, fuelGenB=(sB.fuelRegenPerFrame||0)*FPS;
    const fireFuelA=sA.firingFuelPerSec||0, fireFuelB=sB.firingFuelPerSec||0;
    const moveFuelA=(sA.movementProfile?.sustainedCombat?.fuelPerSec)??0;
    const moveFuelB=(sB.movementProfile?.sustainedCombat?.fuelPerSec)??0;
    const netFuelA=fuelGenA-fireFuelA-moveFuelA, netFuelB=fuelGenB-fireFuelB-moveFuelB;
    const showFuel=(sA.fuelCap||0)>0||(sB.fuelCap||0)>0||fireFuelA>0||fireFuelB>0||moveFuelA>0||moveFuelB>0;

    const energySection=[
        ['Energy Cap.',     fmt(sA.energyCap),        fmt(sB.energyCap)],
        ['Energy Gen/s',    fmt(energyGenA),           fmt(energyGenB)],
        ['Idle Consume/s',  fmt(-idleConsumeA),        fmt(-idleConsumeB)],
        ['Move Energy/s',   fmt(-moveEnergyA),         fmt(-moveEnergyB)],
        ['Firing Energy/s', fmt(-fireEnergyA),         fmt(-fireEnergyB)],
        ['Net (combat) /s', fmtNet(netA),              fmtNet(netB)],
        ['Heat Capacity',   fmt(sA.maxHeat),           fmt(sB.maxHeat)],
        ['Cooling/s',       fmt(sA.coolingPerSec),     fmt(sB.coolingPerSec)],
        ['Firing Heat/s',   fmt(sA.firingHeatPerSec),  fmt(sB.firingHeatPerSec)],
        ['Cool Efficiency', (sA.coolEff||0).toFixed(3),(sB.coolEff||0).toFixed(3)],
    ];
    if ((sA.firingHullCostPerSec||0)>0||(sB.firingHullCostPerSec||0)>0)
        energySection.push(['Firing Hull Cost/s',fmt(sA.firingHullCostPerSec),fmt(sB.firingHullCostPerSec)]);
    if ((sA.firingShieldCostPerSec||0)>0||(sB.firingShieldCostPerSec||0)>0)
        energySection.push(['Firing Shield Cost/s',fmt(sA.firingShieldCostPerSec),fmt(sB.firingShieldCostPerSec)]);

    const sections=[
        ['Combat', [
            ['Time to Disable',fmt(result.ttkA),fmt(result.ttkB)],
            ['Max Shields',    fmt(sA.maxShields), fmt(sB.maxShields)],
            ['Max Hull',       fmt(sA.maxHull),    fmt(sB.maxHull)],
            ['Disable Thresh', fmt(sA.minHull),    fmt(sB.minHull)],
            ['Shield DPS',     fmt(sA.shieldDPS),  fmt(sB.shieldDPS)],
            ['Hull DPS',       fmt(sA.hullDPS),    fmt(sB.hullDPS)],
            ['Shield Regen/s', fmt(sA.shieldRegenPerSec), fmt(sB.shieldRegenPerSec)],
            ['Hull Repair/s',  fmt(sA.hullRepairPerSec),  fmt(sB.hullRepairPerSec)],
            ...protRows,
        ]],
        ['Energy & Heat', energySection],
    ];

    if (showFuel) {
        const fuelRows=[
            ['Fuel Capacity',fmt(sA.fuelCap),fmt(sB.fuelCap)],
            ['Fuel Regen/s', fmt(fuelGenA),  fmt(fuelGenB)],
        ];
        if (moveFuelA>0||moveFuelB>0) fuelRows.push(['Move Fuel/s',fmt(-moveFuelA),fmt(-moveFuelB)]);
        if (fireFuelA>0||fireFuelB>0) fuelRows.push(['Firing Fuel/s',fmt(-fireFuelA),fmt(-fireFuelB)]);
        fuelRows.push(['Net Fuel/s',fmtNet(netFuelA),fmtNet(netFuelB)]);
        sections.push(['Fuel',fuelRows]);
    }

    const colorA = sA.color || '#3b82f6';
    const colorB = sB.color || '#ef4444';

    return sections.map(([section, items]) => {
        if (!items?.length) return '';
        const colA   = items.map(([,va])  => `<div class="res-row"><div class="res-row-value">${va}</div></div>`).join('');
        const colDiv = items.map(([label])=> `<div class="res-divider-item">${label}</div>`).join('');
        const colB   = items.map(([,,vb]) => `<div class="res-row"><div class="res-row-value">${vb}</div></div>`).join('');
        const mobileRows=items.map(([label,va,vb])=>
            `<div class="res-row-mobile"><span class="res-row-mobile__label">${label}</span><span class="res-row-mobile__val-a" style="color:${colorA}">${va}</span><span class="res-row-mobile__val-b" style="color:${colorB}">${vb}</span></div>`).join('');
        return `<div class="res-section-title">${section}</div>
        <div class="results-compare">
            <div class="res-col res-col-a" style="--col-a:${colorA}">${colA}</div>
            <div class="res-divider">${colDiv}</div>
            <div class="res-col res-col-b" style="--col-b:${colorB}">${colB}</div>
            ${mobileRows}
        </div>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WEAPON DISPLAY HELPERS  (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

function buildWeaponsList(details) {
    if (!details?.length) return '<div class="weapon-item" style="color:var(--c-text-muted);font-style:italic;padding:8px 0;">No weapons</div>';
    return details.map(w => {
        const extra = [];
        for (const typeName of _damageTypes) {
            if (typeName==='Shield'||typeName==='Hull') continue;
            const dps=w[typeName.toLowerCase()+'DPS']||0;
            if (dps>0.001) {
                const typeEntry=window.DamageTypes?.getDamageType(typeName);
                const isStatusOnly=typeEntry?.category==='status'&&typeEntry?.shieldInteraction!=='direct';
                extra.push(`${typeName}: ${fmt(dps)}/s${isStatusOnly?' ⚡':''}`);
            }
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

// ═══════════════════════════════════════════════════════════════════════════════
//  FORMATTING HELPERS  (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

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
function fmtPct(v) {
    if (!v) return '0%';
    const s=(v*100).toFixed(2).replace(/\.?0+$/,'');
    return s+'%';
}
function fmtNet(v) { if (!isFinite(v)||v===0) return '0'; return (v>0?'+':'')+fmt(v); }
function escHtml(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function buildTtkString(name, ttk, projectedTtk) {
    const n=escHtml(name);
    if (isFinite(ttk)) return `${n} disabled in ${fmtT(ttk)}`;
    if (projectedTtk==null) return `${n} survived`;
    if (!isFinite(projectedTtk)) return `${n} survived (regen &gt; damage)`;
    return `${n} survived · ~${fmtT(projectedTtk)} projected`;
}

// ── Public API ─────────────────────────────────────────────────────────────────
window.searchShipsForTeam  = searchShipsForTeam;
window.openTeamDropdown    = openTeamDropdown;
window.blurTeamDropdown    = blurTeamDropdown;
window.removeTeam          = removeTeam;
window.removeShipFromTeam  = removeShipFromTeam;
window.updateShipCount     = updateShipCount;
window.renameTeam          = renameTeam;
window.runSimulation       = runSimulation;

window.addNewTeam = function() {
    let teamNumber = _teams.length + 1;
    let teamName = "Team " + teamNumber;
    createTeam(teamName);
    renderAllTeams();
    updateSimButton();
};

document.addEventListener('DOMContentLoaded', () => {
    // Initialise with 2 teams by default
    createTeam('Team 1');
    createTeam('Team 2');
    renderAllTeams();

    const btn = document.getElementById('fightBtn');
    if (btn) btn.addEventListener('click', runSimulation);
    init();
});

})();