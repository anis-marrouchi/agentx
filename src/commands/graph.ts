import { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"
import { existsSync } from "fs"
import { GraphStore } from "@/graph/store"
import { hashPath, pathLabel } from "@/graph/classifier"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx graph — intent knowledge graph operations ---
//
// v1 scope: just the review loop. Future: `graph status`, `graph nodes`,
// `graph show <msgHash>`, `graph schema edit`. The admin panel surfaces
// pending classifications; this CLI lets an operator (or a cron) invoke
// the reviewer agent to triage them in batch.

export const graph = new Command()
  .name("graph")
  .description("intent knowledge graph — review, inspect, manage")

graph
  .command("review")
  .description("triage pending classifications via the configured review agent (the agent uses `wiki query` for context before deciding)")
  .option("--agent <id>", "override the review agent (defaults to graph.reviewAgent or graph.draftAgent)")
  .option("--max <n>", "cap reviews this run", "20")
  .option("--dry-run", "show the agent's decision but don't apply approvals/rejections")
  .option("--daemon-url <url>", "daemon URL (default: http://localhost:18800)")
  .action(async (opts) => {
    const config = loadDaemonConfig()
    if (!config.graph?.enabled) {
      console.log(chalk.yellow("  graph.enabled is false — nothing to review"))
      return
    }

    const agentId = opts.agent || config.graph.reviewAgent || config.graph.draftAgent
    if (!agentId) {
      console.log(chalk.red("  no review agent. Set graph.reviewAgent in agentx.json or pass --agent <id>."))
      return
    }
    if (!config.agents?.[agentId]) {
      console.log(chalk.red(`  agent "${agentId}" not in config`))
      return
    }
    const daemonUrl = (opts.daemonUrl || config.dashboard?.daemonUrl || "http://localhost:18800").replace(/\/+$/, "")
    const cap = Math.max(1, parseInt(opts.max) || 20)

    const store = new GraphStore({ baseDir: resolve(process.cwd(), config.graph.baseDir) })
    const pending = store.listPendingClassifications(cap)
    if (pending.length === 0) {
      console.log(chalk.dim("  no pending classifications — nothing to review"))
      return
    }

    const schema = store.loadSchema()
    const nodes = store.loadNodes().nodes
    console.log()
    console.log(chalk.bold(`  Graph review — ${pending.length} pending`))
    console.log(chalk.dim(`  Reviewer: ${agentId}  ·  daemon: ${daemonUrl}  ·  ${opts.dryRun ? "dry-run" : "commit"}`))
    console.log()

    let approvedN = 0, rejectedN = 0, skippedN = 0, errorN = 0
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]
      const label = pathLabel(c.path, nodes) || c.path.join(" › ")
      process.stdout.write(`  [${i + 1}/${pending.length}] ${chalk.cyan(c.msgHash.slice(0, 8))} ${chalk.dim(label)} ... `)

      const prompt = buildReviewPrompt(c, schema, nodes)
      let decision: { decision?: string; reason?: string } | null = null
      try {
        decision = await askAgent(daemonUrl, agentId, prompt, config.dashboard?.token)
      } catch (e: any) {
        errorN++
        console.log(chalk.red(`ERR ${e.message?.slice(0, 80)}`))
        continue
      }
      if (!decision || !decision.decision) {
        errorN++
        console.log(chalk.red("ERR no decision"))
        continue
      }
      const verdict = String(decision.decision).toLowerCase().trim()
      const reason = (decision.reason || "").toString().slice(0, 180)

      if (verdict === "approve") {
        console.log(chalk.green(`APPROVE`) + " " + chalk.dim(reason))
        if (!opts.dryRun) {
          try {
            commitApproved(store, c, schema, nodes, agentId)
            store.updateClassificationStatus(c.msgHash, {
              status: "approved",
              reviewer: agentId,
              reviewReason: reason,
            })
            approvedN++
          } catch (e: any) {
            console.log(chalk.yellow(`    (commit failed, staying pending: ${e.message?.slice(0, 100)})`))
            errorN++
          }
        } else {
          approvedN++
        }
      } else if (verdict === "reject") {
        console.log(chalk.red(`REJECT`) + " " + chalk.dim(reason))
        if (!opts.dryRun) {
          store.updateClassificationStatus(c.msgHash, {
            status: "rejected",
            reviewer: agentId,
            reviewReason: reason,
          })
        }
        rejectedN++
      } else {
        console.log(chalk.yellow(`SKIP`) + " " + chalk.dim(reason || verdict))
        skippedN++
      }
    }

    console.log()
    const verb = opts.dryRun ? "would" : "did"
    console.log(chalk.dim(
      `  Summary: ${verb} approve ${approvedN}, ${verb} reject ${rejectedN}, ${skippedN} skipped, ${errorN} errors.`
    ))
    if (opts.dryRun && (approvedN > 0 || rejectedN > 0)) {
      console.log(chalk.dim(`  Dry-run — omit --dry-run to apply.`))
    }
    console.log()
  })

