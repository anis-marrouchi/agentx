import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const execute = vi.fn()
vi.mock("../src/agents/registry", () => ({
  AgentRegistry: class { execute = execute },
}))
vi.mock("../src/daemon/config", () => ({
  loadDaemonConfig: () => ({
    node: { bind: "127.0.0.1:18800" },
    agents: { bench: { name: "Bench", workspace: "/tmp", tier: "claude-code" } },
  }),
}))

import { exec } from "../src/commands/exec"

class Exit extends Error { constructor(public code: number) { super(`exit ${code}`) } }

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = ""
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { stdout += s; return true })
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw new Exit(code) }) as any)
  try {
    await exec.parseAsync(["node", "exec", ...args])
  } catch (e) {
    if (e instanceof Exit) return { code: e.code, stdout }
    throw e
  }
  throw new Error("exec did not exit")
}

describe("agentx exec", () => {
  beforeEach(() => execute.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it("runs the task through the registry and prints one JSON result", async () => {
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreateTokens: 20 }
    execute.mockResolvedValue({ content: "done", usage, numTurns: 3, billedModel: "m" })

    const { code, stdout } = await run(["fix the build", "-a", "bench", "-m", "m", "--json"])

    expect(code).toBe(0)
    const task = execute.mock.calls[0][0]
    expect(task).toMatchObject({ agentId: "bench", message: "fix the build", model: "m" })
    expect(task.context.chatId).toMatch(/^exec-/)
    const out = JSON.parse(stdout)
    expect(out).toMatchObject({ content: "done", usage, numTurns: 3, billedModel: "m" })
    expect(typeof out.durationMs).toBe("number")
  })

  it("exits 1 when the agent returns an error", async () => {
    execute.mockResolvedValue({ content: "", error: "timed out", errorKind: "timeout" })
    const { code, stdout } = await run(["x", "-a", "bench", "--json"])
    expect(code).toBe(1)
    expect(JSON.parse(stdout)).toMatchObject({ error: "timed out", errorKind: "timeout" })
  })

  it("refuses an unknown agent without dispatching", async () => {
    const { code } = await run(["x", "-a", "nope"])
    expect(code).toBe(1)
    expect(execute).not.toHaveBeenCalled()
  })
})
