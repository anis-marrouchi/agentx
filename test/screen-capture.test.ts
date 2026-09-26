import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "events"
import { PassThrough } from "stream"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { captureAround, captureArgs, captureShot, regionArgs, resolveRegion } from "../src/computer-use/capture"
import { DEFAULT_SCREEN, patchScreen, screenSettings } from "../src/computer-use/capture-settings"
import { ScreenBuffer } from "../src/daemon/screen-buffer"
import { proofAlert } from "../src/notify/proof"
import { daemonConfigSchema } from "../src/daemon/config"

// Event-aware capture: wait for a change or for the screen to settle,
// arm before an action, keep recent frames in memory only, crop and scale.

const minimal = { node: { id: "n", name: "n" } }

/** A stand-in for the helper process: scripted stderr/stdout and exit. */
function fakeHelper(script: (p: { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; close: () => void }) => void) {
  const calls: string[][] = []
  const spawn = vi.fn((_file: string, args: string[]) => {
    calls.push(args)
    const proc: any = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.stdin = new PassThrough()
    const close = () => { proc.stdout.end(); setImmediate(() => proc.emit("close", 0)) }
    setImmediate(() => script({ stdout: proc.stdout, stderr: proc.stderr, stdin: proc.stdin, close }))
    return proc
  })
  return { spawn: spawn as any, calls }
}

// Any existing file stands in for the helper binary.
const dir = mkdtempSync(join(tmpdir(), "agentx-capture-test-"))
const helper = join(dir, "helper")
writeFileSync(helper, "")
const shotJson = (extra: object = {}) => JSON.stringify({ ok: true, path: join(dir, "none.png"), region: { x: 1, y: 2, w: 3, h: 4 }, ...extra })

describe("screen config", () => {
  it("defaults: downscale on, buffer off", () => {
    const cfg = daemonConfigSchema.parse(minimal)
    expect(cfg.screen).toEqual(DEFAULT_SCREEN)
    expect(cfg.screen.buffer.enabled).toBe(false)
  })

  it("fills a partial block", () => {
    expect(screenSettings({ buffer: { enabled: true } } as any).buffer).toEqual({ ...DEFAULT_SCREEN.buffer, enabled: true })
  })
})

describe("patchScreen — the one write rule for the CLI and the dashboard", () => {
  it("adds, changes and removes named regions", () => {
    const a = patchScreen({}, { regions: { chat: "0,60,720,800" } })
    expect(a.regions).toEqual({ chat: { x: 0, y: 60, width: 720, height: 800 } })
    expect(patchScreen(a, { regions: { chat: null } }).regions).toEqual({})
  })

  it("refuses values that would not load", () => {
    expect(() => patchScreen({}, { changeThreshold: 2 })).toThrow(/between 0 and 1/)
    expect(() => patchScreen({}, { maxPixels: "" })).toThrow(/whole number/)
    expect(() => patchScreen({}, { regions: { Bad: "0,0,1,1" } })).toThrow(/region name/)
    expect(() => patchScreen({}, { regions: { ok: "0,0,0,1" } })).toThrow(/width and height/)
    expect(() => patchScreen({}, { buffer: { fps: 50 } })).toThrow(/at most 10/)
  })

  it("accepts a buffer region only if it names a region", () => {
    expect(patchScreen({}, { buffer: { region: "notifications" } }).buffer?.region).toBe("notifications")
    expect(patchScreen({}, { regions: { chat: "0,0,10,10" }, buffer: { region: "chat" } }).buffer?.region).toBe("chat")
    expect(patchScreen({}, { buffer: { region: "0,0,10,10" } }).buffer?.region).toBe("0,0,10,10")
    expect(() => patchScreen({}, { buffer: { region: "nowhere" } })).toThrow(/not a region/)
  })
})

