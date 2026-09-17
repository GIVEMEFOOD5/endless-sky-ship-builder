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
let _authReadyResolve;
const _authReady = new Promise(resolve => { _authReadyResolve = resolve; });
const _listeners = [];

function _fireAuthChange() {
    for (const fn of _listeners) {
        try { fn(_currentUser); } catch (e) { console.error('[Auth] listener error:', e); }
    }
}

// getSession() reads the persisted session token — cheap, no network
// round trip in the common case — so this resolves fast on every page.
window.supabaseClient.auth.getSession().then(({ data }) => {
    _currentUser = data?.session?.user ?? null;
    _authReadyResolve();
    _fireAuthChange();
});

window.supabaseClient.auth.onAuthStateChange((_event, session) => {
    _currentUser = session?.user ?? null;
    _fireAuthChange();
});

async function signUp(email, password) {
    const { data, error } = await window.supabaseClient.auth.signUp({ email, password });
    if (error) throw error;
    return data.user;
}

async function signIn(email, password) {
    const { data, error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
}

async function signOut() {
    await window.supabaseClient.auth.signOut();
}

/** Resolves once the initial session check has completed (page load only). */
async function ready() {
    await _authReady;
    return _currentUser;
}

function getCurrentUser() {
    return _currentUser;
}

/** Fires immediately with current state, then again on every login/logout. */
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
    signUp, signIn, signOut, ready, getCurrentUser, onAuthChange,
    getActivePluginsPreference, saveActivePluginsPreference,
};

})();
