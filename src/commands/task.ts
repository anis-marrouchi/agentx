import { Command } from "commander"
import chalk from "chalk"
import prompts from "prompts"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx task — terminal access to the human-in-the-loop inbox ---
//
// Mirrors the dashboard's /inbox page so a workflow `userTask` step can
// be resolved without leaving the terminal. Hits the same daemon
// endpoints the inbox uses:
//
//   GET  /api/workflows/tasks            (list open / by-actor)
//   GET  /api/workflows/tasks/:id        (single task + form definition)
//   POST /api/workflows/tasks/:id/submit (form submission)
//
// Stays narrow: list / show / submit. Edit / claim / reassign live in
// the dashboard until a CLI use case shows up.

interface FormField {
  key: string
  label: string
  type: "text" | "long-text" | "number" | "boolean" | "date" | "select" | "multi-select" | "file"
  required?: boolean
  options?: string[]
  hint?: string
  defaultValue?: unknown
}

interface FormSchema {
  id?: string
  title: string
  description?: string
  fields: FormField[]
  submitLabel?: string
  secondaryAction?: { key: string; label: string }
}

interface UserTaskRecord {
  id: string
  runId: string
  workflowId: string
  nodeId: string
  title: string
  description?: string
  assignee: string
  assignedTo: string[]
  form: FormSchema
  status: "open" | "claimed" | "completed" | "canceled"
  dueAt?: string
  createdAt: string
  updatedAt: string
}

function daemonBase(): string {
  const config = loadDaemonConfig()
  const [host, port] = (config.node?.bind || "127.0.0.1:18800").split(":")
  return `http://${host || "127.0.0.1"}:${port || 18800}`
}

