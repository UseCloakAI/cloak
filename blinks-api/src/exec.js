// Exec: a tiny Durable Object that does one outbound job and returns.
//
// Why it exists: Cloudflare caps how many outbound requests one invocation
// may make (50 on the free plan). A reply that searches eight times, reads
// pages and falls over between models blew through that, and every model
// then "failed" instantly. Each Exec call is its own invocation with its own
// budget, so the agent run spends exactly one request per model call or
// per web fetch, however much failover happens inside.
//
//   execLane(env, lane, opts)   async generator, same events as streamLane
//   execNet(env)                { search(query, recent), read(url) }

import { DurableObject } from "cloudflare:workers";
import { streamLane } from "./engine.js";
import { search, readPage } from "./tools.js";

const enc = new TextEncoder();

export class Exec extends DurableObject {
  async fetch(request) {
    const job = await request.json();
    const ctx = { waitUntil: (p) => this.ctx.waitUntil(p) };
    if (job.kind === "lane") {
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      const ctrl = new AbortController();
      (async () => {
        try {
          for await (const ev of streamLane(this.env, ctx, job.lane, { ...job.opts, signal: ctrl.signal })) {
            await w.write(enc.encode(JSON.stringify(ev) + "\n"));
          }
        } catch (e) {
          await w.write(enc.encode(JSON.stringify({ error: String(e?.message || e).slice(0, 500), tried: e?.tried }) + "\n")).catch(() => ctrl.abort());
        }
        await w.close().catch(() => ctrl.abort());
      })();
      return new Response(readable, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    try {
      if (job.kind === "search") return Response.json({ ok: true, data: await search(this.env, job.query, !!job.recent) });
      if (job.kind === "read") return Response.json({ ok: true, data: await readPage(this.env, job.url) });
    } catch (e) {
      return Response.json({ ok: false, error: String(e?.message || e).slice(0, 300) });
    }
    return Response.json({ ok: false, error: "unknown job" }, { status: 400 });
  }
}

const stub = (env) => env.EXEC.get(env.EXEC.newUniqueId());

export async function* execLane(env, lane, opts = {}) {
  const { signal, ...rest } = opts;
  const res = await stub(env).fetch("https://exec/lane", { method: "POST", body: JSON.stringify({ kind: "lane", lane, opts: rest }) });
  const reader = res.body.getReader();
  const stop = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", stop, { once: true });
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.error) {
          const err = new Error(ev.error);
          err.tried = ev.tried;
          throw err;
        }
        yield ev;
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

async function job(env, body) {
  const res = await stub(env).fetch("https://exec/job", { method: "POST", body: JSON.stringify(body) });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || "failed");
  return out.data;
}

export function execNet(env) {
  return {
    search: (query, recent) => job(env, { kind: "search", query, recent }),
    read: (url) => job(env, { kind: "read", url }),
  };
}
