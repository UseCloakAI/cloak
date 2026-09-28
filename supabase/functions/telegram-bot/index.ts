import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Telegram ⇄ Cloak.
//
//  Linked chats (Settings → Telegram on the web) continue the user's single
//  Cloak thread: messages land in `thread_messages`, replies use the same
//  compressed context + memories as the web, and long stretches get condensed
//  (with memory extraction) exactly like on the web.
//
//  Routes on this one function:
//    POST (Telegram webhook)       updates from Telegram
//    POST ?action=link             signed-in web user → deep link with a one-time code
//    POST ?relay=<message id>      DB trigger: mirror a non-Telegram message into the
//                                  linked chat ("Weston said: …" / Cloak's reply)
//
//  Unlinked chats keep a small standalone history in `messaging_sessions`.

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? ""; // optional but recommended
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CLOAK_API = Deno.env.get("CLOAK_API_URL") ?? "https://api.usecloak.org";

const MAX_HISTORY = 20; // unlinked chats only
const BUDGET = { total: 5200, memory: 420, summary: 900, keep: 4 };
const PAUSE_MS = 3 * 3600e3;
const CHUNK_TOKENS = 2400;
const CHUNK_MAX = 14;
const MERGE_AT = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const ok = () => new Response("ok", { status: 200 });
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const est = (s: string) => (s ? Math.ceil(s.length / 3.6) : 0);
const db = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const later = (p: Promise<unknown>) => {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p.catch((e) => console.error("background:", e?.message ?? e)));
  else return p.catch((e) => console.error("background:", e?.message ?? e));
};

type Msg = { id: number; role: "user" | "assistant"; content: string; created_at: string };
type Chunk = { s: number; e: number; sum: string; tok: number; n?: number; from?: number | null; to?: number | null };
type Ctx = { v: 2; chunks: Chunk[]; digest: { e: number; sum: string; tok: number; n?: number } | null };

/* ── Telegram helpers ─────────────────────────────────────────────────────── */

