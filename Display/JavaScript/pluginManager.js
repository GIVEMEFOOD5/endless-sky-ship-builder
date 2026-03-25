/* ═══════════════════════════════════════════════════════════════
   pluginManager.js  —  Endless Sky Plugin Manager
   Handles loading, saving, adding & removing plugins from
   the plugins.json config file via the File System Access API,
   with a localStorage fallback for browsers that don't support it.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── Constants ────────────────────────────────────────────────── */
const STORAGE_KEY   = 'endlessSkyPlugins';
const DEFAULT_STORE = { plugins: [] };

/* ── Helpers ──────────────────────────────────────────────────── */

/**
 * Parse a raw GitHub URL or "username/repo" shorthand into the
 * canonical https://github.com/username/repo form.
 * Returns null if the input can't be resolved.
 *
 * Accepted formats:
 *   - username/repo
 *   - https://github.com/username/repo
 *   - https://github.com/username/repo/tree/branch  (trimmed to root)
 *   - http://github.com/…
 */
function normaliseRepository(raw) {
    const s = raw.trim();
    if (!s) return null;

    // Already a full GitHub URL
    if (/^https?:\/\/github\.com\//i.test(s)) {
        const match = s.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)/i);
        return match ? `https://github.com/${match[1]}` : null;
    }

    // Short "username/repo" form
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
        return `https://github.com/${s}`;
    }

    return null;
}

/**
 * Deep-clone a plain object (avoids mutating the live store).
 */
function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/* ══════════════════════════════════════════════════════════════
   PluginStore — single source of truth for plugin data
   ══════════════════════════════════════════════════════════════ */
class PluginStore {
    constructor() {
        /** @type {{ plugins: Array<{ name: string, repository: string }> }} */
        this._data = clone(DEFAULT_STORE);

        /** File handle when the user has opened / saved a real plugins.json */
        this._fileHandle = null;

        /** Callbacks registered with .onChange() */
        this._listeners = [];
    }

    /* ── Public getters ──────────────────────────────────────── */

    /** Returns a deep copy of the current plugin list. */
    get plugins() {
        return clone(this._data.plugins);
    }

    /** True when a real file has been linked. */
    get hasFile() {
        return this._fileHandle !== null;
    }

    /* ── Change notifications ─────────────────────────────────── */

    /** Register a callback invoked whenever the store changes. */
    onChange(fn) {
        this._listeners.push(fn);
    }

    _notify() {
        this._listeners.forEach(fn => fn(this.plugins));
    }

    /* ── Persistence ──────────────────────────────────────────── */

    /**
     * Serialise the store to a pretty-printed JSON string.
     */
    toJSON() {
        return JSON.stringify(this._data, null, 2);
    }

    /**
     * Load data from a JSON string.  Validates structure and
     * populates the store.  Returns an error message or null.
     */
    fromJSON(jsonString) {
        try {
            const parsed = JSON.parse(jsonString);

            if (!parsed || typeof parsed !== 'object') {
                return 'Invalid JSON: expected an object at root.';
            }
            if (!Array.isArray(parsed.plugins)) {
                return 'Invalid format: missing "plugins" array.';
            }
            for (const p of parsed.plugins) {
                if (typeof p.name !== 'string' || typeof p.repository !== 'string') {
                    return 'Invalid format: each plugin must have "name" and "repository" strings.';
                }
            }

            this._data = { plugins: parsed.plugins };
            return null;                             // success
        } catch (e) {
            return `JSON parse error: ${e.message}`;
        }
    }

    /**
     * Save to localStorage as a fallback.
     */
    saveToLocalStorage() {
        try {
            localStorage.setItem(STORAGE_KEY, this.toJSON());
        } catch (_) { /* quota exceeded — silently ignore */ }
    }

    /**
     * Load from localStorage.  Returns true on success.
     */
    loadFromLocalStorage() {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const err = this.fromJSON(raw);
        return err === null;
    }

    /* ── File System Access API ───────────────────────────────── */

