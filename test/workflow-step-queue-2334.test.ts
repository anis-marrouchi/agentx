// #2334: a workflow agent step waited 35+ minutes in the node queue
// (normal priority, disk gate), past its 15-minute timeout, and nobody was
// told. The agent node now takes priority "critical", a queue time limit
// (queueTimeoutMinutes, default timeoutMinutes) that fails the step with
// queue_timeout, onError "continue" so the workflow routes that failure,
// and one held notice to the workflow's owner agent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { rmSync } from "fs"
import { resolve } from "path"
import { AdmissionQueue, DEFAULT_ADMISSION_SETTINGS, heldNoticeMsOf, type AdmissionSettings, type AdmissionTicket } from "../src/admission/queue"
import { ResourceSampler, type ResourceSample } from "../src/native/resources"
import { RunStore, WorkflowStore, WorkflowDispatcher, workflowSchema, type AgentExecuteRequest, type AgentExecuteResponse } from "../src/workflows"
import { TimerService } from "../src/workflows/timers"
import { queueConfigOf, StepWait } from "../src/workflows/nodes/agent-queue"
import { workflowAgents } from "../src/daemon/workflow-agents"

const TEST_DIR = resolve(__dirname, "../.test-workflow-step-queue-2334")
const tick = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(10)
}

// --- the queue ---

const roomy: ResourceSample = {
  at: 0, memTotalMB: 8192, memAvailableMB: 4000, swapTotalMB: 2048, swapUsedMB: 100, swapGrows: true,
  diskFreeMB: 50_000, load1: 2, cpuCount: 8,
}

function queue(over: Partial<AdmissionSettings> = {}, sample: Partial<ResourceSample> = {}) {
  let now = 1_000_000
  const res = { current: { ...roomy, ...sample } }
  const settings: AdmissionSettings = {
    ...DEFAULT_ADMISSION_SETTINGS, allowOneWhenIdle: false, minStartGapSeconds: 0,
    boot: { windowSeconds: 0, startsPerInterval: 0, intervalSeconds: 30 }, sampleSeconds: 60, ...over,
  }
  const sampler = new ResourceSampler("/", 0, async () => ({ ...res.current, at: now }))
  const q = new AdmissionQueue(() => settings, sampler, () => {}, () => now)
  return { q, res, advance: (ms: number) => { now += ms } }
}

function ask(q: AdmissionQueue, agentId: string, extra: Record<string, unknown> = {}) {
  const box: { ticket?: AdmissionTicket | null } = {}
  void q.admit({ agentId, channel: "workflow", ...extra }).then((o) => { box.ticket = o.ok ? o.ticket : null })
  return box
}

describe("#2334 queue: a critical workflow step", () => {
  it("starts before earlier normal workflow steps when one slot frees", async () => {
    const { q } = queue({ maxSessions: 1, ownerExtraSessions: 0 })
    const first = ask(q, "busy")
    await tick(); await tick()
    expect(first.ticket).toBeTruthy()
    const normal = ask(q, "pm-agent", { label: "normal step" })
    const answer = ask(q, "pm-agent", { atLeast: "critical", label: "answer" })
    await tick(); await tick()
    expect(normal.ticket).toBeUndefined()
    expect(answer.ticket).toBeUndefined()
    first.ticket!.release()
    await tick(); await tick()
    expect(answer.ticket).toBeTruthy()
    expect(normal.ticket).toBeUndefined()
  })

  it("starts past a load hold that keeps the normal step waiting", async () => {
    const { q } = queue({}, { load1: 40 })
    const first = ask(q, "busy")
    await tick(); await tick()
    // allowOneWhenIdle is off: the first run is held too, so free the node by hand.
    first.ticket?.release()
    const running = ask(q, "other", { atLeast: "critical" })
    await tick(); await tick()
    expect(running.ticket).toBeTruthy()
    const normal = ask(q, "pm-agent")
    const answer = ask(q, "pm-agent", { atLeast: "critical" })
    await tick(); await tick()
    expect(answer.ticket).toBeTruthy()
    expect(normal.ticket).toBeUndefined()
  })

  it("tells the held caller its queue position", async () => {
    const { q, advance } = queue({}, { diskFreeMB: 100 })
    const notify = vi.fn()
    ask(q, "a")
    ask(q, "pm-agent", { longWait: { afterMs: 60_000, notify } })
    await tick(); await tick()
    advance(60_000); await q.pump()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ position: 2, of: 2 })
    expect(notify.mock.calls[0][0].blockedBy.join()).toMatch(/disk:/)
  })

  it("uses the step's own notice time over admission.waitNotice", () => {
    const s = { waitNotice: { afterSeconds: 120, channels: [] } }
    expect(heldNoticeMsOf({ heldNoticeMs: 600_000 }, s)).toBe(600_000)
    expect(heldNoticeMsOf({ heldNoticeMs: 0 }, s)).toBe(0)
    expect(heldNoticeMsOf({}, s)).toBe(120_000)
  })
})

