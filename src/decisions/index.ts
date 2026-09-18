// Typed-decision seat.
//
// A decision seat does not make a decision better. It makes the decision's
// uncertainty legible. Attached to a call site with no ground truth, it buys
// a more expensive number and a dashboard that cannot be wrong — so the
// calibration harness is not optional polish, it is the only thing that
// separates this from the self-reported `confidence` fields the codebase
// already has several of and trusts none of.
//
// See docs/architecture (and the plan that introduced this module) for the
// full contract. Start at ./types.ts.

export * from "./types"
export * from "./questions"
export * from "./normalize"
export * from "./schema"
export * from "./backend"
export * from "./prompt"
export * from "./store"
export * from "./calibration"
export * from "./recalibrate"
export * from "./seat"
export { createMockDecisionBackend } from "./backends/mock"
export type { MockBackendOptions } from "./backends/mock"
export { createLocalDecisionBackend } from "./backends/local-llm"
export type { LocalBackendOptions } from "./backends/local-llm"

import { registerDecisionBackend } from "./backend"
import { createMockDecisionBackend } from "./backends/mock"
import { createLocalDecisionBackend, type LocalBackendOptions } from "./backends/local-llm"

/** Register the backends that ship in-tree. Explicit rather than
 *  import-time so tests can start from an empty registry. */
export function registerBuiltinDecisionBackends(local: LocalBackendOptions = {}): void {
  registerDecisionBackend("mock", () => createMockDecisionBackend())
  registerDecisionBackend("local", () => createLocalDecisionBackend(local))
}
