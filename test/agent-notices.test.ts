import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AgentNotices, NOTICE_MARKER, MAX_NOTICES, NOTICE_MAX_AGE_MS } from "../src/agents/notices"

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

describe("AgentNotices on a file (#2121)", () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-notices-"))
    file = join(dir, ".agentx", "notices.json")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("keeps notices across a new instance on the same file", () => {
    const logs: string[] = []
    const a = new AgentNotices({ file })
    a.add("coo", "devops", "Mac on battery.")
    const b = new AgentNotices({ file, log: (m) => logs.push(m) })
    expect(b.count("coo")).toBe(1)
    expect(b.take("coo")).toContain("Mac on battery.")
    expect(logs).toEqual(["[notices] 1 notice(s) kept from before the restart"])
  })

  it("take() empties the file so a notice is not delivered twice", () => {
    const a = new AgentNotices({ file })
    a.add("coo", "devops", "x")
    expect(a.take("coo")).not.toBe("")
    expect(new AgentNotices({ file }).count("coo")).toBe(0)
  })

  it("writes only when notices change, never on a check", () => {
    const a = new AgentNotices({ file })
    a.overdue(); a.count("coo"); a.take("coo")
    expect(existsSync(file)).toBe(false)
    a.add("coo", "devops", "x")
    const before = statSync(file).mtimeMs
    utimesSync(file, 0, 0)
    a.overdue(); a.count("coo"); a.take("pm")
    expect(statSync(file).mtimeMs).toBe(0)
    expect(before).toBeGreaterThan(0)
  })

  it("drops notices older than NOTICE_MAX_AGE_MS on load", () => {
    let t = 0
    new AgentNotices({ file, now: () => t }).add("coo", "devops", "old")
    t = NOTICE_MAX_AGE_MS / 2
    new AgentNotices({ file, now: () => t }).add("coo", "devops", "new")
    t = NOTICE_MAX_AGE_MS + 1
    const logs: string[] = []
    const b = new AgentNotices({ file, now: () => t, log: (m) => logs.push(m) })
    expect(b.count("coo")).toBe(1)
    expect(b.take("coo")).toContain("new")
    expect(logs.some((l) => l.includes("dropped 1 notice(s) older than 24 h"))).toBe(true)
  })

  it("drops a repeated id on load", () => {
    mkdirSync(join(dir, ".agentx"), { recursive: true })
    const n = { id: "a1", from: "devops", text: "x", at: Date.now() }
    writeFileSync(file, JSON.stringify({ coo: [n, n], pm: [n] }))
    const b = new AgentNotices({ file })
    expect(b.count("coo") + b.count("pm")).toBe(1)
  })

  it("starts empty on an unreadable file and logs once", () => {
    mkdirSync(join(dir, ".agentx"), { recursive: true })
    writeFileSync(file, "{not json")
    const logs: string[] = []
    const b = new AgentNotices({ file, log: (m) => logs.push(m) })
    expect(b.size).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`couldn't read notices from ${file}`)
  })

  it("logs a failed save with the path and the error", () => {
    writeFileSync(join(dir, "blocker"), "")
    const bad = join(dir, "blocker", "notices.json")
    const logs: string[] = []
    const a = new AgentNotices({ file: bad, log: (m) => logs.push(m) })
    a.add("coo", "devops", "x")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(new RegExp(`couldn't save notices to ${bad} \\(.+\\)`))
  })

  it("overdue() counts from the original send time after a reload", () => {
    let t = 0
    new AgentNotices({ file, now: () => t }).add("coo", "devops", "x")
    t = 1000
    expect(new AgentNotices({ file, now: () => t, maxHoldMs: 1000 }).overdue()).toEqual(["coo"])
  })

  it("keeps the cap and oldest-first order after a reload", () => {
    let t = 0
    const a = new AgentNotices({ file, now: () => t })
    for (let i = 0; i < MAX_NOTICES + 3; i++) { t = i; a.add("coo", "devops", `n${i}`) }
    const b = new AgentNotices({ file, now: () => t })
    expect(b.count("coo")).toBe(MAX_NOTICES)
    const text = b.take("coo")
    expect(text).not.toContain(": n2\n")
    expect(text.indexOf(": n3\n")).toBeLessThan(text.indexOf(": n22\n"))
  })

  it("drop() forgets an agent's notices on disk too", () => {
    const a = new AgentNotices({ file })
    a.add("gone", "devops", "x")
    expect(a.drop("gone")).toBe(1)
    expect(a.drop("gone")).toBe(0)
    expect(new AgentNotices({ file }).count("gone")).toBe(0)
  })
})
