# Keep a small machine from running out of memory

Every agent reply starts a *session*: a program that runs the agent's model and tools. Each one takes memory. On a small machine, many sessions starting at once can fill the memory and the *swap* (disk space the system uses when memory runs out), and the machine slows down or stops.

AgentX checks first. Before any session starts (a chat message, a scheduled job, a message from another agent), it waits in one **queue** until the machine has room. The work waits and starts on its own once there is room. Work that waits longer than an hour (`admission.maxWaitMinutes`) is refused with a plain message saying why.

Only agents that start a program on this machine wait in the queue (the `claude-code`, `codex-cli` and `opencode` tiers, set in `admission.tiers`).

A session starts only when all of these hold:

| Check | Default | Setting |
|---|---|---|
| Free memory (memory the system can hand out without swapping) | at least 10% of the memory, and at least 512 MB | `admission.minAvailableMemoryPercent`, `admission.minAvailableMemoryMB` |
| Swap in use | at most half the swap size; where the system grows swap as needed (macOS), at most three quarters of the memory size | `admission.maxSwapUsedMB` (0 = default) |
| Free disk where AgentX runs | at least 2048 MB | `admission.minDiskFreeMB` (0 = no check) |
| Load (how many programs wait for the processor, over the last minute) | at most 2 per processor | `admission.maxLoadPerCpu` (0 = no check) |
| Sessions running on this machine | one per GB of memory above the first 2 GB, at least 2 (6 on an 8 GB machine) | `admission.maxSessions` (0 = default) |
| The agent itself | a free place for the agent (its `maxConcurrent`) | the agent's settings |
| Sessions of one kind, such as browser jobs | as you set | `admission.classes` |

Two things can start while these checks say no, on purpose:

