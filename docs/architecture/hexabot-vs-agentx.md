# Hexabot vs AgentX — Comparative Architecture Review

> Date: 2026-04-30 (revised — previous revision 2026-04-27)
> Author: Coder Agent
> Versions reviewed: Hexabot `3.2.2-alpha.1`, AgentX `agentix-cli@0.18.0`
> Hexabot tree: `/Users/macbookpro/Developer/coder-workspace/hexabot`
> AgentX tree: `/Users/macbookpro/Developer/noqta/agentx`

## 0. What changed since the previous review

The previous revision proposed three architectural moves for AgentX (event bus,
SQLite, plugin loader). Two of the three are now in tree:

| Move | Status | Evidence |
|---|---|---|
| 1 — Internal event bus | **Shipped** | `src/events/bus.ts` (140 LOC, typed `AgentXEvents`); `src/storage/subscribers.ts` consumes it |
| 2 — SQLite for ops tables | **Partial** | `src/storage/sqlite.ts` (185 LOC, WAL + migrations); subscribers write **additively** to `.agentx/db.sqlite`, JSON path still primary |
| 3 — Plugin loader | Not started | No `src/plugins/` |

New AgentX surface area not in the prior review (now load-bearing):

- **Intent layer** with formal spec (`docs/architecture/DispatchSpec.tla`), ledger
  (`src/intent/ledger.ts`, 568 LOC), counterfactual replay
  (`src/intent/counterfactual.ts`), org-chart governance
  (`src/intent/governance.ts`, just merged on `master`)
- **A2A mesh** (`src/a2a/`, 1,280 LOC across server + client + mesh + types) with
  3-strike health hysteresis and transparent task forwarding
- **MCP server** for AgentX itself (`src/mcp/index.ts`, 1,101 LOC) — exposes
  agents/workflows/wiki as MCP tools
- **Workflow engine** with run-store, conflict detector, signals, timers, hooks
  (`src/workflows/`, ~17 files)
- **Graph classifier + store** (`src/graph/`, 5 files, 1,192 LOC) — supports the
  workflow editor in `src/web/workflow-editor/`

Hexabot since the prior review has shipped (per `pnpm-workspace.yaml` + git log):

- `@hexabot-ai/agentic` 3.1.2-alpha — stable YAML DSL with `parallel`,
  `conditional`, `for_each`, `while`, JSONata expressions, retries, suspension
- `@hexabot-ai/graph` 3.0.0-alpha — React-Flow visual editor, ELK auto-layout
- `@hexabot-ai/cli` — `hexabot create` scaffolds a project, `hexabot dev` runs
  it; pkg-manager auto-detection
- pgvector + LlamaIndex + Vercel AI SDK 6 integration in `@hexabot-ai/api`
- Full Action library: `agent`, `generate-text`, `generate-object`,
  `infer-object`, `retrieve-content-rag`, `update-memory`, `handover`,
  `update-labels`, `http-request`, `send-mail`

The prior review treated Hexabot as "v2-style entity-CRUD". v3 is a different
animal — a workflow runtime with first-class agentic actions. The comparison
below is rewritten against that.

## 1. Stack at a Glance

