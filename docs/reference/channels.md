# Channels

A channel receives a message from another tool and routes it to an agent. The current product includes Telegram and WhatsApp pairing, GitLab and GitHub integrations, and generic webhooks. Availability and setup differ by channel; check the corresponding Settings panel and `agentx connect --help`.

**Slack and Discord are not supported as live channel adapters in this build.** Do not paste their tokens into a stale prompt or example. A connection record alone does not make an adapter run.

Keep channel credentials private. For a failed event, first check whether the remote tool delivered it, then look at `/admin/observability` and [Activity](../dashboard/activity.md).
