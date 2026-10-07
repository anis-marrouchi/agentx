import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { PlanStore } from "../src/requests/plan-store"
import { DEFAULT_PLAN_SETTINGS, parseSteps, type PlanSettings } from "../src/requests/plans"
import { ownerStepAction, runPlansSweep, type PlanSweepDeps } from "../src/requests/plan-sweep"
import { runRequestsSweep } from "../src/requests/sweep"
import { handleRequestsApi, type RequestsApiDeps } from "../src/requests/daemon-api"
import { requestsConfigSchema } from "../src/daemon/config"
import { createCard, decideCard, readCard } from "../src/approvals/cards"
import { runApprovalsSweep } from "../src/approvals/sweep"

const MIN = 60_000
const AGENTS = new Set(["coder", "devops", "secretary"])
const REQ: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let requests: RequestStore
let plans: PlanStore
let tracker: RequestTracker
let settings: PlanSettings
let clock: number
let turns: Array<{ agentId: string; text: string }>
let sent: Array<{ to: string; text: string }>
let notices: Array<{ title: string; message: string }>
let cardsRaised: string[]

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-plans-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  requests = new RequestStore(db)
  plans = new PlanStore(db)
  tracker = new RequestTracker(requests, () => REQ, () => {}, () => clock)
  settings = { ...DEFAULT_PLAN_SETTINGS }
  clock = 1_000_000_000
  turns = []
  sent = []
  notices = []
  cardsRaised = []
  // The owner's request, open and with coder.
  requests.addCandidate({ id: "req-1", runId: "run-1", channel: "telegram", chatId: "owner-chat", agentId: "coder", text: "Fix the login bug, ship it, and tell the client", now: clock })
  requests.progress("req-1", clock)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function deps(over: Partial<PlanSweepDeps> = {}): PlanSweepDeps {
  return {
    requests, plans, settings,
    tellAgent: async (agentId, text) => { turns.push({ agentId, text }) },
    send: async (step, text) => { sent.push({ to: `${step.toChannel}:${step.toChat}`, text }) },
    notify: async (title, message) => { notices.push({ title, message }) },
    raiseCard: (r, step, input) => {
      const res = createCard(tmp, { ...input, if_silent: "discard", raised_by: step.agentId }, { now: clock, origin: { kind: "plan-step", requestId: r.id, step: step.idx } })
      if (!res.ok) throw new Error(res.error)
      cardsRaised.push(res.card.id)
      return res.card.id
    },
    readCard: (id) => readCard(tmp, id),
    hasAgent: (id) => AGENTS.has(id),
    fetch: (async () => new Response("down", { status: 503 })) as any,
    log: () => {},
    now: clock,
    ...over,
  }
}

const sweep = (over: Partial<PlanSweepDeps> = {}) => runPlansSweep(deps(over))

function api(body: Record<string, unknown>, over: Partial<RequestsApiDeps> = {}) {
  return handleRequestsApi("POST", "/requests", body, {
    store: requests, tracker, enabled: true,
    hasAgent: (id) => AGENTS.has(id),
    runningTurn: () => ({ channel: "telegram", chatId: "owner-chat" }),
    plans, planSettings: settings, now: clock,
    ...over,
  })
}

const STEPS = [
  { name: "Build the fix", done: "PR merged" },
  { name: "Deploy", agent: "devops", kind: "deploy", done: "release live", check: { url: "https://example.com/version", contains: "1.2.3" } },
  { name: "Tell the client", kind: "message", message: "The login fix is live.", to: { channel: "telegram", chatId: "client-chat" } },
]

function makePlan(steps: unknown[] = STEPS) {
  const res = api({ action: "accept", agentId: "coder", id: "req-1", steps })
  expect(res.status).toBe(200)
  return res
}

describe("settings", () => {
  it("defaults to on, a 30 minute stall, 3 nudges, and approving messages up front", () => {
    expect(requestsConfigSchema.parse(undefined).plans).toEqual({ enabled: true, stallMinutes: 30, maxNudges: 3, approveKinds: ["message"], disabledAgents: [] })
  })

  it("refuses a step kind that is not a short word", () => {
    expect(requestsConfigSchema.safeParse({ plans: { approveKinds: ["Send Email"] } }).success).toBe(false)
  })
})

