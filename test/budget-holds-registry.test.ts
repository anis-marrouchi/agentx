import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A chat message to an agent paused by its monthly budget waits instead of
// failing (#1162): the chat is told why once, and the message runs when the
// cap is raised or the month turns.

const hang = vi.hoisted(() => ({ on: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args),
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { clearAgentSpend, recordAgentSpend, setAgentBudgets } from "../src/agents/agent-budget"
import { BudgetHolds } from "../src/agents/budget-holds"
import { isQueued } from "../src/agents/queued"
import { setMessageRouter, resetMessageRouterForTesting } from "../src/channels/router-instance"

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-budget-holds-"))
  process.chdir(dir)
  hang.on = true
  clearAgentSpend()
  setMessageRouter({ getChannel: (name: string) => (name === "telegram" ? {} : undefined), sendOutbound: async () => {} } as any)
})
afterEach(() => {
  hang.on = false
  clearAgentSpend()
  resetMessageRouterForTesting()
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry() {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, budget: { monthlyUsd: 1 } } },
  })
  const r = new AgentRegistry(config, () => {})
  recordAgentSpend("ops", 1.5)
  return r
}

describe("chat messages to an agent over its monthly budget", () => {
  it("are held, telling each chat once, and run once the cap is raised", async () => {
    const r = registry()
    const first = await r.execute({ message: "one", agentId: "ops", context: { channel: "telegram", chatId: "c1" } })
    expect(first.errorKind).toBe("budget_cap")
    expect(first.error).toContain("Monthly budget reached")
    expect(first.error).toContain("kept and runs when the agent resumes")

    const second = await r.execute({ message: "two", agentId: "ops", context: { channel: "telegram", chatId: "c1" } })
    expect(isQueued(second.error)).toBe(true)

    const other = await r.execute({ message: "three", agentId: "ops", context: { channel: "telegram", chatId: "c2" } })
    expect(other.errorKind).toBe("budget_cap")
    expect(r.heldForBudget("ops")).toBe(3)

    // Still over budget: nothing is released.
    expect(r.releaseBudgetHolds()).toBe(0)
    expect(r.heldForBudget("ops")).toBe(3)

    setAgentBudgets({ agents: { ops: { monthlyUsd: 10 } } })
    expect(r.releaseBudgetHolds()).toBe(3)
    expect(r.heldForBudget("ops")).toBe(0)
  })

  it("are not held when the channel has no adapter to reply on", async () => {
    const r = registry()
    hang.on = false
    const res = await r.execute({ message: "report", agentId: "ops", context: { channel: "cron", chatId: "nightly" } })
    expect(res.errorKind).toBe("budget_cap")
    expect(r.heldForBudget("ops")).toBe(0)
  })
})

describe("BudgetHolds", () => {
  it("tells a chat once per pause and stops at its bound", () => {
    const h = new BudgetHolds(2)
    const m = (chatId: string) => ({ text: "x", channel: "telegram", chatId, context: undefined, heldAt: 0 })
    expect(h.hold("a", m("1"))).toBe("held-first")
    expect(h.hold("a", m("1"))).toBe("held")
    expect(h.hold("a", m("2"))).toBe("full")
    expect(h.take("a")).toHaveLength(2)
    expect(h.hold("a", m("1"))).toBe("held-first")
  })
})
