import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  accountHolds, activeProviderHolds, clearDispatchHistory, liftProviderHolds, preflightQuotaGate,
  recordRateLimitEvent, setActiveAccountResolver,
} from "../src/agents/claude-code-quota"
import { changeCliAccounts, cliAccountForDir, readCliAccounts, withCliAccountEnv } from "../src/agents/cli-accounts"
import { PlanUsageReader } from "../src/agents/claude-plan-usage"
import { clearAccountsPlanUsage, readAccountsPlanUsage } from "../src/agents/plan-usage-accounts"
import { handlePlanUsageApi } from "../src/daemon/plan-usage-api"
import { cliAccountOfWorkspace } from "../src/utils/workspace-env"

// #2113 C1: each Claude account has its own plan windows, so a used-up
// account holds only the runs on that account.

const T0 = Date.UTC(2026, 10, 27, 9, 0, 0)
const rejected = {
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor((T0 + 40 * 60_000) / 1000) },
}

let dir: string
let file: string
beforeEach(() => {
  clearDispatchHistory()
  setActiveAccountResolver(() => "work")
  dir = mkdtempSync(join(tmpdir(), "acct-holds-"))
  file = join(dir, ".agentx", "cli-accounts.json")
})
afterEach(() => {
  setActiveAccountResolver()
  rmSync(dir, { recursive: true, force: true })
})

describe("holds per account", () => {
  it("a rejected window on account A does not gate a cold run on account B", () => {
    recordRateLimitEvent(rejected, T0, undefined, "A")
    expect(preflightQuotaGate(false, T0 + 60_000, undefined, undefined, "A")?.reason).toBe("provider_rate_limit")
    expect(preflightQuotaGate(false, T0 + 60_000, undefined, undefined, "B")).toBeNull()
  })

  it("the refusal names the account to lift", () => {
    recordRateLimitEvent(rejected, T0, undefined, "A")
    expect(preflightQuotaGate(false, T0 + 60_000, undefined, undefined, "A")?.message).toContain("--lift --account A")
  })

  it("lifting account A leaves account B held", () => {
    recordRateLimitEvent(rejected, T0, undefined, "A")
    recordRateLimitEvent(rejected, T0, undefined, "B")
    expect(liftProviderHolds(T0 + 60_000, "A").map((s) => s.window)).toEqual(["five_hour"])
    expect(activeProviderHolds(T0 + 60_000, "A")).toEqual([])
    expect(activeProviderHolds(T0 + 60_000, "B").map((s) => s.window)).toEqual(["five_hour"])
  })

  it("without an account, calls mean the active account", () => {
    recordRateLimitEvent(rejected, T0)
    expect(activeProviderHolds(T0 + 60_000, "work")).toHaveLength(1)
    expect(liftProviderHolds(T0 + 60_000)).toHaveLength(1)
    expect(activeProviderHolds(T0 + 60_000, "work")).toEqual([])
  })

  it("lift ?account= on the API lifts that account only", () => {
    recordRateLimitEvent(rejected, T0, undefined, "A")
    recordRateLimitEvent(rejected, T0, undefined, "work")
    const r = handlePlanUsageApi("POST", "/usage/plan/lift", T0 + 60_000, { account: "A" })
    expect((r.body as any).lifted).toHaveLength(1)
    expect(activeProviderHolds(T0 + 60_000, "work")).toHaveLength(1)
  })

  it("accountHolds lists the active account first, by name only", () => {
    recordRateLimitEvent(rejected, T0, undefined, "A")
    const all = accountHolds(T0 + 60_000)
    expect(all.map((a) => [a.account, a.active, a.holds.length])).toEqual([["work", true, 0], ["A", false, 1]])
    const get = handlePlanUsageApi("GET", "/usage/plan", T0 + 60_000)
    expect((get.body as any).accountHolds.map((a: any) => a.account)).toEqual(["work", "A"])
  })
})

