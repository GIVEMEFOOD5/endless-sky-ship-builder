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
const PLUGINS_JSON_PATH = 'https://givemefood5.github.io/endless-sky-ship-builder/plugins.json';
const PARSE_STATUS_PATH = 'https://api.github.com/repos/givemefood5/endless-sky-ship-builder/contents/parse-status.json';

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
        this._plugins   = [];
        this._pending   = [];
        this._listeners = [];
    }

    onChange(fn) { this._listeners.push(fn); }
    _notify()    { this._listeners.forEach(fn => fn()); }

    get plugins()      { return JSON.parse(JSON.stringify(this._plugins)); }
    get pending()      { return JSON.parse(JSON.stringify(this._pending)); }
    get count()        { return this._plugins.length; }
    get pendingCount() { return this._pending.length; }

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

    _allPlugins() {
        return [...this._plugins, ...this._pending];
    }

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

    removePlugin(index) {
        if (index < 0 || index >= this._plugins.length)
            return { ok: false, error: `No plugin at index ${index}.` };
        this._plugins.splice(index, 1);
        this._notify();
        return { ok: true };
    }

    removePending(index) {
        if (index < 0 || index >= this._pending.length)
            return { ok: false, error: `No pending plugin at index ${index}.` };
        this._pending.splice(index, 1);
        this._notify();
        return { ok: true };
    }

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
   
   Two modes:
     - "on-demand"  → GitHub Contents API (accurate, costs quota)
                      Called only on page load and before a save/remove.
     - "pages-poll" → GitHub Pages raw URL (free, ~1-10 min CDN lag)
                      Used only while a job is confirmed/optimistically
                      running, polling every 15 s until idle.
   ══════════════════════════════════════════════════════════════ */

const PARSE_STATUS_API_PATH =
    'https://api.github.com/repos/givemefood5/endless-sky-ship-builder/contents/parse-status.json';

const PARSE_STATUS_PAGES_PATH =
    'https://givemefood5.github.io/endless-sky-ship-builder/parse-status.json';

const PAGES_POLL_INTERVAL = 15_000; // 15 s — while job is running

class ParseStatusMonitor {
    constructor() {
        this._status           = null;   // 'running' | 'idle' | null
        this._startedAt        = null;
        this._completedAt      = null;
        this._listeners        = [];
        this._pagesPollTimer   = null;   // only active while running
        this._optimisticTimer  = null;
        this._confirmedRunning = false;
    }

    get isRunning()   { return this._status === 'running'; }
    get status()      { return this._status; }
    get startedAt()   { return this._startedAt; }
    get completedAt() { return this._completedAt; }

    onChange(fn) { this._listeners.push(fn); }
    _notify()    { this._listeners.forEach(fn => fn()); }

