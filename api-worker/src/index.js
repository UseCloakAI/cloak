// CloakAPI — Cloudflare Worker serving https://api.usecloak.org
// Routes: native /v1/chat, OpenAI /v1/chat/completions, Anthropic /v1/messages,
// /v1/search, /admin/provider-keys. All chat routes support live token streaming.

import { PNEUMA, LOGOS, KAIROS, LINUS } from "./prompts.js";

const VERSION = "4.3.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Admin-Token, Authorization, x-api-key, anthropic-version",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };
const SSE_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

// Model IDs verified live on 2026-09-26 (NVIDIA /v1/models, Groq + Gemini docs).
const GEMINI_MODEL = "gemini-3.5-flash";
const NVIDIA_VISION_MODEL = "meta/llama-3.2-90b-vision-instruct";

const MODEL_CONFIG = {
  pneuma: {
    name: "Pneuma",
    systemPrompt: PNEUMA,
    providers: ["groq", "nvidia"],
    groqModel: "llama-3.3-70b-versatile",
    nvidiaModel: "nvidia/nemotron-3-super-120b-a12b",
    temperature: 0.9,
  },
  logos: {
    name: "Logos",
    systemPrompt: LOGOS,
    providers: ["groq", "nvidia"],
    groqModel: "llama-3.3-70b-versatile",
    nvidiaModel: "nvidia/nemotron-3-super-120b-a12b",
    temperature: 0.3,
  },
  kairos: {
    name: "Kairos",
    systemPrompt: KAIROS,
    providers: ["nvidia", "groq", "gemini"],
    nvidiaModel: "nvidia/nemotron-3-super-120b-a12b",
    groqModel: "llama-3.3-70b-versatile",
    temperature: 0.8,
  },
  linus: {
    name: "Linus",
    systemPrompt: LINUS,
    providers: ["nvidia", "groq"],
    nvidiaModel: "z-ai/glm-5.3",
    groqModel: "openai/gpt-oss-120b",
    temperature: 0.2,
  },
};
const VALID_MODELS = Object.keys(MODEL_CONFIG);

const UNAVAILABLE = "Cloak AI is currently unavailable. Please try again later.";
const DEFAULT_MAX_TOKENS = 2048;
const MAX_MAX_TOKENS = 8192;
// Time allowed to connect AND receive the first token before failing over.
const FIRST_TOKEN_TIMEOUT_MS = 25_000;
// Time allowed for a complete non-streaming response.
const FULL_RESPONSE_TIMEOUT_MS = 55_000;

class UpstreamError extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.rateLimited = rateLimited;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function clampMaxTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(Math.floor(n), MAX_MAX_TOKENS);
}

function resolveTier(model) {
  return VALID_MODELS.includes(model) ? model : "pneuma";
}

function buildSystemPrompt(config, extraSystem) {
  const extra = normalizeSystem(extraSystem);
  if (!extra) return config.systemPrompt;
  return `${config.systemPrompt}\n\n## ADDITIONAL INSTRUCTIONS FROM THE CLOAK APP\n${extra}`;
}

