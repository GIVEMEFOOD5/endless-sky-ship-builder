'use strict';

// ═══════════════════════════════════════════════════════════
//  missionStatusHelper.js
//
//  The "helper" in loader → display → helper: takes data the loader
//  already fetched/formatted and data the save-file tooling already
//  parsed, and manipulates/combines them — it doesn't fetch or render
//  anything itself.
//
//  Reads a parsed Endless Sky save (as produced by esSaveParser.js and
//  stored by saveManager.js) directly from localStorage — no dependency
//  on saveManager.js or esSaveParser.js actually being loaded on the
//  page, since the save is already plain JSON by the time it's in
//  localStorage. Cross-references it against a mission's internal name
//  to answer: is this mission currently active, available-but-not-
//  accepted, completed, failed, declined, or never encountered — and,
//  for repeatable missions with a mixed history, says so honestly
//  instead of picking one outcome to report.
//
//  ── Why this isn't a naive done/failed binary ──────────────────────
//  Confirmed against a real save file (not assumed):
//    - `mission "X"` blocks and `"available job" "X"` blocks are TWO
//      SEPARATE keywords. A mission sitting in `mission` is genuinely
//      held (it carries a uuid, and if it had NPCs/on-enter triggers
//      set up when accepted, those are serialised too). A mission
//      sitting in `"available job"` merely passed its `to offer` roll
//      and is waiting on the job board — never accepted. There's no
//      ambiguity between these two once you use the right keyword.
//    - `"<name>: active"` is a COUNTER, not a boolean — incremented on
//      accept, decremented on complete/fail — and a real save was found
//      where a repeatable mission had BOTH `done: 14` and `failed: 2`
//      with no current `active`/held/available state at all. Reporting
//      that as just "failed" (or just "done") would be actively wrong.
//      So every status result carries the full counts, and `mixed` is
//      its own explicit status rather than a coin-flip between two.
//    - "Failed" doesn't always mean the player did something wrong —
//      some missions can structurally only ever resolve via `to fail`
//      (a literal always-false `to complete`). `unreachableCompletePath`
//      flags that narrow, confirmed-real pattern — see
//      hasUnreachableCompletePath() below for exactly what it does and
//      doesn't catch.
//
//  Public API on window.MissionStatusHelper:
//    .STATUS                        → the status string constants
//    .getCurrentSave()              → parsed save object, or null
//    .listSaves()                   → [{ id, label, pilotName, importedAt }]
//    .getSaveById(id)               → parsed save object, or null
//    .getMissionStatus(name, save?) → status object for ONE mission name
//    .getAllStatuses(save?)         → Map<name, statusObject> for every
//                                      name the save has ANY record of
//                                      (held, available, or in conditions)
//    .decorateMissions(missions, save?)
//                                    → given MissionLoader.getAllMissions()
//                                      output (or any array of objects with
//                                      a `.name`), returns the same array
//                                      with `.status` attached to each
//    .hasUnreachableCompletePath(rawEntries)
//                                    → pure utility, see the note above
// ═══════════════════════════════════════════════════════════

