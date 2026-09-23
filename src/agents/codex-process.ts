import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import { createInterface } from "node:readline"

interface Options {
  key: string
  cwd: string
  env: NodeJS.ProcessEnv
  args: string[]
  model?: string
  bypass: boolean
  prompt: string
  resume?: string
  fresh?: boolean
  timeoutMs: number
  signal?: AbortSignal
  onEvent?: (event: any) => void
  onDelta?: (delta: string, text: string) => void
}
interface Result {
  content: string
  codexSessionId?: string
  billedModel?: string
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }
  error?: string
  duration: number
}
/** Only this error permits CLI fallback: no turn has been submitted. */
export class CodexUnavailable extends Error {}
type Spawn = (options: Options) => ChildProcessWithoutNullStreams
const launch: Spawn = (o) => spawn("codex", ["app-server", ...o.args], {
  cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"],
})

class Connection {
  child: ChildProcessWithoutNullStreams
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  nextId = 0
  dead = false
  busy = false
  threadId?: string
  idle?: NodeJS.Timeout
  notify?: (method: string, params: any) => void
  failTurn?: (e: Error) => void
  constructor(o: Options, launchProcess: Spawn) {
    this.child = launchProcess(o)
    this.child.stderr.resume() // Drain without exposing credentials or prompt text in logs.
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => {
      let msg: any
      try { msg = JSON.parse(line) } catch { return }
      if (msg.method && msg.id !== undefined) {
        // AgentX has no interactive approval bridge here. Fail closed.
        this.write({ id: msg.id, error: { code: -32601, message: "Interactive requests are not supported by AgentX" } })
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || "Codex RPC failed"))
        else p.resolve(msg.result)
      } else if (msg.method) this.notify?.(msg.method, msg.params)
    })
    this.child.on("error", (e) => this.close(e))
    this.child.stdin.on("error", (e) => this.close(e))
    this.child.on("exit", () => this.close(new Error("Codex app-server exited")))
  }
  write(message: any) { if (!this.dead) this.child.stdin.write(JSON.stringify(message) + "\n") }
  rpc(method: string, params: any): Promise<any> {
    if (this.dead) return Promise.reject(new Error("Codex connection closed"))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }
  close(error = new Error("Codex connection closed")) {
    if (this.dead) return
    this.dead = true
    clearTimeout(this.idle)
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
    this.failTurn?.(error)
    this.child.kill("SIGTERM")
    const kill = setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGKILL") }, 5000)
    kill.unref()
  }
}

