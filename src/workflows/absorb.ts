import Database from "better-sqlite3"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { basename, resolve } from "path"
import { getTrace, listTraces, type TraceRecord, type TraceStepRecord } from "@/storage/traces"
import { lintWorkflow, workflowSchema, type Workflow } from "./types"
import { renderWorkflowYaml, parseYamlWorkflow } from "./yaml"

export interface WorkflowDraftCandidate {
  id: string
  workflow: Workflow
  sourceTaskIds: string[]
  confidence: number
  reason: string
}

export interface WorkflowDraftRecord {
  id: string
  path: string
  workflow: Workflow
}

function slugify(input: string, fallback = "workflow"): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52)
  return slug || fallback
}

function cap(input: string | null | undefined, max = 900): string {
  const text = String(input ?? "").trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/** Maps platform-specific noteable kinds to short, stable labels in workflow
 *  ids (so a GitHub PR and a GitLab merge_request both end up as `mr`). */
const KIND_ALIASES: Record<string, string> = {
  merge_request: "mr",
  pull_request: "mr",
  pr: "mr",
  push: "push",
  issue: "issue",
  issues: "issue",
}

const ENV_KEYWORDS: Array<[string, RegExp]> = [
  ["prod", /\b(prod(?:uction)?|live)\b/],
  ["staging", /\b(stag(?:ing|e)?|qa|preprod|pre-prod)\b/],
  ["dev", /\b(dev|development|local)\b/],
]

const INTENT_KEYWORDS: Array<[string, RegExp]> = [
  ["rollback", /\b(rollback|revert|undo)\b/],
  ["deploy", /\b(deploy|deployment|rollout|release|ship)\b/],
  ["fix", /\b(fix|repair|patch|resolve|hotfix)\b/],
  ["migrate", /\b(migration|migrate)\b/],
  ["review", /\b(review|inspect|audit|approve)\b/],
  ["triage", /\b(triage|classify|categorize|label)\b/],
  ["implement", /\b(implement|add|build|create|introduce)\b/],
  ["refactor", /\b(refactor|rename|restructure|cleanup)\b/],
  ["test", /\b(test|verify|validate|qa)\b/],
  ["update", /\b(update|upgrade|bump)\b/],
]

interface InferredName {
  project?: string
  kind?: string
  intent?: string
  environment?: string
  variation?: string
}

/** Pull a workflow name out of a trace. Names should describe the work, not
 *  the worker — so we drop the agent id entirely and lean on the entity
 *  (project + kind from the chatId composite) plus an intent verb mined from
 *  the message. Stable across agents: a GitLab MR triaged by `coder-agent`
 *  and the same MR deployed by `devops-agent` cluster on the same project. */
export function inferWorkflowName(trace: TraceRecord, _steps: TraceStepRecord[] = []): InferredName {
  const out: InferredName = {}

  // Extract project + kind from the chatId composite. Today's known shapes:
  //   GitLab issue:        "<group>/<project>:issue:<iid>"
  //   GitLab merge_request:"<group>/<project>:merge_request:<iid>"
  //   GitHub push:         "<owner>/<repo>:push:refs/heads/<branch>"
  //   GitHub PR:           "<owner>/<repo>:pull_request:<n>"
  //   Telegram numeric:    "<chat-id>" (no colons → no project mining)
  const chatId = trace.chatId || ""
  const parts = chatId.split(":")
  if (parts.length >= 2 && parts[0].includes("/")) {
    const repoSlug = parts[0]
    const repoName = repoSlug.split("/").pop() || repoSlug
    out.project = slugify(repoName, "project")
    out.kind = slugify(KIND_ALIASES[parts[1]] || parts[1], "task")
  }

  // Mine the message for verbs / environment, but ONLY when project+kind didn't
  // already give us strong identity. For notification-style events (GitHub
  // push, GitLab MR) the work IS the kind — looking for verbs in commit
  // messages or MR descriptions splits a coherent workflow into accidental
  // sub-clusters (`agentx-push-implement` vs `agentx-push-draft`). When we
  // have a project+kind, only environment is still useful (one project may
  // have separate staging vs prod procedures).
  const msg = String(trace.messagePreview || "").toLowerCase()
  const hasStrongIdentity = Boolean(out.project && out.kind)
  if (!hasStrongIdentity) {
    for (const [verb, pattern] of INTENT_KEYWORDS) {
      if (pattern.test(msg)) { out.intent = verb; break }
    }
  }
  for (const [env, pattern] of ENV_KEYWORDS) {
    if (pattern.test(msg)) { out.environment = env; break }
  }

  return out
}

/** Build a workflow id from inferred parts. Falls back to a hash of the
 *  message when nothing structured can be extracted (telegram one-offs). */
function buildWorkflowId(name: InferredName, trace: TraceRecord): string {
  const parts = [name.project, name.kind, name.intent, name.environment, name.variation].filter(Boolean)
  if (parts.length >= 2) return parts.map((p) => slugify(p as string)).join("-") + "-draft"
  // Fallback: short slug of the message + taskId tail to disambiguate.
  const msgSlug = slugify(trace.messagePreview || "", "task").slice(0, 32)
  const tail = trace.taskId.slice(-6).toLowerCase()
  return `${msgSlug || "task"}-${tail}-draft`
}

function traceTags(trace: TraceRecord, steps: TraceStepRecord[] = []): string[] {
  const tags = new Set<string>()
  if (trace.channel) tags.add(trace.channel)
  if (trace.agentId) tags.add(trace.agentId)
  for (const s of steps) {
    if (s.action) tags.add(slugify(s.action, "action"))
  }
  return Array.from(tags).slice(0, 12)
}

function summarizeSteps(steps: TraceStepRecord[]): string {
  const useful = steps
    .filter((s) => s.status !== "error")
    .filter((s) => s.name !== "system")
    .slice(0, 16)
  if (useful.length === 0) return "No structured steps were captured; use the original message and final result as the procedure evidence."
  return useful.map((s, idx) => {
    const label = [s.name, s.action].filter(Boolean).join(":")
    const out = cap(s.outputSummary || s.inputSummary || s.error || "", 220)
    return `${idx + 1}. ${label}${out ? ` — ${out}` : ""}`
  }).join("\n")
}

export function buildWorkflowDraftFromTrace(
  trace: TraceRecord,
  steps: TraceStepRecord[] = [],
  opts: {
    id?: string
    sourceTaskIds?: string[]
    confidence?: number
    generatedFrom?: string
  } = {},
): Workflow {
  const inferred = inferWorkflowName(trace, steps)
  const id = opts.id || buildWorkflowId(inferred, trace)
  const sourceTaskIds = opts.sourceTaskIds?.length ? opts.sourceTaskIds : [trace.taskId]
  const titleSeed = cap(trace.messagePreview, 72) || `Task ${trace.taskId.slice(0, 8)}`
  const prompt = [
    "Replay the cleaned successful procedure represented by this absorbed task trace.",
    "",
    "Original task:",
    `{{trigger.input.message}}`,
    "",
    "Procedure evidence, with failed turns and incidental retries removed where possible:",
    summarizeSteps(steps),
    "",
    "Use the current run input values where provided. Keep the final answer concise and operational.",
  ].join("\n")

  return workflowSchema.parse({
    id,
    version: 2,
    title: `Draft: ${titleSeed}`,
    description: `Generated from task trace ${trace.taskId}. Review before promotion.`,
    status: "draft",
    state: "disabled",
    tags: traceTags(trace, steps),
    entity: trace.chatId || undefined,
    generatedFrom: opts.generatedFrom ?? "task-trace",
    sourceTaskIds,
    confidence: opts.confidence ?? 0.55,
    workflowVersion: "draft-1",
    ownerAgent: trace.agentId,
    nodes: [
      {
        id: "trigger",
        type: "trigger.manual",
        config: {
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
              taskId: { type: "string" },
            },
          },
        },
      },
      {
        id: "run_cleaned_task",
        type: "agent",
        config: {
          agentId: trace.agentId,
          prompt,
        },
      },
      {
        id: "done",
        type: "end",
        config: {
          status: "completed",
          output: "{{run_cleaned_task.reply}}",
        },
      },
    ],
    edges: [
      { from: "trigger", to: "run_cleaned_task" },
      { from: "run_cleaned_task", to: "done" },
    ],
    envAllow: [],
    retention: { maxRuns: 500, maxDays: 90 },
    maxChildDepth: 5,
  })
}

