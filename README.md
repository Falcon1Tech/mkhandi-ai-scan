# MKHANDI AI SCAN

## Implemented in this branch

- Deriv catalogue now includes the additional Boom/Crash, Volatility Boom/Crash, Snap and Ladder Volatility markets shown in the supplied screenshots. Entries without hard-coded Deriv codes resolve against the live `active_symbols` response by exact display name/alias.
- Supabase schema for per-account watchlists, shared signal history, lifecycle events, push-device metadata, per-user scan cadence and scanner health.
- Supabase Edge Function `mkhandi-background-scanner`: server-side Deriv OHLC retrieval, technical candidate screening, independent OpenAI qualification, persisted signal publication, server-owned TP2/invalidation monitoring and OneSignal notification dispatch.
- Supabase Cron SQL to invoke the worker once per minute. The worker respects each account's 30/60-minute AI qualification interval while monitoring active signal lifecycle each minute.
- Web OneSignal v16 SDK bootstrap, account identity linking via Supabase user ID, notification permission action and service worker files.
- Android native OneSignal SDK integration, external user identity bridge and notification permission action.
- Connection Health view reads server-side Deriv quote, scan and AI health records.
- Existing browser signal history is imported into the central account ledger on sign-in; cloud signal rows are refreshed and subscribed to realtime changes.

## Required configuration before activation

The source code is prepared, but the worker cannot run until the existing Supabase project and OneSignal application are configured. Never commit service-role or OneSignal REST API secrets.

### 1. Supabase database

Run the migration in the Supabase SQL Editor:

`supabase/migrations/202610310001_mkhandi_central_signals.sql`

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

The worker runs once per minute to monitor active signals. New AI qualification is limited to the 30- or 60-minute interval saved in each account's watchlist.

### 4. OneSignal application

Create/use a OneSignal app with both Web Push and Android platforms configured.

- Add `ONESIGNAL_APP_ID` to Vercel Production, Preview and Development environment variables. This is the public application ID, not the REST API key.
- Add GitHub Actions repository secret `ONESIGNAL_APP_ID` so the Android 1.6.0 build can compile the native SDK with the same app ID.
- Add `ONESIGNAL_REST_API_KEY` only to Supabase Edge Function secrets. Never add it to Vercel public variables or GitHub source.

For Android, configure the OneSignal Android platform with the Firebase Cloud Messaging credentials required by OneSignal. The app ID alone is not sufficient for delivery until the platform is configured in OneSignal.

### 5. Test before production use

1. Confirm the database migration and RLS policies.
2. Deploy the Edge Function and verify its authenticated worker endpoint.
3. Run one manual worker invocation, then enable Cron.
4. Confirm Deriv quote timestamps and AI status in Connection Health.
5. Confirm a test BUY/SELL notification reaches a web subscriber and an Android subscriber.
6. Verify TP2 and invalidation events update the same signal record across devices.
7. Test duplicate prevention, worker restarts, Deriv disconnects, AI timeouts and OneSignal delivery failures.

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