// Accepts a string or Anthropic-style [{type:"text", text}] blocks.
function normalizeSystem(system) {
  if (!system) return "";
  if (typeof system === "string") return system.trim();
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

// Keeps only well-formed chat messages; content may be string or content-part array.
function sanitizeMessages(messages) {
  return messages
    .filter((m) => m && typeof m === "object" && typeof m.role === "string")
    .map((m) => {
      const out = { role: m.role };
      if (typeof m.content === "string" || Array.isArray(m.content)) out.content = m.content;
      else if (m.content == null) out.content = m.role === "assistant" ? null : "";
      else out.content = String(m.content);
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
      return out;
    });
}

async function getKeys(env, provider) {
  const raw = await env.PROVIDER_KEYS.get("keys");
  if (!raw) throw new UpstreamError("No keys found in KV");
  let keys;
  try {
    keys = JSON.parse(raw);
  } catch {
    throw new UpstreamError("PROVIDER_KEYS.keys is not valid JSON");
  }
  const list = Array.isArray(keys[provider]) ? keys[provider].filter(Boolean) : [];
  if (list.length === 0) throw new UpstreamError(`No keys for provider: ${provider}`);
  return list;
}

// Removes <think>…</think> reasoning spans, including ones split across chunks,
// and leading whitespace before the first visible character.
function makeThinkStripper() {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let inThink = false;
  let buf = "";
  let started = false;
  let think = "";

  const partialSuffix = (s, tag) => {
    for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
      if (tag.startsWith(s.slice(-k))) return k;
    }
    return 0;
  };
  const emit = (s) => {
    if (!started) {
      s = s.replace(/^\s+/, "");
      if (s) started = true;
    }
    return s;
  };

  return {
    push(chunk) {
      buf += chunk;
      let out = "";
      for (;;) {
        if (inThink) {
          const i = buf.indexOf(CLOSE);
          if (i === -1) {
            const keep = partialSuffix(buf, CLOSE);
            think += buf.slice(0, buf.length - keep);
            buf = buf.slice(buf.length - keep);
            return emit(out);
          }
          think += buf.slice(0, i);
          buf = buf.slice(i + CLOSE.length);
          inThink = false;
          continue;
        }
        const i = buf.indexOf(OPEN);
        if (i === -1) {
          const keep = partialSuffix(buf, OPEN);
          out += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          return emit(out);
        }
        out += buf.slice(0, i);
        buf = buf.slice(i + OPEN.length);
        inThink = true;
      }
    },
    // Reasoning text captured since the last call.
    takeThink() {
      const t = think;
      think = "";
      return t;
    },
    flush() {
      const rest = inThink ? "" : buf;
      buf = "";
      return emit(rest);
    },
  };
}

function stripThinkFull(text) {
  const s = makeThinkStripper();
  return (s.push(text || "") + s.flush()).trim();
}

// Parses an upstream SSE body into `data:` payload strings.
async function* sseData(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
    const tail = buf.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trimStart();
  } finally {
    reader.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider adapters
// Every adapter call yields normalized deltas: { content?, tool_calls?, finish_reason? }
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_COMPAT = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
};

function openAIBody({ model, messages, temperature, maxTokens, tools, toolChoice, stream }) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (tools && tools.length) {
    body.tools = tools;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
  }
  if (stream) body.stream = true;
  return body;
}

// Gemini: OpenAI-style messages → contents + systemInstruction.
function toGeminiRequest(messages, temperature, maxTokens) {
  const systemParts = [];
  const contents = [];
  for (const m of messages) {
    const parts = toGeminiParts(m.content);
    if (!parts.length) continue;
    if (m.role === "system") {
      systemParts.push(...parts.filter((p) => p.text));
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const req = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (systemParts.length) req.systemInstruction = { parts: systemParts };
  return req;
}

function toGeminiParts(content) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const p of content) {
    if (p?.type === "text" && p.text) parts.push({ text: p.text });
    if (p?.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      const m = /^data:([^;]+);base64,(.+)$/.exec(url || "");
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }
  }
  return parts;
}

function geminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
}

function geminiFinish(data) {
  const r = data?.candidates?.[0]?.finishReason;
  if (!r) return undefined;
  return r === "MAX_TOKENS" ? "length" : "stop";
}

// Sends one request with one key. Returns the upstream Response or throws UpstreamError.
async function sendUpstream(provider, apiKey, spec, stream, signal) {
  let url;
  let headers;
  let body;
  if (provider === "gemini") {
    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    url = `https://generativelanguage.googleapis.com/v1beta/models/${spec.model}:${method}`;
    headers = { "Content-Type": "application/json", "x-goog-api-key": apiKey };
    body = toGeminiRequest(spec.messages, spec.temperature, spec.maxTokens);
  } else {
    url = OPENAI_COMPAT[provider];
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    body = openAIBody({ ...spec, stream });
  }

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    throw new UpstreamError(`${provider} network: ${e.name === "AbortError" ? "timeout" : e.message}`);
  }
  if (res.status === 429) {
    res.body?.cancel().catch(() => {});
    throw new UpstreamError(`${provider} (${spec.model}) 429 rate limited`, { rateLimited: true });
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {}
    throw new UpstreamError(`${provider} (${spec.model}) HTTP ${res.status}: ${detail}`);
  }
  return res;
}

