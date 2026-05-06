import { Command } from "commander"
import chalk from "chalk"
import { resolve, basename } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import Database from "better-sqlite3"
import { RunStore, WorkflowStore, lintWorkflow, workflowSchema, parseYamlWorkflow, renderWorkflowYaml, WorkflowYamlError } from "@/workflows"
import { TEMPLATES, readTemplate, type TemplateName } from "@/workflows/templates"
import { getTrace } from "@/storage/traces"
import {
  buildDraftsFromClusters,
  buildWorkflowDraftFromTrace,
  clusterWorkflowCandidates,
  getWorkflowDraft,
  listWorkflowDrafts,
  loadSuccessfulTraces,
  promoteWorkflowDraft,
  rejectWorkflowDraft,
  validateWorkflowDraft,
  writeWorkflowDraft,
} from "@/workflows/absorb"

// --- agentx workflow — declarative state machines for channel events ---
//
// v1: list / show / validate / run-manual / runs / pause / resume / cancel
// The engine itself runs inside the daemon; this CLI is the author tooling
// (inspect YAML, validate, poke manual triggers, read run history).

export const workflow = new Command()
  .name("workflow")
  .description("workflow definitions — list, show, validate, manage runs")

function durationToMs(input: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(input.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]
  return n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3600_000 : 86_400_000)
}

function parseSince(input: string | undefined): number | undefined {
  if (!input) return undefined
  const ms = durationToMs(input)
  if (ms === null) {
    const n = Number(input)
    if (Number.isFinite(n) && n > 0) return n
    console.log(chalk.red(`  Invalid --since "${input}". Use "1h", "30m", "7d", or an ms epoch.`))
    process.exit(1)
  }
  return Date.now() - ms
}

function openTraceDb(path = ".agentx/db.sqlite"): Database.Database {
  const dbPath = resolve(process.cwd(), path)
  if (!existsSync(dbPath)) {
    console.log(chalk.red(`  No db at ${dbPath}`))
    process.exit(1)
  }
  return new Database(dbPath, { readonly: true })
}

function printWorkflowDraft(workflow: unknown, format: "yaml" | "json"): void {
  if (format === "json") console.log(JSON.stringify(workflow, null, 2))
  else console.log(renderWorkflowYaml(workflow))
}

function traceSummary(records: any[]): { durationMs: number; totalTokens: number; models: string[]; status: string; result: string } {
  const models = Array.from(new Set(records.map((r) => r.model).filter(Boolean).map(String)))
  const durationMs = records.reduce((sum, r) => sum + (Number(r.durationMs) || 0), 0)
  const totalTokens = records.reduce((sum, r) => sum + (Number(r.totalTokens) || 0), 0)
  const last = records.at(-1)
  return {
    durationMs,
    totalTokens,
    models,
    status: records.some((r) => r.status === "error") ? "error" : (last?.status || "ok"),
    result: String(last?.outputSummary || last?.error || "").slice(0, 160),
  }
}

function printReplayComparison(original: ReturnType<typeof traceSummary>, replay: ReturnType<typeof traceSummary>): void {
  const deltaMs = replay.durationMs - original.durationMs
  const deltaTokens = replay.totalTokens - original.totalTokens
  console.log()
  console.log(chalk.bold("  replay comparison"))
  console.log(`    original: ${original.status}  ${original.totalTokens || 0}t  ${original.durationMs || 0}ms  model=${original.models.join(",") || "—"}`)
  console.log(`    replay:   ${replay.status}  ${replay.totalTokens || 0}t  ${replay.durationMs || 0}ms  model=${replay.models.join(",") || "—"}`)
  console.log(`    delta:    ${deltaTokens >= 0 ? "+" : ""}${deltaTokens}t  ${deltaMs >= 0 ? "+" : ""}${deltaMs}ms`)
  if (replay.result) console.log(`    result:   ${replay.result}`)
}

workflow
  .command("list")
  .description("list all workflows with their trigger + state count")
  .action(() => {
    const store = new WorkflowStore()
    const items = store.list()
    if (!items.length) {
      console.log(chalk.dim("  no workflows yet. Add one by writing .agentx/workflows/<id>.json"))
      return
    }
    console.log()
    for (const wf of items) {
      const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
      const cfg = (trigger?.config ?? {}) as { source?: string; filter?: { project?: string; repo?: string; chat?: string } }
      const filterParts = [cfg.filter?.project, cfg.filter?.repo, cfg.filter?.chat].filter(Boolean).join(" / ")
      console.log(`  ${chalk.cyan(wf.id)}  ${chalk.bold(wf.title)} ${chalk.dim(`v${wf.version} state=${wf.state} status=${wf.status}`)}`)
      console.log(`    ${chalk.dim("trigger:")} ${cfg.source ?? "?"}${filterParts ? `  ${chalk.dim(filterParts)}` : ""}`)
      console.log(`    ${chalk.dim("nodes:  ")} ${wf.nodes.length} (${wf.nodes.map((n) => n.type).join(", ")})`)
    }
    console.log()
    console.log(chalk.dim(`  ${items.length} workflow${items.length === 1 ? "" : "s"}.`))
  })

