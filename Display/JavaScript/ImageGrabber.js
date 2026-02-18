/**
 * ImageGrabber.js (integrated with effects support)
 *
 * Uses the GitHub API to fetch the full repo file tree once, builds a
 * searchable filename index, then fetches exact URLs.
 * Now includes built-in effects.json support!
 *
 * Requires Animator.js (EndlessSkyAnimator) to be loaded first.
 *
 * Public API
 * ──────────
 *   initImageIndex()
 *     Fetches the repo tree and builds the index. Call once at startup.
 *     Also loads effects.json automatically.
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
 *     → void
 *
 *   findImageVariations(basePath)
 *     Low-level: returns all matching frame entries from the index.
 *     → Array<{path, url, variation}>
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

const GITHUB_REPO        = 'GIVEMEFOOD5/endless-sky-ship-builder';
const GITHUB_BRANCH      = 'main';
const IMAGES_REPO_PREFIX = 'data/official-game/images/';  // path inside repo
const GITHUB_PAGES_BASE  =
  'https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/' + IMAGES_REPO_PREFIX;
const EFFECTS_JSON_URL   = 'https://raw.githubusercontent.com/GIVEMEFOOD5/endless-sky-ship-builder/main/data/official-game/dataFiles/effects.json';

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
let _effectsData    = null;  // Array of effect objects
let _effectsMap     = null;  // Map of effect name → effect object
let _effectsLoading = null;  // Promise while loading

// Active animator / static-image disposable
let _active   = null;
let _fetchGen = 0;


// ─── Index builder ────────────────────────────────────────────────────────────

async function initImageIndex() {
  if (_index)    return;
  if (_indexing) return _indexing;

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
      console.error('ImageGrabber: failed to build index:', err);
      _index    = {};
      _indexing = null;
      return;
    }

    const imgExts = /\.(png|jpg|jpeg)$/i;
    _index = {};

    tree.forEach(function(node) {
      if (node.type !== 'blob') return;
      if (!node.path.startsWith(IMAGES_REPO_PREFIX)) return;
      if (!imgExts.test(node.path)) return;

      const rel     = node.path.slice(IMAGES_REPO_PREFIX.length);
      const noExt   = rel.replace(imgExts, '');
      const pageUrl = GITHUB_PAGES_BASE + rel;

      const sepNumMatch  = noExt.match(/^(.*?)([+~\-\^=@])(\d+)$/);
      const sepOnlyMatch = noExt.match(/^(.*?)([+~\-\^=@])$/);
      let baseKey, variation;

      if (sepNumMatch) {
        baseKey   = sepNumMatch[1];
        variation = sepNumMatch[2] + sepNumMatch[3];
      } else if (sepOnlyMatch) {
        baseKey   = sepOnlyMatch[1];
        variation = sepOnlyMatch[2];
      } else {
        baseKey   = noExt;
        variation = 'base';
      }

      if (!_index[baseKey]) _index[baseKey] = [];
      _index[baseKey].push({ fullPath: rel, url: pageUrl, variation: variation });
    });

    // Sort frames into playback order
    Object.keys(_index).forEach(function(key) {
      _index[key].sort(function(a, b) {
        if (a.variation === 'base') return -1;
        if (b.variation === 'base') return  1;

        const aIsNum = /\d/.test(a.variation);
        const bIsNum = /\d/.test(b.variation);
        if (!aIsNum &&  bIsNum) return -1;
        if ( aIsNum && !bIsNum) return  1;
        if (!aIsNum && !bIsNum) return a.variation.localeCompare(b.variation);

        const na = parseInt(a.variation.replace(/\D/g, ''), 10);
        const nb = parseInt(b.variation.replace(/\D/g, ''), 10);
        return na - nb;
      });
    });

    console.log('ImageGrabber: index built —', Object.keys(_index).length, 'sprites');
    _indexing = null;

    // Load effects.json in parallel
    await loadEffectsData();
  })();

  return _indexing;
}


// ─── Effects data loader ──────────────────────────────────────────────────────

async function loadEffectsData() {
  if (_effectsData)    return;
  if (_effectsLoading) return _effectsLoading;

  _effectsLoading = (async function() {
    try {
      const res = await fetch(EFFECTS_JSON_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);

      _effectsData = await res.json();

      _effectsMap = {};
      _effectsData.forEach(function(effect) {
        if (effect.name) _effectsMap[effect.name] = effect;
      });

      console.log('ImageGrabber: loaded', _effectsData.length, 'effects');
    } catch (err) {
      console.warn('ImageGrabber: failed to load effects.json:', err);
      _effectsData = [];
      _effectsMap  = {};
    }
    _effectsLoading = null;
  })();

  return _effectsLoading;
}


// ─── getEffect ────────────────────────────────────────────────────────────────

function getEffect(effectName) {
  if (!_effectsMap) {
    console.warn('ImageGrabber: effects not loaded — call initImageIndex() first');
    return null;
  }
  return _effectsMap[effectName] || null;
}


// ─── findImageVariations ──────────────────────────────────────────────────────

function findImageVariations(basePath) {
  if (!_index) {
    console.warn('ImageGrabber: index not ready — call initImageIndex() first');
    return [];
  }

  // Normalise: strip leading slash, extension, trailing separator+number
  let key = basePath.replace(/^\/+/, '');
  key = key.replace(/\.(png|jpg|jpeg)$/i, '');
  key = key.replace(/[+~\-\^=@]\d+$/, '');
  key = key.replace(/[+~\-\^=@]$/, '');

  // Exact match first
  const frames = _index[key];
  if (frames && frames.length) return frames;

  // Suffix search — handles cases where the data path omits leading folders
  // e.g. "penguin/penguin" matches index key "ship/penguin/penguin"
  //
  // We require the match to land on a folder boundary (preceded by '/')
  // so "burner" never accidentally matches "afterburner".
  const suffix  = '/' + key;
  const matches = Object.keys(_index).filter(function(k) {
    return k === key || k.endsWith(suffix);
  });

  if (matches.length === 1) return _index[matches[0]];
  if (matches.length  > 1) {
    // Prefer the LONGEST (most specific / most deeply nested) match.
    // e.g. given key "remnant afterburner/remnant afterburner":
    //   "effect/remnant afterburner/remnant afterburner"  ← correct (longer)
    //   "outfit/remnant afterburner"                      ← wrong   (shorter)
    matches.sort(function(a, b) { return b.length - a.length; });
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

async function fetchSprite(spritePath, spriteParams) {
  spriteParams = spriteParams || {};

  // NOTE: clearSpriteCache() is intentionally NOT called here.
  // It is called externally by switchModalTab() in Plugin_Script.js
  // before fetchSprite() is invoked. Calling it here would cancel
  // any concurrent fetch and cause stale content to remain visible.
  const myGen = _fetchGen;

  if (!spritePath) {
    console.warn('fetchSprite: no spritePath provided');
    return null;
  }

  // Ensure index and effects are ready
  await initImageIndex();
  if (_fetchGen !== myGen) return null;

  // ── Step 0: Check if this is an effect name in effects.json ──────────────
  // This bypasses the suffix search which can match the wrong path when
  // multiple index keys share the same ending (e.g. thumbnail vs effect).
  if (typeof window.fetchEffectByName === 'function') {
    const effectResult = await window.fetchEffectByName(spritePath, spriteParams);
    if (effectResult !== null) {
      console.log('fetchSprite: resolved via EffectGrabber');
      return effectResult;
    }
    // Not an effect name or effect not found — continue to normal image lookup
  }

  // ── Step 1: Try direct image index lookup ─────────────────────────────────
  let frames = findImageVariations(spritePath);

  // ── Step 2: Not found — check effects.json by name ───────────────────────
  if (!frames.length) {
    console.log('fetchSprite: "' + spritePath + '" not in image index, checking effects.json...');

    const effect = getEffect(spritePath);

    if (effect && effect.sprite) {
      console.log('fetchSprite: found effect "' + spritePath + '" → sprite: "' + effect.sprite + '"');

      frames = findImageVariations(effect.sprite);

      if (frames.length) {
        // Use the effect's own spriteData unless the caller supplied params
        if (!spriteParams || Object.keys(spriteParams).length === 0) {
          spriteParams = effect.spriteData || {};
        }
      } else {
        console.warn('fetchSprite: effect sprite "' + effect.sprite + '" not found in image index');
        return null;
      }

    // ── Step 3: Not in effects.json — try prepending "effect/" ───────────
    } else {
      const withPrefix = 'effect/' + spritePath;
      console.log('fetchSprite: not in effects.json, trying "' + withPrefix + '"...');
      frames = findImageVariations(withPrefix);

      if (!frames.length) {
        console.warn('fetchSprite: "' + spritePath + '" not found anywhere');
        return null;
      }
      console.log('fetchSprite: found as "' + withPrefix + '"');
    }
  }

  // ── Fetch all frame blobs in parallel ─────────────────────────────────────
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
    console.warn('fetchSprite: all frame fetches failed for "' + spritePath + '"');
    return null;
  }

  // ── Single frame → plain <img> ────────────────────────────────────────────
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

// Wrapper kept for backward compatibility — fetchSprite now handles everything.
async function fetchEffectSprite(effectNameOrPath, spriteParams) {
  if (!effectNameOrPath) {
    console.warn('fetchEffectSprite: no path provided');
    return null;
  }
  await initImageIndex();
  return await fetchSprite(effectNameOrPath, spriteParams);
}


// ─── fetchOutfitEffects ───────────────────────────────────────────────────────

async function fetchOutfitEffects(outfit) {
  if (!outfit) return {};

  const results = {};

  if (outfit['flare sprite']) {
    try {
      const sprite = await fetchEffectSprite(outfit['flare sprite'], outfit.spriteData);
      if (sprite) results.flareSprite = sprite;
    } catch (err) { console.error('fetchOutfitEffects: flare sprite failed:', err); }
  }

  if (outfit['steering flare sprite']) {
    try {
      const sprite = await fetchEffectSprite(outfit['steering flare sprite'], outfit.spriteData);
      if (sprite) results.steeringFlareSprite = sprite;
    } catch (err) { console.error('fetchOutfitEffects: steering flare failed:', err); }
  }

  if (outfit['reverse flare sprite']) {
    try {
      const sprite = await fetchEffectSprite(outfit['reverse flare sprite'], outfit.spriteData);
      if (sprite) results.reverseFlareSprite = sprite;
    } catch (err) { console.error('fetchOutfitEffects: reverse flare failed:', err); }
  }

  if (outfit['afterburner effect']) {
    try {
      const sprite = await fetchEffectSprite(outfit['afterburner effect']);
      if (sprite) results.afterburnerEffect = sprite;
    } catch (err) { console.error('fetchOutfitEffects: afterburner effect failed:', err); }
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
