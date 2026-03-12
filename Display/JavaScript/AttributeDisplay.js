// AttributeDisplay.js
// Pure renderer — no data fetching, no monkey-patching.
// Plugin_Script.js owns loading attributeDefinitions.json and calls
// window.AttributeDisplay.renderAttributesTabEnhanced(item, attrDefs, currentTab)
// directly from its own renderAttributesTab function.
//
// Also exposes:
//   AttributeDisplay.initTooltips()  — call once from Plugin_Script DOMContentLoaded
//   AttributeDisplay.injectStyles()  — call once from Plugin_Script DOMContentLoaded

'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtNum(v) {
    if (v === undefined || v === null) return '—';
    if (typeof v !== 'number') return String(v);
    if (Number.isInteger(v) && Math.abs(v) >= 10000) return v.toLocaleString();
    return parseFloat(v.toPrecision(4)).toString();
}

function getAttrDef(attrDefs, key) {
    return attrDefs?.outfitAttributes?.[key]
        || attrDefs?.outfitAttributes?.[key.toLowerCase()]
        || null;
}

function getDeriveDef(attrDefs, key) {
    return attrDefs?.derivedStats?.[key] || null;
}

function tooltipAttrs(def) {
    if (!def) return '';
    const parts = [];
    if (def.description)              parts.push(def.description);
    if (def.formulaDisplay || def.formula) parts.push(`Formula: ${def.formulaDisplay || def.formula}`);
    if (def.unit)                     parts.push(`Unit: ${def.unit}`);
    if (!parts.length) return '';
    return ` data-tooltip="${parts.join(' | ').replace(/"/g, '&quot;')}"`;
}

function buildSection(title, rows) {
    if (!rows.length) return '';
    const titleHtml = title ? `<h3 class="ad-section-title">${title}</h3>` : '';
    return `${titleHtml}<div class="ad-grid">${rows.join('')}</div>`;
}

function attrRow(label, displayValue, unit, def, extra) {
    const tip   = tooltipAttrs(def);
    const badge = unit ? `<span class="ad-unit">${unit}</span>` : '';
    const cls   = extra ? ` ad-row--${extra}` : '';
    return `<div class="ad-row${cls}"${tip}>
        <div class="ad-label">${label}</div>
        <div class="ad-value">${displayValue}${badge}</div>
    </div>`;
}

// ─── Derived stat calculators ─────────────────────────────────────────────────

function calcDerivedStats(attrDefs, item) {
    const a = key => parseFloat((item.attributes || {})[key] ?? 0);
    const results = [];

    const mass    = a('mass');
    const drag    = a('drag');
    const thrust  = a('thrust');
    const turn    = a('turn');
    const hull    = a('hull');

    if (thrust && drag)   results.push({ label: 'Max Speed',       value: fmtNum(thrust / drag),                 unit: 'px/s',  def: getDeriveDef(attrDefs, 'maxSpeed') });
    if (thrust && mass)   results.push({ label: 'Acceleration',    value: fmtNum(3600 * thrust / mass),          unit: 'px/s²', def: getDeriveDef(attrDefs, 'acceleration') });
    if (turn   && mass)   results.push({ label: 'Turn Rate',        value: fmtNum(60 * turn / mass),              unit: '°/s',   def: getDeriveDef(attrDefs, 'turnRate') });
    if (mass)             results.push({ label: 'Heat Capacity',    value: fmtNum(100 * mass),                    unit: 'heat',  def: getDeriveDef(attrDefs, 'heatCapacity') });
    if (hull) {
        const thresh = hull * Math.max(0.15, Math.min(0.45, 10 / Math.sqrt(hull)));
        results.push({ label: 'Disabled at Hull', value: fmtNum(thresh), unit: 'hull', def: getDeriveDef(attrDefs, 'disabledHullThreshold') });
    }

    const ramscoop = a('ramscoop');
    if (ramscoop) results.push({ label: 'Ramscoop Fuel/s', value: fmtNum(0.03 * Math.sqrt(ramscoop)), unit: 'fuel/s', def: getDeriveDef(attrDefs, 'ramscoopFuelPerSecond') });

    for (const [attr, label, defKey] of [
        ['cargo scan power',    'Cargo Scan Range',    'cargoScanRange'],
        ['outfit scan power',   'Outfit Scan Range',   'outfitScanRange'],
        ['tactical scan power', 'Tactical Scan Range', 'tacticalScanRange'],
        ['asteroid scan power', 'Asteroid Scan Range', 'asteroidScanRange'],
    ]) {
        const v = a(attr);
        if (v) results.push({ label, value: fmtNum(100 * Math.sqrt(v)), unit: 'px', def: getDeriveDef(attrDefs, defKey) });
    }

    const si = a('scan interference');
    if (si) results.push({ label: 'Scan Evasion', value: (si / (1 + si) * 100).toFixed(1), unit: '%', def: getDeriveDef(attrDefs, 'scanEvasion') });

    return results;
}

