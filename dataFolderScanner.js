'use strict';

/**
 * dataFolderScanner.js — Endless Sky data/*.txt attribute-usage scanner
 *
 * Companion to attributeParser.js's source/-tree discovery phase, covering
 * the gap documented in attribute-area-classification.md §5/§6: everything
 * in attributeParser.js is derived from C++ *source* — this file derives
 * evidence from the game's actual shipped *content* (data/**\/*.txt).
 *
 * WHY THIS IS A SEPARATE FILE (not more regexes bolted onto the existing
 * brace-counting extractors): data/*.txt is NOT C++. Per §5.1, the engine's
 * own reader (DataFile.cpp) builds a tree purely from TAB-INDENTATION DEPTH
 * — no { } to balance. Reusing extractFunctionBodies' brace-counter on this
 * format would silently produce garbage. This file implements the small,
 * different thing that format actually needs: an indentation-stack tree
 * builder, tokenizing each line with awareness of "quoted" and `backtick`
 * spans (§5.2) exactly like DataFile.cpp does.
 *
 * WHAT THIS FEEDS BACK INTO THE DICTIONARY (all additive, same philosophy
 * as every other pass in attributeParser.js):
 *   - usedInDataCategories, dataUsageCount, dataValueRange, dataSampleValues
 *     — on every attribute key actually observed inside a real `outfit`/
 *     `ship` block, whether or not it was already known from source.
 *   - dataOnly: true — for keys that ONLY show up here, never in any
 *     source-code layer. Per §5.3, custom attribute keys are an explicitly
 *     supported, open modding feature (e.g. "spinal mount"), not a parser
 *     bug — these are real, first-class attributes with zero corresponding
 *     C++ logic anywhere.
 *   - Category co-occurrence, via deriveCategoryAreaHints() — the strongest
 *     signal available for area classification (§3's own note: "could sit
 *     above Layers 1-3"), because it's evidence of what the attribute is
 *     actually FOR in the shipped game, not an inference about which
 *     engine code path happens to touch it.
 *
 * SCOPE NOTE: only `outfit` and `ship` root blocks are walked (that's what
 * feeds attribute-area classification for ship/outfit stats). §5.5's
 * broader point — that custom attributes can also appear on `mission` and
 * `planet` blocks — is real but out of scope here; the tree-walking
 * primitives below (tokenizeLine/buildTree) are format-agnostic and could
 * be pointed at those block types later without any changes to them.
 *
 * KNOWN SIMPLIFICATIONS (best-effort, like every other regex-based pass in
 * this parser — see attributeParser.js's own Section 4 "Caveats"):
 *   - The excluded-structural-key list below is curated, not exhaustive.
 *     A modder-invented top-level key that happens to share a name with a
 *     real structural field would be silently skipped.
 *   - data/categories.txt (§5.4) is NOT fetched — category strings are
 *     used exactly as observed, whatever they are, tolerating unknown/
 *     custom category names by design rather than validating against a
 *     fixed list.
 *   - `ship` blocks are only recognised when they have a distinct nested
 *     `attributes` child (the standard format); a `category` line is
 *     looked for both inside that `attributes` block and at the ship's
 *     own top level, since both forms have been seen in the wild.
 */

const fs   = require('fs').promises;
const path = require('path');

const ES_REPO_RAW = 'https://raw.githubusercontent.com/endless-sky/endless-sky/master';
const ES_API_TREE  = 'https://api.github.com/repos/endless-sky/endless-sky/git/trees/master?recursive=1';

// ---------------------------------------------------------------------------
// Tokenizer / tree builder — the DataNode-equivalent this format needs.
// ---------------------------------------------------------------------------

// Tokenizes one line per DataFile.cpp's rules (§5.2): a token starting with
// " or ` runs until its matching close mark (letting values contain spaces);
// anything else is whitespace-delimited. Depth = count of leading tabs
// (§5.1 — tabs only, not spaces). Returns null for blank/whitespace-only
// lines so callers can skip them without special-casing.
function tokenizeLine(rawLine) {
    if (!rawLine) return null;
    let i = 0;
    while (rawLine[i] === '\t') i++;
    const depth = i;
    const rest = rawLine.slice(i);
    if (!rest.trim()) return null;

    const tokens = [];
    let j = 0;
    while (j < rest.length) {
        const ch = rest[j];
        if (ch === ' ' || ch === '\t') { j++; continue; }
        if (ch === '"' || ch === '`') {
            const quote = ch;
            let k = j + 1;
            while (k < rest.length && rest[k] !== quote) k++;
            tokens.push(rest.slice(j + 1, k));
            j = k + 1;
        } else {
            let k = j;
            while (k < rest.length && rest[k] !== ' ' && rest[k] !== '\t') k++;
            tokens.push(rest.slice(j, k));
            j = k;
        }
    }
    return tokens.length ? { depth, tokens } : null;
}

