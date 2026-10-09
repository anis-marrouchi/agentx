import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { resolve } from "path"
import { answerLines, buildChoices, draftFor, resolveAnswer, type CardChoices } from "./choices"
import { isRetroOrigin, originLines, RETRO_NONE, retroApproved, retroCheckLines, retroLines, type CardOrigin } from "./origin"

// --- Decision cards: what an agent asks the operator ---
//
// An agent that needs a yes/no from the operator writes a card instead of
// asking in chat. A card says what it is, the question, what the agent
// recommends, and what happens if nobody answers by `expires`. Nothing
// waits forever: past `expires` the daemon applies `if_silent` (sweep.ts).
//
// Storage: one JSON file per card under `.agentx/approvals/`, written
// atomically, like wiki proposals. The CLI, the dashboard and the daemon
// are separate processes and all read the same files.
//
// Field names match the API (`if_silent`, `raised_by`), so a stored card is
// exactly what `POST /approvals` accepted.

// No card approves itself (#741): only the operator says yes. "approve",
// which older agents and stored cards may still carry, is read as "keep".
export type IfSilent = "discard" | "keep" | "pause"
export const IF_SILENT_VALUES: readonly IfSilent[] = ["discard", "keep", "pause"]

function asIfSilent(v: string): IfSilent | null {
  if (v === "approve") return "keep"
  return IF_SILENT_VALUES.includes(v as IfSilent) ? (v as IfSilent) : null
}

// "resolved": closed by the agent that raised it, because the owner gave the
// same answer somewhere else (in chat, #909) and the agent already acted on
// it. Not a verdict: nothing is approved or rejected by it.
export type CardStatus = "pending" | "decided" | "expired" | "resolved"
export type Verdict = "yes" | "no"

/** Where the agent was asked, so the verdict can be taken back there. */
export interface ReplyTarget {
  channel: string
  chatId: string
  accountId?: string
}

export interface DecisionCard extends CardChoices {
  id: string
  title: string
  ask: string
  recommend: string
  if_silent: IfSilent
  /** ISO time the default applies. Always set. */
  expires: string
  /** Link to the draft, PR or issue. */
  source?: string
  raised_by: string
  /** The mesh node the raising agent is on, when the card was forwarded
   *  here from there (forward.ts, #668). Unset: this node. */
  node?: string
  created_at: string
  reply?: ReplyTarget
  status: CardStatus
  /** The operator's answer (status "decided"). */
  verdict?: Verdict
  /** What applied on expiry (status "expired"). */
  outcome?: IfSilent
  /** Set when the agent, or a card stored before #741, asked for
   *  "approve" on expiry; `if_silent` then holds "keep". Kept so the
   *  record still shows what was originally asked. */
  if_silent_asked?: "approve"
  decided_by?: string
  decided_at?: string
  note?: string
  /** The option the operator picked, when the card offered choices. */
  choice?: string
  /** The message the operator approved, after any edit. */
  text?: string
  /** Set once the raising agent has been told the result. */
  agent_notified_at?: string
  /** Why the raising agent closed it (status "resolved"). */
  resolution?: string
  /** What the card is about, when the daemon raised it (origin.ts). */
  origin?: CardOrigin
}

export const CARD_LIMITS = {
  title: 120,
  ask: 300,
  recommend: 300,
  source: 500,
  note: 500,
  resolution: 300,
  /** Pending cards one agent may have open at a time. */
  pendingPerAgent: 25,
} as const

export interface CardSettings {
  defaultExpiryDays: number
  maxExpiryDays: number
}

export const DEFAULT_CARD_SETTINGS: CardSettings = { defaultExpiryDays: 3, maxExpiryDays: 30 }

export function approvalsDir(root: string): string {
  return resolve(root, ".agentx", "approvals")
}

const CARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

export function isValidCardId(id: string): boolean {
  return CARD_ID_RE.test(id)
}

function fileFor(root: string, id: string): string {
  if (!isValidCardId(id)) throw new Error(`invalid card id: ${id}`)
  return resolve(approvalsDir(root), `${id}.json`)
}

export function newCardId(now: number, title: string): string {
  const day = new Date(now).toISOString().slice(0, 10)
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return `${day}-${slug || "card"}-${Math.random().toString(36).slice(2, 6)}`
}

export function saveCard(root: string, card: DecisionCard): void {
  mkdirSync(approvalsDir(root), { recursive: true })
  const path = fileFor(root, card.id)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(card, null, 2) + "\n")
  renameSync(tmp, path)
}

