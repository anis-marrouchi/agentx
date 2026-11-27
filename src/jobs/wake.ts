import { isQueued } from "@/agents/queued"
import { ledgerFacts } from "./api"
import { isOwned, stallReason, type JobFacts } from "./status"
import type { JobRecord, JobRun, JobStore } from "./store"

// --- The daemon owns the wake-up (#1861, phase 3) ---
//
// A run that ends with work left says "continue" with a time. Nothing in
// the agent keeps that promise: the daemon does. Each minute it
//   1. starts the next run of every job whose wake time has come, in the
//      job's own chat, with the job's note, under a per-job cap of wakes
//      and cost;
//   2. checks the invariant: every open job has a live run, an armed
//      wake, or a named waiter with a due time. A job with none is
//      marked stalled, with why;
//   3. tells the one who asked for each stalled job that it stalled.
// Background work a turn left running belongs to its job too: when it
// ends, its closing reply wakes the job instead of being dropped.
//
// No model call, no waiting: one pass of small statements.

export interface JobWakeSettings {
  enabled: boolean
  /** Wakes one job may get. Past it the job is stalled, not woken. */
  maxWakes: number
  /** What one job's runs may cost before it is no longer woken. */
  maxCostUsd: number
  /** Minutes an open job may sit with nobody on it before it is stalled:
   *  time for a queued run to start. */
  graceMinutes: number
  /** Minutes a job waits on background work its run left before it stalls. */
  maxBackgroundMinutes: number
}

export const DEFAULT_WAKE_SETTINGS: JobWakeSettings = { enabled: true, maxWakes: 20, maxCostUsd: 10, graceMinutes: 10, maxBackgroundMinutes: 180 }

/** Who a job waiting on its own background work names as its waiter. */
export const BACKGROUND_WAITER = "its background work"

const MIN = 60_000
const ASK_MAX = 1500
const REPLY_MAX = 600
// A notice keeps 1000 characters: the line must fit whole.
const TOLD_ASK_MAX = 250
const TOLD_WHY_MAX = 400
/** Stalled jobs read per page, and at most per pass, when telling them. */
const TELL_PAGE = 50
const TELL_SCAN_MAX = 500

/** Marks the context of the run the daemon starts to wake a job. A symbol
 *  key cannot arrive in a JSON body, so a caller of /task cannot set it. */
const WAKE_MARK = Symbol("jobs.wake")

/** The context of the run that wakes `job`: its own chat. */
export function wakeContext(job: Pick<JobRecord, "id" | "channel" | "chatId">): { channel: string; chatId: string; sender: string } {
  return markWake({ channel: job.channel, chatId: job.chatId, sender: "system:job-wake" }, job.id)
}

/** Marks `ctx` as the context of the run that wakes job `jobId`. For a
 *  wake that runs in a context of its own (an owner's request is woken as
 *  a pick-up): the mark makes it wait for a slot instead of being queued. */
export function markWake<T extends object>(ctx: T, jobId: string): T {
  return markWakeKind(Object.assign(ctx, { [WAKE_MARK]: jobId }), "job")
}

/** The job this run was started to wake, when the daemon started it. */
export function wokenJobId(ctx: object | undefined | null): string | undefined {
  const id = ctx ? (ctx as Record<symbol, unknown>)[WAKE_MARK] : undefined
  return typeof id === "string" && id ? id : undefined
}

/** Why the daemon itself started a run (#2012): saved as
 *  task_traces.wake_kind, so each kind of wake is a job type of its own
 *  with its own numbers, instead of one lump of chat runs. */
export type WakeKind =
  | "job" | "pickup" | "overdue" | "no-due" | "no-proof" | "proof-block" | "pr-due" | "pr-lead"
  | "plan-dispatch" | "plan-nudge" | "plan-continue" | "owner-words"

const WAKE_KIND = Symbol("runs.wakeKind")

/** Marks `ctx` as a run the daemon started for `kind`. A symbol key, like
 *  the wake mark: a caller of /task cannot set it. */
