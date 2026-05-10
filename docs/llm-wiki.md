---
title: "AgentX as an LLM-Wiki implementation"
---

# AgentX as an LLM-Wiki implementation

> **Status:** ships all three Karpathy layers + agentic query + contradiction linter. Honest scorecard below.

[Karpathy's LLM-Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) describes a three-layer architecture for LLM-driven knowledge management: **raw sources** (immutable), **the wiki** (LLM-generated markdown with cross-references), and **the schema** (configuration that drives structure and workflows). AgentX's `src/wiki/` was built independently of the gist but converges on the same shape.

This page is an honest audit. It tells you exactly what AgentX does well, where it's only partial, and what would close the remaining gaps. If you're evaluating AgentX for institutional-memory use cases, this is the page to read.

## Three-layer mapping

| Karpathy layer | AgentX implementation | Where it lives |
|---|---|---|
| **Raw sources** | Immutable `WikiEntry` files at `.agentx/wiki/raw/entries/`. Stable ID scheme (e.g., WhatsApp JID-hash) means re-ingest is a no-op. | `src/wiki/store.ts` (`addEntry`, `listEntries`), `ingest-whatsapp.ts` |
| **The wiki** | Markdown articles with frontmatter (`type`, `related`, `tags`, `sources`). Seven canonical types (`person / project / place / concept / event / decision / pattern`) enforced at write time. Every overwrite snapshots prior content to `_versions/`. | `src/wiki/store.ts` (`writeArticle`), `src/wiki/types.ts` |
| **The schema** | Auto-generated `_schema.md` + `worldview.md` capture structure and the user's mental model. | `src/wiki/store.ts` (`ensureSchema`) |

## Three operations

| Operation | What AgentX ships | Notes |
|---|---|---|
| **Ingest** | Raw-entry capture + nightly **absorb** (`agentx wiki absorb`) that batches unabsorbed entries into one Claude call producing typed articles with wikilinks. | Karpathy's "incrementally build and maintain" — exactly. |
| **Query** | `agenticQuery()` walks the article graph (catalog → wikilink subgraph → synthesis) instead of BM25-matching keywords. Exposed as MCP tool `agentx_wiki_query` for Claude Code, Cursor, Windsurf. | The agentic walk is what Karpathy meant by "search wiki" — most ecosystem implementations are flat blob stores. |
| **Lint** | Structural pass (`agentx wiki lint`) — broken wikilinks, orphans, stubs, bloated articles, unsourced entries. | See **Contradiction linter** below for the semantic pass. |

## Scorecard

Honest 0–3 scoring, where 3 = exemplary, 2 = solid, 1 = partial, 0 = absent.

| Karpathy dimension | Score | Why |
|---|---|---|
| **Layer 1 — raw sources** | **3** | Immutable, stable IDs, durable on-disk layout. Re-ingest is idempotent. |
| **Layer 2 — wiki articles** | **3** | Typed spine (7 canonical types), wikilinks, immutable `_versions/` snapshots, `_index.md` catalog. |
| **Layer 3 — schema** | **2.5** | Schema document is generated and operational; missing version field + drift detection. |
| **Ingest** | **2.5** | WhatsApp ingestor is exemplary; no generic framework for Slack/email/webhook yet. |
| **Query** | **3** | Selector → wikilink walk → synthesis, permission-aware, MCP-exposed. |
| **Lint (structural)** | **2** | Comprehensive structural checks; semantic pass added separately (below). |
| **Schema-driven consistency** | **2** | `_schema.md` + `worldview.md` constrain absorb prompts; no drift detection or mesh-wide schema federation. |
| **Provenance** | **1.5** | Articles carry `sources: [entry-ids]`; missing span-level citations and edit-audit trail. |
| **Contradiction detection** | **2** (NEW — was 0) | `agentx wiki lint --semantic` ships an LLM-backed contradiction pass. See below. |
| **Token efficiency** | **2** | BM25 cache on disk; synthesis caps articles at ~8; missing read-dedup + mesh cache coherence. |
| **Enterprise extensions** | **0** | No ontology, no evidence layer, no runtime eval. Mesh sync exists but is read-only replication. |

**Composite ≈ 24 / 33 ≈ 0.73** — above the median ecosystem implementation per the gist's own commentary on SwarmVault, Synthadoc, Keel, llmwiki-compiler, and Link.

## Strongest claims AgentX can make publicly

1. **Production LLM-Wiki with typed-spine + agentic query.** Article-type discipline (7 canonical types) plus a wikilink graph walk is rare; most ecosystem implementations stop at a flat blob store with vector search.
2. **Multi-agent permissions on the wiki primitive.** Tri-state access (`public` / `shared` / `private`) is enforced on every read/write — none of the cited gist implementations ship this.
3. **Immutable raw + versioned articles.** Every overwrite snapshots prior content to `_versions/`. Yarmoluk's "stale-claim propagation" critique is partially defused: history is recoverable.
4. **MCP-exposed agentic query.** Cursor, Claude Code, and Windsurf can query the wiki directly through the Model Context Protocol — no other implementation cited offers this surface.
5. **Contradiction detection out of the box.** `agentx wiki lint --semantic` (see below) ships an LLM-backed pass that addresses Karpathy's spec requirement for runtime health feedback.

## Contradiction linter

Karpathy's spec calls out contradiction detection as runtime insurance — without it, a wiki becomes a cache of stale facts with no health feedback. AgentX ships this as `agentx wiki lint --semantic`.

```
$ agentx wiki lint --semantic --agent ksi-coding

  ksi-coding: 3 issues
    [≠] contradiction app/Filament/.../SupplierArticleResource.php ⟷ docs/eager-loading.md:
        [high] One article asserts the supplier eager-load is in the resource;
        the other says it lives in the global scope.
    [?] orphan concepts/sigma-cohomology.md: No other articles link to "Sigma Cohomology"
    [!] stub patterns/cron-throttle.md: Very short article — needs enrichment
```

**How it works** (`src/wiki/lint-contradictions.ts`):

1. Enumerates articles in the store (admin scope; no permission filter).
2. Filters to contradiction-prone types (`concept`, `decision`, `pattern` by default).
3. Builds candidate pairs scored by **wikilink overlap** — articles that already cite each other or share third-party links are far more likely to overlap on claims.
4. Batches articles (default 4 per call) and asks Claude (default `claude-haiku-4-5`) for any factual contradictions, in strict JSON.
5. Emits `type: "contradiction"` issues alongside the existing structural issues.

**Cost-bounded by design**: defaults are `maxArticles=40`, `maxPairs=20`, `batchSize=4`. With Haiku rates that's a few cents per agent per run. Run it nightly via cron alongside `agentx wiki lint`.

```
# Nightly cron example
0 3 * * * agentx wiki lint --semantic --model claude-haiku-4-5 >> ~/.agentx/lint.log
```

## Honest gaps (what AgentX does NOT yet do)

These are not promised. They are the next 0.5–1 point lifts on the scorecard.

1. **Span-level citations.** The absorb prompt could ask the LLM to emit `[entry-id:line-range]` anchors inside article content; lint could verify they resolve.
2. **Schema versioning + drift detection.** `_schema.md` should carry a `version: N` field; lint should warn agents on a stale version.
3. **Mesh cache coherence.** `MeshWikiClient`'s 30s TTL should key on article-content hash and auto-invalidate when sources publish.
4. **Generic ingest framework.** Today only WhatsApp and webhooks are first-class. Slack and email need bespoke adapters.

These will be addressed iteratively. None block the claims above.

## When AgentX is the right LLM-Wiki for you

- You run multiple agents (mesh or single-host) that need to share institutional memory.
- You care about `read-after-write` consistency, permissions, and version history.
- You want MCP-native query so existing Claude Code / Cursor sessions can reach the wiki.
- You self-host (a $5 droplet runs the whole stack).
- You care about cost — typed-article + agentic query is dramatically cheaper at scale than embedding-backed vector RAG.

## When you should pick something else

- You need enterprise SSO, multi-tenant audit, formal SOC-2 — pick a hosted product.
- You need ingest at petabyte scale with sub-second freshness — AgentX is built for SMB-scale corpora (1K–50K articles), not search-engine scale.
- You need real-time multi-user editing in the database sense — `gnusupport`'s point in the gist applies; this is a documentation system with LLM smarts, not a Confluence replacement.

## Further reading

- [The Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the source.
- [Journey 06: Shared wiki — compounding team knowledge](./journey/06-shared-wiki.md) — how to use it day-to-day.
- [An honest review of our Karpathy-inspired wiki](https://noqta.tn/en/blog/agentx-wiki-karpathy-honest-review-2026) — the lessons learned post.
