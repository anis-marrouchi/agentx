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
| `ELEVENLABS_API_KEY` | Optional hosted transcription and speech |
| `AGENTX_VOICE_ID` | ElevenLabs voice ID, used when the answering agent has no `voice` block in agentx.json |
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper`, the local transcription executable |
| `AGENTX_MLX_MODEL` | `mlx-community/whisper-large-v3-turbo` |

Without an ElevenLabs key, transcription needs a working local `mlx_whisper` installation; speech uses macOS `say`. ElevenLabs usage and the agent's model usage are separate costs. The app checks the key environment variable first, then `~/.elevenlabs/key` and `~/.agentx/elevenlabs-key.txt`.

The installer persists the chosen agent, daemon URL, helper path, and CLI command in the login service. Finder does not inherit terminal environment variables. Use a key file for speech credentials or configure the login service environment for advanced speech settings.

## Agent voices

Each agent may carry a `voice` block in `agentx.json`. Every field is optional; an agent without one speaks in `AGENTX_VOICE_ID`.

```json
"coder-agent": {
  "voice": {
    "elevenlabsVoiceId": "CwhRBWXzGAHq8TQ4Fs17",
    "gender": "male",
    "style": "laid-back, dry",
    "intro": "Hello, this is Coder. I write and fix the code for your projects.",
    "narrate": "on"
  }
}
```

An agent introduces itself the first time it speaks in a voice session, or after eight hours of silence, and talks casually after that. Without `intro`, the line is derived from the first sentence of its system prompt.

## Talk mode

Two agents talk a topic through out loud on the daemon's host:

```bash
agentx talk secretary-agent marketing-agent "how to open tomorrow's demo"
```

Each line comes from a fast model with no tools (Haiku 4.5), streamed sentence by sentence into ElevenLabs Flash and played at once. The next speaker writes its reply while the current one is still talking, so hand-overs take milliseconds, not a full agent turn. Agents cannot act during a talk; they say who will do something afterwards.

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

## If it does not answer

- **No recording:** check macOS microphone permission and hold the shortcut while speaking.
- **Transcription fails:** check your ElevenLabs key or the local Whisper executable and model.
- **Agent unavailable:** check the daemon URL and the exact agent ID.
- **Remote daemon rejects it:** the current widget client has no configurable mesh bearer token; use the local daemon path for this setup.

The app also registers **Command–Option–V** for smart paste through `agentx paste`; this needs a working AgentX CLI and its own permissions. Voice is a native macOS client, separate from the dashboard's WebRTC `/call` page.
