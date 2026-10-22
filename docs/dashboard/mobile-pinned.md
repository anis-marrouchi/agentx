# Pinned pages

A *pinned page* is a web page you open often, shown as a button at the top of the [phone app](./mobile-app.md). One tap opens it inside the app, so you don't have to look for the link in your browser. A good example is a small tool page served by another of your machines on your *tailnet* (the private network Tailscale makes between your devices), such as a remote control or a status board.

![How a pinned page opens: you serve the page over https and pin it once; then you tap its button, the page opens inside the AgentX app, and it asks for the microphone if it needs it](/diagrams/pinned-page.svg)

## What you need

- The [phone app](./mobile-app.md) set up and paired.
- The page's address. It must start with `https://`. A browser only lets a page use the microphone on a secure (`https`) address, and AgentX refuses any other kind.
- If the page is on your tailnet: Tailscale turned on on the phone. AgentX never opens the page itself; your phone does.

## Pin a page from the phone

1. **Phone:** in the phone app, open **Alerts**. The **Pinned pages** card lists your pinned pages.
   ![The Pinned pages card in the Alerts tab, with one page from agentx.json and one added in the app](/screenshots/mobile-app/pinned.png)
2. **Phone:** tap **Pin a page**.
3. **Phone:** in **Button name**, type a short name, such as `Kitchen timer`. Keep it under 40 characters.
4. **Phone:** in **Address**, type the page's address, starting with `https://`.
5. **Phone:** tap **Pin page**.
   ![The Pin a page form with a name and an address filled in](/screenshots/mobile-app/pinned-add.png)

Every phone paired with this computer gets the same buttons.

## Pin a page in agentx.json

Use this to set buttons for every phone without touching one.

1. **Computer:** open `agentx.json` and add the page under `app.pinned.pages`:
   ```json
   {
     "app": {
       "pinned": {
         "pages": [
           { "label": "Status board", "url": "https://status.example.ts.net/" }
         ]
       }
     }
   }
   ```
2. **Terminal (computer):** restart AgentX:
   ```sh
   agentx daemon stop && agentx daemon start --detach
   ```
3. **Phone:** close the phone app and open it again. The button appears.

A page set in `agentx.json` shows on the **Pinned pages** card with **Set in agentx.json**. You rename or remove it in `agentx.json`, not in the app.

## Open a pinned page

1. **Phone:** open the phone app. It opens on **Chat**, with your buttons under the AgentX title.
   ![The phone app's Chat tab with two pinned-page buttons under the title](/screenshots/mobile-app/pinned-strip.png)
2. **Phone:** tap a button. The page opens inside the app.
3. **Phone:** if the page uses the microphone (for example a hold-to-talk button), the phone asks the first time. Tap **Allow**.
4. **Phone:** to come back to AgentX, close the page (the **×** at the top in the Android app) or use the phone's **Back** gesture.

Where the page opens depends on how you use the phone app:

| How you open AgentX | Where the page opens |
|---|---|
| The AgentX Android app | In the app's own window, shown by Chrome, with a close button at the top. |
| Installed on an iPhone home screen | In a browser sheet over the app. |
| A browser tab | In the same tab. **Back** returns to AgentX. |

The buttons also show when the phone is offline, from the last time the app loaded them. The pages themselves need a connection.

## Rename or remove a pinned page

1. **Phone:** on the **Pinned pages** card in **Alerts**, under the page, tap **Rename or remove**.
2. **Phone:** to rename it, change **Button name** and tap **Save name**.
3. **Phone:** to remove it, tap **Remove**, then confirm.
   ![The rename form under a pinned page, with Remove and Save name](/screenshots/mobile-app/pinned-rename.png)

For a page set in `agentx.json`, change its `label` there, or delete its entry, and restart AgentX.

## Settings

All in `agentx.json`, under `app.pinned`. Each one is described in the [configuration reference](../reference/config-channels.md#app).

| Setting | Default | What it changes |
|---|---|---|
| `app.pinned.enabled` | `true` | Pinned pages on or off for every phone. |
| `app.pinned.pages` | none | Buttons set here, each a `label` and an `https://` `url`. |
| `app.pinned.max` | `12` | Most buttons, counting both kinds. |
| `app.pinned.file` | `.agentx/pinned.json` | Where pages pinned from the phone are kept. |

## Check it worked

1. **Phone:** open the phone app. Your button shows under the AgentX title on **Chat**.
2. **Phone:** tap it. The page opens inside the app.
3. **Phone:** if the page uses the microphone, use it once. The phone asks for permission, and the page hears you after you tap **Allow**.

## If something is wrong

- **"The address must start with https://"** — the page is served over plain `http`. Serve it over `https`; on a tailnet, `tailscale serve` on the machine that hosts the page does this.
- **"That page is already pinned"** — a button with the same address exists, in the app or in `agentx.json`.
- **"You already have 12 pinned pages"** — remove one, or raise `app.pinned.max` in `agentx.json` and restart AgentX.
- **"This page is set in agentx.json"** — that button comes from `app.pinned.pages`. Change or remove it there and restart AgentX.
- **No buttons on the screen** — the buttons show on **Chat** only. Open the **Chat** tab. If they still don't show, check the **Pinned pages** card in **Alerts**.
- **"Pinned pages are off on this computer (app.pinned.enabled)"** — set `app.pinned.enabled` to `true` in `agentx.json`, or remove the line, and restart AgentX.
- **The page doesn't load** — the phone can't reach it. Turn Tailscale on on the phone, and check that the address opens in the phone's browser.
- **The page can't hear you** — the microphone was refused. Then:
  1. **Phone (Android):** open Android settings, then **Apps**, then **Chrome**, then **Permissions**, and allow **Microphone**. Open the page again.
  2. **Phone (Android):** if Chrome already has it, open the page, tap the lock or settings icon at the top, and allow the microphone for that site.
  3. **Phone (iPhone):** open **Settings**, then **Safari** (under **Apps** on newer iPhones), then **Microphone**, and choose **Ask** or **Allow**.
