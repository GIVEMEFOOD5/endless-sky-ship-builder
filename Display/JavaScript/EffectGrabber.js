/**
 * EffectGrabber.js
 *
 * Resolves effect names to their exact sprite paths from effects.json,
 * then fetches them via ImageGrabber.js.
 *
 * Why this exists:
 *   ImageGrabber's suffix search can find 2 matches for a path like
 *   "remnant afterburner/remnant afterburner" — one in effect/ and one
 *   in outfit/ — and pick the wrong one. By looking up the effect name
 *   in effects.json first, we get the EXACT sprite path and pass it
 *   directly to fetchSprite(), bypassing the ambiguous suffix search.
 *
 * Requires ImageGrabber.js to be loaded first.
 *
 * Public API
 * ──────────
 *   fetchEffectByName(effectName, spriteParams?)
 *     Looks up effectName in effects.json, gets the exact sprite path,
 *     passes it directly to fetchSprite().
 *     → Promise<HTMLCanvasElement | HTMLImageElement | null>
 */

'use strict';

const EFFECTS_URL = 'https://raw.githubusercontent.com/GIVEMEFOOD5/endless-sky-ship-builder/main/data/official-game/dataFiles/effects.json';

let _effectsMap  = null;
let _loading     = null;

// ─── Loader ───────────────────────────────────────────────────────────────────

async function _loadEffects() {
    if (_effectsMap)  return;
    if (_loading)     return _loading;

    _loading = (async function () {
        try {
            const res = await fetch(EFFECTS_URL);
            if (!res.ok) throw new Error('HTTP ' + res.status);

            const effects = await res.json();
            _effectsMap = {};
            effects.forEach(function (e) {
                if (e.name) _effectsMap[e.name] = e;
            });

            console.log('EffectGrabber: loaded', effects.length, 'effects');
        } catch (err) {
            console.warn('EffectGrabber: failed to load effects.json:', err);
            _effectsMap = {};
        }
        _loading = null;
    })();

    return _loading;
}

// ─── fetchEffectByName ────────────────────────────────────────────────────────

async function fetchEffectByName(effectName, spriteParams) {
    if (!effectName) {
        console.warn('EffectGrabber: no effectName provided');
        return null;
    }

    await _loadEffects();

    const effect = _effectsMap[effectName];

    // Silently return null if not found — caller will try other methods
    if (!effect || !effect.sprite) {
        return null;
    }

    // Use effect's own spriteData unless caller supplied params
    const params = (spriteParams && Object.keys(spriteParams).length > 0)
        ? spriteParams
        : (effect.spriteData || {});

    console.log('EffectGrabber: "' + effectName + '" → "' + effect.sprite + '"');

    // Pass EXACT path directly — no suffix search ambiguity
    return await window.fetchSprite(effect.sprite, params);
}

// ─── Globals ──────────────────────────────────────────────────────────────────

window.fetchEffectByName = fetchEffectByName;
