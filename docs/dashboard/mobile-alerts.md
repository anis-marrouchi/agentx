# Notifications on your phone

The **Alerts** tab of the [phone app](./mobile-app.md) turns on notifications for your phone. After that, when an agent needs you, a job fails or a script runs `agentx notify`, your phone shows a notification, even while the app is closed. The tab also lists the most recent notifications.

These are standard web notifications (*Web Push*). They reach the phone through the push service of the phone's own browser, so no extra app or account is needed.

![The Alerts tab before notifications are turned on, with recent notifications listed](/screenshots/mobile-app/alerts.png)

## Before you start

- Install and pair the [phone app](./mobile-app.md), and add it to the home screen.
- **iPhone:** iOS 16.4 or newer. On an iPhone, notifications only work in the app opened from the Home Screen, not in a Safari tab.
- **Android:** Chrome, or another browser that can install apps.

## Set up the computer that hosts the phone app

Do this once, on the computer the phone pairs with.

1. **Terminal (computer):** go to the folder that holds `agentx.json`, for example:
   ```sh
   cd ~/agentx
   ```
2. **Terminal (computer):** create the key pair that lets this computer send notifications:
   ```sh
   agentx app push-keys
   ```
   The keys are saved in `.agentx/push-keys.json`, which only you can read. They are never stored in `agentx.json`.
3. **Terminal (computer):** turn notifications on. The push services need a way to contact whoever runs the server, so give an email address (or a web address starting with `https://`):
   ```sh
   agentx notifications push --subject mailto:you@example.com --enable
   ```
4. **Terminal (computer):** restart AgentX so the change takes effect:
   ```sh
   agentx daemon stop && agentx daemon start --detach
   ```

## Set up your other computers

If you run AgentX on more than one computer (a *mesh*), the other computers send their notifications through the host. Do this on each of them.

1. **Terminal (other computer):** find the host's name in the mesh:
   ```sh
   agentx mesh list
   ```
2. **Terminal (other computer):** from the folder that holds `agentx.json`, send notifications through the host. Use the host's name from step 1:
   ```sh
   agentx notifications push --relay-to my-host --enable
   ```
3. **Terminal (other computer):** restart AgentX:
   ```sh
   agentx daemon stop && agentx daemon start --detach
   ```

## Turn on notifications on the phone

1. **Phone:** open the AgentX app from the home screen.
2. **Phone:** tap **Alerts**.
3. **Phone:** tap **Turn on**.
4. **Phone:** when the phone asks whether AgentX may send notifications, tap **Allow**.
5. **Phone:** check that the card now says **On**.

Each phone turns notifications on for itself. Repeat these steps on every phone you paired.

## Use it

- Tap a notification to open the app on the **Alerts** tab. When the message carries a link, for example to a failed job, tapping opens that link instead.
- Some notifications have buttons. Each button opens its own link.
- To stop notifications on one phone, open **Alerts** and tap **Turn off**.
- Removing a phone with `agentx app revoke` also stops its notifications.
- `agentx notify` sends to the phone app unless you choose another channel. To make ntfy or a chat app the default again, run `agentx notifications channel ntfy` (or the channel's name). For ntfy, see [Get notified](../jobs/notifications.md).

## Check it worked

1. **Terminal (computer):** run `agentx notifications show`. The `push` line says `on`, `subject set` and `keys set`.
2. **Terminal (computer):** send a test:
   ```sh
   agentx notify "Hello" --title "Test"
   ```
3. **Phone:** a notification titled **Test** appears within a few seconds.
4. **Phone:** open the app and tap **Alerts**. **Test** is at the top of **Recent**.
5. **Terminal (other computer):** if you set up a second computer, run the same `agentx notify` there. The phone gets it too.

## If something is wrong

- **The card says "Notifications are off"** — the host isn't set up yet. Follow [Set up the computer that hosts the phone app](#set-up-the-computer-that-hosts-the-phone-app).
- **The card says "This computer has no push keys yet"** — run `agentx app push-keys` in the folder that holds `agentx.json`, then restart AgentX.
- **The card says "Notifications are set up on …"** — this phone is paired with a computer that relays to another. Pair the phone with the host named on the card.
- **The card says "This browser can't receive notifications here"** — on an iPhone, add the app to the Home Screen and open it from there.
- **The card says notifications are blocked** — you tapped **Don't Allow** earlier. Allow notifications for the AgentX app in the phone's settings, then tap **Turn on** again.
- **`agentx notify` says "no phone has turned on notifications"** — turn notifications on in the **Alerts** tab on at least one phone.
- **`agentx notify` says `Unknown channel: "push"`** — notifications aren't turned on on this computer. Follow the setup above, or restart AgentX if you just turned them on.
- **A second computer says "is not a mesh peer of this node"** — the name after `--relay-to` doesn't match. Check it with `agentx mesh list`.
- **Notifications stopped after `agentx app push-keys --force`** — new keys cut off every phone. Open **Alerts** on each phone and tap **Turn on** again.
