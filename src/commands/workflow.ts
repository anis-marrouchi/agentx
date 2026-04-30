import { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"
import { existsSync, readFileSync } from "fs"
import { RunStore, WorkflowStore, lintWorkflow, workflowSchema, parseYamlWorkflow, renderWorkflowYaml, WorkflowYamlError } from "@/workflows"

// --- agentx workflow — declarative state machines for channel events ---
//
// v1: list / show / validate / run-manual / runs / pause / resume / cancel
// The engine itself runs inside the daemon; this CLI is the author tooling
// (inspect YAML, validate, poke manual triggers, read run history).

export const workflow = new Command()
  .name("workflow")
  .description("workflow definitions — list, show, validate, manage runs")

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
      console.log(`  ${chalk.cyan(wf.id)}  ${chalk.bold(wf.title)} ${chalk.dim(`v${wf.version}`)}`)
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
  .command("run <id>")
  .description("manually trigger a workflow (trigger.manual by default; add --force for any)")
  .option("--input <json>", "JSON object merged into the trigger event payload")
  .option("--force", "fire even if the trigger isn't `trigger.manual` (uses a synthesized event)", false)
  .option("--daemon <url>", "daemon API base URL", "http://127.0.0.1:18800")
  .action(async (id: string, opts) => {
    let payload: unknown = {}
    if (opts.input) {
      try { payload = JSON.parse(opts.input) } catch { console.log(chalk.red(`  --input must be valid JSON`)); process.exit(1) }
    }
    const url = `${String(opts.daemon).replace(/\/$/, "")}/workflows/${encodeURIComponent(id)}/run`
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
      console.log(chalk.green(`  ✓ run started: ${body.runId || "(unknown id)"}${body.force ? chalk.dim(`  (forced, source=${body.source})`) : ""}`))
    } catch (e: any) {
      console.log(chalk.red(`  request to daemon failed: ${e.message}`))
      process.exit(1)
    }
  })

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
