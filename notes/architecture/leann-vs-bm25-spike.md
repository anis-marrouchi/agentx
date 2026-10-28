# Spike plan: LEANN vs BM25 for memory and wiki recall (AR/FR/EN)

Issue: #1390. Status: **closed 2026-10-28, only the Arabic fix shipped** (see [Outcome](#outcome)). It was approved on 2026-10-26 for arms A, B and C (see [Approved scope](#approved-scope)). Harness: [bench/leann-1390/](../../bench/leann-1390/README.md).

## Outcome

Decided by the maintainer on 2026-10-27: "Only fix Arabic".

- Arm B's tokenizer shipped in `src/memory/bm25.ts` with #1491 (commit `8d73fbbd`), released in 0.184.0. Arabic and accented words are now kept, so Arabic notes can be found and French accents no longer cut words in two.
- On the spike's questions, arm B moved recall@5 from 30.0 to 43.3 overall, and from 0 to 40 for Arabic.
- No LEANN work remains. Arms C, D and C′ will not be run, and no semantic search setting is planned.
- The harness in `bench/leann-1390/` stays as a record. Its arm A now runs the fixed tokenizer, because it calls `src/memory/bm25.ts` as shipped. To reproduce the old baseline, run it on a commit before `8d73fbbd`.

The sections below are the original plan, kept unchanged for the record.

## Question

