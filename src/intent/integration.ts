import { decideAndCommit, type DispatchPolicy } from "./decide"
import { reportDivergence, type LegacyOutcome } from "./divergence"
import { getDefaultLedger } from "./instance"
import { getLedgerMode } from "./mode"
import type { IntentLedger } from "./ledger"
import type { IntentEventInput, IntentSource } from "./types"

// Common call-site wiring helper — Phase 1 commit 6.0.
//
// Each dispatch source (gitlab, router, workflow, cron, mesh) needs the
// same off/shadow/authoritative branching when it consults the ledger.
// `shadowAlongside` collapses the cookie-cutter pattern into one place so
// 1:1 dispatch sources (cron firing one task; mesh forwarding one task;
// workflow dispatching one node) can wire in three lines instead of
// reimplementing the dance.
//
// Multi-target sources (gitlab handleIssue can dispatch N targets per
// webhook) bypass the helper and call `decideAndCommit` + `reportDivergence`
// directly per-target — the helper's 1:1 contract doesn't fit and trying to
// stretch it would only obscure what's happening.
//
// IMPORTANT: this helper currently treats `mode === "authoritative"` the
// same as `mode === "shadow"` — both run the ledger and the legacy path,
// with legacy still authoritative. The actual "use ledger decision as the
// dispatch" step is per-source and lands in commits 9–13 (the per-source
// promotions in §7's stage 1c). Until those land, flipping a source to
// "authoritative" is safe-but-no-op: behaviour matches shadow.

export interface ShadowAlongsideOptions {
  /** Override the singleton — used by tests to point at a tmp ledger. */
  ledger?: IntentLedger
  /** Override the environment — used by tests to drive mode without
   *  mutating process.env. */
  env?: NodeJS.ProcessEnv
  /** Override the clock — used by tests for deterministic timestamps. */
  now?: () => number
}

/**
 * Run a legacy dispatch path alongside the ledger. Returns the legacy
 * path's result unchanged. Records the ledger's decision and any
 * divergence — that's the entire shadow-mode contract.
 *
 * Mode handling:
 *   off            calls `legacy()` and returns. Ledger never touched.
 *   shadow         decideAndCommit → legacy → reportDivergence; return legacy.
 *   authoritative  same as shadow until per-source 1c wiring lands.
 *
 * The function is async so that `legacy` can be async (every real call site
 * is). `decideAndCommit` and `reportDivergence` are sync — the only async
 * step is the legacy work.
 */
export async function shadowAlongside<R>(
  source: IntentSource,
  event: IntentEventInput,
  policy: DispatchPolicy,
  legacy: () => Promise<R>,
  legacyToOutcome: (result: R) => LegacyOutcome,
  opts: ShadowAlongsideOptions = {},
): Promise<R> {
  const mode = getLedgerMode(source, opts.env)
  if (mode === "off") {
    return legacy()
  }

  const ledger = opts.ledger ?? getDefaultLedger()
  const ledgerDecision = decideAndCommit(ledger, event, policy, opts.now)
  const legacyResult = await legacy()
  reportDivergence(
    ledger,
    source,
    ledgerDecision,
    legacyToOutcome(legacyResult),
    opts.now,
  )
  return legacyResult
}
