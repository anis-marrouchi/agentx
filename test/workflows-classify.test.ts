import { beforeEach, describe, expect, it, vi } from "vitest"
import { classifyHandler, UNSURE_PORT } from "../src/workflows/nodes/classify"
import * as seat from "../src/decisions/seat"

const ctx = (config: Record<string, unknown>, context: Record<string, unknown> = {}) => ({
  workflow: { id: "wf", envAllow: [] },
  run: { context },
  node: { id: "n1", type: "classify", config },
  channels: {},
  agents: { execute: async () => ({}) },
  log: () => {},
}) as never

const answer = (choice: string, confidence: number, probabilities?: Record<string, number>) => ({
  answers: { label: { choice, confidence, probabilities: probabilities ?? { [choice]: confidence } } },
  callId: "c1",
  mode: "active" as const,
})

let ask: ReturnType<typeof vi.spyOn>
beforeEach(() => { ask = vi.spyOn(seat, "askSeat") })

const LABELS = { bug: "a defect", feature: "a request", question: "a query" }

describe("classify node", () => {
  it("fires the port named after the label it picked", async () => {
    ask.mockResolvedValue(answer("bug", 0.93) as never)
    const r = await classifyHandler(ctx({ input: "it crashes", labels: LABELS }))
    expect(r.port).toBe("bug")
    expect(r.output).toMatchObject({ label: "bug", confidence: 0.93, unsure: false })
  })

  it("returns the whole distribution, which the RESULT-token pattern could not", async () => {
    ask.mockResolvedValue(answer("bug", 0.6, { bug: 0.6, feature: 0.3, question: 0.1 }) as never)
    const r = await classifyHandler(ctx({ input: "x", labels: LABELS, minConfidence: 0.5 }))
    expect(r.output?.probabilities).toEqual({ bug: 0.6, feature: 0.3, question: 0.1 })
  })

  it("routes to `unsure` below the threshold instead of guessing", async () => {
    // The whole reason for the node: a workflow can escalate the cases it
    // should not have guessed at.
    ask.mockResolvedValue(answer("bug", 0.42) as never)
    const r = await classifyHandler(ctx({ input: "x", labels: LABELS, minConfidence: 0.7 }))
    expect(r.port).toBe(UNSURE_PORT)
    expect(r.output).toMatchObject({ unsure: true, label: "bug" })
  })

  it("keeps `result` as an alias so an agent-node workflow can swap in place", async () => {
    ask.mockResolvedValue(answer("bug", 0.9) as never)
    const r = await classifyHandler(ctx({ input: "x", labels: LABELS }))
    expect(r.output?.result).toBe("bug")
  })

  it("defaults the threshold to 0.7", async () => {
    ask.mockResolvedValue(answer("bug", 0.69) as never)
    expect((await classifyHandler(ctx({ input: "x", labels: LABELS }))).port).toBe(UNSURE_PORT)
    ask.mockResolvedValue(answer("bug", 0.71) as never)
    expect((await classifyHandler(ctx({ input: "x", labels: LABELS }))).port).toBe("bug")
  })

  it("accepts a bare label list as well as a described map", async () => {
    ask.mockResolvedValue(answer("a", 0.9) as never)
    const r = await classifyHandler(ctx({ input: "x", labels: ["a", "b"] }))
    expect(r.port).toBe("a")
  })

  it("templates the input from run context", async () => {
    ask.mockResolvedValue(answer("bug", 0.9) as never)
    await classifyHandler(ctx({ input: "{{trigger.text}}", labels: LABELS }, { trigger: { text: "it crashes" } }))
    expect(ask.mock.calls[0][1]).toMatchObject({ input: "it crashes" })
  })

  it("passes extra templated state to the model", async () => {
    ask.mockResolvedValue(answer("bug", 0.9) as never)
    await classifyHandler(ctx(
      { input: "x", labels: LABELS, state: { project: "{{trigger.project}}" } },
      { trigger: { project: "acme/widgets" } },
    ))
    expect(ask.mock.calls[0][1]).toMatchObject({ project: "acme/widgets" })
  })

  it("fails the node when the seat is unavailable rather than picking a port", async () => {
    // A branch that silently picks a direction when its decision
    // procedure is down is how a workflow does the wrong thing
    // confidently.
    ask.mockResolvedValue(null as never)
    const r = await classifyHandler(ctx({ input: "x", labels: LABELS }))
    expect(r.error).toMatch(/seat unavailable/)
    expect(r.port).toBeUndefined()
  })

  it("rejects a config with fewer than two labels", async () => {
    const r = await classifyHandler(ctx({ input: "x", labels: { only: "one" } }))
    expect(r.error).toMatch(/at least two labels/)
  })

  it("rejects `unsure` as a label, which would collide with the low-confidence port", async () => {
    const r = await classifyHandler(ctx({ input: "x", labels: { bug: null, unsure: null } }))
    expect(r.error).toMatch(/reserved/)
  })

  it("rejects an empty input", async () => {
    const r = await classifyHandler(ctx({ input: "{{missing}}", labels: LABELS }))
    expect(r.error).toMatch(/missing config.input/)
  })

  it("is registered under the `classify` node kind", async () => {
    const { resolveHandler } = await import("../src/workflows/nodes/handlers")
    expect(resolveHandler("classify")).toBe(classifyHandler)
  })

  it("declares an output schema, so the editor can show its paths", async () => {
    const { NODE_OUTPUTS } = await import("../src/workflows/nodes/schemas")
    const paths = (NODE_OUTPUTS as never as Record<string, { fields: Array<{ path: string }> }>)
      .classify.fields.map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining(["label", "confidence", "probabilities", "unsure", "port"]))
  })
})
