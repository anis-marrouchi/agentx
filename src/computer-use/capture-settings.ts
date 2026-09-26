import type { DaemonConfig } from "@/daemon/config"

// The `screen` block of agentx.json and the one write rule for it, shared
// by `agentx screen config` and the dashboard so both refuse the same
// values.

export type ScreenSettings = DaemonConfig["screen"]
type Rect = ScreenSettings["regions"][string]

export const DEFAULT_SCREEN: ScreenSettings = {
  maxPixels: 1_200_000,
  timeoutMs: 5_000,
  intervalMs: 100,
  changeThreshold: 0.015,
  stableMs: 400,
  regions: {},
  buffer: { enabled: false, seconds: 10, fps: 2, region: "screen", maxPixels: 300_000 },
}

/** Fill gaps in a partial `screen` block with the defaults. */
export function screenSettings(cfg: Partial<ScreenSettings> | undefined): ScreenSettings {
  return {
    ...DEFAULT_SCREEN,
    ...(cfg ?? {}),
    regions: { ...(cfg?.regions ?? {}) },
    buffer: { ...DEFAULT_SCREEN.buffer, ...(cfg?.buffer ?? {}) },
  }
}

const REGION_NAME = /^[a-z][\w-]*$/

/** Regions the helper knows without configuration; `screen.regions` adds
 *  more and may override these. */
export const BUILT_IN_REGIONS = ["window", "screen", "menubar", "notifications"]

function num(v: unknown, what: string, ok: (n: number) => boolean, rule: string): number {
  const n = Number(v)
  if (v === "" || v === null || !Number.isFinite(n) || !ok(n)) throw new Error(`${what} must be ${rule}`)
  return n
}
const positiveInt = (v: unknown, what: string) => num(v, what, (n) => Number.isInteger(n) && n > 0, "a whole number above 0")

/** "x,y,w,h" or {x, y, width, height} → a rect, or an error. */
export function parseRect(v: unknown): Rect {
  const r = typeof v === "string" ? v.split(",").map(Number) : [(v as any)?.x, (v as any)?.y, (v as any)?.width, (v as any)?.height].map(Number)
  if (r.length !== 4 || !r.every(Number.isFinite) || r[2] <= 0 || r[3] <= 0) throw new Error("a region is x,y,width,height in screen points, with width and height above 0")
  return { x: r[0], y: r[1], width: r[2], height: r[3] }
}

/**
 * Apply a change to a stored `screen` block. Returns the new block;
 * throws on a value that would not load. `regions` entries set to null
 * are removed.
 */
export function patchScreen(current: Partial<ScreenSettings> | undefined, patch: Record<string, any>): Partial<ScreenSettings> {
  const next: Record<string, any> = { ...(current ?? {}) }
  if ("maxPixels" in patch) next.maxPixels = positiveInt(patch.maxPixels, "maxPixels")
  if ("timeoutMs" in patch) next.timeoutMs = positiveInt(patch.timeoutMs, "timeoutMs")
  if ("intervalMs" in patch) next.intervalMs = positiveInt(patch.intervalMs, "intervalMs")
  if ("stableMs" in patch) next.stableMs = num(patch.stableMs, "stableMs", (n) => Number.isInteger(n) && n >= 0, "a whole number, 0 or more")
  if ("changeThreshold" in patch) next.changeThreshold = num(patch.changeThreshold, "changeThreshold", (n) => n >= 0 && n <= 1, "between 0 and 1")
  if (patch.regions && typeof patch.regions === "object") {
    const regions = { ...(next.regions ?? {}) }
    for (const [name, rect] of Object.entries(patch.regions)) {
      if (!REGION_NAME.test(name)) throw new Error(`region name "${name}" must be lowercase letters, digits, - or _`)
      if (rect === null) delete regions[name]
      else regions[name] = parseRect(rect)
    }
    next.regions = regions
  }
  if (patch.buffer && typeof patch.buffer === "object") {
    const b = patch.buffer
    const buffer = { ...(next.buffer ?? {}) }
    if ("enabled" in b) buffer.enabled = Boolean(b.enabled)
    if ("seconds" in b) buffer.seconds = num(b.seconds, "buffer.seconds", (n) => n > 0 && n <= 120, "above 0 and at most 120")
    if ("fps" in b) buffer.fps = num(b.fps, "buffer.fps", (n) => n > 0 && n <= 10, "above 0 and at most 10")
    if ("maxPixels" in b) buffer.maxPixels = positiveInt(b.maxPixels, "buffer.maxPixels")
    if ("region" in b) buffer.region = String(b.region).trim()
    next.buffer = buffer
  }
  const watched = next.buffer?.region
  if (watched !== undefined && !BUILT_IN_REGIONS.includes(watched) && !next.regions?.[watched]) {
    try { parseRect(watched) } catch {
      throw new Error(`buffer.region "${watched}" is not a region — use ${[...BUILT_IN_REGIONS, ...Object.keys(next.regions ?? {})].join(", ")}, or x,y,w,h`)
    }
  }
  return next
}
