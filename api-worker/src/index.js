// CloakAPI — Cloudflare Worker serving https://api.usecloak.org
// Routes: native /v1/chat, OpenAI /v1/chat/completions, Anthropic /v1/messages,
// /v1/search, /v1/extract, /v1/transcribe, /v1/speech (TTS), /v1/memory/extract, /v1/context/compress, /v1/usage,
// /admin/provider-keys. All chat routes support live token streaming.
// Every upstream call goes through the free-tier governor (./governor.js).

import { makeChatRun, routeRun } from "./run.js";
import { handleRaw, handleFile, handleRepo, handleUpload, handleBlob } from "./files.js";
import { CLOAK, CODE_PLAYBOOK, REVIEW_PLAYBOOK } from "./prompts.js";
import * as gov from "./governor.js";
import { handleMemoryExtract, handleContextCompress } from "./memory.js";
import { handleSpeech } from "./speech.js";
import {
  EFFORT_LEVELS, DEFAULT_EFFORT, parseEffort, effortFromBudget, effortName,
  reserveScale, tokensScale, patienceScale, effortExtra, effortInstruction,
} from "./effort.js";

const VERSION = "4.9.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Admin-Token, Authorization, x-api-key, anthropic-version, X-File-Name",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };
const SSE_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

// Model IDs checked 2026-10-31. NVIDIA first. Groq gpt-oss, then Gemini 2.5
// Flash, are the last resort for a text reply. Qwen 3.6 is shut down. Gemini
// 3.5, 3.8, and 3.5 Flash-Lite are not in the lineup. Logos is retired.
const GEMINI_MODEL = "gemini-2.5-flash";
const NVIDIA_VISION_MODEL = "meta/llama-3.2-90b-vision-instruct";
// Nemotron 3: Ultra answers Kairos Smart, Super answers Kairos Fast and backs
// up Ultra (and Linus) when Ultra is slow or busy.
const NEMOTRON_ULTRA = "nvidia/nemotron-3-ultra-550b-a55b";
const NEMOTRON = "nvidia/nemotron-3-super-120b-a12b";
const GPT_OSS = "openai/gpt-oss-120b";
const GPT_OSS_20 = "openai/gpt-oss-20b";
// 2.5 Flash thinks with a token budget, not Gemini 3's thinkingLevel. 0 asks
// for a direct answer so the last resort does not spend the reply on thoughts.
const GEMINI_FAST = { thinkingConfig: { thinkingBudget: 0 } };

// Each tier is an ordered lineup tried best-first; a retired, rate-limited or
// slow model is skipped and the next takes over. Tiers are routing only (fast /
// reasoning / deep / code): every tier is the same Cloak, one prompt, one name.
// Per-model knobs:
//   temperature   overrides the tier's (reasoning models get their recommended
//                 one; Gemini 3 loops below 1.0)
//   extra         provider params — OpenAI-style body keys, or Gemini
//                 generationConfig keys. Dropped automatically if rejected (400).
//   reserve       output tokens on top of max_tokens for the model's reasoning,
//                 which every provider counts against the output cap
//   firstTokenMs  wait for the first token before failing over (default 20s)
const LAST_RESORT = [
  { provider: "groq", model: GPT_OSS, temperature: 1.0, extra: { reasoning_effort: "low", include_reasoning: false }, reserve: 512 },
  { provider: "gemini", model: GEMINI_MODEL, temperature: 1.0, extra: GEMINI_FAST },
];

const MODEL_CONFIG = {
  // Lighter option: NVIDIA's vision model, so text and pictures share one brain.
  pneuma: {
    name: "Cloak",
    systemPrompt: CLOAK,
    temperature: 0.7,
    lineup: [
      { provider: "nvidia", model: NVIDIA_VISION_MODEL, reserve: 512, firstTokenMs: 20_000 },
      ...LAST_RESORT,
    ],
  },
  // Default (Kairos Smart). Nemotron Ultra answers; Super takes over if Ultra
  // misses its first token. Groq and Gemini only if NVIDIA returns nothing.
  kairos: {
    name: "Cloak",
    systemPrompt: CLOAK,
    temperature: 0.8,
    lineup: [
      { provider: "nvidia", model: NEMOTRON_ULTRA, reserve: 2048, firstTokenMs: 30_000 },
      { provider: "nvidia", model: NEMOTRON, reserve: 2048 },
      { provider: "groq", model: GPT_OSS, temperature: 1.0, extra: { reasoning_effort: "medium" }, reserve: 1024 },
      { provider: "gemini", model: GEMINI_MODEL, temperature: 1.0, extra: GEMINI_FAST },
    ],
  },
  // Kairos Fast. Same Kairos on Nemotron Super, no Ultra wait.
  "kairos-fast": {
    name: "Cloak",
    systemPrompt: CLOAK,
    temperature: 0.8,
    lineup: [
      { provider: "nvidia", model: NEMOTRON, reserve: 2048 },
      { provider: "groq", model: GPT_OSS, temperature: 1.0, extra: { reasoning_effort: "medium" }, reserve: 1024 },
      { provider: "gemini", model: GEMINI_MODEL, temperature: 1.0, extra: GEMINI_FAST },
    ],
  },
  // Code tier. NVIDIA code models first, reasoning kept short so the file fits.
  // GLM-5.3-Flash and Laguna can jam on the free fleet; Nemotron is the NVIDIA
  // fallback, then the same text last resort as every other tier.
  // Not here: Kimi K3 and full GLM-5.3 — they crawl on NVIDIA's free tier.
  linus: {
    name: "Cloak",
    systemPrompt: CLOAK,
    playbook: CODE_PLAYBOOK,
    temperature: 0.3,
    lineup: [
      { provider: "nvidia", model: "z-ai/glm-5.3-flash", temperature: 0.6, extra: { reasoning_effort: "low" }, reserve: 2048, firstTokenMs: 15_000 },
      { provider: "nvidia", model: "poolside/laguna-xs-2.1", temperature: 0.3, firstTokenMs: 15_000 },
      { provider: "nvidia", model: NEMOTRON, reserve: 2048 },
      ...LAST_RESORT,
    ],
    // Code needs room: whole files, full apps. Clients rarely send max_tokens.
    defaultMaxTokens: 8192,
    maxMaxTokens: 16384,
    minOutputTokens: 2000,
  },
};
const VALID_MODELS = Object.keys(MODEL_CONFIG);

