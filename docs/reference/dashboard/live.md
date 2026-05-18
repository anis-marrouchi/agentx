# Live activity

Path: `/live` (also the dashboard's default landing page when boards are not configured)

A real-time view of every reachable daemon: which agents are online, what they're doing right now, and the last handful of tasks. Driven by an SSE snapshot from `/api/live/stream`.

## What you'll see

- **Top bar**: peer chips (one per `dashboard.daemons[]` entry plus auto-discovered mesh peers). Click to filter.
- **Agent grid**: one card per agent, sized by recent activity. The card shows: status (idle / busy / error), current task preview, last message timestamp, queue depth.
- **Recent tasks rail** (right): a chronological feed of completed and in-flight tasks across the fleet.
- **Channel badges** on each card: which Telegram/Discord/Slack/WhatsApp/GitLab bindings the agent owns.

The view is "skim friendly" by design — scan the grid, spot the agent that's stuck, click into the [per-agent page](./agent) to investigate.

## What you can do

- **Click an agent card** to open `/admin/agents/<id>` (the per-agent page).
- **Click a task in the rail** to open the same page scrolled to that task in the history.
- **Filter by peer** via the top-bar chips when running multi-node mesh.
- **Watch the SSE stream** in dev tools: every change pushes a delta — no polling.
- **Stop a running task** — click `✕ stop` on the running-task card. Sends SIGTERM to the underlying `claude` subprocess (SIGKILL after 3 s) and the task surfaces `errorKind: "cancelled"`.
- **Update / correct a running task** — click `✎ update`, enter the correction. You pick whether to queue it (current run finishes, then your message dispatches as the next turn — preserves warm cache and in-process memory on `persistentProcess` agents) or replace (current run is killed, your message dispatches immediately — fresh process but conversation history is preserved). See the [HTTP API reference](#api) for the underlying endpoints.

## Common tasks

| You want to… | Do this |
|---|---|
| See which channel routed a message | Hover the channel badge on the agent card — tooltip shows the route + chat id |
| Know if a peer is unreachable | Peer chip turns red. Hover for the last error |
| Tail the daemon log instead | The CLI is faster: `agentx daemon logs -f` |

## Troubleshooting

- **Empty grid.** Check `dashboard.daemonUrl` resolves and the daemon is up (`curl $DAEMON/health`). If the daemon is on another machine, set `dashboard.daemons[]` (see [config schema](../config-schema#dashboard)).
- **Stuck "loading…" spinner.** The SSE stream couldn't connect. Look in the browser console for CORS errors; if you bound the daemon to a Tailscale IP, the dashboard's `daemonUrl` must be the same scheme/host.
- **Cards missing channel badges.** `channels.<name>.enabled` is true but no `routes[]` reach the agent. Check `agentx channel list` or the [Admin → Channels tab](./admin).

## Implementation pointers

- Page module: `src/daemon/ui/pages/live.ts` (skeleton + JS)
- API: `GET /api/live/stream` (Server-Sent Events)
- The live snapshot is computed from the same data the `agentx daemon status` and `agentx daemon watch` CLIs surface — single source of truth.

## <a id="api"></a>HTTP API

| Endpoint | Purpose |
|---|---|
| `POST /api/tasks/:taskId/cancel` `{ reason? }` | Stop an in-flight task. 404 if no running task matches `taskId` (use `GET /agents` → `runningTasks[].id` to find it). |
| `POST /api/tasks/:taskId/followup` `{ message, replace?, sender? }` | Inject a correction/update. `replace=false` (default) queues behind the running task; `replace=true` cancels the run first and dispatches the message immediately. |
| `POST /api/task/action?node=<url>&task=<id>&kind=cancel\|followup` | Dashboard-side proxy used by the Live page's Stop / Update buttons — forwards to the originating daemon with the configured operator token. |