| Dimension | Hexabot v3 | AgentX 0.18 |
|---|---|---|
| **Footprint** | 1,185 TS files / 132k LOC across 7 workspaces (api / agentic / graph / frontend / widget / cli / types) | 284 TS files / 80k LOC, single Node process; web wizard is one of many subsystems |
| **Tests** | Jest across packages; 41 module dirs in `api/src` with `*.spec.ts` siblings; `agentic` has dedicated `__tests__/` | 60 `*.test.ts` files in `test/`, plus eval harness (`test/eval/`) |
| **Persistence** | TypeORM → Postgres (production) / SQLite / Mongo; pgvector for RAG | SQLite (`.agentx/db.sqlite`, WAL) for ops tables + JSON files for definitions/wiki/memory; both written additively today |
| **Eventing** | EventEmitter2 (wildcard, `:` namespaces) + workflow-event-emitter inside the runner | Node `EventEmitter` singleton (`src/events/bus.ts`) with a typed `AgentXEvents` contract |
| **Workflows** | Declarative YAML DSL (`@hexabot-ai/agentic`) — `parallel`, `conditional`, `for_each`, `while`, retries, suspensions, JSONata expressions, scheduled runs (`workflow-scheduler.service.ts`) | Imperative + JSON definitions in `.agentx/workflows/*.json`, run-store as JSONL (`.agentx/workflows/_runs/*.jsonl`); engine in `src/workflows/engine.ts` |
| **Plugin model** | NestJS `@InjectDynamicProviders` + `nestjs-dynamic-providers` glob discovery for `*.channel.ts` / `*.action.ts` | File globs over `.claude/skills/`; registry-based agent injection; **no JS/TS plugin contract yet** |
| **Transport** | Socket.IO (web), HTTP webhooks (external), Redis pub/sub for multi-instance Socket.IO fan-out | Native clients for Telegram / WhatsApp (Baileys) / Slack / Discord / GitLab / cron / HTTP webhooks + **A2A mesh RPC** for inter-node task forwarding |
| **Queueing** | None built-in (Redis is Socket.IO adapter only) | In-memory `MessageQueue` per agent with drop / collect overflow modes (`src/agents/message-queue.ts`) |
| **AI substrate** | Vercel AI SDK 6 + `@ai-sdk/gateway`, `@ai-sdk/openai`, `@ai-sdk/mcp`; LlamaIndex 0.12; pgvector | Claude Code CLI as primary substrate (subagent model); MCP server *exposes* AgentX; agent-memory + RAG via filesystem markdown |
| **Observability** | NestJS Audit module + `nestjs-auditlog`; analytics entities; Compodoc | Event bus + SQLite subscribers + `task-history` JSONL + `TOKEN_COSTS.md` + drift detection + counterfactual ledger replay |
| **Formal verification** | None | `DispatchSpec.tla` (TLA+ spec) + counterfactual replay equivalence test |
| **Frontend** | Full React admin (309 tsx / 36k LOC) + chat widget package | Single workflow-editor SPA (8 tsx) — operator UX is dashboards rendered server-side |
| **Deployment** | Docker Compose: Postgres + Redis + API + Frontend (multi-container) | Single Node process; `daemon.pid` lifecycle; `install.sh`; runs on a $5 droplet |
| **License** | FCL-1.0-ALv2 (Fair Core, source-available) | MIT |

## 2. Scoring Method

