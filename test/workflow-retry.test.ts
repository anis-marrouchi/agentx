import { describe, it, expect } from "vitest"
import { retryPolicySchema, workflowNodeSchema, workflowSchema } from "../src/workflows"

describe("retryPolicySchema (improvement plan #9b)", () => {
  it("defaults to maxAttempts=1, backoffMs=1000 (no retry)", () => {
    const r = retryPolicySchema.parse(undefined)
    expect(r.maxAttempts).toBe(1)
    expect(r.backoffMs).toBe(1000)
  })

  it("rejects negative or zero maxAttempts", () => {
    expect(() => retryPolicySchema.parse({ maxAttempts: 0, backoffMs: 100 })).toThrow()
    expect(() => retryPolicySchema.parse({ maxAttempts: -1, backoffMs: 100 })).toThrow()
  })

  it("caps maxAttempts at 10 (keeps soak budgets bounded)", () => {
    expect(() => retryPolicySchema.parse({ maxAttempts: 11, backoffMs: 100 })).toThrow()
  })

  it("accepts backoffMs=0 for tight retry loops", () => {
    const r = retryPolicySchema.parse({ maxAttempts: 3, backoffMs: 0 })
    expect(r.backoffMs).toBe(0)
  })

  it("caps backoffMs at 60s (keeps node duration bounded)", () => {
    expect(() => retryPolicySchema.parse({ maxAttempts: 1, backoffMs: 60_001 })).toThrow()
  })
})

describe("workflowNodeSchema retry field", () => {
  it("defaults the retry block when not specified", () => {
    const n = workflowNodeSchema.parse({ id: "x", type: "transform", config: {} })
    expect(n.retry.maxAttempts).toBe(1)
  })

  it("accepts and round-trips a custom retry block", () => {
    const n = workflowNodeSchema.parse({
      id: "x", type: "action.builtin", config: {},
      retry: { maxAttempts: 3, backoffMs: 500 },
    })
    expect(n.retry.maxAttempts).toBe(3)
    expect(n.retry.backoffMs).toBe(500)
  })
})

describe("workflow with retry survives full schema parse", () => {
  it("parses a workflow whose nodes have retry configured", () => {
    const wf = workflowSchema.parse({
      id: "retry-wf", version: 2, title: "x", priority: 0, fanOut: false,
      nodes: [
        { id: "trigger", type: "trigger.manual", config: {} },
        {
          id: "fetch", type: "action.builtin",
          config: { name: "http.fetch", input: { url: "https://example.test/" } },
          retry: { maxAttempts: 5, backoffMs: 250 },
        },
        { id: "done", type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "fetch" },
        { from: "fetch", to: "done" },
      ],
    })
    const fetchNode = wf.nodes.find((n) => n.id === "fetch")!
    expect(fetchNode.retry.maxAttempts).toBe(5)
    expect(fetchNode.retry.backoffMs).toBe(250)
  })
})

// --- Retry-loop unit test: simulate the dispatcher's retry behaviour
// with a counting fake handler. We don't need the full dispatcher to
// exercise the loop semantics — just the same code shape.

async function runWithRetry(
  handler: () => Promise<{ error?: string; paused?: boolean; output?: any }>,
  retry: { maxAttempts: number; backoffMs: number },
  log: (msg: string) => void = () => {},
): Promise<{ result: any; attempts: number }> {
  let result: any = { error: "init" }
  let attempt = 0
  while (attempt < retry.maxAttempts) {
    attempt++
    try {
      result = await handler()
    } catch (e: any) {
      result = { error: e.message }
    }
    if (!result.error || result.paused) break
    if (attempt < retry.maxAttempts) {
      const wait = retry.backoffMs * Math.pow(2, attempt - 1)
      log(`retry (attempt ${attempt}/${retry.maxAttempts}) in ${wait}ms`)
      // No real sleep in test — keep deterministic.
    }
  }
  return { result, attempts: attempt }
}

describe("retry loop semantics", () => {
  it("succeeds on first attempt → no retry", async () => {
    const h = async () => ({ output: "ok" })
    const { result, attempts } = await runWithRetry(h, { maxAttempts: 3, backoffMs: 0 })
    expect(result.output).toBe("ok")
    expect(attempts).toBe(1)
  })

  it("retries on hard error and succeeds before exhausting attempts", async () => {
    let n = 0
    const h = async () => {
      n++
      if (n < 3) return { error: `transient-${n}` }
      return { output: "finally-ok" }
    }
    const { result, attempts } = await runWithRetry(h, { maxAttempts: 5, backoffMs: 0 })
    expect(result.output).toBe("finally-ok")
    expect(attempts).toBe(3)
  })

  it("returns the LAST error after exhausting attempts", async () => {
    let n = 0
    const h = async () => { n++; return { error: `fail-${n}` } }
    const { result, attempts } = await runWithRetry(h, { maxAttempts: 3, backoffMs: 0 })
    expect(result.error).toBe("fail-3")
    expect(attempts).toBe(3)
  })

  it("does NOT retry on a paused result (pause is a normal lifecycle, not a failure)", async () => {
    let n = 0
    const h = async () => {
      n++
      return { paused: true, error: undefined } as any
    }
    const { result, attempts } = await runWithRetry(h, { maxAttempts: 5, backoffMs: 0 })
    expect(result.paused).toBe(true)
    expect(attempts).toBe(1)
  })

  it("default policy (maxAttempts=1) means no retry on errors", async () => {
    let n = 0
    const h = async () => { n++; return { error: "first" } }
    const { result, attempts } = await runWithRetry(h, { maxAttempts: 1, backoffMs: 0 })
    expect(result.error).toBe("first")
    expect(attempts).toBe(1)
  })

  it("converts thrown exceptions to {error} and retries them", async () => {
    let n = 0
    const h = async () => {
      n++
      if (n < 2) throw new Error("boom")
      return { output: "recovered" }
    }
    const { result, attempts } = await runWithRetry(h, { maxAttempts: 3, backoffMs: 0 })
    expect(result.output).toBe("recovered")
    expect(attempts).toBe(2)
  })
})
