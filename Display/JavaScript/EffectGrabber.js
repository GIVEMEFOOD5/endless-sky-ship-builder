/**
 * effect-fetcher.js
 *
 * Loads effects.json and provides lookup/display functionality for effects
 * referenced in outfits (flare sprite, afterburner effect, etc.)
 *
 * Requires image-fetcher.js to be loaded first.
 *
 * Public API
 * ──────────
 *   initEffectsData()
 *     Loads the effects.json file. Call once at startup.
 *     Safe to call multiple times — only fetches once.
 *     → Promise<void>
 *
 *   getEffect(effectName)
 *     Looks up an effect by name in the loaded effects data.
 *     → Object | null
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
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

const EFFECTS_JSON_URL = 'data/official-game/data/official-game/dataFiles/effects.json';

// ─── Module state ─────────────────────────────────────────────────────────────

let _effectsData = null;  // Array of effect objects
let _effectsMap = null;   // Map of effect name → effect object
let _loading = null;      // Promise while loading

// ─── Data loader ──────────────────────────────────────────────────────────────

/**
 * Load effects.json and build the lookup map.
 */
async function initEffectsData() {
  if (_effectsData) return;       // already loaded
  if (_loading) return _loading;  // already in progress

  _loading = (async function() {
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
      
      console.log('effect-fetcher: loaded', _effectsData.length, 'effects');
    } catch (err) {
      console.error('effect-fetcher: failed to load effects.json:', err);
      _effectsData = [];
      _effectsMap = {};
    }
    _loading = null;
  })();

  return _loading;
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
    console.warn('effect-fetcher: effects not loaded — call initEffectsData() first');
    return null;
  }
  return _effectsMap[effectName] || null;
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
    console.warn('effect-fetcher: no effectNameOrPath provided');
    return null;
  }

  // Ensure effects data is loaded
  await initEffectsData();

  // Try to find effect by name
  const effect = getEffect(effectNameOrPath);
  
  if (effect) {
    // Found effect definition - use its sprite and spriteData
    if (!effect.sprite) {
      console.warn('effect-fetcher: effect "' + effectNameOrPath + '" has no sprite');
      return null;
    }
    
    // Use provided spriteParams, or fall back to effect's spriteData
    const params = spriteParams || effect.spriteData || {};
    
    console.log('effect-fetcher: fetching sprite for effect "' + effect.name + '"');
    return await window.fetchSprite(effect.sprite, params);
  } else {
    // Not found in effects.json - treat as direct sprite path
    console.log('effect-fetcher: "' + effectNameOrPath + '" not in effects.json, trying as sprite path');
    return await window.fetchSprite(effectNameOrPath, spriteParams);
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
      console.error('effect-fetcher: failed to fetch flare sprite:', err);
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
      console.error('effect-fetcher: failed to fetch steering flare sprite:', err);
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
      console.error('effect-fetcher: failed to fetch reverse flare sprite:', err);
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
      console.error('effect-fetcher: failed to fetch afterburner effect:', err);
    }
  }

  return results;
}

// ─── Globals ──────────────────────────────────────────────────────────────────

window.initEffectsData = initEffectsData;
window.getEffect = getEffect;
window.fetchEffectSprite = fetchEffectSprite;
window.fetchOutfitEffects = fetchOutfitEffects;
