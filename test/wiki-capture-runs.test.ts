import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { recordCaptureSkip, recordCaptureWrite, summariseCaptureRuns } from "../src/wiki/capture-runs"

const at = (iso: string) => () => new Date(iso)

describe("wiki capture outcomes (#603)", () => {
  it("logs and counts a skip with its reason, a write, and a failed write", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-runs-"))
    const file = join(dir, "_capture-runs.jsonl")
    const logs: string[] = []
    try {
      recordCaptureSkip(file, "ops", { capture: false, reason: "response too short" }, (m) => logs.push(m), new Date("2026-10-30T10:00:00Z"))
      expect(recordCaptureWrite(file, "ops", () => {}, (m) => logs.push(m), at("2026-10-30T10:01:00Z"))).toBe(true)
      expect(recordCaptureWrite(file, "ops", () => { throw new Error("disk full") }, (m) => logs.push(m), at("2026-10-30T10:02:00Z"))).toBe(false)

      expect(logs).toEqual(["[ops] not captured in the wiki: response too short", "[ops] wiki entry not written: disk full"])
      const text = readFileSync(file, "utf-8")
      expect(text).not.toContain("disk full")
      expect(summariseCaptureRuns(text)).toEqual({ total: 3, captured: 1, skipped: 1, failed: 1, skippedBy: { "response too short": 1 } })
      expect(summariseCaptureRuns(text, "2026-10-30T10:01")).toEqual({ total: 2, captured: 1, skipped: 0, failed: 1, skippedBy: {} })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("never fails the task when the log cannot be written", () => {
    const logs: string[] = []
    const file = join(tmpdir(), "no-such-dir-603", "x", "_capture-runs.jsonl")
    expect(recordCaptureWrite(file, "ops", () => {}, (m) => logs.push(m))).toBe(true)
    expect(logs[0]).toMatch(/could not record a capture outcome/)
  })

  it("skips lines it cannot read", () => {
    expect(summariseCaptureRuns('nope\n{"at":"x","outcome":"other"}\n{"at":"2026-10-30","agent":"a","outcome":"skipped"}\n')).toEqual({
      total: 1, captured: 0, skipped: 1, failed: 0, skippedBy: { filtered: 1 },
    })
  })
})
