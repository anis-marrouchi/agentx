// --- Cron system types ---

export interface CronJobState {
  id: string
  enabled: boolean
  schedule: string
  timezone: string
  agent: string
  prompt: string
  timeout: number
  model?: string
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
}
