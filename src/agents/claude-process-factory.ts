import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import {
  type ProcessFactory,
  type ProcessHandle,
  type ProcessKey,
  type ProcessSnapshot,
  type ProcessState,
  type SpawnOptions,
  type TurnEvent,
  type TurnInput,
} from "./process-registry"

// --- Real subprocess factory for `claude` ---
//
// Step 3 of the persistent-claude-process design (see
// docs/architecture/persistent-claude-process.md). Wraps the `claude`
// CLI in a long-lived child driven via stream-json on stdin and
// stdout. The wire format was verified empirically on 2026-05-03:
//
//   stdin:  {"type":"user","message":{"role":"user","content":"<text>"}}\n
//   stdout: newline-delimited JSON events (system/init, assistant,
//           rate_limit_event, result, ...). The `result` event marks
//           the end of one turn; subsequent turns can be sent on the
//           same stdin without spawning again.
//
// Concurrency: same-chat turns serialize through `turnQueue`. The
// handle never runs two turns simultaneously — Claude's session state
// is intrinsically sequential.

interface ParsedEvent {
  type: string
  [k: string]: unknown
}

const TURN_DEADLINE_MS = 20 * 60 * 1000   // 20 min absolute per turn
const KILL_GRACE_MS = 5_000               // SIGTERM → wait → SIGKILL

export interface ClaudeProcessFactoryOptions {
  /** Override the binary. Default: "claude" (resolved via PATH). */
  binary?: string
  /** Extra flags appended to every spawn. Useful for tests / overrides. */
  extraArgs?: string[]
  /** Logger; default no-op. */
  log?: (msg: string) => void
}

export class ClaudeProcessFactory implements ProcessFactory {
  constructor(private opts: ClaudeProcessFactoryOptions = {}) {}

  spawn(key: ProcessKey, opts: SpawnOptions): ProcessHandle {
    return new ClaudeProcessHandle(key, opts, this.opts)
  }
}

class ClaudeProcessHandle implements ProcessHandle {
  private child: ChildProcessWithoutNullStreams
  private buf = ""
  private pendingEvents: ParsedEvent[] = []
  private waiters: Array<(e: ParsedEvent | null) => void> = []
  private exited = false
  private exitCode: number | null = null
  private killReason?: string
  /** Promise chain that serialises runTurn calls. Each call appends. */
  private turnQueue: Promise<void> = Promise.resolve()
  private snap: ProcessSnapshot

