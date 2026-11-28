// --- The shell's Waiting on you, as data (#2226 S5) ---
//
// What waits on the owner: the owner's one list (src/desk/owner-list.ts),
// the same list the old Hub's Needs you, the phone's Desk and the digest
// count. Read from `GET /api/admin/approvals`, whose `desk` is that list in
// the Desk's card shape (DeskCard in src/desk/board.ts). Nothing new on the
// server: answers go through the same call as the feed's cards
// (POST /api/admin/wall/decide), from the opened item or the wizard
// (#2499 part 2, NeedsWizard.tsx).
//
// Plain data and pure functions, so the tests check them without a browser.

import { buildHash } from "./router"

export const WAITING_URL = "/api/admin/approvals"
/** Where an answer is sent (wall-actions.ts → approvals-panel.ts). */
export const DECIDE_URL = "/api/admin/wall/decide"

/** The part of a Desk card the shell draws (DeskCard in desk/board.ts). */
export interface WaitingItem {
  key: string
  kind: string
  title: string
  ask?: string
  facts?: string
  need?: string
  said?: string
  recommend?: string
  agent?: string
  nodeName?: string
  yes?: string
  no?: string
  choices?: string[]
  /** Content drafts: the hash of the post shown, sent as `seen` with a yes. */
  textHash?: string
  expires?: string
  ifSilent?: string
  askedAt?: string
}

export interface WaitingReply {
  desk?: { count?: number; later?: number; oldest?: string; items?: WaitingItem[]; errors?: string[] }
}

export interface WaitingList { items: WaitingItem[]; later: number; errors: string[] }

const time = (s?: string) => (s ? Date.parse(s) || 0 : 0)

/** The list of a reply, oldest ask first (the one waiting longest on top);
 *  items without a key are dropped. */
export function waitingList(reply: WaitingReply | null | undefined): WaitingList {
  const d = reply?.desk
  const items = (Array.isArray(d?.items) ? d!.items : []).filter((i) => i && i.key)
  items.sort((a, b) => (time(a.askedAt) || Number.MAX_SAFE_INTEGER) - (time(b.askedAt) || Number.MAX_SAFE_INTEGER))
  return { items, later: Number(d?.later) || 0, errors: Array.isArray(d?.errors) ? d!.errors.filter(Boolean) : [] }
}

/** Waiting on you's number: the Desk items of a reply, undefined while it
 *  loads. The menu's Waiting on you item and its Needs you heading both
 *  show this one number (#2101 R3). */
export function waitingCount(reply: WaitingReply | null | undefined): number | undefined {
  return reply ? waitingList(reply).items.length : undefined
}

const KIND_WORD: Record<string, string> = {
  card: "Decision", request: "Request", schedule: "Schedule", memory: "Memory", wiki: "Wiki", fact: "Fact", question: "Question",
  whatsapp: "WhatsApp", email: "Email", agent: "Agent", content: "Content", ci: "CI",
}

