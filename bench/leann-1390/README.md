# LEANN vs BM25 spike (#1390)

Measures how often memory and wiki search find the right note for Arabic, French, mixed and English questions. Three arms are approved:

| Arm | What runs | Where |
| --- | --- | --- |
| A | BM25 as shipped (`src/memory/bm25.ts`) | any machine |
| B | The same BM25 with a Unicode tokenizer (`tokenizeUnicode` in `lib.ts`) | any machine |
| C | LEANN, HNSW backend, recompute on, a multilingual model | **the DO box only, through devops-agent** |

The plan, the decision rule and what is out of scope are in [notes/architecture/leann-vs-bm25-spike.md](../../notes/architecture/leann-vs-bm25-spike.md).

Every run leaves three things in the state folder, and anything said about the spike must trace back to them:

- `results-<run_id>.jsonl`: one line per question with a timestamp, the note ids and scores returned, and the rank of the right note. No note or question text.
- `COMMANDS.md`: the exact command of every run, with the commit and the snapshot hash.
- `casts/<run_id>.cast`: the asciinema recording of the run, when started with `record.sh`.

## The state folder

```text
<state-dir>/                      e.g. dev-session-workspace/state/leann-1390/
  snapshot/
    corpus.jsonl                  frozen, redacted notes (never committed)
    questions.jsonl               labelled questions (never committed)
  results-<run_id>.jsonl          one per finished run
  results-<run_id>.jsonl.partial  a run still going or interrupted; ignored by grade
  run-<run_id>.meta.json          arm C only: model, LEANN version, build time, index size, memory
  leann-index/                    arm C indexes, one folder per model and snapshot
  casts/<run_id>.cast
  COMMANDS.md
```

`corpus.jsonl`, one note per line:

```json
{"id": "mem-0042", "kind": "memory", "text": "invoice payment Client Example Corp paid invoice INV-2041 ..."}
```

- `id` is what goes on screen. Use the note's own id (memory fact id, wiki path), or a neutral alias.
- `kind` is `memory` or `wiki`. A question with `kind` set searches only that pool, as the product does.
- `text` is what the product indexes: for a memory fact, `keywords.join(" ") + " " + content` (`MemoryStore.findRelevant`); for a wiki article, its content (`WikiStore.search`).

`questions.jsonl`, one question per line:

```json
{"qid": "ar-01", "lang": "ar", "type": "same-lang-paraphrase", "kind": "memory", "query": "...", "expected": ["mem-0042"]}
```

- `lang`: `ar`, `fr`, `en` or `mixed`.
- `type`: `same-lang-exact`, `same-lang-paraphrase`, `cross-lang`, `arabizi`, `morphology` or `identifier`.
- `expected`: the note ids that answer it. A hit is any of them in the top results.

Every run checks the snapshot first: duplicate ids, unlabelled questions and expected ids missing from the corpus stop it before it starts. The snapshot hash (sha256 of the two files) is written on every result line, so a number can always be traced to the exact snapshot.

`demo/snapshot/` is a small made-up snapshot with neutral content, for trying the commands.

## Run arms A and B

Terminal, from the repository root:

1. Record arm A: `bench/leann-1390/record.sh <state-dir> A`
2. Record arm B: `bench/leann-1390/record.sh <state-dir> B`

Without a recording (for a dry run): `pnpm bench:leann run <state-dir> --arm A` (or `--arm B`). Add `--k <n>` to keep more than the top 10.

Pass `<state-dir>` as a relative path: it is copied into `COMMANDS.md` as typed, and that file may go on screen.

## Run arm C on the DO box

devops-agent runs these. Terminal, on the DO box, from the repository root:

1. Install LEANN in a virtual environment: `uv venv && uv pip install leann asciinema`
2. Activate it: `source .venv/bin/activate`
3. Copy the frozen `snapshot/` into the state folder on the box.
4. Record the small model: `bench/leann-1390/record.sh <state-dir> C --model intfloat/multilingual-e5-small`
5. Record the large model: `bench/leann-1390/record.sh <state-dir> C --model BAAI/bge-m3`
6. Copy the new `results-*.jsonl`, `run-*.meta.json`, `casts/` and `COMMANDS.md` back to the state folder.

Notes:

- Never use LEANN's default model (`facebook/contriever`): it is English only.
- e5 models get the `query: ` and `passage: ` prefixes they were trained with. Override them with `--query-prefix` and `--passage-prefix`.
- LEANN's keyword index stays off (`prebuild_bm25` off, `vector_weight` 1.0). Mixing it in would be arm D, which is not approved.
- Each index is built once per model and snapshot, then reused. `--rebuild` forces a new build.
- `run-<id>.meta.json` reports peak memory of the runner and its finished children. LEANN may embed in a separate server process that these figures miss. For the full figure, also run the arm under `/usr/bin/time -v` and keep that output next to the meta file.

## Grade

Terminal, anywhere the result files are:

1. All runs, overall: `pnpm bench:leann grade <state-dir>`
2. By language: `pnpm bench:leann grade <state-dir> --by lang`
3. By question type: `pnpm bench:leann grade <state-dir> --by type`
4. Question by question, for the video: `pnpm bench:leann grade <state-dir> --questions`

Add `--json` for machine-readable output. Columns:

- `recall@3` / `recall@5`: share of questions with a right note in the top 3 / top 5.
- `mrr`: mean of 1 / rank of the first right note (0 when it is missing).
- `zero-result`: share of questions where the arm returned nothing. In the product, memory search then falls back to the most recent facts.
- `p50 ms` / `p95 ms`: query time with the index already loaded.

## What goes on screen

Show `grade` output, result lines, `COMMANDS.md` and casts. They hold note ids, scores and numbers only. Never open `snapshot/` on screen: it holds the notes themselves.

## Check it worked

1. Terminal: `D=$(mktemp -d) && cp -r bench/leann-1390/demo/snapshot $D/`
2. Terminal: `pnpm bench:leann run $D --arm A && pnpm bench:leann run $D --arm B`
3. Terminal: `pnpm bench:leann grade $D --by lang`
4. The table has one row per run and language. On the `ar` rows, arm B shows a higher recall than arm A.
5. Terminal: `pnpm vitest run test/eval/leann-1390.test.ts` passes.

## If something is wrong

- **`expected id not in corpus`**: a label names a note that is not in `corpus.jsonl`. Fix the label or the snapshot, then run again.
- **`no results-*.jsonl`**: no run has finished. A run that stopped half way leaves only a `.partial` file, which `grade` ignores; run the arm again.
- **`warning: runs cover N different snapshots`**: the folder mixes runs from different snapshots. Compare only runs that share a hash.
- **`leann is not installed`**: activate the virtual environment from step 2 of arm C.
- **`asciinema is not installed`**: `record.sh` stops rather than run without a recording. Install it, or use `pnpm bench:leann run` for a dry run.
