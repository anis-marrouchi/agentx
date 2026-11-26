import { isQueued } from "@/agents/queued"
import { workHint } from "./work-hint.js"
import { OVERDUE_REASON, WALL_CHANNEL, type RequestRecord, type RequestStore } from "./store"
import type { RequestSettings } from "./tracker"
import { checkLoops, waitsOn, waitsOnWords, when, type LoopChecker } from "./loops"
import { checkHomes, type HomeChecker, type PlanStepLeft } from "./home-check"
import { DEFAULT_CLOSE_PROOF, deliverablesOf, type CloseProofCtx } from "./close-proof"
import { DEFAULT_CHECKER_SETTINGS } from "./checkers"
import { cardWords } from "./card-view"
import { wokenAgent, wokenTail } from "./owner-check"
import { goalLine } from "./goals"
import { DEFAULT_RESEND, resendLine, resendVerdict, type ResendCause } from "./resend"
import { HUB_NAME } from "@/daemon/ui/hub-name"
import { JOB_NOTE_MAX } from "@/jobs/store"
import { DEFAULT_PROMISE_SETTINGS } from "./promise"
import { DEFAULT_PROOF_CHECK, type ProofChecker } from "./proof-check"
import { missedPr, PR_LEAD_AFTER_MS, PR_LEAD_WINDOW_MS, prDueText, prLeadText } from "./pr-due"

