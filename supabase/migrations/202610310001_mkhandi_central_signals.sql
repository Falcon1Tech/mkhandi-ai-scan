-- MKHANDI central account history, server scanner state and push registrations.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.mkhandi_watchlists (
  user_id uuid primary key references auth.users(id) on delete cascade,
  symbols text[] not null default array['BOOM1000','BOOM500','CRASH1000','CRASH5000'],
  scan_interval_minutes integer not null default 30 check (scan_interval_minutes in (30,60)),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.mkhandi_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text,
  symbol text not null,
  market_name text not null,
  direction text not null check (direction in ('BUY','SELL')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','TP2_REACHED','INVALIDATED','CANCELLED')),
  entry numeric not null,
  invalidation numeric not null,
  tp1 numeric,
  tp2 numeric not null,
  confidence numeric not null check (confidence between 0 and 100),
  rationale text not null default '',
  technical_snapshot jsonb not null default '{}'::jsonb,
  authenticated_at timestamptz not null default now(),
  completed_at timestamptz,
  completion_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists mkhandi_one_active_signal_per_user_symbol
  on public.mkhandi_signals(user_id,symbol) where status='ACTIVE';
create unique index if not exists mkhandi_signals_user_source on public.mkhandi_signals(user_id,source_id) where source_id is not null;
create index if not exists mkhandi_signals_user_created on public.mkhandi_signals(user_id,created_at desc);

create table if not exists public.mkhandi_signal_events (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.mkhandi_signals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('AUTHENTICATED','TP2_REACHED','INVALIDATED','REVIEWED')),
  price numeric,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists mkhandi_signal_events_user_created on public.mkhandi_signal_events(user_id,created_at desc);

create table if not exists public.mkhandi_push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'onesignal',
  subscription_id text,
  platform text not null check (platform in ('web','android','ios')),
  enabled boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,provider,platform)
);

create table if not exists public.mkhandi_scanner_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  last_qualification_at timestamptz,
  last_quote numeric,
  last_quote_at timestamptz,
  primary key(user_id,symbol)
);

create table if not exists public.mkhandi_scanner_health (
  symbol text primary key,
  market_name text not null,
  deriv_connected boolean not null default false,
  last_quote numeric,
  last_quote_at timestamptz,
  last_scan_at timestamptz,
  ai_status text not null default 'IDLE',
  last_error text,
  updated_at timestamptz not null default now()
);

alter table public.mkhandi_watchlists enable row level security;
alter table public.mkhandi_signals enable row level security;
alter table public.mkhandi_signal_events enable row level security;
alter table public.mkhandi_push_devices enable row level security;
alter table public.mkhandi_scanner_health enable row level security;
alter table public.mkhandi_scanner_state enable row level security;

drop policy if exists "Users manage own watchlist" on public.mkhandi_watchlists;
create policy "Users manage own watchlist" on public.mkhandi_watchlists for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
drop policy if exists "Users read own signals" on public.mkhandi_signals;
create policy "Users read own signals" on public.mkhandi_signals for select using (auth.uid()=user_id);
drop policy if exists "Users read own signal events" on public.mkhandi_signal_events;
create policy "Users read own signal events" on public.mkhandi_signal_events for select using (auth.uid()=user_id);
drop policy if exists "Users manage own push devices" on public.mkhandi_push_devices;
create policy "Users manage own push devices" on public.mkhandi_push_devices for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
drop policy if exists "Users read scanner health" on public.mkhandi_scanner_health;
create policy "Users read scanner health" on public.mkhandi_scanner_health for select to authenticated using (true);

grant select,insert,update,delete on public.mkhandi_watchlists to authenticated;
grant select on public.mkhandi_signals, public.mkhandi_signal_events, public.mkhandi_scanner_health to authenticated;
grant select,insert,update,delete on public.mkhandi_push_devices to authenticated;
grant all on public.mkhandi_watchlists, public.mkhandi_signals, public.mkhandi_signal_events, public.mkhandi_push_devices, public.mkhandi_scanner_health, public.mkhandi_scanner_state to service_role;

-- Deploy supabase/functions/mkhandi-background-scanner before enabling the schedule.
-- Store mkhandi_worker_url and mkhandi_worker_secret in Supabase Vault, then run
-- supabase/enable-background-scanner-cron.sql. This prevents an empty cron job
-- from being installed before credentials are configured.
