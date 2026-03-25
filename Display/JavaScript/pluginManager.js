/* ═══════════════════════════════════════════════════════════════
   pluginManager.js  —  Endless Sky Plugin Manager
   Fetches plugins.json on page load, lets the user add / edit /
   remove entries, then saves back via fetch POST or download.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── Path to the JSON file (relative to this HTML page) ─────── */
const PLUGINS_JSON_PATH = 'https://givemefood5.github.io/endless-sky-ship-builder/plugins.json';
const BACKEND_URL = 'https://vercel-for-endless-sky-ship-builder.vercel.app/api/update-json';

/* ── Optional: shared secret for basic auth protection ──────────
   Set to null to disable.  Must match SECRET_KEY in Vercel env.  */
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

    /* ── Save back to plugins.json ───────────────────────────── */
     async save() {
        /* Build the payload the backend expects */
        const payload = { plugins: this._plugins };
    
        const headers = { 'Content-Type': 'application/json' };
    
        /* Attach the shared secret if one is configured */
        if (UPDATE_SECRET) {
            headers['X-Update-Secret'] = UPDATE_SECRET;
        }
    
        try {
            const res = await fetch(BACKEND_URL, {
                method:  'POST',
                headers,
                body:    JSON.stringify(payload),
            });
        
            /* Try to parse JSON; fall back gracefully if response isn't JSON */
            let data;
            try {
                data = await res.json();
            } catch {
                data = {};
            }
        
            if (!res.ok) {
                /* Backend returned a 4xx / 5xx — surface the error message */
                return {
                    ok:    false,
                    error: data.error || `Server error ${res.status}`,
                };
            }
        
            return { ok: true };
        
        } catch (networkErr) {
            /* Fetch itself failed (no connection, CORS blocked, etc.) */
            return {
                ok:    false,
                error: `Network error: ${networkErr.message}`,
            };
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

        this._editIndex   = null;
        this._statusTimer = null;

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

        this._showStatus(
            result.downloaded
                ? 'Downloaded plugins.json — replace your existing file with this one.'
                : 'plugins.json saved!',
            result.downloaded ? 'info' : 'success'
        );
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

    /* ── Render list ─────────────────────────────────────────── */
    _render() {
        const plugins = this.store.plugins;

        if (this.counterEl) this.counterEl.textContent = plugins.length;

        if (plugins.length === 0) {
            this.listEl.innerHTML =
                '<div class="sorter-empty">No plugins yet — add one above.</div>';
            return;
        }

        this.listEl.innerHTML = '';
        plugins.forEach((p, i) => {
            const row = document.createElement('div');
            row.className = 'sorter-row';
            row.innerHTML = `
                <div class="sorter-label">
                    <span class="plugin-list-name">${esc(p.name)}</span>
                    <span class="plugin-list-repo">${esc(p.repository)}</span>
                </div>
                <button class="btn-action plugin-edit-btn"      data-i="${i}" title="Edit">✏️</button>
                <button class="sorter-remove-btn plugin-rm-btn" data-i="${i}" title="Remove">✕ Remove</button>
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
