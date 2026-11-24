import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { evaluate } from "../../src/guard/engine"
import { resolveInMemory } from "../../src/guard/policy"
import { guardPolicySchema, type GuardInput, type GuardMode, type GuardPolicy } from "../../src/guard/types"

// Arms the production protected set so the catalog's `target_in: production`
// rules can bite. Host-based so it works via process.env below.
const PROD_POLICY: GuardPolicy = guardPolicySchema.parse({
  protected_resources: { production: { resolve_env: true, hosts: ["api.demosite.example.com"] } },
})

function run(command: string, mode: GuardMode, extra?: Partial<GuardInput>, policy: GuardPolicy = PROD_POLICY) {
  const resolved = resolveInMemory({ ...policy, mode })
  return evaluate({ tool: "Bash", command, ...extra }, resolved)
}

const PROD_DB = "postgres://user:pw@api.demosite.example.com:5432/app"

beforeEach(() => {
  process.env.DATABASE_URL = PROD_DB
})
afterEach(() => {
  delete process.env.DATABASE_URL
})

describe("engine — the incident", () => {
  const incident =
    'npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --script'

  it("DENIES prisma migrate diff --shadow-database-url resolving to prod", () => {
    const v = run(incident, "enforce")
    expect(v.action).toBe("deny")
    expect(v.ruleId).toBe("prisma-shadow-against-prod")
    expect(v.resolvedTarget).toBe("api.demosite.example.com")
    expect(v.effectiveAction).toBe("deny")
  })

  it("in warn mode records the deny but enforces allow", () => {
    const v = run(incident, "warn")
    expect(v.action).toBe("deny")
    expect(v.effectiveAction).toBe("allow")
  })

  it("does NOT deny the same diff against a non-prod shadow db", () => {
    process.env.DATABASE_URL = "postgres://user:pw@localhost:5432/dev"
    const v = run(incident, "enforce")
    expect(v.action).toBe("allow")
    expect(v.matched).toBe(false)
  })
})

describe("engine — catalog precision (low false positives)", () => {
  it("prisma generate is allowed", () => {
    expect(run("npx prisma generate", "enforce").action).toBe("allow")
  })
  it("prisma migrate deploy against prod escalates (not deny)", () => {
    const v = run("DATABASE_URL=$DATABASE_URL npx prisma migrate deploy", "enforce")
    expect(v.ruleId).toBe("prisma-migrate-deploy-prod")
    expect(v.action).toBe("escalate")
    expect(v.effectiveAction).toBe("ask")
  })
  it("prisma migrate reset against prod is denied", () => {
    const v = run("npx prisma migrate reset --force --url=$DATABASE_URL", "enforce")
    expect(v.action).toBe("deny")
  })
})

describe("engine — filesystem + vcs (target-independent)", () => {
  it("rm -rf on a real path escalates", () => {
    expect(run("rm -rf /var/www/app", "enforce").ruleId).toBe("fs-recursive-delete")
  })
  it("rm -rf on a scratch path is exempt", () => {
    expect(run("rm -rf /tmp/build-cache", "enforce").matched).toBe(false)
    expect(run("rm -rf node_modules", "enforce").matched).toBe(false)
  })
  it("git push --force escalates but --force-with-lease does not", () => {
    expect(run("git push --force origin main", "enforce").ruleId).toBe("git-force-push")
    expect(run("git push --force-with-lease origin main", "enforce").matched).toBe(false)
  })
})

describe("engine — mode + precedence", () => {
  it("mode off allows everything", () => {
    const v = run("npx prisma migrate reset --url=$DATABASE_URL", "off")
    expect(v.effectiveAction).toBe("allow")
  })

  it("an explicit deny is never downgraded by a lower-priority match", () => {
    // A custom allow rule for the same command must not beat the catalog deny.
    const policy: GuardPolicy = {
      ...PROD_POLICY,
      rules: [{ id: "loose-allow", match: { tool: "Bash", command_regex: "prisma" }, action: "allow", preconditions: [] }],
    }
    const v = run("npx prisma migrate reset --url=$DATABASE_URL", "enforce", {}, policy)
    expect(v.action).toBe("deny")
  })

  it("unmatched commands follow defaults.unmatched", () => {
    expect(run("ls -la", "enforce").action).toBe("allow")
  })
})

