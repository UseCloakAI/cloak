// Lanes: what kind of thinking a request needs. Each lane is an ordered lineup,
// tried best-first with failover (see engine.js). NVIDIA's free API catalog
// leads every lane; Groq and Gemini are safety nets only.
//
// Model ids come from GET https://integrate.api.nvidia.com/v1/models
// (checked 2026-11-10). Ids go stale and free-tier speed changes week to week:
// run GET /admin/probe to time every model here, then reorder.
//
// Per attempt: temperature, `extra` body params (dropped if the provider
// rejects them), `firstTokenMs` (miss it → next model, and the model is tried
// last for 10 minutes), `size` (energy class for carbon.js).

const NV = "nvidia";

// Nemotron family
const ULTRA = { provider: NV, model: "nvidia/nemotron-3-ultra-550b-a55b", size: "xl", firstTokenMs: 30_000 };
const SUPER = { provider: NV, model: "nvidia/nemotron-3-super-120b-a12b", size: "l", firstTokenMs: 20_000 };
const LIGHTNING = { provider: NV, model: "nvidia/nemotron-3.5-lightning-30b-a3b", size: "s", firstTokenMs: 8_000 };
const BOLT = { provider: NV, model: "nvidia/nemotron-3.5-bolt-e4b", size: "xs", firstTokenMs: 6_000 };
const SUPER_VL = { provider: NV, model: "nvidia/nemotron-3.5-super-vl-120b-a12b", size: "l", firstTokenMs: 20_000 };
const OMNI = { provider: NV, model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", size: "s", firstTokenMs: 15_000 };

// Partner models on NVIDIA's API
const GLM_FLASH = { provider: NV, model: "z-ai/glm-5.3-flash", size: "m", firstTokenMs: 15_000, extra: { reasoning_effort: "low" } };
const DEEPSEEK_FLASH = { provider: NV, model: "deepseek-ai/deepseek-v4.1-flash", size: "m", firstTokenMs: 15_000 };
const MINIMAX_FLASH = { provider: NV, model: "minimaxai/minimax-m3.1-flash", size: "m", firstTokenMs: 15_000 };
const MISTRAL_L4 = { provider: NV, model: "mistralai/mistral-large-4-1t-a52b", size: "xl", firstTokenMs: 30_000 };
const KIMI = { provider: NV, model: "moonshotai/kimi-k2.6", size: "xl", firstTokenMs: 30_000 };
const LAGUNA = { provider: NV, model: "poolside/laguna-xs-2.1", size: "s", firstTokenMs: 15_000 };
const PALMYRA = { provider: NV, model: "writer/palmyra-creative-122b", size: "l", firstTokenMs: 20_000 };
const GEMMA4 = { provider: NV, model: "google/gemma-4-31b-it", size: "s", firstTokenMs: 12_000 };
const OSS20_NV = { provider: NV, model: "openai/gpt-oss-20b", size: "s", firstTokenMs: 10_000 };
const LLAMA_VISION = { provider: NV, model: "meta/llama-3.2-90b-vision-instruct", size: "l", firstTokenMs: 20_000 };

// Safety nets (other free tiers, already in the shared keyring)
const GROQ_120 = { provider: "groq", model: "openai/gpt-oss-120b", size: "l", temperature: 1.0, extra: { reasoning_effort: "low" }, firstTokenMs: 10_000 };
const GROQ_20 = { provider: "groq", model: "openai/gpt-oss-20b", size: "s", extra: { reasoning_effort: "low" }, firstTokenMs: 8_000 };
const GEMINI = { provider: "gemini", model: "gemini-2.5-flash", size: "m", temperature: 1.0, firstTokenMs: 15_000 };

const at = (m, o) => ({ ...m, ...o });

export const LANES = {
  // Quick replies, small talk, lookups, rewrites. Small models, first token fast.
  swift: {
    label: "Swift",
    blurb: "Small, fast models for quick answers. Lowest energy.",
    maxTokens: 1024,
    lineup: [at(LIGHTNING, { temperature: 0.6 }), at(BOLT, { temperature: 0.6 }), at(GEMMA4, { temperature: 0.6 }), at(GLM_FLASH, { temperature: 0.6 }), GROQ_20, GEMINI],
  },
  // The default: strong general model that still answers at chat speed.
  smart: {
    label: "Balanced",
    blurb: "Strong general models at chat speed. The default.",
    maxTokens: 3072,
    lineup: [at(SUPER, { temperature: 0.6 }), at(DEEPSEEK_FLASH, { temperature: 0.6 }), at(MINIMAX_FLASH, { temperature: 0.6 }), at(GLM_FLASH, { temperature: 0.6 }), GROQ_120, GEMINI],
  },
  // Hard reasoning, research, long analysis. Biggest models, patient deadlines.
  deep: {
    label: "Deep",
    blurb: "The largest models, for hard problems. Slower, more energy.",
    maxTokens: 6144,
    lineup: [at(ULTRA, { temperature: 0.5 }), at(MISTRAL_L4, { temperature: 0.5 }), at(KIMI, { temperature: 0.5 }), at(SUPER, { temperature: 0.5 }), GROQ_120, GEMINI],
  },
  // Code. Order follows what production Cloak learned: only models that answer
  // at chat speed on the free tier belong at the front.
  code: {
    label: "Build",
    blurb: "Code-tuned models with a senior-engineer playbook.",
    maxTokens: 8192,
    playbook: "code",
    lineup: [at(GLM_FLASH, { temperature: 0.4 }), at(LAGUNA, { temperature: 0.3 }), at(DEEPSEEK_FLASH, { temperature: 0.3 }), at(SUPER, { temperature: 0.3 }), GROQ_120, GEMINI],
  },
  // Stories, voice, wordplay. A writing-tuned model first.
  creative: {
    label: "Create",
    blurb: "Writing-tuned models with more range.",
    maxTokens: 4096,
    lineup: [at(PALMYRA, { temperature: 0.95 }), at(MISTRAL_L4, { temperature: 0.9 }), at(SUPER, { temperature: 0.9 }), at(MINIMAX_FLASH, { temperature: 0.9 }), GROQ_120, GEMINI],
  },
  // Images in the turn.
  vision: {
    label: "See",
    blurb: "Multimodal models for images.",
    maxTokens: 2048,
    lineup: [at(SUPER_VL, { temperature: 0.4 }), at(OMNI, { temperature: 0.4 }), at(LLAMA_VISION, { temperature: 0.4 }), GEMINI],
  },
  // Background work (titles, summaries). Never a chat lane.
  utility: {
    label: "Utility",
    blurb: "Background jobs.",
    maxTokens: 512,
    internal: true,
    lineup: [at(BOLT, { temperature: 0.2 }), at(OSS20_NV, { temperature: 0.2 }), at(LIGHTNING, { temperature: 0.2 }), GROQ_20, GEMINI],
  },
};

export const PUBLIC_LANES = Object.keys(LANES).filter((k) => !LANES[k].internal);

// ── Router ───────────────────────────────────────────────────────────────────
// Picks a lane from the turn itself. Cheap on purpose (no model call): the
// greenest request is the one that goes to the smallest model that can do it.

const CODE_RE = /```|\b(function|const |let |class |import |def |return |async |await |SELECT |INSERT |npm |pip |git |docker|regex|stack ?trace|traceback|exception|compile|refactor|debug|bug|api endpoint|typescript|javascript|python|rust|golang|java\b|c\+\+|html|css|sql|bash|script|component|unit test)\b|\.(js|ts|tsx|py|rs|go|java|css|html|json|sql|sh)\b/i;
const BUILD_RE = /\b(build|make|create|code|write|generate)\b.{0,40}\b(app|website|web ?page|landing page|game|tool|calculator|dashboard|component|script|bot|extension|program)\b/i;
const CREATIVE_RE = /\b(story|poem|poetry|lyrics|song|verse|haiku|limerick|screenplay|script for|monologue|dialogue|fan ?fic|novel|chapter|character|world-?build|role-?play|joke|toast|speech|slogan|tagline|name ideas|brainstorm)\b/i;
const DEEP_RE = /\b(prove|derive|proof|theorem|analy[sz]e|analysis|compare|trade-?offs?|evaluate|critique|research|literature|strategy|business plan|step[- ]by[- ]step|in depth|in detail|thorough|comprehensive|explain why|root cause|diagnos|optimi[sz]e|architecture|design a system|legal|contract|tax|medical|differential|statistic|probabilit|calculus|equation|essay|report|thesis)\b/i;
const SWIFT_RE = /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|lol|good (morning|night|evening)|what'?s up|how are you|who are you|what can you do)\b/i;

export function routeLane({ text = "", hasImage = false, mode = "auto", home = "smart", turns = 0, crisis = false }) {
  if (hasImage) return { lane: "vision", why: "image attached" };
  // Someone in distress gets the strongest general model, never the smallest.
  if (crisis) return { lane: "smart", why: "care" };
  if (mode && mode !== "auto" && LANES[mode] && !LANES[mode].internal) return { lane: mode, why: "you chose it" };

  const t = String(text).trim();
  const len = t.length;
  const isCode = CODE_RE.test(t) || BUILD_RE.test(t);
  const isCreative = CREATIVE_RE.test(t);
  const isDeep = DEEP_RE.test(t) || len > 1400 || (t.match(/\?/g) || []).length >= 3;

  if (isCode) return { lane: "code", why: "looks like code" };
  if (isCreative && !isDeep) return { lane: "creative", why: "creative writing" };
  if (isDeep) return { lane: "deep", why: len > 1400 ? "long, detailed ask" : "needs careful reasoning" };
  if (SWIFT_RE.test(t)) return { lane: "swift", why: "quick one" };
  // Short openers go to the small models, unless this companion is the one people bring hard things to.
  if (len < 40 && turns < 2 && (home === "swift" || home === "smart") && !/\b(why|how|plan|help|should|explain)\b/i.test(t)) return { lane: "swift", why: "quick one" };
  // Nothing special about the turn: use the companion's home lane.
  return { lane: LANES[home] ? home : "smart", why: "default" };
}

// Free-tier numbers for models the shared governor doesn't know yet. NVIDIA's
// trial tier is ~40 requests/minute per key and doesn't meter tokens.
export const EXTRA_LIMITS = Object.fromEntries(
  [ULTRA, SUPER, LIGHTNING, BOLT, SUPER_VL, OMNI, GLM_FLASH, DEEPSEEK_FLASH, MINIMAX_FLASH, MISTRAL_L4, KIMI, LAGUNA, PALMYRA, GEMMA4, OSS20_NV, LLAMA_VISION].map((m) => [`${m.provider}:${m.model}`, { rpm: 40, ctx: 131072 }]),
);
