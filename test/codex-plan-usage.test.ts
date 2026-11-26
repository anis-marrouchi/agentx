import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearCodexPlanUsageCache, CODEX_USAGE_CACHE_MS, codexRateLimitsFromLine, codexRateLimitsFromText, readCodexPlanUsage, readCodexPlanUsageCached } from "../src/agents/codex-plan-usage"

// #2101 R28b: Codex's plan limits, read from its own session files.
const at = "2026-11-25T06:50:00.000Z"
const atMs = Date.parse(at)
const line = (rl: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: rl }, ...extra })
const limits = (p: number, s: number) => ({
  primary: { used_percent: p, window_minutes: 300, resets_at: 1795665462 },
  secondary: { used_percent: s, window_minutes: 10080, resets_at: 1796000000 },
  plan_type: "plus",
})

describe("codexRateLimitsFromLine", () => {
  it("reads both windows, their reset times and the plan", () => {
    expect(codexRateLimitsFromLine(line(limits(9, 19)))).toEqual({
      windows: [
        { window: "five_hour", utilization: 0.09, resetsAt: 1795665462000 },
        { window: "seven_day", utilization: 0.19, resetsAt: 1796000000000 },
      ],
      readAt: atMs,
      plan: "plus",
    })
  })

  it("turns an older build's resets_in_seconds into a reset time from the event's own time", () => {
    const r = codexRateLimitsFromLine(line({ primary: { used_percent: 50, window_minutes: 300, resets_in_seconds: 600 } }))
    expect(r?.windows).toEqual([{ window: "five_hour", utilization: 0.5, resetsAt: atMs + 600_000 }])
    expect(r?.plan).toBeUndefined()
  })

  it("names an unusual window by its minutes and keeps a window with no reset time", () => {
    const r = codexRateLimitsFromLine(line({ primary: { used_percent: 1, window_minutes: 60 }, secondary: { used_percent: 2 } }))
    expect(r?.windows).toEqual([{ window: "window_60m", utilization: 0.01 }, { window: "seven_day", utilization: 0.02 }])
  })

  it("gives null for lines with no plan limits, broken JSON or no percentage", () => {
    expect(codexRateLimitsFromLine('{"type":"event_msg","payload":{"type":"agent_message"}}')).toBeNull()
    expect(codexRateLimitsFromLine('{"rate_limits": {')).toBeNull()
    expect(codexRateLimitsFromLine(line(null))).toBeNull()
    expect(codexRateLimitsFromLine(line({ primary: { window_minutes: 300 } }))).toBeNull()
    expect(codexRateLimitsFromLine(JSON.stringify({ type: "event_msg", payload: { type: "other", rate_limits: limits(1, 1) } }))).toBeNull()
  })

  it("uses the fallback time when the event has none", () => {
    const l = JSON.stringify({ type: "token_count", rate_limits: limits(3, 4) })
    expect(codexRateLimitsFromLine(l, 1234)?.readAt).toBe(1234)
  })
})

describe("codexRateLimitsFromText", () => {
  it("takes the bottom-most reading", () => {
    const text = [line(limits(1, 2)), '{"type":"event_msg","payload":{"type":"agent_message"}}', line(limits(30, 40)), ""].join("\n")
    expect(codexRateLimitsFromText(text)?.windows.map((w) => w.utilization)).toEqual([0.3, 0.4])
    expect(codexRateLimitsFromText("not json\n")).toBeNull()
  })
})

describe("readCodexPlanUsage", () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "codex-home-")) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const put = (rel: string, text: string, mtimeSec?: number) => {
    const f = join(home, "sessions", rel)
    mkdirSync(join(f, ".."), { recursive: true })
    writeFileSync(f, text)
    if (mtimeSec) utimesSync(f, mtimeSec, mtimeSec)
  }

  it("gives null with no sessions folder", async () => {
    expect(await readCodexPlanUsage(home)).toBeNull()
  })

  it("reads the newest day first, and the newest file in that day", async () => {
    put("2026/11/24/rollout-a.jsonl", line(limits(70, 80)) + "\n")
    put("2026/11/25/rollout-old.jsonl", line(limits(5, 6)) + "\n", 1_000_000)
    put("2026/11/25/rollout-new.jsonl", line(limits(9, 19)) + "\n", 2_000_000)
    const r = await readCodexPlanUsage(home)
    expect(r?.windows.map((w) => w.utilization)).toEqual([0.09, 0.19])
  })

  it("falls back to an older file when the newest has no reading (an API-key run)", async () => {
    put("2026/11/24/rollout-a.jsonl", line(limits(70, 80)) + "\n")
    put("2026/11/25/rollout-b.jsonl", '{"type":"event_msg","payload":{"type":"agent_message"}}\n')
    expect((await readCodexPlanUsage(home))?.windows[0].utilization).toBe(0.7)
  })

  it("skips folders that are not dates and files that are not .jsonl", async () => {
    put("tmp/rollout.jsonl", line(limits(99, 99)) + "\n")
    put("2026/11/25/notes.txt", line(limits(98, 98)) + "\n")
    expect(await readCodexPlanUsage(home)).toBeNull()
  })

  it("stops after the newest few files", async () => {
    put("2026/11/20/rollout-a.jsonl", line(limits(70, 80)) + "\n")
    put("2026/11/25/rollout-b.jsonl", "{}\n")
    expect(await readCodexPlanUsage(home, 1)).toBeNull()
  })

  it("walks only the newest day folders", async () => {
    put("2026/11/20/rollout-a.jsonl", line(limits(70, 80)) + "\n")
    put("2026/11/24/rollout-b.jsonl", "{}\n")
    put("2026/11/25/rollout-c.jsonl", "{}\n")
    expect(await readCodexPlanUsage(home, 6, 2)).toBeNull()
    expect((await readCodexPlanUsage(home, 6, 3))?.windows[0].utilization).toBe(0.7)
  })

  it("keeps a reading for a minute, then reads the files again", async () => {
    clearCodexPlanUsageCache()
    put("2026/11/25/rollout-a.jsonl", line(limits(10, 20)) + "\n")
    expect((await readCodexPlanUsageCached(home, 1_000))?.windows[0].utilization).toBe(0.1)
    put("2026/11/25/rollout-a.jsonl", line(limits(50, 60)) + "\n")
    expect((await readCodexPlanUsageCached(home, 1_000 + CODEX_USAGE_CACHE_MS - 1))?.windows[0].utilization).toBe(0.1)
    expect((await readCodexPlanUsageCached(home, 1_000 + CODEX_USAGE_CACHE_MS))?.windows[0].utilization).toBe(0.5)
    clearCodexPlanUsageCache()
  })
})
