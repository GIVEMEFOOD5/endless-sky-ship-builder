'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderStats.js  —  Live Stats Panel for Ship Builder
//
//  INTEGRATION
//  ─────────────────────────────────────────────────────────────────────────────
//  1. Add mount point to shipBuilder.html at the bottom of #builder-view
//     (just before the closing </div><!-- /builder-view -->):
//
//         <div id="sbs-panel-mount"></div>
//
//  2. Load AFTER the existing scripts in shipBuilder.html:
//
//         <script src="../JavaScript/weaponStats.js"></script>
//         <script src="../JavaScript/computedStats.js"></script>
//         <script src="../JavaScript/shipBuilderStats.js"></script>
//
//  3. Add ONE call at the very END of the DOMContentLoaded block in
//     shipBuilder.js (after the pluginsChanged / dataLoaded listeners):
//
//         SBS.hookIntoBuilder();
//
//  CSS and HTML mount point are handled externally — this file emits no styles.
// ═══════════════════════════════════════════════════════════════════════════════

const SBS = (() => {
    'use strict';

    const FPS       = 60;
    const MAX_TEMP  = 100; // MAXIMUM_TEMPERATURE in Ship.cpp

    // ─────────────────────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────────────────────

    let _panel      = null;
    let _activeTab  = 'combat';
    let _rafPending = false;
    let _hooked     = false;
    let _keyReg     = null;

    // ─────────────────────────────────────────────────────────────────────────
    //  KEY REGISTRY  — resolved from window.attrDefs, zero hardcoding
    // ─────────────────────────────────────────────────────────────────────────

    function _buildKeyRegistry() {
        const ad = window.attrDefs;
        if (!ad) return null;

        const attrKeys = Object.keys(ad.attributes || {});

        // Find the first key matching any pattern (case-insensitive exact match)
        const find = (...patterns) => {
            for (const pat of patterns) {
                const lp    = pat.toLowerCase();
                const found = attrKeys.find(k => k.toLowerCase() === lp);
                if (found) return found;
            }
            return patterns[0]; // fallback to literal string
        };

        // Collect every scan-related key from attrDefs automatically
        // so we never miss one added to the game later
        const scanKeys = attrKeys.filter(k => k.toLowerCase().includes('scan'));

        const reg = {
            // ── Mass / inertia / drag ──────────────────────────────────────
            mass:                  find('mass'),
            heatCapacity:          find('heat capacity'),
            inertiaReduction:      find('inertia reduction'),
            drag:                  find('drag'),
            dragReduction:         find('drag reduction'),

            // ── Normal thrust ─────────────────────────────────────────────
            thrust:                find('thrust'),
            thrustEnergy:          find('thrusting energy'),
            thrustHeat:            find('thrusting heat'),
            thrustFuel:            find('thrusting fuel'),

            // ── Reverse thrust ────────────────────────────────────────────
            reverseThrust:         find('reverse thrust'),
            reverseEnergy:         find('reverse thrusting energy'),
            reverseHeat:           find('reverse thrusting heat'),
            reverseFuel:           find('reverse thrusting fuel'),

            // ── Afterburner ───────────────────────────────────────────────
            abThrust:              find('afterburner thrust'),
            abEnergy:              find('afterburner energy'),
            abHeat:                find('afterburner heat'),
            abFuel:                find('afterburner fuel'),
            abShields:             find('afterburner shields'),
            abHull:                find('afterburner hull'),

            // ── Turning ───────────────────────────────────────────────────
            turn:                  find('turn'),
            turnMultiplier:        find('turn multiplier'),
            turningEnergy:         find('turning energy'),
            turningHeat:           find('turning heat'),
            turningFuel:           find('turning fuel'),

            // ── Combat ────────────────────────────────────────────────────
            shields:               find('shields'),
            hull:                  find('hull'),
            shieldGen:             find('shield generation'),
            hullRepair:            find('hull repair rate'),
            shieldEnergy:          find('shield energy'),
            shieldHeat:            find('shield heat'),
            shieldFuel:            find('shield fuel'),
            hullEnergy:            find('hull energy'),
            hullHeat:              find('hull heat'),
            hullFuel:              find('hull fuel'),
            heatDissipation:       find('heat dissipation'),
            cooling:               find('cooling'),
            coolingInefficiency:   find('cooling inefficiency'),
            hullMult:              find('hull multiplier'),
            shieldMult:            find('shield multiplier'),
            shieldGenMult:         find('shield generation multiplier'),
            hullRepairMult:        find('hull repair multiplier'),
            shieldDelay:           find('shield delay'),
            depletedDelay:         find('depleted shield delay'),
            repairDelay:           find('repair delay'),
            disabledRepair:        find('disabled repair rate'),
            thresholdPct:          find('threshold percentage'),
            absoluteThreshold:     find('absolute threshold'),
            piercingResist:        find('piercing resistance'),
            shieldProtection:      find('shield protection'),
            hullProtection:        find('hull protection'),
            energyProtection:      find('energy protection'),
            fuelProtection:        find('fuel protection'),
            heatProtection:        find('heat protection'),
            forceProtection:       find('force protection'),
            piercingProtection:    find('piercing protection'),
            disruptionProtection:  find('disruption protection'),

            // ── Status resistances ────────────────────────────────────────
            ionResist:             find('ion resistance'),
            scrambleResist:        find('scramble resistance'),
            disruptionResist:      find('disruption resistance'),
            slowingResist:         find('slowing resistance'),
            burnResist:            find('burn resistance'),
            dischargeResist:       find('discharge resistance'),
            corrosionResist:       find('corrosion resistance'),
            leakResist:            find('leak resistance'),

            // ── Power ─────────────────────────────────────────────────────
            energyCap:             find('energy capacity'),
            energyGen:             find('energy generation'),
            energyCon:             find('energy consumption'),
            fuelCap:               find('fuel capacity'),
            solarCollection:       find('solar collection'),
            solarHeat:             find('solar heat'),
            ramscoop:              find('ramscoop'),
            fuelGen:               find('fuel generation'),
            fuelCon:               find('fuel consumption'),

            // ── Capacity ──────────────────────────────────────────────────
            outfitSpace:           find('outfit space'),
            engineCap:             find('engine capacity'),
            weaponCap:             find('weapon capacity'),
            cargoSpace:            find('cargo space'),
            gunPorts:              find('gun ports'),
            turretMounts:          find('turret mounts'),

            // ── Crew / misc ───────────────────────────────────────────────
            requiredCrew:          find('required crew'),
            bunks:                 find('bunks'),
            cost:                  find('cost'),
            category:              find('category'),
            crewEquivalent:        find('crew equivalent'),
            extraMass:             find('extra mass'),

            // ── Jump / nav ────────────────────────────────────────────────
            jumpFuel:              find('jump fuel'),
            jumpRange:             find('jump range'),
            jumpFuelMult:          find('jump fuel multiplier'),
            hyperdrive:            find('hyperdrive'),
            jumpDrive:             find('jump drive'),
            scramDrive:            find('scram drive'),

            // ── Cloaking ──────────────────────────────────────────────────
            cloak:                 find('cloak'),
            cloakEnergy:           find('cloaking energy'),
            cloakFuel:             find('cloaking fuel'),
            cloakHeat:             find('cloaking heat'),
            cloakShields:          find('cloaking shields'),
            cloakHull:             find('cloaking hull'),

            // ── Scanning — all keys pulled from attrDefs automatically ────
            // Also keep named refs for the range-formula keys
            scanPowerKeys: scanKeys.filter(k => k.toLowerCase().endsWith('scan power') || k.toLowerCase().endsWith('scan efficiency') || k.toLowerCase() === 'atmosphere scan' || k.toLowerCase().endsWith('scan')),
            scanInterference:      find('scan interference'),
            allScanKeys:           scanKeys,

            // ── Full attrDefs reference ───────────────────────────────────
            attrDefs: ad,
        };

        // ── coveredKeys: everything explicitly shown in named tabs ─────────
        const covered = new Set([
            reg.mass, reg.heatCapacity, reg.inertiaReduction, reg.drag, reg.dragReduction,
            reg.thrust, reg.thrustEnergy, reg.thrustHeat, reg.thrustFuel,
            reg.reverseThrust, reg.reverseEnergy, reg.reverseHeat, reg.reverseFuel,
            reg.abThrust, reg.abEnergy, reg.abHeat, reg.abFuel, reg.abShields, reg.abHull,
            reg.turn, reg.turnMultiplier, reg.turningEnergy, reg.turningHeat, reg.turningFuel,
            reg.shields, reg.hull, reg.shieldGen, reg.hullRepair,
            reg.shieldEnergy, reg.shieldHeat, reg.shieldFuel,
            reg.hullEnergy, reg.hullHeat, reg.hullFuel,
            reg.heatDissipation, reg.cooling, reg.coolingInefficiency,
            reg.hullMult, reg.shieldMult, reg.shieldGenMult, reg.hullRepairMult,
            reg.shieldDelay, reg.depletedDelay, reg.repairDelay, reg.disabledRepair,
            reg.thresholdPct, reg.absoluteThreshold,
            reg.piercingResist,
            reg.shieldProtection, reg.hullProtection, reg.energyProtection,
            reg.fuelProtection, reg.heatProtection, reg.forceProtection,
            reg.piercingProtection, reg.disruptionProtection,
            reg.ionResist, reg.scrambleResist, reg.disruptionResist, reg.slowingResist,
            reg.burnResist, reg.dischargeResist, reg.corrosionResist, reg.leakResist,
            reg.energyCap, reg.energyGen, reg.energyCon,
            reg.fuelCap, reg.solarCollection, reg.solarHeat, reg.ramscoop,
            reg.fuelGen, reg.fuelCon,
            reg.outfitSpace, reg.engineCap, reg.weaponCap, reg.cargoSpace,
            reg.gunPorts, reg.turretMounts,
            reg.requiredCrew, reg.bunks, reg.cost, reg.category,
            reg.crewEquivalent, reg.extraMass,
            reg.jumpFuel, reg.jumpRange, reg.jumpFuelMult,
            reg.hyperdrive, reg.jumpDrive, reg.scramDrive,
            reg.cloak, reg.cloakEnergy, reg.cloakFuel, reg.cloakHeat,
            reg.cloakShields, reg.cloakHull,
            reg.scanInterference,
            ...scanKeys,
        ]);

        // Cover all status effect descriptor keys
        for (const desc of (ad.weapon?.statusEffectDecay?.descriptors || [])) {
            covered.add(desc.damageKey);
            covered.add(desc.resistKey);
            covered.add(desc.protectionKey);
            for (const ck of (desc.costKeys || [])) covered.add(ck);
        }

        reg.coveredKeys = covered;
        return reg;
    }

    function _keys() {
        if (!_keyReg && window.attrDefs) _keyReg = _buildKeyRegistry();
        return _keyReg;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HOOK INTO BUILDER
    // ─────────────────────────────────────────────────────────────────────────

    function hookIntoBuilder() {
        if (_hooked) return;
        _hooked = true;

        const TARGETS = [
            'sbUpdateAttrVal', 'sbRemoveAttr', 'confirmAddAttr',
            'sbUpdateOutfitCount', 'sbRemoveOutfit',
            'sbAddOutfitFromPicker', 'confirmAddOutfit',
            'sbRemoveHP', 'addGunTurret', 'sbUpdateHP',
            'sbUpdateWeaponField',
            'sbUpdateExplode', 'sbRemoveExplode',
            'sbAddEffectFromPicker', 'sbUpdateLeak', 'sbRemoveLeak',
            'onBuilderChange',
            'importRaw', 'sbPickShip', 'sbEditFleetShip',
            'newShip', 'openOutfitExisting', 'openEditExisting',
        ];

        for (const fnName of TARGETS) {
            if (typeof window[fnName] !== 'function') continue;
            const orig = window[fnName];
            window[fnName] = function (...args) {
                const result = orig.apply(this, args);
                requestAnimationFrame(() => refresh());
                return result;
            };
        }

        document.addEventListener('input', e => {
            const id = e.target?.id;
            if (id === 'ship-name' || id === 'ship-variant' || id === 'ship-plural')
                requestAnimationFrame(() => refresh());
        });

        console.log('[SBS] Hooked into builder.');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  REFRESH
    // ─────────────────────────────────────────────────────────────────────────

    function refresh() {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => {
            _rafPending = false;
            if (!_keyReg && window.attrDefs) _keyReg = _buildKeyRegistry();
            if (!_panel) _mount();
            if (!_panel) return;
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            const builderHidden = document.getElementById('builder-view')?.classList.contains('hidden');
            if (!ship || builderHidden) return;
            if (typeof ComputedStats !== 'undefined') ComputedStats.clearCache();
            _renderContent(ship);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  OUTFIT INDEX
    // ─────────────────────────────────────────────────────────────────────────

    function _buildOutfitIndex() {
        const allData   = window.allData || {};
        const sbOutfits = (typeof sbAllOutfits !== 'undefined') ? sbAllOutfits : [];
        const merged    = {};
        for (const o of [
            ...Object.values(allData).flatMap(p => p?.outfits || []),
            ...sbOutfits,
        ]) {
            const name = (o.name || o.displayName || '').replace(/^"|"$/g, '').trim();
            if (!name || name in merged) continue;
            const flat = { ...o };
            if (o.attributes && typeof o.attributes === 'object')
                for (const [k, v] of Object.entries(o.attributes))
                    if (!(k in flat)) flat[k] = v;
            flat.name = name;
            merged[name] = flat;
        }
        return merged;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  EFFECTIVE ATTRIBUTES  — base ship attrs + all outfit contributions
    // ─────────────────────────────────────────────────────────────────────────

    const _META = new Set([
        'name','category','series','index','cost','thumbnail','sprite',
        'description','pluginId','weapon','governments','locations',
        '_internalId','_pluginId','_hash','_pn','_pd','_isVariant',
        'displayName','spriteData','attributes',
    ]);

    function _buildEffectiveAttrs(ship, outfitIdx) {
        const eff = {};
        for (const [k, v] of Object.entries(ship.attributes || {})) {
            if (typeof v === 'number') eff[k] = v;
            else if (typeof v === 'string') { const n = parseFloat(v); if (!isNaN(n)) eff[k] = n; }
        }
        if (ship.mass && ship.mass !== '') eff['mass'] = parseFloat(ship.mass) || 0;
        if (ship.drag && ship.drag !== '') eff['drag'] = parseFloat(ship.drag) || 0;

        for (const entry of (ship.outfits || [])) {
            const name  = (entry.name || '').replace(/^"|"$/g, '').trim();
            const count = parseInt(entry.count) || 1;
            const o = outfitIdx[name];
            if (!o) continue;
            for (const [key, rawVal] of Object.entries(o)) {
                if (_META.has(key) || key.startsWith('_')) continue;
                if (typeof rawVal !== 'number' || rawVal === 0) continue;
                eff[key] = (eff[key] || 0) + rawVal * count;
            }
        }
        return eff;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PHYSICS ENGINE
    // ─────────────────────────────────────────────────────────────────────────

    function _physics(eff, k) {
        const a = key => { if (!key) return 0; const v = eff[key]; return (typeof v === 'number' && isFinite(v)) ? v : 0; };

        const mass         = a(k.mass);
        const heatCap      = a(k.heatCapacity);
        const maxHeat      = MAX_TEMP * (mass + heatCap);

        const inertiaRed   = a(k.inertiaReduction);
        const inertialMass = mass > 0 ? mass / (1 + inertiaRed) : 0;

        const dragRaw      = a(k.drag);
        const dragRed      = a(k.dragReduction);
        const effectiveDrag = inertialMass > 0
            ? Math.min(dragRaw / (1 + dragRed), inertialMass)
            : Math.max(0, dragRaw / (1 + dragRed));

        const turnForce    = a(k.turn);
        const turnMult     = a(k.turnMultiplier);
        const turnRateDeg  = inertialMass > 0
            ? (turnForce / inertialMass) * (1 + turnMult) * FPS : 0;
        const timeFor180   = turnRateDeg > 0 ? 180 / turnRateDeg : null;

        function _mode(thrustForce) {
            const maxVel   = effectiveDrag > 0 ? (thrustForce / effectiveDrag) * FPS    : 0;
            const accel    = inertialMass  > 0 ? (thrustForce / inertialMass)  * FPS * FPS : 0;
            const stopDist = effectiveDrag > 0 && maxVel > 0
                ? (maxVel / FPS) * (inertialMass / effectiveDrag) * FPS : 0;
            const ttMaxVel = effectiveDrag > 0 && inertialMass > 0
                ? (inertialMass / effectiveDrag) / FPS : null;
            return { maxVel, accel, stopDist, ttMaxVel };
        }

        const thrustOnly = a(k.thrust);
        const abOnly     = a(k.abThrust);
        const combined   = thrustOnly + abOnly;
        const revThrust  = a(k.reverseThrust);

        const costs = {
            thrust:  { energy: a(k.thrustEnergy)  * FPS, heat: a(k.thrustHeat)  * FPS, fuel: a(k.thrustFuel)  * FPS },
            ab:      { energy: a(k.abEnergy)       * FPS, heat: a(k.abHeat)      * FPS, fuel: a(k.abFuel)      * FPS, shields: a(k.abShields) * FPS, hull: a(k.abHull) * FPS },
            turning: { energy: a(k.turningEnergy)  * FPS, heat: a(k.turningHeat) * FPS, fuel: a(k.turningFuel) * FPS },
            reverse: { energy: a(k.reverseEnergy)  * FPS, heat: a(k.reverseHeat) * FPS, fuel: a(k.reverseFuel) * FPS },
        };
        const costsCombined = {
            energy:  costs.thrust.energy  + costs.ab.energy,
            heat:    costs.thrust.heat    + costs.ab.heat,
            fuel:    costs.thrust.fuel    + costs.ab.fuel,
            shields: costs.ab.shields,
            hull:    costs.ab.hull,
        };

        return {
            mass, heatCap, maxHeat,
            inertiaRed, inertialMass,
            dragRaw, dragRed, effectiveDrag,
            turnForce, turnMult, turnRateDeg, timeFor180,
            thrustOnly: thrustOnly > 0 ? _mode(thrustOnly) : null,
            abOnly:     abOnly     > 0 ? _mode(abOnly)     : null,
            combined:   combined   > 0 ? _mode(combined)   : null,
            reverse:    revThrust  > 0 ? _mode(revThrust)  : null,
            hasThrustOnly: thrustOnly > 0,
            hasAb:         abOnly     > 0,
            costs, costsCombined,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  WEAPON STATS
    // ─────────────────────────────────────────────────────────────────────────

    function _computeWeaponStats(ship, outfitIdx) {
        if (typeof WeaponStats === 'undefined') return null;
        try {
            const outfitMap = {};
            for (const entry of (ship.outfits || [])) {
                const name  = (entry.name || '').replace(/^"|"$/g, '').trim();
                const count = parseInt(entry.count) || 1;
                if (name) outfitMap[name] = (outfitMap[name] || 0) + count;
            }
            return WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx);
        } catch (e) { console.warn('[SBS] WeaponStats error:', e); return null; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  DOM MOUNT  — emits only the panel structure, no <style> tag
    // ─────────────────────────────────────────────────────────────────────────

    function _mount() {
        const mount = document.getElementById('sbs-panel-mount');
        if (!mount) { console.warn('[SBS] Mount point #sbs-panel-mount not found.'); return; }

        const tabDefs = [
            { id: 'combat',   label: '🛡 Combat'  },
            { id: 'movement', label: '🚀 Movement' },
            { id: 'power',    label: '⚡ Power'    },
            { id: 'weapons',  label: '🔫 Weapons'  },
            { id: 'crew',     label: '👤 Misc'     },
            { id: 'other',    label: '📋 Other'    },
        ];

        mount.innerHTML = `
<div id="sbs-root" class="sbs-root">
    <div class="sbs-header">
        <span class="sbs-title">📊 Live Ship Stats</span>
        <div class="sbs-tabs">${tabDefs.map(t =>
            `<button class="sbs-tab${t.id === _activeTab ? ' sbs-tab--active' : ''}" data-sbs-tab="${t.id}">${t.label}</button>`
        ).join('')}</div>
        <button class="sbs-collapse-btn" id="sbs-collapse-btn" title="Toggle stats panel">▲</button>
    </div>
    <div class="sbs-body" id="sbs-body">
        <div id="sbs-content" class="sbs-content">
            <div class="sbs-empty">Add attributes or outfits to see live stats.</div>
        </div>
    </div>
</div>`;

        _panel = document.getElementById('sbs-root');

        _panel.querySelectorAll('.sbs-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                _activeTab = btn.dataset.sbsTab;
                _panel.querySelectorAll('.sbs-tab').forEach(b => b.classList.remove('sbs-tab--active'));
                btn.classList.add('sbs-tab--active');
                refresh();
            });
        });

        document.getElementById('sbs-collapse-btn').addEventListener('click', () => {
            const body = document.getElementById('sbs-body');
            const btn  = document.getElementById('sbs-collapse-btn');
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? '' : 'none';
            btn.textContent    = isHidden ? '▲' : '▼';
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  RENDER DISPATCH
    // ─────────────────────────────────────────────────────────────────────────

    function _renderContent(ship) {
        const el = document.getElementById('sbs-content');
        if (!el) return;

        const k         = _keys();
        const outfitIdx = _buildOutfitIndex();
        const eff       = _buildEffectiveAttrs(ship, outfitIdx);
        const phys      = k ? _physics(eff, k) : null;
        const wData     = _computeWeaponStats(ship, outfitIdx);

        let html = '';
        switch (_activeTab) {
            case 'combat':   html = _tabCombat(eff, k, phys);        break;
            case 'movement': html = _tabMovement(eff, k, phys);      break;
            case 'power':    html = _tabPower(eff, k, phys);         break;
            case 'weapons':  html = _tabWeapons(wData, eff, k);      break;
            case 'crew':     html = _tabCrew(eff, k);                break;
            case 'other':    html = _tabOther(eff, k, ship);         break;
        }

        el.innerHTML = html || `<div class="sbs-empty">No data available.</div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  VALUE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    function _get(eff, key) {
        if (!key) return null;
        const v = parseFloat(eff[key] ?? '');
        return (!isNaN(v) && v !== 0) ? v : null;
    }

    function _fmt(v, dp) {
        if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '—';
        if (typeof v !== 'number') return String(v);
        if (dp !== undefined) return v.toFixed(dp);
        if (Number.isInteger(v) && Math.abs(v) >= 1000) return v.toLocaleString();
        return parseFloat(v.toPrecision(4)).toString();
    }

    function _pct(v) {
        if (v === null || v === undefined || isNaN(v)) return null;
        return (v * 100).toFixed(1) + '%';
    }

    function _coloured(v, positiveIsGood) {
        if (v === null || v === undefined || isNaN(v)) return '—';
        const color = (positiveIsGood ? v >= 0 : v <= 0) ? 'var(--sbs-pos)' : 'var(--sbs-neg)';
        return `<span style="color:${color};font-weight:700">${_fmt(v)}</span>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HTML HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    function _card(label, value, unit, highlight) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && (isNaN(value) || value === 0)) return '';
        const cls     = highlight ? ' sbs-card--hi' : '';
        const unitTag = unit ? `<span class="sbs-unit">${_esc(unit)}</span>` : '';
        const fmtVal  = typeof value === 'string' ? value : _fmt(value);
        return `<div class="sbs-card${cls}"><div class="sbs-label">${_esc(label)}</div><div class="sbs-value">${fmtVal}${unitTag}</div></div>`;
    }

    function _section(title, content) {
        if (!content || !content.trim()) return '';
        return `<div class="sbs-section"><div class="sbs-section-title">${_esc(title)}</div><div class="sbs-cards">${content}</div></div>`;
    }

    function _tableSection(title, tableHtml) {
        if (!tableHtml) return '';
        return `<div class="sbs-section"><div class="sbs-section-title">${_esc(title)}</div><div class="sbs-table-wrap">${tableHtml}</div></div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: COMBAT
    // ─────────────────────────────────────────────────────────────────────────

    function _tabCombat(eff, k, phys) {
        if (!k) return _noAttrDefs();

        const shieldMult  = _get(eff, k.shieldMult);
        const hullMult    = _get(eff, k.hullMult);
        const baseShields = _get(eff, k.shields);
        const baseHull    = _get(eff, k.hull);
        const effShields  = baseShields != null ? baseShields * (1 + (shieldMult ?? 0)) : null;
        const effHull     = baseHull    != null ? baseHull    * (1 + (hullMult    ?? 0)) : null;

        const shGenMult   = _get(eff, k.shieldGenMult);
        const hrMult      = _get(eff, k.hullRepairMult);
        const shGenRaw    = _get(eff, k.shieldGen);
        const hrRaw       = _get(eff, k.hullRepair);
        const shRegen     = shGenRaw != null ? (shGenRaw * FPS) * (1 + (shGenMult ?? 0)) : null;
        const hullRepair  = hrRaw    != null ? (hrRaw    * FPS) * (1 + (hrMult    ?? 0)) : null;
        const ttfSh       = (effShields && shRegen)  ? effShields  / shRegen   : null;
        const ttfHull     = (effHull    && hullRepair)? effHull     / hullRepair : null;

        const maxHeat     = phys?.maxHeat ?? null;
        const heatDiss    = _get(eff, k.heatDissipation);
        const cooling     = _get(eff, k.cooling) != null ? _get(eff, k.cooling) * FPS : null;
        const coolIneff   = _get(eff, k.coolingInefficiency);

        const shEnergy    = _get(eff, k.shieldEnergy) != null ? _get(eff, k.shieldEnergy) * FPS : null;
        const shHeat      = _get(eff, k.shieldHeat)   != null ? _get(eff, k.shieldHeat)   * FPS : null;
        const shFuel      = _get(eff, k.shieldFuel)   != null ? _get(eff, k.shieldFuel)   * FPS : null;
        const hlEnergy    = _get(eff, k.hullEnergy)   != null ? _get(eff, k.hullEnergy)   * FPS : null;
        const hlHeat      = _get(eff, k.hullHeat)     != null ? _get(eff, k.hullHeat)     * FPS : null;
        const hlFuel      = _get(eff, k.hullFuel)     != null ? _get(eff, k.hullFuel)     * FPS : null;

        const threshPct   = _get(eff, k.thresholdPct);
        const absThresh   = _get(eff, k.absoluteThreshold);
        const minHullPct  = threshPct != null && effHull != null ? effHull * threshPct : null;

        // Protections — explicit pairs
        const protPairs = [
            [k.shieldProtection,     'Shield Prot.'],
            [k.hullProtection,       'Hull Prot.'],
            [k.energyProtection,     'Energy Prot.'],
            [k.fuelProtection,       'Fuel Prot.'],
            [k.heatProtection,       'Heat Prot.'],
            [k.forceProtection,      'Force Prot.'],
            [k.piercingProtection,   'Piercing Prot.'],
            [k.disruptionProtection, 'Disruption Prot.'],
            [k.piercingResist,       'Piercing Resist'],
        ];
        // Status protections from descriptors
        const statusProtPairs = [];
        for (const desc of (k.attrDefs?.weapon?.statusEffectDecay?.descriptors || []))
            if (desc.protectionKey) statusProtPairs.push([desc.protectionKey, desc.label + ' Prot.']);

        const resistPairs = [
            [k.ionResist,        'Ion'],
            [k.scrambleResist,   'Scramble'],
            [k.disruptionResist, 'Disruption'],
            [k.slowingResist,    'Slowing'],
            [k.burnResist,       'Burn'],
            [k.dischargeResist,  'Discharge'],
            [k.corrosionResist,  'Corrosion'],
            [k.leakResist,       'Leak'],
        ];

        let hpCards = '';
        hpCards += _card('Shields',      effShields,  'hp', !!effShields);
        hpCards += _card('Hull',         effHull,     'hp', !!effHull);
        if (shieldMult) hpCards += _card('Shield ×',  1 + shieldMult, '');
        if (hullMult)   hpCards += _card('Hull ×',    1 + hullMult,   '');

        let regenCards = '';
        regenCards += _card('Shield Regen',    shRegen,    '/s');
        regenCards += _card('Hull Repair',     hullRepair, '/s');
        if (shGenMult) regenCards += _card('Shield Gen ×',  1 + shGenMult, '');
        if (hrMult)    regenCards += _card('Hull Repair ×', 1 + hrMult,    '');
        if (ttfSh   != null) regenCards += _card('TTF Shields',     ttfSh,   's');
        if (ttfHull != null) regenCards += _card('TTF Hull',        ttfHull, 's');
        if (shEnergy) regenCards += _card('Shield Energy/s', shEnergy, '/s');
        if (shHeat)   regenCards += _card('Shield Heat/s',   shHeat,   '/s');
        if (shFuel)   regenCards += _card('Shield Fuel/s',   shFuel,   '/s');
        if (hlEnergy) regenCards += _card('Hull Energy/s',   hlEnergy, '/s');
        if (hlHeat)   regenCards += _card('Hull Heat/s',     hlHeat,   '/s');
        if (hlFuel)   regenCards += _card('Hull Fuel/s',     hlFuel,   '/s');

        let heatCards = '';
        if (maxHeat)   heatCards += _card('Max Heat',            maxHeat,   '',   true);
        if (heatDiss)  heatCards += _card('Heat Dissipation',    heatDiss,  '');
        if (cooling)   heatCards += _card('Cooling/s',           cooling,   '/s');
        if (coolIneff) heatCards += _card('Cool. Inefficiency',  coolIneff, '');

        let threshCards = '';
        if (threshPct)  threshCards += _card('Threshold %',       _pct(threshPct), '');
        if (minHullPct) threshCards += _card('Min Hull (calc)',    minHullPct,      'hp');
        if (absThresh)  threshCards += _card('Absolute Threshold', absThresh,       'hp');

        let delayCards = '';
        const shDelay  = _get(eff, k.shieldDelay);
        const depDelay = _get(eff, k.depletedDelay);
        const repDelay = _get(eff, k.repairDelay);
        const disRep   = _get(eff, k.disabledRepair);
        if (shDelay)  delayCards += _card('Shield Delay',    shDelay,  's');
        if (depDelay) delayCards += _card('Depleted Delay',  depDelay, 's');
        if (repDelay) delayCards += _card('Repair Delay',    repDelay, 's');
        if (disRep)   delayCards += _card('Disabled Repair', disRep,   '/s');

        let protCards = '';
        for (const [key, label] of [...protPairs, ...statusProtPairs]) {
            const v = _get(eff, key);
            if (v) protCards += _card(label, _pct(v), '');
        }

        let resistCards = '';
        for (const [key, label] of resistPairs) {
            const v = _get(eff, key);
            if (v) resistCards += _card(label + ' Resist', v, '');
        }

        return _section('HP', hpCards)
             + (regenCards  ? _section('Regen & Costs',      regenCards)  : '')
             + (heatCards   ? _section('Heat',               heatCards)   : '')
             + (threshCards ? _section('Hull Thresholds',    threshCards) : '')
             + (delayCards  ? _section('Regen Delays',       delayCards)  : '')
             + (protCards   ? _section('Damage Protections', protCards)   : '')
             + (resistCards ? _section('Status Resistances', resistCards) : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: MOVEMENT
    // ─────────────────────────────────────────────────────────────────────────

    function _tabMovement(eff, k, phys) {
        if (!k || !phys) return _noAttrDefs();

        let baseCards = '';
        baseCards += _card('Mass',           phys.mass,         't',  !!phys.mass);
        baseCards += _card('Heat Capacity',  phys.heatCap || 0, '');
        baseCards += _card('Max Heat',       phys.maxHeat,      '',   !!phys.maxHeat);
        if (phys.inertiaRed) baseCards += _card('Inertia Reduction', _pct(phys.inertiaRed), '');
        baseCards += _card('Inertial Mass',  phys.inertialMass, 't');
        baseCards += _card('Drag',           phys.dragRaw,      '');
        if (phys.dragRed)    baseCards += _card('Drag Reduction',    _pct(phys.dragRed),    '');
        baseCards += _card('Effective Drag', phys.effectiveDrag,'');

        function _modeSection(mode, costs, label) {
            if (!mode) return '';
            let c = '';
            c += _card('Max Velocity',    mode.maxVel,   'px/s', true);
            c += _card('Acceleration',    mode.accel,    'px/s²',true);
            c += _card('Stopping Dist.',  mode.stopDist, 'px');
            if (mode.ttMaxVel != null) c += _card('~63% Vel. Time', mode.ttMaxVel, 's');
            if (costs) {
                if (costs.energy)  c += _card('Energy/s',  costs.energy,  '/s');
                if (costs.heat)    c += _card('Heat/s',    costs.heat,    '/s');
                if (costs.fuel)    c += _card('Fuel/s',    costs.fuel,    '/s');
                if (costs.shields) c += _card('Shields/s', costs.shields, '/s');
                if (costs.hull)    c += _card('Hull/s',    costs.hull,    '/s');
            }
            return _section(label, c);
        }

        let turnCards = '';
        turnCards += _card('Turn Rate',   phys.turnRateDeg, '°/s', !!phys.turnRateDeg);
        if (phys.timeFor180 != null) turnCards += _card('Time for 180°',  phys.timeFor180,             's');
        if (phys.turnMult)           turnCards += _card('Turn ×',         1 + phys.turnMult,            '');
        if (phys.costs.turning.energy) turnCards += _card('Turn Energy/s', phys.costs.turning.energy,  '/s');
        if (phys.costs.turning.heat)   turnCards += _card('Turn Heat/s',   phys.costs.turning.heat,    '/s');
        if (phys.costs.turning.fuel)   turnCards += _card('Turn Fuel/s',   phys.costs.turning.fuel,    '/s');

        let revSection = '';
        if (phys.reverse) {
            let rc = '';
            rc += _card('Rev. Max Vel.',    phys.reverse.maxVel,   'px/s');
            rc += _card('Rev. Accel.',      phys.reverse.accel,    'px/s²');
            rc += _card('Rev. Stop Dist.',  phys.reverse.stopDist, 'px');
            if (phys.reverse.ttMaxVel != null) rc += _card('Rev. ~63% Time', phys.reverse.ttMaxVel, 's');
            if (phys.costs.reverse.energy) rc += _card('Rev. Energy/s', phys.costs.reverse.energy, '/s');
            if (phys.costs.reverse.heat)   rc += _card('Rev. Heat/s',   phys.costs.reverse.heat,   '/s');
            if (phys.costs.reverse.fuel)   rc += _card('Rev. Fuel/s',   phys.costs.reverse.fuel,   '/s');
            revSection = _section('↩ Reverse Thrust', rc);
        }

        return _section('Mass & Drag', baseCards)
             + _modeSection(phys.thrustOnly, phys.costs.thrust, '🔹 Thrust Only')
             + _modeSection(phys.abOnly,     phys.costs.ab,     '🔥 Afterburner Only')
             + _modeSection(phys.combined,
                 (phys.hasThrustOnly && phys.hasAb) ? phys.costsCombined : null,
                 '⚡ Thrust + Afterburner')
             + (turnCards   ? _section('↪ Turning', turnCards) : '')
             + revSection;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: POWER
    // ─────────────────────────────────────────────────────────────────────────

    function _tabPower(eff, k, phys) {
        if (!k) return _noAttrDefs();

        const eCap    = _get(eff, k.energyCap);
        const fCap    = _get(eff, k.fuelCap);
        const eGen    = _get(eff, k.energyGen)       != null ? _get(eff, k.energyGen)       * FPS : null;
        const eCon    = _get(eff, k.energyCon)       != null ? _get(eff, k.energyCon)       * FPS : null;
        const solar   = _get(eff, k.solarCollection) != null ? _get(eff, k.solarCollection) * FPS : null;
        const solHeat = _get(eff, k.solarHeat)       != null ? _get(eff, k.solarHeat)       * FPS : null;
        const ramsco  = _get(eff, k.ramscoop);
        const fuelGen = _get(eff, k.fuelGen)         != null ? _get(eff, k.fuelGen)         * FPS : null;
        const fuelCon = _get(eff, k.fuelCon)         != null ? _get(eff, k.fuelCon)         * FPS : null;
        const eNet    = (eGen !== null || eCon !== null) ? ((eGen ?? 0) - (eCon ?? 0)) : null;
        const fNet    = (fuelGen !== null || fuelCon !== null) ? ((fuelGen ?? 0) - (fuelCon ?? 0)) : null;

        const maxHeat   = phys?.maxHeat ?? null;
        const heatDiss  = _get(eff, k.heatDissipation);
        const cooling   = _get(eff, k.cooling)           != null ? _get(eff, k.cooling)  * FPS : null;
        const coolIneff = _get(eff, k.coolingInefficiency);

        const thrustE = phys?.costs.thrust.energy  || null;
        const thrustH = phys?.costs.thrust.heat    || null;
        const turnE   = phys?.costs.turning.energy || null;
        const turnH   = phys?.costs.turning.heat   || null;
        const abE     = phys?.costs.ab.energy      || null;
        const abH     = phys?.costs.ab.heat        || null;
        const shE     = _get(eff, k.shieldEnergy)  != null ? _get(eff, k.shieldEnergy)  * FPS : null;
        const shH     = _get(eff, k.shieldHeat)    != null ? _get(eff, k.shieldHeat)    * FPS : null;
        const hlE     = _get(eff, k.hullEnergy)    != null ? _get(eff, k.hullEnergy)    * FPS : null;
        const hlH     = _get(eff, k.hullHeat)      != null ? _get(eff, k.hullHeat)      * FPS : null;
        const cloakE  = _get(eff, k.cloakEnergy)   != null ? _get(eff, k.cloakEnergy)   * FPS : null;
        const cloakH  = _get(eff, k.cloakHeat)     != null ? _get(eff, k.cloakHeat)     * FPS : null;
        const cloakF  = _get(eff, k.cloakFuel)     != null ? _get(eff, k.cloakFuel)     * FPS : null;

        let energyCards = '';
        energyCards += _card('Energy Cap.',    eCap,   'J',  !!eCap);
        energyCards += _card('Generation',     eGen,   '/s', eGen > 0);
        energyCards += _card('Consumption',    eCon,   '/s');
        energyCards += _card('Solar Collect.', solar,  '/s');
        if (eNet !== null) {
            energyCards += `<div class="sbs-card${eNet >= 0 ? ' sbs-card--hi' : ' sbs-card--warn'}">
<div class="sbs-label">Net Energy/s</div>
<div class="sbs-value">${_coloured(eNet, true)}<span class="sbs-unit">/s</span></div></div>`;
        }

        let fuelCards = '';
        fuelCards += _card('Fuel Cap.',   fCap,    '');
        fuelCards += _card('Ramscoop',    ramsco,  '');
        fuelCards += _card('Fuel Gen./s', fuelGen, '/s');
        fuelCards += _card('Fuel Con./s', fuelCon, '/s');
        if (fNet !== null) {
            fuelCards += `<div class="sbs-card${fNet >= 0 ? ' sbs-card--hi' : ' sbs-card--warn'}">
<div class="sbs-label">Net Fuel/s</div>
<div class="sbs-value">${_coloured(fNet, true)}<span class="sbs-unit">/s</span></div></div>`;
        }

        let heatCards = '';
        if (maxHeat)   heatCards += _card('Max Heat',           maxHeat,   '',   true);
        if (heatDiss)  heatCards += _card('Heat Dissipation',   heatDiss,  '');
        if (cooling)   heatCards += _card('Cooling/s',          cooling,   '/s');
        if (coolIneff) heatCards += _card('Cool. Inefficiency', coolIneff, '');
        if (solHeat)   heatCards += _card('Solar Heat/s',       solHeat,   '/s');

        let costCards = '';
        if (thrustE) costCards += _card('Thrust Energy/s',  thrustE, '/s');
        if (thrustH) costCards += _card('Thrust Heat/s',    thrustH, '/s');
        if (turnE)   costCards += _card('Turning Energy/s', turnE,   '/s');
        if (turnH)   costCards += _card('Turning Heat/s',   turnH,   '/s');
        if (abE)     costCards += _card('AB Energy/s',      abE,     '/s');
        if (abH)     costCards += _card('AB Heat/s',        abH,     '/s');
        if (shE)     costCards += _card('Shield Regen E/s', shE,     '/s');
        if (shH)     costCards += _card('Shield Regen H/s', shH,     '/s');
        if (hlE)     costCards += _card('Hull Repair E/s',  hlE,     '/s');
        if (hlH)     costCards += _card('Hull Repair H/s',  hlH,     '/s');
        if (cloakE)  costCards += _card('Cloak Energy/s',   cloakE,  '/s');
        if (cloakH)  costCards += _card('Cloak Heat/s',     cloakH,  '/s');
        if (cloakF)  costCards += _card('Cloak Fuel/s',     cloakF,  '/s');

        return _section('Energy',          energyCards)
             + (fuelCards.trim()  ? _section('Fuel',             fuelCards)  : '')
             + (heatCards.trim()  ? _section('Heat',             heatCards)  : '')
             + (costCards.trim()  ? _section('Per-Action Costs', costCards)  : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: WEAPONS
    // ─────────────────────────────────────────────────────────────────────────

    function _tabWeapons(wData, eff, k) {
        let capCards = '';
        if (k) {
            const pairs = [
                [k.weaponCap,    'Weapon Cap.'],
                [k.engineCap,    'Engine Cap.'],
                [k.outfitSpace,  'Outfit Space'],
                [k.gunPorts,     'Gun Ports'],
                [k.turretMounts, 'Turret Mounts'],
            ];
            for (const [key, label] of pairs) {
                const v = _get(eff, key);
                if (v) capCards += _card(label, v, '');
            }
        }
        const capSection = capCards ? _section('Capacity', capCards) : '';

        if (!wData || !wData.weaponCount)
            return capSection + `<div class="sbs-section"><div class="sbs-empty">No weapons installed.</div></div>`;

        let sumCards = '';
        sumCards += _card('Total DPS',    wData.totalDps,          'dps', wData.totalDps  > 0);
        sumCards += _card('Shield DPS',   wData.shieldDps,         'dps', wData.shieldDps > 0);
        sumCards += _card('Hull DPS',     wData.hullDps,           'dps', wData.hullDps   > 0);
        sumCards += _card('Weapon Types', wData.weaponCount,       '');
        sumCards += _card('Total Mounts', wData.totalWeaponMounts, '');

        let typeCards = '';
        for (const [key, val] of Object.entries(wData.dpsByType || {}))
            if (val) typeCards += _card(_capWords(key.replace(/ damage$/, '')) + ' DPS', val, 'dps');

        const rows = (wData.weapons || []).map(w => {
            const range   = w.profile.effectiveRange ? `${_fmt(w.profile.effectiveRange)} px` : '—';
            const badges  = [
                w.profile.isHoming      ? `<span class="sbs-badge sbs-badge--blue">HOMING</span>` : '',
                w.profile.hasAmmo       ? `<span class="sbs-badge sbs-badge--amber">AMMO</span>`  : '',
                w.profile.isAntiMissile ? `<span class="sbs-badge sbs-badge--red">A-M</span>`     : '',
            ].join('');
            const countTag = w.count > 1 ? `<span class="sbs-wt-count">×${w.count}</span>` : '';
            return `<tr>
<td class="sbs-wt-name">${_esc(w.outfitName)} ${countTag}${badges}</td>
<td class="sbs-wt-num">${_fmt(w.profile.shotsPerSecond)}/s</td>
<td class="sbs-wt-num">${range}</td>
<td class="sbs-wt-num sbs-wt-dps">${_fmt(w.scaledDps)}</td></tr>`;
        }).join('');

        const table = `<table class="sbs-table">
<thead><tr>
    <th>Weapon</th>
    <th style="text-align:right">Shots/s</th>
    <th style="text-align:right">Range</th>
    <th style="text-align:right">DPS</th>
</tr></thead>
<tbody>${rows}</tbody></table>`;

        let ammoCards = '';
        if (wData.hasAmmoWeapons)
            for (const a of (wData.ammoRequired || []))
                ammoCards += _card(_esc(a.ammoOutfitName), _fmt(a.totalShotsPerSecond), 'rounds/s');

        return capSection
             + _section('DPS Summary', sumCards)
             + (typeCards ? _section('DPS by Type', typeCards) : '')
             + _tableSection('Installed Weapons', table)
             + (ammoCards ? _section('⚠ Ammo Required', ammoCards) : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: CREW & MISC  (includes scanning)
    // ─────────────────────────────────────────────────────────────────────────

    function _tabCrew(eff, k) {
        if (!k) return _noAttrDefs();

        let mainCards = '';
        mainCards += _card('Required Crew', _get(eff, k.requiredCrew),  '');
        mainCards += _card('Bunks',         _get(eff, k.bunks),         '');
        mainCards += _card('Cargo Space',   _get(eff, k.cargoSpace),    't');
        mainCards += _card('Cost',          _get(eff, k.cost),          'cr');
        mainCards += _card('Crew Equiv.',   _get(eff, k.crewEquivalent),'');
        mainCards += _card('Extra Mass',    _get(eff, k.extraMass),     't');

        let capCards = '';
        capCards += _card('Outfit Space',  _get(eff, k.outfitSpace), '');
        capCards += _card('Engine Cap.',   _get(eff, k.engineCap),   '');
        capCards += _card('Weapon Cap.',   _get(eff, k.weaponCap),   '');
        capCards += _card('Gun Ports',     _get(eff, k.gunPorts),    '');
        capCards += _card('Turret Mounts', _get(eff, k.turretMounts),'');

        // ── Cloaking ──────────────────────────────────────────────────────
        let cloakCards = '';
        const cloakRate = _get(eff, k.cloak);
        if (cloakRate) {
            cloakCards += _card('Cloak Rate',     cloakRate,                     '');
            cloakCards += _card('Time to Cloak',  Math.ceil(1 / cloakRate) / FPS,'s');
            const pairs = [
                [k.cloakEnergy,  'Cloak Energy/s'],
                [k.cloakFuel,    'Cloak Fuel/s'],
                [k.cloakHeat,    'Cloak Heat/s'],
                [k.cloakShields, 'Cloak Shields/s'],
                [k.cloakHull,    'Cloak Hull/s'],
            ];
            for (const [key, label] of pairs) {
                const v = _get(eff, key);
                if (v) cloakCards += _card(label, v * FPS, '/s');
            }
        }

        // ── Navigation ────────────────────────────────────────────────────
        let navCards = '';
        const fCap   = _get(eff, k.fuelCap);
        const jFuel  = _get(eff, k.jumpFuel);
        const jMult  = _get(eff, k.jumpFuelMult);
        const jRange = _get(eff, k.jumpRange);
        const hyp    = _get(eff, k.hyperdrive);
        const jDrive = _get(eff, k.jumpDrive);
        const scram  = _get(eff, k.scramDrive);
        const effJumpFuel = jFuel != null
            ? (jFuel > 0 ? jFuel : 100) * (1 + (jMult ?? 0))
            : null;
        if (hyp)         navCards += _card('Hyperdrive',       hyp,                          '');
        if (jDrive)      navCards += _card('Jump Drive',       jDrive,                       '');
        if (scram)       navCards += _card('Scram Drive',      scram,                        '');
        if (effJumpFuel) navCards += _card('Jump Fuel Cost',   effJumpFuel,                  '');
        if (jRange)      navCards += _card('Jump Range',       jRange,                       '');
        if (effJumpFuel && fCap)
            navCards += _card('Jumps (full tank)', Math.floor(fCap / effJumpFuel), '');

        // ── Scanning — all scan keys from attrDefs ────────────────────────
        // Keys ending in "scan power" → range = 100 * sqrt(value)
        // Keys ending in "scan efficiency" → raw value
        // Keys ending in "scan" (bare) → raw value
        // "atmosphere scan" → raw value
        // "scan interference" → evasion = value / (1 + value) * 100 %
        let scanCards = '';
        const scanInterf = _get(eff, k.scanInterference);
        if (scanInterf) {
            scanCards += _card('Scan Evasion', scanInterf / (1 + scanInterf) * 100, '%');
        }
        for (const scanKey of (k.allScanKeys || []).sort()) {
            if (scanKey === k.scanInterference) continue; // already handled
            const v = _get(eff, scanKey);
            if (v === null) continue;
            const lk = scanKey.toLowerCase();
            const label = _capWords(scanKey);
            if (lk.endsWith('scan power')) {
                // Show the raw power AND the derived range
                scanCards += _card(label,           v,                    '');
                scanCards += _card(label.replace(/Power$/i,'Range'), 100 * Math.sqrt(v), 'px');
            } else {
                // efficiency, bare scan, atmosphere scan etc — show raw
                scanCards += _card(label, v, '');
            }
        }

        return _section('Crew & General', mainCards)
             + (capCards.trim()   ? _section('Capacity',   capCards)   : '')
             + (cloakCards.trim() ? _section('Cloaking',   cloakCards) : '')
             + (navCards.trim()   ? _section('Navigation', navCards)   : '')
             + (scanCards.trim()  ? _section('Scanning',   scanCards)  : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: OTHER
    //
    //  Completely flat — no section titles, no grouping, sorted alphabetically.
    //
    //  Shows:
    //   1. Every raw attr in eff not shown in any other tab (with displayMultiplier
    //      and displayUnit from attrDefs applied)
    //   2. Every computed value from ComputedStats.getComputedStatsForAttrs(eff)
    //      with displayScale from attrDefs.shipFunctions[fnName] applied, and
    //      displayUnit as the unit label
    //   3. Every _derived_* and _sys_* value from the same call
    //   4. String attrs from the base ship not shown elsewhere
    // ─────────────────────────────────────────────────────────────────────────

    function _tabOther(eff, k, ship) {
        if (!k) return _noAttrDefs();

        const attrMeta  = k.attrDefs?.attributes    || {};
        const shipFns   = k.attrDefs?.shipFunctions  || {};
        const entries   = []; // { label, value, unit }

        // ── 1. Raw uncovered attrs ─────────────────────────────────────────
        for (const [key, rawVal] of Object.entries(eff)) {
            if (k.coveredKeys.has(key))    continue;
            if (typeof rawVal !== 'number') continue;
            if (rawVal === 0)              continue;
            if (key.startsWith('_'))       continue;
            const meta  = attrMeta[key] || {};
            const mult  = meta.displayMultiplier ?? 1;
            const unit  = meta.displayUnit        ?? '';
            entries.push({ label: _capWords(key), value: rawVal * mult, unit, sortKey: key });
        }

        // ── 2 & 3. ComputedStats values ────────────────────────────────────
        if (typeof ComputedStats !== 'undefined' && ComputedStats.isReady()) {
            try {
                const cs = ComputedStats.getComputedStatsForAttrs(eff);
                for (const [statKey, rawVal] of Object.entries(cs)) {
                    if (rawVal === null || rawVal === undefined) continue;
                    if (typeof rawVal !== 'number' || isNaN(rawVal) || rawVal === 0) continue;

                    if (statKey.startsWith('_fn_')) {
                        const fnName = statKey.slice(4);
                        const fnData = shipFns[fnName];
                        const scale  = fnData?.displayScale ?? 1;
                        const unit   = fnData?.displayUnit  ?? '';
                        const label  = fnName.replace(/([A-Z])/g, ' $1').trim();
                        entries.push({ label, value: rawVal * scale, unit, sortKey: label.toLowerCase() });

                    } else if (statKey.startsWith('_derived_energy_')) {
                        const label = _capWords(statKey.slice('_derived_energy_'.length).replace(/_/g, ' ')) + ' Energy';
                        entries.push({ label, value: rawVal, unit: '/s', sortKey: label.toLowerCase() });

                    } else if (statKey.startsWith('_derived_heat_')) {
                        const label = _capWords(statKey.slice('_derived_heat_'.length).replace(/_/g, ' ')) + ' Heat';
                        entries.push({ label, value: rawVal, unit: '/s', sortKey: label.toLowerCase() });

                    } else if (statKey.startsWith('_derived_')) {
                        const label = _capWords(statKey.slice('_derived_'.length).replace(/_/g, ' '));
                        entries.push({ label, value: rawVal, unit: '', sortKey: label.toLowerCase() });

                    } else if (statKey.startsWith('_sys_')) {
                        const label = _capWords(statKey.slice('_sys_'.length).replace(/_/g, ' ')) + ' (system)';
                        entries.push({ label, value: rawVal, unit: '', sortKey: label.toLowerCase() });
                    }
                    // ignore _weaponStats, _ws_*, _total*, _outfitMass etc — weapon tab covers them
                }
            } catch (e) {
                console.warn('[SBS] ComputedStats error in Other tab:', e);
            }
        }

        // ── 4. String attrs ────────────────────────────────────────────────
        const strEntries = Object.entries(ship.attributes || {})
            .filter(([key, val]) => typeof val === 'string' && val && !k.coveredKeys.has(key))
            .sort((a, b) => a[0].localeCompare(b[0]));

        if (!entries.length && !strEntries.length)
            return `<div class="sbs-empty">No additional attributes found.</div>`;

        // Sort alphabetically by sortKey, deduplicate by label (prefer computed over raw)
        entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        const seen = new Set();
        let cards = '';
        for (const { label, value, unit } of entries) {
            if (seen.has(label)) continue;
            seen.add(label);
            if (typeof value === 'number' && (isNaN(value) || value === 0)) continue;
            cards += _card(label, value, unit);
        }
        for (const [key, val] of strEntries) {
            cards += `<div class="sbs-card"><div class="sbs-label">${_esc(_capWords(key))}</div><div class="sbs-value" style="font-size:.78rem">${_esc(val)}</div></div>`;
        }

        return `<div class="sbs-cards" style="gap:5px">${cards}</div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  UTILS
    // ─────────────────────────────────────────────────────────────────────────

    function _noAttrDefs() {
        return `<div class="sbs-empty">window.attrDefs not yet loaded — stats will appear once data is ready.</div>`;
    }

    function _capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
    function _capWords(s) { return String(s).split(' ').map(_capFirst).join(' '); }
    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    return { refresh, hookIntoBuilder, _mount };

})();

document.addEventListener('DOMContentLoaded', () => { SBS._mount(); });
