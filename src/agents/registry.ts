import type { DaemonConfig, AgentDef } from "@/daemon/config"
import { executeTask, type AgentTask, type AgentResponse, type StreamCallback, type AgentPeer } from "./runtime"
import { friendlyModelError, renderFriendlyError } from "./error-map"
import { SessionStore, detectLongMemoryHint } from "./sessions"
import { WikiHub } from "@/wiki"
import { RateLimiter } from "@/daemon/rate-limit"
import { TokenTracker, splitTaskUsageByTier } from "@/daemon/token-tracker"
import { buildAgentContext, type ContextInput } from "./context"
import { Classifier, GraphStore, type ClassifyResult } from "@/graph"
import { HandoverStore } from "@/channels/handover-store"
import { MemoryStore } from "./memory-store"
import { AgentMemory } from "./agent-memory"
import { extractMemories } from "./memory-extract"
import { MessageQueue, type QueueMode, type QueuedMessage } from "./message-queue"
import { loadBootstrapFiles, buildBootstrapContext, detectSoulSwitch, listSoulProfiles } from "./bootstrap"
import { PatternStore, extractPatterns } from "./patterns"
import { loadReferences, renderReferences } from "./references/loader"
import { getDefaultLedger } from "@/intent/instance"
import { loadRecipes, resolveRecipes, type RecipeIndex } from "./references/recipes"
import type { ReferenceIndex } from "./references/types"
import { getEventBus } from "@/events/bus"
import { newEventId } from "@/intent/ulid"
import { debug } from "@/observability/debug"
import type { LandscapeBuilder } from "./landscape"
import { preflightOverageGate } from "./overage-status"
import { getProcessRegistry } from "./process-registry-instance"
import { preflightQuotaGate, recordClaudeCodeDispatch, warnIfNearingCap, setDispatchBudget } from "./claude-code-quota"
import { promptSizeKey, recordPromptSize, warnIfPromptGrowing } from "./prompt-size-tracker"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { WorkflowStore, matchWorkflow } from "@/workflows"

// --- Agent Registry: lifecycle management + concurrency control ---

/**
 * Context Surgery — coding-channel detector. A `claude-code` or `codex-cli`
 * tier agent triggered by a github/gitlab webhook is doing focused code work
 * on one issue/PR. The mesh-peer landscape and full session-history aren't
 * useful in that context and bias the agent on noise.
 */
function isCodingChannelContext(channel: string, tier: string): boolean {
  if (tier !== "claude-code" && tier !== "codex-cli") return false
  return channel === "github" || channel === "gitlab"
}

/** Global singleton for sub-agent spawning from tools */
let globalRegistry: AgentRegistry | undefined

export function setGlobalRegistry(registry: AgentRegistry): void {
  globalRegistry = registry
}

export function getGlobalRegistry(): AgentRegistry | undefined {
  return globalRegistry
}

export interface RunningTask {
  /** Unique id for this execution (timestamp-based). */
  id: string
  /** First 200 chars of the user message, for display. */
  messagePreview: string
  /** Origin channel (telegram, whatsapp, gitlab, api, cron, business, a2a, …). */
  channel: string
  /** Group / chat / issue id from which the task arrived. */
  chatId?: string
  /** Sender id/name (user, agent id, "cron:<id>", "mesh:<peer>", …). */
  sender?: string
  /** Wall-clock start. */
  startedAt: Date
}

type TaskOutputSubscriber = (chunk: string) => void

interface TaskOutput {
  agentId: string
  buffer: string
  subscribers: Set<TaskOutputSubscriber>
  done: boolean
  endedAt?: Date
}

/** Cap per-task buffer to keep memory bounded; recent tail wins. */
const TASK_OUTPUT_BUFFER_MAX = 64 * 1024
/** Keep finished outputs around briefly so a late opener still gets the tail. */
const TASK_OUTPUT_TTL_MS = 5 * 60 * 1000

/** Persisted record of a finished task, written to .agentx/task-history. */
export interface TaskRecord {
  id: string
  agentId: string
  channel: string
  chatId?: string
  sender?: string
  message: string
  startedAt: string
  endedAt: string
  durationMs: number
  ok: boolean
  error?: string
  /** Final agent text (one-shot, may be empty if streaming captured it). */
  responseText: string
  /** Terminal-style transcript captured from stream-json events. */
  transcript: string
}

const TASK_HISTORY_DIR = ".agentx/task-history"
/** Default retention for persisted task records. Set for business audit trails;
 *  bump via the `dashboard.taskHistoryRetentionDays` config field if you need more. */
const TASK_HISTORY_RETENTION_DAYS = 30

/** Truncate long values so the buffer doesn't blow up on huge tool inputs/outputs. */
function clip(s: string, max = 800): string {
  if (s.length <= max) return s
  return s.slice(0, max) + ` …[+${s.length - max} chars]`
}

/**
 * Phase 3 wiki layer — compact pointer to the `agentx wiki query` tool.
 * The wiki is the cross-agent institutional-knowledge source of truth.
 * Agents call it themselves when the question is about "who / what
 * happened / what we decided / how we do X." Empty when the agent has no
 * catalog yet, so new installs see no noise.
 *
 * Uses an absolute CLI path because `agentx` is not on PATH in the agent
 * workspaces. `process.argv[1]` points at the running daemon's cli.js.
 */
function buildWikiQueryHint(agentWiki: ReturnType<WikiHub["getAgentWiki"]>, agentId: string): string {
  let articleCount = 0
  try {
    articleCount = agentWiki.listArticles(agentId).length
  } catch {
    return ""
  }
  if (articleCount === 0) return ""
  const catalogPath = resolve(agentWiki.baseDir, "_index.md")
  if (!existsSync(catalogPath)) return ""
  const cli = process.argv[1] || "dist/cli.js"
  const wikiDir = agentWiki.baseDir.replace(new RegExp(`/agents/${agentId}(/[^/]+)?$`), "")
  return [
    "[Institutional Wiki — cross-agent source of truth]",
    `A curated wiki with ${articleCount} article${articleCount === 1 ? "" : "s"} grouped by type: person, project, place, concept, event, decision, pattern.`,
    "",
    "The wiki is the canonical source for: who people are (team, clients, agents), past events (incidents, deploys), decisions and their reasoning, documented procedures, patterns.",
    "",
    "BEFORE you grep the workspace, search memory, or answer from your own prior context — if the question is about who / what happened / what we decided / how we do X, call:",
    `  node ${cli} wiki query "the user's question" --dir ${wikiDir} --agent ${agentId}`,
    "",
    "It walks the catalog + wikilink graph and returns a cited answer. Your workspace memory is local to you; the wiki is shared and authoritative. Prefer the wiki for institutional questions; prefer your workspace for code-level questions.",
    "[End Institutional Wiki]",
  ].join("\n")
}

/**
 * Format raw Claude Code stream-json events into a terminal-style transcript
 * for the dashboard streaming modal. Returns "" for events we don't surface.
 *
 * Stateful so we can emit only the *delta* of assistant text across consecutive
 * `assistant` snapshot events (Claude re-sends the cumulative content each tick).
 */
/**
 * Cap a string at the configured byte budget, suffixing with "…[+N]" when
 * truncated so the trace reader knows there's more upstream. 8KB lets us
 * keep a useful preview of e.g. a Bash tool's stdout while bounding the
 * row size — anything larger almost always exceeds operator attention.
 */
export const TRACE_STEP_SUMMARY_BYTES = 8 * 1024
export function clipForTrace(s: string): string {
  if (s.length <= TRACE_STEP_SUMMARY_BYTES) return s
  const remaining = s.length - TRACE_STEP_SUMMARY_BYTES
  return s.slice(0, TRACE_STEP_SUMMARY_BYTES) + `…[+${remaining}]`
}

/**
 * Translate a Claude stream-json event into zero-or-more task:step bus
 * events. Mirrors the block walks in makeStreamEventFormatter but emits
 * structured rows for SQLite persistence rather than terminal text.
 *
 * Why a separate function (and not extending the formatter)? Two
 * concerns. The formatter is for the dashboard's live terminal modal —
 * its output is a string and its job is to read like a transcript. The
 * trace store wants typed rows that survive a daemon restart. Keeping
 * them separate means future refactors of either don't ripple.
 */
/**
 * Tally a single stream event's tool_use blocks into the running per-task
 * counter. Mirrors the block walks used elsewhere — assistant.tool_use
 * fires once per tool the model invoked. Called from the same onEvent
 * pipeline that drives trace step capture, so there's no extra parse pass.
 */
export function tallyToolUses(counter: Map<string, number>, event: any): void {
  if (!event || typeof event !== "object") return
  if (event.type !== "assistant") return
  const blocks = event.message?.content
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    if (block?.type !== "tool_use") continue
    const name = typeof block.name === "string" ? block.name : ""
    if (!name) continue
    counter.set(name, (counter.get(name) ?? 0) + 1)
  }
}

/**
 * Improvement plan #3 — given an agent's `toolUseRequired` list and the
 * tally of tool_use invocations from this task, return the FIRST tool
 * name that wasn't invoked, or null when the contract was satisfied.
 *
 * Empty / unset toolUseRequired → null (no enforcement). Non-empty list
 * with at least one missing tool → the missing tool name; the caller
 * surfaces this as `tool_required_not_called: <name>` so retry logic
 * can distinguish "model didn't follow the tool-use contract" from
 * other error shapes.
 */
export function firstMissingRequiredTool(
  required: string[] | undefined,
  invoked: Map<string, number>,
): string | null {
  if (!required || required.length === 0) return null
  for (const name of required) {
    if ((invoked.get(name) ?? 0) === 0) return name
  }
  return null
}

export function emitTraceStepsFromStreamEvent(taskId: string, agentId: string, event: any): void {
  if (!event || typeof event !== "object") return
  const t = event.type
  const at = new Date().toISOString()
  const bus = getEventBus()

  if (t === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use") {
        const inputJson = block.input != null ? JSON.stringify(block.input) : ""
        bus.emit("task:step", {
          taskId,
          agentId,
          name: "tool_use",
          action: typeof block.name === "string" ? block.name : null,
          status: "in-flight",
          inputSummary: inputJson ? clipForTrace(inputJson) : null,
          at,
        } as any)
      }
    }
    return
  }
  if (t === "user" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_result") {
        const content = Array.isArray(block.content)
          ? block.content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
          : typeof block.content === "string" ? block.content : ""
        bus.emit("task:step", {
          taskId,
          agentId,
          // Action mirrors the originating tool name when Claude provides
          // tool_use_id. We don't have a quick lookup here without
          // threading more state, so leave action null and let consumers
          // pair via tool_use_id if they care.
          name: "tool_result",
          status: block.is_error ? "error" : "ok",
          outputSummary: content ? clipForTrace(content) : null,
          at,
        } as any)
      }
    }
    return
  }
}

