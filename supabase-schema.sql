-- FinTrack — Supabase schema
-- Paste this entire file into: Supabase → SQL Editor → New query → Run

create table if not exists accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade not null,
  name            text not null,
  type            text not null default 'bank',
  initial_balance numeric not null default 0,
  color           text not null default '#6366f1',
  created_at      timestamptz not null default now()
);

create table if not exists transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  date          date not null,
  amount        numeric not null,
  type          text not null check (type in ('income','expense','transfer')),
  category_id   text,
  account_id    uuid references accounts(id) on delete set null,
  to_account_id uuid references accounts(id) on delete set null,
  note          text not null default '',
  tags          text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

create index if not exists idx_tx_user_date on transactions(user_id, date desc);

alter table accounts     enable row level security;
alter table transactions enable row level security;

create policy "own accounts"     on accounts     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own transactions" on transactions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists user_settings (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  currency          text  not null default 'CAD',
  budgets           jsonb not null default '{}',
  custom_categories jsonb not null default '[]',
  subscriptions     jsonb not null default '[]'
);

-- Run these if the table already exists (safe to re-run):
alter table user_settings add column if not exists custom_categories jsonb not null default '[]';
alter table user_settings add column if not exists subscriptions     jsonb not null default '[]';
-- v6: cross-device Hours-tracker defaults (default job, default rate, deposit
-- account, default account) — mirrors the localStorage convenience keys so a
-- new device picks them up. { defaultJobId, employer, rate, accountId, defaultAccountId }
alter table user_settings add column if not exists job_defaults      jsonb not null default '{}'::jsonb;
-- v6: the rest of the previously device-local settings, also synced.
--   shift_goal   — weekly hours/pay goal { metric, target }
--   shift_presets— saved quick-log shift templates (array)
--   ui_prefs     — misc UI prefs, e.g. { balanceMode: 'cash'|'networth' }
alter table user_settings add column if not exists shift_goal        jsonb not null default '{}'::jsonb;
alter table user_settings add column if not exists shift_presets     jsonb not null default '[]'::jsonb;
alter table user_settings add column if not exists ui_prefs          jsonb not null default '{}'::jsonb;
alter table user_settings alter column currency set default 'CAD';
alter table user_settings enable row level security;
create policy "own settings" on user_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- v2 (June 2026): per-row table for subscriptions, replacing the
-- jsonb blob in user_settings. Safe to re-run. The app lazily
-- migrates blob data into the table on first load, then empties it.
-- (The recurring-rules feature was removed — Subscriptions covers
-- it. Any existing `recurring_rules` table can be dropped manually.)
-- ============================================================

create table if not exists subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  name        text not null,
  amount      numeric not null,
  frequency   text not null default 'monthly' check (frequency in ('weekly','monthly','yearly')),
  next_due    date not null,
  account_id  uuid references accounts(id) on delete set null,
  category_id text,
  color       text,
  auto_log    boolean not null default true,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists idx_subs_user on subscriptions(user_id, next_due);
alter table subscriptions enable row level security;
create policy "own subscriptions" on subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- v3 (June 2026): crypto wallets — read-only balance viewing.
-- Stores ONLY public addresses (never keys/seeds). The app
-- falls back to localStorage until this table exists, then
-- migrates local wallets into it on first load. Safe to re-run.
-- ============================================================
create table if not exists crypto_wallets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade not null,
  label      text not null default 'Wallet',
  chain      text not null,
  addresses  text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_crypto_user on crypto_wallets(user_id, created_at);
alter table crypto_wallets enable row level security;
create policy "own crypto wallets" on crypto_wallets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- v4 (June 2026): work shifts — hours + pay tracker. The app falls
-- back to localStorage until this table exists, then migrates local
-- shifts into it on first load. A logged shift can create an income
-- transaction (tx_id links to it). Safe to re-run.
-- ============================================================
create table if not exists shifts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  date        date not null,
  start_time  text not null default '',
  end_time    text not null default '',
  break_min   integer not null default 0,
  rate        numeric not null default 0,
  pay_mode    text not null default 'hourly' check (pay_mode in ('hourly','fixed')),
  fixed_pay   numeric not null default 0,
  tips        numeric not null default 0,
  employer    text not null default '',
  account_id  uuid references accounts(id) on delete set null,
  category_id text,
  tx_id       uuid references transactions(id) on delete set null,
  note        text not null default '',
  created_at  timestamptz not null default now()
);
-- Run these if the shifts table already exists (safe to re-run):
alter table shifts add column if not exists pay_mode  text    not null default 'hourly';
alter table shifts add column if not exists fixed_pay numeric not null default 0;
alter table shifts add column if not exists tips      numeric not null default 0;
create index if not exists idx_shifts_user on shifts(user_id, date desc);
alter table shifts enable row level security;
create policy "own shifts" on shifts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- v5 (June 2026): "just total hours" logging + payday reconciliation.
--   * shifts.hours — a direct decimal-hours value for the fast quick-log
--     path (no clock times). 0/null means use start_time/end_time instead.
--   * shift_payouts — each "mark as paid" cash event: it settles a set of
--     shifts (shift_ids), recording the estimated total (hours × rate), the
--     actual cash received, and the bonus (actual − estimated, i.e. the boss
--     rounding up). A shift is "paid" when a payout's shift_ids include it.
-- The app falls back to localStorage until these exist. Safe to re-run.
-- ============================================================
alter table shifts add column if not exists hours numeric not null default 0;

create table if not exists shift_payouts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade not null,
  date       date not null,
  hours      numeric not null default 0,
  estimated  numeric not null default 0,
  actual     numeric not null default 0,
  bonus      numeric not null default 0,
  shift_ids  jsonb not null default '[]'::jsonb,
  tx_id      uuid references transactions(id) on delete set null,
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_payouts_user on shift_payouts(user_id, date desc);
alter table shift_payouts enable row level security;
create policy "own payouts" on shift_payouts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- v6 (June 2026): named jobs. A job is a reusable employer/role with a
-- default hourly rate, deposit account and income category — it replaces the
-- per-device localStorage "job defaults" so the same jobs follow you across
-- devices. Shifts reference a job (job_id) and keep the job's name in
-- `employer` for the by-job analytics. The app falls back to localStorage
-- until this table exists, then seeds jobs from your existing shift names on
-- first load. Safe to re-run.
-- ============================================================
create table if not exists jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  name        text not null default '',
  rate        numeric not null default 0,
  account_id  uuid references accounts(id) on delete set null,
  category_id text,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_jobs_user on jobs(user_id);
alter table jobs enable row level security;
create policy "own jobs" on jobs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Link shifts to a job (the name stays denormalised in `employer`):
alter table shifts add column if not exists job_id uuid references jobs(id) on delete set null;

-- ============================================================
-- delete_my_account() — lets a signed-in user delete their own account.
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Deleting the auth.users row removes the email/login, and every app table
-- references auth.users(id) ON DELETE CASCADE, so all of the user's rows go
-- with it in the same transaction.
--
-- SECURITY DEFINER is needed because ordinary users can't touch auth.users.
-- It is safe here: the function takes no arguments and only ever deletes the
-- caller's own row (auth.uid()), and search_path is pinned to stop
-- object-shadowing tricks.
-- ============================================================
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
