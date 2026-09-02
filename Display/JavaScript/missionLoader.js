'use strict';

// ═══════════════════════════════════════════════════════════
//  missionLoader.js  —  Endless Sky Mission Loader
//
//  Same shape as dataLoader.js: loads per-plugin mission data
//  from GitHub, manages active plugin selection, and persists
//  that selection to localStorage.
//
//  UNLIKE dataLoader.js, this module also owns ALL formatting.
//  getAllMissions() doesn't hand back raw mission objects — it
//  hands back ready-to-render view models (title, badges, and
//  a fully-built bodyHtml string) so the display layer never
//  has to know what a mission object looks like internally.
//
//  Public API on window.MissionLoader:
//    .load()                      → Promise — start/await loading
//    .onReady(fn)                 → register ready callback
//    .isReady()                   → boolean
//    .getPlugins()                → all loaded plugins + mission counts
//    .getActivePlugins()          → ordered active outputNames
//    .setActivePlugins(arr)       → set active set, fires 'missionPluginsChanged'
//    .initDefaultPlugins()        → activate saved set, or ALL loaded plugins
//    .getAllMissions()            → formatted view models from active plugins
//    .getMissionsByPlugin(id)     → formatted view models from one plugin
//
//  Custom events fired on document:
//    'missionsLoaded'         — all remote mission data fetched
//    'missionsLoadError'      — fetch failed
//    'missionPluginsChanged'  — active plugin selection changed
// ═══════════════════════════════════════════════════════════

