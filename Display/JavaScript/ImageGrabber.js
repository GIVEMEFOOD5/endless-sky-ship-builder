/**
 * image-fetcher.js
 *
 * Fetches all sprite frames from GitHub Pages, passes them into
 * EndlessSkyAnimator, and returns a ready <canvas> element to the caller.
 *
 * Requires endless-sky-animator.js to be loaded first.
 *
 * Public API 
 *
 *   fetchSprite(spritePath, spriteParams?)
 *     Fetches every frame for spritePath, loads them into a new animator,
 *     auto-plays, and returns the <canvas> element.
 *     → Promise<HTMLCanvasElement | null>
 *
 *   clearSpriteCache()
 *     Disposes the currently active animator and revokes all its object URLs.
 *     Call this on tab change and on modal close.
 *     → void
 *
 *   findImageVariations(basePath, baseUrl?, options?)
 *     Low-level fetch — returns all frame blobs for a sprite path.
 *     Exposed so other code can call it directly if needed.
 *     → Promise<Array<{path, url, blob, variation}>>
 *
 * spriteParams
 *   Extract from item.spriteData and pass straight through:
 *   {
 *     frameRate,    // fps  (ES default: 2)
 *     frameTime,    // game ticks (1/60 s); overrides frameRate
 *     delay,        // ticks to pause between loops
 *     startFrame,   // integer start frame
 *     randomStart,  // bool
 *     noRepeat,     // bool — stop at last frame
 *     rewind,       // bool — ping-pong
 *     scale,        // uniform scale factor
 *   }
 */

'use strict';

const GITHUB_PAGES_BASE_URL =
  'https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/data/official-game/images';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

// Separator chars that ES uses to denote animation frames
// Order matters: try + first (most common for animations), then others
const SEPARATORS = ['+', '~', '-', '^', '=', '@'];

// The one currently-active animator — disposed on tab change / modal close
let _activeAnimator = null;


// Internal helpers

function _pathToUrls(spritePath, baseUrl) {
  const base  = baseUrl.replace(/\/$/, '');
  const clean = spritePath.replace(/^\/+/, '');
  if (IMAGE_EXTENSIONS.some(ext => clean.toLowerCase().endsWith(ext))) {
    return [`${base}/${clean}`];
  }
  return IMAGE_EXTENSIONS.map(ext => `${base}/${clean}${ext}`);
}

async function _fetchOne(spritePath, baseUrl) {
  for (const url of _pathToUrls(spritePath, baseUrl)) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return { path: spritePath, url, blob: await res.blob() };
      }
    } catch (_) { /* try next extension */ }
  }
  return null;
}


//  findImageVariations 

/**
 * Fetch every animation frame for a sprite base path.
 *
 * 1. Tries the bare path first  (the "base" / only frame for static sprites).
 * 2. Then tries <path><sep>0, <path><sep>1, … for each separator in SEPARATORS,
 *    stopping at the first gap after a successful hit.
 *
 * @param {string}   basePath
 * @param {string}   [baseUrl]
 * @param {Object}   [options]
 * @param {number}   [options.maxVariations=999]
 * @param {string[]} [options.separators]
 * @returns {Promise<Array<{path, url, blob, variation}>>}
 */
async function findImageVariations(basePath, baseUrl, options) {
  baseUrl = baseUrl || GITHUB_PAGES_BASE_URL;
  options = options || {};

  const maxVariations = options.maxVariations != null ? options.maxVariations : 999;
  const separators    = options.separators || SEPARATORS;
  const cleanPath     = basePath.replace(/^\/+/, '');
  const found         = [];

  // Step 1: bare base path
  const base = await _fetchOne(cleanPath, baseUrl);
  if (base) {
    found.push({ ...base, variation: 'base' });
  }

  // Step 2: numbered variations per separator
  for (const sep of separators) {
    for (let i = 0; i < maxVariations; i++) {
      const result = await _fetchOne(`${cleanPath}${sep}${i}`, baseUrl);

      if (result) {
        found.push({ ...result, variation: `${sep}${i}` });
      } else {
        // No frame found: if we already found some for this separator, stop.
        // If i===0 we haven't found any yet — move to next separator.
        break;
      }
    }
  }

  return found;
}


// clearSpriteCache

/**
 * Dispose the active animator (stops RAF, revokes all object URLs).
 * Call on every tab change and on modal close.
 */
function clearSpriteCache() {
  if (_activeAnimator) {
    _activeAnimator.dispose();
    _activeAnimator = null;
  }
}


// fetchSprite 

/**
 * Main entry point for the UI.
 *
 * 1. Clears any existing animator.
 * 2. Fetches all frames for spritePath.
 * 3. If only one frame: returns a plain <img> element (no animation overhead).
 * 4. If multiple frames: creates an EndlessSkyAnimator on a <canvas>,
 *    loads all frames, auto-plays, stores the animator in _activeAnimator,
 *    and returns the <canvas>.
 *
 * @param {string} spritePath   e.g. 'ship/penguin/penguin'
 * @param {Object} [spriteParams]
 * @returns {Promise<HTMLCanvasElement | HTMLImageElement | null>}
 */
async function fetchSprite(spritePath, spriteParams) {
  spriteParams = spriteParams || {};

  clearSpriteCache();

  if (!spritePath) {
    console.warn('fetchSprite: no spritePath provided');
    return null;
  }

  const variations = await findImageVariations(spritePath);

  if (!variations.length) {
    console.warn(`fetchSprite: no images found for "${spritePath}"`);
    return null;
  }

  //  Single frame: just return an <img> 
  if (variations.length === 1) {
    const objectUrl = URL.createObjectURL(variations[0].blob);

    // Wrap the single object URL so clearSpriteCache still revokes it
    _activeAnimator = {
      dispose() { URL.revokeObjectURL(objectUrl); }
    };

    const img = new Image();
    img.src = objectUrl;
    img.style.cssText = 'max-width:100%;max-height:500px;object-fit:contain;image-rendering:pixelated;';
    return img;
  }

  // Multiple frames: create animator on a canvas
  if (typeof window.EndlessSkyAnimator !== 'function') {
    console.error('fetchSprite: EndlessSkyAnimator not loaded — include endless-sky-animator.js first');
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'max-width:100%;image-rendering:pixelated;';

  const anim = new window.EndlessSkyAnimator(canvas);
  _activeAnimator = anim;

  // Forward spriteData fields to the animator
  await anim.loadVariations(variations, spriteParams);

  // Auto-play once frames are ready
  canvas.addEventListener('es:ready', function() {
    anim.play();
  }, { once: true });

  // Surface load errors
  canvas.addEventListener('es:error', function(e) {
    console.warn('fetchSprite animator error:', e.detail);
  });

  return canvas;
}


//global
window.findImageVariations = findImageVariations;
window.fetchSprite         = fetchSprite;
window.clearSpriteCache    = clearSpriteCache;
