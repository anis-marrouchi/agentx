import { copyFileSync, existsSync, mkdirSync } from "fs"
import { basename, dirname, resolve } from "path"
import { classifyFact } from "./fact-freshness"
import type { MemoryFact, MemoryStore } from "./memory-store"

// --- One-off: flag unsourced volatile memory lines as unverified (#273) ---
//
// Memory written before provenance existed can state account, billing,
// outage or deploy state ("vendor account past due", "the API is down")
// with nothing saying where that came from. This pass marks each such
// line `unverified`, so it is always rendered UNVERIFIED, whatever its
// age, until someone re-checks it.
//
// Dry-run unless `apply`. Idempotent: a line already flagged, or one with
// a source, is left alone, so a second run changes nothing. Before a file
// is rewritten it is copied to `.agentx/memory/_backup/`.

export const MIGRATION_REASON = "unsourced-volatile"

export interface FlagResult {
  agentId: string
  flagged: Array<Pick<MemoryFact, "id" | "content"> & { volatility: string }>
  /** The copy made before rewriting; absent on a dry run or no change. */
  backup?: string
}

export function flagUnsourced(
  store: MemoryStore, agentId: string, opts: { apply?: boolean; now?: number } = {},
): FlagResult {
  const facts = store.getAll(agentId)
  const since = new Date(opts.now ?? Date.now()).toISOString()
  const flagged: FlagResult["flagged"] = []

  for (const f of facts) {
    if (f.unverified || f.category === "secret") continue
    // The wording decides, not the sender: a memo that says nothing about
    // an outside system is work state, and already expires on its own.
    const volatility = classifyFact(f.content)
    if (volatility === "stable" || f.provenance?.source?.trim()) continue
    flagged.push({ id: f.id, content: f.content, volatility })
    if (opts.apply) f.unverified = { since, reason: MIGRATION_REASON }
  }

  if (!opts.apply || flagged.length === 0) return { agentId, flagged }

  const file = store.fileFor(agentId)
  const dir = resolve(dirname(file), "_backup")
  mkdirSync(dir, { recursive: true })
  let backup = resolve(dir, `${basename(file, ".jsonl")}.${since.replace(/[:.]/g, "-")}.jsonl`)
  for (let n = 1; existsSync(backup); n++) backup = backup.replace(/(\.\d+)?\.jsonl$/, `.${n}.jsonl`)
  copyFileSync(file, backup)
  store.rewrite(agentId, facts)
  return { agentId, flagged, backup }
}
