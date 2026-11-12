// Blinks on the brain: each of a person's Blinks is a folder of files.
//
//   /var/lib/cloak-brain/blinks/<person>/<blink>/
//     SOUL.md      who this Blink is, in its own words (seeded, editable)
//     USER.md      what it knows about the person (profile, preferences)
//     MEMORY.md    everything else worth keeping (projects, people, notes)
//     HISTORY.md   the conversation so far, compacted into a summary
//     log.jsonl    the one continuous chat, every message, append-only
//     state.json   where compaction has reached, the Blink's spec
//     mind.sqlite  its scheduled tasks and inbox (MindCore)
//
// One chat per Blink, never several. Older messages are compacted into
// HISTORY.md automatically; the model sees the summary plus the recent
// messages. Turns finish here even if the browser goes away, and land in
// log.jsonl, which the app reads back when it returns.
//
// Blinks can message each other (message_blink). After every few messages
// in one exchange, a quick model call checks whether they are making
// progress or going in circles, and stops the exchange if it is a loop.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { MindCore } from "../blinks-api/src/mind-core.js";
import { COMPANIONS, customCompanion, stripTags } from "../blinks-api/src/prompts.js";
import { openSql } from "./sqlite.js";

const KEEP_RECENT = 12; // messages always kept verbatim
const COMPACT_AFTER = 30; // compact once this many messages are past the summary
const COMPACT_CHARS = 18_000;
const LOOP_CHECK_EVERY = 4; // Blink-to-Blink messages between loop checks
const BACKSTOP = 40; // technical ceiling for one exchange (runaway cost guard)