export function readCard(root: string, id: string): DecisionCard | null {
  if (!isValidCardId(id)) return null
  try {
    const card = JSON.parse(readFileSync(fileFor(root, id), "utf-8")) as DecisionCard
    // A card that expired as "approve" before #741 is read as "keep" too, so
    // an agent not yet told never hears "default applied: approve".
    const legacy = (card.if_silent as string) === "approve" || (card.outcome as string) === "approve"
    return {
      ...card,
      if_silent: asIfSilent(card.if_silent) ?? "keep",
      ...(card.outcome ? { outcome: asIfSilent(card.outcome) ?? "keep" } : {}),
      ...(legacy ? { if_silent_asked: "approve" as const } : {}),
    }
  } catch {
    return null
  }
}

/** Cards, oldest first; only `status` ones when given. */
export function listCards(root: string, status?: CardStatus): DecisionCard[] {
  const dir = approvalsDir(root)
  if (!existsSync(dir)) return []
  const out: DecisionCard[] = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()) {
    const c = readCard(root, f.slice(0, -5))
    if (c && (!status || c.status === status)) out.push(c)
  }
  return out
}

function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : ""
}

/**
 * `expires` as given by an agent: an ISO date or time, or a relative
 * "12h" / "3d". Unset: the default. Always capped at maxExpiryDays, so a
 * card can't be parked for a year.
 */
export function resolveExpiry(input: unknown, now: number, settings: CardSettings): { ok: true; at: string } | { ok: false; error: string } {
  const max = now + settings.maxExpiryDays * 86_400_000
  let at: number
  const raw = oneLine(input)
  if (!raw) {
    at = now + settings.defaultExpiryDays * 86_400_000
  } else {
    const rel = /^(\d+)\s*([hd])$/i.exec(raw)
    if (rel) {
      at = now + Number(rel[1]) * (rel[2].toLowerCase() === "d" ? 86_400_000 : 3_600_000)
    } else {
      at = Date.parse(raw)
      if (Number.isNaN(at)) return { ok: false, error: `expires must be an ISO date or time, or like "12h" / "3d" (got "${raw}")` }
    }
  }
  if (at <= now) return { ok: false, error: "expires must be in the future" }
  return { ok: true, at: new Date(Math.min(at, max)).toISOString() }
}

export interface CardInput {
  title?: unknown
  ask?: unknown
  recommend?: unknown
  if_silent?: unknown
  expires?: unknown
  source?: unknown
  raised_by?: unknown
  reply?: unknown
  choices?: unknown
  draft?: unknown
  say?: unknown
  context?: unknown
}

/** Validate what an agent sent and build a pending card. Never saves. */
export interface BuildCardOptions {
  now?: number
  settings?: CardSettings
  origin?: CardOrigin
  /** The peer the card was forwarded from. The daemon sets it after
   *  checking the name against its mesh peers; never taken as sent. */
  node?: string
}

export function buildCard(
  input: CardInput,
  opts: BuildCardOptions = {},
): { ok: true; card: DecisionCard } | { ok: false; error: string } {
  const now = opts.now ?? Date.now()
  const settings = opts.settings ?? DEFAULT_CARD_SETTINGS
  const title = oneLine(input.title)
  const ask = oneLine(input.ask)
  const recommend = oneLine(input.recommend)
  const raisedBy = oneLine(input.raised_by)
  if (!title) return { ok: false, error: "title is required" }
  if (!ask) return { ok: false, error: "ask is required: the yes/no question" }
  if (!recommend) return { ok: false, error: "recommend is required: your advice and why, in one line" }
  if (!raisedBy) return { ok: false, error: "raised_by is required: the agent id" }
  if (title.length > CARD_LIMITS.title) return { ok: false, error: `title is longer than ${CARD_LIMITS.title} characters` }
  if (ask.length > CARD_LIMITS.ask) return { ok: false, error: `ask is longer than ${CARD_LIMITS.ask} characters` }
  if (recommend.length > CARD_LIMITS.recommend) return { ok: false, error: `recommend is longer than ${CARD_LIMITS.recommend} characters` }
  const ifSilentRaw = oneLine(input.if_silent).toLowerCase()
  const ifSilent = asIfSilent(ifSilentRaw)
  if (!ifSilent) {
    return { ok: false, error: `if_silent must be one of ${IF_SILENT_VALUES.join(", ")}` }
  }
  const expiry = resolveExpiry(input.expires, now, settings)
  if (!expiry.ok) return expiry
  const source = oneLine(input.source)
  if (source.length > CARD_LIMITS.source) return { ok: false, error: `source is longer than ${CARD_LIMITS.source} characters` }
  if (source && /^[a-z][a-z0-9+.-]*:/i.test(source) && !/^https?:\/\//i.test(source)) {
    return { ok: false, error: "source must be an http(s) link or a plain reference" }
  }
  const extras = buildChoices(input)
  if (!extras.ok) return extras
  let reply: ReplyTarget | undefined
  const r = input.reply as Record<string, unknown> | undefined
  if (r && typeof r === "object" && oneLine(r.channel) && oneLine(r.chatId)) {
    reply = { channel: oneLine(r.channel), chatId: oneLine(r.chatId), ...(oneLine(r.accountId) ? { accountId: oneLine(r.accountId) } : {}) }
  }
  return {
    ok: true,
    card: {
      id: newCardId(now, title),
      title,
      ask,
      recommend,
      if_silent: ifSilent,
      ...(ifSilentRaw === "approve" ? { if_silent_asked: "approve" as const } : {}),
      expires: expiry.at,
      ...(source ? { source } : {}),
      raised_by: raisedBy,
      ...(opts.node ? { node: opts.node } : {}),
      created_at: new Date(now).toISOString(),
      ...(reply ? { reply } : {}),
      ...extras.value,
      // Set by the daemon only (check-ins), never from what an agent sent.
      ...(opts.origin ? { origin: opts.origin } : {}),
      status: "pending",
    },
  }
}

