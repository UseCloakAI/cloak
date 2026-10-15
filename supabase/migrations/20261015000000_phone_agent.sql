-- Phone agent (android-agent/): Cloak accounts chat with — and admins control —
-- the Cloak Agent phone through agent_messages. The phone signs in as an admin
-- account, polls pending rows, answers, and writes the reply back.
--
-- Also closes two holes that made "admin" meaningless:
--   * profiles_insert / profiles_update let any user set is_admin on their own row.
--   * "Admin insert" / "Admin update" on announcements were `true` (anyone could post).

-- ── Lock is_admin: only the dashboard / service role can change it ──────────
CREATE OR REPLACE FUNCTION public.profiles_guard_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(auth.role(), '') IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_admin := false;
    ELSE
      NEW.is_admin := OLD.is_admin;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profiles_guard_admin ON public.profiles;
CREATE TRIGGER profiles_guard_admin BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_admin();

DROP POLICY IF EXISTS "Admin insert" ON public.announcements;
DROP POLICY IF EXISTS "Admin update" ON public.announcements;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin);
$$;

-- ── Config: the admin toggle ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_config (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  admins_only boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
INSERT INTO public.agent_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.agent_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_config_select ON public.agent_config;
CREATE POLICY agent_config_select ON public.agent_config FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS agent_config_update ON public.agent_config;
CREATE POLICY agent_config_update ON public.agent_config FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Admins always; everyone signed in only when the toggle is off.
CREATE OR REPLACE FUNCTION public.agent_open() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_admin() OR NOT coalesce((SELECT admins_only FROM public.agent_config WHERE id = 1), true);
$$;

-- ── Messages: web ↔ phone ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_messages (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'agent')),
  content    text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
  reply_to   bigint REFERENCES public.agent_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_messages_pending ON public.agent_messages (id) WHERE role = 'user' AND status = 'pending';
CREATE INDEX IF NOT EXISTS agent_messages_user ON public.agent_messages (user_id, id);

ALTER TABLE public.agent_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_messages_select ON public.agent_messages;
CREATE POLICY agent_messages_select ON public.agent_messages FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

-- Users post their own pending messages (if the agent is open to them);
-- only admins (the phone) post agent replies.
DROP POLICY IF EXISTS agent_messages_insert ON public.agent_messages;
CREATE POLICY agent_messages_insert ON public.agent_messages FOR INSERT TO authenticated
  WITH CHECK (
    (role = 'user' AND user_id = auth.uid() AND status = 'pending' AND public.agent_open())
    OR (role = 'agent' AND public.is_admin())
  );

DROP POLICY IF EXISTS agent_messages_update ON public.agent_messages;
CREATE POLICY agent_messages_update ON public.agent_messages FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS agent_messages_delete ON public.agent_messages;
CREATE POLICY agent_messages_delete ON public.agent_messages FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

-- Flood guard: 20 messages / user / 10 min (admins exempt).
CREATE OR REPLACE FUNCTION public.agent_messages_rate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.role = 'user' AND NOT public.is_admin() AND (
    SELECT count(*) FROM public.agent_messages
    WHERE user_id = NEW.user_id AND role = 'user' AND created_at > now() - interval '10 minutes'
  ) >= 20 THEN
    RAISE EXCEPTION 'Slow down — try again in a few minutes.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS agent_messages_rate ON public.agent_messages;
CREATE TRIGGER agent_messages_rate BEFORE INSERT ON public.agent_messages
  FOR EACH ROW EXECUTE FUNCTION public.agent_messages_rate();

-- Live replies in the web app.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_messages;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
