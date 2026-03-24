let _filterGeneration = 0;

async function filterItems() {
    const myGeneration = ++_filterGeneration;
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const selectedCategories = getSelectedCategories();
    const selectedGovts = getSelectedGovernments();
    const container = document.getElementById('cardsContainer');

    const filtered = filteredData.filter(item => {
        const matchesSearch = !searchTerm || (item.name && item.name.toLowerCase().includes(searchTerm));
        const itemCategory = item.category || item.attributes?.category;
        const matchesCategory = selectedCategories.length === 0 || !itemCategory || selectedCategories.includes(itemCategory);
        return matchesSearch && matchesCategory && itemMatchesGovernmentFilter(item, selectedGovts);
    });

    const display = typeof applySorters === 'function' ? applySorters(filtered) : filtered;
    if (typeof setSorterItems === 'function') setSorterItems(display);

    if (myGeneration !== _filterGeneration) return;

    container.innerHTML = '';

    if (display.length === 0) {
        container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #94a3b8; padding: 40px;">No items found</p>';
        return;
    }

    // Build cards in chunks to avoid freezing the browser on large datasets
    const CHUNK_SIZE = 500;
    for (let i = 0; i < display.length; i += CHUNK_SIZE) {
        if (myGeneration !== _filterGeneration) return;

        const chunk = display.slice(i, i + CHUNK_SIZE);
        const fragment = document.createDocumentFragment();
        for (const item of chunk) {
            fragment.appendChild(createCardPlaceholder(item));
        }
        container.appendChild(fragment);

        // Yield to browser between chunks so it stays responsive
        if (i + CHUNK_SIZE < display.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (myGeneration !== _filterGeneration) return;
    initLazySprites(myGeneration);
}

window.filterItems = filterItems;
