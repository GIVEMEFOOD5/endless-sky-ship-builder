'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  builderExtras.js — undo for the ship builder, and "Edit in builder" from
//  the save editor
//
//  Undo: every click or edit inside the builder that changes the ship is
//  remembered (up to 40 steps). ↶ Undo in the header or Ctrl+Z (when not
//  typing in a box) steps back. Switching to another ship starts afresh.
//
//  Open from a save: the save editor stores the ship's uuid in
//  ES_SB_OPEN_SAVE_SHIP and opens this page; once the save's ships are
//  loaded (ES_SM_ACTIVE_SAVE_SHIPS), that ship opens for editing.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const MAX = 40;
  let stack = [], current = null;
  const cur = () => (typeof sbCurrentShip !== 'undefined' ? sbCurrentShip : null);
  const btn = () => document.getElementById('sb-undo-btn');
  const refresh = () => { const b = btn(); if (b) { b.disabled = !stack.length; b.textContent = stack.length ? `↶ Undo (${stack.length})` : '↶ Undo'; } };
  function track() {
    const s = cur();
    if (s !== current) { current = s; stack = []; refresh(); }
  }

  /** Remember the ship as it is now (call before changing it from code). */
  function snapshot() {
    track();
    const s = cur(); if (!s) return;
    const json = JSON.stringify(s);
    if (stack[stack.length - 1] !== json) { stack.push(json); if (stack.length > MAX) stack.shift(); }
    refresh();
  }

  function undo() {
    track();
    if (!stack.length || typeof sbCurrentShip === 'undefined') return;
    const prev = JSON.parse(stack.pop());
    // restore in place so other code holding the object keeps working
    for (const k of Object.keys(sbCurrentShip)) delete sbCurrentShip[k];
    Object.assign(sbCurrentShip, prev);
    if (typeof sbPopulateBuilder === 'function') sbPopulateBuilder();
    refresh();
    if (typeof sbToast === 'function') sbToast('Undone.', 'success');
  }

  // Watch changes made by clicks/edits inside the builder.
  function watch() {
    const view = document.getElementById('builder-view');
    if (!view) return;
    let before = null;
    const start = () => { track(); const s = cur(); before = s ? JSON.stringify(s) : null; };
    const finish = () => {
      setTimeout(() => {
        if (typeof onBuilderChange === 'function' && document.activeElement && view.contains(document.activeElement)) { /* form edits sync on change */ }
        const s = cur();
        if (!s || before === null) return;
        const after = JSON.stringify(s);
        if (after !== before && s === current) { stack.push(before); if (stack.length > MAX) stack.shift(); refresh(); }
        before = null;
      }, 0);
    };
    view.addEventListener('pointerdown', start, true);
    view.addEventListener('focusin', start, true);
    view.addEventListener('click', finish, true);
    view.addEventListener('change', finish, true);
    // outfit picker and other pop-ups live outside the view
    document.addEventListener('click', e => {
      if (e.target.closest('#modal-sb-outfit-picker .sb-picker-row')) { start(); finish(); }
    }, true);
    document.addEventListener('keydown', e => {
      if (view.classList.contains('hidden')) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing && stack.length) { e.preventDefault(); undo(); }
    });
  }

  // Opened from the save editor's "Edit in builder"
  function openFromSave() {
    let uuid = null;
    try { uuid = localStorage.getItem('ES_SB_OPEN_SAVE_SHIP'); } catch (_) {}
    if (!uuid) return;
    const tryOpen = () => {
      if (typeof sbSaveFleet === 'undefined' || typeof sbEditSaveShip !== 'function') return false;
      const i = sbSaveFleet.findIndex(s => s._uuid === uuid);
      if (i === -1) return false;
      try { localStorage.removeItem('ES_SB_OPEN_SAVE_SHIP'); } catch (_) {}
      sbEditSaveShip(i);
      if (typeof sbToast === 'function') sbToast('Opened from your save — use ➜ Put in a save to send it back.', 'success');
      return true;
    };
    if (tryOpen()) return;
    if (window.DataLoader) window.DataLoader.onReady(() => setTimeout(tryOpen, 50));
  }

  document.addEventListener('DOMContentLoaded', () => { watch(); setTimeout(openFromSave, 0); });
  window.BuilderExtras = { undo, snapshot };
})();
