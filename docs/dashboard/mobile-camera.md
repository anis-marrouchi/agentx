# Share your phone camera

The [phone app](./mobile-app.md) can show what your phone's camera sees to another computer that runs AgentX, or to one of your agents. Use it to look at something from your desk while someone else, or you, holds the phone: a server rack, a cable, a document. An agent can tell you what it sees ("the third port is empty", "this invoice is for 240 euros") and, once you allow it, can ask you to show it something.

The camera opens only when you tap **Start camera** or **Show**, and a red bar with a **Stop** button stays on screen the whole time it is live. The app never uses the camera in the background: leaving the app stops the share.

When you show the camera to another computer, the picture goes straight from the phone to that computer and isn't saved. When you show it to an agent, the agent doesn't get a video: it gets one picture each time you ask it something (or when it asks for one), and the pictures are deleted when the share ends unless you turn `keepFrames` on. If you ask nothing, the agent gets no pictures at all.

With an agent, you ask by voice: hold **Talk**, say your question, let go. The agent's answer shows on the sheet and is read aloud, in one or two short sentences. The microphone is on only while you talk, and your voice is never part of the camera share.

## Before you start

- Install and pair the [phone app](./mobile-app.md). The phone must open it over `https://` (the `tailscale serve` setup in that guide), or the browser won't give it the camera.
- Turn calls on for the computer the phone is paired with. In its `agentx.json`:
  ```json
  { "channels": { "webrtc": { "enabled": true } } }
  ```
  Then restart AgentX on that computer (`agentx daemon restart`). A config reload isn't enough to turn calls on.
