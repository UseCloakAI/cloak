// cloak-blinks-api — the backend for Cloak Blinks at usecloak.org/blinks (a
// separate Cloak product). Separate Worker from production cloak-api; shares only the
// provider key ring (KV) and the free-tier governor.
//
//   POST /v1/chat          agent run, SSE: {meta} {care?} {step}… {sources} {delta}… {done}
//   GET  /v1/runs/:id      re-attach to a cloud run (?from=N); POST …/cancel
//   GET  /v1/me            memories, scheduled tasks, inbox (X-Device or Bearer)
//   …    /v1/memory, /v1/tasks, /v1/inbox   manage them
//   GET  /v1/tools         tool catalog and modes
//   POST /v1/speech        text to speech (WAV); GET /v1/speech/voices
//   GET  /v1/companions    Cloak (the built-in Blink) + public lanes
//   GET  /v1/impact        the public carbon ledger
//   POST /v1/ads/event     {sponsor, kind: "view" | "click"}
//   GET  /admin/probe      time every model in every lane        (X-Admin-Token)
//   POST /admin/offsets    record retired credits with a receipt (X-Admin-Token)
//   POST /admin/revenue    book real sponsor revenue             (X-Admin-Token)
//   GET  /v1/status        is the brain (home PC) awake? {mode: full | lowlight}
//   POST /v1/files, GET|DELETE /v1/files/:id   chat files, stored on the brain
//   POST /internal/lane|net|ledger   the brain calling back for models, the web
//                          and the ledger                        (X-Brain-Token)
// Every /v1 route except status, impact, companions, tools and ads needs a
// signed-in Cloak account (Supabase access token as Bearer).

import { LANES, PUBLIC_LANES } from "./models.js";
import { companionList, COMPANIONS, BRANDS } from "./prompts.js";
import { probe } from "./engine.js";
import { runAgent, mindFor, setIO } from "./agent.js";
import { streamLane } from "./engine.js";
import { search, readPage } from "./tools.js";
import { execLane, execNet } from "./exec.js";
import { turn, brainState, checkBrain, statusBody, toBrain, markDown } from "./brainlink.js";
import { friendly } from "./run.js";
import { catalog } from "./tools.js";
import { handleSpeech } from "../../api-worker/src/speech.js";
export { Ledger } from "./ledger.js";
export { Mind } from "./mind.js";
export { AgentRun } from "./run.js";
export { Exec } from "./exec.js";

// Model calls and web fetches go through Exec when it is bound: one outbound
// request each, however much failover happens inside.
setIO({
  lane: (env, lane, opts, ctx) => (env.EXEC ? execLane(env, lane, opts) : streamLane(env, ctx, lane, opts)),
  net: (env) => (env.EXEC ? execNet(env) : null),
});

const VERSION = "0.2.0";
const MAX_TURNS = 60;
const MAX_CHARS = 60_000;
const IMG_MAX = 3;
const IMG_MAX_B64 = 6_000_000;

// Browsers allowed to call the API. CORS is not security, but it keeps other
// sites from spending the shared free keys by accident. Extra origins:
// ALLOWED_ORIGINS var, comma separated.
const ORIGINS = [/^https:\/\/([a-z0-9-]+\.)?usecloak\.org$/, /^https:\/\/[a-z0-9-]+\.pages\.dev$/, /^https:\/\/[a-z0-9-]+\.workers\.dev$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

function corsFor(request, env) {
  const origin = request.headers.get("Origin") || "";
  const extra = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = ORIGINS.some((re) => re.test(origin)) || extra.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : "https://usecloak.org",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device, X-Admin-Token, X-File-Name",
    "Access-Control-Expose-Headers": "X-Run-Id, X-Run-Status",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (data, cors, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } });

// Per-IP limiter (per isolate). Coarse on purpose: stops a loop, not a person.
const hits = new Map();
function limited(ip, max = 24, windowMs = 60_000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

const ledger = (env) => env.LEDGER.get(env.LEDGER.idFromName("global"));

function readFiles(list) {
  if (!Array.isArray(list)) return [];
  let total = 0;
  const out = [];
  for (const f of list.slice(0, 24)) {
    if (!f || typeof f.name !== "string" || typeof f.code !== "string") continue;
    const code = f.code.slice(0, 200_000);
    if ((total += code.length) > 600_000) break;
    out.push({ name: f.name.replace(/[^\w.\-/ ]/g, "").slice(0, 80) || "file", code });
  }
  return out;
}
function sanitize(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  let chars = 0;
  for (const m of messages.slice(-MAX_TURNS)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (!content.trim()) continue;
    chars += content.length;
    out.push({ role: m.role, content });
  }
  // Keep the newest turns if the conversation is enormous.
  while (chars > MAX_CHARS && out.length > 1) chars -= out.shift().content.length;
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function readImages(body) {
  if (!Array.isArray(body.images)) return [];
  return body.images
    .filter((i) => i && typeof i.data === "string" && i.data.length < IMG_MAX_B64 && /^image\/(png|jpeg|webp|gif)$/.test(i.mime || ""))
    .slice(0, IMG_MAX);
}

// Who is asking. Signed in: the Supabase user id (token verified with
// Supabase). Otherwise: the device id, a random secret the app generated.
const tokenCache = new Map();
// Signed-in people's emails, by key: the brain's admins-only features check them.
const emails = new Map();
async function identify(request, body, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : typeof body?.token === "string" ? body.token : "";
  if (token && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    const hit = tokenCache.get(token);
    if (hit && hit.until > Date.now()) return hit.key;
    try {
      const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const u = await r.json();
        if (u?.id) {
          const key = `u:${u.id}`;
          if (u.email) { if (emails.size > 4000) emails.clear(); emails.set(key, String(u.email).toLowerCase()); }
          if (tokenCache.size > 2000) tokenCache.clear();
          tokenCache.set(token, { key, until: Date.now() + 5 * 60_000 });
          return key;
        }
      }
    } catch {}
  }
  // Blinks needs a Cloak account. A device id only counts while REQUIRE_AUTH
  // is "off" (local development, or before the site's sign-in shipped).
  if (env.REQUIRE_AUTH !== "off") return null;
  const device = request.headers.get("X-Device") || (typeof body?.device === "string" ? body.device : "");
  return /^[\w-]{24,80}$/.test(device) ? `d:${device}` : null;
}

function sseFrom(gen, abort, cors) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      try {
        for await (const ev of gen) send(ev.done ? { ...ev, text: undefined } : ev);
      } catch (e) {
        console.error("[blinks-api] all models failed", JSON.stringify(e.tried || String(e.message || e)));
        send({ error: friendly(e) });
      }
      controller.close();
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, { headers: { ...cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}

const RUN_ID = /^[\w-]{16,64}$/;

async function handleChat(request, env, ctx, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  if (limited(ip)) return json({ error: "Slow down a little. Try again in a minute." }, cors, 429);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, cors, 400);
  }
  const userKey = await identify(request, body, env);
  if (!userKey) return json({ error: "Sign in with your Cloak account to use Blinks.", signin: true }, cors, 401);
  const messages = sanitize(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "messages must end with a user turn" }, cors, 400);

  const req = {
    brand: body.brand,
    companion: body.companion,
    bot: body.bot && typeof body.bot === "object" ? { id: body.bot.id, name: body.bot.name, purpose: body.bot.purpose, persona: body.bot.persona, lane: body.bot.lane } : null,
    // The person's other Blinks, so theirs can message each other (brain only).
    blinks: Array.isArray(body.blinks) ? body.blinks.slice(0, 13).filter((b) => b && typeof b.id === "string").map((b) => ({ id: String(b.id).slice(0, 40), name: String(b.name || "").slice(0, 32), purpose: String(b.purpose || "").slice(0, 160), persona: String(b.persona || "").slice(0, 1500), lane: String(b.lane || "").slice(0, 12) })) : [],
    // The chat's code canvas (latest version of each file), for grep_files and read_file.
    files: readFiles(body.files),
    mode: ["auto", "swift", "deep", "research", "team"].includes(body.mode) ? body.mode : "auto",
    messages,
    images: readImages(body),
    user: body.user && typeof body.user === "object" ? { name: body.user.name, about: body.user.about, tz: body.user.tz } : {},
    userKey,
    email: emails.get(userKey) || null,
    country: request.cf?.country || null,
    max_tokens: body.max_tokens,
    chat_id: typeof body.chat_id === "string" ? body.chat_id.slice(0, 64) : null,
  };

  // Cloud run: the work continues if this connection drops.
  if (typeof body.run_id === "string" && RUN_ID.test(body.run_id) && env.AGENT_RUN) {
    const stub = env.AGENT_RUN.get(env.AGENT_RUN.idFromName(body.run_id));
    const res = await stub.fetch("https://run/start", { method: "POST", body: JSON.stringify(req) });
    return new Response(res.body, { status: res.status, headers: { ...cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Run-Id": body.run_id } });
  }
  const abort = new AbortController();
  return sseFrom(turn(env, ctx, req, abort.signal), abort, cors);
}

async function handleRun(request, env, cors, id, action) {
  const stub = env.AGENT_RUN.get(env.AGENT_RUN.idFromName(id));
  const u = new URL(request.url);
  const res = await stub.fetch(`https://run/${action || "events"}${u.search}`, { method: request.method });
  const headers = { ...cors, "Content-Type": res.headers.get("Content-Type") || "application/json" };
  if (res.headers.get("X-Run-Status")) Object.assign(headers, { "X-Run-Status": res.headers.get("X-Run-Status"), "Access-Control-Expose-Headers": "X-Run-Status", "Cache-Control": "no-cache, no-transform" });
  return new Response(res.body, { status: res.status, headers });
}

// The person's own data: memories, scheduled tasks, inbox.
async function handleMe(request, env, cors, path) {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const key = await identify(request, body, env);
  if (!key) return json({ error: "Sign in with your Cloak account to use Blinks.", signin: true }, cors, 401);
  // Memory, tasks and the inbox live on the brain while it is up.
  const s = await brainState(env);
  if (s.configured) {
    if (!s.up || s.paused) {
      if (path === "/v1/me" && request.method === "GET") return json({ power: "lowlight", memories: [], tasks: [], inbox: [] }, cors);
      return json({ error: "Memory and tasks are resting while Cloak is in Low Light.", power: "lowlight" }, cors, 503);
    }
    try {
      const res = await toBrain(env, path + new URL(request.url).search, { method: request.method, headers: { "Content-Type": "application/json", "X-User-Key": key, "X-User-Email": emails.get(key) || "" }, body: request.method === "GET" || request.method === "DELETE" ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      return new Response(res.body, { status: res.status, headers: { ...cors, "Content-Type": res.headers.get("Content-Type") || "application/json" } });
    } catch (e) {
      ctxWait(checkBrain(env));
      return json({ power: "lowlight", memories: [], tasks: [], inbox: [] }, cors, request.method === "GET" ? 200 : 503);
    }
  }
  const mind = mindFor(env, key);
  await mind.hello(key);
  const m = request.method;
  let r;
  if (path === "/v1/me" && m === "GET") return json(await mind.overview(), cors);
  if (path === "/v1/me" && m === "DELETE") return json({ ok: await mind.erase() }, cors);
  if (path === "/v1/memory" && m === "POST") return json(await mind.remember({ fact: body.fact, kind: body.kind, by: "you" }), cors);
  if (path === "/v1/memory" && m === "DELETE") return json({ ok: await mind.forgetAll() }, cors);
  if ((r = /^\/v1\/memory\/(\d+)$/.exec(path)) && m === "DELETE") return json({ ok: await mind.forgetId(+r[1]) }, cors);
  if (path === "/v1/tasks" && m === "POST") return json(await mind.addTask({ ...body, companion: COMPANIONS[body.companion] ? body.companion : "cloak", brand: BRANDS.includes(body.brand) ? body.brand : env.BRAND || "Cloak Blinks" }), cors);
  if ((r = /^\/v1\/tasks\/(\d+)$/.exec(path)) && m === "DELETE") return json({ ok: await mind.removeTask(+r[1]) }, cors);
  if (path === "/v1/inbox/seen" && m === "POST") return json({ ok: await mind.seen(body.ids) }, cors);
  if ((r = /^\/v1\/inbox\/(\d+)$/.exec(path)) && m === "DELETE") return json({ ok: await mind.removeInbox(+r[1]) }, cors);
  return json({ error: "Not found" }, cors, 404);
}

// Background work without a ctx (handleMe has none): best effort.
const ctxWait = (p) => { p?.catch?.(() => {}); };

// Chat files: stored on the brain, never here. Bytes stream straight through.
async function handleFiles(request, env, cors, path) {
  const key = await identify(request, null, env);
  if (!key) return json({ error: "Sign in with your Cloak account to use Blinks.", signin: true }, cors, 401);
  const s = await brainState(env);
  if (!s.up || s.paused) return json({ error: "Files are resting while Cloak is in Low Light. They will be back when it wakes up.", power: "lowlight" }, cors, 503);
  const headers = { "X-User-Key": key };
  for (const h of ["Content-Type", "Content-Length", "X-File-Name"]) if (request.headers.get(h)) headers[h] = request.headers.get(h);
  try {
    const res = await toBrain(env, path, { method: request.method, headers, body: request.method === "POST" ? request.body : undefined, signal: AbortSignal.timeout(120_000) });
    const out = { ...cors };
    for (const h of ["Content-Type", "Content-Length", "Content-Disposition", "Cache-Control"]) if (res.headers.get(h)) out[h] = res.headers.get(h);
    return new Response(res.body, { status: res.status, headers: out });
  } catch (e) {
    ctxWait(checkBrain(env));
    return json({ error: "Could not reach Cloak's files right now. Try again in a moment.", power: "lowlight" }, cors, 503);
  }
}

// The brain calling back: models, the web and the ledger. Each call is its
// own invocation here, so the brain is never short of request budget.
async function handleInternal(request, env, ctx, path) {
  if (!env.BRAIN_TOKEN || request.headers.get("X-Brain-Token") !== env.BRAIN_TOKEN) return new Response("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (path === "/internal/lane") {
    const enc = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    ctx.waitUntil((async () => {
      try {
        for await (const ev of streamLane(env, ctx, body.lane, { ...(body.opts || {}), signal: request.signal })) await w.write(enc.encode(JSON.stringify(ev) + "\n"));
      } catch (e) {
        await w.write(enc.encode(JSON.stringify({ error: String(e?.message || e).slice(0, 500), tried: e?.tried }) + "\n")).catch(() => {});
      }
      await w.close().catch(() => {});
    })());
    return new Response(readable, { headers: { "Content-Type": "application/x-ndjson" } });
  }
  if (path === "/internal/net") {
    try {
      if (body.kind === "search") return Response.json({ ok: true, data: await search(env, String(body.query || ""), !!body.recent) });
      if (body.kind === "read") return Response.json({ ok: true, data: await readPage(env, String(body.url || "")) });
    } catch (e) {
      return Response.json({ ok: false, error: String(e?.message || e).slice(0, 300) });
    }
    return Response.json({ ok: false, error: "unknown kind" }, { status: 400 });
  }
  if (path === "/internal/ledger") return Response.json(await ledger(env).recordReply(body));
  return new Response("Not found", { status: 404 });
}

async function handleAdmin(request, env, ctx, cors, path) {
  if (!env.ADMIN_TOKEN || request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) return json({ error: "Unauthorized" }, cors, 401);
  if (path === "/admin/probe" && request.method === "GET") return json({ checked: new Date().toISOString(), models: await probe(env, ctx) }, cors);
  if (request.method !== "POST") return json({ error: "Not found" }, cors, 404);
  const body = await request.json().catch(() => ({}));
  if (path === "/admin/offsets") {
    const r = await ledger(env).addOffset(body);
    return json(r, cors, r.ok ? 200 : 400);
  }
  if (path === "/admin/revenue") return json(await ledger(env).bookRevenue(body), cors);
  // A one-time pairing code for the brain installer (the payload holds its
  // tunnel token and settings; the brain token is filled in here).
  if (path === "/admin/pair") {
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const raw = Array.from(bytes, (b) => abc[b % abc.length]).join("");
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    return json(await ledger(env).putPair(code, { ...body, brainToken: env.BRAIN_TOKEN }), cors);
  }
  return json({ error: "Not found" }, cors, 404);
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsFor(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/" && request.method === "GET") return json({ service: "cloak-blinks-api", version: VERSION, lanes: PUBLIC_LANES }, cors);
      if (path === "/v1/chat" && request.method === "POST") return await handleChat(request, env, ctx, cors);
      if (path === "/v1/status" && request.method === "GET") return json(statusBody(await brainState(env)), cors, 200, { "Cache-Control": "no-store" });
      if (path === "/v1/files" || path.startsWith("/v1/files/")) return await handleFiles(request, env, cors, path);
      if (path.startsWith("/internal/")) return await handleInternal(request, env, ctx, path);
      let pm;
      if ((pm = /^\/v1\/pair\/([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(path)) && request.method === "GET") {
        if (limited(`pair:${request.headers.get("CF-Connecting-IP") || "anon"}`, 5)) return json({ error: "Too many tries. Wait a minute." }, cors, 429);
        const payload = await ledger(env).takePair(pm[1]);
        return payload ? json(payload, cors, 200, { "Cache-Control": "no-store" }) : json({ error: "That code is wrong, used or expired. Make a new one." }, cors, 404);
      }
      let m;
      if ((m = /^\/v1\/runs\/([\w-]{16,64})(?:\/(cancel))?$/.exec(path))) return await handleRun(request, env, cors, m[1], m[2]);
      if (path === "/v1/me" || path.startsWith("/v1/memory") || path.startsWith("/v1/tasks") || path.startsWith("/v1/inbox") || path.startsWith("/v1/blink/") || path.startsWith("/v1/computer")) return await handleMe(request, env, cors, path);
      if (path === "/v1/tools" && request.method === "GET") return json({ tools: catalog(), modes: ["auto", "swift", "deep", "research", "team"] }, cors, 200, { "Cache-Control": "public, max-age=300" });
      if (path === "/v1/speech" || path === "/v1/speech/voices") {
        if (path === "/v1/speech" && limited(`tts:${request.headers.get("CF-Connecting-IP") || "anon"}`, 20)) return json({ error: "Slow down a little." }, cors, 429);
        return await handleSpeech(env, request, ctx, { json: (d, st = 200) => json(d, cors, st), cors });
      }
      if (path === "/v1/companions" && request.method === "GET") {
        const lanes = PUBLIC_LANES.map((k) => ({ id: k, label: LANES[k].label, blurb: LANES[k].blurb }));
        return json({ companions: companionList(), lanes }, cors, 200, { "Cache-Control": "public, max-age=300" });
      }
      if (path === "/v1/impact" && request.method === "GET") {
        const days = Number(url.searchParams.get("days")) || 90;
        return json(await ledger(env).summary(days), cors, 200, { "Cache-Control": "public, max-age=60" });
      }
      if (path === "/v1/ads/event" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "anon";
        if (limited(`ad:${ip}`, 40)) return json({ ok: true }, cors);
        const b = await request.json().catch(() => ({}));
        if (b.kind === "view" || b.kind === "click") ctx.waitUntil(ledger(env).recordAd({ sponsor: b.sponsor, kind: b.kind }).catch(() => {}));
        return json({ ok: true }, cors);
      }
      if (path.startsWith("/admin/")) return await handleAdmin(request, env, ctx, cors, path);
      return json({ error: "Not found" }, cors, 404);
    } catch (e) {
      console.error("[blinks-api] unhandled", e?.stack || e);
      return json({ error: "Something went wrong." }, cors, 500);
    }
  },

  // Every minute: is the brain awake?
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkBrain(env));
  },
};