workflow
  .command("show <id>")
  .description("show a single workflow's full definition")
  .option("--format <fmt>", "output format: json (default) or yaml", "json")
  .action((id: string, opts: { format: string }) => {
    const store = new WorkflowStore()
    const wf = store.get(id)
    if (!wf) {
      console.log(chalk.yellow(`  no workflow matches "${id}". Try: agentx workflow list`))
      process.exit(1)
    }
    const fmt = opts.format.toLowerCase()
    if (fmt === "yaml" || fmt === "yml") {
      // Render the canonical (post-desugar) shape, not the original
      // YAML source — `flow:` sugar is a one-way authoring affordance,
      // not a round-trip format. The output validates clean when
      // copied back to a new file.
      console.log(renderWorkflowYaml(wf))
    } else if (fmt === "json") {
      console.log(JSON.stringify(wf, null, 2))
    } else {
      console.log(chalk.red(`  unknown format "${opts.format}" — use json or yaml`))
      process.exit(1)
    }
  })

workflow
  .command("validate [file]")
  .description("validate all workflows in .agentx/workflows (or a single file)")
  .action((file?: string) => {
    if (file) {
      const path = resolve(process.cwd(), file)
      if (!existsSync(path)) {
        console.log(chalk.red(`  file not found: ${path}`))
        process.exit(1)
      }
      try {
        const text = readFileSync(path, "utf-8")
        const isYaml = /\.(ya?ml)$/i.test(file)
        // YAML files run through the desugar pass before Zod sees them.
        // JSON keeps its existing JSON.parse path.
        const raw = isYaml ? parseYamlWorkflow(text, { filePath: file }) : JSON.parse(text)
        const parsed = workflowSchema.safeParse(raw)
        if (!parsed.success) {
          console.log(chalk.red(`  ✗ ${path}`))
          for (const i of parsed.error.issues) console.log(`    ${i.path.join(".") || "<root>"}: ${i.message}`)
          process.exit(1)
        }
        const lintIssues = lintWorkflow(parsed.data)
        if (lintIssues.length) {
          console.log(chalk.yellow(`  ! ${path} (lint)`))
          for (const l of lintIssues) console.log(`    ${l}`)
          process.exit(1)
        }
        console.log(chalk.green(`  ✓ ${parsed.data.id} — valid`))
      } catch (e: any) {
        // WorkflowYamlError already carries a friendly message with the
        // file path + line/col when js-yaml provided it; print as-is.
        const msg = e instanceof WorkflowYamlError ? e.message : `parse error: ${e?.message ?? e}`
        console.log(chalk.red(`  ${msg}`))
        process.exit(1)
      }
      return
    }
    const store = new WorkflowStore()
    const results = store.validateAll()
    let ok = 0
    let bad = 0
    for (const r of results) {
      if (r.isValid) {
        console.log(chalk.green(`  ✓ ${(r as any).workflow.id}`))
        ok++
      } else {
        const id = (r as any).workflow?.id || (r as any).id
        console.log(chalk.red(`  ✗ ${id}`))
        for (const issue of r.issues) console.log(`    ${issue}`)
        bad++
      }
    }
    console.log()
    console.log(chalk.dim(`  ${ok} valid, ${bad} invalid.`))
    if (bad > 0) process.exit(1)
  })

