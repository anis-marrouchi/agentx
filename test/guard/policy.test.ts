import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { loadPolicy } from "../../src/guard/policy"

let root: string

function write(rel: string, content: string) {
  const abs = path.join(root, ".agentx/guardrails", rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "guard-policy-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("loadPolicy — layering", () => {
  it("returns the built-in catalog when no files exist", () => {
    const p = loadPolicy(root)
    expect(p.mode).toBe("warn")
    expect(p.rules.some((r) => r.id === "prisma-shadow-against-prod")).toBe(true)
    expect(Object.keys(p.protectedResources)).toHaveLength(0)
  })

  it("global policy.yaml overrides mode; environment adds protected resources", () => {
    write("policy.yaml", "version: 1\nmode: enforce\ndefaults:\n  unmatched: allow\n")
    write("environments/production.yaml", "protected_resources:\n  production:\n    hosts: ['db.prod.example']\n")
    const p = loadPolicy(root)
    expect(p.mode).toBe("enforce")
    expect(p.protectedResources.production.hosts).toContain("db.prod.example")
  })

  it("agents/<id>.yaml rules are auto-scoped to that agent only", () => {
    write("environments/production.yaml", "protected_resources:\n  production:\n    hosts: ['db.prod.example']\n")
    write(
      "agents/coder-agent.yaml",
      "rules:\n  - id: coder-no-prod\n    match: { target_in: production }\n    action: deny\n",
    )
    const forCoder = loadPolicy(root, "coder-agent")
    const forOther = loadPolicy(root, "devops-agent")
    expect(forCoder.rules.some((r) => r.id === "coder-no-prod")).toBe(true)
    expect(forOther.rules.some((r) => r.id === "coder-no-prod")).toBe(false)
  })

  it("an agent-file mode override wins for that agent", () => {
    write("policy.yaml", "mode: warn\n")
    write("agents/devops-agent.yaml", "mode: enforce\nrules: []\n")
    expect(loadPolicy(root, "devops-agent").mode).toBe("enforce")
    expect(loadPolicy(root, "other").mode).toBe("warn")
  })

  it("a malformed policy file is skipped, not fatal", () => {
    write("policy.yaml", "mode: enforce\n")
    write("environments/broken.yaml", "protected_resources: [this is not a map]\n")
    const p = loadPolicy(root)
    expect(p.mode).toBe("enforce") // still loaded the good layer
  })
})
