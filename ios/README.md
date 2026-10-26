# MKHANDI AI SCAN — Native iOS app

This is a native SwiftUI iPhone app, not a website wrapper. It includes a native dashboard, supported-asset list, AI Deep Scan workflow, native photo-library chart selection, and a result view with confidence, price levels, timeframe analysis, reasons, invalidation and warnings.

Target: iPhone 13, iOS 16 or later. Bundle ID: com.mkhandi.aiscan.ios.

Chart screenshots are submitted to the existing server-side endpoint https://mkhandi-ai-scan.vercel.app/api/scan. The OpenAI key remains server-side and is not embedded in the app.

Current scope: native UI and chart-upload analysis. Live Deriv WebSocket streaming, persistent scan history, push notifications and release signing are not yet implemented. The Watchlist screen does not claim to display live prices.

To build, open the ios folder in an Xcode iOS App project, set deployment target to iOS 16+, bundle ID to com.mkhandi.aiscan.ios, add ContentView.swift and MKHANDIAIScanApp.swift to the target, and set Info.plist as the app plist. Physical iPhone installation requires Apple development signing. TestFlight distribution requires Apple Developer Program and App Store Connect setup.
