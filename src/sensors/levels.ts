import type { BatteryReading } from "./battery"
import type { SensorConfig, SensorLevel } from "./config"

// --- The battery levels, as a pure engine (#863) ---
//
// State in, a reading in, actions out; no timer, no I/O. The rules are
// devops-workspace's battery-watch.sh, line for line:
//
//   - A battery stretch starts at the first reading on battery and ends
//     when AC returns. Each agent level is sent once per stretch.
//   - Of the `below` levels that hold, only the lowest one not yet sent
//     goes; once it is sent, the higher ones count as sent too (14 % on the
//     first read sends the 15 % level, not the 50 % one as well).
//   - An urgent level (the model-free push) is independent of the wakes,
//     and re-arms only above `rearm.above` on AC: a short AC spell does not.
//   - A wake counts as sent only once its run has STARTED. Not started in
//     2 minutes (held) or failed: a Wall line, and the wake goes again at
//     the next reading. Only a `fallbackPush` level (the 15 % line) also
//     owes the model-free push, once per stretch, sent at once; the other
//     agent levels never push to the operator (the COO decides that).
//   - A push that fails is tried again at the next reading, the result
//     logged; only a push that went out counts.
//   - A reading that is not ok is never a crossing: one Wall line, again
//     only after a good reading.

export const HOLD_MS = 2 * 60_000

export interface LevelState {
  /** Sent this stretch (an urgent level: until re-armed). */
  sent?: boolean
  sentAt?: number
  /** A wake handed to the agent that has not started yet. */
  pending?: { since: number; seq: number }
  /** The text the last wake carried, for a fallbackPush level's push. */
  text?: string
  /** A held or failed wake was put on the Wall this stretch. */
  stuckTold?: boolean
  /** A fallbackPush level's model-free push: owed, or sent, this stretch. */
  fallback?: "owed" | "sent"
}

export interface SensorState {
  stretchStart: number | null
  levels: Record<string, LevelState>
  unavailableTold: boolean
  last?: { at: number } & BatteryReading
  seq: number
}

export type SensorAction =
  | { kind: "wake"; level: string; target: string; text: string; seq: number }
  | { kind: "abort"; level: string; seq: number }
  | { kind: "push"; level: string; text: string; fallback: boolean }
  | { kind: "wall"; text: string }
  | { kind: "log"; text: string }

export interface Step { state: SensorState; actions: SensorAction[] }

export function emptyState(): SensorState {
  return { stretchStart: null, levels: {}, unavailableTold: false, seq: 0 }
}

const clone = (s: SensorState): SensorState => ({ ...s, levels: Object.fromEntries(Object.entries(s.levels).map(([k, v]) => [k, { ...v, ...(v.pending ? { pending: { ...v.pending } } : {}) }])) })
const lv = (s: SensorState, id: string): LevelState => (s.levels[id] ??= {})
const minutesOn = (s: SensorState, now: number): number => (s.stretchStart === null ? 0 : Math.floor((now - s.stretchStart) / 60_000))

function holds(l: SensorLevel, r: { percent: number; onBattery: boolean }, onMin: number): boolean {
  if (!r.onBattery) return false
  if (l.when.forMinutes !== undefined && onMin < l.when.forMinutes) return false
  if (l.when.below !== undefined && !(r.percent < l.when.below)) return false
  return true
}

/** The words of a wake, as the script wrote them ("DevOps battery watch,
 *  URGENT" as the brief gives the script's 15 % line). */
export function wakeText(l: SensorLevel, percent: number, onMin: number): string {
  const lead = l.brief ? `${l.brief}: ` : ""
  if (l.when.below !== undefined) return `${lead}Mac on battery at ${percent}%, under the ${l.when.below}% line, ${onMin} min on battery.`
  return `${lead}Mac on battery for ${onMin} min, now ${percent}%.`
}

/** The words of an urgent level's push. */
export function pushText(l: SensorLevel, percent: number, onMin: number): string {
  const line = l.when.below !== undefined ? `, under the ${l.when.below}% line` : ""
  return `Mac on battery at ${percent}%${line}, ${onMin} min on battery. When it goes flat, every agent on it stops.`
}

/** Held wakes: not started within HOLD_MS. Dropped, put on the Wall, and
 *  sent again at the next reading; a fallbackPush level's push goes now. */
export function checkHolds(cfg: SensorConfig, state: SensorState, now: number, id = "battery"): Step {
  const s = clone(state)
  const actions: SensorAction[] = []
  for (const l of cfg.levels) {
    const st = s.levels[l.id]
    if (!st?.pending || st.sent || now - st.pending.since < HOLD_MS) continue
    actions.push({ kind: "abort", level: l.id, seq: st.pending.seq })
    st.pending = undefined
    actions.push(...stuck(id, l, st, `not started in ${Math.round(HOLD_MS / 60_000)} min`))
    if (st.fallback === "owed") actions.push(fallbackPush(l, st))
  }
  return { state: s, actions }
}

const fallbackPush = (l: SensorLevel, st: LevelState): SensorAction => ({ kind: "push", level: l.id, text: st.text ?? "", fallback: true })

/** A held or failed wake: one Wall line per level and stretch, the rest
 *  logged; a fallbackPush level owes its push. */
function stuck(id: string, l: SensorLevel, st: LevelState, why: string): SensorAction[] {
  const owes = l.fallbackPush && st.fallback !== "sent"
  if (owes) st.fallback = "owed"
  const line = `sensor ${id}: the ${l.id} wake to ${l.target} ${why}; ${owes ? "sending the urgent push instead, and " : ""}waking it again at the next reading`
  if (st.stuckTold) return [{ kind: "log", text: line }]
  st.stuckTold = true
  return [{ kind: "wall", text: line }]
}

