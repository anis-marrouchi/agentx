import { IntentLedger } from "./ledger"

// Daemon-process singleton accessor for the IntentLedger.
//
// Phase 1 commit 6.0 — scaffolding for the call-site wiring that lands in
// 6.a (gitlab), 6.b (router), 6.c (workflow), 6.d (cron + mesh). Each
// source's wrapper will read this singleton when the mode is non-"off".
//
// The singleton is lazy because the ledger isn't needed in production
// until the operator flips INTENT_LEDGER_MODE off the default. Avoiding
// eager construction means an unflipped agentx process never opens the
// ledger db, never holds the file, never writes WAL pages — exactly what
// "deploy-time default is off" means in practice.
//
// Tests use `setLedgerForTesting` to inject an in-memory or tmp-dir
// ledger and `resetLedgerForTesting` to release it between cases. Outside
// of tests, callers go through `getDefaultLedger()`.

let _ledger: IntentLedger | undefined

export interface DefaultLedgerOptions {
  /** Path override. Default: `.agentx/intent/ledger.sqlite` (resolved
   *  against cwd by the IntentLedger constructor). */
  path?: string
}

/**
 * Lazy singleton getter. Idempotent — repeated calls return the same
 * handle. Constructs the ledger on first call.
 *
 * Throws on construction failure (file unwritable, native binding broken,
 * etc.). Call sites should gate the call behind `getLedgerMode(...) !== "off"`
 * so a bad ledger never reaches construction in normal "off" production.
 *
 * The decision to throw rather than fail-soft (return null like
 * src/storage/sqlite.ts does) is deliberate: the ledger is canonical
 * state once `mode !== "off"`, so a silent failure would leave the
 * dispatcher in an undefined "I tried to record but didn't" state. Loud
 * failure surfaces misconfig at startup rather than days into a soak.
 */
export function getDefaultLedger(opts: DefaultLedgerOptions = {}): IntentLedger {
  if (_ledger) return _ledger
  _ledger = new IntentLedger({ path: opts.path })
  return _ledger
}

/** Test-only: inject a pre-built ledger so per-test tmp dirs work without
 *  fighting the singleton. Production code MUST NOT call this. */
export function setLedgerForTesting(ledger: IntentLedger): void {
  _ledger = ledger
}

/** Test-only: drop the singleton reference. Use in `afterEach` so the
 *  next test's `setLedgerForTesting` or `getDefaultLedger` starts fresh.
 *  Does NOT close the underlying db — the caller (test) owns close(). */
export function resetLedgerForTesting(): void {
  _ledger = undefined
}
