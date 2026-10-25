import { randomBytes } from "crypto"
import { TEXT_MAX } from "./store"
import {
  SETTLED_ITEM_STATES, type ItemRecord, type LaneRecord, type NewLane, type SprintRecord, type SprintStore,
} from "./sprint-store"

// --- Sprint lanes: the daemon hands each lane its next item (#1241) ---
//
// A lead agent posts a sprint: lanes side by side, each with one agent and
// an ordered list of items. Once a minute, and as soon as a lane's turn
// ends, the daemon checks every active sprint:
//   1. A lane with no item running gets its next pending item, as a turn
//      on the lane's agent in the lane's own chat (sprint/<id>/<lane>).
//      Held items are passed over, with a note, until they are released.
//   2. When that turn ends the item is done and the lane moves on. A turn
//      that failed or was stopped blocks the lane: the owner is told, and
//      the lead or the owner retries or skips the item.
//   3. A lane idle with items left for longer than idleMinutes (an item
//      whose turn never reported its end, or only held items left) is
//      told to the owner once, until it moves again.
//   4. Every lane done: the sprint is done and the owner gets one summary.
// Every sprint and every lane is isolated: a failure is logged and the
// next one runs.

export interface SprintSettings {
  /** Sprints are recorded and followed. */
  enabled: boolean
  /** A lane idle with items left for this long is told to the owner. */
  idleMinutes: number
}

export const DEFAULT_SPRINT_SETTINGS: SprintSettings = { enabled: true, idleMinutes: 30 }

/** The chat a lane's turns run in. Not a channel with an adapter: the
 *  agent posts its results where the item lives (the issue, the PR). */
export const SPRINT_CHANNEL = "sprint"
export const MAX_LANES = 10
export const MAX_ITEMS = 50
const LANE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/
const REF_MAX = 300
const TITLE_MAX = 200
const MINUTE = 60_000

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export function newSprintId(): string {
  return `spr-${randomBytes(4).toString("hex")}`
}

/** One hand-out of an item: a turn's end settles the item only with it. */
export function newDispatchId(): string {
  return `d-${randomBytes(6).toString("hex")}`
}

/** The item a lane's turn works on, and which hand-out the turn is. */
export interface DispatchRef {
  sprintId: string
  lane: string
  idx: number
  dispatchId: string
}

export function laneChatId(sprintId: string, lane: string): string {
  return `${sprintId}/${lane}`
}

/** The sprint and lane a lane chat belongs to. Null: not a lane chat. */
export function parseLaneChat(chatId: string): { sprintId: string; lane: string } | null {
  const m = /^(spr-[0-9a-f]{4,16})\/([A-Za-z0-9][A-Za-z0-9_-]{0,23})$/.exec(chatId)
  return m ? { sprintId: m[1], lane: m[2] } : null
}

export function laneContext(sprintId: string, lane: string): { channel: string; chatId: string; sender: string } {
  return { channel: SPRINT_CHANNEL, chatId: laneChatId(sprintId, lane), sender: "sprint" }
}

export interface ParsedSprint {
  title: string
  ref: string | null
  idleMinutes: number | null
  lanes: NewLane[]
}

