import type { CardAction, CardInput, DecisionCard } from "@/approvals/cards"
import { inQuietHours, matchRule, bareJid, type WacliMessage, type WacliRule } from "./rules"
import type { WacliStore } from "./store"
import { chatLabel, parseTriage, triagePrompt, type PreparedMessage, type TriageVerdict } from "./triage"

// --- WhatsApp triage: from a stored message to an owner decision ---
//
//   receive   a rule matched: store it once (dedup), start or extend the
//             chat's batch timer
//   flush     claim the batch, read its media, one turn on the rule's agent
//   act       action → tell the owner; a draft reply → an Approvals card
//             whose yes sends it through wacli (approvals/actions.ts);
//             autoAck (per rule, off by default) sends an ack draft at once
//
// The agent is never given a way to send: the only send paths are an
// approved card and a rule's autoAck.

export interface WacliSettings {
  enabled: boolean
  batchSeconds: number
  rules: WacliRule[]
}

export interface WacliServiceDeps {
  store: WacliStore
  settings: () => WacliSettings
  hasAgent: (id: string) => boolean
  /** One turn on the agent; its final answer. */
  execute: (agentId: string, message: string, chatId: string) => Promise<{ content?: string; error?: string }>
  /** Read images and voice notes; returns a cleanup for any files made. */
  prepare: (batch: WacliMessage[]) => Promise<{ messages: PreparedMessage[]; cleanup: () => Promise<void> }>
  createCard: (input: CardInput, action: CardAction) => { ok: true; card: DecisionCard } | { ok: false; error: string }
  send: (action: CardAction) => Promise<void>
  notifyOwner: (title: string, message: string, from: string) => Promise<void>
  log: (line: string) => void
  now?: () => number
}

export type ReceiveResult = "stored" | "duplicate" | "unwatched"

export interface FlushOutcome {
  messages: number
  verdict: TriageVerdict | null
  card?: string
  autoAcked?: boolean
  notified?: boolean
}

/** A burst never waits longer than this many batch windows. */
const MAX_WINDOWS = 5

interface Pending {
  timer: ReturnType<typeof setTimeout>
  first: number
}

export class WacliService {
  private timers = new Map<string, Pending>()
  private running = new Map<string, Promise<unknown>>()
  private stopped = false

