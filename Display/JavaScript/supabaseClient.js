'use strict';

// ═══════════════════════════════════════════════════════════
//  supabaseClient.js  —  Endless Sky Ship Builder
//
//  Shared Supabase client + a generic pagination helper, used by
//  dataLoader.js, mapDataLoader.js, and missionLoader.js instead of
//  each fetching raw.githubusercontent.com JSON files directly.
//
//  Requires the Supabase UMD script to already be loaded on the page
//  (see index HTML files — added as a <script> tag right before this
//  one), which exposes the global `window.supabase.createClient`.
//
//  The key below is the public "anon"-equivalent key — safe to ship
//  in frontend code. Real access control is enforced by Row-Level
//  Security policies on the database, not by keeping this secret.
// ═══════════════════════════════════════════════════════════

(function () {

const SUPABASE_URL = 'https://lhbagnwfgsclywroxhqj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6i_1psbc5BaaAyC6wdAkDQ_7L96Rq2s';

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Fetches every row from a table, walking through pages automatically —
 * Supabase/PostgREST caps a single request at 1000 rows by default, and
 * ships/outfits/systems/etc. all exceed that, so a single .select() would
 * silently come back truncated without this.
 *
 * @param {string} table
 * @param {object} [opts]
 * @param {string} [opts.select]   column list, defaults to '*'
 * @param {function} [opts.filters] receives the query builder, returns it
 *        with .eq()/.in()/etc. applied — e.g. filters: q => q.eq('plugin_id', id)
 */
async function fetchAllRows(table, opts = {}) {
    const { select = '*', filters } = opts;
    const PAGE_SIZE = 1000;
    let from = 0;
    let rows = [];
    for (;;) {
        let query = window.supabaseClient.from(table).select(select).range(from, from + PAGE_SIZE - 1);
        if (filters) query = filters(query);
        const { data, error } = await query;
        if (error) throw new Error(`Supabase fetch failed for "${table}": ${error.message}`);
        rows = rows.concat(data || []);
        if (!data || data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }
    return rows;
}

/** Groups an array of rows into a Map keyed by one of their own fields. */
function groupBy(rows, key) {
    const map = new Map();
    for (const row of rows) {
        if (!map.has(row[key])) map.set(row[key], []);
        map.get(row[key]).push(row);
    }
    return map;
}

window.SupabaseHelpers = { fetchAllRows, groupBy };

})();