/** A sprint from what the lead sent. A string when it is malformed. */
export function parseSprint(input: Record<string, unknown>, hasAgent: (id: string) => boolean): ParsedSprint | string {
  const title = str(input.title)
  if (!title) return "start needs title: the sprint in a few words"
  if (title.length > TITLE_MAX) return `title is longer than ${TITLE_MAX} characters`
  const ref = str(input.ref) || null
  if (ref && ref.length > REF_MAX) return `ref is longer than ${REF_MAX} characters`
  let idleMinutes: number | null = null
  if (input.idleMinutes !== undefined && input.idleMinutes !== null && input.idleMinutes !== "") {
    const n = Number(input.idleMinutes)
    if (!Number.isFinite(n) || n < 1 || n > 7 * 24 * 60) return "idleMinutes must be a number of minutes from 1 to 10080"
    idleMinutes = n
  }
  if (!Array.isArray(input.lanes) || input.lanes.length === 0) return "start needs lanes: a list of {name, agent, items}"
  if (input.lanes.length > MAX_LANES) return `a sprint has at most ${MAX_LANES} lanes`
  const lanes: NewLane[] = []
  for (const [i, raw] of (input.lanes as any[]).entries()) {
    const lane = str(raw?.name ?? raw?.lane) || String.fromCharCode(65 + i)
    if (!LANE_RE.test(lane)) return `lane "${lane}": a lane name is a short word (letters, digits, - or _)`
    if (lanes.some((l) => l.lane === lane)) return `lane "${lane}" is named twice`
    const agentId = str(raw?.agent ?? raw?.agentId)
    if (!agentId) return `lane "${lane}" needs agent: the agent that works its items`
    if (!hasAgent(agentId)) return `lane "${lane}": agent "${agentId}" is not on this node`
    if (!Array.isArray(raw?.items) || raw.items.length === 0) return `lane "${lane}" needs items: the issues it works, in order`
    if (raw.items.length > MAX_ITEMS) return `lane "${lane}" has more than ${MAX_ITEMS} items`
    const items: NewLane["items"] = []
    for (const it of raw.items as unknown[]) {
      const o = typeof it === "string" ? { ref: it } : (it && typeof it === "object" ? it as Record<string, unknown> : {})
      const itemRef = str(o.ref)
      if (!itemRef) return `lane "${lane}": every item needs ref (an issue number or a link)`
      if (itemRef.length > REF_MAX) return `lane "${lane}": ref "${itemRef.slice(0, 40)}…" is longer than ${REF_MAX} characters`
      const brief = str(o.brief)
      const held = o.held === true ? "held when the sprint was made" : str(o.held)
      items.push({
        ref: itemRef,
        title: str(o.title).slice(0, TITLE_MAX) || null,
        brief: brief ? brief.slice(0, TEXT_MAX) : null,
        held: held || null,
      })
    }
    lanes.push({ lane, agentId, items })
  }
  return { title, ref, idleMinutes, lanes }
}

const itemName = (it: Pick<ItemRecord, "ref" | "title">) => (it.title ? `${it.ref} (${it.title})` : it.ref)

const isSettled = (it: ItemRecord) => SETTLED_ITEM_STATES.includes(it.state)

/** The turn that hands a lane its next item. */
export function dispatchText(s: SprintRecord, lane: LaneRecord, items: ItemRecord[], it: ItemRecord): string {
  const left = items.filter((x) => x.idx > it.idx && !isSettled(x)).map((x) => x.ref)
  return [
    `[Sprint ${s.id} "${s.title}", lane ${lane.lane}, item ${it.idx} of ${items.length}] Work on ${itemName(it)} now.`,
    s.ref ? `The sprint's plan: ${s.ref}.` : "",
    it.brief ?? "",
    "Post your result where the item lives (the issue or the pull request): nobody reads the reply to this turn.",
    `When your turn ends, AgentX hands lane ${lane.lane} its next item${left.length ? ` (${left.slice(0, 5).join(", ")}${left.length > 5 ? ", …" : ""})` : ": this is the last one"}.`,
    `If you cannot finish it, stop the lane with agentx_sprint {action:"block", id:"${s.id}", lane:"${lane.lane}", note:"<why>"}: the owner is told.`,
  ].filter(Boolean).join(" ")
}

function lineOf(it: ItemRecord): string {
  return `${it.idx}. ${itemName(it)} [${it.state}]${it.note && it.state !== "done" ? ` ${it.note}` : ""}`
}

/** The owner's message when a lane is blocked or idle. */
export function laneNoticeText(s: SprintRecord, lane: LaneRecord, items: ItemRecord[], why: string): string {
  return [
    `Sprint "${s.title}" (${s.id}), lane ${lane.lane} (${lane.agentId}): ${why}`,
    ...items.map(lineOf),
    `Move it on: agentx requests sprints ${s.id} --retry ${lane.lane}, --skip ${lane.lane}, or --release ${lane.lane}:<item>.`,
  ].join("\n")
}

export function sprintSummaryText(s: SprintRecord, lanes: LaneRecord[], items: ItemRecord[]): string {
  return [
    `Sprint "${s.title}" (${s.id}) is finished: ${items.filter((i) => i.state === "done").length} of ${items.length} items done.`,
    ...lanes.map((l) => `Lane ${l.lane} (${l.agentId}): ${items.filter((i) => i.lane === l.lane).map((i) => `${i.ref} ${i.state}`).join(", ")}`),
  ].join("\n")
}

export interface ItemEnd {
  error?: string
  errorKind?: string
  stopped?: boolean
  interrupted?: boolean
}

/** The item is running under this hand-out: the turn still owns it. */
function ownsItem(it: ItemRecord | null, ref: DispatchRef): it is ItemRecord {
  return !!it && it.state === "running" && it.dispatchId === ref.dispatchId
}

/** A lane's turn ended. Returns what happened to the item: "done" (the
 *  lane moves on), "blocked" (it failed or was stopped), or null (not the
 *  running item, or not this hand-out of it: it was retried, skipped or
 *  blocked since; or cut by a shutdown: the next boot may resume it). */
