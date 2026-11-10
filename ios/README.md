# MKHANDI AI SCAN — Native iOS preparation

## Current native-app scope

This is a native SwiftUI iPhone app, not a website wrapper. It currently provides:
- Native dashboard and supported-asset list
- AI Deep Scan with H1 and M15 screenshot selection and an optional third timeframe
- Submission to the existing server-side scan endpoint
- A native result view

The native app is **not yet feature-equivalent** to the web/Android product. Live Deriv streaming, authenticated Supabase accounts, shared signal history, watchlist synchronisation, push notifications/OneSignal and persistent journal data are not implemented in this native target. The Watchlist screen deliberately does not claim to show live prices. Do not treat this build as the finished production mobile app.

## Build settings

- iPhone target, iOS 16.0+
- Bundle ID: `com.mkhandi.aiscan.ios`
- Display name: `MKHANDI AI SCAN`
- Xcode project generated from `project.yml` using XcodeGen
- Automatic code signing is enabled so Xcode can use a free Apple Account Personal Team for local development

## Install privately on an iPhone using a free Apple Account

A Mac with Xcode is required for Apple's device signing and installation. A 2020 M1 MacBook Air is supported by current Xcode releases compatible with the installed macOS.

1. Install Xcode from the Mac App Store and open it once. Accept the licence and allow additional components to install.
2. In Xcode, open **Settings → Accounts**, click **+**, choose **Apple Account**, and sign in with the Apple Account to use for development. A paid Developer Program membership is not required for personal on-device testing.
3. Install XcodeGen in Terminal if it is not already installed:
   `brew install xcodegen`
4. In Terminal, from the repository root, run:
   `cd ios && xcodegen generate`
5. Open the generated project:
   `open MKHANDIAIScan.xcodeproj`
6. Connect the iPhone to the Mac by cable, unlock it, and tap **Trust** if prompted. Enable Developer Mode on the iPhone if iOS requests it.
7. In Xcode, select the **MKHANDIAIScan** project and app target → **Signing & Capabilities**. Enable **Automatically manage signing** and select the **Personal Team** for the Apple Account. Keep bundle ID `com.mkhandi.aiscan.ios`.
8. Select the connected iPhone as the run destination and press **Run**.
9. Repeat the signing/install process for the second iPhone. Both devices can use separate app logins once native authentication is implemented.

### Free-account limitations

- Free Personal Team provisioning is time-limited (typically 7 days), so the app may need to be rebuilt/reinstalled from Xcode when its provisioning expires.
- Free signing is for personal development/testing, not TestFlight or public distribution.
- A simulator build artifact from GitHub Actions cannot be installed directly on a physical iPhone.

## Security and backend

The OpenAI key remains server-side and is not embedded in the app. The native scan request uses `https://mkhandi-ai-scan.vercel.app/api/scan`. Verify the endpoint contract and test with non-sensitive chart screenshots before relying on scan results.