describe("making a plan", () => {
  it("records named steps with owners when the agent accepts a request of 2+ steps", () => {
    const res = makePlan()
    const body = res.body as any
    expect(body.plan).toMatchObject({ requestId: "req-1", createdBy: "coder", state: "active" })
    expect(body.steps.map((s: any) => [s.idx, s.name, s.agentId, s.kind, s.state])).toEqual([
      [1, "Build the fix", "coder", "task", "active"],
      [2, "Deploy", "devops", "deploy", "pending"],
      [3, "Tell the client", "coder", "message", "pending"],
    ])
    expect(body.steps[2]).toMatchObject({ needsApproval: true, approval: "none", toChannel: "telegram", toChat: "client-chat" })
    expect(plans.events("req-1")[0]).toMatchObject({ kind: "created" })
  })

  it("needs two steps, a done check, an agent of this node, and a destination for a message", () => {
    const one = parseSteps([{ name: "a", done: "x" }], { createdBy: "coder", hasAgent: (id) => AGENTS.has(id), settings })
    expect(one.ok).toBe(false)
    const cases: Array<[unknown[], RegExp]> = [
      [[{ name: "a", done: "x" }, { name: "b" }], /needs done/],
      [[{ name: "a", done: "x" }, { name: "b", done: "y", agent: "ghost" }], /not an agent/],
      [[{ name: "a", done: "x" }, { name: "b", kind: "message", message: "hi" }], /needs to:/],
      [[{ name: "a", done: "x" }, { name: "b", done: "y", check: { url: "file:///etc/passwd" } }], /http/],
    ]
    for (const [steps, error] of cases) {
      const res = api({ action: "accept", agentId: "coder", id: "req-1", steps })
      expect(res.status).toBe(400)
      expect((res.body as any).error).toMatch(error)
    }
    expect(plans.get("req-1")).toBeNull()
  })

  it("is refused for an agent the plans are turned off for, and when off", () => {
    settings.disabledAgents = ["coder"]
    expect((api({ action: "accept", agentId: "coder", id: "req-1", steps: STEPS }).body as any).error).toMatch(/turned off for coder/)
    settings.disabledAgents = []
    settings.enabled = false
    expect((api({ action: "accept", agentId: "coder", id: "req-1", steps: STEPS }).body as any).error).toMatch(/turned off on this node/)
    // Accept without steps still works.
    expect(api({ action: "accept", agentId: "coder", id: "req-1" }).status).toBe(200)
  })

  it("keeps one plan per request", () => {
    makePlan()
    expect(api({ action: "accept", agentId: "coder", id: "req-1", steps: STEPS }).status).toBe(409)
  })
})

describe("following a plan", () => {
  it("hands each step to its owner in order, and a URL check finishes a step by itself", async () => {
    makePlan()
    await sweep()
    // Step 1 is the writer's own, already under way: nobody is told.
    expect(turns).toEqual([])
    expect(api({ action: "step", agentId: "coder", id: "req-1", step: 1, status: "done", evidence: "https://example.com/pull/7" }).status).toBe(200)
    await sweep()
    expect(turns.map((t) => t.agentId)).toEqual(["devops"])
    expect(turns[0].text).toContain("[agentx:plan-step id=req-1 step=2]")
    expect(turns[0].text).toContain("Done when: release live")
    // The release goes live: the check sees it.
    await sweep({ fetch: (async () => new Response("version 1.2.3")) as any })
    expect(plans.step("req-1", 2)).toMatchObject({ state: "done", evidence: "https://example.com/version answered with \"1.2.3\"" })
  })

  it("lets only the step's owner, or the plan's writer, report on it", () => {
    makePlan()
    expect(api({ action: "step", agentId: "secretary", id: "req-1", step: 2, status: "done", evidence: "x" }).status).toBe(403)
    expect(api({ action: "step", agentId: "devops", id: "req-1", step: 2, status: "done", evidence: "" }).status).toBe(409)
    expect(api({ action: "step", agentId: "devops", id: "req-1", step: 2, status: "done", evidence: "v1.2.3 live" }).status).toBe(200)
    // A message step is the daemon's to send.
    expect((api({ action: "step", agentId: "coder", id: "req-1", step: 3, status: "done", evidence: "sent" }).body as any).error).toMatch(/daemon sends/)
  })
})

