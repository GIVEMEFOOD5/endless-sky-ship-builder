'use strict';

// ─── AttributeSections.js ─────────────────────────────────────────────
//
// SINGLE SOURCE OF TRUTH for grouping attribute keys into display sections.
// Used by CompareDisplay.js, AttributeDisplay.js, and shipBuilderStats.js so
// a given attribute always lands in the same bucket everywhere it's shown.
//
// DESIGN GOAL: minimise invented keyword lists. attrDefs.json (produced by
// attributeParser.js) already encodes most of what we need as real signals
// pulled straight from the Endless Sky C++ source, not guesses:
//
//   • rec.usedInNavFunctions   — this key is read by a ShipJumpNavigation::
//                                 method (Calibrate, JumpFuel, etc). If it's
//                                 populated at all, the key is Jump-domain,
//                                 full stop — no pattern matching needed.
//   • rec.isStatusResistance / isStatusResistanceCost
//                                 — set directly from weapon.statusEffectDecay
//                                 descriptors (resistKey / costKeys).
//   • rec.isProtection / isStatusProtection
//                                 — set directly from weapon.damageTypeDetails
//                                 protectionKey + Outfit.cpp MINIMUM_OVERRIDES.
//   • rec.isWeaponStat          — set from OutfitInfoDisplay's VALUE_NAMES /
//                                 PERCENT_NAMES / OTHER_NAMES tables.
//   • shipDisplay.capacityDisplay
//                                 — the exact 5 capacity keys ShipInfoDisplay
//                                 itself groups together (outfit/weapon/engine
//                                 space, gun ports, turret mounts).
//   • rec.usedInShipFunctions   — the real Ship:: method(s) that read the key.
//                                 A method's own name already encodes its
//                                 subsystem (MaxShields, CloakingSpeed,
//                                 IdleHeat, TurnRate, RequiredCrew, Scan...),
//                                 so we pattern-match the FUNCTION NAME, not
//                                 attribute names — much higher precision,
//                                 and it's one dictionary shared with steps
//                                 below instead of three separate lists.
//
// Only once ALL of the above are exhausted do we fall back to matching the
// SAME small domain dictionary against the attribute's own key name, then
// its tooltip/description (its stated purpose) as a last resort. That
// dictionary is 8 entries, declared once, reused in three places — versus
// ~40 keyword strings hand-copied across three separate files previously.
// ─────────────────────────────────────────────────────────────────────────

