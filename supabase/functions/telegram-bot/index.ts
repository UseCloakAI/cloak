import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? ""; // optional but recommended
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_HISTORY = 20; // messages (pairs) to keep per session

const MODELS: Record<string, string> = {
  pneuma: "Pneuma — creative, warm, everyday chat",
  logos:  "Logos — logical, precise reasoning",
  kairos: "Kairos — deep, thorough thinking",
};
const modelName = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

type Session = { id: string; history: { role: string; message: string }[]; model: string };

async function tg(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function modelKeyboard(current: string) {
  return {
    inline_keyboard: Object.keys(MODELS).map((m) => [{
      text: (m === current ? "● " : "") + modelName(m),
      callback_data: "model:" + m,
    }]),
  };
}

function modelMenuText(current: string) {
  return `Current model: *${modelName(current)}*\n\n` +
    Object.entries(MODELS).map(([, d]) => "• " + d).join("\n") +
    "\n\nPick one below, or send /model <name>.";
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
TELEGRAM REACTIONS — you can react to the user's message like a person would:
- Put <react emoji="👍"/> anywhere in your reply to react to their latest message. Pick from: 👍 ❤ 🔥 😁 🤣 🤔 👀 🙏 👏 🎉 💯 😢 🤯 🫡 😎 🤝 🥰 😭 🗿 🆒.
- Put <silent/> to send NO text reply (they'll just see "delivered" or your reaction). Use it the way a person would: for "ok", "thanks", "lol", "👍", sign-offs, or anything that doesn't need an answer. Usually pair it with a reaction.
- Most messages that ask something still get a normal text reply. Don't react to everything — only when it feels natural.
- If the user reacted to one of your messages, you'll see "[User reacted ❤ to your message]". Usually do nothing (<silent/>); only reply or react if it genuinely calls for it.`;

// Pull <react emoji="…"/> and <silent/> directives out of the model's reply.
function parseDirectives(raw: string) {
  let react: string | null = null;
  const m = raw.match(/<react\s+emoji\s*=\s*["']([^"']+)["']\s*\/?>/i);
  if (m) {
    const e = normEmoji(m[1].trim());
    react = [...REACTIONS].find((r) => normEmoji(r) === e) ?? null;
  }
  const silent = /<silent\s*\/?>/i.test(raw);
  const text = raw.replace(/<react[^>]*\/?>|<silent\s*\/?>|<\/react>/gi, "").trim();
  return { react, silent: silent || !text, text };
}

async function reactTo(chatId: number | string, messageId: number, emoji: string) {
  await tg("setMessageReaction", {
    chat_id: chatId, message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  });
}

// Make sure the webhook also delivers button taps and reactions
// (keeps the current URL + secret, just widens allowed_updates).
async function ensureWebhookUpdates() {
  const info = await (await tg("getWebhookInfo", {})).json().catch(() => null);
  const url = info?.result?.url;
  if (!url) return;
  await tg("setWebhook", {
    url,
    ...(TELEGRAM_SECRET ? { secret_token: TELEGRAM_SECRET } : {}),
    allowed_updates: ["message", "callback_query", "message_reaction"],
  });
}

// Register the command menu shown in Telegram's "/" picker.
async function registerCommands() {
  await ensureWebhookUpdates();
  await tg("setMyCommands", {
    commands: [
      { command: "model", description: "Show or switch the AI model" },
      { command: "reset", description: "Start a fresh conversation" },
      { command: "start", description: "About Cloak" },
    ],
  });
}

async function sendTelegram(chatId: number | string, text: string) {
  // Telegram max message length is 4096 chars; split if needed
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));

  for (const chunk of chunks) {
    const send = (parseMode?: string) =>
      fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, ...(parseMode ? { parse_mode: parseMode } : {}) }),
      });
    // Model markdown doesn't always parse as Telegram Markdown — fall back to plain text.
    const res = await send("Markdown");
    if (!res.ok) await send();
  }
}

