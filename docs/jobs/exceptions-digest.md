# Get a daily list of what is wrong

When many schedules and agents run on their own, a message for every run is too much to read. The exceptions digest is one message a day that lists only what needs a look. When nothing is wrong, nothing is sent.

It lists three kinds of problem found on this machine:

| Section | What is listed |
|---|---|
| **Schedules** | A schedule whose latest run failed or ran out of time, and a schedule that was due but did not run (for example because AgentX was stopped). A schedule that failed and then ran fine is not listed. |
| **Stuck requests** | An open request that needs attention, is past its due time, or has had no activity for a day (the `requests.staleAfterHours` setting). Needs [open requests](./open-requests.md) switched on. |
| **Paused agents** | An agent that has used its monthly budget, so new runs are refused until the month ends. |

Each digest covers what happened since the previous one, so a failed or missed run shows up in the next digest. It is off until you switch it on.

## Switch it on

1. **Terminal:** check that AgentX knows where to send messages. Run `agentx notifications` and look for a destination. If there is none, follow [Get notified](./notifications.md) first, or give the digest its own `destination` in step 4.
2. Open `agentx.json` in a text editor.
3. Add an `exceptionsDigest` section at the top level (next to `crons`):
   ```json
   "exceptionsDigest": {
     "enabled": true,
     "time": "08:30",
     "timezone": "Europe/Paris"
   }
   ```
   `time` is when the digest goes out, on a 24-hour clock. `timezone` is the time zone that time is read in; leave it out to use this computer's.
4. Optional: to send the digest somewhere other than your usual notification chat, add a destination:
   ```json
   "destination": { "channel": "telegram", "chatId": "123456789" }
   ```
5. Save the file. The daemon picks up the change by itself; no restart needed.

A digest looks like this:

```text
Needs a look on office-mac:
Schedules (2)
- backup-check (reporter): 2026-10-25 05:00 UTC, failed: exit 2
- weekly-summary (writer): due 2026-10-25 06:00 UTC, did not run
Stuck requests (1)
- Renew the shop certificate (helper): past its due time (2026-10-24 17:00 UTC)
Paused agents (1)
- writer: monthly budget used ($50.00 of $50.00)
Details: Operations in the dashboard, or run: agentx schedule list
```

To have a single schedule stay quiet unless it finds a problem, see [Report only when something is wrong](./daily-report.md#report-only-when-something-is-wrong).

## Check it worked

1. Wait until after the time you set.
2. **Terminal:** run `agentx daemon logs` and search for `[exceptions]`.
3. You see either `[exceptions] digest sent: …`, and the message arrived in your chat, or `[exceptions] digest: nothing wrong, nothing sent`.

## If something is wrong

- **No `[exceptions]` line at all:** check that `exceptionsDigest.enabled` is `true` and that the daemon is running (`agentx daemon status`). It goes out at most once a day, after `time`; if the daemon started after that time today, it goes out straight away.
- **It was due but nothing was sent and nothing logged:** there is no destination. Set `notifications.destination`, or `exceptionsDigest.destination`.
- **`[exceptions] digest failed`:** the chat could not be reached. The rest of the line says why. The digest is not retried that day.
- **A schedule you expected is not listed:** a schedule that has never run is not listed as missed, and a missed run counts only once its time limit has passed (2 hours for an agent schedule). A schedule that is switched off is listed only if its last run failed.
- **Stuck requests are never listed:** open requests are off. See [Keep track of what you asked for](./open-requests.md).