// Normalized stream of deltas from an upstream streaming response.
async function* upstreamDeltas(provider, res) {
  for await (const data of sseData(res.body)) {
    if (data === "[DONE]") return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    if (provider === "gemini") {
      const content = geminiText(evt);
      const finish_reason = geminiFinish(evt);
      if (content || finish_reason) yield { content, finish_reason };
      continue;
    }
    if (evt.error) throw new UpstreamError(`${provider} stream error: ${JSON.stringify(evt.error).slice(0, 200)}`);
    const choice = evt.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    const out = {};
    if (typeof d.content === "string" && d.content) out.content = d.content;
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === "string" && r) out.reasoning = r;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) out.tool_calls = d.tool_calls;
    if (choice.finish_reason) out.finish_reason = choice.finish_reason;
    if (out.content || out.reasoning || out.tool_calls || out.finish_reason) yield out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing with failover
// ─────────────────────────────────────────────────────────────────────────────

// Builds the ordered list of attempts: [{provider, model}]
function planAttempts(config, { hasImage, hasTools }) {
  if (hasImage) {
    return [
      { provider: "gemini", model: GEMINI_MODEL },
      { provider: "nvidia", model: NVIDIA_VISION_MODEL },
    ];
  }
  return config.providers
    .filter((p) => !(p === "gemini" && hasTools)) // Gemini adapter has no tool support
    .map((p) => ({
      provider: p,
      model: p === "groq" ? config.groqModel : p === "nvidia" ? config.nvidiaModel : GEMINI_MODEL,
    }));
}