// --- The daemon's requests check, once a minute (#356) ---
//
//   0. Evidence (#1039): an open loop with a `close_when` has its checker
//      run every `checkers.checkEveryMinutes`. Met closes it as done, with
//      the checker's evidence. An open request with no checker whose home
//      is an issue or merge request has that home read as often: merged,
//      or closed as completed, closes it as done (#1522, home-check.ts).
//      `homeCloses: false` turns that off.
//   1. Settle (#1138): a request in progress, quiet for `staleAfterHours`,
//      whose handed work all came back done, closes as done with the link
//      its delegate gave. The owner is not told: the work came back, and
//      its record leaves their list. Without a link it stays open
//      (noqta#884): its agent is woken once per hand-back to bring the
//      proof, and it comes back as quiet if none follows.
//      A due time does not keep it open: the agent set it, from its own
//      estimate or wait (#1214). One already raised for being overdue
//      settles the same way once its work has been back that long.
//      `settleHandedBack: false` raises it as quiet instead, as before.
//      A hand-off that failed or was lost no longer holds it once a later
//      one came back done (#1522).
//   1c. Missed PR (#2279, pr-due.ts): a due promise whose words name a PR
//      and that has none linked wakes its agent with the issue, through
//      its job's wake or else a turn of its own; 15 min after that push,
//      still open with no PR, the lead (`promises.prLead`) is woken once.
//   2. Quiet: an open request nothing has touched for `staleAfterHours`
//      needs attention. So does a candidate that old: its turn never
//      reported an end. A loop with a due time needs attention once it is
//      past it instead, unless its handed work all came back done: that
//      one waits to settle. A request waiting on the owner is left alone; its
//      question is what reminds them.
//   2b. Resend once (#1542, resend.ts): a request stopped by a usage
//      limit or a restart goes back to its agent once, on the pick-up
//      path, after `autoResend.afterMinutes` and, for a limit, once no
//      limit hold is active. Its notice is held meanwhile, up to
//      `autoResend.holdMaxHours`. Runs before the pick-ups, so the resend
//      is sent by this same check.
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
  notify?: (title: string, message: string, request: RequestRecord, kind?: "notice", key?: string) => Promise<void>
  /** A loop's own words for its notice, when it has them: a tracked plan
   *  with a blocked step (planNotice). `told` runs once it went out. */
  noticeFor?: (r: RequestRecord) => { title: string; text: string; kind?: "notice"; told?: (now: number) => void } | null
  /** Start a turn on the agent for a request the owner said to pick up
   *  again. Fire and forget: the check never waits on a model. */
  tellAgent?: (agentId: string, text: string, request: RequestRecord) => Promise<void>
  hasAgent?: (agentId: string) => boolean
  /** The request has an active tracked plan (#788): never settled here. */
  inPlan?: (requestId: string) => boolean
  /** A usage-limit hold is active (#1542): a request a limit stopped is
   *  not resent until it lifts. Unset: no hold. */
  limitHeld?: () => boolean
  /** Arms the wake of the request's job (#1861): its one resend (box 4)
   *  or its pick-up then starts as the job's next run. False: not taken,
   *  the pick-up turn goes as before. Unset: always the pick-up turn. */
  wakeJob?: (requestId: string, note: string) => boolean
  /** Gives an agent that waits on a promise the line that says it fell
   *  due, without a run of its own (#1908). False: it could not take it
   *  now. Unset: only the owner is told. */
  tellRequester?: (agentId: string, text: string, request: RequestRecord) => boolean
  /** Runs a loop's checker (#1039). Unset: loops are not checked. */
  check?: LoopChecker
  /** Reads a request's issue or merge request home (#1522). Unset: homes
   *  are not read. */
  checkHome?: HomeChecker
  /** The steps the request's active plan has not finished. One an agent
   *  owns keeps the request open when its home closes; the rest are named
   *  in the close, so it says what the plan stopped with. */
  planLeft?: (requestId: string) => PlanStepLeft[]
  /** Proof per deliverable and reopen once (close-proof.ts, #692): the
   *  plan lookup and the reader. The mode, the telling and its cap come
   *  from the settings and the deps here. Unset: as before. */
  closeProof?: Pick<CloseProofCtx, "plan" | "read">
  /** Opens a hand-back's proof link before it settles (proof-check.ts,
   *  #2122). Unset: proofCheck is off, settled unverified as before. */
  proofCheck?: ProofChecker
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
  /** Requests closed because their issue or merge request home closed (#1522). */
  homesClosed: number
  /** Quiet requests whose handed work came back done, closed (#1138). */
  settled: number
  quiet: number
  notified: number
  pruned: number
  pickedUp: number
  /** Sent back once on their own after a limit or a restart (#1542). */
  resent: number
  /** Notices held while a resend is due. */
  held: number
  /** Promises that fell due: their agent woken, whoever waits told (#1908). */
  duePushed: number
  /** Missed PRs whose lead was woken 15 min after their agent (#2279). */
  prLeads: number
  /** Promises whose agent was woken before their due time
   *  (retro:01M7ZMDDWBC76VKP5NXF9CE9ZY). */
  leadWoken: number
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
export function pickupText(r: RequestRecord, resend: ResendCause | null = null): string {
  const { lead, tail } = pickupParts(r, resend)
  return [`[agentx:request-pickup id=${r.id}]`, lead, "", "What they asked:", r.text, "", ...tail].join("\n")
}

/** The same, as the note of the job's wake that picks it up (#1861): the
 *  wake's own text already says what was asked. */
export function pickupNote(r: RequestRecord, resend: ResendCause | null = null): string {
  const { lead, tail } = pickupParts(r, resend)
  return [lead, ...tail].filter((l) => l !== "").join(" ")
}

