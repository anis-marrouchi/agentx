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
  const base = slugify(`${trace.agentId}-${trace.messagePreview || trace.taskId}`, `task-${trace.taskId.slice(0, 8).toLowerCase()}`)
  const id = opts.id || `${base}-draft`
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

export function validateWorkflowDraft(workflow: Workflow): string[] {
  const parsed = workflowSchema.safeParse(workflow)
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
  }
  return lintWorkflow(parsed.data)
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

export function loadSuccessfulTraces(
  db: Database.Database,
  opts: { since?: number; agentId?: string; limit?: number } = {},
): TraceRecord[] {
  return listTraces(db, {
    agentId: opts.agentId,
    status: "ok",
    since: opts.since,
    limit: opts.limit ?? 1000,
  }).filter((t) => !t.workflowRunId)
}

function clusterKey(trace: TraceRecord): string {
  const words = (trace.messagePreview || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
    .join("-")
  return [trace.agentId, trace.channel || "unknown", words || "task"].join(":")
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
    .map(([key, grouped]) => ({
      key,
      traces: grouped.sort((a, b) => b.startedAt - a.startedAt),
      confidence: Math.min(0.9, 0.45 + grouped.length * 0.1),
    }))
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
    const workflow = buildWorkflowDraftFromTrace(representative, full?.steps ?? [], {
      id: `${slugify(cluster.key.replace(/:/g, "-"))}-draft`,
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
