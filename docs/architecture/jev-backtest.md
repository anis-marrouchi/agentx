# Backtest the wake gate and model tier

Before AgentX may skip an agent run or send one to a smaller model, you want to know how often that would have been the wrong call. A *backtest* answers that from the past: it takes the runs your daemon already recorded, asks the two typed questions about each one, and reports what would have happened. Nothing changes while it runs. No run is skipped, blocked or moved to another model, and the daemon does not need to be restarted.

The two questions are decision seats (see [Jev and typed decisions](./jev.md)):

- **Wake gate** (`wake-gate`): did this event need an agent run at all? A bot's status line, a duplicate notification or a bare "thanks" usually does not.
- **Model tier** (`task-tier`): could a smaller model have handled this task? The same seat the live routing uses when it is turned on.

Each answer is a probability. The report applies a threshold to it, and also shows what other thresholds would have done, so you can read off the trade-off between money saved and runs wrongly skipped.

## What you need

- A copy of the AgentX source code, with its packages installed (`pnpm install`). The backtest is a script in that copy, not part of the installed package.
- A running daemon with a few days of recorded runs.
- A decision backend and its key. The script reads `agentx.json` in the folder you run it from, so a backend you already set up for other seats works as is. For a dry run without a key, use `--backend mock`.

## Export the recorded runs

The daemon lists its runs at `/traces`. One call returns up to 1,000 runs, newest first.

1. **Terminal:** work out the start of the period as milliseconds since 1970. For the last three days:
   ```sh
   SINCE=$(( $(date +%s) * 1000 - 3 * 24 * 60 * 60 * 1000 ))
   ```
2. **Terminal:** save the export next to your `agentx.json`:
   ```sh
   curl -s "http://127.0.0.1:4202/traces?since=$SINCE&limit=1000" > traces.json
   ```
   Replace the address with your dashboard's address if it differs.
3. **Terminal:** check how many runs you got:
   ```sh
   grep -o '"taskId"' traces.json | wc -l
   ```
   If the answer is 1000, the period holds more runs than one call returns. Export it in shorter pieces with `since` and `until`, then put the pieces in one file as a JSON array: `[ {"traces": [...]}, {"traces": [...]} ]`. The script reads that shape too and keeps each run once.

The export holds the first 200 characters of every message and the agents' replies. Keep it with your other private data and delete it when you are done. Never commit it or attach it to an issue.

## Run the backtest

1. **Terminal:** from the AgentX source folder that holds your `agentx.json`, run:
   ```sh
   pnpm exec tsx scripts/backtest-jev.ts --traces traces.json
   ```
2. Read the first lines: how many runs it loaded, which backend it asks, which cheap model it prices downgrades at, and which price table it uses. It then asks the backend two questions per run and prints a progress count.
3. Read the table and the threshold sweep (explained below).
4. Open the two files it wrote under `.agentx/reports/jev-backtest/`:
   - `report.json`: every number from the table, the sweep, the price table used and the list of proxies.
   - `sample.csv`: the events the gate would have skipped and the runs the tier would have downgraded, for you to judge.

To try the script without a backend key, add `--backend mock`. The answers are then made up and only the plumbing is tested.

### Options

| Flag | Default | What it does |
|---|---|---|
| `--traces <file>` | required | The export from `/traces`. |
| `--backend <name>` | the `wake-gate` seat's backend in `agentx.json`, else `decisions.defaultBackend`, else `jev` | Which decision backend answers: `jev`, `typesafe`, `local`, `simple-jev` or `mock`. |
| `--skip-below <p>` | `0.2` | The gate skips a run when the probability that it needs one is at or below this. |
| `--downgrade-below <p>` | `0.2` | The tier moves a run to the cheap model when the probability that it needs the strongest model is below this. The same value the live routing uses. |
| `--sweep <p,p,...>` | `0.05,0.1,0.15,0.2,0.3,0.4,0.5` | Thresholds to replay the answers at. No extra calls. |
| `--cheap-model <id>` | `decisions.routing.cheapModels.claude-code`, else `claude-haiku-4-5` | The model a downgraded run is priced at. |
| `--default-model <id>` | `claude-opus-5` | Used to price a run that recorded no model when its agent is not in `agentx.json`. |
| `--prices <file>` | built-in list prices, merged with `.agentx/pricing/custom.json` when that file exists | A price table in US dollars per million tokens, same shape as `.agentx/pricing/custom.json` (see below). |
| `--cache-ttl-minutes <n>` | `60` | A follow-up this soon after the previous run in the same conversation keeps the strongest model, as the live routing does. |
| `--channel <a,b>` | all | Only runs from these channels. |
| `--agent <a,b>` | all | Only runs by these agents. |
| `--limit <n>` | all | Only the first n runs. Good for a first try. |
| `--sample <n>` | `50` | How many skipped and how many downgraded runs go into `sample.csv`. |
| `--concurrency <n>` | `4` | How many backend calls run at once. |
| `--timeout-ms <n>` | `10000` | How long to wait for one answer. |
| `--noop-max-turns <n>`, `--noop-max-output <n>` | `1`, `200` | The proxy's definition of a run that did nothing: at most this many provider turns and this many output tokens. |
| `--worked-min-turns <n>`, `--worked-min-output <n>` | `3`, `1500` | The proxy's definition of a run that did real work: at least this many provider turns, or this many output tokens. |
| `--record` | off | Also keep every answer in `decisions.sqlite` next to the report, never in the daemon's own decision database. |
| `--json` | off | Print the report as JSON instead of the table. |
| `--out <dir>` | `.agentx/reports/jev-backtest` | Where the report and the sample go. |

