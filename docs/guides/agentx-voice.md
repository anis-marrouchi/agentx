# AgentX Voice: talk to your agents from anywhere on your Mac

AgentX Voice is a small assistant that lives in your Mac's menu bar (macOS lists the app as **AgentX Desktop**). Hold a key, say what you need, and let go. Your words go to one of your AgentX agents, and the agent answers out loud, in its own voice. You don't need to open a browser, a chat window or a terminal, whichever app you are in.

This page is the user guide: install it, ask your first question, and learn the widget, the menu and the settings. The [Desktop assistant](../dashboard/voice.md) page goes deeper into talks between two agents, live lessons, task narration and automations.

## What it does

- **Ask any agent from any app.** Hold **Option–Space**, speak, let go. The ticked agent answers.
- **Hear the answer.** Each agent has its own voice, so you can tell who is talking without looking.
- **Ask several agents at once.** Start with an agent's name ("Researcher, what's the status?") to ask it directly. Answers never talk over each other: they wait their turn.
- **Stop it any time.** One key, **Command–Option–.** (the period key), silences everything.

The agents do the work on the AgentX daemon (the background service that runs your agents). The Mac app only listens, shows what is happening, and plays the answers.

## Before you start

You need:

- a Mac with Apple Silicon (M1 or newer) and macOS 14 or newer;
- AgentX installed, with the daemon running and at least one agent (see [Install AgentX](../install.md) and [Create your first agent](../first-agent.md));
- a microphone (the one built into your Mac is fine).

