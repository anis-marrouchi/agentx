import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { readRecentCronRuns, type CronRunHistoryItem } from "../src/crons/run-history"
import {
  buildRoutines,
  describeFilters,
  failStreak,
  workflowOutcome,
  ROUTINE_LIMITS,
  type RoutineCronJob,
  type RoutineWorkflow,
} from "../src/daemon/routines"
import type { RunSummary } from "../src/daemon/workflow-health"
import { renderMeshPage } from "../src/daemon/ui/pages/mesh"
import { MESH_ROUTINES_SCRIPT } from "../src/daemon/ui/pages/mesh-routines.client"

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

function cronRun(jobId: string, hoursAgo: number, status: CronRunHistoryItem["status"] = "success", errorSummary?: string): CronRunHistoryItem {
  const at = NOW - hoursAgo * HOUR
  return { jobId, startedAt: iso(at), completedAt: iso(at + 1000), duration: 1000, status, errorSummary, responseSummary: "done", isRetry: false, retryAttempt: 0 }
}

function job(id: string, overrides: Partial<RoutineCronJob> = {}): RoutineCronJob {
  return { id, enabled: true, schedule: "0 * * * *", timezone: "UTC", agent: "ops", ...overrides }
}

function hookWorkflow(id: string, overrides: Partial<RoutineWorkflow> = {}): RoutineWorkflow {
  return {
    id, title: id, state: "active",
    nodes: [
      { id: "t", type: "trigger.hook", config: { event: "on:gitlab-issue", filter: { action: ["open", "reopen"] } } },
      { id: "a", type: "agent", config: { agentId: "coder", prompt: "SECRET PROMPT TEXT" } },
    ],
    ...overrides,
  }
}

function wfRun(workflowId: string, hoursAgo: number, status = "completed"): RunSummary {
  return { workflowId, status, at: NOW - hoursAgo * HOUR }
}

function build(args: {
  crons?: RoutineCronJob[]
  runs?: Record<string, CronRunHistoryItem[]>
  workflows?: RoutineWorkflow[]
  workflowRuns?: RunSummary[]
}) {
  return buildRoutines({
    crons: args.crons ?? [],
    cronRuns: new Map(Object.entries(args.runs ?? {})),
    workflows: args.workflows ?? [],
    workflowRuns: args.workflowRuns ?? [],
    now: NOW,
  })
}

describe("buildRoutines — merge", () => {
  it("lists cron jobs and cron/hook workflows together with stable ids", () => {
    const routines = build({
      crons: [job("hourly-sync")],
      runs: { "hourly-sync": [cronRun("hourly-sync", 0.5)] },
      workflows: [
        hookWorkflow("issue-triage"),
        { id: "nightly-report", title: "Nightly report", nodes: [{ id: "t", type: "trigger.cron", config: { spec: "0 2 * * *", timezone: "UTC" } }], ownerAgent: "reporter" },
        { id: "manual-only", title: "Manual", nodes: [{ id: "t", type: "trigger.manual", config: {} }] },
      ],
      workflowRuns: [wfRun("issue-triage", 2), wfRun("nightly-report", 10)],
    })
    const byId = Object.fromEntries(routines.map((r) => [r.id, r]))
    expect(Object.keys(byId).sort()).toEqual(["cron:hourly-sync", "workflow:issue-triage", "workflow:nightly-report"])

    expect(byId["cron:hourly-sync"]).toMatchObject({ source: "cron", kind: "schedule", agent: "ops", enabled: true, trigger: { schedule: "0 * * * *" } })
    expect(byId["workflow:issue-triage"]).toMatchObject({
      source: "workflow", kind: "event", agent: "coder",
      trigger: { event: "on:gitlab-issue", filters: ["action=open,reopen"] },
      nextRunAt: null, lastRun: { status: "success" },
    })
    expect(byId["workflow:nightly-report"]).toMatchObject({ kind: "schedule", agent: "reporter", trigger: { schedule: "0 2 * * *" } })
    expect(byId["workflow:nightly-report"].nextRunAt).toBe("2026-09-21T02:00:00.000Z")
  })

  it("never carries prompts or full responses", () => {
    const long = "x".repeat(2000)
    const routines = build({
      crons: [job("noisy")],
      runs: { noisy: [cronRun("noisy", 0.2, "failed", long)] },
      workflows: [hookWorkflow("wf")],
    })
    const text = JSON.stringify(routines)
    expect(text).not.toContain("SECRET PROMPT TEXT")
    expect(text).not.toContain("done")
    expect(routines.find((r) => r.id === "cron:noisy")!.lastRun!.summary!.length).toBeLessThanOrEqual(ROUTINE_LIMITS.summary)
  })

  it("uses the scheduler's next run when present and computes it otherwise", () => {
    const [withNext] = build({ crons: [job("a", { nextRun: new Date(NOW + 5 * 60_000) })], runs: { a: [cronRun("a", 0.9)] } })
    expect(withNext.nextRunAt).toBe(iso(NOW + 5 * 60_000))
    const [computed] = build({ crons: [job("b")], runs: { b: [cronRun("b", 0.9)] } })
    expect(computed.nextRunAt).toBe("2026-09-20T13:00:00.000Z")
    const [disabled] = build({ crons: [job("c", { enabled: false })] })
    expect(disabled.nextRunAt).toBeNull()
  })

  it("marks disabled and quarantined workflows as not enabled", () => {
    const routines = build({ workflows: [hookWorkflow("off", { state: "disabled" }), hookWorkflow("q", { state: "quarantined" })] })
    expect(routines.map((r) => [r.id, r.enabled, r.state])).toEqual(
      expect.arrayContaining([["workflow:off", false, "disabled"], ["workflow:q", false, "quarantined"]]),
    )
  })

  it("caps the list", () => {
    const crons = Array.from({ length: ROUTINE_LIMITS.routines + 20 }, (_, i) => job(`j${i}`))
    expect(build({ crons })).toHaveLength(ROUTINE_LIMITS.routines)
  })
})