(function () {

// Same keys saveManager.js writes to — see that file's own header comment.
// Read directly rather than depending on saveManager.js being loaded,
// since by the time a save is in localStorage it's already plain JSON.
const SM_REGISTRY_KEY = 'ES_SM_REGISTRY';
const SM_SAVE_PREFIX  = 'ES_SM_SAVE_';
const SM_CURRENT_KEY  = 'ES_SM_CURRENT';

const STATUS = {
  IN_PROGRESS:     'in_progress',
  AVAILABLE:       'available_not_accepted',
  DONE:            'completed_successfully',
  FAILED:          'completed_unsuccessfully',
  DECLINED:        'declined',
  MIXED:           'mixed',
  OFFERED_ONLY:    'offered_only',
  NOT_ENCOUNTERED: 'not_encountered',
};

// ── "Failure may be the only real path" detector ────────────────
//
// A narrow, specific pattern confirmed against a real save: a mission
// whose `to complete` trigger is a literal always-false condition (a
// single child that's just the bare number 0, no values) while a real
// `to fail` trigger exists. Structurally, such a mission can ONLY ever
// resolve through `to fail` — so a "Failed" status on one of these may
// be its designed resolution path, not a genuine failure.
//
// This is deliberately narrow. It catches exactly the one pattern
// that's actually been confirmed in real data, nothing broader —
// tested against the full plugin catalog and it does NOT generalise
// to "any unreachable to-complete" (a mission could just as easily
// rely on an explicit `complete` action fired from a conversation,
// which looks completely different and isn't detectable this way).
// So: the ABSENCE of this flag does not mean a failure was genuine —
// it only means this specific pattern wasn't the cause. Always treat
// it as "worth a second look", never as a verdict.
function hasUnreachableCompletePath(rawEntries) {
  if (!Array.isArray(rawEntries)) return false;
  const toComplete = rawEntries.find(e => e.key === 'to complete');
  const toFail     = rawEntries.find(e => e.key === 'to fail');
  if (!toComplete || !toFail) return false;

  const kids = toComplete.children;
  const looksAlwaysFalse = Array.isArray(kids) && kids.length === 1 &&
      kids[0].key === '0' && (!kids[0].values || kids[0].values.length === 0);
  if (!looksAlwaysFalse) return false;

  // `to fail` needs to actually say something — not itself be an
  // equally-trivial placeholder.
  return !!((toFail.children && toFail.children.length) || (toFail.values && toFail.values.length));
}

// ── Save-file access ─────────────────────────────────────────
function _readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[missionStatusHelper] Could not read', key, e);
    return null;
  }
}

function listSaves() {
  return _readJSON(SM_REGISTRY_KEY) || [];
}

function getSaveById(id) {
  if (!id) return null;
  return _readJSON(SM_SAVE_PREFIX + id);
}

function getCurrentSave() {
  const id = _readJSON(SM_CURRENT_KEY);
  return id ? getSaveById(id) : null;
}

// ── Core status logic ────────────────────────────────────────
//
// Priority when a mission has BOTH a live state (held/available) AND
// leftover history from earlier cycles (a repeatable mission done or
// failed before): the live state wins for `status`, but the historical
// counts are never dropped — they're always in `counts`, and folded
// into `label` as a parenthetical so a repeatable mission's full story
// doesn't disappear just because it's active again.
function getMissionStatus(name, save) {
  save = save === undefined ? getCurrentSave() : save;

  const counts = { offered: 0, active: 0, done: 0, failed: 0, declined: 0 };
  if (save && save.pilot && save.pilot.conditions) {
    const c = save.pilot.conditions;
    for (const key of Object.keys(counts)) {
      const v = c[`${name}: ${key}`];
      // Conditions are stored as `true` when the save just has the bare
      // condition name with no trailing number (count of 1, effectively),
      // or a number when it does.
      counts[key] = typeof v === 'number' ? v : (v ? 1 : 0);
    }
  }

  const isHeld      = !!(save && Array.isArray(save.missions)     && save.missions.some(m => m.name === name));
  const isAvailable = !!(save && Array.isArray(save.availableJobs) && save.availableJobs.some(m => m.name === name));

  // Checked here ONLY against the save's own copy of a currently-held
  // mission (the live, most-trustworthy source). For missions that have
  // already resolved (not held), decorateMissions() layers an
  // additional check against the plugin catalog's static definition,
  // since the save no longer carries that mission's structure once it's
  // no longer active.
  let unreachableCompletePath = false;
  if (isHeld) {
    const heldEntry = save.missions.find(m => m.name === name);
    if (heldEntry) unreachableCompletePath = hasUnreachableCompletePath(heldEntry.raw);
  }

  const resolutionTypes = ['done', 'failed', 'declined'].filter(k => counts[k] > 0);
  const history = resolutionTypes.length > 1
    ? STATUS.MIXED
    : resolutionTypes.length === 1
      ? ({ done: STATUS.DONE, failed: STATUS.FAILED, declined: STATUS.DECLINED }[resolutionTypes[0]])
      : (counts.offered > 0 ? STATUS.OFFERED_ONLY : STATUS.NOT_ENCOUNTERED);

  let status;
  if (isHeld)           status = STATUS.IN_PROGRESS;
  else if (isAvailable) status = STATUS.AVAILABLE;
  else                  status = history;

  return {
    status,
    label:  _label(status, counts, isHeld !== true && isAvailable !== true ? null : history),
    counts,
    isHeld,
    isAvailable,
    unreachableCompletePath,
  };
}

