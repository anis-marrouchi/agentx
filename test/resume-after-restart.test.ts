import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { claimResume, recordTraceStart, recordTraceStep, takeInterruptedRuns, type InterruptedRun } from "../src/storage/traces"
import { DEFAULT_RESUME_SETTINGS, inCrashLoop, planResume, type ResumeSettings } from "../src/agents/resume/policy"
import { buildResumeNote, recordBoot } from "../src/agents/resume/note"
import { parseOrigin, serializeOrigin, MAX_ORIGIN_BYTES, type RunOrigin } from "../src/agents/resume/origin"
import { RESUMED_TEXT, ResumeCoordinator } from "../src/agents/resume/coordinator"
import { MessageRouter } from "../src/channels/router"
import type { IncomingMessage } from "../src/channels/types"
import { attachSqliteSubscribers } from "../src/storage/subscribers"
import { getEventBus } from "../src/events/bus"

let tmp: string
beforeEach(() => { closeDb(); tmp = mkdtempSync(path.join(tmpdir(), "agentx-resume-")) })
afterEach(() => { closeDb(); vi.restoreAllMocks(); rmSync(tmp, { recursive: true, force: true }) })
const openTmp = () => openDb({ path: path.join(tmp, "db.sqlite") })!

const NOW = Date.parse("2026-09-26T12:00:00.000Z")
const chatOrigin: RunOrigin = {
  kind: "router", adapter: "telegram",
  message: { id: "m1", channel: "telegram", accountId: "bot", sender: { id: "42", name: "Sam" }, text: "summarise the week", timestamp: "2026-09-26T11:50:00.000Z", resolvedAgent: "ops-agent" },
}

function run(over: Partial<InterruptedRun> = {}): InterruptedRun {
  return {
    taskId: "t1", agentId: "ops-agent", channel: "telegram", chatId: "42", workflowRunId: null,
    startedAt: NOW - 5 * 60_000, originalMessage: "summarise the week",
    resumeOrigin: serializeOrigin(chatOrigin), resumeAttempt: 0, toolCalls: [], ...over,
  }
}

describe("run journal", () => {
  it("closes cut-off runs as interrupted, with their origin and tool calls, once", () => {
    const db = openTmp()
    recordTraceStart(db, { agentId: "ops-agent", channel: "telegram", chatId: "42", originalMessage: "hi", resumeOrigin: serializeOrigin(chatOrigin) }, "t1")
    recordTraceStep(db, "t1", { name: "tool_use", action: "Bash", inputSummary: "git push origin feature" })
    recordTraceStep(db, "t1", { name: "tool_result", action: "Bash", outputSummary: "ok" })

    const runs = takeInterruptedRuns(db, NOW)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ taskId: "t1", resumeAttempt: 0, toolCalls: [{ action: "Bash", inputSummary: "git push origin feature" }] })
    expect(parseOrigin(runs[0].resumeOrigin)).toEqual(chatOrigin)
    const row = db.prepare("SELECT status, resume_decision FROM task_traces WHERE task_id='t1'").get() as any
    expect(row).toEqual({ status: "canceled", resume_decision: "interrupted" })
    expect(takeInterruptedRuns(db, NOW)).toEqual([])
  })

  it("lets only one claimer resume a run", () => {
    const db = openTmp()
    recordTraceStart(db, { agentId: "ops-agent" }, "t1")
    takeInterruptedRuns(db, NOW)
    expect(claimResume(db, "t1")).toBe(true)
    expect(claimResume(db, "t1")).toBe(false)
    // Only runs this boot marked interrupted can be claimed at all.
    expect(claimResume(db, "never-existed")).toBe(false)
  })

  it("records a resumed run's attempt and the run it continues", () => {
    const db = openTmp()
    recordTraceStart(db, { agentId: "ops-agent", resumeAttempt: 1, resumedFrom: "t1" }, "t2")
    expect(takeInterruptedRuns(db, NOW)[0]).toMatchObject({ taskId: "t2", resumeAttempt: 1 })
  })

  // #297: a run the drain limit cut off ends before the daemon exits. Its
  // end must not close the trace, or the next boot never resumes it.
  it("keeps a run a shutdown interrupted open for the next boot", () => {
    const db = openTmp()
    const detach = attachSqliteSubscribers(db)
    try {
      recordTraceStart(db, { agentId: "ops-agent", channel: "telegram", chatId: "42" }, "t1")
      recordTraceStart(db, { agentId: "ops-agent", channel: "telegram", chatId: "43" }, "t2")
      const done = { agentId: "ops-agent", channel: "telegram", durationMs: 1, at: new Date(NOW).toISOString() }
      getEventBus().emit("task:completed", { ...done, taskId: "t1", chatId: "42", error: "killed by daemon restart (drain limit 300s)", interrupted: true })
      getEventBus().emit("task:completed", { ...done, taskId: "t2", chatId: "43", error: "real failure" })
    } finally {
      detach()
    }
    expect(takeInterruptedRuns(db, NOW).map((r) => r.taskId)).toEqual(["t1"])
  })
})

