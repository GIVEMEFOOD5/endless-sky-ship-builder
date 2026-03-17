let categoryFilterExpanded = false;
let lastCategoryFilter = [];

// Function to extract unique categories from JSON data
function extractCategories(data) {
    const categories = new Set();
            
    // Assuming data is an array of objects
    if (Array.isArray(data)) {
        data.forEach(item => {
            // Check both item.category and item.attributes.category
            const category = item.category || item.attributes?.category;
            if (category) {
                categories.add(category);
            }
        });
    } else if (typeof data === 'object') {
        // If data is an object, check all values
        Object.values(data).forEach(item => {
            if (item) {
                const category = item.category || item.attributes?.category;
                if (category) {
                    categories.add(category);
                }
            }
        });
    }
            
    return Array.from(categories).sort();
}

// Function to populate filter checkboxes
function populateCategoryFilters(data) {
    lastCategoryFilter = data;
    const categories = extractCategories(data);
    const filterOptions = document.getElementById('filterOptions');
    const filterSection = document.getElementById('filterSection');
            
    if (categories.length === 0) {
        filterSection.classList.add("hidden");
        filterSection.classList.remove("shown");
        return;
    }
    
    // Only render if expanded
    if (!categoryFilterExpanded) {
        filterOptions.innerHTML = '';
        return;
    }
            
    categories.forEach(category => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'filter-option';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `filter-${category}`;
        checkbox.value = category;
        checkbox.checked = false;
        checkbox.onchange = filterItems;
                
        const label = document.createElement('label');
        label.htmlFor = `filter-${category}`;
        label.textContent = category;
                
        optionDiv.appendChild(checkbox);
        optionDiv.appendChild(label);
        filterOptions.appendChild(optionDiv);
    });
}

// Function to get selected categories
function getSelectedCategories() {
    const checkboxes = document.querySelectorAll('#filterOptions input[type="checkbox"]');
    const selected = [];
            
    checkboxes.forEach(cb => {
        if (cb.checked) {
            selected.push(cb.value);
        }
    });
            
    return selected;
}
        
// Function to clear all filters
function clearFilters() {
    const checkboxes = document.querySelectorAll('#filterOptions input[type="checkbox"]');
    const searchBar = document.getElementById('searchInput');
    checkboxes.forEach(cb => { cb.checked = false; });
    searchBar.value = "";
    if (typeof clearGovernmentFilters === 'function') clearGovernmentFilters();
    filterItems();
}

function categoryFilterDisplay() {
    const filterOptions = document.getElementById('filterOptions');
    const filterTitle = document.getElementById('categoryFilterTitle');
    
    if (!filterOptions) return;

    categoryFilterExpanded = !categoryFilterExpanded;

    if (categoryFilterExpanded) {
        // Rebuild checkboxes
        if (lastCategoryFilter.length) {
            filterTitle.classList.remove("filter-title-no-margin");
            filterTitle.classList.add("filter-title");
            filterTitle.innerHTML = 'Filter by Category: 🡆'
            populateCategoryFilters(lastCategoryFilter);
        }
    } else {
        filterOptions.innerHTML = ''; // clear to reduce DOM load
        filterTitle.classList.remove("filter-title");
        filterTitle.classList.add("filter-title-no-margin");
        filterTitle.innerHTML = 'Filter by Category: 🡇'
    }
}


// Make functions globally accessible for HTML onclick attributes
window.clearFilters = clearFilters;
window.populateCategoryFilters = populateCategoryFilters;
window.getSelectedCategories = getSelectedCategories;
window.categoryFilterDisplay     = categoryFilterDisplay;