/** Validate, enforce the per-agent cap, and save. */
export function createCard(
  root: string,
  input: CardInput,
  opts: BuildCardOptions = {},
): { ok: true; card: DecisionCard } | { ok: false; error: string } {
  const built = buildCard(input, opts)
  if (!built.ok) return built
  // Retro cards are raised for an agent, not by it: they get their own
  // count, so they never use up the agent's room for its own cards.
  const isRetro = (c: { origin?: CardOrigin }) => isRetroOrigin(c.origin)
  const retro = isRetro(built.card)
  const open = listCards(root, "pending").filter((c) => c.raised_by === built.card.raised_by && isRetro(c) === retro).length
  if (open >= CARD_LIMITS.pendingPerAgent) {
    const what = retro ? "retro cards" : "cards"
    return { ok: false, error: `${built.card.raised_by} already has ${open} ${what} waiting; wait for decisions before raising more` }
  }
  saveCard(root, built.card)
  return built
}

/** Record the operator's answer. Refuses anything no longer pending. */
export function decideCard(
  root: string,
  id: string,
  verdict: Verdict,
  opts: { by?: string; note?: string; now?: number; choice?: string | number; text?: string } = {},
): { ok: true; card: DecisionCard } | { ok: false; error: string } {
  const card = readCard(root, id)
  if (!card) return { ok: false, error: `no card "${id}"` }
  if (card.status !== "pending") return { ok: false, error: `card "${id}" is already ${card.status}` }
  const answer = resolveAnswer(card, verdict, opts)
  if (!answer.ok) return answer
  const note = oneLine(opts.note).slice(0, CARD_LIMITS.note)
  const decided: DecisionCard = {
    ...card,
    status: "decided",
    verdict,
    decided_by: opts.by ?? "operator",
    decided_at: new Date(opts.now ?? Date.now()).toISOString(),
    ...(note ? { note } : {}),
    ...(answer.choice ? { choice: answer.choice } : {}),
    ...(answer.text ? { text: answer.text } : {}),
  }
  saveCard(root, decided)
  return { ok: true, card: decided }
}

/** Cards whose answer the daemon acts on itself (a workflow run, a plan
 *  step, a retro): only the operator closes those. A reminder card is the
 *  agent's own to act on, so it may close it like one it raised. */
const AGENT_RESOLVABLE_ORIGINS = new Set<string | undefined>([undefined, "reminder"])

/**
 * The raising agent closes its own pending card: the owner gave the same
 * answer outside the card (in chat) and the agent has acted on it (#909).
 * The card leaves the inbox, so no check-in or popup asks again. It is not
 * a verdict, and the agent is not sent a result for it: it already knows.
 */
