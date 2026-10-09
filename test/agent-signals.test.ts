import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { canSignal, DEFAULT_SIGNAL_SETTINGS, SignalBudget, type SignalSettings } from "../src/agents/signals/policy"
import { SignalService, type RunningRef, type SignalServiceDeps } from "../src/agents/signals/service"
import { StoppedTaskStore, summarizeStopped } from "../src/agents/signals/store"
import { agentPlan, machinePlan, resumeNote, windDownMessage } from "../src/agents/signals/plan"
import { ResumeCoordinator } from "../src/agents/resume/coordinator"
import { handleSignalsHttp, peerOfToken, signalSender } from "../src/daemon/signals-api"
import { EventWaker } from "../src/events/wake"
import type { EventEnvelope } from "../src/events/envelope"
import { daemonConfigSchema } from "../src/daemon/config"

// Stop a running agent with a resume plan, and resume it (#857). What must hold:
//   - a stop ends the run, the agent writes a plan in a wind-down turn, and
//     the task is recorded as stopped (not failed);
//   - an agent that does not wind down in time is stopped, and a plan is
//     built from the trace, marked machine-written;
//   - resume re-enters through the resume coordinator, plan prepended, on
//     the same root; a second resume is refused;
//   - only the owner, the dispatching agent, allow-listed agents and named
//     peers may signal; an agent never signals its own task;
//   - signals cannot loop: a per-root budget, and the waker's root guard.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-signals-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const settings = (over: Partial<SignalSettings> = {}): SignalSettings => ({ ...DEFAULT_SIGNAL_SETTINGS, ...over })

const RUN: RunningRef = {
  taskId: "run-1",
  traceId: "trace-1",
  agentId: "coder",
  channel: "telegram",
  chatId: "42",
  sender: "agent:lead",
  rootId: "root-1",
  originalMessage: "Migrate the billing tables",
  origin: { kind: "router", adapter: "telegram", message: { id: "m1" } },
}

function harness(over: Partial<SignalServiceDeps> & { s?: Partial<SignalSettings>; running?: RunningRef | null } = {}) {
  const events: Array<{ type: string; rootId: string; summary: string }> = []
  const resumed: Array<{ id: string; note: string; rootId: string }> = []
  const told: string[] = []
  let running: RunningRef | null = over.running === undefined ? { ...RUN } : over.running
  const stopped: string[] = []
  const deps: SignalServiceDeps = {
    settings: () => settings(over.s),
    store: new StoppedTaskStore(dir),
    findRunning: (by) => (running && (by.taskId === running.taskId || (by.agentId === running.agentId && by.chatId === running.chatId)) ? running : null),
    stopRun: (taskId, reason) => { stopped.push(`${taskId}:${reason}`); running = null; return true },
    whenRunEnds: async () => {},
    toolCalls: () => [{ action: "Bash", inputSummary: "psql -c 'alter table invoices'" }],
    windDown: async () => ({ content: "Done: invoices table.\nLeft: payments table.\nNext action: alter payments.\nHalf-applied: nothing" }),
    resume: async ({ record, note }) => { resumed.push({ id: record.id, note, rootId: record.rootId }) },
    tell: async (_o, text) => { told.push(text) },
    publish: (e) => { events.push(e) },
    log: () => {},
    ...over,
  }
  return { service: new SignalService(deps), events, resumed, told, stopped, deps }
}

