-- Cloak Blinks (usecloak.org/blinks): chats for signed-in users.
-- Additive only. Production tables (chats, thread_messages, …) are untouched.
-- One row per conversation; messages are a JSON array of
-- {role, content, companion?, meta?, care?}. Images are never stored.

create table if not exists public.pv_chats (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  companion text not null default 'pip' check (companion in ('pip', 'moss', 'ember', 'juno', 'sol')),
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
