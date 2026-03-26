/* ═══════════════════════════════════════════════════════════════
   navBar.js  —  Endless Sky Data Viewer  |  Top Navigation
   Drop a single <script src="../JavaScript/navBar.js"></script>
   anywhere in <body> and this file does everything:
     1. Writes the navbar HTML into #navbar-mount (or prepends to body)
     2. Attaches all event listeners
     3. Highlights the active page link
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── 1. Inject markup ───────────────────────────────────────── */
  const NAV_HTML = `
<nav id="es-navbar">

  <a href="index.html" class="nav-brand">
    <span class="nav-brand-icon">🚀</span>
    Endless Sky
  </a>

  <div class="nav-divider"></div>

  <!-- ╔══════════════════════════════════════════════════════╗
       ║  EDIT YOUR PAGES HERE                                ║
       ║  data-page must match the HTML filename (no .html)   ║
       ╚══════════════════════════════════════════════════════╝ -->
  <ul class="nav-links" id="es-nav-links">

    <li>
      <a href="DataViewer.html" class="nav-link" data-page="dataviewer">
        <span class="nav-icon">🔭</span> Data Viewer
      </a>
    </li>

    <li class="nav-dropdown" id="nav-dd-browse">
      <button class="nav-link nav-dropdown-toggle" data-page="browse">
        <span class="nav-icon">📦</span> Browse
      </button>
      <div class="nav-dropdown-menu">
        <a href="Ships.html"       class="nav-dropdown-item" data-page="ships">
          <span class="nav-icon">🛸</span> Ships
        </a>
        <a href="Outfits.html"     class="nav-dropdown-item" data-page="outfits">
          <span class="nav-icon">⚙️</span> Outfits
        </a>
        <a href="Variants.html"    class="nav-dropdown-item" data-page="variants">
          <span class="nav-icon">🔀</span> Variants
        </a>
        <div class="nav-dropdown-sep"></div>
        <a href="Governments.html" class="nav-dropdown-item" data-page="governments">
          <span class="nav-icon">🏛️</span> Governments
        </a>
        <a href="Systems.html"     class="nav-dropdown-item" data-page="systems">
          <span class="nav-icon">🌌</span> Systems
        </a>
      </div>
    </li>

    <li class="nav-dropdown" id="nav-dd-tools">
      <button class="nav-link nav-dropdown-toggle" data-page="tools">
        <span class="nav-icon">🛠️</span> Tools
      </button>
      <div class="nav-dropdown-menu">
        <a href="Comparator.html"  class="nav-dropdown-item" data-page="comparator">
          <span class="nav-icon">⚖️</span> Comparator
        </a>
        <a href="FitEditor.html"   class="nav-dropdown-item" data-page="fiteditor">
          <span class="nav-icon">🔧</span> Fit Editor
        </a>
        <a href="Calculator.html"  class="nav-dropdown-item" data-page="calculator">
          <span class="nav-icon">🧮</span> Calculator
        </a>
      </div>
    </li>

    <li>
      <a href="Plugins.html" class="nav-link" data-page="plugins">
        <span class="nav-icon">🧩</span> Plugins
      </a>
    </li>

    <li>
      <a href="About.html" class="nav-link" data-page="about">
        <span class="nav-icon">ℹ️</span> About
      </a>
    </li>

  </ul>

  <div class="nav-spacer"></div>

  <button class="nav-hamburger" id="es-nav-hamburger" aria-label="Toggle menu">
    <span></span><span></span><span></span>
  </button>

</nav>

<div id="es-navbar-drawer"></div>
`;

  // Write into #navbar-mount if it exists, otherwise prepend to body
  const mount = document.getElementById('navbar-mount');
  if (mount) {
    mount.innerHTML = NAV_HTML;
  } else {
    document.body.insertAdjacentHTML('afterbegin', NAV_HTML);
  }

  /* ── 2. Dropdowns ───────────────────────────────────────────── */
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

  /* ── 3. Mobile hamburger ────────────────────────────────────── */
  document.getElementById('es-nav-hamburger').addEventListener('click', function () {
    const nav    = document.getElementById('es-navbar');
    const drawer = document.getElementById('es-navbar-drawer');
    const isOpen = drawer.classList.contains('nav-drawer-open');
    nav.classList.toggle('nav-open', !isOpen);
    drawer.classList.toggle('nav-drawer-open', !isOpen);
  });

  // Clicking a link in the drawer closes it
  document.getElementById('es-navbar-drawer').addEventListener('click', function (e) {
    if (e.target.closest('.nav-link')) {
      document.getElementById('es-navbar').classList.remove('nav-open');
      document.getElementById('es-navbar-drawer').classList.remove('nav-drawer-open');
    }
  });

  /* ── 4. Mobile drawer — mirror desktop links ────────────────── */
  function buildDrawer () {
    const drawer = document.getElementById('es-navbar-drawer');
    const frag   = document.createDocumentFragment();

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

  /* ── 5. Active link highlighting ────────────────────────────── */
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
