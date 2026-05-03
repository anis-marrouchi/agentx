// --- Process Registry: persistent claude processes per session ---
//
// Tracks one `claude -p --input-format stream-json` subprocess per
// (agentId, channel, chatId). Tasks for the same chat reuse the live
// process across turns; the empirical cache-amortization win is ~3-5×
// (turn 1 cache_create=12897, turn 2 cache_create=20 in the
// 2026-05-03 spike). When a chat goes idle past idleTimeoutMs the
// process is killed; when at the cap, the oldest idle process is
// evicted to make room.
//
// This file is the registry only. Real subprocess wiring (spawn,
// stdin write, stdout read) lives behind the ProcessFactory interface
// so the registry can be tested without spawning real children.
//
// Design rationale (see docs/architecture/persistent-claude-process.md):
//   - Process-per-session (not pool-per-agent) — perfect chat
//     isolation; same composite key as SessionStore.
//   - Slash commands DO NOT work in `-p` mode (verbatim from the
//     headless docs). Rotation = kill + respawn, optionally with an
//     application-level summary in --append-system-prompt.
//   - Concurrency: same-chat turns serialize through the handle's
//     own queue; different-chat turns are independent processes.

export interface ProcessKey {
  agentId: string
  channel: string
  chatId: string
}

export type ProcessKeyString = string

/** Stringify the key for Map storage / logging. The composite is the
 *  same one SessionStore uses, so process and session entries line up
 *  without an extra mapping table. */
export function processKeyToString(k: ProcessKey): ProcessKeyString {
  return `${k.agentId}:${k.channel}:${k.chatId}`
}

export function parseProcessKey(s: ProcessKeyString): ProcessKey {
  const [agentId, channel, ...rest] = s.split(":")
  return { agentId, channel, chatId: rest.join(":") }
}

/**
 * Lifecycle state of a process. Values are strings (not enum) so they
 * round-trip through JSON for `agentx process list` without an
 * encode/decode step.
 *
 *   warm-cold → spawned, no claudeSessionId yet
 *   warm-hot  → at least one turn done, cache reuse expected
 *   idle      → not running a turn, eligible for eviction
 *   dead      → killed or exited; will be removed from the registry
 */
export type ProcessState = "warm-cold" | "warm-hot" | "idle" | "dead"

export interface ProcessSnapshot {
  key: ProcessKey
  pid: number | null
  claudeSessionId: string | null
  state: ProcessState
  spawnedAt: number
  lastTurnAt: number
  turnCount: number
  /** Last result event's input_tokens — drives tier-2 rotation decisions. */
  lastInputTokens: number
  /** Trace ULID of the in-flight turn, when one is active. */
  pendingTaskId: string | null
  /** Reason the process is dead, when state === "dead". */
  deadReason?: string
}

export interface SpawnOptions {
  agentId: string
  channel: string
  chatId: string
  workspace: string
  model?: string
  permissionMode?: string
  systemPromptAppend?: string
  /** Pass-through to `claude --resume <id>`. Set when SessionStore has a
   *  stored claudeSessionId for this chat (e.g. across daemon restart). */
  resumeSessionId?: string
}

export interface TurnInput {
  /** User-facing text the parent wrote to stdin under
   *  `{type:"user", message:{role:"user", content:<here>}}`. */
  message: string
  /** Trace ULID for correlating events back to a task_traces row. */
  taskId: string
}

export interface TurnEvent {
  /** stream-json event type — one of "system" | "assistant" | "user" |
   *  "result" | "stream_event" | "rate_limit_event" | … */
  type: string
  /** Raw event line (parsed). Forwarded verbatim to the streaming
   *  parser in registry.ts so trace step capture stays unchanged. */
  raw: Record<string, unknown>
}

export interface ProcessHandle {
  readonly key: ProcessKey
  state(): ProcessState
  snapshot(): ProcessSnapshot
  /**
   * Send one user turn, yield stream-json events as they arrive, and
   * return when a `result` event is observed. The handle serializes
   * concurrent runTurn calls so two simultaneous tasks on the same
   * chat queue rather than racing.
   */
  runTurn(input: TurnInput): AsyncIterable<TurnEvent>
  /**
   * Kill the underlying process. SIGTERM, then SIGKILL after a grace
   * period. Resolves once the process is gone. `reason` shows up in
   * `agentx process list --include-dead` and the trace step.
   */
  kill(reason: string): Promise<void>
}