// review: Kairos asks for a short second pass. Not in the model menu.
// utility: memory extraction and context compression. Not selectable.
const TIERS = {
  ...MODEL_CONFIG,
  review: {
    name: "Cloak",
    systemPrompt: REVIEW_PLAYBOOK,
    temperature: 0.2,
    lineup: [
      { provider: "groq", model: GPT_OSS, temperature: 1.0, extra: { reasoning_effort: "low", include_reasoning: false }, reserve: 256 },
      { provider: "gemini", model: GEMINI_MODEL, temperature: 1.0, extra: GEMINI_FAST },
    ],
    defaultMaxTokens: 512,
    maxMaxTokens: 1024,
  },
  utility: {
    name: "Utility",
    systemPrompt: "",
    temperature: 0.1,
    lineup: [
      { provider: "groq", model: GPT_OSS_20, extra: { reasoning_effort: "low", include_reasoning: false }, reserve: 256 },
      { provider: "groq", model: GPT_OSS, temperature: 1.0, extra: { reasoning_effort: "low", include_reasoning: false }, reserve: 256 },
      { provider: "gemini", model: GEMINI_MODEL, temperature: 1.0, extra: GEMINI_FAST },
    ],
  },
};

// A chat request with images (`images: [...]`) uses
// this lineup: the vision model, then Gemini 2.5 Flash, which accepts images.
// Images go straight to the model on /v1/chat — there is no separate look call.
const VISION_LINEUP = [
  { provider: "nvidia", model: NVIDIA_VISION_MODEL, reserve: 512, firstTokenMs: 20_000 },
  { provider: "gemini", model: GEMINI_MODEL, temperature: 1.0, extra: GEMINI_FAST },
];
const UNAVAILABLE = "Cloak AI is currently unavailable. Please try again later.";
const DEFAULT_MAX_TOKENS = 2048;
const MAX_MAX_TOKENS = 8192;
// Time allowed to connect AND receive the first token before failing over
// (per model: `firstTokenMs`).
const FIRST_TOKEN_TIMEOUT_MS = 20_000;
// Longest gap between streamed tokens before the stream counts as dead.
const STALL_MS = 45_000;
// Longest a model may reason without starting its answer before handing over.
const THINK_LIMIT_MS = 120_000;
// Stop opening new candidates after this long with nothing to show.
const OPEN_DEADLINE_MS = 60_000;
// No handover to a fresh model once the reply is this old.
const HANDOVER_WINDOW_MS = 150_000;
// Time allowed for a complete non-streaming response.
const FULL_RESPONSE_TIMEOUT_MS = 55_000;

class UpstreamError extends Error {
  constructor(message, { rateLimited = false, status = 0 } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.rateLimited = rateLimited;
    this.status = status;
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

// With an effort, the default budget scales (×0.6 → ×1.6) and the ceiling
// doubles at "max". An explicit max_tokens is kept, just clamped.
function clampMaxTokens(v, tierKey, effort) {
  const t = TIERS[tierKey] || {};
  const e = effort ?? DEFAULT_EFFORT;
  const ceiling = (t.maxMaxTokens || MAX_MAX_TOKENS) * (effortName(e) === "max" ? 2 : 1);
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    return Math.min(ceiling, Math.round((t.defaultMaxTokens || DEFAULT_MAX_TOKENS) * tokensScale(e)));
  }
  return Math.min(Math.floor(n), ceiling);
}

function resolveTier(model) {
  // Logos was the old middle tier. Old clients land on Kairos.
  if (model === "logos") return "kairos";
  if (model === "review") return "review";
  return VALID_MODELS.includes(model) ? model : "pneuma";
}

function buildSystemPrompt(config, extraSystem) {
  const extra = normalizeSystem(extraSystem);
  // Same Cloak, plus a task playbook for tiers that have one (code).
  const base = config.playbook ? `${config.systemPrompt}\n\n${config.playbook}` : config.systemPrompt;
  if (!base) return extra;
  if (!extra) return base;
  return `${base}\n\n## ADDITIONAL INSTRUCTIONS FROM THE CLOAK APP\n${extra}`;
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
  const keys = await gov.readKeyring(env);
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

function openAIBody({ model, messages, temperature, maxTokens, tools, toolChoice, stream, json: wantJson, extra }, provider) {
  // Per-model knobs (reasoning_effort, chat_template_kwargs…) go in first so
  // the core fields below always win.
  const body = { ...(extra || {}), model, messages, temperature, max_tokens: maxTokens };
  if (wantJson && provider === "groq") body.response_format = { type: "json_object" };
  if (tools && tools.length) {
    body.tools = tools;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
  }
  if (stream) body.stream = true;
  return body;
}

// Gemini: OpenAI-style messages → contents + systemInstruction.
function toGeminiRequest(messages, temperature, maxTokens, wantJson, extra) {
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
    // Per-model knobs (thinkingConfig…) first so the core fields always win.
    generationConfig: { ...(extra || {}), temperature, maxOutputTokens: maxTokens },
  };
  if (wantJson) req.generationConfig.responseMimeType = "application/json";
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

// Answer text, or with thought=true the thought summaries (includeThoughts).
function geminiText(data, thought = false) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p.text === "string" && !!p.thought === thought).map((p) => p.text).join("");
}

