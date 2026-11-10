/* The app: pick a companion, talk, watch them listen, think and answer.
   Chats live in localStorage (and in Supabase when signed in, see sync.js).
   Talks to preview-api POST /v1/chat (SSE). If that is unreachable the app
   says so and plays a short scripted reply instead of pretending. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var C = Kit.COMPANIONS, byId = {};
  C.forEach(function (c) { byId[c.id] = c; });

  var MOOD_LABEL = { idle: "Here", listen: "Listening", think: "Thinking", talk: "Talking", happy: "Glad", care: "With you", sleep: "Resting" };
  var SPONSORS = [
    { title: "Your name here", body: "One quiet card, no tracking. Sponsors pay for carbon removal, ten times what this chat emits." },
    { title: "Sponsor a greener answer", body: "Reach people who chose an AI that cleans up after itself. Every view funds verified removal." },
  ];

  var state = {
    chats: load("pv_chats", []),
    chatId: null,
    companion: byId[Kit.get("pv_companion")] ? Kit.get("pv_companion") : "pip",
    mode: "auto",
    busy: false,
    ctrl: null,
    images: [],
    sess: { wh: 0, g: 0 },
    user: load("pv_user", { name: "", about: "" }),
  };
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
  function cheer() { ["stage", "top", "empty"].forEach(function (k) { if (fig[k]) fig[k].cheer(); }); }
  function mountFigs() {
    var c = byId[state.companion];
    ["stage", "top"].forEach(function (k) { if (fig[k]) fig[k].destroy(); });
    fig.stage = Creatures.mount($("stageFig"), c.id, { backdrop: false, label: c.name });
    fig.top = Creatures.mount($("topAv"), c.id, { label: c.name });
    $("topName").textContent = $("stName").textContent = c.name;
    $("topRole").textContent = c.role;
    $("stLine").textContent = c.line;
    $("input").placeholder = "Talk to " + c.name;
    document.title = c.name + " | " + Kit.brand;
    setTimeout(cheer, 150);
  }

  /* ── Sidebar ───────────────────────────────────────────────────── */
  var sideFigs = [];
  function renderComps() {
    var host = $("comps");
    sideFigs.forEach(function (f) { f.destroy(); });
    sideFigs = [];
    host.innerHTML = "";
    C.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "comp";
      b.setAttribute("aria-current", c.id === state.companion ? "true" : "false");
      b.innerHTML = '<div class="comp-av"></div><div><b>' + c.name + "</b><span>" + c.role + "</span></div>";
      b.addEventListener("click", function () { setCompanion(c.id, true); closeSide(); });
      host.appendChild(b);
      sideFigs.push(Creatures.mount(b.firstChild, c.id, { label: c.name }));
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
  function careHtml(r) {
    return '<div class="care" role="region" aria-label="Help available now"><h3>You do not have to carry this alone.</h3><p>Real people are available right now. If you are in immediate danger, call ' + Kit.esc(r.emergency) + ".</p><ul>" +
      r.lines.map(function (l) { return '<li><a href="' + Kit.esc(l.href) + '"' + (/^https/.test(l.href) ? ' target="_blank" rel="noopener noreferrer"' : "") + "><div><b>" + Kit.esc(l.name) + "</b><span>" + Kit.esc(l.how) + "</span></div>" + Kit.icon("arrow-up-right") + "</a></li>"; }).join("") +
      "</ul></div>";
  }
  function addMsg(m) {
    var el = document.createElement("div");
    el.className = "msg " + (m.role === "user" ? "user" : "bot");
    if (m.role === "user") {
      el.innerHTML = '<div class="bubble">' + (m.thumbs || []).map(function (u) { return '<img src="' + u + '" alt="Attached image">'; }).join("") + Kit.esc(m.content) + "</div>";
    } else {
      var c = byId[m.companion || state.companion];
      el.innerHTML = (m.care ? careHtml(m.care) : "") + '<div class="name">' + c.name + '</div><div class="prose"></div><div class="meta"></div>';
      var prose = el.querySelector(".prose");
      prose.innerHTML = md(m.content || "");
      dress(prose);
      el.querySelector(".meta").innerHTML = metaHtml(m.meta) + (m.content ? '<button class="iconbtn" aria-label="Copy reply">' + Kit.icon("copy") + "</button>" : "");
      var cp = el.querySelector(".meta .iconbtn");
      if (cp) cp.addEventListener("click", function () { navigator.clipboard.writeText(m.content); });
    }
    $("threadIn").appendChild(el);
    return el;
  }
  function renderThread() {
    var host = $("threadIn");
    if (fig.empty) { fig.empty.destroy(); fig.empty = null; }
    host.innerHTML = "";
    var ch = chat();
    if (!ch || !ch.messages.length) {
      var c = byId[state.companion];
      var name = (state.user.name || "").trim();
      host.innerHTML = '<div class="empty"><div class="empty-fig"></div><h1>' + Kit.esc(c.hello) + "</h1><p>" + (name ? Kit.esc(name) + ", this is " : "This is ") + c.name + ". " + Kit.esc(c.about) + '</p><div class="starters"></div></div>';
      fig.empty = Creatures.mount(host.querySelector(".empty-fig"), c.id, { label: c.name });
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
    ch.messages.forEach(addMsg);
    scrollEnd(true);
  }
  function scrollEnd(force) {
    var t = $("thread");
    if (force || t.scrollHeight - t.scrollTop - t.clientHeight < 160) t.scrollTop = t.scrollHeight;
  }

  /* ── Sending ───────────────────────────────────────────────────── */
  function setBusy(b) {
    state.busy = b;
    var btn = $("send");
    btn.innerHTML = Kit.icon(b ? "x" : "arrow-up");
    btn.setAttribute("aria-label", b ? "Stop" : "Send");
    btn.disabled = !b && !$("input").value.trim();
  }
  function stop() { if (state.ctrl) state.ctrl.abort(); }

  async function send(text) {
    text = (text == null ? $("input").value : text).trim();
    if (!text || state.busy) return;
    var ch = chat();
    if (!ch) {
      ch = { id: uid(), companion: state.companion, title: text.slice(0, 60), messages: [], updated: Date.now() };
      state.chats.unshift(ch);
      state.chatId = ch.id;
      $("threadIn").innerHTML = "";
      if (fig.empty) { fig.empty.destroy(); fig.empty = null; }
    }
    var images = state.images;
    state.images = [];
    renderThumbs();
    var um = { role: "user", content: text };
    ch.messages.push(um);
    addMsg({ role: "user", content: text, thumbs: images.map(function (i) { return "data:" + i.mime + ";base64," + i.data; }) });
    $("input").value = "";
    grow();
    setBusy(true);
    renderHist();

    var bm = { role: "assistant", content: "", companion: state.companion, meta: {} };
    var el = addMsg(bm);
    var prose = el.querySelector(".prose"), metaEl = el.querySelector(".meta");
    prose.innerHTML = '<div class="wait" aria-label="Thinking"><i></i><i></i><i></i></div>';
    scrollEnd(true);
    mood("think");

    state.ctrl = new AbortController();
    var raf = 0;
    var paint = function () {
      raf = 0;
      prose.innerHTML = md(bm.content);
      prose.classList.add("caret");
      scrollEnd();
    };
    var onEvent = function (ev) {
      if (ev.meta) Object.assign(bm.meta, { lane: ev.meta.lane, lane_label: ev.meta.lane_label });
      if (ev.care) { bm.care = ev.care; el.insertAdjacentHTML("afterbegin", careHtml(ev.care)); mood("care"); }
      if (ev.delta) {
        if (!bm.content && !bm.care) mood("talk");
        bm.content += ev.delta;
        pulse(Math.min(0.9, 0.25 + ev.delta.length * 0.04));
        if (!raf) raf = requestAnimationFrame(paint);
      }
      if (ev.done) { bm.meta.impact = ev.impact; bm.meta.partial = ev.partial; if (ev.demo) bm.meta.demo = true; }
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
    if (raf) cancelAnimationFrame(raf);
    state.ctrl = null;
    prose.classList.remove("caret");
    if (!bm.content) bm.content = bm.error || (bm.care ? "" : "Stopped before I could answer.");
    prose.innerHTML = md(bm.content);
    dress(prose);
    metaEl.innerHTML = metaHtml(bm.meta) + '<button class="iconbtn" aria-label="Copy reply">' + Kit.icon("copy") + "</button>";
    metaEl.querySelector(".iconbtn").addEventListener("click", function () { navigator.clipboard.writeText(bm.content); });
    if (bm.meta.impact) {
      state.sess.wh += bm.meta.impact.wh;
      state.sess.g += bm.meta.impact.g;
      $("stLane").textContent = bm.meta.lane_label || bm.meta.lane || "";
      $("stWh").textContent = Kit.fmtWh(bm.meta.impact.wh);
      $("stG").textContent = Kit.fmtCO2(bm.meta.impact.g / 1000);
      $("stSess").textContent = $("sessWh").textContent = Kit.fmtWh(state.sess.wh);
    }
    ch.messages.push(bm);
    ch.updated = Date.now();
    save();
    if (window.Sync) Sync.push(ch);
    setBusy(false);
    // Settle: stay soft if care is showing, otherwise a small nod and back to idle.
    if (bm.care) mood("care"); else { mood("idle"); if (ch.messages.length === 2) cheer(); }
    scrollEnd();
  }

  async function stream(ch, images, onEvent, signal) {
    var res = await fetch(Kit.api + "/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: signal,
      body: JSON.stringify({
        companion: state.companion,
        brand: Kit.brand,
        mode: state.mode,
        user: state.user,
        images: images,
        messages: ch.messages.map(function (m) { return { role: m.role, content: m.content }; }),
      }),
    });
    if (res.status === 429) { onEvent({ error: "That is a lot of messages in a minute. Give it a moment and try again." }); return; }
    if (!res.ok || !res.body) throw new Error("backend " + res.status);
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        var line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (line.indexOf("data:") === 0) { try { onEvent(JSON.parse(line.slice(5))); } catch (e) {} }
      }
    }
  }

  // Scripted stand-in used only when the backend cannot be reached.
  var DEMO = {
    pip: "This is a scripted line, not a real answer: the preview backend isn't connected yet. Once it is, I'm the quick one. Lists, rewrites, what's-for-dinner, the hundred small things.",
    moss: "A scripted line for now, since the preview backend isn't connected. When it is, bring me the slow questions. I'll give you the answer first, then the reasoning, then what would change my mind.",
    ember: "Scripted placeholder: the preview backend isn't connected yet. When it is, you'll get complete, runnable code from me, like this:\n\n```js\nconst greet = (name) => `Hello, ${name}.`;\nconsole.log(greet(\"world\"));\n```",
    juno: "This one is scripted, because the preview backend isn't connected yet. When it is, bring me the half-idea you can't stop thinking about and we'll see what it wants to be.",
    sol: "A scripted line for now. The preview backend isn't connected yet. When it is, there's no rush here. Tell me the long version.",
  };
  var CRISIS = /\b(kill myself|suicid|end my life|want to die|self[- ]?harm|don'?t want to (live|be here))\b/i;
  async function demo(text, onEvent, signal) {
    var lane = byId[state.companion].lane;
    onEvent({ meta: { lane: lane.toLowerCase(), lane_label: lane } });
    var body = DEMO[state.companion];
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
    if (!state.busy) $("send").disabled = !t.value.trim();
  }
  function renderThumbs() {
    var host = $("thumbs");
    host.hidden = !state.images.length;
    host.innerHTML = "";
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

  /* ── Settings ──────────────────────────────────────────────────── */
  function openSettings() {
    $("setName").value = state.user.name || "";
    $("setAbout").value = state.user.about || "";
    if (window.Sync) Sync.renderAccount($("acct"));
    $("settings").showModal();
  }
  function whoLabel() { $("whoName").textContent = (state.user.name || "").trim() || "You"; }

  /* ── Wire up ───────────────────────────────────────────────────── */
  function init() {
    renderComps();
    mountFigs();
    whoLabel();

    var q = new URLSearchParams(location.search);
    if (byId[q.get("c")]) { state.companion = q.get("c"); Kit.set("pv_companion", state.companion); renderComps(); mountFigs(); }
    renderThread();
    renderHist();

    var sp = SPONSORS[Math.floor(Math.random() * SPONSORS.length)];
    $("spTitle").textContent = sp.title;
    $("spBody").textContent = sp.body;

    $("form").addEventListener("submit", function (e) { e.preventDefault(); if (state.busy) stop(); else send(); });
    $("input").addEventListener("input", function () {
      grow();
      if (state.busy) return;
      mood("listen");
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () { if (!state.busy) mood("idle"); }, 1600);
    });
    $("input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!state.busy) send(); }
    });
    $("attach").addEventListener("click", function () { $("file").click(); });
    $("file").addEventListener("change", async function () {
      for (var i = 0; i < this.files.length && state.images.length < 3; i++) {
        var im = await readImage(this.files[i]);
        if (im) state.images.push(im);
      }
      this.value = "";
      renderThumbs();
    });
    $("newChat").addEventListener("click", function () { newChat(); closeSide(); });
    $("menu").addEventListener("click", function () { $("app").classList.add("open"); });
    $("scrim").addEventListener("click", closeSide);
    $("seg").addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      state.mode = b.getAttribute("data-mode");
      this.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    });
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

    if (window.Sync) Sync.init({
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
    });

    if (q.get("q")) { history.replaceState(null, "", location.pathname); send(q.get("q")); }
    else if (matchMedia("(min-width: 781px)").matches) $("input").focus();
  }
  init();
})();
