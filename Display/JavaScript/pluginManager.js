/* ═══════════════════════════════════════════════════════════════
   pluginManager.js  —  Endless Sky Plugin Manager
   Fetches plugins.json on page load, lets the user add / edit /
   remove entries, then saves back via the Vercel backend.

   Two lists:
     _plugins  — already committed to plugins.json (Active Plugins)
     _pending  — added this session, not yet saved (Awaiting Save)
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
        /** Already saved to plugins.json */
        this._plugins  = [];
        /** Added this session, not yet saved */
        this._pending  = [];
        this._listeners = [];
    }

    /* ── Observers ───────────────────────────────────────────── */
    onChange(fn) { this._listeners.push(fn); }
    _notify()    { this._listeners.forEach(fn => fn()); }

    /* ── Accessors ───────────────────────────────────────────── */
    get plugins()      { return JSON.parse(JSON.stringify(this._plugins)); }
    get pending()      { return JSON.parse(JSON.stringify(this._pending)); }
    get count()        { return this._plugins.length; }
    get pendingCount() { return this._pending.length; }

    /* ── Load from parsed object (populates _plugins only) ───── */
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

    /* ── Combined list used when saving ─────────────────────── */
    _allPlugins() {
        return [...this._plugins, ...this._pending];
    }

    /* ── Add to pending list ─────────────────────────────────── */
    addPlugin(name, repo) {
        const trimName = (name || '').trim();
        if (!trimName) return { ok: false, error: 'Plugin name cannot be empty.' };

        const normRepo = normaliseRepository(repo);
        if (!normRepo) return { ok: false, error: 'Invalid repository — use  username/repo  or a full GitHub URL.' };

        /* Check against both active and pending */
        const lower = trimName.toLowerCase();
        for (const list of [this._plugins, this._pending]) {
            for (const p of list) {
                if (p.name.toLowerCase() === lower)
                    return { ok: false, error: `A plugin named "${p.name}" already exists.` };
                if (p.repository === normRepo)
                    return { ok: false, error: `That repository is already listed as "${p.name}".` };
            }
        }

        this._pending.push({ name: trimName, repository: normRepo });
        this._notify();
        return { ok: true };
    }

    /* ── Edit active plugin ──────────────────────────────────── */
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
        for (const p of this._pending) {
            if (p.name.toLowerCase() === lower)
                return { ok: false, error: `A plugin named "${p.name}" is awaiting save.` };
            if (p.repository === normRepo)
                return { ok: false, error: `That repository is awaiting save as "${p.name}".` };
        }

        this._plugins[index] = { name: trimName, repository: normRepo };
        this._notify();
        return { ok: true };
    }

    /* ── Edit pending plugin ─────────────────────────────────── */
    editPending(index, name, repo) {
        if (index < 0 || index >= this._pending.length)
            return { ok: false, error: `No pending plugin at index ${index}.` };

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
        for (let i = 0; i < this._pending.length; i++) {
            if (i === index) continue;
            if (this._pending[i].name.toLowerCase() === lower)
                return { ok: false, error: `A plugin named "${this._pending[i].name}" already exists.` };
            if (this._pending[i].repository === normRepo)
                return { ok: false, error: `That repository is already listed as "${this._pending[i].name}".` };
        }

        this._pending[index] = { name: trimName, repository: normRepo };
        this._notify();
        return { ok: true };
    }

    /* ── Remove active plugin ────────────────────────────────── */
    removePlugin(index) {
        if (index < 0 || index >= this._plugins.length)
            return { ok: false, error: `No plugin at index ${index}.` };
        this._plugins.splice(index, 1);
        this._notify();
        return { ok: true };
    }

    /* ── Remove pending plugin ───────────────────────────────── */
    removePending(index) {
        if (index < 0 || index >= this._pending.length)
            return { ok: false, error: `No pending plugin at index ${index}.` };
        this._pending.splice(index, 1);
        this._notify();
        return { ok: true };
    }

    /* ── Save: merge pending into active, then commit ────────── */
    async save() {
        const payload = { plugins: this._allPlugins() };
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

            /* On success: move pending into active and clear pending */
            this._plugins = this._allPlugins();
            this._pending = [];
            this._notify();
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

        this.nameInput        = document.getElementById('pluginName');
        this.repoInput        = document.getElementById('repoUrl');
        this.addBtn           = document.getElementById('addPluginBtn');
        this.clearBtn         = document.getElementById('clearBtn');
        this.saveBtn          = document.getElementById('saveBtn');
        this.listEl           = document.getElementById('pluginActiveList');
        this.pendingListEl    = document.getElementById('pluginPendingList');
        this.pendingPanel     = document.getElementById('pendingPanel');
        this.counterEl        = document.getElementById('pluginCounter');
        this.pendingCounterEl = document.getElementById('pendingCounter');
        this.statusEl         = document.getElementById('statusMsg');
        this.searchEl         = document.getElementById('pluginSearch');

        this._editIndex   = null;   // index in _plugins (active)
        this._editPending = null;   // index in _pending
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

        this.searchEl.addEventListener('input', () => {
            this._searchQuery = this.searchEl.value.trim();
            this._render();
        });

        this.searchEl.addEventListener('search', () => {
            this._searchQuery = '';
            this._render();
        });
    }

    /* ── Add / edit ──────────────────────────────────────────── */
    _handleAddOrEdit() {
        let result;

        if (this._editPending !== null) {
            result = this.store.editPending(this._editPending, this.nameInput.value, this.repoInput.value);
        } else if (this._editIndex !== null) {
            result = this.store.editPlugin(this._editIndex, this.nameInput.value, this.repoInput.value);
        } else {
            result = this.store.addPlugin(this.nameInput.value, this.repoInput.value);
        }

        if (!result.ok) { this._showStatus(result.error, 'error'); return; }

        const wasEditing = this._editIndex !== null || this._editPending !== null;
        this._clearInputs();
        this._showStatus(wasEditing ? 'Plugin updated.' : 'Plugin staged — save when ready.', 'success');
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

        if (!result.ok) {
            this._showStatus('Save failed: ' + (result.error || ''), 'error');
            return;
        }

        this._showStatus('plugins.json saved!', 'success');
    }

    /* ── Start editing an active plugin ─────────────────────── */
    _startEdit(index) {
        const p = this.store.plugins[index];
        if (!p) return;
        this._editIndex       = index;
        this._editPending     = null;
        this.nameInput.value  = p.name;
        this.repoInput.value  = p.repository;
        this.addBtn.innerHTML = '<span>✏️</span> Save Changes';
        this.nameInput.focus();
        this._showStatus(`Editing active: ${p.name}`, 'info');
    }

    /* ── Start editing a pending plugin ─────────────────────── */
    _startEditPending(index) {
        const p = this.store.pending[index];
        if (!p) return;
        this._editPending     = index;
        this._editIndex       = null;
        this.nameInput.value  = p.name;
        this.repoInput.value  = p.repository;
        this.addBtn.innerHTML = '<span>✏️</span> Save Changes';
        this.nameInput.focus();
        this._showStatus(`Editing staged: ${p.name}`, 'info');
    }

    _clearInputs() {
        this._editIndex       = null;
        this._editPending     = null;
        this.nameInput.value  = '';
        this.repoInput.value  = '';
        this.addBtn.innerHTML = '<span>📥</span> Add Plugin';
    }

    /* ── Render both lists ───────────────────────────────────── */
    _render() {
        this._renderActive();
        this._renderPending();
    }

    /* ── Render active list ──────────────────────────────────── */
    _renderActive() {
        const plugins = this.store.plugins;
        const query   = this._searchQuery.toLowerCase();

        if (this.counterEl) this.counterEl.textContent = plugins.length;

        const filtered = query
            ? plugins.filter(p =>
                p.name.toLowerCase().includes(query) ||
                p.repository.toLowerCase().includes(query)
              )
            : plugins;

        if (plugins.length === 0) {
            this.listEl.innerHTML = '<div class="sorter-empty">No plugins yet — add one above.</div>';
            return;
        }

        if (filtered.length === 0) {
            this.listEl.innerHTML =
                `<div class="search-no-results">No plugins match "<strong>${esc(this._searchQuery)}</strong>".</div>`;
            return;
        }

        this.listEl.innerHTML = '';
        filtered.forEach(p => {
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
                <button class="btn-action plugin-edit-btn" data-i="${realIndex}" title="Edit">✏️</button>
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

    /* ── Render pending list + show/hide the panel ───────────── */
    _renderPending() {
        const pending = this.store.pending;

        if (this.pendingCounterEl) this.pendingCounterEl.textContent = pending.length;

        /* Show or hide the whole panel */
        if (pending.length === 0) {
            this.pendingPanel.classList.remove('has-items');
            this.pendingListEl.innerHTML = '';
            return;
        }

        this.pendingPanel.classList.add('has-items');
        this.pendingListEl.innerHTML = '';

        pending.forEach((p, i) => {
            const row = document.createElement('div');
            row.className = 'sorter-row';
            row.innerHTML = `
                <div class="sorter-label">
                    <span class="plugin-list-name">${esc(p.name)}</span>
                    <span class="plugin-list-repo">${esc(p.repository)}</span>
                </div>
                <button class="btn-action plugin-edit-btn" data-i="${i}" title="Edit">✏️</button>
                <button class="sorter-remove-btn plugin-rm-btn" data-i="${i}" title="Remove">✕ Remove</button>
            `;

            row.querySelector('.plugin-edit-btn').addEventListener('click', e => {
                e.stopPropagation();
                this._startEditPending(+e.currentTarget.dataset.i);
            });

            row.querySelector('.plugin-rm-btn').addEventListener('click', e => {
                e.stopPropagation();
                const idx  = +e.currentTarget.dataset.i;
                const name = this.store.pending[idx]?.name ?? 'this plugin';
                if (confirm(`Remove "${name}" from the pending list?`)) {
                    if (this._editPending === idx) this._clearInputs();
                    this.store.removePending(idx);
                }
            });

            this.pendingListEl.appendChild(row);
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