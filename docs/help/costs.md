# Understand model costs

AgentX itself is free, but the AI models your agents use are not. Each time an agent reads a message, looks at its context or writes a reply, your model provider may charge you. The amount depends on the model, how much text it reads, and how often work runs.

The scripted [demo](../see-it-first.md) never calls a paid model, so it costs nothing.

Keep in mind:

- A schedule (a job that runs at set times) spends money even when nobody sends a message. Start with a schedule that runs rarely, check its first runs, then make it more frequent.
- Monitor's automatic reviewer also uses Claude Code, separately from the agents' own work. See [Monitor's reviewer](#monitor-s-reviewer) below.
- AgentX doesn't change your provider's prices. Check your provider's billing page for the real amounts.

## Choose a model account

You pay the model provider in one of two ways. AgentX works with both.

- **A subscription:** a fixed monthly plan, such as Claude Pro or Claude Max. Your agents use it through Claude Code, a command-line tool you install and sign in to once on the machine that runs AgentX. On the setup page, this is the engine **Claude Code (recommended)**. You pay the same amount each month, but the plan has usage limits; see [When the Claude plan runs out](#when-the-claude-plan-runs-out).
- **An API key:** a private code from the provider that lets AgentX call the model directly. You pay for what your agents use. On the setup page, this is the engine **Anthropic API (BYO key)**. A Claude Code agent can also bill a key instead of the sign-in, with the agent setting [`billing`](../reference/config-agents.md#agents) set to `api`.

An API key only works once billing is set up with the provider. Before the first request, sign in to the provider's console in your browser, add a payment method and buy credits. Without that, every request fails, often with a message like `Credit balance is too low`. If the console lets you set a monthly spending limit, set one.

A personal subscription is for your own use. If other people can reach your agent, such as a guest from another team, bill an API key instead. See [Bill the guest's turns to your API key](../jobs/guest-mesh.md#host-bill-the-guest-s-turns-to-your-api-key).

The other engines on the setup page, **Codex CLI** and **OpenCode CLI**, use that tool's own sign-in or key. Follow the tool's own instructions to set it up.

### What it costs per month, roughly

These are rough guides, not quotes. Prices change, and your use decides the real amount. Check the provider's pricing page before you choose.

- **Subscription:** the plan's fixed price. At the time of writing, the entry Claude plan costs about USD 20 a month, and the larger plans about USD 100 to 200. A larger plan gives you more use before the limit.
- **API key, one light agent:** one agent that answers a few dozen short messages a day, on a mid-size model, often costs a few dollars to a few tens of dollars a month.
- **What makes it grow:** schedules that run often, the largest models (such as Opus), long conversations, many agents, and Monitor's reviewer. These can take an API bill into hundreds of dollars a month.

Not sure? If you already pay for a Claude plan, start with **Claude Code (recommended)**. Otherwise, start with an API key, set a spending limit, and check the [Cost page](#see-what-your-agents-spent) after the first week.

## See what your agents spent

The Cost page has no tab in the top bar. You open it by its address.

1. **Browser:** open `/admin/cost` on your dashboard (for example `http://127.0.0.1:4202/admin/cost`). The short address `/cost` takes you there too. From the **Health** page (`/admin/health`), you can also select the **Cost** link at the top.
2. Pick a period at the top right: **7d**, **14d**, **30d**, **90d** or **All**.
3. Read the totals, then **Top agents by spend**.
4. To keep a copy or compare with your bill, select **Export CSV**.

![The Cost page with the period picker, the totals and Top agents by spend](/screenshots/costs/page.png)

The Cost page doesn't read your bill. It counts the tokens (small pieces of text) each agent used, and multiplies them by fixed prices for Claude models (Opus, Sonnet and Haiku) built into AgentX. So what the dollar figures mean depends on how you pay:

- **Anthropic API key:** the figures are an estimate of your bill. The built-in prices can be out of date; the provider's bill is the figure you pay.
- **Claude subscription:** the figures show what the same work would cost with an API key. You pay the plan's fixed price, not these amounts. Use them to see which agents use the most.
- **Another provider (such as Codex, GPT or Gemini models):** the tokens are counted, but the spend shows as `$0`. Check that provider's billing page for the cost.

Monitor's reviewer is not on the Cost page, because it runs outside the agents' own work.

## Monitor's reviewer

After an agent finishes a task, AgentX asks Claude Code to review it and write the summary you see on [Monitor](../dashboard/monitor.md). Successful scheduled jobs, internal workflow steps and questions asked in the dashboard's **Ask** drawer are not reviewed.

- **Which account pays:** the review runs the `claude` command on the machine that runs the daemon (the AgentX background service), with whatever account Claude Code is signed in to there. It never uses the `ANTHROPIC_API_KEY` from your `.env` file; AgentX removes the key for this call.
- **Which model:** `opus` by default. To use a cheaper model, set the environment variable `AGENTX_MONITOR_MODEL` in the `.env` file next to `agentx.json`, for example `AGENTX_MONITOR_MODEL=sonnet`, then restart the daemon.
- **Without Claude Code:** if `claude` isn't installed on the daemon's machine, as in the Docker image by default, each review fails and costs nothing. Your agents keep working. Monitor shows the failures under **Reviews failed**, with the reason `Reviewer failed: claude CLI not found on the daemon PATH`. If Claude Code is installed but not signed in, the reviews fail the same way, with Claude Code's own message.
- **Turning it off:** there is no setting to turn the reviewer off; only the [demo](../see-it-first.md) skips it. To spend less on it, choose a cheaper model as above.

## See token use from the terminal

A token is a small piece of text, roughly three quarters of a word. Providers charge per token read and written.

1. **Terminal:** run:
   ```sh
   agentx usage
   ```
2. Read the totals for the last 7 days, then the list **By Agent**, largest first.

The daemon (the AgentX background service) must be running for this command to work.

`agentx usage` is short for `agentx usage today`. Despite the name, both show the last 7 days.

## For developers: get a detailed token report

**This section is for developers only.** The command needs a copy of the AgentX source code (the files you get by downloading the project from its code repository). It doesn't work with AgentX installed from npm or Docker. If you installed AgentX the usual way, skip this section and use the [Cost page](#see-what-your-agents-spent) or `agentx usage` instead.

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
To try again now, run: agentx usage plan --lift
```

Nothing to configure. The hold lifts by itself at the reset time, or sooner: as soon as Claude serves a request from an open conversation, AgentX knows the plan is accepting work again and lifts the hold.

Some windows count one model only, for example a weekly limit for Opus. Such a window holds only the agents that run on that model. An agent with no model set in `agentx.json` is held too, because AgentX can't tell which model it will use.

### See the plan windows and lift a hold

1. **Terminal:** in the folder with `agentx.json`, run:
   ```sh
   agentx usage plan
   ```
2. Read one line per window: its name, its state (`allowed`, `nearly full`, `rejected` or `extra usage`), how full it is, and when it resets. A window that is holding fresh sessions says so.
3. Read the last line: how many fresh Claude Code sessions AgentX started in the last hour and the last 5 hours.
4. Optional: if you know the plan is accepting work again (for example, you changed plan or switched on extra usage), lift the hold without waiting:
   ```sh
   agentx usage plan --lift
   ```
   The next fresh session asks Claude again. If the window is still used up, that session fails and the hold comes back.

Example output:

```text
  Claude plan (as Claude Code last reported it)

  five hour          rejected     100% used, resets in 38 min, holding fresh sessions
  seven day          allowed      41% used, resets in 3 days

  Fresh sessions started: 12 in the last hour, 40 in the last 5 hours
  To try again now: agentx usage plan --lift
```

AgentX keeps this state in memory. After a daemon restart the list is empty until Claude Code reports again, and no hold is in place.

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
3. **Terminal (developers, in a source copy):** `agentx usage report` ends with `Report: .agentx/reports/token_report.md`, and that file exists.
4. **Terminal:** `agentx usage surfaces` prints `Surface usage — last 30 days`. The commands you ran in the folder, such as `usage surfaces` itself, appear in the list.
5. **Terminal:** `agentx usage plan` prints `Claude plan (as Claude Code last reported it)`, then a line per window once an agent has run a turn.

## If something is wrong

- **`Daemon not running. Start with: agentx daemon start`:** start the daemon, then run `agentx usage` again.
- **`Script not found: …/scripts/token-report.py`:** `agentx usage report` was run outside a copy of the AgentX source code. Go to that folder and run it again.
- **`Analysis failed. Is Python 3 installed?`:** install Python 3 so that `python3` works in the terminal, then run the report again.
- **`No surface usage recorded in the last 30 days.`:** nothing has been counted yet. Counting starts once this version has been running for a while, and only inside an AgentX folder. Check that `AGENTX_NO_TELEMETRY` is not set.
- **`No tasks recorded yet`:** no agent has run yet on this machine. Send an agent a message first.
- **The Cost page is empty:** it only counts work done since AgentX started recording on this machine. Pick **All** to see everything it has.
- **Requests fail with `Credit balance is too low`:** the API key's account has no credits. In the provider's console, add a payment method and buy credits, then try again.
- **The Cost page shows `$0` but your agents ran:** they use a model that isn't Claude, so AgentX has no price for it. Check that provider's billing page.
- **The Cost page shows dollars, but you pay a subscription:** that's expected. The figures show what the work would cost with an API key; you pay the plan's fixed price.
- **Monitor's Reviews failed keeps going up:** the reviewer can't run Claude Code on the daemon's machine. **Terminal:** on that machine, run `claude --version`. If it's not found, install Claude Code and sign in, or accept that Monitor stays empty; this costs nothing. See [Monitor's reviewer](#monitor-s-reviewer).
- **The numbers don't match your bill:** your bill also covers use outside AgentX, and providers may round or group charges differently. Use the provider's figure.
- **`Claude plan limit reached: Claude Code reports the … window as rejected`:** the subscription's rolling window is full. Wait for the reset time in the message; open conversations keep working. Run `agentx usage plan` to see every window, and `agentx usage plan --lift` if you know the plan is accepting work again. If this happens every day, consider a larger plan or fewer scheduled jobs.
- **`agentx usage plan` says `Daemon answered 404`:** the running daemon is older than the command. Restart it with `agentx daemon restart`.
- **`Local dispatch cap reached: …`:** you set `session.maxClaudeCodeDispatchesPerHour` or `session.maxClaudeCodeDispatchesPer5h` and the fleet reached it. Raise the setting or remove it; the change applies when you save `agentx.json`.
- **Spending is higher than expected:** check **Settings** › **Schedules** for jobs that run very often, and lower their frequency.
