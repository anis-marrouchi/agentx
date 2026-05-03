---
title: "Capability audit — typed intents and delegation depth"
---

# Capability audit — typed intents and delegation depth

PM gating ([previous playbook](./pm-gating)) routes by project; capabilities tighten which intents an agent will accept and how deep delegation chains can grow. Phases 5 and 8 of the architectural rescue.

Use this when:
- Some agents should only handle specific intent types (e.g. `qa-forensics` should only get `bug.opened`, not `merge_request.opened`)
- You're seeing cascade loops where Agent A → B → A → B keeps recurring
- You want to bound how much delegation a single inbound can produce

## Listing agent intents

Each agent has an optional `intents: string[]` (Phase 5). Empty/unset = permissive (any intent).

```bash
agentx config get agents.mtgl-v2.intents --json
```

Example:

```json
["issue.opened", "issue.commented", "merge_request.opened", "merge_request.synchronize"]
```

To see them all in one shot:

```bash
agentx config show | jq '.agents | to_entries | map({id: .key, intents: .value.intents})'
```

The `Organization.canHandle(agentId, project, intent)` check rejects dispatches whose `intent` isn't in the list. The reject is recorded in the ledger as `outcome: dropped, reason: "agent X cannot handle Y"`.

## Setting intents

Tighten a specific agent:

```bash
agentx config set agents.qa-forensics.intents '["bug.opened", "bug.commented", "incident.opened"]'
```

Open up a permissive agent:

```bash
agentx config set agents.atlas.intents '[]'
```

(Empty array = unset = permissive.) The daemon hot-reloads on save.

## Delegation depth

The `maxDelegationDepth` field (Phase 8) caps how many distinct upstream agents can be in the dispatch chain on the same `(project, subject)` before a dispatch to this agent is refused. Default: `5`. Range: `0–50`.

```bash
agentx config get agents.mtgl-v2.maxDelegationDepth
# 5

# Tighten — this coder should never sit deeper than 3 hops
agentx config set agents.mtgl-v2.maxDelegationDepth 3
```

Setting `0` disables the check for that agent (use when the agent is always called as the bottom of a chain).

## Detecting cascade loops

Two signals to look for:

### 1. Ledger lineage on a long chain

```bash
agentx ledger lineage <event-id>
```

Output's header shows `<n> distinct agent(s) dispatched`. A healthy chain is 2-3; a cascading one is 5+. Look at the chain — A → B → A pattern means the two agents are calling each other.

### 2. `agentx ledger active` showing many in-flight on one subject

```bash
agentx ledger active --json | jq 'group_by([.project, .subject]) | map({key: (.[0].project + ":" + .[0].subject), count: length}) | sort_by(.count) | reverse | .[0:5]'
```

If a `(project, subject)` has 5+ active decisions, something's recursing. The `withinDelegationBudget` check would have caught this once `maxDelegationDepth` is set on the relevant agents — the rejection appears in the ledger as `outcome: dropped, reason: "delegation depth exceeded"`.

## Tightening capabilities

A practical sequence for an existing install:

1. **Establish baseline.** Run `agentx ledger stats --since 7d` and note the per-source dispatch counts. These are your "normal" volumes.
2. **Audit per-agent intents.** Pick agents that should be specialised (QA, devops). Set their `intents[]` based on what they currently handle in the ledger:
   ```bash
   agentx ledger events -s gitlab --since 7d --json \
     | jq -r '.[] | "\(.intent) \(.subject)"' \
     | sort | uniq -c | sort -rn
   ```
   Set `intents[]` to the top 80% by volume; let the rest fall through to a generalist.
3. **Set `maxDelegationDepth`.** Default `5` is fine for most agents. Bottom-of-chain coders → set `3`. Specialists that should never delegate → set `0` (or `1` if they need to escalate to their PM).
4. **Run replay.** `agentx ledger replay --since 24h` — the dropped decisions show up as divergences if you tightened mid-soak. Inspect each.

## Auditing recent governance rejects

The ledger records every reject with a reason. Pull the last day's:

```bash
agentx ledger events --since 24h --json \
  | jq '[.[] | select(.intent and .reason and (.reason | test("cannot handle|delegation depth")))]'
```

(This requires a small extension to `agentx ledger events` to surface decisions; today the events command only shows event metadata. Use `sqlite3 .agentx/intent/ledger.sqlite "SELECT decided_at, decided_by, agent_id, outcome, reason FROM intent_decisions WHERE outcome = 'dropped' AND decided_at > strftime('%s', 'now', '-1 day') * 1000 ORDER BY decided_at DESC LIMIT 30;"` for the raw query.)

## Common pitfalls

- **Tightening `intents` mid-day kills inbound.** Daemon hot-reloads on `agentx config set`, but in-flight tasks already past the gate finish on the old config. New inbounds use the tighter set immediately.
- **`maxDelegationDepth: 0` everywhere.** Disables the check entirely — opposite of what you want. Use the default `5` unless you've measured chains.
- **No baseline.** Without a 7-day ledger sample, you're guessing what intents an agent "actually handles." Run baseline first.

## Next

- [PM gating playbook](./pm-gating) — the project-scoped gate that pairs with intents/depth
- [`agentx ledger` CLI reference](/reference/cli#ledger), especially `lineage` and `replay`
- [Schema: per-agent intents + maxDelegationDepth](/reference/config-schema#agents-id)
