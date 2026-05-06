# Config schema

::: tip How to read this page
This page is the source of truth for every field in `agentx.json`. Most operators never edit it directly — the dashboard's Settings page covers the common changes. Use this when (a) the dashboard doesn't expose what you need yet, (b) you're version-controlling `agentx.json` and want to know what each field means, or (c) you're debugging a config validation error. Selected fields are annotated with a "When to change" line where the default isn't obvious.
:::

Every field in `agentx.json`. Source of truth: [`src/daemon/config.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/daemon/config.ts) and [`src/business/config.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/business/config.ts).

Environment variables are expanded inline: `${MY_TOKEN}` → `process.env.MY_TOKEN`. A `.env` file in the working directory is auto-loaded.

## Top-level shape

```json
{
  "node":          { "id": "...", "name": "...", "bind": "0.0.0.0:19900", "defaultAgent": "..." },
  "providers":     { "<provider>": { "apiKey": "", "defaultModel": "", "baseUrl": "" } },
  "agents":        { "<agentId>":  { ... } },
  "channels":      { "telegram": {...}, "whatsapp": {...}, "discord": {...}, "slack": {...}, "gitlab": {...}, "github": {...}, "webrtc": {...} },
  "crons":         { "<cronId>":   { ... } },
  "services":      { "<serviceId>":{ ... } },
  "session":       { "staleMinutes": 45, "maxTurnsPerSession": 15, "tierTwoThresholdTokens": 195000, "contextStrategy": "layered" },
  "notifications": { ... },
  "mesh":          { "enabled": false, "peers": [], ... },
  "boards":        [ { ... } ],
  "dashboard":     { "enabled": false, "port": 4202, ... },
  "graph":         { "enabled": false, ... },
  "workflows":     { "enabled": false, "dir": ".agentx/workflows", "editor": "edit" },
  "webhooks":      [ { "id": "...", "source": "gitlab", "agentId": "...", ... } ],
  "plugins":       [ "<npm-package-name>", ... ],
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
| `apiKey` | string | Used by API-backed tiers (`sdk`, `orchestrator`) |
| `defaultModel` | string | Model id if the agent doesn't specify one |
| `baseUrl` | string | Override endpoint (Ollama, proxies) |

## `agents.<id>`

| Field | Type | Default | Purpose |
|---|---|---|---|
| `name` | string | — | Display name |
| `workspace` | string | — | Directory with agent instructions, skills, MCP config |
| `tier` | `claude-code` \| `codex-cli` \| `sdk` \| `orchestrator` | `claude-code` | Execution strategy |
| `provider` | string | — | For `sdk`/`orchestrator`: which `providers[]` entry |
| `model` | string | — | Model id |
| `systemPrompt` | string | — | Inline override (normally lives in `CLAUDE.md`) |
| `mentions` | string[] | `[]` | `@handles` that route to this agent |
| `intents` | string[] | `[]` | **Phase 5 — typed capabilities.** Free-form list of intent strings this agent is allowed to handle. When set, the org-chart `canHandle` check rejects dispatches with intents not in this list. Empty/unset = permissive (handles any intent). Examples: `["issue.opened", "merge_request.opened"]`, `["cron.fired", "message.received"]`. **When to change:** set this to a comma-separated list when the agent should ONLY handle specific intents (e.g. `["issue.opened", "merge_request.opened"]` for a code-review agent that shouldn't pick up Telegram chitchat). Leave blank for permissive (default) |
| `maxDelegationDepth` | number (0–50) | `5` | **Phase 8 — capability-bounded security.** Max distinct upstream agents in the delegation chain on the same `(project, subject)` before a dispatch to this agent is refused. The ledger walker counts distinct agents across recent decisions on the subject. Set to 0 to disable for an agent that's always called as the bottom of a chain. **When to change:** lower this (e.g. 2) for agents at the bottom of a chain — prevents cascade loops where A → B → A. Default 5 is fine for most teams |
| `mcp` | `Record<string, McpServer>` | — | Per-agent MCP servers. Synced to `<workspace>/.mcp.json` at boot. Operator edits to `.mcp.json` are respected — see `agent-mcp.ts` |
| `contextStrategy` | `"layered"` \| `"planner"` | inherited from `session.contextStrategy` | Per-agent override of the global context-assembly strategy |
| `contextReferences` | bool | `false` | When true, the registry resolves references-recipes for this agent's workspace and renders a deterministic `[Verified References]` block at priority 4.7. Off by default — flip on per agent (e.g. `pm-ksi`, `devops-agent`) once a `references/` registry exists. **When to change:** turn on for agents that need stable, cited facts (PMs, devops) — surfaces a `[Verified References]` block in the prompt. Off by default because not every agent has a `references/` registry |
| `maxConcurrent` | number | `1` | Parallel turns allowed |
| `maxExecutionMinutes` | number (1–240) | `20` | Hard wall-clock cap on a single Claude Code invocation. Exceeding sends SIGTERM (exit 143). Bump for devops/coder agents that run long investigations or multi-file refactors |
| `permissionMode` | string | `default` | Claude Code permission mode (`default`, `acceptEdits`, `plan`, `bypassPermissions`) |
| `queueMode` | `collect` \| `followup` \| `drop` | `collect` | Behavior when messages arrive during a turn |
| `access` | `private` \| `public` | `private` | Reachability via the public API. `public` lets external apps `POST /api/public/agents/<id>/messages` with a scoped token (`agent:<id>` or `agent:*`) |
| `heartbeat.enabled` | bool | `false` | Enable periodic in-session check-ins |
| `heartbeat.intervalMinutes` | number | `30` | |
| `heartbeat.prompt` | string | stock prompt | |
| `heartbeat.channel` | string | `heartbeat` | Virtual channel tag |

### Execution tiers

| Tier | Backend | Continuity | Notes |
|---|---|---|---|
| `claude-code` | Claude Code CLI | `claudeSessionId`, optional persistent process | Best-supported tool-using path. Uses workspace `.claude/`, MCP, skills/hooks where present |
| `codex-cli` | Codex CLI | `codexSessionId` from Codex `thread_id` | Uses `codex exec` for fresh runs and `codex exec resume` for warm runs. AgentX sends a compact context budget to avoid prompt bloat |
| `sdk` | Anthropic Agent SDK | AgentX-rendered bounded history | API-key path for Anthropic Agent SDK; less native-session/usage metadata than CLI tiers today |
| `orchestrator` | AgentX `generate()` loop | AgentX-rendered bounded history | Provider-agnostic path for supported non-CLI providers |

Every tier goes through the same AgentX registry: routing, queueing, context assembly, `freshSession`, task history, traces, and final channel delivery are tier-independent. See [Agent execution tiers](/reference/tiers) for the detailed behavior contract and current implementation plan.

## `channels.telegram`

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `accounts.<name>.token` | string | — | Bot token (env expansion OK) |
| `accounts.<name>.agentBinding` | string | — | Agent id this bot speaks for |
| `accounts.<name>.allowFrom` | string[] | — | Per-account sender allowlist (overrides global) |
| `accounts.<name>.pollInbound` | bool | `true` | When false, daemon keeps the token registered for outbound but skips long-polling. Use on remote nodes where the bound agent lives elsewhere — otherwise two daemons race on the same `getUpdates` cursor |
| `policy.dm` | `pair` \| `block` | `pair` | DM policy |
| `policy.group` | `mention-required` \| `all` | `mention-required` | Group policy |
| `policy.allowFrom` | string[] | — | Global sender allowlist (user id, chat id, or `@username`). Closed by default — when neither global nor per-account is set, every inbound is dropped |

## `channels.whatsapp`

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `sessionDir` | string | `.agentx/whatsapp-sessions` | |
| `defaultAgent` | string | — | |
| `allowFrom` | string[] | — | Contact allowlist |
| `routes[].contact` / `.group` | string | — | Match |
| `routes[].agent` | string | — | Target agent |

## `channels.whatsapp.ingest`

Data-source ingestion — turns WhatsApp from a messaging-only channel into a source that seeds the wiki with contact/group metadata (and optionally bounded message windows) per an explicit allowlist. See [WhatsApp as a data source](/reference/whatsapp-ingest) for the full walkthrough.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `enabled` | bool | `false` | Master switch. Default-deny |
| `mode` | `"metadata-only"` \| `"messages"` | `"metadata-only"` | `metadata-only` pulls contact/group info; `messages` additionally pulls the last `messageCap` messages per allowlisted chat |
| `allowContacts` | string[] | `[]` | Phone numbers or JIDs, substring match (same semantics as `allowFrom`) |
| `allowGroups` | string[] | `[]` | Group JIDs, substring match |
| `denyContacts` | string[] | `[]` | Wins over allow |
| `denyGroups` | string[] | `[]` | Wins over allow |
| `messageCap` | number (1–500) | `50` | Per-chat message cap when `mode = "messages"` |
| `historyDays` | number (1–365) | `30` | Max age of messages to include in a window |
| `contactRefreshDays` | number (1–90) | `7` | Skip re-writing a contact entry unless this many days have passed and the profile hash differs |
| `throttle.minMsBetweenCalls` | number (≥100) | `1500` | Minimum spacing between live Baileys reads (ban-safety) |
| `throttle.maxCallsPerMinute` | number (≥1) | `20` | Per-minute cap on live reads |
| `throttle.maxChatsPerSweep` | number (≥1) | `25` | Per-sweep cap on targets (protects personal accounts) |
| `retentionDays` | number (≥0) | `0` | Purge absorbed raw entries older than this; `0` = never (phase 2) |

## `channels.discord` / `channels.slack`

| Field | Type | |
|---|---|---|
| `enabled` | bool | |
| `token` (Discord) / `botToken` + `appToken` (Slack) | string | Slack: `xoxb-…` bot token + `xapp-…` app-level token (Socket Mode) |
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
| `agentMappings[].node` | string | — | Mesh peer for a remote agent — forces username→agent resolution to this mapping |

## `channels.github`

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `token` | string | — | PAT (use `${GITHUB_TOKEN}`); `tokenFile` is an alternative — read first line at startup |
| `appId` / `clientId` / `privateKeyFile` | various | — | GitHub App auth (JWT issuer); `clientId` is preferred per GitHub's updated docs |
| `webhookSecret` | string | — | Validates `X-Hub-Signature-256` |
| `routes[].repo` / `.agent` | string | — | `"owner/repo"` or `"*"` for default |
| `agentMappings[].agentId` / `.githubUsernames` / `.token` / `.tokenFile` / `.node` | various | — | Per-agent identity, mesh routing |

## `channels.webrtc`

WebRTC voice/video calls between mesh peers. v1 ships transcribe-only bot participation.

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `stunServers` | string[] | `[stun:stun.l.google.com:19302]` | ICE STUN servers |
| `turnServers[]` | object | `[]` | TURN relays (required when both peers behind symmetric NAT). Fields: `urls`, `username`, `credential` |
| `allowedCallers` | string[] | `[]` (allow all peers) | Peer names permitted to initiate calls into this daemon |
| `ringNotify[]` | object | `[]` | Where to send "someone is calling" notifications. Same shape as `notifications.destination` |
| `callUrlBase` | string | `http://<node.bind>` | Base URL for tap-to-join links |
| `bot.enabled` | bool | `false` | AI bot joins via `?bot=<id>` query param |
| `bot.defaultAgentId` / `.whisperBackend` (`auto`/`mlx`/`openai`) / `.whisperModel` / `.whisperLanguage` / `.mlxBinary` / `.transcriptChannel` / `.maxCallMinutes` | various | various | Whisper transcription config |

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
| `maxOutputTokens` | number (50–8000) | — | Soft cap appended to the prompt — Claude Code CLI has no hard flag for this. 1500 for briefs, 500 for status pings, 300 for classifiers |
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
| `maxTurnsPerSession` | number (2–200) | `15` | Hard cap on turns per Claude CLI session. On hit, the next turn rotates. Prevents `--resume` replay growing unbounded across a long chat. **When to change:** lower (e.g. 8) if your agents accumulate context bloat across long Telegram threads; raise (e.g. 30) if rotations are losing too much context mid-task |
| `tierTwoThresholdTokens` | number (50 000–200 000) | `195000` | If the prior turn's total input (input + cacheRead + cacheCreate) crosses this, rotate before the next turn. Claude bills tier-2 at 1.5× above 200K; default leaves a 5K headroom. **When to change:** lower it (e.g. 150_000) if you're on the Anthropic Max plan and tier-2 surcharges are eating budget. Default 200_000 matches Anthropic's official threshold |
| `contextStrategy` | `"layered"` \| `"planner"` | `"layered"` | Context assembly strategy. Per-task override via the `contextStrategy` field in `POST /task` or `AgentTask` |
| `maxClaudeCodeDispatchesPerHour` | number | `80` | Soft dispatch budget for `claude-code`-tier agents (shared OAuth pools count across the fleet). Warns at 80% of the cap; short-circuits cold dispatches when exceeded — warm sessions always allowed. Sized for Max 5×; raise for Max 20× |
| `maxClaudeCodeDispatchesPer5h` | number | `180` | 5-hour rolling counterpart to the hourly budget |

