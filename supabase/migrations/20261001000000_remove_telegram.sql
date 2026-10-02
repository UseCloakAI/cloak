-- Removes the Telegram integration entirely: the web → Telegram relay
-- trigger, the link tables, and the bot's session table. The telegram-bot
-- Edge Function is deleted alongside this.
DROP TRIGGER IF EXISTS thread_messages_relay ON public.thread_messages;
DROP FUNCTION IF EXISTS public.thread_messages_relay();
DROP TABLE IF EXISTS public.telegram_link_codes;
DROP TABLE IF EXISTS public.telegram_links;
DROP TABLE IF EXISTS public.messaging_sessions;
ALTER TABLE public.thread_messages DROP COLUMN IF EXISTS relayed_at;
