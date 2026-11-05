-- A Deep-AI-reviewed WAIT candidate is a public WAITING signal.
-- When the same candidate later passes AI, its existing signal row is promoted to ACTIVE.
alter table public.mkhandi_signals
  alter column entry drop not null,
  alter column invalidation drop not null,
  alter column tp2 drop not null,
  alter column confidence drop not null,
  alter column authenticated_at drop not null;

alter table public.mkhandi_signals
  drop constraint if exists mkhandi_signals_direction_check,
  drop constraint if exists mkhandi_signals_status_check,
  drop constraint if exists mkhandi_signals_wait_shape_check;

alter table public.mkhandi_signals
  add constraint mkhandi_signals_direction_check
    check (direction = any (array['BUY'::text, 'SELL'::text, 'WAIT'::text])),
  add constraint mkhandi_signals_status_check
    check (status = any (array['ACTIVE'::text, 'WAITING'::text, 'TP2_REACHED'::text, 'INVALIDATED'::text, 'CANCELLED'::text])),
  add constraint mkhandi_signals_wait_shape_check
    check (
      (direction = 'WAIT' and status = 'WAITING'
        and entry is null and invalidation is null and tp1 is null and tp2 is null)
      or
      (direction in ('BUY','SELL') and status in ('ACTIVE','TP2_REACHED','INVALIDATED','CANCELLED')
        and entry is not null and invalidation is not null and tp2 is not null)
    );

drop policy if exists "Users read own Deep AI authenticated signals" on public.mkhandi_signals;

create policy "Users read own Deep AI reviewed signals"
on public.mkhandi_signals
for select
to authenticated
using (
  auth.uid() = user_id
  and source_id like 'BG:%'
  and exists (
    select 1
    from public.mkhandi_signal_candidates c
    where c.id::text = substring(mkhandi_signals.source_id from 4)
      and c.user_id = mkhandi_signals.user_id
      and c.published_signal_id = mkhandi_signals.id
      and c.ai_result ? 'authenticated'
      and (
        (
          mkhandi_signals.direction = 'WAIT'
          and mkhandi_signals.status = 'WAITING'
          and c.ai_result ->> 'authenticated' = 'false'
          and c.status in ('WAITING','AI_QUALIFYING','AI_REJECTED')
        )
        or
        (
          mkhandi_signals.direction in ('BUY','SELL')
          and mkhandi_signals.status in ('ACTIVE','TP2_REACHED','INVALIDATED','CANCELLED')
          and c.ai_result ->> 'authenticated' = 'true'
          and c.status in ('AUTHENTICATED','CLOSED')
        )
      )
  )
);

comment on policy "Users read own Deep AI reviewed signals" on public.mkhandi_signals
is 'Only expose AI-reviewed WAITING signals or AI-authenticated active/closed signals linked to their matching candidate.';
