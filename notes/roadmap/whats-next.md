---
title: "What's next"
---

# What's next

The backlog. No vision copy.

## Shipped, needs finishing

**Graph admin UI approval queue** — `src/daemon/graph-panel.ts` lists pending classifications but the approve/reject buttons aren't wired. CLI does the same job via `agentx graph review`. ~1 day.

**Classifier timeout resilience** — bumped 20s → 60s in [`2eba778`](https://github.com/anis-marrouchi/agentx/commit/2eba778); still aborts on cold-start. Next: retry-with-backoff, or bypass `POST /task` and call the LLM SDK directly.

**A/B / online-eval harness** — `wiki ab-test` works interactively; no standing run, no production shadow mode. Promoted from "waiting on traffic" after a 4-layer-stack proposal review confirmed this is the only real production-grade gap (rest of the Google ADK/MCP/Vertex/A2A surface is already covered by `src/agents/`, `src/mcp/index.ts`, `src/a2a/`, `src/business/kpi.ts` + `token-tracker.ts`). Build: shadow-mode flag in `src/agents/registry.ts` that, for a sampled % of incoming tasks, runs the same input through a B-version (alt model / alt prompt / alt agent) in parallel, persists both outputs alongside the existing TaskRecord, and surfaces a side-by-side diff in the dashboard. ~2 days. Owned ~$0; alternative was Vertex AI Agent Engine which is vendor lock-in + ongoing bill for capabilities already built.

## Scoped, partial

**Procedure-delta extraction** — data model + `agentx procedure list/add/show` shipped. Deferred: the delta flow itself (agents emit one-line deltas when they run a procedure, cheap O(runs) instead of O(entries × articles)). ~1 week for the delta pipeline.

**Cross-mesh graph sync** — v1 shipped: `GET /graph/{schema,nodes,classifications}` on the daemon + `agentx graph pull --from <peer>` (leader-follower, local wins on conflict, fingerprint cache populated from peer's approved classifications). Bidirectional push + schema reconciliation still parked.

**MCP tool surface beyond `wiki_query`** — `agentx_wiki_patch`, `agentx_wiki_interview`, `agentx_graph_review` now exposed over MCP. Claude Code / Cursor / Windsurf can call them as tools. Remaining CLI-only: `wiki edit`, `wiki quiz`, `skill sync`, `procedure add/show`.

## Parking lot

Auto-prune rejected classifications · retrieval-weights audit (verify `graph.retrievalWeights` is actually wired) · classifier content-hash short-circuit for trivial messages ("thanks", "ok") · MCP client compatibility sweep (Cursor/Windsurf/Zed) · **MCP-client wiring per agent** (centralize each agent's `.mcp.json` via an `mcp:` block in `agentx.json`, install at boot via the `installAgentMemorySurface()` pattern in `src/daemon/index.ts`; ~half a day) · public procedure registry (after Procedures land) · graph taxonomy tree-viz.

## Explicitly not doing

**RBAC / multi-operator auth** — parked until a second operator shares a deployment. **Hosted / SaaS** — we're self-hosted for SMB by design. **Voice / Canvas UI** — OpenClaw's territory.
