;(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  battleSim.js  —  Endless Sky Battle Simulator
// ═══════════════════════════════════════════════════════════════════════════════

const FPS          = 60;
const MAX_SIM_SECS = 600;
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

const _slots = { A: null, B: null };

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

// ─────────────────────────────────────────────────────────────────────────────
//  Firing-cost resource keys — these are the only ones that gate weapon firing.
//  'firing heat' is intentionally absent: it adds heat but never directly
//  prevents a weapon from firing (overheat gates ALL weapons via isOverheated).
//
//  The label shown in phase messages is derived from the key itself, so no
//  separate label table is needed.
// ─────────────────────────────────────────────────────────────────────────────
const FIRING_RESOURCE_KEYS = ['firing energy', 'firing fuel', 'firing hull', 'firing shields'];

// Strip 'firing ' prefix for human-readable labels in phase messages.
function resourceLabel(key) { return key.replace(/^firing\s+/, ''); }

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
    const resEl = document.getElementById('simResults');
    if (resEl) resEl.style.display = 'none';
    await loadData();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fetch with sessionStorage cache + exponential-backoff retry on 429.
//
//  GitHub raw content rate-limits aggressive clients (HTTP 429).  We cache
//  every successful JSON response in sessionStorage so reloads within the same
//  browser tab never re-request data that was already fetched.
//
//  Cache keys are prefixed with the repo URL so they never collide with other
//  apps sharing the same origin.
//
//  Backoff: 429 → wait 2^attempt * 500 ms, up to MAX_FETCH_RETRIES attempts.
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_PREFIX     = `es-sim:${REPO_URL}:`;
const MAX_FETCH_RETRIES = 4;

async function cachedFetchJSON(url) {
    const cacheKey = CACHE_PREFIX + url;

    // ── Return from sessionStorage if available ───────────────────────────
    try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) return JSON.parse(cached);
    } catch (_) { /* sessionStorage unavailable or parse error — fall through */ }

    // ── Fetch with retry on 429 ───────────────────────────────────────────
    let lastErr;
    for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = Math.pow(2, attempt) * 500;   // 1s, 2s, 4s, 8s
            setStatus(`Rate limited by GitHub — retrying in ${(delay / 1000).toFixed(1)} s… (attempt ${attempt}/${MAX_FETCH_RETRIES})`);
            await new Promise(r => setTimeout(r, delay));
        }
        try {
            const res = await fetch(url);
            if (res.status === 429) { lastErr = new Error('429 Too Many Requests'); continue; }
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
            const data = await res.json();
            // Cache the result
            try { sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch (_) {}
            return data;
        } catch (err) {
            lastErr = err;
            if (!err.message.includes('429')) throw err;   // non-429 errors are fatal
        }
    }
    throw lastErr ?? new Error(`Failed to fetch ${url} after ${MAX_FETCH_RETRIES} retries`);
}

/**
 * cachedFetchJSONSoft(url)
 * Like cachedFetchJSON but returns null instead of throwing — used for
 * optional per-plugin files that may legitimately not exist (404).
 */
async function cachedFetchJSONSoft(url) {
    const cacheKey = CACHE_PREFIX + url;
    try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) return JSON.parse(cached);
    } catch (_) {}
    for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
        if (attempt > 0)
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
        try {
            const res = await fetch(url);
            if (res.status === 429) continue;
            if (res.status === 404) return null;         // legitimately missing
            if (!res.ok) return null;
            const data = await res.json();
            try { sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch (_) {}
            return data;
        } catch (_) { return null; }
    }
    return null;
}

