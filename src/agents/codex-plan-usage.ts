// --- Codex plan usage, from Codex's own session files (#2101 R28b) ---
//
// Codex has no usage endpoint we can ask. Each time it answers, it writes a
// `token_count` event into its session file under
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl, and that event carries the
// plan's limits as the server sent them:
//
//   {"timestamp":"…","type":"event_msg","payload":{"type":"token_count",…,
//    "rate_limits":{"primary":{"used_percent":9.0,"window_minutes":300,"resets_at":1795665462},
//                   "secondary":{"used_percent":19.0,"window_minutes":10080,"resets_at":…},
//                   "plan_type":"plus",…}}}
//
// So a reading is only as fresh as the last Codex run on this machine: the
// Hub shows its age. Only the newest few files are opened, and only their
// tail is read. AgentX only reads these files, never writes them.

import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { PlanWindowReading } from "./claude-plan-usage"

export interface CodexPlanUsage {
  windows: PlanWindowReading[]
  /** When Codex wrote the event (ms). */
  readAt: number
  /** "plus", "pro", … as Codex names the plan, when it does. */
  plan?: string
}

/** How much of the end of a session file is read. */
const TAIL_BYTES = 256 * 1024
/** How many of the newest session files are tried. */
const MAX_FILES = 6
/** How many of the newest day folders are walked: a home full of empty or
 *  reading-less days (API-key runs) stops here instead of walking them all. */
const MAX_DAYS = 14
/** How long one reading is kept before the files are read again. */
export const CODEX_USAGE_CACHE_MS = 60_000

function windowName(minutes: unknown, fallback: string): string {
  if (minutes === 300) return "five_hour"
  if (minutes === 10080) return "seven_day"
  return typeof minutes === "number" && minutes > 0 ? `window_${minutes}m` : fallback
}

function epochMs(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? (v > 1e10 ? v : v * 1000) : undefined
}

function codexWindow(raw: unknown, fallback: string, at: number): PlanWindowReading | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const pct = o.used_percent
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null
  // Older Codex builds wrote how long until the reset, not when.
  const resetsAt = epochMs(o.resets_at) ?? (typeof o.resets_in_seconds === "number" && o.resets_in_seconds >= 0 ? at + o.resets_in_seconds * 1000 : undefined)
  return { window: windowName(o.window_minutes, fallback), utilization: Math.max(0, pct) / 100, ...(resetsAt && { resetsAt }) }
}

/** The plan limits in one session-file line, or null when it has none. */
export function codexRateLimitsFromLine(line: string, fallbackAt = 0): CodexPlanUsage | null {
  if (!line.includes('"rate_limits"')) return null
  let e: any
  try { e = JSON.parse(line) } catch { return null }
  const p = e?.payload
  const rl = p?.type === "token_count" ? p.rate_limits : e?.type === "token_count" ? e.rate_limits : null
  if (!rl || typeof rl !== "object") return null
  const at = Date.parse(e.timestamp) || fallbackAt
  const windows = [codexWindow(rl.primary, "five_hour", at), codexWindow(rl.secondary, "seven_day", at)].filter((w): w is PlanWindowReading => !!w)
  if (!windows.length) return null
  return { windows, readAt: at, ...(typeof rl.plan_type === "string" && rl.plan_type && { plan: rl.plan_type }) }
}

/** The last reading in a file's text: the bottom-most line that has one. */
export function codexRateLimitsFromText(text: string, fallbackAt = 0): CodexPlanUsage | null {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = codexRateLimitsFromLine(lines[i], fallbackAt)
    if (r) return r
  }
  return null
}

async function names(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).sort().reverse() } catch { return [] }
}

/** The newest session files, newest first: walks YYYY/MM/DD from the end. */
async function newestSessionFiles(sessions: string, max: number, maxDays = MAX_DAYS): Promise<string[]> {
  const out: string[] = []
  let days = 0
  for (const y of await names(sessions)) {
    if (!/^\d{4}$/.test(y)) continue
    for (const m of await names(join(sessions, y))) {
      if (!/^\d{2}$/.test(m)) continue
      for (const d of await names(join(sessions, y, m))) {
        if (!/^\d{2}$/.test(d)) continue
        if (++days > maxDays) return out
        const dir = join(sessions, y, m, d)
        const files = (await names(dir)).filter((f) => f.endsWith(".jsonl"))
        const timed = await Promise.all(files.map(async (f) => ({ f: join(dir, f), t: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })))
        out.push(...timed.sort((a, b) => b.t - a.t).map((x) => x.f))
        if (out.length >= max) return out.slice(0, max)
      }
    }
  }
  return out
}

async function tail(file: string): Promise<{ text: string; mtime: number }> {
  const fh = await open(file, "r")
  try {
    const st = await fh.stat()
    const len = Math.min(st.size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, st.size - len)
    return { text: buf.toString("utf8"), mtime: st.mtimeMs }
  } finally {
    await fh.close()
  }
}

/**
 * The newest plan reading Codex wrote under `codexHome`, or null when no
 * recent session file has one (no Codex run yet, or an API-key login, which
 * has no plan limits).
 */
export async function readCodexPlanUsage(codexHome: string, maxFiles = MAX_FILES, maxDays = MAX_DAYS): Promise<CodexPlanUsage | null> {
  const files = await newestSessionFiles(join(codexHome, "sessions"), maxFiles, maxDays)
  // Newest file first: the first one with a reading is the newest reading.
  for (const f of files) {
    const t = await tail(f).catch(() => null)
    const r = t && codexRateLimitsFromText(t.text, t.mtime)
    if (r) return r
  }
  return null
}

const cache = new Map<string, { at: number; value: Promise<CodexPlanUsage | null> }>()

/**
 * readCodexPlanUsage, kept CODEX_USAGE_CACHE_MS per Codex home: the Hub's
 * footer polls GET /usage/plan, and each read walks folders and opens files.
 * Calls that come while a read runs share it.
 */
export function readCodexPlanUsageCached(codexHome: string, now = Date.now()): Promise<CodexPlanUsage | null> {
  const hit = cache.get(codexHome)
  if (hit && now - hit.at < CODEX_USAGE_CACHE_MS) return hit.value
  const value = readCodexPlanUsage(codexHome).catch(() => null)
  cache.set(codexHome, { at: now, value })
  return value
}

/** For tests. */
export function clearCodexPlanUsageCache(): void { cache.clear() }
