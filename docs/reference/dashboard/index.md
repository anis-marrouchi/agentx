# Dashboard

The dashboard is agentx's web UI — a single HTTP surface served by the daemon (or by `agentx board serve` standalone) at `http://127.0.0.1:4202` by default. Every CLI verb has a corresponding dashboard control; the dashboard is the recommended path for non-technical operators.

## Quick map

| Path | Page | What you do here |
|---|---|---|
| `/setup` | [Setup wizard](./setup) | Create or extend `agentx.json`, wire your first channel, mint your first token |
| `/live` | [Live activity](./live) | Real-time view of every reachable daemon's agents and recent tasks |
| `/boards` | [Boards (Kanban)](./boards) | Column-based view over GitLab/GitHub/local sources with drag-drop |
| `/workflows` | [Workflows](./workflows) | Workflow definition list, per-run timeline, optional visual editor |
| `/inbox` | [Inbox](./inbox) | Open user-tasks for the signed-in actor (or all actors) with form renderer |
| `/processes` | [Processes](./processes) | Live view of in-flight workflow runs with composition-tree + SLA indicators |
| `/graph` | [Intent graph](./graph) | Triage queue + taxonomy tree + schema editor for the intent classifier |
| `/admin` | [Admin panel](./admin) | Settings: Agents / Channels / Schedules / Webhooks / Mesh / Tokens / Advanced |
| `/admin/agents/<id>` | [Per-agent page](./agent) | Edit metadata, system prompt, skills, identity files (CLAUDE.md), channels, handovers |

The token usage dashboard runs on a **separate process** (`agentx usage serve`) — see [Usage dashboard](./usage).

## Configuration

The dashboard is off by default. Enable it via `dashboard.enabled = true` in `agentx.json`:

```json
"dashboard": {
  "enabled": true,
  "port": 4202,
  "bind": "127.0.0.1",
  "daemonUrl": "http://localhost:18800"
}
```

For multi-daemon (mesh) installs, populate `dashboard.daemons[]` so the live view polls every reachable peer; see [config schema](../config-schema#dashboard).

## Auth

By default the dashboard's writes are unauthenticated — fine for `127.0.0.1` binds. Set `dashboard.token` (or mint via `agentx token create --scope dashboard:read,dashboard:admin`) when binding to a non-loopback interface (Tailscale, LAN). The token goes in the `Authorization: Bearer <secret>` header.

## How it relates to the daemon

The dashboard is a thin HTML/CSS/JS shell that talks to the daemon's HTTP API (`/agents`, `/health`, `/task`, `/api/workflows/*`, `/business/*`). On a single-node install, dashboard and daemon run side-by-side under `agentx daemon start`. The standalone `agentx board serve` is the same shell pointed at a remote daemon — useful for managing a server-only deployment from a laptop.

## Hardening

Production dashboards should:

- Bind to a private interface (Tailscale `100.x` or `127.0.0.1` behind an SSH tunnel)
- Require `dashboard.token` for writes
- Be reverse-proxied with TLS if exposed beyond loopback

See [Journey 11 — Production hardening](/journey/11-production-hardening).
