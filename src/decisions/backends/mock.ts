import type {
  AnswerMode,
  DecisionBackend,
  DecisionBackendCapabilities,
  DecisionRequest,
  DecisionResponse,
} from "../backend"
import { finalizeAnswer } from "../normalize"
import { labelsOf, validateQuestions } from "../questions"
import type { AnswersFor, AnyAnswer, Questions, RawAnswer } from "../types"

// A backend with no model behind it.
//
// Two jobs: let the seat, the store and the calibration maths be tested
// without a network or an API key, and give `agentx decisions` something to
// smoke against. Answers are deterministic in (state, question, label), so
// the same input always produces the same distribution and a test can assert
// on exact numbers.

export interface MockBackendOptions {
  /** Raw answers keyed by question name. Anything not scripted is derived
   *  deterministically from the state. */
  answers?: Record<string, RawAnswer>
  /** Rejects with this instead of answering. For exercising the seat's
   *  fail-open path. */
  fail?: Error
  latencyMs?: number
}

const capabilities: DecisionBackendCapabilities = {
  probabilitySource: "synthetic",
  calibratedProbabilities: false,
  maxChoiceOptions: 255,
  maxStateChars: 24_000,
  parallelQuestions: true,
  images: false,
}

export function createMockDecisionBackend(opts: MockBackendOptions = {}): DecisionBackend {
  return {
    name: "mock",
    capabilities,
    async decide<Q extends Questions>(
      request: DecisionRequest<Q>,
    ): Promise<DecisionResponse<Q>> {
      if (opts.fail) throw opts.fail
      validateQuestions(request.questions)

      const stateText = JSON.stringify(request.state ?? null)
      const answers: Record<string, AnyAnswer> = {}
      let repaired = false

      for (const [name, question] of Object.entries(request.questions)) {
        const raw = opts.answers?.[name] ?? syntheticRaw(stateText, name, question)
        const result = finalizeAnswer(question, raw)
        answers[name] = result.answer
        if (result.repaired) repaired = true
      }

      const answerMode: AnswerMode = "probabilities"
      return {
        model: request.model ?? "mock",
        answers: answers as AnswersFor<Q>,
        usage: { inputTokens: stateText.length, outputTokens: 0 },
        meta: {
          backend: "mock",
          structureMode: "mock",
          answerMode,
          repaired,
          retries: 0,
          stateTruncated: false,
          latencyMs: opts.latencyMs ?? 0,
        },
      }
    },
  }
}

function syntheticRaw(
  stateText: string,
  name: string,
  question: Questions[string],
): RawAnswer {
  if (question.type === "noul") {
    return { noul: unitHash(`${stateText}|${name}|noul`) }
  }
  const labels = labelsOf(question)
  const weights = labels.map((label) => unitHash(`${stateText}|${name}|${label}`) + 1e-3)
  const total = weights.reduce((a, b) => a + b, 0)
  const probabilities: Record<string, number> = {}
  labels.forEach((label, i) => {
    probabilities[label] = weights[i] / total
  })
  return { probabilities }
}

/** FNV-1a, mapped to [0, 1). Stable across runs and platforms, which is the
 *  only property that matters here. */
function unitHash(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h / 0x100000000
}
