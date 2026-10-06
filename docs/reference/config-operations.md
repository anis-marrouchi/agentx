# Configuration: dashboard, mesh and optional layers

This page lists every `agentx.json` setting for the dashboard, the mesh (other AgentX machines), voices, screen capture and the optional layers: business, boards, the intent graph and typed decisions. For the other sections, see the [Configuration reference](./config.md).

Each table gives the key, the kind of value it takes (its type), the value used when you leave it out (its default), and what it does. "required" means the file is rejected without it. A `<id>` in a heading is a name you choose.

## dashboard

The dashboard is the web page served by `agentx board serve`. See [Dashboard](/dashboard/).

| Key | Type | Default | What it does |
|---|---|---|---|
| `dashboard.enabled` | boolean | `false` | Turns the dashboard server on. |
| `dashboard.port` | number | `4202` | Port the dashboard listens on. |
| `dashboard.bind` | string | `"127.0.0.1"` | Address the dashboard listens on. Keep it local unless a reverse proxy sits in front ([your own address](/jobs/reverse-proxy)). |
| `dashboard.token` | string | — | Bearer token required for changes made through the dashboard. Unset means changes need no token. |
| `dashboard.daemonUrl` | string | `"http://localhost:18800"` | The main daemon the dashboard reads live data from. |
| `dashboard.daemons` | list of objects | `[]` | Extra daemons to show, beyond the peers the main daemon already knows. |
| `dashboard.draftAgent` | string | — | Agent that drafts text when you create an issue from a board. |

Each entry in `dashboard.daemons`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `name` | string | required | Label shown for that daemon. |
| `url` | string | required | That daemon's HTTP address. |
| `dashboardUrl` | string | — | That machine's dashboard address, used to pass settings changes through. Defaults to `url` with the port changed to 4202. |
| `token` | string | — | Bearer token for that daemon's API. |
| `dashboardToken` | string | — | Bearer token for that machine's dashboard. Defaults to `token`. |

## mesh

The mesh links several AgentX machines so their agents can reach each other. See [Add a second machine](/jobs/second-machine).

| Key | Type | Default | What it does |
|---|---|---|---|
| `mesh.enabled` | boolean | `false` | Turns the mesh on. |
| `mesh.peers` | list of objects | `[]` | The other machines this one talks to. |
| `mesh.inboxes` | list of objects | `[]` | Named inboxes that other machines may send work to. None are published until you add one. |
| `mesh.discovery` | `"static"` \| `"mdns"` | `"static"` | How peers are found. Only `static` (the `mesh.peers` list) is used today. |
| `mesh.healthCheck.interval` | number | `60` | Seconds between checks that each peer is up. |
| `mesh.healthCheck.timeout` | number | `10` | Seconds to wait for a peer before counting it as down. |
| `mesh.feed.enabled` | boolean | `true` | Follow the events of every reachable peer and show them in this machine's event feed. See [Events from other machines](./events.md#events-from-other-machines). |
| `mesh.feed.skipTypes` | list of strings | `["task:step"]` | Event types peers leave out of the feed they send this machine. The default skips per-step agent activity. A change applies when this machine next reconnects to each peer. |
| `mesh.delegation.asyncWhenHuman` | boolean | `true` | When a person started the conversation, an agent that asks another agent gets its answer later, as a new message, instead of waiting. See [When an agent asks another agent](/jobs/ask-another-agent). Applies without the mesh too. |
| `mesh.delegation.timeoutMinutes` | number | `30` | Minutes a helper agent has to answer before the asking agent is told it timed out. From 1 to 240. |

Each entry in `mesh.peers`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `url` | string | required | The peer's daemon address. |
| `name` | string | required | The peer's name. |
| `token` | string | — | Bearer token sent to that peer. Use an `${ENV_VAR}` reference. |

Guest meshes (another organisation let into part of this one) are not in `agentx.json`: the host keeps its grants in `.agentx/guests.json` and their trail in `.agentx/guests-log.jsonl`; the guest keeps the hosts it joined in `.agentx/guest-hosts.json`. All three are readable by your user only. See [Let another organisation into part of your mesh](/jobs/guest-mesh).

Each entry in `mesh.inboxes`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `name` | string | required | Inbox name other machines see. |
| `agent` | string | required | Local agent that handles it. Not shown to other machines. |
| `enabled` | boolean | `true` | Whether the inbox accepts work. |

