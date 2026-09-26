import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { notify, flushHeld, NotificationQueue } from "../src/notify"
import { localAlert, localSettings, patchLocal, DEFAULT_LOCAL } from "../src/notify/local"
import { daemonConfigSchema } from "../src/daemon/config"
import { ntfyStatus, patchNtfy } from "../src/notify/ntfy-settings"

// The banner and sound on the machine that raised the notification: set
// from agentx.json, silenced by Focus like the push, and awaited so a
// caller that exits straight away does not cut them off.

const minimal = { node: { id: "n", name: "n" } }

describe("notifications.local config", () => {
  it("defaults to a banner and Glass at 0.4 when the block is absent", () => {
    const cfg = daemonConfigSchema.parse(minimal)
    expect(cfg.notifications.local).toEqual(DEFAULT_LOCAL)
  })

  it("keeps what the operator set and fills the rest", () => {
    const cfg = daemonConfigSchema.parse({ ...minimal, notifications: { local: { banner: false, volume: 0.8 } } })
    expect(cfg.notifications.local).toEqual({ banner: false, sound: true, soundName: "Glass", volume: 0.8 })
  })

  it("refuses a volume out of range and a sound name that is a path", () => {
    expect(daemonConfigSchema.safeParse({ ...minimal, notifications: { local: { volume: 2 } } }).success).toBe(false)
    expect(daemonConfigSchema.safeParse({ ...minimal, notifications: { local: { soundName: "../../x" } } }).success).toBe(false)
  })

  it("fills a partial block the way the CLI and daemon read it", () => {
    expect(localSettings(undefined)).toEqual(DEFAULT_LOCAL)
    expect(localSettings({ sound: false })).toEqual({ ...DEFAULT_LOCAL, sound: false })
  })
})

describe("patchLocal — the one write rule for the CLI and the dashboard", () => {
  it("switches banner and sound off without touching the rest", () => {
    expect(patchLocal({ soundName: "Ping" }, { banner: false, sound: false }, "linux"))
      .toEqual({ soundName: "Ping", banner: false, sound: false })
  })

  it("rejects a bad volume and a path for a sound name", () => {
    expect(() => patchLocal({}, { volume: 1.5 }, "linux")).toThrow(/volume/)
    expect(() => patchLocal({}, { volume: "loud" }, "linux")).toThrow(/volume/)
    expect(() => patchLocal({}, { soundName: "/etc/passwd" }, "linux")).toThrow(/no system sound/)
  })

  it("on a Mac, rejects a sound that is not installed", () => {
    expect(() => patchLocal({}, { soundName: "NoSuchSoundHere" }, "darwin")).toThrow(/no system sound/)
  })
})

describe("localAlert", () => {
  const calls = () => {
    const run = vi.fn(async (_file: string, _args: string[]) => {})
    return run
  }

  it("shows the banner with title and message as argv, never inside the script", async () => {
    const run = calls()
    await localAlert({ ...DEFAULT_LOCAL, sound: false }, { run, platform: "darwin" })('Build "done"', "it's green")
    expect(run).toHaveBeenCalledOnce()
    const [file, args] = run.mock.calls[0]
    expect(file).toBe("/usr/bin/osascript")
    expect(args.slice(-2)).toEqual(['Build "done"', "it's green"])
    expect(args.slice(0, -2).join(" ")).not.toMatch(/done|green/)
  })

  it("does nothing when both are off", async () => {
    const run = calls()
    await localAlert({ ...DEFAULT_LOCAL, banner: false, sound: false }, { run, platform: "darwin" })("t", "m")
    expect(run).not.toHaveBeenCalled()
  })

  it("skips quietly on other platforms", async () => {
    const run = calls()
    await localAlert(DEFAULT_LOCAL, { run, platform: "linux" })("t", "m")
    expect(run).not.toHaveBeenCalled()
  })

  it("waits for the steps to finish before resolving", async () => {
    // A detached job exits the moment notify returns; the sound must be
    // over by then, not merely started.
    let finished = false
    const run = vi.fn(() => new Promise<void>((r) => setTimeout(() => { finished = true; r() }, 20)))
    await localAlert({ ...DEFAULT_LOCAL, sound: false }, { run, platform: "darwin" })("t", "m")
    expect(finished).toBe(true)
  })
})

