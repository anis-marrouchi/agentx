import { describe, it, expect, vi } from "vitest"
import { createLocalDecisionBackend } from "../../src/decisions/backends/local-llm"
import { choice, noul, score } from "../../src/decisions/questions"
import { TOOL_NAME } from "../../src/decisions/prompt"
import type { AgentProvider, RawGenerationResult } from "../../src/agent/providers/types"
import type { ChoiceAnswer, NoulAnswer } from "../../src/decisions/types"

const questions = {
  urgent: noul("is this urgent?"),
  area: choice({ billing: "money", technical: "engineering" }),
  quality: score(["poor", "fine", "good"]),
}

const goodAnswers = {
  urgent: { noul: 0.9 },
  area: { probabilities: { billing: 0.8, technical: 0.2 } },
  quality: { probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 } },
}

function toolResult(input: unknown): RawGenerationResult {
  return {
    content: [{ type: "tool_use", id: "t1", name: TOOL_NAME, input: input as any }],
    stop_reason: "tool_use",
    usage: { input_tokens: 120, output_tokens: 40 },
  }
}

/** A provider with generateRaw, i.e. one that can force a tool. */
function toolProvider(results: RawGenerationResult[], name = "claude") {
  const calls: any[] = []
  const provider: AgentProvider = {
    name,
    generate: vi.fn(),
    generateRaw: vi.fn(async (messages, systemPrompt, tools, options) => {
      calls.push({ messages, systemPrompt, tools, options })
      const next = results.shift()
      if (!next) throw new Error("no scripted result left")
      return next
    }) as any,
  }
  return { provider, calls }
}

/** A provider with no generateRaw — the claude-code-on-OAuth shape. */
function textProvider(contents: string[], name = "claude-code") {
  const calls: any[] = []
  const provider: AgentProvider = {
    name,
    generate: vi.fn(async (messages, options) => {
      calls.push({ messages, options })
      const next = contents.shift()
      if (next === undefined) throw new Error("no scripted content left")
      return { content: next, files: [], tokensUsed: 33 }
    }) as any,
  }
  return { provider, calls }
}

describe("local decision backend — tool mode", () => {
  it("forces the tool and sends a schema derived from the questions", async () => {
    const { provider, calls } = toolProvider([toolResult({ answers: goodAnswers })])
    const backend = createLocalDecisionBackend({ providerFactory: () => provider })

    const res = await backend.decide({ state: "I was charged twice", questions })

    expect(calls).toHaveLength(1)
    expect(calls[0].options.toolChoice).toEqual({ type: "tool", name: TOOL_NAME })

    const schema = calls[0].tools[0].input_schema
    expect(calls[0].tools[0].name).toBe(TOOL_NAME)
    expect(schema.required).toEqual(["answers"])
    const answers = schema.properties.answers
    expect(answers.required.sort()).toEqual(["area", "quality", "urgent"])
    expect(answers.additionalProperties).toBe(false)
    // The model is asked for probabilities and nothing else.
    expect(Object.keys(answers.properties.area.properties)).toEqual(["probabilities"])
    expect(answers.properties.area.properties.probabilities.required).toEqual([
      "billing",
      "technical",
    ])
    expect(Object.keys(answers.properties.urgent.properties)).toEqual(["noul"])

    expect(res.meta.structureMode).toBe("tool")
    expect(res.meta.retries).toBe(0)
    expect(res.meta.repaired).toBe(false)
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 40 })
    expect((res.answers.area as ChoiceAnswer).choice).toBe("billing")
    expect((res.answers.urgent as NoulAnswer).noul).toBe(0.9)
  })

  it("accepts a bare answers map without the wrapper", async () => {
    const { provider } = toolProvider([toolResult(goodAnswers)])
    const backend = createLocalDecisionBackend({ providerFactory: () => provider })
    const res = await backend.decide({ state: "x", questions })
    expect((res.answers.area as ChoiceAnswer).choice).toBe("billing")
  })

  it("spends one correction round on malformed structure, then succeeds", async () => {
    const { provider, calls } = toolProvider([
      toolResult({ answers: { urgent: { probability_yes: 0.9 } } }),
      toolResult({ answers: goodAnswers }),
    ])
    const backend = createLocalDecisionBackend({ providerFactory: () => provider })

    const res = await backend.decide({ state: "x", questions })

    expect(res.meta.retries).toBe(1)
    expect(calls).toHaveLength(2)
    // The correction names what was wrong and is appended, not substituted.
    const correction = calls[1].messages[calls[1].messages.length - 1].content
    expect(correction).toMatch(/did not match the required structure/)
    expect(correction).toMatch(/urgent/)
    // Token usage covers every attempt, not just the winning one.
    expect(res.usage.inputTokens).toBe(240)
  })

  it("gives up after the retry budget and says how many attempts it made", async () => {
    const bad = () => toolResult({ answers: { nope: true } })
    const { provider } = toolProvider([bad(), bad()])
    const backend = createLocalDecisionBackend({ providerFactory: () => provider })
    await expect(backend.decide({ state: "x", questions })).rejects.toThrow(
      /could not get a valid answer after 2 attempt\(s\)/,
    )
  })

  it("repairs a distribution that does not sum to one and says so", async () => {
    const { provider } = toolProvider([
      toolResult({
        answers: { ...goodAnswers, area: { probabilities: { billing: 8, technical: 2 } } },
      }),
    ])
    const backend = createLocalDecisionBackend({ providerFactory: () => provider })
    const res = await backend.decide({ state: "x", questions })
    const area = res.answers.area as ChoiceAnswer
    expect(area.probabilities.billing).toBeCloseTo(0.8, 10)
    expect(res.meta.repaired).toBe(true)
  })
})

