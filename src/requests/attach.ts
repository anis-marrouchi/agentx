import type Database from "better-sqlite3"
import { existsSync, readFileSync } from "fs"
import { getEventBus } from "@/events/bus"
import { RequestStore } from "./store"
import { PlanStore } from "./plan-store"
import { SprintStore } from "./sprint-store"
import { RequestTracker, type RequestSettings } from "./tracker"
import { traceInbound, type InboundLog } from "./checkers/reply"
import { DriftStore } from "./drift/store"

// --- Hook the request tracker to the daemon's event bus (#356) ---

export interface AttachedRequests {
  store: RequestStore
  tracker: RequestTracker
  plans: PlanStore
  /** Sprint lanes (#1241). */
  sprints: SprintStore
  /** Inbound turns, for the reply checker (#1039). */
  inbound: InboundLog
  /** What status drift has told and written (#1138 step F). */
  drift: DriftStore
  detach: () => void
}

/** Who each delegation in the log went to: id → callee, `callee@peer` for
 *  a peer's, as the tracker links them. */
export function delegationAgents(logText: string): Map<string, string> {
  const agents = new Map<string, string>()
  for (const line of logText.split("\n")) {
    if (!line.includes('"type":"start"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type === "start" && typeof e.id === "string" && typeof e.callee === "string") {
        agents.set(e.id, e.peer ? `${e.callee}@${e.peer}` : e.callee)
      }
    } catch {
      // A line cut off by a crash: the rest of the log still reads.
    }
  }
  return agents
}

/** Delegation links kept before their agent was (#1520), filled once at
 *  start, so a retry can be told from its failure. The delegation log
 *  first, though compaction keeps only unfinished starts there; then the
 *  callee's own turn in task_history, which covers the finished ones. The
 *  whole log is read: it stays small (compacted). */
export function fillLinkAgents(store: RequestStore, logPath: string, log: (msg: string) => void): void {
  try {
    const fromLog = existsSync(logPath) ? store.fillLinkAgents(delegationAgents(readFileSync(logPath, "utf-8"))) : 0
    const fromHistory = store.fillLinkAgentsFromHistory()
    const n = fromLog + fromHistory
    if (n) log(`  Requests: ${n} hand-off link${n === 1 ? "" : "s"} given their agent (${fromLog} from the delegation log, ${fromHistory} from task history)`)
  } catch (e: any) {
    log(`  Requests: hand-off agents not filled (${e?.message ?? e})`)
  }
}

export function attachRequests(
  db: Database.Database,
  settings: () => RequestSettings,
  log: (msg: string) => void,
): AttachedRequests {
  const store = new RequestStore(db)
  const plans = new PlanStore(db)
  const tracker = new RequestTracker(store, settings, log)
  const bus = getEventBus()
  const started = tracker.taskStarted.bind(tracker)
  const completed = tracker.taskCompleted.bind(tracker)
  bus.on("task:started", started)
  bus.on("task:completed", completed)
  return {
    store,
    tracker,
    plans,
    sprints: new SprintStore(db),
    inbound: traceInbound(db),
    drift: new DriftStore(db),
    detach: () => {
      bus.off("task:started", started)
      bus.off("task:completed", completed)
    },
  }
}
