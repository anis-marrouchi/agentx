import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2101 R16: a run's Task page streams while the run works, whoever started
// it. The Task page reads the run's live output (GET /api/task/stream relays
// registry.subscribeToTaskOutput). A run started without a caller onDelta
// (Telegram, a2a, GitLab, a schedule) used to fill that output only at the
// end, with the whole reply in one piece, though the persistent claude-code
// process sends its events (text, tool calls, results) as they happen.
//
// Real AgentRegistry; only the model process is faked, sending events the
// way the persistent process does: whole assistant messages, a tool call,
// its result, then a second, shorter message.

const gate = vi.hoisted(() => ({ release: () => {}, started: false }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: async (_def: any, _task: any, _providers: any, onDelta: any, _history: any, _resume: any, onEvent: any) => {
      expect(onDelta).toBeUndefined()
      onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "Let me read the file first." }] } })
      onEvent?.({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] } })
      onEvent?.({ type: "user", message: { content: [{ type: "tool_result", content: "export const a = 1" }] } })
      gate.started = true
      await new Promise<void>((r) => { gate.release = r })
      onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "Done: `a` is 1." }] } })
      onEvent?.({ type: "result", duration_ms: 2000 })
      return { content: "Done: `a` is 1.", duration: 2 }
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"

let tmp: string
const home = process.cwd()
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "agentx-task-stream-")); process.chdir(tmp) })
afterAll(() => { gate.release(); process.chdir(home); rmSync(tmp, { recursive: true, force: true }) })

describe("a run with no caller onDelta streams to its Task page (#2101 R16)", () => {
  it("puts text, the tool call and its result on the live output before the run ends, and the reply once", async () => {
    const config = daemonConfigSchema.parse({
      jobState: { enabled: false },
      node: { id: "n", name: "n" },
      agents: { helper: { name: "Helper", tier: "claude-code", workspace: tmp } },
    })
    const registry = new AgentRegistry(config, () => {})
    const run = registry.execute({ agentId: "helper", message: "what is a?", context: { channel: "a2a", chatId: "a2a:x:helper:dlg-1" } } as any)

    await vi.waitFor(() => expect(gate.started).toBe(true))
    const taskId = registry.list().find((a) => a.id === "helper")!.runningTasks[0].id
    const chunks: string[] = []
    const sub = registry.subscribeToTaskOutput(taskId, (c) => chunks.push(c))
    expect(sub).not.toBeNull()
    expect(sub!.done).toBe(false)
    expect(sub!.initial).toContain("Let me read the file first.")
    expect(sub!.initial).toContain('\n→ Read({"file_path":"src/a.ts"})\n')
    expect(sub!.initial).toContain("← export const a = 1\n")
    expect(sub!.initial).not.toContain("Done:")

    gate.release()
    const res = await run
    expect(res.content).toBe("Done: `a` is 1.")
    const all = sub!.initial + chunks.join("")
    // The second message is shorter than the first: it is still written, whole.
    expect(all).toContain("\nDone: `a` is 1.")
    // What streamed stays; the reply is not posted a second time at the end.
    expect(all.split("Done: `a` is 1.").length).toBe(2)
    expect(all).toContain("Let me read the file first.")
    sub!.unsubscribe()
  })
})
