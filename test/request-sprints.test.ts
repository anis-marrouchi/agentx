import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { SprintStore } from "../src/requests/sprint-store"
import {
  DEFAULT_SPRINT_SETTINGS, cancelSprint, itemEnded, laneAction, laneChatId, parseLaneChat, parseSprint, runSprintSweep,
  type SprintSweepDeps,
} from "../src/requests/sprints"
import { handleSprintsApi, type SprintsApiDeps } from "../src/requests/sprint-api"
import { runSprintTool } from "../src/requests/sprint-tool"
import { requestsConfigSchema } from "../src/daemon/config"

const MIN = 60_000
const AGENTS = new Set(["lead", "coder", "reviewer"])
const hasAgent = (id: string) => AGENTS.has(id)

let tmp: string
let db: Database.Database
let store: SprintStore
let clock: number
let turns: Array<{ agentId: string; text: string; ref: { sprintId: string; lane: string; idx: number } }>
let notices: Array<{ title: string; message: string; key: string }>
let busy: boolean

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-sprints-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new SprintStore(db)
  clock = 1_000_000_000
  turns = []
  notices = []
  busy = false
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function deps(over: Partial<SprintSweepDeps> = {}): SprintSweepDeps {
  return {
    store,
    settings: { ...DEFAULT_SPRINT_SETTINGS },
    dispatch: async (agentId, text, ref) => { turns.push({ agentId, text, ref }) },
    isBusy: () => busy,
    hasAgent,
    notify: async (title, message, _s, key) => { notices.push({ title, message, key }) },
    log: () => {},
    now: clock,
    ...over,
  }
}

const sweep = (over: Partial<SprintSweepDeps> = {}) => runSprintSweep(deps({ now: clock, ...over }))

function makeSprint(lanes: unknown = [
  { name: "A", agent: "coder", items: ["#11", "#12"] },
  { name: "B", agent: "reviewer", items: [{ ref: "#21", title: "Review the parser" }, { ref: "#22", held: "waits on the design call" }, "#23"] },
]): string {
  const parsed = parseSprint({ title: "Sprint 12", ref: "https://example.com/issues/10", lanes }, hasAgent)
  if (typeof parsed === "string") throw new Error(parsed)
  store.create({ id: "spr-0000aaaa", createdBy: "lead", ...parsed }, clock)
  return "spr-0000aaaa"
}

describe("parseSprint", () => {
  it("reads lanes, items given as refs or objects, and held items", () => {
    const p = parseSprint({ title: "S", lanes: [{ agent: "coder", items: ["#1", { ref: "#2", brief: "Draft PR only.", held: true }] }] }, hasAgent)
    expect(typeof p).toBe("object")
    if (typeof p === "string") return
    expect(p.lanes[0].lane).toBe("A")
    expect(p.lanes[0].items[1]).toMatchObject({ ref: "#2", brief: "Draft PR only.", held: "held when the sprint was made" })
  })

  it("refuses what it cannot follow", () => {
    expect(parseSprint({ lanes: [] }, hasAgent)).toMatch(/title/)
    expect(parseSprint({ title: "S" }, hasAgent)).toMatch(/lanes/)
    expect(parseSprint({ title: "S", lanes: [{ name: "A", agent: "ghost", items: ["#1"] }] }, hasAgent)).toMatch(/not on this node/)
    expect(parseSprint({ title: "S", lanes: [{ name: "A", agent: "coder", items: [] }] }, hasAgent)).toMatch(/needs items/)
    expect(parseSprint({ title: "S", lanes: [{ name: "A", agent: "coder", items: ["#1"] }, { name: "A", agent: "coder", items: ["#2"] }] }, hasAgent)).toMatch(/twice/)
    expect(parseSprint({ title: "S", lanes: [{ name: "a b", agent: "coder", items: ["#1"] }] }, hasAgent)).toMatch(/short word/)
  })
})

describe("lane chats", () => {
  it("round-trips the sprint and lane", () => {
    expect(parseLaneChat(laneChatId("spr-0000aaaa", "review"))).toEqual({ sprintId: "spr-0000aaaa", lane: "review" })
    expect(parseLaneChat("req-1")).toBeNull()
  })
})

