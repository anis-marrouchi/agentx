import { describe, it, expect } from "vitest"
import { IdleRestartScheduler, applyRestartPolicy, nextWindowMs, type RestartPolicy } from "../src/daemon/restart"
import { handleRestartApi, type RestartApiContext } from "../src/daemon/restart-api"

// A deploy script could ask for "restart when idle" with onTimeout
// "restart" and cut long tasks off after the wait. shutdown.restart lets
// the operator forbid that, hold requests from unnamed requesters until a
// daily window, and see the runs a restart would cut. This used to live
// in an external guard script.

const policy: RestartPolicy = { allowBy: "^(operator|restart-window)", window: "03:00", windowWaitMinutes: 180, forbidOnTimeoutRestart: true }
const noon = new Date(2026, 8, 29, 12, 0, 0).getTime()

describe("nextWindowMs", () => {
  it("is the next occurrence of the local time, tomorrow when it has passed today", () => {
    const at = new Date(nextWindowMs("03:00", noon))
    expect([at.getHours(), at.getMinutes()]).toEqual([3, 0])
    expect(at.getTime()).toBeGreaterThan(noon)
    expect(at.getTime() - noon).toBeLessThan(24 * 3600_000)
    const later = new Date(nextWindowMs("15:30", noon))
    expect(later.getDate()).toBe(new Date(noon).getDate())
  })
  it("rejects anything but HH:MM", () => {
    expect(() => nextWindowMs("3pm", noon)).toThrow(/HH:MM/)
  })
})

describe("applyRestartPolicy", () => {
  it("without a policy the request is taken as is", () => {
    expect(applyRestartPolicy({ by: "deploy", onTimeout: "restart" }, undefined, noon)).toEqual({ action: "allow", onTimeout: "restart", forced: false })
  })
  it("forbidOnTimeoutRestart turns a forced restart into an idle-only wait", () => {
    expect(applyRestartPolicy({ by: "operator", onTimeout: "restart" }, policy, noon)).toEqual({ action: "allow", onTimeout: "abort", forced: true })
    expect(applyRestartPolicy({ by: "operator", onTimeout: "abort" }, policy, noon)).toMatchObject({ action: "allow", forced: false })
  })
  it("holds an unnamed requester until the window, idle-only", () => {
    const d = applyRestartPolicy({ by: "deploy f884498", onTimeout: "restart" }, policy, noon)
    expect(d.action).toBe("defer")
    if (d.action !== "defer") return
    expect(d.onTimeout).toBe("abort")
    expect(d.timeoutMs).toBe(180 * 60_000)
    expect(new Date(d.untilMs).getHours()).toBe(3)
  })
  it("refuses an unnamed requester when there is no window", () => {
    const d = applyRestartPolicy({ by: "deploy", onTimeout: "abort" }, { ...policy, window: undefined }, noon)
    expect(d).toMatchObject({ action: "refuse" })
  })
  it("a broken regular expression allows nobody rather than everybody", () => {
    expect(applyRestartPolicy({ by: "operator", onTimeout: "abort" }, { ...policy, allowBy: "(" , window: undefined }, noon)).toMatchObject({ action: "refuse" })
  })
})

describe("IdleRestartScheduler.defer", () => {
  function make(inflight: () => number) {
    let now = noon
    const fired: string[] = []
    const s = new IdleRestartScheduler({
      inflight, fire: (reason) => fired.push(reason), now: () => now, setInterval: () => 1, clearInterval: () => {},
    })
    return { s, fired, advance: (ms: number) => { now += ms } }
  }
  it("waits for the window, then runs an idle wait that gives up rather than restarting", () => {
    const { s, fired, advance } = make(() => 1)
    const until = noon + 60_000
    expect(s.defer({ requestedBy: "deploy", untilMs: until, timeoutMs: 30_000, onTimeout: "abort" }).state).toBe("deferred")
    s.tick()
    expect(s.state().state).toBe("deferred")
    advance(60_000); s.tick()
    expect(s.state()).toMatchObject({ state: "pending", onTimeout: "abort", requestedBy: "deploy" })
    advance(31_000); s.tick()
    expect(s.state()).toMatchObject({ state: "none", last: { outcome: "timeout-aborted" } })
    expect(fired).toEqual([])
  })
  it("restarts once the window's wait sees the daemon idle", () => {
    let busy = 1
    const { s, fired, advance } = make(() => busy)
    s.defer({ requestedBy: "deploy", untilMs: noon + 1, timeoutMs: 600_000, onTimeout: "abort" })
    advance(2); s.tick()
    busy = 0
    for (let i = 0; i < 5; i++) s.tick()
    expect(fired).toEqual(["idle"])
  })
  it("can be cancelled while deferred, and a second request does not replace it", () => {
    const { s } = make(() => 0)
    s.defer({ requestedBy: "deploy", untilMs: noon + 1000, timeoutMs: 1000, onTimeout: "abort" })
    expect(s.schedule({ requestedBy: "other", timeoutMs: 1000, onTimeout: "restart" }).state).toBe("deferred")
    expect(s.cancel()).toBe(true)
    expect(s.state().state).toBe("none")
  })
})

describe("POST /daemon/restart with a policy", () => {
  const running = [{ agentId: "a", taskId: "t1", channel: "gitlab", chatId: "mr:1", step: "agent", ageSeconds: 540 }]
  function ctx(p?: RestartPolicy): RestartApiContext {
    const scheduler = new IdleRestartScheduler({ inflight: () => 1, fire: () => {}, now: () => noon, setInterval: () => 1, clearInterval: () => {} })
    return {
      scheduler, policy: p, now: () => noon,
      inflight: () => ({ local: 1, meshForwards: 0, total: 1 }),
      running: () => running,
      service: () => ({ service: { kind: "none" } as any, plan: { ok: true, how: "launchd brings it back", exitCode: 0 } as any }),
      pid: 1, cwd: "/x",
    }
  }
  it("lists the runs a restart would cut, on GET and on every POST reply", () => {
    const c = ctx(policy)
    expect((handleRestartApi("GET", "/daemon/restart", {}, c).body as any).running).toEqual(running)
    const r = handleRestartApi("POST", "/daemon/restart", { by: "operator", onTimeout: "abort" }, c)
    expect((r.body as any).running).toEqual(running)
  })
  it("forces an idle-only wait and says so", () => {
    const r = handleRestartApi("POST", "/daemon/restart", { by: "operator", onTimeout: "restart" }, ctx(policy))
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ state: "pending", onTimeout: "abort", onTimeoutForced: "abort" })
  })
  it("defers a deploy script to the window", () => {
    const r = handleRestartApi("POST", "/daemon/restart", { by: "deploy f884498" }, ctx(policy))
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ state: "deferred", onTimeout: "abort" })
    expect(String((r.body as any).deferred)).toMatch(/held until 03:00/)
  })
  it("refuses when held with no window", () => {
    const r = handleRestartApi("POST", "/daemon/restart", { by: "deploy" }, ctx({ ...policy, window: undefined }))
    expect(r.status).toBe(403)
    expect((r.body as any).running).toEqual(running)
  })
  it("cancel drops a deferred request", () => {
    const c = ctx(policy)
    handleRestartApi("POST", "/daemon/restart", { by: "deploy" }, c)
    expect(handleRestartApi("POST", "/daemon/restart/cancel", {}, c).status).toBe(200)
  })
})
