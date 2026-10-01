/* ════════════════════════════════════════════════════════
   CLOAK EFFORT — how hard Cloak works on a request.
   A 0–100 slider (magnetic detents at Minimal / Low / Medium / High / Max)
   in the topbar. The value goes to the API as `effort` on every chat call
   (api-worker/src/effort.js turns it into reasoning level, token budget,
   patience and prompt), and also sets client-side research depth:
   sources read per search and how many verification rounds are allowed.
   Persisted per device in localStorage.cloak_effort.
   ════════════════════════════════════════════════════════ */
const CloakEffort = (() => {
  const KEY = 'cloak_effort';
  const LEVELS = [
    { v: 0,   name: 'Minimal', desc: 'Fastest replies. Little deliberation.' },
    { v: 25,  name: 'Low',     desc: 'Quick and concise.' },
    { v: 50,  name: 'Medium',  desc: 'Balanced — each model’s tuned default.' },
    { v: 75,  name: 'High',    desc: 'Thinks it through, checks its work.' },
    { v: 100, name: 'Max',     desc: 'Full effort. Exhaustive reasoning and verification.' },
  ];
  const SNAP = 4; // magnetic pull toward a detent, in slider units

  let value = 50;
  try { const s = Number(localStorage.getItem(KEY)); if (Number.isFinite(s) && localStorage.getItem(KEY) !== null) value = clamp(s); } catch (_) {}

  function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }
  function level(v = value) {
    return v < 13 ? LEVELS[0] : v < 38 ? LEVELS[1] : v < 63 ? LEVELS[2] : v < 88 ? LEVELS[3] : LEVELS[4];
  }
  // Multipliers mirror the worker (1 at 50) so the readout is honest.
  const curve = (v, lo, hi) => v <= 50 ? lo + (1 - lo) * v / 50 : 1 + (hi - 1) * (v - 50) / 50;

  // Research depth on the client.
  function maxSources(v = value) { return v < 13 ? 3 : v < 38 ? 4 : v < 63 ? 5 : v < 88 ? 7 : 8; }
  function verifyRounds(v = value) { return v < 13 ? 0 : v < 38 ? 1 : v < 88 ? 2 : 3; }

  const listeners = new Set();
  function set(v, { persist = true } = {}) {
    const n = clamp(v);
    if (n === value && persist) { save(); return; }
    value = n;
    if (persist) save();
    listeners.forEach(fn => { try { fn(value); } catch (_) {} });
  }
  function save() { try { localStorage.setItem(KEY, String(value)); } catch (_) {} }

  /* ── UI ── */
  let btn, pop, track, fill, thumb, readout, nameEl, descEl, statsEl;

  function bars(v) {
    const lit = v < 13 ? 1 : v < 38 ? 2 : v < 63 ? 3 : v < 88 ? 4 : 5;
    return [0, 1, 2, 3, 4].map(i =>
      `<rect x="${i * 4}" y="${12 - (i + 1) * 2.4}" width="3" height="${(i + 1) * 2.4}" class="${i < lit ? 'on' : ''}"/>`).join('');
  }

  function render() {
    if (!btn) return;
    const L = level();
    btn.querySelector('.eff-bars').innerHTML = bars(value);
    btn.querySelector('.eff-btn-label').textContent = L.name;
    btn.setAttribute('aria-label', `Effort: ${L.name} (${value})`);
    btn.dataset.level = L.name.toLowerCase();
    if (!pop) return;
    fill.style.width = value + '%';
    thumb.style.left = value + '%';
    thumb.setAttribute('aria-valuenow', value);
    thumb.setAttribute('aria-valuetext', `${L.name}, ${value} of 100`);
    readout.textContent = value;
    if (nameEl.textContent !== L.name) {
      nameEl.textContent = L.name;
      nameEl.classList.remove('eff-bump'); void nameEl.offsetWidth; nameEl.classList.add('eff-bump');
    }
    descEl.textContent = L.desc;
    pop.querySelectorAll('.eff-tick').forEach(t => t.classList.toggle('on', Number(t.dataset.v) <= value));
    pop.querySelectorAll('.eff-stop').forEach(t => t.classList.toggle('on', t.dataset.name === L.name));
    const think = curve(value, 0.5, 3), budget = curve(value, 0.6, 1.6), patience = curve(value, 1, 2.5);
    statsEl.innerHTML =
      stat('Reasoning', `${think.toFixed(1)}×`, think / 3) +
      stat('Answer length', `${budget.toFixed(1)}×`, budget / 1.6) +
      stat('Patience', `${patience.toFixed(1)}×`, patience / 2.5) +
      stat('Sources / search', String(maxSources()), maxSources() / 8) +
      stat('Verify rounds', String(verifyRounds()), verifyRounds() / 3);
  }
  function stat(label, val, frac) {
    return `<div class="eff-stat"><span class="eff-stat-k">${label}</span><span class="eff-stat-bar"><i style="width:${Math.round(Math.max(.04, Math.min(1, frac)) * 100)}%"></i></span><span class="eff-stat-v">${val}</span></div>`;
  }

  function build() {
    pop = document.createElement('div');
    pop.className = 'eff-pop';
    pop.id = 'effort-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Effort');
    pop.innerHTML = `
      <div class="eff-head">
        <div><div class="eff-kicker">Effort</div><div class="eff-name"></div></div>
        <div class="eff-readout" aria-hidden="true"></div>
      </div>
      <div class="eff-desc"></div>
      <div class="eff-slider">
        <div class="eff-track">
          <div class="eff-fill"></div>
          ${Array.from({ length: 21 }, (_, i) => `<span class="eff-tick${i % 5 === 0 ? ' major' : ''}" data-v="${i * 5}" style="left:${i * 5}%"></span>`).join('')}
          <div class="eff-thumb" role="slider" tabindex="0" aria-label="Effort" aria-valuemin="0" aria-valuemax="100"></div>
        </div>
        <div class="eff-stops">
          ${LEVELS.map(l => `<button type="button" class="eff-stop" data-v="${l.v}" data-name="${l.name}" style="left:${l.v}%">${l.name}</button>`).join('')}
        </div>
      </div>
      <div class="eff-stats"></div>`;
    btn.parentNode.appendChild(pop);
    track = pop.querySelector('.eff-track');
    fill = pop.querySelector('.eff-fill');
    thumb = pop.querySelector('.eff-thumb');
    readout = pop.querySelector('.eff-readout');
    nameEl = pop.querySelector('.eff-name');
    descEl = pop.querySelector('.eff-desc');
    statsEl = pop.querySelector('.eff-stats');

    // Drag anywhere on the track. Magnetic detents; Shift = free (no snap).
    let dragging = false, lastDetent = null;
    const fromEvent = (e, free) => {
      const r = track.getBoundingClientRect();
      let v = ((e.clientX - r.left) / r.width) * 100;
      if (!free) {
        const near = LEVELS.find(l => Math.abs(l.v - v) <= SNAP);
        if (near) v = near.v;
      }
      return clamp(v);
    };
    const haptic = (v) => {
      const d = LEVELS.find(l => l.v === v);
      if (d && d.v !== lastDetent) { lastDetent = d.v; if (typeof hapticTap === 'function') hapticTap(); }
      if (!d) lastDetent = null;
    };
    track.addEventListener('pointerdown', (e) => {
      dragging = true; track.setPointerCapture(e.pointerId); pop.classList.add('dragging');
      const v = fromEvent(e, e.shiftKey); haptic(v); set(v, { persist: false });
      thumb.focus({ preventScroll: true });
    });
    track.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const v = fromEvent(e, e.shiftKey); haptic(v); set(v, { persist: false });
    });
    const end = () => { if (!dragging) return; dragging = false; pop.classList.remove('dragging'); set(value); };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);

    thumb.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      let v = value;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= step;
      else if (e.key === 'PageUp') v = (LEVELS.find(l => l.v > value) || LEVELS[4]).v;
      else if (e.key === 'PageDown') v = ([...LEVELS].reverse().find(l => l.v < value) || LEVELS[0]).v;
      else if (e.key === 'Home') v = 0;
      else if (e.key === 'End') v = 100;
      else if (e.key === 'Escape') { close(); btn.focus(); return; }
      else return;
      e.preventDefault(); set(v);
    });
    pop.querySelectorAll('.eff-stop').forEach(b => b.addEventListener('click', () => { set(Number(b.dataset.v)); thumb.focus(); }));
  }

  function open() {
    if (!pop) build();
    pop.classList.add('open'); btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    render();
    requestAnimationFrame(() => thumb.focus({ preventScroll: true }));
  }
  function close() {
    if (!pop) return;
    pop.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
  }

  function mount() {
    const host = document.getElementById('effort-picker');
    if (!host || btn) return;
    host.innerHTML = `<button type="button" class="eff-btn" id="effort-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="effort-pop" title="Effort — how hard Cloak works">
      <svg class="eff-bars" width="20" height="12" viewBox="0 0 20 12" aria-hidden="true"></svg>
      <span class="eff-btn-label"></span></button>`;
    btn = host.querySelector('#effort-btn');
    btn.addEventListener('click', (e) => { e.stopPropagation(); pop && pop.classList.contains('open') ? close() : open(); });
    document.addEventListener('pointerdown', (e) => { if (pop && pop.classList.contains('open') && !host.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    listeners.add(render);
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  return {
    value: () => value,
    set: (v) => set(v),
    level: () => level().name.toLowerCase(),
    maxSources: () => maxSources(),
    verifyRounds: () => verifyRounds(),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    open, close,
  };
})();
window.CloakEffort = CloakEffort;
