let governmentFilterExpanded = false;
let lastGovernmentData = [];
let savedGovernmentFilterState = {};

function isPluginId(key) {
    // Plugin IDs contain a slash e.g. "official-game/endless-sky" or "Zuckungs list/tribute.republic"
    // Plain government names like "Merchant", "Militia" etc. never contain a slash
    return key.includes('/');
}

function extractGovernments(data) {
    const governments = new Set();

    const activePlugins = window.PluginManager
        ? new Set(window.PluginManager.getActivePlugins())
        : new Set();

    const processItem = item => {
        if (!item || typeof item.governments !== 'object') return;

        for (const [key, value] of Object.entries(item.governments)) {
            if (isPluginId(key)) {
                // Nested format: { "plugin-id": { "GovernmentName": true } }
                if (!activePlugins.has(key)) continue;
                if (typeof value !== 'object') continue;
                for (const govName of Object.keys(value)) {
                    const trimmed = govName.trim();
                    if (trimmed) governments.add(trimmed);
                }
            } else {
                // Flat format: { "GovernmentName": true }
                // No plugin filtering possible — always include
                const trimmed = key.trim();
                if (trimmed && value === true) governments.add(trimmed);
            }
        }
    };

    if (Array.isArray(data)) {
        data.forEach(processItem);
    } else if (data && typeof data === 'object') {
        Object.values(data).forEach(processItem);
    }

    return Array.from(governments).sort();
}

function populateGovernmentFilters(data) {
    lastGovernmentData = data;

    const governments = extractGovernments(data);
    const filterOptions = document.getElementById('governmentFilterOptions');
    const filterSection = document.getElementById('governmentFilterSection');

    if (!filterOptions || !filterSection) return;

    if (governments.length === 0) {
        filterSection.classList.add('hidden');
        filterSection.classList.remove('shown');
        return;
    }

    filterSection.classList.remove('hidden');

    if (!governmentFilterExpanded) {
        filterOptions.innerHTML = '';
        return;
    }

    filterOptions.innerHTML = '';

    governments.forEach(government => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'filter-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `gov-filter-${CSS.escape(government)}`;
        checkbox.value = government;
        checkbox.checked = savedGovernmentFilterState[government] ?? false;
        checkbox.onchange = filterItems;

        const label = document.createElement('label');
        label.htmlFor = `gov-filter-${CSS.escape(government)}`;
        label.textContent = government;

        optionDiv.appendChild(checkbox);
        optionDiv.appendChild(label);
        filterOptions.appendChild(optionDiv);
    });
}

function getSelectedGovernments() {
    const checkboxes = document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]');

    if (checkboxes.length === 0) {
        return Object.entries(savedGovernmentFilterState)
            .filter(([_, checked]) => checked)
            .map(([value]) => value);
    }

    const selected = [];
    checkboxes.forEach(cb => { if (cb.checked) selected.push(cb.value); });
    return selected;
}

function itemMatchesGovernmentFilter(item, selected) {
    if (selected.length === 0) return true;
    if (!item || typeof item.governments !== 'object') return false;

    const activePlugins = window.PluginManager
        ? new Set(window.PluginManager.getActivePlugins())
        : new Set();

    return selected.some(govName => {
        for (const [key, value] of Object.entries(item.governments)) {
            if (isPluginId(key)) {
                // Nested format — only check active plugins
                if (!activePlugins.has(key)) continue;
                if (typeof value === 'object' && value[govName] === true) return true;
            } else {
                // Flat format — key is the government name
                if (key === govName && value === true) return true;
            }
        }
        return false;
    });
}

function clearGovernmentFilters() {
    savedGovernmentFilterState = {};
    const checkboxes = document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = false; });
}

function governmentFilterDisplay() {
    const filterOptions = document.getElementById('governmentFilterOptions');
    const filterTitle = document.getElementById('governmentFilterTitle');

    if (!filterOptions) return;

    governmentFilterExpanded = !governmentFilterExpanded;

    if (governmentFilterExpanded) {
        if (lastGovernmentData.length) {
            filterTitle.classList.remove('filter-title-no-margin');
            filterTitle.classList.add('filter-title');
            filterTitle.innerHTML = 'Filter by Government: ▶';
            populateGovernmentFilters(lastGovernmentData);
        }
    } else {
        document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]').forEach(cb => {
            savedGovernmentFilterState[cb.value] = cb.checked;
        });

        filterOptions.innerHTML = '';
        filterTitle.classList.remove('filter-title');
        filterTitle.classList.add('filter-title-no-margin');
        filterTitle.innerHTML = 'Filter by Government: ▼';
    }
}

window.extractGovernments          = extractGovernments;
window.populateGovernmentFilters   = populateGovernmentFilters;
window.getSelectedGovernments      = getSelectedGovernments;
window.itemMatchesGovernmentFilter = itemMatchesGovernmentFilter;
window.clearGovernmentFilters      = clearGovernmentFilters;
window.governmentFilterDisplay     = governmentFilterDisplay;
