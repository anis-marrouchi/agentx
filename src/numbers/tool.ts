import { resolveScheduleCaller } from "@/crons/schedule-tool"
import { callerHeaders } from "@/calls/service"
import { describePeriod, describeTarget, formatValue, STATUS_WORDS, type NumberStatus, type Reading } from "./model"
import { describeSource } from "./sources"
import type { NumberAlert, NumberRecord } from "./store"

// --- Agent-facing `agentx_numbers` tool (#1826) ---
//
//   list     tracked numbers with status and newest reading (tags narrows)
//   review   the numbers that are missed, missed twice or have no reading,
//            worst first, with their missed-twice card
//   show     one number and its readings
//   create   make or change a number the agent owns
//   record   a reading for a window (from, to), default the last whole
//            period of its rhythm
//   archive  stop tracking a number (its readings stay)
// It talks to the daemon's /numbers endpoints.

export interface NumbersToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

type View = NumberRecord & { status: NumberStatus; latest: Reading | null; readings?: Reading[] }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** One line per number. */
export function describeNumber(n: View): string {
  const latest = n.latest
    ? `${formatValue(n.latest.value, n.unit)} for ${describePeriod({ start: n.latest.periodStart, end: n.latest.periodEnd })}${n.latest.value === null && n.latest.error ? ` (${n.latest.error})` : ""}`
    : "no reading yet"
  const parts = [
    n.ownerAgent ? `owner ${n.ownerAgent}` : null,
    n.rhythm,
    n.target ? `target ${describeTarget(n.target, n.unit)}` : null,
    n.tags.length ? `tags ${n.tags.join(", ")}` : null,
    describeSource(n.source),
  ].filter(Boolean)
  return `- ${n.id} "${n.name}" [${STATUS_WORDS[n.status]}]: ${latest}. ${parts.join("; ")}.${n.archivedAt ? " Archived." : ""}`
}

/** The missed-twice card of a number, in one line. */
export function describeCard(a: NumberAlert): string {
  const when = new Date(a.raisedAt).toISOString().slice(0, 10)
  return a.cardId
    ? `Missed-twice card ${a.cardId}, raised ${when} for ${a.raisedFor}${a.reviewer ? `, reviewer ${a.reviewer}` : ""}.`
    : `Missed-twice card not raised (${when}): ${a.error ?? "unknown reason"}.`
}

export function describeReadings(n: View): string[] {
  return (n.readings ?? []).map((r) =>
    `  ${describePeriod({ start: r.periodStart, end: r.periodEnd })}: ${formatValue(r.value, n.unit)}${r.value === null && r.error ? ` (${r.error})` : ""}, by ${r.by}${r.note ? ` (${r.note})` : ""}`)
}

/** Returns the text the agent sees. Every refusal is text, never a throw. */
export async function runNumbersTool(args: Record<string, unknown>, deps: NumbersToolDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.daemonUrl.replace(/\/$/, "")
  const action = (str(args.action) || "list").toLowerCase()
  try {
    if (action === "list") {
      const tags = Array.isArray(args.tags) ? args.tags.join(",") : str(args.tags)
      const q = new URLSearchParams({ ...(tags ? { tags } : {}), ...(args.archived ? { archived: "1" } : {}) })
      const res = await doFetch(`${base}/numbers${q.size ? `?${q}` : ""}`, { signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      const list: View[] = data.numbers ?? []
      return list.length ? `${list.length} number${list.length === 1 ? "" : "s"}:\n${list.map(describeNumber).join("\n")}` : "No numbers are tracked on this node."
    }
    if (action === "review") {
      const tags = Array.isArray(args.tags) ? args.tags.join(",") : str(args.tags)
      const q = new URLSearchParams({ review: "1", ...(tags ? { tags } : {}) })
      const res = await doFetch(`${base}/numbers?${q}`, { signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      const list: (View & { card?: NumberAlert | null })[] = data.numbers ?? []
      if (!list.length) return "Nothing to review: every tracked number is on target, or has no target."
      return `${list.length} number${list.length === 1 ? "" : "s"} to review, worst first:\n${list.map((n) => [describeNumber(n), ...(n.card ? [`  ${describeCard(n.card)}`] : [])].join("\n")).join("\n")}`
    }
    if (action === "show") {
      const id = str(args.id)
      if (!id) return "Error: show needs id: the number's id (list shows them)."
      const res = await doFetch(`${base}/numbers/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      const n = data.number as View
      return [describeNumber(n), ...(n.readings?.length ? ["Readings, newest first:", ...describeReadings(n)] : [])].join("\n")
    }
    if (!["create", "record", "archive"].includes(action)) return `Error: unknown action "${action}": use list, review, show, create, record or archive.`
    const env = deps.env ?? process.env
    const caller = resolveScheduleCaller(args, env)
    if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."
    const { callerAgentId: _c, ...rest } = args
    const res = await doFetch(`${base}/numbers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...callerHeaders(env) },
      body: JSON.stringify({ ...rest, action, agentId: caller.agentId }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
    const n = data.number as View
    if (action === "create") {
      const reads = n.source.kind === "manual" ? ` Record each reading with {action:"record", id:"${n.id}", value:<n>, from:"YYYY-MM-DD", to:"YYYY-MM-DD"}.` : " The daemon reads it once per period."
      return `Number ${res.status === 201 ? "made" : "updated"}:\n${describeNumber(n)}${reads}`
    }
    if (action === "archive") return `Number ${n.id} is no longer tracked. Its readings stay.`
    return `Reading kept:\n${describeNumber(n)}`
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
