function filterItems() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const selectedCategories = getSelectedCategories();
    const container = document.getElementById('cardsContainer');

    const filtered = filteredData.filter(item => {
        // Check if item matches search term
        const matchesSearch = item.name && item.name.toLowerCase().includes(searchTerm);
        
        // Get category - handle both item.category and item.attributes.category
        const itemCategory = item.category || item.attributes?.category;
        
        // Check if item matches selected categories
        const matchesCategory = selectedCategories.length === 0 || 
                                !itemCategory || 
                                selectedCategories.includes(itemCategory);
        
        // Item must match both search and category
        return matchesSearch && matchesCategory;
    });

    container.innerHTML = '';

    if (filtered.length === 0) {
        container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #94a3b8; padding: 40px;">No items found</p>';
        return;
    }

    filtered.forEach(item => {
        const card = createCard(item);
        container.appendChild(card);
    });
}

window.filterItems = filterItems;