export function itemEnded(
  store: SprintStore,
  ref: DispatchRef,
  end: ItemEnd,
  now: number,
): "done" | "blocked" | null {
  const it = store.item(ref.sprintId, ref.lane, ref.idx)
  if (!ownsItem(it, ref)) return null
  if (end.interrupted || end.errorKind === "interrupted") {
    store.event(ref.sprintId, ref.lane, ref.idx, "interrupted", "the daemon stopped during the turn", now)
    return null
  }
  const stopped = end.stopped || end.errorKind === "stopped" || end.errorKind === "cancelled"
  if (end.error || stopped) {
    const why = stopped ? `its turn was stopped${end.error ? `: ${end.error}` : ""}` : `its turn failed: ${end.error}`
    if (!store.updateRunningItem(ref.sprintId, ref.lane, ref.idx, ref.dispatchId, { state: "failed", note: why.slice(0, 500), finishedAt: now })) return null
    store.updateLane(ref.sprintId, ref.lane, { state: "blocked", note: `${it.ref}: ${why}`.slice(0, 500), updatedAt: now, notifiedAt: null })
    store.event(ref.sprintId, ref.lane, ref.idx, "failed", why, now)
    return "blocked"
  }
  if (!store.updateRunningItem(ref.sprintId, ref.lane, ref.idx, ref.dispatchId, { state: "done", finishedAt: now })) return null
  store.updateLane(ref.sprintId, ref.lane, { updatedAt: now, notifiedAt: null })
  store.event(ref.sprintId, ref.lane, ref.idx, "done", "the turn ended", now)
  return "done"
}

/** The turn never started (no free slot in time): the item goes back to
 *  the queue, but only while this hand-out still owns it. False: it was
 *  retried, skipped or blocked since, and is left as it is. */
export function requeueItem(store: SprintStore, ref: DispatchRef, why: string, now: number): boolean {
  if (!store.updateRunningItem(ref.sprintId, ref.lane, ref.idx, ref.dispatchId, { state: "pending", dispatchedAt: null, dispatchId: null })) return false
  store.event(ref.sprintId, ref.lane, ref.idx, "requeued", why, now)
  return true
}

export type LaneAction = "retry" | "skip" | "hold" | "release" | "block"

/** The lead or the owner moves a lane on. `item` names one item by its
 *  number; without it the action applies to the lane's current item (the
 *  failed or running one, or for release the first held one). Returns an
 *  error in words, or null. */
export function laneAction(
  store: SprintStore,
  input: { sprintId: string; lane: string; action: LaneAction; item?: number; note?: string; by: string },
  now: number,
): string | null {
  const s = store.get(input.sprintId)
  if (!s) return `no sprint "${input.sprintId}"`
  if (s.state !== "active") return `sprint "${s.id}" is already ${s.state}`
  const lane = store.lane(s.id, input.lane)
  if (!lane) return `sprint "${s.id}" has no lane "${input.lane}"`
  const items = store.items(s.id, lane.lane)
  const note = (input.note ?? "").trim()
  const pick = (states: ItemRecord["state"][]) => input.item !== undefined
    ? items.find((i) => i.idx === input.item) ?? null
    : items.find((i) => states.includes(i.state)) ?? null
  const by = `${input.by}${note ? `: ${note}` : ""}`

  if (input.action === "block") {
    if (!note) return "block needs note: why the lane cannot go on"
    if (lane.state === "done") return `lane ${lane.lane} is already done`
    const running = items.find((i) => i.state === "running")
    if (running) store.updateItem(s.id, lane.lane, running.idx, { state: "failed", note: `blocked by ${by}`.slice(0, 500), finishedAt: now })
    store.updateLane(s.id, lane.lane, { state: "blocked", note: `${input.by}: ${note}`.slice(0, 500), updatedAt: now, notifiedAt: null })
    store.event(s.id, lane.lane, running?.idx ?? null, "blocked", by, now)
    return null
  }

  const it = pick(input.action === "release" ? ["held"] : input.action === "hold" ? ["pending"] : ["failed", "running"])
  if (!it) return input.item !== undefined ? `lane ${lane.lane} has no item ${input.item}` : `lane ${lane.lane} has no item to ${input.action}`
  const reopen = () => store.updateLane(s.id, lane.lane, { state: "active", note: null, updatedAt: now, notifiedAt: null })

  if (input.action === "retry") {
    if (!["failed", "running", "skipped"].includes(it.state)) return `item ${it.idx} is ${it.state}: only a failed, running or skipped item is retried`
    // A running item's turn may still be going: its end no longer counts,
    // since the next hand-out gets a new dispatch token.
    store.updateItem(s.id, lane.lane, it.idx, { state: "pending", note: null, dispatchedAt: null, dispatchId: null, finishedAt: null })
  } else if (input.action === "skip") {
    if (isSettled(it)) return `item ${it.idx} is already ${it.state}`
    store.updateItem(s.id, lane.lane, it.idx, { state: "skipped", note: `skipped by ${by}`.slice(0, 500), finishedAt: now })
  } else if (input.action === "hold") {
    if (it.state !== "pending") return `item ${it.idx} is ${it.state}: only a pending item is held`
    store.updateItem(s.id, lane.lane, it.idx, { state: "held", note: `held by ${by}`.slice(0, 500) })
  } else {
    if (it.state !== "held") return `item ${it.idx} is ${it.state}, not held`
    store.updateItem(s.id, lane.lane, it.idx, { state: "pending", note: null })
  }
  // Anything but a hold puts a blocked lane back to work.
  if (input.action !== "hold") reopen()
  store.event(s.id, lane.lane, it.idx, input.action, by, now)
  return null
}

