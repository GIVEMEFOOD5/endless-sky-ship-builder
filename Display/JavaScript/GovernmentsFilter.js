let governmentFilterExpanded = false;
let lastGovernmentData = [];
let savedGovernmentFilterState = {};

function extractGovernments(data) {
    const governments = new Set();

    const processItem = item => {
        if (item && typeof item.governments === 'object') {
            Object.keys(item.governments).forEach(g => governments.add(g));
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
        // Restore saved state, default to false
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

    // If dropdowns are collapsed, read from saved state instead
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
        // Save state before clearing
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
