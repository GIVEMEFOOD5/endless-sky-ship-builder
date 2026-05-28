'use strict';

// ─── CompareDisplay.js ────────────────────────────────────────────────────────

window.CompareDisplay = (() => {

    let _panelOpen = false;
    let _viewMode  = 'columns';

    // ── DOM bootstrap ─────────────────────────────────────────────────────────

    function init() {
        _injectBar();
        _injectPanel();

        window.addEventListener('compareListChanged', () => {
            _refreshBar();
            if (_panelOpen) _renderPanelContent();
        });
    }

    // ── Bottom bar ────────────────────────────────────────────────────────────

    function _injectBar() {
        const bar = document.createElement('div');
        bar.id        = 'compareBar';
        bar.className = 'compare-bar';
        bar.innerHTML = `
            <div class="compare-bar__left">
                <span class="compare-bar__icon">⚖</span>
                <div class="compare-bar__scroll" id="compareBarScroll">
                    <span class="compare-bar__label" id="compareBarLabel">Compare — nothing selected</span>
                    <div class="compare-bar__chips" id="compareBarChips"></div>
                </div>
            </div>
            <div class="compare-bar__right">
                <button class="compare-bar__clear" id="compareBarClear" onclick="window.CompareDisplay.clearAll()">Clear</button>
                <button class="compare-bar__open"  id="compareBarOpen"  onclick="window.CompareDisplay.togglePanel()">
                    <span id="compareBarOpenLabel">Open Compare ▲</span>
                </button>
            </div>
        `;
        document.body.appendChild(bar);
        _refreshBar();
    }

    function _refreshBar() {
        const items     = window.CompareManager.getItems();
        const count     = items.length;
        const label     = document.getElementById('compareBarLabel');
        const chips     = document.getElementById('compareBarChips');
        const clearBtn  = document.getElementById('compareBarClear');
        const openBtn   = document.getElementById('compareBarOpen');
        const openLabel = document.getElementById('compareBarOpenLabel');
        const bar       = document.getElementById('compareBar');

        if (!label) return;

        const groupType = window.CompareManager.getGroupType();
        const groupStr  = groupType === 'ship' ? 'ships/variants' : 'outfits';
        label.textContent = count === 0
            ? 'Compare — nothing selected'
            : `Compare — ${count} ${groupStr}`;

        chips.innerHTML = '';
        items.forEach(item => {
            const chip = document.createElement('span');
            chip.className   = 'compare-bar__chip';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = item['display name'] || item.name || '?';
            chip.appendChild(nameSpan);

            const x = document.createElement('button');
            x.className   = 'compare-bar__chip-remove';
            x.textContent = '×';
            x.onclick = (e) => { e.stopPropagation(); window.CompareManager.remove(item); };
            chip.appendChild(x);
            chips.appendChild(chip);
        });

        clearBtn.style.display = count > 0 ? '' : 'none';
        openBtn.style.display  = count > 1 ? '' : 'none';
        openLabel.textContent  = _panelOpen ? 'Close Compare ▼' : 'Open Compare ▲';
        bar.classList.toggle('compare-bar--has-items', count > 0);
    }

    // ── Panel ─────────────────────────────────────────────────────────────────

    function _injectPanel() {
        const panel = document.createElement('div');
        panel.id        = 'comparePanel';
        panel.className = 'compare-panel';
        panel.innerHTML = `
            <div class="compare-panel__header">
                <h2 class="compare-panel__title">⚖ Compare</h2>
                <div class="compare-panel__controls">
                    <div class="compare-toggle" id="compareToggle">
                        <button class="compare-toggle__btn compare-toggle__btn--active" data-mode="columns" onclick="window.CompareDisplay.setViewMode('columns')">Columns</button>
                        <button class="compare-toggle__btn" data-mode="table" onclick="window.CompareDisplay.setViewMode('table')">Table</button>
                    </div>
                    <button class="compare-panel__close" onclick="window.CompareDisplay.togglePanel()">✕</button>
                </div>
            </div>
            <div class="compare-panel__body" id="comparePanelBody">
                <p class="compare-empty">Add at least two items to compare.</p>
            </div>
        `;
        document.body.appendChild(panel);
    }

    function _renderPanelContent() {
        const body  = document.getElementById('comparePanelBody');
        const items = window.CompareManager.getItems();
        if (!body) return;
        body.innerHTML = '';
        if (items.length < 2) {
            body.innerHTML = '<p class="compare-empty">Add at least two items to compare.</p>';
            return;
        }
        if (_viewMode === 'columns') _renderColumns(body, items);
        else                         _renderTable(body, items);
    }

    // ── Columns view ──────────────────────────────────────────────────────────

    function _renderColumns(container, items) {
        const grid = document.createElement('div');
        grid.className = 'compare-columns';
        grid.style.gridTemplateColumns = `repeat(${items.length}, minmax(220px, 1fr))`;

        items.forEach(item => {
            const col = document.createElement('div');
            col.className = 'compare-col';

            const header = document.createElement('div');
            header.className = 'compare-col__header';

            const removeBtn = document.createElement('button');
            removeBtn.className   = 'compare-col__remove';
            removeBtn.textContent = '× Remove';
            removeBtn.onclick     = () => window.CompareManager.remove(item);

            const img = document.createElement('div');
            img.className = 'compare-col__img';
            _loadThumb(item, img);

            const name = document.createElement('div');
            name.className   = 'compare-col__name';
            name.textContent = item['display name'] || item.name || 'Unknown';

            const sub = document.createElement('div');
            sub.className   = 'compare-col__sub';
            sub.textContent = item['display name'] ? item.name : (item.attributes?.category || item.category || '');

            header.appendChild(removeBtn);
            header.appendChild(img);
            header.appendChild(name);
            if (sub.textContent) header.appendChild(sub);
            col.appendChild(header);

            const attrs = _getDisplayAttrs(item);
            attrs.forEach(({ key, value }) => {
                const row = document.createElement('div');
                row.className = 'compare-col__row';
                const k = document.createElement('div');
                k.className   = 'compare-col__key';
                k.textContent = key;
                const v = document.createElement('div');
                v.className   = 'compare-col__val';
                v.textContent = value;
                row.appendChild(k);
                row.appendChild(v);
                col.appendChild(row);
            });

            grid.appendChild(col);
        });

        container.appendChild(grid);
    }

    // ── Table view ────────────────────────────────────────────────────────────

    function _renderTable(container, items) {
        const allKeys = [];
        const keySet  = new Set();
        items.forEach(item => {
            _getDisplayAttrs(item).forEach(({ key }) => {
                if (!keySet.has(key)) { keySet.add(key); allKeys.push(key); }
            });
        });

        const wrap = document.createElement('div');
        wrap.className = 'compare-table-wrap';

        const table = document.createElement('table');
        table.className = 'compare-table';

        const thead   = document.createElement('thead');
        const headRow = document.createElement('tr');
        headRow.innerHTML = '<th class="compare-table__corner">Attribute</th>';

        items.forEach(item => {
            const th = document.createElement('th');
            th.className = 'compare-table__item-header';

            const img = document.createElement('div');
            img.className = 'compare-table__thumb';
            _loadThumb(item, img);

            const nameEl = document.createElement('div');
            nameEl.className   = 'compare-table__item-name';
            nameEl.textContent = item['display name'] || item.name || 'Unknown';

            const removeBtn = document.createElement('button');
            removeBtn.className   = 'compare-col__remove';
            removeBtn.textContent = '× Remove';
            removeBtn.onclick     = () => window.CompareManager.remove(item);

            th.appendChild(removeBtn);
            th.appendChild(img);
            th.appendChild(nameEl);
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        allKeys.forEach((key, i) => {
            const tr = document.createElement('tr');
            tr.className = i % 2 === 0 ? 'compare-table__row--even' : 'compare-table__row--odd';

            const keyTd = document.createElement('td');
            keyTd.className   = 'compare-table__key';
            keyTd.textContent = key;
            tr.appendChild(keyTd);

            items.forEach(item => {
                const map = Object.fromEntries(_getDisplayAttrs(item).map(a => [a.key, a.value]));
                const td  = document.createElement('td');
                td.className   = 'compare-table__val';
                td.textContent = map[key] ?? '—';
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        wrap.appendChild(table);
        container.appendChild(wrap);
    }

    // ── Attribute extraction ──────────────────────────────────────────────────

    function _getDisplayAttrs(item) {
        const results = [];
        const fmt     = v => (typeof v === 'number') ? v.toLocaleString() : String(v);
        const skip    = new Set([
            'name','display name','description','sprite','thumbnail','spriteData',
            '_pluginId','_internalId','_compareTab','locations',
            'hardpoint sprite','steering flare sprite','flare sprite',
            'reverse flare sprite','afterburner effect','projectile'
        ]);

        function push(key, value) {
            if (skip.has(key)) return;
            if (value === null || value === undefined) return;
            if (typeof value === 'object' && !Array.isArray(value)) return;
            if (Array.isArray(value)) {
                results.push({ key, value: value.length ? `${value.length} entries` : '—' });
                return;
            }
            results.push({ key, value: fmt(value) });
        }

        if (item.attributes && typeof item.attributes === 'object') {
            Object.entries(item.attributes).forEach(([k, v]) => push(k, v));
            ['baseShip', 'guns', 'turrets', 'bays', 'engines'].forEach(k => {
                if (item[k] !== undefined) push(k, item[k]);
            });
        } else {
            Object.entries(item).forEach(([k, v]) => {
                if (k === 'weapon' && typeof v === 'object') {
                    Object.entries(v).forEach(([wk, wv]) => {
                        const weapSkip = new Set(['sprite','spriteData','sound','hit effect','fire effect','die effect','submunition','stream','cluster']);
                        if (!weapSkip.has(wk) && typeof wv !== 'object') push(`weapon: ${wk}`, wv);
                    });
                    return;
                }
                push(k, v);
            });
        }

        return results;
    }

    // ── Sprite thumbnail ──────────────────────────────────────────────────────

    function _loadThumb(item, container) {
        container.innerHTML = '<div class="compare-thumb-placeholder"></div>';
        const spritePath = item.thumbnail || item.sprite;
        if (!spritePath || !window.fetchSprite) return;
        window.fetchSprite(spritePath, null).then(el => {
            if (!el) return;
            el.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
            container.innerHTML = '';
            container.appendChild(el);
        }).catch(() => {});
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function togglePanel() {
        _panelOpen = !_panelOpen;
        const panel = document.getElementById('comparePanel');
        if (panel) panel.classList.toggle('compare-panel--open', _panelOpen);
        _refreshBar();
        if (_panelOpen) _renderPanelContent();
    }

    function openPanel()  { if (!_panelOpen) togglePanel(); }
    function closePanel() { if (_panelOpen)  togglePanel(); }

    function setViewMode(mode) {
        _viewMode = mode;
        document.querySelectorAll('.compare-toggle__btn').forEach(btn => {
            btn.classList.toggle('compare-toggle__btn--active', btn.dataset.mode === mode);
        });
        _renderPanelContent();
    }

    function clearAll() {
        window.CompareManager.clear();
        closePanel();
    }

    return { init, togglePanel, openPanel, closePanel, setViewMode, clearAll };

})();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.CompareDisplay.init());
} else {
    window.CompareDisplay.init();
}
