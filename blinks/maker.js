/* The Blink maker: build your own Blink. Pick a shape, a colour, eyes and
   something on top, then give it a name, a purpose and a personality. Blinks
   are stored on this device (pv_bots) and sent with each message, so the
   backend can run them under the same constitution as Cloak.

   Maker.open(bot | null, { onSave(bot), onDelete(id) }) */
(function () {
  "use strict";
  var MAX = 12;
  var LANES = [
    { id: "swift", name: "Quick", help: "Smallest, fastest models. Good for a sidekick you ask small things." },
    { id: "smart", name: "Balanced", help: "A strong general model. The right call for most Blinks." },
    { id: "deep", name: "Deep", help: "The largest models. Slower, more careful, more energy." },
    { id: "code", name: "Builder", help: "Code-tuned models, with the engineering playbook." },
    { id: "creative", name: "Creative", help: "Writing-tuned models, for voice and range." },
  ];
  var LANE_LABEL = { swift: "Swift", smart: "Balanced", deep: "Deep", code: "Build", creative: "Create" };
  var TRAITS = ["Blunt and honest", "Endlessly encouraging", "Dry sense of humour", "Short answers unless I ask", "Explains like I am new to it", "Asks me questions back", "Formal and precise", "Talks like a pirate"];
  var NAMES = ["Biscuit", "Nova", "Pebble", "Ziggy", "Mochi", "Rook", "Tansy", "Bolt", "Clover", "Fig", "Echo", "Juniper"];

  function load() { try { var b = JSON.parse(Kit.get("pv_bots")); return Array.isArray(b) ? b : []; } catch (e) { return []; } }
  function store(list) {
    Kit.set("pv_bots", JSON.stringify(list.slice(0, MAX)));
    if (window.Sync) Sync.pushBots(list.slice(0, MAX)); // your Blinks follow your account
  }
  function id() { return "u_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }

  // A saved Blink as the app sees it: the same fields as Cloak, plus look.
  function asCompanion(b) {
    var lane = LANE_LABEL[b.lane] || "Balanced";
    return {
      id: b.id, name: b.name, custom: true, look: b.look, lane: lane, home: b.lane,
      role: b.purpose || "Made by you", line: b.purpose || "Made by you.",
      about: b.purpose ? b.purpose + (/[.!?]$/.test(b.purpose) ? "" : ".") : "A Blink you made.",
      hello: b.hello || "Hey. What are we doing?",
      starters: (b.starters || []).filter(Boolean).length ? b.starters.filter(Boolean) : ["What can you help me with?", "Tell me about yourself", "Surprise me"],
      bot: { id: b.id, name: b.name, purpose: b.purpose || "", persona: b.persona || "", lane: b.lane },
    };
  }

  var dlg, f, state, fig, tiles = [], handlers = {};
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(s) { return Kit.esc(s == null ? "" : s); }

  function build() {
    dlg = el(
      '<dialog class="maker" aria-labelledby="mkTitle"><form method="dialog" class="mk">' +
      '<header class="mk-head"><h2 id="mkTitle">Make a Blink</h2><button class="iconbtn" value="cancel" aria-label="Close">' + Kit.icon("x") + "</button></header>" +
      '<div class="mk-body">' +
      '<aside class="mk-stage"><div class="mk-fig dots" id="mkFig" title="Poke it"></div>' +
      '<p class="mk-name" id="mkName">Your Blink</p><p class="mk-purpose" id="mkPurpose">Give it a purpose</p>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="mkRandom" aria-label="Surprise me">' + Kit.icon("arrow-clockwise") + '<span class="mk-rl">Surprise me</span></button>' +
      '<span class="note mk-note" aria-hidden="true">poke it</span></aside>' +
      '<div class="mk-form">' +
      '<section><p class="lbl"><i>1</i>Look</p>' +
      '<p class="mk-sub">Shape</p><div class="mk-tiles" id="mkShapes" role="radiogroup" aria-label="Shape"></div>' +
      '<p class="mk-sub">Colour</p><div class="mk-swatches" id="mkColors" role="radiogroup" aria-label="Colour"></div>' +
      '<p class="mk-sub">Eyes</p><div class="pick" id="mkEyes" role="radiogroup" aria-label="Eyes"></div>' +
      '<p class="mk-sub">On top</p><div class="pick" id="mkTop" role="radiogroup" aria-label="On top"></div>' +
      '<p class="mk-sub">Extras</p><div class="pick"><button type="button" id="mkGlasses" aria-pressed="false">Glasses</button><button type="button" id="mkCheeks" aria-pressed="false">Rosy cheeks</button></div></section>' +
      '<section><p class="lbl"><i>2</i>Who it is</p>' +
      '<label class="mk-sub" for="mkNameIn">Name</label><input class="field" id="mkNameIn" maxlength="24" required autocomplete="off" placeholder="Biscuit">' +
      '<label class="mk-sub" for="mkPurposeIn">What is it for?</label><input class="field" id="mkPurposeIn" maxlength="120" placeholder="Helps me study for my chemistry final">' +
      '<label class="mk-sub" for="mkPersona">Personality and instructions</label><textarea class="field" id="mkPersona" maxlength="1500" placeholder="How it talks, what it focuses on, what to avoid. For example: Quizzes me instead of giving answers straight away. Uses sports analogies. Never longer than a few paragraphs."></textarea>' +
      '<div class="mk-traits" id="mkTraits"></div><p class="help" id="mkCount"></p></section>' +
      '<section><p class="lbl"><i>3</i>How it thinks</p><div class="pick" id="mkLane" role="radiogroup" aria-label="How it thinks"></div><p class="help" id="mkLaneHelp"></p></section>' +
      '<section><p class="lbl"><i>4</i>First hello</p>' +
      '<label class="mk-sub" for="mkHello">The first thing it says</label><input class="field" id="mkHello" maxlength="80" placeholder="What are we studying today?">' +
      '<p class="mk-sub">Conversation starters</p><input class="field mk-st" maxlength="80" placeholder="Quiz me on organic chemistry"><input class="field mk-st" maxlength="80" placeholder="Explain moles like I am twelve"><input class="field mk-st" maxlength="80" placeholder="Make me a study plan for Friday">' +
      '<p class="help">Every Blink runs on the same rules as Cloak: never harm a human life, honest, no lectures. Your description shapes its voice, not the rules.</p></section>' +
      "</div></div>" +
      '<footer class="mk-foot"><button type="button" class="btn btn-ghost btn-sm mk-del" id="mkDelete" hidden>' + Kit.icon("trash") + 'Delete</button><span class="sp"></span><button class="btn btn-ghost btn-sm" value="cancel" formnovalidate>Cancel</button><button class="btn btn-accent btn-sm" value="save" id="mkSave">Save Blink</button></footer>' +
      "</form></dialog>"
    );
    document.body.appendChild(dlg);
    f = function (x) { return dlg.querySelector("#" + x); };

    // Look pickers
    Creatures.shapes.forEach(function (s) {
      var b = el('<button type="button" class="mk-tile" role="radio" data-v="' + s.id + '"><span class="mk-thumb"></span><small>' + s.name + "</small></button>");
      b.addEventListener("click", function () { state.look.shape = s.id; refresh(true); });
      f("mkShapes").appendChild(b);
    });
    Creatures.colors.forEach(function (c) {
      var b = el('<button type="button" class="mk-sw" role="radio" data-v="' + c + '" style="background:' + c + '" aria-label="Colour ' + c + '"></button>');
      b.addEventListener("click", function () { state.look.color = c; refresh(); });
      f("mkColors").appendChild(b);
    });
    var custom = el('<label class="mk-sw mk-custom" title="Any colour">' + Kit.icon("palette") + '<input type="color" aria-label="Any colour"></label>');
    custom.querySelector("input").addEventListener("input", function () { state.look.color = this.value.toUpperCase(); refresh(); });
    f("mkColors").appendChild(custom);
    chips(f("mkEyes"), Creatures.eyes, function () { return state.look.eyes; }, function (v) { state.look.eyes = v; refresh(); });
    chips(f("mkTop"), Creatures.toppers, function () { return state.look.topper; }, function (v) { state.look.topper = v; refresh(); });
    chips(f("mkLane"), LANES, function () { return state.lane; }, function (v) { state.lane = v; laneHelp(); });
    f("mkCheeks").addEventListener("click", function () { state.look.cheeks = !state.look.cheeks; refresh(); });
    f("mkGlasses").addEventListener("click", function () { state.look.glasses = !state.look.glasses; refresh(); });

    TRAITS.forEach(function (t) {
      var b = el('<button type="button" class="chip">+ ' + t + "</button>");
      b.addEventListener("click", function () {
        var ta = f("mkPersona");
        ta.value = (ta.value.trim() ? ta.value.trim().replace(/[.!]?$/, ". ") : "") + t + ".";
        count();
        ta.focus();
      });
      f("mkTraits").appendChild(b);
    });
    f("mkNameIn").addEventListener("input", function () { f("mkName").textContent = this.value.trim() || "Your Blink"; });
    f("mkPurposeIn").addEventListener("input", function () { f("mkPurpose").textContent = this.value.trim() || "Give it a purpose"; });
    f("mkPersona").addEventListener("input", count);
    f("mkFig").addEventListener("click", function () { if (fig) fig.cheer(); });
    f("mkRandom").addEventListener("click", function () {
      state.look = Creatures.random();
      if (!f("mkNameIn").value.trim()) { f("mkNameIn").value = NAMES[Math.floor(Math.random() * NAMES.length)]; f("mkName").textContent = f("mkNameIn").value; }
      refresh(true);
    });
    f("mkDelete").addEventListener("click", function () {
      if (!state.id || !confirm("Delete " + (state.name || "this Blink") + "? Its chats stay, and Cloak picks them up.")) return;
      store(load().filter(function (b) { return b.id !== state.id; }));
      dlg.close("deleted");
      if (handlers.onDelete) handlers.onDelete(state.id);
    });
    dlg.querySelector("form").addEventListener("submit", function (e) {
      if (!e.submitter || e.submitter.value !== "save") return;
      var name = f("mkNameIn").value.trim();
      if (!name) { e.preventDefault(); f("mkNameIn").focus(); return; }
      var list = load();
      var bot = {
        id: state.id || id(), name: name.slice(0, 24),
        purpose: f("mkPurposeIn").value.trim().slice(0, 120),
        persona: f("mkPersona").value.trim().slice(0, 1500),
        hello: f("mkHello").value.trim().slice(0, 80),
        starters: Array.from(dlg.querySelectorAll(".mk-st")).map(function (i) { return i.value.trim().slice(0, 80); }).filter(Boolean),
        lane: state.lane, look: Creatures.spec(state.look), updated: Date.now(),
      };
      var i = list.findIndex(function (b) { return b.id === bot.id; });
      if (i === -1) list.unshift(bot); else list[i] = bot;
      store(list);
      if (handlers.onSave) handlers.onSave(bot);
    });
    dlg.addEventListener("close", function () { if (fig) { fig.destroy(); fig = null; } tiles.forEach(function (t) { t.destroy(); }); tiles = []; });
  }

  function chips(host, items, get, on) {
    host.innerHTML = "";
    items.forEach(function (it) {
      var b = el('<button type="button" role="radio" data-v="' + it.id + '">' + esc(it.name) + "</button>");
      b.addEventListener("click", function () { on(it.id); mark(host, get()); });
      host.appendChild(b);
    });
  }
  function mark(host, v) {
    host.querySelectorAll("[data-v]").forEach(function (b) {
      var on = b.getAttribute("data-v").toLowerCase() === String(v).toLowerCase();
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  function count() { var n = f("mkPersona").value.length; f("mkCount").textContent = n ? n + " / 1500" : ""; }
  function laneHelp() { var l = LANES.find(function (x) { return x.id === state.lane; }); f("mkLaneHelp").textContent = l ? l.help : ""; mark(f("mkLane"), state.lane); }

  // Redraw the preview and the shape thumbnails in the current colour and eyes.
  var raf = 0, hop = false;
  function refresh(cheer) {
    hop = hop || !!cheer;
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      var look = Creatures.spec(state.look);
      if (fig) fig.destroy();
      fig = Creatures.mount(f("mkFig"), look, { mood: "listen", label: "Preview of your Blink" });
      if (hop) { fig.cheer(); hop = false; }
      tiles.forEach(function (t) { t.destroy(); });
      tiles = [];
      f("mkShapes").querySelectorAll(".mk-tile").forEach(function (b) {
        tiles.push(Creatures.mount(b.querySelector(".mk-thumb"), Object.assign({}, look, { shape: b.getAttribute("data-v") }), { still: true, label: b.getAttribute("data-v") }));
      });
      mark(f("mkShapes"), look.shape);
      mark(f("mkColors"), look.color);
      mark(f("mkEyes"), look.eyes);
      mark(f("mkTop"), look.topper);
      f("mkCheeks").setAttribute("aria-pressed", look.cheeks ? "true" : "false");
      f("mkGlasses").setAttribute("aria-pressed", look.glasses ? "true" : "false");
      var cust = dlg.querySelector(".mk-custom");
      var known = Creatures.colors.some(function (c) { return c.toLowerCase() === look.color.toLowerCase(); });
      cust.style.background = known ? "" : look.color;
      cust.setAttribute("aria-pressed", known ? "false" : "true");
    });
  }

  function open(bot, h) {
    if (!dlg) build();
    handlers = h || {};
    if (!bot && load().length >= MAX) { alert("You have " + MAX + " Blinks, the most for now. Delete one to make another."); return; }
    var b = bot || {};
    state = { id: b.id || null, name: b.name || "", lane: b.lane || "smart", look: Creatures.spec(b.look || Creatures.random()) };
    f("mkTitle").textContent = b.id ? "Edit " + b.name : "Make a Blink";
    f("mkNameIn").value = b.name || "";
    f("mkPurposeIn").value = b.purpose || "";
    f("mkPersona").value = b.persona || "";
    f("mkHello").value = b.hello || "";
    dlg.querySelectorAll(".mk-st").forEach(function (i, n) { i.value = (b.starters || [])[n] || ""; });
    f("mkName").textContent = b.name || "Your Blink";
    f("mkPurpose").textContent = b.purpose || "Give it a purpose";
    f("mkDelete").hidden = !b.id;
    f("mkSave").textContent = b.id ? "Save changes" : "Save Blink";
    count();
    laneHelp();
    dlg.showModal();
    dlg.querySelector(".mk-form").scrollTop = 0;
    refresh(true);
    if (!b.id) setTimeout(function () { f("mkNameIn").focus(); }, 60);
  }

  // A Blink another Blink designed (create_blink). Returns it, or null when full.
  function add(spec) {
    var list = load();
    if (list.length >= MAX) return null;
    var b = { id: id(), name: spec.name, purpose: spec.purpose || "", persona: spec.persona || "", lane: spec.lane || "smart", hello: spec.hello || "", starters: [], look: spec.look };
    list.push(b);
    store(list);
    return b;
  }
  window.Maker = { open: open, load: load, add: add, asCompanion: asCompanion, MAX: MAX };
})();
