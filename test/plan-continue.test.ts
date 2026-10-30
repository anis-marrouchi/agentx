import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { PlanStore } from "../src/requests/plan-store"
import { DEFAULT_CONTINUE_SETTINGS, DEFAULT_PLAN_SETTINGS, parseSteps, type ContinueSettings } from "../src/requests/plans"
import { continueOnTurnEnd, type ContinueDeps } from "../src/requests/plan-continue"
import { reportStep, runPlansSweep } from "../src/requests/plan-sweep"
import { forgeCounter, parseCountSpec, type ForgeCounter } from "../src/requests/checkers/count"
import { requestsConfigSchema } from "../src/daemon/config"

const MIN = 60_000
const REQ = "req-goal"
const COUNT = JSON.stringify({ provider: "github", project: "acme/app", what: "issues", max: 0 })

let tmp: string
let db: Database.Database
let requests: RequestStore
let plans: PlanStore
let clock: number
let open: number
let turns: Array<{ agentId: string; text: string }>
let notices: string[]
let started: Set<string>
let settings: ContinueSettings

const counter: ForgeCounter = async () => open

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-continue-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  requests = new RequestStore(db)
  plans = new PlanStore(db)
  clock = Date.UTC(2026, 9, 30, 19, 0)
  open = 13
  turns = []
  notices = []
  started = new Set()
  settings = { ...DEFAULT_CONTINUE_SETTINGS, enabled: true }
  requests.addCandidate({ id: REQ, runId: "run-1", channel: "voice", chatId: "voice:secretary", agentId: "secretary", text: "Clear the open issues", now: clock })
  requests.progress(REQ, clock)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makePlan(checkCount: string | null = COUNT) {
  plans.create(REQ, "secretary", [
    { name: "Coder clears the open issues", kind: "task", agentId: "coder", doneWhen: "0 open issues", needsApproval: false, checkCount },
    { name: "Deploy", kind: "deploy", agentId: "devops", doneWhen: "live", needsApproval: false },
  ], clock)
  // Handed to coder, and its count read once.
  plans.updateStep(REQ, 1, { dispatchedAt: clock, ...(checkCount ? { lastCount: 13, lastCountAt: clock } : {}) })
}

function deps(over: Partial<ContinueDeps> = {}): ContinueDeps {
  return {
    requests, plans, settings,
    tellAgent: async (agentId, text) => { turns.push({ agentId, text }) },
    notify: async (title, message) => { notices.push(`${title}: ${message}`) },
    counter, started, log: () => {}, now: clock,
    ...over,
  }
}

/** A turn of `minutes` on the request's chat ends now. */
const turnEnds = (over: Partial<Parameters<typeof continueOnTurnEnd>[1]> = {}, minutes = 10) =>
  continueOnTurnEnd(deps(), { agentId: "coder", chatId: REQ, durationMs: minutes * MIN, ...over })

describe("the count check", () => {
  it("reads open counts from GitHub's search total and GitLab's X-Total", async () => {
    const urls: string[] = []
    const fetcher = (async (url: string) => {
      urls.push(url)
      return url.includes("gitlab")
        ? new Response("[]", { headers: { "x-total": "4" } })
        : new Response(JSON.stringify({ total_count: 11 }))
    }) as any
    const count = forgeCounter({ github: { apiUrl: "https://api.github.com" }, gitlab: { url: "https://gitlab.example" } }, fetcher)
    expect(await count("github", "acme/app", "issues")).toBe(11)
    expect(await count("gitlab", "grp/proj", "prs")).toBe(4)
    expect(decodeURIComponent(urls[0])).toContain("repo:acme/app is:open is:issue")
    expect(urls[1]).toBe("https://gitlab.example/api/v4/projects/grp%2Fproj/merge_requests?state=opened&per_page=1")
    expect(await forgeCounter({}, fetcher)("github", "acme/app", "issues")).toEqual({ error: expect.stringContaining("no github connector") })
  })

  it("is a step check: {count: {provider, project, what, max}}", () => {
    const opts = { createdBy: "coder", hasAgent: () => true, settings: DEFAULT_PLAN_SETTINGS }
    const ok = parseSteps([{ name: "Clear", done: "0 open", check: { count: { provider: "github", project: "acme/app" } } }, { name: "Ship", done: "live" }], opts)
    expect(ok).toMatchObject({ ok: true, steps: [{ checkCount: COUNT }, {}] })
    const bad = parseSteps([{ name: "Clear", done: "0", check: { count: { provider: "github", project: "acme" } } }, { name: "Ship", done: "live" }], opts)
    expect((ok as any).steps[0].checkUrl).toBeUndefined()
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('step 1: check.count.project must be "owner/repo"') })
    expect(parseCountSpec({ provider: "gitlab", project: "g/p", what: "all", max: 2 })).toEqual({ provider: "gitlab", project: "g/p", what: "all", max: 2 })
    expect(parseCountSpec({ provider: "github", project: "a/b", max: -1 })).toMatch(/max/)
  })

  it("marks the step done in the plan check when the count reaches max, at most every 5 minutes", async () => {
    makePlan()
    const sweep = () => runPlansSweep({ requests, plans, settings: DEFAULT_PLAN_SETTINGS, counter, tellAgent: async () => {}, log: () => {}, now: clock })
    open = 0
    clock += 2 * MIN
    await sweep()
    expect(plans.step(REQ, 1)?.state).toBe("active") // read 2 minutes ago
    clock += 4 * MIN
    await sweep()
    expect(plans.step(REQ, 1)).toMatchObject({ state: "done", evidence: "0 open issues in acme/app", lastCount: 0 })
    expect(plans.events(REQ).map((e) => e.kind)).toContain("count-down")
  })
})