/** One process per conversation and effective configuration. Busy entries are never evicted. */
export class CodexProcessPool {
  private entries = new Map<string, { fingerprint: string; connection: Connection }>()
  constructor(private launchProcess: Spawn = launch, private capacity = 8, private idleMs = 300_000) {}
  stop() {
    for (const { connection } of this.entries.values()) connection.close()
    this.entries.clear()
  }
  async run(o: Options): Promise<Result> {
    const start = Date.now()
    if (o.signal?.aborted) return { content: "", error: "task cancelled by operator", duration: 0 }
    // The hash includes environment (including MCP identity), but never logs its contents.
    const fingerprint = createHash("sha256").update(JSON.stringify([
      o.cwd, o.model, o.bypass, o.args, Object.entries(o.env).sort(([a], [b]) => a.localeCompare(b)),
    ])).digest("hex")
    let entry = this.entries.get(o.key)
    if (entry?.connection.busy) throw new CodexUnavailable("Conversation already running")
    if (entry && (entry.fingerprint !== fingerprint || o.fresh || entry.connection.dead)) {
      entry.connection.close()
      this.entries.delete(o.key)
      entry = undefined
    }
    const reused = !!entry
    if (!entry) {
      if (this.entries.size >= this.capacity) {
        const idle = [...this.entries].find(([, e]) => !e.connection.busy)
        if (!idle) throw new CodexUnavailable("Codex warm process capacity reached")
        idle[1].connection.close()
        this.entries.delete(idle[0])
      }
      try { entry = { fingerprint, connection: new Connection(o, this.launchProcess) } }
      catch { throw new CodexUnavailable("Could not start Codex app-server") }
      this.entries.set(o.key, entry)
    }
    const c = entry.connection
    c.busy = true
    clearTimeout(c.idle)
    let submitted = false
    let content = ""
    let finalText: string | undefined
    let threadId: string | undefined
    let usage: Result["usage"]
    let firstOutput = false
    const abort = () => c.close(new Error("task cancelled by operator"))
    o.signal?.addEventListener("abort", abort, { once: true })
    const deadline = setTimeout(() => c.close(new Error("Codex turn timed out")), o.timeoutMs)
    const startup = setTimeout(() => c.close(new Error("Codex initialization timed out")), 15_000)
    try {
      if (!reused) {
        await c.rpc("initialize", { clientInfo: { name: "agentx", version: "1.0.0" }, capabilities: {} })
        c.write({ method: "initialized", params: {} })
      }
      // Rejoin from the registry's session ID every turn. Without a resume ID,
      // start a new thread even when reusing a process: never infer conversation history.
      if (c.threadId && c.threadId !== o.resume) {
        await c.rpc("thread/unsubscribe", { threadId: c.threadId })
        c.threadId = undefined
      }
      const params = { cwd: o.cwd, model: o.model, approvalPolicy: "never",
        sandbox: o.bypass ? "danger-full-access" : "workspace-write" }
      const thread = await c.rpc(o.resume && !o.fresh ? "thread/resume" : "thread/start",
        { ...params, ...(o.resume && !o.fresh ? { threadId: o.resume } : {}) })
      threadId = thread.thread.id
      c.threadId = threadId
      clearTimeout(startup)
      o.onEvent?.({ type: "codex.ready", reused, startupMs: Date.now() - start, model: o.model })
      const completed = new Promise<void>((resolve, reject) => {
        c.failTurn = reject
        c.notify = (method, p) => {
          if (p?.threadId !== threadId) return
          const item = p.item
          const itemTypes: Record<string, string> = {
            agentMessage: "agent_message", commandExecution: "command_execution",
            fileChange: "file_change", mcpToolCall: "mcp_tool_call",
          }
          o.onEvent?.({ ...p, type: method.replace("/", "."),
            ...(item ? { item: { ...item, type: itemTypes[item.type] || item.type } } : {}) })
          if (method === "item/completed" && item?.type === "agentMessage" && item.phase === "final_answer") {
            finalText = item.text
          }
          if (method === "item/agentMessage/delta") {
            if (!firstOutput) {
              firstOutput = true
              o.onEvent?.({ type: "codex.first_output", elapsedMs: Date.now() - start, reused })
            }
            content += p.delta
            o.onDelta?.(p.delta, content)
          }
          if (method === "thread/tokenUsage/updated") {
            // `last` is ONE model call; a tool-using turn makes many, so sum
            // them (`total` spans the whole thread, which a resumed session
            // shares with earlier turns). OpenAI's inputTokens includes the
            // cached part; TokenUsage keeps them apart, Anthropic-style.
            const u = p.tokenUsage.last
            const cached = u.cachedInputTokens || 0
            usage = {
              inputTokens: (usage?.inputTokens || 0) + Math.max(0, (u.inputTokens || 0) - cached),
              outputTokens: (usage?.outputTokens || 0) + (u.outputTokens || 0),
              cacheReadTokens: (usage?.cacheReadTokens || 0) + cached,
              cacheCreateTokens: (usage?.cacheCreateTokens || 0) + (u.cacheWriteInputTokens || 0),
            }
          }
          if (method === "turn/completed") {
            if (p.turn.status === "completed") resolve()
            else reject(new Error(p.turn.error?.message || `Codex turn ${p.turn.status}`))
          }
        }
      })
      // Attach a rejection handler before dispatch: process exit can precede the RPC response.
      completed.catch(() => {})
      submitted = true
      await c.rpc("turn/start", { threadId, input: [{ type: "text", text: o.prompt, text_elements: [] }] })
      await completed
      return { content: finalText ?? content, codexSessionId: threadId, billedModel: o.model, usage, duration: Date.now() - start }
    } catch (e: any) {
      c.close()
      if (!submitted && !o.signal?.aborted) throw new CodexUnavailable(e.message)
      return { content, codexSessionId: threadId, usage, error: e.message, duration: Date.now() - start }
    } finally {
      clearTimeout(startup)
      clearTimeout(deadline)
      o.signal?.removeEventListener("abort", abort)
      c.notify = undefined
      c.failTurn = undefined
      c.busy = false
      if (c.dead) {
        if (this.entries.get(o.key)?.connection === c) this.entries.delete(o.key)
      }
      else {
        c.idle = setTimeout(() => { c.close(); this.entries.delete(o.key) }, this.idleMs)
        c.idle.unref()
      }
    }
  }
}
export const codexProcessPool = new CodexProcessPool()
