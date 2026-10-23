# Benchmarks

Three levels, from free and every-commit to expensive and rare. Optimize
against the cheap ones; use the expensive ones to confirm.

| Level | Command | Cost | Answers |
|---|---|---|---|
| 0 | `pnpm bench:context` | free | How much context does agentx add before the model starts? |
| 0 | `pnpm bench:profiles` | free | What does the lean session profile save per channel and prompt section? |
| 1 | `bench/harbor/dev.sh` | ~$8 per run on Haiku | Does a change make agentx cheaper or worse on real tasks? |
| 1 | `pnpm bench:browser` | cents per run on Haiku and Sonnet; free with `--backend oracle` | Where does the time go when an agent drives the browser? |
| 1 | `bench/wiki-absorb.sh <wiki snapshot>` | one absorb backlog per variant | Is a wiki absorb change faster, cheaper or worse? |
| 1 | `pnpm bench:catch <labelled.jsonl>` | about $0.002 per reply on Haiku | How well does the promise catch read replies? |
| 2+ | `harbor run` directly, see [harbor/README.md](harbor/README.md) | $60 to $1,300+ | Publishable numbers on the full Terminal-Bench 2.0 |

## Level 0: context size

Runs the real `agentx exec` path against a fake `claude` and counts what
agentx hands it: the system-prompt preamble, the prompt around the task,
and the workspace files Claude Code loads on its own. No model is called.
Every token here is re-read on every model call of every task.

```bash
pnpm bench:context                 # estimate (~4 chars per token)
pnpm bench:context --exact         # exact, via the free count_tokens API
pnpm bench:context --budget 2000   # exit 1 above 2000 tokens
pnpm bench:context --channel github --sections   # one channel, one row per prompt section
pnpm bench:context --channel a2a --profile lean  # force the session profile
```

### Session profiles (#615)

`pnpm bench:profiles` measures the same thing twice per channel, with the
`full` and the `lean` session profile, and prints a table with the saving
per prompt section. By default it covers `github`, `a2a`, `workflow` and
`cron` on the third turn of a chat (`--warm 2`), which is when a full
session has a history and a cross-chat hint to push.

```bash
pnpm bench:profiles                               # the four lean-by-default channels
pnpm bench:profiles --channels github,telegram    # pick channels
pnpm bench:profiles --exact                       # exact counts (ANTHROPIC_API_KEY)
pnpm bench:profiles --config agentx.json --agent devops   # a real agent
```

It counts what agentx hands the session. Claude Code's own start (built-in
tool schemas, the skill list, user-level MCP tool schemas, the global
CLAUDE.md) is not visible to a fake `claude`; the `claude flags` row shows
which of it a lean session leaves out, and issue #615 has its measured size.

### Tool results (#621)

`bench/observation-pack-replay.py` reads the Claude Code session logs of a
fixed range of days and counts the tool results over the ObservationPack
limit: per tool and per channel, how many bytes they are and how many tokens
later requests re-read. No model is called. Use it to see what
`session.observationPack` can reach on a node before turning it on.

```bash
python3 bench/observation-pack-replay.py --from 2026-10-01 --to 2026-10-03
python3 bench/observation-pack-replay.py --from 2026-10-01 --to 2026-10-03 --limit 20480 --json replay.json
```

The token column is an estimate (bytes / 4, once per later request in the
same session log). It is an upper limit: it ignores compaction and what the
agent reads back from a saved original. The recorded cost per channel, before
and after, comes from `agentx usage channels`.

### Cache rewrites after a pause (#947)

`bench/cache-gap-replay.py` reads the same session logs and groups every
model call by how long it came after the previous call in its session:
under 5 minutes, 5 to 60 minutes, 1 to 24 hours, more than a day. For each
group it shows the cache writes and reads from the logs' own usage fields,
the share of writes already on the one-hour cache, and three what-ifs: every
write on the one-hour cache (`ttl1h`), every write on the five-minute
cache (`ttl5m`, the other direction, for a node on the subscription whose
writes are all on the hour), and a fresh start with a short brief after a
long pause (`rotate`). No model is called. It reads only the top-level
`*/*.jsonl` files and skips sidechain lines, so calls made by subagents are
not counted.