```json
"session": {
  "staleMinutes": 45,
  "maxTurnsPerSession": 15,
  "tierTwoThresholdTokens": 195000,
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

## `boards`

Array of Kanban boards backed by a `WorkSource`. See [Boards & Kanban](/reference/boards) for the column model and label conventions.

| Field | Type | Default | |
|---|---|---|---|
| `boards[].id` | string (slug) | — | |
| `boards[].name` | string | — | Human label |
| `boards[].source.type` | `gitlab` (more later) | — | Discriminated union on source |
| `boards[].source.projects` | string[] | — | One or more GitLab project paths |
| `boards[].primaryToolLabel` | string | — | ANDed into every list query — shown as a baseline chip |
| `boards[].labels[]` | object | — | Manual label palette (`name`, `color` `#RRGGBB`, `description`) |
| `boards[].columns[]` | object[] | 6 default GitLab-style columns | See below |
| `boards[].timeRangeDays` | number (1–365) | `30` | Open-window time range |
| `boards[].closedWindowDays` | number (1–365) | `30` | Closed-column window |
| `boards[].reconciliation.enabled` | bool | `true` | Stale-Doing reconciler |
| `boards[].reconciliation.staleDoingMinutes` | number | `45` | |
| `boards[].reconciliation.respectLunchBreak` / `.respectSchedule` | bool | `true` | |
| `boards[].reconciliation.action` | `badge` \| `notify` | `badge` | |

