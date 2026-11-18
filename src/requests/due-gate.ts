import { askSeat, getSeatMode, recordSeatOutcome } from "@/decisions/seat"
import { ASK_AT, commitsDueTime, DUE_TIME_SEAT, dueTimeOwner, dueTimeQuestions, dueTimeState } from "@/decisions/seats/due-time"
import type { SeatMode } from "@/decisions/store"
import { openPromise } from "./promise"
import { OPEN_STATES, OWED_TO_OWNER, type RequestStore } from "./store"

// --- A due time an agent writes gets a record, so a wake stands behind it (#1908) ---
//
// At the end of each agent run the `due-time` seat reads the run's final
// reply and the notes it posted, and says whether the text sets a due
// time that this agent owes. Then, by the seat's mode:
//
//   off     nothing happens (the default)
//   shadow  one row is recorded per finished run, with what the gate
//           would have done; nothing else changes
//   active  when the seat says yes and nothing with a due time was
//           recorded in the run (a promise, a request's due time, a job's
//           wake, a plan step's wait), the agent is asked once, in the
//           same session: record it, or say there is none. Still nothing:
//           the run's request is marked as needing attention, and the
//           requests check tells the owner once.
//
// The seat only judges yes or no. The time itself comes from the record
// the agent makes (agentx_request promise, with due and closeWhen): the
// daemon reads no time out of prose here.
//
// Never throws, and never holds the run's answer: the registry calls it
// after the answer is on its way.

/** The one question a run that set a due time and recorded none gets. */
export const DUE_TIME_ASK =
  "[Due time] Your last reply or a note you posted sets a due time that you owe, and nothing is recorded for it, so nothing will wake you when it comes. " +
  "Record it now with the agentx_request tool: {action:\"promise\", owedTo:\"<who waits on it>\", text:\"<what you owe>\", due:\"<ISO time>\", closeWhen:{…}}. " +
  "If you set no due time, reply with the one line `Due: none`. Do not redo or continue the work in this turn."

