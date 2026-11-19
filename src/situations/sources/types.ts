// --- Signal sources: one interface (#1892 phase 3, design 2.1) ---
//
// Every source answers the same shape, the Fact pattern: who said it,
// when it was checked, until when it holds. A source that cannot answer
// says `unknown` with a reason. Unknown is not "no": the core treats it
// as absent (fail open), the way the hold has always treated an
// unreadable Focus file (notify/focus.ts).
//
// The core imports no platform file. Each adapter names the platforms it
// fits; the registry does not load one that does not fit this node.

export type Sensitivity = "open" | "personal" | "sensitive"
export type SourcePlatform = "any" | NodeJS.Platform

/** The value a source gives when it cannot tell. */
export const UNKNOWN = "unknown" as const

export type SignalValue = boolean | number | string

/** What a read is about. Every field is optional: a source reads what it
 *  needs and answers unknown when the scope lacks it. */
export interface SignalScope {
  /** The chat's situation key (situations/key.ts). */
  key?: string
  /** The agent the turn is for: sources can be limited per agent. */
  agentId?: string
  /** The request the read is for (per-request sources, consent). */
  requestId?: string
  /** The running turn's chat ("channel:chatId") and task: a yes holds
   *  only for the turn or chat it was asked from (phase 7). */
  chat?: string
  taskId?: string
}

export interface Signal {
  /** The source id. */
  source: string
  /** "busy", "present", "left", ... */
  kind: string
  /** Who or what it is about ("owner", a participant id). Stays on this
   *  node: never put into a prompt line, a record's `why` or the bus. */
  subject: string
  /** `UNKNOWN` when the source could not tell. */
  value: SignalValue
  checkedAt: number
  /** Ms since the epoch; null: holds until replaced. */
  expiresAt: number | null
  /** Why the source answers this. Internal (logs, the CLI), never a prompt. */
  reason: string
  /** The situation key the signal is about, when it is about a chat. */
  scope?: string
  /** For `left`: how many other parties are still there after it, not
   *  counting our own accounts. null or absent: not known. */
  remaining?: number | null
}

export interface SignalSource {
  id: string
  kind: string
  sensitivity: Sensitivity
  platforms: SourcePlatform[]
  /** push: publishes on the node's signal hub when something happens.
   *  read: answers when a turn asks. No source runs its own poll loop. */
  mode: "push" | "read"
  /** Answer now. Never called for a sensitive source without consent,
   *  nor for one switched off. May throw: the registry turns that into
   *  unknown with the error as the reason. */
  read?(scope: SignalScope): Signal[]
  /** A per-request source (phase 7: open apps, browser tabs, news). Off
   *  unless its settings switch it on, read only for a named request
   *  (`SignalSources.readForRequest`), never by the sync `read` path and
   *  never by the sources view. Each read is logged before it runs. */
  perRequest?: true
  /** The per-request read, when it has to wait (a script, a fetch). */
  readAsync?(scope: SignalScope): Promise<Signal[]>
}

export function unknownSignal(source: string, kind: string, subject: string, reason: string, now = Date.now(), scope?: string): Signal {
  return { source, kind, subject, value: UNKNOWN, checkedAt: now, expiresAt: null, reason, ...(scope ? { scope } : {}) }
}

export function isUnknown(s: Pick<Signal, "value">): boolean {
  return s.value === UNKNOWN
}

/** Does the adapter fit this platform? */
export function fitsPlatform(src: Pick<SignalSource, "platforms">, platform: NodeJS.Platform): boolean {
  return src.platforms.includes("any") || src.platforms.includes(platform)
}