describe("continue when a turn ends", () => {
  it("starts the next turn at once when the count went down during the turn", async () => {
    makePlan()
    open = 11
    expect(await turnEnds()).toBe("continued")
    expect(turns).toEqual([{ agentId: "coder", text: expect.stringContaining(`[agentx:plan-continue id=${REQ} step=1]`) }])
    expect(turns[0].text).toContain("count 13 → 11 open issues in acme/app")
    expect(turns[0].text).toContain("turn 1 of at most 10 today")
    expect(plans.events(REQ).filter((e) => e.kind === "continued")).toEqual([
      expect.objectContaining({ step: 1, detail: expect.stringContaining("coder, turn 1 of 10 today") }),
    ])
    expect(plans.continues("request:" + REQ, "2026-10-30")).toMatchObject({ turns: 1 })
  })

  it("leaves a turn that moved nothing to the nudge: words alone do not count when there is a count", async () => {
    makePlan()
    reportStep(requests, plans, { requestId: REQ, step: 1, status: "progress", agentId: "coder", note: "still 13 open, looking" }, clock - MIN)
    expect(await turnEnds()).toBe("still")
    expect(turns).toEqual([])
  })

  it("without a count, continues on a new progress report and not on a repeat", async () => {
    makePlan(null)
    reportStep(requests, plans, { requestId: REQ, step: 1, status: "progress", agentId: "coder", note: "PR 1 open" }, clock - 30 * MIN)
    reportStep(requests, plans, { requestId: REQ, step: 1, status: "progress", agentId: "coder", note: "PR 2 open" }, clock - MIN)
    expect(await turnEnds()).toBe("continued")
    clock += 20 * MIN
    reportStep(requests, plans, { requestId: REQ, step: 1, status: "progress", agentId: "coder", note: "PR 2 open" }, clock - MIN)
    expect(await turnEnds()).toBe("still")
  })

  it("stops at the daily turn cap, tells the owner once, and starts again the next day", async () => {
    settings.maxTurnsPerDay = 2
    makePlan()
    for (const n of [12, 11]) { open = n; clock += MIN; expect(await turnEnds()).toBe("continued") }
    open = 10; clock += MIN
    expect(await turnEnds()).toBe("capped")
    open = 9; clock += MIN
    expect(await turnEnds()).toBe("capped")
    expect(turns).toHaveLength(2)
    expect(notices).toEqual([expect.stringContaining("2 turns, $0.00 today (cap 2 turns, $5)")])
    clock = Date.UTC(2026, 9, 31, 0, 5)
    open = 8
    expect(await turnEnds()).toBe("continued")
  })

  it("counts what the turns it started cost against the daily cost cap", async () => {
    makePlan()
    open = 12
    expect(await turnEnds()).toBe("continued")
    open = 11; clock += MIN
    // The continued turn cost $6: over the $5 cap.
    expect(await turnEnds({ costUsd: 6 })).toBe("capped")
    expect(plans.continues("request:" + REQ, "2026-10-30")).toMatchObject({ turns: 1, costUsd: 6 })
  })

  it("caps by goal, across the goal's requests", async () => {
    requests.setGoal(REQ, { id: "zero-issues", title: "Zero issues" })
    makePlan()
    open = 12
    await turnEnds()
    expect(plans.continues("goal:zero-issues", "2026-10-30").turns).toBe(1)
    expect(plans.continues("request:" + REQ, "2026-10-30").turns).toBe(0)
  })

  it("does nothing when off, outside `only`, on another agent, or after a failed turn", async () => {
    makePlan()
    open = 11
    settings.enabled = false
    expect(await turnEnds()).toBeNull()
    settings.enabled = true
    settings.only = ["req-other"]
    expect(await turnEnds()).toBeNull()
    settings.only = [REQ]
    expect(await turnEnds({ agentId: "devops" })).toBeNull()
    expect(await turnEnds({ error: "boom" })).toBeNull()
    expect(await turnEnds({ stopped: true })).toBeNull()
    expect(turns).toEqual([])
    expect(await turnEnds()).toBe("continued")
  })

  it("does nothing once the count is met: the plan check marks it done", async () => {
    makePlan()
    open = 0
    expect(await turnEnds()).toBeNull()
    expect(turns).toEqual([])
  })
})

describe("settings", () => {
  it("defaults to off, 10 turns and $5 per goal per day", () => {
    const parsed = requestsConfigSchema.parse({})
    expect(parsed.plans.continue).toEqual({ enabled: false, only: [], maxTurnsPerDay: 10, maxCostUsdPerDay: 5 })
  })
})
