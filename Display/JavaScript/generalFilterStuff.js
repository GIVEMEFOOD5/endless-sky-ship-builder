let filtersExpanded = true;
let lastFilterItems = [];
//let savedCategoryFilterState = {};
//let savedGovernmentFilterState = {};

// Function to clear all filters
function clearFilters() {
    savedCategoryFilterState = {};
    savedGovernmentFilterState = {};
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

    if (!governmentFilterSection || !categoryFilterSection || !filterTitle) return;

    filtersExpanded = !filtersExpanded;

    if (filtersExpanded) {
        filterTitle.innerHTML = 'Filters ▶';
        governmentFilterSection.classList.remove("hidden");
        categoryFilterSection.classList.remove("hidden");
        governmentFilterSection.classList.add("shown");
        categoryFilterSection.classList.add("shown");

        if (lastFilterItems.length) {
            populateGovernmentFilters(lastFilterItems);
            populateCategoryFilters(lastFilterItems);

            // Restore category state
            document.querySelectorAll('#filterOptions input[type="checkbox"]').forEach(cb => {
                if (savedCategoryFilterState[cb.value] !== undefined) {
                    cb.checked = savedCategoryFilterState[cb.value];
                }
            });

            // Restore government state
            document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]').forEach(cb => {
                if (savedGovernmentFilterState[cb.value] !== undefined) {
                    cb.checked = savedGovernmentFilterState[cb.value];
                }
            });
        }
    } else {
        // Save category state before hiding
        document.querySelectorAll('#filterOptions input[type="checkbox"]').forEach(cb => {
            savedCategoryFilterState[cb.value] = cb.checked;
        });

        // Save government state before hiding
        document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]').forEach(cb => {
            savedGovernmentFilterState[cb.value] = cb.checked;
        });

        filterTitle.innerHTML = 'Filters ▼';
        governmentFilterSection.classList.add("hidden");
        categoryFilterSection.classList.add("hidden");
        governmentFilterSection.classList.remove("shown");
        categoryFilterSection.classList.remove("shown");
    }
}

window.clearFilters = clearFilters;
window.filterDisplay = filterDisplay;
window.getFilterData = getFilterData;
