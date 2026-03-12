// AttributeDisplay.js
// Loads attributeDefinitions.json and enhances renderAttributesTab with:
//   - Human-readable labels and unit annotations on every attribute row
//   - Tooltips showing descriptions and formulas on hover
//   - A "Derived Stats" section for ships/variants showing calculated values
//   - A "Weapon Stats" section for outfits with per-second DPS figures
//
// Hooks:
//   Called automatically — overrides window.renderAttributesTab after load.
//   The original Plugin_Script.js renderAttributesTab is preserved as
//   window._originalRenderAttributesTab and used as fallback.

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let _attrDefs = null;   // attributeDefinitions.json contents, loaded once

const ATTR_DEFS_URL = 'https://raw.githubusercontent.com/GIVEMEFOOD5/endless-sky-ship-builder/main/data/attributeDefinitions.json';

async function loadAttrDefs() {
    if (_attrDefs) return _attrDefs;
    try {
        const res = await fetch(ATTR_DEFS_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _attrDefs = await res.json();
    } catch (e) {
        console.warn('AttributeDisplay: could not load attributeDefinitions.json —', e.message);
        _attrDefs = { outfitAttributes: {}, derivedStats: {}, stackingRules: {}, shipDisplayStats: {} };
    }
    return _attrDefs;
}

// Kick off the load immediately so it's ready before the first modal opens
loadAttrDefs();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtNum(v) {
    if (v === undefined || v === null) return '—';
    if (typeof v !== 'number') return v;
    // Credits-style for large round numbers
    if (Number.isInteger(v) && Math.abs(v) >= 10000) return v.toLocaleString();
    // Up to 4 sig-figs for small decimals
    return parseFloat(v.toPrecision(4)).toString();
}

// Convert a raw per-frame value to per-second using the multiplier in attrDefs
function applyMultiplier(key, rawValue) {
    const def = _attrDefs?.outfitAttributes?.[key];
    if (!def?.multiplier) return rawValue;
    return rawValue * def.multiplier;
}

function getAttrDef(key) {
    return _attrDefs?.outfitAttributes?.[key]
        || _attrDefs?.outfitAttributes?.[key.toLowerCase()]
        || null;
}

function getDeriveDef(key) {
    return _attrDefs?.derivedStats?.[key] || null;
}

// Build a tooltip data-attribute string from a definition
function tooltipAttrs(def) {
    if (!def) return '';
    const parts = [];
    if (def.description)    parts.push(def.description);
    if (def.formula)        parts.push(`Formula: ${def.formulaDisplay || def.formula}`);
    if (def.unit)           parts.push(`Unit: ${def.unit}`);
    if (!parts.length)      return '';
    return ` data-tooltip="${parts.join(' | ').replace(/"/g, '&quot;')}"`;
}

// ─── Section builder ──────────────────────────────────────────────────────────

function buildSection(title, rows) {
    if (!rows.length) return '';
    const titleHtml = title
        ? `<h3 class="ad-section-title">${title}</h3>`
        : '';
    const rowsHtml = rows.map(r => r).join('');
    return `${titleHtml}<div class="ad-grid">${rowsHtml}</div>`;
}

function attrRow(label, displayValue, unit, tooltipDef, extra) {
    const tip   = tooltipAttrs(tooltipDef);
    const badge = unit ? `<span class="ad-unit">${unit}</span>` : '';
    const cls   = extra ? ` ad-row--${extra}` : '';
    return `
        <div class="ad-row${cls}"${tip}>
            <div class="ad-label">${label}</div>
            <div class="ad-value">${displayValue}${badge}</div>
        </div>`;
}

// ─── Derived stats calculator ─────────────────────────────────────────────────

function calcDerivedStats(item) {
    // Merge base attributes with summed outfit contributions
    const base    = item.attributes || {};
    const outfits = item.outfitMap  || {};

    // Sum outfit attribute values by looking up each outfit's contributions.
    // Since we only have outfit names + counts here (not full outfit data),
    // we derive from the ship's known totals which are already in attributes.
    const a = attr => parseFloat(base[attr] ?? 0);

    const mass   = a('mass');
    const drag   = a('drag');
    const thrust = a('thrust') || 0;
    const turn   = a('turn')   || 0;

    const results = [];

    // Max speed
    if (thrust && drag) {
        const v = thrust / drag;
        const def = getDeriveDef('maxSpeed');
        results.push({ label: 'Max Speed', value: fmtNum(v), unit: 'px/s', def });
    }

    // Acceleration
    if (thrust && mass) {
        const acc = 3600 * thrust / mass;
        const def = getDeriveDef('acceleration');
        results.push({ label: 'Acceleration', value: fmtNum(acc), unit: 'px/s²', def });
    }

    // Turn rate
    if (turn && mass) {
        const tr = 60 * turn / mass;
        const def = getDeriveDef('turnRate');
        results.push({ label: 'Turn Rate', value: fmtNum(tr), unit: '°/s', def });
    }

    // Heat capacity
    if (mass) {
        const hc  = 100 * mass;
        const def = getDeriveDef('heatCapacity');
        results.push({ label: 'Heat Capacity', value: fmtNum(hc), unit: 'heat', def });
    }

    // Disabled hull threshold
    const hull = a('hull');
    if (hull) {
        const thresh = hull * Math.max(0.15, Math.min(0.45, 10 / Math.sqrt(hull)));
        const def = getDeriveDef('disabledHullThreshold');
        results.push({ label: 'Disabled at Hull', value: fmtNum(thresh), unit: 'hull', def });
    }

    // Ramscoop
    const ramscoop = a('ramscoop');
    if (ramscoop) {
        const rate = 0.03 * Math.sqrt(ramscoop);
        const def  = getDeriveDef('ramscoopFuelPerSecond');
        results.push({ label: 'Ramscoop Fuel/s', value: fmtNum(rate), unit: 'fuel/s', def });
    }

    // Scan ranges
    for (const [attr, label, defKey] of [
        ['cargo scan power',    'Cargo Scan Range',    'cargoScanRange'],
        ['outfit scan power',   'Outfit Scan Range',   'outfitScanRange'],
        ['tactical scan power', 'Tactical Scan Range', 'tacticalScanRange'],
        ['asteroid scan power', 'Asteroid Scan Range', 'asteroidScanRange'],
    ]) {
        const v = a(attr);
        if (v) {
            results.push({ label, value: fmtNum(100 * Math.sqrt(v)), unit: 'px', def: getDeriveDef(defKey) });
        }
    }

    // Scan evasion
    const si = a('scan interference');
    if (si) {
        const evasion = (si / (1 + si) * 100).toFixed(1);
        results.push({ label: 'Scan Evasion', value: evasion, unit: '%', def: getDeriveDef('scanEvasion') });
    }

    return results;
}

// ─── Derived weapon stats ─────────────────────────────────────────────────────

function calcWeaponDerived(weapon) {
    if (!weapon) return [];
    const results = [];

    const reload   = parseFloat(weapon.reload   ?? 1);
    const velocity = parseFloat(weapon.velocity ?? 0);
    const lifetime = parseFloat(weapon.lifetime ?? 0);

    // Range
    if (velocity && lifetime) {
        results.push({ label: 'Range', value: fmtNum(velocity * lifetime), unit: 'px', def: getDeriveDef('weaponRange') });
    }

    // DPS figures
    if (weapon['shield damage'] && reload) {
        const dps = (weapon['shield damage'] / reload * 60);
        results.push({ label: 'Shield DPS', value: fmtNum(dps), unit: '/s', def: getDeriveDef('shieldDPS') });
    }
    if (weapon['hull damage'] && reload) {
        const dps = (weapon['hull damage'] / reload * 60);
        results.push({ label: 'Hull DPS', value: fmtNum(dps), unit: '/s', def: getDeriveDef('hullDPS') });
    }

    // Shots per second
    if (reload) {
        results.push({ label: 'Fire Rate', value: fmtNum(60 / reload), unit: 'shots/s', def: null });
    }

    // Anti-missile intercept vs strength-1 missile
    if (weapon['anti-missile']) {
        const am = weapon['anti-missile'];
        const ms = weapon['missile strength'] ?? 1;
        const chance = (am / (am + ms) * 100).toFixed(1);
        results.push({ label: 'Intercept Chance', value: chance, unit: `% vs str ${ms}`, def: getDeriveDef('antiMissileChance') });
    }

    return results;
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function renderAttributesTabEnhanced(item) {
    const defs = _attrDefs || { outfitAttributes: {}, derivedStats: {} };
    let html = '';

    // ── Ships & Variants ──────────────────────────────────────────────────────
    if (window.currentTab === 'ships' || window.currentTab === 'variants') {

        if (window.currentTab === 'variants' && item.baseShip) {
            html += `<p class="ad-base-ship">Base Ship: <strong>${item.baseShip}</strong></p>`;
        }

        // Group attributes by section using defs, with an "Other" catch-all
        const sections = {};
        const attrs    = item.attributes || {};

        for (const [key, value] of Object.entries(attrs)) {
            if (typeof value === 'object') continue;
            const def     = getAttrDef(key);
            const section = def?.section || 'General';
            if (!sections[section]) sections[section] = [];

            const displayVal = def?.multiplier
                ? fmtNum(value * def.multiplier)
                : fmtNum(value);
            const unit = def?.unit || '';
            sections[section].push(attrRow(def?.label || key, displayVal, unit, def));
        }

        // Licenses as a special case (object value)
        if (attrs.licenses && typeof attrs.licenses === 'object') {
            const licNames = Object.keys(attrs.licenses).join(', ');
            if (!sections['General']) sections['General'] = [];
            sections['General'].unshift(attrRow('Licenses', licNames, '', null));
        }

        // Output sections in a logical order
        const sectionOrder = [
            'General', 'Shields & Hull', 'Energy', 'Engines',
            'Jump', 'Cargo', 'Crew', 'Scanning', 'Cloaking',
            'Resistance', 'Protection', 'Other'
        ];
        const allSectionKeys = [...new Set([...sectionOrder, ...Object.keys(sections)])];

        for (const s of allSectionKeys) {
            if (sections[s]?.length) {
                html += buildSection(s, sections[s]);
            }
        }

        // Hardpoints
        const hpRows = [];
        if (item.guns?.length)           hpRows.push(attrRow('Guns',    item.guns.length,    '', null));
        if (item.turrets?.length)         hpRows.push(attrRow('Turrets', item.turrets.length, '', null));
        if (item.engines?.length)         hpRows.push(attrRow('Engines', item.engines.length, '', null));
        if (item.reverseEngines?.length)  hpRows.push(attrRow('Reverse Engines', item.reverseEngines.length, '', null));
        if (item.steeringEngines?.length) hpRows.push(attrRow('Steering Engines', item.steeringEngines.length, '', null));
        if (item.bays?.length) {
            const byType = {};
            item.bays.forEach(b => { byType[b.type] = (byType[b.type] || 0) + 1; });
            Object.entries(byType).forEach(([t, n]) => hpRows.push(attrRow(`${t} Bays`, n, '', null)));
        }
        if (hpRows.length) html += buildSection('Hardpoints', hpRows);

        // Outfits summary
        if (item.outfitMap && Object.keys(item.outfitMap).length) {
            const outfitRows = Object.entries(item.outfitMap)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([name, count]) => attrRow(name, count, count > 1 ? '×' + count : '', null));
            html += buildSection('Outfits', outfitRows);
        }

        // Derived stats
        const derived = calcDerivedStats(item);
        if (derived.length) {
            const rows = derived.map(d =>
                attrRow(d.label, d.value, d.unit, d.def, 'derived')
            );
            html += buildSection('Derived Stats', rows);
        }

    // ── Effects ───────────────────────────────────────────────────────────────
    } else if (window.currentTab === 'effects') {

        const excludeKeys = new Set(['name', 'description', 'sprite', 'spriteData']);
        const rows = [];
        for (const [key, value] of Object.entries(item)) {
            if (excludeKeys.has(key) || typeof value === 'object') continue;
            const def = getAttrDef(key);
            rows.push(attrRow(def?.label || key, fmtNum(value), def?.unit || '', def));
        }
        html += buildSection('', rows);

    // ── Outfits ───────────────────────────────────────────────────────────────
    } else {

        const excludeKeys = new Set([
            'name', 'description', 'thumbnail', 'sprite', 'hardpointSprite',
            'hardpoint sprite', 'steering flare sprite', 'flare sprite',
            'reverse flare sprite', 'afterburner effect', 'projectile',
            'weapon', 'spriteData', '_internalId', '_pluginId', '_hash',
            'governments', '_variantPluginId',
        ]);

        const sections = {};
        for (const [key, value] of Object.entries(item)) {
            if (excludeKeys.has(key) || typeof value === 'object') continue;
            const def     = getAttrDef(key);
            const section = def?.section || 'General';
            if (!sections[section]) sections[section] = [];
            const displayVal = def?.multiplier ? fmtNum(value * def.multiplier) : fmtNum(value);
            sections[section].push(attrRow(def?.label || key, displayVal, def?.unit || '', def));
        }

        // licenses object
        if (item.licenses && typeof item.licenses === 'object') {
            if (!sections['General']) sections['General'] = [];
            sections['General'].unshift(attrRow('Licenses', Object.keys(item.licenses).join(', '), '', null));
        }

        const sectionOrder = [
            'General', 'Shields & Hull', 'Energy', 'Engines',
            'Jump', 'Cargo', 'Crew', 'Scanning', 'Cloaking',
            'Resistance', 'Protection', 'Other'
        ];
        const allSectionKeys = [...new Set([...sectionOrder, ...Object.keys(sections)])];
        for (const s of allSectionKeys) {
            if (sections[s]?.length) html += buildSection(s, sections[s]);
        }

        // Weapon sub-block
        if (item.weapon) {
            const weaponExclude = new Set([
                'sprite', 'spriteData', 'sound', 'hit effect', 'fire effect',
                'die effect', 'submunition', 'stream', 'cluster',
                'hardpoint sprite', 'hardpoint offset',
            ]);
            const wRows = [];
            for (const [key, value] of Object.entries(item.weapon)) {
                if (weaponExclude.has(key) || typeof value === 'object' || Array.isArray(value)) continue;
                const def = _attrDefs?.weaponAttributes?.[key] || getAttrDef(key);
                wRows.push(attrRow(def?.label || key, fmtNum(value), def?.unit || '', def));
            }
            if (wRows.length) html += buildSection('Weapon Stats', wRows);

            // Derived weapon stats
            const wDerived = calcWeaponDerived(item.weapon);
            if (wDerived.length) {
                const rows = wDerived.map(d => attrRow(d.label, d.value, d.unit, d.def, 'derived'));
                html += buildSection('Derived Weapon Stats', rows);
            }
        }

        // Stacking rule note
        if (_attrDefs?.stackingRules) {
            const noteRows = [];
            for (const [key, rule] of Object.entries(_attrDefs.stackingRules)) {
                if (item[key] !== undefined) {
                    noteRows.push(`<div class="ad-stacking-note">
                        <span class="ad-stacking-key">${key}</span>
                        <span class="ad-stacking-rule">${rule.stacking}: ${rule.note}</span>
                    </div>`);
                }
            }
            if (noteRows.length) {
                html += `<div class="ad-stacking-section">
                    <h3 class="ad-section-title">Stacking Notes</h3>
                    ${noteRows.join('')}
                </div>`;
            }
        }
    }

    return html;
}

// ─── Tooltip rendering ────────────────────────────────────────────────────────

function initTooltips() {
    const tooltip = document.createElement('div');
    tooltip.id = 'ad-tooltip';
    tooltip.style.cssText = `
        position: fixed;
        z-index: 9999;
        max-width: 320px;
        padding: 10px 14px;
        background: rgba(15,23,42,0.97);
        border: 1px solid rgba(99,179,237,0.35);
        border-radius: 8px;
        color: #e2e8f0;
        font-size: 12px;
        line-height: 1.55;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        white-space: pre-wrap;
    `;
    document.body.appendChild(tooltip);

    document.addEventListener('mouseover', e => {
        const target = e.target.closest('[data-tooltip]');
        if (!target) return;
        tooltip.textContent = target.dataset.tooltip.replace(/ \| /g, '\n');
        tooltip.style.opacity = '1';
    });
    document.addEventListener('mousemove', e => {
        const x = Math.min(e.clientX + 16, window.innerWidth  - 340);
        const y = Math.min(e.clientY + 12, window.innerHeight - 120);
        tooltip.style.left = x + 'px';
        tooltip.style.top  = y + 'px';
    });
    document.addEventListener('mouseout', e => {
        if (!e.target.closest('[data-tooltip]')) return;
        tooltip.style.opacity = '0';
    });
}

// ─── CSS injection ────────────────────────────────────────────────────────────

function injectStyles() {
    if (document.getElementById('ad-styles')) return;
    const style = document.createElement('style');
    style.id = 'ad-styles';
    style.textContent = `
        /* ── Section titles ── */
        .ad-section-title {
            color: #63b3ed;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            margin: 20px 0 8px;
            padding-bottom: 5px;
            border-bottom: 1px solid rgba(99,179,237,0.2);
        }

        /* ── Attribute grid ── */
        .ad-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px 12px;
            margin-bottom: 4px;
        }

        /* ── Attribute row ── */
        .ad-row {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            padding: 5px 8px;
            border-radius: 5px;
            background: rgba(30,41,59,0.5);
            cursor: default;
            transition: background 0.15s;
        }
        .ad-row:hover {
            background: rgba(51,65,85,0.7);
        }
        .ad-row[data-tooltip] {
            cursor: help;
        }
        .ad-row[data-tooltip]:hover {
            background: rgba(59,100,150,0.35);
            outline: 1px solid rgba(99,179,237,0.25);
        }

        /* Derived stat rows get a subtle accent */
        .ad-row--derived {
            background: rgba(30,58,90,0.45);
            border-left: 2px solid rgba(99,179,237,0.5);
        }
        .ad-row--derived:hover {
            background: rgba(30,80,120,0.5);
        }

        .ad-label {
            font-size: 12px;
            color: #94a3b8;
            flex: 1;
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-right: 8px;
        }
        .ad-value {
            font-size: 12px;
            color: #e2e8f0;
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
        }
        .ad-unit {
            font-size: 10px;
            color: #64748b;
            margin-left: 3px;
        }

        /* ── Base ship label ── */
        .ad-base-ship {
            color: #93c5fd;
            font-size: 13px;
            margin-bottom: 16px;
        }
        .ad-base-ship strong {
            color: #bfdbfe;
        }

        /* ── Stacking notes ── */
        .ad-stacking-section { margin-top: 12px; }
        .ad-stacking-note {
            display: flex;
            gap: 8px;
            padding: 5px 8px;
            font-size: 11px;
            border-radius: 4px;
            background: rgba(120,90,20,0.2);
            border-left: 2px solid rgba(250,200,50,0.4);
            margin-bottom: 4px;
        }
        .ad-stacking-key  { color: #fde68a; font-weight: 600; white-space: nowrap; }
        .ad-stacking-rule { color: #a3a3a3; }
    `;
    document.head.appendChild(style);
}

// ─── Hook into Plugin_Script.js ───────────────────────────────────────────────

function install() {
    injectStyles();
    initTooltips();

    // Keep a reference to the original in case we need to fall back
    if (typeof window.renderAttributesTab === 'function') {
        window._originalRenderAttributesTab = window.renderAttributesTab;
    }

    // Replace with the enhanced version.
    // attributeDefinitions may not be loaded yet when the first modal opens,
    // so we await it inside the replacement.
    window.renderAttributesTab = function(item) {
        if (!_attrDefs) {
            // Defs not ready yet — fall back to original then patch the DOM
            // once they arrive so the user doesn't see a blank panel.
            const fallback = window._originalRenderAttributesTab
                ? window._originalRenderAttributesTab(item)
                : '<p style="color:#94a3b8">Loading attribute definitions…</p>';

            loadAttrDefs().then(() => {
                const tabContent = document.querySelector('.modal-tab-content[data-tab="attributes"]');
                if (tabContent && tabContent.style.display !== 'none') {
                    tabContent.innerHTML = renderAttributesTabEnhanced(item);
                }
            });

            return fallback;
        }
        return renderAttributesTabEnhanced(item);
    };
}

// ─── Init ─────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
} else {
    install();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

window.AttributeDisplay = {
    loadAttrDefs,
    renderAttributesTabEnhanced,
    calcDerivedStats,
    calcWeaponDerived,
    getAttrDef,
    fmtNum,
};
