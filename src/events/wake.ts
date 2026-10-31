import type { EventEnvelope } from "./envelope"
import { formatEventLine, matchesFilters, matchesSubscription, subscriptionsFor, type SubscriptionInput } from "./subscriptions"
import type { WakeJournal } from "./wake-journal"

// --- Wake on event ---
//
// A `wake` subscription starts a turn for the subscribing agent when a
// matching event is published. It is opt-in and guarded three ways:
//   1. Loop guard: never on the agent's own events, and never on an event
//      whose rootId the agent has already worked under. A woken turn runs
//      under the event's root, so anything it causes shares that root and
//      cannot wake it again.
//   2. Dedup: one wake per rootId, however many matching events it has.
//   3. Rate limit: each wake subscription wakes the agent at most its
//      `maxPerHour` times in a sliding hour.
// Events that arrived from other machines through the mesh feed
// (peer-feed.ts) wake only a subscription whose `nodes` names that
// machine: a broad subscription must not turn every peer's activity into
// turns here. Pull and digest still see them.
// Every skipped wake is logged with its reason, and every wake (skipped,
// held, run, failed) is kept in the optional journal the Hub reads (#1648).
// A wake is a cold dispatch, so the dispatch cap can hold it (#1284). A
// held wake is not dropped: it is queued and retried with a growing delay
// until the window frees up, and each hold is logged with its reason.
// An agent whose slots all stay busy for the whole slot wait is held the
// same way (#1596), rather than the wake being lost after one try.

export type WakeOutcome =
  | { agentId: string; eventId: string; woke: true }
  | { agentId: string; eventId: string; woke: false; reason: "own-event" | "own-root" | "duplicate-root" | "rate-limit" }

export interface WakeDeps {
  /** Current agent definitions (read on every event, so reloads apply). */
  agents: () => Record<string, { subscriptions?: SubscriptionInput[] }>
  /** Start the turn. Called asynchronously, off the publish path. Resolve
   *  to `{ held: <reason> }` when the dispatch cap held it or the agent
   *  stayed busy for the whole slot wait: it is retried. */
  dispatch: (agentId: string, e: EventEnvelope, sub: SubscriptionInput) => Promise<WakeDispatch | unknown> | void
  log: (msg: string) => void
  /** True for events this node published itself (bus.isLocal). Without
   *  it every event counts as local. */
  isLocal?: (e: EventEnvelope) => boolean
  /** Records what each wake did, for the Hub's events feed (#1648). */
  journal?: WakeJournal
  now?: () => number
}

/** What dispatch resolves to when the wake was held, not run. */
export interface WakeDispatch { held: string }

const HOUR_MS = 60 * 60 * 1000
/** Held wakes: first retry after this, doubling up to RETRY_MAX_MS. */
export const RETRY_BASE_MS = 5 * 60 * 1000
export const RETRY_MAX_MS = 30 * 60 * 1000
/** Retries before a held wake is given up (about 7 hours). */
export const RETRY_ATTEMPTS = 16
/** Held wakes waiting at once, across agents; more are dropped and logged. */
export const RETRY_QUEUE_CAP = 100
/** How long a root stays remembered for dedup and the loop guard. */
const ROOT_TTL_MS = 24 * HOUR_MS
/** Roots remembered per agent, oldest dropped first. */
const ROOT_CAP = 2000

export class EventWaker {
  private wakes = new Map<string, number[]>()
  /** Per agent: rootId → last time seen. `own` holds roots the agent's own
   *  events carried; `woken` holds roots it was woken for. */
  private own = new Map<string, Map<string, number>>()
  private woken = new Map<string, Map<string, number>>()
  /** Held wakes waiting for their retry, by agent and event id. */
  private held = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number

