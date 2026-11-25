import { DELIVERED_SPOKEN, DELIVERED_TEXT, MidTurnInbox, midTurnChat, midTurnKey, type MidTurnEntry } from "./mid-turn"
import { redactSourcesRead } from "@/situations/sources/redact"
import type { DaemonConfig, AgentDef } from "@/daemon/config"
import { modelAfterSwitch } from "./engine-model"
import { cheapModelForEngine, triageModelFor, type RouteResult } from "./routing"
import { canHoldUpgrade, coldResumeChoice, heldEdgeRoute, isWarm, modelFitsRuntime, modelToStore, namedModelRotates, resumeModel, sameModel, warmEdgeRotates } from "./session-model"
import { IMPLIED_AT, edgeModelForEngine, edgePlanFor, edgeRouteLog, edgeSeatOn, jobModelFor, routeTaskEdge, type EdgeRouteResult } from "./edge-routing"
import { labelToolSetRun, startToolSetShadow } from "./tool-set"
import { decideResume, describeResume } from "./resume-gate"
import { askSeat, getSeatMode } from "@/decisions/seat"
import { getPolicy } from "@/guard/service"
import { gatesWithoutRow, liveGateRules } from "@/gates"
import { PRE_SPAWN_SEAT_TIMEOUT_MS } from "@/decisions/limits"
import {
  SESSION_CONTINUITY_SEAT,
  continuityState,
  sessionContinuityQuestions,
  shouldRotateEarly,
  type ContinuityInput,
  type SessionContinuityAnswers,
} from "@/decisions/seats/session-continuity"
import { executeTask, warmProcessChat, withCallerEnv, type AgentTask, type AgentResponse, type StreamCallback, type ThinkingCallback, type AgentPeer } from "./runtime"
import { friendlyModelError, renderFriendlyError } from "./error-map"
import { SessionStore, detectLongMemoryHint, priorUserMessage, priorUserRequests } from "./sessions"
import { shouldCaptureEntry } from "@/wiki/capture-filter"
import { CAPTURE_RUNS_FILE, recordCaptureSkip, recordCaptureWrite } from "@/wiki/capture-runs"
import { WikiHub } from "@/wiki"
import { RateLimiter } from "@/daemon/rate-limit"
import { TokenTracker, splitTaskUsageByTier } from "@/daemon/token-tracker"
import { buildAgentContext, type ContextInput } from "./context"
import { injectedContextOf } from "./injected-context"
import { Classifier, GraphStore, type ClassifyResult } from "@/graph"
import { HandoverStore } from "@/channels/handover-store"
import { MemoryStore } from "./memory-store"
import { AgentMemory, agentMemoryStartBlock } from "./agent-memory"
import { extractMemories } from "./memory-extract"
import { redactSecrets } from "./memory-trust"
import { serializeOrigin, type RunOrigin } from "./resume/origin"
import { buildTimeLimitNote, DEFAULT_TIME_LIMIT_SETTINGS, handedOffTimeLimitError, planTimeLimit, reportedTimeLimitError } from "./resume/time-limit"
import { describeJobState, JOB_STATE_ASK, JOB_STATE_RULE, jobStateInText, needsJobState, stalledLine, stateOnAnswer, withoutStateLines, type JobState } from "./run-state"
import { isQuietAnswer } from "@/crons/quiet"
import { withoutExitMarker } from "@/crons/exit-check"
import { emitSignal } from "@/improve/signals"
import { queueCostSignals, startTokens } from "@/improve/cost"
import { queueAwarenessSignals, type RunEnd } from "@/improve/awareness"
import { queueBayanSignals } from "@/improve/bayan"
import { MessageQueue, staleQueueNote, type QueueMode, type QueuedMessage } from "./message-queue"
import { homesOfRun, normalizeHome, sameHomeNote } from "@/a2a/home"
import { isQueued, queuedMarker } from "./queued"
import { loadBootstrapFiles, buildBootstrapContext, detectSoulSwitch, listSoulProfiles } from "./bootstrap"
import { PatternStore, extractPatterns } from "./patterns"
import { loadReferences, renderReferences } from "./references/loader"
import { getDefaultLedger } from "@/intent/instance"
import { loadRecipes, resolveRecipes, type RecipeIndex } from "./references/recipes"
import type { ReferenceIndex } from "./references/types"
import { getEventBus, type AgentXEvents } from "@/events/bus"

/** How long the pipeline waits for the intent classification before
 *  workflow matching (cache hits only) and before the wiki entry stamp. */
const INTENT_WAIT_BEFORE_MATCH_MS = 250
const INTENT_WAIT_BEFORE_ENTRY_MS = 5_000
import { digestEvents, renderDigest, type SubscriptionInput } from "@/events/subscriptions"
import { newEventId } from "@/intent/ulid"
import { currentRoot } from "@/events/envelope"
import { buildOwnerDecisions } from "./owner-decisions"
import { decisionPagesFor, decisionsForBlock } from "@/wiki/decision-approvals"
import { buildRulesBlock, parseRegistry, rulesForRun, rulesHash, wallProjectsOf, type RunFacts } from "./rules-registry"
import { repoOfChat } from "@/daemon/wall-projects"
import { WorkLanes, workKeyOf, takesNotices, isPersonChannel, isHomeRefusal, leaseHomeOf, type HomeEntry } from "./work-lane"
import { AgentNotices } from "./notices"
import { getAttachRegistry } from "@/attach"
import { isRestricted } from "@/guard/autonomy"
import { meshContextOf, meshForwardBlock, placedRefusalText } from "./mesh-safety"
import { isSshNode, runOverSsh, sshServerOf, type SshSpawn } from "./ssh-run"
import { fromPeer, issueKeyOfChat, issueOfChat, leftBehindNoteText, leftBehindOfTask, LOCAL_NODE, offlineNoteText, resolveRunNode, type IssueKey, type RunNodeDeps } from "@/channels/run-on"
import { debug } from "@/observability/debug"
import type { LandscapeBuilder } from "./landscape"
import { preflightOverageGate } from "./overage-status"
import { getProcessRegistry } from "./process-registry-instance"
import { getMessageRouter } from "@/channels/router-instance"
import { preflightQuotaGate, recordClaudeCodeDispatch, recordRateLimitEvent, recordSessionInit, warnIfNearingCap, setDispatchBudget } from "./claude-code-quota"
import { priorityOfTask, setPlanPriority } from "./plan-priority"
import { budgetConfigFrom, budgetProjectOf, preflightBudgetGate, setAgentBudgets, setBudgetProjectResolver } from "./agent-budget"
import { holdMessage, holdsRoot } from "./holds"
import { budgetProjectResolver } from "./budget-projects"
import { BudgetHolds, MAX_HELD_PER_AGENT } from "./budget-holds"
import { promptSizeKey, recordPromptSize, warnIfPromptGrowing } from "./prompt-size-tracker"
import { situationContextFor } from "@/situations/context"
import { withClaudeMdFiles, type SettingSource } from "./claude-md-chain"
import { describeProfile, fullClaudeArgs, isolatedClaudeArgs, leanClaudeArgs, leanConfig, leanLoadsWorkspace, onDemandContextNote, resolveSessionProfile } from "./session-profile"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { WorkflowStore, matchWorkflow } from "@/workflows"
import { workflowHintText } from "@/workflows/follow-up"
import { continuedRun, endedWithoutFailing, finishWrap, isReadOnlyToolUse, liveStep, requiredFor, shouldWrap, startWrap, TASK_WORKFLOW_ID, toolUsesOf, wrapHintText } from "@/workflows/required"
import type { RunStore as WorkflowRunStore } from "@/workflows/run-store"
import { randomUUID } from "crypto"
import { ProcedureStore } from "@/procedures"
import { matchProcedures, renderProcedureContext } from "@/procedures/match"
import { onAgentReply, onUserMessage, startTurnWatch } from "./turn-seats"
import { isHumanFacingTurn, isInsideDelegation } from "@/a2a/initiator"
import { isPickup, senderOf } from "@/requests/tracker"
import { wokenJobId } from "@/jobs/wake"
import { homeOfForgeChat } from "@/jobs/doors"
import { awaitsSlot } from "@/agents/await-slot"
import { isOperatorTurn } from "@/requests/operator"
import { recordGateEvent } from "@/gates/events"
import {
  STATUS_CLAIM_GATE, STATUS_CLAIM_RULE, STATUS_CLAIM_SEAT, claimAsk, judgeClaim, midRunClaims, notCheckedLine, statusClaimMode,
} from "@/gates/status-claim"
import type { SeatMode } from "@/decisions/store"
import { dueAtOf, taskTypeOf } from "@/agents/task-context"
import { personLimitsOf, nameMatches, operatorPerson, personOfTurn, refusedPerson } from "@/people/people"
import { MemberStore } from "@/members/store"
import { abortReason, untilAborted, withBudget, StepBudgetExceeded } from "./until-aborted"
import { CLOUD_SESSIONS_DEFAULTS, CloudSessionStore, decideCloudRoute, dispatchCloudSession, launchCloudSession, parseGitHubChatId as parseCloudTarget, type CloudRoute } from "./cloud-sessions"
import { SPEC_TESTS_DEFAULTS, SpecTestStore, claudeSpecAgent, commentOnIssueWithGh, execProcess, fetchIssueWithGh, planSpecTests, previousRunBlocks, runSpecTests, specTestAuthorInstructions, type SpecTestInput } from "./spec-tests"
import { TASK_WORKTREE_DEFAULTS, hasTargetWorktree, pickCheckout, prepareChangeWorktree, prepareTaskWorktree, pruneTaskWorktrees, requestMarkerInstruction, worktreeInstructions, worktreeTarget } from "./task-worktrees"
import { buildAgentEnv, claudeBillingEnv } from "@/utils/workspace-env"

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
  "route-edge": 5_000,
}
import { appAttachHint } from "@/utils/artifact-sentinel"
import { AdmissionQueue, DEFAULT_ADMISSION_SETTINGS, requestedPriorityOf, type AdmissionSettings, type AdmissionTicket } from "@/admission/queue"
import { waitRefusalText } from "@/admission/wait-notice"
import { ResourceSampler } from "@/native/resources"
import { prepareOutbox } from "@/utils/app-outbox"
import { parentRunOf } from "./run-workers"
import { TaskSessionIndex, type SessionPage } from "./task-session"

/** Channels that never have an outbound adapter: a queued reply on them
 *  stays on its task, so skipping the post is expected and not logged. */
const NO_ADAPTER_CHANNELS: ReadonlySet<string> = new Set([
  "requests", "a2a", "api", "cron", "workflow", "test", "mesh", "subagent", "mcp",
  "events", "reminder", "heartbeat", "system", "internal", "business", "selftest", "compaction",
])

// --- Agent Registry: lifecycle management + concurrency control ---

/**
 * Context Surgery — coding-channel detector. A `claude-code` or `codex-cli`
 * tier agent triggered by a github/gitlab webhook is doing focused code work
 * on one issue/PR. The mesh-peer landscape and full session-history aren't
 * useful in that context and bias the agent on noise.
 */
/** The code-first operating principle (Context Surgery, Fix 4) for coding
 *  tiers, empty for the rest so chat/orchestrator agents are unaffected.
 *  Lives in the cacheable system-prompt prefix. */
const CODE_FIRST_INSTRUCTION = "[Operating principle]\nAlways investigate the codebase before relying on issue history or comments. The code is the source of truth — start by reading relevant files (CLAUDE.md, then code), and consult conversation context only to clarify intent. Issue threads may contain wrong hypotheses; verify against the source."

/** Claude Code only (Codex has no Edit tool). Without it, about a third of
 *  runs of a six-file bug fix edited with a multi-line `sed`, left a
 *  duplicate line and spent one to three more model calls repairing it.
 *  With it, 0 of 20 runs needed an extra call against 7 of 20, and mean
 *  tokens fell 13 percent; output tokens rise, since an edit spells out
 *  the old and new text, so cost rose about 4 percent (#455,
 *  bench/results/jev-and-edit-followups.md). */
export const EDIT_TOOL_INSTRUCTION = "Change files with the Edit tool, one exact replacement per edit, not with sed, awk or a shell rewrite: a pattern that misses or matches twice leaves the file broken and costs another round. Several edits can go in one turn, and the tests can run in that same turn."

export function codingInstructions(tier: string): string {
  if (tier === "claude-code") return `${CODE_FIRST_INSTRUCTION}\n${EDIT_TOOL_INSTRUCTION}`
  if (tier === "codex-cli") return CODE_FIRST_INSTRUCTION
  return ""
}

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
  /** The id the run's trace is kept under, and the one `task:started`
   *  carries: what a request's run link holds. Absent until the trace
   *  is allocated. */
  traceId?: string
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
  /** The issues or merge requests the run is about (#1100), in the form
   *  src/a2a/home.ts compares. */
  homes?: string[]
  /** The step the run is in right now (classify, compact, agent, …). A run
   *  that hangs shows here where it stopped. */
  step?: string
  /** Intent-graph path this request was classified under, once known.
   *  Classification runs alongside the turn, so it is absent until then. */
  intentPath?: string[]
  /** Step autonomy the turn runs at (report | propose | act). Unset = act. */
  autonomy?: AgentTask["autonomy"]
  /** The workflow run this turn belongs to (#858): a step of a run, or
   *  the run a task is wrapped in under workflows.required. `step` and
   *  `title` are filled in when the agent list is read. */
  workflow?: { runId: string; workflowId?: string; step?: string; title?: string }
  /** The last line the run wrote to its live output (#1381): a tool
   *  call, a result or a line of its reply. Filled in when the agent list
   *  is read, never stored. */
  lastActivity?: string
  /** The run that started this one, when a caller named it (#2145): an
   *  agent's hand-off, agent.call or mesh.delegate. Shown on the Hub under
   *  that run; never used for access. */
  parent?: import("./run-workers").RunParent
  /** The workers this run started (#2145). Filled in by GET /agents,
   *  never stored. */
  workers?: import("./run-workers").RunWorker[]
}

type TaskOutputSubscriber = (chunk: string) => void

/** The last non-empty line of a run's output, secrets redacted, then cut
 *  to 160 characters. It goes out on /health, so redact before clamping
 *  (#1383). */
export function lastActivityLine(buffer: string): string | undefined {
  const lines = buffer.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = redactSecrets(lines[i].trim())
    if (line) return line.length > 160 ? line.slice(0, 159) + "…" : line
  }
  return undefined
}

interface TaskOutput {
  agentId: string
  buffer: string
  subscribers: Set<TaskOutputSubscriber>
  done: boolean
  endedAt?: Date
  /** Events reached the buffer while the run went (#2101 R16). */
  streamed?: boolean
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
/** How long a caller that waits for a busy agent's slot (api, a2a, mcp,
 *  ...) waits when its task names no `slotWaitMs`: slightly under
 *  mesh.sendTask's 30 min default cap. */
export const DEFAULT_SLOT_WAIT_MS = 25 * 60_000

/** Persisted record of a finished task, written to .agentx/task-history. */
export interface TaskRecord {
  id: string
  agentId: string
  channel: string
  chatId?: string
  sender?: string
  message: string
  /** What the person typed, when the caller kept it apart from the prompt
   *  around it (runPreview); the session view shows it (#2101 R4). */
  requestText?: string
  startedAt: string
  endedAt: string
  durationMs: number
  ok: boolean
  error?: string
  /** Set when a deadline ended the run: `timeout`, with the step it was in;
   *  `stopped` when a stop signal ended it (#857). */
  status?: "timeout" | "stopped"
  step?: string
  /** Final agent text (one-shot, may be empty if streaming captured it). */
  responseText: string
  /** Terminal-style transcript captured from stream-json events. */
  transcript: string
  /** The home the run held the lease on (#2084): counted per week. */
  home?: string
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

/** Where an agent posts a wiki note (#825), when notes are on. */
function wikiNotesHint(config: DaemonConfig): { inbox: string; daemonUrl: string } | undefined {
  const n = config.wikiNotes
  if (!n?.enabled || !n.inbox) return undefined
  const [host, port] = (config.node?.bind || "127.0.0.1:18800").split(":")
  return { inbox: n.inbox, daemonUrl: `http://${!host || host === "0.0.0.0" ? "127.0.0.1" : host}:${port || "18800"}` }
}

export function buildWikiContext(
  agentWiki: ReturnType<WikiHub["getAgentWiki"]>,
  agentId: string,
  opts: {
    maxArticles?: number
    notesInbox?: { inbox: string; daemonUrl: string }
    /** `wiki.startCatalog`. "counts" (default since #2002): one line per type
     *  with its count. "titles": every title, as before #2002. */
    catalog?: "counts" | "titles"
  } = {},
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
  //
  // #2002: counts are the default for every corpus. The full title list was
  // added because agents almost never ran `wiki query`; with counts they
  // have to ask again. The watch for one week after the deploy is
  // owner_check_mismatch and owner_reopened; if either rises, set
  // `wiki.startCatalog: "titles"` to bring the list back.
  const max = opts.maxArticles ?? 400
  const listed = opts.catalog === "titles" && articles.length <= max

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
    ...(listed ? [] : [
      "",
      `Titles are not listed here. To find a page: \`node ${cli} wiki search "words" --dir ${wikiDir} --agent ${agentId}\`.`,
    ]),
    "",
    `For the contents of an article, or any question spanning several, run:\n  node ${cli} wiki query "the question" --dir ${wikiDir} --agent ${agentId}`,
    "",
    "It walks the catalog and the wikilink graph and returns a cited answer. Ask it before you grep the workspace or answer from your own recollection.",
    "",
    `Facts about outside systems (billing, accounts, outages, deploys) carry a source and a check date: \`node ${cli} wiki facts list --dir ${wikiDir}\`. Past its time limit a fact must be re-checked at the source before you state it; record what you checked with \`wiki facts set ... --checked-at now\`. If you can't check, say it is unverified and ask the owner.`,
    ...(opts.notesInbox && opts.notesInbox.inbox !== agentId ? [
      "",
      `When you learn something the wiki should know (a change, a correction, a fact that went stale), leave a short note for the wiki run: \`node ${cli} wiki notes add --from ${agentId} --change "what changed" --source "where you saw it" --date YYYY-MM-DD --daemon ${opts.notesInbox.daemonUrl}\`. The run checks it before it changes anything. Notes stay inside the fleet; never put secrets in one.`,
    ] : []),
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

/** A run's short preview for lists (the Hub's tree, Running now, a trace
 *  row): the sentence the person typed when the caller kept it apart from
 *  the prompt around it (requestText), so a Hub chat question reads as the
 *  question and not as the "You are answering…" wrapper (#2101 R14). */
export function runPreview(task: { message?: string; requestText?: string }): string {
  return (task.requestText?.trim() || task.message || "").slice(0, 200)
}

/** A tool result or a thought on one line of the live output: the Hub chat
 *  and the phone read that output line by line (a marker opens a line), so
 *  a result's second line must not pass for the agent's answer. */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ↵ ").trim()
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

// Codex CLI and the persistent app server normalize these item types alike.
function codexToolStep(item: any) {
  switch (item?.type) {
    case "command_execution":
      return { tool: "Bash", input: { command: item.command }, result: item.aggregated_output ?? item.aggregatedOutput ?? item.output, error: Boolean(item.exit_code ?? item.exitCode) }
    case "mcp_tool_call":
      return { tool: [item.server, item.tool ?? item.name].filter(Boolean).join(" ") || "MCP", input: item.arguments, result: item.result ?? item.error, error: Boolean(item.error) }
    case "file_change":
      return { tool: "Edit", input: { path: item.changes?.[0]?.path }, result: undefined, error: false }
    default:
      return null
  }
}

export function emitTraceStepsFromStreamEvent(taskId: string, agentId: string, event: any): void {
  if (!event || typeof event !== "object") return
  const t = event.type
  const at = new Date().toISOString()
  const bus = getEventBus()

  if (t === "item.completed") {
    const step = codexToolStep(event.item)
    if (!step) return
    bus.emit("task:step", {
      taskId, agentId, at, name: "tool_use", action: step.tool,
      status: step.error || event.item.status === "failed" ? "error" : "ok",
      inputSummary: step.input ? clipForTrace(redactSourcesRead(JSON.stringify(step.input))) : null,
      outputSummary: step.result == null ? null : clipForTrace(redactSourcesRead(
        typeof step.result === "string" ? step.result : JSON.stringify(step.result),
      )),
    } as any)
    return
  }
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
          outputSummary: content ? clipForTrace(redactSourcesRead(content)) : null,
          at,
        } as any)
      }
    }
    return
  }
}

/** Writes a non-claude-code runtime's thinking tokens into the task
 *  buffer. Each line of reasoning starts with `💭 `: the renderers and the
 *  phone's trimmer (app-task-stream.ts) read the buffer line by line, and a
 *  bare line would read as the answer (#2137 B1). A formatted event (an
 *  `[error] …\n` from a retried provider error, a tool line) can land in
 *  the buffer in the middle of a thought; the thought is then no longer the
 *  buffer's last line, so the next token starts a new `💭 ` line (#2137
 *  review C2, Hakim on #2148). Exported for tests. */
export function makeBufferThinkingWriter(
  buffer: () => string,
  push: (chunk: string) => void,
): { think(text: string): void; close(): void } {
  let open = false
  const thoughtIsLastLine = () => {
    const b = buffer()
    return b.slice(b.lastIndexOf("\n") + 1).startsWith("💭 ")
  }
  return {
    think(text) {
      if (!text) return
      const lines = text.replace(/\n/g, "\n💭 ")
      if (open && thoughtIsLastLine()) { push(lines); return }
      // On its own line: after a text delta the buffer has no newline.
      const b = buffer()
      push(`${b && !b.endsWith("\n") ? "\n" : ""}💭 ${lines}`)
      open = true
    },
    close() {
      if (open && thoughtIsLastLine()) push("\n")
      open = false
    },
  }
}

/** Exported for tests (test/app-live-2103.test.ts). `atLineStart` reads
 *  the task buffer: on tiers other than claude-code, text deltas go into
 *  the buffer without passing through this formatter, so only the buffer
 *  knows whether a marker needs a newline first (#2137 review B1, Hakim on
 *  #2148). Without it, the formatter goes by what it wrote last. */
/** Tools whose input the Task page shows as a diff (#2101 R16). */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])

