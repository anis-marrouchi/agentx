# Configuration: agents and runtime

This page lists every setting in `agentx.json` for the machine (`node`), model providers, agents, conversation sessions, warm processes and plugins. For the other sections and how to edit the file, see the [Configuration reference](./config.md).

In the tables, "required" means the setting has no default and must be set. "—" means it is unset unless you set it. Paths with `<id>` stand for a name you choose, such as an agent id.

## node

The machine this daemon runs on.

| Key | Type | Default | What it does |
|---|---|---|---|
| `node.id` | string | required | Stable id of this machine. Used to label workflow runs and as this node's name on the mesh. |
| `node.name` | string | required | Readable name of this machine, shown in logs and mesh listings. |
| `node.bind` | string | `"127.0.0.1:18800"` | Address and port the daemon API listens on. |
| `node.defaultAgent` | string | — | Agent used by voice and API calls that do not name one. |

## providers

API credentials for agents that call a model directly (the `sdk` and `orchestrator` engines). Keyed by provider name, for example `providers.claude`.

| Key (under `providers.<name>`) | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | string | — | API key for this provider. Use an `${ENV_VAR}` reference rather than the key itself. An `sdk` agent without a key fails with `No API key for provider`. |
| `defaultModel` | string | — | Accepted by the validator but not read by the current runtime. Set `model` on the agent instead. |
| `baseUrl` | string | — | Accepted by the validator but not read by the current runtime. |
| `thinking` | boolean | — | Turns thinking-mode output on or off for `orchestrator` agents on backends that support it. Ignored elsewhere. |

```json
"providers": {
  "claude": { "apiKey": "${ANTHROPIC_API_KEY}" }
}
```

## agents

One entry per agent, keyed by agent id (`agents.<id>`).

