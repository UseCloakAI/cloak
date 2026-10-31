// ─────────────────────────────────────────────────────────────────────────────
// Cloud runs — replies are generated here, not in the browser.
//
// POST /v1/chat with `run: { id, chat_id?, token?, sb? }` hands the request to
// a ChatRun Durable Object (one per run id). The DO calls the model, keeps
// every SSE event, and streams them to whoever is attached. The browser can
// drop (tab closed, phone locked) and the reply keeps going.
//
//   GET  /v1/runs/:id?from=N   replay events from N, then follow live
//   POST /v1/runs/:id/claim    the browser got the result and saves it itself
//   POST /v1/runs/:id/cancel   stop button
//
// If nobody claims a finished run within CLAIM_MS, the DO writes the reply to
// the user's chat in Supabase (thread_messages, with their own JWT, so RLS
// applies). Realtime then shows it on every open device.
// ─────────────────────────────────────────────────────────────────────────────

const CLAIM_MS = 15_000;
const KEEP_MS = 10 * 60_000;     // a finished run stays replayable this long
const SSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } });
const enc = new TextEncoder();
const line = (e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);

// Strip control tags the browser would have acted on; what's left is prose.
function cleanFinal(t) {
  return String(t || "")
    .replace(/<(search|fetch|code|review)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, "")
    .replace(/<look\b[^>]*\/>|<done\s*\/?>/gi, "")
    .trim();
}
function jwtSub(token) {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "===".slice((p.length + 3) % 4))).sub || null;
  } catch { return null; }
}
function okSupabase(url) {
  try { const u = new URL(url); return u.protocol === "https:" && /\.supabase\.co$/.test(u.hostname); } catch { return false; }
}

export function makeChatRun(produceEvents) {
  return class ChatRun {
    constructor(state, env) {
      this.state = state;
      this.env = env;
      this.events = [];
      this.subs = new Set();
      this.status = "idle";       // idle | running | done | error | cancelled
      this.claimed = false;
      this.ctrl = null;
      this.meta = null;
    }

    async fetch(request) {
      const url = new URL(request.url);
      const tail = url.pathname.split("/").pop();
      if (request.method === "POST" && tail === "start") return this.start(await request.json());
      if (request.method === "POST" && tail === "claim") { this.claimed = true; return J({ ok: true }); }
      if (request.method === "POST" && tail === "cancel") {
        this.claimed = true;
        if (this.status === "running") { this.status = "cancelled"; this.ctrl?.abort(); }
        return J({ ok: true });
      }
      if (request.method === "GET") {
        if (this.status === "idle") return J({ error: "Run not found" }, 404);
        return this.attach(Math.max(0, parseInt(url.searchParams.get("from") || "0", 10) || 0));
      }
      return J({ error: "Not found" }, 404);
    }

    start(body) {
      if (this.status !== "idle") return this.attach(0);
      const run = body.run || {};
      this.meta = {
        chat_id: typeof run.chat_id === "string" ? run.chat_id : null,
        token: typeof run.token === "string" ? run.token : null,
        sb: run.sb && okSupabase(run.sb.url) && typeof run.sb.key === "string" ? run.sb : null,
        id: String(run.id).slice(0, 64),
      };
      delete body.run;
      // The work runs in the alarm handler, not this request: a request's work
      // dies with its caller's connection; an alarm runs on its own (15 min).
      this.status = "running";
      this.pending = body;
      this.ctrl = new AbortController();
      this.state.storage.setAlarm(Date.now());
      return this.attach(0);
    }

    async work(body) {
      let full = "";
      const ctx = { waitUntil: (p) => { p?.catch?.(() => {}); } };
      try {
        for await (const e of produceEvents(this.env, body, ctx, this.ctrl.signal)) {
          if (this.status === "cancelled") break;
          if (typeof e.delta === "string") full += e.delta;
          if (e.done && typeof e.response === "string") full = e.response;
          if (e.error && e.partial) full = e.partial;
          this.push(e);
          if (e.error) { this.status = "error"; break; }
        }
        if (this.status === "running") this.status = "done";
      } catch (err) {
        if (this.status === "running") {
          this.status = "error";
          this.push({ error: err?.message || "The response was interrupted. Please try again.", partial: full });
        }
      }
      this.final = full;
      for (const w of this.subs) w.close().catch(() => {});
      this.subs.clear();
      this.state.storage.setAlarm(Date.now() + CLAIM_MS);
    }

    push(e) {
      this.events.push(e);
      const chunk = line(e);
      for (const w of this.subs) w.write(chunk).catch(() => this.subs.delete(w));
    }

    attach(from) {
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      for (const e of this.events.slice(from)) w.write(line(e)).catch(() => {});
      if (this.status === "running") this.subs.add(w);
      else w.close().catch(() => {});
      return new Response(readable, { headers: { ...SSE_HEADERS, "X-Run-Status": this.status, "X-Run-Persisted": this.persisted ? "1" : "0", "Access-Control-Expose-Headers": "X-Run-Status, X-Run-Persisted" } });
    }

    async alarm() {
      if (this.pending) {
        const body = this.pending;
        this.pending = null;
        try { await this.work(body); } catch (e) { console.error("[cloak-api] run work:", e?.message || e); }
        return;   // work() set the claim alarm
      }
      if (this.status === "running") return;   // evicted mid-run and lost: nothing to do
      if (!this.persisted) {
        this.persisted = true;
        if (!this.claimed && this.status !== "cancelled") await this.persist().catch((e) => console.error("[cloak-api] run persist:", e?.message || e));
        this.state.storage.setAlarm(Date.now() + KEEP_MS);
        return;
      }
      // Done and kept long enough: forget it.
      this.events = [];
      this.status = "idle";
    }

    async persist() {
      const m = this.meta;
      const text = cleanFinal(this.final);
      if (!m || !m.sb || !m.token || !m.chat_id || !text) return;
      const uid = jwtSub(m.token);
      if (!uid) return;
      const r = await fetch(m.sb.url.replace(/\/$/, "") + "/rest/v1/thread_messages", {
        method: "POST",
        headers: {
          apikey: m.sb.key,
          Authorization: "Bearer " + m.token,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ user_id: uid, chat_id: m.chat_id, role: "assistant", content: text.slice(0, 60000), source: "web", client_id: "run-" + m.id.slice(0, 56) }),
      });
      if (!r.ok) throw new Error("supabase " + r.status + " " + (await r.text()).slice(0, 200));
    }
  };
}

// Router glue: returns a Response, or null if the path isn't a run route.
export async function routeRun(env, request, path, body) {
  if (!env.CHAT_RUN) return null;
  if (path === "/v1/chat" && body) {
    const id = String(body.run.id || "").slice(0, 64);
    if (!/^[\w-]{8,64}$/.test(id)) return J({ error: "bad run id" }, 400);
    const stub = env.CHAT_RUN.get(env.CHAT_RUN.idFromName(id));
    return stub.fetch("https://run/start", { method: "POST", body: JSON.stringify(body) });
  }
  const m = path.match(/^\/v1\/runs\/([\w-]{8,64})(?:\/(claim|cancel))?$/);
  if (!m) return null;
  const stub = env.CHAT_RUN.get(env.CHAT_RUN.idFromName(m[1]));
  const u = new URL(request.url);
  return stub.fetch("https://run/" + (m[2] || "events") + u.search, { method: request.method });
}
