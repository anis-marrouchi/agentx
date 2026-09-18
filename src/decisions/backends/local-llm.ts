import { createProvider, type ProviderName } from "@/agent/providers"
import { PROVIDER_CAPABILITIES } from "@/agent/providers/capabilities"
import type { AgentProvider } from "@/agent/providers/types"
import { extractJson } from "@/utils/extract-json"
import type {
  AnswerMode,
  DecisionBackend,
  DecisionBackendCapabilities,
  DecisionRequest,
  DecisionResponse,
  StructureMode,
} from "../backend"
import { finalizeAnswer } from "../normalize"
import {
  SYSTEM_PROMPT,
  TOOL_NAME,
  renderShapeInstructions,
  renderUserPrompt,
  toolInputSchema,
} from "../prompt"
import { validateQuestions } from "../questions"
import { describeIssues, rawAnswersSchema } from "../schema"
import type { AnswersFor, AnyAnswer, Questions, RawAnswer, RawAnswers } from "../types"
import { z } from "zod"

// The System One contract, served by an ordinary chat model.
//
// READ THIS BEFORE TRUSTING A NUMBER THIS BACKEND RETURNS.
//
// In "tool" mode the model is forced to emit a value matching a schema, so
// the answer is guaranteed well-formed. In "text" mode we ask nicely and
// repair. Neither produces a CALIBRATED probability. A number the model
// wrote into its answer is a number it chose; it is not a measurement of
// its own uncertainty, and models tuned on human preference are
// systematically overconfident about it — which is the entire premise of
// the decision-model vendors.
//
// What this backend genuinely buys:
//   - one call for N questions against one shared state
//   - a guaranteed shape, so no call site hand-parses prose
//   - an ordinal signal that is usually better than nothing
//   - rows in the shadow store, which is where calibration actually
//     comes from: a temperature fitted on a few hundred of your own
//     labeled decisions beats any number the model hands you
//
// A backend reporting `calibratedProbabilities: false` is not a defect to
// fix later. It is the honest value, and the harness exists to measure how
// much it costs.

const DEFAULT_PROVIDER: ProviderName = "claude-code"
const DEFAULT_MODEL = "claude-haiku-4-5-20251001"
const DEFAULT_MAX_STATE_CHARS = 24_000
const DEFAULT_MAX_TOKENS = 2_000
const DEFAULT_TIMEOUT_MS = 30_000

export interface LocalBackendOptions {
  provider?: ProviderName
  model?: string
  /** "auto" resolves to "tool" when the provider guarantees structured
   *  output and "text" otherwise. Never resolves to "logprobs": that mode
   *  costs one call per question, so it has to be asked for explicitly. */
  structureMode?: "auto" | "tool" | "text"
  answerMode?: AnswerMode
  normalizeProbabilities?: boolean
  nRetryMalformedStructure?: number
  temperature?: number
  maxStateChars?: number
  maxTokens?: number
  timeoutMs?: number
  /** Injected in tests. Production resolves through createProvider. */
  providerFactory?: () => AgentProvider
}

