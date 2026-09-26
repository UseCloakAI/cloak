-- Cloak memory system.
--  1. memory_files: each user's long-term memory as markdown files (see memory.js).
--     Owner-only via RLS; capped per user so the free-tier database can't be flooded.
--  2. chats.context: per-chat compression state (see context.js):
--     { v:1, chunks:[{s,e,sum,tok,at}], digest:{e,sum,tok,n}|null }

CREATE TABLE IF NOT EXISTS public.memory_files (
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  path         text        NOT NULL CHECK (path ~ '^(profile|preference|project|fact|episode)/[a-z0-9][a-z0-9-]{0,47}\.md$'),
  content      text        NOT NULL CHECK (char_length(content) <= 4000),
  hits         integer     NOT NULL DEFAULT 0 CHECK (hits >= 0),
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, path)
);

ALTER TABLE public.memory_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY memory_files_select ON public.memory_files
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY memory_files_insert ON public.memory_files
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY memory_files_update ON public.memory_files
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY memory_files_delete ON public.memory_files
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

-- updated_at + per-user cap (client keeps ≤300; hard stop at 400).
CREATE OR REPLACE FUNCTION public.memory_files_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (SELECT count(*) FROM public.memory_files WHERE user_id = NEW.user_id) >= 400 THEN
    RAISE EXCEPTION 'memory limit reached' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_files_guard
  BEFORE INSERT OR UPDATE ON public.memory_files
  FOR EACH ROW EXECUTE FUNCTION public.memory_files_guard();

ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb;
