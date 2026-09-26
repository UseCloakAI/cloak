/* ════════════════════════════════════════════════════════
   CLOAK CONTEXT — budgeted context window + chunked compression

   Each request gets a token budget sized so persona + app prompt +
   this budget + the reply stays under the tier's first provider's
   free-tier tokens-per-minute cap. Inside it:

     [memory]  recalled notes (CloakMemory)
     [digest]  summary-of-summaries for the oldest part of the chat
     [chunks]  per-chunk summaries (≈2.4k tokens of chat each, ~9:1)
     [gap]     local abbreviation of turns not yet summarised (free)
     [live]    the most recent turns verbatim

   Compression only runs once a chat outgrows its budget, one chunk at a
   time, in the background after a reply, on the cheap utility tier
   (/v1/context/compress). When chunk summaries pile up they are merged
   into the digest — so context stays bounded however long the chat gets.
   State lives on the chat row (chats.context) as
     { v:1, chunks:[{s,e,sum,tok,at}], digest:{e,sum,tok,n}|null }
   where s/e index into the chat's message array.
   ════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const API = 'https://api.usecloak.org';

  // total = tokens for memory + summaries + recent turns + the new message.
  const BUDGETS = {
    pneuma: { total: 5200, memory: 420, summary: 900, keep: 4 },
    logos: { total: 5200, memory: 420, summary: 900, keep: 4 },
    kairos: { total: 9000, memory: 700, summary: 1600, keep: 6 },
    linus: { total: 7000, memory: 520, summary: 1200, keep: 6 },
  };
  const CHUNK_TOKENS = 2400;   // target raw size of one compressed chunk
  const CHUNK_MAX = 14;        // messages per chunk at most
  const MERGE_AT = 5;          // chunk summaries before folding into the digest
  const GAP_BUDGET = 600;      // cap for the local abbreviation of unsummarised turns
  const OLD_MSG_CAP = 1400;    // older verbatim messages are clipped to this
  const COMPRESS_AT = 0.8;     // compress once history exceeds this share of the budget
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

  function empty() { return { v: 1, chunks: [], digest: null }; }
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, data) { (listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
  const log = (t, m) => { try { if (typeof window.log === 'function') window.log(t, '[context] ' + m); } catch (_) {} };

  function valid(o) {
    if (!o || o.v !== 1 || !Array.isArray(o.chunks)) return false;
    let at = o.digest ? o.digest.e : 0;
    if (o.digest && (typeof o.digest.sum !== 'string' || !(o.digest.e > 0))) return false;
    for (const c of o.chunks) {
      if (typeof c.sum !== 'string' || c.s !== at || !(c.e > c.s)) return false;
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
  function covered() {
    if (ctx.chunks.length) return ctx.chunks[ctx.chunks.length - 1].e;
    return ctx.digest ? ctx.digest.e : 0;
  }

  // History was cut to n messages (message edit): drop summaries that covered removed turns.
  function truncate(n) {
    const before = JSON.stringify(ctx);
    if (ctx.digest && ctx.digest.e > n) ctx = empty();
    else ctx.chunks = ctx.chunks.filter((c) => c.e <= n);
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
    // Over budget → keep the most recent lines.
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

  function summaryText() {
    const parts = [];
    if (ctx.digest) parts.push('Earliest part (digest):\n' + ctx.digest.sum);
    ctx.chunks.forEach((c) => parts.push('Messages ' + (c.s + 1) + '–' + c.e + ':\n' + c.sum));
    return parts.join('\n\n');
  }

  // hist: [{role:'USER'|'CHATBOT', message}] including the new user message last.
  // Returns { messages (API format), system (summary block), plan }.
  function build(o) {
    const hist = o.hist || [];
    const model = o.model || 'pneuma';
    const B = budgetFor(model);
    const n = hist.length;
    const cov = Math.min(covered(), Math.max(0, n - 1));
    const sums = summaryText();
    const sumTok = est(sums);
    const memTok = est(o.memory || '');
    const avail = Math.max(800, B.total - memTok - sumTok);

    const live = [];
    let liveTok = 0;
    for (let i = n - 1; i >= cov; i--) {
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

    const gapMsgs = hist.slice(cov, liveStart);
    const gap = gapMsgs.length ? gist(gapMsgs, Math.min(GAP_BUDGET, Math.max(150, avail - liveTok))) : '';
    const gapTok = est(gap);

    let system = '';
    if (sums || gap) {
      system = '## CONVERSATION SO FAR (compressed)\nThis chat is longer than the messages shown. These are compressed notes of the earlier part; treat them as things that were actually said.\n' +
        (sums ? '\n' + sums + '\n' : '') +
        (gap ? '\nMore recent earlier turns (abbreviated):\n' + gap + '\n' : '');
    }

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
      covered: cov,
      chunks: ctx.chunks.map((c) => ({ s: c.s, e: c.e, tok: c.tok })),
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

  // Runs after a reply. At most one chunk (plus an optional merge) per call.
  async function maybeCompress(o) {
    if (busy || Date.now() < retryAt) return false;
    const hist = o.hist || [];
    const B = budgetFor(o.model);
    const n = hist.length;
    const cov = covered();
    let pendTok = 0;
    for (let i = cov; i < n; i++) pendTok += est(hist[i].message) + 4;
    if (pendTok + est(summaryText()) <= B.total * COMPRESS_AT) return mergeIfNeeded(B);

    // Recent turns stay verbatim: at least `keep`, up to ~55% of the budget.
    let keepFrom = n;
    let keepTok = 0;
    for (let i = n - 1; i >= cov; i--) {
      const t = est(hist[i].message) + 4;
      if (n - i > B.keep && keepTok + t > B.total * 0.55) break;
      keepTok += t;
      keepFrom = i;
    }
    let e = cov;
    let t = 0;
    while (e < keepFrom && e - cov < CHUNK_MAX && t < CHUNK_TOKENS) { t += est(hist[e].message) + 4; e++; }
    if (e - cov >= 3 && hist[e - 1].role === 'USER') e--; // end a chunk on a reply
    if (e - cov < 2) return mergeIfNeeded(B);

    busy = true;
    const myEpoch = epoch;
    const s = cov;
    emit('compressing', { s, e });
    try {
      const words = Math.max(60, Math.min(200, Math.round(t / 10))); // ≈9:1 in tokens
      const d = await post('/v1/context/compress', {
        mode: 'chunk',
        words,
        messages: hist.slice(s, e).map((m) => ({ role: m.role === 'CHATBOT' ? 'assistant' : 'user', content: String(m.message || '').slice(0, 6000) })),
      });
      if (myEpoch !== epoch || covered() !== s) return false; // chat changed underneath us
      ctx.chunks.push({ s, e, sum: d.summary, tok: est(d.summary), at: Date.now() });
      emit('change', { source: 'compress', s, e });
      emit('compressed', { s, e, tok: est(d.summary), from: t });
      log('inf', 'compressed ' + (e - s) + ' msgs ' + t + '→' + est(d.summary) + ' tok');
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
    est,
    load, reset, get, truncate, covered,
    build, maybeCompress,
    lastPlan: () => lastPlan,
    busy: () => busy,
    calls: () => calls,
    summaryText,
    on,
  };
})();
