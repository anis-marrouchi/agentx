import type { WatchRule, WhatsappTriageConfig } from "./config"
import { createDraft, decideDraft, type SendReply } from "./drafts"
import type { WaMessage } from "./message"
import { inQuietHours, matchRule, normalizeJid } from "./rules"
import { messageKey, type QueuedMessage, type TriageStore } from "./store"
import { buildPrompt, parseVerdict, type Verdict } from "./verdict"

// --- Watched message in, triage out ---
//
// receive() keeps only messages a rule covers, drops repeats, and holds a
// burst from one chat for batchSeconds. Then the rule's agent triages the
// burst in one run. The daemon acts on its verdict:
//   action          notify the owner (not during the rule's quiet hours)
//   a draft reply   saved for the owner's approval (drafts.ts)
//   ack + autoAck   sent directly, only when the rule and allowAutoAck both say so

export interface TriageDeps {
  root: string
  store: TriageStore
  config: () => WhatsappTriageConfig
  execute: (task: { agentId: string; message: string; context: Record<string, unknown> }) => Promise<{ content: string; error?: string }>
  notify: (n: { title: string; message: string; from: string }) => Promise<void>
  /** Used for auto-acknowledgements only. Drafts are sent by decideDraft. */
  send: SendReply
  /** One line about a message's media for the prompt, or null. */
  describeMedia?: (msg: WaMessage) => Promise<string | null>
  now?: () => number
  log: (m: string) => void
}

export type ReceiveResult = { status: "ignored" } | { status: "duplicate" } | { status: "queued"; rule: string }

interface Burst {
  ruleId: string
  items: QueuedMessage[]
  timer: ReturnType<typeof setTimeout>
}

export class TriageService {
  private bursts = new Map<string, Burst>()
  private running = new Set<Promise<void>>()