describe("resume columns", () => {
  it("appear even on a database that recorded another branch's migration number", () => {
    const db = openTmp()
    // Simulate a database that went ahead of this build on another branch:
    // drop our columns' table state by rebuilding task_traces without them.
    db.exec(`ALTER TABLE task_traces RENAME TO old_traces`)
    db.exec(`CREATE TABLE task_traces AS SELECT task_id, agent_id, channel, chat_id, workflow_run_id, workflow_id, workflow_node_id, intent_event_id, intent_decided_by, resume_session_id, final_session_id, model, status, started_at, finished_at, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, error, message_preview, original_message, final_response, tier2_input_tokens, tier2_output_tokens, tier2_cache_read_tokens, tier2_cache_create_tokens, resumed, jev_arm FROM old_traces`)
    db.exec(`INSERT OR IGNORE INTO schema_version (v) VALUES (99)`)
    closeDb()
    const reopened = openTmp()
    const cols = (reopened.prepare("PRAGMA table_info(task_traces)").all() as any[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(["resume_origin", "resume_attempt", "resumed_from", "resume_decision", "resume_reason"]))
  })
})

describe("origin", () => {
  it("refuses origins too big to store", () => {
    const huge: RunOrigin = { kind: "direct", context: { blob: "x".repeat(MAX_ORIGIN_BYTES) } }
    expect(serializeOrigin(huge)).toBeNull()
    expect(parseOrigin("{not json")).toBeNull()
    expect(parseOrigin(JSON.stringify({ kind: "router" }))).toBeNull()
  })
})

describe("planResume", () => {
  const plan = (r: InterruptedRun, s: Partial<ResumeSettings> = {}, boots = [NOW]) =>
    planResume([r], { ...DEFAULT_RESUME_SETTINGS, ...s }, { now: NOW, boots })[0]

  it("resumes a recent chat run", () => {
    expect(plan(run())).toMatchObject({ action: "resume" })
  })
  it("never resumes scheduled jobs", () => {
    expect(plan(run({ channel: "cron" }))).toMatchObject({ action: "skip" })
  })
  it("leaves workflow steps to the workflow engine", () => {
    expect(plan(run({ workflowRunId: "wf-1" }))).toMatchObject({ action: "report" })
  })
  it("reports runs older than 30 minutes", () => {
    expect(plan(run({ startedAt: NOW - 31 * 60_000 }))).toMatchObject({ action: "report", reason: expect.stringContaining("limit 30") })
    expect(plan(run({ startedAt: NOW - 29 * 60_000 }))).toMatchObject({ action: "resume" })
  })
  it("doesn't retry a run cut off while resuming", () => {
    expect(plan(run({ resumeAttempt: 1 }))).toMatchObject({ action: "report" })
  })
  it("pauses during a crash loop", () => {
    const boots = [NOW - 8 * 60_000, NOW - 4 * 60_000, NOW]
    expect(inCrashLoop(boots, NOW, DEFAULT_RESUME_SETTINGS.crashLoop)).toBe(true)
    expect(plan(run(), {}, boots)).toMatchObject({ action: "report", reason: expect.stringContaining("restarts") })
  })
  it("reports runs with no recorded origin", () => {
    expect(plan(run({ resumeOrigin: null }))).toMatchObject({ action: "report" })
  })
  it("reports direct runs unless their channel is opted in", () => {
    const direct = serializeOrigin({ kind: "direct", context: { channel: "voice" } })
    expect(plan(run({ channel: "voice", resumeOrigin: direct }))).toMatchObject({ action: "report" })
    expect(plan(run({ channel: "voice", resumeOrigin: direct }), { directChannels: ["voice"] })).toMatchObject({ action: "resume" })
  })
  it("honours report-only channels and the off switch", () => {
    expect(plan(run(), { reportOnlyChannels: ["telegram"] })).toMatchObject({ action: "report" })
    expect(plan(run(), { enabled: false })).toMatchObject({ action: "report" })
  })
})

describe("resume note", () => {
  it("lists the tool calls already made and asks to check before repeating", () => {
    const note = buildResumeNote(run({ toolCalls: [{ action: "Bash", inputSummary: "git push origin feature" }] }))
    expect(note).toContain("1. Bash: git push origin feature")
    expect(note).toContain("check whether it already happened")
  })
  it("says so when nothing had been done yet", () => {
    expect(buildResumeNote(run())).toContain("had not made any tool calls yet")
  })
  it("caps the list", () => {
    const calls = Array.from({ length: 20 }, (_, i) => ({ action: "Read", inputSummary: `file-${i}` }))
    const note = buildResumeNote(run({ toolCalls: calls }))
    expect(note).toContain("…and 5 more.")
    expect(note).not.toContain("file-19")
  })
})

describe("boot history", () => {
  it("keeps recent boots across restarts", () => {
    recordBoot(tmp, NOW - 1000)
    expect(recordBoot(tmp, NOW)).toEqual([NOW - 1000, NOW])
  })
})

describe("ResumeCoordinator", () => {
  function setup(runs: InterruptedRun[]) {
    const db = openTmp()
    for (const r of runs) recordTraceStart(db, { agentId: r.agentId }, r.taskId)
    takeInterruptedRuns(db, NOW)
    return db
  }
  const base = { settings: DEFAULT_RESUME_SETTINGS, now: NOW, boots: [NOW], log: () => {} }

  it("resumes once, tells the chat first, and records the decision", async () => {
    const db = setup([run()])
    const order: string[] = []
    const c = new ResumeCoordinator()
    c.register("router", {
      resume: async ({ note, attempt }) => { order.push(`resume:${attempt}`); expect(note).toContain("Resumed after a restart") },
      tell: async (_o, text) => { order.push(text === RESUMED_TEXT ? "tell:resumed" : "tell:other") },
    })
    const out = await c.run({ ...base, db, runs: [run()] })
    expect(out[0].decision).toBe("resumed")
    expect(order).toEqual(["tell:resumed", "resume:1"])
    const second = await new ResumeCoordinator().run({ ...base, db, runs: [run()] })
    expect(second[0].decision).toBe("already-claimed")
  })

  it("isolates a failing resume: recorded, reported to the operator, the next run still handled", async () => {
    const runs = [run({ taskId: "bad" }), run({ taskId: "good" })]
    const db = setup(runs)
    const resumed: string[] = []
    const c = new ResumeCoordinator()
    c.register("router", {
      resume: async ({ run: r }) => { if (r.taskId === "bad") throw new Error("adapter gone"); resumed.push(r.taskId) },
    })
    const notify = vi.fn(async () => {})
    const out = await c.run({ ...base, db, runs, notifyOperator: notify })
    expect(out.map((o) => o.decision)).toEqual(["resume-failed", "resumed"])
    expect(resumed).toEqual(["good"])
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("adapter gone"))
    const row = db.prepare("SELECT resume_decision, resume_reason FROM task_traces WHERE task_id='bad'").get() as any
    expect(row.resume_decision).toBe("resume-failed")
  })

  it("tells the chat when a run is only reported, and the operator when no chat can be told", async () => {
    const runs = [run({ taskId: "old", startedAt: NOW - 60 * 60_000 }), run({ taskId: "voice", channel: "voice", resumeOrigin: null })]
    const db = setup(runs)
    const told: string[] = []
    const c = new ResumeCoordinator()
    c.register("router", { resume: async () => {}, tell: async (_o, text) => { told.push(text) } })
    const notify = vi.fn(async () => {})
    await c.run({ ...base, db, runs, notifyOperator: notify })
    expect(told).toHaveLength(1)
    expect(told[0]).toContain("wasn't picked up again")
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain("voice")
    expect(notify.mock.calls[0][0]).not.toContain("old")
  })

  it("skips scheduled jobs silently and never throws, even if a chat can't be told", async () => {
    const runs = [run({ taskId: "cron", channel: "cron" }), run({ taskId: "stale", startedAt: 0 })]
    const db = setup(runs)
    const c = new ResumeCoordinator()
    c.register("router", { resume: async () => {}, tell: async () => { throw new Error("chat unreachable") } })
    const notify = vi.fn(async () => {})
    const out = await c.run({ ...base, db, runs, notifyOperator: notify })
    expect(out.map((o) => o.decision)).toEqual(["skipped", "reported"])
    // The chat couldn't be told, so the operator hears about it instead.
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe("router resume path", () => {
  const adapter: any = { name: "telegram", send: vi.fn(async () => "sent-1"), sendTyping: vi.fn(async () => {}), react: vi.fn(async () => {}) }
  const routerLog: string[] = []
  function makeRouter(execute: (task: any) => Promise<any>) {
    vi.spyOn(process, "cwd").mockReturnValue(tmp)
    const registry: any = {
      getAgent: () => ({ id: "ops-agent", name: "Ops" }),
      execute: vi.fn(execute),
      list: () => [],
    }
    const config: any = { channels: { telegram: { accounts: {} } }, agents: { "ops-agent": { name: "Ops" } }, notifications: {} }
    const router = new MessageRouter(registry, config, undefined, (...a: unknown[]) => { routerLog.push(a.map(String).join(" ")) })
    ;(router as any).channels.set("telegram", adapter)
    return { router, registry }
  }
  const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id: "m1", channel: "telegram", accountId: "bot", sender: { id: "42", name: "Sam" },
    text: "summarise the week", timestamp: new Date(NOW), ...over,
  })

  it("records the chat origin and hands the message to the journal once the run starts", async () => {
    const { router, registry } = makeRouter(async (task) => { task.onStart?.("run-1"); return { content: "done" } })
    ;(router as any).inflight.start({ id: "m1", channel: "telegram", accountId: "bot", text: "x", sender: { id: "42", name: "Sam" }, timestamp: new Date(NOW).toISOString() })
    await (router as any).processResolvedMessage(adapter, msg(), "ops-agent", "42")
    const task = registry.execute.mock.calls[0][0]
    expect(task.origin).toMatchObject({ kind: "router", adapter: "telegram", message: { id: "m1", text: "summarise the week" } })
    expect(task.resumeAttempt).toBeUndefined()
    expect((router as any).inflight.loadUnfinished()).toEqual([])
  })

  it("resumes through the normal path, with the note first and the attempt recorded", async () => {
    const { router, registry } = makeRouter(async () => ({ content: "done" }))
    await router.createResumer().resume({ origin: chatOrigin, run: run(), note: "[Resumed after a restart] …\n", attempt: 1 })
    await vi.waitFor(() => expect(registry.execute).toHaveBeenCalled())
    const task = registry.execute.mock.calls[0][0]
    expect(task.message.startsWith("[Resumed after a restart]")).toBe(true)
    expect(task.message).toContain("summarise the week")
    expect(task).toMatchObject({ resumeAttempt: 1, resumedFrom: "t1" })
  })

  it("tells the chat, as a reply on Telegram", async () => {
    const { router } = makeRouter(async () => ({ content: "done" }))
    adapter.send.mockClear()
    await router.createResumer().tell!(chatOrigin, "hello")
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ chatId: "42", text: "hello", replyTo: "m1" }))
  })

  it("fails loudly when the chat's channel isn't running", async () => {
    const { router } = makeRouter(async () => ({ content: "done" }))
    await expect(router.createResumer().resume({ origin: { ...chatOrigin, adapter: "whatsapp" } as RunOrigin, run: run(), note: "", attempt: 1 }))
      .rejects.toThrow("not running")
  })
})
