// The link to the brain: Cloak's home PC, reached through a Cloudflare Tunnel
// at BRAIN_URL (https://brain.usecloak.org). The brain runs the agent,
// memory, tasks and files; this Worker stays the front door.
//
// - A cron check every minute (and every failed turn) records whether the
//   brain is up, in the Ledger Durable Object. GET /v1/status reads it.
// - A turn goes to the brain while it is up. If the brain does not answer,
//   or drops out mid-reply, the turn finishes here in Low Light: plain chat,
//   no memory, no tools, lighter models (agent.js, req.lowlight).
// - The brain calls back for models and the web (POST /internal/*), so the
//   provider keys never leave Cloudflare.
//
// Shared secret both ways: BRAIN_TOKEN (Worker secret, brain config).

import { runAgent } from "./agent.js";

const ledger = (env) => env.LEDGER.get(env.LEDGER.idFromName("global"));
const FIRST_BYTE_MS = 8_000; // the brain must start answering within this
const STALL_MS = 60_000; // and never go quiet for longer (it sends pings)

export const brainConfigured = (env) => !!(env.BRAIN_URL && env.BRAIN_TOKEN);

// Status, cached per isolate for a few seconds so busy minutes stay cheap.
let cached = null;
export async function brainState(env) {
  if (!brainConfigured(env)) return { up: false, paused: false, configured: false, checked: 0, since: 0 };
  if (cached && Date.now() - cached.at < 10_000) return cached.s;
  const s = { ...(await ledger(env).brainStatus()), configured: true };
  cached = { at: Date.now(), s };
  return s;
}
async function record(env, next) {
  const s = await ledger(env).setBrain(next);
  cached = { at: Date.now(), s: { ...s, configured: true } };
  return s;
}
export const markDown = (env, reason) => record(env, { up: false, reason: String(reason || "").slice(0, 200) }).catch(() => {});

// The cron check: is the brain there, and does it want to work?
// One miss never counts: a restart after an auto-update or a blip on the
// tunnel lasts seconds, so a failed check is retried before the brain is
// marked away.
async function health(env) {
  try {
    const res = await fetch(`${env.BRAIN_URL}/health`, { headers: { "X-Brain-Token": env.BRAIN_TOKEN }, signal: AbortSignal.timeout(6_000) });
    const h = res.ok ? await res.json() : null;
    return h?.ok ? { up: true, paused: !!h.paused, version: h.version } : { up: false, reason: `health ${res.status}` };
  } catch (e) {
    return { up: false, reason: String(e?.message || e) };
  }
}
export async function checkBrain(env) {
  if (!brainConfigured(env)) return null;
  let h = await health(env);
  if (!h.up) { await new Promise((r) => setTimeout(r, 4_000)); h = await health(env); }
  return await record(env, h);
}

export function statusBody(s) {
  const mode = s.configured === false || (s.up && !s.paused) ? "full" : "lowlight";
  return {
    mode,
    up: !!s.up,
    paused: !!s.paused,
    since: s.since ? new Date(s.since).toISOString() : null,
    checked: s.checked ? new Date(s.checked).toISOString() : null,
    message: mode === "full" ? "Cloak is fully awake." : "Cloak is in Low Light. Chat works; memory, agents and files are resting.",
  };
}

// A request to the brain, authenticated, for proxied routes.
export function toBrain(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Brain-Token", env.BRAIN_TOKEN);
  return fetch(`${env.BRAIN_URL}${path}`, { ...init, headers });
}

// The brain's reply to a turn: SSE in, events out. Throws if it fails.
async function* fromBrain(env, req, signal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer = setTimeout(() => ctrl.abort(), FIRST_BYTE_MS);
  try {
    const res = await toBrain(env, "/v1/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req), signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`brain answered ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), STALL_MS);
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.ping) continue;
        yield ev;
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// One turn: the brain if it is up, Low Light otherwise.
export async function* turn(env, ctx, req, signal) {
  const s = await brainState(env);
  // No brain configured yet: this Worker does everything itself, as before.
  if (!s.configured) {
    yield* runAgent(env, ctx, req, signal);
    return;
  }
  if (s.up && !s.paused) {
    let got = 0;
    try {
      for await (const ev of fromBrain(env, req, signal)) {
        got++;
        yield ev;
        if (ev.done || ev.error) return;
      }
      throw new Error(got ? "the brain stopped mid-reply" : "the brain sent nothing");
    } catch (e) {
      if (signal?.aborted) return;
      ctx.waitUntil?.(checkBrain(env));
      // The brain was already working on it: it keeps going and saves the reply,
      // and the app fetches it when the connection is back. A Low Light answer
      // here would only be a confused second reply.
      if (got) { yield { notice: "Lost the connection to the brain for a moment. It is still working on this; the reply will show up here when it is back." }; return; }
    }
  }
  yield* runAgent(env, ctx, { ...req, lowlight: true }, signal);
}