function geminiFinish(data) {
  const r = data?.candidates?.[0]?.finishReason;
  if (!r) return undefined;
  return r === "MAX_TOKENS" ? "length" : "stop";
}

// Sends one request with one key. Returns the upstream Response or throws UpstreamError.
async function sendUpstream(provider, apiKey, spec, stream, signal, ctx) {
  let url;
  let headers;
  let body;
  if (provider === "gemini") {
    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    url = `https://generativelanguage.googleapis.com/v1beta/models/${spec.model}:${method}`;
    headers = { "Content-Type": "application/json", "x-goog-api-key": apiKey };
    body = toGeminiRequest(spec.messages, spec.temperature, spec.maxTokens, spec.json, spec.extra);
  } else {
    url = OPENAI_COMPAT[provider];
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    body = openAIBody({ ...spec, stream }, provider);
  }

  gov.noteCall(gov.slotId(provider, apiKey, spec.model));
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    throw new UpstreamError(`${provider} network: ${e.name === "AbortError" ? "timeout" : e.message}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 600);
    } catch {}
    gov.observe({ provider, model: spec.model, key: apiKey, res, bodyText: detail, ctx });
    if (res.status === 429) {
      throw new UpstreamError(`${provider} (${spec.model}) 429 rate limited: ${detail.slice(0, 160)}`, { rateLimited: true, status: 429 });
    }
    throw new UpstreamError(`${provider} (${spec.model}) HTTP ${res.status}: ${detail.slice(0, 300)}`, { status: res.status });
  }
  gov.observe({ provider, model: spec.model, key: apiKey, res, ctx });
  return res;
}

// Per-model params (`extra`) are best-effort: if the provider rejects a request
// carrying them, retry once without and stop sending them to that model.
const badExtra = new Set();

async function send(c, spec, stream, signal, ctx) {
  try {
    return await sendUpstream(c.provider, c.key, spec, stream, signal, ctx);
  } catch (e) {
    if (!spec.extra || !(e.status === 400 || e.status === 422)) throw e;
    const res = await sendUpstream(c.provider, c.key, { ...spec, extra: undefined }, stream, signal, ctx);
    badExtra.add(`${c.provider}:${c.model}`);
    console.warn(`[cloak-api] ${c.provider} (${c.model}) rejected ${Object.keys(spec.extra).join(", ")}; sending without: ${e.message.slice(0, 200)}`);
    return res;
  }
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
      if (evt.error) throw new UpstreamError(`gemini stream error: ${JSON.stringify(evt.error).slice(0, 200)}`);
      const content = geminiText(evt);
      const reasoning = geminiText(evt, true);
      const finish_reason = geminiFinish(evt);
      if (content || reasoning || finish_reason) yield { content, reasoning, finish_reason };
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

// The ordered attempts for a request: the tier's lineup, or the vision lineup
// when an image is attached.
function planAttempts(config, { hasImage, hasTools }) {
  const lineup = hasImage ? VISION_LINEUP : config.lineup;
  return lineup.filter((a) => !(a.provider === "gemini" && hasTools)); // Gemini adapter has no tool support
}

function withImages(messages, images) {
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
        ...images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime || "image/jpeg"};base64,${im.data}` } })),
      ],
    };
    break;
  }
  return out;
}

// Images on a chat request: `images: [{data, mime}]` (up to IMG_MAX), or the
// older single `imageBase64` + `mimeType`. Oversized ones are dropped.
const IMG_MAX = 4, IMG_MAX_B64 = 8_000_000;
function readImages(body) {
  const list = Array.isArray(body.images) ? body.images
    : body.imageBase64 ? [{ data: body.imageBase64, mime: body.mimeType }] : [];
  return list
    .filter((im) => im && typeof im.data === "string" && im.data.trim() && im.data.length <= IMG_MAX_B64)
    .slice(0, IMG_MAX)
    .map((im) => ({ data: im.data, mime: /^image\/[\w.+-]+$/.test(im.mime || "") ? im.mime : "image/jpeg" }));
}

