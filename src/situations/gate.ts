import type { IncomingMessage } from "@/channels/types"
import { FireWindow } from "@/workflows/loop-guard"
import { classifyCourtesy, type CourtesyClass } from "./courtesy"
import { DEFAULT_SITUATIONS_CONFIG, type SituationsConfig } from "./config"
import { SITUATION_CHANNELS, situationKey } from "./key"
import type { EndReason, Phase, SituationRow, SituationStore } from "./store"

// --- The courtesy-close gate (#1892, phase 1) ---
//
// The router asks `decide(msg)` after its dedup check and BEFORE the
// pre:channel-message hook, so a dropped "thank you, goodbye" never
// reaches a workflow, a run or an agent. `decide` is pure: it reads the
// chat's record and the dispatcher's claim rule and returns an answer.
// The router then calls `commit` (phase writes, the backstop count) and,
// on a drop, `logDrop`.
//
// Answers:
//   pass          let it through
//   pass-claimed  the gate would drop it, but a run already takes it
//                 (a person.wait, a checkpoint, a running or forwarded
//                 channel run): the run wins
//   drop          drop it (active mode only; shadow never drops)
//
// `unclaimed` is the answer the gate would give if no run took it. The
// router applies it again after the hook when the hook did not block (the
// run ended in between, or every claim was passthrough), and the hook
// passes it to `dispatch`, which then starts no new run (M1).

export type SenderKind = "person" | "bot" | "agent"

export type GateChange =
  | { kind: "create"; phase: Phase; why: string; endReason?: EndReason }
  | { kind: "move"; from: Phase; to: Phase; why: string; endReason?: EndReason }

export interface GateClaim { runId: string; kind: string }

export interface GateDecision {
  key: string
  /** The gate looked at this message (mode not off, a covered channel, not a replay). */
  active: boolean
  /** Mode is `active`: drops are real. */
  enforce: boolean
  unclaimed: "pass" | "drop"
  claimed: GateClaim | null
  answer: "pass" | "pass-claimed" | "drop"
  reason: string
  /** Put a reaction on the dropped message (a person's lone "thanks"). */
  react: boolean
  courtesy: CourtesyClass
  senderKind: SenderKind
  /** The phase the decision was made in (after max age). */
  phase: Phase | null
  record: SituationRow | null
  changes: GateChange[]
  messageId: string
  chatId: string
}

export interface SituationGateDeps {
  store: SituationStore
  settings?: () => SituationsConfig
  /** The dispatcher's claimantFor, when the workflow engine runs here. */
  claimant?: () => ((msg: IncomingMessage) => GateClaim | null) | undefined
  now?: () => number
}

const chatOf = (msg: IncomingMessage) => msg.group?.id || msg.sender.id

export function senderKindOf(msg: IncomingMessage): SenderKind {
  if (msg.sender.id.startsWith("agent:")) return "agent"
  return msg.sender.isBot ? "bot" : "person"
}

export class SituationGate {
  private readonly window = new FireWindow(5000)
  /** Message ids already counted by the backstop (S8: count once). */
  private readonly counted = new Map<string, true>()

  constructor(private readonly deps: SituationGateDeps) {}

  get store(): SituationStore { return this.deps.store }

  settings(): SituationsConfig {
    return this.deps.settings?.() ?? DEFAULT_SITUATIONS_CONFIG
  }

