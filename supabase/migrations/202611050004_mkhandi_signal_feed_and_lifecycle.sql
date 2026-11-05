-- Expose only Deep-AI-authenticated directional signals in Market Feed.
-- WAIT candidates remain visible through the user's private candidate rows only.
alter table public.mkhandi_signals
  add column if not exists entry_reached_at timestamptz,
  add column if not exists tp1_reached_at timestamptz;

alter table public.mkhandi_signal_events
  drop constraint if exists mkhandi_signal_events_event_type_check;
alter table public.mkhandi_signal_events
  add constraint mkhandi_signal_events_event_type_check
  check (event_type = any (array[
    'AUTHENTICATED'::text,'ENTRY_REACHED'::text,'TP1_REACHED'::text,
    'TP2_REACHED'::text,'INVALIDATED'::text,'REVIEWED'::text
  ]));

create unique index if not exists mkhandi_signal_events_once_per_type
  on public.mkhandi_signal_events(signal_id,event_type);

drop policy if exists "Users read own Deep AI reviewed signals" on public.mkhandi_signals;
drop policy if exists "Users read own Deep AI authenticated signals" on public.mkhandi_signals;

create policy "Users read own Deep AI authenticated directional signals"
on public.mkhandi_signals
for select
to authenticated
using (
  auth.uid() = user_id
  and source_id like 'BG:%'
  and direction in ('BUY','SELL')
  and status in ('ACTIVE','TP2_REACHED','INVALIDATED','CANCELLED')
  and authenticated_at is not null
  and exists (
    select 1
    from public.mkhandi_signal_candidates c
    where c.id::text = substring(mkhandi_signals.source_id from 4)
      and c.user_id = mkhandi_signals.user_id
      and c.published_signal_id = mkhandi_signals.id
      and c.ai_result ->> 'authenticated' = 'true'
      and c.status in ('AUTHENTICATED','CLOSED')
  )
);

comment on policy "Users read own Deep AI authenticated directional signals" on public.mkhandi_signals
is 'Market Feed and signal history expose only AI-authenticated BUY/SELL signals. WAIT candidates remain available through the private candidate table.';