**Default columns** (when `columns[]` is unset): Open / To Do / Doing / On Hold / Review / Closed, driving the `Status::*` scoped-label taxonomy.

Column kinds:
- `open-backlog` — opened issues with no label matching `scopedPrefix`. Dragging in strips scoped labels.
- `scoped-label` — opened issues carrying `scopedLabel` (e.g. `Status::Doing`). Mutually exclusive by prefix.
- `closed` — all closed issues. Dragging in closes; dragging away reopens.
- `label` (legacy) — opened issues with `mapsToLabel`; flat add/remove.

## `dashboard`

The Kanban dashboard / board UI HTTP server. Off by default; turn on per machine.

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `port` | number | `4202` | |
| `bind` | string | `127.0.0.1` | Use `0.0.0.0` to expose to other machines (or bind to a Tailscale interface) |
| `token` | string | — | Optional bearer for writes. If unset, writes are unauthenticated (local-only acceptable) |
| `daemonUrl` | string | `http://localhost:18800` | Primary daemon for live view + A2A |
| `daemons[]` | object | `[]` | Additional daemons to poll. Each: `name`, `url`, optional `dashboardUrl` (auto-derived from `url` with port 18800/19900 → 4202), `token`, `dashboardToken` |
| `draftAgent` | string | — | Default agent for AI-assisted drafting in the create-issue flow |

