import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, pickupContext, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { PlanStore } from "../src/requests/plan-store"
import { describeGoals, describeOpen, runRequestTool } from "../src/requests/tool"
import { goalIdOf, parseGoal } from "../src/requests/goals"
import { pickupText } from "../src/requests/sweep"
import { dispatchText } from "../src/requests/plans"

// An optional goal on requests, with progress and cost (#1168).

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let store: RequestStore
let plans: PlanStore
let tracker: RequestTracker
let now: number

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-requests-goals-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  plans = new PlanStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  now = 6_000
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const api = (method: string, p: string, body?: Record<string, unknown>, taskId = "t1") =>
  handleRequestsApi(method, p, body, {
    store, tracker, plans, enabled: true, hasAgent: (id) => id === "coder" || id === "ops", now,
    runningTurn: (agentId, pr) => (agentId === "coder" && pr.taskId === taskId ? { channel: "telegram", chatId: `chat-${taskId}` } : null),
  }, { taskId })

function turn(taskId: string) {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: `chat-${taskId}`, taskId, messagePreview: `job ${taskId}`, fullMessage: `job ${taskId}`,
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
}

const accept = (taskId: string, extra: Record<string, unknown> = {}) =>
  api("POST", "/requests", { action: "accept", agentId: "coder", work: "research", ...extra }, taskId)
const goals = () => (api("GET", "/requests/goals").body as any).goals as any[]

function traces(rows: Array<[string, number | null]>) {
  db.exec("CREATE TABLE IF NOT EXISTS task_traces (task_id TEXT PRIMARY KEY, cost_usd REAL)")
  for (const [id, usd] of rows) db.prepare("INSERT INTO task_traces VALUES (?, ?)").run(id, usd)
}

describe("parseGoal", () => {
  it("takes {id, title} or a bare title, and refuses what does not read", () => {
    expect(parseGoal(undefined)).toBeUndefined()
    expect(parseGoal("")).toBeUndefined()
    expect(parseGoal({ id: "launch", title: "  Launch the  site " })).toEqual({ id: "launch", title: "Launch the site" })
    expect(parseGoal("Launch the new site!")).toEqual({ id: "launch-the-new-site", title: "Launch the new site!" })
    expect(parseGoal({ id: "launch" })).toMatch(/title/)
    expect(parseGoal({ id: "has space", title: "x" })).toMatch(/goal.id/)
    expect(parseGoal({ title: "x".repeat(121) })).toMatch(/longer/)
    expect(parseGoal(42)).toMatch(/goal must be/)
    expect(goalIdOf("Café opening, Q3")).toBe("cafe-opening-q3")
    // A title with no Latin letters still gives a stable id.
    const arabic = parseGoal("إطلاق الموقع الجديد") as any
    expect(arabic.title).toBe("إطلاق الموقع الجديد")
    expect(arabic.id).toMatch(/^goal-[0-9a-f]{10}$/)
    expect(goalIdOf("إطلاق الموقع الجديد")).toBe(arabic.id)
  })
})

