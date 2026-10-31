/* ════════════════════════════════════════════════════════
   CLOAK AGENT ORBIT — "agents working" indicator
   The design-system motions: orbit, ping-pong, spiral, moon,
   research, team, and corners (the building motion).
   Starting: one orb with a heartbeat squish.
   Looping:  the chosen motion.
   Completed: they merge, squish and settle into one orb.

   Usage:
     <script src="agent-orbit.js"></script>
     const orbit = CloakAgentOrbit.mount(el, { size: 112, state: 'looping', motion: 'snap' });
     orbit.setState('looping');   // 'starting' | 'looping' | 'completed'
     orbit.setMotion('snap');     // orbit | pong | spiral | moon | research | team | snap
     orbit.destroy();

   Colours come from --acc (fill) and --ink (outline), so it follows
   the active theme. Respects prefers-reduced-motion (holds a pose).
   ════════════════════════════════════════════════════════ */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const STATES = { starting: 0, looping: 1, completed: 2 };
  const TAU = Math.PI * 2, R = 11, RM = 15, D = 22, BLEND = .75, NMAX = 5;
  let uid = 0;

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const io = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const iob = (x, k = 1.7) => {
    const c = k * 1.525;
    return x < .5
      ? (Math.pow(2 * x, 2) * ((c + 1) * 2 * x - c)) / 2
      : (Math.pow(2 * x - 2, 2) * ((c + 1) * (2 * x - 2) + c) + 2) / 2;
  };
  const warp = (p, k) => p + k * Math.sin(TAU * p) / TAU;
  const sgnp = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
  const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  const mirror = ([x, y, r]) => [[x, y, r], [-x, -y, r]];

  const MOTIONS = [
    { id: 'orbit', P: 1.6, f: t => {
      const p = t / 1.6, a = TAU * p + .9 * Math.sin(TAU * p) + .25 * Math.sin(TAU * p / 3.1);
      const rho = D * (1 + .3 * Math.cos(a - .6));
      return mirror([Math.cos(a) * rho, Math.sin(a) * rho, R * (1 + .05 * Math.cos(a))]);
    }},
    { id: 'pong', P: 1.5, f: t => {
      const q = t / 1.5, h = Math.floor(q * 2), u = q * 2 - h, e = iob(u), X = D * 1.2;
      const x = lerp(h % 2 ? X : -X, h % 2 ? -X : X, e);
      const ax = .5 * t + .5 * Math.sin(TAU * q / 2);
      const [px, py] = rot(x, 0, ax);
      return mirror([px, py, R * (1 + .1 * Math.sin(Math.PI * u))]);
    }},
    { id: 'spiral', P: 3.8, f: t => {
      const p = t / 3.8, s = TAU * warp(p, .55), rho = D * (.25 + .9 * Math.pow(.5 + .5 * Math.cos(s), 1.6));
      const a = 3.2 * s - 1.6 * Math.sin(s) + .6 * Math.sin(2 * s);
      return mirror([Math.cos(a) * rho, Math.sin(a) * rho, R * (1 + .12 * Math.sin(s))]);
    }},
    { id: 'moon', P: 2.6, f: t => {
      const p = t / 2.6, m = TAU * p + 1.15 * Math.sin(TAU * p), rho = 22 + 11 * Math.pow(.5 + .5 * Math.cos(m - .8), 1.4);
      const ax = Math.cos(-m) * 5, ay = Math.sin(-m) * 5;
      return [[ax, ay, 14 + .8 * Math.sin(m)], [ax + Math.cos(2 * m) * rho, ay + Math.sin(2 * m) * rho, 6.5]];
    }},
    { id: 'research', P: 4.8, f: t => {
      const p = t / 1.2, u = p % 1, out = Math.pow(Math.sin(Math.PI * Math.pow(u, .7)), 1.6);
      const A = 2.4 * (p + Math.sin(TAU * p) / TAU) - .5, dd = 34 * out;
      const sx = Math.cos(A) * dd, sy = Math.sin(A) * dd;
      return [[-sx * .14, -sy * .14, 13.5], [sx, sy, 8 + 1.2 * (1 - out)]];
    }},
    { id: 'team', agents: 5, P: 4.2, f: t => {
      const p = t / 4.2, s = TAU * p, hp = Math.max(0, Math.sin(s)), h = Math.pow(hp, 3) * (1 + .18 * Math.sin(s * 4));
      const rho = D * 1.25 * (1 - .82 * Math.min(1, h)), spin = 2.2 * warp(p, .7) * TAU / 2.2 * .9 + 1.4 * h;
      return Array.from({ length: 5 }, (_, i) => {
        const a = spin + i * TAU / 5 + .35 * Math.sin(s * 2 + i * 1.3) * (1 - h);
        const rr = rho + 3.2 * Math.sin(t * 3.4 - i * 1.26) * (1 - h);
        return [Math.cos(a) * rr, Math.sin(a) * rr, R * .78 + 2 * h];
      });
    }},
    // Building: two agents walk the corners of the work, one a beat behind.
    { id: 'snap', P: 3, f: t => {
      const h = .75, sq = th => [sgnp(Math.cos(th), .8) * 20, sgnp(Math.sin(th), .8) * 20];
      const pos = tt => {
        const i = Math.floor(tt / h), u = (tt / h) - i, e = iob(Math.min(1, u / .82), .7);
        return sq(-3 * Math.PI / 4 + (i + e) * Math.PI / 2);
      };
      const A = pos(t), B = pos(t - .16 + h * 4 * 8);
      return [[A[0], A[1], R * .9], [-B[0], -B[1], R * .9]];
    }},
  ];

  function mk(tag, parent, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent.appendChild(e);
    return e;
  }

  function mount(el, opts) {
    opts = opts || {};
    const size = opts.size || 112;
    // spread < 1 pulls the agents in so they overlap and goo together,
    // keeping the whole motion inside a small footprint.
    const spread = opts.spread || 1;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fid = 'cloak-orbit-goo-' + (++uid);

    const svg = mk('svg', el, {
      width: size, height: size, viewBox: '-70 -70 140 140',
      'aria-hidden': 'true', style: 'overflow:visible;display:block',
    });
    const filter = mk('filter', mk('defs', svg, {}), {
      id: fid, filterUnits: 'userSpaceOnUse', x: -80, y: -80, width: 160, height: 160,
    });
    mk('feGaussianBlur', filter, { stdDeviation: 3.2 });
    mk('feColorMatrix', filter, { values: '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 22 -10' });

    const T = mk('g', svg, {});
    const layers = [['var(--ink)', 2.8], ['var(--acc)', 0]].map(([fill, pad]) => {
      const g = mk('g', T, { filter: 'url(#' + fid + ')', style: 'fill:' + fill });
      return [Array.from({ length: NMAX }, () => mk('circle', g, {})), pad];
    });

    let mode = STATES[opts.state] != null ? STATES[opts.state] : 1;
    let mi = Math.max(0, MOTIONS.findIndex(m => m.id === (opts.motion || 'orbit')));
    let prevMi = mi, mt = .4, pmt = .4, bl = 1, runT = 0;
    let sp = mode === 1 ? 1 : 0, spv = 0, w = 0, wv = 0, pulseT = 0, merged = mode !== 1;
    let last = performance.now(), raf = 0, alive = true;

    const fill = a => { while (a.length < NMAX) a.push(a[0].slice()); return a; };

    function poses(dt) {
      mt += dt; pmt += dt; runT += dt;
      if (bl < 1) bl = Math.min(1, bl + dt / BLEND);
      const cur = fill(MOTIONS[mi].f(mt));
      if (bl >= 1) return cur;
      const pv = fill(MOTIONS[prevMi].f(pmt)), e = io(bl);
      return cur.map((c, k) => c.map((v, j) => lerp(pv[k][j], v, e)));
    }

    function render(now) {
      const dt = reduce ? 0 : Math.min(.05, (now - last) / 1000);
      last = now;
      const pose = poses(dt);
      const tgt = mode === 1 ? 1 : 0;
      if (reduce) sp = tgt;
      else {
        spv += ((tgt - sp) * (mode === 1 ? 55 : 70) - spv * (mode === 1 ? 9 : 13)) * dt;
        sp += spv * dt;
      }
      const s = clamp(sp, -.15, 1.2);
      const tw = mode === 2 ? (1 - clamp(sp, 0, 1)) * 2.2 : 0;
      const P = pose.map(([x, y, r]) => {
        const [rx, ry] = rot(x * s * spread, y * s * spread, tw);
        return [rx, ry, lerp(RM, r, clamp(s, 0, 1))];
      });
      if (sp < .04 && !merged && mode !== 1) { merged = true; wv -= 4.8; }
      if (sp > .2) merged = false;
      if (mode === 0 && (pulseT += dt) > 1.05) { pulseT = 0; wv -= 2.4; }
      wv += (-190 * w - 11 * wv) * dt; w += wv * dt;
      T.setAttribute('transform', 'scale(' + (1 + w * .85) + ',' + (1 - w * .85) + ')');
      layers.forEach(([els, pad]) => els.forEach((node, k) => {
        const [x, y, r] = P[k];
        node.setAttribute('cx', x.toFixed(2));
        node.setAttribute('cy', y.toFixed(2));
        node.setAttribute('r', (r + pad).toFixed(2));
      }));
    }

    function frame(now) {
      if (!alive) return;
      render(now);
      raf = requestAnimationFrame(frame);
    }

    function setState(s) {
      if (!alive) return;
      const m = typeof s === 'number' ? s : STATES[s];
      if (m === undefined || m === mode) return;
      if (m === 1) wv += 3.4;
      mode = m;
      if (reduce) render(performance.now());
    }

    function setMotion(id) {
      if (!alive) return;
      const i = MOTIONS.findIndex(m => m.id === id);
      if (i < 0 || i === mi) return;
      prevMi = mi; pmt = mt; mi = i; mt = 0; bl = 0;
      if (reduce) render(performance.now());
    }

    render(performance.now());
    if (!reduce) raf = requestAnimationFrame(frame);

    return {
      el: svg,
      setState,
      setMotion,
      get state() { return Object.keys(STATES)[mode]; },
      get motion() { return MOTIONS[mi].id; },
      destroy() { alive = false; cancelAnimationFrame(raf); svg.remove(); },
    };
  }

  window.CloakAgentOrbit = { mount };
})();