export function createLocalDecisionBackend(opts: LocalBackendOptions = {}): DecisionBackend {
  if (opts.answerMode && opts.answerMode !== "probabilities") {
    throw new Error(
      `local decision backend supports answerMode "probabilities" only (got "${opts.answerMode}")`,
    )
  }

  const maxStateChars = opts.maxStateChars ?? DEFAULT_MAX_STATE_CHARS
  const capabilities: DecisionBackendCapabilities = {
    probabilitySource: "verbalized",
  calibratedProbabilities: false,
    maxChoiceOptions: 255,
    maxStateChars,
    parallelQuestions: true,
    images: false,
  }

  let provider: AgentProvider | null = null
  const resolveProvider = (): AgentProvider => {
    if (!provider) {
      provider = opts.providerFactory
        ? opts.providerFactory()
        : createProvider(opts.provider ?? DEFAULT_PROVIDER)
    }
    return provider
  }

  return {
    name: "local",
    capabilities,
    async decide<Q extends Questions>(
      request: DecisionRequest<Q>,
    ): Promise<DecisionResponse<Q>> {
      validateQuestions(request.questions)

      const started = Date.now()
      const model = request.model ?? opts.model ?? DEFAULT_MODEL
      const agent = resolveProvider()
      const structureMode = resolveStructureMode(opts.structureMode ?? "auto", agent)
      const prompt = renderUserPrompt(request.state, request.questions, maxStateChars)
      const schema = rawAnswersSchema(request.questions)
      const maxRetries = opts.nRetryMalformedStructure ?? 1

      const { signal, dispose } = deadline(
        request.abortSignal,
        request.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )

      let usage = { inputTokens: 0, outputTokens: 0 }
      let correction: string | null = null
      let retries = 0
      let raw: RawAnswers | null = null
      let lastError = "no attempt was made"

      try {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) retries++

          const call =
            structureMode === "tool"
              ? callWithForcedTool(agent, request.questions, prompt.text, correction, {
                  model,
                  maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
                  temperature: opts.temperature ?? 0,
                  abortSignal: signal,
                })
              : callWithText(agent, request.questions, prompt.text, correction, {
                  model,
                  maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
                  temperature: opts.temperature ?? 0,
                  abortSignal: signal,
                })

          const result = await call
          usage = {
            inputTokens: usage.inputTokens + result.usage.inputTokens,
            outputTokens: usage.outputTokens + result.usage.outputTokens,
          }

          const parsed = schema.safeParse(result.answers)
          if (parsed.success) {
            raw = parsed.data as RawAnswers
            break
          }
          lastError = describeIssues(parsed.error as z.ZodError)
          correction = [
            "Your previous reply did not match the required structure:",
            lastError,
            "",
            "Reply again with the corrected structure only.",
          ].join("\n")
        }

        if (!raw) {
          throw new Error(
            `local decision backend could not get a valid answer after ${retries + 1} attempt(s): ${lastError}`,
          )
        }

        const answers: Record<string, AnyAnswer> = {}
        let repaired = false
        for (const [name, question] of Object.entries(request.questions)) {
          const result = finalizeAnswer(question, raw[name] as RawAnswer, {
            normalize: opts.normalizeProbabilities ?? true,
          })
          answers[name] = result.answer
          if (result.repaired) repaired = true
        }

        return {
          model,
          answers: answers as AnswersFor<Q>,
          usage,
          meta: {
            backend: "local",
            structureMode,
            answerMode: "probabilities",
            repaired,
            retries,
            stateTruncated: prompt.truncated,
            latencyMs: Date.now() - started,
          },
        }
      } finally {
        dispose()
      }
    },
  }
}

interface AttemptResult {
  answers: unknown
  usage: { inputTokens: number; outputTokens: number }
}

interface CallOptions {
  model: string
  maxTokens: number
  temperature: number
  abortSignal: AbortSignal
}

async function callWithForcedTool(
  agent: AgentProvider,
  questions: Questions,
  userPrompt: string,
  correction: string | null,
  options: CallOptions,
): Promise<AttemptResult> {
  if (!agent.generateRaw) {
    throw new Error(`provider "${agent.name}" has no generateRaw(); use structureMode "text"`)
  }

  const messages = [
    { role: "user" as const, content: userPrompt },
    ...(correction ? [{ role: "user" as const, content: correction }] : []),
  ]

  const result = await agent.generateRaw(
    messages,
    SYSTEM_PROMPT,
    [
      {
        name: TOOL_NAME,
        description: "Report a probability distribution for every question.",
        input_schema: toolInputSchema(questions),
      },
    ],
    { ...options, toolChoice: { type: "tool", name: TOOL_NAME } },
  )

  const block = result.content.find((b) => b.type === "tool_use" && b.name === TOOL_NAME)
  const input = block && block.type === "tool_use" ? block.input : null

  return {
    answers: unwrapAnswers(input),
    usage: {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    },
  }
}

async function callWithText(
  agent: AgentProvider,
  questions: Questions,
  userPrompt: string,
  correction: string | null,
  options: CallOptions,
): Promise<AttemptResult> {
  const content = [userPrompt, renderShapeInstructions(questions)].join("\n")
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content },
    ...(correction ? [{ role: "user" as const, content: correction }] : []),
  ]

  const result = await agent.generate(messages, options)
  return {
    answers: unwrapAnswers(extractJson(result.content ?? "")),
    usage: { inputTokens: 0, outputTokens: result.tokensUsed ?? 0 },
  }
}

/** Accept both `{ answers: {...} }` and a bare answers map. Models drop the
 *  wrapper often enough that rejecting it would spend correction rounds on
 *  a difference that carries no information. */
function unwrapAnswers(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const wrapper = value as { answers?: unknown }
    if (wrapper.answers && typeof wrapper.answers === "object") return wrapper.answers
  }
  return value
}

function resolveStructureMode(
  requested: "auto" | "tool" | "text",
  agent: AgentProvider,
): StructureMode {
  if (requested !== "auto") return requested
  if (!agent.generateRaw) return "text"
  // Resolved name, not the configured one: createProvider("claude-code")
  // falls through to whatever the stored auth config selected.
  return PROVIDER_CAPABILITIES[agent.name]?.structuredOutput ? "tool" : "text"
}

/** One signal that fires on either the caller's cancel or our own timeout.
 *  Hand-rolled rather than AbortSignal.any so this does not depend on the
 *  lib target's typings. */
function deadline(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`decision timed out after ${timeoutMs}ms`)),
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
