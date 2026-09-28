/* ════════════════════════════════════════════════════════
   CLOAK THREAD — one continuous conversation per user
   Replaces the old per-chat list. Every message (web, Telegram, …) is a
   row in `thread_messages`; compression state lives in `threads.context`
   (see context.js). The web view loads what Cloak hasn't moved on from
   yet; above it sits the "moved on" card with a way back to the latest
   message. New rows from other platforms stream in over Realtime.
   Web messages are mirrored to a linked Telegram chat server-side
   (DB trigger → telegram-bot?relay=<id>).
   Guests: in-memory only, nothing is saved.
   ════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const LOAD_LIMIT = 300;
  const FN_URL = 'https://kdawsqrrmwirilyhcolk.supabase.co/functions/v1/telegram-bot';

  let owner = { sb: null, uid: '', guest: true };
  let channel = null;
  let localId = 0;
  let olderHidden = false;
  let ctxSaveT = 0;
  let incoming = [];
  const pendingCids = new Map(); // client_id → hist entry awaiting its row id

  const log = (t, m) => { try { if (typeof window.log === 'function') window.log(t, '[thread] ' + m); } catch (_) {} };
  const persisted = () => !!(owner.sb && owner.uid && !owner.guest);
  const cid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const box = () => document.getElementById('messages');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toEntry = (r) => ({ id: r.id, role: r.role === 'assistant' ? 'CHATBOT' : 'USER', message: r.content, at: Date.parse(r.created_at) || Date.now(), source: r.source || 'web' });

  /* ── rendering ── */
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

  /* ── load ── */
  async function init(o) {
    stop();
    owner = { sb: (o && o.sb) || null, uid: (o && o.uid) || '', guest: !(o && o.uid) || !!(o && o.guest) };
    chatId = 'thread';
    olderHidden = false;
    incoming = [];
    pendingCids.clear();
    if (!persisted()) {
      hist = [];
      if (window.CloakContext) CloakContext.reset();
      renderAll();
      return;
    }
    try {
      const { data: t } = await owner.sb.from('threads').select('context').eq('user_id', owner.uid).maybeSingle();
      if (window.CloakContext) CloakContext.load(t && t.context);
      const boundary = window.CloakContext ? CloakContext.movedOn() : 0;
      const { data, error } = await owner.sb.from('thread_messages')
        .select('id,role,content,source,created_at')
        .eq('user_id', owner.uid).gt('id', boundary)
        .order('id', { ascending: false }).limit(LOAD_LIMIT + 1);
      if (error) throw error;
      const rows = (data || []).reverse();
      if (rows.length > LOAD_LIMIT) { rows.shift(); olderHidden = true; }
      if (boundary > 0) olderHidden = true;
      hist = rows.map(toEntry);
      renderAll();
      subscribe();
      log('inf', 'loaded ' + hist.length + ' message(s)');
    } catch (e) {
      log('err', 'load failed: ' + (e.message || e));
      hist = [];
      renderAll();
    }
    refreshTelegram();
  }

  function stop() {
    if (channel && owner.sb) { try { owner.sb.removeChannel(channel); } catch (_) {} }
    channel = null;
  }

  /* ── live sync ── */
  function subscribe() {
    if (!persisted() || !owner.sb.channel) return;
    channel = owner.sb.channel('thread-' + owner.uid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'thread_messages', filter: 'user_id=eq.' + owner.uid }, (p) => onRow(p.new))
      .subscribe();
  }

  function onRow(r) {
    if (!r || r.user_id !== owner.uid) return;
    if (hist.some((m) => m.id === r.id)) return;
    if (r.client_id && pendingCids.has(r.client_id)) return; // our own insert, id arrives via its response
    if (typeof busy !== 'undefined' && busy) { incoming.push(r); return; }
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
  // Adds a message to the thread (and the DB when signed in). `el` is its bubble.
  function push(role, message, el) {
    const entry = { id: null, role, message, at: Date.now(), source: 'web' };
    const prev = hist[hist.length - 1];
    if (el && prev && prev.at) {
      const div = dividerFor(prev.at, entry.at);
      if (div && el.parentNode) el.parentNode.insertBefore(div, el);
    }
    hist.push(entry);
    bind(entry, el);
    if (!persisted()) { entry.id = ++localId; if (el) el.dataset.mid = entry.id; return entry; }
    const c = cid();
    pendingCids.set(c, entry);
    entry.saved = owner.sb.from('thread_messages')
      .insert({ user_id: owner.uid, role: role === 'CHATBOT' ? 'assistant' : 'user', content: String(message || '').slice(0, 60000), source: 'web', client_id: c })
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
    ctxSaveT = setTimeout(async () => {
      const { error } = await owner.sb.from('threads')
        .upsert({ user_id: owner.uid, context: CloakContext.get(), updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
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
      const { error } = await owner.sb.from('thread_messages').delete().eq('user_id', owner.uid).gte('id', Math.min(...ids));
      if (error) log('err', 'edit delete failed: ' + error.message);
    }
    saveContext();
  }

  async function clear() {
    hist = [];
    if (window.CloakContext) CloakContext.reset();
    olderHidden = false;
    renderAll();
    if (!persisted()) return;
    const a = await owner.sb.from('thread_messages').delete().eq('user_id', owner.uid);
    const b = await owner.sb.from('threads').upsert({ user_id: owner.uid, context: {}, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (a.error || b.error) log('err', 'clear failed: ' + ((a.error || b.error).message));
  }

  function reset() {
    stop();
    owner = { sb: null, uid: '', guest: true };
    incoming = [];
    pendingCids.clear();
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
    row.querySelector('#tg-desc').textContent = 'Continue this same conversation in Telegram. What you send here appears there as “' + who + ' said: …”, and what you send there appears here.';
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
    status.textContent = data ? 'Linked — this conversation continues in Telegram.' : 'Not linked.';
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
    if (!confirm('Unlink Telegram? That chat will stop continuing this conversation.')) return;
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
    init, reset, push, drain, saveContext, truncateAt, clear,
    jumpToLatest, refreshTelegram, placeMovedOn,
    receive: onRow,
  };
})();
