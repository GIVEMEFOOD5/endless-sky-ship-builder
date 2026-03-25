/* ═══════════════════════════════════════════════════════════════
   pluginManager.js  —  Endless Sky Plugin Manager
   Fetches plugins.json on page load, lets the user add / edit /
   remove entries, then saves back via the Vercel backend.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── Path to the JSON file (absolute URL for GitHub Pages) ─────── */
const PLUGINS_JSON_PATH = 'https://givemefood5.github.io/endless-sky-ship-builder/plugins.json';

/* ── Vercel backend endpoint ─────────────────────────────────── */
const BACKEND_URL = 'https://vercel-for-endless-sky-ship-builder.vercel.app/api/update-json';

/* ── Optional shared secret (must match SECRET_KEY in Vercel env) */
const UPDATE_SECRET = null;

/* ── Helpers ─────────────────────────────────────────────────── */

/**
 * Normalise a GitHub repo input to https://github.com/user/repo.
 * Accepts:
 *   username/repo
 *   https://github.com/username/repo
 *   https://github.com/username/repo/tree/branch  (trimmed to root)
 * Returns null on failure.
 */
function normaliseRepository(raw) {
    const s = (raw || '').trim();
    if (!s) return null;

    if (/^https?:\/\/github\.com\//i.test(s)) {
        const m = s.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)/i);
        return m ? `https://github.com/${m[1]}` : null;
    }

    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
        return `https://github.com/${s}`;
    }

    return null;
}

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Wrap every occurrence of `query` in a string with <mark> tags.
 * Case-insensitive. Returns escaped HTML.
 */
function highlight(str, query) {
    const escaped = esc(str);
    if (!query) return escaped;
    const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.replace(
        new RegExp(`(${safeQuery})`, 'gi'),
        '<mark class="search-hl">$1</mark>'
    );
}

/* ══════════════════════════════════════════════════════════════
   PluginStore
   ══════════════════════════════════════════════════════════════ */
class PluginStore {
    constructor() {
        /** @type {Array<{name:string, repository:string}>} */
        this._plugins   = [];
        this._listeners = [];
    }

    /* ── Observers ───────────────────────────────────────────── */
    onChange(fn) { this._listeners.push(fn); }
    _notify()    { this._listeners.forEach(fn => fn()); }

    /* ── Accessors ───────────────────────────────────────────── */
    get plugins() { return JSON.parse(JSON.stringify(this._plugins)); }
    get count()   { return this._plugins.length; }

    /* ── Load from parsed object ─────────────────────────────── */
    loadFromObject(obj) {
        if (!obj || !Array.isArray(obj.plugins)) {
            throw new Error('JSON must have a "plugins" array at the root.');
        }
        this._plugins = obj.plugins.map(p => ({
            name:       String(p.name       || '').trim(),
            repository: String(p.repository || '').trim(),
        }));
        this._notify();
    }

    /* ── Serialise ───────────────────────────────────────────── */
    toJSON() {
        return JSON.stringify({ plugins: this._plugins }, null, 2);
    }

    /* ── CRUD ────────────────────────────────────────────────── */
    addPlugin(name, repo) {
        const trimName = (name || '').trim();
        if (!trimName) return { ok: false, error: 'Plugin name cannot be empty.' };

        const normRepo = normaliseRepository(repo);
        if (!normRepo) return { ok: false, error: 'Invalid repository — use  username/repo  or a full GitHub URL.' };

        const lower = trimName.toLowerCase();
        for (const p of this._plugins) {
            if (p.name.toLowerCase() === lower)
                return { ok: false, error: `A plugin named "${p.name}" already exists.` };
            if (p.repository === normRepo)
                return { ok: false, error: `That repository is already listed as "${p.name}".` };
        }

        this._plugins.push({ name: trimName, repository: normRepo });
        this._notify();
        return { ok: true };
    }

