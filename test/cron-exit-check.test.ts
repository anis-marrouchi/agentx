import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler } from "../src/crons/scheduler"
import { readRecentCronRuns, clearCronRunHistoryCache } from "../src/crons/run-history"
import { daemonConfigSchema } from "../src/daemon/config"
import { NOTHING_TO_REPORT } from "../src/crons/quiet"
import { exitCheckError, reportedExitCode, withExitRule, withoutExitMarker } from "../src/crons/exit-check"

// #1540: a prompt cron that tells the agent to run a shell command was
// recorded as a success when the command failed, because only the agent
// run's own error counted. `expectExitZero` makes the exit code count.

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-cron-exit-"))
  process.chdir(dir)
  clearCronRunHistoryCache()
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

describe("the exit code line", () => {
  it("is read from the last marker line, with markdown forgiven", () => {
    expect(reportedExitCode("done\nEXIT=0")).toBe(0)
    expect(reportedExitCode("Error: Cannot find module\n`EXIT=1`\n")).toBe(1)
    expect(reportedExitCode("first EXIT=0\n**exit=127**")).toBe(127)
    expect(reportedExitCode("EXIT=0\nthen it failed\nEXIT=2")).toBe(2)
  })
  it("is absent when no line is only the marker", () => {
    for (const t of [undefined, "", "All good", "I would write EXIT=0 here"]) {
      expect(reportedExitCode(t), String(t)).toBeUndefined()
    }
  })
  it("fails the check when missing or not 0, and only with the setting", () => {
    expect(exitCheckError(true, "ok\nEXIT=0")).toBeUndefined()
    expect(exitCheckError(true, "MODULE_NOT_FOUND\nEXIT=1")).toBe("the command exited with code 1")
    expect(exitCheckError(true, "Absorbed 3 notes")).toMatch(/did not report/)
    expect(exitCheckError(undefined, "MODULE_NOT_FOUND\nEXIT=1")).toBeUndefined()
  })
  it("is asked for only with the setting", () => {
    expect(withExitRule("Run: wiki absorb")).toBe("Run: wiki absorb")
    expect(withExitRule("Run: wiki absorb", true)).toContain("EXIT=<code>")
  })
  it("is dropped for the quiet check", () => {
    expect(withoutExitMarker(`${NOTHING_TO_REPORT}\nEXIT=0`)).toBe(NOTHING_TO_REPORT)
  })
})

const job = (extra: Record<string, unknown> = {}) => ({
  enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "ops-agent",
  prompt: "Run: wiki absorb --dir ./release", timeout: 30, onError: ["log"], ...extra,
})

function run(def: Record<string, unknown>, response: Record<string, unknown>) {
  const registry = { execute: vi.fn(async (_task: any) => ({ duration: 5, ...response })) }
  const s: any = new CronScheduler({ crons: { absorb: def }, agents: {}, notifications: {} } as any, registry as any, undefined, () => {})
  s.scheduleNext = () => {}
  s.scheduleRetry = () => {}
  s.running = true
  const deliver = vi.fn(async () => {})
  s.setDeliverCallback(deliver)
  return { s, registry, deliver, go: () => s.executeJob("absorb") }
}

function runRecords(): any[] {
  const d = join(dir, ".agentx/cron/runs/absorb")
  if (!existsSync(d)) return []
  return readdirSync(d).map((n) => JSON.parse(readFileSync(join(d, n), "utf-8")))
}