async function tg(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Reactions Telegram lets bots use (standard emoji set).
const REACTIONS = new Set([
  "👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱","🤬","😢","🎉","🤩","🤮","💩","🙏","👌","🕊","🤡",
  "🥱","🥴","😍","🐳","❤‍🔥","🌚","🌭","💯","🤣","⚡","🍌","🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈",
  "😴","😭","🤓","👻","👨‍💻","👀","🎃","🙈","😇","😨","🤝","✍","🤗","🫡","🎅","🎄","☃","💅","🤪","🗿",
  "🆒","💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷‍♂","🤷","🤷‍♀","😡",
]);
const normEmoji = (e: string) => e.replace(/\uFE0F/g, "");

const REACTION_GUIDE = `
TEXT LIKE A REAL PERSON — this is a Telegram chat, not an essay:
- Mirror the user: match their length, energy and formality. Short message in → short message back. Casual → casual.
- Plain conversational language, contractions, no headers, no bullet lists, no bold unless they asked for something structured (steps, code, a list).
- Don't open with "Great question" or restate what they said. Don't sign off every message with "Let me know if…". Don't end every message with a question.
- Emoji sparingly, only when they fit the vibe.
- Split naturally into a few bubbles when a person would (reaction/thought, then the point, then a follow-up) — see <break/> below.
- For real questions that need depth, still answer properly — just keep it readable on a phone.
TELEGRAM REACTIONS — you can react to the user's message like a person would:
- Put <react emoji="👍"/> anywhere in your reply to react to their latest message. Pick from: 👍 ❤ 🔥 😁 🤣 🤔 👀 🙏 👏 🎉 💯 😢 🤯 🫡 😎 🤝 🥰 😭 🗿 🆒.
- Put <silent/> to send NO text reply (they'll just see "delivered" or your reaction). Use it the way a person would: for "ok", "thanks", "lol", "👍", sign-offs, or anything that doesn't need an answer. Usually pair it with a reaction.
- Most messages that ask something still get a normal text reply. Don't react to everything — only when it feels natural.
- To text in a chain like a person (several short bubbles instead of one block), put <break/> between the messages, e.g. "Yeah that works.<break/>Want me to draft it?" Use it for casual back-and-forth, not for long structured answers. 2–4 bubbles max.
- If the user reacted to one of your messages, you'll see "[User reacted ❤ to your message]". Usually do nothing (<silent/>); only reply or react if it genuinely calls for it.`;

function parseDirectives(raw: string) {
  let react: string | null = null;
  const m = raw.match(/<react\s+emoji\s*=\s*["']([^"']+)["']\s*\/?>/i);
  if (m) {
    const e = normEmoji(m[1].trim());
    react = [...REACTIONS].find((r) => normEmoji(r) === e) ?? null;
  }
  const silent = /<silent\s*\/?>/i.test(raw);
  const text = raw.replace(/<react[^>]*\/?>|<silent\s*\/?>|<\/react>/gi, "").trim();
  const parts = text.split(/<break\s*\/?>/i).map((t) => t.trim()).filter(Boolean).slice(0, 6);
  return { react, silent: silent || !parts.length, text: parts.join("\n\n"), parts };
}

async function sendTelegram(chatId: number | string, text: string, plain = false) {
  for (let i = 0; i < text.length; i += 4000) {
    const chunk = text.slice(i, i + 4000);
    const send = (parseMode?: string) =>
      tg("sendMessage", { chat_id: chatId, text: chunk, ...(parseMode ? { parse_mode: parseMode } : {}) });
    // Model markdown doesn't always parse as Telegram Markdown — fall back to plain text.
    const res = plain ? await send() : await send("Markdown");
    if (!res.ok && !plain) await send();
  }
}

// No artificial "typing…" pauses — deliver every bubble as soon as it's ready.
// The typing indicator is fire-and-forget so it never adds latency either.
async function sendChain(chatId: number | string, parts: string[]) {
  tg("sendChatAction", { chat_id: chatId, action: "typing" });
  for (const part of parts) await sendTelegram(chatId, part);
}

async function reactTo(chatId: number | string, messageId: number, emoji: string) {
  await tg("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] });
}

async function registerCommands() {
  const info = await (await tg("getWebhookInfo", {})).json().catch(() => null);
  const url = info?.result?.url;
  if (url) {
    await tg("setWebhook", {
      url,
      ...(TELEGRAM_SECRET ? { secret_token: TELEGRAM_SECRET } : {}),
      allowed_updates: ["message", "callback_query", "message_reaction"],
    });
  }
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "About Cloak" },
      { command: "model", description: "Show or switch the AI model" },
      { command: "unlink", description: "Stop continuing your Cloak conversation here" },
      { command: "reset", description: "Clear this chat (unlinked chats only)" },
    ],
  });
}

let botUsername = "";
async function getBotUsername() {
  if (botUsername) return botUsername;
  const me = await (await tg("getMe", {})).json().catch(() => null);
  botUsername = me?.result?.username ?? "";
  return botUsername;
}

