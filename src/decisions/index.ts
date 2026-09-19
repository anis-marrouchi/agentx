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
export * from "./consistency"
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
  typesafe: SimpleJevOptions = {},
): void {
  registerDecisionBackend("mock", () => createMockDecisionBackend())
  registerDecisionBackend("local", () => createLocalDecisionBackend(local))
  registerDecisionBackend("simple-jev", () => createSimpleJevBackend(simpleJev))
  // Jev via OpenRouter's alpha decisions endpoint. Verified against a live
  // key on 2026-09-19: POST /api/alpha/decisions with model "jev-latest"
  // resolves to typesafe/jev-1.13-20260917 with provider "TypeSafe", so
  // this is the real model rather than a proxy to something else. All
  // three primitives round-tripped in 0.49s from Tunisia at a cost of
  // $1.8e-05 for 429 input tokens.
  //
  // The model id is "jev-latest", NOT "typesafe/jev-latest" — the
  // namespaced form 400s with "does not exist", and the endpoint accepts
  // no generative models at all. It does not appear in OpenRouter's public
  // model list either, so the id cannot be discovered from /v1/models.
  registerDecisionBackend("jev", () =>
    createSimpleJevBackend({
      name: "jev",
      baseUrl: "https://openrouter.ai/api/alpha",
      path: "/decisions",
      model: "jev-latest",
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
  // Jev direct from TypeSafe, bypassing OpenRouter. Same System One
  // contract on /v1/systemone; the difference is billing and that it needs
  // a TypeSafe key rather than an OpenRouter one. Prefer this once you have
  // direct access: one less hop, and the vendor's own rate limits.
  registerDecisionBackend("typesafe", () =>
    createSimpleJevBackend({
      name: "typesafe",
      baseUrl: "https://api.typesafe.ai/v1",
      path: "/systemone",
      model: "jev-latest",
      apiKeyEnv: "TYPESAFE_API_KEY",
      probabilitySource: "native",
      maxChoiceOptions: 255,
      maxStateChars: 24_000,
      ...typesafe,
    }),
  )
}
