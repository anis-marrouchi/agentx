import { describe, expect, it } from "vitest"
import { ReviewWait, isReleasePr, reviewOwnerText, reviewWakeText } from "../src/channels/review-wait"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The green-PR review wait (#2227).

const T0 = Date.parse("2026-11-26T12:00:00Z")
const min = (n: number) => T0 + n * 60_000
const entry = (sha = "aaaa1111bbbb") => ({ repo: "o/r", number: 7, sha, greenAt: new Date(T0).toISOString(), owner: "devops-agent", title: "feat: x" })
const make = (file?: string) => new ReviewWait({ file, wakeMinutes: () => 15, ownerMinutes: () => 30 })

describe("green-PR review wait", () => {
  it("wakes the reviewer at 15 min and tells the owner at 30, once each", () => {
    const w = make()
    expect(w.green("k", entry())).toBe(true)
    expect(w.due(min(14))).toEqual([])
    expect(w.due(min(15)).map((d) => d.kind)).toEqual(["reviewer"])
    expect(w.due(min(20))).toEqual([])
    expect(w.due(min(30)).map((d) => d.kind)).toEqual(["owner"])
    expect(w.due(min(90))).toEqual([])
  })
  it("keeps the first start on a repeat green of the same head", () => {
    const w = make()
    w.green("k", entry())
    expect(w.green("k", { ...entry(), greenAt: new Date(min(10)).toISOString() })).toBe(false)
    expect(w.due(min(15)).map((d) => d.kind)).toEqual(["reviewer"])
  })
  it("ends on a new push; the new head's green starts again", () => {
    const w = make()
    w.green("k", entry())
    expect(w.pushed("k", "aaaa1111bbbb")).toBe(false)
    expect(w.pushed("k", "cccc2222")).toBe(true)
    expect(w.due(min(40))).toEqual([])
    expect(w.green("k", { ...entry("cccc2222"), greenAt: new Date(min(40)).toISOString() })).toBe(true)
    expect(w.due(min(55)).map((d) => d.kind)).toEqual(["reviewer"])
  })
  it("ends on a review, a reviewer comment or a close", () => {
    const w = make()
    w.green("k", entry())
    expect(w.end("k")).toBe(true)
    expect(w.end("k")).toBe(false)
    expect(w.due(min(60))).toEqual([])
  })
  it("survives a restart without waking twice", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rw-")), "w.json")
    const a = make(file)
    a.green("k", entry())
    expect(a.due(min(16)).map((d) => d.kind)).toEqual(["reviewer"])
    const b = make(file)
    expect(b.waiting("k", "aaaa1111bbbb")).toBe(true)
    expect(b.due(min(17))).toEqual([])
    expect(b.due(min(31)).map((d) => d.kind)).toEqual(["owner"])
  })
  it("never waits on a release PR", () => {
    expect(isReleasePr("chore(main): release 0.280.0", "release-please--branches--main")).toBe(true)
    expect(isReleasePr("feat(hub): x", "release-please--branches--main")).toBe(true)
    expect(isReleasePr("feat(hub): x", "2226-s1")).toBe(false)
  })
  it("says what to do in the wake texts", () => {
    expect(reviewWakeText(entry(), 15)).toContain("green for 15 min")
    expect(reviewOwnerText(entry(), 30, "pm-agent")).toContain("pm-agent was woken")
  })
})
