# Desktop assistant for macOS

First complete the [desktop prerequisites](../requirements.md#desktop-assistant), choose a [speech backend](../requirements.md#voice-input-and-spoken-replies), and review [macOS permissions](../requirements.md#macos-permissions). Each section includes setup steps and official help.

AgentX Desktop is a menu-bar assistant with voice, smart paste, and native computer-use tools. Hold **Option–Space**, speak, then release to send your question to an AgentX agent. The response appears in a small panel and is spoken aloud. The daemon and the selected agent do the work.

## Install and activate

You need a Mac with Apple Silicon and macOS 14 or newer, a running daemon (the AgentX background service), and at least one agent.

1. **Terminal:** preview what the installer will do, without changing anything:
   ```sh
   agentx desktop install --dry-run
   ```
2. **Terminal:** install it:
   ```sh
   agentx desktop install
   ```
   This builds and installs the app into `~/Applications/AgentX Desktop.app` and its helper into `~/Applications/AgentX Helper.app`, remembers the daemon address, and starts the app at login. If Apple's command-line tools are missing, it tells you how to install them.
3. **Mac:** when macOS asks, allow the microphone.
4. **Mac:** when the helper asks, allow **Accessibility** and **Screen Recording** in System Settings › Privacy & Security.
5. **Mac:** click the AgentX icon in the menu bar and pick the agent to talk to (see [Choose who answers](#choose-who-answers)).
6. Hold **Option–Space**, say a question, then release.

<!-- Screenshot needed: the desktop widget with a spoken answer, and the macOS permission prompts (native macOS app). Not captured: the widget only takes spoken questions and answers through the agent it was installed for, so a capture needs a person speaking to a demo-only install; the permission prompts appear once per Mac and only come back after resetting privacy settings in System Settings. -->

From a source checkout, run `pnpm build` once and replace `agentx` with `node dist/cli.js`.

To tie the app to one agent for good, install with `--agent <id>` (for example `agentx desktop install --agent helper`). The menu then shows that agent and can't switch; run the install again without `--agent` to switch from the menu again.

To manage the app afterwards:

```sh
agentx desktop status
agentx desktop stop
agentx desktop start
```

## Choose who answers

The AgentX icon in the menu bar shows what the assistant is doing: a waveform when idle, a microphone while listening, dots while the agent thinks, and a speaker while it answers. Its menu lists your agents and whether each one is working right now.

![The AgentX menu: three agents with Writer ticked, then Stop speaking, Hold notifications, Show floating pill, Settings…, History… and Quit](/screenshots/voice/menu-bar.png)

1. **Mac:** click the AgentX icon in the menu bar, or press **Command–Option–A**.
2. **Mac:** choose an agent, or press its number (**1** to **9**).
3. Hold **Option–Space** and speak. The panel names the agent while it listens and answers.

The app remembers your choice after a restart. The rest of the menu works from the keyboard too: use the arrow keys and **Return**, or **Escape** to close it.

| Menu item | What it does |
|---|---|
| **Stop speaking** | Silences every voice (see [Stop every voice at once](#stop-every-voice-at-once)) |
| **Hold notifications** | Holds agent notifications until you turn it off |
| **Show floating pill** | Keeps the small panel on screen when idle. Off by default: the panel appears only while listening or answering |
| **Settings…** | Opens the dashboard's [Settings](./settings.md) page |
| **History…** | Opens the dashboard's [Activity](./activity.md) page |

If the daemon isn't running, the menu says **AgentX daemon isn't reachable** and offers **Retry**. Right-clicking the panel opens the same menu.

**Command–Option–V** is smart paste: it reshapes the clipboard for wherever you are typing. It runs the `agentx paste` command, so that command must work. The helper also powers [pointing, screen checks, and guided lessons](../tutorials/record-vscode.md).

## Speech and configuration

| Setting | Default / purpose |
|---|---|
| `AGENTX_DAEMON_URL` | `http://127.0.0.1:18800` |
| `AGENTX_VOICE_AGENT` | Pins the agent the app talks to; the menu can't switch while it is set. `agentx desktop install --agent <id>` sets it. Without it: the agent picked in the menu, else the daemon's `node.defaultAgent`, else the first agent |
| `AGENTX_DASHBOARD_URL` | `http://127.0.0.1:4202`, opened by the menu's **Settings…** and **History…** |
| `ELEVENLABS_API_KEY` | Optional hosted transcription, and speech for agents whose provider is `elevenlabs` |
| `AGENTX_VOICE_ID` | ElevenLabs voice ID for `elevenlabs` agents without `voice.elevenlabsVoiceId` |
| `AGENTX_VOICE_PROVIDER` | `system`; which engine speaks before the daemon has named one (e.g. an error line) |
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper`, the local transcription executable |
| `AGENTX_MLX_MODEL` | `mlx-community/whisper-large-v3-turbo` |
| `AGENTX_VOICE_PATH` | Read by the installer, not the app: the full `PATH` to give the login service. By default, this is the folder of the `ffmpeg` found at install time plus macOS's standard folders |

Without an ElevenLabs key, transcription needs a working local `mlx_whisper` installation. Speech uses the free macOS voices unless you choose ElevenLabs (see [Agent voices](#agent-voices)). ElevenLabs usage and the agent's model usage are separate costs. The app checks the key environment variable first, then `~/.elevenlabs/key` and `~/.agentx/elevenlabs-key.txt`.

The installer persists the pinned agent (if any), daemon URL, helper path, and CLI command in the login service. Finder does not inherit terminal environment variables. Use a key file for speech credentials or configure the login service environment for advanced speech settings.

## Agent voices

Out of the box every agent speaks with a free macOS voice, and each agent gets a different one: the best installed voices first (Premium, then Enhanced, then standard), of the agent's `gender` when it has one, else alternating female and male. Nothing is sent to a speech service and no key is needed.

```bash
agentx voice list                                  # installed voices, best first, and who uses which
agentx voice set helper Daniel                     # pick a system voice
agentx voice set reviewer siri:aaron               # a Siri voice (see below)
agentx voice set support system                    # follow the OS default voice
agentx voice set support Thomas --lang fr          # French lines in Thomas, other lines as before
agentx voice set support --gender female           # an assigned voice will be female
agentx voice set helper <voice-id> --provider elevenlabs   # this agent speaks through ElevenLabs
```

`agentx voice set` edits `agentx.json`; a running daemon reloads it, so the next line uses the new voice.

**Better free voices.**

1. **Mac:** open System Settings › Accessibility › Spoken Content.
2. Next to **System Voice**, open the list and choose **Manage Voices…**.
3. Download a Premium or Enhanced voice (for example Ava, Zoe or Evan).
4. **Terminal:** run `agentx voice list`. The new voice is listed. (AgentX also notices it on its own within ten minutes.)

![The Manage Voices list in System Settings, with voices to download for each language](/screenshots/voice/manage-voices.png)

**Siri voices.** `say -v` cannot use the Siri voices, but `say` without a voice follows the Spoken Content System Voice. So an agent set to `siri:<name>` (listed as `siri:aaron`, `siri:marie`… by `agentx voice list`) speaks each line by switching the System Voice to that Siri voice, speaking, and switching your own choice straight back. Every line that uses the OS default voice, from the daemon and from AgentX Voice, goes through one script (`~/.agentx/voice/siri-say.sh`, written by the daemon) that holds a lock, so two agents never switch it at once; lines wait their turn. If a speaker is killed mid-line, the next line restores your choice first. On a Mac every system-voice line goes through that script, Siri or not: it reads the text before taking the lock (a caller that never closes stdin gives up after 5 s without blocking anyone), stops a line that runs past its length's worth of speech (5 s plus 0.6 s a word, at most 5 minutes), and drops a line that waited more than 30 s rather than play it late. Siri voices are never assigned automatically, only when named. A per-language list works as usual (`"system": { "en": "siri:aaron", "fr": "siri:marie" }`). If the Siri voice is not downloaded, the system voice of the same name speaks instead (`siri:daniel` → Daniel), else the next choice. Download Siri voices in Spoken Content → System Voice → Manage Voices.

**Configuration.** The global `voice` block sets the defaults; each agent's `voice` block overrides them. Every field is optional.

```json
"voice": {
  "provider": "system",
  "fallback": "system",
  "locale": "en",
  "listener": "Sam"
},
"agents": {
  "helper": {
    "voice": {
      "system": { "en": "Daniel", "fr": "Thomas", "ar": "Majed" },
      "provider": "elevenlabs",
      "elevenlabsVoiceId": "<your-elevenlabs-voice-id>",
      "gender": "male",
      "style": "laid-back, dry",
      "intro": "Hello, this is Helper. I answer questions about your projects.",
      "narrate": "on"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `voice.provider` | `system` (default) or `elevenlabs`, for every agent without its own |
| `voice.fallback` | `system` (default): when ElevenLabs cannot speak (no key, quota, network), use the system voice. `none`: stay silent |
| `voice.system` | One system voice (or one per language) for every agent without its own. Unset: each agent gets its own |
| `voice.locale` | Language of assigned voices, e.g. `en`, `fr`, `en-GB` (default `en`) |
| `voice.listener` | Who agents address in talk and live teach, e.g. `"Sam"`. Unset: they say "the user" |
| agent `voice.provider` | Overrides the global provider for this agent |
| agent `voice.system` | This agent's system voice: a name (`Daniel`, `Ava (Premium)`), an identifier from `agentx voice list`, `system` for the OS default voice, or one per language: `{ "en": "Samantha", "fr": "Thomas", "ar": "system" }` |
| agent `voice.gender` | `female`, `male` or `neutral`. An assigned voice, and the global `voice.system`, are used only if they match |

The system voice is chosen in this order: the agent's own, the global `voice.system` if it matches the agent's gender, then one assigned to it. A name that is not installed is skipped, and the daemon log says so once. With `provider: "system"`, no request goes to ElevenLabs, even when a key is set. `meshVoices` entries accept the same `provider`, `system` and `gender` fields.

**Per-language voices.** With a list, each line is spoken by the voice of its language (English, French or Arabic, told apart by script and common words); a line in another language, or one too short to tell, uses the voice for `voice.locale`. An agent's list overrides the global one language by language. A plain name speaks every language. An agent without a voice for `voice.locale` in its list gets one assigned. `agentx voice list` shows each agent's voice with its per-language picks.

An agent introduces itself the first time it speaks in a voice session, or after eight hours of silence, and talks casually after that. Without `intro`, the line is derived from the first sentence of its system prompt.

## Talk mode: two agents talk out loud

In talk mode, two of your agents discuss a topic out loud, like two colleagues thinking something through. You listen, and you can join in at any time. The voices come out of the speakers of the computer that runs the daemon.

During a talk, the agents only talk. They can't run tools, change files or send messages. If something needs doing, they say which of them will do it afterwards.

### Start a talk

1. **Terminal:** list your agents and pick two of them:
   ```sh
   agentx agent list
   ```
2. **Terminal:** start the talk. Put the two agent ids first, then the topic (here the ids are `support` and `reviewer`):
   ```sh
   agentx talk support reviewer "how to prepare tomorrow's demo"
   ```
3. Listen. Each line is spoken in that agent's voice and also printed in the terminal.
4. Wait for the end. The talk ends on its own when the agents agree the topic is settled, or after 10 lines. At the end, the terminal prints how long the pauses between speakers were.

![A terminal showing an agentx talk between two demo agents, CX and Builder: four spoken lines, the pause after each hand-over, and the closing summary of the gaps between speakers](/screenshots/voice/talk-transcript.png)

Either agent can live on another AgentX computer in your mesh (the group of AgentX computers that know each other); its voice still plays on this computer. Only one talk or lesson runs at a time.

| Option | What it does |
|---|---|
| `--context "<text>"` | A few lines of background both agents should know |
| `--turns <n>` | The most lines before they wrap up (default 10; the daemon accepts 2 to 40) |
| `--local` | Run the talk in this terminal instead of in the daemon |
| `-c, --config <path>` | With `--local`: the `agentx.json` file to read the agents from |

### Join in or stop a talk

1. **Mac:** hold **Option–Space**. The talk goes quiet at once.
2. **Mac:** say what you want to add, then release the keys.
3. Listen. The agent you named answers you first. If you named neither, the agent you cut off answers.
4. To end the talk, hold **Option–Space** again and say "stop".

You can also type instead of speaking:

1. **Terminal:** in the window where the talk runs, type a line and press Return. The agents answer it first.
2. **Terminal:** type `stop` and press Return to end the talk, or press Control–C.

If you hold **Option–Space** and then say nothing, the talk carries on by itself after about 20 seconds.

**Why the agents can't hear you by themselves.** The microphone is only on while you hold **Option–Space**. The agents' voices come out of the same speakers the microphone would listen to, so an open microphone would hear the agents and interrupt them with their own words.

**Which model writes the lines.** To keep the pauses short, each line comes from a fast model (Claude Haiku 4.5) with no tools, not from a full agent turn. It runs through the `claude` command-line program with your existing sign-in. To call the model's API directly instead, set `AGENTX_TALK_BACKEND=api` in the daemon's environment. This is faster, but needs an API key or sign-in token that AgentX can find.

## Stop every voice at once

One key stops everything that is speaking on your Mac: the widget's own answer, a talk, a lesson, task narration, and every line waiting its turn. Your macOS voice setting is put back as it was.

1. **Mac:** press **Command–Option–.** (the period key).

Or use the menu instead:

1. **Mac:** click the AgentX icon in the menu bar.
2. **Mac:** choose **Stop speaking**.

Holding **Option–Space** also silences everything before the widget starts listening, but it only pauses the lines waiting their turn (see the next section). To end a lesson from the dashboard, see [Check a running lesson in the browser](#check-a-running-lesson-in-the-browser).

## One queue for everything spoken

Everything spoken aloud on your Mac waits in one line, called the **speaking queue**: the widget's answers, task narration, talks and lessons. Each item plays only when the one before it has finished, so two agents never talk at the same time. If you ask two agents questions back to back, the second answer plays right after the first.

**You come first.** When you hold **Option–Space**, the line being spoken stops and the queue waits. Once you release the keys and the widget has your words, the line that was cut off plays again from the start, followed by everything that was waiting. If you say "stop" instead, everything waiting is dropped. If you say nothing, the queue plays on by itself after a minute at most.

**Command–Option–.** still stops everything and empties the queue.

To see what is speaking and what is waiting:

1. **Terminal:** run `curl -s http://127.0.0.1:18800/voice/queue`.
2. Read the answer. `playing` is the line being spoken now, `waiting` lists the lines still to come, in order, and `recent` lists the last lines that finished. `paused` is `true` while you are speaking.

Each line shows its `id`, the agent (`agentId`), what kind of line it is (`answer`, `narration`, `talk`, `lesson` or `line`), its text and when it joined the queue (`enqueuedAt`).

Agents can check the queue themselves when they need to, using the `agentx_voice_queue` tool of `agentx serve`. It is never added to every message an agent receives.

If the daemon can't be reached, the widget speaks its answer itself, as before.

## Task narration

With narration on, an agent tells you out loud what it is doing while it works on a real task, in its own voice. For example: "I'm reading the latest test results now."

- It says at most one short sentence every 20 seconds.
- It only describes the steps the agent really took since its last sentence. If there is nothing worth saying, it stays silent.
- Before the steps go to the model that writes the sentence, long strings of letters and numbers, and anything written like `password=…` or `token: …`, are blanked out. The model is also told never to read out commands, file paths, code, numbers or anything that looks like a key.
- It stays silent while something else is speaking, such as a talk.
- Questions you ask through the widget are not narrated this way; the widget narrates those itself.

Narration is off until you switch it on.

### Switch narration on for an agent

1. **Terminal:** open `agentx.json` in a text editor.
2. In the agent's `voice` block, add `"narrate": "on"`. Use `"all"` instead to narrate scheduled jobs too (jobs that run on a timer, such as routines).
3. Save the file. A running daemon reloads it.

```json
"agents": {
  "helper": {
    "voice": { "narrate": "on" }
  }
}
```

| `voice.narrate` | What the agent narrates |
|---|---|
| `off` (default) | Nothing |
| `on` | Its tasks, except scheduled jobs |
| `all` | Its tasks, including scheduled jobs |

### Switch it on or off for now

These switches last until the daemon restarts.

1. **Terminal:** switch narration on for one agent (here `helper`):
   ```sh
   agentx narrate helper on
   ```
   Use `off` to silence it, or `default` to go back to what `agentx.json` says. Scheduled jobs stay quiet unless the file says `"all"`.
2. **Browser:** to narrate one task only, even a scheduled one, open the task in the dashboard. Its id is the last part of the address, after `/tasks/`.
3. **Terminal:** switch narration on for that task:
   ```sh
   agentx narrate --task <task-id> on
   ```

Each command prints the switches that are now set, for example `{"agents":{"helper":true},"tasks":{}}`.

To silence a narrating task by voice:

1. **Mac:** hold **Option–Space**. Narration pauses.
2. **Mac:** say "stop", then release the keys. Narration of that task is switched off.

## Presence on screen

An agent can appear on your screen as its own pointer: an arrow in its colour, with its initial, its name, and a speech bubble showing what it says. The **AgentX Helper** app draws it. You can click straight through it, and it never moves your own mouse.

The pointer appears during lessons (see [Live lessons](#live-lessons)), and after a spoken answer when [presence mode](#presence-mode) is on.

![An agent's on-screen pointer beside the Numbers sidebar: an arrow in the agent's colour, a circle with its initial C, its name CX, and a speech bubble with what it is saying](/screenshots/voice/presence-pointer.png)

To change how an agent's pointer looks:

1. **Terminal:** open `agentx.json` in a text editor.
2. In the agent's block, add a `presence` block:
   ```json
   "helper": {
     "presence": { "color": "#7C3AED", "initial": "H", "label": "Helper", "allowActions": false }
   }
   ```
3. Save the file.

| Field | Meaning |
|---|---|
| `color` | The pointer's colour. Default: a colour picked from the agent's id |
| `initial` | The letter on the pointer. Default: the first letter of the label |
| `label` | The name shown. Default: the agent's `name`, else its id |
| `allowActions` | `true` lets the agent click and type for you in `act` mode. Default `false` |

Without `allowActions`, the agent never clicks or types. It shows you where to click and lets you do it.

### Presence mode

Presence mode lets AgentX decide, on each question you ask through the widget, whether the agent should also show something on screen. A small, fast decision model called a seat makes this choice; see [Jev and typed decisions](../architecture/jev.md) for how seats work and how to set up their backend. This seat is named `presence-mode` and is off by default. While it is off, answers are spoken only, and no pointer appears after them.

| Mode | What happens |
|---|---|
| `talk` | The agent answers out loud. Its pointer rests in a corner with the answer in its bubble |
| `teach` | A live lesson: the agent points at each step and says it; you do it |
| `watch` | You work; the agent coaches you and points at what you need |
| `act` | The agent does the steps itself. Only when `allowActions` is `true`; otherwise the answer is `talk` |
| `quiet` | Nothing appears on screen |

Some safety rules always apply:

- A lesson (`teach` or `watch`) starts only when you ask to be shown something, for example "show me how…", "how do I…", "where is…", "walk me through…" or "montre-moi…". An instruction such as "merge and deploy the release" is always answered as `talk`.
- If the seat is unsure (below 55% confidence), takes longer than 2.5 seconds, or fails, the answer is `talk`.
- After a `talk` answer, the pointer disappears once the answer has had time to be heard. If the seat expects the conversation to go on, it stays, quietly, for up to 5 minutes.

To switch presence mode on:

1. **Terminal:** open `agentx.json` in a text editor.
2. Add the seat under `decisions`:
   ```json
   "decisions": { "seats": { "presence-mode": { "mode": "active", "backend": "typesafe" } } }
   ```
   Use `"mode": "shadow"` to try it first: the daemon log records what the seat would choose, without acting on it.
3. **Terminal:** restart the daemon so the seat is set up with its backend.

## Live lessons

In a live lesson, an agent teaches you how to do something in an app, one step at a time, with no script written in advance:

1. The agent reads the app's window: the buttons and fields macOS lists for accessibility tools, or the text it can read from a screenshot when that list is short.
2. A fast model plans the next single step.
3. The agent's pointer moves to the right control, or outlines it, while the agent says the step.
4. The agent waits for the screen to change (you did the step). In `act` mode with `allowActions` set, it does the step itself.
5. The window is read again, and the next step starts from what is really there.

A lesson stays in the app it started in. If you switch to another app, the agent asks you to bring it back and waits without doing anything else. After 45 seconds it ends. A lesson stops after 12 steps unless you set another limit.

A lesson starts in one of two ways: when presence mode chooses `teach`, `watch` or `act` for your question, or from a terminal.

### Start a lesson from the terminal

1. **Terminal:** run the lesson. This example opens Numbers and teaches in your assistant agent's voice:
   ```sh
   agentx teach --live "make a simple table of monthly expenses" --app Numbers --agent helper --mode teach
   ```
2. **Mac:** follow the spoken steps in the app. The terminal prints each step as it happens.

![A live lesson in progress: a Numbers table on the left, the agent's pointer labelled C and CX between the windows, and the terminal on the right printing each step as it happens](/screenshots/voice/live-lesson.png)

| Option | What it does |
|---|---|
| `--live "<goal>"` | What the lesson should teach |
| `--mode <mode>` | `teach` (default, you do each step), `watch` (you drive, it coaches), `act` (it does the steps, if `allowActions` is `true`) or `draw` (see below) |
| `--app <name>` | Open this app first and teach in it. Without it, the lesson uses the app in front when it starts |
| `--agent <id>` | The agent who teaches. Default: your assistant agent (set with `AGENTX_VOICE_AGENT` in the terminal's environment), else the node's default agent (`node.defaultAgent`) |
| `--steps <n>` | The most steps before it stops (default 12) |
| `-c, --config <path>` | The `agentx.json` file to read the agent from |

**Drawing mode.** With `--mode draw`, the agent draws an illustration of the goal in the tldraw offline app instead, with its pointer moving over each shape as it appears. It saves a `.tldraw` file and a `.png` picture in your Documents folder. `--out <folder>` picks another folder, and `--model <id>` another planning model (default `claude-sonnet-5`). The tldraw offline app must be installed.

### Interrupt or end a lesson

1. **Mac:** hold **Option–Space**. The lesson ends at once and the screen is yours again.
2. **Mac:** say your question, then release the keys. It goes to the agent as a normal question.

Pressing **Command–Option–.** also ends a lesson. In the terminal where it runs, type `stop` and press Return, or press Control–C.

### Check a running lesson in the browser

1. **Browser:** open the dashboard's [Live](./live.md) tab.
2. Find the agent's card. A running lesson shows **on screen**, the mode, the step number and what the agent is saying.
3. To end it, select **✕ stop** on that line.

![The Live tab with the cx agent's card showing a running lesson: "on screen · teach · step 0", the lesson's goal, and its ✕ stop button](/screenshots/voice/live-tab-lesson.png)

## For automations (Siri, Shortcuts, scripts)

The daemon offers these addresses for talks, lessons and narration. Requests from the same Mac need nothing more. Requests from another computer need the mesh token, the same as `/ask`.

| Address | What it does |
|---|---|
| `POST /talk` | Start a talk: `{"agents": ["<id>", "<id>"], "topic": "…", "context": "…", "maxTurns": 10}` |
| `GET /talk` | The running talk or lesson: what was said, its state and the pauses |
| `POST /talk/stop` | End the talk |
| `POST /teach/live` | Start a lesson: `{"agent": "<id>", "goal": "…", "mode": "teach", "app": "Numbers"}` (`draw` is terminal only) |
| `POST /voice/hush` | Silence whatever is speaking, pause the speaking queue and wait for your words (what **Option–Space** sends when pressed) |
| `POST /voice/door` | `{"text": "…"}`: your words for the talk or lesson; the queue plays on. `stop` ends the talk or lesson and empties the queue |
| `POST /voice/stop` | Silence every voice and empty the speaking queue (what **Command–Option–.** sends) |
| `GET /voice/queue` | The speaking queue: `{"paused", "playing", "waiting", "recent"}` |
| `POST /voice/queue` | Add a line in an agent's voice: `{"text": "…", "agentId": "<id>", "kind": "answer"}`. `kind` is `answer`, `narration` or `line`. Add `"wait": true` to get the reply only once the line has been spoken (`{"item", "played"}`) |
| `POST /voice/queue/<id>/skip` | Drop that line, whether it is playing or waiting. The others keep their order |
| `POST /voice/queue/<id>/front` | Play that waiting line next |
| `POST /voice/queue/<id>/replay` | Say a waiting or recently finished line again, next |
| `POST /voice/queue/pause`, `POST /voice/queue/resume` | Hold the queue, or let it play on. A held queue plays on by itself after a minute |
| `GET /narration`, `POST /narration` | Read or set narration switches: `{"agentId": "<id>", "on": true}` or `{"taskId": "<id>", "on": null}` |

`/talk/hush` and `/talk/door` still work as older names for `/voice/hush` and `/voice/door`.

Every change to the speaking queue is also sent on the live event stream (`GET /events`) as a `voice` event whose message has `"kind": "voice:queue"` and the same fields as `GET /voice/queue`.

## Check it worked

1. **Terminal:** run `agentx desktop status`. It prints the login service's details. `Installed, but not running` or `Not installed` means it isn't running.
2. **Mac:** click the AgentX icon in the menu bar. Your agents are listed and one is ticked.
3. Hold **Option–Space**, ask "What can you do?", then release.
4. The answer appears in the panel, under the ticked agent's name, and is spoken aloud.
5. **Browser:** the question shows on the dashboard's [Live](./live.md) tab under your agent.
6. **Terminal:** to check talk mode, run `agentx talk <first-agent-id> <second-agent-id> "say hello"`. Both agents speak, and the terminal prints their lines.
7. **Terminal:** to check the speaking queue, run `curl -s -X POST http://127.0.0.1:18800/voice/queue -H 'Content-Type: application/json' -d '{"text": "First line.", "agentId": "<agent-id>"}'` twice in quick succession, then `curl -s http://127.0.0.1:18800/voice/queue`. You hear both lines one after the other, and the second shows under `waiting` until the first has finished.

## If something is wrong

- **No recording:** check the microphone permission in System Settings › Privacy & Security › Microphone, and hold the shortcut while speaking.
- **"Sorry, I didn't hear that":** transcription failed and nothing was sent. Check your ElevenLabs key, or the local Whisper program and model.
- **Local Whisper fails:** **Terminal:** run `agentx doctor`. If it reports `ffmpeg not reachable by the desktop app`, install FFmpeg (for example `brew install ffmpeg`) and run `agentx desktop install` again.
- **Agent unavailable:** check the daemon address, then pick another agent from the menu. If the menu can't switch, the app was installed with `--agent`; run the install again without it.
- **The menu says the daemon isn't reachable:** **Terminal:** run `agentx daemon status`, start the daemon, then choose **Retry**.
- **A daemon on another machine refuses it:** the widget can't send a mesh token yet. Use a daemon on the same Mac.
- **Voices talk over something else, or won't stop:** press **Command–Option–.**, or choose **Stop speaking** from the AgentX menu.
- **An answer is late to play:** another line is ahead of it in the speaking queue. **Terminal:** run `curl -s http://127.0.0.1:18800/voice/queue` to see what is ahead. If `paused` is `true` and you are not speaking, run `curl -s -X POST http://127.0.0.1:18800/voice/queue/resume`.
- **`Unknown agent: …` from `POST /voice/queue`:** the `agentId` must be an agent on this computer or on a connected mesh computer. Check the id with `agentx agent list`.
- **`A talk or lesson is already running`:** only one runs at a time. Wait for it to end, or press **Command–Option–.** to stop it.
- **`Unknown agent: …` from `agentx talk` or `agentx teach --live`:** check the id with `agentx agent list`. For `agentx talk`, an agent on another computer must be reachable: check that its computer shows in `agentx mesh list`.
- **A talk never starts speaking:** the lines come from the `claude` program. **Terminal:** run `claude --version` on the daemon's computer and sign in if needed, or set `AGENTX_TALK_BACKEND=api`.
- **No pointer appears after an answer:** presence mode is off, or the seat chose `talk` with low confidence. Look for `[presence]` lines in the daemon log.
- **A lesson says "Bring … to the front":** click the app the lesson started in; it carries on.
- **The agent never clicks in `act` mode:** set `"allowActions": true` in the agent's `presence` block.
- **Narration stays silent:** check `voice.narrate` for the agent, or run `agentx narrate <agent-id> on`. Scheduled jobs need `"all"`, and questions from the widget are never narrated this way.