// --- the node config ---

describe("#2334 agent node queue settings", () => {
  it("defaults the queue limit to timeoutMinutes and the notice to 10 min", () => {
    expect(queueConfigOf({}, 15)).toEqual({ queueLimitMs: 15 * 60_000, heldNoticeMs: 10 * 60_000 })
    expect(queueConfigOf({}, undefined)).toEqual({ heldNoticeMs: 10 * 60_000 })
    expect(queueConfigOf({ queueTimeoutMinutes: 5, heldNoticeMinutes: 0, priority: "critical", onError: "continue" }, 15))
      .toEqual({ queueLimitMs: 5 * 60_000, heldNoticeMs: 0, priority: "critical", onError: "continue" })
  })

  it("refuses owner priority and unknown values", () => {
    expect(queueConfigOf({ priority: "owner" }, 15)).toHaveProperty("error")
    expect(queueConfigOf({ priority: "normal" }, 15)).toHaveProperty("error")
    expect(queueConfigOf({ onError: "ignore" }, 15)).toHaveProperty("error")
    expect(queueConfigOf({ queueTimeoutMinutes: 0 }, 15)).toHaveProperty("error")
    expect(queueConfigOf({ heldNoticeMinutes: -1 }, 15)).toHaveProperty("error")
  })

  it("the queue clock does not run out once the turn started", async () => {
    const w = new StepWait(20)
    w.stop()
    await sleep(40)
    expect(w.timedOut).toBe(false)
    expect(w.signal!.aborted).toBe(false)
  })
})

// --- the shim to the registry ---

describe("#2334 workflow agents shim", () => {
  it("passes priority, the queue signal and the held notice to the agent task", async () => {
    const seen: any[] = []
    const registry = { execute: async (task: any) => { seen.push(task); task.onStart?.("t1"); return { content: "ok" } } }
    const ac = new AbortController()
    const onHeld = vi.fn()
    const onStarted = vi.fn()
    await workflowAgents(registry as any).execute({ agentId: "pm-agent", message: "m", workflowRunId: "r1", priority: "critical", signal: ac.signal, onHeld, heldNoticeMs: 1000, onStarted })
    expect(seen[0].context.admissionPriority).toBe("critical")
    expect(seen[0].callerSignal).toBe(ac.signal)
    expect(seen[0].onHeld).toBe(onHeld)
    expect(seen[0].heldNoticeMs).toBe(1000)
    expect(onStarted).toHaveBeenCalledTimes(1)
  })

  it("leaves a step with no priority at the computed one", async () => {
    const seen: any[] = []
    await workflowAgents({ execute: async (t: any) => { seen.push(t); return { content: "" } } } as any).execute({ agentId: "a", message: "m" })
    expect(seen[0].context.admissionPriority).toBeUndefined()
    expect(seen[0].callerSignal).toBeUndefined()
  })
})

// --- a whole run, shaped like saber-hakim-whatsapp ---

