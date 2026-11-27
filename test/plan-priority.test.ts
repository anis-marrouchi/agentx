import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  clearDispatchHistory, setDispatchBudget, recordClaudeCodeDispatch, recordRateLimitEvent,
  preflightQuotaGate, planWindowUse,
} from "../src/agents/claude-code-quota"
import { priorityOfTask, planPriorityHold, setPlanPriority, DEFAULT_PLAN_PRIORITY } from "../src/agents/plan-priority"
import {
  PlanUsageReader, PlanUsageRequestError, keychainServiceFor, parseUsageResponse, planUsageReader, readStoredLogin,
} from "../src/agents/claude-plan-usage"
import { handlePlanUsageApi } from "../src/daemon/plan-usage-api"
import { daemonConfigSchema } from "../src/daemon/config"

const T0 = Date.UTC(2026, 10, 23, 18, 0, 0)
const sec = (ms: number) => Math.floor(ms / 1000)
const event = (window: string, utilization: number, status = "allowed") => ({
  type: "rate_limit_event",
  rate_limit_info: { status, rateLimitType: window, utilization, resetsAt: sec(T0 + 3 * 3600_000) },
})

beforeEach(() => {
  clearDispatchHistory()
  setDispatchBudget(undefined)
  setPlanPriority(undefined)
})
afterEach(() => vi.restoreAllMocks())

describe("priorityOfTask", () => {
  const p = (context: Record<string, unknown>, extra: Record<string, unknown> = {}) => priorityOfTask({ context, ...extra })

  it("puts a person writing first", () => {
    expect(p({ channel: "telegram", sender: "Ana" })).toBe("person")
    expect(p({ channel: "app" })).toBe("person")
    expect(p({ channel: "dashboard" })).toBe("person")
    expect(p({ channel: "github", sender: "octo" })).toBe("person")
  })

  it("does not treat an agent's comment on a forge as a person", () => {
    expect(p({ channel: "github", sender: "agent:coder" })).toBe("agent")
  })

  it("puts scheduled work last, also when it is handed on", () => {
    expect(p({ channel: "cron" })).toBe("background")
    expect(p({ channel: "reminder" })).toBe("background")
    expect(p({ channel: "a2a", initiator: { kind: "agent", channel: "cron" } })).toBe("background")
  })

  it("ranks hand-offs by who started the chain", () => {
    expect(p({ channel: "a2a", initiator: { kind: "human", channel: "telegram" } })).toBe("work")
    expect(p({ channel: "a2a", initiator: { kind: "agent", channel: "events" } })).toBe("agent")
    expect(p({ channel: "events" })).toBe("agent")
    expect(p({ channel: "a2a", delegation: { taskId: "t", from: "x", status: "done", root: { kind: "human", channel: "app" } } })).toBe("work")
  })

  it("counts workflow steps as work", () => {
    expect(p({ channel: "workflow" })).toBe("work")
    expect(p({ channel: "gitlab", sender: "agent:pm" }, { workflowRunId: "run-1" })).toBe("work")
  })
})