/** The agent's answer that it set no due time. */
const SAYS_NONE = /^[\s>`*_•-]*due(?:\s+time)?[`*_]*\s*:[\s`*_]*none\b/im

export function saysNoDueTime(reply: string | undefined): boolean {
  return !!reply && SAYS_NONE.test(reply)
}

/** Why the run's request needs attention when no record was made. */
export const DUE_UNRECORDED_REASON = "Set a due time and recorded none"

export interface DueRun {
  agentId: string
  channel: string
  chatId: string
  /** The run's trace id, then its running id. */
  runIds: string[]
  startedAt: number
  /** The run's final reply. */
  reply: string
}

export interface DueSeatAnswer {
  /** P(the run set a due time its agent owes). */
  commits: number
  owner: string | null
  callId: string | null
}

export type DueGateOutcome =
  | "off"
  /** The seat gave no answer (backend down, timeout): nothing changes. */
  | "no-answer"
  /** Shadow mode: the row is recorded, nothing else. */
  | "shadow"
  | "no-commitment"
  /** A due time was recorded in the run itself: no ask. */
  | "recorded"
  | "recorded-when-asked"
  | "none-when-asked"
  | "stalled"

export interface DueGateDeps {
  store: RequestStore
  /** What the agent posted while the run ran, from its trace. Unset: none. */
  notes?: (runIds: string[]) => string[]
  /** Something else with a due time was made in the run (a schedule). */
  alsoRecorded?: (run: DueRun) => boolean
  /** The seat's mode. Unset: read from the decisions settings. */
  mode?: () => SeatMode
  /** The seat's answer for a run. Unset: askSeat. */
  ask?: (run: DueRun, notes: string[], recorded: boolean) => Promise<DueSeatAnswer | null>
  log: (msg: string) => void
  now?: () => number
}

/** One short turn in the run's own session. Resolves with its reply. */
export type AskAgent = (text: string) => Promise<{ reply?: string; error?: string }>

const NOTE_WORDS = /\b(?:comment|note|notes|reply|post|message|send)\b/i
const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/** The tool calls of a run that post something, as text for the seat. */
export function postedNotes(calls: Array<{ action: string | null; inputSummary: string | null }>): string[] {
  return calls
    .filter((c) => c.inputSummary && NOTE_WORDS.test(`${c.action ?? ""} ${c.inputSummary}`))
    .map((c) => `${c.action ?? "tool"}: ${c.inputSummary}`)
}

/** The schedule tool, by the end of its name: a trace keeps the name with
 *  the server's prefix. */
const SCHEDULE_TOOL = /(?:^|_)schedule$/

/** Did the run make or resume a schedule? Its own firing stands behind
 *  the time, so the gate does not ask. */
export function madeSchedule(calls: Array<{ action: string | null; inputSummary: string | null }>): boolean {
  return calls.some((c) => SCHEDULE_TOOL.test(c.action ?? "") && !/"action"\s*:\s*"(?:list|pause|delete)"/.test(c.inputSummary ?? ""))
}

async function seatAnswer(run: DueRun, notes: string[], recorded: boolean, now: number): Promise<DueSeatAnswer | null> {
  const res = await askSeat(
    DUE_TIME_SEAT,
    dueTimeState({ agent: run.agentId, channel: run.channel, reply: run.reply, notes, now: new Date(now).toISOString() }),
    dueTimeQuestions,
    {
      links: run.runIds.slice(0, 1).map((id) => ({ kind: "task", id })),
      features: { agent: run.agentId, channel: run.channel, recorded, notes: notes.length },
    },
  )
  if (!res) return null
  return { commits: commitsDueTime(res.answers), owner: dueTimeOwner(res.answers), callId: res.callId }
}

export class DueTimeGate {
  constructor(private deps: DueGateDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private recorded(run: DueRun): boolean {
    return this.deps.store.dueRecordedSince(run.agentId, run.startedAt) || !!this.deps.alsoRecorded?.(run)
  }

  /** A run ended cleanly with a reply. Never throws. */
  async runEnded(run: DueRun, askAgent?: AskAgent): Promise<DueGateOutcome> {
    try {
      return await this.decide(run, askAgent)
    } catch (e: any) {
      this.deps.log(`[due-time] ${run.agentId} ${run.runIds[0] ?? "-"}: check failed: ${e?.message ?? e}`)
      return "no-answer"
    }
  }

  private async decide(run: DueRun, askAgent?: AskAgent): Promise<DueGateOutcome> {
    const mode = (this.deps.mode ?? (() => getSeatMode(DUE_TIME_SEAT)))()
    if (mode === "off" || !run.reply.trim()) return "off"
    let notes: string[] = []
    try { notes = this.deps.notes?.(run.runIds) ?? [] } catch { /* the seat reads the reply alone */ }
    const recorded = this.recorded(run)
    const answer = await (this.deps.ask ?? ((r, n, rec) => seatAnswer(r, n, rec, this.now())))(run, notes, recorded)
    if (!answer) return "no-answer"
    const commits = Number.isFinite(answer.commits) && answer.commits >= ASK_AT
    // What the gate does, or in shadow would do: ask ("review") or not.
    recordSeatOutcome(answer.callId, commits && !recorded ? "review" : "skip")
    const where = `${run.agentId} ${run.channel} ${run.runIds[0] ?? "-"}`
    if (mode === "shadow") return "shadow"
    if (!commits) return "no-commitment"
    if (recorded) {
      this.deps.log(`[due-time] ${where}: set a due time and recorded it`)
      return "recorded"
    }
    this.deps.log(`[due-time] ${where}: set a due time (owed by ${answer.owner ?? "?"}) and recorded none; asking once`)
    let asked: { reply?: string; error?: string } = { error: "no way to ask the agent" }
    if (askAgent) {
      try { asked = await askAgent(DUE_TIME_ASK) } catch (e: any) { asked = { error: e?.message ?? String(e) } }
    }
    if (this.recorded(run)) {
      this.deps.log(`[due-time] ${where}: recorded when asked`)
      return "recorded-when-asked"
    }
    if (!asked.error && saysNoDueTime(asked.reply)) {
      this.deps.log(`[due-time] ${where}: said there is none when asked`)
      return "none-when-asked"
    }
    this.stall(run, asked.error)
    return "stalled"
  }

  /** Nothing was recorded, even when asked: the run's request needs
   *  attention, and the requests check tells the owner once. A run with
   *  no open request gets a promise of its own, raised the same way. */
  private stall(run: DueRun, error: string | undefined): void {
    const { store } = this.deps
    const now = this.now()
    const reason = `${DUE_UNRECORDED_REASON}: ${run.agentId} wrote a due time in its reply or a note, and recorded nothing for it when asked` +
      `${error ? ` (${clip(error, 120)})` : ""}. Nothing will wake it at that time. It said: ${clip(tailOf(run.reply), 300)}`
    // The run's own request when it still follows the work (a candidate
    // is the owner's turn, kept by this); else a promise of the agent's
    // own, with no wake: it needs attention now.
    const own = run.runIds.map((ref) => store.byLink("run", ref))
      .find((r) => !!r && (r.state === "candidate" || (OPEN_STATES as readonly string[]).includes(r.state)))
    const id = own?.id ?? openPromise(store, {
      agentId: run.agentId, owedTo: OWED_TO_OWNER, channel: run.channel, chatId: run.chatId,
      text: `Record the due time set in this reply: ${clip(tailOf(run.reply), 400)}`,
      headline: "A due time with no record", wake: false, now,
    }).id
    const raised = store.needsAttention(id, reason, now)
    this.deps.log(`[due-time] ${run.agentId} ${run.channel} ${run.runIds[0] ?? "-"}: nothing recorded when asked; ${id} ${own ? "" : "opened and "}` +
      `${raised ? "needs attention" : "already needed attention"}`)
  }
}

/** The end of a reply: where a due time is stated. */
function tailOf(reply: string): string {
  const t = reply.trim()
  return t.length > 600 ? t.slice(-600) : t
}
