# Get notified

`agentx notify` taps you on the shoulder. It does three things:

1. It checks whether you are in Focus. If you are, it **holds** the message instead of dropping it, and delivers everything held as one message when Focus ends.
2. It pushes the message to your phone through [ntfy](https://ntfy.sh).
3. On a Mac, it shows a banner and plays a short sound, because a push to a phone in another room is not a notification to someone at the keyboard.

You can set everything below in the dashboard or with the CLI. Both write the same `agentx.json`.

## 1. Phone push (ntfy)

Install the ntfy app on your phone and subscribe to a topic. On the public `ntfy.sh` server, anyone who knows the topic name can read it, so pick a long random name and treat it like a password. If you run your own ntfy server, use its URL and, for a protected topic, an access token.

Keep the topic and token out of `agentx.json` by putting them in the `.env` file next to it:

```sh
NTFY_TOPIC=agentx-8f3c1e0a9b7d
NTFY_TOKEN=tk_your_token_here   # only for a protected topic
```

::: info In the browser
Open **Settings → Channels → Notifications routing**. Under **Phone push (ntfy)**, tick **enabled**, set the server, and type `${NTFY_TOPIC}` as the topic (and `${NTFY_TOKEN}` as the token if you need one). Select **Save notifications**, then restart the daemon ([how](../first-agent.md)). The form never shows a saved topic or token again; it only says whether one is set.
:::

::: info Terminal
```sh
agentx notifications ntfy --topic '${NTFY_TOPIC}' --token '${NTFY_TOKEN}' --enable
agentx daemon stop && agentx daemon start --detach
```
Add `--server https://ntfy.example.com` for your own server. `--token ""` removes a token, and `--disable` turns the channel off. Use single quotes so your shell does not expand `${…}`: AgentX reads the value from `.env` when it starts.
:::

You can also put the literal topic in the field instead of `${NTFY_TOPIC}`. The value is then stored in `agentx.json`, so do not commit or share that file.

## 2. Banner and sound on the Mac

This part is on by default: a banner, and the Glass sound at volume 0.4. Other platforms skip it without an error.

::: info In the browser
In the same **Notifications routing** section, under **On this Mac**, tick or untick **show a banner** and **play a sound**. Choose the sound by name from `/System/Library/Sounds` (Glass, Ping, Tink, Submarine…) and a volume from 0 to 1.
:::

::: info Terminal
```sh
agentx notifications local --banner on --sound on --sound-name Tink --volume 0.6
agentx notifications show
```
:::

The first banner comes from **Script Editor**, because macOS attributes `osascript` notifications to it. If no banner appears, open **System Settings → Notifications → Script Editor** and allow notifications with the **Banners** style. Do Not Disturb hides banners too.

`agentx notify` waits for the banner and the sound to finish before it exits (about two seconds). A job that runs `agentx notify` and then ends straight away, such as a `launchctl submit` job that removes itself, still gets both.

`agentx notify` reads these settings from `./agentx.json`. When it runs from another folder, as scheduled jobs do, pass `-c /path/to/agentx.json`. Without a config it uses the defaults.

## 3. Focus

A held message gets no push, no banner and no sound. It waits until Focus ends. `--urgent` goes through anyway.

AgentX reads Focus from two places:

- **macOS Focus / Do Not Disturb.** macOS keeps this in a private file. To read it, the app that runs `agentx` (Terminal, iTerm, or the daemon's host) needs **Full Disk Access** in **System Settings → Privacy & Security**. Without that access, AgentX reports that it cannot read Focus and never holds a message, so nothing is lost.
- **A manual hold.** Create `~/.agentx/focus.json` containing `{"active": true}` to hold messages without turning on macOS Focus. Delete the file, or set `"active": false`, to release them.

The daemon checks every 30 seconds. When Focus ends, it sends everything held as one message per destination, with one banner and one sound.

## 4. Send one

```sh
agentx notify "Build finished" --title "CI"
agentx notify "Production is down" --title "Alert" --urgent
agentx notify --status        # Focus state and anything held
agentx notify --flush         # deliver what is held now
```

| Option | What it does |
|---|---|
| `--title <text>` | Notification title (default `AgentX`) |
| `--priority <1-5>` | ntfy priority (default 4) |
| `--urgent` | Deliver even during Focus |
| `--from <who>` | Shown in a held digest so a backlog is attributable |
| `--channel`, `--chat-id` | Deliver somewhere other than ntfy |
| `--no-banner`, `--no-sound` | Skip the local banner or sound for this call |
| `-c <path>` | Read the banner and sound settings from this `agentx.json` |
| `--json` | Print the result as JSON |

The push goes through the running daemon. If the daemon is down, the command exits with an error, but the banner and sound still play so you know something tried to reach you.

## Check it worked

1. Run `agentx notifications show`. It should list `ntfy on` with the topic `set`, and your banner and sound settings.
2. Run `agentx notify "hello" --title "Test"`. The phone should buzz and a banner should appear on the Mac.
3. Create `~/.agentx/focus.json` containing `{"active": true}`, send another message, and check that it is held (`agentx notify --status`). Delete the file. Within 30 seconds the held message arrives.