Does a meaning-based index (LEANN, <https://github.com/StarTrail-org/LEANN>) find the right memory fact or wiki article more often than our keyword search (BM25) when the question is in Arabic, French or English? If it does, is the gain worth a Python dependency, model downloads and more CPU per query?

## What the code does today

BM25 lives in `src/memory/bm25.ts` (hand-written Okapi BM25, k1=1.2, b=0.75). It ranks:

| Caller | What it searches | Fallback when nothing matches |
| --- | --- | --- |
| `src/agents/memory-store.ts` `findRelevant` | memory facts (keywords + content) | the most recent facts |
| `src/agents/patterns.ts` | learned patterns | none |
| `src/wiki/store.ts` `search` / relevance | article content, blended with graph path (`graph.retrievalWeights`, 0.6 graph / 0.4 bm25) | none |
| `src/wiki/query.ts` `rankCatalogPool` | title + tags catalog; feeds the wiki-rerank seat shortlist | branch-only, then catalog order |
| `src/wiki/contributions.ts` | duplicate detection for new pages | none |
| `src/agents/drift-detection.ts` | uses `tokenize` only | n/a |

`agentx rag` (`src/rag/lexical-index.ts`) is a separate per-agent index on MiniSearch. It is out of scope for this spike but can reuse the result.

### Finding: the tokenizer drops Arabic and breaks French

`tokenize()` runs `.replace(/[^a-z0-9\s]/g, " ")` after lowercasing. Every character outside ASCII becomes a space:

```text
tokenize("اجتماع الفريق يوم الاثنين")          → []
tokenize("Réunion d'équipe prévue lundi, facture payée")
                                               → ["union","quipe","vue","lundi","facture","pay"]
```

So today:

- **Arabic queries score zero against every document.** Memory recall falls back to "most recent facts". Wiki search returns only title-substring bonuses.
- **French words lose their accented letters.** "réunion" becomes "union", and "payée" becomes "pay", which collides with English "pay".
- The stop-word list is English only.

A comparison between LEANN and the current BM25 would therefore measure "semantic vs broken tokenizer", not "semantic vs keyword". The spike must include a fixed BM25 arm, or it answers the wrong question.

### Facts about LEANN that matter here

From its README (checked 2026-10-26):

- Python 3.10+, installed with `uv pip install leann`. CLI: `leann build`, `leann search`, `leann ask`, `leann watch`, `leann list`, `leann remove`. Python API: `LeannBuilder`, `LeannSearcher`. Ships an MCP server (`leann_mcp`).
- Backends: HNSW (default, recomputes embeddings at query time) and DiskANN.
- **Default embedding model is `facebook/contriever`, which is English-only.** AR/FR needs a multilingual model set with `--embedding-model` (sentence-transformers, Ollama, MLX or an OpenAI-compatible API).
- The README offers no hybrid mode, only an exact-match grep option. The source does have one: `LeannBuilder(prebuild_bm25=...)` and `search(vector_weight=...)`. Arm C keeps both at their defaults (off, 1.0), so it is pure semantic search.
- `SearchResult.id` is LEANN's own passage number, so arm C stores our note id in metadata and reports that.
- Metadata filters exist (`metadata_filters` on `search()`), which can carry agent scope / visibility.
- No per-document update or delete. `leann watch` reports changed files; the index is rebuilt (`--force`).
- Storage claims (91–97% smaller than FAISS) apply to corpora of 38K to 60M chunks. Our corpora per agent are hundreds to low thousands of short documents, where a plain vector file is already a few MB. **The storage win is probably irrelevant at our size; the trade we would actually pay is CPU per query.**

## Arms

All arms return a ranked list of document indexes for the same corpus and query, so they plug into the same harness.

| Arm | Description |
| --- | --- |
| **A. BM25 today** | `src/memory/bm25.ts` as shipped. The baseline. |
| **B. BM25, Unicode tokenizer** | Same scoring. Tokenizer uses `\p{L}\p{N}`, NFKC, strips French accents for matching, normalizes Arabic (remove tashkeel and tatweel, unify alef forms إأآ→ا, ى→ي, ة→ه), adds FR and AR stop words, and keeps 2-letter tokens for Arabic. No new dependency. |
| **C. LEANN, multilingual model** | HNSW backend, recompute on. Two models: a small one (`intfloat/multilingual-e5-small` or similar, ~120 MB) and a stronger one (`BAAI/bge-m3`, ~2 GB). Local only; no embedding API, so memory content never leaves the machine. |
| **D. Hybrid B + C** | Reciprocal rank fusion (k=60) of B and C. This is the realistic production shape if C wins, because exact names, IDs and codes are BM25's strength. **Not approved.** |

Optional control: **C′ = same model, plain flat cosine search in-process** (no LEANN). It separates "embeddings help" from "LEANN specifically helps". If C′ ≈ C at our size, we do not need LEANN's graph index at all. **Not approved.**

## Approved scope

Approved by the maintainer on 2026-10-26 (#1390):

- Arms **A, B and C** as written above. D and C′ need a separate yes.
- **LEANN runs only on the DO box, through devops-agent.** Arms A and B run anywhere.
- The optional MCP coding-seat trial (`leann_mcp`) is not part of this yes.
- The spike is also episode 1 of the video series "We tested it on AgentX". Every run keeps:
  - its raw per-question results with timestamps (`results-*.jsonl`);
  - the exact commands (`COMMANDS.md`);
  - an asciinema recording (`.cast`).
  Anything said in the video must trace back to these files. On screen we show note ids and scores, never the content of private notes.
- Files live in `dev-session-workspace/state/leann-1390/`, outside this repository.
- Questions: 10 Arabic and 10 French/mixed, drafted by the marketing agent. The maintainer labels them and freezes the redacted snapshot.
- Targets: A and B results by 2026-10-27 12:00Z, if the questions arrive by 08:00Z. Full write-up with C and a recommendation by 2026-10-28 18:00Z, depending on the DO batch slot.

## Test set

The approved run uses the 20 labelled questions on the frozen, redacted snapshot. Format and freezing recipe: [bench/leann-1390/README.md](../../bench/leann-1390/README.md). `bench/leann-1390/demo/` holds a 12-note, 12-question made-up snapshot for trying the commands. It is not evidence.

The larger synthetic set below (about 150 facts, 60 articles, 180 questions) is not part of this run. It is the next step if 20 questions leave the answer open.

Question types (the `type` field), for both sets:

- `same-lang-exact`: shares keywords with the target (BM25 should win).
- `same-lang-paraphrase`: same meaning, different words ("facture réglée" → "paiement reçu").
- `cross-lang`: query in one language, answer stored in another (EN question, FR fact).
- `arabizi`: Arabic written in Latin letters with digits (3, 7, 9), common in chat.
- `morphology`: Arabic prefixes/suffixes (ال، و، ب، ـها) and French plurals/genders.
- `identifier`: names, ticket IDs, amounts, hostnames from the fixture (BM25 should win).

## Metrics

Per arm, split by language and query type:

- Recall@3 and recall@5 (memory injection uses up to 8 facts; the wiki shortlist is small).
- MRR.
- "Zero-result rate": how often the arm returns nothing and the caller falls back.
- Query latency p50/p95 on a small VPS-class node (2 vCPU, no GPU) and on a laptop.
- Peak RAM during query, index build time, index size on disk.
- Install footprint: Python packages + model download size.

## Decision rule

Proposed, to be agreed before reading the results. Rules 1 to 3 cover the approved arms. Rules 4 and 5 apply only if D and C′ are approved later.

1. If **B** closes most of the gap (within 5 points of C on recall@5 overall and on AR), ship B only. No new dependency.
2. If **C** beats B by ≥10 points recall@5 on `paraphrase` + `cross-lang` and p95 query latency stays under 300 ms on the DO box, propose D (hybrid) as the next spike, not C alone. C alone is expected to lose on `identifier` and `same-lang-exact`, and production would keep BM25 for those.
3. Otherwise, ship B and close the semantic question for now.
4. Adopt a semantic arm only if **D beats B by ≥10 points recall@5 on `paraphrase` + `cross-lang`** without losing more than 2 points on `identifier`/`same-lang-exact`, **and** p95 query latency stays under 300 ms on the VPS-class node.
5. If C′ (flat vectors) is within 2 points of C, prefer flat vectors over LEANN: simpler, no graph rebuilds, and storage is not our constraint. LEANN specifically wins only if it beats C′ on quality or memory use at our real corpus sizes.

**Sample size.** With 20 questions, one question is 5 points overall and 10 points within a 10-question language group. A 10-point gap inside one language is a single question. The write-up reports counts (for example, 7/10) next to every rate, and treats a gap of one or two questions as "no difference".

## If it goes ahead: integration shape (for discussion, not built)

- Keep BM25 as the default and the fallback. Semantic search is opt-in per node, for example `memory.search.mode: "bm25" | "hybrid"`, following the "settings default off" pattern in `src/daemon/config.ts`. A new setting needs a docs page in the same PR.
- Run the embedder as an optional sidecar (Python process or `leann_mcp`) the daemon calls over a local socket. If it is down or not installed, fall back to BM25 and say so in the doctor output, the same way unreachable nodes degrade elsewhere.
- One index per agent, carrying `agentId` and visibility as metadata, so `canRead` scoping in `WikiStore` is enforced at query time, not just after.
- Rebuild on change, debounced, because LEANN has no per-document update. Measure rebuild time on the fixture to see whether that is acceptable for memory, which changes on every conversation.
- Fusion lives in one place (a small `rankHybrid` next to `scoreAll`) so every caller in the table above can switch without its own copy.

## Risks

- **Stack fit.** AgentX is Node/TypeScript; LEANN adds Python 3.10+, `uv`, PyTorch-class dependencies and model downloads (hundreds of MB to ~2 GB) on every node that enables it.
- **CPU per query.** Recompute-on-query trades disk for CPU. Small nodes that also run agents may feel it.
- **Model quality on Arabic dialects and Arabizi** is not covered by any LEANN benchmark; this spike is the first evidence we would have.
- **Privacy.** Only local embedding models are allowed in the spike. An embedding API would send memory content off the machine.
- **Project maturity.** LEANN is young and moving fast. Pin a version if adopted.

## Steps and timebox

1. Harness: done, in `bench/leann-1390/`. It covers arms A and B (`pnpm bench:leann run`), arm C (`arm_c_leann.py`), recording (`record.sh`) and grading (`pnpm bench:leann grade`). Arm B's tokenizer lives there, not in `src/`.
2. Questions drafted, labelled, and the snapshot frozen (by 2026-10-27 08:00Z).
3. Run and record A and B on the snapshot; post the graded tables (by 2026-10-27 12:00Z).
4. devops-agent runs and records C on the DO box with both models (DO batch slot).
5. Write results back into this file with a recommendation (by 2026-10-28 18:00Z).

## Out of scope

- Shipping any of this to `src/`, including the tokenizer fix, until the maintainer approves a recommendation.
- Arms D and C′, and the `leann_mcp` coding-seat trial.
- `agentx rag` MiniSearch indexes, which can reuse the result later.
- LLM re-ranking changes (the wiki-rerank seat stays as is and simply receives a better shortlist).
