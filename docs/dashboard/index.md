# The dashboard

Open the local dashboard address printed by `agentx setup` (normally `http://127.0.0.1:4202`). The top bar has six tabs:

| Tab | What to look for |
|---|---|
| [Live](./live.md) | Agents currently running |
| [Operations](./operations.md) | Work across connected machines |
| [Monitor](./monitor.md) | What needs a person and what agents can handle |
| [Activity](./activity.md) | What ran and the decisions it recorded |
| [Workflows](./workflows.md) | Saved automations and the editor |
| [Settings](./settings.md) | Agents, channels, schedules, and connections |

Start in Monitor for a work overview, then open Activity when you need to investigate a particular run. Some views need data from specific integrations before they show anything.

## Talk to your agents

Use [in-page chat](chat.md) to ask about the current view. You can also work through the [macOS desktop assistant](voice.md) or the [OpenCode terminal UI](tui.md).

## Behind a reverse proxy

The dashboard and the daemon accept browser requests only from pages they serve themselves. This stops a web page open on the same machine from using them. If a reverse proxy serves the dashboard under another host name and doesn't forward `X-Forwarded-Host`, list that address in `AGENTX_ALLOWED_ORIGINS`, for example `AGENTX_ALLOWED_ORIGINS=https://ops.example.com`. Separate several addresses with commas.
