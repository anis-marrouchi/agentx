// --- Structured logger for the daemon ---
// Outputs JSON lines to stderr for machine parsing, human-readable to stdout.

export type LogLevel = "debug" | "info" | "warn" | "error"

interface LogEntry {
  time: string
  level: LogLevel
  module: string
  msg: string
  [key: string]: unknown
}

export class Logger {
  private module: string
  private minLevel: LogLevel
  private static levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

  constructor(module: string, minLevel: LogLevel = "info") {
    this.module = module
    this.minLevel = minLevel
  }

  child(module: string): Logger {
    return new Logger(`${this.module}:${module}`, this.minLevel)
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.emit("debug", msg, data)
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.emit("info", msg, data)
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit("warn", msg, data)
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.emit("error", msg, data)
  }

  /**
   * Create a console.error-compatible function for backward compat.
   */
  asConsoleLog(): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
      // Strip [agentx] prefix if present
      const clean = msg.replace(/^\[agentx\]\s*/, "")
      if (clean) this.info(clean)
    }
  }

  private emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (Logger.levelOrder[level] < Logger.levelOrder[this.minLevel]) return

    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      module: this.module,
      msg,
      ...data,
    }

    // Human-readable to stderr (what the user sees)
    const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : ""
    const tag = `[${this.module}]`
    const display = prefix ? `${tag} ${prefix}: ${msg}` : `${tag} ${msg}`
    console.error(display)
  }
}