/** Async wrapper around buildWorkflowDraftFromTrace. Two architect backends:
 *  - `opts.model`: direct Anthropic API (needs ANTHROPIC_API_KEY)
 *  - `opts.viaAgent`: route through the agent registry (uses the agent's own
 *    Claude Code / Codex session — no raw API key needed, mirrors the wiki
 *    cron pattern). Trade-off: slower (~5-10s) but operationally simpler.
 *
 *  If both are set, `viaAgent` wins. Falls back to the deterministic
 *  single-agent-node draft on any architect failure. The fallback is silent
 *  in the return value but emitted to `opts.log`. */
export async function architectOrBuildDraft(
  trace: TraceRecord,
  steps: TraceStepRecord[] = [],
  opts: {
    id?: string
    sourceTaskIds?: string[]
    confidence?: number
    generatedFrom?: string
    model?: string
    viaAgent?: string
    daemonUrl?: string
    log?: (msg: string) => void
  } = {},
): Promise<{ workflow: Workflow; usedLlm: boolean; via?: string; error?: string }> {
  const inferred = inferWorkflowName(trace, steps)
  const id = opts.id || buildWorkflowId(inferred, trace)
  const sourceTaskIds = opts.sourceTaskIds?.length ? opts.sourceTaskIds : [trace.taskId]
  const confidence = opts.confidence ?? 0.55
  if (opts.viaAgent) {
    try {
      const { architectWorkflowViaAgent } = await import("./architect")
      const result = await architectWorkflowViaAgent(trace, steps, id, sourceTaskIds, confidence, {
        agentId: opts.viaAgent,
        daemonUrl: opts.daemonUrl,
      })
      return { workflow: result.workflow, usedLlm: true, via: result.via }
    } catch (e: any) {
      const msg = e?.message || String(e)
      opts.log?.(`[architect] agent path (${opts.viaAgent}) failed for ${trace.taskId.slice(0, 8)}, falling back to deterministic: ${msg}`)
      return {
        workflow: buildWorkflowDraftFromTrace(trace, steps, opts),
        usedLlm: false,
        error: msg,
      }
    }
  }
  if (opts.model) {
    try {
      const { architectWorkflowFromTrace } = await import("./architect")
      const result = await architectWorkflowFromTrace(trace, steps, id, sourceTaskIds, confidence, { model: opts.model })
      return { workflow: result.workflow, usedLlm: true, via: `direct:${result.model}` }
    } catch (e: any) {
      const msg = e?.message || String(e)
      opts.log?.(`[architect] direct API failed for ${trace.taskId.slice(0, 8)}, falling back to deterministic: ${msg}`)
      return {
        workflow: buildWorkflowDraftFromTrace(trace, steps, opts),
        usedLlm: false,
        error: msg,
      }
    }
  }
  return { workflow: buildWorkflowDraftFromTrace(trace, steps, opts), usedLlm: false }
}

