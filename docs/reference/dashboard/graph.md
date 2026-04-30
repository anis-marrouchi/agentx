# Intent graph viewer

Path: `/admin/graph`

Dashboard surface over the intent knowledge graph at `.agentx/graph/`. Three panels stacked on one page:

1. **Pending approval queue** — LLM-proposed classifications awaiting operator triage (or auto-approval per the structural/confidence policies).
2. **Taxonomy tree** — nodes grouped by level with inline axis editing.
3. **Schema editor** — raw JSON for advanced level/axis changes.

For the conceptual model (axes, levels, classification flow, hybrid retrieval), see [Intent graph](/reference/graph).

## What you'll see

- The **pending queue** lists each classification with: message hash, proposed path, confidence score, and the structural diff (which axes changed). Action buttons: **Approve**, **Reject**, **Edit** (inline path correction), **Skip**.
- The **taxonomy tree** is the hierarchy laid out per axis. Click any node to see member classifications, their axes values, and the path. Inline edits commit through `GraphStore.updateAxis`.
- The **schema editor** is a JSON textarea backed by `graph/schema.json`. Save runs schema validation; broken edits are rejected with a row-level error.

## What you can do

- Triage pending classifications interactively (the same loop `agentx graph review` runs, but visual).
- Edit axes in place — the queue refreshes when you save.
- Adjust the schema (rename axes, reorder levels) for advanced taxonomy redesign.
- **Pull from a peer** with `agentx graph pull --from <url>` — the dashboard re-renders the merged tree.

## Common tasks

| You want to… | Do this |
|---|---|
| Auto-approve safe classifications | Set `graph.autoApproveStructure: "extend-leaves"` and `graph.autoApproveConfidence: 0.8` in `agentx.json` |
| Run triage non-interactively | `agentx graph review --max 50 --dry-run` (then drop `--dry-run`) |
| See how a chat message was classified | Search the queue or tree for the message's hash (visible in the `/live` task rail when classification is enabled) |

## Troubleshooting

- **"Graph is disabled."** Set `graph.enabled: true` in `agentx.json` and restart the daemon.
- **No `reviewAgent`/`draftAgent`.** The page falls back to `dashboard.draftAgent`. If none is set, the **Approve via reviewer** button is greyed out — set `graph.reviewAgent` to an agent that has the wiki skill so the reviewer can call `wiki query` for context.
- **Schema rejects on save.** Required levels missing or duplicate axis names. The error message names the offending field; fix and retry.

## Implementation pointers

- Page module: `src/daemon/ui/pages/graph.ts`
- Server API: `src/daemon/graph-panel.ts`
- Store: `src/graph/store.ts` (GraphStore)
- CLI siblings: [`agentx graph review`, `agentx graph pull`](/reference/cli#graph-intent-knowledge)
