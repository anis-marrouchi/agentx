import { Command } from "commander"
import chalk from "chalk"
import { WikiStore } from "@/wiki"
import { resolve } from "path"
import { execSync } from "child_process"
import { writeFileSync, mkdirSync } from "fs"

function getWiki(wikiDir?: string): WikiStore {
  const dir = wikiDir || resolve(process.cwd(), ".agentx/wiki")
  return new WikiStore(dir)
}

export const wiki = new Command()
  .name("wiki")
  .description("wiki knowledge base management")

// agentx wiki status
wiki
  .command("status")
  .description("show wiki status: entries, articles, unabsorbed count")
  .option("--dir <path>", "wiki directory")
  .action((opts) => {
    const store = getWiki(opts.dir)
    const entries = store.listEntries()
    const unabsorbed = store.getUnabsorbedEntries()
    const index = store.rebuildIndex()

    console.log()
    console.log(chalk.bold("  Wiki Status"))
    console.log()
    console.log(`  Raw entries:     ${entries.length}`)
    console.log(`  Articles:        ${index.articles.length}`)
    console.log(`  Unabsorbed:      ${chalk.yellow(String(unabsorbed.length))}`)
    console.log()

    if (unabsorbed.length > 0) {
      console.log(chalk.dim("  Run 'agentx wiki absorb' to compile entries into articles"))
      console.log()

      // Show unabsorbed by agent
      const byAgent = new Map<string, number>()
      for (const e of unabsorbed) {
        byAgent.set(e.agentId, (byAgent.get(e.agentId) || 0) + 1)
      }
      for (const [agent, count] of byAgent) {
        console.log(`    ${chalk.cyan(agent)}: ${count} unabsorbed entries`)
      }
      console.log()
    }
  })

// agentx wiki lint
wiki
  .command("lint")
  .description("check wiki for issues: broken links, orphans, stubs, unsourced")
  .option("--dir <path>", "wiki directory")
  .action((opts) => {
    const store = getWiki(opts.dir)
    const issues = store.lint()

    console.log()
    if (issues.length === 0) {
      console.log(chalk.green("  No issues found"))
    } else {
      console.log(chalk.bold(`  ${issues.length} issues found:`))
      console.log()
      for (const issue of issues) {
        const icon = issue.type === "broken-link" ? "x" : issue.type === "orphan" ? "?" : "!"
        console.log(`  [${icon}] ${chalk.dim(issue.type)} ${issue.article}: ${issue.message}`)
      }
    }
    console.log()
  })

