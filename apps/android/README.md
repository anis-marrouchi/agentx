# AgentX Android app

A small Android app around the AgentX phone app (`/app`). It adds what a web
app can't have on Android, starting with place reminders: the saved places
are registered as OS geofences, so a reminder fires with the app closed and
the screen off (#676).

How to build, install, pair and use it, step by step:
[docs/dashboard/mobile-places.md](../../docs/dashboard/mobile-places.md).

## How it fits together

- `MainActivity` is the launcher entry: `SetupActivity` the first time
  (address and pairing code), then the phone app.
- `TwaActivity` opens `https://<computer>/app` in Chrome as a Trusted Web
  Activity, so the phone app runs unchanged: Chrome's cookies, camera,
  microphone and Web Push. The computer vouches for the app at
  `/.well-known/assetlinks.json` (`app.android` in `agentx.json`).
- `DelegationService` is what Chrome asks before it shows the phone app's
  notifications as this app's, and before it gives the page the location
  (**Use where I am now** on the Places card). Chrome reads the location
  through this app's permission (#684).
- The app pairs once, with a code from `agentx app pair`, and keeps the
  device key in app-private storage that is excluded from backups. It hands
  Chrome the same key the first time through `/app/pair#token=…`.
- `Places` fetches `GET /api/app/places` and registers each place as a
  geofence. `SyncWorker` repeats that every `app.places.syncMinutes`, after
  a restart and after an update (`BootReceiver`). The places registered
  last are kept in app-private storage, so after a restart `BootReceiver`
  watches them again at once, before the tailnet is up.
- `GeofenceReceiver` gets the crossing from Android and sends
  `POST /api/app/places/event` with `{ id, place, transition, time }` and
  nothing else, at once, while Android keeps the app awake for the
  broadcast (a background job can wait for Doze's next maintenance window
  with the screen off). `EventWorker` is queued first and sends it later
  if that fails, retrying while the phone is offline. The computer fires a
  crossing once even if both send it.
- `PlacesActivity` is the settings screen: the switch, the permissions, the
  places watched, and the way out. The phone app links to it with
  `intent://places#Intent;scheme=agentx;package=<package>;end`.

## Build

Java 17 and the Android SDK (Android Studio has both).

```sh
./gradlew testDebugUnitTest   # unit tests
./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
```

Gradle properties (in `gradle.properties`, `~/.gradle/gradle.properties` or
`-P` on the command line) change what differs between owners; nothing else
is configured in the build files:

| Property | Default | What it does |
|---|---|---|
| `agentxApplicationId` | `dev.agentx.phone` | The app's package name. Set the same in `app.android.packageName`. |
| `agentxVersionCode`, `agentxVersionName` | `1`, `0.1.0` | Version shown on the phone. |
| `agentxKeystore`, `agentxKeystorePassword`, `agentxKeyAlias`, `agentxKeyPassword` | unset | Signs `assembleRelease` with your own key. |
