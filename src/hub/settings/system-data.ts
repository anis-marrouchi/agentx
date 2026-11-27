// --- Settings › Mesh, Machine and Diagnostics: what they read, and the pure sums on it (#2101 ST3b) ---
//
// The same endpoints the old Settings reads (wall-settings-mesh,
// -machine and -diagnostics.client.ts), so nothing new on the server:
// /api/admin/state (mesh, nodeName, screen), /api/admin/tokens,
// /api/admin/config/hidden, /api/admin/observability/* and
// /api/admin/doctor. Writes go through useWrite (fields.tsx) to
// /api/admin/wall/settings/*.
import type { WorkState } from "./work-data"

export interface MeshPeer { url: string; name: string; hasToken?: boolean }
export interface MeshState { enabled?: boolean; peers?: MeshPeer[]; healthCheck?: { interval?: number; timeout?: number } }
export interface Rect { x: number; y: number; width: number; height: number }
export interface ScreenState {
  maxPixels?: number; timeoutMs?: number; intervalMs?: number; changeThreshold?: number; stableMs?: number
  regions?: Record<string, Rect>
  buffer?: { enabled?: boolean; region?: string; seconds?: number; fps?: number; maxPixels?: number }
}
export interface SystemState extends WorkState { mesh?: MeshState; nodeName?: string; screen?: ScreenState }
export interface Token {
  id: string; name: string; prefix?: string; scopes?: string[]
  createdAt?: string; expiresAt?: string | null; revokedAt?: string | null; lastUsedAt?: string | null
}

// --- Mesh and tokens ---

const DAY = 86_400_000
export type TokenState = "active" | "stale" | "expired" | "revoked"

/** Revoked, expired, not used for 30 days, or active: the old Settings' rule. */
export function tokenState(t: Token, now = Date.now()): TokenState {
  if (t.revokedAt) return "revoked"
  if (t.expiresAt && Date.parse(t.expiresAt) < now) return "expired"
  if (t.lastUsedAt && now - Date.parse(t.lastUsedAt) > 30 * DAY) return "stale"
  return "active"
}

export const BASE_SCOPES: readonly [string, string][] = [
  ["dashboard:read", "Read the dashboard and Live"],
  ["dashboard:write", "Change settings: full control"],
  ["agent:*", "Message any public agent"],
  ["mesh:peer", "A mesh peer (another machine)"],
]

/** The scopes a new token may take: the base four, then each public agent. */
export function tokenScopes(agents: { id: string; name?: string; access?: string }[] = []): [string, string][] {
  return [...BASE_SCOPES, ...agents.filter((a) => a.access === "public").map((a): [string, string] => ["agent:" + a.id, `Message ${a.name || a.id} (${a.id})`])]
}

// --- Screen capture ---

export const BUILT_IN_REGIONS = ["window", "screen", "menubar", "notifications"] as const

export function regionsText(regions: Record<string, Rect> | undefined): string {
  return Object.entries(regions ?? {}).map(([n, r]) => `${n}=${r.x},${r.y},${r.width},${r.height}`).join("\n")
}

/** The box's lines as the `regions` patch: each named region set, and each
 *  region taken out of the box sent as null so the server deletes it.
 *  A line with no name is refused here; the server checks the numbers. */
export function regionsPatch(text: string, before: Record<string, Rect> | undefined): Record<string, string | null> | { error: string } {
  const out: Record<string, string | null> = {}
  for (const n of Object.keys(before ?? {})) out[n] = null
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    const at = t.indexOf("=")
    if (at < 1) return { error: "write each region as name=x,y,width,height" }
    out[t.slice(0, at).trim()] = t.slice(at + 1).trim()
  }
  return out
}

/** A file size as the old Advanced section writes it. */
export function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1) + " KB"
}

// --- Diagnostics ---

