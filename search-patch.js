/* ════════════════════════════════════════════════════════
   CLOAK SEARCH INTEGRATION PATCH
   Drop this AFTER cloak.js in chat.html.

   Patches:
   1. Overwrites send() to support search tool calls
   2. Adds citation strip renderer
   3. Injects search system prompt
   ════════════════════════════════════════════════════════ */

/* ── SYSTEM PROMPT ADDITION ── */
const SEARCH_SYSTEM_PROMPT = `You have access to web search tools. When a user's question would benefit from current information, real-time data, specific URLs, or facts you're unsure about, use these tools.

SEARCH TOOL SYNTAX — wrap in XML tags in your response:

For a web search:
<search>{"queries":["your query here"],"maxSources":5}</search>

For reading specific URLs:
<search>{"followUrls":["https://example.com/page"]}</search>

For deep crawling (follow to sub-pages):
<search>{"queries":["initial query"],"deepCrawl":["https://specific-page.com/article"]}</search>

For a page's RAW data (HTML source, JSON APIs, CSV, feeds, plain-text files):
<fetch>{"url":"https://example.com/data.json","raw":true,"maxChars":20000}</fetch>

You can combine: queries + followUrls + deepCrawl in one <search> block.
You can emit multiple <search> blocks if you need to search different topics.
After your search block(s), end with: <done/>

Then wait — search results will be injected and you will get a second turn to synthesize.
In your synthesis turn, write your full answer. Cite sources inline with [1], [2] etc.

RULES:
- Only use search when genuinely needed (current events, facts, specific data, URLs user mentioned)
- Be specific with queries — "React 19 concurrent features 2024" not "React features"
- If a result page seems to have more info on sub-links, use deepCrawl on those URLs
- You can request up to 3 search rounds if needed
- Always synthesize into a clear, helpful answer after searching`;

/* ── REAL-TIME CLOCK ──
   Fresh on every request, so Cloak always knows "now" and can research the
   latest info instead of guessing from its training cutoff. */
function cloakClock() {
  const d = new Date();
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
  const local = d.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `

CURRENT DATE & TIME (real-time clock — this is "now"):
- User's local time: ${local}${tz ? ' (' + tz + ')' : ''}
- UTC: ${d.toISOString()}

Use this clock:
- Treat it as the present. Your training data is older; anything that may have changed since (news, prices, releases, scores, weather, officeholders, versions) needs a search.
- When researching, put the current year (and month when it matters) into time-sensitive queries, prefer the most recent sources, and check publication dates against today.
- Resolve relative dates ("today", "last week", "this year") from this clock, and say how recent your info is when it matters.`;
}

/* ── CITATION STRIP RENDERER ── */
function renderCitationStrip(botMsgEl, sources) {
  if (!sources || !sources.length) return;
  const botBody = botMsgEl.querySelector('.bot-body');
  if (!botBody) return;
  const existing = botBody.querySelector('.search-citation-strip');
  if (existing) existing.remove();

  const strip = document.createElement('div');
  strip.className = 'search-citation-strip';

  sources.slice(0, 8).forEach((src, i) => {
    const chip = document.createElement('a');
    chip.className = 'search-cit-chip';
    chip.href = src.url || '#';
    chip.target = '_blank';
    chip.rel = 'noopener noreferrer';
    chip.style.animationDelay = `${i * 60}ms`;
    chip.addEventListener('click', e => { e.preventDefault(); interceptLink(e, src.url); });

    const domain = (() => { try { return new URL(src.url).hostname.replace('www.', ''); } catch { return src.url.slice(0, 20); } })();
    chip.innerHTML = `<span class="cit-chip-num">${i + 1}</span><span class="cit-chip-label">${CLOAK_SEARCH.escHtml(src.title || domain)}</span>`;
    strip.appendChild(chip);
  });

  botBody.appendChild(strip);
}

/* ── LIVE TOKEN STREAMING ── */
// Requests /v1/chat with stream:true and paints tokens into the bubble as they
// arrive. Falls back transparently when the server answers with plain JSON.
// Search tool markup (<search>, <fetch>, <done/>) is never painted.
const _LIVE_TOOL_TAGS = ['<search', '<fetch', '<done'];