window.AttributeSections = (() => {

    // Canonical section list, in display order. Every file should render
    // sections in this order, alphabetising anything not listed here.
    const SECTION_ORDER = [
        'General', 'Shields & Hull', 'Energy', 'Engines', 'Jump',
        'Cargo', 'Crew', 'Scanning', 'Cloaking', 'Resistance', 'Protection',
        'Hardpoints', 'Heat (derived)', 'Weapon DPS', 'Weapon DPS — Efficiency',
        'Ammo Consumption', 'Derived Stats', 'Licenses', 'Other',
    ];

    // ── The one shared domain dictionary ──────────────────────────────────
    // Reused against: (a) usedInShipFunctions entries, (b) the attribute's
    // own key, (c) its tooltip text. Order = priority when multiple tokens
    // could match (checked top to bottom, first hit wins).
    const DOMAIN_WORDS = [
        ['Cloaking',       /cloak/i],
        ['Shields & Hull', /shield|hull/i],
        ['Jump',           /jump|hyperdrive|hyperspace|scram|warp/i], // fallback only — usedInNavFunctions is checked first
        ['Scanning',       /scan/i],
        ['Crew',           /crew|bunk/i],
        ['Energy',         /heat|energy|solar|fuel|cool|ramscoop|generation/i],
        ['Engines',        /thrust|turn|veloc|drag|inertia|reverse|afterburner/i],
        ['Cargo',          /cargo/i],
    ];

    function _matchDomain(text) {
        if (!text) return null;
        for (const [section, re] of DOMAIN_WORDS) if (re.test(text)) return section;
        return null;
    }

    // ── The only other hardcoded table: the 5 capacity keys ShipInfoDisplay
    // itself groups together (shipDisplay.capacityDisplay in attrDefs.json).
    // Given directly by the game's own display code — we're not inventing
    // this grouping, just routing it to the right section name. Needed
    // ahead of the usedInShipFunctions check because e.g. "outfit space" is
    // also read by Scan() (for scan-time calc), which would otherwise
    // misroute it to Scanning instead of its true home, Cargo.
    const CAPACITY_SECTION = {
        'outfit space':    'Cargo',
        'weapon capacity': 'Cargo',
        'engine capacity': 'Engines',
        'gun ports':       'Hardpoints',
        'turret mounts':   'Hardpoints',
    };

    // Ship/outfit identity & economy fields with no dedicated engine
    // subsystem of their own — everything else that doesn't match falls
    // through to 'Other' rather than being force-fit here.
    const GENERAL_RE = /^(mass|cost|category|series|index)\b/i;

    function _getAttrRecord(attrDefs, key) {
        const attrs = attrDefs?.attributes || {};
        return attrs[key] || attrs[key?.toLowerCase()] || null;
    }

    /**
     * Classify a single attribute key into its canonical display section.
     * @param {object} attrDefs - parsed attrDefs.json (window.attrDefs)
     * @param {string} key - attribute key, e.g. "shield generation"
     * @param {object} [overrides] - optional { key: sectionName } escape hatch
     *   for the rare attribute nothing else can resolve. Keep this short —
     *   it's a pressure release, not the primary mechanism.
     */
    function classify(attrDefs, key, overrides) {
        if (overrides && overrides[key]) return overrides[key];

        const rec = _getAttrRecord(attrDefs, key);
        if (!rec) return _matchDomain(key) || 'Other';

        // 1. Explicit capacity grouping straight from ShipInfoDisplay's own table.
        if (CAPACITY_SECTION[key]) return CAPACITY_SECTION[key];

        // 2. Jump navigation — a real ShipJumpNavigation:: method reads this key.
        if (rec.usedInNavFunctions?.length) return 'Jump';

        // 3. Real Ship:: engine functions reading this key — match on the
        //    FUNCTION's name, which already encodes its subsystem.
        if (rec.usedInShipFunctions?.length) {
            for (const fnName of rec.usedInShipFunctions) {
                const hit = _matchDomain(fnName);
                if (hit) return hit;
            }
        }

        // 4. Semantic flags computed by the parser from real damage/status data.
        if (rec.isStatusResistance || rec.isStatusResistanceCost) return 'Resistance';
        if (rec.isProtection || rec.isStatusProtection)           return 'Protection';
        if (rec.isWeaponStat || rec.isWeaponDataKey)               return 'Weapon DPS';

        // 5. Fall back to the key's own name, then its stated purpose (tooltip).
        const nameHit = _matchDomain(key);
        if (nameHit) return nameHit;

        const purposeHit = _matchDomain(rec.tooltip || rec.description);
        if (purposeHit) return purposeHit;

        if (GENERAL_RE.test(key)) return 'General';

        return 'Other';
    }

    /**
     * Group every key of an attrs-like object { key: value } into
     * { sectionName: [key, key, ...] } using classify().
     */
    function groupKeys(attrDefs, attrsObj, overrides) {
        const groups = {};
        for (const key of Object.keys(attrsObj || {})) {
            const section = classify(attrDefs, key, overrides);
            (groups[section] = groups[section] || []).push(key);
        }
        return groups;
    }

    /** Sort section names per SECTION_ORDER; unknowns appended alphabetically. */
    function orderSections(sectionNames) {
        const known  = SECTION_ORDER.filter(s => sectionNames.includes(s));
        const extras = sectionNames.filter(s => !SECTION_ORDER.includes(s)).sort();
        return [...known, ...extras];
    }

    /**
     * Convenience for consumers (e.g. shipBuilderStats.js) that want a "tab"
     * made of several canonical sections merged together, instead of their
     * own separate keyword-token list. Returns every key in attrsObj whose
     * classify() result is one of `sectionNames`.
     */
    function keysInSections(attrDefs, attrsObj, sectionNames, overrides) {
        const wanted = new Set(sectionNames);
        return Object.keys(attrsObj || {})
            .filter(key => wanted.has(classify(attrDefs, key, overrides)));
    }

    return { SECTION_ORDER, classify, groupKeys, orderSections, keysInSections };
})();
