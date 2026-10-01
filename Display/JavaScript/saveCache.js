'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  saveCache.js — parsed saves that never need re-uploading
//
//  The pages read each save's parsed JSON from localStorage
//  (ES_SM_SAVE_<id>). Big saves don't fit there (localStorage is ~5 MB per
//  site), and the write used to fail silently — so after a reload the save
//  looked "gone" and had to be uploaded again.
//
//  The original .txt is always kept in IndexedDB by saveVault.js, so this
//  rebuilds the parsed JSON from it whenever localStorage doesn't have it,
//  and keeps it in memory for the page. Pages call EsSaveCache.get(id)
//  instead of failing; 'esSaveCacheReady' fires once the preload is done.
//
//  Needs esSaveParser.js (parseESSaveFile) and saveVault.js.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const mem = new Map();
  const readJSON = k => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (_) { return null; } };

  function get(id) { return id ? (mem.get(id) || null) : null; }
  function set(id, parsed) { if (id && parsed) mem.set(id, parsed); }
  function drop(id) { mem.delete(id); }

  /** Parsed save for `id`: localStorage, then memory, then rebuilt from the stored text. */
  async function ensure(id) {
    if (!id) return null;
    const stored = readJSON('ES_SM_SAVE_' + id);
    if (stored) return stored;
    if (mem.has(id)) return mem.get(id);
    if (!window.SaveVault || typeof parseESSaveFile !== 'function') return null;
    const text = await window.SaveVault.text(id).catch(() => null);
    if (!text) return null;
    const parsed = parseESSaveFile(text);
    mem.set(id, parsed);
    // try to store it again — it may fit now that other saves were removed
    try { localStorage.setItem('ES_SM_SAVE_' + id, JSON.stringify(parsed)); } catch (_) { /* stays in memory */ }
    return parsed;
  }

  const ready = (async () => {
    const reg = readJSON('ES_SM_REGISTRY') || [];
    const current = readJSON('ES_SM_CURRENT');
    // the open save first, so it's usable as soon as possible
    const ids = [...new Set([current, ...reg.map(r => r.id)].filter(Boolean))];
    for (const id of ids) { try { await ensure(id); } catch (e) { console.warn('[EsSaveCache]', id, e); } }
    document.dispatchEvent(new CustomEvent('esSaveCacheReady'));
  })();

  window.EsSaveCache = { get, set, drop, ensure, ready };
})();
