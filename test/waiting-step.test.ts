// retro:01M8AG6YTMQG790EQXF01DFG00: a run that ends "waiting until <time>"
// on a plan step it owns files the step's wait (requests/waiting-step.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { PlanStore } from "../src/requests/plan-store"
import { DEFAULT_PLAN_SETTINGS } from "../src/requests/plans"
import { reportStep, runPlansSweep } from "../src/requests/plan-sweep"
import { fileWaitingStep, waitingTime, type WaitingStepMode } from "../src/requests/waiting-step"
import { requestsConfigSchema } from "../src/daemon/config"

const MIN = 60_000
// 2026-11-25T23:19:31Z: the end of run 01M8AG3BMA3VHPXWT8V4CFMTBV, the
// run before the nudge of req-01M8A6FB3JZ4YKYS410K8S0VEQ step 3.
const RUN_END = Date.parse("2026-11-25T23:19:31Z")
const MIDNIGHT = Date.parse("2026-11-26T00:00:00Z")

let tmp: string
let db: Database.Database
let requests: RequestStore
let plans: PlanStore
let clock: number
let logs: string[]
let signals: Array<{ agentId: string; ref: string; detail: string }>

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-waiting-step-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  requests = new RequestStore(db)
  plans = new PlanStore(db)
  clock = Date.parse("2026-11-25T22:18:00Z")
  logs = []
  signals = []
  // The replayed request: 3 steps, steps 1-2 done, step 3 is pm-agent's.
  requests.addCandidate({ id: "req-1", runId: "run-0", channel: "a2a", chatId: "c", agentId: "pm-agent", text: "Put the fix live, watch it, check the Hub", now: clock - 60 * MIN })
  requests.progress("req-1", clock - 60 * MIN)
  plans.create("req-1", "pm-agent", [
    { name: "DevOps puts the fix on Mac and clawd", kind: "deploy", agentId: "devops-agent", doneWhen: "release live", needsApproval: false },
    { name: "Dev Session watches the machines view", kind: "task", agentId: "dev-session", doneWhen: "watched", needsApproval: false },
    { name: "Hakim checks machines view on Mac Hub", kind: "verify", agentId: "pm-agent", doneWhen: "checked live", needsApproval: false },
  ], clock - 60 * MIN)
  plans.updateStep("req-1", 1, { state: "done", evidence: "x" })
  plans.updateStep("req-1", 2, { state: "done", evidence: "y" })
  plans.updateStep("req-1", 3, { state: "active", dispatchedAt: clock, updatedAt: clock })
  // pm-agent's last report on step 3, 22:50Z (as in the real log).
  clock = Date.parse("2026-11-25T22:50:23Z")
  expect(reportStep(requests, plans, { requestId: "req-1", step: 3, status: "progress", agentId: "pm-agent", note: "PR sent to DevOps" }, clock)).toBeNull()
  // The run that ended waiting is linked to the request.
  requests.link("req-1", "run", "run-1", clock)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const deps = (mode: WaitingStepMode) => ({
  requests, plans, mode: () => mode, now: () => clock,
  log: (l: string) => { logs.push(l) },
  signal: (agentId: string, ref: string, detail: string) => { signals.push({ agentId, ref, detail }) },
})
const run = (reply: string, over: Record<string, unknown> = {}) => ({
  agentId: "pm-agent", runIds: ["run-1"], startedAt: RUN_END - 10_000, reply, ...over,
})

describe("waitingTime", () => {
  const now = RUN_END
  it("reads a clock time in until as the next one, UTC", () => {
    expect(waitingTime({ on: "devops", until: "00:00Z" }, now)).toBe(MIDNIGHT)
    expect(waitingTime({ on: "devops", until: "23:30" }, now)).toBe(Date.parse("2026-11-25T23:30:00Z"))
    expect(waitingTime({ on: "devops", until: "23:00Z" }, now)).toBe(Date.parse("2026-11-26T23:00:00Z"))
  })
  it("reads a full ISO time in until, or else the last one in the text", () => {
    expect(waitingTime({ on: "x", until: "2026-11-27T10:00Z" }, now)).toBe(Date.parse("2026-11-27T10:00:00Z"))
    expect(waitingTime({ on: "the Mac upgrade (gives up at about 23:59Z); my check is at 2026-11-26T00:00Z (prm-1)" }, now)).toBe(MIDNIGHT)
  })
  it("has no time for words", () => {
    expect(waitingTime({ on: "devops", until: "tomorrow" }, now)).toBeNull()
    expect(waitingTime({ on: "devops review" }, now)).toBeNull()
    expect(waitingTime({ on: "x", until: "25:00" }, now)).toBeNull()
  })
})

