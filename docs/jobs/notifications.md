# Get notified

AgentX can tap you on the shoulder when something happens: a task finishes, a job fails, or an agent needs you. This page sets that up from scratch, one step at a time.

A notification can reach you in three ways. You can use any of them on its own:

- **On your phone**, through the AgentX [phone app](../dashboard/mobile-app.md). This is the default. If you prefer, the free [ntfy](https://ntfy.sh) app works too. ntfy ("notify") is a small service that sends a push message to a phone.
- **On your Mac**, as a banner in the top-right corner of the screen, with a short sound.
- **In a chat app** (Telegram or WhatsApp), for messages about tasks the agents run.

AgentX also respects **Focus** and **calls**. While your Mac is in Focus (Do Not Disturb), or you are in a call, it keeps messages back and sends them together when the Focus or the call ends.

You can change every setting in two places. Both save to the same settings file, `agentx.json`:

- **The dashboard:** open **Settings**, choose the **Channels** tab, and open **Notifications routing**.
- **The terminal:** the `agentx notifications` command.

![The Notifications routing section in the dashboard](/screenshots/notifications/dashboard-routing.png)

## 1. Get messages on your phone

### With the AgentX phone app

1. Install and pair the [phone app](../dashboard/mobile-app.md).
2. Follow [Notifications on your phone](../dashboard/mobile-alerts.md): run `agentx app push-keys` and `agentx notifications push --subject mailto:you@example.com --enable` on the computer, restart AgentX, then tap **Turn on** in the app's **Alerts** tab.

Once phone app notifications are on, `agentx notify` sends to the phone app.

### With ntfy instead

Use ntfy if you don't use the phone app. `agentx notify` sends to ntfy when phone app notifications are off. If you turned both on, step 11 makes ntfy the default.

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
    agentx daemon restart
    ```

11. Only if phone app notifications are also on: make ntfy the default for `agentx notify`. In the terminal, run:

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
agentx notifications channel ntfy   # only if phone app notifications are also on
agentx daemon restart
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

`agentx desktop install` also installs the [AgentX Voice assistant](../dashboard/voice.md) and starts it when you log in. Run `agentx desktop install --dry-run` first to see what it will install, without changing anything.

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

## 4. Hold messages during Focus and calls

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

**Calls.** While you are in a call, messages and decision cards are held the same way, and they come when the call ends. AgentX counts you as in a call when:

- you answered a call from an agent and it has not ended (for up to two hours);
- the AgentX widget is busy: a call, its microphone, or a reply it is speaking.

The daemon writes this every 15 seconds to `~/.agentx/call.json`, with a time limit, so `agentx notify` run by an agent sees it too. Another tool that knows you are in a call, such as a phone bridge, can write `{"active": true, "source": "<its name>", "until": "<ISO time>"}` to the same file. The daemon never removes a hold written by another source. Calls to you from agents keep their own rule: see [Calls](../dashboard/calls.md).

## 5. Send a notification yourself

Scripts and scheduled jobs can call `agentx notify`:

```sh
agentx notify "Build finished" --title "CI"
agentx notify "Production is down" --title "Alert" --todo "Open the status page" --urgent
agentx notify --status        # Focus state and anything held
agentx notify --flush         # deliver what is held now
```

| Option | What it does |
|---|---|
| `--title <text>` | Notification title (default `AgentX`) |
| `--todo <text>` | What you should do about it. Shown after the message as `To do: <text>`; without it the line says `To do: nothing, FYI` |
| `--priority <1-5>` | ntfy priority (default 4); the phone app ignores it |
| `--urgent` | Deliver even during Focus, and even if you were already told the same thing |
| `--key <id>` | What the message is about, for example `backup:nightly`. A message with the same key is told once across all channels within `notifications.told.repeatWindowHours`. Without it, a message of 40 characters or more is its own key |
| `--request <id>` | The open request the message belongs to |
| `--digest` | A system reminder, such as disk space or a channel that stopped. It waits for the daily digest instead of a notification now |
| `--told` | Show what you were told in the last 24 hours: how many were sent, held, kept for the digest or not repeated, and the latest ones |
| `--from <who>` | Shown in a held digest, so you know who sent what |
| `--channel`, `--chat-id` | Deliver somewhere other than the default channel (`notifications.channel`, which is `push`) |
| `--no-banner`, `--no-sound` | Skip the banner or the sound for this message |
| `-c <path>` | Read the settings from this `agentx.json` |
| `--proof` | Capture the banner as it shows and print the picture's location; see [Capture the screen at the right moment](./screen-capture.md) |
| `--json` | Print the result as JSON |

- `agentx notify` reads its settings from `./agentx.json`. When it runs from another folder, as scheduled jobs do, add `-c /path/to/agentx.json`. Without a settings file it uses the defaults.
- It waits for the banner and the sound to finish before it exits (about two seconds), so a job that ends straight afterwards still gets both.
- The phone push goes through the running AgentX daemon. If the daemon is stopped, the command reports an error, but the banner and sound still play.
- Every notice from `agentx notify` ends with a **To do** line after the message, so you know at a glance whether it wants anything from you. Notices the daemon sends by itself (a failed job, a request that needs you) do not have one.
- A message must read in about ten seconds: the title can be up to 120 characters and the message up to 300, counting the To do line. A longer one is not sent. The command says why and exits with an error, so the agent or script that sent it can shorten it. AgentX never cuts it.
- A title must say what the notice is in words. A title that is only a reference, such as `#402`, `group/project#402`, a link, a commit hash or a request id, is not sent; put the reference in the message instead. A short plain title such as `Backups` is fine, and so is a reference next to words, such as `Login fix ready (#402)`.

## 6. Told once, and the daily digest

Every message that goes to your own addresses passes one check first, whether an agent, a script or AgentX itself sent it. Your own addresses are the phone app (`push`), ntfy, and any private chat you list in `notifications.told.addresses`. AgentX writes down what it told you, which request it belongs to and on which channel.

- **Told once.** A notice from AgentX itself or from `agentx notify` that you already got is not sent again, on any of these channels. With a `--key`, "already" means within `notifications.told.repeatWindowHours` (24 by default). Without one, the same words count as the same notice for up to 20 hours, so a daily report still arrives every day. An agent's answer to you is never held back as a repeat, and an urgent message always goes.
- **System reminders wait for the digest.** "Not finished" for a request that stopped, a missing voice, or a channel that stopped working is not sent as a notification of its own. The request is on your Desk at once. The reminder is added as one line to the daily digest (`approvals.digest`, 09:00 by default), for example: `6 notices held for this digest: Not finished ×5 (Check the invoices batch, …); WhatsApp stopped reconnecting.` This needs the digest on and a place to send it: `approvals.digest.destination` or `notifications.destination`. Without one, reminders are sent at once as before, so none is lost.
- **Nothing speaks over something else.** Before AgentX speaks a reply, it waits while another program on this computer is speaking or playing a sound, such as a script reading a presentation aloud with `say`. The notification sound waits up to `notifications.local.quietWaitSeconds` (15 by default); after that the banner shows without the sound. To keep AgentX quiet for longer, for a talk or a recording, take the floor: `agentx voice floor run --as "Presentation" --sound -- <your command>`.

To see what you were told:

1. **Terminal:** run `agentx notify --told`.
2. The first line counts the last 24 hours by outcome: sent, held for Focus or a call, kept for the digest, not repeated, and failed.
3. The lines after it list the latest messages.

Scripts can read the same record with `curl -s http://127.0.0.1:18800/owner/told` (from another computer, with the mesh token). It returns the counts and the latest messages since `?since=<epoch milliseconds>`, by default the last 24 hours. A message posted to `POST /send` for one of your addresses can carry `"told": {"key": "…", "kind": "nag"}`. When the check keeps it back, the answer is `{"ok": true, "sent": false, "told": "repeat"}` or `"told": "digest"`.

To turn the check off, set `notifications.told.enabled` to `false`. To get system reminders at once again, set `notifications.told.digestNags` to `false`. See [Configuration: automation](../reference/config-automation.md).

## 7. Did it land: seen, answered, and urgent messages

AgentX also writes down whether a message reached you. Each message that went out moves from **sent** to **seen** to **answered**:

- **Seen**: you marked it read in the phone app's **Alerts** tab (tap it, or **Mark all read**), or the **Desk** tab showed the request it is about.
- **Answered**: you wrote in the chat where you asked for that work, you wrote an answer on the Desk, or you decided the request's card.

`agentx notify --told` adds a line such as `Of those that went out: 3 answered, 5 seen, 2 not seen yet`, and each message shows its state and how it got there, for example `seen ... (phone)`. `GET /owner/told` returns the same as `landed`, and `seenAt`, `seenVia`, `answeredAt` and `answeredVia` on each row.

AgentX also keeps where you were last seen: the phone app, its Desk tab, and each chat you wrote from. `curl -s http://127.0.0.1:18800/owner/presence` shows this, with how long this computer has been idle (Mac only), whether Focus is on and whether you are in a call.

**Urgent messages can follow you.** Set `notifications.reach.enabled` to `true` to turn this on. It is off by default. An urgent message from AgentX itself, such as a call that cannot wait, then goes to the address where you were seen last. A message sent to a named channel, such as `agentx notify --urgent`, still goes to that channel. If an urgent message is still neither seen nor answered after `notifications.reach.escalateAfterMinutes` (10 by default), it is sent once more, to the next address on the list, with `(Sent again here: not seen on push for 10 min.)` at the end. It is never sent a third time. Other messages are not affected: they still follow the told-once rule and the digest. The list is `notifications.reach.ladder`, for example `["push:default", "telegram:123456789"]`. Without one, it is your told channels and then your told addresses.

**A channel that is down is refused.** When a channel cannot send, for example WhatsApp with no connection, `/health` shows it under `channels` as `"up": false` with the reason and since when. A message sent to it is refused with that reason: `POST /send` answers `503` with `{"ok": false, "refused": true, "reason": "…"}`, and AgentX does not report it as sent. A channel down on two checks a minute apart raises one notice (a reminder for the digest, like other system reminders). To try this without breaking anything, switch a channel off and on again: `curl -s -X POST http://127.0.0.1:18800/channels/ntfy/switch -H 'Content-Type: application/json' -d '{"on": false}'`. It stays off until you switch it on or restart AgentX.

## Check it worked

1. In the terminal, run `agentx notifications show`.
2. Check the `channel` line: it names where `agentx notify` sends. For the phone app it says `push`, and the `push` line says `on`, `subject set` and `keys set`. For ntfy it says `ntfy`, and the `ntfy` line says `on` and `topic set`.
3. Check that the `local.helper` line says **AgentX Helper posts banners with the AgentX icon.** If it says anything else, follow the `Fix:` line under it.
4. Run `agentx notify "Hello" --title "Test"`.
5. Check that your phone buzzes, and that a banner with the AgentX logo appears on the Mac with a sound.
6. Create `~/.agentx/focus.json` containing `{"active": true}` and send another message.
7. Run `agentx notify --status` and check that the message is listed as held.
8. Delete `~/.agentx/focus.json`. Within 30 seconds, the held message arrives.
9. Create `~/.agentx/call.json` containing `{"active": true, "source": "test"}`. Run `agentx notify --status`: it says `in a call`. Delete the file; within 30 seconds anything held arrives.
10. Run `agentx notify "$(printf 'x%.0s' {1..301})"`. It says `not sent: message is longer than 300 characters` and sends nothing.
11. Run `agentx notify "Ready for review" --title "#402"`. It says `not sent: title is only a reference ("#402")` and sends nothing.
12. Run `agentx notify "Backups ran" --title "Backups"`. The notice shows `Backups ran`, then `To do: nothing, FYI` on the next line.
13. Run `agentx notify "Backups ran" --title "Backups" --key backup:test` twice. The first is sent; the second says `not sent: the owner was already told this`.
14. Run `agentx notify "The test disk is nearly full" --title "Disk" --digest`. It says `not sent: kept for the daily digest`. Run `agentx notify --told`: it counts `1 kept for the digest`, and the next digest has a line for it.
15. On a Mac, run `say "This is a long sentence that takes a few seconds to read aloud"` and, while it speaks, ask an agent something by voice. Its answer starts only after `say` is finished.
16. With the phone app, run `agentx notify "Seen test" --title "Reach"`. On the phone, open **Alerts** and tap the message. Run `agentx notify --told`: the message shows `seen ... (phone)`.
17. Switch a channel off: `curl -s -X POST http://127.0.0.1:18800/channels/ntfy/switch -H 'Content-Type: application/json' -d '{"on": false}'`. Run `curl -s http://127.0.0.1:18800/health`: `channels.ntfy` says `"up": false`. Send to it with `curl -s -X POST http://127.0.0.1:18800/send -H 'Content-Type: application/json' -d '{"channel":"ntfy","chatId":"default","text":"Test\nrefused"}'`: the answer is `503` with `"refused": true` and the reason. Switch it on again with `{"on": true}`.

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
| A message you expected never came | Run `agentx notify --told`. `repeat` means you were already told the same thing (with the same `--key` in the last 24 hours, or the same words in the last 20); `digest` means it waits for the daily digest. Send it with `--urgent` if it cannot wait, or give a different `--key`. |
| A message stays `sent` although you read it | Seen comes from the phone app's read mark and the Desk. Reading the notification on the lock screen does not count. Tap it in **Alerts**. |
| `/send` answers `refused` | The channel is down. Check `channels` in `curl -s http://127.0.0.1:18800/health` for the reason, fix it, or switch it on again if you switched it off. |
| A script's message is sent every time even though it says the same thing | A message shorter than 40 characters is never taken for a repeat. Give it a `--key`. |
| System reminders never arrive | They come in the daily digest. Check that `approvals.digest.enabled` is on and has a destination (`approvals.digest.destination`, or `notifications.destination`). |
| An agent's spoken answer waits a long time | Another program on this computer is speaking or playing a sound. AgentX waits for it for up to 10 minutes, then speaks anyway. |
| The new icon does not show | Run `agentx desktop install` after changing **Banner icon**, then allow notifications again if asked. |
