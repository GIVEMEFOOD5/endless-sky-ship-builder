/**
 * image-fetcher.js
 *
 * Uses the GitHub API to fetch the full repo file tree once, builds a
 * searchable filename index, then fetches exact URLs — no more guessing
 * extensions or probing 404s.
 *
 * NOW WITH BUILT-IN EFFECTS SUPPORT!
 *
 * Requires endless-sky-animator.js to be loaded first.
 *
 * Public API
 * ──────────
 *   initImageIndex()
 *     Fetches the repo tree and builds the index. Call once at startup.
 *     Also loads effects.json automatically.
 *     Safe to call multiple times — only fetches once.
 *     → Promise<void>
 *
 *   fetchSprite(spritePath, spriteParams?)
 *     Looks up all frames for spritePath in the index, fetches their blobs,
 *     passes to EndlessSkyAnimator (or returns a plain <img> for statics).
 *     → Promise<HTMLCanvasElement | HTMLImageElement | null>
 *
 *   fetchEffectSprite(effectNameOrPath, spriteParams?)
 *     Tries to find the effect by name in effects.json, then fetches its sprite.
 *     If not found, treats the input as a direct sprite path.
 *     → Promise<HTMLCanvasElement | HTMLImageElement | null>
 *
 *   fetchOutfitEffects(outfit)
 *     Fetches all effect sprites for an outfit (flare sprite, afterburner, etc.)
 *     Returns an object with keys for each effect type.
 *     → Promise<Object>
 *
 *   getEffect(effectName)
 *     Looks up an effect by name in the loaded effects data.
 *     → Object | null
 *
 *   clearSpriteCache()
 *     Stops the active animator and revokes all object URLs.
 *     Call on every tab change and modal close.
 *     → void
 *
 *   findImageVariations(basePath)
 *     Low-level: returns all matching frame entries from the index.
 *     → Array<{path, url, variation}>  (sync after index is ready)
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

const GITHUB_REPO        = 'GIVEMEFOOD5/endless-sky-ship-builder';
const GITHUB_BRANCH      = 'main';
const IMAGES_REPO_PREFIX = 'data/official-game/images/';  // path inside repo
const GITHUB_PAGES_BASE  =
  'https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/' + IMAGES_REPO_PREFIX;
const EFFECTS_JSON_URL   = 'data/official-game/dataFiles/effects.json';

// Separator chars used in ES animation filenames
const SEPARATORS = ['+', '~', '-', '^', '=', '@'];
const SEP_RE     = new RegExp('[' + SEPARATORS.map(function(s) {
  return s.replace(/[-^]/g, '\\$&');
}).join('') + ']');

// ─── Module state ─────────────────────────────────────────────────────────────

// Image index: Map of normalised-base-path → Array<{fullPath, url, variation}>
let _index     = null;   // null = not yet built
let _indexing  = null;   // Promise while building, to avoid duplicate fetches

// Effects data
let _effectsData = null;  // Array of effect objects
let _effectsMap  = null;  // Map of effect name → effect object
let _effectsLoading = null;  // Promise while loading

// Active animator / static-image disposable
let _active    = null;
let _fetchGen  = 0;


// ─── Index builder ────────────────────────────────────────────────────────────

/**
 * Fetch the full repo file tree from the GitHub API and build _index.
 * Also loads effects.json automatically.
 * The GitHub Trees API returns every file path in one request (no auth needed
 * for public repos).
 */
