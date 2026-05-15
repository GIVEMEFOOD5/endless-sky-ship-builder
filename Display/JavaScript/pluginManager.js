/* ═══════════════════════════════════════════════════════════════
   pluginManager.js  —  Endless Sky Plugin Manager
   Fetches plugins.json on page load, lets the user add / edit /
   remove entries, then saves back via the Vercel backend.

   Two lists:
     _plugins  — already committed to plugins.json (Active Plugins)
     _pending  — added this session, not yet saved (Awaiting Save)

   Also polls parse-status.json to show when the GitHub Action is
   running, and blocks saves during that window.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── Paths ───────────────────────────────────────────────────── */
const PLUGINS_JSON_PATH  = 'https://givemefood5.github.io/endless-sky-ship-builder/plugins.json';
const PARSE_STATUS_PATH = 'https://raw.githubusercontent.com/givemefood5/endless-sky-ship-builder/main/parse-status.json';

/* ── Vercel backend endpoint ─────────────────────────────────── */
const BACKEND_URL = 'https://vercel-for-endless-sky-ship-builder.vercel.app/api/update-json';

/* ── Optional shared secret (must match SECRET_KEY in Vercel env) */
const UPDATE_SECRET = null;

/* ── Poll intervals ──────────────────────────────────────────── */
const POLL_INTERVAL_RUNNING    = 30_000;  // 30 s  — while parse is active
const POLL_INTERVAL_IDLE       = 120_000; // 2 min — background keep-alive
const POLL_INTERVAL_AFTER_SAVE = 8_000;  // 8 s   — rapid checks just after a save
const POLL_AFTER_SAVE_DURATION = 180_000; // 3 min — how long to keep rapid-polling

/* ══════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════ */

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
   ParseStatusMonitor
   Polls parse-status.json and notifies listeners of changes.
   ══════════════════════════════════════════════════════════════ */
class ParseStatusMonitor {
    constructor() {
        this._status        = null;   // 'running' | 'idle' | null (unknown)
        this._startedAt     = null;
        this._completedAt   = null;
        this._listeners     = [];
        this._timer         = null;
        this._rapidDeadline = null;   // timestamp until which we rapid-poll
    }

    get isRunning()    { return this._status === 'running'; }
    get status()       { return this._status; }
    get startedAt()    { return this._startedAt; }
    get completedAt()  { return this._completedAt; }

    onChange(fn) { this._listeners.push(fn); }
    _notify()    { this._listeners.forEach(fn => fn()); }

    /**
     * Call this immediately after a save so we poll rapidly for the next
     * POLL_AFTER_SAVE_DURATION ms, catching the moment the Action flips
     * parse-status.json to "running".
     */
    pollAfterSave() {
        this._rapidDeadline = Date.now() + POLL_AFTER_SAVE_DURATION;
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.poll(), POLL_INTERVAL_AFTER_SAVE);
    }

    async poll() {
        clearTimeout(this._timer);

        try {
            const res  = await fetch(PARSE_STATUS_PATH + '?t=' + Date.now());
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            const changed =
                this._status      !== (data.status      || null) ||
                this._startedAt   !== (data.startedAt   || null) ||
                this._completedAt !== (data.completedAt || null);

            this._status      = data.status      || null;
            this._startedAt   = data.startedAt   || null;
            this._completedAt = data.completedAt || null;

            if (changed) this._notify();
        } catch {
            /* parse-status.json missing or network error — treat as unknown */
            if (this._status !== null) {
                this._status = null;
                this._notify();
            }
        }

        /* Pick next interval:
           - running           → 30 s (keep checking until it goes idle)
           - within rapid window → 8 s (just saved, watching for Action to start)
           - idle / unknown    → 2 min (background keep-alive)               */
        let interval;
        if (this.isRunning) {
            interval = POLL_INTERVAL_RUNNING;
            this._rapidDeadline = null; // no longer need rapid mode
        } else if (this._rapidDeadline && Date.now() < this._rapidDeadline) {
            interval = POLL_INTERVAL_AFTER_SAVE;
        } else {
            interval = POLL_INTERVAL_IDLE;
        }

        this._timer = setTimeout(() => this.poll(), interval);
    }

    stop() {
        clearTimeout(this._timer);
    }
}

/* ══════════════════════════════════════════════════════════════
   PluginManagerUI
   ══════════════════════════════════════════════════════════════ */
