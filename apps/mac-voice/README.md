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
             →  TTS   ElevenLabs, falling back to `say`
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
| `AGENTX_VOICE_AGENT` | `secretary-agent` | which agent answers |
| `ELEVENLABS_API_KEY` | `~/.elevenlabs/key` | STT + TTS; absent → local fallbacks |
| `AGENTX_VOICE_ID` | Rachel | ElevenLabs voice |
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper` | offline STT |

The ElevenLabs key is read from the environment first, then key files: an app launched from
Finder inherits nothing from your login shell, so an env-only design works
from a terminal and fails mysteriously when double-clicked.

## Permissions

Microphone only. The hotkey uses Carbon's `RegisterEventHotKey`, which
needs no Accessibility permission — an `NSEvent` global monitor would have.

## Known limits

- Push-to-talk only; no wake word, and no barge-in while it speaks.
- One turn at a time — a keypress during a running turn is ignored, not queued.
- ⌥Space is fixed. `⌃Space` was avoided because it's commonly bound to
  input-source switching.
