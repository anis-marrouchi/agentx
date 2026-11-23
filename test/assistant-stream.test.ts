import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import Database from "better-sqlite3"

// #2101 R13: the Hub's chat panel streams an answer while it is written.
// The panel reads the run's live output (GET /api/task/stream, which relays
// registry.subscribeToTaskOutput). That output only fills while the run goes
// when the caller of registry.execute passes onDelta; POST /api/assistant
// passed none, so the panel got the whole answer in one piece at the end.
//
// Real daemon handler, real AgentRegistry, real AssistantStore; only the
// model process is faked. The fake does what the real claude-code runtime
// does: stream-json events (and onDelta) only when it is asked to stream.

const gate = vi.hoisted(() => ({ release: () => {}, streamed: [] as boolean[] }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: async (_def: any, _task: any, _providers: any, onDelta: any, _history: any, _resume: any, onEvent: any) => {
      gate.streamed.push(Boolean(onDelta))
      const say = (text: string) => onEvent?.({ type: "assistant", message: { content: [{ type: "text", text }] } })
      if (onDelta) { say("Part one, "); onDelta("Part one, ", "Part one, ") }
      await new Promise<void>((r) => { gate.release = r })
      if (onDelta) { say("Part one, part two."); onDelta("part two.", "Part one, part two.") }
      return { content: "Part one, part two.", duration: 1 }
    },
  }
})

import { AgentXDaemon } from "../src/daemon"
import { AgentRegistry } from "../src/agents/registry"
import { AssistantStore } from "../src/daemon/assistant-store"
import { daemonConfigSchema } from "../src/daemon/config"

let tmp: string
let db: Database.Database
let server: Server | undefined
const home = process.cwd()

beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "agentx-assistant-stream-")); process.chdir(tmp) })
beforeEach(() => { db = new Database(":memory:"); gate.streamed = [] })
afterEach(async () => {
  gate.release()
  if (server) { server.closeAllConnections?.(); await new Promise<void>((r) => server!.close(() => r())); server = undefined }
  db.close()
})
afterAll(() => { process.chdir(home); rmSync(tmp, { recursive: true, force: true }) })

async function serve() {
  const config = daemonConfigSchema.parse({
    jobState: { enabled: false },
    node: { id: "n", name: "n" },
    agents: { helper: { name: "Helper", tier: "claude-code", workspace: tmp } },
  })
  const registry = new AgentRegistry(config, () => {})
  const store = new AssistantStore(db)
  const daemon = Object.assign(Object.create(AgentXDaemon.prototype), { config, log: () => {}, _assistant: store, registry })
  server = createServer((req, res) => { void daemon.handleHttp(req, res) })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, registry, store }
}

describe("POST /api/assistant streams the answer to the Hub panel (#2101 R13)", () => {
  it("puts partial text on the run's live output before the run ends", async () => {
    const { base, registry, store } = await serve()
    const posted = await fetch(base + "/api/assistant", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "helper", message: "hello" }),
    })
    expect(posted.status).toBe(200)
    const { threadId } = await posted.json() as { threadId: string }

    // The run's id lands on the pending message, as the panel reads it.
    let taskId = ""
    await vi.waitFor(() => {
      taskId = store.messages(threadId).find((m: any) => m.role === "assistant" && m.taskId)?.taskId ?? ""
      expect(taskId).not.toBe("")
    })
    await vi.waitFor(() => expect(gate.streamed).toEqual([true]))

    // What /api/task/stream relays: the buffer so far, then each chunk.
    const chunks: string[] = []
    const sub = registry.subscribeToTaskOutput(taskId, (c) => chunks.push(c))
    expect(sub).not.toBeNull()
    expect(sub!.done).toBe(false)
    const before = sub!.initial + chunks.join("")
    expect(before).toContain("Part one, ")
    expect(before).not.toContain("part two.")
    expect(store.messages(threadId).find((m: any) => m.role === "assistant")?.status).toBe("pending")

    gate.release()
    await vi.waitFor(() => expect(store.messages(threadId).find((m: any) => m.role === "assistant")?.status).toBe("done"))
    expect(sub!.initial + chunks.join("")).toContain("part two.")
    // The thread still keeps the answer once, in full.
    expect(store.messages(threadId).find((m: any) => m.role === "assistant")?.content).toBe("Part one, part two.")
    sub!.unsubscribe()
  })
})