class PluginManagerUI {
    constructor(store, monitor) {
        this.store   = store;
        this.monitor = monitor;

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
        this.parseBarEl       = document.getElementById('parseStatusBar');

        this._editIndex   = null;
        this._editPending = null;
        this._statusTimer = null;
        this._searchQuery = '';

        this._bindEvents();
        this.store.onChange(()   => this._render());
        this.monitor.onChange(() => this._updateParseBar());
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

    /* ── Parse status bar ────────────────────────────────────── */
   _updateParseBar() {
       if (!this.parseBarEl) return;
      const { status, startedAt, completedAt } = this.monitor;
      
       // If we're no longer idle, cancel any pending hide
       if (status !== 'idle') {
           clearTimeout(this._idleHideTimer);
           this._idleHideTimer = null;
       }
      
        if (status === 'running') {
            this.parseBarEl.className   = 'parse-status-bar parse-status--running';
            this.parseBarEl.innerHTML   =
                `<span class="parse-spinner"></span>` +
                `<strong>Parse job is currently running.</strong> ` +
                `Saving is disabled until it completes. This page will update automatically.`;
            this.saveBtn.disabled = true;
        } else if (status === 'idle') {
             this.parseBarEl.className = 'parse-status-bar parse-status--idle';
             this.parseBarEl.innerHTML = `✅ <strong>Parser idle.</strong>`;
             this.saveBtn.disabled = false;

             // Only start the hide timer once, not on every poll
             if (!this._idleHideTimer) {
                 this._idleHideTimer = setTimeout(() => {
                     this._idleHideTimer = null;   // ← clear the ref so next idle cycle works
                     if (!this.monitor.isRunning) {
                         this.parseBarEl.className = 'parse-status-bar parse-status--hidden';
                     }
                 }, 8000);
             }
         } else {
            /* Status unknown (file missing / network error) — don't block */
            this.parseBarEl.className = 'parse-status-bar parse-status--hidden';
            this.saveBtn.disabled     = false;
        }
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

    /* ── Save after a remove (no pending check needed) ──────── */
    async _handleRemoveSave(removedName) {
        if (this.monitor.isRunning) {
            this._showStatus('Cannot save while the parse job is running.', 'error');
            return;
        }
        this.saveBtn.disabled = true;
        this._showStatus(`Removing "${removedName}"…`, 'info');
        const result = await this.store.save();
        this.saveBtn.disabled = this.monitor.isRunning;
        if (!result.ok) {
            this._showStatus('Remove failed: ' + (result.error || ''), 'error');
            return;
        }
        this._showStatus(`"${removedName}" removed and saved.`, 'success');
        this.monitor.pollAfterSave();
    }

    /* ── Save ────────────────────────────────────────────────── */
    async _handleSave() {
        if (this.monitor.isRunning) {
            this._showStatus('Cannot save while the parse job is running. Please wait.', 'error');
            return;
        }

        this.saveBtn.disabled = true;
        this._showStatus('Saving…', 'info');

        const result = await this.store.save();

        /* Re-evaluate disabled state from monitor (not just re-enable blindly) */
        this.saveBtn.disabled = this.monitor.isRunning;

        if (!result.ok) {
            this._showStatus('Save failed: ' + (result.error || ''), 'error');
            return;
        }

        this._showStatus('plugins.json saved! The parse job will start shortly.', 'success');
        this.monitor.pollAfterSave();
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
                    const result = this.store.removePlugin(idx);
                    if (result.ok) this._handleRemoveSave(name);
                }
            });

            this.listEl.appendChild(row);
        });
    }

    /* ── Render pending list + show/hide the panel ───────────── */
    _renderPending() {
        const pending = this.store.pending;

        if (this.pendingCounterEl) this.pendingCounterEl.textContent = pending.length;

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

    /* ── Status banner (auto-hides on success) ───────────────── */
    _showStatus(msg, type) {
        if (!this.statusEl) return;
        clearTimeout(this._statusTimer);

        if (!msg) { this.statusEl.className = 'status-msg hidden'; return; }

        this.statusEl.className  = `status-msg status--${type}`;
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
    const store   = new PluginStore();
    const monitor = new ParseStatusMonitor();
    const ui      = new PluginManagerUI(store, monitor);

    window.pluginStore   = store;   // available in console for debugging
    window.parseMonitor  = monitor;

    /* Load plugins immediately — don't wait for parse status */
    try {
        const res  = await fetch(PLUGINS_JSON_PATH);
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

    /* Poll parse status independently — won't delay the list */
    monitor.poll();
});