function withImage(messages, imageBase64, mimeType) {
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== "user") continue;
    const text =
      typeof out[i].content === "string" && out[i].content.trim() && out[i].content !== "[Image]"
        ? out[i].content
        : "What is in this image?";
    out[i] = {
      role: "user",
      content: [
        { type: "text", text },
        { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` } },
      ],
    };
    break;
  }
  return out;
}

function prepare(tierKey, req) {
  const config = MODEL_CONFIG[tierKey];
  const hasImage = !!(req.imageBase64 && String(req.imageBase64).trim());
  const hasTools = !!(req.tools && req.tools.length);
  const system = { role: "system", content: buildSystemPrompt(config, req.system) };
  const base = [system, ...req.messages];
  return {
    config,
    hasTools,
    attempts: planAttempts(config, { hasImage, hasTools }),
    visionMessages: hasImage ? [system, ...withImage(req.messages, req.imageBase64, req.mimeType)] : null,
    textMessages: base,
    // If every vision provider fails, answer text-only on the normal providers.
    textFallback: hasImage ? planAttempts(config, { hasImage: false, hasTools }) : [],
  };
}

// Iterates every (attempt × key) combination.
async function* candidates(env, plan, errors) {
  const groups = [
    ...plan.attempts.map((a) => ({ ...a, messages: plan.visionMessages || plan.textMessages })),
    ...plan.textFallback.map((a) => ({ ...a, messages: plan.textMessages })),
  ];
  for (const g of groups) {
    let keys;
    try {
      keys = await getKeys(env, g.provider);
    } catch (e) {
      errors.push(`${g.provider}: ${e.message}`);
      continue;
    }
    for (const key of keys) yield { ...g, key };
  }
}

// Non-streaming: returns an OpenAI-style choice { message, finish_reason }.
async function completeOnce(env, tierKey, req) {
  const plan = prepare(tierKey, req);
  const errors = [];
  for await (const c of candidates(env, plan, errors)) {
    const spec = {
      model: c.model,
      messages: c.messages,
      temperature: plan.config.temperature,
      maxTokens: req.maxTokens,
      tools: c.provider === "gemini" ? undefined : req.tools,
      toolChoice: c.provider === "gemini" ? undefined : req.toolChoice,
    };
    try {
      const res = await sendUpstream(c.provider, c.key, spec, false, AbortSignal.timeout(FULL_RESPONSE_TIMEOUT_MS));
      const data = await res.json();
      let choice;
      if (c.provider === "gemini") {
        choice = {
          message: { role: "assistant", content: geminiText(data) },
          finish_reason: geminiFinish(data) || "stop",
        };
      } else {
        choice = data.choices?.[0];
      }
      if (!choice?.message) throw new UpstreamError(`${c.provider} (${c.model}) returned no choices`);
      const content = stripThinkFull(choice.message.content || "");
      const hasToolCalls = Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0;
      if (!content && !hasToolCalls) throw new UpstreamError(`${c.provider} (${c.model}) returned empty content`);
      return {
        message: { ...choice.message, content: content || null },
        finish_reason: choice.finish_reason || "stop",
        provider: c.provider,
      };
    } catch (e) {
      errors.push(e.name === "TimeoutError" ? `${c.provider} (${c.model}) timeout` : e.message);
    }
  }
  console.error(`[cloak-api] all providers failed tier=${tierKey}: ${errors.join(" | ")}`);
  throw new Error(UNAVAILABLE);
}

// Streaming: fails over until a provider produces its first token, then commits.
// Returns { provider, deltas } where deltas is an async iterator of normalized deltas
// with <think> spans already stripped.
async function openStream(env, tierKey, req) {
  const plan = prepare(tierKey, req);
  const errors = [];
  for await (const c of candidates(env, plan, errors)) {
    const spec = {
      model: c.model,
      messages: c.messages,
      temperature: plan.config.temperature,
      maxTokens: req.maxTokens,
      tools: c.provider === "gemini" ? undefined : req.tools,
      toolChoice: c.provider === "gemini" ? undefined : req.toolChoice,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FIRST_TOKEN_TIMEOUT_MS);
    try {
      const res = await sendUpstream(c.provider, c.key, spec, true, ctrl.signal);
      const stripper = makeThinkStripper();
      const raw = upstreamDeltas(c.provider, res);
      const cleaned = (async function* () {
        for await (const d of raw) {
          const out = { ...d };
          if (d.content) out.content = stripper.push(d.content);
          const think = (d.reasoning || "") + stripper.takeThink();
          if (think) out.reasoning = think;
          else delete out.reasoning;
          if (out.content || out.reasoning || out.tool_calls || out.finish_reason) yield out;
        }
        const tail = stripper.flush();
        if (tail) yield { content: tail };
      })();

      // Peek until the first visible token or tool call before committing.
      const buffered = [];
      let committed = false;
      for (;;) {
        const { value, done } = await cleaned.next();
        if (done) break;
        buffered.push(value);
        if (value.content || value.reasoning || value.tool_calls) {
          committed = true;
          break;
        }
      }
      clearTimeout(timer);
      if (!committed) throw new UpstreamError(`${c.provider} (${c.model}) returned empty stream`);

      const deltas = (async function* () {
        yield* buffered;
        yield* cleaned;
      })();
      return { provider: c.provider, model: c.model, deltas };
    } catch (e) {
      clearTimeout(timer);
      errors.push(ctrl.signal.aborted ? `${c.provider} (${c.model}) first-token timeout` : e.message);
    }
  }
  console.error(`[cloak-api] all providers failed (stream) tier=${tierKey}: ${errors.join(" | ")}`);
  throw new Error(UNAVAILABLE);
}

// Writes SSE events produced by `produce(send)` into a streaming Response.
function sseResponse(produce) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj, event) => {
    const prefix = event ? `event: ${event}\n` : "";
    const payload = typeof obj === "string" ? obj : JSON.stringify(obj);
    return writer.write(enc.encode(`${prefix}data: ${payload}\n\n`));
  };
  (async () => {
    try {
      await produce(send);
    } catch (e) {
      console.error("[cloak-api] stream error:", e?.message || e);
    } finally {
      writer.close().catch(() => {});
    }
  })();
  return new Response(readable, { headers: SSE_HEADERS });
}

// ─────────────────────────────────────────────────────────────────────────────
// Native endpoint: POST /v1/chat
// Request:  { model, messages, system?, max_tokens?, imageBase64?, mimeType?, stream? }
// Response: { model, response }            (stream: false)
//           SSE data: {delta} … {done, model, response}  |  {error}   (stream: true)
// ─────────────────────────────────────────────────────────────────────────────

async function handleNativeChat(env, request) {
  const body = await readJson(request);
  if (!body || !Array.isArray(body.messages)) return json({ error: "messages array required" }, 400);

  const tierKey = resolveTier(body.model);
  const req = {
    messages: sanitizeMessages(body.messages),
    system: body.system,
    maxTokens: clampMaxTokens(body.max_tokens),
    imageBase64: body.imageBase64,
    mimeType: body.mimeType,
  };
  const name = MODEL_CONFIG[tierKey].name;

  if (body.stream === true) {
    let stream;
    try {
      stream = await openStream(env, tierKey, req);
    } catch (e) {
      return json({ error: e.message }, 503);
    }
    return sseResponse(async (send) => {
      let full = "";
      try {
        for await (const d of stream.deltas) {
          if (d.reasoning) await send({ think: d.reasoning });
          if (d.content) {
            full += d.content;
            await send({ delta: d.content });
          }
        }
        await send({ done: true, model: name, response: full });
      } catch (e) {
        console.error(`[cloak-api] mid-stream failure ${stream.provider}: ${e.message}`);
        await send({ error: "The response was interrupted. Please try again.", partial: full });
      }
    });
  }

  try {
    const choice = await completeOnce(env, tierKey, req);
    return json({ model: name, response: choice.message.content || "" });
  } catch (e) {
    return json({ error: e.message }, 503);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible endpoint: POST /v1/chat/completions
// ─────────────────────────────────────────────────────────────────────────────

function checkApiKey(env, request) {
  const validKey = env.API_KEY || "apikey";
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7) === validKey;
  const xApiKey = request.headers.get("x-api-key") || "";
  if (xApiKey) return xApiKey === validKey;
  return false;
}

async function handleOpenAIChat(env, request) {
  if (!checkApiKey(env, request)) {
    return json({ error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } }, 401);
  }
  const body = await readJson(request);
  if (!body || !Array.isArray(body.messages)) {
    return json({ error: { message: "messages array required", type: "invalid_request_error" } }, 400);
  }
  const tierKey = resolveTier(body.model || "pneuma");
  const req = {
    messages: sanitizeMessages(body.messages),
    maxTokens: clampMaxTokens(body.max_tokens ?? body.max_completion_tokens),
    tools: body.tools,
    toolChoice: body.tool_choice,
  };
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream === true) {
    let stream;
    try {
      stream = await openStream(env, tierKey, req);
    } catch (e) {
      return json({ error: { message: e.message, type: "server_error" } }, 503);
    }
    const chunk = (delta, finish_reason = null) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model: tierKey,
      choices: [{ index: 0, delta, finish_reason }],
    });
    return sseResponse(async (send) => {
      await send(chunk({ role: "assistant", content: "" }));
      let finish = "stop";
      let sawTools = false;
      try {
        for await (const d of stream.deltas) {
          const delta = {};
          if (d.content) delta.content = d.content;
          if (d.tool_calls) {
            delta.tool_calls = d.tool_calls;
            sawTools = true;
          }
          if (d.finish_reason) finish = d.finish_reason;
          if (delta.content || delta.tool_calls) await send(chunk(delta));
        }
      } catch (e) {
        console.error(`[cloak-api] mid-stream failure ${stream.provider}: ${e.message}`);
        await send({ error: { message: "stream interrupted", type: "server_error" } });
      }
      await send(chunk({}, sawTools && finish === "stop" ? "tool_calls" : finish));
      await send("[DONE]");
    });
  }

  try {
    const choice = await completeOnce(env, tierKey, req);
    return json({
      id,
      object: "chat.completion",
      created,
      model: tierKey,
      choices: [{ index: 0, message: choice.message, finish_reason: choice.finish_reason }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
    return json({ error: { message: e.message, type: "server_error" } }, 503);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic-compatible endpoint: POST /v1/messages
// ─────────────────────────────────────────────────────────────────────────────

function anthropicToolsToOpenAI(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  }));
}

function anthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice.type === "auto") return "auto";
  if (toolChoice === "any" || toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") return { type: "function", function: { name: toolChoice.name } };
  if (toolChoice.type === "none") return "none";
  return "auto";
}

function flattenAnthropicMessages(messages) {
  const out = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      out.push({ role: msg.role, content: String(msg.content ?? "") });
      continue;
    }
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    const toolResults = msg.content.filter((b) => b.type === "tool_result");
    for (const block of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content:
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
              : JSON.stringify(block.content ?? ""),
      });
    }
    if (toolUses.length) {
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolUses.map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        })),
      });
    } else if (text && !toolResults.length) {
      out.push({ role: msg.role, content: text });
    } else if (text) {
      out.push({ role: "user", content: text });
    }
  }
  return out;
}

function parseToolArgs(args) {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return { _raw: args };
  }
}

async function handleAnthropicMessages(env, request) {
  if (!checkApiKey(env, request)) {
    return json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } }, 401);
  }
  const body = await readJson(request);
  if (!body || !Array.isArray(body.messages)) {
    return json({ type: "error", error: { type: "invalid_request_error", message: "messages array required" } }, 400);
  }
  const tierKey = resolveTier(body.model || "pneuma");
  const req = {
    messages: sanitizeMessages(flattenAnthropicMessages(body.messages)),
    system: body.system,
    maxTokens: clampMaxTokens(body.max_tokens),
    tools: anthropicToolsToOpenAI(body.tools),
    toolChoice: anthropicToolChoiceToOpenAI(body.tool_choice),
  };
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;

  if (body.stream === true) {
    let stream;
    try {
      stream = await openStream(env, tierKey, req);
    } catch (e) {
      return json({ type: "error", error: { type: "api_error", message: e.message } }, 503);
    }
    return sseResponse(async (send) => {
      await send(
        {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: tierKey,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        "message_start",
      );
      let blockIndex = -1;
      let textOpen = false;
      let finish = "stop";
      const tools = new Map(); // index → { id, name, args }
      try {
        for await (const d of stream.deltas) {
          if (d.finish_reason) finish = d.finish_reason;
          if (d.content) {
            if (!textOpen) {
              blockIndex++;
              textOpen = true;
              await send(
                { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } },
                "content_block_start",
              );
            }
            await send(
              { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: d.content } },
              "content_block_delta",
            );
          }
          for (const tc of d.tool_calls || []) {
            const idx = tc.index ?? 0;
            const cur = tools.get(idx) || { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            tools.set(idx, cur);
          }
        }
      } catch (e) {
        console.error(`[cloak-api] mid-stream failure ${stream.provider}: ${e.message}`);
        await send({ type: "error", error: { type: "api_error", message: "stream interrupted" } }, "error");
        return;
      }
      if (textOpen) await send({ type: "content_block_stop", index: blockIndex }, "content_block_stop");
      for (const [, t] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
        blockIndex++;
        await send(
          {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: t.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`, name: t.name, input: {} },
          },
          "content_block_start",
        );
        await send(
          {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(parseToolArgs(t.args)) },
          },
          "content_block_delta",
        );
        await send({ type: "content_block_stop", index: blockIndex }, "content_block_stop");
      }
      const stopReason = tools.size ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";
      await send(
        { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } },
        "message_delta",
      );
      await send({ type: "message_stop" }, "message_stop");
    });
  }

  try {
    const choice = await completeOnce(env, tierKey, req);
    const content = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const tc of choice.message.tool_calls || []) {
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseToolArgs(tc.function.arguments) });
    }
    const stopReason =
      choice.message.tool_calls?.length ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
    return json({
      id: msgId,
      type: "message",
      role: "assistant",
      content,
      model: tierKey,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  } catch (e) {
    return json({ type: "error", error: { type: "api_error", message: e.message } }, 503);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Web search proxy: POST /v1/search  { query, start? } → { items: [{title, link, snippet}] }
// Uses Google Programmable Search when GOOGLE_CSE_KEY + GOOGLE_CSE_CX are set,
// otherwise DuckDuckGo's HTML endpoint.
// ─────────────────────────────────────────────────────────────────────────────

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

async function searchGoogle(env, query, start) {
  const u = new URL("https://www.googleapis.com/customsearch/v1");
  u.searchParams.set("key", env.GOOGLE_CSE_KEY);
  u.searchParams.set("cx", env.GOOGLE_CSE_CX);
  u.searchParams.set("q", query);
  u.searchParams.set("start", String(start));
  const res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Google CSE HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map((i) => ({ title: i.title || "", link: i.link || "", snippet: i.snippet || "" }));
}

async function searchDuckDuckGo(query, start) {
  const form = new URLSearchParams({ q: query });
  if (start > 1) form.set("s", String(start - 1));
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; CloakSearch/1.0; +https://usecloak.org)",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: form,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);

  const results = [];
  let cur = null;
  await new HTMLRewriter()
    .on("div.result", {
      element() {
        cur = { title: "", link: "", snippet: "" };
        results.push(cur);
      },
    })
    .on("a.result__a", {
      element(el) {
        if (cur) cur.link = el.getAttribute("href") || "";
      },
      text(t) {
        if (cur) cur.title += t.text;
      },
    })
    .on(".result__snippet", {
      text(t) {
        if (cur) cur.snippet += t.text;
      },
    })
    .transform(res)
    .arrayBuffer();

  return results
    .map((r) => {
      let link = decodeEntities(r.link);
      if (link.includes("uddg=")) {
        try {
          link = decodeURIComponent(link.split("uddg=")[1].split("&")[0]);
        } catch {}
      } else if (link.startsWith("//")) {
        link = "https:" + link;
      }
      return {
        title: decodeEntities(r.title).trim(),
        link,
        snippet: decodeEntities(r.snippet).replace(/\s+/g, " ").trim(),
      };
    })
    .filter((r) => r.title && /^https?:\/\//.test(r.link) && !/duckduckgo\.com\/y\.js/.test(r.link))
    .slice(0, 10);
}

async function handleSearch(env, request) {
  const body = await readJson(request);
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, 400) : "";
  if (!query) return json({ error: "query required" }, 400);
  const start = Math.max(1, Math.min(91, Number(body.start) || 1));
  try {
    const items =
      env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX ? await searchGoogle(env, query, start) : await searchDuckDuckGo(query, start);
    return json({ items });
  } catch (e) {
    console.error(`[cloak-api] search failed: ${e.message}`);
    return json({ error: "Search unavailable", items: [] }, 502);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: provider key management (X-Admin-Token)
// ─────────────────────────────────────────────────────────────────────────────

function adminAuth(env, request) {
  const token = request.headers.get("X-Admin-Token");
  return !!(token && env.ADMIN_TOKEN && token === env.ADMIN_TOKEN);
}

async function loadKeys(env) {
  const raw = await env.PROVIDER_KEYS.get("keys");
  if (!raw) return { groq: [], nvidia: [], gemini: [] };
  return JSON.parse(raw);
}

async function handleAdminGetKeys(env) {
  const keys = await loadKeys(env);
  const masked = {};
  for (const [provider, list] of Object.entries(keys)) {
    masked[provider] = (list || []).map((k) => ({ masked: "••••••••" + k.slice(-4), full: k }));
  }
  return json(masked);
}

async function handleAdminAddKey(env, request) {
  const body = await readJson(request);
  const provider = body?.provider;
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!provider || !key) return json({ error: "provider and key required" }, 400);
  const keys = await loadKeys(env);
  if (!Array.isArray(keys[provider])) keys[provider] = [];
  if (keys[provider].includes(key)) return json({ error: "Key already exists" }, 409);
  keys[provider].push(key);
  await env.PROVIDER_KEYS.put("keys", JSON.stringify(keys));
  return json({ success: true, provider, total: keys[provider].length });
}

async function handleAdminDeleteKey(env, request) {
  const body = await readJson(request);
  const provider = body?.provider;
  const key = body?.key;
  if (!provider || !key) return json({ error: "provider and key required" }, 400);
  const keys = await loadKeys(env);
  if (!Array.isArray(keys[provider])) return json({ error: "Provider not found" }, 404);
  keys[provider] = keys[provider].filter((k) => k !== key);
  await env.PROVIDER_KEYS.put("keys", JSON.stringify(keys));
  return json({ success: true, provider, total: keys[provider].length });
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    const { pathname: path } = new URL(request.url);

    try {
      if (path === "/" && request.method === "GET") {
        return json({
          name: "CloakAPI",
          version: VERSION,
          models: VALID_MODELS,
          status: "operational",
          streaming: true,
          endpoints: {
            native: "POST /v1/chat",
            openai: "POST /v1/chat/completions",
            anthropic: "POST /v1/messages",
            search: "POST /v1/search",
          },
        });
      }

      if (path.startsWith("/admin")) {
        if (!adminAuth(env, request)) return json({ error: "Unauthorized" }, 401);
        if (path === "/admin/provider-keys") {
          if (request.method === "GET") return handleAdminGetKeys(env);
          if (request.method === "POST") return handleAdminAddKey(env, request);
          if (request.method === "DELETE") return handleAdminDeleteKey(env, request);
        }
        return json({ error: "Not found" }, 404);
      }

      if (request.method === "POST") {
        if (path === "/v1/chat") return handleNativeChat(env, request);
        if (path === "/v1/chat/completions") return handleOpenAIChat(env, request);
        if (path === "/v1/messages") return handleAnthropicMessages(env, request);
        if (path === "/v1/search") return handleSearch(env, request);
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error(`[cloak-api] unhandled ${path}: ${e?.stack || e}`);
      return json({ error: "Internal error" }, 500);
    }
  },
};
