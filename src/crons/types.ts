import type { CronValue } from "./value-line"
import type { AutonomyLevel } from "@/guard/autonomy"
import type { AutonomyBlock } from "@/guard/autonomy-enforce"
import type { CronReportMode } from "./quiet"

// --- Cron system types ---

export interface CronJobState {
  id: string
  enabled: boolean
  schedule: string
  timezone: string
  agent: string
  prompt: string
  /** Run this shell command instead of dispatching the agent. See the
   *  cron schema in daemon/config.ts for why this exists. */
  command?: string
  timeout: number
  model?: string
  /** Soft output-length cap appended to the prompt at invocation time.
   *  Claude Code CLI has no hard flag for this, so we instruct the model
   *  via the prompt tail; reliably honored and keeps cache-hit intact
   *  (hint text is per-job, not per-run). */
  maxOutputTokens?: number
  /** The run's `context.taskType` (#1049). */
  taskType?: string
  /** Routine autonomy level; unset = act (full agent permissions). */
  autonomy?: AutonomyLevel
  onError: Array<"log" | "notify" | "disable">
  /** Why it runs and the number that proves it (#1183). */
  value?: CronValue
  /** The goal it serves (#1568): once that goal is done or dropped, the
   *  job stops running, and each run gets the goal's current state. */
  goal?: string
  /** Set when a run was skipped because its goal is closed: the Wall
   *  shows "goal done, disable?". */
  goalClosed?: { state: string; at: Date }
  /** The goal check's lines for the Wall (#863): held, change owed, a
   *  refused card, a forge read that failed. */
  goalLines?: string[]
  /** Send each successful run's answer to the job's `notify` target.
   *  True whenever the job has `notify`, unless `deliverResult: false`. */
  deliverResult?: boolean
  /** `exceptions`: a run that answers NOTHING_TO_REPORT sends nothing (#1289). */
  report?: CronReportMode
  /** Flag answer lines that state a fact without a source (#1288). */
  requireSources?: boolean
  /** Fail the run unless the answer ends with `EXIT=0` (#1540). */
  expectExitZero?: boolean
  /** One-time job (#2004): its single run time (ISO). Off after it runs. */
  runAt?: string
  /** Recurring job (#863): ISO time after which it ends for good. */
  until?: string
  /** Set when the job was retired (agentx.json `endedAt`, #863). */
  endedAt?: string
  /** A one-time run missed while the daemon was down: how late, in ms. */
  lateBy?: number
  /** The owner's last verdict on its job (#863), for the Wall. */
  lastVerdict?: { text: string; at: string; by: string }
  lastRun?: Date
  nextRun?: Date
  lastSuccess?: Date
  lastError?: string
  consecutiveErrors: number
  totalRuns: number
  totalFailures: number
  /** Whether a retry is currently pending */
  retryPending?: boolean
}

export interface CronRunResult {
  jobId: string
  startedAt: Date
  completedAt: Date
  success: boolean
  response?: string
  error?: string
  duration: number
  /** Was this a retry attempt? */
  isRetry?: boolean
  retryAttempt?: number
  /** Hard deadline applied to an agent run, in seconds. Absent for command
   *  jobs, whose `timeout` is the shell timeout. */
  timeout?: number
  /** Started on demand via POST /routines/:id/fire, not by the schedule. */
  fired?: boolean
  /** Dashboard task id of the agent run (RunningTask.id / TaskRecord.id),
   *  so the run opens on the Task page. Absent for command jobs, which
   *  never reach an agent. */
  taskId?: string
  /** Per-execution trace id (task_traces row, /api/mesh/run). */
  traceId?: string
  /** Native provider session the run resumed or started, when reported. */
  sessionId?: string
  /** Wiki notes (#825) the run was given as input, by note id. */
  wikiNotes?: string[]
  /** Autonomy level the run was held to (absent = act). */
  autonomy?: AutonomyLevel
  /** Tool calls the autonomy guard blocked — what the routine would have
   *  done with more power. */
  autonomyBlocks?: AutonomyBlock[]
  /** A `report: "exceptions"` run that had nothing to report (#1289). */
  quiet?: boolean
  /** Answer lines that stated a fact without a source, on a job with
   *  `requireSources` (#1288). Absent when every line had one. */
  unsourced?: number
}
