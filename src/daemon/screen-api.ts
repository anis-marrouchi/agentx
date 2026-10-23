import type { DecisionCard } from "@/approvals/cards"
import type { PendingNotification } from "@/notify/queue"
import type { RequestRecord } from "@/requests/store"
import { cardWords } from "@/requests/card-view"
import type { QueueItem, QueueView } from "@/voice/speaking-queue"

// --- What is on the owner's screen now (#1100) ---
//
//   GET /screen   {ts, cards, held, voice, requests}
//
// One read over everything that is in front of the owner or waiting to
// be: decision cards not yet answered, notices Focus or a call is holding,
// the lines waiting to be spoken, and open requests whose next step is
// the owner's. An agent reads it before it puts something new in front
// of the owner, to see whether the same thing is already there.
//
// Read only, and bounded: titles and who raised what, never a card's ask,
// a notice's message or a request's whole text. Mesh-gated like
// /approvals (isMeshGatedPath): it names agents and what they asked.

/** At most this many of each list; `total` keeps the full count. */
export const SCREEN_LIST_MAX = 20
const TITLE_MAX = 120
/** A spoken line has no title: its first words stand in for one. */
const LINE_MAX = 80

export interface ScreenList<T> {
  total: number
  items: T[]
}

export interface ScreenView {
  ts: string
  cards: ScreenList<{ id: string; title: string; raised_by: string; node: string | null; createdAt: string }>
  held: ScreenList<{ id: string; title: string; from: string; at: string; heldBecause: string }>
  voice: {
    paused: boolean
    reserved: boolean
    playing: ScreenVoiceLine | null
    waiting: ScreenList<ScreenVoiceLine>
  } | null
  requests: ScreenList<{ id: string; title: string; agentId: string; state: string; since: string }>
  /** Sources that could not be read, so an empty list is not taken for a quiet screen. */
  errors: string[]
}

export interface ScreenVoiceLine {
  id: string
  agentId: string | null
  kind: string
  text: string
  enqueuedAt: string
}

export interface ScreenInput {
  now: number
  /** Every card; only pending ones are listed. */
  cards: DecisionCard[]
  held: PendingNotification[]
  /** The speaking queue; null where this host has none. */
  voice: QueueView | null
  /** Open requests. Null: requests are off or have no database. */
  requests: RequestRecord[] | null
  errors?: string[]
}

/** Requests whose next step is the owner's, as the Desk counts them. */
const OWNER_STATES = new Set(["waiting_owner", "needs_attention"])

// A hand-edited file may lack a field: one bad item must not take the
// whole view down.
function clip(text: unknown, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function bounded<T>(all: T[]): ScreenList<T> {
  return { total: all.length, items: all.slice(0, SCREEN_LIST_MAX) }
}

const iso = (ms: number) => new Date(ms).toISOString()

function line(i: QueueItem): ScreenVoiceLine {
  return { id: i.id, agentId: i.agentId, kind: i.kind, text: clip(i.text, LINE_MAX), enqueuedAt: iso(i.enqueuedAt) }
}

/** The screen view, oldest first in every list: what has waited longest leads. */
export function buildScreen(input: ScreenInput): ScreenView {
  const cards = input.cards
    .filter((c) => c.status === "pending")
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
    .map((c) => ({ id: c.id, title: clip(c.title, TITLE_MAX), raised_by: c.raised_by, node: c.node ?? null, createdAt: c.created_at }))
  const held = [...input.held]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((n) => ({ id: n.id, title: clip(n.title, TITLE_MAX), from: n.from, at: n.at, heldBecause: n.heldBecause }))
  const requests = (input.requests ?? [])
    .filter((r) => OWNER_STATES.has(r.state))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({
      id: r.id,
      title: cardWords(r, TITLE_MAX).headline,
      agentId: r.agentId,
      state: r.state,
      since: iso(r.stateChangedAt ?? r.updatedAt),
    }))
  const v = input.voice
  return {
    ts: iso(input.now),
    cards: bounded(cards),
    held: bounded(held),
    voice: v ? { paused: v.paused, reserved: v.reserved, playing: v.playing ? line(v.playing) : null, waiting: bounded(v.waiting.map(line)) } : null,
    requests: bounded(requests),
    errors: input.errors ?? [],
  }
}

/** What the agentx_screen tool says: one line per thing, counts first. */
export function describeScreen(v: ScreenView): string {
  const out: string[] = []
  const more = (l: ScreenList<unknown>) => (l.total > l.items.length ? [`  … and ${l.total - l.items.length} more`] : [])
  out.push(`Decision cards waiting for an answer: ${v.cards.total}`)
  for (const c of v.cards.items) out.push(`  - ${c.title} (by ${c.raised_by}${c.node ? ` on ${c.node}` : ""}, ${c.createdAt}, ${c.id})`)
  out.push(...more(v.cards))
  out.push(`Notices held by Focus or a call: ${v.held.total}`)
  for (const n of v.held.items) out.push(`  - ${n.title} (from ${n.from}, ${n.at})`)
  out.push(...more(v.held))
  if (v.voice) {
    const state = v.voice.paused ? ", paused" : v.voice.reserved ? ", the floor is held" : ""
    out.push(`Speaking now: ${v.voice.playing ? `${v.voice.playing.agentId ?? "the host"}: ${v.voice.playing.text}` : "nothing"}${state}`)
    out.push(`Lines waiting to be spoken: ${v.voice.waiting.total}`)
    for (const l of v.voice.waiting.items) out.push(`  - ${l.agentId ?? "the host"} (${l.kind}): ${l.text}`)
    out.push(...more(v.voice.waiting))
  }
  out.push(`Open requests waiting on the owner: ${v.requests.total}`)
  for (const r of v.requests.items) out.push(`  - ${r.title} (${r.agentId}, ${r.state.replace("_", " ")} since ${r.since}, ${r.id})`)
  out.push(...more(v.requests))
  for (const e of v.errors) out.push(`Could not read: ${e}`)
  return out.join("\n")
}
