import { describe, it, expect } from "vitest"
import { resolvePermission } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"

const make = (mode: string | undefined): AgentDef => ({
  name: "x",
  workspace: "/tmp",
  tier: "claude-code",
  permissionMode: mode,
} as unknown as AgentDef)

describe("resolvePermission (improvement plan #4)", () => {
  it("bypassPermissions → skipPermissions=true with explicit flag in summary", () => {
    const r = resolvePermission(make("bypassPermissions"))
    expect(r.configured).toBe("bypassPermissions")
    expect(r.skipPermissions).toBe(true)
    expect(r.summary).toContain("--dangerously-skip-permissions")
  })

  it("default → skipPermissions=false, summary mentions no skip flag", () => {
    const r = resolvePermission(make("default"))
    expect(r.configured).toBe("default")
    expect(r.skipPermissions).toBe(false)
    expect(r.summary).not.toContain("--dangerously-skip-permissions")
    expect(r.summary).toContain("no skip-permissions")
  })

  it("plan / acceptEdits / auto / dontAsk → skipPermissions=false", () => {
    for (const mode of ["plan", "acceptEdits", "auto", "dontAsk"]) {
      const r = resolvePermission(make(mode))
      expect(r.skipPermissions, `${mode} should not skip`).toBe(false)
      expect(r.configured).toBe(mode)
    }
  })

  it("missing permissionMode falls back to 'default'", () => {
    const r = resolvePermission(make(undefined))
    expect(r.configured).toBe("default")
    expect(r.skipPermissions).toBe(false)
  })
})
