-- Per-chat model choice for messaging bots (/model in Telegram).
ALTER TABLE public.messaging_sessions ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'pneuma';
