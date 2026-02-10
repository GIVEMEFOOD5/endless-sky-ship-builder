/**
 * image-fetcher.js
 *
 * Fetches all sprite frames from GitHub Pages, passes them into
 * EndlessSkyAnimator, and returns a ready element to the caller.
 *
 * Requires endless-sky-animator.js to be loaded first.
 *
 * Public API
 * ──────────
 *   fetchSprite(spritePath, spriteParams?)
 *     → Promise<HTMLCanvasElement | HTMLImageElement | null>
 *     Fetches all frames, loads into animator, plays, returns the element.
 *     Single-frame sprites return a plain <img>; animated sprites return <canvas>.
 *
 *   clearSpriteCache()
 *     Stops and fully disposes the active animator, revoking all object URLs.
 *     Call on every tab change and on modal close.
 *     → void
 *
 *   findImageVariations(basePath, baseUrl?, options?)
 *     Low-level: returns all frame blobs for a sprite path.
 *     → Promise<Array<{path, url, blob, variation}>>
 */

'use strict';

const GITHUB_PAGES_BASE_URL =
  'https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/data/official-game/images';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
const SEPARATORS       = ['+', '~', '-', '^', '=', '@'];

// The single active disposable — either an EndlessSkyAnimator or a
// plain { dispose() } stub for static images.
let _active = null;

// Fetch-generation counter: if a newer fetch starts while an older one
// is still awaiting network, the older result is silently discarded.
let _fetchGen = 0;


// ─── Internal fetch helpers ───────────────────────────────────────────────────

function _pathToUrls(spritePath, baseUrl) {
  const base  = baseUrl.replace(/\/$/, '');
  const clean = spritePath.replace(/^\/+/, '');
  if (IMAGE_EXTENSIONS.some(function(ext) { return clean.toLowerCase().endsWith(ext); })) {
    return [base + '/' + clean];
  }
  return IMAGE_EXTENSIONS.map(function(ext) { return base + '/' + clean + ext; });
}

async function _fetchOne(spritePath, baseUrl) {
  const urls = _pathToUrls(spritePath, baseUrl);
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i]);
      if (res.ok) {
        return { path: spritePath, url: urls[i], blob: await res.blob() };
      }
    } catch (_) { /* try next extension */ }
  }
  return null;
}


// ─── findImageVariations ──────────────────────────────────────────────────────

/**
 * Download every animation frame for basePath.
 *
 * 1. Tries the bare path (static sprites have no separator).
 * 2. For each separator tries <path><sep>0, <path><sep>1, …
 *    Stops a separator as soon as a frame is missing (sequential numbering).
 *
 * @param {string}   basePath
 * @param {string}   [baseUrl]
 * @param {Object}   [options]
 * @param {number}   [options.maxVariations=999]
 * @param {string[]} [options.separators]
 * @returns {Promise<Array<{path,url,blob,variation}>>}
 */
async function findImageVariations(basePath, baseUrl, options) {
  baseUrl = baseUrl || GITHUB_PAGES_BASE_URL;
  options = options || {};

  const max        = options.maxVariations != null ? options.maxVariations : 999;
  const seps       = options.separators || SEPARATORS;
  const cleanPath  = basePath.replace(/^\/+/, '');
  const found      = [];

  // Base image (no separator)
  const base = await _fetchOne(cleanPath, baseUrl);
  if (base) found.push(Object.assign({}, base, { variation: 'base' }));

  // Numbered variations
  for (let s = 0; s < seps.length; s++) {
    const sep = seps[s];
    for (let i = 0; i < max; i++) {
      const result = await _fetchOne(cleanPath + sep + i, baseUrl);
      if (result) {
        found.push(Object.assign({}, result, { variation: sep + i }));
      } else {
        break; // gap — stop this separator
      }
    }
  }

  return found;
}


// ─── clearSpriteCache ─────────────────────────────────────────────────────────

/**
 * Fully dispose the active animator / static image handle.
 * Stops RAF loop, closes ImageBitmaps, revokes every object URL.
 * Safe to call when nothing is loaded.
 */
function clearSpriteCache() {
  if (_active) {
    _active.dispose();
    _active = null;
  }
  // Bump generation so any in-flight fetch knows it has been superseded
  _fetchGen++;
}


// ─── fetchSprite ──────────────────────────────────────────────────────────────

/**
 * Fetch all frames for spritePath, load into animator, play, return element.
 *
 * Race-condition safe: if clearSpriteCache() (or another fetchSprite()) is
 * called while this is still awaiting network, the stale result is dropped
 * and null is returned — the caller should discard it.
 *
 * @param {string} spritePath   e.g. 'ship/penguin/penguin'
 * @param {Object} [spriteParams]
 * @returns {Promise<HTMLCanvasElement | HTMLImageElement | null>}
 */
async function fetchSprite(spritePath, spriteParams) {
  spriteParams = spriteParams || {};

  // Dispose whatever was active and mark this as the current generation
  clearSpriteCache();
  const myGen = _fetchGen;

  if (!spritePath) {
    console.warn('fetchSprite: no spritePath provided');
    return null;
  }

  // ── Fetch all frames ───────────────────────────────────────────────────────
  const variations = await findImageVariations(spritePath);

  // If the user switched tabs mid-fetch, bail out without leaking anything
  if (_fetchGen !== myGen) {
    variations.forEach(function(v) { URL.revokeObjectURL(URL.createObjectURL(v.blob)); });
    return null;
  }

  if (!variations.length) {
    console.warn('fetchSprite: no images found for "' + spritePath + '"');
    return null;
  }

  // ── Single frame → plain <img> ─────────────────────────────────────────────
  if (variations.length === 1) {
    const objectUrl = URL.createObjectURL(variations[0].blob);

    // Register a disposable so clearSpriteCache revokes this URL
    _active = {
      dispose: function() { URL.revokeObjectURL(objectUrl); }
    };

    const img = document.createElement('img');
    img.src       = objectUrl;
    img.style.cssText =
      'max-width:100%;max-height:500px;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
    return img;
  }

  // ── Multiple frames → EndlessSkyAnimator on <canvas> ──────────────────────
  if (typeof window.EndlessSkyAnimator !== 'function') {
    console.error('fetchSprite: EndlessSkyAnimator not loaded');
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'max-width:100%;image-rendering:pixelated;display:block;margin:auto;';

  const anim = new window.EndlessSkyAnimator(canvas);

  // Register as active BEFORE the await so clearSpriteCache can dispose it
  // if the user switches tabs while loadVariations is running
  _active = anim;

  // loadVariations: fetches blobs → bakes bitmaps → fires es:ready internally
  // We do NOT use the es:ready event — we call play() directly after the
  // await returns, because the event fires before this line is reached.
  await anim.loadVariations(variations, spriteParams);

  // Check again: user may have switched tabs during loadVariations (bitmap baking)
  if (_fetchGen !== myGen) {
    // anim was already disposed by clearSpriteCache — nothing to do
    return null;
  }

  // Start playback
  anim.play();

  return canvas;
}


// ─── Globals ──────────────────────────────────────────────────────────────────
window.findImageVariations = findImageVariations;
window.fetchSprite         = fetchSprite;
window.clearSpriteCache    = clearSpriteCache;