describe("buildRoutines — staleness", () => {
  it("flags consecutive failures as critical and sorts them first", () => {
    const routines = build({
      crons: [job("healthy"), job("broken")],
      runs: {
        healthy: [cronRun("healthy", 0.5)],
        broken: [cronRun("broken", 0.5, "failed", "boom"), cronRun("broken", 1.5, "timeout"), cronRun("broken", 2.5, "failed"), cronRun("broken", 3.5)],
      },
    })
    expect(routines[0].id).toBe("cron:broken")
    expect(routines[0].consecutiveFailures).toBe(3)
    expect(routines[0].attention).toBe("critical")
    expect(routines[0].flags.map((f) => f.reason)).toEqual(["failing"])
    expect(routines[0].lastRun).toMatchObject({ status: "failed", summary: "boom" })
    expect(routines[0].lastSuccessAt).toBe(iso(NOW - 3.5 * HOUR))
    expect(routines[1]).toMatchObject({ id: "cron:healthy", attention: null, flags: [] })
  })

  it("does not flag two failures under the default streak", () => {
    const [r] = build({ crons: [job("flaky")], runs: { flaky: [cronRun("flaky", 0.5, "failed"), cronRun("flaky", 1.5, "failed"), cronRun("flaky", 2.5)] } })
    expect(r.consecutiveFailures).toBe(2)
    expect(r.flags).toEqual([])
  })

  it("flags a schedule that has missed several expected fires", () => {
    // Hourly job, last attempt 5h ago: far past two missed fires.
    const [overdue] = build({ crons: [job("quiet")], runs: { quiet: [cronRun("quiet", 5)] } })
    expect(overdue.flags.map((f) => f.reason)).toEqual(["overdue"])
    expect(overdue.attention).toBe("warning")
    // Daily job that ran 20h ago is on time.
    const [daily] = build({ crons: [job("daily", { schedule: "0 16 * * *" })], runs: { daily: [cronRun("daily", 20)] } })
    expect(daily.flags).toEqual([])
  })

  it("allows grace before calling a schedule overdue", () => {
    // Hourly, last at 10:00; fires due 11:00 and 12:00. At 12:00 exactly
    // it is still within grace.
    const [r] = build({ crons: [job("edge")], runs: { edge: [cronRun("edge", 2)] } })
    expect(r.flags).toEqual([])
  })

  it("flags enabled routines that never ran", () => {
    const routines = build({ crons: [job("fresh")], workflows: [hookWorkflow("unused")] })
    for (const r of routines) {
      expect(r.flags.map((f) => f.reason)).toEqual(["never-ran"])
      expect(r.attention).toBe("warning")
    }
  })

  it("flags routines disabled for a long time, not recently disabled ones", () => {
    const routines = build({
      crons: [job("old", { enabled: false }), job("recent", { enabled: false }), job("never", { enabled: false })],
      runs: { old: [cronRun("old", 45 * 24)], recent: [cronRun("recent", 3 * 24)] },
      workflows: [
        hookWorkflow("stale-wf", { state: "disabled", updated: iso(NOW - 90 * DAY) }),
        hookWorkflow("new-wf", { state: "disabled", updated: iso(NOW - 2 * DAY) }),
      ],
    })
    const reasons = Object.fromEntries(routines.map((r) => [r.id, r.flags.map((f) => f.reason)]))
    expect(reasons["cron:old"]).toEqual(["disabled-long"])
    expect(reasons["cron:never"]).toEqual(["disabled-long"])
    expect(reasons["cron:recent"]).toEqual([])
    expect(reasons["workflow:stale-wf"]).toEqual(["disabled-long"])
    expect(reasons["workflow:new-wf"]).toEqual([])
    expect(routines.find((r) => r.id === "cron:old")!.attention).toBe("info")
    // Disabled routines are never also reported as failing or overdue.
    const failingButOff = build({ crons: [job("x", { enabled: false })], runs: { x: [cronRun("x", 1, "failed"), cronRun("x", 2, "failed"), cronRun("x", 3, "failed")] } })
    expect(failingButOff[0].flags).toEqual([])
  })

  it("flags an event workflow that went dormant, and one that keeps failing", () => {
    const routines = build({
      workflows: [hookWorkflow("dormant"), hookWorkflow("failing")],
      workflowRuns: [
        wfRun("dormant", 9 * 24), wfRun("dormant", 10 * 24),
        wfRun("failing", 1, "failed"), wfRun("failing", 2, "failed"), wfRun("failing", 3, "failed"), wfRun("failing", 0.5, "running"),
      ],
    })
    const byId = Object.fromEntries(routines.map((r) => [r.id, r]))
    expect(byId["workflow:dormant"].flags.map((f) => f.reason)).toEqual(["dormant"])
    expect(byId["workflow:failing"].flags.map((f) => f.reason)).toEqual(["failing"])
    expect(byId["workflow:failing"].consecutiveFailures).toBe(3)
    expect(byId["workflow:failing"].lastRun!.status).toBe("running")
  })
})

