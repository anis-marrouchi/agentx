import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { chmodSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { executeClaudeCode } from "../src/agents/runtime"

// A `claude` that is stopped by SIGTERM (exit 143) a moment after it starts,
// the way a daemon shutdown stops it. Long before its time limit.
describe("claude-code exit 143 before the time limit", () => {
  const origPath = process.env.PATH
  let workspace: string

  beforeAll(() => {
    const bin = mkdtempSync(join(tmpdir(), "agentx-sigterm-claude-"))
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 143\n")
    chmodSync(join(bin, "claude"), 0o755)
    process.env.PATH = `${bin}:${origPath}`
    workspace = mkdtempSync(join(tmpdir(), "agentx-sigterm-ws-"))
  })
  afterAll(() => { process.env.PATH = origPath })

  it("is reported as interrupted, not as a timeout to raise", async () => {
    const res = await executeClaudeCode(
      { id: "a", name: "Demo", tier: "claude-code", workspace, maxExecutionMinutes: 90 } as any,
      { agentId: "a", message: "hi" } as any,
    )
    expect(res.errorKind).toBe("interrupted")
    expect(res.error).toMatch(/before its 90m time limit/)
    expect(res.error).not.toMatch(/maxExecutionMinutes/)
  })
})