function pickupParts(r: RequestRecord, resend: ResendCause | null): { lead: string; tail: string[] } {
  const first = r.askedAgent && r.askedAgent !== r.agentId ? r.askedAgent : null
  const on = new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")
  const asked = `on ${r.channel} (chat ${r.chatId}) on ${on} UTC and was not finished.`
  // A post the owner wrote on the Wall (#1355) has no chat to report in.
  const wall = r.channel === WALL_CHANNEL
  const report = wall
    ? `The ${HUB_NAME} has no chat: give your report as the answer to this turn, which shows as the post's result.`
    : first
    ? `That chat is ${first}'s: you may have no way to write there, so do not report in it. Give your report as the answer to this turn: the owner reads it on the request's card. If you have a chat of your own with them, you can report there as well.`
    : "Report to them in that chat."
  const lead = resend
    ? `${resendLine(resend)} It was asked ${wall ? `on the ${HUB_NAME} on ${on} UTC and was not finished.` : asked}`
    : wall && !first && !r.ownerNote
    ? `The owner gave you this task on the ${HUB_NAME} on ${on} UTC.`
    : first
      ? `The owner handed this request to you. It was asked of ${first} ${asked}`
      : `The owner asked you to pick this request up again. It was asked ${asked}`
  return {
    lead,
    tail: [
      ...goalLine(r.goal),
      ...(r.ownerNote && !r.noteSaid ? ["What they say now:", r.ownerNote, ""] : []),
      `Do the work now. ${report} When it is finished, close it with agentx_request: {action:"done", id:"${r.id}"${workHint(r)}, evidence:"<link>"}. If you will not do it, use decline with the reason.`,
    ],
  }
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
  const woken = wokenAgent(r)
  return [
    r.promise
      ? `A promise ${r.agentId} made to ${r.owedTo} is not kept yet.`
      : `A request you gave ${r.agentId} on ${r.channel} is not finished.`,
    `What happened: ${r.attentionReason ?? "unknown"}`,
    `Waiting on: ${waitsOnWords(on.group, on.who)}`,
    ...(r.verifyState === "unverified" && r.verifyDetail ? [`Its check could not say: ${r.verifyDetail}`] : []),
    // Met but not closed (#692 S3): held after a mismatch, or refused for proof.
    ...((r.verifyState === "held" || r.verifyState === "proof_missing") && r.verifyDetail ? [`Its check is met, but it stays open: ${r.verifyDetail}`] : []),
    r.resentAt !== null ? `Resent once at ${new Date(r.resentAt).toISOString().slice(0, 16).replace("T", " ")} UTC, stopped again.` : "Nothing is retrying it.",
    woken
      ? `Nothing needed from you: ${woken} is woken to finish it. Drop it only if you no longer want it.`
      : r.closeWhen
      ? `Needed from you: hand it back to ${r.agentId}, close it by hand with a reason, or drop it.`
      : `Needed from you: ${cardWords(r).need}`,
    // The owner's own words last, under the headline the title carries.
    r.promise ? `It promised: ${said}` : `You said: ${said}`,
  ].join("\n")
}

/** What the agent of an owner's request reads when it falls due (noqta#876). */
export function overdueText(r: RequestRecord): string {
  const words = (r.headline ?? r.text).replace(/\s+/g, " ").trim()
  return `[agentx:request-overdue id=${r.id}] It fell due (${when(r.dueAt!)}) and is not finished: ${words.length > 300 ? `${words.slice(0, 299)}…` : words}. ` +
    `Finish it now and close it with agentx_request {action:"done", id:"${r.id}"${workHint(r)}, evidence:"<link>"}, or give a new due time with {action:"accept", id:"${r.id}"${workHint(r)}, due:"<ISO time>"} and the reason. The owner is told it is late and that it is yours.`
}

/** Wakes the agent of an overdue request: its job's wake when it takes
 *  it, else a turn of its own. What woke it, or null when nothing could. */
function wakeOverdue(deps: RequestSweepDeps, r: RequestRecord): string | null {
  const text = overdueText(r)
  if (text.length <= JOB_NOTE_MAX && deps.wakeJob?.(r.id, text)) return "job wake"
  if (!deps.tellAgent || (deps.hasAgent && !deps.hasAgent(r.agentId))) return null
  void deps.tellAgent(r.agentId, text, r).catch((e: any) => deps.log(`[requests] ${r.id}: could not wake ${r.agentId} for its due time: ${e?.message ?? e}`))
  return "turn"
}

/** What the agent reads when its handed work came back done with no
 *  proof link (noqta#884): the request stays open until it brings one. */