describe("the sprint check", () => {
  it("hands every lane its first item, in its own chat, and nothing more while it runs", async () => {
    const id = makeSprint()
    const r = await sweep()
    expect(r.dispatched).toBe(2)
    expect(turns.map((t) => [t.agentId, t.ref.lane, t.ref.idx])).toEqual([["coder", "A", 1], ["reviewer", "B", 1]])
    expect(turns[0].text).toContain("Work on #11 now")
    expect(turns[0].text).toContain("https://example.com/issues/10")
    expect(turns[0].text).toContain("agentx_sprint")
    expect(store.item(id, "A", 1)?.state).toBe("running")
    clock += MIN
    expect((await sweep()).dispatched).toBe(0)
  })

  it("gives a lane its next item when its turn ends: the issue's bug", async () => {
    const id = makeSprint()
    await sweep()
    clock += 20 * MIN
    expect(itemEnded(store, { sprintId: id, lane: "A", idx: 1 }, {}, clock)).toBe("done")
    await sweep()
    expect(turns.at(-1)).toMatchObject({ agentId: "coder", ref: { lane: "A", idx: 2 } })
    expect(turns.at(-1)!.text).toContain("this is the last one")
  })

  it("passes over a held item with a note, and comes back to it once released", async () => {
    const id = makeSprint()
    await sweep()
    itemEnded(store, { sprintId: id, lane: "B", idx: 1 }, {}, clock)
    await sweep()
    expect(turns.at(-1)!.ref).toMatchObject({ lane: "B", idx: 3 })
    expect(store.events(id).some((e) => e.kind === "passed-held" && /design call/.test(e.detail))).toBe(true)
    itemEnded(store, { sprintId: id, lane: "B", idx: 3 }, {}, clock)
    await sweep()
    // Only the held item is left: the lane waits, and is not done.
    expect(store.lane(id, "B")?.state).toBe("active")
    expect(laneAction(store, { sprintId: id, lane: "B", action: "release", by: "owner" }, clock)).toBeNull()
    await sweep()
    expect(turns.at(-1)!.ref).toMatchObject({ lane: "B", idx: 2 })
  })

  it("blocks a lane whose turn failed, tells the owner once, and goes on after a retry", async () => {
    const id = makeSprint()
    await sweep()
    expect(itemEnded(store, { sprintId: id, lane: "A", idx: 1 }, { error: "rate limited" }, clock)).toBe("blocked")
    await sweep()
    await sweep()
    expect(notices).toHaveLength(1)
    expect(notices[0].title).toContain("lane A blocked")
    expect(notices[0].message).toContain("rate limited")
    expect(notices[0].message).toContain("--retry A")
    expect(turns.filter((t) => t.ref.lane === "A")).toHaveLength(1)
    expect(laneAction(store, { sprintId: id, lane: "A", action: "retry", by: "owner" }, clock)).toBeNull()
    await sweep()
    expect(turns.at(-1)!.ref).toMatchObject({ lane: "A", idx: 1 })
  })

  it("leaves an item cut by a shutdown running, and tells the owner when it stays idle", async () => {
    const id = makeSprint()
    await sweep()
    expect(itemEnded(store, { sprintId: id, lane: "A", idx: 1 }, { interrupted: true }, clock)).toBeNull()
    expect(store.item(id, "A", 1)?.state).toBe("running")
    clock += 31 * MIN
    busy = true
    await sweep()
    expect(notices).toHaveLength(0)
    busy = false
    await sweep()
    await sweep()
    const idle = notices.filter((n) => n.title.includes("lane A idle"))
    expect(idle).toHaveLength(1)
    expect(idle[0].message).toContain("never recorded")
  })

  it("uses the sprint's own idle time", async () => {
    const parsed = parseSprint({ title: "Quick", idleMinutes: 5, lanes: [{ agent: "coder", items: ["#1"] }] }, hasAgent) as any
    store.create({ id: "spr-0000bbbb", createdBy: "lead", ...parsed }, clock)
    await sweep()
    clock += 6 * MIN
    await sweep()
    expect(notices.some((n) => n.title.includes("idle"))).toBe(true)
  })

  it("finishes the sprint when every lane is done, with one summary", async () => {
    const parsed = parseSprint({ title: "Small", lanes: [{ agent: "coder", items: ["#1"] }, { agent: "reviewer", items: ["#2"] }] }, hasAgent) as any
    store.create({ id: "spr-0000cccc", createdBy: "lead", ...parsed }, clock)
    await sweep()
    itemEnded(store, { sprintId: "spr-0000cccc", lane: "A", idx: 1 }, {}, clock)
    itemEnded(store, { sprintId: "spr-0000cccc", lane: "B", idx: 1 }, {}, clock)
    const r = await sweep()
    expect(r.finished).toBe(1)
    expect(store.get("spr-0000cccc")?.state).toBe("done")
    await sweep()
    const summaries = notices.filter((n) => n.title.startsWith("Sprint finished"))
    expect(summaries).toHaveLength(1)
    expect(summaries[0].message).toContain("2 of 2 items done")
  })

  it("blocks a lane whose turn could not even be asked for", async () => {
    const id = makeSprint()
    await sweep({ dispatch: async () => { throw new Error("no runtime") } })
    expect(store.lane(id, "A")?.state).toBe("blocked")
    expect(store.item(id, "A", 1)).toMatchObject({ state: "failed" })
    expect(store.item(id, "A", 1)?.note).toContain("no runtime")
  })

  it("hands nothing out once cancelled, and nothing while turned off", async () => {
    const id = makeSprint()
    expect((await sweep({ settings: { ...DEFAULT_SPRINT_SETTINGS, enabled: false } })).dispatched).toBe(0)
    expect(cancelSprint(store, id, "owner", clock)).toBeNull()
    expect((await sweep()).dispatched).toBe(0)
    expect(cancelSprint(store, id, "owner", clock)).toMatch(/already cancelled/)
  })
})

