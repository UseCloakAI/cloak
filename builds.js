/* ════════════════════════════════════════════════════════
   CLOAK BUILDS — code blocks, the Builds panel, the editor
   and code-file attachments.

   • Code blocks: filename-aware header (lang · file · lines),
     real highlighting (highlight.js), Copy / Download / Edit /
     Run. Replaces cloak.js's marked code renderer.
   • Builds (Cloak's artifacts): a complete HTML page, React
     component (jsx/tsx), SVG or Mermaid diagram renders as a
     build card. While streaming it shows the tail of the code
     being written; once done it opens in the Builds panel.
   • Builds panel: Preview / Code / Console, versions (every
     revision Cloak writes or you run is kept), copy, download,
     export, fullscreen, "Ask Cloak to change…", and a fix loop:
     runtime errors surface in a banner with "Fix with Cloak",
     and a fresh build that throws is auto-repaired (max 2/build).
   • Runners: every build runs in a sandboxed iframe WITHOUT
     allow-same-origin (opaque origin — no access to Cloak's
     storage or session). React builds compile with Babel in the
     page, import npm packages from esm.sh and resolve sibling
     files from the same message (multi-file apps). JS/TS and
     Python (Pyodide) run with an output terminal.
   • Editor: CodeMirror 5, lazy-loaded the first time the Code
     tab opens; plain textarea fallback. Cmd/Ctrl+Enter runs.
   • Attachments: + menu → Attach code files, or drop files on
     the composer. Sent as "[file: name]" + fenced block; the user
     bubble shows chips instead of the raw text.
   Load after cloak.js (patches postProcessBotEl / addMsg / onInput)
   and wraps send() once search-patch.js has installed it.
   ════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const JSD = 'https://cdn.jsdelivr.net/npm/';
  const CDN = {
    babel: JSD + '@babel/standalone@7.29.9/babel.min.js',
    cm: JSD + 'codemirror@5.65.21/',
    mermaid: JSD + 'mermaid@11.17.2/dist/mermaid.esm.min.mjs',
    pyodide: 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/',
    esm: 'https://esm.sh/',
    tailwind: 'https://cdn.tailwindcss.com',
  };
  const REACT = '18.3.1';
  const MAX_AUTOFIX = 2;
  const FILE_MAX = 80 * 1024, FILES_TOTAL = 160 * 1024, FILES_N = 6;

  /* ── LANGUAGES ─────────────────────────────────────────── */
  const ALIAS = {
    js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
    ts: 'typescript', typescript: 'typescript', mts: 'typescript',
    jsx: 'jsx', tsx: 'tsx', react: 'jsx',
    html: 'html', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html',
    svg: 'svg', xml: 'xml', css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    py: 'python', python: 'python', python3: 'python', py3: 'python',
    md: 'markdown', markdown: 'markdown', mermaid: 'mermaid', mmd: 'mermaid',
    json: 'json', jsonc: 'json', sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash',
    sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini',
    go: 'go', golang: 'go', rust: 'rust', rs: 'rust', java: 'java', kotlin: 'kotlin', kt: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', csharp: 'csharp',
    rb: 'ruby', ruby: 'ruby', php: 'php', swift: 'swift', lua: 'lua', r: 'r', dart: 'dart',
    dockerfile: 'dockerfile', docker: 'dockerfile', makefile: 'makefile', make: 'makefile',
    diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql',
    txt: 'plaintext', text: 'plaintext', plaintext: 'plaintext', plain: 'plaintext', output: 'plaintext', '': 'plaintext',
  };
  const LABEL = {
    javascript: 'JavaScript', typescript: 'TypeScript', jsx: 'React', tsx: 'React TS', html: 'HTML', svg: 'SVG',
    css: 'CSS', scss: 'SCSS', python: 'Python', markdown: 'Markdown', mermaid: 'Mermaid', json: 'JSON',
    bash: 'Shell', sql: 'SQL', yaml: 'YAML', plaintext: 'Text', csharp: 'C#', cpp: 'C++',
  };
  const EXT = {
    javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx', html: 'html', svg: 'svg', xml: 'xml', css: 'css',
    scss: 'scss', less: 'less', python: 'py', markdown: 'md', mermaid: 'mmd', json: 'json', bash: 'sh', sql: 'sql',
    yaml: 'yml', ini: 'toml', go: 'go', rust: 'rs', java: 'java', kotlin: 'kt', c: 'c', cpp: 'cpp', csharp: 'cs',
    ruby: 'rb', php: 'php', swift: 'swift', lua: 'lua', r: 'r', dart: 'dart', diff: 'diff', graphql: 'graphql',
    plaintext: 'txt', dockerfile: 'Dockerfile', makefile: 'Makefile',
  };
  // Previewable in the panel / runnable with an output terminal.
  const PREVIEW = new Set(['html', 'svg', 'jsx', 'tsx', 'mermaid', 'markdown']);
  const SCRIPT = new Set(['javascript', 'typescript', 'python']);
  const HL = { jsx: 'javascript', tsx: 'typescript', html: 'xml', svg: 'xml', mermaid: 'plaintext', dockerfile: 'bash' };

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const langOf = (l) => { l = String(l || '').toLowerCase(); return ALIAS[l] || l || 'plaintext'; };
  const label = (l) => LABEL[l] || (l ? l[0].toUpperCase() + l.slice(1) : 'Text');
  const extLang = (f) => { const m = /\.([\w+]+)$/.exec(f || ''); return m ? langOf(m[1]) : (/^dockerfile$/i.test(f) ? 'dockerfile' : ''); };
  const baseName = (f) => String(f || '').split('/').pop();
  const lineCount = (s) => (s ? s.replace(/\n$/, '').split('\n').length : 0);
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const isDark = () => document.documentElement.classList.contains('dark');

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // Parses a fence info string: ```js · ```js title="app.js" · ```js app.js · ```js:app.js · ```app.js
  function parseInfo(info) {
    info = String(info || '').trim();
    let lang = (/^[^\s{:]+/.exec(info) || [''])[0];
    let file = '';
    const t = /(?:title|file|filename|name)\s*=\s*["']?([^"'\s}]+)/i.exec(info);
    if (t) file = t[1];
    else if (/^[\w+#-]+:[\w./@-]+$/.test(info)) { const i = info.indexOf(':'); file = info.slice(i + 1); lang = info.slice(0, i); }
    else {
      const rest = info.slice(lang.length).trim();
      if (/^[\w./@-]+\.[\w]+$/.test(rest)) file = rest;
    }
    if (/\.[\w]+$/.test(lang) && !ALIAS[lang.toLowerCase()]) { file = file || lang; lang = ''; }
    const l = langOf(lang) === 'plaintext' && file ? (extLang(file) || 'plaintext') : langOf(lang);
    return { lang: l, file };
  }

  // Is this block a whole build (card + panel), or a snippet (plain code block)?
  function buildKind(lang, code, file) {
    if (lang === 'html') return /<!doctype|<html[\s>]|<body[\s>]/i.test(code) || (code.length > 500 && /<(script|style)[\s>]/i.test(code)) ? 'html' : '';
    if (lang === 'svg' || (lang === 'xml' && /^\s*<svg[\s>]/.test(code))) return /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(code) ? 'svg' : '';
    if (lang === 'jsx' || lang === 'tsx') {
      // components/Button.jsx in a multi-file answer is a part, not the build.
      if (file && file.includes('/') && !/^(App|Main|main|index|page)\.[jt]sx$/.test(baseName(file))) return '';
      return /export\s+default\b|createRoot\s*\(|ReactDOM\.render\s*\(/.test(code) && code.length > 120 ? 'react' : '';
    }
    if (lang === 'mermaid') return 'mermaid';
    return '';
  }
  function runKind(lang, code) {
    const b = buildKind(lang, code);
    if (b) return b;
    if (lang === 'jsx' || lang === 'tsx') return 'react';
    if (lang === 'html') return 'html';
    if (lang === 'svg') return 'svg';
    if (lang === 'markdown') return 'markdown';
    if (SCRIPT.has(lang)) return lang === 'python' ? 'python' : 'script';
    return '';
  }

  function titleFor(kind, code, file) {
    if (kind === 'html') {
      const m = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(code) || /<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(code);
      if (m && m[1].trim()) return m[1].trim();
    }
    if (kind === 'react') {
      const m = /export\s+default\s+(?:function|class)\s+([A-Z]\w*)/.exec(code) || /export\s+default\s+([A-Z]\w*)/.exec(code);
      if (m && !/^App$/.test(m[1])) return m[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    }
    if (kind === 'mermaid') {
      const m = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|quadrantChart|xychart-beta|sankey-beta|block-beta)/m.exec(code);
      const n = { graph: 'Flowchart', flowchart: 'Flowchart', sequenceDiagram: 'Sequence diagram', classDiagram: 'Class diagram', erDiagram: 'ER diagram', gantt: 'Gantt chart', pie: 'Pie chart', journey: 'User journey', mindmap: 'Mind map', timeline: 'Timeline', gitGraph: 'Git graph' };
      return m ? (n[m[1]] || m[1].replace(/-v2|-beta/, '').replace(/([a-z])([A-Z])/g, '$1 $2')) : 'Diagram';
    }
    if (file) return baseName(file);
    return { html: 'Web page', react: 'React app', svg: 'SVG graphic', python: 'Python script', script: 'Script', markdown: 'Document' }[kind] || 'Code';
  }

  /* ── HIGHLIGHT + RENDERER ──────────────────────────────── */
  function highlight(code, lang) {
    const h = window.hljs;
    const l = HL[lang] || lang;
    if (h && l !== 'plaintext' && h.getLanguage(l)) {
      try { return h.highlight(code, { language: l, ignoreIllegals: true }).value; } catch (_) {}
    }
    return esc(code);
  }

  const ICON = {
    copy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12"/><path d="M5 15H3V3h12v2"/></svg>',
    dl: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>',
    edit: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/></svg>',
    play: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
    eye: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    expand: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    reload: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    export: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
    file: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/></svg>',
    wrench: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/></svg>',
  };
  const KIND_ICON = {
    html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16"/></svg>',
    react: '<svg width="18" height="18" viewBox="-12 -12 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><ellipse rx="10" ry="4"/><ellipse rx="10" ry="4" transform="rotate(60)"/><ellipse rx="10" ry="4" transform="rotate(120)"/><circle r="1.8" fill="currentColor"/></svg>',
    svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 16H3z"/><circle cx="12" cy="14" r="2.2"/></svg>',
    mermaid: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="6"/><rect x="14" y="15" width="7" height="6"/><path d="M6.5 9v4.5a2 2 0 0 0 2 2H14"/></svg>',
  };

  function codeBlockHtml(code, info) {
    const p = parseInfo(info);
    const kind = buildKind(p.lang, code, p.file);
    const hl = highlight(code, p.lang);
    const n = lineCount(code);
    const attrs = ' data-lang="' + esc(p.lang) + '"' + (p.file ? ' data-file="' + esc(p.file) + '"' : '');
    if (kind) {
      const title = titleFor(kind, code, p.file);
      return '<div class="bld" data-kind="' + kind + '"' + attrs + '>' +
        '<div class="bld-head">' +
          '<span class="bld-ic">' + (KIND_ICON[kind] || KIND_ICON.html) + '</span>' +
          '<span class="bld-meta"><span class="bld-title">' + esc(title) + '</span>' +
          '<span class="bld-sub"><span class="bld-state">Writing</span><span class="bld-dots" aria-hidden="true"><i></i><i></i><i></i></span> · ' + esc(label(p.lang)) + ' · <span class="bld-n">' + n + '</span> lines</span></span>' +
          '<button class="bld-open" type="button" data-act="open">' + ICON.eye + '<span>Open</span></button>' +
        '</div>' +
        '<div class="bld-tail"><pre class="cb-pre"><code class="hljs">' + hl + '</code></pre></div>' +
        '<div class="bld-foot">' +
          '<button type="button" class="bld-lnk" data-act="toggle">Show code</button>' +
          '<button type="button" class="bld-lnk" data-act="copy">Copy</button>' +
          '<button type="button" class="bld-lnk" data-act="download">Download</button>' +
        '</div>' +
      '</div>';
    }
    const rk = runKind(p.lang, code);
    const run = rk ? '<button class="code-btn cb-run" type="button" data-act="run" title="' + (PREVIEW.has(p.lang) ? 'Preview' : 'Run') + '">' + (PREVIEW.has(p.lang) ? ICON.eye : ICON.play) + '<span>' + (PREVIEW.has(p.lang) ? 'Preview' : 'Run') + '</span></button>' : '';
    return '<pre class="cb"' + attrs + '><div class="code-bar">' +
      '<span class="cb-id"><span class="code-lang">' + esc(label(p.lang)) + '</span>' + (p.file ? '<span class="cb-file">' + esc(p.file) + '</span>' : '') + (n > 1 ? '<span class="cb-n">' + n + ' lines</span>' : '') + '</span>' +
      '<div class="code-actions">' + run +
        '<button class="code-btn" type="button" data-act="edit" title="Open in editor" aria-label="Open in editor">' + ICON.edit + '</button>' +
        '<button class="code-btn" type="button" data-act="download" title="Download" aria-label="Download">' + ICON.dl + '</button>' +
        '<button class="code-btn cb-copy" type="button" data-act="copy" title="Copy" aria-label="Copy">' + ICON.copy + '<span>Copy</span></button>' +
      '</div></div><code class="hljs">' + hl + '</code></pre>';
  }

  if (window.marked) marked.use({ renderer: { code: (code, info) => codeBlockHtml(String(code || '').replace(/\n$/, ''), info) } });

  // Block → { code, lang, file, kind } from its rendered element.
  function blockData(el) {
    const code = (el.querySelector('code') || {}).textContent || '';
    const lang = el.dataset.lang || 'plaintext';
    return { code, lang, file: el.dataset.file || '', kind: el.dataset.kind || runKind(lang, code) };
  }

  /* ── STATE ─────────────────────────────────────────────── */
  // builds: id → { id, kind, lang, file, title, versions: [{ code, src, msgEl, live, at }], autoFix }
  const S = {
    builds: new Map(), cur: null, v: 0, tab: 'preview', pending: null, liveMsgs: new WeakSet(),
    files: [], log: [], errs: [], token: '', dirty: false, fixTimer: 0, mode: '',
  };

  function newId() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function findLineage(kind, file, title) {
    let hit = null;
    S.builds.forEach((b) => {
      if (b.kind !== kind) return;
      if (file ? b.file === file : (!b.file && b.title === title)) hit = b;
    });
    return hit;
  }

  // Registers every build block in a finished bot message.
  function scan(msgEl) {
    const bc = msgEl && msgEl.querySelector('.bot-content');
    if (!bc) return;
    const live = S.liveMsgs.has(msgEl);
    const seen = msgEl._bseen || (msgEl._bseen = new Map());
    let last = null;
    bc.querySelectorAll('.bld').forEach((el) => {
      const d = blockData(el);
      if (!d.code.trim()) return;
      const key = hash(d.code);
      const title = titleFor(d.kind, d.code, d.file);
      let ref = seen.get(key);
      if (!ref) {
        let b = findLineage(d.kind, d.file, title);
        if (!b && live && S.pending && S.builds.has(S.pending) && S.builds.get(S.pending).kind === d.kind) b = S.builds.get(S.pending);
        if (!b) {
          b = { id: newId(), kind: d.kind, lang: d.lang, file: d.file, title, versions: [], autoFix: 0 };
          S.builds.set(b.id, b);
        }
        b.title = title; b.lang = d.lang;
        b.versions.push({ code: d.code, src: live && S.pending === b.id && S.fixing ? 'fix' : 'cloak', msgEl, live, at: Date.now() });
        ref = { id: b.id, v: b.versions.length - 1 };
        seen.set(key, ref);
      }
      const b = S.builds.get(ref.id);
      el.dataset.bid = ref.id; el.dataset.v = ref.v;
      el.classList.add('ready');
      const st = el.querySelector('.bld-state');
      if (st) st.textContent = b.versions.length > 1 ? 'Version ' + (ref.v + 1) : 'Build';
      last = ref;
    });
    if (live) { S.pending = null; S.fixing = false; }
    if (last && live) {
      const b = S.builds.get(last.id);
      const showing = S.cur && S.cur.id === last.id && isOpen();
      if (showing || splitRoom()) open(last.id, last.v, 'preview');
    }
  }

  // Drop builds whose messages left the DOM (chat switch, edit, sign-out).
  function prune() {
    S.builds.forEach((b, id) => {
      b.versions = b.versions.filter((v) => !v.msgEl || v.msgEl.isConnected || v.src === 'edit');
      if (!b.versions.some((v) => v.msgEl && v.msgEl.isConnected)) S.builds.delete(id);
    });
    if (S.cur && S.cur.transient && S.cur.msgEl && !S.cur.msgEl.isConnected) close();
    else if (S.cur && !S.cur.transient && !S.builds.has(S.cur.id)) close();
  }

  /* ── PANEL ─────────────────────────────────────────────── */
  let P = null; // panel elements
  function panel() {
    if (P) return P;
    const shell = $('.chat-shell') || document.body;
    const el = document.createElement('aside');
    el.className = 'bp';
    el.id = 'build-panel';
    el.setAttribute('aria-label', 'Build');
    el.hidden = true;
    el.innerHTML =
      '<div class="bp-resize" title="Drag to resize" aria-hidden="true"></div>' +
      '<div class="bp-top">' +
        '<div class="bp-id"><span class="bp-ic" aria-hidden="true"></span><span class="bp-title-wrap"><span class="bp-title"></span><span class="bp-sub"></span></span></div>' +
        '<div class="bp-ver" hidden><button type="button" class="bp-vb" data-bp="prev" aria-label="Previous version">&lsaquo;</button><span class="bp-vl"></span><button type="button" class="bp-vb" data-bp="next" aria-label="Next version">&rsaquo;</button></div>' +
        '<div class="bp-acts">' +
          '<button class="icon-btn bp-btn" type="button" data-bp="copy" title="Copy code" aria-label="Copy code">' + ICON.copy + '</button>' +
          '<button class="icon-btn bp-btn" type="button" data-bp="download" title="Download source" aria-label="Download source">' + ICON.dl + '</button>' +
          '<button class="icon-btn bp-btn" type="button" data-bp="export" title="Export as a standalone .html" aria-label="Export as HTML">' + ICON.export + '</button>' +
          '<button class="icon-btn bp-btn bp-full" type="button" data-bp="full" title="Focus" aria-label="Toggle focus mode">' + ICON.expand + '</button>' +
          '<button class="icon-btn bp-btn" type="button" data-bp="close" title="Close" aria-label="Close build panel">' + ICON.close + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="bp-bar">' +
        '<div class="bp-tabs" role="tablist">' +
          '<button type="button" role="tab" class="bp-tab" data-tab="preview">Preview</button>' +
          '<button type="button" role="tab" class="bp-tab" data-tab="code">Code</button>' +
          '<button type="button" role="tab" class="bp-tab" data-tab="console">Console<span class="bp-count" hidden></span></button>' +
        '</div>' +
        '<div class="bp-bar-r">' +
          '<span class="bp-dirty" hidden>Edited</span>' +
          '<button type="button" class="bp-mini" data-bp="revert" hidden>Revert</button>' +
          '<button type="button" class="bp-run" data-bp="run" title="Run (Ctrl/Cmd+Enter)">' + ICON.reload + '<span>Run</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="bp-body">' +
        '<div class="bp-view bp-preview" data-view="preview">' +
          '<div class="bp-stage"></div>' +
          '<div class="bp-load" hidden><span class="bp-spin" aria-hidden="true"></span><span class="bp-load-t">Starting…</span></div>' +
          '<div class="bp-err" role="alert" hidden><div class="bp-err-t"><strong class="bp-err-h"></strong><code class="bp-err-m"></code></div>' +
            '<div class="bp-err-a"><button type="button" class="bp-fix" data-bp="fix">' + ICON.wrench + '<span>Fix with Cloak</span></button><button type="button" class="bp-mini" data-bp="dismiss">Dismiss</button></div></div>' +
        '</div>' +
        '<div class="bp-view bp-code" data-view="code" hidden><div class="bp-editor"></div></div>' +
        '<div class="bp-view bp-console" data-view="console" hidden><ol class="bp-log" aria-live="polite"></ol><div class="bp-log-empty">Nothing logged yet.</div></div>' +
      '</div>' +
      '<form class="bp-ask" autocomplete="off"><input class="bp-ask-in" type="text" placeholder="Ask Cloak to change this build…" aria-label="Ask Cloak to change this build" maxlength="2000">' +
        '<button type="submit" class="bp-ask-go" aria-label="Send change request"><svg width="13" height="13" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z"/></svg></button></form>';
    shell.appendChild(el);
    P = {
      el, title: $('.bp-title', el), sub: $('.bp-sub', el), ic: $('.bp-ic', el), ver: $('.bp-ver', el), vl: $('.bp-vl', el),
      stage: $('.bp-stage', el), load: $('.bp-load', el), loadT: $('.bp-load-t', el), err: $('.bp-err', el),
      errH: $('.bp-err-h', el), errM: $('.bp-err-m', el), log: $('.bp-log', el), count: $('.bp-count', el),
      editor: $('.bp-editor', el), dirty: $('.bp-dirty', el), revert: $('[data-bp="revert"]', el), run: $('[data-bp="run"]', el),
      ask: $('.bp-ask', el), askIn: $('.bp-ask-in', el), exp: $('[data-bp="export"]', el),
    };
    el.addEventListener('click', onPanelClick);
    P.ask.addEventListener('submit', (e) => { e.preventDefault(); askChange(P.askIn.value); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.target.closest('.CodeMirror')) { e.preventDefault(); if (el.classList.contains('bp-max')) toggleFull(false); else close(); }
    });
    initResize($('.bp-resize', el));
    return P;
  }

  function isOpen() { return !!(P && !P.el.hidden); }

  // Room for chat + panel side by side? (else the panel overlays the chat)
  function splitRoom() {
    const shell = $('.chat-shell');
    if (!shell || window.innerWidth < 900) return false;
    const sb = $('.sidebar');
    const sbw = sb && getComputedStyle(sb).position !== 'fixed' ? sb.offsetWidth : 0;
    return shell.clientWidth - sbw - 380 >= 380;
  }

  function layout() {
    if (!isOpen()) return;
    const shell = $('.chat-shell');
    const split = splitRoom() && !P.el.classList.contains('bp-max');
    S.mode = split ? 'split' : 'overlay';
    P.el.classList.toggle('bp-over', !split);
    shell.classList.toggle('bp-open', split);
    if (split) {
      const sb = $('.sidebar');
      const room = shell.clientWidth - (sb ? sb.offsetWidth : 0) - 380;
      let w = 0;
      try { w = +localStorage.getItem('cloak_bp_w') || 0; } catch (_) {}
      if (!w) w = Math.round((shell.clientWidth - (sb ? sb.offsetWidth : 0)) * 0.52);
      P.el.style.width = Math.max(380, Math.min(w, room)) + 'px';
    } else P.el.style.width = '';
  }

  function initResize(h) {
    h.addEventListener('pointerdown', (e) => {
      if (S.mode !== 'split') return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const shell = $('.chat-shell');
      P.el.classList.add('resizing');
      const move = (ev) => {
        const sb = $('.sidebar');
        const room = shell.clientWidth - (sb ? sb.offsetWidth : 0) - 380;
        const w = Math.max(380, Math.min(shell.getBoundingClientRect().right - ev.clientX, room));
        P.el.style.width = w + 'px';
      };
      const up = () => {
        P.el.classList.remove('resizing');
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        try { localStorage.setItem('cloak_bp_w', parseInt(P.el.style.width, 10)); } catch (_) {}
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
  }

  function cur() {
    if (!S.cur) return null;
    if (S.cur.transient) return S.cur;
    return S.builds.get(S.cur.id) || null;
  }
  function curVer() {
    const b = cur();
    return b ? b.versions[Math.min(S.v, b.versions.length - 1)] : null;
  }
  function curCode() {
    if (S.dirty && S.editor) return S.editor.get();
    const v = curVer();
    return v ? v.code : '';
  }

  // Opens a registered build at version v (default: latest).
  function open(id, v, tab) {
    const b = S.builds.get(id);
    if (!b) return;
    S.cur = { id };
    S.v = v == null ? b.versions.length - 1 : Math.max(0, Math.min(v, b.versions.length - 1));
    show(tab || 'preview');
  }

  // Opens a loose snippet (not a build) — Edit / Run / Preview on a code block or file chip.
  function openLoose(d, tab, msgEl) {
    const kind = runKind(d.lang, d.code);
    S.cur = {
      transient: true, id: 'loose', kind: kind || 'code', lang: d.lang, file: d.file, msgEl,
      title: d.file ? baseName(d.file) : (kind ? titleFor(kind, d.code, d.file) : label(d.lang) + ' snippet'),
      versions: [{ code: d.code, src: 'cloak' }],
    };
    S.v = 0;
    show(tab || (kind ? 'preview' : 'code'));
  }

  function show(tab) {
    panel();
    const b = cur();
    if (!b) return;
    const wasOpen = isOpen();
    S.dirty = false;
    P.el.hidden = false;
    P.el.dataset.kind = b.kind;
    const runnable = b.kind !== 'code';
    P.el.classList.toggle('no-run', !runnable);
    P.ic.innerHTML = KIND_ICON[b.kind] || (runnable ? ICON.play : ICON.file);
    P.title.textContent = b.title;
    P.exp.hidden = !(b.kind === 'react' || b.kind === 'svg' || b.kind === 'mermaid' || b.kind === 'markdown');
    $('.bp-tab[data-tab="preview"]', P.el).textContent = b.kind === 'script' || b.kind === 'python' ? 'Output' : 'Preview';
    updateVersion();
    if (!wasOpen) {
      P.el.classList.remove('bp-max');
      layout();
      P.el.classList.remove('bp-in'); void P.el.offsetWidth; P.el.classList.add('bp-in');
      if (typeof syncThemeColor === 'function') try { syncThemeColor(); } catch (_) {}
    }
    setTab(runnable ? tab : 'code');
    if (runnable) run();
    else loadEditor();
  }

  function updateVersion() {
    const b = cur();
    const n = b.versions.length;
    const v = b.versions[S.v];
    P.ver.hidden = n < 2;
    P.vl.textContent = 'v' + (S.v + 1) + ' / ' + n;
    $('[data-bp="prev"]', P.el).disabled = S.v <= 0;
    $('[data-bp="next"]', P.el).disabled = S.v >= n - 1;
    const src = v.src === 'edit' ? 'Your edit' : v.src === 'fix' ? 'Fixed by Cloak' : '';
    P.sub.textContent = [label(b.lang), lineCount(v.code) + ' lines', src].filter(Boolean).join(' · ');
    setDirty(false);
    if (S.editor) S.editor.set(v.code, b.lang);
  }

  function setTab(t) {
    S.tab = t;
    P.el.querySelectorAll('.bp-tab').forEach((x) => { const on = x.dataset.tab === t; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); });
    P.el.querySelectorAll('.bp-view').forEach((x) => { x.hidden = x.dataset.view !== t; });
    if (t === 'code') loadEditor();
    if (t === 'console') renderLog();
  }

  function close() {
    if (!P) return;
    clearTimeout(S.fixTimer);
    P.el.hidden = true;
    P.el.classList.remove('bp-max', 'bp-over');
    const shell = $('.chat-shell');
    if (shell) shell.classList.remove('bp-open');
    P.stage.innerHTML = '';
    S.token = '';
    S.cur = null;
    if (typeof syncThemeColor === 'function') try { syncThemeColor(); } catch (_) {}
  }

  function toggleFull(on) {
    const full = on == null ? !P.el.classList.contains('bp-max') : on;
    P.el.classList.toggle('bp-max', full);
    layout();
  }

  function onPanelClick(e) {
    const t = e.target.closest('[data-bp],[data-tab]');
    if (!t) return;
    if (t.dataset.tab) return setTab(t.dataset.tab);
    const b = cur();
    switch (t.dataset.bp) {
      case 'close': return close();
      case 'full': return toggleFull();
      case 'prev': case 'next':
        S.v += t.dataset.bp === 'next' ? 1 : -1;
        updateVersion();
        return b.kind !== 'code' && run();
      case 'copy': return copyText(curCode(), t);
      case 'download': return download(curCode(), fileNameFor(b));
      case 'export': {
        const code = curCode();
        const name = (b.file ? baseName(b.file).replace(/\.\w+$/, '') : slug(b.title)) + '.html';
        const go = () => { try { download(docFor(b.kind, code, 'export', b).html, name, 'text/html'); } catch (e) { toast('Export failed: ' + e.message); } };
        return b.kind === 'react' && !window.Babel ? loadBabel().then(go, () => toast('Couldn\'t load the compiler')) : go();
      }
      case 'run': return commitAndRun();
      case 'revert': updateVersion(); return;
      case 'fix': return fix(false);
      case 'dismiss': P.err.hidden = true; clearTimeout(S.fixTimer); return;
    }
  }

  /* ── EDITOR (CodeMirror 5, lazy) ───────────────────────── */
  const CM_MODE = {
    javascript: 'javascript', typescript: 'text/typescript', jsx: 'jsx', tsx: 'text/typescript-jsx', html: 'htmlmixed',
    svg: 'xml', xml: 'xml', css: 'css', scss: 'text/x-scss', less: 'text/x-less', python: 'python', markdown: 'markdown',
    json: 'application/json', java: 'text/x-java', c: 'text/x-csrc', cpp: 'text/x-c++src', csharp: 'text/x-csharp',
    kotlin: 'text/x-kotlin', go: 'go', rust: 'rust', sql: 'sql', bash: 'shell', yaml: 'yaml', php: 'php', ruby: 'ruby', swift: 'swift',
  };
  let cmLoading = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = false; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }
  function loadCM() {
    if (window.CodeMirror && window.CodeMirror.modes && window.CodeMirror.modes.jsx) return Promise.resolve();
    if (cmLoading) return cmLoading;
    const b = CDN.cm;
    loadCss(b + 'lib/codemirror.min.css');
    cmLoading = loadScript(b + 'lib/codemirror.min.js')
      .then(() => loadScript(b + 'addon/mode/simple.min.js').catch(() => {})) // rust mode needs defineSimpleMode
      .then(() => Promise.all(['xml', 'javascript', 'css', 'python', 'markdown', 'clike', 'go', 'rust', 'sql', 'shell', 'yaml', 'ruby', 'swift']
        .map((m) => loadScript(b + 'mode/' + m + '/' + m + '.min.js').catch(() => {}))))
      .then(() => Promise.all(['htmlmixed', 'jsx', 'php'].map((m) => loadScript(b + 'mode/' + m + '/' + m + '.min.js').catch(() => {}))))
      .then(() => Promise.all(['edit/closebrackets', 'edit/matchbrackets', 'edit/closetag', 'selection/active-line', 'comment/comment', 'search/searchcursor']
        .map((a) => loadScript(b + 'addon/' + a + '.min.js').catch(() => {}))));
    cmLoading.catch(() => { cmLoading = null; });
    return cmLoading;
  }

  function loadEditor() {
    if (S.editor) {
      const v = curVer();
      if (v && !S.dirty) S.editor.set(v.code, cur().lang);
      S.editor.refresh();
      return;
    }
    const host = P.editor;
    host.innerHTML = '<div class="bp-ed-wait">Loading editor…</div>';
    loadCM().then(() => {
      if (S.editor || !window.CodeMirror) throw new Error('no-cm');
      host.innerHTML = '';
      const cm = CodeMirror(host, {
        value: '', lineNumbers: true, indentUnit: 2, tabSize: 2, indentWithTabs: false, lineWrapping: false,
        autoCloseBrackets: true, matchBrackets: true, autoCloseTags: true, styleActiveLine: true,
        theme: 'cloak', viewportMargin: 40,
        extraKeys: {
          'Cmd-Enter': commitAndRun, 'Ctrl-Enter': commitAndRun, 'Cmd-S': commitAndRun, 'Ctrl-S': commitAndRun,
          'Cmd-/': 'toggleComment', 'Ctrl-/': 'toggleComment',
          Tab: (c) => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ', 'end')),
          'Shift-Tab': (c) => c.indentSelection('subtract'),
          Esc: () => { P.el.focus(); },
        },
      });
      let quiet = false;
      cm.on('change', () => { if (!quiet) setDirty(true); });
      S.editor = {
        get: () => cm.getValue(),
        set: (code, lang) => { quiet = true; cm.setOption('mode', CM_MODE[lang] || null); if (cm.getValue() !== code) cm.setValue(code); cm.clearHistory(); quiet = false; },
        refresh: () => setTimeout(() => cm.refresh(), 0),
        focus: () => cm.focus(),
      };
      const v = curVer();
      if (v) S.editor.set(v.code, cur().lang);
      S.editor.refresh();
    }).catch(() => {
      if (S.editor) return;
      host.innerHTML = '';
      const ta = document.createElement('textarea');
      ta.className = 'bp-ta';
      ta.spellcheck = false;
      ta.setAttribute('aria-label', 'Code editor');
      host.appendChild(ta);
      let quiet = false;
      ta.addEventListener('input', () => { if (!quiet) setDirty(true); });
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 's')) { e.preventDefault(); commitAndRun(); }
        else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
      });
      S.editor = {
        get: () => ta.value,
        set: (code) => { quiet = true; ta.value = code; quiet = false; },
        refresh: () => {}, focus: () => ta.focus(),
      };
      const v = curVer();
      if (v) S.editor.set(v.code);
    });
  }

  function setDirty(on) {
    S.dirty = on;
    if (!P) return;
    P.dirty.hidden = !on;
    P.revert.hidden = !on;
    P.run.classList.toggle('hot', on);
  }

  // Edited code becomes a new version, then runs.
  function commitAndRun() {
    const b = cur();
    if (!b) return;
    if (S.dirty && S.editor) {
      const code = S.editor.get();
      const v = curVer();
      if (code !== v.code) {
        b.versions.push({ code, src: 'edit', msgEl: null, at: Date.now() });
        S.v = b.versions.length - 1;
        updateVersion();
      }
      setDirty(false);
    }
    if (b.kind === 'code') return;
    setTab('preview');
    run();
  }

  /* ── RUNNERS ───────────────────────────────────────────── */
  const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock';

  // One line, injected right after <head>, so error line numbers stay true.
  function bridge(token, names) {
    const js = '(function(){var T=' + JSON.stringify(token) + ',N=' + JSON.stringify(names || {}) +
      ';function nm(s){s=String(s||"");for(var k in N)s=s.split(k).join(N[k]);return s.replace(/data:text\\/javascript[^\\s)]*/g,"build")}' +
      'function s(t,a){try{parent.postMessage({__cb:T,type:t,args:a},"*")}catch(e){}}' +
      'function f(v){try{if(v instanceof Error)return nm(v.stack&&v.stack.indexOf(v.message)>-1?v.stack:v.name+": "+v.message+(v.stack?"\\n"+v.stack:""));if(typeof v==="object"&&v!==null){var c=[];return JSON.stringify(v,function(k,x){if(typeof x==="object"&&x!==null){if(c.indexOf(x)>-1)return"[Circular]";c.push(x)}if(typeof x==="function")return"[Function "+(x.name||"anonymous")+"]";if(x===undefined)return"undefined";return x},2)}return String(v)}catch(e){return String(v)}}' +
      '["log","info","warn","error","debug"].forEach(function(k){var o=console[k];console[k]=function(){var a=[].slice.call(arguments),t=a.map(f).join(" ");if(!/cdn\\.tailwindcss\\.com should not be used/.test(t)){s("console",{level:k,text:t});if(window.__cbOut)window.__cbOut(k,t)}return o&&o.apply(console,arguments)}});' +
      'window.__cbFatal=function(e,w){s("error",{text:(w?w+": ":"")+(e&&e.message?(e.name||"Error")+": "+e.message:String(e)),stack:nm(e&&e.stack||"")})};' +
      'addEventListener("error",function(e){var g=e.target;if(g&&g!==window&&(g.src||g.href)){s("console",{level:"warn",text:"Failed to load "+(g.src||g.href)});return}' +
      'if(e.message==="Script error."&&!e.lineno)return;var fn=N[e.filename]?N[e.filename]+" ":"";s("error",{text:nm(e.message||"Error")+(e.lineno?" ("+fn+"line "+e.lineno+(e.colno?":"+e.colno:"")+")":""),stack:nm(e.error&&e.error.stack||"")})},true);' +
      'addEventListener("unhandledrejection",function(e){var r=e.reason;s("error",{text:"Unhandled promise rejection: "+(r&&r.message?r.message:String(r)),stack:nm(r&&r.stack||"")})});' +
      'function mem(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}' +
      '["localStorage","sessionStorage"].forEach(function(k){try{window[k].getItem("x")}catch(e){try{Object.defineProperty(window,k,{value:mem(),configurable:true})}catch(_){}}});' +
      'addEventListener("load",function(){s("loaded",{})});' +
      '})();';
    return '<script>' + js + '<\/script>';
  }

  function dataUrl(code) {
    return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code).replace(/[()'!*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  const slug = (s) => String(s || 'build').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'build';
  const VIEWPORT = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';

  function termStyle() {
    return '<style>:root{color-scheme:' + (isDark() ? 'dark' : 'light') + '}html,body{margin:0;background:' + cssVar('--paper') + ';color:' + cssVar('--ink') + '}' +
      '#__o{font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:14px 16px;white-space:pre-wrap;word-break:break-word}' +
      '#__o div{padding:1px 0}#__o .warn{color:#b7791f}#__o .error{color:' + cssVar('--acc') + '}#__o .sys{opacity:.55}' +
      '#__f img{max-width:100%;display:block;margin:8px 16px;border:2px solid ' + cssVar('--ink') + ';background:#fff}</style>';
  }
  const TERM_HOOK = '<script>window.__cbOut=function(l,t){var o=document.getElementById("__o");if(!o)return;var d=document.createElement("div");d.className=l;d.textContent=t;o.appendChild(d)};<\/script>';

  function htmlDoc(code, token) {
    let src = code;
    if (!/<html[\s>]/i.test(src) && !/<!doctype/i.test(src)) src = '<!doctype html><html><head>' + VIEWPORT + '</head><body>' + src + '</body></html>';
    const b = bridge(token);
    if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => m + b);
    if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, (m) => m + '<head>' + b + '</head>');
    return b + src;
  }

  function svgDoc(code, token) {
    return '<!doctype html><html><head>' + bridge(token) + VIEWPORT + '<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:' + (isDark() ? '#1a1815' : '#fff') + '}svg{max-width:100%;max-height:100vh;height:auto}</style></head><body>' + code + '</body></html>';
  }

  function mermaidDoc(code, token) {
    return '<!doctype html><html><head>' + bridge(token) + VIEWPORT + '<style>html,body{margin:0;min-height:100%;background:' + cssVar('--paper') + '}body{display:grid;place-items:center;padding:24px;box-sizing:border-box}#m svg{max-width:100%;height:auto}</style></head><body><div id="m"></div>' +
      '<script type="module">import mermaid from ' + JSON.stringify(CDN.mermaid) + ';mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:' + JSON.stringify(isDark() ? 'dark' : 'neutral') + ',fontFamily:"Space Grotesk, system-ui, sans-serif"});' +
      'try{var r=await mermaid.render("cbm",' + safeJson(code) + ');document.getElementById("m").innerHTML=r.svg}catch(e){window.__cbFatal(e,"Diagram error");document.getElementById("m").textContent=String(e&&e.message||e)}<\/script></body></html>';
  }

  function markdownDoc(code, token) {
    const body = window.marked ? marked.parse(code) : esc(code);
    return '<!doctype html><html><head>' + bridge(token) + VIEWPORT + '<style>body{margin:0 auto;max-width:760px;padding:28px 22px 60px;font:16px/1.7 system-ui,sans-serif;background:' + cssVar('--paper') + ';color:' + cssVar('--ink') + '}' +
      'pre{padding:12px 14px;overflow:auto;border:2px solid currentColor}code{font-family:ui-monospace,Menlo,monospace;font-size:.9em}table{border-collapse:collapse}td,th{border:1px solid;padding:6px 10px}img{max-width:100%}a{color:' + cssVar('--acc') + '}.code-bar{display:none}</style></head><body>' + body + '</body></html>';
  }

  function pythonDoc(code, token) {
    const mpl = /\b(matplotlib|pyplot|seaborn)\b/.test(code);
    return '<!doctype html><html><head>' + bridge(token) + VIEWPORT + termStyle() + TERM_HOOK + '</head><body><div id="__o"><div class="sys">Starting Python…</div></div><div id="__f"></div>' +
      '<script src="' + CDN.pyodide + 'pyodide.js"><\/script><script>(async function(){var o=document.getElementById("__o"),src=' + safeJson(code) + ';' +
      'try{var py=await loadPyodide({indexURL:' + JSON.stringify(CDN.pyodide) + ',stdout:function(t){console.log(t)},stderr:function(t){console.warn(t)}});' +
      'o.lastChild.textContent="Python "+py.version+" ready";await py.loadPackagesFromImports(src,{messageCallback:function(){}});' +
      (mpl ? 'py.runPython("import matplotlib\\nmatplotlib.use(\\"AGG\\")");' : '') +
      'var t0=performance.now();await py.runPythonAsync(src);' +
      (mpl ? 'var imgs=py.runPython("import io,base64\\nimport matplotlib.pyplot as _p\\n_o=[]\\nfor _n in _p.get_fignums():\\n  _b=io.BytesIO();_p.figure(_n).savefig(_b,format=\\"png\\",bbox_inches=\\"tight\\",dpi=110);_o.append(base64.b64encode(_b.getvalue()).decode())\\n_o").toJs();imgs.forEach(function(b){var i=new Image();i.src="data:image/png;base64,"+b;document.getElementById("__f").appendChild(i)});' : '') +
      'var d=document.createElement("div");d.className="sys";d.textContent="Finished in "+Math.round(performance.now()-t0)+" ms";o.appendChild(d)' +
      '}catch(e){var m=String(e&&e.message||e);var tb=m.split("\\n").filter(Boolean);console.error(m);window.__cbFatal({name:"PythonError",message:tb.slice(-1)[0]+((m.match(/line (\\d+)/g)||[]).slice(-1)[0]?" ("+(m.match(/line (\\d+)/g)||[]).slice(-1)[0]+")":""),stack:m})}})()<\/script></body></html>';
  }

  /* React / JS / TS: compiled with Babel here, run as ES modules there.
     npm imports → esm.sh (one React instance, dev build for readable errors);
     relative imports → sibling files from the same message. */
  let babelLoading = null;
  function loadBabel() {
    if (window.Babel) return Promise.resolve();
    if (!babelLoading) { babelLoading = loadScript(CDN.babel); babelLoading.catch(() => { babelLoading = null; }); }
    return babelLoading;
  }

  function normPath(p) {
    const out = [];
    p.replace(/^\.\//, '').split('/').forEach((s) => { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); });
    return out.join('/');
  }
  function resolveRel(from, spec, fs) {
    const dir = from.split('/').slice(0, -1).join('/');
    const base = normPath((dir ? dir + '/' : '') + spec);
    const tries = [base, base + '.jsx', base + '.tsx', base + '.js', base + '.ts', base + '.css', base + '/index.jsx', base + '/index.tsx', base + '/index.js', base + '/index.ts'];
    for (const t of tries) if (fs[t] != null) return t;
    // Loose match on the basename (models often drop the src/ prefix).
    const bn = baseName(base);
    const k = Object.keys(fs).find((f) => { const b = baseName(f).replace(/\.\w+$/, ''); return b === bn || baseName(f) === bn; });
    return k || null;
  }

  const SPEC_RE = /(\bimport\s*(?:[\w*${}\s,]+?\s*from\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g;

  function esmUrl(spec) {
    const core = {
      react: 'react@' + REACT, 'react/jsx-runtime': 'react@' + REACT + '/jsx-runtime', 'react/jsx-dev-runtime': 'react@' + REACT + '/jsx-dev-runtime',
      'react-dom': 'react-dom@' + REACT, 'react-dom/client': 'react-dom@' + REACT + '/client',
    };
    if (core[spec]) return CDN.esm + core[spec] + '?dev';
    return CDN.esm + spec + (spec.includes('?') ? '&' : '?') + 'dev&deps=react@' + REACT + ',react-dom@' + REACT;
  }

  function compile(code, path, react) {
    const ts = /\.tsx?$/.test(path);
    const presets = [];
    if (ts) presets.push(['typescript', { isTSX: /\.tsx$/.test(path) || react, allExtensions: true, onlyRemoveTypeImports: false }]);
    if (react || /\.[jt]sx$/.test(path)) presets.push(['react', { runtime: 'automatic', development: false }]);
    return Babel.transform(code, { filename: path, presets, sourceType: 'module', retainLines: true, compact: false, comments: true }).code;
  }

  function moduleDoc(b, code, token) {
    const react = b.kind === 'react';
    const entryPath = normPath(b.file || (react ? (b.lang === 'tsx' ? 'App.tsx' : 'App.jsx') : (b.lang === 'typescript' ? 'main.ts' : 'main.js')));
    // Sibling files from the same message make up the rest of the project.
    const fs = {};
    const v = curVer();
    const msgEl = (v && v.msgEl) || b.msgEl;
    if (msgEl) msgEl.querySelectorAll('.bot-content [data-file]').forEach((el) => {
      const d = blockData(el);
      const p = normPath(d.file);
      if (p && p !== entryPath && /\.(m?[jt]sx?|css|json)$/.test(p)) fs[p] = d.code;
    });
    fs[entryPath] = code;
    const imports = {};
    const names = {};
    const styles = [];
    const bare = new Set();
    const compiled = {};
    const visit = (path) => {
      if (compiled[path] != null) return;
      compiled[path] = '';
      const src = fs[path];
      if (/\.css$/.test(path)) { styles.push(src); return; }
      if (/\.json$/.test(path)) { compiled[path] = 'export default ' + src; return; }
      let out;
      try { out = compile(src, path, react); } catch (e) {
        const err = new Error(String(e.message || e).replace(/^unknown file: /, ''));
        err.file = path; throw err;
      }
      out = out.replace(SPEC_RE, (m, pre, q, spec) => {
        if (/^(https?:|data:|blob:)/.test(spec)) return m;
        if (spec[0] === '.' || spec[0] === '/') {
          const hit = resolveRel(path, spec, fs);
          if (!hit) { console.warn('[builds] unresolved import', spec); return /\.(css|scss|less)$/.test(spec) ? pre.replace(/[\w*${}\s,]+from\s*$/, '') + q + 'data:text/javascript,' + q : m; }
          visit(hit);
          if (/\.css$/.test(hit)) return pre.replace(/[\w*${}\s,]+from\s*$/, '') + q + 'data:text/javascript,' + q;
          return pre + q + '@cloakfs/' + hit + q;
        }
        if (/\.(css|scss|less)$/.test(spec)) { styles.push('@import url(' + JSON.stringify(JSD + spec) + ');'); return pre.replace(/[\w*${}\s,]+from\s*$/, '') + q + 'data:text/javascript,' + q; }
        bare.add(spec);
        return m;
      });
      compiled[path] = out;
    };
    visit(entryPath);
    Object.keys(compiled).forEach((p) => {
      if (/\.css$/.test(p)) return;
      const u = dataUrl(compiled[p]);
      imports['@cloakfs/' + p] = u;
      names[u] = baseName(p);
    });
    if (react) ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].forEach((s) => bare.add(s));
    bare.forEach((s) => { imports[s] = esmUrl(s); });
    const selfMount = /createRoot\s*\(|ReactDOM\.render\s*\(|hydrateRoot\s*\(/.test(code);
    const usesTw = /className\s*=\s*["'`{][^"'`]*\b(flex|grid|p[xytrbl]?-\d|m[xytrbl]?-\d|text-(xs|sm|lg|xl|\dxl)|bg-\w+|rounded|shadow|w-|h-)/.test(code) || /tailwind/i.test(code);
    const head = bridge(token, names) + VIEWPORT +
      '<script type="importmap">' + safeJson({ imports }) + '<\/script>' +
      (react && usesTw ? '<script src="' + CDN.tailwind + '"><\/script>' : '') +
      '<style>' + (react ? 'html,body{margin:0}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' : '') + styles.join('\n').replace(/<\/style/gi, '<\\/style') + '</style>' +
      (react ? '' : termStyle() + TERM_HOOK);
    let boot;
    if (react) {
      boot = 'import React from "react";import {createRoot} from "react-dom/client";' +
        'class B extends React.Component{constructor(p){super(p);this.state={e:null}}static getDerivedStateFromError(e){return{e:e}}componentDidCatch(e){window.__cbFatal(e,"Render error")}' +
        'render(){if(this.state.e){var e=this.state.e;return React.createElement("pre",{style:{margin:0,padding:"16px",font:"13px/1.5 ui-monospace,Menlo,monospace",color:"#b3261e",whiteSpace:"pre-wrap"}},(e.name||"Error")+": "+e.message)}return this.props.children}}' +
        'let M;try{M=await import("@cloakfs/' + entryPath + '")}catch(e){window.__cbFatal(e,"Module error");throw e}' +
        (selfMount ? '' :
          'const R=M.default||M.App||Object.values(M).find(function(x){return typeof x==="function"});' +
          'if(!R){window.__cbFatal(new Error("Nothing to render. Export the root component as default: export default function App() {…}"))}' +
          'else createRoot(document.getElementById("root")).render(React.createElement(B,null,React.createElement(R)));');
    } else {
      boot = 'try{await import("@cloakfs/' + entryPath + '");var d=document.createElement("div");d.className="sys";d.textContent="Finished";document.getElementById("__o").appendChild(d)}catch(e){console.error(e);window.__cbFatal(e)}';
    }
    const body = react ? '<div id="root"></div>' : '<div id="__o"></div>';
    return '<!doctype html><html><head>' + head + '</head><body>' + body + '<script type="module">' + boot + '<\/script></body></html>';
  }

  // Returns { html, async } for a build kind (async = needs Babel first).
  function docFor(kind, code, token, b) {
    b = b || cur();
    switch (kind) {
      case 'html': return { html: htmlDoc(code, token) };
      case 'svg': return { html: svgDoc(code, token) };
      case 'mermaid': return { html: mermaidDoc(code, token) };
      case 'markdown': return { html: markdownDoc(code, token) };
      case 'python': return { html: pythonDoc(code, token) };
      default: return { html: window.Babel ? moduleDoc(b, code, token) : '', async: !window.Babel };
    }
  }

  function run() {
    const b = cur();
    if (!b || b.kind === 'code') return;
    const code = curCode();
    const token = 't' + Math.random().toString(36).slice(2);
    S.token = token;
    S.log = [];
    S.errs = [];
    S.loaded = false;
    clearTimeout(S.fixTimer);
    P.err.hidden = true;
    renderLog();
    P.stage.innerHTML = '';
    const needsBabel = b.kind === 'react' || b.kind === 'script';
    const go = () => {
      if (S.token !== token) return;
      let html;
      try { html = docFor(b.kind, code, token, b).html; } catch (e) {
        loading(false);
        report({ level: 'error', text: (e.file ? e.file + ': ' : '') + (e.message || String(e)).split('\n').slice(0, 12).join('\n'), fatal: true });
        return;
      }
      const f = document.createElement('iframe');
      f.className = 'bp-frame';
      f.title = b.title + ' preview';
      f.setAttribute('sandbox', SANDBOX);
      f.setAttribute('allow', 'clipboard-write; fullscreen');
      f.dataset.kind = b.kind;
      f.srcdoc = html;
      P.stage.appendChild(f);
      S.frame = f;
      loading(b.kind === 'python' ? 'Starting Python…' : b.kind === 'mermaid' ? 'Drawing…' : false);
      if (b.kind === 'python' || b.kind === 'mermaid') setTimeout(() => { if (S.token === token) loading(false); }, b.kind === 'python' ? 2500 : 900);
    };
    if (needsBabel && !window.Babel) {
      loading('Loading compiler…');
      loadBabel().then(go, () => { loading(false); report({ level: 'error', text: 'Couldn\'t load the compiler (Babel). Check your connection and press Run.', fatal: false }); });
    } else go();
  }

  function loading(msg) {
    if (!P) return;
    P.load.hidden = !msg;
    if (msg) P.loadT.textContent = msg;
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.__cb || d.__cb !== S.token) return;
    if (!S.frame || e.source !== S.frame.contentWindow) return;
    if (d.type === 'loaded') { S.loaded = true; loading(false); return; }
    if (d.type === 'console') return report({ level: d.args.level, text: String(d.args.text).slice(0, 8000) });
    if (d.type === 'error') return report({ level: 'error', text: String(d.args.text).slice(0, 4000), stack: String(d.args.stack || '').slice(0, 4000), fatal: true });
  });

  function report(entry) {
    entry.t = Date.now();
    const last = S.log[S.log.length - 1];
    if (last && last.text === entry.text && last.level === entry.level) { last.n = (last.n || 1) + 1; }
    else S.log.push(entry);
    if (S.log.length > 500) S.log.shift();
    if (entry.fatal && !S.errs.some((x) => x.text === entry.text)) {
      S.errs.push(entry);
      loading(false);
      showError();
    }
    renderLog();
  }

  function renderLog() {
    if (!P) return;
    const errs = S.log.filter((l) => l.level === 'error').length;
    const warns = S.log.filter((l) => l.level === 'warn').length;
    P.count.hidden = !(errs || warns);
    P.count.textContent = errs || warns;
    P.count.classList.toggle('err', !!errs);
    if (S.tab !== 'console') return;
    P.log.innerHTML = S.log.map((l) => '<li class="lg ' + esc(l.level) + '"><span class="lg-l">' + esc(l.level === 'log' ? '›' : l.level) + '</span><pre>' + esc(l.text) + (l.stack && l.stack !== l.text ? '\n' + esc(l.stack) : '') + '</pre>' + (l.n > 1 ? '<span class="lg-n">' + l.n + '</span>' : '') + '</li>').join('');
    P.el.querySelector('.bp-log-empty').hidden = S.log.length > 0;
    P.log.scrollTop = P.log.scrollHeight;
  }

  function showError() {
    const e = S.errs[0];
    if (!e) return;
    P.errH.textContent = S.errs.length > 1 ? S.errs.length + ' errors' : 'This build threw an error';
    P.errM.textContent = e.text.split('\n')[0].slice(0, 240);
    P.err.hidden = false;
    // Auto-repair: a fresh Cloak-written build that throws gets fixed without asking.
    const b = cur();
    const v = curVer();
    clearTimeout(S.fixTimer);
    if (!b || b.transient || !v || !v.live || v.src === 'edit' || v.autoTried || b.autoFix >= MAX_AUTOFIX) return;
    if (S.v !== b.versions.length - 1 || autoFixOff()) return;
    S.fixTimer = setTimeout(() => {
      if (typeof busy !== 'undefined' && busy) return;
      const inp = $('#chat-input');
      if (inp && inp.value.trim()) return; // never clobber a draft
      v.autoTried = true;
      b.autoFix++;
      fix(true);
    }, 1600);
  }
  function autoFixOff() { try { return localStorage.getItem('cloak_autofix') === '0'; } catch (_) { return false; } }

  /* ── ASK / FIX → CHAT ──────────────────────────────────── */
  function fence(code, lang, file) {
    const ticks = '`'.repeat(Math.max(3, ...((code.match(/`{3,}/g) || []).map((m) => m.length + 1))));
    return ticks + (lang || '') + (file ? ' title="' + file + '"' : '') + '\n' + code + '\n' + ticks;
  }

  function sendToChat(text) {
    if (typeof busy !== 'undefined' && busy) { toast('Cloak is still answering — try again in a moment'); return false; }
    const inp = $('#chat-input');
    if (!inp || typeof window.send !== 'function') return false;
    if (typeof goPage === 'function' && document.querySelector('#page-chat[hidden]')) goPage('chat');
    inp.value = text;
    if (typeof onInput === 'function') onInput(inp);
    window.send();
    if (S.mode === 'overlay' && !P.el.classList.contains('bp-max')) close();
    return true;
  }

  function askChange(text) {
    text = String(text || '').trim();
    const b = cur();
    if (!text || !b) return;
    const v = curVer();
    let msg = 'Update the "' + b.title + '" build: ' + text;
    if (v.src === 'edit' || S.dirty) msg += '\n\nI edited it — start from my version:\n' + fence(curCode(), b.lang, b.file);
    if (b.transient) msg = text + '\n\nThis is the code:\n' + fence(curCode(), b.lang, b.file);
    if (sendToChat(msg)) {
      P.askIn.value = '';
      if (!b.transient) S.pending = b.id;
    }
  }

  function fix(auto) {
    const b = cur();
    if (!b || !S.errs.length) return;
    const v = curVer();
    const errs = S.errs.slice(0, 4).map((e) => e.text + (e.stack && !e.stack.includes(e.text) ? '\n' + e.stack.split('\n').slice(0, 6).join('\n') : '')).join('\n\n');
    let msg = 'The build threw ' + (S.errs.length > 1 ? S.errs.length + ' errors' : 'an error') + ' in "' + b.title + '"' + (auto ? ' (auto-reported)' : '') + ':\n\n' + fence(errs, 'text') + '\n\nFind the root cause and return the full corrected build.';
    if (b.transient || v.src === 'edit') msg += '\n\nThe code that ran:\n' + fence(curCode(), b.lang, b.file);
    P.errH.textContent = auto ? 'Auto-fixing…' : 'Asking Cloak to fix it…';
    if (sendToChat(msg) && !b.transient) { S.pending = b.id; S.fixing = true; }
  }

  /* ── COPY / DOWNLOAD / TOAST ───────────────────────────── */
  function copyText(text, btn) {
    const done = () => {
      if (!btn) return toast('Copied');
      btn.classList.add('ok');
      const sp = btn.querySelector('span');
      const was = sp ? sp.textContent : '';
      if (sp) sp.textContent = 'Copied';
      setTimeout(() => { btn.classList.remove('ok'); if (sp) sp.textContent = was; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (_) {}
    ta.remove();
  }
  function fileNameFor(d) {
    if (d.file) return baseName(d.file);
    const ext = d.kind === 'react' ? (d.lang === 'tsx' ? 'tsx' : 'jsx') : (EXT[d.lang] || 'txt');
    return /^(Dockerfile|Makefile)$/.test(ext) ? ext : slug(d.title || titleFor(d.kind, d.code || '', '')) + '.' + ext;
  }
  function download(text, name, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function toast(msg) {
    if (window.CloakBrain && CloakBrain.toast) return CloakBrain.toast(msg);
    let t = $('.cb-toast');
    if (!t) { t = document.createElement('div'); t.className = 'cb-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ── CHAT CLICK DELEGATION ─────────────────────────────── */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !btn.closest('#messages')) return;
    const el = btn.closest('.bld, pre.cb');
    const msgEl = btn.closest('.msg');
    if (btn.dataset.act === 'chip') return openChip(btn, msgEl);
    if (!el) return;
    const d = blockData(el);
    switch (btn.dataset.act) {
      case 'copy': return copyText(d.code, btn.classList.contains('bld-lnk') ? null : btn);
      case 'download': return download(d.code, fileNameFor({ ...d, title: titleFor(d.kind, d.code, d.file) }));
      case 'toggle': { const on = el.classList.toggle('expanded'); btn.textContent = on ? 'Hide code' : 'Show code'; return; }
      case 'open':
        if (el.dataset.bid && S.builds.has(el.dataset.bid)) return open(el.dataset.bid, +el.dataset.v, 'preview');
        if (!el.classList.contains('ready') && typeof busy !== 'undefined' && busy) return toast('Still writing…');
        if (msgEl && msgEl.classList.contains('bot')) { scan(msgEl); if (el.dataset.bid && S.builds.has(el.dataset.bid)) return open(el.dataset.bid, +el.dataset.v, 'preview'); }
        return openLoose(d, 'preview', msgEl);
      case 'run': return openLoose(d, 'preview', msgEl);
      case 'edit': return openLoose(d, 'code', msgEl);
    }
  });

  /* ── CODE FILE ATTACHMENTS ─────────────────────────────── */
  const TEXT_EXT = /\.(m?[jt]sx?|cjs|json|jsonc|html?|css|scss|sass|less|py|pyi|ipynb|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|lua|r|dart|scala|sh|bash|zsh|ps1|sql|ya?ml|toml|ini|env|cfg|conf|xml|svg|md|mdx|txt|csv|tsv|log|vue|svelte|astro|graphql|gql|prisma|proto|tf|dockerfile|makefile|gradle|lock)$/i;
  function isTextFile(f) {
    return /^text\//.test(f.type) || /json|xml|javascript|typescript|x-sh|x-python|sql|yaml|toml/.test(f.type) || TEXT_EXT.test(f.name) || /^(Dockerfile|Makefile|\.\w+rc|\.gitignore|\.env[\w.]*)$/i.test(f.name);
  }

  function addFiles(list) {
    const files = Array.from(list || []);
    const imgs = files.filter((f) => /^image\//.test(f.type));
    const texts = files.filter((f) => !/^image\//.test(f.type));
    if (imgs.length && typeof attachedImgs !== 'undefined') imgs.forEach((f) => {
      const r = new FileReader();
      r.onload = (ev) => { attachedImgs.push({ name: f.name, data: ev.target.result }); if (typeof renderImgStrip === 'function') renderImgStrip(); syncSend(); };
      r.readAsDataURL(f);
    });
    texts.forEach((f) => {
      if (!isTextFile(f)) return toast(f.name + ' isn\'t a text/code file');
      if (S.files.length >= FILES_N) return toast('Up to ' + FILES_N + ' files per message');
      if (f.size > FILE_MAX) return toast(f.name + ' is over ' + Math.round(FILE_MAX / 1024) + ' KB');
      const total = S.files.reduce((n, x) => n + x.text.length, 0);
      if (total + f.size > FILES_TOTAL) return toast('Attachments are limited to ' + Math.round(FILES_TOTAL / 1024) + ' KB per message');
      const r = new FileReader();
      r.onload = (ev) => {
        const text = String(ev.target.result || '');
        if (/\u0000/.test(text.slice(0, 4000))) return toast(f.name + ' looks binary');
        S.files.push({ name: f.webkitRelativePath || f.name, text: text.replace(/\r\n/g, '\n') });
        renderFiles();
      };
      r.readAsText(f);
    });
  }

  function renderFiles() {
    let strip = $('#file-strip');
    if (!strip) {
      const img = $('#img-strip');
      if (!img) return;
      strip = document.createElement('div');
      strip.id = 'file-strip';
      strip.className = 'file-strip';
      img.after(strip);
    }
    const had = S.shown || 0;
    S.shown = S.files.length;
    strip.innerHTML = S.files.map((f, i) => '<span class="fchip' + (i >= had ? ' is-new' : '') + '"><span class="fchip-ic">' + ICON.file + '</span><span class="fchip-n">' + esc(baseName(f.name)) + '</span><span class="fchip-l">' + lineCount(f.text) + 'L</span>' +
      '<button type="button" class="fchip-x" data-fx="' + i + '" aria-label="Remove ' + esc(baseName(f.name)) + '">&times;</button></span>').join('');
    strip.classList.toggle('show', S.files.length > 0);
    const pb = $('#plus-btn');
    if (pb && S.files.length) pb.classList.add('has-mode');
    syncSend();
  }

  function syncSend() {
    const btn = $('#send-btn');
    if (btn && (typeof busy === 'undefined' || !busy) && (S.files.length || (typeof attachedImgs !== 'undefined' && attachedImgs.length))) btn.disabled = false;
  }

  function filesToText() {
    return S.files.map((f) => '[file: ' + f.name + ']\n' + fence(f.text, EXT[extLang(f.name)] ? extLang(f.name) : '', '')).join('\n\n');
  }

  // User bubbles: "[file: x]" + fence → a clickable chip.
  const ATT_RE = /\[file: ([^\]\n]{1,200})\]\n(`{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
  function chipify(msgEl) {
    const bub = msgEl && msgEl.querySelector('.bubble');
    const raw = msgEl && msgEl.dataset.raw;
    if (!bub || !raw || raw.indexOf('[file: ') === -1) return;
    const files = [];
    const text = raw.replace(ATT_RE, (m, name, t, lang, code) => { files.push({ name, lang: lang.trim(), code }); return ''; }).trim();
    if (!files.length) return;
    msgEl._files = files;
    const txtDiv = [...bub.children].find((c) => c.tagName === 'DIV' && !c.querySelector('img'));
    if (txtDiv) { if (text) txtDiv.textContent = text; else txtDiv.remove(); }
    const row = document.createElement('div');
    row.className = 'ufiles';
    row.innerHTML = files.map((f, i) => '<button type="button" class="fchip ufile" data-act="chip" data-i="' + i + '"><span class="fchip-ic">' + ICON.file + '</span><span class="fchip-n">' + esc(baseName(f.name)) + '</span><span class="fchip-l">' + lineCount(f.code) + 'L</span></button>').join('');
    bub.appendChild(row);
  }

  function openChip(btn, msgEl) {
    const f = msgEl && msgEl._files && msgEl._files[+btn.dataset.i];
    if (!f) return;
    const lang = f.lang ? langOf(f.lang) : (extLang(f.name) || 'plaintext');
    openLoose({ code: f.code, lang, file: f.name }, 'code', msgEl);
  }

  function initComposer() {
    const menu = $('#plus-menu');
    if (menu && !$('#menu-files')) {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.id = 'code-upload'; inp.multiple = true; inp.hidden = true;
      inp.addEventListener('change', () => { addFiles(inp.files); inp.value = ''; });
      document.body.appendChild(inp);
      const b = document.createElement('button');
      b.className = 'plus-item'; b.id = 'menu-files'; b.type = 'button';
      b.innerHTML = '<span class="plus-item-icon"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6v20h12V6z"/><path d="M14 2v4h4M9.5 12.5L8 14l1.5 1.5M14.5 12.5L16 14l-1.5 1.5"/></svg></span>' +
        '<span class="plus-item-text"><span class="plus-item-label">Attach code files</span><span class="plus-item-desc">Source, configs, logs — or drop them here</span></span>';
      b.addEventListener('click', () => { inp.click(); menu.classList.remove('open'); });
      menu.appendChild(b);
    }
    const box = $('#input-box');
    if (box) {
      box.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('drop'); } });
      box.addEventListener('dragleave', () => box.classList.remove('drop'));
      box.addEventListener('drop', (e) => { if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); box.classList.remove('drop'); addFiles(e.dataTransfer.files); });
    }
    document.addEventListener('click', (e) => {
      const x = e.target.closest('.fchip-x');
      if (!x) return;
      S.files.splice(+x.dataset.fx, 1);
      renderFiles();
      if (!S.files.length && typeof onInput === 'function') onInput($('#chat-input'));
    });
  }

  /* ── PATCHES INTO cloak.js / search-patch.js ───────────── */
  function patch() {
    if (typeof window.postProcessBotEl === 'function' && !window.postProcessBotEl._cb) {
      const pp = window.postProcessBotEl;
      window.postProcessBotEl = function (msgEl, raw) {
        const r = pp.apply(this, arguments);
        try { scan(msgEl); } catch (e) { console.error('[builds] scan', e); }
        return r;
      };
      window.postProcessBotEl._cb = true;
    }
    if (typeof window.addMsg === 'function' && !window.addMsg._cb) {
      const am = window.addMsg;
      window.addMsg = function (role) {
        const d = am.apply(this, arguments);
        if (role === 'user') try { chipify(d); } catch (_) {}
        return d;
      };
      window.addMsg._cb = true;
    }
    if (typeof window.onInput === 'function' && !window.onInput._cb) {
      const oi = window.onInput;
      window.onInput = function () { const r = oi.apply(this, arguments); syncSend(); return r; };
      window.onInput._cb = true;
    }
  }

  function patchSend() {
    if (typeof window.send !== 'function' || window.send._cb) return;
    const sd = window.send;
    window.send = function () {
      const inp = $('#chat-input');
      if (S.files.length && inp && (typeof busy === 'undefined' || !busy)) {
        const typed = inp.value.trim();
        inp.value = (typed || 'Here are my files.') + '\n\n' + filesToText();
        S.files = [];
        renderFiles();
        const pb = $('#plus-btn');
        if (pb && typeof renderImgStrip === 'function') renderImgStrip();
      }
      const box = $('#messages');
      const before = box ? box.querySelectorAll('.msg.bot').length : 0;
      const p = sd.apply(this, arguments);
      // The bot bubble is inserted synchronously; mark it live so its builds auto-open.
      if (box) {
        const bots = box.querySelectorAll('.msg.bot');
        if (bots.length > before) S.liveMsgs.add(bots[bots.length - 1]);
      }
      return p;
    };
    window.send._cb = true;
  }

  function init() {
    patch();
    patchSend();
    initComposer();
    const box = $('#messages');
    if (box && 'MutationObserver' in window) {
      let t = 0;
      new MutationObserver(() => { clearTimeout(t); t = setTimeout(prune, 60); }).observe(box, { childList: true });
    }
    window.addEventListener('resize', () => { if (isOpen()) layout(); });
    // Sidebar collapse changes the room available for a split.
    const sb = $('.sidebar');
    if (sb && 'ResizeObserver' in window) new ResizeObserver(() => { if (isOpen()) layout(); }).observe(sb);
  }

  patch();
  // Deferred scripts run while readyState is still "interactive", before
  // search-patch.js installs its send() — DOMContentLoaded comes after all of them.
  if (document.readyState === 'complete') init();
  else document.addEventListener('DOMContentLoaded', init);

  window.CloakBuilds = {
    open, openLoose, close, run, scan, addFiles,
    get list() { return [...S.builds.values()]; },
    get current() { return cur(); },
    _state: S, _parseInfo: parseInfo, _buildKind: buildKind,
  };
})();
