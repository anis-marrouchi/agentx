// --- Debug mode: structured verbose logging with categories ---
//
// Toggle globally or per-category. Categories:
//   webhook   — incoming webhook payloads and routing decisions
//   agent     — agent execution, task routing, session management
//   channel   — channel adapter lifecycle (connect, disconnect, errors)
//   cron      — cron scheduling, execution, retries
//   mesh      — A2A mesh peer discovery, health checks
//   context   — context engine layer building
//   memory    — memory extraction, compaction
//   all       — enable everything
//
// Toggle at runtime:
//   POST /debug/on?categories=webhook,agent
//   POST /debug/off
//   GET  /debug — current state
//
// Or via env: AGENTX_DEBUG=webhook,agent

import chalk from "chalk"

export type DebugCategory =
  | "webhook" | "agent" | "channel" | "cron" | "mesh"
  | "context" | "memory" | "config" | "all"

let debugEnabled = false
let enabledCategories: Set<DebugCategory> = new Set()

/** Log buffer for recent debug messages (ring buffer, last 200) */
const LOG_BUFFER_SIZE = 200
const logBuffer: Array<{ ts: string; category: string; message: string }> = []

export function setDebug(enabled: boolean, categories?: DebugCategory[]): void {
  debugEnabled = enabled
  if (categories) {
    enabledCategories = new Set(categories)
  } else if (enabled) {
    enabledCategories = new Set(["all"])
  } else {
    enabledCategories.clear()
  }
}

export function isDebug(category?: DebugCategory): boolean {
  if (!debugEnabled) return false
  if (enabledCategories.has("all")) return true
  if (category && enabledCategories.has(category)) return true
  return false
}

export function getDebugState(): { enabled: boolean; categories: string[] } {
  return {
    enabled: debugEnabled,
    categories: [...enabledCategories],
  }
}

/** Get recent debug log entries */
export function getDebugLogs(limit: number = 50): typeof logBuffer {
  return logBuffer.slice(-limit)
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
}

function bufferLog(category: string, message: string): void {
  const entry = { ts: new Date().toISOString(), category, message }
  logBuffer.push(entry)
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift()
}

export const debug = {
  log(...args: unknown[]): void {
    if (!debugEnabled) return
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
    bufferLog("general", msg)
    console.error(chalk.dim(`[${timestamp()}]`), ...args)
  },

  /** Log with a specific category — only outputs if that category is enabled */
  cat(category: DebugCategory, message: string, ...extra: unknown[]): void {
    if (!isDebug(category)) return
    bufferLog(category, message)
    const tag = chalk.bold(`[${category}]`)
    console.error(chalk.dim(`[${timestamp()}]`), tag, message, ...extra)
  },

  step(step: number, message: string): void {
    if (!debugEnabled) return
    bufferLog("agent", `step ${step}: ${message}`)
    console.error(chalk.dim(`[${timestamp()}]`), chalk.blue(`[step ${step}]`), message)
  },

  hook(name: string, duration: number, result: string): void {
    if (!debugEnabled) return
    bufferLog("agent", `hook ${name} (${duration}ms) → ${result}`)
    console.error(
      chalk.dim(`[${timestamp()}]`),
      chalk.magenta(`[hook]`),
      `${name} (${duration}ms) → ${result}`
    )
  },

  api(method: string, model: string, tokens?: number): void {
    if (!debugEnabled) return
    const tokenStr = tokens ? ` (${tokens} tokens)` : ""
    bufferLog("agent", `api ${method} → ${model}${tokenStr}`)
    console.error(
      chalk.dim(`[${timestamp()}]`),
      chalk.yellow(`[api]`),
      `${method} → ${model}${tokenStr}`
    )
  },

  tokens(input: number, output: number, cost: number): void {
    if (!debugEnabled) return
    bufferLog("agent", `tokens in:${input} out:${output} $${cost.toFixed(4)}`)
    console.error(
      chalk.dim(`[${timestamp()}]`),
      chalk.green(`[tokens]`),
      `in: ${input.toLocaleString()}, out: ${output.toLocaleString()}, cost: $${cost.toFixed(4)}`
    )
  },

  context(label: string, detail: string): void {
    if (!isDebug("context")) return
    bufferLog("context", `${label}: ${detail}`)
    console.error(chalk.dim(`[${timestamp()}]`), chalk.cyan(`[${label}]`), detail)
  },

  /** Log webhook event with full payload summary */
  webhook(channel: string, event: string, detail: string): void {
    if (!isDebug("webhook")) return
    bufferLog("webhook", `${channel}/${event}: ${detail}`)
    console.error(chalk.dim(`[${timestamp()}]`), chalk.red(`[webhook:${channel}]`), event, detail)
  },

  /** Log channel lifecycle event */
  channel(name: string, event: string, detail?: string): void {
    if (!isDebug("channel")) return
    const msg = detail ? `${event}: ${detail}` : event
    bufferLog("channel", `${name}: ${msg}`)
    console.error(chalk.dim(`[${timestamp()}]`), chalk.blue(`[channel:${name}]`), msg)
  },
}

// Initialize from environment variable
const envDebug = process.env.AGENTX_DEBUG
if (envDebug) {
  const cats = envDebug.split(",").map(c => c.trim()) as DebugCategory[]
  setDebug(true, cats)
}
