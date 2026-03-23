let governmentFilterExpanded = false;
let lastGovernmentData = [];
let savedGovernmentFilterState = {};

// Track the plugin that was active when lastGovernmentData was populated
let lastGovernmentPlugin = null;

function extractGovernments(data) {
    const governments = new Set();

    const processItem = item => {
        if (item && typeof item.governments === 'object') {
            Object.keys(item.governments).forEach(g => {
                const trimmed = g.trim();
                if (trimmed) governments.add(trimmed);   // skip blank keys
            });
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
    // Detect plugin change — if the active plugin changed, reset saved filter state
    const activePlugin = window.PluginManager
        ? window.PluginManager.getPrimaryPlugin()
        : null;

    if (activePlugin !== lastGovernmentPlugin) {
        savedGovernmentFilterState = {};   // clear stale selections from old plugin
        lastGovernmentPlugin = activePlugin;
    }

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

    // Show the section now that there are governments
    filterSection.classList.remove("hidden");

    if (!governmentFilterExpanded) {
        filterOptions.innerHTML = '';
        return;
    }

    // Re-render checkboxes (Set already deduplicates; trim() above handles
    // whitespace variants; sort() in extractGovernments keeps list stable)
    filterOptions.innerHTML = '';

    governments.forEach(government => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'filter-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `gov-filter-${CSS.escape(government)}`;
        checkbox.value = government;
        // Restore saved state for this plugin; default unchecked
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

    // If the dropdown is collapsed, read from saved state
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
    return selected.some(g => item.governments[g] === true);
}

function clearGovernmentFilters() {
    savedGovernmentFilterState = {};
    const checkboxes = document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = false; });
}

function governmentFilterDisplay() {
    const filterOptions = document.getElementById('governmentFilterOptions');
    const filterTitle   = document.getElementById('governmentFilterTitle');

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
        // Persist checkbox state before collapsing
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
