import type { RequestRecord } from "./store"

// --- "What did I ask today, and where did it land" (#394, 1c C) ---
//
// One row per request made since 00:00 Tunis: time, first words, state,
// owner, and where it landed. A request with nowhere it landed goes red, at
// the top. No model: the Secretary reads it out, the Desk shows it.

export const TODAY_ZONE = "Africa/Tunis"

export interface Landed { kind: string; ref: string }

export interface TodayRow {
  id: string
  /** HH:MM, Tunis time. */
  time: string
  words: string
  state: string
  owner: string
  landed: Landed[]
  noHome: boolean
}

/** Epoch ms of the last 00:00 in `zone` at or before `now`. */
export function startOfDay(now: number, zone = TODAY_ZONE): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  )
  const elapsed = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + (now % 1000)
  return now - elapsed
}

const clock = (ms: number, zone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour12: false, hour: "2-digit", minute: "2-digit" }).format(new Date(ms))

/** The first `n` words of a request, on one line. */
export function firstWords(text: string, n = 10): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ")
  return words.slice(0, n).join(" ") + (words.length > n ? " …" : "")
}

/** Link kinds that say where the work lives: a home (#394), or an
 *  approval card put to the owner. Runs, delegations and workflows do not. */
const LANDING_LINKS = new Set(["issue", "idea", "approval", "erp", "card"])

export function todayRows(
  items: Array<RequestRecord & { links?: Array<{ kind: string; ref: string }> }>,
  opts: { hasPlan?: (id: string) => boolean; zone?: string } = {},
): TodayRow[] {
  const rows = items.map((r): TodayRow => {
    const landed: Landed[] = []
    const add = (kind: string, ref: string) => { if (!landed.some((l) => l.kind === kind && l.ref === ref)) landed.push({ kind, ref }) }
    for (const l of r.links ?? []) if (LANDING_LINKS.has(l.kind)) add(l.kind, l.ref)
    if (r.home) add(r.home.kind, r.home.link)
    if (opts.hasPlan?.(r.id)) add("plan", r.id)
    if (r.evidence) add("evidence", r.evidence)
    return {
      id: r.id, time: clock(r.createdAt, opts.zone ?? TODAY_ZONE), words: firstWords(r.text), state: r.state, owner: r.agentId,
      // Declined or dropped: closed on purpose, nothing was to land.
      landed, noHome: landed.length === 0 && r.state !== "declined" && r.state !== "dropped",
    }
  })
  // Red first; each group in the order asked.
  return [...rows.filter((r) => r.noHome), ...rows.filter((r) => !r.noHome)]
}
