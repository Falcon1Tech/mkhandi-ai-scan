-- Persistent trade journal with private screenshot evidence and auditable AI review.
create table if not exists public.mkhandi_trade_journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  signal_id uuid not null references public.mkhandi_signals(id) on delete cascade,
  outcome text not null check (outcome in ('WIN','LOSS','BREAKEVEN','PARTIAL')),
  actual_entry numeric,
  actual_exit numeric,
  pnl_amount numeric,
  pnl_currency text not null default 'USD',
  notes text not null default '',
  evidence_paths text[] not null default '{}',
  review_status text not null default 'PENDING_REVIEW'
    check (review_status in ('PENDING_REVIEW','AI_SUPPORTED','AI_CONFLICT','INSUFFICIENT_EVIDENCE')),
  ai_analysis jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(user_id,signal_id)
);
create index if not exists mkhandi_trade_journal_user_submitted_idx
  on public.mkhandi_trade_journal(user_id,submitted_at desc);
create index if not exists mkhandi_trade_journal_review_idx
  on public.mkhandi_trade_journal(user_id,review_status);

alter table public.mkhandi_trade_journal enable row level security;
drop policy if exists "Users read own trade journal" on public.mkhandi_trade_journal;
create policy "Users read own trade journal" on public.mkhandi_trade_journal
  for select to authenticated using ((select auth.uid())=user_id);
drop policy if exists "Users insert own trade journal" on public.mkhandi_trade_journal;
create policy "Users insert own trade journal" on public.mkhandi_trade_journal
  for insert to authenticated with check (
    (select auth.uid())=user_id and exists (
      select 1 from public.mkhandi_signals s
      where s.id=signal_id and s.user_id=(select auth.uid())
        and s.direction in ('BUY','SELL')
        and s.authenticated_at is not null
    )
  );
drop policy if exists "Users update own trade journal" on public.mkhandi_trade_journal;
create policy "Users update own trade journal" on public.mkhandi_trade_journal
  for update to authenticated using ((select auth.uid())=user_id)
  with check (
    (select auth.uid())=user_id and exists (
      select 1 from public.mkhandi_signals sig
      where sig.id=signal_id and sig.user_id=(select auth.uid())
        and sig.direction in ('BUY','SELL') and sig.authenticated_at is not null
    )
  );
grant select,insert,update on public.mkhandi_trade_journal to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('mkhandi-trade-evidence','mkhandi-trade-evidence',false,10485760,
  array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=false,file_size_limit=10485760,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "Users upload own MKHANDI trade evidence" on storage.objects;
create policy "Users upload own MKHANDI trade evidence" on storage.objects
for insert to authenticated with check (
  bucket_id='mkhandi-trade-evidence'
  and (storage.foldername(name))[1]=(select auth.uid()::text)
);
drop policy if exists "Users read own MKHANDI trade evidence" on storage.objects;
create policy "Users read own MKHANDI trade evidence" on storage.objects
for select to authenticated using (
  bucket_id='mkhandi-trade-evidence'
  and (storage.foldername(name))[1]=(select auth.uid()::text)
);
drop policy if exists "Users delete own MKHANDI trade evidence" on storage.objects;
create policy "Users delete own MKHANDI trade evidence" on storage.objects
for delete to authenticated using (
  bucket_id='mkhandi-trade-evidence'
  and (storage.foldername(name))[1]=(select auth.uid()::text)
);