function prepare(tierKey, req) {
  const config = TIERS[tierKey];
  const images = req.images || [];
  const hasImage = images.length > 0;
  const hasTools = !!(req.tools && req.tools.length);
  const guide = req.effort != null ? effortInstruction(req.effort) : "";
  const prompt = buildSystemPrompt(config, req.system);
  const system = { role: "system", content: guide ? `${prompt}\n\n${guide}` : prompt };
  const base = [system, ...req.messages];
  return {
    config,
    hasTools,
    attempts: planAttempts(config, { hasImage, hasTools }),
    visionMessages: hasImage ? [system, ...withImages(req.messages, images)] : null,
    textMessages: base,
    // If every vision provider fails, answer text-only on the normal providers.
    textFallback: hasImage ? planAttempts(config, { hasImage: false, hasTools }) : [],
  };
}

// Every (attempt × key) combination: healthy keys first (round-robin), cooling
// keys and slow models after, so quota-exhausted keys aren't spent first. With
// a tier minimum (minOutputTokens), models whose free-tier caps leave less room
// than that for the answer go to the very end.
async function* candidates(env, plan, req, errors) {
  const groups = [
    ...plan.attempts.map((a) => ({ ...a, messages: plan.visionMessages || plan.textMessages })),
    ...plan.textFallback.map((a) => ({ ...a, messages: plan.textMessages })),
  ];
  const keyring = new Map();
  const withKeys = [];
  for (const g of groups) {
    if (!keyring.has(g.provider)) {
      try {
        keyring.set(g.provider, await getKeys(env, g.provider));
      } catch (e) {
        keyring.set(g.provider, null);
        errors.push(`${g.provider}: ${e.message}`);
      }
    }
    const keys = keyring.get(g.provider);
    if (keys) withKeys.push({ ...g, keys });
  }
  await gov.syncCooldowns(gov.idsFor(withKeys));
  const { healthy, cold } = gov.orderCandidates(withKeys);
  const min = plan.config.minOutputTokens || 0;
  const tight = [];
  for (const c of [...healthy, ...cold]) {
    if (min && specFor(c, plan, req).maxTokens < min) tight.push(c);
    else yield c;
  }
  yield* tight;
}

// Request spec for one candidate, sized to the model's free-tier caps.
function specFor(c, plan, req) {
  const gemini = c.provider === "gemini";
  return gov.fitSpec(c.provider, c.model, {
    model: c.model,
    messages: c.messages,
    temperature: c.temperature ?? plan.config.temperature,
    extra: badExtra.has(`${c.provider}:${c.model}`) ? undefined : effortExtra(c.extra, req.effort ?? DEFAULT_EFFORT),
    maxTokens: req.maxTokens + Math.round((c.reserve || 0) * reserveScale(req.effort ?? DEFAULT_EFFORT)),
    tools: gemini ? undefined : req.tools,
    toolChoice: gemini ? undefined : req.toolChoice,
    json: req.json,
  });
}

// Non-streaming: returns an OpenAI-style choice { message, finish_reason }.
async function completeOnce(env, tierKey, req) {
  const plan = prepare(tierKey, req);
  const errors = [];
  // Optional limits: per-model timeout, total deadline. A model that times
  // out isn't retried on its other keys (it's the model, not the key).
  const t0 = Date.now(), slow = new Set();
  for await (const c of candidates(env, plan, req, errors)) {
    const tag = `${c.provider}:${c.model}`;
    if (slow.has(tag)) continue;
    const left = req.deadlineMs ? req.deadlineMs - (Date.now() - t0) : Infinity;
    if (left < 3000) { errors.push("deadline reached"); break; }
    const spec = specFor(c, plan, req);
    try {
      const res = await send(c, spec, false, AbortSignal.timeout(Math.min(req.timeoutMs || FULL_RESPONSE_TIMEOUT_MS, left)), req.ctx);
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
        usage: { in: spec.inTokens, dropped: spec.dropped },
      };
    } catch (e) {
      if (e.name === "TimeoutError") slow.add(tag);
      errors.push(e.name === "TimeoutError" ? `${c.provider} (${c.model}) timeout` : e.message);
    }
  }
  console.error(`[cloak-api] all providers failed tier=${tierKey}: ${errors.join(" | ")}`);
  throw new Error(UNAVAILABLE);
}

// Upstream deltas with <think>…</think> spans moved from content to reasoning.
async function* cleanDeltas(provider, res) {
  const stripper = makeThinkStripper();
  for await (const d of upstreamDeltas(provider, res)) {
    const out = { ...d };
    if (d.content) out.content = stripper.push(d.content);
    const think = (d.reasoning || "") + stripper.takeThink();
    if (think) out.reasoning = think;
    else delete out.reasoning;
    if (out.content || out.reasoning || out.tool_calls || out.finish_reason) yield out;
  }
  const tail = stripper.flush();
  if (tail) yield { content: tail };
}

// Resolves like `p`, or aborts `ctrl` and rejects once `ms` pass without it.
function within(p, ms, ctrl, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(Object.assign(new UpstreamError(`${what} stalled for ${ms / 1000}s`), { slow: true }));
    }, ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// Streaming with failover. Candidates are opened in order until one produces a
