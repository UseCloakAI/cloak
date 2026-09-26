// Memory + context utility endpoints. Both run on the "utility" tier — the
// cheapest, highest-quota models — so chat models keep their free quota for chat.
//
//   POST /v1/memory/extract  { turns:[{user, assistant}], existing:[{path,title,type,tags,body}], today? }
//                            → { ops:[{op, path, title, type, tags, importance, body}] }
//   POST /v1/context/compress { mode:"chunk"|"merge", messages?:[{role, content}], summaries?:[string], words? }
//                            → { summary }

const TYPES = ["profile", "preference", "project", "fact", "episode"];
const MAX_OPS = 5;
const MAX_TURNS = 8;
const MAX_INPUT_CHARS = 14_000;

const EXTRACT_PROMPT = `You maintain the long-term memory of Cloak, an AI assistant, for ONE user. Memory is a set of small markdown notes. Read the new conversation turns and decide what durable, useful information to save.

Note types:
- profile: stable facts about the user (name, role/job, school level, city or broader, languages, skills)
- preference: how they want answers (tone, length, format, tools, stack, units, what to avoid)
- project: ongoing work and goals (names of things they build, tech choices, deadlines, status)
- fact: durable specifics of their world (their setup, devices, services they use, recurring people by role)
- episode: a notable decision or event worth recalling later (one dated line)

Never save: passwords, API keys, tokens, card/bank/ID numbers, exact addresses, phone numbers, health or mental-health details, religion, politics, sexuality (unless the user explicitly says "remember" it), private details about other people, small talk, one-off questions, or anything the assistant said that the user didn't confirm.

Rules:
- Update an existing note (same path) instead of adding a near-duplicate. Merge new detail into its body.
- Delete a note only when the user contradicts or retracts it.
- body: 1-4 terse bullet lines starting with "- ", third person ("User ..."), max 400 characters.
- path: "<type>/<slug>.md", slug lowercase a-z 0-9 and hyphens, e.g. "project/cloak.md".
- title: max 60 characters. tags: 1-5 lowercase keywords. importance: 0.1-1 (1 = shapes almost every answer). The user's name and core identity are always 0.9+.
- At most ${MAX_OPS} ops. If nothing is worth saving, return {"ops":[]}.

Return ONLY JSON: {"ops":[{"op":"add"|"update"|"delete","path":"...","title":"...","type":"...","tags":["..."],"importance":0.5,"body":"- ..."}]}`;

const CHUNK_PROMPT = (words) => `Compress this conversation segment into dense notes that let an assistant continue the conversation without the original text.
Keep: the user's goals and questions, decisions, facts, names, numbers, dates, file names, code identifiers, commands, constraints and preferences they stated, what the assistant already answered or produced (briefly), and anything left open.
Drop: greetings, filler, repetition, verbatim code (describe it; keep only a snippet if essential).
Write terse bullet points starting with "- ", "User"/"Cloak" as subjects, past tense. At most ${words} words. Output only the bullets.`;

