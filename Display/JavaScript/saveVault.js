'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  saveVault.js — keeps the ORIGINAL text of every imported save (and the
//  latest edited version), so saves can be edited and downloaded back into
//  the game.
//
//  Local:  IndexedDB database "es_save_vault", store "saves", keyed by the
//          same id saveManager.js uses in its registry. IndexedDB has no
//          5 MB limit, unlike localStorage.
//  Cloud:  when logged in, each save is also kept in the account —
//          Storage bucket "saves" at <user id>/<save id>/original.txt and
//          edited.txt, plus a row in `player_saves` (see user_management.sql).
//
//  window.SaveVault
//    put(id, { original, label, parsed })   store a newly imported save
//    get(id)            → { id, original, edited|null, updatedAt, cloud } | null
//    text(id)           → edited text if any, else original
//    setEdited(id, text) / revert(id) / remove(id)
//    uploadToAccount(id)          push one save into the account
//    listAccountSaves()           rows from player_saves
//    downloadFromAccount(row)     → { original, edited } (and stores it locally)
//    localIdsMissingFromAccount() ids stored here but not in the account
//    deleteAllAccountFiles()      used by "Delete my account"
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const DB_NAME = 'es_save_vault';
  const STORE   = 'saves';
  const BUCKET  = 'saves';
  const TABLE   = 'player_saves';

  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('This browser does not support IndexedDB.')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const user = () => (window.EsAuth && window.EsAuth.getCurrentUser && window.EsAuth.getCurrentUser()) || null;
  const sb = () => window.supabaseClient;
  // Saves made before ids were UUIDs ("save_mv0n30qt_eove5n") get a separate
  // UUID for their copy in the account — player_saves.id is a uuid column.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isUuid = id => UUID_RE.test(String(id || ''));
  function newUuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const x = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }
  /** The id this save uses in the account (creates one for old-style ids). */
  const cidPending = new Map();   // one id per save even if two uploads start together
  async function ensureCloudId(rec) {
    if (isUuid(rec.id)) return rec.id;
    if (rec.cloudId) return rec.cloudId;
    if (!cidPending.has(rec.id)) cidPending.set(rec.id, (async () => {
      const cid = newUuid();
      const saved = await patchLocal(rec.id, r => (r.cloudId ? {} : { cloudId: cid }));
      return (saved && saved.cloudId) || cid;
    })().finally(() => setTimeout(() => cidPending.delete(rec.id), 0)));
    rec.cloudId = await cidPending.get(rec.id);
    return rec.cloudId;
  }
  const cloudIdOf = (rec, id) => (rec ? (isUuid(rec.id) ? rec.id : rec.cloudId || null) : (isUuid(id) ? id : null));

  const isMissing = err => err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|could not find the table|bucket not found/i.test(err.message || ''));

  // ── local ────────────────────────────────────────────────────────────────
  async function getLocal(id) { return tx('readonly', s => reqP(s.get(id))); }
  async function putLocal(rec) { return tx('readwrite', s => reqP(s.put(rec))); }
  // Change a few fields of a stored save inside ONE transaction (read + write
  // together), so a concurrent edit can't be overwritten by an older copy.
  async function patchLocal(id, patch) {
    return tx('readwrite', s => new Promise((res, rej) => {
      const g = s.get(id);
      g.onsuccess = () => { const r = g.result; if (!r) return res(null); Object.assign(r, typeof patch === 'function' ? patch(r) : patch); const p = s.put(r); p.onsuccess = () => res(r); p.onerror = () => rej(p.error); };
      g.onerror = () => rej(g.error);
    }));
  }
  async function allLocalIds() { return tx('readonly', s => reqP(s.getAllKeys())); }

  function summarise(parsed, label) {
    return {
      label: label || parsed?.pilot?.name || 'Save',
      pilot_name: parsed?.pilot?.name || null,
      game_date: parsed?.pilot?.date || null,
      credits: parsed?.account?.credits != null ? String(parsed.account.credits) : null,
      ship_count: Array.isArray(parsed?.ships) ? parsed.ships.length : null,
    };
  }

  async function put(id, { original, label, parsed }) {
    const rec = { id, original, edited: null, updatedAt: Date.now(), meta: summarise(parsed, label), cloud: false };
    await putLocal(rec);
    if (user()) uploadToAccount(id).catch(e => console.warn('[SaveVault] upload failed', e));
    return rec;
  }
  async function get(id) { return (await getLocal(id)) || null; }
  async function text(id) { const r = await getLocal(id); return r ? (r.edited || r.original) : null; }

  async function setEdited(id, editedText, parsed) {
    const r = await patchLocal(id, rec => ({ edited: editedText, updatedAt: Date.now(),
      ...(parsed ? { meta: { ...rec.meta, ...summarise(parsed, rec.meta?.label) } } : {}) }));
    if (!r) throw new Error('This save has no stored original — re-upload the .txt file.');
    if (user()) uploadToAccount(id, { editedOnly: true }).catch(e => console.warn('[SaveVault] upload failed', e));
    return r;
  }
  async function revert(id) {
    const r = await patchLocal(id, { edited: null, updatedAt: Date.now() });
    if (!r) return null;
    const cid = cloudIdOf(r, id);
    if (user() && cid) {
      await sb().storage.from(BUCKET).remove([`${user().id}/${cid}/edited.txt`]).catch(() => {});
      await sb().from(TABLE).update({ has_edits: false }).eq('id', cid).then(() => {}, () => {});
    }
    return r;
  }
  async function remove(id, { fromAccount = true } = {}) {
    const r = await getLocal(id).catch(() => null);
    await tx('readwrite', s => reqP(s.delete(id)));
    const cid = cloudIdOf(r, id);
    if (fromAccount && user() && cid) {
      const u = user().id;
      await sb().storage.from(BUCKET).remove([`${u}/${cid}/original.txt`, `${u}/${cid}/edited.txt`]).catch(() => {});
      await sb().from(TABLE).delete().eq('id', cid).then(() => {}, () => {});
    }
  }

  // ── cloud ────────────────────────────────────────────────────────────────
  async function uploadToAccount(id, { editedOnly = false } = {}) {
    const u = user();
    if (!u) throw new Error('Log in to keep saves in your account.');
    const r = await getLocal(id);
    if (!r) throw new Error('This save has no stored original — re-upload the .txt file.');
    const bucket = sb().storage.from(BUCKET);
    const opts = { upsert: true, contentType: 'text/plain;charset=utf-8' };
    const cid = await ensureCloudId(r);
    // a save that got its account id just now has never had its original uploaded
    if (!editedOnly || !r.cloud) {
      const { error } = await bucket.upload(`${u.id}/${cid}/original.txt`, new Blob([r.original], { type: 'text/plain' }), opts);
      if (error) throw error;
    }
    if (r.edited) {
      const { error } = await bucket.upload(`${u.id}/${cid}/edited.txt`, new Blob([r.edited], { type: 'text/plain' }), opts);
      if (error) throw error;
    }
    const { error: rowErr } = await sb().from(TABLE).upsert({
      id: cid, user_id: u.id, ...(r.meta || { label: 'Save' }), has_edits: !!r.edited, original_size: r.original.length,
    }, { onConflict: 'id' });
    if (rowErr) throw rowErr;
    // mark it as in the account on a FRESH copy — an edit saved while this upload
    // was running must not be overwritten by the older text we started with
    await patchLocal(id, r => ({ cloud: true, ...(cid !== r.id && !r.cloudId ? { cloudId: cid } : {}) }));
    return true;
  }

  async function listAccountSaves() {
    if (!user()) return [];
    const { data, error } = await sb().from(TABLE).select('*').eq('user_id', user().id).order('updated_at', { ascending: false });
    if (error) { if (isMissing(error)) return []; throw error; }
    // rows use the account id; report them under the id this browser knows the save by
    const local = await tx('readonly', s => reqP(s.getAll())).catch(() => []);
    const byCloud = new Map();
    for (const r of local || []) { const c = cloudIdOf(r, r.id); if (c) byCloud.set(c, r.id); }
    return (data || []).map(row => ({ ...row, cloudId: row.id, id: byCloud.get(row.id) || row.id }));
  }

  async function downloadFromAccount(row) {
    const u = user();
    if (!u) throw new Error('Log in first.');
    const bucket = sb().storage.from(BUCKET);
    const read = async path => {
      const { data, error } = await bucket.download(path);
      if (error) return null;
      return await data.text();
    };
    const cid = row.cloudId || row.id;
    const original = await read(`${u.id}/${cid}/original.txt`);
    if (original == null) throw new Error('The save file could not be found in your account.');
    const edited = row.has_edits ? await read(`${u.id}/${cid}/edited.txt`) : null;
    await putLocal({ id: row.id, ...(row.id !== cid ? { cloudId: cid } : {}), original, edited, updatedAt: Date.parse(row.updated_at) || Date.now(),
      meta: { label: row.label, pilot_name: row.pilot_name, game_date: row.game_date, credits: row.credits, ship_count: row.ship_count },
      cloud: true });
    return { original, edited };
  }

  async function localIdsMissingFromAccount() {
    if (!user()) return [];
    const [ids, rows] = await Promise.all([allLocalIds(), listAccountSaves()]);
    const inAccount = new Set(rows.map(r => r.id));
    return ids.filter(id => !inAccount.has(id));
  }

  async function deleteAllAccountFiles() {
    const u = user();
    if (!u) return;
    const bucket = sb().storage.from(BUCKET);
    const { data: folders } = await bucket.list(u.id, { limit: 1000 });
    const paths = [];
    for (const f of folders || []) {
      const { data: files } = await bucket.list(`${u.id}/${f.name}`, { limit: 100 });
      for (const file of files || []) paths.push(`${u.id}/${f.name}/${file.name}`);
    }
    for (let i = 0; i < paths.length; i += 100) await bucket.remove(paths.slice(i, i + 100));
  }

  async function clearLocal() { await tx('readwrite', s => reqP(s.clear())); }

  /** New text from the game for an existing save (same id). Edits are dropped unless keepEdits. */
  async function replaceOriginal(id, original, { parsed, keepEdits = false } = {}) {
    const r = (await getLocal(id)) || { id, edited: null, meta: {} };
    r.original = original;
    if (!keepEdits) r.edited = null;
    r.updatedAt = Date.now();
    if (parsed) r.meta = { ...(r.meta || {}), ...summarise(parsed, r.meta?.label) };
    await putLocal(r);
    if (user()) uploadToAccount(id).catch(e => console.warn('[SaveVault] upload failed', e));
    return r;
  }

  // A FileSystemFileHandle for the save's file on disk (Chrome / Edge), so it
  // can be re-read — and written back — without choosing the file again.
  async function setHandle(id, handle) {
    await patchLocal(id, { handle: handle || null });
  }
  async function getHandle(id) { const r = await getLocal(id); return (r && r.handle) || null; }

  window.SaveVault = {
    put, get, text, setEdited, revert, remove,
    uploadToAccount, listAccountSaves, downloadFromAccount, localIdsMissingFromAccount,
    deleteAllAccountFiles, clearLocal, replaceOriginal, setHandle, getHandle,
  };
})();
