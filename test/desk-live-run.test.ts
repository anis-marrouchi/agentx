import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The Desk shows "Working now" when a run linked to a request is live
// (#959). Both ids come from the real path here: the request's run link
// from the tracker on task:started, the live id from the registry's list
// of running tasks. Fixtures with the same invented string on both sides
// hid that the two never matched.

// The turn stays running until the test cancels it (the abort signal is
// executeTask's eighth argument).
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (...args: any[]) => new Promise((_, reject) => {
      const signal: AbortSignal | undefined = args[7]
      if (signal?.aborted) return reject(signal.reason)
      signal?.addEventListener("abort", () => reject(signal.reason))
    }),
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { attachRequests, type AttachedRequests } from "../src/requests/attach"
import type { RequestSettings } from "../src/requests/tracker"
import { buildDesk } from "../src/desk/board"

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:42"], staleAfterHours: 24, retentionDays: 90 }
const HOUR = 3_600_000

let dir: string
let db: Database.Database
let requests: AttachedRequests
let registry: AgentRegistry
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-desk-live-"))
  process.chdir(dir)
  getEventBus().removeAllListeners()
  db = new Database(join(dir, "requests.sqlite"))
  requests = attachRequests(db, () => settings, () => {})
  registry = new AgentRegistry(daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { writer: { name: "Writer", tier: "claude-code", workspace: dir } },
  }), () => {})
})
afterEach(() => {
  requests.detach()
  db.close()
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const until = async (ok: () => boolean, ms = 10_000) => {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("a live run on the Desk", () => {
  it("matches the request's run link to a running task of the registry", async () => {
    // The tracker links the request to the id task:started carries.
    let runLink = ""
    getEventBus().on("task:started", (p) => { if (p.agentId === "writer" && p.taskId) runLink = p.taskId })
    const turn = registry.execute({
      agentId: "writer", message: "draft the spring newsletter",
      context: { channel: "telegram", chatId: "c1", sender: "Owner", senderId: "42" },
    })
    const running = () => registry.list().find((a) => a.id === "writer")!.runningTasks
    await until(() => !!runLink && !!requests.store.byLink("run", runLink))

    const record = requests.store.byLink("run", runLink)!
    const task = running()[0]
    expect(task.traceId).toBe(runLink)
    // The registry's own run id is another id: matching on it shows nothing live.
    expect(task.id).not.toBe(runLink)

    // Older than the quiet limit, so only the live run can put it under "With agents".
    const now = Date.now() + 4 * HOUR
    requests.store.progress(record.id, Date.now())
    const desk = (liveRuns: Set<string>) => buildDesk({
      now, node: "local", nodeName: "test", inbox: [], cards: [], liveRuns,
      requests: requests.store.listOpen().map((r) => ({ record: r, links: requests.store.links(r.id) })),
    }).cards.find((c) => c.key === `request:${record.id}`)!

    const card = desk(new Set(running().flatMap((t) => (t.traceId ? [t.traceId] : []))))
    expect(card.column).toBe("agent")
    expect(card.live).toBe(true)
    expect(card.can.reply).toBe(false)

    const byRunId = desk(new Set(running().map((t) => t.id)))
    expect(byRunId.column).toBe("quiet")

    const ended = registry.whenRunEnds(task.id, 10_000)
    registry.cancelRunningTask(task.id, "test over")
    await turn
    await ended
  }, 20_000)
})
