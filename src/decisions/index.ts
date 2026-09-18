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
export { createSimpleJevBackend } from "./backends/simple-jev"
export type { SimpleJevOptions } from "./backends/simple-jev"

import { registerDecisionBackend } from "./backend"
import { createMockDecisionBackend } from "./backends/mock"
import { createLocalDecisionBackend, type LocalBackendOptions } from "./backends/local-llm"
import { createSimpleJevBackend, type SimpleJevOptions } from "./backends/simple-jev"

/** Register the backends that ship in-tree. Explicit rather than
 *  import-time so tests can start from an empty registry. */
export function registerBuiltinDecisionBackends(
  local: LocalBackendOptions = {},
  simpleJev: SimpleJevOptions = {},
  jev: SimpleJevOptions = {},
): void {
  registerDecisionBackend("mock", () => createMockDecisionBackend())
  registerDecisionBackend("local", () => createLocalDecisionBackend(local))
  registerDecisionBackend("simple-jev", () => createSimpleJevBackend(simpleJev))
  // Jev via OpenRouter. UNVERIFIED: the endpoint exists and takes a normal
  // bearer token (a bogus key returns the same "User not found" as
  // /v1/chat/completions), but its request and response shape have not been
  // checked against a real key, and typesafe/jev-latest does not appear in
  // OpenRouter's public model list. If the shape differs, the call fails
  // with the backend's contract-drift error rather than silently
  // misinterpreting a response.
  registerDecisionBackend("jev", () =>
    createSimpleJevBackend({
      name: "jev",
      baseUrl: "https://openrouter.ai/api/alpha",
      path: "/decisions",
      model: "typesafe/jev-latest",
      apiKeyEnv: "OPENROUTER_API_KEY",
      // TypeSafe's claim is a model trained for calibrated decisions. The
      // claim is what this records; whether it holds on our traffic is what
      // `agentx decisions recalibrate` is for, and calibratedProbabilities
      // stays false until it is measured.
      probabilitySource: "native",
      maxChoiceOptions: 255,
      maxStateChars: 24_000,
      ...jev,
    }),
  )
}