export function noProofText(r: RequestRecord): string {
  const words = (r.headline ?? r.text).replace(/\s+/g, " ").trim()
  const names = deliverablesOf(r, null)?.names ?? []
  return [
    `[agentx:request-no-proof id=${r.id}] ${words.length > 300 ? `${words.slice(0, 299)}…` : words}`,
    `It is not closed: the hand-off came back with no proof: bring the link for each thing asked.`,
    ...(names.length ? ["Asked:", ...names.map((n, i) => `${i + 1}. ${n}`)] : []),
    `Close it with agentx_request {action:"done", id:"${r.id}"${workHint(r)}, evidence:"<link>"}${names.length > 1 ? `, with proofs: [{deliverable: <number>, link: "<url>"}] for each` : ""}.`,
  ].join("\n")
}

/** Wakes the agent of a hand-back with no proof, as wakeOverdue does.
 *  What woke it, or null when nothing could. */
function wakeNoProof(deps: RequestSweepDeps, r: RequestRecord): string | null {
  const text = noProofText(r)
  if (text.length <= JOB_NOTE_MAX && deps.wakeJob?.(r.id, text)) return "job wake"
  if (!deps.tellAgent || (deps.hasAgent && !deps.hasAgent(r.agentId))) return null
  void deps.tellAgent(r.agentId, text, r).catch((e: any) => deps.log(`[requests] ${r.id}: could not wake ${r.agentId} for its missing proof: ${e?.message ?? e}`))
  return "turn"
}

/** Wakes the agent of a promised PR that fell due with none linked
 *  (#2279): its job's wake when it takes it, else a turn of its own, so a
 *  wake the job cannot take (a run on it, its cap) still reaches it. */
function wakePrDue(deps: RequestSweepDeps, r: RequestRecord, lead: string | null): string | null {
  const text = prDueText(r, lead)
  if (text.length <= JOB_NOTE_MAX && deps.wakeJob?.(r.id, text)) return "job wake"
  if (!deps.tellAgent || (deps.hasAgent && !deps.hasAgent(r.agentId))) return null
  void deps.tellAgent(r.agentId, text, r).catch((e: any) => deps.log(`[requests] ${r.id}: could not wake ${r.agentId} for its PR: ${e?.message ?? e}`))
  return "turn"
}

/** What an agent that waits on a promise reads when it falls due (#1908). */
export function duePromiseText(r: RequestRecord): string {
  const words = (r.headline ?? r.text).replace(/\s+/g, " ").trim()
  return `[Promise due] ${r.id}: ${r.agentId} promised you this by ${when(r.dueAt!)} and it is not kept yet: ${words.length > 300 ? `${words.slice(0, 299)}…` : words}\n` +
    `${r.agentId} was woken to keep it now; the owner is told if it stays open. Nothing is needed from you unless your own work waits on it.`
}

/** What a promise's agent reads before its due time
 *  (retro:01M7ZMDDWBC76VKP5NXF9CE9ZY): how long is left and how to close it. */
export function leadText(r: RequestRecord, now: number): string {
  const words = (r.headline ?? r.text).replace(/\s+/g, " ").trim()
  const left = Math.max(1, Math.round((r.dueAt! - now) / 60_000))
  return `It is due in ${left} min (${when(r.dueAt!)}), owed to ${r.owedTo ?? "the owner"}: ${words.length > 300 ? `${words.slice(0, 299)}…` : words}. ` +
    `Keep it and close it with agentx_request {action:"done", id:"${r.id}", evidence:"<link>"}, or give a new due time with {action:"accept", id:"${r.id}", due:"<ISO time>"} and the reason.`
}

