import { fitsPlatform, isUnknown, unknownSignal, type Signal, type SignalScope, type SignalSource } from "./types"

// --- The node's signal sources (#1892 phase 3, design 2.1, 2.3, 8) ---
//
// One registry per node. It loads the adapters that fit the platform and
// answers every read, in this order:
//
//   not loaded here            → unknown ("not loaded on this node")
//   switched off in settings   → unknown, the source is not read
//   limited to other agents    → unknown, the source is not read
//   needs consent, none given  → unknown ("no consent"), NOT READ (fail closed)
//   read throws                → unknown ("source down: …")   (fail open)
//   answer expired             → unknown ("expired")
//
// Consent: a `sensitive` source always needs the person's yes; settings
// cannot lower that. Any other source needs it when its settings say
// `consent: person`. The yes itself (with its expiry) is the `consent`
// callback's business: phase 7 stores it. With no callback, nothing has
// consent, so a sensitive source is never read.
//
// Per-request sources (phase 7: open apps, browser tabs, news) add two
// refusals before consent: off unless switched on (`enabled: true`), and
// read only for a named request. They are read only by
// `readForRequest`, which writes the read log row BEFORE the source is
// touched: a row that cannot be written means no read (fail closed).

export interface SourceSettings {
  enabled?: boolean
  agents?: string[]
  consent?: "none" | "person"
}

/** Has the person said yes for this source, for this scope, now? */
export type ConsentCheck = (sourceId: string, scope: SignalScope, now: number) => boolean | { why: string }

/** Where per-request reads are logged (read-log.ts). Only when, which
 *  source, which agent, which request: never what was read. */
export interface ReadLogSink {
  /** Called before the source is read. Returns the row id. */
  start(row: { at: number; source: string; agentId: string; requestId: string }): number
  /** Called after: how it went and how many answers came back. */
  finish(id: number, outcome: "read" | "down" | "empty", count: number): void
}

export interface SignalSourcesOptions {
  platform?: NodeJS.Platform
  settings?: () => Record<string, SourceSettings> | undefined
  consent?: ConsentCheck
  now?: () => number
  readLog?: ReadLogSink
}

/** A per-request read's answer cut to fit: values are text the agent
 *  reads, never a dump. */
const PER_REQUEST_VALUE_MAX = 6_000

export class SignalSources {
  private readonly sources = new Map<string, SignalSource>()
  private readonly notLoaded = new Map<string, string>()

  constructor(private readonly opts: SignalSourcesOptions = {}) {}

  private get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private settingsOf(id: string): SourceSettings {
    try { return this.opts.settings?.()?.[id] ?? {} } catch { return {} }
  }

  /** Load an adapter. False when it does not fit this node's platform. */
  register(src: SignalSource): boolean {
    if (!fitsPlatform(src, this.platform)) {
      this.notLoaded.set(src.id, `needs ${src.platforms.join(" or ")}, this node is ${this.platform}`)
      return false
    }
    this.sources.set(src.id, src)
    return true
  }

  /** Note a source that is not loaded here for another reason than the
   *  platform (phase 7: tabs without a separate reader). */
  skip(id: string, reason: string): void {
    if (!this.sources.has(id)) this.notLoaded.set(id, reason)
  }

  loaded(): SignalSource[] {
    return [...this.sources.values()]
  }

  skipped(): Array<{ id: string; reason: string }> {
    return [...this.notLoaded].map(([id, reason]) => ({ id, reason }))
  }

  /** Why this source may not be read for this scope, or null when it may. */
  private refusal(src: SignalSource, scope: SignalScope, opts: { skipConsent?: boolean } = {}): string | null {
    const s = this.settingsOf(src.id)
    if (s.enabled === false) return "switched off in situations.sources"
    if (src.perRequest && s.enabled !== true) return `off: a per-request source is read only when situations.sources.${src.id}.enabled is true`
    if (s.agents?.length && !(scope.agentId && s.agents.includes(scope.agentId))) return "off for this agent"
    if (src.perRequest && !scope.requestId) return "read only for a request"
    if (!opts.skipConsent && (src.sensitivity === "sensitive" || s.consent === "person")) {
      let answer: boolean | { why: string } | undefined
      try { answer = this.opts.consent?.(src.id, scope, this.now()) } catch { answer = false }
      if (answer !== true) {
        const why = answer && typeof answer === "object" && typeof answer.why === "string" ? answer.why.slice(0, 160) : ""
        return why ? `no consent (${why})` : "no consent"
      }
    }
    return null
  }

