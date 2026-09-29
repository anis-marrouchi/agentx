# Share your phone camera

The [phone app](./mobile-app.md) can show what your phone's camera sees on another computer that runs AgentX. Use it to look at something from your desk while someone else, or you, holds the phone: a server rack, a cable, a document.

The picture goes straight from the phone to the other computer. It doesn't pass through AgentX and isn't saved. The camera opens only when you tap **Start camera**, and a red bar with a **Stop** button stays on screen the whole time it is live.

This is the first step of [issue #325](https://github.com/anis-marrouchi/agentx/issues/325). An agent can't look at the camera yet.

## Before you start

- Install and pair the [phone app](./mobile-app.md). The phone must open it over `https://` (the `tailscale serve` setup in that guide), or the browser won't give it the camera.
- You need two AgentX computers in the same *mesh* (the private link between your AgentX computers), sharing a mesh token. See [Add a second machine](../jobs/second-machine.md). The phone is paired with one of them. You watch on the other.
- Turn calls on for **both** computers. In each computer's `agentx.json`:
  ```json
  { "channels": { "webrtc": { "enabled": true } } }
  ```
  Then restart AgentX on that computer (`agentx daemon restart`). A config reload isn't enough to turn calls on.
- So you get the link to watch, set `channels.webrtc.ringNotify` on the computer you watch from, for example your Telegram chat. The options are in [the calls settings](../reference/config-channels.md#browser-calls-webrtc).

## Share the camera

1. **Phone:** open the app and tap the camera button (📷) at the top right.
2. **Phone:** under **Show it on**, pick the computer you will watch from.

   ![The Share camera sheet with one computer to pick](/screenshots/mobile-app/camera-sheet.png)

3. **Phone:** tap **Start camera**. The first time, the phone asks to use the camera: allow it. The back camera opens and a red bar says **Camera live on …** with the time left.
4. **Other computer:** you get a message such as "📷 my-mac is sharing a phone camera — tap to watch" with a link. Open it on that computer and click **Join**.

   ![The watch page on the other computer showing the phone's camera](/screenshots/mobile-app/camera-watch.png)

5. **Phone:** the sheet now says **… is watching**. Tap **Flip camera** to switch between the back and front cameras.

   ![The phone while its camera is live, with the red bar and the Stop button](/screenshots/mobile-app/camera-live.png)

The phone waits until you open the link, so you can take your time.

## Stop sharing

Any of these stops the camera at once:

- **Phone:** tap **Stop** in the red bar.
- **Other computer:** click **Hang up**.
- **Phone:** leave the app or lock the screen. The app never uses the camera in the background.
- The time limit runs out (10 minutes by default).

## Settings

Under `channels.webrtc.camera` in `agentx.json`, on the computer the phone is paired with:

| Key | Default | What it does |
|---|---|---|
| `width`, `height` | `1280`, `720` | Picture size the phone asks for. |
| `frameRate` | `15` | Frames per second the phone asks for. |
| `maxSeconds` | `600` | The share stops after this many seconds. |

`channels.webrtc.allowedCallers` on the watching computer limits which computers may share with it.

## Check it worked

1. **Phone:** tap 📷. The computer you expect is listed under **Show it on**.
2. **Phone:** tap **Start camera**. The red bar appears and the time left counts down.
3. **Other computer:** open the link and click **Join**. The phone's picture appears, and the page's log ends with `pc[…] state: connected`.
4. **Phone:** tap **Stop**. The red bar goes away and the phone's camera light turns off.

## If something is wrong

- **"Calls are off on this computer"** — set `channels.webrtc.enabled` to `true` on the computer the phone is paired with, then restart AgentX there (`agentx daemon restart`).
- **"No other machine to show it on"** — this computer has no mesh peer. Add one as in [Add a second machine](../jobs/second-machine.md).
- **"This browser cannot share its camera here"** — the app was opened over `http://`. Open it from the `https://` address that `tailscale serve` gives you.
- **"Camera access was refused"** — allow the camera for the app, or for Safari, in the phone's settings, then try again.
- **"Could not reach …"** — AgentX isn't running on the other computer, or the mesh token differs. Check with `agentx mesh list`.
- **No message with a link arrives** — `channels.webrtc.ringNotify` isn't set on the other computer. You can still watch: open `/call?to=<phone's computer>&callId=<id>&watch=1` on it. The id is in its AgentX log, in the line `ring received for call=<id>`.
- **The page says connected but stays black, or "The connection … failed"** — the two devices can't reach each other directly. Put both on the same tailnet, or add a relay under `channels.webrtc.turnServers`.