describe("planPriorityHold", () => {
  const weekly = (pct: number) => [{ window: "seven_day", utilization: pct / 100, resetsAt: T0 + 3600_000 }]

  it("holds each class past its own threshold", () => {
    expect(planPriorityHold("background", weekly(72))?.thresholdPercent).toBe(70)
    expect(planPriorityHold("agent", weekly(72))).toBeNull()
    expect(planPriorityHold("agent", weekly(86))?.window).toBe("seven_day")
    expect(planPriorityHold("work", weekly(94))).toBeNull()
    expect(planPriorityHold("work", weekly(95))).not.toBeNull()
  })

  it("never holds a person", () => {
    expect(planPriorityHold("person", weekly(100))).toBeNull()
  })

  it("uses the 5-hour threshold for the 5-hour window", () => {
    const fiveHour = [{ window: "five_hour", utilization: 0.75 }]
    expect(planPriorityHold("background", fiveHour)).toBeNull()
    expect(planPriorityHold("background", [{ window: "five_hour", utilization: 0.8 }])).not.toBeNull()
  })

  it("applies a model's weekly window only to runs on that model", () => {
    const scoped = [{ window: "seven_day_fable", utilization: 0.99 }]
    expect(planPriorityHold("agent", scoped, "claude-opus-5-5")).toBeNull()
    expect(planPriorityHold("agent", scoped, "claude-fable-5-2")).not.toBeNull()
  })

  it("does nothing when turned off, and takes thresholds from config", () => {
    setPlanPriority({ enabled: false })
    expect(planPriorityHold("background", weekly(99))).toBeNull()
    setPlanPriority({ background: { weekly: 90 } })
    expect(planPriorityHold("background", weekly(85))).toBeNull()
    expect(planPriorityHold("background", [{ window: "five_hour", utilization: 0.8 }])?.thresholdPercent).toBe(DEFAULT_PLAN_PRIORITY.background.fiveHour)
  })
})

describe("preflightQuotaGate with a priority", () => {
  it("holds a background run on the window use Claude Code reported", () => {
    recordRateLimitEvent(event("seven_day", 0.72), T0)
    const abort = preflightQuotaGate(false, T0 + 1, undefined, "background")
    expect(abort?.reason).toBe("plan_priority")
    expect(abort?.message).toContain("72%")
    expect(abort?.retryAt).toBeLessThanOrEqual(T0 + 1 + 15 * 60_000)
    expect(preflightQuotaGate(false, T0 + 1, undefined, "agent")).toBeNull()
  })

  it("lets warm sessions through", () => {
    recordRateLimitEvent(event("seven_day", 0.99), T0)
    expect(preflightQuotaGate(true, T0 + 1, undefined, "background")).toBeNull()
  })

  it("does not refuse a person on the local count cap, but still refuses agents", () => {
    setDispatchBudget({ maxPerHour: 2 })
    recordClaudeCodeDispatch(T0)
    recordClaudeCodeDispatch(T0 + 1)
    expect(preflightQuotaGate(false, T0 + 2, undefined, "person")).toBeNull()
    expect(preflightQuotaGate(false, T0 + 2, undefined, "agent")?.reason).toBe("hourly_cap")
    expect(preflightQuotaGate(false, T0 + 2)?.reason).toBe("hourly_cap")
  })

  it("still holds a person when Claude rejects the window", () => {
    recordRateLimitEvent(event("five_hour", 1, "rejected"), T0)
    expect(preflightQuotaGate(false, T0 + 1, undefined, "person")?.reason).toBe("provider_rate_limit")
  })

  it("prefers the usage reader's reading when it is newer", () => {
    recordRateLimitEvent(event("seven_day", 0.5), T0)
    vi.spyOn(planUsageReader, "freshReading").mockReturnValue({
      windows: [{ window: "seven_day", utilization: 0.9 }, { window: "five_hour", utilization: 0.2 }],
      readAt: T0 + 60_000,
      source: "credentials-file",
    })
    const use = planWindowUse(T0 + 120_000)
    expect(use.find((w) => w.window === "seven_day")?.utilization).toBe(0.9)
    expect(preflightQuotaGate(false, T0 + 120_000, undefined, "agent")?.reason).toBe("plan_priority")
  })
})

// The shape the endpoint answered with on a live node (2026-11-23), trimmed.
const LIVE = {
  five_hour: { utilization: 35.0, resets_at: "2026-11-23T21:59:59.990398+00:00" },
  seven_day: { utilization: 58.0, resets_at: "2026-11-25T03:59:59.990418+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: "session", percent: 35, resets_at: "2026-11-23T21:59:59.990398+00:00", scope: null },
    { kind: "weekly_scoped", percent: 9, resets_at: "2026-11-25T03:59:59.990560+00:00", scope: { model: { id: null, display_name: "Fable" } } },
  ],
}

