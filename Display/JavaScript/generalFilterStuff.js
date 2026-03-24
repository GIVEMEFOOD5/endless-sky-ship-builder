'use strict';

// ─── generalFilterStuff.js ────────────────────────────────────────────────────
//
// Owns:
//   • filterDisplay()   — top-level show/hide of the entire filter section
//   • getFilterData()   — caches the current item list for repopulation
//   • filterItems()     — core filter+sort+render loop (debounced)
//
// Delegates category/government state to CheckBoxFilter.js &
// GovernmentsFilter.js which are loaded before this file.
// ─────────────────────────────────────────────────────────────────────────────

let filtersExpanded = true;
let lastFilterItems = [];

// ── filterDisplay ─────────────────────────────────────────────────────────────

function filterDisplay() {
    const govSection      = document.getElementById('governmentFilterSection');
    const catSection      = document.getElementById('filterSection');
    const filterTitle     = document.getElementById('filterTitle');
    if (!govSection || !catSection || !filterTitle) return;

    filtersExpanded = !filtersExpanded;

    if (filtersExpanded) {
        filterTitle.textContent = 'Filters ▶';
        govSection.classList.remove('hidden');
        catSection.classList.remove('hidden');
        govSection.classList.add('shown');
        catSection.classList.add('shown');

        if (lastFilterItems.length) {
            populateGovernmentFilters(lastFilterItems);
            populateCategoryFilters(lastFilterItems);
        }
    } else {
        // Persist checkbox state before hiding
        document.querySelectorAll('#filterOptions input[type="checkbox"]').forEach(cb => {
            savedCategoryFilterState[cb.value] = cb.checked;
        });
        document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]').forEach(cb => {
            savedGovernmentFilterState[cb.value] = cb.checked;
        });

        filterTitle.textContent = 'Filters ▼';
        govSection.classList.add('hidden');
        catSection.classList.add('hidden');
        govSection.classList.remove('shown');
        catSection.classList.remove('shown');
    }
}

// ── getFilterData ─────────────────────────────────────────────────────────────

function getFilterData(data) {
    lastFilterItems = data;
}

// ── filterItems (debounced) ───────────────────────────────────────────────────
//
// Uses a generation counter so stale async renders are aborted.
// A 60 ms debounce on the search path avoids re-rendering on every keystroke.

// Shared with Plugin_Script._loadSpriteForCard — must be on window so both
// modules read the same value regardless of load order.
if (typeof window._filterGeneration === 'undefined') window._filterGeneration = 0;

let _filterDebounceTimer = null;
const FILTER_DEBOUNCE_MS = 60;

function filterItems() {
    clearTimeout(_filterDebounceTimer);
    _filterDebounceTimer = setTimeout(_runFilter, FILTER_DEBOUNCE_MS);
}

async function _runFilter() {
    const myGeneration = ++window._filterGeneration;

    // ── Read inputs (batch DOM reads up-front, no interleaved reads/writes) ──
    const searchTerm         = (document.getElementById('searchInput')?.value ?? '').toLowerCase().trim();
    const selectedCategories = getSelectedCategories();
    const selectedGovts      = getSelectedGovernments();
    const container          = document.getElementById('cardsContainer');
    if (!container) return;

    // ── Filter ────────────────────────────────────────────────────────────────
    const hasSearch = searchTerm.length > 0;
    const hasCat    = selectedCategories.length > 0;
    const hasGov    = selectedGovts.length > 0;

    const filtered = filteredData.filter(item => {
        if (hasSearch && !(item.name && item.name.toLowerCase().includes(searchTerm))) return false;
        if (hasCat) {
            const cat = item.category ?? item.attributes?.category;
            if (cat && !selectedCategories.includes(cat)) return false;
        }
        if (hasGov && !itemMatchesGovernmentFilter(item, selectedGovts)) return false;
        return true;
    });

    // ── Sort ──────────────────────────────────────────────────────────────────
    const display = typeof applySorters === 'function' ? applySorters(filtered) : filtered;
    if (typeof setSorterItems === 'function') setSorterItems(display);

    if (myGeneration !== window._filterGeneration) return;

    // ── Render (chunked to keep frame budget) ─────────────────────────────────
    container.textContent = '';

    if (display.length === 0) {
        const msg = document.createElement('p');
        msg.style.cssText = 'grid-column:1/-1;text-align:center;color:#94a3b8;padding:40px;';
        msg.textContent   = 'No items found';
        container.appendChild(msg);
        return;
    }

    const CHUNK = 200;
    for (let i = 0; i < display.length; i += CHUNK) {
        if (myGeneration !== window._filterGeneration) return;

        const frag = document.createDocumentFragment();
        const end  = Math.min(i + CHUNK, display.length);
        for (let j = i; j < end; j++) {
            frag.appendChild(createCardPlaceholder(display[j]));
        }
        container.appendChild(frag);

        if (end < display.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (myGeneration !== window._filterGeneration) return;
    initLazySprites(myGeneration);
}

// ── Exports ───────────────────────────────────────────────────────────────────

window.filterItems   = filterItems;
window.filterDisplay = filterDisplay;
window.getFilterData = getFilterData;