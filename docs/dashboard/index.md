# The dashboard

The dashboard is the AgentX website that runs on your own machine. You use it in a browser to see what agents are doing and to change settings. It is a separate program from the daemon (the AgentX background service that actually runs the agents), so the dashboard can load while the daemon is stopped.

## Open it

1. **Browser:** go to the address printed by `agentx setup`. It is normally `http://127.0.0.1:4202`.
2. Select a tab in the top bar.

If nothing loads, start the dashboard yourself:

1. **Terminal:** from the folder that holds `agentx.json`, run:
   ```sh
   agentx board serve
   ```
2. Keep that terminal open, and open the address again.

![The top bar and the Live tab](/screenshots/live.png)

The top bar has eight tabs:

| Tab | What to look for |
|---|---|
| [Live](./live.md) | Agents currently running |
| [Operations](./operations.md) | Work across connected machines |
| [Monitor](./monitor.md) | What needs a person and what agents can handle |
| [Approvals](./approvals.md) | Decisions waiting for your yes or no |
| [People](./people.md) | Who is connected, their machines and what they asked for |
| [Activity](./activity.md) | What ran and the decisions it recorded |
| [Workflows](./workflows.md) | Saved automations and the editor |
| [Settings](./settings.md) | Agents, channels, schedules, and connections |

Start in Monitor for an overview of the work, then open Activity when you need to look into a particular run. Some views stay empty until the matching app (for example GitLab) is connected. On the right of the top bar, **Dark** and **Light** switch the colour theme, and **Managing** picks which connected machine you are looking at.

## See which version is running

On every page, the right of the top bar shows the version of the daemon, its commit (the exact state of the source code it was built from) and when it started, in your time zone.

![The right of the top bar: the daemon's version and commit, and since when it has been running](/screenshots/live/running-build.png)

*The daemon runs version 0.89.0, built from commit e66f85a, and started on October 2.*

When the AgentX files on disk were rebuilt or upgraded after the daemon started, the same place adds a **restart pending** badge. Hover over it to read why: the code on disk is newer than the running daemon. The daemon keeps running the old code until it restarts: use **Restart when idle** on the Live tab, or `agentx daemon restart --when-idle` in a terminal ([restart without losing work](../jobs/restart-safely.md#restart-from-the-dashboard)). The line refreshes every minute.

The badge looks at the folder the daemon was started from. If you install each release into a new folder and then point the service at it, a release waiting in the new folder does not show the badge.

This is the daemon the dashboard is attached to (`dashboard.daemonUrl`), not the machine picked under **Managing**. For the full picture, with the last restart and how often the daemon restarts, run [`agentx daemon status`](../reference/cli.md#see-what-the-daemon-is-running).

## Talk to your agents

Use [in-page chat](chat.md) to ask about the current view. You can also work through the [macOS desktop assistant](voice.md) or the [OpenCode terminal UI](tui.md).

To open the dashboard through your own web address, see [Open the dashboard through your own web address](../jobs/reverse-proxy.md).

## Check it worked

1. **Browser:** open `http://127.0.0.1:4202/live`. The top bar shows the eight tabs.
2. Your agents appear on **Live**. If they do, the dashboard can reach the daemon.
3. The right of the top bar shows a version and "since" with a date. **Terminal:** `agentx daemon status` names the same version on its first line.

## If something is wrong

- **The page doesn't load:** the dashboard isn't running. Start it with `agentx board serve`, or run `agentx setup` again.
- **The page loads but shows no agents:** the daemon is stopped or unreachable. **Terminal:** run `agentx daemon status`. See [It's not answering](../help/its-not-answering.md).
- **Every page stops answering for seconds at a time, the teammate page and the phone app included:** one database read is holding the dashboard, which serves all of them. Read the output of `agentx board serve` (its terminal, or the log file of the service that starts it) for a line containing `slow query`. It gives the time taken and the query, for any read of 200 ms or longer. Report that line. No such line means the cause is elsewhere.
- **The page looks out of date after an update:** the dashboard is a separate program. Stop it and start it again.
- **The top bar shows no version:** the dashboard can't reach the daemon, or the daemon is older than this page. **Terminal:** run `agentx daemon status`.
- **The top bar shows "restart pending":** the daemon is running older code than what is installed. Restart it when no task is running: `agentx daemon restart --when-idle`.
- **You changed the port:** the address uses `dashboard.port` from `agentx.json` instead of `4202`.
