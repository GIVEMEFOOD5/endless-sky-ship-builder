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
  const isMissing = err => err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|could not find the table|bucket not found/i.test(err.message || ''));

  // ── local ────────────────────────────────────────────────────────────────
  async function getLocal(id) { return tx('readonly', s => reqP(s.get(id))); }
  async function putLocal(rec) { return tx('readwrite', s => reqP(s.put(rec))); }
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
    const r = await getLocal(id);
    if (!r) throw new Error('This save has no stored original — re-upload the .txt file.');
    r.edited = editedText; r.updatedAt = Date.now();
    if (parsed) r.meta = { ...r.meta, ...summarise(parsed, r.meta?.label) };
    await putLocal(r);
    if (user()) uploadToAccount(id, { editedOnly: true }).catch(e => console.warn('[SaveVault] upload failed', e));
    return r;
  }
  async function revert(id) {
    const r = await getLocal(id);
    if (!r) return null;
    r.edited = null; r.updatedAt = Date.now();
    await putLocal(r);
    if (user()) {
      await sb().storage.from(BUCKET).remove([`${user().id}/${id}/edited.txt`]).catch(() => {});
      await sb().from(TABLE).update({ has_edits: false }).eq('id', id).then(() => {}, () => {});
    }
    return r;
  }
  async function remove(id, { fromAccount = true } = {}) {
    await tx('readwrite', s => reqP(s.delete(id)));
    if (fromAccount && user()) {
      const u = user().id;
      await sb().storage.from(BUCKET).remove([`${u}/${id}/original.txt`, `${u}/${id}/edited.txt`]).catch(() => {});
      await sb().from(TABLE).delete().eq('id', id).then(() => {}, () => {});
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
    if (!editedOnly) {
      const { error } = await bucket.upload(`${u.id}/${id}/original.txt`, new Blob([r.original], { type: 'text/plain' }), opts);
      if (error) throw error;
    }
    if (r.edited) {
      const { error } = await bucket.upload(`${u.id}/${id}/edited.txt`, new Blob([r.edited], { type: 'text/plain' }), opts);
      if (error) throw error;
    }
    const { error: rowErr } = await sb().from(TABLE).upsert({
      id, user_id: u.id, ...(r.meta || { label: 'Save' }), has_edits: !!r.edited, original_size: r.original.length,
    }, { onConflict: 'id' });
    if (rowErr) throw rowErr;
    r.cloud = true;
    await putLocal(r);
    return true;
  }

  async function listAccountSaves() {
    if (!user()) return [];
    const { data, error } = await sb().from(TABLE).select('*').eq('user_id', user().id).order('updated_at', { ascending: false });
    if (error) { if (isMissing(error)) return []; throw error; }
    return data || [];
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
    const original = await read(`${u.id}/${row.id}/original.txt`);
    if (original == null) throw new Error('The save file could not be found in your account.');
    const edited = row.has_edits ? await read(`${u.id}/${row.id}/edited.txt`) : null;
    await putLocal({ id: row.id, original, edited, updatedAt: Date.parse(row.updated_at) || Date.now(),
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
    const r = await getLocal(id);
    if (!r) return;
    r.handle = handle || null;
    await putLocal(r);
  }
  async function getHandle(id) { const r = await getLocal(id); return (r && r.handle) || null; }

  window.SaveVault = {
    put, get, text, setEdited, revert, remove,
    uploadToAccount, listAccountSaves, downloadFromAccount, localIdsMissingFromAccount,
    deleteAllAccountFiles, clearLocal, replaceOriginal, setHandle, getHandle,
  };
})();
