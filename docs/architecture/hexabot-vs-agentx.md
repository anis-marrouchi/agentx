# Hexabot vs AgentX — Comparative Architecture Review

> Date: 2026-04-27 | Author: Coder Agent

## 1. Stack at a Glance

| Dimension | Hexabot | AgentX |
|-----------|---------|--------|
| **Persistence** | TypeORM → Postgres/SQLite/Mongo, session store via connect-typeorm | Flat JSON files + append-only JSONL in `.agentx/` (~1,698 files, ~1.6 GB) |
| **Eventing** | EventEmitter2 (global, wildcard, namespaced `hook:chatbot:*`) | Direct method calls in registry; no event bus |
| **Plugin model** | `@InjectDynamicProviders` glob discovery — channels, actions, helpers loaded by convention | Skill injection via file globs in `.claude/skills/`; wiki/memory/pattern stores loaded at dispatch |
| **Transport** | Socket.IO (web) + HTTP webhooks (external channels) + Redis pub/sub for multi-instance | Telegram/WhatsApp/Slack/Discord native clients + HTTP webhooks + A2A mesh RPC |
| **Queueing** | None built-in; Redis adapter handles Socket.IO fan-out only | In-memory `MessageQueue` per agent with drop/collect overflow modes |
| **Observability** | Audit module + analytics entities; no structured metrics export | Task-history JSONL, `TOKEN_COSTS.md`, hourly sparkline, drift detection — all file-based |
| **Deployment** | Docker Compose: Postgres + Redis + API + Frontend | Single Node.js process; `daemon.pid` lifecycle; no container orchestration |

## 2. Three Things Hexabot Does Better

### 2.1 Structured Persistence with Migrations

Hexabot's TypeORM layer (`packages/api/src/database/`) gives every entity a UUID base class, timestamps, Zod transforms, and migration support. Schema changes are versioned and auditable.

AgentX stores sessions as individual JSON files (`src/agents/sessions.ts:~line 1`, writing to `.agentx/sessions/*.json`). No schema enforcement, no migrations, no indexing — querying across sessions requires reading every file.

**Effort to port:** M (1–3 days) — see Section 4 for SQLite plan.

### 2.2 Event-Driven Decoupling

Hexabot's `EventEmitter2` setup (`packages/api/src/app.module.ts`, wildcard + `:` delimiter) lets any module subscribe to `hook:chatbot:message` without coupling to the sender. The `ChannelEventBus` (`packages/api/src/channel/channel-event-bus.ts`) is a clean facade.

AgentX's router (`src/channels/router.ts`) calls registry methods directly. Adding a new side-effect (e.g., analytics on every message) means editing the router. An internal event bus would decouple routing from observation.

**Effort to port:** S (under a day) — Node's `EventEmitter` suffices; no need for EventEmitter2.

### 2.3 Convention-Based Plugin Discovery

Hexabot's `@InjectDynamicProviders` scans globs like `hexabot-channel-*/**/*.channel.js` and `hexabot-action-*/**/*.action.js` (`packages/api/src/channel/channel.module.ts`, `packages/api/src/actions/actions.module.ts`). Third-party npm packages auto-register.

AgentX skills live under `.claude/skills/` as symlinked markdown — effective but not composable as code modules. There's no equivalent of "install an npm package and it wires itself in."

**Effort to port:** M — requires a loader convention and a registration interface for JS/TS plugins.

## 3. Three Things Hexabot Does Worse

### 3.1 Heavy Infrastructure Requirements

Hexabot requires Postgres + Redis for production (`docker/docker-compose.yml`). The Redis adapter (`packages/api/src/websocket/redis-io.adapter.ts`) is mandatory for multi-instance Socket.IO. For a single-operator deployment this is over-provisioned.

AgentX runs as a single process with zero external services. **Rejection:** adopting mandatory Postgres/Redis would break the "clone and run" simplicity that makes AgentX deployable on a $5 droplet.

### 3.2 Deep ORM Abstraction Stack

Every Hexabot entity goes through: `BaseOrmEntity` → `BaseOrmRepository` → `BaseOrmService` → Controller (`packages/api/src/utils/generics/`). For simple CRUD this is 4 layers of indirection with Zod transforms at each boundary.

AgentX reads/writes JSON directly. **Rejection:** the abstraction tax isn't justified for AgentX's data shapes, which are append-heavy and rarely queried relationally. SQLite with thin helpers (Section 4) is the right middle ground.

### 3.3 No Multi-Node / Mesh Support

Hexabot is single-instance by design. No peer discovery, no agent directory across nodes, no task forwarding. Scaling means running identical replicas behind a load balancer — all stateless, no agent affinity.

AgentX's A2A mesh (`src/a2a/mesh.ts`) provides peer health checks (3-strike hysteresis), agent card discovery, and transparent task forwarding. **Rejection:** Hexabot's approach would lose AgentX's core differentiator — heterogeneous agent topology across nodes.

## 4. The `.agentx/db.sqlite` Decision

