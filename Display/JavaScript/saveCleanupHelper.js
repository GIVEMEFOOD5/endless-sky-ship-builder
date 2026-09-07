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
//  ── What "remove an individual mission" means, precisely ────────────
//  Confirmed against a real save: for every currently-held mission, its
//  "<name>: active" and "<name>: offered" conditions sit as ADJACENT
//  lines in the conditions block (in that order). That confirmed the
//  mechanism, but removal isn't limited to held missions — it strips
//  every trace of a mission regardless of its current status: the held
//  `mission` block if it has one, an `"available job"` entry if it has
//  one instead, and every condition key that exists for that name
//  (offered/active/done/failed/declined). A mission that's already
//  resolved (done or failed, no longer held) only has condition
//  entries left — removing just active/offered wouldn't touch those,
//  so all five get checked and cleared, whichever are actually present.
//
//  ── What "complete a mission" means, precisely ───────────────────────
//  Different from removal: this simulates the mission actually
//  finishing successfully, not un-happening. Confirmed against a real
//  save (a repeatable mission completed 14 times, failed 2, with no
//  "active" key left over at all): completion DECREMENTS "active" by
//  1 (deleting the key entirely if that reaches 0, since Endless Sky
//  never writes "active" as a literal 0) and INCREMENTS "done" by 1 —
//  it does NOT touch "offered", which is cumulative history. Rewards
//  (money, outfits) are taken from the mission's `onComplete`-triggered
//  grants specifically — confirmed against real plugin data that
//  `grantedIn` uses exactly that string, alongside onOffer/onAccept/
//  onVisit/etc. for the OTHER trigger points this deliberately ignores,
//  since those would have already applied when the mission was offered/
//  accepted, not now.
//  Ship rewards are NOT added to the save's ship list — doing that
//  properly needs the ship's full stat/outfit data, which this page
//  doesn't load (that lives in dataLoader.js's ship catalog, a
//  different page entirely). completeMission() reports them back
//  instead of silently fabricating an incomplete ship entry.
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
//    .removeMission(name)           → erase a held mission entirely
//    .completeMission(name, rewards) → simulate completion + apply rewards
//                                       rewards: { credits, outfits:[{name,count}],
//                                                  ships:[{name,count}] } — caller
//                                       (the display layer, which has the plugin
//                                       catalog) builds this from the mission's
//                                       own onComplete-triggered payment/rewards.
//                                       Returns { save, unappliedShips }.
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

// ── Mission removal ───────────────────────────────────────────
// Strips a mission out of the save entirely, whatever state it's
// currently in — not just currently-held ones:
//   - a held `mission` block, if it has one
//   - an `"available job"` entry, if it has one instead
//   - EVERY condition key for that name — offered/active/done/failed/
//     declined, whichever exist. A resolved mission (done or failed,
//     no longer held) only has condition entries, no data block, so
//     removing just "active"/"offered" alone wouldn't touch it — this
//     covers a mission at any point in its lifecycle, not only the
//     "just accepted" case the offered/active pairing was confirmed
//     against.
function _pullMissionBlock(save, name) {
  const idx = (save.missions || []).findIndex(m => m.name === name);
  if (idx === -1) return null;
  const [removed] = save.missions.splice(idx, 1);
  if (save.blocks && Array.isArray(save.blocks.mission)) save.blocks.mission = save.missions;
  return removed;
}

function _pullAvailableJob(save, name) {
  const idx = (save.availableJobs || []).findIndex(m => m.name === name);
  if (idx === -1) return null;
  const [removed] = save.availableJobs.splice(idx, 1);
  if (save.blocks && Array.isArray(save.blocks['available job'])) save.blocks['available job'] = save.availableJobs;
  return removed;
}

function removeMission(name) {
  const save = getUpdatedSave();
  if (!save) return null;
  _pullMissionBlock(save, name);
  _pullAvailableJob(save, name);
  for (const suffix of ['offered', 'active', 'done', 'failed', 'declined']) {
    delete save.pilot.conditions[`${name}: ${suffix}`];
  }
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

// ── Mission completion ───────────────────────────────────────
// Simulates finishing a currently-held mission successfully: removes
// its held block, decrements "active" (deleting the key at 0, never
// writing a literal 0 — matches confirmed real-save behaviour),
// increments "done", and applies whatever rewards the caller computed
// from the mission's onComplete-triggered payment/outfit/ship grants.
//
// `rewards` shape: { credits: number, outfits: [{name, count}], ships: [{name, count}] }
// Ship rewards are reported back in `unappliedShips`, not written to
// save.ships — see the header note on why.
function completeMission(name, rewards) {
  const save = getUpdatedSave();
  if (!save) return null;
  rewards = rewards || {};

  const held = _pullMissionBlock(save, name);
  if (!held) return { save, unappliedShips: [], appliedToHeldMission: false };

  const activeKey = `${name}: active`;
  const currentActive = save.pilot.conditions[activeKey];
  const nextActive = (typeof currentActive === 'number' ? currentActive : (currentActive ? 1 : 0)) - 1;
  if (nextActive > 0) save.pilot.conditions[activeKey] = nextActive;
  else delete save.pilot.conditions[activeKey];

  const doneKey = `${name}: done`;
  const currentDone = save.pilot.conditions[doneKey];
  save.pilot.conditions[doneKey] = (typeof currentDone === 'number' ? currentDone : (currentDone ? 1 : 0)) + 1;

  if (rewards.credits) {
    save.account = save.account || { credits: 0, score: 0, salaries: {}, history: [] };
    save.account.credits = (save.account.credits || 0) + rewards.credits;
  }

  for (const o of (rewards.outfits || [])) {
    if (!o || !o.name) continue;
    save.cargo = save.cargo || { outfits: {}, commodities: {} };
    save.cargo.outfits = save.cargo.outfits || {};
    save.cargo.outfits[o.name] = (save.cargo.outfits[o.name] || 0) + (o.count || 1);
  }

  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return { save, unappliedShips: rewards.ships || [], appliedToHeldMission: true };
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
  removeMission,
  completeMission,
};

})();
