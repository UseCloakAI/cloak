#!/bin/sh
# Bumps the app version in version.js (and its ?v= cache tag in chat.html /
# sw.js) so every commit ships a new, visible version number.
# Run automatically by .githooks/pre-commit; safe to run by hand.
#   version = 1.<release>.<build>   build = commit number this commit will be
set -e
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
RELEASE=$(sed -n 's/.*release: *\([0-9]*\).*/\1/p' version.js 2>/dev/null | head -1)
[ -n "$RELEASE" ] || RELEASE=0
COUNT=$(( $(git rev-list --count HEAD 2>/dev/null || echo 0) + 1 ))
# A shallow clone undercounts history; never let the build go backwards.
PREV=$(sed -n 's/.*build: *\([0-9]*\).*/\1/p' version.js 2>/dev/null | head -1)
[ -n "$PREV" ] || PREV=0
[ "$COUNT" -gt "$PREV" ] || COUNT=$((PREV + 1))
DATE=$(date -u +%Y-%m-%d)
VERSION="1.$RELEASE.$COUNT"
cat > version.js <<JS
/* Cloak app version — written by scripts/bump-version.sh on EVERY commit
   (.githooks/pre-commit). Don't edit by hand except to bump \`release\`.
   Shown on the loading screen and in Settings ([data-cloak-version]). */
window.CLOAK_VERSION = { version: "$VERSION", release: $RELEASE, build: $COUNT, date: "$DATE" };
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
JS
# Cache-bust version.js itself so the new number is never served stale.
sed -i "s#version\.js?v=[A-Za-z0-9.]*#version.js?v=$VERSION#g" chat.html sw.js 2>/dev/null || true
git add version.js chat.html sw.js
echo "Cloak version -> v$VERSION"
