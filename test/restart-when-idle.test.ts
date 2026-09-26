import { describe, expect, it, vi } from "vitest"
import {
  IdleRestartScheduler, RESTART_EXIT_CODE, cliRestartPlan, describeService, launchdRespawn, manualRestartCommand,
  parseLaunchctlList, parseLaunchctlPrint, parseSystemdCgroup, planSelfRestart, systemdRespawn, waitForIdle,
  type ServiceInfo,
} from "../src/daemon/restart"
import { handleRestartApi, type RestartApiContext } from "../src/daemon/restart-api"
import { detectService } from "../src/daemon/restart-host"

// Nothing here restarts, signals or even queries a real service manager.

const LAUNCHD: ServiceInfo = { kind: "launchd", label: "com.example.agentx", domain: "gui/501" }
const SYSTEMD: ServiceInfo = { kind: "systemd", unit: "agentx.service", scope: "system" }
const SYSTEMD_USER: ServiceInfo = { kind: "systemd", unit: "agentx.service", scope: "user" }
const NONE: ServiceInfo = { kind: "none" }

describe("service-manager detection", () => {
  it("reads the systemd unit from a cgroup v2 file", () => {
    expect(parseSystemdCgroup("0::/system.slice/agentx.service\n")).toEqual({ unit: "agentx.service", scope: "system" })
  })

  it("tells a user unit from a system one", () => {
    const text = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentx.service\n"
    expect(parseSystemdCgroup(text)).toEqual({ unit: "agentx.service", scope: "user" })
  })

  it("reads the name=systemd line of a cgroup v1 file", () => {
    const text = "12:memory:/system.slice/agentx.service\n1:name=systemd:/system.slice/agentx.service\n"
    expect(parseSystemdCgroup(text)).toEqual({ unit: "agentx.service", scope: "system" })
  })

  it("a daemon started from a login shell is not a service", () => {
    expect(parseSystemdCgroup("0::/user.slice/user-1000.slice/session-3.scope\n")).toBeNull()
    expect(parseSystemdCgroup("0::/user.slice/user-1000.slice/user@1000.service\n")).toBeNull()
    expect(parseSystemdCgroup("0::/\n")).toBeNull()
    expect(parseSystemdCgroup("")).toBeNull()
  })

  it("finds the launchd label by PID in `launchctl list`", () => {
    const out = "PID\tStatus\tLabel\n-\t0\tcom.example.other\n4242\t0\tcom.example.agentx\n77\t0\tcom.example.x\n"
    expect(parseLaunchctlList(out, 4242)).toBe("com.example.agentx")
    expect(parseLaunchctlList(out, 42)).toBeNull()
  })

  it("reads the settings file and PID from `launchctl print`", () => {
    const out = "gui/501/com.example.agentx = {\n\tactive count = 1\n\tpath = /Users/demo/Library/LaunchAgents/com.example.agentx.plist\n\tstate = running\n\tpid = 4242\n\tendpoints = {\n\t\tpath = /ignored\n\t}\n}\n"
    expect(parseLaunchctlPrint(out)).toEqual({ path: "/Users/demo/Library/LaunchAgents/com.example.agentx.plist", pid: 4242 })
  })

  it("on an unsupported platform nothing is run and the answer is none", () => {
    expect(detectService(process.pid, "win32")).toEqual({ kind: "none" })
    expect(detectService(999_999_999, "linux")).toEqual({ kind: "none" })
  })

  it("describes each kind for people", () => {
    expect(describeService(LAUNCHD)).toBe("launchd job com.example.agentx")
    expect(describeService(SYSTEMD_USER)).toBe("systemd user unit agentx.service")
    expect(describeService(NONE)).toMatch(/no service manager/)
  })
})

