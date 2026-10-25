# Send a daily report

A schedule asks an agent to do something at a set time, with no one having to ask. This page sets up a schedule that asks an agent for a short report every day.

Each run uses your model account, every day, whether or not anyone reads the report. See [What this costs](../help/costs.md).

::: warning The dashboard and the terminal use different clocks
A schedule made in the dashboard always runs in **UTC** (world time, the clock of London in winter). A schedule made in the terminal runs in **your computer's own time zone** unless you say otherwise. So "9:00" in the dashboard is not 9:00 on your clock unless you live on UTC.

To get a report at 9:00 your time from the dashboard, convert your time to UTC first. For example, in Paris in summer (UTC+2), 9:00 local is 7:00 UTC, so pick **7:00 am**. In New York in winter (UTC−5), 9:00 local is 14:00 UTC, so pick **2:00 pm**. When your clocks change for summer or winter, the report moves by an hour. To avoid this, create the schedule from the terminal (below).
:::

## Create the schedule in the browser

1. **Browser:** open the dashboard and select **Settings**.
2. Select the **Schedules** tab.
3. Under **Create a new schedule**, keep **Guided** selected.
4. In the sentence, pick the agent that should write the report.
5. Pick **every day**.
6. Pick a time **in UTC**, such as **7:00 am** for 9:00 in Paris in summer. See the box above.
7. Under **Give it a name**, type an ID such as `daily-report` (lowercase, no spaces).
8. Under **What should the agent do?**, say which information to read and what the report should look like.
9. Select **Add schedule**. The schedule is switched on straight away.

![Three disabled examples in Settings → Schedules](/screenshots/settings-crons.png)

The guided form always uses the **UTC** time zone; it has no time zone picker. To use your own time zone, create the schedule from the terminal instead (below).

## Or create it from the terminal

1. **Terminal:** preview the schedule without saving it. Replace `reporter` with one of your agent IDs and `Europe/Paris` with your time zone:
   ```sh
   agentx schedule "daily at 9am" --agent reporter --do "Summarize yesterday's work in a short report" --timezone Europe/Paris --dry-run
   ```
   Here "9am" means 9:00 in Paris, all year round.
2. Read the preview it prints.
3. **Terminal:** run the same command again without `--dry-run` to save it.

Without `--timezone`, the command uses the computer's own time zone. Time zone names look like `Europe/Paris` or `America/New_York`; `UTC` works too. The daemon (the AgentX background service) must be running for the schedule to fire.

## Deliver the report to a chat

To have each report posted to a chat, such as your Telegram, give the schedule a chat to send to (its `notify` destination). After every run that succeeds, the report is posted there. If a run fails, a short failure message goes to the same chat.

### From the terminal

1. **Terminal:** find your chat. If `notifications.destination` is already set in `agentx.json` (see [Get notified](./notifications.md)), you can use `me` for it. Otherwise use `telegram:<chat id>`, where `<chat id>` is the number of your chat with the bot.
2. **Terminal:** create the schedule with `--notify`. Replace `reporter` with one of your agent IDs:
   ```sh
   agentx schedule "daily at 9am" --agent reporter --do "Summarize yesterday's work in a short report" --notify me --dry-run
   ```
3. Read the preview. The `Notify:` line ends with `(results and failures)`.
4. **Terminal:** run the same command again without `--dry-run` to save it.

To be told only when the schedule **fails**, and not get the reports, add `--no-deliver`.

### For a schedule that already exists

1. Open `agentx.json` in a text editor.
2. Find the schedule under `crons`.
3. Add a `notify` destination:
   ```json
   "daily-report": {
     "schedule": "0 9 * * *",
     "agent": "reporter",
     "prompt": "Summarize yesterday's work in a short report",
     "notify": { "channel": "telegram", "chatId": "123456789" }
   }
   ```
4. Save the file. The daemon picks up the change by itself; no restart needed.

An agent you ask from a chat ("every day at 9, send me a report") sets this up for you: see [Ask an agent to schedule something](../automations/schedules-from-chat.md).

## Report only when something is wrong

A check that runs every day and says "all fine" every day soon gets ignored. Set the schedule to report only exceptions, and the agent decides on each run whether there is anything to say. When everything is as expected, nothing is sent.

How it works: AgentX adds one line to the end of the prompt, asking the agent to reply with exactly `NOTHING_TO_REPORT` when all is well. A run that answers with that word sends nothing to the chat. Any other answer is sent as usual. A failed run still sends its short failure message.

### From the terminal

1. **Terminal:** preview the schedule. Replace `reporter` with one of your agent IDs:
   ```sh
   agentx schedule "daily at 7am" --agent reporter --do "Check that last night's backups finished and are less than a day old" --notify me --only-exceptions --dry-run
   ```
2. Read the preview. The `Notify:` line ends with `(exceptions and failures)`.
3. **Terminal:** run the same command again without `--dry-run` to save it.

### In `agentx.json`

1. Open `agentx.json` in a text editor.
2. Find the schedule under `crons`.
3. Add `"report": "exceptions"`:
   ```json
   "backup-check": {
     "schedule": "0 7 * * *",
     "agent": "reporter",
     "prompt": "Check that last night's backups finished and are less than a day old",
     "notify": { "channel": "telegram", "chatId": "123456789" },
     "report": "exceptions"
   }
   ```
4. Save the file. The daemon picks up the change by itself.

Write the prompt so the agent knows what "wrong" means: name what to check and the limit, such as "less than a day old". Each quiet run is still kept, so you can open it in **Operations** to see what the agent checked.

To get one message a day that lists every failed or missed schedule, stuck request and paused agent, and nothing when all is well, see [Get a daily list of what is wrong](./exceptions-digest.md).

## Check it worked

1. **Browser:** in **Settings › Schedules**, the new schedule appears in the list with its timing and agent.
2. **Terminal:** `agentx schedule list` shows it with a plain-English description of when it runs.
3. If you gave it a chat: after its first run time, the report arrives in that chat. For a schedule that reports only exceptions, nothing arrives when all is well: open the run in **Operations** instead (next step).
4. After its first run time, **Browser:** open **Operations**, switch the view to **Operations**, and find the schedule under **Today's automations**. Its drawer lists the run with an **Open** link. See [Operations](../dashboard/operations.md).

## If something is wrong

- **It ran at the wrong hour:** the guided form uses UTC, not your time. Remove the schedule and create it again from the terminal with `--timezone`, or pick the UTC time in the form as shown in the box at the top.
- **`Cron id must be lowercase`:** use only lowercase letters, digits, `-` and `_` in the name.
- **`Cron "…" already exists`:** pick another name, or delete the old schedule first.
- **Nothing ran:** check that the daemon is running with `agentx daemon status`, and that the schedule is switched on (`agentx schedule on <id>`).
- **It ran but no message arrived:** run `agentx schedule list`. The schedule needs a `notify:` line that ends with `(results and failures)`. If there is no `notify:` line, follow [Deliver the report to a chat](#deliver-the-report-to-a-chat). If it says `(failures only)`, remove `"deliverResult": false` from the schedule in `agentx.json`. If the line is there, check the run in **Operations**: a run with an empty answer sends nothing.
- **A report-only-exceptions schedule sends "all fine" messages:** the agent did not answer with the exact word. Add to the prompt: "If all is well, reply with only NOTHING_TO_REPORT."
- **A report-only-exceptions schedule never sends anything:** open its runs in **Operations**. If they all say `NOTHING_TO_REPORT`, make the prompt say plainly what counts as wrong.
- **The run failed:** open it from Operations to read the error. See also [It's not answering](../help/its-not-answering.md).