// --- helpers ---

/**
 * Build the review prompt for the agent. The agent sees the original message,
 * the proposed path + axes, a slice of the current catalog so it can sanity-
 * check names, and explicit instructions to use `wiki query` for institutional
 * context before deciding.
 */
function buildReviewPrompt(
  c: any,
  schema: any,
  nodes: any[],
): string {
  const existingByLevel: Record<string, string[]> = {}
  for (const n of nodes) {
    (existingByLevel[n.level] ||= []).push(`${n.id}${n.axes?.name ? ` (${n.axes.name})` : ""}`)
  }
  const levelsSummary = schema.levels
    .map((l: any) => `  ${l.id}: [${(existingByLevel[l.id] || []).slice(0, 10).join(", ") || "(none yet)"}]`)
    .join("\n")

  const axesJson = JSON.stringify(c.proposedAxes || {}, null, 2)
  return [
    `You are reviewing a pending intent classification. Decide whether it is reasonable.`,
    ``,
    `--- MESSAGE (first 500 chars) ---`,
    (c.preview || "").slice(0, 500),
    `channel: ${c.channel || "?"} · sender: ${c.sender || "?"}`,
    ``,
    `--- PROPOSED PATH ---`,
    c.path.join(" › "),
    ``,
    `--- PROPOSED AXES (per new node) ---`,
    axesJson,
    ``,
    `--- CURRENT NODES BY LEVEL (first 10 per level) ---`,
    levelsSummary,
    ``,
    `--- YOUR JOB ---`,
    `Decide one of:`,
    `  approve — the path is right and the axes make sense for the message`,
    `  reject  — the path is wrong (e.g. the message is NOT about the proposed org/topic, or the axes are bogus)`,
    `  skip    — you can't confidently decide; leave it for a human`,
    ``,
    `BEFORE you decide, you MAY call \`agentx wiki query\` (via Bash) to check institutional context — e.g. "is there an article for this project" or "who is this person". This is optional; don't call it for obvious cases.`,
    ``,
    `Bias toward reject over approve when uncertain. A wrong approval pollutes the graph; a wrong rejection just keeps the entry pending.`,
    ``,
    `Return EXACTLY one JSON object on one line, no prose, no fences:`,
    `  {"decision":"approve"|"reject"|"skip","reason":"one sentence"}`,
  ].join("\n")
}

async function askAgent(
  daemonUrl: string,
  agentId: string,
  message: string,
  token?: string,
): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 120_000)  // 2 min — reviewer may call wiki query
  try {
    const r = await fetch(`${daemonUrl}/task`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent: agentId,
        message,
        context: { channel: "a2a", sender: "graph-review" },
      }),
      signal: ac.signal,
    })
    if (!r.ok) throw new Error(`daemon /task HTTP ${r.status}`)
    const data: any = await r.json()
    if (data?.error) throw new Error(String(data.error))
    return extractJson((data?.content || "").toString())
  } finally {
    clearTimeout(timer)
  }
}

/** Commit any new nodes along the path + populate the fingerprint cache.
 *  Delegates to store.commitNodesAlongPath which handles level inference
 *  from axes (so paths that skip levels, like business→noqta when location
 *  is absent, land at the right level) and refreshes nodes between adds. */
function commitApproved(
  store: GraphStore,
  c: any,
  schema: any,
  _existing: any[],  // unused — helper re-reads fresh each time
  createdBy: string,
): void {
  store.commitNodesAlongPath(c.path, c.proposedAxes || {}, schema, createdBy)
  store.setFingerprint(c.msgHash, { path: c.path, leaf: c.leaf || {} })
}

function extractJson(text: string): any {
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) { try { return JSON.parse(fenced[1]) } catch {} }
  const start = text.indexOf("{")
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)) } catch { return null } }
    }
  }
  return null
}

// Suppress unused-import warning — hashPath is exported via the types; we don't
// need it in this file but keep the dependency explicit in case future
// subcommands want to regenerate pathId for display.
void hashPath
void existsSync