async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) {
    const txt = await r.text().catch(() => "")
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200) || r.statusText}`)
  }
  return await r.json() as T
}

export const task = new Command()
  .name("task")
  .description("workflow user-tasks — list, show, submit (the terminal inbox)")

task
  .command("list")
  .description("list open user-tasks awaiting submission")
  .option("--actor <id>", "filter to tasks assigned to this actor id")
  .option("--json", "machine-readable JSON output")
  .action(async (opts) => {
    try {
      const qs = opts.actor ? `?actor=${encodeURIComponent(String(opts.actor))}` : ""
      const data = await fetchJson<{ tasks: UserTaskRecord[] }>(`${daemonBase()}/api/workflows/tasks${qs}`)
      const tasks = data.tasks || []
      if (opts.json) {
        console.log(JSON.stringify(tasks, null, 2))
        return
      }
      if (tasks.length === 0) {
        console.log()
        console.log(chalk.dim("  No open tasks."))
        console.log()
        return
      }
      console.log()
      console.log(chalk.bold(`  ${tasks.length} open task${tasks.length === 1 ? "" : "s"}`))
      console.log()
      for (const t of tasks) {
        const due = t.dueAt ? chalk.yellow(` · due ${t.dueAt.slice(0, 16).replace("T", " ")}`) : ""
        const fields = t.form?.fields?.length || 0
        console.log(`  ${chalk.bold(t.id)}${due}`)
        console.log(`    ${t.title}`)
        console.log(chalk.dim(`    workflow=${t.workflowId} node=${t.nodeId} assignee=${t.assignee} fields=${fields}`))
      }
      console.log()
      console.log(chalk.dim("  agentx task show <id>   to see form details"))
      console.log(chalk.dim("  agentx task submit <id> to fill it in"))
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exitCode = 1
    }
  })

task
  .command("show <id>")
  .description("show a single user-task with its form definition")
  .option("--json", "machine-readable JSON output")
  .action(async (id: string, opts) => {
    try {
      const data = await fetchJson<{ task: UserTaskRecord }>(`${daemonBase()}/api/workflows/tasks/${encodeURIComponent(id)}`)
      const t = data.task
      if (opts.json) {
        console.log(JSON.stringify(t, null, 2))
        return
      }
      console.log()
      console.log(chalk.bold(`  ${t.title}`))
      if (t.description) console.log(chalk.dim(`  ${t.description}`))
      console.log()
      console.log(chalk.dim(`  id=${t.id} workflow=${t.workflowId} node=${t.nodeId}`))
      console.log(chalk.dim(`  assignee=${t.assignee} status=${t.status}`))
      if (t.dueAt) console.log(chalk.yellow(`  due ${t.dueAt}`))
      console.log()
      const fields = t.form?.fields || []
      if (fields.length === 0) {
        console.log(chalk.dim("  (no fields)"))
      } else {
        console.log(chalk.bold(`  Fields:`))
        for (const f of fields) {
          const req = f.required ? chalk.red("*") : " "
          const opts = f.options?.length ? chalk.dim(` [${f.options.join("|")}]`) : ""
          const hint = f.hint ? chalk.dim(` — ${f.hint}`) : ""
          console.log(`   ${req} ${chalk.cyan(f.key)} (${f.type})${opts}${hint}`)
        }
      }
      console.log()
      console.log(chalk.dim(`  agentx task submit ${t.id}   to fill it in`))
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exitCode = 1
    }
  })

task
  .command("submit <id>")
  .description("fill in and submit a user-task form interactively (or via --json)")
  .option("--as <actor>", "submitted-by id (defaults to terminal user)", process.env.USER || "cli")
  .option("--json <body>", "non-interactive: pass {action,values} as a JSON string")
  .option("--secondary", "click the secondary action instead of primary (e.g. reject)")
  .action(async (id: string, opts) => {
    try {
      const data = await fetchJson<{ task: UserTaskRecord }>(`${daemonBase()}/api/workflows/tasks/${encodeURIComponent(id)}`)
      const t = data.task
      if (t.status !== "open") {
        console.log(chalk.yellow(`  task is ${t.status} — nothing to submit`))
        return
      }

      let action: "primary" | "secondary" = opts.secondary ? "secondary" : "primary"
      let values: Record<string, unknown> = {}

      if (opts.json) {
        try {
          const parsed = JSON.parse(opts.json)
          if (parsed && typeof parsed === "object") {
            values = (parsed.values && typeof parsed.values === "object") ? parsed.values : parsed
            if (parsed.action === "secondary") action = "secondary"
          }
        } catch (e: any) {
          console.log(chalk.red(`  --json parse failed: ${e.message}`))
          process.exitCode = 1
          return
        }
      } else {
        // Interactive: prompt each field in order
        console.log()
        console.log(chalk.bold(`  ${t.title}`))
        if (t.description) console.log(chalk.dim(`  ${t.description}`))
        console.log()
        for (const f of t.form?.fields || []) {
          const promptType = mapFieldToPromptType(f.type)
          const message = `${f.label}${f.required ? chalk.red(" *") : ""}${f.hint ? chalk.dim(` (${f.hint})`) : ""}`
          const initial = f.defaultValue !== undefined ? f.defaultValue : undefined
          const choices = f.options?.map((o) => ({ title: o, value: o }))
          const promptCfg: prompts.PromptObject = {
            type: promptType,
            name: f.key,
            message,
            ...(initial !== undefined ? { initial: initial as never } : {}),
            ...(choices ? { choices } : {}),
            validate: (v: unknown) => {
              if (f.required && (v == null || v === "")) return `${f.label} is required`
              return true
            },
          }
          const ans = await prompts(promptCfg, { onCancel: () => process.exit(130) })
          values[f.key] = ans[f.key]
        }
        // Choose action when secondary exists and --secondary not explicitly set
        if (!opts.secondary && t.form?.secondaryAction) {
          const labelP = t.form.submitLabel || "Submit"
          const labelS = t.form.secondaryAction.label
          const pick = await prompts({
            type: "select",
            name: "action",
            message: "Action",
            choices: [
              { title: labelP, value: "primary" },
              { title: labelS, value: "secondary" },
            ],
          }, { onCancel: () => process.exit(130) })
          if (pick.action === "secondary") action = "secondary"
        }
      }

      const body = {
        submission: { action, values },
        submittedBy: opts.as,
      }
      const res = await fetchJson<{ ok: boolean; runId: string } | { error: string; fieldErrors?: Record<string, string> }>(
        `${daemonBase()}/api/workflows/tasks/${encodeURIComponent(id)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      )
      if ("error" in res) {
        console.log(chalk.red(`  ${res.error}`))
        if (res.fieldErrors) for (const [k, v] of Object.entries(res.fieldErrors)) console.log(chalk.red(`    ${k}: ${v}`))
        process.exitCode = 1
        return
      }
      console.log()
      console.log(chalk.green(`  Submitted (action=${action}). runId=${res.runId}`))
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exitCode = 1
    }
  })

function mapFieldToPromptType(t: FormField["type"]): prompts.PromptType {
  switch (t) {
    case "long-text":   return "text" // prompts has no multiline; fall back to single-line
    case "number":      return "number"
    case "boolean":     return "confirm"
    case "date":        return "text" // ISO-8601 string; agentx validates downstream
    case "select":      return "select"
    case "multi-select": return "multiselect"
    case "file":        return "text" // path; agentx side resolves
    default:            return "text"
  }
}