describe("stop", () => {
  it("stops the run, saves the agent's plan, and the task is stopped", async () => {
    const h = harness()
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" }, "deploy window")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(h.stopped[0]).toMatch(/^run-1:stopped by owner: deploy window/)
    expect(r.record.state).toBe("winding-down")
    const done = await r.done!
    expect(done.state).toBe("stopped")
    expect(done.plan?.author).toBe("agent")
    expect(done.plan?.text).toMatch(/Left: payments table/)
    expect(h.service.get("run-1")?.state).toBe("stopped")
    expect(h.events.map((e) => e.type)).toEqual(["signal:stop", "signal:stopped"])
    expect(h.events.every((e) => e.rootId === "root-1")).toBe(true)
    // The chat it came from hears it is paused.
    expect(h.told[0]).toMatch(/Paused/)
  })

  it("builds a machine-written plan from the trace when the agent does not wind down in time", async () => {
    const h = harness({
      s: { windDownSeconds: 0 },
      windDown: () => new Promise(() => {}), // never answers
    })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    const done = await r.done!
    expect(done.state).toBe("stopped")
    expect(done.plan?.author).toBe("machine")
    expect(done.plan?.note).toMatch(/no plan within 0s/)
    expect(done.plan?.text).toMatch(/alter table invoices/)
  }, 10_000)

  it("treats a wind-down turn the deadline ended as no plan", async () => {
    const h = harness({ windDown: async () => ({ error: "timed out after 120s" }) })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    expect((await r.done!).plan?.author).toBe("machine")
  })

  it("answers 404 when nothing runs", async () => {
    const h = harness({ running: null })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    expect(r).toMatchObject({ ok: false, status: 404 })
  })

  it("refuses a sender the policy refuses, and stops nothing", async () => {
    const h = harness()
    const r = await h.service.stop({ kind: "agent", agentId: "intruder" }, { taskId: "run-1" })
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(h.stopped).toEqual([])
  })
})

describe("resume", () => {
  it("re-enters with the plan prepended, under the same root, once", async () => {
    const h = harness()
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" }, "priority")
    if (!r.ok) throw new Error(r.error)
    await r.done
    const res = await h.service.resume({ kind: "agent", agentId: "lead" }, "run-1")
    expect(res.ok).toBe(true)
    expect(h.resumed).toHaveLength(1)
    expect(h.resumed[0].rootId).toBe("root-1")
    expect(h.resumed[0].note).toMatch(/\[Resumed after a stop\] owner stopped this task/)
    expect(h.resumed[0].note).toMatch(/Next action: alter payments/)
    expect(h.service.get("run-1")?.state).toBe("resumed")
    expect(h.events.at(-1)?.type).toBe("signal:resume")
    expect(await h.service.resume({ kind: "owner" }, "run-1")).toMatchObject({ ok: false, status: 409 })
  })

  it("is refused while the plan is still being written", async () => {
    const h = harness({ windDown: () => new Promise(() => {}) })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    expect(await h.service.resume({ kind: "owner" }, "run-1")).toMatchObject({ ok: false, status: 409 })
  })

  it("puts the task back to stopped when re-entering fails", async () => {
    const h = harness({ resume: async () => { throw new Error("channel down") } })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    expect(await h.service.resume({ kind: "owner" }, "run-1")).toMatchObject({ ok: false, status: 500 })
    expect(h.service.get("run-1")?.state).toBe("stopped")
  })

  it("goes through the resume coordinator's resumer for the task's origin", async () => {
    const coordinator = new ResumeCoordinator()
    const seen: any[] = []
    coordinator.register("router", { resume: async (input) => { seen.push(input) } })
    const h = harness({
      resume: ({ record, note }) => coordinator.resumeOne({
        origin: record.origin!, note, rootId: record.rootId,
        run: { taskId: record.id, agentId: record.agentId, channel: record.channel, chatId: record.chatId, workflowRunId: null, startedAt: 0, originalMessage: record.originalMessage, resumeOrigin: null, resumeAttempt: 0, toolCalls: [] },
      }),
    })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    expect((await h.service.resume({ kind: "owner" }, "run-1")).ok).toBe(true)
    expect(seen[0]).toMatchObject({ attempt: 0, rootId: "root-1", origin: { kind: "router", adapter: "telegram" } })
    // A kind no resumer handles is an error, not a silent no-op.
    await expect(coordinator.resumeOne({ origin: { kind: "direct" }, note: "", run: seen[0].run })).rejects.toThrow(/no resumer/)
  })
})

