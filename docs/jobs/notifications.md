# Get notified

AgentX can tap you on the shoulder when something happens: a task finishes, a job fails, or an agent needs you. This page sets that up from scratch, one step at a time.

A notification can reach you in three ways. You can use any of them on its own:

- **On your phone**, through the AgentX [phone app](../dashboard/mobile-app.md). This is the default. If you prefer, the free [ntfy](https://ntfy.sh) app works too. ntfy ("notify") is a small service that sends a push message to a phone.
- **On your Mac**, as a banner in the top-right corner of the screen, with a short sound.
- **In a chat app** (Telegram or WhatsApp), for messages about tasks the agents run.

AgentX also respects **Focus**. While your Mac is in Focus (Do Not Disturb), it keeps messages back and sends them together when Focus ends.

You can change every setting in two places. Both save to the same settings file, `agentx.json`:

- **The dashboard:** open **Settings**, choose the **Channels** tab, and open **Notifications routing**.
- **The terminal:** the `agentx notifications` command.

![The Notifications routing section in the dashboard](/screenshots/notifications/dashboard-routing.png)

## 1. Get messages on your phone

### With the AgentX phone app

1. Install and pair the [phone app](../dashboard/mobile-app.md).
2. Follow [Notifications on your phone](../dashboard/mobile-alerts.md): run `agentx app push-keys` and `agentx notifications push --subject mailto:you@example.com --enable` on the computer, restart AgentX, then tap **Turn on** in the app's **Alerts** tab.

`agentx notify` sends to the phone app unless you choose another channel.

### With ntfy instead

Use ntfy if you don't use the phone app. After setting it up, make it the default for `agentx notify` (step 11).

A **topic** is the name of your private message box on ntfy. On the public `ntfy.sh` server, anyone who knows the topic name can read it, so treat the name like a password.

1. Install the **ntfy** app on your phone from the App Store or Google Play.
2. Make up a long, random topic name, for example `agentx-8f3c1e0a9b7d`.
3. In the ntfy app, tap **+** and subscribe to that topic.
4. Open the `.env` file in the same folder as your `agentx.json`. (This file keeps secrets out of `agentx.json`.)
5. Add this line, using your own topic name:

   ```sh
   NTFY_TOPIC=agentx-8f3c1e0a9b7d
   ```

6. In the dashboard, open **Settings → Channels → Notifications routing**.
7. Under **Phone push (ntfy)**, tick **Enabled**.
8. In **Topic**, type `${NTFY_TOPIC}`. AgentX reads the real name from `.env`.
9. Select **Save notifications**.
10. Restart AgentX so the change takes effect. In the terminal, run:

    ```sh
    agentx daemon stop && agentx daemon start --detach
    ```

11. Make ntfy the default for `agentx notify`. In the terminal, run:

    ```sh
    agentx notifications channel ntfy
    ```

The form never shows a saved topic or token again. It only says whether one is set.

::: tip Running your own ntfy server?
Put its address in **Server** (for example `https://ntfy.example.com`). If your topic is protected, add `NTFY_TOKEN=…` to `.env` and type `${NTFY_TOKEN}` in **Access token**.
:::

::: info The same steps in the terminal
```sh
agentx notifications ntfy --topic '${NTFY_TOPIC}' --enable
agentx notifications ntfy --server https://ntfy.example.com --token '${NTFY_TOKEN}'   # own server only
agentx notifications channel ntfy
agentx daemon stop && agentx daemon start --detach
```
Keep the single quotes, so your shell does not replace `${…}` itself. `--token ""` removes a token, and `--disable` turns phone push off.
:::

You can type the real topic name in the form instead of `${NTFY_TOPIC}`. It is then stored in `agentx.json`, so do not share or commit that file.

## 2. See a banner on your Mac

Banners and sounds are on by default. They only happen on a Mac; on other computers AgentX skips them quietly.

Banners come from a small app called **AgentX Helper**. With it, banners show the AgentX logo. Without it, macOS shows them as coming from **Script Editor**, with Script Editor's icon.

| Right: AgentX Helper posts the banner | Wrong: the Script Editor icon |
|---|---|
| ![A banner with the AgentX logo](/screenshots/notifications/banner-agentx.png) | ![A banner with the Script Editor icon](/screenshots/notifications/banner-script-editor.png) |

### Install AgentX Helper

Before you start, check that:

- your Mac has an Apple chip (M1 or newer) and runs macOS 14 Sonoma or newer;
- Apple's command-line tools are installed. If you are not sure, run `xcode-select --install` in the Terminal. It either starts the install or says they are already there.

`agentx desktop install` also installs the [AgentX Desktop voice assistant](../dashboard/voice.md) and starts it when you log in. Run `agentx desktop install --dry-run` first to see what it will install, without changing anything.

1. Open the Terminal.
2. Go to the folder that holds your `agentx.json`, for example:

   ```sh
   cd ~/agentx
   ```

3. Run:

   ```sh
   agentx desktop install
   ```

   This builds AgentX Helper and puts it in the **Applications** folder inside your home folder. It takes a minute or two the first time.
4. Send a test message:

   ```sh
   agentx notify "Hello" --title "Test"
   ```

5. macOS asks whether **AgentX Helper** may send notifications. Choose **Allow**.

<!-- No screenshots yet for the install output or the macOS "allow notifications" prompt:
     both only appear when AgentX Helper is really installed into ~/Applications on a Mac,
     which the scripted docs demo cannot do. Capture them on a clean demo Mac user account
     (neutral home folder name) and store them under docs/public/screenshots/notifications/. -->

### Allow AgentX Helper to show banners

If you missed the question, or chose **Don't Allow**, turn it on by hand:

1. Open the Apple menu and choose **System Settings**.
2. Select **Notifications** in the sidebar.
3. Scroll down to the list of apps and select **AgentX Helper**.
4. Turn on **Allow notifications**.
5. Select the **Banners** style.

![System Settings, Notifications, AgentX Helper: Allow notifications on, Banners selected](/screenshots/notifications/system-settings-helper.png)

Run `agentx notify "Hello" --title "Test"` again. The banner should now show the AgentX logo.

### Choose the sound and volume

1. In the dashboard, open **Settings → Channels → Notifications routing**.
2. Under **On this Mac**, tick or untick **Show a banner** and **Play a sound**.
3. In **Sound**, type the name of a macOS sound: Glass (the default), Ping, Tink, Submarine, or any other name in `/System/Library/Sounds`.
4. In **Volume**, type a number from 0 (silent) to 1 (full). The default is 0.4.
5. Select **Save notifications**.

::: info The same steps in the terminal
```sh
agentx notifications local --banner on --sound on --sound-name Tink --volume 0.6
```
:::

### Use your own icon

The banner shows the AgentX logo unless you choose another picture. macOS takes the icon from the app that posts the banner, so a new icon means rebuilding AgentX Helper.

1. Save a square picture of at least 512 × 512 pixels as `.png`, `.jpg` or `.icns`.
2. In the dashboard, under **On this Mac**, type the picture's full path in **Banner icon**, for example `/Users/you/Pictures/team-logo.png`.
3. Select **Save notifications**.
4. In the terminal, run `agentx desktop install` to rebuild the helper with the new icon.
5. If macOS asks again whether AgentX Helper may send notifications, choose **Allow**. A rebuilt app counts as new to macOS.

![The On this Mac settings with a banner icon path filled in](/screenshots/notifications/dashboard-this-mac.png)

To go back to the AgentX logo, empty **Banner icon**, save, and run `agentx desktop install` again.

::: info The same steps in the terminal
```sh
agentx notifications local --icon ~/Pictures/team-logo.png
agentx desktop install
agentx notifications local --icon ""   # back to the AgentX logo
```
:::

::: details Where AgentX looks for the helper
In this order: the path in the `AGENTX_MAC_HELPER` environment variable, if set; then `~/Applications/AgentX Helper.app`; then a helper built inside the AgentX installation (`apps/mac-helper/build`). It does not depend on the folder you run `agentx` from.
:::

## 3. Get task messages in a chat app

Agents can report on their own work: when a task finishes, fails, or waits in line. These messages go to one chat.

1. Connect the chat app first ([Telegram](../connect-telegram.md) or WhatsApp).
2. In the dashboard, open **Settings → Channels → Notifications routing**.
3. In **Channel**, type `telegram` or `whatsapp`.
4. In **Chat ID**, type the chat's ID. For a Telegram group it starts with `-100`.
5. Fill in **Account ID** only if you run more than one bot on that channel.
6. Under **Events to ping on**, tick the events you want: **Task complete**, **Task error**, **Task queued**.
7. In **Long-task threshold**, type how many seconds a task may run before AgentX tells you it is still working. `0` turns this off. The default is 30.
8. Select **Save notifications**.

To stop these messages, select **Clear destination**.

::: info The same steps in the terminal
```sh
agentx notifications route --channel telegram --chat-id -1001234567890
agentx notifications event taskQueued on
agentx notifications threshold 60
agentx notifications route --clear   # stop
```
:::

## 4. Hold messages during Focus

While you are in Focus, a message gets no push, no banner and no sound. AgentX keeps it and sends everything held as one message when Focus ends. A message sent with `--urgent` always goes through.

AgentX can tell you are in Focus in two ways.

**macOS Focus (Do Not Disturb).** macOS keeps this in a private file, so AgentX needs permission to read it:

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Turn on the app that runs AgentX: Terminal, iTerm, or whichever app starts the AgentX daemon (the background service).

Without that permission, AgentX cannot see Focus and never holds a message, so nothing is lost.

**A manual hold**, without turning on macOS Focus:

1. Create the file `~/.agentx/focus.json` containing `{"active": true}`.
2. To release the messages, delete the file or change it to `{"active": false}`.

AgentX checks every 30 seconds. When Focus ends, it sends what it held: one message per destination, with one banner and one sound.

## 5. Send a notification yourself

Scripts and scheduled jobs can call `agentx notify`:

```sh
agentx notify "Build finished" --title "CI"
agentx notify "Production is down" --title "Alert" --urgent
agentx notify --status        # Focus state and anything held
agentx notify --flush         # deliver what is held now
```

| Option | What it does |
|---|---|
| `--title <text>` | Notification title (default `AgentX`) |
| `--priority <1-5>` | ntfy priority (default 4); the phone app ignores it |
| `--urgent` | Deliver even during Focus |
| `--from <who>` | Shown in a held digest, so you know who sent what |
| `--channel`, `--chat-id` | Deliver somewhere other than the default channel (`notifications.channel`, which is `push`) |
| `--no-banner`, `--no-sound` | Skip the banner or the sound for this message |
| `-c <path>` | Read the settings from this `agentx.json` |
| `--proof` | Capture the banner as it shows and print the picture's location; see [Capture the screen at the right moment](./screen-capture.md) |
| `--json` | Print the result as JSON |

- `agentx notify` reads its settings from `./agentx.json`. When it runs from another folder, as scheduled jobs do, add `-c /path/to/agentx.json`. Without a settings file it uses the defaults.
- It waits for the banner and the sound to finish before it exits (about two seconds), so a job that ends straight afterwards still gets both.
- The phone push goes through the running AgentX daemon. If the daemon is stopped, the command reports an error, but the banner and sound still play.

## Check it worked

1. In the terminal, run `agentx notifications show`.
2. Check that the `push` line says `on`, `subject set` and `keys set`. If you use ntfy instead, check that the `channel` line says `ntfy` and the `ntfy` line says `on` and `topic set`.
3. Check that the `local.helper` line says **AgentX Helper posts banners with the AgentX icon.** If it says anything else, follow the `Fix:` line under it.
4. Run `agentx notify "Hello" --title "Test"`.
5. Check that your phone buzzes, and that a banner with the AgentX logo appears on the Mac with a sound.
6. Create `~/.agentx/focus.json` containing `{"active": true}` and send another message.
7. Run `agentx notify --status` and check that the message is listed as held.
8. Delete `~/.agentx/focus.json`. Within 30 seconds, the held message arrives.

`agentx doctor` runs the same helper check under **Notifications**, along with its other checks.

## If something is wrong

`agentx notifications show` and `agentx doctor` explain what they find about AgentX Helper in plain words:

| What you see | What it means | What to do |
|---|---|---|
| "AgentX Helper is not installed" | Banners come from Script Editor. | Run `agentx desktop install`, then send a test and choose **Allow**. |
| "macOS has not asked yet" | The helper has never tried to post a banner. | Run `agentx notify "Hello" --title "Test"` and choose **Allow**. |
| "macOS does not allow AgentX Helper to notify" | Someone chose **Don't Allow**, or it was turned off. | Follow [Allow AgentX Helper to show banners](#allow-agentx-helper-to-show-banners). |
| "its banner style is None" | Allowed, but set to show nothing on screen. | In System Settings → Notifications → AgentX Helper, choose **Banners**. |
| "AgentX Helper is too old" | The helper was built by an older AgentX. | Run `agentx desktop install` to update it. |

Other problems:

| Problem | What to do |
|---|---|
| No banner at all | Turn off Do Not Disturb. If the helper is not installed, also allow **System Settings → Notifications → Script Editor**. |
| The phone does not buzz | With the phone app, see [Notifications on your phone](../dashboard/mobile-alerts.md#if-something-is-wrong). With ntfy, check that the topic in the ntfy app matches `NTFY_TOPIC` exactly, that `agentx notifications show` lists `channel ntfy`, and that you restarted AgentX after saving. |
| Nothing is held during Focus | Give Full Disk Access to the app that runs AgentX (step 4), or use `~/.agentx/focus.json`. |
| A scheduled job uses the wrong settings | Add `-c /path/to/agentx.json` to its `agentx notify` command. |
| The new icon does not show | Run `agentx desktop install` after changing **Banner icon**, then allow notifications again if asked. |
