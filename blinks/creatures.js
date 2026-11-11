/* Cloak Blinks: hand-drawn shapes with dot eyes. No mouths, no arms, no
   shadows, no thought bubbles. Wobbly ink outlines and flat Cloak colours.
   Drawn as paths, rigged and animated in code: no image files, no generated
   art.

   Every animation has named variants (VARIANTS). Creatures.style holds the
   chosen one for each; opts.style overrides per figure (the lab uses that).

   Everything they say is in the eyes and the body. One state machine drives
   it: idle, listen, think, search, work, talk, happy, care, sleep. Eyes lead, the
   face follows, the body leans last, toppers arrive late. Talking is a pulse
   through the whole shape, driven by real energy (stream chunks or audio
   level), like a voice orb with a face. Gestures on top: cheer (crouch, hop,
   squash), wave (a happy side-to-side rock), nod.

   Every Blink is a spec: { shape, color, eyes, topper, glasses, cheeks }.
   One ships, "cloak": the orb from the wordmark, drawn by hand. People
   build the rest in the app.

   Creatures.mount(el, "ember" | spec, { mood }) →
     { set(mood), pulse(n), level(0..1), cheer(), wave(), nod(), destroy() } */
(function () {
  "use strict";
  var INK = "var(--ink, #0A0A0A)";
  var DARK = "#0A0A0A";
  var uid = 0;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var S = 'stroke="' + INK + '" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"';
  var L = 'fill="none" stroke="' + INK + '" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"';
  var T = 'fill="none" stroke="' + INK + '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';
  // Anything drawn on the coloured body (the face) stays dark in both themes.
  var LF = 'fill="none" stroke="' + DARK + '" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"';
  var TF = 'fill="none" stroke="' + DARK + '" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"';

  // An eye: one ink dot. It slides to look, squashes flat to blink, and a
  // hand-drawn arc replaces it when happy. Nothing else.
  function eye(x, y, rx, ry, pr, ink) {
    var w = (pr * 0.92).toFixed(1), h = (pr * 1.28).toFixed(1), sw = (Math.max(rx, pr * 1.6) * 0.72).toFixed(1);
    var lf = 'fill="none" stroke="' + ink + '" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"';
    return (
      '<g data-p="pupil" data-o="' + x + "," + y + '" data-r="' + Math.max(3, rx - pr + 1).toFixed(1) + '">' +
      '<ellipse data-p="socket" data-o="' + x + "," + y + '" cx="' + x + '" cy="' + y + '" rx="' + w + '" ry="' + h + '" fill="' + ink + '"/>' +
      "</g>" +
      '<path data-p="smile" d="M' + (x - sw) + " " + (y + 3) + " Q" + x + " " + (y - ry * 0.7 - 3).toFixed(1) + " " + (x + +sw) + " " + (y + 3) + '" ' + lf + ' opacity="0"/>'
    );
  }
  // The face for a shape and an eye style, with optional glasses that fit
  // whatever eyes are there (one eye gets a monocle).
  var EYE_SCALE = 1.2;
  function face(f, style, glasses, ink) {
    var cx = f[0], cy = f[1], gap = f[2], rx = f[3], ry = f[4], pr = f[5] * EYE_SCALE;
    var tf = 'stroke="' + ink + '" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"';
    var list;
    if (style === "big") list = [[-gap * 1.08, rx + 4, ry + 4, pr * 1.4], [gap * 1.08, rx + 4, ry + 4, pr * 1.4]];
    else if (style === "small") list = [[-gap * 0.74, rx - 3, ry - 3, pr * 0.7], [gap * 0.74, rx - 3, ry - 3, pr * 0.7]];
    else if (style === "wide") list = [[-gap * 1.45, rx, ry, pr], [gap * 1.45, rx, ry, pr]];
    else if (style === "one") list = [[0, rx + 7, ry + 7, pr * 1.6]];
    else list = [[-gap, rx + 1, ry + 1, pr], [gap, rx + 1, ry + 1, pr]];
    var eyes = list.map(function (e) { return eye(cx + e[0], cy, e[1], e[2], e[3], ink); }).join("");
    var extra = "";
    if (glasses) {
      var R = Math.max(14, list[0][3] * 2.2);
      if (list.length === 2) R = Math.min(R, (list[1][0] - list[0][0]) / 2 - 2.5);
      var lens = function (x) { return '<circle cx="' + x.toFixed(1) + '" cy="' + cy + '" r="' + R.toFixed(1) + '" fill="#fff" fill-opacity=".2" ' + tf + "/>"; };
      var l = cx + list[0][0], d = "";
      if (list.length === 2) {
        var r = cx + list[1][0];
        extra = lens(l) + lens(r);
        d = "M" + (l + R).toFixed(1) + " " + (cy - 2) + " Q" + cx + " " + (cy - 9) + " " + (r - R).toFixed(1) + " " + (cy - 2) +
          " M" + (l - R).toFixed(1) + " " + (cy - 3) + " l-13 -6 M" + (r + R).toFixed(1) + " " + (cy - 3) + " l13 -6";
      } else {
        extra = lens(l);
        d = "M" + (l + R * 0.7).toFixed(1) + " " + (cy + R * 0.7).toFixed(1) + " q8 16 -2 30";
      }
      extra += '<path d="' + d + '" fill="none" ' + tf + "/>";
    }
    return '<g data-p="head" data-o="' + cx + "," + (cy + 20) + '">' + eyes + extra + "</g>";
  }
  function bloom() {
    // Six soft lobes, a little uneven, as if cut with scissors.
    var pts = [], n = 48;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 - Math.PI / 2;
      var r = 74 + 13 * Math.sin(6 * a + 0.4) + 2.5 * Math.sin(3 * a + 1.3);
      pts.push([120 + Math.cos(a) * r, 122 + Math.sin(a) * r * 0.98]);
    }
    var d = "M" + ((pts[0][0] + pts[n - 1][0]) / 2).toFixed(1) + " " + ((pts[0][1] + pts[n - 1][1]) / 2).toFixed(1);
    for (var j = 0; j < n; j++) {
      var p = pts[j], q = pts[(j + 1) % n];
      d += " Q" + p[0].toFixed(1) + " " + p[1].toFixed(1) + " " + ((p[0] + q[0]) / 2).toFixed(1) + " " + ((p[1] + q[1]) / 2).toFixed(1);
    }
    return d + " Z";
  }

  /* Shapes. d: the outline. o: where it stands. shine: the highlight stroke.
     face: [cx, cy, gap, eye rx, eye ry, pupil]. top/side: where toppers sit. */
  var SHAPES = {
    orb: { name: "Orb", d: "M120 42 C168 40 202 78 200 124 C198 172 164 204 118 202 C72 200 38 166 40 120 C42 76 74 44 120 42 Z", o: "120,206", shine: "M66 92 q10 -22 32 -30", face: [120, 112, 26, 17, 20, 7.5], top: [120, 44], side: [178, 66] },
    slab: { name: "Slab", d: "M60 58 C98 50 152 52 186 60 C196 96 196 152 188 190 C150 200 94 200 56 192 C46 150 48 98 60 58 Z", o: "122,206", shine: "M72 78 q22 -8 46 -8", face: [122, 112, 28, 16, 18, 7], top: [150, 56], side: [184, 60] },
    spark: { name: "Spark", d: "M120 34 C129 34 135 42 141 53 L202 166 C211 183 202 198 183 198 L57 198 C38 198 29 183 38 166 L99 53 C105 42 111 34 120 34 Z", o: "120,206", shine: "M104 70 l-22 42", face: [120, 136, 22, 14, 17, 6.5], top: [120, 34], side: [150, 66] },
    bloom: { name: "Bloom", d: bloom(), o: "120,206", shine: "M74 84 q12 -16 28 -18", face: [120, 116, 25, 16, 19, 7], top: [120, 46], side: [176, 58] },
    dome: { name: "Dome", d: "M34 178 C32 112 72 68 122 68 C172 68 208 112 206 178 C206 190 198 196 187 196 L53 196 C41 196 34 190 34 178 Z", o: "120,204", shine: "M62 122 q14 -26 38 -34", face: [120, 134, 27, 16, 15, 7], top: [122, 68], side: [178, 96] },
    drop: { name: "Drop", d: "M120 30 C138 62 192 104 192 146 C192 182 162 204 120 204 C78 204 48 182 48 146 C48 104 102 62 120 30 Z", o: "120,206", shine: "M70 146 q2 -26 22 -44", face: [120, 144, 24, 15, 18, 7], top: [120, 30], side: [158, 76] },
    pill: { name: "Pill", d: "M86 40 C110 34 132 34 156 40 C176 46 182 66 182 90 L182 162 C182 186 174 198 154 202 C132 206 108 206 86 202 C66 198 58 186 58 162 L58 90 C58 66 66 46 86 40 Z", o: "120,206", shine: "M74 72 q8 -18 26 -24", face: [120, 106, 25, 15, 18, 7], top: [120, 37], side: [172, 50] },
  };

  /* Toppers, drawn relative to the shape's top (or side, for the star). */
  var TOPPERS = {
    none: { name: "None", svg: function () { return ""; } },
    curl: { name: "Curl", svg: function () { return '<path d="M0 0 C-2 -14 4 -24 14 -24 C22 -24 24 -16 18 -14" ' + L + "/>"; } },
    sprout: { name: "Sprout", svg: function () { return '<path d="M0 0 C0 -12 1 -20 3 -26 M2 -18 C-6 -18 -12 -24 -12 -32 C-4 -32 2 -26 2 -18 Z M3 -22 C11 -20 18 -26 20 -34 C10 -36 3 -30 3 -22 Z" fill="#fff" ' + T + "/>"; } },
    sparks: { name: "Sparks", svg: function () { return '<path d="M0 -12 V-26 M-20 -8 L-30 -20 M20 -8 L30 -20" ' + L + "/>"; } },
    rays: { name: "Rays", svg: function () { return '<path d="M0 -18 V-38 M-50 -2 L-64 -18 M50 -2 L64 -18 M-84 36 L-102 28 M84 36 L102 28" ' + L + ' opacity=".9"/>'; } },
    antenna: { name: "Antenna", svg: function (acc) { return '<path d="M0 0 C2 -10 -2 -18 2 -26" ' + L + '/><circle cx="3" cy="-32" r="7" fill="' + acc + '" ' + T + ' stroke-width="3"/>'; } },
    bow: { name: "Bow", svg: function (acc) { return '<path d="M0 -6 L-20 -18 C-24 -10 -24 2 -20 8 Z M0 -6 L20 -18 C24 -10 24 2 20 8 Z" fill="' + acc + '" ' + T + ' stroke-width="3"/><circle cx="0" cy="-5" r="5" fill="' + acc + '" ' + T + ' stroke-width="3"/>'; } },
    star: { name: "Star", side: true, svg: function () { return '<path d="M0 -20 l5 13 l14 1 l-11 9 l4 14 l-12 -8 l-12 8 l4 -14 l-11 -9 l14 -1 Z" fill="#F5C842" ' + T + ' stroke-width="3.4"/>'; } },
  };
  var EYES = { dots: "Dots", big: "Big", small: "Small", wide: "Wide apart", one: "One", sleepy: "Sleepy" };
  var COLORS = ["#F5C842", "#4CBF73", "#E5603E", "#5B9BF8", "#F3A77C", "#B18CF0", "#F28BA8", "#7FD6C2", "#FAFAF7", "#3B3A36"];

  /* The one Blink that ships with Cloak: the O from the wordmark, drawn by
     hand. Every other character is one somebody made (or an example). */
  var DEFS = {
    cloak: { shape: "orb", color: "#D44D2A", eyes: "big", topper: "none" },
  };

  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function lum(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return 1;
    var n = parseInt(m[1], 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  // Any id or partial spec becomes a full, safe spec.
  function resolve(x) {
    var s = typeof x === "string" ? DEFS[x] || DEFS.cloak : x || {};
    var col = /^#[0-9a-f]{6}$/i.test(s.color || "") ? s.color : "#D44D2A";
    return {
      shape: SHAPES[s.shape] ? s.shape : "orb",
      color: col,
      eyes: EYES[s.eyes] ? s.eyes : "dots",
      topper: TOPPERS[s.topper] ? s.topper : "none",
      glasses: !!s.glasses || s.eyes === "glasses", // older Blinks had glasses as an eye style
      cheeks: !!s.cheeks,
    };
  }
  function draw(spec) {
    var sh = SHAPES[spec.shape], tp = TOPPERS[spec.topper];
    var ink = lum(spec.color) < 0.12 ? "#FAFAF7" : DARK; // eyes stay readable on dark bodies
    var acc = /^#(e5603e|d44d2a)$/i.test(spec.color) ? "#F5C842" : "#E5603E";
    var at = tp.side ? sh.side : sh.top;
    var f = sh.face;
    var cheeks = spec.cheeks ? '<ellipse cx="' + (f[0] - f[2] - 22) + '" cy="' + (f[1] + f[4] + 8) + '" rx="10" ry="6" fill="#E5603E" opacity=".45"/><ellipse cx="' + (f[0] + f[2] + 22) + '" cy="' + (f[1] + f[4] + 8) + '" rx="10" ry="6" fill="#E5603E" opacity=".45"/>' : "";
    var hat = tp.svg(acc) ? '<g data-p="hat" data-o="' + at[0] + "," + at[1] + '"><g transform="translate(' + at[0] + " " + at[1] + ')">' + tp.svg(acc) + "</g></g>" : "";
    var shine = '<path d="' + sh.shine + '" fill="none" stroke="' + ink + '" stroke-width="3.2" stroke-linecap="round" opacity=".35"/>';
    return '<g data-p="body" data-o="' + sh.o + '">' + '<path d="' + sh.d + '" fill="' + spec.color + '" ' + S + "/>" + shine + hat + cheeks + face(f, spec.eyes, spec.glasses, ink) + "</g>";
  }

  /* ── The rig ─────────────────────────────────────────────────────── */
  var live = [];
  var raf = 0;
  var pointer = { x: 0, y: 0, t: 0 };

  function spring(s, target, stiff, damp, dt) {
    s.v += (target - s.x) * stiff * dt;
    s.v *= Math.pow(damp, dt * 60);
    s.x += s.v * dt;
    return s.x;
  }
  function sv(x) { return { x: x || 0, v: 0 }; }

  // tilt (deg), lift (px), look bias, eye openness, lean (deg), topper energy, breathing rate
  var MOODS = {
    idle: { tilt: 0, lift: 0, lookX: 0, lookY: 0, open: 1, lean: 0, top: 1, breathe: 1 },
    listen: { tilt: 7, lift: -3, lookX: 0, lookY: 0.15, open: 1.14, lean: 2.5, top: 1.4, breathe: 1 },
    think: { tilt: -7, lift: -1, lookX: 0.85, lookY: -0.9, open: 0.88, lean: -2, top: 0.6, breathe: 0.8 },
    search: { tilt: 0, lift: -2, lookX: 0, lookY: 0.1, open: 1.08, lean: 0, top: 2, breathe: 1.2 },
    work: { tilt: 0, lift: -3, lookX: 0, lookY: -0.1, open: 1.06, lean: 0, top: 2.4, breathe: 1.6 },
    talk: { tilt: 0, lift: -1.5, lookX: 0, lookY: 0, open: 1, lean: 0, top: 1.3, breathe: 1.15 },
    happy: { tilt: 5, lift: -4, lookX: 0, lookY: 0, open: 1, lean: 0, top: 2.6, breathe: 1.3 },
    care: { tilt: -5, lift: 3, lookX: 0, lookY: 0.35, open: 0.8, lean: 3, top: 0.4, breathe: 0.7 },
    sleep: { tilt: 9, lift: 6, lookX: 0, lookY: 0.7, open: 0.05, lean: 4, top: 0.2, breathe: 0.5 },
  };

  // Every animation, its variants, and the one in use. The first is the default.
  // Round two, from the lab's grades: bigger, more physical, each one distinct.
  var VARIANTS = {
    idle: ["breathe", "float"],
    listen: ["lean", "nudge"],
    think: ["arc", "pendulum", "orbit"],
    search: ["arc", "peek"],
    work: ["hop", "bounce"],
    talk: ["bob", "pulse"],
    happy: ["beam", "wiggle"],
    care: ["hug", "soft"],
    sleep: ["doze", "side"],
    cheer: ["hop", "spin", "double"],
    wave: ["wiggle", "rock"],
    nod: ["dip", "double"],
    blink: ["snappy", "classic"],
    change: ["kick", "none"],
    boil: ["boil", "steady"],
  };
  var STYLE = {};
  Object.keys(VARIANTS).forEach(function (k) { STYLE[k] = VARIANTS[k][0]; });

  // Shaped curves (no linear spatial motion).
  var ease = {
    out: function (k) { return 1 - Math.pow(1 - k, 3); },
    inOut: function (k) { return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; },
  };
  // One hop, phase 0..1: crouch (anticipation), launch with a stretch, a
  // parabolic arc, a squash on landing, then rest.
  function hopCurve(ph, H, Q) {
    Q = Q || 0.11;
    if (ph < 0.16) { var a = ease.inOut(ph / 0.16); return { y: 0, sq: Q * 0.9 * a }; }
    if (ph < 0.6) { var k = (ph - 0.16) / 0.44; return { y: -H * 4 * k * (1 - k), sq: -Q * 0.9 * (1 - k) * (1 - k) + Q * 0.9 * Math.max(0, 1 - k * 6) }; }
    if (ph < 0.8) { var l = (ph - 0.6) / 0.2; return { y: 0, sq: Q * 1.9 * Math.sin(Math.PI * Math.min(1, l * 1.25)) * (1 - l * 0.45) }; }
    return { y: 0, sq: 0 };
  }
  // A drawn "z" for sleeping (the one thing that floats off a Blink).
  function zee(x, y) { return '<path d="M' + x + " " + y + ' h13 l-13 15 h13" fill="none" stroke="' + INK + '" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>'; }

  function Creature(el, id, opts) {
    opts = opts || {};
    var spec = resolve(id);
    var n = ++uid;
    var fid = "cr-ink-" + n;
    el.innerHTML =
      '<svg viewBox="0 0 240 240" role="img" aria-label="' + esc(opts.label || (typeof id === "string" ? id : "A Blink")) + '" style="display:block;width:100%;height:100%;overflow:visible">' +
      "<defs>" +
      '<filter id="' + fid + '" x="-14%" y="-14%" width="128%" height="128%" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.024" numOctaves="2" seed="2" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="4.2" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="9" result="g"/>' +
      '<feColorMatrix in="g" type="matrix" values="0 0 0 0 0.04  0 0 0 0 0.04  0 0 0 0 0.04  0 0 0 -1.1 0.6" result="ga"/>' +
      '<feComposite in="ga" in2="d" operator="in" result="spk"/>' +
      '<feMerge><feMergeNode in="d"/><feMergeNode in="spk"/></feMerge>' +
      "</filter>" +
      "</defs>" +
      '<g class="cr-root" filter="url(#' + fid + ')"><g class="cr-hop">' + draw(spec) + "</g>" +
      '<g class="cr-z" opacity="0">' + zee(170, 70) + zee(170, 70) + zee(170, 70) + "</g></g>" +
      "</svg>";

    var svg = el.firstChild;
    var turb = svg.querySelector("feTurbulence");
    var hop = svg.querySelector(".cr-hop");
    var zz = svg.querySelector(".cr-z");
    var parts = {};
    svg.querySelectorAll("[data-p]").forEach(function (node) {
      var p = node.getAttribute("data-p");
      var o = (node.getAttribute("data-o") || "0,0").split(",").map(Number);
      (parts[p] = parts[p] || []).push({ node: node, ox: o[0], oy: o[1], dir: Number(node.getAttribute("data-dir") || 1), r: Number(node.getAttribute("data-r") || 6) });
    });

    var self = this;
    this.el = el;
    this.mood = MOODS[opts.mood] ? opts.mood : "idle";
    this.visible = true;
    var st = function (k) { return (opts.style && opts.style[k]) || STYLE[k]; };
    var t0 = Math.random() * 100;
    var s = { tilt: sv(), lift: sv(), lookX: sv(), lookY: sv(), open: sv(1), lean: sv(), top: sv(1), hop: sv(), squash: sv(), hatLag: sv(), happy: sv(), face: sv(), spin: sv(), reach: sv(1), roll: sv(), z: sv(), sx: sv() };
    var moodAt = 0;
    var blinkAt = -1, blink = 0;
    var glanceAt = 0, glance = { x: 0, y: 0 };
    var talk = 0, level = -1, voice = 0;
    var cheerT = -1, waveT = -1, nodT = -1;
    var boilAt = 0, seed = 2, lastTilt = 0;

    function X(part, tx, ty, rot, sx, sy) {
      var a = "";
      if (tx || ty) a += "translate(" + tx.toFixed(2) + " " + ty.toFixed(2) + ") ";
      if (rot) a += "rotate(" + rot.toFixed(2) + " " + part.ox + " " + part.oy + ") ";
      if (sx !== undefined && (sx !== 1 || sy !== 1)) a += "translate(" + part.ox + " " + part.oy + ") scale(" + sx.toFixed(3) + " " + sy.toFixed(3) + ") translate(" + -part.ox + " " + -part.oy + ")";
      part.node.setAttribute("transform", a);
    }
    function each(name, fn) {
      var list = parts[name];
      if (list) for (var i = 0; i < list.length; i++) fn(list[i], i);
    }
    // Quick, sure eye movements from one point to the next.
    function dart(t, every, spread) {
      if (t > glanceAt) {
        glanceAt = t + every * (0.7 + Math.random() * 0.6);
        glance = { x: Math.random() * 1.8 - 0.9, y: Math.random() * spread - spread * 0.6 };
      }
      return glance;
    }

    this.frame = function (now, dt) {
      var t = now / 1000 + t0;
      var mood = self.mood, m = MOODS[mood], v = st(mood);
      if (blinkAt < 0) { blinkAt = t + 1 + Math.random() * 3; glanceAt = t + 2 + Math.random() * 4; } // first blink comes after a beat, never on mount

      // Line boil: the hand-drawn ink is redrawn a few times a second (or held still).
      var bs = st("boil");
      if (bs !== "steady" && now > boilAt) {
        boilAt = now + (bs === "slow" ? 340 : 140);
        seed = seed >= 4 ? 2 : seed + 1;
        turb.setAttribute("seed", seed);
      }

      var lx = m.lookX, ly = m.lookY, open0 = m.open;
      var hopY = 0, squash = 0, leanX = 0, tiltX = 0, liftX = 0, spin = 0, breathK = 1, rateK = 1, glanceK = 1;
      var reach = 1, roll = 0, zOn = 0, sxX = 0, breathX = -1;
      if (!moodAt) moodAt = t;
      var mt = t - moodAt; // seconds in this mood

      // ── Where to look, and how each mood moves ──
      if (mood === "search") {
        if (v === "peek") {
          var g = dart(t, 0.28, 0.7);
          lx = g.x; ly = g.y; open0 = 1.22; liftX = -6; squash -= 0.05; reach = 1.35;
          leanX = g.x * 4;
        } else {
          // The eyes travel an arc around the bottom of the face, side to side.
          var th = Math.PI * (0.5 - 0.5 * Math.cos(t * 2.1));
          lx = -Math.cos(th); ly = 0.1 + 0.9 * Math.sin(th);
          reach = 1.5;
          tiltX = lx * 5; leanX = lx * 2.5;
          hopY -= Math.abs(Math.sin(t * 4.2)) * 3;
        }
      } else if (mood === "work") {
        var g2 = dart(t, 0.45, 1);
        lx = g2.x; ly = g2.y; reach = 1.2;
        if (v === "bounce") {
          // Big hops with momentum: a deep crouch, a long arc, a heavy squash.
          var h = hopCurve((t * 1.05) % 1, 30, 0.2);
          hopY += h.y; squash += h.sq;
          leanX = Math.sin(t * 1.05 * Math.PI * 2) * 3;
          ly = Math.min(ly, h.y < -10 ? -0.4 : ly);
        } else {
          var ph = (t * 2.6) % 1;
          hopY += -9 * Math.sin(Math.PI * Math.min(1, ph / 0.62));
          if (ph > 0.62) squash += 0.07 * Math.sin(Math.PI * (ph - 0.62) / 0.38);
          leanX = Math.sin(t * 2.6 * Math.PI) * 4;
        }
      } else if (mood === "think") {
        if (v === "arc") {
          // The eyes travel an arc around the bottom of the face, side to side
          // (unhurried: it is thinking, not reading).
          var tha = Math.PI * (0.5 - 0.5 * Math.cos(t * 1.5));
          lx = -Math.cos(tha); ly = 0.1 + 0.9 * Math.sin(tha);
          reach = 1.5;
          tiltX = lx * 5; leanX = lx * 2.5;
          hopY -= Math.abs(Math.sin(t * 3)) * 2;
        } else if (v === "orbit") {
          // Eyes roll up and around while the body tips after them.
          lx = Math.cos(t * 2.2) * 0.9; ly = -0.45 + Math.sin(t * 2.2) * 0.45;
          reach = 1.35;
          tiltX = lx * 7; leanX = lx * 3;
          hopY -= 3 + Math.sin(t * 4.4) * 2;
        } else {
          // Eyes closed, swaying side to side, mulling it over.
          open0 = 0.07;
          leanX = Math.sin(t * 1.5) * 11;
          tiltX = -Math.sin(t * 1.5 - 0.5) * 5;
          lx = 0; ly = 0.2;
          hopY -= Math.abs(Math.cos(t * 1.5)) * 2.5;
        }
      } else if (mood === "idle" || mood === "listen" || mood === "talk") {
        if (now - pointer.t < 2600) {
          var r = el.getBoundingClientRect();
          var dx = pointer.x - (r.left + r.width / 2), dy = pointer.y - (r.top + r.height * 0.45);
          var d = Math.max(120, Math.hypot(dx, dy));
          lx += (dx / d) * 1.15;
          ly += (dy / d) * 1.15;
        } else {
          if (t > glanceAt) {
            glanceAt = t + (1.4 + Math.random() * 4) * glanceK;
            glance = Math.random() < 0.35 ? { x: 0, y: 0 } : { x: Math.random() * 1.7 - 0.85, y: Math.random() * 0.9 - 0.35 };
          }
          lx += glance.x;
          ly += glance.y;
        }
        if (mood === "idle") {
          if (v === "float") {
            // Floating: a slow, weightless drift with a lazy sway.
            hopY += -7 - 8 * Math.sin(t * 1.05);
            tiltX += Math.sin(t * 0.55) * 4;
            leanX = Math.sin(t * 0.55 + 1) * 2.5;
            squash += Math.max(0, Math.sin(t * 1.05)) * 0.025;
          } else {
            // A real breath: in (slower, the body swells and rises), out (it settles).
            var bp = (t / 4.2) % 1, inh = bp < 0.45 ? ease.inOut(bp / 0.45) : 1 - ease.inOut((bp - 0.45) / 0.55);
            breathX = inh;
            sxX = 0.045 * inh;
            liftX = -2.5 * inh;
          }
        }
        if (mood === "listen") {
          if (v === "nudge") { liftX = -5 + Math.max(0, Math.sin(t * 4)) * -3; open0 = 1.2; }
          else { leanX = 6; tiltX = 6; liftX = -5; open0 = 1.18; hopY -= 2; }
        }
        if (mood === "talk") {
          // Talking: the body swings gently and every syllable bounces it.
          tiltX += Math.sin(t * 2.1) * 4;
          leanX += Math.sin(t * 1.4) * 3;
        }
      } else if (mood === "happy") {
        if (v === "wiggle") leanX = Math.sin(t * 9) * 9 * (0.55 + 0.45 * Math.sin(t * 1.2));
        else hopY -= Math.abs(Math.sin(t * 3)) * 4;
      } else if (mood === "care") {
        if (v === "soft") { leanX = Math.sin(t * 0.9) * 3; breathK = 1.4; }
        else {
          // A slow hug: every few seconds it squeezes in, eyes softly closing.
          var cp = (t / 3.4) % 1, hug = cp < 0.35 ? ease.inOut(cp / 0.35) : cp < 0.6 ? 1 : 1 - ease.inOut((cp - 0.6) / 0.4);
          sxX = -0.07 * hug; squash -= 0.04 * hug;
          open0 = 0.8 - 0.62 * hug;
          tiltX = -6 + Math.sin(t * 0.8) * 2.5; leanX = 3 + 2 * hug;
          liftX = 2 - 2 * hug;
        }
      } else if (mood === "sleep") {
        zOn = 1;
        if (v === "side") { roll = 74; open0 = 0.04; breathK = 3; rateK = 0.55; }
        else {
          // Dozing: nods off, jolts awake, nods off again, then rolls onto its
          // side and sleeps, turning over now and then.
          var c0 = mt % 30;
          if (c0 < 6.5) {
            var nodd = c0 < 2.6 ? c0 / 2.6 : c0 < 2.9 ? 1 - (c0 - 2.6) / 0.3 : c0 < 5.2 ? (c0 - 2.9) / 2.3 : c0 < 5.45 ? 1 - (c0 - 5.2) / 0.25 : (c0 - 5.45) / 1.05;
            nodd = ease.inOut(Math.max(0, Math.min(1, nodd)));
            open0 = 1 - 0.92 * nodd; liftX = 8 * nodd; tiltX = 9 * nodd;
            if ((c0 > 2.6 && c0 < 2.9) || (c0 > 5.2 && c0 < 5.45)) { liftX -= 6; open0 = 1.15; }
            zOn = c0 > 5.6 ? 1 : 0;
          } else {
            var side = Math.floor((c0 - 6.5) / 11.75) % 2 ? -1 : 1;
            roll = 74 * side; open0 = 0.04; breathK = 2.6; rateK = 0.55;
          }
          if (c0 < 6.5) { lx = 0; ly = 0.6; }
        }
      }
      var nod = 0;
      if (nodT >= 0) {
        nodT += dt;
        if (st("nod") === "double") {
          nod = Math.sin(nodT * 14) * Math.max(0, 1 - nodT / 1.15) * 5;
          if (nodT > 1.25) nodT = -1;
        } else {
          // A real nod: the eyes drop, the body squishes down, twice, then settles.
          var half = 0.42, n1 = nodT < half ? Math.sin(Math.PI * nodT / half) : nodT < half * 2 ? 0.7 * Math.sin(Math.PI * (nodT - half) / half) : 0;
          nod = 7 * n1; squash += 0.08 * n1; ly = 0.95 * n1 - 0.25 * (1 - n1) * (nodT < half * 2 ? 1 : 0); lx *= 1 - n1;
          if (nodT > half * 2 + 0.15) nodT = -1;
        }
      }

      lx = Math.max(-1, Math.min(1, lx));
      ly = Math.max(-1, Math.min(1, ly));
      // Eyes lead (snappy), the face follows (softer), the body leans last.
      var ex = spring(s.lookX, lx, 210, 0.7, dt), ey = spring(s.lookY, ly, 210, 0.7, dt);
      var fx = spring(s.face, lx, 60, 0.82, dt);

      // Blink: fast shut, slower open, sometimes twice.
      var snappy = st("blink") === "snappy";
      if (t > blinkAt && blink <= 0) {
        blink = 1;
        blinkAt = t + (Math.random() < 0.18 ? 0.3 : 2 + Math.random() * 4.2) * (mood === "think" ? 1.5 : 1);
      }
      if (blink > 0) blink = Math.max(0, blink - dt / (snappy ? 0.11 : 0.17));
      var shut = blink > 0 ? Math.sin(Math.PI * Math.pow(1 - blink, 0.6)) : 0;
      if (snappy) liftX += shut * 1.6;
      var open = spring(s.open, open0 * (spec.eyes === "sleepy" && mood !== "happy" ? 0.48 : 1), 130, 0.7, dt) * (1 - shut * 0.95);

      // Voice: a live audio level, or stream energy from pulse() shaped into syllables.
      talk = Math.max(0, talk - dt * 2.6);
      var target;
      if (level >= 0) target = Math.min(1, level * 1.6);
      else {
        var syll = Math.abs(Math.sin(t * 17.3) * 0.6 + Math.sin(t * 11.1 + 1.3) * 0.4);
        target = talk > 0.04 ? Math.min(1, talk) * (0.25 + 0.75 * syll) : 0;
      }
      voice += (target - voice) * Math.min(1, dt * 28);
      if (mood === "talk" && v === "bob") { liftX -= voice * 7; tiltX += voice * Math.sin(t * 9) * 4; squash -= voice * 0.07; open0 = 1 + voice * 0.15; }

      // ── Gestures on top ──
      if (cheerT >= 0) {
        cheerT += dt;
        var c = cheerT, cv = st("cheer");
        if (cv === "double") {
          if (c < 0.12) squash += 0.09 * ease.out(c / 0.12);
          else if (c < 0.42) { var k1 = (c - 0.12) / 0.3; hopY += -26 * 4 * k1 * (1 - k1); squash -= 0.08 * (1 - k1); }
          else if (c < 0.52) squash += 0.08 * Math.sin(Math.PI * (c - 0.42) / 0.1);
          else if (c < 0.86) { var k2 = (c - 0.52) / 0.34; hopY += -38 * 4 * k2 * (1 - k2); squash -= 0.1 * (1 - k2); }
          else if (c < 1) squash += 0.12 * Math.sin(Math.PI * (c - 0.86) / 0.14);
          else if (c > 1.7) cheerT = -1;
        } else {
          if (c < 0.14) squash += 0.1 * ease.out(c / 0.14);
          else if (c < 0.54) {
            var k = (c - 0.14) / 0.4;
            hopY += -26 * 4 * k * (1 - k);
            squash -= 0.08 * (1 - k);
            if (cv === "spin") spin = 360 * ease.inOut(k);
          } else if (c < 0.68) squash += 0.12 * Math.sin(Math.PI * (c - 0.54) / 0.14);
          else if (c > 1.5) cheerT = -1;
        }
      }
      var rock = 0;
      if (waveT >= 0) {
        waveT += dt;
        var fade = Math.max(0, 1 - waveT / 1.1);
        if (st("wave") === "wiggle") { rock = Math.sin(waveT * 20) * 5 * fade; squash += Math.abs(Math.sin(waveT * 20)) * 0.03 * fade; }
        else rock = Math.sin(waveT * 16) * 14 * fade;
        if (waveT > 1.2) waveT = -1;
      }
      var hy = spring(s.hop, hopY, 330, 0.62, dt);
      var sq = spring(s.squash, squash, 300, 0.6, dt);
      var sp = spin ? spin : spring(s.spin, 0, 200, 0.7, dt);
      if (spin) { s.spin.x = spin > 180 ? spin - 360 : spin; s.spin.v = 0; }
      var smile = spring(s.happy, mood === "happy" || (cheerT >= 0 && cheerT < 1.3) || waveT >= 0 ? 1 : 0, 170, 0.7, dt);

      var breath = breathX >= 0 ? breathX * 0.035 : Math.sin(t * 1.55 * m.breathe * rateK) * 0.014 * (0.6 + m.breathe * 0.4) * breathK;
      var rl = spring(s.roll, roll, 34, 0.86, dt);
      var sxs = spring(s.sx, sxX, 90, 0.8, dt);
      var zv = spring(s.z, zOn, 40, 0.85, dt);
      var beat = voice * 0.05; // no mouth: the whole shape pulses with each syllable
      var tilt = spring(s.tilt, m.tilt + tiltX + fx * 3 + Math.sin(t * 0.6) * 1, 48, 0.86, dt);
      var lift = spring(s.lift, m.lift + liftX + ey * 1.6 - voice * 2 + nod, 80, 0.82, dt);
      var lean = spring(s.lean, m.lean + leanX + fx * 2.2 + Math.sin(t * 0.43) * 0.8, 26, 0.9, dt) + rock;
      var topE = spring(s.top, m.top, 30, 0.9, dt);

      // The topper arrives late: it trails the body's motion (follow-through).
      var dTilt = (tilt - lastTilt) / Math.max(dt, 0.001);
      lastTilt = tilt;
      var hat = spring(s.hatLag, -dTilt * 0.25 - hy * 0.5 - lean * 0.6, 110, 0.78, dt);

      hop.setAttribute("transform", "translate(0 " + hy.toFixed(2) + ")" + (Math.abs(sp) > 0.05 ? " rotate(" + sp.toFixed(2) + " 120 124)" : ""));
      each("body", function (p) { X(p, 0, 0, lean + rl, 1 - breath * 0.5 + sq * 0.9 - beat * 0.5 + sxs, 1 + breath - sq + beat); });
      // Lying down: slide over so the Blink stays centred on its side.
      if (Math.abs(rl) > 0.5) hop.setAttribute("transform", "translate(" + (-Math.sin(rl * Math.PI / 180) * 70).toFixed(2) + " " + (hy - Math.abs(Math.sin(rl * Math.PI / 180)) * 52).toFixed(2) + ")");
      // Sleeping: z's float up and away, one after another.
      zz.setAttribute("opacity", Math.max(0, Math.min(1, zv)).toFixed(2));
      if (zv > 0.02) {
        var sr = Math.sin(rl * Math.PI / 180), zs = zz.childNodes, zx = sr * (sr > 0 ? 40 : 160), zy = Math.abs(sr) * -6;
        for (var zi = 0; zi < 3; zi++) {
          var zp = (t * 0.42 + zi / 3) % 1;
          var zo = zp < 0.15 ? zp / 0.15 : zp > 0.7 ? (1 - zp) / 0.3 : 1;
          zs[zi].setAttribute("transform", "translate(" + (zx + zp * 26 + Math.sin(zp * 6.3) * 4).toFixed(2) + " " + (zy - zp * 54).toFixed(2) + ") translate(176 78) scale(" + (0.55 + zp * 0.7).toFixed(2) + ") translate(-176 -78)");
          zs[zi].setAttribute("opacity", zo.toFixed(2));
        }
      }
      each("head", function (p) { X(p, fx * 5.5, lift + ey * 2.2, tilt * 0.55); });
      each("socket", function (p) { X(p, 0, 0, 0, 1 - voice * 0.08, Math.max(0.05, Math.min(1.16, open + voice * 0.22)) * (1 - smile)); p.node.style.opacity = smile > 0.6 ? 0 : 1; });
      var rc = spring(s.reach, reach, 90, 0.8, dt);
      each("pupil", function (p) { X(p, ex * p.r * rc, ey * p.r * 0.9 * rc, 0); });
      each("smile", function (p) { p.node.setAttribute("opacity", smile > 0.6 ? 1 : 0); });
      each("hat", function (p) { X(p, 0, 0, hat + Math.sin(t * (1 + topE * 0.8)) * (1.2 + topE * 1.6), 1, 1 + Math.sin(t * 2.2) * 0.02 * topE); });
    };

    this.set = function (mood) {
      if (!MOODS[mood] || mood === self.mood) return;
      if (mood === "happy") self.cheer();
      // A change of mood lands with a small kick: a squash and a lift that settle.
      if (st("change") === "kick") { s.squash.v += 1.1; s.hop.v -= 40; }
      self.mood = mood;
      moodAt = 0;
      el.setAttribute("data-mood", mood);
    };
    this.pulse = function (v) { talk = Math.min(1.4, talk + (v || 0.5)); };
    // Live audio level 0..1 (the shape pulses with the voice); pass -1 to hand back to pulse().
    this.level = function (v) { level = v; };
    this.cheer = function () { if (cheerT < 0) cheerT = 0; };
    this.wave = function () { if (waveT < 0) waveT = 0; };
    this.nod = function () { if (nodT < 0) nodT = 0; };
    this.style = function (k, v) { opts.style = opts.style || {}; opts.style[k] = v; };
    this.destroy = function () {
      var i = live.indexOf(self);
      if (i !== -1) live.splice(i, 1);
      if (io) io.disconnect();
      el.innerHTML = "";
    };

    var io = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(function (es) { self.visible = es[0].isIntersecting; }, { rootMargin: "80px" });
      io.observe(el);
    }
    el.setAttribute("data-mood", this.mood);
    if (reduce || opts.still) {
      // A still drawing: one frame so every part sits in its pose.
      this.frame(0, 0.016);
      return;
    }
    live.push(this);
    start();
  }

  var last = 0;
  function tick(now) {
    raf = 0;
    var dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    if (!document.hidden) for (var i = 0; i < live.length; i++) if (live[i].visible) live[i].frame(now, dt);
    if (live.length) start();
  }
  function start() { if (!raf) raf = requestAnimationFrame(tick); }
  window.addEventListener("pointermove", function (e) { pointer.x = e.clientX; pointer.y = e.clientY; pointer.t = performance.now(); }, { passive: true });

  window.Creatures = {
    ids: Object.keys(DEFS),
    color: function (id) { return resolve(id).color; },
    spec: resolve,
    shapes: Object.keys(SHAPES).map(function (k) { return { id: k, name: SHAPES[k].name }; }),
    toppers: Object.keys(TOPPERS).map(function (k) { return { id: k, name: TOPPERS[k].name }; }),
    eyes: Object.keys(EYES).map(function (k) { return { id: k, name: EYES[k] }; }),
    colors: COLORS.slice(),
    random: function () {
      var pick = function (a) { return a[Math.floor(Math.random() * a.length)]; };
      return { shape: pick(Object.keys(SHAPES)), color: pick(COLORS.slice(0, 8)), eyes: pick(["dots", "dots", "big", "small", "wide", "one", "sleepy"]), topper: pick(Object.keys(TOPPERS)), glasses: Math.random() < 0.25, cheeks: Math.random() < 0.35 };
    },
    mount: function (el, id, opts) { return new Creature(el, id, opts); },
    variants: VARIANTS,
    style: STYLE, // the variant each animation uses; change entries to switch them everywhere
  };
})();
