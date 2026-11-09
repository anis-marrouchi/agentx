# Wiki query: reliability, usage, savings, first option (spike #1820)

**Status:** proposal for review. This change ships the measurement (a report over the trace ledger, per-agent and per-day counts in `wiki query-runs`) and fixes the two reliability faults the code shows. The numbers that need a live node are marked **to measure**, each with the exact command. Build issues for the "first option" work are listed at the end, to be opened once this is agreed.

## Summary

- **An agent can reach the wiki in three ways under two names.** Full chat sessions are told to run the CLI through Bash. Lean sessions (GitHub, agent-to-agent, workflow, cron) get one clause naming the MCP tool, and that tool is deferred behind ToolSearch. The workspace skill names the CLI. The **best path (the MCP tool) is the least advertised**, and the most advertised path (the CLI run from a workspace) runs without the node's settings.
- **Two faults explain most "crashes" and "no catalog" answers:** a `--dir` that points at a workspace made an empty wiki there, and a `--dir` that could not be written crashed with a stack trace. Both are fixed here. A model failure inside the tool came back as plain text, so neither Claude Code nor the trace ledger saw it as an error. It is now a tool error.
- **MCP tool calls are already counted:** every tool call of every turn is in the trace ledger (`task_trace_steps`), and every tool query is in `_query-runs.jsonl`. Nothing reported them. `surface_usage` counts only CLI commands run from the node's own folder, so agents' queries never show up there. That is why it showed 1.
- **Recommendation:** fix reliability first (this change), then make the tool the one named path (S), add a one-line wiki hint to lean sessions (S), and pre-fetch an answer for messages the intent classifier files as fact questions (M). Targets are in §6.

## 1. How an agent reaches the wiki today

| Session | What the agent is told | Path it uses | Runs with the node's `wiki.query` settings? |
|---|---|---|---|
| Full, fresh (chat channels) | `[Institutional Wiki]` block: catalog by type, then `node <cli> wiki query "…" --dir <wiki> --agent <id>` (`buildWikiContext`, `src/agents/registry.ts`) | Bash → CLI, with cwd = the agent's workspace | **No.** `loadQuerySettings()` reads `agentx.json` from the cwd. A workspace has none, so the defaults apply: no live sources, notes off, no intent-branch rank. |
| Full, resumed | Nothing new. The block is in the transcript from the first turn. | Same | Same |
| Lean (github, a2a, workflow, cron by default) | One clause in `[Context on demand]`: "stored knowledge (agentx_wiki_query)" (`onDemandContextNote`, `src/agents/session-profile.ts`) | MCP tool, after a ToolSearch to load its schema | Yes. The server runs with `--cwd <node folder>`. |
| Any Claude Code session | Workspace skill `.claude/skills/wiki/SKILL.md` ("Use `wiki query` BEFORE grep…"), auto-injected on trigger words | Bash → CLI | No (as above) |
| Codex | No wiki block | — | — |

