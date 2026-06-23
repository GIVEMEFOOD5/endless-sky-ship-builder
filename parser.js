// parser.js - Endless Sky data parser for GitHub Actions
// Parses ship, variant, outfit, and effect data from GitHub repositories.
// Uses sparse Git clones (data/ + images/ only) instead of the GitHub API,
// which avoids rate limits and the 100k-file tree truncation limit.

const https           = require('https');
const SpeciesResolver = require('./speciesResolver');
const LocationResolver = require('./locationResolver');
const { parseAttributes } = require('./attributeParser');
const crypto          = require('crypto');
const fs              = require('fs').promises;
const path            = require('path');
const { exec: execCallback } = require('child_process');
const { promisify }   = require('util');
const exec            = promisify(execCallback);

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

    const repoShipsBefore   = this.ships.length;
    const repoOutfitsBefore = this.outfits.length;
    const repoEffectsBefore = this.effects.length;
    const repoPendingBefore = this.pendingVariants.length;

    this._currentRepoShipsBefore = repoShipsBefore;

    const pluginMeta = [];

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

        const clonedPlugins = await this.detectPlugins(cloneDir, repo);
        const clonedPlugin  = clonedPlugins.find(p => p.name === probe.name) || clonedPlugins[0];

        if (!clonedPlugin) {
          console.warn(`  Could not locate plugin "${probe.name}" in clone, skipping.`);
          continue;
        }

        // ── Read plugin.txt if present ──
        const pluginRoot = root === '.' ? cloneDir : path.join(cloneDir, root);
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

        console.log(`  → +${this.ships.length - shipsBefore} ships, +${this.outfits.length - outfitsBefore} outfits, +${this.effects.length - effectsBefore} effects (${this.pendingVariants.length - repoPendingBefore} variants pending for this repo)`);

        pluginMeta.push({
          name:         clonedPlugin.name,
          pluginData,
          pluginId,
          imagesDir:    clonedPlugin.imagesDir,
          cloneDir,
          shipsBefore,
          shipsAfter:   this.ships.length,
          outfitsBefore,
          outfitsAfter: this.outfits.length,
          effectsBefore,
          effectsAfter: this.effects.length
        });

      } catch (err) {
        await fs.rm(cloneDir, { recursive: true, force: true });
        throw err;
      }
    }

    this._currentRepoShipsAfter = this.ships.length;
    this._currentPluginId = null;

    for (const pv of this.pendingVariants.slice(repoPendingBefore)) {
      pv.repoShipsAfter = this._currentRepoShipsAfter;
    }

    const repoPending = this.pendingVariants.slice(repoPendingBefore);
    console.log(`\n  Processing ${repoPending.length} variants from this repo against ${this.ships.length} total ships (across all repos)...`);
    this.processVariants(repoPending);
    console.log(`  → ${this.variants.length} total variants kept so far`);

    const results = [];

    for (const meta of pluginMeta) {
      try {
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
          repository: repoUrl,
          ships:      pluginShips,
          variants:   pluginVariants,
          outfits:    pluginOutfits,
          effects:    pluginEffects,
          owner, repo, branch
        });

      } finally {
        await fs.rm(meta.cloneDir, { recursive: true, force: true });
      }
    }

    return results;
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
        }
      }
      i++;
    }
  }

  parseFleetBlock(lines, i) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^fleet\s+"([^"]+)"/) ||
                      headerLine.match(/^fleet\s+`([^`]+)`/);
    const fleetName = nameMatch ? nameMatch[1] : null;
    let government = null;
    const shipNames = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      if (indent === 1) {
        const govMatch = stripped.match(/^government\s+"([^"]+)"/);
        if (govMatch) { government = govMatch[1]; i++; continue; }
      }
      if (indent === 2 || indent === 3) {
        const shipMatch = stripped.match(/^"([^"]+)"(?:\s+\d+)?$/) ||
                          stripped.match(/^`([^`]+)`(?:\s+\d+)?$/);
        if (shipMatch) shipNames.push(shipMatch[1]);
      }
      i++;
    }
    this.speciesResolver.collectFleet(government, shipNames, this._currentPluginId);
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
      if (missionName && (
        stripped.startsWith('give outfit "') || stripped.startsWith('give outfit `') ||
        stripped.startsWith('outfit "')      || stripped.startsWith('outfit `')
      )) {
        const om =
          stripped.match(/^give\s+outfit\s+"([^"]+)"(?:\s+(-?\d+))?/) ||
          stripped.match(/^give\s+outfit\s+`([^`]+)`(?:\s+(-?\d+))?/) ||
          stripped.match(/^outfit\s+"([^"]+)"(?:\s+(-?\d+))?/)        ||
          stripped.match(/^outfit\s+`([^`]+)`(?:\s+(-?\d+))?/);
        if (om) {
          const count = om[2] ? parseInt(om[2], 10) : 1;
          if (count > 0) {
            this.locationResolver.collectMissionGiveOutfit(missionName, om[1], count, this._currentPluginId);
          }
        }
      }
      if (missionName && (
        stripped.startsWith('give ship "') || stripped.startsWith('give ship `') ||
        stripped.startsWith('ship "')      || stripped.startsWith('ship `')
      )) {
        const sm =
          stripped.match(/^give\s+ship\s+"([^"]+)"(?:\s+"[^"]*")?/) ||
          stripped.match(/^give\s+ship\s+`([^`]+)`(?:\s+`[^`]*`)?/) ||
          stripped.match(/^ship\s+"([^"]+)"(?:\s+"[^"]*")?/)        ||
          stripped.match(/^ship\s+`([^`]+)`(?:\s+`[^`]*`)?/);
        if (sm) {
          this.locationResolver.collectMissionGiveShip(missionName, sm[1], this._currentPluginId);
        }
      }
      i++;
    }
    return i;
  }

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
          const fleetIndent = indent;
          i++;
          while (i < lines.length) {
            const fl = lines[i];
            const fi = fl.length - fl.replace(/^\t+/, '').length;
            if (fi <= fleetIndent && fl.trim()) break;
            const fs2 = fl.trim();
            if (fi > fleetIndent + 1) {
              const fm = fs2.match(/^"([^"]+)"(?:\s+\d+)?$/) || fs2.match(/^`([^`]+)`(?:\s+\d+)?$/);
              if (fm) shipNames.push(fm[1]);
            }
            i++;
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

  parseNpcBlock(lines, i) {
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
          const fleetIndent = indent;
          i++;
          while (i < lines.length) {
            const fl = lines[i];
            const fi = fl.length - fl.replace(/^\t+/, '').length;
            if (fi <= fleetIndent && fl.trim()) break;
            const fs2 = fl.trim();
            if (fi > fleetIndent + 1) {
              const fm = fs2.match(/^"([^"]+)"(?:\s+\d+)?$/) || fs2.match(/^`([^`]+)`(?:\s+\d+)?$/);
              if (fm) shipNames.push(fm[1]);
            }
            i++;
          }
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

  parseOutfitsBlock(lines, i, speciesShipName = null, variantShipName = null) {
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
          const pluginId = this._resolveOutfitPluginId(name, this._currentPluginId);
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
        this.locationResolver.collectShipOutfit(locName, outfitName, this._currentPluginId);
      }
    }
    return [outfitMap, i];
  }

  parseShipyardBlock(lines, i) {
    const headerMatch = lines[i].trim().match(/^shipyard\s+"([^"]+)"/) ||
                        lines[i].trim().match(/^shipyard\s+`([^`]+)`/);
    if (!headerMatch) return i + 1;
    const name = headerMatch[1];
    const ships = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const m = line.trim().match(/^"([^"]+)"/) || line.trim().match(/^`([^`]+)`/);
      if (m) ships.push(m[1]);
      i++;
    }
    this.speciesResolver.collectShipyard(name, ships, this._currentPluginId);
    this.locationResolver.collectShipyard(name, ships, this._currentPluginId);
    return i;
  }

  parseOutfitterBlock(lines, i) {
    const headerMatch = lines[i].trim().match(/^outfitter\s+"([^"]+)"/) ||
                        lines[i].trim().match(/^outfitter\s+`([^`]+)`/);
    if (!headerMatch) return i + 1;
    const name = headerMatch[1];
    const outfits = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const m = line.trim().match(/^"([^"]+)"/) || line.trim().match(/^`([^`]+)`/);
      if (m) outfits.push(m[1]);
      i++;
    }
    this.speciesResolver.collectOutfitter(name, outfits, this._currentPluginId);
    this.locationResolver.collectOutfitter(name, outfits, this._currentPluginId);
    return i;
  }

  parsePlanetBlock(lines, i) {
    const headerMatch = lines[i].trim().match(/^(?:"planet"|planet)\s+"([^"]+)"/);
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
      const syMatch    = stripped.match(/^shipyard\s+"([^"]+)"/) || stripped.match(/^shipyard\s+`([^`]+)`/);
      const addSyMatch = stripped.match(/^add\s+shipyard\s+"([^"]+)"/) || stripped.match(/^add\s+shipyard\s+`([^`]+)`/);
      const ofMatch    = stripped.match(/^outfitter\s+"([^"]+)"/) || stripped.match(/^outfitter\s+`([^`]+)`/);
      if (govMatch)   government = govMatch[1];
      if (syMatch)    shipyards.push(syMatch[1]);
      if (ofMatch)    outfitters.push(ofMatch[1]);
      if (addSyMatch) {
        shipyards.push(addSyMatch[1]);
        this.locationResolver.collectEventPlanetShipyardAdd(planetName, addSyMatch[1], this._currentPluginId);
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

  parseEventBlock(lines, i) {
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      if (indent >= 1) {
        if (stripped.startsWith('fleet ') || stripped === 'fleet') { i = this.parseFleetBlock(lines, i); continue; }
        if (stripped.startsWith('planet ') || stripped.startsWith('"planet"')) { i = this.parsePlanetBlock(lines, i); continue; }
        if (stripped.startsWith('shipyard ')) { i = this.parseShipyardBlock(lines, i); continue; }
        if (stripped.startsWith('outfitter ')) { i = this.parseOutfitterBlock(lines, i); continue; }
        if (stripped === 'npc' || stripped.startsWith('npc ')) { i = this.parseNpcBlock(lines, i); continue; }
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
            const [nd, ni] = this.parseBlock(lines, i + 1, options);
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

        const kv = this.parseKeyValue(stripped);
        if (kv) {
          const [k, v] = kv;
          if (k in data) {
            if (!Array.isArray(data[k])) data[k] = [data[k]];
            data[k].push(v);
          } else { data[k] = v; }
          i++; continue;
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

  parseHardpoint(stripped, lines, i, baseIndent) {
    if (stripped.match(/^["'`]?engine["'`]?\s+(-?\d+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(1);
      const d = { x: +p[0], y: +p[1] };
      if (p[2]) d.zoom = +p[2];
      return ['engines', d, i + 1];
    }
    if (stripped.match(/^["'`]?reverse engine["'`]?\s+(-?\d+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(2);
      const d = { x: +p[0], y: +p[1] };
      if (p[2]) d.zoom = +p[2];
      return ['reverseEngines', d, this.parseOptionalNestedProperty(lines, i, baseIndent, d, 'position')];
    }
    if (stripped.match(/^["'`]?steering engine["'`]?\s+(-?\d+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(2);
      const d = { x: +p[0], y: +p[1] };
      if (p[2]) d.zoom = +p[2];
      return ['steeringEngines', d, this.parseOptionalNestedProperty(lines, i, baseIndent, d, 'position')];
    }
    if (stripped.match(/^["'`]?gun["'`]?\s+(-?\d+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(1);
      return ['guns', { x: +p[0], y: +p[1], gun: '' }, i + 1];
    }
    if (stripped.match(/^["'`]?turret["'`]?\s+(-?\d+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(1);
      return ['turrets', { x: +p[0], y: +p[1], turret: '' }, i + 1];
    }
    const bm = stripped.match(/^["'`]?bay["'`]?\s+["'`]?([^"'`\s]+)["'`]?\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)(?:\s+(.+))?/);
    if (bm) {
      const d = { type: bm[1], x: +bm[2], y: +bm[3] };
      if (bm[4]) d.position = bm[4];
      if (i + 1 < lines.length) {
        const ni = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
        if (ni > baseIndent) {
          i++;
          while (i < lines.length) {
            const bl = lines[i], bli = bl.length - bl.replace(/^\t+/, '').length;
            if (bli <= baseIndent) break;
            const kv = this.parseKeyValue(bl.trim());
            if (kv) d[kv[0]] = kv[1];
            i++;
          }
          return ['bays', d, i];
        }
      }
      return ['bays', d, i + 1];
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

  parseOptionalNestedProperty(lines, i, baseIndent, data, prop) {
    if (i + 1 < lines.length) {
      const ni = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
      if (ni > baseIndent) {
        i++;
        while (i < lines.length) {
          const pl = lines[i], pi2 = pl.length - pl.replace(/^\t+/, '').length;
          if (pi2 <= baseIndent) break;
          if (pl.trim()) data[prop] = pl.trim();
          i++;
        }
        return i;
      }
    }
    return i + 1;
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
        const [outfitMap, ni] = this.parseOutfitsBlock(lines, i, baseName, null);
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
        this.locationResolver.collectShipOutfit(v.name, outfitName, this._currentPluginId);
        changed = true;
        i++; continue;
      }

      if (stripped === 'outfits') {
        const [outfitMap, ni] = this.parseOutfitsBlock(lines, i, variantInfo.baseName, v.name);
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
    console.log(`  Outfit pluginId resolution: ${resolved} resolved, ${stillMissing} still missing`);
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
      let results;
      try {
        results = await sharedParser.parseRepository(source.repository, source.name);
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

      // ── Write pluginData.json if plugin.txt was found ──
      if (plugin.pluginData) {
        await fs.writeFile(
          path.join(pluginDir, 'pluginData.json'),
          JSON.stringify(plugin.pluginData, null, 2)
        );
      }

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
      const indexEntry = { outputName: plugin.outputName };
      if (plugin.pluginData?.name) {
        indexEntry.displayPluginName = plugin.pluginData.name;
      }
      dataIndex[source.name].push(indexEntry);
    }

    const indexPath = path.join(process.cwd(), 'data', 'index.json');
    await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify(dataIndex, null, 2));
    console.log(`\nWrote data/index.json with ${Object.keys(dataIndex).length} source(s)`);

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
