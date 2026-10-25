import { isQueued } from "@/agents/queued"
import { OVERDUE_REASON, type RequestRecord, type RequestStore } from "./store"
import type { RequestSettings } from "./tracker"
import { checkLoops, waitsOn, waitsOnWords, when, type LoopChecker } from "./loops"
import { DEFAULT_CHECKER_SETTINGS } from "./checkers"
import { cardWords } from "./card-view"
import { goalLine } from "./goals"

// --- The daemon's requests check, once a minute (#356) ---
//
//   0. Evidence (#1039): an open loop with a `close_when` has its checker
//      run every `checkers.checkEveryMinutes`. Met closes it as done, with
//      the checker's evidence.
//   1. Settle (#1138): a request in progress, quiet for `staleAfterHours`,
//      whose handed work all came back done, closes as done with the link
//      its delegate gave, or marked unproven without one. The owner is not
//      told: the work came back, and its record leaves their list.
//      A due time does not keep it open: the agent set it, from its own
//      estimate or wait (#1214). One already raised for being overdue
//      settles the same way once its work has been back that long.
//      `settleHandedBack: false` raises it as quiet instead, as before.
//   2. Quiet: an open request nothing has touched for `staleAfterHours`
//      needs attention. So does a candidate that old: its turn never
//      reported an end. A loop with a due time needs attention once it is
//      past it instead, unless its handed work all came back done: that
//      one waits to settle. A request waiting on the owner is left alone; its
//      question is what reminds them.
//   3. Tell once: every request that needs attention is sent to the owner
//      one time. After that it is only listed. A notice that could not be
//      sent at all is tried again at the next check. This is the one
//      escalation of every loop (#1138 D): a blocked plan step, a task
//      watcher that fired, a wait that ran out, a promise not kept.
//   4. Pick-ups: a request the owner said to pick up again is handed back
//      to its agent as a new turn, once.
//   5. Retention: closed requests older than `retentionDays` are deleted.
//      Open requests never age out.
//
// Every step is isolated: a failure is logged and the next step runs.

export interface RequestSweepDeps {
  store: RequestStore
  settings: RequestSettings
  /** Tell the owner, through the daemon's notify path. `kind` "notice"
   *  when a loop's own words say it must not wait for the digest. */
  notify?: (title: string, message: string, request: RequestRecord, kind?: "notice") => Promise<void>
  /** A loop's own words for its notice, when it has them: a tracked plan
   *  with a blocked step (planNotice). `told` runs once it went out. */
  noticeFor?: (r: RequestRecord) => { title: string; text: string; kind?: "notice"; told?: (now: number) => void } | null
  /** Start a turn on the agent for a request the owner said to pick up
   *  again. Fire and forget: the check never waits on a model. */
  tellAgent?: (agentId: string, text: string, request: RequestRecord) => Promise<void>
  hasAgent?: (agentId: string) => boolean
  /** The request has an active tracked plan (#788): never settled here. */
  inPlan?: (requestId: string) => boolean
  /** Runs a loop's checker (#1039). Unset: loops are not checked. */
  check?: LoopChecker
  /** Gives a request its headline when it has none (#1126), so the owner
   *  is told what it is. Returns it as it is when none could be written. */
  describe?: (r: RequestRecord) => Promise<RequestRecord>
  /** Writes missing headlines of other open requests in the background. */
  fillHeadlines?: () => Promise<unknown>
  log: (msg: string) => void
  now?: number
}

export interface RequestSweepResult {
  /** Loops whose checker ran, and those it closed. */
  checked: number
  verified: number
  /** Quiet requests whose handed work came back done, closed (#1138). */
  settled: number
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
    ...goalLine(r.goal),
    ...(r.ownerNote && !r.noteSaid ? ["What they say now:", r.ownerNote, ""] : []),
    `Do the work now. ${report} When it is finished, close it with agentx_request: {action:"done", id:"${r.id}", evidence:"<link>"}. If you will not do it, use decline with the reason.`,
  ].join("\n")
}

const HOUR = 3_600_000
/** Time one check may spend writing headlines before it tells the owner. */
export const DESCRIBE_BUDGET_MS = 45_000

/** The notice's title (#1126): what the request is, then that it stopped. */
export function attentionTitle(r: RequestRecord): string {
  const { headline } = cardWords(r, 80)
  return `${r.promise ? "Promise not kept" : "Not finished"}: ${headline}`
}

