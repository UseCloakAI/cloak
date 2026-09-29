// Free-tier governor — keeps every upstream call inside each provider's free limits.
//
//   • Keyring: PROVIDER_KEYS is read from KV at most once a minute per isolate
//     (KV free tier = 100k reads/day; every chat used to cost 2–3 reads).
//   • Key health: rate-limit headers + 429s put a key (or a dead model) on
//     cooldown, so we stop spending requests on keys that will just 429 again.
//     Cooldowns are shared across isolates in the same colo via the Cache API.
//   • Rotation: healthy keys are tried round-robin, so pooled free keys wear
//     evenly instead of key #1 burning its daily quota first.
//   • Fit: prompt + max_tokens is sized under the model's tokens-per-minute cap
//     (Groq counts max_tokens against TPM), trimming the oldest turns if needed.

// Conservative free-tier defaults. Groq values are replaced live by the
// x-ratelimit-limit-* headers it returns. rpd/tpd are informational.
const LIMITS = {
  "groq:llama-3.3-70b-versatile": { rpm: 30, rpd: 1000, tpm: 12000, ctx: 131072 },
  "groq:llama-3.1-8b-instant": { rpm: 30, rpd: 14400, tpm: 6000, ctx: 131072 },
  "groq:openai/gpt-oss-120b": { rpm: 30, rpd: 1000, tpm: 8000, ctx: 131072 },
  "groq:openai/gpt-oss-20b": { rpm: 30, rpd: 1000, tpm: 8000, ctx: 131072 },
  "groq:qwen/qwen3.8-27b": { rpm: 30, rpd: 1000, tpm: 6000, ctx: 131072 },
  "groq:qwen/qwen3.6-27b": { rpm: 30, rpd: 1000, tpm: 6000, ctx: 131072 },
  "groq:*": { rpm: 30, rpd: 1000, tpm: 6000, ctx: 32768 },
  "nvidia:moonshotai/kimi-k3": { rpm: 40, rpd: 0, tpm: 0, ctx: 131072 },
  "nvidia:z-ai/glm-5.3": { rpm: 40, rpd: 0, tpm: 0, ctx: 131072 },
  "nvidia:poolside/laguna-xs-2.1": { rpm: 40, rpd: 0, tpm: 0, ctx: 131072 },
  "nvidia:*": { rpm: 40, rpd: 0, tpm: 0, ctx: 65536 },
  "gemini:gemini-3.8-flash": { rpm: 5, rpd: 20, tpm: 250000, ctx: 1000000 },
  "gemini:gemini-3.5-flash-lite": { rpm: 15, rpd: 500, tpm: 250000, ctx: 1000000 },
  "gemini:*": { rpm: 10, rpd: 250, tpm: 250000, ctx: 1000000 },
};

const KEYRING_TTL_MS = 60_000;
const DEAD_MODEL_MS = 6 * 3600_000;
const DEFAULT_COOL_MS = 20_000;
const LOW_TOKENS = 1200; // below this many TPM tokens left, wait for the window to reset
const SHARE_EVERY_MS = 30_000;
const CACHE_ORIGIN = "https://governor.cloak.internal/";

// ── token estimate ──────────────────────────────────────────────────────────
// ~3.6 chars/token over-counts English slightly (safer for staying under caps).
export function estimateTokens(s) {
  return s ? Math.ceil(String(s).length / 3.6) : 0;
}

function contentTokens(content) {
  if (typeof content === "string") return estimateTokens(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const p of content) {
    if (p?.type === "text") n += estimateTokens(p.text);
    else if (p?.type === "image_url") n += 1100;
  }
  return n;
}

export function estimateMessages(messages) {
  let n = 0;
  for (const m of messages) {
    n += 4 + contentTokens(m.content);
    if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return n;
}

// ── limits ──────────────────────────────────────────────────────────────────
const learned = new Map(); // "provider:model" → { tpm, rpd }

export function limitsFor(provider, model) {
  const base = LIMITS[`${provider}:${model}`] || LIMITS[`${provider}:*`] || { rpm: 30, tpm: 0, ctx: 32768 };
  const l = learned.get(`${provider}:${model}`);
  return l ? { ...base, ...l } : base;
}

// ── keyring (KV, cached) ────────────────────────────────────────────────────
let keyring = null;
let keyringAt = 0;

export async function readKeyring(env) {
  if (keyring && Date.now() - keyringAt < KEYRING_TTL_MS) return keyring;
  const raw = await env.PROVIDER_KEYS.get("keys");
  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) || {};
    } catch {
      parsed = {};
    }
  }
  keyring = parsed;
  keyringAt = Date.now();
  return keyring;
}

export function invalidateKeyring() {
  keyring = null;
  keyringAt = 0;
}

