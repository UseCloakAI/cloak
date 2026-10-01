/* ════════════════════════════════════════════════════════
   CLOAK CONTEXT — budgeted context window + chunked compression
   for the single, continuous Cloak thread.

   Each request gets a token budget sized so the Cloak prompt + app
   prompt + this budget + the reply stays under the tier's first
   provider's free-tier tokens-per-minute cap. Inside it:

     [memory]  recalled notes (CloakMemory)
     [digest]  summary-of-summaries: everything Cloak has "moved on" from
     [chunks]  per-conversation summaries (≈2.4k tokens of chat each, ~9:1)
     [gap]     local abbreviation of turns not yet summarised (free)
     [live]    the most recent turns verbatim

   The thread is split into conversation chunks: a chunk ends at a real
   pause (≥ 3 h between messages) or when it reaches ~2.4k tokens. An
   earlier conversation is compressed as soon as a new one starts; within
   a conversation, compression starts once history outgrows the budget.
   Compressing a chunk also extracts its memories (one utility call does
   both). When chunk summaries pile up they are merged into the digest —
   the thread's "moved on" boundary.

   State lives on `chats.context` (one row per chat) as
     { v:2, chunks:[{s,e,sum,tok,n,from,to}], digest:{e,sum,tok,n}|null }
   where s/e are thread message ids (inclusive) and from/to timestamps.
   ════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const API = 'https://api.usecloak.org';

  // total = tokens for memory + summaries + recent turns + the new message.
  const BUDGETS = {
    pneuma: { total: 5200, memory: 420, summary: 900, keep: 4 },
    logos: { total: 5200, memory: 420, summary: 900, keep: 4 },
    kairos: { total: 9000, memory: 700, summary: 1600, keep: 6 },
    linus: { total: 11000, memory: 520, summary: 1400, keep: 6 },
  };
  const CHUNK_TOKENS = 2400;   // target raw size of one compressed chunk
  const CHUNK_MAX = 14;        // messages per chunk at most
  const MERGE_AT = 5;          // chunk summaries before folding into the digest
  const GAP_BUDGET = 600;      // cap for the local abbreviation of unsummarised turns
  const OLD_MSG_CAP = 1400;    // older verbatim messages are clipped to this
  const COMPRESS_AT = 0.8;     // compress once history exceeds this share of the budget
  const PAUSE_MS = 3 * 3600e3; // a pause this long starts a new conversation chunk
  const RETRY_MS = 60000;

  const est = (s) => (s ? Math.ceil(String(s).length / 3.6) : 0);
  const budgetFor = (model) => BUDGETS[model] || BUDGETS.pneuma;
  const listeners = {};
  let ctx = empty();
  let epoch = 0;
  let busy = false;
  let retryAt = 0;
  let lastPlan = null;
  let calls = 0;

  function empty() { return { v: 2, chunks: [], digest: null }; }
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, data) { (listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
  const log = (t, m) => { try { if (typeof window.log === 'function') window.log(t, '[context] ' + m); } catch (_) {} };

  function valid(o) {
    if (!o || o.v !== 2 || !Array.isArray(o.chunks)) return false;
    if (o.digest && (typeof o.digest.sum !== 'string' || !(o.digest.e > 0))) return false;
    let at = o.digest ? o.digest.e : 0;
    for (const c of o.chunks) {
      if (typeof c.sum !== 'string' || !(c.s > at) || !(c.e >= c.s)) return false;
      at = c.e;
    }
    return true;
  }

  function load(o) {
    epoch++;
    ctx = valid(o) ? JSON.parse(JSON.stringify(o)) : empty();
    lastPlan = null;
    emit('change', { source: 'load' });
  }
  function reset() { load(null); emit('plan', null); }
  function get() { return ctx; }
  // Last message id summarised (chunks or digest); 0 = none.
  function covered() {
    if (ctx.chunks.length) return ctx.chunks[ctx.chunks.length - 1].e;
    return ctx.digest ? ctx.digest.e : 0;
  }
  // Last message id Cloak has "moved on" from (folded into the digest).
  function movedOn() { return ctx.digest ? ctx.digest.e : 0; }
  const isCovered = (m, cov) => m.id != null && m.id <= cov;

  // Messages from `id` on were removed (edit): drop summaries that covered them.
  function truncateFrom(id) {
    const before = JSON.stringify(ctx);
    if (ctx.digest && ctx.digest.e >= id) ctx = empty();
    else ctx.chunks = ctx.chunks.filter((c) => c.e < id);
    if (JSON.stringify(ctx) !== before) { epoch++; emit('change', { source: 'truncate' }); }
  }

  function clip(s, maxTok) {
    const max = Math.floor(maxTok * 3.6);
    if (s.length <= max) return s;
    const head = Math.floor(max * 0.65);
    const tail = max - head - 30;
    return s.slice(0, head) + '\n…[trimmed]…\n' + s.slice(-tail);
  }

  // Free local abbreviation: first sentence-ish of each turn, code collapsed.
  function gist(msgs, budgetTok) {
    if (!msgs.length) return '';
    const per = Math.max(60, Math.min(280, Math.floor((budgetTok * 3.6) / msgs.length)));
    const lines = msgs.map((m) => {
      const who = m.role === 'CHATBOT' ? 'Cloak' : 'User';
      let t = String(m.message || '').replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim();
      if (t.length > per) {
        const cut = t.slice(0, per);
        const stop = cut.search(/[.!?](?=\s|$)[^.!?]*$/);
        t = (stop > per * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '')) + '…';
      }
      return '- ' + who + ': ' + t;
    });
    let out = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = est(lines[i]);
      if (used + t > budgetTok) break;
      out.unshift(lines[i]);
      used += t;
    }
    if (out.length < lines.length) out.unshift('- (' + (lines.length - out.length) + ' earlier turns omitted)');
    return out.join('\n');
  }

  const when = (ms) => {
    try { return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch (_) { return ''; }
  };
  function summaryText() {
    const parts = [];
    if (ctx.digest) parts.push('Earlier conversations (digest):\n' + ctx.digest.sum);
    ctx.chunks.forEach((c) => parts.push('Conversation' + (c.from ? ' from ' + when(c.from) : '') + ':\n' + c.sum));
    return parts.join('\n\n');
  }

  // hist: [{id?, role:'USER'|'CHATBOT', message, at?}] with the new user message last.
  // Returns { messages (API format), system (summary block), plan }.
  function build(o) {
    const hist = o.hist || [];
    const model = o.model || 'pneuma';
    const B = budgetFor(model);
    const n = hist.length;
    const cov = covered();
    let first = hist.findIndex((m) => !isCovered(m, cov));
    if (first === -1 || first > n - 1) first = Math.max(0, n - 1);
    const sums = summaryText();
    const sumTok = est(sums);
    const memTok = est(o.memory || '');
    const avail = Math.max(800, B.total - memTok - sumTok);

    const live = [];
    let liveTok = 0;
    for (let i = n - 1; i >= first; i--) {
      const mustKeep = n - 1 - i < 2; // the new message and the reply it follows
      let content = String(hist[i].message || '');
      let t = est(content) + 4;
      if (!mustKeep && t > OLD_MSG_CAP) { content = clip(content, OLD_MSG_CAP); t = est(content) + 4; }
      if (!mustKeep && liveTok + t > avail) break;
      live.unshift({ role: hist[i].role === 'CHATBOT' ? 'assistant' : 'user', content, i });
      liveTok += t;
    }
    // Lead with a user turn (some providers reject a leading assistant turn).
    while (live.length > 1 && live[0].role === 'assistant') { liveTok -= est(live[0].content) + 4; live.shift(); }
    const liveStart = live.length ? live[0].i : n;

    const gapMsgs = hist.slice(first, liveStart);
    const gap = gapMsgs.length ? gist(gapMsgs, Math.min(GAP_BUDGET, Math.max(150, avail - liveTok))) : '';
    const gapTok = est(gap);

    let system = '';
    if (sums || gap) {
      system = '## CONVERSATION SO FAR (compressed)\nYou and the user share one continuous conversation. The messages shown are the most recent; these are compressed notes of what came before — treat them as things that were actually said.\n' +
        (sums ? '\n' + sums + '\n' : '') +
        (gap ? '\nMore recent earlier turns (abbreviated):\n' + gap + '\n' : '');
    }

    const dEnd = ctx.digest ? hist.filter((m) => isCovered(m, ctx.digest.e)).length : 0;
    lastPlan = {
      model,
      budget: B.total,
      memory: memTok,
      summary: sumTok,
      gap: gapTok,
      live: liveTok,
      used: memTok + sumTok + gapTok + liveTok,
      total: n,
      liveCount: live.length,
      gapCount: gapMsgs.length,
      covered: first,          // positions within the loaded history (for the Brain strip)
      digestEnd: dEnd,
      chunks: ctx.chunks.map((c) => ({ s: c.s, e: c.e, tok: c.tok, n: c.n })),
      digest: ctx.digest ? { e: ctx.digest.e, tok: ctx.digest.tok, n: ctx.digest.n || 1 } : null,
      at: Date.now(),
    };
    emit('plan', lastPlan);
    return { messages: live.map((m) => ({ role: m.role, content: m.content })), system, plan: lastPlan };
  }

  async function post(path, body) {
    calls++;
    const res = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error) throw new Error(d.error || 'HTTP ' + res.status);
    return d;
  }

  // Picks the next range to compress, or null. A finished earlier conversation
  // (followed by a pause) is always compressed; otherwise only when over budget.
  function nextChunk(hist, B) {
    const n = hist.length;
    const cov = covered();
    const first = hist.findIndex((m) => !isCovered(m, cov));
    if (first === -1) return null;

    // Recent turns stay verbatim: at least `keep`, up to ~55% of the budget.
    let keepFrom = n;
    let keepTok = 0;
    for (let i = n - 1; i >= first; i--) {
      const t = est(hist[i].message) + 4;
      if (n - i > B.keep && keepTok + t > B.total * 0.55) break;
      keepTok += t;
      keepFrom = i;
    }
    // Only messages that already have server ids can be summarised.
    let firstNoId = n;
    for (let i = first; i < n; i++) if (hist[i].id == null) { firstNoId = i; break; }

    // The latest pause marks where the current conversation began; everything
    // unsummarised before it belongs to an earlier, finished conversation.
    let pauseAt = -1;
    for (let i = n - 1; i > first; i--) {
      if (hist[i].at && hist[i - 1].at && hist[i].at - hist[i - 1].at >= PAUSE_MS) { pauseAt = i; break; }
    }
    let pendTok = 0;
    for (let i = first; i < n; i++) pendTok += est(hist[i].message) + 4;
    const overBudget = pendTok + est(summaryText()) > B.total * COMPRESS_AT;
    // Over budget: everything older than the verbatim tail. Otherwise only a
    // finished earlier conversation (everything before the latest pause).
    const limit = Math.min(firstNoId, overBudget ? keepFrom : pauseAt === -1 ? -1 : pauseAt);
    if (limit - first < (overBudget ? 2 : 4)) return null;

    let e = first;
    let t = 0;
    while (e < limit && e - first < CHUNK_MAX && t < CHUNK_TOKENS) {
      if (e > first + 1 && hist[e].at && hist[e - 1].at && hist[e].at - hist[e - 1].at >= PAUSE_MS) break; // end at a pause
      t += est(hist[e].message) + 4;
      e++;
    }
    if (e - first >= 3 && hist[e - 1].role === 'USER' && !(hist[e] && hist[e].at && hist[e - 1].at && hist[e].at - hist[e - 1].at >= PAUSE_MS)) e--; // end on a reply
    if (e - first < 2) return null;
    return { from: first, to: e, tok: t };
  }

  // Runs after a reply. At most one chunk (plus an optional merge) per call.
  async function maybeCompress(o) {
    if (busy || Date.now() < retryAt) return false;
    const hist = o.hist || [];
    const B = budgetFor(o.model);
    const pick = nextChunk(hist, B);
    if (!pick) return mergeIfNeeded(B);

    const slice = hist.slice(pick.from, pick.to);
    const s = slice[0].id;
    const e = slice[slice.length - 1].id;
    busy = true;
    const myEpoch = epoch;
    const covBefore = covered();
    emit('compressing', { s, e, count: slice.length });
    try {
      const words = Math.max(60, Math.min(200, Math.round(pick.tok / 10))); // ≈9:1 in tokens
      const msgs = slice.map((m) => ({ role: m.role === 'CHATBOT' ? 'assistant' : 'user', content: String(m.message || '').slice(0, 6000) }));
      const M = window.CloakMemory;
      const body = { mode: 'chunk', words, messages: msgs };
      // Save what matters from this conversation before it leaves verbatim context.
      if (M && M.enabled()) body.memory = { existing: M.related(slice.map((m) => m.message).join('\n'), 14), today: new Date().toISOString().slice(0, 10) };
      const d = await post('/v1/context/compress', body);
      if (myEpoch !== epoch || covered() !== covBefore) return false; // thread changed underneath us
      ctx.chunks.push({ s, e, sum: d.summary, tok: est(d.summary), n: slice.length, from: slice[0].at || null, to: slice[slice.length - 1].at || null });
      if (M && Array.isArray(d.ops) && d.ops.length) M.applyOps(d.ops.map((op) => Object.assign({}, op, { source: 'auto' })), 'auto');
      emit('change', { source: 'compress', s, e });
      emit('compressed', { s, e, count: slice.length, tok: est(d.summary), from: pick.tok, ops: (d.ops || []).length });
      log('inf', 'compressed ' + slice.length + ' msgs ' + pick.tok + '→' + est(d.summary) + ' tok, ' + (d.ops || []).length + ' memory op(s)');
      await mergeIfNeeded(B, true);
      return true;
    } catch (err) {
      retryAt = Date.now() + RETRY_MS;
      emit('compressed', { s, e, error: err.message });
      log('err', 'compress failed: ' + err.message);
      return false;
    } finally {
      busy = false;
    }
  }

  async function mergeIfNeeded(B, holding) {
    const chunkTok = ctx.chunks.reduce((a, c) => a + c.tok, 0);
    if (ctx.chunks.length < MERGE_AT && chunkTok <= B.summary) return false;
    if (ctx.chunks.length < 2 && !ctx.digest) return false;
    if (busy && !holding) return false;
    const take = ctx.chunks.slice(0, Math.max(1, ctx.chunks.length - 2));
    const sources = (ctx.digest ? [ctx.digest.sum] : []).concat(take.map((c) => c.sum));
    if (sources.length < 2) return false;
    busy = true;
    const myEpoch = epoch;
    emit('compressing', { merge: true, e: take[take.length - 1].e });
    try {
      const words = Math.max(80, Math.min(320, Math.round(B.summary * 0.45)));
      const d = await post('/v1/context/compress', { mode: 'merge', words, summaries: sources });
      if (myEpoch !== epoch || ctx.chunks[0] !== take[0]) return false;
      const e = take[take.length - 1].e;
      ctx.digest = { e, sum: d.summary, tok: est(d.summary), n: (ctx.digest ? ctx.digest.n || 1 : 0) + take.length };
      ctx.chunks = ctx.chunks.slice(take.length);
      emit('change', { source: 'merge', e });
      emit('compressed', { merge: true, e, tok: ctx.digest.tok });
      log('inf', 'merged ' + take.length + ' chunk(s) into digest');
      return true;
    } catch (err) {
      retryAt = Date.now() + RETRY_MS;
      log('err', 'merge failed: ' + err.message);
      return false;
    } finally {
      if (!holding) busy = false;
    }
  }

  window.CloakContext = {
    BUDGETS,
    PAUSE_MS,
    est,
    load, reset, get, truncateFrom, covered, movedOn,
    build, maybeCompress,
    lastPlan: () => lastPlan,
    busy: () => busy,
    calls: () => calls,
    summaryText,
    on,
  };
})();
