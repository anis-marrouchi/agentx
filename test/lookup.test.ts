import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { handleLookup, type LookupDeps } from "../src/daemon/lookup-api"
import { workKey, runView, bareRefNamesProject } from "../src/a2a/lookup"

const NOW = Date.parse("2026-11-08T10:00:00Z")
const H = 3_600_000
let db: Database.Database

beforeEach(() => {
  db = new Database(":memory:")
  db.exec(`CREATE TABLE task_traces (task_id TEXT, agent_id TEXT, channel TEXT, chat_id TEXT, status TEXT, started_at INTEGER,
    original_message TEXT, final_response TEXT, error TEXT)`)
  const ins = db.prepare("INSERT INTO task_traces VALUES (?,?,?,?,?,?,?,?,?)")
  ins.run("t1", "builder", "a2a", "a2a:planner:builder:dlg-1", "ok", NOW - 2 * H, "Rebase team/app!52 on main please", "Rebased team/app!52 on main, mergeable, tests green.", null)
  ins.run("t2", "builder", "telegram", "12345", "ok", NOW - 1 * H, "my bank pin is 1234, also look at team/app!52", "Done, I looked.", null)
  ins.run("t3", "builder", "a2a", "a2a:planner:builder:dlg-2", "error", NOW - 3 * H, "Deploy team/app!53", null, "deploy failed: guard stop")
  ins.run("t4", "builder", "a2a", "x", "ok", NOW - 240 * H, "old work team/app!52", "old answer", null)
  ins.run("t5", "ops", "workflow", "wf-1", "ok", NOW - 30 * 60_000, "[agentx:plan-step id=req-01M6TKA0XQ92ADP3408JTM88S6 step=1] build the box", "Box built.", null)
})
afterEach(() => db.close())

function deps(over: Partial<LookupDeps> = {}): LookupDeps {
  return {
    db,
    hasAgent: (id) => ["builder", "ops", "planner"].includes(id),
    running: (id) => (id === "builder" ? [{ channel: "a2a", chatId: "a2a:planner:builder:dlg-3", startedAt: new Date(NOW - 5 * 60_000), message: "Review team/app!58" }] : []),
    openRequests: () => [{ id: "req-01M6TKA0XQ92ADP3408JTM88S6", agentId: "ops", state: "in_progress", text: "build the posting box", headline: "Posting box", need: null, home: null, updatedAt: NOW - H }],
    closedRequests: () => [{ id: "req-01M6TKA0XQ92ADP3408JTM88S7", agentId: "builder", state: "done", text: "merge team/app!52", headline: "Merge !52", need: null, home: { kind: "mr", link: "https://git.example.com/team/app/-/merge_requests/52" }, updatedAt: NOW - H }],
    handOffs: () => [{ id: "dlg-3", caller: "planner", callee: "builder", status: "running", startedAt: "2026-11-08T09:55" }, { id: "dlg-1", caller: "planner", callee: "builder", status: "done", startedAt: "x" }],
    now: NOW,
    ...over,
  }
}

describe("agentx_lookup: a colleague", () => {
  it("shows what they are on, their requests, hand-offs and recent finished work, newest first", async () => {
    const a = await handleLookup(new URLSearchParams("agent=builder"), deps())
    expect(a.status).toBe(200)
    const text = String(a.body.text)
    expect(text).toContain("Review team/app!58")
    expect(text).toContain("dlg-3: planner -> builder")
    expect(text).not.toContain("dlg-1:")
    expect(text).toContain("Rebased team/app!52 on main, mergeable")
    expect(text).toContain("deploy failed: guard stop")
    expect(text).not.toContain("old answer")
    expect(text.indexOf("telegram")).toBeLessThan(text.indexOf("Rebased"))
  })

  it("never shows the words of a person's chat", async () => {
    const text = String((await handleLookup(new URLSearchParams("agent=builder"), deps())).body.text)
    expect(text).not.toContain("1234")
    expect(text).not.toContain("Done, I looked")
    expect(text).toContain("a person's chat (about team/app!52)")
  })

  it("asks the peer for an agent that is not here, and says so when no peer has it", async () => {
    const fwd = await handleLookup(new URLSearchParams("agent=remote"), deps({ forward: async () => ({ status: 200, body: { text: "from peer" } }) }))
    expect(fwd.body.text).toBe("from peer")
    expect((await handleLookup(new URLSearchParams("agent=remote"), deps({ forward: async () => null }))).status).toBe(404)
  })
})

describe("agentx_lookup: a piece of work", () => {
  it("finds every run and request about a merge request, by link or ref", async () => {
    for (const w of ["team/app!52", "https://git.example.com/team/app/-/merge_requests/52"]) {
      const text = String((await handleLookup(new URLSearchParams({ work: w }), deps())).body.text)
      expect(text).toContain("Work team/app!52")
      expect(text).toContain("Merge !52")
      expect(text).toContain("Rebased team/app!52")
      expect(text).not.toContain("Deploy team/app!53")
      expect(text).not.toContain("old answer")
      expect(text).not.toContain("1234")
    }
  })

  it("finds an owner's request by its id", async () => {
    const text = String((await handleLookup(new URLSearchParams("work=req-01M6TKA0XQ92ADP3408JTM88S6"), deps())).body.text)
    expect(text).toContain("Posting box")
    expect(text).toContain("Box built.")
  })

  it("refuses a bare number or prose, and asks for exactly one question", async () => {
    expect((await handleLookup(new URLSearchParams("work=#52"), deps())).status).toBe(400)
    expect((await handleLookup(new URLSearchParams("work=the login page"), deps())).status).toBe(400)
    expect((await handleLookup(new URLSearchParams(""), deps())).status).toBe(400)
    expect((await handleLookup(new URLSearchParams("agent=a&work=b"), deps())).status).toBe(400)
    expect(workKey("team/app#12")).toEqual({ kind: "home", key: "team/app#12" })
  })
})

describe("runView", () => {
  it("shows the asked text of a running work run, not of a person's", () => {
    const base = { agent_id: "b", chat_id: "c", status: "in-flight", started_at: NOW, final_response: null, error: null }
    expect(runView({ ...base, channel: "a2a", original_message: "Fix the build" }).asked).toBe("Fix the build")
    expect(runView({ ...base, channel: "app", original_message: "private" }).asked).toBeUndefined()
  })
})

describe("bare merge request refs", () => {
  it("count when the same text names the project, never alone or for issues", () => {
    expect(bareRefNamesProject("About the three open app MRs: 1) !51 2) !52", "team/app!52")).toBe(true)
    expect(bareRefNamesProject("rebased noqta/app and !52 is mergeable", "team/app!52")).toBe(true)
    expect(bareRefNamesProject("!52 is mergeable", "team/app!52")).toBe(false)
    expect(bareRefNamesProject("the app MR !520 is open", "team/app!52")).toBe(false)
    expect(bareRefNamesProject("webapp !52", "team/app!52")).toBe(false)
    expect(bareRefNamesProject("app #52", "team/app#52")).toBe(false)
  })
})