describe("helpers", () => {
  it("failStreak skips in-flight runs and stops at a success or cancel", () => {
    expect(failStreak([{ status: "running" }, { status: "failed" }, { status: "timeout" }, { status: "success" }, { status: "failed" }])).toBe(2)
    expect(failStreak([{ status: "canceled" }, { status: "failed" }])).toBe(0)
    expect(failStreak([])).toBe(0)
  })

  it("maps workflow run statuses", () => {
    expect(workflowOutcome("completed")).toBe("success")
    expect(workflowOutcome("ok")).toBe("success")
    expect(workflowOutcome("failed")).toBe("failed")
    expect(workflowOutcome("paused")).toBe("paused")
    expect(workflowOutcome("weird")).toBe("unknown")
  })

  it("describes filters compactly and includes project scope", () => {
    expect(describeFilters({ mentions: ["bot"], noteableType: ["merge_request"], empty: [] }, { project: "group/repo" }))
      .toEqual(["project=group/repo", "mentions=bot", "noteableType=merge_request"])
    expect(describeFilters(undefined)).toEqual([])
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, ["v".repeat(200)]]))
    const out = describeFilters(many)
    expect(out).toHaveLength(ROUTINE_LIMITS.filters)
    for (const f of out) expect(f.length).toBeLessThanOrEqual(ROUTINE_LIMITS.filterValue)
  })
})

