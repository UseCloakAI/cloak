/* Cloak app version — written by scripts/bump-version.sh on EVERY commit
   (.githooks/pre-commit). Don't edit by hand except to bump `release`.
   Shown on the loading screen and in Settings ([data-cloak-version]). */
window.CLOAK_VERSION = { version: "1.0.205", release: 0, build: 205, date: "2026-10-01" };
(function () {
  function fill() {
    var v = window.CLOAK_VERSION;
    document.querySelectorAll('[data-cloak-version]').forEach(function (el) {
      el.textContent = (el.getAttribute('data-cloak-version') === 'long')
        ? 'Cloak v' + v.version + ' · ' + v.date
        : 'v' + v.version;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
})();