(function () {

const REPO_URL  = 'GIVEMEFOOD5/endless-sky-ship-builder';
const BASE_URL  = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;
const ACTIVE_KEY = 'es_sb_active_mission_plugins';
const DEFAULT_PLUGIN = 'official-game/endless-sky';

// ── Internal state ─────────────────────────────────────────
let _ready         = false;
let _loading       = false;
let _callbacks     = [];
let _activePlugins = [];

// window.allMissionData[outputName] = { sourceName, displayName, outputName, missions: [...] }
window.allMissionData = window.allMissionData || {};

// ═════════════════════════════════════════════════════════════
//  Formatting helpers — ported from the standalone mission
//  viewer, now living here so the display layer stays dumb.
// ═════════════════════════════════════════════════════════════
function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function mono(text)      { return `<span class="tag-inline">${esc(text)}</span>`; }
function tag(text, cls)  { return `<span class="badge ${cls}">${esc(text)}</span>`; }

function formatRange(r) {
    let out = r.commodity ? `${esc(r.commodity)}: ` : '';
    if (r.mode === 'fixed')              out += r.min;
    else if (r.mode === 'uniform')       out += `${r.min}–${r.max}`;
    else if (r.mode === 'negative-binomial') out += `~${r.expected} (min ${r.min}, up to ~${r.softMax})`;
    else out += esc(JSON.stringify(r));
    return out;
}

function formatDeadline(d) {
    return `${d.days} day${d.days === 1 ? '' : 's'}${d.multiplier ? `, +${d.multiplier}/jump` : ''}`;
}

function formatIllegal(i) {
    return `fine ${i.fine ?? '?'}${i.message ? ` — "${esc(i.message)}"` : ''}`;
}

function planetName(ref) {
    if (!ref) return null;
    if (ref.type === 'planet') return ref.ref ? ref.ref.name : ref.value;
    return null;
}

function summarizeEntry(e) {
    return e.values.length ? `${e.key} ${e.values.join(' ')}` : e.key;
}

function formatLocationRef(ref) {
    if (ref.type === 'planet') {
        const name = ref.ref ? ref.ref.name : ref.value;
        const plugin = ref.ref && ref.ref.pluginId ? ` <span class="field-label">(${esc(ref.ref.pluginId)})</span>` : '';
        return mono(name) + plugin;
    }
    if (ref.type === 'filter') {
        const conds = ref.value || [];
        if (!conds.length) return '<span class="empty">any (unfiltered)</span>';
        return 'filtered by: ' + conds.map(c => mono(summarizeEntry(c))).join(', ');
    }
    return esc(JSON.stringify(ref));
}

function formatNamedRefList(refs) {
    return refs.map(r => mono(r.name) + (r.count > 1 ? ` ×${r.count}` : '')).join(', ');
}

function formatPayment(p) {
    const parts = [];
    if (p.apparentPayment !== null && p.apparentPayment !== undefined) parts.push(`apparent: ${p.apparentPayment}`);
    Object.entries(p.triggers || {}).forEach(([trigger, entries]) => {
        (entries || []).forEach(e => {
            parts.push(`${trigger}: base ${e.base}${e.multiplier ? ` + ${e.multiplier}/distance` : ''}`);
        });
    });
    return parts.length ? parts.join('<br>') : '<span class="empty">none declared</span>';
}

function formatEventTriggers(list) {
    return list.map(e =>
        `${mono(e.name)} on ${esc(e.trigger)}${e.delayDays ? ` (+${e.delayDays}${e.delayDaysMax ? `–${e.delayDaysMax}` : ''}d)` : ''}`
    ).join('<br>');
}

function formatSideEffects(list) {
    return list.map(e => `${mono(e.condition)} ${esc(e.op)} on ${esc(e.trigger)}`).join('<br>');
}

function flagLabel(key, value) {
    if (value === true) return key;
    if (Array.isArray(value)) return `${key} ×${value.length}`;
    if (typeof value === 'object' && value !== null) return key;
    return `${key}: ${value}`;
}

// Generic { key, values, children } tree → HTML string. Used for `raw`
// and for `conditions`, since missionParser.js gives both the exact same
// shape. depth just controls indentation.
function renderTreeHtml(entries, depth = 0) {
    if (!entries || !entries.length) return '<div class="raw-line empty">(empty)</div>';
    let html = '';
    entries.forEach(entry => {
        const indent = '  '.repeat(depth);
        const looksLikeBareText = entry.values.length === 0 && !entry.children &&
            !/^[a-z][a-z0-9 _-]*$/i.test(entry.key || '');
        if (looksLikeBareText || (entry.key && entry.key.length > 40 && entry.values.length === 0)) {
            html += `<div class="raw-line">${indent}<span class="raw-text">"${esc(entry.key)}"</span></div>`;
        } else {
            const valuesStr = entry.values.length
                ? ' ' + entry.values.map(v => `<span class="raw-value">${esc(String(v))}</span>`).join(' ')
                : '';
            html += `<div class="raw-line">${indent}<span class="raw-key">${esc(entry.key)}</span>${valuesStr}</div>`;
        }
        if (entry.children && entry.children.length) {
            html += renderTreeHtml(entry.children, depth + 1);
        }
    });
    return html;
}

// ═════════════════════════════════════════════════════════════
//  Mission → view model. Everything the display layer needs,
//  pre-built. `bodyHtml` is a complete, ready-to-inject string.
// ═════════════════════════════════════════════════════════════
function formatMission(m, pluginId, pluginDisplay) {
    const badges = [];
    (m.locations || []).forEach(l => badges.push(tag(l, '')));
    if (m.repeatable) badges.push(tag('repeatable' + (m.repeatLimit ? ` (limit ${m.repeatLimit})` : ''), 'repeatable'));
    if (m.illegal) badges.push(tag('illegal', 'illegal'));
    Object.keys(m.flags || {}).forEach(k => badges.push(tag(flagLabel(k, m.flags[k]), 'flag')));

    let bodyHtml = '';
    if (badges.length) bodyHtml += `<div class="badges">${badges.join('')}</div>`;
    if (m.description) bodyHtml += `<div class="description-box">${esc(m.description)}</div>`;

    const rows = [];
    if (m.name) rows.push(['Internal name', mono(m.name)]);
    if (m.cargo) rows.push(['Cargo', formatRange(m.cargo)]);
    if (m.passengers) rows.push(['Passengers', formatRange(m.passengers)]);
    if (m.deadline) rows.push(['Deadline', formatDeadline(m.deadline)]);
    if (m.illegal) rows.push(['Illegal', formatIllegal(m.illegal)]);
    if (m.source) rows.push(['Source', formatLocationRef(m.source)]);
    if (m.destination) rows.push(['Destination', formatLocationRef(m.destination)]);
    if (m.stopovers && m.stopovers.length) rows.push(['Stopovers', formatNamedRefList(m.stopovers)]);
    if (m.waypoints && m.waypoints.length) rows.push(['Waypoints', formatNamedRefList(m.waypoints)]);
    if (m.payment && (m.payment.apparentPayment != null || Object.keys(m.payment.triggers || {}).length)) {
        rows.push(['Payment', formatPayment(m.payment)]);
    }
    if (m.hasNpcObjective) rows.push(['NPCs', `${m.npcCount} NPC block${m.npcCount === 1 ? '' : 's'} (see raw data)`]);
    if (m.eventTriggers && m.eventTriggers.length) rows.push(['Event triggers', formatEventTriggers(m.eventTriggers)]);
    if (m.conditionSideEffects && m.conditionSideEffects.length) rows.push(['Side effects', formatSideEffects(m.conditionSideEffects)]);

    if (rows.length) {
        bodyHtml += '<div class="field-grid">';
        rows.forEach(([label, value]) => {
            bodyHtml += `<div class="field-label">${esc(label)}</div><div class="field-value">${value}</div>`;
        });
        bodyHtml += '</div>';
    }

    const outfitRewards = (m.rewards && m.rewards.outfits) || [];
    const shipRewards    = (m.rewards && m.rewards.ships) || [];
    if (outfitRewards.length || shipRewards.length) {
        bodyHtml += '<div class="section-title">Rewards</div><ul class="reward-list">';
        outfitRewards.forEach(o => {
            bodyHtml += `<li>Outfit: ${mono(o.name)} × ${o.count}${o.grantedIn ? ` <span class="field-label">(on ${esc(o.grantedIn)})</span>` : ''}</li>`;
        });
        shipRewards.forEach(s => {
            bodyHtml += `<li>Ship: ${mono(s.name)}${s.customName ? ` named "${esc(s.customName)}"` : ''}${s.grantedIn ? ` <span class="field-label">(on ${esc(s.grantedIn)})</span>` : ''}</li>`;
        });
        bodyHtml += '</ul>';
    }

    if (m.conditions && Object.keys(m.conditions).length) {
        bodyHtml += '<div class="section-title">Conditions</div>';
        Object.entries(m.conditions).forEach(([name, tree]) => {
            bodyHtml += `<div><span class="field-label">to ${esc(name)}</span></div>${renderTreeHtml(tree)}`;
        });
    }

    const detailedFlags = Object.entries(m.flags || {}).filter(([, v]) => v !== true);
    if (detailedFlags.length) {
        bodyHtml += '<div class="section-title">Other declared fields</div>';
        detailedFlags.forEach(([k, v]) => {
            bodyHtml += `<div><span class="field-label">${esc(k)}</span></div>`;
            if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null && 'key' in v[0]) {
                bodyHtml += renderTreeHtml(v);
            } else {
                bodyHtml += `<div class="field-value">${mono(JSON.stringify(v))}</div>`;
            }
        });
    }

    if (m.raw) {
        bodyHtml += `<span class="raw-toggle">▸ View full raw structure</span>` +
                    `<div class="raw-tree">${renderTreeHtml(m.raw)}</div>`;
    }

    const searchText = [
        m.name, m.displayName, m.description, pluginId, pluginDisplay,
        planetName(m.source), planetName(m.destination),
    ].filter(Boolean).join(' ').toLowerCase();

    return {
        id: m._internalId || `${pluginId}::${m.name}`,
        titleHtml: esc(m.displayName || m.name || '(unnamed mission)'),
        pluginId,
        pluginHtml: esc(pluginDisplay || pluginId || ''),
        searchText,
        bodyHtml,
    };
}

// ═════════════════════════════════════════════════════════════
//  Plugin management
// ═════════════════════════════════════════════════════════════
function _activeMissionData() {
    const result = {};
    for (const id of _activePlugins) {
        if (window.allMissionData[id]) result[id] = window.allMissionData[id];
    }
    return result;
}

function _fireEvent(name, detail = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
}

function _saveActivePlugins() {
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(_activePlugins)); } catch (_) {}
}
function _loadActivePlugins() {
    try { return JSON.parse(localStorage.getItem(ACTIVE_KEY)); } catch (_) { return null; }
}

