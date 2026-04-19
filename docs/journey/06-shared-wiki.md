---
title: "6. Shared wiki — compounding team knowledge"
---

# 6. Shared wiki — compounding team knowledge

> **Status:** full Karpathy/Farzapedia pattern shipped — ingest + absorb + query + prune + migrate all live

The wiki pipeline today follows the pattern Karpathy and Farza actually described: typed articles (`person / project / place / concept / event / decision / pattern`), `[[wikilinks]]` as the primary navigation surface, an `_index.md` catalog grouped by type, and an **agentic query** that walks the subgraph instead of BM25-matching keywords. For the full why, see **[An honest review of our Karpathy-inspired wiki](https://noqta.tn/en/blog/agentx-wiki-karpathy-honest-review-2026)**.

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