## `graph` (intent knowledge)

Per-message intent classification into a fixed-axis taxonomy. See [Intent graph](/reference/graph).

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `baseDir` | string | `.agentx/graph` | Where schema/nodes/classifications live |
| `draftAgent` | string | — | Agent that proposes classifications |
| `reviewAgent` | string | — | Agent used by `agentx graph review`. Should have the wiki skill so it can call `wiki query` for context |
| `autoApproveStructure` | `strict` \| `extend-leaves` \| `any` | `extend-leaves` | Structural auto-approval policy. **When to change:** leave at default (`extend-leaves`) until you trust the classifier. Set to `any` only if you want zero review (not recommended); set to `strict` if you want to manually approve every label |
| `autoApproveConfidence` | number (0–1) | `1.0` | Min classifier confidence to auto-approve. OR'd with `autoApproveStructure` |
| `retrievalWeights.graph` / `.bm25` | number | `0.6` / `0.4` | Hybrid wiki-retrieval score weights (sum need not be 1) |

## `workflows`

Declarative state machines. See [Workflows](/reference/workflows).

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `dir` | string | `.agentx/workflows` | Where definitions live (one JSON or YAML file per workflow) |
| `editor` | `disabled` \| `readonly` \| `edit` | `edit` | Whether the dashboard exposes the visual editor (and at what level) |
| `matching.enabled` | bool | `false` | Enables the workflow matcher seam before free-form agent execution |
| `matching.mode` | `suggest` \| `auto` | `suggest` | `suggest` logs candidate workflows; `auto` is reserved for dispatcher-backed auto-run and currently falls back |
| `matching.autoRunThreshold` | number (0–1) | `0.85` | Confidence target for future auto-run |
| `matching.suggestThreshold` | number (0–1) | `0.65` | Minimum confidence to log a workflow suggestion |