// ═════════════════════════════════════════════════════════════
//  Public API
// ═════════════════════════════════════════════════════════════
window.MissionLoader = {

    load() {
        if (_ready)   return Promise.resolve(window.allMissionData);
        if (_loading) return new Promise(resolve => _callbacks.push(() => resolve(window.allMissionData)));
        return _doLoad();
    },

    onReady(fn) {
        if (_ready) { fn(window.allMissionData); return; }
        _callbacks.push(fn);
        if (!_loading) _doLoad();
    },

    isReady() { return _ready; },

    // ── Plugin management ──────────────────────────────────
    getPlugins() {
        return Object.entries(window.allMissionData).map(([id, p]) => ({
            outputName:   id,
            displayName:  p.displayName || id,
            sourceName:   p.sourceName  || id,
            missionCount: (p.missions || []).length,
            isDefault:    id === DEFAULT_PLUGIN,
        }));
    },

    getActivePlugins() { return [..._activePlugins]; },

    setActivePlugins(arr) {
        _activePlugins = arr.filter(id => window.allMissionData[id]);
        _saveActivePlugins();
        _fireEvent('missionPluginsChanged', { active: [..._activePlugins] });
    },

    initDefaultPlugins() {
        const saved = _loadActivePlugins();
        if (saved && saved.length) {
            const valid = saved.filter(id => window.allMissionData[id]);
            if (valid.length) {
                _activePlugins = valid;
                _fireEvent('missionPluginsChanged', { active: [..._activePlugins] });
                return;
            }
        }
        // No usable saved selection — default to EVERY loaded plugin, so
        // nothing is hidden until the user deliberately narrows it down.
        _activePlugins = Object.keys(window.allMissionData);
        _saveActivePlugins();
        _fireEvent('missionPluginsChanged', { active: [..._activePlugins] });
    },

    // ── Data accessors (active plugins only, fully formatted) ──
    getAllMissions() {
        const out = [];
        for (const [id, plugin] of Object.entries(_activeMissionData())) {
            const display = plugin.displayName || id;
            for (const m of (plugin.missions || [])) out.push(formatMission(m, id, display));
        }
        return out;
    },

    getMissionsByPlugin(pluginId) {
        const plugin = window.allMissionData[pluginId];
        if (!plugin) return [];
        const display = plugin.displayName || pluginId;
        return (plugin.missions || []).map(m => formatMission(m, pluginId, display));
    },

    DEFAULT_PLUGIN,
};

