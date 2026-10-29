// --- Plain-text view of the admission queue, for `agentx queue` (#1521) ---

import type { AdmissionSnapshot } from "./queue"

function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function where(x: { channel: string; chatId: string | null }): string {
  return x.chatId ? `${x.channel}:${x.chatId}` : x.channel
}

export function formatQueue(s: AdmissionSnapshot, now = Date.now()): string {
  const out: string[] = []
  const mode = !s.enabled ? "off (nothing is held)" : s.mode === "observe" ? "observe (logs only, nothing is held)" : "on"
  out.push(`Admission queue: ${mode}${s.checkedAt ? ` — checked ${s.checkedAt}` : ""}`)
  const r = s.resources, l = s.limits
  if (r && l) {
    out.push("")
    out.push("Resources")
    out.push(`  memory  ${r.memAvailableMB} MB available of ${r.memTotalMB} MB (needs ${l.minAvailableMemoryMB} MB)`)
    out.push(`  swap    ${r.swapTotalMB > 0 ? `${r.swapUsedMB} MB used (limit ${l.maxSwapUsedMB} MB)` : "none"}`)
    out.push(`  disk    ${r.diskFreeMB === null ? "unknown" : `${r.diskFreeMB} MB free`}${l.minDiskFreeMB > 0 ? ` (needs ${l.minDiskFreeMB} MB)` : ""}`)
    out.push(`  load    ${r.load1} on ${r.cpuCount} CPUs${l.maxLoad1 > 0 ? ` (limit ${l.maxLoad1})` : ""}`)
  }
  out.push("")
  out.push(s.gate.open ? "Gate: open" : `Gate: closed — ${s.gate.reasons.join("; ")}`)
  const classes = Object.entries(s.caps.classes).map(([n, c]) => `${n} ${c.running}/${c.max}`)
  out.push(`Caps: ${s.running.length}/${s.caps.maxSessions ?? "?"} sessions (owner +${s.caps.ownerExtraSessions}, helpers +${s.caps.delegationHeadroom})${classes.length ? `; ${classes.join(", ")}` : ""}`)
  if (s.warmUp.active) {
    const left = Math.max(0, Math.round((Date.parse(s.warmUp.until) - now) / 1000))
    out.push(`Warm-up: ${s.warmUp.startsPerInterval} starts per ${s.warmUp.intervalSeconds}s for ${ago(left)} more`)
  }
  out.push("")
  out.push(`Running (${s.running.length})`)
  if (!s.running.length) out.push("  none")
  for (const x of s.running) {
    const ran = Math.max(0, Math.round((now - Date.parse(x.startedAt)) / 1000))
    out.push(`  ${x.agentId}  ${x.priority}${x.class ? ` [${x.class}]` : ""}  ${where(x)}  for ${ago(ran)}`)
  }
  out.push("")
  out.push(`Waiting (${s.waiting.length})`)
  if (!s.waiting.length) out.push("  none")
  for (const w of s.waiting) {
    out.push(`  ${w.position}. ${w.agentId}  ${w.priority}${w.class ? ` [${w.class}]` : ""}  ${where(w)}  waiting ${ago(w.waitingSeconds)}`)
    if (w.blockedBy.length) out.push(`     held by: ${w.blockedBy.join("; ")}`)
  }
  out.push("")
  out.push(s.next ? `Next: ${s.next.agentId} (${s.next.priority}, ${where(s.next)})` : "Next: nothing waiting")
  return out.join("\n")
}
