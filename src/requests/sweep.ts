import { isQueued } from "@/agents/queued"
import type { RequestRecord, RequestStore } from "./store"
import type { RequestSettings } from "./tracker"
import { checkLoops, waitsOn, waitsOnWords, when, type LoopChecker } from "./loops"
import { DEFAULT_CHECKER_SETTINGS } from "./checkers"

// --- The daemon's requests check, once a minute (#356) ---
//
//   0. Evidence (#1039): an open loop with a `close_when` has its checker
//      run every `checkers.checkEveryMinutes`. Met closes it as done, with
//      the checker's evidence.
//   1. Quiet: an open request nothing has touched for `staleAfterHours`
//      needs attention. So does a candidate that old: its turn never
//      reported an end. A loop with a due time needs attention once it is
//      past it instead. A request waiting on the owner is left alone; its
//      question is what reminds them.
//   2. Tell once: every request that needs attention is sent to the owner
//      one time. After that it is only listed. A notice that could not be
//      sent at all is tried again at the next check.
//   3. Pick-ups: a request the owner said to pick up again is handed back
//      to its agent as a new turn, once.
//   4. Retention: closed requests older than `retentionDays` are deleted.
//      Open requests never age out.
//
// Every step is isolated: a failure is logged and the next step runs.

export interface RequestSweepDeps {
  store: RequestStore
  settings: RequestSettings
  /** Tell the owner, through the daemon's notify path. */
  notify?: (title: string, message: string, request: RequestRecord) => Promise<void>
  /** Start a turn on the agent for a request the owner said to pick up
   *  again. Fire and forget: the check never waits on a model. */
  tellAgent?: (agentId: string, text: string, request: RequestRecord) => Promise<void>
  hasAgent?: (agentId: string) => boolean
  /** Runs a loop's checker (#1039). Unset: loops are not checked. */
  check?: LoopChecker
  log: (msg: string) => void
  now?: number
}

export interface RequestSweepResult {
  /** Loops whose checker ran, and those it closed. */
  checked: number
  verified: number
  quiet: number
  notified: number
  pruned: number
  pickedUp: number
}

/** The pick-up turn ended. A turn that started is followed through its
 *  run events; one that never started (agent busy, message dropped, rate
 *  limit) reports only here, so the request comes back instead of sitting
 *  in progress until the quiet check. A request already raised keeps its
 *  first reason. */
export function pickupEnded(store: RequestStore, r: RequestRecord, res: { error?: string } | undefined | null, now: number): boolean {
  // "__queued__" is not a failure: the agent is busy on this request's
  // chat, the message was accepted, and the queue flush runs it when the
  // current turn ends. That turn keeps the pick-up mark, so it is linked
  // to the request then (#392).
  if (!res?.error || isQueued(res.error)) return false
  // The agent never read the owner's note: the next pick-up says it.
  if (r.ownerNote && !r.noteSaid) store.setNoteSaid(r.id, r.ownerNote, false)
  return store.needsAttention(r.id, `Could not hand it back to ${r.agentId}: ${res.error}`, now)
}

/** What the agent is told when the owner says "pick it up again", or
 *  hands the request to it. The chat it was asked in belongs to the agent
 *  that was asked: another agent may have no way to write there (another
 *  bot's chat, a voice turn), so it is told to answer in this turn, which
 *  the request's card shows as the last answer (#481). */
export function pickupText(r: RequestRecord): string {
  const first = r.askedAgent && r.askedAgent !== r.agentId ? r.askedAgent : null
  const asked = `on ${r.channel} (chat ${r.chatId}) on ${new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC and was not finished.`
  const report = first
    ? `That chat is ${first}'s: you may have no way to write there, so do not report in it. Give your report as the answer to this turn: the owner reads it on the request's card. If you have a chat of your own with them, you can report there as well.`
    : "Report to them in that chat."
  return [
    `[agentx:request-pickup id=${r.id}]`,
    first
      ? `The owner handed this request to you. It was asked of ${first} ${asked}`
      : `The owner asked you to pick this request up again. It was asked ${asked}`,
    "",
    "What they asked:",
    r.text,
    "",
    ...(r.ownerNote && !r.noteSaid ? ["What they say now:", r.ownerNote, ""] : []),
    `Do the work now. ${report} When it is finished, close it with agentx_request: {action:"done", id:"${r.id}", evidence:"<link>"}. If you will not do it, use decline with the reason.`,
  ].join("\n")
}

const HOUR = 3_600_000

