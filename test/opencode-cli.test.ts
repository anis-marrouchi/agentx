import { describe, expect, it } from "vitest"
import { checkOpenCodeVersion } from "../src/tui/opencode-cli"

describe("OpenCode TUI prerequisite", () => {
  it("accepts OpenCode v2", () => {
    expect(checkOpenCodeVersion(() => "opencode v2.0.12")).toEqual({ ok: true, version: "opencode v2.0.12" })
  })

  it("falls back when OpenCode is missing", () => {
    const result = checkOpenCodeVersion(() => { throw Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }) })
    expect(result).toEqual({ ok: false, reason: "OpenCode is not installed or is not on PATH." })
  })

  it("falls back when OpenCode v1 is installed", () => {
    const result = checkOpenCodeVersion(() => "1.18.23")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("too old")
  })

  it("falls back when version output is unrecognized", () => {
    expect(checkOpenCodeVersion(() => "unknown").ok).toBe(false)
  })
})
