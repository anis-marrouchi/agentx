// --- Plain-text view of the node report, for `agentx node` and agentx_node (#1531) ---
//
// Written for an agent to answer from as much as for a person to read:
// each section names when it was checked, so an answer can quote it.

import type { NodeReport } from "./index"

function ago(fromIso: string | null, now: number): string {
  if (!fromIso) return "never"
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`
  return `${Math.floor(s / 86_400)} d ago`
}

function at(isoTime: string | null, now: number): string {
  return isoTime ? `${isoTime} (${ago(isoTime, now)})` : "never"
}

function until(isoTime: string | null, now: number): string {
  if (!isoTime) return "no reset time reported"
  const mins = Math.round((Date.parse(isoTime) - now) / 60_000)
  if (mins <= 0) return `reset time ${isoTime} has passed`
  return mins < 120 ? `resets ${isoTime} (in ${mins} min)` : `resets ${isoTime} (in ${Math.round(mins / 60)} h)`
}

export function formatNode(r: NodeReport, now = Date.now()): string {
  const out: string[] = []
  out.push(`Node ${r.node.name} (${r.node.id}) — report checked ${r.checkedAt}`)
  out.push(`AgentX ${r.node.version ?? "unknown version"}${r.node.commit ? ` (${r.node.commit.slice(0, 8)})` : ""}, running since ${r.node.startedAt}`)
  out.push("Answer from this report and quote its check times; do not answer these facts from memory.")

  out.push("")
  out.push("Machine")
  if (!r.host) out.push("  not read yet")
  else {
    const h = r.host
    out.push(`  system   ${h.os.pretty} (${h.platform} ${h.arch}, kernel ${h.os.kernel})${h.os.build ? `, build ${h.os.build}` : ""}`)
    out.push(`  name     ${h.hostname}`)
    out.push(`  CPU      ${h.cpu.model}, ${h.cpu.count} cores`)
    out.push(`  memory   ${h.memTotalMB} MB`)
    out.push(`  checked  ${h.checkedAt} (at boot)`)
    const l = h.live
    if (l) {
      out.push(`  now      ${l.memAvailableMB} MB memory available, swap ${l.swapTotalMB > 0 ? `${l.swapUsedMB} of ${l.swapTotalMB} MB used` : "none"}, ` +
        `disk ${l.diskFreeMB === null ? "unknown" : `${l.diskFreeMB} MB free`}, load ${l.load1} on ${l.cpuCount} CPUs — checked ${at(l.checkedAt, now)}`)
    }
  }

  out.push("")
  out.push(`Programs — checked ${at(r.tools.checkedAt, now)}${r.tools.nextCheckAt ? `, next check ${r.tools.nextCheckAt}` : ""}`)
  if (!r.tools.items.length) out.push("  none listed (environment.tools)")
  for (const t of r.tools.items) {
    const v = !t.found ? "not installed" : t.version ?? (t.raw ? `"${t.raw}"` : t.error ? `error: ${t.error}` : "version unknown")
    out.push(`  ${t.name.padEnd(8)} ${v}`)
  }

  out.push("")
  const a = r.account
  out.push(`Claude account — last report from Claude Code ${at(a.checkedAt, now)}`)
  if (a.lastSession) {
    const s = a.lastSession
    out.push(`  account  ${s.credential ?? "unknown"}${s.cliVersion ? `, Claude Code ${s.cliVersion}` : ""}${s.agentId ? `, last session by ${s.agentId}` : ""} — ${at(s.checkedAt, now)}`)
  } else {
    out.push("  account  no Claude Code session since the node started")
  }
  const bill = [
    a.billing.subscription.length ? `subscription: ${a.billing.subscription.length} agent(s)` : "",
    a.billing.api.length ? `API key: ${a.billing.api.join(", ")}` : "",
  ].filter(Boolean)
  if (bill.length) out.push(`  billing  ${bill.join("; ")}`)
  if (a.holds.length) {
    for (const h of a.holds) out.push(`  LIMIT    ${h.window.replace(/_/g, " ")} window used up: new sessions are held, ${until(h.until, now)} — reported ${at(h.reportedAt, now)}`)
  } else {
    out.push(`  limits   no usage limit holds work right now (checked ${r.checkedAt})`)
  }
  for (const l of a.lifted) {
    out.push(`  lifted   ${l.window.replace(/_/g, " ")} hold (since ${l.heldSince}) lifted ${at(l.liftedAt, now)} — ${l.how === "served" ? "Claude served requests again" : l.how === "operator" ? "lifted by the operator" : "its reset time passed"}`)
  }
  for (const w of a.windows) {
    if (a.holds.some((h) => h.window === w.window)) continue
    const used = w.usedPercent === null ? "" : `, ${w.usedPercent}% used`
    const state = w.status === "allowed" ? "ok" : w.status === "allowed_warning" ? "nearing its limit" : w.usingOverage ? "used up, extra usage serving" : "used up"
    out.push(`  window   ${w.window.replace(/_/g, " ")}: ${state}${used}${w.resetsAt ? `, ${until(w.resetsAt, now)}` : ""} — reported ${at(w.reportedAt, now)}`)
  }
  const d = a.dispatches
  out.push(`  started  ${d.lastHour} new session(s) in the last hour, ${d.last5h} in 5 h${d.maxPerHour || d.maxPer5h ? ` (local caps ${d.maxPerHour ?? "-"}/h, ${d.maxPer5h ?? "-"}/5h)` : ""}`)

  out.push("")
  const w = r.work
  if (!w) out.push("Work — not available")
  else {
    out.push(`Work — checked ${at(w.checkedAt, now)}`)
    out.push(`  gate     ${!w.enabled ? "off" : w.gate.open ? "open" : `closed: ${w.gate.reasons.join("; ")}`}`)
    out.push(`  running  ${w.running.length}${w.caps.maxSessions ? ` of ${w.caps.maxSessions}` : ""}${w.running.length ? `: ${w.running.map((x) => `${x.agentId} (${x.channel})`).join(", ")}` : ""}`)
    out.push(`  waiting  ${w.waiting.length}${w.next ? `, next ${w.next.agentId} (${w.next.priority})` : ""}`)
  }
  return out.join("\n")
}
