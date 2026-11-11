/* The app: text Cloak (or a Blink you made), watch it listen, think and answer.
   Chats live in localStorage (and in Supabase when signed in, see sync.js).
   Talks to blinks-api POST /v1/chat (SSE). If that is unreachable the app
   says so and plays a short scripted reply instead of pretending. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  // The five, then the Blinks this person made (maker.js, stored on this device).
  var C = [], byId = {};
  function rebuild() {
    C = Kit.COMPANIONS.concat(window.Maker ? Maker.load().map(Maker.asCompanion) : []);
    byId = {};
    C.forEach(function (c) { byId[c.id] = c; });
  }
  rebuild();
  function who(id) { return byId[id] || byId.cloak; }
  // In Low Light every Blink's eyes go half-shut.
  function look(c) {
    var spec = c.look || c.id;
    return state && state.power === "lowlight" ? Object.assign({}, Creatures.spec(spec), { eyes: "sleepy" }) : spec;
  }

  var MOOD_LABEL = { idle: "Here", listen: "Listening", think: "Thinking", search: "Looking it up", talk: "Talking", happy: "Glad", care: "With you", sleep: "Resting" };
  var SPONSORS = [
    { title: "Your name here", body: "One quiet card, no tracking. Sponsors pay for carbon removal, ten times what this chat emits." },
    { title: "Sponsor a greener answer", body: "Reach people who chose an AI that cleans up after itself. Every view funds verified removal." },
  ];

  var state = {
    chats: load("pv_chats", []),
    chatId: null,
    companion: byId[Kit.get("pv_companion")] ? Kit.get("pv_companion") : "cloak",
    mode: "auto",
    busy: false,
    ctrl: null,
    images: [],
    sess: { wh: 0, g: 0 },
    queue: [],
    files: [],
    power: "full",
    user: load("pv_user", { name: "", about: "" }),
  };
  // A random secret kept on this device: it is how memory, tasks and the inbox find you without an account.
  var device = Kit.get("pv_device");
  if (!device) { device = Array.from(crypto.getRandomValues(new Uint8Array(20)), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); Kit.set("pv_device", device); }
  var TZ = ""; try { TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
  // Every request carries the Cloak account's token. Blinks needs one.
  function authHeaders(extra) {
    return (window.Sync ? Sync.token() : Promise.resolve(null)).then(function (t) {
      return Object.assign(t ? { Authorization: "Bearer " + t } : { "X-Device": device }, extra || {});
    });
  }
  function signedOut() { if (window.Sync && !document.documentElement.classList.contains("gated")) Sync.gate(function () { location.reload(); }); }
  function api(path, opts) {
    opts = opts || {};
    return authHeaders(Object.assign(opts.body ? { "Content-Type": "application/json" } : {}, opts.headers || {})).then(function (h) {
      opts.headers = h;
      return fetch(Kit.api + path, opts).then(function (r) { if (r.status === 401) signedOut(); return r.json(); });
    });
  }
  var fig = { stage: null, top: null, empty: null };
  var typingTimer = 0;

  function load(k, d) { try { return JSON.parse(Kit.get(k)) || d; } catch (e) { return d; } }
  function save() {
    // Newest 40 chats; images are never stored.
    state.chats.sort(function (a, b) { return b.updated - a.updated; });
    state.chats = state.chats.slice(0, 40);
    Kit.set("pv_chats", JSON.stringify(state.chats));
  }
  function chat() { return state.chats.find(function (c) { return c.id === state.chatId; }) || null; }
  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); }

  /* ── Creatures ─────────────────────────────────────────────────── */
  function mood(m) {
    ["stage", "top", "empty"].forEach(function (k) { if (fig[k]) fig[k].set(m); });
    $("mood").textContent = MOOD_LABEL[m] || "Here";
  }
  function pulse(n) { ["stage", "top", "empty"].forEach(function (k) { if (fig[k]) fig[k].pulse(n); }); }
  function each(fn) { ["stage", "top", "empty"].forEach(function (k) { if (fig[k] && fig[k][fn]) fig[k][fn](); }); }
  function cheer() { ["stage", "top", "empty"].forEach(function (k) { if (fig[k]) fig[k].cheer(); }); }
  function mountFigs() {
    var c = who(state.companion);
    ["stage", "top"].forEach(function (k) { if (fig[k]) fig[k].destroy(); });
    fig.stage = Creatures.mount($("stageFig"), look(c), { label: c.name });
    fig.top = Creatures.mount($("topAv"), look(c), { label: c.name });
    $("topName").textContent = $("stName").textContent = c.name;
    $("topRole").textContent = c.role;
    $("stLine").textContent = c.line;
    $("input").placeholder = "Talk to " + c.name;
    document.title = c.name + " | " + Kit.brand;
    setTimeout(function () { each("wave"); }, 250);
  }

  /* ── Sidebar ───────────────────────────────────────────────────── */
  var sideFigs = [];
  function renderComps() {
    var host = $("comps");
    sideFigs.forEach(function (f) { f.destroy(); });
    sideFigs = [];
    host.innerHTML = "";
    function row(c) {
      var b = document.createElement("div");
      b.className = "comp";
      b.setAttribute("role", "button");
      b.tabIndex = 0;
      b.setAttribute("aria-current", c.id === state.companion ? "true" : "false");
      b.innerHTML = '<div class="comp-av"></div><div class="comp-tx"><b>' + Kit.esc(c.name) + "</b><span>" + Kit.esc(c.role) + "</span></div>" +
        (c.custom ? '<button class="iconbtn comp-edit" aria-label="Edit ' + Kit.esc(c.name) + '">' + Kit.icon("pencil-simple") + "</button>" : "");
      var go = function () { setCompanion(c.id, true); closeSide(); };
      b.addEventListener("click", function (e) {
        if (e.target.closest(".comp-edit")) { editBlink(c.id); return; }
        go();
      });
      b.addEventListener("keydown", function (e) { if ((e.key === "Enter" || e.key === " ") && e.target === b) { e.preventDefault(); go(); } });
      host.appendChild(b);
      sideFigs.push(Creatures.mount(b.firstChild, look(c), { label: c.name }));
    }
    C.filter(function (c) { return !c.custom; }).forEach(row);
    var mine = C.filter(function (c) { return c.custom; });
    var h = document.createElement("h2");
    h.textContent = "Yours";
    host.appendChild(h);
    mine.forEach(row);
    var mk = document.createElement("button");
    mk.className = "make";
    mk.type = "button";
    mk.innerHTML = '<span class="make-av">' + Kit.icon("plus") + "</span><span><b>Make a Blink</b><small>" + (mine.length ? "Pick a shape, give it a job" : "Your own shape, name and purpose") + "</small></span>";
    mk.addEventListener("click", function () { editBlink(null); closeSide(); });
    host.appendChild(mk);
  }
  function editBlink(id) {
    var bot = id ? Maker.load().find(function (b) { return b.id === id; }) : null;
    Maker.open(bot, {
      onSave: function (b) {
        rebuild();
        if (state.companion === b.id) { renderComps(); mountFigs(); renderThread(); }
        else setCompanion(b.id, true);
        setTimeout(function () { ["stage", "top", "empty"].forEach(function (k) { if (fig[k]) fig[k].cheer(); }); }, 200);
      },
      onDelete: function (gone) {
        rebuild();
        if (state.companion === gone) setCompanion("cloak", true); else renderComps();
      },
    });
  }
  function renderHist() {
    var host = $("hist");
    host.innerHTML = "";
    if (!state.chats.length) { host.innerHTML = '<p class="hist-empty">Your chats will collect here.</p>'; return; }
    state.chats.forEach(function (c) {
      var b = document.createElement("div");
      b.className = "hist";
      b.setAttribute("role", "button");
      b.tabIndex = 0;
      b.setAttribute("aria-current", c.id === state.chatId ? "true" : "false");
      b.innerHTML = "<span>" + Kit.esc(c.title || "New chat") + '</span><button class="iconbtn del" aria-label="Delete chat">' + Kit.icon("trash") + "</button>";
      var open = function () { openChat(c.id); closeSide(); };
      b.addEventListener("click", function (e) {
        if (e.target.closest(".del")) {
          state.chats = state.chats.filter(function (x) { return x.id !== c.id; });
          save();
          if (window.Sync) Sync.remove(c.id);
          if (state.chatId === c.id) newChat(); else renderHist();
          return;
        }
        open();
      });
      b.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target === b) open(); });
      host.appendChild(b);
    });
  }
  function closeSide() { $("app").classList.remove("open"); }

  function setCompanion(id, fresh) {
    if (!byId[id]) return;
    stop();
    state.companion = id;
    Kit.set("pv_companion", id);
    if (fresh) state.chatId = null;
    renderComps();
    mountFigs();
    renderThread();
    renderHist();
  }
  function newChat() { stop(); state.chatId = null; renderThread(); renderHist(); $("input").focus(); }
  function openChat(id) {
    var c = state.chats.find(function (x) { return x.id === id; });
    if (!c) return;
    stop();
    state.chatId = id;
    if (c.companion !== state.companion && byId[c.companion]) { state.companion = c.companion; Kit.set("pv_companion", c.companion); renderComps(); mountFigs(); }
    renderThread();
    renderHist();
  }

  /* ── Thread ────────────────────────────────────────────────────── */
  function md(text) {
    if (window.marked && window.DOMPurify) {
      try { return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), { FORBID_TAGS: ["style", "form", "input", "iframe"], ADD_ATTR: ["target"] }); } catch (e) {}
    }
    return Kit.esc(text).replace(/\n/g, "<br>");
  }
  function dress(el) {
    el.querySelectorAll("a[href]").forEach(function (a) { a.target = "_blank"; a.rel = "noopener noreferrer"; });
    // Cloak makes pictures only in code. An svg block shows as the picture,
    // sanitised, with its code a tap away.
    el.querySelectorAll("pre > code.language-svg").forEach(function (code) {
      if (!window.DOMPurify || !/<svg[\s>]/i.test(code.textContent)) return;
      var pre = code.parentNode;
      var fig = document.createElement("figure");
      fig.className = "drawn";
      fig.innerHTML = DOMPurify.sanitize(code.textContent, { USE_PROFILES: { svg: true, svgFilters: true } });
      var svg = fig.querySelector("svg");
      if (!svg) return;
      svg.setAttribute("role", "img");
      if (!svg.getAttribute("aria-label")) svg.setAttribute("aria-label", "A picture Cloak drew in code");
      var cap = document.createElement("figcaption");
      cap.innerHTML = '<span class="note">drawn in code</span><button type="button" class="linkbtn">Show the code</button>';
      cap.querySelector("button").addEventListener("click", function () { pre.hidden = !pre.hidden; this.textContent = pre.hidden ? "Show the code" : "Hide the code"; });
      fig.appendChild(cap);
      pre.hidden = true;
      pre.parentNode.insertBefore(fig, pre);
    });
    el.querySelectorAll("pre").forEach(function (pre) {
      if (pre.querySelector(".copy-code")) return;
      var b = document.createElement("button");
      b.className = "copy-code"; b.type = "button"; b.textContent = "Copy";
      b.addEventListener("click", function () {
        var code = pre.querySelector("code");
        navigator.clipboard.writeText(code ? code.textContent : pre.textContent).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1400); });
      });
      pre.appendChild(b);
    });
  }
  function metaHtml(m) {
    if (!m || !m.lane) return "";
    var s = '<span class="chip">' + Kit.esc(m.lane_label || m.lane) + "</span>";
    if (m.impact) s += Kit.icon("leaf", "leaf") + '<span class="mono" title="Estimated from token counts, with a 50% margin. Removed ten times over.">' + Kit.fmtWh(m.impact.wh) + ", " + Kit.fmtCO2(m.impact.g / 1000) + " CO2e est.</span>";
    if (m.demo) s += '<span class="chip chip-accent">Scripted demo</span>';
    if (m.partial) s += "<span>Cut short</span>";
    return s;
  }
  var TOOL_ICON = { web_search: "magnifying-glass", read_page: "file-text", calculate: "gauge", remember: "brain", recall: "brain", forget: "brain", ask_companion: "chat-circle", schedule_task: "hourglass-medium", list_tasks: "hourglass-medium", cancel_task: "hourglass-medium", look: "eye", team: "stack" };
  function didHtml(steps) {
    if (!steps || !steps.length) return "";
    var tool = function (n) { return steps.filter(function (s) { return s.tool === n; }).length; };
    var parts = [];
    if (tool("web_search")) parts.push("searched " + tool("web_search") + (tool("web_search") === 1 ? " time" : " times"));
    if (tool("read_page")) parts.push("read " + tool("read_page") + (tool("read_page") === 1 ? " page" : " pages"));
    if (tool("remember")) parts.push("saved " + tool("remember") + (tool("remember") === 1 ? " memory" : " memories"));
    var t = parts.length ? parts.join(", ") : "took " + steps.length + (steps.length === 1 ? " step" : " steps");
    t = t.charAt(0).toUpperCase() + t.slice(1);
    return '<button type="button" class="did" aria-expanded="false">' + Kit.esc(t) + Kit.icon("caret-down") + "</button>" + stepsHtml(steps).replace('<ul class="steps">', '<ul class="steps" hidden>');
  }
  function hookDid(el) {
    var b = el.querySelector(".did");
    if (b) b.addEventListener("click", function () { var on = b.getAttribute("aria-expanded") !== "true"; b.setAttribute("aria-expanded", on ? "true" : "false"); el.querySelector(".steps").hidden = !on; });
  }
  function stepsHtml(steps) {
    if (!steps || !steps.length) return "";
    return '<ul class="steps">' + steps.map(function (st) {
      var by = st.by && byId[st.by] ? '<b>' + Kit.esc(byId[st.by].name) + "</b> " : "";
      return '<li class="' + (st.state === "run" ? "run" : st.state === "blocked" ? "blocked" : "ok") + (st.by && st.tool !== "team" ? " sub" : "") + '">' + Kit.icon(st.state === "blocked" ? "warning-circle" : TOOL_ICON[st.tool] || "wrench") + "<span>" + by + Kit.esc(st.label || "") + "</span>" + (st.summary && st.state !== "run" ? "<em>" + Kit.esc(st.state === "blocked" ? "blocked for safety" : st.summary) + "</em>" : "") + "</li>";
    }).join("") + "</ul>";
  }
  function sourcesHtml(list) {
    if (!list || !list.length) return "";
    var seen = {};
    return '<div class="sources">' + list.filter(function (x) { if (seen[x.url]) return false; seen[x.url] = 1; return true; }).slice(0, 8).map(function (x) {
      var host = ""; try { host = new URL(x.url).hostname.replace(/^www\./, ""); } catch (e) {}
      return '<a href="' + Kit.esc(x.url) + '" target="_blank" rel="noopener noreferrer" title="' + Kit.esc(x.title) + '"><b>' + x.n + "</b>" + Kit.esc(host) + "</a>";
    }).join("") + "</div>";
  }
  function careHtml(r) {
    return '<div class="care" role="region" aria-label="Help available now"><h3>You do not have to carry this alone.</h3><p>Real people are available right now. If you are in immediate danger, call ' + Kit.esc(r.emergency) + ".</p><ul>" +
      r.lines.map(function (l) { return '<li><a href="' + Kit.esc(l.href) + '"' + (/^https/.test(l.href) ? ' target="_blank" rel="noopener noreferrer"' : "") + "><div><b>" + Kit.esc(l.name) + "</b><span>" + Kit.esc(l.how) + "</span></div>" + Kit.icon("arrow-up-right") + "</a></li>"; }).join("") +
      "</ul></div>";
  }
  /* ── Texting ───────────────────────────────────────────────────────
     Replies arrive as texts: a typing bubble, then short bubbles one after
     another, split at blank lines. The Blink can tapback your message
     ([react:X]) or leave it on read ([read]); your last message shows
     Delivered, then Read. You can tapback its bubbles too (double-click,
     long-press, or the heart). */
  var REACTS = ["❤️", "👍", "😂", "😮", "😢", "‼️", "❓", "🔥"];
  var TAPS = ["❤️", "👍", "😂", "😮", "😢", "‼️"];
  function parseReply(raw) {
    var react = null, m = /\[react:\s*([^\]\s]{1,8})\s*\]/i.exec(raw);
    if (m && REACTS.indexOf(m[1]) !== -1) react = m[1];
    return {
      react: react,
      read: /\[read\]/i.test(raw),
      text: raw.replace(/\[react:[^\]]{0,12}\]/gi, "").replace(/\[read\]/gi, "").replace(/^\s+/, ""),
    };
  }
  // Blank lines split texts. Code stays whole, a list stays one bubble, a
  // heading rides with what follows it.
  function bubbles(text) {
    var out = [], cur = [], fence = false;
    String(text || "").split("\n").forEach(function (line) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (!fence && !line.trim()) { if (cur.length) { out.push(cur.join("\n")); cur = []; } return; }
      cur.push(line);
    });
    if (cur.length) out.push(cur.join("\n"));
    var LIST = /^\s*([-*+]|\d+[.)])\s/, TABLE = /^\s*\|/;
    var merged = [];
    out.forEach(function (seg) {
      var prev = merged[merged.length - 1];
      var lastLine = prev ? prev.split("\n").pop() : "";
      if (prev != null && ((LIST.test(seg) && LIST.test(lastLine)) || (TABLE.test(seg) && TABLE.test(lastLine)) || /^#{1,6}\s[^\n]*$/.test(prev))) merged[merged.length - 1] = prev + "\n\n" + seg;
      else merged.push(seg);
    });
    return merged;
  }
  function hm(t) { return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function dayLabel(t) {
    var d = new Date(t), now = new Date(), y = new Date(now - 864e5);
    var day = d.toDateString() === now.toDateString() ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return day + " " + hm(t);
  }
  function divider(t) {
    var d = document.createElement("div");
    d.className = "when";
    d.textContent = dayLabel(t);
    $("threadIn").appendChild(d);
  }
  function reactHtml(e, pop) { return '<span class="react' + (pop ? " pop" : "") + '" role="img" aria-label="Reacted ' + e + '">' + e + "</span>"; }

  function userTurn(m, react) {
    var el = document.createElement("div");
    el.className = "turn me";
    var html = (m.thumbs || []).map(function (u) { return '<div class="bub me pic"><img src="' + u + '" alt="Attached image"></div>'; }).join("");
    html += '<div class="bub me"><span class="tx">' + Kit.esc(m.content) + "</span>" + (react ? reactHtml(react) : "") + "</div>";
    el.innerHTML = '<div class="stack">' + html + "</div>";
    $("threadIn").appendChild(el);
    return el;
  }
  function botTurn(m) {
    var c = who(m.companion || state.companion);
    var el = document.createElement("div");
    el.className = "turn them";
    el.innerHTML = (m.care ? careHtml(m.care) : "") + '<div class="steps-host">' + didHtml(m.steps) + '</div><div class="row"><div class="av" aria-hidden="true"></div><div class="stack"></div></div><div class="tfoot"><div class="sources-host">' + sourcesHtml(m.sources) + '</div><div class="meta">' + (m.content || m.care ? metaHtml(m.meta || {}) : "") + "</div></div>";
    $("threadIn").appendChild(el);
    hookDid(el);
    var segs = bubbles(m.content);
    segs.forEach(function (t, i) { addBubble(el, m, t, i, false); });
    if (segs.length) avatar(el, c);
    return el;
  }
  function avatar(el, c) {
    var av = el.querySelector(".av");
    if (av && !av.firstChild) Creatures.mount(av, look(c), { still: true, label: c.name });
  }
  function addBubble(turn, m, text, i, anim) {
    var b = document.createElement("div");
    b.className = "bub them" + (anim ? " pop" : "") + (/```|^\s*\|/m.test(text) ? " wide" : "");
    b.setAttribute("data-i", i);
    b.innerHTML = '<div class="prose"></div><button type="button" class="tapbtn" aria-label="React">' + Kit.icon("hand-heart") + "</button>";
    var p = b.firstChild;
    p.innerHTML = md(text);
    dress(p);
    if (m.taps && m.taps[i]) b.insertAdjacentHTML("beforeend", reactHtml(m.taps[i]));
    hookTap(b, m);
    var st = turn.querySelector(".stack");
    st.insertBefore(b, st.querySelector(".typing"));
    return b;
  }

  // Your tapbacks on its texts.
  var picker = null;
  function hookTap(b, m) {
    var t = 0;
    b.addEventListener("mousedown", function (e) { if (e.detail > 1 && !e.target.closest("pre")) e.preventDefault(); });
    b.addEventListener("dblclick", function (e) { if (e.target.closest("a,pre,button")) return; e.preventDefault(); openPicker(b, m); });
    b.querySelector(".tapbtn").addEventListener("click", function (e) { e.stopPropagation(); openPicker(b, m); });
    b.addEventListener("pointerdown", function (e) { if (e.pointerType === "mouse") return; t = setTimeout(function () { openPicker(b, m); }, 460); });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (n) { b.addEventListener(n, function () { clearTimeout(t); }); });
  }
  function openPicker(b, m) {
    closePicker();
    var i = +b.getAttribute("data-i");
    picker = document.createElement("div");
    picker.className = "picker";
    picker.setAttribute("role", "menu");
    picker.innerHTML = TAPS.map(function (e) { return '<button type="button" role="menuitemradio" aria-checked="' + (m.taps && m.taps[i] === e ? "true" : "false") + '" data-e="' + e + '">' + e + "</button>"; }).join("") +
      '<button type="button" class="pk-copy" role="menuitem" aria-label="Copy this text">' + Kit.icon("copy") + "</button>";
    b.appendChild(picker);
    picker.addEventListener("click", function (e) {
      e.stopPropagation();
      var x = e.target.closest("button");
      if (!x) return;
      if (x.classList.contains("pk-copy")) { navigator.clipboard.writeText(bubbles(m.content)[i] || ""); closePicker(); return; }
      var em = x.getAttribute("data-e");
      m.taps = m.taps || {};
      var old = b.querySelector(":scope > .react");
      if (old) old.remove();
      if (m.taps[i] === em) delete m.taps[i];
      else {
        m.taps[i] = em;
        b.insertAdjacentHTML("beforeend", reactHtml(em, true));
        if (em === "😢") each("nod"); else cheer();
      }
      closePicker();
      var ch = chat();
      if (ch) { save(); if (window.Sync) Sync.push(ch); }
    });
    setTimeout(function () { document.addEventListener("pointerdown", outside, true); }, 0);
  }
  function outside(e) { if (picker && !picker.contains(e.target)) closePicker(); }
  function closePicker() {
    if (picker) { picker.remove(); picker = null; }
    document.removeEventListener("pointerdown", outside, true);
  }

  // Delivered / Read under your last message, while it is the last word.
  function receipt() {
    var host = $("threadIn");
    host.querySelectorAll(".receipt").forEach(function (r) { r.remove(); });
    var ch = chat();
    if (!ch) return;
    var msgs = ch.messages, li = -1;
    for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { li = i; break; }
    if (li === -1) return;
    var next = msgs[li + 1];
    if (next && !next.onRead) return;
    var turns = host.querySelectorAll(".turn.me"), t = turns[turns.length - 1];
    if (!t) return;
    var r = document.createElement("div");
    r.className = "receipt";
    r.innerHTML = msgs[li].read ? "<b>Read</b> " + hm(msgs[li].read) : "Delivered";
    t.appendChild(r);
  }

  function renderThread() {
    var host = $("threadIn");
    if (fig.empty) { fig.empty.destroy(); fig.empty = null; }
    closePicker();
    host.innerHTML = "";
    var ch = chat();
    if (!ch || !ch.messages.length) {
      var c = who(state.companion);
      var name = (state.user.name || "").trim();
      host.innerHTML = '<div class="empty"><div class="empty-fig"></div><h1>' + Kit.esc(c.hello) + "</h1><p>" + (name ? Kit.esc(name) + ", this is " : "This is ") + Kit.esc(c.name) + ". " + Kit.esc(c.about) + '</p><div class="starters"></div></div>';
      fig.empty = Creatures.mount(host.querySelector(".empty-fig"), look(c), { label: c.name });
      var st = host.querySelector(".starters");
      c.starters.forEach(function (s) {
        var b = document.createElement("button");
        b.className = "starter"; b.type = "button";
        b.innerHTML = Kit.esc(s) + Kit.icon("arrow-up-right");
        b.addEventListener("click", function () { send(s); });
        st.appendChild(b);
      });
      return;
    }
    var last = 0;
    ch.messages.forEach(function (m, i) {
      if (m.at && m.at - last > 20 * 60000) divider(m.at);
      if (m.at) last = m.at;
      if (m.role === "user") { var nx = ch.messages[i + 1]; userTurn(m, nx && nx.role === "assistant" ? nx.react : null); }
      else if (!m.onRead) botTurn(m);
    });
    receipt();
    scrollEnd(true);
  }
  function scrollEnd(force) {
    var t = $("thread");
    if (force || t.scrollHeight - t.scrollTop - t.clientHeight < 160) t.scrollTop = t.scrollHeight;
  }

  /* ── Sending ───────────────────────────────────────────────────── */
  // There is no stop button: while Cloak works you can keep texting, and
  // what you send waits in line for the next turn.
  function setBusy(b) {
    state.busy = b;
    $("send").disabled = !$("input").value.trim();
    $("send").setAttribute("aria-label", b ? "Send after this reply" : "Send");
  }
  function queueText(text) {
    var el = userTurn({ content: text }, null);
    el.classList.add("queued", "sent");
    var r = document.createElement("div");
    r.className = "receipt";
    r.innerHTML = 'Queued <button type="button" class="linkbtn">Remove</button>';
    el.appendChild(r);
    var item = { text: text, el: el };
    r.querySelector("button").addEventListener("click", function () { state.queue.splice(state.queue.indexOf(item), 1); el.remove(); });
    state.queue.push(item);
    scrollEnd(true);
  }
  function stop() { if (state.ctrl) state.ctrl.abort(); }

  async function send(text) {
    var texts = (Array.isArray(text) ? text : [text == null ? $("input").value : text]).map(function (t) { return String(t || "").trim(); }).filter(Boolean);
    if (!texts.length && !state.files.length) return;
    if (state.busy) {
      texts.forEach(queueText);
      $("input").value = "";
      grow();
      return;
    }
    // Files go to the brain first; their names (and small text files' text) ride along.
    if (state.files.length) {
      var note = await uploadFiles();
      if (note === null) return;
      texts.push(note.trim());
      texts = [texts.join("\n\n")];
    }
    text = texts[texts.length - 1];
    closePicker();
    var ch = chat();
    if (!ch) {
      ch = { id: uid(), companion: state.companion, title: texts[0].slice(0, 60), messages: [], updated: Date.now() };
      state.chats.unshift(ch);
      state.chatId = ch.id;
      $("threadIn").innerHTML = "";
      if (fig.empty) { fig.empty.destroy(); fig.empty = null; }
    }
    var images = state.images;
    state.images = [];
    renderThumbs();
    var now = Date.now(), prevAt = 0;
    ch.messages.forEach(function (m) { if (m.at) prevAt = m.at; });
    if (now - prevAt > 20 * 60000) divider(now);
    var um, uEl;
    texts.forEach(function (t, n) {
      um = { role: "user", content: t, at: now };
      ch.messages.push(um);
      uEl = userTurn({ content: t, thumbs: n === texts.length - 1 ? images.map(function (i) { return "data:" + i.mime + ";base64," + i.data; }) : [] }, null);
      uEl.classList.add("sent");
    });
    receipt();
    $("input").value = "";
    grow();
    setBusy(true);
    renderHist();
    scrollEnd(true);
    mood("think");

    var bm = { role: "assistant", content: "", companion: state.companion, meta: {} };
    var el = null, typingEl = null, finished = false, readDone = false;
    var raw = "", queued = 0, shown = 0, live = null, liveRaf = 0, chain = Promise.resolve(), gen = 0, reacted = false;
    function turn() { if (!el) el = botTurn({ companion: bm.companion, sources: bm.sources, care: bm.care, meta: {} }); return el; }
    // One line that says what Cloak is doing right now, in its own words.
    var nowEl = null;
    function nowSay(label) {
      var host = turn().querySelector(".steps-host");
      if (!nowEl) {
        nowEl = document.createElement("div");
        nowEl.className = "now";
        nowEl.setAttribute("role", "status");
        nowEl.innerHTML = '<i class="now-dot" aria-hidden="true"></i><span class="now-t"></span>';
        host.innerHTML = "";
        host.appendChild(nowEl);
      }
      var box = nowEl.querySelector(".now-t");
      var old = box.querySelector("span:not(.out)");
      if (old && old.textContent === label + "...") return;
      if (old) { old.classList.add("out"); setTimeout(function () { old.remove(); }, 320); }
      var n = document.createElement("span");
      n.textContent = label + "...";
      box.appendChild(n);
      typing(false);
      scrollEnd();
    }
    function nowDone() {
      if (!el) return;
      var host = el.querySelector(".steps-host");
      if (nowEl) { nowEl.remove(); nowEl = null; }
      host.innerHTML = didHtml(bm.steps);
      hookDid(el);
      if (!finished && shown === queued && !live) typing(true);
    }
    function typing(on) {
      if (on && !typingEl && !finished && !nowEl) {
        var st = turn().querySelector(".stack");
        typingEl = document.createElement("div");
        typingEl.className = "bub them typing";
        typingEl.setAttribute("aria-label", who(bm.companion).name + " is typing");
        typingEl.innerHTML = "<i></i><i></i><i></i>";
        st.appendChild(typingEl);
        avatar(el, who(bm.companion));
        scrollEnd();
      } else if (!on && typingEl) { typingEl.remove(); typingEl = null; }
    }
    function markRead() {
      if (readDone) return;
      readDone = true;
      um.read = Date.now();
      receipt();
      // It has read it: say so in one line until it either works or texts back.
      setTimeout(function () { if (!finished && !live && shown === queued && !raw && !nowEl && !bm.care) nowSay("Thinking"); }, 420);
    }
    // Texts go out one at a time, with a beat of typing between them.
    function enqueue(i) {
      var g = gen;
      chain = chain.then(function () {
        if (g !== gen) return;
        var t = bubbles(bm.content)[i];
        if (t == null) return;
        if (live && +live.getAttribute("data-i") === i) {
          if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = 0; }
          var p = live.querySelector(".prose");
          p.innerHTML = md(t);
          p.classList.remove("caret");
          dress(p);
          live = null;
          shown++;
          return;
        }
        var wait = shown === 0 ? 0 : Math.min(700, 180 + t.length * 4);
        if (wait) typing(true);
        return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
          if (g !== gen) return;
          typing(false);
          if (!bm.at) bm.at = Date.now();
          addBubble(turn(), bm, t, i, true);
          avatar(el, who(bm.companion));
          shown++;
          pulse(0.8);
          if (!finished || shown < queued) typing(true);
          scrollEnd();
        });
      });
    }
    function paintLive() {
      liveRaf = 0;
      if (!live) return;
      var p = live.querySelector(".prose");
      p.innerHTML = md(bubbles(bm.content)[+live.getAttribute("data-i")] || "");
      p.classList.add("caret");
      scrollEnd();
    }
    function onText(done) {
      if (!done && /^\s*\[[^\]]{0,14}$/.test(raw)) return; // a tag is still arriving
      var p = parseReply(raw);
      if (p.react && !reacted) {
        reacted = true;
        bm.react = p.react;
        var ub = uEl.querySelector(".bub.me:last-child");
        if (ub) ub.insertAdjacentHTML("beforeend", reactHtml(p.react, true));
        if (p.react !== "😢") cheer();
      }
      bm.content = p.text;
      bm.read = p.read;
      var segs = bubbles(p.text);
      var complete = done ? segs.length : Math.max(0, segs.length - 1);
      while (queued < complete) enqueue(queued++);
      // The text being written now: if it is long and nothing is waiting, write it live.
      var cur = segs[queued];
      if (!done && cur != null && queued === shown && (live || cur.length > 220)) {
        if (!live) {
          typing(false);
          if (!bm.at) bm.at = Date.now();
          live = addBubble(turn(), bm, cur, queued, true);
          avatar(el, who(bm.companion));
        }
        if (!liveRaf) liveRaf = requestAnimationFrame(paintLive);
      }
    }

    state.ctrl = new AbortController();
    var onEvent = function (ev) {
      if (ev.meta) { Object.assign(bm.meta, { lane: ev.meta.lane, lane_label: ev.meta.lane_label }); if (ev.meta.power) setPower(ev.meta.power); markRead(); }
      if (ev.notice) nowSay(ev.notice.replace(/[.]$/, ""));
      if (ev.care) {
        bm.care = ev.care;
        markRead();
        if (el) el.insertAdjacentHTML("afterbegin", careHtml(ev.care)); else turn();
        mood("care");
      }
      if (ev.step) {
        markRead();
        bm.steps = bm.steps || [];
        var cur = bm.steps.find(function (x) { return x.id === ev.step.id; });
        if (cur) Object.assign(cur, ev.step); else bm.steps.push(ev.step);
        if (ev.step.state === "run" && ev.step.label) nowSay(ev.step.label);
        if (!bm.care) {
          var t = ev.step.tool;
          if (ev.step.state === "run") mood(t === "web_search" || t === "read_page" || t === "recall" ? "search" : "think");
          else if (t === "remember" && ev.step.state !== "blocked") each("nod");
        }
        scrollEnd();
      }
      if (ev.sources) { bm.sources = ev.sources; turn().querySelector(".sources-host").innerHTML = sourcesHtml(bm.sources); }
      if (ev.reset) {
        gen++;
        raw = ""; bm.content = ""; queued = shown = 0; live = null; chain = Promise.resolve();
        if (el) el.querySelectorAll(".bub:not(.typing)").forEach(function (b) { b.remove(); });
        typing(true);
      }
      if (ev.delta) {
        markRead();
        if (nowEl) nowDone();
        if (!raw && !bm.care) mood("talk");
        raw += ev.delta;
        pulse(Math.min(0.9, 0.25 + ev.delta.length * 0.04));
        onText(false);
      }
      if (ev.done) { bm.meta.impact = ev.impact; bm.meta.partial = ev.partial; if (ev.lane_label) bm.meta.lane_label = ev.lane_label; if (ev.demo) bm.meta.demo = true; }
      if (ev.error) bm.error = ev.error;
    };

    try {
      await stream(ch, images, onEvent, state.ctrl.signal);
    } catch (e) {
      if (e.name !== "AbortError") {
        // No backend: say so, and play the scripted demo instead.
        $("offline").hidden = false;
        try { await demo(text, onEvent, state.ctrl.signal); } catch (e2) {}
      }
    }
    state.ctrl = null;
    markRead();
    onText(true);
    await chain;
    finished = true;
    typing(false);
    nowDone();
    var said = bm.content.trim();
    // Left on read: only when there is truly nothing to say and nobody is at risk.
    if (!said && bm.read && !bm.care && !bm.error) {
      bm.onRead = true;
      if (el) { el.remove(); el = null; }
      each("nod");
    } else if (!said && !bm.care) {
      bm.content = bm.error || "Stopped before I could answer.";
      addBubble(turn(), bm, bm.content, 0, true);
      avatar(el, who(bm.companion));
    }
    if (el) el.querySelector(".meta").innerHTML = metaHtml(bm.meta);
    if (bm.meta.impact) {
      state.sess.wh += bm.meta.impact.wh;
      state.sess.g += bm.meta.impact.g;
      $("stSess").textContent = Kit.fmtWh(state.sess.wh);
    }
    delete bm.read;
    bm.at = bm.at || Date.now();
    ch.messages.push(bm);
    ch.updated = Date.now();
    receipt();
    save();
    if (window.Sync) Sync.push(ch);
    setBusy(false);
    // Settle: stay soft if care is showing, otherwise back to idle.
    if (bm.care) mood("care"); else { mood("idle"); if (ch.messages.length === 2 && !bm.onRead) cheer(); }
    scrollEnd();
    // Anything you sent meanwhile goes now, as the next turn.
    if (state.queue.length && state.chatId === ch.id) {
      var next = state.queue.splice(0);
      next.forEach(function (q) { q.el.remove(); });
      send(next.map(function (q) { return q.text; }));
    }
  }

  // What the model sees: its own tags kept, your tapbacks noted on your next text.
  function history(ch) {
    return ch.messages.map(function (m, i) {
      if (m.role === "user") {
        var prev = ch.messages[i - 1], note = "";
        if (prev && prev.role === "assistant" && prev.taps) {
          var t = Object.keys(prev.taps).map(function (k) { return prev.taps[k]; });
          if (t.length) note = "(I tapped " + t.join(" ") + " on your last texts.)\n";
        }
        return { role: "user", content: note + m.content };
      }
      return { role: "assistant", content: ((m.react ? "[react:" + m.react + "] " : "") + (m.onRead ? "[read]" : m.content || "…")).trim() };
    });
  }

  // Each reply is a cloud run: if the connection drops, re-attach and carry on
  // from the last event seen. Stop cancels the run on the server too.
  async function stream(ch, images, onEvent, signal) {
    var runId = "r-" + uid().replace(/[^\w-]/g, "");
    var seen = 0, finished = false;
    var cancel = function () { fetch(Kit.api + "/v1/runs/" + runId + "/cancel", { method: "POST" }).catch(function () {}); };
    signal.addEventListener("abort", cancel, { once: true });
    var read = async function (res) {
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        var i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          var line = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (line.indexOf("data:") !== 0) continue;
          var ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
          seen++;
          if (ev.done || ev.error) finished = true;
          onEvent(ev);
        }
      }
    };
    var res = await fetch(Kit.api + "/v1/chat", {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      signal: signal,
      body: JSON.stringify({
        run_id: runId,
        chat_id: ch.id,
        companion: state.companion,
        bot: who(state.companion).bot || undefined,
        brand: Kit.brand,
        mode: state.mode,
        user: { name: state.user.name, about: state.user.about, tz: TZ },
        images: images,
        messages: history(ch),
      }),
    });
    if (res.status === 429) { onEvent({ error: "That is a lot of messages in a minute. Give it a moment and try again." }); return; }
    if (res.status === 401) { onEvent({ error: "Sign in again to keep texting." }); signedOut(); return; }
    if (!res.ok || !res.body) throw new Error("backend " + res.status);
    try { await read(res); } catch (e) { if (e.name === "AbortError") throw e; }
    // Dropped mid-run: the work is still going on the server. Pick it back up.
    for (var tries = 0; !finished && !signal.aborted && tries < 5; tries++) {
      await new Promise(function (r) { setTimeout(r, 800 * (tries + 1)); });
      try {
        var again = await fetch(Kit.api + "/v1/runs/" + runId + "?from=" + seen, { signal: signal });
        if (!again.ok) break;
        await read(again);
        if (again.headers.get("X-Run-Status") !== "running") break;
      } catch (e) { if (e.name === "AbortError") throw e; }
    }
    signal.removeEventListener("abort", cancel);
  }

  // Scripted stand-in used only when the backend cannot be reached.
  var DEMO = "Hey! Heads up: this is a scripted text, because the Blinks backend isn't connected yet.\n\nOnce it is, I'll text back for real. Short and quick, and longer only when it's worth it.";
  var CRISIS = /\b(kill myself|suicid|end my life|want to die|self[- ]?harm|don'?t want to (live|be here))\b/i;
  async function demo(text, onEvent, signal) {
    var lane = who(state.companion).lane;
    onEvent({ meta: { lane: lane.toLowerCase(), lane_label: lane } });
    var body = DEMO;
    if (/^(ok(ay)?|k|thanks|thank you|thx|ty|cool|nice|night|gn|👍)[.!]*$/i.test(text.trim())) body = "[react:👍] [read]";
    else if (/\b(lol|haha|lmao|joke)\b/i.test(text)) body = "[react:😂] Okay, that one got me.\n\n(It's scripted, but still.)";
    if (CRISIS.test(text)) {
      onEvent({ care: { emergency: "your local emergency number", lines: [{ name: "Find a Helpline", how: "Free helplines in 130+ countries", href: "https://findahelpline.com" }] } });
      body = "I'm really glad you said that out loud. I'm only a scripted demo right now, so please reach one of the people above. They're there for exactly this, and you deserve a real voice tonight.";
    }
    var words = body.split(/(\s+)/);
    for (var i = 0; i < words.length; i++) {
      if (signal.aborted) return;
      onEvent({ delta: words[i] });
      await new Promise(function (r) { setTimeout(r, 22 + Math.random() * 40); });
    }
    var out = Math.ceil(body.length / 3.6);
    var wh = (out / 1000) * 0.1 * 1.2 * 1.5;
    onEvent({ done: true, demo: true, impact: { wh: wh, g: (wh / 1000) * 445 } });
  }

  /* ── Composer ──────────────────────────────────────────────────── */
  function grow() {
    var t = $("input");
    t.style.height = "auto";
    t.style.height = Math.min(190, t.scrollHeight) + "px";
    $("send").disabled = !t.value.trim() && !state.files.length;
  }
  var TEXTY = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh|sql))|\.(txt|md|csv|json|js|ts|py|html|css|xml|yml|yaml|sql|sh|log|ini|toml)$/i;
  async function uploadFiles() {
    var files = state.files.splice(0);
    renderThumbs();
    var notes = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      try {
        var res = await fetch(Kit.api + "/v1/files", { method: "POST", headers: await authHeaders({ "Content-Type": f.type || "application/octet-stream", "X-File-Name": encodeURIComponent(f.name) }), body: f });
        var meta = await res.json();
        if (!res.ok) throw new Error(meta.error || "upload failed");
        var line = "[File: " + f.name + ", " + Math.max(1, Math.round(f.size / 1024)) + " KB, id " + meta.id + "]";
        if (f.size <= 200000 && (TEXTY.test(f.type) || TEXTY.test(f.name))) line += "\n```\n" + (await f.text()).slice(0, 200000) + "\n```";
        notes.push(line);
      } catch (e) {
        showNotice(String(e.message || e).indexOf("Low Light") !== -1 ? e.message : "Could not attach " + f.name + ": " + (e.message || "upload failed") + ".");
        return null;
      }
    }
    return notes.join("\n\n");
  }
  function showNotice(t) {
    var n = $("notice");
    n.textContent = t;
    n.hidden = false;
    clearTimeout(showNotice.t);
    showNotice.t = setTimeout(function () { n.hidden = true; }, 6000);
  }
  function renderThumbs() {
    var host = $("thumbs");
    host.hidden = !state.images.length && !state.files.length;
    host.innerHTML = "";
    state.files.forEach(function (f, i) {
      var d = document.createElement("div");
      d.className = "thumb file";
      d.innerHTML = "<span>" + Kit.icon("file-text") + Kit.esc(f.name.length > 18 ? f.name.slice(0, 16) + "..." : f.name) + '</span><button type="button" aria-label="Remove file">' + Kit.icon("x") + "</button>";
      d.querySelector("button").addEventListener("click", function () { state.files.splice(i, 1); renderThumbs(); });
      host.appendChild(d);
    });
    state.images.forEach(function (im, i) {
      var d = document.createElement("div");
      d.className = "thumb";
      d.innerHTML = '<img alt="Attached image" src="data:' + im.mime + ";base64," + im.data + '"><button type="button" aria-label="Remove image">' + Kit.icon("x") + "</button>";
      d.querySelector("button").addEventListener("click", function () { state.images.splice(i, 1); renderThumbs(); });
      host.appendChild(d);
    });
  }
  // Shrinks to ~1 megapixel JPEG so it travels light.
  function readImage(file) {
    return new Promise(function (resolve) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var k = Math.min(1, Math.sqrt(1048576 / (img.width * img.height)));
        var cv = document.createElement("canvas");
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve({ mime: "image/jpeg", data: cv.toDataURL("image/jpeg", 0.85).split(",")[1] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  /* ── Low Light: the home brain is away ─────────────────────────── */
  function setPower(p) {
    p = p === "lowlight" ? "lowlight" : "full";
    if (p === state.power) return;
    state.power = p;
    document.documentElement.classList.toggle("lowlight", p === "lowlight");
    $("power").hidden = p !== "lowlight";
    mountFigs();
    renderComps();
  }
  function pollPower() {
    fetch(Kit.api + "/v1/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) { setPower(s.mode); }).catch(function () {});
  }

  /* ── Settings ──────────────────────────────────────────────────── */
  function openSettings() {
    $("setName").value = state.user.name || "";
    $("setAbout").value = state.user.about || "";
    if (window.Sync) Sync.renderAccount($("acct"));
    $("settings").showModal();
    loadMind();
  }
  // Memory, scheduled tasks and the inbox, from the person's Mind on the server.
  function loadMind() {
    var host = $("mind");
    host.innerHTML = '<p class="help">Loading what Cloak remembers.</p>';
    api("/v1/me").then(function (d) {
      var when = function (ms) { return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
      var row = function (text, sub, kind, id) { return '<li><div><span>' + Kit.esc(text) + "</span>" + (sub ? "<small>" + Kit.esc(sub) + "</small>" : "") + '</div><button type="button" class="iconbtn" data-del="' + kind + ":" + id + '" aria-label="Delete">' + Kit.icon("trash") + "</button></li>"; };
      host.innerHTML =
        '<p class="lbl">Inbox</p>' + (d.inbox.length ? '<ul class="mind">' + d.inbox.map(function (i) { return row((i.kind === "task" ? "Task: " : "Finished while you were away: ") + i.title, byId[i.companion] ? byId[i.companion].name + ", " + when(i.created) : when(i.created), "inbox", i.id).replace("<li>", '<li data-open="' + i.id + '">'); }).join("") + "</ul>" : '<p class="help">Results from scheduled tasks, and replies that finished after you left, land here.</p>') +
        '<p class="lbl">Scheduled</p>' + (d.tasks.length ? '<ul class="mind">' + d.tasks.map(function (t) { return row(t.title, "Next " + when(t.at) + (t.repeat !== "none" ? ", " + t.repeat : ""), "tasks", t.id); }).join("") + "</ul>" : '<p class="help">Nothing scheduled. Ask a companion to remind you or to check on something later.</p>') +
        '<p class="lbl">Memory</p>' + (d.memories.length ? '<ul class="mind">' + d.memories.map(function (m) { return row(m.fact, m.kind + ", " + m.day, "memory", m.id); }).join("") + "</ul>" : '<p class="help">Nothing remembered yet. The companions keep lasting things you tell them, and you can delete any of it here.</p>');
      var unseen = d.inbox.filter(function (i) { return !i.seen; }).map(function (i) { return i.id; });
      if (unseen.length) api("/v1/inbox/seen", { method: "POST", body: JSON.stringify({ ids: unseen }) }).then(badge);
      host.onclick = function (e) {
        var del = e.target.closest("[data-del]");
        if (del) { var p = del.getAttribute("data-del").split(":"); api("/v1/" + p[0] + "/" + p[1], { method: "DELETE" }).then(loadMind); return; }
        var open = e.target.closest("[data-open]");
        if (open) {
          var item = d.inbox.find(function (i) { return String(i.id) === open.getAttribute("data-open"); });
          if (!item) return;
          // Open the result as a chat so it can be continued.
          var c = { id: uid(), companion: byId[item.companion] ? item.companion : "cloak", title: item.title.slice(0, 60), updated: Date.now(), messages: [{ role: "user", content: item.title }, { role: "assistant", content: item.body, companion: item.companion, sources: (item.meta || {}).sources, meta: { lane: (item.meta || {}).lane || "task", lane_label: item.kind === "task" ? "Scheduled task" : "Finished in the background", impact: (item.meta || {}).impact } }] };
          state.chats.unshift(c); save(); $("settings").close(); openChat(c.id);
        }
      };
    }).catch(function () { host.innerHTML = '<p class="help">Memory, tasks and the inbox need the preview backend, which is not connected.</p>'; });
  }
  function badge() {
    api("/v1/me").then(function (d) {
      var n = d.inbox.filter(function (i) { return !i.seen; }).length;
      var b = $("inboxBadge"); b.hidden = !n; b.textContent = n;
    }).catch(function () {});
  }
  function whoLabel() { $("whoName").textContent = (state.user.name || "").trim() || "You"; }

  /* ── Wire up ───────────────────────────────────────────────────── */
  function init() {
    renderComps();
    mountFigs();
    whoLabel();

    var q = new URLSearchParams(location.search);
    if (byId[q.get("c")]) { state.companion = q.get("c"); Kit.set("pv_companion", state.companion); renderComps(); mountFigs(); }
    if (q.get("make")) { history.replaceState(null, "", location.pathname); setTimeout(function () { editBlink(null); }, 300); }
    renderThread();
    renderHist();

    var sp = SPONSORS[Math.floor(Math.random() * SPONSORS.length)];
    $("spTitle").textContent = sp.title;
    $("spBody").textContent = sp.body;

    $("form").addEventListener("submit", function (e) { e.preventDefault(); send(); });
    $("input").addEventListener("input", function () {
      grow();
      if (state.busy) return;
      mood("listen");
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () { if (!state.busy) mood("idle"); }, 1600);
    });
    $("input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $("attach").addEventListener("click", function () { $("file").click(); });
    $("file").addEventListener("change", async function () {
      for (var i = 0; i < this.files.length; i++) {
        var f = this.files[i];
        if (/^image\/(png|jpeg|webp)$/.test(f.type) && state.images.length < 3) {
          var im = await readImage(f);
          if (im) state.images.push(im);
          continue;
        }
        if (state.power === "lowlight") { showNotice("Files are resting while Cloak is in Low Light. Images still work."); continue; }
        if (f.size > 100 * 1024 * 1024) { showNotice(f.name + " is over 100 MB."); continue; }
        if (state.files.length < 5) state.files.push(f);
      }
      this.value = "";
      renderThumbs();
    });
    $("newChat").addEventListener("click", function () { newChat(); closeSide(); });
    $("menu").addEventListener("click", function () { $("app").classList.add("open"); });
    $("scrim").addEventListener("click", closeSide);
    // Thinking mode: one quiet button, the choices in a menu.
    var modeBtn = $("modeBtn"), modeMenu = $("modeMenu");
    function modeOpen(on) {
      modeMenu.hidden = !on;
      modeBtn.setAttribute("aria-expanded", on ? "true" : "false");
      if (on) (modeMenu.querySelector('[aria-checked="true"]') || modeMenu.firstElementChild).focus();
    }
    modeBtn.addEventListener("click", function () { modeOpen(modeMenu.hidden); });
    modeMenu.addEventListener("click", function (e) {
      var b = e.target.closest("[data-mode]");
      if (!b) return;
      state.mode = b.getAttribute("data-mode");
      modeMenu.querySelectorAll("[data-mode]").forEach(function (x) { x.setAttribute("aria-checked", x === b ? "true" : "false"); });
      $("modeName").textContent = b.querySelector("b").textContent;
      modeBtn.classList.toggle("on", state.mode !== "auto");
      modeOpen(false);
      modeBtn.focus();
    });
    modeMenu.addEventListener("keydown", function (e) {
      var items = Array.prototype.slice.call(modeMenu.querySelectorAll("[data-mode]")), i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === "Escape") { modeOpen(false); modeBtn.focus(); }
    });
    document.addEventListener("pointerdown", function (e) { if (!modeMenu.hidden && !e.target.closest(".modes")) modeOpen(false); });
    $("openSettings").addEventListener("click", openSettings);
    $("openSettings2").addEventListener("click", openSettings);
    $("setForm").addEventListener("submit", function (e) {
      if (e.submitter && e.submitter.value === "save") {
        state.user = { name: $("setName").value.trim(), about: $("setAbout").value.trim() };
        Kit.set("pv_user", JSON.stringify(state.user));
        whoLabel();
        if (!chat()) renderThread();
      }
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeSide(); });

    var hooks = {
      onBots: function (remote) {
        var local = Maker.load();
        if (!remote.length && local.length) { Sync.pushBots(local); return; }
        Kit.set("pv_bots", JSON.stringify(remote));
        rebuild();
        if (!byId[state.companion]) state.companion = "cloak";
        renderComps();
        mountFigs();
      },
      onChats: function (remote) {
        // Merge by id, newest copy wins.
        remote.forEach(function (r) {
          var i = state.chats.findIndex(function (c) { return c.id === r.id; });
          if (i === -1) state.chats.push(r); else if (r.updated > state.chats[i].updated) state.chats[i] = r;
        });
        save();
        renderHist();
      },
      local: function () { return state.chats; },
    };

    pollPower();
    setInterval(pollPower, 60000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { badge(); pollPower(); } });
    // Blinks needs a Cloak account: sign in first, then everything syncs.
    function go() {
      Sync.init(hooks);
      badge();
      if (q.get("q")) { history.replaceState(null, "", location.pathname); send(q.get("q")); }
      else if (matchMedia("(min-width: 781px)").matches) $("input").focus();
    }
    Sync.ready().then(function (u) { if (u) go(); else Sync.gate(go); });
  }
  init();
})();