async function loadData() {
    setStatus('Loading plugin data…');

    // ── attributeDefinitions.json ─────────────────────────────────────────
    try {
        const attrDefs = await cachedFetchJSON(`${BASE_URL}/attributeDefinitions.json`);
        if (attrDefs) {
            _attrDefs          = attrDefs;
            _damageTypes       = _attrDefs?.weapon?.damageTypes || [];
            const sed          = _attrDefs?.weapon?.statusEffectDecay;
            _statusDecayMap    = sed?.decayMap    || {};
            _statusDescriptors = sed?.descriptors || [];
            _weaponDataKeys    = new Set(_attrDefs?.weapon?.dataFileKeys || []);
            if (typeof initComputedStats === 'function')
                initComputedStats(_attrDefs, BASE_URL);
            if (typeof window.DamageTypes?.init === 'function')
                window.DamageTypes.init(_attrDefs);
            if (typeof window.MunitionTypes?.init === 'function')
                window.MunitionTypes.init(() => _outfitIndex, _attrDefs);
        }
    } catch (e) { console.warn('Failed to load attributeDefinitions.json:', e.message); }

    // ── index.json ────────────────────────────────────────────────────────
    let dataIndex;
    try {
        dataIndex = await cachedFetchJSON(`${BASE_URL}/index.json`);
    } catch (err) { setStatus(`Error: ${err.message}`, true); return; }

    window._indexPluginOrder = [];
    for (const pluginList of Object.values(dataIndex))
        for (const { outputName } of pluginList)
            window._indexPluginOrder.push(outputName);

    // ── Per-plugin data files ─────────────────────────────────────────────
    window.allData = {};
    for (const [, pluginList] of Object.entries(dataIndex)) {
        for (const { outputName, displayName, sourceName } of pluginList) {
            const pluginData = { sourceName, displayName, outputName,
                                 ships: [], variants: [], outfits: [] };
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
    ['selected', 'stats', 'slot'].forEach(prefix => {
        const el = document.getElementById(prefix + slot);
        if (!el) return;
        if (prefix === 'selected') el.classList.remove('visible');
        else if (prefix === 'stats') el.style.display = 'none';
        else if (prefix === 'slot') el.classList.remove('has-ship');
    });
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

function getResistanceKeys() {
    if (!_attrDefs?.attributes) return [];
    return Object.keys(_attrDefs.attributes).filter(k => k.endsWith(' resistance'));
}

const dmgKey    = t => t.toLowerCase() + ' damage';
const protKey   = t => t.toLowerCase() + ' protection';
const relDmgKey = t => '% ' + t.toLowerCase() + ' damage';

// ═══════════════════════════════════════════════════════════════════════════════
//  OUTFIT ATTRIBUTE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

const OUTFIT_META_KEYS = new Set([
    '_pluginId', 'name', 'displayName', 'pluralName', 'category',
    'weapon', 'attributes', 'description', 'thumbnail', 'sprite',
    'licenses', 'series', 'index', 'ammoStored', 'cost', 'mass',
    'flareSprites', 'reverseFlareSprites', 'steeringFlareSprites',
    'flareSounds', 'jumpEffects', 'hyperSounds', 'jumpSounds',
    'flotsamSprite', 'ammo', 'isDefined',
]);

function extractOutfitAttributes(outfit) {
    const merged = {};
    for (const [key, val] of Object.entries(outfit)) {
        if (OUTFIT_META_KEYS.has(key)) continue;
        if (typeof val === 'number') merged[key] = val;
    }
    if (outfit.attributes && typeof outfit.attributes === 'object') {
        for (const [key, val] of Object.entries(outfit.attributes))
            if (typeof val === 'number') merged[key] = val;
    }
    return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STAT RESOLUTION
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

    const absThresh = a('absolute threshold');
    const minHull   = absThresh > 0
        ? absThresh
        : Math.max(0, Math.floor(a('threshold percentage') * maxHull + a('hull threshold')));

    const x        = a('cooling inefficiency');
    const coolEff  = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));
    const maxHeat  = 100 * (rawMass + a('heat capacity'));
    const heatDissipFrac  = 0.001 * a('heat dissipation');
    const coolingPerFrame = coolEff * (a('cooling') + a('active cooling'));

    const shieldRegenPerFrame   = a('shield generation')         * (1 + a('shield generation multiplier'));
    const delayedShieldPerFrame = a('delayed shield generation') * (1 + a('shield generation multiplier'));
    const hullRepairPerFrame    = a('hull repair rate')          * (1 + a('hull repair multiplier'));
    const delayedHullPerFrame   = a('delayed hull repair rate')  * (1 + a('hull repair multiplier'));

    const protections = {};
    for (const key of getProtectionKeys())
        protections[key] = Math.max(0, Math.min(1, a(key)));
    const shieldProt = protections['shield protection'] || 0;
    const hullProt   = protections['hull protection']   || 0;

    const piercingRes = Math.max(0, Math.min(1, a('piercing resistance')));

    const statusResist = {};
    for (const [statName, resistKey] of Object.entries(_statusDecayMap))
        statusResist[statName] = Math.max(0, a(resistKey));

    const energyCap                 = a('energy capacity');
    const energyGenPerFrame         = a('energy generation')
                                    + a('solar collection') * SOLAR_POWER
                                    + a('fuel energy');
    const energyConsumeIdlePerFrame = a('energy consumption');
    const movingEnergyPerFrame      = Math.max(a('thrusting energy'), a('reverse thrusting energy'))
                                    + a('turning energy');
    const coolingEnergyPerFrame     = a('cooling energy');
    const heatGenIdlePerFrame       = a('heat generation');
    const movingHeatPerFrame        = Math.max(a('thrusting heat'), a('reverse thrusting heat'))
                                    + a('turning heat');

    // ── Fuel recovery ────────────────────────────────────────────────────────
    // From attributeParser.js systemAwareFormulas / ramscoop formula:
    //   ramscoop fuel/s = 0.03 * sqrt(solarPower) * [ramscoop]
    // Plus 'fuel generation' attribute (fuel/s, convert to per-frame).
    const fuelCap          = a('fuel capacity') || 0;
    const fuelRegenPerFrame = (
        0.03 * Math.sqrt(SOLAR_POWER) * a('ramscoop') + a('fuel generation')
    ) / FPS;

    // ── Initial ammo inventory ───────────────────────────────────────────────
    // We want: ammoInventory[ammoOutfitName] = total rounds available at battle start.
    //
    // ES ammo storage conventions (any one or more may apply to an outfit):
    //   (a) outfit.ammoStored > 0   — compiled field from ship-builder
    //   (b) outfit.category === 'Ammunition'   — category flag
    //   (c) outfit.attributes[outfitName] > 0  — attribute named after the outfit itself
    //   (d) extractOutfitAttributes()[outfitName] > 0  — same, via top-level attrs
    //
    // All are additive: 3 × "Javelin Rack" each giving 40 = 120 total.
    const ammoInventory = {};
    for (const [outfitName, qty] of Object.entries(ship.outfitMap || {})) {
        const outfit = _outfitIndex[outfitName];
        if (!outfit) continue;

        let roundsPerUnit = 0;

        // (a) explicit ammoStored field
        if (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0)
            roundsPerUnit = outfit.ammoStored;

        // (b/c) attributes object contains a key matching the outfit name
        if (roundsPerUnit === 0 && outfit.attributes &&
                typeof outfit.attributes[outfitName] === 'number' &&
                outfit.attributes[outfitName] > 0)
            roundsPerUnit = outfit.attributes[outfitName];

        // (d) top-level numeric fields (via extractOutfitAttributes)
        if (roundsPerUnit === 0) {
            const attrs = extractOutfitAttributes(outfit);
            if (typeof attrs[outfitName] === 'number' && attrs[outfitName] > 0)
                roundsPerUnit = attrs[outfitName];
        }

        if (roundsPerUnit > 0)
            ammoInventory[outfitName] = (ammoInventory[outfitName] || 0) + roundsPerUnit * qty;
    }

    const thrustForVel = a('thrust') || a('afterburner thrust');
    const maxVelocity  = drag > 0 ? thrustForVel / drag : 0;
    const acceleration = inertialMass > 0
        ? (a('thrust') / inertialMass) * (1 + a('acceleration multiplier')) : 0;

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
//  WEAPON ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * resolveSubmunitionRefs(w)  →  Array<{ subName: string, subCount: number }>
 *
 * Submunitions follow the same two-format convention as ammo:
 *
 * FORMAT A — single submunition (count implicit):
 *   weapon: { submunition: "Proton Fragment" }   → 1 copy
 *
 * FORMAT B — explicit count, outfit name is the key:
 *   weapon: { "Proton Fragment": 3 }             → 3 copies
 *   weapon: { "Proton Fragment": true }           → 1 copy
 *
 * Both formats can coexist in different outfits.  We check Format A first,
 * then scan all keys for Format B (any key whose value is a number/true and
 * whose name matches a weapon-bearing outfit in the index).
 *
 * Returns an array (may be multiple submunition types from Format A arrays).
 */
function resolveSubmunitionRefs(w) {
    const results = [];

    // FORMAT A: w.submunition = string | object | array
    const rawSub = w.submunition;
    if (rawSub != null) {
        const entries = Array.isArray(rawSub) ? rawSub : [rawSub];
        for (const entry of entries) {
            const subName  = typeof entry === 'string' ? entry
                           : typeof entry === 'object' ? (entry?.name ?? null)
                           : null;
            const subCount = typeof entry === 'object' && entry !== null
                           ? (entry.count ?? 1) : 1;
            if (subName) results.push({ subName, subCount });
        }
        if (results.length > 0) return results;
    }

    // FORMAT B: weapon["OutfitName"] = count | true
    // The outfit must have a weapon block to be a submunition (not ammo/engine/etc.)
    for (const key of Object.keys(w)) {
        if (key === 'submunition') continue;
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;

        const outfit = _outfitIndex[key];
        if (!outfit?.weapon) continue;   // must have a weapon block

        // Exclude ammo outfits (they don't fire, they're consumed)
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

/**
 * resolveEffectiveRange(w, visited, depth)
 *
 * Calculates the true effective range of a weapon including submunition travel.
 *
 * In Endless Sky a submunition is spawned at the point where the parent
 * projectile detonates, then travels for its own lifetime at its own velocity.
 * Effective range = parent_velocity * parent_lifetime
 *                 + max(submunition effective ranges)
 *
 * We take the MAX of submunition chains (not sum) because only one path
 * determines the furthest-reaching fragment.
 *
 * Returns null if the weapon has no velocity/lifetime data.
 */
function resolveEffectiveRange(w, visited, depth) {
    if (depth > 8) return null;

    const vel      = w.velocity  || 0;
    const life     = w.lifetime  || 0;
    const ownRange = vel * life;

    const subs = resolveSubmunitionRefs(w);
    if (!subs.length) return ownRange > 0 ? ownRange : null;

    let maxSubRange = 0;
    let anySubHasRange = false;

    for (const { subName } of subs) {
        if (visited && visited.has(subName)) continue;
        const subOutfit = _outfitIndex[subName];
        if (!subOutfit?.weapon) continue;
        const nv = new Set(visited || []);
        nv.add(subName);
        const subRange = resolveEffectiveRange(subOutfit.weapon, nv, depth + 1);
        if (subRange !== null) {
            anySubHasRange = true;
            if (subRange > maxSubRange) maxSubRange = subRange;
        }
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
        const munitionInfo = window.MunitionTypes?.analyseWeapon?.(w, w._name) ?? null;

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
            name: w._name || 'Unknown',
            munition: munitionInfo,
            reload, burstCount, burstReload, framesPerCycle,
            sps: +sps.toFixed(3), piercing: +(piercing * 100).toFixed(0),
            range: resolveEffectiveRange(w, new Set([w._name].filter(Boolean)), 0),
            homing: (w.homing || 0) > 0, antiMissile: (w['anti-missile'] || 0) > 0,
            hasSubmunitions: resolveSubmunitionRefs(w).length > 0, dmgPerShot,
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
    result.slowingDPS    = totalDPS['Slowing']    || 0;
    result.firingEnergyPerSec     = +(totalFiring['firing energy']  || 0).toFixed(3);
    result.firingHeatPerSec       = +(totalFiring['firing heat']    || 0).toFixed(3);
    result.firingFuelPerSec       = +(totalFiring['firing fuel']    || 0).toFixed(3);
    result.firingHullCostPerSec   = +(totalFiring['firing hull']    || 0).toFixed(3);
    result.firingShieldCostPerSec = +(totalFiring['firing shields'] || 0).toFixed(3);
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WEAPON SUSTAIN — resource gate check and cost consumption
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * resolveAmmoRef(w)  →  { ammoName: string, ammoCount: number } | null
 *
 * Two formats exist in the ship-builder JSON:
 *
 * FORMAT A — 1 ammo per shot (weapon.ammo is a string):
 *   weapon: { ammo: "Javelin" }
 *
 * FORMAT B — explicit count (ammo outfit name is the key):
 *   weapon: { "Javelin": 2 }     ← 2 per shot
 *   weapon: { "Javelin": true }  ← 1 per shot (boolean from some parsers)
 *
 * We try FORMAT A first, then scan keys for FORMAT B.
 * Ammo outfits are identified by: ammoStored > 0, category "Ammunition",
 * or own-name attribute > 0.
 */
function resolveAmmoRef(w) {
    // FORMAT A: weapon.ammo = "OutfitName"
    const rawAmmoField = w['ammo'];
    if (typeof rawAmmoField === 'string' && rawAmmoField.length > 0) {
        const outfit = _outfitIndex[rawAmmoField];
        // Accept even if not in index — the name is explicit
        return { ammoName: rawAmmoField, ammoCount: 1 };
    }

    // FORMAT B: weapon["OutfitName"] = count | true
    for (const key of Object.keys(w)) {
        if (key === 'ammo') continue;
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;

        const outfit = _outfitIndex[key];
        if (!outfit) continue;

        const isAmmo =
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0)
         || outfit.category === 'Ammunition'
         || (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0);
        if (!isAmmo) continue;

        const ammoCount = val === true ? 1 : Math.max(1, Math.round(val));
        return { ammoName: key, ammoCount };
    }
    return null;
}

/**
 * canWeaponFire(w, st, stats)  →  string | null
 *
 * Returns the FIRST reason the weapon is blocked, or null if it can fire.
 *
 * Possible return values:
 *   null                  — can fire
 *   'firing energy'       — insufficient energy (or ionized while energy-gated)
 *   'firing fuel'         — insufficient fuel
 *   'firing hull'         — firing would push hull below disable threshold
 *   'firing shields'      — insufficient shields
 *   'ammo:<OutfitName>'   — that ammo outfit is exhausted
 *
 * A weapon with zero cost for a resource is NEVER blocked by that resource.
 * Firing heat is never a gate here — overheat shuts ALL weapons via isOverheated.
 */
function canWeaponFire(w, st, stats) {
    const fe = w['firing energy'] || 0;
    if (fe > 0) {
        if (st.isIonized || st.energy < fe) return 'firing energy';
    }

    const ff = w['firing fuel'] || 0;
    if (ff > 0 && st.fuel < ff) return 'firing fuel';

    const fh = w['firing hull'] || 0;
    if (fh > 0 && st.hull - fh < stats.minHull) return 'firing hull';

    const fs = w['firing shields'] || 0;
    if (fs > 0 && st.shields < fs) return 'firing shields';

    const ammoRef = resolveAmmoRef(w);
    if (ammoRef && ammoRef.ammoName) {
        const have = st.ammoInventory[ammoRef.ammoName] ?? 0;
        if (have < ammoRef.ammoCount) return 'ammo:' + ammoRef.ammoName;
    }

    return null;
}

/**
 * consumeFiringCosts(w, st)
 * Deducts all per-shot resource costs.  Only call when canWeaponFire returns null.
 */
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
//  WEAPON SUSTAIN — per-frame stall / resume / ammo-out event detection
// ═══════════════════════════════════════════════════════════════════════════════

function _isAmmoReason(r) { return typeof r === 'string' && r.startsWith('ammo:'); }

// ─────────────────────────────────────────────────────────────────────────────
//  Hysteresis thresholds.
//
//  A resource stall is only REPORTED after it has blocked at least one weapon
//  for STALL_CONFIRM_FRAMES consecutive frames.  A resume is only reported
//  after the resource has been clear for RESUME_CONFIRM_FRAMES frames.
//
//  This prevents energy/shield oscillation (fire → dip → regen → fire…) from
//  flooding the log.  2 s to confirm a stall, 1 s to confirm recovery.
// ─────────────────────────────────────────────────────────────────────────────
const STALL_CONFIRM_FRAMES  = 2 * 60;
const RESUME_CONFIRM_FRAMES = 1 * 60;

/**
 * createSustainState(stats)
 *
 * Tracking is per-RESOURCE-TYPE across all weapons — at most one stall event
 * and one resume event per resource per ship per fight.
 *
 *   resourceState[key].reported       — stall event has been emitted (not yet resumed)
 *   resourceState[key].stallFrames    — consecutive frames >= 1 weapon blocked
 *   resourceState[key].resumeFrames   — consecutive frames all weapons clear
 *   resourceState[key].reportedNames  — weapon names captured at stall-report time
 *   ammoExhausted                     — Set<'name::ammo'>, permanent, emitted once
 */
function createSustainState(stats) {
    const resourceState = {};
    for (const key of FIRING_RESOURCE_KEYS) {
        resourceState[key] = {
            reported:      false,
            stallFrames:   0,
            resumeFrames:  0,
            reportedNames: [],
        };
    }
    return { resourceState, ammoExhausted: new Set() };
}

/**
 * checkWeaponSustainEvents(st, stats, side, t, sus, phases)
 *
 * Called once per frame BEFORE shootFrame.
 *
 * Ammo:     emitted immediately, once per weapon x ammo type, permanent.
 * Resource: per-resource hysteresis —
 *   blocked >= STALL_CONFIRM_FRAMES  → emit one grouped stall ⚠️
 *   clear   >= RESUME_CONFIRM_FRAMES → emit one grouped resume 🔄
 */
function checkWeaponSustainEvents(st, stats, side, t, sus, phases) {
    const weapons = stats.weapons;
    if (!weapons.length) return;

    // ── Ammo exhaustion (immediate, permanent, once per weapon×ammo) ──────
    for (let i = 0; i < weapons.length; i++) {
        const w      = weapons[i];
        const reason = canWeaponFire(w, st, stats);
        if (!_isAmmoReason(reason)) continue;
        const name     = w._name || ('Weapon ' + (i + 1));
        const ammoName = reason.slice(5);
        const key      = name + '::' + ammoName;
        if (!sus.ammoExhausted.has(key)) {
            sus.ammoExhausted.add(key);
            phases.push({
                time: t, type: side, icon: '📦',
                text: `<strong>${escHtml(stats.name)}</strong>'s ` +
                      `<em>${escHtml(name)}</em> ran out of ` +
                      `<em>${escHtml(ammoName)}</em> ammo at ${fmtT(t)} ` +
                      `\u2014 permanently offline`,
            });
        }
    }

    // ── Per-resource hysteresis ────────────────────────────────────────────
    for (const key of FIRING_RESOURCE_KEYS) {
        const rs = sus.resourceState[key];

        // Weapons that use this resource AND are currently blocked by it
        const blocked = [];
        for (let i = 0; i < weapons.length; i++) {
            const w = weapons[i];
            if ((w[key] || 0) === 0) continue;           // doesn't use this resource
            if (canWeaponFire(w, st, stats) === key)
                blocked.push(w._name || ('Weapon ' + (i + 1)));
        }

        if (blocked.length > 0) {
            rs.stallFrames++;
            rs.resumeFrames = 0;

            if (!rs.reported && rs.stallFrames === STALL_CONFIRM_FRAMES) {
                rs.reported      = true;
                rs.reportedNames = [...new Set(blocked)];   // deduplicate names
                const label   = resourceLabel(key);
                const nameStr = rs.reportedNames.map(n => `<em>${escHtml(n)}</em>`).join(', ');
                const verb    = rs.reportedNames.length === 1 ? 'is' : 'are';
                phases.push({
                    time: t, type: side, icon: '\u26a0\ufe0f',
                    text: `<strong>${escHtml(stats.name)}</strong>'s ${nameStr} ` +
                          `${verb} unable to sustain fire \u2014 ` +
                          `<em>${escHtml(label)}</em> insufficient at ${fmtT(t)} ` +
                          `(may recover)`,
                });
            }
        } else {
            rs.resumeFrames++;
            rs.stallFrames = 0;

            if (rs.reported && rs.resumeFrames === RESUME_CONFIRM_FRAMES) {
                rs.reported = false;
                const label   = resourceLabel(key);
                const nameStr = rs.reportedNames.map(n => `<em>${escHtml(n)}</em>`).join(', ');
                const verb    = rs.reportedNames.length === 1 ? 'has' : 'have';
                phases.push({
                    time: t, type: side, icon: '\ud83d\udd04',
                    text: `<strong>${escHtml(stats.name)}</strong>'s ${nameStr} ` +
                          `${verb} resumed firing \u2014 ` +
                          `<em>${escHtml(label)}</em> restored at ${fmtT(t)}`,
                });
                rs.reportedNames = [];
            }
        }
    }
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
        fuel:    stats.fuelCap > 0 ? stats.fuelCap : 0,
        ammoInventory: { ...(stats.ammoInventory || {}) },
        statusEffects,
        shieldDelayCounter: 0,
        repairDelayCounter: 0,
        depletedFlag:       false,
        weaponReloadCounters: stats.weapons.map(() => 0),
        weaponBurstCounters:  stats.weapons.map(() => 0),
        disabled:    false, disabledAt:  Infinity,
        destroyed:   false, destroyedAt: Infinity,
        isOverheated: false, isIonized:  false,
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

    // Sustain tracking — lives outside combatant state so it doesn't interfere
    const susA = createSustainState(sA);
    const susB = createSustainState(sB);

    const milestones = {
        A: { shieldsBroken: false, halfHull: false, disabled: false,
             energyBlackout: false, overheated: false, heavilySlowed: false },
        B: { shieldsBroken: false, halfHull: false, disabled: false,
             energyBlackout: false, overheated: false, heavilySlowed: false },
    };
    const timelineA = [], timelineB = [];
    let frame = 0;

    while (frame < MAX_FRAMES) {
        const t = frame / FPS;
        if (frame % 60 === 0) {
            timelineA.push({ t, shields: stA.shields, hull: stA.hull, energy: stA.energy, heat: stA.heat });
            timelineB.push({ t, shields: stB.shields, hull: stB.hull, energy: stB.energy, heat: stB.heat });
        }

        // Sustain checks run BEFORE shooting so events fire on the correct frame
        if (!stA.disabled && !stA.destroyed)
            checkWeaponSustainEvents(stA, sA, 'A', t, susA, result.phases);
        if (!stB.disabled && !stB.destroyed)
            checkWeaponSustainEvents(stB, sB, 'B', t, susB, result.phases);

        const preShieldsA = stA.shields, preHullA = stA.hull;
        const preShieldsB = stB.shields, preHullB = stB.hull;

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
        stA.heat    = Math.max(0, stA.heat);
        stB.heat    = Math.max(0, stB.heat);
        if (sA.fuelCap > 0) stA.fuel = Math.max(0, Math.min(sA.fuelCap, stA.fuel));
        if (sB.fuelCap > 0) stB.fuel = Math.max(0, Math.min(sB.fuelCap, stB.fuel));

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
    if (!timelineA.length || timelineA[timelineA.length - 1].t < finalT) {
        timelineA.push({ t: finalT, shields: stA.shields, hull: stA.hull, energy: stA.energy, heat: stA.heat });
        timelineB.push({ t: finalT, shields: stB.shields, hull: stB.hull, energy: stB.energy, heat: stB.heat });
    }
    result.timelineA = timelineA; result.timelineB = timelineB;
    result.finalStateA = stA;     result.finalStateB = stB;

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
    if (attSt.isOverheated) return;

    for (let i = 0; i < attStats.weapons.length; i++) {
        const w = attStats.weapons[i];
        if (attSt.weaponReloadCounters[i] > 0) { attSt.weaponReloadCounters[i]--; continue; }

        const reload      = Math.max(1, w.reload || 1);
        const burstCount  = w['burst count']  || 1;
        const burstReload = w['burst reload'] || reload;

        // Unified gate: energy, fuel, hull, shields, ammo
        if (canWeaponFire(w, attSt, attStats) !== null) {
            advanceBurst(attSt, i, burstCount, burstReload, reload);
            continue;
        }

        const scrambling = attSt.statusEffects.scrambling || 0;
        if (scrambling > 0.1) {
            if (Math.random() < (1 - Math.pow(2, -scrambling / 70))) {
                advanceBurst(attSt, i, burstCount, burstReload, reload);
                continue;
            }
        }

        consumeFiringCosts(w, attSt);

        for (const [statName, firingKey] of Object.entries(FIRING_STATUS_MAP)) {
            const val = w[firingKey] || 0;
            if (val > 0) attSt.statusEffects[statName] = (attSt.statusEffects[statName] || 0) + val;
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

// ── applyWeaponDamage ─────────────────────────────────────────────────────────
function applyWeaponDamage(w, defSt, defStats) {
    const disruptMult      = 1 + (defSt.statusEffects.disruption || 0) * 0.01;
    const effectivePiercing = Math.max(0, Math.min(1, w.piercing || 0))
                            * (1 - defStats.piercingRes);

    const relShieldDmg = (w['% shield damage'] || 0)
                       * Math.min(Math.max(0, defSt.shields), defStats.maxShields);
    const relHullDmg   = (w['% hull damage']   || 0)
                       * Math.min(Math.max(0, defSt.hull),    defStats.maxHull);

    const rawShieldDmg = (w['shield damage'] || 0) + relShieldDmg;
    const rawHullDmg   = (w['hull damage']   || 0) + relHullDmg;

    const shieldDmgTotal   = rawShieldDmg * (1 - defStats.shieldProt) * disruptMult;
    const hullDmgAfterProt = rawHullDmg   * (1 - defStats.hullProt);
    const hullPiercedDmg   = shieldDmgTotal * effectivePiercing;
    const shieldDmgApplied = shieldDmgTotal * (1 - effectivePiercing);

    if (defSt.shields > 0) {
        defSt.shields -= shieldDmgApplied;
        defSt.hull    -= hullPiercedDmg;
        if (defSt.shields < 0) {
            const overflow = -defSt.shields;
            defSt.shields = 0;
            defSt.hull -= overflow * (1 - defStats.hullProt);
            defSt.hull -= hullDmgAfterProt;
        }
    } else {
        defSt.hull -= hullDmgAfterProt + rawShieldDmg * (1 - defStats.shieldProt);
    }

    defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.shieldDelay   || 0);
    defSt.repairDelayCounter = Math.max(defSt.repairDelayCounter, defStats.repairDelay   || 0);
    if (defSt.depletedFlag)
        defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.depletedDelay || 0);

    const shieldsUp = defSt.shields > 0;
    for (const typeName of _damageTypes) {
        if (typeName === 'Shield' || typeName === 'Hull') continue;
        const raw      = w[dmgKey(typeName)]    || 0;
        const rel      = w[relDmgKey(typeName)] || 0;
        const totalDmg = raw + rel;
        if (!totalDmg) continue;
        const prot         = defStats.protections[protKey(typeName)] || 0;
        const shieldMult   = window.DamageTypes?.getShieldMultiplier(typeName, shieldsUp) ?? 1.0;
        const effectiveDmg = totalDmg * (1 - prot) * shieldMult;
        if (effectiveDmg > 0)
            applyStatusOrInstantDamage(defSt, typeName, effectiveDmg);
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
    st.energy += stats.energyGenPerFrame
               - stats.energyConsumeIdlePerFrame
               - stats.movingEnergyPerFrame
               - stats.coolingEnergyPerFrame;
    st.heat   += stats.heatGenIdlePerFrame
               + stats.movingHeatPerFrame
               - stats.coolingPerFrame;
    st.heat   -= st.heat * stats.heatDissipFrac;

    // Fuel recovery: ramscoop (0.03*sqrt(solar)*attr/FPS) + fuel generation attr/FPS
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
        const effectiveR     = Math.min(resistPerFrame, passive);
        st.statusEffects[statName] = Math.max(0, passive - effectiveR);
    }
}

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
    if (!m.heavilySlowed && (st.statusEffects.slowing || 0) >= 20) {
        m.heavilySlowed = true;
        const pct = Math.round((1 - 1 / (1 + (st.statusEffects.slowing || 0) * 0.05)) * 100);
        phases.push({ time: t, type: side, icon: '🐌',
            text: `<strong>${escHtml(stats.name)}</strong> heavily slowed (~${pct}% speed reduction) at ${fmtT(t)}` });
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
//  UI
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
            if (ship.sprite)               element = await window.fetchSprite(ship.sprite,     ship.spriteData || {});
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
        const protDisplay = [];
        if (stats.shieldProt > 0)  protDisplay.push(['Shld Prot', fmtPct(stats.shieldProt)]);
        if (stats.hullProt > 0)    protDisplay.push(['Hull Prot', fmtPct(stats.hullProt)]);
        if (stats.piercingRes > 0) protDisplay.push(['Pierce Res', fmtPct(stats.piercingRes)]);
        for (const [key, val] of Object.entries(stats.protections)) {
            if (key === 'shield protection' || key === 'hull protection') continue;
            if (val > 0) {
                const label = key.replace(' protection', '').replace(/\b\w/g, l => l.toUpperCase()) + ' Prot';
                protDisplay.push([label, fmtPct(val)]);
            }
        }
        const baseStats = [
            ['Shields',    fmt(stats.maxShields)],
            ['Hull',       fmt(stats.maxHull)],
            ['Min Hull',   fmt(stats.minHull)],
            ['Shld DPS',   fmt(stats.shieldDPS)],
            ['Hull DPS',   fmt(stats.hullDPS)],
            ['Shld Regen', fmt(stats.shieldRegenPerSec) + '/s'],
            ['Energy',     fmt(stats.energyCap)],
            ['Heat Cap',   fmt(stats.maxHeat)],
        ];
        statEl.innerHTML = [...baseStats, ...protDisplay].map(([l, v]) =>
            `<div class="slot-stat"><div class="slot-stat-label">${l}</div><div class="slot-stat-value">${v}</div></div>`).join('');
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
    if (!window.DamageTypes?.isReady())
        { setStatus('Damage type registry not ready — please wait.', true); return; }
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
    if (subtitleEl)
        subtitleEl.innerHTML = `${buildTtkString(sA.name, result.ttkA, result.projectedTtkA)}&nbsp;&nbsp;·&nbsp;&nbsp;${buildTtkString(sB.name, result.ttkB, result.projectedTtkB)}`;

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
    if (weaponsEl)
        weaponsEl.innerHTML =
            `<div><div class="weapons-col-title weapons-col-title-a">${escHtml(sA.name)}</div>${buildWeaponsList(sA.weaponDetails)}</div>
             <div><div class="weapons-col-title weapons-col-title-b">${escHtml(sB.name)}</div>${buildWeaponsList(sB.weaponDetails)}</div>`;

    const phaseEl = document.getElementById('phaseList');
    if (phaseEl) {
        const phases = [...result.phases];
        if (result.winner === 'A' && result.projectedTtkA != null) {
            const pttk = result.projectedTtkA;
            phases.push({ time: result.ttkB + (isFinite(pttk) ? pttk : 0), type: 'A', icon: '📊',
                text: isFinite(pttk)
                    ? `<strong>${escHtml(sA.name)}</strong> projected to survive ~${fmtT(pttk)} more under continued fire`
                    : `<strong>${escHtml(sA.name)}</strong> projected to outlast continued fire — regen outpaces damage` });
        }
        if (result.winner === 'B' && result.projectedTtkB != null) {
            const pttk = result.projectedTtkB;
            phases.push({ time: result.ttkA + (isFinite(pttk) ? pttk : 0), type: 'B', icon: '📊',
                text: isFinite(pttk)
                    ? `<strong>${escHtml(sB.name)}</strong> projected to survive ~${fmtT(pttk)} more under continued fire`
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

function buildHpChart(sA, sB, result) {
    const tlA = result.timelineA || [], tlB = result.timelineB || [];
    if (!tlA.length && !tlB.length) return '';
    const W=560, H=180, PL=44, PR=12, PT=14, PB=28, cW=W-PL-PR, cH=H-PT-PB;
    const maxTime = Math.max(tlA.length?tlA[tlA.length-1].t:0, tlB.length?tlB[tlB.length-1].t:0, 1);
    const maxHP   = Math.max(sA.maxShields+sA.maxHull, sB.maxShields+sB.maxHull, 1);
    const px = t  => PL + (t/maxTime)*cW;
    const py = hp => PT + cH - (hp/maxHP)*cH;
    const pathAH = tlA.map((p,i)=>`${i?'L':'M'}${px(p.t).toFixed(1)},${py(p.hull).toFixed(1)}`).join(' ');
    const pathBH = tlB.map((p,i)=>`${i?'L':'M'}${px(p.t).toFixed(1)},${py(p.hull).toFixed(1)}`).join(' ');
    const pathAS = tlA.map((p,i)=>`${i?'L':'M'}${px(p.t).toFixed(1)},${py(p.hull+p.shields).toFixed(1)}`).join(' ');
    const pathBS = tlB.map((p,i)=>`${i?'L':'M'}${px(p.t).toFixed(1)},${py(p.hull+p.shields).toFixed(1)}`).join(' ');
    const yTicks = [0,0.5,1].map(f=>{const v=maxHP*f,y=py(v).toFixed(1),lb=v>=1000?(v/1000).toFixed(1)+'k':Math.round(v).toString();
        return `<line x1="${PL}" y1="${y}" x2="${PL+cW}" y2="${y}" stroke="rgba(148,163,184,0.12)" stroke-width="1"/>
                <text x="${PL-4}" y="${+y+4}" fill="#64748b" font-size="10" text-anchor="end">${lb}</text>`;}).join('');
    const xTicks = [0,0.5,1].map(f=>{const t=maxTime*f,x=px(t).toFixed(1);
        return `<text x="${x}" y="${PT+cH+14}" fill="#64748b" font-size="10" text-anchor="middle">${t.toFixed(1)}s</text>`;}).join('');
    const threshA = sA.minHull>0?`<line x1="${PL}" y1="${py(sA.minHull).toFixed(1)}" x2="${PL+cW}" y2="${py(sA.minHull).toFixed(1)}" stroke="rgba(59,130,246,0.4)" stroke-width="1" stroke-dasharray="4,3"/>`:'' ;
    const threshB = sB.minHull>0?`<line x1="${PL}" y1="${py(sB.minHull).toFixed(1)}" x2="${PL+cW}" y2="${py(sB.minHull).toFixed(1)}" stroke="rgba(239,68,68,0.4)" stroke-width="1" stroke-dasharray="4,3"/>`:'' ;
    const trunc=(s,n)=>s.length>n?s.slice(0,n-1)+'…':s, lx=PL+cW-4;
    const legend=`<rect x="${lx-80}" y="${PT+4}" width="8" height="3" fill="#3b82f6" rx="1"/>
        <text x="${lx-68}" y="${PT+9}" fill="#93c5fd" font-size="10" text-anchor="start">${escHtml(trunc(sA.name,18))}</text>
        <rect x="${lx-80}" y="${PT+16}" width="8" height="3" fill="#ef4444" rx="1"/>
        <text x="${lx-68}" y="${PT+21}" fill="#fca5a5" font-size="10" text-anchor="start">${escHtml(trunc(sB.name,18))}</text>`;
    return `<div class="hp-chart-wrap"><svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;display:block;height:auto;">
        <rect x="${PL}" y="${PT}" width="${cW}" height="${cH}" fill="rgba(15,23,42,0.5)" rx="4"/>
        ${yTicks}${xTicks}${threshA}${threshB}
        <path d="${pathAS}" fill="none" stroke="rgba(59,130,246,0.35)" stroke-width="1.5"/>
        <path d="${pathAH}" fill="none" stroke="#3b82f6" stroke-width="2.5"/>
        <path d="${pathBS}" fill="none" stroke="rgba(239,68,68,0.35)" stroke-width="1.5"/>
        <path d="${pathBH}" fill="none" stroke="#ef4444" stroke-width="2.5"/>
        ${legend}</svg></div>`;
}

function buildCompareGrid(sA, sB, result) {
    const ttkStrA = isFinite(result.ttkA) ? fmtTTK(result.ttkA)
        : result.projectedTtkA != null ? (isFinite(result.projectedTtkA) ? `~${fmtT(result.projectedTtkA)} (proj.)` : '∞ (regen wins)') : '∞ (survived)';
    const ttkStrB = isFinite(result.ttkB) ? fmtTTK(result.ttkB)
        : result.projectedTtkB != null ? (isFinite(result.projectedTtkB) ? `~${fmtT(result.projectedTtkB)} (proj.)` : '∞ (regen wins)') : '∞ (survived)';

    const allProtKeys = new Set([...Object.keys(sA.protections), ...Object.keys(sB.protections), 'piercing resistance']);
    const protRows = [];
    for (const key of [...allProtKeys].sort()) {
        const va = key === 'piercing resistance' ? sA.piercingRes : (sA.protections[key] || 0);
        const vb = key === 'piercing resistance' ? sB.piercingRes : (sB.protections[key] || 0);
        if (va === 0 && vb === 0) continue;
        protRows.push([key.replace(/\b\w/g, l => l.toUpperCase()), fmtPct(va), fmtPct(vb)]);
    }

    const sections = [
        ['Combat', [
            ['Time to Disable',   ttkStrA, ttkStrB],
            ['Max Shields',       fmt(sA.maxShields), fmt(sB.maxShields)],
            ['Max Hull',          fmt(sA.maxHull),    fmt(sB.maxHull)],
            ['Disable Threshold', fmt(sA.minHull),    fmt(sB.minHull)],
            ['Shield DPS',        fmt(sA.shieldDPS),  fmt(sB.shieldDPS)],
            ['Hull DPS',          fmt(sA.hullDPS),    fmt(sB.hullDPS)],
            ['Shield Regen/s',    fmt(sA.shieldRegenPerSec), fmt(sB.shieldRegenPerSec)],
            ['Hull Repair/s',     fmt(sA.hullRepairPerSec),  fmt(sB.hullRepairPerSec)],
            ...protRows,
        ]],
        ['Energy & Heat', [
            ['Energy Cap.',     fmt(sA.energyCap),             fmt(sB.energyCap)],
            ['Energy Gen/s',    fmt(sA.energyGenPerFrame*FPS), fmt(sB.energyGenPerFrame*FPS)],
            ['Firing Energy/s', fmt(sA.firingEnergyPerSec),    fmt(sB.firingEnergyPerSec)],
            ['Net Energy/s',
                fmtNet((sA.energyGenPerFrame-sA.energyConsumeIdlePerFrame-sA.movingEnergyPerFrame-sA.coolingEnergyPerFrame-sA.firingEnergyPerSec/FPS)*FPS),
                fmtNet((sB.energyGenPerFrame-sB.energyConsumeIdlePerFrame-sB.movingEnergyPerFrame-sB.coolingEnergyPerFrame-sB.firingEnergyPerSec/FPS)*FPS)],
            ['Heat Capacity',   fmt(sA.maxHeat),          fmt(sB.maxHeat)],
            ['Cooling/s',       fmt(sA.coolingPerSec),    fmt(sB.coolingPerSec)],
            ['Firing Heat/s',   fmt(sA.firingHeatPerSec), fmt(sB.firingHeatPerSec)],
            ['Cool Efficiency', sA.coolEff.toFixed(3),    sB.coolEff.toFixed(3)],
        ]],
        ['Navigation', [
            ['Mass',          fmt(sA.rawMass)+' t',      fmt(sB.rawMass)+' t'],
            ['Inertial Mass', fmt(sA.inertialMass)+' t', fmt(sB.inertialMass)+' t'],
            ['Max Velocity',  fmt(sA.maxVelocity)+' px/s', fmt(sB.maxVelocity)+' px/s'],
        ]],
    ];

    return sections.map(([section, items]) => {
        const colA      = items.map(([,va])   => `<div class="res-row"><div class="res-row-value">${va}</div></div>`).join('');
        const colDiv    = items.map(([label]) => `<div class="res-divider-item">${label}</div>`).join('');
        const colB      = items.map(([,,vb])  => `<div class="res-row"><div class="res-row-value">${vb}</div></div>`).join('');
        const mobileRows = items.map(([label,va,vb]) =>
            `<div class="res-row-mobile"><span class="res-row-mobile__label">${label}</span><span class="res-row-mobile__val-a">${va}</span><span class="res-row-mobile__val-b">${vb}</span></div>`).join('');
        return `<div class="res-section-title">${section}</div>
        <div class="results-compare">
            <div class="res-col res-col-a">${colA}</div>
            <div class="res-divider">${colDiv}</div>
            <div class="res-col res-col-b">${colB}</div>
            ${mobileRows}
        </div>`;
    }).join('');
}

function buildWeaponsList(details) {
    if (!details?.length)
        return '<div class="weapon-item" style="color:var(--c-text-muted);font-style:italic;padding:8px 0;">No weapons</div>';
    return details.map(w => {
        const extra = [];
        for (const typeName of _damageTypes) {
            if (typeName==='Shield'||typeName==='Hull') continue;
            const dps = w[typeName.toLowerCase()+'DPS']||0;
            if (dps > 0.001) {
                const typeEntry = window.DamageTypes?.getDamageType(typeName);
                const isStatusOnly = typeEntry?.category === 'status' &&
                                     typeEntry?.shieldInteraction !== 'direct';
                extra.push(`${typeName}: ${fmt(dps)}/s${isStatusOnly ? ' ⚡' : ''}`);
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
