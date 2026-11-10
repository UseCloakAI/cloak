// cloak-preview-api — the backend for preview.usecloak.org (the rebrand
// prototype). Separate Worker from production cloak-api; shares only the
// provider key ring (KV) and the free-tier governor.
//
//   POST /v1/chat          SSE: {meta} {care?} {delta}… {done}
//   GET  /v1/companions    the five companions + public lanes
//   GET  /v1/impact        the public carbon ledger
//   POST /v1/ads/event     {sponsor, kind: "view" | "click"}
//   GET  /admin/probe      time every model in every lane        (X-Admin-Token)
//   POST /admin/offsets    record retired credits with a receipt (X-Admin-Token)
//   POST /admin/revenue    book real sponsor revenue             (X-Admin-Token)

import { LANES, PUBLIC_LANES, routeLane } from "./models.js";
import { buildSystem, companionList, COMPANIONS, BRANDS } from "./prompts.js";
import { detect, resources, careProtocol } from "./safety.js";
import { estimate } from "./carbon.js";
import { streamLane, probe } from "./engine.js";
export { Ledger } from "./ledger.js";

const VERSION = "0.1.0";
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
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

  const companionId = COMPANIONS[body.companion] ? body.companion : "pip";
  const companion = COMPANIONS[companionId];
  const brand = BRANDS.includes(body.brand) ? body.brand : env.BRAND || "Kith";
  const images = readImages(body);
  const last = messages[messages.length - 1];

  const signal = detect(messages);
  const crisis = signal?.level === "crisis";
  const res = signal ? resources(request.cf?.country) : null;
  const { lane, why } = routeLane({ text: last.content, hasImage: images.length > 0, mode: body.mode, home: companion.home, turns: messages.length, crisis });

  const system = buildSystem({
    brand,
    companion: companionId,
    lane,
    care: signal ? careProtocol(signal, res) : "",
    user: body.user && typeof body.user === "object" ? body.user : {},
    convictions: env.CONVICTIONS !== "off",
  });

  const upstream = images.length
    ? [...messages.slice(0, -1), { role: "user", content: [{ type: "text", text: last.content }, ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))] }]
    : messages;

  const enc = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      send({ meta: { companion: companionId, lane, lane_label: LANES[lane].label, why } });
      // Pinned by the app above the reply, whatever the model writes.
      if (crisis) send({ care: res });
      try {
        for await (const ev of streamLane(env, ctx, lane, { system, messages: upstream, maxTokens: body.max_tokens, signal: abort.signal })) {
          if (ev.delta) send({ delta: ev.delta });
          else if (ev.start) send({ start: { size: ev.size, first_token_ms: ev.firstTokenMs } });
          else if (ev.done) {
            const impact = estimate({ size: ev.size, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut });
            ctx.waitUntil(ledger(env).recordReply({ lane, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, wh: impact.wh, g: impact.g }).catch(() => {}));
            if (ev.tried?.some((t) => !t.ok)) console.warn("[preview-api] failover", JSON.stringify(ev.tried));
            send({ done: true, partial: !!ev.partial, lane, usage: { tokens_in: ev.tokensIn, tokens_out: ev.tokensOut }, impact });
          }
        }
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
