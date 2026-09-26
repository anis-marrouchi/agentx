import { describe, expect, it, vi } from "vitest"
import { resolveHandler } from "../src/workflows/nodes/handlers"

// Workflow agent steps carry the same optional autonomy level as crons (#80).

const ctx = (config: Record<string, unknown>, execute: (req: any) => Promise<any>) => ({
  workflow: { id: "wf", envAllow: [] },
  run: { id: "run-1", context: {} },
  node: { id: "n1", type: "agent", config },
  channels: {},
  agents: { execute },
  log: () => {},
}) as never

describe("agent step autonomy", () => {
  const agentHandler = resolveHandler("agent")!

  it("passes the step's autonomy to the agent call and returns blocked actions", async () => {
    const execute = vi.fn(async () => ({
      content: "RESULT: ok",
      autonomyBlocks: [{ tool: "Bash", target: "gh pr merge 1", ruleId: "autonomy.propose.merge", reason: "merging" }],
    }))
    const r = await agentHandler(ctx({ agentId: "coder", prompt: "fix it", autonomy: "propose" }, execute))
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ agentId: "coder", autonomy: "propose" }))
    expect((r as any).output.autonomyBlocks[0].ruleId).toBe("autonomy.propose.merge")
  })

  it("omits autonomy when unset (act)", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }))
    await agentHandler(ctx({ agentId: "coder", prompt: "x" }, execute))
    expect((execute.mock.calls[0] as any[])[0].autonomy).toBeUndefined()
  })

  it("fails the step on an unknown level instead of running at full power", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }))
    const r = await agentHandler(ctx({ agentId: "coder", prompt: "x", autonomy: "readonly" }, execute))
    expect((r as any).error).toMatch(/invalid autonomy "readonly"/)
    expect(execute).not.toHaveBeenCalled()
  })
})
