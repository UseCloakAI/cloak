/* ════════════════════════════════════════════════════════
   CLOAK MEMORY — long-term memory as markdown files
   Each memory is a small .md file with YAML-ish frontmatter:

     ---
     title: Builds Cloak
     type: project            profile | preference | project | fact | episode
     tags: [cloak, supabase]
     importance: 0.8          0.1–1, how often it should shape answers
     created: 2026-09-26
     updated: 2026-09-26
     ---
     - User builds Cloak, a human-centric AI platform (usecloak.org).

   Storage: Supabase `memory_files` only (RLS: owner only). The browser keeps
   a working copy in RAM for recall; nothing is written to the device.
   Guests get session-only memory.
   Recall is local BM25 + importance/recency/usage — zero API calls.
   Writing is batched: turns with self-disclosure queue up and one cheap
   utility-model call (/v1/memory/extract) turns them into file ops.
   "remember …" / "forget …" are handled instantly with no model call.
   ════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const API = 'https://api.usecloak.org';
  const TYPES = ['profile', 'preference', 'project', 'fact', 'episode'];
  const TYPE_LABEL = { profile: 'Identity', preference: 'Preferences', project: 'Projects', fact: 'Knowledge', episode: 'Episodes' };
  const TYPE_WORDS = {
    profile: 'me myself name who identity about background',
    preference: 'prefer style tone format like want answer reply',
    project: 'project build building working app goal plan',
    fact: 'use setup',
    episode: 'decided happened earlier last time',
  };
  const MAX_FILES = 300;
  const MAX_BODY = 1200;
  const MAX_TITLE = 60;
  const MIN_REL = 0.22;
  const K1 = 1.2, B = 0.75;
  const EXTRACT_BATCH = 3;        // signal turns before an immediate extraction
  const EXTRACT_IDLE_MS = 25000;  // …or this long after the last one
  const EXTRACT_GAP_MS = 20000;   // never closer together than this
  const EXTRACT_DAILY = 60;       // per-browser cap on background extraction calls
  const TOUCH_FLUSH_MS = 15000;
  const LS_ON = 'cloak_mem_on';
  const LS_QUOTA = 'cloak_mem_q';

  const STOP = new Set(('a an and are as at be but by for from has have had i in is it its of on or that the this to was were will with you your yours me my mine we our us they them their he she him his her not no do does did done so if then than too very can could just about into over also what which who whom how when where why all any some more most other such only own same few both each here there these those am been being would should may might must shall ok okay yes yeah yep hey hi hello please thanks thank user users im ive id dont doesnt cant wont get got make made thing things really like want need know think').split(' '));

  // Turns worth sending to extraction: the user talks about themselves or their world.
  const SIGNAL = /\b(i am|i'm|im|i've|i have|my|mine|i work|i live|i study|i prefer|i like|i love|i hate|i don'?t (like|want)|i want you|i use|i'm using|i build|i'm building|i run|i made|call me|we use|our (team|company|app|stack|product|school|class)|from now on|going forward|always|never|remember|don'?t forget)\b/i;
  const REMEMBER_RE = /^(?:hey\s+cloak[,\s]+)?(?:please\s+)?(?:remember|don'?t forget|do not forget|note|save to memory)(?:\s+that)?[:,\s]+(.{3,})$/is;
  const FORGET_RE = /^(?:hey\s+cloak[,\s]+)?(?:please\s+)?forget(?:\s+(?:that|about))?[:,\s]+(.{3,})$/is;

  let files = new Map();
  let owner = { sb: null, uid: '', guest: true };
  let remoteOK = true;
  let loaded = false;
  let index = null;
  let pending = [];
  let extractTimer = 0;
  let extracting = false;
  let lastExtract = 0;
  const touched = new Set();
  let touchTimer = 0;
  let lastRecall = null;
  const listeners = {};

  /* ── utils ── */
  const est = (s) => (s ? Math.ceil(String(s).length / 3.6) : 0);
  const today = () => new Date().toISOString().slice(0, 10);
  const clamp = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const oneLine = (s) => String(s || '').split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean).join('; ');
  const titleFromPath = (p) => { const s = p.split('/').pop().replace(/\.md$/, '').replace(/-/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const log = (t, m) => { try { if (typeof window.log === 'function') window.log(t, '[memory] ' + m); } catch (_) {} };

  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function off(evt, fn) { listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn); }
  function emit(evt, data) { (listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

  function enabled() { return lsGet(LS_ON) !== '0'; }
  function setEnabled(v) {
    lsSet(LS_ON, v ? '1' : '0');
    if (!v) { pending = []; clearTimeout(extractTimer); }
    emit('enabled', !!v);
  }

  /* ── markdown files ── */
  function normPath(p, type) {
    const parts = String(p || '').toLowerCase().replace(/\.md$/, '').split('/').filter(Boolean);
    const folder = TYPES.includes(parts[0]) ? parts.shift() : (TYPES.includes(type) ? type : 'fact');
    const name = slug(parts.join('-'));
    return name ? folder + '/' + name + '.md' : '';
  }

  function parseMd(raw, path) {
    const text = String(raw || '').replace(/\r\n/g, '\n');
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
    const meta = {};
    let body = text;
    if (m) {
      body = m[2];
      m[1].split('\n').forEach((line) => {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      });
    }
    const folder = String(path || '').split('/')[0];
    const type = TYPES.includes(meta.type) ? meta.type : TYPES.includes(folder) ? folder : 'fact';
    const p = normPath(path, type) || normPath(meta.title, type);
    return {
      path: p,
      title: String(meta.title || titleFromPath(p || 'untitled')).replace(/\s+/g, ' ').slice(0, MAX_TITLE),
      type,
      tags: String(meta.tags || '').replace(/^\[|\]$/g, '').split(',').map(slug).filter(Boolean).slice(0, 8),
      importance: clamp(parseFloat(meta.importance), 0.1, 1, 0.5),
      created: /^\d{4}-\d\d-\d\d$/.test(meta.created || '') ? meta.created : today(),
      updated: /^\d{4}-\d\d-\d\d$/.test(meta.updated || '') ? meta.updated : today(),
      source: /^(auto|explicit|manual|import)$/.test(meta.source || '') ? meta.source : '',
      body: body.trim().slice(0, MAX_BODY),
      hits: 0,
      lastUsed: null,
    };
  }

  function toMd(f) {
    return '---\n' +
      'title: ' + f.title + '\n' +
      'type: ' + f.type + '\n' +
      'tags: [' + f.tags.join(', ') + ']\n' +
      'importance: ' + Math.round(f.importance * 100) / 100 + '\n' +
      'created: ' + f.created + '\n' +
      'updated: ' + f.updated + '\n' +
      (f.source ? 'source: ' + f.source + '\n' : '') +
      '---\n' + f.body.trim() + '\n';
  }

  /* ── retrieval (BM25 + priors) ── */
  function stem(w) {
    if (w.length <= 3) return w;
    if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
    if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
    if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
    if (/(s|x|z|ch|sh)es$/.test(w) && w.length > 4) return w.slice(0, -2);
    if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
    if (w.endsWith('ly') && w.length > 5) return w.slice(0, -2);
    return w;
  }
  function tokens(text) {
    const out = [];
    String(text || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).forEach((w) => {
      if (w.length < 2 || STOP.has(w)) return;
      out.push(stem(w));
    });
    return out;
  }

  function buildIndex() {
    const docs = [];
    const df = new Map();
    let total = 0;
    for (const f of files.values()) {
      const tf = new Map();
      const add = (txt, w) => { for (const t of tokens(txt)) tf.set(t, (tf.get(t) || 0) + w); };
      add(f.title, 2.2);
      add(f.tags.join(' '), 2);
      add(f.body, 1);
      add(TYPE_WORDS[f.type], 0.5);
      let len = 0;
      for (const v of tf.values()) len += v;
      docs.push({ f, tf, len: len || 1 });
      total += len;
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    index = { docs, df, N: docs.length, avg: docs.length ? total / docs.length : 1 };
  }

  function bm25(doc, q) {
    let s = 0;
    for (const [t, qw] of q) {
      let tf = doc.tf.get(t) || 0;
      let key = t;
      if (!tf && t.length >= 4) {
        // Prefix match ("deploy" ↔ "deployment") at half weight.
        for (const [dt, v] of doc.tf) {
          if (dt.length >= 4 && (dt.startsWith(t) || t.startsWith(dt)) && v * 0.5 > tf) { tf = v * 0.5; key = dt; }
        }
      }
      if (!tf) continue;
      const n = index.df.get(key) || 1;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      s += qw * idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.len / index.avg));
    }
    return s;
  }

  const BLOCK_HEAD = '## USER MEMORY\nYou DO remember this user. These notes are what you know about them from past chats; the user saved them and can see and edit them in Cloak\'s Brain panel, so using them is expected and is not a privacy problem. This overrides any default of saying you don\'t know who the user is. Use them silently to tailor answers; don\'t recite them unprompted. When the user asks who they are, their name, or what you know or remember about them, answer directly from these notes. If a note conflicts with what the user says now, trust the user.\n';
  const lineFor = (f) => '- [' + f.type + '] ' + f.title + ': ' + oneLine(f.body).slice(0, 240);

  // Always-on: identity is tiny and shapes everything; strong preferences too.
  function isCore(f) { return f.type === 'profile' || (f.type === 'preference' && f.importance >= 0.6); }
  // "who am i", "what's my name", "what do you know/remember about me"… — all
  // stopwords to BM25, so these get a broad, importance-ranked recall instead.
  const SELF_Q = /\b(who am i|who i am|what'?s my name|what is my name|my name\b|about me\b|about myself|know about me|remember (about )?me|remember anything|what do you (know|remember)|what have you (learned|saved|remembered)|do you (know|remember) me|tell me about (me|myself))/i;

  // query: the new message. context: [{text, w}] of recent turns (lower weight).
  function recall(query, opts) {
    const o = Object.assign({ context: [], budget: 420, k: 8, touch: true, emit: true, core: true, minRel: MIN_REL }, opts || {});
    const self = o.core && SELF_Q.test(String(query || ''));
    if (self) { o.budget = Math.round(o.budget * 1.6); o.k = 14; o.minRel = -1; }
    const empty = { query, hits: [], block: '', tokens: 0, total: files.size, at: Date.now(), enabled: enabled() };
    if (!enabled() || !files.size) { if (o.emit) { lastRecall = empty; emit('recall', empty); } return empty; }
    if (!index) buildIndex();

    const q = new Map();
    const addQ = (txt, w) => { for (const t of tokens(txt)) q.set(t, Math.max(q.get(t) || 0, w)); };
    addQ(query, 1);
    (o.context || []).forEach((c) => addQ(c.text, c.w || 0.4));

    const now = Date.now();
    const scored = index.docs.map((d) => {
      const raw = q.size ? bm25(d, q) : 0;
      const rel = raw / (raw + 2.5);
      const age = (now - Date.parse(d.f.lastUsed || d.f.updated)) / 864e5;
      const recency = Math.exp(-(Number.isFinite(age) ? Math.max(0, age) : 90) / 45);
      const freq = Math.min(1, Math.log1p(d.f.hits || 0) / Math.log(20));
      return { file: d.f, rel, score: rel * 0.7 + d.f.importance * 0.15 + recency * 0.08 + freq * 0.07 };
    });

    const picked = [];
    let used = est(BLOCK_HEAD);
    if (o.core) {
      scored.filter((s) => isCore(s.file))
        .sort((a, b) => b.file.importance - a.file.importance || b.score - a.score)
        .some((s) => {
          const c = est(lineFor(s.file));
          if (used + c > o.budget * 0.45) return true;
          picked.push(Object.assign({ why: 'core' }, s));
          used += c;
          return false;
        });
    }
    // Carried: memories the model's thinking pulled up last turn.
    (o.include || []).forEach((path) => {
      const s = scored.find((x) => x.file.path === path);
      if (!s || picked.some((p) => p.file === s.file)) return;
      const c = est(lineFor(s.file));
      if (used + c > o.budget) return;
      picked.push(Object.assign({}, s, { why: 'carried' }));
      used += c;
    });
    scored.filter((s) => s.rel >= o.minRel && !picked.some((p) => p.file === s.file))
      .map((s) => (self ? Object.assign({}, s, { score: s.score + s.file.importance }) : s))
      .sort((a, b) => b.score - a.score)
      .forEach((s) => {
        if (picked.length >= o.k) return;
        const c = est(lineFor(s.file));
        if (used + c > o.budget) return;
        picked.push(Object.assign({ why: 'relevant' }, s));
        used += c;
      });

    const block = picked.length ? BLOCK_HEAD + picked.map((p) => lineFor(p.file)).join('\n') : '';
    const result = {
      query,
      hits: picked.map((p) => ({ path: p.file.path, title: p.file.title, type: p.file.type, rel: p.rel, score: p.score, why: p.why })),
      block,
      tokens: block ? used : 0,
      total: files.size,
      at: now,
      enabled: true,
    };
    if (o.touch) picked.filter((p) => p.why === 'relevant').forEach((p) => touch(p.file));
    if (o.emit) { lastRecall = result; emit('recall', result); }
    return result;
  }

  // Think-time recall: memories the model's live reasoning points at that the
  // prompt doesn't have yet. Stricter floor than message recall — it costs a re-ask.
  function probe(text, exclude) {
    if (!enabled() || !files.size || !text) return [];
    const ex = new Set(exclude || []);
    return recall(text, { core: false, touch: false, emit: false, k: 4, budget: 300, minRel: 0.38 }).hits
      .filter((h) => !ex.has(h.path))
      .map((h) => Object.assign({}, h, { why: 'thought' }));
  }

  // Adds probe hits to an earlier recall result, rebuilds its prompt block, fires the Brain.
  function extend(base, extra) {
    const all = ((base && base.hits) || []).concat(extra || []);
    const fl = all.map((h) => files.get(h.path)).filter(Boolean);
    (extra || []).forEach((h) => { const f = files.get(h.path); if (f) touch(f); });
    const block = fl.length ? BLOCK_HEAD + fl.map(lineFor).join('\n') : '';
    const res = Object.assign({}, base || {}, { hits: all, block, tokens: est(block), total: files.size, at: Date.now(), enabled: true, query: (base && base.query) || '' });
    lastRecall = res;
    emit('recall', res);
    return res;
  }

  function touch(f) {
    f.hits = (f.hits || 0) + 1;
    f.lastUsed = new Date().toISOString();
    touched.add(f.path);
    clearTimeout(touchTimer);
    touchTimer = setTimeout(flushTouched, TOUCH_FLUSH_MS);
  }

  /* ── persistence: Supabase is the only store ──
     Memory files live in `memory_files`; the browser holds a working copy in
     RAM for recall and never writes memories to localStorage. Guests (no
     account) get session-only memory that is carried into their account if
     they sign in during the same session. */
  const remoteOn = () => remoteOK && owner.sb && owner.uid && !owner.guest;
  const rowFor = (f) => ({ user_id: owner.uid, path: f.path, content: toMd(f), hits: f.hits || 0, last_used_at: f.lastUsed || null });
  function remoteFail(e, what) {
    const msg = (e && (e.message || e.code)) || String(e);
    log('err', what + ': ' + msg);
    if (/42P01|PGRST205|does not exist|schema cache/i.test(msg + (e && e.code))) remoteOK = false;
    emit('sync', { ok: false, error: msg });
  }
  async function pushRemote(paths) {
    if (!remoteOn() || !paths.length) return;
    const rows = paths.map((p) => files.get(p)).filter(Boolean).map(rowFor);
    if (!rows.length) return;
    const { error } = await owner.sb.from('memory_files').upsert(rows, { onConflict: 'user_id,path' });
    if (error) remoteFail(error, 'sync');
  }
  async function deleteRemote(paths) {
    if (!remoteOn() || !paths.length) return;
    const { error } = await owner.sb.from('memory_files').delete().eq('user_id', owner.uid).in('path', paths);
    if (error) remoteFail(error, 'delete');
  }
  function flushTouched() {
    const paths = [...touched];
    touched.clear();
    pushRemote(paths).catch((e) => remoteFail(e, 'touch'));
  }

  // Drops any memory copies an earlier build may have cached on this device.
  function purgeDeviceCopies() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && /^cloak_mem_/.test(k) && k !== LS_ON && k !== LS_QUOTA) localStorage.removeItem(k);
      }
    } catch (_) {}
  }

  async function init(o) {
    const guestFiles = owner.guest ? files : new Map(); // session-only guest memories
    owner = { sb: (o && o.sb) || null, uid: (o && o.uid) || '', guest: !(o && o.uid) || !!(o && o.guest) };
    remoteOK = true;
    loaded = false;
    purgeDeviceCopies();
    if (!remoteOn()) {
      files = guestFiles;
      index = null;
      loaded = true;
      emit('change', { source: 'load' });
      return;
    }
    files = new Map();
    index = null;
    emit('change', { source: 'load' });
    try {
      const { data, error } = await owner.sb.from('memory_files')
        .select('path,content,hits,last_used_at').eq('user_id', owner.uid).limit(MAX_FILES + 100);
      if (error) { remoteFail(error, 'load'); return; }
      const next = new Map();
      (data || []).forEach((r) => {
        const f = parseMd(r.content, r.path);
        if (!f.path) return;
        f.hits = r.hits || 0;
        f.lastUsed = r.last_used_at || null;
        next.set(f.path, f);
      });
      // A guest who signs in keeps what Cloak learned earlier in this session.
      const carried = [];
      for (const [p, f] of guestFiles) if (!next.has(p) && next.size < MAX_FILES) { next.set(p, f); carried.push(p); }
      files = next;
      index = null;
      loaded = true;
      if (carried.length) pushRemote(carried).catch((e) => remoteFail(e, 'carry'));
      emit('change', { source: 'sync' });
      emit('sync', { ok: true });
      log('inf', 'Loaded ' + files.size + ' memories from Supabase');
    } catch (e) { remoteFail(e, 'load'); }
  }

  // Sign-out: drop the in-memory copy.
  function reset() {
    if (touched.size) flushTouched();
    files = new Map();
    index = null;
    pending = [];
    clearTimeout(extractTimer);
    touched.clear();
    lastRecall = null;
    loaded = false;
    owner = { sb: null, uid: '', guest: true };
    emit('change', { source: 'reset' });
  }

  /* ── writes ── */
  function value(f) {
    const age = (Date.now() - Date.parse(f.lastUsed || f.updated)) / 864e5;
    return f.importance * 0.6 + Math.min(1, Math.log1p(f.hits || 0) / Math.log(20)) * 0.25 + Math.exp(-(age || 0) / 60) * 0.15;
  }

  function validOp(o) {
    if (!o || !['add', 'update', 'delete'].includes(o.op)) return null;
    const type = TYPES.includes(o.type) ? o.type : null;
    const path = normPath(o.path || o.title, type || String(o.path || '').split('/')[0]);
    if (!path) return null;
    if (o.op === 'delete') return { op: 'delete', path };
    const body = String(o.body || '').trim().slice(0, MAX_BODY);
    if (!body) return null;
    return {
      op: o.op,
      path,
      type: type || path.split('/')[0],
      title: String(o.title || titleFromPath(path)).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE),
      tags: (Array.isArray(o.tags) ? o.tags : []).map(slug).filter(Boolean).slice(0, 8),
      importance: clamp(Number(o.importance), 0.1, 1, 0.5),
      body,
      source: o.source || '',
    };
  }

  // An auto "add" that restates an existing note of the same type is folded
  // into that note instead (bullet lines unioned), so memory doesn't fill with near-duplicates.
  function foldDuplicate(o) {
    if (o.op !== 'add' || files.has(o.path) || !files.size) return o;
    const hit = recall(o.title + ' ' + o.tags.join(' ') + ' ' + o.body, { core: false, touch: false, emit: false, k: 3, minRel: 0.55 })
      .hits.find((h) => h.type === o.type);
    if (!hit) return o;
    const cur = files.get(hit.path);
    if (!cur) return o;
    const lines = cur.body.split('\n').concat(o.body.split('\n')).map((l) => l.trim()).filter(Boolean);
    const seen = new Set();
    const body = lines.filter((l) => { const k = l.toLowerCase().replace(/[^a-z0-9]+/g, ''); if (seen.has(k)) return false; seen.add(k); return true; }).join('\n');
    return Object.assign({}, o, { op: 'update', path: cur.path, title: cur.title, tags: [...new Set(cur.tags.concat(o.tags))].slice(0, 8), importance: Math.max(cur.importance, o.importance), body: body.slice(0, MAX_BODY) });
  }

  // Applies add/update/delete ops. Returns the ops that changed something.
  function applyOps(ops, source) {
    const done = [];
    const upserts = [];
    const deletes = [];
    (Array.isArray(ops) ? ops : []).forEach((raw) => {
      let o = validOp(raw);
      if (!o) return;
      if (source === 'auto') o = foldDuplicate(o);
      if (o.op === 'delete') {
        if (!files.has(o.path)) return;
        const f = files.get(o.path);
        files.delete(o.path);
        deletes.push(o.path);
        done.push({ op: 'delete', path: o.path, title: f.title, type: f.type });
        return;
      }
      const cur = files.get(o.path);
      const d = today();
      const f = cur ? Object.assign({}, cur) : { path: o.path, created: d, hits: 0, lastUsed: null, source: source || o.source || 'auto' };
      f.type = o.type;
      f.title = o.title;
      f.tags = o.tags.length ? o.tags : (cur ? cur.tags : []);
      f.importance = o.importance;
      f.body = o.body;
      f.updated = d;
      if (!cur && files.size >= MAX_FILES) {
        const victim = [...files.values()].filter((x) => x.source !== 'explicit').sort((a, b) => value(a) - value(b))[0];
        if (!victim) return;
        files.delete(victim.path);
        deletes.push(victim.path);
      }
      files.set(f.path, f);
      upserts.push(f.path);
      done.push({ op: cur ? 'update' : 'add', path: f.path, title: f.title, type: f.type });
    });
    if (!done.length) return done;
    index = null;
    pushRemote(upserts).catch((e) => remoteFail(e, 'sync'));
    deleteRemote(deletes).catch((e) => remoteFail(e, 'delete'));
    emit('change', { source: source || 'auto', ops: done });
    return done;
  }

  // Raw markdown save from the Brain editor. Renames when the path changes.
  function saveFile(oldPath, raw, newPath) {
    const f = parseMd(raw, newPath || oldPath);
    if (!f.path) return null;
    const ops = [];
    if (oldPath && oldPath !== f.path && files.has(oldPath)) ops.push({ op: 'delete', path: oldPath });
    ops.push({ op: files.has(f.path) ? 'update' : 'add', path: f.path, type: f.type, title: f.title, tags: f.tags, importance: f.importance, body: f.body || '-', source: 'manual' });
    applyOps(ops, 'manual');
    return files.get(f.path) || null;
  }
  function removeFile(path) { return applyOps([{ op: 'delete', path }], 'manual').length > 0; }

  /* ── explicit commands ── */
  // Whole message ("remember: …") or any sentence in it ("…. Remember that I …").
  function detectCommand(text) {
    const t = String(text || '').trim();
    let m = REMEMBER_RE.exec(t);
    if (m) return { op: 'remember', text: m[1].trim() };
    m = FORGET_RE.exec(t);
    if (m) return { op: 'forget', text: m[1].trim() };
    m = /(?:^|[.!?]\s+)(?:please\s+)?(?:remember|don'?t forget)\s+that\s+([^.!?\n]{3,})/i.exec(t);
    if (m) return { op: 'remember', text: m[1].trim() };
    return null;
  }

  const MODAL = /^(can|could|will|would|should|shall|may|might|must|was|did|had|need|used)$/;
  function thirdPerson(s) {
    return s
      .replace(/\bI am\b|\bI'm\b|\bIm\b/gi, 'User is')
      .replace(/\bI've\b|\bI have\b/gi, 'User has')
      .replace(/\bI'll\b/gi, 'User will')
      .replace(/\bI'd\b/gi, 'User would')
      .replace(/\bI (don'?t|do not)\b/gi, "User doesn't")
      .replace(/\bI do\b/gi, 'User does')
      .replace(/\bI ([a-z]+)\b/g, (_, v) => {
        if (MODAL.test(v) || /ed$/.test(v)) return 'User ' + v;
        if (/(s|sh|ch|x|z|o)$/.test(v)) return 'User ' + v + 'es';
        if (/[^aeiou]y$/.test(v)) return 'User ' + v.slice(0, -1) + 'ies';
        return 'User ' + v + 's';
      })
      .replace(/\bmy\b/gi, 'their')
      .replace(/\bmine\b/gi, 'theirs')
      .replace(/\bme\b/gi, 'them')
      .replace(/\bI\b/g, 'User');
  }

  function remember(text) {
    if (!enabled()) return null;
    const clean = String(text || '').trim().replace(/[.!\s]+$/, '').slice(0, 400);
    if (clean.length < 3) return null;
    const type = /\b(prefer|like|love|hate|want|always|never|don'?t|call me|reply|answer|respond|format|tone|style)\b/i.test(clean) ? 'preference'
      : /\b(i am|i'm|my name|years old|i live|i work|i study|i go to)\b/i.test(clean) ? 'profile'
      : /\b(building|project|working on|app|launch|deadline|startup|repo)\b/i.test(clean) ? 'project' : 'fact';
    const body = thirdPerson(clean);
    const words = body.replace(/^User (is |has )?/, '').split(/\s+/).slice(0, 7).join(' ');
    const title = (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, MAX_TITLE);
    // Same topic already stored → fold into it instead of duplicating.
    const near = recall(clean, { core: false, touch: false, emit: false, k: 1, minRel: 0.5 }).hits[0];
    const f = near && files.get(near.path);
    const op = f
      ? { op: 'update', path: f.path, type: f.type, title: f.title, tags: f.tags, importance: Math.max(f.importance, 0.8), body: (f.body + '\n- ' + body).slice(-MAX_BODY) }
      : { op: 'add', path: type + '/' + slug(title), type, title, tags: tokens(clean).slice(0, 4), importance: 0.8, body: '- ' + body, source: 'explicit' };
    const done = applyOps([op], 'explicit');
    return done[0] ? files.get(done[0].path) : null;
  }

  function forget(text) {
    if (!files.size) return null;
    const hit = recall(text, { core: false, touch: false, emit: false, k: 1, minRel: 0.3 }).hits[0];
    if (!hit) return null;
    const f = files.get(hit.path);
    applyOps([{ op: 'delete', path: hit.path }], 'explicit');
    return f || null;
  }

  /* ── background extraction ── */
  function quotaOK() {
    let q;
    try { q = JSON.parse(lsGet(LS_QUOTA) || '{}'); } catch (_) { q = {}; }
    if (q.d !== today()) q = { d: today(), n: 0 };
    if (q.n >= EXTRACT_DAILY) return false;
    q.n++;
    lsSet(LS_QUOTA, JSON.stringify(q));
    return true;
  }
  function quota() {
    try { const q = JSON.parse(lsGet(LS_QUOTA) || '{}'); return { used: q.d === today() ? q.n || 0 : 0, cap: EXTRACT_DAILY }; }
    catch (_) { return { used: 0, cap: EXTRACT_DAILY }; }
  }

  // Notes an extraction call should see so it updates instead of duplicating:
  // the ones related to `text` plus the strongest identity/preference notes.
  function related(text, n) {
    const rel = recall(text, { core: false, touch: false, emit: false, k: 10, budget: 3000, minRel: 0.12 }).hits.map((h) => files.get(h.path));
    const core = [...files.values()].filter(isCore).sort((a, b) => b.importance - a.importance).slice(0, 4);
    return [...new Set([...rel, ...core])].filter(Boolean).slice(0, n || 14)
      .map((f) => ({ path: f.path, title: f.title, type: f.type, tags: f.tags, body: f.body }));
  }

  // Call after each completed turn. Only turns with a self-disclosure signal
  // are queued, so most turns cost nothing.
  function observe(turn) {
    if (!enabled() || !turn || !turn.user) return;
    if (!SIGNAL.test(turn.user)) return;
    pending.push({ user: String(turn.user).slice(0, 1800), assistant: String(turn.assistant || '').slice(0, 500) });
    if (pending.length > 8) pending = pending.slice(-8);
    clearTimeout(extractTimer);
    extractTimer = setTimeout(runExtract, pending.length >= EXTRACT_BATCH ? 1500 : EXTRACT_IDLE_MS);
    emit('queue', { pending: pending.length });
  }

  // Chat switch / tab hidden: don't wait for the idle timer.
  function flush() { if (pending.length) { clearTimeout(extractTimer); runExtract(); } }

  async function runExtract() {
    if (extracting || !pending.length || !enabled()) return;
    const gap = Date.now() - lastExtract;
    if (gap < EXTRACT_GAP_MS) { clearTimeout(extractTimer); extractTimer = setTimeout(runExtract, EXTRACT_GAP_MS - gap); return; }
    if (!quotaOK()) { pending = []; log('inf', 'daily extraction cap reached'); return; }
    const batch = pending.splice(0, 6);
    extracting = true;
    lastExtract = Date.now();
    emit('extracting', { turns: batch.length });
    try {
      const existing = related(batch.map((t) => t.user).join('\n'), 14);
      const res = await fetch(API + '/v1/memory/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turns: batch, existing, today: today() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
      const done = applyOps((d.ops || []).map((o) => Object.assign({}, o, { source: 'auto' })), 'auto');
      emit('extracted', { ops: done });
      log('inf', 'extract: ' + done.length + ' change(s)');
    } catch (e) {
      if (!batch._retried) { batch._retried = true; pending.unshift(...batch); }
      emit('extracted', { ops: [], error: e.message });
      log('err', 'extract failed: ' + e.message);
    } finally {
      extracting = false;
      if (pending.length) { clearTimeout(extractTimer); extractTimer = setTimeout(runExtract, EXTRACT_IDLE_MS); }
    }
  }

  /* ── MEMORY.md index + import/export ── */
  function sortedFiles() {
    return [...files.values()].sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || b.importance - a.importance || a.title.localeCompare(b.title));
  }
  function indexMarkdown() {
    const list = sortedFiles();
    let out = '# MEMORY.md\n\n_' + list.length + ' memor' + (list.length === 1 ? 'y' : 'ies') + ' · generated ' + today() + '. One line per file; open a file to see it in full._\n';
    TYPES.forEach((t) => {
      const of = list.filter((f) => f.type === t);
      if (!of.length) return;
      out += '\n## ' + TYPE_LABEL[t] + '\n';
      of.forEach((f) => { out += '- [' + f.title + '](' + f.path + ') — ' + oneLine(f.body).slice(0, 110) + '\n'; });
    });
    return out;
  }
  function exportMarkdown() {
    return indexMarkdown() + sortedFiles().map((f) => '\n<!-- file: ' + f.path + ' -->\n' + toMd(f)).join('');
  }
  function importMarkdown(text, filename) {
    const src = String(text || '');
    const parts = src.split(/<!--\s*file:\s*([^\s>]+)\s*-->/);
    const chunks = [];
    if (parts.length > 1) for (let i = 1; i < parts.length; i += 2) chunks.push({ path: parts[i], raw: parts[i + 1] || '' });
    else chunks.push({ path: String(filename || 'fact/imported').replace(/^.*[\\/]/, ''), raw: src });
    const ops = chunks.map(({ path, raw }) => {
      const f = parseMd(raw.trim(), path);
      if (!f.path || !f.body) return null;
      return { op: files.has(f.path) ? 'update' : 'add', path: f.path, type: f.type, title: f.title, tags: f.tags, importance: f.importance, body: f.body, source: 'import' };
    }).filter(Boolean);
    return applyOps(ops, 'import');
  }

  window.CloakMemory = {
    TYPES, TYPE_LABEL,
    init, reset, enabled, setEnabled,
    recall, observe, flush, probe, extend, related,
    detectCommand, remember, forget,
    applyOps, saveFile, removeFile,
    list: sortedFiles,
    get: (p) => files.get(p) || null,
    raw: (p) => (files.get(p) ? toMd(files.get(p)) : ''),
    size: () => files.size,
    lastRecall: () => lastRecall,
    pending: () => pending.length,
    busy: () => extracting,
    quota,
    remote: () => !!remoteOn(),
    loaded: () => loaded,
    guest: () => !!owner.guest,
    indexMarkdown, exportMarkdown, importMarkdown,
    parseMd, toMd, tokens, est,
    on, off,
  };
})();
