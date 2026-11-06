/* Landing page behaviour (prototype). Every interaction here is a real
   component from ds.css/ds.js running with sample content. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const ic = DS.icon;
  const reduced = () => DS.reduce.matches;

  /* nav: surface + hairline once the page has scrolled (no scroll listener) */
  const nav = $('#nav');
  new IntersectionObserver(([e]) => nav.classList.toggle('is-stuck', !e.isIntersecting)).observe($('#nav-sentinel'));

  /* ── hero: one streamed reply, then still ───────────────────── */
  const REPLY = [
    ['p', 'Depends on what failed. A new battery or SSD usually costs a fraction of a new laptop and can buy you a few more years.', 1],
    ['p', 'If the logic board or screen has gone, put that money toward a replacement instead.', 2],
  ];
  function streamHero() {
    const box = $('#demo-reply'), orb = $('#demo-orb'), status = $('#demo-status');
    const done = () => { orb.classList.remove('is-working'); status.textContent = 'Read 5 sources'; };
    const cite = n => `<a class="cite" href="#memory" aria-label="Source ${n}">${n}</a>`;
    if (reduced()) { box.innerHTML = REPLY.map(([t, s, c]) => `<${t}>${s} ${cite(c)}</${t}>`).join(''); done(); return; }
    let delay = 900;
    REPLY.forEach(([tag, text, c]) => {
      const el = document.createElement(tag); box.append(el);
      text.split(' ').forEach(w => {
        setTimeout(() => { const s = document.createElement('span'); s.className = 'tk'; s.textContent = w + ' '; el.append(s); }, delay);
        delay += 42;
      });
      setTimeout(() => el.insertAdjacentHTML('beforeend', cite(c)), delay);
      delay += 180;
    });
    setTimeout(() => { status.textContent = 'Writing'; }, 900);
    setTimeout(done, delay);
  }
  streamHero();

  /* ── models: master / detail tabs ───────────────────────────── */
  const MODELS = {
    kairos: {
      tag: 'Default', head: 'The main reply, with help when you want it.',
      body: 'Kairos answers by default. Turn agents on and it can hand parts of the job to web search, a review pass, or Linus.',
      good: ['Questions that need current sources', 'Plans and long answers', 'Handing work to agents'],
      tryIt: 'Compare three budget e-readers and check current prices.',
    },
    linus: {
      tag: 'Code', head: 'Writes the whole file and keeps it running.',
      body: 'Linus is Cloak in code mode. Builds open in a sandbox you can preview, edit, fix and export.',
      good: ['Full pages and React components', 'Fixing a bug in a file you attach', 'Scripts that run in the chat (JS, Python)'],
      tryIt: 'Make a printable checklist page for a laptop repair.',
    },
    pneuma: {
      tag: 'Lightest', head: 'Instant. Sharp. No filler.',
      body: 'Pneuma gets to the answer before you finish asking. The lightest model, with the smallest footprint.',
      good: ['Quick facts and definitions', 'Rewrites and short drafts', 'Reading text in a photo'],
      tryIt: 'Make this email shorter and more polite.',
    },
  };
  const tabs = [...document.querySelectorAll('.model-tab')];
  const panel = $('#model-panel'), mpc = $('#mp-content'), mark = $('.mp-mark');
  function showModel(key, animate = true) {
    const m = MODELS[key];
    tabs.forEach(t => { const on = t.dataset.model === key; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    panel.setAttribute('aria-labelledby', 'tab-' + key);
    mark.dataset.m = key;
    mpc.innerHTML = `
      <div class="mp-top"><span class="tag tag-acc">${m.tag}</span></div>
      <h3 class="t-d2">${m.head}</h3>
      <p class="t-body">${m.body}</p>
      <ul class="mp-good">${m.good.map(g => `<li>${ic('check')}<span>${g}</span></li>`).join('')}</ul>
      <div class="mp-try">${ic('chat-circle')}<p><span>Try asking</span>${m.tryIt}</p></div>`;
    if (animate && !reduced()) { mpc.classList.remove('is-swap'); void mpc.offsetWidth; mpc.classList.add('is-swap'); }
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => showModel(t.dataset.model));
    t.addEventListener('keydown', e => {
      const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); showModel(n.dataset.model);
    });
  });
  showModel('kairos', false);

  /* ── effort: the slider from the app, with honest readouts ──── */
  const roll = (el, text) => {
    if (el.textContent === text) return;
    el.textContent = text;
    if (!reduced()) { el.classList.remove('is-roll'); void el.offsetWidth; el.classList.add('is-roll'); }
  };
  const labels = [...document.querySelectorAll('#effort-labels span')];
  DS.effort($('#effort-landing'), {
    value: 50,
    onChange: L => {
      roll($('#er-name'), L.name); $('#er-desc').textContent = L.desc;
      roll($('#er-src'), String(L.sources)); roll($('#er-rounds'), String(L.rounds));
      labels.forEach(s => s.classList.toggle('is-on', s.textContent === L.name));
    },
  });

  /* ── memory: real file format from memory-system.md ─────────── */
  const FILES = [
    { path: 'MEMORY.md', type: 'index', icon: 'stack', md: `# Memory\n- [project] Kitchen renovation  project/kitchen-renovation.md\n- [fact] 2014 laptop  fact/2014-laptop.md\n- [preference] Short answers first  preference/short-answers.md\n- [episode] Chose to repair the laptop  episode/laptop-repair.md` },
    { path: 'fact/2014-laptop.md', type: 'fact', icon: 'file-text', md: fm('2014 laptop', 'fact', '[laptop, hardware]', '0.6') + `- Has a 13-inch laptop from 2014.\n- Battery no longer holds a charge.\n- Mostly used for writing and browsing.` },
    { path: 'project/kitchen-renovation.md', type: 'project', icon: 'file-text', md: fm('Kitchen renovation', 'project', '[home, budget]', '0.8') + `- Renovating a small kitchen on a fixed budget.\n- Doing the tiling themselves; hiring out electrical work.` },
    { path: 'preference/short-answers.md', type: 'preference', icon: 'file-text', md: fm('Short answers first', 'preference', '[style]', '0.9') + `- Wants the short answer first, details on request.\n- Prefers metric units.` },
    { path: 'episode/laptop-repair.md', type: 'episode', icon: 'file-text', md: fm('Chose to repair the laptop', 'episode', '[laptop]', '0.5') + `- 2026-10-12: Decided to replace the battery instead of buying new.` },
  ];
  function fm(title, type, tags, imp) {
    return `---\ntitle: ${title}\ntype: ${type}\ntags: ${tags}\nimportance: ${imp}\nupdated: 2026-10-12\nsource: auto\n---\n`;
  }
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const paint = md => esc(md)
    .replace(/^(---)$/gm, '<span class="fm">$1</span>')
    .replace(/^([a-z]+):(.*)$/gm, '<span class="k">$1:</span><span class="v">$2</span>')
    .replace(/^(# .*)$/gm, '<strong>$1</strong>');
  const list = $('#bd-files'), md = $('#bd-md'), path = $('#bd-path');
  list.innerHTML = FILES.map((f, i) => `<button class="bd-file-btn" role="tab" type="button" aria-selected="${i === 1}" tabindex="${i === 1 ? 0 : -1}" data-i="${i}">${ic(f.icon)}<span class="grow">${f.path}</span>${f.type !== 'index' ? `<span class="tag">${f.type}</span>` : ''}</button>`).join('');
  function openFile(i, animate = true) {
    const f = FILES[i];
    list.querySelectorAll('.bd-file-btn').forEach(b => { const on = +b.dataset.i === i; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    path.textContent = f.path; md.innerHTML = paint(f.md);
    if (animate && !reduced()) { md.classList.remove('is-swap'); void md.offsetWidth; md.classList.add('is-swap'); }
  }
  list.addEventListener('click', e => { const b = e.target.closest('.bd-file-btn'); if (b) openFile(+b.dataset.i); });
  list.addEventListener('keydown', e => {
    const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; if (!d) return;
    e.preventDefault();
    const btns = [...list.querySelectorAll('.bd-file-btn')], i = btns.indexOf(document.activeElement);
    const n = (i + d + btns.length) % btns.length; btns[n].focus(); openFile(n);
  });
  openFile(1, false);
  const sw = $('#mem-switch');
  sw.addEventListener('click', () => {
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(on));
    $('#brain-demo').classList.toggle('is-off', !on);
    DS.toast(on ? 'Memory on. Cloak will save and recall.' : 'Memory off. Nothing is saved or recalled.', on ? 'check' : 'info');
  });
})();
