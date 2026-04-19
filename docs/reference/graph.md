---
title: "Intent Knowledge Graph"
---

# Intent Knowledge Graph

A hierarchical, enumerable intent taxonomy that classifies every incoming message into a path through a fixed-axis schema. Typed paths feed Layer 6 of the context engine and can tag wiki articles so retrieval can prefer content from the same sub-tree.

## The shape

Five levels, fixed axes per level:

```
scope     (business | personal | other)
  └── location     (country, city)
        └── org    (name, orgKind)
              └── unit     (unitKind, name, role?, lead?)
                    └── activity (who, what, where)
```

Paths can **skip intermediate levels** when they don't apply — a remote-first org that never uses `location` will commit `scope → org → unit → activity` directly. Level inference matches each node's axes against each level's required axes rather than naive index-by-position.

Axes are typed: `enum` (closed set), `free` (any string), `ref` (pointer to another node). Axes can be `optional: true` for cases like `unit.lead` that only apply to sub-groups, not individuals.

Each agent's taxonomy lives on disk under `.agentx/graph/`:

```
.agentx/graph/
  schema.json              — level + axis definitions (seeded from starter-schema.ts)
  nodes.json               — committed nodes in the taxonomy tree
  classifications.jsonl    — append-only log (pending / approved / rejected entries)
  index.json               — fingerprint → path cache (hot-path for recurring messages)
```

## The lifecycle

```mermaid
flowchart LR
  M[Incoming message] -->|fingerprint| C{Cache hit?}
  C -->|yes| T[Tag with cached path]
  C -->|no| P[Classifier: graph-agent proposes path + axes]
  P -->|structure matches extend-leaves| A[Auto-approve: commit nodes + populate cache]
  P -->|structural change| Q[Queue as pending]
  Q -->|agentx graph review| R[Review agent: decides approve / reject / skip]
  R -->|approve| A
  R -->|reject| X[Marked rejected; no nodes committed]
  A --> T
```

Three failure modes are all handled gracefully:

- **LLM proposes invalid node-id slugs** (Arabic input, unicode, caps) → filtered against `[a-z0-9][a-z0-9_-]*`; malformed elements drop.
- **New nodes fail schema validation** (missing required axes) → classification falls back to pending, task continues.
- **Classifier times out** (60s ceiling) → task uses old regex-based intent tags, doesn't block.

## Auto-approval policy

Controlled by `graph.autoApproveStructure` in config:

| Policy | When classification auto-approves |
|---|---|
| `strict` | Never. Every classification waits for human or review-agent approval. |
| `extend-leaves` (default) | When the path either (a) reuses only existing nodes, or (b) adds exactly one new node at the deepest level. Structural changes still queue. |
| `any` | Always. No review, no queue. |

`graph.autoApproveConfidence` (0..1) is OR'd with the structural policy — if the LLM reports confidence ≥ threshold the classification auto-approves regardless of structure. Default 1.0 (disabled).

Rationale: most real classifications add one new leaf ("a new activity") — those grow the graph organically without review friction. Structural changes (a new org, a new unit) are the ones operators want to see.

## Reviewing pending classifications

When something structural hits `pending`, run:

```bash
agentx graph review [--dry-run] [--max N] [--agent <id>]
```

The review agent — configured as `graph.reviewAgent` — sees the original message, the proposed path + axes, and a compact view of the current catalog (existing nodes per level). It MAY call `agentx wiki query` via Bash to verify context (e.g. "is there an article for this project?") before deciding:

- `approve` — commit the new nodes, populate the fingerprint cache for next time
- `reject` — mark as rejected in the ledger
- `skip` — leave pending for human review

**Explicit bias in the review prompt: reject over approve when uncertain.** A wrong approval pollutes the graph; a wrong rejection just keeps the entry pending.

Schedule it as a cron for hands-off operation:

