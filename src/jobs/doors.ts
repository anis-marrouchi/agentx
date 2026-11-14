import type { AgentXEvents } from "@/events/bus"
import { firstLink, type RequestHome, type RequestStore } from "@/requests/store"
import { PICKUP_CHANNEL, type DelegationSignal } from "@/requests/tracker"
import { delegationIdOfChat } from "@/a2a/delegation"
import { normalizeHome } from "@/a2a/home"
import type { JobDoor, JobRecord, JobStore } from "./store"

// --- A job opened at every door (#1861, phase 1) ---
//
// The request tracker opens a row for the owner's turn. This opens one for
// every other run: an agent-to-agent hand-off, an issue mention, a cron, a
// workflow step, or a run software started. Fed by the same signals as the
// tracker, after it, so a run the tracker linked is already the owner's.
//
// Phase 1 changes no behaviour: a job whose run ends without error is
// closed as it is today ("the run ended"), unless `onUndeclared` says
// otherwise. Phase 2 plugs the end-of-run declaration in there.
//
// Like the tracker, every entry point swallows its own errors.

export interface JobDoorSettings {
  enabled: boolean
}

export const DEFAULT_JOB_SETTINGS: JobDoorSettings = { enabled: true }

/** What a run that ended cleanly without declaring a state leaves. */
export const RUN_ENDED_PROOF = "the run ended without error (no state declared)"

const FORGE_CHAT = /^(.+):(issue|pull|merge_request):(\d+)$/
const base = (channel: string) => channel.toLowerCase().split("@")[0]
const chatKey = (agentId: string, channel: string, chatId: string) => `${agentId}\u0000${channel}\u0000${chatId}`
const clip = (s: string, n = 300) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/** The home of a run on an issue or merge request thread, from its chat:
 *  `group/project#12`, or `!12` for a merge request. */
export function homeOfForgeChat(chatId: string): string | null {
  const m = FORGE_CHAT.exec(chatId)
  return m ? `${m[1].toLowerCase()}${m[2] === "merge_request" ? "!" : "#"}${m[3]}` : null
}

/** Which door a run that is not the owner's came through, with who asked. */
export function doorOf(p: Pick<AgentXEvents["task:started"], "channel" | "chatId" | "sender" | "humanRoot">): { door: Exclude<JobDoor, "owner">; requester: string | null } | null {
  const ch = base(p.channel)
  const sender = p.sender?.username ?? p.sender?.name ?? p.sender?.id ?? null
  if (ch === "a2a") {
    const parts = p.chatId.split(":")
    const caller = parts.length === 4 && parts[0] === "a2a" ? parts[1] : null
    return { door: "a2a", requester: caller ?? (sender ? sender.replace(/^agent:/, "") : null) ?? (p.chatId !== "a2a" ? p.chatId : null) }
  }
  if (ch === "github" || ch === "gitlab") return { door: "mention", requester: sender }
  if (ch === "cron") return { door: "cron", requester: p.chatId.startsWith("cron:") ? p.chatId : `cron:${p.chatId}` }
  if (ch === "workflow") return { door: "workflow", requester: p.chatId }
  // A turn that talks to a person who is not the owner is a chat answer.
  if (p.humanRoot) return null
  return { door: "api", requester: sender }
}

export interface JobDoorsDeps {
  jobs: JobStore
  /** The owner's requests, to find the request a workflow run serves. */
  requests: RequestStore
  settings: () => JobDoorSettings
  log: (msg: string) => void
  now?: () => number
  /** A job's run ended cleanly and no run declared a state for it. Return
   *  true when handled; unset or false: the job is closed as "the run
   *  ended" (what the daemon did before jobs). */
  onUndeclared?: (job: JobRecord, end: AgentXEvents["task:completed"]) => boolean
}