async function initImageIndex() {
  if (_index)    return;          // already built
  if (_indexing) return _indexing; // already in progress

  _indexing = (async function() {
    // Build image index
    const apiUrl =
      'https://api.github.com/repos/' + GITHUB_REPO +
      '/git/trees/' + GITHUB_BRANCH + '?recursive=1';
    let tree;
    try {
      const res = await fetch(apiUrl, {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });
      if (!res.ok) throw new Error('GitHub API returned ' + res.status);
      const data = await res.json();
      tree = data.tree;
    } catch (err) {
      console.error('image-fetcher: failed to build index:', err);
      _index    = {};   // empty — fall back to blind-probe mode
      _indexing = null;
      return;
    }

    // Filter to image files inside IMAGES_REPO_PREFIX
    const imgExts = /\.(png|jpg|jpeg)$/i;
    _index = {};

    tree.forEach(function(node) {
      if (node.type !== 'blob') return;
      if (!node.path.startsWith(IMAGES_REPO_PREFIX)) return;
      if (!imgExts.test(node.path)) return;

      // Relative path inside the images folder, without extension
      // e.g. "ship/penguin/penguin+0"
      const rel      = node.path.slice(IMAGES_REPO_PREFIX.length);
      const noExt    = rel.replace(imgExts, '');
      const pageUrl  = GITHUB_PAGES_BASE + rel;

      // Split off any trailing separator+number OR separator-only to find the base key
      // "ship/penguin/penguin+0"  → base = "ship/penguin/penguin", variation = "+0"
      // "ship/penguin/penguin+"   → base = "ship/penguin/penguin", variation = "+"
      // "ship/penguin/penguin"    → base = "ship/penguin/penguin", variation = "base"
      const sepNumMatch = noExt.match(/^(.*?)([+~\-\^=@])(\d+)$/);
      const sepOnlyMatch = noExt.match(/^(.*?)([+~\-\^=@])$/);
      let baseKey, variation;

      if (sepNumMatch) {
        baseKey   = sepNumMatch[1];
        variation = sepNumMatch[2] + sepNumMatch[3];   // e.g. "+0"
      } else if (sepOnlyMatch) {
        baseKey   = sepOnlyMatch[1];
        variation = sepOnlyMatch[2];                    // e.g. "+"
      } else {
        baseKey   = noExt;
        variation = 'base';
      }

      if (!_index[baseKey]) _index[baseKey] = [];
      _index[baseKey].push({ fullPath: rel, url: pageUrl, variation: variation });
    });

    // Sort each entry's frames into numeric order
    // Order: 'base' first, then single-char separators (e.g. '+'), then numbered ('+0', '+1', ...)
    Object.keys(_index).forEach(function(key) {
      _index[key].sort(function(a, b) {
        if (a.variation === 'base') return -1;
        if (b.variation === 'base') return  1;
        
        // Single-char separator (e.g. '+') comes before numbered variants
        const aIsNum = /\d/.test(a.variation);
        const bIsNum = /\d/.test(b.variation);
        if (!aIsNum && bIsNum) return -1;
        if (aIsNum && !bIsNum) return  1;
        if (!aIsNum && !bIsNum) return a.variation.localeCompare(b.variation);
        
        // Both are numbered — sort numerically
        const na = parseInt(a.variation.replace(/\D/g, ''), 10);
        const nb = parseInt(b.variation.replace(/\D/g, ''), 10);
        return na - nb;
      });
    });

    console.log('image-fetcher: index built —', Object.keys(_index).length, 'sprites');
    _indexing = null;

    // Also load effects.json
    await loadEffectsData();
  })();

  return _indexing;
}


// ─── Effects data loader ──────────────────────────────────────────────────────

/**
 * Load effects.json and build the lookup map.
 * Called automatically by initImageIndex().
 */
