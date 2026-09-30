import { readClaims } from "@/reminders/store"
import type { Reminder, ReminderSource } from "@/reminders/source"
import { parseTrailer } from "@/reminders/trailer"
import { createCard, readCard, type CardSettings } from "./cards"
import { composePrompt, parseCompose } from "./checkin-compose"
import { pruneItems, readCheckinState, writeCheckinState, type CheckinState } from "./checkin-state"
import { recordPass } from "./state"
import { localClock } from "./sweep"

// --- Check-ins: the operator's open items, a few times a day ---
//
// At each time in `times`, and once a day at `dailyAt`, the daemon:
//   1. puts every waiting decision card back in line for the Mac card;
//   2. reads the operator's open Apple Reminders (`lists`). A normal pass
//      takes those due within `dueWithinHours` or overdue; the daily pass
//      takes every open one;
//   3. asks the agent that owns each reminder (its `agentx:` trailer, else
//      `agent`) what the card should say (checkin-compose.ts), and raises
//      it on that agent's behalf, linked to the reminder (origin.ts).
// The operator's answer goes back to that agent through the approvals
// sweep, like any card. Nothing here sends anything to anyone.
//
// A reminder gets one card at a time. After an answer, after the agent
// said it doesn't need the operator, or after a failed attempt, it comes
// back at the next daily pass if it is still open. A pass asks at most
// `maxAsksPerPass` agents, whatever they answer: each ask is a full turn. Reminders the reminders poller has claimed belong
// to their agent and are left alone.

export interface CheckinSettings {
  enabled: boolean
  /** Local HH:MM times for a normal pass. */
  times: string[]
  /** Local HH:MM of the daily pass. */
  dailyAt: string
  timezone?: string
  lists: string[]
  /** Owner of reminders without an `agentx:` trailer. Unset: they are skipped. */
  agent?: string
  dueWithinHours: number
  /** Most agent turns one pass starts, cards or not. */
  maxAsksPerPass: number
  composeTimeoutSeconds: number
}

export type PassKind = "daily" | "check"

export interface CheckinDeps {
  root: string
  settings: CheckinSettings
  cardSettings?: CardSettings
  source: ReminderSource
  /** The reminders poller's claims file, when it runs. */
  claimsPath?: string
  hasAgent: (agentId: string) => boolean
  /** One turn on the agent; resolves to its final text. */
  ask: (agentId: string, message: string, reminder: Reminder) => Promise<string>
  log: (msg: string) => void
  now?: number
}

export interface PassResult {
  kind: PassKind
  looked: number
  carded: string[]
  skipped: number
  failed: number
}

const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m }

/** The pass due now, if any. A missed slot is not replayed: only the latest counts. */
export function checkinDue(s: CheckinSettings, state: Pick<CheckinState, "lastSlot" | "lastDaily">, now: number): { kind: PassKind; slot: string } | null {
  const { date, minutes } = localClock(now, s.timezone)
  if (state.lastDaily !== date && minutes >= toMinutes(s.dailyAt)) {
    return { kind: "daily", slot: `${date} ${s.dailyAt}` }
  }
  const latest = s.times.filter((t) => toMinutes(t) <= minutes).sort().pop()
  if (!latest) return null
  const slot = `${date} ${latest}`
  // The daily pass at or after this slot covers it.
  if (state.lastDaily === date && toMinutes(s.dailyAt) >= toMinutes(latest)) return null
  if (state.lastSlot && state.lastSlot >= slot) return null
  return { kind: "check", slot }
}

function isEligible(r: Reminder, state: CheckinState, kind: PassKind, s: CheckinSettings, root: string, now: number): boolean {
  if (kind === "check") {
    const due = r.dueDate ? Date.parse(r.dueDate) : NaN
    if (!(due <= now + s.dueWithinHours * 3_600_000)) return false
  }
  const rec = state.items[r.id]
  if (!rec) return true
  if (rec.status === "carded" && rec.card && readCard(root, rec.card)?.status === "pending") return false
  // Answered, not needed or failed: back once a day while it stays open.
  return kind === "daily" && localClock(Date.parse(rec.at), s.timezone).date !== localClock(now, s.timezone).date
}