describe("local decision backend — text mode", () => {
  it("falls back to text for a provider that cannot force a tool", async () => {
    const { provider, calls } = textProvider([
      "```json\n" + JSON.stringify({ answers: goodAnswers }) + "\n```",
    ])
    const backend = createLocalDecisionBackend({ providerFactory: () => provider })

    const res = await backend.decide({ state: "x", questions })

    expect(res.meta.structureMode).toBe("text")
    expect((res.answers.area as ChoiceAnswer).choice).toBe("billing")
    // Text mode has no schema to lean on, so the shape is spelled out.
    const userTurn = calls[0].messages[1].content
    expect(userTurn).toMatch(/## Output/)
    expect(userTurn).toMatch(/Reply with this JSON object and nothing else/)
  })

  it("stays in text mode even when the provider claims structured output", async () => {
    const { provider } = textProvider([JSON.stringify(goodAnswers)], "claude")
    const backend = createLocalDecisionBackend({
      providerFactory: () => provider,
      structureMode: "text",
    })
    const res = await backend.decide({ state: "x", questions })
    expect(res.meta.structureMode).toBe("text")
  })

  it("digs the object out of surrounding prose", async () => {
    const { provider } = textProvider([
      `Sure, here you go:\n${JSON.stringify({ answers: goodAnswers })}\nLet me know!`,
    ])
    const backend = createLocalDecisionBackend({ providerFactory: () => provider })
    const res = await backend.decide({ state: "x", questions })
    expect((res.answers.urgent as NoulAnswer).noul).toBe(0.9)
  })
})

describe("local decision backend — contract", () => {
  it("does not claim its probabilities are calibrated", () => {
    const backend = createLocalDecisionBackend({ providerFactory: () => textProvider([]).provider })
    expect(backend.capabilities.calibratedProbabilities).toBe(false)
  })

  it("reports truncation when the state exceeds the budget", async () => {
    const { provider } = toolProvider([toolResult({ answers: goodAnswers })])
    const backend = createLocalDecisionBackend({
      providerFactory: () => provider,
      maxStateChars: 50,
    })
    const res = await backend.decide({ state: "x".repeat(500), questions })
    expect(res.meta.stateTruncated).toBe(true)
  })

  it("rejects answerMode discrete rather than silently returning probabilities", () => {
    expect(() => createLocalDecisionBackend({ answerMode: "discrete" })).toThrow(
      /answerMode "probabilities" only/,
    )
  })

  it("validates the question set before spending a call", async () => {
    const { provider, calls } = toolProvider([])
    const backend = createLocalDecisionBackend({ providerFactory: () => provider })
    await expect(backend.decide({ state: "x", questions: {} })).rejects.toThrow(
      /at least one question/,
    )
    expect(calls).toHaveLength(0)
  })
})