async function getOrCreateSession(
  db: ReturnType<typeof createClient>,
  platformId: string,
): Promise<Session> {
  const { data, error } = await db
    .from("messaging_sessions")
    .select("id, history, model")
    .eq("platform", "telegram")
    .eq("platform_id", platformId)
    .single();

  if (data) return data as Session;
  if (error?.code !== "PGRST116") throw error; // unexpected error

  const { data: created, error: createErr } = await db
    .from("messaging_sessions")
    .insert({ platform: "telegram", platform_id: platformId, history: [] })
    .select("id, history, model")
    .single();

  if (createErr) throw createErr;
  return created as Session;
}

async function saveHistory(
  db: ReturnType<typeof createClient>,
  sessionId: string,
  history: { role: string; message: string }[],
) {
  // Trim to last MAX_HISTORY messages before saving
  const trimmed = history.slice(-MAX_HISTORY);
  await db.from("messaging_sessions").update({ history: trimmed }).eq("id", sessionId);
}

async function downloadPhotoAsBase64(fileId: string): Promise<{ base64: string; mimeType: string }> {
  // Get file path from Telegram
  const fileRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`,
  );
  const fileJson = await fileRes.json();
  const filePath: string = fileJson.result?.file_path;
  if (!filePath) throw new Error("Could not get file path from Telegram.");

  // Download the file
  const imgRes = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`,
  );
  if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);

  const buffer = await imgRes.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);

  // Infer mime type from file extension
  const mimeType = filePath.endsWith(".png") ? "image/png" : "image/jpeg";
  return { base64, mimeType };
}

// Answers come from cloak-api (https://api.usecloak.org) — the same backend
// as the web chat, with provider/model failover, so a retired model on one
// provider no longer takes the bot down.
const CLOAK_API = Deno.env.get("CLOAK_API_URL") ?? "https://api.usecloak.org";

