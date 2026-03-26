/* ═══════════════════════════════════════════════════════════════
   navBar.js  —  Endless Sky Data Viewer  |  Top Navigation
   Logic only — HTML is loaded from NavBar.html via navLoader.js
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── 1. Dropdowns ───────────────────────────────────────────── */
  function closeAllDropdowns () {
    document.querySelectorAll('#es-navbar .nav-dropdown.open')
      .forEach(el => el.classList.remove('open'));
  }

  document.querySelectorAll('#es-navbar .nav-dropdown').forEach(function (dd) {
    const btn = dd.querySelector('.nav-dropdown-toggle');
    if (!btn) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const isOpen = dd.classList.contains('open');
      closeAllDropdowns();
      if (!isOpen) dd.classList.add('open');
    });
  });

  // Click outside navbar closes all dropdowns
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#es-navbar')) closeAllDropdowns();
  });

  /* ── 2. Mobile hamburger ────────────────────────────────────── */
  const hamburger = document.querySelector('#es-navbar .nav-hamburger');
  if (hamburger) {
    hamburger.addEventListener('click', function () {
      const nav    = document.getElementById('es-navbar');
      const drawer = document.getElementById('es-navbar-drawer');
      const isOpen = drawer.classList.contains('nav-drawer-open');
      nav.classList.toggle('nav-open', !isOpen);
      drawer.classList.toggle('nav-drawer-open', !isOpen);
    });
  }

  // Clicking a link in the drawer closes it
  const drawer = document.getElementById('es-navbar-drawer');
  if (drawer) {
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('.nav-link')) {
        document.getElementById('es-navbar').classList.remove('nav-open');
        drawer.classList.remove('nav-drawer-open');
      }
    });
  }

  /* ── 3. Mobile drawer — mirror desktop links ────────────────── */
  function buildDrawer () {
    const drawer = document.getElementById('es-navbar-drawer');
    if (!drawer) return;
    const frag = document.createDocumentFragment();

    document.querySelectorAll('#es-nav-links > li').forEach(function (li) {
      if (li.classList.contains('nav-dropdown')) {
        const toggle = li.querySelector('.nav-dropdown-toggle');
        const label  = document.createElement('div');
        label.className   = 'nav-drawer-group-label';
        label.textContent = toggle ? toggle.textContent.trim() : '';
        frag.appendChild(label);

        li.querySelectorAll('.nav-dropdown-item').forEach(function (item) {
          const a = document.createElement('a');
          a.href         = item.getAttribute('href');
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
        a.href         = orig.getAttribute('href') || '#';
        a.className    = 'nav-link';
        a.dataset.page = orig.dataset.page || '';
        a.innerHTML    = orig.innerHTML;
        frag.appendChild(a);
      }
    });

    drawer.appendChild(frag);
  }

  /* ── 4. Active link highlighting ────────────────────────────── */
  function markActive () {
    const page = location.pathname.split('/').pop().replace(/\.html$/i, '').toLowerCase();
    document.querySelectorAll('#es-navbar [data-page], #es-navbar-drawer [data-page]')
      .forEach(function (el) {
        el.classList.toggle('active', (el.dataset.page || '').toLowerCase() === page);
      });
  }

  /* ── Init ───────────────────────────────────────────────────── */
  buildDrawer();
  markActive();

})();
