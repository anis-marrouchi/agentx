# Browser driving: where the time goes (#1118)

Status: measured, 2026-10-21. Spike only: nothing here changes AgentX.

**Verdict:** a small-model target picker is not worth building as a speed
feature on this evidence: 12% faster on a small form. It may be worth it as
a cost and robustness feature, at 74% cheaper, once large pages are tested.
The cheap wins are to close stray tabs on the agent Chrome and to keep fill
batching.

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
