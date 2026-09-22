# Settings — connect the team

Settings contains the configuration for agents, channels, schedules, and other connections. Use it to add a Telegram bot, assign a channel to an agent, or review what is connected.

A saved setting does not start the daemon. If messages do not arrive, check `agentx daemon status`. Keep tokens out of screenshots and support requests. For sensitive access, use the smallest scope that supports the job.

![Settings agent list from the isolated demo](/screenshots/settings.png)

*The demo's CX agent is local and uses scripted replies.*

The **Channels** tab shows supported connectors. A saved token or disabled account does not mean a connection is live. The **Schedules** tab shows recurring jobs; confirm the enabled state and timezone before relying on one.

![Disabled example schedules in Settings](/screenshots/settings-crons.png)