describe("a prompt cron with expectExitZero", () => {
  it("records a failed command as a failed run that counts in cron health", async () => {
    const { s, registry, deliver, go } = run(job({ expectExitZero: true }), {
      content: "The command failed: Error: Cannot find module '/opt/release/cli.js' (MODULE_NOT_FOUND)\nEXIT=1",
    })
    await go()
    expect(registry.execute.mock.calls[0][0].message).toContain("EXIT=<code>")
    expect(runRecords()).toEqual([expect.objectContaining({ success: false, error: "the command exited with code 1" })])
    const state = s.jobs.get("absorb")
    expect(state.consecutiveErrors).toBe(1)
    expect(state.totalFailures).toBe(1)
    expect(state.lastError).toBe("the command exited with code 1")
    expect(deliver).not.toHaveBeenCalled()
    const recent = await readRecentCronRuns({ perJob: 5 })
    expect(recent.get("absorb")?.[0].status).toBe("failed")
  })

  it("records a missing exit code as a failed run", async () => {
    const { go } = run(job({ expectExitZero: true }), { content: "Absorbed the notes." })
    await go()
    expect(runRecords()[0]).toMatchObject({ success: false })
    expect(runRecords()[0].error).toMatch(/did not report/)
  })

  it("records EXIT=0 as a success and delivers the answer without the EXIT line", async () => {
    const { s, deliver, go } = run(job({ expectExitZero: true, notify: { channel: "telegram", chatId: "1" } }), { content: "Absorbed 3 notes\nEXIT=0" })
    await go()
    expect(runRecords()[0]).toMatchObject({ success: true, response: "Absorbed 3 notes\nEXIT=0" })
    expect(s.jobs.get("absorb").consecutiveErrors).toBe(0)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect((deliver.mock.calls[0] as any[])[2]).toBe("Absorbed 3 notes")
  })

  it("does not flag the EXIT line as a fact without a source", async () => {
    const { deliver, go } = run(job({ expectExitZero: true, requireSources: true, notify: { channel: "telegram", chatId: "1" } }), {
      content: "Absorbed 3 notes from https://example.com/release\nEXIT=0",
    })
    await go()
    expect(runRecords()[0].unsourced).toBeUndefined()
    expect((deliver.mock.calls[0] as any[])[2]).toBe("Absorbed 3 notes from https://example.com/release")
  })

  it("keeps a quiet answer quiet when it ends with EXIT=0", async () => {
    const { deliver, go } = run(job({ expectExitZero: true, report: "exceptions", notify: { channel: "telegram", chatId: "1" } }), {
      content: `${NOTHING_TO_REPORT}\nEXIT=0`,
    })
    await go()
    expect(deliver).not.toHaveBeenCalled()
    expect(runRecords()[0]).toMatchObject({ success: true, quiet: true })
  })

  it("a missed run caught up after a restart fails on the exit code too", async () => {
    const { s, registry } = run(job({ expectExitZero: true }), { content: "MODULE_NOT_FOUND\nEXIT=1" })
    await s.executeMissedRuns([{ jobId: "absorb", missedAt: new Date("2026-01-01T03:00:00Z") }])
    expect(registry.execute.mock.calls[0][0].message).toContain("EXIT=<code>")
    expect(runRecords()).toEqual([expect.objectContaining({ success: false, error: "the command exited with code 1" })])
    expect(s.jobs.get("absorb").lastSuccess).toBeUndefined()
  })

  it("a failed missed run raises the failure counters and sends the failure notice", async () => {
    const { s } = run(job({ expectExitZero: true, onError: ["notify"] }), { content: "MODULE_NOT_FOUND\nEXIT=1" })
    const notify = vi.fn(async () => {})
    s.setNotifyCallback(notify)
    await s.executeMissedRuns([{ jobId: "absorb", missedAt: new Date("2026-01-01T03:00:00Z") }])
    const state = s.jobs.get("absorb")
    expect(state.consecutiveErrors).toBe(1)
    expect(state.totalFailures).toBe(1)
    expect(state.lastError).toBe("the command exited with code 1")
    expect(notify).toHaveBeenCalledWith("absorb", "ops-agent", "the command exited with code 1", 1)
  })

  it("a successful missed run clears the failure streak", async () => {
    const { s } = run(job({ expectExitZero: true }), { content: "Absorbed\nEXIT=0" })
    const state = s.jobs.get("absorb")
    state.consecutiveErrors = 2
    state.lastError = "earlier"
    await s.executeMissedRuns([{ jobId: "absorb", missedAt: new Date("2026-01-01T03:00:00Z") }])
    expect(state.consecutiveErrors).toBe(0)
    expect(state.lastError).toBeUndefined()
    expect(state.lastSuccess).toBeInstanceOf(Date)
  })

  it("an agent run error still wins", async () => {
    const { go } = run(job({ expectExitZero: true }), { content: "EXIT=0", error: "agent crashed" })
    await go()
    expect(runRecords()[0]).toMatchObject({ success: false, error: "agent crashed" })
  })
})

