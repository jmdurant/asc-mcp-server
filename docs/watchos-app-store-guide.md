# watchOS App Store Upload Guide: Three Approaches

A practical guide based on shipping three real apps to TestFlight, covering the three common patterns for watchOS app distribution.

---

## Overview

Apple requires watchOS apps to be embedded inside an iOS app for App Store distribution. Even "standalone" watchOS apps need an iOS wrapper. How you build that wrapper depends on your project architecture.

| App | Pattern | iOS App | watchOS App | Build System |
|-----|---------|---------|-------------|-------------|
| **Slingshot** | Full companion | Full-featured iOS + watchOS | Shared codebase | xcodegen + SPM |
| **XMWatch** | Standalone + stub | Minimal iOS stub (`Text("")`) | Independent watchOS app | xcodegen + SPM |
| **SameDayTrips** | Flutter + native watch | Flutter iOS app | Native Swift watchOS app | CocoaPods + SPM |

---

## Pattern 1: Full Companion App (Slingshot)

**When to use:** Your iOS and watchOS apps share significant code and both have real functionality.

### Architecture

```
Slingshot.xcodeproj (single project, multiple targets)
├── Slingshot-iOS          (full iOS app)
├── Slingshot-watchOS      (companion watchOS app)
├── SlingshotLiveActivity  (iOS Live Activity extension)
├── SlingshotWidgetExtension (watchOS widget)
├── Slingshot-macOS        (macOS Catalyst)
├── Slingshot-tvOS         (tvOS)
└── Slingshot-visionOS     (visionOS)
```

### How It Works

- **Single Xcode project** with all platform targets
- watchOS target is a **dependency** of the iOS target in `project.yml`:
  ```yaml
  Slingshot-iOS:
    dependencies:
      - target: Slingshot-watchOS
  ```
- Xcode automatically generates an "Embed Watch Content" build phase
- **Shared/ directory** contains all platform-agnostic code (API clients, models, repositories)
- Platform targets **exclude** files they don't need via `project.yml` excludes
- watchOS has `SKIP_INSTALL: YES` — it installs only via the iOS bundle

### Bundle IDs

```
iOS:     com.doctordurant.slingshotplayer
watchOS: com.doctordurant.slingshotplayer.watchos
Widget:  com.doctordurant.slingshotplayer.watchos.widget
```

watchOS Info.plist must set:
```xml
<key>WKCompanionAppBundleIdentifier</key>
<string>$(IOS_BUNDLE_IDENTIFIER)</string>
```

### Version Management

- All targets share `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` via `Config.xcconfig`
- Versions **must match** between iOS and watchOS — Apple rejects mismatches

### Archive & Upload

```bash
# Archive the iOS scheme — watchOS builds automatically as a dependency
xcodebuild archive \
  -project Slingshot.xcodeproj \
  -scheme Slingshot-iOS \
  -destination 'generic/platform=iOS' \
  -archivePath /tmp/slingshot.xcarchive

# Or use the MCP tool:
deploy_to_testflight(
  projectPath: "Slingshot.xcodeproj",
  scheme: "Slingshot-iOS"
)
```

### Gotchas

- **Widget display name required:** Apple rejects if watchOS widget extension is missing `CFBundleDisplayName` in Info.plist. If using `GENERATE_INFOPLIST_FILE`, add `INFOPLIST_KEY_CFBundleDisplayName` to build settings.
- **Version sync is critical:** `CFBundleShortVersionString` and `CFBundleVersion` must match across iOS, watchOS, and all extensions. Use a shared xcconfig.
- **File exclusions grow:** watchOS can't use many iOS-specific APIs (Metal, complex UI). Maintain careful exclude lists in project.yml.

---

## Pattern 2: Standalone watchOS App + iOS Stub (XMWatch)

**When to use:** The watchOS app is the primary product. iOS is just a delivery wrapper for the App Store.

### Architecture

```
XMWatch/
├── XMWatch-watchOS/           (main project — builds everything)
│   ├── project.yml            (xcodegen: 3 targets)
│   ├── XMWatchApp.swift       (real watchOS app)
│   ├── Features/              (full UI)
│   ├── Services/              (streaming, auth)
│   ├── Player/                (audio playback)
│   ├── XMWatchWidget/         (widget extension)
│   └── Stub/                  (minimal iOS wrapper)
│       └── StubApp.swift      (literally just `Text("")`)
│
├── XMWatch-iOS/               (separate standalone iOS app — NOT used for watchOS upload)
│   ├── project.yml
│   └── (full iOS implementation)
│
└── StarPlayrRadioKit/         (shared SPM package)
```

