import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The Desk shows a request as "Working now" when one of its run links is a
// live run (#959). Both ids come from the real path here: the run link from
// the tracker, on the turn's start event, and the live run from the agent
// list the dashboard reads. Names and texts are invented.

const run = vi.hoisted(() => ({ impl: (): Promise<any> => Promise.resolve({ content: "ok", duration: 1 }) }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, executeTask: () => run.impl() }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { attachRequests, type AttachedRequests } from "../src/requests/attach"
import { pickupContext, type RequestSettings } from "../src/requests/tracker"
import { buildDesk, liveRunRefs } from "../src/desk/board"

const settings: RequestSettings = { enabled: true, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 }
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
  requests.store.addCandidate({ id: "req-1", runId: "t1", channel: "voice", chatId: "studio", sender: null, agentId: "writer", text: "draft the newsletter", now: 1000 })
  requests.store.progress("req-1", 2000)
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

// What the dashboard gets from the daemon's agent list: JSON, parsed.
const agentList = () => JSON.parse(JSON.stringify(registry.list()))

function card() {
  const store = requests.store
  // Long past the quiet limit: only a live run keeps the request off "No news".
  const now = store.get("req-1")!.updatedAt + 30 * HOUR
  const board = buildDesk({
    now, node: "http://studio-mac:18800", nodeName: "studio-mac", inbox: [], cards: [],
    requests: store.listOpen().map((record) => ({ record, links: store.links(record.id) })),
    liveRuns: liveRunRefs(agentList()),
  })
  return board.cards.find((c) => c.key === "request:req-1")!
}

describe("a request whose run is live, through the registry", () => {
  it("is shown as working while the run lasts, and not after", async () => {
    let finish: (v: any) => void = () => {}
    let entered = false
    run.impl = () => new Promise((resolve) => { entered = true; finish = resolve })

    const done = registry.execute({ agentId: "writer", message: "pick it up again", context: pickupContext("req-1") })
    await until(() => entered)

    const [task] = agentList()[0].runningTasks
    const runRefs = requests.store.links("req-1").filter((l) => l.kind === "run").map((l) => l.ref)
    expect(runRefs).toContain(task.traceId)
    // The running task's own id is another id, and no link holds it.
    expect(runRefs).not.toContain(task.id)

    expect(card()).toMatchObject({ column: "agent", live: true, can: { reply: false } })

    finish({ content: "ok", duration: 1 })
    await done
    expect(card()).toMatchObject({ column: "quiet", can: { reply: true } })
    expect(card().live).toBeUndefined()
  }, 15_000)
})
