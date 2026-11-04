import { describe, expect, it } from "vitest"
import { ChainBudget } from "../src/a2a/chain-budget"
import type { RootInitiator } from "../src/a2a/initiator"

const cron: RootInitiator = { kind: "agent", channel: "cron", chatId: "cron:desk", agentId: "ops" }
const other: RootInitiator = { kind: "agent", channel: "a2a", chatId: "ops", agentId: "ops" }
const person: RootInitiator = { kind: "human", channel: "telegram", chatId: "42", agentId: "ops" }

function budget(perAgentHour: number, perChainDay: number) {
  let t = 1_000_000
  const b = new ChainBudget(() => ({ perAgentHour, perChainDay }), () => t)
  return { b, advance: (ms: number) => { t += ms } }
}

describe("hand-off budget for work no person started (#1756)", () => {
  it("refuses an agent past its hourly hand-offs, and lets it go again an hour later", () => {
    const { b, advance } = budget(3, 0)
    expect(b.take("ops", cron)).toBeNull()
    expect(b.take("ops", other)).toBeNull()
    expect(b.take("ops", cron)).toBeNull()
    const why = b.take("ops", other)
    expect(why).toMatch(/Hand-off budget used: ops has handed out 3 pieces of work in the last hour/)
    expect(why).toMatch(/Do not hand this to another agent/)
    // Another agent has its own count.
    expect(b.take("pm", cron)).toBeNull()
    advance(60 * 60_000 + 1)
    expect(b.take("ops", cron)).toBeNull()
  })

  it("refuses a chain past its daily hand-offs, whichever agent asks", () => {
    const { b, advance } = budget(0, 2)
    expect(b.take("ops", cron)).toBeNull()
    expect(b.take("pm", cron)).toBeNull()
    expect(b.take("coder", cron)).toMatch(/this chain of work, started by ops, has made 2 hand-offs today/)
    // A different root is a different chain.
    expect(b.take("coder", other)).toBeNull()
    advance(24 * 60 * 60_000 + 1)
    expect(b.take("coder", cron)).toBeNull()
  })

  it("never counts work a person started", () => {
    const { b } = budget(1, 1)
    for (let i = 0; i < 10; i++) expect(b.take("ops", person)).toBeNull()
    expect(b.take("ops", cron)).toBeNull()
    expect(b.take("ops", cron)).not.toBeNull()
  })

  it("a refused hand-off is not counted", () => {
    const { b, advance } = budget(1, 0)
    expect(b.take("ops", cron)).toBeNull()
    advance(30 * 60_000)
    expect(b.take("ops", cron)).not.toBeNull()
    advance(30 * 60_000 + 1)
    expect(b.take("ops", cron)).toBeNull()
  })

  it("0 turns both brakes off, and a new limit applies at once", () => {
    let limits = { perAgentHour: 0, perChainDay: 0 }
    const b = new ChainBudget(() => limits, () => 5)
    for (let i = 0; i < 50; i++) expect(b.take("ops", cron)).toBeNull()
    limits = { perAgentHour: 10, perChainDay: 0 }
    expect(b.take("ops", cron)).not.toBeNull()
  })
})

describe("where the budget is asked (#1756)", () => {
  it("counts every hop once: in the gate before any hop starts, and on /mesh/task's other ways out", async () => {
    const { readFileSync } = await import("fs")
    const src = readFileSync(new URL("../src/daemon/index.ts", import.meta.url), "utf8")
    const gate = src.slice(src.indexOf("private delegationGate("), src.indexOf("private handOffRefusal("))
    expect(gate.indexOf("this.handOffRefusal(caller")).toBeGreaterThan(0)
    expect(gate.indexOf("this.handOffRefusal(")).toBeLessThan(gate.indexOf("this.startCallback("))
    const meshTask = src.slice(src.indexOf('case "POST /mesh/task"'), src.indexOf("// Streaming pass-through"))
    expect(meshTask).toMatch(/meshTaskMode\(body, true\) === "callback" \? null : this\.handOffRefusal\(meshCaller/)
  })
})
