let governmentFilterExpanded = false;
let lastGovernmentData = [];
let savedGovernmentFilterState = {};

function getGovernmentsForItem(item) {
    if (!item || typeof item.governments !== 'object') return [];
    const governments = new Set();

    // item._pluginId matches the key in item.governments for its own plugin's governments
    // We also need to check other active plugins' contributions to this item
    const activePlugins = new Set(window.PluginManager ? window.PluginManager.getActivePlugins() : []);

    for (const [govKey, govMap] of Object.entries(item.governments)) {
        if (typeof govMap !== 'object') continue;

        // Check if this govKey corresponds to any active plugin
        // govKey could be "official-game/endless-sky", activePlugin could be "endless-sky"
        // So we check if any active plugin outputName appears at the end of the govKey
        const isActive = [...activePlugins].some(pluginId =>
            govKey === pluginId || govKey.endsWith('/' + pluginId) || govKey === item._pluginId
        );

        if (!isActive) continue;

        for (const govName of Object.keys(govMap)) {
            if (govName.trim()) governments.add(govName.trim());
        }
    }

    return [...governments];
}

function extractGovernments(data) {
    const governments = new Set();

    const processItem = item => {
        getGovernmentsForItem(item).forEach(g => governments.add(g));
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
        filterSection.classList.add("hidden");
        filterSection.classList.remove("shown");
        return;
    }

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

    const activePlugins = new Set(window.PluginManager ? window.PluginManager.getActivePlugins() : []);

    return selected.some(govName => {
        for (const [govKey, govMap] of Object.entries(item.governments)) {
            if (typeof govMap !== 'object') continue;

            const isActive = [...activePlugins].some(pluginId =>
                govKey === pluginId || govKey.endsWith('/' + pluginId) || govKey === item._pluginId
            );

            if (!isActive) continue;
            if (govMap[govName] === true) return true;
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
            filterTitle.classList.remove("filter-title-no-margin");
            filterTitle.classList.add("filter-title");
            filterTitle.innerHTML = 'Filter by Government: ▶';
            populateGovernmentFilters(lastGovernmentData);
        }
    } else {
        document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]').forEach(cb => {
            savedGovernmentFilterState[cb.value] = cb.checked;
        });

        filterOptions.innerHTML = '';
        filterTitle.classList.remove("filter-title");
        filterTitle.classList.add("filter-title-no-margin");
        filterTitle.innerHTML = 'Filter by Government: ▼';
    }
}

window.extractGovernments          = extractGovernments;
window.populateGovernmentFilters   = populateGovernmentFilters;
window.getSelectedGovernments      = getSelectedGovernments;
window.itemMatchesGovernmentFilter = itemMatchesGovernmentFilter;
window.clearGovernmentFilters      = clearGovernmentFilters;
window.governmentFilterDisplay     = governmentFilterDisplay;
