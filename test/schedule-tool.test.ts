import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runScheduleTool, resolveScheduleCaller, type ScheduleCaller } from "../src/crons/schedule-tool"
import {
  approveSchedule,
  buildScheduleJob,
  rejectSchedule,
  setScheduleEnabled,
} from "../src/crons/schedule-ops"
import { parseEnglishToCron } from "../src/utils/nl-cron"
import { daemonConfigSchema } from "../src/daemon/config"
import { CronScheduler } from "../src/crons/scheduler"

// The agent-facing schedule tool. What must hold:
//   - create writes the same crons.<id> shape as the CLI, but disabled and
//     marked pending, and tells the operator the parsed cron + next fire
//   - nothing an agent can do through the tool enables a pending job
//   - agents manage only what they created, unless admin
//   - only the operator's approve/reject resolves a request

const FIXED_NOW = new Date("2026-09-26T08:00:00.000Z") // a Saturday

let dir: string
let configPath: string

function writeConfig(extraCrons: Record<string, any> = {}) {
  const cfg = {
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: {
      alpha: { name: "Alpha", workspace: "./agents/alpha", tier: "claude-code" },
      beta: { name: "Beta", workspace: "./agents/beta", tier: "claude-code" },
      boss: { name: "Boss", workspace: "./agents/boss", tier: "claude-code", admin: true },
    },
    notifications: { destination: { channel: "telegram", chatId: "1000" } },
    crons: extraCrons,
  }
  writeFileSync(configPath, JSON.stringify(cfg, null, 2))
}

function readCrons(): Record<string, any> {
  return JSON.parse(readFileSync(configPath, "utf-8")).crons
}

const alpha: ScheduleCaller = { agentId: "alpha", channel: "telegram", chatId: "2000" }
const beta: ScheduleCaller = { agentId: "beta", channel: "telegram", chatId: "3000" }
const boss: ScheduleCaller = { agentId: "boss" }

function deps(notifyOperator = vi.fn(async () => {})) {
  return { configPath, reload: false, now: () => FIXED_NOW, notifyOperator }
}

async function createAsAlpha(extra: Record<string, unknown> = {}) {
  return runScheduleTool(
    { action: "create", when: "every monday at 10am", prompt: "Check X and ping me", id: "weekly-x", ...extra },
    alpha,
    deps(),
  )
}