function makeStreamEventFormatter(): (event: any) => string {
  let textSeen = ""
  let codexTextSeen = ""
  return (event: any): string => {
    if (!event || typeof event !== "object") return ""
    const t = event.type
    if (t === "codex.spawned") {
      const model = event.model ? ` model=${event.model}` : ""
      const resume = event.resumeSessionId ? ` resume=${String(event.resumeSessionId).slice(0, 8)}` : ""
      return `. codex started${model}${resume}\n`
    }
    if (t === "thread.started") {
      const tid = event.thread_id ? ` thread=${String(event.thread_id).slice(0, 8)}` : ""
      return `. codex thread started${tid}\n`
    }
    if (t === "turn.started") return ". codex turn started\n"
    if (t === "turn.completed") {
      const usage = event.usage || {}
      const input = usage.input_tokens ?? usage.inputTokens
      const output = usage.output_tokens ?? usage.outputTokens
      const tokens = input || output ? ` input=${input || 0} output=${output || 0}` : ""
      return `. codex turn completed${tokens}\n`
    }
    if (t === "item.started" || t === "item.completed") {
      const item = event.item || {}
      if (item.type === "agent_message" && typeof item.text === "string") {
        const text = item.text
        const delta = text.startsWith(codexTextSeen) ? text.slice(codexTextSeen.length) : text
        codexTextSeen = text.startsWith(codexTextSeen) ? text : codexTextSeen + text
        return delta
      }
      const label = item.type || "item"
      const name = item.name || item.command || item.tool_name || item.id || ""
      if (t === "item.started") return `\n> codex ${label}${name ? ` ${name}` : ""}\n`
      const summary = item.output || item.result || item.text || item.error || ""
      return `< codex ${label}${name ? ` ${name}` : ""}${summary ? `: ${clip(String(summary), 800)}` : ""}\n`
    }
    if (t === "error" || t === "turn.failed") {
      const msg = event.message || event.error || event.reason || JSON.stringify(event)
      return `[error] ${clip(String(msg), 800)}\n`
    }
    if (t === "system" && event.subtype === "init") {
      const m = event.model ? ` model=${event.model}` : ""
      const sid = event.session_id ? ` session=${event.session_id.slice(0, 8)}` : ""
      return `· init${m}${sid}\n`
    }
    if (t === "assistant" && event.message?.content) {
      let out = ""
      for (const block of event.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.length > textSeen.length) {
            out += block.text.slice(textSeen.length)
            textSeen = block.text
          }
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          out += `\n💭 ${clip(block.thinking, 600)}\n`
        } else if (block.type === "tool_use") {
          const name = block.name || "tool"
          const input = block.input ? clip(JSON.stringify(block.input), 400) : ""
          out += `\n→ ${name}(${input})\n`
        }
      }
      return out
    }
    if (t === "user" && event.message?.content) {
      let out = ""
      for (const block of event.message.content) {
        if (block.type === "tool_result") {
          const c = Array.isArray(block.content)
            ? block.content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
            : typeof block.content === "string" ? block.content : ""
          const flag = block.is_error ? "← [error] " : "← "
          out += `${flag}${clip(c, 800)}\n`
        }
      }
      return out
    }
    if (t === "result") {
      const dur = event.duration_ms ? ` (${Math.round(event.duration_ms / 1000)}s)` : ""
      return `· done${dur}\n`
    }
    return ""
  }
}

interface AgentState {
  id: string
  def: AgentDef
  activeTasks: number
  totalTasks: number
  lastActive?: Date
  errors: number
  runningTasks: RunningTask[]
}

export class AgentRegistry {
  private agents: Map<string, AgentState> = new Map()
  private config: DaemonConfig
  private providers: Record<string, { apiKey?: string }> = {}
  private sessions: SessionStore
  private wikiHub: WikiHub
  private memoryStore: MemoryStore
  /** Structured per-agent memory (Claude-Code-style: user / feedback /
   *  project / reference). Separate from the BM25 fact store above —
   *  that's for short-lived facts extracted from conversations; this is
   *  for long-lived behavioural memory that inlines into the system
   *  prompt on every task. */
  readonly agentMemory: AgentMemory = new AgentMemory()
  private patternStore: PatternStore
  private rateLimiter: RateLimiter
  private tokenTracker: TokenTracker
  private landscape?: LandscapeBuilder
  /** Mesh handle. When set, `execute` falls back to a peer that advertises
   *  the requested agent before returning "Unknown agent". Duck-typed so
   *  we don't create a circular import with src/a2a/mesh.ts. */
  private meshFallback?: {
    findPeerWithSkill: (skillId: string) => { peer: { url: string; token?: string } } | undefined
    sendTask: (peerName: string, text: string, agentId?: string, opts?: { timeoutMs?: number }) => Promise<string>
    directory: () => Array<{ peer: string; healthy: boolean; skills: Array<{ id: string }> }>
  }
  /** Workflow auto-runner — invoked when workflow matching is in `mode: "auto"`
   *  and a candidate workflow's confidence ≥ autoRunThreshold. Wired by the
   *  daemon after the workflow dispatcher is constructed. Returns the runId of
   *  the started workflow run; the workflow itself owns posting any reply via
   *  its `action.send` / `agent` nodes. Duck-typed to avoid a circular import
   *  on WorkflowDispatcher. */
  private workflowAutoRunner?: (input: {
    workflowId: string
    agentId: string
    channel: string
    chatId: string
    message: string
    payload: Record<string, unknown>
  }) => Promise<{ runId?: string }>
  private messageQueue: MessageQueue
  /** Intent Knowledge Graph classifier. Null when graph.enabled=false. */
  private classifier?: Classifier
  private graphStore?: GraphStore
  /** Runtime handover store — shared with MessageRouter via file on disk. */
  private handoverStore: HandoverStore = new HandoverStore()
  /** Active soul profile per agent+chat session: "agentId:channel:chatId" → profile name */
  private activeSouls: Map<string, string> = new Map()
  /** Live output captured per running task id — drives the dashboard streaming modal. */
  private taskOutputs: Map<string, TaskOutput> = new Map()
  /** Per-running-task AbortController. Set when execution starts, removed in
   *  finally. Cancel paths (operator stop / replace) call .abort() and the
   *  runtime kills the underlying claude subprocess.
   *
   *  `originalMessage` is captured so the operator follow-up flow can frame
   *  the replacement as "correction to this prior ask" — without it, the
   *  agent just sees two bare user messages in a row and the second one is
   *  ambiguous (saw a real bug where "Count up to 30" + "up to 20" was
   *  interpreted as "list top-20 CPU hogs"). */
  private taskAborts: Map<string, { agentId: string; channel: string; chatId: string; originalMessage: string; controller: AbortController }> = new Map()
  /** Last completed task summary per agent — single-line blurb for the dashboard card. */
  private lastSummaries: Map<string, { text: string; at: Date; ok: boolean }> = new Map()
  /** 24-hour sparkline cache per agent — recomputed from disk at most once a minute. */
  private sparklineCache: Map<string, { hourly: number[]; at: number }> = new Map()
  /** Per-workspace references registry cache. Loaded lazily on first turn for
   *  agents with `contextReferences: true`; reused for the daemon's lifetime
   *  (operator-edited registries take effect on next daemon restart — same
   *  policy as agentx.json). */
  private referencesCache: Map<string, { refs: ReferenceIndex; recipes: RecipeIndex }> = new Map()
  private log: (...args: unknown[]) => void

  constructor(
    config: DaemonConfig,
    log: (...args: unknown[]) => void = console.error.bind(console, "[agents]"),
  ) {
    this.log = log
    this.config = config
    this.providers = config.providers
    this.sessions = new SessionStore(process.cwd(), {
      staleMinutes: config.session.staleMinutes,
      maxTurnsPerSession: config.session.maxTurnsPerSession,
      tierTwoThresholdTokens: config.session.tierTwoThresholdTokens,
    })
    this.wikiHub = new WikiHub(undefined, undefined, "unified")
    this.memoryStore = new MemoryStore()
    this.patternStore = new PatternStore()
    this.rateLimiter = new RateLimiter()
    this.tokenTracker = new TokenTracker()
    this.messageQueue = new MessageQueue()

    // Apply the claude-code fleet dispatch budget. See DaemonConfig.session
    // for the tuning knobs. Pools all claude-code agents under one counter
    // because they share the Max OAuth.
    setDispatchBudget({
      maxPerHour: config.session.maxClaudeCodeDispatchesPerHour,
      maxPer5h: config.session.maxClaudeCodeDispatchesPer5h,
    })

    if (config.graph?.enabled) {
      this.graphStore = new GraphStore({
        baseDir: resolve(process.cwd(), config.graph.baseDir),
        log: (...a) => log("[graph]", ...a),
      })
      const draftAgent = config.graph.draftAgent || config.dashboard?.draftAgent
      this.classifier = new Classifier({
        store: this.graphStore,
        daemonUrl: config.dashboard.daemonUrl,
        token: config.dashboard.token,
        draftAgent,
        autoApproveStructure: config.graph.autoApproveStructure,
        autoApproveConfidence: config.graph.autoApproveConfidence,
        classifierModel: config.graph.classifierModel,
        log: (...a) => log("[classifier]", ...a),
      })
    }

    for (const [id, def] of Object.entries(config.agents)) {
      this.agents.set(id, {
        id,
        def,
        activeTasks: 0,
        totalTasks: 0,
        errors: 0,
        runningTasks: [],
      })
    }
  }

  /**
   * Set landscape builder (called after mesh init).
   */
  setLandscape(builder: LandscapeBuilder): void {
    this.landscape = builder
  }

  /** Wire the mesh so `execute` can fall back to a peer that hosts an
   *  agent this node doesn't have. Called by the daemon after mesh boot.
   *  Pass `undefined` to disable fallback (testing, mesh disabled). */
  setMeshFallback(mesh: NonNullable<AgentRegistry["meshFallback"]>): void {
    this.meshFallback = mesh
  }

  /** Wire the workflow auto-runner — see field doc above. Daemon calls this
   *  after WorkflowDispatcher boot. Pass undefined to detach (e.g. during
   *  reload). */
  setWorkflowAutoRunner(runner: NonNullable<AgentRegistry["workflowAutoRunner"]> | undefined): void {
    this.workflowAutoRunner = runner
  }

  /** Hot-swap the provider map. Daemon reload calls this after agentx.json
   *  changes — the next task that executes will resolve credentials through
   *  the fresh table (see executeTask call-site). In-flight tasks keep the
   *  old provider reference from their closure, which is the desired behavior
   *  (rotating a key mid-task shouldn't fail the task). */
  setProviders(next: Record<string, { apiKey?: string }>): void {
    this.providers = next
  }

  /** Hot-swap the live DaemonConfig reference. Registry reads it lazily at
   *  execute-time for landscape + session policies, so next-task semantics
   *  match setProviders. */
  setConfig(next: DaemonConfig): void {
    this.config = next
  }

  /**
   * If there's an active handover routing TO this agent for this (channel,
   * chatId) pair AND the operator's summary hasn't been consumed yet, pull
   * + clear it so the target agent sees the note exactly once.
   */
  private buildHandoverNote(
    agentId: string,
    channel: string,
    chatId: string,
  ): ContextInput["handoverNote"] {
    const o = this.handoverStore.get(channel, chatId)
    if (!o || o.toAgent !== agentId) return undefined
    const summary = this.handoverStore.consumeSummary(channel, chatId)
    // If already consumed on a prior message, skip — route remains active
    // but no repeated briefing in every turn.
    if (!summary && o.summaryConsumedAt) return undefined
    return {
      fromAgent: o.fromAgent,
      summary: summary || o.summary,
      at: o.createdAt,
    }
  }

  /**
   * Get agent definition by ID.
   */
  getAgent(id: string): AgentDef | undefined {
    return this.agents.get(id)?.def
  }

  /**
   * Find agent by mention pattern (e.g., "@my_bot" -> "my-agent").
   * Returns the agent with the longest (most specific) mention match.
   *
   * When `atMentionsOnly` is true, only `@`-prefixed mentions are considered.
   * This is used for messages originating from another bot (cross-daemon
   * Telegram cascades, for example) where we don't want bare-word matches
   * like "nadia" in prose or "devops-mtgl" quoted in a reply to trigger
   * agents spuriously. Intentional handoffs still work because agents
   * write explicit `@noqta_X_bot` handles.
   */
  findByMention(text: string, opts: { atMentionsOnly?: boolean } = {}): string | undefined {
    const lower = text.toLowerCase()
    let bestId: string | undefined
    let bestLen = 0

    for (const [id, state] of this.agents) {
      for (const mention of state.def.mentions) {
        if (opts.atMentionsOnly && !mention.startsWith("@")) continue
        const mentionLower = mention.toLowerCase()
        if (lower.includes(mentionLower) && mentionLower.length > bestLen) {
          bestId = id
          bestLen = mentionLower.length
        }
      }
    }

    return bestId
  }

