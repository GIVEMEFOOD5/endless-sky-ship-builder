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
// ═══════════════════════════════════════════════════════════════════════════════

const SBS = (() => {
    'use strict';

    const FPS = 60;

    // ─────────────────────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────────────────────

    let _panel      = null;
    let _activeTab  = 'combat';
    let _rafPending = false;
    let _hooked     = false;
    let _keyReg     = null; // resolved once from window.attrDefs

    // ─────────────────────────────────────────────────────────────────────────
    //  KEY REGISTRY
    //
    //  Resolves every attribute key we need from window.attrDefs so nothing is
    //  hardcoded.  Falls back to the canonical Endless Sky strings only when
    //  attrDefs is not yet loaded (will re-resolve on next refresh).
    // ─────────────────────────────────────────────────────────────────────────

    function _buildKeyRegistry() {
        const ad = window.attrDefs;
        if (!ad) return null;

        const attrKeys = Object.keys(ad.attributes || {});

        // Find the first key matching any of the given patterns (case-insensitive)
        const find = (...patterns) => {
            for (const pat of patterns) {
                const lp = pat.toLowerCase();
                const found = attrKeys.find(k => k.toLowerCase() === lp);
                if (found) return found;
            }
            // Fallback: return the first pattern as-is (keeps things working if
            // attrDefs loaded but key not present under that exact casing)
            return patterns[0];
        };

        // Collect every key that is used by any ship function — these are the
        // "known / meaningful" keys and everything else goes into "Other"
        const knownByFns = new Set();
        for (const fnData of Object.values(ad.shipFunctions || {})) {
            for (const k of (fnData.attributesRead || [])) knownByFns.add(k);
        }
        // Also mark keys shown in the outfit display panel as known
        const outfitDisplay = ad.outfitDisplay || {};
        for (const k of Object.keys(outfitDisplay.scaleMap   || {})) knownByFns.add(k);
        for (const k of Object.keys(outfitDisplay.booleanAttributes || {})) knownByFns.add(k);
        for (const { key } of (outfitDisplay.valueNames || [])) knownByFns.add(key);
        for (const k of (outfitDisplay.percentNames  || [])) knownByFns.add(k);
        for (const k of (outfitDisplay.otherNames    || [])) knownByFns.add(k);

        // Status effect keys
        const statusKeys = new Set();
        for (const desc of (ad.weapon?.statusEffectDecay?.descriptors || [])) {
            statusKeys.add(desc.damageKey);
            statusKeys.add(desc.resistKey);
            statusKeys.add(desc.protectionKey);
            for (const ck of (desc.costKeys || [])) statusKeys.add(ck);
        }

        return {
            // ── Mass / inertia / drag ──────────────────────────────────────
            mass:               find('mass'),
            inertiaReduction:   find('inertia reduction'),
            drag:               find('drag'),
            dragReduction:      find('drag reduction'),

            // ── Normal thrust ─────────────────────────────────────────────
            thrust:             find('thrust'),
            thrustEnergy:       find('thrusting energy'),
            thrustHeat:         find('thrusting heat'),
            thrustFuel:         find('thrusting fuel'),

            // ── Reverse thrust ────────────────────────────────────────────
            reverseThrust:      find('reverse thrust'),
            reverseEnergy:      find('reverse thrusting energy'),
            reverseHeat:        find('reverse thrusting heat'),

            // ── Afterburner ───────────────────────────────────────────────
            abThrust:           find('afterburner thrust'),
            abEnergy:           find('afterburner energy'),
            abHeat:             find('afterburner heat'),
            abFuel:             find('afterburner fuel'),
            abShields:          find('afterburner shields'),
            abHull:             find('afterburner hull'),

            // ── Turning ───────────────────────────────────────────────────
            turn:               find('turn'),
            turnMultiplier:     find('turn multiplier'),
            turningEnergy:      find('turning energy'),
            turningHeat:        find('turning heat'),
            turningFuel:        find('turning fuel'),

            // ── Combat / shields / hull ───────────────────────────────────
            shields:            find('shields'),
            hull:               find('hull'),
            shieldGen:          find('shield generation'),
            hullRepair:         find('hull repair rate'),
            heatDissipation:    find('heat dissipation'),
            cooling:            find('cooling'),
            hullMult:           find('hull multiplier'),
            shieldMult:         find('shield multiplier'),
            shieldGenMult:      find('shield generation multiplier'),
            hullRepairMult:     find('hull repair multiplier'),
            shieldDelay:        find('shield delay'),
            depletedDelay:      find('depleted shield delay'),
            repairDelay:        find('repair delay'),
            disabledRepair:     find('disabled repair rate'),

            // ── Power ─────────────────────────────────────────────────────
            energyCap:          find('energy capacity'),
            energyGen:          find('energy generation'),
            energyCon:          find('energy consumption'),
            fuelCap:            find('fuel capacity'),
            solarCollection:    find('solar collection'),
            ramscoop:           find('ramscoop'),
            fuelGen:            find('fuel generation'),
            coolingEff:         find('cooling inefficiency'),

            // ── Capacity ──────────────────────────────────────────────────
            outfitSpace:        find('outfit space'),
            engineCap:          find('engine capacity'),
            weaponCap:          find('weapon capacity'),
            cargoSpace:         find('cargo space'),

            // ── Crew / misc ───────────────────────────────────────────────
            requiredCrew:       find('required crew'),
            bunks:              find('bunks'),
            cost:               find('cost'),
            category:           find('category'),

            // ── Jump / nav ────────────────────────────────────────────────
            jumpFuel:           find('jump fuel'),
            jumpRange:          find('jump range'),
            jumpFuelMult:       find('jump fuel multiplier'),
            hyperdrive:         find('hyperdrive'),
            jumpDrive:          find('jump drive'),
            scramDrive:         find('scram drive'),

            // ── Cloaking ──────────────────────────────────────────────────
            cloak:              find('cloak'),
            cloakEnergy:        find('cloaking energy'),
            cloakFuel:          find('cloaking fuel'),
            cloakHeat:          find('cloaking heat'),

            // ── Status resistances ────────────────────────────────────────
            ionResist:          find('ion resistance'),
            scrambleResist:     find('scramble resistance'),
            disruptionResist:   find('disruption resistance'),
            slowingResist:      find('slowing resistance'),
            burnResist:         find('burn resistance'),
            dischargeResist:    find('discharge resistance'),
            corrosionResist:    find('corrosion resistance'),
            leakResist:         find('leak resistance'),

            // ── Sets for "Other" section ──────────────────────────────────
            // All keys considered "covered" by the explicit tabs
            coveredKeys: new Set([
                // Will be populated after the object is created
            ]),

            // All keys that attrDefs considers meaningful
            knownByFns,
            statusKeys,

            // The full attrDefs attributes map for display multipliers etc.
            attrDefs: ad,
        };
    }

    function _keys() {
        if (!_keyReg) _keyReg = _buildKeyRegistry();
        return _keyReg;
    }

    // Build the "covered" set lazily — everything shown in any non-Other tab
    function _coveredKeys(k) {
        if (k._coveredBuilt) return;
        k._coveredBuilt = true;
        const covered = [
            k.mass, k.inertiaReduction, k.drag, k.dragReduction,
            k.thrust, k.thrustEnergy, k.thrustHeat, k.thrustFuel,
            k.reverseThrust, k.reverseEnergy, k.reverseHeat,
            k.abThrust, k.abEnergy, k.abHeat, k.abFuel, k.abShields, k.abHull,
            k.turn, k.turnMultiplier, k.turningEnergy, k.turningHeat, k.turningFuel,
            k.shields, k.hull, k.shieldGen, k.hullRepair, k.heatDissipation,
            k.cooling, k.hullMult, k.shieldMult, k.shieldGenMult, k.hullRepairMult,
            k.shieldDelay, k.depletedDelay, k.repairDelay, k.disabledRepair,
            k.energyCap, k.energyGen, k.energyCon, k.fuelCap,
            k.solarCollection, k.ramscoop, k.fuelGen, k.coolingEff,
            k.outfitSpace, k.engineCap, k.weaponCap, k.cargoSpace,
            k.requiredCrew, k.bunks, k.cost, k.category,
            k.jumpFuel, k.jumpRange, k.jumpFuelMult,
            k.hyperdrive, k.jumpDrive, k.scramDrive,
            k.cloak, k.cloakEnergy, k.cloakFuel, k.cloakHeat,
            k.ionResist, k.scrambleResist, k.disruptionResist, k.slowingResist,
            k.burnResist, k.dischargeResist, k.corrosionResist, k.leakResist,
        ];
        // Also cover protection/damage keys from status effect descriptors
        for (const desc of (k.attrDefs?.weapon?.statusEffectDecay?.descriptors || [])) {
            covered.push(desc.damageKey, desc.resistKey, desc.protectionKey);
            for (const ck of (desc.costKeys || [])) covered.push(ck);
        }
        for (const key of covered) if (key) k.coveredKeys.add(key);
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
            // Re-resolve key registry if attrDefs loaded since last refresh
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
    //  OUTFIT INDEX  — flattens outfit.attributes to top level
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
            if (o.attributes && typeof o.attributes === 'object') {
                for (const [k, v] of Object.entries(o.attributes))
                    if (!(k in flat)) flat[k] = v;
            }
            flat.name = name;
            merged[name] = flat;
        }
        return merged;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  EFFECTIVE ATTRIBUTES  — base ship + all outfit contributions
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
            else if (typeof v === 'string') {
                const n = parseFloat(v);
                if (!isNaN(n)) eff[k] = n;
            }
        }
        if (ship.mass && ship.mass !== '') eff['mass'] = parseFloat(ship.mass) || 0;
        if (ship.drag && ship.drag !== '') eff['drag'] = parseFloat(ship.drag) || 0;

        for (const entry of (ship.outfits || [])) {
            const name  = (entry.name || '').replace(/^"|"$/g, '').trim();
            const count = parseInt(entry.count) || 1;
            const o = outfitIdx[name];
            if (!o) continue;
            for (const [key, rawVal] of Object.entries(o)) {
                if (_META.has(key))            continue;
                if (key.startsWith('_'))        continue;
                if (typeof rawVal !== 'number') continue;
                if (rawVal === 0)               continue;
                eff[key] = (eff[key] || 0) + rawVal * count;
            }
        }
        return eff;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PHYSICS ENGINE
    //
    //  Three modes — only the thrust source changes.
    //  Everything else (mass, drag, drag reduction, inertia reduction,
    //  turning) is always included because it always applies.
    //
    //  All per-frame values are multiplied by FPS (60) to give per-second rates.
    //
    //  Max velocity  = thrustForce / effectiveDrag * FPS
    //  Acceleration  = (thrustForce / inertialMass) * FPS²   (px/s per s)
    //  Turn rate     = (turn / inertialMass) * (1 + turnMult) * FPS  (deg/s)
    //  Time for 180° = 180 / turnRate
    //  Stopping dist = (maxVelPerFrame) * (inertialMass / effectiveDrag) * FPS  px
    // ─────────────────────────────────────────────────────────────────────────

    function _physics(eff, k) {
        const a = key => {
            if (!key) return 0;
            const v = eff[key];
            return (typeof v === 'number' && isFinite(v)) ? v : 0;
        };

        // ── Always-on values ──────────────────────────────────────────────
        const mass            = a(k.mass);
        const inertiaRed      = a(k.inertiaReduction);
        const inertialMass    = mass > 0 ? mass / (1 + inertiaRed) : 0;

        const dragRaw         = a(k.drag);
        const dragRed         = a(k.dragReduction);
        const effectiveDrag   = inertialMass > 0
            ? Math.min(dragRaw / (1 + dragRed), inertialMass)
            : Math.max(0, dragRaw / (1 + dragRed));

        const turnForce       = a(k.turn);
        const turnMult        = a(k.turnMultiplier);
        const turnRateDeg     = inertialMass > 0
            ? (turnForce / inertialMass) * (1 + turnMult) * FPS
            : 0;
        const timeFor180      = turnRateDeg > 0 ? 180 / turnRateDeg : null;

        // ── Per-mode thrust calc ──────────────────────────────────────────
        function _calcMode(thrustForce) {
            const maxVel      = effectiveDrag > 0 ? (thrustForce / effectiveDrag) * FPS : 0;
            const accel       = inertialMass  > 0 ? (thrustForce / inertialMass)  * FPS * FPS : 0;
            const stopDist    = effectiveDrag > 0 && maxVel > 0
                ? (maxVel / FPS) * (inertialMass / effectiveDrag) * FPS
                : 0;
            const ttMaxVel    = effectiveDrag > 0 && inertialMass > 0
                ? (inertialMass / effectiveDrag) / FPS
                : null; // time constant τ in seconds (63% of max vel)
            return { maxVel, accel, stopDist, ttMaxVel };
        }

        const thrustOnly = a(k.thrust);
        const abOnly     = a(k.abThrust);
        const combined   = thrustOnly + abOnly;

        // ── Costs per second (per-frame attr × 60) ────────────────────────
        const costs = {
            thrust: {
                energy:  a(k.thrustEnergy)  * FPS,
                heat:    a(k.thrustHeat)    * FPS,
                fuel:    a(k.thrustFuel)    * FPS,
            },
            ab: {
                energy:  a(k.abEnergy)   * FPS,
                heat:    a(k.abHeat)     * FPS,
                fuel:    a(k.abFuel)     * FPS,
                shields: a(k.abShields)  * FPS,
                hull:    a(k.abHull)     * FPS,
            },
            turning: {
                energy:  a(k.turningEnergy) * FPS,
                heat:    a(k.turningHeat)   * FPS,
                fuel:    a(k.turningFuel)   * FPS,
            },
            reverse: {
                energy:  a(k.reverseEnergy) * FPS,
                heat:    a(k.reverseHeat)   * FPS,
            },
        };

        // Combined costs = thrust costs + ab costs (both active at same time)
        const costsCombined = {
            energy:  costs.thrust.energy  + costs.ab.energy,
            heat:    costs.thrust.heat    + costs.ab.heat,
            fuel:    costs.thrust.fuel    + costs.ab.fuel,
            shields: costs.ab.shields,
            hull:    costs.ab.hull,
        };

        const reverseThrust = a(k.reverseThrust);
        const reverseMode   = reverseThrust > 0 ? _calcMode(reverseThrust) : null;

        return {
            mass, inertiaRed, inertialMass,
            dragRaw, dragRed, effectiveDrag,
            turnForce, turnMult, turnRateDeg, timeFor180,
            thrustOnly: thrustOnly > 0 ? _calcMode(thrustOnly) : null,
            abOnly:     abOnly     > 0 ? _calcMode(abOnly)     : null,
            combined:   combined   > 0 ? _calcMode(combined)   : null,
            reverse:    reverseMode,
            costs, costsCombined,
            hasThrustOnly: thrustOnly > 0,
            hasAb:         abOnly     > 0,
            reverseThrust,
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
        } catch (e) {
            console.warn('[SBS] WeaponStats error:', e);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  DOM MOUNT
    // ─────────────────────────────────────────────────────────────────────────

    function _mount() {
        const mount = document.getElementById('sbs-panel-mount');
        if (!mount) {
            console.warn('[SBS] Mount point #sbs-panel-mount not found.');
            return;
        }

        const tabDefs = [
            { id: 'combat',   label: '🛡 Combat'   },
            { id: 'movement', label: '🚀 Movement'  },
            { id: 'power',    label: '⚡ Power'     },
            { id: 'weapons',  label: '🔫 Weapons'   },
            { id: 'crew',     label: '👤 Misc'      },
            { id: 'other',    label: '📋 Other'     },
        ];

        const tabsHtml = tabDefs.map(t =>
            `<button class="sbs-tab${t.id === _activeTab ? ' sbs-tab--active' : ''}" data-sbs-tab="${t.id}">${t.label}</button>`
        ).join('');

        mount.innerHTML = `
<div id="sbs-root" class="sbs-root">
    <div class="sbs-header">
        <span class="sbs-title">📊 Live Ship Stats</span>
        <div class="sbs-tabs">${tabsHtml}</div>
        <button class="sbs-collapse-btn" id="sbs-collapse-btn" title="Toggle stats panel">▲</button>
    </div>
    <div class="sbs-body" id="sbs-body">
        <div id="sbs-content" class="sbs-content">
            <div class="sbs-empty">Add attributes or outfits to see live stats.</div>
        </div>
    </div>
</div>
<style id="sbs-style">${_CSS}</style>`;

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
    //  RENDER
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
            case 'combat':   html = _tabCombat(eff, k);               break;
            case 'movement': html = _tabMovement(eff, k, phys);       break;
            case 'power':    html = _tabPower(eff, k);                 break;
            case 'weapons':  html = _tabWeapons(wData, eff, k);       break;
            case 'crew':     html = _tabCrew(eff, k);                  break;
            case 'other':    html = _tabOther(eff, k, ship);           break;
        }

        el.innerHTML = html || `<div class="sbs-empty">No data available for this section yet.</div>`;
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

    function _coloured(v, positiveIsGood) {
        if (v === null || v === undefined || isNaN(v)) return '—';
        const good  = positiveIsGood ? v >= 0 : v <= 0;
        const color = good ? 'var(--sbs-pos)' : 'var(--sbs-neg)';
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
        return `<div class="sbs-card${cls}">
    <div class="sbs-label">${_esc(label)}</div>
    <div class="sbs-value">${fmtVal}${unitTag}</div>
</div>`;
    }

    function _section(title, content) {
        if (!content || !content.trim()) return '';
        return `<div class="sbs-section">
    <div class="sbs-section-title">${_esc(title)}</div>
    <div class="sbs-cards">${content}</div>
</div>`;
    }

    function _tableSection(title, tableHtml) {
        if (!tableHtml) return '';
        return `<div class="sbs-section">
    <div class="sbs-section-title">${_esc(title)}</div>
    <div class="sbs-table-wrap">${tableHtml}</div>
</div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: COMBAT
    // ─────────────────────────────────────────────────────────────────────────

    function _tabCombat(eff, k) {
        if (!k) return _noAttrDefs();

        // Base values
        const shields     = _get(eff, k.shields);
        const hull        = _get(eff, k.hull);
        const shieldMult  = _get(eff, k.shieldMult);
        const hullMult    = _get(eff, k.hullMult);

        // Apply multipliers for effective values
        const effShields  = shields != null
            ? (shieldMult != null ? shields * (1 + shieldMult) : shields)
            : null;
        const effHull     = hull    != null
            ? (hullMult   != null ? hull    * (1 + hullMult)   : hull)
            : null;

        // Regen (attr is per-frame, multiply ×60 for per-second)
        const shGenRaw    = _get(eff, k.shieldGen);
        const hrRaw       = _get(eff, k.hullRepair);
        const shGenMult   = _get(eff, k.shieldGenMult);
        const hrMult      = _get(eff, k.hullRepairMult);
        const shRegen     = shGenRaw != null
            ? (shGenRaw * FPS) * (1 + (shGenMult ?? 0))
            : null;
        const hullRepair  = hrRaw != null
            ? (hrRaw    * FPS) * (1 + (hrMult    ?? 0))
            : null;

        const heatDiss    = _get(eff, k.heatDissipation);
        const cooling     = _get(eff, k.cooling) != null ? _get(eff, k.cooling) * FPS : null;

        // Time-to-full
        const ttfSh   = (effShields && shRegen)  ? effShields  / shRegen  : null;
        const ttfHull = (effHull    && hullRepair)? effHull     / hullRepair : null;

        let main = '';
        main += _card('Shields',          effShields,  'hp',  !!effShields);
        main += _card('Hull',             effHull,     'hp',  !!effHull);
        main += _card('Shield Regen',     shRegen,     '/s');
        main += _card('Hull Repair',      hullRepair,  '/s');
        main += _card('Heat Dissipation', heatDiss,    '');
        main += _card('Cooling',          cooling,     '/s');
        if (shieldMult) main += _card('Shield ×',     1 + shieldMult, '');
        if (hullMult)   main += _card('Hull ×',       1 + hullMult,   '');
        if (ttfSh   != null) main += _card('TTF Shields', ttfSh,   's');
        if (ttfHull != null) main += _card('TTF Hull',    ttfHull,  's');

        const delayKeys = [
            [k.shieldDelay,   'Shield Delay'],
            [k.depletedDelay, 'Depleted Delay'],
            [k.repairDelay,   'Repair Delay'],
            [k.disabledRepair,'Disabled Repair'],
        ];
        let delayCards = '';
        for (const [key, label] of delayKeys) {
            const v = _get(eff, key);
            if (v) delayCards += _card(label, v, '');
        }

        // Status resistances
        const resistPairs = [
            [k.ionResist,         'Ion'],
            [k.scrambleResist,    'Scramble'],
            [k.disruptionResist,  'Disruption'],
            [k.slowingResist,     'Slowing'],
            [k.burnResist,        'Burn'],
            [k.dischargeResist,   'Discharge'],
            [k.corrosionResist,   'Corrosion'],
            [k.leakResist,        'Leak'],
        ];
        let resistCards = '';
        for (const [key, label] of resistPairs) {
            const v = _get(eff, key);
            if (v) resistCards += _card(label + ' Resist', v, '');
        }

        // Protection values from status effect descriptors
        let protCards = '';
        for (const desc of (k.attrDefs?.weapon?.statusEffectDecay?.descriptors || [])) {
            const v = _get(eff, desc.protectionKey);
            if (v) protCards += _card(
                desc.label + ' Prot.',
                (v * 100).toFixed(1),
                '%'
            );
        }

        return _section('Combat', main)
             + (delayCards  ? _section('Regen Delays',       delayCards)  : '')
             + (resistCards ? _section('Status Resistances', resistCards) : '')
             + (protCards   ? _section('Damage Protections', protCards)   : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: MOVEMENT  — three mode panels + turning + reverse
    // ─────────────────────────────────────────────────────────────────────────

    function _tabMovement(eff, k, phys) {
        if (!k || !phys) return _noAttrDefs();

        // ── Shared base info ──────────────────────────────────────────────
        let baseCards = '';
        baseCards += _card('Mass',           phys.mass,         't',   !!phys.mass);
        if (phys.inertiaRed) {
            baseCards += _card('Inertia Red.',   phys.inertiaRed * 100, '%');
        }
        baseCards += _card('Inertial Mass',  phys.inertialMass, 't');
        baseCards += _card('Drag',           phys.dragRaw,      '');
        if (phys.dragRed) {
            baseCards += _card('Drag Red.',      phys.dragRed * 100,    '%');
        }
        baseCards += _card('Effective Drag', phys.effectiveDrag,'');

        // ── Mode builder ─────────────────────────────────────────────────
        function _modeCards(mode, costObj, label) {
            if (!mode) return '';
            let c = '';
            c += _card('Max Velocity',   mode.maxVel,   'px/s', true);
            c += _card('Acceleration',   mode.accel,    'px/s²',true);
            c += _card('Stopping Dist.', mode.stopDist, 'px');
            if (mode.ttMaxVel != null)
                c += _card('~63% Vel Time', mode.ttMaxVel, 's');
            // Costs
            if (costObj) {
                if (costObj.energy)  c += _card('Energy/s',  costObj.energy,  '/s');
                if (costObj.heat)    c += _card('Heat/s',    costObj.heat,    '/s');
                if (costObj.fuel)    c += _card('Fuel/s',    costObj.fuel,    '/s');
                if (costObj.shields) c += _card('Shields/s', costObj.shields, '/s');
                if (costObj.hull)    c += _card('Hull/s',    costObj.hull,    '/s');
            }
            return _section(label, c);
        }

        // ── Turning ───────────────────────────────────────────────────────
        let turnCards = '';
        turnCards += _card('Turn Rate',   phys.turnRateDeg,  '°/s', !!phys.turnRateDeg);
        if (phys.timeFor180 != null)
            turnCards += _card('Time 180°', phys.timeFor180, 's');
        if (phys.turnMult)
            turnCards += _card('Turn ×', 1 + phys.turnMult, '');
        if (phys.costs.turning.energy) turnCards += _card('Turn Energy/s', phys.costs.turning.energy, '/s');
        if (phys.costs.turning.heat)   turnCards += _card('Turn Heat/s',   phys.costs.turning.heat,   '/s');
        if (phys.costs.turning.fuel)   turnCards += _card('Turn Fuel/s',   phys.costs.turning.fuel,   '/s');

        // Build the three thrust modes
        // Thrust only: uses thrust costs
        const thrustSection = _modeCards(
            phys.thrustOnly,
            phys.hasThrustOnly ? phys.costs.thrust : null,
            '🔹 Thrust Only'
        );

        // AB only: uses ab costs
        const abSection = _modeCards(
            phys.abOnly,
            phys.hasAb ? phys.costs.ab : null,
            '🔥 Afterburner Only'
        );

        // Combined: uses combined costs
        const combinedSection = _modeCards(
            phys.combined,
            (phys.hasThrustOnly && phys.hasAb) ? phys.costsCombined : null,
            '⚡ Thrust + Afterburner'
        );

        // Reverse thrust
        let reverseSection = '';
        if (phys.reverse) {
            let rc = '';
            rc += _card('Rev. Max Vel.',  phys.reverse.maxVel,   'px/s');
            rc += _card('Rev. Accel.',    phys.reverse.accel,    'px/s²');
            rc += _card('Rev. Stop Dist.',phys.reverse.stopDist, 'px');
            if (phys.costs.reverse.energy) rc += _card('Rev. Energy/s', phys.costs.reverse.energy, '/s');
            if (phys.costs.reverse.heat)   rc += _card('Rev. Heat/s',   phys.costs.reverse.heat,   '/s');
            reverseSection = _section('↩ Reverse Thrust', rc);
        }

        return _section('Mass & Drag', baseCards)
             + thrustSection
             + abSection
             + combinedSection
             + _section('↪ Turning', turnCards)
             + reverseSection;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: POWER
    // ─────────────────────────────────────────────────────────────────────────

    function _tabPower(eff, k) {
        if (!k) return _noAttrDefs();

        const eCap    = _get(eff, k.energyCap);
        const fCap    = _get(eff, k.fuelCap);
        const eGen    = _get(eff, k.energyGen)  != null ? _get(eff, k.energyGen)  * FPS : null;
        const eCon    = _get(eff, k.energyCon)  != null ? _get(eff, k.energyCon)  * FPS : null;
        const solar   = _get(eff, k.solarCollection) != null ? _get(eff, k.solarCollection) * FPS : null;
        const ramsco  = _get(eff, k.ramscoop);
        const fuelGen = _get(eff, k.fuelGen)    != null ? _get(eff, k.fuelGen)    * FPS : null;
        const eNet    = (eGen !== null || eCon !== null) ? ((eGen ?? 0) - (eCon ?? 0)) : null;

        let main = '';
        main += _card('Energy Cap.',     eCap,   'J',   !!eCap);
        main += _card('Generation',      eGen,   '/s',  eGen > 0);
        main += _card('Consumption',     eCon,   '/s');
        if (eNet !== null) {
            main += `<div class="sbs-card${eNet >= 0 ? ' sbs-card--hi' : ' sbs-card--warn'}">
    <div class="sbs-label">Net Energy/s</div>
    <div class="sbs-value">${_coloured(eNet, true)}<span class="sbs-unit">/s</span></div>
</div>`;
        }
        main += _card('Fuel Cap.',       fCap,   '');
        main += _card('Solar Collect.',  solar,  '/s');
        main += _card('Ramscoop',        ramsco, '');
        main += _card('Fuel Gen.',       fuelGen,'/s');

        return _section('Power', main);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: WEAPONS
    // ─────────────────────────────────────────────────────────────────────────

    function _tabWeapons(wData, eff, k) {
        let capCards = '';
        if (k) {
            const wCap = _get(eff, k.weaponCap);
            const eCap = _get(eff, k.engineCap);
            const oCap = _get(eff, k.outfitSpace);
            if (wCap) capCards += _card('Weapon Cap.',  wCap, '');
            if (eCap) capCards += _card('Engine Cap.',  eCap, '');
            if (oCap) capCards += _card('Outfit Space', oCap, '');
        }
        const capSection = capCards ? _section('Capacity', capCards) : '';

        if (!wData || !wData.weaponCount) {
            return capSection + `<div class="sbs-section"><div class="sbs-empty">No weapons installed.</div></div>`;
        }

        let sumCards = '';
        sumCards += _card('Total DPS',    wData.totalDps,          'dps', wData.totalDps  > 0);
        sumCards += _card('Shield DPS',   wData.shieldDps,         'dps', wData.shieldDps > 0);
        sumCards += _card('Hull DPS',     wData.hullDps,           'dps', wData.hullDps   > 0);
        sumCards += _card('Weapon Types', wData.weaponCount,       '');
        sumCards += _card('Total Mounts', wData.totalWeaponMounts, '');

        let typeCards = '';
        for (const [key, val] of Object.entries(wData.dpsByType || {})) {
            if (!val) continue;
            typeCards += _card(_capWords(key.replace(/ damage$/, '')) + ' DPS', val, 'dps');
        }

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
    <td class="sbs-wt-num sbs-wt-dps">${_fmt(w.scaledDps)}</td>
</tr>`;
        }).join('');

        const table = `<table class="sbs-table">
    <thead><tr>
        <th>Weapon</th>
        <th style="text-align:right">Shots/s</th>
        <th style="text-align:right">Range</th>
        <th style="text-align:right">DPS</th>
    </tr></thead>
    <tbody>${rows}</tbody>
</table>`;

        let ammoCards = '';
        if (wData.hasAmmoWeapons) {
            for (const a of (wData.ammoRequired || []))
                ammoCards += _card(_esc(a.ammoOutfitName), _fmt(a.totalShotsPerSecond), 'rounds/s');
        }

        return capSection
             + _section('DPS Summary', sumCards)
             + (typeCards ? _section('DPS by Type', typeCards) : '')
             + _tableSection('Installed Weapons', table)
             + (ammoCards ? _section('⚠ Ammo Required', ammoCards) : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: CREW & MISC
    // ─────────────────────────────────────────────────────────────────────────

    function _tabCrew(eff, k) {
        if (!k) return _noAttrDefs();

        let main = '';
        main += _card('Required Crew', _get(eff, k.requiredCrew), '');
        main += _card('Bunks',         _get(eff, k.bunks),        '');
        main += _card('Cargo Space',   _get(eff, k.cargoSpace),   't');
        main += _card('Fuel Cap.',     _get(eff, k.fuelCap),      '');
        main += _card('Cost',          _get(eff, k.cost),         'cr');

        let cloakCards = '';
        const cloakRate = _get(eff, k.cloak);
        if (cloakRate) {
            const cloakTime = Math.ceil(1 / cloakRate) / FPS;
            cloakCards += _card('Cloak Rate',    cloakRate,              '');
            cloakCards += _card('Time to Cloak', cloakTime,              's');
            const ce = _get(eff, k.cloakEnergy);
            const cf = _get(eff, k.cloakFuel);
            const ch = _get(eff, k.cloakHeat);
            if (ce) cloakCards += _card('Cloak Energy/s', ce * FPS, '/s');
            if (cf) cloakCards += _card('Cloak Fuel/s',   cf * FPS, '/s');
            if (ch) cloakCards += _card('Cloak Heat/s',   ch * FPS, '/s');
        }

        let navCards = '';
        const hyp    = _get(eff, k.hyperdrive);
        const jDrive = _get(eff, k.jumpDrive);
        const scram  = _get(eff, k.scramDrive);
        const jFuel  = _get(eff, k.jumpFuel);
        const jRange = _get(eff, k.jumpRange);
        const fCap   = _get(eff, k.fuelCap);
        if (hyp)    navCards += _card('Hyperdrive',  hyp,    '');
        if (jDrive) navCards += _card('Jump Drive',  jDrive, '');
        if (scram)  navCards += _card('Scram Drive', scram,  '');
        if (jFuel)  navCards += _card('Jump Fuel',   jFuel,  '');
        if (jRange) navCards += _card('Jump Range',  jRange, '');
        if (jFuel && fCap) navCards += _card('Jumps (full tank)', Math.floor(fCap / jFuel), '');

        return _section('Crew & General', main)
             + (cloakCards ? _section('Cloaking',   cloakCards) : '')
             + (navCards   ? _section('Navigation', navCards)   : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TAB: OTHER
    //
    //  Shows every attribute on the effective ship that isn't already shown in
    //  the other tabs.  Uses window.attrDefs for display multipliers / units.
    // ─────────────────────────────────────────────────────────────────────────

    function _tabOther(eff, k, ship) {
        if (!k) return _noAttrDefs();

        _coveredKeys(k);

        const ad        = k.attrDefs || {};
        const attrMeta  = ad.attributes || {};

        // Collect all keys in effective attrs that aren't covered
        const rows = [];
        for (const [key, rawVal] of Object.entries(eff)) {
            if (k.coveredKeys.has(key))   continue;
            if (typeof rawVal !== 'number') continue;
            if (rawVal === 0)              continue;
            if (key.startsWith('_'))       continue;

            const meta  = attrMeta[key] || {};
            const mult  = meta.displayMultiplier ?? 1;
            const unit  = meta.displayUnit        ?? '';
            const disp  = rawVal * mult;

            rows.push({ key, disp, unit, meta });
        }

        // Also show the ship's own category, sprite etc. (string attrs)
        const strRows = [];
        for (const [key, val] of Object.entries(ship.attributes || {})) {
            if (typeof val !== 'string' || !val) continue;
            if (k.coveredKeys.has(key)) continue;
            strRows.push({ key, val });
        }

        if (!rows.length && !strRows.length) {
            return `<div class="sbs-empty">No additional attributes found.</div>`;
        }

        // Group by section using attrDefs.usedInShipFunctions or raw key patterns
        const grouped = {};
        for (const row of rows) {
            // Rough grouping by key pattern
            const grp = _otherGroup(row.key, row.meta);
            if (!grouped[grp]) grouped[grp] = [];
            grouped[grp].push(row);
        }

        let html = '';
        for (const [grp, grpRows] of Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]))) {
            let cards = '';
            for (const { key, disp, unit } of grpRows.sort((a, b) => a.key.localeCompare(b.key))) {
                cards += _card(_capWords(key), disp, unit);
            }
            html += _section(grp, cards);
        }

        // String attributes
        if (strRows.length) {
            const strCards = strRows.map(({ key, val }) =>
                `<div class="sbs-card">
    <div class="sbs-label">${_esc(_capWords(key))}</div>
    <div class="sbs-value" style="font-size:0.78rem">${_esc(val)}</div>
</div>`
            ).join('');
            html += _section('Text Attributes', strCards);
        }

        return html;
    }

    function _otherGroup(key, meta) {
        const k = key.toLowerCase();
        if (meta?.isStatusEffect || meta?.isStatusResistance || meta?.isStatusProtection ||
            meta?.isStatusResistanceCost) return 'Status Effects';
        if (/damage|weapon|gun|turret|missile|torpedo|blast|piercing|firing/.test(k)) return 'Weapons';
        if (/shield|hull|repair/.test(k)) return 'Combat';
        if (/energy|heat|cooling|solar|fuel|ramscoop/.test(k)) return 'Power';
        if (/thrust|turn|drag|mass|velocity|speed|accel|reverse|afterburner/.test(k)) return 'Movement';
        if (/outfit|cargo|capacity|space|mount|port|bay/.test(k)) return 'Capacity';
        if (/crew|bunk|capture|automaton/.test(k)) return 'Crew';
        if (/scan|stealth|cloak/.test(k)) return 'Stealth & Scan';
        if (/jump|hyperdrive|nav|warp|scram/.test(k)) return 'Navigation';
        if (/resist|protection/.test(k)) return 'Resistances';
        if (meta?.isMultiplier) return 'Multipliers';
        return 'Other';
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  FALLBACK when attrDefs not loaded
    // ─────────────────────────────────────────────────────────────────────────

    function _noAttrDefs() {
        return `<div class="sbs-empty">Attribute definitions (window.attrDefs) not yet loaded.<br>Stats will appear once data is ready.</div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  UTILS
    // ─────────────────────────────────────────────────────────────────────────

    function _capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
    function _capWords(s) { return String(s).split(' ').map(_capFirst).join(' '); }
    function _esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CSS
    // ─────────────────────────────────────────────────────────────────────────

    const _CSS = `
#sbs-root {
    --sbs-bg:    #0d1826;
    --sbs-sur:   #162033;
    --sbs-sur2:  #1d2d45;
    --sbs-bdr:   rgba(99,179,237,0.16);
    --sbs-acc:   #63b3ed;
    --sbs-acc2:  #38bdf8;
    --sbs-txt:   #e2e8f0;
    --sbs-mut:   #64748b;
    --sbs-dim:   #3d526b;
    --sbs-pos:   #4ade80;
    --sbs-neg:   #f87171;
    --sbs-r:     8px;
    --sbs-rsm:   5px;
    margin-top: 28px;
    border: 1px solid var(--sbs-bdr);
    border-radius: var(--sbs-r);
    background: var(--sbs-bg);
    overflow: hidden;
    box-shadow: 0 6px 32px rgba(0,0,0,.45), inset 0 1px 0 rgba(99,179,237,.06);
}
#sbs-root .sbs-header {
    display:flex; align-items:center; gap:8px;
    padding:8px 12px;
    background:var(--sbs-sur);
    border-bottom:1px solid var(--sbs-bdr);
    flex-wrap:wrap;
}
#sbs-root .sbs-title {
    font-size:.72rem; font-weight:800; color:var(--sbs-acc);
    text-transform:uppercase; letter-spacing:.12em;
    white-space:nowrap; flex-shrink:0;
}
#sbs-root .sbs-tabs { display:flex; gap:4px; flex-wrap:wrap; flex:1; min-width:0; }
#sbs-root .sbs-tab {
    padding:3px 10px; border-radius:var(--sbs-rsm);
    border:1px solid var(--sbs-bdr); background:transparent;
    color:var(--sbs-mut); font-size:.72rem; font-weight:600;
    cursor:pointer; transition:background .12s,color .12s,border-color .12s;
    white-space:nowrap;
}
#sbs-root .sbs-tab:hover { background:var(--sbs-sur2); color:var(--sbs-txt); border-color:rgba(99,179,237,.5); }
#sbs-root .sbs-tab--active { background:#1d4ed8; color:#fff; border-color:#1d4ed8; }
#sbs-root .sbs-collapse-btn {
    margin-left:auto; padding:2px 8px; border-radius:var(--sbs-rsm);
    border:1px solid var(--sbs-bdr); background:transparent;
    color:var(--sbs-mut); font-size:.7rem; cursor:pointer; flex-shrink:0;
    transition:color .12s,border-color .12s;
}
#sbs-root .sbs-collapse-btn:hover { color:var(--sbs-txt); border-color:var(--sbs-acc); }
#sbs-root .sbs-body {
    padding:14px 14px 18px; max-height:420px; overflow-y:auto;
    scrollbar-width:thin; scrollbar-color:var(--sbs-dim) transparent;
}
#sbs-root .sbs-body::-webkit-scrollbar { width:5px; }
#sbs-root .sbs-body::-webkit-scrollbar-track { background:transparent; }
#sbs-root .sbs-body::-webkit-scrollbar-thumb { background:var(--sbs-dim); border-radius:3px; }
#sbs-root .sbs-content { display:flex; flex-direction:column; gap:16px; }
#sbs-root .sbs-empty {
    color:var(--sbs-mut); font-size:.82rem; font-style:italic;
    padding:14px 0; text-align:center; line-height:1.6;
}
#sbs-root .sbs-section { display:flex; flex-direction:column; gap:7px; }
#sbs-root .sbs-section-title {
    font-size:.63rem; font-weight:700; text-transform:uppercase;
    letter-spacing:.14em; color:var(--sbs-acc);
    border-bottom:1px solid var(--sbs-bdr); padding-bottom:3px;
}
#sbs-root .sbs-cards { display:flex; flex-wrap:wrap; gap:5px; }
#sbs-root .sbs-card {
    display:flex; flex-direction:column;
    background:var(--sbs-sur); border:1px solid var(--sbs-bdr);
    border-radius:var(--sbs-rsm); padding:5px 10px 6px; min-width:80px;
    transition:border-color .12s,background .12s;
}
#sbs-root .sbs-card:hover { border-color:rgba(99,179,237,.4); background:var(--sbs-sur2); }
#sbs-root .sbs-card--hi  { border-color:rgba(99,179,237,.35); background:var(--sbs-sur2); }
#sbs-root .sbs-card--warn{ border-color:rgba(248,113,113,.35); }
#sbs-root .sbs-label {
    font-size:.58rem; font-weight:700; text-transform:uppercase;
    letter-spacing:.07em; color:var(--sbs-mut); margin-bottom:1px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
