# 2. Scheduled reports that page you on failure

> **Difficulty:** beginner · **Time:** 5 minutes · **Ends at:** a daily job that compiles a report — and alerts Telegram if it fails three days in a row

## Scenario

Every morning at 9am Africa/Tunis, the `devops` agent should check pipeline health, open issues in GitLab, and post a 5-line summary to the team's Telegram group. If it fails **three days in a row**, AgentX should auto-disable the job and DM the on-call engineer.

## Prerequisites

- A working agent from [Journey 1](/journey/01-telegram-qa-bot)
- A Telegram group chat ID where reports land (see below)

## Finding your chat ID

1. Add your bot to the target group
2. Send any message in the group
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Copy the `chat.id` (group IDs start with `-100…`)

## Set a default notification target (once)

So you can type `--notify me` from now on:

```bash
agentx config set notifications.destination.channel telegram
agentx config set notifications.destination.chatId -1001234567890
agentx config set notifications.destination.accountId default
```

## Add the cron — natural language

```bash
agentx schedule "every morning at 9" \
  --agent devops \
  --do "Post the morning standup to the team chat:\n1. Pipeline status\n2. New issues opened in last 24h\n3. Deployments since yesterday\n4. Alerts pending\n5. Top 3 priorities today\nKeep each line under 15 words." \
  --notify me \
  --on-error notify,disable \
  --timezone Africa/Tunis
```

What prints:

```
  ✓ Added cron every-morning-at-9-devops
    Schedule: 0 9 * * *  (At 09:00 AM, Africa/Tunis)
    Agent: devops
    Notify: telegram -1001234567890
    On error: log, notify, disable
    Daemon hot-reloaded.
```

No JSON edits. No cron-syntax memorization. No daemon restart.

### What each flag means

| Flag | Purpose |
|---|---|
| `--agent devops` | Which agent runs each tick |
| `--do "..."` | The prompt sent on every firing |
| `--notify me` | Failure alerts go to `notifications.destination` (set once above) |
| `--on-error notify,disable` | Page **and** auto-disable after 3 consecutive failures |
| `--timezone` | IANA zone — cron fires on local wall-clock time |

`--notify` also accepts `channel:chatId[:accountId]` for an ad-hoc target.

### Supported English phrasings

```text
every morning at 9              → 0 9 * * *
every evening / every night     → 0 18 * * *  /  0 22 * * *
weekdays at 6pm                 → 0 18 * * 1-5
weekends at 10am                → 0 10 * * 0,6
every monday at 10am            → 0 10 * * 1
every tuesday and friday at 3pm → 0 15 * * 2,5
every 15 minutes                → */15 * * * *
every hour / hourly             → 0 * * * *
every 2 hours                   → 0 */2 * * *
1st of every month at noon      → 0 12 1 * *
daily at 9:30am                 → 30 9 * * *
at midnight / at noon           → 0 0 * * *  /  0 12 * * *
```

Preview any phrase without writing:

```bash
agentx schedule parse "every tuesday and friday at 3pm"
#   → 0 15 * * 2,5
#   → At 03:00 PM, only on Tuesday and Friday
```

## Manage jobs

```bash
agentx schedule list                        # human-readable table
agentx schedule off every-morning-at-9-devops
agentx schedule on every-morning-at-9-devops
agentx schedule remove every-morning-at-9-devops
```

Each action hot-reloads the daemon — the cron is rescheduled immediately.

## The `onError` pipeline

`onError` takes any combination of three actions:

| Value | Meaning |
|---|---|
| `log` | Write failures to the daemon log (always happens, regardless of this setting) |
| `notify` | Push to the `notify` channel. Triggers on first failure if set; otherwise after 2 consecutive failures. |
| `disable` | Auto-disable the job after 3 consecutive failures |

Retry schedule on failure: **30s → 1m → 5m → 15m → 60m**. Once a run succeeds, the counter resets.

## Verify

Temporarily speed up the schedule to watch it fire:

```bash
agentx config set crons.every-morning-at-9-devops.schedule "* * * * *"   # every minute
agentx daemon watch
```

You'll see:

```
[cron] every-morning-at-9-devops starting (agent: devops)
[devops] executing task
[cron] every-morning-at-9-devops completed in 18s
```

Restore the original schedule when done:

```bash
agentx schedule remove every-morning-at-9-devops
agentx schedule "every morning at 9" --agent devops --do "..." --notify me --on-error notify,disable
```

### Simulate a failure

Point the prompt at something that will error (e.g. reference a missing tool) and watch the retry + notify + disable path:

```
[cron] every-morning-at-9-devops starting
[cron] every-morning-at-9-devops failed (1 consecutive): <error>
[cron] retry scheduled in 30s (attempt 1/5)
…
[CRON ALERT] Cron "every-morning-at-9-devops" failed (2x)
…
[cron] every-morning-at-9-devops DISABLED after 3 consecutive failures
```

Re-enable once you've fixed the prompt:

```bash
agentx schedule on every-morning-at-9-devops
```

## Missed-run catch-up

If the daemon was down when the cron should have fired, AgentX detects it on startup and runs the missed job once (not for every missed slot). Useful for laptops that sleep overnight.

## Escape hatch — raw cron syntax

If you already know cron syntax and want to skip the English layer:

```bash
agentx cron add   # interactive, raw syntax
# or directly
agentx config set crons.raw-job.schedule "0 9 * * *"
agentx config set crons.raw-job.agent devops
agentx config set crons.raw-job.prompt "..."
```

Both paths write the same `crons.<id>` shape — you can mix and match.

## What's next

- **Multiple agents in the same group** → [Journey 3](/journey/03-multi-agent-group)
- **Feed the cron a real backlog of tickets** → [Journey 7 — Business layer](/journey/07-business-layer)
- **All cron flags + config fields** → [Reference — Config schema](/reference/config-schema)