function calcWeaponDerived(attrDefs, weapon) {
    if (!weapon) return [];
    const results  = [];
    const reload   = parseFloat(weapon.reload   ?? 1);
    const velocity = parseFloat(weapon.velocity ?? 0);
    const lifetime = parseFloat(weapon.lifetime ?? 0);

    if (velocity && lifetime)          results.push({ label: 'Range',            value: fmtNum(velocity * lifetime),              unit: 'px',     def: getDeriveDef(attrDefs, 'weaponRange') });
    if (weapon['shield damage'])       results.push({ label: 'Shield DPS',       value: fmtNum(weapon['shield damage'] / reload * 60), unit: '/s', def: getDeriveDef(attrDefs, 'shieldDPS') });
    if (weapon['hull damage'])         results.push({ label: 'Hull DPS',         value: fmtNum(weapon['hull damage']   / reload * 60), unit: '/s', def: getDeriveDef(attrDefs, 'hullDPS') });
    if (reload)                        results.push({ label: 'Fire Rate',        value: fmtNum(60 / reload),                       unit: 'shots/s', def: null });
    if (weapon['anti-missile']) {
        const am = weapon['anti-missile'], ms = weapon['missile strength'] ?? 1;
        results.push({ label: 'Intercept Chance', value: (am / (am + ms) * 100).toFixed(1), unit: `% vs str ${ms}`, def: getDeriveDef(attrDefs, 'antiMissileChance') });
    }

    return results;
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function renderAttributesTabEnhanced(item, attrDefs, currentTab) {
    attrDefs = attrDefs || { outfitAttributes: {}, derivedStats: {}, stackingRules: {} };
    let html = '';

    const SECTION_ORDER = ['General', 'Shields & Hull', 'Energy', 'Engines', 'Jump', 'Cargo', 'Crew', 'Scanning', 'Cloaking', 'Resistance', 'Protection', 'Other'];

    function groupBySection(entries) {
        const sections = {};
        for (const { key, value, def } of entries) {
            const section = def?.section || 'General';
            if (!sections[section]) sections[section] = [];
            const displayVal = (def?.multiplier && def.multiplier !== 1)
                ? fmtNum(value * def.multiplier)
                : fmtNum(value);
            sections[section].push(attrRow(def?.label || key, displayVal, def?.unit || '', def));
        }
        return sections;
    }

    function renderSections(sections) {
        let out = '';
        const keys = [...new Set([...SECTION_ORDER, ...Object.keys(sections)])];
        for (const s of keys) {
            if (sections[s]?.length) out += buildSection(s, sections[s]);
        }
        return out;
    }

    // ── Ships & Variants ──────────────────────────────────────────────────────
    if (currentTab === 'ships' || currentTab === 'variants') {
        if (currentTab === 'variants' && item.baseShip) {
            html += `<p class="ad-base-ship">Base Ship: <strong>${item.baseShip}</strong></p>`;
        }

        const attrs   = item.attributes || {};
        const entries = [];
        for (const [key, value] of Object.entries(attrs)) {
            if (typeof value === 'object') continue;
            entries.push({ key, value, def: getAttrDef(attrDefs, key) });
        }
        // licenses special case
        if (attrs.licenses && typeof attrs.licenses === 'object') {
            const licRow = attrRow('Licenses', Object.keys(attrs.licenses).join(', '), '', null);
            html += buildSection('General', [licRow]);
        }

        html += renderSections(groupBySection(entries));

        // Hardpoints
        const hpRows = [];
        if (item.guns?.length)            hpRows.push(attrRow('Guns',            item.guns.length,            '', null));
        if (item.turrets?.length)         hpRows.push(attrRow('Turrets',         item.turrets.length,         '', null));
        if (item.engines?.length)         hpRows.push(attrRow('Engines',         item.engines.length,         '', null));
        if (item.reverseEngines?.length)  hpRows.push(attrRow('Reverse Engines', item.reverseEngines.length,  '', null));
        if (item.steeringEngines?.length) hpRows.push(attrRow('Steering Engines',item.steeringEngines.length, '', null));
        if (item.bays?.length) {
            const byType = {};
            item.bays.forEach(b => { byType[b.type] = (byType[b.type] || 0) + 1; });
            Object.entries(byType).forEach(([t, n]) => hpRows.push(attrRow(`${t} Bays`, n, '', null)));
        }
        if (hpRows.length) html += buildSection('Hardpoints', hpRows);

        // Outfits list
        if (item.outfitMap && Object.keys(item.outfitMap).length) {
            const outfitRows = Object.entries(item.outfitMap)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([name, count]) => attrRow(name, count > 1 ? `×${count}` : '✓', '', null));
            html += buildSection('Outfits', outfitRows);
        }

        // Derived stats
        const derived = calcDerivedStats(attrDefs, item);
        if (derived.length) {
            html += buildSection('Derived Stats', derived.map(d => attrRow(d.label, d.value, d.unit, d.def, 'derived')));
        }

    // ── Effects ───────────────────────────────────────────────────────────────
    } else if (currentTab === 'effects') {
        const excludeKeys = new Set(['name', 'description', 'sprite', 'spriteData']);
        const rows = [];
        for (const [key, value] of Object.entries(item)) {
            if (excludeKeys.has(key) || typeof value === 'object') continue;
            const def = getAttrDef(attrDefs, key);
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

        const entries = [];
        for (const [key, value] of Object.entries(item)) {
            if (excludeKeys.has(key) || typeof value === 'object') continue;
            entries.push({ key, value, def: getAttrDef(attrDefs, key) });
        }
        if (item.licenses && typeof item.licenses === 'object') {
            html += buildSection('General', [attrRow('Licenses', Object.keys(item.licenses).join(', '), '', null)]);
        }

        html += renderSections(groupBySection(entries));

        // Weapon sub-block
        if (item.weapon) {
            const weaponExclude = new Set(['sprite','spriteData','sound','hit effect','fire effect','die effect','submunition','stream','cluster','hardpoint sprite','hardpoint offset']);
            const wRows = [];
            for (const [key, value] of Object.entries(item.weapon)) {
                if (weaponExclude.has(key) || typeof value === 'object' || Array.isArray(value)) continue;
                const def = attrDefs?.weaponAttributes?.[key] || getAttrDef(attrDefs, key);
                wRows.push(attrRow(def?.label || key, fmtNum(value), def?.unit || '', def));
            }
            if (wRows.length) html += buildSection('Weapon Stats', wRows);

            const wDerived = calcWeaponDerived(attrDefs, item.weapon);
            if (wDerived.length) {
                html += buildSection('Derived Weapon Stats', wDerived.map(d => attrRow(d.label, d.value, d.unit, d.def, 'derived')));
            }
        }

        // Stacking notes
        const noteRows = [];
        for (const [key, rule] of Object.entries(attrDefs?.stackingRules || {})) {
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

    return html;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function initTooltips() {
    if (document.getElementById('ad-tooltip')) return;
    const tooltip = document.createElement('div');
    tooltip.id = 'ad-tooltip';
    tooltip.style.cssText = [
        'position:fixed', 'z-index:9999', 'max-width:320px', 'padding:10px 14px',
        'background:rgba(15,23,42,0.97)', 'border:1px solid rgba(99,179,237,0.35)',
        'border-radius:8px', 'color:#e2e8f0', 'font-size:12px', 'line-height:1.55',
        'pointer-events:none', 'opacity:0', 'transition:opacity 0.15s ease',
        'box-shadow:0 8px 32px rgba(0,0,0,0.6)', 'white-space:pre-wrap',
    ].join(';');
    document.body.appendChild(tooltip);

    document.addEventListener('mouseover', e => {
        const t = e.target.closest('[data-tooltip]');
        if (!t) return;
        tooltip.textContent = t.dataset.tooltip.replace(/ \| /g, '\n');
        tooltip.style.opacity = '1';
    });
    document.addEventListener('mousemove', e => {
        tooltip.style.left = Math.min(e.clientX + 16, window.innerWidth  - 340) + 'px';
        tooltip.style.top  = Math.min(e.clientY + 12, window.innerHeight - 120) + 'px';
    });
    document.addEventListener('mouseout', e => {
        if (e.target.closest('[data-tooltip]')) tooltip.style.opacity = '0';
    });
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
    if (document.getElementById('ad-styles')) return;
    const style = document.createElement('style');
    style.id = 'ad-styles';
    style.textContent = `
        .ad-section-title {
            color: #63b3ed; font-size: 11px; font-weight: 700;
            letter-spacing: .12em; text-transform: uppercase;
            margin: 20px 0 8px; padding-bottom: 5px;
            border-bottom: 1px solid rgba(99,179,237,.2);
        }
        .ad-grid {
            display: grid; grid-template-columns: 1fr 1fr;
            gap: 4px 12px; margin-bottom: 4px;
        }
        .ad-row {
            display: flex; justify-content: space-between; align-items: baseline;
            padding: 5px 8px; border-radius: 5px;
            background: rgba(30,41,59,.5); cursor: default;
            transition: background .15s;
        }
        .ad-row:hover                { background: rgba(51,65,85,.7); }
        .ad-row[data-tooltip]        { cursor: help; }
        .ad-row[data-tooltip]:hover  { background: rgba(59,100,150,.35); outline: 1px solid rgba(99,179,237,.25); }
        .ad-row--derived             { background: rgba(30,58,90,.45); border-left: 2px solid rgba(99,179,237,.5); }
        .ad-row--derived:hover       { background: rgba(30,80,120,.5); }
        .ad-label {
            font-size: 12px; color: #94a3b8; flex: 1; min-width: 0;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 8px;
        }
        .ad-value { font-size: 12px; color: #e2e8f0; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .ad-unit  { font-size: 10px; color: #64748b; margin-left: 3px; }
        .ad-base-ship { color: #93c5fd; font-size: 13px; margin-bottom: 16px; }
        .ad-base-ship strong { color: #bfdbfe; }
        .ad-stacking-section { margin-top: 12px; }
        .ad-stacking-note {
            display: flex; gap: 8px; padding: 5px 8px; font-size: 11px;
            border-radius: 4px; background: rgba(120,90,20,.2);
            border-left: 2px solid rgba(250,200,50,.4); margin-bottom: 4px;
        }
        .ad-stacking-key  { color: #fde68a; font-weight: 600; white-space: nowrap; }
        .ad-stacking-rule { color: #a3a3a3; }
    `;
    document.head.appendChild(style);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

window.AttributeDisplay = {
    renderAttributesTabEnhanced,
    calcDerivedStats,
    calcWeaponDerived,
    initTooltips,
    injectStyles,
    fmtNum,
};
