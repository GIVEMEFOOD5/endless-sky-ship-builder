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
 * ─────────────────────────────────────────────────────────────────────────
 */

const https = require('https');
const fs    = require('fs').promises;
const path  = require('path');

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
// buildAttributeDictionary (unchanged)
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
// Main
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
  const damageTypes = parseDamageDealt(sources.damageDealtH, sources.damageDealtCpp);
  const jumpNavFns  = parseJumpNav(sources.jumpNavCpp);

  const statusEffectDecay     = parseStatusEffectDecay(sources.shipCpp || '');
  console.log(`  Status effects     ${statusEffectDecay.descriptors.length} effects`);

  const shipCppTakeDmgDetails = parseShipTakeDamage(sources.shipCpp || '');
  console.log(`  TakeDamage parse   ${shipCppTakeDmgDetails.size} type entries from Ship.cpp`);

  const damageTypeDetails = buildDamageTypeDetails(
    damageTypes, statusEffectDecay.descriptors, shipCppTakeDmgDetails
  );
  console.log(`  damageTypeDetails  ${damageTypeDetails.length} types`);

  const attributes = buildAttributeDictionary_withDmgTypes(
    oidData, shipFns, shipDisplay, outfitStacking, weaponData, jumpNavFns,
    statusEffectDecay, damageTypeDetails
  );

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
      notes: [
        'Zero hardcoding of WHICH files matter: discovery scans every .cpp/.h under source/ and ' +
          'keeps whatever actually reads/writes attributes, not a maintained list.',
        'The dozen seed files still use bespoke, hand-tuned extraction (SCALE_LABELS, BOOLEAN_ATTRIBUTES, ' +
          'VALUE_NAMES, MINIMUM_OVERRIDES) because only targeted regexes can read those exact formats.',
        'Everything else is parsed generically via extractAllClassFunctionBodies — any class, any file.',
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
    otherSystems, // ← NEW: every class/function found by the discovery pass, keyed by class name
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
};
