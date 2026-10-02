import { readBootLog, type RestartSummary } from "@/daemon/boot-record"
import type { SelfRestartPlan, ServiceInfo } from "@/daemon/restart"
import type { DiskBuild } from "@/utils/build-info"

// --- agentx daemon status: the block above the agent list ---
//
// Which build is running, since when, what restarted it last, how often it
// restarts, whether the code on disk has moved on, and what keeps it
// running. Built from GET /health plus GET /daemon/restart (service); a
// daemon from before these fields simply gets fewer lines.
//
// Pure text over plain data, unit tested.

/** The parts of GET /health the block reads. All optional: an older daemon
 *  answers without the newer ones. */
export interface StatusHealth extends Partial<RestartSummary> {
  node?: { id?: string; name?: string }
  version?: string | null
  commit?: string | null
  startedAt?: string
  pid?: number
  build?: DiskBuild
}

export interface StatusService {
  service?: ServiceInfo
  selfRestart?: SelfRestartPlan
}

/** "2026-10-02 14:26" in the given time zone. */
export function stamp(at: string | number, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(at))
}

/** "45s", "5m", "2h 05m", "3d 4h". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`
}

function serviceLine(s: StatusService): string | null {
  if (!s.service) return null
  if (s.service.kind === "none") return "none (started from a terminal, nothing starts it again)"
  const name = s.service.kind === "launchd" ? `launchd ${s.service.label}` : `systemd ${s.service.unit}`
  if (!s.selfRestart) return name
  // plan.how ends with the restart setting in brackets, e.g. "(KeepAlive)".
  const setting = s.selfRestart.ok ? s.selfRestart.how.match(/\(([^)]+)\)$/)?.[1] : null
  return s.selfRestart.ok ? `${name}${setting ? ` (${setting})` : ""}` : `${name} (does not start it again by itself)`
}

/** The lines `agentx daemon status` prints for a running daemon. */
export function statusBlock(h: StatusHealth, s: StatusService, now: number, timeZone: string): string[] {
  const row = (label: string, text: string) => `${label.padEnd(16)}${text}`
  const lines = [`AgentX ${h.version ?? "unknown version"}${h.commit ? ` (${h.commit})` : ""}   node ${h.node?.id ?? "unknown"}`]
  if (h.startedAt) {
    lines.push(row("Running since", `${stamp(h.startedAt, timeZone)} (${timeZone}), ${ago(now - Date.parse(h.startedAt))} ago${h.pid ? `, pid ${h.pid}` : ""}`))
  }
  if (h.lastRestart) {
    const r = h.lastRestart
    const who = r.by ? `by ${r.by}${r.reason ? ` (${r.reason})` : ""}` : r.reason ? `on ${r.reason}, sender unknown` : "no clean stop on record before it"
    lines.push(row("Last restart", r.previousBootAt
      ? `${stamp(r.at, timeZone)} ${who}, previous boot ${stamp(r.previousBootAt, timeZone)}`
      : `${stamp(r.at, timeZone)}, first start on record`))
  }
  if (h.restarts) {
    const partial = h.restarts.since && Date.parse(h.restarts.since) > now - 7 * 86_400_000
      ? ` (on record since ${stamp(h.restarts.since, timeZone)})` : ""
    lines.push(row("Restarts", `${h.restarts.today} today, ${h.restarts.last7d} in the last 7 days${partial}`))
  }
  if (h.build) {
    const b = h.build
    const what = [b.version && b.version !== h.version ? b.version : null, b.changedAt ? `written ${stamp(b.changedAt, timeZone)}` : null].filter(Boolean).join(", ")
    lines.push(row("Build on disk", b.newer ? `dist newer than process: yes${what ? ` (${what})` : ""}, restart to load it` : "dist newer than process: no"))
  }
  const service = serviceLine(s)
  if (service) lines.push(row("Service", service))
  return lines
}

/** What is known about a daemon that does not answer: its last start. */
export function lastBoot(agentxDir: string): { at: string; by: string | null; reason: string | null } | null {
  const last = readBootLog(agentxDir).at(-1)
  return last ? { at: new Date(last.at).toISOString(), by: last.by, reason: last.reason } : null
}

/** The lines `agentx daemon status` prints when no daemon answers: nothing
 *  listens (stopped), or it took too long (busy or stuck, not stopped). */
export function stoppedBlock(nodeId: string, boot: ReturnType<typeof lastBoot>, now: number, timeZone: string, answered: "refused" | "timeout" = "refused"): string[] {
  return [
    `${answered === "timeout" ? "AgentX did not answer within 3 seconds" : "AgentX is stopped"}   node ${nodeId}`,
    boot
      ? `${"Last boot".padEnd(16)}${stamp(boot.at, timeZone)} (${timeZone}), ${ago(now - Date.parse(boot.at))} ago`
      : `${"Last boot".padEnd(16)}none on record in this folder`,
  ]
}