async function downloadPhotoAsBase64(fileId: string): Promise<{ base64: string; mimeType: string }> {
  const fileJson = await (await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`)).json();
  const filePath: string = fileJson.result?.file_path;
  if (!filePath) throw new Error("Could not get file path from Telegram.");
  const imgRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
  if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), mimeType: filePath.endsWith(".png") ? "image/png" : "image/jpeg" };
}

/* ── Cloak ────────────────────────────────────────────────────────────────── */

// Separate models, one Cloak: they differ in the underlying model, not persona.
const MODELS: Record<string, string> = {
  pneuma: "Pneuma — fast, everyday chat",
  logos: "Logos — precise reasoning",
  kairos: "Kairos — deep, thorough thinking",
};
const modelName = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);
const pickModel = (m?: string | null) => (m && MODELS[m] ? m : "pneuma");

function modelKeyboard(current: string) {
  return {
    inline_keyboard: Object.keys(MODELS).map((m) => [{ text: (m === current ? "● " : "") + modelName(m), callback_data: "model:" + m }]),
  };
}
function modelMenuText(current: string) {
  return `Current model: *${modelName(current)}*\n\n` + Object.values(MODELS).map((d) => "• " + d).join("\n") + "\n\nPick one below, or send /model <name>.";
}

async function callCloak(
  messages: { role: string; content: string }[],
  system: string,
  model: string,
  image?: { base64: string; mimeType: string },
): Promise<string> {
  const res = await fetch(`${CLOAK_API}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      system,
      ...(image ? { imageBase64: image.base64, mimeType: image.mimeType } : {}),
    }),
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok) throw new Error(`cloak-api ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return d.response ?? d.text ?? "Sorry, I couldn't generate a response.";
}

async function utility(path: string, body: unknown) {
  const res = await fetch(`${CLOAK_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}

function clock() {
  return `Current date and time (UTC): ${new Date().toISOString()}. You are replying in Telegram: keep formatting simple, and text like a person — short when short fits.\n${REACTION_GUIDE}`;
}

/* ── Accounts ─────────────────────────────────────────────────────────────── */

async function displayName(c: SupabaseClient, userId: string) {
  const { data: p } = await c.from("profiles").select("display_name").eq("id", userId).maybeSingle();
  if (p?.display_name) return String(p.display_name).trim().split(/\s+/)[0];
  const { data } = await c.auth.admin.getUserById(userId);
  const meta = data?.user?.user_metadata?.display_name;
  if (meta) return String(meta).trim().split(/\s+/)[0];
  const local = (data?.user?.email ?? "").split("@")[0].replace(/[^a-zA-Z]+/g, " ").trim().split(/\s+/)[0] ?? "";
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "You";
}

async function linkedUser(c: SupabaseClient, chatId: number | string): Promise<string | null> {
  const { data } = await c.from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
  return data?.user_id ?? null;
}

async function handleLinkRequest(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in first." }, 401);
  const c = db();
  const { data: auth, error } = await c.auth.getUser(jwt);
  if (error || !auth?.user) return json({ error: "Sign in first." }, 401);
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const code = Array.from(bytes, (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
  await c.from("telegram_link_codes").delete().eq("user_id", auth.user.id);
  const { error: insErr } = await c.from("telegram_link_codes").insert({ code, user_id: auth.user.id });
  if (insErr) return json({ error: "Could not create a link code." }, 500);
  const username = await getBotUsername();
  if (!username) return json({ error: "Telegram bot is not configured." }, 503);
  return json({ url: `https://t.me/${username}?start=link_${code}`, code });
}

async function redeemLink(c: SupabaseClient, chatId: number, code: string) {
  const { data } = await c.from("telegram_link_codes").select("user_id, expires_at").eq("code", code).maybeSingle();
  if (!data || new Date(data.expires_at).getTime() < Date.now()) {
    await sendTelegram(chatId, "That link has expired. Open Cloak → Settings → Telegram and tap *Link Telegram* again.");
    return;
  }
  await c.from("telegram_link_codes").delete().eq("code", code);
  await c.from("telegram_links").delete().eq("chat_id", chatId); // this chat was linked to someone else
  const { error } = await c.from("telegram_links").upsert({ user_id: data.user_id, chat_id: chatId, linked_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) {
    await sendTelegram(chatId, "Couldn't link this chat. Try again in a moment.");
    return;
  }
  const who = await displayName(c, data.user_id);
  await sendTelegram(chatId, `Linked, ${who}. This chat now continues your Cloak conversation. Anything you send on the web shows up here too, and this chat shows up on the web.`);
}

/* ── Relay: web (or any non-Telegram) message → linked chat ───────────────── */

async function handleRelay(id: number) {
  if (!Number.isFinite(id) || id <= 0) return ok();
  const c = db();
  // Claim the row first so a message is never delivered twice.
  const { data: row } = await c.from("thread_messages")
    .update({ relayed_at: new Date().toISOString() })
    .eq("id", id).is("relayed_at", null).neq("source", "telegram")
    .select("id, user_id, role, content").maybeSingle();
  if (!row) return ok();
  const { data: link } = await c.from("telegram_links").select("chat_id").eq("user_id", row.user_id).maybeSingle();
  if (!link) return ok();
  if (row.role === "user") {
    const who = await displayName(c, row.user_id);
    await sendTelegram(link.chat_id, `${who} said: "${row.content.slice(0, 3800)}"`, true);
  } else {
    await sendTelegram(link.chat_id, row.content);
  }
  return ok();
}

/* ── Thread context (mirrors context.js + memory.js recall) ───────────────── */

const STOP = new Set(("a an and are as at be but by for from has have i in is it its of on or that the this to was were will with you your me my we our they them he she his her not no do does did so if then than too very can just about into over also what which who how when where why all any some more most other such only own same few both each here there these those am been would should could may might must ok yes hey hi hello please thanks user").split(" "));
const toks = (s: string) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ""));

type MemFile = { path: string; title: string; type: string; tags: string[]; importance: number; body: string };
function parseMem(path: string, raw: string): MemFile {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(String(raw || "").replace(/\r\n/g, "\n"));
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  return {
    path,
    title: meta.title || path,
    type: meta.type || path.split("/")[0],
    tags: (meta.tags || "").replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean),
    importance: Math.min(1, Math.max(0.1, parseFloat(meta.importance) || 0.5)),
    body: (m ? m[2] : raw).trim(),
  };
}
function toMd(f: { title: string; type: string; tags: string[]; importance: number; body: string }) {
  const d = new Date().toISOString().slice(0, 10);
  return `---\ntitle: ${f.title}\ntype: ${f.type}\ntags: [${f.tags.join(", ")}]\nimportance: ${Math.round(f.importance * 100) / 100}\ncreated: ${d}\nupdated: ${d}\nsource: auto\n---\n${f.body.trim()}\n`;
}

async function loadMemories(c: SupabaseClient, userId: string): Promise<MemFile[]> {
  const { data } = await c.from("memory_files").select("path, content").eq("user_id", userId).limit(400);
  return (data ?? []).map((r) => parseMem(r.path, r.content));
}

const MEMORY_HEAD = "## USER MEMORY\nYou DO remember this user. These notes are what you know about them from past chats; the user saved them and can see and edit them in Cloak's Brain panel, so using them is expected and is not a privacy problem. This overrides any default of saying you don't know who the user is. Use them silently to tailor answers; don't recite them unprompted. When the user asks who they are, their name, or what you know or remember about them, answer directly from these notes. If a note conflicts with what the user says now, trust the user.\n";

function relatedMemories(files: MemFile[], text: string, k: number) {
  const q = new Set(toks(text));
  const scored = files.map((f) => {
    const words = toks(`${f.title} ${f.tags.join(" ")} ${f.body}`);
    let hit = 0;
    for (const w of new Set(words)) if (q.has(w)) hit++;
    return { f, s: hit ? hit / Math.sqrt(words.length + 4) + f.importance * 0.2 : 0 };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.f);
}

function memoryBlock(files: MemFile[], text: string) {
  const self = /\b(who am i|my name|about me|remember (about )?me|what do you (know|remember))/i.test(text);
  const core = files.filter((f) => f.type === "profile" || (f.type === "preference" && f.importance >= 0.6))
    .sort((a, b) => b.importance - a.importance);
  const rel = self ? [...files].sort((a, b) => b.importance - a.importance) : relatedMemories(files, text, 6);
  const picked: MemFile[] = [];
  let used = est(MEMORY_HEAD);
  for (const f of [...core, ...rel]) {
    if (picked.includes(f)) continue;
    const line = `- [${f.type}] ${f.title}: ${f.body.replace(/^\s*[-*]\s*/gm, "").split("\n").filter(Boolean).join("; ").slice(0, 240)}`;
    if (used + est(line) > (self ? BUDGET.memory * 1.6 : BUDGET.memory)) break;
    picked.push(f);
    used += est(line);
  }
  if (!picked.length) return "";
  return MEMORY_HEAD + picked.map((f) => `- [${f.type}] ${f.title}: ${f.body.replace(/^\s*[-*]\s*/gm, "").split("\n").filter(Boolean).join("; ").slice(0, 240)}`).join("\n");
}

const validCtx = (o: unknown): o is Ctx => !!o && (o as Ctx).v === 2 && Array.isArray((o as Ctx).chunks);
const coveredId = (x: Ctx) => (x.chunks.length ? x.chunks[x.chunks.length - 1].e : x.digest ? x.digest.e : 0);

async function loadCtx(c: SupabaseClient, userId: string): Promise<Ctx> {
  const { data } = await c.from("threads").select("context").eq("user_id", userId).maybeSingle();
  return validCtx(data?.context) ? data!.context as Ctx : { v: 2, chunks: [], digest: null };
}

function summaryText(x: Ctx) {
  const parts: string[] = [];
  if (x.digest) parts.push("Earlier conversations (digest):\n" + x.digest.sum);
  for (const ch of x.chunks) parts.push("Conversation" + (ch.from ? " from " + new Date(ch.from).toUTCString().slice(0, 22) : "") + ":\n" + ch.sum);
  return parts.join("\n\n");
}

async function buildThreadContext(c: SupabaseClient, userId: string, text: string) {
  const [x, files, who] = await Promise.all([loadCtx(c, userId), loadMemories(c, userId), displayName(c, userId)]);
  const { data } = await c.from("thread_messages").select("id, role, content, created_at")
    .eq("user_id", userId).gt("id", coveredId(x)).order("id", { ascending: false }).limit(60);
  const rows = ((data ?? []) as Msg[]).reverse();
  const sums = summaryText(x);
  const mem = memoryBlock(files, text);
  const avail = Math.max(800, BUDGET.total - est(mem) - est(sums));
  const live: { role: string; content: string }[] = [];
  let used = 0;
  let start = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const must = rows.length - 1 - i < 2;
    let content = rows[i].content;
    if (!must && est(content) > 1400) content = content.slice(0, 3200) + "\n…[trimmed]…\n" + content.slice(-1800);
    const t = est(content) + 4;
    if (!must && used + t > avail) break;
    live.unshift({ role: rows[i].role, content });
    used += t;
    start = i;
  }
  while (live.length > 1 && live[0].role === "assistant") { live.shift(); start++; }
  const gap = rows.slice(0, start).slice(-12)
    .map((m) => `- ${m.role === "assistant" ? "Cloak" : "User"}: ${m.content.replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
  let system = "";
  if (mem) system += "\n\n" + mem;
  system += `\n\n## ACCOUNT\nThe user's name is ${who}. You and ${who} share one continuous conversation across the Cloak web app and Telegram.`;
  if (sums || gap) {
    system += "\n\n## CONVERSATION SO FAR (compressed)\nThe messages shown are the most recent; these are compressed notes of what came before — treat them as things that were actually said.\n" +
      (sums ? "\n" + sums + "\n" : "") + (gap ? "\nMore recent earlier turns (abbreviated):\n" + gap + "\n" : "");
  }
  return { messages: live, system };
}

/* ── Compression (mirrors context.js maybeCompress, one chunk per turn) ───── */

async function applyMemoryOps(c: SupabaseClient, userId: string, ops: Record<string, unknown>[]) {
  for (const o of ops ?? []) {
    const path = String(o.path ?? "");
    if (!/^(profile|preference|project|fact|episode)\/[a-z0-9][a-z0-9-]{0,47}\.md$/.test(path)) continue;
    if (o.op === "delete") { await c.from("memory_files").delete().eq("user_id", userId).eq("path", path); continue; }
    const body = String(o.body ?? "").slice(0, 1200);
    if (!body) continue;
    await c.from("memory_files").upsert({
      user_id: userId,
      path,
      content: toMd({ title: String(o.title ?? path).slice(0, 60), type: String(o.type ?? path.split("/")[0]), tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 8) : [], importance: Number(o.importance) || 0.5, body }),
    }, { onConflict: "user_id,path" });
  }
}

async function maybeCompressThread(c: SupabaseClient, userId: string) {
  const x = await loadCtx(c, userId);
  const cov = coveredId(x);
  const { data } = await c.from("thread_messages").select("id, role, content, created_at")
    .eq("user_id", userId).gt("id", cov).order("id", { ascending: true }).limit(120);
  const rows = (data ?? []) as Msg[];
  if (rows.length < 4) return;
  const at = (m: Msg) => Date.parse(m.created_at) || 0;
  const n = rows.length;
  let keepFrom = n, keepTok = 0;
  for (let i = n - 1; i >= 0; i--) {
    const t = est(rows[i].content) + 4;
    if (n - i > BUDGET.keep && keepTok + t > BUDGET.total * 0.55) break;
    keepTok += t; keepFrom = i;
  }
  let pauseAt = -1;
  for (let i = n - 1; i > 0; i--) if (at(rows[i]) - at(rows[i - 1]) >= PAUSE_MS) { pauseAt = i; break; }
  const pendTok = rows.reduce((a, m) => a + est(m.content) + 4, 0);
  const over = pendTok + est(summaryText(x)) > BUDGET.total * 0.8;
  const limit = over ? keepFrom : pauseAt; // a finished earlier conversation, or the overflow
  if (limit < (over ? 2 : 4)) return;
  let e = 0, tok = 0;
  while (e < limit && e < CHUNK_MAX && tok < CHUNK_TOKENS) {
    if (e > 1 && at(rows[e]) - at(rows[e - 1]) >= PAUSE_MS) break;
    tok += est(rows[e].content) + 4; e++;
  }
  if (e >= 3 && rows[e - 1].role === "user") e--;
  if (e < 2) return;
  const slice = rows.slice(0, e);
  const files = await loadMemories(c, userId);
  const existing = [...new Set([...relatedMemories(files, slice.map((m) => m.content).join("\n"), 10),
    ...files.filter((f) => f.type === "profile").slice(0, 4)])].slice(0, 14)
    .map((f) => ({ path: f.path, title: f.title, type: f.type, tags: f.tags, body: f.body }));
  const d = await utility("/v1/context/compress", {
    mode: "chunk",
    words: Math.max(60, Math.min(200, Math.round(tok / 10))),
    messages: slice.map((m) => ({ role: m.role, content: m.content.slice(0, 6000) })),
    memory: { existing, today: new Date().toISOString().slice(0, 10) },
  });
  const fresh = await loadCtx(c, userId);
  if (coveredId(fresh) !== cov) return; // someone else compressed meanwhile
  fresh.chunks.push({ s: slice[0].id, e: slice[slice.length - 1].id, sum: d.summary, tok: est(d.summary), n: slice.length, from: at(slice[0]), to: at(slice[slice.length - 1]) });
  if (Array.isArray(d.ops)) await applyMemoryOps(c, userId, d.ops);
  const chunkTok = fresh.chunks.reduce((a, ch) => a + ch.tok, 0);
  if ((fresh.chunks.length >= MERGE_AT || chunkTok > BUDGET.summary) && (fresh.chunks.length >= 2 || fresh.digest)) {
    const take = fresh.chunks.slice(0, Math.max(1, fresh.chunks.length - 2));
    const sources = (fresh.digest ? [fresh.digest.sum] : []).concat(take.map((ch) => ch.sum));
    if (sources.length >= 2) {
      try {
        const m = await utility("/v1/context/compress", { mode: "merge", words: Math.round(BUDGET.summary * 0.45), summaries: sources });
        fresh.digest = { e: take[take.length - 1].e, sum: m.summary, tok: est(m.summary), n: (fresh.digest?.n ?? 0) + take.length };
        fresh.chunks = fresh.chunks.slice(take.length);
      } catch (err) {
        console.error("merge failed:", (err as Error).message);
      }
    }
  }
  await c.from("threads").upsert({ user_id: userId, context: fresh, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
}

/* ── Linked chat: one continuous thread ───────────────────────────────────── */

async function handleThreadMessage(
  c: SupabaseClient,
  userId: string,
  chatId: number,
  messageId: number,
  userText: string,
  model: string,
  image?: { base64: string; mimeType: string },
) {
  const stored = image ? (userText ? `[Image] ${userText}` : "[Image]") : userText;
  await c.from("thread_messages").insert({ user_id: userId, role: "user", content: stored, source: "telegram", relayed_at: new Date().toISOString() });
  const ctx = await buildThreadContext(c, userId, userText);
  const raw = await callCloak(ctx.messages, clock() + ctx.system, model, image);
  const { react, silent, parts } = parseDirectives(raw);
  if (react) await reactTo(chatId, messageId, react);
  if (!silent) {
    await c.from("thread_messages").insert({ user_id: userId, role: "assistant", content: parts.join("\n\n"), source: "telegram", relayed_at: new Date().toISOString() });
    await sendChain(chatId, parts);
  }
  await later(maybeCompressThread(c, userId));
}

async function handleThreadReaction(c: SupabaseClient, userId: string, chatId: number, messageId: number, emojis: string[]) {
  const note = `[User reacted ${emojis.join(" ")} to your message]`;
  const ctx = await buildThreadContext(c, userId, note);
  const raw = await callCloak([...ctx.messages, { role: "user", content: note }].slice(-40), clock() + ctx.system, "pneuma");
  const { react, silent, parts } = parseDirectives(raw);
  if (react) await reactTo(chatId, messageId, react);
  if (!silent) {
    await c.from("thread_messages").insert({ user_id: userId, role: "assistant", content: parts.join("\n\n"), source: "telegram", relayed_at: new Date().toISOString() });
    await sendChain(chatId, parts);
  }
}

/* ── Unlinked chat: small standalone history ──────────────────────────────── */

type Session = { id: string; history: { role: string; message: string }[]; model: string };

async function getOrCreateSession(c: SupabaseClient, platformId: string): Promise<Session> {
  const { data, error } = await c.from("messaging_sessions").select("id, history, model")
    .eq("platform", "telegram").eq("platform_id", platformId).single();
  if (data) return data as Session;
  if (error?.code !== "PGRST116") throw error;
  const { data: created, error: createErr } = await c.from("messaging_sessions")
    .insert({ platform: "telegram", platform_id: platformId, history: [] }).select("id, history, model").single();
  if (createErr) throw createErr;
  return created as Session;
}

async function saveHistory(c: SupabaseClient, sessionId: string, history: { role: string; message: string }[]) {
  await c.from("messaging_sessions").update({ history: history.slice(-MAX_HISTORY) }).eq("id", sessionId);
}

const sessionMessages = (h: { role: string; message: string }[], next: string) => [
  ...h.map((m) => ({ role: /^(assistant|chatbot|bot|model)$/i.test(m.role) ? "assistant" : "user", content: m.message })),
  { role: "user", content: next || "[Image]" },
].slice(-20);

async function handleSessionMessage(c: SupabaseClient, chatId: number, messageId: number, userText: string, image?: { base64: string; mimeType: string }) {
  const session = await getOrCreateSession(c, String(chatId));
  const raw = await callCloak(sessionMessages(session.history, userText), clock(), pickModel(session.model), image);
  const { react, silent, parts } = parseDirectives(raw);
  if (react) await reactTo(chatId, messageId, react);
  const userHistoryText = image ? (userText ? `[Image] ${userText}` : "[Image]") : userText;
  await saveHistory(c, session.id, [
    ...session.history,
    { role: "USER", message: userHistoryText },
    { role: "CHATBOT", message: (react ? `<react emoji="${react}"/>` : "") + (silent ? "<silent/>" : parts.join("<break/>")) },
  ]);
  if (!silent) await sendChain(chatId, parts);
}

/* ── Router ───────────────────────────────────────────────────────────────── */

serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Internal / web routes (not Telegram updates).
  if (url.searchParams.has("relay")) {
    try { return await handleRelay(Number(url.searchParams.get("relay"))); }
    catch (e) { console.error("relay error:", (e as Error).message); return ok(); }
  }
  if (url.searchParams.get("action") === "link") {
    try { return await handleLinkRequest(req); }
    catch (e) { console.error("link error:", (e as Error).message); return json({ error: "Could not start linking." }, 500); }
  }

  // Telegram webhook.
  if (TELEGRAM_SECRET && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== TELEGRAM_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  let update: any;
  try { update = await req.json(); } catch { return new Response("Bad Request", { status: 400 }); }
  const c = db();

  // Model picker taps.
  const cb = update?.callback_query;
  if (cb?.data?.startsWith("model:") && cb.message) {
    const m = cb.data.slice(6);
    if (MODELS[m]) {
      const session = await getOrCreateSession(c, String(cb.message.chat.id));
      await c.from("messaging_sessions").update({ model: m }).eq("id", session.id);
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `Switched to ${modelName(m)}` });
      await tg("editMessageText", {
        chat_id: cb.message.chat.id, message_id: cb.message.message_id,
        text: modelMenuText(m), parse_mode: "Markdown", reply_markup: modelKeyboard(m),
      });
    }
    return ok();
  }

  // Reactions to Cloak's messages.
  const mr = update?.message_reaction;
  if (mr?.chat?.id && !mr.user?.is_bot) {
    const emojis = (mr.new_reaction ?? []).filter((r: { type: string; emoji?: string }) => r.type === "emoji" && r.emoji).map((r: { emoji: string }) => r.emoji);
    if (!emojis.length) return ok();
    try {
      const userId = await linkedUser(c, mr.chat.id);
      if (userId) await handleThreadReaction(c, userId, mr.chat.id, mr.message_id, emojis);
      else {
        const session = await getOrCreateSession(c, String(mr.chat.id));
        const note = `[User reacted ${emojis.join(" ")} to your message]`;
        const { react, silent, parts } = parseDirectives(await callCloak(sessionMessages(session.history, note), clock(), "pneuma"));
        if (react) await reactTo(mr.chat.id, mr.message_id, react);
        if (!silent) await sendChain(mr.chat.id, parts);
      }
    } catch (e) {
      console.error("reaction error:", (e as Error).message);
    }
    return ok();
  }

  const msg = update?.message;
  if (!msg?.chat?.id) return ok();
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  if (!msg.text && !hasPhoto) return ok();
  const chatId: number = msg.chat.id;
  const userText = String(msg.text ?? msg.caption ?? "").trim();
  const cmd = userText.startsWith("/") ? userText.slice(1).split(/\s+/)[0].split("@")[0].toLowerCase() : "";
  if (cmd && !["start", "reset", "new", "clear", "unlink", "model"].includes(cmd)) return ok();

  try {
    tg("sendChatAction", { chat_id: chatId, action: "typing" });
    const userId = await linkedUser(c, chatId);

    if (cmd === "start") {
      const payload = userText.split(/\s+/)[1] ?? "";
      if (payload.startsWith("link_")) {
        await redeemLink(c, chatId, payload.slice(5));
        await registerCommands();
        return ok();
      }
      await registerCommands();
      await sendTelegram(chatId, userId
        ? "This chat continues your Cloak conversation — same memories, same thread as the web. Just talk."
        : "Hey, I'm *Cloak*. Ask me anything, or send me an image.\n\n/model — switch AI model\nTo keep one conversation across the web and Telegram, open Cloak → Settings → Telegram → *Link Telegram*.");
      return ok();
    }
    if (cmd === "model") {
      const session = await getOrCreateSession(c, String(chatId));
      const arg = userText.split(/\s+/)[1]?.toLowerCase();
      if (arg && MODELS[arg]) {
        await c.from("messaging_sessions").update({ model: arg }).eq("id", session.id);
        await sendTelegram(chatId, `Switched to *${modelName(arg)}*.`);
      } else {
        const cur = pickModel(session.model);
        await tg("sendMessage", { chat_id: chatId, text: modelMenuText(cur), parse_mode: "Markdown", reply_markup: modelKeyboard(cur) });
      }
      return ok();
    }
    if (cmd === "unlink") {
      if (userId) await c.from("telegram_links").delete().eq("chat_id", chatId);
      await sendTelegram(chatId, userId ? "Unlinked. This chat no longer continues your Cloak conversation." : "This chat isn't linked to a Cloak account.");
      return ok();
    }
    if (cmd === "reset" || cmd === "new" || cmd === "clear") {
      if (userId) {
        await sendTelegram(chatId, "This chat is your one continuous Cloak conversation — older parts get condensed into memories automatically. To wipe it, use Settings → Clear conversation on the web.");
      } else {
        const session = await getOrCreateSession(c, String(chatId));
        await saveHistory(c, session.id, []);
        await sendTelegram(chatId, "Fresh start — I've cleared our conversation. What's up?");
      }
      return ok();
    }

    let image: { base64: string; mimeType: string } | undefined;
    if (hasPhoto) image = await downloadPhotoAsBase64(msg.photo[msg.photo.length - 1].file_id);

    if (userId) {
      const session = await getOrCreateSession(c, String(chatId));
      await handleThreadMessage(c, userId, chatId, msg.message_id, userText, pickModel(session.model), image);
    }
    else await handleSessionMessage(c, chatId, msg.message_id, userText, image);
  } catch (e) {
    console.error("telegram-bot error:", e instanceof Error ? e.message : String(e));
    await sendTelegram(chatId, "Something went wrong. Try again in a moment.");
  }
  return ok();
});