export function markWakeKind<T extends object>(ctx: T, kind: WakeKind): T {
  return Object.assign(ctx, { [WAKE_KIND]: kind })
}

/** The kind of daemon wake that started this run; undefined for any other run. */
export function wakeKindOf(ctx: object | undefined | null): WakeKind | undefined {
  const k = ctx ? (ctx as Record<symbol, unknown>)[WAKE_KIND] : undefined
  return typeof k === "string" && k ? k as WakeKind : undefined
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** What the woken run is told. */
export function wakeText(job: JobRecord, settings: Pick<JobWakeSettings, "maxWakes">): string {
  const lines = [
    `[agentx:job-wake id=${job.id}] The daemon started this run to continue a job you left open (wake ${job.wakeCount + 1} of at most ${settings.maxWakes}).`,
    "",
    `What was asked${job.requester ? ` (by ${job.requester})` : ""}:`,
    clip(job.text, ASK_MAX),
  ]
  if (job.home) lines.push("", `Where the work lives: ${job.home.link}`)
  if (job.note) lines.push("", `Why you are woken now: ${job.note}`)
  lines.push(
    "",
    "Continue the work now. Do not repeat an outside action you already took (a message sent, a comment posted, a deploy): check first.",
    "Before this run ends, state the job's state: done with its proof, continue (when, and what is left), waiting (on whom, until when) or blocked (why). A run that ends without one leaves the job stalled.",
  )
  return lines.join("\n")
}

export interface JobWakeDeps {
  jobs: JobStore
  settings: () => JobWakeSettings
  /** What the daemon knows about a job's runs now. Unset: the ledger alone. */
  facts?: (job: JobRecord, runs: () => JobRun[]) => JobFacts
  /** Start the run. Resolves when the run has ended, or could not start,
   *  with its error text. The wake is armed again only when no run began:
   *  a run that began and failed has said what its job's state is. */
  start: (job: JobRecord, text: string) => Promise<{ error?: string } | void>
  hasAgent: (agentId: string) => boolean
  /** Something else answers for the job right now (a hand-off still out). */
  held?: (job: JobRecord) => boolean
  /** Is the schedule with this id still there and on? Its next firing
   *  continues its job. Unset: no schedule is known to be on. */
  scheduleOn?: (id: string) => boolean
  /** Give `agentId` the line that says a job stalled, without a run of
   *  its own. False when it cannot take it now: it is tried again at the
   *  next pass. Unset: nobody is told. */
  tell?: (agentId: string, text: string, job: JobRecord) => boolean
  log: (msg: string) => void
  now?: () => number
}

export interface WakeTickResult { woken: number; capped: number; stalled: number }

/** How long a wake that was started may wait for its run to begin before
 *  the job counts as held by nobody. Longer than the registry's waits put
 *  together: 25 minutes for a slot, 5 for the rate limit, then room on
 *  the node. */
const START_WAIT_MS = 45 * MIN

/** A schedule's job is not woken: the wake run would not carry the
 *  schedule's own model, autonomy or limits. Its next firing goes on. */
const noWake = (job: Pick<JobRecord, "door">) => job.door === "cron"

/** The id of the schedule a schedule's job belongs to. */
const scheduleOf = (job: Pick<JobRecord, "requester" | "chatId">) => (job.requester ?? job.chatId).replace(/^cron:/, "")

/** Who is told a job stalled, and as what. The agent that asked, when it
 *  is on this node. A schedule has nobody who asked: its own agent is
 *  told, and reads it at the schedule's next firing. So is the agent of
 *  an owner's request (the request's own checks tell the owner), and of
 *  a job whose requester is no agent here (a login, software, an agent
 *  on another node, which reads the job's line from this node). */
export function stalledRecipient(job: JobRecord, hasAgent: (id: string) => boolean): { agentId: string; as: "requester" | "schedule" | "assignee" } | null {
  if (job.door === "cron") return hasAgent(job.assignee) ? { agentId: job.assignee, as: "schedule" } : null
  // Only a hand-off names an agent as its requester: a login may spell like one.
  if (job.door === "a2a" && !job.ownerRequest && job.requester && job.requester !== job.assignee && hasAgent(job.requester)) return { agentId: job.requester, as: "requester" }
  return hasAgent(job.assignee) ? { agentId: job.assignee, as: "assignee" } : null
}

/** The line the recipient reads. */
export function stalledText(job: JobRecord, as: "requester" | "schedule" | "assignee"): string {
  const what = as === "requester" ? `the work you asked ${job.assignee} for is stalled`
    : as === "schedule" ? `the job of your schedule ${scheduleOf(job)} is stalled`
    : `a job you hold${job.ownerRequest ? " for the owner" : job.requester ? ` (asked by ${job.requester})` : ""} is stalled`
  const next = as === "requester" ? `Nobody is on it now: ask ${job.assignee} again, or drop it.`
    : as === "schedule" ? "The daemon does not wake a schedule's job: take it up at the next firing, or say it is done."
    : "Nobody is on it now: take it up, or tell the one who asked why not."
  const lines = [`[Job stalled] ${job.id}: ${what}: ${clip(job.note ?? "no run, no wake and no one it waits on", TOLD_WHY_MAX)}.`,`It was: ${clip(job.text.replace(/\s+/g, " ").trim(), TOLD_ASK_MAX)}`]
  if (job.home) lines.push(`Where the work lives: ${job.home.link}`)
  lines.push(next)
  return lines.join("\n")
}

export class JobWake {
  private now: () => number
  /** Wakes whose start has not come back yet, and when they were taken:
   *  the run may still be waiting for a slot. Removed when the start
   *  resolves, so it never outlives the run. */
  private startedAt = new Map<string, number>()

  constructor(private deps: JobWakeDeps) {
    this.now = deps.now ?? Date.now
  }

  private factsOf(job: JobRecord): JobFacts {
    let cached: JobRun[] | null = null
    const runs = () => (cached ??= this.deps.jobs.runs(job.id))
    return this.deps.facts ? this.deps.facts(job, runs) : ledgerFacts(runs())
  }

  /** One pass: wake what is due, then mark what nobody holds. */
  tick(): WakeTickResult {
    const result: WakeTickResult = { woken: 0, capped: 0, stalled: 0 }
    const settings = this.deps.settings()
    if (!settings.enabled) return result
    try { this.wakeDue(settings, result) } catch (e: any) { this.deps.log(`[jobs] wake failed: ${e?.message ?? e}`) }
    try { this.checkOwned(settings, result) } catch (e: any) { this.deps.log(`[jobs] invariant check failed: ${e?.message ?? e}`) }
    try { this.tellStalled() } catch (e: any) { this.deps.log(`[jobs] telling stalled jobs failed: ${e?.message ?? e}`) }
    return result
  }

  /** Every stalled job is told to the one who asked for it, once: the
   *  wake and the invariant only mark it. A job nobody here can be told
   *  about stays untold, and is tried again at the next pass. Returns how
   *  many were told. */
  tellStalled(): number {
    const { jobs, tell, log } = this.deps
    if (!tell) return 0
    let told = 0
    // Page on past the jobs that stay untold, so a full page of them does
    // not hide a later job that can be told. Bounded per pass.
    let after: { stalledAt: number; id: string } | undefined
    for (let seen = 0; seen < TELL_SCAN_MAX;) {
      const page = jobs.stalledUntold(TELL_PAGE, after)
      for (const job of page) {
        const to = stalledRecipient(job, this.deps.hasAgent)
        if (!to || !tell(to.agentId, stalledText(job, to.as), job)) continue
        if (jobs.markRequesterTold(job.id, this.now())) {
          told++
          log(`[jobs] ${job.id} stalled: told ${to.agentId}${to.as === "requester" ? "" : ` (${to.as})`}`)
        }
      }
      seen += page.length
      const last = page[page.length - 1]
      if (page.length < TELL_PAGE || last?.stalledAt == null) break
      after = { stalledAt: last.stalledAt, id: last.id }
    }
    return told
  }

  private wakeDue(settings: JobWakeSettings, result: WakeTickResult): void {
    const { jobs, log } = this.deps
    const now = this.now()
    for (const job of jobs.dueWakes(now)) {
      if (!this.deps.hasAgent(job.assignee)) {
        if (jobs.markStalled(job.id, `its agent ${job.assignee} is not on this node, so it cannot be woken`, now)) result.stalled++
        continue
      }
      if (noWake(job)) {
        // Its next firing continues it (the doors link that run to this
        // job), so it is not stalled while its schedule is on: looked at
        // again in an hour.
        if (this.deps.scheduleOn?.(scheduleOf(job))) {
          jobs.deferWake(job.id, now + 60 * MIN)
          continue
        }
        if (jobs.markStalled(job.id, `a schedule's job is not woken by the daemon, and its schedule is off or gone, so no firing continues it. What was left: ${job.note ?? "not said"}`, now)) result.stalled++
        continue
      }
      // A run is on it already, or an earlier wake of it is still waiting
      // for its slot: that run will say what comes next. The wake stays set.
      if (this.startedAt.has(job.id) || this.factsOf(job).liveRun || this.deps.held?.(job)) continue
      const cost = jobs.costUsd(job.id)
      const over = job.wakeCount >= settings.maxWakes ? `it was woken ${job.wakeCount} times, the most a job may be (requests.jobs.wake.maxWakes)`
        : cost >= settings.maxCostUsd ? `its runs cost $${cost.toFixed(2)}, the most a job may spend (requests.jobs.wake.maxCostUsd)` : null
      if (over) {
        if (jobs.markStalled(job.id, `not woken again: ${over}. What was left: ${job.note ?? "not said"}`, now)) {
          result.capped++
          log(`[jobs] ${job.id} stalled at its cap: ${over}`)
        }
        continue
      }
      if (!jobs.takeWake(job.id, now)) continue
      this.startedAt.set(job.id, now)
      const runsBefore = jobs.runCount(job.id)
      result.woken++
      log(`[jobs] waking ${job.id} for ${job.assignee} (wake ${job.wakeCount + 1})`)
      void Promise.resolve()
        .then(() => this.deps.start(job, wakeText(job, settings)))
        .then((res) => {
          const error = res && typeof res === "object" ? res.error : undefined
          // Queued behind a busy agent: the run will start, nothing to arm.
          // The job stays held until the wait below runs out.
          if (error && isQueued(error)) return
          if (this.startedAt.get(job.id) === now) this.startedAt.delete(job.id)
          if (!error) return
          // A run began on the job since the wake was taken (the doors link
          // it as it starts). It ran and failed: a time limit, the model, a
          // restart. Its end already put a state on the job (blocked, or
          // what the run declared), and that state stands.
          if (jobs.runCount(job.id) > runsBefore) {
            log(`[jobs] ${job.id}: its wake run ended with an error (${clip(error, 120)}), not armed again`)
            return
          }
          // No run began (the agent stayed busy, a limit holds): try again
          // in a few minutes. Each try counts toward the cap.
          const at = this.now()
          if (jobs.rearmWake(job.id, at + 5 * MIN, job.note ?? "the wake could not start", at)) log(`[jobs] ${job.id}: wake could not start (${clip(error, 120)}), armed again`)
        })
        .catch((e: any) => {
          if (this.startedAt.get(job.id) === now) this.startedAt.delete(job.id)
          log(`[jobs] ${job.id}: wake failed: ${e?.message ?? e}`)
        })
    }
  }

  private checkOwned(settings: JobWakeSettings, result: WakeTickResult): void {
    const { jobs, log } = this.deps
    const now = this.now()
    for (const [id, at] of this.startedAt) if (now - at >= START_WAIT_MS) this.startedAt.delete(id)
    // An owner's request whose wake fired and whose run never handed it
    // back (a run before this was fixed, a start a restart cut): its
    // request's own checks follow it again, and a later due time can arm
    // a wake. Not while its wake's run may still be waiting for a slot.
    for (const job of jobs.spentOwnerWakes(now - settings.graceMinutes * MIN)) {
      if (this.startedAt.has(job.id) || this.factsOf(job).liveRun || this.deps.held?.(job)) continue
      if (jobs.ownerWakeSpent(job.id)) log(`[jobs] ${job.id}: its wake was spent, back to its request's own checks`)
    }
    // Only the jobs the check can stall: not the owner's requests no run
    // declared on (their own checks hold them), not a job on another node
    // (that node's to check), not one blocked, stalled or with a wake set.
    for (const job of jobs.unheldCandidates()) {
      if (now - job.updatedAt < settings.graceMinutes * MIN && job.state !== "waiting") continue
      // Its wake was started and the run may still be waiting for a slot.
      if (this.startedAt.has(job.id)) continue
      const facts = this.factsOf(job)
      if (isOwned(job, facts, now)) continue
      if (this.deps.held?.(job)) continue
      const reason = stallReason(job, facts, now)
      if (jobs.markStalled(job.id, reason, now)) {
        result.stalled++
        log(`[jobs] ${job.id} stalled: ${reason}`)
      }
    }
  }

  /** Another part of the daemon has a reason to start a job's next run:
   *  a request a limit or a restart stopped is due its one resend
   *  (#1861 box 4). Instead of a
   *  run of its own, it arms the job's wake: the run starts in the job's
   *  chat, under the job's caps, linked to the same job. True only when
   *  the wake is armed and its run will carry `note`. False, and the
   *  caller keeps its old path, when the wake is off; the job is closed,
   *  missing, a schedule's or another node's; it is blocked or stalled
   *  (its reason stands); it is at its cap of wakes or cost; or a run is
   *  on it or about to start (that run would never see `note`). */
  /** A run is on the job now or about to start: why wakeFor refused, for
   *  the sweep's words (#2383). */
  busy(jobId: string): boolean {
    try {
      const job = this.deps.jobs.get(jobId)
      return !!job && (this.startedAt.has(job.id) || !!this.factsOf(job).liveRun)
    } catch {
      return false
    }
  }

  wakeFor(jobId: string, note: string): boolean {
    const settings = this.deps.settings()
    if (!settings.enabled) return false
    try {
      const job = this.deps.jobs.get(jobId)
      if (!job || noWake(job) || job.peer || !this.deps.hasAgent(job.assignee)) return false
      if (job.state === "done" || job.state === "dropped" || job.state === "blocked" || job.state === "stalled") return false
      if (job.wakeCount >= settings.maxWakes || this.deps.jobs.costUsd(job.id) >= settings.maxCostUsd) return false
      if (this.startedAt.has(job.id) || this.factsOf(job).liveRun || this.deps.held?.(job)) return false
      const now = this.now()
      // A wake already armed keeps what it was for: both reasons go.
      const said = job.wakeAt !== null && job.note ? `${note} (also: ${job.note})` : note
      const armed = this.deps.jobs.armWake(job.id, now, said, now)
      if (armed) this.deps.log(`[jobs] ${job.id}: wake armed (${clip(note.replace(/\s+/g, " "), 120)})`)
      return armed
    } catch (e: any) {
      this.deps.log(`[jobs] wake for ${jobId} failed: ${e?.message ?? e}`)
      return false
    }
  }

  /** A run was stopped at its agent's time limit (agents/resume/time-
   *  limit.ts): its job continues it, in a run this wake starts with
   *  `note`. The run's own end has already marked the job blocked (timed
   *  out, jobs/doors.ts): that block is the stop handed off here; any
   *  other reason stands. The id of the job, or null when none takes it:
   *  the wake is off; no job, an owner's request (its own checks follow
   *  it), a schedule's or another node's; closed or held for another
   *  reason; at its cap of wakes or cost. The start waits, as every wake
   *  does, until no run is on the job. */
  timeLimitStopped(runIds: Array<string | undefined>, note: string): string | null {
    const settings = this.deps.settings()
    if (!settings.enabled) return null
    try {
      const ids = runIds.filter((id): id is string => !!id)
      const job = ids.map((id) => this.deps.jobs.byRun(id)).find((j) => !!j)
      if (!job || job.ownerRequest || noWake(job) || job.peer || !this.deps.hasAgent(job.assignee)) return null
      const ownStop = job.state === "blocked" && job.declaredRun !== null && ids.includes(job.declaredRun)
      if (!ownStop && job.state !== "working" && job.state !== "continue") return null
      if (job.wakeCount >= settings.maxWakes || this.deps.jobs.costUsd(job.id) >= settings.maxCostUsd) return null
      const now = this.now()
      if (!this.deps.jobs.declare(job.id, { state: "continue", wakeAt: now, note }, { runId: ids[0], now })) return null
      this.deps.log(`[jobs] ${job.id}: stopped at its time limit, wake armed`)
      return job.id
    } catch (e: any) {
      this.deps.log(`[jobs] time-limit hand-off failed: ${e?.message ?? e}`)
      return null
    }
  }

  /** A run ended cleanly with background work still open in its process:
   *  the job waits on that work instead of closing. True when it does. */
  runLeftBackground(job: JobRecord, open: number, runId?: string): boolean {
    const settings = this.deps.settings()
    if (!settings.enabled || open <= 0 || job.ownerRequest || noWake(job)) return false
    const now = this.now()
    return this.deps.jobs.declare(job.id, {
      state: "waiting", on: BACKGROUND_WAITER, until: now + settings.maxBackgroundMinutes * MIN,
      note: `${open} background task${open === 1 ? "" : "s"} still running when the run ended`,
    }, { runId, now })
  }

  /** Background work a turn left in this chat ended, with Claude's closing
   *  reply: the job that waits on that work is woken with it. When several
   *  wait in the chat, the one that has waited longest; the next reply
   *  wakes the next. With none waiting, the chat's newest open job takes
   *  it if it is still working. False when no job takes it (the reply is
   *  dropped, as before jobs). What the turn cost counts toward the job's
   *  cost cap either way. */
  backgroundEnded(key: { agentId: string; channel: string; chatId: string }, reply: string, costUsd?: number): boolean {
    if (!this.deps.settings().enabled) return false
    try {
      const { jobs } = this.deps
      const job = jobs.waitingInChat(key.agentId, key.channel, key.chatId, BACKGROUND_WAITER)
        ?? jobs.latestInChat(key.agentId, key.channel, key.chatId)
      if (!job) return false
      // The turn nobody asked for has no trace of its own to carry its cost.
      if (costUsd && costUsd > 0) jobs.addCost(job.id, costUsd)
      // The owner's request is woken only once a run put a job state on it
      // or it waits on this work: its own checks hold it otherwise.
      if (job.ownerRequest && job.declaredAt === null) return false
      // Only a job that waits on this work, or is still working: a job
      // someone blocked or stopped is not started again by a stray reply.
      if (noWake(job) || !(job.waitingOn === BACKGROUND_WAITER || job.state === "working")) return false
      // A run is on it now, or its wake is waiting for a slot: that run
      // sees the work's result itself.
      if (this.startedAt.has(job.id) || this.factsOf(job).liveRun || this.deps.held?.(job)) return false
      const now = this.now()
      const said = reply.replace(/\s+/g, " ").trim()
      const note = `background work you left running has ended.${said ? ` Its closing reply: ${clip(said, REPLY_MAX)}` : ""}`
      const armed = this.deps.jobs.armWake(job.id, now, note, now)
      if (armed) this.deps.log(`[jobs] ${job.id}: background work ended, waking it`)
      return armed
    } catch (e: any) {
      this.deps.log(`[jobs] background end failed: ${e?.message ?? e}`)
      return false
    }
  }
}
