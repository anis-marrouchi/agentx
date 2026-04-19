---
title: "What's next"
---

# What's next

The backlog. No vision copy.

## Shipped, needs finishing

**Graph admin UI approval queue** — `src/daemon/graph-panel.ts` lists pending classifications but the approve/reject buttons aren't wired. CLI does the same job via `agentx graph review`. ~1 day.

**Classifier timeout resilience** — bumped 20s → 60s in [`2eba778`](https://github.com/anis-marrouchi/agentx/commit/2eba778); still aborts on cold-start. Next: retry-with-backoff, or bypass `POST /task` and call the LLM SDK directly.

**A/B harness as a cron** — `wiki ab-test` works interactively; no standing run. Waiting on traffic volume to justify alerting.

## Scoped, partial

**Procedure-delta extraction** — data model + `agentx procedure list/add/show` shipped. Deferred: the delta flow itself (agents emit one-line deltas when they run a procedure, cheap O(runs) instead of O(entries × articles)). ~1 week for the delta pipeline.

**Cross-mesh graph sync** — v1 shipped: `GET /graph/{schema,nodes,classifications}` on the daemon + `agentx graph pull --from <peer>` (leader-follower, local wins on conflict, fingerprint cache populated from peer's approved classifications). Bidirectional push + schema reconciliation still parked.

**MCP tool surface beyond `wiki_query`** — `agentx_wiki_patch`, `agentx_wiki_interview`, `agentx_graph_review` now exposed over MCP. Claude Code / Cursor / Windsurf can call them as tools. Remaining CLI-only: `wiki edit`, `wiki quiz`, `skill sync`, `procedure add/show`.

## Parking lot

Auto-prune rejected classifications · retrieval-weights audit (verify `graph.retrievalWeights` is actually wired) · classifier content-hash short-circuit for trivial messages ("thanks", "ok") · MCP client compatibility sweep (Cursor/Windsurf/Zed) · public procedure registry (after Procedures land) · graph taxonomy tree-viz.

## Explicitly not doing

**RBAC / multi-operator auth** — parked until a second operator shares a deployment. **Hosted / SaaS** — we're self-hosted for SMB by design. **Voice / Canvas UI** — OpenClaw's territory.