**Twelve dimensions, weighted, scored 1–10.** Scores are anchored to evidence
in the trees inspected — file paths and LOC are cited so the reasoning is
auditable. Weights reflect what matters for **operational AI agent platforms
deployed by SMBs** (AgentX's stated audience), not generic chatbot SaaS.

Each score answers: *"How well does this project's current code solve this
dimension's problem?"* — not "how much code is there" or "how popular is it."

| Dimension | Weight | Rationale for weight |
|---|---|---|
| Conversational channel breadth | 10% | Reach across messaging platforms is table stakes for the use case |
| Workflow authoring | 12% | The single biggest force multiplier for non-engineer operators |
| Agent runtime / LLM substrate | 10% | Where reliability and cost actually live |
| Persistence + query | 8% | Determines what you can ask of the system |
| Observability + audit | 8% | Pre-requisite for putting this in front of customers |
| Formal correctness | 5% | Differentiator, not a hygiene score |
| Multi-node / mesh | 7% | Heterogeneous deployment is AgentX's bet |
| Plugin / extension model | 8% | Long-term ecosystem health |
| Frontend / operator UX | 8% | Non-technical operators must self-serve |
| RAG / memory | 7% | Determines what agents actually know |
| Deployment simplicity | 7% | "Clone and run" vs "Postgres + Redis" — real cost difference |
| Test coverage / verifiability | 10% | Confidence that v-next won't regress |

Scoring scale anchors:
- **1–3** missing or trivial
- **4–5** present but immature
- **6–7** production-usable for the common path
- **8–9** strong; well-tested edges
- **10** state-of-the-art reference implementation

## 3. Per-Dimension Scores

### 3.1 Conversational channel breadth — Hexabot 6, AgentX 9

Hexabot v3 ships `console` and `web` channels in tree
(`packages/api/src/extensions/channels/`). External channels (Messenger, WhatsApp,
LINE, etc.) live as `hexabot-channel-*` plugins via `@InjectDynamicProviders` —
proven model, but the **packaged extensions are not in this monorepo**.

AgentX has Telegram, WhatsApp (Baileys, including QR pairing), Slack, Discord,
GitLab, cron, and HTTP webhooks **as first-class in-tree integrations**
(`src/channels/`, 1,500+ LOC). Plus inbound media (voice via WebRTC), group
log, account resolution, handover-store, dedup. WhatsApp pairing is mature
enough that QR codes render in `qrcode-terminal`.

### 3.2 Workflow authoring — Hexabot 9, AgentX 6

Hexabot's `@hexabot-ai/agentic` DSL is the strongest single thing in this
comparison. Declarative YAML with `parallel` / `conditional` / `for_each` /
`while`, JSONata expressions for data flow, retries with backoff/jitter,
suspension/resume, scheduled runs. **The compiler validates Zod-typed steps
before execution** (`packages/agentic/src/workflow-compiler.ts`). 10 test files
in `__tests__/` covering parser, validator, runner, compiler, suspension
rebuild. `@hexabot-ai/graph` adds a React-Flow visual editor with ELK
auto-layout — operators can author flows graphically and the YAML stays the
canonical artifact.

AgentX has a workflow engine (`src/workflows/engine.ts`), run-store, signals,
timers, conflict detector, hooks — but definitions are JSON, not declarative
YAML. The web editor under `src/web/workflow-editor/` covers the basics
(8 tsx files vs Hexabot's separate package). No JSONata-equivalent expression
language; flow-control primitives less developed.

### 3.3 Agent runtime / LLM substrate — Hexabot 8, AgentX 8

Hexabot uses **Vercel AI SDK 6** (`ai@^6.0.17`), `@ai-sdk/gateway`,
`@ai-sdk/openai`, `@ai-sdk/mcp`, and LlamaIndex 0.12. The `agent.action`
binds tools, memory, models, and MCP into a single execution unit
(`packages/api/src/extensions/actions/ai/`). Standard provider-agnostic stack.

AgentX's runtime is **Claude Code CLI as substrate** — every agent is a Claude
Code subagent in a managed session (`src/agents/runtime.ts`,
`src/agents/sessions.ts`). This means every agent gets free access to: tool
loop, parallel sub-agents, MCP, file ops, web search, hooks — all the things
Vercel AI SDK has to assemble. The trade-off: AgentX is **Claude-native**
where Hexabot is provider-neutral. AgentX has explicit drift detection,
quota tracking, prompt-size tracking, agent compaction — operationally
deeper for the Claude path. Tied at 8 because they're optimized for
different bets.

### 3.4 Persistence + query — Hexabot 8, AgentX 6

Hexabot: TypeORM → Postgres in production, with migrations, UUID base entity,
Zod transforms, pgvector for RAG. Repository → Service → Controller layering
adds boilerplate but every entity is queryable from day one.

AgentX: SQLite via `better-sqlite3` is present and wired through event-bus
subscribers. WAL mode, sync=NORMAL, FK on. Schema migrates forward. **But**:
SQLite writes are still additive — JSON remains the source of truth, and
nothing reads from SQLite yet outside tests. So the dashboard can't query
the database; the query layer is real but unused. Scored 6, not 4, because
the foundation is in place — finishing it is now plumbing, not architecture.

### 3.5 Observability + audit — Hexabot 7, AgentX 8

Hexabot has `nestjs-auditlog`, an analytics entity model, and Audit module
controller endpoints. Standard NestJS hygiene.

AgentX has the event bus (typed `message:matched`, `task:started`,
`task:completed`, `session:rotated`) feeding SQLite subscribers, drift
detection (`src/agents/drift-detection.ts`), token-cost dashboards
(`TOKEN_COSTS.md` is auto-generated), per-agent task-history JSONL,
and the **counterfactual ledger replay** which is essentially time-travel
debugging for routing decisions. Closer to a SRE-friendly system than
Hexabot's CRUD-style audit. AgentX scores 8 here.

### 3.6 Formal correctness — Hexabot 1, AgentX 7

Hexabot has no formal spec.

AgentX has `docs/architecture/DispatchSpec.tla` (TLA+) and
`DispatchSpec.cfg`, a `phase-2` commit linking `decideAndCommit` to the
spec, and the `intent/replay.ts` regression test that re-derives every
historical routing decision from the ledger and asserts byte-identical
output. This is a small differentiator but a real one. Score reflects
that it's narrow (only routing is specified), not absent.

### 3.7 Multi-node / mesh — Hexabot 4, AgentX 9

Hexabot is single-instance with horizontal Socket.IO scaling via Redis
adapter. No agent affinity, no cross-node task forwarding, no peer
discovery. You scale by replicating the same monolith.

AgentX A2A (`src/a2a/`) implements peer health checks (3-strike hysteresis),
agent card discovery, transparent task forwarding, and the `connect`
command for joining meshes. This is AgentX's defining differentiator and
a tier-A feature in the codebase, not a sketch.

### 3.8 Plugin / extension model — Hexabot 9, AgentX 4

Hexabot's NestJS dynamic providers + Turborepo workspace gives a clear
contract: drop a `*.channel.ts` or `*.action.ts` into a glob-matched
location, install via npm, register implicit. Fully realized — it's how
the AI actions and channels are themselves loaded.

AgentX has `.claude/skills/` (markdown) and a registry pattern, but no JS/TS
plugin contract. Move 3 from the prior review (plugin loader) was scoped
but never implemented. Until that lands, third-party extensibility is
limited to Claude Code skills.

### 3.9 Frontend / operator UX — Hexabot 9, AgentX 5

Hexabot frontend: 309 tsx files / 36k LOC — full admin with i18n, contexts,
providers, layout, routes, websocket integration. Plus a separate
`@hexabot-ai/widget` for chat embedding.

AgentX has a workflow-editor SPA (8 tsx files) and a number of CLI panel
commands (`admin-panel`, `agent-panel`, `usage-dashboard`,
`board-dashboard`, `topbar`) which are **terminal UIs**, not browser UIs.
The setup-wizard is web-served via `src/daemon/setup-wizard.ts`. The gap
is real but reflects the deliberate "CLI for engineers, web wizard for
non-engineers" stance.

### 3.10 RAG / memory — Hexabot 8, AgentX 6

Hexabot ships `retrieve-content-rag.action`, `update-memory.action`,
`memory.binding`, and a memory service (`memory.service.ts` + record
+ definition services) backed by pgvector. Standard, production-ready RAG.

AgentX agent-memory is markdown files under `.agentx/agent-memory/<agent>/`,
auto-pruned, summarized, and injected into context (`src/agents/memory-store.ts`,
`src/agents/memory-extract.ts`). Wiki retrieval uses BM25
(`src/agents/references/`). No vector index yet. Works, but text-only retrieval
is the limit.

### 3.11 Deployment simplicity — Hexabot 4, AgentX 9

Hexabot needs Postgres + Redis + API + Frontend containers minimum, and the
Docker Compose stack does this for you, but the **operational floor** is
multi-service ops (PG backups, Redis fan-out, image builds).

AgentX is one Node process. `npm i -g agentix-cli && agentx serve`. The
$5-droplet deployment is real and tested (the tree has clawd-server deploy
notes). One process means one place to crash and one log to read.

### 3.12 Test coverage / verifiability — Hexabot 8, AgentX 7

Hexabot: 41 module dirs in `api/src` and most have `*.spec.ts` siblings. Jest
across all packages, plus e2e config. Mature coverage culture.

AgentX: 60 test files in `test/`, plus `eval/` harness for end-to-end
quality regression. Counterfactual replay acts as a property test for the
intent layer. Hexabot scores higher because coverage breadth is wider,
but AgentX's counterfactual + TLA+ make the routing path more *verifiable*
than anything Hexabot has.

## 4. Weighted Score Card

| Dimension | Weight | Hexabot | AgentX | Hexabot×W | AgentX×W |
|---|---:|---:|---:|---:|---:|
| Channel breadth | 10% | 6 | 9 | 0.60 | 0.90 |
| Workflow authoring | 12% | 9 | 6 | 1.08 | 0.72 |
| Agent runtime | 10% | 8 | 8 | 0.80 | 0.80 |
| Persistence + query | 8% | 8 | 6 | 0.64 | 0.48 |
| Observability + audit | 8% | 7 | 8 | 0.56 | 0.64 |
| Formal correctness | 5% | 1 | 7 | 0.05 | 0.35 |
| Multi-node / mesh | 7% | 4 | 9 | 0.28 | 0.63 |
| Plugin / extension | 8% | 9 | 4 | 0.72 | 0.32 |
| Frontend / operator UX | 8% | 9 | 5 | 0.72 | 0.40 |
| RAG / memory | 7% | 8 | 6 | 0.56 | 0.42 |
| Deployment simplicity | 7% | 4 | 9 | 0.28 | 0.63 |
| Test coverage | 10% | 8 | 7 | 0.80 | 0.70 |
| **Weighted total / 10** | **100%** | | | **7.09** | **6.99** |

**Within 0.10 of each other.** That is not a tie of "they're the same project"
— it's a tie of "they sit on different ends of the same problem and trade
identical amounts of one strength for another." Reweighting moves the verdict:

- Reweight toward operator UX + plugin ecosystem + RAG (SaaS chatbot
  vendor lens) → **Hexabot wins clearly**.
- Reweight toward channel breadth + mesh + deployment simplicity + formal
  correctness (sovereign SMB ops lens — AgentX's actual audience) →
  **AgentX wins clearly**.

The headline number is honest: neither dominates. The choice is the
**weight vector**, not the project.

## 5. Replacement Analysis

### 5.1 Can AgentX replace Hexabot?

**No, not today.** Three blockers, in order of severity:

1. **Workflow DSL gap.** Hexabot operators author flows in YAML with
   JSONata expressions and a graph editor. AgentX workflows are JSON +
   imperative engine — the authoring loop is for engineers. A migration
   would lose every Hexabot operator who isn't an engineer.
2. **Plugin ecosystem.** Hexabot's `*.channel.ts` / `*.action.ts` glob
   contract is how third-party channels and actions ship. AgentX has no
   JS/TS plugin contract — Claude Code skills are markdown, which doesn't
   compose for code.
3. **Frontend admin.** Hexabot's 36k-LOC React admin is a product surface,
   not just a dashboard. AgentX's terminal panels + workflow-editor SPA
   don't cover the same ground.

A 6–9 month investment could close these (build a YAML DSL on top of the
existing engine; ship Move 3; build a real admin UI). But "today, swap
Hexabot for AgentX" is wrong.

### 5.2 Can Hexabot replace AgentX?

**No, and the gap is bigger.** Two blockers Hexabot won't close without
re-architecting:

1. **Mesh + multi-node.** AgentX's A2A is the architectural premise of
   the project — heterogeneous agents across nodes that route to each
   other. Hexabot's scaling story is "replicate the monolith," which is
   the opposite shape. Adopting A2A means rebuilding peer discovery,
   agent cards, and task forwarding from scratch and undoing the
   single-instance assumptions.
2. **Native messaging channels in-tree.** AgentX has Telegram, WhatsApp,
   Slack, Discord, GitLab as first-class. Hexabot expects them as
   plugins. For an SMB op who needs "WhatsApp + Telegram + a cron"
   working day one, AgentX is one install; Hexabot is one install plus
   N plugin installs plus discovering which plugins exist.

Plus: deployment simplicity is a feature for AgentX's audience. Forcing
Postgres + Redis on a one-operator droplet to gain Hexabot's admin UI
is a bad trade.

### 5.3 What about coexistence?

This is where the honest answer lives. **They are complementary, not
competing.** A pragmatic deployment uses both:

- **Hexabot** as the customer-facing chatbot platform — its DSL, action
  library, frontend admin, RAG, and plugin model are best-in-class for
  conversational UX with non-engineer authors.
- **AgentX** as the operations layer behind it — mesh, cron, GitLab/Slack
  glue, multi-channel sovereign ops, agent-to-agent task forwarding,
  ledger / counterfactual replay for trust.

The interface between them is MCP. AgentX exposes itself as an MCP server
already (`src/mcp/index.ts`); Hexabot consumes MCP as a binding
(`mcp.binding.ts`). A Hexabot `agent.action` can invoke AgentX
capabilities, and an AgentX agent can drive Hexabot workflows by API.

## 6. Updated Architectural Moves for AgentX

Move 1 and Move 2 (partial) are shipped. Re-prioritized list:

### Move A — Finish Move 2: Read-Path SQLite

**Scope:** Switch the dashboard read path off JSON and onto SQLite. Add
queries for sessions-by-agent-day, task-history-by-status, top-cost-models.
Once the dashboard depends on SQLite, JSON writes become the redundancy
layer; eventually drop JSON for the migrated tables.

**Files:** edit `src/daemon/usage-dashboard.ts`, `src/daemon/admin-panel.ts`,
`src/daemon/board-dashboard.ts`. Add `src/storage/queries.ts`.
**Effort:** S. **Why:** The 1,698-file problem from the prior review is
half-solved — finish it.

### Move B — Plugin loader (the unfinished Move 3)

**Scope:** Define `AgentXPlugin` interface with `register(ctx)`. Scan
`node_modules/agentx-plugin-*` at boot. Start with channel adapters, then
allow plugins to subscribe to event bus and add MCP tools.

**Files:** new `src/plugins/loader.ts`, `src/plugins/interface.ts`; edit
`src/daemon/index.ts` boot.
**Effort:** M. **Why:** Without this, AgentX has a permanent ceiling on
third-party reach. Plugin loader unlocks the ecosystem question.

### Move C — Borrow Hexabot's YAML DSL contract for workflows

**Scope:** Don't re-implement — adopt `@hexabot-ai/agentic` as a
peer-dependency or fork its DSL parser. Add a translator from the
declarative DSL to AgentX's existing `src/workflows/engine.ts`. Operators
get the YAML authoring loop; AgentX keeps its run-store and conflict
detector.

**Files:** new `src/workflows/dsl-adapter.ts`. Optional
peer-dep on `@hexabot-ai/agentic` (FCL license — verify compatibility for
AgentX's MIT distribution; if blocked, reimplement the parser using the
public DSL spec).

**Effort:** M–L. **Why:** This is the largest single gap and the highest
leverage move — closes the workflow-authoring score from 6 → 8 in one
ship.

### Move D — Vector index for agent-memory + wiki

**Scope:** Add an `embeddings` SQLite table (or Vectra / sqlite-vss)
behind the existing BM25. Auto-embed wiki on write, agent-memory on
extract. Don't break the markdown-first model — the vector layer is an
index over it.

**Files:** new `src/storage/vector.ts`; edit `src/agents/memory-store.ts`,
`src/wiki/`.
**Effort:** M. **Why:** Closes the RAG gap (6 → 8) without adopting
Postgres.

### Move E — Productize the operator UI

**Scope:** Promote `src/web/workflow-editor/` to a full admin SPA. Routes
for agents, sessions, task-history, mesh-topology, cron, ledger replay.
Not a Hexabot-frontend port — keep AgentX's CLI-first stance and use the
SPA as the *non-engineer* surface.

**Effort:** L. **Why:** Closes the operator-UX gap (5 → 7) and unlocks
the SMB customer who can't run a TUI.

## 7. Open Questions for the Operator

1. **DSL adoption path:** Is FCL→MIT compatible for distributing
   `@hexabot-ai/agentic` as a peer-dep? If not, fork-and-reimplement
   the parser is the fallback. Confirm before scoping Move C.
2. **Vector lib choice:** sqlite-vss has no native ARM build; Vectra is
   pure-JS but slower. The deployment-simplicity score depends on this.
3. **Frontend stack:** If we promote the SPA, do we adopt React-Flow +
   Tailwind (matches Hexabot's stack and lets us copy patterns) or stay
   minimal? The answer drives ~3 weeks of work.
4. **Hexabot interop demo:** Want a worked example of "Hexabot calls
   AgentX-MCP" and "AgentX delegates to Hexabot workflow" as a reference
   architecture? That positions both projects clearly and answers the
   replacement question with a recipe instead of a verdict.

## 8. Verdict

- **Hexabot 7.09 / AgentX 6.99** — within scoring noise; the choice is
  the weight vector, not the projects.
- AgentX **cannot** replace Hexabot today (DSL, plugin model, admin UI).
- Hexabot **cannot** replace AgentX today (mesh, native channels,
  deployment simplicity).
- They are **complementary**. The honest recommendation is to ship Move A
  (finish SQLite read path), Move B (plugin loader), and Move C (DSL
  adoption) — those three close the gap on AgentX's three weakest
  dimensions while leaving its three strongest untouched, and bring the
  weighted total from 6.99 to ~7.7 (estimated). At that point AgentX is
  unambiguously the right choice for its stated audience, and the Hexabot
  comparison stops being interesting.
