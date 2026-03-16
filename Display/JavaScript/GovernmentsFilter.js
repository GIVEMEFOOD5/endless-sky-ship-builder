// governmentFilter.js
// Extracts unique governments from the current tab's data and renders
// them as checkboxes. Integrates with renderCards, filterItems, and clearFilters.

let governmentFilterExpanded = false;
let lastGovernmentData = [];

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Populate — called from renderCards alongside populateFilters
// ---------------------------------------------------------------------------

function populateGovernmentFilters(data) {
    lastGovernmentData = data;

    const governments = extractGovernments(data);
    const filterOptions = document.getElementById('governmentFilterOptions');
    const filterSection = document.getElementById('governmentFilterSection');

    if (!filterOptions || !filterSection) return;

    if (governments.length === 0) {
        filterSection.style.display = 'none';
        return;
    }

    filterSection.style.display = 'block';

    // Only render if expanded
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
        checkbox.checked = false;
        checkbox.onchange = filterItems;

        const label = document.createElement('label');
        label.htmlFor = `gov-filter-${CSS.escape(government)}`;
        label.textContent = government;

        optionDiv.appendChild(checkbox);
        optionDiv.appendChild(label);
        filterOptions.appendChild(optionDiv);
    });
}

// ---------------------------------------------------------------------------
// Read selection
// ---------------------------------------------------------------------------

function getSelectedGovernments() {
    const checkboxes = document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]');
    const selected = [];
    checkboxes.forEach(cb => { if (cb.checked) selected.push(cb.value); });
    return selected;
}

// ---------------------------------------------------------------------------
// Per-item check — call this inside filterItems alongside category checks
// ---------------------------------------------------------------------------

function itemMatchesGovernmentFilter(item, selected) {
    if (selected.length === 0) return true;
    if (!item || typeof item.governments !== 'object') return false;
    return selected.some(g => item.governments[g] === true);
}

// ---------------------------------------------------------------------------
// Clear — plug into clearFilters
// ---------------------------------------------------------------------------

function clearGovernmentFilters() {
    const checkboxes = document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = false; });
}

// ---------------------------------------------------------------------------
// Hide/show — plug to hide and show checkboxes
// ---------------------------------------------------------------------------

function governmentFilterDisplay() {
    const filterOptions = document.getElementById('governmentFilterOptions');
    const filterTitle = document.getElementById('governmentFilterTitle');
    
    if (!filterOptions) return;

    governmentFilterExpanded = !governmentFilterExpanded;

    if (governmentFilterExpanded) {
        // Rebuild checkboxes
        if (lastGovernmentData.length) {
            filterTitle.classList.remove("filter-title-no-margin");
            filterTitle.classList.add("filter-title");
            populateGovernmentFilters(lastGovernmentData);
        }
    } else {
        filterOptions.innerHTML = ''; // clear to reduce DOM load
        filterTitle.classList.remove("filter-title");
        filterTitle.classList.add("filter-title-no-margin");
    }
}

// ---------------------------------------------------------------------------
// Global exports
// ---------------------------------------------------------------------------

window.extractGovernments          = extractGovernments;
window.populateGovernmentFilters   = populateGovernmentFilters;
window.getSelectedGovernments      = getSelectedGovernments;
window.itemMatchesGovernmentFilter = itemMatchesGovernmentFilter;
window.clearGovernmentFilters      = clearGovernmentFilters;
window.governmentFilterDisplay     = governmentFilterDisplay;
