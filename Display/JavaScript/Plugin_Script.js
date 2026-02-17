let allData = {};
let currentPlugin = null;
let currentTab = 'ships';
let filteredData = [];
let currentModalTab = 'attributes';

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadData() {
    const repoUrl = "GIVEMEFOOD5/endless-sky-ship-builder";

    const loadingIndicator = document.getElementById('loadingIndicator');
    const errorContainer   = document.getElementById('errorContainer');
    const mainContent      = document.getElementById('mainContent');

    loadingIndicator.style.display = 'block';
    errorContainer.innerHTML = '';
    mainContent.style.display = 'none';

    if (typeof initImageIndex === 'function') initImageIndex();

    try {
        const baseUrl = `https://raw.githubusercontent.com/${repoUrl}/main/data`;
        const pluginsResponse = await fetch(`https://raw.githubusercontent.com/${repoUrl}/main/plugins.json`);

        if (!pluginsResponse.ok) throw new Error('Could not find plugins.json in repository');

        const pluginsConfig = await pluginsResponse.json();
        allData = {};

        for (const plugin of pluginsConfig.plugins) {
            const pluginData = { repository: plugin.repository, ships: [], variants: [], outfits: [] };
            let loadedSomething = false;

            try {
                const shipsResponse = await fetch(`${baseUrl}/${plugin.name}/dataFiles/ships.json`);
                if (shipsResponse.ok) { pluginData.ships = await shipsResponse.json(); loadedSomething = true; }
                else console.warn(`${plugin.name}: ships.json not found (${shipsResponse.status})`);

                const variantsResponse = await fetch(`${baseUrl}/${plugin.name}/dataFiles/variants.json`);
                if (variantsResponse.ok) { pluginData.variants = await variantsResponse.json(); loadedSomething = true; }
                else console.warn(`${plugin.name}: variants.json not found (${variantsResponse.status})`);

                const outfitsResponse = await fetch(`${baseUrl}/${plugin.name}/dataFiles/outfits.json`);
                if (outfitsResponse.ok) { pluginData.outfits = await outfitsResponse.json(); loadedSomething = true; }
                else console.warn(`${plugin.name}: outfits.json not found (${outfitsResponse.status})`);

                if (loadedSomething) allData[plugin.name] = pluginData;
                else console.warn(`${plugin.name}: no data files found, skipping plugin`);
            } catch (err) {
                console.warn(`Failed loading plugin ${plugin.name}`, err);
            }
        }

        const hasAnyData = Object.values(allData).some(p =>
            (p.ships && p.ships.length > 0) ||
            (p.variants && p.variants.length > 0) ||
            (p.outfits && p.outfits.length > 0)
        );

        if (!hasAnyData) throw new Error('No plugin data files could be loaded');

        loadingIndicator.style.display = 'none';
        mainContent.style.display = 'block';
        renderPluginSelector();
        currentPlugin = Object.keys(allData)[0];
        updateStats();
        renderCards();
    } catch (error) {
        loadingIndicator.style.display = 'none';
        showError(`Error loading data: ${error.message}`);
    }
}

// ─── Plugin / tab / card rendering ───────────────────────────────────────────

function renderPluginSelector() {
    const selector = document.getElementById('pluginSelector');
    selector.innerHTML = '';
    Object.keys(allData).forEach(pluginName => {
        const btn = document.createElement('button');
        btn.className = 'plugin-btn';
        btn.textContent = pluginName;
        btn.onclick = () => selectPlugin(pluginName);
        selector.appendChild(btn);
    });
    if (selector.firstChild) selector.firstChild.classList.add('active');
}

function selectPlugin(pluginName) {
    currentPlugin = pluginName;
    document.querySelectorAll('.plugin-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === pluginName);
    });
    updateStats();
    renderCards();
}