export async function runRequestsSweep(deps: RequestSweepDeps): Promise<RequestSweepResult> {
  const { store, settings, log } = deps
  const now = deps.now ?? Date.now()
  const result: RequestSweepResult = { checked: 0, verified: 0, homesClosed: 0, settled: 0, quiet: 0, notified: 0, pruned: 0, pickedUp: 0, resent: 0, held: 0, duePushed: 0, prLeads: 0, leadWoken: 0 }
  if (!settings.enabled) return result
  // Who hears of a missed PR after its agent (#2279): never the agent itself.
  const prLead = settings.promises?.prLead ?? DEFAULT_PROMISE_SETTINGS.prLead
  const leadOf = (r: RequestRecord): string | null => (prLead && prLead !== r.agentId ? prLead : null)

  const proofSettings = { ...DEFAULT_CLOSE_PROOF, ...settings.closeProof }
  const proof: CloseProofCtx = {
    mode: proofSettings.mode,
    ownerCheckOn: !!settings.ownerCheck?.enabled,
    ...deps.closeProof,
    tell: deps.tellAgent, hasAgent: deps.hasAgent, askBudget: { left: proofSettings.askPerCheck }, log,
  }

  if (deps.check) {
    try {
      const every = (settings.checkers ?? DEFAULT_CHECKER_SETTINGS).checkEveryMinutes
      const r = await checkLoops(store, deps.check, { everyMinutes: every, now, log, proof })
      result.checked = r.checked
      result.verified = r.closed
    } catch (e: any) {
      log(`[requests] loop checks failed: ${e?.message ?? e}`)
    }
  }

  if (deps.checkHome && settings.homeCloses !== false) {
    try {
      const every = (settings.checkers ?? DEFAULT_CHECKER_SETTINGS).checkEveryMinutes
      const r = await checkHomes(store, deps.checkHome, { everyMinutes: every, now, log, planLeft: deps.planLeft, proof })
      result.checked += r.checked
      result.homesClosed = r.closed
    } catch (e: any) {
      log(`[requests] home checks failed: ${e?.message ?? e}`)
    }
  }

  // Held: told later, once the resend is no longer due.
  const held = new Set<string>()
  // Resent by this check: its pick-up says why it comes back.
  const resent = new Map<string, ResendCause>()
  const resend = settings.autoResend ?? DEFAULT_RESEND
  if (resend.enabled && deps.tellAgent) {
    try {
      const limitHeld = deps.limitHeld?.() ?? false
      for (const r of store.awaitingNotice()) {
        const v = resendVerdict(r, {
          settings: resend, now, limitHeld,
          hasAgent: deps.hasAgent ? deps.hasAgent(r.agentId) : true,
          inPlan: deps.inPlan?.(r.id) ?? false,
          cameBack: store.cameBack(r.id),
        })
        if (v.act === "hold") { held.add(r.id); continue }
        if (v.act !== "resend") continue
        if (store.requestPickup(r.id, now, { resend: true })) {
          const by = v.cause === "limit" ? "a usage limit" : "a restart"
          // Through the job's wake when it takes it (#1861 box 4): one
          // path, under the job's caps. Otherwise the pick-up, as before.
          if (deps.wakeJob?.(r.id, resendLine(v.cause))) {
            store.dropPickup(r.id)
            result.resent++
            log(`[requests] ${r.id} resent once through its job's wake: stopped by ${by} (${r.attentionReason})`)
            continue
          }
          resent.set(r.id, v.cause)
          log(`[requests] ${r.id} resent once: stopped by ${by} (${r.attentionReason})`)
        }
      }
      result.held = held.size
    } catch (e: any) {
      log(`[requests] resend failed: ${e?.message ?? e}`)
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
      // The job's next run when its wake takes it (#1861): one path, under
      // the job's caps. A note too long for the wake keeps the turn whole.
      const note = pickupNote(r, resent.get(r.id) ?? null)
      if (note.length <= JOB_NOTE_MAX && deps.wakeJob?.(r.id, note)) {
        result.pickedUp++
        if (resent.has(r.id)) result.resent++
        log(`[requests] ${r.id} picked up through its job's wake`)
        continue
      }
      try {
        await deps.tellAgent(r.agentId, pickupText(r, resent.get(r.id) ?? null), r)
        result.pickedUp++
        if (resent.has(r.id)) result.resent++
      } catch (e: any) {
        if (says) store.setNoteSaid(r.id, says, false)
        store.needsAttention(r.id, `Could not hand it back to ${r.agentId}: ${e?.message ?? e}`, now)
      }
    }
  } catch (e: any) {
    log(`[requests] pick-ups failed: ${e?.message ?? e}`)
  }

  // Its last reply still asks the owner (retro 01M6VAK5): not closed as
  // done, only logged; it stays open and comes back once quiet or overdue.
  // Moving it to waiting_owner (enforce) comes later.
  const asksOwner = (id: string) => settings.settleOwnerWait === "off" ? null : store.ownerWait(id)

  // Hand-backs left for the next check by the cap below: the quiet check
  // must not raise them meanwhile, or they would never settle.
  const linkCheckNext = new Set<string>()
  if (settings.settleHandedBack !== false) {
    // Each link check may take totalTimeoutMs and they run one after
    // another, so only perSweep of them run per check (#2122 review C6);
    // the rest settle on the next one. The daemon also never starts a
    // check while the last is running (requestsSweeping).
    let linkChecksLeft = settings.proofCheck?.perSweep ?? DEFAULT_PROOF_CHECK.perSweep
    try {
      for (const r of store.handedBack(now - settings.staleAfterHours * HOUR)) {
        // A tracked plan follows its own steps and tells the owner itself.
        if (deps.inPlan?.(r.id)) continue
        const waits = asksOwner(r.id)
        if (waits) {
          log(`[requests] retro:01M6VAK5YD0QYR720EDQ8XSGEN ${r.id} not settled (warn mode): ${waits}; it would wait on the owner`)
          continue
        }
        const back = store.handBackProof(r.id)
        if (!back) {
          // No proof, no close (noqta#884): its agent is asked once.
          if (!store.markHandBackAsked(r.id)) continue
          const woken = wakeNoProof(deps, r)
          if (woken) store.touch(r.id, now)
          log(`[requests] ${r.id} not settled: handed work came back with no proof; ${woken ? `${r.agentId} woken (${woken})` : `${r.agentId} could not be woken`}`)
          continue
        }
        // Its link already failed firmly in block mode: left as it is
        // until the work comes back with another link (#2122).
        if (r.verifyState === "failed" && r.verifyDetail?.includes(back.proof)) continue
        if (deps.proofCheck && linkChecksLeft <= 0) {
          linkCheckNext.add(r.id)
          continue
        }
        if (deps.proofCheck) linkChecksLeft--
        // The state it claims comes from the hand-back's own words; the
        // headline may only name the ref (review C5).
        const links = deps.proofCheck ? await deps.proofCheck([back.proof], { said: back.answer ?? "", about: r.headline ?? r.text }) : null
        if (links?.refuse) {
          const why = `Not settled: its proof link ${back.proof} shows otherwise (${links.refuse}).`
          store.markChecked(r.id, "failed", why, now)
          log(`[requests] ${r.id} not settled (proofCheck block): ${links.refuse}`)
          if (deps.tellAgent && deps.hasAgent?.(r.agentId) !== false) {
            await deps.tellAgent(r.agentId, `${why} Give the right link, or say what is still left.`, r)
              .catch((e: any) => log(`[requests] ${r.id}: could not tell ${r.agentId}: ${e?.message ?? e}`))
          }
          continue
        }
        const detail = `The work it handed on came back done with ${back.proof}; nobody closed it in ${settings.staleAfterHours} h.`
        if (store.settle(r.id, back.proof, detail, now, links?.verify)) {
          result.settled++
          log(`[requests] ${r.id} settled: handed work came back with ${back.proof}`)
        }
      }
    } catch (e: any) {
      log(`[requests] settle failed: ${e?.message ?? e}`)
    }
  }

  // A promise that fell due and is not kept (#1908): its agent is woken
  // now, and whoever waits on it is told by this same check, not after
  // the quiet time. Its checker ran above: a promise it closed is gone.
  // Off (`promises.duePush`, #1912): nothing is read, woken or marked here;
  // the promise comes back through the quiet check below.
  const duePush = settings.promises?.duePush !== false
  const leadMinutes = settings.promises?.leadMinutes ?? DEFAULT_PROMISE_SETTINGS.leadMinutes
  const graceMinutes = settings.promises?.graceMinutes ?? DEFAULT_PROMISE_SETTINGS.graceMinutes

  // Before the due time (retro:01M7ZMDDWBC76VKP5NXF9CE9ZY): its agent is
  // woken `leadMinutes` ahead, once per due time, through its job's wake.
  // Nobody else is told: it is not late yet.
  try {
    for (const r of duePush && leadMinutes > 0 ? store.leadPromises(now, leadMinutes * 60_000) : []) {
      store.markLeadWoken(r.id)
      const woken = deps.wakeJob?.(r.id, leadText(r, now)) ?? false
      if (woken) result.leadWoken++
      log(`[requests] retro:01M7ZMDDWBC76VKP5NXF9CE9ZY ${r.id} due ${when(r.dueAt!)}: ${r.agentId} ${woken ? "woken ahead" : "not woken ahead (a run is on it, or its job cannot be woken)"}`)
    }
  } catch (e: any) {
    log(`[requests] promise lead wakes failed: ${e?.message ?? e}`)
  }

  try {
    // No "came back, left to settle" skip here (#1912 item 2): the
    // hand-back settle reads non-promises only (CAME_BACK), so every due
    // promise is pushed once and then left out of this query by its mark.
    for (const r of duePush ? store.duePromises(now) : []) {
      const words = (r.headline ?? r.text).replace(/\s+/g, " ").trim()
      // A PR due with none linked (#2279): woken with the issue, by a turn
      // when the job's wake cannot take it.
      const pr = missedPr(r, store.links(r.id)) ? wakePrDue(deps, r, leadOf(r)) : undefined
      const woken = pr !== undefined ? !!pr
        : deps.wakeJob?.(r.id, `It fell due (${when(r.dueAt!)}) and is not kept, owed to ${r.owedTo ?? "the owner"}: ${words}`.slice(0, JOB_NOTE_MAX)) ?? false
      const waiter = r.owedTo && r.owedTo !== r.agentId && deps.hasAgent?.(r.owedTo) ? r.owedTo : null
      const told = waiter ? deps.tellRequester?.(waiter, duePromiseText(r), r) ?? false : false
      store.markDuePushed(r.id, now)
      const line = `[requests] ${r.id} fell due${pr !== undefined ? " with no PR linked" : ""}: ${r.agentId} ${woken ? `woken${pr ? ` (${pr})` : ""}` : "not woken (a run is on it, or its job cannot be woken)"}${waiter ? `, ${waiter} ${told ? "told" : "not told"}` : ""}`
      // With a grace window it needs attention only once that has run out
      // (below); the agent and its waiter are still told now.
      if (graceMinutes > 0) {
        result.duePushed++
        log(`${line}; needs attention after ${graceMinutes} min of grace`)
      } else if (store.needsAttention(r.id, `${OVERDUE_REASON} (${when(r.dueAt!)})${woken ? `.${wokenTail(r.agentId)}` : ""}`, now)) {
        result.quiet++
        result.duePushed++
        log(line)
      }
    }
  } catch (e: any) {
    log(`[requests] due promises failed: ${e?.message ?? e}`)
  }

  // Grace run out (retro:01M7ZMDDWBC76VKP5NXF9CE9ZY): a promise pushed at
  // its due time and still open `graceMinutes` later needs attention, once
  // per due time. One kept within the grace is never raised.
  try {
    for (const r of duePush && graceMinutes > 0 ? store.graceDue(now - graceMinutes * 60_000) : []) {
      store.markGraceRaised(r.id)
      if (store.needsAttention(r.id, `${OVERDUE_REASON} (${when(r.dueAt!)}), still open ${graceMinutes} min later`, now)) {
        result.quiet++
        log(`[requests] retro:01M7ZMDDWBC76VKP5NXF9CE9ZY ${r.id} still open ${graceMinutes} min past its due time: needs attention`)
      }
    }
  } catch (e: any) {
    log(`[requests] promise grace check failed: ${e?.message ?? e}`)
  }

  // 15 min after a missed PR's agent was woken, still open with no PR
  // linked (#2279): its lead is woken, once per due time. Every promise
  // pushed in the window is read once and marked, PR or not.
  try {
    if (settings.promises?.duePush !== false) {
      for (const r of store.prLeadsDue(now - PR_LEAD_AFTER_MS - PR_LEAD_WINDOW_MS, now - PR_LEAD_AFTER_MS)) {
        store.markPrLead(r.id)
        const lead = leadOf(r)
        if (!lead || !missedPr(r, store.links(r.id))) continue
        if (!deps.tellAgent || (deps.hasAgent && !deps.hasAgent(lead))) {
          log(`[requests] ${r.id} still has no PR: ${lead} could not be woken (not on this node)`)
          continue
        }
        void deps.tellAgent(lead, prLeadText(r, r.duePushedAt), r).catch((e: any) => log(`[requests] ${r.id}: could not wake ${lead} for the missing PR: ${e?.message ?? e}`))
        result.prLeads++
        log(`[requests] ${r.id} still has no PR ${Math.round(PR_LEAD_AFTER_MS / 60_000)} min after ${r.agentId} was woken: ${lead} woken`)
      }
    }
  } catch (e: any) {
    log(`[requests] missed PR follow-up failed: ${e?.message ?? e}`)
  }

  try {
    const hours = settings.staleAfterHours
    for (const r of store.quietSince(["candidate", "in_progress", "waiting_other"], now - hours * HOUR)) {
      if (linkCheckNext.has(r.id)) continue
      const reason = r.state === "candidate"
        ? `The turn that received it never reported an end (${hours} h ago or more)`
        : `No activity for ${hours} h`
      if (store.needsAttention(r.id, reason, now)) result.quiet++
    }
    const settling = settings.settleHandedBack !== false
    for (const r of store.overdue(now, now - hours * HOUR)) {
      if (r.state === "waiting_owner") {
        try {
          if (r.dueAt === null) continue
          const line = `Due ${when(r.dueAt)}, still waiting on the owner${r.question ? `: ${r.question}` : ""}`
          if (!store.noteOwnerDue(r, line, now)) continue
          await deps.notify?.("Request due", line, r, "notice", `request:${r.id}:due:${r.dueAt}:${now}`)
        } catch (e: any) {
          log(`[requests] owner-due notice for ${r.id} failed: ${e?.message ?? e}`)
        }
        continue
      }
      // Back done, and settled once quiet: no "Not finished" before that (#1214).
      // One whose last reply asks the owner is not settled, so it is raised.
      if (settling && r.state === "in_progress" && !deps.inPlan?.(r.id) && store.cameBack(r.id) && !asksOwner(r.id)) continue
      // Its agent is woken at the due time, once per due time (noqta#876
      // cause 3): before, only the owner was told. A tracked plan wakes its
      // own steps; a promise was pushed above.
      // A promise is pushed above; with that push off (#1912) it keeps the
      // old rule: a touch after its due time holds it until quiet.
      if (r.promise) {
        if (r.updatedAt > r.dueAt! && r.updatedAt >= now - hours * HOUR) continue
        if (store.needsAttention(r.id, `${OVERDUE_REASON} (${when(r.dueAt!)})`, now)) result.quiet++
        continue
      }
      const pushed = store.duePushedNow(r.id)
      const woken = !pushed && !deps.inPlan?.(r.id) ? wakeOverdue(deps, r) : null
      if (!pushed) store.markDuePushed(r.id, now)
      if (store.needsAttention(r.id, `${OVERDUE_REASON} (${when(r.dueAt!)})${woken ? `.${wokenTail(r.agentId)}` : ""}`, now)) {
        result.quiet++
        if (woken) {
          result.duePushed++
          log(`[requests] ${r.id} fell due: ${r.agentId} woken (${woken})`)
        }
      }
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
      if (held.has(r.id)) continue
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