// ── key health ──────────────────────────────────────────────────────────────
const health = new Map(); // id → { coolUntil, tokensLeft, reason }
const recent = new Map(); // id → timestamps of calls in the last minute
let rr = 0;
let lastShareSync = 0;

// FNV-1a so cooldown ids never contain key material.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const keyId = (provider, key) => `${provider}.${hash(key)}`;
const modelId = (provider, model) => `${provider}.m.${hash(model)}`;

function cooling(id, now = Date.now()) {
  const h = health.get(id);
  return !!(h && h.coolUntil > now);
}

function overRpm(id, provider, model, now) {
  const list = recent.get(id);
  if (!list) return false;
  while (list.length && now - list[0] > 60_000) list.shift();
  const rpm = limitsFor(provider, model).rpm || 30;
  return list.length >= rpm;
}

export function modelDead(provider, model) {
  return cooling(modelId(provider, model));
}

// Orders (attempt × key) candidates: healthy first, round-robin within each
// provider group; cooling ones last as a final resort.
export function orderCandidates(groups) {
  const now = Date.now();
  const healthy = [];
  const cold = [];
  rr = (rr + 1) % 1_000_000;
  for (const g of groups) {
    if (modelDead(g.provider, g.model)) continue;
    const keys = g.keys;
    const start = keys.length ? rr % keys.length : 0;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length];
      const id = keyId(g.provider, key);
      const c = { ...g, key, id };
      delete c.keys;
      if (cooling(id, now) || overRpm(id, g.provider, g.model, now)) cold.push(c);
      else healthy.push(c);
    }
  }
  cold.sort((a, b) => (health.get(a.id)?.coolUntil || 0) - (health.get(b.id)?.coolUntil || 0));
  return { healthy, cold };
}

function cool(id, ms, reason, shareCtx) {
  const until = Date.now() + Math.max(1000, ms);
  const h = health.get(id) || {};
  if ((h.coolUntil || 0) >= until) return;
  health.set(id, { ...h, coolUntil: until, reason });
  if (shareCtx) shareCooldown(shareCtx, id, until);
}

// "1m30.5s" / "7.66s" / "450ms" / "2h" → ms
export function parseDuration(s) {
  if (!s) return 0;
  const str = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1000);
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m;
  while ((m = re.exec(str))) {
    const v = parseFloat(m[1]);
    ms += m[2] === "h" ? v * 3600_000 : m[2] === "m" ? v * 60_000 : m[2] === "s" ? v * 1000 : v;
  }
  return Math.round(ms);
}

// Call before sending: counts toward the per-minute request window.
export function noteCall(id) {
  const list = recent.get(id) || [];
  list.push(Date.now());
  if (list.length > 120) list.splice(0, list.length - 120);
  recent.set(id, list);
}

// Call after any upstream response (ok or not). Learns limits from headers.
export function observe({ provider, model, key, res, bodyText, ctx }) {
  const id = keyId(provider, key);
  const hd = res.headers;

  if (provider === "groq") {
    const limTok = Number(hd.get("x-ratelimit-limit-tokens"));
    const limReq = Number(hd.get("x-ratelimit-limit-requests"));
    if (limTok > 0 || limReq > 0) {
      const cur = learned.get(`${provider}:${model}`) || {};
      if (limTok > 0) cur.tpm = limTok;
      if (limReq > 0) cur.rpd = limReq;
      learned.set(`${provider}:${model}`, cur);
    }
    const leftReq = hd.get("x-ratelimit-remaining-requests");
    const leftTok = hd.get("x-ratelimit-remaining-tokens");
    if (leftReq !== null && Number(leftReq) <= 0) {
      cool(id, parseDuration(hd.get("x-ratelimit-reset-requests")) || 3600_000, "daily requests", ctx);
    } else if (leftTok !== null && Number(leftTok) < LOW_TOKENS) {
      cool(id, parseDuration(hd.get("x-ratelimit-reset-tokens")) || DEFAULT_COOL_MS, "minute tokens", ctx);
    }
    if (leftTok !== null) {
      const h = health.get(id) || {};
      health.set(id, { ...h, tokensLeft: Number(leftTok) });
    }
  }

  if (res.status === 429) {
    let ms = parseDuration(hd.get("retry-after"));
    if (!ms && bodyText) {
      const m = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?s)/.exec(bodyText) || /try again in ([\dhms.]+)/i.exec(bodyText);
      if (m) ms = parseDuration(m[1]);
    }
    const daily = /per day|RPD|TPD|daily/i.test(bodyText || "");
    cool(id, ms || (daily ? 3600_000 : DEFAULT_COOL_MS), daily ? "daily quota" : "rate limited", ctx);
  } else if (
    (res.status === 404 && /model/i.test(bodyText || "")) ||
    (res.status === 400 && /model_not_found|model_decommissioned|decommissioned|unknown model|model .{0,40}(does not exist|not found|no longer supported)/i.test(bodyText || ""))
  ) {
    // Retired/unknown model: skip it for a few hours instead of paying a failed call every request.
    cool(modelId(provider, model), DEAD_MODEL_MS, "model unavailable", ctx);
  } else if (res.status === 401 || res.status === 403) {
    cool(id, 600_000, "auth", ctx);
  }
}

