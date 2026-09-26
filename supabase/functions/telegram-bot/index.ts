import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? ""; // optional but recommended
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_HISTORY = 20; // messages (pairs) to keep per session

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
): Promise<{ id: string; history: { role: string; message: string }[] }> {
  const { data, error } = await db
    .from("messaging_sessions")
    .select("id, history")
    .eq("platform", "telegram")
    .eq("platform_id", platformId)
    .single();

  if (data) return data as { id: string; history: { role: string; message: string }[] };
  if (error?.code !== "PGRST116") throw error; // unexpected error

  const { data: created, error: createErr } = await db
    .from("messaging_sessions")
    .insert({ platform: "telegram", platform_id: platformId, history: [] })
    .select("id, history")
    .single();

  if (createErr) throw createErr;
  return created as { id: string; history: { role: string; message: string }[] };
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
      model: "pneuma",
      messages,
      system: `Current date and time (UTC): ${new Date().toISOString()}. You are replying in Telegram: keep formatting simple.`,
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
    message?: {
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

  const msg = update?.message;
  if (!msg?.chat?.id) return new Response("ok", { status: 200 });

  // Must have text or a photo
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  if (!msg.text && !hasPhoto) return new Response("ok", { status: 200 });

  const chatId   = msg.chat.id;
  const userText = (msg.text ?? msg.caption ?? "").trim();

  // Ignore bot commands other than /start
  if (userText.startsWith("/") && !userText.startsWith("/start")) {
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

    if (userText === "/start") {
      await sendTelegram(chatId,
        "Hey, I'm *Cloak* — an AI assistant. Ask me anything, or send me an image."
      );
      return new Response("ok", { status: 200 });
    }

    const session = await getOrCreateSession(db, String(chatId));

    // Download photo if present (use largest size)
    let image: { base64: string; mimeType: string } | undefined;
    if (hasPhoto) {
      const largest = msg.photo![msg.photo!.length - 1];
      image = await downloadPhotoAsBase64(largest.file_id);
    }

    const reply = await callChatMessage(userText, session.history, image);

    // Store [Image] as user turn text — base64 is too large to persist
    const userHistoryText = hasPhoto ? (userText ? `[Image] ${userText}` : "[Image]") : userText;

    const newHistory = [
      ...session.history,
      { role: "USER", message: userHistoryText },
      { role: "CHATBOT", message: reply },
    ];
    await saveHistory(db, session.id, newHistory);

    await sendTelegram(chatId, reply);
  } catch (e) {
    console.error("telegram-bot error:", e instanceof Error ? e.message : String(e));
    await sendTelegram(chatId, "Something went wrong. Try again in a moment.");
  }

  return new Response("ok", { status: 200 });
});
