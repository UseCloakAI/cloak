// Cloak Brain: the home-PC half of Cloak Blinks.
//
// Runs as a background service (systemd) on the PC. Cloudflare reaches it
// through a Cloudflare Tunnel at brain.usecloak.org; nothing else can.
// It runs the agent (the same code as the Worker), keeps each person's
// memory, scheduled tasks and inbox (node:sqlite), stores chat files on
// disk, keeps a copy of every chat, and serves the management site at
// /admin. Models and web search are called through the Worker, so the
// provider keys never sit on this machine.
//
// Zero npm dependencies: Node 22+ only.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openSql } from "./sqlite.js";
import { runAgent, setIO, collect } from "../blinks-api/src/agent.js";
import { makeBlinks } from "./blinks.js";
import { makeComputer, Busy } from "./computer.js";
import { MindCore } from "../blinks-api/src/mind-core.js";
import { stripTags } from "../blinks-api/src/prompts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "0.5.5";
const CONFIG_FILE = process.env.CLOAK_BRAIN_CONFIG || "/etc/cloak-brain/config.json";
const started = Date.now();

// ── Config ───────────────────────────────────────────────────────────────────
function readConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  return {
    port: 7777,
    api: "https://blinks-api.usecloak.org",
    dataDir: "/var/lib/cloak-brain",
    supabaseUrl: "https://kdawsqrrmwirilyhcolk.supabase.co",
    supabaseAnonKey: "",
    admins: [],
    paused: false,
    brand: "Cloak Blinks",
    convictions: "on",
    ...c,
  };
}
let config = readConfig();
async function saveConfig(patch) {
  config = { ...config, ...patch };
  const tmp = CONFIG_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, CONFIG_FILE);
}
const DATA = config.dataDir;
for (const d of ["users", "files", "chats"]) fs.mkdirSync(path.join(DATA, d), { recursive: true });

// ── Log: what the management site shows ─────────────────────────────────────
const LOG = [];
function log(level, msg, extra) {
  const line = { t: Date.now(), level, msg: String(msg).slice(0, 500), ...(extra ? { extra } : {}) };
  LOG.push(line);
  if (LOG.length > 800) LOG.shift();
  (level === "error" ? console.error : console.log)(`[${level}] ${line.msg}`);
}
const stats = { turns: 0, turnsToday: 0, day: new Date().toDateString(), errors: 0, active: new Map() };

