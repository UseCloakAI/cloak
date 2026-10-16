-- Cloak Plan (/plan): one private credit-plan tracker, signed in with a Cloak account.
-- Only accounts on plan_allowlist with a CONFIRMED email can read or write their row.
-- The allowlist rows are added by hand in SQL (not in this repo, which is served publicly):
--   insert into public.plan_allowlist (email) values ('<her email>');

create table if not exists public.plan_allowlist (
  email text primary key check (email = lower(email))
);
-- RLS on with no policies: invisible to anon/authenticated through the API.
alter table public.plan_allowlist enable row level security;

create or replace function public.plan_is_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.plan_allowlist a
    join auth.users u on lower(u.email) = a.email
    where u.id = auth.uid() and u.email_confirmed_at is not null
  );
$$;
revoke all on function public.plan_is_allowed() from public, anon;
grant execute on function public.plan_is_allowed() to authenticated;

create table if not exists public.credit_plan_state (
  user_id uuid primary key,  -- no FK to auth.users: RLS ties the row to auth.uid()
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.credit_plan_state enable row level security;

create policy "plan owner only" on public.credit_plan_state
  for all to authenticated
  using ((select auth.uid()) = user_id and (select public.plan_is_allowed()))
  with check ((select auth.uid()) = user_id and (select public.plan_is_allowed()));
