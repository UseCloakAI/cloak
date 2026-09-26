/* ════════════════════════════════════════════════════════
   CLOAK BRAIN — a live view of memory + context
   Every memory is a node in the lobe for its type:
     frontal → projects · parietal → knowledge · occipital → identity
     temporal → episodes · cerebellum → preferences
   On each message, recalled memories light up and a signal travels
   from the brainstem to each one. The side panel shows what was
   recalled, how the context window is spent (and compressed), and
   the underlying .md files, which can be edited, exported, imported.
   ════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const M = () => window.CloakMemory;
  const C = () => window.CloakContext;
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };

  const REGIONS = {
    project: { lobe: 'Frontal', label: 'Projects', cx: 175, cy: 190, r: 72, sy: 1, lx: 175, ly: 108, rot: 0.3 },
    fact: { lobe: 'Parietal', label: 'Knowledge', cx: 348, cy: 128, r: 60, sy: 1, lx: 348, ly: 64, rot: 1.1 },
    profile: { lobe: 'Occipital', label: 'Identity', cx: 472, cy: 196, r: 50, sy: 1, lx: 478, ly: 140, rot: 2.2 },
    episode: { lobe: 'Temporal', label: 'Episodes', cx: 290, cy: 285, r: 42, sy: 0.72, lx: 222, ly: 318, rot: 0.8 },
    preference: { lobe: 'Cerebellum', label: 'Preferences', cx: 468, cy: 339, r: 30, sy: 0.72, lx: 545, ly: 396, rot: 1.7 },
  };
  const ORIGIN = { x: 390, y: 410 };
  const CENTER = { x: 300, y: 200 };
  const PATHS = {
    cerebrum: 'M150,318 C95,300 70,240 82,190 C92,130 140,82 205,62 C265,42 330,40 390,52 C460,66 520,110 535,175 C548,230 530,280 488,300 C455,315 420,312 395,318 C360,328 330,340 290,338 C240,336 200,334 150,318 Z',
    cerebellum: 'M404,322 C420,302 472,298 506,309 C536,319 541,349 516,364 C491,380 441,378 419,362 C403,350 397,336 404,322 Z',
    stem: 'M372,326 C381,356 380,392 374,426 L406,426 C403,392 405,360 414,332 Z',
    sulci: [
      'M298,46 C286,96 312,142 290,196 C280,222 292,238 286,252',
      'M150,262 C210,246 262,240 318,244 C350,246 372,236 392,226',
      'M118,166 C150,150 170,120 208,110',
      'M112,226 C150,214 186,226 214,206',
      'M338,72 C352,98 392,104 420,94',
      'M470,112 C476,150 500,170 520,200',
      'M200,300 C240,290 290,300 340,292',
      'M420,330 C450,322 490,322 520,334',
      'M424,346 C454,340 488,342 514,350',
    ],
  };
  const BRAIN_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 3.5a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 9.7a3 3 0 0 0 .6 4.8A3.2 3.2 0 0 0 7.7 19a2.8 2.8 0 0 0 4.3 1V4.9a2.7 2.7 0 0 0-2.5-1.4z"/><path d="M14.5 3.5a3 3 0 0 1 3 3v.2A3 3 0 0 1 20 9.7a3 3 0 0 1-.6 4.8 3.2 3.2 0 0 1-3.1 4.5 2.8 2.8 0 0 1-4.3 1"/><path d="M12 8.5h-1.6M12 13h2M7.6 11.6H9.2"/></svg>';

  let root = null;
  let svg = null;
  let layers = {};
  let pos = new Map();
  let edgeList = [];
  let knownPaths = null;
  let current = null;       // recall shown in the brain
  let openerEl = null;
  let editing = null;       // path being edited ('' = new, 'MEMORY.md' = index)
  let fireT = 0;
  let toastT = 0;
  let activity = '';

  /* ── helpers ── */
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const $ = (sel) => root && root.querySelector(sel);

  /* ── DOM ── */
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'brain-screen';
    root.className = 'brain-screen';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'brain-title');
    root.innerHTML = `
      <div class="brain-top">
        <button class="settings-back" type="button" data-act="close" aria-label="Back to chat">
          <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="brain-heading">
          <div class="modal-title" id="brain-title">Brain</div>
          <div class="brain-sub" id="brain-sub">Memory &amp; context</div>
        </div>
        <label class="brain-switch" title="When off, Cloak neither recalls nor saves memories">
          <input type="checkbox" id="brain-on">
          <span class="brain-switch-track" aria-hidden="true"><span class="brain-switch-knob"></span></span>
          <span class="brain-switch-label">Memory</span>
        </label>
      </div>
      <div class="brain-scroll">
        <div class="brain-grid">
          <section class="brain-card brain-stage" aria-label="Memory map">
            <div class="brain-card-head">
              <span class="brain-kicker">Live recall</span>
              <span class="brain-ticker" id="brain-ticker" aria-live="polite">Idle</span>
            </div>
            <div class="brain-canvas"><svg class="brain-svg" id="brain-svg" viewBox="0 0 600 440" role="img" aria-labelledby="brain-svg-title"><title id="brain-svg-title">Memory map</title></svg></div>
            <form class="brain-probe" id="brain-probe" autocomplete="off">
              <input class="inp-field" id="brain-probe-q" placeholder="Probe memory — type anything" aria-label="Probe memory">
              <button class="cta" type="submit">Probe</button>
            </form>
            <div class="brain-legend" id="brain-legend"></div>
          </section>
          <div class="brain-side">
            <section class="brain-card" aria-labelledby="brain-recall-h">
              <div class="brain-card-head"><h3 class="brain-kicker" id="brain-recall-h">Recalled</h3><span class="brain-meta" id="brain-recall-meta"></span></div>
              <ol class="brain-recall" id="brain-recall"></ol>
            </section>
            <section class="brain-card" aria-labelledby="brain-ctx-h">
              <div class="brain-card-head"><h3 class="brain-kicker" id="brain-ctx-h">Context window</h3><span class="brain-meta" id="brain-ctx-meta"></span></div>
              <div class="bctx-bar" id="bctx-bar" role="img" aria-label="Context budget"></div>
              <div class="bctx-legend" id="bctx-legend"></div>
              <div class="bctx-strip-label">Messages <span id="bctx-strip-note"></span></div>
              <div class="bctx-strip" id="bctx-strip" aria-hidden="true"></div>
              <ol class="bctx-chunks" id="bctx-chunks"></ol>
              <div class="brain-foot" id="bctx-foot"></div>
            </section>
            <section class="brain-card" aria-labelledby="brain-files-h">
              <div class="brain-card-head"><h3 class="brain-kicker" id="brain-files-h">Files</h3><span class="brain-meta" id="brain-files-meta"></span></div>
              <div class="bfile-actions">
                <button class="cta" type="button" data-act="new">+ New</button>
                <button class="bfile-btn" type="button" data-act="export">Export .md</button>
                <button class="bfile-btn" type="button" data-act="import">Import .md</button>
                <input type="file" id="brain-import" accept=".md,.markdown,text/markdown,text/plain" hidden>
              </div>
              <ul class="bfile-list" id="bfile-list"></ul>
            </section>
          </div>
        </div>
      </div>
      <div class="bedit" id="bedit" hidden>
        <div class="bedit-card" role="dialog" aria-modal="true" aria-labelledby="bedit-title">
          <div class="bedit-head">
            <span class="brain-kicker" id="bedit-title">Edit memory</span>
            <button class="bedit-x" type="button" data-act="edit-close" aria-label="Close editor">&times;</button>
          </div>
          <label class="bedit-label" for="bedit-path">Path</label>
          <input class="inp-field bedit-path" id="bedit-path" spellcheck="false">
          <textarea class="inp-field bedit-text" id="bedit-text" spellcheck="false" aria-label="Markdown"></textarea>
          <div class="err-msg" id="bedit-err"></div>
          <div class="bedit-actions">
            <button class="cta" type="button" data-act="edit-save">Save</button>
            <button class="danger" type="button" data-act="edit-delete">Delete</button>
            <button class="bfile-btn" type="button" data-act="edit-close">Cancel</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    svg = root.querySelector('#brain-svg');
    drawAnatomy();

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    root.querySelector('#brain-probe').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = root.querySelector('#brain-probe-q').value.trim();
      if (!q || !M()) return;
      const ctxTurns = recentTurns();
      M().recall(q, { touch: false, context: ctxTurns });
    });
    root.querySelector('#brain-on').addEventListener('change', (e) => { if (M()) M().setEnabled(e.target.checked); });
    root.querySelector('#brain-import').addEventListener('change', onImport);

    const legend = root.querySelector('#brain-legend');
    legend.innerHTML = Object.keys(REGIONS).map((t) => `<span class="brain-leg"><i class="brain-leg-dot t-${t}"></i>${REGIONS[t].label}<em>${REGIONS[t].lobe}</em></span>`).join('');
  }

  function drawAnatomy() {
    const defs = el('defs', {}, svg);
    const pat = el('pattern', { id: 'br-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'br-hatch-line' }, pat);

    const shadow = el('g', { class: 'br-shadow', transform: 'translate(6 6)' }, svg);
    [PATHS.stem, PATHS.cerebellum, PATHS.cerebrum].forEach((d) => el('path', { d }, shadow));
    const body = el('g', { class: 'br-body' }, svg);
    layers.stem = el('path', { d: PATHS.stem, class: 'br-stem' }, body);
    el('path', { d: PATHS.cerebellum, class: 'br-part' }, body);
    el('path', { d: PATHS.cerebrum, class: 'br-part' }, body);
    const sulci = el('g', { class: 'br-sulci' }, svg);
    PATHS.sulci.forEach((d) => el('path', { d }, sulci));

    layers.zones = el('g', { class: 'br-zones' }, svg);
    for (const [t, R] of Object.entries(REGIONS)) {
      el('ellipse', { cx: R.cx, cy: R.cy, rx: R.r + 6, ry: (R.r + 6) * R.sy, class: 'br-zone t-' + t }, layers.zones);
      const tx = el('text', { x: R.lx, y: R.ly, class: 'br-zone-label', 'text-anchor': 'middle' }, layers.zones);
      tx.textContent = R.label;
    }
    layers.edges = el('g', { class: 'br-edges' }, svg);
    layers.signals = el('g', { class: 'br-signals' }, svg);
    layers.nodes = el('g', { class: 'br-nodes' }, svg);
    layers.labels = el('g', { class: 'br-labels' }, svg);
    layers.empty = el('text', { x: 308, y: 196, class: 'br-empty', 'text-anchor': 'middle' }, svg);
  }

  /* ── layout ── */
  function layout(list) {
    const next = new Map();
    const byType = {};
    Object.keys(REGIONS).forEach((t) => (byType[t] = []));
    list.forEach((f) => (byType[f.type] || byType.fact).push(f));
    for (const [t, arr] of Object.entries(byType)) {
      const R = REGIONS[t];
      arr.sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path));
      const n = arr.length;
      const base = Math.max(2.4, Math.min(8.5, (R.r * 0.86 / Math.sqrt(Math.max(1, n))) * 0.55));
      arr.forEach((f, i) => {
        const rr = R.r * 0.86 * Math.sqrt(i / Math.max(1, n));
        const th = i * 2.39996 + R.rot;
        next.set(f.path, { x: R.cx + rr * Math.cos(th), y: R.cy + rr * Math.sin(th) * R.sy, r: base * (0.7 + f.importance * 0.6), f });
      });
    }
    return next;
  }

  function linkEdges(list) {
    const sets = list.map((f) => new Set([...(f.tags || []), ...(M() ? M().tokens(f.title) : [])]));
    const seen = new Set();
    const out = [];
    list.forEach((f, i) => {
      const best = [];
      list.forEach((g, j) => {
        if (i === j) return;
        let inter = 0;
        sets[i].forEach((t) => { if (sets[j].has(t)) inter++; });
        if (!inter) return;
        const sim = inter / (sets[i].size + sets[j].size - inter);
        if (sim >= 0.2) best.push({ j, sim });
      });
      best.sort((a, b) => b.sim - a.sim).slice(0, 2).forEach(({ j }) => {
        const key = i < j ? i + '|' + j : j + '|' + i;
        if (seen.has(key)) return;
        seen.add(key);
        out.push([list[i].path, list[j].path]);
      });
    });
    return out;
  }

  const curve = (a, b, pull) => {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const qx = mx + (CENTER.x - mx) * pull, qy = my + (CENTER.y - my) * pull;
    return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  };

  function renderNodes() {
    if (!svg || !M()) return;
    const list = M().list();
    pos = layout(list);
    edgeList = linkEdges(list);
    const born = knownPaths ? list.filter((f) => !knownPaths.has(f.path)).map((f) => f.path) : [];
    knownPaths = new Set(list.map((f) => f.path));

    layers.edges.textContent = '';
    edgeList.forEach(([a, b]) => {
      const p = el('path', { d: curve(pos.get(a), pos.get(b), 0.18), class: 'br-edge' }, layers.edges);
      p.dataset.a = a;
      p.dataset.b = b;
    });

    layers.nodes.textContent = '';
    for (const [path, p] of pos) {
      const f = p.f;
      const g = el('g', { class: 'br-node t-' + f.type + (born.includes(path) ? ' born' : ''), transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})` }, layers.nodes);
      g.dataset.path = path;
      const core = (f.type === 'profile' || f.type === 'preference') && f.importance >= 0.7;
      if (core) el('rect', { x: -p.r, y: -p.r, width: p.r * 2, height: p.r * 2, class: 'br-dot' }, g);
      else el('circle', { r: p.r, class: 'br-dot' }, g);
      el('title', {}, g).textContent = f.title + ' — ' + f.path;
    }
    layers.empty.textContent = list.length ? '' : (M().enabled() ? 'No memories yet — tell Cloak about yourself, or say “remember …”' : 'Memory is off');
    layers.empty.setAttribute('class', 'br-empty' + (list.length ? '' : ' show'));
    svg.querySelector('title').textContent = `Memory map: ${list.length} memories` + (current && current.hits.length ? `, ${current.hits.length} recalled for the last message` : '');
    if (current) paintRecall(current, false);
  }

  /* ── recall animation ── */
  function paintRecall(result, animate) {
    if (!svg) return;
    const hits = (result && result.hits) || [];
    const on = new Map(hits.map((h, i) => [h.path, i]));
    layers.nodes.querySelectorAll('.br-node').forEach((g) => {
      const i = on.get(g.dataset.path);
      g.classList.toggle('on', i !== undefined);
      g.classList.toggle('core-on', i !== undefined && hits[i].why === 'core');
      g.classList.toggle('dim', hits.length > 0 && i === undefined);
    });
    layers.edges.querySelectorAll('.br-edge').forEach((p) => p.classList.toggle('hot', on.has(p.dataset.a) && on.has(p.dataset.b)));
    layers.labels.textContent = '';
    const placed = [];
    hits.filter((h) => h.why !== 'core').concat(hits.filter((h) => h.why === 'core')).slice(0, 3).forEach((h, i) => {
      const p = pos.get(h.path);
      if (!p) return;
      const text = h.title.length > 26 ? h.title.slice(0, 25) + '…' : h.title;
      const g = el('g', { class: 'br-label' }, layers.labels);
      if (animate) g.style.animationDelay = (380 + i * 120) + 'ms';
      const bg = el('rect', { height: 20, class: 'br-label-bg' }, g);
      const tx = el('text', { x: 7, y: 14, class: 'br-label-text' }, g);
      tx.textContent = text;
      let tw = 0;
      try { tw = tx.getComputedTextLength(); } catch (_) {}
      const w = (tw || text.length * 6.6) + 14;
      bg.setAttribute('width', w.toFixed(1));
      const right = p.x + p.r + 8 + w < 596;
      const x = right ? p.x + p.r + 8 : Math.max(4, p.x - p.r - 8 - w);
      let y = Math.max(8, Math.min(412, p.y - 10));
      // Nudge down past labels already placed so neighbours don't overlap.
      for (let k = 0; k < 6 && placed.some((b) => x < b.x + b.w && b.x < x + w && y < b.y + 22 && b.y < y + 22); k++) y = Math.min(412, y + 23);
      placed.push({ x, y, w });
      g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    });

    if (!animate || reduced()) return;
    layers.signals.textContent = '';
    clearTimeout(fireT);
    layers.stem.classList.remove('fire');
    void layers.stem.getBoundingClientRect();
    layers.stem.classList.add('fire');
    hits.slice(0, 12).forEach((h, i) => {
      const p = pos.get(h.path);
      if (!p) return;
      const path = el('path', { d: curve(ORIGIN, p, 0.35), class: 'br-signal' }, layers.signals);
      const len = path.getTotalLength ? path.getTotalLength() : 400;
      path.style.strokeDasharray = `${len} ${len}`;
      path.style.setProperty('--len', len);
      path.style.animationDelay = i * 90 + 'ms';
      const node = layers.nodes.querySelector(`.br-node[data-path="${CSS.escape(h.path)}"]`);
      if (node) {
        const ring = el('circle', { r: p.r + 3, class: 'br-ring' }, node);
        ring.style.animationDelay = 380 + i * 90 + 'ms';
        setTimeout(() => ring.remove(), 1900 + i * 90);
      }
    });
    fireT = setTimeout(() => { layers.signals.textContent = ''; layers.stem.classList.remove('fire'); }, 2400);
  }

  /* ── side panels ── */
  function renderRecall() {
    const list = $('#brain-recall');
    if (!list) return;
    const r = current;
    const meta = $('#brain-recall-meta');
    if (!r || !r.hits.length) {
      list.innerHTML = `<li class="brain-empty-row">${r ? (r.enabled === false ? 'Memory is off.' : 'Nothing relevant for “' + esc(String(r.query || '').slice(0, 60)) + '”.') : 'Send a message or probe to see what Cloak recalls.'}</li>`;
      meta.textContent = '';
      return;
    }
    meta.textContent = `${r.hits.length} of ${r.total} · ${fmt(r.tokens)} tok`;
    list.innerHTML = r.hits.map((h, i) => `
      <li><button class="brow" type="button" data-open="${esc(h.path)}">
        <span class="brow-rank">${i + 1}</span>
        <span class="brow-main"><span class="brow-title">${esc(h.title)}</span><span class="brow-sub"><i class="brain-leg-dot t-${h.type}"></i>${esc(M().TYPE_LABEL[h.type] || h.type)} · ${h.why === 'core' ? 'always on' : h.why === 'thought' ? 'surfaced while thinking' : h.why === 'carried' ? 'pulled up by last turn’s thinking' : 'match ' + Math.round(h.rel * 100) + '%'}</span></span>
        <span class="brow-bar" aria-hidden="true"><span style="width:${Math.round(Math.min(1, h.why === 'core' ? 1 : h.rel) * 100)}%"></span></span>
      </button></li>`).join('');
  }

  function renderContext() {
    const plan = C() && C().lastPlan();
    const bar = $('#bctx-bar');
    if (!bar) return;
    const legend = $('#bctx-legend');
    const strip = $('#bctx-strip');
    const chunks = $('#bctx-chunks');
    const meta = $('#brain-ctx-meta');
    const foot = $('#bctx-foot');
    const q = M() ? M().quota() : { used: 0, cap: 0 };
    foot.textContent = `Background calls today: ${q.used}/${q.cap} memory · ${C() ? C().calls() : 0} compression this session. Both run on the cheapest model tier.`;
    if (!plan) {
      bar.innerHTML = '';
      legend.innerHTML = '<span class="brain-empty-row">Starts filling once you chat.</span>';
      strip.innerHTML = '';
      chunks.innerHTML = '';
      meta.textContent = '';
      $('#bctx-strip-note').textContent = '';
      return;
    }
    const segs = [
      ['mem', 'Memory', plan.memory],
      ['sum', 'Summaries', plan.summary + plan.gap],
      ['live', 'Recent turns', plan.live],
    ];
    const free = Math.max(0, plan.budget - plan.used);
    const total = Math.max(plan.budget, plan.used);
    bar.innerHTML = segs.concat([['free', 'Free', free]]).map(([k, , v]) => v ? `<span class="bctx-seg s-${k}" style="flex-basis:${(v / total * 100).toFixed(2)}%"></span>` : '').join('');
    bar.setAttribute('aria-label', `Context budget: ${fmt(plan.used)} of ${fmt(plan.budget)} tokens used`);
    legend.innerHTML = segs.concat([['free', 'Free', free]]).map(([k, label, v]) => `<span class="bctx-leg"><i class="bctx-key s-${k}"></i>${label} <b>${fmt(v)}</b></span>`).join('');
    meta.textContent = `${fmt(plan.used)} / ${fmt(plan.budget)} tok`;

    const n = plan.total;
    const dEnd = plan.digest ? plan.digest.e : 0;
    const liveFrom = n - plan.liveCount;
    let cells = '';
    for (let i = 0; i < n; i++) {
      const k = i < dEnd ? 'd' : i < plan.covered ? 'c' : i < liveFrom ? 'g' : 'l';
      cells += `<i class="bctx-cell k-${k}"></i>`;
    }
    strip.innerHTML = cells;
    const parts = [];
    if (plan.digest) parts.push(`${dEnd} in digest`);
    if (plan.chunks.length) parts.push(`${plan.covered - dEnd} in ${plan.chunks.length} chunk${plan.chunks.length > 1 ? 's' : ''}`);
    if (plan.gapCount) parts.push(`${plan.gapCount} abbreviated`);
    parts.push(`${plan.liveCount} verbatim`);
    $('#bctx-strip-note').textContent = `· ${n} total · ` + parts.join(' · ');

    const ctx = C().get();
    const rows = [];
    if (ctx.digest) rows.push({ label: `Digest · messages 1–${ctx.digest.e}`, tok: ctx.digest.tok, sum: ctx.digest.sum, k: 'd' });
    ctx.chunks.forEach((c) => rows.push({ label: `Chunk · messages ${c.s + 1}–${c.e}`, tok: c.tok, sum: c.sum, k: 'c' }));
    chunks.innerHTML = rows.map((r, i) => `
      <li class="bchunk k-${r.k}"><button type="button" class="bchunk-head" aria-expanded="false" data-chunk="${i}"><span>${r.label}</span><b>${fmt(r.tok)} tok</b></button><pre class="bchunk-sum" hidden>${esc(r.sum)}</pre></li>`).join('');
  }

  function renderFiles() {
    const ul = $('#bfile-list');
    if (!ul || !M()) return;
    const list = M().list();
    $('#brain-files-meta').textContent = list.length + ' file' + (list.length === 1 ? '' : 's') + (M().remote() ? ' · Supabase' : ' · session only');
    ul.innerHTML = `<li><button class="bfile" type="button" data-open="MEMORY.md"><span class="bfile-type t-index">IDX</span><span class="bfile-path">MEMORY.md</span><span class="bfile-title">Index of every memory</span></button></li>` +
      list.map((f) => `<li><button class="bfile" type="button" data-open="${esc(f.path)}"><span class="bfile-type t-${f.type}">${f.type.slice(0, 4).toUpperCase()}</span><span class="bfile-path">${esc(f.path)}</span><span class="bfile-title">${esc(f.title)}</span></button></li>`).join('');
  }

  function renderHeader() {
    if (!root || !M()) return;
    root.querySelector('#brain-on').checked = M().enabled();
    const where = M().remote() ? (M().loaded() ? 'stored in your Cloak account' : 'loading from your account…')
      : M().guest() ? 'guest — this session only, sign in to keep them' : 'account storage unavailable';
    root.querySelector('#brain-sub').textContent = `${M().size()} memories · ${where}`;
    setTicker(activity || (M().enabled() ? recallTicker(current) : 'Memory off'));
  }

  function setTicker(t) { const k = $('#brain-ticker'); if (k) k.textContent = t; }
  function recallTicker(r) {
    if (!r) return M() && M().enabled() ? 'Idle' : 'Memory off';
    const q = String(r.query || '');
    return r.hits.length ? `Recalled ${r.hits.length} of ${r.total} for “${q.slice(0, 40)}${q.length > 40 ? '…' : ''}”` : 'Nothing relevant recalled';
  }

  function renderAll() {
    if (!root || root.hidden) return;
    renderHeader();
    renderNodes();
    renderRecall();
    renderContext();
    renderFiles();
  }

  /* ── editor ── */
  function openEditor(path) {
    const box = $('#bedit');
    const text = $('#bedit-text');
    const p = $('#bedit-path');
    $('#bedit-err').textContent = '';
    editing = path;
    const isIndex = path === 'MEMORY.md';
    if (isIndex) {
      text.value = M().indexMarkdown();
      p.value = 'MEMORY.md';
    } else if (path) {
      text.value = M().raw(path);
      p.value = path;
    } else {
      p.value = 'fact/new-memory.md';
      text.value = '---\ntitle: New memory\ntype: fact\ntags: []\nimportance: 0.5\n---\n- ';
    }
    text.readOnly = isIndex;
    p.readOnly = isIndex;
    root.querySelector('[data-act="edit-save"]').hidden = isIndex;
    root.querySelector('[data-act="edit-delete"]').hidden = isIndex || !path;
    $('#bedit-title').textContent = isIndex ? 'MEMORY.md (generated)' : path ? 'Edit memory' : 'New memory';
    box.hidden = false;
    (isIndex ? text : text).focus();
  }
  function closeEditor() { const b = $('#bedit'); if (b) b.hidden = true; editing = null; }
  function saveEditor() {
    const raw = $('#bedit-text').value;
    const path = $('#bedit-path').value.trim();
    const f = M().saveFile(editing || '', raw, path);
    if (!f) { $('#bedit-err').textContent = 'Path must look like type/name.md (type: ' + M().TYPES.join(', ') + ').'; return; }
    closeEditor();
    toast('Saved ' + f.path);
  }

  /* ── events ── */
  function onClick(e) {
    const t = e.target.closest('[data-act],[data-open],[data-chunk]');
    if (!t) {
      const node = e.target.closest && e.target.closest('.br-node');
      if (node) openEditor(node.dataset.path);
      else if (e.target === $('#bedit')) closeEditor();
      return;
    }
    if (t.dataset.open) return openEditor(t.dataset.open);
    if (t.dataset.chunk !== undefined) {
      const pre = t.nextElementSibling;
      pre.hidden = !pre.hidden;
      t.setAttribute('aria-expanded', String(!pre.hidden));
      return;
    }
    switch (t.dataset.act) {
      case 'close': return close();
      case 'new': return openEditor('');
      case 'export': return exportMd();
      case 'import': return $('#brain-import').click();
      case 'edit-close': return closeEditor();
      case 'edit-save': return saveEditor();
      case 'edit-delete':
        if (editing && confirm('Delete ' + editing + '?')) { M().removeFile(editing); closeEditor(); toast('Deleted'); }
        return;
    }
  }
  function onKey(e) {
    if (e.key === 'Tab') {
      // Keep focus inside the open dialog (editor first, else the brain).
      const scope = !$('#bedit').hidden ? $('#bedit') : root;
      const f = [...scope.querySelectorAll('button,input,textarea,[href],[tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!scope.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (!$('#bedit').hidden) closeEditor(); else close();
  }
  function exportMd() {
    const blob = new Blob([M().exportMarkdown()], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cloak-memory-' + new Date().toISOString().slice(0, 10) + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function onImport(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 600000) { toast('File too large'); return; }
    file.text().then((txt) => {
      const done = M().importMarkdown(txt, file.name);
      toast(done.length ? `Imported ${done.length} memor${done.length === 1 ? 'y' : 'ies'}` : 'Nothing to import');
    });
  }

  function recentTurns() {
    try {
      // `hist` is cloak.js's chat history (global lexical binding).
      const h = typeof hist !== 'undefined' && Array.isArray(hist) ? hist : [];
      return h.slice(-3).map((m, i, a) => ({ text: String(m.message || '').slice(0, 600), w: i === a.length - 1 ? 0.45 : 0.3 }));
    } catch (_) { return []; }
  }

  /* ── open / close ── */
  function open(opts) {
    build();
    if (!root.hidden) return;
    openerEl = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add('brain-open');
    if (opts && opts.recall) current = opts.recall;
    else if (!current && M()) current = M().lastRecall();
    renderAll();
    requestAnimationFrame(() => {
      root.classList.add('in');
      root.querySelector('[data-act="close"]').focus();
      if (current && current.hits.length) paintRecall(current, true);
    });
    try { if (typeof closeMobileSidebar === 'function' && window.innerWidth <= 640) closeMobileSidebar(); } catch (_) {}
  }
  function close() {
    if (!root || root.hidden) return;
    closeEditor();
    root.classList.remove('in');
    root.hidden = true;
    document.documentElement.classList.remove('brain-open');
    if (openerEl && openerEl.focus) try { openerEl.focus(); } catch (_) {}
  }

  /* ── chat-side affordances ── */
  function pulseButton(count) {
    const btn = document.getElementById('brain-btn');
    if (!btn) return;
    const badge = btn.querySelector('.brain-badge');
    if (badge) {
      badge.textContent = count ? String(count) : '';
      badge.hidden = !count;
    }
    btn.classList.remove('firing');
    void btn.offsetWidth;
    if (count) btn.classList.add('firing');
    btn.setAttribute('aria-label', count ? `Open Brain — ${count} memories recalled` : 'Open Brain');
  }

  // Chip above an answer: which memories shaped it. Opens the brain on click.
  function attachRecall(botMsgEl, result) {
    if (!botMsgEl || !result || !result.hits || !result.hits.some((h) => h.why !== 'core')) return;
    const body = botMsgEl.querySelector('.bot-body');
    const bc = botMsgEl.querySelector('.bot-content');
    if (!body || !bc) return;
    const old = body.querySelector('.mem-chip');
    if (old) old.remove();
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mem-chip';
    const n = result.hits.length;
    chip.innerHTML = BRAIN_ICON + '<span>' + n + ' memor' + (n === 1 ? 'y' : 'ies') + '</span>';
    chip.title = result.hits.map((h) => h.title).join(' · ');
    chip.setAttribute('aria-label', `Recalled ${n} memor${n === 1 ? 'y' : 'ies'}: ${chip.title}. Open Brain`);
    chip.addEventListener('click', (e) => { e.stopPropagation(); open({ recall: result }); });
    body.insertBefore(chip, bc);
  }

  function toast(msg, action) {
    let t = document.getElementById('mem-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mem-toast';
      t.className = 'mem-toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.innerHTML = BRAIN_ICON + '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">View</button>' : '');
    if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); action(); };
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 3400);
  }

  /* ── wiring ── */
  function wire() {
    const mem = M();
    const cx = C();
    if (mem) {
      mem.on('recall', (r) => {
        current = r;
        pulseButton(r.hits.some((h) => h.why !== 'core') ? r.hits.length : 0);
        if (root && !root.hidden) {
          renderRecall();
          paintRecall(r, true);
          setTicker(recallTicker(r));
          const s = svg && svg.querySelector('title');
          if (s) s.textContent = `Memory map: ${r.total} memories, ${r.hits.length} recalled`;
        }
      });
      mem.on('change', (d) => {
        if (root && !root.hidden) { renderHeader(); renderNodes(); renderFiles(); }
        const ops = (d && d.ops) || [];
        if (d && (d.source === 'auto' || d.source === 'explicit') && ops.length) {
          const added = ops.filter((o) => o.op !== 'delete');
          const first = added[0] || ops[0];
          const msg = d.source === 'explicit' && first.op === 'delete' ? 'Forgot: ' + first.title
            : added.length ? (added.length === 1 ? 'Remembered: ' + first.title : `Memory updated · ${added.length} notes`) : `Memory updated`;
          toast(msg, () => open());
        }
      });
      mem.on('enabled', () => { renderAll(); });
      mem.on('sync', (d) => { renderHeader(); if (!d.ok) setTicker('Couldn’t reach memory storage — changes kept for this session'); });
      mem.on('extracting', () => { activity = 'Writing to memory…'; layers.stem && layers.stem.classList.add('busy'); setTicker(activity); });
      mem.on('extracted', (d) => {
        activity = '';
        if (layers.stem) layers.stem.classList.remove('busy');
        setTicker(d.error ? 'Memory write failed — will retry' : d.ops.length ? `Saved ${d.ops.length} change${d.ops.length > 1 ? 's' : ''}` : 'Nothing new to remember');
      });
    }
    if (cx) {
      cx.on('plan', () => { if (root && !root.hidden) renderContext(); });
      cx.on('change', () => { if (root && !root.hidden) renderContext(); });
      cx.on('compressing', (d) => { activity = d.merge ? 'Folding summaries into the digest…' : `Compressing messages ${d.s + 1}–${d.e}…`; layers.stem && layers.stem.classList.add('busy'); setTicker(activity); });
      cx.on('compressed', (d) => {
        activity = '';
        if (layers.stem) layers.stem.classList.remove('busy');
        setTicker(d.error ? 'Compression failed — will retry' : d.merge ? 'Digest updated' : `Compressed ${d.e - d.s} messages · ${fmt(d.from)} → ${fmt(d.tok)} tok`);
        if (root && !root.hidden) renderContext();
      });
    }
  }

  window.CloakBrain = { open, close, attachRecall, toast, pulse: pulseButton, icon: BRAIN_ICON };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();
})();
