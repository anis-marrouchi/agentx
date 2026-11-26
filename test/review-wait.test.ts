import { describe, expect, it } from "vitest"
import { ReviewWait, isReleasePr, reviewOwnerText, reviewWakeText } from "../src/channels/review-wait"
import { mkdtempSync, writeFileSync } from "fs"
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
  it("never tells the owner in the reviewer's tick, even after downtime (#2368)", () => {
    const w = make()
    w.green("k", entry())
    // First tick 45 min after green: only the reviewer.
    expect(w.due(min(45)).map((d) => d.kind)).toEqual(["reviewer"])
    // The owner waits owner - wake = 15 min after the real wake.
    expect(w.due(min(59))).toEqual([])
    expect(w.due(min(60)).map((d) => d.kind)).toEqual(["owner"])
  })
  it("with owner minutes at or below wake minutes, the owner comes a tick later", () => {
    const w = new ReviewWait({ wakeMinutes: () => 15, ownerMinutes: () => 10 })
    w.green("k", entry())
    expect(w.due(min(15)).map((d) => d.kind)).toEqual(["reviewer"])
    expect(w.due(min(16)).map((d) => d.kind)).toEqual(["owner"])
  })
  it("a wait saved before wokeAt existed still tells the owner", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rw-")), "w.json")
    writeFileSync(file, JSON.stringify({ k: { ...entry(), woke: true } }))
    expect(make(file).due(min(30)).map((d) => d.kind)).toEqual(["owner"])
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
  it("a reviewed head starts no wait on a later green of it; a new push clears that (#2368 C1)", () => {
    const w = make()
    w.green("k", entry())
    expect(w.reviewed("k")).toBe(true)
    expect(w.green("k", entry())).toBe(false)
    expect(w.settled("k", "aaaa1111bbbb")).toBe(true)
    expect(w.due(min(60))).toEqual([])
    expect(w.pushed("k", "cccc2222")).toBe(false)
    expect(w.settled("k", "aaaa1111bbbb")).toBe(false)
    expect(w.green("k", entry("cccc2222"))).toBe(true)
  })
  it("a review before the green, on that head, starts no wait", () => {
    const w = make()
    expect(w.reviewed("k", "aaaa1111bbbb")).toBe(false)
    expect(w.green("k", entry())).toBe(false)
    expect(w.green("k", entry("cccc2222"))).toBe(true)
  })
  it("keeps the reviewed head across a restart, and reads a file from before it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rw-")), "w.json")
    const a = make(file)
    a.green("k", entry())
    a.reviewed("k")
    expect(make(file).green("k", entry())).toBe(false)
    const old = join(mkdtempSync(join(tmpdir(), "rw-")), "w.json")
    writeFileSync(old, JSON.stringify({ k: entry() }))
    expect(make(old).waiting("k", "aaaa1111bbbb")).toBe(true)
  })
  it("a skipped head is settled until a push; a close forgets all", () => {
    const w = make()
    w.skip("k", "aaaa1111bbbb")
    expect(w.settled("k", "aaaa1111bbbb")).toBe(true)
    w.pushed("k", "cccc2222")
    expect(w.settled("k", "aaaa1111bbbb")).toBe(false)
    w.reviewed("k", "cccc2222")
    expect(w.forget("k")).toBe(false)
    expect(w.green("k", entry("cccc2222"))).toBe(true)
    expect(w.forget("k")).toBe(true)
  })
})