function withTimeout<T>(p: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${seconds}s`)), seconds * 1000) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/** One pass. Never throws; failures are logged and retried at the next daily pass. */
export async function runCheckinPass(deps: CheckinDeps, kind: PassKind): Promise<PassResult> {
  const { root, settings: s, log } = deps
  const now = deps.now ?? Date.now()
  const result: PassResult = { kind, looked: 0, carded: [], skipped: 0, failed: 0 }
  recordPass(root, now)

  const open: Reminder[] = []
  for (const list of s.lists) {
    try {
      open.push(...(await deps.source.listOpen(list)).map((r) => ({ ...r, listName: r.listName ?? list })))
    } catch (e: any) {
      log(`[checkin] couldn't read the "${list}" reminders: ${e?.message ?? e}`)
    }
  }
  const state = readCheckinState(root)
  const claims = deps.claimsPath ? readClaims(deps.claimsPath) : {}
  const due = (r: Reminder) => (r.dueDate ? Date.parse(r.dueDate) : Infinity)
  const todo = open
    .filter((r) => !claims[r.id] && isEligible(r, state, kind, s, root, now))
    .sort((a, b) => due(a) - due(b))
  result.looked = open.length

  let asks = 0
  for (const r of todo) {
    if (asks >= s.maxAsksPerPass) break
    const trailer = parseTrailer(r.notes)
    const owner = [trailer?.agent, s.agent].find((a) => a && deps.hasAgent(a))
    if (!owner) {
      log(`[checkin] "${r.title}": no agent owns it (no agentx trailer, approvals.checkin.agent unset or unknown); skipped`)
      continue
    }
    const at = new Date(now).toISOString()
    const nowText = new Date(now).toLocaleString("en-GB", { timeZone: s.timezone, dateStyle: "full", timeStyle: "short" })
    asks++
    try {
      const reply = await withTimeout(deps.ask(owner, composePrompt(r, trailer, nowText), r), s.composeTimeoutSeconds)
      const composed = parseCompose(reply)
      if (composed.kind === "skip") {
        state.items[r.id] = { status: "skipped", owner, at, ...(composed.why ? { why: composed.why } : {}) }
        result.skipped++
        continue
      }
      if (composed.kind === "error") throw new Error(composed.error)
      const made = createCard(root, { ...composed.input, raised_by: owner }, {
        now, settings: deps.cardSettings,
        origin: { kind: "reminder", id: r.id, title: r.title, ...(r.listName ? { list: r.listName } : {}) },
      })
      if (!made.ok) throw new Error(made.error)
      state.items[r.id] = { status: "carded", owner, at, card: made.card.id }
      result.carded.push(made.card.id)
      log(`[checkin] "${r.title}": card:${made.card.id} raised for ${owner}`)
    } catch (e: any) {
      state.items[r.id] = { status: "failed", owner, at, why: String(e?.message ?? e).slice(0, 200) }
      result.failed++
      log(`[checkin] "${r.title}": ${owner} couldn't compose a card: ${e?.message ?? e}`)
    } finally {
      // Saved after each item: a pass cut short keeps what it did.
      writeCheckinState(root, { ...readCheckinState(root), items: state.items })
    }
  }
  writeCheckinState(root, { ...readCheckinState(root), items: pruneItems(state.items, new Set(open.map((r) => r.id)), now) })
  return result
}

// One pass at a time in the process, across config reloads.
let running = false

/** Called every minute by the daemon. Runs the pass that is due, if any. */
export async function checkinTick(deps: CheckinDeps, force?: PassKind): Promise<PassResult | null> {
  if (!deps.settings.enabled && !force) return null
  if (running) return null
  const now = deps.now ?? Date.now()
  const state = readCheckinState(deps.root)
  const due = force ? { kind: force, slot: "" } : checkinDue(deps.settings, state, now)
  if (!due) return null
  running = true
  try {
    // Recorded first: a pass that crashes must not rerun every minute.
    if (due.slot) {
      const { date } = localClock(now, deps.settings.timezone)
      writeCheckinState(deps.root, { ...state, lastSlot: due.slot, ...(due.kind === "daily" ? { lastDaily: date } : {}) })
    }
    const r = await runCheckinPass(deps, due.kind)
    deps.log(`[checkin] ${r.kind} pass: ${r.looked} open, ${r.carded.length} card(s), ${r.skipped} not needed, ${r.failed} failed`)
    return r
  } finally {
    running = false
  }
}
