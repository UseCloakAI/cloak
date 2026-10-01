// ─────────────────────────────────────────────────────────────────────────────
// Effort — how hard Cloak works on one request.
//
// Clients send `effort` as a 0–100 number or a level name. 50 ("medium") is the
// tier's tuned default, so leaving it out changes nothing. It drives real knobs,
// per model, not just a prompt hint:
//   reasoning    Groq/NVIDIA `reasoning_effort` and Gemini `thinkingLevel`
//                step down/up from the tier default
//   reserve      output tokens set aside for reasoning (×0.5 → ×3)
//   max tokens   the default answer budget (×0.6 → ×1.6) when the client
//                didn't set one, and the ceiling doubles at max
//   patience     first-token / stall / think-time limits (×1 → ×2.5), so a
//                model is allowed to think longer before failover
//   prompt       a short instruction on how much to deliberate and verify
// ─────────────────────────────────────────────────────────────────────────────

export const EFFORT_LEVELS = [
  { name: "minimal", value: 0 },
  { name: "low", value: 25 },
  { name: "medium", value: 50 },
  { name: "high", value: 75 },
  { name: "max", value: 100 },
];
export const DEFAULT_EFFORT = 50;

const ALIASES = { none: "minimal", min: "minimal", fast: "minimal", quick: "minimal", default: "medium", normal: "medium", xhigh: "max", maximum: "max", extended: "max" };

// Accepts 0–100, a 0–1 fraction, 1–5 (when given as a level index string is
// ambiguous we only treat integers 1–5 from `effort_level`), or a level name.
export function parseEffort(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    const name = ALIASES[s] || s;
    const lvl = EFFORT_LEVELS.find((l) => l.name === name);
    if (lvl) return lvl.value;
    if (s !== "" && !Number.isNaN(Number(s))) return parseEffort(Number(s));
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1) return Math.round(n * 100); // fraction
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Anthropic-style thinking budget → effort (0 tokens = minimal, 32K+ = max).
export function effortFromBudget(budget) {
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((Math.log2(Math.max(1024, b)) - 10) / 5 * 100)));
}

export function effortName(e) {
  if (e < 13) return "minimal";
  if (e < 38) return "low";
  if (e < 63) return "medium";
  if (e < 88) return "high";
  return "max";
}

// Smooth multipliers, 1 at 50.
const lerp = (a, b, t) => a + (b - a) * t;
const curve = (e, lo, hi) => (e <= 50 ? lerp(lo, 1, e / 50) : lerp(1, hi, (e - 50) / 50));
export const reserveScale = (e) => curve(e, 0.5, 3);
export const tokensScale = (e) => curve(e, 0.6, 1.6);
export const patienceScale = (e) => curve(e, 1, 2.5);

// Step an ordered scale from the tier default: minimal/low go down, high up one,
// max to the top.
const OAI_STEPS = ["low", "medium", "high"];
const GEMINI_STEPS = ["low", "medium", "high"];
function stepFrom(steps, base, e) {
  const i = steps.indexOf(base);
  if (i < 0) return base;
  const name = effortName(e);
  if (name === "minimal") return steps[0];
  if (name === "low") return steps[Math.max(0, i - 1)];
  if (name === "medium") return base;
  if (name === "high") return steps[Math.min(steps.length - 1, i + 1)];
  return steps[steps.length - 1];
}

// Per-model provider params for this effort. Only touches knobs the model
// already declares, so models without reasoning controls are left alone.
export function effortExtra(extra, e) {
  if (!extra || e === DEFAULT_EFFORT) return extra;
  const out = { ...extra };
  if (typeof out.reasoning_effort === "string") {
    const base = out.reasoning_effort;
    if (base === "none" || base === "default") {
      // Qwen-style on/off thinking: turn it on from "high" up.
      out.reasoning_effort = e >= 63 ? "default" : "none";
    } else {
      out.reasoning_effort = stepFrom(OAI_STEPS, base, e);
    }
    // Show reasoning when we're paying for more of it.
    if (out.include_reasoning === false && e >= 63) delete out.include_reasoning;
  }
  const tc = out.thinkingConfig;
  if (tc && typeof tc.thinkingLevel === "string") {
    out.thinkingConfig = { ...tc, thinkingLevel: stepFrom(GEMINI_STEPS, tc.thinkingLevel, e) };
  }
  return out;
}

// Appended to the system prompt (not at medium — the base prompt already is).
export function effortInstruction(e) {
  switch (effortName(e)) {
    case "minimal":
      return "## EFFORT: MINIMAL\nThe user wants speed. Answer directly and briefly. Skip extended deliberation, alternatives and caveats unless they're essential. Don't search unless the question can't be answered without current information.";
    case "low":
      return "## EFFORT: LOW\nKeep it quick. Think only as much as needed, answer concisely, and avoid long explanations.";
    case "high":
      return "## EFFORT: HIGH\nTake extra care. Think the problem through step by step, consider edge cases and alternatives, double-check facts and calculations, and give a thorough answer. Search when anything might be out of date.";
    case "max":
      return "## EFFORT: MAX\nUse your full effort. Reason exhaustively before answering: break the problem down, consider multiple approaches, check every step, verify facts against sources (search when there's any doubt), and look for mistakes in your own answer before finalising. Be complete — depth matters more than speed here.";
    default:
      return "";
  }
}
