let _filterGeneration = 0;

async function filterItems() {
    const myGeneration = ++_filterGeneration;  // claim this search's generation

    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const selectedCategories = getSelectedCategories();
    const container = document.getElementById('cardsContainer');
    const filtered = filteredData.filter(item => {
        const matchesSearch = item.name && item.name.toLowerCase().includes(searchTerm);
        const itemCategory = item.category || item.attributes?.category;
        const selectedGovts = getSelectedGovernments();
        const matchesCategory = selectedCategories.length === 0 || 
                                !itemCategory || 
                                selectedCategories.includes(itemCategory);
        return matchesSearch && matchesCategory && itemMatchesGovernmentFilter(item, selectedGovts);
    });

    const display = typeof applySorters === 'function' ? applySorters(filtered) : filtered;
    if (typeof setSorterItems === 'function') setSorterItems(display);

    container.innerHTML = '';
    if (display.length === 0) {
        container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #94a3b8; padding: 40px;">No items found</p>';
        return;
    }

    for (const item of display) {
        // If a newer search has started, stop appending old results
        if (myGeneration !== _filterGeneration) return;

        const card = await createCard(item);

        if (myGeneration !== _filterGeneration) return;
        container.appendChild(card);
    }
}

window.filterItems = filterItems;
