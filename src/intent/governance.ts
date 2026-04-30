import type { DispatchGovernance } from "./decide"

// Daemon-level governance singleton — Phase 3 of the architectural rescue.
//
// `decideAndCommit` reads this when its caller doesn't pass an explicit
// `governance` argument. The daemon initializes it at startup from the
// `BusinessLayer.organization` instance, gated by the
// `INTENT_PM_GATE_ENABLED` env var. When the var is unset (the deploy
// default), the singleton stays undefined and no PM gate / canHandle
// check fires — production behaviour is unchanged.
//
// This indirection keeps governance an opt-in concern: call sites and
// helpers (`recordGitLabTargetDispatch`, `recordRouterDispatch`, etc.)
// don't need to know about Organization. The daemon plumbs Organization
// → DispatchGovernance once at startup; everything else stays generic.
//
// Tests reset between cases via `setDefaultGovernance(undefined)` to
// avoid leakage from one test's fixture into another's behaviour.

let _governance: DispatchGovernance | undefined

/** Set the process-wide default governance. Called once at daemon
 *  startup (or never, if INTENT_PM_GATE_ENABLED is off). */
export function setDefaultGovernance(g: DispatchGovernance | undefined): void {
  _governance = g
}

/** Read the current default. `decideAndCommit` falls back to this when
 *  its caller didn't pass an explicit governance arg. Returns undefined
 *  in test contexts that haven't set anything (no governance fires). */
export function getDefaultGovernance(): DispatchGovernance | undefined {
  return _governance
}
