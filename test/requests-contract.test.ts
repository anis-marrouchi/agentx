import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { ToldLedger } from "../src/notify/told"
import { isStatusPull, measureContract, outputsOf, parseSpan, type ContractOptions } from "../src/requests/contract"

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 9, 28, 0, 0)
const OPTS: ContractOptions = { since: T0, until: T0 + 8 * HOUR, deliverWithinMinutes: 10, rhythmHours: 2, pushAfterHours: 6 }

let db: Database.Database
let store: RequestStore
let told: ToldLedger

function trace(id: string, agent: string, channel: string, chat: string, start: number, end: number | null, extra: { person?: string; message?: string; response?: string } = {}) {
  db.prepare(
    `INSERT INTO task_traces (task_id, agent_id, channel, chat_id, person, status, started_at, finished_at, original_message, final_response)
     VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
  ).run(id, agent, channel, chat, extra.person ?? null, start, end, extra.message ?? null, extra.response ?? null)
}

beforeEach(() => {
  db = new Database(":memory:")
  db.exec(`CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel TEXT, chat_id TEXT, person TEXT, status TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER, message_preview TEXT, original_message TEXT, final_response TEXT)`)
  store = new RequestStore(db)
  told = new ToldLedger(db)
})

describe("what an answer delivered (#1509)", () => {
  it("tells links from local paths, and words from paths", () => {
    const o = outputsOf("Done: see https://example.com/pull/7. Files in checks/demo-2026-10-28/ and /srv/app/out.csv, and/or ~/notes/a.md")
    expect(o.links).toEqual(["https://example.com/pull/7"])
    expect(o.paths).toEqual(["checks/demo-2026-10-28/", "/srv/app/out.csv", "~/notes/a.md"])
    expect(outputsOf("yes and/or no, 1/2 done").paths).toEqual([])
    expect(outputsOf(null)).toEqual({ links: [], paths: [] })
  })

  it("catches the owner asking where things stand", () => {
    expect(isStatusPull("Is he right now working on something?")).toBe(true)
    expect(isStatusPull("what is the producer doing")).toBe(true)
    expect(isStatusPull("any update on the render?")).toBe(true)
    expect(isStatusPull("write me a poem")).toBe(false)
  })

  it("reads spans", () => {
    expect(parseSpan("7d")).toBe(7 * 24 * HOUR)
    expect(parseSpan("36h")).toBe(36 * HOUR)
    expect(parseSpan("90m")).toBe(90 * 60_000)
    expect(parseSpan("soon")).toBeNull()
    expect(parseSpan("0d")).toBeNull()
  })
})

describe("measureContract (#1509 step 0)", () => {
  beforeEach(() => {
    // The owner asks the front desk; it hands to the producer, which hands on to the director.
    trace("t-owner", "desk-agent", "voice", "v1", T0 + HOUR, T0 + HOUR + 60_000, { person: "owner", message: "make the launch video" })
    store.addCandidate({ id: "req-t-owner", runId: "t-owner", channel: "voice", chatId: "v1", agentId: "desk-agent", text: "make the launch video", now: T0 + HOUR })
    store.progress("req-t-owner", T0 + HOUR)
    store.link("req-t-owner", "delegation", "dlg-a", T0 + HOUR)
    // First hop: linked today.
    trace("t-p1", "producer-agent", "a2a", "a2a:desk-agent:producer-agent:dlg-a", T0 + HOUR + 30_000, T0 + 2 * HOUR,
      { response: "Checks are in checks/demo-2026-10-28/" })
    // Second hop, started during the producer's turn: linked to nothing today.
    trace("t-d1", "director-agent", "a2a", "a2a:producer-agent:director-agent:dlg-b", T0 + HOUR + 10 * 60_000, T0 + HOUR + 20 * 60_000,
      { response: "Render at https://example.com/render/1" })
    trace("t-d2", "director-agent", "a2a", "a2a:producer-agent:director-agent:dlg-b", T0 + 3 * HOUR, T0 + 3 * HOUR + 60_000)
    // A hop with no caller turn here: stays outside any chain.
    trace("t-x", "director-agent", "a2a", "a2a:other-agent:director-agent:dlg-c", T0 + 4 * HOUR, T0 + 4 * HOUR + 60_000)
    // The owner asks where it stands.
    trace("t-pull", "desk-agent", "voice", "v1", T0 + 7 * HOUR, T0 + 7 * HOUR + 30_000, { person: "owner", message: "Is he right now working on something?" })
    // The owner was told about the render, with a link, in time.
    told.add({ at: T0 + HOUR + 25 * 60_000, key: "k1", requestId: "req-t-owner", kind: "notice", channel: "push", chatId: "owner", from: "desk-agent",
      title: "Render ready", text: "https://example.com/render/1", outcome: "sent" })
  })

  it("counts first-hop links today and what inheriting would add", () => {
    const r = measureContract(db, OPTS)
    expect(r.turnsByChannel).toEqual({ voice: 2, a2a: 4 })
    expect(r.chain.turns).toEqual({ n: 1, of: 4 })
    expect(r.chain.chats).toEqual({ n: 1, of: 3 })
    expect(r.chain.inherited.turns).toEqual({ n: 3, of: 4 })
    expect(r.chain.inherited.chats).toEqual({ n: 2, of: 3 })
  })

  it("puts outputs on the root request and says which reached the owner", () => {
    const r = measureContract(db, { ...OPTS, sample: 10 })
    expect(r.delivery).toMatchObject({ outputs: 2, withPath: 1, pathOnly: 1, inChain: 2, reached: { n: 1, of: 2 } })
    expect(r.dryRun.outputs.map((o) => [o.agent, o.kind, o.reached])).toEqual([
      ["producer-agent", "path", false], ["director-agent", "link", true],
    ])
    expect(r.dryRun.hops).toEqual([{ chat: "a2a:producer-agent:director-agent:dlg-b", agent: "director-agent", requestId: "req-t-owner", via: "producer-agent" }])
  })

  it("writes a status line for a quiet request, and pushes only past the second threshold", () => {
    const r = measureContract(db, OPTS)
    expect(r.quiet).toEqual({ open: 1, breaches: 1, pushes: 1 })
    const q = r.dryRun.quiet[0]
    expect(q.requestId).toBe("req-t-owner")
    expect(q.line).toContain("last turn 07:00Z by desk-agent")
    expect(q.line).toContain("waiting on 1 hand-off(s) since 01:00Z")
    expect(q.line).toContain("last output checks/demo-2026-10-28/ at 02:00Z")
    expect(measureContract(db, { ...OPTS, pushAfterHours: 12 }).quiet.pushes).toBe(0)
    expect(measureContract(db, { ...OPTS, rhythmHours: 12 }).quiet.breaches).toBe(0)
  })

  it("counts status pulls, owner-told rows, and proof on close", () => {
    store.close("req-t-owner", "done", "/srv/out/video.mp4", T0 + 5 * HOUR)
    const r = measureContract(db, OPTS)
    expect(r.pulls).toMatchObject({ ownerTurns: 2, pulls: 1, byDay: { "2026-10-28": 1 } })
    expect(r.told).toMatchObject({ rows: 1, outcomes: { sent: 1 } })
    expect(r.proof).toMatchObject({ closedDone: 1, path: 1, link: 0, none: 0, toldAtClose: { n: 0, of: 1 } })
    expect(r.quiet.open).toBe(0)
    const producer = r.agents.find((a) => a.agent === "producer-agent")!
    expect(producer).toMatchObject({ a2aTurns: 1, linkedTurns: 1, chainTurns: 1, outputs: 1, pathOnlyOutputs: 1, told: 0 })
  })

  it("narrows to one agent, and reads a store with no requests", () => {
    expect(measureContract(db, { ...OPTS, agent: "director-agent" }).chain.turns).toEqual({ n: 0, of: 3 })
    const empty = new Database(":memory:")
    const r = measureContract(empty, OPTS)
    expect(r.chain.turns).toEqual({ n: 0, of: 0 })
    expect(r.quiet.open).toBe(0)
  })
})
