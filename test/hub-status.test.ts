import { describe, expect, it } from "vitest"
import { hubUsageText, HUB_STATUS_HTML } from "../src/daemon/ui/pages/hub-status"
import { renderWallPage } from "../src/daemon/ui/pages/wall"

describe("Hub bottom status", () => {
  const now = Date.UTC(2026, 10, 24, 14)

  it("shows only reported plan windows and their remaining reset time", () => {
    expect(hubUsageText([
      { window: "five_hour", utilization: 0.756, resetsAt: now + 31 * 60_000 },
      { window: "seven_day", utilization: 0.34, resetsAt: now + 7 * 60_000 },
    ], now)).toBe("5h 76% · resets in 31m · 7d 34% · resets in 7m")
  })

  it("does not invent a percentage for a missing reading", () => {
    expect(hubUsageText([], now)).toBe("5h not known · 7d not known")
    expect(hubUsageText([{ window: "five_hour", utilization: 1.5 }], now)).toBe("5h 100% · 7d not known")
  })

  it("adds the status strip without replacing the phone navigation", () => {
    expect(HUB_STATUS_HTML).toContain("Codex: not known")
    const html = renderWallPage({ owner: true })
    expect(html).toContain('id="hub-status"')
    expect(html).toContain('id="wall-more"')
  })
})
