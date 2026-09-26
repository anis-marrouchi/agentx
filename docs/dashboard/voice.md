# Desktop assistant for macOS

First complete the [desktop prerequisites](../requirements.md#desktop-assistant), choose a [speech backend](../requirements.md#voice-input-and-spoken-replies), and review [macOS permissions](../requirements.md#macos-permissions). Each section includes setup steps and official help.

AgentX Desktop is a floating assistant with voice, smart paste, and native computer-use tools. Hold **Option–Space**, speak, then release to send your question to an AgentX agent. The response appears in the widget and is spoken aloud. The daemon and the selected agent do the work.

## Install and activate

You need a Mac with Apple Silicon and macOS 14 or newer, a running daemon (the AgentX background service), and at least one agent.

1. **Terminal:** list your agents and note the id of the one you want to talk to:
   ```sh
   agentx agent list
   ```
2. **Terminal:** preview what the installer will do, without changing anything (here the agent id is `helper`):
   ```sh
   agentx desktop install --agent helper --dry-run
   ```
3. **Terminal:** install it:
   ```sh
   agentx desktop install --agent helper
   ```
   This builds and installs the app into `~/Applications/AgentX Desktop.app` and its helper into `~/Applications/AgentX Helper.app`, remembers the agent and daemon address, and starts the app at login. If Apple's command-line tools are missing, it tells you how to install them.
4. **Mac:** when macOS asks, allow the microphone.
5. **Mac:** when the helper asks, allow **Accessibility** and **Screen Recording** in System Settings › Privacy & Security.
6. Hold **Option–Space**, say a question, then release.

<!-- Screenshot needed: the desktop widget with a spoken answer, and the macOS permission prompts. Not capturable from the docs demo (native macOS app). -->

From a source checkout, run `pnpm build` once and replace `agentx` with `node dist/cli.js`. To change the agent later, run the install again with another `--agent`.

To manage the app afterwards:

```sh
agentx desktop status
agentx desktop stop
agentx desktop start
```

**Command–Option–V** is smart paste: it reshapes the clipboard for wherever you are typing. The helper also powers [pointing, screen checks, and guided lessons](../tutorials/record-vscode.md).

## Speech and configuration

| Setting | Default / purpose |
|---|---|
| `AGENTX_DAEMON_URL` | `http://127.0.0.1:18800` |
| `AGENTX_VOICE_AGENT` | The agent the app talks to. `agentx desktop install` sets it; without it the app falls back to a built-in id that probably isn't one of your agents |
| `ELEVENLABS_API_KEY` | Optional hosted transcription, and speech for agents whose provider is `elevenlabs` |
| `AGENTX_VOICE_ID` | ElevenLabs voice ID for `elevenlabs` agents without `voice.elevenlabsVoiceId` |
| `AGENTX_VOICE_PROVIDER` | `system`; which engine speaks before the daemon has named one (e.g. an error line) |
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper`, the local transcription executable |
| `AGENTX_MLX_MODEL` | `mlx-community/whisper-large-v3-turbo` |
| `AGENTX_VOICE_PATH` | Read by the installer, not the app: the full `PATH` to give the login service. By default, this is the folder of the `ffmpeg` found at install time plus macOS's standard folders |

Without an ElevenLabs key, transcription needs a working local `mlx_whisper` installation. Speech uses the free macOS voices unless you choose ElevenLabs (see [Agent voices](#agent-voices)). ElevenLabs usage and the agent's model usage are separate costs. The app checks the key environment variable first, then `~/.elevenlabs/key` and `~/.agentx/elevenlabs-key.txt`.

The installer persists the chosen agent, daemon URL, helper path, and CLI command in the login service. Finder does not inherit terminal environment variables. Use a key file for speech credentials or configure the login service environment for advanced speech settings.

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

<!-- Screenshot needed: System Settings › Accessibility › Spoken Content › Manage Voices. Not capturable from the docs demo. -->

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

## Talk mode

Two agents talk a topic through out loud on the daemon's host:

```bash
agentx talk support reviewer "how to open tomorrow's demo"
```

Each line comes from a fast model with no tools (Haiku 4.5), spoken sentence by sentence in each agent's voice (ElevenLabs Flash for `elevenlabs` agents). The next speaker writes its reply while the current one is still talking, so hand-overs take milliseconds, not a full agent turn. Agents cannot act during a talk; they say who will do something afterwards.

**The door.** Hold **Option–Space** in AgentX Voice while a talk runs: the talk goes quiet as soon as you press, and what you say goes to the talk instead of to your agent. The agent you name answers you first, or else the one you cut off. Say "stop" to end the talk. From the CLI, type a line to do the same.

**Stop speaking.** Press **⌘⌥.** in AgentX Voice, or choose *Stop speaking* from its right-click menu, to silence every voice at once: its own answer, the line holding the speaker, a talk, a lesson or narration, and every line queued behind them. The voice setting is restored. Siri or a Shortcut can do the same with `POST /voice/stop`. Option–Space stops everything the same way before it listens.

There is no hands-free interrupting (no "barge-in"). The agents' voices come out of the same speakers the microphone would listen to, and the audio plays in a separate process, so echo cancellation has no reference signal to subtract. An open microphone would hear the agents and interrupt them with their own words.

The model runs as one warm `claude -p` per speaker on the subscription login. Set `AGENTX_TALK_BACKEND=api` to call the Messages API through the provider layer instead; that is faster, but needs an API key or OAuth token the provider can resolve.

| Endpoint | |
|---|---|
| `POST /talk` | `{agents: [a, b], topic, context?, maxTurns?}` starts a talk; one at a time |
| `GET /talk` | transcript, state, and measured gaps |
| `POST /talk/hush` | go quiet now (the app sends this on key-down) |
| `POST /talk/door` | `{text}`: the listener spoke; `stop` ends the talk |
| `POST /talk/stop` | end it |
| `POST /voice/stop` | silence every voice on the host and drop queued lines; nothing waits for the door |

These use the same mesh-token gate as `/ask`.

## Task narration

While an agent works on a real task, it can say what it is doing in its own voice: at most one short line every 20 seconds, written only from the tool steps it actually took since the last line. Paths, commands and anything that looks like a key are neither spoken nor sent to the model.

Narration is off unless switched on. `voice.narrate: "on"` narrates the agent's work except cron jobs; `"all"` includes cron. Turns started from the voice app are not narrated this way, because the app narrates those itself. At runtime:

```bash
agentx narrate helper on             # or off, or default
agentx narrate --task <taskId> on    # one task, including a cron run
```

The same switches are available at `GET/POST /narration`.

## Presence on screen

An agent can appear on screen as its own cursor: an arrow in its colour, its initial, its name, and a bubble with what it is saying. It is drawn by the Mac helper, is click-through, and never moves your mouse.

```json
"helper": {
  "presence": { "color": "#7C3AED", "initial": "H", "label": "Helper", "allowActions": false }
}
```

All fields are optional; the colour and initial are derived from the agent otherwise. `allowActions` lets the agent click and type for you in `act` mode. It is off by default, and without it `act` becomes `teach`.

### Presence mode

On every voice turn the `presence-mode` seat decides how the agent shows up. A seat is a small, fast decision model that answers one fixed question; see [Jev and typed decisions](../architecture/jev.md).

| Mode | What happens |
|---|---|
| `talk` | Voice only; the cursor rests in a corner with the answer in its bubble |
| `teach` | A live lesson: the agent shows each step with its cursor and says it; you do it |
| `watch` | You drive; the agent coaches, pointing at what you need |
| `act` | The agent does the steps itself, if `allowActions` is set; otherwise the turn is `talk` and the agent does the work in its own turn |
| `quiet` | Nothing on screen |

The seat also answers whether the cursor stays after the turn and what the first action is (speak, point, highlight, click, type, wait for you). The chosen mode's probability is logged on every turn; below 0.55, or when the seat is off, slow (2.5 s budget) or down, the turn is plain `talk`. Enable it in `agentx.json`:

```json
"decisions": { "seats": { "presence-mode": { "mode": "active", "backend": "typesafe" } } }
```

`"mode": "shadow"` is a trial mode: it logs the decision without acting on it.

A lesson (`teach` or `watch`) starts only when you ask to be shown or coached: "show me how…", "how do I…", "where is…", "walk me through…", "montre-moi…". An instruction such as "merge and deploy 40" is always `talk`, whatever the seat chose.

### Live teach

`teach`, `watch` and `act` run a lesson with no script: the agent reads the focused window (the list of buttons and fields macOS exposes to assistive tools, or text recognised from a screenshot when that list is thin), a fast model plans one step, the agent points or highlights while saying it, then waits for the screen to change (you did it) or does it itself (`act`). The screen is read again after every step. A lesson stays on the app it started in: while another app is in front it asks you to bring it back, and does nothing else.

Hold **Option–Space** to cut in: the lesson ends at once, the screen is yours again, and what you say goes to the agent. **⌘⌥.** ends it too, and so does **✕ stop** on the agent's card in [Live](./live.md), which shows a running lesson with its step and what it is saying.

```bash
agentx teach --live "make a simple table of monthly expenses" --app Numbers --agent helper --mode teach
```

The daemon runs the same lesson at `POST /teach/live {agent, goal, mode}`, behind the `/ask` gate.

Smart paste (**Command–Option–V**) runs through `agentx paste`; it needs a working AgentX command and its own permissions. The desktop assistant is a native macOS app, separate from the dashboard's `/call` page (calls in the browser).

## Check it worked

1. **Terminal:** run `agentx desktop status`. It prints the login service's details. `Installed, but not running` or `Not installed` means it isn't running.
2. Hold **Option–Space**, ask "What can you do?", then release.
3. The answer appears in the widget and is spoken aloud.
4. **Browser:** the question shows on the dashboard's [Live](./live.md) tab under your agent.

## If something is wrong

- **No recording:** check the microphone permission in System Settings › Privacy & Security › Microphone, and hold the shortcut while speaking.
- **"Sorry, I didn't hear that":** transcription failed and nothing was sent. Check your ElevenLabs key, or the local Whisper program and model.
- **Local Whisper fails:** **Terminal:** run `agentx doctor`. If it reports `ffmpeg not reachable by the desktop app`, install FFmpeg (for example `brew install ffmpeg`) and run `agentx desktop install` again.
- **Agent unavailable:** check the daemon address and the exact agent id, then run the install again with the right `--agent`.
- **A daemon on another machine refuses it:** the widget can't send a mesh token yet. Use a daemon on the same Mac.
- **Voices talk over something else, or won't stop:** press **⌘⌥.**, or choose **Stop speaking** from the widget's right-click menu.
