let allData = {};
let currentPlugin = null;
let currentTab = 'ships';
let filteredData = [];
let currentModalTab = 'attributes'; // Track active modal tab

async function loadData() {
    const repoUrl = "GIVEMEFOOD5/endless-sky-ship-builder"; //document.getElementById('repoUrl').value.trim();
    if (!repoUrl) {
        showError('Please enter a GitHub repository URL');
        return;
    }

    const loadingIndicator = document.getElementById('loadingIndicator');
    const errorContainer = document.getElementById('errorContainer');
    const mainContent = document.getElementById('mainContent');

    loadingIndicator.style.display = 'block';
    errorContainer.innerHTML = '';
    mainContent.style.display = 'none';

    try {
        const baseUrl = `https://raw.githubusercontent.com/${repoUrl}/main/data`;
        const pluginsResponse = await fetch(`https://raw.githubusercontent.com/${repoUrl}/main/plugins.json`);
        
        if (!pluginsResponse.ok) {
            throw new Error('Could not find plugins.json in repository');
        }

        const pluginsConfig = await pluginsResponse.json();
        allData = {};

        for (const plugin of pluginsConfig.plugins) {
            const pluginData = {
                repository: plugin.repository,
                ships: [],
                variants: [],
                outfits: []
            };

            let loadedSomething = false;

            try {
                const shipsResponse = await fetch(`${baseUrl}/${plugin.name}/dataFiles/ships.json`);
                if (shipsResponse.ok) {
                    pluginData.ships = await shipsResponse.json();
                    loadedSomething = true;
                } else {
                    console.warn(`${plugin.name}: ships.json not found (${shipsResponse.status})`);
                }

                const variantsResponse = await fetch(`${baseUrl}/${plugin.name}/dataFiles/variants.json`);
                if (variantsResponse.ok) {
                    pluginData.variants = await variantsResponse.json();
                    loadedSomething = true;
                } else {
                    console.warn(`${plugin.name}: variants.json not found (${variantsResponse.status})`);
                }

                const outfitsResponse = await fetch(`${baseUrl}/${plugin.name}/dataFiles/outfits.json`);
                if (outfitsResponse.ok) {
                    pluginData.outfits = await outfitsResponse.json();
                    loadedSomething = true;
                } else {
                    console.warn(`${plugin.name}: outfits.json not found (${outfitsResponse.status})`);
                }

                if (loadedSomething) {
                    allData[plugin.name] = pluginData;
                } else {
                    console.warn(`${plugin.name}: no data files found, skipping plugin`);
                }
            } catch (err) {
                console.warn(`Failed loading plugin ${plugin.name}`, err);
            }
        }

        const hasAnyData = Object.values(allData).some(plugin =>
            (plugin.ships && plugin.ships.length > 0) ||
            (plugin.variants && plugin.variants.length > 0) ||
            (plugin.outfits && plugin.outfits.length > 0)
        );

        if (!hasAnyData) {
            throw new Error('No plugin data files could be loaded');
        }

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

    if (selector.firstChild) {
        selector.firstChild.classList.add('active');
    }
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
    const totalShips = (data.ships ? data.ships.length : 0) + (data.variants ? data.variants.length : 0);
    const totalOutfits = data.outfits ? data.outfits.length : 0;

    statsContainer.innerHTML = `
        <div class="stat-card">
            <div class="stat-value">${data.ships ? data.ships.length : 0}</div>
            <div class="stat-label">Base Ships</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${data.variants ? data.variants.length : 0}</div>
            <div class="stat-label">Variants</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${totalOutfits}</div>
            <div class="stat-label">Outfits</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${totalShips + totalOutfits}</div>
            <div class="stat-label">Total Items</div>
        </div>
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

    const container = document.getElementById('cardsContainer');
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
    if (typeof filterItems === 'function') {
        filterItems();
    }
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
            <div class="detail-item">
                <div class="detail-label">Category</div>
                <div class="detail-value">${item.attributes?.category || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Cost</div>
                <div class="detail-value">${formatNumber(item.attributes?.cost) || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Hull</div>
                <div class="detail-value">${formatNumber(item.attributes?.hull) || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Shields</div>
                <div class="detail-value">${formatNumber(item.attributes?.shields) || 'N/A'}</div>
            </div>
        `;
    } else {
        details.innerHTML = `
            <div class="detail-item">
                <div class="detail-label">Category</div>
                <div class="detail-value">${item.category || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Cost</div>
                <div class="detail-value">${formatNumber(item.cost) || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Mass</div>
                <div class="detail-value">${item.mass || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Outfit Space</div>
                <div class="detail-value">${item['outfit space'] || 'N/A'}</div>
            </div>
        `;
    }

    card.appendChild(title);
    card.appendChild(details);
    return card;
}

