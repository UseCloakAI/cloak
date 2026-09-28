/* ════════════════════════════════════════════════════════
   CLOAK MOTION — shared motion layer
   Used by index, landing, values, design-system and chat.

   Physics: the shadow is the floor. Things lift off it, get
   pressed flat into it and spring back up. Reveals rise out of
   the page, exits sink back in. Curves live in CSS tokens
   (--sp-snap / --sp-pop / --sp-soft, --ease-*) so JS and CSS
   move the same way.

   • Reveals   [data-rv] gets .in when it scrolls into view.
               Values: up (default) · rise · lines · uncloak · rule · fade
               data-rv-d="120" adds a base delay (ms). Elements that
               enter together are staggered 80ms in reading order.
               [data-stagger] numbers its children as --k (or
               --<value>) for per-child CSS delays.
               Pages opt in with the early <head> script that adds
               html.m-js (hidden-until-revealed only applies then).
   • Cursor    <body data-cursor> → crop-mark cursor that locks onto
               links and buttons. Fine pointers only.
   • Progress  [data-progress] on a sticky nav → accent scroll bar.
   • API       CloakMotion.swapTheme(fn, originEl?)  hard-edged wipe
               CloakMotion.roll(el, text)            slot-roll text swap
               CloakMotion.morph(el, change)         ease height across change()
               CloakMotion.leave(el, done)           play exit, then done()

   Everything no-ops under prefers-reduced-motion.
   ════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var d = document, html = d.documentElement;
  var mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduced() { return !!(mq && mq.matches); }
  function token(name, fallback) {
    var v = getComputedStyle(html).getPropertyValue(name).trim();
    return v || fallback;
  }

  // iOS Safari only applies :active to touch when a touch listener exists.
  d.addEventListener('touchstart', function () {}, { passive: true });

  // Last press position — origin for theme wipes started from a click.
  var lastPress = null;
  d.addEventListener('pointerdown', function (e) {
    lastPress = { x: e.clientX, y: e.clientY, t: Date.now() };
  }, { passive: true, capture: true });

  /* ── REVEALS ── */
  var STEP = 80;
  // [data-stagger] numbers its children (--k, or --<value>) for CSS delays.
  function initStagger() {
    d.querySelectorAll('[data-stagger]').forEach(function (p) {
      var prop = '--' + (p.getAttribute('data-stagger') || 'k');
      Array.prototype.forEach.call(p.children, function (c, i) { c.style.setProperty(prop, i); });
    });
  }
  function revealAll() {
    d.querySelectorAll('[data-rv]:not(.in)').forEach(function (el) { el.classList.add('in'); });
  }
  function initReveals() {
    if (!html.classList.contains('m-js')) return;        // safety net already gave up → content is visible
    if (reduced() || !('IntersectionObserver' in window)) { revealAll(); return; }
    var io = new IntersectionObserver(function (entries) {
      var hits = entries.filter(function (e) { return e.isIntersecting; }).map(function (e) { return e.target; });
      hits.sort(function (a, b) {
        var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.top - rb.top) || (ra.left - rb.left);
      });
      hits.forEach(function (el, i) {
        var base = parseInt(el.getAttribute('data-rv-d'), 10) || 0;
        el.style.setProperty('--rv-d', (base + i * STEP) + 'ms');
        el.classList.add('in');
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0 });
    d.querySelectorAll('[data-rv]').forEach(function (el) { io.observe(el); });
  }

  /* ── THEME WIPE ──
     View Transition: the new theme is revealed as a hard-edged rectangle
     growing out of whatever was pressed. No support / reduced motion → apply(). */
  function originRect(el) {
    if (el && el.getBoundingClientRect) return el.getBoundingClientRect();
    var a = d.activeElement;
    if (lastPress && Date.now() - lastPress.t < 1500) {
      return { left: lastPress.x, top: lastPress.y, right: lastPress.x, bottom: lastPress.y };
    }
    if (a && a !== d.body && a.getBoundingClientRect) return a.getBoundingClientRect();
    var cx = innerWidth / 2, cy = innerHeight / 2;
    return { left: cx, top: cy, right: cx, bottom: cy };
  }
  function swapTheme(apply, originEl) {
    if (reduced() || !d.startViewTransition || d.visibilityState !== 'visible') { apply(); return; }
    var r = originRect(originEl), w = innerWidth, h = innerHeight;
    function px(v) { return Math.max(0, Math.round(v)) + 'px'; }
    var s = html.style;
    s.setProperty('--vt-t', px(r.top)); s.setProperty('--vt-r', px(w - r.right));
    s.setProperty('--vt-b', px(h - r.bottom)); s.setProperty('--vt-l', px(r.left));
    html.classList.add('vt-theme');
    var vt;
    try { vt = d.startViewTransition(apply); }
    catch (_) { html.classList.remove('vt-theme'); apply(); return; }
    function noop() {}
    vt.ready.catch(noop);                                  // skipped transitions reject ready
    vt.finished.catch(noop).then(function () {
      html.classList.remove('vt-theme');
      ['--vt-t', '--vt-r', '--vt-b', '--vt-l'].forEach(function (p) { s.removeProperty(p); });
    });
  }

  /* ── ROLL ── old text slides up out of a slot, new text springs up in.
     The slot (an inner span, so the element's own borders, shadows and
     pseudo-elements are never clipped) eases its width between the two. */
  function roll(el, text) {
    if (!el) return;
    var from = el._rollTo != null ? el._rollTo : el.textContent;
    if (from === text) return;
    if (el._roll) el._roll();                              // finish any roll in flight
    if (reduced() || !el.animate || !el.isConnected || !el.offsetWidth) { el.textContent = text; return; }
    var slot = d.createElement('span'), out = d.createElement('span'), inn = d.createElement('span');
    slot.className = 'm-roll';
    out.textContent = from; inn.textContent = text;
    out.setAttribute('aria-hidden', 'true');
    el.textContent = '';
    el.appendChild(slot);
    slot.appendChild(out);
    var w0 = slot.getBoundingClientRect().width;
    slot.replaceChild(inn, out);
    var w1 = slot.getBoundingClientRect().width;
    slot.appendChild(out);
    el._rollTo = text;
    var snap = token('--sp-snap', 'cubic-bezier(.3,1.35,.55,1)');
    var anims = [
      slot.animate([{ width: w0 + 'px' }, { width: w1 + 'px' }], { duration: 380, easing: token('--ease-out', 'ease-out') }),
      out.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-105%)', opacity: 0 }], { duration: 200, easing: token('--ease-in', 'ease-in'), fill: 'forwards' }),
      inn.animate([{ transform: 'translateY(105%)' }, { transform: 'none' }], { duration: 420, delay: 60, easing: snap, fill: 'backwards' })
    ];
    var done = false;
    el._roll = function () {
      if (done) return; done = true;
      anims.forEach(function (a) { a.cancel(); });
      if (slot.parentNode === el) el.textContent = text;    // unless someone rewrote it mid-roll
      el._roll = null; el._rollTo = null;
    };
    anims[2].finished.then(el._roll, function () {});
  }

  /* ── MORPH ── run change(), then ease the element's height from what it
     was to what it is now (fields appearing/disappearing in a card). */
  function morph(el, change) {
    if (!el || reduced() || !el.animate || !el.offsetHeight) { change(); return; }
    if (el._morph) el._morph.cancel();
    var h0 = el.getBoundingClientRect().height;
    change();
    var h1 = el.getBoundingClientRect().height;
    if (Math.abs(h1 - h0) < 1) return;
    el.style.overflow = 'hidden';
    var a = el._morph = el.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 480, easing: token('--sp-soft', 'ease-out') });
    function done() { if (el._morph === a) { el._morph = null; el.style.overflow = ''; } }
    a.finished.then(done, done);
  }

  /* ── LEAVE ── plays the element's .is-leaving CSS exit, then done().
     Re-showing the element (removing .is-leaving) cancels the pending done(). */
  function leave(el, done) {
    done = done || function () {};
    if (!el) { done(); return; }
    if (el.classList.contains('is-leaving')) return;       // already on its way out
    if (reduced() || getComputedStyle(el).display === 'none') { done(); return; }
    el.classList.add('is-leaving');
    var fin = false;
    function end() {
      if (fin) return; fin = true;
      el.removeEventListener('animationend', onEnd);
      if (!el.classList.contains('is-leaving')) return;       // shown again meanwhile
      el.classList.remove('is-leaving');
      done();
    }
    function onEnd(e) { if (e.target === el) end(); }
    el.addEventListener('animationend', onEnd);
    setTimeout(end, 480);
  }

  /* ── CURSOR ── crop marks on a spring. Free: a small frame around the
     pointer. Over a link/button: the frame locks onto its box. Press:
     the frame squeezes in. */
  var CURSOR_CSS =
    'html.mc-on,html.mc-on *{cursor:none!important}' +
    'html.mc-on :is(input:not([type=checkbox]):not([type=radio]),textarea,[contenteditable]){cursor:text!important}' +
    '.mc{position:fixed;left:0;top:0;width:0;height:0;z-index:10000;pointer-events:none;opacity:0;transition:opacity .2s ease}' +
    '.mc.on{opacity:1}' +
    '.mc i{position:absolute;left:0;top:0;display:block;will-change:transform}' +
    '.mc-c{width:9px;height:9px;border:0 solid var(--ink)}' +
    '.mc-tl{border-top-width:2px;border-left-width:2px}.mc-tr{border-top-width:2px;border-right-width:2px}' +
    '.mc-bl{border-bottom-width:2px;border-left-width:2px}.mc-br{border-bottom-width:2px;border-right-width:2px}' +
    '.mc-dot{width:8px;height:8px;margin:-4px 0 0 -4px;background:var(--acc);border:1.5px solid var(--ink)}' +
    '.mc.locked .mc-c{border-color:var(--acc)}' +
    '.mc.text .mc-c,.mc.text .mc-dot{opacity:0}';
  var LOCK = 'a[href],button:not(:disabled),[role="button"],label[for],summary,select';
  var TEXT = 'input:not([type=checkbox]):not([type=radio]),textarea,[contenteditable]';

  function initCursor() {
    if (!d.body || !d.body.hasAttribute('data-cursor')) return;
    if (reduced() || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    var st = d.createElement('style'); st.textContent = CURSOR_CSS; d.head.appendChild(st);
    var root = d.createElement('div'); root.className = 'mc'; root.setAttribute('aria-hidden', 'true');
    root.innerHTML = '<i class="mc-c mc-tl"></i><i class="mc-c mc-tr"></i><i class="mc-c mc-bl"></i><i class="mc-c mc-br"></i><i class="mc-dot"></i>';
    d.body.appendChild(root);
    html.classList.add('mc-on');
    var c = root.children, B = 9;                          // bracket size

    var px = -100, py = -100, pressed = false, lock = null, shown = false;
    var S = { x: 0, y: 0, w: 0, h: 0 }, V = { x: 0, y: 0, w: 0, h: 0 }, T = { x: 0, y: 0, w: 0, h: 0 };
    var K = 560, D = 2 * Math.sqrt(K) * 0.68;              // spring stiffness / damping
    var raf = 0, last = 0;

    function target() {
      if (lock && lock.isConnected) {
        var r = lock.getBoundingClientRect(), pad = pressed ? 3 : 7;
        // A hint of pull toward the pointer so a locked frame still feels alive.
        var nx = Math.max(-4, Math.min(4, (px - (r.left + r.width / 2)) * 0.06));
        var ny = Math.max(-4, Math.min(4, (py - (r.top + r.height / 2)) * 0.06));
        T.x = r.left - pad + nx; T.y = r.top - pad + ny; T.w = r.width + pad * 2; T.h = r.height + pad * 2;
      } else {
        var s = pressed ? 16 : 26;
        T.x = px - s / 2; T.y = py - s / 2; T.w = s; T.h = s;
      }
    }
    function paint() {
      var x2 = S.x + S.w - B, y2 = S.y + S.h - B;
      c[0].style.transform = 'translate3d(' + S.x + 'px,' + S.y + 'px,0)';
      c[1].style.transform = 'translate3d(' + x2 + 'px,' + S.y + 'px,0)';
      c[2].style.transform = 'translate3d(' + S.x + 'px,' + y2 + 'px,0)';
      c[3].style.transform = 'translate3d(' + x2 + 'px,' + y2 + 'px,0)';
      c[4].style.transform = 'translate3d(' + px + 'px,' + py + 'px,0) scale(' + (pressed ? .6 : 1) + ')';
    }
    function frame(now) {
      raf = 0;
      var dt = Math.min(1 / 30, last ? (now - last) / 1000 : 1 / 60); last = now;
      target();
      var moving = false;
      for (var k in S) {
        var a = K * (T[k] - S[k]) - D * V[k];
        V[k] += a * dt; S[k] += V[k] * dt;
        if (Math.abs(T[k] - S[k]) > 0.02 || Math.abs(V[k]) > 0.02) moving = true;
      }
      paint();
      if (moving) raf = requestAnimationFrame(frame); else last = 0;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }

    function hide() { shown = false; root.classList.remove('on'); }
    d.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') { hide(); return; }
      px = e.clientX; py = e.clientY;
      if (!shown) {                                        // (re)appear in place, don't fly in
        shown = true; target();
        for (var k in S) { S[k] = T[k]; V[k] = 0; }
        root.classList.add('on');
      }
      kick();
    }, { passive: true });
    d.addEventListener('pointerover', function (e) {
      var el = e.target instanceof Element ? e.target : null;
      root.classList.toggle('text', !!(el && el.closest(TEXT)));
      var l = el && el.closest(LOCK);
      if (l !== lock) { lock = l; root.classList.toggle('locked', !!l); kick(); }
    }, { passive: true });
    d.addEventListener('pointerdown', function (e) { if (e.pointerType === 'mouse') { pressed = true; kick(); } }, { passive: true });
    d.addEventListener('pointerup', function () { pressed = false; kick(); }, { passive: true });
    d.addEventListener('pointerout', function (e) { if (!e.relatedTarget) hide(); }, { passive: true });
    addEventListener('scroll', function () {
      // Content moved under a still pointer: re-check what's beneath it.
      var el = d.elementFromPoint(px, py), l = el && el.closest(LOCK);
      if (l !== lock) { lock = l; root.classList.toggle('locked', !!l); }
      kick();
    }, { passive: true });
    addEventListener('blur', function () { pressed = false; });
  }

  /* ── SCROLL PROGRESS ── */
  function initProgress() {
    var host = d.querySelector('[data-progress]');
    if (!host) return;
    var bar = d.createElement('i');
    bar.setAttribute('aria-hidden', 'true');
    bar.style.cssText = 'position:absolute;left:0;right:0;bottom:-2px;height:2px;background:var(--acc);transform-origin:0 50%;transform:scaleX(0);pointer-events:none;will-change:transform';
    host.appendChild(bar);
    var raf = 0;
    function update() {
      raf = 0;
      var max = d.documentElement.scrollHeight - innerHeight;
      bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0) + ')';
    }
    function q() { if (!raf) raf = requestAnimationFrame(update); }
    addEventListener('scroll', q, { passive: true });
    addEventListener('resize', q, { passive: true });
    update();
  }

  window.CloakMotion = { swapTheme: swapTheme, roll: roll, morph: morph, leave: leave, reduced: reduced };

  function boot() { initStagger(); initReveals(); initCursor(); initProgress(); }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
