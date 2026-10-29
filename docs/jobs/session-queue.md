# Keep a small machine from running out of memory

Every agent reply starts a *session*: a program that runs the agent's model and tools. Each one takes memory. On a small machine, many sessions starting at once can fill the memory and the *swap* (disk space the system uses when memory runs out), and the machine slows down or stops.

AgentX checks first. Before any session starts (a chat message, a scheduled job, a message from another agent), it waits in one **queue** until the machine has room. Nothing is dropped: the work waits and starts on its own once there is room.

A session starts only when all of these hold:

| Check | Default | Setting |
|---|---|---|
| Free memory (memory the system can hand out without swapping) | at least 10% of the memory, and at least 512 MB | `admission.minAvailableMemoryPercent`, `admission.minAvailableMemoryMB` |
| Swap in use | at most three quarters of the memory size | `admission.maxSwapUsedMB` (0 = default) |
| Free disk where AgentX runs | at least 2048 MB | `admission.minDiskFreeMB` (0 = no check) |
| Load (how many programs wait for the processor, over the last minute) | at most 2 per processor | `admission.maxLoadPerCpu` (0 = no check) |
| Sessions running on this machine | at most one per GB of memory, at least 2 | `admission.maxSessions` (0 = default) |
| Sessions of one kind, such as browser jobs | as you set | `admission.classes` |

If nothing of AgentX's is running, one session still starts even when memory is short (`admission.allowOneWhenIdle`). The pressure then comes from other programs, and a machine that never answers is worse than one slow answer.

## Who goes first

The queue is ordered by priority, then by age:

1. **owner**: you, on voice or the phone app, or anyone with the owner role in `people`. Owner work may go one session over the limit (`admission.ownerExtraSessions`) but never past the memory, swap, disk or load checks.
2. **critical**: agents listed in `admission.priority.criticalAgents`.
3. **normal**: everything else, such as chat messages and messages from other agents.
4. **background**: scheduled jobs and heartbeats (`admission.priority.backgroundChannels`).

## After a restart

For the first five minutes after AgentX starts, at most two sessions start every 30 seconds (`admission.boot`). Any two starts are also at least 3 seconds apart (`admission.minStartGapSeconds`). Owner work skips both. Chat messages still waiting when AgentX stops are not lost: they run again after the restart, through the queue.

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
2. Read the output. It shows the machine's memory, swap, disk and load, whether the gate is open, the limits, what is running, what is waiting in order and why, and what runs next.
3. For the same data as JSON, run `agentx queue --json`, or open `/api/queue` on the daemon (by default `http://localhost:18800/api/queue`).

## If something is wrong

- **Work waits a long time.** Run `agentx queue` and read the "held by" line under each waiting item. If swap stays high long after the machine is quiet, raise `admission.maxSwapUsedMB`.
- **The machine still runs out of memory.** Lower `admission.maxSessions`, or raise `admission.minAvailableMemoryPercent`.
- **`agentx queue` says HTTP 404.** The daemon is older than the command. Restart it after updating AgentX.