function _liveVisible(text) {
  let cut = text.length;
  for (const tag of _LIVE_TOOL_TAGS) {
    const i = text.indexOf(tag);
    if (i !== -1 && i < cut) cut = i;
  }
  let vis = text.slice(0, cut);
  // Hold back a trailing partial tag such as "<se" until we know what it is.
  const lt = vis.lastIndexOf('<');
  if (lt !== -1 && vis.length - lt < 8 && _LIVE_TOOL_TAGS.some(t => t.startsWith(vis.slice(lt)))) {
    vis = vis.slice(0, lt);
  }
  return vis.trimEnd();
}

// Each word is stamped with the time it first arrived. Every repaint re-parses
// the markdown, then wraps only words still mid-entrance in <span class="tk">
// with a negative animation-delay equal to their age — so the push-up/blur/fade
// carries on seamlessly across repaints instead of restarting. Words that have
// finished animating stay plain text nodes.
const TK_MS = 460;            // keep in sync with .tk in cloak.css
const TK_STAGGER_MAX = 220;   // a burst of new words cascades in over at most this
const ORB_STALL_MS = 650;     // no tokens for this long → orb drops from hop to squish

function _renderLive(container, text) {
  const st = container._tk || (container._tk = { births: [], last: 0 });
  const births = st.births;
  const now = performance.now();
  container.innerHTML = marked.parse(text);

  const nodes = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    if (!n.parentElement.closest('button')) nodes.push(n);
  }
  let total = 0;
  const split = nodes.map(n => {
    const parts = n.textContent.split(/(\s+)/);
    for (const p of parts) if (p && !/^\s/.test(p)) total++;
    return parts;
  });

  // Markdown can swallow earlier words (e.g. "1." becoming a list marker);
  // drop stale stamps so the next real word still gets a fresh entrance.
  if (total < births.length) births.length = total;
  const fresh = total - births.length;
  if (fresh > 0) {
    const step = Math.min(28, TK_STAGGER_MAX / fresh);
    for (let k = 0; k < fresh; k++) births.push(now + k * step);
    st.last = births[births.length - 1];
  }

  let w = 0;
  nodes.forEach((node, ni) => {
    const parts = split[ni];
    let words = 0, live = false;
    for (const p of parts) {
      if (!p || /^\s/.test(p)) continue;
      if (now - births[w + words] < TK_MS) live = true;
      words++;
    }
    if (!live) { w += words; return; }
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if (!p) continue;
      if (/^\s/.test(p)) { frag.appendChild(document.createTextNode(p)); continue; }
      const age = now - births[w++];
      if (age >= TK_MS) { frag.appendChild(document.createTextNode(p)); continue; }
      const s = document.createElement('span');
      s.className = 'tk';
      s.style.animationDelay = (-age).toFixed(0) + 'ms';
      s.textContent = p;
      frag.appendChild(s);
    }
    node.parentNode.replaceChild(frag, node);
  });
  scrollBottom();
}

// Returns { text, streamed } — streamed=true means tokens were already painted.
async function streamChat(bodyObj, botMsgEl, signal) {
  const res = await fetch(CLOAK_API + '/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ ...bodyObj, stream: true }),
  });

  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream') || !res.body) {
    let d;
    try { d = await res.json(); } catch (_) { throw new Error('Unreadable response.'); }
    if (!res.ok || d.error) throw new Error(d.error || 'HTTP ' + res.status);
    return { text: d.response || d.text || '', streamed: false };
  }

  const bc = botMsgEl.querySelector('.bot-content');
  if (bc) bc._tk = null;
  botMsgEl._thinkBuf = ''; botMsgEl._thinkLine = null;
  let orb = null;
  let full = '';
  let shown = false;
  let raf = 0;
  let stallT = 0;
  const paint = () => {
    raf = 0;
    const vis = _liveVisible(full);
    if (!vis || !bc) return;
    if (!shown) {
      shown = true;
      stopThinkAnimation();
      botMsgEl._status = null;
      closeLiveThink(botMsgEl);
      setBotState(botMsgEl, 'streaming');
      const t = tailOrb(botMsgEl);
      orb = t && t.querySelector('.cloak-orb');
    }
    // Hop while tokens flow; squish if the stream stalls mid-answer.
    setOrbState(orb, 'streaming');
    clearTimeout(stallT);
    stallT = setTimeout(() => setOrbState(orb, 'thinking'), ORB_STALL_MS);
    _renderLive(bc, vis);
    placeTailOrb(botMsgEl, bc);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        if (evt.error) {
          if (evt.partial) full = evt.partial;
          throw new Error(evt.error);
        }
        if (typeof evt.think === 'string' && evt.think) liveThink(botMsgEl, evt.think);
        if (typeof evt.delta === 'string') { full += evt.delta; schedule(); }
        if (evt.done && typeof evt.response === 'string') full = evt.response;
      }
    }
  } catch (e) {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    clearTimeout(stallT);
    // User pressed stop mid-answer: keep what already arrived.
    if (e.name === 'AbortError' && full) return { text: full, streamed: shown, aborted: true };
    throw e;
  }
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  clearTimeout(stallT);
  return { text: full, streamed: shown };
}