The MCP tool is deferred in every Claude Code session (ToolSearch has been on since #700), so the model sees only its name until it searches for it. The description "Use this BEFORE grep/memory-search…" is read only after a ToolSearch has already picked the tool.

## 2. Reliability

### Failure causes found in the code

| Cause | Where | What the agent saw | Counted as failed? | State |
|---|---|---|---|---|
| `--dir` is a workspace, not the wiki | `WikiHub` constructor creates `agents/`, `raw/`, `_schema.md` | "No agent has a catalog yet", and an empty wiki left in the workspace | Yes, `no-catalog` in the **workspace's** stray `_query-runs.jsonl`, so the node never saw it | **Fixed:** a query opens only a folder that holds a wiki, or the `.agentx/wiki` inside a node's folder. Otherwise it says `No wiki at …` and exits 1, creating nothing. |
| `--dir` cannot be written (a file, a read-only mount, another user's folder) | Same `mkdirSync` | A Node stack trace (`ENOTDIR`, `EACCES`, `EROFS`): the reported crash | No: it threw before `timedQuery` | **Fixed** by the same check. Reproduced with a file as `--dir` (`ENOTDIR`). `EACCES` and `EROFS` take the same code path. |
| Model call failed or timed out | Each query is 2–3 `claude -p` calls: picker 60 s, live-read planner 60 s, answer 120 s (`src/wiki/model-call.ts`, `query-summaries.ts`) | `Query returned status "error": Selector: claude exited 1 …` as **normal text** | Yes in `_query-runs.jsonl`. **Not** an error in Claude Code or the trace ledger. | **Changed:** the tool now returns `isError: true` for `error` and `no-catalog`. |
| The wiki has no page for it | `no-candidates` | `Query returned status "no-candidates"` | No, by design | Kept. It counts against the hit rate, not the error rate. Before this change it read like an error, which likely inflated the issue's text match (~8 of 46). |
| CLI from a workspace ignores node settings | `loadQuerySettings()` / `sharedQueryEnabled()` read the cwd | Answers without live reads or notes, with no sign that anything is missing | No | Open. Option R1 (§5) removes this path for Claude Code sessions. |
| Bash denied by the session's permission mode or guard | Claude Code | A permission message | No | To measure: the report sorts these as `denied`. |

### How to measure the error rate (to measure)

Run in a terminal on the node. The report script lives in the repository, not in the installed package, so run it from an AgentX checkout and point it at the node's database:

```bash
cd <node folder> && agentx wiki query-runs --since 2026-11-02 --by agent      # tool + CLI queries that reached the wiki
cd <agentx checkout> && pnpm exec tsx scripts/wiki-query-report.ts --since 7d --path <node folder>/.agentx/db.sqlite   # every call in the trace ledger, with causes
```

`query-runs` is the authority for failures inside the query. The report also catches failures that never reached the wiki (crash, denied, wrong `--dir`), because it reads each call's result in the trace ledger and sorts it into `answer`, `no-answer`, `empty`, `no-catalog`, `timeout`, `crash`, `model-error`, `denied` or `other-error`. The sorting matches text, so a cause is a best guess. A result is paired with its call in order, because the ledger keeps no tool-use id on a result. The counts hold, but a single pairing can swap between two parallel calls.

## 3. Usage

### What AgentX already records

| Record | Has | Missing |
|---|---|---|
| Trace ledger: `task_traces` + `task_trace_steps` in `.agentx/db.sqlite` | Every tool call of every AgentX-run turn, MCP included (`action = mcp__agentx__agentx_wiki_query`), its input (≤ 8 KB) and the start of its result. The turn's agent, start time and Claude Code session. | Sessions AgentX did not start (an owner's own Claude Code using `agentx serve`) |
| `_query-runs.jsonl` in the wiki folder | Every tool and CLI query that reached the wiki: time, agent, status, method, source, wall time | Question, answer, turn. Queries pointed at the wrong `--dir` (fixed now) |
| `surface_usage` | CLI commands run **from the node's folder** | Anything an agent runs from its workspace |

So no new MCP counter is needed for agent sessions. A per-call write to `surface_usage` from each MCP server process was considered and dropped: `openDb` sets no busy timeout, so every tool call could wait up to 5 s behind the daemon's writes, and the ledger already has the data.

### Built in this change

- `agentx wiki query-runs --by agent|day`: per-agent and per-day counts and failures. The JSON always carries `byAgent` and `byDay`.
- `scripts/wiki-query-report.ts` (read-only): turns and sessions in the window, the share with a wiki query, calls by kind (`tool`, `cli`, `lookup`, `patch`), per agent and per day, outcomes by cause, median result size, and **what the agent did in its next three calls after an answer** (search, ask, read, ask again). That last figure is the savings proxy in §4.

Definitions: a **turn** is a `task_traces` row. A **session** is its Claude Code session (`final_session_id`, else `resume_session_id`, else the turn on its own). The issue's ~2,900 "sessions" were most likely turns. The report prints both.

### Numbers (to measure)

| Figure | Issue's first check (one node, 7 days) | Re-measure with |
|---|---|---|
| Sessions / turns in window | ~2,900 | report: `turns`, `sessions` |
| With a wiki query | 48 (~1.6%) | report: `turnsWithQuery`, `sessionsWithQuery` |
| `agentx_wiki_query` calls | 163 | report: `calls.tool`, and `query-runs` `from: tool` |
| `wiki query` via Bash | not split out | report: `calls.cli` |
| `agentx_lookup` / `agentx_wiki_patch` | 82 / 30 | report: `calls.lookup` / `calls.patch` |
| Error share | ~8 of 46, crude | report: `failed` and `outcomes`; `query-runs` failed |
| Median result | ~1.5k chars | report: `resultCharsP50` (capped by the 8 KB step clip) |
| Seats using it | "PM, one coding seat, DevOps" | report: `byAgent` |

This spike ran in a cloud session with no access to the node, so this column is not filled here. The owner fills it by running the two commands above on the node.

## 4. Graded sample and savings

### 30-query graded sample (protocol)

1. **Terminal, in an AgentX checkout:** `pnpm exec tsx scripts/wiki-query-report.ts --since 30d --path <node folder>/.agentx/db.sqlite --sample 30 --out ~/wiki-grading.json`. It takes distinct past questions, round-robin across agents, newest first. The file holds real questions, so keep it outside the repository.
2. For each question, mark the answer the agent got then (its result is in the trace; `agentx trace show <task>` prints it): **correct**, **partial**, **wrong**, **no answer**, or **error (cause)**. Mark **wrong tool** when the question needed no stored knowledge (for example "what does this function do"). Leave those out of the hit rate.
3. For each question that is not marked wrong tool, write the facts a correct answer contains into `expect`. Then run `agentx wiki score --questions ~/wiki-grading.json --agent <agent> --out ~/wiki-score-now.json`, one agent's questions at a time. This scores today's wiki on the same questions and records the time and cost of each query.
4. Hit rate = correct ÷ (graded − wrong tool). Report wrong answers separately: they cost more than a miss.

### Savings model

What a query that answers replaces, with **assumed** costs until the sample replaces them:

| Without the wiki the agent would… | Assumed cost | Measured by |
|---|---|---|
| search the workspace (Grep, `rg`, Read) | 3–6 tool calls, 1–3 min, ~20–60k input tokens (context re-read per call, mostly cached) | grader's call per question; the report's "after an answer: search" |
| ask another agent (`agentx_send_agent`) | one full turn on their side (their context, typically 20–60k tokens) plus 5–30 min waiting | same |
| ask the owner | 2–10 owner-minutes, 30 min–hours waiting, an interruption | same |

A query costs 2–3 model calls (picker and planner on Haiku, answer on Sonnet) with 10–40 s wall time. `wiki score` prints the measured seconds and dollars per question.

Per week: **saved = Σ answered × Σ P(alternative) × cost(alternative) − queries × query cost − wrong × cost(wrong)**. A wrong answer costs a rework turn, and an owner correction when it reached a person.

Illustration only, with the issue's 163 queries and assumed shares (60% useful answers, alternatives 60% search / 30% ask an agent / 10% ask the owner):

- ~98 useful answers × (0.6 × 2 min + 0.3 × 10 min + 0.1 × 35 min) ≈ 750 agent-minutes of waiting and searching saved, and ≈ 50 owner-minutes.
- At 10% wrong: ~16 wrong answers × one rework turn each, plus owner time for the ones that reached a person.

The measured proxy that keeps this honest is **"search or ask right after an answer"** from the report. If agents search anyway after a good answer, the query saved nothing.

## 5. Making it the first option

What Claude Code offers was checked first:

- **Tool description:** read only after ToolSearch picks the tool. All agentx tools are deferred, so the description cannot pull the model in. It only ranks the tool within ToolSearch results.
- **Skills:** already shipped (`.claude/skills/wiki`, trigger words) and auto-injected by AgentX on a trigger match. They name the CLI.
- **Hooks:** AgentX already runs a `PreToolUse` guard and a `PostToolUse` `/runs/inbox` hook that adds context after every main-thread tool call (#1817 §4). A nudge can ride that hook with no new install.
- **SessionStart / injected context:** AgentX builds the fresh-session prompt itself, which is the cheapest lever.

Ranked by expected effect per cost:

| # | Option | Cost | Expected effect | Notes |
|---|---|---|---|---|
| R0 | Reliability fixes in this change | done | Error share down; no stray wikis; failures visible | Prerequisite: an agent that hits errors stops asking. |
| R1 | **One named path:** the `[Institutional Wiki]` block and the workspace skill name `agentx_wiki_query` (CLI kept as the fallback for Codex and for sessions without the agentx server) | S | High in full sessions: one call instead of Bash plus flags; runs with live sources, notes and intent rank; no `--dir` to get wrong | Add `agentx_wiki_query` to the names a shortened tool list keeps (it already is, through `AGENTX_ON_DEMAND_TOOLS`). |
| R2 | **Lean hint:** one line in lean prompts, "The wiki knows N pages on people, projects, decisions… Ask `agentx_wiki_query` before you search or ask a colleague." | S (~40 tokens) | Medium–high: lean sessions are most turns and today get one clause among six | Fresh sessions only, like the catalog block. |
| R3 | **Pre-fetch for fact questions:** when the intent classifier files a message as who / what happened / what was decided / how we do X, the daemon starts a wiki query in parallel with the turn and hands the answer in through the `/runs/inbox` hook at the first tool call, framed as data with its citations | M | Highest for those messages: the agent does not have to choose | Costs one query per such message (measure the share first; the classifier already logs paths). Skip when the answer is `no-candidates`. Never blocks the turn. |
| R4 | **Nudge after the first search:** in the `PostToolUse` hook, after the first Grep, Glob or `rg`/`grep` Bash call in a turn with no wiki query yet, and only for a fact-question intent path, add "the wiki may already know this: agentx_wiki_query" once | M | Medium. Risk of noise in coding seats, where a grep is about code; hence the intent gate and once per turn | A `PreToolUse` deny was considered and rejected: blocking a search is worse than a missed query. |
| R5 | Role default in the generated `CLAUDE.md` (PM, CX, DevOps: "start with the wiki for who / what / when / how") | S | Low–medium; static text fades over a long session | Cheap to add with R1. |
| R6 | Rewrite the tool description | S | Low (deferred; see above) | Do it as part of R1 so ToolSearch ranks it for "who / decided / how do we". |

## 6. Recommendation and targets

Do R0 (this change), then R1 + R2 + R5 as one small build, measure for a week, then R3. Hold R4 unless R3 leaves a gap.

Targets, all read from the report and `query-runs`:

| Measure | Target | After |
|---|---|---|
| Failed share of queries that ran (`failed` ÷ answered results) | under 3% per week | R0 |
| Graded hit rate (30-question sample) | 70% correct or better; wrong 10% or less | wiki content work, re-graded monthly |
| Turns with a wiki query, among turns the classifier files as fact questions | 50% or more | R1–R3 |
| Turns with a wiki query, all turns | from ~1.6% to 8% or more | R1–R3 |
| Search or ask within 3 calls after an answer | 25% or less | R1–R3 |
| Query wall time p50 / p95 (`query-runs`) | 15 s / 45 s or less | — |

## Follow-up build issues (to open once agreed)

- **A. One named path (R1, R5, R6):** `buildWikiContext` and `src/wiki/SKILL.md` name `agentx_wiki_query` first; the CLI line stays for Codex and for runs without the agentx server; role defaults in `generateClaudeMd`; tool description lists the question kinds.
- **B. Lean hint (R2):** one line with page counts by type in the lean prompt, fresh sessions only.
- **C. Pre-fetch (R3):** fact-question intent paths → parallel daemon-side query → `/runs/inbox` hand-in. Caps, data framing, and suppression when the agent already asked.
- **D. Search nudge (R4):** only if C leaves a gap.
- **E. Weekly wiki usage line:** the report's headline numbers on the Hub, so the targets in §6 are visible without a terminal.

## Check it worked

- `agentx wiki query "anything" --dir <an agent workspace>` prints `No wiki at …`, exits 1 and leaves the workspace as it was.
- `agentx wiki query-runs --by agent` lists each agent with its queries and failures.
- `pnpm exec tsx scripts/wiki-query-report.ts --since 7d --path <node folder>/.agentx/db.sqlite` prints turns, the share with a query, calls by kind, outcomes, and the per-agent and per-day tables.
- Each "Done when" item in #1820 maps to a section: numbers and method (§3), graded sample (§4, protocol; the run needs the node), savings (§4), ranked options (§5), note (this file).

## If something is wrong

- **The report says `no such table: task_traces` or cannot open the file:** `--path` must name the node's `.agentx/db.sqlite`; without it the script reads `.agentx/db.sqlite` under the current folder.
- **`calls.tool` is far below `query-runs`' `tool` count:** those queries came from sessions AgentX did not start (an owner's own Claude Code), which the trace ledger does not hold.
- **Many results are `other-error`:** read a few in `agentx trace show <task>` and add their text to `classifyResult` in `scripts/wiki-query-usage-lib.ts`.
- **A row in §5 looks wrong:** change it here; the build issues are written from that table.
