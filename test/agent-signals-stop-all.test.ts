import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DEFAULT_SIGNAL_SETTINGS, type SignalSettings } from "../src/agents/signals/policy"
import { SignalService, stopAllReport, type RunningRef, type SignalServiceDeps } from "../src/agents/signals/service"
import { StoppedTaskStore } from "../src/agents/signals/store"
import { handleSignalsHttp } from "../src/daemon/signals-api"
import { isControlPost } from "../src/daemon/mesh-auth"
import { DEFAULT_RESUME_SETTINGS, planResume } from "../src/agents/resume/policy"
import type { InterruptedRun } from "../src/storage/traces"

// Fleet stop-all (#1271). What must hold:
//   - one owner order stops every running task, and each writes its plan;
//   - an agent cannot give the order; a peer only when allowPeers names it;
//   - the next boot resumes every stop-all task from its plan, once, with no
//     age limit, and a failed attempt is reported and never tried again;
//   - the owner's order with `mesh` goes to every healthy peer, one hop,
//     and `wait` says whether it is safe to restart.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-stop-all-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const run = (n: number, over: Partial<RunningRef> = {}): RunningRef => ({
  taskId: `run-${n}`,
  traceId: `trace-${n}`,
  agentId: `agent-${n}`,
  channel: "telegram",
  chatId: String(n),
  rootId: `root-${n}`,
  originalMessage: `Task ${n}`,
  origin: { kind: "router", adapter: "telegram", message: { id: `m${n}` } },
  ...over,
})

function harness(over: Partial<SignalServiceDeps> & { s?: Partial<SignalSettings>; runs?: RunningRef[]; now?: () => number } = {}) {
  let running = over.runs ?? [run(1), run(2), run(3)]
  const resumed: Array<{ id: string; note: string }> = []
  const events: string[] = []
  const deps: SignalServiceDeps = {
    settings: () => ({ ...DEFAULT_SIGNAL_SETTINGS, ...over.s }),
    store: new StoppedTaskStore(dir),
    findRunning: (by) => running.find((r) => r.taskId === by.taskId) ?? null,
    listRunning: () => [...running],
    stopRun: (taskId) => { running = running.filter((r) => r.taskId !== taskId); return true },
    whenRunEnds: async () => {},
    toolCalls: () => [],
    windDown: async ({ agentId }) => ({ content: `Done: half.\nLeft: rest of ${agentId}.\nNext action: go on.\nHalf-applied: nothing` }),
    resume: async ({ record, note }) => { resumed.push({ id: record.id, note }) },
    publish: (e) => { events.push(e.type) },
    log: () => {},
    ...over,
  }
  return { service: new SignalService(deps), resumed, events, deps }
}

describe("stop-all order", () => {
  it("stops every running task, and each saves its plan under the order", async () => {
    const h = harness()
    const r = await h.service.stopAll({ kind: "owner" }, "restart for the update")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tasks.map((t) => t.id)).toEqual(["run-1", "run-2", "run-3"])
    const done = await r.done
    expect(done.every((t) => t.state === "stopped" && t.plan === "agent")).toBe(true)
    for (const t of h.service.list({ state: "stopped" })) {
      expect(t.stopAll?.orderId).toBe(r.orderId)
      expect(t.reason).toBe("stop-all: restart for the update")
    }
    expect(h.events).toContain("signal:stop-all")
  })

  it("lists a task stop() refuses, and keeps going", async () => {
    const h = harness({ runs: [run(1, { workflowRunId: "wf-1" }), run(2)] })
    const r = await h.service.stopAll({ kind: "owner" })
    if (!r.ok) throw new Error(r.error)
    expect(r.tasks[0]).toMatchObject({ id: "run-1", state: "refused" })
    expect(r.tasks[0].error).toMatch(/cannot pause here/)
    expect(r.tasks[1]).toMatchObject({ id: "run-2", state: "winding-down" })
  })

  it("is refused for an agent, and for a peer allowPeers does not name", async () => {
    const h = harness({ s: { allowPeers: ["mac"] } })
    expect(await h.service.stopAll({ kind: "agent", agentId: "lead" })).toMatchObject({ ok: false, status: 403 })
    expect(await h.service.stopAll({ kind: "peer", peer: "other" })).toMatchObject({ ok: false, status: 403 })
    const ok = await h.service.stopAll({ kind: "peer", peer: "Mac" })
    expect(ok.ok).toBe(true)
  })

  it("answers with an empty list when nothing runs", async () => {
    const h = harness({ runs: [] })
    const r = await h.service.stopAll({ kind: "owner" })
    if (!r.ok) throw new Error(r.error)
    expect(r.tasks).toEqual([])
    expect(await r.done).toEqual([])
  })
})

