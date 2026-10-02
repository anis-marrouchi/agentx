# Understand model costs

AgentX itself is free, but the AI models your agents use are not. Each time an agent reads a message, looks at its context or writes a reply, your model provider may charge you. The amount depends on the model, how much text it reads, and how often work runs.

The scripted [demo](../see-it-first.md) never calls a paid model, so it costs nothing.

Keep in mind:

- A schedule (a job that runs at set times) spends money even when nobody sends a message. Start with a schedule that runs rarely, check its first runs, then make it more frequent.
- Monitor's automatic reviewer also uses Claude Code, separately from the agents' own work. The demo turns that reviewer off.
- AgentX doesn't change your provider's prices. Check your provider's billing page for the real amounts.

## See what your agents spent

1. **Browser:** open `/admin/cost` on your dashboard (for example `http://127.0.0.1:4202/admin/cost`).
2. Pick a period at the top right: **7d**, **14d**, **30d**, **90d** or **All**.
3. Read the totals, then **Top agents by spend**.
4. To keep a copy or compare with your bill, select **Export CSV**.

![The Cost page with the period picker, the totals and Top agents by spend](/screenshots/costs/page.png)

The Cost page shows Anthropic spend. Compare it with your provider's bill; the provider's figure is the one you pay.

## See token use from the terminal

A token is a small piece of text, roughly three quarters of a word. Providers charge per token read and written.

1. **Terminal:** run:
   ```sh
   agentx usage
   ```
2. Read the totals for the last 7 days, then the list **By Agent**, largest first.

The daemon (the AgentX background service) must be running for this command to work.

`agentx usage` is short for `agentx usage today`. Despite the name, both show the last 7 days.

## Get a detailed token report

`agentx usage report` answers "where did the tokens go, session by session?". It goes further than `agentx usage`: it also reads the conversation files Claude Code keeps on this machine (under `~/.claude/projects`), so it counts Claude Code work done outside AgentX too. It does not need the daemon.

It runs a small Python script, `scripts/token-report.py`, from the folder you are in. That script is in the AgentX source code, not in the package installed with npm, so run this command from a copy of the AgentX source code that holds your `.agentx` folder.

1. **Terminal:** go to that folder.
2. **Terminal:** run:
   ```sh
   agentx usage report
   ```
   To look further back, add `--days` with a number of days (the default is 7):
   ```sh
   agentx usage report --days 30
   ```
3. Read the three parts of the output:
   - **AgentX Agent Usage (from daemon):** one row per agent with tasks, input, output, cache read, cache write and total tokens, then a **Cache hit ratio**.
   - **Claude Code Sessions (from JSONL):** sessions and tokens per project folder.
   - **Top 5 Expensive Sessions:** the five largest sessions, with the start of the prompt that began each one.
4. Open the saved copy: the last line prints `Report: .agentx/reports/token_report.md`. That file holds the per-agent table.

Example output (shortened):

```text
  AgentX Token Usage Report
  ...
  Agent                      Tasks      Input     Output    Cache R    Cache W        Total
  helper                        12     48,210      9,904  1,203,550     80,112    1,341,776
  reviewer                       3     11,030      2,417    301,229     20,448      335,124

  Cache hit ratio: 91.2%
```

## See which commands and pages people use

`agentx usage surfaces` answers "which AgentX commands and dashboard pages does anyone actually open?". AgentX counts each use on this machine: the command name (such as `guard log`) or the page address (such as `/live`), never what you typed after it. The counts stay in the local database and are not sent anywhere. The daemon does not need to be running.

1. **Terminal:** in the folder with `agentx.json`, run:
   ```sh
   agentx usage surfaces
   ```
   It lists **CLI commands**, then **Dashboard pages**, each with the number of uses and on how many days they were used, for the last 30 days.
2. Optional: change the period with `--days`, for example `agentx usage surfaces --days 7`.
3. Optional: show only one kind with `--kind cli` or `--kind page`.
4. Optional: list the commands nobody has used in the period with `--unused`. It prints `Never used in the last 30 days (x/y)` and the command names. It lists commands only, not pages, so don't combine it with `--kind`.
5. Optional: add `--json` to get the raw data for a script or a spreadsheet.

