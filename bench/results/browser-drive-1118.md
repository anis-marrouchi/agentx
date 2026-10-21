# Browser driving: where the time goes (#1118)

Status: part 1 measured without a model (the floor); the model runs are
still to do on a node with an API key and the agent Chrome. Spike only:
nothing here changes AgentX.

## Setup

- Task: `pnpm bench:browser` (see [../README.md](../README.md#level-1-small-browser-driving-1118)).
  Open a local registration form, fill 8 fields, submit, read back the
  reference number.
- Browser: headless Chromium 141 on a Linux cloud container, debug port
  9222, `--force-renderer-accessibility`. Not the agent Chrome on the Mac.
- MCP: chrome-devtools-mcp 1.11.0, over stdio.
- Backend: `oracle` (targets matched by label in code, zero think time).
  3 runs per mode, modes interleaved.

## Floor: browser and MCP only (oracle, 3 runs)

Median per run, seconds.

| Mode | Success | Total | Tool calls | Page wait | Snapshot reads (time) | Model calls | Wrong targets |
|---|---|---|---|---|---|---|---|
| baseline | 3/3 | 2.66 | 2.53 | 0.02 | 10 (0.10) | 10 | 0 |
| picker | 3/3 | 2.54 | 2.50 | 0.02 | 2 (0.02) | 10 | 0 |
| batch | 3/3 | 1.20 | 1.15 | 0.02 | 2 (0.01) | 2 | 0 |
| oneshot | 3/3 | 1.22 | 1.17 | 0.03 | 2 (0.01) | 1 | 0 |

Per tool call (all runs): `fill` 220–350 ms each, `fill_form` with 8
fields 680–830 ms, `click` (submit) about 190 ms, `new_page` about 200 ms,
`take_snapshot` 4–45 ms, `wait_for` on the result page 20–45 ms. The form
page snapshot is about 3,200 characters, roughly 800 tokens.

## What it shows so far

1. **The browser is not the slow part.** With no model, the whole task
   takes 1.2–2.7 s. Snapshots cost milliseconds to take and page waits are
   tens of milliseconds. Anything an agent spends beyond that is model
   time and context.
2. **One fill per call costs about a quarter second each, in the MCP.**
   Each `fill` waits for the page to settle before it returns. One
   `fill_form` for the same 8 fields takes a third of the time
   (~95 ms per field). Batching halves the browser floor on its own.
3. **The number of model round trips is the lever.** `baseline` and
   `picker` make 10 model calls for this task; `batch` makes 2 and
   `oneshot` 1. At one to a few seconds per call, that difference dwarfs
   the whole browser floor.
4. **Context grows with every step in the agent loop.** `baseline` keeps
   each snapshot in the conversation, so call *n* re-reads *n* snapshots:
   about 44,000 input tokens over the 10 calls of this small page
   (estimate, 800 tokens a snapshot), against about 800 for `oneshot`.
   Real pages snapshot at several thousand tokens, so this grows fast.
5. **A wrong uid costs 5 seconds.** Filling a uid that is not an input
   (for example the label text next to it) does not fail fast:
   chrome-devtools-mcp waits for the element to become interactive and
   gives up after 5 s. Seen once by hand while setting up, not yet counted
   by the bench. A picker that is fast but sometimes wrong pays this.

## Still to measure (needs the agent Chrome and an API key)

On the dev-session node:

```bash
scripts/agent-chrome.sh
pnpm bench:browser --runs 3 --big claude-sonnet-5-5 --small claude-haiku-5-5 --out state/browser-spike
```

That adds, per mode: real think time per call, exact input tokens, the
success rate and the wrong-target count with real models. The question
for part 2 is whether `batch` (small model picks) beats `oneshot` (big
model picks in one call): if one big-model call is as accurate and nearly
as fast, the small model adds a moving part for little.