Workflow definitions also accept generated-workflow metadata: `status` (`draft`, `review`, `active`, `deprecated`), `tags`, `entity`, `intentPath`, `generatedFrom`, `sourceTaskIds`, `confidence`, `workflowVersion`, `ownerAgent`, `lastMatchedAt`, and `matchCount`. Generated drafts are written with `status: draft` and `state: disabled`.

## `webhooks[]`

Inbound webhook inventory the dashboard manages. The actual URL is always `POST /webhook/<agentId>/<source>`.

| Field | Type | Default | |
|---|---|---|---|
| `id` | string (slug) | — | |
| `source` | `gitlab` \| `github` \| `sentry` \| `stripe` \| `discord` \| `slack` \| `custom` | — | |
| `agentId` | string | — | |
| `secretEnv` | string | — | Env var holding the signing secret |
| `description` | string | — | |
| `enabled` | bool | `true` | |
| `node` | string | — | Route to a mesh peer instead of local execution |
| `triggers` | `Record<event-type, workflowId>` | — | Per-event-type workflow routing. E.g. `"issues.opened": "triage-bug"` (GitHub), `"Note Hook": "review-comment"` (GitLab) |
| `defaultWorkflow` | string | — | Workflow used when no `triggers` entry matches (backward-compatible fallback) |

## `plugins[]`

Array of installed npm package names. The loader does dynamic `import(name)` at boot, validates the manifest, and calls `plugin.setup(ctx)`. See [`docs/architecture/plugins.md`](/architecture/plugins) (when surfaced) for the contract.

```json
"plugins": ["agentx-plugin-mattermost", "@noqta/plugin-mattermost"]
```

Plugins can register channel adapters via `ctx.addChannel()` and subscribe to bus events via `ctx.on()`.

## Process-pool eviction

When any agent has `persistentProcess: true`, the daemon keeps a warm Claude subprocess per `(agent, channel, chatId)`. The pool is bounded by these knobs:

```jsonc
"processPool": {
  "maxIdleSeconds": 30,         // eligibility for cap-pressured eviction (LRU)
  "maxAgeSeconds": 2700,        // unconditional kill on next sweep (45min default)
  "sweepIntervalSeconds": 5     // how often the sweeper checks
}
```

Increase `maxAgeSeconds` for chat workloads where the same conversation legitimately spans hours; decrease it (e.g. 1800) to eject any pool slot that's been idle longer than 30 minutes — useful when a triage→worker pattern would otherwise inherit stale visitor context. See [Persistent processes](./cli#persistent-processes-production-recipe) for the full operator recipe.