export function makeStreamEventFormatter(atLineStart?: () => boolean): (event: any) => string {
  let textSeen = ""
  // A text block began in partial events and none of its words are out yet.
  let blockStarted = false
  let codexTextSeen = ""
  const openCodexTools = new Set<string>()
  // A text delta ends with no newline, so a marker line that follows it
  // starts with one: readers split the buffer at "\n<marker>", and a marker
  // glued to the answer would read as answer text (#2137 review, Hakim on
  // #2148).
  let lineStart = true
  const line = (s: string): string => ((atLineStart ? atLineStart() : lineStart) ? s : `\n${s}`)
  const format = (event: any): string => {
    if (!event || typeof event !== "object") return ""
    const t = event.type
    if (t === "opencode.ready") return line(`. opencode ${event.reused ? "reused" : "started"} ready=${event.startupMs}ms\n`)
    if (t === "opencode.first_output") return line(`. opencode first output=${event.elapsedMs}ms\n`)
    if (t === "opencode.fallback") return line(`. opencode using CLI fallback: ${event.reason}\n`)
    if (t === "codex.ready") return line(`. codex ${event.reused ? "reused" : "started"} ready=${event.startupMs}ms\n`)
    if (t === "codex.first_output") return line(`. codex first output=${event.elapsedMs}ms\n`)
    if (t === "codex.fallback") return line(`. codex using CLI fallback: ${event.reason}\n`)
    if (t === "codex.spawned") {
      const model = event.model ? ` model=${event.model}` : ""
      const resume = event.resumeSessionId ? ` resume=${String(event.resumeSessionId).slice(0, 8)}` : ""
      return line(`. codex started${model}${resume}\n`)
    }
    if (t === "thread.started") {
      const tid = event.thread_id ? ` thread=${String(event.thread_id).slice(0, 8)}` : ""
      return line(`. codex thread started${tid}\n`)
    }
    if (t === "turn.started") return line(". codex turn started\n")
    if (t === "turn.completed") {
      const usage = event.usage || {}
      const input = usage.input_tokens ?? usage.inputTokens
      const output = usage.output_tokens ?? usage.outputTokens
      const tokens = input || output ? ` input=${input || 0} output=${output || 0}` : ""
      return line(`. codex turn completed${tokens}\n`)
    }
    if (t === "item.started" || t === "item.completed") {
      const item = event.item || {}
      if (item.type === "agent_message" && typeof item.text === "string") {
        const text = item.text
        const delta = text.startsWith(codexTextSeen) ? text.slice(codexTextSeen.length) : text
        codexTextSeen = text.startsWith(codexTextSeen) ? text : codexTextSeen + text
        return delta
      }
      const step = codexToolStep(item)
      if (step) {
        const input = clip(redactSourcesRead(JSON.stringify(step.input ?? {})), 800)
        const call = `→ ${step.tool.replace(/\s+/g, "_")}(${input})\n`
        if (t === "item.started") {
          if (item.id) openCodexTools.add(item.id)
          return line(call)
        }
        const started = openCodexTools.delete(item.id)
        const output = typeof step.result === "string" ? step.result : (step.result == null ? "" : JSON.stringify(step.result))
        const body = clip(redactSourcesRead(output), 800).replace(/\r?\n/g, "\u2028")
        const error = step.error || item.status === "failed"
        return line((started ? "" : call) + `← ${error ? "[error] " : ""}${body}\n`)
      }
      const label = item.type || "item"
      const name = item.name || item.command || item.tool_name || item.id || ""
      if (t === "item.started") return `\n> codex ${label}${name ? ` ${name}` : ""}\n`
      const summary = item.output || item.result || item.text || item.error || ""
      return line(`< codex ${label}${name ? ` ${name}` : ""}${summary ? `: ${clip(redactSourcesRead(String(summary)), 800)}` : ""}\n`)
    }
    if (t === "error" || t === "turn.failed") {
      const msg = event.message || event.error || event.reason || JSON.stringify(event)
      return line(`[error] ${clip(String(msg), 800)}\n`)
    }
    if (t === "system" && event.subtype === "init") {
      const m = event.model ? ` model=${event.model}` : ""
      const sid = event.session_id ? ` session=${event.session_id.slice(0, 8)}` : ""
      return line(`· init${m}${sid}\n`)
    }
    if (t === "stream_event") {
      // Partial messages (--include-partial-messages): the answer arrives a
      // few words at a time, before the whole message. Only the main agent's
      // text is written here; a sub-agent's text, thinking and tool input
      // deltas wait for their whole message below (#2101 R16).
      const inner = event.event
      if (!inner || event.parent_tool_use_id) return ""
      if (inner.type === "content_block_start" && inner.content_block?.type === "text") {
        blockStarted = true
        return ""
      }
      if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && typeof inner.delta.text === "string" && inner.delta.text) {
        // The first words of a new block start on their own line; the
        // whole message that follows then adds nothing (it starts with
        // textSeen).
        const out = (blockStarted ? line("") : "") + inner.delta.text
        textSeen = blockStarted ? inner.delta.text : textSeen + inner.delta.text
        blockStarted = false
        return out
      }
      return ""
    }
    if (t === "assistant" && event.message?.content) {
      let out = ""
      for (const block of event.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          // A growing message (partial events) adds its new tail; a new
          // message after a tool step starts over, so it is written whole
          // even when shorter than the one before (#2101 R16).
          if (block.text.startsWith(textSeen)) {
            out += block.text.slice(textSeen.length)
          } else {
            out += line("") + block.text
          }
          textSeen = block.text
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          // An empty thought (only its signature came) is left out, not
          // shown as an empty fold.
          // Every line of a thought carries the marker (#2101 R16).
          out += `\n💭 ${clip(block.thinking, 600).replace(/\n/g, "\n💭 ")}\n`
        } else if (block.type === "tool_use") {
          const name = block.name || "tool"
          // An edit keeps enough of its input for the Task page to show it
          // as a diff (#2101 R16); other calls stay short.
          // Same redaction as tool results: a Write of a config file must not put
          // its keys on the Task page (#2163 review).
          const input = block.input ? clip(redactSecrets(redactSourcesRead(JSON.stringify(block.input))), EDIT_TOOLS.has(name) ? 8000 : 400) : ""
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
          // One line per result: its own newlines become U+2028, so the
          // reply that follows is never read as part of it (#2101 R16).
          out += (out ? "" : line("")) + `${flag}${clip(redactSecrets(redactSourcesRead(c)), 800).replace(/\r?\n/g, "\u2028")}\n`
        }
      }
      return out
    }
    if (t === "result") {
      const dur = event.duration_ms ? ` (${Math.round(event.duration_ms / 1000)}s)` : ""
      return line(`· done${dur}\n`)
    }
    return ""
  }
  return (event: any): string => {
    const s = format(event)
    if (s) lineStart = s.endsWith("\n")
    return s
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

/** The answer to an awaited caller refused on a home (#2084): another run
 *  of the agent held it past the caller's wait budget. Never run. */
function homeBusy(agentId: string, home: string, holder: string, waitedMs: number): AgentResponse {
  return {
    content: "",
    error: `home_busy: agent "${agentId}" is already working on ${home} (${holder}); waited ${Math.round(waitedMs / 60_000)} min, not run`,
    errorKind: "agent_busy",
  }
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
  /** See setSshSpawn. Unset: the real `ssh`. */
  private sshSpawn?: SshSpawn
  /** Issues with an SSH run going from this daemon (`<node> <repo>#<n>`).
   *  A placed run is sent before the chat queue, so this keeps two runs
   *  from preparing one worktree at once (#2134 review nit). */
  private sshRunsGoing = new Set<string>()
  private meshFallback?: {
    findPeerWithSkill: (skillId: string) => { peer: { url: string; token?: string } } | undefined
    sendTask: (peerName: string, text: string, agentId?: string, opts?: { timeoutMs?: number; context?: Record<string, unknown> }) => Promise<string>
    directory: () => Array<{ peer: string; healthy: boolean; skills: Array<{ id: string }> }>
  }
  /** See setStatusClaimMode. */
  private statusClaimModeOf?: () => SeatMode
  /** Gates without a Registry row are logged once per process (#2085 §3). */
  private gateRowsChecked = false
  /** See setTraceToolCalls. */
  private traceToolCalls?: (traceId: string) => Array<{ action: string | null; inputSummary: string | null }>
  /** See setTimeLimitHandoff. */
  private timeLimitHandoff?: (runIds: Array<string | undefined>, note: string) => string | null
  /** See setDueTimeGate. */
  private openRequestOnIssue?: (provider: "github" | "gitlab", project: string, number: number, agentId: string) => boolean
  /** See setCheckoutDirs. */
  private checkoutDirs?: () => string[]
  /** See setPlacements. */
  private placements?: RunNodeDeps
  private dueTimeGate?: (
    run: { agentId: string; channel: string; chatId: string; runIds: string[]; startedAt: number; reply: string },
    askAgent: (text: string) => Promise<{ reply?: string; error?: string }>,
  ) => Promise<unknown>
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
    /** Start it as a followed run (#858: workflows.required). */
    follow?: boolean
  }) => Promise<{ runId?: string; title?: string }>
  /** Where wrapped tasks keep their run (#858). Wired by the daemon with
   *  the workflow engine's run store; unset means no wrapping. */
  private workflowRuns?: WorkflowRunStore
  private messageQueue: MessageQueue
  /** Node-wide admission queue (#1521): every run waits here for room. */
  readonly admission: AdmissionQueue
  private admissionTickets = new WeakMap<AgentTask, AdmissionTicket>()
  /**
   * Voice chats a waiting question has claimed between its wait ending and
   * the chat being marked running (the rate limiter awaits in between).
   * Without the claim, two questions waiting on one chat could both see it
   * free and run at once.
   */
  private voiceClaims = new Set<string>()
  /** Messages for a run already going in their chat (mid-turn.ts). */
  readonly midTurn = new MidTurnInbox()
  /** One run at a time per agent and owner's request (work-lane.ts). */
  private workLanes = new WorkLanes({ log: (line) => this.log(line) })
  /** Notices for an agent's next run (notices.ts, /send/agent notice:true). */
  readonly notices: AgentNotices
  /** Chat messages waiting for an agent paused by its monthly budget (#1162). */
  private budgetHolds: BudgetHolds
  private budgetReleaseTimer: ReturnType<typeof setInterval> | null = null
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
  private taskAborts: Map<string, {
    agentId: string; channel: string; chatId: string; originalMessage: string; controller: AbortController
    /** What a stop signal needs to save and later re-enter the run (#857). */
    traceId?: string; sender?: string; rootId?: string; origin?: RunOrigin
    /** Set when the run is a workflow step (#857: not stoppable with a plan). */
    workflowRunId?: string
  }> = new Map()
  /** Runs a daemon shutdown stopped, with the reason each one reports. */
  private interruptedRuns: Map<string, string> = new Map()
  /** Runs a stop signal ended, with the reason each one reports (#857). */
  private stoppedRuns: Map<string, string> = new Map()
  /** The job's state a running run stated with agentx_job_state or
   *  agentx_waiting (run-state.ts), read when it ends. */
  private jobStates: Map<string, JobState> = new Map()
  /** See setJobStateListener. */
  private jobStateListener?: (runIds: Array<string | undefined>, ev: import("@/jobs/run-state-ledger").RunStateEvent) => void
  /** Callers waiting for a run to let go of its slot (whenRunEnds). */
  private runEndWaiters: Map<string, Array<() => void>> = new Map()
  /** Claude cloud sessions this node launched (#622), by issue. Created on
   *  first use so a fleet with the setting off never touches the file. */
  private cloudSessions?: CloudSessionStore
  /** Spec-test runs (#992), one per issue. Created on first use. */
  private specTests?: SpecTestStore
  /** Worktrees being made (#1292), by agent and issue, so two tasks on
   *  one issue arriving together share one `git worktree add`. */
  private worktreesPending = new Map<string, ReturnType<typeof prepareTaskWorktree>>()
  /** When each checkout's old worktrees were last pruned. */
  private worktreesPrunedAt = new Map<string, number>()
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
      tierTwoThresholdTokensByChannel: config.session.tierTwoThresholdTokensByChannel,
    })
    // graph/ is the canonical article folder: the CLI, the MCP wiki tool
    // and `agentx wiki prune` all use it. Reading "unified" here gave fresh
    // sessions an empty catalog and the mesh /wiki endpoints no articles
    // (#603).
    this.wikiHub = new WikiHub(undefined, undefined, "graph")
    this.memoryStore = new MemoryStore()
    this.patternStore = new PatternStore()
    this.rateLimiter = new RateLimiter()
    this.tokenTracker = new TokenTracker()
    this.messageQueue = new MessageQueue()
    // A message the running turn read mid-turn is not run again (mid-turn.ts).
    this.messageQueue.wasTaken = (id) => this.midTurn.isTaken(id)
    this.admission = new AdmissionQueue(
      () => this.admissionSettings(),
      // The disk that holds the daemon's data folder.
      new ResourceSampler(existsSync(resolve(process.cwd(), ".agentx")) ? resolve(process.cwd(), ".agentx") : process.cwd()),
      (m) => this.log(m),
      Date.now,
      (req) => getProcessRegistry()?.closeIdle(req) ?? [],
    )

    // Apply the claude-code fleet dispatch budget. See DaemonConfig.session
    // for the tuning knobs. Pools all claude-code agents under one counter
    // because they share the Max OAuth.
    setDispatchBudget({
      maxPerHour: config.session.maxClaudeCodeDispatchesPerHour,
      maxPer5h: config.session.maxClaudeCodeDispatchesPer5h,
    })
    setPlanPriority(config.session.planPriority)
    // Monthly money budgets (#1162, #1290). The daemon re-applies them on save.
    setAgentBudgets(budgetConfigFrom(config))
    setBudgetProjectResolver(budgetProjectResolver(config))
    // Notices not yet delivered are on disk too (#2121).
    this.notices = new AgentNotices({ file: resolve(process.cwd(), ".agentx/notices.json"), log: (m) => this.log(m) })
    // Held work is on disk, so a restart keeps it; release what may run.
    this.budgetHolds = new BudgetHolds(MAX_HELD_PER_AGENT, resolve(process.cwd(), ".agentx/budget-holds.json"), (m) => this.log(m))
    if (this.budgetHolds.size) {
      this.log(`[budget] ${this.budgetHolds.size} held message(s) kept from before the restart`)
      this.armBudgetRelease()
    }

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
  setWorkflowRunStore(runs: WorkflowRunStore | undefined): void {
    this.workflowRuns = runs
  }

  /** A running run states its job's state (agentx_job_state,
   *  agentx_waiting). False when no run with this id is going. */
  recordJobState(runningTaskId: string, state: JobState): boolean {
    if (!this.runningTaskOwner(runningTaskId)) return false
    this.jobStates.set(runningTaskId, state)
    return true
  }

  /** Told what each checked run said about its job: the daemon writes it
   *  on the job (jobs/run-state-ledger.ts). `runIds`: the run's trace id
   *  and running id, and the ask turn's when there was one. */
  setJobStateListener(fn: AgentRegistry["jobStateListener"]): void {
    this.jobStateListener = fn
  }

  private tellJobState(runIds: Array<string | undefined>, ev: import("@/jobs/run-state-ledger").RunStateEvent): void {
    try { this.jobStateListener?.(runIds, ev) } catch (e: any) { this.log(`[job-state] ledger write failed: ${e?.message ?? e}`) }
  }

  /** The state a run stated: with a tool while it ran, else on its last lines. */
  private takeJobState(task: AgentTask, response: AgentResponse): JobState | null {
    const id = task.runningTaskId
    const told = id ? this.jobStates.get(id) : undefined
    if (id) this.jobStates.delete(id)
    return told ?? jobStateInText(response.content)
  }

  /** The `status-claim` gate's switch (#2085 G3). Unset: the seat's mode. */
  setStatusClaimMode(fn: (() => SeatMode) | undefined): void {
    this.statusClaimModeOf = fn
  }

  /** Is this turn the owner's: the daemon marked it as the operator's, or
   *  the channel's sender resolves to a person with role owner (#2085 G3). */
  private isOwnerTurn(ctx: AgentTask["context"]): boolean {
    return isOperatorTurn(ctx) || personOfTurn(this.config.people, ctx as any)?.role === "owner"
  }

  /** A streamed answer to this turn holds from its first claim word: the
   *  `status-claim` seat is active and the turn is the owner's (#2085 v3 T,
   *  v4 T′, v5 T″). The router and /task stream through `ClaimHold` then. */
  holdsClaims(ctx: AgentTask["context"]): boolean {
    return (this.statusClaimModeOf ?? statusClaimMode)() === "active" && this.isOwnerTurn(ctx)
  }

  /** Wire the trace lookup a time-limit continuation lists the stopped
   *  run's tool calls from (#1257). Unset, the note lists none. */
  setTraceToolCalls(lookup: AgentRegistry["traceToolCalls"]): void {
    this.traceToolCalls = lookup
  }

  /** Wire the hand-off of a run stopped at its time limit to its job's
   *  wake (#1861): given the run's ids and the note, the id of the job
   *  that continues it, or null when none does. Unset, none does. */
  setTimeLimitHandoff(fn: AgentRegistry["timeLimitHandoff"]): void {
    this.timeLimitHandoff = fn
  }

  /** Wire the check a run's end goes through when its reply may set a
   *  due time (requests/due-gate.ts, #1908). It gets the run and a way
   *  to ask the agent one question in the same session. Unset: no check. */
  setDueTimeGate(fn: AgentRegistry["dueTimeGate"]): void {
    this.dueTimeGate = fn
  }

  /** Wire the check a queued message goes through when its turn comes
   *  (message-queue.ts): one that went out of date while it waited, like
   *  a plan step done meanwhile (#2280), is dropped, not run. */
  setQueuedOutdated(fn: MessageQueue["outdated"]): void {
    this.messageQueue.outdated = fn
  }

  /** Wire the open-request lookup by issue home (requests/store.ts): an
   *  issue with an open request when worktrees are turned on stays in the
   *  checkout (#2102). Unset: no issue counts as in progress by request. */
  setOpenRequestOnIssue(fn: AgentRegistry["openRequestOnIssue"]): void {
    this.openRequestOnIssue = fn
  }

  /** Where an issue's runs go (#2104 B1): the placement store and a
   *  request's home. Read at the start of every execute. */
  setPlacements(deps: RunNodeDeps): void {
    this.placements = deps
  }

  /** The placement of the issue a task names, "local" included, or null
   *  when there is none (or the task came from a peer). A mapping does not
   *  apply to a placed issue (#2104 B1). */
  placementOf(task: Pick<AgentTask, "context">): { node: string; key: IssueKey; held?: true } | null {
    const ctx = task.context as Record<string, unknown> | undefined
    if (!this.placements || fromPeer(ctx)) return null
    const hit = resolveRunNode({ context: ctx }, this.placements)
    return hit ? { node: hit.placement.node, key: hit.key, ...(hit.held ? { held: true as const } : {}) } : null
  }

  /** The nodes keeping work left behind on the issue a task names (#2104
   *  C-d): a mapped webhook's node is not sent its runs. */
  leftBehindOf(task: Pick<AgentTask, "context">): string[] {
    if (!this.placements) return []
    return leftBehindOfTask(task.context as Record<string, unknown> | undefined, this.placements)
  }

  /** The node a task's issue is placed on, or null: no placed issue, a
   *  placement on this node, or a task a peer sent (never forwarded twice). */
  placedNodeOf(task: Pick<AgentTask, "context">): { node: string; key: IssueKey; held?: true } | null {
    const hit = this.placementOf(task)
    return hit && hit.node !== LOCAL_NODE ? hit : null
  }

  /** A task whose issue is placed on a peer (#2104 B1) runs there: sent
   *  synchronously with its context, `placed: true` and the agent's time
   *  limit, and the peer's answer is this execute's answer, so records,
   *  links and the reply are written here as for a local run. Refused,
   *  not sent, when the peer cannot apply the run's autonomy or the
   *  person's limits (B2). Null: the task runs here. */
  private async runOnPlacedNode(task: AgentTask): Promise<AgentResponse | null> {
    const placed = this.placedNodeOf(task)
    if (!placed) return null
    const { node, key } = placed
    if (placed.held) {
      this.log(`[run-on] ${task.agentId} ${key.chatId} runs on "${node}", which keeps left-behind work: not sent`)
      return { content: "", error: leftBehindNoteText(node) }
    }
    const limits = personLimitsOf(this.config.people, task.context as any)
    const blocked = meshForwardBlock(task.agentId, task.autonomy, limits)
    if (blocked) {
      this.log(`[run-on] ${task.agentId} ${key.chatId} runs on "${node}": refused: ${blocked.error}`)
      return { content: placedRefusalText(node), duration: 0 }
    }
    if (isSshNode(node)) return this.runOnSshServer(task, node, key)
    const peer = this.meshFallback?.directory().find((p) => p.peer === node)
    if (!this.meshFallback || !peer) return { content: "", error: `This issue runs on ${node}, which is not a node of this mesh. Bring it back to this Mac from the Hub.` }
    if (!peer.healthy) return { content: "", error: offlineNoteText(node) }
    const def = this.agents.get(task.agentId)?.def
    const minutes = typeof task.timeoutMinutes === "number" && task.timeoutMinutes > 0 ? task.timeoutMinutes : def?.maxExecutionMinutes
    const ctx = (task.context ?? {}) as Record<string, unknown>
    // The peer runs it in the issue's chat (its worktree and session); a
    // turn that started elsewhere (a pick-up, a cron) says where.
    const sameChat = issueKeyOfChat(ctx.channel as string | undefined, ctx.chatId as string | undefined)?.chatId === key.chatId
    const context = {
      ...meshContextOf(ctx),
      channel: sameChat ? ctx.channel : key.channel,
      chatId: sameChat ? ctx.chatId : key.chatId,
      ...(sameChat ? {} : { placedFrom: { channel: ctx.channel ?? null, chatId: ctx.chatId ?? null } }),
      placed: true,
    }
    const start = Date.now()
    this.log(`[run-on] ${task.agentId} ${key.chatId}: placed on "${node}", sending the run there`)
    try {
      const content = await this.meshFallback.sendTask(node, task.message, task.agentId, { ...(minutes ? { timeoutMs: minutes * 60_000 } : {}), context })
      return { content, viaMesh: node, duration: Date.now() - start } as AgentResponse
    } catch (e: any) {
      this.log(`[run-on] ${task.agentId} ${key.chatId}: the run on "${node}" failed: ${e?.message ?? e}`)
      return { content: "", error: `The run on ${node} failed: ${e?.message ?? e}`, duration: Date.now() - start }
    }
  }

  /** Runs `ssh` for an issue placed on an SSH server; tests inject a fake. */
  setSshSpawn(fn: SshSpawn | undefined): void {
    this.sshSpawn = fn
  }

  /** A task whose issue is placed on an SSH server (#2104 PR 2) runs
   *  there, started by this daemon (agents/ssh-run.ts). The safety refusal
   *  above has already applied. The answer is this execute's answer, with
   *  the job state its last `State:` line gives; `viaMesh` names the
   *  server, so nothing asks a local session about a run it did not do. */
  private async runOnSshServer(task: AgentTask, node: string, key: IssueKey): Promise<AgentResponse> {
    const server = sshServerOf(node, this.config.sshServers)
    if (!server) return { content: "", error: `This issue runs on ${node}, which is not in sshServers on this Mac. Bring it back to this Mac from the Hub.` }
    const issue = issueOfChat(key.channel, key.chatId)
    if (!issue) return { content: "", error: `This issue runs on ${node}, but ${key.chatId} is not a forge issue.` }
    const def = this.agents.get(task.agentId)?.def
    const minutes = typeof task.timeoutMinutes === "number" && task.timeoutMinutes > 0 ? task.timeoutMinutes : (def?.maxExecutionMinutes ?? 20)
    const start = Date.now()
    const going = `${node} ${issue.project}#${issue.number}`
    if (this.sshRunsGoing.has(going)) return { content: "", error: `An earlier run of issue ${issue.number} is still going on ${node}. Wait for it to end, then run again.`, duration: 0 }
    this.sshRunsGoing.add(going)
    this.log(`[run-on] ${task.agentId} ${key.chatId}: placed on "${node}", running it there over SSH`)
    let out: Awaited<ReturnType<typeof runOverSsh>>
    try {
      out = await runOverSsh({ server, repo: issue.project, issue: issue.number, prompt: task.message, timeoutMs: minutes * 60_000, model: def?.model }, this.sshSpawn)
    } finally {
      this.sshRunsGoing.delete(going)
    }
    if (!out.ok) {
      this.log(`[run-on] ${task.agentId} ${key.chatId}: the run on "${node}" failed: ${out.error}`)
      return { content: "", error: out.offline ? `${offlineNoteText(node)} ${out.error}` : out.error, duration: Date.now() - start }
    }
    return { content: out.content, viaMesh: node, duration: Date.now() - start, ...(out.jobState ? { jobState: out.jobState } : {}) } as AgentResponse
  }

  /** The folders of this node's project rules (`runbook:`), where a task
   *  another node placed here (#2104) looks for its checkout: the sender's
   *  own runbook path means nothing on this machine. */
  setCheckoutDirs(fn: () => string[]): void {
    this.checkoutDirs = fn
  }

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

  /** The admission settings in force, read on every start. */
  private admissionSettings(): AdmissionSettings {
    const settings = (this.config.admission as AdmissionSettings | undefined) ?? DEFAULT_ADMISSION_SETTINGS
    // Emergency switch: no config edit, no restart.
    return process.env.AGENTX_ADMISSION === "off" ? { ...settings, enabled: false } : settings
  }

  /** Hot-swap the live DaemonConfig reference. Registry reads it lazily at
   *  execute-time for landscape + session policies, so next-task semantics
   *  match setProviders. */
  setConfig(next: DaemonConfig): void {
    this.config = next
    // An engine switch (the Hub's CLI drop-down, #2101) needs no restart: an
    // idle agent's next run reads the new tier; a busy one takes it when its
    // last run ends, so a run never changes engine under it.
    // The model goes over with the tier (B1): a Claude model on Codex CLI or
    // OpenCode fails the run, so a model the new engine cannot run is
    // dropped and the engine's default is used.
    for (const [id, def] of Object.entries(next.agents || {})) {
      const state = this.agents.get(id)
      if (!state) continue
      if (state.def.tier === def.tier) { this.pendingTiers.delete(id); continue }
      const model = modelAfterSwitch(def.model, def.tier)
      if (state.activeTasks > 0) {
        if (this.pendingTiers.get(id)?.tier !== def.tier) this.log(`[${id}] engine switch to ${def.tier} waits for ${state.activeTasks} run(s)`)
        this.pendingTiers.set(id, { tier: def.tier, model })
      } else {
        this.switchEngine(state, def.tier, model); this.pendingTiers.delete(id)
        this.log(`[${id}] engine switched to ${def.tier}${model ? ` (model ${model})` : " (engine's default model)"}`)
      }
    }
  }

  /** A tier (and its model) saved while the agent was busy, applied when its
   *  last run ends. */
  private pendingTiers = new Map<string, { tier: AgentDef["tier"]; model: string | undefined }>()
  private switchEngine(state: AgentState, tier: AgentDef["tier"], model: string | undefined): void {
    const { model: _old, ...rest } = state.def
    state.def = model ? { ...rest, tier, model } : { ...rest, tier }
  }
  private applyPendingTier(state: AgentState): void {
    const next = this.pendingTiers.get(state.id)
    if (state.activeTasks > 0 || !next) return
    this.switchEngine(state, next.tier, next.model)
    this.pendingTiers.delete(state.id)
    this.log(`[${state.id}] engine switched to ${state.def.tier} (its runs ended)`)
  }

  /** The engine an agent's next run uses (tests and the reload log). */
  tierOf(id: string): AgentDef["tier"] | undefined {
    return this.pendingTiers.get(id)?.tier ?? this.agents.get(id)?.def.tier
  }

  /** No new run may start: every slot is taken, or an engine switch waits
   *  for the runs still going (#2101), so every run that starts after the
   *  switch, queued ones too, starts on the new engine. */
  private slotFull(state: AgentState): boolean {
    return state.activeTasks >= state.def.maxConcurrent
      || (state.activeTasks > 0 && this.pendingTiers.has(state.id))
  }

  /** The native session a run on `tier` resumes for this chat. Each engine
   *  keeps its own id, so after a switch the new engine never gets the old
   *  engine's id: it starts fresh (or resumes its own earlier session). */
  resumeIdFor(agentId: string, tier: AgentDef["tier"], channel: string, chatId: string): string | undefined {
    return tier === "claude-code"
      ? this.sessions.getClaudeSessionId(agentId, channel, chatId)
      : tier === "codex-cli"
        ? this.sessions.getCodexSessionId(agentId, channel, chatId)
        : tier === "opencode"
          ? this.sessions.getOpenCodeSessionId(agentId, channel, chatId)
          : undefined
  }

  /** Swap the workflows block on a config reload (#858): matching,
   *  follow-up and required settings are read per turn. */
  setWorkflows(workflows: DaemonConfig["workflows"]): void {
    this.config = { ...this.config, workflows }
  }

  /** Swap the people list on a config reload (#384). Turns read it when
   *  they start, so the next turn is stamped from the new list. */
  setPeople(people: DaemonConfig["people"]): void {
    this.config = { ...this.config, people }
  }

  /** People permissions (#379): the note a limited person is answered with
   *  instead of reaching `agentId`, or null when the turn may go ahead. The
   *  limit follows them through a delegation (the root's person). Every way
   *  to an agent asks here before it starts: a run on this node, and the
   *  router and delegation paths to a mesh peer, which cannot check for
   *  itself (person ids are per machine). A refusal is kept in the
   *  per-person trail. */
  refusalFor(agentId: string, ctx: unknown): string | null {
    const refused = refusedPerson(this.config.people, agentId, ctx as any)
    if (!refused) return null
    this.log(`[${agentId}] refused: ${refused.person.id} may not reach this agent (people[].agents)`)
    this.memberTrail().log({ person: refused.person.id, event: "agent-refused", detail: agentId })
    return refused.note
  }

  /** A tool or skill call the guard hook denied for a person (#379), kept
   *  in their trail beside refused agents. */
  logToolRefusal(personId: string, agentId: string | undefined, detail: string): void {
    this.log(`[${agentId ?? "?"}] blocked for ${personId}: ${detail} (people[].deny)`)
    this.memberTrail().log({ person: personId, event: "tool-refused", detail })
  }

  private memberTrail(): MemberStore {
    const days = this.config.members.logRetentionDays
    if (!this.memberLog || this.memberLog.days !== days) this.memberLog = { days, store: new MemberStore(process.cwd(), Date.now, days) }
    return this.memberLog.store
  }
  private memberLog?: { days: number; store: MemberStore }

  /**
   * The Rules Registry block for this run (noqta#809), when `rules.enabled`.
   * Sent on a fresh session, and on a resumed one only when the block
   * differs from the one this session last got (`Session.rulesHash`). Never
   * throws: the block is optional. Codex runs get it too.
   */
  private rulesForRun(
    task: { agentId: string; workflowRunId?: string },
    channel: string,
    chatId: string,
    fresh: boolean,
  ): { block?: string; ids: string[] } {
    const cfg = this.config.rules
    if (!cfg?.enabled) return { ids: [] }
    try {
      const store = this.wikiHub.getAgentWiki(cfg.registryAgent)
      const page = store.readArticle(cfg.registryPage)
      if (!page) return { ids: [] }
      const required = this.config.wiki?.decisionApprovals?.required === true
      const [readable] = decisionsForBlock([page], store.baseDir, required)
      if (!readable) return { ids: [] }

      const workflowRunId = task.workflowRunId
        ?? (chatId.startsWith("workflow:") ? chatId.slice(9) || undefined : undefined)
      let cronSpec: string | undefined
      let scheduled = false
      if (chatId.startsWith("cron:")) {
        scheduled = true
        cronSpec = this.config.crons?.[chatId.slice(5)]?.schedule
      } else if (workflowRunId) {
        // A workflow node run (#803 R3, #813 R8): its schedule is the
        // workflow's own trigger.cron, not a `cron:<jobId>` chat.
        const run = this.workflowRuns?.get(workflowRunId)
        const wf = run ? new WorkflowStore({ baseDir: resolve(process.cwd(), this.config.workflows.dir) }).get(run.workflowId) : null
        const trigger = wf?.nodes.find((n) => n.type === "trigger.cron")
        const spec = (trigger?.config as { spec?: unknown } | undefined)?.spec
        if (typeof spec === "string" && spec.trim()) { scheduled = true; cronSpec = spec }
      }
      const agentDef = this.config.agents[task.agentId]
      const facts: RunFacts = {
        agentId: task.agentId,
        nodeName: this.config.node.name,
        projects: wallProjectsOf(this.config.dashboard?.wall?.projects as any, {
          agentId: task.agentId,
          repo: repoOfChat(chatId),
          workspace: agentDef?.workspace,
        }),
        ...(workflowRunId ? { workflowRunId } : {}),
        scheduled,
        ...(cronSpec ? { cronSpec } : {}),
      }
      const agents = Object.entries(this.config.agents).map(([id, a]) => ({ id, name: a.name }))
      const allRows = parseRegistry(readable.content)
      if (!this.gateRowsChecked) {
        this.gateRowsChecked = true
        for (const g of gatesWithoutRow(allRows.map((r) => r.id))) {
          this.log(`[rules] gate ${g.gate} names rule ${g.ruleId}, which has no Rules Registry row: it never shortens a rule`)
        }
      }
      const rows = rulesForRun(allRows, facts, agents)
      const checked = liveGateRules({
        config: this.config,
        seatMode: (seat) => (seat === STATUS_CLAIM_SEAT && this.statusClaimModeOf ? this.statusClaimModeOf() : getSeatMode(seat)),
        policy: (id) => getPolicy(process.cwd(), id),
      }, task.agentId)
      const block = buildRulesBlock(rows, { maxTokens: cfg.maxTokens, checked })
      if (!block) return { ids: [] }
      const hash = rulesHash(block)
      const session = this.sessions.getSession(task.agentId, channel, chatId)
      if (!fresh && session.rulesHash === hash) return { ids: [] }
      this.sessions.setRulesHash(task.agentId, channel, chatId, hash)
      return { block, ids: rows.map((r) => r.id) }
    } catch (e: any) {
      this.log(`[${task.agentId}] rules registry failed (non-fatal): ${e?.message || e}`)
      return { ids: [] }
    }
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
        // A chat continued from another one's session (#2010) has no
        // message of its own yet: compare with the source chat's last.
        // Only with topicSessions on; off, the seat is as before.
        ?? (this.config.mesh?.delegation?.topicSessions ? this.sessions.continuedFromMessage(task.agentId, channel, chatId, task.message ?? "") : null)
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

  /** The store of cloud sessions this node launched (#622). */
  private cloudSessionStore(): CloudSessionStore {
    if (!this.cloudSessions) this.cloudSessions = new CloudSessionStore(resolve(process.cwd(), ".agentx/cloud-sessions.json"))
    return this.cloudSessions
  }

  /** Where this task runs (#622): a Claude cloud session, a follow-up to one
   *  already open for its issue, or locally. Decided before the dispatch
   *  gates, which only guard a local spawn. Cheap when the setting is off. */
  private planCloudSession(def: AgentDef, task: AgentTask): CloudRoute {
    const settings = { ...CLOUD_SESSIONS_DEFAULTS, ...(def.cloudSessions ?? {}) }
    if (!settings.enabled) return { route: "local", reason: "cloud sessions are off for this agent" }
    const channel = task.context?.channel || "api"
    const channelCfg = (this.config.channels as Record<string, { cloudSessions?: boolean } | undefined>)?.[channel]
    const target = parseCloudTarget(task.context?.chatId)
    const store = this.cloudSessionStore()
    return decideCloudRoute({
      agent: def,
      channelEnabled: channelCfg?.cloudSessions === true,
      context: task.context,
      openSession: target ? store.open(target.repo, target.number, settings.openHours) : undefined,
      launchesToday: store.launchesToday(task.agentId),
    })
  }

  /** Launches the cloud session (or forwards to the open one) and records
   *  it on the trace. Null means: run locally, the reason is logged and on
   *  the trace. */
  private async runCloudSession(def: AgentDef, task: AgentTask, route: CloudRoute, traceId: string): Promise<AgentResponse | null> {
    const settings = { ...CLOUD_SESSIONS_DEFAULTS, ...(def.cloudSessions ?? {}) }
    const started = Date.now()
    const env = claudeBillingEnv(withCallerEnv(buildAgentEnv(def.workspace), task), def.billing)
    const launch = (opts: { cwd: string; prompt: string; sessionId?: string }) => launchCloudSession({ ...opts, env, timeoutMs: settings.launchTimeoutSeconds * 1000 })
    const spec = await this.planSpecTests(task.agentId, route)
    const result = await dispatchCloudSession({
      route,
      agentId: task.agentId,
      message: spec ? `${task.message}\n${specTestAuthorInstructions(spec.number, this.specTestSettings().agent)}` : task.message,
      settings,
      store: this.cloudSessionStore(),
      traceId,
      launch,
      log: (line) => this.log(line),
      trace: (s) => {
        try {
          getEventBus().emit("task:step", {
            taskId: traceId, agentId: task.agentId, name: "cloud_session", action: s.action, status: s.status,
            outputSummary: s.status === "ok" ? s.summary : undefined, error: s.status === "error" ? s.summary : undefined,
            ms: Date.now() - started, at: new Date().toISOString(),
          })
        } catch { /* observability never breaks the run */ }
      },
    })
    if (!result) return null
    // Checked again after the launch's await: a second dispatch for the
    // issue may have started a run meanwhile (it records `running` at once).
    if (spec && route.route === "cloud" && !result.error && !result.cloudSession.followUp && !previousRunBlocks(this.specTestStore().get(spec.repo, spec.number), this.specTestSettings())) {
      const sessionId = result.cloudSession.id
      void this.startSpecTests(task.agentId, spec, route.cwd, (text) => launch({ cwd: route.cwd, prompt: text, sessionId }).then((r) => { if (!r.ok) throw new Error(r.reason) }))
    }
    return { content: result.content, error: result.error, cloudSession: result.cloudSession, duration: Date.now() - started }
  }

  /** The agent and task to run locally: in the issue's own worktree when
   *  `agents.<id>.worktrees` is on (#1292), or for a pull or merge request
   *  in a worktree on its source branch (#2102), else unchanged. A worktree
   *  that cannot be made is logged, and the task runs in the workspace.
   *  `fresh`: the worktree is new (or taken over from another chat), so a
   *  session kept for the chat was started in another folder, and Claude
   *  Code keeps sessions per folder.
   *  An issue or change already in progress in the checkout (`sessionKept`:
   *  the chat had a session before this turn, rotated since or not, or an
   *  open request of this agent has the issue as its home, or that lookup
   *  failed) and with no worktree yet stays in the checkout (#2102 review
   *  B5): a new worktree would start it again from the default branch. */
  private async inTaskWorktree(def: AgentDef, task: AgentTask, opts: { sessionKept?: boolean } = {}): Promise<{ def: AgentDef; task: AgentTask; fresh?: boolean; refused?: string }> {
    const settings = { ...TASK_WORKTREE_DEFAULTS, ...(def.worktrees ?? {}) }
    // A task another node placed here (#2104 B4) runs in a checkout of its
    // repository or not at all: the workspace may be another project.
    const placed = (task.context as Record<string, unknown> | undefined)?.placed === true
    if (!settings.enabled && !placed) return { def, task }
    const target = worktreeTarget(task.context?.channel, task.context?.chatId)
    if (!target) return { def, task }
    const label = target.kind === "change"
      ? `${target.repo}${target.source === "gitlab" ? "!" : " PR #"}${target.id}`
      : `${target.repo ? `${target.repo}#` : ""}${target.id}`
    const candidates = placed
      ? [def.workspace, ...(this.checkoutDirs?.() ?? [])]
      : [task.context?.runbookPath, def.workspace]
    const picked = pickCheckout(target, candidates.filter((d): d is string => !!d))
    if ("reason" in picked) {
      if (placed) {
        this.log(`[worktrees] ${task.agentId} ${label}: placed here, refused: ${picked.reason}`)
        return { def, task, refused: `This node has no checkout for ${label}, so the run placed here was refused: ${picked.reason}` }
      }
      this.log(`[worktrees] ${task.agentId} ${label}: running in the workspace: ${picked.reason}`)
      return { def, task }
    }
    if (!settings.enabled) return { def, task }
    const branch = task.context?.sourceBranch
    if (target.kind === "change" && (task.context?.sourceFork || !branch)) {
      this.log(`[worktrees] ${task.agentId} ${label}: running in the workspace: ${task.context?.sourceFork ? `fork (${branch ?? "unknown branch"} is in another repository)` : "source branch unknown"}`)
      return { def, task }
    }
    const openRequest = () => {
      if (target.kind === "change" || !target.repo || (target.source !== "github" && target.source !== "gitlab") || !/^\d+$/.test(target.id)) return false
      // A lookup that fails counts as in progress: the issue stays where it
      // is rather than starting again from the default branch.
      try { return !!this.openRequestOnIssue?.(target.source, target.repo, Number(target.id), task.agentId) } catch (e: any) {
        this.log(`[worktrees] ${task.agentId} ${label}: open request lookup failed, keeping the issue in the checkout: ${e?.message || e}`)
        return true
      }
    }
    const before = opts.sessionKept ? "session" : openRequest() ? "open request" : null
    if (before && !(await hasTargetWorktree(target, branch, picked.dir, settings, execProcess).catch(() => false))) {
      this.log(`[worktrees] ${task.agentId} ${label}: running in the workspace: in progress before worktrees (${before})`)
      return { def, task }
    }
    const key = `${task.agentId}:${picked.dir}:${label}`
    let pending = this.worktreesPending.get(key)
    if (!pending) {
      const deps = { exec: execProcess, log: (l: string) => this.log(l) }
      pending = target.kind === "change" && branch
        ? prepareChangeWorktree(target, branch, picked.dir, settings, deps)
        : prepareTaskWorktree(target, picked.dir, settings, deps)
      this.worktreesPending.set(key, pending)
      void pending.finally(() => this.worktreesPending.delete(key)).catch(() => {})
    }
    let wt: Awaited<typeof pending>
    try {
      wt = await pending
    } catch (e: any) {
      wt = { error: e?.message || String(e) }
    }
    if ("error" in wt) {
      // Diverged from the pushed branch (#2104 B3): refused, never run on
      // old code nor in the workspace instead.
      if ("refuse" in wt && wt.refuse) {
        this.log(`[worktrees] ${task.agentId} ${label}: refused: ${wt.error}`)
        return { def, task, refused: `The issue's worktree could not be brought up to date, so the run was refused: ${wt.error}` }
      }
      this.log(`[worktrees] ${task.agentId} ${label}: running in the workspace: ${wt.error}`)
      return { def, task }
    }
    this.log(`[worktrees] ${task.agentId} ${label}: ${wt.reused ? "reusing" : "created"} ${wt.dir} on ${wt.branch}`)
    const last = this.worktreesPrunedAt.get(picked.dir) ?? 0
    if (Date.now() - last > 3_600_000) {
      this.worktreesPrunedAt.set(picked.dir, Date.now())
      void pruneTaskWorktrees(picked.dir, settings, { exec: execProcess, log: (l) => this.log(l), keep: wt.dir })
        .then((gone) => { if (gone.length) this.log(`[worktrees] removed ${gone.length} unused worktree(s): ${gone.join(", ")}`) })
        .catch((e: any) => this.log(`[worktrees] prune failed: ${e?.message || e}`))
    }
    const note = worktreeInstructions(wt)
    return {
      fresh: !wt.reused || !!wt.adopted,
      // A persistent process keeps the folder it was started in.
      def: { ...def, persistentProcess: false },
      task: { ...task, cwd: wt.dir, systemPromptAppend: task.systemPromptAppend ? `${task.systemPromptAppend}\n\n${note}` : note },
    }
  }

  private specTestSettings() {
    return { ...SPEC_TESTS_DEFAULTS, ...(this.config.quality?.specTests ?? {}) }
  }

  private specTestStore(): SpecTestStore {
    if (!this.specTests) this.specTests = new SpecTestStore(resolve(process.cwd(), ".agentx/spec-tests.json"))
    return this.specTests
  }

  /** The spec-test input for a new cloud session on an issue (#992), or
   *  null when the test agent does not run (the reason is logged unless the
   *  setting is off). Reads the whole issue with `gh`: the channel's task
   *  text carries only its first 500 characters. */
  private async planSpecTests(codeAgent: string, route: CloudRoute): Promise<SpecTestInput | null> {
    const settings = this.specTestSettings()
    if (!settings.enabled || route.route !== "cloud" || route.kind !== "issue") return null
    const issue = await fetchIssueWithGh(execProcess, route.repo, route.number, route.cwd)
    const plan = planSpecTests({ settings, issue, codeAgent, previous: this.specTestStore().get(route.repo, route.number) })
    if (!plan.run) {
      this.log(`[spec-tests] ${route.repo}#${route.number}: not running: ${plan.reason}`)
      return null
    }
    return plan.input
  }

  /** Runs the test agent in the background, beside the coding session. */
  private async startSpecTests(codeAgent: string, input: SpecTestInput, checkout: string, tellAuthor: (text: string) => Promise<void>): Promise<void> {
    try {
      await runSpecTests({
        settings: this.specTestSettings(),
        input,
        codeAgent,
        checkout,
        exec: execProcess,
        runAgent: claudeSpecAgent,
        store: this.specTestStore(),
        noteOnIssue: (body) => commentOnIssueWithGh(execProcess, input.repo, input.number, checkout, body),
        tellAuthor,
        log: (line) => this.log(line),
      })
    } catch (e: any) {
      this.log(`[spec-tests] ${input.repo}#${input.number}: ${e?.message || e}`)
    }
  }

  /** The answer for a run whose HTTP caller left before it got a slot
   *  (#822). Logged so the dropped request is visible on the node. */
  /** Wait until no run holds or has claimed `chatId` (up to 25 min), then
   *  claim it: the claim, or the response for a turn that will not run. */
  private async waitForChat(agentId: string, channel: string, chatId: string, task?: AgentTask): Promise<string | AgentResponse> {
    const start = Date.now()
    const maxWaitMs = 25 * 60_000
    const claim = `${agentId}\u0000${chatId}`
    while (this.messageQueue.isBusy(agentId, channel, chatId) || this.voiceClaims.has(claim)) {
      if (task?.callerSignal?.aborted) return this.callerGone(task, "chat wait")
      if (Date.now() - start > maxWaitMs) {
        return { content: "", error: `Agent "${agentId}" busy — ${channel} wait timed out after ${Math.round(maxWaitMs / 60000)}m` }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    this.voiceClaims.add(claim)
    return claim
  }

  private callerGone(task: AgentTask, during: string): AgentResponse {
    const reason = abortReason(task.callerSignal!).message
    this.log(`[${task.agentId}] caller gone during ${during} — not starting (${reason})`)
    return { content: "", error: `Caller gone before agent "${task.agentId}" was free — not started` }
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
    const channel = task.context?.channel as string | undefined
    // One run at a time per agent and owner's request (work-lane.ts),
    // keyed on the message as sent, not on notices put before it.
    const key = workKeyOf(task.message, channel)
    // One run at a time per agent and named home (#2084): admitted, then
    // the home's lane, then the request's lane (always in that order).
    const home = this.leaseHomeOfTask(task)
    if (home) return this.executeOnHome(home, key, task, onDelta, onThinking, onEvent)
    return this.executeInLane(key, this.prepareRun(task), onDelta, onThinking, onEvent)
  }

  /** What a run carries once it may start: notices the hourly sweep took,
   *  the job-state rule, and its session (decided now, not when it was
   *  sent). Waiting notices are taken later, once the run has its slot
   *  (executeInternal, #2121). */
  private prepareRun(task: AgentTask): AgentTask {
    const channel = task.context?.channel as string | undefined
    // Notices the hourly sweep already took (#2121).
    if (task.notices) task = { ...task, message: task.notices + task.message, notices: undefined }
    if (needsJobState(this.config.jobState, channel) && !task.jobStateAsk) {
      task = { ...task, message: JOB_STATE_RULE + task.message }
    }
    if (task.freshSessionAt) {
      const { freshSessionAt, ...rest } = task
      task = { ...rest, freshSession: freshSessionAt() }
    }
    return task
  }

  /** The home a run holds the lease on (#2084), or null for none: a named
   *  home (`context.home`) or the issue or merge request of a forge
   *  thread, qualified with its project. Nothing is read from the message
   *  text. Person chats never wait (the same-home note still tells them),
   *  a question to a finished run is part of that run, and an agent that
   *  does not run on this node holds nothing here. */
  /** The lease a run of `agentId` on this named home will hold, or null:
   *  the lease is on, the agent runs here, and the home names its project.
   *  A hand-off with no lease keeps its own wait for the run ahead
   *  (delegation.ts). */
  namedLeaseHome(agentId: string, home: unknown): string | null {
    if (this.config.homeLease?.enabled === false || !this.agents.has(agentId)) return null
    return leaseHomeOf(normalizeHome(home))
  }

  private leaseHomeOfTask(task: AgentTask): string | null {
    if (this.config.homeLease?.enabled === false) return null
    if (task.jobStateAsk || task.leaseHome) return null
    const ctx = (task.context ?? {}) as Record<string, unknown>
    const channel = typeof ctx.channel === "string" ? ctx.channel : undefined
    if (isPersonChannel(channel)) return null
    if (!this.agents.has(task.agentId)) return null
    const named = this.namedLeaseHome(task.agentId, ctx.home)
    if (named) return named
    if ((channel === "gitlab" || channel === "github") && ctx.chatId) return leaseHomeOf(homeOfForgeChat(String(ctx.chatId)))
    return null
  }

  /** Refusal, hold and budget hold, before a run takes a place in a home's
   *  lane (#2084): a refused or held message never waits there, and its
   *  checks do not run again once it is let in. Null: admitted. */
  private admit(task: AgentTask): AgentResponse | null {
    const refusal = this.refusalFor(task.agentId, task.context)
    if (refusal) return { content: refusal, duration: 0 }
    const held = holdMessage(holdsRoot(), task.agentId)
    if (held) {
      this.log(`[${task.agentId}] refused — on hold`)
      return { content: "", error: held, errorKind: "agent_held" }
    }
    if (isRestricted(task.isolated ? "report" : task.autonomy)) return null
    return this.budgetHold(task)
  }

  /** Monthly budget (#1162): a chat message to an agent over budget is
   *  held until it resumes. The answer for a held message, or null. */
  private budgetHold(task: AgentTask): AgentResponse | null {
    const ctxChannel = task.context?.channel
    const ctxChat = task.context?.chatId
    const overBudget = preflightBudgetGate(task.agentId, undefined, budgetProjectOf(task.agentId, ctxChat))
    // Not a run the daemon starts to wake a job (#1861): released later,
    // its reply would be posted to the job's chat. The gate inside the
    // run refuses it, and its job says why.
    if (overBudget && ctxChannel && ctxChat && !wokenJobId(task.context) && getMessageRouter()?.getChannel(ctxChannel)) {
      const held = this.budgetHolds.hold(task.agentId, {
        text: task.message,
        channel: ctxChannel,
        chatId: String(ctxChat),
        context: task.context as Record<string, unknown>,
        heldAt: task.queuedAt ?? Date.now(),
      })
      if (held !== "full") {
        this.armBudgetRelease()
        const waiting = this.budgetHolds.count(task.agentId)
        this.log(`[${task.agentId}] over budget — message held (${waiting} waiting) chat=${ctxChannel}:${ctxChat}`)
        if (held === "held") return { content: "", error: queuedMarker("budget", waiting) }
        return {
          content: "",
          error: `${overBudget.message} This message is kept and runs when the agent resumes.`,
          errorKind: "budget_cap",
        }
      }
      this.log(`[${task.agentId}] over budget — hold is full, message refused`)
    }
    return null
  }

  /**
   * A run on a named home (#2084): one at a time per agent and home. An
   * awaited caller waits for the run ahead within its slot-wait budget,
   * shared with the slot and rate-limit waits after the lane, and is
   * refused past it (`home_busy`, never run). A forge comment and a job
   * wake have no caller waiting on them: they wait their turn. The lease
   * is kept until the run's due-time ask ends, and a backstop stops a run
   * still going 5 min past its time limit, then frees the lease.
   */
  private async executeOnHome(home: string, key: string | null, task: AgentTask, onDelta?: StreamCallback, onThinking?: ThinkingCallback, onEvent?: (event: any) => void): Promise<AgentResponse> {
    const start = Date.now()
    const ctx = (task.context ?? {}) as Record<string, unknown>
    const channel = typeof ctx.channel === "string" ? ctx.channel : "api"
    const chatId = String(ctx.chatId ?? "default")
    const notAdmitted = this.admit(task)
    if (notAdmitted) return notAdmitted
    const awaited = channel !== "gitlab" && channel !== "github" && !wokenJobId(task.context)
    const deadline = awaited ? start + (task.slotWaitMs ?? DEFAULT_SLOT_WAIT_MS) : undefined
    const entry = await this.workLanes.enterHome(task.agentId, home, {
      deadline,
      signal: task.callerSignal,
      source: `${channel}:${chatId}`,
      onWait: (h) => getEventBus().emit("task:joined", {
        agentId: task.agentId, home, holderId: h.holderId, ...(h.taskId ? { taskId: h.taskId } : {}),
        channel, chatId, at: new Date().toISOString(),
      }),
    })
    if (isHomeRefusal(entry)) {
      if (entry.refused === "caller_gone") return this.callerGone(task, `the wait for ${home}`)
      return homeBusy(task.agentId, home, entry.taskId ?? entry.holderId, entry.waitedMs)
    }
    // Let the run ahead finish its own wrap-up (a hand-off frees its
    // session there) before this one reads which session to continue.
    if (entry.waitedMs > 0) await new Promise((r) => setImmediate(r))
    const def = this.agents.get(task.agentId)?.def
    const limitMin = (typeof task.timeoutMinutes === "number" && task.timeoutMinutes > 0 ? task.timeoutMinutes : def?.maxExecutionMinutes ?? 20) + 5
    let backstop: ReturnType<typeof setTimeout> | undefined
    let followUp: Promise<unknown> | undefined
    // Armed on every spawn (the job-state and due-time asks too), and
    // stops the spawn that is live before the lease is freed.
    const onStart = (runId: string) => {
      entry.setTaskId(runId)
      if (backstop) clearTimeout(backstop)
      backstop = setTimeout(() => this.leaseBackstop(task.agentId, home, runId, limitMin, entry), limitMin * 60_000)
      ;(backstop as any).unref?.()
      task.onStart?.(runId)
    }
    let response: AgentResponse = { content: "", error: "run did not end" }
    let run = task
    try {
      run = this.prepareRun({
        ...task, admitted: true, leaseHome: home, onStart,
        ...(deadline !== undefined ? { leaseDeadline: deadline } : {}),
        onFollowUp: (p) => { followUp = p },
      })
      if (entry.note) run = { ...run, message: entry.note + run.message }
      response = await this.executeInLane(key, run, onDelta, onThinking, onEvent)
      // The lane wait used the budget up and the slot wait ran out after it.
      if (entry.waitedMs > 0 && response.errorKind === "agent_busy" && /slot wait timed out/.test(response.error ?? "")) {
        emitSignal({ kind: "home_busy", agentId: task.agentId, ref: home, detail: `${channel} refused: no slot within the wait budget left after the lane` })
        response = homeBusy(task.agentId, home, "a busy slot", Date.now() - start)
      }
    } finally {
      const queued = !!response.error && isQueued(response.error)
      const release = () => {
        if (backstop) clearTimeout(backstop)
        entry.release({ text: response.error ? response.error : response.content ?? "", ok: !response.error, ran: !queued })
      }
      if (followUp) void followUp.then(release, release)
      else release()
    }
    return response
  }

  /** A run still going 5 min past its time limit on a home (#2084): stop
   *  it first, then free the lease once it had time to exit. */
  private leaseBackstop(agentId: string, home: string, runId: string, limitMin: number, entry: HomeEntry): void {
    this.log(`[${agentId}] ${home}: run ${runId} still holds the home ${limitMin} min after it started; lease backstop stops it`)
    emitSignal({ kind: "duplicate_session", agentId, ref: home, detail: `the lease backstop stopped run ${runId} on ${home} after ${limitMin} min` })
    try { this.cancelRunningTask(runId, "lease backstop") } catch { /* freed below either way */ }
    const t = setTimeout(() => entry.release({ text: "", ok: false }), CANCEL_GRACE_MS)
    ;(t as any).unref?.()
  }

  private async executeInLane(key: string | null, task: AgentTask, onDelta?: StreamCallback, onThinking?: ThinkingCallback, onEvent?: (event: any) => void): Promise<AgentResponse> {
    if (!key) {
      const startedAt = Date.now()
      const response = await this.runWithRecovery(task, onDelta, onThinking, onEvent)
      this.queueRunSignals(task, response, startedAt)
      return response
    }
    const entry = await this.workLanes.enter(task.agentId, key, currentRoot()?.rootId, task.callerSignal)
    let response: AgentResponse = { content: "", error: "run did not end" }
    let run = task
    const startedAt = Date.now()
    try {
      run = entry.note ? { ...task, message: entry.note + task.message } : task
      response = await this.runWithRecovery(run, onDelta, onThinking, onEvent)
    } finally {
      const queued = !!response.error && isQueued(response.error)
      entry.release({ text: response.error ? response.error : response.content ?? "", ok: !response.error, ran: !queued })
    }
    // Outside the finally: nothing here can change the lane's release.
    this.queueRunSignals(run, response, startedAt)
    return response
  }

  /** Awareness (#1997) and Bayan (#1998) checks of a finished run, on a
   *  later tick, after the reply. An errored run, a run answered by a
   *  peer, and the job-state question are not judged. Never throws. */
  private queueRunSignals(task: AgentTask, response: AgentResponse, startedAt: number): void {
    try {
      if (response.error || response.viaMesh || task.jobStateAsk) return
      const taskId = task.taskId ?? task.runningTaskId
      if (!taskId) return
      const ctx = (task.context ?? {}) as Record<string, unknown>
      const str = (v: unknown) => (typeof v === "string" ? v : undefined)
      const run: RunEnd = {
        taskId, agentId: task.agentId, channel: str(ctx.channel), chatId: str(ctx.chatId), sender: str(ctx.sender),
        content: response.content, jobState: response.jobState, startedAt,
      }
      const isAgent = (id: string) => !!this.getAgent(id)
      queueAwarenessSignals(run, isAgent)
      queueBayanSignals(run, isAgent)
    } catch { /* a signal never changes the reply */ }
  }

  private async runWithRecovery(task: AgentTask, onDelta?: StreamCallback, onThinking?: ThinkingCallback, onEvent?: (event: any) => void): Promise<AgentResponse> {
    const startedAt = Date.now()
    let response: AgentResponse
    try {
      response = await this.executeInternal(task, onDelta, onThinking, onEvent)
    } catch (e: any) {
      response = { content: "", error: e?.message ?? String(e) }
    }
    // The run normally frees its node place when it ends; this covers a
    // path that left before its release ran.
    this.admissionTickets.get(task)?.release()
    // Cut off by a daemon shutdown, at whatever step: report the restart,
    // not how the step read the kill.
    const interruptedBy = task.runningTaskId ? this.interruptedRuns.get(task.runningTaskId) : undefined
    if (interruptedBy) {
      this.interruptedRuns.delete(task.runningTaskId!)
      response = { ...response, content: "", error: interruptedBy, errorKind: "interrupted" }
    }
    // Ended by a stop signal (#857): report the stop, not how the step read the kill.
    const stoppedBy = !interruptedBy && task.runningTaskId ? this.stoppedRuns.get(task.runningTaskId) : undefined
    if (stoppedBy) {
      this.stoppedRuns.delete(task.runningTaskId!)
      response = { ...response, content: "", error: stoppedBy, errorKind: "stopped" }
    }
    // A run that threw or was cancelled before its own cleanup ran.
    if (task.runningTaskId) this.runReleases.get(task.runningTaskId)?.(response)
    // The preparation steps hit the pre-spawn deadline: the message was
    // never handed to a model. With the slot released, run it once more
    // from the start; a second stall is reported in plain words, not with
    // the internal error (#340).
    const preSpawn = !interruptedBy && !stoppedBy && response.error && /^timed out before spawn after/.test(response.error)
    // The retry keeps onStart: it gets the new run's id, so a caller that
    // stored the first one (a Hub chat row, a delegation) now points at the
    // run that is live, not the dead one.
    if (preSpawn && !task.preSpawnRetry) {
      this.log(`[${task.agentId}] ${response.error}; retrying the run once`)
      return this.runWithRecovery({ ...task, preSpawnRetry: 1, runningTaskId: undefined }, onDelta, onThinking, onEvent)
    }
    if (preSpawn) {
      const step = response.error!.match(/in step "([^"]+)"/)?.[1] ?? "start"
      response = {
        ...response,
        error: `I couldn't get started on this: preparing the run stalled twice (step "${step}"). Please send it again.`,
        errorKind: "interrupted",
      }
    }
    // Stopped at the agent's time limit (#1257): its job continues it, in
    // a run the job's wake starts (#1861); otherwise say why it stopped
    // there. The caller gets the stop now, not a continued answer.
    const limit = planTimeLimit({
      error: response.error,
      errorKind: response.errorKind,
      viaMesh: response.viaMesh,
      channel: task.context?.channel,
      chatId: task.context?.chatId,
      workflowRunId: task.workflowRunId,
      settings: this.config.resume?.timeLimit ?? DEFAULT_TIME_LIMIT_SETTINGS,
    })
    if (limit.action === "handoff") {
      const stoppedTrace = task.taskId
      let toolCalls: Array<{ action: string | null; inputSummary: string | null }> = []
      try { toolCalls = stoppedTrace && this.traceToolCalls ? this.traceToolCalls(stoppedTrace) : [] } catch { /* the note lists none */ }
      let jobId: string | null = null
      try { jobId = this.timeLimitHandoff?.([task.taskId, task.runningTaskId], buildTimeLimitNote(limit.minutes, toolCalls)) ?? null } catch (e: any) {
        this.log(`[resume] time-limit hand-off failed: ${e?.message ?? e}`)
      }
      const where = `${task.agentId} ${task.context?.channel ?? "-"} ${stoppedTrace ?? "-"}`
      if (jobId) {
        this.log(`[resume] ${where}: stopped at its ${limit.minutes}m time limit; its job ${jobId} continues it`)
        response = { ...response, error: handedOffTimeLimitError(response.error!, jobId) }
      } else {
        const reason = "no job's wake took it: no job, the wake is off, or the job is at its cap"
        this.log(`[resume] ${where}: stopped at its ${limit.minutes}m time limit; not continued — ${reason}`)
        response = { ...response, error: reportedTimeLimitError(response.error!, reason) }
      }
    }
    if (limit.action === "report") {
      this.log(`[resume] ${task.agentId} ${task.context?.channel ?? "-"} ${task.taskId ?? "-"}: stopped at its ${limit.minutes}m time limit; not continued — ${limit.reason}`)
      response = { ...response, error: reportedTimeLimitError(response.error!, limit.reason) }
    }
    if (!task.jobStateAsk) response = await this.checkJobState(task, response)
    if (!task.jobStateAsk) response = await this.checkStatusClaim(task, response)
    if (!task.jobStateAsk) this.checkDueTime(task, response, startedAt)
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
   * A run of agent work that ended cleanly states its job's state (#1861
   * phase 2). One that stated nothing is asked once, in the same session;
   * the caller still gets the run's own answer. Still nothing: the answer
   * carries a line saying the job is stalled, so whoever asked is told.
   */
  private async checkJobState(task: AgentTask, response: AgentResponse): Promise<AgentResponse> {
    const channel = task.context?.channel as string | undefined
    const runId = task.runningTaskId
    if (!needsJobState(this.config.jobState, channel) || response.error || response.viaMesh || response.midTurnDelivered) {
      if (runId) this.jobStates.delete(runId)
      return response
    }
    const where = `${task.agentId} ${channel ?? "-"} ${task.taskId ?? "-"}`
    // A state the answer does not already show goes on its last line, so
    // whoever asked reads it with the answer (not a schedule's answer).
    const onAnswer = stateOnAnswer(channel)
    const withState = (state: JobState): AgentResponse => {
      // An answer that goes to a person loses the run's own State line too.
      if (!onAnswer) {
        const content = jobStateInText(response.content) ? withoutStateLines(response.content ?? "") : response.content
        return { ...response, content, jobState: state }
      }
      if (jobStateInText(response.content)) return { ...response, jobState: state }
      const line = `[Job state] ${describeJobState(state)}`
      return { ...response, content: response.content ? `${response.content}\n\n${line}` : line, jobState: state }
    }
    const runIds = [task.taskId, runId]
    // A schedule's quiet word (#1289) is sent nowhere only when it is the
    // whole answer, so it gets no ask and no added line: it means done.
    const bare = withoutStateLines(response.content ?? "")
    if (isQuietAnswer(withoutExitMarker(bare))) {
      const state = this.takeJobState(task, response) ?? { state: "done", proof: "nothing to report" }
      this.log(`[job-state] ${where}: ${describeJobState(state)} (quiet answer)`)
      this.tellJobState(runIds, { kind: "stated", state })
      return { ...response, content: bare, jobState: state }
    }
    const stated = this.takeJobState(task, response)
    if (stated) {
      this.log(`[job-state] ${where}: ${describeJobState(stated)}`)
      this.tellJobState(runIds, { kind: "stated", state: stated })
      return withState(stated)
    }
    this.log(`[job-state] ${where}: ended with no state; asking once`)
    this.tellJobState(runIds, { kind: "asked" })
    // The question is a turn of its own, not the work again: it does not
    // settle the run's intent (the run does, below in runWithRecovery).
    const { intentRef: _intent, ...rest } = task
    const ask: AgentTask = { ...rest, message: JOB_STATE_ASK, jobStateAsk: true, runningTaskId: undefined, freshSession: false, resumedFrom: task.taskId ?? task.resumedFrom, leaseDeadline: undefined }
    let asked: AgentResponse
    try {
      // Not streamed: the caller reads the run's answer, not this question's.
      asked = await this.runWithRecovery(ask)
    } catch (e: any) {
      asked = { content: "", error: e?.message ?? String(e) }
    }
    const answer = asked.error ? null : this.takeJobState(ask, asked)
    if (ask.runningTaskId) this.jobStates.delete(ask.runningTaskId)
    if (answer) {
      this.log(`[job-state] ${where}: ${describeJobState(answer)} (when asked)`)
      this.tellJobState([...runIds, ask.taskId, ask.runningTaskId], { kind: "stated", state: answer })
      return withState(answer)
    }
    this.log(`[job-state] ${where}: no state when asked${asked.error ? ` (${asked.error.slice(0, 120)})` : ""}; stalled`)
    this.tellJobState([...runIds, ask.taskId, ask.runningTaskId], { kind: "stalled", reason: "run ended with no state, and gave none when asked" })
    emitSignal({ kind: "job_stalled", agentId: task.agentId, ref: task.taskId ?? runId ?? "-", detail: `${channel ?? "-"}: run ended with no job state, none when asked` })
    if (!onAnswer) return { ...response, jobState: { state: "stalled" } }
    const line = stalledLine(task.agentId)
    return { ...response, content: response.content ? `${response.content}\n\n${line}` : line, jobState: { state: "stalled" } }
  }

  /**
   * G3 (#2085): a reply to the owner that says merged, live, deployed,
   * released or closed about a PR, MR, issue, version or commit must rest
   * on a read of it in this run. Runs before `execute()` returns, so the
   * caller that posts the answer posts the checked one. Shadow: a row
   * only. Active: one question in the same session; its answer replaces
   * the run's, or, with no answer, the claim is marked "not checked".
   */
  private async checkStatusClaim(task: AgentTask, response: AgentResponse): Promise<AgentResponse> {
    const reply = response.content?.trim()
    if (!reply || response.error || response.viaMesh) return response
    if (!this.isOwnerTurn(task.context)) return response
    const mode = (this.statusClaimModeOf ?? statusClaimMode)()
    if (mode === "off") return response
    const runIds = [task.taskId, task.runningTaskId].filter((id): id is string => !!id)
    let calls: Array<{ action: string | null; inputSummary: string | null }> = []
    try { calls = runIds.flatMap((id) => this.traceToolCalls?.(id) ?? []) } catch { /* no calls read: every ref is unread */ }
    const where = `${task.agentId} ${task.context?.channel ?? "-"} ${task.taskId ?? "-"}`
    const base = { gate: STATUS_CLAIM_GATE, ruleId: STATUS_CLAIM_RULE, agent: task.agentId, ref: task.taskId ?? undefined }
    // Claims already sent mid-run are gone: logged, not corrected here.
    for (const ref of midRunClaims(calls)) recordGateEvent({ ...base, outcome: "not-fixed", reason: `sent mid-run about ${ref.label} without a read` })
    const verdict = judgeClaim(reply, calls)
    if (verdict.kind === "none" || verdict.kind === "read") return response
    if (verdict.kind === "untied") {
      recordGateEvent({ ...base, outcome: "untied", reason: "claim word with no ref" })
      return response
    }
    const labels = verdict.refs.map((r) => r.label).join(", ")
    if (mode !== "active") {
      recordGateEvent({ ...base, outcome: "would-ask", reason: `not read: ${labels}` })
      this.log(`[status-claim] ${where}: claim about ${labels} not read this run (shadow)`)
      return response
    }
    recordGateEvent({ ...base, outcome: "asked", reason: `not read: ${labels}` })
    this.log(`[status-claim] ${where}: claim about ${labels} not read this run; asking once`)
    const { intentRef: _intent, ...rest } = task
    const ask: AgentTask = { ...rest, message: claimAsk(verdict.refs), jobStateAsk: true, runningTaskId: undefined, freshSession: false, resumedFrom: task.taskId ?? task.resumedFrom }
    let asked: AgentResponse
    try {
      asked = await this.runWithRecovery(ask)
    } catch (e: any) {
      asked = { content: "", error: e?.message ?? String(e) }
    }
    const answer = asked.error ? "" : withoutStateLines(asked.content ?? "").trim()
    if (answer) {
      recordGateEvent({ ...base, outcome: "corrected", reason: labels })
      this.log(`[status-claim] ${where}: answer replaced after the check`)
      return { ...response, content: answer }
    }
    recordGateEvent({ ...base, outcome: "not-fixed", reason: `no answer to the check${asked.error ? `: ${asked.error.slice(0, 120)}` : ""}` })
    return { ...response, content: `${response.content}\n\n${notCheckedLine(verdict.refs)}` }
  }

  /**
   * A run that ended cleanly with a reply goes to the due-time gate
   * (#1908): a due time the agent wrote and did not record gets one
   * question, in the same session. Beside the answer, never before it:
   * the caller already has the run's answer and does not wait for this.
   */
  private checkDueTime(task: AgentTask, response: AgentResponse, startedAt: number): void {
    const gate = this.dueTimeGate
    const reply = response.content?.trim()
    if (!gate || !reply || response.error || response.viaMesh || response.midTurnDelivered) return
    const runIds = [task.taskId, task.runningTaskId].filter((id): id is string => !!id)
    const askAgent = async (text: string) => {
      // A question to the run, like the job-state ask: not the work again,
      // and it does not settle the run's intent.
      const { intentRef: _intent, ...rest } = task
      const ask: AgentTask = { ...rest, message: text, jobStateAsk: true, runningTaskId: undefined, freshSession: false, resumedFrom: task.taskId ?? task.resumedFrom, leaseDeadline: undefined }
      const asked = await this.runWithRecovery(ask)
      return { reply: asked.content, error: asked.error }
    }
    const followUp = Promise.resolve()
      .then(() => gate({
        agentId: task.agentId,
        channel: String(task.context?.channel ?? ""),
        chatId: String(task.context?.chatId ?? ""),
        runIds, startedAt, reply,
      }, askAgent))
      .catch((e: any) => this.log(`[due-time] ${task.agentId} ${task.taskId ?? "-"}: check failed: ${e?.message ?? e}`))
    // A run on a home keeps its lease until this ends (#2084).
    task.onFollowUp?.(followUp)
  }

  /**
   * Internal dispatcher — the real body. See `execute` for the public
   * wrapper that adds intent-ledger resolution recording.
   */
  private async executeInternal(task: AgentTask, onDelta?: StreamCallback, onThinking?: ThinkingCallback, callerOnEvent?: (event: any) => void): Promise<AgentResponse> {
    // People permissions (#379), before every way to the agent: an attached
    // session, a mesh peer, the local queue.
    // Admitted before its home's lane (#2084): not refused twice.
    const refusal = task.admitted ? null : this.refusalFor(task.agentId, task.context)
    if (refusal) return { content: refusal, duration: 0 }

    // An isolated run (#990) is read-only whoever asked: autonomy `report`
    // keeps it off attached sessions and mesh peers and makes a tier that
    // cannot enforce it refuse, rather than run it with its usual tools.
    if (task.isolated) task.autonomy = "report"

    // An issue placed on another node (#2104) runs there, whatever started
    // the task: a channel message, a Hub turn, a cron, a workflow step.
    const placedRun = await this.runOnPlacedNode(task)
    if (placedRun) return placedRun

    // Attach mode: a live Claude Code session may have claimed this identity.
    // If so it gets first refusal — but only for a bounded window. When the
    // human doesn't pick the message up we fall through to the normal spawn
    // path below, and the offer is atomically expired so a late drain can't
    // answer it a second time. Attach is a preference, never a black hole.
    // A restricted-autonomy routine never goes to an attached session: that
    // terminal runs with its own (full) permissions, outside the per-task
    // guard hook, so enforcement would be silently skipped.
    const restricted = isRestricted(task.autonomy)
    // People permissions, per tool and per skill (#379): the run carries its
    // person's deny lists to the runtime, which enforces them with a per-run
    // guard hook. Recomputed on every run (a queued or resumed task too), so
    // a stale list on the task is never trusted. Same rule as autonomy: an
    // attached session runs outside the hook, so it is never offered one.
    const limits = personLimitsOf(this.config.people, task.context as any)
    if (limits) task.personLimits = limits
    else delete task.personLimits
    const offered = restricted || limits ? null : getAttachRegistry().offer({
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
      // The autonomy hook is spawned by THIS daemon, and the person's limits
      // by this node's people list: a peer would run the task at full
      // power. Refuse instead (mesh-safety.ts, shared with the router).
      const blocked = meshForwardBlock(task.agentId, task.autonomy, limits)
      if (blocked) {
        return blocked.kind === "autonomy" ? { content: "", error: blocked.error, autonomy: task.autonomy } : { content: "", error: blocked.error }
      }
      // A task placed here (#2104 C-b) runs in this node's checkout or is
      // refused, and the refusal goes back to the node that placed it:
      // never passed on to another peer the owner did not choose.
      if ((task.context as Record<string, unknown> | undefined)?.placed === true) {
        this.log(`[run-on] ${task.agentId} was placed here but does not run on this node: refused`)
        return { content: "", error: `This issue was placed on a node that does not host ${task.agentId}, so the run was refused there. Move it to another machine from the Hub.` }
      }
      // Mesh fallback: the agent isn't local but a healthy peer may host
      // it. Look it up in the mesh directory and forward via A2A sendTask.
      // Streaming callbacks are dropped — sendTask doesn't stream today.
      if (this.meshFallback) {
        // C-d: a node keeping work left behind on the task's issue is not
        // sent its runs; another host is, else the run fails with the note.
        const held = this.leftBehindOf(task)
        const hosts = this.meshFallback.directory().filter(
          (p) => p.healthy && p.skills.some((s) => s.id === task.agentId),
        )
        const peerEntry = hosts.find((p) => !held.includes(p.peer))
        if (!peerEntry && hosts.length) {
          this.log(`[run-on] ${task.agentId}: every host keeps left-behind work on the issue (${hosts.map((p) => p.peer).join(", ")}): not sent`)
          return { content: "", error: leftBehindNoteText(hosts[0].peer) }
        }
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
            // With the task's context (channel, chat, home…), so the peer
            // keys the session and finds the issue as a local run would
            // (#2104); paths that only mean something here are left out.
            const content = await this.meshFallback.sendTask(peerEntry.peer, task.message, task.agentId, { timeoutMs, context: meshContextOf(task.context as Record<string, unknown> | undefined) })
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
    const { channel: qChannel, chatId: qChatId } = warmProcessChat(task.context)
    // Held from a voice wait ending until the chat is marked running.
    let voiceClaim: string | undefined
    // A spoken question /ask runs in a phone conversation (#1455): waited
    // for like a voice turn, on its own chat, not behind the agent's slots.
    const spokenInApp = qChannel === "app" && task.context?.via === "voice"

    // An agent the owner paused, or one another agent created that waits
    // for the owner's yes (#1169), takes nothing: refused before it is
    // queued, planned or given a slot, for every caller.
    const held = holdMessage(holdsRoot(), task.agentId)
    if (held) {
      this.log(`[${task.agentId}] refused — on hold`)
      return { content: "", error: held, errorKind: "agent_held" }
    }

    // Monthly budget (#1162): a chat message to a paused agent waits for
    // the agent to resume instead of failing. The chat is told why once
    // per pause; the reply comes when the held message runs. Callers that
    // await the answer (API, crons, other agents) get the refusal from the
    // gate inside the run instead.
    // Admitted before its home's lane (#2084): the hold is not written twice.
    if (!restricted && !task.admitted) {
      const budgetHeld = this.budgetHold(task)
      if (budgetHeld) return budgetHeld
    }

    // A run of this agent is already going in this chat: offer the message
    // to it as well, read after its next tool call (mid-turn.ts). It still
    // takes its usual way below; if the run takes it, it is not run again.
    this.offerMidTurn(task, state, qChannel, qChatId)

    // One turn at a time in a phone conversation: the dashboard keeps one
    // per conversation for the phone, but a spoken question /ask runs in
    // the same conversation (#1455) and the dashboard does not see it.
    if (qChannel === "app") {
      const waited = await this.waitForChat(task.agentId, qChannel, qChatId, task)
      if (typeof waited !== "string") return waited
      voiceClaim = waited
    }
    const dropVoiceClaim = () => { if (voiceClaim) this.voiceClaims.delete(voiceClaim) }

    if (this.slotFull(state)) {
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
      // A guest mesh's turn ("guest") is answered over its open request
      // too, and has no adapter to flush a queued reply to. A sprint lane's
      // turn ("sprint", #1241) is awaited by the daemon, whose end hands
      // the lane its next item: queued, it would end at once, unrun.
      // A run the daemon starts to wake a job (#1861) waits too: queued,
      // its reply would be posted to the job's chat when the queue flushes.
      // A sensor's wake ("sensor", #863) is awaited by the sensor loop, which
      // counts it sent only once it starts: queued, it would never start.
      // A schedule's goal-check wake (#863, await-slot.ts) is awaited by the
      // goal check, which raises the card when the turn ends: queued, the
      // card would go up at once with no recommendation.
      if (qChannel === "api" || qChannel === "sensor" || (qChannel === "app" && !spokenInApp) || qChannel === "a2a" || qChannel === "mcp" || qChannel === "reminder" || qChannel === "events" || qChannel === "guest" || qChannel === "sprint" || restricted || !!wokenJobId(task.context) || awaitsSlot(task.context) || task.leaseDeadline !== undefined) {
        const start = Date.now()
        // A run on a home (#2084) has what its lane wait left of the budget.
        const maxWaitMs = task.leaseDeadline !== undefined ? Math.max(0, task.leaseDeadline - start) : task.slotWaitMs ?? DEFAULT_SLOT_WAIT_MS
        const pollIntervalMs = 500
        // A wake with a deadline can wait well under a minute (#1596).
        const waitLabel = maxWaitMs < 60_000 ? `${Math.max(1, Math.ceil(maxWaitMs / 1000))}s` : `${Math.round(maxWaitMs / 60000)}m`
        if (this.slotFull(state)) {
          this.log(`[${task.agentId}] busy, waiting for a slot (up to ${waitLabel}) behind=${state.runningTasks.map((r) => r.id).join(",") || "-"} chat=${qChannel}:${qChatId}`)
        }
        while (this.slotFull(state)) {
          if (task.callerSignal?.aborted) { dropVoiceClaim(); return this.callerGone(task, "slot wait") }
          if (Date.now() - start > maxWaitMs) {
            dropVoiceClaim()
            this.log(`[${task.agentId}] slot wait timed out after ${waitLabel} chat=${qChannel}:${qChatId} — message not run`)
            return { content: "", error: `Agent "${task.agentId}" busy — slot wait timed out after ${waitLabel}`, errorKind: "agent_busy" }
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs))
        }
        // Slot freed — fall through to normal execution path below.
        if (Date.now() - start >= 60_000) {
          this.log(`[${task.agentId}] slot free after ${Math.round((Date.now() - start) / 60000)}m wait chat=${qChannel}:${qChatId}`)
        }
      } else if (qChannel === "voice" || spokenInApp) {
        // /ask waits on the answer to speak it, and "voice" has no adapter
        // to re-route a queued reply to: queued, it was answered into
        // nothing. Wait for the same voice chat instead, as the queue
        // would — other work on the agent still runs alongside.
        // A spoken question in a phone conversation holds its chat already.
        if (!voiceClaim) {
          const waited = await this.waitForChat(task.agentId, qChannel, qChatId)
          if (typeof waited !== "string") return waited
          voiceClaim = waited
        }
      } else {
        // Channel callers (telegram/gitlab/whatsapp/...) already ack'd the
        // user's message, so queueing is the right behavior — the flush
        // callback will reply via the original channel when the slot frees.
        const mode = (state.def.queueMode as QueueMode) || "collect"
        const queued = this.messageQueue.enqueue(task.agentId, qChannel, qChatId, {
          ...(task.midTurnId ? { midTurnId: task.midTurnId } : {}),
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
          // Who is waiting, so the member page can count the messages ahead
          // of a teammate's (#443). The person is resolved here, not read
          // from the context: a queued message never reached the stamping
          // a run does below.
          getEventBus().emit("task:queued", {
            agentId: task.agentId, channel: qChannel, chatId: qChatId, at: new Date().toISOString(),
            sender: senderOf(task.context), humanRoot: isHumanFacingTurn(task.context as any),
            person: personOfTurn(this.config.people, task.context as any)?.id ?? null,
            messagePreview: task.message.slice(0, 200), queuedAt: Date.now(),
          })
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
      maxWaitMs: task.leaseDeadline !== undefined ? Math.max(0, Math.min(5 * 60_000, task.leaseDeadline - Date.now())) : 5 * 60_000,
      onWait: (reason, waitMs) => {
        this.log(`[${task.agentId}] ${reason} — queued, resumes in ~${Math.max(1, Math.round(waitMs / 1000))}s`)
      },
    })
    // The voice claim is kept through the node wait below and dropped only
    // once the run holds its agent slot (or does not start), so a second
    // question on the same voice chat cannot slip past while this one waits.
    if (!rateResult.ok) {
      dropVoiceClaim()
      this.log(`[${task.agentId}] ${rateResult.reason}`)
      return { content: "", error: rateResult.reason }
    }
    // The rate-limit wait above can be minutes long too. The token it
    // took is spent even though this run never starts; that is accepted,
    // since the next caller only waits one token interval longer.
    if (task.callerSignal?.aborted) { dropVoiceClaim(); return this.callerGone(task, "rate-limit wait") }

    // The run this message waited behind took it mid-turn: its answer
    // covers it, so it does not start a turn of its own.
    if (this.midTurn.isTaken(task.midTurnId)) {
      dropVoiceClaim()
      this.log(`[${task.agentId}] message ${task.midTurnId} was read by the running turn; not run again chat=${qChannel}:${qChatId}`)
      const spoken = qChannel === "voice" || spokenInApp
      return { content: spoken ? DELIVERED_SPOKEN : DELIVERED_TEXT, midTurnDelivered: true }
    }

    // Node admission (#1521): wait for room on the node. The agent's slot is
    // NOT held while waiting: the queue checks it (canStart) and takes it
    // (onStart) in the same step as admission, so nothing can slip in
    // between, and a later, higher-priority message to the same agent still
    // reaches the queue instead of waiting behind this one. Tiers that start
    // no local process are not gated. From admission to markRunning below
    // nothing awaits.
    const admissionSettings = this.admissionSettings()
    if (admissionSettings.tiers.includes(state.def.tier)) {
      const person = personOfTurn(this.config.people, task.context as any)
      const voiceKey = qChannel === "voice" ? `${task.agentId}\u0000${qChatId}` : null
      const outcome = await this.admission.admit({
        agentId: task.agentId,
        channel: qChannel,
        chatId: qChatId,
        person: person?.id ?? null,
        owner: person?.role === "owner",
        // A message its sender marked time-critical (an alert, #1807): not
        // held by swap or load. Never lowers an owner turn.
        ...(requestedPriorityOf((task.context as any)?.admissionPriority) ? { atLeast: "critical" as const } : {}),
        // A hop whose caller waits on it; a callback turn has no waiting parent.
        delegated: isInsideDelegation(task.context as any) && !(task.context as any)?.delegation,
        // A chat message still waiting at shutdown is replayed by the router.
        keepOnClose: task.origin?.kind === "router",
        // One written line to the person once the run has waited a while
        // (admission.waitNotice); the router decides which channels ask.
        ...(task.onHeld && (admissionSettings.waitNotice?.afterSeconds ?? 0) > 0
          ? { longWait: { afterMs: admissionSettings.waitNotice!.afterSeconds * 1000, notify: task.onHeld } }
          : {}),
        // One question at a time per voice chat: the claim is taken at
        // admission, before any other entry of the same pass is checked,
        // and held until this run marks the chat running.
        canStart: () => !this.slotFull(state)
          && !(voiceKey && voiceKey !== voiceClaim && (this.voiceClaims.has(voiceKey) || this.messageQueue.isBusy(task.agentId, qChannel, qChatId))),
        onStart: () => {
          state.activeTasks++
          if (voiceKey && !voiceClaim) { voiceClaim = voiceKey; this.voiceClaims.add(voiceKey) }
        },
        signal: task.callerSignal,
      })
      dropVoiceClaim()
      if (!outcome.ok) {
        if (outcome.reason === "caller-gone") return this.callerGone(task, "node queue")
        if (outcome.reason === "closed") {
          return { content: "", error: `Agent "${task.agentId}" not started: the daemon is restarting`, errorKind: "interrupted" }
        }
        // Plain words only: this text can reach a thread everyone reads.
        // The queue has already logged the full reason with its numbers.
        return { content: "", error: waitRefusalText(outcome.blockedBy), errorKind: "no_room" }
      }
      this.admissionTickets.set(task, outcome.ticket)
    } else {
      dropVoiceClaim()
      state.activeTasks++
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

    // Another run of this agent on the same issue, in another chat (#1100):
    // this one is told, so the two do not overwrite each other's work.
    const homes = homesOfRun({ message: task.message, home: task.context?.home })
    const clash = sameHomeNote(state.runningTasks, homes, { channel: task.context?.channel || "api", chatId: task.context?.chatId || task.context?.group })
    if (clash) {
      this.log(`[${task.agentId}] ${clash.slice(0, 160)}`)
      task.message = `${clash}\n${task.message}`
    }

    // Notices waiting for this agent ride on its next run of agent work
    // (a2a, cron, workflow, ...), never on a person's or visitor's chat
    // nor on an internal run whose output is parsed (notices.ts). Taken
    // here, once the run has its slot, and not when it starts to wait:
    // a crash during a long work-lane or slot wait no longer loses them
    // (#2121). The retry of a stalled start already carries them.
    if (!task.preSpawnRetry) {
      const notes = takesNotices(task.context?.channel) ? this.notices.take(task.agentId) : ""
      if (notes) task.message = notes + task.message
    }

    state.totalTasks++
    state.lastActive = new Date()

    // Track the running task for live visibility (/agents endpoint surfaces this).
    const runningTask: RunningTask = {
      ...(homes.length ? { homes } : {}),
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messagePreview: runPreview(task),
      message: task.message || "",
      channel: task.context?.channel || "api",
      chatId: task.context?.chatId || task.context?.group,
      sender: task.context?.sender,
      startedAt: new Date(),
      ...(task.autonomy ? { autonomy: task.autonomy } : {}),
      ...(task.workflowRunId ? { workflow: { runId: task.workflowRunId } } : {}),
      ...(parentRunOf(task.context) ? { parent: parentRunOf(task.context) } : {}),
    }
    state.runningTasks.push(runningTask)
    task.runningTaskId = runningTask.id
    // Who started this chain (people, #384). Stamped on the context so a
    // delegation from this turn carries it in its root.
    const person = personOfTurn(this.config.people, task.context as any)
    if (task.context) {
      if (person) task.context.person = person.id
      else delete task.context.person
    }
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
      sender: task.context?.sender,
      rootId: currentRoot()?.rootId,
      workflowRunId: task.workflowRunId ?? (typeof runningTask.chatId === "string" && runningTask.chatId.startsWith("workflow:") ? runningTask.chatId.slice(9) || undefined : undefined),
      origin: task.origin ?? {
        kind: "direct",
        context: task.context as Record<string, unknown> | undefined,
        model: task.model,
        autonomy: task.autonomy,
      },
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
    runningTask.traceId = traceTaskId
    const abortEntry = this.taskAborts.get(runningTask.id)
    if (abortEntry) abortEntry.traceId = traceTaskId

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
      const formatter = makeStreamEventFormatter(() => !output.buffer || output.buffer.endsWith("\n"))
      onEvent = (event: any) => {
        noteFirstEvent()
        // Codex text reaches the buffer through wrappedOnDelta below.
        const formatted = state.def.tier === "codex-cli" && event?.item?.type === "agent_message"
          ? "" : formatter(event)
        if (formatted) pushToBuffer(formatted)
        // Per-step trace capture (improvement plan #2). Fire one
        // task:step event per tool_use / tool_result block. The
        // SQLite subscriber persists it under traceTaskId.
        emitTraceStepsFromStreamEvent(traceTaskId, task.agentId, event)
        tallyToolUses(toolUsesByName, event)
        // Claude Code's own view of the plan window; feeds the dispatch gate.
        recordRateLimitEvent(event, undefined, task.model || state.def.model)
        recordSessionInit(event, undefined, task.agentId)
        // Caller-supplied event subscriber (HTTP SSE callers, etc.).
        // Fire after internal capture so a subscriber crash never breaks
        // our own bookkeeping.
        if (callerOnEvent) { try { callerOnEvent(event) } catch { /* */ } }
      }
    } else {
      // No caller onDelta: the run keeps its own mode. When the runtime still
      // sends stream-json events (the persistent claude-code process does,
      // whatever the caller), the task's live output gets them too, so a run
      // started from Telegram, a2a, GitLab or a schedule streams on its Task
      // page while it works (#2101 R16). Before, only the final reply landed,
      // in one piece, when the run ended.
      const formatter = makeStreamEventFormatter(() => !output.buffer || output.buffer.endsWith("\n"))
      onEvent = (event: any) => {
        noteFirstEvent()
        // Codex text reaches the buffer through wrappedOnDelta below.
        const formatted = state.def.tier === "codex-cli" && event?.item?.type === "agent_message"
          ? "" : formatter(event)
        if (formatted) { output.streamed = true; pushToBuffer(formatted) }
        emitTraceStepsFromStreamEvent(traceTaskId, task.agentId, event)
        tallyToolUses(toolUsesByName, event)
        // Claude Code's own view of the plan window; feeds the dispatch gate.
        recordRateLimitEvent(event, undefined, task.model || state.def.model)
        recordSessionInit(event, undefined, task.agentId)
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
    // Set once the run emitted task:started / its own task:completed.
    // closeTrace emits the completion for a run that ended before reaching
    // it: a pre-spawn abort, a cancel or stop signal, an unexpected error.
    // Otherwise its trace stayed "in-flight" and the next boot resumed it
    // as cut-off work (#340, #857). A shutdown interruption is emitted
    // flagged `interrupted`, which keeps the trace open on purpose.
    let traceOpened = false
    let completedEmitted = false
    const closeTrace = (finalResponse: AgentResponse | undefined) => {
      if (!traceOpened || completedEmitted) return
      completedEmitted = true
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
          stopped: !this.interruptedRuns.has(runningTask.id) && (this.stoppedRuns.has(runningTask.id) || finalResponse?.errorKind === "stopped") ? true : undefined,
          at: new Date().toISOString(),
        } as any)
      } catch { /* observability never breaks the run */ }
    }

    let released = false
    const releaseRun = (finalResponse: AgentResponse | undefined) => {
      if (released) return
      released = true
      closeTrace(finalResponse)
      this.runReleases.delete(runningTask.id)
      if (deadline) clearTimeout(deadline)
      clearPreSpawnDeadline()
      state.activeTasks--
      this.applyPendingTier(state)
      this.admissionTickets.get(task)?.release()
      // Remove this run from the running-tasks list.
      const idx = state.runningTasks.findIndex((r) => r.id === runningTask.id)
      if (idx !== -1) state.runningTasks.splice(idx, 1)
      this.runningContexts.delete(runningTask.id)
      // Drop the abort entry — the controller is unreachable after this point
      // and a future cancel for the same id should 404, not silently no-op.
      this.taskAborts.delete(runningTask.id)
      const waiters = this.runEndWaiters.get(runningTask.id)
      this.runEndWaiters.delete(runningTask.id)
      for (const w of waiters ?? []) { try { w() } catch { /* */ } }

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
          ...(task.requestText?.trim() ? { requestText: task.requestText.trim() } : {}),
          startedAt: runningTask.startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - runningTask.startedAt.getTime(),
          ok: !finalResponse?.error,
          error: finalResponse?.error,
          ...(this.stoppedRuns.has(runningTask.id) || finalResponse?.errorKind === "stopped"
            ? { status: "stopped" as const }
            : timedOutStep ? { status: "timeout" as const, step: timedOutStep } : {}),
          responseText: finalResponse?.content || "",
          transcript: output.buffer,
          ...(task.leaseHome ? { home: task.leaseHome } : {}),
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

      // What this run never took mid-turn goes on its usual way.
      this.midTurn.endChat(midTurnKey(task.agentId, qChannel, qChatId))
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
          const flushedAt = Date.now()
          // The line is empty from here: what waited now runs (#443).
          getEventBus().emit("task:queue-flushed", {
            agentId: task.agentId, channel: qChannel, chatId: qChatId, flushedAt, count: queued.length, at: new Date().toISOString(),
          })
          const ended = () => getEventBus().emit("task:queue-ended", {
            agentId: task.agentId, channel: qChannel, chatId: qChatId, flushedAt, at: new Date().toISOString(),
          })
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
              .then((resp) => {
                // Queued again behind another turn: it still waits.
                if (!isQueued(resp.error)) ended()
                return this.postQueuedResponseToChannel(task.agentId, ctx, resp)
              }, (e) => { ended(); throw e })
              .catch((e) => {
                this.log(`[${task.agentId}] queued message failed: ${e.message}`)
              })
          }
        })
        .catch((e) => {
          getEventBus().emit("task:queue-ended", {
            agentId: task.agentId, channel: qChannel, chatId: qChatId, flushedAt: Date.now(), at: new Date().toISOString(),
          })
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
    // Asked now, read later: nothing before the context planner needs the
    // gate's answer, so it runs alongside history seeding, skill loading,
    // the continuity seat and compaction instead of ahead of them (#455).
    // The settle handlers also keep a run that returns before the await
    // from leaving a rejection unhandled; the await below still sees it.
    const requestGatePending = budgeted(
      "request-gate",
      () => evaluateRequest(task.message, task.agentId, channel),
      (): Awaited<ReturnType<typeof evaluateRequest>> => ({ active: false, preprocess: false }),
    )
    let requestGateSettled = false
    requestGatePending.then(() => { requestGateSettled = true }, () => { requestGateSettled = true })
    const chatId = qChatId
    const senderName = task.context?.sender || "User"
    const isCodexCli = state.def.tier === "codex-cli"

    // Session profile (#615): what this channel's sessions get up front.
    // `lean` (github, a2a, workflow, cron by default) hands the landscape,
    // chat history and cross-chat context over on demand through the
    // agentx MCP tools and starts Claude Code without user-level MCP
    // servers, skills and settings. Chat channels stay `full`.
    const sessionProfile = resolveSessionProfile(this.config.session, channel, state.def.tier)
    const lean = leanConfig(this.config.session)
    // An isolated run (#990) gets none of the context below, pushed or on
    // demand: only its own message.
    const isolated = task.isolated === true
    const leanOnDemand = !isolated && sessionProfile === "lean" && lean.contextOnDemand
    // A full Claude Code start can fetch the landscape on demand too
    // (#2009), behind its own switch (off by default); its history and
    // other chats stay pushed. Only Claude Code: the full profile adds the
    // agentx tools to it.
    const fullLandscapeOnDemand = !isolated && sessionProfile === "full" && state.def.tier === "claude-code" && this.config.session.fullContextOnDemand

    // Whether this conversation was under way before this turn (#2102 review
    // B5), read before any rotation below (fresh, stale, tier, max-turns,
    // model, cost) clears the session: a rotated session is still work in
    // progress in the checkout. Any runtime's native session counts, and
    // so does a reply of the agent's already in the chat's history, the
    // only record runtimes with no native session keep.
    const sessionBefore = (() => {
      const s = this.sessions.getSession(task.agentId, channel, chatId)
      return !!(s.claudeSessionId || s.codexSessionId || s.opencodeSessionId) || s.messages.some((m) => m.role === "agent")
    })()

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

    // How long the session sat idle before this turn. Read it now: seeding,
    // recording the user message and compaction below all bump updatedAt,
    // after which the session always looks idle for ~0 ms. The stale rule,
    // the resume gate and the router all need the pre-turn value.
    const priorIdleMs = this.sessions.sessionIdleMs(task.agentId, channel, chatId)

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
    const started: AgentXEvents["task:started"] = {
      agentId: task.agentId,
      channel,
      chatId,
      messagePreview: runPreview(task),
      fullMessage: task.message || "",
      requestText: task.requestText,
      at: new Date(taskStartedAt).toISOString(),
      taskId: traceTaskId,
      ...(task.workflowId ? { workflowId: task.workflowId } : {}),
      resumeOrigin: serializeOrigin(task.origin ?? {
        kind: "direct",
        context: task.context as Record<string, unknown> | undefined,
        model: task.model,
        autonomy: task.autonomy,
      }),
      resumeAttempt: task.resumeAttempt ?? 0,
      resumedFrom: task.resumedFrom,
      ...(task.jobStateAsk ? { jobStateAsk: true } : {}),
      sender: senderOf(task.context),
      ...(person ? { person } : {}),
      humanRoot: isHumanFacingTurn(task.context as any),
      pickup: isPickup(task.context),
      operator: isOperatorTurn(task.context),
      dueAt: dueAtOf(task.context as Record<string, unknown> | undefined),
      taskType: taskTypeOf(task.context as Record<string, unknown> | undefined),
      ...(typeof (task.context as Record<string, unknown> | undefined)?.home === "string"
        ? { home: ((task.context as Record<string, unknown>).home as string).slice(0, 500) } : {}),
      ...(wokenJobId(task.context) ? { jobId: wokenJobId(task.context) } : {}),
    }
    getEventBus().emit("task:started", started)
    traceOpened = true

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
    let pendingAutoRun: { workflowId: string; confidence: number; follow?: boolean } | undefined
    // Follow-up (#788): a saved workflow that fits this request is named to
    // the agent, which starts it with agentx_workflow instead of running
    // the steps by hand.
    let workflowHint: string | undefined
    const followUp = this.config.workflows?.followUp
    if (this.config.workflows?.enabled && followUp?.enabled && (followUp.agents[task.agentId] ?? true) && !restricted && isHumanFacingTurn(task.context as any)) {
      try {
        const store = new WorkflowStore({ baseDir: resolve(process.cwd(), this.config.workflows.dir) })
        const match = matchWorkflow({ agentId: task.agentId, channel, message: task.message, intentPath: intent?.path }, store.list())
        if (match && match.confidence >= (wfMatching?.suggestThreshold ?? 0.65)) workflowHint = workflowHintText(match.workflow)
      } catch (e: any) {
        this.log(`[${task.agentId}] workflow hint failed (non-fatal): ${e?.message || e}`)
      }
    }
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
    // workflows.required (#858): every task runs inside a workflow run. A
    // saved workflow that fits a person's request is started and followed
    // (matching need not be on); anything else is wrapped in a run of its
    // own, on a plan the agent writes or the one-step linear template. A
    // workflow step's own turn is never wrapped again.
    const wrapRunStore = requiredFor(this.config.workflows, task.agentId) && shouldWrap(task) ? this.workflowRuns : undefined
    if (wrapRunStore && !pendingAutoRun && !restricted && this.workflowAutoRunner && isHumanFacingTurn(task.context as any)) {
      try {
        const store = new WorkflowStore({ baseDir: resolve(process.cwd(), this.config.workflows.dir) })
        const match = matchWorkflow({ agentId: task.agentId, channel, message: task.message, intentPath: intent?.path }, store.list())
        const threshold = wfMatching?.autoRunThreshold ?? 0.85
        if (match && match.confidence >= threshold) {
          pendingAutoRun = { workflowId: match.workflow.id, confidence: match.confidence, follow: true }
          this.log(`[${task.agentId}] workflows.required: saved workflow ${match.workflow.id} fits (confidence=${match.confidence.toFixed(2)})`)
        }
      } catch (e: any) {
        this.log(`[${task.agentId}] workflows.required matcher failed (non-fatal): ${e?.message || e}`)
      }
    }
    // Chosen now so the agent is told its run before the turn starts; the
    // run itself is created inside the try below, which always closes it.
    const wrapRunId = wrapRunStore ? randomUUID() : undefined
    // Its own context layer, so mined procedures and the follow-up hint
    // never crowd it out of the procedures budget.
    const workflowRunContext = wrapRunId ? wrapHintText(wrapRunId) : undefined

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
        const loaded = await step("skills", () => loadLocalSkills(state.def.workspace))
        // A skill the person may not use is not offered to them either
        // (#379); the guard hook still blocks it if the agent reaches for it.
        const denied = task.personLimits?.skills ?? []
        const skills = denied.length ? loaded.filter((s) => !denied.some((p) => nameMatches(p, s.frontmatter.name))) : loaded
        skillInjection = getAutoInjectSkills(skills, task.message)
      } catch {
        // Skill loading is optional
      }
    }

    // Decide whether to resume or start fresh
    let resumeSessionId = this.resumeIdFor(task.agentId, state.def.tier, channel, chatId)

    // If session is stale (idle > staleMinutes), start fresh with full context rebuild
    if (resumeSessionId && this.sessions.isSessionStale(task.agentId, channel, chatId, priorIdleMs)) {
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
      this.log(`[${task.agentId}] tier-2 rotation for ${channel}:${chatId} (last turn context: ${lastTokens} tokens ≥ ${this.sessions.getTierTwoThresholdTokens(channel)})`)
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

    // The model seats, as one start. `gate` is the request gate's answer:
    // awaited on a fresh start, read only when already settled on a cold
    // resume (#2001, condition 5), so the gate never runs in series with
    // a seat at the model check.
    const startModelSeats = (gate: { active: boolean; preprocess?: boolean }) => {
      // Route mechanical work to a cheaper model, when the seat is active
      // and sure. Everything that is not an explicit confident "no" keeps
      // the agent's own model — see agents/routing.ts for why the failure
      // has to land on the expensive side.
      //
      // Started before the context selection and awaited after it: neither
      // reads the other's answer, so the two seat calls overlap instead of
      // queueing (#455). The answer is still in hand before the task runs.
      // A run started only by triage events (a label, a close) goes to the
      // configured triage model first: a fixed rule, no seat asked (#615).
      const triage = !task.model
        ? triageModelFor({
            tier: state.def.tier,
            channel,
            eventActions: task.context?.channelMeta?.eventActions,
            triage: this.config.session.triage,
            isFollowUp: Boolean(resumeSessionId),
            sessionIdleMs: resumeSessionId ? priorIdleMs : null,
          })
        : undefined
      if (triage?.downgraded) this.log(`[${task.agentId}] ${triage.reason}`)
      const cheapModel = cheapModelForEngine(state.def.tier, this.config.decisions.routing)
      // The downgrade seat's whole answer: a cold resume needs to know
      // whether it answered or failed, not only the model (#2001).
      const routeResultPending: Promise<RouteResult | undefined> =
        triage?.downgraded
          ? Promise.resolve(undefined)
          : !task.model && cheapModel && (!gate.active || gate.preprocess)
            ? (async () => {
                try {
                  const { routeTaskModel } = await import("./routing")
                  const route = await step("route-model", () => routeTaskModel({
                    message: task.message,
                    agent: task.agentId,
                    channel,
                    isFollowUp: Boolean(resumeSessionId),
                    // Idle time decides whether the cache this would give up still
                    // exists. See routing.ts for the arithmetic.
                    sessionIdleMs: resumeSessionId ? priorIdleMs : null,
                    cheapModel,
                  }))
                  if (route.downgraded) this.log(`[${task.agentId}] ${route.reason}`)
                  return route
                } catch {
                  /* routing is an optimisation; never let it stop a task */
                  return { downgraded: false, needsFlagship: null, reason: "routing threw", seat: "failed" as const }
                }
              })()
            : Promise.resolve(undefined)
      const routedModelPending: Promise<string | undefined> = triage?.downgraded
        ? Promise.resolve(triage.model)
        : routeResultPending.then((r) => r?.downgraded ? r.model : undefined)

      // The other direction: a job the task-edge seat is sure about moves UP
      // to the edge model for this job only, and may be told to use
      // sub-agents (agents/edge-routing.ts). Asked alongside the downgrade
      // above, with the same exclusions: a model named on the task (a cron
      // override), a triage run and an isolated run are left alone.
      const edgeRoutePending: Promise<EdgeRouteResult | undefined> =
        !task.model && !triage?.downgraded && !isolated
        && (state.def.tier === "claude-code" || state.def.tier === "codex-cli")
        && edgeSeatOn()
        && (!gate.active || gate.preprocess)
          ? (async () => {
              try {
                return await step("route-edge", () => routeTaskEdge({
                  message: task.message,
                  agent: task.agentId,
                  channel,
                  tier: state.def.tier,
                  isFollowUp: Boolean(resumeSessionId),
                  agentPrompt: state.def.systemPrompt ?? null,
                  edgeModel: edgeModelForEngine(state.def.tier, this.config.decisions.routing),
                  currentModel: state.def.model ?? null,
                  // Only a message a person wrote is read for implied work:
                  // a cron, a webhook or another agent says what it wants.
                  impliedWork: isHumanFacingTurn(task.context as any)
                    ? this.config.decisions.routing.impliedWork
                    : "off",
                }))
              } catch {
                /* never let this decision stop a task */
                return {
                  upgraded: false, subagents: false, needsEdge: null, subagentsHelp: null,
                  reason: "edge seat threw — keeping the agent's model", seat: "failed" as const,
                }
              }
            })()
          : Promise.resolve(undefined)
      return { triage, routeResultPending, routedModelPending, edgeRoutePending }
    }
    let earlySeats: ReturnType<typeof startModelSeats> | undefined

    // --- One model per session (#2001) ----------------------------------
    //
    // The session keeps the model it started on. Here, with the other
    // rotation rules and before the history and memo are built for a new
    // session, a turn that needs another model rotates (reason "model").
    // Rules in session-model.ts: a model named on the task that differs
    // rotates; a warm resume keeps its model (an edge upgrade is held,
    // unless the session sits on a cheap or triage model); a cold resume
    // asks the seats and rotates only on an answer, never on a failure.
    const storedModel = resumeSessionId
      ? this.sessions.getSessionModel(task.agentId, channel, chatId)
      : undefined
    const warmResume = isWarm(priorIdleMs)
    let modelRotatedTo: string | undefined
    if (resumeSessionId && storedModel) {
      let target: string | undefined
      // The agent moved to another runtime since this session started:
      // its stored model can't run there, so it always starts anew.
      const wrongRuntime = !modelFitsRuntime(state.def.tier, storedModel)
      if (wrongRuntime) {
        target = task.model ?? state.def.model
      } else if (task.model) {
        if (namedModelRotates(storedModel, task.model)) target = task.model
      } else if (!warmResume || !canHoldUpgrade(storedModel, state.def.model, edgeModelForEngine(state.def.tier, this.config.decisions.routing))) {
        // Started now, without waiting for the request gate: its answer
        // is read only if it is already in (#2001, condition 5).
        const gate = requestGateSettled
          ? await requestGatePending
          : { active: false, preprocess: false }
        earlySeats = startModelSeats(gate)
        traceStep("model-check")
        const [routed, edge] = await Promise.all([earlySeats.routeResultPending, earlySeats.edgeRoutePending])
        if (!warmResume) {
          const choice = coldResumeChoice({
            stored: storedModel,
            agentModel: state.def.model,
            triage: earlySeats.triage,
            routed,
            edge,
          })
          if (choice.rotate) target = choice.model
        } else {
          target = warmEdgeRotates(storedModel, state.def.model, edgeModelForEngine(state.def.tier, this.config.decisions.routing), edge)
        }
      }
      if (target || wrongRuntime) {
        this.log(`[${task.agentId}] model changed for ${channel}:${chatId} (${storedModel} → ${target ?? `${state.def.tier} default`}${wrongRuntime ? `, not a ${state.def.tier} model` : ""}): new session`)
        if (state.def.tier === "claude-code") {
          void this.captureRotationMemoAsync(task.agentId, state.def, resumeSessionId, channel, chatId, "model")
        }
        this.sessions.clearClaudeSessionId(task.agentId, channel, chatId)
        getEventBus().emit("session:rotated", {
          agentId: task.agentId, channel, chatId,
          reason: "model",
          at: new Date().toISOString(),
        })
        resumeSessionId = undefined
        modelRotatedTo = target
      }
    }

    // Resume or start fresh (#621, step 3): a price comparison in code, not
    // a model. Like the continuity seat below it can only rotate earlier
    // than the rules above, never keep a session they dropped.
    if (resumeSessionId && state.def.tier === "claude-code") {
      // Optional chaining: hand-built configs (tests, older callers) may
      // not carry the block the schema defaults in.
      const gate = this.config.session?.resumeGate
      if (gate && gate.mode !== "off") {
        const r = decideResume({
          // Raw reading: the cumulative fallback would make C the turn's
          // summed input, N ≈ 1, and the cold-cache cost about twice it.
          contextTokens: this.sessions.getRawLastTurnContextTokens(task.agentId, channel, chatId),
          turnInputTokens: this.sessions.getLastTurnInputTokens(task.agentId, channel, chatId),
          idleMs: priorIdleMs ?? 0,
        }, gate)
        if (r.rotate && gate.mode === "active") {
          this.log(`[${task.agentId}] cost rotation for ${channel}:${chatId}: ${describeResume(r)}`)
          void this.captureRotationMemoAsync(task.agentId, state.def, resumeSessionId, channel, chatId, "cost")
          // Read before clearing: clearClaudeSessionId resets the counters.
          const lastTokens = this.sessions.getLastTurnInputTokens(task.agentId, channel, chatId)
          this.sessions.clearClaudeSessionId(task.agentId, channel, chatId)
          getEventBus().emit("session:rotated", {
            agentId: task.agentId, channel, chatId,
            reason: "cost",
            lastTurnInputTokens: lastTokens,
            at: new Date().toISOString(),
          })
          resumeSessionId = undefined
        } else if (gate.mode === "shadow") {
          this.log(`[${task.agentId}] resume gate (shadow) for ${channel}:${chatId}: would ${describeResume(r)}`)
        }
      }
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
      ? buildWikiContext(agentWiki, task.agentId, {
        notesInbox: wikiNotesHint(this.config),
        catalog: this.config.wiki?.startCatalog,
      })
      : undefined

    // The owner's newest decisions, ahead of the history and the memo
    // below, which can be hours old (owner-decisions.ts). Same gate as the
    // catalog. With `wiki.decisionApprovals.required`, only decision pages
    // the owner approved as they stand now (decision-approvals.ts, #1778).
    let ownerDecisions: string | undefined
    if (!resumeSessionId && !isCodexCli) {
      try {
        const required = this.config.wiki?.decisionApprovals?.required === true
        let candidates = decisionPagesFor(agentWiki, task.agentId)
        // With the Rules Registry on, the registry page reaches runs through
        // its own scoped block, not here (#809). Filtered in the caller so
        // `wiki decisions list` still offers the page for approval.
        if (this.config.rules?.enabled) {
          const registryPath = resolve(this.wikiHub.getAgentWiki(this.config.rules.registryAgent).baseDir, this.config.rules.registryPage)
          candidates = candidates.filter((a) => resolve(agentWiki.baseDir, a.path) !== registryPath)
        }
        const pages = decisionsForBlock(candidates, agentWiki.baseDir, required)
        ownerDecisions = buildOwnerDecisions(pages, Date.now()) || undefined
      } catch { /* the block is optional */ }
    }

    // Lean sessions fetch earlier turns with agentx_recent instead.
    const sessionHistory = !resumeSessionId && !leanOnDemand
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
    // Lean sessions read other chats with agentx_recent (no chatId) instead.
    let crossChatContext = isolated || leanOnDemand ? "" : this.sessions.getCrossSessionSummary(
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
    const lmHint = isolated ? null : detectLongMemoryHint(task.message)
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
    // Steps since have moved the run's step label on; a run that stalls here
    // is waiting on the gate, so that is the step it must report.
    if (!requestGateSettled) traceStep("request-gate")
    const requestGate = await requestGatePending
    if (requestGate.arm === "holdout") this.log(`[${task.agentId}] request-gate holdout: skipping Jev preprocessing for this turn`)
    // A lean session has nothing for the planner to curate: history and
    // cross-chat are fetched by the agent, not pushed.
    if (strategy === "planner" && !isolated && !requestGate.active && !leanOnDemand && channel !== "voice" && channel !== "desktop") {
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
    // project / reference). Its index changes on every memory write, so it
    // stays out of the cached system prompt and the workspace CLAUDE.md
    // (#2009 B1): one copy, in the task text of a fresh start next to
    // Claude Code's auto-memory block, for every engine. Empty when the
    // agent has no memories yet. Rendered capped; the file stays whole.
    const agentMemoryStart = isolated ? "" : agentMemoryStartBlock(
      this.agentMemory.indexMarkdown(task.agentId),
      state.def.workspace ? resolve(state.def.workspace, ".agentx-memory.md") : "`agentx memory index`",
      this.config.session.memoryIndexMaxChars,
    )

    // Context Surgery — Fix 4: code-first operating principle for coding-tier
    // agents. Cacheable (lives in the system-prompt prefix). Empty for non-
    // coding tiers so chat/orchestrator agents are unaffected.
    const codeFirstInstruction = codingInstructions(state.def.tier)

    // Rich-reply convention — only on interactive chat channels, and only when
    // the agent hasn't opted out. Rides the cacheable system prompt so it
    // costs nothing per turn. Kept short and conditional ("when it genuinely
    // helps") so agents don't spray buttons on every reply.
    // A spoken question in a phone conversation is still a voice turn (#1455).
    const richReplyInstruction = richReplyPrompt(state.def.richMessages, task.context?.via === "voice" ? "voice" : channel)

    // Context Surgery — Fix 3: per-workspace CLAUDE.md auto-injection. Read
    // once at task-setup, cap at 4KB to bound prompt size, silent fallback so
    // a missing/unreadable file is a no-op. Lives in the cacheable system
    // prompt prefix; project-specific patterns reach the agent before any
    // task context.
    // A claude-code session gets the workspace CLAUDE.md from Claude Code
    // itself: it runs in the workspace, and its setting sources include the
    // project unless a lean profile leaves it out. Appending it here as well
    // sent it twice (#615 for lean, #455 for full: about 2.5k characters on
    // every call of a session).
    const claudeLoadsWorkspace = state.def.tier === "claude-code" && (isolated || sessionProfile !== "lean" || leanLoadsWorkspace(lean))
    let projectClaudeMd = ""
    if (state.def.workspace && !claudeLoadsWorkspace) {
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

    // #2000: a claude-code start gets Claude Code's own instruction files
    // here instead of in message 1, where they sat before the only message
    // cache mark and were written again on every start. The stable files go
    // in the cached system prompt; MEMORY.md, rewritten many times a day,
    // goes in the task text. The process is told not to load them itself.
    // Both are read after inTaskWorktree, from the folder the process
    // really starts in (withClaudeMdFiles).
    const ownClaudeMd = state.def.tier === "claude-code"
    const claudeSources: SettingSource[] = isolated
      ? ["project", "local"]
      : sessionProfile === "lean" ? lean.settingSources : ["user", "project", "local"]

    const systemPromptAppend = [
      state.def.systemPrompt || "",
      codeFirstInstruction,
      richReplyInstruction,
      // Every agent, in a worktree or not: the CI fix loop finds a
      // change's agent by this marker (#2102 review).
      requestMarkerInstruction(task.agentId),
      projectClaudeMd,
      projectRunbook,
      bootstrapContextText || "",
    ].filter((s) => s.trim().length > 0).join("\n\n") || undefined

    // Read here, after the planner may have dropped the session above.
    const runRules = this.rulesForRun(task, channel, chatId, !resumeSessionId)

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
      // Lean sessions, and full Claude Code ones with the switch on (#2009),
      // fetch it with agentx_agents (landscape=true) instead.
      landscape: (isCodexCli || leanOnDemand || fullLandscapeOnDemand || isCodingChannelContext(channel, state.def.tier))
        ? undefined
        : this.landscape?.getForAgent(task.agentId),
      channelMeta: task.context?.channelMeta,
      mediaPath: task.context?.mediaPath,
      mediaType: task.context?.mediaType,
      replyToText: task.context?.replyToText,
      // bootstrapContext intentionally omitted — delivered via system prompt.
      patternContext: isCodexCli ? undefined : patternContext || undefined,
      procedureContext: [procedureContext, workflowHint].filter(Boolean).join("\n\n") || undefined,
      workflowRunContext,
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
      // The one line that stands in for the three layers above on a fresh
      // lean session; a resumed one already saw it. A full fresh start gets
      // the note without the history it still pushes (#2009).
      contextOnDemand: resumeSessionId
        ? undefined
        : leanOnDemand
          ? onDemandContextNote(channel, chatId)
          : fullLandscapeOnDemand ? onDemandContextNote(channel, chatId, { historyPushed: true }) : undefined,
      wikiContext,
      handoverNote: this.buildHandoverNote(task.agentId, channel, chatId),
      // Kept on an isolated run too: it is about this run, not its context.
      rotationMemo,
      ownerDecisions,
      rulesBlock: runRules.block,
      // Checked here, after the planner may have dropped the session.
      eventDigest: !resumeSessionId ? buildEventDigest(task.agentId, this.config.agents[task.agentId]?.subscriptions ?? state.def.subscriptions) : undefined,
      // How to show a file on the phone: once, when the session starts.
      // Sent only on a fresh app session with rich messages on (#259); the
      // outbox is prepared only when the hint that names it goes out (#258).
      attachHint: (() => {
        const hint = appAttachHint(channel, !resumeSessionId, state.def.richMessages)
        return hint ? withOutbox(state.def.workspace, hint) : undefined
      })(),
      // The chat's situation (#1892): fresh sessions, or a talk that is
      // ending or ended. Never throws; no record, no line.
      situation: situationContextFor(task.context?.situationKey, { fresh: !resumeSessionId }),
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
    if (isolated) {
      Object.assign(contextInput, {
        landscape: undefined, patternContext: undefined, procedureContext: undefined, workflowRunContext: undefined,
        references: undefined, skillInjection: undefined, sessionHistory: undefined, memoryContext: undefined,
        crossChatContext: undefined, longMemoryRecall: undefined, contextOnDemand: undefined, wikiContext: undefined,
        handoverNote: undefined, rotationMemo: undefined, ownerDecisions: undefined, eventDigest: undefined, attachHint: undefined,
        situation: undefined,
      } satisfies Partial<ContextInput>)
    }

    // The three model seats (triage rule, downgrade, edge). Started here on
    // a fresh start, as before (#455). A cold resume, or a warm one on a
    // cheap or triage model, started them already at the model check in
    // the rotation block (#2001), so the answers are reused, not asked twice.
    // Unless the gate, unread then, turned out active without preprocessing
    // (the holdout arm): no seat is asked on that arm, so the early answers
    // are dropped and the session keeps its stored model, as with the seats
    // off. The triage rule is no seat and stays.
    const gateDropsEarlySeats = Boolean(earlySeats) && requestGate.active && !requestGate.preprocess
    if (gateDropsEarlySeats) this.log(`[${task.agentId}] request gate active without preprocessing: early model seat answers dropped for ${channel}:${chatId}`)
    const seats = gateDropsEarlySeats && earlySeats
      ? {
          triage: earlySeats.triage,
          routedModelPending: Promise.resolve(earlySeats.triage?.downgraded ? earlySeats.triage.model : undefined),
          edgeRoutePending: Promise.resolve(undefined),
        }
      : earlySeats ?? startModelSeats(requestGate)
    const { triage, routedModelPending, edgeRoutePending } = seats
    let routedModelSettled = false
    routedModelPending.then(() => { routedModelSettled = true })
    let edgeRouteSettled = false
    edgeRoutePending.then(() => { edgeRouteSettled = true })

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
      rules: runRules.ids,
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
    // Claude Code starts are measured whole, from the first call's usage
    // (task_traces.start_tokens, start_over_budget, #2009); this count of
    // AgentX's own part stays for the other engines.
    if (state.def.tier !== "claude-code" && agentxContextBytes > 16_000) {
      this.log(`[${task.agentId}] large context for ${channel}:${chatId}: ${agentxContextBytes} bytes (history=${sizeParts.history}, sysPrompt=${sizeParts.sysPrompt}, message=${sizeParts.message})`)
    }

    // Attach the cacheable preamble onto the task so runtime.ts can forward
    // it to Claude CLI's --append-system-prompt arg.
    if (!routedModelSettled) traceStep("route-model")
    const routedModel = await routedModelPending

    // Lean claude-code sessions also start the CLI with only the agentx MCP
    // server and the project's settings (#615); full ones add the agentx
    // server to what they load anyway (#668). The flags describe the
    // process, so a resumed session carries them too.
    const claudeArgs = state.def.tier !== "claude-code"
      ? undefined
      : isolated
        ? isolatedClaudeArgs()
        : sessionProfile === "lean"
          ? leanClaudeArgs(state.def.workspace, lean, undefined, channel)
          : fullClaudeArgs(state.def.workspace)
    if (sessionProfile === "lean" && !isolated && !resumeSessionId) {
      this.log(`[${task.agentId}] session profile for ${channel}: ${describeProfile(sessionProfile, lean, channel)}`)
    }

    // tool-set seat, shadow only (#455): which built-in tools this fresh
    // session would need. Asked alongside the run and never awaited here,
    // so it adds no time before the agent starts; the run's own tool calls
    // label it afterwards.
    const toolSetPending = state.def.tier === "claude-code" && !resumeSessionId
      ? startToolSetShadow({
          message: task.message ?? "",
          agent: task.agentId,
          channel,
          agentPrompt: state.def.systemPrompt ?? null,
          taskId: traceTaskId,
        }, (m) => this.log(m))
      : undefined

    // A confident "needs the edge model" wins over a downgrade: the two
    // seats disagree only when one of them is wrong, and the cheaper
    // mistake is the stronger model. That holds when the agent is already
    // configured on the edge model too (#1864): the downgrade is dropped.
    if (!edgeRouteSettled) traceStep("route-edge")
    const askedEdgeRoute = await edgeRoutePending
    // A session that goes on keeps its model (#2001): the edge answer's
    // model is dropped, its implied-work line and sub-agent hint stay.
    const heldUpgrade = Boolean(resumeSessionId && storedModel && askedEdgeRoute?.model && !sameModel(askedEdgeRoute.model, storedModel))
    if (heldUpgrade) {
      this.log(`[${task.agentId}] edge upgrade held for ${channel}:${chatId} (${warmResume ? "warm" : "cold"}, idle ${Math.round((priorIdleMs ?? 0) / 1000)}s, stored=${storedModel}, wanted=${askedEdgeRoute!.model}, task ${traceTaskId})`)
    }
    const edgeRoute = heldUpgrade ? heldEdgeRoute(askedEdgeRoute!) : askedEdgeRoute
    const edgePlan = edgePlanFor(edgeRoute, { tier: state.def.tier, claudeArgs })
    const jobModel = jobModelFor(edgeRoute, routedModel)
    // The turn always names its model, so a warm process on another model
    // is respawned (staleHandleReason) and the model is stored with the
    // session. A resume runs on the session's model (#2001, condition 1);
    // a new session on the model the check chose, else as routed.
    const turnModel = task.model
      ?? (resumeSessionId ? resumeModel(storedModel, jobModel, state.def.model) : modelRotatedTo ?? jobModel ?? state.def.model)
    const downgradeDropped = Boolean(routedModel) && jobModel !== routedModel
    if (edgeRoute && (edgeRoute.upgraded || edgeRoute.subagents || downgradeDropped || (edgeRoute.impliedP ?? 0) >= IMPLIED_AT)) {
      this.log(`[${task.agentId}] ${edgeRouteLog(edgeRoute, routedModel)}`)
    }

    const taskWithSystemPrompt: AgentTask = {
      ...task, systemPromptAppend,
      ...(claudeArgs ? { claudeArgs } : {}),
      ...(ownClaudeMd ? { ownClaudeMd } : {}),
      ...(turnModel ? { model: turnModel } : {}),
      ...(edgePlan.subagentModel ? { subagentModel: edgePlan.subagentModel } : {}),
      ...(edgePlan.turnNote ? { turnNote: edgePlan.turnNote } : {}),
    }

    let finalResponse: AgentResponse | undefined
    // turn-progress shadow seat: watches the tool steps of this turn.
    const turnWatch = startTurnWatch({
      agent: task.agentId, request: task.message, taskId: traceTaskId,
      budgetMinutes: state.def.maxExecutionMinutes ?? 20,
    })
    const unwatchedOnEvent = onEvent
    // workflows.required (#858): the turn's wrapping run, once created, and
    // whether every tool it used changed nothing (the plain-question test).
    let wrapStarted = false
    let wrapReadOnly = true
    onEvent = (event: any) => {
      turnWatch.observe(event)
      if (wrapRunId && wrapReadOnly) {
        for (const use of toolUsesOf(event)) if (!isReadOnlyToolUse(use.name, use.input)) wrapReadOnly = false
      }
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
            ...(autoRun.follow ? { follow: true } : {}),
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
            // A required run answers the person with where their request
            // went; the run's own steps and summary do the rest.
            content: autoRun.follow
              ? `Started the workflow "${result.title ?? autoRun.workflowId}" for this${result.runId ? ` (run ${result.runId})` : ""}. AgentX follows each step and tells the owner when it is done.`
              : "",
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

      // workflows.required (#858): no saved workflow took it, so the turn
      // runs inside a run of its own. Best-effort: a store that cannot
      // write never stops the task.
      if (wrapRunId && wrapRunStore) {
        try {
          // A stopped task resumed: its new run names the run the stop closed.
          const continues = continuedRun(wrapRunStore, task.resumedFrom)
          startWrap(wrapRunStore, { runId: wrapRunId, agentId: task.agentId, channel, chatId, message: task.message, taskId: traceTaskId, ...(continues ? { continues } : {}) })
          wrapStarted = true
          runningTask.workflow = { runId: wrapRunId, workflowId: TASK_WORKFLOW_ID }
        } catch (e: any) {
          this.log(`[${task.agentId}] workflows.required: could not create run ${wrapRunId} (non-fatal): ${e?.message || e}`)
        }
      }

      // Pre-flight gates (claude-code tier only). Two separate heuristics that
      // short-circuit doomed cold dispatches BEFORE we burn a Claude CLI
      // subprocess to reproduce the same failure:
      //   (1) Overage gate — when Anthropic has disabled Max-plan extra usage
      //       at the org level. A cold dispatch's fresh cache-create spills
      //       past the regular allotment and gets rejected.
      //   (2) Quota gate — when Claude Code reports a plan window as
      //       rejected (and extra usage is not serving), or when an opt-in
      //       local dispatch cap is reached. Warm sessions still pass; cold
      //       dispatches are deferred.
      // Warm sessions (resumeSessionId set) bypass both gates — prompt-cache
      // replay keeps them inside the regular allotment.
      //
      // Kept inside the try so the `finally` below still runs — otherwise a
      // short-circuit return leaks runningTask bookkeeping.
      //
      // The gates guard a LOCAL claude spawn, so a task bound for a cloud
      // session (#622) skips them: the session draws on separate credit, and
      // a rejected plan window is exactly when the cloud is wanted. When the
      // launch then fails, the gates run before the local fallback.
      const runDispatchGates = (): AgentResponse | null => {
        if (state.def.tier !== "claude-code") return null
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
          preflightQuotaGate(hasWarmSession, undefined, task.model || state.def.model, priorityOfTask(task)),
        ]
        const abort = gates.find((g) => g && g.abort)
        if (abort) {
          this.log(`[${task.agentId}] skipping cold dispatch — ${abort.reason}`)
          const preflightResponse: AgentResponse = {
            content: "",
            error: abort.message,
            errorKind: "dispatch_hold",
            ...("retryAt" in abort && typeof abort.retryAt === "number" ? { retryAt: abort.retryAt } : {}),
            duration: 0,
          }
          if (!onDelta) {
            output.buffer = `[error] ${abort.message}`
            for (const sub of output.subscribers) {
              try { sub(output.buffer) } catch { /* */ }
            }
          } else {
            // A streaming caller (the Hub chat, #2101 R14) shows the
            // refusal while it waits, as an error line of the live output.
            pushToBuffer(`\n[error] ${oneLine(abort.message)}\n`)
          }
          return preflightResponse
        }
        // Past the gates — commit the dispatch to the rolling budget and log
        // a warning if we've crossed warnRatio so the operator sees pressure
        // building before it turns into rejections.
        recordClaudeCodeDispatch()
        const warning = warnIfNearingCap()
        if (warning) this.log(`[${task.agentId}] ${warning}`)
        return null
      }
      // Monthly money budget (#1162): an agent past its cap, a run whose
      // project is past its cap (#1290), or a fleet past the fleet cap,
      // starts no new run, on any tier and warm or cold, until the cap is
      // raised or the month turns.
      const overBudget = preflightBudgetGate(task.agentId, undefined, budgetProjectOf(task.agentId, task.context?.chatId))
      if (overBudget) {
        traceStep("budget-gate")
        this.log(`[${task.agentId}] run refused — ${overBudget.reason}`)
        if (!onDelta) {
          output.buffer = `[error] ${overBudget.message}`
          for (const sub of output.subscribers) {
            try { sub(output.buffer) } catch { /* */ }
          }
        } else {
          pushToBuffer(`\n[error] ${oneLine(overBudget.message)}\n`)
        }
        state.errors++
        finalResponse = { content: "", error: overBudget.message, errorKind: "budget_cap", duration: 0 }
        return finalResponse
      }

      const cloudRoute = this.planCloudSession(state.def, task)
      if (cloudRoute.route === "local") {
        const gated = runDispatchGates()
        if (gated) {
          // The early return skips the error accounting below; a gated
          // fallback inside the agent step goes through it instead.
          state.errors++
          finalResponse = gated
          return gated
        }
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
      // Line and mid-thought rules: makeBufferThinkingWriter.
      const thinkingWriter = makeBufferThinkingWriter(() => output.buffer, pushToBuffer)
      const wrappedOnThinking: ThinkingCallback | undefined = tierUsesStreamJson
        ? onThinking
        : (text) => {
            thinkingWriter.think(text)
            if (onThinking) onThinking(text)
          }
      // When the agent transitions back to text, close any open
      // thought block in the modal so the next text chunk doesn't
      // get folded into the same line.
      const closeThinkingIfOpen = () => thinkingWriter.close()
      const wrappedOnDeltaWithThinkingClose: StreamCallback | undefined = tierUsesStreamJson
        ? wrappedOnDelta
        : wrappedOnDelta
          ? (text, fullText) => { closeThinkingIfOpen(); wrappedOnDelta(text, fullText) }
          : undefined
      // The runtime reaps its own subprocess on abort; the grace only covers
      // a runtime that never returns.
      const response = await step("agent", async () => {
        // Cloud first (#622): a launched session answers the task; a failed
        // launch runs it locally after the gates a local spawn gets.
        if (cloudRoute.route !== "local") {
          const cloud = await this.runCloudSession(state.def, task, cloudRoute, traceTaskId)
          if (cloud) return cloud
          const gated = runDispatchGates()
          if (gated) return gated
        }
        const local = await this.inTaskWorktree(state.def, taskWithSystemPrompt, { sessionKept: sessionBefore })
        if (local.refused) return { content: "", error: local.refused } as AgentResponse
        // Claude Code's auto-memory is not cut: it lists its newest notes
        // last, and Claude Code's own 200-line rule is kept until the hand
        // trim of #2002 step 4 (review of PR #2035).
        const own = withClaudeMdFiles(local.task, local.def.workspace, claudeSources)
        // The two memory indexes, volatile, go first in the task text and
        // only on a fresh start: a resumed session already has them.
        const startMemory = local.fresh || !resumeSessionId ? [own.autoMemory, agentMemoryStart] : []
        return executeTask(local.def, own.task, this.providers, wrappedOnDeltaWithThinkingClose, [...startMemory, historyContext].filter(Boolean).join("\n\n") || undefined, local.fresh ? undefined : resumeSessionId, onEvent, abortController.signal, wrappedOnThinking)
      }, CANCEL_GRACE_MS)

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

      if (toolSetPending) {
        void labelToolSetRun(toolSetPending, {
          toolUses: toolUsesByName, eventsSeen: firstEventSeen, error: response.error, agentId: task.agentId,
        }, (m) => this.log(m))
      }

      // Stopped by a daemon shutdown: say so, whatever the runtime made of
      // the kill, and leave the trace in flight so the next boot resumes it.
      const interruptedBy = this.interruptedRuns.get(runningTask.id)
      if (interruptedBy) {
        response.content = ""
        response.error = interruptedBy
        response.errorKind = "interrupted"
      }
      // Ended by a stop signal (#857): stopped, not failed.
      const stoppedBy = interruptedBy ? undefined : this.stoppedRuns.get(runningTask.id)
      if (stoppedBy) {
        response.content = ""
        response.error = stoppedBy
        response.errorKind = "stopped"
      }

      finalResponse = response

      // Split this request's tokens into tier1/tier2 buckets so subscribers
      // (sqlite usage_daily, audit, dashboard) record both lanes. The same
      // threshold that TokenTracker.record() applies — extracted as a
      // helper so the two sites can never drift.
      const split = response.usage ? splitTaskUsageByTier(response.usage, response.callUsage) : undefined
      // What the run cost: the runtime's own figure when it reports one
      // (Claude Code's total_cost_usd), else the tokens at the billed
      // model's list price: Claude, or another provider's API model in the
      // price table (#1290). A model with no price (local) records no cost.
      // Summed per agent, project and month (#1162).
      const pricedModel = response.billedModel || task.model || state.def.model || undefined
      const costUsd = response.costUsd ?? (response.usage
        ? this.tokenTracker.runCost(response.usage, pricedModel, state.def.tier, response.callUsage)
        : undefined)
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
        stopped: stoppedBy ? true : undefined,
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
        // The start-size guard (#2009): the same first-call usage the cost
        // signals below judge, so the column and start_over_budget agree.
        startTokens: startTokens({ resumed: Boolean(resumeSessionId), calls: response.callUsage }) ?? undefined,
        costUsd: costUsd !== undefined && Number.isFinite(costUsd) && costUsd > 0 ? costUsd : undefined,
        injectedContext,
        finalResponse: response.content || undefined,
        // Per-task model attribution: prefer what the runtime actually
        // billed; then the per-task override (cron model); then the agent's
        // configured model so codex-cli / sdk agents don't get stamped with
        // the daemon-wide opus default. Same order as the usage tracker below.
        billedModel: response.billedModel || task.model || state.def.model || undefined,
        at: new Date().toISOString(),
      })
      // Token waste, ranked like failures (#1995): judged after the reply
      // below is recorded (see the end of this block).
      const costRun = response.usage && !interruptedBy && !stoppedBy
        ? {
          taskId: traceTaskId,
          agentId: task.agentId,
          channel,
          chatId,
          workflowId: task.workflowId ?? null,
          startedAt: taskStartedAt,
          resumed: Boolean(resumeSessionId),
          resumeSessionId: resumeSessionId || null,
          model: response.billedModel || task.model || state.def.model || null,
          usage: response.usage,
          calls: response.callUsage,
        }
        : null

      // For non-streaming runs (no caller onDelta) we never captured incremental
      // chunks — surface the final response in one shot so the dashboard modal
      // shows something meaningful when subscribers are attached.
      // A run whose events already streamed (#2101 R16) keeps what it wrote;
      // only an error the stream did not carry is added, on its own line.
      if (!onDelta && output.streamed) {
        if (response.error && !output.buffer.includes(response.error)) {
          pushToBuffer(`${output.buffer && !output.buffer.endsWith("\n") ? "\n" : ""}[error] ${response.error}\n`)
        }
      } else if (!onDelta && (response.content || response.error)) {
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

        // Store native CLI session IDs for future resume, with the model
        // the turn asked for (#2001).
        const ranOn = modelToStore(taskWithSystemPrompt.model, response.billedModel)
        if (response.claudeSessionId) {
          this.sessions.setClaudeSessionId(task.agentId, channel, chatId, response.claudeSessionId, ranOn)
        }
        if (response.codexSessionId) {
          this.sessions.setCodexSessionId(task.agentId, channel, chatId, response.codexSessionId, ranOn)
        }
        if (response.opencodeSessionId) {
          this.sessions.setOpenCodeSessionId(task.agentId, channel, chatId, response.opencodeSessionId, ranOn)
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
          if ((contextSize ?? cumulative) >= this.sessions.getTierTwoThresholdTokens(channel)) {
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
        // Every finished task leaves one line on why it was or was not
        // captured, counted by `agentx wiki status` (#603).
        const captureRuns = resolve(this.wikiHub.getBaseDir(), CAPTURE_RUNS_FILE)
        if (!wikiCapture.capture) recordCaptureSkip(captureRuns, task.agentId, wikiCapture, (m) => this.log(m))
        if (wikiCapture.capture) {
          // The entry carries the classifier's path; by now the turn has
          // run for seconds to minutes, so this rarely waits at all.
          await awaitIntent(INTENT_WAIT_BEFORE_ENTRY_MS)
          recordCaptureWrite(captureRuns, task.agentId, () => {
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
          }, (m) => this.log(m))

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
          response.callUsage,
        )

        this.log(
          `[${task.agentId}] completed in ${response.duration}ms` +
            (response.tokensUsed ? ` (${response.tokensUsed} tokens)` : "") + ` ${runTag()}`,
        )
      }

      // Cost signals (#1995) read task_traces: on a later tick, after the
      // reply is recorded, so they never delay a reply or /health. A run a
      // shutdown or a stop cut short is not judged. Never throws.
      if (costRun) queueCostSignals(costRun)

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
      if (wrapStarted && wrapRunId && wrapRunStore) {
        try {
          const usage = finalResponse?.usage
          const closed = finishWrap(wrapRunStore, wrapRunId, {
            error: finalResponse ? finalResponse.error || undefined : (abortController.signal.aborted ? abortReason(abortController.signal).message : "run ended before completion"),
            canceled: endedWithoutFailing(finalResponse?.errorKind) || this.stoppedRuns.has(runningTask.id) || this.interruptedRuns.has(runningTask.id) || (!finalResponse && abortController.signal.aborted),
            durationMs: Date.now() - runningTask.startedAt.getTime(),
            ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
            readOnly: wrapReadOnly,
            exemptQuestions: this.config.workflows?.required?.exemptQuestions ?? true,
          })
          if (closed && closed !== "discarded") this.log(`[${task.agentId}] workflow run ${wrapRunId} ${closed.status} (${closed.meta?.wrap?.mode ?? "linear"})`)
        } catch (e: any) {
          this.log(`[${task.agentId}] workflows.required: could not close run ${wrapRunId} (non-fatal): ${e?.message || e}`)
        }
      }
      // A run that threw before its completion event (a pre-spawn abort, a
      // cancel, an unexpected error) still closes its trace; otherwise the
      // row stayed "in-flight" and the next boot resumed it as cut-off work
      // (#340). A shutdown interruption keeps it open on purpose.
      closeTrace(finalResponse)
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
    /** An engine switch saved while busy, waiting for the runs going (#2101 B2). */
    pendingTier?: string
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
        ...(this.pendingTiers.has(s.id) ? { pendingTier: this.pendingTiers.get(s.id)!.tier } : {}),
        model: s.def.model,
        workspace: s.def.workspace,
        active: s.activeTasks,
        total: s.totalTasks,
        errors: s.errors,
        lastActive: s.lastActive,
        runningTasks: this.withLastActivity(this.withWorkflowSteps(s.runningTasks)),
        lastSummary: summary ? { text: summary.text, at: summary.at.toISOString(), ok: summary.ok } : undefined,
        hourlyTasks: this.getHourlySparkline(s.id, 24),
      }
    })
  }

  /** Running tasks with the last line each wrote (#1381); the stored list
   *  is not touched. */
  private withLastActivity(tasks: RunningTask[]): RunningTask[] {
    return tasks.map((t) => {
      const out = this.taskOutputs.get(t.id)
      const line = out ? lastActivityLine(out.buffer.slice(-2000)) : undefined
      return line ? { ...t, lastActivity: line } : t
    })
  }

  /** Running tasks with the workflow run each belongs to and the step it
   *  is on (#858), read from the run store; the stored list is not touched. */
  private withWorkflowSteps(tasks: RunningTask[]): RunningTask[] {
    const runs = this.workflowRuns
    if (!runs || !tasks.some((t) => t.workflow)) return tasks
    return tasks.map((t) => {
      if (!t.workflow) return t
      try {
        const run = runs.get(t.workflow.runId)
        if (!run) return t
        return { ...t, workflow: { ...t.workflow, workflowId: run.workflowId, step: liveStep(run), title: run.meta?.title ?? run.workflowId } }
      } catch { return t }
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
    this.sessionIndex?.note(record)
  }

  /** The runs that share a chat with one run (#2101 R4), read from the
   *  saved records; built per agent on first use. */
  private sessionIndex: TaskSessionIndex | null = null
  private sessionIndexRoot = ""

  /**
   * One run's session: the agent's runs in the same channel and chat, in
   * order, paged (task-session.ts). Null when the run is neither saved nor
   * running.
   */
  getTaskSession(agentId: string, taskId: string, opts: { before?: string | null; limit?: number } = {}): SessionPage | null {
    const root = resolve(process.cwd(), TASK_HISTORY_DIR)
    if (!this.sessionIndex || this.sessionIndexRoot !== root) {
      this.sessionIndex = new TaskSessionIndex(root)
      this.sessionIndexRoot = root
    }
    const live = this.agents.get(agentId)?.runningTasks ?? []
    return this.sessionIndex.page(agentId, taskId, live, opts)
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
    if (removed) this.sessionIndex?.reset()
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

  /** Check every minute whether held work may run: the month may have
   *  turned. A raised cap releases it at once (releaseBudgetHolds). */
  private armBudgetRelease(): void {
    if (this.budgetReleaseTimer) return
    this.budgetReleaseTimer = setInterval(() => this.releaseBudgetHolds(), 60_000)
    this.budgetReleaseTimer.unref?.()
  }

  /**
   * Run the messages held for agents whose budget gate passes again, each
   * as a queued turn with its reply posted to its chat. Called on a timer
   * and when the budgets change. Returns how many were released.
   */
  releaseBudgetHolds(): number {
    let released = 0
    for (const agentId of this.budgetHolds.agents()) {
      // Per message: a project cap holds only that project's chats.
      const held = this.budgetHolds.take(agentId, (h) => !preflightBudgetGate(agentId, undefined, budgetProjectOf(agentId, h.chatId)))
      if (!held.length) continue
      released += held.length
      this.log(`[${agentId}] budget allows runs again — releasing ${held.length} held message(s)`)
      for (const h of held) {
        const ctx = (h.context as AgentTask["context"]) || { channel: h.channel, chatId: h.chatId }
        this.execute({ message: h.text, agentId, context: ctx, queuedAt: h.heldAt })
          .then((resp) => this.postQueuedResponseToChannel(agentId, ctx, resp))
          .catch((e) => this.log(`[${agentId}] held message failed: ${e?.message ?? e}`))
      }
    }
    if (this.budgetHolds.size === 0 && this.budgetReleaseTimer) {
      clearInterval(this.budgetReleaseTimer)
      this.budgetReleaseTimer = null
    }
    return released
  }

  /** Messages waiting for `agentId` to come back under its budget. */
  heldForBudget(agentId: string): number {
    return this.budgetHolds.count(agentId)
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
    if (resp.errorKind === "cancelled" || resp.errorKind === "interrupted" || resp.errorKind === "stopped") return
    if (isQueued(resp.error)) return
    const text = resp.error
      ? `Error: ${resp.error}`
      : (resp.content || "").trim()
    if (!text) return
    // No adapter to post on: the reply stays on the task and its session.
    // `requests` pick-ups land here, their reply read by the tracker (#1259).
    // A real channel whose adapter failed to start still leaves a log line.
    if (!router.getChannel(channel)) {
      if (!NO_ADAPTER_CHANNELS.has(channel.split("@")[0])) {
        this.log(`[${agentId}] queued response not posted: no adapter for channel "${channel}"`)
      }
      return
    }
    // Resolve account binding for shared-channel adapters (Telegram is
    // multi-account); sendOutbound auto-fills accountId from agentId.
    // The queued turn's answer is the agent's reply in the chat (#1892);
    // an error text is a notice.
    router.sendOutbound({ channel, chatId, text, agentId } as any, { countsAsReply: !resp.error })
      .catch((e: any) => this.log(`[${agentId}] queued response post failed: ${e?.message ?? e}`))
  }

  /** The root a running task works under, when it has one (#1284: an
   *  event the turn emits carries it, so the loop guard holds). */
  runningTaskRoot(taskId: string): string | undefined {
    return this.taskAborts.get(taskId)?.rootId
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
  /** The trace id of a running task of `agentId`, once allocated. */
  runningTraceId(agentId: string, taskId: string): string | null {
    return this.agents.get(agentId)?.runningTasks.find((r) => r.id === taskId)?.traceId ?? null
  }

  findRunningTurn(
    agentId: string,
    by: { taskId?: string; channel?: string; chatId?: string } = {},
  ): { taskId: string; context: NonNullable<AgentTask["context"]>; autonomy?: AgentTask["autonomy"]; workflowRunId?: string } | null {
    const state = this.agents.get(agentId)
    if (!state) return null
    let run: RunningTask | undefined
    if (by.taskId) {
      run = state.runningTasks.find((r) => r.id === by.taskId)
    } else if (by.channel && by.chatId) {
      // Compared as a warm process names it, so a run with no chat is
      // found by the fallback pair its process sends (#410).
      const matches = state.runningTasks.filter((r) => {
        const chat = warmProcessChat(r)
        return chat.channel === by.channel && chat.chatId === by.chatId
      })
      run = matches.length === 1 ? matches[0] : undefined
    }
    if (!run) return null
    const context = this.runningContexts.get(run.id)
    return context ? { taskId: run.id, context, ...(run.autonomy ? { autonomy: run.autonomy } : {}), ...(run.workflow ? { workflowRunId: run.workflow.runId } : {}) } : null
  }

  /** Whether a run is open on this chat on this node, for any agent
   *  (#2104 B3): a move of the chat's issue waits for it to end. */
  runOpenOnChat(chatId: string): boolean {
    for (const s of this.agents.values()) if (s.runningTasks.some((r) => r.chatId === chatId)) return true
    return false
  }

  /** Whether every slot of `agentId` is taken, and by which runs. Lets a
   *  synchronous delegation refuse at once when the only slot is held by
   *  the turn waiting on it (#277), instead of waiting 25 minutes. */
  slotHolders(agentId: string): { full: boolean; runIds: string[] } | null {
    const state = this.agents.get(agentId)
    if (!state) return null
    return { full: this.slotFull(state), runIds: state.runningTasks.map((r) => r.id) }
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
   * Stop signal (#857). Aborts the run like an operator stop, but it ends
   * with status `stopped` and errorKind "stopped" instead of cancelled, so
   * nothing reports it as a failure. False when no live run matches.
   */
  stopRunningTask(taskId: string, reason: string): boolean {
    const entry = this.taskAborts.get(taskId)
    if (!entry || entry.controller.signal.aborted) return false
    this.stoppedRuns.set(taskId, reason)
    try { entry.controller.abort(new Error(reason)) } catch { /* */ }
    this.log(`[${entry.agentId}] task ${taskId} stopped — ${reason}`)
    return true
  }

  /** Resolves once the run `taskId` has let go of its slot (at once when it
   *  is not running), or after `timeoutMs`. */
  whenRunEnds(taskId: string, timeoutMs: number): Promise<void> {
    if (!this.taskAborts.has(taskId)) return Promise.resolve()
    return new Promise((resolveEnd) => {
      const timer = setTimeout(resolveEnd, timeoutMs)
      timer.unref?.()
      const list = this.runEndWaiters.get(taskId) ?? []
      list.push(() => { clearTimeout(timer); resolveEnd() })
      this.runEndWaiters.set(taskId, list)
    })
  }

  /** A running task a stop signal can address: by its id, or the only run
   *  of `agentId` on a chat. Null when none (or several) match. */
  signalTarget(by: { taskId?: string; agentId?: string; channel?: string; chatId?: string }): {
    taskId: string; traceId?: string; agentId: string; channel: string; chatId: string
    sender?: string; rootId?: string; originalMessage: string; origin: RunOrigin | null; workflowRunId?: string
  } | null {
    let id: string | undefined
    if (by.taskId) {
      id = this.taskAborts.has(by.taskId) ? by.taskId : undefined
    } else if (by.agentId && by.channel && by.chatId) {
      const ids = [...this.taskAborts].filter(([, e]) => e.agentId === by.agentId && e.channel === by.channel && e.chatId === by.chatId).map(([k]) => k)
      id = ids.length === 1 ? ids[0] : undefined
    }
    return id ? this.signalTargetOf(id) : null
  }

  /** Every running task, as a stop-all signal addresses them (#1271). */
  signalTargets(): Array<NonNullable<ReturnType<AgentRegistry["signalTarget"]>>> {
    return [...this.taskAborts].filter(([, e]) => !e.controller.signal.aborted).map(([id]) => this.signalTargetOf(id)).filter((t): t is NonNullable<typeof t> => t !== null)
  }

  private signalTargetOf(id: string): ReturnType<AgentRegistry["signalTarget"]> {
    const e = this.taskAborts.get(id)
    if (!e) return null
    return {
      taskId: id, traceId: e.traceId, agentId: e.agentId, channel: e.channel, chatId: e.chatId,
      sender: e.sender, rootId: e.rootId, originalMessage: e.originalMessage, origin: e.origin ?? null,
      ...(e.workflowRunId ? { workflowRunId: e.workflowRunId } : {}),
    }
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
   *  caller disconnects (the phone app's Stop). With `sender`, only the runs
   *  that sender started: AgentX Voice stopping its own turn in a phone
   *  conversation leaves a turn the phone started there alone (#1455).
   *  Returns how many it aborted. */
  cancelChatTasks(agentId: string, channel: string, chatId: string, reason = "operator", sender?: string): number {
    let n = 0
    for (const [taskId, e] of this.taskAborts) {
      if (e.agentId !== agentId || e.channel !== channel || e.chatId !== chatId) continue
      if (sender !== undefined && e.sender !== sender) continue
      if (this.cancelRunningTask(taskId, reason)) n++
    }
    return n
  }

  /** Offer `task` to the run of its agent already going in its chat, when
   *  that run can hear it (claude-code, whose workspace hook reads the
   *  inbox) and the message is a person's or an agent's words. */
  private offerMidTurn(task: AgentTask, state: { def: AgentDef; runningTasks: RunningTask[] }, channel: string, chatId: string): void {
    if (this.config.session?.midTurnMessages === false || task.midTurnId) return
    if (state.def.tier !== "claude-code" || !midTurnChat(channel, chatId)) return
    if (task.preSpawnRetry || task.message.startsWith("[agentx:")) return
    if (!this.messageQueue.isBusy(task.agentId, channel, chatId)) return
    const run = state.runningTasks.find((r) => r.channel === channel && r.chatId === chatId)
    const from = String((task.context as any)?.sender?.name ?? (task.context as any)?.sender ?? "the owner")
    const e = this.midTurn.offer(midTurnKey(task.agentId, channel, chatId), run?.id ?? "-", task.message, from)
    task.midTurnId = e.id
    this.log(`[${task.agentId}] message offered to the running turn ${run?.id ?? "in this chat"} (${e.id}) chat=${channel}:${chatId}`)
  }

  /** The hook's call after a tool call (GET /runs/inbox): messages for the
   *  run going in this chat, marked taken. */
  takeMidTurn(agentId: string, channel: string, chatId: string): MidTurnEntry[] {
    const taken = this.midTurn.take(midTurnKey(agentId, channel, chatId))
    if (taken.length) this.log(`[${agentId}] running turn read ${taken.length} message(s) mid-turn chat=${channel}:${chatId}`)
    return taken
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

    const queuedAt = Date.now()
    this.messageQueue.enqueue(agentId, channel, chatId, {
      text: message,
      sender,
      timestamp: queuedAt,
      channel,
      chatId,
      originalContext: { channel, chatId, sender },
    })
    const pending = this.messageQueue.pendingCount(agentId, channel, chatId)
    // It waits in the same line as a channel message, so the member page
    // counts it among the messages ahead of a teammate's (#443). Sent from
    // the owner's dashboard, it is the owner's; not a human-facing root,
    // so request status leaves it alone.
    getEventBus().emit("task:queued", {
      agentId, channel, chatId, at: new Date(queuedAt).toISOString(),
      sender: { name: sender }, humanRoot: false,
      person: operatorPerson(this.config.people)?.id ?? null,
      messagePreview: message.slice(0, 200), queuedAt,
    })

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
