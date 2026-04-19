---
title: "What's next"
---

# What's next

Concrete outstanding work, in rough priority order. Each item is real — it was either scoped in a blog post, flagged in a commit, or came up during a live session and got deferred deliberately. None of this is aspirational "vision"; it's the backlog.

Two categories: **Shipped with gaps** (something's built but incomplete — finishing is high-value) and **Scoped but unbuilt** (the design exists, the code doesn't).

## Shipped with gaps

### Graph admin UI — approval queue

- **Status:** panel scaffolded at `src/daemon/graph-panel.ts`, CLI covers the same job via `agentx graph review`.
- **What's missing:** the approve/reject buttons in the admin UI aren't wired. An operator can see pending classifications in the browser but still has to drop to the terminal to act on them.
- **Why defer:** the CLI + cron combo already closes the loop. A web button is ergonomics, not capability.
- **Effort:** ~1 day — POST endpoints already exist in concept, needs the page JS + the two routes. Reuse the same `commitNodesAlongPath` helper the CLI uses.

### Classifier fetch timeout

- **Status:** bumped 20s → 60s in commit `2eba778`; still occasionally aborts under load.
- **What's missing:** the classifier calls the draftAgent via the daemon's `POST /task` endpoint, which routes through the agent's Claude Code subprocess. Cold-start + queue wait can exceed 60s on the first request after a daemon restart.
- **Why defer:** has never blocked an actual task — the classifier falls back to the old regex layer on timeout. Noise, not breakage.
- **Options:** (a) add a retry-with-backoff before giving up, (b) bypass the daemon and call the LLM SDK directly from the classifier module, (c) raise timeout higher still. Probably (a) + (b) in sequence.

### A/B harness — standing run

- **Status:** `agentx wiki ab-test` exists and works; produces a markdown report.
- **What's missing:** it's operator-invoked. There's no cron, no baseline snapshot, no regression alerting.
- **Why defer:** we don't yet have enough traffic to see a regression trend. Waiting for the graph-tagged retrieval to stabilize before investing in monitoring.

## Scoped but unbuilt

### Procedure-delta extraction

- **Status:** scoped in the [Karpathy honest-review blog](https://noqta.tn/en/blog/agentx-wiki-karpathy-honest-review-2026) as the replacement for batch absorb on *runbook-shaped* content. Never built.
- **Shape:** a Procedure is a first-class object (trigger, inputs, steps, expected-output, KPIs) with its own store under `.agentx/procedures/`. When a message runs a known Procedure, the agent produces a **one-line delta** against that Procedure's SOP ("step 3 now requires `--no-cache`"). The delta is a proposed patch to the Procedure — O(procedure-runs), not O(entries × articles).
- **Why it matters:** the wiki holds "what did we decide"; Procedures would hold "how do we do X." Different consumers, different write mechanics. The wiki's absorb flow works for prose; running it over runbook content produces articles that drift because they're never re-validated.
- **Why defer:** depends on the admin UI approval queue (same patterns apply), and on having enough Procedure candidates in the wild to validate the cost assumption. ~1 week of real design + implementation.

### Cross-mesh graph sync

- **Status:** each host's graph is fully local. MacBook's `.agentx/graph/` and Clawd's are independent — same schema (both seeded from `STARTER_SCHEMA`), completely separate node sets and fingerprint caches.
- **What's missing:** no federation. If a message about "Hackathonat" classifies on MacBook and creates an `org/hackathonat` node there, Clawd doesn't see it; Clawd's first Hackathonat message re-classifies against an empty graph and probably picks a slightly different path.
- **Design options:**
  - **Leader-follower** — one host publishes the canonical nodes+schema; peers pull and read-only-cache. Simple, but creates coordination cost if the leader is down.
  - **Gossip** — peers exchange node-added events, merge by timestamp. Consistent with the existing A2A mesh model. Higher complexity.
  - **Shared backing store** — point `graph.baseDir` at a Tailscale-mounted NFS share. Cheap but fragile under network partitions.
- **Why defer:** we have two hosts; the divergence cost is low at N=2. Real payoff kicks in around N=5 and a clear leader candidate. Leader-follower with MacBook as leader is my lean.

### MCP tool surface expansion

- **Status:** `agentx_wiki_query` shipped (commit `ea6b485`, fixed stdio parser as bonus).
- **What's missing:** `wiki interview`, `wiki patch`, `wiki edit`, `graph review`, `skill sync` are all CLI-only. Exposing them via MCP would let Claude Code / Cursor / Windsurf invoke them directly as tools.
- **Why defer:** the CLI covers it for operators. MCP surface is pure ergonomics for "run these from inside my editor without opening a terminal."
- **Effort:** ~1 day per tool. Each one adds a TOOLS entry + a dispatcher case in `src/mcp/index.ts` that calls the same underlying functions the CLI uses.

## Parking lot — smaller items

- **Auto-prune rejected classifications** — `classifications.jsonl` grows without bound. Rotate after 90 days or N entries.
- **Retrieval weights audit** — `graph.retrievalWeights: { graph: 0.6, bm25: 0.4 }` exists in config; verify the wiki retrieval path actually uses them (might be unwired).
- **Classifier content-hash short-circuit** — trivial messages ("thanks", "ok", "hi") still invoke the LLM. A tiny content-hash pre-filter could skip obvious non-actionable messages.
- **MCP client compatibility sweep** — we caught + fixed the stdio parser bug because we tested locally. Cursor/Windsurf/Zed integrations may have other framing issues worth verifying.
- **Public-facing procedure registry** — agents publish what Procedures they handle; router picks the procedure-owning agent. Depends on Procedures landing first.
- **Graph admin UI — visualization** — a tree view of the taxonomy under the approval queue. Eye candy until the corpus is big enough to justify.

## Not on the list

These came up in sessions and were explicitly decided against:

- **RBAC / multi-operator auth** — parked until there's a second operator to share a deployment with. See the [positioning plan](/) for the reasoning.
- **Hosted / SaaS offering** — AgentX is self-hosted for small & medium businesses; we've chosen not to run a hosted version.
- **Voice / Canvas UI** — OpenClaw's territory; deliberately not our differentiation.
