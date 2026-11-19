import { withAgentGitlabEnv } from "@/channels/gitlab-token"
import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { randomUUID } from "crypto"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import {
  SUBAGENT_MODEL_ENV,
  type ProcessFactory,
  type ProcessHandle,
  type ProcessHooks,
  type ProcessKey,
  type ProcessSnapshot,
  type ProcessState,
  type SpawnOptions,
  type TurnEvent,
  type TurnInput,
} from "./process-registry"
import { BackgroundTasks } from "./background-tasks"
import { readManagedHash } from "./workspace-setup"
import { claudeBillingEnv } from "@/utils/workspace-env"
import { SITUATION_TOOL_ENV, SOURCES_TOOL_ENV, situationToolOn, sourcesToolEnvOn } from "@/situations/context"

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
// A `result` is not always the answer to the last line written: when a
// background task of the agent ends, Claude runs a turn nobody asked for,
// with its own `result`. So each user line carries a uuid, and with
// --replay-user-messages Claude echoes it on stdout as that question's
// turn starts (verified on 2.1.288, 2026-10-03). Only what follows the
// echo belongs to the question (#585).
//
// Concurrency: same-chat turns serialize through `turnQueue`. The
// handle never runs two turns simultaneously — Claude's session state
// is intrinsically sequential.

interface ParsedEvent {
  type: string
  [k: string]: unknown
}

/**
 * Read the managed-marker hash from a workspace's CLAUDE.md, returning
 * null when the file is missing or has no marker (user-edited). Used
 * both at spawn (to record the baseline) and from the registry's drift
 * sweep (to detect changes). Read failures swallowed so a permission
 * issue doesn't crash the spawn or the sweeper.
 */
export function readClaudeMdHashSafe(workspace: string): string | null {
  const path = resolve(workspace, "CLAUDE.md")
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, "utf8")
    return readManagedHash(content)
  } catch {
    return null
  }
}

const TURN_DEADLINE_MS = 20 * 60 * 1000   // default when the caller passes no deadlineMs
const KILL_GRACE_MS = 5_000               // SIGTERM → wait → SIGKILL

export interface ClaudeProcessFactoryOptions {
  /** Override the binary. Default: "claude" (resolved via PATH). */
  binary?: string
  /** Extra flags appended to every spawn. Useful for tests / overrides. */
  extraArgs?: string[]
  /** Logger; default no-op. */
  log?: (msg: string) => void
}

export class TurnDeadlineExceeded extends Error {
  constructor(readonly budgetMs: number) {
    super(`turn exceeded its ${Math.round(budgetMs / 60_000)}m budget`)
  }
}

/** The process was killed mid-turn by something other than the turn's own
 *  deadline: a daemon shutdown, an eviction, an operator kill. */
export class TurnInterrupted extends Error {
  constructor(readonly reason: string) {
    super(`claude process stopped mid-turn (${reason})`)
  }
}

/** Who this warm process serves, for the tools it launches (the agentx MCP
 *  server reads these to name the caller of a delegation, #277). A warm
 *  process is keyed by (agent, channel, chatId), so these never go stale;
 *  the per-turn AGENTX_TASK_ID does, and is left out. */
export function persistentCallerEnv(env: NodeJS.ProcessEnv, key: ProcessKey): NodeJS.ProcessEnv {
  env.AGENTX_AGENT_ID = key.agentId
  // glab and scripts write to GitLab as this agent, not the shared account.
  withAgentGitlabEnv(env, key.agentId)
  // The guard hook refuses calls it cannot check in this session (#1710).
  env.AGENTX_GUARD = "required"
  env.AGENTX_CHANNEL = key.channel
  env.AGENTX_CHAT_ID = key.chatId
  // A warm process is keyed by the queue's chat already (mid-turn.ts).
  env.AGENTX_QUEUE_CHANNEL = key.channel
  env.AGENTX_QUEUE_CHAT = key.chatId
  delete env.AGENTX_TASK_ID
  // agentx_situation is listed only while agents may name their talk (#1892).
  if (situationToolOn()) env[SITUATION_TOOL_ENV] = "1"
  else delete env[SITUATION_TOOL_ENV]
  // agentx_sources only while a per-request source is switched on (phase 7).
  if (sourcesToolEnvOn()) env[SOURCES_TOOL_ENV] = "1"
  else delete env[SOURCES_TOOL_ENV]
  return env
}