// Get available tabs based on item data
function getAvailableTabs(item) {
    const tabs = [];
    
    // Always show attributes if present
    if (item.attributes || Object.keys(item).length > 0) {
        tabs.push({ id: 'attributes', label: 'Attributes' });
    }
    
    // Check for thumbnail
    if (item.thumbnail) {
        tabs.push({ id: 'thumbnail', label: 'Thumbnail' });
    }
    
    // Check for sprite (ship/outfit sprite)
    if (item.sprite || item.weapon?.sprite) {
        tabs.push({ id: 'sprite', label: 'Sprite' });
    }
    
    // Check for hardpoint sprite
    if (item.hardpointSprite || item['hardpoint sprite']) {
        tabs.push({ id: 'hardpointSprite', label: 'Hardpoint' });
    }
    
    // Check for steering flare
    if (item.steeringFlare || item['steering flare']) {
        tabs.push({ id: 'steeringFlare', label: 'Steering Flare' });
    }
    
    // Check for flare
    if (item.flare) {
        tabs.push({ id: 'flare', label: 'Flare' });
    }
    
    // Check for reverse flare
    if (item.reverseFlare || item['reverse flare']) {
        tabs.push({ id: 'reverseFlare', label: 'Reverse Flare' });
    }
    
    // Check for projectile
    if (item.projectile) {
        tabs.push({ id: 'projectile', label: 'Projectile' });
    }
    
    // Check for weapon fire effect
    if (item.weapon?.['fire effect']  && Array.isArray(item.weapon['fire effect']) && item.weapon['fire effect'].length > 0) {
        tabs.push({ id: 'fireEffect', label: 'Fire Effect' });
    }
    
    // Check for weapon hit effect (usually first effect in array)
    if (item.weapon?.['hit effect'] && Array.isArray(item.weapon['hit effect']) && item.weapon['hit effect'].length > 0) {
        tabs.push({ id: 'hitEffect', label: 'Hit Effect' });
    }
    
    // Check for weapon die effect
    if (item.weapon?.['die effect']) {
        tabs.push({ id: 'dieEffect', label: 'Die Effect' });
    }
    
    return tabs;
}

// Switch modal tab
function switchModalTab(tabId) {
    currentModalTab = tabId;
    
    // Update tab buttons
    document.querySelectorAll('.modal-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabId);
    });
    
    // Update tab content
    document.querySelectorAll('.modal-tab-content').forEach(content => {
        content.classList.toggle('active', content.dataset.tab === tabId);
    });
}