// ── LIVE THINKING ──
// Reasoning streams into the status log: each sentence pops in as its own
// line; the current one fills in live.
function liveThink(botMsgEl, chunk) {
  let buf = (botMsgEl._thinkBuf || '') + chunk;
  let line = botMsgEl._thinkLine;
  for (;;) {
    const m = buf.match(/[.!?](\s+)|\n+/);
    if (!m) break;
    const cut = m.index + (m[0][0] === '\n' ? 0 : 1);
    const done = buf.slice(0, cut).trim();
    buf = buf.slice(m.index + m[0].length);
    if (done) {
      if (!line) line = addStatus(botMsgEl, done, true); else line.textContent = done;
      setStatusPreview(botMsgEl, done, true);
      line = null;
    }
  }
  const rest = buf.trim();
  if (rest) {
    if (!line) line = addStatus(botMsgEl, rest, true); else line.textContent = rest;
  }
  botMsgEl._thinkBuf = buf;
  botMsgEl._thinkLine = line;
}
function closeLiveThink(botMsgEl) {
  botMsgEl._thinkBuf = ''; botMsgEl._thinkLine = null;
  finishStatus(botMsgEl);
}

// Final render for a bubble whose tokens were painted live. Lets the last
// words finish their entrance, then swaps in a clean (span-free) render.
function finishLive(botMsgEl, text) {
  closeLiveThink(botMsgEl);
  stopThinkAnimation();
  finaliseThoughts(botMsgEl);
  botMsgEl._status = null;
  setBusy(false);
  const bc = botMsgEl.querySelector('.bot-content');
  if (!bc) return;
  _renderLive(bc, text);
  placeTailOrb(botMsgEl, bc);
  setBotState(botMsgEl, null);
  if (botMsgEl._tail) setOrbState(botMsgEl._tail.querySelector('.cloak-orb'), 'done');
  const wait = Math.max(0, (bc._tk ? bc._tk.last : 0) + TK_MS - performance.now());
  setTimeout(() => {
    bc._tk = null;
    bc.innerHTML = marked.parse(text);
    restOrbBelow(botMsgEl);
    postProcessBotEl(botMsgEl, text);
    scrollBottom();
  }, wait);
}

/* ── SEARCH-AWARE SEND ── */
// We save the original send and replace it
const _originalSend = window.send;