  constructor(private deps: WakeDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Decide, and dispatch, the wakes one envelope causes. */
  handle(e: EventEnvelope): WakeOutcome[] {
    const out: WakeOutcome[] = []
    const agents = this.deps.agents()
    const t = this.now()
    const local = this.deps.isLocal ? this.deps.isLocal(e) : true
    for (const [agentId, def] of Object.entries(agents)) {
      const subs = subscriptionsFor(def.subscriptions, "wake")
      if (subs.length === 0) continue
      // An agent's own event never wakes it. Its root is remembered, so a
      // later event under the same root is recognised as its own doing.
      if (e.agentId === agentId) {
        remember(this.own, agentId, e.rootId, t)
        // Not logged: an agent's own steps would flood the log.
        if (subs.some((s) => matchesFilters({ ...s, agents: undefined }, e))) {
          out.push({ agentId, eventId: e.id, woke: false, reason: "own-event" })
        }
        continue
      }
      // Wake subscriptions that match, by their index in the agent's list:
      // each has its own rate bucket.
      const hits = (def.subscriptions ?? [])
        .map((s, index) => ({ s, index }))
        .filter(({ s }) => s.delivery === "wake" && matchesSubscription(s, e, agentId) &&
          (local || (s.nodes?.includes(e.node) ?? false)))
      if (hits.length === 0) continue
      const { outcome, sub } = this.decide(agentId, e, hits, t)
      out.push(outcome)
      this.deps.journal?.decided(agentId, e, outcome.woke ? undefined : outcome.reason)
      if (!outcome.woke) {
        this.deps.log(`[events] wake skipped for ${agentId}: ${outcome.reason} — ${formatEventLine(e)} root=${e.rootId.slice(0, 8)}`)
        continue
      }
      this.deps.log(`[events] waking ${agentId} — ${formatEventLine(e)} root=${e.rootId.slice(0, 8)}`)
      setImmediate(() => this.run(agentId, e, sub!, 0))
    }
    return out
  }

  /** Held wakes still waiting for a retry. */
  pendingRetries(): number {
    return this.held.size
  }

  /** Cancel every queued retry (daemon shutdown). */
  stop(): void {
    for (const timer of this.held.values()) clearTimeout(timer)
    this.held.clear()
  }

  private run(agentId: string, e: EventEnvelope, sub: SubscriptionInput, attempt: number): void {
    const journal = this.deps.journal
    const failed = (err: any) => {
      this.deps.log(`[events] wake of ${agentId} failed: ${err?.message ?? err}`)
      journal?.finished(agentId, e.id, String(err?.message ?? err) || "failed")
    }
    if (attempt > 0) journal?.retrying(agentId, e.id)
    try {
      Promise.resolve(this.deps.dispatch(agentId, e, sub)).then((result) => {
        const held = heldReason(result)
        if (held) this.retry(agentId, e, sub, attempt, held)
        else journal?.finished(agentId, e.id, errorOf(result))
      }, failed)
    } catch (err: any) {
      failed(err)
    }
  }

  private retry(agentId: string, e: EventEnvelope, sub: SubscriptionInput, attempt: number, reason: string): void {
    const key = `${agentId}#${e.id}`
    const line = `${formatEventLine(e)} root=${e.rootId.slice(0, 8)}`
    if (attempt >= RETRY_ATTEMPTS) {
      this.deps.log(`[events] wake of ${agentId} dropped after ${attempt} retries, still held: ${reason} — ${line}`)
      this.deps.journal?.held(agentId, e.id, `${reason} (gave up after ${attempt} retries)`, false)
      return
    }
    if (!this.held.has(key) && this.held.size >= RETRY_QUEUE_CAP) {
      this.deps.log(`[events] wake of ${agentId} dropped, ${RETRY_QUEUE_CAP} held wakes already queued: ${reason} — ${line}`)
      this.deps.journal?.held(agentId, e.id, `${reason} (retry queue full)`, false)
      return
    }
    this.deps.journal?.held(agentId, e.id, reason, true)
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
    this.deps.log(`[events] wake of ${agentId} held: ${reason} — retry ${attempt + 1}/${RETRY_ATTEMPTS} in ${Math.round(delay / 60_000)} min — ${line}`)
    const timer = setTimeout(() => {
      this.held.delete(key)
      this.run(agentId, e, sub, attempt + 1)
    }, delay)
    timer.unref?.()
    this.held.set(key, timer)
  }

  private decide(
    agentId: string, e: EventEnvelope, hits: Array<{ s: SubscriptionInput; index: number }>, t: number,
  ): { outcome: WakeOutcome; sub?: SubscriptionInput } {
    const base = { agentId, eventId: e.id }
    if (seen(this.own, agentId, e.rootId, t)) return { outcome: { ...base, woke: false, reason: "own-root" } }
    if (seen(this.woken, agentId, e.rootId, t)) return { outcome: { ...base, woke: false, reason: "duplicate-root" } }
    // The first matching subscription with room in its own hourly bucket
    // takes the wake; when every bucket is full the wake is skipped.
    for (const { s, index } of hits) {
      const key = `${agentId}#${index}`
      const recent = (this.wakes.get(key) ?? []).filter((w) => t - w < HOUR_MS)
      if (recent.length >= (s.maxPerHour ?? 4)) { this.wakes.set(key, recent); continue }
      recent.push(t)
      this.wakes.set(key, recent)
      remember(this.woken, agentId, e.rootId, t)
      return { outcome: { ...base, woke: true }, sub: s }
    }
    return { outcome: { ...base, woke: false, reason: "rate-limit" } }
  }

  /** Subscribe to a bus; returns the function that unsubscribes and
   *  cancels queued retries. */
  attach(bus: { subscribe(fn: (e: EventEnvelope) => void): () => void }): () => void {
    const off = bus.subscribe((e) => { this.handle(e) })
    return () => { off(); this.stop() }
  }
}

function remember(store: Map<string, Map<string, number>>, agentId: string, rootId: string, t: number): void {
  let roots = store.get(agentId)
  if (!roots) { roots = new Map(); store.set(agentId, roots) }
  roots.delete(rootId)
  roots.set(rootId, t)
  if (roots.size > ROOT_CAP) roots.delete(roots.keys().next().value as string)
}

function seen(store: Map<string, Map<string, number>>, agentId: string, rootId: string, t: number): boolean {
  const at = store.get(agentId)?.get(rootId)
  return at !== undefined && t - at < ROOT_TTL_MS
}

function heldReason(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined
  const held = (result as Partial<WakeDispatch>).held
  return typeof held === "string" && held ? held : undefined
}

/** The error a dispatch result carries, when it has one. */
function errorOf(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined
  const err = (result as { error?: unknown }).error
  return typeof err === "string" && err.trim() ? err : undefined
}

/** The message a woken turn receives: what happened, who emitted it, where
 *  to read more, and the subscription's own instruction when it has one. */
export function wakeMessage(e: EventEnvelope, prompt?: string): string {
  const lines = [
    "[Event] A subscription of yours matched:",
    formatEventLine(e),
    `Event: ${e.type} (kind ${e.kind}), emitted by ${e.agentId ? `${e.agentId} on ${e.node}` : e.node}${e.ref ? `, ref ${e.ref}` : ""}.`,
    `Event id ${e.id}, root ${e.rootId}. Call agentx_events for the surrounding events.`,
  ]
  if (prompt?.trim()) lines.push(`When this event arrives: ${prompt.trim()}`)
  else lines.push("Act on it if it needs you; otherwise reply briefly that no action is needed.")
  return lines.join("\n")
}
