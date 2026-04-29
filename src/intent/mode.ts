import type { IntentSource } from "./types"

// Mode-flag plumbing — Phase 1 commit 4 of the architectural rescue.
//
// The staged rollout in research-rescue-plan.md §7 needs three states:
//
//   off            ledger code is unreachable; legacy paths are authoritative.
//                  This is the default and stays the default through 1a.
//   shadow         decideAndCommit runs alongside the legacy paths on every
//                  dispatch and records what *would* have happened. Legacy
//                  remains authoritative; a divergence reporter (commit 5)
//                  compares the two. The ≥7-day soak in 1b lives here.
//   authoritative  ledger decision is the dispatch decision. Legacy paths
//                  remain only as fallback gated by INTENT_LEDGER_FALLBACK
//                  (commit 1c → 1d removes the legacy paths entirely).
//
// Mode is resolved per-source so 1c can flip sources one at a time
// (gitlab → workflow → telegram → cron → mesh, ≥48h soak between each).
//
// This commit is plumbing only. No call site reads the mode yet —
// commit 6 wires the readers behind the flag, defaulting to "off" so
// production behaviour is unchanged at deploy time.

export type LedgerMode = "off" | "shadow" | "authoritative"

const VALID_MODES = ["off", "shadow", "authoritative"] as const satisfies readonly LedgerMode[]

/** Per-source env-var names. Lifted to a constant so the call site (commit 6)
 *  doesn't need to construct strings, and so the test matrix can drive them
 *  by table rather than guessing the naming convention. */
const PER_SOURCE_ENV_VAR: Record<IntentSource, string> = {
  telegram: "INTENT_LEDGER_MODE_TELEGRAM",
  gitlab: "INTENT_LEDGER_MODE_GITLAB",
  github: "INTENT_LEDGER_MODE_GITHUB",
  workflow: "INTENT_LEDGER_MODE_WORKFLOW",
  cron: "INTENT_LEDGER_MODE_CRON",
  mesh: "INTENT_LEDGER_MODE_MESH",
}

const GLOBAL_ENV_VAR = "INTENT_LEDGER_MODE"

/**
 * Resolve the ledger mode for one source. Resolution order:
 *
 *   1. Per-source env var (e.g. INTENT_LEDGER_MODE_GITLAB)
 *   2. Global env var (INTENT_LEDGER_MODE)
 *   3. Default — "off"
 *
 * Invalid values at any level (typos, foreign strings) are ignored — that
 * level falls through to the next. Defaulting to "off" on garbage means an
 * operator typo never accidentally promotes a source to authoritative; the
 * cost is silence on misconfig, but the cost of the alternative
 * (mis-promoted source) is much higher in production.
 *
 * The accepted values are case-insensitive ("Shadow", "SHADOW", "shadow"
 * all parse) so config copied from a doc or shell history doesn't surprise.
 *
 * Read every call rather than cached. Per-dispatch overhead is one or two
 * `process.env` lookups — negligible — and runtime flips (operator SIGHUPs
 * the daemon and changes `EnvironmentFile=` on systemd) take effect on the
 * next event without a restart.
 */
export function getLedgerMode(
  source: IntentSource,
  env: NodeJS.ProcessEnv = process.env,
): LedgerMode {
  const perSource = parseLedgerMode(env[PER_SOURCE_ENV_VAR[source]])
  if (perSource) return perSource
  const global = parseLedgerMode(env[GLOBAL_ENV_VAR])
  if (global) return global
  return "off"
}

/** Parse a value into a LedgerMode, or return null for invalid / unset. */
export function parseLedgerMode(value: unknown): LedgerMode | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return (VALID_MODES as readonly string[]).includes(normalized)
    ? (normalized as LedgerMode)
    : null
}

/** Convenience: is this source consulting the ledger at all? Equivalent to
 *  `getLedgerMode(source) !== "off"`, named for callsite readability. */
export function isLedgerActive(
  source: IntentSource,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getLedgerMode(source, env) !== "off"
}
