-- Only server-authenticated Deep AI signals may be visible in the canonical Market Feed.
-- Client-side direct signal imports are disabled; the service-role background worker publishes.
drop policy if exists "Users import own local signals" on public.mkhandi_signals;
drop policy if exists "Users read own signals" on public.mkhandi_signals;

revoke insert on public.mkhandi_signals from anon, authenticated;

create policy "Users read own Deep AI authenticated signals"
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
      and c.status = 'AUTHENTICATED'
      and c.published_signal_id = mkhandi_signals.id
      and c.ai_result ->> 'authenticated' = 'true'
  )
);

comment on policy "Users read own Deep AI authenticated signals" on public.mkhandi_signals
is 'Only show a signal after its matching candidate has a recorded successful Deep AI authentication.';
