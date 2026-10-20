import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #1100: two runs of one agent on the same issue, in different chats,
// overwrote each other's work. The second one is told about the first.

const hang = vi.hoisted(() => ({ on: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args),
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { SAME_HOME_MARKER } from "../src/a2a/home"
import { daemonConfigSchema } from "../src/daemon/config"

describe("a run that starts on a home another run works on", () => {
  let dir: string
  const prevCwd = process.cwd()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-same-home-"))
    process.chdir(dir)
    hang.on = true
  })
  afterEach(async () => {
    hang.on = false
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  const config = () => daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { writer: { name: "Writer", tier: "claude-code", workspace: dir, maxConcurrent: 2 } },
  })

  async function start(r: AgentRegistry, message: string, context: Record<string, unknown>) {
    let onStart!: (id: string) => void
    const started = new Promise<string>((res) => { onStart = res })
    const run = r.execute({ message, agentId: "writer", context: context as any, onStart })
    return { id: await started, run }
  }

  async function stopAll(r: AgentRegistry, runs: Array<{ id: string; run: Promise<unknown> }>) {
    for (const x of runs) r.cancelRunningTask(x.id, "done")
    await Promise.all(runs.map((x) => x.run))
  }

  it("is told, by named home or by a ref in its message; other work is not", async () => {
    const r = new AgentRegistry(config(), () => {})
    const first = await start(r, "Build the page for team/site#7", { channel: "a2a", chatId: "a2a:lead:writer:dlg-1", sender: "agent:lead" })
    const second = await start(r, "Use hero A", { channel: "a2a", chatId: "a2a:lead:writer:dlg-2", sender: "agent:lead", home: "team/site#7" })
    const state = (r as any).agents.get("writer")
    const msg = state.runningTasks.find((t: any) => t.id === second.id).message as string
    expect(msg.startsWith(SAME_HOME_MARKER)).toBe(true)
    expect(msg).toContain("team/site#7")
    expect(msg).toContain("a2a:lead:writer:dlg-1")
    expect(msg.endsWith("Use hero A")).toBe(true)
    // The first was alone when it started.
    expect(state.runningTasks.find((t: any) => t.id === first.id).message).toBe("Build the page for team/site#7")
    await stopAll(r, [first, second])

    const third = await start(r, "Something else, team/site#8", { channel: "a2a", chatId: "c3", sender: "agent:lead" })
    const fourth = await start(r, "Other work", { channel: "a2a", chatId: "c4", sender: "agent:lead", home: "team/site#7" })
    expect(state.runningTasks.find((t: any) => t.id === fourth.id).message).toBe("Other work")
    await stopAll(r, [third, fourth])
  })
})