function updateStats() {
    if (!currentPlugin || !allData[currentPlugin]) return;
    const data = allData[currentPlugin];
    const statsContainer = document.getElementById('stats');
    const totalShips   = (data.ships   ? data.ships.length   : 0) + (data.variants ? data.variants.length : 0);
    const totalOutfits = data.outfits  ? data.outfits.length : 0;
    statsContainer.innerHTML = `
        <div class="stat-card"><div class="stat-value">${data.ships ? data.ships.length : 0}</div><div class="stat-label">Base Ships</div></div>
        <div class="stat-card"><div class="stat-value">${data.variants ? data.variants.length : 0}</div><div class="stat-label">Variants</div></div>
        <div class="stat-card"><div class="stat-value">${totalOutfits}</div><div class="stat-label">Outfits</div></div>
        <div class="stat-card"><div class="stat-value">${totalShips + totalOutfits}</div><div class="stat-label">Total Items</div></div>
    `;
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.textContent.toLowerCase() === tab);
    });
    renderCards();
}

function renderCards() {
    if (!currentPlugin || !allData[currentPlugin]) return;
    const data = allData[currentPlugin];
    let items = [];
    if (currentTab === 'ships') {
        items = data.ships || [];
        if (typeof populateFilters === 'function') populateFilters(data.ships);
    } else if (currentTab === 'variants') {
        items = data.variants || [];
        if (typeof populateFilters === 'function') populateFilters(data.variants);
    } else {
        items = data.outfits || [];
        if (typeof populateFilters === 'function') populateFilters(data.outfits);
    }
    filteredData = items;
    if (typeof filterItems === 'function') filterItems();
}