describe("engine — ambient connection targets", () => {
  // `prisma migrate reset` names no target; it reads DATABASE_URL implicitly.
  // Without ambient resolution this sailed through as allow even in a
  // prod-configured workspace (found during peer deploy verification).
  it("catches a destructive command that names no target but reads ambient DATABASE_URL", () => {
    const v = run("npx prisma migrate reset --force", "enforce")
    expect(v.action).toBe("deny")
    expect(v.ruleId).toBe("prisma-reset-or-force-push-prod")
    expect(v.resolvedTarget).toBe("api.demosite.example.com")
  })

  it("allows it once the ambient env is not production", () => {
    process.env.DATABASE_URL = "postgres://user:pw@localhost:5432/dev"
    expect(run("npx prisma migrate reset --force", "enforce").matched).toBe(false)
  })

  it("ambient targets do NOT arm a bare target_in rule (no `ls` false positives)", () => {
    const policy: GuardPolicy = guardPolicySchema.parse({
      protected_resources: { production: { resolve_env: true, hosts: ["api.demosite.example.com"] } },
      agents: {
        "coder-agent": { rules: [{ id: "coder-no-prod", match: { target_in: "production" }, action: "deny" }] },
      },
    })
    const resolved = resolveInMemory({ ...policy, mode: "enforce" }, "coder-agent")
    // Ambient DATABASE_URL is prod, but `ls` references no target.
    expect(evaluate({ tool: "Bash", command: "ls -la", agentId: "coder-agent" }, resolved).matched).toBe(false)
    // An explicit reference still trips it.
    expect(
      evaluate({ tool: "Bash", command: "psql $DATABASE_URL -c 'select 1'", agentId: "coder-agent" }, resolved).ruleId,
    ).toBe("coder-no-prod")
  })
})

describe("engine — agent-scoped deny", () => {
  it("coder-no-prod denies any prod-targeting command for that agent", () => {
    const policy: GuardPolicy = {
      ...PROD_POLICY,
      agents: {
        "coder-agent": {
          rules: [{ id: "coder-no-prod", match: { target_in: "production" }, action: "deny", preconditions: [] }],
        },
      },
    }
    const resolved = resolveInMemory({ ...policy, mode: "enforce" }, "coder-agent")
    const v = evaluate({ tool: "Bash", command: "psql $DATABASE_URL -c 'select 1'", agentId: "coder-agent" }, resolved)
    expect(v.ruleId).toBe("coder-no-prod")
    expect(v.action).toBe("deny")
  })
})

describe("issue completeness", () => {
  const policy = resolveInMemory(guardPolicySchema.parse({
    mode: "warn",
    rules: [{ id: "issue-complete", check: "issue-complete", match: {}, action: "deny", mode: "enforce" }],
  }))
  const tool = "mcp__noqta_gitlab_server__create_issue"
  const description = "- [ ] Check staging\n/estimate 30m"

  it("reads a literal glab description and leaves shell expansions unchecked", () => {
    const check = (command: string) => evaluate({ tool: "Bash", command }, policy)
    expect(check("glab issue create -t Test -m 7 -d '- [ ] Check staging'")).toMatchObject({
      effectiveAction: "deny",
      message: "missing: /estimate",
    })
    expect(check(`glab issue create --title=Test --milestone=7 --description='${description}'`).effectiveAction).toBe("allow")
    expect(check('glab issue create -t Test -d "$DESCRIPTION"').effectiveAction).toBe("allow")
  })

  it("requires a milestone on an otherwise complete GitLab issue", () => {
    expect(evaluate({ tool, toolInput: { description } }, policy)).toMatchObject({
      ruleId: "issue-complete",
      effectiveAction: "deny",
      message: "missing: milestone",
    })
    expect(evaluate({ tool, toolInput: { description, milestone_id: 7 } }, policy).effectiveAction).toBe("allow")
    expect(evaluate({ tool: "mcp__github__create_issue", toolInput: {} }, policy).effectiveAction).toBe("allow")
  })
})