  /**
   * Find ALL agents mentioned in text (for bot-to-bot detection).
   */
  findAllMentioned(text: string): string[] {
    const lower = text.toLowerCase()
    const found: string[] = []

    for (const [id, state] of this.agents) {
      for (const mention of state.def.mentions) {
        if (lower.includes(mention.toLowerCase())) {
          found.push(id)
          break
        }
      }
    }

    return found
  }

  /** Wiki hub accessor. */
  getWikiHub(): WikiHub { return this.wikiHub }
  getGraphStore(): GraphStore | undefined { return this.graphStore }
  /** Session-store accessor — used by the /recall HTTP endpoint to expose
   *  conversation history to agents that need to rebuild context. */
  getSessionStore(): SessionStore { return this.sessions }

  /** Fire-and-forget pre-rotation memo capture. Spawns a one-shot Haiku
   *  call against the about-to-be-dropped Claude session asking for the
   *  facts/decisions worth carrying forward, persists the result into
   *  MemoryStore. Runs asynchronously so the calling rotation path
   *  doesn't pay the extraction latency — the next user turn dispatches
   *  immediately on the fresh session, and the memo lands in time for
   *  whichever turn arrives ~30s later (which is when atlas's bloated-
   *  session WhatsApp conversations actually need it).
   *
   *  Errors are swallowed by design — memory continuity is best-effort,
   *  it must never block or break the rotation it's hooked into. */
  private async captureRotationMemoAsync(
    agentId: string,
    def: AgentDef,
    resumeSessionId: string,
    channel: string,
    chatId: string,
    reason: string,
  ): Promise<void> {
    try {
      const { extractRotationMemo } = await import("./rotation-memo")
      const result = await extractRotationMemo(def, resumeSessionId)
      if (!result.memo) {
        this.log(
          `[${agentId}] rotation memo skipped (${reason}, ${result.reason}, ${result.durationMs}ms)`,
        )
        return
      }
      // Pull a few keywords from the chatId / channel so the memo
      // surfaces from MemoryStore.findRelevant when the same chat
      // continues. Without keywords BM25 has nothing to score against
      // and the memo only floats up via the recent-fallback branch.
      const chatKeyword = chatId.split(/[:@.]/).filter(Boolean).slice(0, 4)
      this.memoryStore.addMemory(agentId, {
        agentId,
        category: "fact",
        content: `[Rotation memo · ${reason}] ${result.memo}`,
        keywords: ["rotation-memo", channel, ...chatKeyword],
        source: { channel, chatId, sender: "system:rotation", date: new Date().toISOString().slice(0, 10) },
      })
      this.log(
        `[${agentId}] rotation memo captured (${reason}, ${result.durationMs}ms, ${result.memo.length} chars)`,
      )
    } catch (e: any) {
      this.log(`rotation memo error: ${e?.message || e}`)
    }
  }

  /**
   * Build peer list for context engine.
   */
  private buildPeerList(agentId: string, channel?: string): Array<{ name: string; handle?: string; role?: string }> {
    const peers: Array<{ name: string; handle?: string; role?: string }> = []
    for (const [id, state] of this.agents) {
      if (id === agentId) continue
      peers.push({
        name: state.def.name,
        handle: this.getChannelHandle(id, channel),
        role: state.def.systemPrompt?.split("\n")[0]?.slice(0, 80),
      })
    }
    return peers
  }

  /**
   * Get the primary channel handle for an agent (e.g. "@my_bot" on telegram).
   */
  private getChannelHandle(agentId: string, channel?: string): string | undefined {
    const agent = this.agents.get(agentId)?.def
    if (!agent) return undefined

    // For telegram, find the mention that starts with @ (bot username)
    if (channel === "telegram") {
      return agent.mentions.find((m) => m.startsWith("@"))
    }

    // Fallback: first mention
    return agent.mentions[0]
  }

  /**
   * Execute a task on an agent. Respects maxConcurrent limit.
   *
   * Wraps `executeInternal` to record an intent-ledger resolution
   * after completion when `task.intentRef` is set. The resolution
   * write clears the dispatched-but-unresolved slot in
   * `intent_decisions` so Inv-ActiveTaskSafety lookups stop blocking
   * subsequent dispatches to the same (project, subject). Without
   * this, every dispatched decision sits in-flight forever and the
   * active-task check becomes vacuously over-aggressive.
   */
  async execute(task: AgentTask, onDelta?: StreamCallback): Promise<AgentResponse> {
    const startedAt = Date.now()
    let response: AgentResponse
    try {
      response = await this.executeInternal(task, onDelta)
    } catch (e: any) {
      response = { content: "", error: e?.message ?? String(e) }
    }
    if (task.intentRef) {
      try {
        const status = response.error
          ? (/timed out|timeout/i.test(response.error) ? "timed-out" : "failed")
          : "completed"
        getDefaultLedger().recordResolution({
          decisionEventId: task.intentRef.eventId,
          decisionDecidedBy: task.intentRef.decidedBy,
          resolvedAt: Date.now(),
          status: status as "completed" | "failed" | "timed-out",
          durationMs: Date.now() - startedAt,
          resultSummary: response.error
            ? response.error.slice(0, 200)
            : (response.content?.slice(0, 200) ?? null),
        })
      } catch (e: any) {
        // Non-fatal — the ledger may have a unique-constraint hit (the
        // resolution was already recorded by a prior call), or the
        // ledger may have failed entirely. Either way, agent dispatch
        // must succeed regardless.
        this.log(`[ledger] resolution write failed for ${task.intentRef.eventId}/${task.intentRef.decidedBy}: ${e?.message ?? e}`)
      }
    }
    return response
  }

  /**
   * Internal dispatcher — the real body. See `execute` for the public
   * wrapper that adds intent-ledger resolution recording.
   */
  private async executeInternal(task: AgentTask, onDelta?: StreamCallback): Promise<AgentResponse> {
    const state = this.agents.get(task.agentId)
    if (!state) {
      // Mesh fallback: the agent isn't local but a healthy peer may host
      // it. Look it up in the mesh directory and forward via A2A sendTask.
      // Streaming callbacks are dropped — sendTask doesn't stream today.
      if (this.meshFallback) {
        const peerEntry = this.meshFallback.directory().find(
          (p) => p.healthy && p.skills.some((s) => s.id === task.agentId),
        )
        if (peerEntry) {
          this.log(`[${task.agentId}] not local — routing to mesh peer "${peerEntry.peer}"`)
          try {
            // Agent tasks can run for minutes. If the caller (workflow
            // agent node) passed a timeoutMinutes, honour it; otherwise
            // mesh.sendTask defaults to 30 minutes which beats Node's
            // 300s fetch default that was silently aborting long runs.
            const timeoutMs = typeof task.timeoutMinutes === "number" && task.timeoutMinutes > 0
              ? task.timeoutMinutes * 60 * 1000
              : undefined
            const content = await this.meshFallback.sendTask(peerEntry.peer, task.message, task.agentId, { timeoutMs })
            return { content, viaMesh: peerEntry.peer } as AgentResponse
          } catch (e: any) {
            this.log(`[${task.agentId}] mesh fallback to "${peerEntry.peer}" failed: ${e?.message ?? e}`)
            return { content: "", error: `mesh fallback failed: ${e?.message ?? e}` }
          }
        }
      }
      return { content: "", error: `Unknown agent: ${task.agentId}` }
    }

    // Build session key for queue management
    const qChannel = task.context?.channel || "api"
    const qChatId = task.context?.chatId || task.context?.group || task.context?.sender || "default"

    if (state.activeTasks >= state.def.maxConcurrent) {
      // Synchronous API callers (mesh /task, /ask, direct curl) can't observe
      // a queued result — the queue's flush callback re-routes via channels,
      // not back to the awaiting HTTP caller. Returning `error: __queued__`
      // surfaces as HTTP 500 on the /task endpoint and triggers an "Error
      // from peer" comment on whatever channel the upstream is bridged to.
      // For these callers, BLOCK and wait for a slot (up to 25 min — slightly
      // under mesh.sendTask's 30 min default cap) instead of queueing.
      if (qChannel === "api") {
        const start = Date.now()
        const maxWaitMs = 25 * 60_000
        const pollIntervalMs = 500
        while (state.activeTasks >= state.def.maxConcurrent) {
          if (Date.now() - start > maxWaitMs) {
            return { content: "", error: `Agent "${task.agentId}" busy — slot wait timed out after ${Math.round(maxWaitMs / 60000)}m` }
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs))
        }
        // Slot freed — fall through to normal execution path below.
      } else {
        // Channel callers (telegram/gitlab/whatsapp/...) already ack'd the
        // user's message, so queueing is the right behavior — the flush
        // callback will reply via the original channel when the slot frees.
        const mode = (state.def.queueMode as QueueMode) || "collect"
        const queued = this.messageQueue.enqueue(task.agentId, qChannel, qChatId, {
          text: task.message,
          sender: task.context?.sender || "User",
          timestamp: Date.now(),
          channel: qChannel,
          chatId: qChatId,
          originalContext: task.context as Record<string, unknown>,
        })

        if (queued === "drop") {
          this.log(`[${task.agentId}] busy, message dropped (mode: drop)`)
          return { content: "", error: `Agent "${task.agentId}" is busy — message dropped` }
        }

        if (queued) {
          const pending = this.messageQueue.pendingCount(task.agentId, qChannel, qChatId)
          this.log(`[${task.agentId}] busy, message queued (mode: ${queued}, pending: ${pending})`)
          return {
            content: "",
            error: `__queued__:${queued}:${pending}`,
          }
        }
      }
    }

    // Rate limit — WAIT for a slot instead of failing. Dropping messages looks
    // like the bot is broken; queueing for ~5 minutes gives chatty channels a
    // smooth experience and still bails if something's genuinely stuck.
    const rateResult = await this.rateLimiter.acquire(task.agentId, {
      maxWaitMs: 5 * 60_000,
      onWait: (reason, waitMs) => {
        this.log(`[${task.agentId}] ${reason} — queued, resumes in ~${Math.max(1, Math.round(waitMs / 1000))}s`)
      },
    })
    if (!rateResult.ok) {
      this.log(`[${task.agentId}] ${rateResult.reason}`)
      return { content: "", error: rateResult.reason }
    }

    state.activeTasks++
    state.totalTasks++
    state.lastActive = new Date()

