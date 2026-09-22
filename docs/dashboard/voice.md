# Desktop assistant for macOS

First complete the [desktop prerequisites](../requirements.md#desktop-assistant), choose a [speech backend](../requirements.md#voice-input-and-spoken-replies), and review [macOS permissions](../requirements.md#macos-permissions). Each section includes setup steps and official help.

AgentX Desktop is a floating assistant with voice, smart paste, and native computer-use tools. Hold **Option–Space**, speak, then release to send your question to an AgentX agent. The response appears in the widget and is spoken aloud. The daemon and the selected agent do the work.

## Install and activate

On **Apple Silicon with macOS 14 or newer**, run:

```sh
agentx desktop install --agent coder-agent
```

The command builds and installs the desktop app and computer-use helper, remembers the agent and daemon URL, and starts the app at login. Use an ID from `agentx agent list`. Apple command-line tools are required; if missing, the command explains how to install them. The daemon and the selected agent must already be configured.

From this unreleased source checkout, build once with `pnpm build`, then use `node dist/cli.js desktop install --agent coder-agent`. Future packages containing this command will use the shorter `agentx` form.

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
| `AGENTX_VOICE_ID` | ElevenLabs voice ID |
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper`, the local transcription executable |
| `AGENTX_MLX_MODEL` | `mlx-community/whisper-large-v3-turbo` |

Without an ElevenLabs key, transcription needs a working local `mlx_whisper` installation; speech uses macOS `say`. ElevenLabs usage and the agent's model usage are separate costs. The app checks the key environment variable first, then `~/.elevenlabs/key` and `~/.agentx/elevenlabs-key.txt`.

The installer persists the chosen agent, daemon URL, helper path, and CLI command in the login service. Finder does not inherit terminal environment variables. Use a key file for speech credentials or configure the login service environment for advanced speech settings.

## If it does not answer

- **No recording:** check macOS microphone permission and hold the shortcut while speaking.
- **Transcription fails:** check your ElevenLabs key or the local Whisper executable and model.
- **Agent unavailable:** check the daemon URL and the exact agent ID.
- **Remote daemon rejects it:** the current widget client has no configurable mesh bearer token; use the local daemon path for this setup.

The app also registers **Command–Option–V** for smart paste through `agentx paste`; this needs a working AgentX CLI and its own permissions. Voice is a native macOS client, separate from the dashboard's WebRTC `/call` page.
