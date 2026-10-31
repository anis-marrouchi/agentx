# AgentX Voice: full reference

First complete the [desktop prerequisites](../requirements.md#desktop-assistant), choose a [speech backend](../requirements.md#voice-input-and-spoken-replies), and review [macOS permissions](../requirements.md#macos-permissions). Each section includes setup steps and official help.

AgentX Voice is a menu-bar assistant for your Mac with voice, smart paste, and native computer-use tools. Hold **Option–Space**, speak, then release to send your question to an AgentX agent. The response appears in a small floating pill and is spoken aloud. The daemon and the selected agent do the work. macOS lists the app as **AgentX Desktop**, and some pages call it the *desktop assistant*: both mean AgentX Voice. For a gentler start, read the [AgentX Voice guide](../guides/agentx-voice.md).

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

   There is only ever one login item. If an earlier install, or `apps/mac-voice/install.sh`, already made one under another `…agentx.voice…` name, the installer keeps that name and points it at the new app, and removes any other login item that starts the voice app. `--dry-run` shows the login item it will use and the ones it will remove. `agentx desktop status`, `start` and `stop` use the same login item.
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

### Keep permissions after an update

By default each build of the app is signed ad hoc, and macOS treats every new build as a different app: after each install it asks again for the microphone, Screen Recording and Accessibility, and the install says so with a `note: ad-hoc signature` line. Sign every build with one certificate of your own and the permissions stay. A self-signed certificate is enough; it does not need to be trusted.

1. **Mac:** open Keychain Access, then choose **Keychain Access › Certificate Assistant › Create a Certificate…**.
2. **Mac:** type a name (for example `AgentX Local Signing`), set **Certificate Type** to **Code Signing**, and click **Create**.
3. **Terminal:** install with that name:
   ```sh
   AGENTX_SIGN_IDENTITY="AgentX Local Signing" agentx desktop install
   ```
   `apps/mac-voice/install.sh` reads the same variable. If the name is not found in the keychain, the install stops with `The specified item could not be found in the keychain` instead of falling back to ad hoc.

   The first install shows **codesign wants to sign using key … in your keychain**: click **Always Allow**. Until you do, the install waits. Run it in a Terminal window on the Mac the first time: over SSH or from a launchd job there is no window to click, and the build fails (usually `errSecInternalComponent`).
4. **Terminal:** add the variable to your shell profile so every later install uses it:
   ```sh
   echo 'export AGENTX_SIGN_IDENTITY="AgentX Local Signing"' >> ~/.zshrc
   ```
   A shell profile only reaches shells you open. A rebuild started by launchd or a deploy job does not read it: that build is signed ad hoc again, says so only with the `note:` line, and the permissions are lost. Set the variable in that job's environment too.
5. **Mac:** allow the permissions once more, for the first build with the certificate.

The next install keeps them.

## Choose who answers

The AgentX icon in the menu bar shows what the assistant is doing: a waveform when idle, a microphone while listening, dots while the agent thinks, and a speaker while it answers. Its menu lists your agents and what each one is doing: **thinking** on your question, **answer ready** when its answer waits for you to hear it, **speaking**, **working** on something else, **queued 2** when it has two answers waiting to be spoken, or **idle**. An agent with its own shortcut shows it at the end of its row, for example **⌃⌥2**. A number next to the icon counts every line waiting in the [speaking queue](#one-queue-for-everything-spoken).

![The AgentX menu: three agents with Writer ticked and each one's state, the Recent questions to replay, then Stop speaking, Hold notifications, Show floating pill, Animated orb, Hide pill, Reset position, Settings…, Dashboard…, History… and Quit AgentX Voice](/screenshots/voice/menu-bar.png)

![The same menu in dark mode](/screenshots/voice/menu-bar-dark.png)

1. **Mac:** click the AgentX icon in the menu bar, or press **Command–Option–A**.
2. **Mac:** choose an agent, or press its number (**1** to **9**).
3. Hold **Option–Space** and speak. The pill names the agent while it listens, then says **Sent. Ask the next one**.

The app remembers your choice after a restart.

### Ask another agent without switching

Start with an agent's name to send just that question to it. With Writer ticked, "Researcher, what's the status?" goes to Researcher, and Writer stays ticked for your next question.

1. **Mac:** hold **Option–Space**.
2. Say the agent's name first, then your question: "Researcher, what's the status?"
3. Let go. The pill shows the named agent while it answers.

The name can be the agent's id, its `name`, or any of its `mentions` from `agentx.json` without the `@`. Capital letters don't matter. Only the first word or two count, so "ask Researcher later" still goes to the ticked agent. If no agent matches, or more than one does, the ticked agent answers. A name speech to text got one letter wrong ("Radia, …" for Nadia) still reaches the one agent it is that close to; see [Ask another agent by name](../guides/agentx-voice.md#ask-another-agent-by-name).

#### Agents on other computers

When this computer is linked to others running AgentX (a *mesh*, set up with `agentx mesh add`), their agents can be asked by name too. With Writer ticked on this Mac, "Planner, what's the status?" goes to the Planner agent on the other computer. Its answer is spoken here in a voice of its own (see [Agent voices](#agent-voices)), and Writer stays ticked.

- Only computers that are online right now count. **Terminal:** run `agentx mesh list` to see which ones say `healthy`.
- A remote agent answers to its id, its name, and the mentions its computer shares (up to four).
- The same name on two computers, or on this Mac and another computer, is ambiguous: the ticked agent answers. Say the agent's id instead.
- When a computer has an agent with the same id as one on this Mac, the name means the one on this Mac.
- While a remote agent is working, the menu lists it under your agents with its computer's name in brackets, for example **Planner (server) · thinking**.

### Ask several agents at once

You don't wait for an answer any more. As soon as your words are sent, the pill is free for the next request, to the same agent or another one. Each answer waits until you choose to hear it.

1. **Mac:** hold **Option–Space**, ask the ticked agent something, and let go. The pill says **Writer · Sent. Ask the next one**.
2. **Mac:** hold **Option–Space** again at once and ask another agent by name ("Researcher, compare the two plans"), or hold that agent's own shortcut (set in [Settings › Agents](#agents-tab)). Both agents work at the same time.
3. When an answer is ready, you hear one soft sound, and for a few seconds the pill says **Ops answered · hover or ⌘⌥O to hear it**. A blue **1 new** stays on the pill. Nothing plays by itself.
4. **Mac:** pick the answer in the [open-requests list](#open-requests) to hear it.

Each agent gets one request at a time from the assistant. A second request to an agent that is still thinking waits its turn, then goes as soon as the first answer is back. The list shows it as **Waiting its turn**, the menu as **thinking (+1 asked)**, and its small orb in the pill carries a **1**.

Say "stop" to silence every voice without sending anything. During a [call](./calls.md), the call works as before: the agent answers out loud and the microphone opens again after each answer.

To hear answers as soon as they are back, as before, tick **Play answers at once** in the menu, or set **When an answer is ready** to **Play it at once** in [Settings › General](#general-tab). Both are the same setting, saved in `agentx.json` as `voice.answers`. Answers then play one after the other through the [speaking queue](#one-queue-for-everything-spoken), and still show in the list as heard.

#### Open requests

The open-requests list shows one row per request you sent: the agent, what it is doing, the first words of your request, and how long ago you sent it. It opens next to the pill, above it or below it, whichever side has more room.

Open it one of three ways:

- **Mac:** point at the pill for half a second. The list stays while the pointer is on the pill or the list, and goes a moment after it leaves both.
- **Mac:** click the small orbs, or **1 new**, on the pill. The list stays until you press **Escape** or click elsewhere.
- **Mac:** press **Command–Option–O** from any app, or choose **Open requests…** in the menu. The keyboard goes to the list, on the oldest answer you haven't heard.

| A row says | What it means | Pick it to |
|---|---|---|
| **Thinking, 1:12** | The agent is working on it, for 1 minute 12 seconds so far | Nothing yet |
| **Waiting its turn** | Another request to the same agent goes first | Nothing yet |
| A blue dot and **Answer ready** | The answer is back and you haven't heard it | Hear it. The answer plays and its text shows in the pill |
| **Heard** | You have heard it | See its text again. **Listen again** in the pill plays it |
| **Couldn't answer** | The agent could not answer | See why, under the row, with **Ask again** |

Picking a row also makes its agent the one you talk to next: see [Continue a conversation](#continue-a-conversation).

Pick a row with a click, or with the keyboard:

| Key | What it does |
|---|---|
| **Up** and **Down** arrows | Move between rows |
| **Return** | Pick the row. On a failed row that is already open, ask again |
| **Option–Space** (hold) | Talk to the agent of the row you are on |
| **Command–Delete** | Close the row you are on (see [Close a request](#close-a-request)) |
| **Escape** | Close the list |

- VoiceOver reads each row in full, for example "Ops. Answer ready, not heard. You asked: check last night's backups finished. 2 minutes ago.", then offers **Listen**, **Show the answer** or **See why**.
- Heard rows stay in the list until you close them. The eight most recent heard rows are kept; older ones leave by themselves.
- The list is kept by the AgentX daemon, not the app. Quitting the app or restarting the daemon keeps it. A request that was still thinking when the daemon stopped says **Couldn't answer**, with the reason "AgentX restarted before the answer came back. Ask again."
- Heard is the same everywhere: a row you heard on this Mac is read on the phone, and an answer you open on the phone turns to **Heard** on the Mac (see [The same requests on the phone](#the-same-requests-on-the-phone)). Any other app that reads the list from the daemon sees the same (see [Open requests for scripts](#open-requests-for-scripts)).
- **Couldn't answer:** pick the row and it opens in place, with why in one line, for example "The calendar didn't answer in time.", and **Ask again**. **Ask again** asks the same words again in the same row.

  ![The open-requests list, made-up data: Writer thinking, Ops with an answer ready, and Planner's failed row picked, saying The calendar didn't answer in time, with Ask again under it](/screenshots/voice/requests-ask-again-light.png)

  ![The same list in dark mode](/screenshots/voice/requests-ask-again-dark.png)
- **AgentX not answering:** while the daemon doesn't answer, the list says **Can't reach AgentX on this Mac**: your requests are kept by AgentX and come back when it answers. The app tries again every few seconds; **Try now** tries at once, and **Open the dashboard** opens it in your browser. The moment the daemon stops answering, the pill says **AgentX isn't answering** for a few seconds.

  ![The list while the daemon doesn't answer: Can't reach AgentX on this Mac, with Try now and Open the dashboard, and Writer's thinking row kept below](/screenshots/voice/requests-unreachable-light.png)
- **Loading:** if the daemon takes more than half a second to send the list when it opens, two grey rows show until it does.

  ![The list loading: two grey placeholder rows under Open requests](/screenshots/voice/requests-loading-light.png)
- To open the list only with a click or **Command–Option–O**, turn off **Open the list on hover** in [Settings › General](#general-tab).

#### One row per agent

With five requests or fewer, the list shows each request on its own row. From six, it shows one row per agent instead: the agent's name, what most needs you (for example **2 new**, **Thinking**, or **3 requests** when all are heard), how many requests it has, and the first words of the latest one.

![The open-requests list grouped by agent in light mode, made-up data: Ops with 3 requests all heard, Writer thinking with 2 requests, and Researcher with 1 new, the keyboard on it](/screenshots/voice/requests-grouped-light.png)

![The same grouped list in dark mode](/screenshots/voice/requests-grouped-dark.png)

1. **Mac:** pick an agent's row, with a click or **Return**. The list shows that agent's requests only, with its name at the top.
2. **Mac:** pick a request there as usual, or choose **History** at the top for that agent's earlier conversations.
3. **Mac:** press the **Left** arrow or **Escape**, or click the arrow at the top, to go back to every agent.

![Researcher opened from the grouped list, light mode: a back arrow, Researcher and History at the top, then its two requests, one heard and one with an answer ready](/screenshots/voice/requests-agent-light.png)

With the keyboard on an agent's row, holding **Option–Space** asks that agent something new. An agent's row has no **×**: close its requests one by one, or with **Close heard**.

#### Continue a conversation

Each agent has one ongoing conversation, the same as on your phone: a request to one of this computer's agents goes into the phone app's most recent conversation with that agent. Picking a row lets you carry on with that agent, in the same row:

1. **Mac:** open the list and pick the row. Its agent becomes the ticked agent, and the pill says, for example, **Ops · Hold ⌥Space to continue it**.
2. **Mac:** hold **Option–Space** and say your follow-up, for example "and the night before?".
3. The follow-up goes to that agent, which still has your earlier question and its answer in mind. The pill says **Ops · Added to the same request**. No new row is added: the picked row shows your follow-up and thinks again, and its new answer waits with a blue dot.

- The row stays picked for every follow-up, until you close it or talk to another agent (for example "Writer, …"). Then a new row starts.
- Picking a row that is still thinking keeps your follow-up for when that answer is back, then asks it in the same row. The answer you talked over is not played; it stays in [History](#history-of-what-you-asked). If AgentX set aside the first words (for example, it took them as a sound while another agent held the floor), your follow-up is still asked in that row.
- Picking a row that is waiting its turn adds your words to that request, which hasn't gone yet.

#### The same requests on the phone

Your requests from the Mac go into the [phone app's Chat](./mobile-chat.md), in the conversation you had last with that agent, and the agent answers in the same session. If you never chatted with that agent on the phone, a new conversation starts on the phone you used last. With no paired phone that ever chatted, the Mac keeps its own conversation with each agent.

With more than one paired phone, "last" means across all of them: the request goes into the conversation with that agent used most recently on any phone, and a new conversation starts on whichever phone chatted last.

The agent takes one turn at a time in a conversation. A question from the Mac waits while the phone's turn in the same conversation runs, and the phone's next message waits for the Mac's answer. Neither waits for the agent's other work.

| On the Mac | On the phone |
|---|---|
| **Thinking** | Your question shows in the conversation. No chip until the answer is back |
| A blue dot and **Answer ready** | A chip with **New** |
| **Couldn't answer**, not seen | A chip with **New**; the conversation says why |
| **Heard** | No chip: the conversation is read |
| Closed before you heard it | No chip: the conversation is read |

Open the conversation on the phone and the Mac row turns to **Heard** within five seconds. Hear the answer on the Mac and the phone's **New** chip goes. The phone reads the whole conversation then, so an answer to a question you typed on the phone in that conversation is no longer marked **New** either.

If the agent could not answer, or was still busy, the conversation on the phone says so under your question.

Agents on another computer in your mesh keep a conversation of their own with the Mac, apart from the phone's.

#### Close a request

Each row has a **×** that shows when you point at it, or when the keyboard is on it. Closing takes the row out of the list. The question and its answer stay in [History](#history-of-what-you-asked).

![The open-requests list in light mode, made-up data: Ops heard, Researcher with an answer ready and a blue dot, Writer thinking for 1:12, and Close heard at the bottom](/screenshots/voice/requests-close-light.png)

![The same list in dark mode, with the keyboard on the Ops row and its close button showing](/screenshots/voice/requests-close-dark.png)

- **Mac:** a row that is answered, heard or failed closes at once. For five seconds the bottom of the list says, for example, **Closed Ops's request**, with **Undo**.

![The list after closing Ops's row: Researcher and Writer remain, and the bottom says Closed Ops's request with Undo](/screenshots/voice/requests-undo-light.png)
- **Mac:** a row that is still thinking asks first: **Writer is still thinking**, with three choices.

![Writer's thinking row turned into the confirm: Writer is still thinking, with Close, let it finish, Stop Writer and Keep](/screenshots/voice/requests-confirm-light.png)

| Choice | Key | What it does |
|---|---|---|
| **Close, let it finish** | **Return** (the default) | The row goes; the agent keeps working. Its answer goes to History, with no sound |
| **Stop Writer** | **Tab**, then **Return** or **Space** | The row goes and the agent stops working on it. Never the default |
| **Keep** | **Escape** | Nothing changes |

- **Close heard**, at the bottom of the list, closes every heard answer and every failed request at once. Unheard answers and thinking rows stay.

#### Small orbs in the pill

While agents are working, or answers wait to be heard, the [pill](#the-pill-and-its-orb) shows a row of small orbs beside its words, one per agent in that agent's palette. The big orb keeps following the agent that is listening or speaking.

![Three pills with small orbs, light mode: Writer drafting with a Writer and a Planner orb, each with a ring going round; Ops saying its answer, with an Ops orb, a Planner orb with a 1 badge and a Researcher orb with a steady ring; and the idle pill with one Planner orb still thinking](/screenshots/voice/pill-mini-orbs-light.png)

![The same pills in dark mode](/screenshots/voice/pill-mini-orbs-dark.png)

| Small orb | What it means |
|---|---|
| A ring goes round it | Thinking on your request |
| A steady ring and a blue dot | Its answer is ready and you haven't heard it |
| A red ring | It couldn't answer, and you haven't seen why |
| A steady ring | Its answer is back and waits in the [speaking queue](#one-queue-for-everything-spoken) |
| It pulses | Its answer is being spoken |
| Smaller and paler | Only requests waiting for it; none asked yet |
| A number on it | That many more requests wait for it |

- Point at a small orb to see the agent's name, the computer it runs on (**this Mac** for your own agents), and what it is doing.
- Click the small orbs, or **1 new**, to open the [open-requests list](#open-requests). Clicking anywhere else on the pill talks, and dragging moves it, as before.
- More than four agents show as three orbs and **+n**.
- The small orbs move only while the pill is on screen and an agent is thinking or speaking. With Reduce Motion on, or **Animated orb** off in the menu, they stand still.

The rest of the menu works from the keyboard too: use the arrow keys and **Return**, or **Escape** to close it.

| Menu item | What it does |
|---|---|
| **Open requests…** | Opens the [open-requests list](#open-requests) with the keyboard in it. Same as **Command–Option–O** |
| **Play answers at once** | Plays each answer as soon as it is back, instead of waiting until you pick it. Off by default. Saved in `agentx.json` as `voice.answers` |
| **Stop speaking** | Silences every voice (see [Stop every voice at once](#stop-every-voice-at-once)) |
| **Hold notifications** | Holds agent notifications until you turn it off |
| **Show floating pill** | Keeps the [pill](#the-pill-and-its-orb) on screen when idle. Off by default: the pill appears only while listening or answering. Unticked while the pill is hidden, so one click brings it back |
| **Animated orb** | Lets the orb in the pill move with your voice and the answer. On by default. Turn it off for an orb that stands still |
| **Reduce to orb** | Makes the pill a small circle with only its orb, which you can drag anywhere. The item then reads **Show full pill**. With the [character](#the-character) it reads **Reduce to character**: the character stays and its speech bubble goes, and the item then reads **Show speech bubble**. See [reduce the pill to its orb](#reduce-the-pill-to-its-orb) |
| **Hide pill** | Hides the pill and stops the voice, like its close button. The next **Option–Space** or **Show floating pill** brings it back. With the [character](#the-character) it reads **Hide character** and hides the character too, then **Show character** to bring it back |
| **Reset position** | Puts the pill back in the bottom-right corner of the screen, or the character back where it rests by default. While the pill is reduced, puts the orb back in the middle of the bottom edge |
| **Settings…** | Opens the [settings window](#settings-window): voices, shortcuts and speech to text |
| **Dashboard…** | Opens the dashboard's [Settings](./settings.md) page |
| **History…** | Opens the [History window](#history-of-what-you-asked): past questions and answers, by day |

If the daemon isn't running, the menu says **AgentX daemon isn't reachable** and offers **Retry**. Right-clicking the pill opens the same menu.

## The pill and its orb

The pill is the small floating bar that shows what the assistant is doing. It appears in the bottom-right corner of the screen while the assistant listens, thinks or speaks. At its left end is a small, glowing orb in the [palette](#orb-palettes) of the agent that is answering. Next to it, the pill names the agent and says what is happening.

![The pill in four states, light mode: Writer listening with a lagoon orb, Researcher reading files for 12 seconds with a ring on its dusk orb, Ops saying its answer with a sunrise orb, and the idle pill reading HOLD ⌥SPACE](/screenshots/voice/pill-states-light.png)

| What you see | What it means |
|---|---|
| The orb swells and shrinks with your voice, and the pill says **Listening** | The microphone is on and hears you |
| A white ring goes round the orb, and the pill shows the step the agent is on and for how long | The agent is thinking on your question |
| The orb pulses in a speaking rhythm, and the answer scrolls past in the pill | The answer is being spoken |
| A still orb and **HOLD ⌥SPACE** | The assistant is idle. You only see this when **Show floating pill** is ticked; with the character look, only for the first six seconds after the app starts |

![The same four states in dark mode](/screenshots/voice/pill-states-dark.png)

### Read the answer in the pill

When an answer has a link, a picture, or more text than was read aloud, the pill grows to show it. There is no separate window: the orb and the words stay where they were, and the answer opens above them when the pill sits low on the screen, or below them when it sits high.

![The pill grown into an answer, light mode: a release checklist with a bulleted list, a code span and two links, a Release page button, and the pill's own row with the orb underneath](/screenshots/voice/answer-open-light.png)

1. **Mac:** hold **Option–Space** and ask something with a longer answer, for example "Give me the release checklist with links."
2. Let go. When the answer arrives, the pill grows into it while the answer is spoken.
3. **Mac:** read, scroll, or select text in the answer. Click a link or a button to open it in your browser.
4. **Mac:** move the pointer over the answer. Three buttons appear at its top-right corner:
   - **Listen again** (a speaker) says the answer again from its start, in the agent's voice. It waits for anything already speaking, and the microphone stays closed while it plays. While it plays the button shows a stop square: click it again, or press **Command–Option–.**, to stop it. Like that shortcut, stopping it also drops answers from other agents still waiting to be spoken. It works the same in the character's speech bubble.
   - **Copy the answer** (the two pages) copies the whole answer.
   - **Open in chat** (the two speech bubbles) opens the agent's page in the dashboard with its chat open.

   To copy only part of it, select the text and press **Command–C**.

![The answer with the pointer over it: the Copy the answer and Open in chat buttons show at its top-right corner, and the close button at the right end of the pill](/screenshots/voice/answer-hover.png)

5. Leave it. Once the answer has been spoken, the pill shrinks back after 30 seconds. It never shrinks while the pointer is over it. To close it at once, click **×** or press **Esc**.

It follows the look of your Mac: light or dark, and a clearer outline and a more solid background with **Increase contrast** or **Reduce transparency** on (System Settings › Accessibility › Display). With **Reduce motion** on, it grows and shrinks at once, without the animation.

![The answer in dark mode](/screenshots/voice/answer-open-dark.png)

![A pill near the top of the screen grows down instead, its orb row staying at the top](/screenshots/voice/answer-open-below.png)

To change how long the answer stays open or how tall it grows, use **Answer in the pill** on the [General tab](#general-tab), or the Terminal:

```sh
agentx voice card --timeout 60 --max-height 400
```

`--timeout 0` keeps the answer open until you close it. `agentx voice card` on its own shows the current values. In `agentx.json` they are `voice.card.timeout` (seconds, 0 to 600, default 30) and `voice.card.maxHeight` (points, 120 to 800, default 320). A longer answer scrolls.

### Orb palettes

Each agent's orb flows through a gradient drawn from nature. There are seven:

![The seven orb palettes: Sunrise (coral to amber), Desert (terracotta to sand), Forest (moss to fern), Lagoon (teal to aqua), Ocean (deep blue to sky), Dusk (indigo to rose) and Blossom (rose to blush)](/screenshots/voice/orb-palettes.png)

| Palette | Colours | Given to agents whose own colour is |
|---|---|---|
| `sunrise` | coral to amber | red and orange |
| `desert` | terracotta to sand | brown and gold |
| `forest` | moss to fern | green |
| `lagoon` | teal to aqua | teal, and grey |
| `ocean` | deep blue to sky | blue and cyan |
| `dusk` | indigo to rose | violet and purple |
| `blossom` | rose to blush | pink |

Without a choice, an agent that has a [colour](#presence-on-screen) of its own (`presence.color`) gets the palette nearest it, so its orb still matches its on-screen pointer. An agent with neither gets the default palette, `lagoon` (teal). To change the default for every such agent, set `voice.palette` in `agentx.json` to one of the seven ids. The pointer of an agent with no colour keeps the colour picked from its id. To pick a palette for one agent:

1. **Mac:** open **Settings…** from the AgentX menu, pick the agent on the **Agents** tab, and choose an **Orb palette**. **Match the colour** goes back to the default.
2. **Mac:** choose **Save**.

Or in the Terminal, from the folder with your `agentx.json`:

```sh
agentx voice palette                  # the palettes, and which one each agent uses
agentx voice palette writer forest    # pick one
agentx voice palette writer default   # back to the one nearest the agent's colour
```

In `agentx.json` it is the agent's `presence.palette`. The app picks up a change the next time you open its menu.

### The character

The orb can be shown as a character instead: the same orb, grown into a small round creature in the agent's [palette](#orb-palettes), with two eyes. It hovers just above the bottom edge of the screen, above the Dock, and shows what the assistant is doing. The pill becomes its speech bubble: it sits just above the character, with a small tail pointing at it. The orb stays the default; the character is a choice.

![The character in its nine states, in the lagoon palette on a light background and the sunrise palette on a dark one: idle, noticing you, listening with rings beside it, a nod with stars, working with half-closed eyes and three dots, speaking, dozing, an agent calling, and waiting with a question mark](/screenshots/voice/character-states.png)

![The character with its speech bubble above it and a small tail pointing down at it, in three states: listening with rings beside it, working with half-closed eyes and three dots while the bubble reads Reading files and 12 seconds, and speaking with arcs beside it while the bubble shows the words being said. Writer in the lagoon palette on a light background, Ops in the sunrise palette on a dark one](/screenshots/voice/character-bubble.png)

| What you see | What it means |
|---|---|
| It hovers, breathes and blinks, and its eyes follow the pointer | The assistant is idle |
| It stretches up with wide eyes | It has noticed you: you started talking, or it is waking up |
| It leans in, and rings beside it follow your voice | The microphone is on and hears you |
| Its eyes smile and it dips, with a few stars | It has heard you, and starts on your question |
| It looks down with half-closed eyes, and three dots hop beside it | The agent is working on your question |
| It bounces in a speaking rhythm, with arcs on its other side | The answer is being spoken |
| It settles flat with closed eyes, and a **z** rises now and then | Nothing has happened for two minutes: it dozes |
| It hops with wide eyes and rings on both sides | An agent is calling you |
| It tilts its head beside a question mark | You are in a call, and it is your turn to talk |

To switch to the character:

1. **Mac:** open **Settings…** from the AgentX menu and go to the **General** tab.
2. **Mac:** under **Assistant**, set **Shown as** to **Character**, then choose **Save**.

Or in the Terminal, from the folder with your `agentx.json`:

```sh
agentx voice look character   # the character
agentx voice look orb         # back to the orb
agentx voice look             # which one is on now
```

In `agentx.json` it is `voice.look`: `"orb"` (the default) or `"character"`. A change made in the Terminal or in the file shows within a few seconds, while the app runs. The daemon must be running: the app reads the setting from it.

Good to know:

- **It never interrupts:** it takes no keys, and a click where it hovers goes to the window behind it. Only a drag with **Command** held [moves it](#move-or-hide-the-character), and a [play on the page](#play-on-the-page) takes the first key or click to end.
- **It moves out of the way:** when the pointer comes close it glides aside along the edge, leaving a short trail of dots, and comes back a few seconds after the pointer has left. Its bubble goes with it, [reduced to three dots](#the-bubble-while-it-moves) on the way. With **Play mode** ticked it also [plays with the pointer](#play-with-the-pointer).
- **The pill is its speech bubble:** the pill shows the agent's name, the words, the answer and the call buttons as before, attached to the character. It has no orb of its own, and it appears and hides by the same rules as the pill: only while listening or answering, unless **Show floating pill** is ticked.
- **It waits while you use the bubble:** while the pointer is on the bubble, the character stays where it is, so you can click a button or read the answer.
- **The bubble never covers it:** the bubble sits above the character, and rises with it when it jumps. An answer opens above it too. When the character is too high on the screen for that, the answer opens beside it instead, on the left, or on the right when the left has no room.
- **The bubble can't be dragged by itself:** it stays with the character, so [move the character](#move-or-hide-the-character) and the bubble goes with it. The place you dragged the pill to is kept, and the pill goes back there when you switch to the orb.
- **It can lose its bubble:** **Reduce to character** in the menu keeps the character and takes its speech bubble away, until an agent calls or an answer needs reading. See [reduce the character](#reduce-the-character).
- **Colour:** it wears the palette of the agent that is answering, amber while notifications are held and red when something went wrong, like the orb.
- **Reduce Motion:** with **Reduce motion** on, or **Animated orb** unticked in the AgentX menu, it is a still picture that changes between states and stays in its place.
- **It can show you things:** an agent can send it to something on screen, see [The character shows you something](#the-character-shows-you-something).
- **Where it rests:** above the bottom edge of the screen with the menu bar, near the bottom-right corner, under the right end of its bubble, until you move it.

### The bubble while it moves

While the character moves, its bubble is reduced to a small shape with three dots, in the middle above its head, so the character is not carried across the screen under a wide bubble. The dots say the assistant is still there, listening or answering. When the character rests again, the full bubble comes back with its words.

![The character moving to the left with a trail of dots behind it, and above its head a small bubble holding three dots, with a tail pointing down at it](/screenshots/voice/character-bubble-dots.png)

Good to know:

- **Every move counts:** stepping aside, a stroll, a game with the pointer, a drag, and the way to something it shows you and back.
- **A short move changes nothing:** the bubble reduces only once the character has moved for a moment, and comes back a little after it has stopped, so it does not flicker.
- **Something to read or to use is never reduced:** an answer, an error and the call buttons stay in the full bubble, moving or not.
- **A click on the dots** talks, like a click on the bubble.
- **Still picture:** with **Reduce Motion** on, or **Animated orb** unticked, the bubble is never reduced.

### Click the character

While the assistant is idle and the character shows no bubble, the character is what you click:

- **Click it** to start listening, the same as a click on the pill or **Option–Space**.
- **Right-click it** to open the menu, the same as the AgentX icon in the menu bar.

It waits for the pointer then and does not step aside. Good to know:

- **A click no longer goes through it:** while it can be clicked, a click on its body does not reach the window behind it. Drag it out of the way to reach what is under it.
- **With a bubble, click the bubble:** as soon as it shows a bubble, clicks on the character go through to the window behind again, and it steps aside for the pointer as before.
- **Play mode:** a game stops when the pointer reaches the character. When it runs away, wait for it to stop, at most two and a half seconds.

### Move or hide the character

With a bubble showing, the character steps aside when the pointer comes close, so hold **Command** to make it wait. Idle with no bubble, it waits by itself and **Command** is not needed. To move it:

1. **Mac:** hold **Command** and move the pointer onto the character.
2. **Mac:** press on it and drag it where you want it, on any screen. Its bubble goes with it.
3. Let go. The character rests there, steps aside from there, and comes back to the same place the next time the app starts.

To put it back where it rests by default:

1. **Mac:** click the AgentX icon in the menu bar.
2. **Mac:** choose **Reset position**.

To hide the character and its bubble together, use any of the ways to [hide the pill](#hide-the-pill): the bubble's **×** button, **Esc** after a click on the bubble, or **Hide character** in the AgentX menu. The voice that is speaking stops too. Hold **Option–Space**, or choose **Show character** in the menu, to bring both back.

Good to know:

- **Its place is its own:** the character's place and the pill's place are kept apart, so moving one never moves the other when you switch looks.
- **It stays on screen:** it goes no closer to the top of a screen than its bubble needs, and no further right than where it rests by default. If its screen is no longer connected, it comes back to the bottom-right corner of your main screen.
- **Hidden until you ask:** a hidden character stays hidden, whatever an agent says meanwhile. It comes back with **Option–Space**, an agent's own shortcut, an incoming call, **Show character** or **Show floating pill**, and when the app starts again.

### Let the character stroll

By default the character moves only to get out of the pointer's way. It can also take a slow stroll when the assistant has nothing to do. This is off by default.

To turn it on:

1. **Mac:** open **Settings…** from the AgentX menu and go to the **General** tab.
2. **Mac:** under **Assistant**, tick **Character strolls when idle**, then choose **Save**.

Or in the Terminal, from the folder with your `agentx.json`:

```sh
agentx voice stroll on    # a slow stroll now and then
agentx voice stroll off   # it stays where it rests
agentx voice stroll       # which one is on now
```

In `agentx.json` it is `voice.stroll`: `false` (the default) or `true`. A change made in the Terminal or in the file is picked up within a few seconds, while the app runs.

Good to know:

- **What a stroll is:** after 25 to 55 seconds with nothing to do, the character walks slowly a little way to one side, at most 110 points, waits there a few seconds and walks back. It leaves no trail of dots.
- **Work comes first:** when you talk or an agent answers, it walks back to where it rests. The pointer still sends it aside as before.
- **It stops when it dozes:** after two minutes with nothing to do the character dozes where it rests, and a dozing character does not stroll.
- **It stays on screen:** next to the edge of the screen it strolls to the other side.
- **It stops at windows, in play mode:** with [**Play mode**](#play-on-the-page) also ticked, a stroll stops short of the side of a window that comes down to the character's line. It turns to look at it, then walks back; on the way back nothing stops it. The app's own windows, such as **Settings…**, count too. It reads only where the windows are, never what is in them, so no permission is asked.
- **Not with a still character:** with **Animated orb** unticked or Reduce Motion on, the character does not move at all.
- **Only with the character:** the setting has no effect while the orb is shown, and the tick box is greyed out.

### Let the character play by itself

When the assistant has nothing to do, the character plays a small animation from time to time, just for the fun of it. This is on by default, at **Sometimes**.

To change how often, or turn it off:

1. **Mac:** open **Settings…** from the AgentX menu and go to the **General** tab.
2. **Mac:** under **Assistant**, set **Character plays when idle** to **Never**, **Rarely**, **Sometimes** or **Often**, then choose **Save**.

Or in the Terminal, from the folder with your `agentx.json`:

```sh
agentx voice animations off         # none
agentx voice animations rarely      # one every 60 to 120 seconds
agentx voice animations sometimes   # one every 25 to 50 seconds
agentx voice animations often       # one every 10 to 20 seconds
agentx voice animations             # which one is set now
```

In `agentx.json` it is `voice.animations`: `"off"`, `"rarely"`, `"sometimes"` (the default) or `"often"`. A change made in the Terminal or in the file is picked up within a few seconds, while the app runs.

The animations:

| Animation | What you see |
|-----------|--------------|
| **Look around** | Its eyes go to one side, then the other, and back |
| **Hop** | A short crouch, then a small jump on the spot |
| **Sway** | It leans from side to side twice |
| **Stretch and yawn** | It stretches tall and shuts its eyes for a moment. This one comes just before it dozes, not at random |

Good to know:

- **Work comes first:** no animation starts while you talk, while an agent thinks or speaks, during a call, while the character shows you something, or while its bubble holds an answer. One that is playing stops at once.
- **The pointer comes first:** it does not play while it steps aside, walks, or plays a game with the pointer in [play mode](#play-on-the-page).
- **Not while notifications are held:** with **Hold notifications** ticked in the AgentX menu, it plays nothing. This is AgentX's own hold, not the Focus of macOS, which the app cannot read.
- **It stays where it is:** an animation never moves it along the edge and leaves no trail.
- **It stops when it dozes:** after two minutes with nothing to do the character dozes, and a dozing character plays nothing. So **Rarely** shows one animation or two before the yawn.
- **Not with a still character:** with **Animated orb** unticked or Reduce Motion on, the character does not move at all.
- **Only with the character:** the setting has no effect while the orb is shown, and the control is greyed out.

### The character shows you something

An agent can send the character to something on your screen. The character leaves its place, flies beside the thing, and marks it with a box, an oval or an underline. Then it goes back to where it rests. This needs **Shown as** set to **Character** and the character on screen.

To try it yourself:

1. **Mac:** open any app with a button or a field you can name, for example a search field.
2. **Terminal:** run the command below. The character goes to the field, draws an oval around it, and goes home after eight seconds.

```sh
agentx point "the search field" --mark circle
```

While the character is on screen, an agent you speak to is told it can run the same command, so it decides by itself when to show you something and where. A [live lesson](#live-lessons) does it at every step: the character points in place of the agent's drawn cursor.

| Option | What it does |
|---|---|
| `--mark box` | A box around the thing, lightly filled. The default |
| `--mark circle` | An oval around it |
| `--mark underline` | A line under it |
| `--mark none` | The character goes there and marks nothing |
| `--hold 20` | Seconds before it goes home: `8` by default, up to `120` |
| `--text "Search starts here"` | What its bubble says while it stands there. Without it there is no bubble at the stop |
| `--expression speaking` | The state it shows while it stands there. See [Ask for a state by name](#ask-for-a-state-by-name) |

Good to know:

- **Nothing is clicked:** the character and its mark are drawn on a layer of their own. No click or key goes to any app, and your pointer is not moved.
- **Its bubble there:** the bubble shows the text you gave from the moment the character is sent, on its way and for as long as it stands there, and goes when it leaves. It is not reduced to its three dots on the way, and it stays while an agent is listening, working or speaking; only an error or a call takes its place. The text is in the size of an answer's text, and the bubble is as wide as the text, last letter included, up to the width of an answer (about 45 characters). The text is one line: line breaks become spaces, it is cut at 120 characters, and a text wider than the widest bubble scrolls. With no text there is no bubble at the stop. The **hold ⌥space** hint shows only where the character rests, never on its way, at a stop, or during a play, and only for the first six seconds after the app starts: after that the character has no bubble while idle, unless notifications are held.
- **Where it stands:** on the left of the thing, level with its middle, so its bubble does not cover it. With no room on the left it stands on the right.
- **It does not step aside meanwhile:** while it shows something, the pointer can come close. Take hold of it with **Command** to end the showing and move it.
- **No busy look at a stop:** while the character is sent to show something, it does not take the working look when an agent is thinking, so the move stays in view. It still listens when you talk and speaks when the answer is read.
- **Without the character:** with the orb look, with the character hidden, or with AgentX Voice closed, `agentx point` moves the highlight cursor as before.

### Ask for a state by name

The character can show any of its nine states when you ask, for example to record a demo. This needs **Shown as** set to **Character** and the character on screen.

1. **Terminal:** run the command below. The character shows the listening state where it rests for five seconds, then its real state again.

```sh
agentx express listening --hold 5
```

2. **Terminal:** to show a state at something on screen, add `--expression` to `agentx point`:

```sh
agentx point "the search field" --text "Search starts here" --expression speaking
```

| State | What you see |
|---|---|
| `idle` | At rest, eyes open |
| `notices` | It looks up at you |
| `listening` | Rings beside it |
| `working` | Half-closed eyes and three dots: the busy look |
| `speaking` | The arcs of its voice |
| `understood` | A nod with stars |
| `dozing` | Asleep |
| `calling` | Ringing, as for a call |
| `asking` | Waiting with a question mark, as in a call between turns |

Good to know:

- **How long:** `--hold` is in seconds, `8` by default, up to `120`. A newer command ends it sooner.
- **Your turn comes first:** when you start talking, when a call rings, and in a call between turns, the character shows that instead, whatever was asked.
- **Where:** `agentx express` shows the state where the character rests. If the character stands at something, it goes home first.
- **Without the character:** the command answers that no character is on screen, and nothing changes.
- **Reduce Motion:** with **Reduce motion** on, or **Animated orb** unticked, the character and the mark appear in place without the flight.
- **One thing at a time:** a new place replaces the one before. Hiding the character removes the mark.

### Play on the page

The character can leave its place and play on a picture of your screen: it walks along a line of text, then eats words, wipes a line, kicks a word to pieces, stomps a line down or carries a word away. The page decides what it does where, so each page gets its own play, and each play is different. It is one movement from start to end: the character never disappears, it shrinks as it jumps onto the page and grows as it jumps back. It is a short show, about fifteen seconds, and the real page is never touched. Play mode is off by default.

To switch it on and start a play:

1. **Mac:** click the AgentX icon in the menu bar and tick **Play mode**. A new row, **Play on this page**, shows in the menu. The tick is kept on this Mac, like **Animated orb**.
2. **Mac:** choose **Play on this page**.
3. **Mac:** the first time, macOS asks to let AgentX Voice record the screen and the pill says **Allow Screen Recording**. Open System Settings › Privacy & Security › Screen & System Audio Recording and switch on **AgentX Voice**. Then quit AgentX Voice from its menu, open it again and choose **Play on this page** once more.

What happens:

1. The app takes one picture of the screen the character is on, without the character and its bubble, and lays it over that screen. The character stays where it stood, at its usual size, with its three thinking dots, while the lines of text are read. The reading is done on the Mac by Apple's text recognition; nothing is uploaded.
2. The character crouches and jumps onto the page, shrinking in the air to fit between the lines. It lands on the page's heading, the line clearly taller than the others, and walks along it. On a page with no heading it takes one of the lines near the middle of the screen.
3. It goes to up to four other lines near the middle and does one thing to each, never the same thing twice in a play. The page decides which line gets what:
   - **Eat:** it eats up to three words of any line, letter by letter.
   - **Wipe:** it wipes the widest line with a cloth.
   - **Kick:** it kicks the longest word of the line that has the longest one. The letters fly off and pile up at the bottom of the screen.
   - **Stomp:** it hops on the line with the most words until they drop one by one, then falls after them.
   - **Carry:** it lifts a word of the shortest line over its head and puts it down at the end of the line it walked.
4. It rests, then jumps back to where it stood, growing in the air to its usual size. The picture goes, and the character is on its edge as before. The page is as it was.

The order of the acts, which one is left out and which words are eaten or carried change with every play.

It moves like a drawn character, not like a pointer: it crouches before a jump and lands softly, it gets up to speed and slows to a stop when it walks, kicked letters leave one after the other, and what falls bounces once before it lies still.

Play ends at once on any key (**Esc** included), any click or scroll, the talk key, a change of Space, when the assistant starts to listen, speak or ring, or when the screen it plays on is unplugged, resized or moved. Ended this way, the picture goes at once and the character is back on its edge, without the jump home. A Dock that moves or hides, or a screen that changes its brightness, does not end a play.

Good to know:

- **Nothing real is changed:** no click, key or edit is sent to any app. The words that go are only painted over on the picture.
- **The picture stays on the Mac:** it is kept in memory only, never written to disk, and dropped when play ends.
- **When the row is greyed out:** **Play on this page** needs **Shown as** set to **Character**, the character on screen (not hidden), **Animated orb** ticked, **Reduce motion** off, and an idle assistant.
- **It takes clicks and keys while it plays:** the picture covers the screen, so the first key or click ends the play and goes no further. Outside a play, the character still takes none.
- **One screen:** it plays on the screen the character is on. Other screens stay live.
- **A short wait before it starts:** reading the text takes one to a few seconds. The screen is already frozen during that time.
- **No text, no play:** if no line of at least two words is found away from the top of the screen, the picture goes again and nothing plays.
- **Letters are an estimate:** a word's box is cut into equal parts, so a letter can go a little early or late, and a kicked letter can carry a sliver of the one next to it.
- **On a page with one line of text:** it walks that line and does one thing to it.
- **Photos and gradients:** on a background that isn't one flat colour, the painted-over patch shows, and a letter or word that moves takes some of the background with it. On a flat colour only the ink moves, so a flying letter does not hide the text it passes.
- **It has no mouth:** eating shows as letters going at its front, with a small bite squash.

### Play with the pointer

With **Play mode** ticked, the character also plays with your pointer while the assistant is idle. It stays on its own edge of the screen, draws only in its own small window, and sends nothing to any app. It needs no permission.

When the pointer moves near it (about 520 points to either side and 360 above), it starts one game:

- **Follow:** it walks along its edge to where the pointer is and stops a little short of it, for four to seven seconds.
- **Jump:** if the pointer is close and low enough, it crouches, then jumps at the place the pointer was. If the pointer is still there when it lands, it has caught it and shows its stars.
- **Run away:** it runs further off than when it only steps aside.

After a game it rests for five to thirteen seconds, and goes back to its place if you leave it alone. A click near it makes it jump once and ends the game.

Good to know:

- **It takes no clicks:** a click where it is still goes to the window behind it. It only sees that the button went down.
- **Work comes first:** a game stops when the assistant listens, thinks, speaks or rings, and when the pointer is on its bubble or leaves its screen.
- **A bubble with something to use stays put:** while the bubble shows an answer, an error or the call buttons, no game starts and a click gives no jump, so the bubble does not move away from your hand.
- **The empty bubble plays too:** with **Show floating pill** ticked, the bubble that only reads "hold ⌥space" goes with the character in a game, [reduced to three dots](#the-bubble-while-it-moves). If it moves away as you reach for it, wait for the game to end, or untick **Play mode**.
- **Along one edge:** it does not climb windows or walk on text here. It follows the pointer only left and right.
- **The same games in the same order** each time the app starts.
- **No play** with **Reduce motion** on, **Animated orb** unticked, or a sleeping character: the pointer has to come close to wake it first.

### Move the pill

1. **Mac:** press anywhere on the pill (the orb and the words too) and drag it where you want it.
2. Let go. The pill stays there, and it comes back to the same place the next time the app starts.

While the [character](#the-character) shows, the pill is its speech bubble: [move the character](#move-or-hide-the-character) instead, and **Reset position** puts the character back.

If the pill was on a screen that is no longer connected, it comes back in the bottom-right corner of your main screen. To put it back in the corner yourself:

1. **Mac:** click the AgentX icon in the menu bar.
2. **Mac:** choose **Reset position**.

### Reduce the pill to its orb

The pill can be reduced to its orb alone: a small circle with no name, no words and no buttons. The orb is then the assistant's place on screen: the full pill opens over it when there is something to read or to answer, and goes back to the orb by itself once that is over.

![The full pill at rest, reading HOLD ⌥SPACE beside its orb, and next to it the same pill reduced: a small circle holding only the orb](/screenshots/voice/pill-reduced-light.png)

1. **Mac:** right-click the pill, or click the AgentX icon in the menu bar.
2. **Mac:** choose **Reduce to orb**. The pill becomes a circle in the middle of the bottom edge of the screen.
3. **Mac:** drag the orb where you want it and let go. It stays there, and comes back to the same place the next time the app starts. The orb and the full pill each keep their own place.

To open the full pill, click the orb once. It stays open until your next turn is over, then goes back to the orb by itself. To keep the full pill, choose **Show full pill** in the menu.

Good to know:

- **It still shows the state:** the orb has the same colours and the same motion as the orb inside the pill: it follows your voice while listening, turns while the agent works and pulses while the answer is spoken.
- **It still listens:** hold **Option–Space** as usual. A click on the reduced orb opens the pill; it does not start the microphone.
- **It opens by itself when you must not miss something:** an agent calling you, and an answer that has more to read or buttons to press, open the full pill.
- **It goes back by itself:** however the full pill opened, with a click, a call or an answer, the orb comes back once the turn is over: the answer has been spoken, an open answer has [closed](#read-the-answer-in-the-pill), the call has ended, and the assistant is idle again. A pill opened with a click waits for a turn first, so it does not vanish while you look at it.
- **It stays on screen:** the reduced orb shows even when idle, whatever **Show floating pill** says. **Esc** or **Hide pill** hides it until the next **Option–Space**.
- **With the character:** the [character](#the-character) has a reduced form of its own, see [reduce the character](#reduce-the-character).

#### Reduce the character

While the [character](#the-character) is shown, the pill is its speech bubble and has no orb of its own. Reduced, the character stays, at its size, with its eyes, its colours and its motion, and its speech bubble goes: no name, no words and no buttons while it listens, works or speaks. The character alone shows what the assistant is doing.

1. **Mac:** right-click the character while it is idle, or click the AgentX icon in the menu bar.
2. **Mac:** choose **Reduce to character**. The bubble goes; the character stays where it is, and you can still [move it](#move-or-hide-the-character) with **Command** held.

To give it its bubble back, choose **Show speech bubble** in the menu.

Good to know:

- **It opens its bubble by itself when you must not miss something:** an agent calling you, an answer that has more to read or buttons to press, and the caption of [something it shows you](#the-character-shows-you-something) open the bubble. Once that is over, the bubble goes again by itself.
- **A click still talks:** a click on the idle character starts the microphone, as it does with the bubble; there is no bubble to open.
- **Hide character** still hides both, until the next **Option–Space**.

To start reduced every time the app opens:

1. **Mac:** open **Settings…** from the AgentX menu and go to the **General** tab.
2. **Mac:** under **Assistant**, tick **Start reduced**, then choose **Save**.

Or in the Terminal, from the folder with your `agentx.json`:

```sh
agentx voice start reduced   # start as the orb alone, or the character without its bubble
agentx voice start full      # start as the full pill
agentx voice start           # which one is on now
```

In `agentx.json` it is `voice.startReduced`: `false` (the default) or `true`. The app reads it when it starts, so a change made in the Terminal or in the file shows the next time the app starts. With the orb look it starts as the orb alone; with the [character](#the-character), as the character without its speech bubble.

### Hide the pill

Hiding the pill also stops the voice that is speaking, the same as **Command–Option–.**. Use any of these:

- **Mac:** move the pointer over the pill and click the **×** button that appears at its right end.
- **Mac:** click the pill, then press **Esc**. (Clicking the pill also starts listening, the same as **Option–Space**.)
- **Mac:** click the AgentX icon in the menu bar and choose **Hide pill**.

![The pill with the pointer over it: the close button shows at its right end](/screenshots/voice/pill-hover.png)

The pill stays hidden until you next hold **Option–Space** (or an agent's own shortcut). It then comes back where you left it.

Good to know:

- **Colour:** each agent's orb uses its [palette](#orb-palettes). Without one it gets the palette nearest its `presence.color` (see [Presence on screen](#presence-on-screen)), or the colour picked from its id. The orb turns amber while notifications are held and red when something went wrong.
- **Your typing is safe:** showing the pill never takes the keyboard from the app you are using. Only clicking the pill does, so that **Esc** can reach it.
- **Reduce Motion:** with **System Settings › Accessibility › Display › Reduce motion** on, the orb stands still. It still changes between listening, thinking and speaking, but nothing moves on its own.
- **A still orb:** to keep the orb still without changing the system setting, click the AgentX icon in the menu bar and choose **Animated orb** to remove its tick.
- **Speaking rhythm:** the answer is played by the AgentX daemon, not by the app, so the orb pulses in a speaking rhythm rather than measuring the sound.
- **No battery drain when idle:** the orb only moves while the assistant listens, thinks or speaks. Idle or hidden, it stops completely.

## Settings window

The settings window changes each agent's voice and the app's own shortcuts without editing `agentx.json` by hand. It saves through the AgentX daemon, which checks every value first and then writes `agentx.json`. The app keeps no copy of its own, so the file stays the one place your settings live.

1. **Mac:** click the AgentX icon in the menu bar, or press **Command–Option–A**.
2. **Mac:** choose **Settings…** (or press **Command–,** while the menu is open).
3. Change what you need on the **Agents**, **General** or **Speech** tab.
4. Choose **Save** (or press **Command–S**). A red message at the bottom says what to fix if a value is refused; nothing is saved then.

Nothing in the window needs a restart. Voice changes apply to the next line the agent speaks, shortcuts change as soon as you save, and the speech-to-text engine applies to your next question. **Revert** puts back what is saved.

### Agents tab

Pick an agent on the left; its settings show on the right.

![The Agents tab with Researcher picked: its voice provider, Mac voice, speaking speed, narration, queue priority, no shortcut, a violet orb colour and the Dusk orb palette](/screenshots/voice/settings-agents.png)

| Setting | What it does | Saved in `agentx.json` as |
|---|---|---|
| **Voice provider** | **Mac voices** (free) or **ElevenLabs**. **Default** follows the Speech tab | agent `voice.provider` |
| **Mac voice** | One of the voices installed on this Mac, **The Mac's default voice**, or **Assigned automatically** (each agent gets a different one). An agent with one voice per language shows that and leaves it alone | agent `voice.system` |
| **ElevenLabs voice ID** | The ElevenLabs voice, used when the provider is ElevenLabs. Empty: the default voice | agent `voice.elevenlabsVoiceId` |
| **Preview** | Says a sample line in the voice as it is set in the window, before you save | nothing |
| **Speaking speed** | From 0.75× to 1.5×; **Normal** is 1×. ElevenLabs speaks at most 1.2× and at least 0.7× | agent `voice.rate` |
| **Narration** | Short spoken updates while the agent works: **Off**, **On, except scheduled jobs**, or **On, scheduled jobs too** (see [Task narration](#task-narration)) | agent `voice.narrate` |
| **Queue priority** | **High**: this agent's lines go ahead of lines already waiting in the [speaking queue](#one-queue-for-everything-spoken). **Low**: they go after them. **Normal**: in order of arrival | agent `voice.priority` |
| **Ask with shortcut** | Hold this shortcut and speak to ask this agent, without changing the agent ticked in the menu. Click the field, then press the keys; **Escape** cancels, **Delete** or the clear button removes it | agent `voice.hotkey` |
| **Orb colour** | The colour of this agent's on-screen pointer, which also picks its orb palette by default. **Use default** goes back to the colour picked from the agent's id | agent `presence.color` |
| **Orb palette** | The [nature palette](#orb-palettes) of this agent's orb. **Match the colour** uses the one nearest the orb colour | agent `presence.palette` |

To hear a voice before you keep it:

1. **Mac:** on the **Agents** tab, pick the agent.
2. **Mac:** choose a different **Mac voice** or **Speaking speed**.
3. **Mac:** choose **Preview**. The agent says "Hello, this is …" in the new voice.
4. **Mac:** choose **Save** to keep it, or **Revert** to go back.

### General tab

![The General tab in dark mode: Talk, Stop every voice and Smart paste shortcuts, the fixed Open the menu shortcut, Answer in the pill with Keep the answer open and Tallest answer, and Launch at login](/screenshots/voice/settings-general.png)

![The Answers group of the General tab, made-up settings: When an answer is ready set to Wait until I pick it, Soft sound set to Glass, and Open the list on hover on](/screenshots/voice/settings-answers-light.png)

| Setting | What it does | Saved as |
|---|---|---|
| **Talk (hold)** | Hold to speak, let go to send. Default **Option–Space** | `voice.hotkeys.talk` |
| **Stop every voice** | Silences everything spoken. Default **Command–Option–.** | `voice.hotkeys.stop` |
| **Smart paste** | Reshapes the clipboard, then pastes. Default **Command–Option–V** | `voice.hotkeys.paste` |
| **Open the menu** | **Command–Option–A**. Fixed; shown so you don't reuse it | not saved |
| **Open requests** | **Command–Option–O**. Opens the [open-requests list](#open-requests). Fixed; shown so you don't reuse it | not saved |
| **When an answer is ready** | **Wait until I pick it** (a soft sound and a blue dot, the default) or **Play it at once**, as before. Same as **Play answers at once** in the menu | `voice.answers`: `"wait"` or `"play"` |
| **Soft sound** | The Mac sound played once when an answer is ready and waits for you: **Pop** (the default), **Tink**, **Glass** and the rest of the Mac's alert sounds. Picking one plays it. Only with **Wait until I pick it** | `voice.readySound` |
| **Open the list on hover** | Half a second's pointing at the pill opens the [open-requests list](#open-requests). Off: only a click or **Command–Option–O** opens it. Default on | `voice.listOnHover` |
| **Shown as** | The **Orb** in the pill, or the [**Character**](#the-character) above the bottom edge of the screen, with the pill as its speech bubble. Default **Orb** | `voice.look` |
| **Start reduced** | The app starts with the pill [reduced to its orb](#reduce-the-pill-to-its-orb), or the character [without its speech bubble](#reduce-the-character). Default off | `voice.startReduced` |
| **Character strolls when idle** | The [character](#the-character) takes a [slow stroll](#let-the-character-stroll) when the assistant has nothing to do. Default off | `voice.stroll` |
| **Character plays when idle** | How often the [character](#the-character) plays a [small animation by itself](#let-the-character-play-by-itself): **Never**, **Rarely**, **Sometimes** or **Often**. Default **Sometimes** | `voice.animations` |
| **Keep the answer open** | How long the [answer in the pill](#read-the-answer-in-the-pill) stays open once it has been spoken, or **Until I close it** | `voice.card.timeout` |
| **Tallest answer** | How tall the answer grows before it scrolls, 120 to 800 points | `voice.card.maxHeight` |
| **Launch at login** | Starts the app when you log in. Saved by macOS as a login item, not in `agentx.json`. If you installed with `agentx desktop install`, that already starts it at login: the switch is on and greyed out | macOS |

A shortcut needs **Control**, **Option** or **Command** (a function key such as **F5** can stand alone), so it never takes a key away from your typing. Two actions can't share one shortcut: the window says which ones clash.

When the app starts and after each save, it writes one line per shortcut to `~/Library/Logs/agentx-voice.log`: `shortcut opt+space for talk: registered`, or a warning that another app holds that shortcut. If a shortcut does nothing, look there first.

![A refused save on the General tab: Smart paste is set to Control–Option–2, and the red message next to Revert and Save says that shortcut is used for both smart paste and asking Researcher](/screenshots/voice/settings-error.png)

In `agentx.json` a shortcut is written as modifiers and a key joined by `+`, for example `"opt+space"`, `"cmd+opt+period"` or `"ctrl+opt+1"`. Modifiers are `ctrl`, `opt`, `shift` and `cmd`; keys are a letter, a digit, `f1` to `f20`, or `space`, `period`, `comma`, `slash`, `semicolon`, `quote`, `minus`, `equal`, `return` or `tab`.

### Speech tab

![The Speech tab in dark mode: Speech to text, the On-this-Mac engine, End of a hands-free turn and Default voice provider](/screenshots/voice/settings-speech.png)

| Setting | What it does | Saved as |
|---|---|---|
| **Speech to text** | **Automatic**: ElevenLabs when a key is set, the engine on this Mac otherwise. **ElevenLabs**: the same, and the app log says so when no key is set. **On this Mac**: your voice never leaves the Mac | `voice.stt` |
| **On-this-Mac engine** | **Whisper**: mlx-whisper, every language. **Parakeet**: faster, no Arabic, downloads 483 MB the first time. See [Speech to text on this Mac](#speech-to-text-on-this-mac) | `voice.localStt` |
| **End of a hands-free turn** | **Voice detection**: the turn ends when you stop talking. **Volume**: the older check, which ends it when the room goes quiet. See [When a hands-free turn ends](#when-a-hands-free-turn-ends) | `voice.endOfTurn` |
| **Default voice provider** | The voice provider for agents set to **Default** | `voice.provider` |

**Command–Option–V** is smart paste: it reshapes the clipboard for wherever you are typing. It runs the `agentx paste` command, so that command must work. The helper also powers [pointing, screen checks, and guided lessons](../tutorials/record-vscode.md).

## Speech and configuration

| Setting | Default / purpose |
|---|---|
| `AGENTX_DAEMON_URL` | `http://127.0.0.1:18800` |
| `AGENTX_VOICE_AGENT` | Pins the agent the app talks to; the menu can't switch while it is set. `agentx desktop install --agent <id>` sets it. Without it: the agent picked in the menu, else the daemon's `node.defaultAgent`, else the first agent |
| `AGENTX_DASHBOARD_URL` | `http://127.0.0.1:4202`, opened by the menu's **Dashboard…** and by **Open task in dashboard** in the History window |
| `ELEVENLABS_API_KEY` | Optional hosted transcription, and speech for agents whose provider is `elevenlabs` |
| `AGENTX_VOICE_ID` | ElevenLabs voice ID for `elevenlabs` agents without `voice.elevenlabsVoiceId` |
| `AGENTX_VOICE_PROVIDER` | `system`; which engine speaks before the daemon has named one (e.g. an error line) |
| `AGENTX_MLX_WHISPER` | `~/.local/bin/mlx_whisper`, the local transcription executable |
| `AGENTX_MLX_MODEL` | `mlx-community/whisper-large-v3-turbo` |
| `AGENTX_VOICE_PATH` | Read by the installer, not the app: the full `PATH` to give the login service. By default, this is the folder of the `ffmpeg` found at install time plus macOS's standard folders. The installer skips an `ffmpeg` that is a script (a file starting with `#!`, such as a wrapper you put earlier in your `PATH`) and uses the first real program instead |
| `AGENTX_MODELS_DIR` | `~/.agentx/models`, where the voice detection and Parakeet models are downloaded |

Without an ElevenLabs key, transcription needs a working local `mlx_whisper` installation. Speech uses the free macOS voices unless you choose ElevenLabs (see [Agent voices](#agent-voices)). ElevenLabs usage and the agent's model usage are separate costs. The app checks the key environment variable first, then `~/.elevenlabs/key` and `~/.agentx/elevenlabs-key.txt`.

The installer persists the pinned agent (if any), daemon URL, helper path, and CLI command in the login service. Finder does not inherit terminal environment variables. Use a key file for speech credentials or configure the login service environment for advanced speech settings.

## When a hands-free turn ends

After an answer, the microphone opens again by itself for a follow-up, and clicking the pill opens it too. Nobody holds a key then, so the app has to hear when you have finished. It sends what you said once you have stopped talking for 1.2 seconds. Shorter pauses, the kind people make in the middle of a sentence, don't end the turn.

By default the app listens with *voice detection*: a small model (Silero VAD, 0.9 MB) that tells a voice apart from a fan, a keyboard, or a busy café. Background noise then neither ends your turn early nor keeps the microphone open after you have finished. The older way, **Volume**, treats any sound louder than a fixed level as talking, so in a loud room it can keep listening long after you have finished.

The model is downloaded the first time the microphone opens, into `~/.agentx/models/silero-vad-coreml` (about 1 MB, checked against a fixed checksum). Until it has arrived, and whenever it can't be loaded, the app uses the volume check instead.

To change it:

1. **Mac:** click the AgentX icon in the menu bar and choose **Settings…**.
2. **Mac:** open the **Speech** tab.
3. **Mac:** set **End of a hands-free turn** to **Voice detection** or **Volume**.
4. **Mac:** choose **Save**. The next hands-free turn uses it.

In `agentx.json` this is `voice.endOfTurn`: `"vad"` (default) or `"volume"`.

## Speech to text on this Mac

When the app can't use ElevenLabs (no key, no network, or **Speech to text** set to **On this Mac**), it turns your speech into text on the Mac itself. Two engines can do that:

| | Whisper (default) | Parakeet |
|---|---|---|
| Program | `mlx_whisper`, a Python tool you install (see [local Whisper](../requirements.md#option-b-local-whisper)) | Built into the app; nothing to install |
| Languages | All Whisper languages, including Arabic | 25 European languages, including English and French. **No Arabic** |
| Download | About 1.5 GB, by `mlx_whisper` the first time | 483 MB, by the app the first time |
| Speed | Several seconds per question | A fraction of a second per question |

Parakeet is NVIDIA's Parakeet TDT 0.6B v3 speech model (licensed CC-BY-4.0), in the Core ML format that runs on the Mac's Neural Engine. The app downloads it from Hugging Face into `~/.agentx/models/parakeet-tdt-0.6b-v3-coreml` and checks every file against a fixed checksum before using it. Whisper stays the default until the comparison below has been reviewed.

### Switch to Parakeet

1. **Mac:** click the AgentX icon in the menu bar and choose **Settings…**.
2. **Mac:** open the **Speech** tab.
3. **Mac:** set **On-this-Mac engine** to **Parakeet**, then choose **Save**.
4. **Mac:** ask a question. If **Speech to text** is **On this Mac**, or no ElevenLabs key is set, the app starts downloading Parakeet in the background the first time, and Whisper answers meanwhile.
5. **Mac:** after the download, the first question loads Parakeet, which can take about 30 seconds on a new Mac (macOS prepares it for the Neural Engine once). Whisper answers until it is ready; after that, Parakeet answers.

To download the models ahead of time instead:

1. **Terminal:** run
   ```sh
   ~/Applications/"AgentX Desktop.app"/Contents/MacOS/agentx-voice-local fetch all
   ```
   It prints its progress and `parakeet: installed in …` when done.
2. **Terminal:** run the same program with `status`. Both models show `installed`.

In `agentx.json` the engine is `voice.localStt`: `"mlx-whisper"` (default) or `"parakeet"`.

### Compare the local engines

A benchmark script runs Whisper and Parakeet on the same recordings and reports the time each takes and its *word error rate* (the share of words it got wrong; lower is better). It uses sentences spoken by the Mac's own English, French and Arabic voices, the same with room noise added, and optionally real recordings.

1. **Terminal:** from a source checkout, build the app: `apps/mac-voice/build.sh`.
2. **Terminal:** fetch Parakeet: `"apps/mac-voice/build/AgentX Voice.app/Contents/MacOS/agentx-voice-local" fetch parakeet`.
3. **Terminal:** run the comparison, adding eight recordings per language from the FLEURS public dataset:
   ```sh
   node scripts/voice-stt-bench/index.mjs --fleurs 8
   ```
4. Read the tables it prints: first where a hands-free turn ended with each detector, then speed and word error rate per engine and language.

To test your own recordings, put `NAME.wav` (16 kHz, mono) next to `NAME.txt` (what was said) and `NAME.lang` (`en`, `fr` or `ar`) in a folder and add `--clips <folder>`.

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

**Siri voices.** `say -v` cannot use the Siri voices, but `say` without a voice follows the Spoken Content System Voice. So an agent set to `siri:<name>` (listed as `siri:aaron`, `siri:marie`… by `agentx voice list`) speaks each line by switching the System Voice to that Siri voice, speaking, and switching your own choice straight back. Every line that uses the OS default voice, from the daemon and from AgentX Voice, goes through one script (`~/.agentx/voice/siri-say.sh`, written by the daemon) that holds a lock, so two agents never switch it at once; lines wait their turn. If a speaker is killed mid-line, the next line restores your choice first, and so does the daemon when it starts. On a Mac every system-voice line goes through that script, Siri or not: it reads the text before taking the lock (a caller that never closes stdin gives up after 5 s without blocking anyone), stops a line that runs past its length's worth of speech (5 s plus 0.6 s a word, at most 5 minutes), and drops a line that waited more than 30 s rather than play it late. Siri voices are never assigned automatically, only when named. A per-language list works as usual (`"system": { "en": "siri:aaron", "fr": "siri:marie" }`). If the Siri voice is not downloaded, the system voice of the same name and language speaks instead (`siri:daniel` → Daniel), else the fallback described in [When a voice goes missing](#when-a-voice-goes-missing). The script never switches the System Voice to a Siri voice whose download is gone, because macOS would then speak with a fallback of its own. Download Siri voices in Spoken Content → System Voice → Manage Voices.

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
| `voice.pointer` | `false` never draws an agent's [pointer and name tag](#presence-on-screen); lessons are then spoken only (default `true`) |
| agent `voice.provider` | Overrides the global provider for this agent |
| agent `voice.system` | This agent's system voice: a name (`Daniel`, `Ava (Premium)`), an identifier from `agentx voice list`, `system` for the OS default voice, or one per language: `{ "en": "Samantha", "fr": "Thomas", "ar": "system" }` |
| agent `voice.fallbacks` | Voices to try in order when `voice.system` names one that is not installed, e.g. `["Ava (Premium)", "Allison"]`. Unset, or none installed: the best voice in the missing voice's language and gender (see [When a voice goes missing](#when-a-voice-goes-missing)) |
| agent `voice.gender` | `female`, `male` or `neutral`. An assigned voice, and the global `voice.system`, are used only if they match |
| agent `voice.rate` | Speaking speed from `0.75` to `1.5` (default `1`). System voices speak 175 words a minute times this; ElevenLabs is held to 0.7–1.2 |
| agent `voice.priority` | `high`, `normal` (default) or `low`: where this agent's lines go in the speaking queue |
| agent `voice.hotkey` | A shortcut that asks this agent from AgentX Voice, e.g. `"ctrl+opt+1"` (see [Settings window](#settings-window)) |
| `voice.stt` | Speech to text for AgentX Voice and for [voice chat on your phone](./mobile-chat.md#what-the-computer-needs-for-voice): `auto` (default), `elevenlabs` or `local` |
| `voice.localStt` | The engine on this Mac: `mlx-whisper` (default) or `parakeet` (see [Speech to text on this Mac](#speech-to-text-on-this-mac)) |
| `voice.endOfTurn` | How a hands-free turn ends: `vad` (default, voice detection) or `volume` (see [When a hands-free turn ends](#when-a-hands-free-turn-ends)) |
| `voice.hotkeys` | AgentX Voice shortcuts: `talk` (default `opt+space`), `stop` (`cmd+opt+period`), `paste` (`cmd+opt+v`) |

The system voice is chosen in this order: the agent's own, the global `voice.system` if it matches the agent's gender, then one assigned to it. A name that is not installed is replaced as described in [When a voice goes missing](#when-a-voice-goes-missing). With `provider: "system"`, no request goes to ElevenLabs, even when a key is set. `meshVoices` entries accept the same `provider`, `system`, `gender` and `fallbacks` fields. A `meshVoices` key is an agent id, which applies on every computer that has that agent, or `<computer>/<id>` (the name `agentx mesh list` shows, for example `office-mac/main`), which applies to that computer's agent only and wins over the plain id. When two computers each have an agent with the same id, each gets a voice of its own.

**Per-language voices.** With a list, each line is spoken by the voice of its language (English, French or Arabic, told apart by script and common words); a line in another language, or one too short to tell, uses the voice for `voice.locale`. An agent's list overrides the global one language by language. A plain name speaks every language. An agent without a voice for `voice.locale` in its list gets one assigned. `agentx voice list` shows each agent's voice with its per-language picks.

### When a voice goes missing

macOS can remove downloaded voices on its own, for example Siri, Premium and Enhanced voices when the disk is nearly full. An agent whose configured voice is gone keeps speaking, with a stand-in chosen in this order:

1. The first installed voice in the agent's `voice.fallbacks`.
2. The global `voice.system`, if it matches the agent's gender.
3. The best installed voice in the missing voice's language (`siri:<name>` uses `voice.locale`), of the agent's `gender`, or else the missing voice's gender, then Premium before Enhanced before standard. Eloquence voices (Flo, Eddy and the rest) and the classic voices are used only when no current macOS voice speaks that language. Among voices of the same quality, one no other agent uses comes first.

On a Mac, the daemon checks every configured voice when it starts, every minute after that, and whenever an agent is about to speak with a missing voice. It tells you once about each missing voice. Voices found missing in the same check share one notification, which lists each voice, the agents that use it, the voice they use for now, and where to reinstall it (System Settings › Accessibility › Spoken Content › System voice › Manage Voices). It notifies you again only after the voice has come back and gone missing again, and a restart does not repeat the notification. The notification uses your usual [notification channel](../jobs/notifications.md), is held during Focus, and shows a banner on the Mac.

To see which voices are missing:

- **Terminal:** `agentx voice list` shows a **Not installed** section, and every agent that uses a stand-in is marked.
- **Dashboard:** the Settings page counts missing voices under **Needs attention** and lists them in a notice.

When you install the voice again, agents switch back to it within about a minute. You don't need to restart.

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

## One speaker at a time: the floor

The speaking queue orders what AgentX says. It cannot see a demo script that plays its own sound, or a screen recording. For those there is the **floor**: whoever holds it is the only one that may speak and show a bubble on this computer. One holder at a time.

While someone holds the floor:

- **Spoken answers wait.** An agent's answer is kept and is shown and said when the floor is free. Task narration is dropped, since it would be old by then.
- **The character obeys only the holder.** `agentx point` and `agentx express` from anyone else are refused and say who holds the floor.
- **No talk, lesson or approval pop-up starts.** A talk or lesson is refused; a pop-up waits.
- **The microphone does not open by itself.** When the holder plays sound (`--sound`), the widget does not open its hands-free window after an answer, and throws away what an open one heard. Holding **Option–Space** still works: that is you.
- **For a recording, nothing shows.** With `--hide`, the character, the pill and every bubble stay off the screen until the floor is free.

The floor never stays taken. It frees itself at its time limit (two minutes unless the holder asks for another time or renews), and at once when the holder's program has ended.

**You can always take it back.** There are two ways, and they differ in what happens to the answers that waited:

- **Take the floor back** in the AgentX menu frees the floor and nothing else: the answers that waited are said now. The menu also shows who holds it.
- **Command–Option–.** (Stop speaking) frees the floor and asks for silence: everything that waited is dropped, as it always is with that key. A kept answer is still shown in the pill.

Either way, what the holder itself had queued to say is dropped.

If the daemon restarts while a command started with `agentx voice floor run` holds the floor, the command takes it again by itself once the daemon is back. AgentX Voice keeps a recording hidden meanwhile.

### Hold the floor while a script runs

1. **Terminal:** run your script through `agentx voice floor run`:

   ```sh
   agentx voice floor run --as "Product tour" --sound -- python3 tour.py
   ```

2. The floor is held under the name you gave for as long as the script runs, and freed when it ends, however it ends. If you press **Command–Option–.**, the script is stopped.

The script and everything it starts get the floor's id in `AGENTX_FLOOR`. `agentx point` and `agentx express` read it, so the script can still move the character. When the character is not on screen (the orb look, AgentX Voice closed, or a recording with `--hide`), `agentx point` from the script moves the highlight cursor instead, as it does when nobody holds the floor.

For a screen recording, add `--hide`:

```sh
agentx voice floor run --as "Screen recording" --hide --seconds 600 -- sleep 600
```

### Take and release it yourself

For a program that cannot be started through `agentx voice floor run`:

1. **Terminal:** run `agentx voice floor take --as "Product tour" --sound --seconds 300`. It prints an id. If someone else holds the floor, it says who and exits with code 2.
2. **Terminal:** when you are done, run `agentx voice floor release <id>`. What waited is said now.

To keep it longer, run `agentx voice floor renew <id> --seconds 300`. Add `--pid <number>` to `take` to free the floor as soon as that program ends, and `--agent <id>` to name the agent it speaks for.

To see who holds the floor, run `agentx voice floor`. To take it back from whoever holds it, run `agentx voice floor stop`. `--json` on `agentx voice floor` and on `take` prints the daemon's reply as it is.

### From any language

The same over HTTP, on the daemon's port:

| Request | What it does |
|---|---|
| `GET /voice/floor` | Who holds it: `held`, `holder`, `sound`, `hide`, `expiresAt`. With `?after=<seq>` the answer comes at the next change |
| `POST /voice/floor` with `{"holder": "Product tour", "seconds": 300, "sound": true}` | Takes it. `201` with an `id`; `409` with who holds it. Also `hide`, `pid`, `agentId` |
| `POST /voice/floor/<id>/renew` with `{"seconds": 300}` | Keeps it that long from now. `410` when it is no longer yours: stop |
| `POST /voice/floor/<id>/release` | Lets go |
| `DELETE /voice/floor` | Takes it back from whoever holds it |

A holder that wants AgentX to speak or point for it sends its id: `POST /voice/queue` with `"floor": "<id>"` plays the line at once, and `POST /voice/guide` with `"floor": "<id>"` moves the character.

To turn the floor off, or change its time limits, see `voice.floor` in the [config reference](../guides/agentx-voice.md#shared-voice-settings-voice-in-agentx-json).

## History of what you asked

The History window lists the questions you asked out loud and the answers you got, grouped by day, newest first. Each row shows the agent, the time, how long the answer took, what you said and the start of the answer. A question that failed shows why in red.

The daemon already keeps a record of every spoken question: each one is a task in the agent's task history, marked as coming from voice. The window reads those records, so nothing new is stored and nothing is kept on the Mac.

![The History window: Today and Yesterday, each row with the agent's colour and name, the time, how long it took, the question and the start of the answer. On the right, the selected answer in full with a link, an Open the survey button, and Replay, Copy and Open task in dashboard](/screenshots/voice/history-light.png)

To read an answer again:

1. **Mac:** click the AgentX icon in the menu bar, or press **Command–Option–A**.
2. **Mac:** choose **History…** (or press **Command–Y** while the menu is open).
3. **Mac:** select a question on the left. The answer shows in full on the right, as it was written, with its links and buttons.

To see one agent only:

1. **Mac:** in the History window, open the **Agent** menu at the top.
2. **Mac:** choose the agent. Only its questions and answers are listed. Choose **All agents** to see everyone again.

![The History window filtered to one agent: only its questions are listed](/screenshots/voice/history-filtered.png)

With an answer selected, you can:

- **Replay** (**Command–Return**): the agent says the answer again. It joins the end of the [speaking queue](#one-queue-for-everything-spoken), so it never talks over a line already playing or waiting.
- **Copy** (**Command–Shift–C**): copies the written answer.
- **Open task in dashboard**: opens the task on the dashboard, with every step the agent took.

The window shows 30 questions at a time. Choose **Load older** at the bottom of the list for more, and **Refresh** (**Command–R**) to see new ones.

![The History window in dark mode](/screenshots/voice/history-dark.png)

### Replay from the menu

The AgentX menu lists your last three questions under **Recent · click to replay**, with the agent that answered each one. Click one to hear its answer again, through the speaking queue like any other answer. A question with no answer is greyed out. Point at a row to see the start of its answer.

![The Recent section of the AgentX menu: three past questions, each with the agent that answered](/screenshots/voice/menu-bar.png)

### History for scripts

The same records are available to scripts from the daemon. Requests from the same Mac need nothing more; requests from another computer need the mesh token, the same as agent memory. The list never contains a whole answer, only its first 240 characters and its length; ask for one exchange to read all of it.

| Address | What it does |
|---|---|
| `GET /voice/history` | Past spoken questions, newest first: `{"exchanges": [...], "next"}`. Add `?agent=<id>` for one agent, `&limit=<n>` for how many (20 by default, at most 50), and `&before=<next>` for the page after this one. `next` is empty on the last page |
| `GET /voice/history/<id>` | One exchange in full: the question, the written `answer`, its `ui` links and buttons, `durationMs`, and `taskPath`, the task's address on the dashboard |
| `POST /voice/history/<id>/replay` | Say that answer again in its agent's voice, at the end of the speaking queue. Replies `202` with the queued line |

Each row of the list has an `id`, the `agentId`, `at` (when you asked, in milliseconds since 1970), `durationMs`, `status` (`ok`, `error`, `in-flight`, `canceled` or `timeout`), your `question` (up to 200 characters), `answerPreview`, `answerChars` and `error`.

### Open requests for scripts

The [open-requests list](#open-requests) is kept by the daemon, so any app on this computer can read it and mark answers heard. The same rules apply as for History: requests from the same Mac need nothing more; from another computer they need the mesh token.

| Address | What it does |
|---|---|
| `GET /voice/requests` | The open rows, oldest first: `{"requests": [...]}` |
| `POST /voice/requests` | Add a row: `{"agentId": "<id>", "question": "<words>"}`. Add `"waiting": true` for one that waits behind another request to the same agent. Replies `201` with the row. Then ask with `POST /ask` and `"request": "<row id>"` in the body: the row turns to thinking, then to answered or failed. For one of this computer's agents, the turn runs in the phone app's conversation with that agent (see [The same requests on the phone](#the-same-requests-on-the-phone)) |
| `GET /voice/requests/<id>` | One row, with `reply`: its answer as `/ask` returned it |
| `POST /voice/requests/<id>/heard` | Mark it heard, for every app |
| `POST /voice/requests/<id>/close` | Close it. Add `{"stop": true}` to also stop an agent that is still thinking on it |
| `POST /voice/requests/<id>/reopen` | Undo a close |
| `POST /voice/requests/<id>/continue` | A follow-up for the row: `{"question": "…", "waiting": false}`. The same row asks again with these words, not heard; its last answer goes. A closed row comes back |
| `POST /voice/requests/close-heard` | Close every heard answer and every failure: `{"closed": <how many>}` |

Each row has an `id`, the `agentId`, your `question`, its `state` (`waiting`, `thinking`, `answered` or `failed`), `sentAt` and `since` (in milliseconds since 1970), `heard`, `error` (why it failed), and `conversationId`: the phone app's conversation it ran in, or `null`. `heard` is also `true` once that conversation was opened on the phone after the answer came. At most 50 rows are listed; closed rows are forgotten after seven days.

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
2. In the agent's `voice` block, add `"narrate": "on"`. Use `"all"` instead to narrate schedules too (work that starts at set times).
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
2. **Browser:** to narrate one task only, even a scheduled one, open the task on the Hub's **Task** page. Its id is in the address, after `task=` and before the next `&`.
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

The pointer appears only during a lesson (see [Live lessons](#live-lessons)) and goes when the lesson ends. A spoken answer shows no pointer: the answer is in the pill, or in the character's bubble.

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
| `color` | The pointer's colour, also used for the [orb](#the-pill-and-its-orb). Default: a colour picked from the agent's id |
| `initial` | The letter on the pointer. Default: the first letter of the label |
| `label` | The name shown. Default: the agent's `name`, else its id |
| `allowActions` | `true` lets the agent click and type for you in `act` mode. Default `false` |

Without `allowActions`, the agent never clicks or types. It shows you where to click and lets you do it.

To turn the pointer off completely:

1. **Terminal:** open `agentx.json` in a text editor.
2. In the `voice` block, set `pointer` to `false`:
   ```json
   "voice": { "pointer": false }
   ```
3. Save the file.

No pointer or name tag is drawn after that, for any agent. A lesson still runs and says each step, but nothing shows you where to click.

### Presence mode

Presence mode lets AgentX decide, on each question you ask through the widget, whether the agent should also show something on screen. A small, fast decision model called a seat makes this choice; see [Jev and typed decisions](../architecture/jev.md) for how seats work and how to set up their backend. This seat is named `presence-mode` and is off by default. While it is off, answers are spoken only.

| Mode | What happens |
|---|---|
| `talk` | The agent answers out loud. Nothing else appears on screen |
| `teach` | A live lesson: the agent points at each step and says it; you do it |
| `watch` | You work; the agent coaches you and points at what you need |
| `act` | The agent does the steps itself. Only when `allowActions` is `true`; otherwise the answer is `talk` |
| `quiet` | Nothing appears on screen |

Some safety rules always apply:

- A lesson (`teach` or `watch`) starts only when you ask to be shown something:
  - Asking outright is enough: "show me how to…", "show me where…", "teach me…", "walk me through…", "coach me…", "show me on screen…", "watch me do it" or "montre-moi comment…". A bare "show me how" is not: "show me how things look today" is answered by voice.
  - A "how do I…" or "where is the…" question also needs to name something on screen, such as a button, menu, tab, field or icon, or "on the screen" or "in this app". "Where is the export button?" starts a lesson; "how do I make a table?" is answered by voice.
  - A question about work or status is always answered as `talk`, even if it starts with "show me" or "walk me through", or names a control: "where are we on the video test", "walk me through the status", "show me where we are on the release", "montre-moi où on en est" or "where's the tab redesign PR". So is an instruction such as "merge and deploy the release". Only "show me on screen…" and "watch me do…" skip this check. Because of it, "where is the merge button" is also answered by voice; ask "show me on screen where to merge" instead.
- If the seat is unsure (below 55% confidence), takes longer than 2.5 seconds, or fails, the answer is `talk`.

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

As soon as a lesson starts, the agent's pointer says **Looking at** and the app's name, until the first step is ready. On a Mac that is not busy, that takes a few seconds. When the lesson starts from your voice, the agent first says "Sure, I'll show you on screen. Say stop when you're done." (in `watch` mode: "Go ahead, I'm watching.").

The pointer's bubble has three lines, so you always know why it is there and how to leave:

```
Here: “Table”
You asked: show me how to make a table of monthly expenses
Say “stop” or press × to end
```

The first line names the control of the current step ("this control" when it has no name), the second what you asked for. Between steps the pointer keeps the last two lines.

A lesson stays in the app it started in. If you switch to another app, the agent asks you to bring it back and waits without doing anything else. After 45 seconds it ends. A lesson stops after 12 steps unless you set another limit.

A lesson also ends by itself when you have not done two steps in a row: the screen did not change and you said nothing. The agent says "I'll leave it there. Ask me to show you again whenever you like." and its pointer goes.

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

### Speak to a lesson or end it

1. **Mac:** hold **Option–Space**, or click the widget. The lesson goes quiet and waits for you.
2. **Mac:** say your question or remark, then release the keys. The lesson answers it with its next step.

To end the lesson, say **stop** the same way. A short "okay, stop now", "please stop" or "cancel" ends it too. A longer sentence that only contains the word, such as "how do I stop the recording", goes to the lesson as a question. A lesson that hears nothing for one minute after it went quiet also ends.

Pressing **Command–Option–.** also ends a lesson. So does clicking the **×** on the agent's name tag, beside its pointer: the tag fades out and the lesson stops. In the terminal where it runs, type `stop` and press Return, or press Control–C.

### Check a running lesson in the browser

1. **Browser:** open the dashboard's [Live](./live.md) tab.
2. Find the agent's card. A running lesson shows **on screen**, the mode, the step number and what the agent is saying.
3. To end it, select **✕ stop** on that line.

![The Live tab with the cx agent's card showing a running lesson: "on screen · teach · step 0", the lesson's goal, and its ✕ stop button](/screenshots/voice/live-tab-lesson.png)

### Check a hands-free lesson

A hands-free lesson is one you start by voice, with [presence mode](#presence-mode) on, and speak to without holding a key. This check shows that speaking to it pauses it instead of ending it, that a spoken stop ends it, and how long its first step took. It needs the daemon at version 0.94.0 or later and a build of the app made from the same version: update the daemon first, then run `agentx desktop install` again.

1. **Terminal:** run `agentx --version`. It prints `0.94.0` or later.
2. **Mac:** open the app you want to be taught in, for example Numbers, and leave it in front.
3. **Mac:** click the pill, and say "show me how to make a table of monthly expenses".
4. **Mac:** the agent says "Sure, I'll show you on screen. Say stop when you're done." Within a second or two its pointer appears and says **Looking at Numbers…**. It stays until the first step is spoken, a few seconds later.
5. **Mac:** after the first step, click the pill and say "it's not having any effect". The lesson goes quiet while you speak. Its next step answers what you said; the lesson does not end.
6. **Mac:** click the pill and say "okay, stop now". The pointer goes and the lesson ends.
7. **Terminal:** run the check:
   ```sh
   agentx voice lessons
   ```
   It reads the daemon's log and prints the last lesson: when it started, each step with how long its screen read and its plan took, what it heard, and one line per point of the check. Every line but **by eye** reads **ok**.

<!-- Screenshot needed: the agent's pointer saying "Looking at Numbers…" beside the Numbers window, before the first step (native macOS app). Not captured: the pointer only appears during a real lesson on a Mac with the helper installed and a person speaking to a demo-only install. -->

```
  Last lesson in ~/.agentx/logs/daemon-stderr.log

  2026-10-05T09:00:00Z  helper (teach): "show me how to make a table of monthly expenses"
    started by a voice turn: the presence seat chose teach (p=0.90)
    2 steps, 2 hushes, ended after 33.0 s (stopped by the listener)
      1. highlight "Table": Click Table in the toolbar. (screen 120 ms, plan 6200 ms)
      2. wait_for_user: It's the grid-shaped button, top left. (screen 90 ms, plan 2900 ms)
      heard "it's not having any effect" → the lesson's next step
      heard "Okay, stop now." → the lesson ended
    by eye   "Looking at …" shows from the start until the first step: the first step came after 7.4 s
    ok       Words said mid-lesson pause it and reach the next step: "it's not having any effect": the lesson went on, and a step followed each
    ok       A spoken stop ends it: "Okay, stop now." ended it (stopped by the listener)
    ok       [teach] lines carry a time and the screen-read and plan durations: step 1: screen 0.1 s, plan 6.2 s
    ok       First step under 10.0 s on an idle Mac: 7.4 s from the start to step 1
```

Each check line starts with one of four words. **ok**: the log shows it. **not ok**: the log shows the opposite. **not seen**: the lesson did not reach that point, for example nothing was said to it. **by eye**: only the screen can tell, so it is for you to confirm in step 4.

| Option | What it does |
|---|---|
| `--log <path>` | The daemon log to read, or `-` to read what is piped in. Default: `~/.agentx/logs/daemon-stderr.log` (the daemon started at login), else `/tmp/agentx-daemon.log` (`agentx daemon start`) |
| `-n, --last <n>` | How many lessons to show, oldest first (default 3) |
| `--json` | Print the lessons and their checks as JSON, for a script |

The command reads the log and changes nothing. A lesson started from the terminal is listed too, as **started by the terminal or the API**.

## For automations (Siri, Shortcuts, scripts)

The daemon offers these addresses for talks, lessons and narration. Requests from the same Mac need nothing more. Requests from another computer need the mesh token, the same as `/ask`.

| Address | What it does |
|---|---|
| `POST /talk` | Start a talk: `{"agents": ["<id>", "<id>"], "topic": "…", "context": "…", "maxTurns": 10}` |
| `GET /talk` | The running talk or lesson: what was said, its state and the pauses |
| `POST /talk/stop` | End the talk |
| `POST /teach/live` | Start a lesson: `{"agent": "<id>", "goal": "…", "mode": "teach", "app": "Numbers"}` (`draw` is terminal only) |
| `GET /voice/settings` | What the settings window shows: `general` (with the answer's `card` settings), each agent's voice, colour and palette, the orb `palettes`, and the installed system voices |
| `POST /voice/settings` | Save settings: `{"general": {…}, "agents": {"<id>": {…}}}`. `null` or `""` puts a field back to its default. `400` with `errors` when a value is refused; nothing is written then |
| `POST /voice/preview` | `{"agentId": "<id>", "voice": {…}}`: say a sample line with unsaved voice changes, next in the queue |
| `POST /voice/address` | `{"text": "…", "target": "<id>"}`: which agent the words are addressed to. Returns `{"agentId"}`, which is `target` when no leading name matches |
| `POST /voice/hush` | Silence whatever is speaking, pause the speaking queue and wait for your words (what **Option–Space** sends when pressed) |
| `POST /voice/door` | `{"text": "…"}`: your words for the talk or lesson; the queue plays on. `stop` ends the talk or lesson and empties the queue |
| `POST /voice/stop` | Silence every voice and empty the speaking queue (what **Command–Option–.** sends) |
| `GET /voice/guide?after=<seq>` | What the character is sent to show: `{"seq", "agentId", "rect", "mark", "text", "expression"}`. It answers as soon as there is a newer command than `<seq>`, else after 25 seconds. AgentX Voice waits here while the character is on screen |
| `POST /voice/guide` | Send the character to a place: `{"rect": {"x", "y", "width", "height"}, "mark": "box", "hold": 8, "text": "Search starts here"}`, measured in points from the top-left of the main screen. `mark` is `box`, `circle`, `underline` or `none`. `text` is optional: what the bubble says at the stop, cut at 120 characters; without it there is no bubble. `expression` is optional: one of the nine [states](#ask-for-a-state-by-name), shown while it stands there. `{"expression": "listening", "hold": 5}` with no `rect` shows the state where it rests. `{"home": true}` sends it back. Answers `409` when no character is on screen, or during a [play on the page](#play-on-the-page) |
| `GET /voice/queue` | The speaking queue: `{"paused", "playing", "waiting", "recent"}` |
| `POST /voice/queue` | Add a line in an agent's voice: `{"text": "…", "agentId": "<id>", "kind": "answer"}`. `kind` is `answer`, `narration` or `line`. Add `"wait": true` to get the reply only once the line has been spoken (`{"item", "played"}`) |
| `POST /voice/queue/<id>/skip` | Drop that line, whether it is playing or waiting. The others keep their order |
| `POST /voice/queue/<id>/front` | Play that waiting line next |
| `POST /voice/queue/<id>/replay` | Say a waiting or recently finished line again, next |
| `POST /voice/queue/pause`, `POST /voice/queue/resume` | Hold the queue, or let it play on. A held queue plays on by itself after a minute |
| `GET /voice/history`, `GET /voice/history/<id>`, `POST /voice/history/<id>/replay` | Past spoken questions and answers, and saying one again (see [History for scripts](#history-for-scripts)) |
| `GET /narration`, `POST /narration` | Read or set narration switches: `{"agentId": "<id>", "on": true}` or `{"taskId": "<id>", "on": null}` |

`/talk/hush` and `/talk/door` still work as older names for `/voice/hush` and `/voice/door`.

Every change to the speaking queue is also sent on the live event stream (`GET /events`) as a `voice` event whose message has `"kind": "voice:queue"` and the same fields as `GET /voice/queue`.

## Check it worked

1. **Terminal:** run `agentx desktop status`. It prints the login service's details. `Installed, but not running` or `Not installed` means it isn't running.
2. **Mac:** click the AgentX icon in the menu bar. Your agents are listed and one is ticked.
3. Hold **Option–Space**, ask "What can you do?", then release. The pill says **Sent. Ask the next one**.
4. When the answer is ready, you hear a soft sound and the pill shows **1 new**. Point at the pill, then click the row with the blue dot: the answer is spoken aloud and its text shows in the pill.
5. **Browser:** the question shows on the dashboard's [Live](./live.md) tab under your agent.
6. **Terminal:** to check talk mode, run `agentx talk <first-agent-id> <second-agent-id> "say hello"`. Both agents speak, and the terminal prints their lines.
7. **Terminal:** to check address by name, run `curl -s -X POST http://127.0.0.1:18800/voice/address -H 'Content-Type: application/json' -d '{"text": "<agent-name>, hello", "target": "<ticked-agent-id>"}'`. It prints the named agent's `agentId`, `name`, `color` and `node`. With a mesh, try the name of an agent on another computer: `node` is that computer's name and `remote` is `true`.
8. **Mac:** ask the ticked agent something that takes a while.
9. **Mac:** while it thinks, hold **Option–Space** and say another agent's name followed by a question, for example "Researcher, what time is it?".
10. **Mac:** open the AgentX menu. Both agents show **thinking**, and the ticked agent is still ticked. The pill shows a small orb for each of the two agents. When both have answered, the pill shows **2 new** and nothing is spoken.
11. **Mac:** press **Command–Option–O**. The open-requests list opens with both answers marked with a blue dot. The keyboard is on the first one. Press **Return**: that answer is spoken, and its row says **Heard** when you open the list again. The pill says that agent's name and **Hold ⌥Space to continue it**.
12. **Terminal:** run `curl -s http://127.0.0.1:18800/voice/requests`. Both rows are listed, and the one you heard has `"heard": true`.
13. **Mac:** quit AgentX Voice from its menu and start it again, then press **Command–Option–O**. Both rows are still there, one heard and one not.
14. **Mac:** move to the heard row and press **Command–Delete**. It leaves the list, and **Closed …'s request** with **Undo** shows for five seconds.
15. **Mac:** hold **Option–Space**. The pill appears with its orb in the ticked agent's palette, and the orb swells as you speak. Let go: the pill says **Sent. Ask the next one**, and a small orb in the pill turns while the agent thinks. Pick the answer in the list: the big orb pulses while it is spoken.
    - **Mac:** open the list, pick that row, hold **Option–Space** and say a follow-up. The pill says **Added to the same request**, and the list still has one row for it, thinking again.
    - **Mac:** ask until the list holds six requests. It shows one row per agent. Pick one: only that agent's requests show, with **History** at the top. Press **Escape** to go back.
16. **Mac:** drag the pill to another place on the screen. Quit the app from its menu and start it again: the pill comes back in the same place.
17. **Mac:** while an answer is spoken, move the pointer over the pill and click **×**. The pill goes and the voice stops. Hold **Option–Space**: the pill is back.
18. **Mac:** open **Settings…**, pick an agent, change its **Mac voice**, and choose **Preview**. The sample plays in the new voice. Choose **Save**, then ask that agent something: the answer uses the new voice.
19. **Terminal:** run `curl -s http://127.0.0.1:18800/voice/settings`. It prints the saved settings, including the change you just made.
20. **Terminal:** to check the speaking queue, run `curl -s -X POST http://127.0.0.1:18800/voice/queue -H 'Content-Type: application/json' -d '{"text": "First line.", "agentId": "<agent-id>"}'` twice in quick succession, then `curl -s http://127.0.0.1:18800/voice/queue`. You hear both lines one after the other, and the second shows under `waiting` until the first has finished.
21. **Mac:** open the AgentX menu and choose **History…**. The question you asked in step 3 is listed under **Today**, with the agent's name and how long it took.
22. **Mac:** choose one agent from the **Agent** menu at the top of the window. Only that agent's questions are listed.
23. **Mac:** select a question and choose **Replay**. The answer is spoken again, after anything already speaking.
24. **Terminal:** run `curl -s 'http://127.0.0.1:18800/voice/history?limit=3'`. It prints your last three questions, each with an `answerPreview` and not the whole answer.
25. **Terminal:** to check the on-device models, run `~/Applications/"AgentX Desktop.app"/Contents/MacOS/agentx-voice-local status`. `vad: installed` appears once the microphone has been used; `parakeet: installed` once Parakeet has been chosen and downloaded.
26. **Mac:** click the pill so the microphone opens without a key, say a sentence with a short pause in the middle, then stop. The question is sent about a second after your last word, not during the pause.
27. **Mac:** ask "Give me three links about macOS design.", then pick its answer in the open-requests list. The pill grows into the answer, with no second window. Once it has been spoken and you move the pointer away, it shrinks back after the time set in **Keep the answer open**.
28. **Mac:** while that answer is open, move the pointer over it and click **Listen again**. It is spoken again from the start, and the button shows a stop square. Click it again: the voice stops.
29. **Terminal:** run `agentx voice palette <agent-id> forest`, then open the AgentX menu and hold **Option–Space**. The orb is moss to fern green. Run `agentx voice palette <agent-id> default` to undo it.
30. **Mac:** right-click the pill and choose **Reduce to orb**. The pill is a small circle in the middle of the bottom edge. Ask "Give me three links about macOS design." again and pick its answer: the full pill opens with the answer, and once the answer has closed the circle is back where it was. Choose **Show full pill** to keep the pill.
31. **Mac:** with **Shown as** set to **Character**, open the AgentX menu and choose **Reduce to character**. Hold **Option–Space** and ask something short: the character listens, works and speaks with no bubble above it. Choose **Show speech bubble** to get the bubble back.
32. **Terminal:** after a lesson (see [Check a hands-free lesson](#check-a-hands-free-lesson)), run `agentx voice lessons`. It prints that lesson with its steps, what it heard, and an **ok** on every check line but **by eye**.

To check the phone side, with the [phone app](./mobile-chat.md) paired and a past conversation with one agent:

1. **Mac:** ask that agent something, and wait for the blue dot.
2. **Phone:** open Chat. The question is in your last conversation with that agent, its answer under it, and a chip says **New**.
3. **Phone:** tap the chip. Within five seconds, the Mac row says **Heard**.
4. **Mac:** ask the same agent "what did I just ask you?". It answers with the question from step 1: one session for both.
5. **Mac:** ask it something else and pick the answer in the list when it is ready. On the phone, the **New** chip goes at the next look.
6. **Terminal:** stop the daemon, then press **Command–Option–O** on the Mac. The list says **Can't reach AgentX on this Mac**. Start the daemon and choose **Try now**: the rows come back.
7. **Mac:** in **Settings › General**, pick another **Soft sound**. It plays once; the next answer that waits plays it.

## If something is wrong

- **No recording:** check the microphone permission in System Settings › Privacy & Security › Microphone, and hold the shortcut while speaking.
- **A permission is switched on in System Settings but the app still asks, after an update:** the switch belongs to an older build. **Terminal:** run `tccutil reset ScreenCapture tn.acme.agentx.voice` (or `Microphone` instead of `ScreenCapture`), switch the permission on again, then quit AgentX Voice from its menu and open it again. For the helper that `agentx desktop install` sets up, run `tccutil reset Accessibility tn.acme.agentx.helper` and `tccutil reset ScreenCapture tn.acme.agentx.helper`, then switch both on again. To stop this after every update, see [Keep permissions after an update](#keep-permissions-after-an-update).
- **"Sorry, I didn't hear that":** transcription failed and nothing was sent. Check your ElevenLabs key, or the local Whisper program and model.
- **A hands-free turn is sent in the middle of a sentence, or never ends:** **Terminal:** run `agentx-voice-local status` (see [Check it worked](#check-it-worked)). If `vad` is `not installed`, the app is still using the volume check: run `agentx-voice-local fetch vad`. The app log (`~/Library/Logs/agentx-voice.log`) says `Silero VAD would not load` when the model is there but broken; delete `~/.agentx/models/silero-vad-coreml` and fetch it again. To go back to the old behaviour, set **End of a hands-free turn** to **Volume**.
- **Parakeet is chosen but Whisper still answers:** the app log says why. `Parakeet is not downloaded yet` means the 483 MB download is still running or failed (`could not be downloaded: …`); run `agentx-voice-local fetch parakeet` in Terminal to see the error. `still loading` means the first load on this Mac is under way; ask again in a minute.
- **Parakeet answers an Arabic question in Latin letters, or with nonsense:** Parakeet has no Arabic. Set **On-this-Mac engine** back to **Whisper**, or use ElevenLabs.
- **A model download fails with `did not match its checksum`:** the file arrived damaged or changed upstream, and was deleted. Run the fetch again; if it keeps failing, the app needs an update.
- **Local Whisper fails:** **Terminal:** run `agentx doctor`. If it reports `ffmpeg not reachable by the desktop app`, install FFmpeg (for example `brew install ffmpeg`) and run `agentx desktop install` again.
- **Agent unavailable:** check the daemon address, then pick another agent from the menu. If the menu can't switch, the app is pinned to one agent: it was installed with `--agent`, or installed before the menu existed (older installs always pinned an agent). Run `agentx desktop install` again without `--agent`.
- **The menu says the daemon isn't reachable:** **Terminal:** run `agentx daemon status`, start the daemon, then choose **Retry**.
- **A daemon on another machine refuses it:** the widget can't send a mesh token yet. Use a daemon on the same Mac.
- **A question you started with a name went to the ticked agent:** the name matched no agent, or more than one. Check the ids and `mentions` with `agentx agent list`, or try it with the curl in [Check it worked](#check-it-worked). For an agent on another computer, run `agentx mesh list`: that computer must say `healthy`. If two computers have an agent with that name, say its id.
- **No small orbs while two agents work:** the row counts only questions asked from this Mac's assistant, and answers waiting in its speaking queue. A task an agent runs for someone else doesn't show.
- **A second question to the same agent waits a long time:** it waits until that agent has finished answering the request before it. The assistant gives up after 10 minutes, and the row says **Couldn't answer**. Pick it to see why.
- **An answer is never spoken:** answers wait until you pick them in the [open-requests list](#open-requests). Point at the pill or press **Command–Option–O**, then pick the row with the blue dot. To hear answers as soon as they are back, tick **Play answers at once** in the menu.
- **No soft sound when an answer is ready:** **Hold notifications** is ticked, or someone holds [the floor](#one-speaker-at-a-time-the-floor). The blue dot and **1 new** still show.
- **The open-requests list is empty after a restart:** the app reads the list from the daemon every few seconds. **Terminal:** run `curl -s http://127.0.0.1:18800/voice/requests`. An empty `requests` means every row was closed; your questions and answers are in **History…**. An error means the daemon is older than the list or not running: run `agentx daemon status`.
- **A row says "AgentX restarted before the answer came back":** the daemon stopped while the agent was thinking, so that answer is lost. Ask again.
- **Closing a thinking row didn't stop the agent:** stopping is never the default. Close it again and choose **Stop …** in the confirm.
- **Command–Option–O does nothing:** another app uses it. The app log says `shortcut ⌘⌥O for open requests is taken by another app`. Use **Open requests…** in the menu instead.
- **The settings window says the daemon isn't reachable:** **Terminal:** run `agentx daemon status` and start the daemon, then open **Settings…** again.
- **Save shows a red message:** the value was refused and `agentx.json` was not changed. If it names a shortcut used twice, change one of them and save again. A message that starts `agentx.json would not be valid` means another part of the file is wrong; the lines after it name the setting to fix.
- **A shortcut does nothing:** another app already uses it. The app log (`~/Library/Logs/agentx-desktop.err.log`) says `is taken by another app`. Pick another one in **Settings…**.
- **A preview is silent:** another line is playing first, or the voice is ElevenLabs without a key. Check `curl -s http://127.0.0.1:18800/voice/queue`.
- **Launch at login is greyed out:** `agentx desktop install` starts the app at login. **Terminal:** run `agentx desktop stop` to stop it.
- **`agentx voice lessons` says no daemon log was found:** the daemon writes its log where it was started from. Give the file with `--log <path>`, or pipe the log in: `agentx daemon logs -n 2000 | agentx voice lessons --log -`.
- **`agentx voice lessons` finds no lesson, or its lines have no time:** the daemon running is older than 0.94.0, or the lesson never started (the presence seat chose `talk`, which the daemon log shows on a `[presence]` line). Update the daemon, restart it, then run `agentx desktop install` again so the app matches.
- **A lesson ended as soon as you spoke to it:** the check prints **not ok** with *a hush ended it*. The daemon is older than 0.94.0; update and restart it. On a current daemon, a lesson that hears nothing for a minute after you clicked the pill ends on its own (*no words after the hush*).
- **The first step took more than 10 seconds:** the check names the slow part. A long **plan** means the planning model was slow, which happens on a Mac that is busy or has just started; try again once it is idle. A long **screen** read means the app's window had to be read from a screenshot, which takes a second or two more.
- **The pill doesn't appear:** it was hidden with **×**, **Esc** or **Hide pill**. Hold **Option–Space**, or choose **Show floating pill** in the menu, to bring it back. The orb needs macOS 14 or later; on macOS 14 it uses a simpler gradient than on macOS 15.
- **The pill is off screen or in an odd place:** click the AgentX icon in the menu bar and choose **Reset position**.
- **The character runs from the pointer and can't be dragged:** hold **Command** first. It then waits, and you can drag it. See [Move or hide the character](#move-or-hide-the-character).
- **The character is gone:** it was hidden with its bubble. Hold **Option–Space**, or choose **Show character** in the menu.
- **Esc does nothing:** the pill only hears **Esc** after you click it. Click the pill first, or use its **×** button.
- **The orb is the wrong colour:** pick a palette with `agentx voice palette <agent-id> <palette>` or in **Settings…**, or set `presence.color` for that agent as `#RRGGBB`. The app reads colours and palettes when you open its menu, so open it once after a change. An orb in plain shades of one colour means the daemon is older than the palettes: update it.
- **No answer text in the pill:** the answer had nothing the voice didn't already say. The pill only grows for a link, a picture, or more text than was spoken. If you closed the pill with **×** or **Esc**, the next answer doesn't open it either; hold **Option–Space** first.
- **The answer closes too soon or stays too long:** change **Keep the answer open** on the General tab, or run `agentx voice card --timeout <seconds>`.
- **`agentx voice palette` or `agentx voice card` says a value is refused:** the palette must be one of the seven names, the timeout 0 to 600 seconds and the height 120 to 800 points.
- **The character doesn't show:** it shows after the app has read its settings. If the app starts before the daemon, as it can when you log in, it shows the orb first and asks again until the daemon answers: at most 30 seconds after the daemon is up. A change to `voice.look` made in the Terminal or in `agentx.json` shows within a few seconds while the daemon runs. Run `agentx voice look` to see which one is on.
- **Play on this page is missing, greyed out, or the pill says Allow Screen Recording:** the row shows only while **Play mode** is ticked in the AgentX menu, and is greyed out unless the character is on screen, **Animated orb** is ticked, Reduce Motion is off and the assistant is idle. **Allow Screen Recording** in the pill, or a play on a picture without your windows, means the screen recording permission is missing: switch on **AgentX Voice** in System Settings › Privacy & Security › Screen & System Audio Recording, then quit AgentX Voice from its menu and open it again. See [Play on the page](#play-on-the-page).
- **The orb doesn't move:** Reduce Motion is on, **Animated orb** is unticked in the AgentX menu, or the microphone permission is missing, so there is no voice level to follow.
- **Voices talk over something else, or won't stop:** press **Command–Option–.**, or choose **Stop speaking** from the AgentX menu.
- **An answer is late to play:** another line is ahead of it in the speaking queue. **Terminal:** run `curl -s http://127.0.0.1:18800/voice/queue` to see what is ahead. If `paused` is `true` and you are not speaking, run `curl -s -X POST http://127.0.0.1:18800/voice/queue/resume`.
- **`Unknown agent: …` from `POST /voice/queue`:** the `agentId` must be an agent on this computer or on a connected mesh computer. Check the id with `agentx agent list`.
- **`A talk or lesson is already running`:** only one runs at a time. Wait for it to end, or press **Command–Option–.** to stop it.
- **`Unknown agent: …` from `agentx talk` or `agentx teach --live`:** check the id with `agentx agent list`. For `agentx talk`, an agent on another computer must be reachable: check that its computer shows in `agentx mesh list`.
- **A talk never starts speaking:** the lines come from the `claude` program. **Terminal:** run `claude --version` on the daemon's computer and sign in if needed, or set `AGENTX_TALK_BACKEND=api`.
- **No pointer appears in a lesson:** `voice.pointer` is `false` in `agentx.json`. Remove the line or set it to `true`. A plain spoken answer never shows a pointer.
- **A lesson says "Bring … to the front":** click the app the lesson started in; it carries on.
- **The agent never clicks in `act` mode:** set `"allowActions": true` in the agent's `presence` block.
- **History says the daemon isn't reachable:** **Terminal:** run `agentx daemon status` and start the daemon, then choose **Refresh**.
- **History is empty:** only questions asked out loud (with the widget, Siri or `/ask`) are listed, and only those this daemon answered. A question answered by an agent on another computer is in that computer's history.
- **Replay is greyed out, or says there is no answer:** the question failed or was stopped before an answer came back. Ask it again.
- **A replay plays late:** it waits for the lines ahead of it in the speaking queue. **Terminal:** run `curl -s http://127.0.0.1:18800/voice/queue` to see what is ahead.
- **Open task in dashboard shows nothing:** the dashboard isn't running on `AGENTX_DASHBOARD_URL`. **Terminal:** run `agentx board serve`, or set `AGENTX_DASHBOARD_URL` to where it runs.
- **`401` from `/voice/history` on another computer:** send the mesh token as `Authorization: Bearer <token>`.
- **Narration stays silent:** check `voice.narrate` for the agent, or run `agentx narrate <agent-id> on`. Scheduled jobs need `"all"`, and questions from the widget are never narrated this way.