// Render attributes tab content
function renderAttributesTab(item) {
    let html = '';
    
    if (currentTab === 'ships' || currentTab === 'variants') {
        if (currentTab === 'variants' && item.baseShip) {
            html += `<p style="color: #93c5fd; margin-bottom: 20px;">Base Ship: ${item.baseShip}</p>`;
        }
        
        html += '<div class="attribute-grid">';
        if (item.attributes) {
            Object.entries(item.attributes).forEach(([key, value]) => {
                if (typeof value !== 'object') {
                    html += `
                        <div class="attribute">
                            <div class="attribute-name">${key}</div>
                            <div class="attribute-value">${formatValue(value)}</div>
                        </div>
                    `;
                }
            });
        }
        html += '</div>';
        
        // Add hardpoints section within attributes
        if (item.guns || item.turrets || item.bays || item.engines) {
            html += '<h3 style="color: #93c5fd; margin-top: 20px;">Hardpoints</h3>';
            html += '<div class="attribute-grid">';
            html += `
                <div class="attribute">
                    <div class="attribute-name">Guns</div>
                    <div class="attribute-value">${item.guns ? item.guns.length : 0}</div>
                </div>
                <div class="attribute">
                    <div class="attribute-name">Turrets</div>
                    <div class="attribute-value">${item.turrets ? item.turrets.length : 0}</div>
                </div>
                <div class="attribute">
                    <div class="attribute-name">Bays</div>
                    <div class="attribute-value">${item.bays ? item.bays.length : 0}</div>
                </div>
                <div class="attribute">
                    <div class="attribute-name">Engines</div>
                    <div class="attribute-value">${item.engines ? item.engines.length : 0}</div>
                </div>
            `;
            html += '</div>';
        }
    } else {
        // Outfit attributes
        html += '<div class="attribute-grid">';
        const excludeKeys = ['name', 'description', 'thumbnail', 'sprite', 'hardpointSprite', 
                            'hardpoint sprite', 'steeringFlare', 'steering flare', 'flare', 
                            'reverseFlare', 'reverse flare', 'projectile', 'weapon', 'spriteData'];
        
        Object.entries(item).forEach(([key, value]) => {
            if (!excludeKeys.includes(key) && typeof value !== 'object') {
                html += `
                    <div class="attribute">
                        <div class="attribute-name">${key}</div>
                        <div class="attribute-value">${formatValue(value)}</div>
                    </div>
                `;
            }
        });
        html += '</div>';
        
        // Add weapon stats if they exist
        if (item.weapon) {
            html += '<h3 style="color: #93c5fd; margin-top: 20px;">Weapon Stats</h3>';
            html += '<div class="attribute-grid">';
            
            const weaponExcludeKeys = ['sprite', 'spriteData', 'sound', 'hit effect', 'fire effect', 
                                       'die effect', 'submunition', 'stream', 'cluster'];
            
            Object.entries(item.weapon).forEach(([key, value]) => {
                if (!weaponExcludeKeys.includes(key) && typeof value !== 'object' && !Array.isArray(value)) {
                    html += `
                        <div class="attribute">
                            <div class="attribute-name">${key}</div>
                            <div class="attribute-value">${formatValue(value)}</div>
                        </div>
                    `;
                }
            });
            
            html += '</div>';
        }
    }
    
    return html;
}

// Render sprite/image tab content
function renderImageTab(imageUrl, altText = 'Image') {
    return `
        <div style="display: flex; justify-content: center; align-items: center; padding: 20px; background: rgba(15, 23, 42, 0.5); border-radius: 8px;">
            <img src="${imageUrl}" alt="${altText}" style="max-width: 100%; max-height: 500px; object-fit: contain; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);" 
                 onerror="this.parentElement.innerHTML='<p style=color:#ef4444;>Failed to load image</p>'">
        </div>
    `;
}