describe("the account of a run (Hakim condition 1)", () => {
  const ws = (name: string, envLine?: string) => {
    const w = join(dir, name)
    mkdirSync(w, { recursive: true })
    if (envLine) writeFileSync(join(w, ".env"), envLine + "\n")
    return w
  }

  it("an agent's .env folder maps to the profile with that folder, by resolved path", () => {
    const work = join(dir, "claude-work")
    mkdirSync(work)
    symlinkSync(work, join(dir, "work-link"))
    changeCliAccounts({ provider: "claude", action: "add", name: "work", dir: work }, file, dir)
    const state = readCliAccounts(file)
    // Same folder written three ways: trailing slash, "..", a symlink.
    const a = ws("a", `CLAUDE_CONFIG_DIR=${work}/`)
    const b = ws("b", `CLAUDE_CONFIG_DIR=${join(dir, "x", "..", "claude-work")}`)
    const c = ws("c", `CLAUDE_CONFIG_DIR=${join(dir, "work-link")}`)
    for (const w of [a, b, c]) expect(cliAccountOfWorkspace("claude", w, "agent", state).account).toBe("work")
  })

  it("a folder no profile has is env:<agentId>", () => {
    const state = readCliAccounts(file)
    const a = ws("a", `CLAUDE_CONFIG_DIR=${join(dir, "loose")}`)
    expect(cliAccountOfWorkspace("claude", a, "alpha", state).account).toBe("env:alpha")
  })

  it("the CLI's own folder is the default profile", () => {
    expect(cliAccountForDir("claude", join(dir, ".claude"), "env:x", {}, dir)).toBe("default")
  })

  it("an agent with no folder in its .env uses the active profile", () => {
    changeCliAccounts({ provider: "claude", action: "add", name: "work", dir: join(dir, "claude-work") }, file, dir)
    changeCliAccounts({ provider: "claude", action: "use", name: "work" }, file, dir)
    const r = cliAccountOfWorkspace("claude", ws("plain"), "agent", readCliAccounts(file))
    expect(r).toEqual({ account: "work", dir: join(dir, "claude-work") })
  })
})

describe("per-vendor default (A1)", () => {
  it("switching Claude leaves Codex's active profile and CODEX_HOME as they were, and the other way", () => {
    changeCliAccounts({ provider: "claude", action: "add", name: "cw", dir: "/tmp/claude-cw" }, file, dir)
    changeCliAccounts({ provider: "codex", action: "add", name: "xw", dir: "/tmp/codex-xw" }, file, dir)
    changeCliAccounts({ provider: "codex", action: "use", name: "xw" }, file, dir)

    changeCliAccounts({ provider: "claude", action: "use", name: "cw" }, file, dir)
    let s = readCliAccounts(file)
    expect(s.codex?.active).toBe("xw")
    expect(withCliAccountEnv({}, [], s).CODEX_HOME).toBe("/tmp/codex-xw")

    changeCliAccounts({ provider: "codex", action: "use", name: "default" }, file, dir)
    s = readCliAccounts(file)
    expect(s.claude?.active).toBe("cw")
    expect(withCliAccountEnv({}, [], s).CLAUDE_CONFIG_DIR).toBe("/tmp/claude-cw")
    expect(withCliAccountEnv({}, [], s).CODEX_HOME).toBeUndefined()
  })
})

describe("priority holds for an account not in use (#2347 reading)", () => {
  afterEach(() => clearAccountsPlanUsage())

  it("a background run on a non-active account is held by that account's own reading", async () => {
    const reader = () => new PlanUsageReader({
      now: () => T0,
      readLogin: async () => ({ token: "t", source: "keychain", renewable: true }),
      fetchUsage: async () => [{ window: "five_hour", utilization: 0.9, resetsAt: T0 + 3600_000 }],
    })
    const state = { claude: { profiles: [{ name: "work", dir: "/w" }, { name: "side", dir: "/s" }], active: "work" } }
    expect(preflightQuotaGate(false, T0, undefined, "background", "side")).toBeNull()
    await readAccountsPlanUsage({ state, env: {}, home: "/h", now: T0, claudeReader: reader, codex: async () => null })
    expect(preflightQuotaGate(false, T0 + 60_000, undefined, "background", "side")?.reason).toBe("plan_priority")
    expect(preflightQuotaGate(false, T0 + 60_000, undefined, "person", "side")).toBeNull()
  })
})
