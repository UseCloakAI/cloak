/* The companions: five hand-drawn creatures, rigged in SVG and animated in
   code. No image files, no generated art: every shape below was drawn by
   hand as a path, then given a skeleton (data-p parts with pivots).

   What makes them feel drawn rather than rendered:
   - line boil: the ink wobbles on a displacement map whose seed steps at
     ~7fps, the way hand-inked frames never quite line up;
   - gouache grain: speckle held inside each shape;
   - animation on principles, not tweens: anticipation before a hop, squash
     and stretch on landing, follow-through on ears, tails and the yuzu,
     overlapping action (nothing starts or stops on the same frame).

   Creatures.mount(el, "ember", { mood }) → { set(mood), pulse(n), cheer(), destroy() }
   Moods: idle | listen | think | talk | happy | care | sleep            */
(function () {
  "use strict";
  var INK = "#1C2B25";
  var uid = 0;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Shared bits. e(x, y) → an eye (solid ink, a glint, a happy arc, a lid).
  function eye(x, y, r, lid) {
    r = r || 5.5;
    return (
      '<g data-p="eye" data-o="' + x + "," + y + '">' +
      '<ellipse cx="' + x + '" cy="' + y + '" rx="' + r + '" ry="' + (r * 1.18).toFixed(1) + '" fill="' + INK + '"/>' +
      '<circle cx="' + (x + r * 0.32).toFixed(1) + '" cy="' + (y - r * 0.42).toFixed(1) + '" r="' + (r * 0.3).toFixed(1) + '" fill="#fff"/>' +
      "</g>" +
      '<path data-p="smile" d="M' + (x - r - 1) + " " + (y + 1.5) + " Q" + x + " " + (y - r - 2.5) + " " + (x + r + 1) + " " + (y + 1.5) + '" fill="none" stroke="' + INK + '" stroke-width="3" stroke-linecap="round" opacity="0"/>' +
      (lid ? '<path d="M' + (x - r - 2.5) + " " + (y - r * 0.2).toFixed(1) + " Q" + x + " " + (y - r * 1.5).toFixed(1) + " " + (x + r + 2.5) + " " + (y - r * 0.2).toFixed(1) + ' Z" data-p="lid" fill="' + lid + '" stroke="' + INK + '" stroke-width="2.4" stroke-linejoin="round"/>' : "")
    );
  }
  function brow(x1, y1, x2, y2) {
    return '<path data-p="brow" data-o="' + (x1 + x2) / 2 + "," + (y1 + y2) / 2 + '" d="M' + x1 + " " + y1 + " L" + x2 + " " + y2 + '" stroke="' + INK + '" stroke-width="2.6" stroke-linecap="round" fill="none"/>';
  }
  var S = 'stroke="' + INK + '" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"';
  var L = 'fill="none" stroke="' + INK + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';

  var DEFS = {
    /* ── Ember, the fox ─────────────────────────────────────────────── */
    ember: {
      tint: "#F3C9A8",
      svg: function () {
        var O = "#DA6A3A", OD = "#B9502A", C = "#FBEEDD", B = "#3A2A24";
        return (
          '<g data-p="tail" data-o="150,196">' +
          '<path d="M148 198 C186 210 220 184 212 146 C208 126 188 120 180 134 C190 150 180 170 150 172 Z" fill="' + O + '" ' + S + "/>" +
          '<path d="M212 146 C208 126 188 120 180 134 C186 142 188 152 185 160 C196 162 208 158 212 146 Z" fill="' + C + '" ' + S + "/>" +
          "</g>" +
          '<g data-p="body" data-o="120,208">' +
          '<path d="M86 208 C78 166 96 136 120 136 C144 136 162 166 154 208 Z" fill="' + O + '" ' + S + "/>" +
          '<path d="M104 207 C100 180 108 160 120 160 C132 160 140 180 136 207 Z" fill="' + C + '"/>' +
          '<path d="M112 176 l4 5 l4 -5 l4 5 l4 -5" ' + L + ' opacity=".35"/>' +
          '<ellipse cx="104" cy="205" rx="10" ry="6.5" fill="' + B + '" ' + S + "/>" +
          '<ellipse cx="136" cy="205" rx="10" ry="6.5" fill="' + B + '" ' + S + "/>" +
          '<g data-p="head" data-o="120,142">' +
          '<g data-p="ear" data-o="92,76" data-dir="-1"><path d="M80 88 L72 36 L114 66 Z" fill="' + O + '" ' + S + '/><path d="M84 74 L80 50 L99 64 Z" fill="' + B + '"/></g>' +
          '<g data-p="ear" data-o="148,76" data-dir="1"><path d="M160 88 L168 36 L126 66 Z" fill="' + O + '" ' + S + '/><path d="M156 74 L160 50 L141 64 Z" fill="' + B + '"/></g>' +
          '<path d="M120 62 C152 62 174 82 172 104 C171 116 161 123 151 129 C142 139 131 149 120 149 C109 149 98 139 89 129 C79 123 69 116 68 104 C66 82 88 62 120 62 Z" fill="' + O + '" ' + S + "/>" +
          '<path d="M69 106 C76 124 98 141 120 148 C113 133 106 118 102 105 C92 112 80 112 69 106 Z" fill="' + C + '"/>' +
          '<path d="M171 106 C164 124 142 141 120 148 C127 133 134 118 138 105 C148 112 160 112 171 106 Z" fill="' + C + '"/>' +
          '<path d="M108 66 C114 76 126 76 132 66" ' + L + ' opacity=".28"/>' +
          '<ellipse data-p="mouth" data-o="120,137" cx="120" cy="141" rx="5.5" ry="5" fill="#7A2A26" stroke="' + INK + '" stroke-width="2"/>' +
          '<path d="M120 132 V137 M111 136.5 Q115.5 142 120 137 Q124.5 142 129 136.5" ' + L + "/>" +
          '<path d="M112 124 Q120 120 128 124 Q125 133.5 120 133.5 Q115 133.5 112 124 Z" fill="' + INK + '"/>' +
          eye(99, 103, 5.6) + eye(141, 103, 5.6) +
          brow(90, 91, 104, 89) + brow(150, 91, 136, 89) +
          '<circle cx="86" cy="118" r="1.3" fill="' + OD + '"/><circle cx="91" cy="123" r="1.3" fill="' + OD + '"/><circle cx="154" cy="118" r="1.3" fill="' + OD + '"/><circle cx="149" cy="123" r="1.3" fill="' + OD + '"/>' +
          "</g></g>"
        );
      },
    },

    /* ── Pip, the wren ──────────────────────────────────────────────── */
    pip: {
      tint: "#F6DFA6",
      svg: function () {
        var BR = "#B9793A", BD = "#8E5626", C = "#FBEFD2", Y = "#EBA637";
        return (
          '<path d="M106 190 V209 M98 211 L106 207 L114 211 M134 190 V209 M126 211 L134 207 L142 211" ' + L + ' stroke-width="3"/>' +
          '<g data-p="tail" data-o="150,160">' +
          '<path d="M146 164 C150 136 160 110 172 90 C182 94 189 102 191 112 C183 132 174 152 164 172 Z" fill="' + BD + '" ' + S + "/>" +
          '<path d="M160 122 l16 8 M156 136 l15 8 M151 150 l14 8" ' + L + ' opacity=".55"/>' +
          "</g>" +
          '<g data-p="body" data-o="118,198">' +
          '<path d="M118 92 C152 92 172 120 170 150 C168 182 146 198 118 198 C88 198 66 180 66 148 C66 118 86 92 118 92 Z" fill="' + BR + '" ' + S + "/>" +
          '<path d="M108 198 C82 196 72 172 80 154 C88 138 110 136 124 146 C140 158 138 190 108 198 Z" fill="' + C + '"/>' +
          '<path d="M92 170 q4 4 8 0 M106 178 q4 4 8 0 M96 184 q4 4 8 0" ' + L + ' opacity=".3"/>' +
          '<g data-p="wing" data-o="142,134">' +
          '<path d="M140 128 C164 132 174 158 162 182 C146 180 132 160 140 128 Z" fill="' + BD + '" ' + S + "/>" +
          '<path d="M148 146 q8 4 10 14 M144 156 q7 5 9 14" ' + L + ' opacity=".5"/>' +
          "</g>" +
          '<g data-p="head" data-o="114,150">' +
          '<path d="M112 92 C108 82 112 76 116 74 C116 82 120 86 124 92" fill="' + BD + '" ' + S + "/>" +
          '<path d="M80 116 Q94 106 108 114" fill="none" stroke="' + C + '" stroke-width="5" stroke-linecap="round"/>' +
          '<path d="M120 114 Q134 106 148 116" fill="none" stroke="' + C + '" stroke-width="5" stroke-linecap="round"/>' +
          '<g data-p="jaw" data-o="113,141" data-rot="26"><path d="M106 141 L120 141 L113 151 Z" fill="' + BD + '" ' + S + "/></g>" +
          '<path d="M103 140 Q113 131 123 140 L113 147 Z" fill="' + Y + '" ' + S + "/>" +
          eye(95, 127, 5.4) + eye(131, 127, 5.4) +
          '<ellipse cx="84" cy="140" rx="6" ry="4" fill="#E98B6A" opacity=".55"/><ellipse cx="143" cy="140" rx="6" ry="4" fill="#E98B6A" opacity=".55"/>' +
          "</g></g>"
        );
      },
    },

    /* ── Moss, the tortoise ─────────────────────────────────────────── */
    moss: {
      tint: "#D5E2C4",
      svg: function () {
        var G = "#7FA06A", GD = "#587A4B", SK = "#C9C77E", SKD = "#A9A85F", LF = "#4F9A5B";
        return (
          '<path d="M96 196 h26 v10 a8 8 0 0 1 -8 8 h-10 a8 8 0 0 1 -8 -8 Z M172 196 h26 v10 a8 8 0 0 1 -8 8 h-10 a8 8 0 0 1 -8 -8 Z" fill="' + SKD + '" ' + S + "/>" +
          '<g data-p="head" data-o="92,186">' +
          '<path d="M78 190 C66 176 60 160 62 142 L88 140 C90 158 96 172 106 184 Z" fill="' + SK + '" ' + S + "/>" +
          '<path d="M70 160 q8 3 16 0 M74 172 q8 3 15 0" ' + L + ' opacity=".3"/>' +
          '<g data-p="skull" data-o="74,140">' +
          '<path d="M36 124 C36 106 52 94 72 94 C92 94 104 108 104 124 C104 142 90 152 70 152 C50 152 36 142 36 124 Z" fill="' + SK + '" ' + S + "/>" +
          '<path data-p="mouth" data-wide="1" data-o="64,137" d="M44 136 Q64 147 90 136 Q80 153 64 152 Q50 151 44 136 Z" fill="#7A2A26" stroke="' + INK + '" stroke-width="2"/>' +
          '<path d="M40 134 Q62 147 94 134" ' + L + "/>" +
          '<path d="M46 122 l1 3 M52 121 l1 3" ' + L + ' stroke-width="2"/>' +
          eye(60, 116, 5, SK) + eye(86, 114, 5, SK) +
          '<ellipse cx="94" cy="128" rx="5" ry="3.4" fill="#D98F6E" opacity=".5"/>' +
          "</g></g>" +
          '<g data-p="body" data-o="146,206">' +
          '<path d="M76 196 C74 142 110 108 150 108 C192 108 220 144 218 196 Z" fill="' + G + '" ' + S + "/>" +
          '<path d="M124 124 L150 116 L176 126 L182 152 L150 162 L118 150 Z M118 150 L92 160 L84 190 M182 152 L206 164 L212 190 M150 162 L148 194 M124 124 L104 132 M176 126 L196 138" ' + L + ' stroke="' + GD + '" stroke-width="3"/>' +
          '<path d="M130 132 q6 -4 14 -4 M160 136 q8 0 12 6" ' + L + ' opacity=".3"/>' +
          '<path d="M68 196 H222 a7 7 0 0 1 0 14 H68 a7 7 0 0 1 0 -14 Z" fill="' + GD + '" ' + S + "/>" +
          '<g data-p="hat" data-o="150,110">' +
          '<path d="M150 111 C150 100 149 92 151 84" ' + L + ' stroke="#3F6A3E" stroke-width="3"/>' +
          '<path d="M151 92 C140 92 132 84 132 74 C144 74 151 80 151 92 Z" fill="' + LF + '" ' + S + "/>" +
          '<path d="M151 86 C162 88 172 80 174 68 C160 66 151 74 151 86 Z" fill="' + LF + '" ' + S + "/>" +
          "</g></g>"
        );
      },
    },

    /* ── Juno, the otter ────────────────────────────────────────────── */
    juno: {
      tint: "#E6D3BF",
      svg: function () {
        var B = "#8F6B4E", BD = "#6D4E38", C = "#F3E3CC", P = "#9FB0B4";
        return (
          '<g data-p="tail" data-o="98,198"><path d="M104 204 C74 214 44 202 34 176 C52 186 78 184 98 174 Z" fill="' + BD + '" ' + S + "/></g>" +
          '<path d="M96 204 q-10 0 -14 8 h26 Z M144 204 q10 0 14 8 h-26 Z" fill="' + BD + '" ' + S + "/>" +
          '<g data-p="body" data-o="120,210">' +
          '<path d="M88 208 C80 168 88 118 120 114 C152 118 160 168 152 208 Z" fill="' + B + '" ' + S + "/>" +
          '<path d="M102 206 C96 176 102 140 120 138 C138 140 144 176 138 206 Z" fill="' + C + '"/>' +
          '<g data-p="arm" data-o="120,150">' +
          '<path d="M92 146 C96 162 106 170 118 168" fill="none" stroke="' + INK + '" stroke-width="15" stroke-linecap="round"/>' +
          '<path d="M148 146 C144 162 134 170 122 168" fill="none" stroke="' + INK + '" stroke-width="15" stroke-linecap="round"/>' +
          '<path d="M92 146 C96 162 106 170 118 168" fill="none" stroke="' + B + '" stroke-width="9.5" stroke-linecap="round"/>' +
          '<path d="M148 146 C144 162 134 170 122 168" fill="none" stroke="' + B + '" stroke-width="9.5" stroke-linecap="round"/>' +
          '<path d="M106 166 C106 156 114 152 122 153 C131 154 136 160 134 168 C132 176 110 176 106 166 Z" fill="' + P + '" ' + S + "/>" +
          '<path d="M114 160 q5 -3 10 -1" ' + L + ' opacity=".4"/>' +
          "</g>" +
          '<g data-p="head" data-o="120,124">' +
          '<g data-p="ear" data-o="88,80" data-dir="-1"><circle cx="84" cy="74" r="9" fill="' + B + '" ' + S + '/><circle cx="85" cy="75" r="3.6" fill="' + BD + '"/></g>' +
          '<g data-p="ear" data-o="152,80" data-dir="1"><circle cx="156" cy="74" r="9" fill="' + B + '" ' + S + '/><circle cx="155" cy="75" r="3.6" fill="' + BD + '"/></g>' +
          '<path d="M120 60 C150 60 164 78 164 98 C164 120 144 132 120 132 C96 132 76 120 76 98 C76 78 90 60 120 60 Z" fill="' + B + '" ' + S + "/>" +
          '<path d="M120 94 C138 94 148 102 148 112 C148 124 136 131 120 131 C104 131 92 124 92 112 C92 102 102 94 120 94 Z" fill="' + C + '"/>' +
          '<ellipse data-p="mouth" data-o="120,115" cx="120" cy="119" rx="6" ry="5" fill="#7A2A26" stroke="' + INK + '" stroke-width="2"/>' +
          '<path d="M120 109 V114 M110 113.5 Q115 120 120 114 Q125 120 130 113.5" ' + L + "/>" +
          '<path d="M110 98 Q120 94 130 98 Q128 110 120 110 Q112 110 110 98 Z" fill="' + INK + '"/>' +
          '<path d="M96 108 l-16 -4 M96 113 l-17 2 M96 118 l-15 7 M144 108 l16 -4 M144 113 l17 2 M144 118 l15 7" ' + L + ' stroke-width="1.6" opacity=".7"/>' +
          eye(99, 88, 4.6) + eye(141, 88, 4.6) +
          brow(92, 77, 104, 76) + brow(148, 77, 136, 76) +
          "</g></g>"
        );
      },
    },

    /* ── Sol, the capybara ──────────────────────────────────────────── */
    sol: {
      tint: "#EAD4B4",
      svg: function () {
        var T = "#C2945F", TD = "#9C7245", TL = "#D6AE7C", Y = "#F0A73A";
        return (
          '<g data-p="body" data-o="126,208">' +
          '<path d="M64 208 C54 160 84 124 132 124 C184 124 212 160 202 208 Z" fill="' + T + '" ' + S + "/>" +
          '<path d="M150 140 q14 4 22 16 M164 166 q8 6 10 16 M136 150 q8 6 10 14" ' + L + ' opacity=".28"/>' +
          '<path d="M84 200 h22 v6 a7 7 0 0 1 -7 7 h-8 a7 7 0 0 1 -7 -7 Z M128 200 h22 v6 a7 7 0 0 1 -7 7 h-8 a7 7 0 0 1 -7 -7 Z" fill="' + TD + '" ' + S + "/>" +
          '<g data-p="head" data-o="104,176">' +
          '<g data-p="ear" data-o="70,92" data-dir="-1"><ellipse cx="66" cy="88" rx="8" ry="10" fill="' + TD + '" ' + S + "/></g>" +
          '<g data-p="ear" data-o="130,92" data-dir="1"><ellipse cx="134" cy="88" rx="8" ry="10" fill="' + TD + '" ' + S + "/></g>" +
          '<path d="M40 148 C36 110 60 84 100 84 C140 84 158 110 156 142 C154 168 132 182 98 182 C64 182 42 172 40 148 Z" fill="' + T + '" ' + S + "/>" +
          '<path d="M48 152 C48 138 62 130 82 130 C104 130 118 140 118 154 C118 170 102 178 82 178 C62 178 48 168 48 152 Z" fill="' + TL + '"/>' +
          '<path data-p="mouth" data-wide="1" data-o="82,162" d="M68 161 Q82 169 98 161 Q92 174 82 174 Q73 174 68 161 Z" fill="#7A2A26" stroke="' + INK + '" stroke-width="2"/>' +
          '<path d="M64 159 Q82 170 102 159" ' + L + "/>" +
          '<path d="M70 142 q2 5 6 4 M90 142 q2 5 6 4" ' + L + "/>" +
          eye(70, 118, 4.6, T) + eye(116, 116, 4.6, T) +
          '<ellipse cx="128" cy="134" rx="7" ry="4.4" fill="#DE8E6C" opacity=".5"/>' +
          '<g data-p="hat" data-o="98,86">' +
          '<circle cx="98" cy="72" r="14" fill="' + Y + '" ' + S + "/>" +
          '<path d="M90 66 q5 -4 10 -3" ' + L + ' opacity=".4" stroke="#fff"/>' +
          '<path d="M98 58 C100 50 108 46 116 48 C114 56 106 60 98 58 Z" fill="#5D9A55" ' + S + "/>" +
          "</g></g></g>"
        );
      },
    },
  };

  /* A soft, slightly irregular blob behind each creature, in its tint. */
  var BLOB = "M120 14 C176 10 226 48 228 112 C230 172 190 226 122 228 C56 230 12 184 12 120 C12 60 62 18 120 14 Z";

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
  function sv() {
    return { x: 0, v: 0 };
  }

  var MOODS = {
    idle: { tilt: 0, lift: 0, lookX: 0, lookY: 0, open: 1, brow: 0, ear: 0, tail: 1, breathe: 1 },
    listen: { tilt: 6, lift: -2.5, lookX: 0, lookY: 0.2, open: 1.12, brow: -1.5, ear: 1, tail: 1.4, breathe: 1 },
    think: { tilt: -6, lift: -1, lookX: 0.8, lookY: -0.9, open: 0.9, brow: -2.5, ear: 0.3, tail: 0.5, breathe: 0.8 },
    talk: { tilt: 0, lift: -1, lookX: 0, lookY: 0, open: 1, brow: -1, ear: 0.4, tail: 1.2, breathe: 1.1 },
    happy: { tilt: 4, lift: -3, lookX: 0, lookY: 0, open: 1, brow: -2, ear: 1, tail: 2.6, breathe: 1.2 },
    care: { tilt: -4, lift: 2, lookX: 0, lookY: 0.4, open: 0.82, brow: 1.2, ear: -0.6, tail: 0.4, breathe: 0.7 },
    sleep: { tilt: 8, lift: 4, lookX: 0, lookY: 0.6, open: 0.06, brow: 0.5, ear: -0.8, tail: 0.2, breathe: 0.55 },
  };

  function Creature(el, id, opts) {
    opts = opts || {};
    var def = DEFS[id] || DEFS.pip;
    var n = ++uid;
    var fid = "cr-ink-" + n;
    var backdrop = opts.backdrop !== false;
    el.innerHTML =
      '<svg viewBox="0 0 240 240" role="img" aria-label="' + (opts.label || id) + '" style="display:block;width:100%;height:100%;overflow:visible">' +
      "<defs>" +
      '<filter id="' + fid + '" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.028" numOctaves="2" seed="2" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="3.4" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="9" result="g"/>' +
      '<feColorMatrix in="g" type="matrix" values="0 0 0 0 0.1  0 0 0 0 0.14  0 0 0 0 0.12  0 0 0 -1.15 0.64" result="ga"/>' +
      '<feComposite in="ga" in2="d" operator="in" result="spk"/>' +
      '<feMerge><feMergeNode in="d"/><feMergeNode in="spk"/></feMerge>' +
      "</filter></defs>" +
      (backdrop ? '<path class="cr-blob" d="' + BLOB + '" fill="' + def.tint + '"/>' : "") +
      '<ellipse class="cr-shadow" cx="126" cy="214" rx="62" ry="7" fill="' + INK + '" opacity=".16"/>' +
      '<g class="cr-dots" opacity="0"><circle cx="186" cy="62" r="4" fill="' + INK + '"/><circle cx="200" cy="46" r="5.5" fill="' + INK + '"/><circle cx="218" cy="26" r="7.5" fill="' + INK + '"/></g>' +
      '<g class="cr-root" filter="url(#' + fid + ')"><g class="cr-hop">' + def.svg() + "</g></g>" +
      "</svg>";

    var svg = el.firstChild;
    var turb = svg.querySelector("feTurbulence");
    var hop = svg.querySelector(".cr-hop");
    var shadow = svg.querySelector(".cr-shadow");
    var dots = svg.querySelector(".cr-dots");
    var parts = {};
    svg.querySelectorAll("[data-p]").forEach(function (node) {
      var p = node.getAttribute("data-p");
      var o = (node.getAttribute("data-o") || "0,0").split(",").map(Number);
      (parts[p] = parts[p] || []).push({ node: node, ox: o[0], oy: o[1], dir: Number(node.getAttribute("data-dir") || 1), rot: Number(node.getAttribute("data-rot") || 18), wide: node.hasAttribute("data-wide") });
    });

    var self = this;
    this.el = el;
    this.mood = MOODS[opts.mood] ? opts.mood : "idle";
    this.visible = true;
    var t0 = Math.random() * 100;
    var s = { tilt: sv(), lift: sv(), lookX: sv(), lookY: sv(), open: sv(), brow: sv(), ear: sv(), tailAmp: sv(), hop: sv(), squash: sv(), dots: sv(), earKick: sv(), hatLag: sv(), happy: sv() };
    s.open.x = 1;
    s.tailAmp.x = 1;
    var blinkAt = 1 + Math.random() * 3;
    var blink = 0;
    var glanceAt = 2 + Math.random() * 4;
    var glance = { x: 0, y: 0 };
    var twitchAt = 3 + Math.random() * 5;
    var talk = 0;
    var mouth = 0;
    var cheerT = -1;
    var boilAt = 0;
    var seed = 2;
    var lastTilt = 0;

    function T(part, tx, ty, rot, sx, sy) {
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

      // Line boil: step the ink's noise seed like hand-inked frames.
      if (now > boilAt) {
        boilAt = now + 140;
        seed = seed >= 4 ? 2 : seed + 1;
        turb.setAttribute("seed", seed);
      }

      // Where to look: the pointer when it moved recently, else idle glances.
      var lx = m.lookX, ly = m.lookY;
      if (self.mood === "idle" || self.mood === "listen" || self.mood === "talk") {
        if (now - pointer.t < 2600) {
          var r = el.getBoundingClientRect();
          var dx = pointer.x - (r.left + r.width / 2), dy = pointer.y - (r.top + r.height * 0.42);
          var d = Math.max(140, Math.hypot(dx, dy));
          lx += (dx / d) * 1.1;
          ly += (dy / d) * 1.1;
        } else {
          if (t > glanceAt) {
            glanceAt = t + 1.6 + Math.random() * 4;
            glance = Math.random() < 0.35 ? { x: 0, y: 0 } : { x: Math.random() * 1.6 - 0.8, y: Math.random() * 0.8 - 0.3 };
          }
          lx += glance.x;
          ly += glance.y;
        }
      }
      lx = Math.max(-1.2, Math.min(1.2, lx));
      ly = Math.max(-1.2, Math.min(1.2, ly));
      // Eyes lead (snappy), the head follows (heavier): overlapping action.
      var ex = spring(s.lookX, lx, 190, 0.72, dt), ey = spring(s.lookY, ly, 190, 0.72, dt);

      // Blink: fast shut, slower open. Sometimes a double.
      if (t > blinkAt && blink <= 0) {
        blink = 1;
        blinkAt = t + (Math.random() < 0.18 ? 0.32 : 2.2 + Math.random() * 4.2) * (self.mood === "think" ? 1.5 : 1);
      }
      if (blink > 0) blink = Math.max(0, blink - dt / 0.17);
      var shut = blink > 0 ? Math.sin(Math.PI * Math.pow(1 - blink, 0.6)) : 0;
      var open = spring(s.open, m.open, 120, 0.7, dt) * (1 - shut * 0.94);

      // Talking: energy from pulse() decays; syllables are irregular on purpose.
      talk = Math.max(0, talk - dt * 2.6);
      var syll = Math.abs(Math.sin(t * 17.3) * 0.6 + Math.sin(t * 11.1 + 1.3) * 0.4);
      var mTarget = talk > 0.04 ? Math.min(1, talk) * (0.25 + 0.75 * syll) : 0;
      mouth += (mTarget - mouth) * Math.min(1, dt * 26);

      // Cheer: anticipation (crouch) → hop → squash on landing → settle.
      var hopY = 0, squash = 0;
      if (cheerT >= 0) {
        cheerT += dt;
        var c = cheerT;
        if (c < 0.14) squash = (c / 0.14) * 0.09;
        else if (c < 0.52) {
          var k = (c - 0.14) / 0.38;
          hopY = -22 * Math.sin(Math.PI * k);
          squash = -0.07 * Math.sin(Math.PI * k);
        } else if (c < 0.66) squash = 0.1 * (1 - (c - 0.52) / 0.14);
        else if (c > 1.5) cheerT = -1;
      }
      var hy = spring(s.hop, hopY, 320, 0.62, dt);
      var sq = spring(s.squash, squash, 300, 0.6, dt);
      var smile = spring(s.happy, self.mood === "happy" || (cheerT >= 0 && cheerT < 1.3) ? 1 : 0, 160, 0.7, dt);

      var breath = Math.sin(t * 1.55 * m.breathe) * 0.012 * (0.6 + m.breathe * 0.4);
      var tilt = spring(s.tilt, m.tilt + ex * 2.2 + Math.sin(t * 0.6) * 0.9, 46, 0.86, dt);
      var lift = spring(s.lift, m.lift + ey * 1.4 - mouth * 1.6, 70, 0.84, dt);
      var browY = spring(s.brow, m.brow, 110, 0.74, dt);

      // Ears, tail and hat trail the head: follow-through.
      var dTilt = (tilt - lastTilt) / Math.max(dt, 0.001);
      lastTilt = tilt;
      if (t > twitchAt) {
        twitchAt = t + 2.5 + Math.random() * 6;
        s.earKick.v += (Math.random() < 0.5 ? -1 : 1) * 160;
      }
      var kick = spring(s.earKick, 0, 220, 0.66, dt);
      var ear = spring(s.ear, m.ear, 90, 0.72, dt);
      var hat = spring(s.hatLag, -dTilt * 0.22 - hy * 0.35, 120, 0.8, dt);
      var tailAmp = spring(s.tailAmp, m.tail, 30, 0.9, dt);
      var tail = Math.sin(t * (1.3 + tailAmp * 0.9)) * (3 + tailAmp * 3.4) + Math.sin(t * 0.47) * 2;

      hop.setAttribute("transform", "translate(0 " + hy.toFixed(2) + ")");
      shadow.setAttribute("transform", "translate(126 214) scale(" + (1 + hy / 70).toFixed(3) + " 1) translate(-126 -214)");
      each("body", function (p) { T(p, 0, 0, 0, 1 - breath * 0.5 + sq * 0.9, 1 + breath - sq); });
      each("head", function (p) { T(p, ex * 1.6, lift + breath * -30, tilt); });
      each("skull", function (p) { T(p, ex * 1.2, 0, tilt * 0.5); });
      each("eye", function (p) { T(p, ex * 2.6, ey * 2.2, 0, 1, Math.max(0.06, open) * (1 - smile)); p.node.style.opacity = smile > 0.6 ? 0 : 1; });
      each("smile", function (p) { p.node.setAttribute("opacity", smile > 0.6 ? 1 : 0); });
      each("lid", function (p) { T(p, ex * 1.4, ey * 1.2 + (1 - Math.min(1, open)) * 4.4, 0); });
      each("brow", function (p, i) { T(p, ex * 1.2, browY + (self.mood === "think" && i === 0 ? -2.4 : 0), self.mood === "care" ? (i ? 9 : -9) : 0); });
      each("mouth", function (p) { T(p, 0, 0, 0, p.wide ? 1 : 0.7 + mouth * 0.5, 0.04 + mouth * (p.wide ? 1 : 1.25)); p.node.style.opacity = mouth < 0.05 ? 0 : 1; });
      each("jaw", function (p) { T(p, 0, mouth * 1.2, mouth * p.rot); });
      each("ear", function (p) { T(p, 0, 0, p.dir * (ear * -7 + kick * 0.06) - dTilt * 0.05, 1, 1); });
      each("tail", function (p) { T(p, 0, 0, tail); });
      each("wing", function (p) { T(p, 0, 0, Math.max(0, -hy) * 2.6 + Math.sin(t * 1.55) * 1.4 + (talk > 0.3 ? Math.sin(t * 9) * 2 : 0)); });
      each("arm", function (p) { T(p, 0, Math.sin(t * 1.55 + 0.6) * 1.4 - mouth * 1.2, Math.sin(t * 0.9) * 2.2); });
      each("hat", function (p) { T(p, 0, 0, hat + Math.sin(t * 1.1) * 1.6); });

      // Thought dots rise one after another while thinking (ambient layer).
      var dv = spring(s.dots, self.mood === "think" ? 1 : 0, 60, 0.8, dt);
      dots.setAttribute("opacity", Math.max(0, Math.min(0.5, dv * 0.5)).toFixed(2));
      if (dv > 0.02) {
        var cs = dots.childNodes;
        for (var i = 0; i < 3; i++) cs[i].setAttribute("transform", "translate(0 " + (Math.sin(t * 2.4 - i * 0.7) * 3).toFixed(2) + ")");
      }
    };

    this.set = function (mood) {
      if (!MOODS[mood] || mood === self.mood) return;
      if (mood === "happy") self.cheer();
      self.mood = mood;
      el.setAttribute("data-mood", mood);
    };
    this.pulse = function (n) {
      talk = Math.min(1.4, talk + (n || 0.5));
    };
    this.cheer = function () {
      if (cheerT < 0) cheerT = 0;
    };
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
      // Still drawing, no motion: one frame so every part sits in its pose.
      this.frame(0, 0.016);
      svg.querySelector(".cr-root").removeAttribute("filter");
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
  function start() {
    if (!raf) raf = requestAnimationFrame(tick);
  }
  window.addEventListener("pointermove", function (e) { pointer.x = e.clientX; pointer.y = e.clientY; pointer.t = performance.now(); }, { passive: true });

  window.Creatures = {
    ids: Object.keys(DEFS),
    tint: function (id) { return (DEFS[id] || DEFS.pip).tint; },
    mount: function (el, id, opts) { return new Creature(el, id, opts); },
  };
})();