/** Events held between asked turns, at most. Past it the oldest go. */
const MAX_PENDING_BETWEEN_TURNS = 200

/** What the next asked turn reads of the events written before it: the
 *  init that may be its own, and the replies nobody asked for. */
function keptBetweenTurns(evt: ParsedEvent): boolean {
  return evt.type === "result" || (evt.type === "system" && evt.subtype === "init")
}

/** A process serving an edge-model job keeps its sub-agents on that model
 *  (agents/edge-routing.ts). */
export function withSubagentModel(env: NodeJS.ProcessEnv, model: string | undefined): NodeJS.ProcessEnv {
  if (model) env[SUBAGENT_MODEL_ENV] = model
  return env
}

export class ClaudeProcessFactory implements ProcessFactory {
  constructor(private opts: ClaudeProcessFactoryOptions = {}) {}

  spawn(key: ProcessKey, opts: SpawnOptions, hooks?: ProcessHooks): ProcessHandle {
    return new ClaudeProcessHandle(key, opts, this.opts, hooks)
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
  /** Background tasks the process has open, asked turn or not (#1560). */
  private background = new BackgroundTasks()
  /** Results of turns nobody asked for that the hook already got (#1861). */
  private passedOn = new WeakSet<ParsedEvent>()
  private snap: ProcessSnapshot
  private log: (msg: string) => void

  constructor(
    public readonly key: ProcessKey,
    public readonly opts: SpawnOptions,
    private factoryOpts: ClaudeProcessFactoryOptions,
    private hooks: ProcessHooks = {},
  ) {
    const binary = factoryOpts.binary ?? "claude"
    const args = this.buildArgs(opts)
    const log = this.log = factoryOpts.log ?? (() => {})

    this.child = spawn(binary, args, {
      cwd: opts.workspace,
      env: claudeBillingEnv(withSubagentModel(persistentCallerEnv({ ...process.env }, key), opts.subagentModel), opts.billing),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams

    this.snap = {
      key,
      pid: this.child.pid ?? null,
      claudeSessionId: opts.resumeSessionId ?? null,
      state: "warm-cold",
      spawnedAt: Date.now(),
      lastTurnAt: Date.now(),
      turnCount: 0,
      lastInputTokens: 0,
      pendingTaskId: null,
      claudeMdHash: readClaudeMdHashSafe(opts.workspace),
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

    // Mark the turn in-flight. Without this the handle kept reporting
    // "idle" while streaming, so the registry sweeper idle-killed
    // processes mid-turn once (now − previous turn's end) crossed
    // idleTimeoutMs — any turn longer than the idle window died.
    const turnStart = Date.now()
    this.snap = { ...this.snap, state: "busy", pendingTaskId: input.taskId, lastTurnAt: turnStart }

    // Write the user line. JSON.stringify guarantees no embedded
    // newlines so a single \n delimits the message.
    const uuid = randomUUID()
    const line = JSON.stringify({
      type: "user",
      uuid,
      message: { role: "user", content: input.message },
    })
    this.child.stdin.write(line + "\n")

    const budgetMs = input.deadlineMs ?? TURN_DEADLINE_MS
    const deadline = turnStart + budgetMs
    const timedOut = () => {
      // Stop the turn for real: a process left running would keep working
      // on a handle marked idle until the sweeper killed it mid-step.
      void this.kill(`turn deadline (${Math.round(budgetMs / 60_000)}m)`)
      return new TurnDeadlineExceeded(budgetMs)
    }

    // Until Claude echoes our uuid, the events are from a turn nobody
    // asked for (queued while the handle sat idle, or still running).
    // Its reply is not this question's answer: it goes to the hook for
    // the job that left the work running (#1861), or is logged and dropped.
    let echoed = false
    let init: ParsedEvent | null = null

    try {
      while (true) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw timedOut()
        const evt = await this.nextEvent(remaining)
        // nextEvent yields null on EOF, on its own timeout, and when kill()
        // wakes it before the child has exited. Only the timeout is ours.
        if (evt === null && this.killReason) throw new TurnInterrupted(this.killReason)
        if (evt === null && !this.exited) throw timedOut()
        if (evt === null) {
          throw new Error(`claude process exited mid-turn (code=${this.exitCode}, reason=${this.snap.deadReason ?? "?"})`)
        }
        if (!echoed) {
          if (evt.type === "user" && evt.uuid === uuid) {
            echoed = true
            // The init of our own turn arrives before the echo.
            if (init) yield { type: init.type, raw: init }
          } else if (evt.type === "system" && evt.subtype === "init") {
            init = evt
          } else if (evt.type === "result") {
            init = null
            const text = typeof evt.result === "string" ? evt.result : ""
            const did = this.passUnaskedReply(evt) ? "passed to its job" : "dropped"
            this.log(`[claude pid=${this.snap.pid}] ${did} a reply no question asked for (${text.length} chars): ${text.slice(0, 120)}`)
          }
          continue
        }
        yield { type: evt.type, raw: evt }

        if (evt.type === "result") {
          this.onResultEvent(evt)
          return
        }
      }
    } finally {
      // Success path already transitioned busy → idle in onResultEvent.
      // On error paths (deadline, mid-turn exit) restore idle here so a
      // handle can never leak in "busy" and dodge the sweeper forever.
      const stillBusy = this.snap.state === "busy"
      this.snap = {
        ...this.snap,
        ...(stillBusy ? { state: "idle" as const, lastTurnAt: Date.now() } : {}),
        pendingTaskId: null,
      }
      release()
    }
  }

  /** See ProcessHandle.claim — bump lastTurnAt on acquire so the idle
   *  sweeper can't kill the handle before the turn's first write. */
  claim(): void {
    if (this.snap.state === "dead") return
    this.snap = { ...this.snap, lastTurnAt: Date.now() }
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
      "--replay-user-messages",
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
    if (opts.extraArgs) {
      args.push(...opts.extraArgs)
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
      this.noteActivity(evt)
      if (this.waiters.length > 0) {
        const w = this.waiters.shift()!
        w(evt)
      } else if (this.snap.state === "busy" || keptBetweenTurns(evt)) {
        // Between asked turns only what the next turn reads is kept: a
        // process with background work can write for hours (#1861).
        this.pendingEvents.push(evt)
        if (this.snap.state !== "busy" && this.pendingEvents.length > MAX_PENDING_BETWEEN_TURNS) this.pendingEvents.shift()
      }
    }
  }

  /**
   * Record what the process does as it happens, whether or not a turn is
   * reading its events (#1560). Between asked turns the events wait in
   * pendingEvents, so without this the registry saw a process running a
   * turn of its own, or background builders, as idle and killed it.
   */
  private noteActivity(evt: ParsedEvent): void {
    this.background.observe(evt)
    let unaskedTurn = this.snap.unaskedTurn ?? false
    // An init while no asked turn is in flight starts a turn nobody asked
    // for; any result ends the turn that was running.
    if (evt.type === "system" && evt.subtype === "init" && this.snap.state !== "busy") unaskedTurn = true
    else if (evt.type === "result") unaskedTurn = false
    // A result while no asked turn is in flight is the reply of a turn
    // nobody asked for. Pass it on now: the next question may never come.
    const unaskedResult = evt.type === "result" && this.snap.state !== "busy"
    this.snap = {
      ...this.snap,
      lastActivityAt: Date.now(),
      backgroundTasks: this.background.pending,
      unaskedTurn,
    }
    if (unaskedResult) this.passUnaskedReply(evt)
  }

  /**
   * Hand the reply of a turn nobody asked for to the hook, once per result
   * (#1861). True when the hook has it, now or from before. The hook's
   * errors stay here: they must not break the stream or the next turn.
   */
  private passUnaskedReply(evt: ParsedEvent): boolean {
    if (this.passedOn.has(evt)) return true
    const hook = this.hooks.onUnaskedReply
    if (!hook) return false
    this.passedOn.add(evt)
    const sessionId = typeof evt.session_id === "string" ? evt.session_id : this.snap.claudeSessionId
    try {
      hook({
        key: this.key,
        text: typeof evt.result === "string" ? evt.result : "",
        ...(sessionId ? { sessionId } : {}),
        ...(typeof evt.total_cost_usd === "number" ? { costUsd: evt.total_cost_usd } : {}),
        at: Date.now(),
      })
    } catch (e: any) {
      this.log(`[claude pid=${this.snap.pid}] unasked reply handler failed: ${e?.message || e}`)
    }
    return true
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
