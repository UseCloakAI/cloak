-- Cloak Blinks (usecloak.org/blinks): chats and custom Blinks for signed-in
-- users. Additive only: production tables (chats, thread_messages, …) are
-- untouched. Blinks requires a Cloak account; these rows are the main copy
-- (the home-PC brain keeps its own copy and catches up from here).

-- One row per conversation. messages is a JSON array of
-- {role, content, at?, companion?, meta?, care?, react?, taps?, onRead?}.
-- File bytes never live here, only references to files on the brain.
create table if not exists public.pv_chats (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  companion text not null default 'cloak' check (companion ~ '^(cloak|u_[a-z0-9]{4,36}|pip|moss|ember|juno|sol)$'),
  title text not null default '',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pv_chats_user_updated on public.pv_chats (user_id, updated_at desc);
alter table public.pv_chats enable row level security;
create policy "pv_chats: owner can read" on public.pv_chats for select to authenticated using ((select auth.uid()) = user_id);
create policy "pv_chats: owner can insert" on public.pv_chats for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "pv_chats: owner can update" on public.pv_chats for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "pv_chats: owner can delete" on public.pv_chats for delete to authenticated using ((select auth.uid()) = user_id);

-- The Blinks a person has built (maker.js), one row per person.
create table if not exists public.pv_bots (
  user_id uuid primary key references auth.users (id) on delete cascade default auth.uid(),
  bots jsonb not null default '[]'::jsonb check (jsonb_typeof(bots) = 'array' and jsonb_array_length(bots) <= 12),
  updated_at timestamptz not null default now()
);
alter table public.pv_bots enable row level security;
create policy "pv_bots: owner can read" on public.pv_bots for select to authenticated using ((select auth.uid()) = user_id);
create policy "pv_bots: owner can insert" on public.pv_bots for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "pv_bots: owner can update" on public.pv_bots for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "pv_bots: owner can delete" on public.pv_bots for delete to authenticated using ((select auth.uid()) = user_id);