describe("notify with the local alert", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-notify-local-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const queue = () => new NotificationQueue(join(dir, "pending.json"))
  const focusOn = { active: true, mode: "com.apple.donotdisturb", reason: "test" }
  const focusOff = { active: false, mode: null, reason: "test" }
  const send = async () => {}

  it("shows the banner when it delivers", async () => {
    const alert = vi.fn(async () => {})
    await notify({ message: "build finished", title: "CI" }, send, { focus: focusOff, alert, queue: queue() })
    expect(alert).toHaveBeenCalledWith("CI", "build finished")
  })

  it("holds the banner along with the push during Focus", async () => {
    const alert = vi.fn(async () => {})
    const r = await notify({ message: "a client replied" }, send, { focus: focusOn, alert, queue: queue() })
    expect(r.held).toBe(true)
    expect(alert).not.toHaveBeenCalled()
  })

  it("lets an urgent banner through Focus", async () => {
    const alert = vi.fn(async () => {})
    await notify({ message: "production is down", urgent: true }, send, { focus: focusOn, alert, queue: queue() })
    expect(alert).toHaveBeenCalledOnce()
  })

  it("shows ONE banner for the backlog when Focus ends", async () => {
    const q = queue()
    const held = vi.fn(async () => {})
    for (const m of ["one", "two"]) await notify({ message: m }, send, { focus: focusOn, alert: held, queue: q })
    const alert = vi.fn(async () => {})
    expect(await flushHeld(send, { queue: q, alert })).toBe(2)
    expect(alert).toHaveBeenCalledOnce()
    expect(alert.mock.calls[0][0]).toBe("2 while you were away")
    expect(held).not.toHaveBeenCalled()
  })

  it("stays silent when the caller switches it off", async () => {
    // alert: false is what the tests and --no-sound --no-banner amount to.
    const r = await notify({ message: "quiet" }, send, { focus: focusOff, alert: false, queue: queue() })
    expect(r.delivered).toBe(true)
  })
})

describe("dashboard Notifications card", () => {
  it("ships the local controls in a page script that parses", async () => {
    const { renderAdminPage } = await import("../src/daemon/ui/pages/admin")
    const html = renderAdminPage()
    for (const id of ["notif-local-banner", "notif-local-sound", "notif-local-sound-name", "notif-local-volume"]) {
      expect(html).toContain(`id="${id}"`)
    }
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })
})

describe("channels.ntfy — set from the CLI and the dashboard", () => {
  it("never reads back the topic or token, only whether they are set", () => {
    const s = ntfyStatus({ enabled: true, topic: "secret-topic", token: "tk_x" })
    expect(s).toEqual({ enabled: true, server: "https://ntfy.sh", topicSet: true, tokenSet: true })
    expect(JSON.stringify(s)).not.toMatch(/secret-topic|tk_x/)
  })

  it("keeps env placeholders as written and removes a token set to empty", () => {
    const next = patchNtfy({ token: "old" }, { topic: "${NTFY_TOPIC}", token: "", enabled: true, server: "https://push.example.com/" })
    expect(next).toEqual({ topic: "${NTFY_TOPIC}", enabled: true, server: "https://push.example.com" })
  })

  it("refuses to enable without a topic, and a server that is not a URL", () => {
    expect(() => patchNtfy({}, { enabled: true })).toThrow(/topic/)
    expect(() => patchNtfy({ topic: "t" }, { server: "ntfy.sh" })).toThrow(/URL/)
  })
})