```bash
python3 bench/cache-gap-replay.py --from 2026-10-01 --to 2026-10-07
python3 bench/cache-gap-replay.py --from 2026-10-01 --to 2026-10-07 --rotate-after 60 --brief 8000 --json gaps.json
```

Costs are in units of one uncached input token of the call's own model,
with each model's cache-read rate. The `rotate` figure reprices only the
first call after the pause, and ignores what the brief leaves out. What
it found to look for, and why, is in
[results/token-research-947.md](results/token-research-947.md).

### Small reusable workflows (#928)

#928 is closed: the owner stopped both the whole-job workflow and the
reader trial on 2026-10-13, and nothing from it went live. What it
measured, and what is still open, is in
[results/workflows-928.md](results/workflows-928.md). Those figures come from
other scripts, and this one gives different shares on the same logs (the
page has both and the rule differences), so do not quote its output as the
#928 figures.

`bench/slice-replay.py` reads the same session logs and asks how much
folding a repeated run of tool calls into one call (a registered action, or
a short workflow that returns one result) could save. A run of 5 calls
folded into 1 is 4 model requests not made, so 4 re-reads of the context
not paid. No model is called.

```bash
# The count: slices of 2 to 5 calls seen in 5+ sessions on 2+ seats
python3 bench/slice-replay.py count --from 2026-10-09 --to 2026-10-12 --skip-repeats
python3 bench/slice-replay.py count --from ... --to ... --level kind --json count.json

# The test, step 1: outlines of 60 sessions spread over the seats, for a mining agent
python3 bench/slice-replay.py outline --from ... --to ... --sample 60 --out mine/
# Step 2: mark and price the agent's catalog on the sessions it did not see
python3 bench/slice-replay.py mark --from ... --to ... --catalog catalog.json --seen mine/seen.json --out marked/
# Step 3: read marked/hand-check.md (30 places) and write pass or fail on each
```

- A **seat** is one project folder under `~/.claude/projects`. A **slice**
  is named by the first command of each call (`bash:gh pr view`,
  `Edit:memory`, an MCP tool name), or with `--level kind` only by its kind
  (`shell`, `file`), which is too coarse for a script to run.
- `--skip-repeats` leaves out one command repeated in a row, which is the
  agent exploring.
- The low figure prices only the cache re-reads of the requests a fold
  removes; the high figure prices their whole cost. Both are shares of the
  window's spend at list price, from the same table as the dashboard (a
  test keeps the two equal).
- A catalog is a JSON list of `{"id": "...", "steps": ["regex", ...]}`; each
  step is matched against `label<TAB>arguments`, with numbers shown as
  `<n>`, so `"^bash:gh pr view\\t"` matches any PR number.
- Outlines and the hand check show each call's arguments cut at 120
  characters and never the tool output (`ahead --sample` is the exception, below), but they still hold commands and
  paths: keep them on the node.

It finds only calls in a row and in the same order. The stop rule from #928:
under 10% saved on unseen sessions, drop the token case for this form.

Two more commands cover the look-ahead form (the agent fixes its next 2 to
4 calls in one call and an engine runs them with no model):

```bash
# What one call costs by its place in a session, split into re-read, cache write, output and input
python3 bench/slice-replay.py calls --from 2026-10-09 --to 2026-10-12
# Windows of 2 to 4 calls whose later calls use nothing that first came back in a result inside the window
python3 bench/slice-replay.py ahead --from 2026-10-09 --to 2026-10-12
python3 bench/slice-replay.py ahead --from ... --to ... --known   # only sequences seen in 5+ sessions and 2+ seats
# Sample 240 of those windows for grading whether a check on a result would have decided the next step
python3 bench/slice-replay.py ahead --from ... --to ... --sample 240 --sample-out graded/
# Any command, with other prices (for example what the runtime reports per call)
python3 bench/slice-replay.py calls --from ... --to ... --prices runtime-prices.json
```

