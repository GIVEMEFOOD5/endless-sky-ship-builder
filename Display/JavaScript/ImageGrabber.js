/**
 * image-fetcher.js
 *
 * Uses the GitHub API to fetch the full repo file tree once, builds a
 * searchable filename index, then fetches exact URLs — no more guessing
 * extensions or probing 404s.
 *
 * Requires endless-sky-animator.js to be loaded first.
 *
 * Public API
 * ──────────
 *   initImageIndex()
 *     Fetches the repo tree and builds the index. Call once at startup.
 *     Safe to call multiple times — only fetches once.
 *     → Promise<void>
 *
 *   fetchSprite(spritePath, spriteParams?)
 *     Looks up all frames for spritePath in the index, fetches their blobs,
 *     passes to EndlessSkyAnimator (or returns a plain <img> for statics).
 *     → Promise<HTMLCanvasElement | HTMLImageElement | null>
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

// Separator chars used in ES animation filenames
const SEPARATORS = ['+', '~', '-', '^', '=', '@'];
const SEP_RE     = new RegExp('[' + SEPARATORS.map(function(s) {
  return s.replace(/[-^]/g, '\\$&');
}).join('') + ']');

// ─── Module state ─────────────────────────────────────────────────────────────

// Map of  normalised-base-path  →  Array<{fullPath, url, variation}>
// Built once by initImageIndex().
let _index     = null;   // null = not yet built
let _indexing  = null;   // Promise while building, to avoid duplicate fetches

// Active animator / static-image disposable
let _active    = null;
let _fetchGen  = 0;


// ─── Index builder ────────────────────────────────────────────────────────────

/**
 * Fetch the full repo file tree from the GitHub API and build _index.
 * The GitHub Trees API returns every file path in one request (no auth needed
 * for public repos).
 */
async function initImageIndex() {
  if (_index)    return;          // already built
  if (_indexing) return _indexing; // already in progress

  _indexing = (async function() {
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

      // Split off any trailing separator+number to find the base key
      // "ship/penguin/penguin+0"  → base = "ship/penguin/penguin", variation = "+0"
      // "ship/penguin/penguin"    → base = "ship/penguin/penguin",  variation = "base"
      const sepMatch = noExt.match(/^(.*?)([+~\-\^=@])(\d+)$/);
      let baseKey, variation;

      if (sepMatch) {
        baseKey   = sepMatch[1];
        variation = sepMatch[2] + sepMatch[3];   // e.g. "+0"
      } else {
        baseKey   = noExt;
        variation = 'base';
      }

      if (!_index[baseKey]) _index[baseKey] = [];
      _index[baseKey].push({ fullPath: rel, url: pageUrl, variation: variation });
    });

    // Sort each entry's frames into numeric order
    Object.keys(_index).forEach(function(key) {
      _index[key].sort(function(a, b) {
        if (a.variation === 'base') return -1;
        if (b.variation === 'base') return  1;
        const na = parseInt(a.variation.replace(/\D/g, ''), 10);
        const nb = parseInt(b.variation.replace(/\D/g, ''), 10);
        return na - nb;
      });
    });

    console.log('image-fetcher: index built —', Object.keys(_index).length, 'sprites');
    _indexing = null;
  })();

  return _indexing;
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

  // Normalise: strip leading slash, extension, trailing sep+num
  let key = basePath.replace(/^\/+/, '');
  key = key.replace(/\.(png|jpg|jpeg)$/i, '');
  key = key.replace(/[+~\-\^=@]\d+$/, '');

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


// ─── Globals ──────────────────────────────────────────────────────────────────
window.initImageIndex      = initImageIndex;
window.findImageVariations = findImageVariations;
window.fetchSprite         = fetchSprite;
window.clearSpriteCache    = clearSpriteCache;