A price file names a model family and its four rates per million tokens:

```json
{
  "claude-opus-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheCreate": 6.25 }
}
```

Families not in the file keep the built-in rate. The built-in table is in `src/daemon/token-tracker.ts`; check it against your provider's price list before you trust a dollar figure.

## Read the result

One row per channel, then a total:

| Column | Meaning |
|---|---|
| runs, cost $ | Runs in the export and what they cost at list price. |
| skip, skip% | Runs the gate would have skipped, and their share of the channel. |
| saved $ | The list-price cost of those skipped runs. |
| wrong\*, right\* | Among the skipped runs, how many the proxy says did real work (a wrong skip) and how many did nothing (a right skip). |
| down, down% | Runs the tier would have moved to the cheap model. |
| saved $\* | The cost at the strongest model minus the cost of the same tokens on the cheap model. |
| risky\* | Downgraded runs the proxy says did real work. |
| n/a | Questions the backend did not answer. Those runs count as "run on the strongest model", as the live path would. |

A star marks a **proxy**: a number the trace can only hint at. There is no record of whether a skipped run was needed, so the script uses the closest thing the trace offers:

- A run that used no tool (one provider turn) and wrote a short reply counts as **noop**, a run that probably did nothing.
- A run that chained tools or wrote at length counts as **worked**.
- Anything else, including a run that errored or timed out, is **unlabelled**.

The tier saving is a proxy for a second reason: it assumes the cheap model would have used the same number of tokens. `report.json` repeats these caveats under `proxies` so they travel with the numbers.

Below the table, two sweeps show the same answers at other thresholds. Lower the threshold and the gate skips less and is wrong less often. Pick the row whose wrong\* count you can live with and read its saving.

### Judge the sample yourself

The proxy is a guess. `sample.csv` lets a person replace it with a judgement.

1. Open `sample.csv` in a spreadsheet.
2. Read each row: the channel, the probability, the proxy's label, the run's turns and tokens, and the first 200 characters of the message.
3. In the `humanLabel` column, write `wrong` when the run was needed and `right` when it was not.
4. Count the `wrong` rows among `skipped`: that is the gate's false-skip rate on the sample, which the issue asks for before the gate may block anything.

The sample is spread over the probability range, so it holds confident skips and borderline ones alike.

## Check it worked

1. **Terminal:** the script ended with a line starting `report` and a line starting `sample`, and no `[backtest]` warning about unanswered calls.
2. `.agentx/reports/jev-backtest/report.json` exists and its `totals.runs` matches the number of finished runs in your export.
3. `.agentx/reports/jev-backtest/sample.csv` opens in a spreadsheet with a `humanLabel` column at the end.
4. **Terminal:** the daemon still runs every event as before: `agentx daemon status` shows no change, and `agentx decisions stats --since 1d` shows no `wake-gate` calls, because the backtest records nothing there.

## If something is wrong

- **`no finished traces in traces.json after filters`:** the export is empty, or every row is still running. Check the `since` value and that the daemon answered with `{"traces":[...]}`.
- **`[backtest] N/M traces got no answer`:** the backend failed or timed out. Run `agentx decisions backends` to check its key, raise `--timeout-ms`, or lower `--concurrency`.
- **`no agentx.json read`:** you ran the script outside the folder that holds your configuration. The script still works with `--backend` named explicitly, but it cannot read your agents' models or your routing settings.
- **`unknown decision backend`:** the name after `--backend` is not one of `jev`, `typesafe`, `local`, `simple-jev` or `mock`.
- **The dollar figures look wrong:** the report line `prices` says which table it used. Pass your own with `--prices` or correct `.agentx/pricing/custom.json`.
- **Many runs are "priced at the default model":** those rows recorded no model and their agent is not in `agentx.json`. Run from the right folder, or set `--default-model`.
- **The tier column is empty for a channel:** runs from `voice`, `desktop` and `opencode` keep the model the person chose, and a follow-up within the cache window keeps the strongest model. Both are reported, not skipped.