  constructor(private deps: WacliServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** A verified message from wacli. Unwatched ones leave nothing behind. */
  receive(msg: WacliMessage): ReceiveResult {
    const rule = matchRule(this.deps.settings().rules, msg)
    if (!rule) return "unwatched"
    const chat = bareJid(msg.Chat)
    if (!this.deps.store.add(chat, msg.ID, rule.id, msg, this.now())) return "duplicate"
    this.schedule(chat, rule.id)
    return "stored"
  }

  /** Pick up batches a restart left waiting. */
  start(): void {
    this.stopped = false
    for (const b of this.deps.store.pending()) this.schedule(b.chat, b.rule, b.since)
    try { this.deps.store.prune(this.now()) } catch (e: any) { this.deps.log(`[wacli] prune failed: ${e?.message ?? e}`) }
  }

  stop(): void {
    this.stopped = true
    for (const p of this.timers.values()) clearTimeout(p.timer)
    this.timers.clear()
  }

  /** Debounced per chat: each message restarts the wait, up to MAX_WINDOWS. */
  private schedule(chat: string, rule: string, since?: number): void {
    if (this.stopped) return
    const key = `${chat}\u0000${rule}`
    const windowMs = this.deps.settings().batchSeconds * 1000
    const now = this.now()
    const prev = this.timers.get(key)
    const first = prev?.first ?? since ?? now
    if (prev) clearTimeout(prev.timer)
    const wait = Math.max(0, Math.min(now + windowMs, first + windowMs * MAX_WINDOWS) - now)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      void this.flush(chat, rule).catch((e: any) => this.deps.log(`[wacli] ${chat}: triage failed: ${e?.message ?? e}`))
    }, wait)
    timer.unref?.()
    this.timers.set(key, { timer, first })
  }

  /** Triage everything waiting for one chat and rule. One at a time per chat. */
  async flush(chat: string, ruleId: string): Promise<FlushOutcome | null> {
    const key = `${chat}\u0000${ruleId}`
    const before = this.running.get(key)
    if (before) await before.catch(() => {})
    const p = this.flushNow(chat, ruleId)
    this.running.set(key, p)
    try { return await p } finally { if (this.running.get(key) === p) this.running.delete(key) }
  }

  private async flushNow(chat: string, ruleId: string): Promise<FlushOutcome | null> {
    const { log } = this.deps
    const batch = this.deps.store.claim(chat, ruleId, this.now()) as WacliMessage[]
    if (!batch.length) return null
    const rule = this.deps.settings().rules.find((r) => r.id === ruleId && r.enabled)
    if (!rule) { log(`[wacli] ${chat}: rule "${ruleId}" is gone or off; ${batch.length} message(s) dropped`); return null }
    if (!this.deps.hasAgent(rule.agent)) { log(`[wacli] ${chat}: agent "${rule.agent}" isn't on this node; ${batch.length} message(s) dropped`); return null }

    const who = chatLabel(batch[0])
    const { messages, cleanup } = await this.deps.prepare(batch)
    let answer: { content?: string; error?: string }
    try {
      answer = await this.deps.execute(rule.agent, triagePrompt(rule, messages), chat)
    } finally {
      await cleanup().catch(() => {})
    }
    const quiet = inQuietHours(rule.quietHours, this.now())
    const outcome: FlushOutcome = { messages: batch.length, verdict: answer.error ? null : parseTriage(answer.content ?? "") }
    const verdict = outcome.verdict
    if (!verdict) {
      log(`[wacli] ${who}: ${rule.agent} gave no verdict for ${batch.length} message(s)${answer.error ? `: ${answer.error}` : ""}`)
      if (!quiet) await this.tell(`WhatsApp: ${batch[0].ChatName || chat}`, `${batch.length} message(s) couldn't be triaged by ${rule.agent}. Check the chat yourself.`, rule.agent)
      return outcome
    }

    const last = batch[batch.length - 1]
    const name = (batch[0].ChatName || batch[0].PushName || chat).slice(0, 60)
    if (verdict.reply) {
      const action: CardAction = { kind: "wacli.send", to: bareJid(last.Chat), message: verdict.reply, replyTo: last.ID, label: name }
      if (verdict.class === "ack" && rule.autoAck && !quiet) {
        try {
          await this.deps.send(action)
          outcome.autoAcked = true
          log(`[wacli] ${who}: acknowledged automatically (rule ${rule.id} has autoAck on)`)
        } catch (e: any) {
          log(`[wacli] ${who}: auto-acknowledgement failed, asking instead: ${e?.message ?? e}`)
        }
      }
      if (!outcome.autoAcked) {
        const made = this.deps.createCard({
          title: `WhatsApp reply to ${name}`,
          ask: `Send this reply to ${name} on WhatsApp?`,
          recommend: `${verdict.class}: ${verdict.summary || "no summary"}`.slice(0, 300),
          if_silent: "discard",
          raised_by: rule.agent,
        }, action)
        if (made.ok) outcome.card = made.card.id
        else log(`[wacli] ${who}: draft reply not filed: ${made.error}`)
      }
    }
    if (verdict.class === "action" && !quiet) {
      await this.tell(`WhatsApp: ${name}`, `${verdict.summary || "Needs action."}${outcome.card ? " A draft reply waits in Approvals." : ""}`, rule.agent)
      outcome.notified = true
    }
    log(`[wacli] ${who}: ${batch.length} message(s) → ${verdict.class}${outcome.card ? `, card ${outcome.card}` : ""}${quiet ? " (quiet hours)" : ""}`)
    return outcome
  }

  private async tell(title: string, message: string, from: string): Promise<void> {
    try { await this.deps.notifyOwner(title, message, from) } catch (e: any) { this.deps.log(`[wacli] owner notification failed: ${e?.message ?? e}`) }
  }
}
