/* ═══════════════════════════════════════════════════════════════
   navBar.js  —  Endless Sky Data Viewer  |  Top Navigation Logic
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Active page highlighting ───────────────────────────────── */
  function markActive () {
    const path = location.pathname.split('/').pop() || 'index.html';
    const page = path.replace(/\.html$/i, '').toLowerCase();

    document.querySelectorAll('#es-navbar [data-page], #es-navbar-drawer [data-page]')
      .forEach(el => {
        const key = (el.dataset.page || '').toLowerCase();
        el.classList.toggle('active', key === page);
      });
  }

  /* ── Dropdown toggle ────────────────────────────────────────── */
  function toggleDropdown (dd, evt) {
    evt.stopPropagation();
    const isOpen = dd.classList.contains('open');
    closeAllDropdowns();
    if (!isOpen) dd.classList.add('open');
  }

  function closeAllDropdowns () {
    document.querySelectorAll('#es-navbar .nav-dropdown.open')
      .forEach(el => el.classList.remove('open'));
  }

  // Wire up every dropdown toggle button
  document.querySelectorAll('#es-navbar .nav-dropdown').forEach(dd => {
    const btn = dd.querySelector('.nav-dropdown-toggle');
    if (btn) btn.addEventListener('click', e => toggleDropdown(dd, e));
  });

  // Close dropdowns when clicking anywhere outside the navbar
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#es-navbar')) closeAllDropdowns();
  });

  /* ── Mobile drawer ──────────────────────────────────────────── */
  function buildDrawer () {
    const drawer = document.getElementById('es-navbar-drawer');
    if (!drawer) return;

    const links = document.querySelectorAll('#es-nav-links > li');
    const frag  = document.createDocumentFragment();

    links.forEach(li => {
      const isDropdown = li.classList.contains('nav-dropdown');

      if (isDropdown) {
        // Group label from the toggle button text
        const toggle = li.querySelector('.nav-dropdown-toggle');
        const label  = document.createElement('div');
        label.className   = 'nav-drawer-group-label';
        label.textContent = toggle ? toggle.textContent.trim() : '';
        frag.appendChild(label);

        // Flatten sub-items into the drawer
        li.querySelectorAll('.nav-dropdown-item').forEach(item => {
          const a = document.createElement('a');
          a.href         = item.href;
          a.className    = 'nav-link';
          a.dataset.page = item.dataset.page || '';
          a.innerHTML    = item.innerHTML;
          frag.appendChild(a);
        });

        const sep = document.createElement('div');
        sep.className = 'nav-drawer-sep';
        frag.appendChild(sep);

      } else {
        const orig = li.querySelector('.nav-link');
        if (!orig) return;
        const a = document.createElement('a');
        a.href         = orig.href || '#';
        a.className    = 'nav-link';
        a.dataset.page = orig.dataset.page || '';
        a.innerHTML    = orig.innerHTML;
        frag.appendChild(a);
      }
    });

    drawer.appendChild(frag);
    markActive(); // re-run now that drawer links exist
  }

  /* ── Hamburger toggle ───────────────────────────────────────── */
  function toggleDrawer () {
    const nav    = document.getElementById('es-navbar');
    const drawer = document.getElementById('es-navbar-drawer');
    const isOpen = drawer.classList.contains('nav-drawer-open');
    nav.classList.toggle('nav-open', !isOpen);
    drawer.classList.toggle('nav-drawer-open', !isOpen);
  }

  const hamburger = document.querySelector('#es-navbar .nav-hamburger');
  if (hamburger) hamburger.addEventListener('click', toggleDrawer);

  // Close the drawer when a link inside it is clicked
  const drawer = document.getElementById('es-navbar-drawer');
  if (drawer) {
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('.nav-link')) {
        document.getElementById('es-navbar').classList.remove('nav-open');
        drawer.classList.remove('nav-drawer-open');
      }
    });
  }

  /* ── Init ───────────────────────────────────────────────────── */
  markActive();
  buildDrawer();

})();
