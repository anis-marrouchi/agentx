import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2084: one run at a time per agent and named home (an issue, a pull
// request, a merge request). The lane in work-lane.ts is the one writer;
// the registry admits a run, then waits for the home, then runs it.

const hang = vi.hoisted(() => ({ on: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args),
  }
})

import { WorkLanes, isHomeRefusal, leaseHomeOf, MESH_TASK_WAIT_MS, SAME_WORK_MARKER, type HomeEntry } from "../src/agents/work-lane"
import { AgentRegistry } from "../src/agents/registry"
import type { AgentTask } from "../src/agents/runtime"
import { daemonConfigSchema } from "../src/daemon/config"
import { workflowAgents } from "../src/daemon/workflow-agents"
import { countHomeOverlaps } from "../src/daemon/concurrent-runs"
import { resolveHandler } from "../src/workflows/nodes/handlers"
import { nudgeText } from "../src/workflows/nodes/follow-up"
import { getEventBus } from "../src/events/bus"
import { withRoot } from "../src/events/envelope"

const H = "noqta/agentx#2084"
const REQ = "req-01M6TKA0XQ92ADP3408JTM88S6"
const quick = (p: Promise<unknown>, ms = 60) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))])
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

describe("leaseHomeOf", () => {
  it("takes only a home qualified with its project", () => {
    expect(leaseHomeOf("noqta/agentx#12")).toBe("noqta/agentx#12")
    expect(leaseHomeOf("group/sub/proj!7")).toBe("group/sub/proj!7")
    expect(leaseHomeOf("!12")).toBeNull()
    expect(leaseHomeOf("#12")).toBeNull()
    expect(leaseHomeOf("the login bug")).toBeNull()
    expect(leaseHomeOf(undefined)).toBeNull()
  })
})

describe("WorkLanes home lease", () => {
  it("serves waiters first in, first out, and tells each what the run before it said", async () => {
    const lanes = new WorkLanes()
    const first = await lanes.enterHome("coder", H) as HomeEntry
    const order: string[] = []
    const b = lanes.enterHome("coder", H, { source: "b" }).then((e) => { order.push("b"); return e as HomeEntry })
    await tick(5)
    const c = lanes.enterHome("coder", H, { source: "c" }).then((e) => { order.push("c"); return e as HomeEntry })
    await tick()
    expect(order).toEqual([])
    expect(lanes.homeWaiting("coder", H)).toBe(2)
    first.release({ text: "Opened MR !5.", ok: true })
    const eb = await b
    expect(eb.note).toContain(SAME_WORK_MARKER)
    expect(eb.note).toContain("Opened MR !5.")
    expect(await quick(c)).toBe(false)
    eb.release({ text: "ok", ok: true })
    await c
    expect(order).toEqual(["b", "c"])
  })

  it("has no same-root skip and lets other agents and other homes through", async () => {
    const lanes = new WorkLanes()
    const held = await lanes.enterHome("coder", H) as HomeEntry
    expect(await quick(lanes.enterHome("reviewer", H))).toBe(true)
    expect(await quick(lanes.enterHome("coder", "noqta/agentx#1"))).toBe(true)
    const again = lanes.enterHome("coder", H)
    expect(await quick(again)).toBe(false)
    held.release({ text: "", ok: true })
    expect(isHomeRefusal(await again)).toBe(false)
  })

  it("refuses a waiter past its deadline (home_busy) and it never runs", async () => {
    let t = 0
    const lanes = new WorkLanes({ now: () => t, sleep: async () => { t += 60_000 } })
    const held = await lanes.enterHome("coder", H) as HomeEntry
    held.setTaskId("task-1")
    const r = await lanes.enterHome("coder", H, { deadline: 5 * 60_000 })
    expect(isHomeRefusal(r)).toBe(true)
    expect(r).toMatchObject({ refused: "home_busy", taskId: "task-1" })
    expect(lanes.homeWaiting("coder", H)).toBe(0)
    expect(lanes.homeHolder("coder", H)?.taskId).toBe("task-1")
  })

  it("drops a waiter whose caller left; its retry runs once, after the holder", async () => {
    const lanes = new WorkLanes()
    const held = await lanes.enterHome("coder", H) as HomeEntry
    const ac = new AbortController()
    const gone = lanes.enterHome("coder", H, { signal: ac.signal })
    await tick()
    ac.abort()
    expect(await gone).toMatchObject({ refused: "caller_gone" })
    const retry = lanes.enterHome("coder", H)
    held.release({ text: "", ok: true })
    const e = await retry
    expect(isHomeRefusal(e)).toBe(false)
    expect(lanes.homeWaiting("coder", H)).toBe(0)
  })

  it("frees the lease once however often it is released", async () => {
    const lanes = new WorkLanes()
    const a = await lanes.enterHome("coder", H) as HomeEntry
    a.release({ text: "", ok: true })
    const b = await lanes.enterHome("coder", H) as HomeEntry
    a.release({ text: "", ok: true })
    expect(lanes.homeHolder("coder", H)?.holderId).toBe(b.holderId)
    b.release({ text: "", ok: true })
  })
})

