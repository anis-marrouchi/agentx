# Restart without losing work

You restart AgentX after an update or a settings change. Agents may be in the middle of a task at that moment: answering a message, reviewing a merge request, running a scheduled job.

When AgentX is asked to stop, it now:

1. Stops taking new work. Messages and scheduled jobs wait; anything that asks it to start a task gets "restarting, try again shortly".
2. Lets the tasks already running finish, for up to 5 minutes.
3. Writes one line to its log saying why it stopped and how many tasks were running.
4. Exits.

This page shows how to restart so that this works, including when AgentX runs as a background service.

The daemon is the AgentX program that keeps running in the background. It can be started three ways, and the restart command works with each:

- by **launchd**, the Mac's built-in service manager (a `.plist` settings file in `~/Library/LaunchAgents/`),
- by **systemd**, the Linux service manager (an `agentx.service` unit),
- or by hand, with `agentx daemon start --detach`.

## Restart when no task is running (recommended)

Use this after an update, and in deploy scripts, instead of `launchctl kickstart -k` or `systemctl restart`.

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run:
   ```sh
   agentx daemon restart --when-idle
   ```
3. Read what it prints. It names the service manager it found, then:
   - `Waiting: 2 task(s) running...` while agents are still busy. It checks every 5 seconds.
   - `No tasks running.` once it has seen zero running tasks twice in a row.
   - `Daemon is back (PID …) after 4s.` when the new daemon answers. The command only reports success at this point.