describe("agentx_schedule tool", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-sched-"))
    configPath = join(dir, "agentx.json")
    writeConfig()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("create writes the CLI job shape, disabled and pending, and notifies the operator", async () => {
    const notify = vi.fn(async () => {})
    const out = await runScheduleTool(
      { action: "create", when: "every monday at 10am", prompt: "Check X and ping me", id: "weekly-x" },
      alpha,
      deps(notify),
    )
    expect(out).toMatch(/will not run until the operator approves/)
    expect(out).toContain("0 10 * * 1")

    const job = readCrons()["weekly-x"]
    const expected = buildScheduleJob({
      parsed: parseEnglishToCron("every monday at 10am")!,
      agent: "alpha",
      prompt: "Check X and ping me",
      notify: { channel: "telegram", chatId: "2000" },
      enabled: false,
      createdBy: "alpha",
      approval: { action: "create", requestedBy: "alpha", requestedAt: FIXED_NOW.toISOString() },
    })
    expect(job).toEqual(expected)
    expect(job.onError).toContain("notify")
    // The written job passes the daemon schema and keeps the new fields.
    const parsed = daemonConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf-8")))
    expect(parsed.crons["weekly-x"].createdBy).toBe("alpha")
    expect(parsed.crons["weekly-x"].approval?.action).toBe("create")

    expect(notify).toHaveBeenCalledTimes(1)
    const [dest, text] = notify.mock.calls[0] as unknown as [any, string]
    expect(dest).toEqual({ channel: "telegram", chatId: "1000", accountId: undefined })
    expect(text).toContain("cron `0 10 * * 1`")
    expect(text).toMatch(/Next fire: Mon, 28 Sept? 2026, 10:00 \(Africa\/Tunis\)/)
    expect(text).toContain("agentx schedule approve weekly-x")
  })

  it("notify defaults to none for non-conversational channels and honours explicit targets", async () => {
    await runScheduleTool(
      { action: "create", when: "daily at 9", prompt: "p", id: "a1" },
      { agentId: "alpha", channel: "cron", chatId: "x" },
      deps(),
    )
    expect(readCrons()["a1"].notify).toBeUndefined()
    await runScheduleTool(
      { action: "create", when: "daily at 9", prompt: "p", id: "a2", notify: "gitlab:org/repo:issue:4" },
      alpha,
      deps(),
    )
    expect(readCrons()["a2"].notify).toEqual({ channel: "gitlab", chatId: "org/repo:issue:4" })
  })

  it("refuses unparseable timing, unknown agents, bad ids and duplicates without writing", async () => {
    expect(await createAsAlpha({ when: "whenever you feel like it" })).toMatch(/couldn't parse/)
    expect(await createAsAlpha({ agent: "ghost" })).toMatch(/not found/)
    expect(await createAsAlpha({ id: "a.b" })).toMatch(/invalid id/)
    expect(Object.keys(readCrons())).toHaveLength(0)
    await createAsAlpha()
    expect(await createAsAlpha()).toMatch(/already exists/)
  })

  it("no tool action enables a pending job — only operator approval does", async () => {
    await createAsAlpha()
    expect(await runScheduleTool({ action: "resume", id: "weekly-x" }, alpha, deps())).toMatch(/awaiting operator approval/)
    expect(await runScheduleTool({ action: "resume", id: "weekly-x" }, boss, deps())).toMatch(/awaiting operator approval/)
    // An admin's delete must not overwrite the pending-create marker.
    expect(await runScheduleTool({ action: "delete", id: "weekly-x" }, boss, deps())).toMatch(/awaiting approval/)
    expect(readCrons()["weekly-x"]).toMatchObject({ enabled: false, approval: { action: "create" } })

    // The CLI's `on` refuses too.
    const on = await setScheduleEnabled("weekly-x", true, { configPath, reload: false })
    expect(on.success).toBe(false)

    const ok = await approveSchedule("weekly-x", { configPath, reload: false })
    expect(ok.success).toBe(true)
    const job = readCrons()["weekly-x"]
    expect(job.enabled).toBe(true)
    expect(job.approval).toBeUndefined()
    expect(job.createdBy).toBe("alpha")
  })

  it("reject drops a pending create", async () => {
    await createAsAlpha()
    const r = await rejectSchedule("weekly-x", { configPath, reload: false })
    expect(r.success).toBe(true)
    expect(readCrons()["weekly-x"]).toBeUndefined()
  })

  it("owner can withdraw its own pending create", async () => {
    await createAsAlpha()
    expect(await runScheduleTool({ action: "delete", id: "weekly-x" }, alpha, deps())).toMatch(/Withdrew/)
    expect(readCrons()["weekly-x"]).toBeUndefined()
  })

  it("pause/resume are owner-only unless admin", async () => {
    await createAsAlpha()
    await approveSchedule("weekly-x", { configPath, reload: false })

    expect(await runScheduleTool({ action: "pause", id: "weekly-x" }, beta, deps())).toMatch(/Not allowed.*alpha/)
    expect(readCrons()["weekly-x"].enabled).toBe(true)

    expect(await runScheduleTool({ action: "pause", id: "weekly-x" }, alpha, deps())).toMatch(/paused/)
    expect(readCrons()["weekly-x"].enabled).toBe(false)
    expect(await runScheduleTool({ action: "resume", id: "weekly-x" }, boss, deps())).toMatch(/resumed/)
    expect(readCrons()["weekly-x"].enabled).toBe(true)
  })

  it("operator-created jobs are off-limits to non-admin agents", async () => {
    writeConfig({ nightly: { enabled: true, schedule: "0 2 * * *", agent: "alpha", prompt: "p" } })
    expect(await runScheduleTool({ action: "pause", id: "nightly" }, alpha, deps())).toMatch(/created by the operator/)
    expect(await runScheduleTool({ action: "delete", id: "nightly" }, alpha, deps())).toMatch(/Not allowed/)
  })

  it("delete is a request: job keeps running until approved; reject keeps it", async () => {
    await createAsAlpha()
    await approveSchedule("weekly-x", { configPath, reload: false })
    const notify = vi.fn(async () => {})

    const out = await runScheduleTool({ action: "delete", id: "weekly-x" }, alpha, deps(notify))
    expect(out).toMatch(/requested/)
    expect(notify).toHaveBeenCalledTimes(1)
    expect((notify.mock.calls[0] as unknown as [any, string])[1]).toMatch(/Delete: weekly-x[\s\S]*cron `0 10 \* \* 1`[\s\S]*Next fire:/)
    expect(readCrons()["weekly-x"]).toMatchObject({ enabled: true, approval: { action: "delete", requestedBy: "alpha" } })

    await rejectSchedule("weekly-x", { configPath, reload: false })
    expect(readCrons()["weekly-x"].approval).toBeUndefined()
    expect(readCrons()["weekly-x"].enabled).toBe(true)

    await runScheduleTool({ action: "delete", id: "weekly-x" }, alpha, deps())
    await approveSchedule("weekly-x", { configPath, reload: false })
    expect(readCrons()["weekly-x"]).toBeUndefined()
  })

  it("list shows state, owner and bounded prompt; mine filters", async () => {
    writeConfig({ nightly: { enabled: true, schedule: "0 2 * * *", agent: "beta", prompt: "x".repeat(1000) } })
    await createAsAlpha()
    const all = await runScheduleTool({ action: "list" }, alpha, deps())
    expect(all).toMatch(/weekly-x \[pending create approval\]/)
    expect(all).toMatch(/nightly \[active\]/)
    expect(all).toMatch(/created by: operator/)
    expect(all.length).toBeLessThan(1000)
    const mine = await runScheduleTool({ action: "list", mine: true }, alpha, deps())
    expect(mine).toContain("weekly-x")
    expect(mine).not.toContain("nightly")
  })

  it("mutating actions need a known caller", async () => {
    expect(await runScheduleTool({ action: "create", when: "daily at 9", prompt: "p" }, null, deps())).toMatch(/caller agent is unknown/)
    expect(await runScheduleTool({ action: "pause", id: "x" }, { agentId: "ghost" }, deps())).toMatch(/not an agent/)
  })

  it("reports when the operator could not be notified, but keeps the request", async () => {
    const out = await runScheduleTool(
      { action: "create", when: "daily at 9", prompt: "p", id: "n1" },
      alpha,
      deps(vi.fn(async () => { throw new Error("channel down") })),
    )
    expect(out).toMatch(/Could not notify the operator \(channel down\)/)
    expect(readCrons()["n1"].approval.action).toBe("create")
  })
})