    editPlugin(index, name, repo) {
        if (index < 0 || index >= this._plugins.length)
            return { ok: false, error: `No plugin at index ${index}.` };

        const trimName = (name || '').trim();
        if (!trimName) return { ok: false, error: 'Plugin name cannot be empty.' };

        const normRepo = normaliseRepository(repo);
        if (!normRepo) return { ok: false, error: 'Invalid repository — use  username/repo  or a full GitHub URL.' };

        const lower = trimName.toLowerCase();
        for (let i = 0; i < this._plugins.length; i++) {
            if (i === index) continue;
            if (this._plugins[i].name.toLowerCase() === lower)
                return { ok: false, error: `A plugin named "${this._plugins[i].name}" already exists.` };
            if (this._plugins[i].repository === normRepo)
                return { ok: false, error: `That repository is already listed as "${this._plugins[i].name}".` };
        }

        this._plugins[index] = { name: trimName, repository: normRepo };
        this._notify();
        return { ok: true };
    }

    removePlugin(index) {
        if (index < 0 || index >= this._plugins.length)
            return { ok: false, error: `No plugin at index ${index}.` };
        this._plugins.splice(index, 1);
        this._notify();
        return { ok: true };
    }

    /* ── Save to GitHub via Vercel backend ───────────────────── */
    async save() {
        const payload = { plugins: this._plugins };
        const headers = { 'Content-Type': 'application/json' };

        if (UPDATE_SECRET) {
            headers['X-Update-Secret'] = UPDATE_SECRET;
        }

        try {
            const res = await fetch(BACKEND_URL, {
                method:  'POST',
                headers,
                body:    JSON.stringify(payload),
            });

            let data;
            try { data = await res.json(); } catch { data = {}; }

            if (!res.ok) {
                return { ok: false, error: data.error || `Server error ${res.status}` };
            }

            return { ok: true };

        } catch (networkErr) {
            return { ok: false, error: `Network error: ${networkErr.message}` };
        }
    }
}

/* ══════════════════════════════════════════════════════════════
   PluginManagerUI
   ══════════════════════════════════════════════════════════════ */
class PluginManagerUI {
    constructor(store) {
        this.store = store;

        this.nameInput  = document.getElementById('pluginName');
        this.repoInput  = document.getElementById('repoUrl');
        this.addBtn     = document.getElementById('addPluginBtn');
        this.clearBtn   = document.getElementById('clearBtn');
        this.saveBtn    = document.getElementById('saveBtn');
        this.listEl     = document.getElementById('pluginActiveList');
        this.counterEl  = document.getElementById('pluginCounter');
        this.statusEl   = document.getElementById('statusMsg');
        this.searchEl   = document.getElementById('pluginSearch');

        this._editIndex   = null;
        this._statusTimer = null;
        this._searchQuery = '';

        this._bindEvents();
        this.store.onChange(() => this._render());
    }

    /* ── Events ──────────────────────────────────────────────── */
    _bindEvents() {
        this.addBtn.addEventListener('click',  () => this._handleAddOrEdit());
        this.clearBtn.addEventListener('click', () => this._handleClear());
        this.saveBtn.addEventListener('click',  () => this._handleSave());

        [this.nameInput, this.repoInput].forEach(el =>
            el.addEventListener('keydown', e => {
                if (e.key === 'Enter') this._handleAddOrEdit();
            })
        );

        /* Search — filter on every keystroke */
        this.searchEl.addEventListener('input', () => {
            this._searchQuery = this.searchEl.value.trim();
            this._render();
        });

        /* Clear search when the × button inside <input type="search"> is clicked */
        this.searchEl.addEventListener('search', () => {
            this._searchQuery = '';
            this._render();
        });
    }

    /* ── Add / edit ──────────────────────────────────────────── */
    _handleAddOrEdit() {
        const result = this._editIndex !== null
            ? this.store.editPlugin(this._editIndex, this.nameInput.value, this.repoInput.value)
            : this.store.addPlugin(this.nameInput.value, this.repoInput.value);

        if (!result.ok) { this._showStatus(result.error, 'error'); return; }

        const wasEditing = this._editIndex !== null;
        this._clearInputs();
        this._showStatus(wasEditing ? 'Plugin updated.' : 'Plugin added.', 'success');
    }

    /* ── Clear ───────────────────────────────────────────────── */
    _handleClear() {
        this._clearInputs();
        this._showStatus('', '');
    }

    /* ── Save ────────────────────────────────────────────────── */
    async _handleSave() {
        this.saveBtn.disabled = true;
        this._showStatus('Saving…', 'info');

        const result = await this.store.save();
        this.saveBtn.disabled = false;

        if (!result.ok) { this._showStatus('Save failed: ' + (result.error || ''), 'error'); return; }

        this._showStatus('plugins.json saved!', 'success');
    }