describe("who may signal", () => {
  const target = { agentId: "coder", sender: "agent:lead" }
  it("allows the owner always, and the agent that dispatched the task", () => {
    expect(canSignal({ kind: "owner" }, target, settings())).toEqual({ ok: true })
    expect(canSignal({ kind: "agent", agentId: "lead" }, target, settings())).toEqual({ ok: true })
  })
  it("refuses other agents unless allowAgents names them", () => {
    expect(canSignal({ kind: "agent", agentId: "ops" }, target, settings()).ok).toBe(false)
    expect(canSignal({ kind: "agent", agentId: "ops" }, target, settings({ allowAgents: ["ops"] })).ok).toBe(true)
    expect(canSignal({ kind: "agent", agentId: "ops" }, target, settings({ allowAgents: ["*"] })).ok).toBe(true)
  })
  it("never lets an agent signal its own task", () => {
    expect(canSignal({ kind: "agent", agentId: "coder" }, target, settings({ allowAgents: ["*"] })).ok).toBe(false)
  })
  it("accepts mesh peers only when named", () => {
    expect(canSignal({ kind: "peer", peer: "laptop" }, target, settings()).ok).toBe(false)
    expect(canSignal({ kind: "peer", peer: "laptop" }, target, settings({ allowPeers: ["Laptop"] })).ok).toBe(true)
    // An agent on a named peer still needs to be the dispatcher or allowed.
    expect(canSignal({ kind: "agent", agentId: "ops", peer: "laptop" }, target, settings({ allowPeers: ["laptop"] })).ok).toBe(false)
    expect(canSignal({ kind: "agent", agentId: "lead", peer: "laptop" }, target, settings({ allowPeers: ["laptop"] })).ok).toBe(true)
  })
  it("refuses everyone when signals are off", () => {
    expect(canSignal({ kind: "owner" }, target, settings({ enabled: false })).ok).toBe(false)
  })
})

describe("loop guard", () => {
  it("caps signals per root", () => {
    let t = 0
    const b = new SignalBudget(() => t)
    expect(b.take("r", 2)).toBe(true)
    expect(b.take("r", 2)).toBe(true)
    expect(b.take("r", 2)).toBe(false)
    expect(b.take("other", 2)).toBe(true)
    t += 25 * 60 * 60 * 1000
    expect(b.take("r", 2)).toBe(true)
  })

  it("refuses a stop past signals.maxPerRoot", async () => {
    const h = harness({ s: { maxPerRoot: 1 } })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    expect(await h.service.resume({ kind: "owner" }, "run-1")).toMatchObject({ ok: false, status: 429 })
  })

  it("a signal event wakes a subscriber once per root, and never the signalled agent", () => {
    const woke: string[] = []
    const agents = {
      lead: { subscriptions: [{ kinds: ["signal"], delivery: "wake" as const, maxPerHour: 60 }] },
      coder: { subscriptions: [{ kinds: ["signal"], delivery: "wake" as const, maxPerHour: 60 }] },
    }
    const waker = new EventWaker({ agents: () => agents, dispatch: (id) => { woke.push(id) }, log: () => {} })
    const ev = (type: string, id: string): EventEnvelope => ({ id, rootId: "root-1", node: "n", agentId: "coder", kind: "signal", type, at: new Date().toISOString(), summary: type })
    const first = waker.handle(ev("signal:stopped", "e1"))
    // lead resumes; the resume event shares the root and cannot wake it again.
    const second = waker.handle(ev("signal:resume", "e2"))
    expect(first.find((o) => o.agentId === "lead")?.woke).toBe(true)
    expect(second.find((o) => o.agentId === "lead")).toMatchObject({ woke: false, reason: "duplicate-root" })
    expect(first.find((o) => o.agentId === "coder")).toMatchObject({ woke: false, reason: "own-event" })
  })
})