export class JobDoors {
  private now: () => number
  /** The job of the turn each agent is running in each chat: a hand-off
   *  started from that turn is its child. */
  private live = new Map<string, { jobId: string; runId: string }>()
  /** Hand-offs this node started: their end comes from the delegation,
   *  not from the callee's run. */
  private handed = new Set<string>()

  constructor(private deps: JobDoorsDeps) {
    this.now = deps.now ?? Date.now
  }

  setOnUndeclared(fn: JobDoorsDeps["onUndeclared"]): void {
    this.deps.onUndeclared = fn
  }

  private guard(what: string, fn: () => void): void {
    try { fn() } catch (e: any) { this.deps.log(`[jobs] ${what} failed: ${e?.message ?? e}`) }
  }

  /** The job of the turn this agent is running in this chat, if any. */
  liveJobId(agentId: string, channel: string, chatId: string): string | null {
    return this.live.get(chatKey(agentId, channel, chatId))?.jobId ?? null
  }

  taskStarted(p: AgentXEvents["task:started"]): void {
    if (!p.taskId) return
    this.guard("open", () => {
      if (!this.deps.settings().enabled) return
      const { jobs } = this.deps
      const now = this.now()
      const runId = p.taskId!
      const key = chatKey(p.agentId, p.channel, p.chatId)
      const on = (jobId: string) => this.live.set(key, { jobId, runId })

      // The tracker linked it: the owner's turn, its resume or its pick-up.
      const owned = jobs.byRun(runId)
      if (owned) {
        if (owned.ownerRequest) jobs.tagOwnerRow(owned.id, {})
        on(owned.id)
        return
      }
      // A run that continues one a restart or a time limit cut off.
      const earlier = p.resumedFrom ? jobs.byRun(p.resumedFrom) : null
      if (earlier) {
        jobs.linkRun(earlier.id, runId, now)
        if (!earlier.ownerRequest) jobs.working(earlier.id, now)
        on(earlier.id)
        return
      }
      // A plan step handed to another agent: counted under its request.
      if (base(p.channel) === PICKUP_CHANNEL) return
      const from = doorOf(p)
      if (!from) return

      // A hand-off this node started already has its job.
      const dlg = from.door === "a2a" ? delegationIdOfChat(p.chatId) : null
      if (dlg) {
        const handed = jobs.get(`job-${dlg}`)
        if (handed) {
          jobs.linkRun(handed.id, runId, now)
          jobs.working(handed.id, now)
          on(handed.id)
          return
        }
      }
      const homeRef = from.door === "mention" ? homeOfForgeChat(p.chatId) : normalizeHome(p.home) ?? null
      const home: RequestHome | null = homeRef ? { kind: "issue", link: homeRef } : null
      // A new message on the same issue to the same agent continues its job.
      const same = home && (from.door === "mention" || from.door === "a2a") ? jobs.openAtHome(p.agentId, home.link) : null
      if (same) {
        jobs.linkRun(same.id, runId, now)
        jobs.working(same.id, now)
        on(same.id)
        return
      }
      const id = dlg ? `job-${dlg}` : `job-${runId}`
      // A workflow step serves the request its workflow run is linked to.
      const wfRun = from.door === "workflow" && p.chatId.startsWith("workflow:") ? p.chatId.slice("workflow:".length) : null
      const parentId = wfRun ? this.deps.requests.byLink("workflow", wfRun)?.id ?? null : null
      jobs.open({
        id, door: from.door, requester: from.requester, assignee: p.agentId, channel: p.channel, chatId: p.chatId,
        text: p.requestText ?? p.fullMessage ?? p.messagePreview, home, parentId, runId, now,
      })
      on(id)
    })
  }

