'use strict';

// ═══════════════════════════════════════════════════════════
//  saveCleanupHelper.js
//
//  A second "helper" alongside missionStatusHelper.js — but where that
//  one is read-only (answers questions about a save, never changes it),
//  this one mutates. To keep those two concerns from tangling, edits
//  never touch the save saveManager.js imported. Instead, everything
//  here operates on a separate localStorage entry — the "Updated Save"
//  — which starts as a copy of the current save and is what actually
//  gets modified. The original stays exactly as imported, forever.
//
//  ── What "remove failed mission lines" means, precisely ────────────
//  Endless Sky records a mission's resolved outcome as a condition
//  named "<mission name>: failed" in the save's top-level `conditions`
//  block. That block is exactly what esSaveParser.js already isolates
//  into `save.pilot.conditions` — confirmed against a real save that
//  this is NOT the same as the string "<name>: failed" appearing
//  elsewhere, e.g. inside another mission's OWN `to fail` trigger
//  (checking whether a different mission failed, as part of that
//  mission's live logic) — those live inside a mission's `raw` tree,
//  never in `pilot.conditions`, so operating only on
//  `pilot.conditions` already can't accidentally touch them.
//  "Removing" a failed-mission line means deleting that one condition
//  key from the Updated Save's `pilot.conditions`.
//
//  ── What "events if they have been triggered" means, precisely ─────
//  A save's `event` block(s) (see esSaveParser.js's GENERIC BLOCK
//  CAPTURE note) describe a scheduled world-state change with a `date`
//  child — e.g. `event \n date 17 2 3027 \n ...`. Comparing that date
//  against the pilot's own current date (`save.pilot.date`, same
//  `DD MM YYYY` format) tells you whether the event's date has already
//  passed. Endless Sky is supposed to apply and clear an event once
//  its date arrives; one still sitting in the save with a past date is
//  exactly the "triggered but not cleaned up" case this exists for.
//  Events with a FUTURE date are left alone — they haven't happened
//  yet, removing them would silently cancel something still pending.
//
//  Public API on window.SaveCleanupHelper:
//    .getUpdatedSave()          → the working copy, or null if no save is loaded
//    .resetUpdatedSave()        → discard edits, recopy from the current save
//    .listFailedConditions()    → [{ key, name, count }]
//    .listTriggeredEvents()     → [{ index, dateText, raw }]
//    .removeFailedCondition(name)   → remove one, returns updated save
//    .removeAllFailedConditions()   → remove every one currently listed
//    .removeTriggeredEvent(index)   → remove one, returns updated save
//    .removeAllTriggeredEvents()    → remove every one currently listed
// ═══════════════════════════════════════════════════════════

(function () {

// Same keys saveManager.js writes to — see that file's own header comment.
const SM_CURRENT_KEY = 'ES_SM_CURRENT';
const SM_SAVE_PREFIX  = 'ES_SM_SAVE_';
// New key this file owns. Singular/current, not per-save-id, mirroring
// how ES_SM_ACTIVE_SAVE_SHIPS already tracks "a derived working copy for
// whichever save is current" rather than one per save ever imported.
const SM_UPDATED_SAVE_KEY = 'ES_SM_UPDATED_SAVE';

function _readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[saveCleanupHelper] Could not read', key, e);
    return null;
  }
}
function _writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('[saveCleanupHelper] Could not write', key, e);
    return false;
  }
}

function _getOriginalSave() {
  const id = _readJSON(SM_CURRENT_KEY);
  return id ? _readJSON(SM_SAVE_PREFIX + id) : null;
}

// Returns the Updated Save, creating it from the current original save
// on first use. Returns null only if there's no save loaded at all.
function getUpdatedSave() {
  let updated = _readJSON(SM_UPDATED_SAVE_KEY);
  if (updated) return updated;

  const original = _getOriginalSave();
  if (!original) return null;

  updated = JSON.parse(JSON.stringify(original)); // deep copy — never share references with the original
  _writeJSON(SM_UPDATED_SAVE_KEY, updated);
  return updated;
}

