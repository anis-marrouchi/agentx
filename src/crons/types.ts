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
  onError: "log" | "notify" | "disable"
  lastRun?: Date
  nextRun?: Date
  consecutiveErrors: number
  totalRuns: number
}

export interface CronRunResult {
  jobId: string
  startedAt: Date
  completedAt: Date
  success: boolean
  response?: string
  error?: string
  duration: number
}