// agentx wiki absorb — compile unabsorbed entries into articles
wiki
  .command("absorb")
  .description("compile unabsorbed raw entries into wiki articles using Claude")
  .option("--dir <path>", "wiki directory")
  .option("--dry-run", "show what would be absorbed without running")
  .option("--max <n>", "max entries to process", "20")
  .action(async (opts) => {
    const store = getWiki(opts.dir)
    const unabsorbed = store.getUnabsorbedEntries().slice(0, parseInt(opts.max))

    if (unabsorbed.length === 0) {
      console.log(chalk.green("  All entries are absorbed. Nothing to do."))
      return
    }

    console.log(chalk.bold(`  ${unabsorbed.length} entries to absorb`))
    console.log()

    // Group by agent
    const byAgent = new Map<string, typeof unabsorbed>()
    for (const entry of unabsorbed) {
      const list = byAgent.get(entry.agentId) || []
      list.push(entry)
      byAgent.set(entry.agentId, list)
    }

    for (const [agentId, entries] of byAgent) {
      console.log(`  ${chalk.cyan(agentId)}: ${entries.length} entries`)
      for (const e of entries.slice(0, 3)) {
        console.log(chalk.dim(`    [${e.date} via ${e.source}] ${e.content.slice(0, 80)}...`))
      }
      if (entries.length > 3) console.log(chalk.dim(`    ... and ${entries.length - 3} more`))
    }
    console.log()

    if (opts.dryRun) {
      console.log(chalk.dim("  Dry run — no changes made"))
      return
    }

    // Build the absorb prompt with full entry content
    const existingArticles = store.rebuildIndex()
    const existingList = existingArticles.articles.length > 0
      ? `\nExisting articles:\n${existingArticles.articles.map(a => `- ${a.title} (${a.path})`).join("\n")}\n`
      : ""

    const entryTexts = unabsorbed.map(e =>
      `--- ENTRY ${e.id} [${e.date} ${e.agentId} via ${e.source}] ---\n${e.content}\n--- END ENTRY ---`
    ).join("\n\n")

    const prompt = `You are a wiki editor for an agent system. Your job is to compile raw conversation entries into structured wiki articles.

Read these ${unabsorbed.length} raw entries and produce wiki articles in JSON format.
${existingList}
Rules:
1. Group related entries into articles by topic (e.g., "Weekly Marketing Brief", "MTGL Deploy Process", "GitLab Token Issues")
2. Each article should synthesize information, not just copy-paste
3. Use wikilinks [[Article Title]] to cross-reference related articles
4. If an existing article covers the topic, produce an UPDATE with merged content
5. Output ONLY valid JSON — no markdown fencing, no explanation

Output format (JSON array):
[
  {
    "path": "projects/mtgl-deploy.md",
    "title": "MTGL Deploy Process",
    "type": "process",
    "content": "How we deploy MTGL to staging...\n\nSee also [[GitLab Token Issues]]",
    "sources": ["entry-id-1", "entry-id-2"]
  }
]

Valid types: concept, process, project, decision, person, pattern, incident, report

ENTRIES:

${entryTexts}`

    // Write prompt to temp file and run through Claude
    const tmpDir = resolve(store["baseDir"], "_tmp")
    mkdirSync(tmpDir, { recursive: true })
    const promptPath = resolve(tmpDir, "absorb-prompt.txt")
    writeFileSync(promptPath, prompt)

    console.log(chalk.dim("  Running Claude to compile articles..."))

    try {
      let rawOutput: string
      try {
        rawOutput = execSync(
          `cat '${promptPath}' | claude -p - --output-format json --max-turns 5`,
          { encoding: "utf-8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
        )
      } catch (execErr: any) {
        // Claude exits non-zero on max_turns but stdout still has the result
        rawOutput = execErr.stdout || ""
        if (!rawOutput) throw execErr
      }

      // Parse Claude's JSON output
      let responseText: string
      try {
        const jsonOut = JSON.parse(rawOutput)
        responseText = jsonOut.result || jsonOut.content || rawOutput
      } catch {
        responseText = rawOutput
      }

      // Extract JSON array from response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.log(chalk.red("  Claude didn't return valid JSON. Raw output:"))
        console.log(responseText.slice(0, 500))
        return
      }

      const articles = JSON.parse(jsonMatch[0]) as Array<{
        path: string
        title: string
        type: string
        content: string
        sources: string[]
      }>

      console.log(chalk.green(`  Claude produced ${articles.length} articles:`))
      console.log()

      for (const article of articles) {
        const now = new Date().toISOString().slice(0, 10)
        // Determine owner from the majority of source entries
        const sourceAgents = article.sources
          .map(sid => unabsorbed.find(e => e.id === sid)?.agentId)
          .filter(Boolean) as string[]
        const owner = sourceAgents[0] || unabsorbed[0]?.agentId || "system"

        store.writeArticle(article.path, {
          title: article.title,
          type: article.type as any,
          owner,
          access: "internal",
          created: now,
          lastUpdated: now,
          related: [],
          sources: article.sources,
        }, article.content, owner)

        console.log(`  ${chalk.green("+")} ${article.path}: ${article.title}`)
        console.log(chalk.dim(`    sources: ${article.sources.join(", ")}`))
      }

      // Rebuild index
      store.rebuildIndex()
      console.log()
      console.log(chalk.green("  Index rebuilt. Done."))

    } catch (e: any) {
      console.log(chalk.red(`  Absorb failed: ${e.message?.slice(0, 200)}`))
      if (e.stderr) console.log(chalk.dim(String(e.stderr).slice(0, 500)))
      if (e.stdout) console.log(chalk.dim("stdout: " + String(e.stdout).slice(0, 500)))
    }
  })

// agentx wiki entries — list raw entries
wiki
  .command("entries")
  .description("list raw entries")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "filter by agent")
  .action((opts) => {
    const store = getWiki(opts.dir)
    let entries = store.listEntries()

    if (opts.agent) {
      entries = entries.filter(e => e.agentId === opts.agent)
    }

    console.log()
    console.log(chalk.bold(`  ${entries.length} raw entries`))
    console.log()

    for (const e of entries.slice(-20)) {
      console.log(`  ${chalk.dim(e.date)} ${chalk.cyan(e.agentId)} via ${e.source}: ${e.content.slice(0, 80)}...`)
    }

    if (entries.length > 20) {
      console.log(chalk.dim(`  ... showing last 20 of ${entries.length}`))
    }
    console.log()
  })

// agentx wiki search <query>
wiki
  .command("search <query>")
  .description("search wiki articles")
  .option("--dir <path>", "wiki directory")
  .action((query, opts) => {
    const store = getWiki(opts.dir)
    const results = store.findRelevant(query, undefined, 10)

    console.log()
    if (results.length === 0) {
      console.log(chalk.dim("  No matching articles"))
    } else {
      console.log(chalk.bold(`  ${results.length} results for "${query}":`))
      console.log()
      for (const r of results) {
        console.log(`  ${chalk.cyan(r.meta.title)} (${r.meta.type})`)
        console.log(chalk.dim(`    ${r.path} — ${r.content.slice(0, 100)}...`))
      }
    }
    console.log()
  })
