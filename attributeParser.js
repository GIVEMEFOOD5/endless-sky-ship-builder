'use strict';

/**
 * attributeParser.js — Endless Sky Attribute Parser
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  NEW IN THIS VERSION: full-codebase discovery before targeted parsing
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  Previously this parser only ever looked at a hardcoded list of ~12 files
 *  (SOURCE_FILES). Anything that reads or writes outfit/ship attributes
 *  outside those files — e.g. Armament/Hardpoint gun & turret handling,
 *  AI combat-behaviour thresholds, boarding-combat code, cargo/crew
 *  handling — was invisible to the dictionary, forever, silently.
 *
 *  This version adds a DISCOVERY PHASE that runs before any targeted
 *  parsing:
 *
 *    1. discoverRelevantSourceFiles() pulls the full recursive file tree
 *       of the live repo (one GitHub Trees API call), filters to every
 *       .cpp/.h under source/, fetches each candidate's raw content, and
 *       tests it against a set of attribute-access patterns
 *       (attributes.Get(, Attributes().Get(, .Set(", Attributes().Mass(),
 *       etc). Anything that matches is "relevant" — regardless of whether
 *       a human ever added it to a hardcoded list.
 *
 *    2. The result is cached to disk (discoveredSourceFiles.json) with a
 *       timestamp, so routine runs don't re-scan ~300 files every time.
 *       Re-discovery happens automatically once the cache is stale
 *       (default 7 days) or when --rescan is passed on the CLI.
 *
 *    3. The dozen "seed" files that already have bespoke parsers
 *       (Ship.cpp, Outfit.cpp/h, Weapon.cpp/h, OutfitInfoDisplay.cpp,
 *       ShipInfoDisplay.cpp, DamageDealt.cpp/h, ShipJumpNavigation.cpp/h)
 *       keep their hand-tuned extraction logic untouched — those follow
 *       hand-authored formats (SCALE_LABELS, BOOLEAN_ATTRIBUTES,
 *       VALUE_NAMES, MINIMUM_OVERRIDES) that only targeted regexes can
 *       read correctly. They are excluded from the generic discovery
 *       pass so they don't get parsed twice / conflictingly.
 *
 *    4. Every OTHER discovered file is parsed generically via
 *       extractAllClassFunctionBodies() / parseGenericSourceFile() — a
 *       version of the existing function-body extractor that is not
 *       locked to one class prefix, so it will pick up e.g. Armament::,
 *       Hardpoint::, AI::, CargoHold::, or any future class without
 *       needing to be told its name in advance.
 *
 *    5. Any attribute key found only in a newly-discovered file (i.e. it
 *       never showed up in OutfitInfoDisplay/ShipInfoDisplay/etc.) gets
 *       a dictionary entry created for it on the spot, tagged
 *       `usedInOtherSystems: ["ClassName::fnName", ...]` and
 *       `discoveredOnly: true` so you can immediately see what the old
 *       hardcoded-file-list approach was missing.
 *
 *  Everything from the previous version (tooltip parsing, damage-type
 *  detail building, status-effect decay modelling, system-aware solar
 *  formulas) is unchanged and still runs exactly as before.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  NEW: movement-system derivation (zero hardcoded keyword lists)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  Attributes like "turn" are ambiguous by NAME ALONE — the same key is
 *  used for a ship's engine turning-force AND (in a different struct path,
 *  outfit.weapon.turn) a missile/turret's turn rate. Rather than maintain
 *  a hand-picked list of "movement attribute names" (which "turn" would
 *  break), this pass derives ship-physics relevance structurally:
 *
 *    1. Build a call graph between ship functions purely from formula text
 *       already in shipFunctions (every "FnName()" reference found there
 *       IS a real call, extracted with zero guessing).
 *    2. Seed the traversal from InertialMass / Drag / DragForce — three
 *       functions that exist for exactly one reason in this engine
 *       (motion physics). Nothing else has any reason to call them.
 *    3. Any ship function that calls a seed function, directly or
 *       transitively, is a physics/movement function. Collect every
 *       attribute referenced (via "[attr]" in its formula) across that
 *       whole closure.
 *    4. Tag each such attribute `isMovementRelevant: true` in the
 *       dictionary — additively, alongside whatever other flags it
 *       already has (e.g. "turn" keeps isWeaponDataKey: true from its
 *       missile-turn-rate role AND gains isMovementRelevant: true from
 *       its ship-engine role — both are correct, for different contexts).
 *
 *  The only "seed" is three function names that are structurally
 *  unambiguous (mass/drag mean nothing except motion) — not a curated
 *  glossary of movement-sounding words.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  NEW: front-end "area" derivation (see attribute-area-classification.md)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  Everything above produces a rich set of per-attribute BOOLEAN flags
 *  (isStatusEffect, isWeaponDataKey, isMovementRelevant, isProtection,
 *  isBoolean, discoveredOnly, usedInOtherSystems, shownInOutfitPanel,
 *  shownInShipPanel, ...) but leaves it to every downstream consumer to
 *  re-derive a single "which UI bucket does this go in" answer from that
 *  flag soup, independently, over and over.
 *
 *  deriveFrontendArea() does that derivation exactly ONCE, here, following
 *  the priority list documented in attribute-area-classification.md §3 —
 *  itself written to describe exactly the flags this file already
 *  produces, so there is nothing new being guessed. Each attribute gets:
 *
 *    - `area`        — the single primary bucket, chosen by walking the
 *                       priority list top to bottom and taking the first
 *                       rule that matches.
 *    - `areaBadges`   — every OTHER rule that also matched (dual-role
 *                       attributes like "turn" — Weapons AND Movement).
 *
 *  This is intentionally a COARSE ~10-bucket taxonomy, useful for a
 *  front end that wants "which broad category" without re-deriving it.
 *  Front ends wanting finer buckets (e.g. splitting "Power, Heat & Life
 *  Support" into separate Shields/Energy/Heat sections) should keep using
 *  the underlying flags directly — `area` is a floor, not a ceiling.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  NEW: structural (zero-hardcoded-type-list) damage-type discovery
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  parseDamageDealt() used to find "damage types" by regex-matching every
 *  zero-arg `double`-returning (or, via the inline-definition regex, ANY
 *  zero-arg const-noexcept) method declared on the DamageDealt class. That
 *  worked when DamageDealt exposed one accessor per damage type directly.
 *  It no longer does — current DamageDealt.h exposes exactly four
 *  accessors (GetWeapon, Scaling, Levels, HitForce), none of which are
 *  damage types; the real per-resource values live one level deeper, as
 *  fields on the struct Levels() returns (currently ResourceLevels).
 *
 *  deriveDamageTypesStructurally() (added below, alongside — not
 *  replacing — parseDamageDealt()/parseShipTakeDamage()) finds this
 *  correctly regardless of naming, by:
 *
 *    A. Structurally locating DamageDealt's "aggregate resource accessor"
 *       — not by name, but by finding the public zero-arg const method
 *       whose declared return type matches a PRIVATE member's declared
 *       type (the ordinary C++ getter pattern).
 *    B. Following DamageDealt.h's own #include lines to the header that
 *       defines that return type, fetching it, and parsing its
 *       double-typed member fields — the raw, current per-resource names.
 *    C. Cross-referencing against Weapon::Load's own literal
 *       `key == "..."` data-file keys (already parsed elsewhere in this
 *       file, zero hardcoding) that end in " damage" — this supplies the
 *       correctly-cased canonical type names ("Shield", "Ion", ...) the
 *       rest of the app expects, since raw struct field names don't match
 *       1:1 (shields/ionization/leakage/burning vs. the attribute-key
 *       convention shield/ion/leak/burn).
 *    D. Reconciling B onto C via a generic shared-prefix similarity check
 *       — not a synonym table — to carry shieldInteraction/category info
 *       across. Union, not intersection: anything Step C finds that Step
 *       B can't confirm is still kept, since an extra type is harmless
 *       downstream while a missing real one silently breaks combat math.
 *
 *  parseDamageDealt() and parseShipTakeDamage() are left completely
 *  unmodified (anything else that imports them directly keeps working
 *  unchanged) and are used as the fallback if structural discovery fails
 *  for any reason (network hiccup, a future upstream refactor that breaks
 *  the getter-pattern assumption, etc.) — see parseAttributes() below.
 * ─────────────────────────────────────────────────────────────────────────
 */

const https = require('https');
const fs    = require('fs').promises;
const path  = require('path');
const createDataFolderScanner = require('./dataFolderScanner');

const ES_RAW  = 'https://raw.githubusercontent.com/endless-sky/endless-sky/master/source';
const ES_DATA = 'https://raw.githubusercontent.com/endless-sky/endless-sky/master/data';
const ES_API_TREE = 'https://api.github.com/repos/endless-sky/endless-sky/git/trees/master?recursive=1';

const SOURCE_FILES = {
  outfitInfoDisplay: `${ES_RAW}/OutfitInfoDisplay.cpp`,
  shipInfoDisplay:   `${ES_RAW}/ShipInfoDisplay.cpp`,
  shipCpp:           `${ES_RAW}/Ship.cpp`,
  shipH:             `${ES_RAW}/Ship.h`,
  outfitCpp:         `${ES_RAW}/Outfit.cpp`,
  outfitH:           `${ES_RAW}/Outfit.h`,
  weaponCpp:         `${ES_RAW}/Weapon.cpp`,
  weaponH:           `${ES_RAW}/Weapon.h`,
  damageDealtCpp:    `${ES_RAW}/DamageDealt.cpp`,
  damageDealtH:      `${ES_RAW}/DamageDealt.h`,
  jumpNavCpp:        `${ES_RAW}/ShipJumpNavigation.cpp`,
  jumpNavH:          `${ES_RAW}/ShipJumpNavigation.h`,
};

// Paths (relative to source/) already covered by a bespoke parser above.
// Excluded from the generic discovery pass so they aren't parsed twice.
const SEED_PATHS = new Set([
  'source/OutfitInfoDisplay.cpp',
  'source/ShipInfoDisplay.cpp',
  'source/Ship.cpp', 'source/Ship.h',
  'source/Outfit.cpp', 'source/Outfit.h',
  'source/Weapon.cpp', 'source/Weapon.h',
  'source/DamageDealt.cpp', 'source/DamageDealt.h',
  'source/ShipJumpNavigation.cpp', 'source/ShipJumpNavigation.h',
]);

const DATA_FILES = {
  solSystem: `${ES_DATA}/human/Sol.txt`,
  tooltips:  `${ES_DATA}/_ui/tooltips.txt`,
};

// ---------------------------------------------------------------------------
// HTTP fetch
// ---------------------------------------------------------------------------

function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'endless-sky-attribute-parser',
        ...headers,
      },
    };
    https.get(url, opts, res => {
      // Follow a single redirect hop (GitHub occasionally issues these).
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        res.resume();
        if (loc) { fetchText(loc, headers).then(resolve, reject); return; }
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Simple bounded-concurrency worker pool. Keeps discovery well under
// GitHub's abuse-detection thresholds without needing a queue library.
async function withPool(items, worker, concurrency = 8, onProgress) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  async function runOne() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await worker(items[i], i); }
      catch (err) { results[i] = { __error: err.message }; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runOne));
  return results;
}

// Instantiated here (not inside dataFolderScanner.js) so the data/ scan
// shares this file's own fetchText/withPool instead of duplicating HTTP
// plumbing in a second file.
const { scanDataFolderUsage, deriveCategoryAreaHints } = createDataFolderScanner({ fetchText, withPool });

// ---------------------------------------------------------------------------
// NEW: discoverRelevantSourceFiles(cacheFile, opts)
//
// Scans the ENTIRE live source/ tree (not just SOURCE_FILES) and returns
// every .cpp/.h file that actually touches outfit/ship attributes, whether
// or not a human ever added it to a hardcoded list.
// ---------------------------------------------------------------------------