describe("laneAction", () => {
  it("skips, holds and blocks", () => {
    const id = makeSprint()
    expect(laneAction(store, { sprintId: id, lane: "A", action: "hold", item: 2, note: "later", by: "lead" }, clock)).toBeNull()
    expect(store.item(id, "A", 2)?.state).toBe("held")
    expect(laneAction(store, { sprintId: id, lane: "A", action: "skip", item: 1, by: "lead" }, clock)).toBeNull()
    expect(store.item(id, "A", 1)?.state).toBe("skipped")
    expect(laneAction(store, { sprintId: id, lane: "A", action: "block", by: "coder" }, clock)).toMatch(/needs note/)
    expect(laneAction(store, { sprintId: id, lane: "A", action: "block", note: "repo is frozen", by: "coder" }, clock)).toBeNull()
    expect(store.lane(id, "A")).toMatchObject({ state: "blocked", note: "coder: repo is frozen" })
    expect(laneAction(store, { sprintId: id, lane: "Z", action: "skip", by: "lead" }, clock)).toMatch(/no lane/)
  })
})

describe("/sprints", () => {
  const api = (method: string, p: string, body?: Record<string, unknown>, over: Partial<SprintsApiDeps> = {}) =>
    handleSprintsApi(method, p, body, {
      store, settings: { ...DEFAULT_SPRINT_SETTINGS }, hasAgent,
      runningTurn: (id) => (id === "ghost-turn" ? null : { channel: "telegram", chatId: "1" }),
      now: clock, ...over,
    })

  it("starts a sprint for a running turn and lists it", () => {
    let kicked = 0
    const r = api("POST", "/sprints", { action: "start", agentId: "lead", title: "S", lanes: [{ agent: "coder", items: ["#1"] }] }, { onChange: () => kicked++ })
    expect(r.status).toBe(200)
    const id = (r.body as any).sprint.id
    expect(id).toMatch(/^spr-[0-9a-f]{8}$/)
    expect(kicked).toBe(1)
    const list = api("GET", "/sprints")
    expect((list.body as any).items.map((v: any) => v.sprint.id)).toEqual([id])
    expect((api("GET", `/sprints/${id}`).body as any).events.length).toBeGreaterThan(0)
  })

  it("refuses a caller without a running turn, and others' lanes", () => {
    const id = makeSprint()
    expect(api("POST", "/sprints", { action: "start", agentId: "lead" }, { runningTurn: () => null }).status).toBe(403)
    expect(api("POST", "/sprints", { action: "retry", agentId: "coder", id, lane: "A" }).status).toBe(403)
    expect(api("POST", "/sprints", { action: "block", agentId: "coder", id, lane: "B", note: "x" }).status).toBe(403)
    expect(api("POST", "/sprints", { action: "block", agentId: "coder", id, lane: "A", note: "repo frozen" }).status).toBe(200)
    expect(api("POST", "/sprints", { action: "cancel", agentId: "coder", id }).status).toBe(403)
    expect(api("POST", "/sprints", { action: "cancel", agentId: "lead", id }).status).toBe(200)
    expect(api("POST", "/sprints", { action: "frobnicate", agentId: "lead" }).status).toBe(400)
  })
})

describe("agentx_sprint", () => {
  it("posts a start as the calling agent and describes the lanes", async () => {
    let sent: any = null
    const fetch = (async (_url: string, init: any) => {
      sent = JSON.parse(init.body)
      const parsed = parseSprint(sent, hasAgent) as any
      store.create({ id: "spr-0000dddd", createdBy: sent.agentId, ...parsed }, clock)
      return new Response(JSON.stringify({ sprint: store.get("spr-0000dddd"), lanes: store.lanes("spr-0000dddd"), items: store.items("spr-0000dddd") }))
    }) as any
    const text = await runSprintTool(
      { action: "start", title: "S", lanes: [{ name: "A", agent: "coder", items: ["#1"] }] },
      { daemonUrl: "http://127.0.0.1:1", fetch, env: { AGENTX_AGENT_ID: "lead" } },
    )
    expect(sent).toMatchObject({ action: "start", agentId: "lead" })
    expect(text).toContain("spr-0000dddd")
    expect(text).toContain("lane A (coder)")
  })
})

describe("settings", () => {
  it("defaults to on, 30 idle minutes", () => {
    expect(requestsConfigSchema.parse({}).sprints).toEqual({ enabled: true, idleMinutes: 30 })
  })
})