  /** Pure: reads the record and the claim rule, writes nothing. */
  decide(msg: IncomingMessage, opts: { replay?: boolean; hop?: boolean; chatId?: string } = {}): GateDecision {
    const s = this.settings()
    const chatId = opts.chatId ?? chatOf(msg)
    const key = situationKey(msg.channel, msg.accountId, chatId)
    const courtesy = classifyCourtesy(msg.text, { hasMedia: !!msg.media })
    const senderKind = senderKindOf(msg)
    const d: GateDecision = {
      key, active: false, enforce: s.mode === "active", unclaimed: "pass", claimed: null, answer: "pass",
      reason: "", react: false, courtesy, senderKind, phase: null, record: null, changes: [], messageId: msg.id, chatId,
    }
    // A replay (crash resume, a stop/resume, a person's release) was
    // accepted once already: never dropped on its way back.
    if (s.mode === "off" || !SITUATION_CHANNELS.has(msg.channel) || opts.replay || msg.resume) return d
    d.active = true

    const now = this.deps.now?.() ?? Date.now()
    const row = this.deps.store.get(key)
    d.record = row
    let phase: Phase | null = row?.phase ?? null
    let endReason: EndReason | null = row?.endReason ?? null

    // Max age, checked when a message arrives (no timer in phase 1).
    if (row && phase !== "ended") {
      const limit = phase === "during" ? s.maxAge.duringHours * 3600_000 : s.maxAge.endingMinutes * 60_000
      if (now - row.phaseChangedAt > limit) {
        d.changes.push({ kind: "move", from: phase!, to: "ended", why: `no message for longer than the ${phase} phase's max age`, endReason: "stale" })
        phase = "ended"
        endReason = "stale"
      }
    }

    const windowMs = s.backstop.windowMinutes * 60_000
    if (senderKind !== "person" && this.window.peek(key, windowMs, now) >= s.backstop.count && !this.counted.has(`${key}|${msg.id}`)) {
      d.unclaimed = "drop"
      d.reason = `backstop: ${s.backstop.count} messages from bots or agents in ${s.backstop.windowMinutes} min`
      if (!row) d.changes.push({ kind: "create", phase: "ended", why: d.reason, endReason: "courtesy loop" })
      else if (phase !== "ended") d.changes.push({ kind: "move", from: phase!, to: "ended", why: d.reason, endReason: "courtesy loop" })
    } else if (!row) {
      d.changes.push(courtesy === "courtesy"
        ? { kind: "create", phase: "ending", why: "the first message is a closer" }
        : { kind: "create", phase: "during", why: "first message on this chat" })
    } else if (phase === "during") {
      if (courtesy === "courtesy") d.changes.push({ kind: "move", from: "during", to: "ending", why: `a closer from ${senderKind} ${msg.sender.name || msg.sender.id}` })
    } else if (phase === "ending") {
      if (courtesy === "courtesy" && row.slot === "taken") {
        d.unclaimed = "drop"
        d.reason = "ending, goodbye in flight"
      } else if (courtesy === "real") {
        d.changes.push({ kind: "move", from: "ending", to: "during", why: "the talk went on" })
      }
    } else if (phase === "ended") {
      if (courtesy === "courtesy") {
        if (!(senderKind === "person" && s.courtesy.onPerson === "reply")) {
          d.unclaimed = "drop"
          d.reason = `ended (${endReason ?? "closed"}), courtesy`
          d.react = senderKind === "person" && s.courtesy.onPerson === "react"
        }
      } else if (courtesy === "real") {
        d.changes.push({ kind: "move", from: "ended", to: "during", why: "reopened by a new message" })
      }
    }
    d.phase = phase

    if (d.unclaimed === "drop") {
      // A run that already takes the message wins (B1). Bot-to-bot hops
      // never reach a workflow, so nothing can claim them.
      d.claimed = opts.hop ? null : (this.deps.claimant?.()?.(msg) ?? null)
      d.answer = d.claimed ? "pass-claimed" : d.enforce ? "drop" : "pass"
    }
    return d
  }

  /** Write what `decide` found: phase changes (conditional, S9) and, for a
   *  message that goes on from a bot or an agent, one backstop count per
   *  message id (S8). Never throws: the gate must not stop routing. */
  commit(d: GateDecision): void {
    if (!d.active) return
    try {
      const store = this.deps.store
      let since = d.record?.phaseChangedAt ?? 0
      for (const c of d.changes) {
        if (c.kind === "create") {
          if (!store.create(d.key, c.phase, c.why, c.endReason)) return
        } else {
          if (!store.move(d.key, { phase: c.from, since }, c.to, { why: c.why, endReason: c.endReason })) return
        }
        since = store.get(d.key)?.phaseChangedAt ?? since
      }
      const id = `${d.key}|${d.messageId}`
      if (d.answer !== "drop" && d.senderKind !== "person" && !this.counted.has(id)) {
        this.counted.set(id, true)
        if (this.counted.size > 5000) this.counted.delete(this.counted.keys().next().value!)
        const s = this.settings()
        this.window.tryFire(d.key, Number.MAX_SAFE_INTEGER, s.backstop.windowMinutes * 60_000, this.deps.now?.() ?? Date.now())
      }
    } catch { /* the record is best-effort; routing goes on */ }
  }

  /** Record a drop (or, in shadow mode, a would-drop) in the gate log.
   *  Returns the row id, the one `agentx situation release` takes. */
  logDrop(msg: IncomingMessage, d: GateDecision, messageJson: string, stage: "gate" | "after-hook" | "hop"): number | null {
    try {
      return this.deps.store.logGate({
        key: d.key,
        situationId: this.deps.store.get(d.key)?.id ?? null,
        messageId: msg.id,
        channel: msg.channel,
        chatId: d.chatId,
        senderId: msg.sender.id,
        senderName: msg.sender.name ?? "",
        senderKind: d.senderKind,
        text: msg.text ?? "",
        phase: d.phase ?? "none",
        outcome: d.enforce ? "drop" : "would-drop",
        reason: stage === "gate" ? d.reason : `${d.reason} (${stage})`,
        message: messageJson,
      })
    } catch {
      return null
    }
  }

  /** A person re-delivers a dropped message: the talk is back in
   *  `during` (set by a person), and the caller re-routes the message as
   *  a replay, which the gate never drops. */
  release(id: number): { ok: true; message: Record<string, unknown> } | { ok: false; error: string } {
    const row = this.deps.store.gateRow(id)
    if (!row) return { ok: false, error: `no gate log row ${id}` }
    if (row.outcome !== "drop") return { ok: false, error: `row ${id} was not dropped (shadow mode let it through)` }
    if (row.releasedAt) return { ok: false, error: `row ${id} was already released` }
    let message: Record<string, unknown>
    try { message = JSON.parse(row.message) as Record<string, unknown> } catch { return { ok: false, error: `row ${id} has no readable message` } }
    if (!this.deps.store.markReleased(id)) return { ok: false, error: `row ${id} was already released` }
    const rec = this.deps.store.get(row.key)
    if (rec && rec.phase !== "during") this.deps.store.move(row.key, { phase: rec.phase, since: rec.phaseChangedAt }, "during", { why: `message ${row.messageId} released by a person`, setBy: "person" })
    return { ok: true, message }
  }
}
