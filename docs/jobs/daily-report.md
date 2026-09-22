# Send a daily report

A schedule can ask an agent to prepare a report every day. Choose the source, the hour and timezone, and where the result should go. Start with a manual test before leaving the schedule enabled.

::: info In the browser
Open **Settings → Schedules**. Under **Create a new schedule**, use **Guided** mode, choose the agent, **every day**, and a time. Give it an ID such as `daily-report`. Under **What should the agent do?**, name the information to read and the report you expect. Select **Add schedule**.
:::

The guided form creates an enabled schedule in **UTC**. It does not have a timezone picker. For a different timezone, ask your installer to use the terminal command below or update the schedule's configuration.

![Three disabled examples in Settings → Schedules](/screenshots/settings-crons.png)

A completed scheduled task does not by itself guarantee delivery to a chat. For reliable delivery, create a workflow with an explicit send step and the correct channel and conversation. Use [Describe what you want](../automations/describe-it.md), then check both its run record and the destination. The CLI's `--notify` setting is for failure notifications, not automatic delivery of every successful report.

::: info Terminal
An engineer can create a schedule with the natural-language command. Replace `reporter` with an existing agent ID:
:::

```sh
agentx schedule "daily at 9am" --agent reporter --do "Summarize yesterday's work in a short report" --timezone Africa/Tunis --dry-run
```

Remove `--dry-run` after checking the proposed schedule. The command writes a schedule; the daemon must be running for it to fire. In the browser, use **Settings** to inspect schedules and **Activity** to check completed runs.
