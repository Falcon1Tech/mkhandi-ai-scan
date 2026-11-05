# MKHANDI AI SCAN

## Implemented in this branch

- Deriv catalogue now includes the additional Boom/Crash, Volatility Boom/Crash, Snap and Ladder Volatility markets shown in the supplied screenshots. Entries without hard-coded Deriv codes resolve against the live `active_symbols` response by exact display name/alias.
- Supabase schema for per-account watchlists, shared signal history, lifecycle events, push-device metadata, per-user scan cadence and scanner health.
- Supabase Edge Function `mkhandi-background-scanner`: server-side Deriv symbol resolution and OHLC retrieval, persistent per-market WAIT candidates, independent OpenAI Deep AI qualification, authenticated signal publication, server-owned TP2/invalidation monitoring and OneSignal notification dispatch.
- The background worker updates the same candidate record while a setup is waiting. When its H1/M15 direction and trigger become valid, it reruns Deep AI, promotes that candidate to one authenticated signal, and sends the OneSignal message: “The signal you were waiting for is now valid.”
- Market Feed, Watchlist signals, Sentiment and the Signals view show BUY/SELL only when the server candidate links to an ACTIVE, background-AI-authenticated signal. Browser technical candidates remain WAIT and private.
- Supabase Cron SQL to invoke the worker once per minute. The worker respects each account's 30/60-minute AI qualification interval while monitoring active signal lifecycle each minute.
- Web OneSignal v16 SDK bootstrap, account identity linking via Supabase user ID, notification permission action and service worker files.
- Android native OneSignal SDK integration, external user identity bridge and notification permission action.
- Connection Health view reads server-side Deriv quote, scan and AI health records.
- Existing browser signal history is imported into the central account ledger on sign-in; cloud signal rows are refreshed and subscribed to realtime changes.

## Default watchlist

The platform default is exactly ten markets, in this order:

1. Boom 1000 Index
2. Boom 500 Index
3. Crash 1000 Index
4. Crash 900 Index
5. Crash 600 Index
6. Crash 300 Index
7. Boom 300 Index
8. Boom 600 Index
9. Boom 900 Index
10. Step Index

The first app load after this release migrates the browser's saved default list to this set. Later deliberate watchlist edits remain saved.

## Required configuration before activation

The source code is prepared, but the worker cannot run until the existing Supabase project and OneSignal application are configured. Never commit service-role or OneSignal REST API secrets.

### 1. Supabase database

Run the migration in the Supabase SQL Editor:

`supabase/migrations/202610310001_mkhandi_central_signals.sql` and then `supabase/migrations/202611050001_mkhandi_background_ai_lifecycle.sql`

This creates the account-owned tables and RLS policies. It also enables `pg_cron` and `pg_net`, but deliberately does not schedule a worker until secrets are set.

### 2. Supabase Edge Function

Deploy `supabase/functions/mkhandi-background-scanner/index.ts` to the existing project:

```bash
supabase functions deploy mkhandi-background-scanner
supabase secrets set OPENAI_API_KEY=<server-side OpenAI key>
supabase secrets set ONESIGNAL_APP_ID=<OneSignal App ID>
supabase secrets set ONESIGNAL_REST_API_KEY=<OneSignal REST API key>
supabase secrets set MKHANDI_WORKER_SECRET=<long random secret>
```

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to deployed Edge Functions. Do not put either in browser code.

### 3. Enable the scheduled worker

In Supabase SQL Editor, first store the function URL and the same worker secret in Vault. Then run `supabase/enable-background-scanner-cron.sql`.

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/mkhandi-background-scanner','mkhandi_worker_url');
select vault.create_secret('<same-long-random-secret>','mkhandi_worker_secret');
```

The worker runs once per minute to monitor prices, refresh WAIT candidates, and detect newly valid setups. Deep AI qualification respects the account's 30- or 60-minute interval, but a newly aligned/strengthened waiting setup can trigger an immediate background Deep AI recheck.

### 4. OneSignal application

Create/use a OneSignal app with both Web Push and Android platforms configured.

- Add `ONESIGNAL_APP_ID` to Vercel Production, Preview and Development environment variables. This is the public application ID, not the REST API key.
- Add GitHub Actions repository secret `ONESIGNAL_APP_ID` so the Android 1.6.0 build can compile the native SDK with the same app ID.
- Add `ONESIGNAL_REST_API_KEY` only to Supabase Edge Function secrets. Never add it to Vercel public variables or GitHub source.

For Android, configure the OneSignal Android platform with the Firebase Cloud Messaging credentials required by OneSignal. The app ID alone is not sufficient for delivery until the platform is configured in OneSignal.

### 5. Test before production use

1. Apply both database migrations in order and confirm the candidate-table RLS policy.
2. Deploy the updated Edge Function and verify its authenticated worker endpoint.
3. Store the worker URL and secret in Supabase Vault, run the Cron SQL, and confirm the one-minute job is active.
4. Confirm all ten default markets resolve from Deriv `active_symbols` and receive quote timestamps in Connection Health.
5. Confirm candidate rows move through WAITING / AI_QUALIFYING / AI_REJECTED / AUTHENTICATED.
6. Confirm a WAIT candidate is promoted once, and the “signal you were waiting for” push reaches web and Android subscribers.
7. Verify TP2 and invalidation events update the same signal record across devices.
8. Test duplicate prevention, worker restarts, Deriv disconnects, AI timeouts and OneSignal delivery failures.

## Android application — version 1.6.0

- Package: `com.mkhandi.aiscan`; minimum Android 6.0 (API 23).
- Version code 7 / version name 1.6.0.
- Native OneSignal Android SDK 5.9.2 and account identity bridge.
- Uses the live web platform for shared scanner interface and central account history.
- GitHub Actions produces a debug APK artifact. A signed Play Store/release APK still requires release signing configuration.

## Important architecture limits

- Server-side background monitoring is designed to run independently of the Android WebView once the Supabase Edge Function, Vault secrets and Cron schedule are deployed.
- The server worker currently uses a conservative EMA-cross plus candle-break technical candidate and independent AI validation. This is a first server-side qualification engine; it is not yet a byte-for-byte port of every browser MMS technical scoring rule.
- The screenshot market names resolve against Deriv's live symbol catalogue. Markets unavailable to the account/region will remain unresolved and should not be scanned.
- The iOS prototype remains a separate web wrapper and has not yet been given a native OneSignal iOS SDK integration.
- MKHANDI is an analysis/journaling system and does not place trades or guarantee outcomes.