    /**
     * Prompt the user to pick an existing plugins.json and load it.
     * Returns { ok: true } or { ok: false, error: string }.
     */
    async openFile() {
        if (!('showOpenFilePicker' in window)) {
            return { ok: false, error: 'File System Access API not supported in this browser. Using localStorage fallback.' };
        }

        try {
            const [handle] = await window.showOpenFilePicker({
                types: [{
                    description: 'JSON files',
                    accept: { 'application/json': ['.json'] }
                }],
                multiple: false
            });

            const file = await handle.getFile();
            const text = await file.text();
            const err  = this.fromJSON(text);

            if (err) return { ok: false, error: err };

            this._fileHandle = handle;
            this._notify();
            return { ok: true };

        } catch (e) {
            if (e.name === 'AbortError') return { ok: false, error: 'cancelled' };
            return { ok: false, error: e.message };
        }
    }

    /**
     * Write the current store back to the linked file, or
     * prompt the user to save a new file if no handle exists.
     * Returns { ok: true } or { ok: false, error: string }.
     */
    async saveFile() {
        if (!('showSaveFilePicker' in window)) {
            // Fallback: trigger a browser download
            this._downloadJSON();
            return { ok: true, fallback: true };
        }

        try {
            // If we don't have a file handle yet (or it lost permission), ask
            if (!this._fileHandle || !(await this._verifyPermission(this._fileHandle, 'readwrite'))) {
                this._fileHandle = await window.showSaveFilePicker({
                    suggestedName: 'plugins.json',
                    types: [{
                        description: 'JSON files',
                        accept: { 'application/json': ['.json'] }
                    }]
                });
            }

            const writable = await this._fileHandle.createWritable();
            await writable.write(this.toJSON());
            await writable.close();
            return { ok: true };

        } catch (e) {
            if (e.name === 'AbortError') return { ok: false, error: 'cancelled' };
            return { ok: false, error: e.message };
        }
    }