// Worker-wide snapshot for GET /v1/usage (this isolate's view).
export function snapshot() {
  const now = Date.now();
  const keys = [];
  for (const [id, h] of health) {
    if (h.coolUntil > now || h.tokensLeft !== undefined) {
      keys.push({ id, coolingFor: Math.max(0, Math.round((h.coolUntil - now) / 1000)) || 0, reason: h.reason || null, tokensLeft: h.tokensLeft ?? null });
    }
  }
  const limits = {};
  for (const k of Object.keys(LIMITS)) limits[k] = { ...LIMITS[k] };
  for (const [k, v] of learned) limits[k] = { ...(limits[k] || LIMITS[`${k.split(":")[0]}:*`] || {}), ...v };
  return { keys, limits };
}

// ── cross-isolate cooldown sharing (Cache API; free, no KV writes) ──────────
function shareCooldown(ctx, id, until) {
  try {
    const ttl = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    const res = new Response(String(until), { headers: { "Cache-Control": `max-age=${ttl}` } });
    const p = caches.default.put(CACHE_ORIGIN + id, res).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(p);
  } catch {}
}

// Pulls peers' cooldowns for these ids at most every SHARE_EVERY_MS.
export async function syncCooldowns(ids) {
  const now = Date.now();
  if (now - lastShareSync < SHARE_EVERY_MS || !ids.length) return;
  lastShareSync = now;
  try {
    const hits = await Promise.all(ids.map((id) => caches.default.match(CACHE_ORIGIN + id).catch(() => null)));
    await Promise.all(
      hits.map(async (r, i) => {
        if (!r) return;
        const until = Number(await r.text());
        if (until > Date.now()) {
          const h = health.get(ids[i]) || {};
          if ((h.coolUntil || 0) < until) health.set(ids[i], { ...h, coolUntil: until, reason: h.reason || "peer" });
        }
      }),
    );
  } catch {}
}

// ── fit a request under the model's free-tier caps ──────────────────────────
function clipMiddle(s, maxTokens) {
  const maxChars = Math.max(200, Math.floor(maxTokens * 3.6));
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 40;
  return `${s.slice(0, head)}\n…[${s.length - head - tail} chars trimmed]…\n${s.slice(-tail)}`;
}

// Drops oldest turns (keeping system + the final message, and tool-call pairs
// together) until the prompt fits `budget` tokens; then clips long messages.
export function trimMessages(messages, budget) {
  const sys = messages.filter((m) => m.role === "system");
  let rest = messages.filter((m) => m.role !== "system");
  const sysTok = estimateMessages(sys);
  let total = sysTok + estimateMessages(rest);
  let dropped = 0;
  while (total > budget && rest.length > 1) {
    const first = rest[0];
    let n = 1;
    if (first.role === "assistant" && first.tool_calls) while (rest[n] && rest[n].role === "tool") n++;
    rest = rest.slice(n);
    dropped += n;
    // Never lead with an orphan tool result or assistant turn.
    while (rest.length > 1 && (rest[0].role === "tool" || rest[0].role === "assistant")) {
      rest = rest.slice(1);
      dropped++;
    }
    total = sysTok + estimateMessages(rest);
  }
  if (total > budget) {
    // Only oversized messages left — clip the longest string ones from the middle.
    const room = Math.max(300, budget - sysTok);
    const per = Math.floor(room / Math.max(1, rest.length));
    rest = rest.map((m) => (typeof m.content === "string" && estimateTokens(m.content) > per ? { ...m, content: clipMiddle(m.content, per) } : m));
  }
  return { messages: [...sys, ...rest], dropped };
}

// Returns a spec sized for this provider/model: max_tokens clamped so
// prompt + max_tokens stays under TPM, and history trimmed if it still won't fit.
export function fitSpec(provider, model, spec) {
  const lim = limitsFor(provider, model);
  const cap = Math.floor(Math.min(lim.ctx || 32768, lim.tpm || Infinity) * 0.92);
  let maxTokens = spec.maxTokens;
  let inTok = estimateMessages(spec.messages);
  const floor = Math.min(maxTokens, 900);
  if (inTok + maxTokens > cap) maxTokens = Math.max(floor, cap - inTok);
  let messages = spec.messages;
  let dropped = 0;
  if (inTok + maxTokens > cap) {
    const r = trimMessages(messages, cap - maxTokens);
    messages = r.messages;
    dropped = r.dropped;
    inTok = estimateMessages(messages);
  }
  return { ...spec, messages, maxTokens, inTokens: inTok, dropped };
}