export interface ProcessFactory {
  /** Spawn (or fake) a process bound to `key` with `opts`. */
  spawn(key: ProcessKey, opts: SpawnOptions): ProcessHandle
}

/**
 * Thrown by `acquire` when at the global or per-agent cap and no idle
 * handle is evictable. Callers — typically the per-turn driver in
 * runtime.ts — catch this and fall back to spawn-per-task. Using a
 * named error class is more robust than message-sniffing.
 */
export class RegistryCapExceeded extends Error {
  constructor(
    message: string,
    public readonly scope: "global" | "agent",
    public readonly cap: number,
  ) {
    super(message)
    this.name = "RegistryCapExceeded"
  }
}

export interface ProcessRegistryConfig {
  /** Hard global cap. Default 64. When at cap, oldest idle handle is
   *  evicted to make room for the next acquire. */
  maxProcessesGlobal?: number
  /** Per-agent cap. Default 16. Prevents one chatty agent from
   *  starving another. */
  maxProcessesPerAgent?: number
  /** A handle is "idle" idleTimeoutMs after its last turn completed.
   *  Idle handles are eligible for eviction; once `staleTimeoutMs` is
   *  also exceeded, the handle is killed unconditionally on the next
   *  sweep. Defaults: 30s idle, 45min stale. */
  idleTimeoutMs?: number
  staleTimeoutMs?: number
  /** Sweep interval. Default 5_000 (5s). */
  sweepIntervalMs?: number
  factory: ProcessFactory
  log?: (msg: string) => void
}

export class ProcessRegistry {
  private handles = new Map<ProcessKeyString, ProcessHandle>()
  private sweeper?: ReturnType<typeof setInterval>
  private readonly cfg: Required<Omit<ProcessRegistryConfig, "factory" | "log">> & {
    factory: ProcessFactory
    log: (msg: string) => void
  }

  constructor(cfg: ProcessRegistryConfig) {
    this.cfg = {
      maxProcessesGlobal: cfg.maxProcessesGlobal ?? 64,
      maxProcessesPerAgent: cfg.maxProcessesPerAgent ?? 16,
      idleTimeoutMs: cfg.idleTimeoutMs ?? 30_000,
      staleTimeoutMs: cfg.staleTimeoutMs ?? 45 * 60 * 1000,
      sweepIntervalMs: cfg.sweepIntervalMs ?? 5_000,
      factory: cfg.factory,
      log: cfg.log ?? (() => {}),
    }
  }

