(function () {
  'use strict';

  const mount = document.getElementById('navbar-mount');
  if (!mount) return;

  const src = mount.dataset.src || 'NavBar.html';

  fetch(src)
    .then(function (r) {
      if (!r.ok) throw new Error('Navbar fetch failed: ' + r.status);
      return r.text();
    })
    .then(function (html) {
      mount.innerHTML = html;

      // Load navBar.js relative to this script's own location
      const script = document.createElement('script');
      script.src = new URL('../JavaScript/navBar.js', document.currentScript
        ? document.currentScript.src
        : location.href).href;
      document.body.appendChild(script);
    })
    .catch(function (err) {
      console.error('Could not load navbar:', err);
    });
})();
