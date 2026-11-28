// --- Memory tidy runs in the Approvals inbox (#2117 PR 3) ---
//
// One `memory` item per tidy run waiting for review, beside the held
// facts: key `memory:<agent>/tidy-<runId>`. Yes keeps the run's changes,
// no undoes the whole run. Silence keeps them; the item expires after
// TIDY_REVIEW_DAYS. The rules live in improve/tidy-review.ts.

import { existsSync } from "fs"
import { resolve } from "path"
import { AgentMemory } from "@/agents/agent-memory"
import { MemoryStore } from "@/agents/memory-store"
import { reviewRun, runDetail, runsToReview, tidyRef, TIDY_REVIEW_DAYS } from "@/improve/tidy-review"
import type { DecideResult, InboxContext, InboxItem } from "./inbox"

const DAY_MS = 86_400_000

export function tidyItems(ctx: InboxContext): InboxItem[] {
  // No run logs yet: no store, so listing never makes the memory folder.
  if (!existsSync(resolve(ctx.root, ".agentx", "memory", "_tidy"))) return []
  const now = ctx.now ?? Date.now()
  return runsToReview(new MemoryStore(ctx.root), now).map((run) => {
    const n = run.changes.length
    return {
      key: `memory:${tidyRef(run)}`,
      kind: "memory" as const,
      title: `Memory tidy for ${run.agent}: ${n} change${n === 1 ? "" : "s"}`,
      ask: `Keep the changes the nightly memory tidy made to ${run.agent}'s memory?`,
      yes: "keep them",
      no: "undo the whole run",
      if_silent: "keep" as const,
      expires: new Date(Date.parse(run.at) + TIDY_REVIEW_DAYS * DAY_MS).toISOString(),
      raised_by: run.agent,
      created_at: run.at,
      detail: runDetail(run),
      more: `agentx memory tidy show ${run.runId}`,
    }
  })
}

/** Yes or no on a tidy run's item. */
export function decideTidy(ctx: InboxContext, runId: string, yes: boolean, by: string): DecideResult {
  try {
    const store = new MemoryStore(ctx.root)
    const notes = new AgentMemory({ baseDir: resolve(ctx.root, ".agentx") })
    return reviewRun(store, notes, runId, yes, { by, now: ctx.now ?? Date.now() })
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) }
  }
}
