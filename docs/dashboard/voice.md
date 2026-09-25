# Desktop assistant for macOS

First complete the [desktop prerequisites](../requirements.md#desktop-assistant), choose a [speech backend](../requirements.md#voice-input-and-spoken-replies), and review [macOS permissions](../requirements.md#macos-permissions). Each section includes setup steps and official help.

AgentX Desktop is a floating assistant with voice, smart paste, and native computer-use tools. Hold **Option–Space**, speak, then release to send your question to an AgentX agent. The response appears in the widget and is spoken aloud. The daemon and the selected agent do the work.

## Install and activate

On **Apple Silicon with macOS 14 or newer**, run:

```sh
agentx desktop install --agent coder-agent
```

The command builds and installs the desktop app and computer-use helper, remembers the agent and daemon URL, and starts the app at login. Use an ID from `agentx agent list`. Apple command-line tools are required; if missing, the command explains how to install them. The daemon and the selected agent must already be configured.

From a source checkout, build once with `pnpm build`, then use `node dist/cli.js desktop install --agent coder-agent`. Installed versions 0.28.0 and newer use the shorter `agentx` form.

```sh
agentx desktop status
agentx desktop stop
agentx desktop start
```

Preview installation without changing anything using `agentx desktop install --agent coder-agent --dry-run`. Rerun install to change the selected agent. The app is installed into `~/Applications/AgentX Desktop.app` and the helper into `~/Applications/AgentX Helper.app`.

Grant microphone access for voice, and Accessibility / Screen Recording permissions when the computer-use helper asks. Hold **Option–Space** to speak. **Command–Option–V** invokes smart paste. The helper also powers [pointing, screen checks, and guided lessons](../tutorials/record-vscode.md).

## Speech and configuration

| Setting | Default / purpose |
|---|---|
| `AGENTX_DAEMON_URL` | `http://127.0.0.1:18800` |
| `AGENTX_VOICE_AGENT` | `secretary-agent`; change it if that agent does not exist |
| `ELEVENLABS_API_KEY` | Optional hosted transcription, and speech for agents whose provider is `elevenlabs` |
| `AGENTX_VOICE_ID` | ElevenLabs voice ID for `elevenlabs` agents without `voice.elevenlabsVoiceId` |
| `AGENTX_VOICE_PROVIDER` | `system`; which engine speaks before the daemon has named one (e.g. an error line) |
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper`, the local transcription executable |
| `AGENTX_MLX_MODEL` | `mlx-community/whisper-large-v3-turbo` |

Without an ElevenLabs key, transcription needs a working local `mlx_whisper` installation. Speech uses the free macOS voices unless you choose ElevenLabs (see [Agent voices](#agent-voices)). ElevenLabs usage and the agent's model usage are separate costs. The app checks the key environment variable first, then `~/.elevenlabs/key` and `~/.agentx/elevenlabs-key.txt`.

The installer persists the chosen agent, daemon URL, helper path, and CLI command in the login service. Finder does not inherit terminal environment variables. Use a key file for speech credentials or configure the login service environment for advanced speech settings.

## Agent voices

Out of the box every agent speaks with a free macOS voice, and each agent gets a different one: the best installed voices first (Premium, then Enhanced, then standard), of the agent's `gender` when it has one, else alternating female and male. Nothing is sent to a speech service and no key is needed.

```bash
agentx voice list                                  # installed voices, best first, and who uses which
agentx voice set coder-agent Daniel                # pick a system voice
agentx voice set secretary-agent system            # follow the OS default voice
agentx voice set devops-agent siri:aaron           # a Siri voice of its own (see below)
agentx voice set cx-agent Thomas --lang fr         # French lines in Thomas, other lines as before
agentx voice set cx-agent --gender female          # an assigned voice will be female
agentx voice set coder-agent <voice-id> --provider elevenlabs   # this agent speaks through ElevenLabs
```

`agentx voice set` edits `agentx.json`; a running daemon reloads it, so the next line uses the new voice.

**Better free voices.** Open System Settings → Accessibility → Spoken Content → System Voice → Manage Voices and download a Premium or Enhanced voice (for example Ava, Zoe or Evan). They are picked up within ten minutes, or on the next `agentx voice list`.

**Siri voices.** macOS does not offer Siri voices to other apps, and `say -v` cannot use them. But `say` without `-v` speaks with the Spoken Content System Voice, and that can be a Siri voice. So an agent can have a Siri voice of its own: name it `siri:<name>` (for example `siri:aaron`, or `{ "en": "siri:nora", "fr": "siri:marie", "ar": "siri:soha" }`). For each line, AgentX switches the System Voice for that language to the agent's Siri voice, speaks, then puts your own selection back.
- **One line at a time.** Lines are spoken one at a time across the daemon, `agentx teach` and the desktop app, which asks the daemon to speak Siri lines, so two agents never switch the voice at once.
- **Recovery.** If a speaker stops mid-line, the next one restores your selection first.
- **Which voices.** `agentx voice list` shows the Siri voices installed on this Mac (download more in Spoken Content → System Voice → Manage Voices). They are never assigned automatically.
- **Not installed.** If a named Siri voice is missing, the regular voice of the same name and language speaks instead, if there is one; otherwise the next choice does.
- **Sharing the System Voice.** While an agent speaks, the System Voice is the agent's, so VoiceOver or Speak Selection used at that moment speaks in it too.
- **The OS default.** `system` still means your own System Voice for that agent.

**Configuration.** The global `voice` block sets the defaults; each agent's `voice` block overrides them. Every field is optional.

```json
"voice": {
  "provider": "system",
  "fallback": "system",
  "locale": "en"
},
"agents": {
  "coder-agent": {
    "voice": {
      "system": { "en": "Daniel", "fr": "Thomas", "ar": "Majed" },
      "provider": "elevenlabs",
      "elevenlabsVoiceId": "CwhRBWXzGAHq8TQ4Fs17",
      "gender": "male",
      "style": "laid-back, dry",
      "intro": "Hello, this is Coder. I write and fix the code for your projects.",
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
| agent `voice.provider` | Overrides the global provider for this agent |
| agent `voice.system` | This agent's system voice: a name (`Daniel`, `Ava (Premium)`), an identifier from `agentx voice list`, `system` for the OS default voice, or one per language: `{ "en": "Samantha", "fr": "Thomas", "ar": "system" }` |
| agent `voice.gender` | `female`, `male` or `neutral`. An assigned voice, and the global `voice.system`, are used only if they match |

The system voice is chosen in this order: the agent's own, the global `voice.system` if it matches the agent's gender, then one assigned to it. A name that is not installed is skipped, and the daemon log says so once. With `provider: "system"`, no request goes to ElevenLabs, even when a key is set. `meshVoices` entries accept the same `provider`, `system` and `gender` fields.

**Per-language voices.** With a list, each line is spoken by the voice of its language (English, French or Arabic, told apart by script and common words); a line in another language, or one too short to tell, uses the voice for `voice.locale`. An agent's list overrides the global one language by language. A plain name speaks every language. An agent without a voice for `voice.locale` in its list gets one assigned. `agentx voice list` shows each agent's voice with its per-language picks.

An agent introduces itself the first time it speaks in a voice session, or after eight hours of silence, and talks casually after that. Without `intro`, the line is derived from the first sentence of its system prompt.

## Talk mode

Two agents talk a topic through out loud on the daemon's host:

```bash
agentx talk secretary-agent marketing-agent "how to open tomorrow's demo"
```

Each line comes from a fast model with no tools (Haiku 4.5), spoken sentence by sentence in each agent's voice (ElevenLabs Flash for `elevenlabs` agents). The next speaker writes its reply while the current one is still talking, so hand-overs take milliseconds, not a full agent turn. Agents cannot act during a talk; they say who will do something afterwards.

**The door.** Hold **Option–Space** in AgentX Voice while a talk runs: the talk goes quiet as soon as you press, and what you say goes to the talk instead of to your agent. The agent you name answers you first, or else the one you cut off. Say "stop" to end the talk. From the CLI, type a line to do the same.

There is no hands-free barge-in. The agents' voices come out of the same speakers the microphone would listen to, and the audio plays in a separate process, so echo cancellation has no reference signal to subtract. An open microphone would hear the agents and interrupt them with their own words.

The model runs as one warm `claude -p` per speaker on the subscription login. Set `AGENTX_TALK_BACKEND=api` to call the Messages API through the provider layer instead; that is faster, but needs an API key or OAuth token the provider can resolve.

| Endpoint | |
|---|---|
| `POST /talk` | `{agents: [a, b], topic, context?, maxTurns?}` starts a talk; one at a time |
| `GET /talk` | transcript, state, and measured gaps |
| `POST /talk/hush` | go quiet now (the app sends this on key-down) |
| `POST /talk/door` | `{text}`: the listener spoke; `stop` ends the talk |
| `POST /talk/stop` | end it |

These use the same mesh-token gate as `/ask`.

## Task narration

While an agent works on a real task, it can say what it is doing in its own voice: at most one short line every 20 seconds, written only from the tool steps it actually took since the last line. Paths, commands and anything that looks like a key are neither spoken nor sent to the model.

Narration is off unless switched on. `voice.narrate: "on"` narrates the agent's work except cron jobs; `"all"` includes cron. Turns started from the voice app are not narrated this way, because the app narrates those itself. At runtime:

```bash
agentx narrate coder-agent on        # or off, or default
agentx narrate --task <taskId> on    # one task, including a cron run
```

The same switches are available at `GET/POST /narration`.

## Presence on screen

An agent can appear on screen as its own cursor: an arrow in its colour, its initial, its name, and a bubble with what it is saying. It is drawn by the Mac helper, is click-through, and never moves your mouse.

```json
"coder-agent": {
  "presence": { "color": "#7C3AED", "initial": "C", "label": "Coder", "allowActions": false }
}
```

All fields are optional; the colour and initial are derived from the agent otherwise. `allowActions` lets the agent click and type for you in `act` mode. It is off by default, and without it `act` becomes `teach`.

### Presence mode

On every voice turn the `presence-mode` seat decides how the agent shows up:

| Mode | What happens |
|---|---|
| `talk` | Voice only; the cursor rests in a corner with the answer in its bubble |
| `teach` | A live lesson: the agent shows each step with its cursor and says it; you do it |
| `watch` | You drive; the agent coaches, pointing at what you need |
| `act` | The agent does the steps itself, if `allowActions` is set |
| `quiet` | Nothing on screen |

The seat also answers whether the cursor stays after the turn and what the first action is (speak, point, highlight, click, type, wait for you). The chosen mode's probability is logged on every turn; below 0.55, or when the seat is off, slow (2.5 s budget) or down, the turn is plain `talk`. Enable it in `agentx.json`:

```json
"decisions": { "seats": { "presence-mode": { "mode": "active", "backend": "typesafe" } } }
```

`shadow` logs the decision without acting on it.

### Live teach

`teach`, `watch` and `act` run a lesson with no script: the agent reads the focused window (accessibility tree, OCR when the tree is thin), a fast model plans one step, the agent points or highlights while saying it, then waits for the screen to change (you did it) or does it itself (`act`). The screen is read again after every step. A lesson stays on the app it started in: while another app is in front it asks you to bring it back, and does nothing else.

Hold **Option–Space** to cut in: the agent stops mid-sentence, and its next step answers you. Say "stop" to end the lesson.

```bash
agentx teach --live "make a simple table of monthly expenses" --app Numbers --agent coder-agent --mode teach
```

The daemon runs the same lesson at `POST /teach/live {agent, goal, mode}`, behind the `/ask` gate.

## If it does not answer

- **No recording:** check macOS microphone permission and hold the shortcut while speaking.
- **Transcription fails:** check your ElevenLabs key or the local Whisper executable and model.
- **Agent unavailable:** check the daemon URL and the exact agent ID.
- **Remote daemon rejects it:** the current widget client has no configurable mesh bearer token; use the local daemon path for this setup.

The app also registers **Command–Option–V** for smart paste through `agentx paste`; this needs a working AgentX CLI and its own permissions. Voice is a native macOS client, separate from the dashboard's WebRTC `/call` page.
