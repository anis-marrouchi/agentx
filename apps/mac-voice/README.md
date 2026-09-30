# AgentX Desktop assistant

Install and activate from your AgentX configuration directory:

```sh
agentx desktop install --agent writer
```

This installs the desktop app and native computer-use helper and saves the chosen
agent for login startup. Use `agentx desktop status`, `start`, or `stop` afterward.
From a source checkout, build the CLI and use `node dist/cli.js desktop install`.
See [the desktop guide](../../docs/dashboard/voice.md).

The remaining sections describe developer builds of the voice component.

## Voice component

A floating push-to-talk widget for macOS. Hold **⌥Space**, speak, release —
your words go to an agentx agent and its answer is spoken back.

## What it is

A thin client over the daemon's existing `/ask` endpoint. The server
already prepends a VOICE MODE instruction and flattens its reply for TTS
(`toSpeakable`), so this app deliberately does no prompt shaping — two
places deciding how an agent sounds is how they drift apart.

```
⌥Space held  →  mic capture (16 kHz mono WAV)
             →  STT   ElevenLabs Scribe, falling back to on-device mlx-whisper,
                      or Parakeet (Core ML) when voice.localStt says so
             →  POST /ask  { message, agent }      [loopback: no token needed]
             →  TTS   the agent's macOS voice via `say`; ElevenLabs when the
                      daemon says the agent uses it, falling back to `say`
```

The native helper supplies computer-use capabilities; the desktop app supplies
voice, hotkeys, and status UI. See the public guide for the current boundaries.

## Build

```bash
./build.sh
open "build/AgentX Voice.app"
```

Run the binary directly to watch what it's doing:

```bash
"./build/AgentX Voice.app/Contents/MacOS/AgentXVoice"
```

## Configuration

All optional; every one has a working default.