    /* ── Edit entry ──────────────────────────────────────────── */
    _startEdit(index) {
        const p = this.store.plugins[index];
        if (!p) return;
        this._editIndex       = index;
        this.nameInput.value  = p.name;
        this.repoInput.value  = p.repository;
        this.addBtn.innerHTML = '<span>✏️</span> Save Changes';
        this.nameInput.focus();
        this._showStatus(`Editing: ${p.name}`, 'info');
    }

    _clearInputs() {
        this._editIndex       = null;
        this.nameInput.value  = '';
        this.repoInput.value  = '';
        this.addBtn.innerHTML = '<span>📥</span> Add Plugin';
    }

    /* ── Render list (respects current search query) ─────────── */
    _render() {
        const plugins = this.store.plugins;
        const query   = this._searchQuery.toLowerCase();

        /* Always show total count, not filtered count */
        if (this.counterEl) this.counterEl.textContent = plugins.length;

        /* Filter by name or repository */
        const filtered = query
            ? plugins.filter(p =>
                p.name.toLowerCase().includes(query) ||
                p.repository.toLowerCase().includes(query)
              )
            : plugins;

        if (plugins.length === 0) {
            this.listEl.innerHTML =
                '<div class="sorter-empty">No plugins yet — add one above.</div>';
            return;
        }

        if (filtered.length === 0) {
            this.listEl.innerHTML =
                `<div class="search-no-results">No plugins match "<strong>${esc(this._searchQuery)}</strong>".</div>`;
            return;
        }

        this.listEl.innerHTML = '';

        filtered.forEach(p => {
            /* Find the real index in the full list so edit/remove work correctly */
            const realIndex = plugins.findIndex(
                x => x.name === p.name && x.repository === p.repository
            );

            const row = document.createElement('div');
            row.className = 'sorter-row';
            row.innerHTML = `
                <div class="sorter-label">
                    <span class="plugin-list-name">${highlight(p.name, this._searchQuery)}</span>
                    <span class="plugin-list-repo">${highlight(p.repository, this._searchQuery)}</span>
                </div>
                <button class="btn-action plugin-edit-btn"      data-i="${realIndex}" title="Edit">✏️</button>
                <button class="sorter-remove-btn plugin-rm-btn" data-i="${realIndex}" title="Remove">✕ Remove</button>
            `;

            row.querySelector('.plugin-edit-btn').addEventListener('click', e => {
                e.stopPropagation();
                this._startEdit(+e.currentTarget.dataset.i);
            });

            row.querySelector('.plugin-rm-btn').addEventListener('click', e => {
                e.stopPropagation();
                const idx  = +e.currentTarget.dataset.i;
                const name = this.store.plugins[idx]?.name ?? 'this plugin';
                if (confirm(`Remove "${name}"?`)) {
                    if (this._editIndex === idx) this._clearInputs();
                    this.store.removePlugin(idx);
                }
            });

            this.listEl.appendChild(row);
        });
    }

    /* ── Status banner ───────────────────────────────────────── */
    _showStatus(msg, type) {
        if (!this.statusEl) return;
        clearTimeout(this._statusTimer);

        if (!msg) { this.statusEl.className = 'status-msg hidden'; return; }

        this.statusEl.className = `status-msg status--${type}`;
        this.statusEl.textContent = msg;

        if (type === 'success') {
            this._statusTimer = setTimeout(
                () => { this.statusEl.className = 'status-msg hidden'; }, 3000
            );
        }
    }
}

/* ══════════════════════════════════════════════════════════════
   Bootstrap — runs after DOM ready
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
    const store = new PluginStore();
    const ui    = new PluginManagerUI(store);

    window.pluginStore = store; // available in console for debugging

    /* Fetch and display plugins.json immediately */
    try {
        const res = await fetch(PLUGINS_JSON_PATH);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        store.loadFromObject(data);
    } catch (err) {
        console.warn('[PluginManager] Could not load plugins.json:', err.message);
        ui._showStatus(
            `Could not load plugins.json (${err.message}). Add plugins manually or check the file path.`,
            'error'
        );
        ui._render();
    }
});