// ── Talking to the Worker ────────────────────────────────────────────────────
async function worker(p, body, opts = {}) {
  return fetch(config.api + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Brain-Token": config.brainToken }, body: JSON.stringify(body), signal: opts.signal });
}
async function* workerLane(env, lane, opts = {}) {
  const { signal, ...rest } = opts;
  const res = await worker("/internal/lane", { lane, opts: rest }, { signal });
  if (!res.ok || !res.body) throw new Error(`the Worker answered ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.error) {
        const err = new Error(ev.error);
        err.tried = ev.tried;
        throw err;
      }
      yield ev;
    }
  }
}
async function workerNet(kind, payload) {
  const res = await worker("/internal/net", { kind, ...payload });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || "failed");
  return out.data;
}
setIO({
  lane: (env, lane, opts) => workerLane(env, lane, opts),
  net: () => ({ search: (query, recent) => workerNet("search", { query, recent }), read: (url) => workerNet("read", { url }) }),
});

// ── Minds: one SQLite file per person ────────────────────────────────────────
const minds = new Map();
const userDir = (key) => crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 24);
function mind(key) {
  let m = minds.get(key);
  if (m) return m;
  const file = path.join(DATA, "users", userDir(key) + ".sqlite");
  const sql = openSql(file);
  let timer = null;
  const alarms = {
    set(at) {
      clearTimeout(timer);
      timer = setTimeout(() => core.alarm().catch((e) => log("error", `task run failed: ${e.message}`)), Math.min(2 ** 31 - 1, Math.max(0, at - Date.now())));
    },
    clear() { clearTimeout(timer); timer = null; },
  };
  const core = new MindCore(sql, alarms, env, (p) => p?.catch?.(() => {}));
  core.hello(key);
  minds.set(key, core);
  return core;
}
// Wake every person's scheduler at start (their files hold their tasks).
function wakeAll() {
  for (const f of fs.readdirSync(path.join(DATA, "users")).filter((n) => n.endsWith(".sqlite"))) {
    try {
      const sql = openSql(path.join(DATA, "users", f));
      const key = sql.exec("SELECT v FROM meta WHERE k = 'key'").toArray()[0]?.v;
      sql.close();
      if (key) mind(key).arm();
    } catch (e) {
      log("error", `could not open ${f}: ${e.message}`);
    }
  }
}

// The env the agent sees: minds here, the ledger via the Worker.
const env = {
  BRAND: config.brand,
  CONVICTIONS: config.convictions,
  // Durable Object calls are always async; MindCore's sometimes are not.
  MIND: { idFromName: (k) => k, get: (k) => new Proxy(String(k).includes("#") ? blinks.mind(k) : mind(k), { get: (t, n) => (typeof t[n] === "function" ? (...a) => Promise.resolve().then(() => t[n](...a)) : t[n]) }) },
  LEDGER: { idFromName: () => "global", get: () => ({ recordReply: (r) => worker("/internal/ledger", r).catch(() => {}) }) },
};

// ── Blinks: one folder of Markdown + one continuous chat per Blink ──────────
async function utility(system, user, maxTokens = 900) {
  let out = "";
  for await (const ev of workerLane(env, "utility", { system, messages: [{ role: "user", content: user }], maxTokens })) if (ev.done) out = ev.text;
  return out;
}
// Memories kept before each Blink had its own files (one SQLite per person).
function legacy(user) {
  const file = path.join(DATA, "users", userDir(user) + ".sqlite");
  if (!fs.existsSync(file)) return [];
  try { return mind(user).memories(); } catch { return []; }
}
const blinks = makeBlinks({ DATA, userDir, env, utility, runAgent, collect, log, legacy });

// ── Cloak Computer: the VMs (brain/vm/setup.sh), when installed ─────────────
async function vision(b64, mime, question, w, h) {
  const system = `You are the eyes of an AI agent controlling a Linux desktop (${w}x${h}). The large white arrow with a black outline is the mouse pointer. Describe what matters for the question: the open windows, what has focus, any text (exactly), dialogs and errors. Give positions as normalized 0-1000 coordinates (x from the left, y from the top) when asked where something is. Be precise and brief.`;
  let out = "";
  for await (const ev of workerLane(env, "screen", { system, messages: [{ role: "user", content: [{ type: "text", text: question }, { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }] }], maxTokens: 900 })) if (ev.done) out = ev.text;
  return out || "The screen could not be read just now.";
}
// The computer operator's two models (NVIDIA, through the Worker's keys):
// think decides from the page as text, see reads a screenshot.
async function think(system, user) {
  let out = "";
  for await (const ev of workerLane(env, "operator", { system, messages: [{ role: "user", content: user }], maxTokens: 900 })) if (ev.done) out = ev.text;
  return out;
}
async function see(b64, mime, system, prompt) {
  let out = "";
  for await (const ev of workerLane(env, "screen", { system, messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }] }], maxTokens: 700 })) if (ev.done) out = ev.text;
  return out;
}
const isAdmin = (email) => !!email && config.admins.map((a) => String(a).toLowerCase()).includes(String(email).toLowerCase());
const computer = makeComputer({ log, isAdmin, vision, think, see, stateDir: path.join(DATA, "computer") });

// ── Files ────────────────────────────────────────────────────────────────────
const FILE_MAX = 100 * 1024 * 1024; // Cloudflare's request limit on the free plan
const fileDir = (key) => path.join(DATA, "files", userDir(key));
async function saveFile(req, key) {
  const name = decodeURIComponent(String(req.headers["x-file-name"] || "file")).replace(/[\\/\u0000-\u001f]+/g, "_").slice(0, 160) || "file";
  const type = String(req.headers["content-type"] || "application/octet-stream").slice(0, 120);
  const id = crypto.randomBytes(12).toString("hex");
  const dir = fileDir(key);
  await fsp.mkdir(dir, { recursive: true });
  const out = fs.createWriteStream(path.join(dir, id));
  let size = 0;
  await new Promise((resolve, reject) => {
    req.on("data", (c) => {
      size += c.length;
      if (size > FILE_MAX) { req.destroy(); out.destroy(); reject(new Error("too big")); }
    });
    req.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    req.on("error", reject);
  });
  const meta = { id, name, type, size, created: Date.now() };
  await fsp.writeFile(path.join(dir, id + ".json"), JSON.stringify(meta));
  log("info", `file saved: ${name} (${Math.round(size / 1024)} KB)`);
  return meta;
}
async function fileMeta(key, id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  try { return JSON.parse(await fsp.readFile(path.join(fileDir(key), id + ".json"), "utf8")); } catch { return null; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(data));
};
const readJson = (req) => new Promise((resolve) => {
  let s = "";
  req.on("data", (c) => { s += c; if (s.length > 8_000_000) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } });
});
const fromWorker = (req) => !!config.brainToken && req.headers["x-brain-token"] === config.brainToken;
async function dirSize(dir) {
  let n = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? await dirSize(p) : (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return n;
}
const sh = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 4000 }, (err, out) => resolve(err ? "" : String(out).trim())));

const injects = new Map(); // run id -> messages sent while it runs

// ── A turn, sent by the Worker ───────────────────────────────────────────────
// Once the brain has the message it finishes the reply no matter what: the
// browser (or the Worker) can go away and the answer still lands in the
// Blink's chat, where the app picks it up next time it opens.
async function handleTurn(req, res) {
  const body = await readJson(req);
  const id = crypto.randomBytes(6).toString("hex");
  const ctrl = new AbortController(); // never aborted by a closed connection
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  const out = (ev) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const ping = setInterval(() => out({ ping: 1 }), 10_000);
  const ask = String(body.messages?.[body.messages.length - 1]?.content || "").slice(0, 80);
  stats.active.set(id, { started: Date.now(), user: userDir(body.userKey || ""), ask, step: "", key: body.userKey || "", companion: body.companion || "cloak", run: typeof body.run_id === "string" ? body.run_id : null });
  const today = new Date().toDateString();
  if (stats.day !== today) { stats.day = today; stats.turnsToday = 0; }
  stats.turns++; stats.turnsToday++;
  const ctx = { waitUntil: (p) => p?.catch?.(() => {}) };
  let text = null;
  try {
    const turn = await blinks.prepare(body, out);
    turn.bindTalk(ctx, ctrl.signal);
    // Messages sent while this runs (POST /v1/blink/inject) join before the next step.
    if (body.run_id) turn.body.pending = () => { const n = injects.get(body.run_id) || []; injects.delete(body.run_id); n.forEach((t) => turn.note(t)); return n; };
    if (computer.available && computer.allowed(body.email)) turn.body.computer = computer.forUser(body.userKey, out);
    for await (const ev of runAgent(env, ctx, turn.body, ctrl.signal)) {
      if (ev.step?.label) stats.active.get(id).step = ev.step.label;
      if (ev.done) {
        text = ev.text || "";
        const at = turn.finish(text);
        out({ ...ev, stored_at: at });
        continue;
      }
      out(ev);
    }
  } catch (e) {
    stats.errors++;
    log("error", `turn failed: ${String(e?.message || e)}`, e?.tried);
    out({ error: "Something went wrong while answering. Try again in a moment." });
  } finally {
    clearInterval(ping);
    stats.active.delete(id);
    if (!res.writableEnded) res.end();
  }
}

// ── Memory, tasks, inbox, and each Blink's files ────────────────────────────
// Everything is per Blink: ?blink=<id> (Cloak when left out).
async function handleMe(req, res, p) {
  const key = String(req.headers["x-user-key"] || "");
  if (!/^[ud]:[\w-]{8,80}$/.test(key)) return send(res, 400, { error: "no user" });
  const q = new URL(req.url, "http://brain").searchParams;
  const blink = /^(cloak|u_[a-z0-9]{4,36})$/i.test(q.get("blink") || "") ? q.get("blink") : "cloak";
  const m = blinks.mind(`${key}#${blink}`);
  const method = req.method;
  const body = method === "POST" ? await readJson(req) : {};
  let r;
  if (p.startsWith("/v1/computer")) {
    const email = String(req.headers["x-user-email"] || "");
    if (p === "/v1/computer" && method === "GET") return send(res, 200, computer.status(key, email));
    if (!computer.available || !computer.allowed(email)) return send(res, 403, { error: "The computer is not available to this account." });
    try {
      if (p === "/v1/computer/wake" && method === "POST") { computer.wakeFor(key, body.kind === "server" ? "server" : "desktop").catch((e) => log("error", `wake failed: ${e.message}`)); return send(res, 200, computer.status(key, email)); }
      if (p === "/v1/computer/release" && method === "POST") { computer.release(key); return send(res, 200, computer.status(key, email)); }
      // Taking over by hand: live frames, the person's mouse and keyboard, and the hand-back.
      if (p === "/v1/computer/takeover" && method === "POST") return send(res, 200, { takeover: computer.forUser(key).takeover(!!body.on), ...computer.status(key, email) });
      if (p === "/v1/computer/live" && method === "GET") {
        const f = await computer.forUser(key).live();
        if (!f) return send(res, 409, { error: "The desktop is not running." });
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "Content-Length": f.jpg.length, "X-Screen": `${f.w}x${f.h}` });
        return res.end(f.jpg);
      }
      if (p === "/v1/computer/input" && method === "POST") {
        const A = ["click", "double", "right", "move", "down", "up", "type", "key", "scroll"];
        if (!A.includes(body.action)) return send(res, 400, { error: "unknown action" });
        const a = { action: body.action };
        for (const k of ["x", "y"]) if (body[k] != null) a[k] = Math.max(0, Math.min(8000, Math.round(+body[k] || 0)));
        if (body.button) a.button = ["left", "middle", "right"].includes(body.button) ? body.button : "left";
        if (body.text != null) a.text = String(body.text).slice(0, 2000);
        if (body.keys != null) a.keys = String(body.keys).slice(0, 120);
        if (body.direction) a.direction = ["up", "down", "left", "right"].includes(body.direction) ? body.direction : "down";
        if (body.amount != null) a.amount = Math.max(1, Math.min(10, +body.amount || 1));
        await computer.forUser(key).input(a, true);
        return send(res, 200, { ok: true });
      }
      if (p === "/v1/computer/screen" && method === "GET") {
        const png = await computer.frameFor(key);
        if (!png) return send(res, 409, { error: "not driving" });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "Content-Length": png.length });
        return res.end(png);
      }
    } catch (e) {
      return send(res, e instanceof Busy ? 409 : 500, { error: e.message, ...computer.status(key, email) });
    }
    return send(res, 404, { error: "Not found" });
  }
  if (p === "/v1/blink/all" && method === "DELETE") {
    blinks.wipe(key);
    minds.delete(key);
    if (computer.available) await computer.wipe(key).catch((e) => log("error", `computer wipe failed: ${e.message}`));
    for (const f of [path.join(DATA, "users", userDir(key) + ".sqlite"), path.join(DATA, "files", userDir(key)), path.join(DATA, "chats", userDir(key))]) await fsp.rm(f, { recursive: true, force: true }).catch(() => {});
    log("info", "a person reset everything");
    return send(res, 200, { ok: true });
  }
  if (p === "/v1/blink/inject" && method === "POST") {
    const id = String(body.run_id || ""), t = String(body.text || "").trim().slice(0, 4000);
    if (!/^[\w-]{8,64}$/.test(id) || !t) return send(res, 400, { error: "bad note" });
    injects.set(id, [...(injects.get(id) || []), t].slice(-10));
    setTimeout(() => injects.delete(id), 15 * 60_000).unref?.();
    return send(res, 200, { ok: true });
  }
  // Replies in progress for this person, so every open page (phone, laptop,
  // any number of tabs) can show the same live status.
  if (p === "/v1/blink/live" && method === "GET") return send(res, 200, { live: [...stats.active.values()].filter((a) => a.key === key && a.run).map((a) => ({ companion: a.companion, run_id: a.run, step: a.step, started: a.started })) });
  if (p === "/v1/blink/since" && method === "GET") return send(res, 200, { now: Date.now(), chats: blinks.since(key, Number(q.get("t")) || 0, q.get("blink") ? blink : null) });
  if (p === "/v1/blink/files" && method === "GET") return send(res, 200, blinks.files(key, blink));
  if (p === "/v1/blink/soul" && method === "POST") return send(res, 200, { ok: blinks.setSoul(key, blink, body.text) });
  if (p === "/v1/me" && method === "GET") return send(res, 200, { power: "full", ...m.overview(), files: blinks.files(key, blink) });
  if (p === "/v1/me" && method === "DELETE") return send(res, 200, { ok: await m.erase() });
  if (p === "/v1/memory" && method === "POST") return send(res, 200, m.remember({ fact: body.fact, kind: body.kind, by: "you" }));
  if (p === "/v1/memory" && method === "DELETE") return send(res, 200, { ok: m.forgetAll() });
  if ((r = /^\/v1\/memory\/(\d+)$/.exec(p)) && method === "DELETE") return send(res, 200, { ok: m.forgetId(+r[1]) });
  if (p === "/v1/tasks" && method === "POST") return send(res, 200, await m.addTask({ ...body, companion: blink, brand: config.brand }));
  if ((r = /^\/v1\/tasks\/(\d+)$/.exec(p)) && method === "DELETE") return send(res, 200, { ok: await m.removeTask(+r[1]) });
  if (p === "/v1/inbox/seen" && method === "POST") return send(res, 200, { ok: m.seen(body.ids) });
  if (p === "/v1/inbox/deliver" && method === "POST") {
    const to = /^(cloak|u_[a-z0-9]{4,36})$/i.test(body.companion || "") ? body.companion : blink;
    blinks.mind(`${key}#${to}`).deliver(body);
    return send(res, 200, { ok: true });
  }
  if ((r = /^\/v1\/inbox\/(\d+)$/.exec(p)) && method === "DELETE") return send(res, 200, { ok: m.removeInbox(+r[1]) });
  return send(res, 404, { error: "Not found" });
}