## Actions registry (separate files)

Actions do **not** live in `agentx.json`. Each action is its own file at `.agentx/actions/<id>.json`. Schema (Zod, `src/actions/types.ts`):

```jsonc
{
  "id": "hubspot-create-contact",          // ^[a-z][a-z0-9_-]*$
  "title": "Create HubSpot contact",
  "description": "Pushes a contact into HubSpot CRM",
  "kind": "http",                          // "shell" | "http"
  "url": "https://api.hubapi.com/crm/v3/objects/contacts",
  "method": "POST",                        // GET | POST | PUT | PATCH | DELETE
  "headers": { "Authorization": "Bearer ${HUBSPOT_TOKEN}" },
  "body": "{\"properties\":{\"email\":\"{{email}}\"}}",
  "inputs": [
    { "name": "email", "type": "string", "required": true, "description": "Contact's primary email" }
  ],
  "timeoutMs": 30000                       // 100..600000
}
```

`kind: shell` swaps the URL/method/headers/body fields for `command`, `cwd`, and an optional `env: { KEY: "value" }` map. Templates (`{{name}}`, `${ENV_VAR}`) work everywhere. See the [Actions reference](./actions) for the integration cookbook.

## `business` (optional)

See [Journey 7 — Business layer](/journey/07-business-layer) for worked examples.

| Field | Type | Default | |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `timezone` | string | `UTC` | |
| `mainChannel.channel` / `.chatId` / `.accountId` | string | — | Daily summary destination |
| `workSource` | discriminated union | — | See below |
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
| `projects[]` | object | `[]` | **Phase 3.** Per-project metadata. `projects[].id` ("owner/repo" for source-linked, free string otherwise) and `projects[].pm` (agentId responsible for gating dispatches on this project) |
| `workTickMinutes` | number | `15` | |
| `idleQueueThreshold` | number | `0` | Skip work-tick if queue depth exceeds this |

### `business.workSource`

Discriminated union on `type`:

| `type` | Required fields | Notes |
|---|---|---|
| `backlog` | `path` (default `.agentx/backlog.md`) | Reads from `.agentx/backlog.json` (canonical) when present, else parses the legacy GFM checklist at `path`. Items can be imported from gitlab/github via `agentx backlog import` and mutations sync upstream. See `agentx backlog` |
| `gitlab` | `projects: string[]` (default `[]` = all configured `channels.gitlab.routes` projects) | The work-pool ticks GitLab issues assigned to each agent's mapped username. Closed/done items leave the pool |
| `wiki` | `path`, `glob` (default `**/*.md`) | Scans markdown files for `- [ ] @agent task` checkboxes |

## Governance flags (Phase 3 / 8)

The architectural rescue introduces governance hooks driven by env vars at startup. These are read once when the daemon boots; flipping a flag requires a restart.

| Flag | Effect |
|---|---|
| `INTENT_LEDGER_MODE` | `off` (default before activation) — no ledger writes. `shadow` — ledger records every dispatch decision in parallel with the legacy router; divergences are tracked, not enforced. `authoritative` — ledger is the source of truth, legacy router becomes the divergence reporter |
| `INTENT_PM_GATE_ENABLED` | When `true` AND `business.enabled = true`, project-scoped events flow through the org-chart PM (`business.projects[].pm`) before reaching agents. Combined with `agents[].intents` (Phase 5) and `agents[].maxDelegationDepth` (Phase 8) for layered admission control |

The Phase 7 reproducibility check (`agentx ledger replay`) can be run any time the ledger has events — it spins up a fresh tmp ledger, replays the source events, and reports any divergences in dispatch decisions.

## Environment variables

See the [CLI reference env-var table](/reference/cli#environment-variables) for the full list (~14 entries: provider creds, runtime overrides, governance flags, channel-token conventions).

## Anonymized example

A full production-shaped config with tokens scrubbed lives at [`/examples/agentx.example.json`](/examples/agentx.example.json). Use it as a starting point for multi-agent, multi-channel, cron + business deployments.
