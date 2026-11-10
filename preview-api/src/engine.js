// Streams one reply from a lane's lineup, failing over model → model and
// key → key until one answers. Shares production Cloak's free-tier governor
// (key rotation, cooldowns on 429s, dead/slow model memory) so the preview
// never burns quota the live app needs.

import * as gov from "../../api-worker/src/governor.js";
import { LANES, EXTRA_LIMITS } from "./models.js";

const ENDPOINT = {
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  // Gemini's OpenAI-compatible surface: one code path for every provider.
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
};

const STALL_MS = 40_000; // silence after the stream started
const THINK_LIMIT_MS = 90_000; // reasoning with no answer text
const MAX_ATTEMPTS = 7;
const badExtra = new Set();

class UpstreamError extends Error {}

function ctxFor(a) {
  return EXTRA_LIMITS[`${a.provider}:${a.model}`]?.ctx || gov.limitsFor(a.provider, a.model).ctx || 32768;
}

// Removes <think>…</think> spans, including ones split across chunks.
function thinkStripper() {
  let inThink = false;
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let out = "";
    for (;;) {
      if (inThink) {
        const end = buf.indexOf("</think>");
        if (end === -1) {
          buf = buf.slice(-8);
          return out;
        }
        buf = buf.slice(end + 8);
        inThink = false;
      } else {
        const start = buf.indexOf("<think>");
        if (start === -1) {
          // Hold back a possible partial "<think" at the tail.
          const lt = buf.lastIndexOf("<");
          const keep = lt !== -1 && "<think>".startsWith(buf.slice(lt)) ? buf.length - lt : 0;
          out += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          return out;
        }
        out += buf.slice(0, start);
        buf = buf.slice(start + 7);
        inThink = true;
      }
    }
  };
}