```json
"graph-review-hourly": {
  "enabled": true,
  "schedule": "0 * * * *",
  "agent": "graph-agent",
  "prompt": "Run: node dist/cli.js graph review --max 20. Report the summary line."
}
```

## Configuration

In `agentx.json`:

```json
{
  "graph": {
    "enabled": true,
    "baseDir": ".agentx/graph",
    "draftAgent": "graph-agent",
    "reviewAgent": "graph-agent",
    "autoApproveStructure": "extend-leaves",
    "autoApproveConfidence": 1.0,
    "retrievalWeights": { "graph": 0.6, "bm25": 0.4 }
  }
}
```

| Field | Default | Purpose |
|---|---|---|
| `enabled` | `false` | Off by default — existing installs see no change until they flip this |
| `baseDir` | `.agentx/graph` | Where schema/nodes/classifications/index live on disk |
| `draftAgent` | (none) | Agent the classifier calls with a proposal prompt. Should be a dedicated, channel-less agent with a sonnet-or-better model |
| `reviewAgent` | falls back to `draftAgent` | Agent the `graph review` command calls. Needs the `wiki` skill so it can `wiki query` for context |
| `autoApproveStructure` | `"extend-leaves"` | See table above |
| `autoApproveConfidence` | `1.0` | LLM-confidence threshold to auto-approve regardless of structure |
| `retrievalWeights` | `{ graph: 0.6, bm25: 0.4 }` | Weights for hybrid wiki retrieval (ancestry match vs BM25) |

## The dedicated classifier agent

The classifier routes proposals through an agent's Claude Code subprocess. Using a channel-bound agent (like a devops- or marketing-agent) is a bad idea:

- It queues behind real Telegram/HTTP traffic (`maxConcurrent=1`).
- Its CLAUDE.md / skills / context are all loaded every classification — slow + expensive.
- When the classifier's `input.agentId === draftAgent`, the call is skipped (would deadlock), so no classification happens for messages targeting THAT agent.

The recommended pattern is a dedicated `graph-agent`:

- **Workspace**: minimal — `CLAUDE.md` spelling out the JSON-only output contract, `.claude/settings.json` allowing only `Bash(agentx wiki query *)`, and the `wiki` skill installed.
- **Config**: `model: claude-sonnet-4-6`, `maxConcurrent: 3`, `mentions: []`, `access: "private"`. No channels — nobody messages this agent directly.
- **Size**: sonnet, not haiku. Classification involves picking 4–5 node ids and axis values; haiku's output was noisy enough in testing to be worth the sonnet cost delta.

See the classifier + review end-to-end in the [commit story](https://github.com/anis-marrouchi/agentx/commit/c70db0f).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `classifications.jsonl` is empty after many messages | `graph.enabled: false`, or `draftAgent` unset, or the draftAgent IS the target of every message (classifier skips self-routing) |
| `[classifier] LLM proposal failed: This operation was aborted` | Classifier's 60s fetch ceiling — the draftAgent is queued behind other tasks. Check `maxConcurrent` on the draftAgent, or use a dedicated `graph-agent` |
| Everything stays pending | `autoApproveStructure: "strict"` (change to `"extend-leaves"`) or no approval happening (run `agentx graph review`) |
| `skipped invalid classification — path=[...]` in log | LLM proposed a node id that doesn't pass `[a-z0-9][a-z0-9_-]*`. Non-blocking; the classification drops and the task continues |
| `Node X (level) missing required axes: ...` | Classifier didn't fill a required axis. Check the schema's axis `optional` flags; if the axis should be optional, mark it |

## Related

- [CLI reference — `agentx graph review`](/reference/cli#graph-intent-knowledge)
- [Config schema](/reference/config-schema)
- [Journey 6 — shared wiki](/journey/06-shared-wiki) — the wiki that graph-tagged articles feed into
- Source: [`src/graph/`](https://github.com/anis-marrouchi/agentx/tree/master/src/graph), [`src/commands/graph.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/commands/graph.ts)
