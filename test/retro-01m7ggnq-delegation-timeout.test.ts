// retro:01M7GGNQNSKH4F1HH2HAH5T6PA
// The delegation reply watchdog the retro card asked for is the delegation's
// own time limit (mesh.delegation.timeoutMinutes, 120 on the Mac): an
// unanswered hand-off comes back as a turn in the asking agent's own chat,
// naming the agent that did not answer. These tests pin that for the shape
// of req-01M7GGNQ: marketing-agent, in the owner's app chat, asked
// secretary-agent and pm-agent the same question.
import { describe, it, expect, vi, afterEach } from "vitest"
import { DelegationManager, type CalleeRun, type CallerTurn, type DelegationDeps, type InjectedTurn } from "../src/a2a/delegation"

const MIN = 60_000
const TIMEOUT_MS = 120 * MIN
const STALL_ALERT_MS = 24 * 60 * MIN

const PARENT: CallerTurn = {
  agentId: "marketing-agent",
  taskId: "01M7GGNQNSKH4F1HH2HAH5T6PA",
  context: { channel: "app", chatId: "app:cmv2d8ls81ef58ddb", sender: "Voice" },
}

function harness() {
  const runs = new Map<string, { resolve: (r: CalleeRun) => void }>()
  const injected: InjectedTurn[] = []
  const deps: DelegationDeps = {
    timeoutMs: TIMEOUT_MS,
    pollMs: 1,
    runLocal: (callee, _message, _context, opts) => {
      opts.onStart(`run-${callee}`)
      return new Promise<CalleeRun>((resolve) => { runs.set(callee, { resolve }) })
    },
    runPeer: () => new Promise<string>(() => {}),
    cancelLocal: () => {},
    injectTurn: async (turn) => { injected.push(turn); return { content: "ok" } },
    isChatBusy: () => false,
    canDeliver: (channel) => channel === "app",
    deliver: async () => {},
    log: () => {},
  }
  const mgr = new DelegationManager(deps)
  const ask = (callee: string) => mgr.start({ caller: PARENT, callee, message: "What is the newborn video and its posting plan?" })
  return { mgr, runs, injected, ask }
}

const inParent = (t: InjectedTurn) => t.agentId === "marketing-agent"
  && t.context.channel === PARENT.context.channel && t.context.chatId === PARENT.context.chatId

afterEach(() => { vi.useRealTimers() })

describe("retro:01M7GGNQNSKH4F1HH2HAH5T6PA delegation reply watchdog", () => {
  it("(a) an unanswered delegation is named in the parent chat before the 24 h stall alert", async () => {
    vi.useFakeTimers()
    const h = harness()
    h.ask("secretary-agent")
    h.ask("pm-agent")

    // Nothing is said while the time limit runs.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1)
    expect(h.injected).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.injected.length).toBeGreaterThan(0)
    expect(h.injected.every(inParent)).toBe(true)
    const said = h.injected.map((t) => t.message).join("\n")
    expect(said).toContain("status=timeout")
    expect(said).toContain("secretary-agent")
    expect(said).toContain("pm-agent")
    expect(TIMEOUT_MS).toBeLessThan(STALL_ALERT_MS)
  })

  it("(b) replay of req-01M7GGNQ: answers at 37 s and 100 s, no timeout message", async () => {
    vi.useFakeTimers()
    const h = harness()
    h.ask("secretary-agent")
    h.ask("pm-agent")

    await vi.advanceTimersByTimeAsync(37_000)
    h.runs.get("pm-agent")!.resolve({ content: "It is #818; proof n148512, n148523." })
    await vi.advanceTimersByTimeAsync(63_000)
    h.runs.get("secretary-agent")!.resolve({ content: "Answer sent." })

    // Past the time limit and the stall alert: the answers came back, no
    // timeout turn.
    await vi.advanceTimersByTimeAsync(STALL_ALERT_MS)
    const said = h.injected.map((t) => t.message).join("\n")
    expect(h.injected.length).toBeGreaterThan(0)
    expect(h.injected.every(inParent)).toBe(true)
    expect(said).not.toContain("status=timeout")
    expect(said).toContain("status=done")
  })
})