### How It Works

- **watchOS project contains 3 targets:**
  1. `XMWatch-Stub` — minimal iOS app (empty UI)
  2. `XMWatch-watchOS` — the real watchOS app
  3. `XMWatchWidgetExtension` — watchOS widget

- The stub's **only purpose** is satisfying Apple's requirement that watchOS apps ship inside an iOS app
- Stub has an "Embed Watch Content" build phase that copies the watchOS .app into the iOS bundle
- `XMWatch-iOS` is a **completely separate, independent** iOS app — it's NOT the stub

### The iOS Stub

```swift
// Stub/StubApp.swift — this is the entire iOS app
import SwiftUI

@main
struct StubApp: App {
    var body: some Scene {
        WindowGroup {
            Text("")
        }
    }
}
```

### Bundle IDs

```
iOS Stub:  com.doctordurant.xmwatch        (same ID as standalone iOS app)
watchOS:   com.doctordurant.xmwatch.watchos
Widget:    com.doctordurant.xmwatch.watchos.widget
```

### Version Management

All three targets in `project.yml` share the same version:
```yaml
settings:
  MARKETING_VERSION: 1.0.0
  CURRENT_PROJECT_VERSION: 2
```

### Archive & Upload

```bash
# Archive the STUB scheme from the watchOS project
xcodebuild archive \
  -project XMWatch-watchOS/XMWatch-watchOS.xcodeproj \
  -scheme XMWatch-Stub \
  -destination 'generic/platform=iOS' \
  -archivePath /tmp/xmwatch.xcarchive

# Or use the MCP tool:
deploy_to_testflight(
  projectPath: "XMWatch-watchOS/XMWatch-watchOS.xcodeproj",
  scheme: "XMWatch-Stub"
)
```

**Important:** Archive `XMWatch-Stub`, NOT `XMWatch-watchOS`. The stub is the iOS container that Xcode submits.

### Gotchas

- **Don't confuse stub with standalone iOS app.** XMWatch-iOS is a full app; the stub in XMWatch-watchOS/Stub/ is just a wrapper. They can share the same bundle ID for App Store purposes.
- **Stub must have app icons.** Even though users never see the stub's icon, App Store validation requires a complete icon set.
- **watchOS SKIP_INSTALL must be YES.** Otherwise Xcode tries to install the watchOS target independently and the archive fails.
- **Version sync across all 3 targets.** Stub, watchOS, and widget must all match — put versions in a shared xcconfig or at the project level in project.yml.

---

## Pattern 3: Flutter iOS + Native watchOS (SameDayTrips)

