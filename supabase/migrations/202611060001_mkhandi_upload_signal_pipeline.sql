-- Unified upload-to-signal publication. Only strong, geometrically valid uploads
-- can enter the same authenticated signal feed as background Deep AI candidates.
create or replace function public.mkhandi_publish_uploaded_candidate(
  p_symbol text,
  p_market_name text,
  p_direction text,
  p_entry numeric,
  p_invalidation numeric,
  p_tp1 numeric,
  p_tp2 numeric,
  p_confidence numeric,
  p_rationale text,
  p_snapshot jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_candidate public.mkhandi_signal_candidates%rowtype;
  v_signal public.mkhandi_signals%rowtype;
  v_rr numeric;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_symbol),'') is null or nullif(trim(p_market_name),'') is null then
    raise exception 'A recognised market and Deriv symbol are required';
  end if;
  if p_direction not in ('BUY','SELL') then raise exception 'Only BUY or SELL uploads can be qualified'; end if;
  if p_entry is null or p_invalidation is null or p_tp1 is null or p_tp2 is null
     or p_entry <= 0 or p_invalidation <= 0 or p_tp1 <= 0 or p_tp2 <= 0 then
    raise exception 'Entry, invalidation, TP1 and TP2 must all be valid positive prices';
  end if;
  if p_confidence is null or p_confidence < 65 or p_confidence > 100 then
    raise exception 'Upload confidence must be at least 65%';
  end if;
  if p_direction = 'BUY' and not (p_invalidation < p_entry and p_tp1 > p_entry and p_tp2 >= p_tp1) then
    raise exception 'BUY price geometry is invalid';
  end if;
  if p_direction = 'SELL' and not (p_invalidation > p_entry and p_tp1 < p_entry and p_tp2 <= p_tp1) then
    raise exception 'SELL price geometry is invalid';
  end if;
  v_rr := abs(p_tp2-p_entry)/nullif(abs(p_entry-p_invalidation),0);
  if v_rr is null or v_rr < 1.5 then raise exception 'Upload TP2 reward/risk must be at least 1.5R'; end if;

  -- Never create a second active signal for the same asset. Reuse an existing
  -- same-direction signal; require the existing lifecycle to close before reversal.
  select * into v_signal
  from public.mkhandi_signals
  where user_id=v_user and symbol=p_symbol and status='ACTIVE'
    and direction in ('BUY','SELL')
  order by created_at desc limit 1 for update;
  if found then
    if v_signal.direction <> p_direction then
      raise exception 'An active % signal already exists for this asset; close or invalidate it before publishing the opposite direction', v_signal.direction;
    end if;
    return jsonb_build_object('published',true,'reused',true,'candidate_id',null,'signal_id',v_signal.id,'direction',v_signal.direction,'risk_reward',v_rr);
  end if;

  insert into public.mkhandi_signal_candidates(
    user_id,symbol,market_name,direction,status,technical_snapshot,ai_result,
    wait_reason,last_seen_at,last_ai_at,next_ai_at
  ) values (
    v_user,p_symbol,p_market_name,p_direction,'AUTHENTICATED',
    coalesce(p_snapshot,'{}'::jsonb),
    jsonb_build_object('authenticated',true,'confidence',p_confidence,'entry',p_entry,
      'invalidation',p_invalidation,'tp1',p_tp1,'tp2',p_tp2,'risk_reward',v_rr,
      'rationale',coalesce(p_rationale,''),'source','UPLOAD_SCAN'),
    'Authenticated from a chart upload after independent risk and geometry gates.',
    now(),now(),null
  ) returning * into v_candidate;

  insert into public.mkhandi_signals(
    user_id,source_id,symbol,market_name,direction,status,entry,invalidation,tp1,tp2,
    confidence,rationale,technical_snapshot,authenticated_at,updated_at
  ) values (
    v_user,'UP:'||v_candidate.id::text,p_symbol,p_market_name,p_direction,'ACTIVE',
    p_entry,p_invalidation,p_tp1,p_tp2,p_confidence,
    left(coalesce(p_rationale,''),1200),coalesce(p_snapshot,'{}'::jsonb),now(),now()
  ) returning * into v_signal;

  update public.mkhandi_signal_candidates
  set published_signal_id=v_signal.id,updated_at=now()
  where id=v_candidate.id;

  insert into public.mkhandi_signal_events(signal_id,user_id,event_type,price,details)
  values(v_signal.id,v_user,'AUTHENTICATED',p_entry,
    jsonb_build_object('source','UPLOAD_SCAN','risk_reward',round(v_rr,2),'confidence',p_confidence));

  return jsonb_build_object('published',true,'reused',false,'candidate_id',v_candidate.id,
    'signal_id',v_signal.id,'direction',p_direction,'risk_reward',round(v_rr,2));
end;
$$;

grant execute on function public.mkhandi_publish_uploaded_candidate(text,text,text,numeric,numeric,numeric,numeric,numeric,text,jsonb) to authenticated;

drop policy if exists "Users read own Deep AI authenticated directional signals" on public.mkhandi_signals;
create policy "Users read own Deep AI authenticated directional signals"
on public.mkhandi_signals for select to authenticated
using (
  auth.uid() = user_id
  and (source_id like 'BG:%' or source_id like 'UP:%')
  and direction in ('BUY','SELL')
  and status in ('ACTIVE','TP2_REACHED','INVALIDATED','CANCELLED')
  and authenticated_at is not null
  and exists (
    select 1 from public.mkhandi_signal_candidates c
    where c.id::text = substring(mkhandi_signals.source_id from 4)
      and c.user_id = mkhandi_signals.user_id
      and c.published_signal_id = mkhandi_signals.id
      and c.ai_result ->> 'authenticated' = 'true'
      and c.status in ('AUTHENTICATED','CLOSED')
  )
);
comment on policy "Users read own Deep AI authenticated directional signals" on public.mkhandi_signals
is 'Market Feed exposes only authenticated BUY/SELL signals from background scans (BG) or validated uploads (UP). WAIT candidates remain private.';