| variable | default | meaning |
|---|---|---|
| `AGENTX_DAEMON_URL` | `http://127.0.0.1:18800` | daemon to ask |
| `AGENTX_VOICE_AGENT` | — | pins the agent that answers; unset: the one picked in the menu bar, else the daemon's default, else its first agent |
| `AGENTX_DASHBOARD_URL` | `http://127.0.0.1:4202` | opened by the menu's Dashboard… and the History window's Open task in dashboard |
| `ELEVENLABS_API_KEY` | `~/.elevenlabs/key` | STT, and TTS for `elevenlabs` agents; absent → local fallbacks |
| `AGENTX_VOICE_ID` | Rachel | ElevenLabs voice for an `elevenlabs` agent with no `voice.elevenlabsVoiceId` |
| `AGENTX_VOICE_PROVIDER` | `system` | engine for lines spoken before the daemon names one |
| `AGENTX_MODELS_DIR` | `~/.agentx/models` | where Silero VAD and Parakeet are downloaded |
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper` | offline STT |

The ElevenLabs key is read from the environment first, then key files: an app launched from
Finder inherits nothing from your login shell, so an env-only design works
from a terminal and fails mysteriously when double-clicked.

## Talking to other agents

Say "talk to Researcher" (or "switch to Ops", "put me through to …") and the
following turns go to that agent, local or on a mesh peer, until "back to
Writer". The daemon does the switch, per voice session, and answers at
once in the new agent's voice. A remote agent runs its turn on its own node
over the mesh; its voice is spoken here. Name or pin a remote voice in
`agentx.json`:

```json
"meshVoices": { "researcher": { "name": "Researcher", "elevenlabsVoiceId": "…", "style": "calm" } }
```

Unset, a remote agent's intro comes from its agent card and it gets a
system voice (and an ElevenLabs voice, for the `elevenlabs` provider) that no
local agent and no other remote uses.

## Incoming calls

An agent the owner allowed (`calls.allow`) can ring from inside its own run:
`agentx call request --reason "…"`, or the MCP tool `agentx_call_owner`. `Calls.swift` polls
`/calls/ringing` every two seconds (the poll is also how the daemon knows the
widget is running; without it the daemon falls back to `agentx notify`). A
ringing call summons the pill, pulses the orb in the caller's colours, loops
`calls.ringSound`, and shows Answer, Later (5 / 15 / 30 min) and Decline.
Answer sends the daemon's opener through `/ask`, so the agent speaks first,
then the hands-free loop runs with the caller as the agent until Hang up,
"bye", or closing the pill. Decisions are in `CallModel.swift`, tested in
`Tests/Calls`. See [the calls guide](../../docs/dashboard/calls.md).

## The pill and its orb

The pill (`Panel.swift`) is the one floating widget. Its head is a 36 pt
SwiftUI orb (`Orb.swift`: MeshGradient on macOS 15, a two-gradient fallback
on 14) in the answering agent's nature palette: `/agents` `palette.colors`
(the daemon's `src/voice/orb-palettes.ts` is the only list), else shades of
`/agents` `color`, else the same id hash as the daemon's `presenceLook`
(`OrbMath.swift`, tested in `Tests/Orb`). It follows the microphone level while listening, turns a ring
while thinking, and pulses in a synthetic rhythm while speaking (the daemon
plays the audio). Idle or hidden, its timeline is paused and the level
timer stopped; Reduce Motion, or "Animated orb" off in the menu
(UserDefaults `animatedOrb`), makes it still.

Dragging it anywhere saves the position (UserDefaults `pillOrigin`); on
launch and when screens change it is clamped onto a connected screen, and
"Reset position" puts it back bottom-right. The close button (on hover), Esc
after a click, and "Hide pill" hide it and stop speech until the next talk
key or "Show floating pill", which is unchecked while the pill is closed
(`PillMenu.swift`). An answer worth reading grows the pill itself
(`PanelAnswer.swift`, `AnswerView.swift`): up or down from its row,
whichever has more room, then back to the same place `voice.card.timeout`
seconds after it is spoken (not while hovered), at most
`voice.card.maxHeight` tall. `PillPlacement.swift` holds that geometry,
tested in `Tests/Pill`. `Surface.swift` is the native background (popover
vibrancy, continuous corners, hairline, Increase Contrast). The panel is
non-activating and only becomes key when clicked.

## On-device models

Core ML only, no package dependency, nothing bundled. `ModelStore.swift`
pins each model to a Hugging Face revision and every file to a SHA-256,
downloads into `~/.agentx/models` on first use, and stamps a model
installed only after every file checked out.

- **Silero VAD** (`SileroVAD.swift`, 0.9 MB, MIT): scores each 32 ms of the
  microphone. `TurnEnd.swift` turns the scores into "speaking" and
  "ended" (1.2 s of non-speech after at least 0.25 s of speech, with
  hysteresis), so a noisy room neither ends a turn nor holds it open.
  Without the model, the same struct runs the old volume threshold.
- **Parakeet TDT 0.6B v3** (`Parakeet.swift`, 483 MB, CC-BY-4.0):
  preprocessor, encoder, decoder and joint models from FluidInference's
  Core ML export, decoded greedily in Swift. 25 European languages; no
  Arabic. `LocalSTT.swift` never makes a turn wait for the download or the
  first load (about 30 s, cached by Core ML); mlx-whisper answers meanwhile.

`agentx-voice-local` (built next to the app from the same sources) fetches
the models, transcribes WAVs and shows where a turn would end;
`scripts/voice-stt-bench` uses it to compare engines.

## Permissions

Microphone only. The hotkey uses Carbon's `RegisterEventHotKey`, which
needs no Accessibility permission — an `NSEvent` global monitor would have.

## Known limits

- Push-to-talk only; no wake word. To cut a voice off, press ⌥Space (and
  talk) or ⌘⌥. (just stop), or use *Stop speaking* in the right-click menu.
- One question per agent at a time. Several agents can think at once: start
  with another agent's name ("Writer, …") while one thinks and both run; the
  answers take turns in the daemon's speaking queue. Words for the agent
  already thinking replace its question; a second question for an agent
  answering a by-name question waits for that answer.
- ⌥Space is the default talk key (`⌃Space` is commonly bound to
  input-source switching). Talk, stop, paste and per-agent shortcuts are
  set in Settings… and stored in agentx.json (`voice.hotkeys`,
  `agents[].voice.hotkey`); ⌘⌥A, which opens the menu, is fixed.

## Settings window

`SettingsWindow.swift` edits per-agent voices (provider, voice, preview,
speed, narration, queue priority, shortcut, orb colour and palette) and the general
shortcuts, speech-to-text engine, default provider, answer time and height
(`SettingsLook.swift`) and launch at login.
Everything but launch at login (SMAppService, and read-only when the
installer's LaunchAgent starts the app) is read from `GET /voice/settings`
and saved with `POST /voice/settings`, which validates and writes
agentx.json in place. The app keeps no copy. `VoiceSettings.swift` computes
the patch and `HotkeySpec.swift` maps shortcuts to Carbon key codes; both
are tested in `Tests/Settings`.
