// Cloud runs: the agent works inside a Durable Object, not inside the browser's
// request, so closing the tab does not stop it. Every event is kept; a client
// can attach late or re-attach after a dropped connection and replay from N.
//
//   POST /v1/chat  { …, run_id }      start (or attach if already started)
//   GET  /v1/runs/:id?from=N          replay from event N, then follow live
//   POST /v1/runs/:id/cancel          stop
//
// If a run finishes with nobody watching, the answer is delivered to the
// person's inbox (Mind), so it is waiting when they come back.

import { DurableObject } from "cloudflare:workers";
import { mindFor } from "./agent.js";
import { turn, brainState, toBrain } from "./brainlink.js";
import { stripTags } from "./prompts.js";

const KEEP_MS = 10 * 60_000;
const enc = new TextEncoder();
const line = (e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);
// The full answer rides on `done` for headless callers; browsers already have the deltas.
const wire = (e) => (e.done ? { ...e, text: undefined } : e);

export class AgentRun extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.events = [];
    this.subs = new Set();
    this.status = "idle"; // idle | running | done | error | cancelled
    this.pending = null;
    this.ctrl = null;
    this.notes = [];
    this.req = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const tail = url.pathname.split("/").pop();
    if (request.method === "POST" && tail === "start") {
      if (this.status === "idle") {
        this.pending = await request.json();
        this.status = "running";
        this.ctrl = new AbortController();
        // The work runs from the alarm: a request's work dies with its caller.
        await this.ctx.storage.setAlarm(Date.now());
      }
      return this.attach(0);
    }
    // A message sent while the run works: the agent reads it before its next step.
    if (request.method === "POST" && tail === "note") {
      const { text } = await request.json().catch(() => ({}));
      const t = String(text || "").trim().slice(0, 4000);
      if (!t || this.status !== "running") return new Response('{"ok":false}', { headers: { "Content-Type": "application/json" } });
      this.notes.push(t);
      // When the brain runs this turn, it keeps its own copy of the notes.
      const r = this.req;
      if (r?.userKey) toBrain(this.env, "/v1/blink/inject", { method: "POST", headers: { "Content-Type": "application/json", "X-User-Key": r.userKey }, body: JSON.stringify({ run_id: r.run_id, text: t }) }).catch(() => {});
      return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "POST" && tail === "cancel") {
      if (this.status === "running") {
        this.status = "cancelled";
        this.ctrl?.abort();
      }
      return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "GET") {
      if (this.status === "idle") return new Response('{"error":"Run not found"}', { status: 404, headers: { "Content-Type": "application/json" } });
      return this.attach(Math.max(0, parseInt(url.searchParams.get("from") || "0", 10) || 0));
    }
    return new Response("Not found", { status: 404 });
  }

  attach(from) {
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    for (const e of this.events.slice(from)) w.write(line(wire(e))).catch(() => {});
    if (this.status === "running") this.subs.add(w);
    else w.close().catch(() => {});
    return new Response(readable, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Run-Status": this.status } });
  }

  push(e) {
    this.events.push(e);
    const chunk = line(wire(e));
    for (const w of this.subs) w.write(chunk).catch(() => this.subs.delete(w));
  }

  async alarm() {
    if (!this.pending) {
      // Kept long enough: forget the run.
      if (this.status !== "running") {
        this.events = [];
        this.status = "idle";
      }
      return;
    }
    const body = this.pending;
    this.pending = null;
    this.req = body;
    body.pending = () => this.notes.splice(0); // used when the Worker runs the turn (Low Light)
    let final = null;
    // Long quiet steps (the computer, deep research) send nothing for a while:
    // keep every watcher's connection warm so nothing in between drops it.
    const beat = setInterval(() => { for (const w of this.subs) w.write(enc.encode(": ping\n\n")).catch(() => this.subs.delete(w)); }, 15_000);
    try {
      for await (const e of turn(this.env, { waitUntil: (p) => this.ctx.waitUntil(p) }, body, this.ctrl.signal)) {
        if (this.status === "cancelled") break;
        if (e.done) final = e;
        this.push(e);
      }
      if (this.status === "running") this.status = "done";
    } catch (err) {
      console.error("[blinks-api] run failed", JSON.stringify(err?.tried || String(err?.message || err)));
      if (this.status === "running") {
        this.status = "error";
        this.push({ error: friendly(err) });
      }
    }
    clearInterval(beat);
    const watched = this.subs.size > 0;
    for (const w of this.subs) w.close().catch(() => {});
    this.subs.clear();
    // Nobody was here for the ending: leave the answer in their inbox. (The
    // brain already saved it into the Blink's chat when stored_at is set.)
    if (!watched && final?.text && !final.stored_at && body.userKey) {
      const ask = body.messages[body.messages.length - 1]?.content || "";
      const item = { kind: "reply", title: String(ask).slice(0, 100), companion: body.companion || "cloak", body: stripTags(final.text), meta: { chat_id: body.chat_id || null, sources: final.sources, impact: final.impact, lane: final.lane } };
      // The inbox lives on the brain while it is up.
      const s = await brainState(this.env).catch(() => ({}));
      if (s.up) await toBrain(this.env, "/v1/inbox/deliver", { method: "POST", headers: { "Content-Type": "application/json", "X-User-Key": body.userKey }, body: JSON.stringify(item) }).catch(() => {});
      else await mindFor(this.env, body.userKey)?.deliver(item).catch(() => {});
    }
    await this.ctx.storage.setAlarm(Date.now() + KEEP_MS);
  }
}

// What the person sees when a reply fails, in plain words, and honest about why.
export function friendly(err) {
  const tried = JSON.stringify(err?.tried || "") + String(err?.message || err || "");
  if (/Too many subrequests/i.test(tried)) return "That one needed more work than a single reply allows. Ask again and I will pick it up from there.";
  if (/HTTP 429|rate.?limit|quota/i.test(tried)) return "Every model is busy right now. Give it a moment and try again.";
  if (/timeout|timed out/i.test(tried)) return "The models are slow to answer right now. Try again in a moment.";
  return "Something went wrong while answering. Try again in a moment.";
}
