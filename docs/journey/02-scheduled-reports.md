# 2. Scheduled reports that page you on failure

> **Difficulty:** beginner · **Time:** 10 minutes · **Ends at:** a daily cron that compiles a report — and alerts Telegram if it fails three times

## Scenario

Every morning at 9am Africa/Tunis, the `devops` agent should check pipeline health, open issues in GitLab, and post a 5-line summary to the team's Telegram group. If it fails **three days in a row**, AgentX should disable the job and DM the on-call engineer.

## Prerequisites

- A working agent from [Journey 1](/journey/01-telegram-qa-bot)
- A Telegram group chat ID where reports land (see below)

## Finding your chat ID

1. Add your bot to the target group
2. Send any message in the group
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Copy the `chat.id` (group IDs start with `-100…`)

## Config

Add to `agentx.json` under `crons`:

```json
{
  "crons": {
    "morning-standup": {
      "enabled": true,
      "schedule": "0 9 * * *",
      "timezone": "Africa/Tunis",
      "agent": "devops",
      "timeout": 600,
      "model": "claude-sonnet-4-6",
      "onError": ["notify", "disable"],
      "notify": {
        "channel": "telegram",
        "chatId": "-1001234567890",
        "accountId": "default"
      },
      "prompt": "Post the morning standup to the team chat:\n1. Pipeline status (GitLab projects <list>)\n2. New issues opened in last 24h\n3. Deployments since yesterday\n4. Any alerts pending\n5. Top 3 priorities today\nKeep each line under 15 words."
    }
  }
}
```

## The `onError` pipeline

`onError` accepts either a single string or an array of actions. Combine them freely:

| Value | Meaning |
|---|---|
| `"log"` | Write failures to the daemon log (default; also always happens) |
| `"notify"` | Push to the `notify` channel. Triggers on first failure if set alone, or after 2 consecutive failures otherwise. |
| `"disable"` | Auto-disable the job after 3 consecutive failures |
| `["notify", "disable"]` | Both — page me **and** stop after 3 fails |

Retry schedule on failure: **30s → 1m → 5m → 15m → 60m**. Once a run succeeds, the counter resets.

## Commands

```bash
agentx cron list                    # see schedule + status
agentx cron enable morning-standup
agentx cron disable morning-standup

# Trigger manually (doesn't wait for cron time) — edit the daemon over HTTP:
curl -X POST http://localhost:19900/cron/run/morning-standup
```

## Verify

1. Set the schedule to `* * * * *` temporarily (every minute) to see it fire.
2. `agentx daemon watch` shows:
   ```
   [cron] morning-standup starting (agent: devops)
   [devops] executing task
   [cron] morning-standup completed in 18s
   ```
3. Restore the 9am schedule.

### Simulate a failure

Temporarily change the prompt to something that will error (e.g. reference a missing tool) and watch the retry + notify path:

```
[cron] morning-standup starting
[cron] morning-standup failed (1 consecutive): <error>
[cron] retry scheduled in 30s (attempt 1/5)
…
[CRON ALERT] Cron "morning-standup" failed (2x)
```

After three straight failures you'll also see:

```
[cron] morning-standup DISABLED after 3 consecutive failures
```

Re-enable with `agentx cron enable morning-standup` after fixing the prompt.

## Missed-run catch-up

If the daemon was down when the cron should have fired, AgentX detects it on startup and runs the missed job once (not for every missed slot). Useful for laptops that sleep overnight.

## What's next

- **Multiple agents in the same group** → [Journey 3](/journey/03-multi-agent-group)
- **Feed the cron a real backlog of tickets** → [Journey 7 — Business layer](/journey/07-business-layer)
- **All cron flags + config fields** → [Reference — Config schema](/reference/config-schema)
