import { Command } from "commander"
import chalk from "chalk"
import { existsSync, rmSync } from "fs"
import { resolve } from "path"
import { buildIndex, indexInfo, lexicalSearch } from "@/rag/lexical-index"

// --- agentx rag ---
//
// Improvement plan #7 — embedding-free retrieval-augmented context.
//
//   agentx rag add <agentId> <glob>...     build/refresh an agent's index
//   agentx rag list                         list every agent's index status
//   agentx rag search <agentId> <query>     query the index (debug surface)
//   agentx rag clear <agentId>              delete the index
//
// Index format is JSON-serialized minisearch state. Tiny, portable,
// rsyncable. Lives at .agentx/rag/<agentId>/index.json.

export const rag = new Command()
  .name("rag")
  .description("manage per-agent lexical (BM25) RAG indexes (improvement plan #7)")

rag
  .command("add <agentId>")
  .description("build or refresh an agent's lexical index from one or more globs")
  .argument("<globs...>", "glob patterns relative to cwd (e.g. './docs/**/*.md')")
  .option("-v, --verbose", "log each indexed file")
  .action(async (agentId: string, globs: string[], opts) => {
    if (globs.length === 0) {
      console.log(chalk.red(`  No globs provided. Example: agentx rag add ${agentId} './docs/**/*.md'`))
      process.exit(1)
    }
    const verbose = !!opts.verbose
    const start = Date.now()
    const r = await buildIndex(agentId, globs, { verbose })
    const ms = Date.now() - start
    console.log(chalk.green(`  ✓ indexed ${r.docs} doc(s) for ${chalk.bold(agentId)} in ${ms}ms`))
    console.log(chalk.dim(`  → ${r.path}`))
  })

rag
  .command("list")
  .description("list every agent's index, sizes, paths")
  .option("-c, --cwd <path>", "search root", process.cwd())
  .action(async (opts) => {
    const root = resolve(opts.cwd, ".agentx", "rag")
    if (!existsSync(root)) {
      console.log(chalk.dim("  (no indexes yet — try `agentx rag add <agentId> <glob>`)"))
      return
    }
    const { readdirSync } = await import("fs")
    const agents = readdirSync(root).filter((d) => existsSync(resolve(root, d, "index.json")))
    if (agents.length === 0) {
      console.log(chalk.dim("  (no indexes)"))
      return
    }
    for (const a of agents.sort()) {
      const info = indexInfo(a)
      console.log(`  ${chalk.bold(a)}  ${info.docs} doc(s)  ${chalk.dim(info.path)}`)
    }
  })

rag
  .command("search <agentId> <query>")
  .description("query an agent's index — useful for debugging recall before the agent calls rag.lexical")
  .option("-k, --k <n>", "top-k results", "5")
  .option("--json", "emit JSON")
  .action((agentId: string, query: string, opts) => {
    const k = parseInt(opts.k, 10) || 5
    const hits = lexicalSearch(agentId, query, { k })
    if (opts.json) {
      console.log(JSON.stringify(hits, null, 2))
      return
    }
    if (hits.length === 0) {
      const info = indexInfo(agentId)
      if (!info.exists) {
        console.log(chalk.red(`  no index for ${agentId} — run \`agentx rag add ${agentId} <glob>\` first`))
      } else {
        console.log(chalk.dim(`  (no hits in ${info.docs} indexed docs)`))
      }
      return
    }
    for (const h of hits) {
      console.log(`  ${chalk.bold(h.title)} ${chalk.dim(`(${h.score.toFixed(2)})`)}`)
      console.log(`    ${chalk.dim(h.path)}`)
      console.log(`    ${chalk.dim(h.snippet.slice(0, 200))}`)
    }
  })

rag
  .command("clear <agentId>")
  .description("delete an agent's index")
  .action((agentId: string) => {
    const path = resolve(process.cwd(), ".agentx", "rag", agentId)
    if (!existsSync(path)) {
      console.log(chalk.dim(`  no index for ${agentId} — nothing to clear`))
      return
    }
    rmSync(path, { recursive: true, force: true })
    console.log(chalk.green(`  ✓ cleared index for ${agentId}`))
  })
