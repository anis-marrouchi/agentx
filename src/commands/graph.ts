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

// --- graph migrate (Phase 2 of classifier-retire) ---
// Bulk remap classifications.jsonl + index.json from v1 (scope/location/...)
// to v2 (category/verb) via keyword heuristics. Idempotent. No LLM calls.

graph
  .command("migrate")
  .description("remap past classifications from v1 (scope/location/org/unit/activity) to v2 (category/verb) via keyword heuristics. No LLM calls. Idempotent.")
  .option("--dry-run", "report what would change, don't write")
  .action(async (opts) => {
    const config = loadDaemonConfig()
    if (!config.graph) {
      console.log(chalk.yellow("  graph block missing from agentx.json — nothing to migrate"))
      return
    }
    const baseDir = resolve(process.cwd(), config.graph.baseDir)
    if (!existsSync(baseDir)) {
      console.log(chalk.yellow(`  ${baseDir} does not exist — nothing to migrate`))
      return
    }
    const { migrateV2 } = await import("@/graph/migrate-v2")
    const store = new GraphStore({ baseDir, log: () => undefined })
    const result = migrateV2(store, { dryRun: !!opts.dryRun, log: (...a) => console.log(chalk.dim("  "), ...a) })
    console.log()
    console.log(chalk.bold("  Pattern hits:"))
    const hits = Object.entries(result.patternHits).sort((a, b) => b[1] - a[1])
    if (hits.length === 0) console.log(chalk.dim("    (none)"))
    for (const [verb, count] of hits) console.log(`    ${verb.padEnd(28)} ${count}`)
    console.log()
    if (opts.dryRun) {
      console.log(chalk.dim(`  Dry-run — omit --dry-run to apply.`))
    } else {
      console.log(chalk.green(`  Done. Backups: ${result.backups.length} file(s).`))
    }
    console.log()
  })

// --- graph pull (cross-mesh sync) ---
// v1: leader-follower — pull schema + nodes + approved classifications from
// a peer's daemon. Conflicts skip silently; local always wins. Only approved
// classifications come across — pending/rejected stay peer-local. Schema
// divergence is reported but not reconciled (that's a harder design).

graph
  .command("pull")
  .description("pull schema + nodes + approved classifications from a peer's graph")
  .requiredOption("--from <url>", "peer daemon URL (e.g. http://clawd.noqta.tn:19900)")
  .option("--token <t>", "bearer token for the peer (if it requires auth)")
  .option("--limit <n>", "max approved classifications to pull", "500")
  .option("--dry-run", "show what would change, don't write")
  .action(async (opts) => {
    const config = loadDaemonConfig()
    if (!config.graph?.enabled) {
      console.log(chalk.yellow("  graph.enabled is false on this node — nothing to sync INTO."))
      return
    }
    const peer = String(opts.from).replace(/\/+$/, "")
    const limit = Math.max(1, parseInt(opts.limit) || 500)
    const headers: Record<string, string> = { Accept: "application/json" }
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`

    const store = new GraphStore({ baseDir: resolve(process.cwd(), config.graph.baseDir) })
    const localSchema = store.loadSchema()
    const localNodes = store.loadNodes().nodes
    const localIds = new Set(localNodes.map(n => n.id))

    // 1. Schema — warn on divergence. If local is fresh (no nodes committed),
    //    adopt peer schema. Otherwise keep local + warn about axis drift.
    console.log()
    console.log(chalk.bold(`  graph pull ← ${peer}`))
    let peerSchema: any, peerNodes: any[], peerClassifications: any[]
    try {
      const schemaRes = await fetch(`${peer}/graph/schema`, { headers })
      if (!schemaRes.ok) throw new Error(`schema HTTP ${schemaRes.status}`)
      const schemaData = await schemaRes.json() as any
      peerSchema = schemaData.schema

      const nodesRes = await fetch(`${peer}/graph/nodes`, { headers })
      if (!nodesRes.ok) throw new Error(`nodes HTTP ${nodesRes.status}`)
      peerNodes = ((await nodesRes.json() as any).nodes) || []

      const clRes = await fetch(`${peer}/graph/classifications?status=approved&limit=${limit}`, { headers })
      if (!clRes.ok) throw new Error(`classifications HTTP ${clRes.status}`)
      peerClassifications = ((await clRes.json() as any).classifications) || []
    } catch (e: any) {
      console.log(chalk.red(`  fetch failed: ${e.message}`))
      return
    }

    const localLevels = localSchema.levels.map((l: any) => l.id).join(",")
    const peerLevels = peerSchema?.levels?.map((l: any) => l.id).join(",")
    const schemaMatches = localLevels === peerLevels
    if (!schemaMatches) {
      console.log(chalk.yellow(`  ⚠ schema levels differ:`))
      console.log(chalk.dim(`    local: ${localLevels}`))
      console.log(chalk.dim(`    peer:  ${peerLevels}`))
      if (localNodes.length === 0 && !opts.dryRun) {
        console.log(chalk.dim(`  local is empty — adopting peer schema`))
        store.saveSchema(peerSchema)
      } else {
        console.log(chalk.yellow(`  keeping local schema; node import may fail if levels disagree`))
      }
    } else {
      console.log(chalk.dim(`  schema matches (${localSchema.levels.length} levels)`))
    }

    // 2. Nodes — import in topological order (level ascending) so parents
    //    exist before children. Skip any id already present locally.
    const schemaForImport = schemaMatches ? localSchema : peerSchema
    const levelOrder = new Map<string, number>()
    schemaForImport.levels.forEach((l: any, i: number) => levelOrder.set(l.id, i))
    const sortedPeerNodes = [...peerNodes].sort(
      (a, b) => (levelOrder.get(a.level) ?? 99) - (levelOrder.get(b.level) ?? 99),
    )

    let nodesAdded = 0, nodesSkipped = 0, nodesFailed = 0
    for (const n of sortedPeerNodes) {
      if (localIds.has(n.id)) { nodesSkipped++; continue }
      if (opts.dryRun) { nodesAdded++; localIds.add(n.id); continue }
      try {
        store.addNode({
          ...n,
          createdBy: n.createdBy ? `${n.createdBy} (sync)` : `sync:${peer}`,
        })
        localIds.add(n.id)
        nodesAdded++
      } catch (e: any) {
        nodesFailed++
        console.log(chalk.yellow(`    skip node ${n.id}: ${e.message?.slice(0, 100)}`))
      }
    }
    console.log(chalk.dim(`  nodes: +${nodesAdded} added · ${nodesSkipped} already-present · ${nodesFailed} failed`))

    // 3. Approved classifications — populate fingerprint cache so recurring
    //    similar messages here snap to the peer's approved path without
    //    another LLM call. Skip any fingerprint already cached locally.
    let fpAdded = 0, fpSkipped = 0
    for (const c of peerClassifications) {
      if (!c.msgHash || !Array.isArray(c.path)) continue
      if (store.getFingerprint(c.msgHash)) { fpSkipped++; continue }
      if (opts.dryRun) { fpAdded++; continue }
      store.setFingerprint(c.msgHash, { path: c.path, leaf: c.leaf || {} })
      fpAdded++
    }
    console.log(chalk.dim(`  fingerprints: +${fpAdded} cached · ${fpSkipped} already-present`))

    console.log()
    if (opts.dryRun) {
      console.log(chalk.dim(`  Dry-run — omit --dry-run to apply.`))
    } else {
      console.log(chalk.green(`  ✓ pulled from ${peer}`))
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
