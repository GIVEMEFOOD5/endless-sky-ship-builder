let filtersExpanded = true;

function filterDisplay() {
    const governmentFilterSection = document.getElementById('governmentFilterSection');
    const categoryFilterSection = document.getElementById('filterSection');
    const filterTitle = document.getElementById('filterSection');
  
    
    if (!filterOptions) return;

    governmentFilterExpanded = !governmentFilterExpanded;

    if (governmentFilterExpanded) {
        // Rebuild checkboxes
        if (lastGovernmentData.length) {
            filterTitle.classList.remove("filter-title-no-margin");
            filterTitle.classList.add("filter-title");
            filterTitle.innerHTML = 'Filter by Government: 🡆'
            populateGovernmentFilters(lastGovernmentData);
        }
    } else {
        filterOptions.innerHTML = ''; // clear to reduce DOM load
        filterTitle.classList.remove("filter-title");
        filterTitle.classList.add("filter-title-no-margin");
        filterTitle.innerHTML = 'Filter by Government: 🡇'
    }
}