It waits up to 30 minutes. If tasks are still running after that, it restarts anyway and says so. Those tasks still get the usual time to finish, and anything cut off is picked up again after the restart ([see below](#work-that-gets-cut-off-anyway)).

Options:

| Option | What it does |
|---|---|
| `--timeout <minutes>` | Wait this long instead of 30 minutes. |
| `--abort-on-timeout` | When the wait runs out, don't restart. The command exits with an error and AgentX keeps running. Use this in deploy scripts that can try again later. |
| `--interval <seconds>` | How often to check. The default is 5. |
| `--reload-service` | Also re-read the service's settings file. Use it after you edit the `.plist` or the systemd unit. |
| `--dry-run` | Show what it would run, without restarting. |

Without `--when-idle`, the restart starts right away. Running tasks still get the usual time to finish.

### What it runs

| AgentX runs under | The command |
|---|---|
| launchd | Asks launchd to stop AgentX, waits for it to exit, then starts the job again. With `--reload-service`, it unloads the job, waits until launchd has let it go, then loads the `.plist` again. |
| systemd, system unit | `systemctl restart <unit>`. When you are not root, it uses `sudo`, which may ask for your password. Without a terminal it won't ask. If `sudo` needs a password, it stops and prints the exact command to run. |
| systemd, user unit | `systemctl --user restart <unit>`. No `sudo`. |
| Started by hand | Stops the daemon, waits until it has exited, then runs `agentx daemon start --detach` in the same folder. |

If a step fails before AgentX was stopped, it stays running and the command prints how to restart it by hand. `agentx daemon deploy <host> --restart` runs this same command on the other machine.

## Restart from the dashboard

The dashboard can ask a node to restart itself as soon as no task is running. This needs launchd or systemd, because a service manager has to start AgentX again after it exits. On a daemon started by hand, use the terminal command above.

1. **Browser:** open the dashboard's **Live** page.
2. **Browser:** find the node, then select **Restart when idle** at the right of its name.

   ![A node on the Live page, with the Restart when idle button at the right](/screenshots/live/restart-when-idle.png)
3. **Browser:** confirm.
4. The node shows `restart pending · 2 running · until 14:30` while it waits. To call it off, select **Cancel restart**.
5. When no task is running, it shows `restarting…`, drops offline for a few seconds, then comes back online.

The node waits up to 30 minutes, then restarts anyway. It refuses straight away, with a message saying why, when nothing would start it again:

- It was started by hand.
- On a Mac, the `.plist` has no `KeepAlive`, or sets it to `false`.
- On Linux, the unit has `Restart=no` (the default), `on-abnormal`, `on-abort` or `on-watchdog`. Set `Restart=always` to use the button.

With `Restart=on-failure`, or a Mac `KeepAlive` that only restarts after a failed exit, AgentX exits with code 75 so that the service manager starts it again.

Only you can use the button: the request must come from the same machine, or from another node with its mesh token. Pages from other websites are refused.

## Stop and start by hand

1. **Terminal:** stop the daemon. The command waits until running tasks have finished:
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
   agentx daemon restart --when-idle --reload-service
   ```
   This unloads the job, waits until macOS has let it go, then loads the settings file again. Running the two `launchctl` commands back to back can fail, because the second one runs before the first has finished, and AgentX then stays stopped.

## Change how long it waits

The daemon waits up to 5 minutes for running tasks. To change that for every agent:

1. **Terminal:** in the folder with `agentx.json`, set the wait in seconds:
   ```sh
   agentx config set shutdown.drainTimeoutSeconds 600
   ```
2. Raise the service's stop time to at least a minute longer (`TimeoutStopSec` or `ExitTimeOut`, [as above](#give-a-background-service-enough-time)), or the system will force AgentX closed first.

Some agents do work that takes much longer, such as rendering a video. You can give only those agents more time, and keep the short wait for the rest:

1. **Terminal:** set the agent's own wait, in seconds (here for an agent named `editor`):
   ```sh
   agentx config set agents.editor.drainTimeoutSeconds 1800
   ```
2. Raise the service's stop time above the longest of these waits.

A stop then waits as long as the longest wait among the agents that are still busy. An agent's own wait can make a stop longer, never shorter.

The older `AGENTX_DRAIN_TIMEOUT_MS` setting (in milliseconds, in the `.env` file next to `agentx.json`) still works. It is used only when `shutdown.drainTimeoutSeconds` is not set.

A task still running when the wait ends is stopped. It reports `killed by daemon restart (drain limit …s, requested by …)`, not a time limit of its own, and nothing is posted to its chat. When AgentX starts again, the task is picked up again or reported, as described below.

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

To check the restart command:

1. **Terminal:** while an agent is working on something, run `agentx daemon restart --when-idle`.
2. It prints `Waiting: 1 task(s) running...`, then `No tasks running.` once the agent has answered.
3. It ends with `Daemon is back (PID …) after …s.`
4. **Terminal:** `agentx daemon logs` shows `Shutdown: SIGTERM requested by agentx daemon restart (…); 0 task(s) in flight; …`

To check the dashboard button:

1. **Browser:** select **Restart when idle** on a node of the **Live** page, and confirm.
2. The node shows `restart pending`, then `restarting…`, then `online` again.
3. **Terminal:** on that node, `agentx daemon logs` shows `Restart when idle: no tasks running`, then `Shutdown: restart requested by restart-when-idle from the dashboard (…)`.

To check which version is running after an update:

1. **Terminal:** ask the daemon (use your `node.bind` address):
   ```sh
   curl -s http://127.0.0.1:18800/health
   ```
2. Read three values near the top of the answer:
   - `version`: the AgentX version the daemon is running, for example `"0.61.0"`.
   - `commit`: a short code that identifies the exact build, or `null` when AgentX was built outside a git folder or runs straight from source.
     If it ends in `-dirty`, the build had local changes, so it doesn't match that commit exactly.
   - `startedAt`: when this daemon started.
3. These describe the program that is running, not the files on disk. If `version` is still the old one, or `startedAt` is older than your update, the daemon hasn't restarted yet: restart it as above.

To check a plain stop:

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

- **`restart` says `The daemon is not answering`:** AgentX isn't running, or listens on another address. Check `node.bind` in `agentx.json`, then start it with `agentx daemon start --detach` or through its service.
- **`restart` stops and prints a `sudo systemctl restart …` command:** `sudo` needed a password and no terminal was attached. AgentX is still running. Run the printed command yourself, or allow that one command in `sudoers`.
- **`restart` says `The daemon did not come back within 2 min`:** the new daemon didn't start. Run the `Start it with:` command it printed, then read `agentx daemon logs`.
- **`restart --abort-on-timeout` exited with `Not restarting`:** tasks were still running when the wait ran out. Try again later, or raise `--timeout`.
- **The dashboard says `would not start AgentX again`:** set `KeepAlive` to `true` in the `.plist`, or `Restart=always` on the unit, as the message says. Or use `agentx daemon restart --when-idle` in a terminal.
- **The dashboard has no Restart when idle button:** the node runs an older AgentX. Update it first.
- **The restart button gives `401` for another node:** the dashboard needs that node's mesh token in `dashboard.daemons`.
- **Tasks still fail right away on a Linux service:** check `systemctl show -p KillMode agentx`. It must say `mixed`.
- **The log shows no `Shutdown:` line at all:** the system forced AgentX closed before it could start. Raise `TimeoutStopSec` or `ExitTimeOut` as above.
- **`Drain timeout after … task(s) still in flight`:** a task took longer than the wait and was stopped. The next line, `Interrupted … run(s): killed by daemon restart (…)`, says which limit applied and who asked for the restart. Raise `shutdown.drainTimeoutSeconds`, or the busy agent's own `drainTimeoutSeconds`, and the service's stop time with it.
- **A task says `timed out after 90m` although it ran for a few minutes:** the daemon that ran it is older than this fix. After an update, a task a restart cuts off says `killed by daemon restart` instead.
- **`stop` says the daemon is still finishing tasks:** wait, then check with `agentx daemon status` before starting it again.
- **Another tool got `503 daemon is restarting`:** it asked for new work during a restart. It can try again a little later.
- **A chat task wasn't picked up:** the log line starting `[resume]` says why. The usual reasons are that it was older than 30 minutes, it was already a second attempt, or there were several restarts in a row.
- **You got a "didn't resume" message you didn't expect:** that task came from somewhere with no chat to answer in. Send the request again, or add its source to `directChannels`.
