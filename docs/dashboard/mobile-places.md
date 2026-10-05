# Place reminders

A *place reminder* is a note that reaches your phone when you arrive at a place or leave it: "when I arrive at the school, remind me to pick up the parcel". It can also ask one of your agents a question at that moment and send you the answer.

A web app can't do this on its own: Android lets a web page read the location only while it is open on screen. So place reminders come with the **AgentX Android app**, a small app that opens the same [phone app](./mobile-app.md) and adds one thing a web page can't have: it asks Android to watch your saved places, even with the app closed and the screen off.

![How a place reminder reaches you: you set it up once; then Android watches the place, the phone reports only which place and whether you arrived or left, and the computer pushes the reminder](/diagrams/place-reminder.svg)

## What leaves your phone

- **Android watches the places, not AgentX.** Each place is registered with Android as a *geofence*: a circle around a point. Android wakes the app only when the phone crosses a circle.
- **The phone sends three things per crossing:** which saved place, whether you arrived or left, and the time. It never sends where you are, and it never sends your position in the background.
- **The computer keeps nothing about the crossing** except a random id, so a report that is sent twice fires once.
- **The phone keeps a copy of your places** (name, centre and size) in the app's own storage, which no other app and no backup can read. After a restart it uses that copy to watch your places again at once, even before Tailscale is connected. **Forget this computer** deletes it.
- **Where a place is** is what you typed or picked when you saved it. **Use where I am now** in the phone app reads the location once, only when you tap it, to fill in the form; nothing is sent until you tap **Save place**.
- **Everything stays on your tailnet.** The Android app talks only to the computer you paired it with, over the same private address as the phone app.

## What you need

