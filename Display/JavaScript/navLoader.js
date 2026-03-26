(function () {
  'use strict';

  const mount = document.getElementById('navbar-mount');
  if (!mount) return;

  // Adjust the path to navbar.html to suit your folder structure
  fetch('Display/HTML/NavBar.html')
    .then(function (r) {
      if (!r.ok) throw new Error('Navbar fetch failed: ' + r.status);
      return r.text();
    })
    .then(function (html) {
      mount.innerHTML = html;

      // Now run the navbar logic (dropdowns, drawer, active link)
      // Load navBar.js dynamically AFTER the HTML exists in the DOM
      const script = document.createElement('script');
      script.src = 'Display/JavaScript/navBar.js';
      document.body.appendChild(script);
    })
    .catch(function (err) {
      console.error('Could not load navbar:', err);
    });
})();
