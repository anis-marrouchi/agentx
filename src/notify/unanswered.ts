import { localClock } from "@/approvals/sweep"
import type { OwnerList } from "@/desk/owner-list"
import type { ToldLedger, ToldRow } from "./told"

// --- The number (#1936, owner mediator phase 0) ---
//
// Items sent to the owner per day that he did not see or answer within
// 24 hours, counted per item, on this node and its mesh peers. Only
// measured: nothing here changes a send.
//
//   item      one item key (told.ts tellKey). Rows of the same key within
//             24 h of its first row are one item: an escalation, the
//             same notice on two channels. A record-only row is its own
//             item. Replies to him (`reply`) are left out: he asked.
//   landed    seen or answered within 24 h of the item's first row.
//   waiting   younger than 24 h and not seen yet: not counted against
//             him until its 24 h are over.
//   day       the day of the item's first row, in the digest's time zone.
//
// Two guards are printed beside it, so it cannot be won by hiding items:
//   deskOver24h      Desk items waiting more than 24 h (desk/owner-list.ts)
//   batchedOver24h   batched items older than 24 h not yet sent in a
//                    batch: 0 until batching exists (phase 2).

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WENT_OUT = new Set(["sent", "held", "recorded"])

export interface NumberDay {
  day: string
  items: number
  landed: number
  notLanded: number
  waiting: number
}

export interface NumberGuards {
  deskOver24h: number
  batchedOver24h: number
}

export type NodeNumber =
  | { node: string; reachable: true; days: NumberDay[]; guards: NumberGuards }
  | { node: string; reachable: false; error: string }

type Row = Pick<ToldRow, "at" | "key" | "outcome" | "reply" | "seenAt" | "answeredAt">

/** The number per day over `rows` (any order). Days with no item are
 *  left out; oldest day first. */
export function unansweredDays(rows: Row[], opts: { now: number; timezone?: string }): NumberDay[] {
  const items: Array<{ first: number; landedAt: number }> = []
  const open = new Map<string, { first: number; landedAt: number }>()
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    if (!WENT_OUT.has(r.outcome) || r.reply) continue
    const mark = Math.min(r.seenAt ?? Infinity, r.answeredAt ?? Infinity)
    const item = open.get(r.key)
    if (item && r.at < item.first + DAY) {
      item.landedAt = Math.min(item.landedAt, mark)
      continue
    }
    const next = { first: r.at, landedAt: mark }
    open.set(r.key, next)
    items.push(next)
  }
  const days = new Map<string, NumberDay>()
  for (const it of items) {
    const day = localClock(it.first, opts.timezone).date
    const d = days.get(day) ?? { day, items: 0, landed: 0, notLanded: 0, waiting: 0 }
    d.items++
    if (it.landedAt <= it.first + DAY) d.landed++
    else if (opts.now < it.first + DAY) d.waiting++
    else d.notLanded++
    days.set(day, d)
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** Desk items asked more than 24 h ago. An item without an ask time is not guessed. */
export function deskOver24h(list: Pick<OwnerList, "items">, now: number): number {
  return list.items.filter((c) => {
    const at = c.askedAt ? Date.parse(c.askedAt) : NaN
    return Number.isFinite(at) && at <= now - DAY
  }).length
}

/** This node's number for the last `days` days, with both guards. */
export function localNumber(ledger: ToldLedger, opts: {
  node: string; days: number; now: number; timezone?: string; desk: Pick<OwnerList, "items">
}): NodeNumber {
  return {
    node: opts.node,
    reachable: true,
    days: unansweredDays(ledger.wentOut(opts.now - opts.days * DAY), opts),
    guards: { deskOver24h: deskOver24h(opts.desk, opts.now), batchedOver24h: 0 },
  }
}

export interface PeerRef {
  peer: string
  peerUrl: string
  healthy: boolean
}

/** Each mesh peer's own number (GET /owner/told/number, with this node's
 *  mesh token). A peer down at the last mesh check, or one that does not
 *  answer with a number, is unreachable: never read as 0. */
export async function peerNumbers(peers: PeerRef[], opts: {
  days: number
  headers: (peer: string) => Record<string, string>
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<NodeNumber[]> {
  const get = opts.fetch ?? fetch
  return Promise.all(peers.map(async (p): Promise<NodeNumber> => {
    if (!p.healthy) return { node: p.peer, reachable: false, error: "down at the last mesh check" }
    try {
      const res = await get(`${p.peerUrl.replace(/\/+$/, "")}/owner/told/number?days=${opts.days}`, {
        headers: opts.headers(p.peer), signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      })
      if (!res.ok) return { node: p.peer, reachable: false, error: `answered ${res.status}` }
      const body = await res.json().catch(() => null) as { reachable?: unknown; days?: unknown; guards?: NumberGuards } | null
      if (!body || body.reachable !== true || !Array.isArray(body.days) || !body.guards) {
        return { node: p.peer, reachable: false, error: "answered without a number (an older version)" }
      }
      return { node: p.peer, reachable: true, days: body.days as NumberDay[], guards: body.guards }
    } catch (e: any) {
      return { node: p.peer, reachable: false, error: `did not answer (${String(e?.message ?? e).slice(0, 120)})` }
    }
  }))
}

/** One line for `day`, every node, both guards: the morning digest's line
 *  and the head of `agentx notify --told`. */
export function numberLine(nodes: NodeNumber[], day: string): string {
  let items = 0, notLanded = 0, waiting = 0, desk = 0, batched = 0
  const parts: string[] = []
  for (const n of nodes) {
    if (!n.reachable) { parts.push(`${n.node} unreachable`); continue }
    const d = n.days.find((x) => x.day === day) ?? { items: 0, notLanded: 0, waiting: 0 }
    items += d.items; notLanded += d.notLanded; waiting += d.waiting
    desk += n.guards.deskOver24h; batched += n.guards.batchedOver24h
    parts.push(`${n.node} ${d.notLanded} of ${d.items}`)
  }
  const still = waiting ? `, ${waiting} still within 24 h` : ""
  return `Not seen or answered within 24 h on ${day}: ${notLanded} of ${items} items${still} (${parts.join(", ")}). `
    + `Desk items waiting over 24 h: ${desk}. Batched over 24 h, not sent: ${batched}.`
}

/** `agentx notify --told`'s lines for GET /owner/told's `number`: the
 *  digest's line, then each node per day with its guards. */
export function numberReport(number: { line?: string; nodes?: NodeNumber[] } | undefined): string[] {
  if (!number?.nodes?.length) return []
  const out = [`  ${number.line ?? ""}`]
  for (const n of number.nodes) {
    if (!n.reachable) { out.push(`  ${n.node}: unreachable (${n.error})`); continue }
    out.push(`  ${n.node}: Desk items waiting over 24 h: ${n.guards.deskOver24h}; batched over 24 h, not sent: ${n.guards.batchedOver24h}`)
    if (!n.days.length) out.push("     nothing sent in these days")
    for (const d of n.days) {
      out.push(`     ${d.day}  ${d.notLanded} of ${d.items} not seen or answered within 24 h${d.waiting ? ` (${d.waiting} still within 24 h)` : ""}`)
    }
  }
  return out
}

/** The day before `now`, in `timezone`: the last day the morning digest reports. */
export function yesterday(now: number, timezone?: string): string {
  return localClock(now - DAY, timezone).date
}