describe("would the service manager start it again", () => {
  it("launchd KeepAlive", () => {
    expect(launchdRespawn(true)).toMatchObject({ onCleanExit: true, onErrorExit: true })
    expect(launchdRespawn({ SuccessfulExit: false })).toMatchObject({ onCleanExit: false, onErrorExit: true })
    expect(launchdRespawn({ SuccessfulExit: true })).toMatchObject({ onCleanExit: true, onErrorExit: false })
    expect(launchdRespawn({ NetworkState: true })).toMatchObject({ onCleanExit: false, onErrorExit: false })
    expect(launchdRespawn(false)).toMatchObject({ onCleanExit: false, onErrorExit: false })
    expect(launchdRespawn(undefined)).toMatchObject({ onCleanExit: false, onErrorExit: false })
  })

  it("systemd Restart=", () => {
    expect(systemdRespawn("always\n")).toMatchObject({ onCleanExit: true, onErrorExit: true })
    expect(systemdRespawn("on-failure")).toMatchObject({ onCleanExit: false, onErrorExit: true })
    expect(systemdRespawn("on-success")).toMatchObject({ onCleanExit: true, onErrorExit: false })
    for (const r of ["no", "on-abnormal", "on-abort", "on-watchdog", ""]) {
      expect(systemdRespawn(r)).toMatchObject({ onCleanExit: false, onErrorExit: false })
    }
  })

  it("exits 0 when a clean exit brings it back", () => {
    expect(planSelfRestart(LAUNCHD, launchdRespawn(true))).toMatchObject({ ok: true, exitCode: 0 })
  })

  it("exits with an error code when only a failure brings it back", () => {
    expect(planSelfRestart(SYSTEMD, systemdRespawn("on-failure"))).toMatchObject({ ok: true, exitCode: RESTART_EXIT_CODE })
  })

  it("refuses when nothing would bring it back", () => {
    const none = planSelfRestart(NONE, null)
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.reason).toMatch(/agentx daemon restart --when-idle/)
    const off = planSelfRestart(SYSTEMD, systemdRespawn("no"))
    expect(off.ok).toBe(false)
    if (!off.ok) expect(off.reason).toMatch(/Restart=no/)
    const unknown = planSelfRestart(LAUNCHD, null)
    expect(unknown.ok).toBe(false)
  })
})

describe("cliRestartPlan", () => {
  const base = { isRoot: false, reloadService: false, interactive: true }

  it("launchd: SIGTERM so the daemon drains, never kickstart -k", () => {
    const p = cliRestartPlan(LAUNCHD, base)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.steps).toEqual([
      { kind: "exec", argv: ["launchctl", "kill", "SIGTERM", "gui/501/com.example.agentx"] },
      { kind: "wait-exit" },
      { kind: "exec", argv: ["launchctl", "kickstart", "gui/501/com.example.agentx"], mayFail: true },
    ])
    expect(JSON.stringify(p.steps)).not.toContain("-k")
  })

  it("launchd with a settings change: bootout, wait until unloaded, then bootstrap", () => {
    const plist = "/Users/demo/Library/LaunchAgents/com.example.agentx.plist"
    const p = cliRestartPlan(LAUNCHD, { ...base, reloadService: true, plistPath: plist })
    expect(p.ok && p.steps.map((s) => s.kind)).toEqual(["exec", "wait-exit", "wait-unloaded", "exec"])
    if (p.ok) expect(p.steps[3]).toEqual({ kind: "exec", argv: ["launchctl", "bootstrap", "gui/501", plist] })
    expect(cliRestartPlan(LAUNCHD, { ...base, reloadService: true, plistPath: null }).ok).toBe(false)
  })

  it("systemd system unit: sudo when not root, non-interactive without a terminal", () => {
    const p = cliRestartPlan(SYSTEMD, base)
    expect(p.ok && p.steps).toEqual([{ kind: "exec", argv: ["sudo", "systemctl", "restart", "agentx.service"] }])
    const q = cliRestartPlan(SYSTEMD, { ...base, interactive: false })
    expect(q.ok && q.steps).toEqual([{ kind: "exec", argv: ["sudo", "-n", "systemctl", "restart", "agentx.service"] }])
    const root = cliRestartPlan(SYSTEMD, { ...base, isRoot: true, reloadService: true })
    expect(root.ok && root.steps).toEqual([
      { kind: "exec", argv: ["systemctl", "daemon-reload"] },
      { kind: "exec", argv: ["systemctl", "restart", "agentx.service"] },
    ])
    expect(p.manual).toBe("sudo systemctl restart agentx.service")
  })

  it("systemd user unit: no sudo", () => {
    const p = cliRestartPlan(SYSTEMD_USER, { ...base, reloadService: true })
    expect(p.ok && p.steps).toEqual([
      { kind: "exec", argv: ["systemctl", "--user", "daemon-reload"] },
      { kind: "exec", argv: ["systemctl", "--user", "restart", "agentx.service"] },
    ])
    expect(manualRestartCommand(SYSTEMD_USER)).toBe("systemctl --user restart agentx.service")
  })

  it("plain daemon: stop, wait for exit, start detached", () => {
    const p = cliRestartPlan(NONE, base)
    expect(p.ok && p.steps.map((s) => s.kind)).toEqual(["sigterm", "wait-exit", "start-detached"])
  })
})

