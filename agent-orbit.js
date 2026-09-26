/* ════════════════════════════════════════════════════════
   CLOAK AGENT ORBIT — "agents working" indicator
   Starting: one orb with a heartbeat squish.
   Looping:  splits into two orbs orbiting at a steady pace.
   Completed: they merge, squish and settle into one orb.

   Usage:
     <script src="agent-orbit.js"></script>
     const orbit = CloakAgentOrbit.mount(el, { size: 40, state: 'starting' });
     orbit.setState('looping');   // 'starting' | 'looping' | 'completed'
     orbit.destroy();

   Colours come from --acc (fill) and --ink (outline), so it follows
   the active theme. Respects prefers-reduced-motion (jumps to state).
   ════════════════════════════════════════════════════════ */
(function(){
  const NS = 'http://www.w3.org/2000/svg';
  const STATES = { starting: 0, looping: 1, completed: 2 };
  const R = 11, RM = 15, D = 20, SPEED = 4.5;
  let uid = 0;

  function mk(tag, parent, attrs){
    const e = document.createElementNS(NS, tag);
    for(const k in attrs) e.setAttribute(k, attrs[k]);
    parent.appendChild(e);
    return e;
  }

  function mount(el, opts){
    opts = opts || {};
    const size = opts.size || 40;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fid = 'cloak-orbit-goo-' + (++uid);

    const svg = mk('svg', el, { width: size, height: size, viewBox: '-40 -40 80 80', 'aria-hidden': 'true', style: 'overflow:visible;display:block' });
    // Gooey metaball filter so the orbs neck together as they merge/split
    const filter = mk('filter', mk('defs', svg, {}), { id: fid, filterUnits: 'userSpaceOnUse', x: -60, y: -60, width: 120, height: 120 });
    mk('feGaussianBlur', filter, { stdDeviation: 3.2 });
    mk('feColorMatrix', filter, { values: '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 22 -10' });

    const T = mk('g', svg, {});
    const layers = [['var(--ink)', 2.8], ['var(--acc)', 0]].map(([fill, pad]) => {
      const g = mk('g', T, { filter: 'url(#' + fid + ')', style: 'fill:' + fill });
      return [mk('circle', g, {}), mk('circle', g, {}), pad];
    });

    let mode = STATES[opts.state] ?? 1;
    let d = mode === 1 ? D : 0, w = 0, wv = 0, ang = 0, spin = mode === 1 ? SPEED : 0;
    let last = performance.now(), pulseT = 0, merged = d < .6, raf = 0, alive = true;

    function render(){
      const r = RM + (R - RM) * (d / D), x = Math.cos(ang) * d, y = Math.sin(ang) * d, deg = ang * 180 / Math.PI;
      T.setAttribute('transform', `rotate(${deg}) scale(${1 + w * .9},${1 - w * .9}) rotate(${-deg})`);
      layers.forEach(([a, b, pad]) => {
        a.setAttribute('cx', x);  a.setAttribute('cy', y);
        b.setAttribute('cx', -x); b.setAttribute('cy', -y);
        a.setAttribute('r', r + pad); b.setAttribute('r', r + pad);
      });
    }

    function frame(now){
      if(!alive) return;
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      d += ((mode === 1 ? D : 0) - d) * (1 - Math.exp(-dt * (mode === 1 ? 5 : 7)));
      if(d < .6 && !merged){ merged = true; wv -= 4.5; }   // landing squish on merge
      if(d > 2) merged = false;
      // steady spin while working, slow warm-up, winds down when done
      const tgt = mode === 1 ? SPEED : mode === 0 ? 1.2 : 0;
      spin += (tgt - spin) * (1 - Math.exp(-dt * 3));
      ang += spin * dt;
      if(mode === 0 && (pulseT += dt) > 1.1){ pulseT = 0; wv -= 2.2; }  // heartbeat
      wv += (-180 * w - 11 * wv) * dt; w += wv * dt;                    // squish spring
      render();
      raf = requestAnimationFrame(frame);
    }

    function setState(s){
      const m = typeof s === 'number' ? s : STATES[s];
      if(m === undefined || m === mode) return;
      if(m === 1) wv += 3;   // stretch as it splits
      mode = m;
      if(reduce){ d = mode === 1 ? D : 0; render(); }
    }

    render();
    if(!reduce) raf = requestAnimationFrame(frame);

    return {
      el: svg,
      setState,
      get state(){ return Object.keys(STATES)[mode]; },
      destroy(){ alive = false; cancelAnimationFrame(raf); svg.remove(); }
    };
  }

  window.CloakAgentOrbit = { mount };
})();