workflow
  .command("init <id>")
  .description("scaffold a new workflow YAML from a template (linear by default)")
  .option("--template <name>", `which template to use (${TEMPLATES.map((t) => t.name).join(" | ")})`, "linear")
  .option("--agent <id>", "fill the agent placeholder with this agent id", "default")
  .option("--reviewer <id>", "fill the reviewer placeholder for human-in-the-loop templates", "alice")
  .option("--title <text>", "workflow title", "")
  .option("--json", "scaffold as .json instead of .yaml", false)
  .option("--force", "overwrite an existing workflow with the same id", false)
  .action((id: string, opts) => {
    const tmplName = String(opts.template || "linear") as TemplateName
    if (!TEMPLATES.some((t) => t.name === tmplName)) {
      console.log(chalk.red(`  unknown template "${opts.template}"`))
      console.log(chalk.dim(`  available: ${TEMPLATES.map((t) => t.name).join(", ")}`))
      process.exit(1)
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      console.log(chalk.red(`  workflow id must be lower-kebab (got "${id}")`))
      process.exit(1)
    }
    const store = new WorkflowStore()
    if (!opts.force && store.get(id)) {
      console.log(chalk.red(`  workflow "${id}" already exists. Use --force to overwrite or pick a new id.`))
      process.exit(1)
    }

    let body = readTemplate(tmplName)
    body = body
      .replace(/__ID__/g, id)
      .replace(/__TITLE__/g, opts.title ? String(opts.title) : `${tmplName} workflow ${id}`)
      .replace(/__AGENT__/g, String(opts.agent))
      .replace(/__REVIEWER__/g, String(opts.reviewer))

    // Validate the substituted text before writing — catches placeholder
    // typos and template drift before the operator opens it. Note: the
    // template may reference an agent that doesn't exist on this
    // install; lint flags unreachable nodes etc., not agent-existence,
    // so a "valid" workflow can still need editing before it runs.
    try {
      const raw = parseYamlWorkflow(body, { filePath: `${id}.yaml` })
      const parsed = workflowSchema.safeParse(raw)
      if (!parsed.success) {
        console.log(chalk.red(`  template "${tmplName}" failed schema validation after substitution:`))
        for (const i of parsed.error.issues) console.log(`    ${i.path.join(".") || "<root>"}: ${i.message}`)
        process.exit(1)
      }
    } catch (e: any) {
      console.log(chalk.red(`  template parse failed: ${e?.message ?? e}`))
      process.exit(1)
    }

    const ext = opts.json ? "json" : "yaml"
    const dest = resolve(process.cwd(), ".agentx/workflows", `${id}.${ext}`)
    if (opts.json) {
      // Round-trip through Zod so the JSON is canonical (sorted keys
      // become deterministic; stripped sugar; defaults filled).
      const raw = parseYamlWorkflow(body, { filePath: `${id}.yaml` })
      const parsed = workflowSchema.parse(raw)
      writeFileSync(dest, JSON.stringify(parsed, null, 2) + "\n")
    } else {
      writeFileSync(dest, body)
    }

    console.log()
    console.log(chalk.green(`  ✓ scaffolded ${dest}`))
    console.log(chalk.dim(`    template: ${tmplName}`))
    console.log()
    console.log(chalk.dim("  Next:"))
    console.log(chalk.dim(`    1. edit ${dest}`))
    console.log(chalk.dim(`    2. agentx workflow validate ${dest}`))
    console.log(chalk.dim(`    3. agentx workflow run ${id} --watch`))
    console.log()
  })

workflow
  .command("templates")
  .description("list the available workflow templates for `init`")
  .action(() => {
    console.log()
    for (const t of TEMPLATES) {
      console.log(`  ${chalk.cyan(t.name.padEnd(20))} ${chalk.bold(t.title)}`)
      console.log(`  ${" ".repeat(20)} ${chalk.dim(t.description)}`)
    }
    console.log()
    console.log(chalk.dim(`  Use: agentx workflow init <id> --template <name>`))
    console.log()
  })

workflow
  .command("add <file>")
  .description("import a YAML/JSON workflow file into .agentx/workflows and hot-reload")
  .option("--daemon <url>", "daemon API base URL", "http://127.0.0.1:18800")
  .option("--no-reload", "skip the POST /reload after writing")
  .action(async (file: string, opts) => {
    const path = resolve(process.cwd(), file)
    if (!existsSync(path)) {
      console.log(chalk.red(`  file not found: ${path}`))
      process.exit(1)
    }
    const text = readFileSync(path, "utf-8")
    const isYaml = /\.(ya?ml)$/i.test(file)
    let raw: unknown
    try {
      raw = isYaml ? parseYamlWorkflow(text, { filePath: file }) : JSON.parse(text)
    } catch (e: any) {
      const msg = e instanceof WorkflowYamlError ? e.message : `parse error: ${e?.message ?? e}`
      console.log(chalk.red(`  ${msg}`))
      process.exit(1)
    }
    const parsed = workflowSchema.safeParse(raw)
    if (!parsed.success) {
      console.log(chalk.red(`  ✗ schema:`))
      for (const i of parsed.error.issues) console.log(`    ${i.path.join(".") || "<root>"}: ${i.message}`)
      process.exit(1)
    }
    const lintIssues = lintWorkflow(parsed.data)
    if (lintIssues.length) {
      console.log(chalk.red(`  ✗ lint:`))
      for (const l of lintIssues) console.log(`    ${l}`)
      process.exit(1)
    }

    const store = new WorkflowStore()
    const ext = isYaml ? (basename(file).match(/\.yml$/i) ? "yml" : "yaml") : "json"
    const dest = resolve(store.baseDir, `${parsed.data.id}.${ext}`)
    writeFileSync(dest, isYaml ? text : JSON.stringify(parsed.data, null, 2) + "\n")
    console.log(chalk.green(`  ✓ ${parsed.data.id} → ${dest}`))

    if (opts.reload === false) {
      console.log(chalk.dim(`  --no-reload: skipped daemon hot-reload; restart manually if running.`))
      return
    }
    const url = `${String(opts.daemon).replace(/\/$/, "")}/reload`
    try {
      const res = await fetch(url, { method: "POST" })
      if (res.ok) {
        console.log(chalk.dim(`  ✓ daemon reloaded`))
      } else {
        console.log(chalk.dim(`  daemon /reload returned ${res.status} — restart manually if needed`))
      }
    } catch {
      console.log(chalk.dim(`  daemon not reachable at ${opts.daemon} — start it or restart to pick up the new workflow`))
    }
  })

