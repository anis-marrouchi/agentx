import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { GroupLog } from "../src/channels/group-log"
import { rmSync } from "fs"
import { resolve } from "path"

const TEST_DIR = resolve(__dirname, "../.test-group-log")

describe("GroupLog", () => {
  let log: GroupLog

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    log = new GroupLog(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it("adds and retrieves entries", () => {
    log.add("group-1", "Anis", "Hello")
    log.add("group-1", "Nadia", "Hi there")

    const entries = log.getEntries("group-1")
    expect(entries).toHaveLength(2)
    expect(entries[0].sender).toBe("Anis")
    expect(entries[1].sender).toBe("Nadia")
  })

  it("builds conversation context", () => {
    log.add("g1", "Anis", "What about deployment?")
    log.add("g1", "Nadia", "Staging is ready")
    log.add("g1", "Anis", "@devops can you deploy?")

    const context = log.buildContext("g1")
    expect(context).toContain("[Recent group conversation]")
    expect(context).toContain("What about deployment?")
    expect(context).toContain("Staging is ready")
    // Last message excluded (it's the current one)
    expect(context).not.toContain("can you deploy?")
  })

  it("returns empty context for single message", () => {
    log.add("g1", "Anis", "Hello")
    expect(log.buildContext("g1")).toBe("")
  })

  it("returns empty context for unknown group", () => {
    expect(log.buildContext("unknown")).toBe("")
  })

  it("persists across instances", () => {
    log.add("g1", "Anis", "Message 1")
    log.add("g1", "Nadia", "Message 2")

    const log2 = new GroupLog(TEST_DIR)
    const entries = log2.getEntries("g1")
    expect(entries).toHaveLength(2)
  })

  it("trims to max entries", () => {
    for (let i = 0; i < 40; i++) {
      log.add("g1", "user", `msg ${i}`)
    }
    const entries = log.getEntries("g1")
    expect(entries.length).toBeLessThanOrEqual(30)
  })

  it("isolates groups", () => {
    log.add("g1", "A", "in group 1")
    log.add("g2", "B", "in group 2")

    expect(log.getEntries("g1")).toHaveLength(1)
    expect(log.getEntries("g2")).toHaveLength(1)
  })
})
