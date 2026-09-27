import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A wake that arrives while an earlier wake of the same agent is still
// running must run as its own turn, under its own event's root. Queueing it
// would flush it from the first run (inside the first run's root) and, in
// collect mode, merge several wakes into one turn.

const gate = vi.hoisted(() => ({ release: () => {}, calls: [] as string[] }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: any, task: any) => {
      gate.calls.push(task.message)
      if (gate.calls.length === 1) return new Promise((res) => { gate.release = () => res({ content: "ok", duration: 1 }) })
      return Promise.resolve({ content: "ok", duration: 1 })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { withRoot } from "../src/events/envelope"

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-wake-root-"))
  process.chdir(dir)
  gate.calls.length = 0
  getEventBus().removeAllListeners()
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

describe("queued wake", () => {
  it("runs each wake as its own turn under its own root", async () => {
    const config = daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1, queueMode: "collect" } },
    })
    const r = new AgentRegistry(config, () => {})
    const started: string[] = []
    getEventBus().subscribe((e) => { if (e.type === "task:started" && e.agentId === "ops") started.push(e.rootId) })

    const wake = (root: string, text: string) => withRoot({ rootId: root, parentId: `ev-${root}` }, () =>
      r.execute({ message: text, agentId: "ops", context: { channel: "events", chatId: "events:ops" } }))

    const first = wake("R1", "wake one")
    await vi.waitFor(() => expect(gate.calls).toHaveLength(1))
    const second = wake("R2", "wake two")
    const third = wake("R3", "wake three")
    await new Promise((res) => setTimeout(res, 50))
    gate.release()
    const results = await Promise.all([first, second, third])

    expect(results.map((x) => x.error)).toEqual([undefined, undefined, undefined])
    expect(gate.calls).toHaveLength(3)
    for (const text of ["wake one", "wake two", "wake three"]) {
      expect(gate.calls.filter((m) => m.includes(text))).toHaveLength(1)
    }
    expect([...started].sort()).toEqual(["R1", "R2", "R3"])
  }, 15_000)
})