- The [phone app](./mobile-app.md) set up and working, with [notifications turned on](./mobile-alerts.md). Reminders arrive as phone app notifications.
- An Android phone with Android 8 or newer, Chrome, and Google Play services. iPhone is not supported yet.
- **To build the app yourself:** a computer with [Android Studio](https://developer.android.com/studio), or with Java 17 and the Android command-line tools.

## Get the Android app

The app is in the AgentX source code, in `apps/android`. Build it once, then install it on the phone.

1. **Terminal (computer):** go to the app's folder in your copy of the AgentX source code:
   ```sh
   cd apps/android
   ```
2. **Terminal (computer):** build it:
   ```sh
   ./gradlew assembleDebug
   ```
   The app is written to `app/build/outputs/apk/debug/app-debug.apk`. The file ending in `.apk` is the app.
3. **Phone:** connect the phone to the computer with a USB cable and turn on *USB debugging* ([how](https://developer.android.com/studio/debug/dev-options)).
4. **Terminal (computer):** install the app on the phone:
   ```sh
   adb install app/build/outputs/apk/debug/app-debug.apk
   ```
   Without a cable, copy the `.apk` file to the phone instead, open it in the phone's **Files** app, and allow the install when Android asks.

Every change to `apps/android` is also built by the **Android app** check on GitHub; the app it builds is attached to that run as `agentx-android-debug`.

### Use your own package name

The app is called `dev.agentx.phone` on the phone. To install your own build next to another one, or to publish it, give it another name:

1. **Terminal (computer):** build with your own name:
   ```sh
   ./gradlew assembleDebug -PagentxApplicationId=org.example.phone
   ```
2. **Computer:** in `agentx.json`, set the same name under `app.android.packageName`:
   ```json
   { "app": { "android": { "packageName": "org.example.phone" } } }
   ```

A signed release build reads its key from the Gradle properties `agentxKeystore`, `agentxKeystorePassword`, `agentxKeyAlias` and `agentxKeyPassword` (`./gradlew assembleRelease`). See `apps/android/README.md`.

## Open it without an address bar (optional)

The app runs the phone app in Chrome. Chrome shows it full screen only when your computer vouches for the app; until then a slim address bar stays at the top. Everything works either way.

1. **Terminal (computer):** from `apps/android`, print the fingerprint of the key that signed the app:
   ```sh
   ./gradlew signingReport
   ```
   Copy the line `SHA-256:` of the variant you installed (`debug` for the build above). It looks like `AB:CD:…`, 32 pairs.
2. **Computer:** in `agentx.json`, add it under `app.android.certFingerprints`:
   ```json
   { "app": { "android": { "certFingerprints": ["AB:CD:…:EF"] } } }
   ```
3. **Terminal (computer):** let the phone read that one address, next to the two from the [phone app's install](./mobile-app.md#install):
   ```sh
   tailscale serve --bg --set-path /.well-known/assetlinks.json http://127.0.0.1:4202/.well-known/assetlinks.json
   ```
4. **Terminal (computer):** restart AgentX:
   ```sh
   agentx daemon stop && agentx daemon start --detach
   ```
5. **Phone:** close AgentX completely and open it again. The address bar is gone.

## Pair the Android app

The Android app pairs like the phone app, with a pairing code.

1. **Terminal (computer):** from the folder that holds `agentx.json`, make a pairing code:
   ```sh
   agentx app pair --name "My phone (Android app)"
   ```
2. **Phone:** open **AgentX** from the app list. The **Pair this phone** screen opens.
3. **Phone:** in **Computer address**, type the address from the QR code without `/app`: `<computer's Tailscale name>`. The app adds `https://`.
4. **Phone:** in **Pairing code**, type the code from step 1, and tap **Pair**.
5. **Phone:** the **Place reminders** screen opens. Turn them on now, as below, or tap **Open AgentX** to go to the phone app.

The first time it opens the phone app, the Android app hands Chrome the same pairing, so the phone app opens without asking for a code.

## Turn on place reminders

Android asks twice: first for the location, then for the location "all the time", which is what lets reminders fire with the app closed.

1. **Phone:** open the **Place reminders** screen: long-press the AgentX icon and tap **Place reminders**, or tap **Location settings** on the **Places** card in the phone app's **Alerts** tab.
2. **Phone:** read the note at the top, then turn on **Place reminders**.
3. **Phone:** when Android asks for the location, tap **While using the app** and keep **Precise** selected.
4. **Phone:** AgentX explains the next step. Tap **Continue**.
5. **Phone:** on Android's page for AgentX, choose **Allow all the time** and keep **Use precise location** on. Then go back.
6. **Phone:** check the screen: **Precise location: allowed** and **Location all the time: allowed**, and **Watching:** lists your places.

If you refuse either one, the switch stays off and the screen says what to change and where. Tap **Open settings** to go straight to AgentX's permissions.

## Save a place

On the phone:

1. **Phone:** in the phone app, open **Alerts**. The **Places** card lists your places.
   ![The Places card in the Alerts tab, with two places and their reminders](/screenshots/mobile-app/places.png)
2. **Phone:** tap **Add a place**.
3. **Phone:** type a **Name**, such as `School`.
4. **Phone:** stand at the place and tap **Use where I am now**, or type its **Latitude, longitude** (in most map apps, long-press the spot and copy the numbers).
5. **Phone:** leave **Radius in metres** empty to use 150 metres, or type another size. A bigger circle fires more reliably; 150 metres or more works best.
6. **Phone:** tap **Save place**.
   ![The Add a place form with a name and coordinates filled in](/screenshots/mobile-app/places-add.png)

On the computer:

1. **Browser (computer):** open the dashboard's Places page: `http://127.0.0.1:4202/places`.
2. **Browser (computer):** under **Add a place**, type a **Name** and the **Coordinates** (latitude, then longitude, separated by a comma).
3. **Browser (computer):** optionally type a **Radius in metres**, then click **Add place**.
   ![The dashboard's Places page with two places and their reminders](/screenshots/places/page.png)

The Android app picks up a new place the next time it checks: within the hour by default (`app.places.syncMinutes`), or at once when you tap **Check for new places now** on its **Place reminders** screen or open the app.

## Add a reminder to a place

1. **Phone:** on the **Places** card, under the place, tap **Add a reminder or remove**. (**Browser (computer):** on the Places page, use the row under the place.)
2. **Phone:** in **When**, choose **When I arrive** or **When I leave**.
3. **Phone:** in **Remind me to**, type the reminder, such as `Pick up the parcel`.
4. **Phone:** in **Who**, keep **Just remind me** to get exactly that text. Or pick **Ask** and an agent: the agent gets the text as a task at that moment, and its answer is what reaches your phone. For example, "What is left on today's list?" when you leave the office.
5. **Phone:** tick **Every time, not just once** for a reminder that fires on every visit. Otherwise it fires once and then shows as **done**.
6. **Phone:** tap **Add reminder**.
   ![The reminder form under a place: when, the reminder text, who, and every time](/screenshots/mobile-app/places-reminder.png)

The notification says **Arrived at School** or **Left School**, with the reminder or the agent's answer under it. It goes only to the phone that crossed the place.

A reminder set to fire every time fires at most once every 10 minutes (`app.places.cooldownMinutes`), so standing at the edge of a place doesn't buzz again and again. If the phone has no signal when it crosses, it sends the crossing when it can; one that is more than 30 minutes late (`app.places.maxEventAgeMinutes`) is dropped, because you are no longer there.

## Remove a place or a reminder

1. **Phone:** on the **Places** card, tap **Remove** next to a reminder, or open **Add a reminder or remove** under a place and tap **Remove place**. Removing a place removes its reminders too.
2. **Browser (computer):** or, on the Places page, click **Remove**, **Pause** or **Remove place**.

## Turn location off

Any one of these stops it:

1. **Phone:** on the **Place reminders** screen, turn off **Place reminders**. Android stops watching your places at once and nothing more is sent. The location permission stays as it was.
2. **Phone:** to take the permission away too, tap **Open Android settings for AgentX**, then **Permissions**, then **Location**, and choose **Don't allow**.
3. **Computer:** to turn place reminders off for every phone, set `app.places.enabled` to `false` in `agentx.json` and restart AgentX. The phone app says they are off, and phones' reports are refused.

To remove the Android app's pairing, tap **Forget this computer** on its **Place reminders** screen, then on the computer run `agentx app devices` and `agentx app revoke <id>` for that phone, as in [Manage paired phones](./mobile-app.md#manage-paired-phones).

## Settings

All in `agentx.json`, under `app`. Each one is described in the [configuration reference](../reference/config-channels.md#app).

| Setting | Default | What it changes |
|---|---|---|
| `app.places.enabled` | `true` | Place reminders on or off for every phone. |
| `app.places.defaultRadiusMeters` | `150` | Size of a new place when none is given. |
| `app.places.minRadiusMeters`, `app.places.maxRadiusMeters` | `100`, `5000` | The smallest and largest place allowed. |
| `app.places.maxPlaces`, `app.places.maxRulesPerPlace` | `50`, `10` | How many places, and reminders per place. |
| `app.places.cooldownMinutes` | `10` | Quiet time after a reminder that fires every time. |
| `app.places.maxEventAgeMinutes` | `30` | How late a crossing may arrive and still count. |
| `app.places.syncMinutes` | `60` | How often the Android app checks for changed places. |
| `app.places.file` | `.agentx/places.json` | Where places and reminders are kept. |
| `app.android.packageName` | `dev.agentx.phone` | The Android app's name, if you built your own. |
| `app.android.certFingerprints` | none | Lets Chrome open the Android app without an address bar. |

## Check it worked

1. **Phone:** on the **Place reminders** screen, **Place reminders** is on, both location lines say **allowed**, and **Watching:** lists your place.
2. **Phone:** add a test reminder to a place you can walk to, with **When I leave**.
3. **Phone:** close the AgentX app and turn the screen off.
4. **Phone:** walk out of the place, well past its circle. Within a few minutes a notification says **Left …** with your reminder. Android may take longer when the phone has been still for a while.
5. **Terminal (computer):** the dashboard's log shows a line such as `[places] tok_… exit pl_…: fired (1)`. It names only ids: never the place's name or where you were.

## If something is wrong

- **The Places card says "Reminders fire only on an Android phone with the AgentX Android app"** — the phone app was opened in the browser, not from the Android app. Open **AgentX** from the app list.
- **"Places are saved, but reminders are not sent"** — notifications are not set up on this computer. Follow [Notifications on your phone](./mobile-alerts.md), and turn notifications on in the **Alerts** tab inside the Android app.
- **No notification after crossing** — on the **Place reminders** screen, check that both location lines say **allowed**, that **Watching:** lists the place, and that Location is on in the phone's quick settings. Then:
  1. **Phone:** tap **Check for new places now**.
  2. **Phone:** make the place bigger: 150 metres or more. Android notices small circles late, or not at all.
  3. **Phone:** in Android settings, open **Apps**, then **AgentX**, then **Battery**, and choose **Unrestricted**. Some phones stop background apps to save battery.
- **No notification after restarting the phone** — the places are watched again as soon as the phone has started, without opening the app. If you changed places while the phone was off, open **AgentX** once, or tap **Check for new places now**.
- **"Location is off on this phone"** — Location was turned off, so Android dropped every place. Turn it on in quick settings; the places are watched again at the next check, or at once when you tap **Check for new places now**.
- **"This phone is no longer paired with the computer"** — the Android app's key was removed with `agentx app revoke`. Tap **Forget this computer**, then [pair again](#pair-the-android-app).
- **"Could not reach the computer"** — Tailscale is off on the phone or on the computer. Turn it on; the app tries again by itself.
- **"Place reminders are off on this computer (app.places.enabled)"** — set `app.places.enabled` to `true` in `agentx.json`, or remove the line, and restart AgentX.
- **"There is no agent called … on this computer"** — the reminder asks an agent this computer doesn't have. Pick one from the **Who** list.
- **A reminder fired once and now shows "done"** — it was set to fire once. Add it again with **Every time, not just once** ticked.
- **The phone app opens with an address bar at the top** — Chrome hasn't verified the app. Follow [Open it without an address bar](#open-it-without-an-address-bar-optional); check that `https://<computer's Tailscale name>/.well-known/assetlinks.json` opens on the phone and lists your fingerprint.
- **The phone app asks for a pairing code inside the Android app** — Chrome lost its pairing. Type a new code from `agentx app pair`, or tap **Forget this computer** and pair the Android app again: it hands the pairing to Chrome once more.
