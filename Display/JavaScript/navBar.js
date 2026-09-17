/* ═══════════════════════════════════════════════════════════════
   navBar.js  —  Endless Sky Data Viewer  |  Top Navigation Logic
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Helpers ────────────────────────────────────────────────── */
  function isDrawerOpen () {
    return document.querySelector('.es-nav__drawer') &&
           document.querySelector('.es-nav__drawer').classList.contains('nav-drawer-open');
  }

  /* ── 1. Desktop dropdowns ───────────────────────────────────── */
  function closeAllDropdowns () {
    document.querySelectorAll('.es-nav__dropdown.open')
      .forEach(el => el.classList.remove('open'));
  }

  function positionDropdown (dd) {
    const toggle = dd.querySelector('.es-nav__dropdown-toggle');
    const menu   = dd.querySelector('.es-nav__dropdown-menu');
    if (!toggle || !menu) return;
    const rect   = toggle.getBoundingClientRect();
    menu.style.top  = rect.bottom + 8 + 'px';
    menu.style.left = rect.left   + 'px';
  }

  document.querySelectorAll('.es-nav__dropdown').forEach(function (dd) {
    const btn = dd.querySelector('.es-nav__dropdown-toggle');
    if (!btn) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();

      // In drawer mode, dropdowns are not used — items are already flat
      if (isDrawerOpen()) return;

      const isOpen = dd.classList.contains('open');
      closeAllDropdowns();
      if (!isOpen) {
        dd.classList.add('open');
        positionDropdown(dd);
      }
    });
  });

  // Click outside: close dropdowns AND close drawer
  document.addEventListener('click', function (e) {
    const nav    = document.querySelector('.es-nav');
    const drawer = document.querySelector('.es-nav__drawer');

    if (!e.target.closest('.es-nav') && !e.target.closest('.es-nav__drawer')) {
      closeAllDropdowns();
      // Close drawer
      if (drawer) drawer.classList.remove('nav-drawer-open');
      if (nav)    nav.classList.remove('nav-open');
    }
  });

  /* ── 2. Mobile hamburger ────────────────────────────────────── */
  const hamburger = document.querySelector('.es-nav__hamburger');
  if (hamburger) {
    hamburger.addEventListener('click', function (e) {
      e.stopPropagation();
      const nav    = document.querySelector('.es-nav');
      const drawer = document.querySelector('.es-nav__drawer');
      const isOpen = drawer.classList.contains('nav-drawer-open');
      nav.classList.toggle('nav-open', !isOpen);
      drawer.classList.toggle('nav-drawer-open', !isOpen);
    });
  }

  // Clicking a flat link in the drawer closes it
  const drawer = document.querySelector('.es-nav__drawer');
  if (drawer) {
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('.es-nav__link') || e.target.closest('.es-nav__dropdown-item')) {
        document.querySelector('.es-nav').classList.remove('nav-open');
        drawer.classList.remove('nav-drawer-open');
      }
    });
  }

  /* ── 3. Mobile drawer — flat list (no nested dropdowns) ─────── */
  function buildDrawer () {
    const drawer = document.querySelector('.es-nav__drawer');
    if (!drawer) return;
    const frag = document.createDocumentFragment();

    document.querySelectorAll('#es-nav-links > li').forEach(function (li) {
      if (li.classList.contains('es-nav__dropdown')) {
        // Group label
        const toggle = li.querySelector('.es-nav__dropdown-toggle');
        const label  = document.createElement('div');
        label.className   = 'nav-drawer-group-label';
        label.textContent = toggle ? toggle.textContent.trim() : '';
        frag.appendChild(label);

        // Flatten every sub-item directly into the drawer — no nested menu
        li.querySelectorAll('.es-nav__dropdown-item').forEach(function (item) {
          const a = document.createElement('a');
          a.href         = item.getAttribute('href');
          a.className    = 'es-nav__link';
          a.dataset.page = item.dataset.page || '';
          a.innerHTML    = item.innerHTML;
          frag.appendChild(a);
        });

        const sep = document.createElement('div');
        sep.className = 'nav-drawer-sep';
        frag.appendChild(sep);

      } else {
        const orig = li.querySelector('.es-nav__link');
        if (!orig) return;
        const a = document.createElement('a');
        a.href         = orig.getAttribute('href') || '#';
        a.className    = 'es-nav__link';
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

    // Clear all active states first
    document.querySelectorAll('.es-nav .active, .es-nav__drawer .active')
      .forEach(function (el) { el.classList.remove('active'); });

    // Mark any link whose data-page matches the current filename
    var matched = false;
    document.querySelectorAll('[data-page]').forEach(function (el) {
      if ((el.dataset.page || '').toLowerCase() === page) {
        el.classList.add('active');
        matched = true;

        // If this item is inside a dropdown menu, also highlight the toggle
        var menu = el.closest('.es-nav__dropdown-menu');
        if (menu) {
          var toggle = el.closest('.es-nav__dropdown')
                         .querySelector('.es-nav__dropdown-toggle');
          if (toggle) toggle.classList.add('active');
        }
      }
    });
  }

  /* ── Init ───────────────────────────────────────────────────── */
  buildDrawer();
  markActive();

  /* ── Account widget ─────────────────────────────────────────────
     Waits for window.EsAuth to exist rather than assuming exact script
     order between pages — auth.js/supabaseClient.js are expected to
     load early on every page, but this degrades gracefully (just
     doesn't show the widget) if they're missing rather than erroring. */
  function waitForAuth(retriesLeft) {
    if (window.EsAuth) { initAccountWidget(); return; }
    if (retriesLeft <= 0) return; // no auth.js on this page — nothing to do
    setTimeout(function () { waitForAuth(retriesLeft - 1); }, 100);
  }

  function initAccountWidget() {
    var mount = document.getElementById('es-nav-account');
    var modal = document.getElementById('es-nav-auth-modal');
    var form  = document.getElementById('es-nav-auth-form');
    var errorBox = document.getElementById('es-nav-auth-error');
    if (!mount || !modal || !form) return;

    function renderSignedOut() {
      mount.innerHTML = '<button type="button" class="es-nav__link" id="es-nav-login-btn">👤 Log in</button>';
      document.getElementById('es-nav-login-btn').addEventListener('click', function () {
        errorBox.hidden = true;
        form.reset();
        modal.hidden = false;
      });
    }

    function renderSignedIn(user) {
      var email = user.email || 'Account';
      mount.innerHTML =
        '<span class="es-nav__account-email" title="' + email + '">👤 ' + email + '</span>' +
        '<button type="button" class="es-nav__link" id="es-nav-logout-btn">Log out</button>';
      document.getElementById('es-nav-logout-btn').addEventListener('click', function () {
        window.EsAuth.signOut();
      });
    }

    window.EsAuth.onAuthChange(function (user) {
      if (user) renderSignedIn(user); else renderSignedOut();
    });

    modal.querySelector('.es-nav__auth-modal-close').addEventListener('click', function () {
      modal.hidden = true;
    });
    modal.querySelector('.es-nav__auth-modal-backdrop').addEventListener('click', function () {
      modal.hidden = true;
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var action = e.submitter ? e.submitter.dataset.action : 'signin';
      var email = document.getElementById('es-nav-auth-email').value.trim();
      var password = document.getElementById('es-nav-auth-password').value;
      errorBox.hidden = true;

      var task = action === 'signup'
        ? window.EsAuth.signUp(email, password)
        : window.EsAuth.signIn(email, password);

      task.then(function () {
        modal.hidden = true;
      }).catch(function (err) {
        errorBox.textContent = err.message || 'Something went wrong — try again.';
        errorBox.hidden = false;
      });
    });
  }

  waitForAuth(30); // ~3 seconds total before giving up

})();