describe("a request accepted with a goal", () => {
  it("shows under that goal, with its runs' cost and how far along it is", () => {
    turn("t1"); turn("t2"); turn("t3")
    const goal = { id: "launch", title: "Launch the new site" }
    expect(accept("t1", { goal }).status).toBe(200)
    expect(accept("t2", { goal: { ...goal, title: "Launch the site" } }).status).toBe(200)
    expect(accept("t3", { goal: "Hire a designer" }).status).toBe(200)
    expect(store.get("req-t1")!.goal).toEqual(goal)
    // A second run under the first request: its cost counts too.
    store.link("req-t1", "run", "t1b", now)
    traces([["t1", 0.5], ["t1b", 0.25], ["t2", null], ["t3", 1]])
    now = 7_000
    expect(api("POST", "/requests", { action: "done", agentId: "coder", evidence: "https://example.com/pull/1" }, "t1").status).toBe(200)

    const [hire, launch] = [goals().find((g) => g.id === "hire-a-designer"), goals().find((g) => g.id === "launch")]
    expect(launch).toMatchObject({ title: "Launch the new site", open: 1, done: 1, dropped: 0, progress: 0.5, costUsd: 0.75, runs: 3, unpriced: 1 })
    expect(launch.requests.map((r: any) => [r.id, r.state, r.costUsd])).toEqual([["req-t1", "done", 0.75], ["req-t2", "in_progress", null]])
    expect(hire).toMatchObject({ open: 1, done: 0, progress: 0, costUsd: 1 })
    // Most recently active first.
    expect(goals()[0].id).toBe("launch")
    expect(describeGoals(goals())).toContain('- launch "Launch the new site": 1 open, 1 done (50% done). Cost $0.75, 1 of 3 runs without a cost.')
  })

  it("keeps the goal on a tracked plan, and tells each step's agent why", () => {
    turn("t1")
    const res = accept("t1", { goal: { id: "launch", title: "Launch the new site" }, steps: [{ name: "Build", done: "PR merged" }, { name: "Deploy", agent: "ops", done: "live" }] })
    expect(res.status).toBe(200)
    const r = store.get("req-t1")!
    expect(r.goal?.id).toBe("launch")
    const steps = plans.steps("req-t1")
    expect(dispatchText(r, steps, steps[1])).toContain('Why: this request serves the goal "Launch the new site" (launch).')
    expect(pickupText(r)).toContain('Why: this request serves the goal "Launch the new site" (launch).')
    expect(describeOpen([r])).toContain("Goal: Launch the new site (launch).")
  })

  it("counts a plan step run by another agent toward the goal, without moving the request", () => {
    turn("t1")
    accept("t1", { goal: "Launch", steps: [{ name: "Build", done: "PR merged" }, { name: "Deploy", agent: "ops", done: "live" }] })
    tracker.taskStarted({ agentId: "ops", ...pickupContext("req-t1"), taskId: "t-ops", pickup: true, at: "", messagePreview: "deploy" } as any)
    expect(store.byLink("run", "t-ops")).toBeNull()
    expect(store.byLink("step_run", "t-ops")?.id).toBe("req-t1")
    traces([["t1", 0.5], ["t-ops", 0.25]])
    tracker.taskCompleted({ agentId: "ops", ...pickupContext("req-t1"), taskId: "t-ops", error: "boom", at: "" } as any)
    expect(store.get("req-t1")!.state).toBe("in_progress")
    expect(goals()[0]).toMatchObject({ id: "launch", costUsd: 0.75, runs: 2 })
  })

  it("refuses a goal on anything but accept, and a malformed one", () => {
    turn("t1")
    accept("t1")
    expect(api("POST", "/requests", { action: "wait", agentId: "coder", question: "which?", goal: "x" }, "t1").status).toBe(400)
    expect(accept("t1", { goal: { title: "" } }).status).toBe(400)
    expect(store.get("req-t1")!.goal).toBeNull()
  })

  it("sums no cost on a database without task traces", () => {
    turn("t1")
    accept("t1", { goal: "Launch" })
    expect(goals()[0]).toMatchObject({ id: "launch", costUsd: 0, runs: 0, unpriced: 0 })
  })
})

describe("a request with no goal", () => {
  it("works exactly as before and lists no goal", () => {
    turn("t1")
    expect(accept("t1").status).toBe(200)
    const r = store.get("req-t1")!
    expect(r.goal).toBeNull()
    expect(pickupText(r)).not.toContain("Why:")
    expect(describeOpen([r])).not.toContain("Goal:")
    expect(goals()).toEqual([])
    expect(describeGoals([])).toBe("No request names a goal.")
  })
})

describe("the agentx_request tool", () => {
  it("passes the goal on accept and reads goals", async () => {
    const sent: any[] = []
    const fetch = (async (url: string, init?: any) => {
      sent.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
      if (url.endsWith("/requests/goals")) {
        return new Response(JSON.stringify({ count: 1, goals: [{ id: "launch", title: "Launch", open: 0, done: 2, dropped: 0, progress: 1, costUsd: 0.004, runs: 2, unpriced: 0 }] }))
      }
      return new Response(JSON.stringify({ request: { id: "req-t1", goal: { id: "launch", title: "Launch" } } }))
    }) as any
    const env = { AGENTX_AGENT_ID: "coder" } as any
    const said = await runRequestTool({ action: "accept", work: "code", goal: { id: "launch", title: "Launch" } }, { daemonUrl: "http://d", fetch, env })
    expect(sent[0].body.goal).toEqual({ id: "launch", title: "Launch" })
    expect(said).toContain('It serves the goal "Launch" (launch).')
    const list = await runRequestTool({ action: "goals" }, { daemonUrl: "http://d", fetch, env })
    expect(list).toContain('- launch "Launch": 0 open, 2 done (100% done). Cost $0.004.')
  })
})
