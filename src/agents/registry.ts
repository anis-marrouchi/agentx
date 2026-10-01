import type { DaemonConfig, AgentDef } from "@/daemon/config"
import { cheapModelForEngine } from "./routing"
import { askSeat } from "@/decisions/seat"
import { PRE_SPAWN_SEAT_TIMEOUT_MS } from "@/decisions/limits"
import {
  SESSION_CONTINUITY_SEAT,
  continuityState,
  sessionContinuityQuestions,
  shouldRotateEarly,
  type ContinuityInput,
  type SessionContinuityAnswers,
} from "@/decisions/seats/session-continuity"
import { executeTask, type AgentTask, type AgentResponse, type StreamCallback, type ThinkingCallback, type AgentPeer } from "./runtime"
import { friendlyModelError, renderFriendlyError } from "./error-map"
import { SessionStore, detectLongMemoryHint, priorUserMessage, priorUserRequests } from "./sessions"
import { shouldCaptureEntry } from "@/wiki/capture-filter"
import { WikiHub } from "@/wiki"
import { RateLimiter } from "@/daemon/rate-limit"
import { TokenTracker, splitTaskUsageByTier } from "@/daemon/token-tracker"
import { buildAgentContext, type ContextInput } from "./context"
import { injectedContextOf } from "./injected-context"
import { Classifier, GraphStore, type ClassifyResult } from "@/graph"
import { HandoverStore } from "@/channels/handover-store"
import { MemoryStore } from "./memory-store"
import { AgentMemory } from "./agent-memory"
import { extractMemories } from "./memory-extract"
import { serializeOrigin } from "./resume/origin"
import { MessageQueue, staleQueueNote, type QueueMode, type QueuedMessage } from "./message-queue"
import { isQueued, queuedMarker } from "./queued"
import { loadBootstrapFiles, buildBootstrapContext, detectSoulSwitch, listSoulProfiles } from "./bootstrap"
import { PatternStore, extractPatterns } from "./patterns"
import { loadReferences, renderReferences } from "./references/loader"
import { getDefaultLedger } from "@/intent/instance"
import { loadRecipes, resolveRecipes, type RecipeIndex } from "./references/recipes"
import type { ReferenceIndex } from "./references/types"
import { getEventBus } from "@/events/bus"

/** How long the pipeline waits for the intent classification before
 *  workflow matching (cache hits only) and before the wiki entry stamp. */
const INTENT_WAIT_BEFORE_MATCH_MS = 250
const INTENT_WAIT_BEFORE_ENTRY_MS = 5_000
import { digestEvents, renderDigest, type SubscriptionInput } from "@/events/subscriptions"
import { newEventId } from "@/intent/ulid"
import { getAttachRegistry } from "@/attach"
import { isRestricted } from "@/guard/autonomy"
import { debug } from "@/observability/debug"
import type { LandscapeBuilder } from "./landscape"
import { preflightOverageGate } from "./overage-status"
import { getProcessRegistry } from "./process-registry-instance"
import { getMessageRouter } from "@/channels/router-instance"
import { preflightQuotaGate, recordClaudeCodeDispatch, warnIfNearingCap, setDispatchBudget } from "./claude-code-quota"
import { promptSizeKey, recordPromptSize, warnIfPromptGrowing } from "./prompt-size-tracker"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { WorkflowStore, matchWorkflow } from "@/workflows"
import { ProcedureStore } from "@/procedures"
import { matchProcedures, renderProcedureContext } from "@/procedures/match"
import { onAgentReply, onUserMessage, startTurnWatch } from "./turn-seats"
import { isHumanFacingTurn } from "@/a2a/initiator"
import { isPickup, senderOf } from "@/requests/tracker"
import { isOperatorTurn } from "@/requests/operator"
import { abortReason, untilAborted, withBudget, StepBudgetExceeded } from "./until-aborted"

/** Own limit for each preparation step, in ms. The run's pre-spawn
 *  deadline is minutes; these are seconds, and a best-effort step that
 *  loses its race is skipped rather than holding the run (#340). Steps
 *  not listed run under the pre-spawn deadline alone. */
const STEP_BUDGET_MS: Record<string, number> = {
  "request-gate": 5_000,
  "seed-history": 30_000,
  skills: 10_000,
  rotate: 8_000,
  compact: 30_000,
  references: 10_000,
  "plan-context": 12_000,
  "select-context": 5_000,
  "route-model": 5_000,
}
import { appAttachHint } from "@/utils/artifact-sentinel"
import { prepareOutbox } from "@/utils/app-outbox"

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
  /** First 200 chars of the user message, for dense lists. */
  messagePreview: string
  /** The whole request. A task page shows what was actually asked, and the
   *  preview cuts mid-sentence — or mid-JSON, which reads as a bug. */
  message: string
  /** Origin channel (telegram, whatsapp, gitlab, api, cron, business, a2a, …). */
  channel: string
  /** Group / chat / issue id from which the task arrived. */
  chatId?: string
  /** Sender id/name (user, agent id, "cron:<id>", "mesh:<peer>", …). */
  sender?: string
  /** Wall-clock start. */
  startedAt: Date
  /** The step the run is in right now (classify, compact, agent, …). A run
   *  that hangs shows here where it stopped. */
  step?: string
  /** Intent-graph path this request was classified under, once known.
   *  Classification runs alongside the turn, so it is absent until then. */
  intentPath?: string[]
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
/** How long a cancelled run's agent call may take to reap its subprocess
 *  before the run lets go of its slot anyway. */
const CANCEL_GRACE_MS = 30_000
/** Default for agents.<id>.preSpawnTimeoutSec when a definition skipped the schema. */
const PRE_SPAWN_TIMEOUT_SEC = 300

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
  /** Set when a deadline ended the run: `timeout`, with the step it was in. */
  status?: "timeout"
  step?: string
  /** Final agent text (one-shot, may be empty if streaming captured it). */
  responseText: string
  /** Terminal-style transcript captured from stream-json events. */
  transcript: string
}

/** Outcome of AgentRegistry.continueFinishedTask. `taskId` is the new run's
 *  dashboard id; absent when the message was queued behind a busy slot or
 *  answered without taking a slot (`answeredBy`), so there is no run to open. */
export type ContinueFinishedTaskResult =
  | { ok: true; agentId: string; channel: string; chatId: string; taskId?: string; queued: boolean; answeredBy?: "attached" | "other" }
  | { ok: false; status: 404 | 409 | 500; error: string }

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
/**
 * The wiki, injected as content on a fresh session.
 *
 * It used to be injected as an invitation: a paragraph telling the agent
 * that an institutional wiki existed and it could shell out to
 * `wiki query` if it wanted to. Four other knowledge layers — skills,
 * patterns, procedures, memory — arrived as content, already in context,
 * free to read. The wiki was the only one that cost a subprocess.
 *
 * Agents behaved exactly as that economy predicts. Over three months of
 * traces the wiki was queried a handful of times out of tens of
 * thousands of steps, while the prompt called it "the canonical source
 * for who people are, past events, decisions". Calling something
 * canonical does not make it cheap to read, and agents read what is
 * cheap.
 *
 * So the catalog goes in directly. Titles by type is the map — enough to
 * know what the institution knows and to name an article precisely —
 * and the query command stays for depth. Bodies are still fetched on
 * demand; injecting 500 articles would be the opposite mistake.
 *
 * Fresh sessions only. Under `--resume` the whole transcript is
 * replayed, so this block is still in the agent's context from turn one;
 * re-rendering it every turn is pure bloat, and per-turn bloat is what
 * drove tier-2 rotation and the "I have no prior context" failures.
 */
/**
 * Metadata stamped onto a captured wiki entry.
 *
 * Kept as a named function so the capture site stays readable and so the
 * shape is testable without standing up a registry. Empty objects
 * collapse to undefined — an entry with no metadata should carry no
 * frontmatter keys rather than an empty map that later parses as "we
 * looked and there was nothing".
 */
export function buildEntryMeta(
  intent: { path?: string[]; pathLabel?: string } | undefined,
  context: {
    sender?: string
    senderId?: string
    senderUsername?: string
    group?: string
  } | undefined,
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {}
  if (intent?.path?.length) {
    meta.intentPath = intent.path
    meta.intentPathLabel = intent.pathLabel
  }
  if (context?.sender) meta.sender = context.sender
  if (context?.senderId) meta.senderId = context.senderId
  if (context?.senderUsername) meta.senderUsername = context.senderUsername
  // Only worth recording alongside a sender; on its own `sourceContext`
  // already holds it.
  if (context?.group && context?.sender) meta.group = context.group
  return Object.keys(meta).length > 0 ? meta : undefined
}

/** The `digest` block for a fresh session: events matched by the agent's
 *  digest subscriptions since its last finished turn. Undefined when it has
 *  none or nothing matched. Callers gate on !resumeSessionId. */
