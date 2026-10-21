# Browser driving: where the time goes (#1118)

Status: measured, 2026-10-21. Spike only: nothing here changes AgentX.

**Verdict:** a small-model target picker is not worth building as a speed
feature on this evidence: 12% faster on a small form. It may be worth it as
a cost and robustness feature, at 74% cheaper, once large pages are tested.
The cheap wins are to close stray tabs on the agent Chrome and to keep fill
batching.

**Follow-up verdict:** handing a whole run of steps to a program
(`browser_run`, below) clears the bar. It cuts time by 32–40% and cost by
62–81%, with no loss in accuracy and with all 10 guard cases passing. The
next step is a PR that ports it into AgentX, with independent review.

## Follow-up: hand a run of steps to a program (dev-session, the owner)

**The prototype:** an MCP server in dev-session
`state/browser-spike/harness/rx_server.py`, with two tools:

- `browser_run(url, steps[], expect)` runs the steps in a single call.
  1. It resolves every target. It tries an exact visible-label match
     first, and calls Haiku 5.5 only for the targets left over, in one
     batched call.
  2. It checks the guards.
  3. It acts: all fills go out as one `fill_form`, then the clicks and
     key presses run in order.
  4. It checks the result (text, URL, title) and returns `ok` or
     `needs_judgment`.
- `browser_look` gives the model the page summary it needs to judge
  after a hand-back.

The runner hands back to the model without acting when:

- a target is missing, or matches two controls;
- the small model answers "none" or "ambiguous";
- a control closes a tab or window and the step did not ask to close (the
  same rule as `asksToClose` and `closes` in
  `src/computer-use/candidates.ts`);
- a click looks risky (delete, pay, publish and the like) and the step
  carries no `risky_ok`.

It acts and then hands back when:

- a fill failed (the form is then never submitted);
- the expected result is not on the page.

When a uid goes stale because the page re-rendered, the runner resolves
it again once, without calling the model.

**How it was measured:** 3 runs per cell, modes interleaved. Each run was
a fresh Opus 5.5 session on the agent Chrome, reached over an ssh tunnel.
An independent check over CDP read whether each run did the right thing;
the model's own report was not used.

| Task | Variant | Runs (s) | Mean | Model turns | Cost/run | Correct | Wrong targets |
|---|---|---|---|---|---|---|---|
| httpbin form | B: baseline | 32.2 / 25.8 / 39.8 | 32.6 s | 6 | $0.147 | 3/3 | 0 |
| httpbin form | R: runner | 20.9 / 17.2 / 20.5 | **19.5 s (−40%)** | 2–3 | **$0.028 (−81%)** | 3/3 | 0 |
| Wikipedia: open an article, search for another, check its heading | B: baseline | 26.3 / 31.4 / 39.6 | 32.4 s | 6–7 | $0.050 | 3/3 | 0 |
| Wikipedia | R: runner | 20.6 / 22.6 / 22.9 | **22.0 s (−32%)** | 2–3 | **$0.019 (−62%)** | 3/3 | 0 |

- **Every R run beat every B run.** The runner itself took 8–11 s and made
  no model call: all 18 targets matched their exact label. Model time fell
  from 15–28 s to 7–9 s.
- **One wasted turn:** in 3 of the 6 R runs, the model spent one extra
  turn re-checking a result the runner had already confirmed. Tool text
  that says "ok means checked" should remove that turn.
- **The large page:**
  - The Wikipedia article's snapshot is 528k characters and takes 6–17 s.
    The runner takes it once.
  - Baseline Opus never took it: it queried the page directly with
    `evaluate_script` instead. So on this page the saving comes from fewer
    round trips, not from fewer tokens.
  - A resolver that queries the page instead of snapshotting it would
    make R faster on large pages. Not built.
- **The guard suite passed 10 of 10.**
  - These cases handed back without pressing anything:
    - a close control, the step not asking to close;
    - the risky buttons `Delete account` and `Pay now`;
    - a missing target;
    - two `Save` buttons;
    - a login wall instead of the form;
    - an unpicked close button.
  - An unexpected result was pressed, then handed back.
  - Both control cases ran: a close the step asked for, and a risky click
    with `risky_ok`.
  - Because its name contains "run", `browser_run` counts as a tool that
    changes things. So AgentX's report-only mode still blocks it.
- **Limits:**
  - Only 2 tasks, one site each.
  - The tasks named exact labels, so the small-model path (about 1.4 s per
    batch) was not timed; only the guard suite exercised it.
  - Only fresh sessions with a small context were measured. Real sessions
    run at about 200k tokens, where every turn costs more.
  - The full path was never timed end to end: hand back, the model
    judges, then a second run.

## Real-model run (dev-session, the owner)

- **Browser:** the agent Chrome on CDP 9222, reached over an ssh tunnel to
  a Mac.
- **Agent:** `claude -p` with Opus 5.5, a fresh session per run.
- **Task:** the httpbin.org pizza form. Open it, fill 7 fields, submit,
  verify.
