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

function card(id = "req-1", liveRuns: ReadonlySet<string> = liveRunRefs(agentList())) {
  const store = requests.store
  // Long past the quiet limit: only a live run keeps the request off "No news".
  const now = store.get(id)!.updatedAt + 30 * HOUR
  const board = buildDesk({
    now, node: "http://studio-mac:18800", nodeName: "studio-mac", inbox: [], cards: [],
    requests: store.listOpen().map((record) => ({ record, links: store.links(record.id) })),
    liveRuns,
  })
  return board.cards.find((c) => c.key === `request:${id}`)!
}

// The live set built from the running tasks' own ids, as before #959.
const byRunId = () => new Set<string>(agentList().flatMap((a: any) => a.runningTasks.map((t: any) => t.id)))

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
    // Control: the same card, matched on the running tasks' own ids, lands under "No news".
    expect(card("req-1", byRunId())).toMatchObject({ column: "quiet", can: { reply: true } })

    finish({ content: "ok", duration: 1 })
    await done
    expect(card()).toMatchObject({ column: "quiet", can: { reply: true } })
    expect(card().live).toBeUndefined()
  }, 15_000)

  it("is shown as working when the owner's own turn opened it", async () => {
    let finish: (v: any) => void = () => {}
    let entered = false
    run.impl = () => new Promise((resolve) => { entered = true; finish = resolve })

    const done = registry.execute({
      agentId: "writer", message: "plan the spring newsletter",
      context: { channel: "telegram", chatId: "c1", sender: "Owner", senderId: "42" },
    })
    await until(() => entered)

    const [task] = agentList()[0].runningTasks
    const record = requests.store.byLink("run", task.traceId)
    expect(record).not.toBeNull()
    expect(requests.store.byLink("run", task.id)).toBeNull()
    // A captured turn is a candidate until work is under way; the Desk lists open requests only.
    requests.store.progress(record!.id, Date.now())

    expect(card(record!.id)).toMatchObject({ column: "agent", live: true, can: { reply: false } })
    expect(card(record!.id, byRunId())).toMatchObject({ column: "quiet", can: { reply: true } })

    finish({ content: "ok", duration: 1 })
    await done
  }, 15_000)
})
