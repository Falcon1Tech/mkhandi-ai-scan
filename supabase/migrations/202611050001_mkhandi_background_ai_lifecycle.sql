-- MKHANDI background AI wait-state lifecycle and canonical default watchlist.
-- Apply once in the existing Supabase project before deploying the updated Edge Function.

alter table public.mkhandi_watchlists
  alter column symbols set default '{}'::text[];

alter table public.mkhandi_watchlists
  add column if not exists markets text[] not null default array[
    'Boom 1000 Index',
    'Boom 500 Index',
    'Crash 1000 Index',
    'Crash 900 Index',
    'Crash 600 Index',
    'Crash 300 Index',
    'Boom 300 Index',
    'Boom 600 Index',
    'Boom 900 Index',
    'Step Index'
  ]::text[];

-- Make the requested ten markets the account default. The client can subsequently
-- save a user's deliberate watchlist edits back to this row.
update public.mkhandi_watchlists
set markets = array[
  'Boom 1000 Index',
  'Boom 500 Index',
  'Crash 1000 Index',
  'Crash 900 Index',
  'Crash 600 Index',
  'Crash 300 Index',
  'Boom 300 Index',
  'Boom 600 Index',
  'Boom 900 Index',
  'Step Index'
]::text[],
symbols = '{}'::text[],
market_names = '{}'::jsonb,
updated_at = now();

create table if not exists public.mkhandi_signal_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  market_name text not null,
  direction text not null default 'WAIT' check (direction in ('BUY','SELL','WAIT')),
  status text not null default 'WAITING' check (status in ('WAITING','AI_QUALIFYING','AI_REJECTED','AUTHENTICATED','CLOSED')),
  technical_snapshot jsonb not null default '{}'::jsonb,
  ai_result jsonb not null default '{}'::jsonb,
  wait_reason text not null default 'Waiting for a valid technical setup.',
  last_seen_at timestamptz not null default now(),
  last_ai_at timestamptz,
  next_ai_at timestamptz,
  published_signal_id uuid references public.mkhandi_signals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mkhandi_one_open_candidate_per_user_symbol
  on public.mkhandi_signal_candidates(user_id, symbol)
  where status in ('WAITING','AI_QUALIFYING','AI_REJECTED');

create index if not exists mkhandi_candidates_user_updated
  on public.mkhandi_signal_candidates(user_id, updated_at desc);

alter table public.mkhandi_signal_candidates enable row level security;

drop policy if exists "Users read own signal candidates" on public.mkhandi_signal_candidates;
create policy "Users read own signal candidates"
  on public.mkhandi_signal_candidates for select to authenticated
  using (auth.uid() = user_id);

grant select on public.mkhandi_signal_candidates to authenticated;
grant all on public.mkhandi_signal_candidates to service_role;

-- Keep the existing worker lease and signal/event policies from the first migration.
