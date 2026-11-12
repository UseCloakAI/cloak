/* The app: text Cloak (or a Blink you made), watch it listen, think and answer.
   One continuous chat per Blink, like a messaging app. The home-PC brain keeps
   the real copy (and compacts it); the app keeps one in localStorage and
   Supabase, and catches up from the brain (/v1/blink/since) for replies that
   finished while it was closed and messages Blinks sent each other.
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

  var MOOD_LABEL = { idle: "Here", listen: "Listening", think: "Thinking", search: "Looking it up", work: "Working", talk: "Talking", happy: "Glad", care: "With you", sleep: "Resting" };
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
    unread: load("pv_unread", {}),
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
    // One chat per Blink (older extra ones are left alone); images are never stored.
    state.chats.sort(function (a, b) { return b.updated - a.updated; });
    state.chats = state.chats.slice(0, 40);
    state.chats.forEach(function (c) { if (c.messages.length > 600) c.messages = c.messages.slice(-600); });
    Kit.set("pv_chats", JSON.stringify(state.chats));
  }
  // Each Blink has exactly one chat: the newest one with it.
  function chatFor(id) { return state.chats.filter(function (c) { return c.companion === id; }).sort(function (a, b) { return b.updated - a.updated; })[0] || null; }
  function chat() { return chatFor(state.companion); }
  function newChatFor(id) {
    var ch = { id: uid(), companion: id, title: who(id).name, messages: [], updated: Date.now() };
    state.chats.unshift(ch);
    return ch;
  }
  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); }

  /* ── Creatures ─────────────────────────────────────────────────── */
  // Every live figure of a Blink on the page (the big block, the top chip,
  // its sidebar row, every little avatar in the chat) is in this crowd, and
  // they all feel the same thing at the same moment.
  var crowd = [];
  function track(id, f) { crowd.push({ id: id, f: f }); return f; }
  function mates() {
    crowd = crowd.filter(function (x) { return x.f.el && x.f.el.isConnected; });
    return crowd.filter(function (x) { return x.id === state.companion; }).map(function (x) { return x.f; });
  }
  var nowMood = "idle";
  function mood(m, forId) {
    if (forId && forId !== state.companion) return; // a reply still finishing for a Blink you left
    nowMood = m;
    mates().forEach(function (f) { f.set(m); });
    rollText($("mood"), MOOD_LABEL[m] || "Here");
    $("blinkBtn").setAttribute("data-mood", m);
  }
  // Swaps a label by sliding the old one up and out and the new one in.
  // Cloak's slot roll (chat.usecloak.org Effort label): the slot eases to the
  // new width, the old text leaves upward, the new one springs up from below.
  function rollText(el, text) {
    if (!el) return;
    var from = el._rollTo != null ? el._rollTo : el.textContent;
    if (from === text) return;
    if (el._roll) el._roll();
    if (!from || matchMedia("(prefers-reduced-motion: reduce)").matches || !el.animate || !el.isConnected || !el.offsetWidth) { el.textContent = text; return; }
    var slot = document.createElement("span"), out = document.createElement("span"), inn = document.createElement("span");
    slot.className = "m-roll";
    out.textContent = from; inn.textContent = text;
    out.setAttribute("aria-hidden", "true");
    el.textContent = "";
    el.appendChild(slot);
    slot.appendChild(out);
    var w0 = slot.getBoundingClientRect().width;
    slot.replaceChild(inn, out);
    var w1 = slot.getBoundingClientRect().width;
    slot.appendChild(out);
    el._rollTo = text;
    var anims = [
      slot.animate([{ width: w0 + "px" }, { width: w1 + "px" }], { duration: 380, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" }),
      out.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-105%)", opacity: 0 }], { duration: 200, easing: "cubic-bezier(.55,0,1,.45)", fill: "forwards" }),
      inn.animate([{ transform: "translateY(105%)" }, { transform: "none" }], { duration: 420, delay: 60, easing: "cubic-bezier(.3,1.35,.55,1)", fill: "backwards" }),
    ];
    var done = false;
    el._roll = function () {
      if (done) return; done = true;
      anims.forEach(function (x) { x.cancel(); });
      if (slot.parentNode === el) el.textContent = text;
      el._roll = null; el._rollTo = null;
    };
    anims[2].finished.then(el._roll, function () {});
  }
  // A counter on a scroll wheel: each digit that changes rolls to the next, blurred in motion.
  function wheel(el, text) {
    var cells = el.querySelectorAll(":scope > .wd");
    if (cells.length !== text.length) {
      el.textContent = "";
      for (var i = 0; i < text.length; i++) { var c = document.createElement("span"); c.className = "wd"; c.innerHTML = "<b></b>"; c.firstChild.textContent = text[i]; el.appendChild(c); }
      return;
    }
    cells.forEach(function (c, i) {
      var cur = c.querySelector("b:not(.wd-out)");
      if (cur.textContent === text[i]) return;
      c.querySelectorAll(".wd-out").forEach(function (x) { x.remove(); });
      cur.className = "wd-out";
      setTimeout(function () { cur.remove(); }, 380);
      var n = document.createElement("b"); n.className = "wd-in"; n.textContent = text[i];
      c.appendChild(n);
    });
  }
  function pulse(n) { mates().forEach(function (f) { f.pulse(n); }); }
  function each(fn) { mates().forEach(function (f) { if (f[fn]) f[fn](); }); }
  function cheer() { each("cheer"); }
  function mountFigs() {
    var c = who(state.companion);
    ["stage", "top"].forEach(function (k) { if (fig[k]) fig[k].destroy(); });
    fig.stage = null;
    fig.top = track(c.id, Creatures.mount($("topAv"), look(c), { label: c.name, mood: nowMood })); // alive, in step with every other figure of this Blink
    if (bpFig) bpFig.destroy();
    bpFig = track(c.id, Creatures.mount($("bpAv"), look(c), { label: c.name, mood: nowMood }));
    $("bpName").textContent = c.name;
    $("bpRole").textContent = c.role;
    whenLoaded(favicon);
    $("topName").textContent = c.name;
    $("blinkBtn").setAttribute("aria-label", c.name + ", " + ($("mood").textContent || "Here") + ". Open " + c.name + "'s settings");

    $("blinkBtn").style.setProperty("--blink", Creatures.color(look(c)));
    $("bpanel").style.setProperty("--blink", Creatures.color(look(c)));
    renderBpActions(c);
    $("input").placeholder = "Message " + c.name;
    document.title = c.name + " | " + Kit.brand;
    setTimeout(function () { each("wave"); }, 250);
  }

  // After the page has finished loading (so the tab never spins for it).
  function whenLoaded(fn) {
    var go = function () { if (window.requestIdleCallback) requestIdleCallback(function () { fn(); }, { timeout: 600 }); else setTimeout(fn, 200); };
    if (document.readyState === "complete") go(); else window.addEventListener("load", go, { once: true });
  }
  // The tab icon is the Blink you are with: its still drawing, crisp at 32px.
  function favicon() {
    var c = who(state.companion), tmp = document.createElement("div");
    tmp.style.cssText = "position:absolute;width:64px;height:64px;left:-9999px";
    document.body.appendChild(tmp);
    var still = Creatures.mount(tmp, look(c), { label: c.name, still: true });
    var svg = tmp.querySelector("svg");
    if (!svg) { tmp.remove(); return; }
    var x = svg.cloneNode(true);
    x.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    x.setAttribute("viewBox", "-14 -26 268 268");
    x.removeAttribute("style");
    x.removeAttribute("role");
    x.removeAttribute("aria-label");
    var root = x.querySelector(".cr-root");
    if (root) root.removeAttribute("filter"); // no hand-drawn wobble at this size
    var dots = x.querySelector(".cr-dots");
    if (dots) dots.remove();
    var src = x.outerHTML.replace(/var\(--ink,\s*(#[0-9a-fA-F]{3,8})\)/g, "$1");
    $("favicon").href = "data:image/svg+xml," + encodeURIComponent(src);
    still.destroy(); tmp.remove();
  }

  /* ── Sidebar ───────────────────────────────────────────────────── */
  var sideFigs = [];
  // Last thing said with a Blink, for its row. Plain text, no tags.
  function preview(id) {
    var ch = chatFor(id);
    if (!ch || !ch.messages.length) return null;
    var m = ch.messages[ch.messages.length - 1];
    var t = String(m.onRead ? "Read" : m.content || "").replace(/```[\s\S]*?```/g, "[code]").replace(/\[react:[^\]]*\]|\[read\]/gi, "").replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim();
    if (m.sent) return "Sent message to " + m.sent;
    if (m.to) return "Replied to " + m.to;
    return (m.from ? m.from + ": " : m.role === "user" ? "You: " : "") + t;
  }
  function when(id) {
    var ch = chatFor(id);
    if (!ch || !ch.messages.length) return "";
    var t = ch.messages[ch.messages.length - 1].at || ch.updated;
    return Date.now() - t < 864e5 ? hm(t) : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  }
  // Rows keep their live Blinks; only the words and the unread dot change.
  function refreshRows() {
    document.querySelectorAll("#comps .comp").forEach(function (r) {
      var id = r.dataset.id, c = byId[id];
      if (!c) return;
      r.querySelector(".comp-tx span").textContent = preview(id) || c.role;
      r.querySelector(".comp-tx em").textContent = when(id);
      var n = state.unread[id] || 0;
      r.classList.toggle("unread", !!n);
      var dot = r.querySelector(".dot");
      if (n && !dot) r.querySelector(".comp-av").insertAdjacentHTML("beforeend", '<i class="dot" aria-hidden="true"></i>');
      if (!n && dot) dot.remove();
      r.setAttribute("aria-label", c.name + (n ? ", " + n + " new" : ""));
    });
  }
  // The Blinks list updates in place: rows that exist stay put (their
  // Blinks keep living), new ones slide in, gone ones leave, and a row's
  // Blink is redrawn only when its look changes. Rebuilding on every update
  // made the list blink on reload.
  var rows = {}, firstDraw = true;
  function rowSig(c) { return JSON.stringify([c.name, c.custom, look(c)]); }
  function makeRow(c) {
    var b = document.createElement("div");
    b.className = "comp" + (firstDraw ? " conv-in" : " row-in");
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    b.dataset.id = c.id;
    var go = function () { openBlink(c.id); goPage("chat"); closeSide(); };
    b.addEventListener("click", function (e) {
      if (e.target.closest(".comp-edit")) { editBlink(c.id); return; }
      go();
    });
    b.addEventListener("keydown", function (e) { if ((e.key === "Enter" || e.key === " ") && e.target === b) { e.preventDefault(); go(); } });
    b.addEventListener("animationend", function () { b.classList.remove("conv-in", "row-in"); });
    return { el: b, fig: null, sig: "" };
  }
  function fillRow(r, c) {
    var sig = rowSig(c);
    if (r.sig === sig) return;
    r.sig = sig;
    if (r.fig) r.fig.destroy();
    r.el.setAttribute("data-tip", c.name);
    r.el.innerHTML = '<div class="comp-av"></div><div class="comp-tx"><b>' + Kit.esc(c.name) + "<em></em></b><span></span></div>" +
      (c.custom ? '<button class="iconbtn comp-edit" aria-label="Edit ' + Kit.esc(c.name) + '">' + Kit.icon("pencil-simple") + "</button>" : "");
    r.fig = track(c.id, Creatures.mount(r.el.querySelector(".comp-av"), look(c), { label: c.name, mood: c.id === state.companion ? nowMood : "idle" }));
  }
  function renderComps() {
    var host = $("comps");
    if (!host.querySelector(".sb-ink")) host.insertAdjacentHTML("afterbegin", '<i class="sb-ink" aria-hidden="true"></i>');
    var q = ($("search").value || "").toLowerCase();
    // Most recent conversation first, like a messaging app.
    var list = C.slice().sort(function (a, b) { var x = chatFor(a.id), y = chatFor(b.id); return (y ? y.updated : 0) - (x ? x.updated : 0); })
      .filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) !== -1; });
    var keep = {};
    list.forEach(function (c, k) {
      keep[c.id] = 1;
      var r = rows[c.id] || (rows[c.id] = makeRow(c));
      r.el.style.setProperty("--k", k);
      fillRow(r, c);
      r.el.setAttribute("aria-current", c.id === state.companion ? "true" : "false");
      // Only move a row when it is out of place (moving restarts its animations).
      var want = host.children[k + 1];
      if (want !== r.el) host.insertBefore(r.el, want || null);
    });
    Object.keys(rows).forEach(function (id) {
      if (keep[id]) return;
      var r = rows[id];
      delete rows[id];
      if (r.fig) r.fig.destroy();
      r.el.remove();
    });
    firstDraw = false;
    refreshRows();
    requestAnimationFrame(function () { inkTo(true); });
  }
  // The ink: one block that springs between rows, leading edge first.
  var inkAt = null;
  function inkTo(jump) {
    var host = $("comps"), ink = host.querySelector(".sb-ink");
    var on = host.querySelector('.comp[aria-current="true"]');
    if (!ink) return;
    if (!on) { ink.classList.remove("show"); return; }
    var top = on.offsetTop, bottom = host.clientHeight - top - on.offsetHeight;
    ink.classList.toggle("jump", !!jump || inkAt === null);
    ink.classList.toggle("down", inkAt !== null && top > inkAt);
    ink.classList.toggle("up", inkAt !== null && top < inkAt);
    ink.style.setProperty("--ink-t", top + "px");
    ink.style.setProperty("--ink-b", bottom + "px");
    ink.classList.add("show");
    inkAt = top;
  }
  // Opening a Blink opens its one chat. A reply still on its way keeps going
  // on the brain and lands in its own chat.
  function openBlink(id) {
    if (!byId[id]) return;
    if (id !== state.companion) {
      // Let go of the reply here, but leave it running: it keeps going and we keep watching it.
      if (state.ctrl) { state.leaving = true; state.ctrl.abort(); state.leaving = false; }
      state.companion = id;
      Kit.set("pv_companion", id);
      document.querySelectorAll("#comps .comp").forEach(function (r) { r.setAttribute("aria-current", r.dataset.id === id ? "true" : "false"); });
      inkTo(false);
      mountFigs();
    }
    if (state.unread[id]) { delete state.unread[id]; Kit.set("pv_unread", JSON.stringify(state.unread)); refreshRows(); }
    renderThread();
    if (dock === "blink") loadMind();
  }
  function editBlink(id) {
    var bot = id ? Maker.load().find(function (b) { return b.id === id; }) : null;
    Maker.open(bot, {
      onSave: function (b) {
        rebuild();
        renderComps();
        if (state.companion === b.id) { mountFigs(); renderThread(); }
        else openBlink(b.id);
        setTimeout(cheer, 200);
      },
      onDelete: function (gone) {
        rebuild();
        renderComps();
        if (state.companion === gone) openBlink("cloak");
      },
    });
  }
  function closeSide() { $("app").classList.remove("open"); }
  function setCompanion(id) { openBlink(id); }

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
        navigator.clipboard.writeText(code ? code.textContent : pre.textContent).then(function () { rollText(b, "Copied"); setTimeout(function () { rollText(b, "Copy"); }, 1400); });
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
  var TOOL_ICON = { read_file: "file-text", grep_files: "magnifying-glass", message_blink: "chat-circle", compact: "stack", web_search: "magnifying-glass", read_page: "file-text", calculate: "gauge", remember: "brain", recall: "brain", forget: "brain", ask_companion: "chat-circle", schedule_task: "hourglass-medium", list_tasks: "hourglass-medium", cancel_task: "hourglass-medium", look: "eye", team: "stack" };
  function didHtml(steps) {
    if (!steps || !steps.length) return "";
    var tool = function (n) { return steps.filter(function (s) { return s.tool === n; }).length; };
    var parts = [];
    if (tool("web_search")) parts.push("searched " + tool("web_search") + (tool("web_search") === 1 ? " time" : " times"));
    if (tool("read_page")) parts.push("read " + tool("read_page") + (tool("read_page") === 1 ? " page" : " pages"));
    if (tool("read_file") || tool("grep_files")) parts.push("looked through the code");
    if (tool("remember")) parts.push("saved " + tool("remember") + (tool("remember") === 1 ? " memory" : " memories"));
    var talked = steps.filter(function (s) { return s.tool === "message_blink" && s.label; }).map(function (s) { return s.label.replace(/^Messaging\s+/, ""); });
    talked = talked.filter(function (n, i) { return talked.indexOf(n) === i; });
    if (talked.length) parts.push("messaged " + talked.join(" and "));
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
  // A long, structured answer (headings, a table, lots of sections) reads as
  // one card, not a pile of texts.
  var HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  function isDoc(text) {
    var t = String(text || "").replace(/```[\s\S]*?```/g, "");
    var heads = (t.match(/^\s*#{1,6}\s/gm) || []).length, table = /^\s*\|.*\|\s*$/m.test(t), paras = t.split(/\n\s*\n/).filter(function (x) { return x.trim(); }).length;
    return heads >= 1 || table || (t.length > 900 && paras > 3) || (HR.test(t) && t.length > 400);
  }
  function bubbles(text) {
    var out = [], cur = [], fence = false;
    var lines = String(text || "").split("\n").filter(function (l) { return !HR.test(l); }); // dividers never become their own boxes
    if (isDoc(text)) {
      // The answer first: a "Bottom line" / "TL;DR" paragraph moves to the top.
      var paras = lines.join("\n").split(/\n\s*\n/).filter(function (x) { return x.trim(); });
      var bi = paras.findIndex(function (x) { return /^\s*(\*\*|__)?\s*(bottom line|tl;?dr|in short|short answer)\b/i.test(x); });
      if (bi > 0) paras.unshift(paras.splice(bi, 1)[0]);
      return [paras.join("\n\n").trim()].filter(Boolean);
    }
    lines.forEach(function (line) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (!fence && !line.trim()) { if (cur.length) { out.push(cur.join("\n")); cur = []; } return; }
      cur.push(line);
    });
    if (cur.length) out.push(cur.join("\n"));
    out = out.filter(function (x) { return x.trim(); });
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
  // A message another Blink sent this one, shown as a quiet note.
  // Blinks talking to each other: one small gray line, collapsed until you open it.
  function isRelay(m) { return !!(m.from || m.to || m.sent); }
  function relayTurn(m) {
    var el = document.createElement("details");
    el.className = "relay";
    var peer = m.from || m.to || m.sent;
    el.innerHTML = "<summary>" + Kit.icon(m.from ? "arrow-down-left" : "arrow-up-right") + "<span>" + (m.from ? "Received message from " : "Sent message to ") + Kit.esc(peer) + "</span></summary><p></p>";
    el.querySelector("p").textContent = m.content || "";
    $("threadIn").appendChild(el);
    return el;
  }
  function botTurn(m) {
    var c = who(m.companion || state.companion);
    var el = document.createElement("div");
    el.className = "turn them";
    el.innerHTML = (m.care ? careHtml(m.care) : "") + (m.task ? '<div class="task-tag">' + Kit.icon("hourglass-medium") + "Scheduled: " + Kit.esc(m.task) + "</div>" : "") + '<div class="steps-host">' + didHtml(m.steps) + '</div><div class="row"><div class="av" aria-hidden="true"></div><div class="stack"></div></div><div class="tfoot"><div class="sources-host">' + sourcesHtml(m.sources) + '</div><div class="meta">' + (m.content || m.care ? metaHtml(m.meta || {}) : "") + "</div></div>";
    $("threadIn").appendChild(el);
    hookDid(el);
    var segs = bubbles(m.content);
    segs.forEach(function (t, i) { addBubble(el, m, t, i, false); });
    if (m.made) madeCard(el, m.made);
    if (segs.length) avatar(el, c);
    return el;
  }
  // Replies carry no avatar: the Blink only shows up beside its status line
  // while it works (nowSay), like Grok's bot.
  // "Meet Biscuit": the card for a Blink this one made.
  function madeCard(el, made) {
    var c = byId[made.id];
    if (!c || el.querySelector(".made-card")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "made-card";
    b.innerHTML = '<span class="mc-av" aria-hidden="true"></span><span class="mc-tx"><small>New Blink</small><b>Meet ' + Kit.esc(c.name) + "</b><span>" + Kit.esc(c.role) + '</span></span><span class="cc-go">Say hi</span>';
    el.querySelector(".stack").appendChild(b);
    Creatures.mount(b.querySelector(".mc-av"), look(c), { label: c.name, mood: "happy" });
    b.addEventListener("click", function () { openBlink(c.id); });
  }
  function avatar(el, c) {
    return;
    var av = el.querySelector(".av");
    if (av && !av.firstChild) track(c.id, Creatures.mount(av, look(c), { label: c.name, mood: c.id === state.companion ? nowMood : "idle" }));
  }
  function addBubble(turn, m, text, i, anim) {
    var b = document.createElement("div");
    b.className = "bub them" + (anim ? " pop" : "") + (/```|^\s*\|/m.test(text) ? " wide" : "");
    b.setAttribute("data-i", i);
    b.innerHTML = '<div class="prose"></div><button type="button" class="tapbtn" aria-label="React">' + Kit.icon("hand-heart") + "</button>";
    var p = b.firstChild;
    var ch0 = chat(), st0 = ch0 && ch0.messages.indexOf(m) !== -1 ? codeSt : CodeCanvas.replay((ch0 ? ch0.messages : []).concat([m]));
    var cz = CodeCanvas.chipify(text, st0);
    p.innerHTML = chipHtml(md(cz.text), cz.chips);
    if (cz.chips.length) b.classList.add("has-code");
    if (isDoc(text)) {
      b.classList.add("doc");
      var more = document.createElement("button");
      more.type = "button"; more.className = "doc-more"; more.textContent = "Show all";
      more.addEventListener("click", function (e) { e.stopPropagation(); var open = b.classList.toggle("open"); more.textContent = open ? "Show less" : "Show all"; if (!open) b.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
      b.appendChild(more);
      requestAnimationFrame(function () { if (p.scrollHeight > 400) b.classList.add("clip"); });
    }
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
    for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user" && !msgs[i].from) { li = i; break; }
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
    codeState();
    if (dock === "code") renderCode();
    var host = $("threadIn");
    if (fig.empty) { fig.empty.destroy(); fig.empty = null; }
    closePicker();
    host.innerHTML = "";
    var ch = chat();
    if (!ch || !ch.messages.length) {
      var c = who(state.companion);
      var name = (state.user.name || "").trim();
      host.innerHTML = '<div class="empty"><div class="empty-fig"></div><h1>' + Kit.esc(c.hello) + "</h1><p>" + (name ? Kit.esc(name) + ", this is " : "This is ") + Kit.esc(c.name) + ". " + Kit.esc(c.about) + '</p><div class="starters"></div></div>';
      fig.empty = track(c.id, Creatures.mount(host.querySelector(".empty-fig"), look(c), { label: c.name, mood: nowMood }));
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
      if (isRelay(m)) relayTurn(m);
      else if (m.role === "user") { var nx = ch.messages[i + 1]; userTurn(m, nx && nx.role === "assistant" ? nx.react : null); }
      else if (!m.onRead) botTurn(m);
    });
    receipt();
    if (resuming) drawResume();
    jumpEnd();
  }
  // A freshly drawn chat opens at the bottom, no scroll animation; held there
  // while late layout (fonts, code, cards) settles.
  function jumpEnd() {
    var t = $("thread");
    t.style.scrollBehavior = "auto";
    t.scrollTop = t.scrollHeight;
    var n = 0, hold = function () { t.scrollTop = t.scrollHeight; if (++n < 12) requestAnimationFrame(hold); else t.style.scrollBehavior = ""; };
    requestAnimationFrame(hold);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (t.style.scrollBehavior === "auto" || t.scrollHeight - t.scrollTop - t.clientHeight < 400) { t.style.scrollBehavior = "auto"; t.scrollTop = t.scrollHeight; t.style.scrollBehavior = ""; } });
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
    // Mid-reply: hand it to the running turn so the Blink can take it in now.
    if (state.runId) fetch(Kit.api + "/v1/runs/" + state.runId + "/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text }) }).catch(function () {});
    r.querySelector("button").addEventListener("click", function () { state.queue.splice(state.queue.indexOf(item), 1); el.remove(); });
    state.queue.push(item);
    scrollEnd(true);
  }
  // Leaving a Blink mid-reply only lets go of it here: the brain finishes the
  // reply and it arrives in that Blink's chat (catchUp).
  function stop() { if (state.ctrl) state.ctrl.abort(); }

  function flySend() {
    var b = $("send"), ic = b.querySelector("svg");
    if (!ic || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var ghost = ic.cloneNode(true);
    ghost.classList.add("send-fly");
    b.appendChild(ghost);
    ic.style.animation = "none"; void ic.offsetWidth; ic.style.animation = "";
    setTimeout(function () { ghost.remove(); }, 460);
  }
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
    flySend();
    var ch = chat();
    if (!ch || !ch.messages.length) {
      ch = ch || newChatFor(state.companion);
      $("threadIn").innerHTML = "";
      if (fig.empty) { fig.empty.destroy(); fig.empty = null; }
    }
    var mine = state.companion;
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
    ch.updated = now;
    save(); // your message is kept even if the page closes before the reply
    if (window.Sync) Sync.push(ch);
    $("input").value = "";
    grow();
    setBusy(true);
    ch.updated = now;
    refreshRows();
    scrollEnd(true);
    mood("think");

    var bm = { role: "assistant", content: "", companion: state.companion, meta: {} };
    var el = null, typingEl = null, finished = false, readDone = false;
    var raw = "", queued = 0, shown = 0, live = null, liveRaf = 0, chain = Promise.resolve(), gen = 0, reacted = false;
    function turn() { if (!el) el = botTurn({ companion: bm.companion, sources: bm.sources, care: bm.care, meta: {} }); return el; }
    // One line that says what Cloak is doing right now, in its own words.
    var nowEl = null, thinking = false, thinkAt = 0;
    // While it only thinks, the line moves on so it never looks stuck.
    var THINK = ["Thinking", "Reading what you said", "Working out what you mean", "Weighing it up", "Putting it together", "Getting the words right", "Nearly there"];
    function nowSay(label) {
      var host = turn().querySelector(".steps-host");
      if (!nowEl) {
        nowEl = document.createElement("div");
        nowEl.className = "now";
        nowEl.setAttribute("role", "status");
        nowEl.innerHTML = '<span class="now-av" aria-hidden="true"></span><span class="now-t"></span><span class="now-n" hidden></span>';
        host.innerHTML = "";
        host.appendChild(nowEl);
        // The Blink itself sits beside what it is doing, and works with it.
        var c = who(bm.companion);
        track(c.id, Creatures.mount(nowEl.querySelector(".now-av"), look(c), { label: c.name, mood: nowMood }));
        var t0 = Date.now(), n = nowEl.querySelector(".now-n"), box0 = nowEl;
        var tick = setInterval(function () {
          if (!box0.isConnected) return clearInterval(tick);
          var sec = Math.round((Date.now() - t0) / 1000);
          if (thinking && !finished) {
            var k = Math.min(THINK.length - 1, Math.floor((Date.now() - thinkAt) / 4500));
            if (k > 0) nowSay(THINK[k]);
          }
          if (sec >= 3) { n.hidden = false; wheel(n, sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m " + (sec % 60) + "s"); }
        }, 1000);
      }
      var box = nowEl.querySelector(".now-t");
      var old = box.querySelector("span:not(.out)");
      if (old && old.textContent === label + "...") return;
      box.querySelectorAll("span.out").forEach(function (x) { x.remove(); }); // never more than one on its way out
      if (old) { old.classList.add("out"); setTimeout(function () { old.remove(); }, 300); }
      var n = document.createElement("span");
      n.textContent = label + "...";
      box.appendChild(n);
      typing(false);
      scrollEnd();
    }
    function nowDone() {
      if (!el) return;
      var host = el.querySelector(".steps-host");
      var put = function () { host.innerHTML = didHtml(bm.steps); hookDid(el); var d = host.querySelector(".did"); if (d) d.classList.add("did-in"); };
      if (nowEl) {
        // The status eases out, then the summary of what it did fades in.
        var gone = nowEl;
        nowEl = null;
        gone.classList.add("now-out");
        setTimeout(function () { if (gone.parentNode === host) { gone.remove(); put(); } }, 220);
      } else put();
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
      setTimeout(function () { if (!finished && !live && shown === queued && !raw && !nowEl && !bm.care) { thinking = true; thinkAt = Date.now(); nowSay("Thinking"); } }, 420);
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
      if (false) { // whole texts only: nothing is written live
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
        if (ev.step.state === "run" && ev.step.label) { thinking = false; nowSay(ev.step.label); }
        if (!bm.care) {
          var t = ev.step.tool;
          if (ev.step.state === "run") mood(t === "web_search" || t === "read_page" || t === "recall" ? "search" : "work");
          else if (t === "remember" && ev.step.state !== "blocked") each("nod");
        }
        scrollEnd();
      }
      if (ev.absorbed) {
        // Messages you queued, taken in by this reply: they become real messages now.
        ev.absorbed.forEach(function (t) {
          var i = state.queue.findIndex(function (q) { return q.text.trim() === String(t).trim(); });
          if (i < 0) return;
          var q = state.queue.splice(i, 1)[0];
          q.el.classList.remove("queued");
          var rc = q.el.querySelector(".receipt"); if (rc) rc.remove();
          ch.messages.push({ role: "user", content: q.text, at: Date.now(), read: Date.now() });
        });
        save();
        thinking = true; thinkAt = Date.now(); nowSay("Reading what you added");
      }
      if (ev.blink && window.Maker) {
        // A Blink made a Blink: it joins the sidebar at once.
        var nb = Maker.add(ev.blink);
        if (nb) {
          rebuild(); renderComps();
          bm.made = { id: nb.id, name: nb.name };
          var row = document.querySelector('#comps .comp[data-id="' + nb.id + '"]');
          if (row) { row.classList.remove("row-in"); void row.offsetWidth; row.classList.add("row-in", "made"); }
        } else showNotice("You have " + Maker.MAX + " Blinks already. Delete one to make room for " + ev.blink.name + ".");
      }
      if (ev.computer) {
        // The Blink is using the computer: show it, and let you watch.
        compStatus().then(function () { if (dock === "computer") pullFrame(); });
        if (dock !== "computer") { $("compDot").hidden = false; $("compDot").className = "comp-dot live"; }
      }
      if (ev.sources) { bm.sources = ev.sources; turn().querySelector(".sources-host").innerHTML = sourcesHtml(bm.sources); }
      if (ev.reset) {
        gen++;
        raw = ""; bm.content = ""; queued = shown = 0; live = null; chain = Promise.resolve();
        if (el) el.querySelectorAll(".bub:not(.typing)").forEach(function (b) { b.remove(); });
        typing(true);
      }
      if (ev.delta) {
        thinking = false;
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
      var complete = await stream(ch, images, onEvent, state.ctrl.signal);
    } catch (e) {
      if (e.name !== "AbortError") {
        // No backend: say so, and play the scripted demo instead.
        $("offline").hidden = false;
        try { await demo(text, onEvent, state.ctrl.signal); } catch (e2) {}
      }
    }
    var left = state.ctrl && state.ctrl.signal.aborted;
    if (!left && complete === false && !bm.content.trim() && !bm.error) {
      // The connection dropped but the reply is still being made: keep the
      // Blink working here and fetch the reply the moment it is ready.
      state.ctrl = null;
      Kit.set("pv_live_run", "");
      if (el) { el.remove(); el = null; }
      um.read = um.read || Date.now();
      ch.updated = Date.now(); save();
      setBusy(false);
      awaitReply(ch);
      return;
    }
    Kit.set("pv_live_run", "");
    state.ctrl = null;
    if (left) {
      // You moved to another Blink: the brain is finishing this one. Watch it
      // from here, so coming back shows it still working, then its reply.
      var rid = state.runId;
      state.runId = null;
      if (rid && !resuming) { Kit.set("pv_live_run", JSON.stringify({ id: rid, companion: ch.companion, chat: ch.id, at: Date.now() })); resumeRun(); }
      um.read = um.read || Date.now();
      ch.updated = Date.now();
      save();
      if (window.Sync) Sync.push(ch);
      setBusy(false);
      setTimeout(catchUp, 4000);
      return;
    }
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
    if (el && bm.made) madeCard(el, bm.made);
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
    refreshRows();
    if (window.Sync) Sync.push(ch);
    // New or changed files: open the canvas on the newest one.
    var before = codeSt, after = codeState(), fresh = null;
    after.order.forEach(function (n) { var a = after.files[n].versions.length, b0 = before.files[n] ? before.files[n].versions.length : 0; if (a > b0) fresh = n; });
    if (fresh && state.companion === ch.companion) { if (dock === "code" || !dock) showFile(fresh, 0); else { $("codeBadge").hidden = false; } }
    else if (dock === "code") renderCode();
    setTimeout(catchUp, 600); // anything your Blinks said to each other meanwhile
    setBusy(false);
    state.runId = null;
    // Settle: stay soft if care is showing, otherwise back to idle.
    if (bm.care) mood("care"); else { mood("idle"); if (ch.messages.length === 2 && !bm.onRead) cheer(); }
    scrollEnd();
    // Anything you sent meanwhile goes now, as the next turn.
    if (state.queue.length && state.companion === mine) {
      var next = state.queue.splice(0);
      next.forEach(function (q) { q.el.remove(); });
      send(next.map(function (q) { return q.text; }));
    }
  }

  // What the model sees: its own tags kept, your tapbacks noted on your next text.
  function history(ch) {
    return ch.messages.filter(function (m) { return !m.sent; }).map(function (m, i, all) {
      if (m.from) return { role: "user", content: "[A message from " + m.from + ", another of this person's Blinks]\n" + m.content };
      if (m.role === "user") {
        var prev = all[i - 1], note = "";
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
    state.runId = runId;
    // Remembered until the reply is in, so a reload can pick the run back up.
    Kit.set("pv_live_run", JSON.stringify({ id: runId, companion: state.companion, chat: ch.id, at: Date.now() }));
    var seen = 0, finished = false;
    var cancel = function () { if (state.leaving) return; fetch(Kit.api + "/v1/runs/" + runId + "/cancel", { method: "POST" }).catch(function () {}); };
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
        files: CodeCanvas.latest(codeSt),
        // Your other Blinks, so this one can message them.
        blinks: C.filter(function (c) { return c.custom && c.bot; }).map(function (c) { return { id: c.id, name: c.name, purpose: c.bot.purpose, persona: c.bot.persona, lane: c.bot.lane }; }),
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
    return finished;
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

  /* ── Picking a reply back up after a reload ────────────────────── */
  // The run keeps going in the cloud; re-attach, show the Blink working
  // again, and drop the reply in when it is done.
  var resuming = null;
  function resumeRun() {
    var lr = null;
    try { lr = JSON.parse(Kit.get("pv_live_run") || "null"); } catch (e) {}
    if (!lr || !lr.id || Date.now() - lr.at > 9 * 60000 || !byId[lr.companion]) { Kit.set("pv_live_run", ""); return false; }
    var ch = state.chats.find(function (c) { return c.id === lr.chat; }) || chatFor(lr.companion);
    if (!ch) { Kit.set("pv_live_run", ""); return false; }
    resuming = { id: lr.id, companion: lr.companion, label: "Picking up where it left off", raw: "" };
    drawResume();
    var count = 0, tries = 0;
    var finish = function (ok) {
      var r = resuming;
      // Lost the stream before the reply: it is still being made. Keep the
      // Blink working and fetch the reply when it lands, never just go quiet.
      if (!(ok && r && r.raw.trim())) {
        resuming = null;
        Kit.set("pv_live_run", "");
        var lu = null;
        for (var j = ch.messages.length - 1; j >= 0; j--) if (ch.messages[j].role === "user" && !ch.messages[j].from) { lu = ch.messages[j]; break; }
        if (lu && !lu.read) { lu.read = Date.now(); save(); }
        if (state.companion === ch.companion) renderThread();
        awaitReply(ch);
        return;
      }
      resuming = null;
      Kit.set("pv_live_run", "");
      if (ok && r && r.raw.trim()) {
        var p = parseReply(r.raw);
        var m = { role: "assistant", content: p.text, companion: r.companion, at: Date.now(), meta: { lane_label: "Finished while the page reloaded" } };
        if (p.react) m.react = p.react;
        if (!p.text && p.read) m.onRead = true;
        var last = null;
        for (var i = ch.messages.length - 1; i >= 0; i--) if (ch.messages[i].role === "user" && !ch.messages[i].from) { last = ch.messages[i]; break; }
        if (last && !last.read) last.read = Date.now();
        if (!seen(ch, m)) { ch.messages.push(m); ch.updated = Date.now(); save(); if (window.Sync) Sync.push(ch); }
      }
      if (state.companion === ch.companion) { renderThread(); mood("idle"); }
      refreshRows();
      setTimeout(catchUp, 800);
    };
    var attach = function () { fetch(Kit.api + "/v1/runs/" + encodeURIComponent(lr.id) + "?from=" + count).then(function (res) {
      if (!res.ok || !res.body) return finish(false);
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "", ended = false;
      var pump = function () {
        return reader.read().then(function (x) {
          // The connection closed mid-run: re-attach where it left off.
          if (x.done) { if (!ended && resuming && ++tries <= 6) return setTimeout(attach, 1200); return finish(ended || !!(resuming && resuming.raw)); }
          buf += dec.decode(x.value, { stream: true });
          var i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            var line = buf.slice(0, i).trim();
            buf = buf.slice(i + 2);
            if (line.indexOf("data:") !== 0 || !resuming) continue;
            var ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
            count++;
            if (ev.reset) resuming.raw = "";
            if (ev.delta) resuming.raw += ev.delta;
            if (ev.step && ev.step.state === "run" && ev.step.label) { resuming.label = ev.step.label; drawResume(); }
            if (ev.done || ev.error) ended = true;
          }
          return pump();
        });
      };
      return pump();
    }).catch(function () { if (resuming && ++tries <= 6) setTimeout(attach, 2000); else finish(false); }); };
    attach();
    return true;
  }
  // The Blink, working, under your last message (kept across re-renders).
  function drawResume() {
    var old = $("threadIn").querySelector(".turn.resumed");
    if (!resuming || resuming.companion !== state.companion) { if (old) old.remove(); return; }
    var c = who(resuming.companion);
    if (!old) {
      old = document.createElement("div");
      old.className = "turn them resumed";
      old.innerHTML = '<div class="steps-host"><div class="now" role="status"><span class="now-av" aria-hidden="true"></span><span class="now-t"><span></span></span></div></div>';
      $("threadIn").appendChild(old);
      track(c.id, Creatures.mount(old.querySelector(".now-av"), look(c), { label: c.name, mood: "work" }));
      mood("work");
      var rc = $("threadIn").querySelector(".receipt");
      if (rc && !/Read/.test(rc.textContent)) rc.innerHTML = "<b>Read</b>";
    }
    var tb = old.querySelector(".now-t"), cur = tb.querySelector("span:not(.out)"), txt = resuming.label + "...";
    if (!cur || cur.textContent !== txt) {
      tb.querySelectorAll("span.out").forEach(function (x) { x.remove(); });
      if (cur && cur.textContent) { cur.classList.add("out"); setTimeout(function () { cur.remove(); }, 220); } else if (cur) cur.remove();
      var ns = document.createElement("span"); ns.textContent = txt; tb.appendChild(ns);
    }
    scrollEnd(true);
  }

  // Polls for a reply that is still on its way (connection dropped).
  function awaitReply(ch) {
    var n0 = ch.messages.length, tries = 0;
    resuming = { id: null, companion: ch.companion, label: "Still working on it", raw: "", poll: true };
    drawResume();
    var tick = function () {
      if (!resuming || !resuming.poll) return;
      if (ch.messages.slice(n0).some(function (m) { return m.role === "assistant"; }) || ++tries > 60) {
        resuming = null; drawResume(); if (state.companion === ch.companion) mood("idle"); return;
      }
      catchUp(true);
      setTimeout(tick, tries < 10 ? 2500 : 6000);
    };
    setTimeout(tick, 1500);
  }

  /* ── Catching up with the brain ─────────────────────────────────── */
  // Replies that finished after you left, task results, and messages your
  // Blinks sent each other all live in each Blink's chat on the brain.
  var synced = +Kit.get("pv_synced") || Date.now() - 864e5, catching = false;
  // Once: look back two days, to bring back messages an earlier version lost.
  if (!Kit.get("pv_resync1")) { synced = Math.min(synced, Date.now() - 2 * 864e5); Kit.set("pv_resync1", "1"); }
  // Loose on purpose: spacing, punctuation and case never make a duplicate.
  function norm(t) { return parseReply(String(t || "")).text.replace(/^\(I tapped [^)]*\)\n/, "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 400); }
  function fromLog(e, id) {
    if (e.from) return { role: "user", from: e.from, content: e.content, at: e.at };
    // Yours, as the brain kept it (the tapback note the app adds is not part of what you wrote).
    if (e.role === "user") return { role: "user", content: String(e.content || "").replace(/^\(I tapped [^)]*\)\n/, ""), at: e.at, read: e.at, mine: true };
    if (e.sent || e.to) return { role: "assistant", content: e.content, companion: id, at: e.at, sent: e.sent, to: e.to };
    var p = parseReply(e.content);
    var m = { role: "assistant", content: p.text, companion: id, at: e.at, meta: { lane: "brain", lane_label: e.task ? "Scheduled task" : "Finished on the brain" } };
    if (p.react) m.react = p.react;
    if (!p.text && p.read) m.onRead = true;
    if (e.task) m.task = e.task;
    return m;
  }
  function seen(ch, m) {
    var k = norm(m.content);
    return ch.messages.slice(-240).some(function (x) {
      if (!!x.from !== !!m.from || (x.sent || "") !== (m.sent || "") || (x.to || "") !== (m.to || "") || (x.role === "assistant") !== (m.role === "assistant")) return false;
      if (m.onRead) return !!x.onRead && Math.abs((x.at || 0) - m.at) < 120000;
      return norm(x.content) === k;
    });
  }
  function catchUp(polling) {
    if (catching || state.busy || (resuming && !(polling && resuming.poll)) || state.power === "lowlight" || !window.Sync || !Sync.user()) return;
    catching = true;
    api("/v1/blink/since?t=" + synced).then(function (d) {
      if (!d || !d.chats) return;
      var redraw = false, fresh = [];
      Object.keys(d.chats).forEach(function (id) {
        if (!byId[id]) return;
        var ch = chatFor(id), added = 0, theirs = 0;
        d.chats[id].forEach(function (e) {
          var m = fromLog(e, id);
          if (!ch) ch = newChatFor(id);
          if (seen(ch, m)) return;
          if (!m.mine && !m.sent) theirs++;
          delete m.mine;
          ch.messages.push(m);
          if (id === state.companion) fresh.push(m);
          ch.messages.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
          ch.updated = Math.max(ch.updated, e.at);
          added++;
        });
        if (!added) return;
        if (window.Sync) Sync.push(ch);
        if (id === state.companion && !document.hidden) redraw = true;
        else if (theirs) state.unread[id] = (state.unread[id] || 0) + theirs;
      });
      synced = d.now || Date.now();
      Kit.set("pv_synced", String(synced));
      Kit.set("pv_unread", JSON.stringify(state.unread));
      save();
      refreshRows();
      if (resuming && resuming.poll && fresh.some(function (m) { return m.role === "assistant"; })) { resuming = null; drawResume(); mood("idle"); }
      if (redraw) {
        // New messages at the end pop in where you are; anything older means a redraw.
        var ch0 = chat(), tail = ch0 ? ch0.messages.slice(-fresh.length) : [];
        var atEnd = fresh.length && fresh.every(function (m, i) { return tail[i] === m; });
        if (!atEnd) renderThread();
        else {
          codeState();
          fresh.forEach(function (m) {
            if (isRelay(m)) relayTurn(m);
            else if (m.role === "user") userTurn(m, null).classList.add("sent");
            else if (!m.onRead) { var t = botTurn(m); t.querySelectorAll(".bub").forEach(function (b) { b.classList.add("pop"); }); }
          });
          receipt();
          scrollEnd();
        }
        pulse(0.8);
      }
    }).catch(function () {}).then(function () { catching = false; });
  }

  /* ── Pages: Chat and Settings share the shell, like chat.usecloak.org ── */
  var curPage = "chat", settlePg = null;
  function goPage(p) {
    var next = $("page-" + p), prev = $("page-" + curPage);
    if (!next) return;
    if (phone.matches) closeSide();
    document.querySelectorAll(".sidebar [data-nav]").forEach(function (b) { var on = b.getAttribute("data-nav") === p; b.classList.toggle("on", on); if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    if (p === curPage && !next.hidden) return;
    if (settlePg) settlePg();
    curPage = p;
    next.hidden = false;
    next.classList.remove("shown");
    void next.offsetWidth;
    next.classList.add("shown");
    if (p === "settings") prepSettings();
    if (prev && prev !== next) {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) prev.hidden = true;
      else {
        var t = 0;
        var settle = function () { clearTimeout(t); prev.removeEventListener("animationend", onEnd); prev.classList.remove("pg-out"); if (curPage !== prev.dataset.page) prev.hidden = true; settlePg = null; };
        var onEnd = function (e) { if (e.target === prev) settle(); };
        prev.addEventListener("animationend", onEnd);
        prev.classList.add("pg-out");
        t = setTimeout(settle, 400);
        settlePg = settle;
      }
    }
    try { next.focus({ preventScroll: true }); } catch (e) {}
    if (p === "chat") jumpEnd();
  }

  /* ── The Blink's own panel (opens from the pill in the top bar) ─── */
  var bpFig = null, bpT = 0;
  function renderBpActions(c) {
    var host = $("bpActions");
    host.innerHTML = c.custom ? '<button type="button" class="cta" id="bpEdit">Edit look and personality</button>' : "";
    if (c.custom) $("bpEdit").addEventListener("click", function () { closePanel(); editBlink(c.id); });
  }
  // One dock on the right holds either the Blink's panel or the code canvas,
  // never both: opening one while the other is open slides that one out and
  // this one in, at the same time.
  var DOCKS = { blink: "bpanel", code: "cpanel", computer: "kpanel" }, dock = null, dockT = {};
  var DOCK_BTN = { blink: "blinkBtn", code: "codeBtn", computer: "compBtn" }, DOCK_CLOSE = { blink: "bpClose", code: "cpClose", computer: "kClose" };
  function openDock(k) {
    if (dock === k) return;
    var prev = dock;
    dock = k;
    if (prev) hideDock(prev, true);
    var p = $(DOCKS[k]), sc = $("bpScrim"), wide = !phone.matches;
    clearTimeout(dockT[k]);
    p.hidden = false;
    p.classList.remove("out");
    sc.hidden = wide; sc.classList.remove("out");
    p.setAttribute("aria-modal", wide ? "false" : "true");
    void p.offsetWidth; // start from closed so the width can grow
    p.classList.add("on");
    $(DOCK_BTN[k]).setAttribute("aria-expanded", "true");
    if (k === "blink") { loadMind(); each("wave"); }
    else if (k === "code") { $("codeBadge").hidden = true; renderCode(); }
    else compOpen();
    setTimeout(function () { var c = $(DOCK_CLOSE[k]); if (c) c.focus({ preventScroll: true }); }, 60);
  }
  function hideDock(k, swapping) {
    var p = $(DOCKS[k]);
    if (k === "computer") compClose();
    if (k === "code") codeFull(false);
    p.classList.remove("on");
    $(DOCK_BTN[k]).setAttribute("aria-expanded", "false");
    clearTimeout(dockT[k]);
    if (!phone.matches) { dockT[k] = setTimeout(function () { if (!p.classList.contains("on")) p.hidden = true; }, 520); return; }
    p.classList.add("out");
    dockT[k] = setTimeout(function () { if (!p.classList.contains("on")) { p.hidden = true; p.classList.remove("out"); } }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260);
    if (!swapping) { var sc = $("bpScrim"); sc.classList.add("out"); setTimeout(function () { if (!dock) { sc.hidden = true; sc.classList.remove("out"); } }, 240); }
  }
  function closeDock() {
    if (!dock) return;
    if (dock === "code") codeFull(false);
    var k = dock;
    dock = null;
    hideDock(k, false);
    $(DOCK_BTN[k]).focus({ preventScroll: true });
  }
  function openPanel() { openDock("blink"); }
  function closePanel() { closeDock(); }

  /* ── Cloak Computer: the VMs on the brain, watched from here ─────── */
  var comp = { st: null, poll: 0, frame: 0, busyImg: false };
  var COMP_TEXT = {
    asleep: ["The computer is asleep", "It wakes up when your Blink needs it, or now if you want to watch. Waking takes about a minute."],
    waking: ["Waking up", "Starting the desktop. This takes about a minute."],
    sleeping: ["Going to sleep", "Nobody used it for a while."],
    someone: ["Someone else's desktop is running", "This PC runs one desktop at a time, and someone else is using theirs right now. Your Blink can still use your server, and your desktop can start when they are done."],
  };
  function compStatus() {
    return api("/v1/computer").then(function (st) {
      comp.st = st;
      var ok = !!(st && st.available && st.allowed);
      $("compBtn").hidden = !ok;
      if (!ok) { if (dock === "computer") closeDock(); return st; }
      var d = st.desktop || {}, mine = d.holder === "you", other = d.holder === "someone";
      var dot = $("compDot");
      dot.hidden = !(d.state === "waking" || (d.state === "ready" && mine) || other);
      dot.className = "comp-dot" + (d.state === "waking" ? " waking" : other ? " busy" : "");
      if (dock === "computer") paintComp();
      return st;
    }).catch(function () { return null; });
  }
  function paintComp() {
    var st = comp.st || {}, d = st.desktop || { state: "asleep" }, sv = st.server || { state: "asleep" };
    var mine = d.holder === "you", other = d.holder === "someone";
    var view = other ? "someone" : d.state === "ready" ? (mine ? "live" : "asleep") : d.state;
    var words = { asleep: "Asleep", waking: "Waking up", sleeping: "Going to sleep", ready: mine ? "Yours right now" : "Awake" };
    rollText($("kState"), other ? "In use by someone else" : words[d.state] || "Asleep");
    $("kDesk").textContent = other ? "in use by someone else" : (words[d.state] || "asleep").toLowerCase();
    $("kServ").textContent = ({ asleep: "asleep", waking: "waking up", sleeping: "going to sleep", ready: "awake" })[sv.state] || "asleep";
    $("kLedD").className = "k-led " + (other ? "busy" : d.state);
    $("kLedS").className = "k-led " + sv.state;
    $("kScreen").setAttribute("data-state", view);
    var cover = COMP_TEXT[view];
    $("kCover").hidden = !cover;
    if (cover) { $("kCoverTitle").textContent = cover[0]; $("kCoverText").textContent = cover[1]; }
    $("kWake").hidden = view !== "asleep";
    $("kRelease").hidden = !mine;
    $("kImg").hidden = view !== "live";
  }
  // The screen, refreshed about once a second while it is yours and open.
  function pullFrame() {
    if (dock !== "computer" || comp.busyImg) return;
    var d = (comp.st || {}).desktop || {};
    if (!(d.state === "ready" && d.holder === "you")) return;
    comp.busyImg = true;
    authHeaders().then(function (h) { return fetch(Kit.api + "/v1/computer/screen", { headers: h }); }).then(function (r) {
      if (!r.ok) throw 0;
      return r.blob();
    }).then(function (b) {
      var url = URL.createObjectURL(b), img = new Image();
      img.onload = function () { var el = $("kImg"), old = el.src; el.src = url; if (old && old.indexOf("blob:") === 0) URL.revokeObjectURL(old); };
      img.src = url;
    }).catch(function () {}).then(function () { comp.busyImg = false; });
  }
  function compOpen() {
    paintComp();
    compStatus().then(pullFrame);
    clearInterval(comp.poll); clearInterval(comp.frame);
    comp.poll = setInterval(compStatus, 3000);
    comp.frame = setInterval(pullFrame, 1200);
  }
  function compClose() { clearInterval(comp.poll); clearInterval(comp.frame); }

  /* ── Code panel size: drag the pill on its edge; or go full screen ── */
  var CODE_MIN = 360, CODE_MAX = 1100;
  function codeMax() { return Math.max(CODE_MIN, Math.min(CODE_MAX, innerWidth - $("side").offsetWidth - 340)); }
  function setCodeW(w, save) {
    w = Math.round(Math.max(CODE_MIN, Math.min(codeMax(), w)));
    $("cpanel").style.setProperty("--dock-w", w + "px");
    $("cpGrip").setAttribute("aria-valuenow", w);
    if (save) Kit.set("pv_code_w", String(w));
    return w;
  }
  function initGrip() {
    var g = $("cpGrip"), p = $("cpanel"), saved = +Kit.get("pv_code_w");
    g.setAttribute("aria-valuemin", CODE_MIN); g.setAttribute("aria-valuemax", CODE_MAX);
    if (saved) setCodeW(saved, false);
    g.addEventListener("pointerdown", function (e) {
      if (phone.matches || $("app").classList.contains("code-full")) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      p.classList.add("dragging");
      document.documentElement.classList.add("resizing");
      var move = function (ev) { setCodeW(innerWidth - ev.clientX, false); };
      var up = function () {
        p.classList.remove("dragging");
        document.documentElement.classList.remove("resizing");
        g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); g.removeEventListener("pointercancel", up);
        setCodeW(p.getBoundingClientRect().width, true);
      };
      g.addEventListener("pointermove", move); g.addEventListener("pointerup", up); g.addEventListener("pointercancel", up);
    });
    g.addEventListener("dblclick", function () { setCodeW(620, true); });
    g.addEventListener("keydown", function (e) {
      var w = p.getBoundingClientRect().width;
      if (e.key === "ArrowLeft") { e.preventDefault(); setCodeW(w + 32, true); }
      if (e.key === "ArrowRight") { e.preventDefault(); setCodeW(w - 32, true); }
    });
    window.addEventListener("resize", function () { var w = parseFloat(getComputedStyle(p).getPropertyValue("--dock-w")); if (w) setCodeW(w, false); });
  }
  // Full screen: the canvas covers the chat and the sidebar folds to its rail.
  var railBefore = false;
  function codeFull(on) {
    var app = $("app");
    if (on === app.classList.contains("code-full")) return;
    if (on) { railBefore = app.classList.contains("rail"); if (!phone.matches) app.classList.add("rail"); }
    else if (!railBefore) app.classList.remove("rail");
    app.classList.toggle("code-full", on);
    $("cpFull").setAttribute("aria-pressed", String(on));
    $("cpFull").setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
    setTimeout(function () { inkTo(true); }, 600);
  }

  /* ── The code canvas (code.js): files live here, not in the messages ── */
  var codeSt = CodeCanvas.replay([]), cv = { file: null, v: 0, view: "code" }, hlLoad = null;
  // The code button only exists once this chat has code.
  function codeState() {
    var ch = chat();
    codeSt = CodeCanvas.replay(ch ? ch.messages : []);
    var b = $("codeBtn"), had = !b.hidden;
    b.hidden = !codeSt.order.length;
    if (!had && !b.hidden) { b.classList.remove("arrive"); void b.offsetWidth; b.classList.add("arrive"); }
    if (had === b.hidden) window.dispatchEvent(new Event("resize")); // the pill re-measures its room
    if (b.hidden && dock === "code") closeDock();
    return codeSt;
  }
  function hl() {
    if (window.hljs) return Promise.resolve(window.hljs);
    if (!hlLoad) hlLoad = new Promise(function (res) {
      var sc = document.createElement("script");
      sc.src = "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js";
      sc.onload = function () { res(window.hljs || null); };
      sc.onerror = function () { res(null); };
      document.head.appendChild(sc);
    });
    return hlLoad;
  }
  function previewable(name) { return /\.(html?|svg)$/i.test(name || ""); }
  function showFile(name, v) {
    cv.file = name; cv.v = v || 0;
    if (!previewable(name)) cv.view = "code";
    openDock("code");
    renderCode(true);
  }
  function renderCode(swap) {
    var st = codeSt, names = st.order;
    $("cpCount").textContent = names.length ? names.length + (names.length === 1 ? " file" : " files") : "No files yet";
    $("cpEmpty").hidden = !!names.length;
    $("cpCode").hidden = !names.length || cv.view === "preview";
    if (!names.length) { $("cpTabs").innerHTML = ""; $("cpFrame").hidden = true; return; }
    if (!st.files[cv.file]) { cv.file = names[names.length - 1]; cv.v = 0; }
    var f = st.files[cv.file], n = f.versions.length;
    var v = cv.v && cv.v <= n ? cv.v : n;
    $("cpTabs").innerHTML = names.map(function (x, i) {
      var vs = st.files[x].versions.length;
      return '<button type="button" role="tab" style="--k:' + i + '" data-file="' + Kit.esc(x) + '" aria-selected="' + (x === cv.file) + '">' + Kit.esc(x) + (vs > 1 ? "<small>v" + vs + "</small>" : "") + "</button>";
    }).join("");
    var tab = $("cpTabs").querySelector('[aria-selected="true"]');
    if (tab) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    $("cpVer").textContent = "v" + v + " of " + n;
    $("cpOlder").disabled = v <= 1; $("cpNewer").disabled = v >= n;
    var canPrev = previewable(cv.file);
    $("cpanel").querySelector('[data-view="preview"]').disabled = !canPrev;
    if (!canPrev) cv.view = "code";
    $("cpanel").querySelectorAll("[data-view]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.view === cv.view)); });
    var code = f.versions[v - 1].code, prev = v > 1 ? f.versions[v - 2].code.split("\n") : null;
    if (cv.view === "preview") {
      $("cpCode").hidden = true;
      var fr = $("cpFrame");
      fr.hidden = false;
      fr.srcdoc = /\.svg$/i.test(cv.file) ? '<!doctype html><body style="margin:0;display:grid;place-items:center;min-height:100vh">' + code + "</body>" : code;
      return;
    }
    $("cpFrame").hidden = true; $("cpFrame").removeAttribute("srcdoc");
    $("cpCode").hidden = false;
    // Lines that changed from the version before get marked in the gutter.
    var had = {};
    if (prev) prev.forEach(function (l) { had[l] = (had[l] || 0) + 1; });
    var lines = code.split("\n");
    $("cpGut").innerHTML = lines.map(function (l, i) { var chg = prev && !(had[l]-- > 0); return "<i" + (chg ? ' class="chg"' : "") + ">" + (i + 1) + "</i>"; }).join("");
    var src = $("cpSrc");
    src.textContent = code;
    src.className = "";
    hl().then(function (h) {
      if (!h || src.textContent !== code) return;
      var lang = (f.lang || "").toLowerCase();
      try { src.innerHTML = h.getLanguage(lang) ? h.highlight(code, { language: lang }).value : h.highlightAuto(code).value; } catch (e) {}
    });
    if (swap) { var cc = $("cpCode"); cc.classList.remove("swap"); void cc.offsetWidth; cc.classList.add("swap"); }
  }
  // A card where a file used to be in a message.
  function chipHtml(html, chips) {
    return html.replace(/<p>CODECHIP(\d+)<\/p>/g, function (all, i) {
      var c = chips[+i];
      if (!c) return "";
      var sub = c.edit ? (c.failed && !c.changes ? "Edit did not apply" : "Edited" + (c.changes ? ", " + c.changes + (c.changes === 1 ? " change" : " changes") : "") + (c.v ? " · v" + c.v : "")) : c.lines + " lines" + (c.v > 1 ? " · v" + c.v : "") + (c.cut ? " · cut off before the end" : "");
      return '<button type="button" class="code-chip' + (c.edit ? " edit" : "") + '" data-file="' + Kit.esc(c.name) + '" data-v="' + (c.v || 0) + '"><span class="cc-ic" aria-hidden="true"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="' + (c.edit ? "M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4z" : "M8 7l-5 5 5 5M16 7l5 5-5 5") + '"/></svg></span><span class="cc-tx"><b>' + Kit.esc(c.name) + "</b><small>" + Kit.esc(sub) + '</small></span><span class="cc-go">Open</span></button>';
    });
  }

  /* ── Settings ──────────────────────────────────────────────────── */
  function openSettings(tab) { goPage("settings"); if (typeof tab === "string") settingsTab(tab); }
  function prepSettings() {
    $("setName").value = state.user.name || "";
    $("setAbout").value = state.user.about || "";
    var u = window.Sync && Sync.user ? Sync.user() : null;
    $("sName").textContent = $("whoName").textContent;
    $("sEmail").textContent = (u && u.email) || "";
    $("sAv").textContent = $("userAv").textContent;
    $("modeLabel").textContent = Kit.mode();
  }
  function settingsTab(t) {
    document.querySelectorAll(".snav-btn").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === t); });
    document.querySelectorAll(".spane").forEach(function (el) { el.classList.toggle("on", el.id === "spane-" + t); });
  }
  // Light and dark, switched the main app's way: the new mode wipes in as a
  // hard-edged rectangle growing out of whatever you pressed.
  var lastPress = null;
  document.addEventListener("pointerdown", function (e) { lastPress = { x: e.clientX, y: e.clientY, t: Date.now() }; }, { passive: true, capture: true });
  function swapTheme(apply, el) {
    var d = document, html = d.documentElement;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !d.startViewTransition || d.visibilityState !== "visible") { apply(); return; }
    var r = lastPress && Date.now() - lastPress.t < 1500 ? { left: lastPress.x, top: lastPress.y, right: lastPress.x, bottom: lastPress.y } : el.getBoundingClientRect();
    var s = html.style, px = function (v) { return Math.max(0, Math.round(v)) + "px"; };
    s.setProperty("--vt-t", px(r.top)); s.setProperty("--vt-r", px(innerWidth - r.right));
    s.setProperty("--vt-b", px(innerHeight - r.bottom)); s.setProperty("--vt-l", px(r.left));
    html.classList.add("vt-theme");
    var vt;
    try { vt = d.startViewTransition(apply); } catch (e) { html.classList.remove("vt-theme"); apply(); return; }
    vt.ready.catch(function () {});
    vt.finished.catch(function () {}).then(function () { html.classList.remove("vt-theme"); ["--vt-t", "--vt-r", "--vt-b", "--vt-l"].forEach(function (p) { s.removeProperty(p); }); });
  }
  function toggleDark(e) {
    swapTheme(function () { Kit.toggleMode(); rollText($("modeLabel"), Kit.mode()); }, e.currentTarget);
  }
  // The Blink you are with: its own files (SOUL.md is yours to edit), what it
  // remembers, and what it has scheduled.
  var FILES = [["soul", "SOUL.md"], ["user", "USER.md"], ["memory", "MEMORY.md"], ["history", "HISTORY.md"]];
  function loadMind() {
    var host = $("mind"), id = state.companion, c = who(id), q = "?blink=" + encodeURIComponent(id);
    var nm = Kit.esc(c.name);
    host.innerHTML = '<div class="srow"><div class="srow-name">' + nm + '\'s files</div><div class="srow-desc">Loading.</div></div>';
    api("/v1/me" + q).then(function (d) {
      if (id !== state.companion) return;
      if (d.power === "lowlight" || !d.files) {
        host.innerHTML = '<div class="srow"><div class="srow-name">' + nm + '\'s files</div><div class="srow-desc">They live on Cloak\'s brain, which is resting in Low Light. They will be back when it wakes up.</div></div>';
        return;
      }
      var f = d.files, tab = "soul";
      var when = function (ms) { return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
      var row = function (text, sub, kind, rid) { return '<li><div><span>' + Kit.esc(text) + "</span>" + (sub ? "<small>" + Kit.esc(sub) + "</small>" : "") + '</div><button type="button" class="iconbtn" data-del="' + kind + ":" + rid + '" aria-label="Delete">' + Kit.icon("trash") + "</button></li>"; };
      host.innerHTML =
        '<div class="srow"><div class="srow-name">' + nm + "'s files</div>" +
        '<div class="srow-desc">' + f.messages + " messages in your chat" + (f.compacted ? ", the oldest " + f.compacted + " summarized in HISTORY.md" : "") + ". Everything lives on Cloak's brain. SOUL.md is who " + nm + " is; edit it to change how it thinks and talks.</div>" +
        '<div class="files-tabs" role="tablist">' + FILES.map(function (x) { return '<button type="button" role="tab" data-ftab="' + x[0] + '" aria-selected="' + (x[0] === tab) + '">' + x[1] + "</button>"; }).join("") + "</div>" +
        '<textarea class="md-file" id="mdFile" spellcheck="false" aria-label="File contents"></textarea>' +
        '<button type="button" class="cta" id="soulSave">Save SOUL.md</button></div>' +
        '<div class="srow"><div class="srow-name">Scheduled</div>' + (d.tasks.length ? '<ul class="mind">' + d.tasks.map(function (t) { return row(t.title, "Next " + when(t.at) + (t.repeat !== "none" ? ", " + t.repeat : ""), "tasks", t.id); }).join("") + "</ul>" : '<div class="srow-desc">Nothing scheduled. Ask ' + nm + " to remind you or to check on something later.</div>") + "</div>" +
        '<div class="srow"><div class="srow-name">Remembers</div>' + (d.memories.length ? '<ul class="mind">' + d.memories.map(function (m) { return row(m.fact, m.kind + ", " + m.day, "memory", m.id); }).join("") + "</ul>" : '<div class="srow-desc">Nothing yet. ' + nm + " keeps lasting things you say in USER.md and MEMORY.md, and you can delete any of it here.</div>") + "</div>";
      var ta = $("mdFile");
      function show(k) {
        tab = k;
        host.querySelectorAll("[data-ftab]").forEach(function (b) { b.setAttribute("aria-selected", b.getAttribute("data-ftab") === k ? "true" : "false"); });
        ta.value = f[k] || "(empty)";
        ta.readOnly = k !== "soul";
        $("soulSave").hidden = k !== "soul";
      }
      show("soul");
      $("soulSave").onclick = function () {
        var b = this;
        b.disabled = true;
        api("/v1/blink/soul" + q, { method: "POST", body: JSON.stringify({ text: ta.value }) }).then(function (r) {
          b.disabled = false;
          b.textContent = r.ok ? "Saved" : "Too short to save";
          if (r.ok) { f.soul = ta.value; cheer(); }
          setTimeout(function () { b.textContent = "Save SOUL.md"; }, 1600);
        }).catch(function () { b.disabled = false; });
      };
      host.onclick = function (e) {
        var t = e.target.closest("[data-ftab]");
        if (t) { show(t.getAttribute("data-ftab")); return; }
        var del = e.target.closest("[data-del]");
        if (del) { var p = del.getAttribute("data-del").split(":"); api("/v1/" + p[0] + "/" + p[1] + q, { method: "DELETE" }).then(loadMind); }
      };
    }).catch(function () { host.innerHTML = '<div class="srow"><div class="srow-name">' + nm + '\'s files</div><div class="srow-desc">Could not reach Cloak\'s brain just now.</div></div>'; });
  }
  // Results that finished while the brain was away (Low Light) wait in the
  // Worker's inbox; they move into their Blink's chat when you come back.
  function badge() {
    api("/v1/me").then(function (d) {
      var items = (d.inbox || []).filter(function (i) { return !i.seen; });
      if (!items.length) { $("inboxBadge").hidden = true; return; }
      items.forEach(function (i) {
        var id = byId[i.companion] ? i.companion : "cloak", ch = chatFor(id) || newChatFor(id);
        var m = { role: "assistant", content: i.body, companion: id, at: i.created, task: i.kind === "task" ? i.title : undefined, sources: (i.meta || {}).sources, meta: { lane: (i.meta || {}).lane || "task", lane_label: i.kind === "task" ? "Scheduled task" : "Finished in the background", impact: (i.meta || {}).impact } };
        if (!seen(ch, m)) { ch.messages.push(m); ch.updated = Math.max(ch.updated, i.created); if (id !== state.companion) state.unread[id] = (state.unread[id] || 0) + 1; if (window.Sync) Sync.push(ch); }
      });
      api("/v1/inbox/seen", { method: "POST", body: JSON.stringify({ ids: items.map(function (i) { return i.id; }) }) });
      Kit.set("pv_unread", JSON.stringify(state.unread));
      save();
      refreshRows();
      if (items.some(function (i) { return (byId[i.companion] ? i.companion : "cloak") === state.companion; }) && !state.busy) renderThread();
    }).catch(function () {});
  }
  // The account row: your initials, your name, your email.
  function whoLabel() {
    var u = window.Sync && Sync.user ? Sync.user() : null;
    var meta = (u && u.user_metadata) || {};
    var name = (state.user.name || "").trim() || meta.display_name || meta.full_name || (u && u.email ? u.email.split("@")[0] : "") || "You";
    $("whoName").textContent = name;
    $("whoEmail").textContent = (u && u.email) || "Signed in";
    $("userAv").textContent = name.split(/\s+/).map(function (w) { return w[0] || ""; }).join("").slice(0, 2).toUpperCase() || "?";
  }

  /* ── Sidebar: rail on desktop, drawer on phones ─────────────────── */
  var phone = matchMedia("(max-width:780px)");
  function toggleSide() {
    var app = $("app");
    if (phone.matches) { app.classList.toggle("open"); return; }
    var rail = !app.classList.contains("rail");
    app.classList.toggle("rail", rail);
    Kit.set("pv_rail", rail ? "1" : "");
    hideTip();
    setTimeout(function () { inkTo(true); }, 600);
  }
  // On the rail, hovering an item flies its name out beside it.
  var tip = null;
  function hideTip() { if (tip) tip.classList.remove("show"); }
  function showTip(el) {
    if (phone.matches || !$("app").classList.contains("rail")) return;
    var label = el.getAttribute("data-tip");
    if (!label) return;
    if (!tip) { tip = document.createElement("div"); tip.className = "sb-tip"; tip.setAttribute("aria-hidden", "true"); document.body.appendChild(tip); }
    var r = el.getBoundingClientRect(), was = tip.classList.contains("show");
    tip.textContent = label;
    tip.classList.toggle("jump", !was);
    tip.style.left = ($("side").getBoundingClientRect().right + 10) + "px";
    tip.style.setProperty("--tip-y", (r.top + r.height / 2) + "px");
    void tip.offsetWidth;
    tip.classList.remove("jump");
    tip.classList.add("show");
  }

  /* ── Wire up ───────────────────────────────────────────────────── */
  function init() {
    renderComps();
    mountFigs();
    whoLabel();

    var q = new URLSearchParams(location.search);
    if (q.has("sw")) { q.delete("sw"); window.history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "")); }
    if (byId[q.get("c")]) { state.companion = q.get("c"); Kit.set("pv_companion", state.companion); renderComps(); mountFigs(); }
    if (q.get("make")) { window.history.replaceState(null, "", location.pathname); setTimeout(function () { editBlink(null); }, 300); }
    renderThread();

    var sp = SPONSORS[Math.floor(Math.random() * SPONSORS.length)];
    $("spTitle").textContent = sp.title;
    $("sponsor").title = sp.body;

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
    $("newBlink").addEventListener("click", function () { editBlink(null); closeSide(); });
    $("searchBtn").addEventListener("click", function () {
      var r = $("searchRow");
      if ($("app").classList.contains("rail")) toggleSide();
      r.hidden = !r.hidden;
      this.setAttribute("aria-expanded", r.hidden ? "false" : "true");
      if (!r.hidden) $("search").focus(); else { $("search").value = ""; renderComps(); }
    });
    $("search").addEventListener("input", function () { renderComps(); });
    $("blinkBtn").addEventListener("click", function () { if (dock === "blink") closeDock(); else openDock("blink"); });
    $("codeBtn").addEventListener("click", function () { if (dock === "code") closeDock(); else openDock("code"); });
    $("bpClose").addEventListener("click", closeDock);
    $("cpClose").addEventListener("click", closeDock);
    $("kClose").addEventListener("click", closeDock);
    $("compBtn").addEventListener("click", function () { if (dock === "computer") closeDock(); else openDock("computer"); });
    $("kWake").addEventListener("click", function () {
      var b = this; b.disabled = true;
      api("/v1/computer/wake", { method: "POST", body: JSON.stringify({ kind: "desktop" }) }).then(function (st) { if (st && st.desktop) { comp.st = st; comp.st.desktop.state = "waking"; paintComp(); } }).catch(function () {}).then(function () { b.disabled = false; });
    });
    $("kRelease").addEventListener("click", function () { api("/v1/computer/release", { method: "POST", body: "{}" }).then(function (st) { comp.st = st; paintComp(); }); });
    $("cpFull").addEventListener("click", function () { codeFull(!$("app").classList.contains("code-full")); });
    initGrip();
    $("bpScrim").addEventListener("click", closeDock);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && dock) { if ($("app").classList.contains("code-full")) codeFull(false); else closeDock(); } });
    $("threadIn").addEventListener("click", function (e) { var c = e.target.closest(".code-chip"); if (c) showFile(c.dataset.file, +c.dataset.v || 0); });
    $("cpTabs").addEventListener("click", function (e) { var b = e.target.closest("[data-file]"); if (b) { cv.file = b.dataset.file; cv.v = 0; renderCode(true); } });
    $("cpOlder").addEventListener("click", function () { var n = codeSt.files[cv.file].versions.length; cv.v = Math.max(1, (cv.v || n) - 1); renderCode(true); });
    $("cpNewer").addEventListener("click", function () { var n = codeSt.files[cv.file].versions.length; cv.v = Math.min(n, (cv.v || n) + 1); if (cv.v === n) cv.v = 0; renderCode(true); });
    $("cpanel").querySelectorAll("[data-view]").forEach(function (b) { b.addEventListener("click", function () { cv.view = b.dataset.view; renderCode(true); }); });
    $("cpCopy").addEventListener("click", function () {
      var f = codeSt.files[cv.file]; if (!f) return;
      var b = this, v = cv.v || f.versions.length;
      navigator.clipboard.writeText(f.versions[v - 1].code).then(function () { rollText(b, "Copied"); setTimeout(function () { rollText(b, "Copy"); }, 1400); }).catch(function () {});
    });
    $("cpDl").addEventListener("click", function () {
      var f = codeSt.files[cv.file]; if (!f) return;
      var v = cv.v || f.versions.length, a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([f.versions[v - 1].code], { type: "text/plain" }));
      a.download = cv.file.split("/").pop();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
    window.addEventListener("resize", function () { inkTo(true); });
    if (Kit.get("pv_rail") && !phone.matches) $("app").classList.add("rail");
    document.querySelectorAll("[data-side-toggle]").forEach(function (b) { b.addEventListener("click", toggleSide); });
    document.querySelectorAll("[data-dark-toggle]").forEach(function (b) { b.addEventListener("click", toggleDark); });
    document.querySelectorAll(".snav-btn").forEach(function (b) { b.addEventListener("click", function () { settingsTab(b.getAttribute("data-tab")); }); });
    $("saveName").addEventListener("click", function () { state.user.name = $("setName").value.trim(); Kit.set("pv_user", JSON.stringify(state.user)); whoLabel(); prepSettings(); var b = this; rollText(b, "Saved"); setTimeout(function () { rollText(b, "Save"); }, 1400); });
    $("saveAbout").addEventListener("click", function () { state.user.about = $("setAbout").value.trim(); Kit.set("pv_user", JSON.stringify(state.user)); var b = this; rollText(b, "Saved"); setTimeout(function () { rollText(b, "Save"); }, 1400); });
    $("signOut").addEventListener("click", function () { if (window.Sync && Sync.signOut) Sync.signOut(); });
    $("resetAll").addEventListener("click", function () { $("resetConfirm").hidden = false; this.hidden = true; $("resetNo").focus({ preventScroll: true }); });
    $("resetNo").addEventListener("click", function () { $("resetConfirm").hidden = true; $("resetAll").hidden = false; });
    $("resetYes").addEventListener("click", function () {
      var b = this, bots = $("resetBots").checked;
      b.disabled = true; b.textContent = "Deleting";
      var brain = api("/v1/blink/all", { method: "DELETE" }).then(function (r) { return !!(r && r.ok); }).catch(function () { return false; });
      Promise.all([brain, window.Sync && Sync.removeAll ? Sync.removeAll() : null, bots && window.Sync ? Promise.resolve(Sync.pushBots([])) : null]).then(function (out) {
        ["pv_chats", "pv_unread", "pv_synced", "pv_live_run", "pv_code_w"].concat(bots ? ["pv_bots", "pv_companion"] : []).forEach(function (k) { Kit.set(k, ""); });
        if (!out[0]) Kit.set("pv_reset_pending", "1"); // the brain was away: finish the job when it is back
        location.reload();
      });
    });
    $("side").classList.add("first");
    setTimeout(function () { $("side").classList.remove("first"); }, 1400);
    $("page-chat").classList.add("shown");
    $("scrim").addEventListener("click", closeSide);
    $("side").addEventListener("pointerover", function (e) { var t = e.target.closest("[data-tip]"); if (t) showTip(t); });
    $("side").addEventListener("pointerleave", hideTip);
    $("side").addEventListener("focusin", function (e) { var t = e.target.closest("[data-tip]"); if (t) showTip(t); });
    $("side").addEventListener("focusout", hideTip);
    // The pill gets the room between the top bar's left and right controls.
    function fitTop() {
      document.querySelectorAll(".page .top").forEach(function (t) {
        var l = t.querySelector(".top-l"), r = t.querySelector(".top-r");
        t.style.setProperty("--side-w", Math.max(l ? l.offsetWidth : 0, r ? r.offsetWidth : 0) + "px");
      });
    }
    fitTop();
    window.addEventListener("resize", fitTop);
    if (window.ResizeObserver) new ResizeObserver(fitTop).observe($("main"));
    // The bottom band is exactly the composer's height: one line across.
    if (window.ResizeObserver) new ResizeObserver(function (es) { $("app").style.setProperty("--input-h", Math.round(es[0].target.getBoundingClientRect().height) + "px"); }).observe(document.querySelector(".composer"));
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
      rollText($("modeName"), b.querySelector("b").textContent);
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
    $("openSettings").addEventListener("click", function () { openSettings("you"); });
    $("openSettings2").addEventListener("click", function () { if (curPage === "settings") goPage("chat"); else openSettings(); });
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
        catchUp();
      },
      onChats: function (remote) {
        // Merge by id, newest copy wins.
        remote.forEach(function (r) {
          var i = state.chats.findIndex(function (c) { return c.id === r.id; });
          if (i === -1) state.chats.push(r); else if (r.updated > state.chats[i].updated) state.chats[i] = r;
        });
        save();
        renderComps();
        if (!state.busy) renderThread();
        catchUp();
      },
      local: function () { return state.chats; },
    };

    pollPower();
    setInterval(pollPower, 60000);
    setInterval(function () { if (!document.hidden) catchUp(); }, 10000);
    // Reset in another tab: this one starts clean too, instead of saving the old chats back.
    window.addEventListener("storage", function (e) { if (e.key === "pv_reset_seen" && e.newValue) location.reload(); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { badge(); pollPower(); catchUp(); } });
    // Blinks needs a Cloak account: sign in first, then everything syncs.
    function go() {
      Sync.init(hooks);
      whoLabel();
      badge();
      compStatus();
      setInterval(function () { if (!document.hidden && dock !== "computer") compStatus(); }, 30000);
      if (Kit.get("pv_reset_pending")) api("/v1/blink/all", { method: "DELETE" }).then(function (r) { if (r && r.ok) Kit.set("pv_reset_pending", ""); }).catch(function () {});
      if (!resumeRun()) catchUp();
      if (q.get("q")) { window.history.replaceState(null, "", location.pathname); send(q.get("q")); }
      else if (matchMedia("(min-width: 781px)").matches) $("input").focus();
    }
    Sync.ready().then(function (u) { if (u) go(); else Sync.gate(go); });
  }
  init();
})();