/** One reading. */
export function step(cfg: SensorConfig, state: SensorState, reading: BatteryReading, now: number, id = "battery"): Step {
  const held = checkHolds(cfg, state, now, id)
  const s = held.state
  const actions = held.actions
  s.last = { at: now, ...reading }
  if (!reading.ok) {
    if (!s.unavailableTold) {
      s.unavailableTold = true
      actions.push({ kind: "wall", text: `battery reading unavailable: ${reading.why}` })
    } else actions.push({ kind: "log", text: `battery reading unavailable: ${reading.why}` })
    return { state: s, actions }
  }
  s.unavailableTold = false
  const { percent } = reading
  if (!reading.onBattery) {
    if (s.stretchStart !== null) actions.push({ kind: "log", text: `AC back at ${percent}%, stretch was ${minutesOn(s, now)} min` })
    s.stretchStart = null
    for (const l of cfg.levels) {
      const st = lv(s, l.id)
      if (l.urgent) {
        if (st.sent && percent > cfg.rearm.above && (!cfg.rearm.onAC || reading.onAC)) {
          st.sent = false
          actions.push({ kind: "log", text: `${l.id} push re-armed: on AC at ${percent}%` })
        }
        continue
      }
      if (st.pending) actions.push({ kind: "abort", level: l.id, seq: st.pending.seq })
      s.levels[l.id] = {}
    }
    return { state: s, actions }
  }
  if (s.stretchStart === null) {
    s.stretchStart = now
    actions.push({ kind: "log", text: `on battery at ${percent}%` })
  }
  const onMin = minutesOn(s, now)
  // The push first: it is independent of the wakes (script order).
  for (const l of cfg.levels.filter((x) => x.urgent)) {
    if (holds(l, reading, onMin) && !lv(s, l.id).sent) actions.push({ kind: "push", level: l.id, text: pushText(l, percent, onMin), fallback: false })
  }
  const wake = (l: SensorLevel) => {
    const st = lv(s, l.id)
    if (st.sent || st.pending) return
    s.seq += 1
    st.pending = { since: now, seq: s.seq }
    st.text = wakeText(l, percent, onMin)
    actions.push({ kind: "wake", level: l.id, target: l.target!, text: st.text, seq: s.seq })
  }
  // `below` wakes: the lowest that holds and is not sent, only.
  const below = cfg.levels.filter((x) => !x.urgent && x.when.below !== undefined).sort((a, b) => a.when.below! - b.when.below!)
  const first = below.find((l) => holds(l, reading, onMin) && !lv(s, l.id).sent)
  if (first) wake(first)
  for (const l of cfg.levels.filter((x) => !x.urgent && x.when.below === undefined)) {
    if (holds(l, reading, onMin)) wake(l)
  }
  // A fallback push still owed (it failed before): tried at every reading
  // until sent. Not twice in one step when the hold check above owed it.
  for (const l of cfg.levels) {
    const st = s.levels[l.id]
    if (st?.fallback !== "owed" || actions.some((a) => a.kind === "push" && a.fallback && a.level === l.id)) continue
    st.text ??= wakeText(l, percent, onMin)
    actions.push(fallbackPush(l, st))
  }
  return { state: s, actions }
}

/** The wake's run has started: the level is sent. A sent `below` level
 *  covers the higher `below` wakes of the stretch. */
export function started(cfg: SensorConfig, state: SensorState, levelId: string, now: number): Step {
  const s = clone(state)
  const l = cfg.levels.find((x) => x.id === levelId)
  const st = s.levels[levelId]
  if (!l || !st || st.sent || s.stretchStart === null) return { state: s, actions: [] }
  st.sent = true
  st.sentAt = now
  st.pending = undefined
  const actions: SensorAction[] = [{ kind: "log", text: `${levelId} wake to ${l.target} started` }]
  if (l.when.below !== undefined) {
    for (const h of cfg.levels) {
      if (h.urgent || h.when.below === undefined || h.when.below <= l.when.below) continue
      const hs = lv(s, h.id)
      if (hs.pending) actions.push({ kind: "abort", level: h.id, seq: hs.pending.seq })
      Object.assign(hs, { sent: true, sentAt: now, pending: undefined })
    }
  }
  return { state: s, actions }
}

/** The wake's run failed (before or after it started). Not sent: a Wall
 *  line, and the wake goes again at the next reading. */
export function failed(cfg: SensorConfig, state: SensorState, levelId: string, seq: number, why: string, id = "battery"): Step {
  const s = clone(state)
  const l = cfg.levels.find((x) => x.id === levelId)
  const st = s.levels[levelId]
  if (!l || !st || s.stretchStart === null || (st.pending && st.pending.seq !== seq)) return { state: s, actions: [] }
  st.sent = false
  st.pending = undefined
  const actions = stuck(id, l, st, `failed (${why.slice(0, 120)})`)
  if (st.fallback === "owed") actions.push(fallbackPush(l, st))
  return { state: s, actions }
}

/** What a push came to. Only a push that went out counts as sent. */
export function pushed(state: SensorState, levelId: string, fallback: boolean, result: { ok: true; reason: string } | { ok: false; why: string }): Step {
  const s = clone(state)
  const st = lv(s, levelId)
  if (!result.ok) return { state: s, actions: [{ kind: "log", text: `ERROR ${levelId} push failed, retry at the next reading: ${result.why}` }] }
  if (fallback) st.fallback = "sent"
  else st.sent = true
  return { state: s, actions: [{ kind: "log", text: `${levelId} push sent (${result.reason})` }] }
}
