import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler } from "../src/crons/scheduler"
import { buildScheduleJob } from "../src/crons/schedule-ops"
import { parseEnglishToCron } from "../src/utils/nl-cron"
import { daemonConfigSchema } from "../src/daemon/config"
import { CallbackReplies, canDeliverToChat, deliverToChat } from "../src/daemon/delegation-wiring"
import { getEventBus } from "../src/events/bus"

// #738: docs promised a schedule's results reach a chat; nothing sent them.
// Owner decision: a schedule sends its successful result to its chat — the
// one it was requested from, otherwise its `notify` destination.
// What must hold now:
//   - a job with a `notify` target sends each successful run's answer
//     through the deliver callback, with no extra setting;
//   - `deliverResult: false` keeps `notify` for failure alerts only;
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

  it("delivers a successful run's answer to notify by default", async () => {
    const { deliver, go } = run(job({ notify }), { content: "Report: all good" })
    await go()
    expect(deliver).toHaveBeenCalledWith("weekly", "ops-agent", "Report: all good", expect.stringMatching(/^weekly/))
  })

  it("keeps notify failure-only with deliverResult: false", async () => {
    const { deliver, go } = run(job({ notify, deliverResult: false }), { content: "Report: all good" })
    await go()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("delivers nothing without a notify target", async () => {
    const { deliver, go } = run(job(), { content: "Report" })
    await go()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("never delivers a failure or an empty answer as a result", async () => {
    const failed = run(job({ notify }), { content: "", error: "boom" })
    await failed.go()
    expect(failed.deliver).not.toHaveBeenCalled()

    const empty = run(job({ notify }), { content: "  " })
    await empty.go()
    expect(empty.deliver).not.toHaveBeenCalled()
  })

  it("a failed send leaves the run successful", async () => {
    const { s, deliver, go } = run(job({ notify }), { content: "Report" })
    deliver.mockRejectedValueOnce(new Error("chat down"))
    await go()
    const state = s.jobs.get("weekly")
    expect(state.consecutiveErrors).toBe(0)
    expect(state.lastSuccess).toBeInstanceOf(Date)
  })

  it("buildScheduleJob writes only the opt-out, and the schema keeps it", () => {
    const parsed = parseEnglishToCron("every monday at 9am")!
    const base = { parsed, agent: "ops-agent", prompt: "p" }
    expect(buildScheduleJob({ ...base, notify, deliverResult: true }).deliverResult).toBeUndefined()
    expect(buildScheduleJob({ ...base, deliverResult: false }).deliverResult).toBeUndefined()
    const withChat = buildScheduleJob({ ...base, notify, deliverResult: false })
    expect(withChat.deliverResult).toBe(false)

    const cfg = daemonConfigSchema.parse({
      node: { id: "t", name: "T", bind: "127.0.0.1:0" },
      agents: { "ops-agent": { name: "Ops", workspace: "./a", tier: "claude-code" } },
      crons: { weekly: withChat },
    })
    expect(cfg.crons.weekly.deliverResult).toBe(false)
  })
})

// PR #749 review: `app` and `voice` targets have no outbound adapter, so
// router.sendOutbound threw "Unknown channel" and the result was lost while
// the approval card said it would arrive. Cron results and alerts now go
// through deliverToChat, the delegation reply path.
describe("deliverToChat reaches app and voice notify targets", () => {
  function wire(channels: string[]) {
    const config = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: { "ops-agent": { name: "Ops", workspace: "./a" } } })
    const replies = new CallbackReplies()
    const sent: Array<{ msg: any; opts: any }> = []
    const recorded: any[] = []
    const registry = { getSessionStore: () => ({ addAgentMessage: (...a: any[]) => recorded.push(a) }) }
    const router = {
      getChannel: (n: string) => (channels.includes(n) ? { name: n } : undefined),
      sendOutbound: async (msg: any, opts: any) => { sent.push({ msg, opts }) },
    }
    return { w: { config, registry: registry as any, router: router as any, replies }, sent, recorded, replies, router }
  }
  const result = (channel: string, chatId: string) => ({
    channel, chatId, agentId: "ops-agent", text: "Report: all good", record: true,
    taskId: "cron:weekly:2026-10-06T09-00-00-000Z", idempotencyKey: "weekly/2026-10-06T09-00-00-000Z",
    outcome: "done" as const, summary: 'Cron "weekly" result',
  })

  it("holds an app result for the phone thread and announces it on the bus", async () => {
    const { w, sent, recorded, replies } = wire([])
    await deliverToChat(w, result("app", "app:cabc12345"))
    expect(sent).toEqual([])
    expect(replies.get("cron:weekly:2026-10-06T09-00-00-000Z")).toMatchObject({ channel: "app", chatId: "app:cabc12345", agent: "ops-agent", text: "Report: all good", status: "done" })
    const ev = getEventBus().recent({ kind: "delegation" }).filter((e) => e.ref === "cron:weekly:2026-10-06T09-00-00-000Z")
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ type: "reply", agentId: "ops-agent", summary: 'Cron "weekly" result' })
    expect(recorded).toHaveLength(1)
  })

  it("sends a voice result as a push notification, with the run as idempotency key", async () => {
    const { w, sent } = wire(["push"])
    await deliverToChat(w, result("voice", "voice:ops-agent"))
    expect(sent).toEqual([{
      msg: { channel: "push", chatId: "default", text: "Ops: Report: all good" },
      opts: { recordInSession: false, idempotencyKey: "weekly/2026-10-06T09-00-00-000Z" },
    }])
  })

  it("sends a chat channel through its adapter", async () => {
    const { w, sent } = wire(["telegram"])
    await deliverToChat(w, result("telegram", "2000"))
    expect(sent[0]).toMatchObject({ msg: { channel: "telegram", chatId: "2000", text: "Report: all good" }, opts: { recordInSession: true } })
  })

  it("throws for a channel this machine cannot reach", async () => {
    const { w } = wire([])
    await expect(deliverToChat(w, result("voice", "voice:ops-agent"))).rejects.toThrow(/no channel "voice"/)
    expect(canDeliverToChat(wire([]).router as any, "app")).toBe(true)
    expect(canDeliverToChat(wire([]).router as any, "voice")).toBe(false)
  })
})
