import { describe, expect, it, vi } from "vitest"

// #2130 (#2112 review F6): the sdk and orchestrator tiers read
// task.systemPromptAppend like the CLI tiers, so their agents get the PR/MR
// marker too.

const seen = vi.hoisted(() => ({ generate: [] as any[], sdk: [] as any[] }))
vi.mock("../src/agent/index", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    generate: async (opts: any) => {
      seen.generate.push(opts)
      return { files: { written: [], skipped: [] }, content: "done", outputType: "text" }
    },
  }
})
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: any) => {
    seen.sdk.push(args)
    return (async function* () { yield { type: "result", subtype: "success", result: "done" } })()
  },
}))

import { executeOrchestrator, executeSdk, type AgentTask } from "../src/agents/runtime"
import { withSystemPromptAppend } from "../src/agent/index"
import type { AgentDef } from "../src/daemon/config"

const agent = { name: "Coder", workspace: "/tmp", tier: "orchestrator", maxExecutionMinutes: 1 } as unknown as AgentDef
const task: AgentTask = { agentId: "coder", message: "fix it", systemPromptAppend: "End with `<!-- agentx:coder -->`." }

describe("systemPromptAppend on the sdk and orchestrator tiers (#2130)", () => {
  it("passes it to the orchestrator's generate()", async () => {
    const r = await executeOrchestrator(agent, task)
    expect(r.error).toBeUndefined()
    expect(seen.generate.at(-1).systemPromptAppend).toBe(task.systemPromptAppend)
  })

  it("adds it to the end of the orchestrator's system prompt", () => {
    expect(withSystemPromptAppend("base", "  marker  ")).toBe("base\n\nmarker")
    expect(withSystemPromptAppend("base", undefined)).toBe("base")
    expect(withSystemPromptAppend("base", "  ")).toBe("base")
  })

  it("puts it in the sdk tier's prompt", async () => {
    const r = await executeSdk({ ...agent, tier: "sdk" } as AgentDef, task, "key")
    expect(r.error).toBeUndefined()
    const prompt: string = seen.sdk.at(-1).prompt
    expect(prompt.startsWith("[System]\nEnd with `<!-- agentx:coder -->`.")).toBe(true)
    expect(prompt).toContain("fix it")
  })
})
