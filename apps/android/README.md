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
  through this app's permission (#684). Chrome only asks an app it has
  registered for the address, and it registers it once per Chrome run. If
  the app is uninstalled and installed again while Chrome keeps running
  (for example with a new signing key), Chrome has dropped the old
  registration but won't register the new install until it restarts, so
  the location fails at once with `Unable to request location permission.`
  in logcat. Force stop Chrome once (Settings › Apps › Chrome › Force stop)
  and open the app again (#708). The Places card says so when it sees this.
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

Sign every build you install with the same key. A phone refuses to update
an app signed with another key, and CI's debug builds each have their own.
Give each build a higher `agentxVersionCode` than the one on the phone.

## Test on a real phone

Unit tests cover what the app decides on a crossing. Geofences themselves
need Google Play services, a real position and Android's power saving, so
this part only runs on a phone. It is the check list of #681.

Before you start:

- A release build signed with your key (see [Build](#build)), installed over
  the old one: `adb install -r app/build/outputs/apk/release/app-release.apk`.
  Some phones (Xiaomi) ask for a tap on the phone to allow it.
- A place you can walk out of and back into, 150 m or larger.
- On the computer, the log that shows place events. For the dashboard
  service: `tail -f ~/.agentx/logs/dashboard-stderr.log | grep '\[places\]'`.
- Optional, on the phone over USB: `adb logcat -s cr_TWAClient WM-WorkerWrapper`.

Steps (each one has its expected result):

1. Pair the app with a code from `agentx app pair` (screenshot the **Pair
   this phone** screen first, on a demo setup). **Expect:** the **Place
   reminders** screen opens. An already paired phone skips this step.
2. Turn on **Place reminders**. Tap **Don't allow** at the first question.
   **Expect:** the switch stays off and a dialog explains it, with
   **Open settings**. Take a screenshot of each Android permission dialog.
3. Turn it on again and allow **While using the app**. Tap **Continue**, and
   on Android's page keep **Allow only while using the app**, then go back.
   **Expect:** the switch stays off and the dialog says reminders would not
   fire with the app closed. Repeat and choose **Allow all the time**.
   **Expect:** both location lines say **allowed**. Screenshot this screen.
4. Tap **Open AgentX**. **Expect:** the phone app opens without asking for a
   pairing code, and without an address bar when assetlinks is served.
5. In the phone app's **Alerts** tab, turn on notifications.
6. Save a place with two reminders: **When I arrive**, **Just remind me**;
   and **When I leave**, asking an agent. On **Place reminders**, tap
   **Check for new places now**. **Expect:** **Watching:** lists it.
7. Swipe the app away and turn the screen off. Walk well out of the place,
   wait a few minutes, then walk back in. **Expect:** two notifications, the
   second with the agent's answer. The log shows `[places] tok_… exit pl_…:
   fired (1)` and `… enter …: fired (1)`, ids only. A `duplicate` line right
   after one is normal: the quick send and the queued job both arrived.
8. Turn **Place reminders** off and cross the place again. **Expect:** no
   notification and no new `[places]` line.
9. Turn it back on, restart the phone and don't open the app. Cross the
   place. **Expect:** the notification arrives.

Report the phone model, Android version, build (`versionCode`) and which
steps passed on #681.