describe("counting runs on a home beside another", () => {
  it("counts same agent, same home, overlapping only", () => {
    const n = countHomeOverlaps([
      { runId: "a", agentId: "coder", home: H, startedAt: 0, endedAt: 100 },
      { runId: "b", agentId: "coder", home: H, startedAt: 50, endedAt: 150 },
      { runId: "c", agentId: "reviewer", home: H, startedAt: 60, endedAt: 70 },
      { runId: "d", agentId: "coder", home: H, startedAt: 150, endedAt: 160 },
      { runId: "e", agentId: "coder", home: "noqta/agentx#1", startedAt: 60, endedAt: 70 },
    ])
    expect(n).toEqual({ count: 1, runs: ["b"] })
  })
})

describe("the nudge (X3)", () => {
  it("quotes no request id, so it takes no lane", () => {
    const text = nudgeText({ id: "run-1", meta: { title: `Ship the box (${REQ})` } } as never, "build", 1, 2, 30 * 60_000)
    expect(text).not.toContain("req-")
    expect(text).toContain(`"Ship the box"`)
    expect(text).toContain("run=run-1 step=build")
  })
})

describe("the agent node's home (B3)", () => {
  const agentHandler = resolveHandler("agent")!
  const ctx = (config: Record<string, unknown>, execute: (req: any) => Promise<any>, inputs: Record<string, unknown> = {}) => ({
    workflow: { id: "wf", envAllow: [] },
    run: { id: "run-1", context: { inputs } },
    node: { id: "n1", type: "agent", config },
    channels: {},
    agents: { execute },
    log: () => {},
  }) as never

  it("passes a rendered home, none when it renders empty, and fails a bare one", async () => {
    const execute = vi.fn(async () => ({ content: "RESULT: ok" }))
    await agentHandler(ctx({ agentId: "coder", prompt: "x", home: "{{inputs.home}}" }, execute, { home: "https://gitlab.com/noqta/agentx/-/merge_requests/9" }))
    expect((execute.mock.calls[0] as any)[0].home).toBe("noqta/agentx!9")
    await agentHandler(ctx({ agentId: "coder", prompt: "x", home: "{{inputs.home}}" }, execute))
    expect((execute.mock.calls[1] as any)[0]).not.toHaveProperty("home")
    const r = await agentHandler(ctx({ agentId: "coder", prompt: "x", home: "!12" }, execute))
    expect((r as any).error).toMatch(/not a project issue or merge request/)
    expect(execute).toHaveBeenCalledTimes(2)
  })
})

// --- Through the registry (runs hang in planning until cancelled) ---

let dir: string
const prevCwd = process.cwd()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-home-lease-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(maxConcurrent = 3, extra: Record<string, unknown> = {}) {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { coder: { name: "Coder", tier: "claude-code", workspace: dir, maxConcurrent } },
    ...extra,
  })
  const logs: string[] = []
  const r = new AgentRegistry(config, (m) => logs.push(m))
  const tasks: AgentTask[] = []
  /** Running task id by chat, once a run started. */
  const startedIn = new Map<string, string>()
  const real = r.execute.bind(r)
  r.execute = ((t: AgentTask, ...rest: any[]) => {
    tasks.push(t)
    const chat = String(t.context?.chatId)
    return (real as any)({ ...t, onStart: (id: string) => { startedIn.set(chat, id); t.onStart?.(id) } }, ...rest)
  }) as any
  return { r, logs, tasks, startedIn }
}