window.send = async function () {
  const inp = document.getElementById('chat-input');
  const txt = inp.value.trim();
  if ((!txt && !attachedImgs.length) || busy) return;
  if (guest && guestN >= GUEST_MAX) { showLimit(); return; }
  if (typeof hapticTap === 'function') hapticTap();
  if (typeof primeAudio === 'function') primeAudio();
  checkMentalHealth(txt);
  if (!chatId) { chatId = Date.now().toString(); hist = []; }

  if (voiceMode) { voiceState = 'thinking'; if (recognition) recognition.stop(); }

  const imgs = [...attachedImgs];
  attachedImgs = []; renderImgStrip();

  inp.value = ''; inp.style.height = 'auto';
  setBusy(true);
  addMsg('user', txt, false, imgs);

  const t0 = Date.now();
  const hasImages = imgs.length > 0;
  const model = window.cloakModel || 'pneuma';
  const useThoughts = _shouldThink(model);

  let userMsg = txt;
  if (hwMode && txt) userMsg = '[HOMEWORK MODE]\n\n' + txt;
  if (!userMsg && hasImages) userMsg = '[Image]';
  hist.push({ role: 'USER', message: userMsg });

  stats.req++;
  log('req', `"${(txt || '[image]').slice(0, 60)}" model=${model} search=enabled`);

  showMessages();

  // ── Instant thinking indicator ──
  // The orb squishes with a "Cloak is thinking…" label. Created BEFORE the
  // request fires so the wait is never a blank screen. This same bubble is
  // reused for the rest of the turn; the orb follows each step after that.
  let botMsgEl = insertBotBubbleForThoughts();
  try { botMsgEl._status = createCloakStatus(botMsgEl); } catch (_) { botMsgEl._status = null; }
  if (!botMsgEl._status) {
    const _bc = botMsgEl.querySelector('.bot-content');
    if (_bc) _bc.innerHTML = '<div class="typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
  }

  // Build API messages with search system prompt
  const apiMessages = hist.slice(0, -1).map(m => ({
    role: m.role === 'CHATBOT' ? 'assistant' : 'user',
    content: m.message,
  }));
  apiMessages.push({ role: 'user', content: userMsg || '[Image]' });

  let imageBase64 = null, mimeType = null;
  if (hasImages && imgs[0]) {
    const match = imgs[0].data.match(/^data:([^;]+);base64,(.+)$/);
    if (match) { mimeType = match[1]; imageBase64 = match[2]; }
  }

  const trimmedMessages = apiMessages.slice(-20);
  const bodyObj = {
    model,
    messages: trimmedMessages,
    system: SEARCH_SYSTEM_PROMPT + cloakClock(),
    imageBase64: imageBase64 || undefined,
    mimeType: mimeType || undefined,
  };

  /* ── ROUND 1: Get model's initial response (may include tool calls) ── */
  _fetchController = new AbortController();

  try {
    const round1 = await streamChat(bodyObj, botMsgEl, _fetchController.signal);
    _fetchController = null;

    // A stopped answer may end mid tool-tag; keep only the readable part.
    let firstResponse = round1.aborted ? _liveVisible(round1.text) : round1.text;
    if (!firstResponse) {
      if (round1.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }
      throw new Error('Empty response.');
    }

    /* ── Check for search tool calls ── */
    if (!round1.aborted && CLOAK_SEARCH.hasToolCalls(firstResponse)) {
      const toolCalls = CLOAK_SEARCH.parseToolCalls(firstResponse);

      if (toolCalls.length > 0) {
        // Search path takes over the bubble — orb switches to its scanning
        // state and the search/thought UI gets a clean bot-content.
        botMsgEl._status = null;
        dropTailOrb(botMsgEl);
        setBotState(botMsgEl, 'searching');
        const _sbc = botMsgEl.querySelector('.bot-content');
        if (_sbc) { _sbc.innerHTML = ''; _sbc._tk = null; }

        // Execute all search calls
        let allGathered = [];
        for (const call of toolCalls) {
          if (call.type === 'search') {
            const gathered = await CLOAK_SEARCH.search(call.params, botMsgEl);
            allGathered = allGathered.concat(gathered);
          } else if (call.type === 'fetch') {
            // Direct URL fetch
            CLOAK_SEARCH.createSearchBlock(botMsgEl);
            const idx = CLOAK_SEARCH.addSearchResultCard(
              { url: call.params.url, title: call.params.url, snippet: '' }, 'direct'
            );
            CLOAK_SEARCH.updateSourceBadge(idx, 'reading');
            try {
              const content = await CLOAK_SEARCH.extractUrl(call.params.url, { maxChars: call.params.maxChars || 5000, raw: !!call.params.raw });
              allGathered.push({ url: call.params.url, title: call.params.url, extracted: content });
              CLOAK_SEARCH.updateSourceBadge(idx, 'done');
            } catch (e) {
              CLOAK_SEARCH.updateSourceBadge(idx, 'skip');
            }
          }
        }

        addStatus(botMsgEl, 'Writing the answer…');
        setBotState(botMsgEl, 'thinking');

        // Build context with search results for synthesis
        const searchContext = allGathered
          .filter(s => s.extracted)
          .map((s, i) => `[${i + 1}] ${s.url}\n${s.title}\n${s.extracted.slice(0, 2000)}`)
          .join('\n\n---\n\n');

        const synthesisMessages = [
          ...trimmedMessages,
          { role: 'assistant', content: firstResponse },
          {
            role: 'user',
            content: `Here are the search results:\n\n${searchContext}\n\nNow synthesise a complete, helpful answer. Cite sources inline with [1], [2] etc. matching the source numbers above.`
          }
        ];

        // Round 2: Synthesis
        stats.req++;
        log('req', `Synthesis round | sources=${allGathered.length}`);

        _fetchController = new AbortController();
        const synth = await streamChat({
          model,
          messages: synthesisMessages.slice(-22),
          system: SEARCH_SYSTEM_PROMPT + cloakClock(),
        }, botMsgEl, _fetchController.signal);
        _fetchController = null;

        // Drop any stray tool markup the model emits during synthesis.
        const finalText = synth.text.replace(/<search>[\s\S]*?<\/search>|<fetch>[\s\S]*?<\/fetch>|<done\s*\/?>/gi, '').trim();
        if (!finalText) throw new Error('Empty synthesis response.');

        CLOAK_SEARCH.finaliseSearchBlock(botMsgEl);

        // Stream the final answer
        const ms = Date.now() - t0;
        stats.lat.push(ms); stats.res++;
        log('res', `${ms}ms | search+synthesis | len=${finalText.length}`);

        hist.push({ role: 'CHATBOT', message: finalText });
        if (hist.length > 20) hist = hist.slice(-20);

        if (synth.streamed) finishLive(botMsgEl, finalText);
        else replaceThinkWithContent(botMsgEl, finalText);

        // Render citation strip after a short delay
        setTimeout(() => {
          renderCitationStrip(botMsgEl, allGathered.filter(s => s.url));
        }, 600);

        if (voiceMode) playVoice(finalText);
        if (guest) { guestN++; if (guestN >= GUEST_MAX) setTimeout(showLimit, 500); }
        else saveConv(txt || '[Image]').catch(e => log('err', 'Save: ' + e.message));

        return; // Done — search path handled
      }
    }

    /* ── No tool calls — normal path ── */
    const ms = Date.now() - t0;
    stats.lat.push(ms); stats.res++;
    log('res', `${ms}ms | no-search | len=${firstResponse.length}`);

    hist.push({ role: 'CHATBOT', message: firstResponse });
    if (hist.length > 20) hist = hist.slice(-20);

    // Streamed → let the last tokens land, then settle the orb.
    if (round1.streamed) finishLive(botMsgEl, firstResponse);
    else replaceThinkWithContent(botMsgEl, firstResponse);

    if (voiceMode) playVoice(firstResponse);
    if (guest) { guestN++; if (guestN >= GUEST_MAX) setTimeout(showLimit, 500); }
    else saveConv(txt || '[Image]').catch(e => log('err', 'Save: ' + e.message));

  } catch (ex) {
    _fetchController = null;
    stopThinkAnimation();
    if (ex.name === 'AbortError') {
      if (botMsgEl) botMsgEl.remove();
      else {
        const msgs = document.getElementById('messages');
        if (msgs && msgs.lastChild?.classList?.contains('bot')) msgs.lastChild.remove();
      }
      if (hist.length && hist[hist.length - 1].role === 'USER') hist.pop();
      setBusy(false);
    } else {
      stats.err++;
      log('err', ex.message);
      const errTxt = ex.message.match(/^(HTTP 5|Service|No response|Empty)/i)
        ? 'Service temporarily unavailable — please try again.'
        : CLOAK_SEARCH.escHtml(ex.message);
      if (!botMsgEl) botMsgEl = insertBotBubble();
      replaceThinkWithContent(botMsgEl, 'Error: ' + errTxt);
      if (voiceMode) playVoice('Sorry, I ran into an error.');
    }
  }
};
