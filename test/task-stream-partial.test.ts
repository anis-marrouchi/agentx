import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2101 R16, #2163 review B1: with --include-partial-messages the persistent
// claude-code process writes the answer a few words at a time as
// stream_event lines, then the whole message. The Task page must show the
// words as they come, write the answer once, and the run's reply (what
// Telegram, GitLab, a2a and schedules send) must stay whole and single.

const gate = vi.hoisted(() => ({ release: () => {}, started: false }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  const se = (event: unknown, parent: string | null = null) => ({ type: "stream_event", event, parent_tool_use_id: parent })
  const start = se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  const text = (t: string) => se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })
  return {
    ...real,
    executeTask: async (_def: any, _task: any, _providers: any, onDelta: any, _history: any, _resume: any, onEvent: any) => {
      expect(onDelta).toBeUndefined()
      onEvent?.({ type: "system", subtype: "init", model: "m", session_id: "abcdefgh123" })
      onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", thinking: "plan" }] } })
      onEvent?.(se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret plan" } }))
      onEvent?.(start); onEvent?.(text("Let me read")); onEvent?.(text(" the file."))
      onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "Let me read the file." }] } })
      onEvent?.(se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"zzpartial" } }))
      onEvent?.({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] } })
      onEvent?.({ type: "user", message: { content: [{ type: "tool_result", content: "export const a = 1" }] } })
      onEvent?.(start); onEvent?.(text("The answer"))
      gate.started = true
      await new Promise<void>((r) => { gate.release = r })
      onEvent?.(text(" is `a = 1`."))
      onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "The answer is `a = 1`." }] } })
      onEvent?.({ type: "result", duration_ms: 2000 })
      return { content: "The answer is `a = 1`.", duration: 2 }
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"

let tmp: string
const home = process.cwd()
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "agentx-task-partial-")); process.chdir(tmp) })
afterAll(() => { gate.release(); process.chdir(home); rmSync(tmp, { recursive: true, force: true }) })

describe("partial answer text streams to the Task page (#2163 B1)", () => {
  it("shows the answer growing before the run ends, writes it once, and keeps the reply whole", async () => {
    const config = daemonConfigSchema.parse({
      jobState: { enabled: false },
      node: { id: "n", name: "n" },
      agents: { helper: { name: "Helper", tier: "claude-code", workspace: tmp } },
    })
    const registry = new AgentRegistry(config, () => {})
    const run = registry.execute({ agentId: "helper", message: "what is a?", context: { channel: "telegram", chatId: "1" } } as any)

    await vi.waitFor(() => expect(gate.started).toBe(true))
    const taskId = registry.list().find((a) => a.id === "helper")!.runningTasks[0].id
    const chunks: string[] = []
    const sub = registry.subscribeToTaskOutput(taskId, (c) => chunks.push(c))!
    // Part-way: the first message, the tool step and the start of the answer.
    expect(sub.initial).toContain("Let me read the file.")
    expect(sub.initial).toContain('\n→ Read({"file_path":"src/a.ts"})\n')
    expect(sub.initial.endsWith("← export const a = 1\nThe answer")).toBe(true)
    // Thinking and tool-input deltas never reach the stream.
    expect(sub.initial).not.toContain("secret plan")
    expect(sub.initial).not.toContain("zzpartial")

    gate.release()
    const res = await run
    const all = sub.initial + chunks.join("")
    expect(chunks.join("")).toContain(" is `a = 1`.")
    // Each text is written once, though both its words and its whole message came.
    expect(all.split("Let me read the file.").length).toBe(2)
    expect(all.split("The answer is `a = 1`.").length).toBe(2)
    // The channel reply is the whole answer, once.
    expect(res.content).toBe("The answer is `a = 1`.")
    sub.unsubscribe()
  })
})
