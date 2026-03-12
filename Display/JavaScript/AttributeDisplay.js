// AttributeDisplay.js
// Pure renderer — no data fetching, no monkey-patching.
// Plugin_Script.js owns loading attributeDefinitions.json and calls
// window.AttributeDisplay.renderAttributesTabEnhanced(item, attrDefs, currentTab)
// directly from its own renderAttributesTab function.
//
// Exposes:
//   AttributeDisplay.initTooltips()  — call once from Plugin_Script DOMContentLoaded
//   AttributeDisplay.injectStyles()  — call once from Plugin_Script DOMContentLoaded

'use strict';

// ─── Built-in attribute map ───────────────────────────────────────────────────
// Covers every standard ES attribute key with: label, section, multiplier, unit.
// attributeDefinitions.json (if loaded) overrides these — this is the guaranteed fallback.

const BUILTIN_ATTRS = {
    // ── General ──
    'category':                    { label: 'Category',               section: 'General' },
    'cost':                        { label: 'Cost',                    section: 'General',       unit: 'credits' },
    'mass':                        { label: 'Mass',                    section: 'General',       unit: 'tons' },
    'drag':                        { label: 'Drag',                    section: 'General' },
    'heat dissipation':            { label: 'Heat Dissipation',        section: 'General' },
    'gaslining':                   { label: 'Gaslining',               section: 'General' },
    'atmosphere scan':             { label: 'Atmosphere Scan',         section: 'General' },
    'spinal mount':                { label: 'Spinal Mount',            section: 'General' },
    'remnant node':                { label: 'Remnant Node',            section: 'General' },
    'automaton':                   { label: 'Automaton',               section: 'General' },
    'nanobot limit':               { label: 'Nanobot Limit',           section: 'General' },
    'capture attack':              { label: 'Capture Attack',          section: 'General' },
    'capture defense':             { label: 'Capture Defense',         section: 'General' },
    'mass multiplier':             { label: 'Mass Multiplier',         section: 'General' },
    // ── Shields & Hull ──
    'shields':                     { label: 'Shields',                 section: 'Shields & Hull' },
    'hull':                        { label: 'Hull',                    section: 'Shields & Hull' },
    'shield generation':           { label: 'Shield Regen',            section: 'Shields & Hull', multiplier: 60, unit: 'shields/s' },
    'shield energy':               { label: 'Shield Energy',           section: 'Shields & Hull', multiplier: 60, unit: 'energy/s' },
    'shield heat':                 { label: 'Shield Heat',             section: 'Shields & Hull', multiplier: 60, unit: 'heat/s' },
    'shield fuel':                 { label: 'Shield Fuel',             section: 'Shields & Hull', multiplier: 60, unit: 'fuel/s' },
    'shield delay':                { label: 'Shield Delay',            section: 'Shields & Hull', unit: 'frames' },
    'depleted shield delay':       { label: 'Depleted Shield Delay',   section: 'Shields & Hull', unit: 'frames' },
    'hull repair rate':            { label: 'Hull Repair',             section: 'Shields & Hull', multiplier: 60, unit: 'hull/s' },
    'hull energy':                 { label: 'Hull Energy',             section: 'Shields & Hull', multiplier: 60, unit: 'energy/s' },
    'hull heat':                   { label: 'Hull Heat',               section: 'Shields & Hull', multiplier: 60, unit: 'heat/s' },
    'hull fuel':                   { label: 'Hull Fuel',               section: 'Shields & Hull', multiplier: 60, unit: 'fuel/s' },
    'repair delay':                { label: 'Repair Delay',            section: 'Shields & Hull', unit: 'frames' },
    'disabled repair delay':       { label: 'Disabled Repair Delay',   section: 'Shields & Hull', unit: 'frames' },
    // ── Energy ──
    'energy capacity':             { label: 'Energy Capacity',         section: 'Energy',         unit: 'energy' },
    'energy generation':           { label: 'Energy Generation',       section: 'Energy',         multiplier: 60, unit: 'energy/s' },
    'energy consumption':          { label: 'Energy Consumption',      section: 'Energy',         multiplier: 60, unit: 'energy/s' },
    'heat generation':             { label: 'Heat Generation',         section: 'Energy',         multiplier: 60, unit: 'heat/s' },
    'solar collection':            { label: 'Solar Collection',        section: 'Energy',         multiplier: 60, unit: 'energy/s' },
    'solar heat':                  { label: 'Solar Heat',              section: 'Energy',         multiplier: 60, unit: 'heat/s' },
    'fuel capacity':               { label: 'Fuel Capacity',           section: 'Energy',         unit: 'fuel' },
    'ramscoop':                    { label: 'Ramscoop',                section: 'Energy' },
    'cooling':                     { label: 'Cooling',                 section: 'Energy',         multiplier: 60, unit: 'heat/s' },
    'active cooling':              { label: 'Active Cooling',          section: 'Energy',         multiplier: 60, unit: 'heat/s' },
    'cooling energy':              { label: 'Cooling Energy',          section: 'Energy',         multiplier: 60, unit: 'energy/s' },
    'disruption protection':       { label: 'Disruption Protection',   section: 'Energy' },
    // ── Engines ──
    'thrust':                      { label: 'Thrust',                  section: 'Engines' },
    'thrusting energy':            { label: 'Thrusting Energy',        section: 'Engines',        multiplier: 60, unit: 'energy/s' },
    'thrusting heat':              { label: 'Thrusting Heat',          section: 'Engines',        multiplier: 60, unit: 'heat/s' },
    'thrusting shields':           { label: 'Thrusting Shields',       section: 'Engines',        multiplier: 60, unit: 'shields/s' },
    'thrusting hull':              { label: 'Thrusting Hull',          section: 'Engines',        multiplier: 60, unit: 'hull/s' },
    'thrusting fuel':              { label: 'Thrusting Fuel',          section: 'Engines',        multiplier: 60, unit: 'fuel/s' },
    'turn':                        { label: 'Turn',                    section: 'Engines' },
    'turning energy':              { label: 'Turning Energy',          section: 'Engines',        multiplier: 60, unit: 'energy/s' },
    'turning heat':                { label: 'Turning Heat',            section: 'Engines',        multiplier: 60, unit: 'heat/s' },
    'turning shields':             { label: 'Turning Shields',         section: 'Engines',        multiplier: 60, unit: 'shields/s' },
    'turning hull':                { label: 'Turning Hull',            section: 'Engines',        multiplier: 60, unit: 'hull/s' },
    'turning fuel':                { label: 'Turning Fuel',            section: 'Engines',        multiplier: 60, unit: 'fuel/s' },
    'reverse thrust':              { label: 'Reverse Thrust',          section: 'Engines' },
    'reverse thrusting energy':    { label: 'Reverse Energy',          section: 'Engines',        multiplier: 60, unit: 'energy/s' },
    'reverse thrusting heat':      { label: 'Reverse Heat',            section: 'Engines',        multiplier: 60, unit: 'heat/s' },
    'afterburner thrust':          { label: 'Afterburner Thrust',      section: 'Engines' },
    'afterburner energy':          { label: 'Afterburner Energy',      section: 'Engines',        multiplier: 60, unit: 'energy/s' },
    'afterburner heat':            { label: 'Afterburner Heat',        section: 'Engines',        multiplier: 60, unit: 'heat/s' },
    'afterburner fuel':            { label: 'Afterburner Fuel',        section: 'Engines',        multiplier: 60, unit: 'fuel/s' },
    'engine capacity':             { label: 'Engine Capacity',         section: 'Engines' },
    // ── Jump ──
    'jump speed':                  { label: 'Jump Speed',              section: 'Jump' },
    'jump fuel':                   { label: 'Jump Fuel',               section: 'Jump',           unit: 'fuel' },
    'jump range':                  { label: 'Jump Range',              section: 'Jump' },
    'hyperdrive':                  { label: 'Hyperdrive',              section: 'Jump' },
    'scram drive':                 { label: 'Scram Drive',             section: 'Jump' },
    'jump drive':                  { label: 'Jump Drive',              section: 'Jump' },
    // ── Cargo & Space ──
    'cargo space':                 { label: 'Cargo Space',             section: 'Cargo',          unit: 'tons' },
    'outfit space':                { label: 'Outfit Space',            section: 'Cargo' },
    'weapon capacity':             { label: 'Weapon Capacity',         section: 'Cargo' },
    'drone carrying space':        { label: 'Drone Space',             section: 'Cargo' },
    'fighter carrying space':      { label: 'Fighter Space',           section: 'Cargo' },
    'mass reduction':              { label: 'Mass Reduction',          section: 'Cargo',          unit: 'tons' },
    // ── Crew ──
    'required crew':               { label: 'Required Crew',           section: 'Crew' },
    'bunks':                       { label: 'Bunks',                   section: 'Crew' },
    'crew equivalent':             { label: 'Crew Equivalent',         section: 'Crew' },
    'extra mass':                  { label: 'Extra Mass',              section: 'Crew',           unit: 'tons' },
    // ── Scanning ──
    'cargo scan power':            { label: 'Cargo Scan Power',        section: 'Scanning' },
    'cargo scan efficiency':       { label: 'Cargo Scan Efficiency',   section: 'Scanning' },
    'outfit scan power':           { label: 'Outfit Scan Power',       section: 'Scanning' },
    'outfit scan efficiency':      { label: 'Outfit Scan Efficiency',  section: 'Scanning' },
    'tactical scan power':         { label: 'Tactical Scan Power',     section: 'Scanning' },
    'asteroid scan power':         { label: 'Asteroid Scan Power',     section: 'Scanning' },
    'scan interference':           { label: 'Scan Interference',       section: 'Scanning' },
    // ── Cloaking ──
    'cloak':                       { label: 'Cloak',                   section: 'Cloaking' },
    'cloaking energy':             { label: 'Cloaking Energy',         section: 'Cloaking',       multiplier: 60, unit: 'energy/s' },
    'cloaking fuel':               { label: 'Cloaking Fuel',           section: 'Cloaking',       multiplier: 60, unit: 'fuel/s' },
    'cloaking heat':               { label: 'Cloaking Heat',           section: 'Cloaking',       multiplier: 60, unit: 'heat/s' },
    'cloaked shield permeability': { label: 'Cloaked Shield Perm.',    section: 'Cloaking' },
    'cloaked hull permeability':   { label: 'Cloaked Hull Perm.',      section: 'Cloaking' },
    'cloaked communication':       { label: 'Cloaked Comms',           section: 'Cloaking' },
    // ── Resistance ──
    'force protection':            { label: 'Force Protection',        section: 'Resistance' },
    'heat protection':             { label: 'Heat Protection',         section: 'Resistance' },
    'ion resistance':              { label: 'Ion Resistance',          section: 'Resistance' },
    'scramble resistance':         { label: 'Scramble Resistance',     section: 'Resistance' },
    'slowing resistance':          { label: 'Slowing Resistance',      section: 'Resistance' },
    'disruption resistance':       { label: 'Disruption Resistance',   section: 'Resistance' },
    'burn resistance':             { label: 'Burn Resistance',         section: 'Resistance' },
    'corrosion resistance':        { label: 'Corrosion Resistance',    section: 'Resistance' },
    'leak resistance':             { label: 'Leak Resistance',         section: 'Resistance' },
    'discharge resistance':        { label: 'Discharge Resistance',    section: 'Resistance' },
    // ── Protection ──
    'shield protection':           { label: 'Shield Protection',       section: 'Protection' },
    'hull protection':             { label: 'Hull Protection',         section: 'Protection' },
    'fuel protection':             { label: 'Fuel Protection',         section: 'Protection' },
    'energy protection':           { label: 'Energy Protection',       section: 'Protection' },
    'cooling protection':          { label: 'Cooling Protection',      section: 'Protection' },
    'damage reduction':            { label: 'Damage Reduction',        section: 'Protection' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtNum(v) {
    if (v === undefined || v === null) return '—';
    if (typeof v !== 'number') return String(v);
    if (Number.isInteger(v) && Math.abs(v) >= 10000) return v.toLocaleString();
    return parseFloat(v.toPrecision(4)).toString();
}

// attrDefs from JSON takes priority; BUILTIN_ATTRS is the guaranteed fallback
function getAttrDef(attrDefs, key) {
    return attrDefs?.outfitAttributes?.[key]
        || attrDefs?.outfitAttributes?.[key.toLowerCase()]
        || BUILTIN_ATTRS[key]
        || BUILTIN_ATTRS[key.toLowerCase()]
        || null;
}

function getDeriveDef(attrDefs, key) {
    return attrDefs?.derivedStats?.[key] || null;
}

function tooltipAttrs(def) {
    if (!def) return '';
    const parts = [];
    if (def.description)                    parts.push(def.description);
    if (def.formulaDisplay || def.formula)  parts.push(`Formula: ${def.formulaDisplay || def.formula}`);
    if (def.unit)                           parts.push(`Unit: ${def.unit}`);
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
    const shields = a('shields');

    // Movement
    if (thrust && drag)  results.push({ label: 'Max Speed',     value: fmtNum(thrust / drag),        unit: 'px/s',  def: getDeriveDef(attrDefs, 'maxSpeed') });
    if (thrust && mass)  results.push({ label: 'Acceleration',  value: fmtNum(3600 * thrust / mass), unit: 'px/s²', def: getDeriveDef(attrDefs, 'acceleration') });
    if (turn   && mass)  results.push({ label: 'Turn Rate',     value: fmtNum(60 * turn / mass),     unit: '°/s',   def: getDeriveDef(attrDefs, 'turnRate') });

    // Thermal
    if (mass)            results.push({ label: 'Heat Capacity', value: fmtNum(100 * mass),           unit: 'heat',  def: getDeriveDef(attrDefs, 'heatCapacity') });

    // Survival thresholds
    if (hull) {
        const thresh = hull * Math.max(0.15, Math.min(0.45, 10 / Math.sqrt(hull)));
        results.push({ label: 'Disabled at Hull', value: fmtNum(thresh), unit: 'hull', def: getDeriveDef(attrDefs, 'disabledHullThreshold') });
    }

    // Time-to-recharge (raw values are per-frame, ×60 = per-second)
    const shieldRegen = a('shield generation') * 60;
    const hullRepair  = a('hull repair rate')  * 60;
    if (shields && shieldRegen) results.push({ label: 'Time to Full Shields', value: fmtNum(shields / shieldRegen), unit: 's', def: null });
    if (hull    && hullRepair)  results.push({ label: 'Time to Full Hull',    value: fmtNum(hull    / hullRepair),  unit: 's', def: null });

    // Ramscoop
    const ramscoop = a('ramscoop');
    if (ramscoop) results.push({ label: 'Ramscoop Fuel/s', value: fmtNum(0.03 * Math.sqrt(ramscoop)), unit: 'fuel/s', def: getDeriveDef(attrDefs, 'ramscoopFuelPerSecond') });

    // Scan ranges (100 × √power = range in px)
    for (const [attr, label, defKey] of [
        ['cargo scan power',    'Cargo Scan Range',    'cargoScanRange'],
        ['outfit scan power',   'Outfit Scan Range',   'outfitScanRange'],
        ['tactical scan power', 'Tactical Scan Range', 'tacticalScanRange'],
        ['asteroid scan power', 'Asteroid Scan Range', 'asteroidScanRange'],
    ]) {
        const v = a(attr);
        if (v) results.push({ label, value: fmtNum(100 * Math.sqrt(v)), unit: 'px', def: getDeriveDef(attrDefs, defKey) });
    }

    // Scan evasion
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

    if (velocity && lifetime)            results.push({ label: 'Range',           value: fmtNum(velocity * lifetime),                    unit: 'px',      def: getDeriveDef(attrDefs, 'weaponRange') });
    if (weapon['shield damage'])         results.push({ label: 'Shield DPS',      value: fmtNum(weapon['shield damage']     / reload * 60), unit: 'dmg/s', def: getDeriveDef(attrDefs, 'shieldDPS') });
    if (weapon['hull damage'])           results.push({ label: 'Hull DPS',        value: fmtNum(weapon['hull damage']       / reload * 60), unit: 'dmg/s', def: getDeriveDef(attrDefs, 'hullDPS') });
    if (weapon['ion damage'])            results.push({ label: 'Ion DPS',         value: fmtNum(weapon['ion damage']        / reload * 60), unit: 'ion/s', def: null });
    if (weapon['heat damage'])           results.push({ label: 'Heat DPS',        value: fmtNum(weapon['heat damage']       / reload * 60), unit: 'heat/s',def: null });
    if (weapon['fuel damage'])           results.push({ label: 'Fuel DPS',        value: fmtNum(weapon['fuel damage']       / reload * 60), unit: 'fuel/s',def: null });
    if (weapon['disruption damage'])     results.push({ label: 'Disruption DPS',  value: fmtNum(weapon['disruption damage'] / reload * 60), unit: '/s',    def: null });
    if (weapon['slowing damage'])        results.push({ label: 'Slowing DPS',     value: fmtNum(weapon['slowing damage']    / reload * 60), unit: '/s',    def: null });
    if (reload)                          results.push({ label: 'Fire Rate',        value: fmtNum(60 / reload),                              unit: 'shots/s',def: null });
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
            const section = def?.section || 'Other';
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
        if (attrs.licenses && typeof attrs.licenses === 'object') {
            html += buildSection('General', [attrRow('Licenses', Object.keys(attrs.licenses).join(', '), '', null)]);
        }

        html += renderSections(groupBySection(entries));

        // Hardpoints
        const hpRows = [];
        if (item.guns?.length)            hpRows.push(attrRow('Guns',             item.guns.length,            '', null));
        if (item.turrets?.length)         hpRows.push(attrRow('Turrets',          item.turrets.length,         '', null));
        if (item.engines?.length)         hpRows.push(attrRow('Engines',          item.engines.length,         '', null));
        if (item.reverseEngines?.length)  hpRows.push(attrRow('Reverse Engines',  item.reverseEngines.length,  '', null));
        if (item.steeringEngines?.length) hpRows.push(attrRow('Steering Engines', item.steeringEngines.length, '', null));
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
    // Styles are in your CSS file — this is a no-op kept for API compatibility
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
