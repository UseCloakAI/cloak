-- Multiple chats again, synced live across tabs/devices.
--
-- `chats` was unused since the one-continuous-thread redesign (it held a
-- user_id+id+title+messages(jsonb)+context row per old-style chat, written
-- whole on every send with no realtime). It's rebuilt here as a proper table:
-- one row per conversation, `thread_messages` now belongs to one via
-- `chat_id`, and each chat keeps its own compressed context (was
-- `threads.context`, one row per user — `threads` is now redundant and
-- dropped). Exactly one chat per user is the "Main" chat: the one Telegram
-- continues. Realtime is already on `thread_messages`; filtering by chat_id
-- instead of user_id means whichever chat is open on other tabs/devices gets
-- new messages the instant they land, same as before but per-chat.

ALTER TABLE public.chats RENAME TO chats_legacy;

CREATE TABLE public.chats (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title      text        NOT NULL DEFAULT 'New chat' CHECK (char_length(title) <= 120),
  is_main    boolean     NOT NULL DEFAULT false,
  context    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chats_one_main_per_user ON public.chats (user_id) WHERE is_main;
CREATE INDEX chats_user_id_idx ON public.chats (user_id, updated_at DESC);

ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY chats_select ON public.chats FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY chats_insert ON public.chats FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY chats_update ON public.chats FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY chats_delete ON public.chats FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

ALTER TABLE public.thread_messages ADD COLUMN chat_id bigint REFERENCES public.chats(id) ON DELETE CASCADE;

-- Every user who had the single thread gets a Main chat carrying over its
-- compression state; their existing messages move onto it.
INSERT INTO public.chats (user_id, title, is_main, context, updated_at)
SELECT user_id, 'Main chat', true, context, updated_at FROM public.threads;

INSERT INTO public.chats (user_id, title, is_main)
SELECT DISTINCT tm.user_id, 'Main chat', true
FROM public.thread_messages tm
WHERE NOT EXISTS (SELECT 1 FROM public.chats c WHERE c.user_id = tm.user_id AND c.is_main);

UPDATE public.thread_messages tm
SET chat_id = c.id
FROM public.chats c
WHERE c.user_id = tm.user_id AND c.is_main;

ALTER TABLE public.thread_messages ALTER COLUMN chat_id SET NOT NULL;
CREATE INDEX thread_messages_chat_id_idx ON public.thread_messages (chat_id, id DESC);

DROP TABLE public.threads;

-- Restore the pre-redesign chats (from chats_legacy) as their own chats,
-- each with its own thread_messages rows, oldest first.
WITH c1 AS (INSERT INTO public.chats (user_id, title, created_at, updated_at)
  VALUES ('68f10f50-4c72-4a8c-a4f3-1e0710a641cc', 'How are you?', '2026-03-20 05:08:44.777+00', '2026-03-20 05:08:44.777+00')
  RETURNING id)
INSERT INTO public.thread_messages (user_id, chat_id, role, content, source, created_at)
SELECT '68f10f50-4c72-4a8c-a4f3-1e0710a641cc', c1.id, v.role, v.content, 'web', v.at FROM c1, (VALUES
  ('user', 'How are you?', '2026-03-20 05:08:44.777+00'::timestamptz),
  ('assistant', 'I''m functioning well, thank you for asking! As an AI, I don''t have feelings or emotions, but I''m ready to assist you with any questions or tasks you may have. How can I help you today?', '2026-03-20 05:08:45.777+00'::timestamptz),
  ('user', 'Can you correct some hello world code', '2026-03-20 05:09:00.000+00'::timestamptz),
  ('assistant', 'Sure! Please share the "Hello, World!" code you''d like me to correct, along with the programming language it''s written in. I''ll be happy to help!', '2026-03-20 05:09:01.000+00'::timestamptz)
) AS v(role, content, at);

WITH c2 AS (INSERT INTO public.chats (user_id, title, created_at, updated_at)
  VALUES ('68f10f50-4c72-4a8c-a4f3-1e0710a641cc', 'Who are you', '2026-03-20 18:21:38.343+00', '2026-03-20 18:21:38.343+00')
  RETURNING id)
INSERT INTO public.thread_messages (user_id, chat_id, role, content, source, created_at)
SELECT '68f10f50-4c72-4a8c-a4f3-1e0710a641cc', c2.id, v.role, v.content, 'web', v.at FROM c2, (VALUES
  ('user', 'Who are you', '2026-03-20 18:21:38.343+00'::timestamptz),
  ('assistant', 'I''m Cloak, a sharp and thoughtful AI assistant designed to be genuinely helpful. I aim to provide clear, warm, and concise responses, whether you have a quick question or need a more thorough explanation. I''m also an excellent programmer, following best practices for clear code, error handling, and language conventions. How can I assist you today?', '2026-03-20 18:21:39.343+00'::timestamptz)
) AS v(role, content, at);

WITH c3 AS (INSERT INTO public.chats (user_id, title, created_at, updated_at)
  VALUES ('68f10f50-4c72-4a8c-a4f3-1e0710a641cc', 'Hey!', '2026-03-21 00:16:00.338+00', '2026-03-21 00:16:00.338+00')
  RETURNING id)
INSERT INTO public.thread_messages (user_id, chat_id, role, content, source, created_at)
SELECT '68f10f50-4c72-4a8c-a4f3-1e0710a641cc', c3.id, v.role, v.content, 'web', v.at FROM c3, (VALUES
  ('user', 'Hey!', '2026-03-21 00:16:00.338+00'::timestamptz),
  ('assistant', 'Hey there! How can I assist you today?', '2026-03-21 00:16:01.338+00'::timestamptz)
) AS v(role, content, at);

WITH c4 AS (INSERT INTO public.chats (user_id, title, created_at, updated_at)
  VALUES ('68f10f50-4c72-4a8c-a4f3-1e0710a641cc', 'Hey how are you?', '2026-03-23 03:50:00.079+00', '2026-03-23 03:50:00.079+00')
  RETURNING id)
INSERT INTO public.thread_messages (user_id, chat_id, role, content, source, created_at)
SELECT '68f10f50-4c72-4a8c-a4f3-1e0710a641cc', c4.id, v.role, v.content, 'web', v.at FROM c4, (VALUES
  ('user', 'Hey how are you?', '2026-03-23 03:50:00.079+00'::timestamptz),
  ('assistant', 'I''m functioning optimally, ready to assist you. How can I help you today?', '2026-03-23 03:50:01.079+00'::timestamptz)
) AS v(role, content, at);

DROP TABLE public.chats_legacy;

-- Web can only insert into a chat it owns.
DROP POLICY thread_messages_insert ON public.thread_messages;
CREATE POLICY thread_messages_insert ON public.thread_messages
  FOR INSERT TO authenticated WITH CHECK (
    (SELECT auth.uid()) = user_id AND source = 'web' AND relayed_at IS NULL
    AND EXISTS (SELECT 1 FROM public.chats c WHERE c.id = chat_id AND c.user_id = user_id)
  );

-- Keeps a chat's `updated_at` current (sidebar sort) without every write path
-- having to remember to bump it.
CREATE OR REPLACE FUNCTION public.chats_bump_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.chats SET updated_at = now() WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.chats_bump_updated_at() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER thread_messages_bump_chat
  AFTER INSERT ON public.thread_messages
  FOR EACH ROW EXECUTE FUNCTION public.chats_bump_updated_at();

-- Telegram only ever continues the Main chat, not every chat.
CREATE OR REPLACE FUNCTION public.thread_messages_relay()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.source <> 'telegram'
     AND EXISTS (SELECT 1 FROM public.chats c WHERE c.id = NEW.chat_id AND c.is_main)
     AND EXISTS (SELECT 1 FROM public.telegram_links l WHERE l.user_id = NEW.user_id) THEN
    PERFORM net.http_post(
      url := 'https://kdawsqrrmwirilyhcolk.supabase.co/functions/v1/telegram-bot?relay=' || NEW.id,
      body := '{}'::jsonb,
      headers := '{"Content-Type":"application/json"}'::jsonb
    );
  END IF;
  RETURN NEW;
END;
$$;