Speech to text (turning your voice into words) runs on your Mac with Whisper, or through ElevenLabs if you have a key. See [Voice input and spoken replies](../requirements.md#voice-input-and-spoken-replies) to set one up. Answers use the free Mac voices unless you choose ElevenLabs.

## Install and first run

1. **Terminal:** check the daemon is running:
   ```sh
   agentx daemon status
   ```
   It prints `Status: running` and lists your agents.
2. **Terminal:** preview what the installer will do, without changing anything:
   ```sh
   agentx desktop install --dry-run
   ```
3. **Terminal:** install it:
   ```sh
   agentx desktop install
   ```
   This builds the app, puts it in the Applications folder of your home folder as **AgentX Desktop**, and starts it every time you log in. If Apple's command-line tools are missing, it tells you how to install them.
4. **Mac:** when macOS asks to let **AgentX Desktop** use the microphone, choose **Allow**.
5. **Mac:** when the AgentX Helper asks, open **System Settings › Privacy & Security** and switch on **Accessibility** and **Screen Recording** for **AgentX Helper**. The helper lets agents point at things on your screen. See [macOS permissions](../requirements.md#macos-permissions).
6. **Mac:** look for the AgentX icon (a small waveform) in the menu bar at the top of the screen.
7. **Mac:** click it and choose the agent you want to talk to.

![System Settings › Privacy & Security › Accessibility with access turned on](/screenshots/requirements/accessibility.png)

<!-- Screenshot needed: the macOS microphone prompt for AgentX Voice. It appears only once per Mac and comes back only after resetting privacy settings (tccutil reset Microphone), so it needs a fresh demo account. -->

### Ask your first question

1. **Mac:** hold **Option–Space**. The floating pill appears in the bottom-right corner and says **Listening**.
2. Say "What can you do?" while you keep holding the keys.
3. Let go. The pill shows the agent thinking, then the agent says its answer out loud.

That's it. From now on, hold **Option–Space** from any app to ask again.

## The floating pill

The pill is the small bar that shows what the assistant is doing. It appears while the assistant listens, thinks or speaks, and goes away when it is done. The glowing dot at its left end is the **orb**, in the colour of the agent that is answering.

![The pill in four states, light mode: listening, thinking with a ring round the orb, speaking, and idle](/screenshots/voice/pill-states-light.png)

![The same four states in dark mode](/screenshots/voice/pill-states-dark.png)

| What you see | What it means |
|---|---|
| The orb swells and shrinks with your voice, and the pill says **Listening** | The microphone is on and hears you |
| A white ring goes round the orb, and the pill shows what the agent is doing and for how long | The agent is thinking |
| The orb pulses, and the answer scrolls past in the pill | The agent is speaking |
| A still orb and **HOLD ⌥SPACE** | Idle. You only see this with **Show floating pill** ticked in the menu |
| An amber orb | Notifications are held (see [the menu](#the-menu-bar-menu)) |
| A red orb | Something went wrong. The pill says what |

### Where the answer text appears

The answer is spoken and scrolls past in the pill. When it has a link, a picture, or more text than was read aloud, an **answer card** opens next to the pill with the full answer. The card sits above the pill when the pill is low on the screen, and below it when the pill is high.

<!-- Screenshot needed: the answer card next to the pill, light and dark. Needs a live spoken question on a demo install; see #211, which is changing where answer text appears. -->

### Move the pill

1. **Mac:** press anywhere on the pill and drag it where you want it.
2. Let go. The pill stays there, and comes back to the same place after a restart.

To put it back in the bottom-right corner, click the AgentX icon in the menu bar and choose **Reset position**.

### Close the pill

Closing the pill also stops the voice that is speaking.

1. **Mac:** move the pointer over the pill.
2. **Mac:** click the **×** that appears at its right end.

![The pill with the pointer over it and the close button showing](/screenshots/voice/pill-hover.png)

You can also click the pill and press **Esc**, or choose **Hide pill** in the menu. The pill comes back the next time you hold **Option–Space**.

## The menu-bar menu

Click the AgentX icon in the menu bar, or press **Command–Option–A** from any app. The icon itself also shows the state: a waveform when idle, a microphone while listening, dots while thinking, and a speaker while answering. A number next to it counts the answers waiting to be spoken.

![The AgentX menu: the agents with one ticked, then Stop speaking, Hold notifications, Show floating pill, Settings…, History… and Quit](/screenshots/voice/menu-bar.png)

<!-- Screenshot needed: menu-bar.png predates #209 and lacks Animated orb, Hide pill, Reset position and Dashboard…. Recapture from a demo install in light and dark mode. -->

| Item | What it does |
|---|---|
| **Talk to** (your agents) | The ticked agent answers your questions. Click another one, or press its number (**1** to **9**) while the menu is open. Each row shows what the agent is doing: **idle**, **thinking**, **speaking**, **working** on something else, or **queued 2** when two answers wait to be spoken. The app remembers your choice |
| **Agent (set by AGENTX_VOICE_AGENT)** | Shown instead of **Talk to** when the app was installed with `--agent`. The agent can't be changed from the menu |
| **Loading agents…** | The app is asking the daemon for your agents |
| **No agents configured** | The daemon answered but has no agents. Add one to `agentx.json` |
| **AgentX daemon isn't reachable** and **Retry** | The app can't reach the daemon. Start it, then choose **Retry** (or press **R**) |
| **Stop speaking** | Stops every voice on the Mac and drops the answers still waiting. Same as **Command–Option–.** |
| **Hold notifications** | A "don't interrupt me" switch. While ticked, agent notifications wait and the orb turns amber. Untick it to let them through |
| **Show floating pill** | Keeps the pill on screen when idle. Off by default |
| **Animated orb** | Lets the orb move with your voice and the answer. On by default. Untick it for a still orb |
| **Hide pill** | Hides the pill and stops the voice. Greyed out when the pill isn't showing |
| **Reset position** | Puts the pill back in the bottom-right corner |
| **Settings…** | Opens the [settings window](#the-settings-window) (**Command–,**) |
| **Dashboard…** | Opens the AgentX dashboard in your browser (**Command–D**) |
| **History…** | Opens your past voice questions in the dashboard (**Command–Y**) |
| **Quit AgentX Voice** | Closes the app until you open it again or next log in (**Command–Q**) |

## The settings window

The settings window changes each agent's voice and the app's shortcuts without editing files. It saves your changes through the daemon into `agentx.json`, the AgentX settings file, and nothing needs a restart.

1. **Mac:** click the AgentX icon in the menu bar.
2. **Mac:** choose **Settings…**.
3. **Mac:** change what you need on the **Agents** or **General** tab.
4. **Mac:** choose **Save** (or press **Command–S**). **Revert** puts back what was saved.

If a value is refused, a red message at the bottom says what to fix, and nothing is saved.

### Agents tab

Pick an agent on the left. Its settings show on the right.

![The Agents tab: voice provider, Mac voice, speaking speed, narration, queue priority, shortcut and orb colour for one agent](/screenshots/voice/settings-agents.png)

| Setting | What it does |
|---|---|
| **Voice provider** | **Mac voices** (free), **ElevenLabs**, or **Default** (follows the General tab) |
| **Mac voice** | Which Mac voice this agent uses. **Assigned automatically** gives every agent a different one. **The Mac's default voice** uses the voice set in System Settings, including Siri voices |
| **ElevenLabs voice ID** | The ElevenLabs voice, when the provider is ElevenLabs |
| **Preview** | Plays a sample line in the voice as set in the window, before you save |
| **Speaking speed** | From 0.75× to 1.5×. **Normal** is 1× |
| **Narration** | Short spoken updates while the agent works on a task: **Off**, **On, except scheduled jobs**, or **On, scheduled jobs too** |
| **Queue priority** | **High** answers go ahead of the ones waiting; **Low** ones go after; **Normal** keeps the order they arrive in |
| **Ask with shortcut** | Hold this shortcut to ask this agent directly, without changing the ticked agent. Click the field and press the keys |
| **Orb colour** | The colour of this agent's orb and on-screen pointer. **Use default** picks one from the agent's id |

To try a voice before keeping it:

1. **Mac:** pick the agent on the **Agents** tab.
2. **Mac:** choose another **Mac voice** or **Speaking speed**.
3. **Mac:** choose **Preview**. The agent says a sample line.
4. **Mac:** choose **Save** to keep it, or **Revert** to go back.

### General tab

![The General tab in dark mode: shortcuts, speech to text, default voice provider and launch at login](/screenshots/voice/settings-general.png)

| Setting | What it does |
|---|---|
| **Talk (hold)** | Hold to speak, let go to send. Default **Option–Space** |
| **Stop every voice** | Silences everything. Default **Command–Option–.** |
| **Smart paste** | Reshapes what you copied for the app you are typing in, then pastes it. Default **Command–Option–V** |
| **Open the menu** | **Command–Option–A**. Fixed; shown so you don't reuse it |
| **Speech to text** | **Automatic** (ElevenLabs when a key is set, Whisper on this Mac otherwise), **ElevenLabs**, or **On this Mac (Whisper)**, which keeps your voice on the Mac |
| **Default voice provider** | The provider for agents set to **Default** |
| **Launch at login** | Starts the app when you log in. Greyed out and on when `agentx desktop install` already does it |

A shortcut needs **Control**, **Option** or **Command** (a function key such as **F5** can be used alone). Two actions can't share one shortcut.

![A refused save: the message at the bottom says the shortcut is already in use](/screenshots/voice/settings-error.png)

<!-- Screenshot needed: settings-agents.png in dark mode and settings-general.png in light mode, from a demo install. -->

## Talking to agents

### Ask the ticked agent

1. **Mac:** hold **Option–Space**.
2. Say your question.
3. Let go. The pill names the agent that answers.

### Ask another agent by name

Start with an agent's name to send just that question to it. The ticked agent stays ticked.

1. **Mac:** hold **Option–Space**.
2. Say the agent's name first, then the question: "Researcher, what's the status?"
3. Let go. The pill shows the agent you named while it answers.

The name can be the agent's id, its name, or one of its mentions in `agentx.json`. Capital letters don't matter. If no agent matches, or more than one does, the ticked agent answers.

### Ask several agents at once

1. **Mac:** ask one agent something that takes a while.
2. While it thinks, hold **Option–Space** and ask another agent by name.
3. Both agents work at the same time. Each answer is spoken when it arrives, one after the other.

Open the menu to see each agent's state. If you ask the same agent again while it is still thinking on your question, your new words replace the old question. More rules are in [Ask several agents at once](../dashboard/voice.md#ask-several-agents-at-once).

### Interrupt or stop

- **Interrupt:** hold **Option–Space** while an agent is speaking. It goes quiet at once and listens. After your question, the cut-off answer plays again from the start.
- **Stop everything:** press **Command–Option–.**, or choose **Stop speaking** from the menu. Every voice stops and the answers still waiting are dropped.
- **Say "stop":** hold **Option–Space** and say "stop". Same as **Stop speaking**.

## Config reference

The settings window writes most of these for you. You can also edit `agentx.json` by hand; the daemon checks every value when it loads.

### Shared voice settings (`voice` in `agentx.json`)

| Key | Default | What it does |
|---|---|---|
| `voice.provider` | `"system"` | `"system"` (free Mac voices) or `"elevenlabs"` for every agent without its own |
| `voice.fallback` | `"system"` | When ElevenLabs can't speak: `"system"` uses a Mac voice, `"none"` stays silent |
| `voice.system` | not set: each agent gets its own voice | A Mac voice for every agent without its own. `"system"` means the Mac's default voice |
| `voice.locale` | `"en"` | The language of automatically assigned voices, for example `"fr-FR"` |
| `voice.listener` | not set: "the user" | What agents call you, for example your first name |
| `voice.stt` | `"auto"` | Speech to text: `"auto"`, `"elevenlabs"` or `"local"` |
| `voice.hotkeys.talk` | `"opt+space"` | Hold to talk |
| `voice.hotkeys.stop` | `"cmd+opt+period"` | Stop every voice |
| `voice.hotkeys.paste` | `"cmd+opt+v"` | Smart paste |
| `node.defaultAgent` | not set: the first agent | The agent that answers when none is ticked or pinned |

### Per-agent settings (in each agent's block)

| Key | Default | What it does |
|---|---|---|
| `voice.provider` | the shared `voice.provider` | This agent's provider |
| `voice.system` | assigned automatically | A Mac voice name, `"system"`, or one voice per language such as `{ "en": "Samantha", "fr": "Thomas" }` |
| `voice.elevenlabsVoiceId` | `AGENTX_VOICE_ID`, else ElevenLabs' default | The ElevenLabs voice |
| `voice.gender` | not set | `"female"`, `"male"` or `"neutral"`; an assigned voice matches it |
| `voice.style` | not set | A few words on manner, for example `"warm, calm"` |
| `voice.intro` | not set | The one-line introduction the agent uses the first time it speaks |
| `voice.rate` | `1` | Speaking speed, from `0.75` to `1.5` |
| `voice.narrate` | `"off"` | `"on"` (all tasks except scheduled jobs), `"all"`, or `"off"` |
| `voice.priority` | `"normal"` | `"high"`, `"normal"` or `"low"` in the speaking queue |
| `voice.hotkey` | none | A shortcut that asks this agent directly, for example `"ctrl+opt+1"` |
| `presence.color` | picked from the agent's id | Orb and pointer colour as `"#RRGGBB"` |

Agents on other AgentX computers in your mesh can get a voice here too, under `meshVoices.<agent-id>`, with the same keys except `rate`, `priority` and `hotkey`, plus `name` (what to call the agent aloud).

A shortcut is written as modifiers and a key joined by `+`. Modifiers are `ctrl`, `opt`, `shift` and `cmd`. Keys are a letter, a digit, `f1` to `f20`, or `space`, `period`, `comma`, `slash`, `semicolon`, `quote`, `minus`, `equal`, `leftbracket`, `rightbracket`, `backslash`, `grave`, `return` or `tab`. You can also type the character itself: `.` `,` `/` `;` `'` `-` `=` and `` ` ``, and `enter` for `return`.

### Settings kept on the Mac only

These are menu choices, not in `agentx.json`. macOS saves them for your user, except **Hold notifications**, which is kept in `~/.agentx/focus.json` so that `agentx notify` in the daemon and in your agents can read it. A macOS Focus also holds notifications, and the two don't override each other.

| Setting | Default |
|---|---|
| The ticked agent | the daemon's `node.defaultAgent`, else the first agent |
| **Show floating pill** | off |
| **Animated orb** | on |
| **Hold notifications** | off |
| Pill position | bottom-right corner of the main screen |

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `AGENTX_DAEMON_URL` | `http://127.0.0.1:18800` | The daemon the app talks to |
| `AGENTX_VOICE_AGENT` | not set | Pins one agent; the menu can't switch. Set by `agentx desktop install --agent` |
| `AGENTX_DASHBOARD_URL` | `http://127.0.0.1:4202` | Opened by **Dashboard…** and **History…** |
| `ELEVENLABS_API_KEY` | not set; the app also reads `~/.elevenlabs/key` and `~/.agentx/elevenlabs-key.txt` | ElevenLabs speech to text, and voices for ElevenLabs agents |
| `AGENTX_VOICE_ID` | ElevenLabs' default voice | ElevenLabs voice for agents without `voice.elevenlabsVoiceId` |
| `AGENTX_VOICE_PROVIDER` | `system` | The engine for lines spoken before the daemon names one, such as an error |
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper` | The Whisper program on your Mac |
| `AGENTX_MLX_MODEL` | `mlx-community/whisper-large-v3-turbo` | The Whisper model |
| `AGENTX_STT_MODEL` | `scribe_v1` | The ElevenLabs speech-to-text model |
| `AGENTX_TTS_MODEL` | `eleven_turbo_v2_5` | The ElevenLabs voice model |
| `AGENTX_PASTE_COMMAND` | the line in `~/.agentx/paste-command.txt`, else `agentx paste` | The command **Smart paste** runs. The app also uses it to find `agentx notify` |
| `AGENTX_VOICE_PATH` | the folder of `ffmpeg` plus macOS's standard folders | Read by the installer only: the `PATH` the app starts with |

An app started at login doesn't see variables set in your terminal. Keep keys in a key file rather than in your shell profile.

### Commands

| Command | What it does |
|---|---|
| `agentx desktop install` | Builds, installs and starts the app and its helper at login. `--agent <id>` pins one agent; `--dry-run` only shows the plan |
| `agentx desktop status` | Shows whether the app is installed and running |
| `agentx desktop start` | Starts the installed app |
| `agentx desktop stop` | Stops it until you start it again or next log in |
| `agentx voice list` | Lists the Mac voices for your language. `--all` lists every language; `-c <path>` reads another `agentx.json` |
| `agentx voice set <agent> [voice]` | Sets an agent's voice. `--provider system\|elevenlabs`, `--lang en\|fr\|ar` for one language only, `--gender female\|male\|neutral`, `-c <path>` |
| `agentx narrate <agent> on\|off\|default` | Switches task narration for an agent. `--task` targets one task id instead |
| `agentx talk <agentA> <agentB> <topic…>` | Two agents talk out loud. See [Talk mode](../dashboard/voice.md#talk-mode-two-agents-talk-out-loud) |

## Check it worked

1. **Terminal:** run `agentx desktop status`. It says the app is installed and running.
2. **Mac:** click the AgentX icon in the menu bar. Your agents are listed and one is ticked.
3. **Mac:** hold **Option–Space**, say "What can you do?", then let go.
4. **Mac:** the pill shows **Listening**, then a ring while the agent thinks, then the answer while it is spoken aloud.
5. **Mac:** hold **Option–Space** again and say another agent's name before a question. The pill names that agent while it answers, and the ticked agent stays ticked in the menu.
6. **Mac:** while an answer plays, press **Command–Option–.**. The voice stops at once.
7. **Mac:** open **Settings…**, pick an agent, change its **Mac voice**, and choose **Preview**. The sample plays in the new voice.

## If something is wrong

- **No AgentX icon in the menu bar:** **Terminal:** run `agentx desktop status`. If it says it isn't running, run `agentx desktop start`. If it isn't installed, follow [Install and first run](#install-and-first-run).
- **The menu says the daemon isn't reachable:** **Terminal:** run `agentx daemon status` and start the daemon, then choose **Retry** in the menu.
- **Nothing is heard, or "Sorry, I didn't hear that":** check **System Settings › Privacy & Security › Microphone** allows **AgentX Desktop**, and keep holding the keys while you speak. If it still fails, speech to text isn't working: check your ElevenLabs key, or run `agentx doctor` to check Whisper and `ffmpeg` on this Mac. After installing `ffmpeg`, run `agentx desktop install` again.
- **No sound from the answer:** check the Mac's volume and output device. Then check an agent isn't waiting behind another: **Terminal:** run `curl -s http://127.0.0.1:18800/voice/queue`. If `paused` is `true` and you are not speaking, run `curl -s -X POST http://127.0.0.1:18800/voice/queue/resume`. An ElevenLabs agent without a key uses a Mac voice, or stays silent when `voice.fallback` is `"none"`.
- **The pill doesn't show:** it was closed with **×**, **Esc** or **Hide pill**. Hold **Option–Space** to bring it back. If it is off screen, choose **Reset position** in the menu.
- **Option–Space does nothing:** another app already uses that shortcut. Pick another **Talk (hold)** shortcut in **Settings… › General**. The app log, `~/Library/Logs/agentx-desktop.err.log`, says `is taken by another app`.
- **The menu can't switch agents:** the app was installed with `--agent`. **Terminal:** run `agentx desktop install` again without it.
- **A question by name went to the ticked agent:** the name matched no agent, or more than one. Check names and mentions with `agentx agent list`.
- **Save in the settings window shows a red message:** fix the value it names (a shortcut used twice, a shortcut without **Control**, **Option** or **Command**, or a speed outside 0.75–1.5) and save again.
- **Anything else:** see [If something is wrong](../dashboard/voice.md#if-something-is-wrong) on the Desktop assistant page.
