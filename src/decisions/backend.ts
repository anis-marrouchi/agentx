import type { AnswersFor, Questions, StateValue } from "./types"

// The backend contract, and the registry that resolves one by name.
//
// Why this is its own registry and not `AgentProvider.decide?()`:
//
//   1. `ProviderName` is what an AGENT is configured with. Adding a
//      decision-only model to that union would make it selectable as an
//      agent's chat provider in agentx.json, the setup wizard and
//      `agentx model` — where it fails, because a System One model has no
//      prose, no stream and no tools. That is a type that lies.
//
//   2. The unit of selection differs. Chat providers are per-agent;
//      decision backends are per-SEAT. Running one seat on the local
//      adapter and another on a hosted model simultaneously is exactly how
//      a backend swap gets graded, and a per-agent union cannot say it.
//
//   3. The local backend COMPOSES the chat registry (it calls
//      createProvider internally) rather than extending it. One adapter
//      over N providers is less code than N providers each reimplementing
//      normalization, retry and confidence.

/** How the structured answer was obtained. Recorded on every call, and
 *  never pooled across values when computing calibration: a verbalized
 *  probability and a token posterior are different measurements. */
export type StructureMode =
  | "tool"
  | "json_schema"
  | "text"
  | "logprobs"
  | "vote"
  | "native"
  | "mock"

export type AnswerMode = "probabilities" | "discrete"

export interface DecisionMeta {
  backend: string
  structureMode: StructureMode
  answerMode: AnswerMode
  /** At least one answer had to be repaired during normalization. */
  repaired: boolean
  /** Correction rounds spent on malformed structure. */
  retries: number
  /** State exceeded the backend's budget and was clipped. Shadow analysis
   *  needs this to know which rows to exclude. */
  stateTruncated: boolean
  latencyMs: number
}

export interface DecisionRequest<Q extends Questions> {
  state: StateValue
  questions: Q
  /** Backend-scoped model id. Omitted means the backend's default. */
  model?: string
  abortSignal?: AbortSignal
  timeoutMs?: number
}

export interface DecisionResponse<Q extends Questions> {
  model: string
  answers: AnswersFor<Q>
  usage: { inputTokens: number; outputTokens: number }
  meta: DecisionMeta
}

/** Where the numbers come from. Factual, not a judgement of quality.
 *
 *  verbalized  the model wrote the probability into its answer. Well-formed,
 *              quantized at round values, and not the model's own posterior.
 *  logits      read off the next-token distribution at the answer position.
 *              This IS the model's posterior over the label set.
 *  native      a model whose training objective targeted the distribution. */
export type ProbabilitySource = "verbalized" | "logits" | "native" | "synthetic"

export interface DecisionBackendCapabilities {
  probabilitySource: ProbabilitySource
  /** Calibrated to CORRECTNESS on your traffic — i.e. an answer given 0.8
   *  is right about 80% of the time here.
   *
   *  This is not the same as reading real logits. A token posterior is the
   *  model's own belief, which can be confidently wrong; simple-jev makes
   *  exactly this point about its own output. Correctness calibration comes
   *  from a recalibrator fitted on your labeled rows, not from a backend,
   *  so every backend reports false until one is demonstrably trained for
   *  it. Prefer `probabilitySource` when choosing a backend. */
  calibratedProbabilities: boolean
  maxChoiceOptions: number
  maxStateChars: number
  /** False forces the caller to loop per question. Every backend worth
   *  shipping is true; the flag exists so that a backend that isn't cannot
   *  quietly multiply request counts. */
  parallelQuestions: boolean
  images: false
}

export interface DecisionBackend {
  readonly name: string
  readonly capabilities: DecisionBackendCapabilities
  decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionResponse<Q>>
}

type BackendFactory = () => DecisionBackend

const factories = new Map<string, BackendFactory>()
const instances = new Map<string, DecisionBackend>()

/** Register a backend under a name. Factories are lazy so that registering
 *  a backend never reads config, opens a socket or requires a key that the
 *  operator may not have. */
export function registerDecisionBackend(name: string, factory: BackendFactory): void {
  factories.set(name, factory)
  instances.delete(name)
}

export function getDecisionBackend(name: string): DecisionBackend {
  const cached = instances.get(name)
  if (cached) return cached
  const factory = factories.get(name)
  if (!factory) {
    const known = listDecisionBackends()
    throw new Error(
      `unknown decision backend "${name}"` +
        (known.length > 0 ? ` — registered: ${known.join(", ")}` : " — none registered"),
    )
  }
  const backend = factory()
  instances.set(name, backend)
  return backend
}

export function listDecisionBackends(): string[] {
  return [...factories.keys()].sort()
}

export function _resetDecisionBackendsForTesting(): void {
  factories.clear()
  instances.clear()
}
