# Config schema

Every field in `agentx.json`. Source of truth: [`src/daemon/config.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/daemon/config.ts) and [`src/business/config.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/business/config.ts).

Environment variables are expanded inline: `${MY_TOKEN}` → `process.env.MY_TOKEN`. A `.env` file in the working directory is auto-loaded.

## Top-level shape

```json
{
  "node":          { "id": "...", "name": "...", "bind": "0.0.0.0:19900", "defaultAgent": "..." },
  "providers":     { "<provider>": { "apiKey": "", "defaultModel": "", "baseUrl": "" } },
  "agents":        { "<agentId>":  { ... } },
  "channels":      { "telegram": {...}, "whatsapp": {...}, "discord": {...}, "gitlab": {...} },
  "crons":         { "<cronId>":   { ... } },
  "services":      { "<serviceId>":{ ... } },
  "session":       { "staleMinutes": 45, "maxTurnsPerSession": 15, "tierTwoThresholdTokens": 180000, "contextStrategy": "layered" },
  "notifications": { ... },
  "mesh":          { ... },
  "business":      { ... }
}
```

## `node`

| Field | Type | Default | Purpose |
|---|---|---|---|
| `id` | string | — | Short slug identifying this node (used in mesh agent cards) |
| `name` | string | — | Human-readable node name |
| `bind` | string | `127.0.0.1:18800` | HTTP bind address. Use `0.0.0.0:…` for mesh or multi-interface |
| `defaultAgent` | string | — | Agent for endpoints that don't specify one (e.g. `POST /ask`) |

## `providers`

Keyed by provider name (`claude`, `openai`, `ollama`, …). Each entry:

| Field | Type | Purpose |
|---|---|---|
| `apiKey` | string | Used by `sdk` and `orchestrator` tiers |
| `defaultModel` | string | Model id if the agent doesn't specify one |
| `baseUrl` | string | Override endpoint (Ollama, proxies) |

## `agents.<id>`

| Field | Type | Default | Purpose |
|---|---|---|---|
| `name` | string | — | Display name |
| `workspace` | string | — | Directory with `CLAUDE.md`, skills, MCP config |
| `tier` | `claude-code` \| `sdk` \| `orchestrator` | `claude-code` | Execution strategy |
| `provider` | string | — | For `sdk`/`orchestrator`: which `providers[]` entry |
| `model` | string | — | Model id |
| `systemPrompt` | string | — | Inline override (normally live in `CLAUDE.md`) |
| `mentions` | string[] | `[]` | `@handles` that route to this agent |
| `maxConcurrent` | number | `1` | Parallel turns allowed |
| `permissionMode` | string | `default` | Claude Code permission mode (`default`, `acceptEdits`, `plan`, `bypassPermissions`) |
| `queueMode` | `collect` \| `followup` \| `drop` | `collect` | Behavior when messages arrive during a turn |
| `heartbeat.enabled` | bool | `false` | Enable periodic in-session check-ins |
| `heartbeat.intervalMinutes` | number | `30` | |
| `heartbeat.prompt` | string | stock prompt | |
| `heartbeat.channel` | string | `heartbeat` | Virtual channel tag |

## `channels.telegram`

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `accounts.<name>.token` | string | — | Bot token (env expansion OK) |
| `accounts.<name>.agentBinding` | string | — | Agent id this bot speaks for |
| `policy.dm` | `pair` \| `block` | `pair` | DM policy |
| `policy.group` | `mention-required` \| `all` | `mention-required` | Group policy |

## `channels.whatsapp`

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `sessionDir` | string | `.agentx/whatsapp-sessions` | |
| `defaultAgent` | string | — | |
| `allowFrom` | string[] | — | Contact allowlist |
| `routes[].contact` / `.group` | string | — | Match |
| `routes[].agent` | string | — | Target agent |

## `channels.discord`

| Field | Type | |
|---|---|---|
| `enabled` | bool | |
| `token` | string | |
| `agentBinding` | string | |

## `channels.gitlab`

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `host` | string | `https://gitlab.com` | |
| `webhookPort` | number | `18810` | |
| `webhookSecret` | string | — | |
| `token` | string | — | Fallback API token |
| `routes[].project` / `.agent` | string | — | |
| `agentMappings[].agentId` | string | — | |
| `agentMappings[].gitlabUsernames` | string[] | `[]` | |
| `agentMappings[].keywords` | string[] | `[]` | |
| `agentMappings[].token` | string | — | Per-agent GitLab PAT |

## `crons.<id>`

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `true` | |
| `schedule` | string | — | 5-field cron |
| `timezone` | string | `UTC` | |
| `agent` | string | — | |
| `prompt` | string | — | |
| `timeout` | number | `600` | seconds |
| `model` | string | — | |
| `onError` | string \| string[] | `log` | Any of `log`, `notify`, `disable`. See [Journey 2](/journey/02-scheduled-reports) |
| `notify.channel` / `.chatId` / `.accountId` | string | — | Where failures get pushed |

