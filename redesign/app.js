/* App shell behaviour (prototype). Sample data only; no network calls.
   Mirrors the live IA: Chat / Brain / Settings / Values in one shell,
   goPage(), a sidebar that folds to an icon rail (drawer on phones). */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ic = DS.icon;
  const reduced = () => DS.reduce.matches;
  const get = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const shell = $('#screen-app'), auth = $('#screen-auth');
  const phone = matchMedia('(max-width: 640px)');

  /* ── sample data ─────────────────────────────────────────────── */
  const SOURCES = [
    ['Laptop battery replacement guides', 'ifixit.com'],
    ['When to repair or replace a laptop', 'consumerreports.org'],
    ['Which older Macs still get updates', 'support.apple.com'],
    ['SSD upgrades for older laptops', 'crucial.com'],
    ['Right to repair: what it covers', 'repair.org'],
  ];
  const CHATS = [
    { id: 'laptop', title: 'Laptop: repair or replace', msgs: [
      { u: 'Is it worth fixing my 2014 laptop, or should I buy a new one?' },
      { c: `<p>Short answer: <strong>fix it if it’s the battery or storage</strong>, replace it if the logic board or screen has failed. <a class="cite" href="#s1">1</a></p>
<ul><li>A new battery or SSD usually costs a fraction of a new laptop. <a class="cite" href="#s2">2</a></li>
<li>Check that your model still gets system updates before you spend anything. <a class="cite" href="#s3">3</a></li>
<li>If it’s slow as well, an SSD often helps more than people expect. <a class="cite" href="#s4">4</a></li></ul>
<p>Want me to check what your exact model supports?</p>`, meta: 'Kairos · Medium', search: true },
      { u: 'Battery’s dead and it’s slow. Can you make me a checklist page I can print?' },
      { c: `<p>Here’s a one-page checklist. Open it to preview, edit or print. The print styles keep each step on one page:</p>`, meta: 'Linus · Medium', build: true,
        code: { name: 'print.css', body: `<span class="c">/* keep each step together on paper */</span>\n@media print {\n  <span class="t">.no-print</span> { display: none; }\n  <span class="t">li</span> { break-inside: avoid; }\n  <span class="t">body</span> { font: 11pt/1.5 <span class="s">"Geist"</span>, sans-serif; }\n}` } },
    ] },
    { id: 'tile', title: 'Kitchen tile layout', msgs: [
      { u: 'How do I start laying tile so the cuts end up even on both walls?' },
      { c: '<p>Start from the center, not a corner. Snap a chalk line across the middle of the floor, dry-lay a row of tiles along it, then shift the line by half a tile if either wall ends up with a sliver under a third of a tile.</p>', meta: 'Kairos · Medium' },
    ] },
    { id: 'email', title: 'Shorter email to landlord', msgs: [
      { u: 'Make this shorter and more polite: “The heating has been broken for two weeks and nobody has called me back.”' },
      { c: '<p>“Hi Dana, the heating has been out for two weeks. Could someone come take a look this week? Thanks.”</p>', meta: 'Pneuma · Low' },
    ] },
    { id: 'ereaders', title: 'Budget e-readers compared', msgs: [
      { u: 'Compare three budget e-readers.' },
      { c: '<p>I’d need current prices to be useful here, and web search is part of how I check them. Turn on web search in the model menu and ask again, and I’ll compare screen, storage and library support.</p>', meta: 'Kairos · Medium' },
    ] },
    { id: 'csv', title: 'Python CSV cleanup', msgs: [
      { u: 'Remove duplicate rows from a CSV in Python.' },
      { c: '<p>With the standard library only:</p>', meta: 'Linus · Low', code: { name: 'dedupe.py', body: `<span class="t">import</span> csv\n\nseen, rows = set(), []\n<span class="t">with</span> open(<span class="s">"in.csv"</span>, newline=<span class="s">""</span>) <span class="t">as</span> f:\n    <span class="t">for</span> row <span class="t">in</span> csv.reader(f):\n        key = tuple(row)\n        <span class="t">if</span> key <span class="t">not in</span> seen:\n            seen.add(key); rows.append(row)` } },
    ] },
  ];
  let current = 'laptop';

  /* ── routing ─────────────────────────────────────────────────── */
  const pages = $$('.page');
  function goPage(name, { push = true } = {}) {
    if (name === 'auth') { showAuth(); return; }
    auth.hidden = true; shell.hidden = false;
    pages.forEach(p => {
      const on = p.dataset.page === name;
      if (on && p.hidden) { p.hidden = false; if (!reduced()) { p.classList.remove('is-enter'); void p.offsetWidth; p.classList.add('is-enter'); } }
      else if (!on) p.hidden = true;
    });
    $$('[data-nav]').forEach(b => { if (b.closest('.sb')) b.toggleAttribute('aria-current', false); });
    $$(`.sb [data-nav="${name}"]`).forEach(b => b.setAttribute('aria-current', 'page'));
    moveInk(name);
    if (push) history.replaceState(null, '', '#' + name);
    if (phone.matches) setRail(true);
    DS.closeMenus();
    syncThemeColor();
  }
  function showAuth() { shell.hidden = true; auth.hidden = false; history.replaceState(null, '', '#auth'); syncThemeColor(); setTimeout(() => $('#a-email').focus(), 50); }
  function syncThemeColor() {
    const m = $('meta[name="theme-color"]'); if (!m) return;
    m.content = getComputedStyle(document.documentElement).getPropertyValue(auth.hidden ? '--surface' : '--surface').trim();
  }
  document.addEventListener('ds:theme', syncThemeColor);

  /* ── sidebar: rail on desktop, drawer on phones ───────────────── */
  function setRail(on) {
    shell.classList.toggle('is-rail', on);
    $('#sidebar').toggleAttribute('data-tips-off', !on || phone.matches);
    $$('[data-sb-toggle]').forEach(b => b.setAttribute('aria-expanded', String(!on)));
    if (!phone.matches) set('cloak_rd_rail', on ? '1' : '');
  }
  document.addEventListener('click', e => {
    if (e.target.closest('[data-sb-toggle]')) setRail(!shell.classList.contains('is-rail'));
    if (e.target.closest('[data-sb-close]')) setRail(true);
    const nav = e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); goPage(nav.dataset.nav); }
    if (e.target.closest('[data-action="new-chat"]')) newChat();
  });
  setRail(phone.matches || get('cloak_rd_rail') === '1');
  phone.addEventListener('change', () => setRail(phone.matches || get('cloak_rd_rail') === '1'));
  // the one marker: glides between Chat and Brain, lets go on other pages
  function moveInk(name) {
    const ink = $('#sb-ink'), btn = $(`#sb-nav [data-nav="${name}"]`);
    if (!btn) { ink.classList.add('is-off'); return; }
    ink.classList.remove('is-off');
    ink.style.setProperty('--y', btn.offsetTop + 'px');
  }

  /* ── chat list ───────────────────────────────────────────────── */
  function renderList() {
    $('#conv-list').innerHTML = CHATS.map(c => `<button class="conv" type="button" data-chat="${c.id}" ${c.id === current ? 'aria-current="true"' : ''}><span>${c.title}</span><span class="btn btn-icon" role="presentation" aria-hidden="true">${ic('dots-three')}</span></button>`).join('');
  }
  $('#conv-list').addEventListener('click', e => {
    const b = e.target.closest('[data-chat]'); if (!b) return;
    current = b.dataset.chat; renderList(); goPage('chat'); renderThread(true);
  });

  /* ── thread ──────────────────────────────────────────────────── */
  const thread = $('#thread'), page = $('#page-chat'), scroller = $('#chat-scroll');
  const actions = () => `<div class="msg-actions">
    <button class="btn btn-icon" type="button" aria-label="Copy" data-copy>${ic('copy')}</button>
    <button class="btn btn-icon" type="button" aria-label="Retry">${ic('arrow-clockwise')}</button>
    <button class="btn btn-icon" type="button" aria-label="More">${ic('dots-three')}</button></div>`;
  function userMsg(text) { return `<div class="msg msg-user"><div class="bubble">${text}</div></div>`; }
  function cloakMsg(m) {
    const search = m.search ? `<div class="search-card" data-open="false"><button type="button" aria-expanded="false">${ic('globe-simple')}Read ${SOURCES.length} sources${ic('caret-down', 'icon-caret')}</button><div class="sources"><ol>${SOURCES.map((s, i) => `<li><a class="src" id="s${i + 1}" href="#s${i + 1}"><i>${i + 1}</i><span>${s[0]}</span><small>${s[1]}</small></a></li>`).join('')}</ol></div></div>` : '';
    const build = m.build ? `<div class="build"><span class="build-ic">${ic('code')}</span><div class="grow"><b>repair-checklist.html</b><small>Page · 1 file · version 1</small></div><button class="btn btn-secondary btn-sm" type="button" data-open-build>Open</button></div>` : '';
    const code = m.code ? `<div class="code"><header><span class="grow">${m.code.name}</span><button class="btn btn-icon" type="button" aria-label="Copy code" data-copy>${ic('copy')}</button><button class="btn btn-icon" type="button" aria-label="Download">${ic('download-simple')}</button></header><pre>${m.code.body}</pre></div>` : '';
    return `<div class="msg msg-cloak"><div class="msg-head"><span class="orb" aria-hidden="true"></span><span>${m.meta}</span></div>${search}<div class="prose">${m.c}</div>${build}${code}${actions()}</div>`;
  }
  function renderThread(loading = false) {
    const chat = CHATS.find(c => c.id === current);
    page.classList.remove('is-empty');
    const paint = () => {
      thread.innerHTML = `<div class="day">Today</div>` + chat.msgs.map(m => m.u ? userMsg(m.u) : cloakMsg(m)).join('');
      scroller.scrollTop = scroller.scrollHeight;
    };
    if (loading && !reduced()) {
      // skeleton in the shape of the thread while the chat "loads"
      thread.innerHTML = `<div class="msg msg-user"><div class="skel" style="width:46%;height:44px;border-radius:20px 20px 6px 20px"></div></div>
        <div class="msg msg-cloak" style="width:100%"><div class="skel" style="width:120px;height:14px"></div><div class="skel" style="width:92%;height:14px"></div><div class="skel" style="width:84%;height:14px"></div><div class="skel" style="width:60%;height:14px"></div></div>`;
      setTimeout(paint, 450);
    } else paint();
  }
  thread.addEventListener('click', e => {
    const sb = e.target.closest('.search-card > button');
    if (sb) { const c = sb.parentElement, o = c.dataset.open !== 'true'; c.dataset.open = String(o); sb.setAttribute('aria-expanded', String(o)); }
    if (e.target.closest('[data-copy]')) DS.toast('Copied');
    if (e.target.closest('[data-open-build]')) DS.toast('Builds panel opens here in the real app', 'code');
    const cite = e.target.closest('.cite');
    if (cite) {
      e.preventDefault();
      const card = cite.closest('.msg').querySelector('.search-card');
      if (card && card.dataset.open !== 'true') card.querySelector('button').click();
    }
  });

  /* ── composer ────────────────────────────────────────────────── */
  const input = $('#input'), send = $('#send');
  let streaming = null;
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; send.disabled = !input.value.trim() && !streaming; }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!streaming && input.value.trim()) submit(); } });
  send.addEventListener('click', () => streaming ? stop() : submit());

  // the composer travels from the middle of the empty state to the bottom (FLIP)
  function leaveEmpty() {
    if (!page.classList.contains('is-empty')) return;
    const dock = $('#dock'), a = dock.getBoundingClientRect();
    page.classList.remove('is-empty');
    if (reduced()) return;
    const b = dock.getBoundingClientRect();
    dock.animate([{ translate: `0 ${a.top - b.top}px` }, { translate: '0 0' }], { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
  function submit() {
    const text = input.value.trim(); if (!text) return;
    const fresh = page.classList.contains('is-empty');
    leaveEmpty();
    if (fresh) thread.innerHTML = '<div class="day">Today</div>';
    thread.insertAdjacentHTML('beforeend', userMsg(text.replace(/</g, '&lt;')));
    input.value = ''; grow();
    const model = $('#model-name').textContent, eff = $('#effort-name').textContent;
    const wrap = document.createElement('div'); wrap.className = 'msg msg-cloak';
    wrap.innerHTML = `<div class="msg-head"><span class="orb is-working" aria-hidden="true"></span><span>Thinking</span></div><div class="prose"><p></p></div>`;
    thread.append(wrap); scroller.scrollTop = scroller.scrollHeight;
    const words = `This is a design prototype, so this reply is canned. In the live app, ${model} would answer here at ${eff.toLowerCase()} effort, streaming word by word like this.`.split(' ');
    const p = wrap.querySelector('p'), head = wrap.querySelector('.msg-head span:last-child'), orb = wrap.querySelector('.orb');
    let i = 0;
    send.classList.add('is-stop'); send.disabled = false; send.setAttribute('aria-label', 'Stop'); send.innerHTML = ic('x');
    const finish = () => {
      clearInterval(streaming); streaming = null;
      orb.classList.remove('is-working'); head.textContent = `${model} · ${eff}`;
      wrap.insertAdjacentHTML('beforeend', actions());
      send.classList.remove('is-stop'); send.setAttribute('aria-label', 'Send'); send.innerHTML = ic('arrow-up'); grow();
    };
    streaming = setTimeout(() => {
      head.textContent = 'Writing';
      streaming = setInterval(() => {
        if (i >= words.length) return finish();
        const s = document.createElement('span'); s.className = 'tk'; s.textContent = words[i++] + ' '; p.append(s);
        scroller.scrollTop = scroller.scrollHeight;
      }, reduced() ? 0 : 45);
    }, 700);
    stop.finish = finish;
  }
  function stop() { if (!streaming) return; clearTimeout(streaming); stop.finish(); DS.toast('Stopped', 'info'); }

  function newChat() {
    goPage('chat');
    current = null; renderList();
    page.classList.add('is-empty'); thread.innerHTML = '';
    input.value = ''; grow(); setTimeout(() => input.focus(), 60);
  }
  $('#greet-orb').addEventListener('click', e => { const o = e.currentTarget; o.classList.add('is-working'); setTimeout(() => o.classList.remove('is-working'), 1800); });

  /* plus menu: homework mode + attach */
  $('#hw-item').addEventListener('click', () => {
    const on = $('#hw-item').getAttribute('aria-checked') !== 'true';
    $('#hw-item').setAttribute('aria-checked', String(on));
    $('#mode-tags').innerHTML = on ? `<button class="chip is-on" type="button" id="hw-chip" aria-label="Turn off homework mode">${ic('graduation-cap')}Homework mode${ic('x')}</button>` : '';
    DS.closeMenus(); input.focus();
  });
  $('#mode-tags').addEventListener('click', e => { if (e.target.closest('#hw-chip')) $('#hw-item').click(); });
  $('#attach-item').addEventListener('click', () => { DS.closeMenus(); DS.toast('File picker opens here in the real app', 'paperclip'); });
  $('#mic-btn').addEventListener('click', () => DS.toast('Voice mode opens here in the real app', 'microphone'));

  /* ── model menu ──────────────────────────────────────────────── */
  const MODEL = { kairos: ['Kairos', '1.2'], linus: ['Linus', '1'], pneuma: ['Pneuma', '1'] };
  $$('.mm-opt').forEach(o => o.addEventListener('click', () => {
    const k = o.dataset.model;
    $$('.mm-opt').forEach(x => x.setAttribute('aria-checked', String(x === o)));
    $('#model-name').textContent = MODEL[k][0]; $('#model-ver').textContent = MODEL[k][1];
    $('#model-tier').className = 'tier tier-' + k;
    DS.closeMenus(); $('#model-btn').focus();
  }));
  $$('#model-menu .switch').forEach(s => s.addEventListener('click', e => { e.stopPropagation(); s.setAttribute('aria-checked', String(s.getAttribute('aria-checked') !== 'true')); }));

  /* ── effort popover (persists per device, like effort.js) ────── */
  const efLabels = $$('#ef-labels span');
  DS.effort($('#effort-app'), {
    value: +(get('cloak_rd_effort') || 50),
    onChange: L => {
      $('#effort-name').textContent = L.name; $('#ef-name').textContent = L.name; $('#ef-desc').textContent = L.desc;
      $('#ef-src').textContent = L.sources; $('#ef-rounds').textContent = L.rounds;
      efLabels.forEach(s => s.classList.toggle('is-on', s.textContent === L.name));
      set('cloak_rd_effort', String(L.v));
    },
  });

  /* ── brain ───────────────────────────────────────────────────── */
  const fm = (t, type, tags, imp) => `---\ntitle: ${t}\ntype: ${type}\ntags: ${tags}\nimportance: ${imp}\nupdated: 2026-10-12\nsource: auto\n---\n`;
  const MEM = [
    { path: 'MEMORY.md', lobe: '', md: '# Memory\n- [project] Kitchen renovation  project/kitchen-renovation.md\n- [fact] 2014 laptop  fact/2014-laptop.md\n- [profile] Works evenings  profile/schedule.md\n- [episode] Chose to repair the laptop  episode/laptop-repair.md\n- [preference] Short answers first  preference/short-answers.md' },
    { path: 'project/kitchen-renovation.md', lobe: 'Projects', md: fm('Kitchen renovation', 'project', '[home, budget]', '0.8') + '- Renovating a small kitchen on a fixed budget.\n- Doing the tiling themselves; hiring out electrical work.' },
    { path: 'fact/2014-laptop.md', lobe: 'Facts', md: fm('2014 laptop', 'fact', '[laptop, hardware]', '0.6') + '- Has a 13-inch laptop from 2014.\n- Battery no longer holds a charge.\n- Mostly used for writing and browsing.' },
    { path: 'profile/schedule.md', lobe: 'Profile', md: fm('Works evenings', 'profile', '[schedule]', '0.4') + '- Usually free after 9pm on weekdays.' },
    { path: 'episode/laptop-repair.md', lobe: 'Episodes', md: fm('Chose to repair the laptop', 'episode', '[laptop]', '0.5') + '- 2026-10-12: Decided to replace the battery instead of buying new.' },
    { path: 'preference/short-answers.md', lobe: 'Preferences', md: fm('Short answers first', 'preference', '[style]', '0.9') + '- Wants the short answer first, details on request.\n- Prefers metric units.' },
  ];
  let memSel = 2;
  function renderLobes() {
    let last = null, html = '';
    MEM.forEach((m, i) => {
      if (m.lobe && m.lobe !== last) { html += `<div class="lobe-h" aria-hidden="true"><span>${m.lobe}</span></div>`; last = m.lobe; }
      html += `<button class="file" type="button" role="option" aria-selected="${i === memSel}" data-mi="${i}">${ic(i ? 'file-text' : 'stack')}<span>${m.path.split('/').pop()}</span></button>`;
    });
    $('#lobes').innerHTML = html;
  }
  function openMem(i) {
    memSel = i; renderLobes();
    $('#doc-path').textContent = MEM[i].path; $('#doc-text').value = MEM[i].md; $('#doc-save').disabled = true;
    if (!reduced()) $('#doc-text').animate([{ opacity: 0, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
  $('#lobes').addEventListener('click', e => { const b = e.target.closest('[data-mi]'); if (b) openMem(+b.dataset.mi); });
  $('#doc-text').addEventListener('input', () => { $('#doc-save').disabled = false; });
  $('#doc-save').addEventListener('click', () => { MEM[memSel].md = $('#doc-text').value; $('#doc-save').disabled = true; DS.toast('Memory saved'); });
  $('#doc-del').addEventListener('click', () => {
    if (memSel === 0) { DS.toast('MEMORY.md is generated. Delete a file instead.', 'info'); return; }
    const gone = MEM.splice(memSel, 1)[0]; openMem(Math.min(memSel, MEM.length - 1)); DS.toast(`Deleted ${gone.path.split('/').pop()}`, 'trash');
  });
  $('#imp-btn').addEventListener('click', () => DS.toast('Pick a .md bundle to import', 'upload-simple'));
  $('#exp-btn').addEventListener('click', () => DS.toast('Exported MEMORY.md and 5 files', 'download-simple'));
  $('#brain-mem-switch').addEventListener('click', e => {
    const s = e.currentTarget, on = s.getAttribute('aria-checked') !== 'true';
    s.setAttribute('aria-checked', String(on));
    $('#brain-mem').style.opacity = on ? '' : '.45';
    DS.toast(on ? 'Memory on. Cloak will save and recall.' : 'Memory off. Nothing is saved or recalled.', on ? 'check' : 'info');
  });
  $$('[data-bt]').forEach(b => b.addEventListener('click', () => {
    $$('[data-bt]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    DS.placeThumb(b.parentElement);
    $('#brain-mem').hidden = b.dataset.bt !== 'mem'; $('#brain-ctx').hidden = b.dataset.bt !== 'ctx';
  }));

  /* ── settings ────────────────────────────────────────────────── */
  $$('[data-st]').forEach(b => b.addEventListener('click', () => {
    $$('[data-st]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    $$('[data-sp]').forEach(p => { p.hidden = p.dataset.sp !== b.dataset.st; if (!p.hidden && !reduced()) p.animate([{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }], { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' }); });
    $$('.set-pane:not([hidden]) .seg.has-thumb').forEach(DS.placeThumb);
  }));
  $('#s-name-save').addEventListener('click', () => { const n = $('#s-name').value.trim() || 'there'; $('#greet').textContent = `Hey there, ${n}.`; DS.toast('Name saved'); });
  $('#clear-btn').addEventListener('click', () => { CHATS.length = 0; renderList(); newChat(); DS.toast('All chats deleted. Memories kept.', 'trash'); });
  $('#signout-btn').addEventListener('click', () => showAuth());
  $('#motion-tag').textContent = reduced() ? 'Reduced' : 'Full';
  $('#pw-save').addEventListener('click', () => {
    const ok = $('#pw-new').value.length >= 8;
    $('#f-pw-new').classList.toggle('is-invalid', !ok); $('#pw-new').setAttribute('aria-invalid', String(!ok));
    if (ok) { $('#pw-cur').value = $('#pw-new').value = ''; DS.toast('Password updated', 'lock-key'); }
  });
  $('#mfa-btn').addEventListener('click', () => { $('#mfa-step').hidden = false; $('#mfa-code').focus(); });
  $('#mfa-enable').addEventListener('click', () => {
    const ok = /^\d{6}$/.test($('#mfa-code').value);
    $('#f-mfa').classList.toggle('is-invalid', !ok); $('#mfa-code').setAttribute('aria-invalid', String(!ok));
    if (ok) { $('#mfa-step').hidden = true; $('#mfa-tag').textContent = 'On'; $('#mfa-tag').classList.add('tag-acc'); $('#mfa-btn').textContent = 'Manage'; DS.toast('Two-factor on', 'lock-key'); }
  });
  const LOG = [
    ['21:14:02', 'req', 'POST /v1/chat  kairos-fast  effort 50'], ['21:14:03', 'res', '200  first token 612 ms'],
    ['21:14:09', 'res', '200  done  1,204 tokens'], ['21:16:40', 'req', 'POST /v1/chat  linus  effort 50'],
    ['21:16:41', 'err', '429  provider busy, handed to next model'], ['21:16:42', 'res', '200  first token 880 ms'],
  ];
  function renderLog(f = 'all') {
    const rows = LOG.filter(r => f === 'all' || r[1] === f);
    $('#log').innerHTML = rows.length ? rows.map(r => `<div class="log-row ${r[1]}"><span class="t">${r[0]}</span><span class="k">${r[1].toUpperCase()}</span><span>${r[2]}</span></div>`).join('') : '<div class="log-row"><span></span><span></span><span class="t">No logs yet</span></div>';
  }
  $('#log-filter').addEventListener('click', e => {
    const b = e.target.closest('[data-lf]'); if (!b) return;
    $$('[data-lf]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); DS.placeThumb($('#log-filter')); renderLog(b.dataset.lf);
  });
  $('#log-clear').addEventListener('click', () => { LOG.length = 0; renderLog(); });

  /* ── auth ────────────────────────────────────────────────────── */
  const card = $('#auth-card');
  $$('[data-auth]').forEach(b => b.addEventListener('click', () => {
    const up = b.dataset.auth === 'up';
    $$('[data-auth]').forEach(x => x.setAttribute('aria-selected', String(x === b))); DS.placeThumb(b.parentElement);
    card.classList.toggle('is-signup', up);
    $('#auth-title').textContent = up ? 'Make an account.' : 'Welcome back.';
    $('#auth-sub').textContent = up ? 'Save your chats and memories across devices.' : 'Sign in to pick up where you left off.';
    $('#auth-submit').textContent = up ? 'Create account' : 'Sign in';
    $('#a-pass').autocomplete = up ? 'new-password' : 'current-password';
    $('#auth-err').classList.remove('is-on');
  }));
  $('#pass-eye').addEventListener('click', e => {
    const b = e.currentTarget, show = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(show)); b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    b.innerHTML = ic(show ? 'eye-slash' : 'eye'); $('#a-pass').type = show ? 'text' : 'password';
  });
  card.addEventListener('submit', e => {
    e.preventDefault();
    const email = $('#a-email').value.trim(), pass = $('#a-pass').value;
    const okE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), okP = card.classList.contains('is-signup') ? pass.length >= 8 : pass.length > 0;
    $('#f-email').classList.toggle('is-invalid', !okE); $('#a-email').setAttribute('aria-invalid', String(!okE));
    $('#f-pass').classList.toggle('is-invalid', !okP); $('#a-pass').setAttribute('aria-invalid', String(!okP));
    $('#e-pass').lastChild.textContent = card.classList.contains('is-signup') ? 'Use at least 8 characters.' : 'Enter your password.';
    $('#auth-err').classList.remove('is-on');
    if (!okE || !okP) return;
    const btn = $('#auth-submit'); btn.classList.add('is-loading');
    setTimeout(() => {
      btn.classList.remove('is-loading');
      if (pass === 'wrong') { void $('#auth-err').offsetWidth; $('#auth-err').classList.add('is-on'); return; }
      goPage('chat');
    }, 900);
  });
  $('#guest-btn').addEventListener('click', () => goPage('chat'));
  $('#auth-values').addEventListener('click', e => { e.preventDefault(); goPage('values'); });

  /* ── boot ────────────────────────────────────────────────────── */
  renderList(); renderThread(); openMem(2); renderLog();
  const start = (location.hash || '#chat').slice(1);
  goPage(['chat', 'brain', 'settings', 'values', 'auth'].includes(start) ? start : 'chat', { push: false });
  if (phone.matches) setRail(true);
  addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h) goPage(h, { push: false }); });
  document.fonts && document.fonts.ready.then(() => moveInk((location.hash || '#chat').slice(1)));
})();