describe("regions", () => {
  it("resolves built-ins, named regions (which may override) and rects", () => {
    expect(resolveRegion("notifications")).toEqual({ kind: "notifications" })
    const settings = screenSettings({ regions: { notifications: { x: 1, y: 2, width: 3, height: 4 } } } as any)
    expect(resolveRegion("notifications", settings)).toEqual({ kind: "rect", x: 1, y: 2, width: 3, height: 4 })
    expect(resolveRegion("5,6,7,8")).toEqual({ kind: "rect", x: 5, y: 6, width: 7, height: 8 })
    expect(() => resolveRegion("nope")).toThrow(/unknown region/)
  })

  it("maps each region to helper flags", () => {
    expect(regionArgs({ kind: "window" })).toEqual([])
    expect(regionArgs({ kind: "notifications" })).toEqual(["--notifications"])
    expect(regionArgs({ kind: "menubar", index: 1 })).toEqual(["--menubar", "--screen", "1"])
    expect(regionArgs({ kind: "rect", x: 1, y: 2, width: 3, height: 4 })).toEqual(["--x", "1", "--y", "2", "--w", "3", "--h", "4"])
  })

  it("downscales by default and passes the wait settings from agentx.json", () => {
    const s = screenSettings({ timeoutMs: 900, stableMs: 250 } as any)
    expect(captureArgs({ kind: "screen" }, "/o.png", {}, s)).toEqual(["capture", "--out", "/o.png", "--max-pixels", "1200000", "--screen-full"])
    const waiting = captureArgs({ kind: "notifications" }, "/o.png", { untilChanged: true, untilStable: true, onArmed: () => {} }, s)
    expect(waiting).toEqual(expect.arrayContaining(["--until-changed", "--until-stable", "--armed"]))
    expect(waiting.join(" ")).toContain("--timeout 900")
    expect(waiting.join(" ")).toContain("--stable-ms 250")
  })
})

describe("captureShot", () => {
  it("reports what the wait saw", async () => {
    const { spawn } = fakeHelper(({ stdout, close }) => { stdout.write(shotJson({ changed: true, stable: true, timedOut: false, waitedMs: 640 })); close() })
    const shot = await captureShot({ kind: "notifications" }, { untilChanged: true, untilStable: true }, { helper, spawn })
    expect(shot).toMatchObject({ changed: true, stable: true, timedOut: false, waitedMs: 640, region: { x: 1, y: 2, width: 3, height: 4 } })
  })

  it("passes the helper's reason on failure", async () => {
    const { spawn } = fakeHelper(({ stdout, close }) => { stdout.write(JSON.stringify({ ok: false, error: "check Screen Recording permission" })); close() })
    await expect(captureShot({ kind: "screen" }, {}, { helper, spawn })).rejects.toThrow(/Screen Recording/)
  })

  it("refuses a frame from a helper too old to wait", async () => {
    const { spawn } = fakeHelper(({ stdout, close }) => { stdout.write(shotJson()); close() })
    await expect(captureShot({ kind: "screen" }, { untilStable: true }, { helper, spawn })).rejects.toThrow(/out of date/)
  })
})

describe("captureAround — arm, act, capture", () => {
  it("starts the action only once the baseline is taken", async () => {
    const order: string[] = []
    const { spawn } = fakeHelper(({ stdout, stderr, close }) => {
      setTimeout(() => { order.push("armed"); stderr.write("armed\n") }, 20)
      setTimeout(() => { stdout.write(shotJson({ changed: true, stable: true, timedOut: false, waitedMs: 300 })); close() }, 40)
    })
    const { result, shot } = await captureAround(async () => { order.push("action"); return 7 }, { kind: "notifications" }, {}, { helper, spawn })
    expect(order).toEqual(["armed", "action"])
    expect(result).toBe(7)
    expect(shot?.changed).toBe(true)
  })

  it("still runs the action when the capture cannot", async () => {
    const action = vi.fn(async () => "done")
    const r = await captureAround(action, { kind: "screen" }, {}, { helper: join(dir, "missing") })
    expect(action).toHaveBeenCalledOnce()
    expect(r).toMatchObject({ result: "done", shot: null, error: expect.stringMatching(/helper not built/) })
  })
})

