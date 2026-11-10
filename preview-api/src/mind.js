// Mind: one Durable Object per person. Holds what the companions remember
// about them, their scheduled tasks, and an inbox of results that arrived
// while they were away. The alarm runs due tasks through the agent.
//
// Addressed by user key: "u:<supabase user id>" when signed in, otherwise
// "d:<device id>" (a random secret the app keeps on the device).

import { DurableObject } from "cloudflare:workers";
import { runAgent, collect } from "./agent.js";

const MAX_MEMORIES = 200;
const MAX_TASKS = 10;
const MAX_INBOX = 60;
const STOP = new Set("a an and are as at be but by for from has have he her his i in is it its my of on or she that the their they this to was we were with you your".split(" "));

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
function overlap(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
const STEP = { hourly: 3600_000, daily: 86400_000, weekly: 7 * 86400_000 };

export class Mind extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, fact TEXT NOT NULL, kind TEXT NOT NULL, by TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, prompt TEXT NOT NULL, companion TEXT NOT NULL, brand TEXT NOT NULL, run_at INTEGER NOT NULL, repeat TEXT NOT NULL, runs INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL, companion TEXT NOT NULL, body TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', created INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
    `);
  }

  // The object needs to know its own key to act for the person later (tasks).
  hello(key) {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES ('key', ?) ON CONFLICT(k) DO NOTHING`, String(key));
  }
  key() {
    return this.sql.exec(`SELECT v FROM meta WHERE k = 'key'`).toArray()[0]?.v || null;
  }

  // ── Memory ────────────────────────────────────────────────────────────────
  remember({ fact, kind = "other", by = "pip" }) {
    const text = String(fact || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (text.length < 4) return { ok: false, error: "nothing to save" };
    if (/\b(password|passcode|pin|cvv|ssn|social security|card number)\b/i.test(text) && /\d{3,}/.test(text)) return { ok: false, error: "secrets are never stored" };
    const k = ["profile", "preference", "project", "person", "other"].includes(kind) ? kind : "other";
    const now = Date.now();
    const w = words(text);
    for (const m of this.sql.exec(`SELECT id, fact FROM memory`).toArray()) {
      if (overlap(w, words(m.fact)) >= 0.75) {
        this.sql.exec(`UPDATE memory SET fact = ?, kind = ?, by = ?, updated = ? WHERE id = ?`, text, k, by, now, m.id);
        return { ok: true, updated: true, id: m.id };
      }
    }
    this.sql.exec(`INSERT INTO memory (fact, kind, by, created, updated) VALUES (?, ?, ?, ?, ?)`, text, k, by, now, now);
    this.sql.exec(`DELETE FROM memory WHERE id NOT IN (SELECT id FROM memory ORDER BY updated DESC LIMIT ?)`, MAX_MEMORIES);
    return { ok: true, updated: false };
  }
  memories() {
    return this.sql.exec(`SELECT id, fact, kind, by, created, updated FROM memory ORDER BY updated DESC`).toArray().map((m) => ({ ...m, day: new Date(m.updated).toISOString().slice(0, 10) }));
  }
  recall(query, limit = 12) {
    const q = words(query);
    const now = Date.now();
    return this.memories()
      .map((m) => ({ ...m, score: overlap(q, words(m.fact)) + (m.kind === "profile" || m.kind === "preference" ? 0.15 : 0) + Math.max(0, 0.1 - (now - m.updated) / (90 * 86400_000) * 0.1) }))
      .filter((m) => !q.length || m.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  // What goes into the prompt each turn: who they are, plus whatever matches.
  context(query) {
    const all = this.memories();
    if (all.length <= 14) return all;
    const core = all.filter((m) => m.kind === "profile" || m.kind === "preference").slice(0, 8);
    const seen = new Set(core.map((m) => m.id));
    return [...core, ...this.recall(query, 10).filter((m) => !seen.has(m.id))].slice(0, 16);
  }
  forget(query) {
    const q = words(query);
    if (!q.length) return 0;
    const hit = this.memories().filter((m) => overlap(q, words(m.fact)) >= 0.5);
    for (const m of hit) this.sql.exec(`DELETE FROM memory WHERE id = ?`, m.id);
    return hit.length;
  }
  forgetId(id) {
    this.sql.exec(`DELETE FROM memory WHERE id = ?`, Number(id));
    return true;
  }
  forgetAll() {
    this.sql.exec(`DELETE FROM memory`);
    return true;
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  async addTask({ title, prompt, run_at, repeat = "none", companion = "pip", brand = "Cloak Blinks" }) {
    const when = Date.parse(run_at);
    if (!Number.isFinite(when)) return { ok: false, error: "run_at must be an ISO 8601 time, for example 2026-11-11T14:00:00Z" };
    if (when > Date.now() + 366 * 86400_000) return { ok: false, error: "that is more than a year away" };
    const rep = STEP[repeat] ? repeat : "none";
    const p = String(prompt || "").trim().slice(0, 2000);
    if (p.length < 4) return { ok: false, error: "the task needs an instruction" };
    if (this.sql.exec(`SELECT COUNT(*) n FROM task`).one().n >= MAX_TASKS) return { ok: false, error: `the limit is ${MAX_TASKS} scheduled tasks; cancel one first` };
    const at = Math.max(when, Date.now() + 30_000);
    const id = this.sql.exec(`INSERT INTO task (title, prompt, companion, brand, run_at, repeat, created) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, String(title || "Task").slice(0, 80), p, companion, brand, at, rep, Date.now()).one().id;
    await this.arm();
    return { ok: true, id, run_at: new Date(at).toISOString().slice(0, 16).replace("T", " "), repeat: rep };
  }
  tasks() {
    return this.sql.exec(`SELECT id, title, prompt, companion, run_at, repeat, runs FROM task ORDER BY run_at`).toArray().map((t) => ({ ...t, run_at: new Date(t.run_at).toISOString().slice(0, 16).replace("T", " "), at: t.run_at }));
  }
  async removeTask(id) {
    const had = this.sql.exec(`SELECT id FROM task WHERE id = ?`, Number(id)).toArray().length > 0;
    this.sql.exec(`DELETE FROM task WHERE id = ?`, Number(id));
    await this.arm();
    return had;
  }
  async arm() {
    const next = this.sql.exec(`SELECT MIN(run_at) t FROM task`).one().t;
    if (next) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
    else await this.ctx.storage.deleteAlarm();
  }

  // Runs whatever is due. Each task is a full agent run with tools; the
  // result goes to the inbox. A failing task still reschedules.
  async alarm() {
    const key = this.key();
    const due = this.sql.exec(`SELECT * FROM task WHERE run_at <= ? ORDER BY run_at LIMIT 3`, Date.now() + 5000).toArray();
    for (const t of due) {
      let body = "", meta = {};
      try {
        const out = await collect(runAgent(this.env, { waitUntil: (p) => this.ctx.waitUntil(p) }, {
          brand: t.brand, companion: t.companion, userKey: key, mode: "auto", background: true,
          messages: [{ role: "user", content: `Scheduled task "${t.title}". Carry it out now and write the result for me to read later.\n\n${t.prompt}` }],
        }));
        body = out.text || "The task ran but produced nothing.";
        meta = { sources: out.sources, impact: out.impact, steps: out.steps };
      } catch (e) {
        body = "This task could not run: every model was busy. It will try again at its next scheduled time.";
      }
      this.deliver({ kind: "task", title: t.title, companion: t.companion, body, meta });
      if (STEP[t.repeat]) {
        let next = t.run_at + STEP[t.repeat];
        while (next <= Date.now()) next += STEP[t.repeat];
        this.sql.exec(`UPDATE task SET run_at = ?, runs = runs + 1 WHERE id = ?`, next, t.id);
      } else this.sql.exec(`DELETE FROM task WHERE id = ?`, t.id);
    }
    await this.arm();
  }

  // ── Inbox ─────────────────────────────────────────────────────────────────
  deliver({ kind = "task", title = "", companion = "pip", body = "", meta = {} }) {
    this.sql.exec(`INSERT INTO inbox (kind, title, companion, body, meta, created) VALUES (?, ?, ?, ?, ?, ?)`, kind, String(title).slice(0, 120), companion, String(body).slice(0, 60_000), JSON.stringify(meta || {}), Date.now());
    this.sql.exec(`DELETE FROM inbox WHERE id NOT IN (SELECT id FROM inbox ORDER BY id DESC LIMIT ?)`, MAX_INBOX);
  }
  inbox() {
    return this.sql.exec(`SELECT id, kind, title, companion, body, meta, created, seen FROM inbox ORDER BY id DESC`).toArray().map((r) => ({ ...r, meta: safe(r.meta), seen: !!r.seen }));
  }
  seen(ids) {
    for (const id of Array.isArray(ids) ? ids : []) this.sql.exec(`UPDATE inbox SET seen = 1 WHERE id = ?`, Number(id));
    return true;
  }
  removeInbox(id) {
    this.sql.exec(`DELETE FROM inbox WHERE id = ?`, Number(id));
    return true;
  }

  // Everything the app needs for its side panels, in one call.
  overview() {
    return { memories: this.memories(), tasks: this.tasks(), inbox: this.inbox() };
  }
  // Wipes the person's data (memories, tasks, inbox).
  async erase() {
    this.sql.exec(`DELETE FROM memory; DELETE FROM task; DELETE FROM inbox;`);
    await this.ctx.storage.deleteAlarm();
    return true;
  }
}

function safe(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