describe("plan text", () => {
  it("asks for the four headings and lists the tool calls", () => {
    const m = windDownMessage({ by: "owner", reason: "deploy", originalMessage: "do it", toolCalls: [{ action: "Edit", inputSummary: "a.ts" }] })
    for (const h of ["Done:", "Left:", "Next action:", "Half-applied:"]) expect(m).toContain(h)
    expect(m).toContain("1. Edit: a.ts")
  })
  it("treats an empty answer as no plan and caps a long one", () => {
    expect(agentPlan("  ")).toBeNull()
    expect(agentPlan("x".repeat(10_000))!.text.length).toBeLessThanOrEqual(4000)
  })
  it("says who wrote the plan in the resume note", () => {
    const note = resumeNote({ stoppedAt: "2026-10-09T10:30:00.000Z", stoppedBy: "owner", plan: machinePlan({ toolCalls: [], note: "timeout" }), resumedBy: "lead" })
    expect(note).toMatch(/stopped this task at 10:30 UTC; lead resumed it/)
    expect(note).toMatch(/AgentX built from your trace/)
  })
  it("list summaries are bounded", () => {
    const s = summarizeStopped({
      id: "x", agentId: "a", channel: "c", chatId: "1", rootId: "r", originalMessage: "y".repeat(5000), origin: null,
      stoppedAt: "t", stoppedBy: "owner", state: "stopped", plan: { author: "agent", text: "z".repeat(5000) },
    })
    expect(String(s.request).length).toBeLessThanOrEqual(200)
    expect((s.plan as any).text.length).toBeLessThanOrEqual(1200)
    expect(s.resumable).toBe(false)
  })
})

describe("HTTP surface", () => {
  it("resolves who is calling", () => {
    expect(signalSender({ proofGiven: false, provenTurn: null, tokenPeer: null })).toEqual({ kind: "owner" })
    expect(signalSender({ proofGiven: true, provenTurn: { agentId: "lead", channel: "telegram" }, tokenPeer: null })).toEqual({ kind: "agent", agentId: "lead" })
    expect(signalSender({ proofGiven: true, provenTurn: null, tokenPeer: null })).toHaveProperty("error")
    // A wind-down turn cannot start another signal.
    expect(signalSender({ proofGiven: true, provenTurn: { agentId: "coder", channel: "signals" }, tokenPeer: null })).toHaveProperty("error")
    // A peer token names the peer, whatever the body claims.
    expect(signalSender({ proofGiven: false, provenTurn: null, via: { node: "liar", agentId: "lead" }, tokenPeer: "laptop" }))
      .toEqual({ kind: "agent", agentId: "lead", peer: "laptop" })
    expect(signalSender({ proofGiven: false, provenTurn: null, via: { node: "laptop" }, tokenPeer: null })).toEqual({ kind: "peer", peer: "laptop" })
  })

  it("maps a peer's own token to its name, never the shared mesh token", () => {
    const peers = [{ name: "laptop", token: "t1" }, { name: "server", token: "t2" }]
    expect(peerOfToken("Bearer t1", peers, "shared")).toBe("laptop")
    expect(peerOfToken("Bearer shared", [...peers, { name: "x", token: "shared" }], "shared")).toBeNull()
    expect(peerOfToken(undefined, peers)).toBeNull()
  })

  it("forwards a signal for another node with `via`, one hop only", async () => {
    const h = harness()
    const sent: any[] = []
    const forward = async (node: string, method: "GET" | "POST", path: string, body?: Record<string, unknown>) => {
      sent.push({ node, method, path, body })
      return { status: 202, body: { ok: true } }
    }
    const r = await handleSignalsHttp("POST", "/api/signals/stop", new URLSearchParams(), { taskId: "t", node: "laptop" }, {
      service: h.service, selfNode: "server", sender: { kind: "agent", agentId: "lead" }, forward,
    })
    expect(r.status).toBe(202)
    expect(sent[0]).toMatchObject({ node: "laptop", path: "/api/signals/stop", body: { taskId: "t", via: { node: "server", agentId: "lead" } } })
    expect(sent[0].body).not.toHaveProperty("node")
    const again = await handleSignalsHttp("POST", "/api/signals/stop", new URLSearchParams(), { taskId: "t", node: "third" }, {
      service: h.service, selfNode: "laptop", sender: { kind: "peer", peer: "server" }, forward,
    })
    expect(again.status).toBe(400)
  })

  it("stops and resumes locally with the right status codes", async () => {
    const h = harness()
    const deps = { service: h.service, selfNode: "server", sender: { kind: "owner" as const }, forward: async () => null }
    expect((await handleSignalsHttp("POST", "/api/signals/stop", new URLSearchParams(), {}, deps)).status).toBe(400)
    const stop = await handleSignalsHttp("POST", "/api/signals/stop", new URLSearchParams(), { taskId: "run-1" }, deps)
    expect(stop.status).toBe(202)
    await new Promise((r) => setTimeout(r, 10))
    const list = await handleSignalsHttp("GET", "/api/signals/stopped", new URLSearchParams(), {}, deps)
    expect((list.body.tasks as any[])[0]).toMatchObject({ id: "run-1", state: "stopped", resumable: true })
    const one = await handleSignalsHttp("GET", "/api/signals/stopped/run-1", new URLSearchParams(), {}, deps)
    expect((one.body.task as any).originalMessage).toBe("Migrate the billing tables")
    expect((await handleSignalsHttp("POST", "/api/signals/resume", new URLSearchParams(), { id: "run-1" }, deps)).status).toBe(200)
    const refused = await handleSignalsHttp("POST", "/api/signals/resume", new URLSearchParams(), { id: "run-1" }, { ...deps, sender: { error: "nope" } })
    expect(refused.status).toBe(403)
  })
})

