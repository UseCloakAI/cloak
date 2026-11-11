/* Kit runtime: the wordmark, light/dark, icons, entrances, API base, and the
   companion data the pages share. Loaded on every preview page. */
(function () {
  "use strict";
  var LS = window.localStorage;
  function get(k) { try { return LS.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { LS.setItem(k, v); } catch (e) {} }

  /* ── Brand. The logo is CL(O)AK: the O is a hand-drawn orb with two dot
     eyes that watches the pointer and blinks. Blinks is the product: a
     handwritten word after the wordmark, like a pen note in a margin. */
  var BRANDS = { "Cloak Blinks": { tag: "AI that looks you in the eye." } };
  var brand = "Cloak Blinks";
  var MARK =
    '<span class="o" aria-hidden="true"><svg viewBox="0 0 40 40">' +
    '<path d="M20 3.5 C30 3 37 10.5 36.6 20.4 C36.2 30.4 29.4 36.8 19.6 36.5 C10 36.2 3.2 29.6 3.5 19.8 C3.8 10.6 10.6 4 20 3.5 Z" fill="var(--accent)" stroke="var(--ink)" stroke-width="3.6" stroke-linejoin="round"/>' +
    '<g class="o-eyes"><ellipse cx="14.2" cy="19" rx="2.5" ry="3.6" fill="#0A0A0A"/><ellipse cx="25.8" cy="19" rx="2.5" ry="3.6" fill="#0A0A0A"/></g>' +
    "</svg></span>";


  function applyBrand() {
    document.querySelectorAll("[data-brand]").forEach(function (el) {
      el.innerHTML = "Cl" + MARK + 'ak<span class="sub">blinks</span>';
      el.setAttribute("aria-label", "Cloak Blinks");
    });
    document.querySelectorAll("[data-brand-tag]").forEach(function (el) { el.textContent = BRANDS[brand].tag; });
    document.querySelectorAll("[data-brand-o]").forEach(function (el) { el.outerHTML = MARK; });
  }

  // Every O on the page looks toward the pointer. One rAF per move, no loop.
  var eyeRaf = 0, px = 0, py = 0;
  function lookAt() {
    eyeRaf = 0;
    document.querySelectorAll(".o-eyes").forEach(function (g) {
      var r = g.ownerSVGElement.getBoundingClientRect();
      var dx = px - (r.left + r.width / 2), dy = py - (r.top + r.height / 2);
      var d = Math.max(60, Math.hypot(dx, dy));
      g.style.translate = ((dx / d) * 4.2).toFixed(2) + "px " + ((dy / d) * 3.4).toFixed(2) + "px";
    });
  }
  window.addEventListener("pointermove", function (e) { px = e.clientX; py = e.clientY; if (!eyeRaf) eyeRaf = requestAnimationFrame(lookAt); }, { passive: true });

  /* ── Mode: follows the system until the person chooses. ─────────── */
  function mode() {
    var m = get("pv_mode");
    if (m === "dark" || m === "light") return m;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyMode() {
    var m = mode();
    document.documentElement.setAttribute("data-mode", m);
    document.querySelectorAll("[data-mode-toggle] use").forEach(function (u) { u.setAttribute("href", "icons.svg#" + (m === "dark" ? "sun" : "moon")); });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", m === "dark" ? "#131110" : "#F2EEE5");
  }

  /* ── API base. Override with ?api=… (remembered) for local work. ── */
  var q = new URLSearchParams(location.search).get("api");
  if (q) set("pv_api", q);
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var api = (get("pv_api") || (local ? "http://localhost:8787" : "https://blinks-api.usecloak.org")).replace(/\/+$/, "");

  /* ── The built-in Blink (mirrors blinks-api/src/prompts.js). Everyone else
     is made by people in the app (maker.js). ─────────────────────────── */
  var COMPANIONS = [
    { id: "cloak", name: "Cloak", role: "Your Blink", lane: "Auto", line: "The O from the logo, awake.", about: "Texts back fast, keeps it short, and goes long only when it is worth it. Searches, builds, remembers, and tells you straight.", hello: "Hey. What's up?", starters: ["Plan my week around three deadlines", "Explain how tides work, quickly", "Help me reply to this text without sounding mad"] },
  ];

  function icon(name, cls) {
    return '<svg class="ic' + (cls ? " " + cls : "") + '" viewBox="0 0 256 256" aria-hidden="true"><use href="icons.svg#' + name + '"/></svg>';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  // 0.0042 → "4.2 mWh"-style formatting for small physical quantities.
  function fmtWh(wh) {
    if (!(wh > 0)) return "0 Wh";
    if (wh < 1) return (wh * 1000).toFixed(wh < 0.01 ? 1 : 0) + " mWh";
    if (wh < 1000) return wh.toFixed(wh < 10 ? 2 : 1) + " Wh";
    return (wh / 1000).toFixed(2) + " kWh";
  }
  function fmtCO2(kg) {
    if (!(kg > 0)) return "0 g";
    var g = kg * 1000;
    if (g < 1) return (g * 1000).toFixed(0) + " mg";
    if (g < 1000) return g.toFixed(g < 10 ? 2 : 1) + " g";
    if (kg < 1000) return kg.toFixed(kg < 10 ? 2 : 1) + " kg";
    return (kg / 1000).toFixed(2) + " t";
  }
  function fmtN(n) {
    return Math.round(n).toLocaleString("en-US");
  }

  /* Sample ledger, used only when the preview API is unreachable. Shaped like
     GET /v1/impact and flagged sample:true so pages label it. */
  function sampleImpact() {
    var days = [], seed = 7, emitted = 0, funded = 0;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var now = Date.now();
    for (var i = 59; i >= 0; i--) {
      var growth = 1 + (59 - i) * 0.045;
      var replies = Math.round((900 + rnd() * 700) * growth);
      var e = replies * 0.00011 * (0.85 + rnd() * 0.3);
      var views = Math.round(replies * (0.5 + rnd() * 0.2));
      var f = e * 10;
      emitted += e; funded += f;
      days.push({ day: new Date(now - i * 864e5).toISOString().slice(0, 10), replies: replies, wh: e / 0.445 * 1000, emitted_kg: e, views: views, clicks: Math.round(views * 0.012), funded_kg: f });
    }
    var replies = days.reduce(function (a, d) { return a + d.replies; }, 0);
    var views = days.reduce(function (a, d) { return a + d.views; }, 0);
    return {
      sample: true,
      totals: { replies: replies, tokens: replies * 640, wh: emitted / 0.445 * 1000, emitted_kg: emitted, views: views, clicks: Math.round(views * 0.012), revenue_usd: views / 1000 * 4, revenue_is_estimate: true, pledge_kg: emitted * 10, funded_kg: funded, retired_kg: funded * 0.82, retired_usd: funded * 0.82 * 0.12 },
      days: days,
      offsets: [
        { day: days[52].day, kg: funded * 0.5, usd: funded * 0.5 * 0.12, project: "Sample: biochar removal", registry: "Sample registry", receipt: "#" },
        { day: days[24].day, kg: funded * 0.32, usd: funded * 0.32 * 0.12, project: "Sample: enhanced weathering", registry: "Sample registry", receipt: "#" },
      ],
      lanes: [{ lane: "smart", replies: replies * 0.46, g: emitted * 520 }, { lane: "swift", replies: replies * 0.3, g: emitted * 60 }, { lane: "code", replies: replies * 0.12, g: emitted * 190 }, { lane: "deep", replies: replies * 0.07, g: emitted * 200 }, { lane: "creative", replies: replies * 0.05, g: emitted * 30 }],
      method: { wh_per_1k_out: { xs: 0.04, s: 0.1, m: 0.25, l: 0.5, xl: 1.2 }, input_factor: 0.08, pue: 1.2, grid_g_per_kwh: 445, margin: 1.5, offset_multiple: 10, est_usd_per_1k_views: 4, est_usd_per_click: 0.25, climate_share: 0.5, usd_per_tonne: 120 },
    };
  }
  function loadImpact() {
    return fetch(api + "/v1/impact?days=90", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) { return d && d.days && d.totals && d.totals.replies > 0 ? d : sampleImpact(); })
      .catch(sampleImpact);
  }

  window.Kit = {
    BRANDS: BRANDS,
    COMPANIONS: COMPANIONS,
    api: api,
    get brand() { return brand; },
    mode: mode,
    toggleMode: function () { set("pv_mode", mode() === "dark" ? "light" : "dark"); applyMode(); },
    icon: icon, esc: esc, fmtWh: fmtWh, fmtCO2: fmtCO2, fmtN: fmtN,
    loadImpact: loadImpact, get: get, set: set,
  };

  document.documentElement.classList.add("js");
  applyMode();

  function ready() {
    applyBrand();
    applyMode();
    document.querySelectorAll("[data-mode-toggle]").forEach(function (b) { b.addEventListener("click", window.Kit.toggleMode); });

    // Entrances when a block scrolls into view (no scroll listeners).
    var els = document.querySelectorAll("[data-in]");
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
      els.forEach(function (el) { io.observe(el); });
    } else els.forEach(function (el) { el.classList.add("in"); });

    // Nav hairline once the page has scrolled past a sentinel.
    var nav = document.querySelector(".nav");
    if (nav && "IntersectionObserver" in window) {
      var s = document.createElement("div");
      s.style.cssText = "position:absolute;top:0;height:8px;width:1px;pointer-events:none";
      document.body.prepend(s);
      new IntersectionObserver(function (es) { nav.classList.toggle("stuck", !es[0].isIntersecting); }).observe(s);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();
