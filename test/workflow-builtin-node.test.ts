import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { z } from "zod"
import { resolveHandler, workflowSchema, type Workflow } from "../src/workflows"
import { registerAllBuiltins, _resetBuiltinsForTesting } from "../src/actions/builtin"
import { registerBuiltin } from "../src/actions/builtin/registry"

beforeEach(() => {
  _resetBuiltinsForTesting()
  registerAllBuiltins()
})

afterEach(() => {
  _resetBuiltinsForTesting()
})

const baseWorkflow = (cfg: Record<string, unknown>): Workflow =>
  workflowSchema.parse({
    id: "test-builtin-wf",
    version: 2,
    title: "Test Builtin",
    priority: 0,
    fanOut: false,
    nodes: [
      { id: "trigger", type: "trigger.manual", config: {} },
      { id: "call", type: "action.builtin", config: cfg },
      { id: "done", type: "end", config: {} },
    ],
    edges: [
      { from: "trigger", to: "call" },
      { from: "call", to: "done" },
    ],
  })

const baseRun = (workflow: Workflow, context: Record<string, unknown> = {}) => ({
  id: "run-1",
  workflowId: workflow.id,
  status: "running" as const,
  startedAt: new Date().toISOString(),
  trigger: { source: "manual" } as const,
  pending: [],
  context,
  executions: [],
  joinCounters: {},
})

const ctxBase = {
  channels: {},
  agents: { execute: async () => ({ content: "" }) },
  actors: undefined,
  tasks: undefined,
} as any

describe("workflow node: action.builtin", () => {
  it("nodeTypeSchema accepts action.builtin", () => {
    const wf = baseWorkflow({ name: "http.fetch", input: { url: "https://example.test/" } })
    expect(wf.nodes.find((n) => n.id === "call")!.type).toBe("action.builtin")
  })

  it("resolveHandler returns the builtin handler for action.builtin", () => {
    const h = resolveHandler("action.builtin")
    expect(typeof h).toBe("function")
  })

  it("invokes the named built-in and returns its output verbatim", async () => {
    let captured: any = null
    registerBuiltin({
      name: "test.echo",
      description: "test",
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ echo: z.string(), at: z.number() }),
      handler: async (input: any) => { captured = input; return { echo: input.msg, at: 42 } },
    } as any)

    const wf = baseWorkflow({ name: "test.echo", input: { msg: "hello" } })
    const node = wf.nodes.find((n) => n.id === "call")!
    const handler = resolveHandler(node.type)!
    const result = await handler({
      ...ctxBase,
      workflow: wf,
      run: baseRun(wf),
      node,
    })
    expect(captured).toEqual({ msg: "hello" })
    expect(result.error).toBeUndefined()
    expect(result.output).toEqual({ echo: "hello", at: 42 })
  })

  it("returns an error (not throw) for unknown built-in", async () => {
    const wf = baseWorkflow({ name: "nope.gone", input: {} })
    const node = wf.nodes.find((n) => n.id === "call")!
    const handler = resolveHandler(node.type)!
    const result = await handler({
      ...ctxBase,
      workflow: wf,
      run: baseRun(wf),
      node,
    })
    expect(result.error).toMatch(/unknown built-in/)
  })

  it("returns an error (not throw) when input fails Zod validation", async () => {
    registerBuiltin({
      name: "test.strict",
      description: "test",
      inputSchema: z.object({ id: z.number().int() }),
      outputSchema: z.object({}),
      handler: async () => ({}),
    } as any)
    const wf = baseWorkflow({ name: "test.strict", input: { id: "not-a-number" } })
    const node = wf.nodes.find((n) => n.id === "call")!
    const handler = resolveHandler(node.type)!
    const result = await handler({
      ...ctxBase,
      workflow: wf,
      run: baseRun(wf),
      node,
    })
    expect(result.error).toMatch(/validation/)
  })

  it("templates {{prevNode.field}} into input from run context", async () => {
    let captured: any = null
    registerBuiltin({
      name: "test.capture",
      description: "test",
      inputSchema: z.object({ url: z.string() }),
      outputSchema: z.object({}),
      handler: async (input: any) => { captured = input; return {} },
    } as any)

    const wf = baseWorkflow({ name: "test.capture", input: { url: "{{trigger.url}}" } })
    const node = wf.nodes.find((n) => n.id === "call")!
    const handler = resolveHandler(node.type)!
    await handler({
      ...ctxBase,
      workflow: wf,
      run: baseRun(wf, { trigger: { url: "https://example.test/path?x=1" } }),
      node,
    })
    expect(captured.url).toBe("https://example.test/path?x=1")
  })

  it("rejects missing name with a clear error", async () => {
    const wf = baseWorkflow({ input: { x: 1 } })
    const node = wf.nodes.find((n) => n.id === "call")!
    const handler = resolveHandler(node.type)!
    const result = await handler({
      ...ctxBase,
      workflow: wf,
      run: baseRun(wf),
      node,
    })
    expect(result.error).toMatch(/needs a "name"/)
  })
})
