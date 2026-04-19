---
title: "What's next"
---

# What's next

The backlog. No vision copy.

## Shipped, needs finishing

**Graph admin UI approval queue** — `src/daemon/graph-panel.ts` lists pending classifications but the approve/reject buttons aren't wired. CLI does the same job via `agentx graph review`. ~1 day.

**Classifier timeout resilience** — bumped 20s → 60s in [`2eba778`](https://github.com/anis-marrouchi/agentx/commit/2eba778); still aborts on cold-start. Next: retry-with-backoff, or bypass `POST /task` and call the LLM SDK directly.

**A/B harness as a cron** — `wiki ab-test` works interactively; no standing run. Waiting on traffic volume to justify alerting.

## Scoped, not built

**Procedure-delta extraction** — the [Karpathy blog](https://noqta.tn/en/blog/agentx-wiki-karpathy-honest-review-2026) promised this as the replacement for batch absorb on runbook content. Procedures (trigger/inputs/steps/expected/KPIs) become first-class; agents emit one-line deltas against the SOP when they run one. Cost is O(procedure-runs), not O(entries × articles). ~1 week.

**Cross-mesh graph sync** — each host's graph is fully local. At N=2 the divergence cost is low; real payoff at N≥5. Leader-follower with MacBook as leader is the lean.

**MCP tool surface beyond `wiki_query`** — `wiki interview/patch/edit`, `graph review`, `skill sync` are CLI-only. Exposing them via MCP lets Claude Code / Cursor / Windsurf call them as tools. ~1 day per tool.

## Parking lot

Auto-prune rejected classifications · retrieval-weights audit (verify `graph.retrievalWeights` is actually wired) · classifier content-hash short-circuit for trivial messages ("thanks", "ok") · MCP client compatibility sweep (Cursor/Windsurf/Zed) · public procedure registry (after Procedures land) · graph taxonomy tree-viz.

## Explicitly not doing

**RBAC / multi-operator auth** — parked until a second operator shares a deployment. **Hosted / SaaS** — we're self-hosted for SMB by design. **Voice / Canvas UI** — OpenClaw's territory.