const answerWf = (answer: Record<string, unknown>) => workflowSchema.parse({
  id: "wa-2334", version: 2, title: "wa answer", priority: 0, fanOut: false, ownerAgent: "pm-agent",
  envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
  nodes: [
    { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
    { id: "answer", type: "agent", config: { agentId: "pm-agent", prompt: "answer", ...answer } },
    { id: "gate_reply", type: "branch", config: { cases: [{ when: { kind: "matches", params: { path: "answer.reply", regex: "<wa>[\\s\\S]*\\S[\\s\\S]*</wa>" } }, to: "send" }], default: "report_fail" } },
    { id: "send", type: "action.send", config: { channel: "fake", chatId: "c", text: "sent" } },
    { id: "report_fail", type: "action.send", config: { channel: "fake", chatId: "c", text: "fail: {{answer.errorKind}}" } },
    { id: "done", type: "end", config: {} },
  ],
  edges: [
    { from: "trigger", to: "answer" },
    { from: "answer", to: "gate_reply" },
    { from: "gate_reply", fromPort: "send", to: "send" },
    { from: "gate_reply", fromPort: "report_fail", to: "report_fail" },
    { from: "send", to: "done" },
    { from: "report_fail", to: "done" },
  ],
})

/** An agent that never gets room: held once, then waits until the step
 *  gives up, as the registry does on a caller-gone signal. */
const heldAgent = (calls: AgentExecuteRequest[]) => ({
  execute: (req: AgentExecuteRequest): Promise<AgentExecuteResponse> => new Promise((done) => {
    calls.push(req)
    setTimeout(() => req.onHeld?.({ waitedMs: 600_000, blockedBy: ["behind earlier work", "disk: 371 MB free, needs 2048 MB"], position: 40, of: 85 }), 5)
    req.signal?.addEventListener("abort", () => done({ content: "", error: `Caller gone before agent "${req.agentId}" was free — not started` }), { once: true })
  }),
})

function boot(agents: { execute(req: AgentExecuteRequest): Promise<AgentExecuteResponse> }) {
  const sends: string[] = []
  const logs: string[] = []
  const notices: Array<{ to: string; from: string; text: string }> = []
  const store = new WorkflowStore({ baseDir: TEST_DIR })
  const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
  const channels = { fake: { send: async (m: { text: string }) => { sends.push(m.text); return "m" } } }
  const timers = new TimerService({ baseDir: resolve(TEST_DIR, "_timer-base"), tickIntervalMs: 50, sweepIntervalMs: 60_000 })
  const dispatcher = new WorkflowDispatcher({
    store, runs, nodeId: "node-a", channels, agents, timers, log: (m) => logs.push(m),
    noticeAgent: (to, from, text) => notices.push({ to, from, text }),
  })
  return { store, runs, dispatcher, sends, logs, notices }
}

async function start(b: ReturnType<typeof boot>) {
  await b.dispatcher.dispatch({ trigger: { source: "manual" }, entityRef: { backend: "manual", id: "e-2334" }, event: { id: "evt-1", payload: {} } })
}

describe("#2334 a held answer step", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })

  // 0.0005 min = 30 ms: the queue limit, in test time.
  it("past its queue time goes down the failure branch, and the owner agent is told once", async () => {
    const calls: AgentExecuteRequest[] = []
    const b = boot(heldAgent(calls))
    b.store.save(answerWf({ priority: "critical", queueTimeoutMinutes: 0.0005, heldNoticeMinutes: 0.0001, onError: "continue" }))
    await start(b)
    await until(() => b.sends.length > 0)
    expect(calls[0].priority).toBe("critical")
    expect(b.sends).toEqual(["fail: queue_timeout"])
    const run = b.runs.list().find((r) => r.workflowId === "wa-2334")!
    await until(() => b.runs.get(run.id)!.status === "completed")
    expect(b.runs.get(run.id)!.status).toBe("completed")
    expect(b.notices).toHaveLength(1)
    expect(b.notices[0].to).toBe("pm-agent")
    expect(b.notices[0].text).toMatch(/step "answer".*disk: 371 MB free.*queue position 40 of 85/)
    expect(b.logs.some((l) => /run .*: Workflow step "answer"/.test(l))).toBe(true)
  })

  it("timeoutMinutes alone is the queue limit; without onError the run fails with queue_timeout", async () => {
    const calls: AgentExecuteRequest[] = []
    const b = boot(heldAgent(calls))
    b.store.save(answerWf({ timeoutMinutes: 0.0005 }))
    await start(b)
    const run = () => b.runs.list().find((r) => r.workflowId === "wa-2334")
    await until(() => run()?.status === "failed")
    expect(run()!.status).toBe("failed")
    expect(run()!.history?.[0]?.note).toMatch(/^\[queue_timeout\] step "answer" did not start: .*disk: 371 MB free/)
    expect(calls[0].priority).toBeUndefined()
    expect(b.sends).toEqual([])
  })

  it("a step that starts in time is not cut by the queue limit", async () => {
    const b = boot({
      execute: async (req) => { req.onStarted?.(); await sleep(60); return { content: "<wa>hello</wa>" } },
    })
    b.store.save(answerWf({ queueTimeoutMinutes: 0.0005, onError: "continue" }))
    await start(b)
    await until(() => b.sends.length > 0)
    expect(b.sends).toEqual(["sent"])
    expect(b.notices).toHaveLength(0)
  })

  it("a run with no owner agent still logs the hold, and leaves no notice", async () => {
    const calls: AgentExecuteRequest[] = []
    const b = boot(heldAgent(calls))
    const wf = answerWf({ queueTimeoutMinutes: 0.0005, heldNoticeMinutes: 0.0001, onError: "continue" })
    b.store.save({ ...wf, ownerAgent: undefined })
    await start(b)
    await until(() => b.sends.length > 0)
    expect(b.notices).toHaveLength(0)
    expect(b.logs.some((l) => /Workflow step "answer" \(agent pm-agent\) has waited/.test(l))).toBe(true)
  })
})
