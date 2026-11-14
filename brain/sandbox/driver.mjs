// Cloak sandbox driver: runs INSIDE the locked-down sandbox (no network, a
// throwaway /work folder) and checks one piece of code a Blink wrote.
//
//   node driver.mjs html   index.html   load it in headless Chromium, press its
//                                       buttons and keys, report what happened
//   node driver.mjs js     main.js      syntax check, then run it
//   node driver.mjs python main.py      compile, then run it
//
// Prints one JSON report on stdout. Nothing here trusts the code it runs.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [kind, entry] = process.argv.slice(2);
const CHROME = process.env.CHROME || "/usr/lib/chromium/chromium";
const RUN_MS = +process.env.RUN_MS || 8000;
const clip = (s, n = 1200) => { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; };
const out = (r) => { process.stdout.write(JSON.stringify(r)); process.exit(0); };

function runProgram(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: process.cwd(), timeout: RUN_MS, encoding: "utf8", maxBuffer: 2e6, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: "/tmp", PYTHONDONTWRITEBYTECODE: "1" } });
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  return { exit: r.status, timedOut, stdout: clip(r.stdout, 3000), stderr: clip(r.stderr, 3000) };
}

if (kind === "js") {
  const chk = spawnSync(process.execPath, ["--check", entry], { encoding: "utf8" });
  if (chk.status !== 0) out({ kind, ok: false, errors: [`Syntax error: ${clip(chk.stderr, 800)}`] });
  const r = runProgram(process.execPath, ["--max-old-space-size=256", entry]);
  const errors = [];
  if (!r.timedOut && r.exit !== 0) errors.push(`Exited with code ${r.exit}: ${clip(r.stderr, 900)}`);
  out({ kind, ok: !errors.length, errors, notes: r.timedOut ? [`Still running after ${RUN_MS / 1000}s (fine for a server or a program that waits for input).`] : [], stdout: r.stdout, stderr: r.stderr });
}
if (kind === "python") {
  const chk = spawnSync("python3", ["-m", "py_compile", entry], { encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", PYTHONPYCACHEPREFIX: "/tmp/pyc" } });
  if (chk.status !== 0) out({ kind, ok: false, errors: [`Syntax error: ${clip(chk.stderr, 800)}`] });
  const r = runProgram("python3", [entry]);
  const errors = [];
  if (!r.timedOut && r.exit !== 0) errors.push(`Exited with code ${r.exit}: ${clip(r.stderr, 900)}`);
  out({ kind, ok: !errors.length, errors, notes: r.timedOut ? [`Still running after ${RUN_MS / 1000}s (fine for a server or a program that waits for input).`] : [], stdout: r.stdout, stderr: r.stderr });
}
if (kind !== "html") out({ kind, ok: false, errors: ["unknown kind"] });

// ── A web page: a real browser, a real click on every control ──────────────
// This runs in the page before its own code, and keeps score.
const HARNESS = `(() => {
  const S = window.__cloak = { errors: [], audio: { contexts: 0, starts: 0, past: 0, zeroGain: 0 }, raf: 0, draws: 0, timers: 0, listeners: {}, storage: 0, t0: performance.now() };
  addEventListener("error", (e) => S.errors.push(String(e.message || e.error || "error") + (e.filename ? " (" + String(e.filename).split("/").pop() + ":" + e.lineno + ")" : "")), true);
  addEventListener("unhandledrejection", (e) => S.errors.push("Unhandled promise rejection: " + String(e.reason && e.reason.message || e.reason)));
  const AEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type) { S.listeners[type] = (S.listeners[type] || 0) + 1; return AEL.apply(this, arguments); };
  const raf = window.requestAnimationFrame; window.requestAnimationFrame = function (f) { S.raf++; return raf.call(window, f); };
  const st = window.setTimeout; window.setTimeout = function () { S.timers++; return st.apply(window, arguments); };
  const si = window.setInterval; window.setInterval = function () { S.timers++; return si.apply(window, arguments); };
  for (const C of [window.CanvasRenderingContext2D]) if (C) for (const m of ["fillRect", "stroke", "fill", "drawImage", "fillText", "clearRect", "putImageData"]) { const o = C.prototype[m]; C.prototype[m] = function () { S.draws++; return o.apply(this, arguments); }; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const ctxs = [], taps = [], freqs = new WeakSet(), pitches = new Set();
    S.audio.future = 0; S.audio.pastParams = 0; S.audio.params = 0;
    const W = function (...a) {
      const c = new AC(...a); S.audio.contexts++; ctxs.push(c);
      // Listen to what actually reaches the speakers.
      try { const an = c.createAnalyser(); an.fftSize = 2048; taps.push({ c, an, buf: new Float32Array(2048) }); c.__tap = an; } catch (e) {}
      return c;
    };
    W.prototype = AC.prototype; window.AudioContext = window.webkitAudioContext = W;
    const conn = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest) {
      try { if (dest && dest === this.context.destination && this.context.__tap && this !== this.context.__tap) conn.call(this, this.context.__tap); } catch (e) {}
      return conn.apply(this, arguments);
    };
    const mk = BaseAudioContext.prototype.createOscillator;
    BaseAudioContext.prototype.createOscillator = function () { const o = mk.apply(this, arguments); freqs.add(o.frequency); return o; };
    const now = () => (ctxs.length ? ctxs[ctxs.length - 1].currentTime : 0);
    for (const m of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "setTargetAtTime"]) {
      const o = AudioParam.prototype[m];
      AudioParam.prototype[m] = function (v, t) {
        S.audio.params++;
        const when = m === "setTargetAtTime" ? arguments[1] : t;
        if (typeof when === "number" && when > 0 && when < now() - 0.08) S.audio.pastParams++;
        if (freqs.has(this) && v > 20 && v < 20000) pitches.add(Math.round(v));
        try { return o.apply(this, arguments); } catch (e) { S.errors.push("AudioParam." + m + ": " + e.message); }
      };
    }
    const start = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (when) {
      S.audio.starts++;
      const t = this.context ? this.context.currentTime : 0;
      // Scheduled for a moment already gone by, or absurdly far ahead: it will not play in time.
      if (typeof when === "number" && when > 0 && when < t - 0.08) S.audio.past++;
      if (typeof when === "number" && when > t + 60) S.audio.future++;
      try { return start.apply(this, arguments); } catch (e) { S.errors.push("AudioNode.start: " + e.message); }
    };
    S.audioState = () => ctxs.map((c) => c.state);
    S.pitches = () => pitches.size;
    // Loudness right now (0 = silence).
    S.level = () => { let m = 0; for (const t of taps) { t.an.getFloatTimeDomainData(t.buf); let s = 0; for (let i = 0; i < t.buf.length; i++) s += t.buf[i] * t.buf[i]; m = Math.max(m, Math.sqrt(s / t.buf.length)); } return m; };
  }
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { kind, ok: false, errors: [], warnings: [], notes: [], facts: {} };
const fileUrl = "file://" + path.resolve(entry);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--mute-audio",
  "--autoplay-policy=no-user-gesture-required", "--disable-background-networking", "--disable-extensions", "--js-flags=--max-old-space-size=256",
  "--remote-debugging-port=9333", "--user-data-dir=/tmp/chrome-" + process.pid, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
const done = (r) => { try { chrome.kill("SIGKILL"); } catch {} out(r); };
const hard = setTimeout(() => { report.errors.push("The page did not finish its check in time (it may be stuck in a loop)."); done(report); }, RUN_MS + 25000);

try {
  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(250);
    try { const list = await (await fetch("http://127.0.0.1:9333/json")).json(); const pg = list.find((x) => x.type === "page"); if (pg) ws = new WebSocket(pg.webSocketDebuggerUrl); } catch {}
  }
  if (!ws) { report.errors.push("The sandbox browser did not start."); report.infra = true; done(report); }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("devtools socket")); });
  let id = 0; const waits = new Map();
  const consoleErrors = [], failed = [], dialogs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); return; }
    if (d.method === "Runtime.consoleAPICalled" && (d.params.type === "error" || d.params.type === "assert")) consoleErrors.push(clip(d.params.args.map((a) => a.value ?? a.description ?? "").join(" "), 300));
    if (d.method === "Runtime.exceptionThrown") { const e = d.params.exceptionDetails; consoleErrors.push(clip((e.exception && e.exception.description) || e.text, 400)); }
    if (d.method === "Network.loadingFailed" && d.params.errorText !== "net::ERR_ABORTED") failed.push(d.params.requestId);
    if (d.method === "Network.requestWillBeSent") reqs.set(d.params.requestId, d.params.request.url);
    if (d.method === "Page.javascriptDialogOpening") { dialogs.push(`${d.params.type}: ${clip(d.params.message, 120)}`); send("Page.handleJavaScriptDialog", { accept: true }); }
  };
  const reqs = new Map();
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; waits.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: HARNESS });
  await send("Page.navigate", { url: fileUrl });
  for (let i = 0; i < 40; i++) { await sleep(150); if ((await ev("document.readyState")) === "complete") break; }
  await sleep(900);

  const snap = () => ev(`(() => { const S = window.__cloak || {}; return { errors: S.errors || [], audio: S.audio, audioState: S.audioState ? S.audioState() : [], raf: S.raf, draws: S.draws, timers: S.timers, listeners: S.listeners, text: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 500), html: document.body ? document.body.innerHTML.length : 0, title: document.title, canvases: document.querySelectorAll("canvas").length, inputs: document.querySelectorAll("input,textarea,select").length }; })()`);
  const before = await snap();
  report.facts.title = before.title; report.facts.text = before.text;
  report.facts.onLoad = { errors: before.errors.length, canvases: before.canvases, draws: before.draws, audioStarts: before.audio ? before.audio.starts : 0 };
  if (!before.html || before.html < 20) report.errors.push("The page renders nothing: the body is empty after loading.");

  // Press its controls, the main one first, and see what each press does.
  const controls = await ev(`(() => { const all = [...document.querySelectorAll("button, [role=button], input[type=button], input[type=submit], a[href='#'], [onclick]")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && !e.disabled; }); const label = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || e.title || e.id || "").replace(/\\s+/g, " ").trim().slice(0, 40); all.forEach((e, i) => e.setAttribute("data-cloak-b", i)); return all.map((e, i) => ({ i, label: label(e) })); })()`) || [];
  const main = /play|start|run|begin|go\b|new game|generate|calculate|add|submit|convert|roll|draw|launch|▶/i;
  const order = [...controls].sort((a, b) => (main.test(b.label) ? 1 : 0) - (main.test(a.label) ? 1 : 0)).slice(0, 6);
  // Give its text boxes something to work with, the way a person would.
  await ev(`(() => { let n = 0; for (const e of document.querySelectorAll("input:not([type]), input[type=text], input[type=search], input[type=number], textarea")) { if (e.disabled || e.readOnly) continue; const v = e.type === "number" ? "7" : "Test item " + (++n); const set = Object.getOwnPropertyDescriptor(e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set; set.call(e, v); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); } })()`);
  const presses = [], levels = [];
  for (const c of order) {
    if (/stop|pause|reset|clear|delete|remove|mute/i.test(c.label) && presses.length === 0 && order.length > 1) continue; // start something before stopping it
    const a = await snap();
    await ev(`(() => { const e = document.querySelector('[data-cloak-b="${c.i}"]'); if (e && !e.disabled) e.click(); })()`);
    if (main.test(c.label)) {
      // Listen for four seconds: is there sound, and does it change like music or stay one drone?
      for (let k = 0; k < 20; k++) { await sleep(200); const v = await ev("window.__cloak && window.__cloak.level ? window.__cloak.level() : -1"); if (v >= 0) levels.push(v); }
    } else await sleep(900);
    const b = await snap();
    const did = [];
    if (b.audio && a.audio && b.audio.starts > a.audio.starts) did.push(`${b.audio.starts - a.audio.starts} sounds started`);
    if (b.draws > a.draws) did.push("the canvas redrew");
    if (b.html !== a.html || b.text !== a.text) did.push("the page changed");
    if (b.errors.length > a.errors.length) did.push(`${b.errors.length - a.errors.length} new error(s)`);
    presses.push({ button: c.label || `button ${c.i + 1}`, did: did.length ? did.join(", ") : "nothing visible or audible happened" });
  }
  // Keyboard-driven pages (games): press the usual keys.
  const l = before.listeners || {};
  if (l.keydown || l.keyup || l.keypress) {
    const a = await snap();
    for (const k of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", " ", "Enter", "w", "a", "s", "d"]) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k === " " ? "Space" : k.length === 1 ? "Key" + k.toUpperCase() : k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32, Enter: 13 }[k] || k.toUpperCase().charCodeAt(0) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: k });
      await sleep(120);
    }
    await sleep(500);
    const b = await snap();
    presses.push({ button: "keyboard (arrows, space, enter, WASD)", did: b.errors.length > a.errors.length ? `${b.errors.length - a.errors.length} new error(s)` : b.draws > a.draws || b.text !== a.text ? "the page responded" : "no visible response" });
  }
  await sleep(600);
  const end = await snap();

  const errs = [...new Set([...end.errors, ...consoleErrors])];
  for (const e of errs.slice(0, 8)) report.errors.push(`JavaScript error: ${clip(e, 400)}`);
  const ext = [...new Set(failed.map((r) => reqs.get(r)).filter((u) => u && !u.startsWith("file:") && !u.startsWith("data:")))];
  if (ext.length) report.warnings.push(`It loads outside files, which could not be checked here (no internet in the sandbox): ${ext.slice(0, 4).join(", ")}. If the page needs them to work, it is unverified; prefer self-contained code.`);
  if (end.audio && end.audio.contexts) {
    const pitches = (await ev("window.__cloak.pitches ? window.__cloak.pitches() : 0")) || 0;
    const loud = levels.filter((v) => v > 0.003).length, peak = levels.length ? Math.max(...levels) : 0;
    const spread = levels.length ? peak - Math.min(...levels) : 0;
    report.facts.sound = { listenedSamples: levels.length, audibleSamples: loud, peakLevel: +peak.toFixed(3), levelChange: +spread.toFixed(3), distinctPitches: pitches };
    if (levels.length >= 10 && loud === 0) report.errors.push("No sound comes out: after pressing play, the output stayed silent for four seconds.");
    else if (levels.length >= 10 && loud < levels.length * 0.25) report.warnings.push(`Sound only came out for ${loud} of ${levels.length} moments in the first four seconds: mostly silence.`);
    if (end.audio.future) report.errors.push(`Audio scheduling bug: ${end.audio.future} sound(s) were started with a time more than a minute in the future (start(when) takes a time in seconds on the audio clock, check the argument order).`);
    if (end.audio.pastParams > 6 && end.audio.pastParams >= end.audio.params * 0.3) report.errors.push(`Audio timing bug: ${end.audio.pastParams} of ${end.audio.params} volume/pitch changes were scheduled at times already in the past, so notes do not play in rhythm. All times must be measured from audioContext.currentTime (add the start time).`);
    if (end.audio.past > 2 && end.audio.past >= end.audio.starts * 0.3) report.errors.push(`Audio timing bug: ${end.audio.past} of ${end.audio.starts} sounds were scheduled for a time already in the past (start(t) with t behind audioContext.currentTime), so notes fire at once instead of in rhythm. Schedule from audioContext.currentTime.`);
    if (end.audio.starts === 0 && presses.length) report.errors.push("It creates an AudioContext but no sound ever starts, even after pressing its controls.");
    if (end.audioState.includes("suspended") && end.audio.starts > 0) report.warnings.push("The AudioContext is still suspended after pressing Play: call audioContext.resume() inside the click handler.");
  }
  const dead = presses.filter((p) => /nothing visible or audible/.test(p.did));
  if (controls.length && presses.length && dead.length === presses.length) report.errors.push(`Pressing its controls does nothing: ${dead.map((p) => `"${p.button}"`).join(", ")}.`);
  else for (const p of dead) report.warnings.push(`Pressing "${p.button}" did nothing visible or audible.`);
  if (dialogs.length) report.notes.push(`It opened dialogs: ${dialogs.slice(0, 3).join(" | ")}`);
  report.facts.controls = controls.map((c) => c.label).slice(0, 12);
  report.facts.presses = presses;
  report.facts.end = { audio: end.audio, audioState: end.audioState, canvasDraws: end.draws, animationFrames: end.raf, listeners: end.listeners, text: end.text };
  report.ok = report.errors.length === 0;
  clearTimeout(hard);
  done(report);
} catch (e) {
  report.errors.push("The check itself failed: " + String(e.message || e)); report.infra = true;
  clearTimeout(hard);
  done(report);
}
