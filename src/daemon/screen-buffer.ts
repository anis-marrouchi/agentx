import { spawn, type ChildProcess } from "child_process"
import { existsSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createInterface } from "readline"
import { regionArgs, resolveRegion } from "@/computer-use/capture"
import type { ScreenSettings } from "@/computer-use/capture-settings"

// The daemon's short memory of the screen (agentx.json `screen.buffer`).
//
// When enabled, one AgentX Helper `buffer` process samples a region into
// an in-memory ring. An agent that arrives after the moment — the banner
// has already gone — asks for the recent frames, and only then are they
// written out, to a fresh private temp directory. Off by default, and
// nothing is kept on disk while it runs.
//
// The helper ends when its stdin closes, so it never outlives the daemon.

export interface RecentFrames {
  frames: Array<{ path: string; ageMs: number; width: number; height: number }>
  region: { x: number; y: number; width: number; height: number }
}

type Buffer = ScreenSettings["buffer"]

export class ScreenBuffer {
  private child: ChildProcess | null = null
  private running: string | null = null
  private waiting: Array<(line: string) => void> = []

  constructor(
    /** Resolved when the buffer starts, so installing the helper later works. */
    private readonly helper: () => string | null,
    private readonly log: (m: string) => void,
    private readonly deps: { spawn?: typeof spawn; platform?: NodeJS.Platform } = {},
  ) {}

  get active(): boolean { return this.child !== null }

  /** Start, restart or stop the helper so it matches the settings. */
  configure(settings: ScreenSettings): void {
    const b = settings.buffer
    const want = b.enabled && (this.deps.platform ?? process.platform) === "darwin"
    const key = want ? JSON.stringify([b, settings.regions[b.region] ?? null, settings.changeThreshold]) : null
    if (key === this.running) return
    this.stop()
    if (!key) return
    const helper = this.helper()
    if (!helper || !existsSync(helper)) {
      this.log("[screen] buffer enabled but AgentX Helper is not installed — run agentx desktop install")
      return
    }
    let region
    try { region = resolveRegion(b.region, settings) } catch (e: any) {
      this.log(`[screen] buffer not started: ${e.message}`)
      return
    }
    const child = (this.deps.spawn ?? spawn)(helper, [
      "buffer", ...regionArgs(region),
      "--fps", String(b.fps), "--seconds", String(b.seconds),
      "--max-pixels", String(b.maxPixels), "--threshold", String(settings.changeThreshold),
    ], { stdio: ["pipe", "pipe", "ignore"] })
    this.child = child
    this.running = key
    createInterface({ input: child.stdout! }).on("line", (line) => this.waiting.shift()?.(line))
    child.on("exit", (code) => {
      if (this.child !== child) return
      this.log(`[screen] buffer helper exited (${code ?? "signal"})`)
      this.child = null
      this.running = null
      for (const w of this.waiting.splice(0)) w(JSON.stringify({ ok: false, error: "buffer stopped" }))
    })
    this.log(`[screen] buffer on: ${b.region}, ${b.seconds}s at ${b.fps} fps`)
  }

  stop(): void {
    const child = this.child
    this.child = null
    this.running = null
    if (child) child.stdin?.end()
  }

  /** Write the frames from the last `seconds` to a new private directory. */
  recent(seconds: number, timeoutMs = 10_000): Promise<RecentFrames> {
    const child = this.child
    if (!child?.stdin) return Promise.reject(new Error("screen buffer is off — enable screen.buffer in agentx.json"))
    const dir = mkdtempSync(join(tmpdir(), "agentx-screen-"))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== answer)
        reject(new Error("screen buffer did not answer"))
      }, timeoutMs)
      const answer = (line: string) => {
        clearTimeout(timer)
        let res: any
        try { res = JSON.parse(line) } catch { return reject(new Error("screen buffer sent an unreadable reply")) }
        if (!res.ok) return reject(new Error(res.error ?? "screen buffer failed"))
        resolve({ frames: res.frames, region: { x: res.region.x, y: res.region.y, width: res.region.w, height: res.region.h } })
      }
      this.waiting.push(answer)
      child.stdin!.write(`dump ${seconds} ${dir}\n`)
    })
  }
}