export function attentionText(r: RequestRecord, isAgent: (id: string) => boolean = () => false): string {
  const words = r.text.replace(/\s+/g, " ").trim()
  const said = words.length > 240 ? `${words.slice(0, 239)}…` : words
  const on = waitsOn(r, { isAgent })
  return [
    r.promise
      ? `A promise ${r.agentId} made to ${r.owedTo} is not kept yet.`
      : `A request you gave ${r.agentId} on ${r.channel} is not finished.`,
    `What happened: ${r.attentionReason ?? "unknown"}`,
    `Waiting on: ${waitsOnWords(on.group, on.who)}`,
    ...(r.verifyState === "unverified" && r.verifyDetail ? [`Its check could not say: ${r.verifyDetail}`] : []),
    "Nothing is retrying it.",
    r.closeWhen
      ? `Needed from you: hand it back to ${r.agentId}, close it by hand with a reason, or drop it.`
      : `Needed from you: ${cardWords(r).need}`,
    // The owner's own words last, under the headline the title carries.
    r.promise ? `It promised: ${said}` : `You said: ${said}`,
  ].join("\n")
}

export async function runRequestsSweep(deps: RequestSweepDeps): Promise<RequestSweepResult> {
  const { store, settings, log } = deps
  const now = deps.now ?? Date.now()
  const result: RequestSweepResult = { checked: 0, verified: 0, settled: 0, quiet: 0, notified: 0, pruned: 0, pickedUp: 0 }
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

  if (settings.settleHandedBack !== false) {
    try {
      for (const r of store.handedBack(now - settings.staleAfterHours * HOUR)) {
        // A tracked plan follows its own steps and tells the owner itself.
        if (deps.inPlan?.(r.id)) continue
        const back = store.handBackProof(r.id)
        const detail = back
          ? `The work it handed on came back done with ${back.proof}; nobody closed it in ${settings.staleAfterHours} h.`
          : `The work it handed on came back done without a link to proof; nobody closed it in ${settings.staleAfterHours} h.`
        if (store.settle(r.id, back?.proof ?? null, detail, now)) {
          result.settled++
          log(`[requests] ${r.id} settled: ${back ? `handed work came back with ${back.proof}` : "handed work came back, unproven"}`)
        }
      }
    } catch (e: any) {
      log(`[requests] settle failed: ${e?.message ?? e}`)
    }
  }

  try {
    const hours = settings.staleAfterHours
    for (const r of store.quietSince(["candidate", "in_progress", "waiting_other"], now - hours * HOUR)) {
      const reason = r.state === "candidate"
        ? `The turn that received it never reported an end (${hours} h ago or more)`
        : `No activity for ${hours} h`
      if (store.needsAttention(r.id, reason, now)) result.quiet++
    }
    const settling = settings.settleHandedBack !== false
    for (const r of store.overdue(now, now - hours * HOUR)) {
      // Back done, and settled once quiet: no "Not finished" before that (#1214).
      if (settling && r.state === "in_progress" && !deps.inPlan?.(r.id) && store.cameBack(r.id)) continue
      if (store.needsAttention(r.id, `${OVERDUE_REASON} (${when(r.dueAt!)})`, now)) result.quiet++
    }
  } catch (e: any) {
    log(`[requests] quiet check failed: ${e?.message ?? e}`)
  }

  try {
    // Headlines get a share of the check, not all of it: past the budget
    // a notice goes out with the owner's words, and the background fill
    // writes its headline later.
    let describing = 0
    for (const r of store.awaitingNotice()) {
      // Marked first: a notice that hangs must not be sent twice.
      store.markNotified(r.id, now)
      if (!deps.notify) continue
      try {
        // Told what it is, not only that it stopped (#1126).
        let described = r
        if (deps.describe && describing < DESCRIBE_BUDGET_MS) {
          const started = Date.now()
          described = await deps.describe(r)
          describing += Date.now() - started
        }
        const own = deps.noticeFor?.(described) ?? null
        if (own) {
          await deps.notify(own.title, own.text, described, own.kind)
          own.told?.(now)
        } else await deps.notify(attentionTitle(described), attentionText(described, deps.hasAgent), described)
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

  // Not awaited: the check never waits on a model for requests nobody
  // is being told about right now.
  if (deps.fillHeadlines) void deps.fillHeadlines().catch((e: any) => log(`[requests] headlines failed: ${e?.message ?? e}`))

  try {
    result.pruned = store.pruneClosed(now - settings.retentionDays * 24 * HOUR)
  } catch (e: any) {
    log(`[requests] retention failed: ${e?.message ?? e}`)
  }
  return result
}
