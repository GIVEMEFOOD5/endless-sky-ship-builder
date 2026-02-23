// parser.js - Endless Sky data parser for GitHub Actions
// Parses ship, variant, outfit, and effect data from GitHub repositories.
// Uses sparse Git clones (data/ + images/ only) instead of the GitHub API,
// which avoids rate limits and the 100k-file tree truncation limit.

const https          = require('https');
const SpeciesResolver = require('./speciesResolver');
const fs     = require('fs').promises;
const path   = require('path');
const ImageConverter = require('./imageConverter');
const { exec: execCallback } = require('child_process');
const { promisify } = require('util');
const exec   = promisify(execCallback);

// ---------------------------------------------------------------------------
// Helper: sparse-clone specific folders from a repo
// ---------------------------------------------------------------------------
async function sparseClone(repoGitUrl, branch, targetDir, folders) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await exec(`git clone --filter=blob:none --no-checkout --depth 1 --single-branch --branch ${branch} ${repoGitUrl} "${targetDir}"`);
  await exec(`git -C "${targetDir}" sparse-checkout init --cone`);
  await exec(`git -C "${targetDir}" sparse-checkout set ${folders.map(f => `"${f}"`).join(' ')}`);
  await exec(`git -C "${targetDir}" checkout ${branch}`);
}

// ---------------------------------------------------------------------------
class EndlessSkyParser {
  constructor() {
    this.ships           = [];
    this.variants        = [];
    this.outfits         = [];
    this.effects         = [];
    this.pendingVariants = [];

    // Species resolution — handled by dedicated module
    this.speciesResolver = new SpeciesResolver();
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

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

  /**
   * Walk a cloned directory tree and find all plugin roots.
   * A plugin root is a folder whose direct child is a directory named "data"
   * containing at least one .txt file.
   *
   * Returns: [{ name, dataDir, imagesDir|null, pluginRootInRepo }]
   * pluginRootInRepo is the path relative to cloneDir (e.g. "." or "plugins/foo")
   */
  /**
   * Uses git ls-tree to find plugin roots without cloning any files.
   * Much faster than a full probe clone, works on repos of any size.
   * Returns same format as detectPlugins: [{ name, pluginRootInRepo, imagesDir: null }]
   * imagesDir is null here - it gets resolved from the real clone later.
   */
  async detectPluginsViaLsTree(repoGitUrl, branch, repoName) {
    // Clone with no checkout and no blobs - just the git objects
    const tmpDir = path.join(process.cwd(), `.tmp-lstree-${repoName}-${Date.now()}`);
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      await exec(`git clone --filter=blob:none --no-checkout --depth 1 --single-branch --branch ${branch} ${repoGitUrl} "${tmpDir}"`);

      // Use ls-tree to list all tree (directory) objects recursively
      const { stdout } = await exec(`git -C "${tmpDir}" ls-tree -r --name-only -t HEAD`);
      const allPaths = stdout.trim().split('\n').filter(Boolean);

      // Find all paths ending in /data or equal to "data"
      const plugins = [];
      for (const p of allPaths) {
        const basename = path.basename(p);
        if (basename !== 'data') continue;

        // Check there's at least one .txt file under this data/ path
        const hasTxt = allPaths.some(f => f.startsWith(p + '/') && f.endsWith('.txt'));
        if (!hasTxt) continue;

        const parentDir = path.dirname(p);
        const pluginRootInRepo = (parentDir === '.' || parentDir === '') ? '.' : parentDir;
        const pluginName = pluginRootInRepo === '.' ? repoName : path.basename(pluginRootInRepo);

        // Check if images/ sibling exists in the tree
        const imagesPath = pluginRootInRepo === '.' ? 'images' : `${pluginRootInRepo}/images`;
        const hasImages = allPaths.includes(imagesPath);

        plugins.push({
          name: pluginName,
          pluginRootInRepo,
          hasImages // used later when deciding whether to sparse-clone images/
        });
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
          // Does it contain any .txt files?
          const files  = await fs.readdir(fullPath);
          const hasTxt = files.some(f => f.endsWith('.txt'));
          if (!hasTxt) continue;

          // Parent of data/ is the plugin root
          const pluginRoot = dir;
          const pluginName = pluginRoot === cloneDir
            ? repoName
            : path.basename(pluginRoot);

          // Relative path of the plugin root inside the repo
          const pluginRootInRepo = path.relative(cloneDir, pluginRoot) || '.';

          // Optional sibling images/
          const imagesDir = path.join(pluginRoot, 'images');
          let hasImages = false;
          try { await fs.access(imagesDir); hasImages = true; } catch {}

          plugins.push({
            name:            pluginName,
            dataDir:         fullPath,
            imagesDir:       hasImages ? imagesDir : null,
            pluginRootInRepo // e.g. "." or "plugins/my-plugin"
          });

          // Don't recurse into data/ itself
          continue;
        }

        await walk(fullPath);
      }
    };

