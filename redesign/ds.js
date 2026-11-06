/* ════════════════════════════════════════════════════════════════
   CLOAK DS v3 runtime (PROTOTYPE). Shared by every redesign page.
   Theme + mode, reveals, segmented thumbs, menus, tooltips, toasts,
   the Effort slider. No scroll listeners: IntersectionObserver only.
   Prototype storage keys are separate from production
   (cloak_rd_mode / cloak_rd_accent) so the live app is never touched.
═════════════════════════════════════════════════════════════════ */
const DS = (() => {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const get = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const icon = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="icons.svg#${id}"/></svg>`;

  /* ── theme ─────────────────────────────────────────────────── */
  const sysDark = matchMedia('(prefers-color-scheme: dark)');
  const mode = () => get('cloak_rd_mode') || 'system';
  const accent = () => get('cloak_rd_accent') || 'rust';
  const isDark = () => root.dataset.mode === 'dark' || (!root.dataset.mode && sysDark.matches);
  function apply(m, a) {
    if (m === 'system') delete root.dataset.mode; else root.dataset.mode = m;
    root.dataset.accent = a;
    document.querySelectorAll('[data-set-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setMode === m)));
    document.querySelectorAll('[data-set-accent]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setAccent === a)));
    document.querySelectorAll('[data-mode-label]').forEach(el => { el.textContent = isDark() ? 'Dark' : 'Light'; });
    document.querySelectorAll('.seg.has-thumb').forEach(placeThumb);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim();
    document.dispatchEvent(new CustomEvent('ds:theme'));
  }
  // The new theme grows out of whatever asked for it, as a circle.
  function swap(fn, from) {
    if (!document.startViewTransition || reduce.matches) { fn(); return; }
    const r = from && from.getBoundingClientRect ? from.getBoundingClientRect() : null;
    const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top + r.height / 2 : innerHeight / 2;
    const far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.style.setProperty('--vt-x', x + 'px'); root.style.setProperty('--vt-y', y + 'px'); root.style.setProperty('--vt-r', far + 'px');
    root.classList.add('vt-theme');
    const t = document.startViewTransition(fn);
    t.finished.finally(() => root.classList.remove('vt-theme'));
  }
  function setMode(m, from) { set('cloak_rd_mode', m); swap(() => apply(m, accent()), from); }
  function setAccent(a, from) { set('cloak_rd_accent', a); swap(() => apply(mode(), a), from); }
  function toggleDark(from) { setMode(isDark() ? 'light' : 'dark', from); }
  sysDark.addEventListener('change', () => apply(mode(), accent()));

  /* ── segmented: a thumb that slides to the pressed button ───── */
  function placeThumb(seg) {
    const on = seg.querySelector('[aria-pressed="true"],[aria-selected="true"]');
    const th = seg.querySelector('.seg-thumb');
    if (!on || !th) return;
    th.style.setProperty('--x', on.offsetLeft + 'px');
    th.style.setProperty('--w', on.offsetWidth + 'px');
    th.style.left = '0';
  }
  function initSeg(seg) {
    if (seg.querySelector('.seg-thumb')) return;
    const th = document.createElement('span'); th.className = 'seg-thumb'; th.setAttribute('aria-hidden', 'true');
    seg.prepend(th); seg.classList.add('has-thumb');
    th.style.transition = 'none'; placeThumb(seg); th.offsetWidth; th.style.transition = '';
  }

  /* ── reveals ───────────────────────────────────────────────── */
  let io;
  function reveal(scope = document) {
    const els = scope.querySelectorAll('[data-reveal]:not(.is-in)');
    if (reduce.matches || !('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('is-in')); return; }
    io = io || new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: .12 });
    els.forEach(e => io.observe(e));
  }

  /* ── menus: one open at a time, Esc / outside click closes ─── */
  let openMenu = null;
  function closeMenus() { if (openMenu) { openMenu.menu.classList.remove('is-open'); openMenu.btn.setAttribute('aria-expanded', 'false'); openMenu = null; } }
  function toggleMenu(btn, menu) {
    const was = openMenu && openMenu.menu === menu;
    closeMenus();
    if (was) return;
    menu.classList.add('is-open'); btn.setAttribute('aria-expanded', 'true');
    openMenu = { btn, menu };
    const first = menu.querySelector('[role^="menuitem"],button,a');
    if (first && matchMedia('(hover:none)').matches === false) setTimeout(() => first.focus({ preventScroll: true }), 30);
  }
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-menu]');
    if (t) { e.stopPropagation(); toggleMenu(t, document.getElementById(t.dataset.menu)); return; }
    if (openMenu && !openMenu.menu.contains(e.target)) closeMenus();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && openMenu) { const b = openMenu.btn; closeMenus(); b.focus(); }
    if (openMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const items = [...openMenu.menu.querySelectorAll('[role^="menuitem"]')];
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });

  /* ── tooltips for [data-tip] (used on the collapsed rail) ──── */
  let tipEl;
  function showTip(el) {
    if (el.closest('[data-tips-off]')) return;
    tipEl = tipEl || Object.assign(document.createElement('div'), { className: 'tip', role: 'tooltip' });
    if (!tipEl.isConnected) document.body.append(tipEl);
    tipEl.textContent = el.dataset.tip;
    const r = el.getBoundingClientRect();
    tipEl.style.left = r.right + 10 + 'px'; tipEl.style.top = r.top + r.height / 2 - 14 + 'px';
    requestAnimationFrame(() => tipEl.classList.add('is-on'));
  }
  const hideTip = () => tipEl && tipEl.classList.remove('is-on');
  document.addEventListener('pointerover', e => { const t = e.target.closest('[data-tip]'); if (t) showTip(t); });
  document.addEventListener('pointerout', e => { if (e.target.closest('[data-tip]')) hideTip(); });
  document.addEventListener('focusin', e => { const t = e.target.closest('[data-tip]'); if (t && t.matches(':focus-visible')) showTip(t); });
  document.addEventListener('focusout', hideTip);

  /* ── toasts (transient confirmations only) ─────────────────── */
  function toast(msg, ic = 'check') {
    let host = document.querySelector('.toast-host');
    if (!host) { host = document.createElement('div'); host.className = 'toast-host'; host.setAttribute('role', 'status'); document.body.append(host); }
    const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = icon(ic) + `<span>${msg}</span>`;
    host.append(t);
    setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 260); }, 2200);
  }

  /* ── Effort slider (values mirror effort.js, so readouts are honest) ── */
  const LEVELS = [
    { v: 0, name: 'Minimal', desc: 'Fastest replies. Little deliberation.' },
    { v: 25, name: 'Low', desc: 'Quick and concise.' },
    { v: 50, name: 'Medium', desc: 'Balanced. Each model’s tuned default.' },
    { v: 75, name: 'High', desc: 'Thinks it through, checks its work.' },
    { v: 100, name: 'Max', desc: 'Full effort. Exhaustive reasoning and verification.' },
  ];
  const sources = v => v < 13 ? 3 : v < 38 ? 4 : v < 63 ? 5 : v < 88 ? 7 : 8;
  const rounds = v => v < 13 ? 0 : v < 38 ? 1 : v < 88 ? 2 : 3;
  function effort(el, { value = 50, onChange } = {}) {
    el.classList.add('effort');
    el.innerHTML = `<div class="effort-track"><div class="effort-fill"></div>${LEVELS.map(l => `<span class="effort-notch" style="left:${l.v}%"></span>`).join('')}</div><div class="effort-thumb" role="slider" tabindex="0" aria-label="Effort" aria-valuemin="0" aria-valuemax="100"></div>`;
    const thumb = el.querySelector('.effort-thumb'), notches = el.querySelectorAll('.effort-notch');
    let v = value;
    const idx = x => LEVELS.reduce((b, l, i) => Math.abs(l.v - x) < Math.abs(LEVELS[b].v - x) ? i : b, 0);
    function render(x, settle = true) {
      el.style.setProperty('--v', x);
      const L = LEVELS[idx(x)];
      notches.forEach((n, i) => n.classList.toggle('is-past', LEVELS[i].v <= x));
      thumb.setAttribute('aria-valuenow', String(settle ? L.v : Math.round(x)));
      thumb.setAttribute('aria-valuetext', L.name);
      if (settle && onChange) onChange({ ...L, sources: sources(L.v), rounds: rounds(L.v) });
    }
    function commit(x) { v = LEVELS[idx(x)].v; render(v); }
    const at = e => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(100, (e.clientX - r.left - 11) / (r.width - 22) * 100)); };
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId); el.classList.add('is-drag'); render(at(e), false);
      const mv = ev => render(at(ev), false);
      const up = ev => { el.classList.remove('is-drag'); commit(at(ev)); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    thumb.addEventListener('keydown', e => {
      const i = idx(v);
      const n = { ArrowRight: i + 1, ArrowUp: i + 1, ArrowLeft: i - 1, ArrowDown: i - 1, Home: 0, End: 4 }[e.key];
      if (n === undefined) return;
      e.preventDefault(); commit(LEVELS[Math.max(0, Math.min(4, n))].v);
    });
    render(v);
    return { get value() { return v; }, set: x => commit(x), level: () => ({ ...LEVELS[idx(v)], sources: sources(v), rounds: rounds(v) }) };
  }

  /* ── prototype badge: minimise it, remember per device ─────── */
  function proto() {
    const p = document.querySelector('.proto'); if (!p) return;
    const btn = p.querySelector('[data-proto-min]');
    const key = 'cloak_rd_proto_' + (p.classList.contains('is-app') ? 'app' : 'site');
    const saved = get(key);
    const min = saved ? saved === 'min' : (p.classList.contains('is-app') || matchMedia('(max-width: 640px)').matches);
    const paint = m => { p.classList.toggle('is-min', m); btn && btn.setAttribute('aria-expanded', String(!m)); };
    paint(min);
    btn && btn.addEventListener('click', () => { const m = !p.classList.contains('is-min'); paint(m); set(key, m ? 'min' : 'open'); });
  }

  function init() {
    root.classList.add('js');
    document.querySelectorAll('.seg').forEach(initSeg);
    apply(mode(), accent());
    document.addEventListener('click', e => {
      const m = e.target.closest('[data-set-mode]'); if (m) setMode(m.dataset.setMode, m);
      const a = e.target.closest('[data-set-accent]'); if (a) setAccent(a.dataset.setAccent, a);
      const d = e.target.closest('[data-toggle-dark]'); if (d) toggleDark(d);
    });
    addEventListener('resize', () => document.querySelectorAll('.seg.has-thumb').forEach(placeThumb), { passive: true });
    document.fonts && document.fonts.ready.then(() => document.querySelectorAll('.seg.has-thumb').forEach(placeThumb));
    reveal(); proto();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return { icon, toast, effort, reveal, initSeg, placeThumb, toggleDark, setMode, setAccent, isDark, closeMenus, reduce, LEVELS };
})();