const ATTR_ACCESS_PATTERNS = [
  /\battributes?(?:\.|->)Get\s*\(/,
  /\bAttributes\s*\(\s*\)\s*(?:\.|->)\s*Get\s*\(/,
  /\bbaseAttributes(?:\.|->)Get\s*\(/,
  /\battributes?(?:\.|->)Set\s*\(\s*"/,
  /\bAttributes\s*\(\s*\)\s*(?:\.|->)\s*Mass\s*\(/,
  /\bship(?:\.|->)Attributes\s*\(\s*\)/,
  /\boutfit(?:\.|->)Attributes\s*\(\s*\)/,
  /\boutfit(?:\.|->)Get\s*\(\s*"/,
];

function looksAttributeRelevant(src) {
  return ATTR_ACCESS_PATTERNS.some(re => re.test(src));
}

async function discoverRelevantSourceFiles(cacheFile, opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  const forceRescan = !!opts.forceRescan;

  if (!forceRescan) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if ((Date.now() - cached.scannedAt) < maxAgeMs) {
        console.log(`  Using cached discovery from ${new Date(cached.scannedAt).toISOString()} ` +
          `(${cached.relevantFiles.length} relevant / ${cached.totalCandidates} scanned). Pass --rescan to force a fresh scan.`);
        return cached;
      }
    } catch (_) { /* no cache yet, or unreadable — do a fresh scan */ }
  }

  console.log('  Fetching full source/ file tree from GitHub API...');
  const authHeaders = process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {};
  let treeJson;
  try {
    treeJson = JSON.parse(await fetchText(ES_API_TREE, authHeaders));
  } catch (err) {
    console.log(`  ✗  Could not fetch repo tree (${err.message}). ` +
      `Falling back to the seed file list only — discovery skipped this run.`);
    return { scannedAt: Date.now(), totalCandidates: 0, relevantFiles: [], scannedPaths: [], failed: true };
  }

  if (treeJson.truncated)
    console.log('  ⚠  GitHub truncated the tree response — some deeply nested files may be missed.');

  const candidates = (treeJson.tree || [])
    .filter(e => e.type === 'blob' && e.path.startsWith('source/') && /\.(cpp|h)$/i.test(e.path))
    .filter(e => !SEED_PATHS.has(e.path));

  console.log(`  ${candidates.length} candidate files under source/ (excluding ${SEED_PATHS.size} seed files already parsed by name)`);

  const relevantFiles = [];
  const scannedPaths  = [];
  const contentCache  = {}; // path -> content, reused immediately by the parse phase below

  await withPool(candidates, async (entry) => {
    const rawUrl = `${ES_RAW}/${entry.path.replace(/^source\//, '')}`;
    const content = await fetchText(rawUrl);
    scannedPaths.push(entry.path);
    if (looksAttributeRelevant(content)) {
      relevantFiles.push({ path: entry.path, size: content.length, sha: entry.sha });
      contentCache[entry.path] = content;
    }
  }, 8, (done, total) => {
    if (done % 25 === 0 || done === total) process.stdout.write(`\r  Scanned ${done}/${total}...`);
  });
  console.log(`\r  Scanned ${scannedPaths.length}/${candidates.length} — ` +
    `${relevantFiles.length} files reference outfit/ship attributes and weren't in the old hardcoded list`);

  const record = {
    scannedAt: Date.now(),
    totalCandidates: candidates.length,
    relevantFiles: relevantFiles.map(({ path: p, size, sha }) => ({ path: p, size, sha })),
    scannedPaths,
  };
  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(record, null, 2), 'utf8');
  } catch (_) { /* non-fatal — discovery still returned in-memory */ }

  // Attach in-memory content so the caller doesn't have to re-fetch files
  // it just downloaded a moment ago (only populated on a fresh scan).
  record._contentCache = contentCache;
  return record;
}

// ---------------------------------------------------------------------------
// parseTooltips(src)
//
// Parses data/_ui/tooltips.txt into a Map: attributeKey → tooltip string.
// Keys are normalised: trailing colon stripped, lowercased, trimmed.
// Multi-paragraph tips are joined with a single newline.
// ---------------------------------------------------------------------------

function parseTooltips(src) {
  const tooltipMap = new Map();
  if (!src) return tooltipMap;

  const lines = src.split('\n');
  let currentKey  = null;
  let paragraphs  = [];

  const flush = () => {
    if (currentKey !== null && paragraphs.length > 0) {
      tooltipMap.set(currentKey, paragraphs.join('\n\n'));
    }
    currentKey = null;
    paragraphs = [];
  };

  for (const rawLine of lines) {
    const line = rawLine;

    const tipMatch = line.match(/^tip\s+"([^"]+)"\s*$/);
    if (tipMatch) {
      flush();
      currentKey = tipMatch[1].replace(/:$/, '').trim().toLowerCase();
      continue;
    }

    const backtickMatch = line.match(/^\s*`([^`]*)`\s*$/);
    if (backtickMatch && currentKey !== null) {
      const text = backtickMatch[1].trim();
      if (text) paragraphs.push(text);
      continue;
    }

    if (line.trim() !== '' && !line.startsWith('\t') && !line.startsWith(' ')) {
      flush();
    }
  }

  flush();
  return tooltipMap;
}

// ---------------------------------------------------------------------------
// mergeTooltipsIntoAttributes(attrs, tooltipMap)
// ---------------------------------------------------------------------------

function mergeTooltipsIntoAttributes(attrs, tooltipMap) {
  for (const [key, entry] of Object.entries(attrs)) {
    const tip = tooltipMap.get(key.toLowerCase());
    if (tip) entry.tooltip = tip;
  }
}

// ---------------------------------------------------------------------------
// Sentinelizer — replaces attributes.Get("key") with ⟦key⟧ brackets
// ---------------------------------------------------------------------------

// Matches both dot (ship.Attributes()) and arrow (outfit->Attributes())
// accessors — arrow notation is extremely common in pointer-heavy code like
// Armament/Hardpoint, which the discovery phase now reaches, so both forms
// need to sentinelize identically or those files silently lose every
// attribute reference.
function sentinelizeGetCalls(src) {
  return src
    .replace(/\battributes?(?:\.|->)Get\s*\(\s*"([^"]+)"\s*\)/g,                 (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\b\w+(?:\.|->)Attributes\s*\(\s*\)(?:\.|->)Get\s*\(\s*"([^"]+)"\s*\)/g, (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\bbaseAttributes(?:\.|->)Get\s*\(\s*"([^"]+)"\s*\)/g,              (_, k) => `\u27e6${k}\u27e7`)
    .replace(/\battributes?(?:\.|->)Mass\s*\(\s*\)/g,                () => `\u27e6mass\u27e7`)
    .replace(/\b\w+(?:\.|->)Attributes\s*\(\s*\)(?:\.|->)Mass\s*\(\s*\)/g, () => `\u27e6mass\u27e7`);
}

function extractVarMap(sentBody) {
  const vars  = {};
  const lines = sentBody.split('\n');
  for (const line of lines) {
    const m = line.match(
      /^\s*(?:const\s+)?(?:double|int|bool|float|size_t|int64_t)\s+(\w+)\s*=\s*(.*?)\s*;?\s*$/
    );
    if (!m) continue;
    const name = m[1];
    const def  = m[2].replace(/\s+/g, ' ').trim();
    if (!def) continue;
    const hasSentinel  = def.includes('\u27e6');
    const isPureArith  = /^[\d\s+\-*/.()\[\]e]+$/i.test(def);
    const isFnCall     = /^[A-Z][a-zA-Z]+\s*\([^)]*\)\s*$/.test(def);
    const hasFnAndSent = /^[A-Z][a-zA-Z]+\s*\(/.test(def) && hasSentinel;
    if (hasSentinel || isPureArith || hasFnAndSent) {
      vars[name] = def;
    } else if (isFnCall) {
      vars[name] = def.replace(/;$/, '').trim();
    }
  }
  return vars;
}

function substituteVars(expr, vars) {
  const sorted = Object.entries(vars).sort((a, b) => b[0].length - a[0].length);
  for (const [name, def] of sorted) {
    const s = '\u27e6', e = '\u27e7';
    const parts = expr.split(new RegExp(`(${s}[^${e}]*${e})`));
    expr = parts.map((part, idx) => {
      if (idx % 2 === 1) return part;
      return part.replace(
        new RegExp(`\\b${name}\\b(?!\\s*\\()`, 'g'),
        def.includes('\u27e6') || def.length > 18 ? `(${def})` : def
      );
    }).join('');
  }
  return expr;
}

function buildFormula(rawReturn, rawBody) {
  const sentBody   = sentinelizeGetCalls(rawBody);
  const sentReturn = sentinelizeGetCalls(rawReturn);
  const vars       = extractVarMap(sentBody);
  const inlined    = substituteVars(sentReturn, vars);
  return inlined
    .replace(/Format::Number\s*\(/g, '(')
    .replace(/\u27e6/g, '[').replace(/\u27e7/g, ']')
    .replace(/\b(\d+)\.\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAllAttributeKeys(src) {
  const keys = new Set();
  const sentSrc = sentinelizeGetCalls(src);
  for (const re of [
    /\u27e6([^\u27e7]+)\u27e7/g,
    /\battributes?(?:\.|->)Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\bbaseAttributes?(?:\.|->)Get\s*\(\s*"([^"]+)"\s*\)/g,
    /\b\w+(?:\.|->)Attributes\s*\(\s*\)(?:\.|->)Get\s*\(\s*"([^"]+)"\s*\)/g,
  ]) {
    let m;
    const target = re.source.includes('\u27e6') ? sentSrc : src;
    while ((m = re.exec(target)) !== null) keys.add(m[1]);
  }
  return [...keys].sort();
}

function extractSetKeys(src) {
  const keys = new Set();
  const re = /\battributes?(?:\.|->)Set\s*\(\s*"([^"]+)"\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// C++ function body extractor — fixed class prefix (used for seed files)
// ---------------------------------------------------------------------------

function extractFunctionBodies(src, classPrefix) {
  const bodies = {};
  const sigRe  = new RegExp(
    `(?:^|\\n)[ \\t]*((?:[\\w:<>*&~][ \\w:<>*&~]*?)\\s+)${classPrefix}(\\w+)\\s*\\(([^)]*)\\)\\s*(const\\s*)?(?:noexcept\\s*)?\\{`,
    'g'
  );
  let m;
  while ((m = sigRe.exec(src)) !== null) {
    const fnName    = m[2];
    const bodyStart = m.index + m[0].length;
    let depth = 1, i = bodyStart;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const body = src.slice(bodyStart, i - 1).trim();
    if (!bodies[fnName] || body.length > bodies[fnName].body.length)
      bodies[fnName] = { returnType: m[1].trim(), params: m[3].trim(), isConst: !!m[4], body };
  }
  return bodies;
}

// ---------------------------------------------------------------------------
// NEW: extractAllClassFunctionBodies(src)
//
// Class-agnostic version of extractFunctionBodies. Matches
// "AnyClassName::AnyMethodName(...) { ... }" for EVERY class defined in
// the file, without needing to be told the class name in advance. This is
// what lets a newly-discovered file (Armament.cpp, AI.cpp, whatever) get
// parsed correctly with zero prior knowledge of what classes it contains.
// ---------------------------------------------------------------------------

const NON_CLASS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'else']);

function extractAllClassFunctionBodies(src) {
  const bodies = {};
  const sigRe = /(?:^|\n)[ \t]*((?:[\w:<>*&~][ \w:<>*&~]*?)\s+)(\w+)::(\w+)\s*\(([^)]*)\)\s*(const\s*)?(?:noexcept\s*)?\{/g;
  let m;
  while ((m = sigRe.exec(src)) !== null) {
    const className = m[2];
    const fnName    = m[3];
    if (NON_CLASS_KEYWORDS.has(className)) continue; // filter obvious false positives
    const bodyStart = m.index + m[0].length;
    let depth = 1, i = bodyStart;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const body = src.slice(bodyStart, i - 1).trim();
    const key  = `${className}::${fnName}`;
    if (!bodies[key] || body.length > bodies[key].body.length)
      bodies[key] = { className, fnName, returnType: m[1].trim(), params: m[4].trim(), isConst: !!m[5], body };
  }
  return bodies;
}

// ---------------------------------------------------------------------------
// NEW: parseGenericSourceFile(src, filePath)
//
// Runs a newly-discovered file through the class-agnostic extractor and
// returns { ClassName: { fnName: {...} } } in the same shape parseShipCpp
// already produces for Ship::, so downstream code (annotateShipFunctionScales
// etc.) can be reused unmodified if you ever want to fold these in further.
// ---------------------------------------------------------------------------

function parseGenericSourceFile(src, filePath) {
  const bodies  = extractAllClassFunctionBodies(src);
  const byClass = {};
  for (const { className, fnName, body, returnType, params, isConst } of Object.values(bodies)) {
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);
    const setKeys  = extractSetKeys(body);
    if (attrKeys.length === 0 && setKeys.length === 0 && returns.length === 0) continue;
    if (!byClass[className]) byClass[className] = {};
    byClass[className][fnName] = {
      returnType, params, isConst,
      sourceFile: filePath,
      attributesRead: attrKeys,
      attributesSet:  setKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })),
    };
  }
  return byClass;
}

function extractReturns(body) {
  const returns = [];
  const re = /\breturn\s+((?:[^;{}]|\{[^}]*\})+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const expr = m[1].replace(/\s+/g, ' ').trim();
    if (expr && !['0', '1', 'false', 'true', 'result', 'type', 'nullptr'].includes(expr))
      returns.push(expr);
  }
  return returns;
}

function parseLabelArg(arg) {
  const trimmed  = arg.trim();
  const litMatch = trimmed.match(/^"([^"]*)"$/);
  if (litMatch) return litMatch[1].replace(/:$/, '').trim();
  const allStrings = [...trimmed.matchAll(/"([^"]+)"/g)].map(m => m[1].replace(/:$/, '').trim());
  const unique = [...new Set(allStrings)];
  return unique.length > 0 ? unique.join(' / ') : trimmed;
}

function extractParenArg(src, start) {
  let depth = 1, i = start;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  return { arg: src.slice(start, i - 1).trim(), end: i };
}

// ---------------------------------------------------------------------------
// Parse OutfitInfoDisplay.cpp
// ---------------------------------------------------------------------------

function parseOutfitInfoDisplay(src) {
  const r = {
    scaleLabels:      [],
    scaleMap:         {},
    booleanAttrs:     {},
    valueNames:       [],
    percentNames:     [],
    otherNames:       [],
    expectedNegative: [],
    beforeAttrs:      [],
    allAttributeKeys: extractAllAttributeKeys(src),
  };

  const slMatch = src.match(/SCALE_LABELS\s*=\s*\{([\s\S]*?)\};/);
  if (slMatch) {
    const pairRe = /make_pair\s*\(\s*([\d\s.*\/]+?)\s*,\s*"([^"]*)"\s*\)/g;
    let m;
    while ((m = pairRe.exec(slMatch[1])) !== null) {
      const expr = m[1].replace(/\s+/g, '');
      let multiplier = NaN;
      if (/^[\d.*\/]+$/.test(expr)) {
        try { multiplier = Function(`"use strict";return(${expr})`)(); } catch (_) {}
      }
      if (isNaN(multiplier)) multiplier = parseFloat(expr);
      r.scaleLabels.push({ multiplier, unit: m[2] });
    }
  }

  const scMatch = src.match(/const map<string,\s*int> SCALE\s*=\s*\{([\s\S]*?)\};/);
  if (scMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*(\d+)\s*\}/g;
    let m;
    while ((m = entryRe.exec(scMatch[1])) !== null) r.scaleMap[m[1]] = parseInt(m[2], 10);
  }

  const baMatch = src.match(/BOOLEAN_ATTRIBUTES\s*=\s*\{([\s\S]*?)\};/);
  if (baMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}/g;
    let m;
    while ((m = entryRe.exec(baMatch[1])) !== null) r.booleanAttrs[m[1]] = m[2];
  }

  const vnMatch = src.match(/VALUE_NAMES\s*=\s*\{([\s\S]*?)\};/);
  if (vnMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\}/g;
    let m;
    while ((m = entryRe.exec(vnMatch[1])) !== null)
      r.valueNames.push({ key: m[1], unit: m[2] || null });
  }

  const valuesBlockMatch = src.match(/vector<double>\s+values\s*=\s*\{([\s\S]*?)\};/);
  if (valuesBlockMatch && r.valueNames.length > 0) {
    const block = valuesBlockMatch[1];
    const entries = [];
    let depth = 0, current = '';
    for (const ch of block) {
      if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth--; current += ch; }
      else if (ch === ',' && depth === 0) { entries.push(current.trim()); current = ''; }
      else current += ch;
    }
    if (current.trim()) entries.push(current.trim());

    for (let i = 0; i < entries.length && i < r.valueNames.length; i++) {
      const multMatch = entries[i].match(/\*\s*([\d.]+)\s*\.?\s*$/);
      if (multMatch) {
        const mult = parseFloat(multMatch[1]);
        if (!isNaN(mult) && mult !== 1) {
          r.valueNames[i].displayMultiplier = mult;
        }
      }
    }
  }

  for (const [field, target] of [['PERCENT_NAMES', r.percentNames], ['OTHER_NAMES', r.otherNames]]) {
    const match = src.match(new RegExp(`${field}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    if (match) {
      const strRe = /"([^"]+)"/g;
      let m;
      while ((m = strRe.exec(match[1])) !== null) target.push(m[1].replace(/:$/, '').trim());
    }
  }

  for (const [field, target] of [['EXPECTED_NEGATIVE', r.expectedNegative], ['\\bBEFORE\\b', r.beforeAttrs]]) {
    const match = src.match(new RegExp(`${field}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    if (match) {
      const strRe = /"([^"]+)"/g;
      let m;
      while ((m = strRe.exec(match[1])) !== null) target.push(m[1]);
    }
  }

  return r;
}

// ---------------------------------------------------------------------------
// Parse Ship.cpp
// ---------------------------------------------------------------------------

function parseShipCpp(src) {
  const allFnBodies = extractFunctionBodies(src, 'Ship::');
  const parsed      = {};

  for (const [fnName, info] of Object.entries(allFnBodies)) {
    const { body, returnType, params, isConst } = info;
    const returns   = extractReturns(body);
    const attrKeys  = extractAllAttributeKeys(body);
    const setKeys   = extractSetKeys(body);
    if (attrKeys.length === 0 && returns.length === 0) continue;
    const sentBody = sentinelizeGetCalls(body);
    const varMap   = extractVarMap(sentBody);
    const attrVars = {};
    for (const [name, def] of Object.entries(varMap)) {
      const cleanDef = def.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']');
      if (def.includes('\u27e6') || /^[A-Z][a-zA-Z]+\s*\(/.test(def))
        attrVars[name] = cleanDef;
    }
    parsed[fnName] = {
      returnType, params, isConst,
      attributesRead: attrKeys,
      attributesSet:  setKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })),
      attributeVariables: attrVars,
    };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Parse ShipInfoDisplay.cpp
// ---------------------------------------------------------------------------

function parseShipInfoDisplay(src) {
  const r = {
    tableRows:        [],
    attributeLabels:  [],
    capacityNames:    [],
    intermediateVars: {},
    allAttributeKeys: extractAllAttributeKeys(src),
  };

  const fnBodies   = extractFunctionBodies(src, 'ShipInfoDisplay::');
  const updateBody = fnBodies['UpdateAttributes']?.body || src;
  const sentBody   = sentinelizeGetCalls(updateBody);
  const varMap     = extractVarMap(sentBody);

  for (const [name, def] of Object.entries(varMap)) {
    const cleanDef = def.replace(/\u27e6/g, '[').replace(/\u27e7/g, ']');
    if (def.includes('\u27e6') || /^[A-Z][a-zA-Z]+\s*\(/.test(def)) {
      const opens  = (cleanDef.match(/\(/g) || []).length;
      const closes = (cleanDef.match(/\)/g) || []).length;
      if (opens === closes)           r.intermediateVars[name] = cleanDef;
      else if (opens > closes)        r.intermediateVars[name] = cleanDef + ')'.repeat(opens - closes);
    }
  }

  if (!r.intermediateVars['movingEnergyPerFrame'])
    r.intermediateVars['movingEnergyPerFrame'] =
      'max([thrusting energy], [reverse thrusting energy]) + [turning energy]';

  {
    let pos = 0;
    while (true) {
      const tlIdx = updateBody.indexOf('tableLabels.push_back(', pos);
      if (tlIdx === -1) break;
      const argStart = tlIdx + 'tableLabels.push_back('.length;
      const { arg: labelArg, end: afterLabel } = extractParenArg(updateBody, argStart);
      pos = afterLabel;
      const searchWindow = updateBody.slice(pos, pos + 200);
      const eMatch = searchWindow.match(/energyTable\.push_back\s*\(/);
      if (!eMatch) continue;
      const eArgStart = pos + eMatch.index + eMatch[0].length;
      const { arg: energyArg, end: afterEnergy } = extractParenArg(updateBody, eArgStart);
      pos = afterEnergy;
      const searchWindow2 = updateBody.slice(pos, pos + 600);
      const hMatch = searchWindow2.match(/heatTable\.push_back\s*\(/);
      if (!hMatch) continue;
      const hArgStart = pos + hMatch.index + hMatch[0].length;
      const { arg: heatArg, end: afterHeat } = extractParenArg(updateBody, hArgStart);
      pos = afterHeat;
      r.tableRows.push({
        label:         parseLabelArg(labelArg),
        rawLabelArg:   labelArg,
        energyFormula: buildFormula(energyArg, updateBody),
        heatFormula:   buildFormula(heatArg, updateBody),
        rawEnergyExpr: energyArg,
        rawHeatExpr:   heatArg,
      });
    }
  }

  {
    const strictPairRe = /attributeLabels\.push_back\s*\(((?:"[^"]*"|[^)]+))\)\s*;\s*(?:\/\/[^\n]*)?\n?\s*attributeValues\.push_back\s*\(((?:[^()]+|\([^()]*\)(?:[^()]*\([^()]*\))*[^()]*)*)\)\s*;/g;
    let m;
    while ((m = strictPairRe.exec(updateBody)) !== null) {
      const label = parseLabelArg(m[1]);
      if (!label) continue;
      r.attributeLabels.push({ label, formula: buildFormula(m[2].trim(), updateBody), rawExpr: m[2].trim() });
    }
  }

  const namesMatch = updateBody.match(/\bNAMES\s*=\s*\{([\s\S]*?)\};/);
  if (namesMatch) {
    const strRe   = /"([^"]+)"/g;
    const entries = [];
    let m;
    while ((m = strRe.exec(namesMatch[1])) !== null) entries.push(m[1]);
    for (let i = 0; i + 1 < entries.length; i += 2)
      r.capacityNames.push({ displayLabel: entries[i].replace(/:$/, '').trim(), attributeKey: entries[i + 1].trim() });
  }

  return r;
}

// ---------------------------------------------------------------------------
// Parse Outfit.cpp
// ---------------------------------------------------------------------------

function parseOutfitCpp(src) {
  const stackingRules = {};

  const moMatch = src.match(/MINIMUM_OVERRIDES\s*=\s*map<[^>]+>\s*\{([\s\S]*?)\};/);
  if (moMatch) {
    const entryRe = /\{\s*"([^"]+)"\s*,\s*(-?[\d.]+)\s*\}/g;
    let m;
    while ((m = entryRe.exec(moMatch[1])) !== null) {
      const key = m[1];
      const min = parseFloat(m[2]);
      if (min === -0.99) {
        stackingRules[key] = { stacking: 'additive',
          stackingDescription: 'Summed additively. Applied in formulas as (1 + sum), so e.g. 0.5 gives 33% reduction.',
          isProtection: true };
      } else if (min === -1.0) {
        stackingRules[key] = { stacking: 'additive',
          stackingDescription: 'Summed additively. Applied in formulas as (1 + sum), so e.g. 1.0 doubles the stat.',
          isMultiplier: true };
      } else if (min === 0.0 && !stackingRules[key]) {
        stackingRules[key] = { stacking: 'additive',
          stackingDescription: 'Values sum directly across all installed outfits.' };
      }
    }
  }

  const sentSrc = sentinelizeGetCalls(src);
  let m;
  const minRe = /\bmin\s*\([^)]*\u27e6([^\u27e7]+)\u27e7[^)]*\)/g;
  while ((m = minRe.exec(sentSrc)) !== null)
    stackingRules[m[1]] = { stacking: 'minimum', stackingDescription: 'Takes the lowest value among all installed outfits.' };
  const maxRe = /\bmax\s*\([^)]*\u27e6([^\u27e7]+)\u27e7[^)]*\)/g;
  while ((m = maxRe.exec(sentSrc)) !== null)
    if (!stackingRules[m[1]])
      stackingRules[m[1]] = { stacking: 'maximum', stackingDescription: 'Takes the highest value among all installed outfits.' };

  for (const key of extractAllAttributeKeys(src))
    if (!stackingRules[key])
      stackingRules[key] = { stacking: 'additive', stackingDescription: 'Values sum directly across all installed outfits.' };

  return stackingRules;
}

// ---------------------------------------------------------------------------
// Parse Weapon.cpp, DamageDealt, JumpNav
// ---------------------------------------------------------------------------

function parseWeaponCpp(src) {
  const fnBodies     = extractFunctionBodies(src, 'Weapon::');
  const functions    = {};
  const dataFileKeys = new Set();
  const submunitionKeys = ['submunition', 'ammo', 'cluster', 'stream'];

  for (const [fnName, info] of Object.entries(fnBodies)) {
    const { body, returnType, params, isConst } = info;
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);
    if (fnName === 'Load') {
      const keyRe = /\bkey\s*==\s*"([^"]+)"/g;
      let m;
      while ((m = keyRe.exec(body)) !== null) dataFileKeys.add(m[1]);
    }
    if (returns.length === 0 && attrKeys.length === 0) continue;
    functions[fnName] = { returnType, params, isConst, attributesRead: attrKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })) };
  }
  return { functions, dataFileKeys: [...dataFileKeys].sort(), submunitionKeys };
}

function parseDamageDealt(hSrc, cppSrc) {
  const types   = new Set();
  const combined = (hSrc || '') + '\n' + (cppSrc || '');
  const declRe  = /\bdouble\s+(\w+)\s*\(\s*\)\s*const\s*(?:noexcept)?\s*;/g;
  let m;
  while ((m = declRe.exec(hSrc || '')) !== null)        types.add(m[1]);
  const defRe = /\bdouble\s+DamageDealt::(\w+)\s*\(\s*\)/g;
  while ((m = defRe.exec(combined)) !== null)            types.add(m[1]);
  const inlineRe = /DamageDealt::(\w+)\s*\(\s*\)\s*const\s*noexcept\s*\{/g;
  while ((m = inlineRe.exec(hSrc || '')) !== null)       types.add(m[1]);
  return [...types].sort();
}

function parseJumpNav(src) {
  if (!src) return {};
  const parsed = {};
  for (const [fnName, info] of Object.entries(extractFunctionBodies(src, 'ShipJumpNavigation::'))) {
    const { body, returnType, params, isConst } = info;
    const returns  = extractReturns(body);
    const attrKeys = extractAllAttributeKeys(body);
    if (returns.length === 0 && attrKeys.length === 0) continue;
    parsed[fnName] = { returnType, params, isConst, attributesRead: attrKeys,
      formulas: returns.map(ret => ({ rawReturn: ret, formula: buildFormula(ret, body) })) };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Parse system data
// ---------------------------------------------------------------------------

function parseSystemContext(solText) {
  const context = {
    referenceSolarPower: 1.0, referenceSystemName: 'Sol',
    notes: [
      'Solar power 1.0 = standard habitable zone of a Sol-type star.',
      'solar collection actual output = attr * system.solarPower.',
      'ramscoop fuel/s = 0.03 * sqrt(system.solarPower) * attr.',
    ],
  };
  if (solText && /^system\s+Sol\s*$/m.test(solText)) {
    context.referenceSystemName = 'Sol';
    context.referenceSolarPower = 1.0;
  }
  return context;
}

// ---------------------------------------------------------------------------
// Status effect decay (unchanged)
// ---------------------------------------------------------------------------

function parseStatusEffectDecay(shipCppSrc) {
  const CANONICAL_EFFECTS = [
    { statName: 'ionization', resistKey: 'ion resistance',        protectionKey: 'ion protection',
      damageKey: 'ion damage',        label: 'Ion',        effectType: 'firing-gate',      shieldInteraction: 'half',
      description: 'Accumulates when hit by ion weapons. Ionization > energy prevents movement-energy weapons from firing (IsIonized). Decays 1%/frame plus up to [ion resistance] per frame.',
      costKeys: ['ion resistance energy', 'ion resistance fuel', 'ion resistance heat'] },
    { statName: 'scrambling', resistKey: 'scramble resistance',   protectionKey: 'scramble protection',
      damageKey: 'scrambling damage', label: 'Scrambling', effectType: 'weapon-jam',       shieldInteraction: 'half',
      description: 'Accumulates when hit by scrambling weapons. Causes weapons to jam: scrambling > 0.1 ? 1 - pow(2, -scrambling/70) : 0. Decays 1%/frame plus up to [scramble resistance] per frame.',
      costKeys: ['scramble resistance energy', 'scramble resistance fuel', 'scramble resistance heat'] },
    { statName: 'disruption', resistKey: 'disruption resistance', protectionKey: 'disruption protection',
      damageKey: 'disruption damage', label: 'Disruption', effectType: 'shield-multiplier', shieldInteraction: 'half',
      description: 'NOT HP damage. Multiplies shield damage received: shieldDmg *= (1 + disruption * 0.01). Decays 1%/frame plus up to [disruption resistance] per frame.',
      costKeys: ['disruption resistance energy', 'disruption resistance fuel', 'disruption resistance heat'] },
    { statName: 'slowing',    resistKey: 'slowing resistance',    protectionKey: 'slowing protection',
      damageKey: 'slowing damage',    label: 'Slowing',    effectType: 'speed-reduction',  shieldInteraction: 'half',
      description: 'NOT HP damage. Reduces thrust and turn rate: speed *= 1/(1 + slowing*0.05). Decays 1%/frame plus up to [slowing resistance] per frame.',
      costKeys: ['slowing resistance energy', 'slowing resistance fuel', 'slowing resistance heat'] },
    { statName: 'discharge',  resistKey: 'discharge resistance',  protectionKey: 'discharge protection',
      damageKey: 'discharge damage',  label: 'Discharge',  effectType: 'shield-dot',       shieldInteraction: 'full',
      description: 'Drains shields by [discharge] per frame (DoT). Always full effect regardless of shields. Decays 1%/frame plus up to [discharge resistance] per frame.',
      costKeys: ['discharge resistance energy', 'discharge resistance fuel', 'discharge resistance heat'] },
    { statName: 'corrosion',  resistKey: 'corrosion resistance',  protectionKey: 'corrosion protection',
      damageKey: 'corrosion damage',  label: 'Corrosion',  effectType: 'hull-dot',         shieldInteraction: 'blocked',
      description: 'Drains hull by [corrosion] per frame (DoT). Ignored entirely when shields are up. Decays 1%/frame plus up to [corrosion resistance] per frame.',
      costKeys: ['corrosion resistance energy', 'corrosion resistance fuel', 'corrosion resistance heat'] },
    { statName: 'burn',       resistKey: 'burn resistance',       protectionKey: 'burn protection',
      damageKey: 'burn damage',       label: 'Burn',       effectType: 'heat-dot',         shieldInteraction: 'half',
      description: 'Adds [burn] heat per frame (DoT). Cut to 50% when shields are up. Decays 1%/frame plus up to [burn resistance] per frame.',
      costKeys: ['burn resistance energy', 'burn resistance fuel', 'burn resistance heat'] },
    { statName: 'leak',       resistKey: 'leak resistance',       protectionKey: 'leak protection',
      damageKey: 'leak damage',       label: 'Leak',       effectType: 'fuel-dot',         shieldInteraction: 'blocked',
      description: 'Drains fuel by [leak] per frame (DoT). Ignored entirely when shields are up. Decays 1%/frame plus up to [leak resistance] per frame.',
      costKeys: ['leak resistance energy', 'leak resistance fuel', 'leak resistance heat'] },
  ];

  const decayMap    = {};
  for (const e of CANONICAL_EFFECTS) decayMap[e.statName] = e.resistKey;

  const descriptors = CANONICAL_EFFECTS.map(e => ({
    ...e,
    decayFormula: `stat = max(0, 0.99 * stat - min([${e.resistKey}], 0.99 * stat))`,
    passiveHalfLifeFrames: Math.round(Math.log(0.5) / Math.log(0.99)),
    ...(e.statName === 'scrambling' ? {
      jamChanceFormula: 'scrambling > 0.1 ? 1 - pow(2, -scrambling/70) : 0',
    } : {}),
  }));

  return { decayMap, descriptors };
}

// ---------------------------------------------------------------------------
// parseShipTakeDamage (unchanged)
// ---------------------------------------------------------------------------

function parseShipTakeDamage(shipCppSrc) {
  const details = new Map();
  if (!shipCppSrc) return details;

  const takeDmgMatch = shipCppSrc.match(/\bTakeDamage\s*\([^)]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/);
  if (!takeDmgMatch) return details;

  const bodyStart = takeDmgMatch.index + takeDmgMatch[0].length;
  let depth = 1, i = bodyStart;
  while (i < shipCppSrc.length && depth > 0) {
    if (shipCppSrc[i] === '{') depth++;
    else if (shipCppSrc[i] === '}') depth--;
    i++;
  }
  const body = shipCppSrc.slice(bodyStart, i - 1);

  const allAccessors = new Set();
  const allAccessorRe = /damage\.([A-Z][a-zA-Z]+)\s*\(\s*\)/g;
  let m;
  while ((m = allAccessorRe.exec(body)) !== null) allAccessors.add(m[1]);

  const blockedTypes = new Set();
  const blockedBlockRe = /if\s*\(\s*!shields?\b[^)]*\)\s*\{([^}]*)\}/g;
  while ((m = blockedBlockRe.exec(body)) !== null) {
    const blockBody = m[1];
    const accRe = /damage\.([A-Z][a-zA-Z]+)\s*\(\s*\)/g;
    let am;
    while ((am = accRe.exec(blockBody)) !== null) blockedTypes.add(am[1]);
  }

  const halfTypes = new Set();
  const shieldFracRe = /damage\.([A-Z][a-zA-Z]+)\s*\(\s*\)\s*\*\s*shieldFraction/g;
  while ((m = shieldFracRe.exec(body)) !== null) halfTypes.add(m[1]);

  const hpTypes = new Set();
  if (/damage\.Shield\s*\(\s*\)/.test(body)) hpTypes.add('Shield');
  if (/damage\.Hull\s*\(\s*\)/.test(body))   hpTypes.add('Hull');

  const resourceTypes = new Set();
  if (/damage\.Energy\s*\(\s*\)/.test(body)) resourceTypes.add('Energy');
  if (/damage\.Heat\s*\(\s*\)/.test(body))   resourceTypes.add('Heat');
  if (/damage\.Fuel\s*\(\s*\)/.test(body))   resourceTypes.add('Fuel');

  for (const typeName of allAccessors) {
    let shieldInteraction, category;
    if (hpTypes.has(typeName)) {
      shieldInteraction = 'direct'; category = 'hp';
    } else if (blockedTypes.has(typeName)) {
      shieldInteraction = 'blocked'; category = 'status';
    } else if (resourceTypes.has(typeName)) {
      shieldInteraction = 'half'; category = 'resource';
    } else if (halfTypes.has(typeName)) {
      shieldInteraction = 'half'; category = 'status';
    } else {
      shieldInteraction = 'full'; category = 'status';
    }
    details.set(typeName, { shieldInteraction, category });
  }

  return details;
}

// ---------------------------------------------------------------------------
// NEW: deriveDamageTypesStructurally(opts)
//
// Zero-hardcoded-type-list discovery of DamageDealt's real per-resource
// damage types, ADDED alongside (not replacing) parseDamageDealt() and
// parseShipTakeDamage() above — both of those stay completely untouched,
// still exported, still usable by anything that already depends on them.
// This function returns the SAME two pieces of information those two
// functions together used to produce — { damageTypes, shipCppDetails } —
// in the same shapes buildDamageTypeDetails() already expects, so it's a
// drop-in substitute at the one call site in parseAttributes() below, with
// no changes needed anywhere further downstream.
//
// Method (see the header comment block at the top of this file for the
// full rationale):
//   A. Structurally locate DamageDealt's "aggregate resource accessor" —
//      not by name, but by finding the public zero-arg const method whose
//      declared return type matches a PRIVATE member's declared type (the
//      ordinary C++ getter pattern). Whatever that accessor is called
//      this year, this finds it without hardcoding "Levels".
//   B. Follow DamageDealt.h's own #include lines to the header that
//      defines that return type, fetch it, and parse its double-typed
//      member fields — the raw, current per-resource field names.
//   C. Cross-reference against Weapon::Load's own literal `key == "..."`
//      data-file keys (already parsed by parseWeaponCpp above with zero
//      hardcoding) that end in " damage" — this supplies the correctly
//      cased canonical type names ("Shield", "Ion", "Scrambling", ...)
//      the rest of the app expects, since raw struct field names don't
//      match 1:1 (shields/ionization/leakage/burning vs. the attribute-
//      key convention shield/ion/leak/burn).
//   D. Reconcile B onto C via a generic shared-prefix similarity check —
//      not a synonym table — to carry shieldInteraction/category info
//      across. Union, not intersection: any canonical type Step C finds
//      that Step B can't confirm (e.g. "Minable", "Disabled", which
//      aren't ResourceLevels fields at all) is still kept, since an extra
//      entry is harmless downstream (the battle simulator's damage-apply
//      switch just no-ops on types it doesn't recognize) while a missing
//      real type silently breaks combat math — which is exactly the bug
//      this function exists to fix.
//
// Never throws. On any failure (network, unexpected header shape, pattern
// not found) it returns { ok: false, warnings: [...] } and the caller
// falls back to the existing parseDamageDealt()/parseShipTakeDamage() pair.
// ---------------------------------------------------------------------------

async function deriveDamageTypesStructurally(opts) {
  const { damageDealtHSrc, shipCppSrc, weaponDataFileKeys, fetchTextFn, esRawBase } = opts;
  const warnings = [];

  if (!damageDealtHSrc) return { ok: false, warnings: ['DamageDealt.h source not available'] };

  // ---- Step C: canonical type names from Weapon::Load's own data keys ----
  const canonicalTypes = [];
  for (const key of (weaponDataFileKeys || [])) {
    if (!/ damage$/i.test(key)) continue;
    const base = key.replace(/^%\s*/, '').replace(/^relative\s+/i, '').replace(/\s*damage\s*$/i, '').trim();
    if (!base) continue;
    const titled = base.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    if (!canonicalTypes.includes(titled)) canonicalTypes.push(titled);
  }
  if (canonicalTypes.length === 0) {
    return { ok: false, warnings: ['No " damage"-suffixed keys found in Weapon::Load data keys — cannot derive a canonical type list'] };
  }

  // ---- Step A: structurally find the aggregate resource accessor ----
  const PRIMITIVE_TYPES = new Set(['double', 'int', 'bool', 'float', 'size_t', 'int64_t', 'string', 'Point', 'Weapon']);
  const accessorRe = /\b((?:const\s+)?[\w:]+(?:\s*[&*])?)\s*(\w+)\s*\(\s*\)\s*const\s*(?:noexcept\s*)?;/g;
  const accessors = [];
  let m;
  while ((m = accessorRe.exec(damageDealtHSrc)) !== null) {
    const rawType = m[1].replace(/\bconst\b/g, '').replace(/[&*]/g, '').trim();
    accessors.push({ name: m[2], type: rawType });
  }

  const privateIdx = damageDealtHSrc.indexOf('private:');
  const privateSection = privateIdx >= 0 ? damageDealtHSrc.slice(privateIdx) : '';
  const memberRe = /(?:^|\n)[ \t]*(?:const\s+)?([A-Za-z_]\w*)\s+(\w+)\s*(?:=\s*[^;]+)?;/g;
  const members = [];
  while ((m = memberRe.exec(privateSection)) !== null) members.push({ type: m[1].trim(), name: m[2] });

  let discovered = null;
  for (const acc of accessors) {
    if (PRIMITIVE_TYPES.has(acc.type)) continue;
    const owner = members.find(mem => mem.type === acc.type);
    if (owner) { discovered = { accessorName: acc.name, structTypeName: acc.type }; break; }
  }

  if (!discovered) {
    warnings.push('Could not structurally locate the DamageDealt aggregate-resource accessor ' +
      '(no public zero-arg const method whose return type matches a private member type). ' +
      'Falling back to the Weapon::Load-derived type list with no shieldInteraction/category enrichment.');
    return { ok: true, damageTypes: canonicalTypes, shipCppDetails: new Map(), warnings };
  }

  // ---- Step B: fetch & parse the discovered struct's own header ----
  const includeRe = /#include\s+"([^"]+\.h)"/g;
  let headerPath = null;
  const targetLower = discovered.structTypeName.toLowerCase();
  while ((m = includeRe.exec(damageDealtHSrc)) !== null) {
    const base = m[1].split('/').pop().replace(/\.h$/i, '').toLowerCase();
    if (base === targetLower) { headerPath = m[1]; break; }
  }

  let structFields = [];
  if (headerPath && fetchTextFn && esRawBase) {
    try {
      const structSrc = await fetchTextFn(`${esRawBase}/${headerPath}`);
      const classRe = new RegExp(`\\b(?:class|struct)\\s+${discovered.structTypeName}\\b[^{;]*\\{`);
      const cm = classRe.exec(structSrc);
      if (cm) {
        let depth = 1, i = cm.index + cm[0].length;
        while (i < structSrc.length && depth > 0) {
          if (structSrc[i] === '{') depth++;
          else if (structSrc[i] === '}') depth--;
          i++;
        }
        const body = structSrc.slice(cm.index + cm[0].length, i - 1);
        const fieldRe = /\b(?:double|float)\s+(\w+)\s*(?:=\s*[^;,{]+)?\s*[;,]/g;
        let fm;
        while ((fm = fieldRe.exec(body)) !== null) structFields.push(fm[1]);
      } else {
        warnings.push(`Fetched ${headerPath} but could not find a class/struct body named ${discovered.structTypeName}.`);
      }
    } catch (err) {
      warnings.push(`Failed to fetch ${headerPath}: ${err.message}`);
    }
  } else {
    warnings.push(`Could not find an #include for struct type "${discovered.structTypeName}" in DamageDealt.h.`);
  }

  // ---- shieldInteraction/category detection, re-pointed at the discovered accessor ----
  const shipCppDetails = new Map();
  if (shipCppSrc && structFields.length) {
    const takeDmgMatch = shipCppSrc.match(/\bTakeDamage\s*\([^)]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/);
    if (takeDmgMatch) {
      const bodyStart = takeDmgMatch.index + takeDmgMatch[0].length;
      let depth = 1, i = bodyStart;
      while (i < shipCppSrc.length && depth > 0) {
        if (shipCppSrc[i] === '{') depth++;
        else if (shipCppSrc[i] === '}') depth--;
        i++;
      }
      const body = shipCppSrc.slice(bodyStart, i - 1);

      const accessorEsc = discovered.accessorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const fieldPattern = structFields.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const fieldRe = new RegExp(`damage\\.${accessorEsc}\\s*\\(\\s*\\)\\s*\\.\\s*(${fieldPattern})\\b`, 'g');

      const seenFields = new Set();
      let fm;
      while ((fm = fieldRe.exec(body)) !== null) seenFields.add(fm[1]);

      const blockedFields = new Set();
      const blockedBlockRe = /if\s*\(\s*!shields?\b[^)]*\)\s*\{([^}]*)\}/g;
      let bm;
      while ((bm = blockedBlockRe.exec(body)) !== null) {
        const innerRe = new RegExp(`damage\\.${accessorEsc}\\s*\\(\\s*\\)\\s*\\.\\s*(${fieldPattern})\\b`, 'g');
        let im;
        while ((im = innerRe.exec(bm[1])) !== null) blockedFields.add(im[1]);
      }

      const halfFields = new Set();
      const shieldFracRe = new RegExp(`damage\\.${accessorEsc}\\s*\\(\\s*\\)\\s*\\.\\s*(${fieldPattern})\\s*\\*\\s*shieldFraction`, 'g');
      let sm;
      while ((sm = shieldFracRe.exec(body)) !== null) halfFields.add(sm[1]);

      const hpFields = new Set(structFields.filter(f => /^(shields?|hull)$/i.test(f)));

      // Generic shared-prefix fuzzy match — NOT a hardcoded synonym table.
      // Correctly lines up e.g. "ionization"<->"Ion", "leakage"<->"Leak",
      // "burning"<->"Burn", "shields"<->"Shield", "slowness"<->"Slowing".
      const fuzzyMatch = (canonical, raw) => {
        const a = canonical.toLowerCase().replace(/\s+/g, '');
        const b = raw.toLowerCase();
        if (a === b) return true;
        const shorter = a.length < b.length ? a : b;
        const longer  = a.length < b.length ? b : a;
        return shorter.length >= 3 && longer.startsWith(shorter.slice(0, Math.min(shorter.length, 4)));
      };

      for (const field of seenFields) {
        const canonical = canonicalTypes.find(t => fuzzyMatch(t, field));
        if (!canonical) continue;
        let shieldInteraction, category;
        if (hpFields.has(field))                       { shieldInteraction = 'direct';  category = 'hp'; }
        else if (blockedFields.has(field))              { shieldInteraction = 'blocked'; category = 'status'; }
        else if (halfFields.has(field))                 { shieldInteraction = 'half';    category = 'status'; }
        else if (/^(energy|heat|fuel)$/i.test(field))   { shieldInteraction = 'half';    category = 'resource'; }
        else                                             { shieldInteraction = 'full';    category = 'status'; }
        shipCppDetails.set(canonical, { shieldInteraction, category });
      }
    } else {
      warnings.push('Could not find Ship::TakeDamage() body for shieldInteraction/category enrichment.');
    }
  }

  return { ok: true, damageTypes: canonicalTypes, shipCppDetails, discovered, warnings };
}

// ---------------------------------------------------------------------------
// buildDamageTypeDetails (unchanged)
// ---------------------------------------------------------------------------

function buildDamageTypeDetails(damageTypeNames, statusDescriptors, shipCppDetails) {
  const result = [];

  const descByDmgBase = {};
  for (const d of statusDescriptors) {
    if (d.damageKey) {
      const base = d.damageKey.replace(/ damage$/, '').toLowerCase();
      descByDmgBase[base] = d;
    }
  }

  for (const typeName of damageTypeNames) {
    const cpuDetail = shipCppDetails.get(typeName) || {};
    const desc      = descByDmgBase[typeName.toLowerCase()] || {};
    const statName  = desc.statName || null;
    const isStatus  = !!statName;
    const isHp      = cpuDetail.category === 'hp'       || (!isStatus && (typeName === 'Shield' || typeName === 'Hull'));
    const isRes     = cpuDetail.category === 'resource' || (!isStatus && !isHp);

    const shieldInteraction = cpuDetail.shieldInteraction
      ?? desc.shieldInteraction
      ?? (isHp ? 'direct' : 'half');

    const category = cpuDetail.category
      ?? (isHp ? 'hp' : isRes ? 'resource' : 'status');

    const resourceKey  = typeName.toLowerCase() + ' damage';
    const relativeKey  = (typeName === 'Shield') ? '% shield damage'
                       : (typeName === 'Hull')   ? '% hull damage'
                       : null;
    const protectionKey = desc.protectionKey ?? (typeName.toLowerCase() + ' protection');
    const resistanceKey = desc.resistKey     ?? null;

    let applyFormula = '';
    if (isHp) {
      if (typeName === 'Shield') {
        applyFormula =
          `effectivePiercing = clamp(piercing, 0, 1) * (1 - [piercing resistance])\n` +
          `disruptMult = 1 + statusEffects.disruption * 0.01\n` +
          `rawDmg = ([${resourceKey}]${relativeKey ? ` + [${relativeKey}] * currentShields` : ''}) * (1 - [${protectionKey}]) * disruptMult\n` +
          `if shields > 0:\n` +
          `    shields -= rawDmg * (1 - effectivePiercing)\n` +
          `    hull    -= rawDmg * effectivePiercing\n` +
          `    if shields < 0: hull += shields * bleedFraction * (1 - [hull protection]); shields = 0\n` +
          `else:\n` +
          `    hull -= [${resourceKey}]${relativeKey ? ` + [${relativeKey}] * maxShields` : ''} * (1 - [${protectionKey}])`;
      } else {
        applyFormula =
          `effectivePiercing = clamp(piercing, 0, 1) * (1 - [piercing resistance])\n` +
          `rawDmg = ([${resourceKey}]${relativeKey ? ` + [${relativeKey}] * currentHull` : ''}) * (1 - [${protectionKey}])\n` +
          `if shields > 0: hull -= rawDmg * effectivePiercing\n` +
          `else:           hull -= rawDmg`;
      }
    } else if (isRes) {
      const gate = shieldInteraction === 'half' ? ' * (shieldsUp ? 0.5 : 1.0)' : '';
      applyFormula =
        `rawDmg = [${resourceKey}]${relativeKey ? ` + [${relativeKey}] * maxCapacity` : ''} * (1 - [${protectionKey}])\n` +
        `${typeName.toLowerCase()} -= rawDmg${gate}`;
    } else {
      const gate = shieldInteraction === 'half'    ? ' * (shieldsUp ? 0.5 : 1.0)'
                 : shieldInteraction === 'blocked' ? ' * (shieldsUp ? 0.0 : 1.0)'
                 : '';
      applyFormula =
        `dose = [${resourceKey}] * (1 - [${protectionKey}])${gate}\n` +
        `statusEffects.${statName} += dose\n` +
        `// Per-frame decay (Ship.cpp DoStatusEffect):\n` +
        `statusEffects.${statName} = max(0, 0.99 * statusEffects.${statName} - min([${resistanceKey}], 0.99 * statusEffects.${statName}))`;
      if (desc.jamChanceFormula)
        applyFormula += `\n// Per-fire jam check:\njamChance = ${desc.jamChanceFormula}`;
    }

    const description = desc.description || (
      isHp  ? `Directly reduces ${typeName.toLowerCase()} HP. Protected by [${protectionKey}].` :
      isRes ? `Instantly drains ${typeName.toLowerCase()}. ` +
              (shieldInteraction === 'half' ? 'Cut to 50% when shields are up. ' : '') +
              `Protected by [${protectionKey}].` :
              `Adds to ${statName} status. ` +
              (shieldInteraction === 'blocked' ? 'Ignored entirely when shields are up. ' :
               shieldInteraction === 'full'    ? 'Always full effect regardless of shields. ' :
               'Cut to 50% when shields are up. ') +
              `Protected by [${protectionKey}], decays with [${resistanceKey}].`
    );

    result.push({
      typeName, category, resourceKey, relativeKey, shieldInteraction,
      statusEffect: statName, resistanceKey, protectionKey,
      description, applyFormula,
      notes: cpuDetail.notes ?? desc.notes ?? [],
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// inferFunctionDisplayScale (unchanged)
// ---------------------------------------------------------------------------

function inferFunctionDisplayScale(attributesRead, attrDict, formula, fnName) {
  const primaryMultipliers = [];
  for (const key of (attributesRead || [])) {
    const rec = attrDict[key];
    if (!rec || (rec.displayUnit || '') === '%') continue;
    const mult = rec.displayMultiplier;
    if (mult && mult !== 1) primaryMultipliers.push(mult);
  }
  let scale = 1;
  if (primaryMultipliers.length > 0) {
    const allSame = primaryMultipliers.every(m => m === primaryMultipliers[0]);
    scale = allSame ? primaryMultipliers[0] : Math.max(...primaryMultipliers);
  }
  if (/velocity/i.test(fnName) && formula && formula.includes('Drag')) scale = 60;
  const unit       = scale === 3600 ? '/s²' : scale === 60 ? '/s' : scale === 6000 ? '%/s' : '';
  const labelPrefix = (formula && formula.includes('withAfterburner') && /velocity|speed/i.test(fnName)) ? 'Base ' : '';
  return { displayScale: scale, displayUnit: unit, labelPrefix };
}

function annotateShipFunctionScales(shipFns, attrs) {
  for (const [fnName, fnData] of Object.entries(shipFns)) {
    if (!fnData) continue;
    const formula = fnData.formulas?.[fnData.formulas.length - 1]?.formula ?? '';
    const { displayScale, displayUnit, labelPrefix } =
      inferFunctionDisplayScale(fnData.attributesRead, attrs, formula, fnName);
    fnData.displayScale = displayScale;
    fnData.displayUnit  = displayUnit;
    fnData.labelPrefix  = labelPrefix;
    for (const key of (fnData.attributesRead || [])) {
      const a = attrs[key];
      if (!a) continue;
      if (!a.usedInShipFunctions) a.usedInShipFunctions = [];
      if (!a.usedInShipFunctions.includes(fnName)) a.usedInShipFunctions.push(fnName);
    }
  }
}

// ---------------------------------------------------------------------------
// NEW: deriveMovementSystem(shipFns)
//
// See the header comment at the top of this file for the full rationale.
// Summary: build a call graph purely from formula text already present in
// shipFns, seed it with the three functions that exist ONLY for motion
// physics (InertialMass, Drag, DragForce), and take the reverse-reachable
// closure — every function that calls one of those, directly or through a
// chain of other ship-function calls. The attributes referenced anywhere
// in that closure are the ship-movement-relevant attribute set.
// ---------------------------------------------------------------------------

const MOVEMENT_SEED_FUNCTIONS = ['InertialMass', 'Drag', 'DragForce'];

function _extractFnCalls(text, knownFnNames) {
  const calls = new Set();
  if (!text) return calls;
  const re = /\b([A-Z][A-Za-z0-9_]*)\s*\(\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (knownFnNames.has(m[1])) calls.add(m[1]);
  }
  return calls;
}

function deriveMovementSystem(shipFns) {
  const fnNames = new Set(Object.keys(shipFns));

  // 1. Build the call graph: fnName -> Set(calleeNames), scanning every
  //    formula string and every attributeVariable definition for
  //    "OtherFunction()" references that are themselves known ship
  //    functions. Nothing here is a hardcoded name — it's pattern-matched
  //    against the actual set of parsed function names.
  const callGraph = {};
  for (const [fnName, fnData] of Object.entries(shipFns)) {
    const callees = new Set();
    for (const f of (fnData.formulas || []))
      for (const c of _extractFnCalls(f.formula, fnNames)) callees.add(c);
    for (const def of Object.values(fnData.attributeVariables || {}))
      for (const c of _extractFnCalls(def, fnNames)) callees.add(c);
    callGraph[fnName] = callees;
  }

  // 2. Reverse the graph: callee -> Set(callers), so we can walk from a
  //    seed function to everything that (transitively) calls it.
  const reverseGraph = {};
  for (const fnName of fnNames) reverseGraph[fnName] = new Set();
  for (const [caller, callees] of Object.entries(callGraph))
    for (const callee of callees)
      if (reverseGraph[callee]) reverseGraph[callee].add(caller);

  // 3. BFS outward from the seed functions across the reverse graph.
  const seeds = MOVEMENT_SEED_FUNCTIONS.filter(f => fnNames.has(f));
  const movementFns = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.pop();
    for (const caller of (reverseGraph[cur] || [])) {
      if (!movementFns.has(caller)) {
        movementFns.add(caller);
        queue.push(caller);
      }
    }
  }

  // 4. Collect every attribute referenced anywhere in that closure —
  //    both from attributesRead (already extracted by the seed-file
  //    parsers) and by re-scanning formula text directly for "[attr]"
  //    references, so nothing is missed even if attributesRead happened
  //    to come back empty for a given function.
  const movementAttrs = new Set();
  for (const fnName of movementFns) {
    const fnData = shipFns[fnName];
    if (!fnData) continue;
    for (const a of (fnData.attributesRead || [])) movementAttrs.add(a);
    for (const f of (fnData.formulas || [])) {
      const refs = [...(f.formula || '').matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
      for (const a of refs) movementAttrs.add(a);
    }
  }

  return {
    seedFunctions: seeds,
    functions: [...movementFns].sort(),
    attributes: [...movementAttrs].sort(),
    notes: [
      'Derived structurally, not from a hardcoded attribute-name list.',
      'Seeded from InertialMass/Drag/DragForce — the only ship functions ' +
        'that exist purely for motion physics — then expanded to every ' +
        'ship function that calls one of them, directly or transitively, ' +
        'via the real call graph found in each function\'s own formula text.',
      'An attribute can be BOTH movement-relevant here AND isWeaponDataKey ' +
        'elsewhere (e.g. "turn": ship engine turning-force here, missile/' +
        'turret turn rate via a separate outfit.weapon.turn path) — both ' +
        'flags are correct simultaneously, for different contexts.',
    ],
  };
}

// ---------------------------------------------------------------------------
// buildAttributeDictionary (unchanged aside from the new movement tagging)
// ---------------------------------------------------------------------------

function deriveDisplayUnit(multiplier) {
  if (multiplier === 60)   return '/s';
  if (multiplier === 3600) return '/s²';
  if (multiplier === 6000) return '%/s';
  if (multiplier < 1)      return 's';
  return '';
}

function buildAttributeDictionary(oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns, statusEffectDecay) {
  const attrs  = {};
  const ensure = key => { if (!attrs[key]) attrs[key] = { key }; return attrs[key]; };

  for (const [key, idx] of Object.entries(oidData.scaleMap)) {
    const sl = oidData.scaleLabels[idx];
    if (!sl) continue;
    const a = ensure(key);
    a.displayMultiplier  = sl.multiplier;
    a.displayUnit        = sl.unit || deriveDisplayUnit(sl.multiplier);
    a.scaleIndex         = idx;
    a.shownInOutfitPanel = true;
  }
  for (const [key, desc] of Object.entries(oidData.booleanAttrs)) {
    const a = ensure(key);
    a.isBoolean = true; a.description = desc; a.shownInOutfitPanel = true;
  }

  for (const { key, unit, displayMultiplier } of oidData.valueNames) {
    const a = ensure(key);
    a.isWeaponStat = true; a.shownInOutfitPanel = true;
    if (unit) a.displayUnit = unit;
    if (displayMultiplier) a.displayMultiplier = displayMultiplier;
  }
  
  for (const key of oidData.percentNames) {
    ensure(key).isWeaponStat = true;
    ensure(key).displayUnit  = '%';
    ensure(key).shownInOutfitPanel = true;
  }
  for (const key of oidData.otherNames)      { ensure(key).isWeaponStat = true; ensure(key).shownInOutfitPanel = true; }
  for (const key of oidData.expectedNegative) ensure(key).isExpectedNegative = true;
  for (const key of oidData.beforeAttrs)      ensure(key).isPrerequisite = true;

  for (const [key, rule] of Object.entries(outfitStacking)) {
    const a = ensure(key);
    a.stacking            = rule.stacking;
    a.stackingDescription = rule.stackingDescription;
    if (rule.isProtection) a.isProtection = true;
    if (rule.isMultiplier) a.isMultiplier = true;
  }
  for (const { displayLabel, attributeKey } of shipDisplay.capacityNames) {
    const a = ensure(attributeKey); a.shipPanelLabel = displayLabel; a.shownInShipPanel = true;
  }
  for (const key of shipDisplay.allAttributeKeys) ensure(key).shownInShipPanel = true;
  for (const key of (weaponData.dataFileKeys || [])) ensure(key).isWeaponDataKey = true;
  for (const key of oidData.allAttributeKeys) ensure(key);

  for (const desc of (statusEffectDecay.descriptors || [])) {
    const a = ensure(desc.statName);
    a.isStatusEffect   = true;
    a.statusEffectType = desc.effectType;
    a.statusDescription = desc.description;
  }
  for (const desc of (statusEffectDecay.descriptors || [])) {
    ensure(desc.resistKey).isStatusResistance   = true;
    ensure(desc.protectionKey).isStatusProtection = true;
    for (const costKey of (desc.costKeys || [])) ensure(costKey).isStatusResistanceCost = true;
  }
  for (const [fnName, fnData] of Object.entries(jumpNavFns)) {
    for (const key of (fnData.attributesRead || [])) {
      const a = ensure(key);
      if (!a.usedInNavFunctions) a.usedInNavFunctions = [];
      if (!a.usedInNavFunctions.includes(fnName)) a.usedInNavFunctions.push(fnName);
    }
  }
  annotateShipFunctionScales(shipFns, attrs);

  // NEW: tag every attribute the movement-system derivation found, purely
  // additively — this never removes or overrides any other flag.
  const movementSystem = deriveMovementSystem(shipFns);
  for (const key of movementSystem.attributes)
    ensure(key).isMovementRelevant = true;
  attrs.__movementSystem = movementSystem; // stashed; pulled out below into result.movementSystem

  return attrs;
}

// ---------------------------------------------------------------------------
// buildAttributeDictionary_withDmgTypes (unchanged)
// ---------------------------------------------------------------------------

function buildAttributeDictionary_withDmgTypes(
    oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns,
    statusEffectDecay, damageTypeDetails
) {
  const attrs = buildAttributeDictionary(
    oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns, statusEffectDecay
  );

  for (const detail of damageTypeDetails) {
    const pk = detail.protectionKey;
    if (!pk) continue;
    const a = attrs[pk] || (attrs[pk] = { key: pk });
    a.isProtection       = true;
    a.protectionAppliesTo = detail.category === 'status'
      ? `${detail.statusEffect ?? detail.typeName.toLowerCase()} damage dose on hit`
      : `incoming ${detail.typeName.toLowerCase()} damage`;
    a.protectionFormula  = detail.category === 'status'
      ? `effectiveDose = [${detail.resourceKey}] * (1 - [${pk}])`
      : `effectiveDmg = rawDmg * (1 - [${pk}])`;
    a.protectionNote     = `Reduces incoming ${detail.typeName.toLowerCase()} ` +
      `${detail.category === 'status' ? 'dose' : 'damage'} per hit. ` +
      `Stacks additively; clamped to [0, 1] by Outfit.cpp MINIMUM_OVERRIDES.`;
    a.clampRange         = '[0, 1]';
  }

  const pr = attrs['piercing resistance'];
  if (pr) {
    pr.protectionAppliesTo = 'weapon piercing fraction';
    pr.protectionFormula   = 'effectivePiercing = clamp(weapon.piercing, 0, 1) * (1 - [piercing resistance])';
    pr.protectionNote      = 'Reduces the fraction of shield damage that bleeds to hull. Stacks additively; clamped [0, 1].';
    pr.clampRange          = '[0, 1]';
  }

  return attrs;
}

// ---------------------------------------------------------------------------
// NEW: mergeDiscoveredSystemsIntoAttributes(attrs, otherSystems)
//
// Walks every class/function found by the generic discovery pass and:
//   - creates a bare dictionary entry for any attribute key that ISN'T
//     already known (tagged discoveredOnly: true) — these are exactly the
//     attributes the old hardcoded-file-list approach would have silently
//     missed entirely.
//   - tags every attribute (known or new) with usedInOtherSystems so you
//     can see every class/function outside Ship/Outfit/Weapon that reads it.
// ---------------------------------------------------------------------------

function mergeDiscoveredSystemsIntoAttributes(attrs, otherSystems) {
  const newlyDiscovered = new Set();
  for (const [className, fns] of Object.entries(otherSystems)) {
    for (const [fnName, fnData] of Object.entries(fns)) {
      const tag = `${className}::${fnName}`;
      for (const key of (fnData.attributesRead || [])) {
        const isNew = !attrs[key];
        const a = attrs[key] || (attrs[key] = { key, discoveredOnly: true });
        if (isNew) newlyDiscovered.add(key);
        if (!a.usedInOtherSystems) a.usedInOtherSystems = [];
        if (!a.usedInOtherSystems.includes(tag)) a.usedInOtherSystems.push(tag);
      }
      for (const key of (fnData.attributesSet || [])) {
        const isNew = !attrs[key];
        const a = attrs[key] || (attrs[key] = { key, discoveredOnly: true });
        if (isNew) newlyDiscovered.add(key);
        if (!a.setInOtherSystems) a.setInOtherSystems = [];
        if (!a.setInOtherSystems.includes(tag)) a.setInOtherSystems.push(tag);
      }
    }
  }
  return [...newlyDiscovered].sort();
}

// ---------------------------------------------------------------------------
// NEW: mergeDataUsageIntoAttributes(attrs, perKey)
//
// The data/-side counterpart to mergeDiscoveredSystemsIntoAttributes above.
// Same additive philosophy: existing entries just gain new fields; keys
// found ONLY here (never touched by any source-code layer) get a bare
// entry created on the spot, tagged `dataOnly: true`. A key ending up with
// dataOnly still set at classification time means it has real usage in
// shipped content but zero corresponding C++ logic anywhere — the
// "Custom / Modder-Defined" case from attribute-area-classification.md §5.3.
// ---------------------------------------------------------------------------

function mergeDataUsageIntoAttributes(attrs, perKey) {
  const newlyDiscovered = new Set();
  for (const [key, usage] of Object.entries(perKey || {})) {
    const isNew = !attrs[key];
    const a = attrs[key] || (attrs[key] = { key, dataOnly: true });
    if (isNew) newlyDiscovered.add(key);
    a.usedInDataCategories = usage.categories;
    a.dataUsageCount       = usage.count;
    a.dataValueRange       = { min: usage.min, max: usage.max };
    a.dataSampleValues     = usage.samples;
    a.dataOnShip           = usage.onShip;
    a.dataOnOutfit         = usage.onOutfit;
  }
  return [...newlyDiscovered].sort();
}

// ---------------------------------------------------------------------------
// NEW: deriveFrontendArea(attrs, categoryAreaHints)
//
// Implements attribute-area-classification.md §3's priority list verbatim,
// PLUS the category-co-occurrence signal from §5/§6 slotted in as priority
// 0 (per the doc's own note that it "could sit above Layers 1-3" — it's
// evidence of what an attribute is actually FOR in shipped content, the
// strongest signal available). Rule 9 ("Uncategorized / Needs Review") is
// intentionally OMITTED per project decision — unmatched attributes simply
// end up with area: null, and the front end's own final fallback (see
// AttributeSections.js) owns them from there.
//
// Every attribute gets:
//   - area        — the single primary bucket: the first rule (in order)
//                    that matched, or null if nothing did.
//   - areaBadges  — every OTHER rule that also matched but didn't win
//                    primary (dual-role attributes, e.g. "turn": Movement
//                    primary, Weapons badge).
//
// This is a coarse ~10-bucket taxonomy for front ends that want "which
// broad category" without re-deriving it from the flag soup themselves.
// It does NOT replace the finer-grained classification AttributeSections.js
// already does from the same underlying flags — see that file's own notes
// on how the two are combined.
// ---------------------------------------------------------------------------

const AREA = {
  STATUS:         'Status Effects',
  WEAPONS:        'Weapons',
  MOVEMENT:       'Movement & Engines',
  SCANNERS:       'Scanners & Detection',
  PROTECTION:     'Defense / Protection',
  POWER:          'Power, Heat & Life Support',
  ECONOMY:        'Economy',
  SPECIAL:        'Special / Flags',
  GENERAL_OUTFIT: 'General Outfit Stats',
  GENERAL_SHIP:   'General Ship Stats',
  CUSTOM:         'Custom / Modder-Defined',
};

// §3 rule 6's "shield/hull/energy/fuel/heat generation-consumption
// pattern" — a substring test against the key itself, same style as every
// other name-pattern check in this codebase (e.g. AttributeSections.js's
// DOMAIN_WORDS).
const POWER_LIFE_SUPPORT_PATTERN = /shield|hull|energy|fuel|heat/i;

function deriveFrontendArea(attrs, categoryAreaHints) {
  categoryAreaHints = categoryAreaHints || {};
  const areaCounts = {};
  let uncategorizedCount = 0;

  for (const [key, a] of Object.entries(attrs)) {
    if (key.startsWith('__')) continue; // internal stash entries (movementSystem), not real attributes

    const badges = new Set();
    let area = null;

    const usedInOther   = a.usedInOtherSystems || [];
    const inScanners     = usedInOther.some(t => t.includes('CalculateScanners'));
    const inMaintenance  = usedInOther.some(t => t.includes('MaintenanceAndReturns'));

    // Priority 0 — real shipped-content evidence (data/ category
    // co-occurrence), when it unambiguously points to one area.
    const catHint = categoryAreaHints[key];
    if (catHint) area = catHint.area;

    // 1. Status Effects
    const isStatusish = !!(a.isStatusEffect || a.isStatusResistance || a.isStatusProtection || a.isStatusResistanceCost);
    if (!area && isStatusish) area = AREA.STATUS;
    else if (isStatusish) badges.add(AREA.STATUS);

    // 2. Weapons — wins primary only when NOT also movement-relevant
    // (a pure weapon-data key like "shield damage" has no movement role
    // and takes this directly; "turn" is both, and Movement — rule 3 —
    // takes primary instead, with Weapons demoted to a badge).
    const isWeaponish = !!(a.isWeaponDataKey || a.isWeaponStat);
    if (!area && isWeaponish && !a.isMovementRelevant) area = AREA.WEAPONS;
    else if (isWeaponish) badges.add(AREA.WEAPONS);

    // 3. Movement & Engines
    if (!area && a.isMovementRelevant) area = AREA.MOVEMENT;
    else if (a.isMovementRelevant) badges.add(AREA.MOVEMENT);

    // 4. Scanners & Detection
    const isScannerish = key.toLowerCase().includes('scan') || inScanners;
    if (!area && isScannerish) area = AREA.SCANNERS;
    else if (isScannerish) badges.add(AREA.SCANNERS);

    // 5. Defense / Protection — excludes status protection (already
    // covered, more specifically, by rule 1).
    const isDefenseProtection = !!(a.isProtection && !a.isStatusProtection);
    if (!area && isDefenseProtection) area = AREA.PROTECTION;
    else if (isDefenseProtection) badges.add(AREA.PROTECTION);

    // 6. Power, Heat & Life Support
    const isPowerLike = !!(a.shownInShipPanel && POWER_LIFE_SUPPORT_PATTERN.test(key));
    if (!area && isPowerLike) area = AREA.POWER;
    else if (isPowerLike) badges.add(AREA.POWER);

    // 7. Economy
    if (!area && inMaintenance) area = AREA.ECONOMY;
    else if (inMaintenance) badges.add(AREA.ECONOMY);

    // 8. Special / Flags
    if (!area && a.isBoolean) area = AREA.SPECIAL;
    else if (a.isBoolean) badges.add(AREA.SPECIAL);

    // (Rule 9, "Uncategorized / Needs Review", intentionally skipped.)

    // 10. General fallback — whichever display panel actually shows it.
    if (!area) {
      if (a.shownInOutfitPanel)     area = AREA.GENERAL_OUTFIT;
      else if (a.shownInShipPanel)  area = AREA.GENERAL_SHIP;
    }

    // Custom / Modder-Defined (§5.3) — real data/ usage, zero source-code
    // signal of any kind. `dataOnly` already means exactly that: it's only
    // ever set at creation time, when a key from the data/ scan didn't
    // already have a dictionary entry from any prior (source-derived) pass.
    if (!area && a.dataOnly) area = AREA.CUSTOM;

    if (!area) uncategorizedCount++;
    else areaCounts[area] = (areaCounts[area] || 0) + 1;

    badges.delete(area);
    a.area       = area;
    a.areaBadges = [...badges];
  }

  return { areaCounts, uncategorizedCount };
}

// ---------------------------------------------------------------------------

async function parseAttributes(outputDir, cliOpts = {}) {
  const outDir  = outputDir || path.join(process.cwd(), 'data');
  const outFile = path.join(outDir, 'attributeDefinitions.json');
  const discoveryCacheFile = path.join(outDir, 'discoveredSourceFiles.json');
  await fs.mkdir(outDir, { recursive: true });

  console.log('\n' + '='.repeat(60));
  console.log('Endless Sky Attribute Parser');
  console.log('='.repeat(60));

  const sources = {};
  for (const [name, url] of Object.entries(SOURCE_FILES)) {
    const filename = url.split('/').pop();
    process.stdout.write(`  Fetching ${filename.padEnd(32)}`);
    try {
      sources[name] = await fetchText(url);
      console.log(`✓  ${sources[name].length.toLocaleString()} bytes`);
    } catch (err) {
      console.log(`✗  ${err.message}`);
      sources[name] = '';
    }
  }

  let systemContext = parseSystemContext(null);
  process.stdout.write(`  Fetching Sol.txt                `);
  try {
    const solText = await fetchText(DATA_FILES.solSystem);
    systemContext = parseSystemContext(solText);
    console.log(`✓  ${solText.length.toLocaleString()} bytes`);
  } catch (err) {
    console.log(`✗  ${err.message} (using default solar power 1.0)`);
  }

  let tooltipMap = new Map();
  process.stdout.write(`  Fetching tooltips.txt           `);
  try {
    const tooltipSrc = await fetchText(DATA_FILES.tooltips);
    tooltipMap = parseTooltips(tooltipSrc);
    console.log(`✓  ${tooltipSrc.length.toLocaleString()} bytes  (${tooltipMap.size} tips)`);
  } catch (err) {
    console.log(`✗  ${err.message} (tooltips unavailable)`);
  }

  console.log('\n  Parsing seed files (bespoke extractors)...');

  const oidData = sources.outfitInfoDisplay
    ? parseOutfitInfoDisplay(sources.outfitInfoDisplay)
    : { scaleLabels: [], scaleMap: {}, booleanAttrs: {}, valueNames: [], percentNames: [], otherNames: [], expectedNegative: [], beforeAttrs: [], allAttributeKeys: [] };
  console.log(`  OutfitInfoDisplay  ${Object.keys(oidData.scaleMap).length} scale, ${Object.keys(oidData.booleanAttrs).length} boolean, ${oidData.valueNames.length} weapon stat names`);

  const shipFns = sources.shipCpp ? parseShipCpp(sources.shipCpp) : {};
  console.log(`  Ship.cpp           ${Object.keys(shipFns).length} functions`);

  const shipDisplay = sources.shipInfoDisplay
    ? parseShipInfoDisplay(sources.shipInfoDisplay)
    : { tableRows: [], attributeLabels: [], capacityNames: [], intermediateVars: {}, allAttributeKeys: [] };
  console.log(`  ShipInfoDisplay    ${shipDisplay.tableRows.length} table rows, ${shipDisplay.attributeLabels.length} label/value pairs`);

  const outfitStacking = sources.outfitCpp ? parseOutfitCpp(sources.outfitCpp) : {};
  console.log(`  Outfit.cpp         ${Object.keys(outfitStacking).length} stacking rules`);

  const weaponData  = sources.weaponCpp ? parseWeaponCpp(sources.weaponCpp) : { functions: {}, dataFileKeys: [], submunitionKeys: [] };
  const jumpNavFns  = parseJumpNav(sources.jumpNavCpp);

  const statusEffectDecay     = parseStatusEffectDecay(sources.shipCpp || '');
  console.log(`  Status effects     ${statusEffectDecay.descriptors.length} effects`);

  // ── Damage types: legacy parse kept as fallback, structural discovery preferred ──
  const legacyDamageTypes           = parseDamageDealt(sources.damageDealtH, sources.damageDealtCpp);
  const legacyShipCppTakeDmgDetails = parseShipTakeDamage(sources.shipCpp || '');

  console.log('\n  Deriving damage types structurally...');
  const structuralDamageResult = await deriveDamageTypesStructurally({
    damageDealtHSrc:    sources.damageDealtH,
    shipCppSrc:         sources.shipCpp,
    weaponDataFileKeys: weaponData.dataFileKeys,
    fetchTextFn:        fetchText,
    esRawBase:          ES_RAW,
  });

  let damageTypes, shipCppTakeDmgDetails;
  if (structuralDamageResult.ok) {
    damageTypes           = structuralDamageResult.damageTypes;
    shipCppTakeDmgDetails = structuralDamageResult.shipCppDetails;
    console.log(`  DamageDealt (structural) ${damageTypes.length} types` +
      (structuralDamageResult.discovered
        ? ` — accessor "${structuralDamageResult.discovered.accessorName}()" -> struct "${structuralDamageResult.discovered.structTypeName}"`
        : ''));
    for (const w of structuralDamageResult.warnings) console.log(`    ⚠  ${w}`);
  } else {
    damageTypes           = legacyDamageTypes;
    shipCppTakeDmgDetails = legacyShipCppTakeDmgDetails;
    console.log(`  ⚠  Structural damage-type discovery failed, using legacy parser instead:`);
    for (const w of structuralDamageResult.warnings) console.log(`     ${w}`);
  }
  console.log(`  TakeDamage parse   ${shipCppTakeDmgDetails.size} type entries`);

  const damageTypeDetails = buildDamageTypeDetails(
    damageTypes, statusEffectDecay.descriptors, shipCppTakeDmgDetails
  );
  console.log(`  damageTypeDetails  ${damageTypeDetails.length} types`);

  const attributes = buildAttributeDictionary_withDmgTypes(
    oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns,
    statusEffectDecay, damageTypeDetails
  );

  // Pull the stashed movement-system summary out of the attrs object (it
  // was stored there temporarily so buildAttributeDictionary could tag
  // attributes without needing an extra return value threaded through
  // buildAttributeDictionary_withDmgTypes too).
  const movementSystem = attributes.__movementSystem;
  delete attributes.__movementSystem;
  console.log(`  Movement system    ${movementSystem.functions.length} ship functions, ` +
    `${movementSystem.attributes.length} attributes tagged isMovementRelevant ` +
    `(seeded from: ${movementSystem.seedFunctions.join(', ')})`);

  mergeTooltipsIntoAttributes(attributes, tooltipMap);
  const tipsMatched = Object.values(attributes).filter(a => a.tooltip).length;
  console.log(`  Tooltips merged    ${tipsMatched} / ${Object.keys(attributes).length} attributes matched`);
  console.log(`\n  Unified dictionary (seed files only): ${Object.keys(attributes).length} unique attribute keys`);

  // ── NEW: discovery phase — scan the ENTIRE source/ tree ──────────────────
  console.log('\n  Discovering attribute usage across the full codebase...');
  const discovery = await discoverRelevantSourceFiles(discoveryCacheFile, {
    forceRescan: !!cliOpts.rescan,
  });

  const otherSystems = {};
  let discoveredParseFailures = 0;

  if (discovery.relevantFiles?.length) {
    console.log(`  Parsing ${discovery.relevantFiles.length} newly-discovered files generically...`);
    const contentCache = discovery._contentCache || {};

    await withPool(discovery.relevantFiles, async (entry) => {
      let content = contentCache[entry.path];
      if (!content) {
        const rawUrl = `${ES_RAW}/${entry.path.replace(/^source\//, '')}`;
        content = await fetchText(rawUrl);
      }
      const parsed = parseGenericSourceFile(content, entry.path);
      for (const [className, fns] of Object.entries(parsed)) {
        if (!otherSystems[className]) otherSystems[className] = {};
        Object.assign(otherSystems[className], fns);
      }
    }, 8).then(results => {
      discoveredParseFailures = results.filter(r => r && r.__error).length;
    });

    const classCount = Object.keys(otherSystems).length;
    const fnCount     = Object.values(otherSystems).reduce((n, fns) => n + Object.keys(fns).length, 0);
    console.log(`  ${classCount} classes / ${fnCount} functions found outside the seed files` +
      (discoveredParseFailures ? ` (${discoveredParseFailures} files failed to fetch and were skipped)` : ''));
  } else if (discovery.failed) {
    console.log('  Discovery phase skipped (tree fetch failed) — dictionary reflects seed files only.');
  } else {
    console.log('  No additional attribute-reading files found outside the seed list.');
  }

  const newlyDiscoveredKeys = mergeDiscoveredSystemsIntoAttributes(attributes, otherSystems);
  if (newlyDiscoveredKeys.length) {
    console.log(`  ⚠  ${newlyDiscoveredKeys.length} attribute key(s) exist ONLY in discovered files ` +
      `— never appeared in OutfitInfoDisplay/ShipInfoDisplay/Outfit.cpp/Weapon.cpp:`);
    console.log('     ' + newlyDiscoveredKeys.slice(0, 20).join(', ') + (newlyDiscoveredKeys.length > 20 ? ', …' : ''));
  }

  console.log(`\n  Unified dictionary (seed + discovered): ${Object.keys(attributes).length} unique attribute keys`);

  // ── NEW: data/ usage scan — evidence from shipped CONTENT, not source ────
  console.log('\n  Scanning data/ for actual attribute usage in outfit/ship blocks...');
  const dataUsageCacheFile = path.join(outDir, 'dataFolderUsage.json');
  const dataScan = await scanDataFolderUsage(dataUsageCacheFile, { forceRescan: !!cliOpts.rescan });

  const dataOnlyKeys = mergeDataUsageIntoAttributes(attributes, dataScan.perKey);
  console.log(`  ${Object.keys(dataScan.perKey || {}).length} attribute keys observed in real outfit/ship blocks` +
    (dataScan.failed ? ' (scan failed — dictionary unaffected)' : ''));
  if (dataOnlyKeys.length) {
    console.log(`  ⚠  ${dataOnlyKeys.length} attribute key(s) exist ONLY in shipped data, ` +
      `never referenced by any source-code layer (custom/modder-only attributes):`);
    console.log('     ' + dataOnlyKeys.slice(0, 20).join(', ') + (dataOnlyKeys.length > 20 ? ', …' : ''));
  }

  const categoryAreaHints = deriveCategoryAreaHints(dataScan.perKey || {});
  console.log(`  ${Object.keys(categoryAreaHints).length} attribute keys have an unambiguous category → area hint`);

  // ── NEW: front-end area classification (attribute-area-classification.md §3) ──
  const { areaCounts, uncategorizedCount } = deriveFrontendArea(attributes, categoryAreaHints);
  console.log('\n  Front-end area classification:');
  for (const [area, count] of Object.entries(areaCounts).sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(count).padStart(4)}  ${area}`);
  if (uncategorizedCount) console.log(`    ${String(uncategorizedCount).padStart(4)}  (no area — left for AttributeSections.js's own fallback)`);

  console.log(`\n  Unified dictionary (seed + discovered + data-scanned): ${Object.keys(attributes).length} unique attribute keys`);

  const systemAwareFormulas = {
    'solar collection': { formula: '[solar collection] * solar_power', displayScale: 60, displayUnit: '/s',
      description: 'Actual energy collected per second.', referencePower: systemContext.referenceSolarPower },
    'solar heat':       { formula: '[solar heat] * solar_power',       displayScale: 60, displayUnit: '/s',
      description: 'Heat from solar collection per second.', referencePower: systemContext.referenceSolarPower },
    ramscoop:           { formula: '0.03 * sqrt(solar_power) * [ramscoop]', displayScale: 60, displayUnit: 'fuel/s',
      description: 'Fuel scooped per second.', referencePower: systemContext.referenceSolarPower },
  };

  const tooltipsObject = Object.fromEntries(tooltipMap);

  const result = {
    _meta: {
      source: 'https://github.com/endless-sky/endless-sky',
      sourceFiles: { ...SOURCE_FILES, tooltips: DATA_FILES.tooltips },
      generatedAt: new Date().toISOString(),
      formulaNotation: [
        '[attr name] = attributes.Get("attr name") in C++.',
        'FnName() calls refer to other ship functions.',
        'Multi-branch functions have one formula entry per return statement.',
      ],
      discovery: {
        scannedAt: discovery.scannedAt ? new Date(discovery.scannedAt).toISOString() : null,
        totalCandidatesScanned: discovery.totalCandidates ?? 0,
        relevantFilesFound: discovery.relevantFiles?.length ?? 0,
        relevantFilePaths: (discovery.relevantFiles || []).map(f => f.path),
        newlyDiscoveredAttributeKeys: newlyDiscoveredKeys,
        note: 'discovery scans the ENTIRE source/ tree (not a hardcoded list) for attribute-access ' +
          'patterns, caches results, and re-scans automatically after 7 days or when --rescan is passed. ' +
          'Files already covered by a bespoke parser (see SEED_PATHS) are excluded from this generic pass.',
      },
      damageTypeDiscovery: {
        method: structuralDamageResult.ok ? 'structural' : 'legacy-fallback',
        accessor: structuralDamageResult.discovered?.accessorName ?? null,
        structTypeName: structuralDamageResult.discovered?.structTypeName ?? null,
        warnings: structuralDamageResult.warnings || [],
        note: 'damageTypes/damageTypeDetails are derived by deriveDamageTypesStructurally(), which ' +
          'discovers DamageDealt\'s aggregate resource accessor structurally (public accessor whose ' +
          'return type matches a private member type), fetches and parses that struct\'s own header ' +
          'for field names, and cross-references Weapon::Load\'s own "X damage" data keys for correct ' +
          'canonical naming. Falls back to the legacy accessor-name-matching parser (parseDamageDealt/ ' +
          'parseShipTakeDamage, both still present and unmodified above) if structural discovery fails.',
      },
      movementSystem: {
        seedFunctions: movementSystem.seedFunctions,
        functionCount: movementSystem.functions.length,
        attributeCount: movementSystem.attributes.length,
        note: 'isMovementRelevant on each attribute (below) is derived structurally from the ship-' +
          'function call graph, seeded only from InertialMass/Drag/DragForce — see movementSystem ' +
          'at the bottom of this file for the full function/attribute lists and rationale.',
      },
      dataUsage: {
        scannedAt: dataScan.scannedAt ? new Date(dataScan.scannedAt).toISOString() : null,
        filesScanned: dataScan.fileCount ?? 0,
        attributeKeysObserved: Object.keys(dataScan.perKey || {}).length,
        dataOnlyAttributeKeys: dataOnlyKeys,
        categoryAreaHintCount: Object.keys(categoryAreaHints).length,
        note: 'Independent sweep of the ENTIRE data/ tree (tab-indentation tree, not brace-counting — ' +
          'see dataFolderScanner.js) for real attribute usage inside outfit/ship blocks. Merged into ' +
          'the dictionary by key name against the source-derived entries above; a key with dataOnly:true ' +
          'has real shipped usage but is never referenced by attributes.Get()/Set() anywhere in source.',
      },
      areaClassification: {
        counts: areaCounts,
        uncategorizedCount,
        note: 'area/areaBadges on each attribute (below) implement attribute-area-classification.md §3 ' +
          '— priority-ordered rules over the flags already in this dictionary, plus data/ category ' +
          'co-occurrence (categoryAreaHintCount above) as the highest-priority signal. Rule 9 ' +
          '("Uncategorized / Needs Review") is intentionally not implemented; unmatched attributes have ' +
          'area: null and are left to AttributeSections.js\'s own final fallback.',
      },
      notes: [
        'Zero hardcoding of WHICH files matter: discovery scans every .cpp/.h under source/ and ' +
          'keeps whatever actually reads/writes attributes, not a maintained list.',
        'The dozen seed files still use bespoke, hand-tuned extraction (SCALE_LABELS, BOOLEAN_ATTRIBUTES, ' +
          'VALUE_NAMES, MINIMUM_OVERRIDES) because only targeted regexes can read those exact formats.',
        'Everything else is parsed generically via extractAllClassFunctionBodies — any class, any file.',
        'isMovementRelevant is derived from the ship-function call graph, not a hardcoded attribute list ' +
          '— see movementSystem below and the header comment in this file.',
        'damageTypes/damageTypeDetails are derived structurally (see damageTypeDiscovery above), with a ' +
          'legacy accessor-name-matching parser kept as an automatic fallback.',
        'data/ usage (dataUsage above) is scanned independently of source, via a tab-indentation tree ' +
          'parser (dataFolderScanner.js) — the data format has no braces, so the source-side brace-' +
          'counting extractors would silently misparse it.',
        'area/areaBadges on each attribute implement attribute-area-classification.md §3 — see ' +
          'areaClassification above.',
        'damageTypeDetails: shieldInteraction parsed from Ship.cpp TakeDamage().',
        'Descriptor lookup uses damageKey base, not label, fixing Ion/Ionization mismatch.',
        'Status decay: stat = max(0, 0.99*stat - min(R, 0.99*stat)) each frame.',
        'Passive half-life: ~69 frames (~1.15s at 60fps).',
        'JamChance: scrambling > 0.1 ? 1 - pow(2, -scrambling/70) : 0.',
        'tooltips: parsed from data/_ui/tooltips.txt; also merged as .tooltip on each attribute entry.',
      ],
    },
    systemContext,
    systemAwareFormulas,
    attributes,
    tooltips: tooltipsObject,
    shipFunctions: shipFns,
    otherSystems, // ← every class/function found by the discovery pass, keyed by class name
    movementSystem, // ← NEW: { seedFunctions, functions, attributes, notes }
    shipDisplay: {
      energyHeatTable:  shipDisplay.tableRows,
      labelValuePairs:  shipDisplay.attributeLabels,
      capacityDisplay:  shipDisplay.capacityNames,
      intermediateVars: shipDisplay.intermediateVars,
    },
    outfitDisplay: {
      scaleLabels:       oidData.scaleLabels,
      scaleMap:          oidData.scaleMap,
      booleanAttributes: oidData.booleanAttrs,
      valueNames:        oidData.valueNames,
      percentNames:      oidData.percentNames,
      otherNames:        oidData.otherNames,
      expectedNegative:  oidData.expectedNegative,
      beforeAttributes:  oidData.beforeAttrs,
    },
    weapon: {
      functions:       weaponData.functions,
      dataFileKeys:    weaponData.dataFileKeys,
      submunitionKeys: weaponData.submunitionKeys,
      damageTypes,
      damageTypeDetails,
      statusEffectDecay: {
        decayMap:    statusEffectDecay.decayMap,
        descriptors: statusEffectDecay.descriptors,
        notes: [
          'Passive decay: stat = max(0, 0.99 * stat) — 1%/frame regardless of resistance.',
          'With resistance R: stat = max(0, 0.99*stat - min(R, 0.99*stat)) each frame.',
          'Passive half-life: ~69 frames (~1.15s at 60fps).',
          'Protection reduces incoming dose: effectiveDose = rawDose * (1 - protection).',
          'Slowing and Disruption are status multipliers, NOT HP damage.',
          'JamChance (scrambling): scrambling > 0.1 ? 1 - pow(2, -scrambling/70) : 0.',
        ],
      },
    },
    navigation: jumpNavFns,
  };

  await fs.writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✓  Written → ${outFile}`);
  console.log(`   attributes: ${Object.keys(result.attributes).length}  ` +
    `shipFunctions: ${Object.keys(result.shipFunctions).length}  ` +
    `otherSystems classes: ${Object.keys(result.otherSystems).length}  ` +
    `tooltips: ${Object.keys(result.tooltips).length}`);
  console.log('='.repeat(60) + '\n');
  return result;
}

if (require.main === module) {
  const cliOpts = { rescan: process.argv.includes('--rescan') };
  parseAttributes(undefined, cliOpts).catch(err => { console.error('Error:', err); process.exit(1); });
}

module.exports = {
  parseAttributes, parseTooltips, mergeTooltipsIntoAttributes,
  discoverRelevantSourceFiles, parseGenericSourceFile, extractAllClassFunctionBodies,
  deriveMovementSystem, deriveFrontendArea, mergeDataUsageIntoAttributes,
  scanDataFolderUsage, deriveCategoryAreaHints,
  deriveDamageTypesStructurally,
};
