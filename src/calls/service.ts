// --- An agent rings the owner (#321) ---
//
// An agent that needs the owner directly asks for a call. It rings on the
// desktop widget (AgentX Voice), which polls `ringing()`. Answering starts
// the widget's hands-free conversation with that agent, which opens with
// its reason. When the widget is not running, `notify` stands in.
//
// Checked before anything rings, in this order:
//   0. the caller is that agent: a turn of it is running now, named by its
//      task id or by its channel and chat (see CallerProof),
//   1. the owner allows this agent (calls.allow; empty allows nobody),
//   2. the agent has no other call in progress,
//   3. it is under calls.maxPerHour,
//   4. Focus: a non-urgent call does not ring. It becomes a missed call,
//      and its notice goes through notify, which holds it until Focus
//      ends. Urgent calls ring through, as `notify --urgent` does.
//
// A camera ask (#325 phase 3, kind "camera") goes through the same checks
// and the same table. It never rings the widget: the notice goes to the
// phone through notify, and the phone app polls `asking()` to show a
// Show / Decline bar. Answering it is the owner tapping Show; the camera
// opens only then, and the share ends the ask (see camera-api.ts).

import { randomUUID } from "crypto"
import { focusLabel, readFocus, type FocusState } from "@/notify/focus"
import type { CallsConfig } from "@/daemon/config"
import { LIVE, type Call, type CallKind, type CallStore, type CallUrgency } from "./store"

export const REASON_MAX = 200
/** The widget polls every 2 s; missing this long means it is not running. */
export const WIDGET_FRESH_MS = 10_000
export const LATER_DEFAULT_MINUTES = 10
export const LATER_MAX_MINUTES = 240

export type CallResult =
  | { ok: true; call: Call }
  | { ok: false; status: number; error: string }

/** What the request says about the turn placing it: the run's
 *  AGENTX_TASK_ID, or, for a warm process that has none, its
 *  AGENTX_CHANNEL and AGENTX_CHAT_ID. Loopback is not an identity. */
export interface CallerProof {
  taskId?: string
  channel?: string
  chatId?: string
}

/** The proof headers for a call placed from inside an agent's run. */
export function callerHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env.AGENTX_TASK_ID) return { "X-AgentX-Task": env.AGENTX_TASK_ID }
  if (env.AGENTX_CHANNEL && env.AGENTX_CHAT_ID) {
    return { "X-AgentX-Channel": env.AGENTX_CHANNEL, "X-AgentX-Chat": env.AGENTX_CHAT_ID }
  }
  return {}
}

export interface CallDeps {
  store: CallStore
  config: () => CallsConfig
  /** The agent's display name, or null when there is no such agent here. */
  agentName: (agentId: string) => string | null
  /** True when `proof` names a running turn of `agentId`. */
  isRunningTurn: (agentId: string, proof: CallerProof) => boolean
  /** The channel and chat of that running turn, when it has one, so a
   *  camera ask is answered where it was asked. Unset: only a proof that
   *  names them itself is kept. */
  turnSession?: (agentId: string, proof: CallerProof) => { channel?: string; chatId?: string } | null
  /** Tell the owner through notify. `urgent` passes Focus, like notify --urgent. */
  alert: (notice: { title: string; message: string; urgent: boolean; from: string }) => Promise<void>
  /** Ask the agent, in its voice session, to summarise the call. */
  summarize?: (call: Call) => Promise<string | null>
  /** File a finished summary where the dashboard shows it. */
  file?: (call: Call, summary: string) => void
  focus?: () => FocusState
  now?: () => number
  log?: (m: string) => void
}

/** What the widget sends through /ask when the owner answers, so the
 *  agent speaks first and says why it called. */
export function openerPrompt(call: Pick<Call, "reason">): string {
  return "[Call answered] The owner just picked up the voice call you asked for. " +
    `You called because: "${call.reason}". Speak first: greet them in a few words ` +
    "and say why you called, then let them answer."
}

export const SUMMARY_PROMPT =
  "[Call ended] The owner hung up. In two or three plain sentences, summarise what " +
  "was said and decided on this call, for your records. Reply with the summary only."

export class CallService {
  private widgetSeenAt = 0

