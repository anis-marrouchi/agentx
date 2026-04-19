import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs"
import { resolve, dirname } from "path"

// --- Runtime routing overrides (per-chat handovers) ------------------------
//
// A "handover" is an operator-initiated override: "from now on, route
// messages from <channel, chatId[, accountId]> to <toAgent>, regardless of
// the config's static routes." Lightweight — persisted as plain JSON, read
// at the top of the router's resolveAgent, consulted before config routes.
//
// Survival: on daemon restart, overrides stay in effect. The file IS the
// source of truth.
//
// Context carryover: each override may carry a one-shot `summary` string.
// The registry reads + clears it the first time it injects it into the
// target agent's context, so the new agent sees "[Handover note: …]" once,
// then subsequent messages just flow to the new agent without repetition.

export interface HandoverOverride {
  channel: string                 // "telegram" | "whatsapp" | ...
  chatId: string                  // DM: sender.id; group: group.id
  accountId?: string              // telegram multi-account discriminator
  fromAgent: string
  toAgent: string
  summary?: string                // one-shot note injected into target context
  createdAt: string               // ISO
  createdBy?: string              // operator that made the call
  /** When set, overrides past this time are treated as expired (ignored on
   *  read, optionally pruned on access). null = indefinite. */
  expiresAt?: string | null
  /** Set after the summary has been injected once. Route stays active. */
  summaryConsumedAt?: string
}

interface HandoverFile {
  version: number
  overrides: Record<string, HandoverOverride>
}

export class HandoverStore {
  readonly filePath: string
  private log: (...args: unknown[]) => void

  constructor(opts: { baseDir?: string; log?: (...args: unknown[]) => void } = {}) {
    const base = opts.baseDir ?? resolve(process.cwd(), ".agentx")
    this.filePath = resolve(base, "handover.json")
    this.log = opts.log ?? console.error.bind(console, "[handover]")
    mkdirSync(base, { recursive: true })
  }

  /** Canonical key for an override. Using "-" for missing accountId keeps
   *  the key shape uniform across channels. */
  key(channel: string, chatId: string, accountId?: string): string {
    return `${channel}::${chatId}::${accountId || "-"}`
  }

  load(): HandoverFile {
    if (!existsSync(this.filePath)) return { version: 1, overrides: {} }
    try {
      const raw = readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw) as HandoverFile
      if (!parsed || typeof parsed !== "object") return { version: 1, overrides: {} }
      if (!parsed.overrides) parsed.overrides = {}
      return parsed
    } catch (e: any) {
      this.log(`load failed, starting empty: ${e?.message || e}`)
      return { version: 1, overrides: {} }
    }
  }

  private save(file: HandoverFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(file, null, 2))
    renameSync(tmp, this.filePath)
  }

  /** Return the active override for a chat, or undefined. Skips expired. */
  get(channel: string, chatId: string, accountId?: string): HandoverOverride | undefined {
    const file = this.load()
    const o = file.overrides[this.key(channel, chatId, accountId)]
    if (!o) return undefined
    if (o.expiresAt && Date.parse(o.expiresAt) < Date.now()) return undefined
    return o
  }

  /** Create or replace an override. If `fromAgent` isn't supplied the caller
   *  can pass "" and the router will fill it in from current routing. */
  set(o: Omit<HandoverOverride, "createdAt"> & { createdAt?: string }): HandoverOverride {
    if (!o.channel || !o.chatId || !o.toAgent) {
      throw new Error("channel, chatId and toAgent are required")
    }
    const file = this.load()
    const rec: HandoverOverride = {
      ...o,
      createdAt: o.createdAt ?? new Date().toISOString(),
    }
    file.overrides[this.key(rec.channel, rec.chatId, rec.accountId)] = rec
    this.save(file)
    return rec
  }

  /** Remove an override (release the handover). Idempotent. */
  remove(channel: string, chatId: string, accountId?: string): boolean {
    const file = this.load()
    const k = this.key(channel, chatId, accountId)
    if (!(k in file.overrides)) return false
    delete file.overrides[k]
    this.save(file)
    return true
  }

  /** Mark the summary as consumed (after it's been injected once). Route
   *  stays active; subsequent messages just skip the note. */
  consumeSummary(channel: string, chatId: string, accountId?: string): string | undefined {
    const file = this.load()
    const o = file.overrides[this.key(channel, chatId, accountId)]
    if (!o || !o.summary || o.summaryConsumedAt) return undefined
    const summary = o.summary
    o.summaryConsumedAt = new Date().toISOString()
    this.save(file)
    return summary
  }

  /** List all non-expired overrides. Used by the admin UI. */
  listActive(): HandoverOverride[] {
    const file = this.load()
    const now = Date.now()
    return Object.values(file.overrides).filter(
      (o) => !o.expiresAt || Date.parse(o.expiresAt) >= now,
    )
  }

  /** Overrides pointing at this agent (incoming) or away from it (outgoing). */
  listByAgent(agentId: string): { incoming: HandoverOverride[]; outgoing: HandoverOverride[] } {
    const all = this.listActive()
    return {
      incoming: all.filter((o) => o.toAgent === agentId),
      outgoing: all.filter((o) => o.fromAgent === agentId),
    }
  }
}
