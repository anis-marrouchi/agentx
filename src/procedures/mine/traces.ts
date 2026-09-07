// --- Successful traces, as raw material for procedure mining --------------
//
// This used to live in workflows/absorb.ts, alongside the machinery that
// turned traces into generated workflow drafts. That generator is gone; the
// procedure miner still needs the same starting set, so the loader moved here
// — to its only remaining caller — rather than keeping a module alive for one
// function.

import type Database from "better-sqlite3"
import { listTraces, type TraceRecord } from "@/storage/traces"

/** Below this, a prompt carries too little to mine anything from. */
const DEFAULT_MIN_MESSAGE_LENGTH = 30

export function loadSuccessfulTraces(
  db: Database.Database,
  opts: { since?: number; agentId?: string; limit?: number; minMessageLength?: number } = {},
): TraceRecord[] {
  const min = opts.minMessageLength ?? DEFAULT_MIN_MESSAGE_LENGTH
  return listTraces(db, {
    agentId: opts.agentId,
    status: "ok",
    since: opts.since,
    limit: opts.limit ?? 1000,
  })
    .filter((t) => !t.workflowRunId)
    .filter((t) => (t.messagePreview || "").trim().length >= min)
}
