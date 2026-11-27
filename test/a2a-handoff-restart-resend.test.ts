// #2467 item 1: a hand-off a restart stopped is sent again after boot,
// once, instead of ending as error or lost.
import { describe, it, expect, onTestFinished } from "vitest"
import Database from "better-sqlite3"
import { DelegationManager, RESEND_NOTE, handoffCutByRestart, type CalleeRun, type CallerTurn, type DelegationDeps, type InjectedTurn } from "../src/a2a/delegation"
import { HandoffStore } from "../src/a2a/handoff-store"

const HUMAN_TURN: CallerTurn = {
  agentId: "front",
  taskId: "run-1",
  context: { channel: "telegram", chatId: "chat-1", sender: "Sam" },
}

const flush = () => new Promise((r) => setTimeout(r, 5))

/** One daemon process on a shared database. Each runLocal call answers
 *  with the next queued result, or stays open. */
function proc(db: Database.Database, over: Partial<DelegationDeps> = {}, answers: CalleeRun[] = []) {
  const injected: InjectedTurn[] = []
  const logs: string[] = []
  const runs: Array<{ callee: string; message: string; context: Record<string, unknown>; timeoutMs: number }> = []
  const mgr = new DelegationManager({
    timeoutMs: 60_000,
    pollMs: 1,
    store: new HandoffStore(db),
    resendAfterRestart: true,
    runLocal: (callee, message, context, opts) => {
      runs.push({ callee, message, context, timeoutMs: opts.timeoutMs })
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
  return { mgr, injected, logs, runs }
}

function database() {
  const db = new Database(":memory:")
  onTestFinished(() => db.close())
  return db
}

const LONG = "Build the thing. " + "x".repeat(900)

describe("handoffCutByRestart", () => {
  it("knows the three ways a restart stops a callee run", () => {
    expect(handoffCutByRestart('Agent "pm-agent" not started: the daemon is restarting')).toBe(true)
    expect(handoffCutByRestart("killed by daemon restart (drain limit 300s, requested by agentx daemon upgrade)")).toBe(true)
    expect(handoffCutByRestart("stopped mid-turn (registry-stop)")).toBe(true)
    expect(handoffCutByRestart("You've hit your 5-hour limit")).toBe(false)
    expect(handoffCutByRestart(undefined)).toBe(false)
  })
})

describe.each([
  'Agent "worker" not started: the daemon is restarting',
  "killed by daemon restart (drain limit 300s)",
])("a callee run stopped by a restart: %s", (error) => {
  it("stays open, then is sent again after boot with its full message, and its answer comes back", async () => {
    const db = database()
    const before = proc(db, {}, [{ content: "", error }])
    const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: LONG, timeoutMs: 120_000 })
    await flush()
    // Not closed as error, no callback to the caller.
    expect(before.injected).toHaveLength(0)
    expect(new HandoffStore(db).statusOf(taskId)).toBeNull()
    expect(before.logs.some((l) => l.includes("kept open to send again"))).toBe(true)
    before.mgr.stop()

    const after = proc(db, {}, [{ content: "Built it." }])
    expect(await after.mgr.recover()).toBe(0)
    await flush()
    expect(after.runs).toHaveLength(1)
    expect(after.runs[0].callee).toBe("worker")
    expect(after.runs[0].message).toBe(RESEND_NOTE + LONG)
    expect(after.runs[0].timeoutMs).toBe(120_000)
    // The callee's chat is the same hand-off's.
    expect(after.runs[0].context.chatId).toBe(`a2a:front:worker:${taskId}`)
    expect(new HandoffStore(db).statusOf(taskId)).toBe("done")
    expect(after.injected).toHaveLength(1)
    expect(after.injected[0].message).toContain("Built it.")
    expect(after.mgr.resentAfterRestart()).toBe(1)
  })
})

describe("a hand-off still out when the machine restarted", () => {
  it("is sent again instead of reported lost", async () => {
    const db = database()
    const before = proc(db)
    const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Long job" })
    before.mgr.stop()

    const after = proc(db, {}, [{ content: "Done now." }])
    await after.mgr.recover()
    await flush()
    expect(after.runs.map((r) => r.message)).toEqual([RESEND_NOTE + "Long job"])
    expect(new HandoffStore(db).statusOf(taskId)).toBe("done")
    expect(after.injected[0].message).not.toContain("status=lost")
  })

  it("is sent again only once: stopped again, it ends as before", async () => {
    const db = database()
    const first = proc(db)
    const { taskId } = first.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Long job" })
    first.mgr.stop()

    const second = proc(db, {}, [{ content: "", error: "killed by daemon restart (drain limit 300s)" }])
    await second.mgr.recover()
    await flush()
    // The resend itself was stopped: it ends as an error, told to the caller.
    expect(new HandoffStore(db).statusOf(taskId)).toBe("error")
    expect(second.injected).toHaveLength(1)
    second.mgr.stop()

    const third = proc(db)
    expect(await third.mgr.recover()).toBe(0)
    expect(third.runs).toHaveLength(0)
  })

  it("open again at the next start after its resend: reported lost, not sent a third time", async () => {
    const db = database()
    const first = proc(db)
    const { taskId } = first.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Long job" })
    first.mgr.stop()
    const second = proc(db)
    await second.mgr.recover()
    expect(second.runs).toHaveLength(1)
    second.mgr.stop()

    const third = proc(db)
    expect(await third.mgr.recover()).toBe(1)
    expect(third.runs).toHaveLength(0)
    expect(new HandoffStore(db).statusOf(taskId)).toBe("lost")
  })

  it("is sent again by one process when two share the database", async () => {
    const db = database()
    const before = proc(db)
    before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Long job" })
    before.mgr.stop()
    const one = proc(db)
    const two = proc(db)
    await Promise.all([one.mgr.recover(), two.mgr.recover()])
    expect(one.runs.length + two.runs.length).toBe(1)
    expect(one.injected.length + two.injected.length).toBe(0)
  })

  it("a peer's hand-off is still reported lost", async () => {
    const db = database()
    const before = proc(db)
    const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "builder", peer: "vps", message: "Long job" })
    before.mgr.stop()
    const after = proc(db)
    expect(await after.mgr.recover()).toBe(1)
    expect(new HandoffStore(db).statusOf(taskId)).toBe("lost")
  })

  it("with resendAfterRestart off, ends as before", async () => {
    const db = database()
    const before = proc(db, { resendAfterRestart: false }, [{ content: "", error: "killed by daemon restart (drain limit 300s)" }])
    const stopped = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Job A" })
    await flush()
    expect(new HandoffStore(db).statusOf(stopped.taskId)).toBe("error")
    const open = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Job B" })
    before.mgr.stop()
    const after = proc(db, { resendAfterRestart: false })
    expect(await after.mgr.recover()).toBe(1)
    expect(after.runs).toHaveLength(0)
    expect(new HandoffStore(db).statusOf(open.taskId)).toBe("lost")
  })

  it("keeps the message only while the row is open", async () => {
    const db = database()
    const p = proc(db, {}, [{ content: "ok" }])
    const { taskId } = p.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Short job" })
    await flush()
    const row = db.prepare("SELECT resend_json FROM handoffs WHERE id = ?").get(taskId) as { resend_json: string | null }
    expect(row.resend_json).toBeNull()
  })
})
