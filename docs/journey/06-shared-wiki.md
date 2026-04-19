---
title: "6. Shared wiki — compounding team knowledge"
---

# 6. Shared wiki — compounding team knowledge

> **Status:** full Karpathy/Farzapedia pattern shipped — ingest + absorb + query + prune + migrate all live

The wiki pipeline today follows the pattern Karpathy and Farza actually described: typed articles (`person / project / place / concept / event / decision / pattern`), `[[wikilinks]]` as the primary navigation surface, an `_index.md` catalog grouped by type, and an **agentic query** that walks the subgraph instead of BM25-matching keywords. For the full why, see **[An honest review of our Karpathy-inspired wiki](https://noqta.tn/en/blog/agentx-wiki-karpathy-honest-review-2026)**.

## The five verbs

| Verb | When |
|---|---|
| `ingest` | Continuous — every conversation writes a raw entry. Cheap, source of truth. |
| `absorb` | Nightly cron — compiles recent raw entries into typed articles with `[[wikilinks]]` and updates `_index.md`. |
| `query` | Agent-invoked — walks the catalog + wikilink graph, synthesizes a cited answer. |
| `migrate` | One-shot — backfills `type` + `related` on legacy articles (after a major upgrade). |
| `prune` | One-shot — collapses legacy per-mode dirs into canonical `graph/`. |

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