/** The item's kind in a word ("card" is a decision an agent asked for). */
export function waitingKind(kind: string): string {
  return KIND_WORD[kind] ?? (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Item")
}

/** Where an item opens in the shell. */
export const waitingHref = (key?: string) => buildHash({ page: "home", pane: "waiting", open: key })

/** A request's id, so its task opens in Tasks; null for any other kind. */
export function waitingTaskId(item: Pick<WaitingItem, "key" | "kind">): string | null {
  return item.key.startsWith("request:") ? item.key.slice("request:".length) || null : null
}

const DAY = 86_400_000

/** Answer by soon: expires within a day (after that its default applies). */
export function waitingSoon(item: Pick<WaitingItem, "expires">, now = Date.now()): boolean {
  const t = time(item.expires)
  return t > 0 && t - now < DAY
}

// --- Going through them, one at a time (#2499 part 2) ---

/** A deploy waits on the owner: first in the wizard (Anis 11-28, "client
 *  deploys first"). The Desk card has no client or deploy field, so it is
 *  the word in what is asked. */
export function waitingDeploy(item: Pick<WaitingItem, "title" | "ask">): boolean {
  return /\bdeploy/i.test(`${item.title} ${item.ask ?? ""}`)
}

/** Most urgent first: deploys, then the soonest to expire, then the oldest. */
export function byUrgent(a: WaitingItem, b: WaitingItem): number {
  const d = Number(waitingDeploy(b)) - Number(waitingDeploy(a))
  if (d) return d
  const ea = time(a.expires) || Number.MAX_SAFE_INTEGER
  const eb = time(b.expires) || Number.MAX_SAFE_INTEGER
  if (ea !== eb) return ea - eb
  return (time(a.askedAt) || Number.MAX_SAFE_INTEGER) - (time(b.askedAt) || Number.MAX_SAFE_INTEGER)
}

/** One step of the wizard: one item, or every "Not finished" request at once. */
export type WizardStep = { kind: "one"; item: WaitingItem } | { kind: "requests"; items: WaitingItem[] }

/** The steps, most urgent first. Two or more requests are one step, last:
 *  restart all, close all, or one by one. */
export function wizardSteps(items: WaitingItem[]): WizardStep[] {
  const requests = items.filter((i) => i.kind === "request")
  const rest = (requests.length > 1 ? items.filter((i) => i.kind !== "request") : items).slice().sort(byUrgent)
  const steps: WizardStep[] = rest.map((item) => ({ kind: "one", item }))
  if (requests.length > 1) steps.push({ kind: "requests", items: requests.slice().sort(byUrgent) })
  return steps
}

/** "One by one": the requests step at `at` becomes one step per request. */
export function oneByOne(steps: WizardStep[], at: number): WizardStep[] {
  const s = steps[at]
  if (!s || s.kind !== "requests") return steps
  return [...steps.slice(0, at), ...s.items.map((item): WizardStep => ({ kind: "one", item })), ...steps.slice(at + 1)]
}

/** A step answered somewhere else since the wizard opened, so it is passed
 *  over: its one item is no longer waiting, or none of its requests are.
 *  `live` null (not read yet): nothing is gone. */
export function stepGone(step: WizardStep | undefined, live: ReadonlySet<string> | null): boolean {
  if (!step || live === null) return false
  return step.kind === "one" ? !live.has(step.item.key) : !step.items.some((i) => live.has(i.key))
}

export type WizardAction = "yes" | "no" | "later"

/** What is sent for an answer (approvals-panel.ts: yes | no | later, with
 *  the 1-based choice when the card offers choices). A yes carries the
 *  shown draft's hash as `seen`: the server refuses to publish a draft
 *  that changed since (drafts.ts), as the old Hub does. */
export function decideBody(
  key: string, action: WizardAction, choice: number | null = null, seen?: string,
): { key: string; action: WizardAction; choice?: number; seen?: string } {
  return {
    key, action,
    ...(action === "yes" && choice !== null ? { choice: choice + 1 } : {}),
    ...(action === "yes" && seen ? { seen } : {}),
  }
}

/** An answer in words, as the summary says it. */
export function answerWords(item: Pick<WaitingItem, "kind" | "choices">, action: WizardAction, choice: number | null = null): string {
  if (action === "later") return "Later"
  if (item.kind === "request") return action === "yes" ? "Pick it up again" : "Close it"
  if (action === "yes" && choice !== null && item.choices?.[choice]) return item.choices[choice]
  return action === "yes" ? "Yes" : "No"
}

/** Kinds whose yes sends or publishes outside: one more tap to confirm. */
export function sendsOutside(kind: string): boolean {
  return kind === "whatsapp" || kind === "email" || kind === "content"
}

/** One answer given in the wizard, sent or not. */
export interface SentAnswer { key: string; title: string; agent?: string; words: string; error?: string }

/** The end summary: what went to whom, by agent in the order first
 *  answered, and what could not be sent. */
export function sentSummary(sent: SentAnswer[]): { byAgent: { agent: string; answers: SentAnswer[] }[]; failed: SentAnswer[] } {
  const byAgent: { agent: string; answers: SentAnswer[] }[] = []
  for (const s of sent) {
    if (s.error) continue
    const agent = s.agent || ""
    let g = byAgent.find((x) => x.agent === agent)
    if (!g) byAgent.push(g = { agent, answers: [] })
    g.answers.push(s)
  }
  return { byAgent, failed: sent.filter((s) => s.error) }
}
