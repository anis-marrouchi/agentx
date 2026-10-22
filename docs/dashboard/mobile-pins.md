# Pinned pages

A *pinned page* is a button in the [phone app](./mobile-app.md) that opens a web page you chose: a tool page on your tailnet, a status page, a remote control for another machine. One tap opens it inside the app, without looking for the link in the browser.

The buttons sit in a row under the app's header, on the **Chat** tab, where the app opens. You add, rename and remove them in **Alerts**, on the **Pinned pages** card.

## Pin a page

1. Open the phone app and go to **Alerts**.
2. On the **Pinned pages** card, tap **Pin a page**.
3. Type a **Button name** (up to 40 characters) and the **Page address**. Only `https://` addresses can be pinned.
4. Tap **Pin page**. The button shows under the header on **Chat**.

To rename or remove a button, tap **Rename** or **Remove** next to it on the same card.

You can also do it from the computer, in the folder that holds `agentx.json`:

```bash
agentx app pin "Remote" https://my-mac.tailnet-name.ts.net/remote
agentx app pins            # lists them, with their ids
agentx app unpin Remote    # by name or id
```

The phone shows a change the next time the app opens or comes back to the screen.

## How the page opens

- **In the AgentX Android app**, the page opens in the app's own window. A page on the same address as the phone app opens full screen; a page on another address opens with a slim bar at the top that shows its address. The back gesture returns to the phone app.
- **In the phone app installed from the browser**, the page opens in the same window, or, on an iPhone, in the app's built-in browser.

The page is opened by your phone directly. The computer only keeps the list of buttons; it never loads or passes on the page.

## Pages that use the microphone

A page that asks for the microphone (for example a hold-to-talk button) gets the browser's own question the first time: tap **Allow**. The answer is kept for that page's address, so it doesn't ask again. The browser only allows the microphone on `https://` pages, which is why only those can be pinned.

If the page says the microphone is blocked, open the browser's site settings for that address and allow the microphone there. In the AgentX Android app, that is Chrome's site settings; Chrome itself must also be allowed to use the microphone in Android's settings.

## Keep the address private

Some addresses work as a key: anyone who has the link can use the page. The list of buttons is kept on the computer in `.agentx/app-pins.json`, readable only by you, and given only to phones paired with this computer. AgentX never writes the addresses or the button names to its logs, and the phone app sends no referrer when it opens one.

## Settings

| Field | Default | What it does |
|---|---|---|
| `app.pins.file` | `".agentx/app-pins.json"` | Where the buttons are kept, relative to the folder that holds `agentx.json`. |
| `app.pins.max` | `12` | Most buttons you can pin (1 to 50). |