  read(id: string, scope: SignalScope): Signal[] {
    const now = this.now()
    const src = this.sources.get(id)
    if (!src) {
      const why = this.notLoaded.get(id)
      return [unknownSignal(id, "unknown", "", why ? `not loaded on this node (${why})` : "not loaded on this node", now, scope.key)]
    }
    if (src.perRequest) return [unknownSignal(id, src.kind, "", "a per-request source: read only for a request, with its own yes where it needs one", now, scope.key)]
    const no = this.refusal(src, scope)
    if (no) return [unknownSignal(id, src.kind, "", no, now, scope.key)]
    if (!src.read) return [unknownSignal(id, src.kind, "", "a push source: it answers only when something happens", now, scope.key)]
    let out: Signal[]
    try {
      out = src.read(scope)
    } catch (e: any) {
      return [unknownSignal(id, src.kind, "", `source down: ${String(e?.message ?? e).slice(0, 200)}`, now, scope.key)]
    }
    if (!Array.isArray(out) || out.length === 0) return [unknownSignal(id, src.kind, "", "the source gave no answer", now, scope.key)]
    return out.map((s) => (s.expiresAt !== null && s.expiresAt <= now && !isUnknown(s)
      ? { ...unknownSignal(id, s.kind, s.subject, `expired at ${new Date(s.expiresAt).toISOString()}`, now, s.scope) }
      : s))
  }

  /** A pushed signal is used only when its source is loaded here and may
   *  be read for its chat (switched on, consent where needed). `agentId`
   *  is the agent that owns the chat's talk: a source limited to some
   *  agents accepts a signal only for a talk one of them owns (#1945). */
  accepts(s: Signal, agentId?: string): boolean {
    const src = this.sources.get(s.source)
    if (!src || src.perRequest) return false
    return this.refusal(src, { key: s.scope, ...(agentId ? { agentId } : {}) }) === null
  }

  /** Is this a per-request source loaded here? */
  isPerRequest(id: string): boolean {
    return this.sources.get(id)?.perRequest === true
  }

  /** Why this per-request source may not be asked for by this agent,
   *  leaving the person's yes aside, or null when it may. Reads nothing,
   *  logs nothing. */
  askRefusal(id: string, agentId: string): string | null {
    const src = this.sources.get(id)
    if (!src) return this.notLoaded.has(id) ? `not loaded on this node (${this.notLoaded.get(id)})` : "not loaded on this node"
    if (!src.perRequest) return "not a per-request source"
    return this.refusal(src, { agentId, requestId: "ask" }, { skipConsent: true })
  }

  /** Does this source need the person's yes before a read? */
  needsConsent(id: string): boolean {
    const src = this.sources.get(id)
    if (!src) return true
    return src.sensitivity === "sensitive" || this.settingsOf(id).consent === "person"
  }

  /** Read a per-request source for one request (phase 7). In order:
   *  every refusal of `read` plus "off unless switched on" and "only for
   *  a request"; then one read log row; then the read. Nothing is read,
   *  and no row is written, when any check says no. */
  async readForRequest(id: string, scope: SignalScope): Promise<Signal[]> {
    const now = this.now()
    const src = this.sources.get(id)
    if (!src || !src.perRequest) {
      return [unknownSignal(id, src?.kind ?? "unknown", "", src ? "not a per-request source" : "not loaded on this node", now, scope.key)]
    }
    const no = this.refusal(src, scope)
    if (no) return [unknownSignal(id, src.kind, "", no, now, scope.key)]
    if (!this.opts.readLog) return [unknownSignal(id, src.kind, "", "no read log on this node: not read", now, scope.key)]
    let row: number
    try {
      row = this.opts.readLog.start({ at: now, source: id, agentId: scope.agentId ?? "", requestId: scope.requestId ?? "" })
    } catch (e: any) {
      return [unknownSignal(id, src.kind, "", `the read log could not be written, so nothing was read: ${String(e?.message ?? e).slice(0, 120)}`, now, scope.key)]
    }
    const finish = (outcome: "read" | "down" | "empty", count: number) => {
      try { this.opts.readLog?.finish(row, outcome, count) } catch { /* the row exists; its outcome is best effort */ }
    }
    let out: Signal[]
    try {
      out = src.readAsync ? await src.readAsync(scope) : (src.read?.(scope) ?? [])
    } catch (e: any) {
      finish("down", 0)
      return [unknownSignal(id, src.kind, "", `source down: ${String(e?.message ?? e).slice(0, 200)}`, now, scope.key)]
    }
    if (!Array.isArray(out) || out.length === 0) {
      finish("empty", 0)
      return [unknownSignal(id, src.kind, "", "the source gave no answer", now, scope.key)]
    }
    finish("read", out.filter((s) => !isUnknown(s)).length)
    return out.map((s) => typeof s.value === "string" && s.value.length > PER_REQUEST_VALUE_MAX
      ? { ...s, value: `${s.value.slice(0, PER_REQUEST_VALUE_MAX - 1)}…` }
      : s)
  }
}
