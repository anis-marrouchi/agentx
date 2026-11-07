import { describe, it, expect } from "vitest"
import { AgentNotices, NOTICE_MARKER, MAX_NOTICES } from "../src/agents/notices"

describe("AgentNotices", () => {
  it("keeps notices per agent and hands them out once, oldest first", () => {
    let t = 0
    const n = new AgentNotices({ now: () => t })
    n.add("coo", "devops", "Mac on battery for 30 min, now 63%.")
    t = 5 * 60_000
    n.add("coo", "devops", "Disk hold numbers met.")
    expect(n.take("pm")).toBe("")
    const text = n.take("coo")
    expect(text.startsWith(NOTICE_MARKER)).toBe(true)
    expect(text.indexOf("battery")).toBeLessThan(text.indexOf("Disk"))
    expect(text).toContain("5 min ago, from devops")
    expect(n.take("coo")).toBe("")
  })

  it("names agents whose oldest notice waited past the hold", () => {
    let t = 0
    const n = new AgentNotices({ now: () => t, maxHoldMs: 1000 })
    n.add("coo", "devops", "x")
    expect(n.overdue()).toEqual([])
    t = 1000
    expect(n.overdue()).toEqual(["coo"])
  })

  it("drops the oldest past the cap", () => {
    const n = new AgentNotices()
    for (let i = 0; i < MAX_NOTICES + 3; i++) n.add("coo", "devops", `n${i}`)
    expect(n.count("coo")).toBe(MAX_NOTICES)
    expect(n.take("coo")).not.toContain(": n0\n")
  })
})
