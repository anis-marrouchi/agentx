import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler } from "../src/crons/scheduler"
import { buildScheduleJob } from "../src/crons/schedule-ops"
import { parseEnglishToCron } from "../src/utils/nl-cron"
import { daemonConfigSchema } from "../src/daemon/config"

// #738: docs promised a schedule's results reach a chat; nothing sent them.
// What must hold now:
//   - a job with `deliverResult` and a `notify` target sends each successful
//     run's answer through the deliver callback;
//   - without `deliverResult`, `notify` stays failure-only (no surprise
//     reports for operators who set it up for alerts);
//   - failures and empty answers are never delivered as results;
//   - a failed send never turns a successful run red.

let dir: string
const prevCwd = process.cwd()

const notify = { channel: "telegram", chatId: "2000" }
const job = (extra: Record<string, unknown> = {}) => ({
  enabled: true, schedule: "0 9 * * 1", timezone: "UTC", agent: "ops-agent",
  prompt: "Write the weekly report", timeout: 30, onError: ["log"], ...extra,
})

function run(def: Record<string, unknown>, response: Record<string, unknown>) {
  const registry = { execute: vi.fn(async () => ({ duration: 5, ...response })) }
  const s: any = new CronScheduler({ crons: { weekly: def }, agents: {}, notifications: {} } as any, registry as any, undefined, () => {})
  s.scheduleNext = () => {}
  s.scheduleRetry = () => {}
  s.running = true
  const deliver = vi.fn(async () => {})
  s.setDeliverCallback(deliver)
  return { s, deliver, go: () => s.executeJob("weekly") }
}

describe("cron results reach the notify chat when deliverResult is on", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-cron-deliver-"))
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it("delivers a successful run's answer", async () => {
    const { deliver, go } = run(job({ notify, deliverResult: true }), { content: "Report: all good" })
    await go()
    expect(deliver).toHaveBeenCalledWith("weekly", "ops-agent", "Report: all good")
  })

  it("keeps notify failure-only without deliverResult", async () => {
    const { deliver, go } = run(job({ notify }), { content: "Report: all good" })
    await go()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("ignores deliverResult without a notify target", async () => {
    const { deliver, go } = run(job({ deliverResult: true }), { content: "Report" })
    await go()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("never delivers a failure or an empty answer as a result", async () => {
    const failed = run(job({ notify, deliverResult: true }), { content: "", error: "boom" })
    await failed.go()
    expect(failed.deliver).not.toHaveBeenCalled()

    const empty = run(job({ notify, deliverResult: true }), { content: "  " })
    await empty.go()
    expect(empty.deliver).not.toHaveBeenCalled()
  })

  it("a failed send leaves the run successful", async () => {
    const { s, deliver, go } = run(job({ notify, deliverResult: true }), { content: "Report" })
    deliver.mockRejectedValueOnce(new Error("chat down"))
    await go()
    const state = s.jobs.get("weekly")
    expect(state.consecutiveErrors).toBe(0)
    expect(state.lastSuccess).toBeInstanceOf(Date)
  })

  it("buildScheduleJob writes deliverResult only with a notify target, and the schema keeps it", () => {
    const parsed = parseEnglishToCron("every monday at 9am")!
    const base = { parsed, agent: "ops-agent", prompt: "p" }
    expect(buildScheduleJob({ ...base, deliverResult: true }).deliverResult).toBeUndefined()
    const withChat = buildScheduleJob({ ...base, notify, deliverResult: true })
    expect(withChat.deliverResult).toBe(true)

    const cfg = daemonConfigSchema.parse({
      node: { id: "t", name: "T", bind: "127.0.0.1:0" },
      agents: { "ops-agent": { name: "Ops", workspace: "./a", tier: "claude-code" } },
      crons: { weekly: withChat },
    })
    expect(cfg.crons.weekly.deliverResult).toBe(true)
  })
})