describe("notify --proof", () => {
  it("returns the frame showing the banner", async () => {
    const { spawn } = fakeHelper(({ stdout, stderr, close }) => {
      stderr.write("armed\n")
      setTimeout(() => { stdout.write(shotJson({ changed: true, stable: true, timedOut: false, waitedMs: 700 })); close() }, 10)
    })
    const alert = vi.fn(async () => {})
    const p = proofAlert(alert, { kind: "notifications" }, { helper, spawn })
    expect(p.proof().shot).toBeNull()
    await p.alert("AgentX", "hello")
    expect(alert).toHaveBeenCalledWith("AgentX", "hello")
    expect(p.proof()).toEqual({ shot: expect.objectContaining({ changed: true }), error: undefined })
  })

  it("says so when the banner region never changed", async () => {
    const { spawn } = fakeHelper(({ stdout, stderr, close }) => {
      stderr.write("armed\n")
      stdout.write(shotJson({ changed: false, stable: false, timedOut: true, waitedMs: 5000 })); close()
    })
    const p = proofAlert(async () => {}, { kind: "notifications" }, { helper, spawn })
    await p.alert("t", "m")
    expect(p.proof().error).toMatch(/did not change/)
  })
})

describe("ScreenBuffer — recent frames, in memory, opt-in", () => {
  const on = (extra: object = {}) => screenSettings({ buffer: { enabled: true, region: "notifications", seconds: 6, fps: 3, ...extra } } as any)

  it("starts nothing while off, or off a Mac", () => {
    const { spawn } = fakeHelper(() => {})
    new ScreenBuffer(() => helper, () => {}, { spawn, platform: "darwin" }).configure(screenSettings(undefined))
    new ScreenBuffer(() => helper, () => {}, { spawn, platform: "linux" }).configure(on())
    expect(spawn).not.toHaveBeenCalled()
  })

  it("starts once, restarts on a change, stops when turned off", () => {
    const { spawn, calls } = fakeHelper(() => {})
    const buf = new ScreenBuffer(() => helper, () => {}, { spawn, platform: "darwin" })
    buf.configure(on())
    buf.configure(on())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(["buffer", "--notifications", "--fps", "3", "--seconds", "6", "--max-pixels", "300000", "--threshold", "0.015"])
    buf.configure(on({ fps: 1 }))
    expect(calls).toHaveLength(2)
    buf.configure(screenSettings(undefined))
    expect(buf.active).toBe(false)
  })

  it("asks the helper for frames and returns their paths", async () => {
    let asked = ""
    const { spawn } = fakeHelper(({ stdin, stdout }) => {
      stdin.on("data", (d) => {
        asked = String(d)
        stdout.write(JSON.stringify({ ok: true, frames: [{ path: "/t/frame-000.png", ageMs: 1200, width: 400, height: 170 }], region: { x: 1, y: 2, w: 3, h: 4 } }) + "\n")
      })
    })
    const buf = new ScreenBuffer(() => helper, () => {}, { spawn, platform: "darwin" })
    buf.configure(on())
    const r = await buf.recent(4)
    expect(asked).toMatch(/^dump 4 \S*agentx-screen-\S+\n$/)
    expect(r.frames[0].ageMs).toBe(1200)
    expect(r.region).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it("refuses when off", async () => {
    await expect(new ScreenBuffer(() => helper, () => {}, { platform: "darwin" }).recent(3)).rejects.toThrow(/buffer is off/)
  })
})

describe("dashboard Screen capture card", () => {
  it("ships its controls in a page script that parses", async () => {
    const { renderAdminPage } = await import("../src/daemon/ui/pages/admin")
    const html = renderAdminPage()
    for (const id of ["screen-max-pixels", "screen-regions", "screen-buffer-enabled", "screen-buffer-region"]) {
      expect(html).toContain(`id="${id}"`)
    }
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1])).not.toThrow()
    }
  })
})

// The wait loop and the ring are Swift; their tests compile with swiftc.
const canSwift = process.platform === "darwin" && (() => {
  try { execFileSync("xcrun", ["--find", "swiftc"], { stdio: "pipe" }); return true } catch { return false }
})()

describe.skipIf(!canSwift)("helper: wait-for-change, wait-for-stable, ring", () => {
  it("passes the Swift tests", () => {
    const script = join(__dirname, "..", "apps", "mac-helper", "test.sh")
    expect(existsSync(script)).toBe(true)
    expect(execFileSync("/bin/bash", [script], { encoding: "utf8" })).toContain("capture tests passed")
  }, 120_000)
})
