import { describe, it, expect } from "vitest"
import { WorkLanes, workKeyOf, takesNotices, SAME_WORK_MARKER } from "../src/agents/work-lane"

const REQ = "req-01M6TKA0XQ92ADP3408JTM88S6"

describe("workKeyOf", () => {
  it("keys an agent's message on the owner's request it names", () => {
    expect(workKeyOf(`About the posting box (${REQ}): go.`, "a2a")).toBe(REQ)
    expect(workKeyOf(`[agentx:plan-step id=${REQ} step=1] You own step 1`, "requests")).toBe(REQ)
  })
  it("never holds back a person's chat or a message with no request", () => {
    expect(workKeyOf(`Do ${REQ} now`, "app")).toBeNull()
    expect(workKeyOf(`Do ${REQ} now`, "telegram")).toBeNull()
    expect(workKeyOf("Deploy the fix", "a2a")).toBeNull()
  })
  it("never holds back the operator's or a visitor's chat", () => {
    for (const ch of ["dashboard", "web-chat", "tui", "admin", "test-drive", "guest", "public-api"]) {
      expect(workKeyOf(`Do ${REQ} now`, ch)).toBeNull()
    }
  })
})

describe("takesNotices", () => {
  it("lets notices ride only on agent work", () => {
    for (const ch of ["a2a", "cron", "workflow", "reminder", "events", "business"]) expect(takesNotices(ch)).toBe(true)
  })
  it("keeps notices off person, visitor and parsed internal runs", () => {
    for (const ch of ["app", "telegram", "guest", "public-api", "web-chat", "dashboard", "subagent", "api", "whatsapp-triage", "selftest", undefined]) {
      expect(takesNotices(ch)).toBe(false)
    }
  })
})

describe("WorkLanes", () => {
  it("makes a second run of the same agent on the same request wait, then tells it what the first said", async () => {
    const lanes = new WorkLanes()
    const first = await lanes.enter("devops", REQ, "root-a")
    expect(first.note).toBe("")
    let secondNote: string | null = null
    const second = lanes.enter("devops", REQ, "root-b").then((e) => { secondNote = e.note; return e })
    await new Promise((r) => setTimeout(r, 20))
    expect(secondNote).toBeNull()
    first.release({ text: "Box posting-1 built at 10.0.0.5.", ok: true })
    const e2 = await second
    expect(secondNote).toContain(SAME_WORK_MARKER)
    expect(e2.note).toContain("Box posting-1 built at 10.0.0.5.")
    expect(e2.note).toContain("Do not do again what it already did")
    e2.release({ text: "ok", ok: true })
  })

  it("lets other agents, other requests and the same chain of work through at once", async () => {
    const lanes = new WorkLanes()
    const held = await lanes.enter("devops", REQ, "root-a")
    const quick = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))])
    expect(await quick(lanes.enter("coder", REQ, "root-b"))).toBe(true)
    expect(await quick(lanes.enter("devops", "req-01M6TKA0XQ92ADP3408JTM88S7", "root-b"))).toBe(true)
    expect(await quick(lanes.enter("devops", REQ, "root-a"))).toBe(true)
    held.release({ text: "", ok: true })
  })

  it("goes ahead after the wait limit instead of dropping the run", async () => {
    let t = 0
    const lanes = new WorkLanes({ now: () => t, sleep: async () => { t += 60_000 }, waitMs: 120_000 })
    await lanes.enter("devops", REQ, "a")
    const e = await lanes.enter("devops", REQ, "b")
    expect(e.waitedMs).toBeGreaterThan(120_000)
  })

  it("tells nothing about a run that was only queued", async () => {
    const lanes = new WorkLanes()
    const a = await lanes.enter("devops", REQ)
    a.release({ text: "", ok: true, ran: false })
    const b = await lanes.enter("devops", REQ)
    expect(b.note).toBe("")
  })
})