describe("readRecentCronRuns", () => {
  let runsDir: string
  beforeEach(() => { runsDir = mkdtempSync(path.join(tmpdir(), "agentx-routines-")) })
  afterEach(() => { rmSync(runsDir, { recursive: true, force: true }) })

  function write(jobId: string, startedAt: string, success: boolean) {
    const dir = path.join(runsDir, jobId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify({
      jobId, startedAt, completedAt: startedAt, duration: 10, success, response: "full response", error: success ? undefined : "failed hard",
    }))
  }

  it("returns the newest attempts per job across days, newest first", async () => {
    write("a", "2026-09-01T08:00:00.000Z", true)
    write("a", "2026-09-10T08:00:00.000Z", false)
    write("a", "2026-09-19T08:00:00.000Z", true)
    write("b", "2026-08-01T08:00:00.000Z", false)
    writeFileSync(path.join(runsDir, "a", "garbage.json"), "{not json")
    const runs = await readRecentCronRuns({ runsDir, perJob: 2 })
    expect(runs.get("a")!.map((r) => [r.startedAt, r.status])).toEqual([
      ["2026-09-19T08:00:00.000Z", "success"],
      ["2026-09-10T08:00:00.000Z", "failed"],
    ])
    expect(runs.get("b")).toHaveLength(1)
  })

  it("restricts to known jobs and tolerates a missing directory", async () => {
    write("a", "2026-09-01T08:00:00.000Z", true)
    write("removed", "2026-09-01T08:00:00.000Z", true)
    const runs = await readRecentCronRuns({ runsDir, perJob: 5, jobIds: ["a"] })
    expect([...runs.keys()]).toEqual(["a"])
    expect((await readRecentCronRuns({ runsDir: path.join(runsDir, "nope"), perJob: 5 })).size).toBe(0)
  })
})

describe("mesh page routines section", () => {
  it("renders the section, filters and script", () => {
    const html = renderMeshPage({})
    expect(html).toContain('id="mx-routines"')
    expect(html).toContain('data-rt-filter="attention"')
    expect(html).toContain("mx:snapshot")
    // The routines listener must be registered before Operations fires its first load.
    expect(html.indexOf("mx-rt-filter')")).toBeLessThan(html.indexOf("MX.get('/api/mesh?date="))
  })

  it("ships browser JS that parses", () => {
    const body = MESH_ROUTINES_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "")
    expect(() => new Function(body)).not.toThrow()
  })

  it("renders flagged routines, unreachable nodes and old daemons from a snapshot", () => {
    // Minimal DOM stand-in: enough surface for the script's own calls.
    const el = (): any => ({ innerHTML: "", textContent: "", listeners: {} as Record<string, Function>,
      addEventListener(t: string, h: Function) { this.listeners[t] = h },
      querySelectorAll: () => [], querySelector: () => ({}) })
    const root = el(), bar = el(), count = el()
    const docListeners: Record<string, Function> = {}
    const opened: string[] = []
    const document = {
      getElementById: (id: string) => ({ "mx-routines": root, "mx-rt-filter": bar, "mx-rt-count": count } as any)[id] ?? null,
      addEventListener: (t: string, h: Function) => { docListeners[t] = h },
    }
    const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    const MX = {
      esc, age: () => "1h ago", plural: (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`,
      fields: (pairs: unknown[][]) => pairs.map((p) => `${esc(p[0])}:${esc(p[1])}`).join(";"),
      section: (t: string, h: string) => `<h3>${t}</h3>${h}`,
      open: (_k: string, _t: string, html: string) => { opened.push(html) },
    }
    const body = MESH_ROUTINES_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "")
    new Function("document", "MX", "localStorage", body)(document, MX, { getItem: () => null, setItem: () => {} })

    const routines = build({
      crons: [job("broken")],
      runs: { broken: [cronRun("broken", 0.5, "failed", "<b>boom</b>"), cronRun("broken", 1.5, "failed"), cronRun("broken", 2.5, "failed")] },
      workflows: [hookWorkflow("triage")],
      workflowRuns: [wfRun("triage", 1)],
    })
    docListeners["mx:snapshot"]({ detail: { ts: iso(NOW), nodes: [
      { name: "node-a", reachable: true, routines },
      { name: "node-b", reachable: false, error: "unreachable" },
      { name: "node-c", reachable: true },
    ] } })

    expect(root.innerHTML).toContain('data-attn="critical"')
    expect(root.innerHTML).toContain("Failing x3")
    expect(root.innerHTML).toContain("on:gitlab-issue")
    expect(root.innerHTML).toContain("Routines unknown while this node is unreachable")
    expect(root.innerHTML).toContain("does not report routines yet")
    expect(count.textContent).toBe("2 routines · 1 flagged")

    root.listeners.click({ target: { closest: () => ({ dataset: { rt: "0" } }) } })
    expect(opened[0]).toContain("cron:broken")
    expect(opened[0]).toContain("&#60;b&#62;boom")
  })
})
