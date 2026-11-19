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

export interface SourceSettings {
  enabled?: boolean
  agents?: string[]
  consent?: "none" | "person"
}

/** Has the person said yes for this source, for this scope, now? */
export type ConsentCheck = (sourceId: string, scope: SignalScope, now: number) => boolean

export interface SignalSourcesOptions {
  platform?: NodeJS.Platform
  settings?: () => Record<string, SourceSettings> | undefined
  consent?: ConsentCheck
  now?: () => number
}

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

  loaded(): SignalSource[] {
    return [...this.sources.values()]
  }

  skipped(): Array<{ id: string; reason: string }> {
    return [...this.notLoaded].map(([id, reason]) => ({ id, reason }))
  }

  /** Why this source may not be read for this scope, or null when it may. */
  private refusal(src: SignalSource, scope: SignalScope): string | null {
    const s = this.settingsOf(src.id)
    if (s.enabled === false) return "switched off in situations.sources"
    if (s.agents?.length && !(scope.agentId && s.agents.includes(scope.agentId))) return "off for this agent"
    if (src.sensitivity === "sensitive" || s.consent === "person") {
      let yes = false
      try { yes = this.opts.consent?.(src.id, scope, this.now()) === true } catch { yes = false }
      if (!yes) return "no consent"
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
    if (!src) return false
    return this.refusal(src, { key: s.scope, ...(agentId ? { agentId } : {}) }) === null
  }
}