describe("config", () => {
  it("has defaults: on, owner and dispatcher only", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(cfg.signals).toEqual({ enabled: true, windDownSeconds: 120, allowAgents: [], allowPeers: [], maxPerRoot: 6 })
    expect(cfg.signals).toEqual(DEFAULT_SIGNAL_SETTINGS)
  })
})

describe("live page", () => {
  it("ships a script that parses, with pause and resume actions", async () => {
    const { renderLivePage } = await import("../src/daemon/ui/pages/live")
    const html = renderLivePage()
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    expect(html).toContain("data-action=\"signal-stop\"")
    expect(html).toContain("data-action=\"signal-resume\"")
    expect(html).toContain("/api/signals/resume")
  })
})

describe("review points (#857)", () => {
  it("claims a resume atomically: two services on one folder, one re-entry", async () => {
    const a = harness()
    const r = await a.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    // A second service on the same folder (another process) races the first.
    const b = harness({ running: null })
    const [x, y] = await Promise.all([a.service.resume({ kind: "owner" }, "run-1"), b.service.resume({ kind: "owner" }, "run-1")])
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1)
    expect(a.resumed.length + b.resumed.length).toBe(1)
  })

  it("gives the claim back when re-entering fails, so a later resume can try", async () => {
    let fail = true
    const h = harness({ resume: async () => { if (fail) throw new Error("channel down") } })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    expect((await h.service.resume({ kind: "owner" }, "run-1")).ok).toBe(false)
    fail = false
    expect((await h.service.resume({ kind: "owner" }, "run-1")).ok).toBe(true)
  })

  it("after a restart, a task cut off while winding down gets a machine plan, with no model call", async () => {
    const h = harness({ windDown: () => new Promise(() => {}) })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    // The daemon restarts here: a new service on the same folder.
    let modelCalls = 0
    const after = harness({ running: null, windDown: async () => { modelCalls++; return { content: "x" } } })
    expect(after.service.recover()).toBe(1)
    const rec = after.service.get("run-1")!
    expect(rec.state).toBe("stopped")
    expect(rec.plan).toMatchObject({ author: "machine", note: "a restart cut off the wind-down" })
    expect(modelCalls).toBe(0)
    expect((await after.service.resume({ kind: "owner" }, "run-1")).ok).toBe(true)
  })

  it("says where a resumed answer goes, by origin", async () => {
    const { deliveryOf } = await import("../src/agents/signals/service")
    expect(deliveryOf({ kind: "router", adapter: "telegram", message: {} })).toMatch(/chat it came from \(telegram\)/)
    expect(deliveryOf({ kind: "mesh", node: "server", channel: "gitlab", chatId: "1" })).toMatch(/through server/)
    expect(deliveryOf({ kind: "direct", context: { channel: "a2a", sender: "agent:lead" } })).toBe("lead, as a new turn")
    expect(deliveryOf({ kind: "direct", context: { channel: "api" } })).toMatch(/^nobody: .*task page and trace only/)
    const h = harness({ running: { ...RUN, origin: { kind: "direct", context: { channel: "api" } } } })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    const res = await h.service.resume({ kind: "owner" }, "run-1")
    expect(res.ok && res.delivery).toMatch(/^nobody/)
  })

  it("a signal event from another machine wakes only a subscription naming that machine", () => {
    const woke: string[] = []
    const agents = {
      broad: { subscriptions: [{ kinds: ["signal"], delivery: "wake" as const, maxPerHour: 60 }] },
      named: { subscriptions: [{ kinds: ["signal"], delivery: "wake" as const, nodes: ["laptop"], maxPerHour: 60 }] },
    }
    const waker = new EventWaker({ agents: () => agents, dispatch: (id) => { woke.push(id) }, log: () => {}, isLocal: (e) => e.node === "server" })
    const out = waker.handle({ id: "p1", rootId: "r9", node: "laptop", agentId: "coder", kind: "signal", type: "signal:stopped", at: new Date().toISOString(), summary: "s" })
    expect(out.map((o) => o.agentId)).toEqual(["named"])
  })

  it("a stop-resume circle between two subscribed agents ends at the root budget", async () => {
    // lead resumes whatever stops; ops stops whatever resumes. Each wake is
    // refused after the first per root, and the budget caps the signals.
    const h = harness({ s: { allowAgents: ["*"], maxPerRoot: 3 } })
    const r = await h.service.stop({ kind: "agent", agentId: "ops" }, { taskId: "run-1" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    const results = []
    for (let i = 0; i < 5; i++) results.push((await h.service.resume({ kind: "agent", agentId: "lead" }, "run-1")).ok)
    // One resume taken; the rest are refused (already resumed / budget).
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

describe("the cut-off tool call and the workflow `signal` kind", () => {
  it("names the last tool call as possibly half-applied, in both plans", () => {
    const calls = [{ action: "Edit", inputSummary: "a.ts" }, { action: "Bash", inputSummary: "git push" }]
    expect(windDownMessage({ by: "owner", originalMessage: "x", toolCalls: calls })).toMatch(/last tool call \(Bash: git push\) may not have finished/)
    expect(machinePlan({ toolCalls: calls, note: "t" }).text).toMatch(/Half-applied: .*Bash: git push/)
  })

  it("stop and resume events never reach legacy /events `signal` subscribers (workflow signals)", async () => {
    const { TypedEventBus } = await import("../src/events/bus")
    const { EventBus } = await import("../src/daemon/event-bus")
    const core = new TypedEventBus()
    const legacy = new EventBus(core)
    const got: any[] = []
    legacy.subscribe({ kinds: ["signal"] }, (e) => got.push(e))
    core.publish({ kind: "signal", type: "signal:stop", agentId: "coder", summary: "stop", ref: "run-1" })
    expect(got).toEqual([])
    legacy.publish({ kind: "signal", name: "go", scope: "global" } as any)
    expect(got).toHaveLength(1)
  })
})
