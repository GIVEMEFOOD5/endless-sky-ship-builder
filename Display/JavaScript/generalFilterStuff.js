let filtersExpanded = true;
let lastFilterItems = [];

// Function to clear all filters
function clearFilters() {
    const checkboxes = document.querySelectorAll('#filterOptions input[type="checkbox"]');
    const searchBar = document.getElementById('searchInput');
    checkboxes.forEach(cb => { cb.checked = false; });
    searchBar.value = "";
    if (typeof clearGovernmentFilters === 'function') clearGovernmentFilters();
    filterItems();
}

function getFilterData(data) {
        lastFilterItems = data;
}

function filterDisplay() {
    
    const governmentFilterSection = document.getElementById('governmentFilterSection');
    const categoryFilterSection = document.getElementById('filterSection');
    const filterTitle = document.getElementById('filterTitle');
    
    if (!filterOptions) return;

    filtersExpanded = !filtersExpanded;

    if (filtersExpanded) {
        // Rebuild checkboxes
        if (lastFilterItems.length) {
            //filterTitle.classList.remove("filter-title-no-margin");
            //filterTitle.classList.add("filter-title");
            filterTitle.innerHTML = 'Filters 🡆'
            populateGovernmentFilters(lastFilterItems);
            populateCategoryFilters(lastFilterItems);
        }
    } else {
        //filterOptions.innerHTML = ''; // clear to reduce DOM load
        //filterTitle.classList.remove("filter-title");
        //filterTitle.classList.add("filter-title-no-margin");
        filterTitle.innerHTML = 'Filters 🡇'
    }
}

// Make functions globally accessible for HTML onclick attributes
window.clearFilters = clearFilters;
window.filterDisplay = filterDisplay;
window.getFilterData = getFilterData;
