'use strict';

// ═══════════════════════════════════════════════════════════
//  auth.js  —  Endless Sky Ship Builder
//
//  Thin wrapper around Supabase Auth, plus the one piece of app-specific
//  logic that needs to know about login state right now: syncing which
//  plugins are active to the logged-in user's account instead of (or
//  alongside) localStorage, so it follows them across devices.
//
//  Requires supabaseClient.js to already be loaded on the page.
// ═══════════════════════════════════════════════════════════

(function () {

let _currentUser = null;
let _currentProfile = null; // { username } — fetched once per session, cached
let _authReadyResolve;
const _authReady = new Promise(resolve => { _authReadyResolve = resolve; });
const _listeners = [];
let _isAdmin = null, _adminCheckedFor = null;   // see isAdmin()

async function _loadProfile(userId) {
    if (!userId) { _currentProfile = null; return; }
    try {
        const { data } = await window.supabaseClient
            .from('profiles').select('username').eq('id', userId).maybeSingle();
        _currentProfile = data || null;
    } catch (_) {
        _currentProfile = null;
    }
}

function _fireAuthChange() {
    for (const fn of _listeners) {
        try { fn(_currentUser, _currentProfile); } catch (e) { console.error('[Auth] listener error:', e); }
    }
}

// getSession() reads the persisted session token — cheap, no network
// round trip in the common case — so this resolves fast on every page.
window.supabaseClient.auth.getSession().then(async ({ data }) => {
    _currentUser = data?.session?.user ?? null;
    await _loadProfile(_currentUser?.id);
    _authReadyResolve();
    _fireAuthChange();
});

let _inPasswordRecovery = false;
window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
    _currentUser = session?.user ?? null;
    if (_currentUser?.id !== _adminCheckedFor) { _isAdmin = null; _adminCheckedFor = null; }
    await _loadProfile(_currentUser?.id);
    _fireAuthChange();
    // Arrived from a "reset your password" email link — the user is signed
    // in with a one-time session and needs to choose a new password now.
    if (event === 'PASSWORD_RECOVERY') {
        _inPasswordRecovery = true;
        window.dispatchEvent(new CustomEvent('es:passwordRecovery'));
    }
});

/** Checks whether a username is free to take — used for inline validation
 * before submitting, so "taken" feedback shows up before the user hits
 * submit rather than only as a server error after. Not a hard guarantee
 * (someone could take it a moment later) — signUp() below still handles
 * the unique-constraint error as the real source of truth. */
async function isUsernameAvailable(username) {
    // Case-insensitive check on the server (user_management.sql); falls back
    // to an exact match if that function hasn't been installed yet.
    const { data, error } = await window.supabaseClient.rpc('username_available', { p_username: username });
    if (!error && typeof data === 'boolean') return data;
    const { data: row } = await window.supabaseClient
        .from('profiles').select('id').eq('username', username).maybeSingle();
    return !row || row.id === _currentUser?.id;
}

/** Returns a message if the username isn't allowed, or '' if it's fine.
 * Same rule as the profiles_username_format check in the database. */
function usernameProblem(username) {
    const v = String(username || '').trim();
    if (v.length < 3) return 'Usernames need at least 3 characters.';
    if (v.length > 24) return 'Usernames can be at most 24 characters.';
    if (!/^[A-Za-z0-9_.-]+$/.test(v)) return 'Use only letters, numbers, dots, dashes and underscores.';
    return '';
}

async function signUp(email, password, username) {
    if (username) {
        const problem = usernameProblem(username);
        if (problem) throw new Error(problem);
    }
    const { data, error } = await window.supabaseClient.auth.signUp({ email, password });
    if (error) throw error;
    if (data.user && username) {
        const { error: profileErr } = await window.supabaseClient
            .from('profiles').insert({ id: data.user.id, username });
        if (profileErr) {
            // Most likely cause: username taken in the split second between
            // the availability check and this insert. Signup itself still
            // succeeded — surface this distinctly so the UI can say so
            // rather than implying the whole signup failed.
            const err = new Error(
                profileErr.message.includes('duplicate') || profileErr.code === '23505'
                    ? 'That username was just taken — your account was created, but pick a different username to finish setting up your profile.'
                    : profileErr.message
            );
            err.isProfileError = true;
            throw err;
        }
        _currentProfile = { username };
    }
    return data.user;
}

