# MKHANDI AI SCAN — Background AI Signal Lifecycle

## Background AI behaviour
- Internal technical qualification is scheduled at 30-minute intervals by default, with a 60-minute option.
- A candidate is authenticated by the server-side AI Deep Scan before publication.
- While a signal is published and active, live market prices continue to be observed, but the internal technical engine and AI qualification are not rerun for that asset.
- The published signal remains locked until live price reaches TP2 or breaches its invalidation level.
- After completion or invalidation, the normal qualification cadence resumes.

## Watchlist and review
- Watchlist capacity: 10 assets.
- Available assets continue to come from the existing market catalogue.
- Signal History uses one outcome review selector and a single SAVE REVIEW action. The positive outcome combines Won / TP2 reached.
- The scanner is for analysis and journaling only; it does not place trades.

## Suggested holding horizons
These are discretionary horizons, not time-based exit rules: M5 scalp 5–30 minutes; M15 intraday 30 minutes–4 hours; H1 intraday 1–8 hours; H4 swing 4 hours to multiple sessions. Exit earlier when invalidation or risk limits are reached.

## Deployment
This is the browser/PWA implementation. The native iOS prototype does not yet have live Deriv streaming or this background signal lifecycle. The Vercel API requires OPENAI_API_KEY configured server-side.


## Android application — version 1.5.0
- Package: `com.mkhandi.aiscan`; minimum Android 6.0 (API 23).
- Version code 6 / version name 1.5.0.
- Uses the live MKHANDI web application, so web scanner and account features are shared.
- Improved reconnect recovery: when the app returns to the foreground after a network interruption, it checks connectivity and reloads the scanner if the offline panel is showing.
- Updated Android user-agent and in-app version label.
- GitHub Actions builds a version-labelled debug APK artifact. A signed release APK still requires release signing configuration.
- Important: background AI monitoring is not guaranteed while Android suspends or closes the WebView. The scanner must remain active in the foreground for browser-based Deriv streaming and scheduled work.
