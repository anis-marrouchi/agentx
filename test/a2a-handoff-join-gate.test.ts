import { describe, it, expect, onTestFinished } from "vitest"
import Database from "better-sqlite3"
import { HandoffStore } from "../src/a2a/handoff-store"
import { DelegationManager } from "../src/a2a/delegation"
import { SyncWaits } from "../src/daemon/delegation-wiring"
import { AgentXDaemon } from "../src/daemon/index"

// #2042 (C2, behaviour): the same send twice through the daemon's gate
// counts one hop on the hand-off budget and writes one intent-ledger row.

function gateHarness() {
  const db = new Database(":memory:")
  onTestFinished(() => db.close())
  const turn = { taskId: "run-1", context: { channel: "telegram", chatId: "chat-1", sender: "Sam" } }
  const agents = new Set(["front", "worker"])
  const registry = {
    getAgent: (id: string) => (agents.has(id) ? { id } : undefined),
    runningTaskOwner: (id: string) => (id === "run-1" ? { agentId: "front" } : null),
    findRunningTurn: () => turn,
    refusalFor: () => null,
    slotHolders: () => null,
  }
  const delegations = new DelegationManager({
    timeoutMs: 60 * 60_000,
    pollMs: 1,
    runLocal: () => new Promise(() => {}),
    runPeer: () => new Promise(() => {}),
    cancelLocal: () => {},
    injectTurn: async () => ({ content: "ok" }),
    isChatBusy: () => false,
    canDeliver: () => true,
    deliver: async () => {},
    log: () => {},
    store: new HandoffStore(db),
  })
  onTestFinished(() => delegations.stop())
  const budget: string[] = []
  const ledger: string[] = []
  const daemon = Object.create(AgentXDaemon.prototype)
  Object.assign(daemon, {
    registry,
    delegations,
    syncWaits: new SyncWaits(),
    config: { mesh: { delegation: { callbackSends: true } } },
    mesh: undefined,
    log: () => {},
    chainBudget: { take: (agentId: string) => { budget.push(agentId); return null } },
    recordInboundDispatch: (callee: string) => { ledger.push(callee); return null },
  })
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } }
  const send = () => daemon.delegationGate(req, { senderAgentId: "front", callerTaskId: "run-1", async: true }, { callee: "worker", message: "Check the build" }, { identity: true })
  return { send, budget, ledger, db }
}

describe("a duplicate send through the gate (#2042, C2)", () => {
  it("counts the budget once and writes one ledger row", () => {
    const { send, budget, ledger, db } = gateHarness()
    const first = send()
    const second = send()
    expect(first.accepted).toMatchObject({ accepted: true })
    expect(second.accepted).toMatchObject({ taskId: first.accepted.taskId, duplicate: true })
    expect(budget).toEqual(["front"])
    expect(ledger).toEqual(["worker"])
    expect((db.prepare("SELECT COUNT(*) AS n FROM handoffs").get() as { n: number }).n).toBe(1)
  })
})