function _label(status, counts, overriddenHistory) {
  const base = {
    [STATUS.IN_PROGRESS]:     'Currently active',
    [STATUS.AVAILABLE]:       'Available, not yet accepted',
    [STATUS.DONE]:            counts.done > 1 ? `Completed (×${counts.done})` : 'Completed',
    [STATUS.FAILED]:          counts.failed > 1 ? `Failed (×${counts.failed})` : 'Failed',
    [STATUS.DECLINED]:        'Declined',
    [STATUS.MIXED]:           `Mixed history — done ×${counts.done}, failed ×${counts.failed}${counts.declined ? `, declined ×${counts.declined}` : ''}`,
    [STATUS.OFFERED_ONLY]:    'Offered — outcome unclear',
    [STATUS.NOT_ENCOUNTERED]: 'Not encountered',
  }[status] || status;

  // If currently held/available but there's also resolved history from
  // earlier cycles (a repeatable mission), say so rather than hiding it.
  if (overriddenHistory && overriddenHistory !== STATUS.NOT_ENCOUNTERED && overriddenHistory !== STATUS.OFFERED_ONLY) {
    const historyBits = [];
    if (counts.done)     historyBits.push(`done ×${counts.done}`);
    if (counts.failed)   historyBits.push(`failed ×${counts.failed}`);
    if (counts.declined) historyBits.push(`declined ×${counts.declined}`);
    if (historyBits.length) return `${base} (previously: ${historyBits.join(', ')})`;
  }
  return base;
}

// ── Bulk lookup ───────────────────────────────────────────────
function getAllStatuses(save) {
  save = save === undefined ? getCurrentSave() : save;
  const names = new Set();

  if (save) {
    (save.missions      || []).forEach(m => names.add(m.name));
    (save.availableJobs || []).forEach(m => names.add(m.name));
    if (save.pilot && save.pilot.conditions) {
      for (const key of Object.keys(save.pilot.conditions)) {
        const m = key.match(/^(.*): (?:offered|active|done|failed|declined)$/);
        if (m) names.add(m[1]);
      }
    }
  }

  const out = new Map();
  for (const name of names) out.set(name, getMissionStatus(name, save));
  return out;
}

// ── Decorate a mission list from MissionLoader ──────────────────
// Takes whatever MissionLoader.getAllMissions() (or getMissionsByPlugin)
// returned and attaches `.status` to each entry by matching `.name`.
// Missions the save has no record of at all still get a NOT_ENCOUNTERED
// status object, not `undefined` — a consumer can always read
// `.status.status` without a null check.
function decorateMissions(missions, save) {
  save = save === undefined ? getCurrentSave() : save;
  const statuses = getAllStatuses(save);
  return missions.map(m => {
    let status = statuses.get(m.name) || getMissionStatus(m.name, save);
    // Already-resolved missions (not currently held) have no live save
    // data to check for the unreachable-complete pattern — fall back to
    // the plugin catalog's static definition, which is what `m.raw` is
    // here (missionLoader.js's own raw tree for this catalog entry).
    if (!status.unreachableCompletePath && !status.isHeld && m.raw && hasUnreachableCompletePath(m.raw)) {
      status = { ...status, unreachableCompletePath: true };
    }
    return { ...m, status };
  });
}

window.MissionStatusHelper = {
  STATUS,
  getCurrentSave,
  listSaves,
  getSaveById,
  getMissionStatus,
  getAllStatuses,
  decorateMissions,
  hasUnreachableCompletePath,
};

})();
