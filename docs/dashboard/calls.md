# Calls from your agents

An agent that needs you directly can **ring you**. The call shows up on the [AgentX Voice](voice.md) pill, much like a phone call. You see who is calling and why, and you hear a ring. Answer, and the agent speaks first and tells you why it called. Then you talk hands-free until you hang up. The agent writes a short summary of the call afterwards.

Nobody can call you until you allow them. Calls that aren't urgent don't ring during Focus. Each agent can call only a few times an hour.

The same permission lets an agent ask to **see** through your phone camera. That request shows on the phone, not on AgentX Voice. See [Share your phone camera](mobile-camera.md#when-an-agent-asks-to-see).

## Before you start

- [AgentX Voice](voice.md) is installed and running on your Mac.
- AgentX is running (`agentx daemon status` says it is up).
- You know the id of the agent you want to allow. `agentx agent list` shows it.

## Let an agent call you

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run this, replacing `writer` with your agent's id:
   ```sh
   agentx call allow writer
   ```
   Run it once for each agent. To let every agent call, use `agentx call allow "*"`. To take the permission back, use `agentx call disallow writer`.

AgentX picks the change up by itself. The allowlist lives in `agentx.json` under `calls.allow`.

## Answer a call

When an agent calls:

- The pill comes on screen with the agent's name, its colours and the reason, and the orb pulses.
- A ring sound repeats until you answer, or until the call counts as missed (45 seconds by default).
- The pill shows three buttons:
  - **Answer** (green phone). The agent says why it called, in its own voice. Then talk as usual: the microphone opens after each answer, and a click on the pill talks.
  - **Later** (clock). Pick **Call back in 5, 15 or 30 min**. The same call rings again then.
  - **Decline** (red phone). The call ends.

To hang up, do one of these:

- **Click** the red **Hang up** button on the pill.
- **Say** "hang up" or "bye".
- **Press** Esc after clicking the pill, or click its close button.

After you hang up, the agent writes a two-to-three-sentence summary. It appears in the dashboard's **Ask** drawer history, titled **Call: …** followed by the reason.

## When you are already in a call

A second agent can call while you talk to the first. It works like call waiting on a phone:

- **You** get a notification at once, with a sound: **Call waiting: Ops**, then the reason. The call you are in carries on. Nothing rings yet.
- **The calling agent** is told that you are busy in another call, and with which agent. It is also told that its call waits, so it doesn't call again.
- **When you hang up**, the waiting call rings on the pill, and its ring time starts then. If several agents wait, they ring one at a time, oldest first.
- **While you stay busy**, you get the notification again every 5 minutes (`calls.busy.retryMinutes`).
- **After 10 minutes** (`calls.busy.maxWaitMinutes`) a call stops waiting. Its ring time then runs once more. If you are still busy at the end of it, the call counts as missed, with the note `widget busy`.

The same happens while AgentX Voice runs a turn of yours or records: the agent is told you are busy on the voice widget.

A waiting call is still one call. It counts once against `calls.maxPerHour`, however long it waits. An urgent call waits too, since the pill can ring only one call at a time. Its notifications pass Focus, as urgent ones do.

The agent can withdraw its call while it waits or rings, for example to send you a message instead. It uses `agentx_call_owner` with `cancel: true`, or `agentx call cancel` inside its run. The call then shows as `ended`, with the note `withdrawn by the caller`.

You can change the words of the notification with `calls.busy.title` and `calls.busy.notice`. See [Settings](#settings).

The agent is told you are busy from what AgentX Voice last reported, which can be up to two seconds old. A call placed in the two seconds after you start a voice turn is answered "ringing" and waits all the same. If AgentX Voice quits while a call waits, the call counts as missed once its ring time runs out.

## How an agent places a call

Agents call through the `agentx_call_owner` tool, which AgentX gives them. Inside an agent's run, `agentx call request --reason "…"` does the same (add `--urgent` for something that can't wait).

A call counts only when it comes from a turn of that agent that is running now. AgentX checks this against the runs it started, so an agent can't simply type another agent's name to get through your allowlist. This stops an agent from naming another by mistake. It isn't a security boundary between agents on the same Mac: every local agent runs as your user and can also edit `calls.allow`. It also means you can't place a call from your own terminal. To try it out, ask an agent to call you, as below.

## Focus, missed calls and limits

- **Focus (Do Not Disturb), or the widget's hold switch:** a call that isn't urgent doesn't ring. It is recorded as a missed call, and you get a notice once Focus ends. Urgent calls ring anyway, the same way `agentx notify --urgent` does.
- **AgentX Voice isn't running:** you get a notification instead, with the caller and the reason. If you open AgentX Voice while the call is still ringing, the pill rings.
- **You are busy:** see [When you are already in a call](#when-you-are-already-in-a-call).
- **Missed calls:** run `agentx call list --status missed`.
- **Limits:** one call in progress per agent, and at most `calls.maxPerHour` calls per agent in an hour (3 by default).

## Settings

All settings are under `calls` in `agentx.json`:

| Setting | Default | What it does |
|---|---|---|
| `calls.allow` | `[]` | Agents that may call you: ids, or `"*"` for all. Empty means nobody. |
| `calls.maxPerHour` | `3` | Most calls one agent may place in an hour. |
| `calls.ringSeconds` | `45` | How long a call rings before it counts as missed. |
| `calls.maxCallMinutes` | `30` | An answered call that was never hung up ends after this many minutes, for example when AgentX Voice quit or the Mac slept. Until then the agent can't call again. |
| `calls.ringSound` | `"Submarine"` | The ring: a sound name from `/System/Library/Sounds`, without `.aiff`. |
| `calls.summary` | `true` | After you hang up, ask the agent for a short summary. |
| `calls.busy.retryMinutes` | `5` | While a call waits because you are busy, you are told again this often. |
| `calls.busy.maxWaitMinutes` | `10` | The longest a call waits for you. Still busy then, it counts as missed. |
| `calls.busy.title` | `"Call waiting: {agent}"` | Title of the call-waiting notification. `{agent}` becomes the caller's name. |
| `calls.busy.notice` | `"AgentX Voice is busy. The call rings when it is free."` | Its second line, under the caller's reason. |

For example:

```json
"calls": { "allow": ["writer", "ops"], "ringSeconds": 60, "ringSound": "Glass" }
```

## Check it worked

1. **Terminal:** run `agentx call allow writer` (use your agent's id).
2. **Terminal:** run `agentx daemon send writer "Call me with agentx_call_owner, reason: Test call"`. The agent replies that the call is ringing on AgentX Voice.
3. **Mac:** the pill rings and shows **Writer is calling · Test call**.
4. **Mac:** click the green **Answer** button. The agent says why it called.
5. **Mac:** say "bye". The call ends.
6. **Terminal:** run `agentx call list`. The call shows as `ended`, and a moment later it has a summary.

## If something is wrong

- **`may not call the owner`**: the agent isn't allowed yet. Run `agentx call allow <agent>` in the folder that holds `agentx.json`.
- **`No running turn of <agent> placed this call`**: the call didn't come from inside that agent's run, for example from a terminal. Ask the agent to call you instead. On version 0.81.0 or earlier, a run started with `agentx daemon send` or `POST /task` and no chat was refused the same way: update AgentX.
- **`has placed 3 calls in the last hour`**: the agent hit `calls.maxPerHour`. Wait, or raise the limit.
- **`already has a call in progress`**: answer, decline or hang up that call first. An answered call that was never hung up ends by itself after `calls.maxCallMinutes`. `agentx call list` shows it, and `agentx call decline <id>` ends it.
- **The command says `sent a notification instead`**: AgentX Voice isn't running. Start it with `agentx desktop start`.
- **The agent says you are busy, but you are not in a call**: AgentX Voice was in a turn of yours or recording. The call rings as soon as that ends.
- **`has no call waiting or ringing`**: the agent tried to withdraw a call that was already answered, missed or ended.
- **The command says `not rung`**: you are in Focus, or the widget's hold switch is on, and the call wasn't urgent. It is listed as a missed call.
- **A call is missed while the pill was busy and never rang**: AgentX Voice is from an older version. Run `agentx desktop install`.
- **No ring sound**: check that `calls.ringSound` names a sound in `/System/Library/Sounds`, and that the Mac isn't muted.
- **`calls require SQLite`**: AgentX could not open its database. Run `agentx doctor`.