    /* ── Public: call on page-load and before every save/remove ─
       Returns the fresh status string so callers can gate on it. */
async poll() {
    // Step 1: try GitHub Pages (free, no rate limit)
    try {
        const res = await fetch(PARSE_STATUS_PAGES_PATH + '?t=' + Date.now());
        if (res.ok) {
            const data = await res.json();
            if (data.status === 'running') {
                // Pages says running — trust it, no need to hit the API
                this._applyStatus(data);
                this._startPagesPoll();
                return this._status;
            }
        }
    } catch {
        // Pages unreachable — fall through to API
    }

    // Step 2: Pages said idle (or failed) — confirm with the API
    try {
        const res = await fetch(PARSE_STATUS_API_PATH + '?t=' + Date.now(), {
            headers: {
                'Accept':               'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const envelope = await res.json();
        const raw      = atob(envelope.content.replace(/\n/g, ''));
        const data     = JSON.parse(raw);

        this._applyStatus(data);

    } catch {
        // Leave status as-is on total failure
    }

    if (this.isRunning) this._startPagesPoll();
    return this._status;
}

/* ── Shared status applier ───────────────────────────────────── */
_applyStatus(data) {
    const newStatus = data.status || null;

    if (newStatus === 'running') {
        this._confirmedRunning = true;
        clearTimeout(this._optimisticTimer);
        this._optimisticTimer = null;
    }

    // Don't drop out of running while optimistic and API still says idle
    if (newStatus === 'idle' && this._status === 'running' && !this._confirmedRunning) {
        return;
    }

    const changed =
        this._status      !== newStatus                   ||
        this._startedAt   !== (data.startedAt   || null)  ||
        this._completedAt !== (data.completedAt || null);

    this._status      = newStatus;
    this._startedAt   = data.startedAt   || null;
    this._completedAt = data.completedAt || null;

    if (changed) this._notify();

    if (newStatus === 'idle' && this._confirmedRunning) {
        this._confirmedRunning = false;
    }
}

    /* ── Called immediately after a save so UI shows "running" ─
       before GitHub Actions even starts.                        */
    forceOptimisticRunning() {
        const previousStatus   = this._status;
        this._status           = 'running';
        this._confirmedRunning = false;
        this._notify();

        // Safety net: revert if neither API nor Pages ever confirms running
        clearTimeout(this._optimisticTimer);
        this._optimisticTimer = setTimeout(() => {
            if (!this._confirmedRunning) {
                this._status = previousStatus;
                this._notify();
            }
            this._optimisticTimer = null;
        }, 180_000); // 3 min

        this._startPagesPoll();
    }

    /* ── Pages polling — only runs while job is running ──────── */
    _startPagesPoll() {
        this._stopPagesPoll(); // clear any existing timer
        this._pagesPollTimer = setTimeout(() => this._pollPages(), PAGES_POLL_INTERVAL);
    }

    _stopPagesPoll() {
        clearTimeout(this._pagesPollTimer);
        this._pagesPollTimer = null;
    }

async _pollPages() {
    this._pagesPollTimer = null;
    try {
        const res = await fetch(PARSE_STATUS_PAGES_PATH + '?t=' + Date.now());
        if (res.ok) {
            const data = await res.json();

            if (data.status === 'running') {
                this._confirmedRunning = true;
                clearTimeout(this._optimisticTimer);
                this._optimisticTimer = null;
                this._notify();
                // Still running — keep polling Pages
                this._pagesPollTimer = setTimeout(() => this._pollPages(), PAGES_POLL_INTERVAL);
                return;
            }

            // Pages says idle — verify with the API before unlocking
            const apiRes = await fetch(PARSE_STATUS_API_PATH + '?t=' + Date.now(), {
                headers: {
                    'Accept':               'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                }
            });
            if (!apiRes.ok) throw new Error(`API HTTP ${apiRes.status}`);
            const envelope = await apiRes.json();
            const apiData  = JSON.parse(atob(envelope.content.replace(/\n/g, '')));

            if (apiData.status === 'idle') {
                // Both agree — job is done
                this._applyStatus(apiData);
                // Stop polling — job is done
                return;
            }

            // API still says running — Pages CDN is stale, keep polling
            this._confirmedRunning = true;
            this._pagesPollTimer = setTimeout(() => this._pollPages(), PAGES_POLL_INTERVAL);
            return;
        }
    } catch {
        // Network hiccup — keep polling
    }

    if (this.isRunning) {
        this._pagesPollTimer = setTimeout(() => this._pollPages(), PAGES_POLL_INTERVAL);
    }
}

    stop() {
        this._stopPagesPoll();
        clearTimeout(this._optimisticTimer);
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
    this.addBtn.addEventListener('click',   () => this._handleAddOrEdit());
    this.clearBtn.addEventListener('click', () => this._handleClear());
    this.saveBtn.addEventListener('click',  () => this._handleSave());

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
        const status = this.monitor.status;

        if (status === 'running') {
            this.parseBarEl.className = 'parse-status-bar parse-status--running';
            this.parseBarEl.innerHTML =
                `<span class="parse-spinner"></span>` +
                `<strong>Parse job is currently running.</strong> ` +
                `Saving is disabled until it completes. This page will update automatically.`;
            this.saveBtn.disabled = true;

        } else if (status === 'idle') {
            this.parseBarEl.className = 'parse-status-bar parse-status--idle';
            this.parseBarEl.innerHTML = `✅ <strong>Parser idle.</strong> Ready to accept changes.`;
            this.saveBtn.disabled = false;

        } else {
            // null = unknown (first load or fetch failed)
            this.parseBarEl.className = 'parse-status-bar parse-status--idle';
            this.parseBarEl.innerHTML = `⏳ <strong>Checking parser status…</strong>`;
            this.saveBtn.disabled = false;
        }
    }

   /* ── Gate: poll API, show modal if running, return bool ─────── */
async _checkBeforeSave() {
    this.saveBtn.disabled = true;
    this._showStatus('Checking parser status…', 'info');

    const status = await this.monitor.poll();

    if (status === 'running') {
        this._showParserRunningModal();
        this.saveBtn.disabled = false;
        return false;
    }

    return true;
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

   _showParserRunningModal() {
    // Remove any existing modal
    document.getElementById('parserRunningModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'parserRunningModal';
    overlay.style.cssText = `
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999;
    `;

    overlay.innerHTML = `
        <div style="
            background: var(--color-background-primary);
            border: 1px solid var(--color-border-secondary);
            border-radius: 12px;
            padding: 28px 32px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18);
        ">
            <div style="font-size:32px; margin-bottom:12px;">⏳</div>
            <h2 style="margin:0 0 8px; font-size:18px; font-weight:500; color:var(--color-text-primary)">
                Parser is currently running
            </h2>
            <p style="margin:0 0 20px; font-size:14px; color:var(--color-text-secondary); line-height:1.6">
                A parse job is already in progress. Saving now could cause a conflict.
                Please wait for it to finish — this page will update automatically.
            </p>
            <button id="parserModalClose" style="
                padding: 8px 20px;
                border-radius: 8px;
                border: 1px solid var(--color-border-secondary);
                background: var(--color-background-secondary);
                color: var(--color-text-primary);
                font-size: 14px;
                cursor: pointer;
            ">Got it</button>
        </div>
    `;

    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector('#parserModalClose').addEventListener('click', () => overlay.remove());

    document.body.appendChild(overlay);
    this._showStatus('', '');
}
   
    /* ── Clear ───────────────────────────────────────────────── */
    _handleClear() {
        this._clearInputs();
        this._showStatus('', '');
    }

async _handleSave() {
    const canProceed = await this._checkBeforeSave();
    if (!canProceed) return;

    this._showStatus('Saving…', 'info');

    const result = await this.store.save();

    if (!result.ok) {
        this.saveBtn.disabled = false;
        this._showStatus('Save failed: ' + (result.error || ''), 'error');
        return;
    }

    this._showStatus('plugins.json saved! Parse job starting…', 'success');
    this.monitor.forceOptimisticRunning();
}

async _handleRemoveSave(removedName) {
    const canProceed = await this._checkBeforeSave();
    if (!canProceed) return;

    this._showStatus(`Removing "${removedName}"…`, 'info');
    const result = await this.store.save();

    if (!result.ok) {
        this.saveBtn.disabled = false;
        this._showStatus('Remove failed: ' + (result.error || ''), 'error');
        return;
    }

    this._showStatus(`"${removedName}" removed and saved.`, 'success');
    this.monitor.forceOptimisticRunning();
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

        this.statusEl.className   = `status-msg status--${type}`;
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

    ui._updateParseBar();

    window.pluginStore  = store;
    window.parseMonitor = monitor;

    // Load plugins and poll status in parallel — neither blocks the other
    const [pluginsResult] = await Promise.allSettled([
        fetch(PLUGINS_JSON_PATH).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        monitor.poll(), // on-load API check — if running, starts pages polling automatically
    ]);

    if (pluginsResult.status === 'fulfilled') {
        try { store.loadFromObject(pluginsResult.value); }
        catch (err) { ui._showStatus(err.message, 'error'); ui._render(); }
    } else {
        const msg = pluginsResult.reason?.message || 'Unknown error';
        ui._showStatus(`Could not load plugins.json (${msg}). Add plugins manually or check the file path.`, 'error');
        ui._render();
    }
});
