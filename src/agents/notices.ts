import { randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"

/**
 * Notices: things an agent should know that do not need a run of their own.
 *
 * A watch script that tells the COO "the Mac has been on battery for 30
 * minutes" started a full COO run each time, and the COO answered "noted,
 * nothing to do". A message sent with `notice: true` to /send/agent is
 * kept instead, and goes at the head of the agent's next run that is not
 * a person's chat. If no such run comes within `maxHoldMs`, the notices
 * waiting for that agent go as one run of their own, so none is lost to
 * a quiet agent.
 *
 * With a file, the notices are written to it whenever they change (added
 * or taken, never on a timer) and read back at start, so a daemon restart
 * keeps the ones not yet delivered (#2121). The hold still counts from the
 * original send. Older than `maxAgeMs` at start, a notice is dropped: it
 * is for information and stale after a long outage. Delivery is at most
 * once: `take()` writes the file before the run starts, so a notice taken
 * by a run that then fails or is cut off by a crash is not sent again.
 */

export const NOTICE_HOLD_MS = 60 * 60_000
/** Notices older than this at start are dropped (#2121). */
export const NOTICE_MAX_AGE_MS = 24 * 60 * 60_000
/** Notices kept per agent; the oldest go first when it is full. */
export const MAX_NOTICES = 20
const NOTICE_CLIP = 1000
export const NOTICE_MARKER = "[agentx:notices"

export interface Notice { id: string; from: string; text: string; at: number }

export interface AgentNoticesOptions {
  now?: () => number
  maxHoldMs?: number
  maxAgeMs?: number
  /** Where notices are kept across a restart; none keeps them in memory only. */
  file?: string
  log?: (msg: string) => void
}

export class AgentNotices {
  private byAgent = new Map<string, Notice[]>()

  constructor(private readonly opts: AgentNoticesOptions = {}) {
    if (opts.file) this.load(opts.file)
  }

  private now(): number { return this.opts.now?.() ?? Date.now() }
  private log(msg: string): void { this.opts.log?.(msg) }

  add(agentId: string, from: string, text: string): number {
    const list = this.byAgent.get(agentId) ?? []
    const id = randomBytes(6).toString("hex")
    list.push({ id, from, text: text.length > NOTICE_CLIP ? text.slice(0, NOTICE_CLIP - 1) + "…" : text, at: this.now() })
    while (list.length > MAX_NOTICES) list.shift()
    this.byAgent.set(agentId, list)
    this.save()
    return list.length
  }

  count(agentId: string): number {
    return this.byAgent.get(agentId)?.length ?? 0
  }

  get size(): number {
    let n = 0
    for (const l of this.byAgent.values()) n += l.length
    return n
  }

  /** Remove and return the agent's notices, as the text to put before a
   *  run's message, or "" when there are none. Saved before it returns. */
  take(agentId: string): string {
    const list = this.byAgent.get(agentId)
    if (!list?.length) return ""
    this.byAgent.delete(agentId)
    this.save()
    return formatNotices(list, this.now())
  }

  /** Drop what waits for an agent no longer in the config; the count dropped. */
  drop(agentId: string): number {
    const n = this.count(agentId)
    if (!this.byAgent.delete(agentId)) return 0
    this.save()
    return n
  }

  /** Agents whose oldest notice has waited longer than maxHoldMs. */
  overdue(): string[] {
    const limit = this.opts.maxHoldMs ?? NOTICE_HOLD_MS
    const out: string[] = []
    for (const [agentId, list] of this.byAgent) if (list.length && this.now() - list[0].at >= limit) out.push(agentId)
    return out
  }

  private load(file: string): void {
    if (!existsSync(file)) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, "utf-8"))
    } catch (e: any) {
      this.log(`[notices] couldn't read notices from ${file} (${e?.message ?? e}); starting empty`)
      return
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.log(`[notices] ${file} is not a notices file; starting empty`)
      return
    }
    const maxAge = this.opts.maxAgeMs ?? NOTICE_MAX_AGE_MS
    const seen = new Set<string>()
    let kept = 0, stale = 0, bad = 0
    for (const [agentId, list] of Object.entries(raw as Record<string, unknown>)) {
      const ok: Notice[] = []
      for (const n of Array.isArray(list) ? list : []) {
        if (!n || typeof n.id !== "string" || typeof n.from !== "string" || typeof n.text !== "string" || typeof n.at !== "number") { bad++; continue }
        if (seen.has(n.id)) { bad++; continue }
        seen.add(n.id)
        if (this.now() - n.at > maxAge) { stale++; continue }
        ok.push({ id: n.id, from: n.from, text: n.text, at: n.at })
      }
      ok.sort((a, b) => a.at - b.at)
      while (ok.length > MAX_NOTICES) ok.shift()
      if (ok.length) this.byAgent.set(agentId, ok)
      kept += ok.length
    }
    if (kept) this.log(`[notices] ${kept} notice(s) kept from before the restart`)
    if (stale) this.log(`[notices] dropped ${stale} notice(s) older than ${Math.round(maxAge / 3_600_000)} h`)
    if (bad) this.log(`[notices] dropped ${bad} unreadable or repeated notice(s) from ${file}`)
    if (stale || bad) this.save()
  }

  /** Write the whole set: a temp file renamed over the old one. */
  private save(): void {
    const file = this.opts.file
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.byAgent)))
      renameSync(tmp, file)
    } catch (e: any) {
      this.log(`[notices] couldn't save notices to ${file} (${e?.message ?? e})`)
    }
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
