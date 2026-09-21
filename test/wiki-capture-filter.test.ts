import { describe, it, expect } from "vitest"
import { shouldCaptureEntry } from "../src/wiki/capture-filter"

const ok = (over: Partial<Parameters<typeof shouldCaptureEntry>[0]> = {}) =>
  shouldCaptureEntry({
    channel: "telegram",
    content: "User: what did we decide about the staging URL?\n\nAgent: We standardised on admin.globex.example.com.",
    responseLength: 200,
    ...over,
  })

describe("shouldCaptureEntry", () => {
  it("captures a real human exchange", () => {
    expect(ok().capture).toBe(true)
  })

  it("keeps the existing length gate", () => {
    expect(ok({ responseLength: 50 }).capture).toBe(false)
    expect(ok({ responseLength: 51 }).capture).toBe(true)
  })

  it("drops machine-origin channels", () => {
    for (const ch of ["cron", "a2a", "workflow", "selftest"]) {
      const d = ok({ channel: ch })
      expect(d.capture, ch).toBe(false)
      expect(d.reason).toContain(ch)
    }
  })

  it("drops a machine channel carrying a node suffix", () => {
    // Channels arrive as "telegram@peer-server" in the fleet.
    expect(ok({ channel: "cron@peer-server" }).capture).toBe(false)
    expect(ok({ channel: "telegram@peer-server" }).capture).toBe(true)
  })

  it("drops the four prompt shapes, quoting real captured entries", () => {
    const cases: Array<[string, string]> = [
      ["User: You are pm-globex, role: Project Manager reporting to product-director.", "role brief"],
      ["User: Run shell command: node dist/cli.js workflow absorb --since 24h", "run instruction"],
      ["User: [MISSED RUN — was scheduled for 2026-06-29T05:00:00.000Z] Run the /acme-news skill", "missed cron run"],
      ["User: [Recent group conversation] [09:11] Group: do we need to restart the daemon?", "group chat dump"],
      // Real shape from the corpus — a bracketed prefix ahead of the marker.
      ["User: [Group, 09:43]: [Recent group conversation] we deployed twice today", "group chat dump"],
    ]
    for (const [content, reason] of cases) {
      const d = ok({ content })
      expect(d.capture, content.slice(0, 40)).toBe(false)
      expect(d.reason).toBe(reason)
    }
  })

  it("does not reject a human who merely mentions running something", () => {
    // The shapes are anchored at the start for exactly this reason: a
    // question ABOUT a command is knowledge; a command IS configuration.
    expect(ok({ content: "User: why did Run shell command fail last night?\n\nAgent: The token expired." }).capture).toBe(true)
    expect(ok({ content: "User: remind me what you are responsible for\n\nAgent: Infra." }).capture).toBe(true)
  })

  it("treats a missing channel as capturable rather than guessing", () => {
    expect(ok({ channel: undefined }).capture).toBe(true)
  })
})
