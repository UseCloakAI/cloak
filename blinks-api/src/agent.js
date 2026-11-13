// The agent runtime. One companion working a task: think, call tools, read
// the results, repeat, answer. Also team runs (several companions in
// parallel, one writes the final answer) and the memory pass after a turn.
//
// runAgent() is an async generator of events:
//   {meta}                  who is answering, which lane, which tools
//   {care}                  helplines, when someone may be in danger
//   {step}                  a tool call starting or finishing (also sub-agents)
//   {sources}               numbered sources gathered so far
//   {delta} / {reset}       answer text / "that text was a working note, clear it"
//   {done} | {error}
//
// It is used three ways: streamed straight to the browser (index.js), inside
// a cloud run that survives a closed tab (run.js), and headless for scheduled
// tasks (mind.js).

import { LANES, routeLane } from "./models.js";
import { buildSystem, COMPANIONS, BRANDS, resolveCompanion, stripTags, codeGuide, COMPUTER_GUIDE } from "./prompts.js";
import { detect, resources, careProtocol } from "./safety.js";
import { estimate } from "./carbon.js";
import { streamLane } from "./engine.js";
import { toolbox, specs, runTool, toolLabel } from "./tools.js";

const STEPS = { auto: 6, research: 10, sub: 4, background: 6 };
const MAX_CALLS_PER_STEP = 4;
// Outbound requests one reply may spend, counting each model call and each
// tool call as one (Exec makes that true). Cloudflare's free plan allows 50
// per invocation; the rest is headroom for memory, the ledger and learning.
const REQUEST_BUDGET = 40;
const RESERVE = 6; // kept back so the final answer can always be written
const SMALLTALK = /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|lol|good (morning|night|evening)|bye|goodnight)\b[\s!.?]*$/i;

export const mindFor = (env, key) => (key && env.MIND ? env.MIND.get(env.MIND.idFromName(key)) : null);
const ledger = (env) => env.LEDGER.get(env.LEDGER.idFromName("global"));

