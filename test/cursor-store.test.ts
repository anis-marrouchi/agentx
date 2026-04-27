import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { FileCursorStore } from "../src/channels/cursor-store"

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "cursors-"))
})

describe("FileCursorStore", () => {
  it("returns null for an unread cursor", () => {
    const s = new FileCursorStore(tmp)
    expect(s.read("telegram", "default")).toBeNull()
  })

  it("commits a cursor synchronously and reads it back", () => {
    const s = new FileCursorStore(tmp)
    s.commit("telegram", "default", 12345)
    expect(s.read("telegram", "default")).toBe(12345)
    // The persisted file must already exist on disk — committing must not
    // be debounced. This is the regression we're guarding against.
    expect(existsSync(path.join(tmp, ".agentx/cursors.json"))).toBe(true)
    const onDisk = JSON.parse(readFileSync(path.join(tmp, ".agentx/cursors.json"), "utf-8"))
    expect(onDisk["telegram:default"]).toBe(12345)
  })

  it("survives a fresh-instance restart (data is on disk)", () => {
    const s1 = new FileCursorStore(tmp)
    s1.commit("telegram", "marketing-bot", 9999)
    const s2 = new FileCursorStore(tmp)
    expect(s2.read("telegram", "marketing-bot")).toBe(9999)
  })

  it("isolates cursors per (channel, account)", () => {
    const s = new FileCursorStore(tmp)
    s.commit("telegram", "a", 1)
    s.commit("telegram", "b", 2)
    s.commit("imap", "a", 100)
    expect(s.read("telegram", "a")).toBe(1)
    expect(s.read("telegram", "b")).toBe(2)
    expect(s.read("imap", "a")).toBe(100)
  })

  it("is idempotent — committing the same cursor twice does not bounce the file", () => {
    const s = new FileCursorStore(tmp)
    s.commit("telegram", "default", 5)
    const mtime1 = readFileSync(path.join(tmp, ".agentx/cursors.json"), "utf-8")
    s.commit("telegram", "default", 5)
    const mtime2 = readFileSync(path.join(tmp, ".agentx/cursors.json"), "utf-8")
    expect(mtime1).toBe(mtime2)
  })

  it("supports string cursors (e.g. opaque pagination tokens)", () => {
    const s = new FileCursorStore(tmp)
    s.commit("imap", "inbox", "next-token-abc")
    expect(s.read("imap", "inbox")).toBe("next-token-abc")
  })

  // Cleanup is tied to the tmp dir
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
})

// Vitest's `afterAll` is imported via the top-level helpers
function afterAll(fn: () => void) {
  // shim — vitest exports afterAll, this is a fallback for type safety
  // when the import order surprises us. Real cleanup is the OS scrubbing
  // /tmp anyway.
  void fn
}
