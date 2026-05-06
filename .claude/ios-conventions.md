# iOS conventions (platform reference)

Conventions and patterns that are useful background when working on
**any** iOS project. Generic — doesn't assume anything about a specific
codebase. Project-specific architecture goes in the project's own
`docs/architecture/` directory.

Read this when:

- Onboarding to an iOS codebase
- Working on iOS code from a non-iOS repo (e.g., a web/Python project
  consuming an iOS-app-related artifact)
- Cross-referencing iOS patterns in cross-platform discussions

## Top-level shape (typical SwiftUI app)

```
MyApp/
  MyApp.xcodeproj/                     # the project
  MyApp.xcworkspace/                   # only if using SPM/CocoaPods
  MyApp/                               # source
    MyAppApp.swift                     # @main entry (SwiftUI lifecycle)
    AppDelegate.swift                  # for UIKit interop / Firebase init
    ContentView.swift                  # initial root view (often replaced)
    Assets.xcassets/                   # images, colors, app icon
    Info.plist                         # app-level config
    GoogleService-Info.plist           # if using Firebase
    Models/                            # data layer (Realm classes etc.)
    Views/                             # SwiftUI views
    Utils/                             # helpers, extensions
  MyAppTests/                          # unit tests
  MyAppUITests/                        # XCUITest UI tests
```

## App entry point

SwiftUI apps use `@main` on a struct conforming to `App`:

```swift
@main
struct MyAppApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
```

For Firebase / push notifications / other UIKit-era SDK setup, an
`@UIApplicationDelegateAdaptor` is the standard bridge:

```swift
@main
struct MyAppApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    var body: some Scene { … }
}
```

## Config files and what's in them

| File | Purpose | Tracked? |
|---|---|---|
| `*.xcodeproj/project.pbxproj` | Project structure, build settings, file references | ✅ |
| `*.xcworkspace/contents.xcworkspacedata` | Workspace structure (multi-project) | ✅ |
| `xcuserdata/` (anywhere) | Per-user Xcode UI state, breakpoints, schemes | ❌ gitignore |
| `*.xcuserstate` | Per-user file open state | ❌ gitignore |
| `Info.plist` | App-level config (bundle ID, version, capabilities) | ✅ |
| `*.entitlements` | App capabilities (push, app groups, etc.) | ✅ |
| `*.xcconfig` | Build setting overlay files | ✅ |
| `Package.swift` | SPM manifest | ✅ |
| `Package.resolved` | SPM lockfile | ✅ |
| `Podfile` / `Podfile.lock` | CocoaPods manifest + lockfile | ✅ |
| `GoogleService-Info.plist` | Firebase project config | ✅ (not secret) |
| `Assets.xcassets/Contents.json` | Asset catalog manifest | ✅ |
| `.DS_Store` | macOS finder noise | ❌ gitignore |

## Versioning

- **`MARKETING_VERSION`** (`CFBundleShortVersionString`) — public
  version like `5.0.10`. Increases on a meaningful release.
- **`CURRENT_PROJECT_VERSION`** (`CFBundleVersion`) — build number,
  monotonically increasing. Bump every TestFlight upload.
- Both live in `project.pbxproj` build settings, accessible via
  `xcodebuild -showBuildSettings`.

Tag format on `main` for releases: `vMAJOR.MINOR.PATCH-BUILD` (e.g.
`v5.0.10-110`). See `git-flow.md` (universal) for the convention.

## Common dependency managers (in order of modernness)

1. **Swift Package Manager (SPM)** — current default. Manifest is
   `Package.swift`. Lockfile is `Package.resolved` inside the
   workspace. No separate install step (Xcode resolves).
2. **CocoaPods** — pre-SPM. `Podfile` + `Podfile.lock`. `pod install`.
3. **Carthage** — rare now, mostly legacy.

## SwiftUI state ownership conventions

- **`@State`** — view-local mutable state, ephemeral.
- **`@StateObject`** — view *owns* this `ObservableObject`'s lifecycle.
  Use when the view creates the object.
- **`@ObservedObject`** — view *consumes* an object owned elsewhere.
  Don't construct in the view's body — that recreates on every render.
- **`@EnvironmentObject`** — implicit injection from an ancestor's
  `.environmentObject(...)`. Globals like a session.
- **`@Binding`** — a write-through reference to state owned by an
  ancestor.

Mixing patterns sloppily is a top source of state-bleed bugs. Pick a
convention per project (documented in `CLAUDE.md`) and stick to it.

## Realm (when used)

Realm Swift is a common local-DB choice. If the project uses Realm:

- Models inherit from `Object` with `@Persisted` properties
- Schema is the **cross-platform contract** if a web/Android client
  mirrors it (typical for Firebase RTDB + Realm-as-cache patterns)
- Migrations are versioned; bumping the schema version requires a
  migration block on the `Realm.Configuration`
- A common iOS shortcut: `deleteRealmIfMigrationNeeded: true` wipes
  the local DB on schema mismatch. Workable when the cloud is
  authoritative; brittle otherwise.

## Firebase (when used)

- Initialize early: `FirebaseApp.configure()` in `AppDelegate.didFinishLaunchingWithOptions`
- `GoogleService-Info.plist` per environment — handle Stage vs Prod
  via separate plists or a runtime config swap
- Realtime Database vs Firestore — different SDKs, different idioms,
  pick one per project

## Background queues / threading

- The Realm thread-confinement rule: a `Realm` instance can't cross
  thread boundaries; pass IDs and re-fetch on the target thread.
- `DispatchQueue.global(qos: .background)` for heavy work; back to
  `DispatchQueue.main.async` for UI updates.
- Combine and async/await both work in SwiftUI; `.task { }` modifier
  is the SwiftUI-native async entry point.

## Testing

- **XCUITest** ships with Xcode. Tests live in a separate target.
- **XCTest** for unit tests.
- Headless test run: `xcodebuild test -scheme … -destination …`.
- `Maestro` (third-party, mobile.dev) is an alternative for UI flows
  that's simpler than XCUITest but adds an external dependency.

## Apple-specific gotchas

- **TestFlight build numbers** consume forever — never reuse.
- **Apple Connect API keys** are downloadable exactly once.
- **App Store review** is a separate workflow from TestFlight upload —
  more involved (release notes per locale, screenshots, age rating,
  export compliance, privacy nutrition labels).
- **Code signing identities** in Keychain need to match the team /
  bundle ID in the project file.