// Builds a forest of { tokens, children } nodes from raw file text, using
// an indentation stack — exactly the "child is one tab deeper than parent"
// rule §5.1 describes, no braces anywhere.
function buildTree(src) {
    const roots = [];
    const stack = []; // [{ depth, node }], innermost last
    for (const rawLine of src.split('\n')) {
        const parsed = tokenizeLine(rawLine);
        if (!parsed) continue;
        const { depth, tokens } = parsed;
        const node = { tokens, children: [] };
        while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
        if (stack.length) stack[stack.length - 1].node.children.push(node);
        else roots.push(node);
        stack.push({ depth, node });
    }
    return roots;
}

// ---------------------------------------------------------------------------
// Attribute-pair extraction from outfit/ship blocks
// ---------------------------------------------------------------------------

// Root-level directives (§5.6) and structural/identity/rendering fields
// that are NOT gameplay attribute keys, even though they appear as direct
// children of an outfit/ship/attributes block just like real attributes do.
// "weapon" and "attributes" are handled specially (descended into, not
// skipped) rather than excluded outright.
const NON_ATTRIBUTE_KEYS = new Set([
    'overwrite', 'add', 'remove', 'clear',
    'sprite', 'thumbnail', 'description', 'plural', 'noun', 'swizzle',
    'licenses', 'flotsam sprite', 'unplunderable', 'category',
    'outfits', 'engine', 'reverse engine', 'steering engine',
    'gun', 'turret', 'fighter', 'drone', 'bay',
    'leak', 'explode', 'final explode', 'effect', 'sound',
]);

// Walks the direct children of a block (an outfit itself, or a ship's
// nested `attributes` block), recording every "key value" / bare "key"
// pair that isn't a known structural field. Descends into a nested
// `weapon` child (same category context — a gun's weapon-block fields like
// "reload"/damage types are just as relevant to its Weapons classification
// as its top-level fields) but does not otherwise recurse, since anything
// else nested (e.g. a ship's `outfits` loadout list) isn't an attribute.
function scanAttributeBlock(node, category, onType, perKey) {
    for (const child of node.children) {
        const key = child.tokens[0];
        if (!key) continue;
        if (key === 'weapon') { scanAttributeBlock(child, category, onType, perKey); continue; }
        if (NON_ATTRIBUTE_KEYS.has(key)) continue;

        if (!perKey[key]) perKey[key] = {
            count: 0, categories: new Set(), min: null, max: null, samples: [],
            onShip: false, onOutfit: false,
        };
        const rec = perKey[key];
        rec.count++;
        if (category) rec.categories.add(category);
        if (onType === 'ship')   rec.onShip = true;
        if (onType === 'outfit') rec.onOutfit = true;

        if (child.tokens.length > 1) {
            const value = parseFloat(child.tokens[1]);
            // Preserve sign (§5.7 — negative capacity-consumption values are
            // normal and expected, not something to normalise away).
            if (!isNaN(value)) {
                if (rec.min === null || value < rec.min) rec.min = value;
                if (rec.max === null || value > rec.max) rec.max = value;
                if (rec.samples.length < 5) rec.samples.push(value);
            }
        }
    }
}

function findChild(node, key) {
    return node.children.find(c => c.tokens[0] === key) || null;
}

// Aggregates attribute usage across every parsed file's forest of root
// nodes. Only `outfit` and `ship` roots are considered (see file header).
function aggregateDataUsage(fileEntries) {
    const perKey = {};
    for (const { content } of fileEntries) {
        let roots;
        try { roots = buildTree(content); } catch (_) { continue; }

        for (const root of roots) {
            const type = root.tokens[0];
            if (type !== 'outfit' && type !== 'ship') continue;

            if (type === 'outfit') {
                const catNode  = findChild(root, 'category');
                const category = catNode ? catNode.tokens[1] : null;
                scanAttributeBlock(root, category, 'outfit', perKey);
            } else {
                // Standard ship format nests real gameplay attributes one
                // level deeper, under a distinct `attributes` child — a
                // ship block's OWN direct children (engine/gun/outfits/...)
                // are positional hardpoint/loadout data, not attributes.
                const attrNode = findChild(root, 'attributes');
                if (!attrNode) continue;
                const catNode = findChild(attrNode, 'category') || findChild(root, 'category');
                const category = catNode ? catNode.tokens[1] : null;
                scanAttributeBlock(attrNode, category, 'ship', perKey);
            }
        }
    }
    return perKey;
}

