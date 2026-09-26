# Restart without losing work

You restart AgentX after an update or a settings change. Agents may be in the middle of a task at that moment: answering a message, reviewing a merge request, running a scheduled job.

When AgentX is asked to stop, it now:

1. Stops taking new work. Messages and scheduled jobs wait; anything that asks it to start a task gets "restarting, try again shortly".
2. Lets the tasks already running finish, for up to 5 minutes.
3. Writes one line to its log saying why it stopped and how many tasks were running.
4. Exits.

This page shows how to restart so that this works, including when AgentX runs as a background service.

## Restart from the terminal

1. **Terminal:** stop the daemon (the AgentX background service). The command waits until running tasks have finished:
   ```sh
   agentx daemon stop
   ```
   If tasks are running, it says so and waits. It prints `Daemon stopped` when it's done.
2. **Terminal:** start it again:
   ```sh
   agentx daemon start --detach
   ```

Don't start the daemon again before `stop` has finished: two daemons would compete for the same port.

## Give a background service enough time

If AgentX runs as a service that the system starts for you, the system decides how long to wait before forcing it closed. Its default is shorter than AgentX needs, so set it once.

**On Linux (systemd):**

1. **Terminal:** open an override file for the service (named `agentx` here; use your service's name):
   ```sh
   sudo systemctl edit agentx
   ```
2. Add these lines, then save:
   ```ini
   [Service]
   TimeoutStopSec=360
   KillMode=mixed
   ```
   `TimeoutStopSec` gives AgentX 6 minutes to finish. `KillMode=mixed` sends the stop request to AgentX only. Without it, systemd also stops the agents' own programs at the same moment, and the running tasks fail straight away.
3. **Terminal:** reload systemd's settings:
   ```sh
   sudo systemctl daemon-reload
   ```

**On a Mac (launchd):**

1. **Terminal:** open the service's settings file in `~/Library/LaunchAgents/` (for example `com.example.agentx.plist`).
2. Add this inside the main `<dict>`:
   ```xml
   <key>ExitTimeOut</key>
   <integer>360</integer>
   ```
   Without it, macOS forces AgentX closed after about 20 seconds.
3. **Terminal:** reload the service so the setting applies:
   ```sh
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.agentx.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.agentx.plist
   ```

## Change how long it waits

The daemon waits up to 5 minutes. To change that, set `AGENTX_DRAIN_TIMEOUT_MS` (in milliseconds) in the `.env` file next to `agentx.json`:

```sh
AGENTX_DRAIN_TIMEOUT_MS=600000   # 10 minutes
```

Keep the service's stop time at least a minute longer than this, or the system will force AgentX closed first.

<!-- No screenshot: every step is a terminal command or a settings file. -->

## Work that gets cut off anyway

Some work still gets cut off: a task that runs longer than the wait, a crash, or a machine that loses power. When AgentX starts again, it looks at every task that was cut off and decides what to do with each one:

| The task came from | What happens |
|---|---|
| A chat (Telegram, WhatsApp, GitLab, GitHub, Slack…) in the last 30 minutes | It's picked up again. The chat gets a short note first: "AgentX restarted while working on this. Picking it up again." The answer arrives in the same chat. |
| A scheduled job | Nothing. The next scheduled run does the work. |
| A workflow step | Reported. The workflow decides whether to retry. |
| Anything else (voice, one agent asking another, webhooks, the API) | Reported, because nothing would deliver the answer. |
| Anything older than 30 minutes | Reported. |

"Reported" means the task isn't run again. Its chat gets a note saying so, or, when there's no chat, you get one message listing them (at `notifications.destination`).

A task that is picked up again is told it was interrupted, along with the steps it had already taken, and asked to check before repeating anything that affects the outside world, such as posting a message, pushing code or deploying.

To stay safe, AgentX never picks the same task up twice:

- A task cut off again while being picked up is reported, not retried.
- After 3 restarts within 10 minutes, it stops picking tasks up and reports them instead. A task that keeps crashing AgentX can't keep doing so.

### Change what gets picked up

Set these in `agentx.json` under `resume`. Every value shown is the default:

```json
"resume": {
  "enabled": true,
  "maxAgeMinutes": 30,
  "maxAttempts": 1,
  "reportOnlyChannels": [],
  "directChannels": [],
  "crashLoop": { "restarts": 3, "windowMinutes": 10 }
}
```

- `reportOnlyChannels`: chats whose tasks are only reported, never picked up. For example `["gitlab"]`.
- `directChannels`: non-chat sources to pick up anyway, such as `["voice"]`. Their answer isn't delivered anywhere; only the work gets done. Add a source only when the work is what matters.
- `"enabled": false` turns picking up off; everything is reported.

## Check it worked

1. **Terminal:** while an agent is working on something, run `agentx daemon stop`.
2. **Terminal:** open the log with `agentx daemon logs`. You should see, in order:
   - `Shutdown: SIGTERM requested by agentx daemon stop (…); 1 task(s) in flight; …`
   - `Draining 1 in-flight task(s) …`
   - `Drain complete (…ms)`
3. The agent's answer arrives as usual, and `stop` prints `Daemon stopped`.

To check that cut-off work is picked up:

1. **Terminal:** while an agent is answering a chat message, force AgentX closed, for example with `kill -9` on the daemon's process.
2. **Terminal:** start the daemon again.
3. Within a few seconds the chat shows the "Picking it up again" note, then the answer.
4. **Terminal:** `agentx daemon logs` shows `Resume: 1 resumed, 0 reported, 0 skipped, 0 failed`.

A restart by systemd or launchd shows `from systemd` or `from launchd (…)` in the first line, instead of `requested by`.

## If something is wrong

- **Tasks still fail right away on a Linux service:** check `systemctl show -p KillMode agentx`. It must say `mixed`.
- **The log shows no `Shutdown:` line at all:** the system forced AgentX closed before it could start. Raise `TimeoutStopSec` or `ExitTimeOut` as above.
- **`Drain timeout after … task(s) still in flight`:** a task took longer than the limit and was stopped. Raise `AGENTX_DRAIN_TIMEOUT_MS`, and the service's stop time with it.
- **`stop` says the daemon is still finishing tasks:** wait, then check with `agentx daemon status` before starting it again.
- **Another tool got `503 daemon is restarting`:** it asked for new work during a restart. It can try again a little later.
- **A chat task wasn't picked up:** the log line starting `[resume]` says why. The usual reasons are that it was older than 30 minutes, it was already a second attempt, or there were several restarts in a row.
- **You got a "didn't resume" message you didn't expect:** that task came from somewhere with no chat to answer in. Send the request again, or add its source to `directChannels`.