describe("fileWaitingStep (retro:01M8AG6YTMQG790EQXF01DFG00)", () => {
  const REPLY = "Mac still on 0.273.2.\n\nState: waiting — devops, until 00:00Z"

  it("on: files progress with waitUntil 00:00Z on the owned step", () => {
    clock = RUN_END
    expect(fileWaitingStep(deps("on"), run(REPLY))).toBe("filed")
    expect(plans.step("req-1", 3)).toMatchObject({ state: "active", waitUntil: MIDNIGHT })
    const last = plans.events("req-1").at(-1)!
    expect(last).toMatchObject({ step: 3, kind: "progress" })
    expect(last.detail).toContain("waits until 2026-11-26T00:00:00.000Z")
    expect(signals).toHaveLength(0)
  })

  it("warn: changes nothing, logs and records one warn signal", () => {
    clock = RUN_END
    const before = plans.events("req-1").length
    expect(fileWaitingStep(deps("warn"), run(REPLY))).toBe("warned")
    expect(plans.step("req-1", 3)).toMatchObject({ waitUntil: null })
    expect(plans.events("req-1")).toHaveLength(before)
    expect(signals).toEqual([{ agentId: "pm-agent", ref: "req-1#3", detail: expect.stringContaining("until 2026-11-26T00:00:00.000Z") }])
    expect(logs.join("\n")).toMatch(/would file step req-1#3 progress, waits until 2026-11-26T00:00:00.000Z \(warn\)/)
  })

  it("does nothing when the run already reported on the step", () => {
    clock = RUN_END - 5_000
    reportStep(requests, plans, { requestId: "req-1", step: 3, status: "progress", agentId: "pm-agent", note: "still waiting" }, clock)
    clock = RUN_END
    expect(fileWaitingStep(deps("on"), run(REPLY))).toBe("already-filed")
    expect(plans.step("req-1", 3)).toMatchObject({ waitUntil: null })
    expect(fileWaitingStep(deps("warn"), run(REPLY))).toBe("already-filed")
    expect(signals).toHaveLength(0)
  })

  it("does nothing with no time, only a log line", () => {
    clock = RUN_END
    expect(fileWaitingStep(deps("on"), run("State: waiting — devops review"))).toBe("no-time")
    expect(plans.step("req-1", 3)).toMatchObject({ waitUntil: null })
    expect(logs.join("\n")).toMatch(/no time/)
  })

  it("does nothing off, not waiting, past, or on a run not linked to the step", () => {
    clock = RUN_END
    expect(fileWaitingStep(deps("off"), run(REPLY))).toBe("off")
    expect(fileWaitingStep(deps("on"), run("State: done — https://x/1"))).toBe("not-waiting")
    expect(fileWaitingStep(deps("on"), run("State: waiting — devops, until 2026-11-25T20:00Z"))).toBe("past")
    expect(fileWaitingStep(deps("on"), run(REPLY, { runIds: ["other-run"] }))).toBe("no-step")
    expect(fileWaitingStep(deps("on"), run(REPLY, { agentId: "dev-session" }))).toBe("no-step")
    expect(plans.step("req-1", 3)).toMatchObject({ waitUntil: null })
  })

  it("uses the state the registry read (tool) before the reply's line", () => {
    clock = RUN_END
    expect(fileWaitingStep(deps("on"), run("no line", { jobState: { state: "waiting", on: "devops", until: "00:00Z" } }))).toBe("filed")
    expect(plans.step("req-1", 3)).toMatchObject({ waitUntil: MIDNIGHT })
  })

  it("caps the wait at 7 days", () => {
    clock = RUN_END
    expect(fileWaitingStep(deps("on"), run("State: waiting — devops, until 2026-12-20T00:00Z"))).toBe("filed")
    expect(plans.step("req-1", 3)!.waitUntil).toBe(RUN_END + 7 * 24 * 60 * MIN)
  })

  it("defaults to warn in the config", () => {
    expect(requestsConfigSchema.parse({}).waitingStep).toEqual({ mode: "warn" })
  })
})

describe("replay: req-01M8A6FB3JZ4YKYS410K8S0VEQ step 3, run 01M8AG3BMA3VHPXWT8V4CFMTBV", () => {
  // The run's real last line (task_traces.final_response, 2026-11-25 23:19:31Z).
  const REAL = "Nothing is needed from you.\n\nState: waiting — on the Mac upgrade to 0.274.0 (DevOps job, gives up at about 23:59Z); my check is at 2026-11-26T00:00Z (prm-mwwq7wdy-39ea27)."
  const sweepAt = async (at: number) => {
    const told: string[] = []
    const res = await runPlansSweep({
      requests, plans, settings: { ...DEFAULT_PLAN_SETTINGS },
      tellAgent: async (agentId) => { told.push(agentId) },
      send: async () => {}, notify: async () => {}, hasAgent: () => true,
      fetch: (async () => new Response("down", { status: 503 })) as any,
      log: () => {}, now: at,
    } as any)
    return { res, told }
  }

  it("before: the sweep at 23:21Z (31 min quiet) nudges pm-agent", async () => {
    const { res, told } = await sweepAt(Date.parse("2026-11-25T23:21:17Z"))
    expect(res.nudged).toBe(1)
    expect(told).toEqual(["pm-agent"])
  })

  it("on: step 3 waits until 00:00Z and no nudge fires at 31 min, nor before midnight", async () => {
    clock = RUN_END
    expect(fileWaitingStep(deps("on"), { agentId: "pm-agent", runIds: ["run-1"], startedAt: Date.parse("2026-11-25T23:19:21Z"), reply: REAL })).toBe("filed")
    expect(plans.step("req-1", 3)).toMatchObject({ waitUntil: MIDNIGHT })
    expect(plans.events("req-1").at(-1)!.detail).toContain("waits until 2026-11-26T00:00:00.000Z")
    for (const at of ["2026-11-25T23:21:17Z", "2026-11-25T23:50:31Z", "2026-11-25T23:59:59Z", "2026-11-26T00:29:00Z"]) {
      const { res, told } = await sweepAt(Date.parse(at))
      expect(res.nudged, at).toBe(0)
      expect(told, at).toEqual([])
    }
    // After the wait the stall time counts from it.
    expect((await sweepAt(Date.parse("2026-11-26T00:31:00Z"))).res.nudged).toBe(1)
  })

  it("warn: the step is left as it is, so the 23:21Z nudge still fires", async () => {
    clock = RUN_END
    expect(fileWaitingStep(deps("warn"), { agentId: "pm-agent", runIds: ["run-1"], startedAt: Date.parse("2026-11-25T23:19:21Z"), reply: REAL })).toBe("warned")
    expect((await sweepAt(Date.parse("2026-11-25T23:21:17Z"))).res.nudged).toBe(1)
  })
})