export function validateWorkflowDraft(workflow: Workflow): string[] {
  const parsed = workflowSchema.safeParse(workflow)
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
  }
  return lintWorkflow(parsed.data)
}

/** Node types that count as "real work" — i.e. not just routing or
 *  signalling. A draft made entirely of trigger + end (or trigger +
 *  checkpoint + end) is not actionable; it's noise from absorbing a
 *  notification trace that had no procedure to capture. */
const MEANINGFUL_NODE_TYPES = new Set<string>([
  "agent", "action.run", "action.send", "action.builtin", "action.callHTTP",
  "action.createIssue", "action.setLabel", "action.readLabel", "action.react",
  "action.editMessage", "action.logTime",
  "transform", "extract.structured",
  "branch", "rule",
  "userTask", "subProcess",
])

/** True if a draft captures an actual procedure worth keeping. Rejects
 *  trigger→end and trigger→checkpoint→end shapes which usually come from
 *  notification-only traces (e.g. GitHub push events with no follow-up
 *  agent action). Operators can still hand-write workflows that are
 *  legitimately minimal — this only gates the auto-absorb path. */
export function isMeaningfulDraft(workflow: Workflow): boolean {
  const work = workflow.nodes.filter((n) => MEANINGFUL_NODE_TYPES.has(n.type))
  return work.length > 0 && workflow.nodes.length >= 3
}

