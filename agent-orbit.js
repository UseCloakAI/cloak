/* ════════════════════════════════════════════════════════
   CLOAK AGENT ORBIT — the design-system "agents working" motion.
   Starting: one orb, heartbeat squish.
   Looping: the orbs act out the work (orbit, research, ping-pong,
   spiral, moon, team, corners).
   Completed: they spiral home, merge, squish and settle.

   Usage:
     const orbit = CloakAgentOrbit.mount(el, { size: 40, state: 'starting', motion: 'orbit' });
     orbit.setMotion('research');   // orbit | research | pong | spiral | moon | team | snap
     orbit.setState('looping');     // starting | looping | completed
     orbit.destroy();

   Colours are --acc (fill) and --ink (outline). Reduced motion jumps
   to the pose and does not spin.
   ════════════════════════════════════════════════════════ */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const STATES = { starting: 0, looping: 1, completed: 2 };
  const TAU = Math.PI * 2, R = 11, RM = 15, D = 22;
  let uid = 0;

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const io = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  const mirror = ([x, y, r]) => [[x, y, r], [-x, -y, r]];
  const iob = (x, k = 1.7) => {
    const c = k * 1.525;
    return x < .5
      ? (Math.pow(2 * x, 2) * ((c + 1) * 2 * x - c)) / 2
      : (Math.pow(2 * x - 2, 2) * ((c + 1) * (2 * x - 2) + c) + 2) / 2;
  };
  const warp = (p, k) => p + k * Math.sin(TAU * p) / TAU;
  const sgnp = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

  // Same acts as the design-system stage. Planning is the default orbit.
  const MOTIONS = {
    orbit: { P: 1.6, f: t => { const p = t / 1.6, a = TAU * p + .9 * Math.sin(TAU * p) + .25 * Math.sin(TAU * p / 3.1), rho = D * (1 + .3 * Math.cos(a - .6)); return mirror([Math.cos(a) * rho, Math.sin(a) * rho, R * (1 + .05 * Math.cos(a))]); } },
    pong: { P: 1.5, f: t => { const q = t / 1.5, h = Math.floor(q * 2), u = q * 2 - h, e = iob(u), X = D * 1.2, x = lerp(h % 2 ? X : -X, h % 2 ? -X : X, e), ax = .5 * t + .5 * Math.sin(TAU * q / 2), [px, py] = rot(x, 0, ax); return mirror([px, py, R * (1 + .1 * Math.sin(Math.PI * u))]); } },
    spiral: { P: 3.8, f: t => { const p = t / 3.8, s = TAU * warp(p, .55), rho = D * (.25 + .9 * Math.pow(.5 + .5 * Math.cos(s), 1.6)), a = 3.2 * s - 1.6 * Math.sin(s) + .6 * Math.sin(2 * s); return mirror([Math.cos(a) * rho, Math.sin(a) * rho, R * (1 + .12 * Math.sin(s))]); } },
    moon: { P: 2.6, f: t => { const p = t / 2.6, m = TAU * p + 1.15 * Math.sin(TAU * p), rho = 22 + 11 * Math.pow(.5 + .5 * Math.cos(m - .8), 1.4), ax = Math.cos(-m) * 5, ay = Math.sin(-m) * 5; return [[ax, ay, 14 + .8 * Math.sin(m)], [ax + Math.cos(2 * m) * rho, ay + Math.sin(2 * m) * rho, 6.5]]; } },
    research: { P: 4.8, f: t => { const p = t / 1.2, u = p % 1, out = Math.pow(Math.sin(Math.PI * Math.pow(u, .7)), 1.6), A = 2.4 * (p + Math.sin(TAU * p) / TAU) - .5, dd = 34 * out, sx = Math.cos(A) * dd, sy = Math.sin(A) * dd; return [[-sx * .14, -sy * .14, 13.5], [sx, sy, 8 + 1.2 * (1 - out)]]; } },
    team: { agents: 5, P: 4.2, f: t => { const p = t / 4.2, s = TAU * p, hp = Math.max(0, Math.sin(s)), h = Math.pow(hp, 3) * (1 + .18 * Math.sin(s * 4)), rho = D * 1.25 * (1 - .82 * Math.min(1, h)), spin = 2.2 * warp(p, .7) * TAU / 2.2 * .9 + 1.4 * h; return Array.from({ length: 5 }, (_, i) => { const a = spin + i * TAU / 5 + .35 * Math.sin(s * 2 + i * 1.3) * (1 - h), rr = rho + 3.2 * Math.sin(t * 3.4 - i * 1.26) * (1 - h); return [Math.cos(a) * rr, Math.sin(a) * rr, R * .78 + 2 * h]; }); } },
    snap: { P: 3, f: t => { const h = .75, sq = th => [sgnp(Math.cos(th), .8) * 20, sgnp(Math.sin(th), .8) * 20], pos = tt => { const i = Math.floor(tt / h), u = (tt / h) - i, e = iob(Math.min(1, u / .82), .7); return sq(-3 * Math.PI / 4 + (i + e) * Math.PI / 2); }; const A = pos(t), B = pos(t - .16 + h * 4 * 8); return [[A[0], A[1], R * .9], [-B[0], -B[1], R * .9]]; } },
  };

  function mk(tag, parent, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent.appendChild(e);
    return e;
  }

  function mount(el, opts) {
    opts = opts || {};
    const size = opts.size || 40;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fid = 'cloak-orbit-goo-' + (++uid);
    const svg = mk('svg', el, { width: size, height: size, viewBox: '-70 -70 140 140', 'aria-hidden': 'true' });
    const filter = mk('filter', mk('defs', svg, {}), { id: fid, filterUnits: 'userSpaceOnUse', x: -80, y: -80, width: 160, height: 160 });
    mk('feGaussianBlur', filter, { stdDeviation: 3.2 });
    mk('feColorMatrix', filter, { values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10' });
    const T = mk('g', svg, {});
    const NMAX = 5;
    const layers = [['var(--ink)', 2.8], ['var(--acc)', 0]].map(([fill, pad]) => {
      const g = mk('g', T, { filter: 'url(#' + fid + ')', style: 'fill:' + fill });
      return [Array.from({ length: NMAX }, () => mk('circle', g, {})), pad];
    });

    let mode = STATES[opts.state] ?? 0;
    let motion = MOTIONS[opts.motion] ? opts.motion : 'orbit';
    let prev = motion, mt = 0, pmt = 0, bl = 1;
    let sp = mode === 1 ? 1 : 0, spv = 0, w = 0, wv = 0, pulseT = 0, merged = mode !== 1;
    let last = performance.now(), raf = 0, alive = true;

    function poseAt(id, t) {
      const m = MOTIONS[id] || MOTIONS.orbit;
      return m.f(t);
    }
    function blend(dt) {
      mt += dt; pmt += dt;
      if (bl < 1) bl = Math.min(1, bl + dt / .75);
      const cur = poseAt(motion, mt);
      if (bl >= 1) return cur;
      const pv = poseAt(prev, pmt), e = io(bl), n = Math.max(cur.length, pv.length);
      const out = [];
      for (let k = 0; k < n; k++) {
        const a = pv[k] || pv[0], b = cur[k] || cur[0];
        out.push([lerp(a[0], b[0], e), lerp(a[1], b[1], e), lerp(a[2], b[2], e)]);
      }
      return out;
    }
    function render(dt) {
      const pose = blend(dt || 0);
      const tgt = mode === 1 ? 1 : 0;
      if (reduce) sp = tgt;
      else { spv += ((tgt - sp) * (mode === 1 ? 55 : 70) - spv * (mode === 1 ? 9 : 13)) * (dt || 0); sp += spv * (dt || 0); }
      const s = clamp(sp, -.15, 1.2);
      const tw = mode === 2 ? (1 - clamp(sp, 0, 1)) * 2.2 : 0;
      const P = pose.map(([x, y, r]) => { const [rx, ry] = rot(x * s, y * s, tw); return [rx, ry, lerp(RM, r, clamp(s, 0, 1))]; });
      if (sp < .04 && !merged && mode !== 1) { merged = true; wv -= 4.8; }
      if (sp > .2) merged = false;
      if (mode === 0 && (pulseT += dt || 0) > 1.05) { pulseT = 0; wv -= 2.4; }
      wv += (-190 * w - 11 * wv) * (dt || 0); w += wv * (dt || 0);
      T.setAttribute('transform', 'scale(' + (1 + w * .85) + ',' + (1 - w * .85) + ')');
      layers.forEach(([els, pad]) => els.forEach((node, k) => {
        if (k >= P.length) { node.setAttribute('r', '0'); return; }
        const [x, y, r] = P[k];
        node.setAttribute('cx', x.toFixed(2));
        node.setAttribute('cy', y.toFixed(2));
        node.setAttribute('r', (r + pad).toFixed(2));
      }));
    }
    function frame(now) {
      if (!alive) return;
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      render(dt);
      raf = requestAnimationFrame(frame);
    }
    function setMotion(id) {
      if (!MOTIONS[id] || id === motion) return;
      prev = motion; pmt = mt; motion = id; mt = 0; bl = reduce ? 1 : 0;
    }
    function setState(s) {
      if (!alive) return;
      const m = typeof s === 'number' ? s : STATES[s];
      if (m === undefined || m === mode) return;
      if (m === 1) wv += 3.4;
      mode = m;
      if (reduce) render(0);
    }

    render(0);
    if (!reduce) raf = requestAnimationFrame(frame);
    if (mode === 0) setTimeout(() => { if (alive && mode === 0) setState('looping'); }, 700);

    return {
      el: svg,
      setState,
      setMotion,
      get state() { return Object.keys(STATES)[mode]; },
      destroy() { alive = false; cancelAnimationFrame(raf); svg.remove(); }
    };
  }

  window.CloakAgentOrbit = { mount, motions: Object.keys(MOTIONS) };
})();
