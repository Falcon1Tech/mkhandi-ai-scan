-- Run after the Edge Function is deployed and the two values are stored in Supabase Vault.
-- Replace the URL and secret values with your actual project/function URL and a long random secret.
-- select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/mkhandi-background-scanner','mkhandi_worker_url');
-- select vault.create_secret('GENERATE_A_LONG_RANDOM_SECRET','mkhandi_worker_secret');
select cron.unschedule(jobid) from cron.job where jobname='mkhandi-background-scanner-minute';
select cron.schedule(
  'mkhandi-background-scanner-minute',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='mkhandi_worker_url' limit 1),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-mkhandi-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='mkhandi_worker_secret' limit 1)
    ),
    body := jsonb_build_object('source','supabase-cron','requested_at',now())
  );
  $job$
);