function createCard(item) {
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => showDetails(item);

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.name || 'Unknown';

    const details = document.createElement('div');
    details.className = 'card-details';

    if (currentTab === 'ships' || currentTab === 'variants') {
        details.innerHTML = `
            <div class="detail-item"><div class="detail-label">Category</div><div class="detail-value">${item.attributes?.category || 'N/A'}</div></div>
            <div class="detail-item"><div class="detail-label">Cost</div><div class="detail-value">${formatNumber(item.attributes?.cost) || '0'}</div></div>
            <div class="detail-item"><div class="detail-label">Hull</div><div class="detail-value">${formatNumber(item.attributes?.hull) || 'N/A'}</div></div>
            <div class="detail-item"><div class="detail-label">Shields</div><div class="detail-value">${formatNumber(item.attributes?.shields) || 'N/A'}</div></div>
        `;
    } else {
        details.innerHTML = `
            <div class="detail-item"><div class="detail-label">Category</div><div class="detail-value">${item.category || 'N/A'}</div></div>
            <div class="detail-item"><div class="detail-label">Cost</div><div class="detail-value">${formatNumber(item.cost) || '0'}</div></div>
            <div class="detail-item"><div class="detail-label">Mass</div><div class="detail-value">${item.mass || 'N/A'}</div></div>
            <div class="detail-item"><div class="detail-label">Outfit Space</div><div class="detail-value">${item['outfit space'] || 'N/A'}</div></div>
        `;
    }

    card.appendChild(title);
    card.appendChild(details);
    return card;
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function getAvailableTabs(item) {
    const tabs = [];
    if (item.attributes || Object.keys(item).length > 0)      tabs.push({ id: 'attributes',       label: 'Attributes'         });
    if (item.thumbnail)                                        tabs.push({ id: 'thumbnail',        label: 'Thumbnail'          });
    if (item.weapon?.['hardpoint sprite'])                     tabs.push({ id: 'hardpointSprite',  label: 'Hardpoint'          });
    if (item.sprite || item.weapon?.sprite)                    tabs.push({ id: 'sprite',           label: 'Sprite'             });
    if (item['steering flare sprite'])                         tabs.push({ id: 'steeringFlare',    label: 'Steering Flare'     });
    if (item['flare sprite'])                                  tabs.push({ id: 'flare',            label: 'Flare'              });
    if (item['reverse flare sprite'])                          tabs.push({ id: 'reverseFlare',     label: 'Reverse Flare'      });
    if (item.projectile)                                       tabs.push({ id: 'projectile',       label: 'Projectile'         });
    if (item['afterburner effect'])                            tabs.push({ id: 'afterburnerEffect',label: 'Afterburner Effect'  });
    return tabs;
}

async function showDetails(item) {
    const modal      = document.getElementById('detailModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody  = document.getElementById('modalBody');

    if (typeof clearSpriteCache === 'function') clearSpriteCache();

    modalTitle.textContent = item.name || 'Unknown';

    const availableTabs = getAvailableTabs(item);
    currentModalTab = availableTabs.length > 0 ? availableTabs[0].id : 'attributes';

    modalBody.innerHTML = '';

    if (availableTabs.length > 0) {
        const tabBar = document.createElement('div');
        tabBar.className = 'modal-tabs';
        availableTabs.forEach(tab => {
            const btn = document.createElement('button');
            btn.className = 'modal-tab' + (tab.id === currentModalTab ? ' active' : '');
            btn.dataset.tab = tab.id;
            btn.textContent = tab.label;
            btn.onclick = () => switchModalTab(tab.id);
            tabBar.appendChild(btn);
        });
        modalBody.appendChild(tabBar);

        const tabContents = document.createElement('div');
        tabContents.className = 'modal-tab-contents';
        availableTabs.forEach(tab => {
            const pane = document.createElement('div');
            pane.className = 'modal-tab-content';
            pane.dataset.tab = tab.id;
            pane.style.display = 'none';
            tabContents.appendChild(pane);
        });
        modalBody.appendChild(tabContents);
    }

    if (item.description) {
        const desc = document.createElement('div');
        desc.innerHTML = `
            <h3 style="color:#93c5fd;margin-top:30px;margin-bottom:10px;padding-top:20px;border-top:2px solid rgba(59,130,246,0.3);">Description</h3>
            <p style="margin-top:10px;line-height:1.6;color:#cbd5e1;">${item.description}</p>
        `;
        modalBody.appendChild(desc);
    }

    modalBody.dataset.itemJson = JSON.stringify(item);
    modal.classList.add('active');

    await switchModalTab(currentModalTab);
}

// ─── switchModalTab ───────────────────────────────────────────────────────────

async function switchModalTab(tabId) {
    currentModalTab = tabId;

    if (typeof clearSpriteCache === 'function') clearSpriteCache();

    document.querySelectorAll('.modal-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabId);
    });

    const modalBody = document.getElementById('modalBody');
    const item      = JSON.parse(modalBody.dataset.itemJson);

    document.querySelectorAll('.modal-tab-content').forEach(content => {
        content.style.display = 'none';
        content.innerHTML     = '';
    });

    const tabContent = document.querySelector(`.modal-tab-content[data-tab="${tabId}"]`);
    if (!tabContent) return;

    tabContent.style.display = 'block';

    if (tabId === 'attributes') {
        tabContent.innerHTML = renderAttributesTab(item);
        return;
    }

    tabContent.innerHTML = '<p style="color:#94a3b8;text-align:center;">Loading…</p>';

    // ── spriteParams ───────────────────────────────────────────────────────────
    // Pass spriteData as-is from the JSON — keys use "frame rate" (with spaces),
    // NOT camelCase. afterburnerEffect gets its params from effects.json via
    // ImageGrabber, so we pass an empty object for that tab.
    const spriteParams = tabId === 'afterburnerEffect' ? {} : (item.spriteData || {});

    // ── pathMap ────────────────────────────────────────────────────────────────
    // Use the exact property names from the JSON — no aliases needed.
    const pathMap = {
        thumbnail:         item.thumbnail,
        sprite:            item.sprite       || item.weapon?.sprite,
        hardpointSprite:   item.weapon?.['hardpoint sprite'],
        steeringFlare:     item['steering flare sprite'],
        flare:             item['flare sprite'],
        reverseFlare:      item['reverse flare sprite'],
        projectile:        item.projectile,
        afterburnerEffect: item['afterburner effect'],
    };

    console.log("afterburner effect " + item);

    const element = await renderImageTab(pathMap[tabId], tabId, spriteParams);

    if (currentModalTab !== tabId) return;

    tabContent.innerHTML = '';
    if (element) tabContent.appendChild(element);
}

// ─── renderImageTab ───────────────────────────────────────────────────────────

async function renderImageTab(spritePath, altText, spriteParams) {
    altText      = altText      || 'Image';
    spriteParams = spriteParams || {};

    if (!spritePath) return null;

    const element = await fetchSprite(spritePath, spriteParams);

    if (!element) {
        const p = document.createElement('p');
        p.style.color = '#ef4444';
        p.textContent = 'Failed to load: ' + altText;
        return p;
    }

    const wrap = document.createElement('div');
    wrap.style.cssText =
        'display:flex;justify-content:center;align-items:center;' +
        'padding:20px;background:rgba(15,23,42,0.5);border-radius:8px;';
    wrap.appendChild(element);
    return wrap;
}

// ─── renderAttributesTab ──────────────────────────────────────────────────────

function renderAttributesTab(item) {
    let html = '';

    if (currentTab === 'ships' || currentTab === 'variants') {
        if (currentTab === 'variants' && item.baseShip) {
            html += `<p style="color:#93c5fd;margin-bottom:20px;">Base Ship: ${item.baseShip}</p>`;
        }
        html += '<div class="attribute-grid">';
        if (item.attributes) {
            Object.entries(item.attributes).forEach(([key, value]) => {
                if (typeof value !== 'object') {
                    html += `<div class="attribute"><div class="attribute-name">${key}</div><div class="attribute-value">${formatValue(value)}</div></div>`;
                }
            });
        }
        html += '</div>';

        if (item.guns || item.turrets || item.bays || item.engines) {
            html += '<h3 style="color:#93c5fd;margin-top:20px;">Hardpoints</h3>';
            html += '<div class="attribute-grid">';
            html += `
                <div class="attribute"><div class="attribute-name">Guns</div><div class="attribute-value">${item.guns ? item.guns.length : 0}</div></div>
                <div class="attribute"><div class="attribute-name">Turrets</div><div class="attribute-value">${item.turrets ? item.turrets.length : 0}</div></div>
                <div class="attribute"><div class="attribute-name">Bays</div><div class="attribute-value">${item.bays ? item.bays.length : 0}</div></div>
                <div class="attribute"><div class="attribute-name">Engines</div><div class="attribute-value">${item.engines ? item.engines.length : 0}</div></div>
            `;
            html += '</div>';
        }
    } else {
        html += '<div class="attribute-grid">';
        const excludeKeys = ['name','description','thumbnail','sprite','hardpointSprite',
            'hardpoint sprite','steering flare sprite','flare sprite','reverse flare sprite',
            'afterburner effect','projectile','weapon','spriteData'];
        Object.entries(item).forEach(([key, value]) => {
            if (!excludeKeys.includes(key) && typeof value !== 'object') {
                html += `<div class="attribute"><div class="attribute-name">${key}</div><div class="attribute-value">${formatValue(value)}</div></div>`;
            }
        });
        html += '</div>';

        if (item.weapon) {
            html += '<h3 style="color:#93c5fd;margin-top:20px;">Weapon Stats</h3>';
            html += '<div class="attribute-grid">';
            const weaponExclude = ['sprite','spriteData','sound','hit effect','fire effect','die effect','submunition','stream','cluster'];
            Object.entries(item.weapon).forEach(([key, value]) => {
                if (!weaponExclude.includes(key) && typeof value !== 'object' && !Array.isArray(value)) {
                    html += `<div class="attribute"><div class="attribute-name">${key}</div><div class="attribute-value">${formatValue(value)}</div></div>`;
                }
            });
            html += '</div>';
        }
    }

    return html;
}

// ─── closeModal ───────────────────────────────────────────────────────────────

function closeModal() {
    if (typeof clearSpriteCache === 'function') clearSpriteCache();
    document.querySelectorAll('.modal-tab-content').forEach(c => { c.innerHTML = ''; });
    document.getElementById('detailModal').classList.remove('active');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatNumber(num) {
    if (num === undefined || num === null) return 'N/A';
    return num.toLocaleString();
}

function formatValue(value) {
    return typeof value === 'number' ? formatNumber(value) : value;
}

function showError(message) {
    document.getElementById('errorContainer').innerHTML = `<div class="error">${message}</div>`;
}

function clearData() {
    document.getElementById('mainContent').style.display = 'none';
    document.getElementById('errorContainer').innerHTML = '';
    allData = {};
    currentPlugin = null;
}

// ─── DOM-dependent setup ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('detailModal').addEventListener('click', function (e) {
        if (e.target.id === 'detailModal') closeModal();
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeModal();
    });

    loadData();
});

// ─── Global exports ───────────────────────────────────────────────────────────

window.loadData       = loadData;
window.clearData      = clearData;
window.switchTab      = switchTab;
window.closeModal     = closeModal;
window.selectPlugin   = selectPlugin;
window.switchModalTab = switchModalTab;
