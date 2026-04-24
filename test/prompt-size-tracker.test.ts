import { describe, it, expect, beforeEach } from "vitest"
import {
  promptSizeKey,
  recordPromptSize,
  warnIfPromptGrowing,
  getPromptSizeReport,
  clearPromptSizeStats,
} from "../src/agents/prompt-size-tracker"

const PARTS = { history: 100, sysPrompt: 500, message: 50 }

describe("prompt-size-tracker", () => {
  beforeEach(() => clearPromptSizeStats())

  it("builds keys scoped by agent+channel and optional chatId", () => {
    expect(promptSizeKey("atlas", "api", "default")).toBe("atlas:api:default")
    expect(promptSizeKey("atlas", "whatsapp")).toBe("atlas:whatsapp")
  })

  it("records samples and reports them", () => {
    recordPromptSize("a:b", 1000, PARTS, 1_000)
    recordPromptSize("a:b", 1100, PARTS, 2_000)
    const report = getPromptSizeReport()
    expect(report.length).toBe(1)
    expect(report[0].samples).toBe(2)
    expect(report[0].current).toBe(1100)
    expect(report[0].peak).toBe(1100)
  })

  it("tracks peak across samples, not just current", () => {
    recordPromptSize("x:y", 5000, PARTS, 1_000)
    recordPromptSize("x:y", 8000, PARTS, 2_000)
    recordPromptSize("x:y", 3000, PARTS, 3_000)
    const report = getPromptSizeReport()
    expect(report[0].current).toBe(3000)
    expect(report[0].peak).toBe(8000)
  })

  it("stays silent while samples are few (cold start)", () => {
    // first 4 samples shouldn't warn, even with huge deltas
    for (let i = 0; i < 4; i++) recordPromptSize("z", 1000 * (i + 1), PARTS, i * 1000)
    expect(warnIfPromptGrowing("z")).toBeNull()
  })

  it("warns when current is >=1.5x baseline after minimum samples", () => {
    for (let i = 0; i < 10; i++) recordPromptSize("agent:telegram:default", 1000, PARTS, i * 1000)
    expect(warnIfPromptGrowing("agent:telegram:default")).toBeNull()
    recordPromptSize("agent:telegram:default", 1800, PARTS, 11_000)  // 1.8x baseline
    const warn = warnIfPromptGrowing("agent:telegram:default")
    expect(warn).not.toBeNull()
    expect(warn).toMatch(/prompt-size drift/)
    expect(warn).toMatch(/agent:telegram:default/)
  })

  it("does NOT warn when current is close to baseline", () => {
    for (let i = 0; i < 10; i++) recordPromptSize("k", 2000, PARTS, i * 1000)
    recordPromptSize("k", 2100, PARTS, 11_000)  // 1.05x
    expect(warnIfPromptGrowing("k")).toBeNull()
  })

  it("returns null for unknown keys", () => {
    expect(warnIfPromptGrowing("never-recorded")).toBeNull()
  })

  it("report omits the ring buffer", () => {
    recordPromptSize("q", 100, PARTS)
    const report = getPromptSizeReport()
    expect(report[0]).not.toHaveProperty("ring")
  })
})
