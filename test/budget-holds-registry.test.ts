import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
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

  it("survive a daemon restart and run once the cap is raised (#1290)", async () => {
    const before = registry()
    await before.execute({ message: "one", agentId: "ops", context: { channel: "telegram", chatId: "c1" } })
    await before.execute({ message: "two", agentId: "ops", context: { channel: "telegram", chatId: "c2" } })
    expect(before.heldForBudget("ops")).toBe(2)

    // A new registry in the same folder is what a restart builds.
    const after = registry()
    expect(after.heldForBudget("ops")).toBe(2)
    setAgentBudgets({ agents: { ops: { monthlyUsd: 10 } } })
    expect(after.releaseBudgetHolds()).toBe(2)

    const again = registry()
    expect(again.heldForBudget("ops")).toBe(0)
  })

  it("held for a paused project release only that project's chats", async () => {
    const config = daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { dev: { name: "Dev", tier: "claude-code", workspace: dir } },
      dashboard: { wall: { projects: [{ name: "Shop", repos: ["acme/shop"], budget: { monthlyUsd: 1 } }] } },
    })
    setMessageRouter({ getChannel: (name: string) => (name === "github" || name === "telegram" ? {} : undefined), sendOutbound: async () => {} } as any)
    const r = new AgentRegistry(config, () => {})
    recordAgentSpend("dev", 2, undefined, "Shop")
    const res = await r.execute({ message: "fix it", agentId: "dev", context: { channel: "github", chatId: "acme/shop:issue:7" } })
    expect(res.errorKind).toBe("budget_cap")
    expect(res.error).toContain("project Shop")
    expect(r.heldForBudget("dev")).toBe(1)
    setAgentBudgets({ projects: { Shop: { monthlyUsd: 5 } } })
    expect(r.releaseBudgetHolds()).toBe(1)
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

  it("keeps what waits in its file and reads it back (#1290)", () => {
    const file = join(dir, ".agentx", "budget-holds.json")
    const m = (chatId: string) => ({ text: "x " + chatId, channel: "telegram", chatId, context: { channel: "telegram", chatId }, heldAt: 1 })
    const h = new BudgetHolds(10, file)
    h.hold("a", m("1"))
    h.hold("a", m("2"))
    const back = new BudgetHolds(10, file)
    expect(back.count("a")).toBe(2)
    expect(back.take("a", (x) => x.chatId === "2").map((x) => x.text)).toEqual(["x 2"])
    expect(new BudgetHolds(10, file).count("a")).toBe(1)
  })

  it("starts empty from an unreadable file", () => {
    const file = join(dir, "holds.json")
    writeFileSync(file, "{not json")
    const logs: string[] = []
    expect(new BudgetHolds(10, file, (l) => logs.push(l)).size).toBe(0)
    expect(logs[0]).toContain("couldn't read held messages")
  })
})
