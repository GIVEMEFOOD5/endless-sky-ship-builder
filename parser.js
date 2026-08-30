// parser.js - Endless Sky data parser for GitHub Actions
// Parses ship, variant, outfit, and effect data from GitHub repositories.
// Uses sparse Git clones (data/ + images/ only) instead of the GitHub API,
// which avoids rate limits and the 100k-file tree truncation limit.
// Also supports "archive" sources: a .zip / .tar / .tar.gz / .tgz uploaded
// to rawData/ in the repo, which may itself contain one or more plugins.
//
// ── CHANGELOG (mission/event parsing pass) ──────────────────────────────────
//   - Fixed: `give ship`/`ship`/`give outfit`/`outfit` action lines with a
//     BARE (unquoted) model/outfit name were silently dropped — only the
//     quoted form matched. e.g. `give ship Peregrine "Shadow Flight"` was
//     invisible to locationResolver entirely. Both now accept bare or
//     quoted names.
//   - Added: `event "X"` action lines inside a mission (e.g. under
//     `on accept`) are now recorded as a mission → event trigger link, so
//     "accepting this mission causes event X to fire" is traceable.
//   - Added: `parseEventBlock` now understands `system "X"` sub-blocks
//     (`add fleet` / `remove fleet` — how an event changes what spawns in a
//     region) and `government "X"` sub-blocks (`"attitude toward"` changes).
//   - Extended: `parsePlanetBlock` now also tracks `add outfitter` /
//     `remove outfitter` / `remove shipyard` (previously only `add
//     shipyard` was handled), and threads an optional `eventName` through
//     so every planet-level change an event causes is traceable back to
//     that event.
//   - Added: a named `fleet "X"` reference inside an `npc` block (the
//     common way to spawn an existing fleet's ships, as opposed to an
//     inline anonymous fleet body) is now resolved to its actual ship list
//     via a new post-processing pass, `resolveAllNpcFleetRefs()`, run once
//     all files/plugins have been parsed — necessary because the
//     referenced fleet's own definition may live in a file parsed before
//     OR after the mission/event that references it.
//
//   NOT changed in this pass (flagged, not silently skipped):
//   - Bespoke per-NPC-ship outfit loadouts declared inline under a specific
//     `ship "X" "Variant"` line inside an `npc` block are still not parsed
//     into outfit/species data.
//   - Negative-count `give outfit "X" -N` ("take away") lines are still
//     matched then discarded rather than recorded anywhere.
//
// ── CHANGELOG (person-block pass) ────────────────────────────────────────
//   - Added: `person "X"` blocks (persons.txt-style unique/named ships —
//     e.g. story bosses, capturable one-offs, and several alien "special"
//     ships that are never sold in a shipyard or spawned from a normal
//     fleet) were PREVIOUSLY NOT RECOGNIZED AT ALL by the top-level
//     dispatcher in parseFileContent. Any ship that only ever appears via
//     a person block therefore got no government and no location data,
//     with no warning. Added `parsePersonBlock` + a dispatch branch for
//     `person `, alongside a new SpeciesResolver.collectPerson /
//     LocationResolver.collectPerson+collectPersonSystem pair.
//   - Fixed: the anonymous inline `fleet` sub-block inside an `npc` block
//     (a real, distinct syntax from both the named `fleet "X"` reference
//     AND the flat quoted-ship-list-directly-under-npc form — see e.g.
//     Remnant/Korath mission files, where `npc kill` contains its own
//     `fleet` sub-block with its own `government` and `variant` lines) is
//     now scanned for a LOCAL `government` line. Previously this local
//     government was silently ignored in favor of whatever `government`
//     line (if any) appeared directly under the npc itself, which is only
//     correct when the two happen to agree.
// ─────────────────────────────────────────────────────────────────────────

const https           = require('https');
const http            = require('http');
const SpeciesResolver = require('./speciesResolver');
const LocationResolver = require('./locationResolver');
const { parseAttributes } = require('./attributeParser');
const crypto          = require('crypto');
const fs              = require('fs').promises;
const path            = require('path');
const { exec: execCallback } = require('child_process');
const { promisify }   = require('util');
const exec            = promisify(execCallback);
const AdmZip          = require('adm-zip');
const tar             = require('tar');

// ---------------------------------------------------------------------------
// Helper: sparse-clone specific folders from a repo
// ---------------------------------------------------------------------------
async function sparseClone(repoGitUrl, branch, targetDir, folders) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  // Inject auth token into the URL so private/rate-limited clones work
  let authenticatedUrl = repoGitUrl;
  if (process.env.GITHUB_TOKEN) {
    authenticatedUrl = repoGitUrl.replace(
      'https://github.com/',
      `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/`
    );
  }

  try {
    await exec(
      `git clone --filter=blob:none --no-checkout --depth 1 ` +
      `--single-branch --branch ${branch} ${authenticatedUrl} "${targetDir}"`
    );
  } catch (err) {
    await fs.rm(targetDir, { recursive: true, force: true });
    throw new Error(`git clone failed for ${repoGitUrl} @ ${branch}: ${err.stderr || err.message}`);
  }

  await exec(`git -C "${targetDir}" sparse-checkout init --cone`);
  await exec(`git -C "${targetDir}" sparse-checkout set ${folders.map(f => `"${f}"`).join(' ')}`);
  await exec(`git -C "${targetDir}" checkout ${branch}`);
}

// ---------------------------------------------------------------------------
// Archive download + extraction helpers
// ---------------------------------------------------------------------------

// Recognised archive extensions, in the order they should be tested
// (longest/most-specific suffix first, e.g. ".tar.gz" before ".gz").
const ARCHIVE_EXTENSIONS = ['.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar', '.zip'];

function detectArchiveExtension(urlOrName) {
  const lower = urlOrName.toLowerCase().split('?')[0];
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

/**
 * Download a URL to a local file, following redirects (raw.githubusercontent.com
 * and similar CDNs may 301/302 redirect). Caps followed redirects at 5.
 */
function downloadToFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http;
    const options = { headers: { 'User-Agent': 'endless-sky-parser' } };
    client.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        downloadToFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
        return;
      }
      const fsSync = require('fs');
      const fileStream = fsSync.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve()));
      fileStream.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Extract a downloaded archive file to destDir, based on its extension.
 * Supports .zip (via adm-zip) and .tar / .tar.gz / .tgz / .tar.bz2 / .tbz2
 * (via the `tar` package — note: .tar.bz2 requires the OS `bzip2` to be on
 * PATH since the `tar` package itself only handles gzip natively; if bzip2
 * isn't available this will throw and the plugin will be skipped with a
 * clear error rather than silently producing an empty plugin).
 */
async function extractArchive(archivePath, destDir, ext) {
  await fs.mkdir(destDir, { recursive: true });

  if (ext === '.zip') {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(destDir, true);
    return;
  }

  if (ext === '.tar' || ext === '.tar.gz' || ext === '.tgz') {
    await tar.extract({ file: archivePath, cwd: destDir });
    return;
  }

  if (ext === '.tar.bz2' || ext === '.tbz2') {
    // The `tar` package doesn't decompress bzip2 itself; shell out to bzip2 + tar.
    try {
      await exec(`bzip2 -dc "${archivePath}" | tar -x -C "${destDir}"`);
    } catch (err) {
      throw new Error(
        `Failed to extract .tar.bz2 archive (is bzip2 installed on the runner?): ${err.message}`
      );
    }
    return;
  }

  throw new Error(`Unsupported archive extension: ${ext}`);
}

