import { describe, it, expect } from "vitest"
import { helperStatus } from "../src/notify/helper-status"
import { runNotificationChecks, type Check } from "../src/commands/doctor"

// Why a banner shows the Script Editor icon, in words a person can act on.

const answer = (json: string | null) => async () => json
const mac = { platform: "darwin" as const, helper: "/Apps/AgentX Helper.app/Contents/MacOS/agentx-mac-helper" }

describe("helperStatus", () => {
  it("says nothing applies off a Mac", async () => {
    expect((await helperStatus({ platform: "linux" })).state).toBe("unsupported")
  })

  it("names the install command when the helper is missing", async () => {
    const s = await helperStatus({ platform: "darwin", helper: null })
    expect(s.state).toBe("missing")
    expect(s.message).toContain("Script Editor")
    expect(s.fix).toContain("agentx desktop install")
    // `agentx notify` takes one message argument; the title is an option.
    expect(s.fix).toContain('agentx notify "Hello" --title "Test"')
  })

  it("points at System Settings when macOS does not allow it", async () => {
    const s = await helperStatus({ ...mac, run: answer('{"ok":true,"authorization":"denied","alertStyle":"none"}') })
    expect(s.state).toBe("not-allowed")
    expect(s.message).toContain("does not allow AgentX Helper to notify")
    expect(s.fix).toContain("System Settings › Notifications › AgentX Helper")
  })

  it("asks for a test banner when macOS has not asked yet", async () => {
    const s = await helperStatus({ ...mac, run: answer('{"ok":true,"authorization":"notDetermined","alertStyle":"banner"}') })
    expect(s.state).toBe("not-asked")
    expect(s.fix).toContain("click Allow")
  })

  it("flags a banner style of None", async () => {
    const s = await helperStatus({ ...mac, run: answer('{"ok":true,"authorization":"authorized","alertStyle":"none"}') })
    expect(s.state).toBe("hidden")
    expect(s.fix).toContain("Banners")
  })

  it("asks to reinstall a helper that does not know notify-status", async () => {
    const s = await helperStatus({ ...mac, run: answer(null) })
    expect(s.state).toBe("outdated")
    expect(s.fix).toContain("agentx desktop install")
  })

  it("is ready when allowed with banners, and passes the right verb", async () => {
    const calls: string[][] = []
    const s = await helperStatus({ ...mac, run: async (file, args) => { calls.push([file, ...args]); return '{"ok":true,"authorization":"authorized","alertStyle":"banner"}' } })
    expect(s.state).toBe("ready")
    expect(s.fix).toBeUndefined()
    expect(calls).toEqual([[mac.helper, "notify-status"]])
  })
})

describe("agentx doctor › Notifications", () => {
  const notAllowed = async () => ({ state: "not-allowed" as const, message: "macOS does not allow AgentX Helper to notify", fix: "Open System Settings" })

  it("warns with the fix when banners are on and the helper may not notify", async () => {
    const checks: Check[] = []
    await runNotificationChecks(checks, {}, notAllowed)
    expect(checks).toEqual([expect.objectContaining({ severity: "warn", group: "Notifications", fix: "Open System Settings" })])
  })

  it("stays quiet when banners are off", async () => {
    const checks: Check[] = []
    await runNotificationChecks(checks, { notifications: { local: { banner: false } } }, notAllowed)
    expect(checks).toEqual([])
  })
})