/** Stop a sprint: no more items are handed out. A turn already running
 *  goes on. */
export function cancelSprint(store: SprintStore, sprintId: string, by: string, now: number): string | null {
  const s = store.get(sprintId)
  if (!s) return `no sprint "${sprintId}"`
  if (!store.finish(s.id, "cancelled", now)) return `sprint "${s.id}" is already ${s.state}`
  store.event(s.id, null, null, "cancelled", by, now)
  return null
}

export interface SprintSweepDeps {
  store: SprintStore
  settings: SprintSettings
  /** Start the lane's turn. Fire and forget: the check never waits on a
   *  model. The turn's end comes back through itemEnded. Throws when the
   *  turn could not even be asked for. */
  dispatch?: (agentId: string, text: string, ref: DispatchRef) => Promise<void>
  /** The lane's agent is in a turn in the lane's chat right now. */
  isBusy?: (agentId: string, sprintId: string, lane: string) => boolean
  hasAgent?: (agentId: string) => boolean
  /** Tell the owner. `key` makes a repeat of the same notice a no-op. */
  notify?: (title: string, message: string, s: SprintRecord, key: string) => Promise<void>
  log: (msg: string) => void
  now?: number
}

export interface SprintSweepResult {
  dispatched: number
  told: number
  finished: number
}

async function tellLane(deps: SprintSweepDeps, s: SprintRecord, lane: LaneRecord, why: string, kind: string, now: number, result: SprintSweepResult): Promise<void> {
  const { store } = deps
  if (lane.notifiedAt !== null || !deps.notify) return
  // Marked first: a notice that throws is not sent again every minute.
  store.updateLane(s.id, lane.lane, { notifiedAt: now })
  try {
    await deps.notify(`Sprint lane ${lane.lane} ${kind}: ${s.title}`, laneNoticeText(s, lane, store.items(s.id, lane.lane), why), s, `sprint:${s.id}:${lane.lane}:${kind}:${lane.updatedAt}`)
    store.event(s.id, lane.lane, null, "owner-told", `${kind}: ${why}`, now)
    result.told++
  } catch (e: any) {
    store.updateLane(s.id, lane.lane, { notifiedAt: null })
    deps.log(`[sprints] ${s.id} lane ${lane.lane}: couldn't tell the owner, will try again: ${e?.message ?? e}`)
  }
}

