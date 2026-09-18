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

window.supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    _currentUser = session?.user ?? null;
    await _loadProfile(_currentUser?.id);
    _fireAuthChange();
});

/** Checks whether a username is free to take — used for inline validation
 * before submitting, so "taken" feedback shows up before the user hits
 * submit rather than only as a server error after. Not a hard guarantee
 * (someone could take it a moment later) — signUp() below still handles
 * the unique-constraint error as the real source of truth. */
async function isUsernameAvailable(username) {
    const { data } = await window.supabaseClient
        .from('profiles').select('id').eq('username', username).maybeSingle();
    return !data;
}

async function signUp(email, password, username) {
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

window.EsAuth = {
    signUp, signIn, signOut, ready, getCurrentUser, getCurrentProfile, getDisplayName,
    isUsernameAvailable, onAuthChange,
    getActivePluginsPreference, saveActivePluginsPreference,
};

})();