- `calls` sorts each request into the first call of a session, a tool call
  right after a message, a tool call inside a chain, and an answer with no
  tool. It also prints how often the agent already groups calls: several
  tools in one request, several commands in one shell line.
- `ahead` looks for named things (a path, a hash, a number of 2+ digits, a
  dotted or dashed identifier). A window counts as fixed when no later call
  in it carries one that first appeared in an earlier result of the same
  window. It also prints how many round trips sit in such windows. It cannot
  see a choice that depends on a result, so for steps fixed ahead it is an
  upper bound. On a graded sample (#928) it missed about half of
  the places where the next step used something the result gave (a line
  number, a file name, a commit), so its share is about twice the real
  one. Treat it as a loose ceiling. It is not one for a workflow that passes values between its
  steps, or for a batch that stops at the first failed check.
- `ahead --sample` writes `windows.jsonl`: each window's calls, the first 300
  characters of each result, and the agent's own text or thinking between
  them. Thinking is mostly not in the logs (a token count only), so most
  windows have no text between calls. A grader (a person or a model run separately) marks whether a check
  on the result would have decided the next step. No model is called here.
  The file holds the start of real tool output, so keep it on the node.
- `--prices` takes `{"<family>": {"input": ..., "output": ..., "cacheRead":
  ..., "cacheCreate": ...}}` and replaces those rates; the families are the
  keys `prices` prints. On 2026-10-13 the runtime's per-call cost for Opus
  5.5 was a fifth below AgentX's table (#928); which one matches the invoice
  is not checked.
- Removing a call does not save all of its cost. The results still come
  back to the agent and are written into the cache, so read the `write`
  column of `calls` next to the `ahead` saving.

One more command covers the reading design (a reader on a small model makes
the look-ups and returns a short note; the main model decides, edits and
answers):

```bash
# Spend by what each request does, and the stretches of 2+ reading calls in a row
python3 bench/slice-replay.py phases --from 2026-10-09 --to 2026-10-12
python3 bench/slice-replay.py phases --from ... --to ... --min-calls 3 --json phases.json
```

- A request is sorted by the strongest of its calls. **Changes something**
  is a file edit, a shell line that commits, pushes, merges, posts, moves,
  deletes, deploys or writes a file with `>`, or an MCP tool whose name
  creates, updates, sends or posts. **Reads plus a run** is a shell line
  that starts a program (`node`, `python3`, `make`, `pnpm <anything>`) or a
  sub-agent. **Only reads** is everything else. These rules read only the
  tool name and the command text, so check a sample before trusting a share.
- A reading stretch is a run of read-only requests in one chain. The result
  size is bytes / 4. What a reader would cost, and whether its notes are
  good enough, needs a real run and is not here.

These figures do not match the #928 results page, which came from the
developer seat's own scripts. `calls`, `ahead` and `phases` can switch each
of the four rules that may explain the gap, one at a time. The default is
the first choice of each, which gives what the PR #954 check reported:

| Option | Default | Other choice |
|---|---|---|
| `--first` | `file`: only the first request of a session file is a first call | `message`: so is every request right after a message |
| `--change` | `broad`: `cp`, `mkdir`, `tee`, a `>` redirect to a file, and MCP tools named add, set or update are changes | `narrow`: they are not |
| `--result-size` | `text`: only the text parts of a result count | `all`: images and other parts count too, at their length in the log |
| `--chain` | `message`: a chain ends at any message | `answer`: it ends only at a request with no tool call |

To find which rule closes the gap, on the node and window of the results
page (terminal, from the repository root):

1. Run `phases` with no rule option, and keep the output:
   `python3 bench/slice-replay.py phases --from 2026-10-09 --to 2026-10-12 --json base.json`
2. Run it again with one option changed, for example
   `--change narrow --json change.json`.
3. Compare the shares with the results page. Repeat step 2 for each option,
   then with the options that moved the shares together.

The JSON output has a `rules` field, and the first line of the printed
report names every rule set away from its default.

### The history block (#636, parked)

Pruning today's earlier messages with a Jev seat before a fresh session
starts was measured and parked: the block is sent on few turns and the
saving is cents a week. The numbers, the reasons and the conditions for
reopening are in [results/context-prune-636.md](results/context-prune-636.md);
the code stays on the branch `636-jev-context-pruning`.

## Level 1, small: AgentX against the bare CLI (#455)

`pnpm bench:compare` runs the same coding tasks on the bare Claude Code CLI
and through `agentx exec`, same model, same prompt, several times each, and
prints tokens, turns, wall time, the CLI's own cost figure and whether each
task came out right. Each task is a small Node project with failing tests
([compare-tasks.ts](compare-tasks.ts)); the check afterwards is mechanical
(the tests pass; no file under `test/` changed).

| Task | What the agent has to do |
|---|---|
| `fix-bugs` (default) | Fix four bugs the failing tests point at, in two files. |
| `implement` | Write two empty functions; the tests are the spec. |
| `trace` | Find four causes of a bug report across six files, with the rules in a README. |

```bash
pnpm build                                   # agentx exec runs from dist/
pnpm bench:compare                           # 3 runs each of claude, agentx, agentx-lean on Haiku 4.5
pnpm bench:compare --runs 10 --tasks all --model claude-sonnet-5-5 --json results.json
pnpm bench:compare --modes claude,agentx --tasks trace --keep
```

Every run calls the model and costs money (cents per run on Haiku). The
`claude` CLI must be signed in; both sides bill the same account. The modes:

| Mode | What runs |
|---|---|
| `claude` | `claude -p <prompt> --dangerously-skip-permissions` in a fresh copy of the project; no CLAUDE.md, nothing from AgentX. |
| `agentx` | `agentx exec` with one `claude-code` agent on the same copy, the managed workspace files written first as the daemon does, full session profile. |
| `agentx-lean` | The same with the lean session profile (#615). |

Runs are interleaved across tasks and modes so a slow hour hits every mode
alike, and `--json` rewrites the raw file after every run. The output ends
with a verdict per AgentX mode against the bare CLI: the ratio of median
tokens (and cost), a 95% bootstrap interval, and "uses less", "uses more"
or "no clear difference". The rule is written out in
[results/token-test-plan.md](results/token-test-plan.md).

The cost column is `total_cost_usd` as the CLI reports it (list price); the
`agentx` rows get it through `agentx exec --json` (`costUsd`).

### What it found (#455, parked)

On one-prompt coding tasks AgentX does not save tokens: after the fixes
the test led to, the lean profile costs the same as the bare CLI on Sonnet
5.5 (1.02 times the tokens) and the full profile about a tenth more; on
Haiku 4.5 ten runs a cell cannot tell them apart. The owner parked the
higher rungs of the comparison on 2026-10-05. The results, the product
changes they led to and the conditions for reopening are gathered in
[results/claude-code-comparison-455.md](results/claude-code-comparison-455.md).

## Level 1, small: browser driving (#1118)

`pnpm bench:browser` times one browser task, step by step, the way an agent
does it: open a registration form on a local test page, fill eight fields
(text, email, a country list, a radio button, a checkbox), submit, and read
back the reference number. The page is served by the bench itself on
`127.0.0.1`, with a search box and a newsletter "Email address" field as
decoys. The browser is the agent Chrome (`scripts/agent-chrome.sh`, debug
port 9222), driven through the real chrome-devtools MCP server, so snapshot
sizes and tool times are the ones an agent sees.

```bash
scripts/agent-chrome.sh                            # once: the agent Chrome on port 9222
pnpm bench:browser --backend oracle --runs 3       # no model: the browser-only floor
pnpm bench:browser --runs 3 --big claude-sonnet-5-5 --small claude-haiku-5-5   # needs ANTHROPIC_API_KEY
pnpm bench:browser --modes baseline,batch --runs 5 --out state/browser-spike
```

| Mode | How the task is driven |
|---|---|
| `baseline` | The big model picks one action per turn from a fresh snapshot; earlier snapshots stay in the conversation, as in an agent's context. |
| `picker` | The big model plans once in words ("the work email field"); the small model maps each target to a snapshot uid, one call per field; fills go one by one. |
| `batch` | As `picker`, but the small model maps every target in one call and the fills go out as one `fill_form`. |
| `oneshot` | The big model returns every uid in one call, then one `fill_form`. Separates the gain of batching from the gain of the small model. |

Each run records, per step: model think time and tokens, tool-call time,
the wait for the result page, and every snapshot re-read with its size.
Success is checked against what the test server actually received, not
against what the model says: a field that arrived wrong, or a newsletter
sign-up, counts as a wrong target. `--backend oracle` replaces the model
with a label lookup in code, which gives the floor no model can beat.
Raw timings go to `<out>/<time>/raw.jsonl` (default `state/browser-spike/`)
and the table to `summary.md` beside them. Other options: `--cdp <url>`,
`--mcp-bin <path to chrome-devtools-mcp.js>` (default: `npx
chrome-devtools-mcp@latest`), `--max-turns`.

### What it found (#1118)

A small-model picker saved 12% of the time and 74% of the cost on a small
form, with no wrong picks; the slowness is model round trips and slow
tool calls on the agent Chrome, not the picking. Not built as a speed
feature. The numbers, the owner's real-model run and the cheap wins
(close stray tabs, keep fill batching) are in
[results/browser-drive-1118.md](results/browser-drive-1118.md).

A follow-up hands a whole run of browser steps to a program in one tool
call (`browser_run`). The program calls the model back only to judge: an
unexpected page, an ambiguous target, a risky click. It cut time by
32–40% and cost by 62–81% against the baseline, with no wrong targets,
and passed all 10 guard cases. Its numbers are in the same file.

A second follow-up lets Jev decide each step: run it as a script, or send
it to the big model. That costs about 2 s and $0.0001 per run, and is
not faster than the runner alone. Jev caught 2 of 2 held-out risky
clicks that the word list missed. Same file.

## Level 1: dev set

Claude Code and agentx, same model (Haiku 4.5), same 8 Terminal-Bench tasks
([harbor/dev-set.txt](harbor/dev-set.txt)), 2 attempts each, both billed to
`ANTHROPIC_API_KEY` so the fleet's subscription quota is never touched.

```bash
export ANTHROPIC_API_KEY=...
bench/harbor/dev.sh baseline --yes   # once; reused until the model or task list changes
bench/harbor/dev.sh agentx --yes     # per change; built from this checkout
bench/harbor/dev.sh compare
```

Nothing runs without `--yes`; without it the script prints what the run
would cost. Jobs are cached by name (`dev-agentx-<commit>-<model>`), so an
unchanged commit is never paid for twice.

Reading `compare`:

- **cost / tokens B/A** is the number to optimize: a geometric mean over the
  tasks both sides solved, comparing each task to itself, with a 95%
  bootstrap interval. If the interval contains 1.00 there is no measurable
  change; run another agentx job or go to Level 2 before believing it.
- **solved tasks** is the guardrail. B solving 2+ fewer tasks than A is a
  regression whatever it saves, and `compare` exits 1.
- With 8 tasks, only changes of roughly 15% or more are detectable. That is
  the price of $8 runs.

## Level 1: wiki absorb (#808)

`bench/wiki-absorb.sh` copies a wiki snapshot once per variant, absorbs
the same pending entries with that variant's flags until nothing is left,
then writes a scorecard (`agentx wiki absorb-eval`) and a time and cost
summary (`agentx wiki absorb-runs`) for each one. The snapshot is never
written to.

```bash
cp -a .agentx/wiki /tmp/wiki-snapshot      # before the backlog is absorbed
bench/wiki-absorb.sh /tmp/wiki-snapshot                                   # baseline (--max 10) and batch20 (--max 20)
bench/wiki-absorb.sh /tmp/wiki-snapshot "baseline=--max 10" "batch15=--max 15"       # name=flags per variant
JUDGE=1 SAMPLE_N=30 bench/wiki-absorb.sh /tmp/wiki-snapshot              # add the model judge to each scorecard
```

A variant is any set of `agentx wiki absorb` flags, so a pipeline change
that adds a flag can be compared with today's run the same way.

Each variant calls the model for real, so a 975-entry backlog costs about
what one absorb of it costs, per variant. Use `SINCE`/`UNTIL` to bound the
entries, and `EXTRA=--no-facts` to skip the system-of-record lookups.
Results land in `$TMPDIR/wiki-absorb-<time>/<variant>/` (set `OUT` to
change it). Each variant folder holds a full copy of the wiki, so don't
commit it; copy only `scorecard.md` and `runs.json` into `bench/results/`.

## Level 1, small: promise catch (#1138 step E)

`pnpm bench:catch <labelled.jsonl>` runs the promise catch
(`src/requests/catch.ts`) over a labelled set of replies, with the same
word check, prompt and reader as the daemon, one `claude -p` call each on
the operator's own sign-in. It prints precision and recall for each of
`promise`, `waiting_owner` and `none`, the confusion table, and the cost and
time of one call. The step's proof of done asks a precision of at least 0.8
for `promise`.

One JSON object per line: `{"reply": "...", "asked": "...", "label": "promise", "at": <epoch ms>}`.
`at` is when the reply was written, so "tomorrow" reads as it did then.
Real replies hold private text: keep the labelled set outside the repo.

```bash
pnpm bench:catch ~/catch-eval/labelled.jsonl
pnpm bench:catch ~/catch-eval/labelled.jsonl --out verdicts.jsonl   # each verdict, to read the misses
pnpm bench:catch ~/catch-eval/labelled.jsonl --think                # the CLI's default thinking on
```

### What it found (#1138 E, 2026-10-23)

Real owner-facing replies from one node, 2026-10-15 to 10-23: 1,281
replies, of which 84% pass the word check (about 126 calls a day there).
Two sets, labelled by hand before the runs: 60 replies to shape the prompt
(35 with promise words, 25 without) and 40 held out (22 and 18), each
reply drawn at random. Haiku 4.5, no thinking:

| Set | `promise` precision | `promise` recall | `waiting_owner` precision | `waiting_owner` recall | Accuracy |
|---|---|---|---|---|---|
| Shaping, first prompt (no quote rule) | 0.78 (14/18) | 0.93 | 0.71 | 1.00 | 0.77 |
| Shaping, final prompt | 1.00 (15/15) | 1.00 | 0.76 | 1.00 | 0.87 |
| Held out, final prompt, one run | 1.00 (8/8) | 0.89 | 0.75 | 0.95 | 0.83 |

One call: about 1,400 tokens in, 55 out, $0.0017 at list price, 3.7 to 4.8 s.
With the CLI's default thinking on, a call wrote 600 to 3,500 tokens and
cost up to $0.019, so the daemon calls it with thinking off.

The first prompt's false promises were a conditional ("if it is, I will"),
an offer ("I can try again this afternoon"), a standing rule, and another
agent's report. The rule that a promise needs the reply's own sentence, in
the first person and the future, with no "if", removed them. The misses
left are on `waiting_owner`: a closing offer ("Do you want me to…?") read
as a question the work waits on.
