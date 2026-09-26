/* ════════════════════════════════════════════════════════
   CLOAK SEARCH ENGINE — v1.0
   Multi-source web search with paginated crawling.
   Search + extraction via the cloak-api Worker (Tavily → Google → DDG),
   Jina AI reader as extraction backup.
   ════════════════════════════════════════════════════════ */

const CLOAK_SEARCH = (() => {

  /* ── CONFIG ── */
  const JINA_BASE = 'https://r.jina.ai/';
  // Google CSE via our API proxy (avoids CORS / key exposure)
  const SEARCH_PROXY = 'https://api.usecloak.org/v1/search';
  const EXTRACT_PROXY = 'https://api.usecloak.org/v1/extract';

  /* ── SEARCH UI STATE ── */
  let _searchContainer = null;
  let _sourceCount = 0;
  let _allSources = [];

  /* ── STATUS LINES (replaces the old card/box UI) ──
     Each step pops in as a single line in the reply's status log
     (addStatus / finishStatus in cloak.js). */
  let _botEl = null;
  const _domain = (u) => { try { return new URL(u).hostname.replace('www.', ''); } catch { return String(u).slice(0, 40); } };

  function createSearchBlock(botMsgEl) {
    if (_botEl !== botMsgEl) { _sourceCount = 0; _allSources = []; }
    _botEl = botMsgEl;
    return statusLog(botMsgEl);
  }

  function updateTicker(text) {
    if (_botEl) addStatus(_botEl, text);
  }

  function addSearchResultCard(result, queryLabel) {
    _sourceCount++;
    _allSources.push(result);
    if (queryLabel === 'direct' && _botEl) addStatus(_botEl, 'Opening ' + _domain(result.url) + '…');
    return _sourceCount;
  }

  function updateSourceBadge(idx, state) {
    const src = _allSources[idx - 1];
    if (!src || !_botEl) return;
    if (state === 'reading') addStatus(_botEl, 'Reading ' + _domain(src.url) + '…');
  }

  function addCrawlCard(url) {
    if (_botEl) addStatus(_botEl, 'Digging into ' + _domain(url) + '…');
    return null;
  }

  function finaliseSearchBlock(botMsgEl) {
    const log = botMsgEl && botMsgEl._log;
    if (log) log._summary = 'Searched ' + _sourceCount + ' source' + (_sourceCount !== 1 ? 's' : '');
  }

  /* ── CORE SEARCH API ── */
  async function googleSearch(query, page = 1) {
    const start = (page - 1) * 10 + 1;
    const res = await fetch(SEARCH_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, start }),
    });
    if (!res.ok) throw new Error(`Search API ${res.status}`);
    const data = await res.json();
    return (data.items || []).map(item => ({
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || '',
      content: item.content || '',   // Tavily's page summary — fallback if extraction fails
    }));
  }

  /* ── URL CONTENT EXTRACTION ──
     Worker /v1/extract first (Tavily extract → direct fetch), Jina Reader as backup.
     options.raw → the page's raw body (HTML / JSON / CSV / text), no cleanup. */
  async function extractUrl(url, options = {}) {
    const maxChars = options.maxChars || 4000;
    try {
      const res = await fetch(EXTRACT_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, format: options.raw ? 'raw' : 'text', maxChars }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.content) return data.content.slice(0, maxChars);
      }
    } catch (_) { /* fall through to Jina */ }
    const res = await fetch(JINA_BASE + url, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': options.raw ? 'html' : 'text',
        'X-Timeout': '10',
      },
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const text = await res.text();
    return text.slice(0, maxChars);
  }

  /* ── ORCHESTRATOR: Full search with crawling ── */
  async function search(params, botMsgEl) {
    const {
      queries,         // string[]  — search queries to run
      followUrls,      // string[]  — specific URLs to read directly
      maxSources = 5,  // how many search results to read per query
      deepCrawl,       // string[]  — URLs to deep-crawl (follow within site)
    } = params;

    createSearchBlock(botMsgEl);

    const gathered = [];

    // 1. Run all search queries
    for (const q of (queries || [])) {
      updateTicker(`Searching: "${q}"`);
      try {
        const results = await googleSearch(q);
        const top = results.slice(0, maxSources);
        updateTicker('Found ' + top.length + ' result' + (top.length !== 1 ? 's' : ''));
        for (const r of top) {
          const idx = addSearchResultCard(r, q);
          gathered.push({ ...r, idx, extracted: null });
        }
        await sleep(120); // stagger for animation
      } catch (e) {
        console.warn('Search error:', e);
      }
    }

    // 2. Add any direct URLs requested
    for (const url of (followUrls || [])) {
      const idx = addSearchResultCard({ url, title: url, snippet: '' }, 'direct');
      gathered.push({ url, title: url, snippet: '', idx, extracted: null });
    }

    // 3. Extract content from each source
    for (const src of gathered) {
      updateSourceBadge(src.idx, 'reading');
      try {
        src.extracted = await extractUrl(src.url);
        updateSourceBadge(src.idx, 'done');
      } catch (e) {
        updateSourceBadge(src.idx, 'skip');
        src.extracted = src.content || src.snippet || '';
      }
      await sleep(80);
    }

    // 4. Deep crawl — follow sub-pages if requested
    if (deepCrawl?.length) {
      for (const url of deepCrawl) {
        const crawlCard = addCrawlCard(url, 2);
        try {
          const content = await extractUrl(url, { maxChars: 6000 });
          gathered.push({ url, title: 'Deep crawl: ' + url, snippet: '', idx: null, extracted: content });
          if (crawlCard) {
            const dots = crawlCard.querySelector('.crawl-dots');
            if (dots) dots.innerHTML = '<svg width="12" height="12" fill="none" stroke="var(--acc)" stroke-width="2.5" stroke-linecap="round" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>';
          }
        } catch (e) {
          if (crawlCard) crawlCard.style.opacity = '0.4';
        }
        await sleep(100);
      }
    }

    finaliseSearchBlock(botMsgEl);
    return gathered;
  }

  /* ── TOOL CALL PARSER ── */
  // The model returns JSON tool calls in its response stream.
  // This parses them and routes accordingly.
  function parseToolCalls(text) {
    const calls = [];
    // Match <search>...</search> blocks
    const searchRe = /<search>([\s\S]*?)<\/search>/gi;
    let m;
    while ((m = searchRe.exec(text)) !== null) {
      try {
        calls.push({ type: 'search', params: JSON.parse(m[1]) });
      } catch {}
    }
    // Match <fetch>...</fetch> blocks
    const fetchRe = /<fetch>([\s\S]*?)<\/fetch>/gi;
    while ((m = fetchRe.exec(text)) !== null) {
      try {
        const p = JSON.parse(m[1]);
        calls.push({ type: 'fetch', params: p });
      } catch {}
    }
    return calls;
  }

  function hasToolCalls(text) {
    return /<search>|<fetch>/i.test(text);
  }

  /* ── UTILS ── */
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── PUBLIC API ── */
  return {
    search,
    parseToolCalls,
    hasToolCalls,
    finaliseSearchBlock,
    extractUrl,
    createSearchBlock,
    updateTicker,
    addCrawlCard,
    addSearchResultCard,
    updateSourceBadge,
    escHtml,
    getAllSources: () => _allSources,
    getSourceCount: () => _sourceCount,
  };
})();

window.CLOAK_SEARCH = CLOAK_SEARCH;