workflow
  .command("runs [id]")
  .description("list recent runs (optionally filtered to a single workflow)")
  .option("--limit <n>", "max runs to show", "20")
  .option("--node <id>", "home-node id for this daemon (defaults to WF_NODE_ID env or \"local\")")
  .action((id: string | undefined, opts) => {
    const nodeId = opts.node || process.env.WF_NODE_ID || "local"
    const runs = new RunStore({ nodeId }).list({ workflowId: id, limit: Number(opts.limit) })
    if (!runs.length) {
      console.log(chalk.dim(`  no runs yet${id ? ` for "${id}"` : ""}.`))
      return
    }
    console.log()
    for (const r of runs) {
      const last = r.history.at(-1)
      const nextLabel = r.pending[0] ?? (r.status === "completed" ? "∅" : "—")
      const stateColor = r.status === "running" ? chalk.cyan : r.status === "failed" ? chalk.red : chalk.green
      console.log(`  ${chalk.dim(r.id.slice(0, 8))}  ${chalk.bold(r.workflowId)}  ${stateColor(nextLabel)}  ${chalk.dim(r.status)}`)
      console.log(`    ${chalk.dim("entity:  ")} ${r.entityRef.backend}:${r.entityRef.id}`)
      console.log(`    ${chalk.dim("home:    ")} ${r.homeNode}`)
      console.log(`    ${chalk.dim("updated: ")} ${r.updatedAt}`)
      if (last) console.log(`    ${chalk.dim("last:    ")} ${last.nodeId}  (${last.status})`)
    }
    console.log()
    console.log(chalk.dim(`  ${runs.length} run${runs.length === 1 ? "" : "s"}.`))
  })

workflow
  .command("draft-from-task <taskId>")
  .description("generate a reviewable workflow draft from a successful task trace")
  .option("--path <path>", "SQLite db path", ".agentx/db.sqlite")
  .option("--format <fmt>", "yaml (default) or json", "yaml")
  .option("--commit", "write to .agentx/workflows/_drafts", false)
  .option("--print", "print the generated draft", false)
  .option("--allow-failed", "allow generating from non-ok traces", false)
  .option("--model <model>", "reserved for LLM-backed extraction; v1 uses deterministic extraction")
  .action((taskId: string, opts) => {
    const db = openTraceDb(opts.path)
    const trace = getTrace(db, taskId)
    if (!trace) {
      console.log(chalk.red(`  task trace not found: ${taskId}`))
      process.exit(1)
    }
    if (trace.task.status !== "ok" && !opts.allowFailed) {
      console.log(chalk.red(`  task ${taskId} status=${trace.task.status}; pass --allow-failed to draft anyway`))
      process.exit(1)
    }
    const workflow = buildWorkflowDraftFromTrace(trace.task, trace.steps)
    const issues = validateWorkflowDraft(workflow)
    if (issues.length) {
      console.log(chalk.red(`  generated draft failed validation:`))
      for (const issue of issues) console.log(`    ${issue}`)
      process.exit(1)
    }
    const format = String(opts.format).toLowerCase() === "json" ? "json" : "yaml"
    if (opts.commit) {
      const path = writeWorkflowDraft(workflow, { format })
      console.log(chalk.green(`  ✓ draft written: ${path}`))
    }
    if (opts.print || !opts.commit) printWorkflowDraft(workflow, format)
  })

workflow
  .command("absorb")
  .description("mine successful task traces into reviewable workflow drafts")
  .option("--path <path>", "SQLite db path", ".agentx/db.sqlite")
  .option("--since <duration>", "trace window, e.g. 24h, 7d, or ms epoch", "24h")
  .option("--agent <id>", "only absorb traces for one agent")
  .option("--min-cluster-size <n>", "minimum similar traces per draft", "3")
  .option("--min-message-length <n>", "minimum messagePreview chars to consider a trace (default 30)", "30")
  .option("--max <n>", "maximum drafts to generate", "10")
  .option("--dry-run", "preview candidates without writing", false)
  .option("--commit", "write generated drafts", false)
  .option("--model <model>", "reserved for LLM-backed extraction; v1 uses deterministic extraction")
  .action((opts) => {
    const db = openTraceDb(opts.path)
    const traces = loadSuccessfulTraces(db, {
      since: parseSince(opts.since),
      agentId: opts.agent,
      limit: 1000,
      minMessageLength: Number(opts.minMessageLength) || 30,
    })
    if (traces.length === 0) {
      console.log(chalk.dim("  no successful free-form traces found in window"))
      return
    }
    const clusters = clusterWorkflowCandidates(traces, {
      minClusterSize: Number(opts.minClusterSize) || 3,
      max: Number(opts.max) || 10,
    })
    if (clusters.length === 0) {
      console.log(chalk.dim(`  ${traces.length} trace(s), but no cluster met min size ${opts.minClusterSize}`))
      return
    }
    const drafts = buildDraftsFromClusters(db, clusters)
    for (const draft of drafts) {
      console.log(`  ${chalk.cyan(draft.id)}  ${chalk.bold(`${draft.sourceTaskIds.length} traces`)}  confidence=${draft.confidence.toFixed(2)}`)
      console.log(chalk.dim(`    ${draft.reason}`))
      const issues = validateWorkflowDraft(draft.workflow)
      if (issues.length) {
        console.log(chalk.red(`    validation failed: ${issues.join("; ")}`))
        continue
      }
      if (opts.commit && !opts.dryRun) {
        try {
          const path = writeWorkflowDraft(draft.workflow, { format: "yaml" })
          console.log(chalk.green(`    written: ${path}`))
        } catch (e: any) {
          console.log(chalk.yellow(`    skipped: ${e.message}`))
        }
      }
    }
    if (!opts.commit || opts.dryRun) console.log(chalk.dim("  dry run only; pass --commit to write drafts"))
  })