describe("resolveScheduleCaller", () => {
  it("runtime env wins over model-supplied identity", () => {
    const c = resolveScheduleCaller(
      { callerAgentId: "boss", channel: "telegram", chatId: "9" },
      { AGENTX_AGENT_ID: "alpha", AGENTX_CHANNEL: "whatsapp", AGENTX_CHAT_ID: "5" },
    )
    expect(c).toEqual({ agentId: "alpha", channel: "whatsapp", chatId: "5" })
  })
  it("falls back to args when the runtime exported nothing", () => {
    expect(resolveScheduleCaller({ callerAgentId: "beta", channel: "telegram", chatId: "9" }, {}))
      .toEqual({ agentId: "beta", channel: "telegram", chatId: "9" })
    expect(resolveScheduleCaller({}, {})).toBeNull()
  })
})

describe("scheduler honours a pending create", () => {
  it("never enables a job whose creation awaits approval, even if enabled is true", () => {
    const s = new CronScheduler(
      {
        crons: {
          pending: { enabled: true, schedule: "* * * * *", timezone: "UTC", agent: "a", prompt: "p", onError: ["log"], timeout: 60, approval: { action: "create", requestedBy: "a", requestedAt: "x" } },
          deleting: { enabled: true, schedule: "* * * * *", timezone: "UTC", agent: "a", prompt: "p", onError: ["log"], timeout: 60, approval: { action: "delete", requestedBy: "a", requestedAt: "x" } },
        },
        agents: {},
        notifications: {},
      } as any,
      {} as any,
      () => {},
    )
    const jobs = (s as any).jobs as Map<string, any>
    expect(jobs.get("pending").enabled).toBe(false)
    expect(jobs.get("deleting").enabled).toBe(true)
  })
})