export function draftsDir(baseDir = process.cwd()): string {
  return resolve(baseDir, ".agentx/workflows/_drafts")
}

export function draftsDirForWorkflowDir(workflowDir: string): string {
  return resolve(workflowDir, "_drafts")
}

export function rejectedDraftsDir(baseDir = process.cwd()): string {
  return resolve(baseDir, ".agentx/workflows/_drafts/_rejected")
}

export function rejectedDraftsDirForWorkflowDir(workflowDir: string): string {
  return resolve(draftsDirForWorkflowDir(workflowDir), "_rejected")
}

export function draftPath(id: string, format: "yaml" | "json" = "yaml", baseDir = process.cwd()): string {
  return resolve(draftsDir(baseDir), `${id}.${format}`)
}

export function draftPathForWorkflowDir(id: string, workflowDir: string, format: "yaml" | "json" = "yaml"): string {
  return resolve(draftsDirForWorkflowDir(workflowDir), `${id}.${format}`)
}

export function writeWorkflowDraft(
  workflow: Workflow,
  opts: { format?: "yaml" | "json"; baseDir?: string; workflowDir?: string; force?: boolean } = {},
): string {
  const format = opts.format ?? "yaml"
  const dir = opts.workflowDir ? draftsDirForWorkflowDir(opts.workflowDir) : draftsDir(opts.baseDir)
  mkdirSync(dir, { recursive: true })
  const path = opts.workflowDir
    ? draftPathForWorkflowDir(workflow.id, opts.workflowDir, format)
    : draftPath(workflow.id, format, opts.baseDir)
  if (!opts.force && existsSync(path)) throw new Error(`draft already exists: ${path}`)
  const text = format === "json" ? JSON.stringify(workflow, null, 2) + "\n" : renderWorkflowYaml(workflow)
  writeFileSync(path, text)
  return path
}

function readWorkflowFile(path: string): Workflow {
  const text = readFileSync(path, "utf-8")
  const raw = /\.(ya?ml)$/i.test(path) ? parseYamlWorkflow(text, { filePath: basename(path) }) : JSON.parse(text)
  return workflowSchema.parse(raw)
}

