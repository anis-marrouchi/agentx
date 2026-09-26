# Before you start

**Install only what you plan to use.** Start with AgentX and one working agent. Add voice, desktop control, or a second machine later.

## Choose your starting point

| I want to… | What I need | Start here |
|---|---|---|
| Explore without a model account | A source installation; the demo uses scripted replies | [Source setup](#option-b-run-from-source), then [demo](see-it-first.md) |
| Run agents and use the browser dashboard | Docker **or** Node.js; a model connection | [Core setup](#core-setup) |
| Chat inside the dashboard | Running dashboard, daemon, and configured agent | [In-page chat](dashboard/chat.md) |
| Use the OpenCode terminal interface | Core setup + OpenCode v2 or newer | [Terminal setup](#terminal-interface) |
| Talk to agents on my Mac | Core setup + compatible Mac + speech setup | [Desktop setup](#desktop-assistant) |
| Point at controls or inspect my screen | Desktop helper + permissions + relevant model credentials | [Computer use](#computer-use) |
| Connect agents on two machines | Core setup on both + private network + mesh pairing | [Networking](#two-machines-and-a2a) |

The **daemon** is the background service that runs agents. The **dashboard** is the browser interface connected to it. A **provider** supplies the AI model. An **API key** is a private credential for that provider.

## Core setup

Install [Git](https://git-scm.com/downloads/) if `git --version` is unavailable; the checkout instructions use it to download AgentX.

Choose **one** installation path. Docker runs the daemon and dashboard in containers. A source installation runs them directly on your machine.

### Option A: use Docker

1. [Install Docker Desktop or Docker Engine](https://docs.docker.com/get-started/get-docker/). Start Docker before continuing.
2. Open a terminal and check:

   ```sh
   docker version
   docker compose version
   ```

3. Follow [Install AgentX with Docker](install.md#docker-build-this-checkout).

**Ready when:** `docker version` shows a responding server and the dashboard opens after starting Compose. You do not need host Node.js for this path. Native macOS desktop tools must be installed on the Mac itself; they do not run inside the Linux container.

### Option B: run from source

1. Install **Node.js 22.x** from [Node.js downloads](https://nodejs.org/en/download). Select version 22 explicitly; the website may offer a newer version by default.
2. Install pnpm 10:

   ```sh
   npm install -g pnpm@10
   node --version
   pnpm --version
   ```

3. Confirm Node reports `v22.…` and pnpm reports `10.…`, then follow [Run from source](install.md#run-from-source).

**Help:** [pnpm installation](https://pnpm.io/installation). If installation reports a native compilation error, follow [node-gyp's platform prerequisites](https://github.com/nodejs/node-gyp#installation) for Python and a C/C++ toolchain.

::: tip Commands in these guides
`agentx` means an installed CLI. When running from source, use `node dist/cli.js` in its place after `pnpm build`. Run commands from the directory containing your `agentx.json`. The [install page](install.md) explains the 0.27.0 package limitation.
:::

### Connect one model

For a first setup, the browser wizard's **Anthropic API (BYO key)** option is a direct route:

1. Follow [Anthropic's getting-started guide](https://platform.claude.com/docs/en/get-started) to obtain API access and a key.
2. Open AgentX `/setup`, select that engine, and enter the key.
3. Save the agent and restart the daemon as described in [Your first agent](first-agent.md).
4. Send a short test message.

**Ready when:** the agent returns a real response. Other engines need their own installed runtime and authentication. Installing OpenCode, Docker, or the desktop app does not provide model credentials. Provider usage and account requirements are separate from AgentX; see [costs](help/costs.md).

## Desktop assistant

**Required:** Apple Silicon Mac, macOS **14 or newer**, Node.js 22, configured AgentX agent, and Apple's command-line tools. Check **Apple menu → About This Mac** for your chip and macOS version.

1. Install Apple's tools if needed:

   ```sh
   xcode-select --install
   ```

   Complete the macOS installer, then check `xcrun --find swiftc`. See [Apple's developer tools help](https://developer.apple.com/xcode/resources/).

2. From your AgentX configuration directory, install and activate:

   ```sh
   agentx desktop install --agent coder-agent
   ```

   Replace `coder-agent` with an ID from `agentx agent list`.

3. Complete [speech setup](#voice-input-and-spoken-replies) if you want voice, and [permissions](#macos-permissions) for the features you use.
4. Run `agentx desktop status` to inspect the login service.

**The installer handles:** building both native apps, installing them under `~/Applications`, remembering your agent and daemon URL, and starting the assistant at login.

**You handle:** installing Apple's tools, configuring the daemon/model, setting up a speech backend, and accepting macOS permissions. The installer does not download Whisper or grant permissions.

## Voice input and spoken replies

Choose **one** transcription option. You can later configure both for fallback.

### Option A: ElevenLabs

1. Create an API key following [ElevenLabs' key guide](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys). Enable the access needed for speech-to-text and, if used, text-to-speech.
2. Create the local configuration folder and open a key file:

   ```sh
   mkdir -p ~/.agentx
   touch ~/.agentx/elevenlabs-key.txt
   chmod 600 ~/.agentx/elevenlabs-key.txt
   nano ~/.agentx/elevenlabs-key.txt
   ```

3. Paste **only the key**, save with Control–O, press Enter, and exit with Control–X. A key file works for login-launched apps without relying on terminal environment variables.
4. Restart the assistant:

   ```sh
   agentx desktop stop
   agentx desktop start
   ```

**Ready when:** holding Option–Space, speaking a short question, and releasing produces a transcript and reply. This option needs internet access and available provider quota. Official help: [ElevenLabs quickstart](https://elevenlabs.io/docs/eleven-api/quickstart).

### Option B: local Whisper

This is an optional local transcription setup for Apple Silicon. It needs Python, FFmpeg, and the `mlx-whisper` package. The [MLX Whisper project](https://github.com/ml-explore/mlx-examples/tree/main/whisper) documents installation and model downloads.

1. Install Python and FFmpeg. If you use [Homebrew](https://brew.sh/):

   ```sh
   brew install python ffmpeg
   ```

2. Install Whisper into its own environment:

   ```sh
   python3 -m venv ~/.agentx/whisper-env
   ~/.agentx/whisper-env/bin/python -m pip install mlx-whisper
   ```

3. Create a launcher at the path AgentX expects. It also makes Homebrew's FFmpeg available to the login app:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/mlx_whisper <<'SH'
   #!/bin/sh
   export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
   exec "$HOME/.agentx/whisper-env/bin/mlx_whisper" "$@"
   SH
   chmod +x ~/.local/bin/mlx_whisper
   ~/.local/bin/mlx_whisper --help
   ```

   If you already have a launcher there, keep it and check that it works instead of replacing it.

4. Test with a short audio file of your own:

   ```sh
   ~/.local/bin/mlx_whisper /path/to/test.wav --model mlx-community/whisper-large-v3-turbo
   ```

   Replace the audio path. The first run downloads the model and needs internet access and free disk space. Let it finish before testing the desktop hotkey.

5. In the terminal, run the desktop install again so the assistant can find FFmpeg when it starts at login:

   ```sh
   agentx desktop install --agent coder-agent
   ```

   A login app does not see your terminal's settings. The installer records the folder where it found FFmpeg. If it prints `ffmpeg was not found`, finish step 1 and run it again.

6. In the terminal, run `agentx doctor`. Under **Desktop**, it should report `ffmpeg reachable by the desktop app`.

**Ready when:** the test creates a text transcript. Restart the desktop assistant and test Option–Space. Without ElevenLabs, spoken replies use macOS `say`. Local transcription does not make a remotely hosted agent model work offline.

## macOS permissions

Open **System Settings → Privacy & Security**. Allow access for the app identified by the prompt, then relaunch it if macOS asks.

| Permission | Needed for | App normally requesting it |
|---|---|---|
| Microphone | Recording your spoken request | AgentX Desktop |
| Accessibility | Reading controls and interacting with apps | AgentX Helper / the invoking app |
| Screen Recording or Screen & System Audio Recording | OCR and screen captures | AgentX Helper / the invoking app |

Official help: [Accessibility access](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac), [microphone access](https://support.apple.com/en-au/102071), [screen recording access](https://support.apple.com/en-om/guide/mac-help/mchld6aa7d23/mac). An app may appear only after it first requests access. A running desktop login service alone does not prove these permissions are enabled.

## Computer use

Install the desktop helper and grant the permissions above first. Then choose the capability:

| Capability | Additional requirement | Check |
|---|---|---|
| Locate and highlight a control (`point`) | Available `ui-element` decision seat | `agentx point "the search field"` while that field is visible |
| Describe the screen (`look`) | OpenRouter key and access to a vision model | `agentx look "What window is visible?"` |
| Verify a visible result | Vision setup; optional `screen-state` seat | `agentx look "The command palette is open" --verify` |
| Run a guided lesson | Dependencies needed by that lesson | `agentx teach` lists the available lessons |

For `look`, create a key using the [OpenRouter quickstart](https://openrouter.ai/docs/quickstart), then save it as a single line in `~/.agentx/openrouter-key.txt` with owner-only permissions, following the key-file steps above. Screen captures are sent to the vision provider. Test using a demo workspace.

For Jev, follow [the decision-seat setup](architecture/jev.md). The current `jev` backend reads `OPENROUTER_API_KEY`; the direct `typesafe` backend reads `TYPESAFE_API_KEY`. Put the appropriate variable in your AgentX `.env`, enable the desired seats, and restart the daemon. The vision key file is not a substitute for the decision backend's environment variable. Confirm backend access before enabling a seat in active mode.

**Ready when:** the specific command you intend to use works. `point` highlights without clicking; lessons can click and type. [The computer-use walkthrough](tutorials/record-vscode.md) explains how to check results.

## Terminal interface

1. Install OpenCode using its [official v2 instructions](https://opencode.ai/v2/docs).
2. Run `opencode --version`. AgentX's integration requires **v2 or newer**.
3. Start your daemon, then run `agentx tui --agent coder-agent` in an interactive terminal.

**Ready when:** OpenCode opens with the AgentX agent selected. If OpenCode is missing or too old, AgentX uses its built-in TUI. `agentx tui --legacy` selects that fallback directly. See [TUI connection limits](dashboard/tui.md#connections-and-limits) before using an authenticated remote daemon.

## Two machines and A2A

1. Install AgentX and configure a model on each machine that will run agents.
2. Install Tailscale using the [official setup guide](https://tailscale.com/docs/install), and join the intended private network.
3. Follow [AgentX's Tailscale guide](jobs/tailscale.md) to configure reachable addresses, pair peers, and load matching tokens.
4. Run `agentx mesh health`, then send a small [peer task](reference/a2a.md).

**Ready when:** the remote agent answers. Tailscale is one private-network option; it is not required for a single-machine setup. The separate standalone A2A server needs its own provider runtime and authentication; it does not automatically use a configured daemon agent.

## Channels and workflows

For Telegram, you need a Telegram account and bot token; follow [Connect Telegram](connect-telegram.md). Other channels need their own account, credentials, and event-delivery configuration; use [Channels](reference/channels.md) to choose a supported integration. Test one incoming message before scheduling work that depends on it.

For the workflow assistant, you need a configured agent and the workflow engine enabled:

```sh
agentx config set workflows.enabled true
```

Follow the command's reload/restart result, then use [Describe an automation](automations/describe-it.md). **Ready when:** the assistant returns a proposal and you can inspect it before applying or running it. A webhook or scheduled workflow also needs the corresponding channel or schedule configured.

## Recording a tutorial

Screen Studio is optional. For the Screen Studio example, install the app and follow its [recording guide](https://screen.studio/guide/starting-finishing-the-recording), including macOS capture permissions. Confirm that a playable clip was saved.

`agentx teach --record` uses macOS `screencapture` instead. It does not require Screen Studio. See [record a VS Code walkthrough](tutorials/record-vscode.md).

## Final check

- [ ] My chosen installation path works.
- [ ] My daemon is running and one agent answers a short message.
- [ ] I installed only the optional features I want.
- [ ] Each optional feature passes its own “Ready when” check.

There is no measured universal RAM or disk minimum for AgentX yet. Local speech models, concurrent agents, and retained recordings change resource needs. For a failure, run `agentx doctor` and follow [troubleshooting](help/its-not-answering.md).