// ═════════════════════════════════════════════════════════════
//  Remote data loader — one missions.json per plugin, discovered
//  via the same data/index.json convention as dataLoader.js.
// ═════════════════════════════════════════════════════════════
async function _doLoad() {
    _loading = true;
    _fireEvent('missionsLoadStart');

    try {
        const indexRes = await fetch(`${BASE_URL}/index.json`);
        if (!indexRes.ok) throw new Error('Could not load data/index.json');
        const dataIndex = await indexRes.json();

        for (const [sourceName, pluginList] of Object.entries(dataIndex)) {
            for (const { outputName, displayPluginName } of pluginList) {
                const plugin = {
                    sourceName,
                    displayName: displayPluginName || outputName,
                    outputName,
                    missions: [],
                };
                try {
                    const res = await fetch(`${BASE_URL}/${outputName}/dataFiles/missions.json`);
                    if (res.ok) {
                        const json = await res.json();
                        plugin.missions = Array.isArray(json) ? json : (json.missions || []);
                        window.allMissionData[outputName] = plugin;
                    }
                } catch (err) {
                    console.warn(`[MissionLoader] Failed loading missions for "${outputName}":`, err);
                }
            }
        }

        const hasData = Object.values(window.allMissionData).some(p => (p.missions || []).length > 0);
        if (!hasData) throw new Error('No mission data could be loaded from any plugin');

        _ready   = true;
        _loading = false;

        window.MissionLoader.initDefaultPlugins();

        for (const fn of _callbacks) {
            try { fn(window.allMissionData); } catch (e) { console.error('[MissionLoader] callback error:', e); }
        }
        _callbacks = [];

        _fireEvent('missionsLoaded', { allMissionData: window.allMissionData });
        return window.allMissionData;

    } catch (error) {
        _loading = false;
        console.error('[MissionLoader] Load failed:', error);
        _fireEvent('missionsLoadError', { message: error.message });
        throw error;
    }
}

})();