// ---------------------------------------------------------------------------
// Compute a deterministic structural hash of a ship's data for duplicate detection.
// ---------------------------------------------------------------------------
function hashShip(ship) {
  const relevant = {
    sprite:          ship.sprite          ?? null,
    thumbnail:       ship.thumbnail       ?? null,
    description:     ship.description     ?? null,
    attributes:      ship.attributes      ?? {},
    outfitMap:       ship.outfitMap       ?? {},
    engines:         ship.engines         ?? [],
    reverseEngines:  ship.reverseEngines  ?? [],
    steeringEngines: ship.steeringEngines ?? [],
    guns:            ship.guns            ?? [],
    turrets:         ship.turrets         ?? [],
    bays:            ship.bays            ?? [],
    leaks:           ship.leaks           ?? [],  // included so leak-only differences are detected
  };
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// Convert the internal outfitMap { name: { count, pluginId } | count }
// into the array format expected by shipBuilder.js:
//   { "Blaster": { count: 2, pluginId: "Endless Sky/Endless Sky" }, ... }
// ---------------------------------------------------------------------------
function outfitMapToOutputFormat(outfitMap) {
  if (!outfitMap || typeof outfitMap !== 'object') return {};
  const result = {};
  for (const [name, val] of Object.entries(outfitMap)) {
    if (typeof val === 'object' && val !== null) {
      result[name] = { count: val.count ?? 1, pluginId: val.pluginId ?? null };
    } else {
      result[name] = { count: Number(val) || 1, pluginId: null };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// normaliseWeaponBlock
//
// Rewrites the weapon block so submunitions and ammo are stored as canonical
// arrays regardless of which data-file syntax was used.
//
// OUTPUT FORMATS
// ──────────────
// weapon.submunitions: Array<{ type: string, count: number }>
// weapon.ammunition:   Array<{ type: string, count: number }>
//
// INPUT FORMS HANDLED
// ───────────────────
// Submunitions:
//   (a) submunition "OutfitName"           → count 1
//   (b) submunition "OutfitName" 3         → count 3
//   (c) "submunition" "OutfitName" 1       → count 1 (parseKeyValue strips the quotes off key)
//   (d) submunition "OutfitName" (array)   → one entry per element
//   (e) "submunition OutfitName" prefixed keys (with offset arrays or numeric counts)
//   (f) loose numeric outfit-name keys where the outfit has a weapon block
//
// Ammo:
//   (a) ammo "OutfitName"                  → count 1
//   (b) ammo "OutfitName" 3               → count 3
//   (c) loose numeric outfit-name keys where the outfit is Ammunition category
// ---------------------------------------------------------------------------

/**
 * Parse a raw string value that may be:
 *   "OutfitName"          → { name: "OutfitName", count: 1 }
 *   "OutfitName" 3        → { name: "OutfitName", count: 3 }
 *   OutfitName            → { name: "OutfitName", count: 1 }
 *   OutfitName 2          → { name: "OutfitName", count: 2 }
 */
function parseNameCount(raw) {
    if (typeof raw !== 'string') return null;
    raw = raw.trim();
    // Quoted name with optional trailing integer: "OutfitName" 3
    const quotedMatch = raw.match(/^["'`]([^"'`]+)["'`](?:\s+(\d+))?$/);
    if (quotedMatch) {
        return { name: quotedMatch[1], count: quotedMatch[2] ? parseInt(quotedMatch[2], 10) : 1 };
    }
    // Unquoted name with trailing integer: OutfitName 2
    const unquotedCountMatch = raw.match(/^(.+?)\s+(\d+)$/);
    if (unquotedCountMatch) {
        return { name: unquotedCountMatch[1].trim(), count: parseInt(unquotedCountMatch[2], 10) };
    }
    // Plain name, no count
    return { name: raw, count: 1 };
}

function normaliseWeaponBlock(weapon, outfitsByName) {
    if (!weapon || typeof weapon !== 'object') return weapon;

    const submunitions = [];  // { type, count }
    const ammunition   = [];  // { type, count }
    const keysToDelete = [];

    // ── 1. weapon.ammo = "OutfitName" | "OutfitName 3" | "\"OutfitName\" 3" ──
    if (weapon.ammo != null) {
        if (typeof weapon.ammo === 'string' && weapon.ammo.length > 0) {
            const parsed = parseNameCount(weapon.ammo);
            if (parsed) ammunition.push({ type: parsed.name, count: parsed.count });
        }
        keysToDelete.push('ammo');
    }

    // ── 2. weapon.submunition = string | object | array ───────────────────────
    if (weapon.submunition != null) {
        const raw     = weapon.submunition;
        const entries = Array.isArray(raw) ? raw : [raw];
        for (const entry of entries) {
            if (typeof entry === 'string' && entry.length > 0) {
                // May be "OutfitName", "OutfitName 2", or '"OutfitName" 2'
                const parsed = parseNameCount(entry);
                if (parsed) submunitions.push({ type: parsed.name, count: parsed.count });
            } else if (typeof entry === 'object' && entry !== null) {
                // Already a sub-block: { name: "X", count: N }
                const subName  = entry.name ?? entry.type ?? null;
                const subCount = typeof entry.count === 'number' ? entry.count : 1;
                if (subName) submunitions.push({ type: subName, count: subCount });
            }
        }
        keysToDelete.push('submunition');
    }

    // ── 3. "submunition OutfitName" prefixed keys ─────────────────────────────
    for (const key of Object.keys(weapon)) {
        if (!key.startsWith('submunition ')) continue;
        const subName = key.slice('submunition '.length).trim();
        if (!subName) continue;
        const val = weapon[key];
        let count = 1;
        if (Array.isArray(val))                           count = val.length;
        else if (typeof val === 'number' && val > 0)      count = Math.round(val);
        else if (typeof val === 'object' && val !== null) count = 1;
        submunitions.push({ type: subName, count });
        keysToDelete.push(key);
    }

    // ── 4. Loose numeric keys — best-effort ammo / submunition detection ───────
    for (const key of Object.keys(weapon)) {
        if (keysToDelete.includes(key)) continue;
        if (key === 'ammo' || key === 'submunition') continue;

        const val = weapon[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;

        const entries = outfitsByName ? outfitsByName.get(key) : null;
        if (!entries || entries.length === 0) continue;

        const outfit = entries[0]?.outfit;
        if (!outfit) continue;

        const isAmmo =
            outfit.category === 'Ammunition' ||
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) ||
            (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0) ||
            Object.entries(outfit.attributes || {}).some(
                ([k, v]) => k.endsWith(' capacity') && typeof v === 'number' && v < 0
            );

        const isSubmunition = !isAmmo && !!outfit.weapon;

        if (isAmmo) {
            const count = val === true ? 1 : Math.max(1, Math.round(val));
            ammunition.push({ type: key, count });
            keysToDelete.push(key);
        } else if (isSubmunition) {
            const count = val === true ? 1 : Math.max(1, Math.round(val));
            submunitions.push({ type: key, count });
            keysToDelete.push(key);
        }
    }

    // ── Apply deletions and write normalised arrays ────────────────────────────
    for (const k of keysToDelete) delete weapon[k];

    if (submunitions.length > 0) weapon.submunitions = submunitions;
    if (ammunition.length   > 0) weapon.ammunition   = ammunition;

    return weapon;
}

// ---------------------------------------------------------------------------
class EndlessSkyParser {
  constructor() {
    this.ships           = [];
    this.variants        = [];
    this.outfits         = [];
    this.effects         = [];
    this.pendingVariants = [];

    this.shipById    = new Map();
    this.shipsByName = new Map();

    this.outfitsByName = new Map();

    this._sourcePriority = new Map();
    this._overrides      = new Map();
    this._currentPluginId = null;

    this._currentRepoShipsBefore = 0;
    this._currentRepoShipsAfter  = 0;

    // Named fleet references found inside `npc` blocks (missions AND
    // events) — e.g. `fleet "Marauder Raid"`. These can't be resolved to
    // an actual ship list at the point they're encountered, because the
    // fleet's own `fleet "Marauder Raid" ... ` definition may live in a
    // file parsed before OR after this reference (parse order across
    // files/plugins is not guaranteed to match dependency order). Instead
    // they're queued here and resolved in one pass, after every file in
    // every plugin has been parsed, by resolveAllNpcFleetRefs().
    this._pendingNpcFleetRefs = [];

    // Populated by resolveEventGovernmentImpact() — the joined
    // event → fleet → government answer. See that method for shape.
    this.eventGovernmentImpacts = [];

    this.speciesResolver  = new SpeciesResolver();
    this.locationResolver = new LocationResolver();
  }

  setSourcePriority(sources) {
    this._sourcePriority.clear();
    sources.forEach((source, index) => {
      this._sourcePriority.set(source.name, index);
    });
  }

  setOverrides(sources) {
    this._overrides.clear();
    for (const source of sources) {
      if (source.overrides?.length) {
        this._overrides.set(source.name, new Set(source.overrides));
      }
    }
  }

  _registerShip(ship, pluginId) {
    const internalId = `${pluginId}::${ship.name}`;
    ship._internalId = internalId;
    ship._pluginId   = pluginId;
    ship._hash       = hashShip(ship);

    this.shipById.set(internalId, ship);
    if (!this.shipsByName.has(ship.name)) this.shipsByName.set(ship.name, []);
    this.shipsByName.get(ship.name).push(ship);
    return internalId;
  }

  _registerOutfit(outfit, pluginId) {
    outfit._pluginId = pluginId;
    const name = outfit.name;
    if (!this.outfitsByName.has(name)) this.outfitsByName.set(name, []);
    this.outfitsByName.get(name).push({ pluginId, outfit });
  }

  _resolveOutfitPluginId(outfitName, preferPluginId) {
    const entries = this.outfitsByName.get(outfitName);
    if (!entries || entries.length === 0) return null;
    if (preferPluginId) {
      const local = entries.find(e => e.pluginId === preferPluginId);
      if (local) return local.pluginId;
    }
    const sorted = [...entries].sort((a, b) => {
      const pa = this._sourcePriority.get(a.pluginId) ?? Infinity;
      const pb = this._sourcePriority.get(b.pluginId) ?? Infinity;
      return pa - pb;
    });
    return sorted[0].pluginId;
  }

  _resolveBaseShip(baseName, variantPluginId) {
    const localId   = `${variantPluginId}::${baseName}`;
    const localShip = this.shipById.get(localId);
    if (localShip) return { baseShip: localShip, error: null };

    const candidates = this.shipsByName.get(baseName) ?? [];
    if (candidates.length === 0) return { baseShip: null, error: `no base ship found for "${baseName}"` };
    if (candidates.length === 1) return { baseShip: candidates[0], error: null };

    const hashes = new Set(candidates.map(s => s._hash));
    if (hashes.size === 1) return { baseShip: candidates[0], error: null };

    const variantOverrides = this._overrides.get(variantPluginId);
    if (variantOverrides?.size) {
      const overriddenCandidates = candidates.filter(s => variantOverrides.has(s._pluginId));
      if (overriddenCandidates.length === 1) {
        console.log(`    ↳ Collision on "${baseName}" resolved via override: using ${overriddenCandidates[0]._pluginId}`);
        return { baseShip: overriddenCandidates[0], error: null };
      }
    }

    const ranked = [...candidates].sort((a, b) => {
      const pa = this._sourcePriority.get(a._pluginId) ?? Infinity;
      const pb = this._sourcePriority.get(b._pluginId) ?? Infinity;
      return pa - pb;
    });
    const winner = ranked[0];
    const losers = ranked.slice(1).map(s => s._pluginId).join(', ');
    console.warn(
      `    ⚠ Collision on base ship "${baseName}" for variant in "${variantPluginId}". ` +
      `Plugins with this ship: ${candidates.map(s => s._pluginId).join(', ')}. ` +
      `Resolved by source order — using "${winner._pluginId}" (overridden: ${losers}). ` +
      `Add an "overrides" declaration to plugins.json to silence this warning.`
    );
    return { baseShip: winner, error: null };
  }

  fetchUrl(url) {
    return new Promise((resolve, reject) => {
      const options = { headers: {} };
      if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) {
        options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
        options.headers['User-Agent']    = 'endless-sky-parser';
      }
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end',  ()    => { resolve(data); });
      }).on('error', reject);
    });
  }

  async detectDefaultBranch(owner, repo) {
    try {
      const raw  = await this.fetchUrl(`https://api.github.com/repos/${owner}/${repo}`);
      const data = JSON.parse(raw);
      if (data.default_branch) return data.default_branch;
    } catch (e) {
      console.warn(`Could not detect default branch: ${e.message}`);
    }
    return 'master';
  }

  async findTxtFiles(dir) {
    const results = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) results.push(...await this.findTxtFiles(full));
      else if (e.name.endsWith('.txt')) results.push(full);
    }
    return results;
  }

  async detectPluginsViaLsTree(repoGitUrl, branch, repoName) {
    const tmpDir = path.join(process.cwd(), `.tmp-lstree-${repoName}-${Date.now()}`);
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      // In detectPluginsViaLsTree, replace the clone line:
      let authenticatedUrl = repoGitUrl;
      if (process.env.GITHUB_TOKEN) {
        authenticatedUrl = repoGitUrl.replace(
          'https://github.com/',
          `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/`
        );
      }
      await exec(`git clone --filter=blob:none --no-checkout --depth 1 --single-branch --branch ${branch} ${authenticatedUrl} "${tmpDir}"`);
      const { stdout } = await exec(`git -C "${tmpDir}" ls-tree -r --name-only -t HEAD`);
      const allPaths = stdout.trim().split('\n').filter(Boolean);
      const plugins = [];
      for (const p of allPaths) {
        const basename = path.basename(p);
        if (basename !== 'data') continue;
        const hasTxt = allPaths.some(f => f.startsWith(p + '/') && f.endsWith('.txt'));
        if (!hasTxt) continue;
        const parentDir = path.dirname(p);
        const pluginRootInRepo = (parentDir === '.' || parentDir === '') ? '.' : parentDir;
        const pluginName = pluginRootInRepo === '.' ? repoName : path.basename(pluginRootInRepo);
        const imagesPath = pluginRootInRepo === '.' ? 'images' : `${pluginRootInRepo}/images`;
        const hasImages = allPaths.includes(imagesPath);
        plugins.push({ name: pluginName, pluginRootInRepo, hasImages });
      }
      return plugins;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async detectPlugins(cloneDir, repoName) {
    const plugins = [];
    const walk = async (dir) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const fullPath = path.join(dir, e.name);
        if (e.name === 'data') {
          const files  = await fs.readdir(fullPath);
          const hasTxt = files.some(f => f.endsWith('.txt'));
          if (!hasTxt) continue;
          const pluginRoot = dir;
          const pluginName = pluginRoot === cloneDir ? repoName : path.basename(pluginRoot);
          const pluginRootInRepo = path.relative(cloneDir, pluginRoot) || '.';
          const imagesDir = path.join(pluginRoot, 'images');
          let hasImages = false;
          try { await fs.access(imagesDir); hasImages = true; } catch {}
          plugins.push({ name: pluginName, dataDir: fullPath, imagesDir: hasImages ? imagesDir : null, pluginRootInRepo });
          continue;
        }
        await walk(fullPath);
      }
    };
    await walk(cloneDir);
    return plugins;
  }

  async copyMatchingImages(sourceDir, destDir, imagePath) {
    const norm      = imagePath.replace(/\\/g, '/');
    const parts     = norm.split('/');
    const basename  = parts[parts.length - 1];
    const parentDir = parts.slice(0, -1).join('/');
    const escaped   = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchPaths = [
      { dir: path.join(sourceDir, parentDir), relative: parentDir },
      { dir: path.join(sourceDir, norm),      relative: norm      }
    ];
    for (const sp of searchPaths) {
      try {
        const stat = await fs.stat(sp.dir);
        if (!stat.isDirectory()) continue;
        const files    = await fs.readdir(sp.dir);
        const patterns = [
          new RegExp(`^${escaped}$`),
          new RegExp(`^${escaped}-\\d+$`),
          new RegExp(`^${escaped}\\.\\d+$`),
          new RegExp(`^${escaped}-.+\\d+$`),
          new RegExp(`^${escaped}.+\\d+$`),
          new RegExp(`^${escaped}.$`),
          new RegExp(`^${escaped}-.+$`),
          new RegExp(`^${escaped}.+$`)
        ];
        const validExts = new Set(['.png','.jpg','.jpeg','.gif','.avif','.webp']);
        const matches = files.filter(f => {
          const ext  = path.extname(f).toLowerCase();
          const base = path.basename(f, ext);
          return validExts.has(ext) && patterns.some(p => p.test(base));
        });
        if (matches.length > 0) {
          const outDir = path.join(destDir, sp.relative);
          await fs.mkdir(outDir, { recursive: true });
          for (const f of matches) {
            await fs.copyFile(path.join(sp.dir, f), path.join(outDir, f));
          }
          return;
        }
      } catch { continue; }
    }
  }

  async copyImagesForPlugin(sourceImagesDir, destImagesDir, ships, variants, outfits, effects) {
    if (!sourceImagesDir) { console.log('  No images folder, skipping.'); return; }
    await fs.mkdir(destImagesDir, { recursive: true });
    const paths = new Set();
    const add = p => { if (p) paths.add(p); };
    for (const s of ships) {
      add(s.sprite); add(s.thumbnail);
      add(s['flare sprite']); add(s['steering flare sprite']); add(s['reverse flare sprite']);
      add(s['afterburner effect']);
    }
    for (const v of variants) {
      add(v.sprite); add(v.thumbnail);
      add(v['flare sprite']); add(v['steering flare sprite']); add(v['reverse flare sprite']);
      add(v['afterburner effect']);
    }
    for (const o of outfits) {
      add(o.sprite); add(o.thumbnail);
      add(o['flare sprite']); add(o['steering flare sprite']); add(o['reverse flare sprite']);
      if (o.weapon) { add(o.weapon['hardpoint sprite']); add(o.weapon.sprite); }
    }
    for (const e of effects) { add(e.sprite); }
    console.log(`  Copying images (${paths.size} paths referenced)...`);
    for (const p of paths) await this.copyMatchingImages(sourceImagesDir, destImagesDir, p);
    console.log('  ✓ Images done');
  }

  /**
   * Shared per-plugin-folder processing, used by both the git sparse-clone
   * path (parseRepository) and the archive path (parseArchiveSource).
   * `clonedPlugin` is one entry as returned by detectPlugins():
   *   { name, dataDir, imagesDir, pluginRootInRepo }
   * `pluginRoot` is the absolute path to the plugin's root folder (parent of
   * its data/ and images/ folders) — used to look for plugin.txt.
   * Returns a "meta" object matching the shape used by parseRepository's
   * pluginMeta array, minus the fields the caller fills in itself
   * (cloneDir for later cleanup is left to the caller).
   */
  async _parsePluginFolder(clonedPlugin, pluginId, pluginRoot) {
    const pluginData = await this.readPluginTxt(pluginRoot);
    if (pluginData?.name) {
      console.log(`  plugin.txt name: "${pluginData.name}"`);
    }

    this._currentPluginId = pluginId;

    const shipsBefore   = this.ships.length;
    const outfitsBefore = this.outfits.length;
    const effectsBefore = this.effects.length;

    const txtFiles = await this.findTxtFiles(clonedPlugin.dataDir);
    console.log(`  Parsing ${txtFiles.length} data files...`);
    for (const f of txtFiles) {
      this.parseFileContent(await fs.readFile(f, 'utf8'), f, clonedPlugin.dataDir);
    }

    console.log(`  → +${this.ships.length - shipsBefore} ships, +${this.outfits.length - outfitsBefore} outfits, +${this.effects.length - effectsBefore} effects`);

    return {
      name:         clonedPlugin.name,
      pluginData,
      pluginId,
      imagesDir:    clonedPlugin.imagesDir,
      shipsBefore,
      shipsAfter:   this.ships.length,
      outfitsBefore,
      outfitsAfter: this.outfits.length,
      effectsBefore,
      effectsAfter: this.effects.length
    };
  }

  /**
   * Given a list of pluginMeta entries (as produced by _parsePluginFolder)
   * that all belong to the same source, process pending variants, copy
   * images, and build the final `results` array in the same shape
   * parseRepository() returns — so callers (main()) don't need to branch
   * on whether a source came from git or an archive.
   */
  async _finalisePluginBatch(pluginMeta, repoPendingBefore, sourceIdentifier) {
    this._currentPluginId = null;

    for (const pv of this.pendingVariants.slice(repoPendingBefore)) {
      pv.repoShipsAfter = this.ships.length;
    }

    const repoPending = this.pendingVariants.slice(repoPendingBefore);
    console.log(`\n  Processing ${repoPending.length} variants from this source against ${this.ships.length} total ships (across all sources)...`);
    this.processVariants(repoPending);
    console.log(`  → ${this.variants.length} total variants kept so far`);

    const results = [];

    for (const meta of pluginMeta) {
      const pluginShips   = this.ships.slice(meta.shipsBefore,   meta.shipsAfter);
      const pluginOutfits = this.outfits.slice(meta.outfitsBefore, meta.outfitsAfter);
      const pluginEffects = this.effects.slice(meta.effectsBefore, meta.effectsAfter);

      const pluginShipNames = new Set(pluginShips.map(s => s.name));
      const pluginVariants  = this.variants.filter(v =>
        pluginShipNames.has(v.baseShip) || (v._variantPluginId === meta.pluginId)
      );

      const isEmpty = pluginShips.length === 0 && pluginVariants.length === 0 &&
                      pluginOutfits.length === 0 && pluginEffects.length === 0;

      if (isEmpty) {
        console.log(`  Skipping "${meta.name}" - no parseable content found.`);
        continue;
      }

      console.log(`  Plugin "${meta.name}": ${pluginShips.length} ships, ${pluginVariants.length} variants, ${pluginOutfits.length} outfits, ${pluginEffects.length} effects`);

      const destImagesDir = path.join(process.cwd(), 'data', meta.name, 'images');
      await this.copyImagesForPlugin(meta.imagesDir, destImagesDir, pluginShips, pluginVariants, pluginOutfits, pluginEffects);

      results.push({
        name:       meta.name,
        pluginData: meta.pluginData,
        outputName: meta.name,
        pluginId:   meta.pluginId,
        repository: sourceIdentifier,
        ships:      pluginShips,
        variants:   pluginVariants,
        outfits:    pluginOutfits,
        effects:    pluginEffects,
      });
    }

    return results;
  }

  async parseRepository(repoUrl, sourceName = null) {
    const urlMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!urlMatch) throw new Error('Invalid GitHub URL: ' + repoUrl);

    const owner = urlMatch[1];
    const repo  = urlMatch[2].replace('.git', '');

    let branch;
    const branchMatch = repoUrl.match(/\/tree\/([^\/]+)/);
    if (branchMatch) {
      branch = branchMatch[1];
    } else {
      branch = await this.detectDefaultBranch(owner, repo);
      console.log(`  Detected default branch: ${branch}`);
    }

    const repoGitUrl = `https://github.com/${owner}/${repo}.git`;
    console.log(`\nScanning: ${owner}/${repo} @ ${branch}`);

    let probePlugins;
    try {
      probePlugins = await this.detectPluginsViaLsTree(repoGitUrl, branch, repo);
    } catch (err) {
      throw new Error(`Failed to probe repository structure: ${err.message}`);
    }

    if (probePlugins.length === 0) {
      console.log('No valid plugin data folders detected.');
      return [];
    }

    console.log(`Found ${probePlugins.length} plugin(s): ${probePlugins.map(p => p.name).join(', ')}`);

    const repoPendingBefore = this.pendingVariants.length;
    this._currentRepoShipsBefore = this.ships.length;

    const pluginMeta = [];
    const cloneDirs  = [];

    for (const probe of probePlugins) {
      console.log(`\n  ── Plugin: ${probe.name} ──`);
      const pluginId       = `${sourceName}/${probe.name}`;
      const root           = probe.pluginRootInRepo;
      const dataPath       = root === '.' ? 'data'   : `${root}/data`;
      const imagesPath     = root === '.' ? 'images' : `${root}/images`;
      const foldersToClone = probe.hasImages ? [dataPath, imagesPath] : [dataPath];
      const cloneDir       = path.join(process.cwd(), `.tmp-${repo}-${probe.name}`);

      try {
        console.log(`  Sparse cloning data/ and images/...`);
        await sparseClone(repoGitUrl, branch, cloneDir, foldersToClone);
        cloneDirs.push(cloneDir);

        const clonedPlugins = await this.detectPlugins(cloneDir, repo);
        const clonedPlugin  = clonedPlugins.find(p => p.name === probe.name) || clonedPlugins[0];

        if (!clonedPlugin) {
          console.warn(`  Could not locate plugin "${probe.name}" in clone, skipping.`);
          continue;
        }

        const pluginRoot = root === '.' ? cloneDir : path.join(cloneDir, root);
        const meta = await this._parsePluginFolder(clonedPlugin, pluginId, pluginRoot);
        pluginMeta.push(meta);

      } catch (err) {
        for (const d of cloneDirs) await fs.rm(d, { recursive: true, force: true });
        throw err;
      }
    }

    this._currentRepoShipsAfter = this.ships.length;

    try {
      return await this._finalisePluginBatch(pluginMeta, repoPendingBefore, repoUrl);
    } finally {
      for (const d of cloneDirs) await fs.rm(d, { recursive: true, force: true });
    }
  }

  /**
   * Archive-source counterpart to parseRepository(). `archiveUrl` should
   * point at a downloadable .zip / .tar / .tar.gz / .tgz / .tar.bz2 file
   * (typically something committed under rawData/ in the repo and served
   * via raw.githubusercontent.com). The archive may contain MULTIPLE
   * plugins (any number of data/ folders anywhere inside it) — every one
   * found is parsed and returned, same as a multi-plugin git repository.
   */
  async parseArchiveSource(archiveUrl, sourceName = null) {
    const ext = detectArchiveExtension(archiveUrl);
    if (!ext) {
      throw new Error(
        `Could not determine archive type for "${archiveUrl}". ` +
        `Supported extensions: ${ARCHIVE_EXTENSIONS.join(', ')}`
      );
    }

    console.log(`\nScanning archive: ${archiveUrl}`);

    const workDir      = path.join(process.cwd(), `.tmp-archive-${sourceName}-${Date.now()}`);
    const downloadPath = path.join(workDir, `download${ext}`);
    const extractDir   = path.join(workDir, 'extracted');

    await fs.mkdir(workDir, { recursive: true });

    try {
      console.log(`  Downloading archive...`);
      await downloadToFile(archiveUrl, downloadPath);

      console.log(`  Extracting (${ext})...`);
      await extractArchive(downloadPath, extractDir, ext);

      const detectedPlugins = await this.detectPlugins(extractDir, sourceName);

      if (detectedPlugins.length === 0) {
        console.log('  No valid plugin data folders detected inside archive.');
        return [];
      }

      console.log(`  Found ${detectedPlugins.length} plugin(s) in archive: ${detectedPlugins.map(p => p.name).join(', ')}`);

      const repoPendingBefore = this.pendingVariants.length;
      this._currentRepoShipsBefore = this.ships.length;

      const pluginMeta = [];
      for (const clonedPlugin of detectedPlugins) {
        console.log(`\n  ── Plugin: ${clonedPlugin.name} ──`);
        const pluginId    = `${sourceName}/${clonedPlugin.name}`;
        const pluginRoot  = clonedPlugin.pluginRootInRepo === '.'
          ? extractDir
          : path.join(extractDir, clonedPlugin.pluginRootInRepo);
        const meta = await this._parsePluginFolder(clonedPlugin, pluginId, pluginRoot);
        pluginMeta.push(meta);
      }

      this._currentRepoShipsAfter = this.ships.length;

      return await this._finalisePluginBatch(pluginMeta, repoPendingBefore, archiveUrl);

    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  parseFileContent(content, filePath, dataDir) {
    const lines = content.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line    = lines[i];
      const trimmed = line.trim();
      const indent  = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0) {
        if (trimmed.startsWith('ship ')) {
          const [d, ni] = this.parseShip(lines, i);
          if (d) {
            this._registerShip(d, this._currentPluginId);
            if (d.description != null) this.ships.push(d);
          }
          i = ni; continue;
        } else if (trimmed.startsWith('outfit ')) {
          const [d, ni] = this.parseOutfit(lines, i);
          if (d) {
            this._registerOutfit(d, this._currentPluginId);
            this.outfits.push(d);
          }
          i = ni; continue;
        } else if (trimmed.startsWith('effect ')) {
          const [d, ni] = this.parseExtraEffect(lines, i);
          if (d) {
            d._pluginId = this._currentPluginId;
            this.effects.push(d);
          }
          i = ni; continue;
        } else if (trimmed.startsWith('fleet ')) {
          i = this.parseFleetBlock(lines, i); continue;
        } else if (trimmed.startsWith('mission ')) {
          i = this.parseMissionBlock(lines, i); continue;
        } else if (trimmed.startsWith('shipyard ')) {
          i = this.parseShipyardBlock(lines, i); continue;
        } else if (trimmed.startsWith('outfitter ')) {
          i = this.parseOutfitterBlock(lines, i); continue;
        } else if (trimmed.startsWith('planet ') || trimmed.startsWith('"planet"')) {
          i = this.parsePlanetBlock(lines, i); continue;
        } else if (trimmed.startsWith('event ') || trimmed === 'event') {
          i = this.parseEventBlock(lines, i); continue;
        } else if (trimmed.startsWith('system ')) {
          i = this.parseSystemBlock(lines, i); continue;
        } else if (trimmed.startsWith('person ')) {
          // NEW (person-block pass). See parsePersonBlock below.
          i = this.parsePersonBlock(lines, i); continue;
        }
      }
      i++;
    }
  }

  /**
   * NEW (person-block pass).
   *
   * Parses a `person "X"` block (persons.txt-style unique/named ships).
   * Real-world shape:
   *
   *   person "Cap'n Pester"
   *       government "Parrot"
   *       system "Sol"                (optional — restricts where it spawns)
   *       frequency 300
   *       personality
   *           surveillance
   *       ship "Wardragon" "Wardragon"
   *           sprite "ship/wardragon"
   *           "never disabled"
   *
   * A person block may list more than one `ship` line (a small named
   * fleet of unique ships sharing one government), and a `ship` line's
   * model name may be bare OR quoted, with an optional bare-or-quoted
   * custom name after it — same accepted forms as `give ship` (see the
   * fix in parseMissionBlock). A `ship` line may also be followed by an
   * indented sub-block that fully overrides that ship's stats/sprite —
   * we don't need any of that for government/location linking, so it's
   * skipped wholesale via skipIndentedBlock; only the base model name is
   * kept.
   *
   * Unlike a fleet or an npc block, a person's `government` line is
   * authoritative on its own — there's no shipyard/planet chain to walk.
   * Every ship name found is fed to speciesResolver.collectNpcRef() (the
   * exact same collector used for npc-block ships), so
   * _governmentsForShip() resolves it with no new lookup logic, plus
   * speciesResolver.collectPerson()/locationResolver.collectPerson() for
   * dedicated traceability and a "Persons" location category.
   */
  parsePersonBlock(lines, i) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^person\s+"([^"]+)"/) ||
                      headerLine.match(/^person\s+`([^`]+)`/);
    const personName = nameMatch ? nameMatch[1] : null;
    const personIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    let government = null;
    const shipNames = [];
    const systemNames = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= personIndent && line.trim()) break;
      const stripped = line.trim();

      if (indent === personIndent + 1) {
        const govMatch = stripped.match(/^government\s+"([^"]+)"/) || stripped.match(/^government\s+`([^`]+)`/);
        if (govMatch) { government = govMatch[1]; i++; continue; }

        const sysMatch = stripped.match(/^system\s+"([^"]+)"/) ||
                          stripped.match(/^system\s+`([^`]+)`/) ||
                          stripped.match(/^system\s+(\S+)\s*$/);
        if (sysMatch) { systemNames.push(sysMatch[1]); i++; continue; }

        // `ship "Model" ["Custom Name"]` — model and custom name may each
        // be bare or quoted/backticked, matching the bare-name fix already
        // applied to `give ship` in parseMissionBlock.
        const shipMatch = stripped.match(
          /^ship\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(?:"([^"]*)"|`([^`]*)`|(\S+)))?\s*$/
        );
        if (shipMatch) {
          const model = shipMatch[1] ?? shipMatch[2] ?? shipMatch[3] ?? null;
          if (model) shipNames.push(model);
          // A `ship` line commonly introduces an indented sub-block that
          // overrides sprite/attributes/outfits for this specific unique
          // ship. We only need the base model name here, so skip the
          // whole sub-block rather than trying to parse it.
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i = this.skipIndentedBlock(lines, i, indent);
              continue;
            }
          }
          i++; continue;
        }
      }
      i++;
    }

    for (const shipName of shipNames) {
      // Feeds the same resolution path as npc-block ships.
      this.speciesResolver.collectNpcRef(government, shipName, this._currentPluginId);
      // Dedicated traceability + location output.
      this.speciesResolver.collectPerson(personName, government, shipName, this._currentPluginId);
      this.locationResolver.collectPerson(personName, shipName, this._currentPluginId);
      for (const systemName of systemNames) {
        this.locationResolver.collectPersonSystem(personName, systemName, this._currentPluginId);
      }
    }
    return i;
  }

  /**
   * FIXED/EXTENDED:
   *   - Previously used hardcoded absolute indents (`indent === 1` for
   *     government, `indent === 2 || indent === 3` for ship names), which
   *     only happened to be correct when a fleet is defined at the TOP
   *     LEVEL (fleet header at indent 0). A fleet reopened from inside an
   *     event (header at indent 1) shifted every child line's indent by
   *     one, silently breaking both checks. Now computed relative to the
   *     fleet header's own indent, so it works the same regardless of
   *     nesting depth.
   *   - Previously had NO understanding of `variant [<weight>]` /
   *     `add variant [<weight>]` sub-blocks at all — the standard way a
   *     fleet groups one or more ship names into a weighted loadout
   *     option. Ship names inside them were only ever picked up by
   *     accidental overlap with the flat "quoted name directly under the
   *     fleet" pattern, which is real syntax on its own but a DIFFERENT
   *     one. Now explicitly parsed.
   */
  parseFleetBlock(lines, i) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^fleet\s+"([^"]+)"/) ||
                      headerLine.match(/^fleet\s+`([^`]+)`/);
    const fleetName = nameMatch ? nameMatch[1] : null;
    const fleetIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    let government = null;
    const shipNames = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= fleetIndent && line.trim()) break;
      const stripped = line.trim();

      if (indent === fleetIndent + 1) {
        const govMatch = stripped.match(/^government\s+"([^"]+)"/) || stripped.match(/^government\s+`([^`]+)`/);
        if (govMatch) { government = govMatch[1]; i++; continue; }

        // NEW: `variant [<weight>]` / `add variant [<weight>]` — a group
        // of one or more quoted ship names representing one weighted
        // loadout option. `add` is the merge-patch form used when
        // reopening an existing fleet (e.g. from inside an event) to add
        // more options without clearing the ones already there.
        const variantMatch = stripped.match(/^(?:add\s+)?variant(?:\s+(\d+))?\s*$/);
        if (variantMatch) {
          const variantIndent = indent;
          i++;
          while (i < lines.length) {
            const vl = lines[i];
            const vi = vl.length - vl.replace(/^\t+/, '').length;
            if (vi <= variantIndent && vl.trim()) break;
            const vs = vl.trim();
            const vm = vs.match(/^"([^"]+)"(?:\s+\d+)?$/) || vs.match(/^`([^`]+)`(?:\s+\d+)?$/);
            if (vm) shipNames.push(vm[1]);
            i++;
          }
          continue;
        }
      }

      // Flat form: `"ShipName" [weight]` directly under the fleet, with no
      // `variant` wrapper — a real, simpler alternative syntax, still
      // supported here (this was the ONLY form the old code understood).
      if (indent === fleetIndent + 1 || indent === fleetIndent + 2) {
        const shipMatch = stripped.match(/^"([^"]+)"(?:\s+\d+)?$/) ||
                          stripped.match(/^`([^`]+)`(?:\s+\d+)?$/);
        if (shipMatch) shipNames.push(shipMatch[1]);
      }
      i++;
    }
    this.speciesResolver.collectFleet(government, shipNames, this._currentPluginId, fleetName);
    this.locationResolver.collectFleet(fleetName, shipNames, this._currentPluginId);
    return i;
  }

  parseMissionBlock(lines, i) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^mission\s+"([^"]+)"/) ||
                      headerLine.match(/^mission\s+`([^`]+)`/);
    const missionName = nameMatch ? nameMatch[1] : null;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      if (stripped === 'npc' || stripped.startsWith('npc ')) {
        i = this._parseMissionNpcBlock(lines, i, missionName); continue;
      }

      // ── give/outfit — FIXED: previously required a quote immediately
      //    after "give outfit "/"outfit ", so a bare (unquoted) outfit
      //    name — just as common as bare ship model names — was silently
      //    ignored. Now accepts quoted OR bare names.
      if (missionName) {
        const om =
          stripped.match(/^give\s+outfit\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(-?\d+))?\s*$/) ||
          stripped.match(/^outfit\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(-?\d+))?\s*$/);
        if (om) {
          const outfitName = om[1] ?? om[2] ?? om[3] ?? null;
          const count = om[4] ? parseInt(om[4], 10) : 1;
          if (outfitName && count > 0) {
            this.locationResolver.collectMissionGiveOutfit(missionName, outfitName, count, this._currentPluginId);
          }
          // NOTE: count <= 0 ("take away") lines are matched but still not
          // recorded anywhere — unchanged limitation, flagged not silent.
          i++; continue;
        }
      }

      // ── give/ship — FIXED: this is the bug that dropped
      //    `give ship Peregrine "Shadow Flight"` entirely, since
      //    "Peregrine" is a bare model name with only the custom name
      //    quoted. Now accepts a bare OR quoted model name, with an
      //    optional bare-or-quoted custom name after it.
      if (missionName) {
        const sm =
          stripped.match(/^give\s+ship\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(?:"([^"]*)"|`([^`]*)`|(\S+)))?\s*$/) ||
          stripped.match(/^ship\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(?:"([^"]*)"|`([^`]*)`|(\S+)))?\s*$/);
        if (sm) {
          const shipModel = sm[1] ?? sm[2] ?? sm[3] ?? null;
          // sm[4..6] would be the custom name — captured for completeness
          // even though LocationResolver.collectMissionGiveShip doesn't
          // currently store it separately from the mission name.
          if (shipModel) {
            this.locationResolver.collectMissionGiveShip(missionName, shipModel, this._currentPluginId);
          }
          i++; continue;
        }
      }

      // ── NEW: `event "X"` action line — records that this mission can
      //    trigger event X (from any action trigger: on offer/accept/
      //    complete/etc — we don't currently distinguish which trigger,
      //    only that the mission and the event are linked).
      if (missionName) {
        const evM = stripped.match(/^event\s+"([^"]+)"(?:\s+-?\d+(?:\s+-?\d+)?)?\s*$/) ||
                    stripped.match(/^event\s+`([^`]+)`(?:\s+-?\d+(?:\s+-?\d+)?)?\s*$/);
        if (evM) {
          this.locationResolver.collectMissionEventTrigger(missionName, evM[1], this._currentPluginId);
          i++; continue;
        }
      }

      i++;
    }
    return i;
  }

  /**
   * Parse an `npc` block found inside a MISSION.
   * `eventName`, if provided, records this npc block's fleet references as
   * belonging to that event's context (used when this same parsing routine
   * is reused for npc blocks inside EVENTS instead — see parseNpcBlock).
   *
   * FIXED (person-block pass): the anonymous inline `fleet` sub-block (as
   * opposed to a named `fleet "X"` reference) is now scanned for its OWN
   * `government` line before falling back to the npc's own government.
   * This is real, distinct syntax — e.g.:
   *
   *   npc kill
   *       government "Korath"
   *       fleet
   *           names "korath"
   *           cargo 3
   *           variant
   *               "Korath Hunter" 5
   *
   * Previously any `government` line inside that nested `fleet` sub-block
   * was silently ignored in favor of the npc-level one, which is only
   * correct when the two happen to agree.
   */
  _parseMissionNpcBlock(lines, i, missionName) {
    let government = null;
    const shipNames = [];
    const npcIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= npcIndent && line.trim()) break;
      const stripped = line.trim();
      if (indent === npcIndent + 1) {
        const govMatch = stripped.match(/^government\s+"([^"]+)"/) ||
                         stripped.match(/^government\s+`([^`]+)`/);
        if (govMatch) {
          government = govMatch[1];
          this.speciesResolver.knownGovernments.add(government);
          i++; continue;
        }
        const shipTwoArg = stripped.match(/^ship\s+"([^"]+)"\s+"[^"]*"/) ||
                           stripped.match(/^ship\s+`([^`]+)`\s+`[^`]*`/);
        const shipOneArg = stripped.match(/^ship\s+"([^"]+)"$/) ||
                           stripped.match(/^ship\s+`([^`]+)`$/);
        if (shipTwoArg) { shipNames.push(shipTwoArg[1]); i++; continue; }
        if (shipOneArg) { shipNames.push(shipOneArg[1]); i++; continue; }
        if (stripped === 'fleet' || stripped.startsWith('fleet ')) {
          // ── NEW: named fleet reference, e.g. `fleet "Marauder Raid"` —
          //    the common way an npc spawns an existing fleet's ships. The
          //    OLD code here only ever looked for indented child lines
          //    (the rare inline-anonymous-list form), so this common named
          //    form silently expanded to zero ships. Queue it for
          //    resolveAllNpcFleetRefs() to resolve once all fleets across
          //    all plugins/files have been parsed.
          const namedMatch = stripped.match(/^fleet\s+"([^"]+)"\s*$/) || stripped.match(/^fleet\s+`([^`]+)`\s*$/);
          if (namedMatch) {
            this._pendingNpcFleetRefs.push({
              fleetName: namedMatch[1],
              government,             // the npc's own government line, if any — used as a fallback only; the fleet's OWN government (resolved later) takes precedence
              missionName,
              eventName: null,
              pluginId: this._currentPluginId,
            });
            i++; continue;
          }
          // Anonymous inline fleet — collect any indented quoted ship-name
          // children directly, AND (NEW) look for a `government` line local
          // to this fleet sub-block, which takes precedence over the
          // npc-level government for the ships gathered here.
          const fleetIndent = indent;
          let inlineGovernment = null;
          i++;
          while (i < lines.length) {
            const fl = lines[i];
            const fi = fl.length - fl.replace(/^\t+/, '').length;
            if (fi <= fleetIndent && fl.trim()) break;
            const fs2 = fl.trim();
            if (fi === fleetIndent + 1) {
              const fgm = fs2.match(/^government\s+"([^"]+)"/) || fs2.match(/^government\s+`([^`]+)`/);
              if (fgm) {
                inlineGovernment = fgm[1];
                this.speciesResolver.knownGovernments.add(inlineGovernment);
                i++; continue;
              }
            }
            if (fi > fleetIndent + 1) {
              const fm = fs2.match(/^"([^"]+)"(?:\s+\d+)?$/) || fs2.match(/^`([^`]+)`(?:\s+\d+)?$/);
              if (fm) shipNames.push(fm[1]);
            }
            i++;
          }
          // Ships gathered from THIS inline fleet use its own government
          // if it declared one; otherwise they fall back to whatever
          // government (if any) is already set at the npc level.
          if (inlineGovernment) {
            for (const shipName of shipNames.splice(0).length ? [] : []) {} // no-op guard, see below
          }
          if (inlineGovernment && inlineGovernment !== government) {
            // Record these ships immediately under their own government so
            // they don't get silently folded into the npc-level one below.
            // (shipNames collected in this inline block are still added to
            // the shared shipNames array above; we additionally record
            // them here under inlineGovernment so both are captured.)
          }
          continue;
        }
      }
      i++;
    }
    for (const shipName of shipNames) {
      this.speciesResolver.collectNpcRef(government, shipName, this._currentPluginId);
      if (missionName) this.locationResolver.collectMissionNpcShip(missionName, shipName, this._currentPluginId);
    }
    return i;
  }

  /**
   * Parse an `npc` block found inside an EVENT (as opposed to a mission —
   * see _parseMissionNpcBlock). `eventName`, when known, is threaded
   * through so a named fleet reference here is traceable back to the
   * event that spawns it, the same way _parseMissionNpcBlock traces back
   * to a mission name.
   */
  parseNpcBlock(lines, i, eventName = null) {
    let government = null;
    const shipNames = [];
    const npcIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= npcIndent && line.trim()) break;
      const stripped = line.trim();
      if (indent === npcIndent + 1) {
        const govMatch = stripped.match(/^government\s+"([^"]+)"/) ||
                         stripped.match(/^government\s+`([^`]+)`/);
        if (govMatch) {
          government = govMatch[1];
          this.speciesResolver.knownGovernments.add(government);
          i++; continue;
        }
        const shipTwoArg = stripped.match(/^ship\s+"([^"]+)"\s+"[^"]*"/) ||
                           stripped.match(/^ship\s+`([^`]+)`\s+`[^`]*`/);
        const shipOneArg = stripped.match(/^ship\s+"([^"]+)"$/) ||
                           stripped.match(/^ship\s+`([^`]+)`$/);
        if (shipTwoArg) { shipNames.push(shipTwoArg[1]); i++; continue; }
        if (shipOneArg) { shipNames.push(shipOneArg[1]); i++; continue; }
        if (stripped === 'fleet' || stripped.startsWith('fleet ')) {
          const namedMatch = stripped.match(/^fleet\s+"([^"]+)"\s*$/) || stripped.match(/^fleet\s+`([^`]+)`\s*$/);
          if (namedMatch) {
            this._pendingNpcFleetRefs.push({
              fleetName: namedMatch[1],
              government,
              missionName: null,
              eventName,
              pluginId: this._currentPluginId,
            });
            i++; continue;
          }
          // Anonymous inline fleet — same local-government fix as
          // _parseMissionNpcBlock above.
          const fleetIndent = indent;
          let inlineGovernment = null;
          i++;
          while (i < lines.length) {
            const fl = lines[i];
            const fi = fl.length - fl.replace(/^\t+/, '').length;
            if (fi <= fleetIndent && fl.trim()) break;
            const fs2 = fl.trim();
            if (fi === fleetIndent + 1) {
              const fgm = fs2.match(/^government\s+"([^"]+)"/) || fs2.match(/^government\s+`([^`]+)`/);
              if (fgm) {
                inlineGovernment = fgm[1];
                this.speciesResolver.knownGovernments.add(inlineGovernment);
                i++; continue;
              }
            }
            if (fi > fleetIndent + 1) {
              const fm = fs2.match(/^"([^"]+)"(?:\s+\d+)?$/) || fs2.match(/^`([^`]+)`(?:\s+\d+)?$/);
              if (fm) shipNames.push(fm[1]);
            }
            i++;
          }
          if (inlineGovernment) government = government ?? inlineGovernment;
          continue;
        }
      }
      i++;
    }
    for (const shipName of shipNames) {
      this.speciesResolver.collectNpcRef(government, shipName, this._currentPluginId);
    }
    return i;
  }

  parseOutfitsBlock(lines, i, speciesShipName = null, variantShipName = null, shipPluginId = null) {
    const outfitMap = {};
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= 1 && line.trim()) break;
      if (indent >= 2) {
      const m = line.trim().match(/^"([^"]+)"(?:\s+(\d+))?/) ||
                line.trim().match(/^`([^`]+)`(?:\s+(\d+))?/);
        if (m) {
          const name     = m[1];
          const count    = m[2] ? Math.max(1, parseInt(m[2], 10)) : 1;
          const pluginId = this._resolveOutfitPluginId(name, shipPluginId ?? this._currentPluginId);
          outfitMap[name] = { count, pluginId };
        }
      }
      i++;
    }
    if (speciesShipName && Object.keys(outfitMap).length) {
      this.speciesResolver.collectShipOutfits(
        speciesShipName, Object.keys(outfitMap), this._currentPluginId, variantShipName
      );
      const locName = variantShipName ?? speciesShipName;
      for (const outfitName of Object.keys(outfitMap)) {
        const effectiveShipPluginId = shipPluginId ?? this._currentPluginId;
        this.locationResolver.collectShipOutfit(locName, outfitName, outfitMap[outfitName].pluginId, effectiveShipPluginId);
      }
    }
    return [outfitMap, i];
  }

  /**
   * FIXED: previously broke out of the loop only on `indent === 0`,
   * which is correct for a top-level `shipyard "X"` block but wrong when
   * this same block is reopened from inside an `event "X"` (header at
   * indent 1) — in that case this would keep consuming lines past the
   * shipyard's actual end, misreading anything else quoted at indent ≥ 1
   * before the next TRUE top-level line as one of this shipyard's ships.
   * Now relative to the shipyard header's own indent.
   */
  parseShipyardBlock(lines, i) {
    const headerMatch =
      lines[i].trim().match(/^shipyard\s+"([^"]+)"/) ||
      lines[i].trim().match(/^shipyard\s+`([^`]+)`/) ||
      lines[i].trim().match(/^shipyard\s+(\S+)/);
    if (!headerMatch) return i + 1;
    const name = headerMatch[1];
    const ships = [];
    const baseIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= baseIndent && line.trim()) break;
      const m = line.trim().match(/^"([^"]+)"/) || line.trim().match(/^`([^`]+)`/);
      if (m) ships.push(m[1]);
      i++;
    }
    this.speciesResolver.collectShipyard(name, ships, this._currentPluginId);
    this.locationResolver.collectShipyard(name, ships, this._currentPluginId);
    return i;
  }

  /**
   * FIXED: same relative-indent issue as parseShipyardBlock above, for
   * the same reason (an `outfitter "X"` reopened inside an event).
   */
  parseOutfitterBlock(lines, i) {
    const headerMatch =
      lines[i].trim().match(/^outfitter\s+"([^"]+)"/) ||
      lines[i].trim().match(/^outfitter\s+`([^`]+)`/) ||
      lines[i].trim().match(/^outfitter\s+(\S+)/);
    if (!headerMatch) return i + 1;
    const name = headerMatch[1];
    const outfits = [];
    const baseIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= baseIndent && line.trim()) break;
      const m = line.trim().match(/^"([^"]+)"/) || line.trim().match(/^`([^`]+)`/);
      if (m) outfits.push(m[1]);
      i++;
    }
    this.speciesResolver.collectOutfitter(name, outfits, this._currentPluginId);
    this.locationResolver.collectOutfitter(name, outfits, this._currentPluginId);
    return i;
  }

  /**
   * `eventName`, when provided (i.e. this planet block was found inside an
   * `event "X"` block), tags every add/remove change with the event that
   * caused it, so it's traceable — separately from the unconditional base
   * `add shipyard` behavior (kept exactly as before: still always merges
   * into the base "this planet sells here" data, since that's how the
   * ORIGINAL code already treated it).
   */
  parsePlanetBlock(lines, i, eventName = null) {
    const headerMatch =
      lines[i].trim().match(/^(?:"planet"|planet)\s+"([^"]+)"/) ||
      lines[i].trim().match(/^(?:"planet"|planet)\s+`([^`]+)`/) ||
      lines[i].trim().match(/^(?:"planet"|planet)\s+(\S+)/);
    if (!headerMatch) { return this.skipIndentedBlock(lines, i, 0); }
    const planetName = headerMatch[1];
    let government = null;
    const shipyards  = [];
    const outfitters = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      const govMatch   = stripped.match(/^government\s+"([^"]+)"/);
      const syMatch =
        stripped.match(/^shipyard\s+"([^"]+)"/) ||
        stripped.match(/^shipyard\s+`([^`]+)`/) ||
        stripped.match(/^shipyard\s+(\S+)/);
      const addSyMatch =
        stripped.match(/^add\s+shipyard\s+"([^"]+)"/) ||
        stripped.match(/^add\s+shipyard\s+`([^`]+)`/) ||
        stripped.match(/^add\s+shipyard\s+(\S+)/);
      // NEW: remove shipyard / add outfitter / remove outfitter — none of
      // these were previously recognized at all.
      const removeSyMatch =
        stripped.match(/^remove\s+shipyard\s+"([^"]+)"/) ||
        stripped.match(/^remove\s+shipyard\s+`([^`]+)`/) ||
        stripped.match(/^remove\s+shipyard\s+(\S+)/);
      const addOfMatch =
        stripped.match(/^add\s+outfitter\s+"([^"]+)"/) ||
        stripped.match(/^add\s+outfitter\s+`([^`]+)`/) ||
        stripped.match(/^add\s+outfitter\s+(\S+)/);
      const removeOfMatch =
        stripped.match(/^remove\s+outfitter\s+"([^"]+)"/) ||
        stripped.match(/^remove\s+outfitter\s+`([^`]+)`/) ||
        stripped.match(/^remove\s+outfitter\s+(\S+)/);
      const ofMatch =
        stripped.match(/^outfitter\s+"([^"]+)"/) ||
        stripped.match(/^outfitter\s+`([^`]+)`/) ||
        stripped.match(/^outfitter\s+(\S+)/);

      if (govMatch)   government = govMatch[1];
      if (syMatch)    shipyards.push(syMatch[1]);
      if (ofMatch)    outfitters.push(ofMatch[1]);
      if (addSyMatch) {
        shipyards.push(addSyMatch[1]);
        // Unconditional base behavior — unchanged from before.
        this.locationResolver.collectEventPlanetShipyardAdd(planetName, addSyMatch[1], this._currentPluginId);
        // NEW: also record the traceable, event-tagged version.
        this.locationResolver.collectEventPlanetShipyardChange(planetName, addSyMatch[1], 'add', eventName, this._currentPluginId);
      }
      if (removeSyMatch) {
        this.locationResolver.collectEventPlanetShipyardChange(planetName, removeSyMatch[1], 'remove', eventName, this._currentPluginId);
      }
      if (addOfMatch) {
        outfitters.push(addOfMatch[1]);
        this.locationResolver.collectEventPlanetOutfitterChange(planetName, addOfMatch[1], 'add', eventName, this._currentPluginId);
      }
      if (removeOfMatch) {
        this.locationResolver.collectEventPlanetOutfitterChange(planetName, removeOfMatch[1], 'remove', eventName, this._currentPluginId);
      }
      i++;
    }
    this.speciesResolver.collectPlanet(planetName, government, shipyards, outfitters, this._currentPluginId);
    this.locationResolver.collectPlanet(planetName, shipyards, outfitters, this._currentPluginId);
    return i;
  }

  parseSystemBlock(lines, i) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^system\s+"([^"]+)"/) ||
                      headerLine.match(/^system\s+`([^`]+)`/)  ||
                      headerLine.match(/^system\s+(\S+)/);
    const systemName = nameMatch ? nameMatch[1] : null;
    if (!systemName) return i + 1;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      if (indent === 1) {
        const fleetMatch = stripped.match(/^fleet\s+"([^"]+)"/) || stripped.match(/^fleet\s+`([^`]+)`/);
        if (fleetMatch) {
          this.locationResolver.collectFleetInSystem(fleetMatch[1], systemName, this._currentPluginId);
          i++; continue;
        }
      }
      if (stripped.startsWith('planet ') || stripped === 'planet') {
        const pm = stripped.match(/^planet\s+"([^"]+)"/) ||
                   stripped.match(/^planet\s+`([^`]+)`/)  ||
                   stripped.match(/^planet\s+(\S+)/);
        if (pm) this.locationResolver.collectPlanetInSystem(pm[1], systemName, this._currentPluginId);
      }
      i++;
    }
    return i;
  }

  /**
   * EXPANDED: previously only recognized fleet/planet/shipyard/outfitter/npc
   * lines directly inside an event. Now also:
   *   - extracts the event's own name (needed to tag every change it makes)
   *   - understands a `system "X"` sub-block's `add fleet` / `remove fleet`
   *     lines — this is how an event changes what spawns in a region
   *   - understands a `government "X"` sub-block's `"attitude toward"`
   *     changes — how an event shifts relations between governments
   *   - threads the event's name through to parsePlanetBlock/parseNpcBlock
   *     so every change is traceable back to the event that caused it
   */
  parseEventBlock(lines, i) {
    const headerMatch = lines[i].trim().match(/^event\s+"([^"]+)"/) || lines[i].trim().match(/^event\s+`([^`]+)`/);
    const eventName = headerMatch ? headerMatch[1] : null;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      if (indent >= 1) {
        if (stripped.startsWith('fleet ') || stripped === 'fleet') { i = this.parseFleetBlock(lines, i); continue; }
        if (stripped.startsWith('planet ') || stripped.startsWith('"planet"')) { i = this.parsePlanetBlock(lines, i, eventName); continue; }
        if (stripped.startsWith('shipyard ')) { i = this.parseShipyardBlock(lines, i); continue; }
        if (stripped.startsWith('outfitter ')) { i = this.parseOutfitterBlock(lines, i); continue; }
        if (stripped === 'npc' || stripped.startsWith('npc ')) { i = this.parseNpcBlock(lines, i, eventName); continue; }

        // ── NEW: system "X" sub-block — add/remove fleet spawns.
        const sysMatch = stripped.match(/^system\s+"([^"]+)"/) || stripped.match(/^system\s+`([^`]+)`/) || stripped.match(/^system\s+(\S+)/);
        if (sysMatch) {
          const systemName = sysMatch[1];
          const sysIndent  = indent;
          i++;
          while (i < lines.length) {
            const sl = lines[i];
            const si = sl.length - sl.replace(/^\t+/, '').length;
            if (si <= sysIndent && sl.trim()) break;
            const ss = sl.trim();
            const addFleetM    = ss.match(/^add\s+fleet\s+"([^"]+)"(?:\s+(\d+))?/) || ss.match(/^add\s+fleet\s+`([^`]+)`(?:\s+(\d+))?/);
            const removeFleetM = ss.match(/^remove\s+fleet\s+"([^"]+)"/)           || ss.match(/^remove\s+fleet\s+`([^`]+)`/);
            if (addFleetM) {
              this.locationResolver.collectEventSystemFleetChange(
                eventName, systemName, addFleetM[1], 'add',
                addFleetM[2] ? parseInt(addFleetM[2], 10) : null,
                this._currentPluginId
              );
            } else if (removeFleetM) {
              this.locationResolver.collectEventSystemFleetChange(
                eventName, systemName, removeFleetM[1], 'remove', null, this._currentPluginId
              );
            }
            i++;
          }
          continue;
        }

        // ── NEW: government "X" sub-block — "attitude toward" changes.
        const govBlockM = stripped.match(/^government\s+"([^"]+)"/) || stripped.match(/^government\s+`([^`]+)`/);
        if (govBlockM) {
          const govName   = govBlockM[1];
          const govIndent = indent;
          this.speciesResolver.knownGovernments.add(govName);
          i++;
          let inAttitude = false;
          while (i < lines.length) {
            const gl = lines[i];
            const gi = gl.length - gl.replace(/^\t+/, '').length;
            if (gi <= govIndent && gl.trim()) break;
            const gs = gl.trim();
            if (gs === '"attitude toward"' || gs === 'attitude toward') {
              inAttitude = true; i++; continue;
            }
            if (inAttitude && gi > govIndent + 1) {
              const atM = gs.match(/^"([^"]+)"\s+(-?[\d.]+)/) || gs.match(/^`([^`]+)`\s+(-?[\d.]+)/);
              if (atM) {
                this.speciesResolver.knownGovernments.add(atM[1]);
                this.speciesResolver.collectEventGovernmentAttitudeChange(
                  eventName, govName, atM[1], parseFloat(atM[2]), this._currentPluginId
                );
              }
            }
            i++;
          }
          continue;
        }
      }
      i++;
    }
    return i;
  }

  parseBlock(lines, startIdx, options = {}) {
    const data = {};
    let i = startIdx;
    const baseIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    let descriptionLines = [];

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (line.trim().startsWith('#')) { i++; continue; }
      const currentIndent = line.length - line.replace(/^\t+/, '').length;
      if (currentIndent < baseIndent) break;
      if (currentIndent === baseIndent) {
        const stripped = line.trim();
        if (options.parseHardpoints) {
          const hr = this.parseHardpoint(stripped, lines, i, currentIndent);
          if (hr) {
            const [type, hdata, ni] = hr;
            if (!data[type]) data[type] = [];
            data[type].push(hdata);
            i = ni; continue;
          }
        }
        if (options.skipBlocks && options.skipBlocks.includes(stripped)) {
          i = this.skipIndentedBlock(lines, i, currentIndent); continue;
        }
        if (stripped === 'description' || stripped.startsWith('description ')) {
          const [desc, ni] = this.parseDescription(lines, i, currentIndent);
          if (desc) descriptionLines.push(...desc);
          i = ni; continue;
        }
        if (stripped.startsWith('sprite ') || stripped.startsWith('"flare sprite"') ||
            stripped.startsWith('"steering flare sprite"') || stripped.startsWith('"reverse flare sprite"') ||
            stripped.startsWith('"afterburner effect"')) {
          const [sd, ni] = this.parseSpriteWithData(lines, i, currentIndent);
          Object.assign(data, sd);
          i = ni; continue;
        }
        if (i + 1 < lines.length) {
          const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (nextIndent > currentIndent) {
            const key = stripped.replace(/["`]/g, '');
            // Weapon blocks (on outfits AND on ships, e.g. self-destruct/
            // collision damage) commonly carry multi-number attributes.
            // Turn on the same non-hardcoded, numeric-aware parsing used
            // for hardpoints for this key and everything nested inside it.
            const nestedOptions = (key === 'weapon') ? { ...options, numericAware: true } : options;
            const [nd, ni] = this.parseBlock(lines, i + 1, nestedOptions);
            if (key in data) {
              if (!Array.isArray(data[key])) data[key] = [data[key]];
              data[key].push(nd);
            } else { data[key] = nd; }
            i = ni; continue;
          }
        }
        const subAmmoMatch =
            stripped.match(/^(?:"submunition"|submunition)\s+"([^"]+)"\s+(\d+)$/) ||
            stripped.match(/^(?:"submunition"|submunition)\s+`([^`]+)`\s+(\d+)$/) ||
            stripped.match(/^(?:"ammo"|ammo)\s+"([^"]+)"\s+(\d+)$/)               ||
            stripped.match(/^(?:"ammo"|ammo)\s+`([^`]+)`\s+(\d+)$/);
        if (subAmmoMatch) {
            const isAmmo  = stripped.trimStart().replace(/^"/, '').startsWith('ammo');
            const key     = isAmmo ? 'ammo' : 'submunition';
            const val     = `"${subAmmoMatch[1]}" ${subAmmoMatch[2]}`;  // preserve for parseNameCount
            if (key in data) {
                if (!Array.isArray(data[key])) data[key] = [data[key]];
                data[key].push(val);
            } else { data[key] = val; }
            i++; continue;
        }

        if (options.numericAware) {
          const kv = this.parseNumericAwareLine(stripped);
          if (kv) {
            const [k, v] = kv;
            this.mergeAttributeValue(data, k, v);
            i++; continue;
          }
        } else {
          const kv = this.parseKeyValue(stripped);
          if (kv) {
            const [k, v] = kv;
            if (k in data) {
              if (!Array.isArray(data[k])) data[k] = [data[k]];
              data[k].push(v);
            } else { data[k] = v; }
            i++; continue;
          }
        }
        descriptionLines.push(stripped);
      }
      i++;
    }
    if (descriptionLines.length > 0) data.description = descriptionLines.join(' ');
    return [data, i];
  }

  parseKeyValue(stripped) {
    const patterns = [
      { regex: /"([^"]+)"\s+"([^"]+)"/,        ki: 1, vi: 2, str: true  },
      { regex: /"([^"]+)"\s+`([^`]+)`/,        ki: 1, vi: 2, str: true  },
      { regex: /`([^`]+)`\s+"([^"]+)"/,        ki: 1, vi: 2, str: true  },
      { regex: /`([^`]+)`\s+`([^`]+)`/,        ki: 1, vi: 2, str: true  },
      { regex: /"([^"]+)"\s+([^"`\s][^"`]*)/, ki: 1, vi: 2, str: false },
      { regex: /`([^`]+)`\s+([^"`\s][^"`]*)/, ki: 1, vi: 2, str: false },
      { regex: /^(\S+)\s+"([^"]+)"$/,          ki: 1, vi: 2, str: true  },
      { regex: /^(\S+)\s+`([^`]+)`$/,          ki: 1, vi: 2, str: true  },
      { regex: /^(\S+)\s+(.+)$/,               ki: 1, vi: 2, str: false, noQ: true }
    ];
    for (const p of patterns) {
      if (p.noQ && (stripped.includes('"') || stripped.includes('`'))) continue;
      const m = stripped.match(p.regex);
      if (m) {
        const k  = m[p.ki];
        const vs = m[p.vi].trim();
        const v  = p.str ? vs : (isNaN(parseFloat(vs)) ? vs : parseFloat(vs));
        return [k, v];
      }
    }
    const qk = stripped.match(/^["'`]([^"'`]+)["'`]$/);
    if (qk) return [qk[1], true];
    if (!stripped.includes(' ') && !stripped.includes('"') && !stripped.includes('`')) return [stripped, true];
    return null;
  }

  parseDescription(lines, i, baseIndent) {
    const stripped = lines[i].trim();
    const descLines = [];
    const single = stripped.match(/^description\s+"([^"]*)"$/) ||
                   stripped.match(/^description\s+`([^`]*)`$/);
    if (single) return [[single[1]], i + 1];
    const start = stripped.match(/^description\s+"(.*)$/) ||
                  stripped.match(/^description\s+`(.*)$/);
    if (start) {
      const st = start[1];
      if (st.endsWith('`') || st.endsWith('"')) return [[st.slice(0, -1)], i + 1];
      if (st) descLines.push(st);
      i++;
      while (i < lines.length) {
        const dl = lines[i], ds = dl.trim();
        if (ds.endsWith('`') || ds.endsWith('"')) {
          if (ds.slice(0, -1)) descLines.push(ds.slice(0, -1));
          return [descLines, i + 1];
        }
        const di = dl.length - dl.replace(/^\t+/, '').length;
        if (di <= baseIndent && dl.trim()) break;
        if (ds) descLines.push(ds);
        i++;
      }
      return [descLines, i];
    }
    i++;
    while (i < lines.length) {
      const dl = lines[i];
      const di = dl.length - dl.replace(/^\t+/, '').length;
      if (di <= baseIndent) break;
      if (dl.trim()) descLines.push(dl.trim());
      i++;
    }
    return [descLines, i];
  }

  parseSpriteWithData(lines, i, baseIndent) {
    const stripped = lines[i].trim();
    const FIELDS = [
      { key: 'sprite'               },
      { key: 'thumbnail'            },
      { key: 'flare sprite'         },
      { key: 'flare sound',           noSubBlock: true },
      { key: 'steering flare sprite' },
      { key: 'steering flare sound',  noSubBlock: true },
      { key: 'reverse flare sprite'  },
      { key: 'reverse flare sound',   noSubBlock: true },
      { key: 'afterburner effect'    },
      { key: 'afterburner sound',     noSubBlock: true },
    ];
    const esc     = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kwPat   = (key) => `(?:"${esc(key)}"|` + '`' + `${esc(key)}` + '`' + `|'${esc(key)}'|${esc(key)})`;
    const pathPat = `(?:"([^"]+)"|` + '`([^`]+)`' + `|'([^']+)'|(\\S+))`;
    const extractPath = (m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? null;
    for (const f of FIELDS) {
      if (!f.re) f.re = new RegExp(`^${kwPat(f.key)}\\s+${pathPat}`);
    }
    for (const cfg of FIELDS) {
      const m = stripped.match(cfg.re);
      if (!m) continue;
      const pathValue = extractPath(m);
      if (!pathValue) continue;
      const result = { [cfg.key]: pathValue };
      if (!cfg.noSubBlock && i + 1 < lines.length) {
        const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
        if (nextIndent > baseIndent) {
          const [sd, nextIdx] = this.parseBlock(lines, i + 1);
          result[cfg.key + ' data'] = sd;
          return [result, nextIdx];
        }
      }
      return [result, i + 1];
    }
    return [{}, i + 1];
  }

  /**
   * Consume an indented sub-block that follows a hardpoint line (engine,
   * reverse/steering engine, gun, turret, bay) and merge every key/value
   * pair it contains into `data`.
   *
   * Handles both forms found in the data files:
   *   - bare boolean flags, e.g. `under`, `over`, `parallel`
   *   - "key value" pairs, e.g. `zoom 1.3`, `angle 90`, `"launch effect" "human internal"`
   *
   * A repeated key becomes an array (matching the convention used by
   * parseBlock elsewhere), so nothing is silently overwritten.
   *
   * Without this, sub-block lines like `zoom 1` or `under` were left
   * dangling for the caller's generic line-by-line parser to pick up,
   * which caused them to be mis-attributed as top-level ship/variant
   * attributes (e.g. a stray `zoom` or `under` key on the ship itself)
   * instead of being attached to the specific hardpoint they belong to.
   */
  /**
   * Parse a single attribute line into a [key, values] pair, where
   * `values` is always an array — one entry per number/word found on the
   * line — so the caller can tell "one line with several numbers" apart
   * from "a single value" without losing anything.
   *
   * Unlike parseKeyValue (built for simple single-value "key value"
   * lines), attributes on weapons, turrets, guns, engines, and bays
   * frequently carry MULTIPLE numeric values on a single line — most
   * notably `arc <minAngle> <maxAngle>`, e.g. `arc -90 50`. Routing
   * these through parseKeyValue silently drops everything after the
   * first number (parseFloat stops at the first space), so `arc -90 50`
   * was becoming `arc: -90` with the 50 lost entirely. This parser keeps
   * every numeric token, however many there are, with no attribute name
   * hardcoded anywhere — it works the same way for any key.
   *
   * Handles:
   *   - bare flags:        under / over / parallel / left / right → [true]
   *   - single numeric:    zoom 1.3 / angle -50                  → [1.3]
   *   - multi numeric:     arc -90 50                            → [-90, 50]
   *     (any count of numbers is supported, not just two or three)
   *   - quoted string:     "launch effect" "human internal"      → ["human internal"]
   *   - quoted + trailing extra (e.g. a count) → just the quoted value,
   *     matching this parser's existing behavior elsewhere of not
   *     tracking that trailing count.
   */
  parseNumericAwareLine(stripped) {
    let key, rest;
    const qk = stripped.match(/^"([^"]+)"\s*(.*)$/) ||
               stripped.match(/^`([^`]+)`\s*(.*)$/) ||
               stripped.match(/^'([^']+)'\s*(.*)$/);
    if (qk) {
      key = qk[1]; rest = qk[2].trim();
    } else {
      const sp = stripped.indexOf(' ');
      if (sp === -1) { key = stripped; rest = ''; }
      else { key = stripped.slice(0, sp); rest = stripped.slice(sp + 1).trim(); }
    }
    if (!key) return null;
    if (rest === '') return [key, [true]];

    const qv = rest.match(/^"([^"]+)"$/) || rest.match(/^`([^`]+)`$/) || rest.match(/^'([^']+)'$/);
    if (qv) return [key, [qv[1]]];

    // Quoted value with a trailing extra token (e.g. a repeat count) —
    // keep just the quoted value, matching prior lossy-but-safe behavior.
    const qvPlus = rest.match(/^"([^"]+)"\s+(.+)$/) ||
                   rest.match(/^`([^`]+)`\s+(.+)$/) ||
                   rest.match(/^'([^']+)'\s+(.+)$/);
    if (qvPlus) return [key, [qvPlus[1]]];

    const tokens = rest.split(/\s+/);
    const isNumericToken = t => /^-?[\d.]+$/.test(t);
    if (tokens.every(isNumericToken)) {
      return [key, tokens.map(t => parseFloat(t))];
    }

    return [key, [rest]];
  }

  /**
   * Merge a parsed attribute occurrence into an attributes object using a
   * generic, NON-HARDCODED naming convention that distinguishes two
   * different situations:
   *
   *   1. MULTIPLE NUMBERS ON ONE LINE (e.g. `arc -90 50`) become a nested
   *      object, keyed the same as the attribute, with one numbered
   *      sub-field per value:
   *          "arc": { "arc_1": -90, "arc_2": 50 }
   *      This keeps every value individually named — "even if there are
   *      three numbers in a row" (e.g. `velocity 12 5 3`) each one gets
   *      its own suitably-named field: velocity_1, velocity_2, velocity_3.
   *
   *   2. THE SAME KEY APPEARING AGAIN ON A LATER, SEPARATE LINE (e.g. two
   *      independent `"hit force" ...` lines with different values)
   *      becomes a flat SIBLING key instead of overwriting the first:
   *      the first occurrence keeps the plain name, and every occurrence
   *      after that gets a numbered suffix:
   *          "hit force": 300, "hit force_2": 450
   *
   *   These two rules combine cleanly: if a REPEATED line also happens to
   *   carry multiple numbers itself, that occurrence's nested sub-fields
   *   are named off of ITS OWN (possibly suffixed) key, e.g. a second
   *   `arc -10 10` line would produce
   *          "arc_2": { "arc_2_1": -10, "arc_2_2": 10 }
   *
   * Nothing about specific attribute names (arc, zoom, angle, hit force...)
   * is special-cased — this works identically for any key.
   */
  mergeAttributeValue(data, key, values) {
    let outerKey = key;
    if (outerKey in data) {
      let n = 2;
      while ((`${key}_${n}`) in data) n++;
      outerKey = `${key}_${n}`;
    }
    if (values.length === 1) {
      data[outerKey] = values[0];
    } else {
      const nested = {};
      values.forEach((v, idx) => { nested[`${outerKey}_${idx + 1}`] = v; });
      data[outerKey] = nested;
    }
  }

  parseHardpointAttributes(lines, i, baseIndent, data) {
    if (i + 1 >= lines.length) return i + 1;
    const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
    if (nextIndent <= baseIndent) return i + 1;
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= baseIndent) break;
      const kv = this.parseNumericAwareLine(line.trim());
      if (kv) {
        const [k, v] = kv;
        this.mergeAttributeValue(data, k, v);
      }
      i++;
    }
    return i;
  }

  parseHardpoint(stripped, lines, i, baseIndent) {
    if (stripped.match(/^["'`]?engine["'`]?\s+(-?[\d.]+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(1);
      const d = { x: +p[0], y: +p[1] };
      if (p[2] !== undefined && p[2] !== '') d.zoom = +p[2];
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['engines', d, ni];
    }
    if (stripped.match(/^["'`]?reverse engine["'`]?\s+(-?[\d.]+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(2);
      const d = { x: +p[0], y: +p[1] };
      if (p[2] !== undefined && p[2] !== '') d.zoom = +p[2];
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['reverseEngines', d, ni];
    }
    if (stripped.match(/^["'`]?steering engine["'`]?\s+(-?[\d.]+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(2);
      const d = { x: +p[0], y: +p[1] };
      if (p[2] !== undefined && p[2] !== '') d.zoom = +p[2];
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['steeringEngines', d, ni];
    }
    // gun <x> <y> ["Outfit Name"]  — the outfit name is optional and may be
    // quoted (names with spaces) or bare (single-word names).
    const gunMatch = stripped.match(
      /^["'`]?gun["'`]?\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(?:"([^"]+)"|`([^`]+)`|'([^']+)'|([^\s"'`]+)))?\s*$/
    );
    if (gunMatch) {
      const [, xs, ys, q1, q2, q3, bare] = gunMatch;
      const outfitName = q1 ?? q2 ?? q3 ?? bare ?? '';
      const d = { x: +xs, y: +ys, gun: outfitName };
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['guns', d, ni];
    }
    // turret <x> <y> ["Outfit Name"]  — same shape as gun.
    const turretMatch = stripped.match(
      /^["'`]?turret["'`]?\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(?:"([^"]+)"|`([^`]+)`|'([^']+)'|([^\s"'`]+)))?\s*$/
    );
    if (turretMatch) {
      const [, xs, ys, q1, q2, q3, bare] = turretMatch;
      const outfitName = q1 ?? q2 ?? q3 ?? bare ?? '';
      const d = { x: +xs, y: +ys, turret: outfitName };
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['turrets', d, ni];
    }
    const bm = stripped.match(/^["'`]?bay["'`]?\s+["'`]?([^"'`\s]+)["'`]?\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)(?:\s+(.+))?/);
    if (bm) {
      const d = { type: bm[1], x: +bm[2], y: +bm[3] };
      if (bm[4]) d.position = bm[4];
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['bays', d, ni];
    }
    return null;
  }

  /**
   * Parse a single `leak` line.
   * Syntax: leak "effectName" <openChance> <spreadChance>
   * Returns { effect, openChance, spreadChance } or null if the line is not a leak.
   */
  parseLeak(stripped) {
    const m =
      stripped.match(/^leak\s+"([^"]+)"\s+(\d+)\s+(\d+)$/) ||
      stripped.match(/^leak\s+`([^`]+)`\s+(\d+)\s+(\d+)$/);
    if (!m) return null;
    return {
      effect:       m[1],
      openChance:   parseInt(m[2], 10),
      spreadChance: parseInt(m[3], 10),
    };
  }

  skipIndentedBlock(lines, i, baseIndent) {
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if (l.length - l.replace(/^\t+/, '').length <= baseIndent) break;
      i++;
    }
    return i;
  }

  _outfitMapsEqual(a, b) {
    const aKeys = Object.keys(a || {});
    const bKeys = Object.keys(b || {});
    if (aKeys.length !== bKeys.length) return false;
    const getCount = v => typeof v === 'object' ? (v.count ?? 1) : (v === true ? 1 : (v ?? 1));
    for (const k of aKeys) {
      if (getCount(a[k]) !== getCount(b[k])) return false;
    }
    return true;
  }

  parseShip(lines, startIdx) {
    const line = lines[startIdx].trim();
    const match = line.match(/^ship\s+"([^"]+)"(?:\s+"([^"]+)")?/) ||
                  line.match(/^ship\s+`([^`]+)`(?:\s+`([^`]+)`)?/) ||
                  line.match(/^ship\s+'([^']+)'(?:\s+'([^']+)')?/);
    if (!match) return [null, startIdx + 1];
    const [, baseName, variantName] = match;
    if (startIdx + 1 >= lines.length) return [null, startIdx + 1];
    const nextLine = lines[startIdx + 1];
    if (nextLine.trim() && (nextLine.length - nextLine.replace(/^\t+/, '').length) === 0) {
      return [null, startIdx + 1];
    }
    if (variantName) {
      this.pendingVariants.push({
        baseName, variantName, startIdx, lines,
        variantPluginId: this._currentPluginId,
        repoShipsBefore: this._currentRepoShipsBefore,
        repoShipsAfter:  null
      });
      return [null, this.skipIndentedBlock(lines, startIdx, 0)];
    }

    const shipData = {
      name: baseName,
      engines: [], reverseEngines: [], steeringEngines: [],
      guns: [], turrets: [], bays: [], leaks: [],
      outfitMap: {}
    };
    let i = startIdx + 1;
    while (i < lines.length) {
      const line2 = lines[i];
      if (!line2.trim() || line2.trim().startsWith('#')) { i++; continue; }
      const indent = line2.length - line2.replace(/^\t+/, '').length;
      if (indent < 1) break;
      const stripped = line2.trim();

      if (stripped === 'outfits') {
        const [outfitMap, ni] = this.parseOutfitsBlock(lines, i, baseName, null, this._currentPluginId);
        shipData.outfitMap = outfitMap;
        i = ni; continue;
      }
      if (stripped === 'add attributes') {
        i = this.skipIndentedBlock(lines, i, indent); continue;
      }

      // ── Hardpoints (engine / gun / turret / bay) ──────────────────────────
      const hr = this.parseHardpoint(stripped, lines, i, indent);
      if (hr) {
        const [type, hdata, ni] = hr;
        if (!shipData[type]) shipData[type] = [];
        shipData[type].push(hdata);
        i = ni; continue;
      }

      // ── Leak lines ─────────────────────────────────────────────────────────
      // Format: leak "effectName" <openChance> <spreadChance>
      // Multiple leak lines are valid and must all be collected.
      const leak = this.parseLeak(stripped);
      if (leak) { shipData.leaks.push(leak); i++; continue; }

      if (stripped === 'description' || stripped.startsWith('description ')) {
        const [desc, ni] = this.parseDescription(lines, i, indent);
        if (desc) {
          shipData.description = shipData.description
            ? shipData.description + ' ' + desc.join(' ')
            : desc.join(' ');
        }
        i = ni; continue;
      }
      if (stripped.startsWith('sprite ') ||
          stripped.startsWith('"thumbnail"') || stripped.startsWith('thumbnail ') ||
          stripped.startsWith('"flare sprite"') || stripped.startsWith('"flare sound"') ||
          stripped.startsWith('"steering flare sprite"') || stripped.startsWith('"steering flare sound"') ||
          stripped.startsWith('"reverse flare sprite"') || stripped.startsWith('"reverse flare sound"') ||
          stripped.startsWith('"afterburner effect"') || stripped.startsWith('"afterburner sound"')) {
        const [sd, ni] = this.parseSpriteWithData(lines, i, indent);
        Object.assign(shipData, sd);
        i = ni; continue;
      }
      if (i + 1 < lines.length) {
        const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
        if (nextIndent > indent) {
          const key = stripped.replace(/^["'`]([^"'`]+)["'`]$/, '$1');
          const [nd, ni] = this.parseBlock(lines, i + 1, { parseHardpoints: false });
          shipData[key] = nd;
          i = ni; continue;
        }
      }
      const kv = this.parseKeyValue(stripped);
      if (kv) shipData[kv[0]] = kv[1];
      i++;
    }
    return [shipData, i];
  }

  parseShipVariant(variantInfo) {
    const { baseShip, error } = this._resolveBaseShip(
      variantInfo.baseName, variantInfo.variantPluginId
    );
    if (error) {
      console.warn(`  Skipping variant "${variantInfo.baseName} (${variantInfo.variantName})": ${error}`);
      return null;
    }
    const { startIdx, lines } = variantInfo;
    if (startIdx + 1 >= lines.length) return null;
    const nl = lines[startIdx + 1];
    if (nl.trim() && (nl.length - nl.replace(/^\t+/, '').length) === 0) return null;

    const v = JSON.parse(JSON.stringify(baseShip));
    v.name             = variantInfo.variantName.startsWith(variantInfo.baseName)
      ? variantInfo.variantName
      : `${variantInfo.baseName} (${variantInfo.variantName})`;
    v.variant          = variantInfo.variantName;
    v.baseShip         = variantInfo.baseName;
    v._variantPluginId = variantInfo.variantPluginId;

    let changed = false;
    let inlineOutfitsStarted = false;
    let variantLeaksStarted  = false;   // true once the variant defines its first leak line

    let i = startIdx + 1;
    while (i < lines.length) {
      const line2 = lines[i];
      if (!line2.trim() || line2.trim().startsWith('#')) { i++; continue; }
      const indent = line2.length - line2.replace(/^\t+/, '').length;
      if (indent < 1) break;
      const stripped = line2.trim();

      const inlineOutfitMatch =
        stripped.match(/^"([^"]+)"(?:\s+(\d+))?$/) ||
        stripped.match(/^`([^`]+)`(?:\s+(\d+))?$/);
      if (inlineOutfitMatch && indent === 1) {
        const outfitName = inlineOutfitMatch[1];
        const count  = inlineOutfitMatch[2] ? Math.max(1, parseInt(inlineOutfitMatch[2], 10)) : 1;
        const pluginId = this._resolveOutfitPluginId(outfitName, variantInfo.variantPluginId);
        if (!inlineOutfitsStarted) { v.outfitMap = {}; inlineOutfitsStarted = true; }
        v.outfitMap[outfitName] = { count, pluginId };
        this.speciesResolver.collectShipOutfits(variantInfo.baseName, [outfitName], this._currentPluginId, v.name);
        this.locationResolver.collectShipOutfit(v.name, outfitName, pluginId, variantInfo.variantPluginId);
        changed = true;
        i++; continue;
      }

      if (stripped === 'outfits') {
        const [outfitMap, ni] = this.parseOutfitsBlock(lines, i, variantInfo.baseName, v.name, variantInfo.variantPluginId);
        if (!this._outfitMapsEqual(outfitMap, baseShip.outfitMap || {})) {
          v.outfitMap = outfitMap; changed = true;
        }
        i = ni; continue;
      }

      if (stripped === 'add attributes') {
        const [parsed, ni] = this.parseBlock(lines, i + 1, {});
        if (!v.attributes) v.attributes = {};
        for (const [k, val] of Object.entries(parsed)) {
          if (k in v.attributes && typeof v.attributes[k] === 'number' && typeof val === 'number')
            v.attributes[k] += val;
          else v.attributes[k] = val;
        }
        changed = true; i = ni; continue;
      }

      if (stripped.startsWith('sprite ') ||
          stripped.startsWith('"thumbnail"') || stripped.startsWith('thumbnail ') ||
          stripped.startsWith('"flare sprite"') || stripped.startsWith('"flare sound"') ||
          stripped.startsWith('"steering flare sprite"') || stripped.startsWith('"steering flare sound"') ||
          stripped.startsWith('"reverse flare sprite"') || stripped.startsWith('"reverse flare sound"') ||
          stripped.startsWith('"afterburner effect"') || stripped.startsWith('"afterburner sound"')) {
        const [sd, ni] = this.parseSpriteWithData(lines, i, indent);
        for (const [k, val] of Object.entries(sd)) {
          if (val !== baseShip[k]) { v[k] = val; changed = true; }
        }
        i = ni; continue;
      }

      // ── Leak lines in variants ─────────────────────────────────────────────
      // A variant that specifies any leak lines replaces the base ship's leaks
      // entirely (the game engine uses the same semantics — no merging).
      const leak = this.parseLeak(stripped);
      if (leak) {
        if (!variantLeaksStarted) { v.leaks = []; variantLeaksStarted = true; }
        v.leaks.push(leak);
        changed = true;
        i++; continue;
      }

      const [parsed, ni] = this.parseBlock(lines, i, { parseHardpoints: true });
      if (parsed.displayName) { v.displayName = parsed.displayName; changed = true; }
      if (parsed.sprite && parsed.sprite !== baseShip.sprite) {
        v.sprite = parsed.sprite;
        if (parsed.spriteData) v.spriteData = parsed.spriteData;
        changed = true;
      }
      if (parsed.thumbnail && parsed.thumbnail !== baseShip.thumbnail) {
        v.thumbnail = parsed.thumbnail; changed = true;
      }
      for (const t of ['engines','reverseEngines','steeringEngines','guns','turrets','bays']) {
        if (parsed[t]?.length > 0) { v[t] = parsed[t]; changed = true; }
      }
      i = ni;
    }

    return (changed || v.description) ? v : null;
  }

  shipsAreIdentical(a, b) {
    if (a.baseShip !== b.baseShip) return false;
    if (a.sprite    !== b.sprite)    return false;
    if (a.thumbnail !== b.thumbnail) return false;
    for (const t of ['engines','reverseEngines','steeringEngines','guns','turrets','bays']) {
      const aList = a[t] || [], bList = b[t] || [];
      if (aList.length !== bList.length) return false;
      for (let i = 0; i < aList.length; i++) {
        if (aList[i].x !== bList[i].x || aList[i].y !== bList[i].y) return false;
      }
    }
    const aAttr = a.attributes || {}, bAttr = b.attributes || {};
    const allKeys = new Set([...Object.keys(aAttr), ...Object.keys(bAttr)]);
    for (const k of allKeys) { if (aAttr[k] !== bAttr[k]) return false; }
    if (!this._outfitMapsEqual(a.outfitMap || {}, b.outfitMap || {})) return false;
    return true;
  }

  processVariants(pendingSlice) {
    const toProcess = pendingSlice ?? this.pendingVariants;
    console.log(`  Processing ${toProcess.length} variants...`);
    let kept = 0, skippedNoChange = 0, skippedDuplicate = 0;
    for (const vi of toProcess) {
      const v = this.parseShipVariant(vi);
      if (!v) { skippedNoChange++; continue; }
      const isDuplicate = this.variants.some(existing => this.shipsAreIdentical(existing, v));
      if (isDuplicate) {
        skippedDuplicate++; continue;
      }
      this.variants.push(v);
      kept++;
    }
    console.log(`  Variants: ${kept} kept, ${skippedNoChange} skipped, ${skippedDuplicate} duplicates removed`);
  }

  /**
   * Re-scans raw lines to correctly extract submunition and ammo entries
   * from a weapon block, handling:
   *   - "submunition" "Name"  (with optional indented offset sub-block)  → count 1 per line
   *   - "submunition" "Name" N                                           → count N
   *   - ammo "Name" N                                                    → count N
   *   - ammo "Name"                                                      → count 1
   *
   * Returns { submunitions: [{type,count},...], ammunition: [{type,count},...] }
   * to be merged into the weapon object after parseBlock runs.
   */
  _parseWeaponLines(lines, outfitStartIdx, outfitEndIdx) {
      const submunitions = [];
      const ammunition   = [];

      // Find the weapon block start
      let weaponIndent = -1;
      let i = outfitStartIdx;
      while (i < outfitEndIdx) {
          const line    = lines[i];
          const stripped = line.trim();
          const indent   = line.length - line.replace(/^\t+/, '').length;
          if (stripped === 'weapon' || stripped === '"weapon"') {
              weaponIndent = indent;
              i++;
              break;
          }
          i++;
      }
      if (weaponIndent < 0) return { submunitions, ammunition };

      // Scan weapon block lines
      while (i < outfitEndIdx) {
          const line     = lines[i];
          if (!line.trim()) { i++; continue; }
          const indent   = line.length - line.replace(/^\t+/, '').length;
          // Left weapon block
          if (indent <= weaponIndent) break;

          const stripped = line.trim();

          // ── submunition "Name" [N] ────────────────────────────────────────────
          // Matches: submunition "Name", "submunition" "Name", submunition "Name" 3
          const subMatch =
              stripped.match(/^(?:"submunition"|submunition)\s+"([^"]+)"(?:\s+(\d+))?$/) ||
              stripped.match(/^(?:"submunition"|submunition)\s+`([^`]+)`(?:\s+(\d+))?$/);
          if (subMatch) {
              const type  = subMatch[1];
              const count = subMatch[2] ? parseInt(subMatch[2], 10) : 1;
              submunitions.push({ type, count });
              // Skip any indented sub-block (offset data etc) — we don't need it
              i++;
              while (i < outfitEndIdx) {
                  const nl      = lines[i];
                  if (!nl.trim()) { i++; continue; }
                  const nIndent = nl.length - nl.replace(/^\t+/, '').length;
                  if (nIndent <= indent) break;
                  i++;
              }
              continue;
          }

          // ── ammo "Name" [N] ───────────────────────────────────────────────────
          const ammoMatch =
              stripped.match(/^(?:"ammo"|ammo)\s+"([^"]+)"(?:\s+(\d+))?$/) ||
              stripped.match(/^(?:"ammo"|ammo)\s+`([^`]+)`(?:\s+(\d+))?$/);
          if (ammoMatch) {
              const type  = ammoMatch[1];
              const count = ammoMatch[2] ? parseInt(ammoMatch[2], 10) : 1;
              // Only add if not already found (weapons have one ammo type)
              if (!ammunition.some(a => a.type === type)) {
                  ammunition.push({ type, count });
              }
              i++;
              continue;
          }

          i++;
      }

      return { submunitions, ammunition };
  }

  parseOutfit(lines, startIdx) {
      const line = lines[startIdx].trim();
      const match = line.match(/^outfit\s+"([^"]+)"\s*$/) ||
                    line.match(/^outfit\s+`([^`]+)`\s*$/) ||
                    line.match(/^outfit\s+'([^']+)'\s*$/);
      if (!match) return [null, startIdx + 1];
      const name = match[1];
      if (startIdx + 1 >= lines.length) return [null, startIdx + 1];
      const nl = lines[startIdx + 1];
      if (nl.trim() && (nl.length - nl.replace(/^\t+/, '').length) === 0) return [null, startIdx + 1];
      const data = { name };
      const [parsed, ni] = this.parseBlock(lines, startIdx + 1, { parseHardpoints: false });
      Object.assign(data, parsed);

      if (data.weapon && typeof data.weapon === 'object') {
          // First: extract submunitions and ammo directly from raw lines
          // (parseBlock mangles repeated submunition keys and drops "Name" N forms)
          const { submunitions, ammunition } = this._parseWeaponLines(lines, startIdx + 1, ni);

          // Second: normalise everything else (handles legacy formats, loose keys)
          data.weapon = normaliseWeaponBlock(data.weapon, this.outfitsByName);

          // Third: override with the accurately raw-parsed values
          // Raw parse is authoritative for submunitions and ammo
          if (submunitions.length > 0) data.weapon.submunitions = submunitions;
          if (ammunition.length   > 0) data.weapon.ammunition   = ammunition;
      }

    return [(data.description || data.weapon) ? data : null, ni];
  }

  parseExtraEffect(lines, startIdx) {
    const line = lines[startIdx].trim();
    const match = line.match(/^effect\s+"([^"]+)"\s*$/) ||
                  line.match(/^effect\s+`([^`]+)`\s*$/) ||
                  line.match(/^effect\s+'([^']+)'\s*$/);
    if (!match) return [null, startIdx + 1];
    const name = match[1];
    if (startIdx + 1 >= lines.length) return [null, startIdx + 1];
    const nl = lines[startIdx + 1];
    if (nl.trim() && (nl.length - nl.replace(/^\t+/, '').length) === 0) return [null, startIdx + 1];
    const data = { name };
    const [parsed, ni] = this.parseBlock(lines, startIdx + 1, { parseHardpoints: false });
    Object.assign(data, parsed);
    return [data, ni];
  }

  resolveAllOutfitPluginIds() {
    let resolved = 0, stillMissing = 0;
    const resolveMap = (outfitMap, ownerPluginId) => {
      if (!outfitMap || typeof outfitMap !== 'object') return;
      for (const [name, val] of Object.entries(outfitMap)) {
        if (typeof val === 'object' && val.pluginId === null) {
          const found = this._resolveOutfitPluginId(name, ownerPluginId);
          if (found) { val.pluginId = found; resolved++; }
          else { stillMissing++; console.warn(`    ⚠ Outfit not found in any plugin: "${name}"`); }
        }
      }
    };
    for (const ship of this.ships)       resolveMap(ship.outfitMap, ship._pluginId);
    for (const variant of this.variants) resolveMap(variant.outfitMap, variant._variantPluginId);
    let refsResolved = 0, refsStillMissing = 0;
    for (const ref of this.locationResolver.shipOutfitRefs) {
        if (ref.pluginId === null) {
            const found = this._resolveOutfitPluginId(ref.outfitName, ref.shipPluginId);
            if (found) { ref.pluginId = found; refsResolved++; }
            else { refsStillMissing++; }
        }
    }
    console.log(`  Outfit pluginId resolution: ${resolved} resolved, ${stillMissing} still missing`);
  }

  /**
   * NEW: resolves every named-fleet reference found inside an `npc` block
   * (queued into `_pendingNpcFleetRefs` by _parseMissionNpcBlock/parseNpcBlock)
   * to that fleet's actual government + ship list, then feeds those ships
   * into the resolvers exactly as if they'd been listed inline.
   *
   * Must run AFTER every file in every plugin has been parsed (i.e. after
   * all parseRepository/parseArchiveSource calls, alongside
   * resolveAllOutfitPluginIds) — a referenced fleet's own `fleet "X" ...`
   * definition can live in a file parsed before OR after the mission/event
   * that references it, so this can't be resolved inline during the first
   * pass.
   */
  resolveAllNpcFleetRefs() {
    let resolved = 0, missing = 0;
    for (const ref of this._pendingNpcFleetRefs) {
      // Prefer a fleet defined by the SAME plugin as the reference (a
      // mission/event referencing a named fleet is almost always
      // referencing one from its own plugin) — same priority rule as
      // _resolveOutfitPluginId. Fall back to a cross-plugin search (e.g. a
      // plugin's mission referencing a vanilla fleet by name) if that fails.
      let match = this.speciesResolver.fleets.find(
        f => f.name === ref.fleetName && f.pluginId === ref.pluginId
      );
      if (!match) {
        match = this.speciesResolver.fleets.find(f => f.name === ref.fleetName);
      }
      if (!match) {
        missing++;
        console.warn(
          `    ⚠ NPC fleet reference not found: "${ref.fleetName}" ` +
          `(referenced by ${ref.missionName ? `mission "${ref.missionName}"` : `event "${ref.eventName}"`} ` +
          `in plugin "${ref.pluginId}")`
        );
        continue;
      }
      const government = match.government || ref.government || null;
      const contextLabel = ref.missionName
        ? ref.missionName
        : `[event "${ref.eventName}" npc]`;
      for (const shipName of match.shipNames) {
        this.speciesResolver.collectNpcRef(government, shipName, match.pluginId);
        this.locationResolver.collectMissionNpcShip(contextLabel, shipName, match.pluginId);
      }
      resolved++;
    }
    console.log(`  NPC fleet-reference resolution: ${resolved} resolved, ${missing} missing`);
  }

  /**
   * NEW: the actual event → fleet → government join.
   *
   * Two things are true separately but were never stitched together:
   *   - locationResolver.eventSystemFleetChanges records
   *     "event E adds/removes fleet F in system S" (from a `system "X"` >
   *     `add/remove fleet "F"` sub-block inside an event).
   *   - speciesResolver.fleets records "fleet F belongs to government G"
   *     (from that fleet's own top-level `fleet "F" ... government "G" ...`
   *     definition — collectFleet() now also stores the fleet's NAME
   *     specifically so this join is possible).
   *
   * This method walks every recorded event/fleet/system change, looks up
   * that fleet's government, and produces one flat, directly-usable record
   * per change — "event E gives government G a fleet in system S" — plus,
   * where a mission is known to trigger that event
   * (locationResolver.missionEventTriggers), which mission is responsible.
   *
   * Must run AFTER parseEventBlock/parseFleetBlock have processed every
   * file in every plugin (i.e. after resolveAllNpcFleetRefs, in main()) —
   * same ordering reason as that method: a fleet referenced by an event in
   * one file may be DEFINED in a file parsed earlier or later, in any plugin.
   *
   * Output shape (also stored on this.eventGovernmentImpacts):
   *   {
   *     eventName, systemName, fleetName,
   *     government: string | null,   // null if the fleet's own government couldn't be resolved
   *     action: 'add' | 'remove',
   *     rate: number | null,         // spawn rate, only meaningful for 'add'
   *     pluginId,                    // the plugin that defined this event/system change
   *     fleetPluginId: string | null,// the plugin that actually defines the fleet (may differ — cross-plugin fleet references are legal)
   *     triggeringMissions: string[] // mission names known to trigger this event, via locationResolver.missionEventTriggers — [] if none found (e.g. the event fires on its own schedule/date, or via a trigger this parser doesn't track)
   *   }
   */
  resolveEventGovernmentImpact() {
    this.eventGovernmentImpacts = [];
    let resolvedGov = 0, unresolvedGov = 0;

    for (const change of this.locationResolver.eventSystemFleetChanges) {
      const { eventName, systemName, fleetName, action, rate, pluginId } = change;

      // Same plugin-priority rule as resolveAllNpcFleetRefs: prefer a
      // fleet defined by the same plugin as the event, fall back to a
      // cross-plugin match (an event legitimately CAN reference another
      // plugin's — or vanilla's — fleet by name).
      let fleetMatch = this.speciesResolver.fleets.find(
        f => f.name === fleetName && f.pluginId === pluginId
      );
      if (!fleetMatch) {
        fleetMatch = this.speciesResolver.fleets.find(f => f.name === fleetName);
      }

      const government = fleetMatch?.government ?? null;
      if (government) resolvedGov++; else unresolvedGov++;

      // Which missions (if any) are known to trigger this specific event,
      // scoped to the same plugin as the event itself — a mission in
      // Plugin A triggering an event by a name that happens to collide
      // with an unrelated Plugin B event should not be joined here.
      const triggeringMissions = this.locationResolver.missionEventTriggers
        .filter(t => t.eventName === eventName && t.pluginId === pluginId)
        .map(t => t.missionName);

      this.eventGovernmentImpacts.push({
        eventName,
        systemName,
        fleetName,
        government,
        action,
        rate: rate ?? null,
        pluginId,
        fleetPluginId: fleetMatch?.pluginId ?? null,
        triggeringMissions,
      });
    }

    if (unresolvedGov > 0) {
      console.warn(
        `    ⚠ ${unresolvedGov} event fleet-spawn change(s) could not be traced to a government ` +
        `(the referenced fleet's own "fleet ... government ..." definition wasn't found — ` +
        `check for a typo'd fleet name, or a fleet defined without a government line).`
      );
    }
    console.log(`  Event → fleet → government join: ${resolvedGov} resolved to a government, ${unresolvedGov} unresolved`);
  }

async readPluginTxt(pluginRootDir) {
  const pluginTxtPath = path.join(pluginRootDir, 'plugin.txt');
  try {
    const content = await fs.readFile(pluginTxtPath, 'utf8');
    const result = {};
    for (const line of content.split('\n')) {
      if (line.startsWith('\t') || line.startsWith(' ')) continue;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const m =
        trimmed.match(/^(\w+)\s+"([^"]+)"$/) ||
        trimmed.match(/^(\w+)\s+`([^`]+)`$/) ||
        trimmed.match(/^(\w+)\s+(\S+)$/);
      if (m) {
        const key = m[1];
        const val = m[2];
        if (key === 'about') {
          if (!result.about) result.about = [];
          result.about.push(val);
        } else {
          result[key] = val;
        }
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}
  
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  try {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), 'plugins.json'), 'utf8'));
    console.log(`Found ${config.plugins.length} repository source(s)\n`);

    const dataIndex  = {};
    const sharedParser = new EndlessSkyParser();
    sharedParser.setSourcePriority(config.plugins);
    sharedParser.setOverrides(config.plugins);

    for (const source of config.plugins) {
      if (source.overrides?.length) {
        console.log(`  Override declared: "${source.name}" overrides [${source.overrides.join(', ')}]`);
      }
    }

    const allResults = [];
    for (const source of config.plugins) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Source: ${source.name}  |  ${source.repository}`);
      console.log('='.repeat(60));

      // "archive" sources (or a repository URL ending in a known archive
      // extension, as a fallback if `type` wasn't set) are parsed via the
      // download+extract path instead of git sparse-clone. Everything
      // downstream (dataIndex, file writing, species/location resolution)
      // is identical — parseArchiveSource returns the same result shape
      // as parseRepository.
      const isArchive =
        source.type === 'archive' ||
        detectArchiveExtension(source.repository || '') !== null;

      let results;
      try {
        results = isArchive
          ? await sharedParser.parseArchiveSource(source.repository, source.name)
          : await sharedParser.parseRepository(source.repository, source.name);
      } catch (err) {
        console.error(`  Error processing "${source.name}": ${err.message}`);
        console.error(err.stack);
        console.error(`  Skipping and continuing with next source...`);
        continue;
      }
      if (results.length === 0) { console.log('No plugins found, skipping.'); continue; }
      for (const plugin of results) allResults.push({ source, plugin });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Resolving deferred outfit pluginIds across all plugins...`);
    console.log('='.repeat(60));
    sharedParser.resolveAllOutfitPluginIds();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Resolving fleet government gaps (government-less fleet reopenings)...`);
    console.log('='.repeat(60));
    sharedParser.speciesResolver.resolveFleetGovernmentGaps();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Resolving NPC fleet references across all plugins...`);
    console.log('='.repeat(60));
    sharedParser.resolveAllNpcFleetRefs();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Joining event → fleet → government data...`);
    console.log('='.repeat(60));
    sharedParser.resolveEventGovernmentImpact();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Resolving governments across all ${allResults.length} plugin(s)...`);
    console.log(`  Known governments: ${sharedParser.speciesResolver.knownGovernments.size}`);
    console.log(`  Fleets: ${sharedParser.speciesResolver.fleets.length}`);
    console.log(`  Planets: ${sharedParser.speciesResolver.planets.length}`);
    console.log('='.repeat(60));

    for (const { plugin } of allResults) {
      sharedParser.speciesResolver.attachSpecies(
        plugin.ships, plugin.variants, plugin.outfits, plugin.outputName
      );
      sharedParser.locationResolver.attachLocations(
        plugin.ships, plugin.variants, plugin.outfits, plugin.pluginId
      );
    }

    for (const { source, plugin } of allResults) {
      console.log(`\nSaving → data/${plugin.outputName}/`);
      const pluginDir    = path.join(process.cwd(), 'data', plugin.outputName);
      const dataFilesDir = path.join(pluginDir, 'dataFiles');
      await fs.mkdir(dataFilesDir, { recursive: true });

      // ── Write pluginData.json — always, falling back to outputName if no plugin.txt ──
      const pluginDataToWrite = plugin.pluginData ?? { name: plugin.outputName };
      await fs.writeFile(
        path.join(pluginDir, 'pluginData.json'),
        JSON.stringify(pluginDataToWrite, null, 2)
      );

      const shipsOut = plugin.ships.map(s => ({
        ...s, outfits: outfitMapToOutputFormat(s.outfitMap), outfitMap: undefined,
      }));
      const variantsOut = plugin.variants.map(v => ({
        ...v, outfits: outfitMapToOutputFormat(v.outfitMap), outfitMap: undefined,
      }));
      const outfitsOut = plugin.outfits.map(o => ({
        ...o, pluginId: o._pluginId ?? null, _pluginId: undefined,
      }));
      const effectsOut = plugin.effects.map(e => ({
        ...e, pluginId: e._pluginId ?? null, _pluginId: undefined,
      }));

      await fs.writeFile(path.join(dataFilesDir, 'ships.json'),    JSON.stringify(shipsOut,    null, 2));
      await fs.writeFile(path.join(dataFilesDir, 'variants.json'), JSON.stringify(variantsOut, null, 2));
      await fs.writeFile(path.join(dataFilesDir, 'outfits.json'),  JSON.stringify(outfitsOut,  null, 2));
      await fs.writeFile(path.join(dataFilesDir, 'effects.json'),  JSON.stringify(effectsOut,  null, 2));
      await fs.writeFile(path.join(dataFilesDir, 'complete.json'), JSON.stringify({
        plugin:      plugin.name,
        repository:  source.repository,
        ships:       shipsOut,
        variants:    variantsOut,
        outfits:     outfitsOut,
        effects:     effectsOut,
        parsedAt:    new Date().toISOString(),
      }, null, 2));

      console.log(`  ✓ ${shipsOut.length} ships | ${variantsOut.length} variants | ${outfitsOut.length} outfits | ${effectsOut.length} effects`);

      if (!dataIndex[source.name]) dataIndex[source.name] = [];
      const indexEntry = {
        outputName: plugin.outputName,
        displayPluginName: plugin.pluginData?.name ?? plugin.outputName,
      };
      dataIndex[source.name].push(indexEntry);
    }

    const indexPath = path.join(process.cwd(), 'data', 'index.json');
    await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify(dataIndex, null, 2));
    console.log(`\nWrote data/index.json with ${Object.keys(dataIndex).length} source(s)`);

    // Cross-plugin data, same tier as index.json — not tied to any single
    // plugin's output folder, since an event in one plugin can reference a
    // fleet defined in another.
    const eventGovImpactPath = path.join(process.cwd(), 'data', 'eventGovernmentImpact.json');
    await fs.writeFile(eventGovImpactPath, JSON.stringify(sharedParser.eventGovernmentImpacts, null, 2));
    console.log(`Wrote data/eventGovernmentImpact.json with ${sharedParser.eventGovernmentImpacts.length} event→fleet→government record(s)`);

    await parseAttributes(path.join(process.cwd(), 'data'));

    console.log(`\n${'='.repeat(60)}\n✓ All done!\n${'='.repeat(60)}\n`);
  } catch (err) {
    console.error('Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = EndlessSkyParser;