| Key (under `agents.<id>`) | Type | Default | What it does |
|---|---|---|---|
| `name` | string | required | Display name of the agent. |
| `workspace` | string | required | Folder the agent works in. |
| `tier` | `"claude-code"` \| `"codex-cli"` \| `"opencode"` \| `"sdk"` \| `"orchestrator"` | `"claude-code"` | Engine that runs the agent: a provider CLI, a direct API call (`sdk`), or AgentX's own tool loop (`orchestrator`). |
| `provider` | string | — | Provider name in `providers` for `sdk` (default `claude`) and `orchestrator` (default `claude-code`) agents. |
| `model` | string | — | Model id passed to the engine. Unset uses the engine's default. |
| `systemPrompt` | string | — | Extra instructions added to every run of this agent. |
| `mentions` | list of string | `[]` | Names that route a message to this agent, such as `@helper`. |
| `intents` | list of string | `[]` | Intents this agent may handle, such as `issue.opened`. Empty allows any intent. |
| `maxDelegationDepth` | number (0–50) | `5` | Refuses a hand-off to this agent when that many other agents already worked on the same item in a chain. `0` turns the check off. |
| `mcp` | map of object | — | MCP tool servers for this agent, by name. Written to the workspace's `.mcp.json` when the daemon starts; your own edits to that file are kept. See the table below. |
| `codegraph` | boolean | `false` | Adds the CodeGraph code index to the agent's workspace (tool server, permissions and instructions) and indexes the workspace in the background. For coding agents. |
| `contextStrategy` | `"layered"` \| `"planner"` | — | Overrides `session.contextStrategy` for this agent. |
| `contextReferences` | boolean | `false` | Adds a checked list of references from the workspace's `references/` registry to the agent's context. |
| `richMessages` | boolean | `true` | Lets the agent send buttons, polls and media on chat channels, and also quick replies in the [phone app](../dashboard/mobile-chat.md), including replies relayed by mesh delegation or `/send`. `false` sends plain text only: no buttons, polls, media or quick replies, and on the phone no pictures inside answers (they show as links) and no files (their names show as text). Speech is not affected. |
| `maxConcurrent` | number | `1` | How many runs of this agent can happen at the same time. |
| `maxExecutionMinutes` | number (1–240) | `20` | Time limit for one run; the process is stopped when it passes. |
| `preSpawnTimeoutSec` | number (10–3600) | `300` | Time a run may spend getting ready before its agent process starts. When it passes, the run is stopped, its slot is freed and its record is marked `timeout` with the step it was stuck on. Applies to every run, whatever started it. See [Time limits and cancel](./config.md#time-limits-and-cancel). |
| `drainTimeoutSeconds` | number (0–86400) | — | How long a daemon stop waits for this agent's running tasks, when that is longer than `shutdown.drainTimeoutSeconds`. For agents whose tasks take long, such as renders. See [change how long it waits](/jobs/restart-safely#change-how-long-it-waits). |
| `permissionMode` | string | `"default"` | Permission mode for the agent's CLI. `bypassPermissions` lets it act without asking. |
| `billing` | `"subscription"` \| `"api"` | `"subscription"` | For `claude-code` agents: use the shared sign-in (`subscription`) or bill `ANTHROPIC_API_KEY` (`api`). An `api` agent with no key fails its run. |
| `toolUseRequired` | list of string | `[]` | Tool names, such as `Write`, of which at least one must be used in a run; otherwise the run fails with `tool_required_not_called`. |
| `gitlabAutoReply` | boolean | — | For this agent, overrides the GitLab or GitHub channel's `autoReplyLegacy`: `true` posts the agent's final answer as a comment, `false` does not. |
| `persistentProcess` | boolean | `false` | Keeps a warm process per conversation for `claude-code`, `codex-cli` and `opencode` agents so replies start faster. |
| `queueMode` | `"collect"` \| `"followup"` \| `"drop"` | `"collect"` | What happens to messages that arrive while the agent is busy: batch them into one turn, run each as its own turn afterwards, or discard them. A held message that waited more than a minute starts with a one-line note giving the time it arrived and the time it runs, so the agent checks again anything that may have changed meanwhile. A busy agent on another node is not an error either: the thread gets no ❌ and no failure comment, and the reply comes when the message runs. |
| `access` | `"private"` \| `"public"` | `"private"` | `public` lets outside apps message the agent through the public API with a scoped token. |
| `admin` | boolean | — | Lets the agent pause, resume and request deletion of schedules created by others. Approval stays with the operator. |
| `subscriptions` | list of object | `[]` | Events this agent follows, and whether it reads them itself (`pull`), gets a short list when it starts fresh (`digest`) or is started by them (`wake`). Each entry has `kinds`, `agents`, `nodes`, `match`, `delivery` and `maxPerHour`. See [Let agents follow events](/automations/event-subscriptions). |
| `heartbeat.enabled` | boolean | `false` | Runs a periodic check-in inside the agent's ongoing session. |
| `heartbeat.intervalMinutes` | number | `30` | Minutes between check-ins. |
| `heartbeat.prompt` | string | `"Check inbox, pending tasks, and system health. Report anything that needs attention."` | What the agent is asked at each check-in. |
| `heartbeat.channel` | string | `"heartbeat"` | Channel name the check-in runs under. |
| `integrations` | list of object | `[]` | Services this agent has credentials for. See the table below. |
| `voice` | object | — | How the agent sounds. See the table below. |
| `presence` | object | — | How the agent's on-screen cursor looks. See the table below. |

```json
"agents": {
  "helper": {
    "name": "Helper",
    "workspace": "./workspaces/helper",
    "tier": "claude-code",
    "mentions": ["@helper"],
    "maxConcurrent": 2,
    "heartbeat": { "enabled": true, "intervalMinutes": 60 }
  }
}
```

### MCP servers

Each entry under `agents.<id>.mcp.<name>` is either a local command or an HTTP server.

| Key | Type | Default | What it does |
|---|---|---|---|
| `type` | `"stdio"` \| `"http"` | `"stdio"` | Kind of server. Leave it out for a local command. |
| `command` | string | required for `stdio` | Program to start. |
| `args` | list of string | `[]` | Arguments for `command`. |
| `env` | map of string | — | Environment variables for `command`. |
| `url` | string | required for `http` | Address of the HTTP server. |
| `headers` | map of string | — | HTTP headers sent to the server. |

### Integrations

Each item in `agents.<id>.integrations` declares one service. Secrets never go in `agentx.json`: credentials name an environment variable (uppercase, such as `HELPER_CRM_TOKEN`) or the system keyring.

| Key | Type | Default | What it does |
|---|---|---|---|
| `kind` | string | required | Service, such as `telegram-bot`, `gitlab-user`, `gmail`, `hubspot` or `custom`. `agentx doctor` warns on unknown kinds. |
| `label` | string | required | Readable name, unique per agent and kind. |
| `credentials` | object | `{}` | Where the secret lives. Only the keys below are accepted. |
| `credentials.tokenEnv` | string | — | Environment variable holding the main token. |
| `credentials.privateAppTokenEnv` | string | — | Environment variable for a private app token. |
| `credentials.apiKeyEnv` | string | — | Environment variable for an API key. |
| `credentials.refreshTokenEnv` | string | — | Environment variable for an OAuth refresh token. |
| `credentials.clientIdEnv` | string | — | Environment variable for an OAuth client id. |
| `credentials.clientSecretEnv` | string | — | Environment variable for an OAuth client secret. |
| `credentials.auth` | `"keyring"` | — | The credential is in the system keyring instead of an environment variable. |
| `credentials.sessionDir` | string | — | Folder holding a login session, for services such as WhatsApp. |
| `metadata` | map of string, number or boolean | `{}` | Non-secret details (username, host, account id), shown in the dashboard and to skills. |
| `enabled` | boolean | `true` | Turns the integration off without removing it. |

### Voice

`agents.<id>.voice` overrides the global `voice` settings for one agent ([desktop assistant](/dashboard/voice)).

| Key | Type | Default | What it does |
|---|---|---|---|
| `voice.provider` | `"system"` \| `"elevenlabs"` | — | Speech engine for this agent. Unset uses the global `voice.provider`. |
| `voice.system` | string \| map of string | — | macOS voice name, `system` for the OS default, or one voice per language such as `{ "en": "Samantha" }`. Unset picks a free voice. |
| `voice.elevenlabsVoiceId` | string | — | ElevenLabs voice id. |
| `voice.gender` | `"female"` \| `"male"` \| `"neutral"` | — | Guides which voice is picked when none is set. |
| `voice.style` | string | — | A few words on manner, such as "warm, calm". |
| `voice.intro` | string | — | One-line self-introduction used on first contact. |
| `voice.narrate` | `"off"` \| `"on"` \| `"all"` | — | Speaks short updates while the agent works: `on` for all but scheduled jobs, `all` includes them. |

### Presence

`agents.<id>.presence` sets the agent's own cursor, drawn by the Mac helper.

| Key | Type | Default | What it does |
|---|---|---|---|
| `presence.color` | string (`#RRGGBB`) | from the agent id | Cursor colour. |
| `presence.initial` | string (up to 2 letters) | from the name | Letters on the cursor. |
| `presence.label` | string | the agent's name | Name shown under the cursor. |
| `presence.allowActions` | boolean | — | Lets the agent click and type for you. Without it, "act" falls back to "teach". |

## session

When a conversation's memory is rotated or treated as stale.

| Key | Type | Default | What it does |
|---|---|---|---|
| `session.staleMinutes` | number (1–1440) | `720` | Minutes of silence after which a conversation starts fresh. |
| `session.maxTurnsPerSession` | number (2–200) | `40` | Turns after which the conversation is rotated to a new session. |
| `session.tierTwoThresholdTokens` | number (50000–200000) | `180000` | Context size, in tokens, at which the conversation is rotated. |
| `session.contextStrategy` | `"layered"` \| `"planner"` | `"layered"` | How context is built: all layers every turn, or a small model picks what to retrieve first. |
| `session.maxClaudeCodeDispatchesPerHour` | number (1–10000) | `80` | Soft hourly cap on new `claude-code` runs across the machine. Warm sessions still go through. |
| `session.maxClaudeCodeDispatchesPer5h` | number (1–50000) | `180` | The same cap over five hours. |
| `session.continuityStateTurns` | number (0–5) | `0` | Extra earlier requests shown to the session-continuity decision. `0` keeps the default two messages. |

## processPool

How long warm `claude-code` processes (`persistentProcess`) are kept. Codex and OpenCode use fixed limits.

| Key | Type | Default | What it does |
|---|---|---|---|
| `processPool.maxIdleSeconds` | number (5–86400) | `30` | Seconds after its last turn when a process may be stopped to make room. |
| `processPool.maxAgeSeconds` | number (60–86400) | `2700` | Seconds of idleness after which a process is always stopped. |
| `processPool.sweepIntervalSeconds` | number (1–300) | `5` | How often the pool is checked. |

## plugins

| Key | Type | Default | What it does |
|---|---|---|---|
| `plugins` | list of string | `[]` | Installed npm package names loaded as plugins when the daemon starts. |

## Check it worked

1. **Terminal:** in the folder with `agentx.json`, run `agentx config check`. It prints `✓ Config valid`.
2. **Terminal:** run `agentx config get agents.helper.maxConcurrent`, using your own agent id. It prints the value you set.
3. **Terminal:** run `agentx agent list`. The agent appears with its engine and model.

## If something is wrong

- **`config check` names a field:** the value has the wrong type or is out of range. Compare it with the table above.
- **An `sdk` agent fails with `No API key for provider`:** set `providers.<name>.apiKey`, or check that the environment variable it points to is in `.env`.
- **A model or engine change is ignored:** restart the daemon fully with `agentx daemon stop`, then `agentx daemon start --detach`.
