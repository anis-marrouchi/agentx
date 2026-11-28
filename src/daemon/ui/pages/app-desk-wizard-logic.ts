// --- Phone app: Desk "Go through them" logic (#2499 part 2) ---
//
// The same wizard as the Hub's Waiting on you (src/hub/waiting.ts), for the
// phone's Desk tab: one card at a time, most urgent first, two or more Not
// finished requests as one step, each answer sent at once, an end summary.
//
// Plain functions, shipped into /app with injectFns (ui/inject.ts): each one
// must stand alone (no imports, no module values), and may call only the
// other functions injected with it, by name.

/** The part of a Desk card (DeskCard, desk/board.ts) the wizard reads. */
export interface WizCard {
  key: string
  kind: string
  node: string
  column: string
  title: string
  ask?: string
  agent?: string
  choices?: string[]
  textHash?: string
  expires?: string
  askedAt?: string
  can: { answer: boolean }
}

export type WizStep = { kind: "one"; card: WizCard } | { kind: "requests"; cards: WizCard[] }
export type WizAction = "yes" | "no" | "later"
/** One answer given in the wizard, sent or not. */
export interface WizSent { id: string; title: string; agent?: string; words: string; error?: string }

/** A card is the same card on the same node: keys are per node. */
export function wizId(c: Pick<WizCard, "node" | "key">): string {
  return c.node + "|" + c.key
}

/** Most urgent first: deploys (the word, as the Hub reads it: the card has
 *  no deploy field), then the soonest to expire, then the oldest. */
export function wizUrgent(a: WizCard, b: WizCard): number {
  const deploy = (c: WizCard) => (/\bdeploy/i.test(c.title + " " + (c.ask || "")) ? 1 : 0)
  const t = (s?: string) => { const n = s ? Date.parse(s) : NaN; return isNaN(n) ? Number.MAX_SAFE_INTEGER : n }
  const d = deploy(b) - deploy(a)
  if (d) return d
  const e = t(a.expires) - t(b.expires)
  if (e) return e
  const o = t(a.askedAt) - t(b.askedAt)
  return o > 0 ? 1 : o < 0 ? -1 : 0
}

/** The steps over the cards that wait for an answer (Your turn, can.answer).
 *  Two or more requests are one step, last: restart all, close all, or one
 *  by one. */
export function wizSteps(cards: WizCard[]): WizStep[] {
  const open = cards.filter((c) => c.column === "yours" && c.can && c.can.answer)
  const requests = open.filter((c) => c.kind === "request").sort(wizUrgent)
  const rest = (requests.length > 1 ? open.filter((c) => c.kind !== "request") : open).slice().sort(wizUrgent)
  const steps: WizStep[] = rest.map((card) => ({ kind: "one" as const, card }))
  if (requests.length > 1) steps.push({ kind: "requests", cards: requests })
  return steps
}

/** "One by one": the requests step at `at` becomes one step per request. */
export function wizOneByOne(steps: WizStep[], at: number): WizStep[] {
  const s = steps[at]
  if (!s || s.kind !== "requests") return steps
  return steps.slice(0, at).concat(s.cards.map((card) => ({ kind: "one" as const, card })), steps.slice(at + 1))
}

/** A step answered somewhere else since the wizard opened: its card no
 *  longer waits, or none of its requests do. `live` null: not read yet. */
export function wizGone(step: WizStep | undefined, live: Record<string, boolean> | null): boolean {
  if (!step || !live) return false
  return step.kind === "one" ? !live[wizId(step.card)] : !step.cards.some((c) => live[wizId(c)])
}

/** The ids of the cards that still wait, from a fresh board read. */
export function wizLive(cards: WizCard[]): Record<string, boolean> {
  const live: Record<string, boolean> = {}
  cards.forEach((c) => { if (c.column === "yours" && c.can && c.can.answer) live[wizId(c)] = true })
  return live
}

/** What POST /api/app/approvals/decide gets (app-fleet.ts): the 1-based
 *  choice on a yes, and on a yes the shown draft's hash as `seen`, so a
 *  draft changed since it was read is not published (drafts.ts). */
export function wizBody(
  c: Pick<WizCard, "node" | "key" | "textHash">, action: WizAction, choice?: number | null,
): { node: string; key: string; action: WizAction; choice?: number; seen?: string } {
  const b: { node: string; key: string; action: WizAction; choice?: number; seen?: string } = { node: c.node, key: c.key, action }
  if (action === "yes" && choice != null && choice >= 0) b.choice = choice + 1
  if (action === "yes" && c.textHash) b.seen = c.textHash
  return b
}

/** An answer in words, as the summary says it. */
export function wizWords(c: Pick<WizCard, "kind" | "choices">, action: WizAction, choice?: number | null): string {
  if (action === "later") return "Later"
  if (c.kind === "request") return action === "yes" ? "Pick it up again" : "Close it"
  if (action === "yes" && choice != null && c.choices && c.choices[choice]) return c.choices[choice]
  return action === "yes" ? "Yes" : "No"
}

/** Kinds whose yes sends or publishes outside: one more tap to confirm. */
export function wizOutside(kind: string): boolean {
  return kind === "whatsapp" || kind === "email" || kind === "content"
}

/** The end summary: what went to whom, by agent in the order first
 *  answered, and what could not be sent. */
export function wizSummary(sent: WizSent[]): { byAgent: { agent: string; answers: WizSent[] }[]; failed: WizSent[] } {
  const byAgent: { agent: string; answers: WizSent[] }[] = []
  sent.forEach((s) => {
    if (s.error) return
    const agent = s.agent || ""
    let g = byAgent.filter((x) => x.agent === agent)[0]
    if (!g) { g = { agent, answers: [] }; byAgent.push(g) }
    g.answers.push(s)
  })
  return { byAgent, failed: sent.filter((s) => !!s.error) }
}