export interface Kpis {
  tasksToday?: number; tasksDelta?: number; errorsToday?: number; errorRate?: number
  avgDurationMs?: number; p50DurationMs?: number; p95DurationMs?: number; spendToday?: number; spendDelta?: number
}
export interface AgentDay { agent_id: string; tasks?: number; errors?: number; avg_duration_ms?: number | null; last_active?: string }
export interface Failure { started_at: string; agent_id: string; channel?: string; message_preview?: string; error?: string; plain?: string }
export interface Overview { kpis?: Kpis; perAgent?: AgentDay[]; perChannel?: { channel: string; tasks?: number; errors?: number }[]; idleAgents?: string[]; recentErrors?: Failure[] }
export interface Bucket { tasks?: number; errors?: number }
export interface Activity {
  hourly?: (Bucket & { hour: string })[]; daily?: (Bucket & { day: string })[]
  perAgent?: { agent_id: string; tasks_24h?: number; tasks_7d?: number; errors_7d?: number; avg_duration_ms?: number | null; last_active?: string }[]
}
export interface Rows<T> { rows?: T[] }
export interface RouteRow { at: string; channel?: string; chat_id?: string; kind?: string; deciding_stage?: string; agent_id?: string; reason?: string }
export interface RotationRow { rotated_at: string; agent_id?: string; channel?: string; reason?: string; last_turn_input_tokens?: number | null }
export interface DoctorCheck { severity: "ok" | "warn" | "fail"; group: string; title: string; detail?: string; fix?: string }
export interface Doctor { checks?: DoctorCheck[]; summary?: { ok?: number; warnings?: number; errors?: number } }

export const num = (n: number | null | undefined) => (n == null ? "–" : Number(n).toLocaleString("en-US"))
export function ms(n: number | null | undefined): string {
  if (!n) return "–"
  return n < 1000 ? Math.round(n) + " ms" : n < 60_000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + " s" : (n / 60_000).toFixed(1).replace(/\.0$/, "") + " min"
}
export const money = (n: number | null | undefined) => "$" + (n ?? 0).toFixed(2)

/** "▲ 31 vs yesterday", the arrow as a word for a screen reader too. */
export function delta(n: number | null | undefined, fmt: (n: number) => string): string {
  if (!n) return "Same as yesterday"
  return (n > 0 ? "▲ " : "▼ ") + fmt(Math.abs(n)) + " vs yesterday"
}

/** The server sends only the hours and days with tasks; the chart wants
 *  every slot, oldest first, empty ones as 0. Keys are UTC, as the server's. */
export function fillHours(rows: (Bucket & { hour: string })[] = [], now = Date.now()): (Bucket & { at: number })[] {
  const by = new Map(rows.map((r) => [r.hour.slice(0, 13), r]))
  const top = Math.floor(now / 3_600_000) * 3_600_000
  return Array.from({ length: 24 }, (_, i) => {
    const at = top - (23 - i) * 3_600_000
    const r = by.get(new Date(at).toISOString().slice(0, 13))
    return { at, tasks: r?.tasks ?? 0, errors: r?.errors ?? 0 }
  })
}

export function fillDays(rows: (Bucket & { day: string })[] = [], now = Date.now()): (Bucket & { at: number })[] {
  const by = new Map(rows.map((r) => [r.day.slice(0, 10), r]))
  const top = Math.floor(now / DAY) * DAY
  return Array.from({ length: 7 }, (_, i) => {
    const at = top - (6 - i) * DAY
    const r = by.get(new Date(at).toISOString().slice(0, 10))
    return { at, tasks: r?.tasks ?? 0, errors: r?.errors ?? 0 }
  })
}

/** A log line's tone, as the old tail colours it. */
export function lineTone(line: string): "err" | "warn" | "dim" | "" {
  const l = line.toLowerCase()
  if (l.includes("error") || l.includes("fail")) return "err"
  if (l.includes("warn")) return "warn"
  if (l.includes("debug") || l.includes("[graph]")) return "dim"
  return ""
}