function resetUpdatedSave() {
  const original = _getOriginalSave();
  if (!original) return null;
  const fresh = JSON.parse(JSON.stringify(original));
  _writeJSON(SM_UPDATED_SAVE_KEY, fresh);
  return fresh;
}

// ── Failed-condition listing/removal ─────────────────────────
function listFailedConditions(save) {
  save = save || getUpdatedSave();
  if (!save || !save.pilot || !save.pilot.conditions) return [];
  const out = [];
  for (const [key, value] of Object.entries(save.pilot.conditions)) {
    const m = key.match(/^(.*): failed$/);
    if (!m) continue;
    out.push({ key, name: m[1], count: typeof value === 'number' ? value : 1 });
  }
  return out;
}

function removeFailedCondition(name) {
  const save = getUpdatedSave();
  if (!save) return null;
  delete save.pilot.conditions[`${name}: failed`];
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

function removeAllFailedConditions() {
  const save = getUpdatedSave();
  if (!save) return null;
  for (const { key } of listFailedConditions(save)) delete save.pilot.conditions[key];
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

// ── Triggered-event listing/removal ──────────────────────────
// Parses a `DD MM YYYY` string (pilot.date's format) into a comparable
// [year, month, day] tuple. Returns null if it doesn't look like that.
function _parseDate(str) {
  if (!str) return null;
  const parts = String(str).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [day, month, year] = parts;
  return [year, month, day];
}

function _dateLTE(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true; // exactly equal counts as "has arrived"
}

// An event block's own date lives as a `date` entry among its raw
// children (see esSaveParser.js's _esBuildRawTree) — values are numbers
// there already, not a string, since the whole line was numeric tokens.
function _eventDateTuple(eventEntry) {
  const dateNode = (eventEntry.raw || []).find(n => n.key === 'date');
  if (!dateNode || dateNode.values.length !== 3) return null;
  const [day, month, year] = dateNode.values;
  return [year, month, day];
}

function listTriggeredEvents(save) {
  save = save || getUpdatedSave();
  if (!save) return [];
  const pilotDate = _parseDate(save.pilot && save.pilot.date);
  const events = save.events || (save.blocks && save.blocks.event) || [];
  if (!pilotDate) return []; // can't compare against an unknown current date

  const out = [];
  events.forEach((ev, index) => {
    const eventDate = _eventDateTuple(ev);
    // No date at all → can't tell if it's triggered; leave it alone
    // rather than guessing.
    if (eventDate && _dateLTE(eventDate, pilotDate)) {
      out.push({
        index,
        dateText: `${eventDate[2]}/${eventDate[1]}/${eventDate[0]}`,
        raw: ev.raw,
      });
    }
  });
  return out;
}

function removeTriggeredEvent(index) {
  const save = getUpdatedSave();
  if (!save || !Array.isArray(save.events)) return null;
  save.events.splice(index, 1);
  // Keep blocks.event (the source of truth `events` was aliased from) in
  // sync too, so nothing reading that field directly sees a stale entry.
  if (save.blocks && Array.isArray(save.blocks.event)) save.blocks.event = save.events;
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

function removeAllTriggeredEvents() {
  const save = getUpdatedSave();
  if (!save) return null;
  // Remove by index from the end so earlier indices in the list we're
  // iterating don't shift out from under us.
  const indices = listTriggeredEvents(save).map(e => e.index).sort((a, b) => b - a);
  for (const i of indices) save.events.splice(i, 1);
  if (save.blocks && Array.isArray(save.blocks.event)) save.blocks.event = save.events;
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

window.SaveCleanupHelper = {
  getUpdatedSave,
  resetUpdatedSave,
  listFailedConditions,
  listTriggeredEvents,
  removeFailedCondition,
  removeAllFailedConditions,
  removeTriggeredEvent,
  removeAllTriggeredEvents,
};

})();