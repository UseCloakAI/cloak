-- Removes the "Main chat" concept. Telegram now continues whichever chat is
-- active — the one you have open on web, or the last one it touched from
-- Telegram — instead of one fixed, designated chat. `profiles.active_chat_id`
-- holds that pointer: the web updates it on every chat switch, and the
-- Telegram bot reads (and, if unset, sets) it to know which chat to
-- continue. Web messages relay to Telegram only while their chat is the
-- active one.

ALTER TABLE public.profiles ADD COLUMN active_chat_id bigint REFERENCES public.chats(id) ON DELETE SET NULL;

-- Carry over each user's old Main chat as their active chat.
UPDATE public.profiles p
SET active_chat_id = c.id
FROM public.chats c
WHERE c.user_id = p.id AND c.is_main = true;

-- Anyone left over (had chats but no Main) gets their most recently active one.
UPDATE public.profiles p
SET active_chat_id = sub.id
FROM (
  SELECT DISTINCT ON (user_id) id, user_id FROM public.chats ORDER BY user_id, updated_at DESC
) sub
WHERE p.id = sub.user_id AND p.active_chat_id IS NULL;

ALTER TABLE public.chats DROP COLUMN is_main;

CREATE OR REPLACE FUNCTION public.thread_messages_relay()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.source <> 'telegram'
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id AND p.active_chat_id = NEW.chat_id)
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
