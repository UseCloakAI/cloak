-- One continuous Cloak conversation per user, shared by every platform.
--
--  thread_messages  append-only log (web, telegram, …). Web writes its own rows
--                   (RLS); the Telegram bot writes with the service role.
--  threads          per-user compression state (chunk summaries + digest, keyed
--                   by message id) — see context.js.
--  telegram_links   which Telegram chat continues which user's thread.
--  telegram_link_codes  one-time codes behind the "Link Telegram" deep link.
--
-- Every non-Telegram message is mirrored to the user's linked Telegram chat by
-- an AFTER INSERT trigger → pg_net → telegram-bot?relay=<id>. The function
-- re-reads the row and only relays rows whose relayed_at is still null, so the
-- endpoint needs no secret: calling it can only deliver a message early.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.thread_messages (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content      text        NOT NULL CHECK (char_length(content) <= 60000),
  source       text        NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'telegram', 'api')),
  client_id    text        CHECK (client_id IS NULL OR char_length(client_id) <= 64),
  created_at   timestamptz NOT NULL DEFAULT now(),
  relayed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS thread_messages_user_id_idx ON public.thread_messages (user_id, id DESC);

ALTER TABLE public.thread_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY thread_messages_select ON public.thread_messages
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY thread_messages_insert ON public.thread_messages
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id AND source = 'web' AND relayed_at IS NULL);
CREATE POLICY thread_messages_delete ON public.thread_messages
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE TABLE IF NOT EXISTS public.threads (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  context    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY threads_select ON public.threads
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY threads_insert ON public.threads
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY threads_update ON public.threads
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE TABLE IF NOT EXISTS public.telegram_links (
  user_id   uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id   bigint      NOT NULL UNIQUE,
  linked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.telegram_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY telegram_links_select ON public.telegram_links
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY telegram_links_delete ON public.telegram_links
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

-- Service role only (the bot issues and redeems codes).
CREATE TABLE IF NOT EXISTS public.telegram_link_codes (
  code       text        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);
ALTER TABLE public.telegram_link_codes ENABLE ROW LEVEL SECURITY;

-- Live sync to open web tabs.
ALTER PUBLICATION supabase_realtime ADD TABLE public.thread_messages;

CREATE OR REPLACE FUNCTION public.thread_messages_relay()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.source <> 'telegram' AND EXISTS (SELECT 1 FROM public.telegram_links l WHERE l.user_id = NEW.user_id) THEN
    PERFORM net.http_post(
      url := 'https://kdawsqrrmwirilyhcolk.supabase.co/functions/v1/telegram-bot?relay=' || NEW.id,
      body := '{}'::jsonb,
      headers := '{"Content-Type":"application/json"}'::jsonb
    );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.thread_messages_relay() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER thread_messages_relay
  AFTER INSERT ON public.thread_messages
  FOR EACH ROW EXECUTE FUNCTION public.thread_messages_relay();
