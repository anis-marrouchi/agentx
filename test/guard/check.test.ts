import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { decisionOutput } from "../../src/guard/check"
import { runGuard, payloadToInput } from "../../src/guard/check"
import { listDecisions } from "../../src/guard/audit"
import { closeDb } from "../../src/storage/sqlite"
import type { Verdict } from "../../src/guard/types"

let root: string

function write(rel: string, content: string) {
  const abs = path.join(root, ".agentx/guardrails", rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

beforeEach(() => {
  closeDb()
  root = mkdtempSync(path.join(tmpdir(), "guard-check-"))
  process.env.DATABASE_URL = "postgres://user:pw@api.hackathonat.com:5432/app"
})
afterEach(() => {
  closeDb()
  delete process.env.DATABASE_URL
  rmSync(root, { recursive: true, force: true })
})

function mkVerdict(over: Partial<Verdict>): Verdict {
  return {
    matched: true,
    action: "deny",
    effectiveAction: "deny",
    ruleId: "prisma-shadow-against-prod",
    severity: "critical",
    message: "never point shadow at prod",
    resolvedTarget: "api.hackathonat.com",
    ...over,
  }
}

describe("decisionOutput — Claude Code contract", () => {
  it("emits a deny hookSpecificOutput when enforced", () => {
    const { stdout } = decisionOutput(mkVerdict({ effectiveAction: "deny" }))
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse")
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[agentx-guard]")
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("api.hackathonat.com")
  })

  it("maps escalate -> ask", () => {
    const { stdout } = decisionOutput(mkVerdict({ action: "escalate", effectiveAction: "ask" }))
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("ask")
  })

  it("warn mode (would-deny) emits a systemMessage but no permissionDecision", () => {
    const { stdout } = decisionOutput(mkVerdict({ effectiveAction: "allow" }))
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput).toBeUndefined()
    expect(parsed.systemMessage).toContain("WARN")
  })

  it("a plain allow emits nothing", () => {
    const { stdout } = decisionOutput({
      matched: false,
      action: "allow",
      effectiveAction: "allow",
      ruleId: null,
      severity: null,
      message: null,
      resolvedTarget: null,
    })
    expect(stdout).toBe("")
  })
})

describe("runGuard — end to end with audit", () => {
  it("evaluates the incident payload and writes an audit row (warn mode)", () => {
    write("policy.yaml", "mode: warn\n")
    write("environments/production.yaml", "protected_resources:\n  production:\n    resolve_env: true\n    hosts: ['api.hackathonat.com']\n")

    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'npx prisma migrate diff --shadow-database-url "$DATABASE_URL" --script' },
      cwd: root,
    }
    const input = payloadToInput(payload, "devops-agent")
    const { verdict, mode } = runGuard(input, { root, agentId: "devops-agent" })

    expect(verdict.action).toBe("deny")
    expect(verdict.effectiveAction).toBe("allow") // warn mode downgrade
    expect(mode).toBe("warn")

    const rows = listDecisions({ root, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe("deny")
    expect(rows[0].effective_action).toBe("allow")
    expect(rows[0].agent_id).toBe("devops-agent")
    expect(rows[0].matched_rule).toBe("prisma-shadow-against-prod")
    expect(rows[0].resolved_target).toBe("api.hackathonat.com")
  })
})