- To show the camera to **another computer**, you need two AgentX computers in the same *mesh* (the private link between your AgentX computers), sharing a mesh token, with calls turned on on both. See [Add a second machine](../jobs/second-machine.md). So you get the link to watch, set `channels.webrtc.ringNotify` on the computer you watch from, for example your Telegram chat. The options are in [the calls settings](../reference/config-channels.md#browser-calls-webrtc).
- To show the camera to an **agent**, the agent must live on the computer the phone is paired with. That computer needs the `@roamhq/wrtc` package, which AgentX installs with itself; the sheet tells you if it is missing.

## Show the camera to another computer

1. **Phone:** open the app and tap the **Share camera** button at the top of **Chat**.
2. **Phone:** under **Show it to**, pick the computer you will watch from.

   ![The Share camera sheet with one computer to pick](/screenshots/mobile-app/camera-sheet.png)

3. **Phone:** tap **Start camera**. The first time, the phone asks to use the camera: allow it. The back camera opens and a red bar says **Camera live on …** with the time left.
4. **Other computer:** you get a message such as "📷 my-mac is sharing a phone camera — tap to watch" with a link. Open it on that computer and click **Join**.

   ![The watch page on the other computer showing the phone's camera](/screenshots/mobile-app/camera-watch.png)

5. **Phone:** the sheet now says **… is watching**. Tap **Flip camera** to switch between the back and front cameras.

   ![The phone while its camera is live, with the red bar and the Stop button](/screenshots/mobile-app/camera-live.png)

The phone waits until you open the link, so you can take your time.

## Let an agent look

1. **Phone:** tap the **Share camera** button at the top of **Chat**.
2. **Phone:** under **Show it to**, pick the agent. Agents are listed as **Agent: …** after the computers.

   ![The Share camera sheet with an agent picked](/screenshots/mobile-app/camera-agent-pick.png)

3. **Phone:** tap **Start camera**. The red bar says **… is watching**, and after a moment the sheet says the agent can see the camera.
4. **Phone:** point the camera at what you want the agent to see.
5. **Phone:** press and hold the blue **Talk** button, ask your question, then let go. The button turns red and says **Listening…** while it hears you. The first time, the phone asks to use the microphone: allow it.

   ![The Talk button while the phone is listening](/screenshots/mobile-app/camera-talk.png)

   If holding is awkward, tap **Talk** once, speak, and tap it again to send.
6. **Phone:** wait a few seconds. The agent gets one picture, the newest, and its answer shows on the sheet (newest first) and is read aloud.

   ![The agent's short answer under the picture, with the question above it](/screenshots/mobile-app/camera-agent-reply.png)

7. **Phone:** ask again whenever you like. Each question sends one fresh picture. **Look now** sends a picture without a question; the agent then says briefly what it sees.
8. **Phone:** tap **Stop** when you are done.

### Type instead of talking

1. **Phone:** tap **Type instead**. A text box replaces the Talk button. The phone remembers this choice.
2. **Phone:** type your question and tap **Look now**.

   ![The text box under the picture, after tapping Type instead](/screenshots/mobile-app/camera-typing.png)

3. **Phone:** tap **Talk instead** to go back to voice.

The phone shows the text box by itself when it can't record (for example over `http://`), or when `voiceInput` is off (see [Settings](#settings)).

### Turn spoken answers off

1. **Phone:** tap **Answers aloud: on**. It changes to **off**, and answers only show as text. The phone remembers this choice.
2. **Phone:** tap it again to hear answers.

An agent with an ElevenLabs voice answers in that voice. Otherwise the phone reads the answer with its own voice. Tapping **Talk** stops an answer that is being read.

### Let the agent keep watching for a minute

Some tasks need more than one picture, for example "tell me if I miss a screw while I put this together". For those, turn on continuous watching for a short while:

1. **Phone:** ask your question with **Talk** first, so the agent knows what to watch for.
2. **Phone:** tap **Keep watching 1 min**. The red bar adds **continuous** with its own countdown, and the button changes to **Stop watching**.

   ![Keep watching on: the red bar shows a second countdown and the button says Stop watching](/screenshots/mobile-app/camera-keep-watching.png)

3. **Phone:** carry on. The agent gets a picture every few seconds (`streamFrameSeconds`) and speaks up only when something matters.
4. **Phone:** it stops by itself after `streamMaxSeconds` (60 by default). Tap **Stop watching** to end it sooner. After that, the agent is back to one picture per question.

Each picture during this time is a turn of the agent, so it is never on unless you tap the button. A turn uses the agent's AI plan or credits, just like a chat message. With the default settings, one minute of **Keep watching** is about 12 turns (one every 5 seconds). At the longest allowed time, 600 seconds (10 minutes), that becomes about 120 turns. To spend less, raise `streamFrameSeconds` or lower `streamMaxSeconds` (see [Settings](#settings)).

The agent answers one picture at a time. If you ask a question with **Talk** while it is still looking at a picture, your question waits until that answer is done, then goes next.

Replaying an answer you have already heard does not use the agent's voice credits again: the computer keeps the last few spoken answers for a while.

While you share, the agent can also take a picture by itself from inside its own work, for example when you ask it something in chat or by voice: it runs `agentx camera look`, gets the newest picture, and opens it. Its answer comes back where you asked. An agent gets a picture by itself on a timer only if you set `frameIntervalSeconds` (see [Settings](#settings)); each of those pictures is a turn of the agent, so the default is off.

The share ends after `maxSessionMinutes` (10 by default) even if the phone's own limit is longer.

## When an agent asks to see

An agent that needs to see something can ask you, the same way an agent [calls you](./calls.md). Nobody can ask until you allow them, and the camera opens only when you tap **Show**.

1. **Terminal:** go to the folder that holds `agentx.json` and allow the agent, replacing `writer` with your agent's id:
   ```sh
   agentx call allow writer
   ```
   This is the same list as for calls (`calls.allow`). `agentx call disallow writer` takes it back.
2. **Phone:** when the agent asks, a blue bar appears at the top of the app with the agent's name and what it wants to see. You also get a notification, the same way `agentx notify` sends one.

   ![The phone app with a bar saying an agent wants to see through the camera, with Show and Decline](/screenshots/mobile-app/camera-ask-bar.png)

3. **Phone:** tap **Show**. The camera sheet opens with that agent already picked, the camera starts, and the agent's request is filled in as your question.

   ![The camera live for the agent that asked, with its request as the question](/screenshots/mobile-app/camera-ask-live.png)

4. **Phone:** point the camera and tap **Look now**, or let the agent take its own picture. Its answer goes back to the chat it asked from, and shows on the sheet when you tapped Look now.
5. **Phone:** tap **Stop** when you are done. That ends the agent's request too.

Tap **Decline** instead to turn the request down. A request nobody answers counts as missed after `calls.ringSeconds` (45 seconds by default), and a request that isn't urgent waits until Focus ends. Each agent can ask, or call, at most `calls.maxPerHour` times an hour, and only one request or call at a time.

Agents ask through the `agentx_camera_ask` tool, which AgentX gives them, or with `agentx camera ask --reason "…"` inside their run. As with calls, a request counts only when it comes from a turn of that agent that is running now.

## Stop sharing

Any of these stops the camera at once:

- **Phone:** tap **Stop** in the red bar.
- **Other computer:** click **Hang up**.
- **Phone:** leave the app or lock the screen. The app never uses the camera in the background.
- **Terminal:** `agentx camera stop <id>` ends an agent's watch (`agentx camera watching` lists them).
- The time limit runs out: 10 minutes by default for the phone, and 10 minutes for an agent's watch.

## Settings

Under `channels.webrtc.camera` in `agentx.json`, on the computer the phone is paired with:

| Key | Default | What it does |
|---|---|---|
| `width`, `height` | `1280`, `720` | Picture size the phone asks for. |
| `frameRate` | `15` | Frames per second the phone asks for. |
| `maxSeconds` | `600` | The share stops after this many seconds. |
| `voiceInput` | `true` | Ask a watching agent by voice with **Talk**. `false` shows only the text box. |
| `speakAnswers` | `true` | Read the watching agent's answers aloud. Each phone can still turn it off with **Answers aloud**. |

For an agent watching, under `channels.webrtc.camera.bot`:

| Key | Default | What it does |
|---|---|---|
| `frameIntervalSeconds` | `0` | How often the agent gets a picture by itself, in seconds. `0` means only when you tap **Look now** or the agent asks for one. |
| `maxSessionMinutes` | `10` | The agent's watch ends after this many minutes. |
| `maxFrameEdge` | `1024` | Pictures are shrunk so their longer side is at most this many pixels. |
| `keepFrames` | `false` | Keep the picture files in the agent's workspace, under `.agentx/camera/`, after the share ends. |
| `streamFrameSeconds` | `5` | While **Keep watching** is on, the agent gets a picture this often, in seconds. |
| `streamMaxSeconds` | `60` | **Keep watching** stops by itself after this many seconds. |

Who may ask to see, and how often, is under `calls` ([reference](../reference/config-automation.md#calls)). `channels.webrtc.allowedCallers` on the watching computer limits which computers may share with it.

## Check it worked

1. **Phone:** tap 📷. The computer or the agent you expect is listed under **Show it to**.
2. **Phone:** pick the agent and tap **Start camera**. The red bar says **… is watching** and the time left counts down.
3. **Phone:** hold **Talk**, ask "What do you see?", and let go. Within a few seconds the agent's answer appears on the sheet and is read aloud.
4. **Terminal:** on the computer the phone is paired with, run `agentx camera watching`. The share is listed with its frames and looks: one look per question.
5. **Terminal:** in the AgentX log on that computer, each picture the agent got has a line such as `[camera] helper gets frame 120 of share cam-… (asked)`. Before you ask anything, there is no such line: the log only says the agent is watching with `frames on demand`.
6. **Phone:** tap **Stop**. The red bar goes away and the phone's camera light turns off.
7. **Terminal:** run `agentx call allow <agent>`, then ask that agent in chat to show you its camera request (it uses `agentx_camera_ask`). The blue bar appears on the phone; tap **Show**, then **Stop**. `agentx camera list` shows the request as `ended`.

## If something is wrong

- **"Calls are off on this computer"** — set `channels.webrtc.enabled` to `true` on the computer the phone is paired with, then restart AgentX there (`agentx daemon restart`).
- **"No other machine or agent to show it to"** — this computer has no mesh peer and no agent. Add one as in [Add a second machine](../jobs/second-machine.md), or add an agent.
- **"This browser cannot share its camera here"** — the app was opened over `http://`. Open it from the `https://` address that `tailscale serve` gives you.
- **"Camera access was refused"** — allow the camera for the app, or for Safari, in the phone's settings, then try again.
- **"could not join the share: WebRTC bot requires @roamhq/wrtc"** — the package is missing on that computer. In the AgentX folder, run `pnpm add @roamhq/wrtc`, then restart AgentX.
- **"no picture has arrived from the phone yet"** — you asked in the first second. Wait a moment and ask again.
- **"The microphone is blocked"** — allow the microphone for the app, or for Safari, in the phone's settings. Until then, tap **Type instead**.
- **"Speech to text …" or "No words were heard"** — this computer can't turn speech into text yet, or the recording was empty. See [What the computer needs for voice](./mobile-chat.md#what-the-computer-needs-for-voice) for the speech to text setup, hold **Talk** for the whole question, or tap **Type instead**.
- **No Talk button, only the text box** — the app was opened over `http://`, the browser can't record, or `voiceInput` is `false`.
- **Answers show but aren't read aloud** — check that **Answers aloud** says **on**, that the phone's ring switch isn't on silent, and that the volume is up.
- **"continuous" stays in the red bar** — it counts down and stops by itself; tap **Stop watching** to end it now.
- **"… did not answer"** — the agent's turn failed. Check the agent in the dashboard's Live page and try again.
- **"… is already watching a camera"** — that agent still has a share open. `agentx camera watching` lists it and `agentx camera stop <id>` ends it.
- **The agent's request never shows on the phone** — the agent isn't allowed yet (`may not ask to see`: run `agentx call allow <agent>`), or the app is closed. Open the app; the bar shows while the request is waiting. `agentx camera list --status missed` shows requests that timed out.
- **"Could not reach …"** — AgentX isn't running on the other computer, or the mesh token differs. Check with `agentx mesh list`.
- **No message with a link arrives** — `channels.webrtc.ringNotify` isn't set on the other computer. You can still watch: open `/call?to=<phone's computer>&callId=<id>&watch=1` on it. The id is in its AgentX log, in the line `ring received for call=<id>`.
- **The page says connected but stays black, or "The connection … failed"** — the two devices can't reach each other directly. Put both on the same tailnet, or add a relay under `channels.webrtc.turnServers`.
