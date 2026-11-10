// cloak-preview-api — the backend for preview.usecloak.org (the rebrand
// prototype). Separate Worker from production cloak-api; shares only the
// provider key ring (KV) and the free-tier governor.
//
//   POST /v1/chat          agent run, SSE: {meta} {care?} {step}… {sources} {delta}… {done}
//   GET  /v1/runs/:id      re-attach to a cloud run (?from=N); POST …/cancel
//   GET  /v1/me            memories, scheduled tasks, inbox (X-Device or Bearer)
//   …    /v1/memory, /v1/tasks, /v1/inbox   manage them
//   GET  /v1/tools         tool catalog and modes
//   POST /v1/speech        text to speech (WAV); GET /v1/speech/voices
//   GET  /v1/companions    the five companions + public lanes
//   GET  /v1/impact        the public carbon ledger
//   POST /v1/ads/event     {sponsor, kind: "view" | "click"}
//   GET  /admin/probe      time every model in every lane        (X-Admin-Token)
//   POST /admin/offsets    record retired credits with a receipt (X-Admin-Token)
//   POST /admin/revenue    book real sponsor revenue             (X-Admin-Token)

import { LANES, PUBLIC_LANES } from "./models.js";
import { companionList, COMPANIONS, BRANDS } from "./prompts.js";
import { probe } from "./engine.js";
import { runAgent, mindFor } from "./agent.js";
import { catalog } from "./tools.js";
import { handleSpeech } from "../../api-worker/src/speech.js";
export { Ledger } from "./ledger.js";
export { Mind } from "./mind.js";
export { AgentRun } from "./run.js";

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
    "Access-Control-Allow-Origin": ok ? origin : "https://preview.usecloak.org",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device, X-Admin-Token",
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
          if (tokenCache.size > 2000) tokenCache.clear();
          tokenCache.set(token, { key, until: Date.now() + 5 * 60_000 });
          return key;
        }
      }
    } catch {}
  }
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
        console.error("[preview-api] all models failed", JSON.stringify(e.tried || String(e.message || e)));
        send({ error: "Every model is busy right now. Give it a moment and try again." });
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
  const messages = sanitize(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "messages must end with a user turn" }, cors, 400);

  const req = {
    brand: body.brand,
    companion: body.companion,
    bot: body.bot && typeof body.bot === "object" ? { id: body.bot.id, name: body.bot.name, purpose: body.bot.purpose, persona: body.bot.persona, lane: body.bot.lane } : null,
    mode: ["auto", "swift", "deep", "research", "team"].includes(body.mode) ? body.mode : "auto",
    messages,
    images: readImages(body),
    user: body.user && typeof body.user === "object" ? { name: body.user.name, about: body.user.about, tz: body.user.tz } : {},
    userKey: await identify(request, body, env),
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
  return sseFrom(runAgent(env, ctx, req, abort.signal), abort, cors);
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
  if (!key) return json({ error: "No identity. Send X-Device or sign in." }, cors, 401);
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
  return json({ error: "Not found" }, cors, 404);
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsFor(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/" && request.method === "GET") return json({ service: "cloak-preview-api", version: VERSION, lanes: PUBLIC_LANES }, cors);
      if (path === "/v1/chat" && request.method === "POST") return await handleChat(request, env, ctx, cors);
      let m;
      if ((m = /^\/v1\/runs\/([\w-]{16,64})(?:\/(cancel))?$/.exec(path))) return await handleRun(request, env, cors, m[1], m[2]);
      if (path === "/v1/me" || path.startsWith("/v1/memory") || path.startsWith("/v1/tasks") || path.startsWith("/v1/inbox")) return await handleMe(request, env, cors, path);
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
      console.error("[preview-api] unhandled", e?.stack || e);
      return json({ error: "Something went wrong." }, cors, 500);
    }
  },
};
