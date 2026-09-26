import type { AutonomyLevel } from "@/guard/autonomy"
import type { AutonomyBlock } from "@/guard/autonomy-enforce"

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
  /** Routine autonomy level; unset = act (full agent permissions). */
  autonomy?: AutonomyLevel
  onError: Array<"log" | "notify" | "disable">
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
  /** Autonomy level the run was held to (absent = act). */
  autonomy?: AutonomyLevel
  /** Tool calls the autonomy guard blocked — what the routine would have
   *  done with more power. */
  autonomyBlocks?: AutonomyBlock[]
}
