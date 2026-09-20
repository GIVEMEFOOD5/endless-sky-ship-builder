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
    var mount    = document.getElementById('es-nav-account');
    var overlay  = document.getElementById('es-nav-auth-overlay');
    var closeBtn = document.getElementById('es-nav-auth-close');
    var tabs     = overlay ? overlay.querySelectorAll('.modal-tab') : [];
    var signinForm = document.getElementById('es-nav-signin-form');
    var signupForm = document.getElementById('es-nav-signup-form');
    if (!mount || !overlay || !signinForm || !signupForm) return;

    function openModal(mode) {
      setMode(mode || 'signin');
      overlay.classList.add('active');
      var firstInput = (mode === 'signup' ? signupForm : signinForm).querySelector('input');
      if (firstInput) setTimeout(function () { firstInput.focus(); }, 50);
    }
    // Lets other files (e.g. shipBuilder.js's "save to account" flow)
    // trigger the login modal directly rather than duplicating it.
    window.openAuthModal = openModal;
    function closeModal() {
      overlay.classList.remove('active');
      signinForm.reset();
      signupForm.reset();
      setFieldError('signin', '');
      setFieldError('signup', '');
      setUsernameHint('', '');
    }
    function setMode(mode) {
      tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === mode); });
      signinForm.style.display = mode === 'signin' ? 'block' : 'none';
      signupForm.style.display = mode === 'signup' ? 'block' : 'none';
      overlay.querySelector('[data-mode-for="signin"]').style.display = mode === 'signin' ? 'inline' : 'none';
      overlay.querySelector('[data-mode-for="signup"]').style.display = mode === 'signup' ? 'inline' : 'none';
    }

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { setMode(tab.dataset.tab); });
    });
    overlay.querySelectorAll('[data-switch-to]').forEach(function (btn) {
      btn.addEventListener('click', function () { setMode(btn.dataset.switchTo); });
    });
    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('active')) closeModal();
    });

    function setFieldError(form, message, isSuccess) {
      var box = document.getElementById('es-nav-' + form + '-error');
      if (!box) return;
      if (!message) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="' + (isSuccess ? 'auth-form-success' : 'auth-form-error') + '">' + message + '</div>';
    }

    function setUsernameHint(text, kind) {
      var hint = document.getElementById('es-nav-signup-username-hint');
      if (!hint) return;
      hint.textContent = text;
      hint.className = 'auth-field-hint' + (kind ? ' auth-field-hint--' + kind : '');
    }

    function setLoading(form, loading, defaultLabel) {
      var btn = form.querySelector('button[type="submit"]');
      if (!btn) return;
      btn.disabled = loading;
      btn.textContent = loading ? 'Please wait…' : defaultLabel;
    }

    // Live username availability check, debounced so it doesn't fire a
    // Supabase query on every single keystroke.
    var usernameInput = document.getElementById('es-nav-signup-username');
    var usernameCheckTimer = null;
    usernameInput.addEventListener('input', function () {
      var value = usernameInput.value.trim();
      clearTimeout(usernameCheckTimer);
      if (value.length < 3) { setUsernameHint('', ''); return; }
      setUsernameHint('Checking…', 'checking');
      usernameCheckTimer = setTimeout(function () {
        window.EsAuth.isUsernameAvailable(value).then(function (available) {
          if (usernameInput.value.trim() !== value) return; // stale — value changed since the check started
          setUsernameHint(available ? '✓ Available' : '✗ Already taken', available ? 'ok' : 'bad');
        }).catch(function () { setUsernameHint('', ''); });
      }, 350);
    });

    // Mobile: the top-bar widget hides at ≤600px (see main.css) since
    // there's no room for it alongside the brand and hamburger. This is
    // its replacement inside the drawer instead — appended now rather
    // than in the static HTML, so it lands AFTER the flattened nav
    // links (buildDrawer() already ran before initAccountWidget() is
    // reached, so appending here puts it at the bottom, not the top).
    var drawer = document.querySelector('.es-nav__drawer');
    var drawerMount = null;
    if (drawer) {
      drawerMount = document.createElement('div');
      drawerMount.id = 'es-nav-drawer-account';
      drawerMount.className = 'nav-drawer-account';
      drawer.appendChild(drawerMount);
    }

    function renderSignedOut() {
      mount.innerHTML = '<button type="button" class="es-nav__link" id="es-nav-login-btn">👤 Log in</button>';
      document.getElementById('es-nav-login-btn').addEventListener('click', function () { openModal('signin'); });

      if (drawerMount) {
        drawerMount.innerHTML = '<button type="button" class="es-nav__link" id="es-nav-drawer-login-btn">👤 Log in</button>';
        document.getElementById('es-nav-drawer-login-btn').addEventListener('click', function () {
          closeDrawerIfOpen();
          openModal('signin');
        });
      }
      scheduleNavOverflowCheck();
    }

    function renderSignedIn(user, profile) {
      // Text label again ("Log out"), but still no username shown in the
      // top bar itself — that stays in the drawer only, where there's
      // room for it.
      mount.innerHTML = '<button type="button" class="es-nav__link" id="es-nav-account-btn">👤 Log out</button>';
      document.getElementById('es-nav-account-btn').addEventListener('click', promptLogoutConfirm);

      if (drawerMount) {
        var name = (profile && profile.username) || user.email || 'Account';
        drawerMount.innerHTML =
          '<span class="nav-drawer-account-email" title="' + name + '">👤 ' + name + '</span>' +
          '<button type="button" class="es-nav__link" id="es-nav-drawer-logout-btn">Log out</button>';
        document.getElementById('es-nav-drawer-logout-btn').addEventListener('click', promptLogoutConfirm);
      }
      scheduleNavOverflowCheck();
    }

    // Shared by both the top-bar and drawer logout buttons — one accidental
    // tap shouldn't sign someone out with no way back.
    function promptLogoutConfirm() {
      closeDrawerIfOpen();
      var overlay = document.getElementById('es-nav-logout-confirm-overlay');
      if (!overlay) { window.EsAuth.signOut(); return; } // fallback if the markup's missing somehow
      overlay.classList.add('active');
    }

    var logoutOverlay = document.getElementById('es-nav-logout-confirm-overlay');
    if (logoutOverlay) {
      document.getElementById('es-nav-logout-cancel').addEventListener('click', function () {
        logoutOverlay.classList.remove('active');
      });
      document.getElementById('es-nav-logout-confirm').addEventListener('click', function () {
        overlay_signOutAndClose();
      });
      logoutOverlay.addEventListener('click', function (e) {
        if (e.target === logoutOverlay) logoutOverlay.classList.remove('active');
      });
    }
    function overlay_signOutAndClose() {
      window.EsAuth.signOut();
      if (logoutOverlay) logoutOverlay.classList.remove('active');
    }

    // Closing the drawer before opening the auth modal avoids having
    // both open at once on a small screen, which would stack two
    // full-screen-ish overlays on top of each other.
    function closeDrawerIfOpen() {
      var d = document.querySelector('.es-nav__drawer');
      var nav = document.querySelector('.es-nav');
      if (d) d.classList.remove('nav-drawer-open');
      if (nav) nav.classList.remove('nav-open');
    }

    window.EsAuth.onAuthChange(function (user, profile) {
      if (user) renderSignedIn(user, profile); else renderSignedOut();
    });

    signinForm.addEventListener('submit', function (e) {
      e.preventDefault();
      setFieldError('signin', '');
      var email = document.getElementById('es-nav-signin-email').value.trim();
      var password = document.getElementById('es-nav-signin-password').value;

      setLoading(signinForm, true, 'Log in');
      window.EsAuth.signIn(email, password)
        .then(function () { closeModal(); })
        .catch(function (err) {
          setFieldError('signin', err.message || 'Could not log in — check your email and password.');
        })
        .finally(function () { setLoading(signinForm, false, 'Log in'); });
    });

    signupForm.addEventListener('submit', function (e) {
      e.preventDefault();
      setFieldError('signup', '');
      var username = usernameInput.value.trim();
      var email = document.getElementById('es-nav-signup-email').value.trim();
      var password = document.getElementById('es-nav-signup-password').value;
      var confirm = document.getElementById('es-nav-signup-password-confirm').value;

      if (password !== confirm) {
        setFieldError('signup', "Passwords don't match.");
        return;
      }

      setLoading(signupForm, true, 'Create account');
      window.EsAuth.signUp(email, password, username)
        .then(function () {
          setFieldError('signup', 'Account created! You\'re logged in.', true);
          setTimeout(closeModal, 900);
        })
        .catch(function (err) {
          // isProfileError: the account itself was created fine, only the
          // username failed to save — worth saying so rather than
          // implying signup as a whole failed.
          setFieldError('signup', err.message || 'Could not create an account — try again.');
        })
        .finally(function () { setLoading(signupForm, false, 'Create account'); });
    });
  }

  waitForAuth(30); // ~3 seconds total before giving up

  /* ── Content-aware collapse ─────────────────────────────────────
     Instead of a fixed pixel breakpoint, actually measure whether the
     bar's content fits. Checked on load, on resize, and whenever the
     account button's content changes (login/logout changes its width,
     which can tip the balance either way). */
  var navOverflowCheckTimer = null;
  function checkNavOverflow() {
    var nav = document.querySelector('.es-nav');
    if (!nav) return;
    // Measure with everything shown first — checking while already
    // collapsed would always report "fits", since there'd be nothing
    // left to overflow.
    nav.classList.remove('es-nav--collapsed');
    var overflowing = nav.scrollWidth > nav.clientWidth + 1; // +1: rounding tolerance
    if (overflowing) nav.classList.add('es-nav--collapsed');
  }
  function scheduleNavOverflowCheck() {
    clearTimeout(navOverflowCheckTimer);
    navOverflowCheckTimer = setTimeout(checkNavOverflow, 50);
  }
  window.addEventListener('resize', scheduleNavOverflowCheck);
  window.addEventListener('load', scheduleNavOverflowCheck);
  scheduleNavOverflowCheck(); // initial check — covers the case where auth.js isn't on
                              // this page at all, so renderSignedIn/Out never fire

})();