function start(r: AgentRegistry, context: Record<string, unknown>, extra: Partial<AgentTask> = {}) {
  let onStart!: (id: string) => void
  const started = new Promise<string>((res) => { onStart = res })
  let didStart = false
  const run = r.execute({
    message: extra.message ?? "work on it", agentId: "coder", context: context as never,
    ...extra,
    onStart: (id) => { didStart = true; onStart(id) },
  })
  return { started, run, didStart: () => didStart }
}

const a2a = (chat: string, home?: string) => ({ channel: "a2a", chatId: chat, ...(home ? { home } : {}) })

describe("one run per agent and home, in the registry", () => {
  it("C1: a hand-back on a held home waits, then runs once the holder ends", async () => {
    const { r } = registry()
    const joined: unknown[] = []
    const onJoined = (p: unknown) => { joined.push(p) }
    getEventBus().on("task:joined", onJoined)
    const holder = start(r, a2a("a2a:pm:coder:1", H))
    const holderId = await holder.started
    const back = start(r, a2a("a2a:reviewer:coder:2", H))
    await tick(1500)
    expect(back.didStart()).toBe(false)
    expect(joined).toContainEqual(expect.objectContaining({ agentId: "coder", home: H, taskId: holderId }))
    // Another agent's home or no home at all: not held.
    const other = start(r, a2a("a2a:pm:coder:3"))
    await other.started
    r.cancelRunningTask(holderId, "done")
    await holder.run
    const id = await back.started
    r.cancelRunningTask(id, "done")
    await back.run
    r.cancelRunningTask(await other.started, "done")
    await other.run
    getEventBus().off("task:joined", onJoined)
  }, 15_000)

  it("C6: a waiter out of budget gets home_busy and never runs", async () => {
    const { r, logs } = registry()
    const holder = start(r, a2a("a2a:pm:coder:1", H))
    const holderId = await holder.started
    const peer = start(r, { channel: "a2a", chatId: "a2a:peer:coder:9", home: H, fromPeer: true }, { slotWaitMs: 1200 })
    const res = await peer.run
    expect(res.error).toMatch(/^home_busy: agent "coder" is already working on noqta\/agentx#2084/)
    expect(res.errorKind).toBe("agent_busy")
    expect(peer.didStart()).toBe(false)
    expect(logs.some((l) => /refused \(home_busy\), not run/.test(l))).toBe(true)
    expect(MESH_TASK_WAIT_MS).toBe(20 * 60_000)
    r.cancelRunningTask(holderId, "done")
    await holder.run
  }, 15_000)

  it("C6b: the slot wait after the lane gets only what is left of the budget", async () => {
    const { r } = registry(1)
    const busy = start(r, a2a("a2a:pm:coder:1"))
    const busyId = await busy.started
    const t0 = Date.now()
    const late = start(r, a2a("a2a:pm:coder:2", H), { slotWaitMs: 700 })
    const res = await late.run
    expect(res.error).toMatch(/slot wait timed out/)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(late.didStart()).toBe(false)
    r.cancelRunningTask(busyId, "done")
    await busy.run
  }, 15_000)

  it("#2337: a run waiting for a slot holds no lease, so the run behind it is not refused for the home", async () => {
    const { r } = registry(1)
    const busy = start(r, a2a("a2a:pm:coder:1"))
    const busyId = await busy.started
    const first = start(r, a2a("a2a:pm:coder:2", H), { slotWaitMs: 10_000 })
    await tick(200)
    expect((r as any).workLanes.homeHolder("coder", H)).toBeNull()
    const second = start(r, a2a("a2a:pm:coder:3", H), { slotWaitMs: 800 })
    const res = await second.run
    expect(res.error).toMatch(/slot wait timed out/)
    expect(res.error).not.toMatch(/home_busy/)
    r.cancelRunningTask(busyId, "done")
    await busy.run
    const firstId = await first.started
    r.cancelRunningTask(firstId, "done")
    await first.run
  }, 15_000)

  it("#2337: a home_busy refusal is kept for the agent's next run, says so, and the log names the holder running", async () => {
    const { r, logs } = registry()
    const holder = start(r, a2a("a2a:pm:coder:1", H))
    const holderId = await holder.started
    const peer = start(r, a2a("a2a:owner:coder:9", H), { slotWaitMs: 1200, message: "owner ask: ship the fix" })
    const res = await peer.run
    expect(res.error).toMatch(/^home_busy: .*kept as a notice for its next run, do not send it again$/)
    expect(peer.didStart()).toBe(false)
    expect(logs.some((l) => /still held by \S+ \(running\) after \d+s; refused \(home_busy\)/.test(l))).toBe(true)
    const notices = (r as any).notices
    expect(notices.count("coder")).toBe(1)
    expect(notices.byAgent.get("coder")[0].text).toMatch(/Refused on noqta\/agentx#2084[\s\S]*owner ask: ship the fix/)
    // The agent's next run of agent work takes it.
    const next = start(r, a2a("a2a:pm:coder:10"))
    const nextId = await next.started
    expect(notices.count("coder")).toBe(0)
    r.cancelRunningTask(nextId, "done")
    await next.run
    r.cancelRunningTask(holderId, "done")
    await holder.run
  }, 15_000)

  it("a caller that leaves while waiting is dropped and never runs", async () => {
    const { r } = registry()
    const holder = start(r, a2a("a2a:pm:coder:1", H))
    const holderId = await holder.started
    const ac = new AbortController()
    const gone = start(r, a2a("a2a:pm:coder:2", H), { callerSignal: ac.signal })
    await tick(200)
    ac.abort(new Error("delegation timed out"))
    const res = await gone.run
    expect(res.error).toMatch(/Caller gone/)
    expect(gone.didStart()).toBe(false)
    r.cancelRunningTask(holderId, "done")
    await holder.run
  }, 15_000)

  it("Y1 and Y1f: a message in the holder's chat, and a forge comment on its thread, wait and run after it", async () => {
    const { r } = registry()
    const holder = start(r, a2a("a2a:pm:coder:1", H))
    const holderId = await holder.started
    const same = start(r, a2a("a2a:pm:coder:1", H))
    // A forge comment has nobody awaiting it: no budget, never refused.
    const forge = start(r, { channel: "gitlab", chatId: "noqta/agentx:issue:2084", sender: "anis" }, { slotWaitMs: 300 })
    await tick(1200)
    expect(same.didStart()).toBe(false)
    expect(forge.didStart()).toBe(false)
    r.cancelRunningTask(holderId, "done")
    await holder.run
    const sameId = await same.started
    expect(forge.didStart()).toBe(false)
    r.cancelRunningTask(sameId, "done")
    await same.run
    const forgeId = await forge.started
    r.cancelRunningTask(forgeId, "done")
    await forge.run
  }, 20_000)

  it("person chats are never held", async () => {
    const { r } = registry()
    const holder = start(r, a2a("a2a:pm:coder:1", H))
    const holderId = await holder.started
    const person = start(r, { channel: "telegram", chatId: "42", home: H })
    const personId = await person.started
    r.cancelRunningTask(personId, "done")
    r.cancelRunningTask(holderId, "done")
    await Promise.all([holder.run, person.run])
  }, 15_000)

  it("C5: a nested turn under the same root goes ahead on a request lane, but waits on the holder's home", async () => {
    const { r } = registry()
    const root = { rootId: "root-1" }
    const holder = withRoot(root, () => start(r, a2a("a2a:pm:coder:1", H), { message: `do ${REQ}` }))
    const holderId = await holder.started
    const nested = withRoot(root, () => start(r, a2a("a2a:pm:coder:2"), { message: `also ${REQ}` }))
    const nestedId = await nested.started
    const onHome = withRoot(root, () => start(r, a2a("a2a:pm:coder:3", H), { message: `then ${REQ}` }))
    await tick(1200)
    expect(onHome.didStart()).toBe(false)
    r.cancelRunningTask(nestedId, "done")
    r.cancelRunningTask(holderId, "done")
    await Promise.all([holder.run, nested.run])
    r.cancelRunningTask(await onHome.started, "done")
    await onHome.run
  }, 15_000)

  it("names the lease a hand-off's run will hold, so the hand-off waits only when it holds none", () => {
    const { r } = registry()
    expect(r.namedLeaseHome("coder", "Team/Site#7")).toBe("team/site#7")
    expect(r.namedLeaseHome("coder", "req-01JABCDEF")).toBeNull()
    expect(r.namedLeaseHome("nobody", "team/site#7")).toBeNull()
    const off = registry(3, { homeLease: { enabled: false } }).r
    expect(off.namedLeaseHome("coder", "team/site#7")).toBeNull()
  })

  it("setting off: runs on one home go side by side, as before", async () => {
    const { r } = registry(3, { homeLease: { enabled: false } })
    const a = start(r, a2a("a2a:pm:coder:1", H))
    const b = start(r, a2a("a2a:pm:coder:2", H))
    const [ia, ib] = await Promise.all([a.started, b.started])
    r.cancelRunningTask(ia, "done")
    r.cancelRunningTask(ib, "done")
    await Promise.all([a.run, b.run])
  }, 15_000)

  it("the backstop stops the live run first, then frees the lease after the grace", async () => {
    vi.useFakeTimers()
    try {
      const { r, logs } = registry()
      const cancel = vi.spyOn(r, "cancelRunningTask").mockReturnValue(null)
      const release = vi.fn()
      ;(r as any).leaseBackstop("coder", H, "task-9", 25, { release } as unknown as HomeEntry)
      expect(cancel).toHaveBeenCalledWith("task-9", "lease backstop")
      expect(release).not.toHaveBeenCalled()
      vi.advanceTimersByTime(30_000)
      expect(release).toHaveBeenCalledTimes(1)
      expect(logs.some((l) => /lease backstop stops it/.test(l))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("workflow nodes through the real wrapper", () => {
  it("B1: a node with the home waits for the holder, then runs with context.home and the run's chat", async () => {
    const { r, tasks, startedIn } = registry()
    const holder = start(r, a2a("a2a:pm:coder:1", H))
    const holderId = await holder.started
    const agents = workflowAgents(r)
    let nodeDone = false
    const node = agents.execute({ agentId: "coder", message: "review it", workflowRunId: "wr-1", home: H }).then((x) => { nodeDone = true; return x })
    await tick(1200)
    const nodeTask = tasks.find((t) => t.context?.chatId === "workflow:wr-1")!
    expect(nodeTask.context).toMatchObject({ channel: "workflow", chatId: "workflow:wr-1", home: H })
    expect(startedIn.has("workflow:wr-1")).toBe(false)
    expect(nodeDone).toBe(false)
    r.cancelRunningTask(holderId, "done")
    await holder.run
    for (let i = 0; i < 50 && !startedIn.has("workflow:wr-1"); i++) await tick(100)
    r.cancelRunningTask(startedIn.get("workflow:wr-1")!, "done")
    await node
  }, 20_000)

  it("B2, X1, X2: a node or nudge with no home starts at once beside the holder, with no home", async () => {
    const { r, tasks, startedIn } = registry()
    const holder = start(r, a2a("a2a:pm:coder:1", H))
    const holderId = await holder.started
    const agents = workflowAgents(r)
    const nudge = agents.execute({ agentId: "coder", message: nudgeText({ id: "wr-2", meta: { title: `x (${REQ})` } } as never, "n1", 1, 2, 60_000), workflowRunId: "wr-2" })
    for (let i = 0; i < 50 && !startedIn.has("workflow:wr-2"); i++) await tick(100)
    expect(startedIn.has("workflow:wr-2")).toBe(true)
    expect(tasks.find((t) => t.context?.chatId === "workflow:wr-2")!.context).not.toHaveProperty("home")
    expect(tasks.find((t) => t.context?.chatId === "workflow:wr-2")!.message).not.toContain("req-")
    r.cancelRunningTask(startedIn.get("workflow:wr-2")!, "done")
    r.cancelRunningTask(holderId, "done")
    await Promise.all([nudge, holder.run])
  }, 15_000)
})