- If nothing of AgentX's is running, one session still starts even when memory is short (`admission.allowOneWhenIdle`). The pressure then comes from other programs, and a machine that never answers is worse than one slow answer. Set it to `false` to hold everything.
- Owner work skips the start pace (below) and may go one session over the limit.
- Critical work, such as an alert, is not held by the swap or load checks. See [Alerts that must not wait](#alerts-that-must-not-wait).

When a running agent hands part of its work to a helper agent, the helper may go two sessions over the limit (`admission.delegationHeadroom`). The first agent keeps its place while it waits for the helper, so without this room a full machine would wait on itself.

## Who goes first

The queue is ordered by priority, then by age:

1. **owner**: you, on voice or the phone app, or anyone with the owner role in `people`. Owner work may go one session over the limit (`admission.ownerExtraSessions`) but never past the memory, swap, disk or load checks.
2. **critical**: agents listed in `admission.priority.criticalAgents`, and messages sent with `"priority": "critical"` (see below).
3. **normal**: everything else, such as chat messages and messages from other agents.
4. **background**: scheduled jobs and heartbeats (`admission.priority.backgroundChannels`).

## Alerts that must not wait

On macOS, swap stays in use long after the machine has free memory again. Work held only by the swap check can then wait up to an hour, and an alert (a battery warning, a full disk) arrives too late.

Critical work is therefore not held by the swap check or the load check. It still waits when:

- free memory is below its limit,
- free disk is below its limit,
- the machine already runs as many sessions as it may, or
- the start pace (below) says wait.

Only the time held by these checks counts toward `admission.maxWaitMinutes`, so critical work is never refused because swap stayed high.

To send a message as critical, add `"priority": "critical"` to a `POST /send/agent` request, or `priority: "critical"` to the `agentx_send_agent` tool. It works for an agent on another machine too. For example (terminal):

```sh
curl -s -X POST http://127.0.0.1:18800/send/agent -H 'Content-Type: application/json' \
  -d '{"agentId":"helper","senderAgentId":"watcher","priority":"critical","text":"Battery at 10%, not charging."}'
```

Use it for alerts only. Any other value of `priority` is ignored, and a message from the owner keeps its owner priority.

## After a restart

For the first five minutes after AgentX starts, at most two sessions start every 30 seconds (`admission.boot`). Any two starts are also at least 10 seconds apart (`admission.minStartGapSeconds`), so the machine's memory reading includes the last session before the next one starts. Owner work skips both.

When AgentX stops, chat messages still waiting are not lost: they run again after the restart, through the queue. Other waiting work (a scheduled job, a message from another agent) is answered as interrupted, so the job's run is recorded and the other agent hears back.

## Tell the person their message is waiting

A chat message that has waited 2 minutes (`admission.waitNotice.afterSeconds`, default `120`; `0` turns it off) gets one written line on its thread. The line says the message arrived, why it has not started yet, and that the answer will come there. Only channels in `admission.waitNotice.channels` get it (default `["gitlab"]`).

The line is sent once per message, also across restarts. On GitLab it is a top-level note that everyone on the project can read, so it holds a plain reason only ("short of free disk space", "working on another request"), never numbers or machine names. The full reason is in the log, on the line that starts with `[wait-notice]`.

On the same channels, the two ends without a start are also told in plain words:

- **Refused after `admission.maxWaitMinutes`:** the line says the message could not start and is no longer queued, and asks for it again.
- **Plan limit reached:** the message is not kept, so the line asks for it again after a time in UTC, when that time is known. It is posted once per thread. It is posted again after that time has passed, or after a run on the thread has answered.

## Idle sessions make room

A session that has finished its reply stays open for a while (`processPool.maxIdleSeconds`), so the next message in that chat starts faster. An open session still holds memory. When work is waiting only because memory or swap is short, AgentX closes some idle sessions early:

1. It closes up to three sessions, the ones that have been quiet longest first (`admission.closeIdle.maxPerRound`).
2. It waits 30 seconds (`admission.closeIdle.settleSeconds`) and reads the memory again, because swap keeps falling for a while after a session closes.
3. It repeats until the gate opens, then stops.

These sessions are never closed this way:

- a session writing a reply, with a background task open, or writing a reply nobody asked for
- a session quiet for less than 60 seconds (`admission.closeIdle.minQuietSeconds`)
- a session whose chat has work waiting or running

Nothing is lost when a session closes. The next message in that chat continues the same conversation, and only starts a little slower.

Closing idle sessions does not help with a full disk or a high load, so AgentX does not close any for those. To turn this off, set `admission.closeIdle.enabled` to `false`. In `observe` mode, AgentX only logs `[admission] observe: would close`.

## Limit one kind of work

To let only one browser job run at a time:

1. Open `agentx.json`.
2. Add a class under `admission`:

```json
{
  "admission": {
    "classes": {
      "browser": { "max": 1, "agents": ["web-tester"] }
    }
  }
}
```

3. Save the file. AgentX reads the change without a restart.

A class can also match by channel, with `"channels": ["cron"]`. A full class holds only its own work; the rest of the queue keeps moving.

## Try it without holding anything

1. Run this in a terminal: `agentx config set admission.mode observe`
2. Watch the log for lines starting `[admission] observe: would hold`.
3. Run `agentx config set admission.mode enforce` to turn holding back on.

To turn the queue off completely, set `admission.enabled` to `false`.

In an emergency, start the daemon with the environment variable `AGENTX_ADMISSION=off`. The queue is then off whatever the settings say, until the daemon runs without it.

## Check it worked

1. Run this in a terminal: `agentx queue`
2. Read the output. It shows when the machine was checked, its memory, swap, disk and load, whether the gate is open, the limits, what is running, what is waiting in order and why, and what runs next.
3. For the same data as JSON, run `agentx queue --json`, or open `/api/queue` on the daemon (by default `http://localhost:18800/api/queue`).
4. To see idle sessions making room, look in the daemon log for `[process-registry] closed idle`. There is one line for each session closed, with the reason.
5. To see a critical message go past a swap hold, look in the daemon log for `[admission] started <agent> (critical) past the gate (swap: …)`.

## If something is wrong

- **Work waits a long time.** Run `agentx queue` and read the "held by" line under each waiting item. If swap stays high long after the machine is quiet, raise `admission.maxSwapUsedMB`.
- **An alert still waits.** Check that the sender adds `"priority": "critical"`. If `agentx queue` shows it held by `memory:`, `disk:` or `session cap`, that is on purpose: the machine is really short.
- **The log says `no idle session to close` and work keeps waiting.** Every open session is in use, or the memory is held by other programs. Stop those programs or wait for the running work to finish.
- **Chats often start slower while the machine is busy.** Idle sessions are being closed to make room. Raise `admission.closeIdle.minQuietSeconds` to keep them open longer.
- **The machine still runs out of memory.** Lower `admission.maxSessions`, or raise `admission.minAvailableMemoryPercent`.
- **`agentx queue` says HTTP 404.** The daemon is older than the command. Restart it after updating AgentX.