    // Track the running task for live visibility (/agents endpoint surfaces this).
    const runningTask: RunningTask = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messagePreview: (task.message || "").slice(0, 200),
      channel: task.context?.channel || "api",
      chatId: task.context?.chatId || task.context?.group,
      sender: task.context?.sender,
      startedAt: new Date(),
    }
    state.runningTasks.push(runningTask)

    // AbortController for operator stop / replace. Stored under the running
    // task id so /api/tasks/:id/cancel can resolve and abort it.
    const abortController = new AbortController()
    this.taskAborts.set(runningTask.id, {
      agentId: task.agentId,
      channel: runningTask.channel,
      chatId: typeof runningTask.chatId === "string" ? runningTask.chatId : "",
      originalMessage: task.message || "",
      controller: abortController,
    })

    // Output capture for the dashboard streaming modal. We never *force*
    // streaming on a caller that didn't ask for it — that would change the
    // runtime mode (stream-json vs json) for every task in the system. So:
    //   - Caller passed onDelta → wrap it to also fan-out to dashboard subscribers (live).
    //     We also install onEvent so the dashboard sees tool calls, tool results,
    //     and system events — i.e. everything you'd see in a real terminal.
    //   - Caller did NOT pass onDelta → leave runtime in non-streaming mode and
    //     post the final response.content as a single chunk after execution.
    const output: TaskOutput = { agentId: task.agentId, buffer: "", subscribers: new Set(), done: false }
    this.taskOutputs.set(runningTask.id, output)
    const pushToBuffer = (chunk: string) => {
      if (!chunk) return
      output.buffer += chunk
      if (output.buffer.length > TASK_OUTPUT_BUFFER_MAX) {
        output.buffer = output.buffer.slice(output.buffer.length - TASK_OUTPUT_BUFFER_MAX)
      }
      for (const sub of output.subscribers) {
        try { sub(chunk) } catch { /* subscriber crashed — ignore */ }
      }
    }
    // Allocate the per-execution trace id eagerly so both the streaming
    // parser (per-step capture below) and the bus emit a few lines down
    // can target the same task_traces row. Closures defined here reference
    // it by name; the variable is set before any callback can fire.
    const traceTaskId = newEventId()
    task.taskId = traceTaskId

    // Per-task tool-use tally (improvement plan #3). Counts each
    // assistant tool_use block by tool name so we can compare against
    // agent.toolUseRequired after the response returns. The count is
    // populated regardless of toolUseRequired being set so traces
    // and dashboards always have it; the post-task check only fires
    // when the agent has the flag.
    const toolUsesByName = new Map<string, number>()

    let onEvent: ((event: any) => void) | undefined
    if (onDelta) {
      // Caller's onDelta still fires only for assistant text (unchanged).
      // Dashboard subscribers see the formatted stream-json firehose via onEvent
      // — this is what makes the modal feel like a live terminal.
      const formatter = makeStreamEventFormatter()
      onEvent = (event: any) => {
        const formatted = formatter(event)
        if (formatted) pushToBuffer(formatted)
        // Per-step trace capture (improvement plan #2). Fire one
        // task:step event per tool_use / tool_result block. The
        // SQLite subscriber persists it under traceTaskId.
        emitTraceStepsFromStreamEvent(traceTaskId, task.agentId, event)
        tallyToolUses(toolUsesByName, event)
      }
    } else {
      // Even without a dashboard subscriber, we want trace steps for
      // /traces/:id. Build a minimal onEvent that ONLY emits steps.
      onEvent = (event: any) => {
        emitTraceStepsFromStreamEvent(traceTaskId, task.agentId, event)
        tallyToolUses(toolUsesByName, event)
      }
    }

    // Mark session as running in the message queue
    this.messageQueue.markRunning(task.agentId, qChannel, qChatId)

    this.log(`[${task.agentId}] executing task (${state.activeTasks}/${state.def.maxConcurrent})`)

    // Build conversation history for session continuity
    const channel = task.context?.channel || "api"
    const chatId = task.context?.chatId || task.context?.group || task.context?.sender || "default"
    const senderName = task.context?.sender || "User"
    const isCodexCli = state.def.tier === "codex-cli"

    // Improvement plan #8 — caller-driven session reset. Honour it before
    // seeding or recording the current inbound message; otherwise the fresh
    // reset can erase the very message that started the task.
    if (task.freshSession) {
      this.sessions.clearSession(task.agentId, channel, chatId)
      this.log(`[${task.agentId}] freshSession=true → cleared session history for ${channel}:${chatId}`)
      getEventBus().emit("session:rotated", {
        agentId: task.agentId, channel, chatId,
        reason: "stale",
        at: new Date().toISOString(),
      })
    }

    // Mirror the live channel before recording the new user message — on a
    // cold-create (fresh chatId, new day after rotation), this calls the
    // adapter's seedHistory and back-fills recent messages so the agent
    // doesn't start blind. No-op for warm sessions, non-channel callers
    // (cron/api/a2a), or channels without a seedHistory implementation.
    if (!task.freshSession) {
      await this.sessions.seedIfEmpty(task.agentId, channel, chatId)
    }

    // Record user message in session
    this.sessions.addUserMessage(task.agentId, channel, chatId, senderName, task.message)

    const taskStartedAt = Date.now()
    // traceTaskId allocated above (alongside the streaming onEvent
    // callback). Including it in task:started lets the SQLite
    // subscriber open the trace row under the same id the per-step
    // emitter uses.
    getEventBus().emit("task:started", {
      agentId: task.agentId,
      channel,
      chatId,
      messagePreview: (task.message || "").slice(0, 200),
      fullMessage: task.message || "",
      at: new Date(taskStartedAt).toISOString(),
      taskId: traceTaskId,
    })

    // Classify the message through the intent graph when enabled. Skip for
    // a2a traffic — the classifier itself dispatches through /task, and
    // re-classifying its own prompts would recurse forever. Any classifier
    // failure (bad LLM output, schema rejection, network error) must never
    // propagate — the main task still has to run.
    let intent: ClassifyResult | undefined
    if (this.classifier && channel !== "a2a" && !isCodexCli) {
      try {
        intent = (await this.classifier.classify({
          text: task.message,
          channel,
          sender: task.context?.sender,
          agentId: task.agentId,
        })) || undefined
      } catch (e: any) {
        this.log(`[classifier] classify failed for ${task.agentId}: ${e?.message || e}`)
      }
    }

    const wfMatching = this.config.workflows?.matching
    // Decision-only here: compute whether auto-run should fire. We don't fire
    // the workflow yet — that happens inside the outer try/finally so
    // runningTask + activeTasks bookkeeping always cleans up.
    let pendingAutoRun: { workflowId: string; confidence: number } | undefined
    if (this.config.workflows?.enabled && wfMatching?.enabled) {
      try {
        const store = new WorkflowStore({ baseDir: resolve(process.cwd(), this.config.workflows.dir) })
        const match = matchWorkflow({
          agentId: task.agentId,
          channel,
          message: task.message,
          intentPath: intent?.path,
        }, store.list())
        if (match && match.confidence >= wfMatching.suggestThreshold) {
          this.log(
            `[${task.agentId}] workflow match ${match.workflow.id} confidence=${match.confidence.toFixed(2)} ` +
            `mode=${wfMatching.mode} reasons=${match.reasons.join(",") || "n/a"}`,
          )
          if (wfMatching.mode === "auto" && match.confidence >= wfMatching.autoRunThreshold) {
            if (this.workflowAutoRunner) {
              pendingAutoRun = { workflowId: match.workflow.id, confidence: match.confidence }
            } else {
              this.log(`[${task.agentId}] workflow auto-run requested but no runner wired; falling back to agent`)
            }
          }
        }
      } catch (e: any) {
        this.log(`[${task.agentId}] workflow matcher failed (non-fatal): ${e?.message || e}`)
      }
    }

    // Wiki context — Phase 3 Farzapedia alignment: instead of preloading BM25
    // hits (the old shallow-RAG path), we inject a short pointer to the
    // `agentx wiki query` tool. The agent decides WHEN institutional knowledge
    // matters and invokes the agentic query itself — walking _index.md, picking
    // candidates, following wikilinks 2–3 hops. Zero retrieval cost on messages
    // that don't need it.
    const agentWiki = this.wikiHub.getAgentWiki(task.agentId)
    const wikiContext = buildWikiQueryHint(agentWiki, task.agentId)

    // Load persistent agent memory (cross-session facts)
    const relevantMemories = this.memoryStore.findRelevant(task.message, task.agentId, isCodexCli ? 3 : 8)
    // `let`, not `const`, because the planner strategy (below) may overwrite
    // this with its own curated memory bundle when enabled.
    let memoryContext = this.memoryStore.buildContext(relevantMemories)

    // Load behavioral patterns (self-improving loop)
    const relevantPatterns = this.patternStore.findRelevant(task.message, task.agentId, 5)
    const patternContext = this.patternStore.buildContext(relevantPatterns)

    // Auto-inject skills matched to current message
    let skillInjection = ""
    if (!isCodexCli) {
      try {
        const { loadLocalSkills, getAutoInjectSkills } = await import("@/agent/skills/loader")
        const skills = await loadLocalSkills(state.def.workspace)
        skillInjection = getAutoInjectSkills(skills, task.message)
      } catch {
        // Skill loading is optional
      }
    }

    // Decide whether to resume or start fresh
    let resumeSessionId = state.def.tier === "claude-code"
      ? this.sessions.getClaudeSessionId(task.agentId, channel, chatId)
      : state.def.tier === "codex-cli"
        ? this.sessions.getCodexSessionId(task.agentId, channel, chatId)
        : undefined

    // If session is stale (idle > staleMinutes), start fresh with full context rebuild
    if (resumeSessionId && this.sessions.isSessionStale(task.agentId, channel, chatId)) {
      this.log(`[${task.agentId}] session stale for ${channel}:${chatId}, starting fresh`)
      if (state.def.tier === "claude-code") {
        void this.captureRotationMemoAsync(task.agentId, state.def, resumeSessionId, channel, chatId, "stale")
      }
      this.sessions.clearClaudeSessionId(task.agentId, channel, chatId)
      getEventBus().emit("session:rotated", {
        agentId: task.agentId, channel, chatId,
        reason: "stale",
        at: new Date().toISOString(),
      })
      resumeSessionId = undefined
    }

    // If prior turn pushed total input past the tier-2 threshold (>200K billed
    // at 1.5×), rotate before paying the multiplier again. Claude CLI --resume
    // replays every past tool result, so one bloated turn keeps billing
    // tier-2 indefinitely until we drop the session.
    if (resumeSessionId && this.sessions.shouldRotateByTierTwo(task.agentId, channel, chatId)) {
      const lastTokens = this.sessions.getLastTurnInputTokens(task.agentId, channel, chatId)
      this.log(`[${task.agentId}] tier-2 rotation for ${channel}:${chatId} (last turn: ${lastTokens} input tokens ≥ ${this.sessions.getTierTwoThresholdTokens()})`)
      if (state.def.tier === "claude-code") {
        void this.captureRotationMemoAsync(task.agentId, state.def, resumeSessionId, channel, chatId, "tier-2")
      }
      this.sessions.clearClaudeSessionId(task.agentId, channel, chatId)
      getEventBus().emit("session:rotated", {
        agentId: task.agentId, channel, chatId,
        reason: "tier-2",
        lastTurnInputTokens: lastTokens,
        at: new Date().toISOString(),
      })
      resumeSessionId = undefined
    }

    // If session has accumulated too many turns, rotate even before it hits
    // tier-2. Claude CLI replays grow linearly with turn count — capping
    // here keeps the per-turn cache-read tax bounded. Compacted summary +
    // recent-messages history seed the next session so nothing is lost.
    if (resumeSessionId && this.sessions.shouldRotateByTurns(task.agentId, channel, chatId)) {
      const turns = this.sessions.getTurnCount(task.agentId, channel, chatId)
      this.log(`[${task.agentId}] max-turns rotation for ${channel}:${chatId} (${turns} turns ≥ ${this.sessions.getMaxTurnsPerSession()})`)
      if (state.def.tier === "claude-code") {
        void this.captureRotationMemoAsync(task.agentId, state.def, resumeSessionId, channel, chatId, "max-turns")
      }
      this.sessions.clearClaudeSessionId(task.agentId, channel, chatId)
      getEventBus().emit("session:rotated", {
        agentId: task.agentId, channel, chatId,
        reason: "max-turns",
        at: new Date().toISOString(),
      })
      resumeSessionId = undefined
    }

    // Compact session if history is getting too long (summarize older messages).
    //
    // Compaction NO LONGER drops resumeSessionId — Claude's own session has
    // its own history that --resume replays, independent of our stored copy.
    // The summary gets used at the next legitimate rotation (tier-2,
    // max-turns, stale) when we genuinely need a fresh Claude session and
    // have to seed it from the stored messages. Until then, the hot session
    // stays cache-friendly. See sessions.ts compactIfNeeded for the longer
    // explanation.
    try {
      const compactResult = await this.sessions.compactIfNeeded(
        task.agentId, channel, chatId, this.memoryStore,
      )
      if (compactResult.compacted) {
        const quality = compactResult.qualityScore ?? "?"
        const lost = compactResult.lostEntities?.length ?? 0
        this.log(`[${task.agentId}] session compacted for ${channel}:${chatId} (quality: ${quality}%, ${lost} entities lost)`)
        if (compactResult.lostEntities?.length) {
          this.log(`[${task.agentId}] lost entities: ${compactResult.lostEntities.slice(0, 5).join(", ")}`)
        }
        if (compactResult.drift) {
          const d = compactResult.drift
          this.log(`[${task.agentId}] DRIFT DETECTED: score=${d.overallScore} (lexicon=${d.lexiconDecay}, tools=${d.toolShift}, semantic=${d.semanticDrift})`)
          if (d.lostWords.length) this.log(`[${task.agentId}] lost domain words: ${d.lostWords.slice(0, 5).join(", ")}`)
        }
      }
    } catch (e: any) {
      this.log(`[${task.agentId}] compaction failed (non-fatal): ${e.message}`)
    }

    // Context Surgery — Fix 1: cap session history for coding-channel
    // contexts. Long github/gitlab issue threads anchor the agent on
    // accumulated assumptions (the diagnosis from ksi-v2 review). Tighter
    // cap forces code-first investigation; thread remains accessible via
    // `gh`/`glab` if the agent explicitly fetches it. Gated behind
    // AGENTX_CONTEXT_SURGERY=1 for one-week soak before unconditional rollout.
    const surgeryEnabled = process.env.AGENTX_CONTEXT_SURGERY === "1"
    const historyCap = isCodexCli
      ? { maxMessages: 8, maxChars: 2400 }
      : (surgeryEnabled && isCodingChannelContext(channel, state.def.tier))
        ? { maxMessages: 6, maxChars: 1800 }
        : undefined

    const sessionHistory = !resumeSessionId
      ? this.sessions.buildHistoryContext(
          task.agentId,
          channel,
          chatId,
          historyCap,
        )
      : undefined

    // Context-rebuild diagnostic. Fires under `--debug context` (or `all`).
    // The amnesia-vs-misreasoning question — "did the agent see X in its
    // prompt?" — was unanswerable from session JSONs alone (the rendered
    // prompt prefix is never persisted). This log captures it per-turn:
    //   - resume vs fresh (after rotation, this is "fresh")
    //   - sessionHistory length when rendered (chars + line count)
    //   - session.messages snapshot: count, first ts, last ts, first/last
    //     name+content preview so we can tell what's actually in the file.
    // Off by default — zero overhead unless the operator opted in.
    if (debug && (debug as any).cat) {
      try {
        const sess = this.sessions.getSession(task.agentId, channel, chatId)
        const msgs = sess.messages
        const first = msgs[0]
        const last = msgs[msgs.length - 1]
        const fingerprint = sessionHistory === undefined
          ? `resume=${resumeSessionId ? resumeSessionId.slice(0, 8) : "?"} (no rebuild)`
          : `fresh history=${sessionHistory.length}c/${sessionHistory.split("\n").length}L`
        const summary = `[${task.agentId}] ${channel}:${chatId} ${fingerprint} | session.messages=${msgs.length}` +
          (msgs.length > 0
            ? ` first=${first.timestamp.slice(11, 19)}(${first.role}:${(first.content || "").slice(0, 40).replace(/\n/g, " ")}) last=${last.timestamp.slice(11, 19)}(${last.role}:${(last.content || "").slice(0, 40).replace(/\n/g, " ")})`
            : "")
        debug.cat("context", summary)
      } catch (e: any) {
        // Diagnostic logging must never throw into the hot path.
        debug.cat("context", `[${task.agentId}] context-diag error: ${e?.message ?? e}`)
      }
    }

    // Verified deterministic references — opt-in per agent via
    // `contextReferences: true`. Only injected when starting a FRESH Claude
    // session: once a session is in progress, the agent already has any
    // facts it learned in earlier turns, and re-rendering them on every
    // resumed turn just bloats the per-turn user-message context. That
    // bloat compounded with --resume's full-history replay was hitting the
    // 180k tier-2 threshold in 5–10 turns and forcing constant rotation,
    // which discarded the conversation Claude session — causing exactly
    // the "I don't have prior context" symptom users observed.
    // The resolver itself runs cheaply in-memory; we just gate the rendered
    // block on `!resumeSessionId`.
    let referencesBlock: string | undefined
    if (state.def.contextReferences && !resumeSessionId) {
      try {
        const cacheKey = state.def.workspace
        let cached = this.referencesCache.get(cacheKey)
        if (!cached) {
          const [refs, recipes] = await Promise.all([
            loadReferences(state.def.workspace),
            loadRecipes(state.def.workspace),
          ])
          if (refs.byId.size === 0 && recipes.recipes.length === 0) {
            const [rootRefs, rootRecipes] = await Promise.all([
              loadReferences(process.cwd()),
              loadRecipes(process.cwd()),
            ])
            cached = { refs: rootRefs, recipes: rootRecipes }
          } else {
            cached = { refs, recipes }
          }
          this.referencesCache.set(cacheKey, cached)
        }
        const resolved = resolveRecipes(
          {
            agentId: task.agentId,
            intentTags: intent?.path,
            message: task.message,
          },
          cached.recipes,
          cached.refs,
        )
        if (resolved.cards.length > 0) {
          referencesBlock = renderReferences(resolved.cards, 500 * 4)
        }
        if (resolved.unresolvedIds.length > 0) {
          this.log(`[${task.agentId}] references: unresolved ids: ${resolved.unresolvedIds.join(", ")}`)
        }
      } catch (e: any) {
        this.log(`[${task.agentId}] references resolver failed (non-fatal): ${e?.message || e}`)
      }
    }

    // Bridge cross-chat amnesia: inject context from other chats (DM ↔ group).
    // Gated on the current message — we only ship the hint when the user
    // actually refers to another conversation, a peer agent, or earlier
    // activity. Otherwise it's pure waste AND breaks prompt cache every turn.
    let crossChatContext = this.sessions.getCrossSessionSummary(
      task.agentId, channel, chatId, task.message,
    )

    // Long-memory recall pre-fetch — when the current message has an
    // explicit long-memory cue ("yesterday", "last week", "remember when…",
    // "we discussed", Arabic equivalents), pull a wider window from the
    // session store and inject as a context block so the agent doesn't have
    // to call /recall itself in obvious cases. Without this, on a fresh
    // claude session the agent would either fabricate context (the
    // observed "Tarek Ksibi" gmail-search failure) or pester the user.
    let longMemoryRecall: string | undefined
    const lmHint = detectLongMemoryHint(task.message)
    if (lmHint) {
      try {
        const recall = this.sessions.recallTurns({
          agentId: task.agentId,
          channel,
          chatId,
          lookbackDays: lmHint.lookbackDays,
          limit: 12,
        })
        if (recall.turns.length > 0) {
          const lines: string[] = [
            `[Long-memory recall — last ${lmHint.lookbackDays}d on this chat (cue-triggered)]`,
          ]
          // Render oldest-first for natural reading flow
          const ordered = [...recall.turns].sort((a, b) => a.ts.localeCompare(b.ts))
          for (const t of ordered) {
            const stamp = t.ts.slice(11, 16) + " " + t.day
            const who = t.role === "user" ? (t.senderName || "User") : (t.senderName || "Agent")
            lines.push(`${stamp} ${who}: ${t.content}`)
          }
          if (recall.hasMore) {
            lines.push(`[…${recall.totalScanned - recall.turns.length}+ older turns available — call /recall with before=${recall.oldestTs} to walk further back]`)
          }
          lines.push("[End of long-memory recall — respond to the latest message above]")
          longMemoryRecall = lines.join("\n")
          this.log(`[${task.agentId}] long-memory recall fired: lookback=${lmHint.lookbackDays}d, turns=${recall.turns.length}, scanned=${recall.totalScanned}`)
        }
      } catch (e: any) {
        this.log(`[${task.agentId}] long-memory recall failed (non-fatal): ${e.message}`)
      }
    }

    // Context strategy: "layered" (above) or "planner". Planner is a Haiku
    // pre-call that curates just the bits of history/memory/cross-chat the
    // current message needs, replacing the full-blob layered approach.
    // Per-task override (for benchmarks) wins over config default.
    // Fail-open: if the planner errors or times out, we fall through with
    // the layered values already computed above.
    // Resolution order: per-task override (benchmarks) → per-agent
    // override (def.contextStrategy) → global config default.
    const strategy: "layered" | "planner" = isCodexCli
      ? "layered"
      : task.contextStrategy ?? state.def.contextStrategy ?? this.config.session.contextStrategy ?? "layered"
    let sessionHistoryOverride: string | undefined
    let planDebug: Record<string, unknown> | undefined
    let plannerSucceeded = false
    if (strategy === "planner") {
      try {
        const { planContext } = await import("./context-planner")
        const plan = await planContext({
          agentId: task.agentId,
          channel,
          chatId,
          message: task.message,
          sessions: this.sessions,
          memoryStore: this.memoryStore,
        })
        if (plan) {
          plannerSucceeded = true
          sessionHistoryOverride = plan.sessionHistory
          memoryContext = plan.memoryContext
          crossChatContext = plan.crossChatContext
          planDebug = plan.debug as unknown as Record<string, unknown>
          this.log(`[${task.agentId}] planner: turns=${plan.debug.recentTurns}, mem=${plan.debug.memoryIncluded ? "yes" : "no"}, xchat=${plan.debug.crossChatIncluded ? "yes" : "no"} (${plan.debug.planLatencyMs}ms) — ${plan.debug.reasoning ?? ""}`)
        } else {
          this.log(`[${task.agentId}] planner returned null — falling back to layered (keeping --resume for continuity)`)
        }
      } catch (e: any) {
        this.log(`[${task.agentId}] planner failed (non-fatal): ${e.message} — falling back to layered (keeping --resume for continuity)`)
      }
      // Force a fresh Claude session ONLY when the planner produced a curated
      // prompt — that's when --resume replay would conflict with the small
      // curated context. If the planner failed, keep the existing session so
      // claude's own --resume continues to provide conversation continuity.
      // Without this guard, every failed planner call dropped the session AND
      // skipped the layered sessionHistory rebuild (which was const-bound on
      // the pre-rotation resumeSessionId state above), leaving the agent
      // context-blind on every turn — the canonical "I don't have prior
      // context" symptom on planner-strategy agents.
      if (plannerSucceeded && resumeSessionId) {
        this.sessions.clearClaudeSessionId(task.agentId, channel, chatId)
        resumeSessionId = undefined
      }
    }
    void planDebug // reserved for the bench harness; not injected into context

    // Soul switching: detect /soul command and track active profile
    const soulSessionKey = `${task.agentId}:${channel}:${chatId}`
    const soulSwitch = detectSoulSwitch(task.message)
    if (soulSwitch) {
      if (soulSwitch === "default") {
        this.activeSouls.delete(soulSessionKey)
        this.log(`[${task.agentId}] Soul reset to default`)
      } else {
        this.activeSouls.set(soulSessionKey, soulSwitch)
        this.log(`[${task.agentId}] Soul switched to: ${soulSwitch}`)
      }
    }
    const activeSoul = this.activeSouls.get(soulSessionKey)

    // Load bootstrap identity files (SOUL.md or SOUL.{profile}.md).
    // These are delivered via --append-system-prompt to Claude Code so they
    // live inside the cached system prompt — we no longer append them into
    // the per-turn user-message context (which would pay cache-create on
    // every new session). The context builder still gets a flag-empty
    // bootstrapContext so the `[Identity]` / `[Personality]` block is
    // suppressed in the rendered context (Claude sees them once, cached).
    const bootstrapFiles = loadBootstrapFiles(state.def.workspace, activeSoul)
    const bootstrapContextText = buildBootstrapContext(bootstrapFiles)

    // Compose the cacheable system-prompt preamble. Order matters for cache
    // stability: agent.systemPrompt is the most stable (config-defined),
    // bootstrap files follow. Soul-switching mid-session produces a new
    // append-text and a new Claude cache key; that's by design — the rare
    // switch is worth a one-time cache-create cost.
    // AgentMemory — structured per-agent memory (user / feedback /
    // project / reference). Inlined into the cacheable system prompt so
    // it survives --resume and shows up on every turn. Empty when the
    // agent has no memories yet — no prompt bloat for fresh agents.
    const agentMemoryBlock = this.agentMemory.indexMarkdown(task.agentId)

    // Context Surgery — Fix 4: code-first operating principle for coding-tier
    // agents. Cacheable (lives in the system-prompt prefix). Empty for non-
    // coding tiers so chat/orchestrator agents are unaffected.
    const codeFirstInstruction =
      (state.def.tier === "claude-code" || state.def.tier === "codex-cli")
        ? "[Operating principle]\nAlways investigate the codebase before relying on issue history or comments. The code is the source of truth — start by reading relevant files (CLAUDE.md, then code), and consult conversation context only to clarify intent. Issue threads may contain wrong hypotheses; verify against the source."
        : ""

    // Context Surgery — Fix 3: per-workspace CLAUDE.md auto-injection. Read
    // once at task-setup, cap at 4KB to bound prompt size, silent fallback so
    // a missing/unreadable file is a no-op. Lives in the cacheable system
    // prompt prefix; project-specific patterns reach the agent before any
    // task context.
    let projectClaudeMd = ""
    if (state.def.workspace) {
      const claudeMdPath = resolve(state.def.workspace, "CLAUDE.md")
      if (existsSync(claudeMdPath)) {
        try {
          const content = readFileSync(claudeMdPath, "utf-8")
          const trimmed = content.length > 4000
            ? content.slice(0, 4000) + "\n\n[CLAUDE.md truncated to 4KB]"
            : content
          projectClaudeMd = `[Project CLAUDE.md]\n${trimmed}`
        } catch {
          // silent — the agent works fine without it
        }
      }
    }

    // Per-channel-event runbook injection — when a project rule resolves a
    // runbook path (gitlab/github adapters stamp it onto IncomingMessage),
    // pull the canonical file set (CLAUDE.md / AGENTS.md / DEPLOY.md /
    // RUNBOOK.md, overridable per-project) and append to the system prefix.
    // This is what carries the *target* project's deploy steps and server
    // mapping into the agent's context — without it the agent falls back to
    // its workspace's CLAUDE.md, which doesn't know about ./cache_clear.sh
    // or which host runs the deploy. Each file capped at 4KB; the whole
    // bundle capped at 16KB to keep the cacheable prefix bounded.
    const runbookPath = task.context?.runbookPath
    const runbookBlocks: string[] = []
    if (runbookPath && existsSync(runbookPath)) {
      const filesToTry = task.context?.runbookFiles && task.context.runbookFiles.length > 0
        ? task.context.runbookFiles
        : ["CLAUDE.md", "AGENTS.md", "DEPLOY.md", "RUNBOOK.md"]
      let totalBytes = 0
      const PER_FILE_CAP = 4000
      const TOTAL_CAP = 16000
      for (const filename of filesToTry) {
        if (totalBytes >= TOTAL_CAP) break
        const filePath = resolve(runbookPath, filename)
        if (!existsSync(filePath)) continue
        try {
          const content = readFileSync(filePath, "utf-8")
          const trimmed = content.length > PER_FILE_CAP
            ? content.slice(0, PER_FILE_CAP) + `\n\n[${filename} truncated to ${PER_FILE_CAP} bytes]`
            : content
          runbookBlocks.push(`[Project Runbook — ${filename} from ${runbookPath}]\n${trimmed}`)
          totalBytes += trimmed.length
        } catch {
          // silent — missing readability is a no-op
        }
      }
    }
    const projectRunbook = runbookBlocks.length > 0 ? runbookBlocks.join("\n\n") : ""

    const systemPromptAppend = [
      state.def.systemPrompt || "",
      codeFirstInstruction,
      projectClaudeMd,
      projectRunbook,
      bootstrapContextText || "",
      agentMemoryBlock || "",
    ].filter((s) => s.trim().length > 0).join("\n\n") || undefined

    const contextInput: ContextInput = {
      channel,
      chatId,
      channelScope: task.context?.group ? "group" : (channel === "gitlab" ? "project" : "personal"),
      groupName: task.context?.group,
      agentId: task.agentId,
      agentName: state.def.name,
      agentHandle: this.getChannelHandle(task.agentId, channel),
      systemPrompt: state.def.systemPrompt,
      sender: senderName,
      senderId: task.context?.senderId,
      senderUsername: task.context?.senderUsername,
      // Context Surgery — Fix 2: skip landscape for coding-tier agents in
      // github/gitlab contexts. The mesh-peer summary (~1-2K tokens of cross-
      // team agents) is irrelevant for focused code work on one issue/PR and
      // anchors the agent on context it shouldn't be using. Chat/orchestrator
      // agents still get the landscape — that's where peer discovery matters.
      landscape: (isCodexCli || isCodingChannelContext(channel, state.def.tier))
        ? undefined
        : this.landscape?.getForAgent(task.agentId),
      channelMeta: task.context?.channelMeta,
      mediaPath: task.context?.mediaPath,
      mediaType: task.context?.mediaType,
      replyToText: task.context?.replyToText,
      // bootstrapContext intentionally omitted — delivered via system prompt.
      patternContext: isCodexCli ? undefined : patternContext || undefined,
      references: referencesBlock,
      skillInjection: skillInjection || undefined,
      groupHistory: task.context?.group ? undefined : undefined, // group log is injected by router
      // Planner override takes precedence when set — falls back to the
      // layered `sessionHistory` (full buildHistoryContext, scoped by
      // resumeSessionId presence) otherwise.
      sessionHistory: sessionHistoryOverride ?? sessionHistory,
      memoryContext: memoryContext || undefined,
      crossChatContext: crossChatContext || undefined,
      longMemoryRecall: longMemoryRecall || undefined,
      wikiContext: isCodexCli ? undefined : wikiContext,
      handoverNote: this.buildHandoverNote(task.agentId, channel, chatId),
      intent: intent
        ? {
            path: intent.path,
            pathLabel: intent.pathLabel,
            pathId: intent.pathId,
            axes: intent.axes,
            leaf: intent.leaf,
            status: intent.status,
          }
        : undefined,
      message: task.message,
    }

    const historyContext = buildAgentContext(
      contextInput,
      isCodexCli
        ? {
            totalBudget: 1800,
            layerBudgets: {
              channel: 180,
              scope: 100,
              identity: 120,
              references: 250,
              intent: 80,
              artifacts: 250,
              memory: 250,
              history: 450,
              "cross-chat": 200,
              "long-memory": 350,
              handover: 120,
            },
          }
        : undefined,
    )

    // Context-size telemetry. Bytes we control: the layered context string +
    // the cacheable system-prompt append + the current message. Bytes we
    // don't: the Claude CLI --resume replay (tool results from prior turns),
    // which shows up as cacheReadTokens in response.usage. Log a warning
    // when our controllable assembly is unusually large (>16K chars ≈ 4K
    // tokens) — anything that big is usually a runaway layer worth
    // investigating before it snowballs via --resume.
    const agentxContextBytes =
      (historyContext?.length ?? 0) +
      (systemPromptAppend?.length ?? 0) +
      (task.message?.length ?? 0)
    const sizeParts = {
      history: historyContext?.length ?? 0,
      sysPrompt: systemPromptAppend?.length ?? 0,
      message: task.message?.length ?? 0,
    }
    // Record every dispatch for drift detection, warn when growing.
    const sizeKey = promptSizeKey(task.agentId, channel, chatId)
    recordPromptSize(sizeKey, agentxContextBytes, sizeParts)
    const driftWarning = warnIfPromptGrowing(sizeKey)
    if (driftWarning) this.log(`[${task.agentId}] ${driftWarning}`)
    if (agentxContextBytes > 16_000) {
      this.log(`[${task.agentId}] large context for ${channel}:${chatId}: ${agentxContextBytes} bytes (history=${sizeParts.history}, sysPrompt=${sizeParts.sysPrompt}, message=${sizeParts.message})`)
    }

    // Attach the cacheable preamble onto the task so runtime.ts can forward
    // it to Claude CLI's --append-system-prompt arg.
    const taskWithSystemPrompt: AgentTask = { ...task, systemPromptAppend }

    let finalResponse: AgentResponse | undefined
    try {
      // Workflow auto-run short-circuit. When the matcher upstream picked a
      // workflow at >= autoRunThreshold AND `workflows.matching.mode == "auto"`,
      // fire that workflow now and return. The workflow owns posting any
      // reply via its action.send / agent nodes; we return an empty content
      // with a metadata marker so the caller knows not to send a redundant
      // agent reply. On runner failure, we log and fall through to normal
      // agent execution — auto-run is best-effort, never a footgun.
      if (pendingAutoRun && this.workflowAutoRunner) {
        try {
          const result = await this.workflowAutoRunner({
            workflowId: pendingAutoRun.workflowId,
            agentId: task.agentId,
            channel,
            chatId,
            message: task.message,
            payload: {
              message: task.message,
              agentId: task.agentId,
              channel,
              chatId,
              senderId: task.context?.senderId,
              senderUsername: task.context?.senderUsername,
              intentPath: intent?.path,
              matchedWorkflowId: pendingAutoRun.workflowId,
              matchConfidence: pendingAutoRun.confidence,
            },
          })
          this.log(
            `[${task.agentId}] workflow auto-run started ${pendingAutoRun.workflowId} run=${result.runId || "?"}; ` +
            `agent execution skipped — workflow owns the reply`,
          )
          finalResponse = {
            content: "",
            duration: 0,
            metadata: {
              handledByWorkflow: pendingAutoRun.workflowId,
              workflowRunId: result.runId,
              workflowMatchConfidence: pendingAutoRun.confidence,
            },
          } as AgentResponse
          return finalResponse
        } catch (e: any) {
          this.log(`[${task.agentId}] workflow auto-run failed; falling back to agent: ${e?.message || e}`)
        }
      }

      // Pre-flight gates (claude-code tier only). Two separate heuristics that
      // short-circuit doomed cold dispatches BEFORE we burn a Claude CLI
      // subprocess to reproduce the same failure:
      //   (1) Overage gate — when Anthropic has disabled Max-plan extra usage
      //       at the org level. A cold dispatch's fresh cache-create spills
      //       past the regular allotment and gets rejected.
      //   (2) Quota gate — when our own dispatch-budget counters say the
      //       fleet has burned through the hourly or 5-hour cap. Warm
      //       sessions still pass; cold dispatches are deferred.
      // Warm sessions (resumeSessionId set) bypass both gates — prompt-cache
      // replay keeps them inside the regular allotment.
      //
      // Kept inside the try so the `finally` below still runs — otherwise a
      // short-circuit return leaks runningTask bookkeeping.
      if (state.def.tier === "claude-code") {
        // A persistent-process handle counts as "warm" — its subprocess already
        // has the system prompt cached, so no fresh cache-create is needed even
        // when there's no --resume session ID stored for this chatId yet.
        const procReg = state.def.persistentProcess ? getProcessRegistry() : null
        const hasLiveProcess = procReg != null
          && procReg.hasLive({ agentId: task.agentId, channel, chatId })
        const hasWarmSession = Boolean(resumeSessionId) || hasLiveProcess
        const gates = [
          preflightOverageGate(hasWarmSession),
          preflightQuotaGate(hasWarmSession),
        ]
        const abort = gates.find((g) => g && g.abort)
        if (abort) {
          state.errors++
          this.log(`[${task.agentId}] skipping cold dispatch — ${abort.reason}`)
          const preflightResponse: AgentResponse = {
            content: "",
            error: abort.message,
            duration: 0,
          }
          if (!onDelta) {
            output.buffer = `[error] ${abort.message}`
            for (const sub of output.subscribers) {
              try { sub(output.buffer) } catch { /* */ }
            }
          }
          finalResponse = preflightResponse
          return preflightResponse
        }
        // Past the gates — commit the dispatch to the rolling budget and log
        // a warning if we've crossed warnRatio so the operator sees pressure
        // building before it turns into rejections.
        recordClaudeCodeDispatch()
        const warning = warnIfNearingCap()
        if (warning) this.log(`[${task.agentId}] ${warning}`)
      }

      const response = await executeTask(state.def, taskWithSystemPrompt, this.providers, onDelta, historyContext, resumeSessionId, onEvent, abortController.signal)

      // Improvement plan #3 — fail with a typed error when the agent
      // declared toolUseRequired and the model didn't invoke at least
      // one of the listed tools. Only fires when the response itself
      // wasn't already an error (an outer error wins). The error
      // message uses the canonical `tool_required_not_called: <name>`
      // shape so retry / fallback logic can pattern-match on it.
      if (!response.error) {
        const missing = firstMissingRequiredTool(state.def.toolUseRequired, toolUsesByName)
        if (missing) {
          const invokedSummary = Array.from(toolUsesByName.entries())
            .map(([n, c]) => `${n}=${c}`)
            .join(", ") || "none"
          response.error = `tool_required_not_called: ${missing} (invoked: ${invokedSummary})`
          response.content = ""
          this.log(`[${task.agentId}] tool-use contract violation — required ${missing}, observed ${invokedSummary}`)
        }
      }

      finalResponse = response

      // Split this request's tokens into tier1/tier2 buckets so subscribers
      // (sqlite usage_daily, audit, dashboard) record both lanes. The same
      // threshold that TokenTracker.record() applies — extracted as a
      // helper so the two sites can never drift.
      const split = response.usage ? splitTaskUsageByTier(response.usage) : undefined
      getEventBus().emit("task:completed", {
        taskId: traceTaskId,
        agentId: task.agentId,
        channel,
        chatId,
        durationMs: Date.now() - taskStartedAt,
        error: response.error || undefined,
        inputTokens: split?.inputTokens,
        outputTokens: split?.outputTokens,
        cacheReadTokens: split?.cacheReadTokens,
        cacheCreateTokens: split?.cacheCreateTokens,
        tier2InputTokens: split?.tier2InputTokens,
        tier2OutputTokens: split?.tier2OutputTokens,
        tier2CacheReadTokens: split?.tier2CacheReadTokens,
        tier2CacheCreateTokens: split?.tier2CacheCreateTokens,
        finalResponse: response.content || undefined,
        // Per-task model attribution: prefer what the runtime actually
        // billed; fall back to the agent's configured model so codex-cli
        // / sdk agents don't get stamped with the daemon-wide opus default.
        billedModel: response.billedModel || state.def.model || undefined,
        at: new Date().toISOString(),
      })

      // For non-streaming runs (no caller onDelta) we never captured incremental
      // chunks — surface the final response in one shot so the dashboard modal
      // shows something meaningful when subscribers are attached.
      if (!onDelta && (response.content || response.error)) {
        const finalText = response.error ? `[error] ${response.error}` : response.content
        output.buffer = finalText
        for (const sub of output.subscribers) {
          try { sub(finalText) } catch { /* */ }
        }
      }

      if (response.error) {
        state.errors++
        this.log(`[${task.agentId}] error: ${response.error}`)
      } else {
        // Record agent response in session
        this.sessions.addAgentMessage(task.agentId, channel, chatId, response.content)

        // Store native CLI session IDs for future resume.
        if (response.claudeSessionId) {
          this.sessions.setClaudeSessionId(task.agentId, channel, chatId, response.claudeSessionId)
        }
        if (response.codexSessionId) {
          this.sessions.setCodexSessionId(task.agentId, channel, chatId, response.codexSessionId)
        }

        // Record this turn's usage so next task can decide whether to rotate:
        // tracks turnCount + lastTurnInputTokens (input + cacheRead + cacheCreate).
        // Only meaningful when we kept a claude session — skip otherwise so the
        // counter isn't incremented for tiers that don't use --resume.
        if ((response.claudeSessionId || response.codexSessionId) && response.usage) {
          this.sessions.recordTurnUsage(task.agentId, channel, chatId, response.usage)
        }

        // Tier-2 warning: Claude bills at 1.5× when a single turn's total
        // input crosses 200K. Surface it visibly so operators don't need to
        // read raw usage JSON to notice. Next turn will auto-rotate (see
        // shouldRotateByTierTwo), but logging THIS turn keeps it observable.
        if (response.usage) {
          const totalInput =
            (response.usage.inputTokens || 0) +
            (response.usage.cacheReadTokens || 0) +
            (response.usage.cacheCreateTokens || 0)
          if (totalInput >= this.sessions.getTierTwoThresholdTokens()) {
            this.log(`[${task.agentId}] TIER-2 HIT on ${channel}:${chatId}: ${totalInput} total input tokens (input=${response.usage.inputTokens}, cacheRead=${response.usage.cacheReadTokens}, cacheCreate=${response.usage.cacheCreateTokens}) — next turn will rotate`)
          }
        }

        // Wiki: export conversation as raw entry for later absorption
        if (response.content.length > 50) {
          try {
            const entryId = `${task.agentId}-${Date.now().toString(36)}`
            this.wikiHub.getSharedStore().addEntry({
              id: entryId,
              date: new Date().toISOString().slice(0, 10),
              agentId: task.agentId,
              source: channel,
              sourceContext: task.context?.group || task.context?.sender,
              content: `User: ${task.message}\n\nAgent: ${response.content}`,
              // Stamp the classifier's path on the entry so `wiki absorb` can
              // propagate it to the article's `graphPath` without
              // reconstructing fingerprints from transformed content. Without
              // this, articles never carry graphPath and the wiki retrieval
              // scorer multiplies the graph weight (default 0.6) by 0.
              meta: intent?.path?.length
                ? { intentPath: intent.path, intentPathLabel: intent.pathLabel }
                : undefined,
            })
          } catch {
            // Wiki export is best-effort
          }

          // Memory: extract and store memorable facts via Haiku (fire-and-forget)
          extractMemories(
            task.agentId,
            task.message,
            response.content,
            { channel, chatId, sender: senderName },
            this.memoryStore,
          ).catch(() => {})

          // Patterns: extract behavioral patterns (fire-and-forget)
          extractPatterns(
            task.agentId,
            task.message,
            response.content,
            { channel, date: new Date().toISOString().slice(0, 10) },
            this.patternStore,
          ).catch(() => {})
        }

        // Track token usage (real counts if available, estimate otherwise).
        // Model priority for pricing: what the API ACTUALLY billed (from the
        // CLI init / result event) > per-task override (cron model) > agent
        // config default. Without this, cron-overridden runs get priced at
        // the wrong rate and cache-aware cost reports mislead operators.
        const billedModel = response.billedModel || task.model || state.def.model
        const tChannel = task.context?.channel
        // Session key = "channel:chatId" — opaque to the tracker, just needs
        // to be unique per (conversation, day). Lets us derive avg-tasks/
        // session later so retry-heavy traffic becomes visible.
        const tSessionKey = tChannel && (task.context?.chatId || task.context?.group || task.context?.sender)
          ? `${tChannel}:${task.context?.chatId || task.context?.group || task.context?.sender}`
          : undefined
        this.tokenTracker.record(
          task.agentId,
          response.duration || 0,
          response.usage,
          task.message.length,
          response.content.length,
          false,
          billedModel,
          tChannel,
          tSessionKey,
        )

        this.log(
          `[${task.agentId}] completed in ${response.duration}ms` +
            (response.tokensUsed ? ` (${response.tokensUsed} tokens)` : ""),
        )
      }

      return response
    } catch (error: any) {
      state.errors++
      this.log(`[${task.agentId}] unexpected error: ${error.message}`)
      const friendly = friendlyModelError(error.message)
      finalResponse = {
        content: "",
        error: renderFriendlyError(friendly),
        errorKind: friendly.kind,
      }
      return finalResponse
    } finally {
      state.activeTasks--
      // Remove this run from the running-tasks list.
      const idx = state.runningTasks.findIndex((r) => r.id === runningTask.id)
      if (idx !== -1) state.runningTasks.splice(idx, 1)
      // Drop the abort entry — the controller is unreachable after this point
      // and a future cancel for the same id should 404, not silently no-op.
      this.taskAborts.delete(runningTask.id)

      // Notify any open dashboard streams that this task has finished, then
      // schedule the buffer for cleanup so memory doesn't grow unbounded.
      output.done = true
      output.endedAt = new Date()
      for (const sub of output.subscribers) {
        try { sub("\n[task finished]\n") } catch { /* ignore */ }
      }
      output.subscribers.clear()
      setTimeout(() => this.taskOutputs.delete(runningTask.id), TASK_OUTPUT_TTL_MS).unref?.()

      // Persist a TaskRecord for the dashboard's "Recent activities" panel.
      // Best-effort — disk failures must not affect task semantics.
      try {
        const endedAt = output.endedAt
        const record: TaskRecord = {
          id: runningTask.id,
          agentId: task.agentId,
          channel: runningTask.channel,
          chatId: runningTask.chatId,
          sender: runningTask.sender,
          message: task.message || "",
          startedAt: runningTask.startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - runningTask.startedAt.getTime(),
          ok: !finalResponse?.error,
          error: finalResponse?.error,
          responseText: finalResponse?.content || "",
          transcript: output.buffer,
        }
        this.persistTaskRecord(record)
        // Stash a one-line summary so the dashboard card can show "what the
        // agent did last" without reading from disk on every snapshot.
        const rawSummary = (record.responseText || record.error || "").trim()
        if (rawSummary) {
          const firstLine = rawSummary.split(/\r?\n/)[0].slice(0, 140)
          this.lastSummaries.set(task.agentId, { text: firstLine, at: endedAt, ok: record.ok })
        }
      } catch (e: any) {
        this.log(`[${task.agentId}] task history persist failed: ${e?.message}`)
      }

      // Flush queued messages that arrived while this run was in progress
      this.messageQueue.markDone(task.agentId, qChannel, qChatId)
        .then((queued) => {
          if (queued.length === 0) return
          this.log(`[${task.agentId}] flushing ${queued.length} queued message(s)`)
          // Re-execute each queued message as a new task
          for (const qm of queued) {
            this.execute({
              message: qm.text,
              agentId: task.agentId,
              context: (qm.originalContext as AgentTask["context"]) || {
                channel: qm.channel,
                sender: qm.sender,
                chatId: qm.chatId,
              },
            }).catch((e) => {
              this.log(`[${task.agentId}] queued message failed: ${e.message}`)
            })
          }
        })
        .catch((e) => {
          this.log(`[${task.agentId}] queue flush failed: ${e.message}`)
        })
    }
  }

  /**
   * List all agents and their status.
   */
  /** Total active task count across all agents — used by the daemon's
   *  graceful shutdown to drain in-flight runs before exit. */
  getActiveTaskCount(): number {
    let total = 0
    for (const s of this.agents.values()) total += s.activeTasks
    return total
  }

  list(): Array<{
    id: string
    name: string
    tier: string
    model?: string
    workspace: string
    active: number
    total: number
    errors: number
    lastActive?: Date
    runningTasks: RunningTask[]
    lastSummary?: { text: string; at: string; ok: boolean }
    hourlyTasks?: number[]
  }> {
    return Array.from(this.agents.values()).map((s) => {
      const summary = this.lastSummaries.get(s.id)
      return {
        id: s.id,
        name: s.def.name,
        tier: s.def.tier,
        model: s.def.model,
        workspace: s.def.workspace,
        active: s.activeTasks,
        total: s.totalTasks,
        errors: s.errors,
        lastActive: s.lastActive,
        runningTasks: s.runningTasks,
        lastSummary: summary ? { text: summary.text, at: summary.at.toISOString(), ok: summary.ok } : undefined,
        hourlyTasks: this.getHourlySparkline(s.id, 24),
      }
    })
  }

  /**
   * Write a finished task record to disk under .agentx/task-history/<agent>/<yyyy-mm-dd>/.
   * Side-effects only — call sites should treat failure as best-effort.
   */
  private persistTaskRecord(record: TaskRecord): void {
    const day = record.endedAt.slice(0, 10)
    const dir = resolve(process.cwd(), TASK_HISTORY_DIR, this.safe(record.agentId), day)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = resolve(dir, `${this.safe(record.id)}.json`)
    writeFileSync(file, JSON.stringify(record, null, 2), "utf-8")
  }

  /**
   * Compute a 24-hour hourly task-count sparkline for an agent from persisted
   * history. Returns an array of 24 numbers: buckets[0] = 23-24h ago,
   * buckets[23] = now-hour. Cached per-agent for 60s to keep snapshot load
   * reasonable when the dashboard polls every 2s.
   */
  getHourlySparkline(agentId: string, hours: number = 24): number[] {
    const now = Date.now()
    const cached = this.sparklineCache.get(agentId)
    if (cached && now - cached.at < 60_000 && cached.hourly.length === hours) return cached.hourly

    const buckets = new Array<number>(hours).fill(0)
    const windowStart = now - hours * 3600_000
    const root = resolve(process.cwd(), TASK_HISTORY_DIR, this.safe(agentId))
    if (!existsSync(root)) {
      this.sparklineCache.set(agentId, { hourly: buckets, at: now })
      return buckets
    }
    // Only need the last 2 day folders — crossing midnight still fits.
    const today = new Date(now).toISOString().slice(0, 10)
    const yesterday = new Date(now - 86400_000).toISOString().slice(0, 10)
    const dayToday = new Date(now); dayToday.setUTCHours(0, 0, 0, 0)
    for (const day of [yesterday, today]) {
      const dayDir = resolve(root, day)
      if (!existsSync(dayDir)) continue
      try {
        for (const f of readdirSync(dayDir)) {
          if (!f.endsWith(".json")) continue
          // Task id is timestamp-prefixed (e.g. 1776447897061-xxx.json) — pull
          // the millis without parsing each file.
          const tsStr = f.split("-")[0]
          const ts = parseInt(tsStr, 10)
          if (!Number.isFinite(ts) || ts < windowStart || ts > now) continue
          const offsetHours = Math.floor((now - ts) / 3600_000)
          const idx = hours - 1 - offsetHours
          if (idx >= 0 && idx < hours) buckets[idx]++
        }
      } catch { /* skip unreadable */ }
    }
    this.sparklineCache.set(agentId, { hourly: buckets, at: now })
    return buckets
  }

  /**
   * Rebuild the in-memory lastSummaries cache from disk so dashboard cards
   * show the most recent "what did they do" line even right after a restart.
   * Called once on daemon startup — one file read per agent.
   */
  hydrateLastSummariesFromDisk(): number {
    const root = resolve(process.cwd(), TASK_HISTORY_DIR)
    if (!existsSync(root)) return 0
    let loaded = 0
    for (const agentDir of readdirSync(root)) {
      const agentPath = resolve(root, agentDir)
      let days: string[]
      try { days = readdirSync(agentPath).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() } catch { continue }
      outer: for (const day of days) {
        const dayDir = resolve(agentPath, day)
        let files: string[]
        try { files = readdirSync(dayDir).filter((f) => f.endsWith(".json")).sort().reverse() } catch { continue }
        for (const f of files) {
          try {
            const rec = JSON.parse(readFileSync(resolve(dayDir, f), "utf-8")) as TaskRecord
            const raw = (rec.responseText || rec.error || "").trim()
            if (!raw) continue
            const firstLine = raw.split(/\r?\n/)[0].slice(0, 140)
            this.lastSummaries.set(rec.agentId, { text: firstLine, at: new Date(rec.endedAt), ok: rec.ok })
            loaded++
            break outer
          } catch { /* skip corrupt file */ }
        }
      }
    }
    return loaded
  }

  /**
   * Drop history folders older than retention window. Cheap startup-time
   * sweep — once a day is plenty, but doing it on every daemon boot is fine.
   */
  pruneTaskHistory(retentionDays = TASK_HISTORY_RETENTION_DAYS): number {
    const root = resolve(process.cwd(), TASK_HISTORY_DIR)
    if (!existsSync(root)) return 0
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    let removed = 0
    for (const agentDir of readdirSync(root)) {
      const agentPath = resolve(root, agentDir)
      let dayEntries: string[]
      try { dayEntries = readdirSync(agentPath) } catch { continue }
      for (const day of dayEntries) {
        const ts = Date.parse(day + "T00:00:00Z")
        if (Number.isNaN(ts) || ts >= cutoff) continue
        try { rmSync(resolve(agentPath, day), { recursive: true, force: true }); removed++ } catch { /* */ }
      }
    }
    return removed
  }

  /**
   * Newest-first list of task records for one agent, capped at `limit`.
   * Walks at most the last few day folders so this is O(limit), not O(history).
   */
  listTaskHistory(agentId: string, limit = 50): Array<Omit<TaskRecord, "transcript" | "responseText">> {
    const root = resolve(process.cwd(), TASK_HISTORY_DIR, this.safe(agentId))
    if (!existsSync(root)) return []
    const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    const out: Array<Omit<TaskRecord, "transcript" | "responseText">> = []
    for (const day of days) {
      if (out.length >= limit) break
      const dayDir = resolve(root, day)
      let files: string[]
      try { files = readdirSync(dayDir).filter((f) => f.endsWith(".json")) } catch { continue }
      // Sort by file mtime desc — task ids are timestamp-prefixed so lexicographic also works.
      files.sort().reverse()
      for (const f of files) {
        if (out.length >= limit) break
        try {
          const rec = JSON.parse(readFileSync(resolve(dayDir, f), "utf-8")) as TaskRecord
          const { transcript: _t, responseText: _r, ...summary } = rec
          out.push(summary)
        } catch { /* skip corrupt */ }
      }
    }
    return out
  }

  /**
   * Look up one task's full record (transcript included) across the retention window.
   */
  getTaskRecord(agentId: string, taskId: string): TaskRecord | null {
    const root = resolve(process.cwd(), TASK_HISTORY_DIR, this.safe(agentId))
    if (!existsSync(root)) return null
    const safeId = this.safe(taskId)
    const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    for (const day of days) {
      const file = resolve(root, day, `${safeId}.json`)
      if (existsSync(file)) {
        try { return JSON.parse(readFileSync(file, "utf-8")) as TaskRecord } catch { return null }
      }
    }
    return null
  }

  private safe(s: string): string {
    return s.replace(/[^a-zA-Z0-9_.:-]/g, "_")
  }

  /**
   * Operator stop. Aborts the in-flight run for `taskId` (kills the
   * underlying claude subprocess via the AbortSignal threaded through
   * runtime.ts). Returns the task's identity for HTTP / audit callers,
   * or null when no live run matches.
   */
  cancelRunningTask(taskId: string, reason = "operator"): { agentId: string; channel: string; chatId: string } | null {
    const entry = this.taskAborts.get(taskId)
    if (!entry) return null
    try {
      entry.controller.abort(new Error(reason))
    } catch { /* AbortController.abort never throws on modern Node, but defend */ }
    this.log(`[${entry.agentId}] task ${taskId} cancelled — ${reason}`)
    return { agentId: entry.agentId, channel: entry.channel, chatId: entry.chatId }
  }

  /**
   * Queue a follow-up correction/update for an in-flight task. The message
   * lands in the per-session MessageQueue and is dispatched after the
   * current run finishes — same path channel messages take while the agent
   * is busy. With `replace=true` we cancel the current run first so the
   * follow-up runs immediately.
   *
   * Returns the resolved identity + queue position, or null when no live
   * run matches taskId.
   */
  queueFollowUp(
    taskId: string,
    message: string,
    sender: string,
    opts: { replace?: boolean; reason?: string } = {},
  ): { agentId: string; channel: string; chatId: string; replaced: boolean; pending: number } | null {
    const entry = this.taskAborts.get(taskId)
    if (!entry) return null
    const { agentId, channel, chatId } = entry

    // On replace, frame the queued message so the agent knows it's a
    // correction to the cancelled prior turn, not a second independent
    // request. Without this, the session history shows two bare user
    // messages in a row (the cancelled run produced no assistant reply)
    // and the agent free-associates from its system prompt instead of
    // treating message #2 as a replacement for message #1.
    let text = message
    if (opts.replace) {
      const orig = (entry.originalMessage || "").trim().replace(/\s+/g, " ").slice(0, 240)
      text =
        `[OPERATOR CORRECTION] Your previous instruction was cancelled mid-execution by the operator. Ignore it entirely and do the following instead — this fully supersedes the cancelled ask:\n\n` +
        `${message}\n\n` +
        (orig ? `(For reference, the cancelled instruction was: "${orig}")` : "")
    }

    // Enqueue first so the cancel→flush ordering is deterministic: the
    // run's finally{} block flushes pending messages right after the
    // abort propagates, and the new message is already there.
    this.messageQueue.enqueue(agentId, channel, chatId, {
      text,
      sender,
      timestamp: Date.now(),
      channel,
      chatId,
      originalContext: { channel, chatId, sender },
    })
    const pending = this.messageQueue.pendingCount(agentId, channel, chatId)

    let replaced = false
    if (opts.replace) {
      const reason = opts.reason || `replaced by follow-up from ${sender}`
      try { entry.controller.abort(new Error(reason)) } catch { /* */ }
      this.log(`[${agentId}] task ${taskId} replaced by follow-up — ${reason}`)
      replaced = true
    } else {
      this.log(`[${agentId}] follow-up queued for task ${taskId} (pending=${pending})`)
    }
    return { agentId, channel, chatId, replaced, pending }
  }

  /**
   * Subscribe to live output for a running task. Returns the buffer that has
   * accumulated so far plus an unsubscribe handle. If the task is unknown,
   * returns null. If the task already finished, the subscriber is given the
   * tail buffer and immediately ended.
   */
  subscribeToTaskOutput(taskId: string, sub: TaskOutputSubscriber): { initial: string; done: boolean; unsubscribe: () => void } | null {
    const out = this.taskOutputs.get(taskId)
    if (!out) return null
    if (out.done) return { initial: out.buffer, done: true, unsubscribe: () => {} }
    out.subscribers.add(sub)
    return {
      initial: out.buffer,
      done: false,
      unsubscribe: () => { out.subscribers.delete(sub) },
    }
  }

  /**
   * Get token usage summary.
   */
  getUsage(days: number = 7) {
    return this.tokenTracker.summary(days)
  }

  /**
   * Get today's usage.
   */
  getTodayUsage() {
    return this.tokenTracker.today()
  }

  /**
   * Get the token tracker instance (for daemon hooks).
   */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker
  }
}
