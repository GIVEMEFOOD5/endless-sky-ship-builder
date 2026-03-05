// governmentFilter.js
// Extracts unique governments from ships/variants/outfits JSON data
// and renders them as checkboxes, mirroring the category filter pattern.

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Collect every government key from a ships, variants, or outfits array.
 * Each item has a `governments` object where keys are government names.
 *
 * e.g. item.governments = { "Republic": true, "Syndicate": true }
 */
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
// Populate
// ---------------------------------------------------------------------------

/**
 * Populate the government filter checkboxes from the loaded plugin data.
 * Expects the page to have:
 *   <div id="governmentFilterSection">
 *     <div id="governmentFilterOptions"></div>
 *   </div>
 *
 * @param {Array|Object} data  - ships, variants, or outfits array/object
 * @param {Function}     onChangeCallback  - called whenever a checkbox changes
 */
function populateGovernmentFilters(data, onChangeCallback) {
    const governments = extractGovernments(data);
    const filterOptions = document.getElementById('governmentFilterOptions');
    const filterSection = document.getElementById('governmentFilterSection');

    if (!filterOptions || !filterSection) {
        console.warn('governmentFilter: missing #governmentFilterOptions or #governmentFilterSection elements');
        return;
    }

    if (governments.length === 0) {
        filterSection.style.display = 'none';
        return;
    }

    filterSection.style.display = 'block';
    filterOptions.innerHTML = '';

    governments.forEach(government => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'filter-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `gov-filter-${CSS.escape(government)}`;
        checkbox.value = government;
        checkbox.checked = false;
        checkbox.onchange = onChangeCallback || filterByGovernment;

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

/**
 * Returns an array of the currently checked government names.
 * Returns an empty array if none are checked (meaning "show all").
 */
function getSelectedGovernments() {
    const checkboxes = document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]');
    const selected = [];

    checkboxes.forEach(cb => {
        if (cb.checked) selected.push(cb.value);
    });

    return selected;
}

// ---------------------------------------------------------------------------
// Filter logic
// ---------------------------------------------------------------------------

/**
 * Returns true if the item should be shown given the currently selected governments.
 * If no governments are selected, all items pass.
 *
 * @param {Object}   item        - a ship, variant, or outfit object
 * @param {string[]} selected    - array from getSelectedGovernments()
 */
function itemMatchesGovernmentFilter(item, selected) {
    if (selected.length === 0) return true;
    if (!item || typeof item.governments !== 'object') return false;
    return selected.some(g => item.governments[g] === true);
}

/**
 * Default filter handler — override with your own or pass a callback to
 * populateGovernmentFilters(). Dispatches a custom event so the rest of
 * your page can react without tight coupling.
 */
function filterByGovernment() {
    const selected = getSelectedGovernments();
    document.dispatchEvent(new CustomEvent('governmentFilterChanged', {
        detail: { selected }
    }));
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

/**
 * Uncheck all government checkboxes and trigger the filter callback.
 */
function clearGovernmentFilters() {
    const checkboxes = document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = false; });
    filterByGovernment();
}

// ---------------------------------------------------------------------------
// Exports — global (mirrors the pattern in your existing filter file)
// ---------------------------------------------------------------------------

window.extractGovernments          = extractGovernments;
window.populateGovernmentFilters   = populateGovernmentFilters;
window.getSelectedGovernments      = getSelectedGovernments;
window.itemMatchesGovernmentFilter = itemMatchesGovernmentFilter;
window.clearGovernmentFilters      = clearGovernmentFilters;
