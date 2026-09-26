# Ask an agent to schedule something

An agent you talk to on Telegram, WhatsApp or any other channel can set up a routine for you: "every Monday at 10, check the open invoices and ping me". It uses the `agentx_schedule` tool, which writes the same schedule the `agentx schedule` command would.

Nothing an agent asks for runs until you approve it.

## What the agent can do

| Action | Effect |
|---|---|
| `list` | Show schedules with their state, owner and next run |
| `create` | Request a new schedule. Saved disabled, marked pending, and you are notified |
| `pause` / `resume` | Stop or restart one of its own approved schedules |
| `delete` | Request removal. The schedule keeps running until you approve |

Timing is plain English, the same phrases `agentx schedule` accepts: "every morning at 9", "weekdays at 6pm", "every 15 minutes", "1st of every month at noon". Use `agentx schedule parse "<phrase>"` to preview one.

By default the routine runs as the agent you asked, and its results and failures go back to the chat you asked from. The agent can pass another agent, a timezone, or a different notify target (`channel:chatId`, or `none`).

## Approving a request

The request goes to `notifications.destination` and shows the parsed cron, the next time it would fire, the agent, where results go and the prompt. Approve or reject from the machine running the daemon:

```sh
agentx schedule list              # pending requests are marked ◐
agentx schedule approve <id>      # create: enable it; delete: remove it
agentx schedule reject <id>       # create: drop it; delete: keep the schedule
```

Both commands hot-reload the daemon. If no `notifications.destination` is set, the agent says so and the request waits in `agentx schedule list`.

A pending creation never runs, even if something else sets `enabled: true` on it. Only `approve` clears it.

## Who can change what

A schedule created through the tool records `createdBy`. An agent can pause, resume or request deletion only of schedules it created. Set `"admin": true` on an agent to let it manage other agents' and your own schedules too. An admin agent still cannot approve anything.

An agent that withdraws its own request before you approve it removes the pending entry directly, since it never ran.

## Making the tool available

The tool is part of the agentx MCP server (`agentx serve --stdio`). Codex and OpenCode agents get it automatically. Claude Code agents get it when their `mcp` block includes the agentx server. For each run it launches, AgentX exports the calling agent and chat to the tool, and those win over anything the agent passes. Long-lived (`persistentProcess`) agents identify themselves through the tool arguments instead.