async function callChatMessage(
  message: string,
  chatHistory: { role: string; message: string }[],
  model: string,
  image?: { base64: string; mimeType: string },
): Promise<string> {
  const messages = [
    ...chatHistory.map((m) => ({
      role: /^(assistant|chatbot|bot|model)$/i.test(m.role) ? "assistant" : "user",
      content: m.message,
    })),
    { role: "user", content: message || "[Image]" },
  ].slice(-20);

  const res = await fetch(`${CLOAK_API}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODELS[model] ? model : "pneuma",
      messages,
      system: `Current date and time (UTC): ${new Date().toISOString()}. You are replying in Telegram: keep formatting simple, and text like a person — short when short fits.\n${REACTION_GUIDE}`,
      ...(image ? { imageBase64: image.base64, mimeType: image.mimeType } : {}),
    }),
    signal: AbortSignal.timeout(55_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`cloak-api ${res.status}: ${err.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.response ?? json.text ?? "Sorry, I couldn't generate a response.";
}

serve(async (req) => {
  // Validate secret token if configured
  if (TELEGRAM_SECRET) {
    const header = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== TELEGRAM_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let update: {
    message_reaction?: {
      chat: { id: number };
      message_id: number;
      user?: { id: number; is_bot?: boolean };
      new_reaction: { type: string; emoji?: string }[];
    };
    callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
    message?: {
      message_id: number;
      chat: { id: number };
      from?: { id: number };
      text?: string;
      caption?: string;
      photo?: { file_id: string; width: number; height: number }[];
    };
  };

  try {
    update = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Model picker button taps
  const cb = update?.callback_query;
  if (cb?.data?.startsWith("model:") && cb.message) {
    const m = cb.data.slice(6);
    if (MODELS[m]) {
      const db = createClient(SUPABASE_URL, SERVICE_KEY);
      const session = await getOrCreateSession(db, String(cb.message.chat.id));
      await db.from("messaging_sessions").update({ model: m }).eq("id", session.id);
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `Switched to ${modelName(m)}` });
      await tg("editMessageText", {
        chat_id: cb.message.chat.id, message_id: cb.message.message_id,
        text: modelMenuText(m), parse_mode: "Markdown", reply_markup: modelKeyboard(m),
      });
    }
    return new Response("ok", { status: 200 });
  }

  // User reacted to a message — let Cloak decide whether that deserves anything.
  const mr = update?.message_reaction;
  if (mr?.chat?.id && !mr.user?.is_bot) {
    const emojis = mr.new_reaction.filter((r) => r.type === "emoji" && r.emoji).map((r) => r.emoji!);
    if (!emojis.length) return new Response("ok", { status: 200 }); // reaction removed
    try {
      const db = createClient(SUPABASE_URL, SERVICE_KEY);
      const session = await getOrCreateSession(db, String(mr.chat.id));
      const note = `[User reacted ${emojis.join(" ")} to your message]`;
      const raw = await callChatMessage(note, session.history, session.model);
      const { react, silent, text } = parseDirectives(raw);
      if (react) await reactTo(mr.chat.id, mr.message_id, react);
      if (!silent) await sendTelegram(mr.chat.id, text);
      await saveHistory(db, session.id, [
        ...session.history,
        { role: "USER", message: note },
        { role: "CHATBOT", message: (react ? `<react emoji="${react}"/>` : "") + (silent ? "<silent/>" : text) },
      ]);
    } catch (e) {
      console.error("telegram-bot reaction error:", e instanceof Error ? e.message : String(e));
    }
    return new Response("ok", { status: 200 });
  }

  const msg = update?.message;
  if (!msg?.chat?.id) return new Response("ok", { status: 200 });

  // Must have text or a photo
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  if (!msg.text && !hasPhoto) return new Response("ok", { status: 200 });

  const chatId   = msg.chat.id;
  const userText = (msg.text ?? msg.caption ?? "").trim();

  // Commands: /start, /reset, /model [name]; ignore any others.
  const cmd = userText.startsWith("/") ? userText.slice(1).split(/\s+/)[0].split("@")[0].toLowerCase() : "";
  if (cmd && !["start", "reset", "new", "clear", "model"].includes(cmd)) {
    return new Response("ok", { status: 200 });
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // Show typing indicator (fire-and-forget)
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });

    if (cmd === "start") {
      await registerCommands();
      await sendTelegram(chatId,
        "Hey, I'm *Cloak* — an AI assistant. Ask me anything, or send me an image.\n\n/model — switch AI model\n/reset — start a fresh conversation"
      );
      return new Response("ok", { status: 200 });
    }

    const session = await getOrCreateSession(db, String(chatId));

    if (cmd === "reset" || cmd === "new" || cmd === "clear") {
      await saveHistory(db, session.id, []);
      await sendTelegram(chatId, "Fresh start — I've cleared our conversation. What's up?");
      return new Response("ok", { status: 200 });
    }

    if (cmd === "model") {
      const arg = userText.split(/\s+/)[1]?.toLowerCase();
      if (arg && MODELS[arg]) {
        await db.from("messaging_sessions").update({ model: arg }).eq("id", session.id);
        await sendTelegram(chatId, `Switched to *${modelName(arg)}*.`);
      } else {
        const cur = MODELS[session.model] ? session.model : "pneuma";
        await tg("sendMessage", {
          chat_id: chatId, text: modelMenuText(cur), parse_mode: "Markdown", reply_markup: modelKeyboard(cur),
        });
      }
      return new Response("ok", { status: 200 });
    }

    // Download photo if present (use largest size)
    let image: { base64: string; mimeType: string } | undefined;
    if (hasPhoto) {
      const largest = msg.photo![msg.photo!.length - 1];
      image = await downloadPhotoAsBase64(largest.file_id);
    }

    const raw = await callChatMessage(userText, session.history, session.model, image);
    const { react, silent, text: reply } = parseDirectives(raw);
    if (react) await reactTo(chatId, msg.message_id, react);

    // Store [Image] as user turn text — base64 is too large to persist
    const userHistoryText = hasPhoto ? (userText ? `[Image] ${userText}` : "[Image]") : userText;

    const newHistory = [
      ...session.history,
      { role: "USER", message: userHistoryText },
      { role: "CHATBOT", message: (react ? `<react emoji="${react}"/>` : "") + (silent ? "<silent/>" : reply) },
    ];
    await saveHistory(db, session.id, newHistory);

    // Left on "delivered" (or just a reaction) when Cloak chose silence.
    if (!silent) await sendTelegram(chatId, reply);
  } catch (e) {
    console.error("telegram-bot error:", e instanceof Error ? e.message : String(e));
    await sendTelegram(chatId, "Something went wrong. Try again in a moment.");
  }

  return new Response("ok", { status: 200 });
});
