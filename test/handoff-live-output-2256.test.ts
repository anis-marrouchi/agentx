import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2256: a hand-off run (runLocal, injectTurn) showed "Waiting for the first
// words…" on its Task page for the whole run. Without a caller onDelta, a
// claude-code agent that is not a persistent process runs `claude` in
// one-shot json mode, which sends no events; the run's live output got only
// the final answer, at the end. The hand-off now passes a no-op onDelta.
//
// Real AgentRegistry and real hand-off wiring; only the model process is
// faked, the way the spawn path behaves: events only in streaming mode.

const gate = vi.hoisted(() => ({ release: () => {}, started: false }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: async (_def: any, _task: any, _providers: any, onDelta: any, _history: any, _resume: any, onEvent: any) => {
      // One-shot json mode: no events until the answer.
      if (onDelta) {
        onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "Reading the issue first." }] } })
        onDelta("Reading the issue first.", "Reading the issue first.")
      }
      gate.started = true
      await new Promise<void>((r) => { gate.release = r })
      return { content: "PR opened.", duration: 1 }
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { CallbackReplies, createDelegations } from "../src/daemon/delegation-wiring"

let tmp: string
const home = process.cwd()
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "agentx-handoff-live-")); process.chdir(tmp) })
afterAll(() => { gate.release(); process.chdir(home); rmSync(tmp, { recursive: true, force: true }) })

describe("a hand-off run streams to its Task page (#2256)", () => {
  it("puts the callee's output on the live output before the run ends, and keeps it after", async () => {
    const config = daemonConfigSchema.parse({
      jobState: { enabled: false },
      node: { id: "n", name: "n" },
      agents: {
        lead: { name: "Lead", tier: "claude-code", workspace: tmp },
        worker: { name: "Worker", tier: "claude-code", workspace: tmp },
      },
    })
    const registry = new AgentRegistry(config, () => {})
    const mgr = createDelegations({
      config,
      registry,
      router: { getChannel: () => undefined, sendOutbound: async () => {} } as any,
      mesh: () => undefined,
      log: () => {},
      replies: new CallbackReplies(),
      baseDir: tmp,
    })
    try {
      mgr.start({ caller: { agentId: "lead", taskId: "run-lead", context: { channel: "a2a", chatId: "a2a:x:lead" } }, callee: "worker", message: "Fix it" })

      await vi.waitFor(() => expect(gate.started).toBe(true))
      const taskId = registry.list().find((a) => a.id === "worker")!.runningTasks[0].id
      const sub = registry.subscribeToTaskOutput(taskId, () => {})
      expect(sub).not.toBeNull()
      expect(sub!.done).toBe(false)
      expect(sub!.initial).toContain("Reading the issue first.")
      sub!.unsubscribe()

      gate.release()
      await vi.waitFor(() => expect(registry.list().find((a) => a.id === "worker")!.runningTasks).toHaveLength(0))
      // Right after the end, the Task page still finds the run's output.
      const after = registry.subscribeToTaskOutput(taskId, () => {})
      expect(after).not.toBeNull()
      expect(after!.done).toBe(true)
      expect(after!.initial).toContain("Reading the issue first.")
    } finally { mgr.stop() }
  })
})