async function signIn(email, password) {
    const { data, error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
}

async function signOut() {
    await window.supabaseClient.auth.signOut();
    // The active-plugins localStorage key is shared/global on this browser
    // (dataLoader.js and generalPluginStuff.js both write to it) — clear it
    // on sign-out so this account's picks don't linger as the "remembered"
    // selection for whoever uses this browser next, logged in or not.
    try { localStorage.removeItem('es_sb_active_plugins'); } catch (_) { /* ignore */ }
}

/** Resolves once the initial session check has completed (page load only). */
async function ready() {
    await _authReady;
    return _currentUser;
}

function getCurrentUser() {
    return _currentUser;
}

function getCurrentProfile() {
    return _currentProfile;
}

/** What the UI should actually show — the username if one's set, the
 * email otherwise (covers accounts created before usernames existed, or
 * anyone who skipped setting one). */
function getDisplayName() {
    return _currentProfile?.username || _currentUser?.email || null;
}

/** Fires immediately with current state, then again on every login/logout.
 * Listener receives (user, profile) — profile is null if none is set. */
function onAuthChange(fn) {
    _listeners.push(fn);
    if (_currentUser !== null || _listeners.length) fn(_currentUser);
}

/** Reads the logged-in user's saved active-plugin list, or null if signed
 * out / never saved one — callers should fall back to localStorage. */
async function getActivePluginsPreference() {
    const user = await ready();
    if (!user) return null;
    const { data, error } = await window.supabaseClient
        .from('user_preferences').select('active_plugins').eq('user_id', user.id).maybeSingle();
    if (error || !data) return null;
    return data.active_plugins;
}

/** Silently does nothing if signed out — this is a "sync if logged in"
 * call, not a required save path (localStorage still gets written too). */
async function saveActivePluginsPreference(activePlugins) {
    const user = getCurrentUser();
    if (!user) return;
    try {
        await window.supabaseClient.from('user_preferences').upsert({
            user_id: user.id,
            active_plugins: activePlugins,
            updated_at: new Date().toISOString(),
        });
    } catch (err) {
        console.warn('[Auth] Could not sync active plugins to account:', err);
    }
}

/** Changes the current user's username. Rejects with a friendly message
 * on a uniqueness conflict, same as signUp()'s profile-creation step. */
async function updateUsername(newUsername) {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    const problem = usernameProblem(newUsername);
    if (problem) throw new Error(problem);
    newUsername = newUsername.trim();

    // FIX: was .update(...).eq('id', user.id) — that only touches a row
    // that already exists. Any account without a profiles row yet (e.g.
    // created before usernames existed) would match zero rows and return
    // success with no error, looking like it worked while nothing was
    // actually written. upsert creates the row if it's missing, updates
    // it if it's already there.
    const { error } = await window.supabaseClient
        .from('profiles').upsert({ id: user.id, username: newUsername });
    if (error) {
        throw new Error(
            error.code === '23505' || /duplicate/i.test(error.message)
                ? 'That username is already taken.'
                : error.message
        );
    }
    _currentProfile = { ..._currentProfile, username: newUsername };
    _fireAuthChange();
}

/** Changes the current user's password. Supabase's own session token
 * authorizes this — no re-entry of the old password required. */
async function updatePassword(newPassword) {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    const { error } = await window.supabaseClient.auth.updateUser({ password: newPassword });
    if (error) throw error;
}

/** Changes the account email. Supabase sends a confirmation link to the
 * NEW address by default — the change only takes effect once that's
 * clicked, so the caller should tell the user to check their inbox
 * rather than assume this took effect immediately. */
async function updateEmail(newEmail) {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    const { error } = await window.supabaseClient.auth.updateUser({ email: newEmail });
    if (error) throw error;
}

/** Sends a "reset your password" email. The link brings the user back to
 * the account page, where navBar.js asks for the new password. */
async function requestPasswordReset(email) {
    const redirectTo = new URL('UserManager.html', window.location.href).href;
    const { error } = await window.supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
}
function isInPasswordRecovery() { return _inPasswordRecovery; }
function finishPasswordRecovery() { _inPasswordRecovery = false; }

// ── admin check (user_management.sql: app_admins / is_admin()) ──
async function isAdmin() {
    const user = getCurrentUser();
    if (!user) return false;
    if (_adminCheckedFor === user.id && _isAdmin !== null) return _isAdmin;
    const { data, error } = await window.supabaseClient.rpc('is_admin');
    _isAdmin = !error && data === true;
    _adminCheckedFor = user.id;
    return _isAdmin;
}

/** Everything this account has stored, as one JSON-ready object. */
async function exportMyData() {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    const sb = window.supabaseClient;
    const pick = async (table, cols = '*', col = 'user_id') => {
        const { data, error } = await sb.from(table).select(cols).eq(col, user.id);
        return error ? { error: error.message } : data;
    };
    const saves = await pick('player_saves');
    const saveFiles = [];
    if (Array.isArray(saves)) {
        for (const s of saves) {
            const entry = { ...s };
            for (const kind of ['original', 'edited']) {
                if (kind === 'edited' && !s.has_edits) continue;
                const { data } = await sb.storage.from('saves').download(`${user.id}/${s.id}/${kind}.txt`);
                if (data) entry[`${kind}_text`] = await data.text();
            }
            saveFiles.push(entry);
        }
    }
    return {
        exportedAt: new Date().toISOString(),
        account: { id: user.id, email: user.email, created_at: user.created_at },
        profile: await pick('profiles', '*', 'id'),
        preferences: await pick('user_preferences'),
        fleets: await pick('fleets'),
        shared_ships: await pick('saved_ships'),
        saves: saveFiles,
        reports_filed: await pick('reports', '*', 'reporter_id'),
    };
}

/** Permanently deletes the account and everything stored with it. */
async function deleteMyAccount() {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    if (window.SaveVault) await window.SaveVault.deleteAllAccountFiles();
    const { error } = await window.supabaseClient.rpc('delete_my_account');
    if (error) throw error;
    await signOut();
}

window.EsAuth = {
    usernameProblem, requestPasswordReset, isInPasswordRecovery, finishPasswordRecovery,
    isAdmin, exportMyData, deleteMyAccount,
    signUp, signIn, signOut, ready, getCurrentUser, getCurrentProfile, getDisplayName,
    isUsernameAvailable, onAuthChange,
    updateUsername, updatePassword, updateEmail,
    getActivePluginsPreference, saveActivePluginsPreference,
};

})();
