import { spawn } from "child_process"
import { existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { HELPER } from "./screen"
import { BUILT_IN_REGIONS, DEFAULT_SCREEN, type ScreenSettings } from "./capture-settings"

// --- Capturing the screen at the right moment ---
//
// A frame taken whenever the caller gets round to it misses what it was
// for: a notification banner is gone in seconds, and a page that is still
// loading is caught half-drawn. So a capture can wait:
//
//   until changed   first frame after the region differs from how it
//                   looked when the capture started
//   until stable    first frame after the region has stopped moving
//
// and both, in that order, is the usual answer for "show me what my
// action did": something appears, then its animation finishes.
//
// Tied to an action (captureAround), the baseline is taken BEFORE the
// action runs — the helper says when it is armed — so a fast banner can
// never slip in between. Nothing is captured on a timer.
//
// Every capture is cropped to its region and downscaled to a pixel budget
// by default: tokens go on the pixels that matter.

export type Region =
  | { kind: "window" }
  | { kind: "screen"; index?: number }
  | { kind: "menubar"; index?: number }
  | { kind: "notifications" }
  | { kind: "rect"; x: number; y: number; width: number; height: number }

export interface Shot {
  path: string
  region: { x: number; y: number; width: number; height: number }
  bytes: number
  /** Set when the capture waited: what it saw while waiting. */
  changed?: boolean
  stable?: boolean
  timedOut?: boolean
  waitedMs?: number
}

export interface CaptureOptions {
  /** Wait for the region to change from how it looked at the start. */
  untilChanged?: boolean
  /** Wait for the region to stop changing. */
  untilStable?: boolean
  /** Where to write the PNG. Default: a fresh file in the temp directory. */
  out?: string
  /** Called once the baseline is taken; an action may start from then. */
  onArmed?: () => void
}

type Spawn = typeof spawn

const BUILT_IN = new Set(BUILT_IN_REGIONS)

/**
 * A region from what a person or agent typed: a name (built-in or from
 * `screen.regions`) or "x,y,w,h" in screen points.
 */
export function resolveRegion(spec: string | undefined, settings: ScreenSettings = DEFAULT_SCREEN): Region {
  const name = (spec ?? "window").trim()
  const named = settings.regions[name]
  if (named) return { kind: "rect", ...named }
  if (BUILT_IN.has(name)) return { kind: name } as Region
  const parts = name.split(",").map(Number)
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
    return { kind: "rect", x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
  }
  const known = [...BUILT_IN, ...Object.keys(settings.regions)].join(", ")
  throw new Error(`unknown region "${name}" — use one of ${known}, or x,y,w,h`)
}

/** Helper flags selecting a region. */
export function regionArgs(region: Region): string[] {
  switch (region.kind) {
    case "window": return []
    case "notifications": return ["--notifications"]
    case "menubar":
    case "screen": {
      const args = [region.kind === "menubar" ? "--menubar" : "--screen-full"]
      if (region.index !== undefined) args.push("--screen", String(region.index))
      return args
    }
    case "rect":
      return ["--x", String(region.x), "--y", String(region.y), "--w", String(region.width), "--h", String(region.height)]
  }
}

/** The full helper argument list for one capture. */
export function captureArgs(region: Region, out: string, opts: CaptureOptions, settings: ScreenSettings, maxPixels?: number): string[] {
  const args = ["capture", "--out", out, "--max-pixels", String(maxPixels ?? settings.maxPixels), ...regionArgs(region)]
  if (opts.untilChanged) args.push("--until-changed")
  if (opts.untilStable) args.push("--until-stable")
  if (opts.untilChanged || opts.untilStable) {
    args.push("--timeout", String(settings.timeoutMs), "--interval", String(settings.intervalMs),
              "--threshold", String(settings.changeThreshold), "--stable-ms", String(settings.stableMs))
    if (opts.onArmed) args.push("--armed")
  }
  return args
}

/** Capture a region to a cropped, downscaled PNG, waiting first when asked. */
export function captureShot(
  region: Region = { kind: "window" },
  opts: CaptureOptions = {},
  deps: { settings?: ScreenSettings; maxPixels?: number; helper?: string; spawn?: Spawn } = {},
): Promise<Shot> {
  const helper = deps.helper ?? HELPER
  if (!existsSync(helper)) return Promise.reject(new Error("helper not built — run apps/mac-helper/build.sh"))
  const settings = deps.settings ?? DEFAULT_SCREEN
  const out = opts.out ?? join(tmpdir(), `agentx-capture-${Date.now()}-${process.pid}.png`)
  const args = captureArgs(region, out, opts, settings, deps.maxPixels)

  return new Promise((resolve, reject) => {
    const child = (deps.spawn ?? spawn)(helper, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let armed = false
    child.stdout?.on("data", (d) => { stdout += d })
    child.stderr?.on("data", (d) => {
      if (!armed && String(d).includes("armed")) { armed = true; opts.onArmed?.() }
    })
    child.on("error", reject)
    child.on("close", () => {
      // The helper answers with JSON either way; a failure carries its reason.
      let res: any
      try { res = JSON.parse(stdout) } catch { return reject(new Error(`capture failed: ${stdout.slice(0, 200) || "no output"}`)) }
      if (!res.ok) return reject(new Error(res.error ?? "capture failed"))
      // A helper from before these flags captures at once and says nothing
      // about waiting: that frame is not the moment the caller asked for.
      if ((opts.untilChanged || opts.untilStable) && res.waitedMs === undefined) {
        return reject(new Error("AgentX Helper is out of date and cannot wait — run agentx desktop install"))
      }
      let bytes = 0
      try { bytes = readFileSync(res.path).length } catch { /* reported as 0 */ }
      resolve({
        path: res.path,
        region: { x: res.region.x, y: res.region.y, width: res.region.w, height: res.region.h },
        bytes,
        ...(res.waitedMs !== undefined
          ? { changed: res.changed, stable: res.stable, timedOut: res.timedOut, waitedMs: res.waitedMs }
          : {}),
      })
    })
  })
}

/**
 * Run an action and capture what it did to a region: arm first, act, then
 * take the first frame after the region changed and settled.
 *
 * The action always runs, even when the capture cannot (no helper, no
 * Screen Recording permission): the capture is evidence, not a gate. Its
 * failure comes back as `error` rather than as a thrown action.
 */
export async function captureAround<T>(
  action: () => Promise<T>,
  region: Region,
  opts: { out?: string; untilStable?: boolean } = {},
  deps: Parameters<typeof captureShot>[2] = {},
): Promise<{ result: T; shot: Shot | null; error?: string }> {
  let arm!: () => void
  const armed = new Promise<void>((r) => { arm = r })
  const shot = captureShot(region, { untilChanged: true, untilStable: opts.untilStable ?? true, out: opts.out, onArmed: () => arm() }, deps)
  shot.catch(() => undefined) // a throwing action must not leave this rejection unhandled
  // Whichever comes first: the helper is armed, or it failed before arming.
  await Promise.race([armed, shot.then(() => undefined, () => undefined)])
  const result = await action()
  try {
    return { result, shot: await shot }
  } catch (e: any) {
    return { result, shot: null, error: e?.message ?? String(e) }
  }
}
