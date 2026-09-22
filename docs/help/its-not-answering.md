# It's not answering

Check these in order. The browser loading successfully does not prove the daemon is running.

1. **Are both processes running?** `agentx setup` starts the dashboard. Run `agentx daemon status` in a terminal; start it with `agentx daemon start --detach` if needed.
2. **Did the message arrive?** Open the dashboard's `/admin/observability` page and look for the route trace. If there is no trace, check the channel connection and its webhook or polling status.
3. **Which agent received it?** If the trace names the wrong agent, fix the channel assignment in **Settings**.
4. **Did the agent run?** Open **Activity**. A model login, missing key, or unavailable workspace may show here.
5. **Run the health check.** `agentx doctor` checks configuration, credentials, and reachability. Share its findings with your installer after removing secrets.

For a silent Telegram bot, also send the bot a fresh message after pairing. For a GitLab webhook, check delivery in GitLab and reachability of the daemon URL.

**Just added an agent?** Agent additions require a daemon restart. In Docker, run `docker compose restart daemon dashboard` from the checkout. On a local installation, stop and start the daemon. If a model responds but Monitor shows failed reviews, check the separate Claude Code reviewer described on the [Monitor page](../dashboard/monitor.md).