  /** Begin the idle-eviction sweep timer. Idempotent. */
  start(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweepIdle(), this.cfg.sweepIntervalMs)
    if (typeof this.sweeper.unref === "function") this.sweeper.unref()
  }

  /**
   * Stop the sweeper and kill every live handle. Used on daemon
   * shutdown. Resolves when all kills complete.
   */
  async stop(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }
    const handles = Array.from(this.handles.values())
    this.handles.clear()
    await Promise.allSettled(handles.map((h) => h.kill("registry-stop")))
  }

  /**
   * Get-or-spawn a process for `key`. Spawns through the factory when
   * no handle exists. When at the global or per-agent cap, evicts the
   * oldest idle handle to make room; throws if no idle handle is
   * available (caller can fall back to spawn-per-task or queue).
   */
  acquire(key: ProcessKey, opts: SpawnOptions): ProcessHandle {
    const ks = processKeyToString(key)
    const existing = this.handles.get(ks)
    if (existing && existing.state() !== "dead") return existing

    // Make room if at cap.
    if (this.handles.size >= this.cfg.maxProcessesGlobal) {
      this.evictOldestIdle({ scope: "global" })
    }
    const perAgentCount = this.countForAgent(key.agentId)
    if (perAgentCount >= this.cfg.maxProcessesPerAgent) {
      this.evictOldestIdle({ scope: "agent", agentId: key.agentId })
    }
    if (this.handles.size >= this.cfg.maxProcessesGlobal) {
      throw new RegistryCapExceeded(
        `process registry at global cap (${this.cfg.maxProcessesGlobal}) and no idle handle to evict`,
        "global",
        this.cfg.maxProcessesGlobal,
      )
    }
    if (this.countForAgent(key.agentId) >= this.cfg.maxProcessesPerAgent) {
      throw new RegistryCapExceeded(
        `process registry at per-agent cap for ${key.agentId} (${this.cfg.maxProcessesPerAgent}) and no idle handle to evict`,
        "agent",
        this.cfg.maxProcessesPerAgent,
      )
    }

    const handle = this.cfg.factory.spawn(key, opts)
    this.handles.set(ks, handle)
    this.cfg.log(`[process-registry] spawned ${ks}`)
    return handle
  }

  /**
   * Drop a key from the registry, optionally killing the process.
   * Without `kill: true`, the handle stays alive — useful when the
   * caller wants the registry to forget about it (e.g. config reload)
   * but the in-flight turn should finish.
   */
  release(key: ProcessKey, opts: { kill?: boolean; reason?: string } = {}): void {
    const ks = processKeyToString(key)
    const handle = this.handles.get(ks)
    if (!handle) return
    this.handles.delete(ks)
    if (opts.kill) {
      void handle.kill(opts.reason ?? "release")
    }
  }

  /** Operator surface: snapshot every live handle. */
  list(): ProcessSnapshot[] {
    return Array.from(this.handles.values()).map((h) => h.snapshot())
  }

  /** Force-kill one handle, removing it from the registry. */
  async kill(key: ProcessKey, reason = "operator"): Promise<void> {
    const ks = processKeyToString(key)
    const handle = this.handles.get(ks)
    if (!handle) return
    this.handles.delete(ks)
    await handle.kill(reason)
  }

  // ---------- internals ----------

  private countForAgent(agentId: string): number {
    let n = 0
    for (const h of this.handles.values()) {
      if (h.key.agentId === agentId && h.state() !== "dead") n += 1
    }
    return n
  }

  /**
   * Evict the oldest idle handle in the requested scope. "Oldest" is
   * defined by lastTurnAt (LRU). Returns true when one was evicted.
   * No-op when no idle handle is found — the caller is responsible
   * for the cap-exceeded error path.
   */
  private evictOldestIdle(scope: { scope: "global" } | { scope: "agent"; agentId: string }): boolean {
    let target: ProcessHandle | undefined
    let oldest = Number.POSITIVE_INFINITY
    for (const h of this.handles.values()) {
      if (h.state() !== "idle") continue
      if (scope.scope === "agent" && h.key.agentId !== scope.agentId) continue
      const ts = h.snapshot().lastTurnAt
      if (ts < oldest) {
        oldest = ts
        target = h
      }
    }
    if (!target) return false
    const ks = processKeyToString(target.key)
    this.handles.delete(ks)
    void target.kill("evicted (cap reached)")
    this.cfg.log(`[process-registry] evicted ${ks} (cap)`)
    return true
  }

  /** Per-tick sweep — kill processes idle past the timeout. */
  private sweepIdle(): void {
    const now = Date.now()
    for (const [ks, h] of this.handles.entries()) {
      const snap = h.snapshot()
      if (h.state() === "dead") {
        this.handles.delete(ks)
        this.cfg.log(`[process-registry] reaped dead ${ks}`)
        continue
      }
      if (h.state() !== "idle") continue
      const idleFor = now - snap.lastTurnAt
      if (idleFor >= this.cfg.staleTimeoutMs) {
        this.handles.delete(ks)
        void h.kill(`stale (idle ${Math.round(idleFor / 1000)}s)`)
        this.cfg.log(`[process-registry] killed stale ${ks}`)
      } else if (idleFor >= this.cfg.idleTimeoutMs) {
        this.handles.delete(ks)
        void h.kill(`idle (${Math.round(idleFor / 1000)}s)`)
        this.cfg.log(`[process-registry] killed idle ${ks}`)
      }
    }
  }
}