#sbs-root .sbs-value {
    font-size:.88rem; font-weight:700; color:var(--sbs-txt);
    font-variant-numeric:tabular-nums; white-space:nowrap;
}
#sbs-root .sbs-unit { font-size:.6rem; font-weight:400; color:var(--sbs-mut); margin-left:2px; }
#sbs-root .sbs-table-wrap { overflow-x:auto; }
#sbs-root .sbs-table { width:100%; border-collapse:collapse; font-size:.76rem; }
#sbs-root .sbs-table th {
    color:var(--sbs-mut); font-size:.62rem; text-transform:uppercase;
    letter-spacing:.08em; padding:4px 8px;
    border-bottom:1px solid var(--sbs-bdr); font-weight:700; white-space:nowrap;
}
#sbs-root .sbs-table td {
    padding:5px 8px; color:var(--sbs-txt);
    border-bottom:1px solid rgba(99,179,237,.06); vertical-align:middle;
}
#sbs-root .sbs-table tbody tr:hover td { background:var(--sbs-sur2); }
#sbs-root .sbs-wt-name { font-weight:600; }
#sbs-root .sbs-wt-num  { text-align:right; font-variant-numeric:tabular-nums; color:var(--sbs-mut); }
#sbs-root .sbs-wt-dps  { color:var(--sbs-acc2) !important; font-weight:700; }
#sbs-root .sbs-wt-count{ font-size:.68rem; color:var(--sbs-mut); margin-left:2px; }
#sbs-root .sbs-badge {
    display:inline-block; font-size:.55rem; font-weight:800;
    letter-spacing:.05em; padding:1px 4px; border-radius:3px;
    vertical-align:middle; margin-left:3px; line-height:1.4;
}
#sbs-root .sbs-badge--blue  { background:rgba(59,130,246,.2);  color:#93c5fd; border:1px solid rgba(59,130,246,.35); }
#sbs-root .sbs-badge--amber { background:rgba(251,191,36,.15); color:#fcd34d; border:1px solid rgba(251,191,36,.35); }
#sbs-root .sbs-badge--red   { background:rgba(239,68,68,.15);  color:#fca5a5; border:1px solid rgba(239,68,68,.35); }
`;

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    return { refresh, hookIntoBuilder, _mount };

})();

document.addEventListener('DOMContentLoaded', () => {
    SBS._mount();
});