describe("resume after the restart", () => {
  it("resumes every stop-all task from its plan, whatever its age, and only once", async () => {
    const h = harness()
    const r = await h.service.stopAll({ kind: "owner" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    // A task stopped by hand is not part of the order: it stays paused.
    const manual = harness({ runs: [run(9)] })
    const m = await manual.service.stop({ kind: "owner" }, { taskId: "run-9" })
    if (m.ok) await m.done

    // A day later, a fresh service on the same folder (the next boot).
    const later = harness({ runs: [], now: () => Date.now() + 24 * 60 * 60 * 1000 })
    const outcomes = await later.service.resumeStopAll()
    expect(outcomes.map((o) => o.decision)).toEqual(["resumed", "resumed", "resumed"])
    expect(later.resumed.map((x) => x.id).sort()).toEqual(["run-1", "run-2", "run-3"])
    expect(later.resumed[0].note).toMatch(/Left: rest of agent-/)
    expect(later.service.get("run-9")?.state).toBe("stopped")
    expect(await later.service.resumeStopAll()).toEqual([])
  })

  it("reports a failed attempt and never tries it again on a later boot", async () => {
    const h = harness({ runs: [run(1)] })
    const r = await h.service.stopAll({ kind: "owner" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    const boot1 = harness({ runs: [], resume: async () => { throw new Error("channel down") } })
    const first = await boot1.service.resumeStopAll()
    expect(first).toMatchObject([{ id: "run-1", decision: "resume-failed" }])
    expect(first[0].reason).toMatch(/channel down/)
    const record = boot1.service.get("run-1")!
    expect(record.state).toBe("stopped")
    expect(record.stopAll?.attemptedAt).toBeTruthy()
    expect(record.stopAll?.error).toMatch(/channel down/)

    // Reported once: later boots neither try it nor list it again.
    const boot2 = harness({ runs: [] })
    expect(await boot2.service.resumeStopAll()).toEqual([])
    expect(boot2.resumed).toEqual([])
    // The owner can still resume it by hand.
    expect((await boot2.service.resume({ kind: "owner" }, "run-1")).ok).toBe(true)
  })

  it("reports an attempt a restart cut off as skipped, on one boot only", async () => {
    const h = harness({ runs: [run(1)] })
    const r = await h.service.stopAll({ kind: "owner" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    const record = h.service.get("run-1")!
    new StoppedTaskStore(dir).save({ ...record, stopAll: { ...record.stopAll!, attemptedAt: "2026-01-01T00:00:00.000Z" } })
    expect(await harness({ runs: [] }).service.resumeStopAll()).toMatchObject([{ id: "run-1", decision: "skipped" }])
    expect(await harness({ runs: [] }).service.resumeStopAll()).toEqual([])
  })

  it("keeps the interrupted-run resume off a stop-all task whose trace was still open", async () => {
    // --no-wait and a quick restart: the wind-down never finished.
    const h = harness({ runs: [run(1), run(2)], whenRunEnds: () => new Promise(() => {}) })
    const r = await h.service.stopAll({ kind: "owner" })
    if (!r.ok) throw new Error(r.error)
    const boot = harness({ runs: [] })
    boot.service.recover()
    const cutOff = (taskId: string): InterruptedRun => ({
      taskId, agentId: "agent-1", channel: "telegram", chatId: "1", workflowRunId: null, startedAt: Date.now(),
      originalMessage: "Task", resumeOrigin: JSON.stringify(run(1).origin), resumeAttempt: 0, toolCalls: [],
    })
    const plans = planResume([cutOff("trace-1"), cutOff("run-2"), cutOff("trace-9")], DEFAULT_RESUME_SETTINGS, {
      now: Date.now(), boots: [],
      handledElsewhere: (x) => { const o = boot.service.stopAllOwner(x.taskId); return o ? `stopped by ${o}` : null },
    })
    expect(plans.map((p) => p.action)).toEqual(["skip", "skip", "resume"])
    expect(plans[0].reason).toBe(`stopped by ${r.orderId}`)
    // Stop-all resumes each of them, once.
    const outcomes = await boot.service.resumeStopAll()
    expect(outcomes.map((o) => [o.id, o.decision])).toEqual([["run-1", "resumed"], ["run-2", "resumed"]])
  })

  it("skips a task with no record of how to re-enter it", async () => {
    const h = harness({ runs: [run(1, { origin: null })] })
    const r = await h.service.stopAll({ kind: "owner" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    const outcomes = await harness({ runs: [] }).service.resumeStopAll()
    expect(outcomes).toMatchObject([{ decision: "skipped", reason: "no record of how to re-enter it" }])
  })
})

describe("the owner's report", () => {
  it("accounts for every task, by agent", () => {
    const text = stopAllReport("mac", [
      { id: "run-2", agentId: "writer", decision: "resume-failed", reason: "resume failed: channel down" },
      { id: "run-1", agentId: "coder", decision: "resumed", reason: "answer goes to the chat" },
      { id: "run-3", agentId: "coder", decision: "skipped", reason: "no record of how to re-enter it" },
    ])!
    expect(text.split("\n")[0]).toBe("After the stop-all on mac: 1 resumed, 1 failed, 1 skipped.")
    expect(text).toMatch(/- coder run-1: resumed\n- coder run-3: skipped \(no record/)
    expect(text).toMatch(/- writer run-2: failed \(resume failed: channel down\)/)
    expect(text).toMatch(/agentx signal resume <id>/)
    expect(stopAllReport("mac", [])).toBeNull()
  })
})

describe("HTTP surface", () => {
  it("is a control post", () => {
    expect(isControlPost("/api/signals/stop-all")).toBe(true)
  })

  it("fans the owner's order out to every peer and waits for the plans", async () => {
    const h = harness({ runs: [run(1)] })
    const sent: Array<{ node: string; body?: Record<string, unknown>; timeoutMs?: number }> = []
    const r = await handleSignalsHttp("POST", "/api/signals/stop-all", new URLSearchParams(), { mesh: true, wait: true, reason: "update" }, {
      service: h.service, selfNode: "mac", sender: { kind: "owner" },
      peers: () => ["clawd", "laptop"],
      forward: async (node, _m, _p, body, timeoutMs) => {
        sent.push({ node, body, timeoutMs })
        if (node === "laptop") return { status: 403, body: { error: 'mesh peer "mac" is not in signals.allowPeers' } }
        return { status: 200, body: { node, tasks: [{ id: "c-1", agentId: "ops", state: "stopped", plan: "machine" }], safeToRestart: true } }
      },
    })
    expect(r.status).toBe(200)
    expect(sent.map((s) => s.node)).toEqual(["clawd", "laptop"])
    expect(sent[0].body).toMatchObject({ reason: "update", wait: true, via: { node: "mac" } })
    expect(sent[0].timeoutMs).toBeGreaterThan(120_000)
    expect((r.body.tasks as any[])[0]).toMatchObject({ id: "run-1", state: "stopped", plan: "agent" })
    expect(r.body.peers).toMatchObject([{ node: "clawd", ok: true }, { node: "laptop", ok: false }])
    expect(r.body.safeToRestart).toBe(false)
  })

  it("is safe to restart once every node saved its plans", async () => {
    const h = harness({ runs: [run(1)] })
    const r = await handleSignalsHttp("POST", "/api/signals/stop-all", new URLSearchParams(), { mesh: true, wait: true }, {
      service: h.service, selfNode: "mac", sender: { kind: "owner" },
      peers: () => ["clawd"],
      forward: async () => ({ status: 200, body: { tasks: [], safeToRestart: true } }),
    })
    expect(r.body.safeToRestart).toBe(true)
  })

  it("is not safe to restart while a task it could not stop still runs", async () => {
    const h = harness({ runs: [run(1, { workflowRunId: "wf-1" }), run(2)] })
    const r = await handleSignalsHttp("POST", "/api/signals/stop-all", new URLSearchParams(), { wait: true }, {
      service: h.service, selfNode: "mac", sender: { kind: "owner" }, forward: async () => null,
    })
    expect((r.body.tasks as any[])[0]).toMatchObject({ id: "run-1", state: "refused" })
    expect(r.body.safeToRestart).toBe(false)
    expect(r.body.message).toMatch(/run-1 could not be stopped/)
  })

  it("never sends a peer's order on, and answers at once without wait", async () => {
    const h = harness({ s: { allowPeers: ["mac"] } })
    let forwarded = 0
    const r = await handleSignalsHttp("POST", "/api/signals/stop-all", new URLSearchParams(), { mesh: true }, {
      service: h.service, selfNode: "clawd", sender: { kind: "peer", peer: "mac" },
      peers: () => ["laptop"],
      forward: async () => { forwarded++; return null },
    })
    expect(r.status).toBe(202)
    expect(forwarded).toBe(0)
    expect(r.body).not.toHaveProperty("peers")
    expect(r.body).not.toHaveProperty("safeToRestart")
  })

  it("refuses an agent", async () => {
    const h = harness()
    const r = await handleSignalsHttp("POST", "/api/signals/stop-all", new URLSearchParams(), {}, {
      service: h.service, selfNode: "mac", sender: { kind: "agent", agentId: "lead" }, forward: async () => null,
    })
    expect(r.status).toBe(403)
  })
})
