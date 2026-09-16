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
    const { select = '*', filters, orderBy, pageSize = 1000 } = opts;
    let from = 0;
    let rows = [];
    for (;;) {
        let query = window.supabaseClient.from(table).select(select);
        if (orderBy) query = query.order(orderBy, { ascending: true });
        query = query.range(from, from + pageSize - 1);
        if (filters) query = filters(query);

        // A timeout here is usually transient (a slow moment on shared
        // compute), not a real failure — retry a couple of times before
        // giving up, same idea as the parser's own retry logic.
        let data, error;
        for (let attempt = 1; attempt <= 3; attempt++) {
            ({ data, error } = await query);
            if (!error) break;
            const isTimeout = /timeout/i.test(error.message ?? '');
            if (!isTimeout || attempt === 3) break;
            console.warn(`[fetchAllRows] "${table}" page timed out, retrying (attempt ${attempt}/3)...`);
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
        if (error) throw new Error(`Supabase fetch failed for "${table}": ${error.message}`);

        rows = rows.concat(data || []);
        if (!data || data.length < pageSize) break;
        from += pageSize;
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