    /** Fallback: trigger a download of plugins.json */
    _downloadJSON() {
        const blob = new Blob([this.toJSON()], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'plugins.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    /** Check / request readwrite permission on a file handle. */
    async _verifyPermission(handle, mode) {
        const opts = { mode };
        return (
            (await handle.queryPermission(opts))  === 'granted' ||
            (await handle.requestPermission(opts)) === 'granted'
        );
    }

    /* ── CRUD ─────────────────────────────────────────────────── */

    /**
     * Add a plugin.
     * @param {string} name  — display name (trimmed)
     * @param {string} repo  — raw URL / shorthand (will be normalised)
     * @returns {{ ok: boolean, error?: string }}
     */
    addPlugin(name, repo) {
        const trimName = name.trim();
        if (!trimName) return { ok: false, error: 'Plugin name cannot be empty.' };

        const normRepo = normaliseRepository(repo);
        if (!normRepo) return { ok: false, error: 'Invalid repository URL or username/repo format.' };

        // Duplicate check (case-insensitive name OR same repo)
        const lower = trimName.toLowerCase();
        for (const p of this._data.plugins) {
            if (p.name.toLowerCase() === lower) {
                return { ok: false, error: `A plugin named "${p.name}" already exists.` };
            }
            if (p.repository === normRepo) {
                return { ok: false, error: `Repository already added as "${p.name}".` };
            }
        }

        this._data.plugins.push({ name: trimName, repository: normRepo });
        this.saveToLocalStorage();
        this._notify();
        return { ok: true };
    }

    /**
     * Remove a plugin by index.
     * @param {number} index
     * @returns {{ ok: boolean, error?: string }}
     */
    removePlugin(index) {
        if (index < 0 || index >= this._data.plugins.length) {
            return { ok: false, error: `No plugin at index ${index}.` };
        }
        this._data.plugins.splice(index, 1);
        this.saveToLocalStorage();
        this._notify();
        return { ok: true };
    }

    /**
     * Edit an existing plugin in-place.
     * @param {number} index
     * @param {string} name
     * @param {string} repo
     * @returns {{ ok: boolean, error?: string }}
     */
    editPlugin(index, name, repo) {
        if (index < 0 || index >= this._data.plugins.length) {
            return { ok: false, error: `No plugin at index ${index}.` };
        }

        const trimName = name.trim();
        if (!trimName) return { ok: false, error: 'Plugin name cannot be empty.' };

        const normRepo = normaliseRepository(repo);
        if (!normRepo) return { ok: false, error: 'Invalid repository URL or username/repo format.' };

        // Duplicate check excluding current index
        const lower = trimName.toLowerCase();
        for (let i = 0; i < this._data.plugins.length; i++) {
            if (i === index) continue;
            if (this._data.plugins[i].name.toLowerCase() === lower) {
                return { ok: false, error: `A plugin named "${this._data.plugins[i].name}" already exists.` };
            }
            if (this._data.plugins[i].repository === normRepo) {
                return { ok: false, error: `Repository already added as "${this._data.plugins[i].name}".` };
            }
        }

        this._data.plugins[index] = { name: trimName, repository: normRepo };
        this.saveToLocalStorage();
        this._notify();
        return { ok: true };
    }
}

/* ══════════════════════════════════════════════════════════════
   PluginManagerUI — wires the DOM to PluginStore
   ══════════════════════════════════════════════════════════════ */
class PluginManagerUI {
    /**
     * @param {PluginStore} store
     * @param {Object} els — object mapping element IDs / selectors
     */
    constructor(store, els) {
        this.store = store;
        this.els   = els;

        /** Index being edited, or null */
        this._editIndex = null;

        this._bind();
        this.store.onChange(() => this._render());
    }

    /* ── Bind events ──────────────────────────────────────────── */
    _bind() {
        const { addBtn, clearBtn, openFileBtn, saveFileBtn, nameInput, repoInput } = this.els;

        addBtn.addEventListener('click', () => this._handleAdd());

        clearBtn.addEventListener('click', () => {
            nameInput.value = '';
            repoInput.value = '';
            this._cancelEdit();
            this._showStatus('', '');
        });

        openFileBtn?.addEventListener('click', () => this._handleOpenFile());
        saveFileBtn?.addEventListener('click', () => this._handleSaveFile());

        // Allow Enter key to submit
        [nameInput, repoInput].forEach(el => {
            el.addEventListener('keydown', e => {
                if (e.key === 'Enter') this._handleAdd();
            });
        });
    }

    /* ── Add / Edit ───────────────────────────────────────────── */
    _handleAdd() {
        const name = this.els.nameInput.value;
        const repo = this.els.repoInput.value;

        let result;
        if (this._editIndex !== null) {
            result = this.store.editPlugin(this._editIndex, name, repo);
        } else {
            result = this.store.addPlugin(name, repo);
        }

        if (!result.ok) {
            this._showStatus(result.error, 'error');
            return;
        }

        this.els.nameInput.value = '';
        this.els.repoInput.value = '';
        this._cancelEdit();

        const action = this._editIndex !== null ? 'updated' : 'added';
        this._showStatus(`Plugin ${action} successfully!`, 'success');
    }

    /* ── File operations ──────────────────────────────────────── */
    async _handleOpenFile() {
        this._showStatus('Opening file…', 'info');
        const result = await this.store.openFile();

        if (!result.ok) {
            if (result.error !== 'cancelled') this._showStatus(result.error, 'error');
            else this._showStatus('', '');
            return;
        }
        this._showStatus('plugins.json loaded successfully!', 'success');
    }

    async _handleSaveFile() {
        this._showStatus('Saving…', 'info');
        const result = await this.store.saveFile();

        if (!result.ok) {
            if (result.error !== 'cancelled') this._showStatus(result.error, 'error');
            else this._showStatus('', '');
            return;
        }

        const msg = result.fallback
            ? 'Downloaded plugins.json (File System API not available).'
            : 'plugins.json saved successfully!';
        this._showStatus(msg, 'success');
    }

    /* ── Edit & cancel ────────────────────────────────────────── */
    _startEdit(index) {
        const p = this.store.plugins[index];
        if (!p) return;

        this._editIndex = index;
        this.els.nameInput.value = p.name;
        this.els.repoInput.value = p.repository;
        this.els.addBtn.textContent = '✏️ Save Changes';
        this.els.nameInput.focus();
        this._showStatus(`Editing: ${p.name}`, 'info');
    }

    _cancelEdit() {
        this._editIndex = null;
        this.els.addBtn.innerHTML = '<span>📥</span> Add Plugin';
    }

    /* ── Render plugin list ───────────────────────────────────── */
    _render() {
        const list    = this.els.pluginList;
        const counter = this.els.pluginCounter;
        const plugins = this.store.plugins;

        // Update counter
        if (counter) {
            counter.textContent = plugins.length;
        }

        // Empty state
        if (plugins.length === 0) {
            list.innerHTML = `
                <div class="sorter-empty">
                    No plugins added yet. Enter a name and repository URL above to get started.
                </div>`;
            return;
        }

        list.innerHTML = '';
        plugins.forEach((p, i) => {
            const row = document.createElement('div');
            row.className = 'sorter-row';
            row.innerHTML = `
                <div class="sorter-label">
                    <span class="plugin-list-name">${this._esc(p.name)}</span>
                    <span class="plugin-list-repo">${this._esc(p.repository)}</span>
                </div>
                <button class="btn-action plugin-edit-btn" data-index="${i}" title="Edit plugin">✏️</button>
                <button class="sorter-remove-btn plugin-remove-btn" data-index="${i}" title="Remove plugin">✕ Remove</button>
            `;

            row.querySelector('.plugin-edit-btn').addEventListener('click', e => {
                e.stopPropagation();
                this._startEdit(parseInt(e.currentTarget.dataset.index, 10));
            });

            row.querySelector('.plugin-remove-btn').addEventListener('click', e => {
                e.stopPropagation();
                const idx = parseInt(e.currentTarget.dataset.index, 10);
                const name = this.store.plugins[idx]?.name ?? 'this plugin';
                if (confirm(`Remove "${name}"?`)) {
                    this.store.removePlugin(idx);
                    if (this._editIndex === idx) this._cancelEdit();
                }
            });

            list.appendChild(row);
        });
    }

    /* ── Status banner ────────────────────────────────────────── */
    /**
     * @param {string} message
     * @param {'success'|'error'|'info'|''} type
     */
    _showStatus(message, type) {
        const el = this.els.statusMsg;
        if (!el) return;

        if (!message) { el.classList.add('hidden'); return; }

        el.classList.remove('hidden', 'status--success', 'status--error', 'status--info');
        if (type) el.classList.add(`status--${type}`);
        el.textContent = message;

        // Auto-hide success messages after 3 s
        if (type === 'success') {
            clearTimeout(this._statusTimer);
            this._statusTimer = setTimeout(() => {
                el.classList.add('hidden');
            }, 3000);
        }
    }

    /* ── Utility ──────────────────────────────────────────────── */
    _esc(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

/* ══════════════════════════════════════════════════════════════
   Bootstrap — runs after DOM is ready
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

    /* Collect DOM elements */
    const els = {
        nameInput:     document.getElementById('pluginName'),
        repoInput:     document.getElementById('repoUrl'),
        addBtn:        document.getElementById('addPluginBtn'),
        clearBtn:      document.getElementById('clearBtn'),
        openFileBtn:   document.getElementById('openFileBtn'),
        saveFileBtn:   document.getElementById('saveFileBtn'),
        pluginList:    document.getElementById('pluginActiveList'),
        pluginCounter: document.getElementById('pluginCounter'),
        statusMsg:     document.getElementById('statusMsg'),
    };

    /* Validate required elements exist */
    const required = ['nameInput', 'repoInput', 'addBtn', 'clearBtn', 'pluginList'];
    for (const key of required) {
        if (!els[key]) {
            console.error(`[PluginManager] Required element not found: #${key}`);
        }
    }

    /* Create store and UI */
    const store = new PluginStore();
    const ui    = new PluginManagerUI(store, els);

    /* Expose store globally for debugging / other scripts */
    window.pluginStore = store;

    /* Seed with default plugins if localStorage is empty */
    if (!store.loadFromLocalStorage()) {
        store.addPlugin('official-game',  'https://github.com/endless-sky/endless-sky');
        store.addPlugin("Zuckungs list",  'https://github.com/zuckung/endless-sky-plugins');
    }

    /* Initial render */
    ui._render();
});