    await walk(cloneDir);
    return plugins;
  }

  // ── Image helpers ──────────────────────────────────────────────────────────

  collectImagePaths() {
    const paths = new Set();
    const add = p => { if (p) paths.add(p); };

    for (const s of this.ships)   { add(s.sprite); add(s.thumbnail); }
    for (const v of this.variants) { add(v.sprite); add(v.thumbnail); }
    for (const o of this.outfits) {
      add(o.sprite); add(o.thumbnail);
      add(o['flare sprite']); add(o['steering flare sprite']); add(o['reverse flare sprite']);
      if (o.weapon) { add(o.weapon['hardpoint sprite']); add(o.weapon.sprite); }
    }
    for (const e of this.effects) { add(e.sprite); }
    return paths;
  }

  async copyMatchingImages(sourceDir, destDir, imagePath) {
    const norm       = imagePath.replace(/\\/g, '/');
    const parts      = norm.split('/');
    const basename   = parts[parts.length - 1];
    const parentDir  = parts.slice(0, -1).join('/');
    const escaped    = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const searchPaths = [
      { dir: path.join(sourceDir, parentDir), relative: parentDir  },
      { dir: path.join(sourceDir, norm),      relative: norm       }
    ];

    for (const sp of searchPaths) {
      try {
        const stat = await fs.stat(sp.dir);
        if (!stat.isDirectory()) continue;

        const files   = await fs.readdir(sp.dir);
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
            console.log(`    ✓ ${sp.relative}/${f}`);
          }
          return;
        }
      } catch { continue; }
    }
    console.log(`    ✗ No files found for: ${norm}`);
  }

  async copyImages(sourceImagesDir, destImagesDir) {
    if (!sourceImagesDir) {
      console.log('  No images folder, skipping.');
      return;
    }
    await fs.mkdir(destImagesDir, { recursive: true });
    const paths = this.collectImagePaths();
    console.log(`  Copying images (${paths.size} paths referenced)...`);
    for (const p of paths) {
      await this.copyMatchingImages(sourceImagesDir, destImagesDir, p);
    }
    console.log('  ✓ Images done');
  }

  /**
   * Same as copyImages but uses explicitly passed data instead of this.*
   * Used when copying images after the shared state has moved on to other plugins.
   */
  async copyImagesForPlugin(sourceImagesDir, destImagesDir, ships, variants, outfits, effects) {
    if (!sourceImagesDir) {
      console.log('  No images folder, skipping.');
      return;
    }
    await fs.mkdir(destImagesDir, { recursive: true });

    const paths = new Set();
    const add = p => { if (p) paths.add(p); };

    for (const s of ships)   { add(s.sprite); add(s.thumbnail); }
    for (const v of variants) { add(v.sprite); add(v.thumbnail); }
    for (const o of outfits) {
      add(o.sprite); add(o.thumbnail);
      add(o['flare sprite']); add(o['steering flare sprite']); add(o['reverse flare sprite']);
      if (o.weapon) { add(o.weapon['hardpoint sprite']); add(o.weapon.sprite); }
    }
    for (const e of effects) { add(e.sprite); }

    console.log(`  Copying images (${paths.size} paths referenced)...`);
    for (const p of paths) {
      await this.copyMatchingImages(sourceImagesDir, destImagesDir, p);
    }
    console.log('  ✓ Images done');
  }

  // ── Main repository entry point ────────────────────────────────────────────

  /**
   * Sparse-clones data/ and images/ for every plugin found in the repository.
   * No GitHub API tree calls — works on repos of any size.
   *
   * @param {string} repoUrl
   * @returns {Promise<Array>} - array of result objects ready for main() to save
   */
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

    // ── Step 1: probe - use git ls-tree to find plugin roots without cloning ────
    // This avoids checking out any files at all, even for huge repos.
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

    // ── Step 2: sparse clone each plugin's data/ + images/, parse into shared state ──
    // We accumulate ALL ships and pendingVariants across every plugin first,
    // so variants can resolve against base ships from any plugin in this repo.

    // Reset shared parser state once for the whole repository
    this.ships           = [];
    this.variants        = [];
    this.outfits         = [];
    this.effects         = [];
    this.pendingVariants = [];
    this.speciesResolver.reset();

    // Track per-plugin metadata so we can split results back out after
    const pluginMeta = []; // [{ name, shipsBefore, outfitsBefore, effectsBefore, imagesDir }]

    for (const probe of probePlugins) {
      console.log(`\n  ── Plugin: ${probe.name} ──`);

      const root       = probe.pluginRootInRepo;
      const dataPath   = root === '.' ? 'data'   : `${root}/data`;
      const imagesPath = root === '.' ? 'images' : `${root}/images`;
      const foldersToClone = probe.hasImages ? [dataPath, imagesPath] : [dataPath];
      const cloneDir   = path.join(process.cwd(), `.tmp-${repo}-${probe.name}`);

      try {
        console.log(`  Sparse cloning data/ and images/...`);
        await sparseClone(repoGitUrl, branch, cloneDir, foldersToClone);

        const clonedPlugins = await this.detectPlugins(cloneDir, repo);
        const clonedPlugin  = clonedPlugins.find(p => p.name === probe.name) || clonedPlugins[0];

        if (!clonedPlugin) {
          console.warn(`  Could not locate plugin "${probe.name}" in clone, skipping.`);
          continue;
        }

        // Snapshot counts BEFORE parsing this plugin so we can slice results later
        const shipsBefore   = this.ships.length;
        const outfitsBefore = this.outfits.length;
        const effectsBefore = this.effects.length;

        const txtFiles = await this.findTxtFiles(clonedPlugin.dataDir);
        console.log(`  Parsing ${txtFiles.length} data files...`);
        for (const f of txtFiles) {
          this.parseFileContent(await fs.readFile(f, 'utf8'), f, clonedPlugin.dataDir);
        }

        console.log(`  → +${this.ships.length - shipsBefore} ships, +${this.outfits.length - outfitsBefore} outfits, +${this.effects.length - effectsBefore} effects (${this.pendingVariants.length} variants pending)`);

        // Store snapshot so we can slice after variants are processed
        pluginMeta.push({
          name:         clonedPlugin.name,
          imagesDir:    clonedPlugin.imagesDir,
          cloneDir,     // keep reference so we can copy images before deleting
          shipsBefore,
          shipsAfter:   this.ships.length,
          outfitsBefore,
          outfitsAfter: this.outfits.length,
          effectsBefore,
          effectsAfter: this.effects.length
        });

        // NOTE: do NOT delete cloneDir here - we need it for image copying after
        // variants are processed. It is deleted below after images are copied.

      } catch (err) {
        // On error, clean up this clone and rethrow
        await fs.rm(cloneDir, { recursive: true, force: true });
        throw err;
      }
    }

    // ── Step 3: process ALL variants now, against the full combined ship pool ──
    console.log(`\n  Processing ${this.pendingVariants.length} total variants against ${this.ships.length} total ships...`);
    this.processVariants();
    console.log(`  → ${this.variants.length} variants kept`);

    // ── Step 3b: attach species to all ships, variants, and outfits ───────────
    // Uses all parsed fleet/npc/shipyard/outfitter/planet data accumulated above.
    // We pass the first plugin's name as the fallback label — for single-plugin
    // repos this is perfect; for multi-plugin repos each plugin will override
    // with its own name in the results loop below.
    const fallbackName = pluginMeta[0]?.name || sourceName || repo;
    console.log(`  Resolving species (${this.fleets.length} fleets, ${this.npcRefs.length} npc refs, ${this.planets.length} planets)...`);
    this.speciesResolver.attachSpecies(this.ships, this.variants, this.outfits, fallbackName);
    console.log(`  ✓ Species attached`);

    // ── Step 4: split results per plugin, copy images, then delete clones ─────
    const results = [];

    for (const meta of pluginMeta) {
      try {
        const pluginShips   = this.ships.slice(meta.shipsBefore,   meta.shipsAfter);
        const pluginOutfits = this.outfits.slice(meta.outfitsBefore, meta.outfitsAfter);
        const pluginEffects = this.effects.slice(meta.effectsBefore, meta.effectsAfter);

        // Assign variants to the plugin that owns their base ship
        const pluginShipNames = new Set(pluginShips.map(s => s.name));
        const pluginVariants  = this.variants.filter(v => pluginShipNames.has(v.baseShip));

        const isEmpty = pluginShips.length === 0 && pluginVariants.length === 0 &&
                        pluginOutfits.length === 0 && pluginEffects.length === 0;

        if (isEmpty) {
          console.log(`  Skipping "${meta.name}" - no parseable content found.`);
          continue;
        }

        console.log(`  Plugin "${meta.name}": ${pluginShips.length} ships, ${pluginVariants.length} variants, ${pluginOutfits.length} outfits, ${pluginEffects.length} effects`);

      // For multi-plugin repos the fallback species was set to the first plugin's name.
      // Fix any "fallback" confidence items to use THIS plugin's name instead.
      if (probePlugins.length > 1) {
        for (const item of [...pluginShips, ...pluginVariants, ...pluginOutfits]) {
          if (item.speciesConfidence === 'fallback') item.species = meta.name;
        }
      }

        // Output folder: sourceName for single-plugin repos, internal name for multi-plugin
        const isSinglePlugin = probePlugins.length === 1;
        const outputName = isSinglePlugin
          ? (sourceName || meta.name)
          : meta.name;

        // Copy images NOW while the clone still exists on disk
        const destImagesDir = path.join(process.cwd(), 'data', outputName, 'images');
        await this.copyImagesForPlugin(meta.imagesDir, destImagesDir, pluginShips, pluginVariants, pluginOutfits, pluginEffects);

        results.push({
          name:       meta.name,
          outputName,
          repository: repoUrl,
          ships:      pluginShips,
          variants:   pluginVariants,
          outfits:    pluginOutfits,
          effects:    pluginEffects,
          owner, repo, branch
        });

      } finally {
        // Delete this plugin's clone now that images have been copied
        await fs.rm(meta.cloneDir, { recursive: true, force: true });
      }
    }

    return results;
  }

  // ── Parsing methods (unchanged from original) ──────────────────────────────

  parseFileContent(content, filePath, dataDir) {
    // Determine parent folder name relative to dataDir for folder-based species detection
    // e.g. dataDir/.../data/human/ships.txt → parentFolder = "human"
    let parentFolder = null;
    if (filePath && dataDir) {
      const rel    = path.relative(dataDir, filePath);
      const parts  = rel.split(path.sep);
      parentFolder = parts.length > 1 ? parts[0] : null;
    }

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
            if (parentFolder) this.speciesResolver.setSourceFile(d.name, f, dataDir);
            this.ships.push(d);
          }
          i = ni; continue;
        } else if (trimmed.startsWith('outfit ')) {
          const [d, ni] = this.parseOutfit(lines, i);
          if (d) {
            if (parentFolder) this.speciesResolver.setSourceFile(d.name, f, dataDir);
            this.outfits.push(d);
          }
          i = ni; continue;
        } else if (trimmed.startsWith('effect ')) {
          const [d, ni] = this.parseExtraEffect(lines, i);
          if (d) this.effects.push(d);
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
        }
      }
      i++;
    }
  }

  // ── Species-resolution block parsers ────────────────────────────────────────

  parseFleetBlock(lines, i) {
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
        if (stripped === 'variant' || stripped.startsWith('variant ')) { i++; continue; }
      }
      if (indent === 2) {
        const shipMatch = stripped.match(/^"([^"]+)"(?:\s+\d+)?$/) ||
                          stripped.match(/^`([^`]+)`(?:\s+\d+)?$/);
        if (shipMatch) shipNames.push(shipMatch[1]);
      }
      i++;
    }
    this.speciesResolver.collectFleet(government, shipNames);
    return i;
  }

  parseMissionBlock(lines, i) {
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      if (indent === 1 && (stripped === 'npc' || stripped.startsWith('npc '))) {
        i = this.parseNpcBlock(lines, i);
        continue;
      }
      i++;
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
        const govMatch  = stripped.match(/^government\s+"([^"]+)"/);
        const shipMatch = stripped.match(/^ship\s+"([^"]+)"/) ||
                          stripped.match(/^ship\s+`([^`]+)`/);
        if (govMatch)  { government = govMatch[1];   i++; continue; }
        if (shipMatch) { shipNames.push(shipMatch[1]); i++; continue; }
      }
      i++;
    }
    for (const shipName of shipNames) {
      this.speciesResolver.collectNpcRef(government, shipName);
    }
    return i;
  }

  parseShipyardBlock(lines, i) {
    const headerMatch = lines[i].trim().match(/^shipyard\s+"([^"]+)"/);
    if (!headerMatch) return i + 1;
    const name = headerMatch[1];
    const ships = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const m = line.trim().match(/^"([^"]+)"/);
      if (m) ships.push(m[1]);
      i++;
    }
    this.speciesResolver.collectShipyard(name, ships);
    return i;
  }

  parseOutfitterBlock(lines, i) {
    const headerMatch = lines[i].trim().match(/^outfitter\s+"([^"]+)"/);
    if (!headerMatch) return i + 1;
    const name = headerMatch[1];
    const outfits = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const m = line.trim().match(/^"([^"]+)"/);
      if (m) outfits.push(m[1]);
      i++;
    }
    this.speciesResolver.collectOutfitter(name, outfits);
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
      const govMatch = stripped.match(/^government\s+"([^"]+)"/);
      const syMatch  = stripped.match(/^shipyard\s+"([^"]+)"/);
      const ofMatch  = stripped.match(/^outfitter\s+"([^"]+)"/);
      if (govMatch) government = govMatch[1];
      if (syMatch)  shipyards.push(syMatch[1]);
      if (ofMatch)  outfitters.push(ofMatch[1]);
      i++;
    }
    this.speciesResolver.collectPlanet(planetName, government, shipyards, outfitters);
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
        const k = m[p.ki];
        const vs = m[p.vi].trim();
        const v = p.str ? vs : (isNaN(parseFloat(vs)) ? vs : parseFloat(vs));
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

    const single = stripped.match(/description\s+[`"](.+)[`"]$/);
    if (single) return [[single[1]], i + 1];

    const start = stripped.match(/description\s+[`"](.*)$/);
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
    const map = {
      'sprite ':                { key: 'sprite',               re: /sprite\s+["`]([^"'`]+)["'`]/,                alt: /sprite\s+(\S+)/ },
      '"flare sprite"':         { key: 'flare sprite',          re: /"flare sprite"\s+["`]([^"'`]+)["'`]/,         alt: /"flare sprite"\s+(\S+)/ },
      '"steering flare sprite"':{ key: 'steering flare sprite', re: /"steering flare sprite"\s+["`]([^"'`]+)["'`]/,alt: /"steering flare sprite"\s+(\S+)/ },
      '"reverse flare sprite"': { key: 'reverse flare sprite',  re: /"reverse flare sprite"\s+["`]([^"'`]+)["'`]/, alt: /"reverse flare sprite"\s+(\S+)/ },
      '"afterburner effect"':   { key: 'afterburner effect',    re: /"afterburner effect"\s+["`]([^"'`]+)["'`]/,   alt: /"afterburner effect"\s+(\S+)/ }
    };

    for (const [prefix, cfg] of Object.entries(map)) {
      if (stripped.startsWith(prefix)) {
        const m = stripped.match(cfg.re) || stripped.match(cfg.alt);
        if (!m) break;
        const result = { [cfg.key]: m[1] };
        if (i + 1 < lines.length) {
          const ni = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (ni > baseIndent) {
            const [sd, nextIdx] = this.parseBlock(lines, i + 1);
            result.spriteData = sd;
            return [result, nextIdx];
          }
        }
        return [result, i + 1];
      }
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

  parseOptionalNestedProperty(lines, i, baseIndent, data, prop) {
    if (i + 1 < lines.length) {
      const ni = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
      if (ni > baseIndent) {
        i++;
        while (i < lines.length) {
          const pl = lines[i], pi = pl.length - pl.replace(/^\t+/, '').length;
          if (pi <= baseIndent) break;
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
      this.pendingVariants.push({ baseName, variantName, startIdx, lines });
      return [null, this.skipIndentedBlock(lines, startIdx, 0)];
    }

    const shipData = { name: baseName, engines: [], reverseEngines: [], steeringEngines: [], guns: [], turrets: [], bays: [] };
    const [parsed, nextIdx] = this.parseBlock(lines, startIdx + 1, {
      parseHardpoints: true,
      skipBlocks: ['add attributes', 'outfits']
    });
    Object.assign(shipData, parsed);

    const hasData = shipData.description && (
      shipData.attributes || shipData.engines.length > 0 ||
      shipData.guns.length > 0 || shipData.turrets.length > 0 || shipData.bays.length > 0
    );
    return [hasData ? shipData : null, nextIdx];
  }

  parseShipVariant(variantInfo) {
    const baseShip = this.ships.find(s => s.name === variantInfo.baseName);
    if (!baseShip) { console.warn(`Warning: base ship "${variantInfo.baseName}" not found`); return null; }

    const { startIdx, lines } = variantInfo;
    if (startIdx + 1 >= lines.length) return null;
    const nl = lines[startIdx + 1];
    if (nl.trim() && (nl.length - nl.replace(/^\t+/, '').length) === 0) return null;

    const v = JSON.parse(JSON.stringify(baseShip));
    v.name     = `${variantInfo.baseName} (${variantInfo.variantName})`;
    v.variant  = variantInfo.variantName;
    v.baseShip = variantInfo.baseName;

    const [parsed] = this.parseBlock(lines, startIdx + 1, { parseHardpoints: true, skipBlocks: ['outfits'] });
    let changed = false;

    if (parsed.displayName)                           { v.displayName = parsed.displayName; changed = true; }
    if (parsed.sprite && parsed.sprite !== baseShip.sprite) {
      v.sprite = parsed.sprite;
      if (parsed.spriteData) v.spriteData = parsed.spriteData;
      changed = true;
    }
    if (parsed.thumbnail && parsed.thumbnail !== baseShip.thumbnail) { v.thumbnail = parsed.thumbnail; changed = true; }

    for (const t of ['engines','reverseEngines','steeringEngines','guns','turrets','bays']) {
      if (parsed[t]?.length > 0) { v[t] = parsed[t]; changed = true; }
    }

    if (parsed['add attributes']) {
      changed = true;
      if (!v.attributes) v.attributes = {};
      for (const [k, val] of Object.entries(parsed['add attributes'])) {
        if (k in v.attributes && typeof v.attributes[k] === 'number' && typeof val === 'number')
          v.attributes[k] += val;
        else v.attributes[k] = val;
      }
    }

    if (!v.description) return null;
    return changed ? v : null;
  }

  /**
   * Compares two fully-resolved ship/variant objects to see if they are
   * effectively identical (same stats, hardpoints, sprite, thumbnail).
   * Used to deduplicate variants against each other.
   */
  shipsAreIdentical(a, b) {
    // Must be the same base ship family
    if (a.baseShip !== b.baseShip) return false;

    // Compare sprite and thumbnail
    if (a.sprite    !== b.sprite)    return false;
    if (a.thumbnail !== b.thumbnail) return false;

    // Compare hardpoints by count and position
    for (const t of ['engines','reverseEngines','steeringEngines','guns','turrets','bays']) {
      const aList = a[t] || [];
      const bList = b[t] || [];
      if (aList.length !== bList.length) return false;
      for (let i = 0; i < aList.length; i++) {
        if (aList[i].x !== bList[i].x || aList[i].y !== bList[i].y) return false;
      }
    }

    // Compare attributes
    const aAttr = a.attributes || {};
    const bAttr = b.attributes || {};
    const allKeys = new Set([...Object.keys(aAttr), ...Object.keys(bAttr)]);
    for (const k of allKeys) {
      if (aAttr[k] !== bAttr[k]) return false;
    }

    return true;
  }

  processVariants() {
    console.log(`  Processing ${this.pendingVariants.length} variants...`);
    let kept = 0, skippedNoChange = 0, skippedDuplicate = 0;

    for (const vi of this.pendingVariants) {
      const v = this.parseShipVariant(vi);

      // parseShipVariant already checks significance vs base ship
      if (!v) { skippedNoChange++; continue; }

      // Check against all already-accepted variants for duplicates
      const isDuplicate = this.variants.some(existing => this.shipsAreIdentical(existing, v));
      if (isDuplicate) {
        console.log(`    ~ Skipped duplicate variant: ${v.name}`);
        skippedDuplicate++;
        continue;
      }

      this.variants.push(v);
      console.log(`    + ${v.name}`);
      kept++;
    }

    console.log(`  Variants: ${kept} kept, ${skippedNoChange} no significant change, ${skippedDuplicate} duplicates removed`);
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
    return [data.description ? data : null, ni];
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
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  try {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), 'plugins.json'), 'utf8'));
    console.log(`Found ${config.plugins.length} repository source(s)\n`);

    // index.json maps sourceName -> [{ outputName, displayName }]
    // so the frontend knows exactly which folders were generated
    const dataIndex = {};

    for (const source of config.plugins) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Source: ${source.name}  |  ${source.repository}`);
      console.log('='.repeat(60));

      let results;
      try {
        const parser = new EndlessSkyParser();
        results = await parser.parseRepository(source.repository, source.name);
      } catch (err) {
        console.error(`  Error processing "${source.name}": ${err.message}`);
        console.error(err.stack);
        console.error(`  Skipping and continuing with next source...`);
        continue;
      }

      if (results.length === 0) {
        console.log('No plugins found, skipping.');
        continue;
      }

      for (const plugin of results) {
        console.log(`\nSaving → data/${plugin.outputName}/`);

        const pluginDir   = path.join(process.cwd(), 'data', plugin.outputName);
        const dataFilesDir = path.join(pluginDir, 'dataFiles');
        await fs.mkdir(dataFilesDir, { recursive: true });

        // Images were already copied inside parseRepository while the clone existed.
        // Nothing extra needed here.

        /*// Convert image sequences to APNG
        const converter = new ImageConverter();
        await converter.processAllImages(pluginDir, plugin, { fps: null });*/

        await fs.writeFile(path.join(dataFilesDir, 'ships.json'),    JSON.stringify(plugin.ships,    null, 2));
        await fs.writeFile(path.join(dataFilesDir, 'variants.json'), JSON.stringify(plugin.variants, null, 2));
        await fs.writeFile(path.join(dataFilesDir, 'outfits.json'),  JSON.stringify(plugin.outfits,  null, 2));
        await fs.writeFile(path.join(dataFilesDir, 'effects.json'),  JSON.stringify(plugin.effects,  null, 2));
        await fs.writeFile(path.join(dataFilesDir, 'complete.json'), JSON.stringify({
          plugin:     plugin.name,
          repository: source.repository,
          ships:      plugin.ships,
          variants:   plugin.variants,
          outfits:    plugin.outfits,
          effects:    plugin.effects,
          parsedAt:   new Date().toISOString()
        }, null, 2));

        console.log(`  ✓ ${plugin.ships.length} ships | ${plugin.variants.length} variants | ${plugin.outfits.length} outfits | ${plugin.effects.length} effects`);

        // Track in index
        if (!dataIndex[source.name]) dataIndex[source.name] = [];
        dataIndex[source.name].push({
          outputName:  plugin.outputName,
          displayName: plugin.name
        });
      }
    }

    // Write index.json so the frontend can discover all generated folders
    const indexPath = path.join(process.cwd(), 'data', 'index.json');
    await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify(dataIndex, null, 2));
    console.log(`\nWrote data/index.json with ${Object.keys(dataIndex).length} source(s)`);

    console.log(`\n${'='.repeat(60)}\n✓ All done!\n${'='.repeat(60)}\n`);
  } catch (err) {
    console.error('Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = EndlessSkyParser;
