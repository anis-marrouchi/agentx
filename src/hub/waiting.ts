// --- The shell's Waiting on you, as data (#2226 S5) ---
//
// What waits on the owner: the owner's one list (src/desk/owner-list.ts),
// the same list the old Hub's Needs you, the phone's Desk and the digest
// count. Read from `GET /api/admin/approvals`, whose `desk` is that list in
// the Desk's card shape (DeskCard in src/desk/board.ts). Nothing new on the
// server. Answers stay where they are made today (the old Hub's Needs you,
// the phone, the Mac card): the shell lists and opens.
//
// Plain data and pure functions, so the tests check them without a browser.

import { buildHash } from "./router"

export const WAITING_URL = "/api/admin/approvals"
/** The old Hub's Needs you, where each item is answered. */
export const NEEDS_YOU_PAGE = "#status=open&view=decide"

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