- **Check:** what httpbin received was checked independently over CDP.
- **Runs:** 3 per variant.

| Variant | Runs (s) | Mean | Model turns | Cost/run | OK | Wrong targets |
|---|---|---|---|---|---|---|
| B: baseline (Opus picks tools) | 31.3 / 25.1 / 29.5 | **28.6 s** | 5–6 | $0.144 | 3/3 | 0 |
| BS: one action per call | 41.3 / 43.8 / 46.0 | 43.7 s | 13–14 | $0.196 | 3/3 | 0 |
| **P: Opus plans, Haiku picks uids, one `fill_form`** | 23.7 / 25.9 / 25.9 | **25.2 s** | 4 | **$0.037** | 3/3 | 0 of 27 picks |
| PS: Haiku picks, one action per step | 32.9 / 33.4 / 36.9 | 34.4 s | 4 | $0.029 | 3/3 | 0 of 27 picks |

Where the baseline's 28.6 s go:

| Part | Time |
|---|---|
| Model turns | 16.4 s (about 2.6 s each) |
| `fill_form`, 8 fields | 6.0 s |
| Snapshots | 3.5 s |
| Verify re-read | 3.5 s |
| New page | 3.0 s |
| Submit | 1.0 s |

- **Snapshot size:** the form snapshot is small, about 300 tokens. But in 4
  of the 6 baseline runs, Opus also took a snapshot of the wrong tab: an
  open page of about 12.6k tokens on the agent Chrome.
- **Haiku picker speed:** a median of 1.4 s per batched call (at most
  2.9 s), and 1.1 s per single call.
- **Haiku picker accuracy:** no wrong picks out of 54.
- **Real sessions:** across 256 tool calls taken from real sessions, the
  median tool time (6.8 s) is larger than the model think time (2.7 s) per
  call, at about 213k tokens of context.
- **Raw data:** full write-up and raw timings are in dev-session
  `state/browser-spike/` (`RESULTS.md`, `timings.csv`, `runs/`,
  `harness/`).

### Reading

1. **The slowness is round trips.** A model turn costs 2–3 s. An input
   action through chrome-devtools costs 0.7–1.4 s on the agent Chrome.
2. **Opus 5.5 already batches** with `fill_form` without being told.
   Forcing one action per call (BS) is 53% slower than letting it choose.
3. **The picker's gain is cost more than time.** On this small form it
   saves 12% of the time and 74% of the cost. Pages with large snapshots
   are still untested; that is where a cheap picker would matter most.
4. **Stray tabs cost the most avoidable tokens.** A 12.6k-token snapshot of
   an unrelated tab is 40 times the size of the form itself.

## Floor: browser and MCP only (`pnpm bench:browser --backend oracle`)

This run used no model; the targets were matched by label in code. It ran
on headless Chromium 141 in a Linux cloud container (port 9222,
`--force-renderer-accessibility`) with chrome-devtools-mcp 1.11.0 over
stdio. The task was the bench's own local form: 8 fields, then submit,
then read back the reference number. Each mode ran 3 times, with the modes
interleaved. The table shows the median per run, in seconds.

| Mode | Success | Total | Tool calls | Page wait | Snapshot reads (time) | Model calls | Wrong targets |
|---|---|---|---|---|---|---|---|
| baseline | 3/3 | 2.66 | 2.53 | 0.02 | 10 (0.10) | 10 | 0 |
| picker | 3/3 | 2.54 | 2.50 | 0.02 | 2 (0.02) | 10 | 0 |
| batch | 3/3 | 1.20 | 1.15 | 0.02 | 2 (0.01) | 2 | 0 |
| oneshot | 3/3 | 1.22 | 1.17 | 0.03 | 2 (0.01) | 1 | 0 |

Time per tool call, across all runs:

| Tool | Time |
|---|---|
| `fill` | 220–350 ms each |
| `fill_form`, 8 fields | 680–830 ms |
| `click` (submit) | about 190 ms |
| `new_page` | about 200 ms |
| `take_snapshot` | 4–45 ms |
| `wait_for`, result page | 20–45 ms |

The form page's snapshot is about 3,200 characters, roughly 800 tokens.

Compared with the real run, the same tools are 5 to 10 times faster here
than on the agent Chrome. Above: `fill_form` takes 6.0 s on the agent
Chrome and under 1 s here; a snapshot takes about 1 s there and tens of
milliseconds here. So on a node, the transport is not negligible: an ssh
tunnel, a real browser with a profile and other tabs. A local headless
floor understates it. The bench's `baseline` mode forces one action per
turn. It matches the owner's BS variant, not B.

Also seen: filling a uid that is not an input, such as the label text next
to it, does not fail fast. chrome-devtools-mcp waits for the element to
become interactive and gives up after 5 s. So a picker that is fast but
sometimes wrong would pay this cost. In the real run, Haiku made no wrong
picks out of 54, so this never happened.