// ---------------------------------------------------------------------------
// Category → area hints — the strongest area-classification signal, but
// only trusted when unambiguous (see module doc above).
// ---------------------------------------------------------------------------

// Standard base-game outfit categories only. A category not in this map
// produces no hint at all — it is NOT forced into a bucket, per §5.3/§5.4:
// categories are an open, data-driven set (data/categories.txt), and a
// modder-invented category should never masquerade as evidence.
const CATEGORY_AREA_MAP = {
    'guns':               'Weapons',
    'turrets':             'Weapons',
    'secondary weapons':   'Weapons',
    'ammunition':          'Weapons',
    'anti-missile':        'Weapons',
    'engines':              'Movement & Engines',
    'steering':             'Movement & Engines',
    'power':                'Power, Heat & Life Support',
    'systems':              'Power, Heat & Life Support',
    'shields':              'Power, Heat & Life Support',
    'cooling':              'Power, Heat & Life Support',
    'hand to hand':         'Special / Flags',
};

// Only assigns a hint when every category the key was ever observed under
// maps to the SAME area — a key seen under both a mapped and an unmapped
// (custom) category, or under two categories implying different areas,
// gets no hint rather than a guess.
function deriveCategoryAreaHints(perKey) {
    const hints = {};
    for (const [key, rec] of Object.entries(perKey)) {
        if (!rec.categories || !rec.categories.size) continue;
        const areas = new Set();
        for (const cat of rec.categories) {
            const area = CATEGORY_AREA_MAP[String(cat).toLowerCase()];
            if (area) areas.add(area);
        }
        if (areas.size === 1)
            hints[key] = { area: [...areas][0], categories: [...rec.categories].sort() };
    }
    return hints;
}

// ---------------------------------------------------------------------------
// Top-level scan — mirrors discoverRelevantSourceFiles' shape/caching
// (same 7-day staleness policy, same --rescan override, same disk cache
// pattern) so the two discovery phases behave identically to operators.
// ---------------------------------------------------------------------------

function createDataFolderScanner({ fetchText, withPool }) {

    async function scanDataFolderUsage(cacheFile, opts = {}) {
        const maxAgeMs    = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
        const forceRescan = !!opts.forceRescan;

        if (!forceRescan) {
            try {
                const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
                if ((Date.now() - cached.scannedAt) < maxAgeMs) {
                    console.log(`  Using cached data/ usage scan from ${new Date(cached.scannedAt).toISOString()} ` +
                        `(${cached.fileCount} files, ${Object.keys(cached.perKey).length} attribute keys). Pass --rescan to force a fresh scan.`);
                    return cached;
                }
            } catch (_) { /* no cache yet, or unreadable — do a fresh scan */ }
        }

        console.log('  Fetching data/ file tree from GitHub API...');
        const authHeaders = process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {};
        let treeJson;
        try {
            treeJson = JSON.parse(await fetchText(ES_API_TREE, authHeaders));
        } catch (err) {
            console.log(`  ✗  Could not fetch repo tree (${err.message}). data/ usage scan skipped this run.`);
            return { scannedAt: Date.now(), fileCount: 0, perKey: {}, failed: true };
        }

        const candidates = (treeJson.tree || [])
            .filter(e => e.type === 'blob' && e.path.startsWith('data/') && /\.txt$/i.test(e.path));
        console.log(`  ${candidates.length} .txt files under data/`);

        const fileEntries = [];
        await withPool(candidates, async (entry) => {
            const content = await fetchText(`${ES_REPO_RAW}/${entry.path}`);
            fileEntries.push({ path: entry.path, content });
        }, 8, (done, total) => {
            if (done % 25 === 0 || done === total) process.stdout.write(`\r  Fetched ${done}/${total}...`);
        });
        console.log(`\r  Fetched ${fileEntries.length}/${candidates.length} data/ files`);

        const perKeyRaw = aggregateDataUsage(fileEntries);
        const perKey = {};
        for (const [key, rec] of Object.entries(perKeyRaw)) {
            perKey[key] = {
                count: rec.count,
                categories: [...rec.categories].sort(),
                min: rec.min, max: rec.max, samples: rec.samples,
                onShip: rec.onShip, onOutfit: rec.onOutfit,
            };
        }

        const record = { scannedAt: Date.now(), fileCount: fileEntries.length, perKey };
        try {
            await fs.mkdir(path.dirname(cacheFile), { recursive: true });
            await fs.writeFile(cacheFile, JSON.stringify(record, null, 2), 'utf8');
        } catch (_) { /* non-fatal — scan still returned in-memory */ }

        return record;
    }

    return { scanDataFolderUsage, deriveCategoryAreaHints, aggregateDataUsage, buildTree, tokenizeLine };
}

module.exports = createDataFolderScanner;
