import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

const exec = promisify(execFile)
export class OpenCodeServerUnavailable extends Error {
  constructor(message: string, readonly standalone = false) { super(message) }
}
interface Options {
  key: string
  cwd: string
  env: NodeJS.ProcessEnv
  model?: string
  permission?: string
  fresh?: boolean
  signal?: AbortSignal
}
interface Entry {
  child: ChildProcessWithoutNullStreams
  fingerprint: string
  url: string
  env: NodeJS.ProcessEnv
  busy: boolean
  dead: boolean
  idle?: NodeJS.Timeout
}

/** Dedicated v2 servers retain provider/MCP startup while CLI clients stream turns. */
export class OpenCodeProcessPool {
  private entries = new Map<string, Entry>()
  private versions = new Map<string, Promise<boolean>>()
  constructor(private capacity = 8, private idleMs = 300_000) {}
  private close(entry: Entry) {
    if (entry.dead) return
    entry.dead = true
    clearTimeout(entry.idle)
    entry.child.kill("SIGTERM")
    const kill = setTimeout(() => {
      if (entry.child.exitCode === null) entry.child.kill("SIGKILL")
    }, 3000)
    kill.unref()
  }
  stop() {
    for (const entry of this.entries.values()) this.close(entry)
    this.entries.clear()
    this.versions.clear()
  }
  async acquire(o: Options) {
    if (o.signal?.aborted) throw new Error("task cancelled by operator")
    const path = o.env.PATH || ""
    let version = this.versions.get(path)
    if (!version) {
      version = exec("opencode", ["--version"], { env: o.env, timeout: 5000 })
        .then(({ stdout }) => /^(?:opencode\s+)?v?2\./.test(stdout.trim())).catch(() => false)
      this.versions.set(path, version)
      // Retry after upgrades/installations without requiring a daemon restart.
      const expire = setTimeout(() => this.versions.delete(path), 60_000)
      expire.unref()
    }
    if (!await version) throw new OpenCodeServerUnavailable("Warm servers require OpenCode v2; using the CLI path")
    if (o.signal?.aborted) throw new Error("task cancelled by operator")
    const fingerprint = createHash("sha256").update(JSON.stringify([
      o.cwd, o.model, o.permission, Object.entries(o.env).sort(([a], [b]) => a.localeCompare(b)),
    ])).digest("hex")
    let entry = this.entries.get(o.key)
    if (entry?.busy) throw new OpenCodeServerUnavailable("Conversation already running", true)
    if (entry && (entry.dead || entry.fingerprint !== fingerprint || o.fresh)) {
      this.close(entry)
      this.entries.delete(o.key)
      entry = undefined
    }
    const reused = !!entry
    if (!entry) {
      if (this.entries.size >= this.capacity) {
        const idle = [...this.entries].find(([, value]) => !value.busy)
        if (!idle) throw new OpenCodeServerUnavailable("Warm server capacity reached", true)
        this.close(idle[1])
        this.entries.delete(idle[0])
      }
      const env = { ...o.env, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: randomBytes(32).toString("hex") }
      const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--stdio"],
        { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"] })
      entry = { child, env, fingerprint, url: "", busy: true, dead: false }
      this.entries.set(o.key, entry)
      const current = entry
      child.stderr.resume()
      child.on("exit", () => this.close(current))
      child.on("error", () => this.close(current))
      try {
        await new Promise<void>((resolve, reject) => {
          const lines = createInterface({ input: child.stdout })
          const fail = () => finish(new OpenCodeServerUnavailable("OpenCode server failed before dispatch", true))
          const abort = () => finish(new Error("task cancelled by operator"))
          const timer = setTimeout(fail, 15_000)
          const finish = (error?: Error) => {
            clearTimeout(timer)
            child.removeListener("exit", fail)
            child.removeListener("error", fail)
            o.signal?.removeEventListener("abort", abort)
            lines.close()
            child.stdout.resume()
            error ? reject(error) : resolve()
          }
          child.once("exit", fail)
          child.once("error", fail)
          o.signal?.addEventListener("abort", abort, { once: true })
          lines.on("line", line => {
            try {
              const url = new URL(JSON.parse(line).url)
              if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) return
              current.url = url.origin
              finish()
            } catch { /* Ignore non-readiness output. */ }
          })
          if (o.signal?.aborted) abort()
        })
      } catch (error) {
        this.close(entry)
        if (this.entries.get(o.key) === entry) this.entries.delete(o.key)
        throw error
      }
    }
    const current = entry
    clearTimeout(current.idle)
    current.busy = true
    let released = false
    return {
      url: current.url, env: current.env, reused,
      invalidate: () => this.close(current),
      release: (failed = false) => {
        if (released) return
        released = true
        current.busy = false
        if (failed || current.dead) {
          this.close(current)
          if (this.entries.get(o.key) === current) this.entries.delete(o.key)
        } else {
          current.idle = setTimeout(() => {
            this.close(current)
            if (this.entries.get(o.key) === current) this.entries.delete(o.key)
          }, this.idleMs)
          current.idle.unref()
        }
      },
    }
  }
}
export const openCodeProcessPool = new OpenCodeProcessPool()
