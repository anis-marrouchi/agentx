import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { classifyMutation } from "../src/guard/mutating"
import {
  shouldAskForConfirmation,
  guardRiskQuestions,
  type GuardRiskAnswers,
} from "../src/decisions/seats/guard-risk"
import { finalizeAnswer } from "../src/decisions/normalize"
import { assessRisk } from "../src/guard/risk"
import { configureDecisions, resetDecisionsRuntime } from "../src/decisions/seat"
import type { GuardInput, Verdict } from "../src/guard/types"

// The guard's safety property, stated as tests rather than as a comment:
//
//   1. What runs without asking is decided by deterministic code.
//   2. The model can only ever ADD a confirmation.
//   3. Unknown risk on a destructive command asks.
//
// If any of these fail, the guard is decorative.

function answers(destroys: number, production: number): GuardRiskAnswers {
  return {
    destroys: finalizeAnswer(guardRiskQuestions.destroys, { noul: destroys }).answer,
    production: finalizeAnswer(guardRiskQuestions.production, { noul: production }).answer,
  } as GuardRiskAnswers
}

const allowVerdict: Verdict = {
  matched: false, action: "allow", effectiveAction: "allow",
  ruleId: null, severity: null, message: null, resolvedTarget: null,
}
const denyVerdict: Verdict = { ...allowVerdict, matched: true, action: "deny", effectiveAction: "deny" }
const askVerdict: Verdict = { ...allowVerdict, matched: true, action: "escalate", effectiveAction: "ask" }

const bash = (command: string): GuardInput => ({ tool: "Bash", command } as GuardInput)

describe("classifyMutation — deterministic and over-inclusive", () => {
  it("leaves read-only work alone, so the guard is free on the hot path", () => {
    for (const c of ["ls -la", "cat x.json", "grep -r foo src/", "npm test", "git status", "git log"]) {
      expect(classifyMutation(bash(c)).mutating, c).toBe(false)
    }
  })

  it("flags destruction across filesystem, vcs, db, infra and cloud", () => {
    for (const c of [
      "rm -rf /tmp/x", "shred secrets", "truncate -s 0 log",
      "git reset --hard HEAD~3", "git push --force origin main", "git branch -D main",
      "psql -c 'DELETE FROM users'", "mysql -e 'DROP TABLE orders'", "redis-cli flushall",
      "docker volume rm data", "kubectl delete pod web", "terraform destroy",
      "aws s3 rm s3://bucket --recursive", "gh repo delete acme/x",
      "echo hi > important.txt", "sudo reboot", "pkill -f node",
    ]) {
      expect(classifyMutation(bash(c)).mutating, c).toBe(true)
    }
  })

  it("treats writing tools as mutating without reading a command", () => {
    expect(classifyMutation({ tool: "Write", filePath: "/etc/hosts" } as GuardInput).mutating).toBe(true)
    expect(classifyMutation({ tool: "Edit", filePath: "a.ts" } as GuardInput).mutating).toBe(true)
  })

  it("is a pure function — same input, same answer, no ambient state", () => {
    const a = classifyMutation(bash("rm -rf /tmp/x"))
    const b = classifyMutation(bash("rm -rf /tmp/x"))
    expect(a).toEqual(b)
  })
})

describe("shouldAskForConfirmation — asymmetric by design", () => {
  it("asks well below 'more likely than not', because the costs are not symmetric", () => {
    expect(shouldAskForConfirmation(answers(0.4, 0.0))).toBe(true)
    expect(shouldAskForConfirmation(answers(0.0, 0.4))).toBe(true)
  })

  it("lets either signal alone trigger, so neither excuses the other", () => {
    expect(shouldAskForConfirmation(answers(0.9, 0.0))).toBe(true)
    expect(shouldAskForConfirmation(answers(0.0, 0.9))).toBe(true)
  })

  it("stays quiet only when both are clearly low", () => {
    expect(shouldAskForConfirmation(answers(0.05, 0.05))).toBe(false)
  })
})

describe("assessRisk — the ratchet", () => {
  beforeEach(() => resetDecisionsRuntime())
  afterEach(() => resetDecisionsRuntime())

  it("never consults the model once rules have decided to deny", async () => {
    const r = await assessRisk(bash("rm -rf /"), denyVerdict)
    expect(r.source).toBe("rules")
    expect(r.requiresConfirmation).toBe(false) // deny blocks outright; no dialog
  })

  it("keeps a rules-driven ask, which the model cannot downgrade", async () => {
    const r = await assessRisk(bash("rm -rf /"), askVerdict)
    expect(r.source).toBe("rules")
    expect(r.requiresConfirmation).toBe(true)
  })

  it("does not touch the model for read-only work", async () => {
    const r = await assessRisk(bash("ls -la"), allowVerdict)
    expect(r.source).toBe("not-mutating")
    expect(r.requiresConfirmation).toBe(false)
  })

  it("FAILS CLOSED: seat off means a destructive command still asks", async () => {
    // Seat disabled — askSeat returns null, its documented fail-open
    // behaviour. A guard must invert that.
    const r = await assessRisk(bash("rm -rf /tmp/data"), allowVerdict)
    expect(r.source).toBe("seat-unavailable")
    expect(r.requiresConfirmation).toBe(true)
  })

  it("FAILS CLOSED: a backend that throws still asks", async () => {
    configureDecisions({
      enabled: true,
      defaultBackend: "does-not-exist",
      seats: { "guard-risk": { mode: "active", backend: "does-not-exist" } },
      store: null,
    })
    const r = await assessRisk(bash("git push --force"), allowVerdict)
    expect(r.requiresConfirmation).toBe(true)
    expect(r.source).toBe("seat-unavailable")
  })
})

describe("syntax vs content — the distinction enforce mode forced", () => {
  it("does not read prose as shell syntax", () => {
    // The regression that blocked a real `git commit` the moment enforce
    // mode went on: a heredoc body containing "->" read as a redirect.
    const heredoc = "git commit -F - <<'EOF'\nfix: thing -> other thing\nand a > in prose\nEOF"
    expect(classifyMutation(bash(heredoc)).mutating).toBe(false)
    expect(classifyMutation(bash('git commit -m "arrow -> here"')).mutating).toBe(false)
    expect(classifyMutation(bash('echo "a > b"')).mutating).toBe(false)
  })

  it("still catches a redirect the shell will actually perform", () => {
    expect(classifyMutation(bash("echo hi > file.txt")).mutating).toBe(true)
    expect(classifyMutation(bash("cat a | tee out.txt")).mutating).toBe(true)
  })

  it("does not let quoting launder destructive CONTENT", () => {
    // Quotes are how the payload is delivered, not a disclaimer. This is
    // the case that caught the first, too-aggressive fix.
    expect(classifyMutation(bash("psql -c 'DELETE FROM users'")).mutating).toBe(true)
    expect(classifyMutation(bash('mysql -e "DROP TABLE orders"')).mutating).toBe(true)
    expect(classifyMutation(bash('rm -rf "$HOME/x"')).mutating).toBe(true)
  })
})
