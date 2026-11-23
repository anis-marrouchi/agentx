import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2137 review B1, end to end on the node: an agent that is not on the
// claude-code tier sends its reasoning token by token. What the node puts on
// the task's live output, read by the phone's trimmer, must hold none of it.

const hub = vi.hoisted(() => ({ chunks: [] as string[], registry: null as any, sub: null as any }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: async (_def: any, task: any, _p: any, onDelta: any, _h: any, _r: any, _e: any, _s: any, onThinking: any) => {
      const id = hub.registry.list().flatMap((a: any) => a.runningTasks)[0]?.id ?? task.taskId
      hub.sub = hub.registry.subscribeToTaskOutput(id, (c: string) => hub.chunks.push(c))
      onThinking?.("The user's")
      onThinking?.(" password is hunter2.\n")
      onThinking?.("Second line: hunter2 again")
      onDelta?.("Here is the answer.", "Here is the answer.")
      return { content: "Here is the answer.", duration: 1 }
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { PhoneStreamTrimmer } from "../src/daemon/app-task-stream"

let tmp: string
const home = process.cwd()
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "agentx-live-thinking-")); process.chdir(tmp) })
afterAll(() => { process.chdir(home); rmSync(tmp, { recursive: true, force: true }) })

describe("thinking from a runtime that is not claude-code (#2137 B1)", () => {
  it("never reaches the phone, and the answer does", async () => {
    const config = daemonConfigSchema.parse({
      jobState: { enabled: false },
      node: { id: "n", name: "n" },
      agents: { helper: { name: "Helper", tier: "opencode", workspace: tmp } },
    })
    const registry = new AgentRegistry(config, () => {})
    hub.registry = registry
    hub.chunks = []
    await registry.execute({ agentId: "helper", message: "hello", context: { channel: "web-chat" } } as any, () => {}, () => {})
    expect(hub.sub).not.toBeNull()
    expect(hub.chunks.join("")).toContain("hunter2")
    const t = new PhoneStreamTrimmer()
    const events = hub.chunks.flatMap((c) => t.feed(c))
    expect(JSON.stringify(events)).not.toContain("hunter2")
    expect(t.final()).toBe("Here is the answer.")
    // Each line of the thought starts with 💭 on the node, for the line-based readers too.
    for (const line of hub.chunks.join("").split("\n")) if (line.includes("hunter2")) expect(line.startsWith("💭 ")).toBe(true)
  })
})