**When to use:** Your iOS app is Flutter but you need a native watchOS companion (Flutter doesn't support watchOS).

### Architecture

```
SameDayClt/
├── same_day_trips_app/            (Flutter project)
│   ├── lib/                       (Dart code)
│   │   └── services/
│   │       └── watch_tool_service.dart  (Flutter ↔ native bridge)
│   ├── ios/
│   │   ├── Runner.xcodeproj       (references watchOS project)
│   │   ├── Runner.xcworkspace     (Runner + Pods)
│   │   └── Runner/
│   │       ├── WatchSessionManager.swift  (WCSession delegate)
│   │       └── Info.plist
│   └── pubspec.yaml
│
└── SameDayTripsWatch/             (native Swift watchOS project)
    ├── SameDayTripsWatch.xcodeproj
    ├── project.yml                (xcodegen)
    ├── SameDayTripsWatch/
    │   ├── Core/
    │   │   ├── GeminiLiveController.swift
    │   │   ├── WatchConnectivityManager.swift  (WCSession)
    │   │   └── ...
    │   └── Tools/                 (55+ tool implementations)
    ├── TripAssistantWidget/       (watchOS widget)
    └── patches/
        └── firebase-watchos-live-api.patch
```

### How It Works

1. **Cross-project reference:** Runner.xcodeproj contains a reference to `../../SameDayTripsWatch/SameDayTripsWatch.xcodeproj`
2. **"Embed Watch Content" build phase** in the Runner target copies `SameDayTripsWatch.app` into the iOS bundle
3. **Runner depends on SameDayTripsWatch** target — building Runner automatically builds the watchOS app
4. **watch_connectivity** enables bidirectional communication:
   - iOS (Swift `WatchSessionManager`) ↔ watchOS (Swift `WatchConnectivityManager`)
   - iOS (Swift) ↔ Flutter (Dart) via `MethodChannel`

### Watch Connectivity Data Flow

```
watchOS App
  → WatchConnectivityManager.sendMessage()
  → WCSession
  → iOS WatchSessionManager.session(_:didReceiveMessage:)
  → MethodChannel('com.samedaytrips/watch_tools')
  → Flutter WatchToolService
  → CalendarService / ReminderService (iOS EventKit via Dart)
  → Result flows back up the chain
```

**Tools are classified:**
- **iPhone-only** (calendar writes, reminders, messages) — routed to Flutter
- **Watch-local** (music, health, HomeKit) — executed directly on watchOS
- **iPhone-preferred** (voice notes) — tries iPhone first, falls back to watch

### Bundle IDs

```
Flutter iOS:  com.doctordurant.tripassistant
watchOS:      com.doctordurant.tripassistant.watchkitapp
Widget:       com.doctordurant.tripassistant.watchkitapp.TripAssistantWidget
```

### Version Management

**Separate version systems — must be manually synced:**
- Flutter: `pubspec.yaml` → `version: 1.0.0+1`
- watchOS: `Info.plist` → `CFBundleShortVersionString: 1.0.0`, `CFBundleVersion: 1`
- Widget: `TripAssistantWidget/Info.plist` → must match watchOS

### Archive & Upload

**Must use `-workspace` not `-project`** because CocoaPods dependencies require the workspace:

```bash
# Apply Firebase patch first!
cd ~/Library/Developer/Xcode/DerivedData/Runner-*/SourcePackages/checkouts/firebase-ios-sdk
git apply /path/to/patches/firebase-watchos-live-api.patch

# Archive using workspace
xcodebuild archive \
  -workspace Runner.xcworkspace \
  -scheme Runner \
  -destination 'generic/platform=iOS' \
  -archivePath /tmp/samedaytrips.xcarchive

# Or use the MCP tool:
deploy_to_testflight(
  projectPath: "same_day_trips_app/ios/Runner.xcworkspace",
  scheme: "Runner"
)
```

### Firebase SDK Patch (CRITICAL)

Google marks the Gemini Live API as `@available(watchOS, unavailable)` — but it works fine at runtime on watchOS. A patch removes these compile-time restrictions from 31 files.

**Must re-apply whenever:**
- SPM re-resolves packages (clean build, version bump, new machine)
- DerivedData is cleared
- Xcode re-downloads packages

The patch lives at `SameDayTripsWatch/patches/firebase-watchos-live-api.patch` and must be applied to the Firebase checkout in DerivedData:

```bash
# Find the checkout location
find ~/Library/Developer/Xcode/DerivedData -path '*Runner*checkouts/firebase-ios-sdk' -type d

# Apply
cd <path-from-above>
git apply /path/to/patches/firebase-watchos-live-api.patch

# If patch fails due to version drift, brute-force strip:
find FirebaseAI -name '*.swift' -exec sed -i '' '/@available(watchOS, unavailable)/d' {} \;
```

### Gotchas

- **Must use `-workspace`** for archiving — `-project` won't resolve CocoaPods dependencies and the build will fail with "Unable to find module dependency: 'GoogleMaps'"
- **Firebase patch is fragile.** Any SDK version change can invalidate the patch. Keep `sed` fallback ready.
- **Cross-project reference creates implicit dependencies.** Even with `buildImplicitDependencies = YES` in the scheme, Xcode discovers and builds the watchOS target. This is desired but means the watch project must compile cleanly.
- **Two package managers coexist.** iOS uses CocoaPods (Flutter plugins); watchOS uses SPM (Firebase). They don't conflict but live in separate resolution contexts.
- **Privacy strings cascade.** The watchOS app may link frameworks (HomeKit, Speech, Bluetooth) that require usage description strings in the **iOS** app's Info.plist — even if the iOS app doesn't directly use those frameworks.
- **Version sync is manual.** No shared config between pubspec.yaml and watchOS Info.plist. Must update both when bumping versions.
- **Watch entitlements need care.** Not all entitlements are provisionable. `com.apple.developer.extended-runtime-session` and `com.apple.developer.playable-content` are NOT valid entitlement keys — they cause "not found and could not be included in profile" errors. Extended runtime works via the `WKExtendedRuntimeSession` API without an entitlement.

---

## Common Requirements (All Patterns)

### App Icons

watchOS requires a **complete** icon set in `AppIcon.appiconset/Contents.json`:

| Role | Size | Scale | Pixels |
|------|------|-------|--------|
| Notification 38mm | 24x24 | 2x | 48x48 |
| Notification 42mm | 27.5x27.5 | 2x | 55x55 |
| Companion Settings | 29x29 | 2x | 58x58 |
| Companion Settings | 29x29 | 3x | 87x87 |
| App Launcher 38mm | 40x40 | 2x | 80x80 |
| App Launcher 40mm | 44x44 | 2x | 88x88 |
| App Launcher 41mm | 46x46 | 2x | 92x92 |
| App Launcher 44mm | 50x50 | 2x | 100x100 |
| App Launcher 45mm | 51x51 | 2x | 102x102 |
| App Launcher 49mm | 54x54 | 2x | 108x108 |
| Short Look 38mm | 86x86 | 2x | 172x172 |
| Short Look 42mm | 98x98 | 2x | 196x196 |
| Short Look 44mm | 108x108 | 2x | 216x216 |
| App Store | 1024x1024 | 1x | 1024x1024 |

Apple rejects uploads missing **any** of these.

### Privacy Usage Strings

The **iOS** app's Info.plist must include usage descriptions for any framework the watchOS app links — even if the iOS app doesn't use them directly:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<key>NSSpeechRecognitionUsageDescription</key>
<key>NSHomeKitUsageDescription</key>
<key>NSMicrophoneUsageDescription</key>
<key>NSHealthShareUsageDescription</key>
<!-- etc. -->
```

### Export Compliance

Both iOS and watchOS Info.plist files should include:
```xml
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```
This skips the export compliance questionnaire on every upload.

### Version Matching

Apple enforces:
- `CFBundleShortVersionString` must match between iOS container and embedded watchOS app
- `CFBundleVersion` must be **higher** than any previously uploaded build
- Widget extensions should match the host app's versions

### Build Number Auto-Increment

The ASC MCP server's `deploy_to_testflight` tool automatically increments `CURRENT_PROJECT_VERSION` if it conflicts with an existing upload. For Flutter projects, it also sets `FLUTTER_BUILD_NUMBER`.

---

## MCP Tool Usage

### Full Deploy (Recommended)

```
deploy_to_testflight(
  projectPath: "/path/to/.xcodeproj or .xcworkspace",
  scheme: "SchemeToArchive",
  platformType: "ios",
  contactPhone: "+18005551234",
  testers: [{ email: "test@example.com", firstName: "Test", lastName: "User" }]
)
```

This runs the entire pipeline: preflight → archive → upload → beta info → groups → review.

### Individual Steps

```
preflight(bundleId: "com.example.app", projectPath: "/path/to/.xcodeproj")
upload_build(projectPath: "...", scheme: "...")
update_beta_app_info(appId: "...", description: "...", contactPhone: "...")
create_beta_group(name: "Internal Testers", appId: "...", isInternalGroup: true)
submit_for_review(buildId: "...", appId: "...")
```

---

## Quick Reference: Which Scheme to Archive?

| App | Archive Scheme | Project/Workspace | Contains |
|-----|---------------|-------------------|----------|
| Slingshot | `Slingshot-iOS` | `Slingshot.xcodeproj` | iOS + embedded watchOS |
| XMWatch | `XMWatch-Stub` | `XMWatch-watchOS.xcodeproj` | Stub + embedded watchOS |
| SameDayTrips | `Runner` | `Runner.xcworkspace` | Flutter iOS + embedded watchOS |

**Rule:** Always archive the **iOS** scheme/target. The watchOS app is embedded automatically as a dependency.