async function followLane(deps: SprintSweepDeps, s: SprintRecord, lane: LaneRecord, now: number, result: SprintSweepResult): Promise<void> {
  const { store } = deps
  if (lane.state === "done") return
  const idleMs = (s.idleMinutes ?? deps.settings.idleMinutes) * MINUTE
  if (lane.state === "blocked") {
    await tellLane(deps, s, lane, `blocked. ${lane.note ?? ""}`.trim(), "blocked", now, result)
    return
  }
  const items = store.items(s.id, lane.lane)
  const running = items.find((i) => i.state === "running")
  if (running) {
    // A turn whose end never came back (a restart it was not resumed
    // from, a lost event): told once, after the idle time, unless the
    // agent is still at it in the lane's chat.
    if (now - lane.updatedAt < idleMs) return
    if (deps.isBusy?.(lane.agentId, s.id, lane.lane)) return
    const since = new Date(running.dispatchedAt ?? lane.updatedAt).toISOString().slice(0, 16).replace("T", " ")
    await tellLane(deps, s, lane, `idle: ${running.ref} was handed out at ${since} UTC and its turn's end was never recorded.`, "idle", now, result)
    return
  }
  if (deps.hasAgent && !deps.hasAgent(lane.agentId)) {
    store.updateLane(s.id, lane.lane, { state: "blocked", note: `agent "${lane.agentId}" is not on this node`, updatedAt: now, notifiedAt: null })
    store.event(s.id, lane.lane, null, "blocked", `agent "${lane.agentId}" is not on this node`, now)
    return
  }
  const next = items.find((i) => i.state === "pending")
  if (!next) {
    const held = items.filter((i) => i.state === "held")
    if (held.length === 0) {
      store.updateLane(s.id, lane.lane, { state: "done", note: null, updatedAt: now })
      store.event(s.id, lane.lane, null, "lane-done", `${items.filter((i) => i.state === "done").length} of ${items.length} done`, now)
      return
    }
    if (now - lane.updatedAt >= idleMs) {
      await tellLane(deps, s, lane, `idle: only held items are left (${held.map((i) => i.ref).join(", ")}).`, "idle", now, result)
    }
    return
  }
  if (!deps.dispatch) return
  // Held items before it are passed over, with a note, once.
  for (const h of items.filter((i) => i.state === "held" && i.idx < next.idx && i.dispatchedAt === null)) {
    store.updateItem(s.id, lane.lane, h.idx, { dispatchedAt: now })
    store.event(s.id, lane.lane, h.idx, "passed-held", `${h.ref} is held${h.note ? ` (${h.note})` : ""}: ${next.ref} goes first`, now)
  }
  const ref: DispatchRef = { sprintId: s.id, lane: lane.lane, idx: next.idx, dispatchId: newDispatchId() }
  store.updateItem(s.id, lane.lane, next.idx, { state: "running", note: null, dispatchedAt: now, dispatchId: ref.dispatchId })
  store.updateLane(s.id, lane.lane, { updatedAt: now, notifiedAt: null })
  try {
    await deps.dispatch(lane.agentId, dispatchText(s, lane, items, { ...next, state: "running" }), ref)
    store.event(s.id, lane.lane, next.idx, "dispatched", `${next.ref} to ${lane.agentId}`, now)
    result.dispatched++
    deps.log(`[sprints] ${s.id} lane ${lane.lane}: ${next.ref} handed to ${lane.agentId}`)
  } catch (e: any) {
    itemEnded(store, ref, { error: `could not hand it to ${lane.agentId}: ${e?.message ?? e}` }, now)
  }
}

async function followSprint(deps: SprintSweepDeps, s: SprintRecord, now: number, result: SprintSweepResult): Promise<void> {
  const { store } = deps
  for (const lane of store.lanes(s.id)) {
    try {
      await followLane(deps, s, lane, now, result)
    } catch (e: any) {
      deps.log(`[sprints] ${s.id} lane ${lane.lane} failed: ${e?.message ?? e}`)
    }
  }
  const lanes = store.lanes(s.id)
  if (lanes.every((l) => l.state === "done") && store.finish(s.id, "done", now)) {
    store.event(s.id, null, null, "finished", `${lanes.length} lanes done`, now)
    result.finished++
    deps.log(`[sprints] ${s.id}: every lane finished`)
  }
}

async function tellFinished(deps: SprintSweepDeps, now: number): Promise<void> {
  const { store } = deps
  for (const s of store.awaitingSummary()) {
    store.markNotified(s.id, now)
    if (!deps.notify) continue
    try {
      await deps.notify(`Sprint finished: ${s.title}`, sprintSummaryText(s, store.lanes(s.id), store.items(s.id)), s, `sprint:${s.id}:finished`)
      store.event(s.id, null, null, "owner-told", "finished", now)
    } catch (e: any) {
      store.markNotified(s.id, null)
      deps.log(`[sprints] couldn't send the summary of ${s.id}, will try again: ${e?.message ?? e}`)
    }
  }
}

export async function runSprintSweep(deps: SprintSweepDeps): Promise<SprintSweepResult> {
  const now = deps.now ?? Date.now()
  const result: SprintSweepResult = { dispatched: 0, told: 0, finished: 0 }
  if (!deps.settings.enabled) return result
  try {
    for (const s of deps.store.listActive()) {
      try {
        await followSprint(deps, s, now, result)
      } catch (e: any) {
        deps.log(`[sprints] ${s.id} failed: ${e?.message ?? e}`)
      }
    }
  } catch (e: any) {
    deps.log(`[sprints] check failed: ${e?.message ?? e}`)
  }
  try { await tellFinished(deps, now) } catch (e: any) { deps.log(`[sprints] summaries failed: ${e?.message ?? e}`) }
  return result
}
