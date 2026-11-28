import type Database from "better-sqlite3"
import { getEventBus } from "@/events/bus"
import { HandoffStore } from "@/a2a/handoff-store"
import { RequestStore } from "./store"
import { PlanStore } from "./plan-store"
import { GoalStore } from "./goal-store"
import { NumberStore } from "@/numbers/store"
import { SprintStore } from "./sprint-store"
import { RequestTracker, type RequestSettings } from "./tracker"
import { traceInbound, type InboundLog } from "./checkers/reply"
import { DriftStore } from "./drift/store"
import { JobStore } from "@/jobs/store"
import { JobDoors, jobsOn, type JobDoorsDeps } from "@/jobs/doors"
import { isSystemMessage } from "@/jobs/headline"
import { SlotStore } from "./slot-store"

// --- Hook the request tracker to the daemon's event bus (#356) ---

export interface AttachedRequests {
  store: RequestStore
  tracker: RequestTracker
  plans: PlanStore
  /** Goal records (#1568). */
  goals: GoalStore
  /** Tracked numbers and their readings (#1826). */
  numbers: NumberStore
  /** Sprint lanes (#1241). */
  sprints: SprintStore
  /** Inbound turns, for the reply checker (#1039). */
  inbound: InboundLog
  /** What status drift has told and written (#1138 step F). */
  drift: DriftStore
  /** The job ledger over the same table (#1861). */
  jobs: JobStore
  /** Opens a job for every run that is not the owner's turn (#1861). */
  doors: JobDoors
  /** Work registered in the queue, with its computed due time (#1909). */
  slots: SlotStore
  detach: () => void
}

/** Who each delegation the callee ran here went to, from its runs: their
 *  chat is `a2a:<caller>:<callee>:<delegation id>`. The callee is read
 *  from the chat, not the run's agent, which can differ. A hand-off to
 *  another node ran there and has no run here. */
export function delegationAgentsFromRuns(db: Database.Database): Map<string, string> {
  const agents = new Map<string, string>()
  const rows = db.prepare("SELECT DISTINCT chat_id FROM task_history WHERE chat_id LIKE 'a2a:%:%:%'").all() as Array<{ chat_id: string }>
  for (const { chat_id } of rows) {
    const parts = chat_id.split(":")
    if (parts.length === 4 && parts[2] && parts[3]) agents.set(parts[3], parts[2])
  }
  return agents
}

/** Who each hand-off in the handoffs table went to (#1861): id → callee,
 *  `callee@peer` for a peer's, as the tracker links them. Empty before the
 *  table is made. */
export function handoffAgents(db: Database.Database): Map<string, string> {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'").get()
  return has ? new HandoffStore(db).agents() : new Map()
}

/** Delegation links kept before their agent was (#1520), filled once at
 *  start, so a retry can be told from its failure. The handoffs table
 *  (with the old log imported into it) names them, a peer's too; the
 *  callee's runs name older ones the old log's compaction dropped. */
export function fillLinkAgents(store: RequestStore, db: Database.Database, log: (msg: string) => void): void {
  try {
    const agents = handoffAgents(db)
    for (const [id, agent] of delegationAgentsFromRuns(db)) agents.set(id, agent)
    const n = store.fillLinkAgents(agents)
    if (n) log(`  Requests: ${n} hand-off link${n === 1 ? "" : "s"} given their agent from the hand-offs`)
  } catch (e: any) {
    log(`  Requests: hand-off agents not filled (${e?.message ?? e})`)
  }
}

export function attachRequests(
  db: Database.Database,
  settings: () => RequestSettings,
  log: (msg: string) => void,
  /** A job's run ended with no state declared (jobs/doors.ts). */
  onUndeclared?: JobDoorsDeps["onUndeclared"],
): AttachedRequests {
  const store = new RequestStore(db)
  const plans = new PlanStore(db)
  const tracker = new RequestTracker(store, settings, log)
  const bus = getEventBus()
  const started = tracker.taskStarted.bind(tracker)
  const completed = tracker.taskCompleted.bind(tracker)
  bus.on("task:started", started)
  bus.on("task:completed", completed)
  // After the tracker, on purpose: a run it linked is the owner's already.
  const jobs = new JobStore(db)
  try {
    const dropped = jobs.dropSystemJobs(isSystemMessage, Date.now())
    if (dropped) log(`[jobs] dropped ${dropped} open job(s) that were only a daemon message (#2555)`)
  } catch (e: any) {
    log(`[jobs] could not drop daemon-message jobs: ${e?.message ?? e}`)
  }
  const doors = new JobDoors({ jobs, requests: store, settings: () => ({ enabled: jobsOn(settings()) }), log, onUndeclared })
  const jobStarted = doors.taskStarted.bind(doors)
  const jobCompleted = doors.taskCompleted.bind(doors)
  bus.on("task:started", jobStarted)
  bus.on("task:completed", jobCompleted)
  return {
    store,
    tracker,
    plans,
    goals: new GoalStore(db),
    numbers: new NumberStore(db),
    sprints: new SprintStore(db),
    inbound: traceInbound(db),
    drift: new DriftStore(db),
    jobs,
    doors,
    slots: new SlotStore(db),
    detach: () => {
      bus.off("task:started", started)
      bus.off("task:completed", completed)
      bus.off("task:started", jobStarted)
      bus.off("task:completed", jobCompleted)
    },
  }
}
