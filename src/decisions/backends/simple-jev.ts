import type {
  DecisionBackend,
  DecisionBackendCapabilities,
  DecisionRequest,
  DecisionResponse,
} from "../backend"
import { finalizeAnswer } from "../normalize"
import { validateQuestions } from "../questions"
import { rawAnswersSchema, describeIssues } from "../schema"
import type { AnswersFor, AnyAnswer, Questions, RawAnswer } from "../types"
import { renderState } from "../prompt"
import type { z } from "zod"

// A backend for a simple-jev server (featherless-ai/simple-jev).
//
// Why this exists alongside the local one: simple-jev prefills the prompt
// and reads the model's next-token logits over the allowed answer labels,
// instead of asking a chat model to write a probability into its reply. The
// difference is visible in the output — a verbalized distribution comes back
// as 0.25/0.35/0.40, a logit one as 7.48e-05/9.61e-05/0.99983. One is a
// number a model chose; the other is its posterior over the label set.
//
// It is NOT a Jev replacement, and its own documentation says so: no
// reproduction of TypeSafe's architecture or training, and its output is
// explicitly "not calibrated probabilities of correctness". That last point
// is why this reports `calibratedProbabilities: false` like everything else
// — correctness calibration comes from a recalibrator fitted on your rows.
//
// Two deliberate choices about its response:
//
//   1. Its `confidence` is discarded and recomputed. simple-jev reports the
//      largest probability, which is not comparable across option counts:
//      uniform over 2 scores 0.5 and uniform over 10 scores 0.1, though both
//      are maximally uncertain. Our normalized-entropy definition is, and
//      rows from different backends have to be comparable in one store or
//      calibration pools apples and oranges.
//
//   2. No correction rounds. simple-jev builds the JSON server-side from
//      scores, so a schema mismatch is contract drift, not a model slip, and
//      re-asking cannot fix it. Failing loudly is the honest response.
//
// Licence note: as of 2026-09-18 the upstream repository ships no LICENSE
// file, which under default copyright means all rights reserved. That is a
// blocker for depending on a self-hosted deployment in production, though
// not for talking to a server someone else is running. Resolve it before
// this backend carries real traffic.

export interface SimpleJevOptions {
  /** Server root, e.g. http://127.0.0.1:8000/v1 */
  baseUrl?: string
  model?: string
  apiKeyEnv?: string
  timeoutMs?: number
  maxStateChars?: number
  /** Their Choice accepts 2-50 candidates, well under Jev's 255. */
  maxChoiceOptions?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_STATE_CHARS = 6_000
const DEFAULT_MAX_CHOICE_OPTIONS = 50

export function createSimpleJevBackend(opts: SimpleJevOptions = {}): DecisionBackend {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const maxStateChars = opts.maxStateChars ?? DEFAULT_MAX_STATE_CHARS
  const maxChoiceOptions = opts.maxChoiceOptions ?? DEFAULT_MAX_CHOICE_OPTIONS

  const capabilities: DecisionBackendCapabilities = {
    probabilitySource: "logits",
    calibratedProbabilities: false,
    maxChoiceOptions,
    maxStateChars,
    parallelQuestions: true,
    images: false,
  }

  return {
    name: "simple-jev",
    capabilities,
    async decide<Q extends Questions>(
      request: DecisionRequest<Q>,
    ): Promise<DecisionResponse<Q>> {
      validateQuestions(request.questions)
      assertChoiceCardinality(request.questions, maxChoiceOptions)

      const started = Date.now()
      const model = request.model ?? opts.model
      if (!model) throw new Error("simple-jev backend needs a model id")

      const rendered = renderState(request.state, maxStateChars)
      const doFetch = opts.fetchImpl ?? fetch

      const { signal, dispose } = deadline(
        request.abortSignal,
        request.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        const apiKey = opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : undefined
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`

        const res = await doFetch(`${baseUrl}/classifier`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            state: rendered.text,
            questions: withInstructions(request.questions),
          }),
          signal,
        })

        if (!res.ok) {
          const detail = await res.text().catch(() => "")
          throw new Error(`simple-jev ${res.status}: ${detail.slice(0, 300)}`)
        }

        const body = (await res.json()) as {
          model?: string
          answers?: unknown
          usage?: { input_tokens?: number; output_tokens?: number }
        }

        const parsed = rawAnswersSchema(request.questions).safeParse(body.answers)
        if (!parsed.success) {
          throw new Error(
            "simple-jev returned a response that does not match the requested questions " +
              `(contract drift, not a model slip — retrying will not help):\n${describeIssues(parsed.error as z.ZodError)}`,
          )
        }

        const raw = parsed.data as Record<string, RawAnswer>
        const answers: Record<string, AnyAnswer> = {}
        let repaired = false
        for (const [name, question] of Object.entries(request.questions)) {
          const result = finalizeAnswer(question, raw[name])
          answers[name] = result.answer
          if (result.repaired) repaired = true
        }

        return {
          model: body.model ?? model,
          answers: answers as AnswersFor<Q>,
          usage: {
            inputTokens: body.usage?.input_tokens ?? 0,
            outputTokens: body.usage?.output_tokens ?? 0,
          },
          meta: {
            backend: "simple-jev",
            // Never pooled with verbalized rows when computing calibration.
            structureMode: "logprobs",
            answerMode: "probabilities",
            repaired,
            retries: 0,
            stateTruncated: rendered.truncated,
            latencyMs: Date.now() - started,
          },
        }
      } finally {
        dispose()
      }
    },
  }
}

/** simple-jev requires `instructions` on every question; TypeSafe's own SDK
 *  marks it optional. Adapting here rather than tightening our builders is
 *  deliberate: the point of a backend registry is that one question set runs
 *  on every backend and can be graded against identical states. A contract
 *  that only works on one server would defeat the comparison this exists for.
 *
 *  The substitute is neutral and deterministic — it restates what the
 *  criteria already encode, and the caller's original questions are what get
 *  stored in the shadow store, so nothing about the recorded request is
 *  silently rewritten. */
const DEFAULT_INSTRUCTIONS: Record<string, string> = {
  choice: "Which option best fits?",
  score: "Which level best fits?",
  noul: "Is this true of the state?",
}

function withInstructions(questions: Questions): Questions {
  const out: Record<string, unknown> = {}
  for (const [name, question] of Object.entries(questions)) {
    out[name] = question.instructions
      ? question
      : { ...question, instructions: DEFAULT_INSTRUCTIONS[question.type] }
  }
  return out as Questions
}

function assertChoiceCardinality(questions: Questions, max: number): void {
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      const n = Object.keys(question.criteria).length
      if (n > max) {
        throw new Error(
          `question "${name}": simple-jev accepts at most ${max} choice options, got ${n}`,
        )
      }
    } else if (question.type === "score" && question.criteria.length > max) {
      throw new Error(
        `question "${name}": simple-jev accepts at most ${max} score levels, got ${question.criteria.length}`,
      )
    }
  }
}

function deadline(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`simple-jev timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  const onCallerAbort = () => controller.abort(caller?.reason)
  if (caller) {
    if (caller.aborted) onCallerAbort()
    else caller.addEventListener("abort", onCallerAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener("abort", onCallerAbort)
    },
  }
}