describe("nudges", () => {
  beforeEach(() => {
    makePlan([{ name: "Build", done: "PR merged" }, { name: "Deploy", agent: "devops", done: "live" }])
    api({ action: "step", agentId: "coder", id: "req-1", step: 1, status: "done", evidence: "PR 7" })
  })

  it("nudges the owning agent of a step quiet past the stall time, and logs it", async () => {
    await sweep()
    expect(turns).toHaveLength(1) // handed over
    clock += 29 * MIN
    await sweep()
    expect(turns).toHaveLength(1)
    clock += 2 * MIN
    const res = await sweep()
    expect(res.nudged).toBe(1)
    expect(turns[1].agentId).toBe("devops")
    expect(turns[1].text).toContain("nudge 1 of 3")
    expect(plans.events("req-1").filter((e) => e.kind === "nudged")).toEqual([
      expect.objectContaining({ step: 2, detail: expect.stringContaining("devops, nudge 1 of 3") }),
    ])
    expect(plans.step("req-1", 2)).toMatchObject({ nudges: 1 })
  })

  it("does not nudge a step whose agent reports progress", async () => {
    await sweep()
    clock += 25 * MIN
    api({ action: "step", agentId: "devops", id: "req-1", step: 2, status: "progress", note: "build running" })
    clock += 25 * MIN
    expect((await sweep()).nudged).toBe(0)
  })

  it("blocks the step after the last nudge and tells the owner once, not twice", async () => {
    await sweep()
    for (let i = 0; i < 3; i++) { clock += 31 * MIN; await sweep() }
    expect(turns).toHaveLength(4)
    clock += 31 * MIN
    const res = await sweep()
    expect(res.blocked).toBe(1)
    expect(plans.step("req-1", 2)).toMatchObject({ state: "blocked", note: "no progress after 3 nudges" })
    expect(requests.get("req-1")).toMatchObject({ state: "needs_attention" })
    expect(notices).toEqual([{ title: "Plan step blocked", message: expect.stringContaining("agentx requests step req-1 2 --retry") }])
    // The requests check does not raise it again with its own words.
    await runRequestsSweep({ store: requests, settings: REQ, notify: async (title, message) => { notices.push({ title, message }) }, log: () => {}, now: clock })
    clock += 31 * MIN
    await sweep()
    expect(notices).toHaveLength(1)
    expect(turns).toHaveLength(4)
  })

  it("goes on when the owner retries a blocked step, with a fresh count", async () => {
    await sweep()
    for (let i = 0; i < 4; i++) { clock += 31 * MIN; await sweep() }
    expect(ownerStepAction(requests, plans, { requestId: "req-1", step: 2, action: "retry" }, clock)).toBeNull()
    expect(requests.get("req-1")?.state).toBe("in_progress")
    await sweep()
    expect(turns.at(-1)?.text).toContain("[agentx:plan-step id=req-1 step=2]")
    expect(plans.step("req-1", 2)).toMatchObject({ state: "active", nudges: 0 })
  })
})

describe("the client message", () => {
  it("is approved once at plan creation, then sent without asking again when the earlier steps are done", async () => {
    makePlan()
    await sweep()
    // One card, for the message, raised when the plan is new.
    expect(cardsRaised).toHaveLength(1)
    const card = readCard(tmp, cardsRaised[0])!
    expect(card).toMatchObject({ draft: "The login fix is live.", origin: { kind: "plan-step", requestId: "req-1", step: 3 } })
    expect(card.ask).toContain("telegram chat client-chat")
    // The owner says yes, with an edit.
    expect(decideCard(tmp, card.id, "yes", { text: "Good news: the login fix is live." }).ok).toBe(true)
    await sweep()
    expect(plans.step("req-1", 3)).toMatchObject({ approval: "approved", message: "Good news: the login fix is live.", state: "pending" })
    expect(sent).toEqual([])
    api({ action: "step", agentId: "coder", id: "req-1", step: 1, status: "done", evidence: "PR 7" })
    api({ action: "step", agentId: "devops", id: "req-1", step: 2, status: "done", evidence: "v1.2.3 live" })
    await sweep()
    expect(sent).toEqual([{ to: "telegram:client-chat", text: "Good news: the login fix is live." }])
    expect(cardsRaised).toHaveLength(1)
    expect(plans.step("req-1", 3)?.state).toBe("done")
  })

  it("is skipped when the owner says no, and blocks the plan when the card expires", async () => {
    makePlan()
    await sweep()
    decideCard(tmp, cardsRaised[0], "no")
    await sweep()
    expect(plans.step("req-1", 3)).toMatchObject({ state: "skipped", approval: "declined" })

    requests.addCandidate({ id: "req-2", runId: "run-2", channel: "telegram", chatId: "owner-chat", agentId: "coder", text: "x", now: clock })
    requests.progress("req-2", clock)
    expect(api({ action: "accept", agentId: "coder", id: "req-2", steps: STEPS }).status).toBe(200)
    await sweep()
    const card2 = cardsRaised[1]
    await runApprovalsSweep({ ctx: { root: tmp, now: clock + 4 * 24 * 60 * MIN }, settings: { notifyAgent: true, digest: { enabled: false } } as any, log: () => {} })
    expect(readCard(tmp, card2)?.status).toBe("expired")
    await sweep()
    expect(plans.step("req-2", 3)).toMatchObject({ state: "blocked", approval: "expired" })
  })

  it("is not told to the agent as a card result: the plan acts on it", async () => {
    makePlan()
    await sweep()
    decideCard(tmp, cardsRaised[0], "yes")
    const told: string[] = []
    await runApprovalsSweep({
      ctx: { root: tmp, now: clock }, settings: { notifyAgent: true, digest: { enabled: false } } as any, log: () => {},
      tellAgent: async (agentId) => { told.push(agentId) },
    })
    expect(told).toEqual([])
  })

  it("is sent straight away when its kind needs no approval", async () => {
    settings.approveKinds = []
    makePlan([{ name: "Build", done: "PR merged" }, STEPS[2]])
    api({ action: "step", agentId: "coder", id: "req-1", step: 1, status: "done", evidence: "PR 7" })
    await sweep()
    expect(cardsRaised).toEqual([])
    expect(sent).toEqual([{ to: "telegram:client-chat", text: "The login fix is live." }])
  })
})