async function loadEffectsData() {
  if (_effectsData) return;           // already loaded
  if (_effectsLoading) return _effectsLoading;  // already in progress

  _effectsLoading = (async function() {
    try {
      const res = await fetch(EFFECTS_JSON_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      
      _effectsData = await res.json();
      
      // Build name → effect map for fast lookup
      _effectsMap = {};
      _effectsData.forEach(function(effect) {
        if (effect.name) {
          _effectsMap[effect.name] = effect;
        }
      });
      
      console.log('image-fetcher: loaded', _effectsData.length, 'effects');
    } catch (err) {
      console.warn('image-fetcher: failed to load effects.json:', err);
      _effectsData = [];
      _effectsMap = {};
    }
    _effectsLoading = null;
  })();

  return _effectsLoading;
}


// ─── getEffect ────────────────────────────────────────────────────────────────

/**
 * Look up an effect by name.
 *
 * @param {string} effectName
 * @returns {Object | null}
 */
function getEffect(effectName) {
  if (!_effectsMap) {
    console.warn('image-fetcher: effects not loaded — call initImageIndex() first');
    return null;
  }
  return _effectsMap[effectName] || null;
}


// ─── findImageVariations ──────────────────────────────────────────────────────

/**
 * Look up all frames for basePath in the index.
 * Strips any trailing extension or separator+number from the input so
 * callers can safely pass raw sprite paths from item data.
 *
 * Returns an array of { fullPath, url, variation } — no blobs yet.
 * Returns [] if nothing found.
 *
 * @param {string} basePath  e.g. 'ship/penguin/penguin' or 'effects/fire+0'
 * @returns {Array<{fullPath, url, variation}>}
 */
function findImageVariations(basePath) {
  if (!_index) {
    console.warn('image-fetcher: index not ready — call initImageIndex() first');
    return [];
  }

  // Normalise: strip leading slash, extension, trailing sep+num or sep-only
  let key = basePath.replace(/^\/+/, '');
  key = key.replace(/\.(png|jpg|jpeg)$/i, '');
  key = key.replace(/[+~\-\^=@]\d+$/, '');   // strip "+0", "~5", etc.
  key = key.replace(/[+~\-\^=@]$/, '');      // strip trailing "+" with no number

  const frames = _index[key];
  if (frames && frames.length) return frames;

  // Nothing found under the exact key — do a suffix search.
  // Some paths in the data files omit leading folders.
  // e.g. item.sprite = "penguin/penguin"  but index key = "ship/penguin/penguin"
  const suffix = '/' + key;
  const matches = Object.keys(_index).filter(function(k) {
    return k === key || k.endsWith(suffix);
  });

  if (matches.length === 1) return _index[matches[0]];
  if (matches.length  > 1) {
    // Prefer the shortest match (least deeply nested)
    matches.sort(function(a, b) { return a.length - b.length; });
    return _index[matches[0]];
  }

  return [];
}


// ─── clearSpriteCache ─────────────────────────────────────────────────────────

function clearSpriteCache() {
  if (_active) {
    _active.dispose();
    _active = null;
  }
  _fetchGen++;
}


// ─── fetchSprite ──────────────────────────────────────────────────────────────

/**
 * Find all frames for spritePath, fetch their blobs, hand to animator.
 *
 * @param {string} spritePath
 * @param {Object} [spriteParams]
 * @returns {Promise<HTMLCanvasElement | HTMLImageElement | null>}
 */
async function fetchSprite(spritePath, spriteParams) {
  spriteParams = spriteParams || {};

  clearSpriteCache();
  const myGen = _fetchGen;

  if (!spritePath) {
    console.warn('fetchSprite: no spritePath');
    return null;
  }

  // Ensure index is ready
  await initImageIndex();
  if (_fetchGen !== myGen) return null;

  // Look up frames in index
  const frames = findImageVariations(spritePath);

  if (!frames.length) {
    console.warn('fetchSprite: "' + spritePath + '" not found in index');
    return null;
  }

  // Fetch all blobs in parallel
  const blobResults = await Promise.all(frames.map(async function(frame) {
    try {
      const res = await fetch(frame.url);
      if (!res.ok) return null;
      return { variation: frame.variation, blob: await res.blob(), url: frame.url, path: frame.fullPath };
    } catch (_) { return null; }
  }));

  if (_fetchGen !== myGen) return null;

  const variations = blobResults.filter(Boolean);

  if (!variations.length) {
    console.warn('fetchSprite: all fetches failed for "' + spritePath + '"');
    return null;
  }

  // ── Single frame → plain <img> ─────────────────────────────────────────────
  if (variations.length === 1) {
    const objectUrl = URL.createObjectURL(variations[0].blob);
    _active = { dispose: function() { URL.revokeObjectURL(objectUrl); } };

    const img = document.createElement('img');
    img.src = objectUrl;
    img.style.cssText =
      'max-width:100%;max-height:500px;object-fit:contain;' +
      'image-rendering:pixelated;display:block;margin:auto;';
    return img;
  }

  // ── Multiple frames → EndlessSkyAnimator ──────────────────────────────────
  if (typeof window.EndlessSkyAnimator !== 'function') {
    console.error('fetchSprite: EndlessSkyAnimator not loaded');
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'max-width:100%;image-rendering:pixelated;display:block;margin:auto;';

  const anim = new window.EndlessSkyAnimator(canvas);
  _active = anim;

  await anim.loadVariations(variations, spriteParams);

  if (_fetchGen !== myGen) return null;

  anim.play();
  return canvas;
}


// ─── fetchEffectSprite ────────────────────────────────────────────────────────

/**
 * Fetch the sprite for an effect.
 * 
 * First tries to look up the effect by name in effects.json.
 * If found, uses its sprite path and spriteData.
 * If not found, treats the input as a direct sprite path.
 *
 * @param {string} effectNameOrPath - Effect name or direct sprite path
 * @param {Object} [spriteParams] - Optional sprite parameters (overrides effect's spriteData)
 * @returns {Promise<HTMLCanvasElement | HTMLImageElement | null>}
 */
async function fetchEffectSprite(effectNameOrPath, spriteParams) {
  if (!effectNameOrPath) {
    console.warn('fetchEffectSprite: no effectNameOrPath provided');
    return null;
  }

  // Ensure data is loaded
  await initImageIndex();

  // Try to find effect by name
  const effect = getEffect(effectNameOrPath);
  
  if (effect) {
    // Found effect definition - use its sprite and spriteData
    if (!effect.sprite) {
      console.warn('fetchEffectSprite: effect "' + effectNameOrPath + '" has no sprite');
      return null;
    }
    
    // Use provided spriteParams, or fall back to effect's spriteData
    const params = spriteParams || effect.spriteData || {};
    
    console.log('fetchEffectSprite: fetching sprite for effect "' + effect.name + '"');
    return await fetchSprite(effect.sprite, params);
  } else {
    // Not found in effects.json - treat as direct sprite path
    console.log('fetchEffectSprite: "' + effectNameOrPath + '" not in effects.json, trying as sprite path');
    return await fetchSprite(effectNameOrPath, spriteParams);
  }
}


// ─── fetchOutfitEffects ───────────────────────────────────────────────────────

/**
 * Fetch all effect sprites for an outfit.
 * 
 * Checks for:
 * - flare sprite
 * - steering flare sprite
 * - reverse flare sprite
 * - afterburner effect
 *
 * Returns an object with keys for each found effect type.
 *
 * @param {Object} outfit
 * @returns {Promise<Object>}
 */
async function fetchOutfitEffects(outfit) {
  if (!outfit) return {};

  const results = {};

  // Flare sprite
  if (outfit['flare sprite']) {
    try {
      const sprite = await fetchEffectSprite(
        outfit['flare sprite'],
        outfit.spriteData
      );
      if (sprite) results.flareSprite = sprite;
    } catch (err) {
      console.error('fetchOutfitEffects: failed to fetch flare sprite:', err);
    }
  }

  // Steering flare sprite
  if (outfit['steering flare sprite']) {
    try {
      const sprite = await fetchEffectSprite(
        outfit['steering flare sprite'],
        outfit.spriteData
      );
      if (sprite) results.steeringFlareSprite = sprite;
    } catch (err) {
      console.error('fetchOutfitEffects: failed to fetch steering flare sprite:', err);
    }
  }

  // Reverse flare sprite
  if (outfit['reverse flare sprite']) {
    try {
      const sprite = await fetchEffectSprite(
        outfit['reverse flare sprite'],
        outfit.spriteData
      );
      if (sprite) results.reverseFlareSprite = sprite;
    } catch (err) {
      console.error('fetchOutfitEffects: failed to fetch reverse flare sprite:', err);
    }
  }

  // Afterburner effect
  if (outfit['afterburner effect']) {
    try {
      const sprite = await fetchEffectSprite(
        outfit['afterburner effect']
      );
      if (sprite) results.afterburnerEffect = sprite;
    } catch (err) {
      console.error('fetchOutfitEffects: failed to fetch afterburner effect:', err);
    }
  }

  return results;
}


// ─── Globals ──────────────────────────────────────────────────────────────────

window.initImageIndex      = initImageIndex;
window.findImageVariations = findImageVariations;
window.fetchSprite         = fetchSprite;
window.fetchEffectSprite   = fetchEffectSprite;
window.fetchOutfitEffects  = fetchOutfitEffects;
window.getEffect           = getEffect;
window.clearSpriteCache    = clearSpriteCache;
