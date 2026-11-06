-- Restrict upload publication RPC to authenticated sessions only.
revoke all on function public.mkhandi_publish_uploaded_candidate(
  text,text,text,numeric,numeric,numeric,numeric,numeric,text,jsonb
) from public, anon;
grant execute on function public.mkhandi_publish_uploaded_candidate(
  text,text,text,numeric,numeric,numeric,numeric,numeric,text,jsonb
) to authenticated;
