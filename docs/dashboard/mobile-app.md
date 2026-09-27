# Phone app

The phone app is a small version of the dashboard that you install on an Android phone or an iPhone straight from the browser. There is no app store. It has four tabs: **Chat**, **Fleet**, **Activity** and **Alerts**. This first version installs the app and pairs your phone; the tabs fill in with later updates.

The phone reaches your computer over [Tailscale](https://tailscale.com/kb/1017/install), a free private network (a *tailnet*) that links your own devices. Nothing is opened to the public internet.

![The phone app in light and dark themes](/screenshots/mobile-app/app-light.png)

## What you need

- The [dashboard](./index.md) running on a computer that stays on.
- Tailscale installed and signed in to the same account on that computer and on the phone ([install Tailscale](https://tailscale.com/kb/1017/install)).
- HTTPS certificates turned on for your tailnet ([enable HTTPS](https://tailscale.com/kb/1153/enabling-https)). Phones only install apps from `https://` addresses.

## Install

1. **Terminal (computer):** give the phone app, and only the phone app, a private HTTPS address on your tailnet. `4202` is the dashboard's port (`dashboard.port` in `agentx.json`):
   ```sh
   tailscale serve --bg --set-path /app http://127.0.0.1:4202/app
   tailscale serve --bg --set-path /api/app http://127.0.0.1:4202/api/app
   ```
   Don't run `tailscale serve --bg 4202`. That shares the whole dashboard with every device on your tailnet, and most of the dashboard trusts anything that arrives through the computer. If you ran it before, run `tailscale serve reset` first. `agentx app pair` refuses to run while the whole dashboard is shared. See [Tailscale Serve](https://tailscale.com/kb/1312/serve) for details.
2. **Terminal (computer):** from the folder that holds `agentx.json`, pair the phone and give it a name you'll recognise:
   ```sh
   agentx app pair --name "My phone"
   ```
   A QR code appears. It uses this computer's Tailscale name. To use another address, add `--url https://<address>`.
3. **Phone:** open the camera, point it at the QR code, and tap the link it shows.
4. **Phone:** wait for the app to open. You'll see **AgentX** at the top with your phone's name under it.
5. **Phone:** add the app to the home screen:
   - **iPhone (Safari):** tap **Share**, then **Add to Home Screen**, then **Add**.
   - **Android (Chrome):** tap the **⋮** menu, then **Install app** (or **Add to Home screen**), then **Install**.
6. **Terminal (computer):** clear the terminal so nobody else can scan the code:
   ```sh
   clear
   ```

Anyone who scans the code can use the app until you remove it, so treat it like a password.

## Use it

- Tap a tab at the bottom to switch sections. With a keyboard, use the **Left** and **Right** arrow keys.
- Tap **◐** in the top-right corner to switch between light and dark themes.
- The app still opens without a connection. A yellow bar says it's offline, and live information returns when the phone reconnects.

![The phone app in the dark theme](/screenshots/mobile-app/app-dark.png)

## Manage paired phones

Each phone gets its own key, so you can remove one without affecting the others.

1. **Terminal (computer):** from the folder that holds `agentx.json`, list paired phones:
   ```sh
   agentx app devices
   ```
2. **Terminal (computer):** remove a phone using the id from that list (it starts with `tok_`):
   ```sh
   agentx app revoke tok_1a2b3c4d
   ```

The phone is locked out as soon as it next connects.

## How access works

The app and its data (`/app` and `/api/app/…`) always need the phone's key, even from the computer itself. That matters because `tailscale serve` passes every phone request through the computer, so the dashboard can't tell a phone from a local browser by address alone. The key only opens the phone app. The rest of the dashboard isn't shared on the tailnet at all: step 1 passes on only `/app` and `/api/app/…`, and every other address answers "404 page not found".

The QR code carries the key after a `#` in the link, which browsers never send to the server, so it doesn't end up in logs. The phone then keeps it in a cookie that page scripts can't read.

## Check it worked

1. **Terminal (computer):** run `agentx app devices`. Your phone is listed as `active`.
2. **Phone:** open the app from the home screen. Your phone's name and the computer's name show under **AgentX**.
3. **Phone:** open `https://<computer's Tailscale name>/` (the same address without `/app`). The page says `404 page not found`, so the rest of the dashboard isn't shared.

## If something is wrong

- **"Could not read this machine's Tailscale name"** — Tailscale isn't running on the computer. Start it, or pass `--url https://<address>` to `agentx app pair`.
- **The link doesn't open on the phone** — the phone isn't connected to your tailnet. Open the Tailscale app on the phone and turn it on.
- **"This phone isn't paired"** — the phone was removed, or the pairing code was used on another folder's AgentX. Run `agentx app pair` again from the folder that holds `agentx.json`.
- **"This pairing code is not valid any more"** — the code was revoked. Run `agentx app pair` again and scan the new code.
- **"tailscale serve publishes the whole dashboard"** — `agentx app pair` found an earlier `tailscale serve --bg 4202`. Run `tailscale serve reset`, then repeat step 1 of [Install](#install).
- **The address without `/app` opens the dashboard** — the whole dashboard is shared on your tailnet. On the computer, run `tailscale serve reset`, then repeat step 1 of [Install](#install).
- **No "Install app" or "Add to Home Screen" option** — the address isn't `https://`. Use the address from `tailscale serve`, not `http://127.0.0.1:4202`.

![The page a phone sees when it isn't paired](/screenshots/mobile-app/not-paired.png)
