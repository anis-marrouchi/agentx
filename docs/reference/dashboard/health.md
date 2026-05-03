# Health

Path: `/admin/health` (the old `/admin/observability` URL still works — it 302-redirects here)

The "is everything OK?" page. Was previously called "Observability," but in practice it only ever covered platform health — daemon errors, routing decisions, rotations, log stream — not the business-side flow. The rename matches the reality: this is where you go when something feels wrong with the daemon itself, not when something feels wrong with the work.

The page is read-only end to end. Nothing here mutates state. You're inspecting, not configuring. That's deliberate — diagnosis and configuration belong in different surfaces, and accidentally toggling something while debugging is exactly the kind of mistake we want to make impossible.

## What you'll see

Six tabs across the top, each a different lens on the same daemon:

- **Overview** — five KPI tiles: tasks today, errors today, p50 / p95 task duration, spend today (mirrors the [Cost page](./cost) headline), idle agent count. The one-screen "is everything green?" view. Open this first; if all five tiles look reasonable, you can probably stop here.
- **Activity** — two histograms: tasks per hour (last 24h) and tasks per day (last 30d). Useful for spotting silent agents — flat bars where there should be activity. Also useful as a sanity check on the rest of the page: if Activity says zero tasks but Errors is full, something is wrong with task accounting.
- **Errors** — every row in `task_history` where `status='error'`, translated into plain English. Instead of `ETIMEDOUT`, you see "Claude session timed out after 3 minutes." Instead of `429`, "Anthropic rate-limited us — try lowering concurrency." Click any row for the raw error and the originating message id.
- **Routing** — every inbound message and the agent it was routed to, plus *why* (which `routes[]` rule matched). The single best place to debug "why didn't agent X pick up that Telegram message?" — the answer is almost always either "no rule matched" or "a rule matched, just not the one you expected."
- **Rotations** — every Claude session rotation event. Three reasons: `stale` (session went idle past the timeout), `tier-2` (rotated to dodge Anthropic's 1.5x surcharge — the *good* kind), `max-turns` (hit the per-session turn cap). Counts by reason at the top, full table below.
- **Logs** — live SSE stream of the daemon's stdout. Mirrors `agentx daemon logs -f` but in your browser. Pause / resume / clear buttons at the top, plus a grep filter that hides any line not matching the substring you type.
- **Doctor** — preflight checks, mirrors `agentx doctor`. Runs six groups: env, config, references, workspaces, routing, runtime. Green check or red cross per check, with the failure reason inline. Run this whenever the dashboard "feels off" but you can't pin down why.

## What you can do

- Switch tabs. That's it. Everything is read-only by design — Health is the diagnostic surface, not the control surface. Mutations live in the other `/admin` tabs.
- Pause the live log stream when something interesting scrolls past, copy the line, then resume.
- Filter the log stream with the grep box (substring match, case-insensitive). Combine with pause to do focused inspection.
- Click an error row to open the raw stack trace and the originating message id.
- Click a routing row to see the full rule that matched (the `routes[]` entry plus the matched fields). When nothing matched, the row says so plainly.
- Click a rotation row to see the session id, reason, and the conversation length at the moment of rotation.
- Open Doctor any time the dashboard "feels off" — broken icons, missing data, weird empty states are usually one red Doctor check away from a clear answer.

## Common tasks

1. **"Why didn't agent X pick up that Telegram message?"**
   Routing tab → find the message timestamp → look at "matched rule." Either no rule matched (the message went to the catch-all or got dropped), or it matched a *different* agent's rule. Fix the `routes[]` ordering in [Channels](./admin) and reload.

2. **"Something just errored — what?"**
   Errors tab. Top row is the freshest. Plain-English label tells you the kind, and clicking gives you the stack and the input that caused it. If the same error repeats every minute, it's almost certainly a config issue (expired token, missing env var) — fix the config, the loop stops on its own.

3. **"Is the daemon healthy?"**
   Doctor tab → run all checks. Six green checks = you're fine. Any red is the actual answer to the question. Don't skip Doctor when triaging — half the "weird daemon behavior" issues turn out to be one red Doctor check that nobody looked at.

4. **"I think something is happening but I can't see it."**
   Logs tab → grep for the keyword (agent id, channel name, error code). Live stream means you'll see the next occurrence immediately, no need to refresh.

5. **"Are sessions rotating like they should?"**
   Rotations tab → look at the per-reason counts. Mostly `tier-2` = healthy (you're rotating proactively). Mostly `stale` = sessions are idling, fine. Lots of `max-turns` = you're hitting caps; raise `session.maxTurns` or split workflows into smaller agents.

6. **"Quick sanity check before going home."**
   Overview tab → glance at five tiles. If errors today is `0` and idle agent count looks right, you're done.

7. **"A user says their message went into the void."**
   Routing tab → search by chatId or username. If the message appears with a "no rule matched" badge, the [Channels config](./admin) is missing a route. If it's there with a green badge, the agent received it but didn't reply — go to that agent's page and check its task history.

8. **"Spot a slow-down before it becomes an outage."**
   Overview tab → watch p50 and p95 task duration over a week. Slowly creeping numbers usually mean Anthropic is rate-limiting in the background, or one channel's API is degrading. Cross-reference the Errors tab for `429` patterns.

## Troubleshooting

- **Logs tab says "no log source available."** The dashboard tries three locations in order: systemd journal (if the daemon runs under `systemctl`), `/tmp/agentx-daemon.log`, and `~/.agentx/logs/daemon-stdout.log`. None of those exist on your setup. Either start the daemon under systemd, or set `AGENTX_LOG_FILE=/tmp/agentx-daemon.log` before starting it.
- **Doctor says "config: workspaces missing"** but the workspaces exist. The check resolves paths relative to the daemon's `cwd`, not yours. Confirm with `agentx daemon status` — the `cwd` field there is the one Doctor checks against.
- **Routing tab is empty.** No inbound messages have arrived since the daemon started. Send a test message via any channel — it should appear within seconds.
- **Errors tab is huge and full of `ECONNRESET`.** A network blip or an upstream channel hiccupping. Filter by agent — if it's localized to one channel, the channel's PAT/token is probably expired or rate-limited.
- **Overview's "spend today" disagrees with [Cost](./cost).** Both read from the same table; the lag is the polling interval. Refresh, or wait 30 seconds.
- **Logs scroll faster than you can read.** Hit pause, scroll up to the moment of interest, then grep for the specific identifier (agent id, error code, message id). The buffer holds the most recent ~10k lines in memory.
- **Doctor flickers between green and red.** Some checks (workspaces, runtime memory) are point-in-time; if your daemon is under heavy load, a check can briefly fail and recover. Three consecutive reds is meaningful; one is noise.
- **Routing tab shows a message but no agent picked it up.** The route matched a webhook agent that's currently offline (queued tasks accumulate), or the route matched a workflow trigger and the workflow is paused. Cross-check the agent's status in [Live](./live).
- **Live SSE keeps disconnecting.** The browser's idle-tab throttling closed it. Bring the tab to the foreground or refresh — the dashboard reconnects automatically. If it disconnects every minute even with the tab active, a reverse proxy in front of the daemon is timing out long-lived connections; raise its read timeout above 60 seconds.

## When to use Health vs other pages

- Health vs [Live](./live): Live tells you what's happening *right now* (which agent picked up which message); Health tells you whether the platform itself is OK and what just went wrong. Live is the foreground; Health is the background.
- Health vs [Cost](./cost): Cost is a financial lens on the same `task_history`; Health is the operational lens. Same data, different question.
- Health vs [Processes](./processes): Processes shows workflow runs; Health shows the daemon hosting them. If a workflow is stuck, look at Health to confirm the daemon isn't the cause first.

## CLI parity

- `agentx daemon logs -f` — same live stream as the Logs tab, in the terminal.
- `agentx doctor` — same preflight as the Doctor tab.
- `agentx db tasks` — raw `task_history` rows behind the Errors and Activity tabs.
- `agentx db rotations` — raw rotation events behind the Rotations tab.
