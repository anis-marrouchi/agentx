# Calls from your agents

An agent that needs you directly can **ring you**. The call shows up on the [desktop assistant](voice.md) pill, much like a phone call. You see who is calling and why, and you hear a ring. Answer, and the agent speaks first and tells you why it called. Then you talk hands-free until you hang up. The agent writes a short summary of the call afterwards.

Nobody can call you until you allow them. Calls that aren't urgent don't ring during Focus. Each agent can call only a few times an hour.

## Before you start

- The [desktop assistant](voice.md) is installed and running on your Mac.
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

## How an agent places a call

Agents call through the `agentx_call_owner` tool, which AgentX gives them. You can also place a call yourself to try it out:

```sh
agentx call request --agent writer --reason "Which launch date should I put in the post?"
```

Add `--urgent` for something that can't wait. Inside an agent's own run, `--agent` can be left out.

## Focus, missed calls and limits

- **Focus (Do Not Disturb), or the widget's hold switch:** a call that isn't urgent doesn't ring. It is recorded as a missed call, and you get a notice once Focus ends. Urgent calls ring anyway, the same way `agentx notify --urgent` does.
- **The desktop assistant isn't running:** you get a notification instead, with the caller and the reason. If you open the desktop assistant while the call is still ringing, the pill rings.
- **Missed calls:** run `agentx call list --status missed`.
- **Limits:** one call in progress per agent, and at most `calls.maxPerHour` calls per agent in an hour (3 by default).

## Settings

All settings are under `calls` in `agentx.json`:

| Setting | Default | What it does |
|---|---|---|
| `calls.allow` | `[]` | Agents that may call you: ids, or `"*"` for all. Empty means nobody. |
| `calls.maxPerHour` | `3` | Most calls one agent may place in an hour. |
| `calls.ringSeconds` | `45` | How long a call rings before it counts as missed. |
| `calls.ringSound` | `"Submarine"` | The ring: a sound name from `/System/Library/Sounds`, without `.aiff`. |
| `calls.summary` | `true` | After you hang up, ask the agent for a short summary. |

For example:

```json
"calls": { "allow": ["writer", "ops"], "ringSeconds": 60, "ringSound": "Glass" }
```

## Check it worked

1. **Terminal:** run `agentx call allow writer` (use your agent's id).
2. **Terminal:** run `agentx call request --agent writer --reason "Test call"`. It prints `ringing on AgentX Voice`.
3. **Mac:** the pill rings and shows **Writer is calling · Test call**.
4. **Mac:** click the green **Answer** button. The agent says why it called.
5. **Mac:** say "bye". The call ends.
6. **Terminal:** run `agentx call list`. The call shows as `ended`, and a moment later it has a summary.

## If something is wrong

- **`may not call the owner`**: the agent isn't allowed yet. Run `agentx call allow <agent>` in the folder that holds `agentx.json`.
- **`has placed 3 calls in the last hour`**: the agent hit `calls.maxPerHour`. Wait, or raise the limit.
- **`already has a call in progress`**: answer, decline or hang up that call first. `agentx call list` shows it, and `agentx call decline <id>` ends it.
- **The command says `sent a notification instead`**: the desktop assistant isn't running. Start it with `agentx desktop start`.
- **The command says `not rung`**: you are in Focus, or the widget's hold switch is on, and the call wasn't urgent. It is listed as a missed call.
- **No ring sound**: check that `calls.ringSound` names a sound in `/System/Library/Sounds`, and that the Mac isn't muted.
- **`calls require SQLite`**: AgentX could not open its database. Run `agentx doctor`.
