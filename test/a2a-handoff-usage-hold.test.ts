// #2467 item 2: a hand-off whose callee is over its usage limit is held
// until the reset and sent again, and the caller is told once.
import { describe, it, expect, onTestFinished, vi, afterEach } from "vitest"
import Database from "better-sqlite3"
import { DelegationManager, type CalleeRun, type CallerTurn, type DelegationDeps, type InjectedTurn } from "../src/a2a/delegation"
import { HandoffStore } from "../src/a2a/handoff-store"
import { LIMIT_HOLD_MARGIN_MS, LIMIT_HOLD_UNKNOWN_MS, LIMIT_NOTE, claudeReset, codexDate, usageLimitHold } from "../src/a2a/usage-hold"

const HUMAN_TURN: CallerTurn = {
  agentId: "front",
  taskId: "run-1",
  context: { channel: "telegram", chatId: "chat-1", sender: "Sam" },
}

// 2026-11-27 13:00Z = 14:00 in Africa/Tunis (UTC+1, no DST).
const NOW = Date.parse("2026-11-27T13:00:00.000Z")

describe("usageLimitHold", () => {
  it("reads the Claude plan gate's reset time", () => {
    const error = "Claude plan limit reached: Claude Code reports the five hour window as rejected. Cold dispatches are held until it resets in about 154 min (2026-11-27T15:34:00.000Z); open conversations still go through. To try again now, run: agentx usage plan --lift"
    expect(usageLimitHold({ error, errorKind: "dispatch_hold" }, NOW)).toEqual({ until: Date.parse("2026-11-27T15:34:00.000Z") })
    expect(usageLimitHold({ error, errorKind: "dispatch_hold", retryAt: Date.parse("2026-11-27T15:00:00.000Z") }, NOW)).toEqual({ until: Date.parse("2026-11-27T15:00:00.000Z") })
    // Without the kind, the text says it too.
    expect(usageLimitHold({ error }, NOW)?.until).toBe(Date.parse("2026-11-27T15:34:00.000Z"))
  })

  it("reads Claude Code's 'resets 6pm (Africa/Tunis)' in that zone", () => {
    expect(usageLimitHold({ error: "You've hit your 5-hour limit · resets 6pm (Africa/Tunis) · out of usage credits" }, NOW))
      .toEqual({ until: Date.parse("2026-11-27T17:00:00.000Z") })
    // Past today: tomorrow.
    expect(claudeReset("You've hit your 5-hour limit · resets 2pm (Africa/Tunis)", Date.parse("2026-11-27T13:30:00.000Z")))
      .toBe(Date.parse("2026-11-28T13:00:00.000Z"))
    expect(claudeReset("resets 12am (Africa/Tunis)", NOW)).toBe(Date.parse("2026-11-27T23:00:00.000Z"))
    expect(claudeReset("resets 2:30pm (UTC)", NOW)).toBe(Date.parse("2026-11-27T14:30:00.000Z"))
  })

  it("reads a weekly reset with its date", () => {
    expect(usageLimitHold({ error: "You've hit your weekly limit · resets Nov 29 at 5pm (Africa/Tunis) · out of usage credits" }, NOW))
      .toEqual({ until: Date.parse("2026-11-29T16:00:00.000Z") })
  })

  it("reads Codex's 'try again at Nov 27th, 2026 3:33 PM' in this machine's time", () => {
    const error = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 27th, 2026 3:33 PM."
    expect(usageLimitHold({ error }, NOW)?.until).toBe(new Date(2026, 10, 27, 15, 33).getTime())
    expect(codexDate("try again at Dec 1st, 2026 1:05 AM", NOW)).toBe(new Date(2026, 11, 1, 1, 5).getTime())
  })

  it("a limit with no time is still a limit", () => {
    expect(usageLimitHold({ error: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro)." }, NOW)).toEqual({})
    expect(usageLimitHold({ error: "Usage cap reached", errorKind: "usage_cap" }, NOW)).toEqual({})
  })

  it("is not fooled by other errors or by answers", () => {
    expect(usageLimitHold({ error: "killed by daemon restart (drain limit 300s)" }, NOW)).toBeNull()
    expect(usageLimitHold({ error: "Agent \"x\" not started: the daemon is restarting" }, NOW)).toBeNull()
    expect(usageLimitHold({ error: "API Error: Can't reach the API server" }, NOW)).toBeNull()
    expect(usageLimitHold({ content: "I hit your usage limit discussion", error: undefined } as CalleeRun, NOW)).toBeNull()
  })
})

const flush = () => new Promise((r) => setTimeout(r, 5))

function proc(db: Database.Database, over: Partial<DelegationDeps> = {}, answers: CalleeRun[] = []) {
  const injected: InjectedTurn[] = []
  const logs: string[] = []
  const notices: Array<{ caller: string; text: string }> = []
  const runs: Array<{ callee: string; message: string }> = []
  const mgr = new DelegationManager({
    timeoutMs: 60_000,
    pollMs: 1,
    store: new HandoffStore(db),
    resendAfterRestart: true,
    holdOnUsageLimit: true,
    now: () => Date.now(),
    holdNotice: (rec, text) => notices.push({ caller: rec.caller, text }),
    runLocal: (callee, message, _context, opts) => {
      runs.push({ callee, message })
      opts.onStart(`run-${runs.length}`)
      const next = answers.shift()
      return next ? Promise.resolve(next) : new Promise<CalleeRun>(() => {})
    },
    runPeer: () => new Promise<string>(() => {}),
    injectTurn: async (turn) => { injected.push(turn); return { content: "ok" } },
    isChatBusy: () => false,
    canDeliver: (channel) => channel === "telegram",
    deliver: async () => {},
    log: (m) => logs.push(m),
    ...over,
  })
  onTestFinished(() => mgr.stop())
  return { mgr, injected, logs, runs, notices }
}

function database() {
  const db = new Database(":memory:")
  onTestFinished(() => db.close())
  return db
}

const LIMIT_6PM = "You've hit your 5-hour limit · resets 6pm (Africa/Tunis) · out of usage credits"
const LONG = "Build the thing. " + "x".repeat(900)

describe("a hand-off whose callee is over its usage limit", () => {
  afterEach(() => { vi.useRealTimers() })

  it("is held until the reset, sent again with its full message, and the caller is told once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW })
    const db = database()
    const p = proc(db, {}, [{ content: "", error: LIMIT_6PM }, { content: "Built it." }])
    const { taskId } = p.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: LONG })
    await vi.advanceTimersByTimeAsync(10)
    expect(new HandoffStore(db).statusOf(taskId)).toBeNull()
    expect(p.injected).toHaveLength(0)
    expect(p.notices).toHaveLength(1)
    expect(p.notices[0].caller).toBe("front")
    expect(p.notices[0].text).toContain("worker is over its usage limit")
    expect(p.notices[0].text).toContain("2026-11-27 17:02 UTC")
    expect(p.mgr.heldForLimit()).toBe(1)
    // Past the 60 s time limit: the hold is not a timeout.
    await vi.advanceTimersByTimeAsync(Date.parse("2026-11-27T17:00:00.000Z") - NOW)
    expect(p.runs).toHaveLength(1)
    expect(new HandoffStore(db).statusOf(taskId)).toBeNull()
    await vi.advanceTimersByTimeAsync(LIMIT_HOLD_MARGIN_MS + 10)
    expect(p.runs).toHaveLength(2)
    expect(p.runs[1].message).toBe(LIMIT_NOTE + LONG)
    expect(new HandoffStore(db).statusOf(taskId)).toBe("done")
    expect(p.injected).toHaveLength(1)
    expect(p.injected[0].message).toContain("Built it.")
  })

  it("with no reset time, tries again after 30 min; a second hold tells nobody again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW })
    const db = database()
    const codex = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro)."
    const p = proc(db, {}, [{ content: "", error: codex }, { content: "", error: codex }, { content: "Done." }])
    const { taskId } = p.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Job" })
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(LIMIT_HOLD_UNKNOWN_MS)
    expect(p.runs).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(LIMIT_HOLD_UNKNOWN_MS)
    expect(p.runs).toHaveLength(3)
    expect(p.runs[2].message).toBe(LIMIT_NOTE + "Job")
    expect(new HandoffStore(db).statusOf(taskId)).toBe("done")
    expect(p.notices).toHaveLength(1)
  })

  it("ends as an error after three holds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW })
    const db = database()
    const err = { content: "", error: "You've hit your usage limit." }
    const p = proc(db, {}, [err, err, err, err])
    const { taskId } = p.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Job" })
    await vi.advanceTimersByTimeAsync(10)
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(LIMIT_HOLD_UNKNOWN_MS)
    expect(p.runs).toHaveLength(4)
    expect(new HandoffStore(db).statusOf(taskId)).toBe("error")
    expect(p.injected).toHaveLength(1)
  })

  it("a reset past the hold limit ends it as an error, as before", async () => {
    const db = database()
    const p = proc(db, { limitHoldMaxMs: 60 * 60_000 }, [{ content: "", error: "You've hit your weekly limit · resets Dec 3 at 5pm (Africa/Tunis)" }])
    const { taskId } = p.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Job" })
    await flush()
    expect(new HandoffStore(db).statusOf(taskId)).toBe("error")
    expect(p.notices).toHaveLength(0)
  })

  it("with holdOnUsageLimit off, ends as an error", async () => {
    const db = database()
    const p = proc(db, { holdOnUsageLimit: false }, [{ content: "", error: LIMIT_6PM }])
    const { taskId } = p.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Job" })
    await flush()
    expect(new HandoffStore(db).statusOf(taskId)).toBe("error")
    expect(p.notices).toHaveLength(0)
  })

  it("other errors end as before", async () => {
    const db = database()
    const p = proc(db, {}, [{ content: "", error: "API Error: 500 boom" }])
    const { taskId } = p.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Job" })
    await flush()
    expect(new HandoffStore(db).statusOf(taskId)).toBe("error")
  })

  it("held when the daemon restarts: sent again at boot, still open", async () => {
    const db = database()
    const before = proc(db, {}, [{ content: "", error: LIMIT_6PM }])
    const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Job" })
    await flush()
    before.mgr.stop()
    const after = proc(db, {}, [{ content: "Done." }])
    expect(await after.mgr.recover()).toBe(0)
    await flush()
    expect(after.runs).toHaveLength(1)
    expect(new HandoffStore(db).statusOf(taskId)).toBe("done")
  })
})