async function* sse(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function open(c, body, signal, ctx) {
  const key = `${c.provider}:${c.model}`;
  const extra = badExtra.has(key) ? undefined : c.extra;
  const post = async (ex) => {
    gov.noteCall(gov.slotId(c.provider, c.key, c.model));
    let res;
    try {
      res = await fetch(c.url || ENDPOINT[c.provider], {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` },
        body: JSON.stringify({ ...(ex || {}), ...body, model: c.model, stream: true }),
        signal,
      });
    } catch (e) {
      throw new UpstreamError(`${key} network: ${e.name === "AbortError" ? "timeout" : e.message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      gov.observe({ provider: c.provider, model: c.model, key: c.key, res, bodyText: detail, ctx });
      const err = new UpstreamError(`${key} HTTP ${res.status}: ${detail.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    gov.observe({ provider: c.provider, model: c.model, key: c.key, res, ctx });
    return res;
  };
  try {
    return await post(extra);
  } catch (e) {
    if (!extra || !(e.status === 400 || e.status === 422)) throw e;
    const res = await post(undefined);
    badExtra.add(key);
    return res;
  }
}

// Yields { start, model, provider, size } once a model is answering, then
// { delta } chunks, then { done, text, tokensIn, tokensOut, model, provider,
// size, tried }. Throws only if every model failed before any text went out.
// With `tools`, the done event also carries toolCalls: [{id, name, arguments}]
// (arguments is the raw JSON string the model produced).
export async function* streamLane(env, ctx, laneKey, { system, messages, maxTokens, signal, tools }) {
  const lane = LANES[laneKey] || LANES.smart;
  const ring = await gov.readKeyring(env);
  const groups = lane.lineup.map((a) => ({ ...a, keys: (Array.isArray(ring[a.provider]) ? ring[a.provider] : []).filter(Boolean) })).filter((g) => g.keys.length);
  if (!groups.length) throw new UpstreamError("no provider keys configured");
  await gov.syncCooldowns(gov.idsFor(groups)).catch(() => {});
  const { healthy, cold } = gov.orderCandidates(groups);
  // One key per model first (a second key rarely fixes a model that is down).
  const seen = new Set();
  const first = [];
  const rest = [];
  for (const c of [...healthy, ...cold]) (seen.has(c.model) ? rest : (seen.add(c.model), first)).push(c);
  const cands = [...first, ...rest].slice(0, MAX_ATTEMPTS);

  const tried = [];
  let text = "";
  for (const c of cands) {
    if (signal?.aborted) return;
    if (env.UPSTREAM_OVERRIDE) c.url = env.UPSTREAM_OVERRIDE; // local tests only
    const want = Math.min(maxTokens || lane.maxTokens, lane.maxTokens);
    const budget = Math.floor(ctxFor(c) * 0.9) - want;
    const fitted = gov.trimMessages([{ role: "system", content: system }, ...messages], Math.max(2000, budget)).messages;
    const body = { messages: fitted, max_tokens: want, temperature: c.temperature ?? 0.6 };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    const calls = [];

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => ctrl.abort(), c.firstTokenMs || 20_000);
    const bump = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), ms);
    };
    const t0 = Date.now();
    let started = false;
    let usage = null;
    const strip = thinkStripper();
    try {
      const res = await open(c, body, ctrl.signal, ctx);
      for await (const data of sse(res.body)) {
        if (data === "[DONE]") break;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.error) throw new UpstreamError(`${c.model} stream error: ${JSON.stringify(evt.error).slice(0, 160)}`);
        if (evt.usage) usage = evt.usage;
        const d = evt.choices?.[0]?.delta;
        if (!d) continue;
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = tc.index ?? calls.length;
            const cur = (calls[i] = calls[i] || { id: "", name: "", arguments: "" });
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (typeof tc.function?.arguments === "string") cur.arguments += tc.function.arguments;
          }
          if (!started) {
            started = true;
            yield { start: true, model: c.model, provider: c.provider, size: c.size, firstTokenMs: Date.now() - t0 };
          }
          bump(STALL_MS);
        }
        const piece = typeof d.content === "string" && d.content ? strip(d.content) : "";
        if (!piece) {
          // Reasoning keeps the stream alive, but not forever.
          if (!started && Date.now() - t0 > THINK_LIMIT_MS) throw new UpstreamError(`${c.model} reasoned too long`);
          bump(STALL_MS);
          continue;
        }
        if (!started) {
          // Drop leading blank lines some models emit before the first word.
          const lead = text ? piece : piece.replace(/^\s+/, "");
          if (!lead) continue;
          started = true;
          yield { start: true, model: c.model, provider: c.provider, size: c.size, firstTokenMs: Date.now() - t0 };
          text += lead;
          yield { delta: lead };
        } else {
          text += piece;
          yield { delta: piece };
        }
        bump(STALL_MS);
      }
      if (!started) throw new UpstreamError(`${c.model} returned no text`);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      tried.push({ model: c.model, ok: true, ms: Date.now() - t0 });
      yield {
        done: true,
        text,
        model: c.model,
        provider: c.provider,
        size: c.size,
        tokensIn: usage?.prompt_tokens || gov.estimateMessages(fitted),
        tokensOut: usage?.completion_tokens || gov.estimateTokens(text) + gov.estimateTokens(calls.map((x) => x.arguments).join("")),
        toolCalls: calls.filter((x) => x && x.name).map((x, i) => ({ id: x.id || `call_${Date.now().toString(36)}_${i}`, name: x.name, arguments: x.arguments || "{}" })),
        tried,
      };
      return;
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return;
      const timedOut = ctrl.signal.aborted;
      if (timedOut && !started) gov.markSlow(c.provider, c.model, ctx);
      tried.push({ model: c.model, ok: false, ms: Date.now() - t0, error: timedOut ? (started ? "stalled" : "slow first token") : String(e.message || e).slice(0, 160) });
      if (started) {
        // Text already went out: finish honestly rather than restart mid-sentence.
        yield { done: true, partial: true, text, model: c.model, provider: c.provider, size: c.size, tokensIn: gov.estimateMessages(fitted), tokensOut: gov.estimateTokens(text), tried };
        return;
      }
    }
  }
  const err = new UpstreamError("all models failed");
  err.tried = tried;
  throw err;
}

// One short non-streamed completion on the utility lane (titles, probes).
export async function complete(env, ctx, laneKey, req) {
  let out = null;
  for await (const ev of streamLane(env, ctx, laneKey, req)) if (ev.done) out = ev;
  return out;
}

// Times every model in every lane with a one-line prompt (GET /admin/probe).
export async function probe(env, ctx) {
  const ring = await gov.readKeyring(env);
  const models = new Map();
  for (const [lane, cfg] of Object.entries(LANES)) for (const a of cfg.lineup) models.set(`${a.provider}:${a.model}`, { ...a, lanes: [...(models.get(`${a.provider}:${a.model}`)?.lanes || []), lane] });
  const one = async (a) => {
    const key = (ring[a.provider] || [])[0];
    if (!key) return { model: a.model, provider: a.provider, lanes: a.lanes, ok: false, error: "no key" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    const t0 = Date.now();
    let first = 0;
    let chars = 0;
    try {
      const res = await open({ ...a, key }, { messages: [{ role: "user", content: "Reply with one short sentence about rivers." }], max_tokens: 200, temperature: 0.3 }, ctrl.signal, ctx);
      for await (const data of sse(res.body)) {
        if (data === "[DONE]") break;
        try {
          const d = JSON.parse(data).choices?.[0]?.delta;
          const s = (d?.content || "") + (d?.reasoning_content || d?.reasoning || "");
          if (s) {
            if (!first) first = Date.now() - t0;
            chars += s.length;
          }
        } catch {}
      }
      const total = Date.now() - t0;
      return { model: a.model, provider: a.provider, lanes: a.lanes, ok: chars > 0, firstTokenMs: first, totalMs: total, tokPerSec: Math.round((chars / 3.6 / Math.max(1, total - first)) * 1000) };
    } catch (e) {
      return { model: a.model, provider: a.provider, lanes: a.lanes, ok: false, error: ctrl.signal.aborted ? "timeout (25s)" : String(e.message || e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  };
  const results = await Promise.all([...models.values()].map(one));
  return results.sort((x, y) => (y.ok - x.ok) || (x.firstTokenMs || 9e9) - (y.firstTokenMs || 9e9));
}
