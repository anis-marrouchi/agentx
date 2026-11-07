/**
 * Notices: things an agent should know that do not need a run of their own.
 *
 * A watch script that tells the COO "the Mac has been on battery for 30
 * minutes" started a full COO run each time, and the COO answered "noted,
 * nothing to do". A message sent with `notice: true` to /send/agent is
 * kept instead, and goes at the head of the agent's next run that is not
 * a person's chat. If no such run comes within `maxHoldMs`, the notices
 * waiting for that agent go as one run of their own, so none is lost to
 * a quiet agent. Kept in memory: a daemon restart drops notices not yet
 * delivered (they are for information; anything urgent is sent as a plain
 * message).
 */

export const NOTICE_HOLD_MS = 60 * 60_000
/** Notices kept per agent; the oldest go first when it is full. */
export const MAX_NOTICES = 20
const NOTICE_CLIP = 1000
export const NOTICE_MARKER = "[agentx:notices"

export interface Notice { from: string; text: string; at: number }

export class AgentNotices {
  private byAgent = new Map<string, Notice[]>()

  constructor(private readonly opts: { now?: () => number; maxHoldMs?: number } = {}) {}

  private now(): number { return this.opts.now?.() ?? Date.now() }

  add(agentId: string, from: string, text: string): number {
    const list = this.byAgent.get(agentId) ?? []
    list.push({ from, text: text.length > NOTICE_CLIP ? text.slice(0, NOTICE_CLIP - 1) + "…" : text, at: this.now() })
    while (list.length > MAX_NOTICES) list.shift()
    this.byAgent.set(agentId, list)
    return list.length
  }

  count(agentId: string): number {
    return this.byAgent.get(agentId)?.length ?? 0
  }

  /** Remove and return the agent's notices, as the text to put before a
   *  run's message, or "" when there are none. */
  take(agentId: string): string {
    const list = this.byAgent.get(agentId)
    if (!list?.length) return ""
    this.byAgent.delete(agentId)
    return formatNotices(list, this.now())
  }

  /** Agents whose oldest notice has waited longer than maxHoldMs. */
  overdue(): string[] {
    const limit = this.opts.maxHoldMs ?? NOTICE_HOLD_MS
    const out: string[] = []
    for (const [agentId, list] of this.byAgent) if (list.length && this.now() - list[0].at >= limit) out.push(agentId)
    return out
  }
}

export function formatNotices(list: Notice[], now: number): string {
  const lines = list.map((n) => {
    const mins = Math.max(0, Math.round((now - n.at) / 60_000))
    return `- ${mins === 0 ? "just now" : `${mins} min ago`}, from ${n.from}: ${n.text.replace(/\s*\n\s*/g, " ")}`
  })
  return [
    `${NOTICE_MARKER} count=${list.length}]`,
    "For your information; these did not need a run of their own. Act on one only if it changes your work.",
    ...lines,
    "",
    "",
  ].join("\n")
}