// first delta (reasoning, text or a tool call); that decides the HTTP response.
// After that, a stream that stalls, errors, or ends before any answer text
// (reasoning ate the budget, a model too slow to get there) hands over to the
// next candidate, so the client sees one continuous reply. Once answer text has
// gone out, a failure ends the stream and the caller reports it with the partial.
// Returns { provider, model, usage, deltas } — updated in place on a handover.
async function openStream(env, tierKey, req) {
  const plan = prepare(tierKey, req);
  // Higher effort = more patience before treating a thinking model as stuck.
  const P = patienceScale(req.effort ?? DEFAULT_EFFORT);
  const OPEN_DEADLINE = OPEN_DEADLINE_MS * P, STALL = STALL_MS * P, THINK_LIMIT = THINK_LIMIT_MS * P, HANDOVER = HANDOVER_WINDOW_MS * P;
  const errors = [];
  const queue = candidates(env, plan, req, errors);
  const skip = new Set(); // models that missed their first-token deadline this request
  const t0 = Date.now();

  const open = async () => {
    const began = Date.now();
    for (;;) {
      if (Date.now() - began > OPEN_DEADLINE) {
        errors.push(`gave up after ${Math.round(OPEN_DEADLINE / 1000)}s`);
        return null;
      }
      const { value: c, done } = await queue.next();
      if (done) return null;
      const tag = `${c.provider} (${c.model})`;
      if (skip.has(tag)) continue;
      const spec = specFor(c, plan, req);
      const ctrl = new AbortController();
      const wait = (c.firstTokenMs || FIRST_TOKEN_TIMEOUT_MS) * P;
      const timer = setTimeout(() => ctrl.abort(), wait);
      try {
        const res = await send(c, spec, true, ctrl.signal, req.ctx);
        const it = cleanDeltas(c.provider, res);
        const first = [];
        let live = false;
        while (!live) {
          const { value, done: ended } = await it.next();
          if (ended) break;
          first.push(value);
          live = !!(value.content || value.reasoning || value.tool_calls);
        }
        clearTimeout(timer);
        if (!live) throw new UpstreamError(`${tag} returned empty stream`);
        return { c, tag, spec, ctrl, first, it };
      } catch (e) {
        clearTimeout(timer);
        if (ctrl.signal.aborted) {
          // A slow queue belongs to the model, not the key: skip its other keys
          // now and try it last for a while.
          skip.add(tag);
          gov.markSlow(c.provider, c.model, req.ctx);
          errors.push(`${tag} first-token timeout (${wait / 1000}s)`);
        } else {
          errors.push(e.message);
        }
      }
    }
  };
  const fail = () => {
    console.error(`[cloak-api] all providers failed (stream) tier=${tierKey}: ${errors.join(" | ")}`);
    return new Error(UNAVAILABLE);
  };

  let cur = await open();
  if (!cur) throw fail();
  const usage = (x) => ({ in: x.spec.inTokens, dropped: x.spec.dropped });
  const out = { provider: cur.c.provider, model: cur.c.model, usage: usage(cur) };
  out.deltas = (async function* () {
    let answered = false;
    try {
      for (;;) {
        let why;
        const since = Date.now();
        try {
          for (const d of cur.first) {
            if (d.content || d.tool_calls) answered = true;
            yield d;
          }
          for (;;) {
            const { value, done } = await within(cur.it.next(), STALL, cur.ctrl, cur.tag);
            if (done) break;
            if (value.content || value.tool_calls) answered = true;
            else if (!answered && Date.now() - since > THINK_LIMIT) {
              throw Object.assign(new UpstreamError(`${cur.tag} still reasoning after ${Math.round(THINK_LIMIT / 1000)}s`), { slow: true });
            }
            yield value;
          }
          if (answered) return;
          why = `${cur.tag} ended without an answer`;
        } catch (e) {
          if (answered) throw e;
          why = e.message;
          if (e.slow) gov.markSlow(cur.c.provider, cur.c.model, req.ctx);
        }
        // Only reasoning has gone out so far: hand over to the next candidate
        // (never another key of the same model — it would do the same).
        cur.ctrl.abort();
        skip.add(cur.tag);
        errors.push(why);
        if (Date.now() - t0 > HANDOVER) throw fail();
        console.warn(`[cloak-api] handover tier=${tierKey}: ${why}`);
        cur = await open();
        if (!cur) throw fail();
        Object.assign(out, { provider: cur.c.provider, model: cur.c.model, usage: usage(cur) });
      }
    } finally {
      cur?.ctrl.abort(); // client gone or stream over: release the upstream
    }
  })();
  return out;
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
// Request:  { model, messages, system?, max_tokens?, images?: [{data, mime}], stream? }
// Response: { model, response }            (stream: false)
//           SSE data: {delta} … {done, model, response}  |  {error}   (stream: true)
// ─────────────────────────────────────────────────────────────────────────────

function chatReq(body, ctx) {
  const tierKey = resolveTier(body.model);
  const effort = parseEffort(body.effort);
  return {
    tierKey, effort,
    req: {
      messages: sanitizeMessages(body.messages),
      system: body.system,
      effort,
      maxTokens: clampMaxTokens(body.max_tokens, tierKey, effort),
      images: readImages(body),
      ctx,
    },
  };
}

// The /v1/chat stream as plain events: {think} {delta} … {done} | {error}.
// Opening errors throw (so the plain SSE route can 503); later ones are events.
async function* chatEvents(env, body, ctx, signal) {
  const { tierKey, effort, req } = chatReq(body, ctx);
  const name = MODEL_CONFIG[tierKey].name;
  const stream = await openStream(env, tierKey, req);
  let full = "";
  try {
    for await (const d of stream.deltas) {
      if (signal?.aborted) return;
      if (d.reasoning) yield { think: d.reasoning };
      if (d.content) { full += d.content; yield { delta: d.content }; }
    }
    yield { done: true, model: name, response: full, usage: stream.usage, effort: effort ?? DEFAULT_EFFORT };
  } catch (e) {
    console.error(`[cloak-api] mid-stream failure ${stream.provider}: ${e?.message || e}`);
    yield { error: "The response was interrupted. Please try again.", partial: full };
  }
}

export const ChatRun = makeChatRun(async function* (env, body, ctx, signal) {
  try { yield* chatEvents(env, body, ctx, signal); }
  catch (e) { yield { error: e.message || UNAVAILABLE }; }
});

async function handleNativeChat(env, request, ctx) {
  const body = await readJson(request);
  if (!body || !Array.isArray(body.messages)) return json({ error: "messages array required" }, 400);
  if (body.stream === true && body.run && typeof body.run === "object") {
    const r = await routeRun(env, request, "/v1/chat", body);
    if (r) return r;
    delete body.run;
  }

  const tierKey = resolveTier(body.model);
  const effort = parseEffort(body.effort);
  const req = {
    messages: sanitizeMessages(body.messages),
    system: body.system,
    effort,
    maxTokens: clampMaxTokens(body.max_tokens, tierKey, effort),
    images: readImages(body),
    ctx,
  };
  const name = MODEL_CONFIG[tierKey].name;

  if (body.stream === true) {
    let first;
    const it = chatEvents(env, body, ctx);
    try { first = await it.next(); } catch (e) { return json({ error: e.message }, 503); }
    return sseResponse(async (send) => {
      if (!first.done) await send(first.value);
      for await (const e of it) await send(e);
    });
  }

  try {
    const choice = await completeOnce(env, tierKey, req);
    return json({ model: name, response: choice.message.content || "", usage: choice.usage, effort: effort ?? DEFAULT_EFFORT });
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
  // `effort` (0–100 or a level), or OpenAI's own `reasoning_effort` / `reasoning.effort`.
  const effort = parseEffort(body.effort ?? body.reasoning_effort ?? body.reasoning?.effort);
  const req = {
    messages: sanitizeMessages(body.messages),
    effort,
    maxTokens: clampMaxTokens(body.max_tokens ?? body.max_completion_tokens, tierKey, effort),
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
        console.error(`[cloak-api] mid-stream failure ${stream.provider}: ${e?.message || e}`);
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
  // `effort`, `output_config.effort`, or a `thinking.budget_tokens` budget.
  const effort =
    parseEffort(body.effort ?? body.output_config?.effort) ??
    (body.thinking?.type === "enabled" ? effortFromBudget(body.thinking.budget_tokens) : null);
  const req = {
    messages: sanitizeMessages(flattenAnthropicMessages(body.messages)),
    system: body.system,
    effort,
    maxTokens: clampMaxTokens(body.max_tokens, tierKey, effort),
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
        console.error(`[cloak-api] mid-stream failure ${stream.provider}: ${e?.message || e}`);
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
// Web search proxy: POST /v1/search  { query, start? } → { items: [{title, link, snippet, content?}], provider }
// Order: Tavily (pooled keys in KV) → Google Programmable Search (GOOGLE_CSE_KEY +
// GOOGLE_CSE_CX) → DuckDuckGo's HTML endpoint. Falls through on error or no results.
// ─────────────────────────────────────────────────────────────────────────────

const NAMED_ENTITIES = { mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&(mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo|copy|reg|trade|middot|bull);/g, (_, n) => NAMED_ENTITIES[n])
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

// ── Tavily (multi-key) ──
// Keys live in PROVIDER_KEYS KV under "tavily" (add via /admin/provider-keys).
// Each call starts at a random key and rolls to the next on auth/quota/rate errors,
// so several free-tier keys pool their monthly credits.
const TAVILY_ROLL = new Set([401, 403, 429, 432, 433]);

async function tavilyKeys(env) {
  try {
    const list = (await gov.readKeyring(env)).tavily;
    return Array.isArray(list) ? list.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function tavilyCall(env, endpoint, payload) {
  const keys = await tavilyKeys(env);
  if (!keys.length) return null;
  const first = Math.floor(Math.random() * keys.length);
  let lastErr = "no keys";
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(first + i) % keys.length];
    const res = await fetch(`https://api.tavily.com/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return res.json();
    lastErr = `Tavily ${endpoint} HTTP ${res.status} (key …${key.slice(-4)})`;
    if (!TAVILY_ROLL.has(res.status)) break;
  }
  throw new Error(lastErr);
}

async function searchTavily(env, query) {
  const data = await tavilyCall(env, "search", { query, max_results: 10, search_depth: "basic" });
  if (!data) return null;
  return (data.results || []).map((r) => ({
    title: r.title || "",
    link: r.url || "",
    snippet: (r.content || "").replace(/\s+/g, " ").trim().slice(0, 400),
    content: r.content || "",
  }));
}

async function handleSearch(env, request) {
  const body = await readJson(request);
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, 400) : "";
  if (!query) return json({ error: "query required" }, 400);
  const start = Math.max(1, Math.min(91, Number(body.start) || 1));
  // Tavily first (no pagination → page 1 only), then Google CSE, then DuckDuckGo.
  const chain = [];
  if (start === 1) chain.push(["tavily", () => searchTavily(env, query)]);
  if (env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX) chain.push(["google", () => searchGoogle(env, query, start)]);
  chain.push(["duckduckgo", () => searchDuckDuckGo(query, start)]);
  for (const [provider, run] of chain) {
    try {
      const items = await run();
      if (items && items.length) return json({ items, provider });
    } catch (e) {
      console.error(`[cloak-api] search via ${provider} failed: ${e.message}`);
    }
  }
  return json({ error: "Search unavailable", items: [] }, 502);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page extraction: POST /v1/extract  { url, format?: "text"|"raw", maxChars? }
//   text → readable page text (Tavily extract, else fetched + stripped here)
//   raw  → the page's raw response body (HTML / JSON / plain text), untouched
// → { url, format, contentType, content, truncated, provider }
// ─────────────────────────────────────────────────────────────────────────────

const RAW_MAX_BYTES = 2_000_000;

function isPublicUrl(u) {
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (h.startsWith("[")) return false; // no raw IPv6 literals
  return true;
}

async function fetchRaw(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CloakReader/1.0; +https://usecloak.org)",
      Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  if (!/text|json|xml|javascript|csv/i.test(contentType)) throw new Error(`Unsupported content-type: ${contentType}`);
  // Read at most RAW_MAX_BYTES so huge pages can't blow the Worker's memory.
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= RAW_MAX_BYTES) {
      reader.cancel();
      break;
    }
  }
  const buf = new Uint8Array(Math.min(size, RAW_MAX_BYTES));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, buf.length - off);
    buf.set(c.subarray(0, take), off);
    off += take;
    if (off >= buf.length) break;
  }
  return { contentType, body: new TextDecoder().decode(buf), finalUrl: res.url || url };
}

// Readable text from HTML: drop script/style/nav chrome, keep block breaks.
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function handleExtract(env, request) {
  const body = await readJson(request);
  let u;
  try {
    u = new URL(String(body?.url || ""));
  } catch {
    return json({ error: "valid url required" }, 400);
  }
  if (!isPublicUrl(u)) return json({ error: "url not allowed" }, 400);
  const format = body?.format === "raw" ? "raw" : "text";
  const maxChars = Math.max(500, Math.min(200_000, Number(body?.maxChars) || 20_000));
  const out = (content, contentType, provider) =>
    json({ url: u.href, format, contentType, content: content.slice(0, maxChars), truncated: content.length > maxChars, provider });

  if (format === "text") {
    try {
      const data = await tavilyCall(env, "extract", { urls: [u.href], extract_depth: "basic", format: "text" });
      const hit = data?.results?.[0]?.raw_content;
      if (hit) return out(hit, "text/plain", "tavily");
    } catch (e) {
      console.error(`[cloak-api] tavily extract failed: ${e.message}`);
    }
  }
  try {
    const { contentType, body: raw } = await fetchRaw(u.href);
    if (format === "raw") return out(raw, contentType, "direct");
    const text = /html|xml/i.test(contentType) ? htmlToText(raw) : raw;
    return out(text, "text/plain", "direct");
  } catch (e) {
    console.error(`[cloak-api] direct fetch failed for ${u.href}: ${e.message}`);
    return json({ error: `Could not fetch page: ${e.message}` }, 502);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory + context utilities (see ./memory.js). Utility tier, non-streaming.
// ─────────────────────────────────────────────────────────────────────────────

function utilityComplete(env, ctx) {
  return async ({ system, messages, maxTokens, json: wantJson }) => {
    const choice = await completeOnce(env, "utility", {
      messages: sanitizeMessages(messages),
      system,
      maxTokens: clampMaxTokens(maxTokens),
      json: !!wantJson,
      ctx,
    });
    return choice.message.content || "";
  };
}

async function handleUtility(env, request, ctx, handler) {
  const body = await readJson(request);
  if (!body) return json({ error: "JSON body required" }, 400);
  try {
    const { status, data } = await handler(body, { complete: utilityComplete(env, ctx) });
    return json(data, status);
  } catch (e) {
    return json({ error: e.message || UNAVAILABLE }, 503);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Speech-to-text: POST /v1/transcribe (raw audio body → { text }) via Groq Whisper
// ─────────────────────────────────────────────────────────────────────────────

const WHISPER_MODEL = "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_EXT = { webm: "webm", ogg: "ogg", mp4: "mp4", mpeg: "mp3", mp3: "mp3", wav: "wav", "x-m4a": "m4a", m4a: "m4a" };

async function handleTranscribe(env, request, ctx) {
  const type = (request.headers.get("Content-Type") || "audio/webm").split(";")[0].trim().toLowerCase();
  const ext = AUDIO_EXT[type.replace(/^(audio|video)\//, "")] || "webm";
  const audio = await request.arrayBuffer();
  if (!audio.byteLength) return json({ error: "audio required" }, 400);
  if (audio.byteLength > MAX_AUDIO_BYTES) return json({ error: "audio too large" }, 413);

  const lang = new URL(request.url).searchParams.get("lang");
  const keys = await getKeys(env, "groq");
  const { healthy, cold } = gov.orderCandidates([{ provider: "groq", model: WHISPER_MODEL, keys }]);
  let lastErr = "no groq keys available";
  for (const c of [...healthy, ...cold].slice(0, 3)) {
    const form = new FormData();
    form.append("file", new Blob([audio], { type }), `speech.${ext}`);
    form.append("model", WHISPER_MODEL);
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (lang && /^[a-z]{2,3}$/i.test(lang)) form.append("language", lang.toLowerCase());
    gov.noteCall(c.slot);
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${c.key}` },
      body: form,
    });
    gov.observe({ provider: "groq", model: WHISPER_MODEL, key: c.key, res, ctx });
    if (res.ok) {
      const data = await res.json();
      return json({ text: (data.text || "").trim() });
    }
    lastErr = `groq ${res.status}`;
    if (res.status !== 429 && res.status < 500) break;
  }
  return json({ error: lastErr }, 503);
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
  if (!raw) return { groq: [], nvidia: [], gemini: [], tavily: [] };
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
  gov.invalidateKeyring();
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
  gov.invalidateKeyring();
  return json({ success: true, provider, total: keys[provider].length });
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
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
          effort: {
            param: "effort",
            range: "0-100 or minimal | low | medium | high | max",
            default: "medium (50)",
            also: "OpenAI reasoning_effort, Anthropic output_config.effort / thinking.budget_tokens",
          },
          endpoints: {
            native: "POST /v1/chat",
            openai: "POST /v1/chat/completions",
            anthropic: "POST /v1/messages",
            search: "POST /v1/search",
            extract: "POST /v1/extract",
            file: "POST /v1/file {url} → exact text file (or binary info)",
            repo: "POST /v1/repo {url, path?} → public GitHub tree / file",
            raw: "GET /v1/raw?url= → exact bytes, CORS-open (for builds)",
            upload: "POST /v1/upload (bytes, X-File-Name) → {url}; GET /v1/blob/:id/:name",
            transcribe: "POST /v1/transcribe",
            memory: "POST /v1/memory/extract",
            compress: "POST /v1/context/compress",
            usage: "GET /v1/usage",
            runs: "GET /v1/runs/:id?from=N · POST /v1/runs/:id/claim|cancel (cloud-run replies: send run:{id} on /v1/chat)",
          },
        });
      }

      if (path === "/v1/usage" && request.method === "GET") return json({ version: VERSION, ...gov.snapshot() });

      if (path.startsWith("/admin")) {
        if (!adminAuth(env, request)) return json({ error: "Unauthorized" }, 401);
        if (path === "/admin/provider-keys") {
          if (request.method === "GET") return handleAdminGetKeys(env);
          if (request.method === "POST") return handleAdminAddKey(env, request);
          if (request.method === "DELETE") return handleAdminDeleteKey(env, request);
        }
        return json({ error: "Not found" }, 404);
      }

      if (path === "/v1/raw" && request.method === "GET") return handleRaw(request);
      if (path.startsWith("/v1/blob/") && request.method === "GET") return handleBlob(env, path);
      if (path === "/v1/upload" && request.method === "POST") return handleUpload(env, request);
      if (path === "/v1/speech/voices" && request.method === "GET") return handleSpeech(env, request, ctx, { json, cors: CORS_HEADERS });

      if (path.startsWith("/v1/runs/")) {
        const r = await routeRun(env, request, path);
        if (r) return r;
      }

      if (request.method === "POST") {
        if (path === "/v1/chat") return handleNativeChat(env, request, ctx);
        if (path === "/v1/chat/completions") return handleOpenAIChat(env, request);
        if (path === "/v1/messages") return handleAnthropicMessages(env, request);
        if (path === "/v1/search") return handleSearch(env, request);
        if (path === "/v1/extract") return handleExtract(env, request);
        if (path === "/v1/file") return handleFile(await readJson(request));
        if (path === "/v1/repo") return handleRepo(env, await readJson(request));
        if (path === "/v1/transcribe") return handleTranscribe(env, request, ctx);
        if (path === "/v1/speech") return handleSpeech(env, request, ctx, { json, cors: CORS_HEADERS });
        if (path === "/v1/memory/extract") return handleUtility(env, request, ctx, handleMemoryExtract);
        if (path === "/v1/context/compress") return handleUtility(env, request, ctx, handleContextCompress);
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error(`[cloak-api] unhandled ${path}: ${e?.stack || e}`);
      return json({ error: "Internal error" }, 500);
    }
  },
};