export function resolveCard(
  root: string,
  id: string,
  opts: { by: string; reason?: unknown; node?: string; now?: number },
): { ok: true; card: DecisionCard } | { ok: false; error: string } {
  const card = readCard(root, id)
  if (!card) return { ok: false, error: `no card "${id}"` }
  if (card.raised_by !== opts.by || (card.node ?? "") !== (opts.node ?? "")) {
    return { ok: false, error: `card "${id}" was raised by another agent` }
  }
  if (!AGENT_RESOLVABLE_ORIGINS.has(card.origin?.kind)) {
    return { ok: false, error: `card "${id}" is answered by the operator only` }
  }
  if (card.status !== "pending") return { ok: false, error: `card "${id}" is already ${card.status}` }
  const reason = oneLine(opts.reason)
  if (!reason) return { ok: false, error: "reason is required: say where the owner answered and what you did" }
  const at = new Date(opts.now ?? Date.now()).toISOString()
  const resolved: DecisionCard = {
    ...card,
    status: "resolved",
    decided_by: opts.by,
    decided_at: at,
    resolution: reason.slice(0, CARD_LIMITS.resolution),
    agent_notified_at: at,
  }
  saveCard(root, resolved)
  return { ok: true, card: resolved }
}

/** Apply `if_silent` to every pending card past its expiry. */
export function expireCards(root: string, now: number = Date.now()): DecisionCard[] {
  const out: DecisionCard[] = []
  for (const card of listCards(root, "pending")) {
    if (Date.parse(card.expires) > now) continue
    const expired: DecisionCard = {
      ...card,
      status: "expired",
      outcome: card.if_silent,
      decided_by: "expiry",
      decided_at: new Date(now).toISOString(),
    }
    saveCard(root, expired)
    out.push(expired)
  }
  return out
}

/** Decided or expired cards whose agent hasn't been told yet. */
export function cardsAwaitingAgentNotice(root: string): DecisionCard[] {
  return listCards(root).filter((c) => c.status !== "pending" && !c.agent_notified_at)
}

export function markAgentNotified(root: string, id: string, now: number = Date.now()): void {
  const card = readCard(root, id)
  if (!card || card.agent_notified_at) return
  saveCard(root, { ...card, agent_notified_at: new Date(now).toISOString() })
}

export const NO_UNDO_LINE =
  "A no does not by itself undo anything you already did. If you already carried this out (for example because the owner approved it in chat), do not reverse it: ask the requester one clear question first."

/** What the raising agent is told. Plain text, one short message. */
export function verdictMessage(card: DecisionCard): string {
  const retro = card.origin?.kind === "retro" ? card.origin : undefined
  const result = card.status === "decided"
    ? (card.verdict === "yes"
        ? (retro && !retroApproved(card) ? `The operator picked "${RETRO_NONE}", which counts as NO.` : "The operator said YES.")
        : "The operator said NO.")
    : `Nobody answered before it expired, so the default applied: ${card.outcome ?? card.if_silent}.`
  const lines = [
    `[Approval result] Your decision card "${card.title}" (${card.id}) is closed.`,
    `Question: ${card.ask}`,
    result,
  ]
  // A retro card's pick and spec go through retroLines, labelled as the
  // reviewer's proposal: never "Approved text (send exactly this)".
  const check = card.origin?.kind === "retro-check" ? card.origin : undefined
  if (card.status === "decided" && card.verdict === "yes" && !retro && !check) lines.push(...answerLines(card))
  if (card.note) lines.push(`Operator note: ${card.note}`)
  // A late no on something the owner already approved in chat must not
  // quietly undo work that is done (#909).
  if (card.status === "decided" && card.verdict === "no" && !retro && !check) lines.push(NO_UNDO_LINE)
  if (card.source) lines.push(`Source: ${card.source}`)
  if (card.origin?.kind === "reminder") lines.push(...originLines(card.origin, card.status === "decided" && card.verdict === "yes"))
  if (retro || check) {
    // Compare ignoring whitespace so a dashboard that only reflows the draft
    // does not resend the whole draft as the operator's note.
    const squash = (s: string) => s.replace(/\s+/g, " ").trim()
    const draft = draftFor(card.draft, card.choice)
    const edited = card.text && squash(card.text) !== squash(draft) ? card.text : undefined
    lines.push(...(retro ? retroLines(retro, card, edited) : retroCheckLines(check!, card, edited)))
  }
  if (card.reply) lines.push(`You raised it from ${card.reply.channel} chat ${card.reply.chatId}; reply there if the requester should know.`)
  if (card.node) lines.push(`The operator answered it on another machine; the card was forwarded from ${card.node}.`)
  lines.push("Act on this result now. Do not raise the same card again.")
  return lines.join("\n")
}
