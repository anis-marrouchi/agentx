# AgentX phone shell (Flutter)

One codebase for an Android app and, later, an iPhone app (#676). The app:

- opens the phone app (`https://<computer>/app`) unchanged in the phone's
  browser: a Trusted Web Activity in Chrome on Android (`MainActivity.kt`),
  so cookies, camera, microphone and Web Push keep working;
- pairs once with an `agentx app pair` code and hands the same pairing to
  the browser through `/app/pair#token=…`;
- registers the saved places as the phone's own geofences
  ([native_geofence](https://pub.dev/packages/native_geofence)), so a
  reminder fires with the app closed and the screen off;
- on a crossing sends only `{id, place, transition, time}` to
  `POST /api/app/places/event`. It never sends a position.

It talks to the same computer routes as the Kotlin app in `apps/android`
and uses the same default package name, `dev.agentx.phone`, so it is a
drop-in replacement for it: install one or the other, not both.

Setup, privacy and every setting: `docs/dashboard/mobile-places.md`.

## Layout

| Path | What it does |
|---|---|
| `lib/main.dart` | Start-up: setup screen, or straight to the phone app. |
| `lib/src/api.dart` | The HTTPS calls to `/api/app/*`. |
| `lib/src/prefs.dart` | What the app remembers (address, key, switch, queue). |
| `lib/src/sync.dart` | Fetches the places and asks the phone to watch them. |
| `lib/src/reporter.dart` | Queues and sends crossings, with retries. |
| `lib/src/native_fences.dart` | The phone's geofencing, and the crossing callback. |
| `lib/src/background.dart` | WorkManager jobs: periodic check, sending later. |
| `lib/src/browser.dart` | Opens the phone app. |
| `lib/src/*_screen.dart` | The two screens. |

## Build the Android app

You need [Flutter](https://docs.flutter.dev/get-started/install) 3.47 or
newer, Java 17 and the Android SDK.

```sh
cd apps/phone
flutter pub get
flutter test
flutter build apk --debug
```

The app is `build/app/outputs/flutter-apk/app-debug.apk`. Install it with
`adb install -r build/app/outputs/flutter-apk/app-debug.apk`.

## Settings that differ between owners

They are Gradle properties, never edited into the code. Put them in
`~/.gradle/gradle.properties`, or set `ORG_GRADLE_PROJECT_<name>` in the
environment:

| Property | Default | What it changes |
|---|---|---|
| `agentxApplicationId` | `dev.agentx.phone` | The app's package name. Set the same value in `agentx.json` under `app.android.packageName`. |
| `agentxKeystore`, `agentxKeystorePassword`, `agentxKeyAlias`, `agentxKeyPassword` | none | Signs `flutter build apk --release` with your own key. Without them the release build uses the debug key. |

The version comes from `version:` in `pubspec.yaml`, or
`--build-name` / `--build-number`.

## iPhone

The iOS project is set up (location wording in `Info.plist`, the geofence
plugin in `AppDelegate.swift`, the permission flags in `Podfile`) but has
not been built or tested. Building it needs a Mac with Xcode, and installing
it on an iPhone needs an Apple account. On iPhone the phone app opens in
Safari; add it to the Home Screen there to get notifications. iOS lets an
app watch 20 places at most.
