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

<!-- Screenshot needed: the Cost page (/admin/cost). Not defined in docs/.scripts/capture.mjs yet. -->

The Cost page shows Anthropic spend. Compare it with your provider's bill; the provider's figure is the one you pay.

## See token use from the terminal

A token is a small piece of text, roughly three quarters of a word. Providers charge per token read and written.

1. **Terminal:** run:
   ```sh
   agentx usage
   ```
2. Read the totals for the last 7 days, then the list **By Agent**, largest first.

The daemon (the AgentX background service) must be running for this command to work.

## Limit how often Claude Code agents start

If your agents use Claude Code with a subscription, AgentX limits how many fresh Claude Code sessions it starts, so a busy day doesn't use up your plan. A conversation that is already open always goes through. Two settings in `agentx.json` control this:

```json
"session": {
  "maxClaudeCodeDispatchesPerHour": 80,
  "maxClaudeCodeDispatchesPer5h": 180
}
```

The values shown are the defaults. Lower them to spend less; raise them if you have a larger plan. Restart the daemon after changing them.

## Check it worked

1. **Browser:** open `/admin/cost`. The page shows a **Last ingest** time and figures for the period you picked.
2. **Terminal:** `agentx usage` prints `Token Usage (last 7 days)` followed by a total.

## If something is wrong

- **`Daemon not running. Start with: agentx daemon start`:** start the daemon, then run `agentx usage` again.
- **`No tasks recorded yet`:** no agent has run yet on this machine. Send an agent a message first.
- **The Cost page is empty:** it only counts work done since AgentX started recording on this machine. Pick **All** to see everything it has.
- **The numbers don't match your bill:** your bill also covers use outside AgentX, and providers may round or group charges differently. Use the provider's figure.
- **Spending is higher than expected:** check **Settings** › **Schedules** for jobs that run very often, and lower their frequency.