export function listWorkflowDrafts(baseDir = process.cwd(), opts: { workflowDir?: string } = {}): WorkflowDraftRecord[] {
  const dir = opts.workflowDir ? draftsDirForWorkflowDir(opts.workflowDir) : draftsDir(baseDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(json|ya?ml)$/i.test(e.name))
    .map((e) => {
      const path = resolve(dir, e.name)
      return { id: e.name.replace(/\.(json|ya?ml)$/i, ""), path, workflow: readWorkflowFile(path) }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function getWorkflowDraft(id: string, baseDir = process.cwd(), opts: { workflowDir?: string } = {}): WorkflowDraftRecord | null {
  const dir = opts.workflowDir ? draftsDirForWorkflowDir(opts.workflowDir) : draftsDir(baseDir)
  for (const ext of ["yaml", "yml", "json"]) {
    const path = resolve(dir, `${id}.${ext}`)
    if (existsSync(path)) return { id, path, workflow: readWorkflowFile(path) }
  }
  return null
}

export function promoteWorkflowDraft(
  id: string,
  opts: { baseDir?: string; workflowDir?: string; replace?: boolean; format?: "yaml" | "json" } = {},
): { workflow: Workflow; from: string; to: string } {
  const draft = getWorkflowDraft(id, opts.baseDir, { workflowDir: opts.workflowDir })
  if (!draft) throw new Error(`draft not found: ${id}`)
  const format = opts.format ?? (draft.path.endsWith(".json") ? "json" : "yaml")
  const workflow = workflowSchema.parse({
    ...draft.workflow,
    status: "active",
    state: "active",
    updated: new Date().toISOString().slice(0, 10),
  })
  const issues = validateWorkflowDraft(workflow)
  if (issues.length) throw new Error(`draft is invalid: ${issues.join("; ")}`)
  const workflowsDir = opts.workflowDir ?? resolve(opts.baseDir ?? process.cwd(), ".agentx/workflows")
  const dest = resolve(workflowsDir, `${workflow.id}.${format}`)
  if (!opts.replace && existsSync(dest)) throw new Error(`workflow already exists: ${dest}`)
  mkdirSync(workflowsDir, { recursive: true })
  writeFileSync(dest, format === "json" ? JSON.stringify(workflow, null, 2) + "\n" : renderWorkflowYaml(workflow))
  unlinkSync(draft.path)
  return { workflow, from: draft.path, to: dest }
}

export function rejectWorkflowDraft(id: string, baseDir = process.cwd(), opts: { workflowDir?: string } = {}): string {
  const draft = getWorkflowDraft(id, baseDir, { workflowDir: opts.workflowDir })
  if (!draft) throw new Error(`draft not found: ${id}`)
  const dir = opts.workflowDir ? rejectedDraftsDirForWorkflowDir(opts.workflowDir) : rejectedDraftsDir(baseDir)
  mkdirSync(dir, { recursive: true })
  const dest = resolve(dir, `${Date.now().toString(36)}-${basename(draft.path)}`)
  renameSync(draft.path, dest)
  return dest
}

/** Default minimum chars on `messagePreview` for a trace to be eligible for
 *  workflow absorb. Filters out trivial chatter ("yes", "ok", short Q&A)
 *  that produces low-value drafts. Operators can override with --min-message-length. */
export const DEFAULT_MIN_MESSAGE_LENGTH = 30

export function loadSuccessfulTraces(
  db: Database.Database,
  opts: { since?: number; agentId?: string; limit?: number; minMessageLength?: number } = {},
): TraceRecord[] {
  const min = opts.minMessageLength ?? DEFAULT_MIN_MESSAGE_LENGTH
  return listTraces(db, {
    agentId: opts.agentId,
    status: "ok",
    since: opts.since,
    limit: opts.limit ?? 1000,
  })
    .filter((t) => !t.workflowRunId)
    .filter((t) => (t.messagePreview || "").trim().length >= min)
    // Drop architect-self-recursion: the LLM architect dispatches via
    // /task with chatId="architect-<taskId>"; those tasks are recorded
    // as their own traces and would re-cluster as "workflow architect"
    // drafts on the next absorb run. Skip anything in that namespace.
    .filter((t) => !(t.chatId || "").startsWith("architect-"))
}

/** Cluster key — describes WHAT the work is, not WHO did it. We deliberately
 *  drop the agentId so a procedure run by `coder-agent` and the same procedure
 *  later run by `devops-agent` cluster together. Falls back to message words
 *  when no project/kind/intent can be mined. */
function clusterKey(trace: TraceRecord): string {
  const inferred = inferWorkflowName(trace)
  if (inferred.project && inferred.kind) {
    const segs = [inferred.project, inferred.kind, inferred.intent, inferred.environment].filter(Boolean)
    return segs.join(":")
  }
  const words = (trace.messagePreview || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
    .join("-")
  return [trace.channel || "unknown", words || "task"].join(":")
}

export function clusterWorkflowCandidates(
  traces: TraceRecord[],
  opts: { minClusterSize?: number; max?: number } = {},
): Array<{ key: string; traces: TraceRecord[]; confidence: number }> {
  const groups = new Map<string, TraceRecord[]>()
  for (const trace of traces) {
    const key = clusterKey(trace)
    const list = groups.get(key) ?? []
    list.push(trace)
    groups.set(key, list)
  }
  const min = Math.max(1, opts.minClusterSize ?? 3)
  return Array.from(groups.entries())
    .map(([key, grouped]) => {
      // Confidence boosts for clusters with a real project+kind+intent
      // (vs. message-word fallbacks). A "mtgl-mr-deploy" cluster of 3 traces
      // is more reusable than a 3-trace "telegram-yes-task" cluster.
      const inferred = inferWorkflowName(grouped[0])
      const namingBoost =
        (inferred.project ? 0.05 : 0) +
        (inferred.kind ? 0.05 : 0) +
        (inferred.intent ? 0.1 : 0) +
        (inferred.environment ? 0.05 : 0)
      const sizeScore = 0.45 + grouped.length * 0.1
      return {
        key,
        traces: grouped.sort((a, b) => b.startedAt - a.startedAt),
        confidence: Math.min(0.95, sizeScore + namingBoost),
      }
    })
    .filter((c) => c.traces.length >= min)
    .sort((a, b) => b.confidence - a.confidence || b.traces.length - a.traces.length)
    .slice(0, Math.max(1, opts.max ?? 10))
}

export function buildDraftsFromClusters(
  db: Database.Database,
  clusters: Array<{ key: string; traces: TraceRecord[]; confidence: number }>,
): WorkflowDraftCandidate[] {
  const out: WorkflowDraftCandidate[] = []
  for (const cluster of clusters) {
    const representative = cluster.traces[0]
    const full = getTrace(db, representative.taskId)
    const sourceTaskIds = cluster.traces.map((t) => t.taskId)
    // Don't pass an explicit id here — buildWorkflowDraftFromTrace runs
    // inferWorkflowName() against the representative trace and gets a clean
    // <project>-<kind>-<intent>[-<env>] name. Falling back to slugifying the
    // cluster key would just re-introduce the problem we're solving.
    const workflow = buildWorkflowDraftFromTrace(representative, full?.steps ?? [], {
      sourceTaskIds,
      confidence: cluster.confidence,
      generatedFrom: "workflow-absorb",
    })
    out.push({
      id: workflow.id,
      workflow,
      sourceTaskIds,
      confidence: cluster.confidence,
      reason: `${cluster.traces.length} similar successful task traces`,
    })
  }
  return out
}

/** Async clusters → drafts pipeline with optional LLM architect. Pass
 *  `opts.viaAgent` to route through an agent (preferred — no raw API key)
 *  or `opts.model` for the direct Anthropic API path. Either way the
 *  deterministic fallback runs on any failure so the cron never hard-fails. */
export async function buildDraftsFromClustersAsync(
  db: Database.Database,
  clusters: Array<{ key: string; traces: TraceRecord[]; confidence: number }>,
  opts: { model?: string; viaAgent?: string; daemonUrl?: string; log?: (msg: string) => void } = {},
): Promise<Array<WorkflowDraftCandidate & { usedLlm: boolean; via?: string }>> {
  const out: Array<WorkflowDraftCandidate & { usedLlm: boolean; via?: string }> = []
  for (const cluster of clusters) {
    const representative = cluster.traces[0]
    const full = getTrace(db, representative.taskId)
    const sourceTaskIds = cluster.traces.map((t) => t.taskId)
    const result = await architectOrBuildDraft(representative, full?.steps ?? [], {
      sourceTaskIds,
      confidence: cluster.confidence,
      generatedFrom: opts.viaAgent || opts.model ? "llm-architect" : "workflow-absorb",
      model: opts.model,
      viaAgent: opts.viaAgent,
      daemonUrl: opts.daemonUrl,
      log: opts.log,
    })
    out.push({
      id: result.workflow.id,
      workflow: result.workflow,
      sourceTaskIds,
      confidence: cluster.confidence,
      reason: `${cluster.traces.length} similar successful task traces${result.usedLlm ? ` (LLM-architected via ${result.via})` : ""}`,
      usedLlm: result.usedLlm,
      via: result.via,
    })
  }
  return out
}