  constructor(private deps: CallDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private name(agentId: string): string { return this.deps.agentName(agentId) ?? agentId }

  /** An agent asks for a call, or to see (kind "camera"). 201 ringing,
   *  202 held as missed (Focus). */
  async request(input: { agentId?: unknown; reason?: unknown; urgency?: unknown; kind?: unknown }, proof: CallerProof = {}): Promise<CallResult & { rang?: "widget" | "notify" | false }> {
    const agentId = String(input.agentId ?? "").trim()
    const reason = String(input.reason ?? "").replace(/\s+/g, " ").trim()
    const urgency: CallUrgency = input.urgency === "urgent" ? "urgent" : "normal"
    const kind: CallKind = input.kind === "camera" ? "camera" : "voice"
    if (input.kind !== undefined && input.kind !== "voice" && input.kind !== "camera") return { ok: false, status: 400, error: "kind must be voice or camera" }
    if (!agentId || !reason) return { ok: false, status: 400, error: "Required: agentId and reason" }
    if (reason.length > REASON_MAX) return { ok: false, status: 413, error: `reason is over ${REASON_MAX} characters; keep it to one line` }
    if (this.deps.agentName(agentId) === null) return { ok: false, status: 404, error: `Unknown agent: ${agentId}` }
    if (!this.deps.isRunningTurn(agentId, proof)) {
      return { ok: false, status: 403, error: `No running turn of ${agentId} placed this call. An agent calls from inside its own run.` }
    }

    const cfg = this.deps.config()
    if (!cfg.allow.includes("*") && !cfg.allow.includes(agentId)) {
      const verb = kind === "camera" ? "may not ask to see through the owner's camera" : "may not call the owner"
      return { ok: false, status: 403, error: `${agentId} ${verb}. Add it to calls.allow in agentx.json (or: agentx call allow ${agentId}).` }
    }
    await this.sweep()
    if (this.deps.store.list({ status: LIVE, limit: 200 }).some((c) => c.agentId === agentId)) {
      return { ok: false, status: 409, error: `${agentId} already has a call in progress` }
    }
    const now = this.now()
    if (this.deps.store.countSince(agentId, now - 3_600_000) >= cfg.maxPerHour) {
      return { ok: false, status: 429, error: `${agentId} has placed ${cfg.maxPerHour} calls in the last hour (calls.maxPerHour)` }
    }

    // Where the ask came from, for kind "camera": the turn's own chat, or
    // the one the proof names. A task run has neither.
    const session: { channel?: string; chatId?: string } = kind === "camera" ? (this.deps.turnSession?.(agentId, proof) ?? proof) : {}
    const call: Call = {
      id: `call-${randomUUID().slice(0, 8)}`, agentId, kind, reason, urgency, status: "ringing", createdAt: now,
      ringingSince: now, answeredAt: null, endedAt: null, ringAgainAt: null, note: null, summary: null,
      channel: session.channel && session.chatId ? session.channel : null,
      chatId: session.channel && session.chatId ? session.chatId : null,
    }
    this.deps.store.insert(call)
    this.deps.log?.(`[calls] ${agentId} asks ${kind === "camera" ? "to see" : "for a call"} (${urgency}): ${reason}`)
    const rang = await this.ring(call)
    const saved = this.deps.store.get(call.id)!
    return { ok: true, call: saved, rang }
  }

  /** Ring now, or hold as missed in Focus. Returns how it rang. */
  private async ring(call: Call): Promise<"widget" | "notify" | false> {
    const focus = (this.deps.focus ?? readFocus)()
    if (focus.active && call.urgency !== "urgent") {
      if (!this.deps.store.transition(call.id, "ringing", { status: "missed", ringingSince: null, note: focusLabel(focus) })) return false
      await this.notice(call, this.missedTitle(call))
      return false
    }
    // A camera ask is answered on the phone, never on the widget.
    if (call.kind === "camera") {
      await this.notice(call, `${this.name(call.agentId)} wants to see through your camera`,
        `Open the phone app and tap Show within ${this.deps.config().ringSeconds} s.`)
      return "notify"
    }
    if (this.widgetAlive()) return "widget"
    await this.notice(call, `${this.name(call.agentId)} is calling`,
      `Open AgentX Voice to answer within ${this.deps.config().ringSeconds} s.`)
    return "notify"
  }

  private async notice(call: Call, title: string, extra?: string): Promise<void> {
    try {
      await this.deps.alert({
        title, message: extra ? `${call.reason}\n${extra}` : call.reason,
        urgent: call.urgency === "urgent", from: call.agentId,
      })
    } catch (e: any) {
      this.deps.log?.(`[calls] notice for ${call.id} failed: ${e?.message ?? e}`)
    }
  }

  private missedTitle(call: Call): string {
    return call.kind === "camera" ? `${this.name(call.agentId)} asked to see through your camera` : `Missed call from ${this.name(call.agentId)}`
  }

  /** True when the widget polled recently. */
  widgetAlive(): boolean {
    return this.now() - this.widgetSeenAt < WIDGET_FRESH_MS
  }

  /** The widget's poll: voice calls ringing now, oldest first. Marks it alive. */
  async ringing(): Promise<Call[]> {
    this.widgetSeenAt = this.now()
    await this.sweep()
    return this.deps.store.list({ status: ["ringing"], kind: "voice", limit: 20 }).reverse()
  }

  /** The phone app's poll: camera asks waiting for the owner, oldest first.
   *  Does not count as the widget being up. */
  async asking(): Promise<Call[]> {
    await this.sweep()
    return this.deps.store.list({ status: ["ringing"], kind: "camera", limit: 20 }).reverse()
  }

  /** Unanswered calls become missed; "later" calls that came due ring
   *  again; answered calls nobody hung up end after calls.maxCallMinutes. */
  async sweep(): Promise<void> {
    const now = this.now()
    const ringFor = this.deps.config().ringSeconds * 1000
    const talkFor = this.deps.config().maxCallMinutes * 60_000
    for (const call of this.deps.store.list({ status: ["ringing", "later", "answered"], limit: 200 })) {
      // The list was read before any await below: each move re-checks the
      // status in the store, so a call answered meanwhile is left alone.
      if (call.status === "ringing" && call.ringingSince !== null && now - call.ringingSince >= ringFor) {
        if (!this.deps.store.transition(call.id, "ringing", { status: "missed", ringingSince: null, note: "not answered" })) continue
        this.deps.log?.(`[calls] ${call.id} from ${call.agentId} missed`)
        await this.notice(call, this.missedTitle(call))
      } else if (call.status === "answered" && call.answeredAt !== null && now - call.answeredAt >= talkFor) {
        if (!this.deps.store.transition(call.id, "answered", { status: "ended", endedAt: now, note: "no hang-up" })) continue
        this.deps.log?.(`[calls] ${call.id} from ${call.agentId} ended: no hang-up in ${this.deps.config().maxCallMinutes} min`)
      } else if (call.status === "later" && call.ringAgainAt !== null && now >= call.ringAgainAt) {
        const again = this.deps.store.transition(call.id, "later", { status: "ringing", ringingSince: now, ringAgainAt: null })
        if (again) await this.ring(again)
      }
    }
  }

  /** The owner picked up, or tapped Show. Returns the call and, for a
   *  voice call, the opener for /ask. */
  answer(id: string): CallResult & { opener?: string } {
    const call = this.deps.store.get(id)
    if (!call) return unknown(id)
    const answered = this.deps.store.transition(id, "ringing", { status: "answered", answeredAt: this.now(), ringingSince: null })
    if (!answered) return { ok: false, status: 409, error: `call is ${this.deps.store.get(id)?.status}, not ringing` }
    this.deps.log?.(`[calls] ${id} answered (${call.agentId})`)
    return answered.kind === "camera" ? { ok: true, call: answered } : { ok: true, call: answered, opener: openerPrompt(answered) }
  }

  decline(id: string): CallResult {
    const call = this.deps.store.get(id)
    if (!call) return unknown(id)
    const declined = this.deps.store.transition(id, ["ringing", "later"], { status: "declined", endedAt: this.now(), ringingSince: null, ringAgainAt: null })
    return declined ? { ok: true, call: declined } : { ok: false, status: 409, error: `call is ${this.deps.store.get(id)?.status}` }
  }

  /** "Call back in N min": it rings again then. */
  later(id: string, minutes?: unknown): CallResult {
    const call = this.deps.store.get(id)
    if (!call) return unknown(id)
    const n = minutes === undefined ? LATER_DEFAULT_MINUTES : Number(minutes)
    if (!Number.isInteger(n) || n < 1 || n > LATER_MAX_MINUTES) {
      return { ok: false, status: 400, error: `minutes must be a whole number from 1 to ${LATER_MAX_MINUTES}` }
    }
    const later = this.deps.store.transition(id, "ringing", { status: "later", ringingSince: null, ringAgainAt: this.now() + n * 60_000 })
    return later ? { ok: true, call: later } : { ok: false, status: 409, error: `call is ${this.deps.store.get(id)?.status}, not ringing` }
  }

  /** End an answered call. The summary is written in the background;
   *  `summarized` settles when it is filed (tests wait on it). */
  hangup(id: string): CallResult & { summarized?: Promise<void> } {
    const call = this.deps.store.get(id)
    if (!call) return unknown(id)
    const ended = this.deps.store.transition(id, "answered", { status: "ended", endedAt: this.now() })
    if (!ended) return { ok: false, status: 409, error: `call is ${call.status}, not answered` }
    this.deps.log?.(`[calls] ${id} ended (${call.agentId})`)
    const summarize = this.deps.summarize
    // What the agent saw is already its answer; only a voice call is summarised.
    if (ended.kind === "camera" || !this.deps.config().summary || !summarize) return { ok: true, call: ended }
    const summarized = (async () => {
      try {
        const text = (await summarize(ended))?.trim()
        if (!text) return
        const done = this.deps.store.update(id, { summary: text })!
        this.deps.file?.(done, text)
      } catch (e: any) {
        this.deps.log?.(`[calls] summary for ${id} failed: ${e?.message ?? e}`)
      }
    })()
    return { ok: true, call: ended, summarized }
  }

  /** A camera ask ends when the share ends; no summary. Only an answered
   *  ask ends this way, so a stop before Show leaves it ringing. */
  endCamera(id: string, note?: string): boolean {
    const call = this.deps.store.get(id)
    if (!call || call.kind !== "camera") return false
    const ended = this.deps.store.transition(id, "answered", { status: "ended", endedAt: this.now(), note: note ?? null })
    if (ended) this.deps.log?.(`[calls] ${id} ended (${call.agentId}): ${note ?? "share over"}`)
    return !!ended
  }

  get(id: string): Call | undefined { return this.deps.store.get(id) }

  list(opts: Parameters<CallStore["list"]>[0] = {}): Call[] { return this.deps.store.list(opts) }
}

const unknown = (id: string): CallResult => ({ ok: false, status: 404, error: `No such call: ${id}` })