async function handleFiles(req, res, p) {
  const key = String(req.headers["x-user-key"] || "");
  if (!/^[ud]:[\w-]{8,80}$/.test(key)) return send(res, 400, { error: "no user" });
  if (p === "/v1/files" && req.method === "POST") {
    try { return send(res, 200, await saveFile(req, key)); } catch (e) { return send(res, 413, { error: e.message === "too big" ? "That file is over 100 MB." : "Could not save that file." }); }
  }
  const r = /^\/v1\/files\/([a-f0-9]{24})$/.exec(p);
  if (!r) return send(res, 404, { error: "Not found" });
  const meta = await fileMeta(key, r[1]);
  if (!meta) return send(res, 404, { error: "No such file." });
  if (req.method === "DELETE") {
    await fsp.rm(path.join(fileDir(key), meta.id), { force: true });
    await fsp.rm(path.join(fileDir(key), meta.id + ".json"), { force: true });
    return send(res, 200, { ok: true });
  }
  res.writeHead(200, { "Content-Type": meta.type, "Content-Length": meta.size, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`, "Cache-Control": "private, max-age=3600" });
  fs.createReadStream(path.join(fileDir(key), meta.id)).pipe(res);
}

// ── The management site (/admin) ─────────────────────────────────────────────
// Sign in with a Cloak account whose email is in config.admins.
const adminCache = new Map();
async function adminOf(req) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const hit = adminCache.get(token);
  if (hit && hit.until > Date.now()) return hit.email;
  try {
    const r = await fetch(`${config.supabaseUrl}/auth/v1/user`, { headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    const u = r.ok ? await r.json() : null;
    const email = String(u?.email || "").toLowerCase();
    const ok = email && config.admins.map((a) => String(a).toLowerCase()).includes(email);
    if (ok) adminCache.set(token, { email, until: Date.now() + 5 * 60_000 });
    return ok ? email : null;
  } catch {
    return null;
  }
}

async function people() {
  const out = [];
  for (const f of (await fsp.readdir(path.join(DATA, "users")).catch(() => [])).filter((n) => n.endsWith(".sqlite"))) {
    const dir = f.replace(/\.sqlite$/, "");
    let key = null, memories = 0, tasks = 0, inbox = 0;
    for (const [k, m] of minds) if (userDir(k) === dir) { key = k; memories = m.memories().length; tasks = m.tasks().length; inbox = m.inbox().length; }
    const files = (await fsp.readdir(path.join(DATA, "files", dir)).catch(() => [])).filter((n) => n.endsWith(".json")).length;
    const chats = (await fsp.readdir(path.join(DATA, "chats", dir)).catch(() => [])).length;
    out.push({ id: dir, key, memories, tasks, inbox, files, chats });
  }
  return out;
}

async function handleAdmin(req, res, p) {
  if (p === "/admin" || p === "/admin/") {
    const html = await fsp.readFile(path.join(HERE, "admin", "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
    return res.end(html.replace("__SB_URL__", config.supabaseUrl).replace("__SB_KEY__", config.supabaseAnonKey));
  }
  const who = await adminOf(req);
  if (!who) return send(res, 401, { error: "Sign in with a Cloak account that is allowed to manage this brain." });
  const body = req.method === "POST" ? await readJson(req) : {};
  let r;
  if (p === "/admin/api/overview") {
    const [tunnel, disk] = await Promise.all([sh("systemctl", ["is-active", "cloudflared"]), sh("df", ["-Pk", DATA])]);
    const d = disk.split("\n")[1]?.split(/\s+/) || [];
    let cf = null;
    try { cf = await (await fetch(config.api + "/v1/status", { signal: AbortSignal.timeout(5000) })).json(); } catch {}
    return send(res, 200, {
      version: VERSION, node: process.version, uptime: Date.now() - started, paused: !!config.paused, admin: who,
      tunnel: tunnel || "unknown", cloudflare: cf,
      turns: stats.turns, turnsToday: stats.turnsToday, errors: stats.errors,
      active: [...stats.active.values()].map(({ key, run, ...a }) => a),
      storage: { used: await dirSize(DATA), diskFree: d[3] ? Number(d[3]) * 1024 : null, diskSize: d[1] ? Number(d[1]) * 1024 : null },
      people: (await fsp.readdir(path.join(DATA, "users")).catch(() => [])).filter((n) => n.endsWith(".sqlite")).length,
      memory: process.memoryUsage().rss,
    });
  }
  if (p === "/admin/api/people") return send(res, 200, { people: await people() });
  if ((r = /^\/admin\/api\/people\/([a-f0-9]{24})$/.exec(p))) {
    let entry = null;
    for (const [k, m] of minds) if (userDir(k) === r[1]) entry = { key: k, ...m.overview() };
    const dir = path.join(DATA, "files", r[1]);
    const files = [];
    for (const f of (await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith(".json"))) files.push(JSON.parse(await fsp.readFile(path.join(dir, f), "utf8")));
    return send(res, 200, { id: r[1], ...(entry || { memories: [], tasks: [], inbox: [] }), files: files.sort((a, b) => b.created - a.created) });
  }
  if ((r = /^\/admin\/api\/people\/([a-f0-9]{24})\/(memory|task|file)\/([\w]+)$/.exec(p)) && req.method === "DELETE") {
    let key = null;
    for (const k of minds.keys()) if (userDir(k) === r[1]) key = k;
    if (r[2] === "file") {
      await fsp.rm(path.join(DATA, "files", r[1], r[3]), { force: true });
      await fsp.rm(path.join(DATA, "files", r[1], r[3] + ".json"), { force: true });
    } else if (key && r[2] === "memory") mind(key).forgetId(+r[3]);
    else if (key && r[2] === "task") await mind(key).removeTask(+r[3]);
    log("info", `${who} deleted ${r[2]} ${r[3]}`);
    return send(res, 200, { ok: true });
  }
  if (p === "/admin/api/log") return send(res, 200, { lines: LOG.slice(-300) });
  if (p === "/admin/api/settings" && req.method === "POST") {
    const patch = {};
    if (typeof body.paused === "boolean") patch.paused = body.paused;
    if (body.computerAccess === "everyone" || body.computerAccess === "admins") computer.setAccess(body.computerAccess);
    if (body.computerSleep === true) computer.sleepAll().catch(() => {});
    if (Array.isArray(body.admins)) patch.admins = body.admins.map((a) => String(a).trim().toLowerCase()).filter((a) => /@/.test(a)).slice(0, 10);
    if (patch.admins && !patch.admins.includes(who)) patch.admins.push(who); // never lock yourself out
    await saveConfig(patch);
    log("info", `${who} changed settings: ${JSON.stringify(patch)}`);
    return send(res, 200, { ok: true, paused: config.paused, admins: config.admins });
  }
  if (p === "/admin/api/settings") return send(res, 200, { paused: config.paused, admins: config.admins, api: config.api, dataDir: DATA, port: config.port, computer: computer.status(null, who) });
  // Update now: the updater (root, systemd) watches for this file.
  if (p === "/admin/api/update" && req.method === "POST") {
    const can = fs.existsSync("/etc/systemd/system/cloak-brain-update.path");
    if (!can) return send(res, 409, { error: "This brain cannot update on request yet. It will be able to after its next automatic update (within 30 minutes)." });
    fs.writeFileSync(path.join(DATA, "update-now"), String(Date.now()));
    log("info", `${who} asked for an update`);
    return send(res, 200, { ok: true, version: VERSION });
  }
  if (p === "/admin/api/restart" && req.method === "POST") {
    log("info", `${who} restarted the brain`);
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 300); // systemd starts it again
    return;
  }
  return send(res, 404, { error: "Not found" });
}

// ── The server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://brain").pathname.replace(/\/+$/, "") || "/";
  try {
    if (p === "/health") {
      if (!fromWorker(req)) return send(res, 401, { error: "Unauthorized" });
      return send(res, 200, { ok: true, paused: !!config.paused, version: VERSION, uptime: Date.now() - started, computer: computer.available ? "ready" : fs.existsSync("/etc/cloak-brain/computer.json") ? "old-setup" : "not-installed" });
    }
    if (p === "/admin" || p.startsWith("/admin/")) return await handleAdmin(req, res, p);
    if (!fromWorker(req)) return send(res, 401, { error: "Unauthorized" });
    if (config.paused && p !== "/health") return send(res, 503, { error: "paused" });
    if (p === "/v1/turn" && req.method === "POST") return await handleTurn(req, res);
    if (p === "/v1/me" || p.startsWith("/v1/memory") || p.startsWith("/v1/tasks") || p.startsWith("/v1/inbox") || p.startsWith("/v1/blink/") || p.startsWith("/v1/computer")) return await handleMe(req, res, p);
    if (p === "/v1/files" || p.startsWith("/v1/files/")) return await handleFiles(req, res, p);
    send(res, 404, { error: "Not found" });
  } catch (e) {
    log("error", `request failed: ${e?.stack || e}`);
    if (!res.headersSent) send(res, 500, { error: "Something went wrong." });
    else res.end();
  }
});
server.requestTimeout = 0; // turns and uploads can take minutes
server.listen(config.port, "127.0.0.1", () => {
  log("info", `Cloak Brain ${VERSION} listening on 127.0.0.1:${config.port}`);
  wakeAll();
  blinks.wakeAll();
});
// Stopping (an update, a reboot): take no new turns, let the ones in
// progress finish (up to two minutes), then exit.
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => {
  log("info", stats.active.size ? `shutting down after ${stats.active.size} reply(s) in progress` : "shutting down");
  server.close();
  const until = Date.now() + 120_000;
  const wait = setInterval(() => { if (!stats.active.size || Date.now() > until) { clearInterval(wait); process.exit(0); } }, 250);
});
