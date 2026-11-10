/* The ledger chart: cumulative CO2e emitted (estimated) against carbon removed
   (verified receipts) and the 10x pledge. Hand-built SVG, no chart library.
   ImpactChart.draw(el, data, { compact }) — data is GET /v1/impact. */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 3 ? 3 : m <= 4 ? 4 : m <= 5 ? 5 : m <= 8 ? 8 : 10) * p;
  }

  function series(data) {
    var e = 0, p = 0, r = 0;
    var byDay = {};
    (data.offsets || []).forEach(function (o) { byDay[o.day] = (byDay[o.day] || 0) + o.kg; });
    var first = data.days.length ? data.days[0].day : "";
    // Credits retired before the window still count toward the running total.
    Object.keys(byDay).forEach(function (d) { if (d < first) r += byDay[d]; });
    var mult = (data.method && data.method.offset_multiple) || 10;
    return data.days.map(function (d) {
      e += d.emitted_kg;
      p = e * mult;
      r += byDay[d.day] || 0;
      return { day: d.day, emitted: e, pledge: p, removed: r, replies: d.replies };
    });
  }

  function draw(host, data, opts) {
    opts = opts || {};
    var pts = series(data);
    host.innerHTML = "";
    if (pts.length < 2) {
      host.innerHTML = '<p class="muted" style="padding:28px 0">The ledger starts with the first reply. Nothing to plot yet.</p>';
      return;
    }
    var W = host.clientWidth || 720;
    // Too narrow for end labels: drop them and print a legend underneath.
    var narrow = W < 520 && !opts.compact;
    if (narrow) opts = { compact: true };
    var H = opts.compact ? 220 : Math.max(300, Math.min(440, W * 0.46));
    var m = { t: 18, r: opts.compact ? 16 : 132, b: 30, l: opts.compact ? 16 : 54 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var last = pts[pts.length - 1];
    var ymax = niceMax(Math.max(last.pledge, last.removed, last.emitted) * 1.05);
    var x = function (i) { return m.l + (i / (pts.length - 1)) * iw; };
    var y = function (v) { return m.t + ih - (v / ymax) * ih; };

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": "Cumulative carbon emitted, estimated, against carbon removed and the ten times pledge" }, host);
    svg.style.display = "block";
    svg.style.overflow = "visible";

    // Grid: three quiet lines, labelled on the left.
    for (var g = 0; g <= 2; g++) {
      var v = (ymax / 2) * g, gy = y(v);
      el("line", { x1: m.l, x2: m.l + iw, y1: gy, y2: gy, stroke: "var(--line)", "stroke-width": 1 }, svg);
      if (!opts.compact) {
        var t = el("text", { x: m.l - 10, y: gy + 4, "text-anchor": "end", fill: "var(--ink-3)", "font-size": 12, "font-family": "var(--fm)" }, svg);
        t.textContent = Kit.fmtCO2(v);
      }
    }
    [0, pts.length - 1].forEach(function (i) {
      var t = el("text", { x: x(i), y: H - 8, "text-anchor": i ? "end" : "start", fill: "var(--ink-3)", "font-size": 12, "font-family": "var(--fm)" }, svg);
      t.textContent = new Date(pts[i].day + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    });

    function path(key, step) {
      var d = "";
      pts.forEach(function (p, i) {
        if (!i) d += "M" + x(i).toFixed(1) + " " + y(p[key]).toFixed(1);
        else if (step) d += " H" + x(i).toFixed(1) + " V" + y(p[key]).toFixed(1);
        else d += " L" + x(i).toFixed(1) + " " + y(p[key]).toFixed(1);
      });
      return d;
    }
    var base = " L" + x(pts.length - 1).toFixed(1) + " " + y(0) + " L" + x(0).toFixed(1) + " " + y(0) + " Z";

    el("path", { d: path("removed", true) + base, fill: "var(--good)", opacity: 0.16 }, svg);
    el("path", { d: path("pledge"), fill: "none", stroke: "var(--ink-3)", "stroke-width": 1.5, "stroke-dasharray": "4 5" }, svg);
    var lr = el("path", { d: path("removed", true), fill: "none", stroke: "var(--good)", "stroke-width": 2.5, "stroke-linejoin": "round" }, svg);
    el("path", { d: path("emitted") + base, fill: "var(--warn)", opacity: 0.2 }, svg);
    var le = el("path", { d: path("emitted"), fill: "none", stroke: "var(--warn)", "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);

    // Draw-on: lines trace left to right once, when first shown.
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      [lr, le].forEach(function (p, i) {
        var len = p.getTotalLength();
        p.style.strokeDasharray = len;
        p.style.strokeDashoffset = len;
        p.getBoundingClientRect();
        p.style.transition = "stroke-dashoffset 1100ms cubic-bezier(.2,.8,.2,1) " + i * 160 + "ms";
        p.style.strokeDashoffset = 0;
      });
    }

    // Direct labels at the line ends (no legend to decode).
    if (!opts.compact) {
      var labels = [
        { v: last.removed, name: "Removed", sub: Kit.fmtCO2(last.removed), color: "var(--good)" },
        { v: last.pledge, name: "10x pledge", sub: Kit.fmtCO2(last.pledge), color: "var(--ink-3)" },
        { v: last.emitted, name: "Emitted (est.)", sub: Kit.fmtCO2(last.emitted), color: "var(--warn)" },
      ].sort(function (a, b) { return y(a.v) - y(b.v); });
      var prev = -99;
      labels.forEach(function (l) {
        var ly = Math.max(y(l.v), prev + 36);
        prev = ly;
        var t = el("text", { x: m.l + iw + 12, y: ly + 1, fill: l.color, "font-size": 13, "font-weight": 600, "font-family": "var(--fb)" }, svg);
        t.textContent = l.name;
        var s = el("text", { x: m.l + iw + 12, y: ly + 17, fill: "var(--ink-2)", "font-size": 12, "font-family": "var(--fm)" }, svg);
        s.textContent = l.sub;
      });

      // Hover: a rule and a readout for the day under the pointer.
      var rule = el("line", { y1: m.t, y2: m.t + ih, stroke: "var(--line-2)", "stroke-width": 1, opacity: 0 }, svg);
      var tip = document.createElement("div");
      tip.className = "chart-tip";
      tip.hidden = true;
      host.style.position = "relative";
      host.appendChild(tip);
      var hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", function (ev) {
        var r = svg.getBoundingClientRect();
        var i = Math.max(0, Math.min(pts.length - 1, Math.round(((ev.clientX - r.left) * (W / r.width) - m.l) / iw * (pts.length - 1))));
        var p = pts[i];
        rule.setAttribute("x1", x(i)); rule.setAttribute("x2", x(i)); rule.setAttribute("opacity", 1);
        tip.hidden = false;
        tip.innerHTML = "<b>" + new Date(p.day + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) + "</b>" +
          "<span><i style=\"background:var(--warn)\"></i>Emitted " + Kit.fmtCO2(p.emitted) + "</span>" +
          "<span><i style=\"background:var(--good)\"></i>Removed " + Kit.fmtCO2(p.removed) + "</span>" +
          "<span class=\"muted\">" + Kit.fmtN(p.replies) + " replies that day</span>";
        var left = x(i) * (r.width / W);
        tip.style.left = Math.max(0, Math.min(r.width - 190, left + 14)) + "px";
        tip.style.top = m.t + 6 + "px";
      });
      hit.addEventListener("pointerleave", function () { rule.setAttribute("opacity", 0); tip.hidden = true; });
    }
    if (narrow) {
      var lg = document.createElement("p");
      lg.style.cssText = "display:flex;flex-wrap:wrap;gap:4px 14px;margin:8px 0 0;font-size:.8rem;color:var(--ink-2)";
      lg.innerHTML = '<span><b style="color:var(--good)">Removed</b> ' + Kit.fmtCO2(last.removed) + '</span><span><b style="color:var(--warn)">Emitted (est.)</b> ' + Kit.fmtCO2(last.emitted) + '</span><span><b>10x pledge</b> ' + Kit.fmtCO2(last.pledge) + " (dashed)</span>";
      host.appendChild(lg);
    }
  }

  window.ImpactChart = {
    draw: function (host, data, opts) {
      draw(host, data, opts);
      // Redraw on resize so text never scales.
      if (host._ro) host._ro.disconnect();
      if ("ResizeObserver" in window) {
        var w = host.clientWidth, t;
        host._ro = new ResizeObserver(function () {
          if (Math.abs(host.clientWidth - w) < 8) return;
          w = host.clientWidth;
          clearTimeout(t);
          t = setTimeout(function () { draw(host, data, opts); }, 120);
        });
        host._ro.observe(host);
      }
    },
    series: series,
  };
})();
