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
| `mentions` | list of string | `[]` | Names that route a message to this agent, such as `@helper`. Spoken questions match them too, without the `@`, so this is also where spoken aliases go: add a spelling speech to text often writes for the agent's name. See [Spoken aliases](../guides/agentx-voice.md#spoken-aliases). |
| `intents` | list of string | `[]` | Intents this agent may handle, such as `issue.opened`. Empty allows any intent. |
| `maxDelegationDepth` | number (0–50) | `5` | Refuses a hand-off to this agent when that many other agents already worked on the same item in a chain. `0` turns the check off. |
| `mcp` | map of object | — | MCP tool servers for this agent, by name. Written to the workspace's `.mcp.json` when the daemon starts; your own edits to that file are kept. See the table below. |
| `codegraph` | boolean | `false` | Adds the CodeGraph code index to the agent's workspace (tool server, permissions and instructions) and indexes the workspace in the background. For coding agents. |
| `contextStrategy` | `"layered"` \| `"planner"` | — | Overrides `session.contextStrategy` for this agent. |
| `contextReferences` | boolean | `false` | Adds a checked list of references from the workspace's `references/` registry to the agent's context. |
| `richMessages` | boolean | `true` | Lets the agent send buttons, polls and media on chat channels, and also quick replies in the [phone app](../dashboard/mobile-chat.md), including replies relayed by mesh delegation or `/send`. `false` sends plain text only: no buttons, polls, media or quick replies, and on the phone no pictures inside answers (they show as links) and no files (their names show as text). Speech is not affected. |
| `maxConcurrent` | number | `1` | How many runs of this agent can happen at the same time. |
| `maxExecutionMinutes` | number (1–240) | `20` | Time limit for one run; the process is stopped when it passes. |
| `preSpawnTimeoutSec` | number (10–3600) | `300` | Time a run may spend getting ready before its agent process starts. Each preparation step also has a short limit of its own (5 to 30 seconds); a step that runs past it is skipped and the run goes on without it. When the whole time passes anyway, the run is stopped, its slot is freed, its record is marked `timeout` with the step it was stuck on, and the message is tried once more from the start; if that stalls too, the sender is told in plain words to send it again. Applies to every run, whatever started it. See [Time limits and cancel](./config.md#time-limits-and-cancel). |
| `drainTimeoutSeconds` | number (0–86400) | — | How long a daemon stop waits for this agent's running tasks, when that is longer than `shutdown.drainTimeoutSeconds`. For agents whose tasks take long, such as renders. See [change how long it waits](/jobs/restart-safely#change-how-long-it-waits). |
| `permissionMode` | string | `"default"` | Permission mode for the agent's CLI. The agent runs with nobody to answer, so no step comes to you: in `default`, `acceptEdits` and `plan` a step that needs permission is refused, and `bypassPermissions` lets it act without asking. See [What always waits for you](/jobs/keep-it-safe#what-always-waits-for-you). |
| `billing` | `"subscription"` \| `"api"` | `"subscription"` | For `claude-code` agents: use the shared sign-in (`subscription`) or bill `ANTHROPIC_API_KEY` (`api`). An `api` agent with no key fails its run. Use `api` for every agent that other people reach, such as the agent of a [guest grant](/jobs/guest-mesh#host-bill-the-guest-s-turns-to-your-api-key). |
| `cloudSessions.enabled` | boolean | `false` | Sends this `claude-code` agent's GitHub issue and pull request tasks to Claude cloud sessions (`claude --cloud`) instead of running them here; the result is a pull request. Needs `channels.github.cloudSessions` too, and a clone of the repository on this computer. A launch that fails runs locally. See [Send coding tasks to Claude cloud sessions](/jobs/cloud-sessions). |
| `cloudSessions.maxPerDay` | number | `0` | Most cloud sessions this agent may start per day; `0` means no limit. Past it, tasks run locally. |
| `cloudSessions.openHours` | number (1–168) | `24` | How long a started session counts as open: no local run starts for its issue, and comments on the issue are forwarded to it. |
| `cloudSessions.launchTimeoutSeconds` | number (10–600) | `120` | How long `claude --cloud` may take to print the session id before the launch is given up and the task runs locally. |
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

### Instructions AgentX adds for coding agents

A `claude-code` or `codex-cli` agent gets two short rules in its system prompt, on top of its own `systemPrompt`. There is no setting for them.

| Rule | Engines | Why |
|---|---|---|
| Read the code before trusting an issue thread or earlier comments. | `claude-code`, `codex-cli` | Threads can hold wrong guesses; the code is the source of truth. |
| Change files with the Edit tool, not with `sed`, `awk` or a shell rewrite. | `claude-code` | A multi-line `sed` that misses leaves the file broken and costs extra rounds with the model. In a test on a bug fix across six files, runs that needed extra rounds fell from 7 in 20 to 0 in 20, and tokens fell 13 percent. Edits spell out the old and new text, so the cost per run rose about 4 percent. |

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

`agents.<id>.voice` overrides the global `voice` settings for one agent ([AgentX Voice](/dashboard/voice)).

| Key | Type | Default | What it does |
|---|---|---|---|
| `voice.provider` | `"system"` \| `"elevenlabs"` | — | Speech engine for this agent. Unset uses the global `voice.provider`. |
| `voice.system` | string \| map of string | — | macOS voice name, `system` for the OS default, or one voice per language such as `{ "en": "Samantha" }`. Unset picks a free voice. |
| `voice.fallbacks` | string[] | — | Voices to try in order when `voice.system` is not installed. Unset picks the best installed voice of the same language and gender. |
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

## people

The humans who talk to your agents, one entry per person. A task started by a listed person is stamped with their `id` on every channel. Empty by default: your own machine's surfaces are recorded as the built-in person `owner` and other senders are unknown. Steps and examples: [Tell agents who is who](../jobs/people.md).

```json
"people": [
  { "id": "anis", "name": "Anis", "role": "owner", "identities": ["telegram:123456789", "github:your-login"] },
  { "id": "sara", "name": "Sara", "identities": ["gitlab:sara.b", "whatsapp:21620123456"] }
]
```

| Key | Type | Default | What it does |
|---|---|---|---|
| `people[].id` | string | required | Short name you choose: lower-case letters, digits, `-` and `_`, up to 40 characters. Each id appears once. `owner` is kept for a person with the owner role. |
| `people[].name` | string | required | The person's name, for you to read. |
| `people[].say` | string | — | How the person's name is said aloud, for example `"Shiv-awn Oh-kah-for"` for "Siobhan Okafor". Only speech changes; the written name stays. With as many words as the name, each name word written with its capital is covered too. See [Say a word the way it is said](../guides/agentx-voice.md#say-a-word-the-way-it-is-said). |
| `people[].role` | `owner`, `member`, `client` or `guest` | `member` | A single `owner` is also the person at this machine's own surfaces (voice, phone app, dashboard), and their turns on other channels count as yours for `requests`. A `client` (someone you do work for) opens **Your project** on a paired machine instead of a teammate's **My work** ([Give a client a page of their own](../jobs/clients.md)). `guest` is a label for another organisation's operator. |
| `people[].identities` | list of strings | `[]` | Where the person writes from, each as `channel:id`: a GitLab or GitHub login, a Telegram id or username, a WhatsApp number. Display names are not matched. An identity belongs to one person only. |
| `people[].agents` | list of strings | `[]` | The agents this person may reach, by id. Empty: every agent. A message to any other agent, on this node or on another, is answered with a note and no run starts. The limit follows the person's work through delegations. Ignored for an `owner`. |
| `people[].deny.tools` | list of strings | `[]` | Tools this person's work may not use, such as `Bash`, `WebFetch` or `mcp__mail__*`. Names match without case; `*` is a wildcard. Every tool call of their runs is checked, and a denied one is blocked. Needs a `claude-code` agent; another tier refuses their messages. Follows delegations. Ignored for an `owner`. |
| `people[].deny.skills` | list of strings | `[]` | Skills this person's work may not load, by name. A denied skill is not offered to the agent for their messages, and loading it is blocked. Same rules as `deny.tools`. |

## `members`

Teammates' and clients' machines paired to their own page ([Invite a teammate to their work page](/jobs/members), [Give a client a page of their own](/jobs/clients)).

| Setting | Type | Default | What it does |
|---|---|---|---|
| `members.logRetentionDays` | number | `90` | Days the per-person trail in `.agentx/members-log.jsonl` (invites, pairings, approvals, refusals, sign-ins, removals, messages to an agent the person may not reach) is kept. Older lines are dropped, at most once an hour, when a new line is written. 1 to 3650. |

## session

When a conversation's memory is rotated or treated as stale.

| Key | Type | Default | What it does |
|---|---|---|---|
| `session.staleMinutes` | number (1–1440) | `720` | Minutes of silence after which a conversation starts fresh. |
| `session.maxTurnsPerSession` | number (2–200) | `40` | Turns after which the conversation is rotated to a new session. |
| `session.tierTwoThresholdTokens` | number (50000–200000) | `180000` | Context size, in tokens, at which the conversation is rotated. |
| `session.tierTwoThresholdTokensByChannel` | object of channel → number (50000–200000) | `{}` | Overrides the context rotation limit for selected channels, for example `{"voice": 60000, "github": 80000}`. Other channels use the global limit. Applies to native Claude, Codex and OpenCode sessions; existing history seeds the next session. Requires a daemon restart. |
| `session.contextStrategy` | `"layered"` \| `"planner"` | `"layered"` | How context is built: all layers every turn, or a small model picks what to retrieve first. |
| `session.maxClaudeCodeDispatchesPerHour` | number (0–10000) | unset (off) | Optional local ceiling on new `claude-code` runs across the machine in one hour. The plan's own limit is read from Claude Code and needs no setting. Warm sessions still go through. Applies on save. |
| `session.maxClaudeCodeDispatchesPer5h` | number (0–50000) | unset (off) | The same optional ceiling over five hours. |
| `session.continuityStateTurns` | number (0–5) | `0` | Extra earlier requests shown to the session-continuity decision. `0` keeps the default two messages. |
| `session.profileByChannel` | object of channel → `"full"` \| `"lean"` | `{}` | How much a session is given when it starts, per channel. A channel you do not list keeps the built-in default: `github`, `a2a`, `workflow` and `cron` are `lean`, every other channel is `full`. See [Lean sessions](#lean-sessions). |
| `session.lean.mcpServers` | list of string | `["agentx"]` | Tool servers from the workspace's `.mcp.json` that a lean session keeps, by name. `agentx` is always kept. |
| `session.lean.settingSources` | list of `"user"` \| `"project"` \| `"local"` | `["project", "local"]` | Which Claude Code settings a lean session reads. Without `user`, the global `CLAUDE.md`, user skills, plugins and user-level tool servers stay out. `project` is the agent's workspace. |
| `session.lean.contextOnDemand` | boolean | `true` | Leave the agent landscape, the chat history and the cross-chat context out of the prompt, and name the tools that fetch them instead. `false` pushes them as a full session does. |
| `session.lean.tools` | list of string | `[]` | Built-in Claude Code tools a lean session gets, such as `Bash`, `Read`, `Edit`. Empty keeps every built-in tool. A short list is what brings a lean start under 20k tokens; an agent that lacks a tool it needs fails mid-task. The `agentx` tools are not affected. `claude-code` agents only. See [Fewer built-in tools](#fewer-built-in-tools). |
| `session.lean.toolsByChannel` | object of channel → list of string | `{}` | The same list per channel. A channel's own list wins over `session.lean.tools`; an empty list falls back to it. |
| `session.lean.agentxTools` | list of string | `[]` | The `agentx_` tools a lean session is told about, such as `agentx_channel_reply`. Empty lists every `agentx` tool. Saves little while `ToolSearch` is on. A name that is not an `agentx` tool fails `agentx config check`. `agentx_approval`, `agentx_request`, `agentx_events` and `agentx_attach_next` are always kept, and so are `agentx_agents`, `agentx_recent` and `agentx_wiki_query` while `session.lean.contextOnDemand` is on. `claude-code` agents only. See [Fewer agentx tools](#fewer-agentx-tools). |
| `session.lean.agentxToolsByChannel` | object of channel → list of string | `{}` | The same list per channel. A channel's own list wins over `session.lean.agentxTools`; an empty list falls back to it. |
| `session.triage.models.claude-code` | string | unset (off) | A cheaper Claude model, such as `claude-haiku-4-5-20251001`, for runs a GitHub triage event started. See [A cheaper model for triage events](#a-cheaper-model-for-triage-events). |
| `session.triage.models.codex-cli` | string | unset (off) | The same for `codex-cli` agents, such as a `gpt-` model. |
| `session.triage.actions` | list of string | `["labeled", "unlabeled", "closed"]` | GitHub issue and pull request actions that count as triage. A run uses the triage model only when every event it collected is in this list. |
| `session.memoryIndexMaxChars` | number | `0` | Longest the agent-memory index may be where every session loads it: in the workspace `CLAUDE.md` and in the system prompt. `0` keeps the whole index. The cut keeps whole lines and ends with a line counting the entries left out; the full index stays in `.agentx-memory.md` in the workspace. See [A shorter memory index](#a-shorter-memory-index). |
| `session.observationPack.enabled` | boolean | `false` | Keep large tool results out of the conversation: the agent sees the start and the end of the result and the path of a file with the exact original. See [Large tool results](#large-tool-results). Turning it on takes a daemon restart; turning it off applies on save. |
| `session.observationPack.limitBytes` | number (1024–1048576) | `10240` | A text result larger than this many bytes is replaced by an excerpt. |
| `session.observationPack.headBytes` | number (0–65536) | `1024` | Bytes of the start of the original the agent sees. |
| `session.observationPack.tailBytes` | number (0–65536) | `1024` | Bytes of the end of the original the agent sees. |
| `session.observationPack.tools` | list of string | `["Bash", "Grep", "Read", "WebFetch", "mcp__.*"]` | Tools whose results are packed. Each entry must match the whole tool name and may be a regular expression. Requires a daemon restart. |
| `session.observationPack.retentionDays` | number (0–3650) | `0` | Days a saved original is kept. `0` keeps every original. |
| `session.resumeGate.mode` | `"off"` \| `"shadow"` \| `"active"` | `"off"` | Before an earlier conversation is picked up again, compare its price with a fresh start and start fresh when that is clearly cheaper. `shadow` only writes what it would do to the daemon log. See [Resume or start fresh](#resume-or-start-fresh). Applies on save. |
| `session.resumeGate.freshTokens` | number (1000–200000) | `30000` | Tokens a fresh lean session starts with. |
| `session.resumeGate.cacheTtlMinutes` | number (1–1440) | `60` | Minutes the saved conversation is assumed to stay in the provider's cache. |
| `session.resumeGate.cacheWriteFactor` | number (1–4) | `2` | Price of writing to the cache, as a multiple of the normal input price. `2` for the one-hour cache, `1.25` for the five-minute one. |
| `session.resumeGate.margin` | number (1–10) | `1.5` | How many times cheaper a fresh start must be before the gate picks it. |

### Lean sessions

A session's first turn carries a lot before the agent reads the task: every tool server (MCP server) the computer's user has connected, every user-level skill and plugin, the global `CLAUDE.md`, plus what AgentX adds, such as the list of agents (the landscape), today's history of the chat and a summary of the agent's other chats. A GitHub label event or a one-line answer to another agent pays for all of it, on every new session.

A **lean** session gets only what the task needs up front. The rest is one tool call away:

| What a full session gets | What a lean session gets instead |
|---|---|
| Every connected tool server, and the `agentx` tool server with them | Only the `agentx` tool server, plus the ones named in `session.lean.mcpServers`. |
| User-level settings: global `CLAUDE.md`, user skills, plugins | Only the workspace's own settings and skills (`session.lean.settingSources`). |
| The landscape in the prompt | The `agentx_agents` tool with `landscape: true`. |
| Today's history of this chat in the prompt | The `agentx_recent` tool with the chat's `channel` and `chatId`. |
| A summary of the agent's other chats today | The `agentx_recent` tool without a `chatId`. |
| (both) Stored knowledge, as before | The `agentx_wiki_query` tool, as before. |

Both kinds of session send a `claude-code` agent's project `CLAUDE.md` once: Claude Code reads it from the workspace, and AgentX does not add a second copy. Both kinds also load the `agentx` tool server (the `agentx_approval`, `agentx_request`, `agentx_recent` and other `agentx_` tools): a full session gets it next to the tool servers the workspace and the computer's user connect, a lean one gets it in their place. An `agentx` entry in the workspace's `.mcp.json` is used as written.

The prompt keeps one line, `[Context on demand]`, naming these tools. Chat channels (Telegram, WhatsApp, voice, the dashboard and the phone app) are not changed: they stay full unless you list them. Only `claude-code` and `codex-cli` agents have a lean start; other engines always start full. The daemon log shows `session profile for github: lean (…)` when a lean session starts.

To make one channel full again, list it:

```json
"session": {
  "profileByChannel": { "github": "full" }
}
```

To make a chat channel lean, or keep a second tool server in lean sessions:

```json
"session": {
  "profileByChannel": { "telegram": "lean" },
  "lean": { "mcpServers": ["agentx", "codegraph"] }
}
```

To see what a session on a channel is handed, before and after:

1. **Terminal:** in the AgentX source folder, run `pnpm bench:profiles --channels github`. It prints a table with one row per prompt section, full against lean, and the saving. No model is called.
2. **Terminal:** run `pnpm bench:context --channel github --sections --config agentx.json --agent <your agent id>` to measure a real agent of yours.

#### Fewer built-in tools

Even a lean session carries the descriptions of every built-in Claude Code tool, about 14k tokens of a first turn. The lowest first turn with every tool, and none of your own files loaded, measured about 27k tokens. Getting under 20k means giving the session a shorter list of tools. This is off until you set it, because an agent that needs a tool it does not have fails in the middle of its task.

To give lean sessions a short tool list:

1. **Terminal:** look at what the agent's tasks on that channel use. Run `agentx trace show <taskId>` on a few recent runs; the `tool_use` steps name the tools.
2. **Terminal:** open `agentx.json` and set the list, for all lean channels or for one:

   ```json
   "session": {
     "lean": {
       "tools": ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
       "toolsByChannel": { "cron": ["Bash", "Read"] }
     }
   }
   ```

3. **Terminal:** run `agentx daemon restart --when-idle`. The daemon log line for the next lean session ends with `tools=Bash+Read+…`.

The list applies to `claude-code` agents on lean channels only, and never to the `agentx` tools, which stay available. An empty list means every tool: there is no way to start a session with no tools at all, because Claude Code then loads every tool server's full description instead, which costs more, not less.

AgentX always adds `ToolSearch` to the list, even when you leave it out. `ToolSearch` is the Claude Code tool that looks up a tool's full description when the agent first needs it. While it is there, the session starts with only the names of the `agentx` tools. Without it, Claude Code puts the full description of all `agentx` tools into every first turn: about 9k tokens, measured on Claude Code 2.1.291, which is more than a short list saves.

#### Fewer agentx tools

You can also tell lean sessions about fewer of the `agentx_` tools, the AgentX tools the agent uses to reply, send messages and look things up. **On most setups this saves very little, so leave it off unless you have measured a reason.**

- While `ToolSearch` is in the session (always, see above), Claude Code sends only the `agentx` tool *names* in the first turn. A list of nine tools instead of all 29 saved about 330 tokens of an 8,000-token first turn, measured on Claude Code 2.1.291.
- It saves more, about 5,500 tokens, only where Claude Code's tool search is off, for example when `ENABLE_TOOL_SEARCH=false` is set or `ANTHROPIC_BASE_URL` points to a server other than Anthropic's. Then Claude Code sends every tool's full description.
- The cost: a tool left off the list is gone for that session. The agent cannot find it, not even with `ToolSearch`.

Some tools are always kept, because AgentX's own messages to the agent ask for them by name: `agentx_approval`, `agentx_request`, `agentx_events` and `agentx_attach_next`, plus `agentx_agents`, `agentx_recent` and `agentx_wiki_query` while `session.lean.contextOnDemand` is on.

To tell lean sessions about fewer `agentx` tools:

1. **Terminal:** look at what the agent's tasks on that channel use. Run `agentx trace show <taskId>` on a few recent runs; the `tool_use` steps name each one as `mcp__agentx__agentx_…`.
2. **Terminal:** open `agentx.json` and set the list, for all lean channels or for one. Use the names without the `mcp__agentx__` start:

   ```json
   "session": {
     "lean": {
       "agentxTools": ["agentx_channel_reply", "agentx_channel_label"],
       "agentxToolsByChannel": { "a2a": ["agentx_send_agent"] }
     }
   }
   ```

3. **Terminal:** run `agentx config check`. It prints `✓ Config valid`. A misspelt name stops here with `not an agentx tool: …`.
4. **Terminal:** run `agentx daemon restart --when-idle`. The daemon log line for the next lean session ends with `agentx-tools=N`, the number of `agentx` tools it was told about.

The list applies to `claude-code` agents on lean channels only. It works when the `agentx` tool server is started as a command, which is the default. If the workspace's `.mcp.json` points `agentx` at a web address (`"type": "http"`) instead, the session still gets every `agentx` tool.

#### A shorter memory index

The index of what an agent remembers (`agentx memory index`) is loaded on every session, twice: merged into the agent's workspace `CLAUDE.md`, and inlined in the system prompt. An agent with many memories pays for the whole list on every task. `session.memoryIndexMaxChars` caps it:

1. **Terminal:** run `agentx memory index --agent <agent id>` and look at its length.
2. **Terminal:** open `agentx.json` and set the cap, for example `"session": { "memoryIndexMaxChars": 4000 }`.
3. **Terminal:** run `agentx daemon restart --when-idle`. The prompt uses the cap at once; the `CLAUDE.md` block is rewritten at the restart and after every memory change.

The cut keeps whole lines, in the index's own order (user, feedback, project, reference), and ends with a line such as `_(12 more memories not shown here. The full index is in .agentx-memory.md in this workspace, or run \`agentx memory index\`.)_`. The file it names always holds the whole index, so the agent can read it when a task needs more.

#### A cheaper model for triage events

A GitHub event such as a label being added or an issue being closed usually needs a short answer, not the agent's strongest model. `session.triage` sends those runs to a cheaper model you name. It is off until you set a model.

A run counts as triage only when every event it collected is a triage action. AgentX collects the events one issue raises in a few seconds into one run, so an issue that is opened and then labeled keeps the agent's own model. Three more cases keep it too:

- a model set on the task itself, such as a schedule's `model`;
- a follow-up on an issue whose conversation ran within the last hour, because changing model there re-reads the whole conversation at full price;
- a model that does not fit the agent's engine, such as a `gpt-` model for a `claude-code` agent.

An action only reaches an agent when `channels.github.issueActions` or `pullRequestActions` (or a project rule) lets it through. `labeled` and `closed` are not in the default lists.

To send label and close events to a cheaper model:

1. **Terminal:** open `agentx.json` and set the model, and the actions if you want different ones:

   ```json
   "session": {
     "triage": {
       "models": { "claude-code": "claude-haiku-4-5-20251001" },
       "actions": ["labeled", "unlabeled", "closed"]
     }
   },
   "channels": {
     "github": { "issueActions": ["opened", "reopened", "assigned", "labeled"] }
   }
   ```

2. **Terminal:** run `agentx config check`. It prints `✓ Config valid`.
3. **Terminal:** run `agentx daemon restart --when-idle`.

This is a fixed rule. The task-tier decision under `decisions.routing` is a separate, learned way to pick a cheaper model; when a triage model applies, that decision is not asked.

### Large tool results

A tool result stays in the conversation, and the model re-reads the whole conversation on every later step of the task. A 20 KB test log read once is paid for again on each of the next thirty steps, although the agent rarely looks at it twice.

With `session.observationPack.enabled`, a text result larger than `limitBytes` is saved in full under `.agentx/observations/<agent id>/` in the daemon's folder, and the agent gets this in its place:

```text
[ObservationPack: this result is 23442 bytes (400 lines). Only its first 1024 and last 1024 bytes are shown.
The exact original is saved at /srv/agentx/.agentx/observations/coder/aa0c…864c.txt
Read that file with offset and limit (line numbers), or grep it, for the part you need. Do not cat it whole: that is packed again. Do not guess at what is not shown.]
(the first 1024 bytes)
[... 21394 bytes not shown ...]
(the last 1024 bytes)
```

Nothing is lost: the saved file is byte for byte what the tool returned, and the agent reads it back with its own file tool. Reading a saved original is never packed again. When the original is a few very long lines, such as minified JSON, the excerpt tells the agent to read it by byte range instead of by line.

A file the agent reads (the `Read` tool) is its own original, so no copy is saved. The agent keeps the first and last whole lines that fit in `headBytes` and `tailBytes`, and a notice between them names the file and the exact lines left out:

```text
(the first 21 lines, with their line numbers)
[ObservationPack: this read is 29889 bytes, lines 1 to 600 of /srv/app/src/server.ts.
Lines 22 to 580 (27870 bytes) are not shown. Lines 581 to 600 follow; the numbers beside them are not the file's.
Read the file again with offset and limit for the lines you need, or Grep it. Do not guess at what is not shown.]
(the last 20 lines)
```

The agent then reads the lines it needs with `offset` and `limit`, which is also how it gets the exact text for an edit. A read that starts at an offset counts its lines from there. Notebooks, PDFs and pictures are never cut.

```json
"session": {
  "observationPack": { "enabled": true }
}
```

What it covers, and what it does not:

| | |
|---|---|
| Agents | `claude-code` agents only. It works through a Claude Code hook (PostToolUse) that AgentX writes into each agent workspace's `.claude/settings.json` when the daemon starts. Codex and the other engines are not changed. |
| Agents that ask before acting | Not packed. Only an agent with `permissionMode: "bypassPermissions"` gets the hook: in any other mode Claude Code refuses to open the saved original in a session nobody answers for, and the agent would guess at the part it was not shown. The daemon log says how many agents were left out. |
| Tools | The ones in `tools`. By default: commands (`Bash`), searches (`Grep`), file reads (`Read`), fetched web pages (`WebFetch`) and every tool server (`mcp__.*`, which includes the AgentX tools). |
| Files the agent reads | Packed by default (owner decision on [#621](https://github.com/anis-marrouchi/agentx/issues/621), 2026-10-05); the replay of three days of logs put the ceiling of cached tokens saved at 7.5% with file reads and 5.5% without. A file over `limitBytes` is cut to its first and last lines with the file's path and line numbers, and no copy is saved. An agent that edits large files reads the part it changes again in pages; set `tools` without `"Read"` to spare it that. |
| Very large command output | Claude Code itself already replaces command output over 30,000 characters with a 2 KB preview and a saved file. The pack leaves those results to it, and covers the ones between `limitBytes` and that size. |
| Pictures, sound and files in base64 | Never packed. Only text is. |
| Claude Code version | The hook answer that replaces a result (`updatedToolOutput`) was confirmed on Claude Code 2.1.289. A version that ignores it gives the agent the full result, while the original is still saved and counted in `index.jsonl`. |
| Event text | The text of the event or message that starts a task is not a tool result and is not packed. |
| Timing | The excerpt replaces the result at once. The agent never sees the full result unless it reads the saved file. |
| Sessions outside the workspace | A session whose working folder is not the agent's workspace does not load the workspace's hooks and is not packed. |

The saved originals can hold whatever a command printed, including secrets, exactly as Claude Code's own session logs do. Each agent has its own folder, and the read rule AgentX writes into a workspace names that agent's folder only. The folders are readable by the daemon's user only. They grow with use; set `retentionDays` to delete originals that have not been written or seen again for that many days. An agent that resumes an older session can then no longer read them.

If the daemon is not running, the hook does nothing and the agent gets the full result.

To see what the pack does to your costs:

1. **Terminal:** before turning it on, in the folder with `agentx.json`, run `agentx usage channels --from 2026-10-01 --to 2026-10-03 --save before.json` with three recent full days. It prints the cost per channel and per task, and saves the figures.
2. Turn the pack on and restart the daemon. Let it run for a few days.
3. **Terminal:** run `agentx usage channels --from <first day> --to <last day> --baseline before.json` with the days after the restart. It prints both ranges side by side with the change in cost per task.
4. **Terminal:** run `cat .agentx/observations/*/index.jsonl | wc -l`. Each line is one packed result, with its size and what the agent was shown.

The two ranges do not hold the same tasks, so compare the cost per task on the busy channels, not the totals. In the AgentX source folder, `python3 bench/observation-pack-replay.py --from <day> --to <day>` reads the Claude Code session logs of a range and prints how many tool-result bytes are over the limit, per tool and per channel, without calling a model.

### Resume or start fresh

A `claude-code` agent picks an earlier conversation up again by replaying it, and it replays the whole conversation on every step of the new task. The provider keeps a recent conversation in a *cache* (a short-term store it reads from at a tenth of the normal price). Once the cache has expired, the first step pays to store the whole conversation again, at more than the normal price.

With `session.resumeGate.mode` set, AgentX compares two prices before it picks a conversation up:

- **Picking it up:** the conversation's size, read cheaply if the cache is still there, or stored again if it is not, then read on every later step.
- **Starting fresh:** a new session of `freshTokens`, stored once, then read on every later step.

It counts the steps from the last task in the same conversation. When starting fresh is at least `margin` times cheaper, the conversation starts fresh, with the same note on what came before that the other rotation rules leave. Starting fresh loses the details of the earlier conversation, which no price shows, so the default margin asks for a clear saving.

The gate runs after the rules that already start a conversation fresh (silence, size near the limit, too many turns), and can only start one sooner. `claude-code` agents only.

```json
"session": {
  "resumeGate": { "mode": "shadow" }
}
```

To try it without changing anything:

1. **Terminal:** in the folder with `agentx.json`, run `agentx usage channels --from 2026-10-01 --to 2026-10-03 --save before.json` with three recent full days.
2. Set `session.resumeGate.mode` to `"shadow"` and save. Let it run for a day.
3. **Terminal:** run `agentx daemon logs | grep "resume gate"`. Each line says whether the conversation would have started fresh, with both prices.
4. If the lines that say `would start fresh` are conversations you would not miss, set the mode to `"active"` and save.
5. **Terminal:** after a few days, run `agentx usage channels --from <first day> --to <last day> --baseline before.json` and compare the cost per task on the busy channels.

## processPool

How long warm `claude-code` processes (`persistentProcess`) are kept. Codex and OpenCode use fixed limits.

| Key | Type | Default | What it does |
|---|---|---|---|
| `processPool.maxIdleSeconds` | number (5–86400) | `30` | Seconds after its last turn when a process may be stopped to make room. |
| `processPool.maxAgeSeconds` | number (60–86400) | `2700` | Seconds of idleness after which a process is always stopped. |
| `processPool.sweepIntervalSeconds` | number (1–300) | `5` | How often the pool is checked. |

A warm process answers only the question it was asked. When a background task of the agent ends, Claude Code writes a reply nobody asked for; that reply is not sent, and the daemon log notes it as `dropped a reply no question asked for`.

## plugins

| Key | Type | Default | What it does |
|---|---|---|---|
| `plugins` | list of string | `[]` | Installed npm package names loaded as plugins when the daemon starts. |

## Check it worked

1. **Terminal:** in the folder with `agentx.json`, run `agentx config check`. It prints `✓ Config valid`.
2. **Terminal:** run `agentx config get agents.helper.maxConcurrent`, using your own agent id. It prints the value you set.
3. **Terminal:** run `agentx agent list`. The agent appears with its engine and model.
4. **Terminal:** after a GitHub event or a schedule runs, run `agentx daemon logs`. A line `session profile for github: lean (mcp=agentx settings=project,local context=on-demand)` shows the lean start took effect.
5. **Terminal:** with `session.lean.agentxTools` set, after a lean session starts, run `agentx daemon logs`. The `session profile for …: lean (…)` line ends with `agentx-tools=N`.
6. **Terminal:** with `session.triage.models` set, after a label event on an issue nobody has worked on for an hour, run `agentx daemon logs`. A line `triage event (labeled) → <model>` shows the cheaper model was used.
7. **Terminal:** with `session.observationPack.enabled`, the daemon log shows `ObservationPack: PostToolUse hook written to N workspace(s)` at the first start (and `N agent(s) not packed` for agents outside `bypassPermissions`), and `.agentx/observations/<agent id>/index.jsonl` gets a line the first time that agent runs a command with more than 10 KB of output or reads a file of that size. A line with `"tool":"Read"` has no saved file next to it: the file the agent read is the original.
8. **Terminal:** with `session.resumeGate.mode` set to `"shadow"`, after an agent picks a conversation up, run `agentx daemon logs`. A line `resume gate (shadow) for <channel>:<chat>: would resume: …` or `would start fresh: …` shows both prices. In `"active"` mode, a line `cost rotation for …` marks a conversation that started fresh.

## If something is wrong

- **`config check` names a field:** the value has the wrong type or is out of range. Compare it with the table above.
- **An `sdk` agent fails with `No API key for provider`:** set `providers.<name>.apiKey`, or check that the environment variable it points to is in `.env`.
- **An agent with `persistentProcess` answers the question before the one you asked:** update AgentX and restart the daemon. Versions up to 0.103.2 sent a background task's reply as the answer to the next question.
- **A model or engine change is ignored:** restart the daemon fully with `agentx daemon stop`, then `agentx daemon start --detach`.
- **An agent on GitHub, a schedule or a workflow says it cannot see another agent, an earlier message or a tool it had before:** its channel starts lean. Either tell the agent to use the `agentx_agents`, `agentx_recent` and `agentx_wiki_query` tools, add the tool server it misses to `session.lean.mcpServers`, or set that channel to `"full"` in `session.profileByChannel`.
- **A label or close event still runs on the agent's own model:** check the daemon log. A run that used the triage model logs `triage event (labeled) → <model>`. If it is missing, the run also collected another action (such as `opened`), the issue's conversation ran within the last hour, or the model does not start with `claude-` (for `claude-code` agents) or `gpt-` (for `codex-cli` agents).
- **The daemon log says `N agent(s) not packed`:** those agents do not run with `permissionMode: "bypassPermissions"`. They could not open a saved original, so they keep getting full results. This is by design; nothing to fix.
- **An agent reads the same large file again and again in pages, or its edit fails with `old_string not found` right after a read:** the read was packed and the agent is fetching the lines it needs. That is expected once per file; if the agent spends most of a task on one large file, set `session.observationPack.tools` to `["Bash", "Grep", "WebFetch", "mcp__.*"]` and restart the daemon, so file reads stay whole.
- **`session.observationPack.enabled` is on and nothing is packed:** restart the daemon; the hook is written into the workspaces at start. Then check that the agent's `tier` is `claude-code`, that its `permissionMode` is `bypassPermissions` and that the result was over `limitBytes`.
- **A lean session with `session.lean.tools` set starts no smaller than one without it:** update AgentX. Versions up to 0.115.0 left `ToolSearch` out of the list, so Claude Code loaded every `agentx` tool description in full.
- **An agent on a lean channel says it has no tool to reply, label or send a message:** that `agentx` tool is not in `session.lean.agentxTools` (or the channel's own list). Add it, or empty the list, and run `agentx daemon restart --when-idle`.
- **`agentx config check` says `not an agentx tool: …`:** a name in `session.lean.agentxTools` or `agentxToolsByChannel` is misspelt, or starts with `mcp__agentx__`. Use the name exactly as `agentx trace show` prints it after `mcp__agentx__`.
- **The daemon log shows no `agentx-tools=` for a lean session with a list set:** the channel's own list in `session.lean.agentxToolsByChannel` and the shared list are both empty, or the agent's `tier` is not `claude-code`.
- **A lean session still loads the user-level skills or the global `CLAUDE.md`:** `session.lean.settingSources` contains `user`. Remove it, or check that the agent's `tier` is `claude-code`; other engines ignore these settings.
- **`session.resumeGate` is set and the log has no `resume gate` line:** the line only appears when a `claude-code` agent picks up an earlier conversation that no other rule ended. A conversation that is new, silent for longer than `staleMinutes`, near its size limit or past `maxTurnsPerSession` starts fresh before the gate looks at it.
- **The gate starts conversations fresh that an agent still needed:** raise `session.resumeGate.margin`, for example to `3`, or set the mode back to `"shadow"`.
- **Every line says `resume: no context reading`:** the agent's last task ran without per-step usage, so there is nothing to compare. The conversation is picked up as before.