const MERGE_PROMPT = (words) => `Merge these rolling summaries of one conversation (oldest first) into a single digest.
Keep what still matters: goals, decisions, facts, names, numbers, identifiers, open questions. When later notes supersede earlier ones, keep only the latest. Drop anything resolved and no longer relevant.
Terse bullet points starting with "- ". At most ${words} words. Output only the bullets.`;

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// Pulls the first JSON object out of model text (tolerates fences / prose).
export function parseJsonLoose(text) {
  if (!text) return null;
  const clean = String(text).replace(/```(?:json)?/gi, "");
  const a = clean.indexOf("{");
  const b = clean.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(clean.slice(a, b + 1));
  } catch {
    return null;
  }
}

export function sanitizeOps(raw) {
  const ops = Array.isArray(raw?.ops) ? raw.ops : [];
  const out = [];
  for (const o of ops) {
    if (!o || typeof o !== "object") continue;
    const op = ["add", "update", "delete"].includes(o.op) ? o.op : null;
    if (!op) continue;
    const type = TYPES.includes(o.type) ? o.type : TYPES.includes(String(o.path || "").split("/")[0]) ? String(o.path).split("/")[0] : "fact";
    const pathSlug = slug(String(o.path || "").replace(/^[a-z]+\//, "").replace(/\.md$/, "")) || slug(o.title);
    if (!pathSlug) continue;
    const path = `${type}/${pathSlug}.md`;
    if (op === "delete") {
      out.push({ op, path });
      continue;
    }
    const body = str(o.body, 600).trim();
    if (!body) continue;
    const imp = Number(o.importance);
    out.push({
      op,
      path,
      type,
      title: str(o.title, 60).trim() || pathSlug.replace(/-/g, " "),
      tags: (Array.isArray(o.tags) ? o.tags : [])
        .map((t) => slug(t))
        .filter(Boolean)
        .slice(0, 5),
      importance: Number.isFinite(imp) ? Math.min(1, Math.max(0.1, imp)) : 0.5,
      body,
    });
    if (out.length >= MAX_OPS) break;
  }
  return out;
}

function clampTurns(turns) {
  let budget = MAX_INPUT_CHARS;
  const out = [];
  for (const t of (Array.isArray(turns) ? turns : []).slice(-MAX_TURNS)) {
    const user = str(t?.user, 1800);
    const assistant = str(t?.assistant, 500);
    if (!user) continue;
    budget -= user.length + assistant.length;
    if (budget < 0) break;
    out.push({ user, assistant });
  }
  return out;
}

export async function handleMemoryExtract(body, { complete }) {
  const turns = clampTurns(body?.turns);
  if (!turns.length) return { status: 400, data: { error: "turns required" } };
  const existing = (Array.isArray(body?.existing) ? body.existing : []).slice(0, 14).map((m) => ({
    path: str(m?.path, 80),
    title: str(m?.title, 60),
    body: str(m?.body, 300).replace(/\n+/g, " "),
  }));
  const today = str(body?.today, 10) || new Date().toISOString().slice(0, 10);

  const lines = [`Today: ${today}`, "", "EXISTING NOTES (may be updated):"];
  if (existing.length) for (const m of existing) lines.push(`- ${m.path} | ${m.title} | ${m.body}`);
  else lines.push("(none)");
  lines.push("", "NEW TURNS:");
  turns.forEach((t, i) => {
    lines.push(`[${i + 1}] USER: ${t.user}`);
    if (t.assistant) lines.push(`[${i + 1}] CLOAK: ${t.assistant}`);
  });

  const text = await complete({
    system: EXTRACT_PROMPT,
    messages: [{ role: "user", content: lines.join("\n") }],
    maxTokens: 700,
    json: true,
  });
  return { status: 200, data: { ops: sanitizeOps(parseJsonLoose(text)) } };
}

export async function handleContextCompress(body, { complete }) {
  const mode = body?.mode === "merge" ? "merge" : "chunk";
  const words = Math.max(40, Math.min(320, Number(body?.words) || 160));
  let input;
  if (mode === "merge") {
    const sums = (Array.isArray(body?.summaries) ? body.summaries : []).map((s) => str(s, 4000)).filter(Boolean);
    if (sums.length < 2) return { status: 400, data: { error: "summaries (2+) required" } };
    input = sums.map((s, i) => `SUMMARY ${i + 1}:\n${s}`).join("\n\n");
  } else {
    const msgs = (Array.isArray(body?.messages) ? body.messages : [])
      .map((m) => ({ role: m?.role === "assistant" ? "CLOAK" : "USER", content: str(m?.content, 6000) }))
      .filter((m) => m.content);
    if (!msgs.length) return { status: 400, data: { error: "messages required" } };
    input = msgs.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  }
  input = input.slice(0, MAX_INPUT_CHARS);

  const text = await complete({
    system: mode === "merge" ? MERGE_PROMPT(words) : CHUNK_PROMPT(words),
    messages: [{ role: "user", content: input }],
    maxTokens: Math.ceil(words * 2.2) + 60,
  });
  const summary = String(text || "")
    .replace(/```[a-z]*|```/gi, "")
    .trim()
    .slice(0, words * 9);
  if (!summary) return { status: 502, data: { error: "empty summary" } };
  return { status: 200, data: { summary } };
}
