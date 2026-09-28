/* ════════════════════════════════════════════════════════
   CLOAK THREAD — multiple chats per user, synced live.
   Each chat is a row in `chats` (title, is_main, its own compressed
   context — see context.js); its messages are rows in `thread_messages`
   tagged with `chat_id`. Exactly one chat is "Main" — the one a linked
   Telegram chat continues. Switching chats swaps which one is loaded and
   which Realtime channel is live; two tabs/devices open on the same chat
   get new messages the instant they land, whichever platform sent them.
   Within one chat, the "moved on" boundary and time dividers work exactly
   as they did for the old single thread.
   Guests: in-memory only, one ephemeral chat, nothing is saved.
   ════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const LOAD_LIMIT = 300;
  const FN_URL = 'https://kdawsqrrmwirilyhcolk.supabase.co/functions/v1/telegram-bot';

  let owner = { sb: null, uid: '', guest: true };
  let channel = null;       // thread_messages realtime — the open chat only
  let listChannel = null;   // chats realtime — keeps the sidebar list in sync
  let localId = 0;
  let olderHidden = false;
  let ctxSaveT = 0;
  let incoming = [];
  const pendingCids = new Map(); // client_id → hist entry awaiting its row id

  let convs = [];        // [{id, title, isMain, updatedAt}], newest first
  let activeId = null;   // current chat id ('guest' when not signed in)
  let _convSeen = new Set();

  const log = (t, m) => { try { if (typeof window.log === 'function') window.log(t, '[thread] ' + m); } catch (_) {} };
  const persisted = () => !!(owner.sb && owner.uid && !owner.guest);
  const cid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const box = () => document.getElementById('messages');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toEntry = (r) => ({ id: r.id, role: r.role === 'assistant' ? 'CHATBOT' : 'USER', message: r.content, at: Date.parse(r.created_at) || Date.now(), source: r.source || 'web' });
  const chatBusy = () => typeof busy !== 'undefined' && busy;

  function _makeTitle(first) {
    const clean = String(first || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    const sentenceEnd = clean.search(/[.!?](?:\s|$)/);
    let candidate = sentenceEnd > 4 && sentenceEnd < 70 ? clean.slice(0, sentenceEnd + 1) : clean;
    if (candidate.length > 60) candidate = candidate.slice(0, 58).replace(/\s+\S*$/, '') + '…';
    return candidate || 'New chat';
  }

  /* ── rendering: messages ── */
  function dividerFor(prevAt, at) {
    if (!prevAt || !at || at - prevAt < (window.CloakContext ? CloakContext.PAUSE_MS : 3 * 3600e3)) return null;
    const d = document.createElement('div');
    d.className = 'thread-divider';
    d.setAttribute('role', 'separator');
    let label = '';
    try { label = new Date(at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) {}
    d.innerHTML = '<span>' + esc(label) + '</span>';
    return d;
  }

  // Renders one entry at the end of the message list.
  function render(entry, prev) {
    const b = box();
    if (!b) return null;
    const div = dividerFor(prev && prev.at, entry.at);
    if (div) b.appendChild(div);
    const el = addMsg(entry.role === 'CHATBOT' ? 'bot' : 'user', entry.message, true);
    bind(entry, el);
    if (entry.source && entry.source !== 'web') {
      const tag = document.createElement('div');
      tag.className = 'msg-src';
      tag.textContent = 'via ' + (entry.source === 'telegram' ? 'Telegram' : entry.source);
      const bubble = el.querySelector('.bubble');
      if (bubble) bubble.insertAdjacentElement('afterend', tag);
      else (el.querySelector('.bot-body') || el).appendChild(tag);
    }
    return el;
  }

  function bind(entry, el) {
    if (!el) return;
    entry.el = el;
    el._entry = entry;
    if (entry.id != null) el.dataset.mid = entry.id;
  }

  function movedOnCard() {
    let c = document.getElementById('moved-on');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'moved-on';
    c.className = 'moved-on';
    c.setAttribute('role', 'note');
    c.innerHTML =
      '<div class="moved-on-mark" aria-hidden="true"></div>' +
      '<div class="moved-on-title">Cloak has moved on from these chats.</div>' +
      '<div class="moved-on-sub">Important memories have been saved.</div>' +
      '<div class="moved-on-actions">' +
      '<button type="button" class="moved-on-btn">Return to most recent chat</button>' +
      '<button type="button" class="moved-on-link">See memories</button>' +
      '</div>';
    c.querySelector('.moved-on-btn').addEventListener('click', jumpToLatest);
    c.querySelector('.moved-on-link').addEventListener('click', () => { if (window.CloakBrain) CloakBrain.open(); });
    return c;
  }

  // Places the card above the first message Cloak hasn't moved on from and
  // dims anything still on screen from before it.
  function placeMovedOn() {
    const b = box();
    if (!b) return;
    const boundary = window.CloakContext ? CloakContext.movedOn() : 0;
    const past = hist.filter((m) => m.id != null && m.id <= boundary);
    const existing = document.getElementById('moved-on');
    if (!olderHidden && !past.length) { if (existing) existing.remove(); return; }
    const card = movedOnCard();
    past.forEach((m) => m.el && m.el.classList.add('moved-on-past'));
    const firstLive = hist.find((m) => !(m.id != null && m.id <= boundary) && m.el && m.el.parentNode === b);
    if (firstLive) {
      // Keep any time divider directly above the first live message with it.
      const anchor = firstLive.el.previousElementSibling && firstLive.el.previousElementSibling.classList.contains('thread-divider') ? firstLive.el.previousElementSibling : firstLive.el;
      b.insertBefore(card, anchor);
    } else if (!card.parentNode) b.insertBefore(card, b.firstChild);
  }

  function jumpToLatest() {
    const ca = document.getElementById('chat-area');
    if (!ca) return;
    try { ca.scrollTo({ top: ca.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
    catch (_) { ca.scrollTop = ca.scrollHeight; }
    const inp = document.getElementById('chat-input');
    if (inp) setTimeout(() => inp.focus({ preventScroll: true }), 350);
  }

  function renderAll() {
    const b = box();
    if (!b) return;
    b.innerHTML = '';
    hist.forEach((m, i) => render(m, hist[i - 1]));
    placeMovedOn();
    if (hist.length) {
      showMessages();
      if (typeof trimToLatest === 'function') trimToLatest(false);
      requestAnimationFrame(() => { const ca = document.getElementById('chat-area'); if (ca) ca.scrollTop = ca.scrollHeight; });
    } else {
      b.style.display = 'none';
      const es = document.getElementById('empty-state');
      if (es) es.style.display = 'flex';
    }
  }

  /* ── rendering: chat list ── */
  function renderConvs() {
    const list = document.getElementById('conv-list');
    if (!list) return;
    list.innerHTML = '';
    const first = !_convSeen.size;
    let k = 0;
    convs.forEach((c) => {
      const d = document.createElement('div');
      d.className = 'conv-item' + (c.id === activeId ? ' active' : '');
      d.dataset.id = c.id;
      if (!_convSeen.has(c.id)) { d.classList.add('conv-in'); d.style.setProperty('--k', first ? Math.min(k++, 12) : 0); }
      const lbl = document.createElement('div');
      lbl.className = 'conv-label';
      lbl.innerHTML = '<svg class="conv-icon" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>' + esc(c.title) + (c.isMain ? ' · Main' : '') + '</span>';
      lbl.title = c.title + (c.isMain ? ' (Main — linked to Telegram)' : '');
      lbl.onclick = () => { if (chatBusy()) return; switchTo(c.id); if (typeof closeMobileSidebar === 'function') closeMobileSidebar(); };
      const del = document.createElement('button');
      del.className = 'conv-del';
      del.type = 'button';
      del.title = 'Delete';
      del.setAttribute('aria-label', 'Delete chat');
      del.innerHTML = '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
      del.onclick = (e) => { e.stopPropagation(); if (!chatBusy()) removeChat(c.id); };
      d.appendChild(lbl);
      d.appendChild(del);
      list.appendChild(d);
    });
    _convSeen = new Set(convs.map((c) => c.id));
  }

  /* ── load ── */
  async function init(o) {
    stop();
    owner = { sb: (o && o.sb) || null, uid: (o && o.uid) || '', guest: !(o && o.uid) || !!(o && o.guest) };
    olderHidden = false;
    incoming = [];
    pendingCids.clear();
    _convSeen = new Set();
    if (!persisted()) {
      convs = [];
      activeId = 'guest';
      chatId = 'guest';
      hist = [];
      if (window.CloakContext) CloakContext.reset();
      renderConvs();
      renderAll();
      return;
    }
    try {
      await loadList();
      let target = convs.find((c) => c.isMain) || convs[0];
      if (!target) target = await createChat('Main chat', true);
      if (target) { await switchTo(target.id); subscribeList(); }
      log('inf', 'loaded ' + convs.length + ' chat(s)');
    } catch (e) {
      log('err', 'load failed: ' + (e.message || e));
      convs = [];
      hist = [];
      renderConvs();
      renderAll();
    }
    refreshTelegram();
  }

  async function loadList() {
    const { data, error } = await owner.sb.from('chats').select('id,title,is_main,updated_at').eq('user_id', owner.uid).order('updated_at', { ascending: false });
    if (error) throw error;
    convs = (data || []).map((r) => ({ id: r.id, title: r.title, isMain: r.is_main, updatedAt: r.updated_at }));
    renderConvs();
  }

  async function createChat(title, isMain) {
    const { data, error } = await owner.sb.from('chats').insert({ user_id: owner.uid, title: title || 'New chat', is_main: !!isMain }).select('id,title,is_main,updated_at').single();
    if (error) { log('err', 'create chat failed: ' + error.message); return null; }
    const c = { id: data.id, title: data.title, isMain: data.is_main, updatedAt: data.updated_at };
    convs.unshift(c);
    renderConvs();
    return c;
  }

  function stop() { stopMessages(); stopList(); }
  function stopMessages() {
    if (channel && owner.sb) { try { owner.sb.removeChannel(channel); } catch (_) {} }
    channel = null;
  }
  function stopList() {
    if (listChannel && owner.sb) { try { owner.sb.removeChannel(listChannel); } catch (_) {} }
    listChannel = null;
  }

  /* ── switching chats ── */
  async function switchTo(id) {
    if (id === activeId) return;
    stopMessages();
    activeId = id;
    chatId = id;
    olderHidden = false;
    incoming = [];
    pendingCids.clear();
    renderConvs();
    if (!persisted()) { hist = []; if (window.CloakContext) CloakContext.reset(); renderAll(); return; }
    try {
      const { data: c } = await owner.sb.from('chats').select('context').eq('id', id).maybeSingle();
      if (window.CloakContext) CloakContext.load(c && c.context);
      const boundary = window.CloakContext ? CloakContext.movedOn() : 0;
      const { data, error } = await owner.sb.from('thread_messages')
        .select('id,role,content,source,created_at')
        .eq('chat_id', id).gt('id', boundary)
        .order('id', { ascending: false }).limit(LOAD_LIMIT + 1);
      if (error) throw error;
      const rows = (data || []).reverse();
      if (rows.length > LOAD_LIMIT) { rows.shift(); olderHidden = true; }
      if (boundary > 0) olderHidden = true;
      hist = rows.map(toEntry);
      renderAll();
      subscribeMessages(id);
    } catch (e) {
      log('err', 'switch failed: ' + (e.message || e));
      hist = [];
      renderAll();
    }
  }

  async function newChat() {
    if (chatBusy()) return;
    if (window.CloakMemory) CloakMemory.flush();
    if (!persisted()) { activeId = 'guest'; chatId = 'guest'; hist = []; if (window.CloakContext) CloakContext.reset(); renderAll(); return; }
    const c = await createChat('New chat', false);
    if (c) await switchTo(c.id);
  }

  async function removeChat(id) {
    const row = document.querySelector('.conv-item[data-id="' + CSS.escape(String(id)) + '"]');
    if (row && row.animate && !(window.CloakMotion && CloakMotion.reduced())) {
      row.style.pointerEvents = 'none'; row.style.overflow = 'hidden';
      row.animate([{ opacity: 1, transform: 'none', height: row.offsetHeight + 'px' }, { opacity: 0, transform: 'translateX(-16px)', height: '0px' }], { duration: 260, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
    }
    const { error } = await owner.sb.from('chats').delete().eq('id', id).eq('user_id', owner.uid);
    if (error) { log('err', 'delete failed: ' + error.message); renderConvs(); return; }
    convs = convs.filter((c) => c.id !== id);
    if (id === activeId) {
      let next = convs.find((c) => c.isMain) || convs[0];
      if (!next) next = await createChat('Main chat', true);
      activeId = null; // force switchTo to actually reload
      if (next) await switchTo(next.id);
    } else renderConvs();
  }

  async function clearAll() {
    stopMessages();
    hist = [];
    if (window.CloakContext) CloakContext.reset();
    olderHidden = false;
    if (!persisted()) { renderAll(); return; }
    const { error } = await owner.sb.from('chats').delete().eq('user_id', owner.uid);
    if (error) log('err', 'clear failed: ' + error.message);
    convs = [];
    activeId = null;
    const main = await createChat('Main chat', true);
    if (main) await switchTo(main.id);
  }

  /* ── live sync ── */
  function subscribeMessages(id) {
    if (!persisted() || !owner.sb.channel) return;
    channel = owner.sb.channel('chat-' + id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'thread_messages', filter: 'chat_id=eq.' + id }, (p) => onRow(p.new))
      .subscribe();
  }

  function subscribeList() {
    if (!persisted() || !owner.sb.channel) return;
    listChannel = owner.sb.channel('chats-' + owner.uid)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chats', filter: 'user_id=eq.' + owner.uid }, onListChange)
      .subscribe();
  }

  // Keeps the sidebar (title/order/Main flag) in sync with other tabs and
  // devices. Doesn't touch the open chat's messages or context — those are
  // handled by the per-chat channel and by CloakContext's own staleness checks.
  function onListChange(p) {
    if (p.eventType === 'DELETE') {
      const id = p.old && p.old.id;
      if (id == null) return;
      const had = convs.some((c) => c.id === id);
      convs = convs.filter((c) => c.id !== id);
      if (had) renderConvs();
      if (id === activeId) {
        const next = convs.find((c) => c.isMain) || convs[0];
        activeId = null;
        if (next) switchTo(next.id); else createChat('Main chat', true).then((c) => c && switchTo(c.id));
      }
      return;
    }
    const r = p.new;
    if (!r) return;
    const idx = convs.findIndex((c) => c.id === r.id);
    const c = { id: r.id, title: r.title, isMain: r.is_main, updatedAt: r.updated_at };
    if (idx === -1) convs.unshift(c); else convs[idx] = c;
    convs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    renderConvs();
  }

  function onRow(r) {
    if (!r || r.chat_id !== activeId) return;
    if (hist.some((m) => m.id === r.id)) return;
    if (r.client_id && pendingCids.has(r.client_id)) return; // our own insert, id arrives via its response
    if (chatBusy()) { incoming.push(r); return; }
    appendRemote(r);
  }

  function appendRemote(r) {
    const entry = toEntry(r);
    const prev = hist[hist.length - 1];
    hist.push(entry);
    const es = document.getElementById('empty-state');
    if (es) es.style.display = 'none';
    showMessages();
    render(entry, prev);
    if (typeof scrollBottom === 'function') scrollBottom();
  }

  // Called when a web turn finishes: show anything that arrived meanwhile.
  function drain() {
    const q = incoming.sort((a, b) => a.id - b.id);
    incoming = [];
    q.forEach((r) => { if (!hist.some((m) => m.id === r.id)) appendRemote(r); });
  }

  /* ── writes ── */
  function titleFromFirst(message) {
    const conv = convs.find((c) => c.id === activeId);
    if (!conv || conv.title !== 'New chat') return;
    conv.title = _makeTitle(message);
    renderConvs();
    owner.sb.from('chats').update({ title: conv.title }).eq('id', activeId)
      .then(({ error }) => { if (error) log('err', 'title save failed: ' + error.message); });
  }

  // Adds a message to the active chat (and the DB when signed in). `el` is its bubble.
  function push(role, message, el) {
    const entry = { id: null, role, message, at: Date.now(), source: 'web' };
    const prev = hist[hist.length - 1];
    if (el && prev && prev.at) {
      const div = dividerFor(prev.at, entry.at);
      if (div && el.parentNode) el.parentNode.insertBefore(div, el);
    }
    const isFirst = hist.length === 0 && role === 'USER';
    hist.push(entry);
    bind(entry, el);
    if (isFirst && persisted()) titleFromFirst(message);
    if (!persisted()) { entry.id = ++localId; if (el) el.dataset.mid = entry.id; return entry; }
    const c = cid();
    const forChat = activeId;
    pendingCids.set(c, entry);
    entry.saved = owner.sb.from('thread_messages')
      .insert({ user_id: owner.uid, chat_id: forChat, role: role === 'CHATBOT' ? 'assistant' : 'user', content: String(message || '').slice(0, 60000), source: 'web', client_id: c })
      .select('id,created_at').single()
      .then(({ data, error }) => {
        pendingCids.delete(c);
        if (error) throw error;
        entry.id = data.id;
        entry.at = Date.parse(data.created_at) || entry.at;
        if (entry.el) entry.el.dataset.mid = entry.id;
        return entry;
      })
      .catch((e) => { pendingCids.delete(c); log('err', 'save failed: ' + (e.message || e)); return entry; });
    return entry;
  }

  function saveContext() {
    if (!persisted() || !window.CloakContext) return;
    clearTimeout(ctxSaveT);
    const forChat = activeId;
    ctxSaveT = setTimeout(async () => {
      const { error } = await owner.sb.from('chats').update({ context: CloakContext.get() }).eq('id', forChat);
      if (error) log('err', 'context save failed: ' + error.message);
    }, 700);
  }

  // Edit: drop this entry and everything after it (locally and in the DB).
  async function truncateAt(entry) {
    const i = hist.indexOf(entry);
    if (i === -1) return;
    const removed = hist.slice(i);
    hist = hist.slice(0, i);
    const saved = await Promise.all(removed.map((m) => m.saved || m));
    const ids = saved.map((m) => m.id).filter((id) => id != null);
    if (ids.length && window.CloakContext) CloakContext.truncateFrom(Math.min(...ids));
    if (persisted() && ids.length) {
      const { error } = await owner.sb.from('thread_messages').delete().eq('chat_id', activeId).gte('id', Math.min(...ids));
      if (error) log('err', 'edit delete failed: ' + error.message);
    }
    saveContext();
  }

  function reset() {
    stop();
    owner = { sb: null, uid: '', guest: true };
    incoming = [];
    pendingCids.clear();
    convs = [];
    activeId = null;
    _convSeen = new Set();
  }

  /* ── Telegram link (Settings → Account) ── */
  function telegramRow() {
    let row = document.getElementById('tg-row');
    if (row) return row;
    const pane = document.getElementById('spane-general');
    if (!pane) return null;
    row = document.createElement('div');
    row.className = 'srow';
    row.id = 'tg-row';
    row.innerHTML =
      '<div class="srow-name">Telegram</div>' +
      '<div class="srow-desc" id="tg-desc"></div>' +
      '<div class="tg-actions"><span class="tg-status" id="tg-status">Checking…</span>' +
      '<button class="cta" type="button" id="tg-link">Link Telegram</button>' +
      '<button class="danger" type="button" id="tg-unlink" hidden>Unlink</button></div>' +
      '<div class="err-msg" id="tg-err"></div>';
    const anchor = pane.children[2] || null; // after Account + Display name
    pane.insertBefore(row, anchor);
    row.querySelector('#tg-link').addEventListener('click', linkTelegram);
    row.querySelector('#tg-unlink').addEventListener('click', unlinkTelegram);
    return row;
  }

  async function refreshTelegram() {
    const row = telegramRow();
    if (!row) return;
    const who = (typeof name === 'string' && name.trim() ? name.trim().split(/\s+/)[0] : 'You');
    row.querySelector('#tg-desc').textContent = 'Continue your Main chat in Telegram. What you send here appears there as “' + who + ' said: …”, and what you send there appears here.';
    const status = row.querySelector('#tg-status');
    const linkBtn = row.querySelector('#tg-link');
    const unlinkBtn = row.querySelector('#tg-unlink');
    if (!persisted()) {
      status.textContent = 'Sign in to link Telegram.';
      linkBtn.hidden = true;
      unlinkBtn.hidden = true;
      return;
    }
    const { data, error } = await owner.sb.from('telegram_links').select('chat_id,linked_at').eq('user_id', owner.uid).maybeSingle();
    if (error) { status.textContent = 'Telegram status unavailable.'; return; }
    status.textContent = data ? 'Linked — your Main chat continues in Telegram.' : 'Not linked.';
    linkBtn.hidden = !!data;
    unlinkBtn.hidden = !data;
  }

  async function linkTelegram() {
    const err = document.getElementById('tg-err');
    if (err) { err.textContent = ''; err.classList.remove('show'); }
    try {
      const { data: { session } } = await owner.sb.auth.getSession();
      if (!session) throw new Error('Sign in again to link Telegram.');
      const res = await fetch(FN_URL + '?action=link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token, apikey: SB_KEY },
        body: '{}',
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.url) throw new Error(d.error || 'Could not start linking (' + res.status + ')');
      window.open(d.url, '_blank', 'noopener');
      const status = document.getElementById('tg-status');
      if (status) status.textContent = 'Tap Start in Telegram to finish linking…';
      // Pick up the link once the user comes back.
      const again = () => { if (!document.hidden) { refreshTelegram(); document.removeEventListener('visibilitychange', again); } };
      document.addEventListener('visibilitychange', again);
      setTimeout(refreshTelegram, 15000);
    } catch (e) {
      if (err) { err.textContent = e.message; err.classList.add('show'); }
    }
  }

  async function unlinkTelegram() {
    if (!confirm('Unlink Telegram? Your Main chat will stop continuing there.')) return;
    const { error } = await owner.sb.from('telegram_links').delete().eq('user_id', owner.uid);
    if (error) log('err', 'unlink failed: ' + error.message);
    refreshTelegram();
  }

  if (window.CloakContext) {
    CloakContext.on('change', (d) => {
      if (!d || !/^(compress|merge|truncate)$/.test(d.source)) return;
      saveContext();
      if (d.source === 'merge') placeMovedOn();
    });
  }

  window.CloakThread = {
    init, reset, push, drain, saveContext, truncateAt, clearAll,
    newChat, switchTo, removeChat, list: () => convs.slice(),
    jumpToLatest, refreshTelegram, placeMovedOn,
    receive: onRow,
  };
})();