describe("the end of a plan", () => {
  it("closes the request and sends the owner one summary when every step is done", async () => {
    settings.approveKinds = []
    makePlan()
    api({ action: "step", agentId: "coder", id: "req-1", step: 1, status: "done", evidence: "https://example.com/pull/7" })
    await sweep()
    expect(notices).toEqual([])
    api({ action: "step", agentId: "devops", id: "req-1", step: 2, status: "done", evidence: "v1.2.3 live" })
    const res = await sweep()
    expect(res.finished).toBe(1)
    expect(plans.get("req-1")?.state).toBe("done")
    expect(requests.get("req-1")).toMatchObject({ state: "done", evidence: expect.stringContaining("Plan finished.") })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ title: "Plan finished" })
    expect(notices[0].message).toContain("3. Tell the client (coder) [done]: sent to telegram chat client-chat")
    await sweep()
    expect(notices).toHaveLength(1)
  })

  it("tries the summary again when it could not be sent", async () => {
    settings.approveKinds = []
    makePlan([{ name: "a", done: "x" }, { name: "b", done: "y" }])
    api({ action: "step", agentId: "coder", id: "req-1", step: 1, status: "done", evidence: "1" })
    api({ action: "step", agentId: "coder", id: "req-1", step: 2, status: "done", evidence: "2" })
    await sweep({ notify: async () => { throw new Error("offline") } })
    expect(plans.get("req-1")?.notifiedAt).toBeNull()
    await sweep()
    expect(notices).toHaveLength(1)
  })

  it("stops following a plan whose request was closed some other way", async () => {
    makePlan()
    requests.close("req-1", "dropped", "not needed", clock)
    await sweep()
    expect(plans.get("req-1")?.state).toBe("closed")
    expect(turns).toEqual([])
    expect(notices).toEqual([])
  })

  it("lets the owner skip or finish a step", () => {
    makePlan()
    expect(ownerStepAction(requests, plans, { requestId: "req-1", step: 2, action: "skip", detail: "deployed by hand" }, clock)).toBeNull()
    expect(ownerStepAction(requests, plans, { requestId: "req-1", step: 1, action: "done" }, clock)).toBeNull()
    expect(plans.steps("req-1").map((s) => s.state)).toEqual(["done", "skipped", "pending"])
    expect(ownerStepAction(requests, plans, { requestId: "req-1", step: 2, action: "skip" }, clock)).toMatch(/already skipped/)
  })
})

describe("reading a plan", () => {
  it("returns the plan, its steps and its log with the request", () => {
    makePlan()
    const res = handleRequestsApi("GET", "/requests/req-1", undefined, {
      store: requests, tracker, enabled: true, hasAgent: () => true, runningTurn: () => null, plans,
    })
    expect((res.body as any).steps).toHaveLength(3)
    expect((res.body as any).events[0].kind).toBe("created")
  })
})

describe("the dashboard card", () => {
  it("lists the plan's steps with their state", async () => {
    const { requestCard } = await import("../src/requests/card-view")
    makePlan()
    const card = requestCard(requests.get("req-1")!, requests, plans)
    expect(card.plan?.steps.map((s) => [s.name, s.agentId, s.state, s.approval])).toEqual([
      ["Build the fix", "coder", "active", null],
      ["Deploy", "devops", "pending", null],
      ["Tell the client", "coder", "pending", "none"],
    ])
    expect(requestCard(requests.get("req-1")!, requests).plan).toBeNull()
  })
})