  taskCompleted(p: AgentXEvents["task:completed"]): void {
    if (!p.taskId) return
    this.guard("run end", () => {
      const key = chatKey(p.agentId, p.channel, p.chatId)
      if (this.live.get(key)?.runId === p.taskId) this.live.delete(key)
      const job = this.deps.jobs.byRun(p.taskId!)
      // An owner's request is moved by the tracker, as before.
      if (!job || job.ownerRequest) return
      // Cut by a shutdown: the resumed run, or the next check, decides.
      if (p.interrupted) return
      const now = this.now()
      if (p.stopped || p.errorKind === "stopped" || p.errorKind === "cancelled") {
        this.deps.jobs.declare(job.id, { state: "blocked", why: `${p.agentId} was stopped${p.error ? `: ${clip(p.error)}` : ""}` }, { runId: p.taskId, now })
        return
      }
      if (p.error) {
        const word = /\btimed? ?out\b|timeout/i.test(p.error) ? "timed out" : "failed"
        this.deps.jobs.declare(job.id, { state: "blocked", why: `${p.agentId} ${word}: ${clip(p.error)}` }, { runId: p.taskId, now })
        return
      }
      // The run said what the job's state is: nothing more to do.
      if (job.state !== "working" || job.declaredRun === p.taskId) return
      // A hand-off this node started ends with its delegation.
      const dlg = job.id.startsWith("job-dlg-") ? job.id.slice("job-".length) : null
      if (dlg && this.handed.has(dlg)) return
      if (this.deps.onUndeclared?.(job, p)) return
      this.deps.jobs.declare(job.id, { state: "done", proof: firstLink(p.finalResponse ?? "") ?? RUN_ENDED_PROOF }, { runId: p.taskId, now })
    })
  }

  /** An agent handed work to another from a running turn: a job owed by
   *  the callee, child of the job of that turn. */
  delegationStarted(d: DelegationSignal & { request?: string; home?: string }): void {
    this.guard("hand-off", () => {
      if (!this.deps.settings().enabled) return
      const now = this.now()
      const parentId = this.liveJobId(d.caller, d.origin.channel, d.origin.chatId)
      const homeRef = normalizeHome(d.home)
      this.handed.add(d.id)
      this.deps.jobs.open({
        id: `job-${d.id}`, door: "a2a", requester: d.caller, assignee: d.callee,
        channel: "a2a", chatId: `a2a:${d.caller}:${d.callee}:${d.id}`,
        text: d.request ?? `Work handed to ${d.callee} by ${d.caller}`,
        home: homeRef ? { kind: "issue", link: homeRef } : null, parentId,
        // On another node no run of it starts here: it waits on that node.
        ...(d.peer ? { peer: d.peer, state: "waiting" as const, waitingOn: `${d.callee}@${d.peer}` } : {}),
        now,
      })
    })
  }

  /** The hand-off ended: done with the link its answer gave, waiting when
   *  the callee said so, blocked when it failed, timed out or was lost. */
  delegationDone(d: DelegationSignal, status: "done" | "waiting" | "error" | "timeout" | "lost", text: string, dueAt?: number): void {
    this.guard("hand-off end", () => {
      this.handed.delete(d.id)
      const job = this.deps.jobs.get(`job-${d.id}`)
      if (!job || job.ownerRequest) return
      const now = this.now()
      const who = d.peer ? `${d.callee}@${d.peer}` : d.callee
      if (status === "done") {
        // The callee's run may have declared a state itself: that stands.
        if (job.state === "working" || (job.peer && job.state === "waiting")) {
          this.deps.jobs.declare(job.id, { state: "done", proof: firstLink(text) ?? RUN_ENDED_PROOF }, { now })
        }
        return
      }
      if (status === "waiting") {
        if (job.state === "working" && dueAt) this.deps.jobs.declare(job.id, { state: "waiting", on: who, until: dueAt, note: "the callee said it is waiting" }, { now })
        return
      }
      const what = { error: "failed", timeout: "did not answer in time", lost: "was lost in a restart" }[status]
      if (job.state === "working" || job.state === "waiting") {
        this.deps.jobs.declare(job.id, { state: "blocked", why: `${who} ${what}: ${clip(text)}` }, { now })
      }
    })
  }
}