  constructor(
    public readonly key: ProcessKey,
    private spawnOpts: SpawnOptions,
    private factoryOpts: ClaudeProcessFactoryOptions,
  ) {
    const binary = factoryOpts.binary ?? "claude"
    const args = this.buildArgs(spawnOpts)
    const log = factoryOpts.log ?? (() => {})

    this.child = spawn(binary, args, {
      cwd: spawnOpts.workspace,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams

    this.snap = {
      key,
      pid: this.child.pid ?? null,
      claudeSessionId: spawnOpts.resumeSessionId ?? null,
      state: "warm-cold",
      spawnedAt: Date.now(),
      lastTurnAt: Date.now(),
      turnCount: 0,
      lastInputTokens: 0,
      pendingTaskId: null,
    }

    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk))
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk) => log(`[claude pid=${this.snap.pid}] stderr: ${chunk.trim()}`))
    this.child.on("exit", (code) => {
      this.exited = true
      this.exitCode = code
      this.snap = { ...this.snap, state: "dead", deadReason: this.killReason ?? `exit=${code}` }
      // Wake every waiter — they get null which is interpreted as EOF.
      const ws = this.waiters.splice(0)
      for (const w of ws) w(null)
    })
    this.child.on("error", (err) => {
      log(`[claude pid=${this.snap.pid}] spawn error: ${err.message}`)
      this.killReason = `spawn-error: ${err.message}`
    })
  }

  state(): ProcessState {
    return this.snap.state
  }

  snapshot(): ProcessSnapshot {
    return { ...this.snap }
  }

  /**
   * Run one user turn. Yields stream-json events until a `result` event
   * arrives (turn complete) or the process exits (turn aborted). Concurrent
   * calls on the same handle queue behind each other — Claude's session
   * is sequential by construction.
   */
  async *runTurn(input: TurnInput): AsyncIterable<TurnEvent> {
    // Take our slot in the queue. We hold it until the iterator finishes.
    let release!: () => void
    const myDone = new Promise<void>((r) => { release = r })
    const prevQueue = this.turnQueue
    this.turnQueue = prevQueue.then(() => myDone)
    await prevQueue

    if (this.exited || this.snap.state === "dead") {
      release()
      throw new Error(`claude process for ${this.key.agentId}:${this.key.chatId} is dead (${this.snap.deadReason ?? "?"})`)
    }

    this.snap = { ...this.snap, pendingTaskId: input.taskId }
    const turnStart = Date.now()

    // Write the user line. JSON.stringify guarantees no embedded
    // newlines so a single \n delimits the message.
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: input.message },
    })
    this.child.stdin.write(line + "\n")

    const deadline = turnStart + TURN_DEADLINE_MS

    try {
      while (true) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error(`turn deadline exceeded (${TURN_DEADLINE_MS}ms)`)
        }
        const evt = await this.nextEvent(remaining)
        if (evt === null) {
          throw new Error(`claude process exited mid-turn (code=${this.exitCode}, reason=${this.snap.deadReason ?? "?"})`)
        }
        yield { type: evt.type, raw: evt }

        if (evt.type === "result") {
          this.onResultEvent(evt)
          return
        }
      }
    } finally {
      this.snap = { ...this.snap, pendingTaskId: null }
      release()
    }
  }

  async kill(reason: string): Promise<void> {
    if (this.exited) return
    this.killReason = reason
    this.snap = { ...this.snap, state: "dead", deadReason: reason }
    try {
      this.child.kill("SIGTERM")
    } catch { /* already gone */ }

    // Best-effort wake any waiters so they don't block forever.
    const ws = this.waiters.splice(0)
    for (const w of ws) w(null)

    // Force after grace.
    const forced = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        try { this.child.kill("SIGKILL") } catch { /* */ }
        resolve(true)
      }, KILL_GRACE_MS)
      this.child.once("exit", () => { clearTimeout(t); resolve(false) })
    })
    void forced
  }

  // ---------- internals ----------

  private buildArgs(opts: SpawnOptions): string[] {
    const args: string[] = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
    ]
    if (opts.model) args.push("--model", opts.model)
    if (opts.permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions")
    }
    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId)
    }
    if (opts.systemPromptAppend && opts.systemPromptAppend.trim().length > 0) {
      args.push("--append-system-prompt", opts.systemPromptAppend)
    }
    if (this.factoryOpts.extraArgs) {
      args.push(...this.factoryOpts.extraArgs)
    }
    return args
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      let evt: ParsedEvent
      try {
        evt = JSON.parse(line) as ParsedEvent
      } catch {
        // Malformed line — drop. Claude CLI very occasionally emits
        // non-JSON warnings; resilience > strictness here.
        continue
      }
      if (this.waiters.length > 0) {
        const w = this.waiters.shift()!
        w(evt)
      } else {
        this.pendingEvents.push(evt)
      }
    }
  }

  /**
   * Pull the next event from the queue, or wait for one. Returns null
   * when the process has exited and no more events will arrive.
   * `timeoutMs` lets the caller cap how long it'll wait — used to
   * enforce per-turn deadlines.
   */
  private nextEvent(timeoutMs: number): Promise<ParsedEvent | null> {
    if (this.pendingEvents.length > 0) {
      return Promise.resolve(this.pendingEvents.shift()!)
    }
    if (this.exited) return Promise.resolve(null)

    return new Promise<ParsedEvent | null>((resolve) => {
      let resolved = false
      const t = setTimeout(() => {
        if (resolved) return
        resolved = true
        const idx = this.waiters.indexOf(resolver)
        if (idx >= 0) this.waiters.splice(idx, 1)
        resolve(null)
      }, timeoutMs)
      const resolver = (e: ParsedEvent | null) => {
        if (resolved) return
        resolved = true
        clearTimeout(t)
        resolve(e)
      }
      this.waiters.push(resolver)
    })
  }

  /**
   * Update the snapshot from a `result` event — usage, session_id,
   * state transition warm-cold → warm-hot → idle.
   */
  private onResultEvent(evt: ParsedEvent): void {
    const usage = (evt.usage ?? {}) as Record<string, number>
    const sessionId = typeof evt.session_id === "string" ? evt.session_id : this.snap.claudeSessionId
    this.snap = {
      ...this.snap,
      lastTurnAt: Date.now(),
      turnCount: this.snap.turnCount + 1,
      lastInputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : this.snap.lastInputTokens,
      claudeSessionId: sessionId,
      state: "idle",
    }
  }
}
