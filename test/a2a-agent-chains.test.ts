import { describe, it, expect } from "vitest"
import { AgentChainBudget, chainKeyOf } from "../src/a2a/agent-chains"
import type { RootInitiator } from "../src/a2a/initiator"
import { chainBudgetCheck, chainBudgetSubject, SyncWaits, type CallerHint } from "../src/daemon/delegation-wiring"
import { daemonConfigSchema } from "../src/daemon/config"

const cronRoot: RootInitiator = { kind: "agent", channel: "cron", chatId: "cron:nightly", agentId: "planner" }
const personRoot: RootInitiator = { kind: "human", channel: "telegram", chatId: "chat-1", sender: "Sam", agentId: "front" }

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe("AgentChainBudget (#1756)", () => {
  it("refuses an agent's hand-offs past perAgentHour, then frees them as the hour rolls", () => {
    const c = clock()
    const b = new AgentChainBudget(() => ({ perAgentHour: 3, perChainDay: 0 }), c.now)
    for (let i = 0; i < 3; i++) {
      expect(b.take("planner", { ...cronRoot, chatId: `cron:job-${i}` })).toBeNull()
      c.advance(60_000)
    }
    const refused = b.take("planner", cronRoot)
    expect(refused).toMatch(/Hand-off budget used/)
    expect(refused).toMatch(/Finish the work yourself/)
    expect(refused).toMatch(/write to the owner once/)
    // Another agent has its own hour.
    expect(b.take("builder", cronRoot)).toBeNull()
    // The first hand-off leaves the window: one more fits.
    c.advance(57 * 60_000)
    expect(b.take("planner", cronRoot)).toBeNull()
    expect(b.take("planner", cronRoot)).not.toBeNull()
  })

  it("refuses a chain past perChainDay across the agents taking turns in it", () => {
    const c = clock()
    const b = new AgentChainBudget(() => ({ perAgentHour: 0, perChainDay: 4 }), c.now)
    const agents = ["a", "b", "a", "b"]
    for (const a of agents) expect(b.take(a, cronRoot)).toBeNull()
    expect(b.take("c", cronRoot)).toMatch(/this chain of work has made 4 hand-offs/)
    // A different root is a different chain.
    expect(b.take("c", { ...cronRoot, chatId: "cron:other" })).toBeNull()
    c.advance(24 * 3_600_000 + 1)
    expect(b.take("c", cronRoot)).toBeNull()
  })

  it("never counts work a person started", () => {
    const b = new AgentChainBudget(() => ({ perAgentHour: 1, perChainDay: 1 }))
    for (let i = 0; i < 10; i++) expect(b.take("front", personRoot)).toBeNull()
    expect(b.usage("front", personRoot)).toEqual({ agentHour: 0, chainDay: 0 })
    // A person's chain did not use up the agent's hour for agent work.
    expect(b.take("front", cronRoot)).toBeNull()
  })

  it("0 turns a brake off, and a refused hop is not counted", () => {
    const off = new AgentChainBudget(() => ({ perAgentHour: 0, perChainDay: 0 }))
    for (let i = 0; i < 100; i++) expect(off.take("a", cronRoot)).toBeNull()

    const b = new AgentChainBudget(() => ({ perAgentHour: 2, perChainDay: 100 }))
    b.take("a", cronRoot); b.take("a", cronRoot)
    expect(b.take("a", cronRoot)).not.toBeNull()
    expect(b.take("a", cronRoot)).not.toBeNull()
    expect(b.usage("a", cronRoot)).toEqual({ agentHour: 2, chainDay: 2 })
  })

  it("reads the limits on every check, so a reload applies at once", () => {
    let limits = { perAgentHour: 1, perChainDay: 0 }
    const b = new AgentChainBudget(() => limits)
    expect(b.take("a", cronRoot)).toBeNull()
    expect(b.take("a", cronRoot)).not.toBeNull()
    limits = { perAgentHour: 5, perChainDay: 0 }
    expect(b.take("a", cronRoot)).toBeNull()
  })

  it("keys a chain by its root", () => {
    expect(chainKeyOf(cronRoot)).toBe(chainKeyOf({ ...cronRoot }))
    expect(chainKeyOf(cronRoot)).not.toBe(chainKeyOf({ ...cronRoot, chatId: "cron:other" }))
  })
})

describe("chainBudgetSubject", () => {
  const hint = (h: Partial<CallerHint>): CallerHint => ({ meshForwarded: false, local: true, ...h })
  const waits = new SyncWaits()

  it("a named caller counts with its chain's root, a callback turn with the root it answers", () => {
    const callback = { agentId: "planner", taskId: "run-9", context: { channel: "a2a", chatId: "x", delegation: { root: cronRoot } } }
    expect(chainBudgetSubject(hint({}), callback, {}, waits)).toEqual({ agentId: "planner", root: cronRoot })
    const person = { agentId: "front", taskId: "run-1", context: { channel: "telegram", chatId: "chat-1", sender: "Sam" } }
    expect(chainBudgetSubject(hint({}), person, {}, waits)?.root.kind).toBe("human")
  })

  it("a sync callee's sends count with the root its hop was started under", () => {
    const w = new SyncWaits()
    w.begin("run-1", "run-2", cronRoot)
    const callee = { agentId: "builder", taskId: "run-2", context: { channel: "a2a", chatId: "a2a" } }
    expect(chainBudgetSubject(hint({}), callee, {}, w)?.root).toEqual(cronRoot)
  })

  it("a peer's hop counts against its sender with the root it carries, or as agent work", () => {
    const peer = hint({ senderAgentId: "remote", local: false })
    expect(chainBudgetSubject(peer, null, { context: { initiator: personRoot } }, waits)?.root.kind).toBe("human")
    expect(chainBudgetSubject(peer, null, { context: { initiator: cronRoot } }, waits)?.root).toEqual(cronRoot)
    expect(chainBudgetSubject(peer, null, {}, waits)).toEqual({ agentId: "remote", root: { kind: "agent", channel: "mesh", agentId: "remote" } })
  })

  it("a local request with no named caller and no root is not counted", () => {
    expect(chainBudgetSubject(hint({ senderAgentId: "x" }), null, {}, waits)).toBeNull()
    expect(chainBudgetSubject(hint({}), null, { context: { channel: "dashboard" } }, waits)).toBeNull()
  })

  it("chainBudgetCheck refuses once the budget is used", () => {
    const b = new AgentChainBudget(() => ({ perAgentHour: 1, perChainDay: 0 }))
    const peer = hint({ senderAgentId: "remote", local: false })
    expect(chainBudgetCheck(b, peer, null, {}, waits)).toBeNull()
    expect(chainBudgetCheck(b, peer, null, {}, waits)).toMatch(/Hand-off budget used/)
  })
})

describe("mesh.delegation.agentChains config", () => {
  it("defaults to 15 an hour per agent and 40 a day per chain", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(cfg.mesh.delegation.agentChains).toEqual({ perAgentHour: 15, perChainDay: 40 })
  })
  it("accepts 0 to turn a brake off", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, mesh: { delegation: { agentChains: { perAgentHour: 0 } } } })
    expect(cfg.mesh.delegation.agentChains).toEqual({ perAgentHour: 0, perChainDay: 40 })
  })
})