Example output (shortened):

```text
  Surface usage — last 30 days

  CLI commands
      41  daemon status                 12d
       9  schedule list                  5d
  Dashboard pages
     130  /live                         22d
```

Counting only happens inside an AgentX folder (one with `agentx.json` or `.agentx`). Setting the environment variable `AGENTX_NO_TELEMETRY` turns it off.

## When the Claude plan runs out

If your agents use Claude Code with a subscription, the plan has a rolling five-hour and a seven-day limit. Claude Code tells AgentX on every turn how full those windows are. When Claude Code reports a window as **rejected**, AgentX stops starting fresh Claude Code sessions until the window resets, so scheduled jobs do not fail one after another with the same refusal. A conversation that is already open always goes through.

If extra usage is switched on for the account, Claude keeps serving requests after a window is used up. Claude Code says so in the same report, and AgentX does not hold anything while that is the case.

While the hold is on, a scheduled job or an agent-to-agent call fails with a message like this, and the log shows when the hold ends:

```
Claude plan limit reached: Claude Code reports the five hour window as rejected.
Cold dispatches are held until it resets in about 38 min (…); open conversations still go through.
```

Nothing to configure. The hold lifts by itself at the reset time, or sooner if Claude Code reports the window as allowed again.

## Put a local ceiling on fresh Claude Code sessions

On top of the plan limit, you can cap how many fresh Claude Code sessions AgentX starts across all its agents. This is off unless you set it. Two settings in `agentx.json` control it:

```json
"session": {
  "maxClaudeCodeDispatchesPerHour": 80,
  "maxClaudeCodeDispatchesPer5h": 180
}
```

Leave a setting out, or set it to `0`, to turn that cap off. AgentX applies a change when you save the file; no restart is needed. When a cap is reached, fresh sessions are held and the error names the setting to raise.

## Check it worked

1. **Browser:** open `/admin/cost`. The page shows a **Last ingest** time and figures for the period you picked.
2. **Terminal:** `agentx usage` prints `Token Usage (last 7 days)` followed by a total.
3. **Terminal:** `agentx usage report` ends with `Report: .agentx/reports/token_report.md`, and that file exists.
4. **Terminal:** `agentx usage surfaces` prints `Surface usage — last 30 days`. The commands you ran in the folder, such as `usage surfaces` itself, appear in the list.

## If something is wrong

- **`Daemon not running. Start with: agentx daemon start`:** start the daemon, then run `agentx usage` again.
- **`Script not found: …/scripts/token-report.py`:** `agentx usage report` was run outside a copy of the AgentX source code. Go to that folder and run it again.
- **`Analysis failed. Is Python 3 installed?`:** install Python 3 so that `python3` works in the terminal, then run the report again.
- **`No surface usage recorded in the last 30 days.`:** nothing has been counted yet. Counting starts once this version has been running for a while, and only inside an AgentX folder. Check that `AGENTX_NO_TELEMETRY` is not set.
- **`No tasks recorded yet`:** no agent has run yet on this machine. Send an agent a message first.
- **The Cost page is empty:** it only counts work done since AgentX started recording on this machine. Pick **All** to see everything it has.
- **The numbers don't match your bill:** your bill also covers use outside AgentX, and providers may round or group charges differently. Use the provider's figure.
- **`Claude plan limit reached: Claude Code reports the … window as rejected`:** the subscription's rolling window is full. Wait for the reset time in the message; open conversations keep working. If this happens every day, consider a larger plan or fewer scheduled jobs.
- **`Local dispatch cap reached: …`:** you set `session.maxClaudeCodeDispatchesPerHour` or `session.maxClaudeCodeDispatchesPer5h` and the fleet reached it. Raise the setting or remove it; the change applies when you save `agentx.json`.
- **Spending is higher than expected:** check **Settings** › **Schedules** for jobs that run very often, and lower their frequency.