## `services.<id>`

Deterministic handlers that intercept messages **before** agent routing — no LLM call for the match.

| Field | Type | |
|---|---|---|
| `name` | string | Human label |
| `triggers[].pattern` | string (regex) | |
| `triggers[].channel` | string | Restrict to a channel |
| `allowedContacts` | string[] | Whitelist |
| `agent` | string | Dispatch target |
| `prompt` | string | Known prompt (not user text) |
| `schedule` | string | Optional cron — run on timer too |
| `timezone` | string | |
| `notify.channel` / `.chatId` / `.accountId` | string | Push result |

## `mesh`

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `peers[].url` | string | — | e.g. `http://100.x.x.x:19900` |
| `peers[].name` | string | — | |
| `peers[].token` | string | — | Shared secret (`${MESH_TOKEN}`) |
| `discovery` | `static` \| `mdns` | `static` | |
| `healthCheck.interval` | number | `60` | seconds |
| `healthCheck.timeout` | number | `10` | |

## `session`

Controls Claude CLI `--resume` session reuse and the context-assembly strategy. See [Context strategies](/reference/context-strategies) for the full picture + bench results.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `staleMinutes` | number (1–1440) | `45` | Idle timeout for `--resume`. After this many minutes of no activity the session is dropped and the next turn starts fresh. Longer = better prompt-cache hit; shorter = less `--resume` replay bloat |
| `maxTurnsPerSession` | number (2–200) | `15` | Hard cap on turns per Claude CLI session. On hit, the next turn rotates. Prevents `--resume` replay growing unbounded across a long chat |
| `tierTwoThresholdTokens` | number (50 000–200 000) | `180000` | If the prior turn's total input (input + cacheRead + cacheCreate) crosses this, rotate before the next turn. Claude bills tier-2 at 1.5× above 200K; 180K leaves headroom |
| `contextStrategy` | `"layered"` \| `"planner"` | `"layered"` | Context assembly strategy. Per-task override via the `contextStrategy` field in `POST /task` or `AgentTask` |

```json
"session": {
  "staleMinutes": 45,
  "maxTurnsPerSession": 15,
  "tierTwoThresholdTokens": 180000,
  "contextStrategy": "layered"
}
```

## `notifications`

Daemon-wide defaults for long-task notifications.

| Field | Type | Default | |
|---|---|---|---|
| `longTaskThreshold` | number | `30` | seconds; `0` disables |
| `destination.channel` / `.chatId` / `.accountId` | string | — | |
| `on.taskComplete` / `on.taskError` / `on.taskQueued` | bool | `true`/`true`/`false` | |

## `business` (optional)

See [Journey 7 — Business layer](/journey/07-business-layer) for worked examples.

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `timezone` | string | `UTC` | |
| `mainChannel.channel` / `.chatId` / `.accountId` | string | — | Daily summary destination |
| `workSource.type` | `backlog` \| `gitlab` \| `wiki` | — | Task source |
| `workSource.path` | string | `.agentx/backlog.md` (for `backlog`) | |
| `workSource.projects` | string[] | `[]` (for `gitlab`) | Empty = all configured projects |
| `workSource.glob` | string | `**/*.md` (for `wiki`) | |
| `roles.<role>.title` | string | — | |
| `roles.<role>.responsibilities` | string[] | `[]` | |
| `roles.<role>.sopPath` | string | — | |
| `roles.<role>.kpis` | string[] | `[]` | |
| `orgChart.<agentId>.role` | string | — | |
| `orgChart.<agentId>.reportsTo` | string | — | |
| `orgChart.<agentId>.schedule.days` | day[] | mon–fri | |
| `orgChart.<agentId>.schedule.start` / `.end` | `HH:MM` | — | |
| `orgChart.<agentId>.schedule.lunch.start` / `.end` | `HH:MM` | — | Optional |
| `orgChart.<agentId>.utilizationTarget` | number (0–1) | `0.8` | |
| `workTickMinutes` | number | `15` | |
| `idleQueueThreshold` | number | `0` | Skip work-tick if queue depth exceeds this |

## Environment variables

| Variable | Purpose |
|---|---|
| `AGENTX_DEBUG` | Comma-separated debug categories (`webhook,cron,mesh,all`) |
| `MESH_TOKEN` | Shared secret between mesh peers (referenced as `${MESH_TOKEN}` in `agentx.json`) |
| `TG_*_BOT_TOKEN`, `DISCORD_*_TOKEN`, `GITLAB_*_TOKEN` | Convention for channel secrets referenced via `${…}` |

## Anonymized example

A full production-shaped config with tokens scrubbed lives at [`/examples/agentx.example.json`](/examples/agentx.example.json). Use it as a starting point for multi-agent, multi-channel, cron + business deployments.