  constructor(private deps: TriageDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  receive(msg: WaMessage): ReceiveResult {
    const cfg = this.deps.config()
    const rule = cfg.enabled ? matchRule(msg, cfg.rules) : null
    if (!rule) return { status: "ignored" }
    if (!this.deps.store.add(rule.id, msg, this.now())) return { status: "duplicate" }
    this.hold({ key: messageKey(msg), ruleId: rule.id, message: msg })
    return { status: "queued", rule: rule.id }
  }

  /** After a restart: triage what was received but never handed over. */
  resume(): number {
    const queued = this.deps.store.queued()
    for (const q of queued) this.hold(q)
    return queued.length
  }

  private hold(q: QueuedMessage): void {
    const id = `${q.ruleId}|${normalizeJid(q.message.chat)}`
    const burst = this.bursts.get(id)
    if (burst) { burst.items.push(q); return }
    const wait = this.deps.config().batchSeconds * 1000
    const timer = setTimeout(() => this.flush(id), wait)
    timer.unref?.()
    this.bursts.set(id, { ruleId: q.ruleId, items: [q], timer })
  }

  private flush(id: string): void {
    const burst = this.bursts.get(id)
    if (!burst) return
    this.bursts.delete(id)
    const p = this.triage(burst.ruleId, burst.items)
      .catch((e: any) => this.deps.log(`[whatsapp-triage] ${burst.ruleId}: ${e?.message ?? e}`))
      .finally(() => { this.running.delete(p) })
    this.running.add(p)
  }

  /** Triage every held burst now and wait for it. For tests and shutdown. */
  async drain(): Promise<void> {
    for (const [id, b] of [...this.bursts]) { clearTimeout(b.timer); this.flush(id) }
    await Promise.all([...this.running])
  }

  /** Stop the timers. Held messages stay queued for the next start. */
  stop(): void {
    for (const b of this.bursts.values()) clearTimeout(b.timer)
    this.bursts.clear()
  }

  private async triage(ruleId: string, items: QueuedMessage[]): Promise<void> {
    const { store, log } = this.deps
    const taken = new Set(store.take(items.map((i) => i.key)))
    const batch = items.filter((i) => taken.has(i.key))
    if (batch.length === 0) return
    const keys = batch.map((i) => i.key)
    const messages = batch.map((i) => i.message)
    const first = messages[0]
    const where = first.chatName || first.chat
    const base = { ruleId, chat: normalizeJid(first.chat), chatName: first.chatName ?? null, messages: messages.length }

    const cfg = this.deps.config()
    const rule = cfg.rules.find((r) => r.id === ruleId && r.enabled)
    if (!rule) {
      store.finish(keys)
      store.log({ ...base, triage: null, summary: "", draftId: null, error: "rule removed or turned off" }, this.now())
      return
    }

    const notes = new Map<string, string>()
    if (cfg.describeMedia && this.deps.describeMedia) {
      for (const m of messages) {
        if (!m.media) continue
        const note = await this.deps.describeMedia(m).catch(() => null)
        if (note) notes.set(m.id, note)
      }
    }

    const res = await this.deps.execute({
      agentId: rule.agent,
      message: buildPrompt(rule, messages, notes),
      context: { channel: "whatsapp-triage", sender: `whatsapp:${base.chat}`, chatId: `${rule.id}:${base.chat}` },
    }).catch((e: any) => ({ content: "", error: String(e?.message ?? e) }))
    store.finish(keys)

    const verdict = res.error ? null : parseVerdict(res.content)
    if (!verdict) {
      const error = res.error ? `agent failed: ${res.error.slice(0, 200)}` : "agent gave no triage block"
      store.log({ ...base, triage: null, summary: "", draftId: null, error }, this.now())
      log(`[whatsapp-triage] ${rule.id}: ${error}`)
      await this.tell(rule, `Couldn't triage WhatsApp from ${where}`, `${messages.length} message(s) need a look: ${error}.`)
      return
    }

    const { draftId, sent } = await this.reply(rule, cfg, verdict, first)
    store.log({ ...base, triage: verdict.triage, summary: verdict.summary, draftId, error: null }, this.now())
    log(`[whatsapp-triage] ${rule.id}: ${messages.length} message(s) from ${base.chat} → ${verdict.triage}${draftId ? `, draft ${draftId}` : ""}${sent ? ", auto-ack sent" : ""}`)

    if (verdict.triage === "action") {
      const draftLine = draftId ? `\nA draft reply is waiting in Approvals (whatsapp:${draftId}).` : ""
      await this.tell(rule, `WhatsApp: action needed (${where})`, `${verdict.summary || "See the chat."}${draftLine}`)
    }
  }

  private async reply(rule: WatchRule, cfg: WhatsappTriageConfig, verdict: Verdict, first: WaMessage): Promise<{ draftId: string | null; sent: boolean }> {
    if (!verdict.reply) return { draftId: null, sent: false }
    const draft = createDraft(this.deps.root, {
      agent: rule.agent,
      rule_id: rule.id,
      to: first.chat,
      ...(first.chatName ? { chat_name: first.chatName } : {}),
      text: verdict.reply,
      triage: verdict.triage,
      summary: verdict.summary,
      wacli: cfg.wacli,
    }, this.now())
    // Only an acknowledgement, only with both switches on. Anything else waits for the owner.
    if (verdict.triage !== "ack" || !rule.autoAck || !cfg.allowAutoAck) return { draftId: draft.id, sent: false }
    const r = await decideDraft(this.deps.root, draft.id, "yes", { by: `auto-ack:${rule.id}`, send: this.deps.send })
    if (!r.ok) this.deps.log(`[whatsapp-triage] ${rule.id}: auto-ack failed: ${r.error}`)
    return { draftId: draft.id, sent: r.ok }
  }

  private async tell(rule: WatchRule, title: string, message: string): Promise<void> {
    const cfg = this.deps.config()
    if (inQuietHours(rule.quietHours, new Date(this.now()), cfg.timezone)) return
    await this.deps.notify({ title, message, from: rule.agent }).catch((e: any) =>
      this.deps.log(`[whatsapp-triage] notify failed: ${e?.message ?? e}`))
  }
}