function showDetails(item) {
    const modal = document.getElementById('detailModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');

    modalTitle.textContent = item.name || 'Unknown';
    
    // Get available tabs for this item
    const availableTabs = getAvailableTabs(item);
    
    // Reset to first tab
    currentModalTab = availableTabs.length > 0 ? availableTabs[0].id : 'attributes';
    
    let html = '';
    
    // Only show tabs if there are multiple sections to display
    if (availableTabs.length > 0) {
        // Build tabs HTML
        html += '<div class="modal-tabs" style="display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); padding-bottom: 0; overflow-x: auto; flex-wrap: wrap;">';
        availableTabs.forEach(tab => {
            html += `
                <button class="modal-tab ${tab.id === currentModalTab ? 'active' : ''}" 
                        data-tab="${tab.id}" 
                        onclick="switchModalTab('${tab.id}')"
                        style="padding: 12px 20px; background: ${tab.id === currentModalTab ? 'rgba(59, 130, 246, 0.4)' : 'rgba(30, 41, 59, 0.8)'}; 
                               border: 1px solid rgba(59, 130, 246, 0.3); color: ${tab.id === currentModalTab ? '#93c5fd' : '#94a3b8'}; 
                               cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease; 
                               border-bottom: 3px solid ${tab.id === currentModalTab ? '#3b82f6' : 'transparent'}; 
                               white-space: nowrap; position: relative; bottom: -2px; border-radius: 8px 8px 0 0;">
                    ${tab.label}
                </button>
            `;
        });
        html += '</div>';
        
        // Build tab contents HTML
        html += '<div class="modal-tab-contents">';
        
        availableTabs.forEach(tab => {
            let content = '';
            
            switch(tab.id) {
                case 'attributes':
                    content = renderAttributesTab(item);
                    break;
                case 'thumbnail':
                    content = renderImageTab(item.thumbnail, 'Thumbnail');
                    break;
                case 'sprite':
                    content = renderImageTab(item.sprite || item.weapon?.sprite, 'Sprite');
                    break;
                case 'hardpointSprite':
                    content = renderImageTab(item.hardpointSprite || item['hardpoint sprite'], 'Hardpoint Sprite');
                    break;
                case 'steeringFlare':
                    content = renderImageTab(item.steeringFlare || item['steering flare'], 'Steering Flare');
                    break;
                case 'flare':
                    content = renderImageTab(item.flare, 'Flare');
                    break;
                case 'reverseFlare':
                    content = renderImageTab(item.reverseFlare || item['reverse flare'], 'Reverse Flare');
                    break;
                case 'projectile':
                    content = renderImageTab(item.projectile, 'Projectile');
                    break;
                case 'fireEffect':
                    content = renderImageTab(item.weapon['fire effect'], 'Fire Effect');
                    break;
                case 'hitEffect':
                    // Use the first hit effect if it's an array
                    const hitEffect = Array.isArray(item.weapon['hit effect']) 
                        ? item.weapon['hit effect'][0] 
                        : item.weapon['hit effect'];
                    content = renderImageTab(hitEffect, 'Hit Effect');
                    break;
                case 'dieEffect':
                    content = renderImageTab(item.weapon['die effect'], 'Die Effect');
                    break;
            }
            
            html += `
                <div class="modal-tab-content" 
                     data-tab="${tab.id}"
                     style="display: ${tab.id === currentModalTab ? 'block' : 'none'}; animation: fadeIn 0.3s ease;">
                    ${content}
                </div>
            `;
        });
        
        html += '</div>';
    } else {
        // If no tabs, just show attributes
        html = renderAttributesTab(item);
    }
    
    // Always add description at the bottom if it exists
    if (item.description) {
        html += `
            <h3 style="color: #93c5fd; margin-top: 30px; margin-bottom: 10px; padding-top: 20px; border-top: 2px solid rgba(59, 130, 246, 0.3);">Description</h3>
            <p style="margin-top: 10px; line-height: 1.6; color: #cbd5e1;">${item.description}</p>
        `;
    }
    
    modalBody.innerHTML = html;
    modal.classList.add('active');
}

function closeModal() {
    document.getElementById('detailModal').classList.remove('active');
}

function formatNumber(num) {
    if (num === undefined || num === null) return 'N/A';
    return num.toLocaleString();
}

function formatValue(value) {
    if (typeof value === 'number') {
        return formatNumber(value);
    }
    return value;
}

function showError(message) {
    const errorContainer = document.getElementById('errorContainer');
    errorContainer.innerHTML = `<div class="error">${message}</div>`;
}

function clearData() {
    document.getElementById('repoUrl').value = '';
    document.getElementById('mainContent').style.display = 'none';
    document.getElementById('errorContainer').innerHTML = '';
    allData = {};
    currentPlugin = null;
}

document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target.id === 'detailModal') {
        closeModal();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
    }
});

// Make functions globally accessible for HTML onclick attributes
window.loadData = loadData;
window.clearData = clearData;
window.switchTab = switchTab;
window.closeModal = closeModal;
window.selectPlugin = selectPlugin;
window.switchModalTab = switchModalTab;
