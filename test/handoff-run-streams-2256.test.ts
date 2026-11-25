import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2256: a hand-off run (runLocal / injectTurn) passes a no-op onDelta, so
// its words reach the Task page's live output while it works, and the
// output can still be read right after it ends (TASK_OUTPUT_TTL_MS).
// Real AgentRegistry; only the model process is faked.

const gate = vi.hoisted(() => ({ release: () => {}, started: false }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    // Stream mode (an onDelta was given): the runtime sends events as they
    // happen; the registry writes them to the Task page's output.
    executeTask: async (_def: any, _task: any, _providers: any, onDelta: any, _history: any, _resume: any, onEvent: any) => {
      expect(typeof onDelta).toBe("function")
      onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the PR first." }] } })
      gate.started = true
      await new Promise<void>((r) => { gate.release = r })
      onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "Opened it." }] } })
      onEvent?.({ type: "result", duration_ms: 1000 })
      return { content: "Opened it.", duration: 1 }
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"

let tmp: string
const home = process.cwd()
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "agentx-2256-")); process.chdir(tmp) })
afterAll(() => { gate.release(); process.chdir(home); rmSync(tmp, { recursive: true, force: true }) })

describe("a hand-off run streams to its Task page (#2256)", () => {
  it("shows words before the run ends and stays readable right after it ends", async () => {
    const config = daemonConfigSchema.parse({
      jobState: { enabled: false },
      node: { id: "n", name: "n" },
      agents: { worker: { name: "Worker", tier: "claude-code", workspace: tmp } },
    })
    const registry = new AgentRegistry(config, () => {})
    let taskId = ""
    const run = registry.execute({
      agentId: "worker",
      message: "open the PR",
      context: { channel: "a2a", chatId: "a2a:front:worker:dlg-1" },
      onStart: (id: string) => { taskId = id },
    } as any, () => {})

    await vi.waitFor(() => expect(gate.started).toBe(true))
    if (!taskId) taskId = registry.list().find((a) => a.id === "worker")!.runningTasks[0].id
    const live = registry.subscribeToTaskOutput(taskId, () => {})
    expect(live).not.toBeNull()
    expect(live!.done).toBe(false)
    expect(live!.initial).toContain("Looking at the PR first.")
    live!.unsubscribe()

    gate.release()
    await run
    const after = registry.subscribeToTaskOutput(taskId, () => {})
    expect(after).not.toBeNull()
    expect(after!.done).toBe(true)
    expect(after!.initial).toContain("Opened it.")
    after!.unsubscribe()
  })
})
