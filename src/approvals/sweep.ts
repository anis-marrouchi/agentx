import { cardsAwaitingAgentNotice, expireCards, markAgentNotified, verdictMessage, type DecisionCard } from "./cards"
import { listInbox, type InboxContext, type InboxItem } from "./inbox"
import { readInboxState, recordDigest } from "./state"

// --- The daemon's approvals sweep ---
//
// Runs every minute inside the daemon:
//   1. Expiry: a pending card past `expires` gets its `if_silent` applied.
//   2. Tell the agent: every decided or expired card is sent to the agent
//      that raised it, once. Decisions made in the CLI or the dashboard
//      (other processes) reach the agent through here too.
//   3. Digest: at most one message a day to the operator, with the count
//      and the most urgent item. Never one message per card.
//
// Every step is isolated: a failure is logged and the next step runs.

export interface ApprovalSettings {
  defaultExpiryDays: number
  maxExpiryDays: number
  laterHours: number
  notifyAgent: boolean
  digest: {
    enabled: boolean
    /** Local time, HH:MM. */
    time: string
    timezone?: string
    destination?: { channel: string; chatId: string; accountId?: string }
  }
}

export interface SweepDeps {
  ctx: InboxContext
  settings: ApprovalSettings
  /** Operator notification target when digest.destination is unset. */
  fallbackDestination?: { channel: string; chatId: string; accountId?: string }
  /** Run a short turn on the agent with the result. */
  tellAgent?: (agentId: string, text: string, card: DecisionCard) => Promise<void>
  /** True when the agent exists on this node. */
  hasAgent?: (agentId: string) => boolean
  sendDigest?: (dest: { channel: string; chatId: string; accountId?: string }, text: string) => Promise<void>
  /** Where the operator opens the inbox, for the digest. */
  dashboardUrl?: string
  log: (msg: string) => void
}

export interface SweepResult {
  expired: number
  notified: number
  digest: "sent" | "not-due" | "empty" | "no-destination" | "disabled" | "failed"
}

/** "YYYY-MM-DD" and minutes since midnight, in `timezone` (default: this machine's). */
export function localClock(now: number, timezone?: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(now))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
  const hour = Number(get("hour")) % 24
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: hour * 60 + Number(get("minute")) }
}

export function digestDue(settings: ApprovalSettings["digest"], lastDigest: string | undefined, now: number): { due: boolean; date: string } {
  const { date, minutes } = localClock(now, settings.timezone)
  const [h, m] = settings.time.split(":").map(Number)
  return { due: lastDigest !== date && minutes >= h * 60 + m, date }
}

export function digestText(items: InboxItem[], dashboardUrl?: string): string {
  const top = items[0]
  const lines = [`${items.length} decision${items.length === 1 ? "" : "s"} waiting for you.`]
  if (top) {
    const expires = top.expires ? ` Expires ${top.expires.slice(0, 16).replace("T", " ")} UTC${top.if_silent ? `, then: ${top.if_silent}` : ""}.` : ""
    lines.push(`Most urgent: ${top.title}: ${top.ask}${expires}`)
  }
  lines.push(dashboardUrl ? `Open ${dashboardUrl.replace(/\/$/, "")}/approvals, or run: agentx approvals list` : "Open Approvals in the dashboard, or run: agentx approvals list")
  return lines.join("\n")
}

export async function runApprovalsSweep(deps: SweepDeps): Promise<SweepResult> {
  const { ctx, settings, log } = deps
  const now = ctx.now ?? Date.now()
  const result: SweepResult = { expired: 0, notified: 0, digest: "not-due" }

  try {
    for (const card of expireCards(ctx.root, now)) {
      result.expired++
      log(`[approvals] ${card.id} from ${card.raised_by} expired; default applied: ${card.if_silent}`)
    }
  } catch (e: any) {
    log(`[approvals] expiry failed: ${e?.message ?? e}`)
  }

  try {
    for (const card of cardsAwaitingAgentNotice(ctx.root)) {
      // Marked first: a turn that hangs or crashes must not tell it twice.
      markAgentNotified(ctx.root, card.id, now)
      if (!settings.notifyAgent || !deps.tellAgent) continue
      if (deps.hasAgent && !deps.hasAgent(card.raised_by)) {
        log(`[approvals] ${card.id}: agent "${card.raised_by}" isn't on this node; result not delivered`)
        continue
      }
      try {
        await deps.tellAgent(card.raised_by, verdictMessage(card), card)
        result.notified++
      } catch (e: any) {
        log(`[approvals] couldn't tell ${card.raised_by} about ${card.id}: ${e?.message ?? e}`)
      }
    }
  } catch (e: any) {
    log(`[approvals] agent notices failed: ${e?.message ?? e}`)
  }

  try {
    if (!settings.digest.enabled) { result.digest = "disabled"; return result }
    const { due, date } = digestDue(settings.digest, readInboxState(ctx.root).lastDigest, now)
    if (!due) return result
    const dest = settings.digest.destination ?? deps.fallbackDestination
    if (!dest || !deps.sendDigest) { result.digest = "no-destination"; return result }
    // Snoozed items count: "later" hides them from the list, not from the day's total.
    const { items } = listInbox(ctx, { includeSnoozed: true })
    if (items.length === 0) { result.digest = "empty"; return result }
    recordDigest(ctx.root, date)
    try {
      await deps.sendDigest(dest, digestText(items, deps.dashboardUrl))
      result.digest = "sent"
      log(`[approvals] digest sent: ${items.length} waiting`)
    } catch (e: any) {
      result.digest = "failed"
      log(`[approvals] digest failed: ${e?.message ?? e}`)
    }
  } catch (e: any) {
    result.digest = "failed"
    log(`[approvals] digest failed: ${e?.message ?? e}`)
  }
  return result
}