export function buildEventDigest(agentId: string, subs: SubscriptionInput[] | undefined): string | undefined {
  if (!subs?.some((s) => s.delivery === "digest")) return undefined
  const { shown, more } = digestEvents(agentId, subs, getEventBus().recent())
  return renderDigest(shown, more)
}

export function buildWikiContext(
  agentWiki: ReturnType<WikiHub["getAgentWiki"]>,
  agentId: string,
  opts: { maxArticles?: number } = {},
): string {
  let articles: Array<{ meta: { title: string; type?: string }; path: string }>
  try {
    articles = agentWiki.listArticles(agentId)
  } catch {
    return ""
  }
  if (articles.length === 0) return ""

  const byType = new Map<string, string[]>()
  for (const a of articles) {
    const t = a.meta.type || "untyped"
    const list = byType.get(t) || []
    list.push(a.meta.title)
    byType.set(t, list)
  }

  // A corpus larger than the budget degrades to counts per type rather
  // than a truncated list: knowing 140 people are on file and how to ask
  // beats seeing the first 40 names and assuming that is all of them.
  const max = opts.maxArticles ?? 400
  const listed = articles.length <= max

  const catalog = Array.from(byType.entries()).sort()
    .map(([type, titles]) => listed
      ? `**${type}** (${titles.length}) — ${titles.sort().join(" · ")}`
      : `**${type}** — ${titles.length} article${titles.length === 1 ? "" : "s"}`)
    .join("\n")

  const cli = process.argv[1] || "dist/cli.js"
  const wikiDir = agentWiki.baseDir.replace(new RegExp(`/agents/${agentId}(/[^/]+)?$`), "")

  return [
    "[Institutional Wiki — the single source of truth]",
    `${articles.length} article${articles.length === 1 ? "" : "s"}. This is long-term memory for the whole fleet: who people are, what systems exist, what happened, what was decided, how we do things.`,
    "",
    "It outranks every other context you are given. Your workspace memory, injected skills, mined procedures and behavioural patterns are all either staged into the wiki or derived from it — where any of them disagrees with the wiki, the wiki is right and the other is stale.",
    "",
    "Catalog:",
    catalog,
    "",
    `For the contents of an article, or any question spanning several, run:\n  node ${cli} wiki query "the question" --dir ${wikiDir} --agent ${agentId}`,
    "",
    "It walks the catalog and the wikilink graph and returns a cited answer. Ask it before you grep the workspace or answer from your own recollection.",
    "",
    `Facts about outside systems (billing, accounts, outages, deploys) carry a source and a check date: \`node ${cli} wiki facts list --dir ${wikiDir}\`. Past its time limit a fact must be re-checked at the source before you state it; record what you checked with \`wiki facts set ... --checked-at now\`. If you can't check, say it is unverified and ask the owner.`,
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
/** A fresh phone chat: the outbox it names exists and old copies are gone
 *  (utils/app-outbox.ts). The hint goes out whatever the disk says. */
function withOutbox(workspace: string | undefined, hint: string): string {
  if (workspace) {
    try { prepareOutbox(workspace) } catch { /* the refusal still explains */ }
  }
  return hint
}

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
    if (t === "opencode.ready") return `. opencode ${event.reused ? "reused" : "started"} ready=${event.startupMs}ms\n`
    if (t === "opencode.first_output") return `. opencode first output=${event.elapsedMs}ms\n`
    if (t === "opencode.fallback") return `. opencode using CLI fallback: ${event.reason}\n`
    if (t === "codex.ready") return `. codex ${event.reused ? "reused" : "started"} ready=${event.startupMs}ms\n`
    if (t === "codex.first_output") return `. codex first output=${event.elapsedMs}ms\n`
    if (t === "codex.fallback") return `. codex using CLI fallback: ${event.reason}\n`
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
  /**
   * Voice chats a waiting question has claimed between its wait ending and
   * the chat being marked running (the rate limiter awaits in between).
   * Without the claim, two questions waiting on one chat could both see it
   * free and run at once.
   */
  private voiceClaims = new Set<string>()
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
   *  `originalMessage` is the user text recorded in SessionStore at the start
   *  of this run. When the operator presses Stop first then Update, we use it
   *  to drop the orphan cancelled turn from history so the Update reads as an
   *  edit, not a bare follow-up. */
  private taskAborts: Map<string, { agentId: string; channel: string; chatId: string; originalMessage: string; controller: AbortController }> = new Map()
  /** Runs a daemon shutdown stopped, with the reason each one reports. */
  private interruptedRuns: Map<string, string> = new Map()
  /** The context each running task was started with, by RunningTask id.
   *  Kept apart from RunningTask because /agents serialises that, and a
   *  context can carry a whole conversation history. Read by A2A
   *  delegation to find who started the caller's turn (#277). */
  private runningContexts = new Map<string, NonNullable<AgentTask["context"]>>()
  /** Idempotent cleanup per running task id, for runs that end before their
   *  own `finally` can run. */
  private runReleases: Map<string, (response: AgentResponse | undefined) => void> = new Map()
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
   * like "marketing" in prose or "devops-globex" quoted in a reply to trigger
   * agents spuriously. Intentional handoffs still work because agents
   * write explicit `@acme_X_bot` handles.
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
  /**
   * Ask the session-continuity seat whether to rotate before any
   * mechanical trigger fires. Returns true only for a confident,
   * active-mode early rotation.
   *
   * Never throws: askSeat is fail-open by contract, and everything else
   * here is a guarded read. Off, shadow, backend error and missing
   * history all return false, which is today's behaviour exactly.
   */
  private async maybeRotateForContinuity(
    task: AgentTask,
    state: { def: AgentDef },
    channel: string,
    chatId: string,
    resumeSessionId: string,
  ): Promise<boolean> {
    let previousMessage: string | null = null
    let minutesSinceLastTurn: number | null = null
    let recentRequests: string[] = []
    try {
      const session = this.sessions.getSession(task.agentId, channel, chatId)
      // Not simply the last user message: this turn's request was already
      // appended upstream, so that would compare the request to itself.
      // See priorUserMessage for why the seat stays shut when it does.
      previousMessage = priorUserMessage(session.messages, task.message ?? "")
      recentRequests = priorUserRequests(
        session.messages,
        task.message ?? "",
        this.config.session.continuityStateTurns,
      )
      if (session.updatedAt) {
        minutesSinceLastTurn = Math.round((Date.now() - Date.parse(session.updatedAt)) / 60_000)
      }
    } catch {
      /* a seat never breaks dispatch over missing history */
    }

    const input: ContinuityInput = {
      message: task.message ?? "",
      previousMessage,
      recentRequests,
      minutesSinceLastTurn,
      turnCount: this.sessions.getTurnCount(task.agentId, channel, chatId),
      lastTurnContextTokens:
        this.sessions.getLastTurnContextTokens(task.agentId, channel, chatId) || null,
      agentId: task.agentId,
      channel,
    }

    const result = await askSeat(
      SESSION_CONTINUITY_SEAT,
      continuityState(input),
      sessionContinuityQuestions,
      {
        // What the code does today: no mechanical trigger fired, so resume.
        incumbent: { continues: "yes", needsHistory: "yes" },
        links: [{ kind: "session", id: `${task.agentId}:${channel}:${chatId}` }],
        features: { agent: task.agentId, channel },
        // Pre-spawn: a slow answer is worth less than the seconds it
        // costs. The backend default (30s) was the cap before this.
        timeoutMs: PRE_SPAWN_SEAT_TIMEOUT_MS,
      },
    )
    if (!result || result.mode !== "active") return false

    const rotate = shouldRotateEarly(result.answers as SessionContinuityAnswers, {
      mechanicalRotation: false,
    })
    if (!rotate) return false

    this.log(`[${task.agentId}] continuity rotation for ${channel}:${chatId} (new subject)`)
    void this.captureRotationMemoAsync(
      task.agentId, state.def, resumeSessionId, channel, chatId, "continuity",
    )
    this.sessions.clearClaudeSessionId(task.agentId, channel, chatId)
    getEventBus().emit("session:rotated", {
      agentId: task.agentId, channel, chatId,
      reason: "continuity",
      at: new Date().toISOString(),
    })
    return true
  }

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
      // Claims go to wiki proposals, work state to memory (#273).
      const { storeRotationMemo } = await import("./rotation-memo-store")
      const stored = storeRotationMemo(this.memoryStore, this.sessions, {
        wikiDir: this.wikiHub.getBaseDir(), agentId, channel, chatId, reason, memo: result.memo,
      })
      if (stored.error) this.log(`[${agentId}] memo claims not proposed: ${stored.error}`)
      this.log(
        `[${agentId}] rotation memo captured (${reason}, ${result.durationMs}ms, ${result.memo.length} chars, ` +
        `${stored.proposals} claim(s) proposed to the wiki)`,
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
  async execute(task: AgentTask, onDelta?: StreamCallback, onThinking?: ThinkingCallback, onEvent?: (event: any) => void): Promise<AgentResponse> {
    const startedAt = Date.now()
    let response: AgentResponse
    try {
      response = await this.executeInternal(task, onDelta, onThinking, onEvent)
    } catch (e: any) {
      response = { content: "", error: e?.message ?? String(e) }
    }
    // Cut off by a daemon shutdown, at whatever step: report the restart,
    // not how the step read the kill.
    const interruptedBy = task.runningTaskId ? this.interruptedRuns.get(task.runningTaskId) : undefined
    if (interruptedBy) {
      this.interruptedRuns.delete(task.runningTaskId!)
      response = { ...response, content: "", error: interruptedBy, errorKind: "interrupted" }
    }
    // A run that threw or was cancelled before its own cleanup ran.
    if (task.runningTaskId) this.runReleases.get(task.runningTaskId)?.(response)
    // The preparation steps hit the pre-spawn deadline: the message was
    // never handed to a model. With the slot released, run it once more
    // from the start; a second stall is reported in plain words, not with
    // the internal error (#340).
    const preSpawn = !interruptedBy && response.error && /^timed out before spawn after/.test(response.error)
    if (preSpawn && !task.preSpawnRetry) {
      this.log(`[${task.agentId}] ${response.error}; retrying the run once`)
      return this.execute({ ...task, preSpawnRetry: 1, runningTaskId: undefined, onStart: undefined }, onDelta, onThinking, onEvent)
    }
    if (preSpawn) {
      const step = response.error!.match(/in step "([^"]+)"/)?.[1] ?? "start"
      response = {
        ...response,
        error: `I couldn't get started on this: preparing the run stalled twice (step "${step}"). Please send it again.`,
        errorKind: "interrupted",
      }
    }
    if (task.intentRef) {
      try {
        // A queued answer is an accepted message, not a failure (#282).
        const status = !response.error
          ? "completed"
          : isQueued(response.error)
            ? "queued"
            : (/timed out|timeout/i.test(response.error) ? "timed-out" : "failed")
        getDefaultLedger().recordResolution({
          decisionEventId: task.intentRef.eventId,
          decisionDecidedBy: task.intentRef.decidedBy,
          resolvedAt: Date.now(),
          status,
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
  private async executeInternal(task: AgentTask, onDelta?: StreamCallback, onThinking?: ThinkingCallback, callerOnEvent?: (event: any) => void): Promise<AgentResponse> {
    // Attach mode: a live Claude Code session may have claimed this identity.
    // If so it gets first refusal — but only for a bounded window. When the
    // human doesn't pick the message up we fall through to the normal spawn
    // path below, and the offer is atomically expired so a late drain can't
    // answer it a second time. Attach is a preference, never a black hole.
    // A restricted-autonomy routine never goes to an attached session: that
    // terminal runs with its own (full) permissions, outside the per-task
    // guard hook, so enforcement would be silently skipped.
    const restricted = isRestricted(task.autonomy)
    const offered = restricted ? null : getAttachRegistry().offer({
      agentId: task.agentId,
      text: task.message,
      channel: task.context?.channel || "api",
      chatId: String(task.context?.chatId || task.context?.group || "default"),
      sender: String(task.context?.sender || "unknown"),
    })
    if (offered) {
      const outcome = await offered
      if (outcome.kind === "answered") {
        this.log(`[${task.agentId}] answered by attached session ${outcome.sessionId}`)
        return { content: outcome.text, viaAttachedSession: outcome.sessionId } as AgentResponse
      }
      this.log(`[${task.agentId}] attached session did not take it (${outcome.reason}) — spawning`)
    }

    const state = this.agents.get(task.agentId)
    if (!state) {
      // The autonomy hook is spawned by THIS daemon; a peer would receive a
      // bare message and run it at full power. Refuse instead.
      if (restricted) {
        return { content: "", error: `autonomy "${task.autonomy}" cannot be enforced on a mesh peer — agent "${task.agentId}" is not local`, autonomy: task.autonomy }
      }
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
    // Held from a voice wait ending until the chat is marked running.
    let voiceClaim: string | undefined

    if (state.activeTasks >= state.def.maxConcurrent) {
      // Synchronous API callers (mesh /task, /ask, direct curl) can't observe
      // a queued result — the queue's flush callback re-routes via channels,
      // not back to the awaiting HTTP caller. Returning `error: __queued__`
      // surfaces as HTTP 500 on the /task endpoint and triggers an "Error
      // from peer" comment on whatever channel the upstream is bridged to.
      // For these callers, BLOCK and wait for a slot (up to 25 min — slightly
      // under mesh.sendTask's 30 min default cap) instead of queueing.
      // Restricted routines wait too: a queued message is later re-routed
      // as plain channel text, which would drop its autonomy level. So does
      // the reminders poller: "reminder" has no adapter to re-route to, and
      // it would read __queued__ as a refusal and dispatch the reminder again.
      // Event wakes ("events") wait so the turn runs inside the dispatch's
      // withRoot: a queued one would be flushed from the earlier run and
      // publish under that run's rootId, or merge with it in collect mode.
      // The phone app ("app") streams its answer back over the open request
      // and has no adapter either, so it waits the same way. Agent-to-agent
      // runs ("a2a", "mcp") are awaited by the delegating agent or by a
      // delegation callback (#277), and have no adapter to flush to.
      if (qChannel === "api" || qChannel === "app" || qChannel === "a2a" || qChannel === "mcp" || qChannel === "reminder" || qChannel === "events" || restricted) {
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
      } else if (qChannel === "voice") {
        // /ask waits on the answer to speak it, and "voice" has no adapter
        // to re-route a queued reply to: queued, it was answered into
        // nothing. Wait for the same voice chat instead, as the queue
        // would — other work on the agent still runs alongside.
        const start = Date.now()
        const maxWaitMs = 25 * 60_000
        const claim = `${task.agentId}\u0000${qChatId}`
        while (this.messageQueue.isBusy(task.agentId, qChannel, qChatId) || this.voiceClaims.has(claim)) {
          if (Date.now() - start > maxWaitMs) {
            return { content: "", error: `Agent "${task.agentId}" busy — voice wait timed out after ${Math.round(maxWaitMs / 60000)}m` }
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        voiceClaim = claim
        this.voiceClaims.add(claim)
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
          // A flushed message queued again keeps its first queue time, so
          // its eventual note reports the whole wait.
          queuedAt: task.queuedAt,
        })

        if (queued === "drop") {
          this.log(`[${task.agentId}] busy, message dropped (mode: drop)`)
          return { content: "", error: `Agent "${task.agentId}" is busy — message dropped` }
        }

        if (queued) {
          const pending = this.messageQueue.pendingCount(task.agentId, qChannel, qChatId)
          this.log(`[${task.agentId}] busy, message queued (mode: ${queued}, pending: ${pending}) behind=${state.runningTasks.map((r) => r.id).join(",") || "-"} chat=${qChannel}:${qChatId} at=${new Date().toISOString()}`)
          return {
            content: "",
            error: queuedMarker(queued, pending),
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
    // From here to markRunning below nothing awaits, so the chat is
    // marked busy before another waiter can look at it.
    if (voiceClaim) this.voiceClaims.delete(voiceClaim)
    if (!rateResult.ok) {
      this.log(`[${task.agentId}] ${rateResult.reason}`)
      return { content: "", error: rateResult.reason }
    }

    // A flushed queued message that waited long enough for its subject to
    // change is told so (#282). Added here, when it really starts, and
    // not in the flush: a message that has to queue again then carries
    // its clean text and first queue time, and gets exactly one note.
    if (task.queuedAt !== undefined) {
      const staleNote = staleQueueNote(task.queuedAt)
      if (staleNote) task.message = `${staleNote}\n${task.message}`
      task.queuedAt = undefined
    }

    state.activeTasks++
    state.totalTasks++
    state.lastActive = new Date()

    // Track the running task for live visibility (/agents endpoint surfaces this).
    const runningTask: RunningTask = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messagePreview: (task.message || "").slice(0, 200),
      message: task.message || "",
      channel: task.context?.channel || "api",
      chatId: task.context?.chatId || task.context?.group,
      sender: task.context?.sender,
      startedAt: new Date(),
    }
    state.runningTasks.push(runningTask)
    task.runningTaskId = runningTask.id
    this.runningContexts.set(runningTask.id, task.context ?? {})
    if (task.onStart) { try { task.onStart(runningTask.id) } catch { /* caller bug must not break the run */ } }

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

    // Persist each pipeline stage's wall time on the trace as a step named
    // "pipeline" with the stage as action. task_trace_steps.ms was NULL
    // for every row before this, so the pre-spawn cost could only be read
    // back from the daemon log.
    const recordPipelineStep = (stage: string, startedAt: number, status: "ok" | "error") => {
      try {
        getEventBus().emit("task:step", {
          taskId: traceTaskId,
          agentId: task.agentId,
          name: "pipeline",
          action: stage,
          status,
          ms: Date.now() - startedAt,
          at: new Date().toISOString(),
        } as any)
      } catch { /* observability never breaks the run */ }
    }
    // Spawn-to-first-event: the one number that separates CLI startup from
    // model latency inside the "agent" stage.
    let agentStartedAt = 0
    let firstEventSeen = false
    const noteFirstEvent = () => {
      if (firstEventSeen) return
      firstEventSeen = true
      if (agentStartedAt) recordPipelineStep("first-event", agentStartedAt, "ok")
    }

    let onEvent: ((event: any) => void) | undefined
    if (onDelta) {
      // Caller's onDelta still fires only for assistant text (unchanged).
      // Dashboard subscribers see the formatted stream-json firehose via onEvent
      // — this is what makes the modal feel like a live terminal.
      const formatter = makeStreamEventFormatter()
      onEvent = (event: any) => {
        noteFirstEvent()
        const formatted = formatter(event)
        if (formatted) pushToBuffer(formatted)
        // Per-step trace capture (improvement plan #2). Fire one
        // task:step event per tool_use / tool_result block. The
        // SQLite subscriber persists it under traceTaskId.
        emitTraceStepsFromStreamEvent(traceTaskId, task.agentId, event)
        tallyToolUses(toolUsesByName, event)
        // Caller-supplied event subscriber (HTTP SSE callers, etc.).
        // Fire after internal capture so a subscriber crash never breaks
        // our own bookkeeping.
        if (callerOnEvent) { try { callerOnEvent(event) } catch { /* */ } }
      }
    } else {
      // Even without a dashboard subscriber, we want trace steps for
      // /traces/:id. Build a minimal onEvent that ONLY emits steps.
      onEvent = (event: any) => {
        noteFirstEvent()
        emitTraceStepsFromStreamEvent(traceTaskId, task.agentId, event)
        tallyToolUses(toolUsesByName, event)
        if (callerOnEvent) { try { callerOnEvent(event) } catch { /* */ } }
      }
    }

    // Hard deadline for callers that set one (cron `timeout`, workflow agent
    // nodes, `agentx exec --timeout`). It fires the same abort as an operator
    // stop, so the runtime reaps its subprocess the same way.
    const deadlineMs = task.timeoutMinutes && task.timeoutMinutes > 0 ? task.timeoutMinutes * 60_000 : 0
    const deadline = deadlineMs
      ? setTimeout(() => abortController.abort(new Error(`timed out after ${Math.round(deadlineMs / 1000)}s`)), deadlineMs)
      : undefined
    deadline?.unref?.()
    // Every run, whatever started it, must reach its agent process (or hand
    // off to a workflow) within preSpawnTimeoutSec of taking the slot. A
    // pre-spawn step that never settles otherwise holds the slot forever.
    const preSpawnMs = (state.def.preSpawnTimeoutSec ?? PRE_SPAWN_TIMEOUT_SEC) * 1000
    let preSpawnDeadline: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      abortController.abort(new Error(`timed out before spawn after ${Math.round(preSpawnMs / 1000)}s in step "${runningTask.step ?? "start"}"`))
    }, preSpawnMs)
    preSpawnDeadline.unref?.()
    const clearPreSpawnDeadline = () => {
      if (preSpawnDeadline) clearTimeout(preSpawnDeadline)
      preSpawnDeadline = undefined
    }
    // Suffix for run log lines: which run, which chat, when.
    const runTag = () => `task=${runningTask.id} chat=${qChannel}:${qChatId} at=${new Date().toISOString()}`
    // The step a deadline (pre-spawn or timeoutMinutes) ended the run in.
    let timedOutStep: string | undefined
    abortController.signal.addEventListener("abort", () => {
      const reason = abortReason(abortController.signal).message
      if (/^timed out/.test(reason)) timedOutStep = runningTask.step ?? "start"
      this.log(`[${task.agentId}] task ${runningTask.id} aborted in step "${runningTask.step ?? "start"}" — ${reason} ${runTag()}`)
    }, { once: true })
    // Every await before and around the spawn goes through `step`, so a
    // cancel or deadline ends the run even when the awaited work never
    // settles. The step name is what /agents shows for a run that hangs.
    // `work` is a thunk so an aborted run never starts the next step: several
    // steps sit in best-effort try/catch blocks that swallow the rejection.
    const traceStep = (name: string) => {
      runningTask.step = name
      this.log(`[${task.agentId}] step ${name} ${runTag()}`)
    }
    const step = <T>(name: string, work: () => Promise<T>, graceMs = 0): Promise<T> => {
      if (abortController.signal.aborted) return Promise.reject(abortReason(abortController.signal))
      traceStep(name)
      // Spawning the agent (or handing off to a workflow) ends the pre-spawn phase.
      if (name === "agent" || name === "workflow-auto-run") {
        clearPreSpawnDeadline()
        agentStartedAt = Date.now()
      }
      const startedAt = Date.now()
      const bounded = withBudget(work(), STEP_BUDGET_MS[name] ?? 0, name)
      return untilAborted(bounded, abortController.signal, graceMs).then(
        (value) => { recordPipelineStep(name, startedAt, "ok"); return value },
        (err) => {
          recordPipelineStep(name, startedAt, "error")
          if (err instanceof StepBudgetExceeded) {
            this.log(`[${task.agentId}] ${err.message}; continuing without it ${runTag()}`)
          }
          throw err
        },
      )
    }
    /** A step the run can do without: past its budget, `fallback` stands
     *  in and the run goes on. Other failures still propagate. */
    const budgeted = async <T>(name: string, work: () => Promise<T>, fallback: () => T, graceMs = 0): Promise<T> => {
      try {
        return await step(name, work, graceMs)
      } catch (err) {
        if (err instanceof StepBudgetExceeded) return fallback()
        throw err
      }
    }

    // Give back everything the run holds. Idempotent: the `finally` below
    // calls it, and execute() calls it for a run that threw before reaching
    // that `try`.
    let released = false
    const releaseRun = (finalResponse: AgentResponse | undefined) => {
      if (released) return
      released = true
      this.runReleases.delete(runningTask.id)
      if (deadline) clearTimeout(deadline)
      clearPreSpawnDeadline()
      state.activeTasks--
      // Remove this run from the running-tasks list.
      const idx = state.runningTasks.findIndex((r) => r.id === runningTask.id)
      if (idx !== -1) state.runningTasks.splice(idx, 1)
      this.runningContexts.delete(runningTask.id)
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
          ...(timedOutStep ? { status: "timeout" as const, step: timedOutStep } : {}),
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
          this.log(`[${task.agentId}] flushing ${queued.length} queued message(s) after task=${runningTask.id} chat=${qChannel}:${qChatId} at=${new Date().toISOString()}`)
          // Re-execute each queued message as a new task. The original
          // inbound message (the one that triggered this run) was posted
          // back to its channel by the router after `registry.execute`
          // returned. Queued messages, however, are re-dispatched here
          // directly — bypassing the router — so we must explicitly post
          // the response back to the channel ourselves, or the user never
          // sees the reply. (Real symptom: operator hits Update on a
          // running task, the follow-up runs and produces a reply, but
          // nothing arrives in Telegram.)
          for (const qm of queued) {
            const ctx = (qm.originalContext as AgentTask["context"]) || {
              channel: qm.channel,
              sender: qm.sender,
              chatId: qm.chatId,
            }
            // queuedAt makes the run add the stale-state note when it
            // starts (#282). Only flushed queued turns carry it, so a
            // normal turn pays nothing for it.
            this.execute({
              message: qm.text,
              agentId: task.agentId,
              context: ctx,
              queuedAt: qm.queuedAt ?? qm.timestamp,
            })
              .then((resp) => this.postQueuedResponseToChannel(task.agentId, ctx, resp))
              .catch((e) => {
                this.log(`[${task.agentId}] queued message failed: ${e.message}`)
              })
          }
        })
        .catch((e) => {
          this.log(`[${task.agentId}] queue flush failed: ${e.message}`)
        })
    }
    this.runReleases.set(runningTask.id, releaseRun)

    // Mark session as running in the message queue
    this.messageQueue.markRunning(task.agentId, qChannel, qChatId)

    this.log(`[${task.agentId}] executing task (${state.activeTasks}/${state.def.maxConcurrent}) ${runTag()}`)

    // Build conversation history for session continuity
    const channel = task.context?.channel || "api"
    const { evaluateRequest, selectRequestContext } = await import("./request-planner")
    const requestGate = await budgeted(
      "request-gate",
      () => evaluateRequest(task.message, task.agentId, channel),
      (): Awaited<ReturnType<typeof evaluateRequest>> => ({ active: false, preprocess: false }),
    )
    if (requestGate.arm === "holdout") this.log(`[${task.agentId}] request-gate holdout: skipping Jev preprocessing for this turn`)
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
      await budgeted("seed-history", () => this.sessions.seedIfEmpty(task.agentId, channel, chatId, task.seedHistory), () => undefined)
    }

    // Shadow seats read the agent's last reply before this message joins it.
    const previousReply = [...this.sessions.getSession(task.agentId, channel, chatId).messages]
      .reverse().find(m => m.role === "agent")?.content
    onUserMessage({ agent: task.agentId, channel, chatId, message: task.message, previousReply, taskId: traceTaskId })

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
      requestText: task.requestText,
      at: new Date(taskStartedAt).toISOString(),
      taskId: traceTaskId,
      resumeOrigin: serializeOrigin(task.origin ?? {
        kind: "direct",
        context: task.context as Record<string, unknown> | undefined,
        model: task.model,
        autonomy: task.autonomy,
      }),
      resumeAttempt: task.resumeAttempt ?? 0,
      resumedFrom: task.resumedFrom,
      sender: senderOf(task.context),
      humanRoot: isHumanFacingTurn(task.context as any),
      pickup: isPickup(task.context),
      operator: isOperatorTurn(task.context),
    })

    // Classify the message through the intent graph when enabled. Skip for
    // a2a traffic — the classifier itself dispatches through /task, and
    // re-classifying its own prompts would recurse forever. Any classifier
    // failure (bad LLM output, schema rejection, network error) must never
    // propagate — the main task still has to run.
    //
    // The classification runs alongside the rest of the pipeline instead
    // of ahead of it. Measured at ~19s p50 per task (a fresh CLI spawn on
    // every cache miss) while nothing before the spawn needs the answer:
    // workflow matching and the context block take whatever has resolved,
    // and the wiki entry stamp at the end waits for it.
    let intent: ClassifyResult | undefined
    let intentPending: Promise<void> | undefined
    const classifier = this.classifier
    if (classifier && channel !== "a2a" && !isCodexCli) {
      traceStep("classify")
      const classifyStartedAt = Date.now()
      intentPending = classifier
        .classify({
          text: task.message,
          channel,
          sender: task.context?.sender,
          chatId,
          agentId: task.agentId,
        })
        .then(
          (r) => {
            intent = r || undefined
            if (intent?.path?.length) runningTask.intentPath = intent.path.slice()
            recordPipelineStep("classify", classifyStartedAt, "ok")
          },
          (e: any) => {
            this.log(`[classifier] classify failed for ${task.agentId}: ${e?.message || e}`)
            recordPipelineStep("classify", classifyStartedAt, "error")
          },
        )
    }
    /** Wait at most `maxMs` for the classification. Cache hits settle in
     *  a tick; an LLM miss keeps running and is picked up later. */
    const awaitIntent = async (maxMs: number): Promise<void> => {
      if (!intentPending) return
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        intentPending,
        new Promise<void>((r) => { timer = setTimeout(r, maxMs); timer.unref?.() }),
      ])
      if (timer) clearTimeout(timer)
    }
    await awaitIntent(INTENT_WAIT_BEFORE_MATCH_MS)

    const wfMatching = this.config.workflows?.matching
    // Decision-only here: compute whether auto-run should fire. We don't fire
    // the workflow yet — that happens inside the outer try/finally so
    // runningTask + activeTasks bookkeeping always cleans up.
    let pendingAutoRun: { workflowId: string; confidence: number } | undefined
    // Restricted routines never auto-run a workflow: its agent steps would
    // run at their own autonomy, not this task's.
    if (this.config.workflows?.enabled && wfMatching?.enabled && !restricted) {
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
    // hits (the old shallow-RAG path). The catalog itself is injected on
    // fresh sessions (see `wikiContext` below, once rotation has settled);
    // bodies are still fetched on demand by the agent through
    // `agentx wiki query`, so there is no retrieval cost on messages that
    // do not need it.
    const agentWiki = this.wikiHub.getAgentWiki(task.agentId)

    // Load persistent agent memory (cross-session facts)
    const relevantMemories = this.memoryStore.findRelevant(task.message, task.agentId, isCodexCli ? 3 : 8)
    // `let`, not `const`, because the planner strategy (below) may overwrite
    // this with its own curated memory bundle when enabled.
    let memoryContext = this.memoryStore.buildContext(relevantMemories)
    // Candidates only; what actually reached the prompt is decided after
    // the context is assembled (see injectedContextOf).
    let memoryFacts = this.memoryStore.contextFacts(relevantMemories)

    // Load behavioral patterns (self-improving loop)
    const relevantPatterns = this.patternStore.findRelevant(task.message, task.agentId, 5)
    const patternContext = this.patternStore.buildContext(relevantPatterns)

    // Auto-inject skills matched to current message
    let skillInjection = ""
    if (!isCodexCli) {
      try {
        const { loadLocalSkills, getAutoInjectSkills } = await import("@/agent/skills/loader")
        const skills = await step("skills", () => loadLocalSkills(state.def.workspace))
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
        : state.def.tier === "opencode"
          ? this.sessions.getOpenCodeSessionId(task.agentId, channel, chatId)
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

    // If the prior turn's END-OF-TURN CONTEXT (per-request input, not the
    // cumulative-with-cache-reads turn total) is near the 200K tier-2
    // boundary, rotate before paying the 1.5× multiplier again. Claude CLI
    // --resume replays every past tool result, so one genuinely bloated
    // context keeps billing tier-2 indefinitely until we drop the session.
    if (resumeSessionId && this.sessions.shouldRotateByTierTwo(task.agentId, channel, chatId)) {
      const lastTokens = this.sessions.getLastTurnContextTokens(task.agentId, channel, chatId)
      this.log(`[${task.agentId}] tier-2 rotation for ${channel}:${chatId} (last turn context: ${lastTokens} tokens ≥ ${this.sessions.getTierTwoThresholdTokens()})`)
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

    // --- Session-continuity seat -----------------------------------------
    //
    // Runs only when the mechanical triggers did NOT fire, and can only
    // rotate EARLY. The thresholds above stay authoritative: this may save
    // a transcript replay, never keep alive one the safety rules wanted
    // dead. See src/decisions/seats/session-continuity.ts for why the
    // asymmetry matters — the cost of resuming is exact, the cost of
    // rotating too early is amnesia, and optimising only the measurable
    // side is how the original rotation incident happened.
    if (resumeSessionId && state.def.tier === "claude-code") {
      const sessionId = resumeSessionId
      const rotatedEarly = await budgeted("rotate", () => this.maybeRotateForContinuity(
        task, state, channel, chatId, sessionId,
      ), () => false)
      if (rotatedEarly) resumeSessionId = undefined
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
      const compactResult = await step("compact", () => this.sessions.compactIfNeeded(
        task.agentId, channel, chatId, this.memoryStore,
      ))
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
    // accumulated assumptions (the diagnosis from initech-v2 review). Tighter
    // cap forces code-first investigation; thread remains accessible via
    // `gh`/`glab` if the agent explicitly fetches it. Gated behind
    // AGENTX_CONTEXT_SURGERY=1 for one-week soak before unconditional rollout.
    const surgeryEnabled = process.env.AGENTX_CONTEXT_SURGERY === "1"
    const historyCap = isCodexCli
      ? { maxMessages: 8, maxChars: 2400 }
      : (surgeryEnabled && isCodingChannelContext(channel, state.def.tier))
        ? { maxMessages: 6, maxChars: 1800 }
        : undefined

    // Fresh sessions only — `--resume` replays the transcript, so the
    // catalog injected on turn one is still there.
    const wikiContext = !resumeSessionId && !isCodexCli
      ? buildWikiContext(agentWiki, task.agentId)
      : undefined

    const sessionHistory = !resumeSessionId
      ? this.sessions.buildHistoryContext(
          task.agentId,
          channel,
          chatId,
          historyCap,
        )
      : undefined

    // Continuity memo from the previous (rotated) session — deterministic
    // handover so a fresh session opens knowing the ongoing task instead
    // of amnesiac. Fresh-session-only, same gate as the history rebuild:
    // a resumed session already carries this context natively, and
    // re-injecting per-turn is exactly the bloat that used to force
    // premature tier-2 rotation.
    const rotationMemo = !resumeSessionId
      ? this.sessions.getRotationMemo(task.agentId, channel, chatId) ?? undefined
      : undefined

    // Matched procedures — user-perspective SOPs mined from recurring
    // activity. Fresh-session-only, same gate and same reasoning as
    // rotationMemo/references above: a warm session already saw the block,
    // and per-turn re-injection is the bloat that forces tier-2 rotation.
    // Warm sessions can pull one on demand via `agentx procedure match`.
    let procedureContext: string | undefined
    let procedureCandidates: Array<{ id: string; title: string }> = []
    if (this.config.procedures?.injection?.enabled && !resumeSessionId && !isCodexCli) {
      try {
        const procStore = new ProcedureStore({
          baseDir: resolve(process.cwd(), this.config.procedures.dir),
        })
        const procMatches = matchProcedures(task.message, procStore.list(), {
          limit: this.config.procedures.injection.maxProcedures,
          minScore: this.config.procedures.injection.minScore,
        })
        if (procMatches.length > 0) {
          procedureContext = renderProcedureContext(procMatches)
          procedureCandidates = procMatches.map((m) => ({ id: m.procedure.meta.id, title: m.procedure.meta.title }))
          for (const m of procMatches) {
            this.log(`[${task.agentId}] procedure match ${m.procedure.meta.id} score=${m.score.toFixed(2)} (${m.reasons.join(",")})`)
          }
        }
      } catch (e: any) {
        this.log(`[${task.agentId}] procedure matcher failed (non-fatal): ${e?.message || e}`)
      }
    }

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
          const [refs, recipes] = await step("references", () => Promise.all([
            loadReferences(state.def.workspace),
            loadRecipes(state.def.workspace),
          ]))
          if (refs.byId.size === 0 && recipes.recipes.length === 0) {
            const [rootRefs, rootRecipes] = await step("references", () => Promise.all([
              loadReferences(process.cwd()),
              loadRecipes(process.cwd()),
            ]))
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
    // observed "Jordan Ellis" gmail-search failure) or pester the user.
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
    if (strategy === "planner" && !requestGate.active && channel !== "voice" && channel !== "desktop") {
      try {
        const { planContext } = await import("./context-planner")
        const plan = await step("plan-context", () => planContext({
          agentId: task.agentId,
          channel,
          chatId,
          message: task.message,
          sessions: this.sessions,
          memoryStore: this.memoryStore,
        }))
        if (plan) {
          plannerSucceeded = true
          sessionHistoryOverride = plan.sessionHistory
          memoryContext = plan.memoryContext
          memoryFacts = plan.memoryFacts
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

    // Rich-reply convention — only on interactive chat channels, and only when
    // the agent hasn't opted out. Rides the cacheable system prompt so it
    // costs nothing per turn. Kept short and conditional ("when it genuinely
    // helps") so agents don't spray buttons on every reply.
    const richReplyInstruction = richReplyPrompt(state.def.richMessages, channel)

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
      richReplyInstruction,
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
      procedureContext,
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
      wikiContext,
      handoverNote: this.buildHandoverNote(task.agentId, channel, chatId),
      rotationMemo,
      // Checked here, after the planner may have dropped the session.
      eventDigest: !resumeSessionId ? buildEventDigest(task.agentId, this.config.agents[task.agentId]?.subscriptions ?? state.def.subscriptions) : undefined,
      // How to show a file on the phone: once, when the session starts.
      // Sent only on a fresh app session with rich messages on (#259); the
      // outbox is prepared only when the hint that names it goes out (#258).
      attachHint: (() => {
        const hint = appAttachHint(channel, !resumeSessionId, state.def.richMessages)
        return hint ? withOutbox(state.def.workspace, hint) : undefined
      })(),
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

    const selectedContext = requestGate.active && requestGate.preprocess
      ? await budgeted("select-context", () => selectRequestContext(contextInput), () => ({ input: contextInput, excluded: [] as string[] }))
      : { input: contextInput, excluded: [] }
    if (selectedContext.excluded.length) this.log(`[${task.agentId}] request-context excluded: ${selectedContext.excluded.join(", ")}`)

    const historyContext = buildAgentContext(
      selectedContext.input,
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

    // Lesson impact (#98): the memory, procedure and wiki ids that made it
    // into this prompt, for `agentx trace lessons`. Ids only, capped.
    const injectedContext = injectedContextOf(historyContext, {
      memory: memoryFacts,
      procedures: procedureCandidates,
      wikiContext: selectedContext.input.wikiContext,
    })

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
    // Route mechanical work to a cheaper model, when the seat is active
    // and sure. Everything that is not an explicit confident "no" keeps
    // the agent's own model — see agents/routing.ts for why the failure
    // has to land on the expensive side.
    //
    // Awaited rather than fired off, because the answer has to be in hand
    // before the task runs; it is one Noul against a message that is
    // already in memory, and it never blocks a task from running.
    let routedModel: string | undefined
    const cheapModel = cheapModelForEngine(state.def.tier, this.config.decisions.routing)
    if (!task.model && cheapModel && (!requestGate.active || requestGate.preprocess)) {
      try {
        const { routeTaskModel } = await import("./routing")
        const route = await step("route-model", () => routeTaskModel({
          message: task.message,
          agent: task.agentId,
          channel,
          isFollowUp: Boolean(resumeSessionId),
          // Idle time decides whether the cache this would give up still
          // exists. See routing.ts for the arithmetic.
          sessionIdleMs: this.sessions.sessionIdleMs(task.agentId, channel, chatId),
          cheapModel,
        }))
        if (route.downgraded) {
          routedModel = route.model
          this.log(`[${task.agentId}] ${route.reason}`)
        }
      } catch {
        /* routing is an optimisation; never let it stop a task */
      }
    }

    const taskWithSystemPrompt: AgentTask = {
      ...task, systemPromptAppend,
      ...(routedModel ? { model: routedModel } : {}),
    }

    let finalResponse: AgentResponse | undefined
    // Set once the run emitted its own task:completed; the finally below
    // emits one for a run that ended before reaching it.
    let completedEmitted = false
    // turn-progress shadow seat: watches the tool steps of this turn.
    const turnWatch = startTurnWatch({
      agent: task.agentId, request: task.message, taskId: traceTaskId,
      budgetMinutes: state.def.maxExecutionMinutes ?? 20,
    })
    const unwatchedOnEvent = onEvent
    onEvent = (event: any) => {
      turnWatch.observe(event)
      unwatchedOnEvent?.(event)
    }
    try {
      // Workflow auto-run short-circuit. When the matcher upstream picked a
      // workflow at >= autoRunThreshold AND `workflows.matching.mode == "auto"`,
      // fire that workflow now and return. The workflow owns posting any
      // reply via its action.send / agent nodes; we return an empty content
      // with a metadata marker so the caller knows not to send a redundant
      // agent reply. On runner failure, we log and fall through to normal
      // agent execution — auto-run is best-effort, never a footgun.
      const autoRunner = this.workflowAutoRunner
      if (pendingAutoRun && autoRunner) {
        const autoRun = pendingAutoRun
        try {
          const result = await step("workflow-auto-run", () => autoRunner({
            workflowId: autoRun.workflowId,
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
              matchedWorkflowId: autoRun.workflowId,
              matchConfidence: autoRun.confidence,
            },
          }))
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
        traceStep("dispatch-gate")
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

      // Tiers other than claude-code don't emit stream-json events into
      // onEvent — they only call onDelta with text chunks. Without
      // wiring those chunks into the modal buffer, /live's task modal
      // came up blank for orchestrator-tier (acme-public) and
      // codex-cli runs even when text was actively streaming back to
      // the caller. Wrap onDelta only for non-claude-code tiers; for
      // claude-code the formatter (onEvent → pushToBuffer) is already
      // the authoritative source — wrapping there would double-print
      // every text chunk in the modal.
      const tierUsesStreamJson = state.def.tier === "claude-code"
      const wrappedOnDelta: StreamCallback | undefined = tierUsesStreamJson
        ? onDelta
        : (text, fullText) => {
            if (text) pushToBuffer(text)
            if (onDelta) onDelta(text, fullText)
          }
      // Thinking chunks land on a side channel: we forward to the
      // caller's onThinking (chat endpoint surfaces them as
      // delta.reasoning_content on the SSE wire) AND push to the
      // modal buffer with a `💭 ` prefix only on the first chunk so
      // the dashboard's line-based renderer treats the whole run of
      // reasoning as a single thought event instead of one per token.
      let thinkingOpen = false
      const wrappedOnThinking: ThinkingCallback | undefined = tierUsesStreamJson
        ? onThinking
        : (text) => {
            if (text) {
              if (!thinkingOpen) {
                pushToBuffer(`💭 ${text}`)
                thinkingOpen = true
              } else {
                pushToBuffer(text)
              }
            }
            if (onThinking) onThinking(text)
          }
      // When the agent transitions back to text, close any open
      // thought block in the modal so the next text chunk doesn't
      // get folded into the same line.
      const closeThinkingIfOpen = () => {
        if (thinkingOpen) { pushToBuffer("\n"); thinkingOpen = false }
      }
      const wrappedOnDeltaWithThinkingClose: StreamCallback | undefined = tierUsesStreamJson
        ? wrappedOnDelta
        : wrappedOnDelta
          ? (text, fullText) => { closeThinkingIfOpen(); wrappedOnDelta(text, fullText) }
          : undefined
      // The runtime reaps its own subprocess on abort; the grace only covers
      // a runtime that never returns.
      const response = await step("agent", () => executeTask(state.def, taskWithSystemPrompt, this.providers, wrappedOnDeltaWithThinkingClose, historyContext, resumeSessionId, onEvent, abortController.signal, wrappedOnThinking), CANCEL_GRACE_MS)

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

      // Stopped by a daemon shutdown: say so, whatever the runtime made of
      // the kill, and leave the trace in flight so the next boot resumes it.
      const interruptedBy = this.interruptedRuns.get(runningTask.id)
      if (interruptedBy) {
        response.content = ""
        response.error = interruptedBy
        response.errorKind = "interrupted"
      }

      finalResponse = response

      // Split this request's tokens into tier1/tier2 buckets so subscribers
      // (sqlite usage_daily, audit, dashboard) record both lanes. The same
      // threshold that TokenTracker.record() applies — extracted as a
      // helper so the two sites can never drift.
      const split = response.usage ? splitTaskUsageByTier(response.usage) : undefined
      completedEmitted = true
      getEventBus().emit("task:completed", {
        taskId: traceTaskId,
        agentId: task.agentId,
        channel,
        chatId,
        durationMs: Date.now() - taskStartedAt,
        error: response.error || undefined,
        errorKind: response.error ? response.errorKind : undefined,
        interrupted: interruptedBy ? true : undefined,
        inputTokens: split?.inputTokens,
        outputTokens: split?.outputTokens,
        cacheReadTokens: split?.cacheReadTokens,
        cacheCreateTokens: split?.cacheCreateTokens,
        tier2InputTokens: split?.tier2InputTokens,
        tier2OutputTokens: split?.tier2OutputTokens,
        tier2CacheReadTokens: split?.tier2CacheReadTokens,
        tier2CacheCreateTokens: split?.tier2CacheCreateTokens,
        resumed: Boolean(resumeSessionId),
        resumeSessionId: resumeSessionId || undefined,
        jevArm: requestGate.arm,
        numTurns: response.numTurns,
        injectedContext,
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
        onAgentReply({ agent: task.agentId, channel, chatId, request: task.message, reply: response.content, taskId: traceTaskId })

        // Store native CLI session IDs for future resume.
        if (response.claudeSessionId) {
          this.sessions.setClaudeSessionId(task.agentId, channel, chatId, response.claudeSessionId)
        }
        if (response.codexSessionId) {
          this.sessions.setCodexSessionId(task.agentId, channel, chatId, response.codexSessionId)
        }
        if (response.opencodeSessionId) {
          this.sessions.setOpenCodeSessionId(task.agentId, channel, chatId, response.opencodeSessionId)
        }

        // Record this turn's usage so next task can decide whether to rotate:
        // turnCount + cumulative lastTurnInputTokens (observability) +
        // per-request lastTurnContextTokens (the actual rotation metric).
        // Only meaningful when we kept a claude session — skip otherwise so the
        // counter isn't incremented for tiers that don't use --resume.
        if ((response.claudeSessionId || response.codexSessionId || response.opencodeSessionId) && response.usage) {
          this.sessions.recordTurnUsage(task.agentId, channel, chatId, response.usage, response.contextTokens)
        }

        // Tier-2 warning: Claude bills the 1.5× long-context rate when a
        // single REQUEST's input crosses 200K — so judge by the end-of-turn
        // per-request context size, not the cumulative turn total (which
        // sums cache reads across every call and reads 10-20× too high).
        // Next turn will auto-rotate (see shouldRotateByTierTwo); logging
        // THIS turn keeps it observable.
        if (response.usage) {
          const contextSize = response.contextTokens
          const cumulative =
            (response.usage.inputTokens || 0) +
            (response.usage.cacheReadTokens || 0) +
            (response.usage.cacheCreateTokens || 0)
          if ((contextSize ?? cumulative) >= this.sessions.getTierTwoThresholdTokens()) {
            this.log(`[${task.agentId}] TIER-2 HIT on ${channel}:${chatId}: context=${contextSize ?? "n/a"} tokens (cumulative turn total=${cumulative}) — next turn will rotate`)
          }
        }

        // Wiki: export conversation as raw entry for later absorption.
        //
        // Filtered at the door. The old gate was response length alone, so
        // every task was captured with its own prompt as the "User:" half:
        // cron prompts, role briefs, missed-run notices. Of the 10,703
        // entries that produced, 47.5% were machine-origin or prompt-shaped,
        // against 257 articles ever compiled. Sifting that with Sonnet at
        // absorb time costs ~19 minutes a run; rejecting it here costs a
        // regex.
        const wikiCapture = shouldCaptureEntry({
          channel,
          content: `User: ${task.message}`,
          responseLength: response.content.length,
        })
        if (wikiCapture.capture) {
          // The entry carries the classifier's path; by now the turn has
          // run for seconds to minutes, so this rarely waits at all.
          await awaitIntent(INTENT_WAIT_BEFORE_ENTRY_MS)
          try {
            const entryId = `${task.agentId}-${Date.now().toString(36)}`
            this.wikiHub.getSharedStore().addEntry({
              id: entryId,
              date: new Date().toISOString().slice(0, 10),
              agentId: task.agentId,
              source: channel,
              sourceContext: task.context?.group || task.context?.sender,
              content: `User: ${task.message}\n\nAgent: ${response.content}`,
              // Who actually spoke.
              //
              // `sourceContext` collapses group and sender into one slot
              // and the group wins, so in a group chat the speaker was
              // dropped on the floor — and group chat is where most
              // people talk. Across a month of entries not one recorded
              // a sender, which is why the wiki could describe someone's
              // billing thread in detail and not know how to reach them:
              // the fact was never captured, so no prompt and no lookup
              // could recover it.
              //
              // senderId is the platform's own identifier — on WhatsApp
              // that is the JID, which is the number itself. Capturing
              // it here means the identifier arrives with the entry
              // instead of being reconstructed later from a directory.
              // Stamp the classifier's path on the entry so `wiki absorb` can
              // propagate it to the article's `graphPath` without
              // reconstructing fingerprints from transformed content. Without
              // this, articles never carry graphPath and the wiki retrieval
              // scorer multiplies the graph weight (default 0.6) by 0.
              meta: buildEntryMeta(intent, task.context),
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
            (response.tokensUsed ? ` (${response.tokensUsed} tokens)` : "") + ` ${runTag()}`,
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
      turnWatch.stop()
      // A run that threw before its completion event (a pre-spawn abort, a
      // cancel, an unexpected error) still closes its trace; otherwise the
      // row stayed "in-flight" and the next boot resumed it as cut-off work
      // (#340). A shutdown interruption keeps it open on purpose.
      if (!completedEmitted) {
        try {
          getEventBus().emit("task:completed", {
            taskId: traceTaskId,
            agentId: task.agentId,
            channel: qChannel,
            chatId: qChatId,
            durationMs: Date.now() - runningTask.startedAt.getTime(),
            error: finalResponse?.error || (abortController.signal.aborted ? abortReason(abortController.signal).message : "run ended before completion"),
            errorKind: finalResponse?.errorKind,
            interrupted: this.interruptedRuns.has(runningTask.id) ? true : undefined,
            at: new Date().toISOString(),
          } as any)
        } catch { /* observability never breaks the run */ }
      }
      releaseRun(finalResponse)
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

  /** drainTimeoutSeconds of each agent with a run in flight (undefined when
   *  unset), so a stop can wait as long as the longest of them asks. */
  runningAgentDrainSeconds(): Array<number | undefined> {
    const out: Array<number | undefined> = []
    for (const s of this.agents.values()) if (s.activeTasks > 0) out.push(s.def.drainTimeoutSeconds)
    return out
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
   * Post a queued message's response back to its originating channel.
   * Used by the flush block in `execute()` — channel messages that arrive
   * while the agent is busy are queued and re-dispatched here, bypassing
   * the router; without this helper the agent's reply would never reach
   * the user. Skipped silently for internal channels (`test`, `api`,
   * `a2a`, `cron`, `workflow`, …) where no adapter is registered.
   */
  private postQueuedResponseToChannel(
    agentId: string,
    ctx: AgentTask["context"],
    resp: AgentResponse,
  ): void {
    const router = getMessageRouter()
    if (!router) return
    const channel = ctx?.channel
    const chatId = ctx?.chatId
    if (!channel || !chatId) return
    // Operator-cancelled / queued-marker — nothing to deliver
    if (resp.errorKind === "cancelled" || resp.errorKind === "interrupted") return
    if (isQueued(resp.error)) return
    const text = resp.error
      ? `Error: ${resp.error}`
      : (resp.content || "").trim()
    if (!text) return
    // Resolve account binding for shared-channel adapters (Telegram is
    // multi-account); sendOutbound auto-fills accountId from agentId.
    router.sendOutbound({ channel, chatId, text, agentId } as any)
      .catch((e: any) => this.log(`[${agentId}] queued response post failed: ${e?.message ?? e}`))
  }

  /** The agent running `taskId` right now, or null once it has finished.
   *  Lets an HTTP caller that names its task prove which agent it is. */
  runningTaskOwner(taskId: string): { agentId: string; channel: string; chatId?: string } | null {
    for (const s of this.agents.values()) {
      const t = s.runningTasks.find((r) => r.id === taskId)
      if (t) return { agentId: s.id, channel: t.channel, chatId: t.chatId }
    }
    return null
  }

  /** A running turn of `agentId` and the context it started with, for
   *  A2A delegation (#277). With `taskId` it must be that run; with a
   *  channel and chat it must be the only run on that chat. With neither
   *  there is no answer: guessing "the agent's only turn" could attach a
   *  same-host proxy's request to an unrelated conversation. */
  findRunningTurn(
    agentId: string,
    by: { taskId?: string; channel?: string; chatId?: string } = {},
  ): { taskId: string; context: NonNullable<AgentTask["context"]> } | null {
    const state = this.agents.get(agentId)
    if (!state) return null
    let run: RunningTask | undefined
    if (by.taskId) {
      run = state.runningTasks.find((r) => r.id === by.taskId)
    } else if (by.channel && by.chatId) {
      const matches = state.runningTasks.filter((r) => r.channel === by.channel && r.chatId === by.chatId)
      run = matches.length === 1 ? matches[0] : undefined
    }
    if (!run) return null
    const context = this.runningContexts.get(run.id)
    return context ? { taskId: run.id, context } : null
  }

  /** Whether every slot of `agentId` is taken, and by which runs. Lets a
   *  synchronous delegation refuse at once when the only slot is held by
   *  the turn waiting on it (#277), instead of waiting 25 minutes. */
  slotHolders(agentId: string): { full: boolean; runIds: string[] } | null {
    const state = this.agents.get(agentId)
    if (!state) return null
    return { full: state.activeTasks >= state.def.maxConcurrent, runIds: state.runningTasks.map((r) => r.id) }
  }

  /** True while `agentId` has a turn running on this chat. */
  isChatBusy(agentId: string, channel: string, chatId: string): boolean {
    return this.messageQueue.isBusy(agentId, channel, chatId)
  }

  /**
   * The intent path of the turn running right now for this conversation,
   * or undefined while it is not classified yet (or nothing is running).
   * Tools launched by that turn ask for it through GET /agents/:id/intent-path;
   * reading the classification log instead would hand them the previous
   * request's path, since this turn's classification may still be in flight.
   */
  runningIntentPath(agentId: string, channel: string, chatId: string): string[] | undefined {
    const state = this.agents.get(agentId)
    if (!state) return undefined
    let latest: RunningTask | undefined
    for (const r of state.runningTasks) {
      if (r.channel !== channel || r.chatId !== chatId) continue
      if (!latest || r.startedAt > latest.startedAt) latest = r
    }
    return latest?.intentPath?.slice()
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
   * Daemon shutdown: stop every run still going once the drain limit is
   * spent. Each one ends as `interrupted` with `reason` rather than as a
   * failure of its own, and its trace stays in flight for resume on boot.
   * Returns how many runs it stopped.
   */
  interruptRunning(reason: string): number {
    let n = 0
    for (const [taskId, e] of this.taskAborts) {
      this.interruptedRuns.set(taskId, reason)
      try { e.controller.abort(new Error(reason)) } catch { /* */ }
      this.log(`[${e.agentId}] task ${taskId} interrupted — ${reason}`)
      n++
    }
    return n
  }

  /** Stop every in-flight run of `agentId` in one chat. Used when a streaming
   *  caller disconnects (the phone app's Stop). Returns how many it aborted. */
  cancelChatTasks(agentId: string, channel: string, chatId: string, reason = "operator"): number {
    let n = 0
    for (const [taskId, e] of this.taskAborts) {
      if (e.agentId === agentId && e.channel === channel && e.chatId === chatId && this.cancelRunningTask(taskId, reason)) n++
    }
    return n
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
  ): { agentId: string; channel: string; chatId: string; replaced: boolean; edited: boolean; pending: number } | null {
    const entry = this.taskAborts.get(taskId)
    if (!entry) return null
    const { agentId, channel, chatId, originalMessage } = entry

    // Inject model: Update appends a message to the same chat session;
    // the running task keeps going and the new message dispatches at the
    // first chance — same as sending a message to an ongoing Claude
    // session. Update never *initiates* a cancel (use Stop for that).
    //
    // BUT — if the controller is already aborted (operator pressed Stop
    // just before Update), the cancelled user turn is sitting in session
    // history with no agent reply. Leaving it there makes the Update
    // read as a bare orphan ask ("87" after a stranded "count up to 75"
    // → agent had no idea what "87" meant). So when we detect the
    // aborted state, we treat the Update as editing the cancelled
    // message in place: pop the orphan from session history before
    // enqueueing the new message.
    const isStopped = entry.controller.signal.aborted
    let edited = false
    if (isStopped && originalMessage) {
      edited = this.sessions.removeLastUserMessageIfMatches(agentId, channel, chatId, originalMessage)
    }

    this.messageQueue.enqueue(agentId, channel, chatId, {
      text: message,
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
      this.log(`[${agentId}] follow-up queued for task ${taskId} (pending=${pending}${edited ? ", edited cancelled turn" : ""})`)
    }
    return { agentId, channel, chatId, replaced, edited, pending }
  }

  /**
   * Operator follow-up on a task that has already finished: dispatch the
   * message as a new turn on the same (channel, chatId), so the session
   * resumes with the finished run's context.
   *
   * Scheduled runs only. A cron chat has no person on the other end, so the
   * Task page is the only place its reply is read. Resuming a Telegram or
   * GitLab conversation from here would run a turn whose reply never reaches
   * the person in that chat, which is worse than refusing.
   *
   * Resolves once the new run starts (with its task id, for the Task page)
   * or, if the message was queued or answered without a slot, once execute
   * returns without one.
   */
  async continueFinishedTask(
    agentId: string,
    taskId: string,
    message: string,
    sender: string,
    opts: { model?: (chatId: string) => string | undefined } = {},
  ): Promise<ContinueFinishedTaskResult> {
    const record = this.getTaskRecord(agentId, taskId)
    if (!record) return { ok: false, status: 404, error: `no task ${taskId} for agent ${agentId}` }
    if (record.channel !== "cron" || !record.chatId) {
      return { ok: false, status: 409, error: `task ${taskId} is finished; only scheduled (cron) runs can be resumed from the dashboard` }
    }
    const channel = record.channel
    const chatId = record.chatId
    return new Promise<ContinueFinishedTaskResult>((resolveStart) => {
      let settled = false
      const settle = (result: ContinueFinishedTaskResult) => {
        if (settled) return
        settled = true
        resolveStart(result)
      }
      this.log(`[${agentId}] operator resumed ${channel}:${chatId} from finished task ${taskId}`)
      this.execute({
        message,
        agentId,
        // The job's model override, so the resumed turn runs on the same
        // model as the scheduled one did.
        model: opts.model?.(chatId),
        context: { channel, chatId, sender },
        onStart: (id) => settle({ ok: true, agentId, channel, chatId, taskId: id, queued: false }),
      })
        .then((resp) => {
          // Only reached first when the run never took a slot: it was queued
          // behind a busy slot (the flush dispatches it later), answered
          // without one (attached session, mesh forward), or refused.
          if (isQueued(resp.error)) {
            settle({ ok: true, agentId, channel, chatId, queued: true })
          } else if (!resp.error) {
            // Delivered and answered. Reporting a failure here would invite a
            // duplicate Send.
            settle({ ok: true, agentId, channel, chatId, queued: false, answeredBy: resp.viaAttachedSession ? "attached" : "other" })
          } else {
            settle({ ok: false, status: 500, error: resp.error || "run did not start" })
          }
        })
        .catch((e) => settle({ ok: false, status: 500, error: e?.message ?? String(e) }))
    })
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

/** The rich-reply convention for an agent's system prompt: only on the
 *  interactive chat channels, and only when the agent hasn't opted out.
 *  Quick replies are offered in the phone app alone, which renders them. */
export function richReplyPrompt(richMessages: boolean | undefined, channel: string | undefined): string {
  if (richMessages === false || (channel !== "telegram" && channel !== "whatsapp" && channel !== "app")) return ""
  return [
    "[Rich replies]",
    "On this chat channel you may add buttons, a poll, or media to a reply by appending ONE fenced block at the very end:",
    "```agentx:ui",
    '{ "buttons": [{"label": "Open docs", "url": "https://..."}], "poll": {"question": "Ship it?", "options": ["Yes", "No"]}, "media": {"type": "image", "url": "https://..."} }',
    "```",
    "All fields are optional; include only what helps. Buttons must be https URLs (tappable callback actions aren't supported yet). Use this sparingly — only when a link, choice, or image genuinely improves the reply. The block is stripped from the visible text.",
    ...(channel === "app"
      ? ['In this phone app you may also offer up to 4 short answers the user can tap instead of typing: "quickReplies": ["Yes", "Not now"] (at most 40 characters each), or a button with a reply instead of a url: {"label": "Run the tests", "reply": "Please run the tests"}. A tap sends that text as the user\'s next message, nothing more. Offer them only when the user is likely to answer with one of them.']
      : []),
  ].join("\n")
}