**Recommendation: Partial migration.**

### Files to Migrate First

| Current path pattern | Record count | Why migrate |
|---|---|---|
| `.agentx/sessions/*.json` | ~hundreds/day | Query by agent+channel, expire stale sessions, reduce file count |
| `.agentx/task-history/<agent>/<date>/*.json` | ~1,200+ | Aggregate metrics, search by status/duration, archive old runs |
| `.agentx/router/dedup.json` | 1 (Map) | Atomic reads under concurrent writes; current debounced-save risks data loss on crash |
| `.agentx/usage/*.json` | ~dozens | Sum/group by agent/model/day without loading all files |

### Files to Keep as-Is

| Path | Reason |
|---|---|
| `.agentx/workflows/*.json` | Human-editable definitions; small count (<50); git-diffable |
| `.agentx/workflows/_runs/*.jsonl` | Append-only stream; SQLite WAL adds no benefit over sequential JSONL |
| `.agentx/wiki/**/*.md` | Markdown content meant for RAG ingestion and human reading |
| `.agentx/agent-memory/**/*.md` | Same — markdown for prompt injection, not structured queries |
| `.agentx/references/**/*.json` | Small count, loaded once at boot, rarely mutated |

### Schema Sketch

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,  -- 'agent:channel:chatId:day'
  agent_id    TEXT NOT NULL,
  channel     TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  day         TEXT NOT NULL,     -- 'YYYY-MM-DD'
  messages    TEXT NOT NULL,     -- JSON array
  claude_session_id TEXT,
  turn_count  INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent ON sessions(agent_id, day);

CREATE TABLE task_history (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  channel     TEXT,
  chat_id     TEXT,
  status      TEXT NOT NULL,     -- 'ok' | 'error' | 'timeout'
  input_text  TEXT,
  output_text TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  duration_ms INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_tasks_agent_date ON task_history(agent_id, started_at);

CREATE TABLE dedup (
  key         TEXT PRIMARY KEY,
  seen_at     INTEGER NOT NULL   -- epoch ms
);

CREATE TABLE usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  model       TEXT NOT NULL,
  day         TEXT NOT NULL,
  tokens_in   INTEGER DEFAULT 0,
  tokens_out  INTEGER DEFAULT 0,
  cost_usd    REAL DEFAULT 0
);
CREATE INDEX idx_usage_agent_day ON usage(agent_id, day);
```

### Effort & Risk

**Effort:** M (2–3 days). Day 1: schema + migration script that reads existing JSON → inserts. Day 2: swap SessionStore and TaskHistory to use `better-sqlite3`. Day 3: swap dedup + usage, test under load.

**Risk:** Low. SQLite WAL mode handles concurrent reads from dashboard while daemon writes. `better-sqlite3` is synchronous — no callback hell. Fallback: keep JSON writer as backup for 1 release cycle.

## 5. Architectural Moves to Ship Next

### Move 1: Internal Event Bus

**Scope:** Add a typed `EventBus` singleton wrapping `EventEmitter`. Emit `message:received`, `task:started`, `task:completed`, `session:rotated`. Refactor `router.ts` and `registry.ts` to emit instead of calling side-effects inline.

**Files:** new `src/events/bus.ts`; edit `src/channels/router.ts`, `src/agents/registry.ts`.
**Effort:** S | **Why:** Unlocks pluggable analytics, audit logging, and webhook triggers without touching the hot path.

### Move 2: SQLite for Sessions + Task History

**Scope:** As described in Section 4. Migrate sessions and task-history to `better-sqlite3`. Keep workflow definitions and wiki as files.

**Files:** new `src/storage/sqlite.ts`; edit `src/agents/sessions.ts`, `src/agents/registry.ts` (task recording), `src/channels/router.ts` (dedup).
**Effort:** M | **Why:** Eliminates the 1,698-file problem, enables dashboard queries, and gives ACID guarantees on session writes.

### Move 3: Plugin Loader for JS/TS Extensions

**Scope:** Define an `AgentXPlugin` interface with `register(ctx)` hook. Scan `node_modules/agentx-plugin-*` at boot. Start with channel adapters as the first plugin type.

**Files:** new `src/plugins/loader.ts`, `src/plugins/interface.ts`; edit `src/daemon/index.ts` (boot sequence).
**Effort:** M | **Why:** Moves channel adapters from monolith to installable packages — prerequisite for community contributions.

## 6. Open Questions for the Operator

1. **Session retention policy:** How many days of sessions should SQLite retain before archiving? Currently files accumulate indefinitely.
2. **Workflow run storage:** The JSONL append pattern works today but isn't queryable. If you need "show me all failed runs this week," that's another SQLite table. Worth it now or later?
3. **Plugin distribution:** Should AgentX plugins live on npm (public) or a private GitLab registry? This affects the loader convention.
4. **Dashboard read path:** Is the dashboard served from the same process? If so, `better-sqlite3` synchronous reads are fine. If separate, we need to consider WAL mode and concurrent access.