export function attentionText(r: RequestRecord, isAgent: (id: string) => boolean = () => false): string {
  const words = r.text.replace(/\s+/g, " ").trim()
  const said = words.length > 240 ? `${words.slice(0, 239)}…` : words
  const on = waitsOn(r, { isAgent })
  // The headline and what is needed come first (#1126): a banner that
  // shows two lines shows what it is. The owner's own words come below.
  return [
    ...(r.headline ? [r.headline] : []),
    ...(r.need ? [`Needed from you: ${r.need}`] : []),
    r.promise
      ? `A promise ${r.agentId} made to ${r.owedTo} is not kept yet.`
      : `A request you gave ${r.agentId} on ${r.channel} is not finished.`,
    r.promise ? `It promised: ${said}` : `You said: ${said}`,
    `What happened: ${r.attentionReason ?? "unknown"}`,
    `Waiting on: ${waitsOnWords(on.group, on.who)}`,
    ...(r.verifyState === "unverified" && r.verifyDetail ? [`Its check could not say: ${r.verifyDetail}`] : []),
    r.closeWhen
      ? "Nothing is retrying it. Ask again, close it by hand with a reason, or drop it."
      : "Nothing is retrying it. Ask again, or drop it.",
  ].join("\n")
}

export async function runRequestsSweep(deps: RequestSweepDeps): Promise<RequestSweepResult> {
  const { store, settings, log } = deps
  const now = deps.now ?? Date.now()
  const result: RequestSweepResult = { checked: 0, verified: 0, quiet: 0, notified: 0, pruned: 0, pickedUp: 0 }
  if (!settings.enabled) return result

  if (deps.check) {
    try {
      const every = (settings.checkers ?? DEFAULT_CHECKER_SETTINGS).checkEveryMinutes
      const r = await checkLoops(store, deps.check, { everyMinutes: every, now, log })
      result.checked = r.checked
      result.verified = r.closed
    } catch (e: any) {
      log(`[requests] loop checks failed: ${e?.message ?? e}`)
    }
  }

  try {
    // takePickups clears the mark first: a turn that hangs or fails is not started twice.
    for (const r of store.takePickups()) {
      if (!deps.tellAgent || (deps.hasAgent && !deps.hasAgent(r.agentId))) {
        store.needsAttention(r.id, `Could not hand it back: agent "${r.agentId}" is not on this node`, now)
        continue
      }
      // Said once (#480): a later pick-up without new words does not repeat
      // it. Marked before the call, so a start that fails at once takes the
      // mark back after it is set, not before (#485).
      const says = r.ownerNote && !r.noteSaid ? r.ownerNote : null
      if (says) store.setNoteSaid(r.id, says, true)
      try {
        await deps.tellAgent(r.agentId, pickupText(r), r)
        result.pickedUp++
      } catch (e: any) {
        if (says) store.setNoteSaid(r.id, says, false)
        store.needsAttention(r.id, `Could not hand it back to ${r.agentId}: ${e?.message ?? e}`, now)
      }
    }
  } catch (e: any) {
    log(`[requests] pick-ups failed: ${e?.message ?? e}`)
  }

  try {
    const hours = settings.staleAfterHours
    for (const r of store.quietSince(["candidate", "in_progress", "waiting_other"], now - hours * HOUR)) {
      const reason = r.state === "candidate"
        ? `The turn that received it never reported an end (${hours} h ago or more)`
        : `No activity for ${hours} h`
      if (store.needsAttention(r.id, reason, now)) result.quiet++
    }
    for (const r of store.overdue(now, now - hours * HOUR)) {
      if (store.needsAttention(r.id, `Past its due time (${when(r.dueAt!)})`, now)) result.quiet++
    }
  } catch (e: any) {
    log(`[requests] quiet check failed: ${e?.message ?? e}`)
  }

  try {
    for (const r of store.awaitingNotice()) {
      // Marked first: a notice that hangs must not be sent twice.
      store.markNotified(r.id, now)
      if (!deps.notify) continue
      try {
        await deps.notify(r.promise ? "Promise not kept" : "Request not finished", attentionText(r, deps.hasAgent), r)
        result.notified++
      } catch (e: any) {
        // Nothing reached the owner: try again at the next check.
        store.markNotified(r.id, null)
        log(`[requests] couldn't tell the owner about ${r.id}, will try again: ${e?.message ?? e}`)
      }
    }
  } catch (e: any) {
    log(`[requests] notices failed: ${e?.message ?? e}`)
  }

  try {
    result.pruned = store.pruneClosed(now - settings.retentionDays * 24 * HOUR)
  } catch (e: any) {
    log(`[requests] retention failed: ${e?.message ?? e}`)
  }
  return result
}