workflow
  .command("drafts")
  .description("list workflow drafts pending review")
  .option("--json", "emit JSON", false)
  .action((opts) => {
    const drafts = listWorkflowDrafts()
    if (opts.json) {
      console.log(JSON.stringify(drafts.map((d) => ({ id: d.id, path: d.path, workflow: d.workflow })), null, 2))
      return
    }
    if (drafts.length === 0) {
      console.log(chalk.dim("  no workflow drafts"))
      return
    }
    for (const d of drafts) {
      const wf = d.workflow
      console.log(`  ${chalk.cyan(d.id)}  ${chalk.bold(wf.title)}  ${chalk.dim(`status=${wf.status} state=${wf.state}`)}`)
      if (wf.sourceTaskIds.length) console.log(chalk.dim(`    sources: ${wf.sourceTaskIds.slice(0, 5).join(", ")}${wf.sourceTaskIds.length > 5 ? "..." : ""}`))
      if (wf.confidence != null) console.log(chalk.dim(`    confidence: ${wf.confidence.toFixed(2)}  path: ${d.path}`))
    }
  })

workflow
  .command("promote <draftId>")
  .description("promote a workflow draft into the active workflow store")
  .option("--replace", "replace an existing workflow file with the same id", false)
  .option("--format <fmt>", "yaml (default) or json", "yaml")
  .option("--daemon <url>", "daemon API base URL", "http://127.0.0.1:18800")
  .action(async (draftId: string, opts) => {
    try {
      const format = String(opts.format).toLowerCase() === "json" ? "json" : "yaml"
      const result = promoteWorkflowDraft(draftId, { replace: !!opts.replace, format })
      console.log(chalk.green(`  ✓ promoted ${draftId}`))
      console.log(chalk.dim(`    ${result.from} -> ${result.to}`))
      try { await fetch(`${String(opts.daemon).replace(/\/$/, "")}/reload`, { method: "POST" }) } catch { /* daemon optional */ }
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

workflow
  .command("reject <draftId>")
  .description("archive a workflow draft without activating it")
  .action((draftId: string) => {
    try {
      const dest = rejectWorkflowDraft(draftId)
      console.log(chalk.green(`  ✓ rejected ${draftId}`))
      console.log(chalk.dim(`    archived: ${dest}`))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

workflow
  .command("replay-task <taskId>")
  .description("replay a task through its generated workflow draft or an ad-hoc draft")
  .option("--path <path>", "SQLite db path", ".agentx/db.sqlite")
  .option("--workflow <id>", "workflow or draft id to replay instead of auto-discovery")
  .option("--input <json>", "override workflow trigger input")
  .option("--agent <id>", "override agent id for generated draft agent nodes")
  .option("--model <id>", "override model id for generated draft agent nodes")
  .option("--timeout <minutes>", "override timeout hint in trigger input")
  .option("--validate-only", "validate the replay workflow without running it", false)
  .option("--dry-run", "print the replay workflow and input without running", false)
  .option("--watch", "tail workflow traces while the replay runs", false)
  .option("--daemon <url>", "daemon API base URL", "http://127.0.0.1:18800")
  .action(async (taskId: string, opts) => {
    const db = openTraceDb(opts.path)
    const trace = getTrace(db, taskId)
    if (!trace) {
      console.log(chalk.red(`  task trace not found: ${taskId}`))
      process.exit(1)
    }

    let workflowDef = opts.workflow ? getWorkflowDraft(opts.workflow)?.workflow : undefined
    if (!workflowDef && opts.workflow) {
      workflowDef = new WorkflowStore().get(opts.workflow) || undefined
    }
    if (!workflowDef) {
      workflowDef = listWorkflowDrafts().find((d) => d.workflow.sourceTaskIds.includes(taskId))?.workflow
    }
    if (!workflowDef) workflowDef = buildWorkflowDraftFromTrace(trace.task, trace.steps, { id: `_adhoc-replay-${taskId.toLowerCase().slice(0, 8)}` })

    if (opts.agent || opts.model) {
      workflowDef = workflowSchema.parse({
        ...workflowDef,
        nodes: workflowDef.nodes.map((n) => n.type === "agent"
          ? {
              ...n,
              config: {
                ...n.config,
                ...(opts.agent ? { agentId: String(opts.agent) } : {}),
                ...(opts.model ? { model: String(opts.model) } : {}),
              },
            }
          : n),
      })
    }

    const issues = validateWorkflowDraft(workflowDef)
    if (issues.length) {
      console.log(chalk.red(`  replay workflow failed validation:`))
      for (const issue of issues) console.log(`    ${issue}`)
      process.exit(1)
    }

    let payload: Record<string, unknown> = {
      input: {
        message: trace.task.messagePreview || "",
        taskId,
        originalAgentId: trace.task.agentId,
        timeoutMinutes: opts.timeout ? Number(opts.timeout) : undefined,
      },
    }
    if (opts.input) {
      try { payload = JSON.parse(opts.input) } catch { console.log(chalk.red("  --input must be valid JSON")); process.exit(1) }
    }

    if (opts.validateOnly || opts.dryRun) {
      printWorkflowDraft(workflowDef, "yaml")
      console.log(chalk.dim("  input:"))
      console.log(JSON.stringify(payload, null, 2))
      return
    }

    const store = new WorkflowStore()
    mkdirSync(store.baseDir, { recursive: true })
    const replayId = workflowDef.id.startsWith("_adhoc-") ? workflowDef.id : `_adhoc-replay-${workflowDef.id}-${Date.now().toString(36)}`
    const replayWorkflow = workflowSchema.parse({ ...workflowDef, id: replayId, state: "active", status: "review" })
    const dest = resolve(store.baseDir, `${replayId}.yaml`)
    writeFileSync(dest, renderWorkflowYaml(replayWorkflow))
    const base = String(opts.daemon).replace(/\/$/, "")
    try { await fetch(`${base}/reload`, { method: "POST" }) } catch { /* daemon may not support reload */ }
    const res = await fetch(`${base}/workflows/${encodeURIComponent(replayId)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, force: true }),
    })
    if (!res.ok) {
      console.log(chalk.red(`  replay failed (${res.status}): ${(await res.text()).slice(0, 300)}`))
      process.exit(1)
    }
    const body = await res.json() as { runId?: string }
    console.log(chalk.green(`  ✓ replay started: ${body.runId || "(unknown run)"}`))
    console.log(chalk.dim(`    workflow: ${replayId}`))
    const originalSummary = traceSummary(trace.steps)
    console.log(chalk.dim(`    original: ${originalSummary.totalTokens || 0}t  ${originalSummary.durationMs || 0}ms  model=${originalSummary.models.join(",") || trace.task.model || "—"}`))
    if (body.runId) {
      const replayTraces = await tailTraces({ daemonUrl: base, runId: body.runId, quiet: !opts.watch })
      printReplayComparison(originalSummary, traceSummary(replayTraces))
    }
  })

workflow
  .command("run <id-or-file>")
  .description("manually trigger a workflow by id, or load + register + run a YAML/JSON file")
  .option("--input <json>", "JSON object merged into the trigger event payload")
  .option("--force", "fire even if the trigger isn't `trigger.manual` (uses a synthesized event)", false)
  .option("--watch", "tail per-step traces while the run executes", false)
  .option("--daemon <url>", "daemon API base URL", "http://127.0.0.1:18800")
  .action(async (idOrFile: string, opts) => {
    let payload: unknown = {}
    if (opts.input) {
      try { payload = JSON.parse(opts.input) } catch { console.log(chalk.red(`  --input must be valid JSON`)); process.exit(1) }
    }

    // Two paths:
    // (1) `idOrFile` resolves to a real file → register-then-run it as a
    //     one-shot. Useful for iterating on an unsaved YAML without
    //     committing to .agentx/workflows/. The synthesized id collides
    //     guard: prefix `_adhoc-` so we don't shadow stored workflows
    //     unless the file's id already starts with that prefix.
    // (2) `idOrFile` is a workflow id → fire by id (existing behavior).
    let id = idOrFile
    const path = resolve(process.cwd(), idOrFile)
    const isFile = (idOrFile.includes("/") || /\.(ya?ml|json)$/i.test(idOrFile)) && existsSync(path)
    if (isFile) {
      const text = readFileSync(path, "utf-8")
      const isYaml = /\.(ya?ml)$/i.test(idOrFile)
      let raw: unknown
      try {
        raw = isYaml ? parseYamlWorkflow(text, { filePath: idOrFile }) : JSON.parse(text)
      } catch (e: any) {
        const msg = e instanceof WorkflowYamlError ? e.message : `parse error: ${e?.message ?? e}`
        console.log(chalk.red(`  ${msg}`))
        process.exit(1)
      }
      const parsed = workflowSchema.safeParse(raw)
      if (!parsed.success) {
        console.log(chalk.red(`  ✗ schema:`))
        for (const i of parsed.error.issues) console.log(`    ${i.path.join(".") || "<root>"}: ${i.message}`)
        process.exit(1)
      }
      const lintIssues = lintWorkflow(parsed.data)
      if (lintIssues.length) {
        console.log(chalk.red(`  ✗ lint:`))
        for (const l of lintIssues) console.log(`    ${l}`)
        process.exit(1)
      }
      // Write to the store under an _adhoc-prefixed id so the daemon's
      // fs.watch picks it up. We re-use the existing id when it already
      // starts with `_adhoc-` so repeated runs against the same file
      // don't accumulate copies.
      const store = new WorkflowStore()
      const adhocId = parsed.data.id.startsWith("_adhoc-")
        ? parsed.data.id
        : `_adhoc-${parsed.data.id}-${Date.now().toString(36)}`
      const ext = isYaml ? "yaml" : "json"
      const dest = resolve(store.baseDir, `${adhocId}.${ext}`)
      const written = isYaml
        ? text.replace(new RegExp(`^id:\\s*${parsed.data.id}\\b`, "m"), `id: ${adhocId}`)
        : JSON.stringify({ ...parsed.data, id: adhocId }, null, 2) + "\n"
      writeFileSync(dest, written)
      id = adhocId
      console.log(chalk.dim(`  ad-hoc registered as "${adhocId}" → ${dest}`))
      // Hot-reload so the dispatcher knows about it before we POST.
      try { await fetch(`${String(opts.daemon).replace(/\/$/, "")}/reload`, { method: "POST" }) } catch { /* daemon may not be running yet */ }
    }

    const url = `${String(opts.daemon).replace(/\/$/, "")}/workflows/${encodeURIComponent(id)}/run`
    let runId: string | undefined
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, force: !!opts.force }),
      })
      if (!res.ok) {
        const text = await res.text()
        console.log(chalk.red(`  run failed (${res.status}): ${text.slice(0, 300)}`))
        if (res.status === 409) console.log(chalk.dim(`  hint: pass --force to fire non-manual workflows for testing`))
        process.exit(1)
      }
      const body = await res.json() as { runId?: string; source?: string; force?: boolean }
      runId = body.runId
      console.log(chalk.green(`  ✓ run started: ${runId || "(unknown id)"}${body.force ? chalk.dim(`  (forced, source=${body.source})`) : ""}`))
    } catch (e: any) {
      console.log(chalk.red(`  request to daemon failed: ${e.message}`))
      process.exit(1)
    }

    if (opts.watch && runId) {
      await tailTraces({ daemonUrl: String(opts.daemon).replace(/\/$/, ""), runId })
    }
  })

/** Poll /traces?workflowRunId=<id> every 500ms until the run is no
 *  longer "running", printing each new step row as it appears. The
 *  trace store keys per node, so we only need to track which nodeIds
 *  we've already printed. */
async function tailTraces(args: { daemonUrl: string; runId: string; quiet?: boolean }): Promise<any[]> {
  const seen = new Set<string>()
  const collected = new Map<string, any>()
  const startedAt = Date.now()
  // Hard cap so a stuck run doesn't pin the terminal forever.
  const maxMs = 15 * 60 * 1000

  while (Date.now() - startedAt < maxMs) {
    let traces: any[] = []
    try {
      const r = await fetch(`${args.daemonUrl}/traces?workflowRunId=${encodeURIComponent(args.runId)}&limit=200`)
      if (r.ok) {
        const body = await r.json() as { traces?: any[] }
        traces = body.traces || []
      }
    } catch { /* transient — try again next tick */ }

    for (const t of traces) {
      if (!t.taskId || seen.has(t.taskId)) continue
      seen.add(t.taskId)
      collected.set(t.taskId, t)
      if (args.quiet) continue
      const status = t.status || "running"
      const color = status === "ok" ? chalk.green : status === "error" ? chalk.red : chalk.cyan
      const tokens = t.totalTokens != null ? chalk.dim(`${t.totalTokens}t`) : ""
      const dur = t.durationMs != null ? chalk.dim(`${t.durationMs}ms`) : ""
      console.log(`  ${color(status.padEnd(5))} ${chalk.bold(t.nodeId || t.label || "(node)")}  ${tokens}  ${dur}`)
      if (t.error) console.log(`    ${chalk.red(String(t.error).slice(0, 200))}`)
    }

    // Look up the run's status to know when to stop. The run isn't in
    // /traces, so we read it from the run-store's HTTP surface.
    try {
      const r = await fetch(`${args.daemonUrl}/api/workflows/runs/${encodeURIComponent(args.runId)}`)
      if (r.ok) {
        const body = await r.json() as { run?: { status?: string } }
        const run = body.run
        if (run && run.status && run.status !== "running") {
          if (!args.quiet) {
            console.log()
            console.log(`  ${chalk.dim("run finished:")} ${run.status}`)
            console.log(chalk.dim(`  full traces: ${args.daemonUrl}/traces?workflowRunId=${args.runId}`))
          }
          return Array.from(collected.values())
        }
      }
    } catch { /* try again next tick */ }

    await new Promise((r) => setTimeout(r, 500))
  }
  if (!args.quiet) console.log(chalk.yellow(`  watch timed out after 15min. Run is still active — check /traces`))
  return Array.from(collected.values())
}

workflow
  .command("trace <id>")
  .description("pretty-print a task's execution trace (taskId or runId)")
  .option("--daemon <url>", "daemon API base URL", "http://127.0.0.1:18800")
  .option("--json", "raw JSON output", false)
  .action(async (id: string, opts) => {
    const base = String(opts.daemon).replace(/\/$/, "")

    // Try as a taskId first (single-step trace), then fall back to
    // workflowRunId (multi-step listing).
    try {
      const single = await fetch(`${base}/traces/${encodeURIComponent(id)}`)
      if (single.ok) {
        const rec = await single.json() as any
        if (opts.json) { console.log(JSON.stringify(rec, null, 2)); return }
        printTrace(rec)
        return
      }
    } catch { /* fall through to runId */ }

    let body: { traces?: any[] }
    try {
      const r = await fetch(`${base}/traces?workflowRunId=${encodeURIComponent(id)}&limit=200`)
      if (!r.ok) {
        console.log(chalk.red(`  /traces returned ${r.status}`))
        process.exit(1)
      }
      body = await r.json() as { traces?: any[] }
    } catch (e: any) {
      console.log(chalk.red(`  daemon request failed: ${e.message}`))
      process.exit(1)
    }
    const traces = body.traces || []
    if (traces.length === 0) {
      console.log(chalk.yellow(`  no traces for "${id}"`))
      console.log(chalk.dim(`  (sqlite must be opened — check 'agentx doctor' if the daemon logged 'sqlite: not opened')`))
      return
    }
    if (opts.json) { console.log(JSON.stringify(traces, null, 2)); return }
    console.log()
    console.log(chalk.bold(`  ${traces.length} step${traces.length === 1 ? "" : "s"} for run ${id}:`))
    console.log()
    for (const t of traces) printTrace(t)
  })

function printTrace(t: any): void {
  const status = t.status || "ok"
  const color = status === "ok" ? chalk.green : status === "error" ? chalk.red : chalk.cyan
  const tokens = t.totalTokens != null ? `${t.totalTokens}t` : "—"
  const dur = t.durationMs != null ? `${t.durationMs}ms` : "—"
  const model = t.model || "—"
  console.log(`  ${color(status.padEnd(5))} ${chalk.bold(String(t.nodeId || t.label || "(node)"))}`)
  console.log(`    ${chalk.dim("taskId:")}   ${t.taskId || "—"}`)
  console.log(`    ${chalk.dim("model:")}    ${model}`)
  console.log(`    ${chalk.dim("tokens:")}   ${tokens}    ${chalk.dim("duration:")} ${dur}`)
  if (t.error) console.log(`    ${chalk.dim("error:")}    ${chalk.red(String(t.error).slice(0, 300))}`)
  console.log()
}

workflow
  .command("pause <runId>")
  .description("pause an active run")
  .option("--node <id>", "home-node id", )
  .action((runId: string, opts) => {
    const nodeId = opts.node || process.env.WF_NODE_ID || "local"
    const runs = new RunStore({ nodeId })
    const updated = runs.setStatus(runId, "paused")
    if (!updated) { console.log(chalk.yellow(`  no such run: ${runId}`)); process.exit(1) }
    console.log(chalk.green(`  ✓ paused ${runId}`))
  })

workflow
  .command("resume <runId>")
  .description("resume a paused run")
  .option("--node <id>", "home-node id")
  .action((runId: string, opts) => {
    const nodeId = opts.node || process.env.WF_NODE_ID || "local"
    const runs = new RunStore({ nodeId })
    const updated = runs.setStatus(runId, "running")
    if (!updated) { console.log(chalk.yellow(`  no such run: ${runId}`)); process.exit(1) }
    console.log(chalk.green(`  ✓ resumed ${runId}`))
  })

workflow
  .command("cancel <runId>")
  .description("cancel an active run")
  .option("--node <id>", "home-node id")
  .action((runId: string, opts) => {
    const nodeId = opts.node || process.env.WF_NODE_ID || "local"
    const runs = new RunStore({ nodeId })
    const updated = runs.setStatus(runId, "canceled")
    if (!updated) { console.log(chalk.yellow(`  no such run: ${runId}`)); process.exit(1) }
    console.log(chalk.green(`  ✓ canceled ${runId}`))
  })
