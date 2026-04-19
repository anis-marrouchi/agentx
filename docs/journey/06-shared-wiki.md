---
title: "6. Shared wiki — compounding team knowledge"
---

# 6. Shared wiki — compounding team knowledge

> **Status:** ingest + query shipping · absorb **deprecated** · procedure-delta replacement planned

::: warning Absorb is deprecated
The original plan was a nightly `agentx wiki absorb` cron that LLM-compiles raw entries into articles. In practice the articles it produced were retrieved by BM25 + tag overlap, which rarely returned a meaningful hit for real agent traffic — we were paying big and reading small. Read the full evaluation: **[An honest review of our Karpathy-inspired wiki](/blog/wiki-karpathy-review)**.

Raw-entry ingest is untouched (cheap, useful). `agentx wiki absorb` is now gated behind `--force`; a focused replacement tied to the upcoming intent knowledge graph is planned.
:::

## What still works today

- **Ingest** — every conversation is written to `.agentx/wiki/raw/entries/` as a Markdown file with frontmatter. Cheap, continuous, the source of truth.
- **Query** — `agentx wiki query <question>` searches existing articles via BM25 + tag match.
- **Browse** — `agentx wiki serve` opens a Wikipedia-style local browser.
- **Sync** — `agentx wiki sync` pulls raw entries from mesh peers.
- **Permissions** — `public` / `shared` / `private` per article, enforced on read/write.

## What's deprecated

- **Absorb** (`agentx wiki absorb`) — LLM batched compile. Still callable with `--force` if you genuinely want it; the default cron in the example config is `enabled: false`.
- The three absorb modes (`unified`, `flat`, `graph`) all had the same retrieval problem — the issue was never the prompt, it was the retrieval side.

## What's coming

A **procedure-delta** flow tied to the intent knowledge graph (Procedures + fixed-axis taxonomy). When a message runs a known Procedure, the agent produces a 1-line delta against the Procedure's SOP — a proposed patch, reviewed in the admin approval queue. Cost: O(procedure-runs) with a small classifier-sized call, not O(entries × articles) with a giant compile call.

## References

- [Wiki CLI](/reference/cli#wiki) — every command still works; absorb is gated
- [Concepts → Wiki](/concepts#_5-wiki)
- [Honest review of the wiki approach](/blog/wiki-karpathy-review) — objective evaluation by Nadia
- Source: [`src/wiki/`](https://github.com/anis-marrouchi/agentx/tree/master/src/wiki) ([store.ts](https://github.com/anis-marrouchi/agentx/blob/master/src/wiki/store.ts), [prompts.ts](https://github.com/anis-marrouchi/agentx/blob/master/src/wiki/prompts.ts))