/** A clock that only moves when the waiter sleeps. */
function fakeClock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe("waitForIdle", () => {
  it("is idle after two zero readings in a row", async () => {
    const c = fakeClock()
    const counts = [2, 1, 0, 0]
    const r = await waitForIdle({ read: async () => counts.shift()!, intervalMs: 1000, timeoutMs: 60_000, ...c })
    expect(r).toEqual({ outcome: "idle", waitedMs: 3000 })
  })

  it("a task starting between two zeros resets the count", async () => {
    const c = fakeClock()
    const counts = [0, 1, 0, 0]
    const seen: Array<number | null> = []
    const r = await waitForIdle({ read: async () => counts.shift()!, intervalMs: 1000, timeoutMs: 60_000, onCheck: (n) => seen.push(n), ...c })
    expect(r.outcome).toBe("idle")
    expect(seen).toEqual([0, 1, 0, 0])
  })

  it("times out with the last count", async () => {
    const c = fakeClock()
    const r = await waitForIdle({ read: async () => 3, intervalMs: 1000, timeoutMs: 5000, ...c })
    expect(r).toEqual({ outcome: "timeout", waitedMs: 5000, inflight: 3 })
  })

  it("a zero timeout checks once", async () => {
    const c = fakeClock()
    const read = vi.fn(async () => 0)
    const r = await waitForIdle({ read, intervalMs: 1000, timeoutMs: 0, ...c })
    expect(r.outcome).toBe("timeout")
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("gives up when the daemon stops answering", async () => {
    const c = fakeClock()
    const counts: Array<number | null> = [0, null, null, null]
    const r = await waitForIdle({ read: async () => counts.shift() ?? null, intervalMs: 1000, timeoutMs: 60_000, ...c })
    expect(r.outcome).toBe("unreachable")
  })

  it("one missed reading does not count as idle", async () => {
    const c = fakeClock()
    const counts: Array<number | null> = [0, null, 0, 0]
    const r = await waitForIdle({ read: async () => counts.shift() ?? null, intervalMs: 1000, timeoutMs: 60_000, ...c })
    expect(r).toEqual({ outcome: "idle", waitedMs: 3000 })
  })
})

function scheduler(inflight: () => number) {
  let t = 1_000_000
  const fire = vi.fn()
  const clear = vi.fn()
  const s = new IdleRestartScheduler({
    inflight, fire, now: () => t,
    setInterval: () => "timer", clearInterval: clear,
  })
  return { s, fire, clear, advance: (ms: number) => { t += ms } }
}

describe("IdleRestartScheduler (the daemon's own restart when idle)", () => {
  it("fires once, after two idle checks", () => {
    let n = 1
    const { s, fire, clear } = scheduler(() => n)
    s.schedule({ requestedBy: "the dashboard", timeoutMs: 60_000, onTimeout: "restart" })
    expect(s.state().state).toBe("pending")
    s.tick()
    n = 0
    s.tick()
    expect(fire).not.toHaveBeenCalled()
    s.tick()
    expect(fire).toHaveBeenCalledWith("idle", { requestedBy: "the dashboard" })
    expect(s.state().state).toBe("restarting")
    expect(clear).toHaveBeenCalledWith("timer")
    s.tick()
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it("restarts anyway at the deadline when asked to", () => {
    const { s, fire, advance } = scheduler(() => 2)
    s.schedule({ requestedBy: "x", timeoutMs: 10_000, onTimeout: "restart" })
    s.tick()
    advance(10_000)
    s.tick()
    expect(fire).toHaveBeenCalledWith("timeout", { requestedBy: "x" })
  })

  it("gives up at the deadline with onTimeout=abort", () => {
    const { s, fire, advance } = scheduler(() => 2)
    s.schedule({ requestedBy: "x", timeoutMs: 10_000, onTimeout: "abort" })
    advance(10_000)
    s.tick()
    expect(fire).not.toHaveBeenCalled()
    expect(s.state()).toMatchObject({ state: "none", last: { outcome: "timeout-aborted" } })
  })

  it("cancel drops a pending request; a second schedule keeps the first", () => {
    const { s, fire } = scheduler(() => 0)
    const first = s.schedule({ requestedBy: "a", timeoutMs: 1000, onTimeout: "restart" })
    expect(s.schedule({ requestedBy: "b", timeoutMs: 5, onTimeout: "abort" })).toEqual(first)
    expect(s.cancel()).toBe(true)
    expect(s.cancel()).toBe(false)
    s.tick(); s.tick()
    expect(fire).not.toHaveBeenCalled()
    expect(s.state()).toMatchObject({ state: "none", last: { outcome: "cancelled" } })
  })
})

describe("restart API", () => {
  function ctx(plan: RestartApiContext["service"] extends () => infer R ? R["plan"] : never, inflight = 0): RestartApiContext {
    return {
      scheduler: scheduler(() => inflight).s,
      inflight: () => ({ local: inflight, meshForwards: 0, total: inflight }),
      service: () => ({ service: LAUNCHD, plan }),
      pid: 4242,
      cwd: "/srv/agentx",
    }
  }
  const ok = { ok: true as const, exitCode: 0, how: "launchd job com.example.agentx restarts it" }

  it("refuses when nothing would start the daemon again", () => {
    const r = handleRestartApi("POST", "/daemon/restart", {}, ctx({ ok: false, reason: "nothing would start it" }))
    expect(r).toEqual({ status: 409, body: { error: "nothing would start it" } })
  })

  it("schedules, then reports the existing request", () => {
    const c = ctx(ok, 1)
    const a = handleRestartApi("POST", "/daemon/restart", { timeoutMinutes: 10, by: "the dashboard" }, c)
    expect(a.status).toBe(202)
    expect(a.body).toMatchObject({ state: "pending", requestedBy: "the dashboard", onTimeout: "restart" })
    const b = handleRestartApi("POST", "/daemon/restart", {}, c)
    expect(b.status).toBe(200)
    const g = handleRestartApi("GET", "/daemon/restart", {}, c)
    expect(g.body).toMatchObject({ pid: 4242, state: "pending", inflight: { total: 1 }, service: LAUNCHD })
  })

  it("validates input", () => {
    expect(handleRestartApi("POST", "/daemon/restart", { onTimeout: "later" }, ctx(ok)).status).toBe(400)
    expect(handleRestartApi("POST", "/daemon/restart", { timeoutMinutes: -1 }, ctx(ok)).status).toBe(400)
    expect(handleRestartApi("DELETE", "/daemon/restart", {}, ctx(ok)).status).toBe(405)
  })

  it("cancel answers 409 when nothing is waiting", () => {
    const c = ctx(ok)
    expect(handleRestartApi("POST", "/daemon/restart/cancel", {}, c).status).toBe(409)
    handleRestartApi("POST", "/daemon/restart", {}, c)
    expect(handleRestartApi("POST", "/daemon/restart/cancel", {}, c).status).toBe(200)
  })
})
