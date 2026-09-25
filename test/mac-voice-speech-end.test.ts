import { execFileSync } from "child_process"
import { join } from "path"
import { describe, it, expect } from "vitest"

// The voice widget's Swift tests (apps/mac-voice/test.sh): when a spoken
// line has ended, including a `say` that goes quiet and never exits (#58).
// They need macOS and swiftc; the live part speaks at volume 0.
const hasSwift = (() => {
  if (process.platform !== "darwin") return false
  try { execFileSync("swiftc", ["--version"], { stdio: "ignore" }); return true } catch { return false }
})()

describe("mac-voice speech end", () => {
  it.skipIf(!hasSwift)("sees a line end when its voice stops, even if the process keeps running", () => {
    const out = execFileSync(join(__dirname, "..", "apps", "mac-voice", "test.sh"), { encoding: "utf8", timeout: 180_000 })
    expect(out).not.toContain("FAIL")
    expect(out).toContain("ok   0.3 s of quiet after speech is the end")
  }, 180_000)
})