// noqta#503: running the prompt again repeats whatever the command did, such
// as a bank login or a public post, so a failed exit check waits for the
// schedule. Agent and runtime errors keep their retries.
describe("retrying a failed scheduled run", () => {
  function spied(def: Record<string, unknown>, response: Record<string, unknown>) {
    const r = run(def, response)
    r.s.scheduleRetry = vi.fn()
    r.s.scheduleNext = vi.fn()
    return r
  }

  it.each([
    ["a non-zero exit code", "The script failed\nEXIT=10"],
    ["a missing exit code", "The script failed"],
  ])("does not retry %s, and still counts and notifies", async (_name, content) => {
    const { s, registry, go } = spied(job({ expectExitZero: true, onError: ["notify"] }), { content })
    const notify = vi.fn(async () => {})
    s.setNotifyCallback(notify)
    await go()
    expect(registry.execute).toHaveBeenCalledTimes(1)
    expect(s.scheduleRetry).not.toHaveBeenCalled()
    expect(s.scheduleNext).toHaveBeenCalledWith("absorb")
    expect(s.jobs.get("absorb").consecutiveErrors).toBe(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(runRecords()[0]).toMatchObject({ success: false })
  })

  it("remembers the run, so a restart does not run the command again as a missed run", async () => {
    const { s, go } = spied(job({ expectExitZero: true }), { content: "EXIT=10" })
    await go()
    expect(s.loadLastRuns()?.absorb).toBe(s.jobs.get("absorb").lastRun.toISOString())
  })

  it("stops retrying when a retry fails only its exit check", async () => {
    const { s } = spied(job({ expectExitZero: true }), { content: "EXIT=10" })
    await s.executeJob("absorb", 1)
    expect(s.scheduleRetry).not.toHaveBeenCalled()
    expect(s.scheduleNext).toHaveBeenCalledWith("absorb")
  })

  it("retries an agent error on a job with the setting", async () => {
    const { s, go } = spied(job({ expectExitZero: true }), { content: "EXIT=10", error: "agent crashed" })
    await go()
    expect(s.scheduleRetry).toHaveBeenCalledWith("absorb", 0)
    expect(s.scheduleNext).not.toHaveBeenCalled()
  })

  it("retries a runtime error on a job with the setting", async () => {
    const { s, registry, go } = spied(job({ expectExitZero: true }), {})
    registry.execute.mockRejectedValueOnce(new Error("spawn failed"))
    await go()
    expect(s.scheduleRetry).toHaveBeenCalledWith("absorb", 0)
    expect(s.scheduleNext).not.toHaveBeenCalled()
  })

  it("retries an agent error on a job without the setting", async () => {
    const { s, go } = spied(job(), { content: "", error: "agent crashed" })
    await go()
    expect(s.scheduleRetry).toHaveBeenCalledWith("absorb", 0)
    expect(s.scheduleNext).not.toHaveBeenCalled()
  })

  it("leaves a fired run's schedule alone", async () => {
    const { s } = spied(job({ expectExitZero: true }), { content: "EXIT=10" })
    await s.executeJob("absorb", 0, { firedAt: new Date(), payload: {} })
    expect(s.scheduleRetry).not.toHaveBeenCalled()
    expect(s.scheduleNext).not.toHaveBeenCalled()
  })
})

describe("a prompt cron without the setting", () => {
  it("does not retry a clean run whose text reports a failure", async () => {
    const { s, go } = run(job(), { content: "The command failed\nEXIT=1" })
    s.scheduleRetry = vi.fn()
    s.scheduleNext = vi.fn()
    await go()
    expect(s.scheduleRetry).not.toHaveBeenCalled()
    expect(s.scheduleNext).toHaveBeenCalledWith("absorb")
  })

  it("is unchanged: a successful agent run is a success whatever the text says", async () => {
    const { registry, go } = run(job(), { content: "The command failed with MODULE_NOT_FOUND\nEXIT=1" })
    await go()
    expect(registry.execute.mock.calls[0][0].message).not.toContain("EXIT=<code>")
    expect(runRecords()[0]).toMatchObject({ success: true })
  })
})

describe("the schema", () => {
  const base = {
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: { "ops-agent": { name: "Ops", workspace: "./a", tier: "claude-code" } },
  }
  it("keeps expectExitZero on a prompt cron", () => {
    const cfg = daemonConfigSchema.parse({ ...base, crons: { absorb: job({ expectExitZero: true }) } })
    expect(cfg.crons.absorb.expectExitZero).toBe(true)
  })
  it("refuses it on a command cron", () => {
    const r = daemonConfigSchema.safeParse({ ...base, crons: { absorb: job({ prompt: "", command: "wiki absorb", expectExitZero: true }) } })
    expect(r.success).toBe(false)
  })
})