// Lets tools and sub-agents push events while the loop is awaiting them.
function channel() {
  const q = [];
  let wake = null, open = 0;
  return {
    emit(e) { q.push(e); wake?.(); },
    track(p) { open++; return p.finally(() => { open--; wake?.(); }); },
    async *drain() {
      for (;;) {
        while (q.length) yield q.shift();
        if (!open) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

const textOf = (m) => (typeof m?.content === "string" ? m.content : "");

// How the agent reaches models and the web. The host sets this once:
// the Worker routes both through Exec (one outbound request each), the
// home-PC brain routes them through the Worker. Default: in-process.
let IO = { lane: null, net: null };
export function setIO(io) { IO = { ...IO, ...io }; }
const callLane = (env, ctx, lane, opts) => (IO.lane ? IO.lane(env, lane, opts, ctx) : streamLane(env, ctx, lane, opts));

// Low Light: the brain (memory, tools, the computer, Blinks talking to each
// other) is away for now. Say so honestly; never claim it can never be done.
const LOWLIGHT_NOTE = `# LOW LIGHT RIGHT NOW
Your brain is resting for the moment, so this reply is plain chat: you cannot use your tools, memory, files or this person's computer right now. If they ask for something that needs those (using their computer or browser, remembering, files, scheduled tasks, other Blinks), say plainly that you can't do it this minute because your brain is away, and that it will work again when it is back, usually within a few minutes. Never say you are an AI without that ability in general.`;

export async function* runAgent(env, ctx, req, signal) {
  const depth = req.depth || 0;
  // One of the five, or a Blink the person built (req.bot carries its spec).
  const companion = resolveCompanion(req.companion, req.bot);
  const companionId = companion.id;
  const bot = companion.custom ? req.bot : null;
  const brand = BRANDS.includes(req.brand) ? req.brand : env.BRAND || "Cloak Blinks";
  const messages = req.messages.slice();
  const last = messages[messages.length - 1];
  const shared = req.shared || { sources: [], wh: 0, g: 0, tokensIn: 0, tokensOut: 0, steps: 0, spent: 0 };
  shared.spent = shared.spent || 0;
  const by = depth ? companionId : undefined;

  // Safety before anything else.
  const danger = depth ? null : detect(messages);
  const crisis = danger?.level === "crisis";
  const help = danger ? resources(req.country) : null;

  // Team runs are orchestrated one level up.
  if (!depth && req.mode === "team" && !crisis && !req.lowlight) {
    yield* runTeam(env, ctx, { ...req, companion: companionId, bot, lead: companion, brand, shared }, signal);
    return;
  }

  // Images: a vision model looks first, then the agent works from its notes.
  const images = Array.isArray(req.images) ? req.images : [];
  if (images.length && !depth) {
    yield { step: { id: "look", tool: "look", label: images.length > 1 ? `Looking at ${images.length} images` : "Looking at the image", state: "run" } };
    let seen = "";
    try {
      const sys = buildSystem({ brand, companion, lane: "vision", convictions: env.CONVICTIONS !== "off" });
      const ask = [{ role: "user", content: [{ type: "text", text: `Describe what is in ${images.length > 1 ? "these images" : "this image"} in the detail needed to answer this, including any text exactly as written:\n\n${textOf(last)}` }, ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))] }];
      shared.spent++;
      for await (const ev of callLane(env, ctx, "vision", { system: sys, messages: ask, signal })) {
        if (ev.done) { seen = ev.text; tally(shared, ev); }
      }
    } catch {}
    yield { step: { id: "look", state: "done", summary: seen ? "seen" : "could not see it" } };
    messages[messages.length - 1] = { role: "user", content: `${textOf(last)}\n\n[${images.length > 1 ? "Images" : "An image"} attached. What the vision model saw: ${seen || "it could not be read. Say so."}]` };
  }

  // Low Light: the home-PC brain is away. Plain chat only: no memory, no
  // tools, no team or research, never the heaviest models.
  const lowlight = !!req.lowlight;
  const research = req.mode === "research" && !crisis && !lowlight;
  const routed = research ? { lane: "deep", why: "research" } : routeLane({ text: textOf(last), mode: req.mode, home: companion.home, turns: messages.length, crisis });
  let lane = routed.lane;
  if (lowlight && !["swift", "smart", "vision"].includes(lane)) lane = "smart";
  const mind = lowlight ? null : mindFor(env, req.userKey);
  if (mind && !depth) await mind.hello(req.userKey).catch(() => {});
  const memories = mind && !depth ? await mind.context(textOf(last)).catch(() => []) : [];

  // No tools for a life at risk (the reply is the person, not a search) or for hellos.
  let tools = crisis || lowlight || SMALLTALK.test(textOf(last).trim()) || req.tools === false ? [] : toolbox({ depth, hasMind: !!mind, hasTalk: typeof req.talk === "function" && !depth, hasFiles: !depth && Array.isArray(req.files) && req.files.length > 0, hasComputer: !depth && !!req.computer && typeof req.computer.run === "function" });
  // The smallest models get a short toolbelt: they plan poorly with a long one.
  if (lane === "swift") tools = tools.filter((t) => ["web_search", "calculate", "remember", "schedule_task", "create_blink"].includes(t));
  // A scheduled task must not schedule more work or rewrite the task list.
  if (req.background) tools = tools.filter((t) => !["schedule_task", "cancel_task", "list_tasks"].includes(t));
  const computing = tools.includes("server_run");
  const budget = depth ? STEPS.sub : computing ? 24 : research ? STEPS.research : req.background ? STEPS.background : STEPS.auto;
  // On the brain each model call is its own Worker request, so the per-reply
  // request cap (a Cloudflare limit) does not apply there.
  const CAP = IO.lane ? 160 : REQUEST_BUDGET;

  const system = buildSystem({
    brand, companion, lane, depth, tools, memories, research,
    texting: !depth && !req.background,
    care: danger ? careProtocol(danger, help) : "",
    user: req.user && typeof req.user === "object" ? req.user : {},
    convictions: env.CONVICTIONS !== "off",
    extra: [req.extra || "", depth ? "" : codeGuide(req.files), tools.includes("server_run") ? COMPUTER_GUIDE : "", lowlight ? LOWLIGHT_NOTE : ""].filter(Boolean).join("\n\n"),
    soul: req.soul || "",
  });

  if (!depth) {
    yield { meta: { companion: companionId, lane, lane_label: LANES[lane].label, why: routed.why, mode: req.mode || "auto", tools: tools.length > 0, memory: memories.length, power: lowlight ? "lowlight" : "full" } };
    if (crisis) yield { care: help };
  }

  const cite = (list) => {
    const base = shared.sources.length + 1;
    list.forEach((s, i) => shared.sources.push({ n: base + i, title: String(s.title || s.url).slice(0, 140), url: s.url }));
    return base;
  };

  const msgs = messages.slice();
  let answer = "";
  let partial = false;
  let remembered = false;

  const heardDuringTools = [];
  for (let step = 0; step < budget; step++) {
    if (signal?.aborted) return;
    // Messages they sent while this was running join the conversation now.
    if (!depth && typeof req.pending === "function") {
      const more = (await req.pending()) || [];
      if (more.length) {
        msgs.push({ role: "user", content: `[They sent more while you were working. Take it into account from here:]\n${more.join("\n")}` });
        yield { absorbed: more };
      }
    }
    // Out of steps, or out of outbound requests: this call writes the answer.
    const broke = shared.spent >= CAP - RESERVE;
    const final = step === budget - 1 || broke;
    const offer = tools.length && !final ? specs(tools) : undefined;
    if (final && tools.length && step > 0) msgs.push({ role: "user", content: "[Platform note: you have used all your tool calls for this turn. Answer now with what you have, and say what you could not check.]" });

    let text = "", calls = [], got = false;
    shared.spent++;
    const attempt = async function* (withTools) {
      for await (const ev of callLane(env, ctx, lane, { system, messages: msgs, maxTokens: req.max_tokens, signal, tools: withTools })) {
        if (ev.delta) { text += ev.delta; if (!depth) yield { delta: ev.delta }; }
        else if (ev.done) { got = true; calls = ev.toolCalls || []; partial = !!ev.partial; tally(shared, ev); }
      }
    };
    try {
      yield* attempt(offer);
    } catch (e) {
      // Every model refused the tool schema or was busy: one plain attempt.
      if (!offer || text) throw e;
      yield* attempt(undefined);
    }
    if (!got) return; // aborted

    if (!calls.length || partial) { answer = text; break; }

    // The model spoke before reaching for tools: that was a working note.
    if (text.trim() && !depth) yield { reset: true, note: text.trim().slice(0, 300) };
    calls = calls.slice(0, Math.max(1, Math.min(MAX_CALLS_PER_STEP, CAP - RESERVE - shared.spent)));
    msgs.push({ role: "assistant", content: text || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });

    const ch = channel();
    const before = shared.sources.length;
    const results = new Array(calls.length);
    calls.forEach((c, i) => {
      shared.steps++;
      const id = `${by || "me"}-${step}-${i}`;
      ch.emit({ step: { id, by, tool: c.name, label: toolLabel(c.name, c.arguments), state: "run" } });
      if (c.name === "remember") remembered = true;
      shared.spent++;
      const cx = {
        env, ctx, mind, userKey: req.userKey, companion: companionId, bot, brand, depth, signal, cite, talk: req.talk, computer: req.computer, files: Array.isArray(req.files) ? req.files : [],
        net: IO.net ? IO.net(env) : null,
        // A long tool can update its own status line while it works.
        progress: (label) => ch.emit({ step: { id, by, tool: c.name, label, state: "run" } }),
        // What the person themselves wrote this turn (for checks that need their own words).
        said: msgs.filter((x) => x.role === "user").slice(-6).map((x) => textOf(x)).join("\n"),
        // Messages they sent while a long tool runs: taken in now, and the app told.
        absorb: async () => {
          if (depth || typeof req.pending !== "function") return [];
          const more = (await req.pending()) || [];
          if (more.length) { ch.emit({ absorbed: more }); heardDuringTools.push(...more); }
          return more;
        },
        delegate: async (who, task) => {
          const sub = runAgent(env, ctx, { brand, companion: who, userKey: req.userKey, user: req.user, country: req.country, depth: depth + 1, shared, messages: [{ role: "user", content: task }] }, signal);
          let out = "";
          for await (const ev of sub) {
            if (ev.step) ch.emit(ev);
            else if (ev.done) out = ev.text || "";
          }
          return out;
        },
      };
      // Only tools that were actually offered on this call may run.
      const go = tools.includes(c.name) ? runTool(c.name, c.arguments, cx) : Promise.resolve({ text: `The tool ${c.name} is not available here. Carry on without it.`, summary: "not available" });
      ch.track(go.then((r) => {
        results[i] = r;
        ch.emit({ step: { id, by, state: r.blocked ? "blocked" : "done", summary: r.summary || "" } });
        if (r.event && !depth) ch.emit(r.event); // e.g. a new Blink for the app to add
      }));
    });
    for await (const ev of ch.drain()) yield ev;
    if (shared.sources.length > before && !depth) yield { sources: shared.sources };
    calls.forEach((c, i) => msgs.push({ role: "tool", tool_call_id: c.id, content: results[i]?.text || "No result." }));
    if (heardDuringTools.length) msgs.push({ role: "user", content: `[They sent this while that was running:]\n${heardDuringTools.splice(0).join("\n")}` });
  }

  if (!depth) {
    const impact = { wh: round(shared.wh), g: round(shared.g) };
    ctx.waitUntil?.(ledger(env).recordReply({ lane, tokensIn: shared.tokensIn, tokensOut: shared.tokensOut, wh: impact.wh, g: impact.g }).catch(() => {}));
    // Quietly keep anything lasting the person said, if the companion did not.
    if (mind && !remembered && !crisis && !req.background && !req.peer && textOf(last).length >= 25 && answer) {
      ctx.waitUntil?.(learn(env, ctx, mind, companionId, textOf(last), stripTags(answer), memories).catch(() => {}));
    }
    yield { done: true, partial, lane, text: answer, steps: shared.steps, sources: shared.sources, usage: { tokens_in: shared.tokensIn, tokens_out: shared.tokensOut }, impact };
  } else {
    yield { done: true, text: answer };
  }
}

// ── Team: several companions work in parallel, the lead writes the answer ────
const STRENGTH = {
  moss: "Reason it through carefully. Check the facts with searches. Name the assumptions and the strongest objection.",
  pip: "Get the current, concrete facts fast: numbers, dates, names, links. Keep it tight.",
  ember: "Look at it as an engineer: what would actually work, the practical steps, the failure modes.",
  juno: "Find the angle nobody else will: the unexpected option, the better framing, the human side.",
  sol: "Consider how this lands for the person: what they might be feeling, what they need, the kind way through.",
};
function pickTeam(lead, text) {
  const code = /```|\b(code|bug|function|api|database|script|deploy|app|website)\b/i.test(text);
  const creative = /\b(story|poem|name|slogan|speech|write|idea|brainstorm|design)\b/i.test(text);
  const personal = /\b(feel|relationship|friend|family|partner|anxious|stress|decide|should i)\b/i.test(text);
  const order = code ? ["ember", "moss", "pip", "juno", "sol"] : creative ? ["juno", "moss", "pip", "ember", "sol"] : personal ? ["sol", "moss", "juno", "pip", "ember"] : ["moss", "pip", "ember", "juno", "sol"];
  return order.filter((c) => c !== lead).slice(0, 3);
}

async function* runTeam(env, ctx, req, signal) {
  const { companion: lead, brand, shared } = req;
  const leadName = req.lead?.name || COMPANIONS[lead]?.name || "Cloak";
  const question = textOf(req.messages[req.messages.length - 1]);
  const team = pickTeam(lead, question);
  yield { meta: { companion: lead, lane: "deep", lane_label: "Team", why: "team", mode: "team", tools: true, team } };

  // Recent conversation, so teammates are not answering in a vacuum.
  const recent = req.messages.slice(-7, -1).map((m) => `${m.role === "user" ? "Person" : "Companion"}: ${textOf(m).slice(0, 700)}`).join("\n");
  const ch = channel();
  const drafts = {};
  team.forEach((who) => {
    ch.emit({ step: { id: `team-${who}`, by: who, tool: "team", label: `${COMPANIONS[who].name} is working on it`, state: "run" } });
    const task = `You are one of several companions working on the same request in parallel. Another companion will combine the answers, so give your own best independent take and do not hedge toward the middle.\nYour angle: ${STRENGTH[who]}\n${recent ? `\nThe conversation so far:\n${recent}\n` : ""}\nThe request:\n${question}`;
    ch.track((async () => {
      try {
        for await (const ev of runAgent(env, ctx, { brand, companion: who, userKey: req.userKey, user: req.user, country: req.country, depth: 1, shared, messages: [{ role: "user", content: task }] }, signal)) {
          if (ev.step) ch.emit(ev);
          else if (ev.done) drafts[who] = ev.text || "";
        }
      } catch {
        drafts[who] = "";
      }
      ch.emit({ step: { id: `team-${who}`, by: who, state: "done", summary: drafts[who] ? "done" : "no answer" } });
    })());
  });
  for await (const ev of ch.drain()) yield ev;
  if (shared.sources.length) yield { sources: shared.sources };
  if (signal?.aborted) return;

  const got = team.filter((w) => drafts[w]);
  const extra = `# TEAM ANSWER
${got.length} other companions worked on the person's latest request in parallel. Their drafts are below. Write the single best answer, in your own voice:
- Take what is right from each, and drop what is weak. Where they disagree, decide which is right and say why in a sentence. Do not average them.
- Verify anything that matters and that only one of them claims.
- Do not narrate the process or list who said what, unless a disagreement is itself useful to the person.
- Keep their citations: reuse the same [n](url) links for the facts you keep.

${got.map((w) => `## ${COMPANIONS[w].name}'s draft\n${drafts[w].slice(0, 7000)}`).join("\n\n") || "No drafts came back. Answer on your own."}`;

  yield { step: { id: "team-lead", tool: "team", label: `${leadName} is writing the answer`, state: "run" } };
  let first = true;
  for await (const ev of runAgent(env, ctx, { ...req, mode: "deep", tools: false, extra, shared, _lead: true }, signal)) {
    if (ev.meta || ev.care) continue;
    if (ev.delta && first) { first = false; yield { step: { id: "team-lead", state: "done", summary: "" } }; }
    if (ev.done) ev.lane_label = "Team";
    yield ev;
  }
}

// ── Memory pass: one cheap call that pulls lasting facts out of the turn ─────
async function learn(env, ctx, mind, companion, said, replied, known) {
  const system = `You maintain an assistant's long-term memory about one person. From the exchange below, extract facts about the PERSON that will still be true and useful in future conversations: identity, work, people in their life, goals, ongoing projects, constraints, stated preferences for how they want help.
Do NOT extract: anything about the assistant, one-off requests, passing moods, guesses, facts already known, or sensitive details (health, finances, sexuality, beliefs, exact address) unless the person explicitly asked for it to be remembered.
Reply with ONLY a JSON array of at most 3 objects: [{"fact": "full sentence about the person", "kind": "profile|preference|project|person|other"}]. If nothing qualifies, reply [].`;
  const user = `Already known:\n${known.map((m) => `- ${m.fact}`).join("\n") || "(nothing)"}\n\nPerson said:\n${said.slice(0, 2500)}\n\nAssistant replied:\n${replied.slice(0, 1200)}`;
  let out = "";
  for await (const ev of callLane(env, ctx, "utility", { system, messages: [{ role: "user", content: user }], maxTokens: 300 })) if (ev.done) out = ev.text;
  const m = /\[[\s\S]*\]/.exec(out);
  if (!m) return;
  let facts;
  try { facts = JSON.parse(m[0]); } catch { return; }
  for (const f of Array.isArray(facts) ? facts.slice(0, 3) : []) {
    if (f && typeof f.fact === "string" && f.fact.length > 8) await mind.remember({ fact: f.fact, kind: f.kind, by: companion });
  }
}

function tally(shared, ev) {
  const e = estimate({ size: ev.size, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut });
  shared.wh += e.wh;
  shared.g += e.g;
  shared.tokensIn += ev.tokensIn || 0;
  shared.tokensOut += ev.tokensOut || 0;
}
const round = (n) => Math.round(n * 10000) / 10000;

// Runs an agent to the end and returns the result (scheduled tasks, tests).
export async function collect(gen) {
  const out = { text: "", sources: [], impact: null, steps: 0 };
  for await (const ev of gen) {
    if (ev.done) Object.assign(out, { text: ev.text || "", sources: ev.sources || [], impact: ev.impact || null, steps: ev.steps || 0 });
    if (ev.error) throw new Error(ev.error);
  }
  return out;
}