describe("parseUsageResponse", () => {
  it("reads the 5-hour, weekly and model weekly windows", () => {
    const w = Object.fromEntries(parseUsageResponse(LIVE).map((x) => [x.window, x]))
    expect(w.five_hour.utilization).toBeCloseTo(0.35)
    expect(w.five_hour.resetsAt).toBe(Date.parse("2026-11-23T21:59:59.990Z"))
    expect(w.seven_day.utilization).toBeCloseTo(0.58)
    expect(w.seven_day_fable.utilization).toBeCloseTo(0.09)
    expect(Object.keys(w).sort()).toEqual(["five_hour", "seven_day", "seven_day_fable"])
  })

  it("returns nothing for an unexpected body", () => {
    expect(parseUsageResponse(null)).toEqual([])
    expect(parseUsageResponse({ five_hour: { utilization: "x" } })).toEqual([])
  })
})

describe("readStoredLogin", () => {
  const login = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r", expiresAt: 1 } })

  it("reads the Keychain entry of the config folder Claude Code uses", async () => {
    const asked: string[] = []
    const got = await readStoredLogin({
      env: { CLAUDE_CONFIG_DIR: "/x/claude" }, home: "/h", user: "me",
      readKeychain: async (s, a) => { asked.push(a ? `${s}|${a}` : s); return login("tok-a") },
      readFile: () => null,
    })
    expect(asked).toEqual([`${keychainServiceFor("/x/claude")}|me`, keychainServiceFor("/x/claude")])
    expect(asked[1]).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    expect(got).toEqual({ token: "tok-a", source: "config-dir-keychain", renewable: true })
  })

  // #2101 R5: the Mac had an item from June (account "Claude Code") beside
  // the one Claude Code renews (account = the user). `security` without an
  // account returned the June one, so the reader never read a percentage.
  it("takes the login that runs out last when two keychain items share the service", async () => {
    const at = (token: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r", expiresAt } })
    const got = await readStoredLogin({
      env: {}, home: "/h", user: "me", now: 5_000,
      readKeychain: async (_s, a) => (a === "me" ? at("fresh", 9_000) : at("june", 1_000)),
      readFile: () => null,
    })
    expect(got.token).toBe("fresh")
    const older = await readStoredLogin({
      env: {}, home: "/h", user: "me", now: 5_000,
      readKeychain: async (_s, a) => (a === "me" ? at("old-user", 1_000) : at("newer", 9_000)),
      readFile: () => null,
    })
    expect(older.token).toBe("newer")
  })

  it("takes the credentials file when it runs out later than the keychain login", async () => {
    const at = (token: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r", expiresAt } })
    const got = await readStoredLogin({
      env: {}, home: "/h", user: "me",
      readKeychain: async () => at("kc", 1_000),
      readFile: () => at("file", 9_000),
    })
    expect(got).toEqual({ token: "file", source: "credentials-file", renewable: true })
  })

  it("falls back to the credentials file when the keychain has nothing", async () => {
    const files: string[] = []
    const got = await readStoredLogin({
      env: {}, home: "/h",
      readKeychain: async () => null,
      readFile: (f) => { files.push(f); return login("tok-b") },
    })
    expect(files).toEqual(["/h/.claude/.credentials.json"])
    expect(got.source).toBe("credentials-file")
  })

  it("reports no login when nothing is stored", async () => {
    const got = await readStoredLogin({ env: {}, home: "/h", readKeychain: async () => null, readFile: () => null })
    expect(got).toEqual({ token: null, source: "none", renewable: false })
  })
})

describe("PlanUsageReader", () => {
  const SECRET = "sk-ant-oat01-secret"

  it("keeps the reading and never the token", async () => {
    let now = T0
    const r = new PlanUsageReader({
      now: () => now,
      readLogin: async () => ({ token: SECRET, source: "keychain", renewable: true }),
      fetchUsage: async (t) => { expect(t).toBe(SECRET); return parseUsageResponse(LIVE) },
    })
    const state = await r.readNow()
    expect(state.reading?.windows).toHaveLength(3)
    expect(JSON.stringify(state)).not.toContain(SECRET)
    expect(r.freshReading(T0 + 29 * 60_000)).not.toBeNull()
    now = T0 + 31 * 60_000
    expect(r.freshReading()).toBeNull()
  })

  it("records a lapsed login without renewing it, and keeps the last good reading", async () => {
    let fail = false
    const logs: string[] = []
    const r = new PlanUsageReader({
      now: () => T0,
      log: (m) => logs.push(m),
      readLogin: async () => ({ token: "t", source: "keychain", renewable: true }),
      fetchUsage: async () => {
        if (fail) throw new PlanUsageRequestError("stale-login", "the stored login token has lapsed")
        return parseUsageResponse(LIVE)
      },
    })
    await r.readNow()
    fail = true
    const state = await r.readNow()
    await r.readNow()
    expect(state.lastError?.kind).toBe("stale-login")
    expect(state.reading?.windows).toHaveLength(3)
    expect(logs.filter((m) => m.includes("lapsed"))).toHaveLength(1)
  })

  it("backs off when the endpoint rate limits", async () => {
    const r = new PlanUsageReader({
      now: () => T0,
      readLogin: async () => ({ token: "t", source: "keychain", renewable: true }),
      fetchUsage: async () => { throw new PlanUsageRequestError("rate-limited", "rate limited", 40 * 60_000) },
    })
    r.configure({ enabled: true, intervalMinutes: 5 })
    const state = await r.readNow()
    r.stop()
    expect(state.lastError?.kind).toBe("rate-limited")
    expect(state.nextReadAt).toBe(T0 + 40 * 60_000)
  })

  it("asks to sign in again when the login can't be renewed", async () => {
    const r = new PlanUsageReader({
      now: () => T0,
      readLogin: async () => ({ token: "t", source: "credentials-file", renewable: false }),
      fetchUsage: async () => { throw new PlanUsageRequestError("stale-login", "lapsed") },
    })
    expect((await r.readNow()).lastError?.kind).toBe("signed-out")
  })

  it("says when there is no login", async () => {
    const r = new PlanUsageReader({ now: () => T0, readLogin: async () => ({ token: null, source: "none", renewable: false }) })
    expect((await r.readNow()).lastError?.kind).toBe("no-login")
  })
})

describe("/usage/plan", () => {
  it("shows the reader state and the classes held now", () => {
    recordRateLimitEvent(event("seven_day", 0.9), T0)
    const res = handlePlanUsageApi("GET", "/usage/plan", T0 + 1)
    const body = res.body as any
    expect(body.reader).toBeDefined()
    expect(body.priority.held.map((h: any) => h.priority).sort()).toEqual(["agent", "background"])
  })
})

describe("config", () => {
  it("accepts thresholds and the reader settings", () => {
    const cfg = daemonConfigSchema.parse({
      node: { id: "n", name: "n" },
      session: { planPriority: { background: { weekly: 60 } }, planUsage: { intervalMinutes: 10 } },
    })
    expect(cfg.session.planPriority?.enabled).toBe(true)
    expect(cfg.session.planPriority?.background?.weekly).toBe(60)
    expect(cfg.session.planUsage).toEqual({ enabled: true, intervalMinutes: 10 })
  })

  it("refuses a percent over 100 and unknown keys", () => {
    const parse = (planPriority: unknown) => daemonConfigSchema.safeParse({ node: { id: "n", name: "n" }, session: { planPriority } }).success
    expect(parse({ agent: { weekly: 120 } })).toBe(false)
    expect(parse({ agent: { monthly: 50 } })).toBe(false)
  })
})