const STOP = new Set("a an and are as at be but by for from has have he her his i in is it its my of on or she that the their they this to was we were with you your".split(" "));
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
function overlap(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
const hashId = (s) => parseInt(crypto.createHash("sha1").update(s).digest("hex").slice(0, 8), 16);
const today = () => new Date().toISOString().slice(0, 10);
const safeId = (id) => (/^(cloak|u_[a-z0-9]{4,36})$/i.test(id) ? id : "cloak");

export function makeBlinks({ DATA, userDir, env, utility, runAgent, collect, log, legacy = () => [] }) {
  const root = path.join(DATA, "blinks");
  fs.mkdirSync(root, { recursive: true });
  const stores = new Map();
  const minds = new Map();

  // ── One Blink's folder ────────────────────────────────────────────────
  function store(user, blinkId, spec) {
    const id = safeId(blinkId);
    const key = `${user}#${id}`;
    let s = stores.get(key);
    if (!s) {
      s = new BlinkStore(path.join(root, userDir(user), id), id);
      stores.set(key, s);
    }
    if (spec) s.setSpec(spec);
    s.ensureSoul();
    return s;
  }

  class BlinkStore {
    constructor(dir, id) {
      this.dir = dir;
      this.id = id;
      fs.mkdirSync(dir, { recursive: true });
      this.state = read(path.join(dir, "state.json"), { cut: 0, spec: null });
    }
    file(name) { return path.join(this.dir, name); }
    saveState() { fs.writeFileSync(this.file("state.json"), JSON.stringify(this.state)); }
    setSpec(spec) {
      const clean = { id: this.id, name: String(spec.name || "").slice(0, 32), purpose: String(spec.purpose || "").slice(0, 160), persona: String(spec.persona || "").slice(0, 1500), lane: spec.lane || "smart" };
      if (JSON.stringify(clean) !== JSON.stringify(this.state.spec)) { this.state.spec = clean; this.saveState(); }
    }
    get name() { return this.id === "cloak" ? "Cloak" : this.state.spec?.name || "Your Blink"; }
    ensureSoul() {
      if (fs.existsSync(this.file("SOUL.md"))) return;
      const sp = this.state.spec || {};
      const voice = this.id === "cloak" ? COMPANIONS.cloak.voice : (customCompanion({ ...sp, id: this.id }) || {}).voice || "";
      fs.writeFileSync(this.file("SOUL.md"), `# SOUL.md: ${this.name}

Who I am, in my own words. I read this before every conversation. The person can edit it.

## Identity
- Name: ${this.name}
- Purpose: ${this.id === "cloak" ? "Their main Blink: the O from the Cloak logo, awake." : sp.purpose || "Whatever they need."}

## How I talk
${voice.trim()}

## What I hold to
- I never help harm a human life, and I look out for the person.
- I am honest, even when it is not what they want to hear.
- I remember what matters to them and use it to help, never against them.
`);
      for (const [f, title, blurb] of [["USER.md", "USER.md", "What I know about the person. One fact per line."], ["MEMORY.md", "MEMORY.md", "Projects, people, plans and notes worth keeping."]]) {
        if (!fs.existsSync(this.file(f))) fs.writeFileSync(this.file(f), `# ${title}\n\n${blurb}\n\n`);
      }
    }
    readFile(name) { try { return fs.readFileSync(this.file(name), "utf8"); } catch { return ""; } }

    // ── The continuous chat ─────────────────────────────────────────────
    log() {
      const raw = this.readFile("log.jsonl");
      return raw ? raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    }
    append(entry) {
      const e = { role: entry.role, content: String(entry.content || "").slice(0, 60_000), at: Math.max(entry.at || 0, (this.lastAt || 0) + 1, Date.now()) };
      if (entry.from) e.from = entry.from;
      if (entry.task) e.task = entry.task;
      this.lastAt = e.at;
      fs.appendFileSync(this.file("log.jsonl"), JSON.stringify(e) + "\n");
      return e;
    }
    // Lines up the app's copy of the chat with this one: whatever the app has
    // after the last message both share gets added (messages sent while the
    // brain was away, in Low Light, come in this way too).
    takeIncoming(messages) {
      const all = this.log();
      const key = (c) => stripTags(String(c || "").replace(/^\(I tapped [^)]*\)\n/, "").replace(/^\[A message from [^\]]*\]\n/, "")).replace(/\s+/g, " ").trim();
      let add = null;
      if (all.length) {
        const last = key(all[all.length - 1].content);
        for (let i = messages.length - 1; i >= 0; i--) if (key(messages[i].content) === last) { add = messages.slice(i + 1); break; }
      } else add = messages.slice(-KEEP_RECENT * 2); // first turn here: bring the app's history along
      if (!add) {
        let i = messages.length;
        while (i > 0 && messages[i - 1].role === "user") i--;
        add = messages.slice(i);
      }
      for (const m of add) if (m.content && !/^\[A message from /.test(m.content)) this.append({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }
    // What the model sees: everything after the compacted summary, as chat.
    recent() {
      const msgs = this.log().slice(this.state.cut).map((e) => ({
        role: e.role === "assistant" ? "assistant" : "user",
        content: e.from ? `[A message from ${e.from}, another of this person's Blinks]\n${e.content}` : e.task ? `[Scheduled task "${e.task}" finished]\n${e.content}` : e.content,
      }));
      while (msgs.length && msgs[0].role !== "user") msgs.shift();
      return msgs;
    }
    needsCompact() {
      const rest = this.log().slice(this.state.cut);
      const chars = rest.reduce((n, e) => n + e.content.length, 0);
      return rest.length > COMPACT_AFTER || (rest.length > KEEP_RECENT + 4 && chars > COMPACT_CHARS);
    }
    async compact() {
      const all = this.log();
      const upto = Math.max(this.state.cut, all.length - KEEP_RECENT);
      const old = all.slice(this.state.cut, upto);
      if (!old.length) return 0;
      const transcript = old.map((e) => `${e.role === "user" ? (e.from || "Person") : this.name}: ${stripTags(e.content).slice(0, 2000)}`).join("\n");
      const prior = this.readFile("HISTORY.md").replace(/^# HISTORY\.md[^\n]*\n+/, "");
      const summary = await utility(
        `You keep the running summary of a long chat between a person and their AI companion "${this.name}". Merge the earlier summary and the new messages into one updated summary in Markdown: what they talked about, decisions, open threads, promises made, and anything the companion should not forget. Keep names, numbers and dates exact. Plain bullets under short headings, at most 600 words. Write it in the third person ("They asked...").`,
        `EARLIER SUMMARY:\n${prior || "(none yet)"}\n\nNEW MESSAGES:\n${transcript}`,
      );
      if (!summary || summary.length < 40) return 0;
      fs.writeFileSync(this.file("HISTORY.md"), `# HISTORY.md: the conversation so far (compacted ${today()})\n\n${summary.trim()}\n`);
      this.state.cut = upto;
      this.saveState();
      log("info", `compacted ${old.length} messages for ${this.name}`);
      return old.length;
    }
    // Everything the Blink knows about itself and this conversation.
    soul() { return this.readFile("SOUL.md").replace(/^# SOUL\.md[^\n]*\n+/, "").trim(); }
    extra(others) {
      const parts = [];
      const hist = this.readFile("HISTORY.md").replace(/^# HISTORY\.md[^\n]*\n+/, "").trim();
      if (hist) parts.push(`# EARLIER IN THIS CONVERSATION (compacted summary; the recent messages follow as chat)\n${hist.slice(0, 8000)}`);
      const list = others.filter((b) => b.id !== this.id);
      if (list.length) parts.push(`# OTHER BLINKS\nThis person also has these Blinks. You can message one with message_blink when it helps:\n${list.map((b) => `- ${b.name}: ${b.purpose || (b.id === "cloak" ? "their main Blink" : "no stated purpose")}`).join("\n")}`);
      return parts.join("\n\n");
    }
  }

  // ── Memory as Markdown (USER.md + MEMORY.md), tasks/inbox in SQLite ─────
  class BlinkMind extends MindCore {
    constructor(st, alarms) {
      super(openSql(st.file("mind.sqlite")), alarms, env, (p) => p?.catch?.(() => {}));
      this.st = st;
    }
    parse(name) {
      const out = [];
      for (const line of this.st.readFile(name).split("\n")) {
        const m = /^- (.+?)(?: <!-- (.*?) -->)?$/.exec(line.trim());
        if (!m) continue;
        const meta = Object.fromEntries((m[2] || "").split(" ").filter(Boolean).map((kv) => kv.split(":")));
        const fact = m[1].trim();
        const day = meta.day || today();
        out.push({ id: hashId(name + fact), fact, kind: meta.kind || (name === "USER.md" ? "profile" : "other"), by: meta.by || "cloak", day, created: Date.parse(day) || 0, updated: Date.parse(day) || 0, file: name, line });
      }
      return out;
    }
    memories() { return [...this.parse("USER.md"), ...this.parse("MEMORY.md")].sort((a, b) => b.updated - a.updated); }
    remember({ fact, kind = "other", by = "cloak" }) {
      const text = String(fact || "").replace(/\s+/g, " ").replace(/<!--|-->/g, "").trim().slice(0, 300);
      if (text.length < 4) return { ok: false, error: "nothing to save" };
      if (/\b(password|passcode|pin|cvv|ssn|social security|card number)\b/i.test(text) && /\d{3,}/.test(text)) return { ok: false, error: "secrets are never stored" };
      const k = ["profile", "preference", "project", "person", "other"].includes(kind) ? kind : "other";
      const file = k === "profile" || k === "preference" ? "USER.md" : "MEMORY.md";
      const line = `- ${text} <!-- kind:${k} day:${today()} by:${String(by).replace(/\s/g, "")} -->`;
      const w = words(text);
      for (const m of this.memories()) {
        if (overlap(w, words(m.fact)) >= 0.75) {
          this.rewrite(m.file, (l) => (l === m.line ? line : l));
          return { ok: true, updated: true, id: hashId(file + text) };
        }
      }
      fs.appendFileSync(this.st.file(file), line + "\n");
      return { ok: true, updated: false };
    }
    rewrite(name, fn) {
      const lines = this.st.readFile(name).split("\n").map(fn).filter((l) => l !== null);
      fs.writeFileSync(this.st.file(name), lines.join("\n"));
    }
    forget(query) {
      const q = words(query);
      if (!q.length) return 0;
      const hit = this.memories().filter((m) => overlap(q, words(m.fact)) >= 0.5);
      for (const m of hit) this.rewrite(m.file, (l) => (l === m.line ? null : l));
      return hit.length;
    }
    forgetId(id) {
      const m = this.memories().find((x) => x.id === Number(id));
      if (m) this.rewrite(m.file, (l) => (l === m.line ? null : l));
      return true;
    }
    forgetAll() {
      for (const f of ["USER.md", "MEMORY.md"]) this.rewrite(f, (l) => (/^- /.test(l.trim()) ? null : l));
      return true;
    }
    // Task results and late replies land in the Blink's chat, not a separate inbox.
    deliver({ kind = "task", title = "", body = "" }) {
      this.st.append({ role: "assistant", content: String(body || ""), ...(kind === "task" ? { task: String(title).slice(0, 120) } : {}) });
    }
    async erase() {
      this.forgetAll();
      return super.erase();
    }
  }
  function mind(key) {
    let m = minds.get(key);
    if (m) return m;
    const [user, blink] = String(key).split("#");
    const st = store(user, blink || "cloak");
    let timer = null;
    const alarms = {
      set(at) { clearTimeout(timer); timer = setTimeout(() => m.alarm().catch((e) => log("error", `task run failed: ${e.message}`)), Math.min(2 ** 31 - 1, Math.max(0, at - Date.now()))); },
      clear() { clearTimeout(timer); timer = null; },
    };
    m = new BlinkMind(st, alarms);
    m.hello(key);
    minds.set(key, m);
    return m;
  }
  function wakeAll() {
    for (const ud of safeList(root)) for (const id of safeList(path.join(root, ud))) {
      try {
        const db = openSql(path.join(root, ud, id, "mind.sqlite"));
        const key = db.exec("SELECT v FROM meta WHERE k = 'key'").toArray()[0]?.v;
        db.close();
        if (key) mind(key).arm();
      } catch {}
    }
  }

  // ── Blink to Blink ──────────────────────────────────────────────────────
  // One exchange = everything that follows from one turn. After every few
  // messages a model call checks for a wasteful loop.
  async function loopCheck(chain) {
    const verdict = await utility(
      `You watch AI companions that can message each other on behalf of one person. Decide if this exchange is still doing useful work for the person, or if they are stuck in a wasteful loop (repeating themselves, bouncing the same request back and forth, thanking each other, or making no new progress). Answer with exactly one word first, CONTINUE or STOP, then one short reason.`,
      chain.lines.slice(-24).join("\n"),
    );
    return /^\s*STOP/i.test(verdict || "") ? (verdict || "").replace(/^\s*STOP[:.\s-]*/i, "").slice(0, 200) || "they were going in circles" : null;
  }
  function talker(user, from, roster, chain, ctx, signal) {
    return async (toName, message) => {
      const want = String(toName).trim().toLowerCase();
      const target = roster.find((b) => b.id.toLowerCase() === want || b.name.toLowerCase() === want);
      if (!target) return { ok: false, error: `there is no Blink called "${toName}". The Blinks are: ${roster.map((b) => b.name).join(", ")}.` };
      if (target.id === from.id) return { ok: false, error: "that is you" };
      if (chain.stopped) return { ok: false, error: `this exchange was stopped (${chain.stopped}). Tell the person what you have so far.` };
      if (chain.n >= BACKSTOP) return { ok: false, error: "this exchange is already very long. Wrap up and tell the person what you have." };
      chain.n++;
      chain.lines.push(`${from.name} to ${target.name}: ${message.slice(0, 600)}`);
      if (chain.n % LOOP_CHECK_EVERY === 0) {
        const why = await loopCheck(chain).catch(() => null);
        if (why) {
          chain.stopped = why;
          log("info", `stopped a Blink loop: ${why}`);
          return { ok: false, error: `this exchange was stopped because ${why}. Tell the person what you have so far.` };
        }
      }
      const st = store(user, target.id, target.id === "cloak" ? null : target);
      st.append({ role: "user", from: from.name, content: message });
      const bot = target.id === "cloak" ? null : { id: target.id, name: target.name, purpose: target.purpose, persona: target.persona, lane: target.lane };
      const out = await collect(runAgent(env, ctx, {
        companion: target.id, bot, userKey: `${user}#${target.id}`, mode: "auto", peer: true,
        messages: st.recent(), extra: st.extra(roster), soul: st.soul(),
        talk: talker(user, { id: target.id, name: target.name }, roster, chain, ctx, signal),
      }, signal));
      const reply = stripTags(out.text || "") || "(no reply)";
      st.append({ role: "assistant", content: reply });
      chain.lines.push(`${target.name} to ${from.name}: ${reply.slice(0, 600)}`);
      return { ok: true, name: target.name, reply };
    };
  }

  // ── A turn ──────────────────────────────────────────────────────────────
  // Prepares body for runAgent and returns { body, finish(text) }.
  async function prepare(body, emit) {
    const user = body.userKey;
    const id = safeId(body.companion || "cloak");
    const spec = id === "cloak" ? null : body.bot;
    const roster = [{ id: "cloak", name: "Cloak", purpose: "their main Blink" }, ...(Array.isArray(body.blinks) ? body.blinks.filter((b) => /^u_/.test(b.id)) : [])];
    for (const b of roster) if (b.id !== "cloak") store(user, b.id, b);
    const st = store(user, id, spec);
    // Memories from before Blinks had their own files move into Cloak's, once.
    if (id === "cloak" && !st.state.imported) {
      const m = mind(`${user}#cloak`);
      for (const f of legacy(user)) m.remember({ fact: f.fact, kind: f.kind, by: f.by });
      st.state.imported = true;
      st.saveState();
    }
    st.takeIncoming(body.messages || []);
    if (st.needsCompact()) {
      emit({ step: { id: "compact", tool: "compact", label: "Tidying up older messages", state: "run" } });
      const n = await st.compact().catch((e) => { log("error", `compaction failed: ${e.message}`); return 0; });
      emit({ step: { id: "compact", state: "done", summary: n ? `${n} summarized` : "skipped" } });
    }
    const chain = { n: 0, lines: [], stopped: null };
    const next = {
      ...body,
      companion: id,
      userKey: `${user}#${id}`,
      messages: st.recent(),
      extra: [st.extra(roster), body.extra || ""].filter(Boolean).join("\n\n"),
      soul: st.soul(),
    };
    return {
      body: next,
      bindTalk(ctx, signal) { next.talk = talker(user, { id, name: st.name }, roster, chain, ctx, signal); },
      note(text) { st.append({ role: "user", content: text }); },
      finish(text) { return text != null ? st.append({ role: "assistant", content: text }).at : null; },
    };
  }

  // Everything new since a moment, for every Blink: how the app catches up
  // after being closed.
  function since(user, t, only) {
    const out = {};
    for (const id of safeList(path.join(root, userDir(user)))) {
      if (only && id !== only) continue;
      const st = store(user, id);
      const fresh = st.log().filter((e) => e.at > t);
      if (fresh.length) out[id] = fresh;
    }
    return out;
  }
  function files(user, id) {
    const st = store(user, safeId(id));
    return { soul: st.readFile("SOUL.md"), user: st.readFile("USER.md"), memory: st.readFile("MEMORY.md"), history: st.readFile("HISTORY.md"), messages: st.log().length, compacted: st.state.cut };
  }
  function setSoul(user, id, text) {
    const st = store(user, safeId(id));
    const t = String(text || "").slice(0, 20_000).trim();
    if (t.length < 20) return false;
    fs.writeFileSync(st.file("SOUL.md"), t + "\n");
    return true;
  }

  // Everything this person has on the brain, gone: every Blink's folder,
  // memories, chat log, tasks.
  function wipe(user) {
    for (const k of [...minds.keys()]) if (k.startsWith(user + "#")) { try { minds.get(k).alarms.clear(); } catch {} minds.delete(k); }
    for (const k of [...stores.keys()]) if (k.startsWith(user + "#")) stores.delete(k);
    fs.rmSync(path.join(root, userDir(user)), { recursive: true, force: true });
  }

  return { store, mind, wakeAll, prepare, since, files, setSoul, wipe, root };
}

function read(file, d) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return d; } }
function safeList(dir) { try { return fs.readdirSync(dir).filter((n) => !n.startsWith(".")); } catch { return []; } }
