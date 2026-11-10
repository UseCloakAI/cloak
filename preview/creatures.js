/* The companions: five hand-drawn shapes with eyes. Wobbly ink outlines,
   hatched shadows, flat Cloak colours. Drawn as paths, rigged and animated in
   code: no image files, no generated art.

   They behave like an avatar, not an icon. One state machine drives every
   part: idle, listen, think, search, talk, happy, care, sleep. Eyes lead and
   the face follows, the body leans after the face, arms and toppers arrive
   late. Talking is driven by real energy (stream chunks or audio level), and
   there are gestures on top of the states: cheer (crouch, hop, squash),
   wave, nod.

   Creatures.mount(el, "ember", { mood }) →
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
  function eye(x, y, rx, ry, pr) {
    var w = (pr * 0.92).toFixed(1), h = (pr * 1.28).toFixed(1), sw = (rx * 0.72).toFixed(1);
    return (
      '<g data-p="pupil" data-o="' + x + "," + y + '" data-r="' + (rx - pr + 1).toFixed(1) + '">' +
      '<ellipse data-p="socket" data-o="' + x + "," + y + '" cx="' + x + '" cy="' + y + '" rx="' + w + '" ry="' + h + '" fill="' + DARK + '"/>' +
      "</g>" +
      '<path data-p="smile" d="M' + (x - sw) + " " + (y + 3) + " Q" + x + " " + (y - ry * 0.7 - 3).toFixed(1) + " " + (x + +sw) + " " + (y + 3) + '" ' + LF + ' opacity="0"/>'
    );
  }
  function face(cx, cy, gap, rx, ry, pr, my) {
    return (
      '<g data-p="head" data-o="' + cx + "," + (cy + 20) + '">' +
      eye(cx - gap, cy, rx, ry, pr) + eye(cx + gap, cy, rx, ry, pr) +
      '<ellipse data-p="mouth" data-o="' + cx + "," + (my - 2) + '" cx="' + cx + '" cy="' + (my + 3) + '" rx="9" ry="8" fill="' + DARK + '" stroke="' + DARK + '" stroke-width="3"/>' +
      '<path data-p="lip" d="M' + (cx - 9) + " " + my + " Q" + cx + " " + (my + 8) + " " + (cx + 9) + " " + my + '" ' + LF + "/>" +
      "</g>"
    );
  }
  function arms(lx, rx, y) {
    return (
      '<g data-p="wing" data-o="' + lx + "," + y + '" data-dir="1"><path d="M' + lx + " " + y + " q-20 6 -26 26 m0 0 l-7 -3 m7 3 l-1 8 m1 -8 l6 5" + '" ' + L + "/></g>" +
      '<g data-p="wing" data-o="' + rx + "," + y + '" data-dir="-1"><path d="M' + rx + " " + y + " q20 6 26 26 m0 0 l7 -3 m-7 3 l1 8 m-1 -8 l-6 5" + '" ' + L + "/></g>"
    );
  }
  // The shadow is hatched by hand, not filled: Cloak's hard shadow, drawn.
  function shadow(d, id) {
    return '<path d="' + d + '" transform="translate(11 10)" fill="url(#' + id + ')" stroke="' + INK + '" stroke-width="3" stroke-linejoin="round"/>';
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

  var SHAPES = {
    orb: "M120 42 C168 40 202 78 200 124 C198 172 164 204 118 202 C72 200 38 166 40 120 C42 76 74 44 120 42 Z",
    slab: "M60 58 C98 50 152 52 186 60 C196 96 196 152 188 190 C150 200 94 200 56 192 C46 150 48 98 60 58 Z",
    spark: "M120 34 C129 34 135 42 141 53 L202 166 C211 183 202 198 183 198 L57 198 C38 198 29 183 38 166 L99 53 C105 42 111 34 120 34 Z",
    bloom: bloom(),
    dome: "M34 178 C32 112 72 68 122 68 C172 68 208 112 206 178 C206 190 198 196 187 196 L53 196 C41 196 34 190 34 178 Z",
  };

  var DEFS = {
    /* Pip: a bright orb with a curl on top. Quick. */
    pip: {
      color: "#F5C842",
      svg: function (h) {
        return (
          '<g data-p="body" data-o="120,206">' + shadow(SHAPES.orb, h) + arms(46, 194, 128) +
          '<path d="' + SHAPES.orb + '" fill="#F5C842" ' + S + "/>" +
          '<path d="M66 92 q10 -22 32 -30" ' + TF + ' opacity=".4"/>' +
          '<g data-p="hat" data-o="120,44"><path d="M120 44 C118 30 124 20 134 20 C142 20 144 28 138 30" ' + L + "/></g>" +
          face(120, 112, 26, 17, 20, 7.5, 152) + "</g>"
        );
      },
    },
    /* Moss: a heavy slab with round glasses. Slow and exact. */
    moss: {
      color: "#4CBF73",
      svg: function (h) {
        return (
          '<g data-p="body" data-o="122,206">' + shadow(SHAPES.slab, h) + arms(54, 190, 130) +
          '<path d="' + SHAPES.slab + '" fill="#4CBF73" ' + S + "/>" +
          '<path d="M72 78 q22 -8 46 -8" ' + TF + ' opacity=".4"/>' +
          '<g data-p="hat" data-o="150,56"><path d="M150 56 C150 44 151 36 153 30 M152 38 C144 38 138 32 138 24 C146 24 152 30 152 38 Z M153 34 C161 36 168 30 170 22 C160 20 153 26 153 34 Z" fill="#fff" ' + T + "/></g>" +
          face(122, 112, 28, 16, 18, 7, 154) +
          '<g data-p="head" data-o="122,132"><path d="M72 112 a22 23 0 1 0 44 0 a22 23 0 1 0 -44 0 M128 112 a22 23 0 1 0 44 0 a22 23 0 1 0 -44 0 M116 110 q6 -5 12 0 M72 108 l-14 -6 M172 108 l14 -6" ' + TF + '/></g>' +
          "</g>"
        );
      },
    },
    /* Ember: a spark, all point and nerve. Builds things. */
    ember: {
      color: "#E5603E",
      svg: function (h) {
        return (
          '<g data-p="body" data-o="120,206">' + shadow(SHAPES.spark, h) + arms(55, 185, 142) +
          '<path d="' + SHAPES.spark + '" fill="#E5603E" ' + S + "/>" +
          '<path d="M104 70 l-22 42" ' + TF + ' opacity=".4"/>' +
          '<g data-p="hat" data-o="120,34"><path d="M120 22 V8 M100 26 L90 14 M140 26 L150 14" ' + L + "/></g>" +
          face(120, 136, 22, 14, 17, 6.5, 172) + "</g>"
        );
      },
    },
    /* Juno: a bloom with a star tucked behind one petal. Plays. */
    juno: {
      color: "#5B9BF8",
      svg: function (h) {
        return (
          '<g data-p="body" data-o="120,206">' + shadow(SHAPES.bloom, h) + arms(46, 194, 126) +
          '<path d="' + SHAPES.bloom + '" fill="#5B9BF8" ' + S + "/>" +
          '<path d="M74 84 q12 -16 28 -18" ' + TF + ' opacity=".4"/>' +
          '<g data-p="hat" data-o="176,58"><path d="M176 38 l5 13 l14 1 l-11 9 l4 14 l-12 -8 l-12 8 l4 -14 l-11 -9 l14 -1 Z" fill="#F5C842" ' + T + ' stroke-width="3.4"/></g>' +
          face(120, 116, 25, 16, 19, 7, 154) + "</g>"
        );
      },
    },
    /* Sol: a low dome that sits and stays. Calm. */
    sol: {
      color: "#F3A77C",
      svg: function (h) {
        return (
          '<g data-p="hat" data-o="120,120"><path d="M120 50 V30 M70 66 L56 50 M170 66 L184 50 M36 104 L18 96 M204 104 L222 96" ' + L + ' opacity=".9"/></g>' +
          '<g data-p="body" data-o="120,204">' + shadow(SHAPES.dome, h) +
          '<path d="' + SHAPES.dome + '" fill="#F3A77C" ' + S + "/>" +
          '<path d="M62 122 q14 -26 38 -34" ' + TF + ' opacity=".4"/>' +
          '<ellipse cx="72" cy="160" rx="10" ry="6" fill="#E5603E" opacity=".45"/><ellipse cx="168" cy="160" rx="10" ry="6" fill="#E5603E" opacity=".45"/>' +
          face(120, 134, 27, 16, 15, 7, 168) + "</g>"
        );
      },
    },
  };

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

  // tilt (deg), lift (px), look bias, eye openness, lean (deg), arm raise, topper energy, breathing rate
  var MOODS = {
    idle: { tilt: 0, lift: 0, lookX: 0, lookY: 0, open: 1, lean: 0, arm: 0, top: 1, breathe: 1 },
    listen: { tilt: 7, lift: -3, lookX: 0, lookY: 0.15, open: 1.14, lean: 2.5, arm: 0.15, top: 1.4, breathe: 1 },
    think: { tilt: -7, lift: -1, lookX: 0.85, lookY: -0.9, open: 0.88, lean: -2, arm: 0.5, top: 0.6, breathe: 0.8 },
    search: { tilt: 0, lift: -2, lookX: 0, lookY: 0.1, open: 1.08, lean: 0, arm: 0.2, top: 2, breathe: 1.2 },
    talk: { tilt: 0, lift: -1.5, lookX: 0, lookY: 0, open: 1, lean: 0, arm: 0.35, top: 1.3, breathe: 1.15 },
    happy: { tilt: 5, lift: -4, lookX: 0, lookY: 0, open: 1, lean: 0, arm: 1, top: 2.6, breathe: 1.3 },
    care: { tilt: -5, lift: 3, lookX: 0, lookY: 0.35, open: 0.8, lean: 3, arm: -0.2, top: 0.4, breathe: 0.7 },
    sleep: { tilt: 9, lift: 6, lookX: 0, lookY: 0.7, open: 0.05, lean: 4, arm: -0.3, top: 0.2, breathe: 0.5 },
  };

  function Creature(el, id, opts) {
    opts = opts || {};
    var def = DEFS[id] || DEFS.pip;
    var n = ++uid;
    var fid = "cr-ink-" + n, hid = "cr-hatch-" + n;
    el.innerHTML =
      '<svg viewBox="0 0 240 240" role="img" aria-label="' + (opts.label || id) + '" style="display:block;width:100%;height:100%;overflow:visible">' +
      "<defs>" +
      '<filter id="' + fid + '" x="-14%" y="-14%" width="128%" height="128%" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.024" numOctaves="2" seed="2" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="4.2" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="9" result="g"/>' +
      '<feColorMatrix in="g" type="matrix" values="0 0 0 0 0.04  0 0 0 0 0.04  0 0 0 0 0.04  0 0 0 -1.1 0.6" result="ga"/>' +
      '<feComposite in="ga" in2="d" operator="in" result="spk"/>' +
      '<feMerge><feMergeNode in="d"/><feMergeNode in="spk"/></feMerge>' +
      "</filter>" +
      '<pattern id="' + hid + '" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(38)"><line x1="0" y1="0" x2="0" y2="9" stroke="' + INK + '" stroke-width="3.4"/></pattern>' +
      "</defs>" +
      '<g class="cr-dots" opacity="0"><circle cx="196" cy="52" r="4.5" fill="' + INK + '"/><circle cx="210" cy="36" r="6" fill="' + INK + '"/><circle cx="226" cy="16" r="8" fill="' + INK + '"/></g>' +
      '<g class="cr-root" filter="url(#' + fid + ')"><g class="cr-hop">' + def.svg(hid) + "</g></g>" +
      "</svg>";

    var svg = el.firstChild;
    var turb = svg.querySelector("feTurbulence");
    var hop = svg.querySelector(".cr-hop");
    var dots = svg.querySelector(".cr-dots");
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
    var t0 = Math.random() * 100;
    var s = { tilt: sv(), lift: sv(), lookX: sv(), lookY: sv(), open: sv(1), lean: sv(), arm: sv(), top: sv(1), hop: sv(), squash: sv(), dots: sv(), hatLag: sv(), happy: sv(), face: sv(), wave: sv(), nod: sv() };
    var blinkAt = 1 + Math.random() * 3, blink = 0;
    var glanceAt = 2 + Math.random() * 4, glance = { x: 0, y: 0 };
    var talk = 0, level = -1, mouth = 0;
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

    this.frame = function (now, dt) {
      var t = now / 1000 + t0;
      var m = MOODS[self.mood];

      // Line boil: the ink is redrawn about seven times a second.
      if (now > boilAt) {
        boilAt = now + 140;
        seed = seed >= 4 ? 2 : seed + 1;
        turb.setAttribute("seed", seed);
      }

      // Where to look. Searching scans side to side like reading; otherwise
      // follow the pointer if it moved lately, else glance around.
      var lx = m.lookX, ly = m.lookY;
      if (self.mood === "search") {
        lx = Math.sin(t * 5.2) * 0.95;
        ly = 0.15 + Math.sin(t * 1.3) * 0.25;
      } else if (self.mood === "idle" || self.mood === "listen" || self.mood === "talk") {
        if (now - pointer.t < 2600) {
          var r = el.getBoundingClientRect();
          var dx = pointer.x - (r.left + r.width / 2), dy = pointer.y - (r.top + r.height * 0.45);
          var d = Math.max(120, Math.hypot(dx, dy));
          lx += (dx / d) * 1.15;
          ly += (dy / d) * 1.15;
        } else {
          if (t > glanceAt) {
            glanceAt = t + 1.4 + Math.random() * 4;
            glance = Math.random() < 0.35 ? { x: 0, y: 0 } : { x: Math.random() * 1.7 - 0.85, y: Math.random() * 0.9 - 0.35 };
          }
          lx += glance.x;
          ly += glance.y;
        }
      }
      lx = Math.max(-1, Math.min(1, lx));
      ly = Math.max(-1, Math.min(1, ly));
      // Eyes lead (snappy), the face follows (softer), the body leans last.
      var ex = spring(s.lookX, lx, 210, 0.7, dt), ey = spring(s.lookY, ly, 210, 0.7, dt);
      var fx = spring(s.face, lx, 60, 0.82, dt);

      // Blink: fast shut, slower open, sometimes twice.
      if (t > blinkAt && blink <= 0) {
        blink = 1;
        blinkAt = t + (Math.random() < 0.18 ? 0.3 : 2 + Math.random() * 4.2) * (self.mood === "think" ? 1.5 : 1);
      }
      if (blink > 0) blink = Math.max(0, blink - dt / 0.17);
      var shut = blink > 0 ? Math.sin(Math.PI * Math.pow(1 - blink, 0.6)) : 0;
      var open = spring(s.open, m.open, 130, 0.7, dt) * (1 - shut * 0.95);

      // Mouth. With a live audio level it follows the sound; otherwise stream
      // energy from pulse() shapes irregular syllables.
      talk = Math.max(0, talk - dt * 2.6);
      var target;
      if (level >= 0) target = Math.min(1, level * 1.6);
      else {
        var syll = Math.abs(Math.sin(t * 17.3) * 0.6 + Math.sin(t * 11.1 + 1.3) * 0.4);
        target = talk > 0.04 ? Math.min(1, talk) * (0.25 + 0.75 * syll) : 0;
      }
      mouth += (target - mouth) * Math.min(1, dt * 28);

      // Gestures. Cheer: anticipation (crouch), hop, squash on landing, settle.
      var hopY = 0, squash = 0;
      if (cheerT >= 0) {
        cheerT += dt;
        var c = cheerT;
        if (c < 0.14) squash = (c / 0.14) * 0.1;
        else if (c < 0.54) { var k = (c - 0.14) / 0.4; hopY = -26 * Math.sin(Math.PI * k); squash = -0.08 * Math.sin(Math.PI * k); }
        else if (c < 0.68) squash = 0.12 * (1 - (c - 0.54) / 0.14);
        else if (c > 1.5) cheerT = -1;
      }
      var wave = 0;
      if (waveT >= 0) { waveT += dt; wave = waveT < 1.3 ? 1 : 0; if (waveT > 1.6) waveT = -1; }
      var nod = 0;
      if (nodT >= 0) { nodT += dt; nod = Math.sin(nodT * 14) * Math.max(0, 1 - nodT / 0.7) * 5; if (nodT > 0.8) nodT = -1; }

      var hy = spring(s.hop, hopY, 330, 0.62, dt);
      var sq = spring(s.squash, squash, 300, 0.6, dt);
      var smile = spring(s.happy, self.mood === "happy" || (cheerT >= 0 && cheerT < 1.3) ? 1 : 0, 170, 0.7, dt);
      var wv = spring(s.wave, wave, 120, 0.72, dt);

      var breath = Math.sin(t * 1.55 * m.breathe) * 0.014 * (0.6 + m.breathe * 0.4);
      var beat = mouth * 0.018; // the whole body gives a little with each syllable
      var tilt = spring(s.tilt, m.tilt + fx * 3 + Math.sin(t * 0.6) * 1, 48, 0.86, dt);
      var lift = spring(s.lift, m.lift + ey * 1.6 - mouth * 2 + nod, 80, 0.82, dt);
      var lean = spring(s.lean, m.lean + fx * 2.2 + Math.sin(t * 0.43) * 0.8, 26, 0.9, dt);
      var arm = spring(s.arm, m.arm, 60, 0.8, dt);
      var topE = spring(s.top, m.top, 30, 0.9, dt);

      var dTilt = (tilt - lastTilt) / Math.max(dt, 0.001);
      lastTilt = tilt;
      var hat = spring(s.hatLag, -dTilt * 0.25 - hy * 0.5 - lean * 0.6, 110, 0.78, dt);

      hop.setAttribute("transform", "translate(0 " + hy.toFixed(2) + ")");
      each("body", function (p) { X(p, 0, 0, lean, 1 - breath * 0.5 + sq * 0.9 - beat * 0.5, 1 + breath - sq + beat); });
      each("head", function (p) { X(p, fx * 5.5, lift + ey * 2.2, tilt * 0.55); });
      each("socket", function (p) { X(p, 0, 0, 0, 1, Math.max(0.05, Math.min(1.16, open)) * (1 - smile)); p.node.style.opacity = smile > 0.6 ? 0 : 1; });
      each("pupil", function (p) { X(p, ex * p.r, ey * p.r * 0.9, 0); });
      each("smile", function (p) { p.node.setAttribute("opacity", smile > 0.6 ? 1 : 0); });
      each("mouth", function (p) { X(p, 0, 0, 0, 0.6 + mouth * 0.55, 0.02 + mouth * 1.3); p.node.style.opacity = mouth < 0.06 ? 0 : 1; });
      each("lip", function (p) { p.node.style.opacity = mouth < 0.06 ? 1 : 0; });
      each("wing", function (p, i) {
        var up = arm * -34 + Math.max(0, -hy) * -3.2 + (talk > 0.3 || level > 0.15 ? Math.sin(t * 7 + i * 2) * 5 : 0) + Math.sin(t * 1.55 + i) * 2.4;
        if (i === 1 && wv > 0.02) up = up * (1 - wv) + (-118 + Math.sin(t * 13) * 16) * wv;
        X(p, 0, 0, p.dir * -up);
      });
      each("hat", function (p) { X(p, 0, 0, hat + Math.sin(t * (1 + topE * 0.8)) * (1.2 + topE * 1.6), 1, 1 + Math.sin(t * 2.2) * 0.02 * topE); });

      // Thought bubbles while thinking or searching (the ambient layer).
      var dv = spring(s.dots, self.mood === "think" || self.mood === "search" ? 1 : 0, 60, 0.8, dt);
      dots.setAttribute("opacity", Math.max(0, Math.min(0.9, dv)).toFixed(2));
      if (dv > 0.02) {
        var cs = dots.childNodes;
        for (var i2 = 0; i2 < 3; i2++) cs[i2].setAttribute("transform", "translate(0 " + (Math.sin(t * 2.6 - i2 * 0.7) * 3.4).toFixed(2) + ") scale(" + (0.7 + 0.3 * Math.min(1, Math.max(0, dv * 3 - i2 * 0.6))).toFixed(2) + ")");
      }
    };

    this.set = function (mood) {
      if (!MOODS[mood] || mood === self.mood) return;
      if (mood === "happy") self.cheer();
      self.mood = mood;
      el.setAttribute("data-mood", mood);
    };
    this.pulse = function (v) { talk = Math.min(1.4, talk + (v || 0.5)); };
    // Live audio level 0..1 for real lip sync; pass -1 to hand back to pulse().
    this.level = function (v) { level = v; };
    this.cheer = function () { if (cheerT < 0) cheerT = 0; };
    this.wave = function () { if (waveT < 0) waveT = 0; };
    this.nod = function () { if (nodT < 0) nodT = 0; };
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
    if (reduce) {
      // A still drawing: one frame so every part sits in its pose, no boil.
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
    color: function (id) { return (DEFS[id] || DEFS.pip).color; },
    mount: function (el, id, opts) { return new Creature(el, id, opts); },
  };
})();
