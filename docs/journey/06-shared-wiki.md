---
title: "6. Shared wiki — compounding team knowledge"
---

# 6. Shared wiki — compounding team knowledge

> **Status:** full Karpathy/Farzapedia pattern shipped — ingest + absorb + query + prune + migrate all live

The wiki pipeline today follows the pattern Karpathy and Farza actually described: typed articles (`person / project / place / concept / event / decision / pattern`), `[[wikilinks]]` as the primary navigation surface, an `_index.md` catalog grouped by type, and an **agentic query** that walks the subgraph instead of BM25-matching keywords. For the full why, see **[An honest review of our Karpathy-inspired wiki](https://noqta.tn/en/blog/agentx-wiki-karpathy-honest-review-2026)**.

## Day in the life — from MR comment to cited answer

Concrete, end-to-end. Your PM agent watches a GitLab project. A merge request lands:

> **MR !179** — `feat: product items table dropdowns (closes #642)` · author: coding-mtgl-v2 · branch `642-rr-product-items-table-dropdowns`
> _GitLab webhook fires into AgentX._

**1. Ingest (continuous).** The router writes a raw entry per webhook event and per reply. No LLM, no decision — just durable capture into `.agentx/wiki/raw/entries/`. After a day of MR activity you have ~13 raw entries for this MR: open, push, comment, CI fail, reply, merge.

**2. Absorb (cron, nightly).** `agentx wiki absorb --mode graph` batches each agent's unabsorbed entries into one Claude call that emits typed articles with wikilinks. The 13 raw entries collapse into a single article:

```markdown
---
title: "MR !179 — feat: product items table dropdowns (closes #642)"
type: project
related: ["Issue #642 — RR Product Items Table Rework (Dropdowns)",
          "MTGL System V2 — Project Overview",
          "MTGL V2 Coding Agent — Implementation Agent for MTGL System V2",
          "DevOps MTGL — Deployment Agent for MTGL System V2",
          "Staging Server — MTGL System V2"]
tags: ["mtgl", "merge-request", "product-items"]
sources: ["pm-mtgl-mnn3f7hj", "pm-mtgl-mnn3j2cc", …]   # traceability to raw entries
---

MR !179 implements [[Issue #642 — RR Product Items Table Rework]] on
[[MTGL System V2 — Project Overview]]. Branch: `642-rr-product-items-table-dropdowns`.
Author: [[MTGL V2 Coding Agent]].

## Scope Drift
#642 specified "UI only." This MR added new DB tables and FKs
(`categories`, `sub_services`, `category_id`). Deployment now requires
running migrations and the `CategoriesAndSubServicesSeeder`.
```

Notice: the wikilinks form a graph. `MR !179 → Issue #642 → MTGL System V2 → Staging Server → DevOps MTGL` is now a walkable path.

**3. Query (when value lands).** Three days later someone in the Telegram project channel types:

> "why did we ship new DB tables with #642? wasn't that a UI-only ticket?"

The PM agent picks this up and calls `agentx wiki query "scope drift on issue 642"`. Under the hood:

- `_index.md` lists 47 articles by type. Selector LLM picks `project: MR !179` and `project: Issue #642` as candidates.
- The walker follows `related` wikilinks 2 hops. Subgraph ends up with 5 articles including the event `2026-04-08 CI Pipeline PHP Version Mismatch` and the decision on backfill strategy.
- Synthesiser replies, citing titles:

> _"Scope expanded from UI-only to schema changes because of the category foreign-key requirement — see [[MR !179 — feat: product items table dropdowns]] > Scope Drift. DevOps confirmed the seeder must run on staging first; see [[2026-04-08 CI Pipeline PHP Version Mismatch]]."_

That's the payoff. Not BM25 over transcripts — a cited answer assembled from typed articles the agent itself compiled. The same pattern works for onboarding ("what is MTGL?"), incident review ("who decided X?"), and cross-project ("has another team hit this?").

**4. Mesh sync.** Clawd-server runs its own absorb pass; macbook runs its own. Agent-wide wikis stay peer-local, but cross-references are published over the mesh — `agentx graph pull` and `wiki sync` keep the two sides in sympathy without either becoming the source of truth (see [Journey 8](/journey/08-mesh-federation)).

## The command surface

Grouped by what they're for:

### Write (grow the wiki)

| Verb | When |
|---|---|
| `ingest` | Continuous — every conversation writes a raw entry. Cheap, source of truth. |
| `absorb` | Nightly cron — compiles recent raw entries into typed articles with `[[wikilinks]]`, updates `_index.md`. |
| `interview` | Interactive — operator answers a scoped Q&A, an LLM synthesizes one typed article. Captures tacit knowledge that never hit a channel. |
| `quiz` | Reverse interview — operator asks, the wiki answers, operator grades (`/ok` `/correct` `/add` `/link`) and the cited article gets patched. |
| `patch` | One-shot LLM-edit from a plain-English instruction. For when you already know what's wrong. |
| `edit` | Straight `$EDITOR` on the article file. No LLM. For typos and trivial fixes. |

### Read (use the wiki)

| Verb | When |
|---|---|
| `query` | Agent-invoked. Walks the catalog + wikilink graph, synthesizes a cited answer. Primary retrieval. |
| `search` | Raw BM25 fallback for cases where the agentic path is too slow. |
| `serve` | Local Wikipedia-style browser (local + mesh peers). |
| `status`, `lint`, `entries` | Health and inventory checks. |

### Housekeeping (one-shot)

| Verb | When |
|---|---|
| `migrate` | Backfill `type` + `related` on legacy articles (post-upgrade). |
| `prune` | Collapse legacy per-mode dirs (`flat/`, `unified/`) into canonical `graph/`. |
| `ab-test` | Side-by-side comparison of old BM25 preload vs new agentic query over real task-history messages. |
| `share`, `sync` | Cross-agent and cross-mesh sharing. |

## The agentic query path (the "read side")

This is the part the earlier design missed. When an agent needs institutional knowledge:

1. Read `_index.md` (catalog grouped by type with wikilink previews).
2. LLM selector picks candidate articles by `type` + title.
3. Walk `related` wikilinks 2–3 hops from candidates, cap at ~8 articles.
4. Synthesize the answer from the walked subgraph, cite by title.

This is what makes the wiki worth compiling into. Without it, you're running shallow BM25 over files the LLM wrote — the pathology the blog post analyzes.

## Permissions

`public` / `shared` / `private` per article, enforced on read and write. Default `public`; drop to `private` for sensitive credentials or agent-specific learnings; use `shared` with specific agent IDs when the article only matters to a subset.

## References

- [Wiki CLI](/reference/cli#wiki) — every command
- [Concepts → Wiki](/concepts#_5-wiki)
- [Honest review of the wiki approach](https://noqta.tn/en/blog/agentx-wiki-karpathy-honest-review-2026) — the post-mortem and the fix
- Source: [`src/wiki/`](https://github.com/anis-marrouchi/agentx/tree/master/src/wiki) ([store.ts](https://github.com/anis-marrouchi/agentx/blob/master/src/wiki/store.ts), [prompts.ts](https://github.com/anis-marrouchi/agentx/blob/master/src/wiki/prompts.ts), [query.ts](https://github.com/anis-marrouchi/agentx/blob/master/src/wiki/query.ts))