## events

The daemon keeps its most recent events in memory so a late reader can catch up. See [Events](/reference/events).

| Key | Type | Default | What it does |
|---|---|---|---|
| `events.ringSize` | number | `1000` | How many recent events `GET /events/recent` can return. Older ones are dropped. Nothing is written to disk. |

## voice and meshVoices

How agents speak aloud. See [AgentX Voice](/dashboard/voice).

| Key | Type | Default | What it does |
|---|---|---|---|
| `voice.provider` | `"system"` \| `"elevenlabs"` | `"system"` | Speech engine: the free system voices, or ElevenLabs. |
| `voice.fallback` | `"system"` \| `"none"` | `"system"` | What happens when ElevenLabs cannot speak: use the system voice, or stay silent. |
| `voice.system` | string or map of strings | — | System voice for agents without their own. A name, `"system"` for the OS default, or one per language such as `{ "en": "Samantha", "fr": "Thomas" }`. Unset gives each agent its own. |
| `voice.locale` | string | `"en"` | Language used when voices are assigned, for example `"fr-FR"`. |
| `voice.listener` | string | — | What agents call you, for example a first name. Unset means "the user". |
| `voice.pronunciations` | list | `[]` | How a word is said aloud without changing how it is written. Each entry is `{ "written": "Okafor", "spoken": "Oh-kah-for" }`, with an optional `"languages"` list (`"en"`, `"fr"`, `"ar"`) that limits it to lines in those languages. The written form matches whole words, without case. At most 200. See [Say a word the way it is said](/guides/agentx-voice#say-a-word-the-way-it-is-said). |
| `voice.pointer` | boolean | `true` | Draw the agent's pointer and name tag on screen during a lesson. `false` never draws it; a lesson is then spoken only. A plain spoken answer never shows it. |

`meshVoices.<agent>` sets the voice of an agent that runs on another machine, keyed by that agent's id. This machine speaks for it, so the other machine needs no ElevenLabs key. Unset fields come from the agent's card.

| Key | Type | Default | What it does |
|---|---|---|---|
| `name` | string | — | What to call the agent aloud. |
| `provider` | `"system"` \| `"elevenlabs"` | — | Speech engine for this agent. Overrides `voice.provider`. |
| `system` | string or map of strings | — | System voice for this agent, as in `voice.system`. |
| `elevenlabsVoiceId` | string | — | ElevenLabs voice to use. |
| `gender` | `"female"` \| `"male"` \| `"neutral"` | — | Used to pick a matching voice when none is set. |
| `style` | string | — | A few words on manner, for example `"calm, brief"`. |
| `intro` | string | — | One-line self-introduction used on first contact. |
| `narrate` | `"off"` \| `"on"` \| `"all"` | — | Speak short updates from the agent's steps while it works. `on` skips scheduled jobs; `all` includes them. |

## screen

How agents capture the screen. See [Capture the screen at the right moment](/jobs/screen-capture).

| Key | Type | Default | What it does |
|---|---|---|---|
| `screen.maxPixels` | number | `1200000` | Pixel budget for one capture. Larger captures are scaled down. |
| `screen.timeoutMs` | number | `5000` | Longest a capture waits for a change or for the screen to settle, in milliseconds. |
| `screen.intervalMs` | number | `100` | Time between samples while waiting, in milliseconds. |
| `screen.changeThreshold` | number (0–1) | `0.015` | Average difference above which two samples count as different. |
| `screen.stableMs` | number | `400` | How long a region must stay unchanged to count as settled, in milliseconds. |
| `screen.regions` | map of objects | `{}` | Named parts of the screen, in screen points. A name here replaces a built-in region of the same name. |
| `screen.buffer.enabled` | boolean | `false` | Keeps the last few seconds of a region in memory. Frames are written out only when asked for. |
| `screen.buffer.seconds` | number (up to 120) | `10` | How many seconds the buffer keeps. |
| `screen.buffer.fps` | number (up to 10) | `2` | Frames per second kept in the buffer. |
| `screen.buffer.region` | string | `"screen"` | Region the buffer records. |
| `screen.buffer.maxPixels` | number | `300000` | Pixel budget for one buffered frame. |

Each entry in `screen.regions` (for example `"chat": { "x": 0, "y": 0, "width": 400, "height": 300 }`):

| Key | Type | Default | What it does |
|---|---|---|---|
| `x`, `y` | number | required | Top-left corner. |
| `width`, `height` | number | required | Size of the region. |

## business

An experimental layer that runs agents like a team, with roles, working hours and a shared pool of work. It is off by default and its shape may change between minor versions. The whole `business` block is optional; when present, `business.mainChannel` and `business.workSource` are required.

| Key | Type | Default | What it does |
|---|---|---|---|
| `business.enabled` | boolean | `false` | Turns the business layer on. |
| `business.timezone` | string | `"UTC"` | Timezone for working hours. |
| `business.mainChannel` | object | required | Chat where the team posts reports and "no plan today" notices: `channel`, `chatId` and optional `accountId`. |
| `business.mainChannel.accountId` | string | — | Which account of that channel to post from. |
| `business.workSource` | object | required | Where agents find work. `type` is `"backlog"`, `"gitlab"` or `"wiki"`. |
| `business.workSource.path` | string | `".agentx/backlog.md"` for `backlog` | The backlog file (`backlog`), or the folder to read (`wiki`, required there). |
| `business.workSource.projects` | list of strings | `[]` | GitLab projects to read (`gitlab`). Empty means all configured GitLab projects. |
| `business.workSource.glob` | string | `"**/*.md"` | Which files to read in the folder (`wiki`). |
| `business.roles` | map of objects | `{}` | Job roles, keyed by role id. |
| `business.orgChart` | map of objects | `{}` | Which agent holds which role and when it works, keyed by agent id. |
| `business.projects` | list of objects | `[]` | Projects, with an optional project manager and client. |
| `business.contactMap` | list of objects | `[]` | Maps a chat or sender to a client and project, so the activity view credits the right client. |
| `business.clients` | map of objects | `{}` | Per-client overrides, keyed by client id. Clients are otherwise worked out from `projects` and `contactMap`. |
| `business.workTickMinutes` | number (1–60) | `15` | How often, in minutes during working hours, agents are asked to pick up work. |
| `business.idleQueueThreshold` | number | `0` | Accepted but not read by the daemon yet. |
| `business.standup.enabled` | boolean | `true` | Runs the morning standup. When off, it does nothing. |
| `business.standup.plansDir` | string | `".agentx/plans"` | Folder holding the day's plan (`<date>.md`, falling back to the week, then the month). With no plan, the standup posts a notice and starts no agent. |
| `business.standup.maxAgentsPerDay` | number (1–100) | `20` | Most agents the standup may start in one morning. |
| `business.standup.dryRun` | boolean | `false` | Posts the day's plan for review but starts no agent. |

Each entry in `business.roles.<role>`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `title` | string | required | Role name given to the agent. |
| `responsibilities` | list of strings | `[]` | Listed in the agent's instructions. |
| `sopPath` | string | — | File with the role's standard procedure, referenced in the agent's instructions. |
| `kpis` | list of strings | `[]` | Measures of success for the role. |

Each entry in `business.orgChart.<agent>`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `role` | string | required | Role id from `business.roles`. |
| `reportsTo` | string | — | Agent id of the manager. Must be another agent in the org chart. |
| `schedule.days` | list of `"mon"`…`"sun"` | Monday to Friday | Working days. |
| `schedule.start`, `schedule.end` | string `HH:MM` | required | Start and end of the working day. |
| `schedule.lunch` | object | — | Lunch break, with `start` and `end` as `HH:MM`. |
| `utilizationTarget` | number (0–1) | `0.8` | Share of working time the agent should be busy. |

Each entry in `business.projects`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `id` | string | required | Project id, for example `group/project`. |
| `pm` | string | — | Agent id of the project manager. |
| `client` | string | — | Client the project belongs to. Defaults to the part of `id` before the first `/`. |

Each entry in `business.contactMap` (the first match wins: `chatId`, then `username`, then `channel`):

| Key | Type | Default | What it does |
|---|---|---|---|
| `client` | string | required | Client this contact belongs to. |
| `channel` | string | — | Channel kind, for example `"telegram"`. |
| `chatId` | string | — | The chat's id on that channel. |
| `username` | string | — | Sender's username. |
| `senderId` | string | — | Sender's numeric id, when the username changes. |
| `project` | string | `<client>/_chat` | Project the conversation counts toward. |
| `displayName` | string | — | Name shown for the contact. |

Each entry in `business.clients.<client>`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `name` | string | the client id | Display name. |
| `kind` | `"client"` \| `"internal"` \| `"own"` | — | `client` is someone waiting on you; `own` is your own product; `internal` has no outside deadline. |
| `respondWithin` | string | — | How long a wait may last before it matters, such as `"4h"`, `"90m"` or `"2d"`. Unset means no deadline. |
| `standing` | list of strings | `[]` | What agents may do for this client without asking; `"*"` means everything. Ignored when `kind` is `client`. |

## boards

Kanban boards backed by GitLab issues, shown on the dashboard's Boards page. `boards` is a list; each board has these keys:

| Key | Type | Default | What it does |
|---|---|---|---|
| `id` | string | required | Board id: lowercase letters, digits, `-` or `_`. |
| `name` | string | required | Board title. |
| `source.type` | `"gitlab"` | required | Where issues come from. Only GitLab today. |
| `source.projects` | list of strings | required | GitLab project paths. At least one. |
| `primaryToolLabel` | string | — | A label every card must carry; shown as a fixed filter chip. |
| `labels` | list of objects | `[]` | Labels offered when you create or edit a card. |
| `columns` | list of objects | six columns | The columns. The default is Open, To Do, Doing, On Hold, Review and Closed, driven by `Status::` scoped labels. |
| `timeRangeDays` | number (1–365) | `30` | How many days of open issues to show. |
| `closedWindowDays` | number (1–365) | `30` | How many days of closed issues the Closed column shows. |
| `reconciliation` | object | `{}` | Settings for flagging stale cards, listed below. |
| `reconciliation.enabled` | boolean | `true` | Accepted but not acted on yet: flagging cards left in Doing too long. |
| `reconciliation.staleDoingMinutes` | number | `45` | Accepted but not acted on yet. |
| `reconciliation.respectLunchBreak` | boolean | `true` | Accepted but not acted on yet. |
| `reconciliation.respectSchedule` | boolean | `true` | Accepted but not acted on yet. |
| `reconciliation.action` | `"badge"` \| `"notify"` | `"badge"` | Accepted but not acted on yet. |

Each entry in `labels`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `name` | string | required | The GitLab label, used as written. |
| `color` | string `#rrggbb` | `"#6366f1"` | Label colour. |
| `description` | string | — | Label description. |

Each entry in `columns`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `id` | string | required | Column id: lowercase letters, digits, `-` or `_`. |
| `title` | string | required | Column heading. |
| `kind` | `"open-backlog"` \| `"scoped-label"` \| `"closed"` \| `"label"` | `"label"` | Which issues land here. `open-backlog`: open issues with no status label. `scoped-label`: open issues with `scopedLabel`. `closed`: closed issues; dragging here closes, dragging out reopens. `label`: open issues with `mapsToLabel`. |
| `mapsToLabel` | string | — | For `label` columns: label added on entry and removed on exit. |
| `scopedLabel` | string | — | For `scoped-label` columns: the full label, such as `Status::Doing`. |
| `scopedPrefix` | string | `"Status"` | For `open-backlog` columns: issues with a label of this prefix are left out. |
| `accent` | string | — | Colour of the column's top bar. |

## graph

The intent graph sorts requests into a fixed tree of topics and helps wiki search. It is off by default.

When a request is not already in the graph's cache, the classifier asks the `intent-path` decision seat first if that seat is `active` under `decisions.seats`, and only falls back to `graph.classifierModel` when the seat has no confident answer. When the seat is sure of the category but only somewhat sure of the verb (the specific kind of work), it files the request under the category alone instead of guessing a verb. The seat chooses the category from a short description of each one (for example, *support* is a person talking to an agent, and *social* is content made for an audience), so a greeting or a complaint is not filed as a post or a settings change. In `shadow` the model still decides and the seat's answer is recorded next to it, so `agentx decisions stats` shows how often the two agree before the seat takes over. The path a request was filed under also steers the wiki: while that request runs, `agentx_wiki_query` asks the daemon for its path and ranks the articles that match the question by how much of the path they share, weighted by `graph.retrievalWeights.graph`. A query sent before the request is classified, or from outside a running request, searches without a path.

| Key | Type | Default | What it does |
|---|---|---|---|
| `graph.enabled` | boolean | `false` | Turns the intent graph on. |
| `graph.baseDir` | string | `".agentx/graph"` | Folder holding the graph's files. |
| `graph.draftAgent` | string | — | Agent that proposes classifications. Falls back to `dashboard.draftAgent`. |
| `graph.reviewAgent` | string | — | Agent `agentx graph review` uses to approve or reject pending classifications. Falls back to `graph.draftAgent`. |
| `graph.autoApproveStructure` | `"strict"` \| `"extend-leaves"` \| `"any"` | `"extend-leaves"` | Which classifications skip review. `strict`: none. `extend-leaves`: those that reuse existing topics or add one new topic at the deepest level. `any`: all. |
| `graph.autoApproveConfidence` | number (0–1) | `1` | Classifications at or above this confidence also skip review. `1` turns this off. |
| `graph.classifierModel` | string | `"claude-haiku-4-5-20251001"` | Model used to classify. |
| `graph.retrievalWeights.graph` | number | `0.6` | Weight of topic match in wiki search. |
| `graph.retrievalWeights.bm25` | number | `0.4` | Weight of text match in wiki search. |

## decisions

Typed decisions ("seats") let a small, fast model answer fixed-choice questions with a probability. Everything is off by default. See [Jev and typed decisions](/architecture/jev).

| Key | Type | Default | What it does |
|---|---|---|---|
| `decisions.enabled` | boolean | `false` | Turns typed decisions on. |
| `decisions.dbPath` | string | `".agentx/decisions/decisions.sqlite"` | Database where every decision is recorded. |
| `decisions.redactState` | boolean | `false` | Stores only a fingerprint of each decision's input, not its text. You can no longer replay decisions offline. |
| `decisions.keepStateRows` | number | `2000` | How many recent inputs to keep in full per seat; older ones keep only the fingerprint. |
| `decisions.defaultBackend` | string | `"local"` | Backend used by seats that don't name one. |
| `decisions.backends` | object | `{}` | Settings for each backend below. |
| `decisions.seats` | map of objects | `{}` | Per-seat settings, keyed by seat name. |
| `decisions.routing` | object | `{}` | Models to move simple tasks to. |
| `decisions.routing.cheapModel` | string | — | Cheaper model for `claude-code` agents (older form of the next key). |
| `decisions.routing.cheapModels` | object | — | Cheaper model per engine. |
| `decisions.routing.cheapModels.claude-code` | string | — | Cheaper model for `claude-code` agents, such as a `claude-` model or `haiku`. |
| `decisions.routing.cheapModels.codex-cli` | string | — | Cheaper model for `codex-cli` agents, such as a `gpt-` model. |

**Local backend** (asks a model through an agent engine):

| Key | Type | Default | What it does |
|---|---|---|---|
| `decisions.backends.local` | object | `{}` | The local backend. |
| `decisions.backends.local.provider` | string | `"claude-code"` | Engine used to ask. |
| `decisions.backends.local.model` | string | `"claude-haiku-4-5-20251001"` | Model used to ask. |
| `decisions.backends.local.structureMode` | `"auto"` \| `"tool"` \| `"text"` | `"auto"` | How the answer's shape is enforced: a forced tool call, JSON in text, or whichever the engine supports. |
| `decisions.backends.local.normalizeProbabilities` | boolean | `true` | Rescales the model's probabilities so they add up to 1. |
| `decisions.backends.local.nRetryMalformedStructure` | number (0–3) | `1` | Retries when the answer has the wrong shape. |
| `decisions.backends.local.maxStateChars` | number | `24000` | Longest input sent, in characters. |

**simple-jev backend** (a self-hosted server that reads the model's own probabilities):

| Key | Type | Default | What it does |
|---|---|---|---|
| `decisions.backends.simpleJev` | object | `{}` | The simple-jev backend. |
| `decisions.backends.simpleJev.baseUrl` | string | `"http://127.0.0.1:8000/v1"` | Server address. |
| `decisions.backends.simpleJev.model` | string | — | Model to use. |
| `decisions.backends.simpleJev.apiKeyEnv` | string | — | Name of the environment variable holding the key. |
| `decisions.backends.simpleJev.timeoutMs` | number | `30000` | Request time limit, in milliseconds. |
| `decisions.backends.simpleJev.maxStateChars` | number | `6000` | Longest input sent, in characters. |
| `decisions.backends.simpleJev.maxChoiceOptions` | number (2–255) | `50` | Most options one question may have. |

**jev backend** (Jev through OpenRouter) and **typesafe backend** (Jev direct from TypeSafe):

| Key | Type | Default (`jev`) | Default (`typesafe`) | What it does |
|---|---|---|---|---|
| `decisions.backends.jev.baseUrl`, `decisions.backends.typesafe.baseUrl` | string | `"https://openrouter.ai/api/alpha"` | `"https://api.typesafe.ai/v1"` | Service address. |
| `decisions.backends.jev.path`, `decisions.backends.typesafe.path` | string | `"/decisions"` | `"/systemone"` | Endpoint path. |
| `decisions.backends.jev.model`, `decisions.backends.typesafe.model` | string | `"jev-latest"` | `"jev-latest"` | Model id. |
| `decisions.backends.jev.apiKeyEnv`, `decisions.backends.typesafe.apiKeyEnv` | string | `"OPENROUTER_API_KEY"` | `"TYPESAFE_API_KEY"` | Name of the environment variable holding the key. |
| `decisions.backends.jev.timeoutMs`, `decisions.backends.typesafe.timeoutMs` | number | `30000` | `30000` | Request time limit, in milliseconds. |
| `decisions.backends.jev.maxStateChars`, `decisions.backends.typesafe.maxStateChars` | number | `90000` | `90000` | Longest input sent, in characters. |
| `decisions.backends.jev.maxChoiceOptions`, `decisions.backends.typesafe.maxChoiceOptions` | number (2–255) | `255` | `255` | Most options one question may have. |

Each entry in `decisions.seats.<seat>`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `mode` | `"off"` \| `"shadow"` \| `"active"` | `"off"` | `off`: unused. `shadow`: runs and records only. `active`: its answer is used. |
| `backend` | string | `decisions.defaultBackend` | Backend for this seat. |
| `model` | string | — | Model for this seat. |
| `timeoutMs` | number | `10000` | Time limit per decision, in milliseconds. `request-gate` and `request-context` default to `3000` instead, because a message waits for them; a value you set is used, but a message never waits more than 5 seconds for either. |
| `temperature` | number | `1` | Calibration fitted from labelled answers (`agentx decisions calibrate`). `1` means not calibrated yet. |
| `explore` | number (0–1) | `0.15` | Share of would-be skips run anyway, so the seat can still be graded. |
| `holdout` | number (0–1) | — | Share of turns that skip the seat as a comparison group. Only seats that run an experiment read it. |

```json
"decisions": {
  "enabled": true,
  "seats": { "request-gate": { "mode": "shadow", "backend": "jev" } }
}
```

## demo

How long `agentx demo` waits while it starts. The demo reads this from the `agentx.json` in the folder you run it from. It needs no config file, so this is only for machines where it starts slowly.

| Key | Type | Default | What it does |
|---|---|---|---|
| `demo.startupTimeoutSeconds` | number (1–3600) | — | Seconds each startup step may take: each node answering `/health`, the dashboard answering `/live`, the nodes finding each other. Unset: `AGENTX_DEMO_STARTUP_TIMEOUT`, else 60, raised when the machine is busy (the 1-minute load average above the CPU count), up to 300. The `--startup-timeout` flag overrides both. |

## Check it worked

1. **Terminal:** in the folder with `agentx.json`, run `agentx config check`. It prints `✓ Config valid`.
2. **Terminal:** run `agentx config get <path>` for the key you changed, for example `agentx config get mesh.healthCheck.interval`. It prints the new value.
3. **Terminal:** run `agentx daemon status` to confirm the daemon is running.

## If something is wrong

- **`config check` names a field:** fix the value to match the type in the tables above. Ids for boards and columns must be lowercase.
- **Dashboard changes don't show:** the dashboard is its own process. Restart it after changing `dashboard` settings.
- **A mesh peer shows as down:** check its `url` and `token`, then raise `mesh.healthCheck.timeout` if the link is slow.
- **`agentx demo` says `Timed out waiting for …`:** the machine is too busy for the startup limit. Run it again with `--startup-timeout 300`, or set `demo.startupTimeoutSeconds`. The line `Startup limit: …` at the top shows the value in use and where it came from.
- **A backend key is empty at runtime:** the variable named in `apiKeyEnv` is missing from `.env`. Add it, then restart the daemon.
