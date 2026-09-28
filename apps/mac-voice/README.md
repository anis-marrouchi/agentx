# AgentX Desktop assistant

Install and activate from your AgentX configuration directory:

```sh
agentx desktop install --agent coder-agent
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
             →  STT   ElevenLabs Scribe, falling back to on-device mlx-whisper
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
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper` | offline STT |

The ElevenLabs key is read from the environment first, then key files: an app launched from
Finder inherits nothing from your login shell, so an env-only design works
from a terminal and fails mysteriously when double-clicked.

## Talking to other agents

Say "talk to Atlas" (or "switch to Nadia", "put me through to …") and the
following turns go to that agent, local or on a mesh peer, until "back to
secretary". The daemon does the switch, per voice session, and answers at
once in the new agent's voice. A remote agent runs its turn on its own node
over the mesh; its voice is spoken here. Name or pin a remote voice in
`agentx.json`:

```json
"meshVoices": { "atlas": { "name": "Atlas", "elevenlabsVoiceId": "…", "style": "calm" } }
```

Unset, a remote agent's intro comes from its agent card and it gets a
system voice (and an ElevenLabs voice, for the `elevenlabs` provider) that no
local agent and no other remote uses.

## The pill and its orb

The pill (`Panel.swift`) is the one floating widget. Its head is a 36 pt
SwiftUI orb (`Orb.swift`: MeshGradient on macOS 15, a two-gradient fallback
on 14) in the answering agent's colour: `/agents` `color`, else the same id
hash as the daemon's `presenceLook` (`OrbMath.swift`, tested in
`Tests/Orb`). It follows the microphone level while listening, turns a ring
while thinking, and pulses in a synthetic rhythm while speaking (the daemon
plays the audio). Idle or hidden, its timeline is paused and the level
timer stopped; Reduce Motion, or "Animated orb" off in the menu
(UserDefaults `animatedOrb`), makes it still.

Dragging it anywhere saves the position (UserDefaults `pillOrigin`); on
launch and when screens change it is clamped onto a connected screen, and
"Reset position" puts it back bottom-right. The close button (on hover), Esc
after a click, and "Hide pill" hide it and stop speech until the next talk
key. The answer card opens above or below the pill, whichever has more
room, and follows it. `PillPlacement.swift` holds that geometry, tested in
`Tests/Pill`. The panel is non-activating and only becomes key when clicked.

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
speed, narration, queue priority, shortcut, orb colour) and the general
shortcuts, speech-to-text engine, default provider and launch at login.
Everything but launch at login (SMAppService, and read-only when the
installer's LaunchAgent starts the app) is read from `GET /voice/settings`
and saved with `POST /voice/settings`, which validates and writes
agentx.json in place. The app keeps no copy. `VoiceSettings.swift` computes
the patch and `HotkeySpec.swift` maps shortcuts to Carbon key codes; both
are tested in `Tests/Settings`.
