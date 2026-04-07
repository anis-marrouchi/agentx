import { Command } from "commander"
import chalk from "chalk"
import { WikiHub } from "@/wiki"
import { startWikiServer } from "@/wiki/serve"
import { resolve } from "path"
import { execSync } from "child_process"
import { writeFileSync, mkdirSync } from "fs"

function getHub(dir?: string): WikiHub {
  return new WikiHub(dir || resolve(process.cwd(), ".agentx/wiki"))
}

export const wiki = new Command()
  .name("wiki")
  .description("wiki knowledge base management")

// agentx wiki status
wiki
  .command("status")
  .description("show wiki status per agent")
  .option("--dir <path>", "wiki directory")
  .action((opts) => {
    const hub = getHub(opts.dir)
    const agents = hub.summary()
    const shared = hub.getSharedStore()
    const totalEntries = shared.listEntries().length

    console.log()
    console.log(chalk.bold("  Wiki Hub Status"))
    console.log()
    console.log(`  Total raw entries: ${totalEntries}`)
    console.log(`  Agents: ${agents.length}`)
    console.log()

    for (const agent of agents) {
      const status = agent.unabsorbed > 0
        ? chalk.yellow(`${agent.unabsorbed} unabsorbed`)
        : chalk.green("up to date")

      console.log(`  ${chalk.cyan(agent.agentId)}`)
      console.log(`    Entries: ${agent.totalEntries}  Articles: ${agent.totalArticles}  ${status}`)

      if (agent.articles.length > 0) {
        for (const a of agent.articles.slice(0, 3)) {
          console.log(chalk.dim(`      - ${a.title} (${a.type})`))
        }
        if (agent.articles.length > 3) {
          console.log(chalk.dim(`      ... and ${agent.articles.length - 3} more`))
        }
      }
      console.log()
    }

    const totalUnabsorbed = agents.reduce((s, a) => s + a.unabsorbed, 0)
    if (totalUnabsorbed > 0) {
      console.log(chalk.dim("  Run 'agentx wiki absorb' to compile all, or 'agentx wiki absorb --agent <id>' for one agent"))
      console.log()
    }
  })

// agentx wiki lint
wiki
  .command("lint")
  .description("check wiki for issues per agent")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "lint a specific agent's wiki")
  .action((opts) => {
    const hub = getHub(opts.dir)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()
    let totalIssues = 0

    console.log()
    for (const agentId of agents) {
      const store = hub.getAgentWiki(agentId)
      const issues = store.lint()
      totalIssues += issues.length

      if (issues.length === 0) {
        console.log(`  ${chalk.cyan(agentId)}: ${chalk.green("healthy")}`)
      } else {
        console.log(`  ${chalk.cyan(agentId)}: ${chalk.yellow(`${issues.length} issues`)}`)
        for (const issue of issues) {
          const icon = issue.type === "broken-link" ? "x" : issue.type === "orphan" ? "?" : "!"
          console.log(`    [${icon}] ${chalk.dim(issue.type)} ${issue.article}: ${issue.message}`)
        }
      }
    }

    console.log()
    if (totalIssues === 0) {
      console.log(chalk.green("  All agent wikis are healthy"))
    }
    console.log()
  })

// agentx wiki absorb — per-agent compilation
wiki
  .command("absorb")
  .description("compile unabsorbed entries into per-agent wiki articles")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "absorb only this agent")
  .option("--dry-run", "preview without running")
  .option("--max <n>", "max entries per agent", "20")
  .action(async (opts) => {
    const hub = getHub(opts.dir)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()
    const maxEntries = parseInt(opts.max)

    let totalAbsorbed = 0

    for (const agentId of agents) {
      const unabsorbed = hub.getUnabsorbedEntries(agentId).slice(0, maxEntries)

      if (unabsorbed.length === 0) {
        console.log(`  ${chalk.cyan(agentId)}: ${chalk.green("all absorbed")}`)
        continue
      }

      console.log()
      console.log(chalk.bold(`  ${chalk.cyan(agentId)}: ${unabsorbed.length} entries to absorb`))
      for (const e of unabsorbed.slice(0, 3)) {
        console.log(chalk.dim(`    [${e.date} via ${e.source}] ${e.content.slice(0, 80)}...`))
      }
      if (unabsorbed.length > 3) console.log(chalk.dim(`    ... and ${unabsorbed.length - 3} more`))

      if (opts.dryRun) continue

      // Get this agent's wiki store
      const agentWiki = hub.getAgentWiki(agentId)

      // Build prompt with existing articles for this agent
      const existingIndex = agentWiki.rebuildIndex()
      const existingList = existingIndex.articles.length > 0
        ? `\nExisting articles in this agent's wiki:\n${existingIndex.articles.map(a => `- ${a.title} (${a.path})`).join("\n")}\n`
        : ""

      const entryTexts = unabsorbed.map(e =>
        `--- ENTRY ${e.id} [${e.date} ${e.agentId} via ${e.source}] ---\n${e.content}\n--- END ENTRY ---`
      ).join("\n\n")

      const prompt = `You are a wiki editor compiling knowledge for the "${agentId}" agent. Read these ${unabsorbed.length} conversation entries and produce structured wiki articles.
${existingList}
Rules:
1. Group related entries into articles by topic
2. Synthesize information — don't just copy-paste conversations
3. Use wikilinks [[Article Title]] to cross-reference related articles
4. If an existing article covers the topic, produce an UPDATE with the full merged content
5. Output ONLY valid JSON — no markdown fencing, no explanation

Output format (JSON array):
[
  {
    "path": "projects/example.md",
    "title": "Example Article",
    "type": "process",
    "content": "Synthesized content here...",
    "sources": ["entry-id-1", "entry-id-2"]
  }
]

Valid types: concept, process, project, decision, person, pattern, incident, report

ENTRIES:

${entryTexts}`

      // Write prompt and run Claude
      const tmpDir = resolve(agentWiki["baseDir"], "_tmp")
      mkdirSync(tmpDir, { recursive: true })
      const promptPath = resolve(tmpDir, "absorb-prompt.txt")
      writeFileSync(promptPath, prompt)

      console.log(chalk.dim(`    Compiling with Claude...`))

      try {
        let rawOutput: string
        try {
          rawOutput = execSync(
            `cat '${promptPath}' | claude -p - --output-format json --max-turns 5`,
            { encoding: "utf-8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
          )
        } catch (execErr: any) {
          rawOutput = execErr.stdout || ""
          if (!rawOutput) throw execErr
        }

        let responseText: string
        try {
          const jsonOut = JSON.parse(rawOutput)
          responseText = jsonOut.result || jsonOut.content || rawOutput
        } catch {
          responseText = rawOutput
        }

        const jsonMatch = responseText.match(/\[[\s\S]*\]/)
        if (!jsonMatch) {
          console.log(chalk.red(`    Claude didn't return valid JSON`))
          console.log(chalk.dim(responseText.slice(0, 300)))
          continue
        }

        const articles = JSON.parse(jsonMatch[0]) as Array<{
          path: string; title: string; type: string; content: string; sources: string[]
        }>

        for (const article of articles) {
          const now = new Date().toISOString().slice(0, 10)
          agentWiki.writeArticle(article.path, {
            title: article.title,
            type: article.type as any,
            owner: agentId,
            access: "internal",
            created: now,
            lastUpdated: now,
            related: [],
            sources: article.sources,
          }, article.content, agentId)

          console.log(`    ${chalk.green("+")} ${article.path}: ${article.title}`)
          totalAbsorbed++
        }

        agentWiki.rebuildIndex()
      } catch (e: any) {
        console.log(chalk.red(`    Absorb failed: ${e.message?.slice(0, 200)}`))
        if (e.stderr) console.log(chalk.dim(String(e.stderr).slice(0, 300)))
        if (e.stdout) console.log(chalk.dim("stdout: " + String(e.stdout).slice(0, 300)))
      }
    }

    console.log()
    if (opts.dryRun) {
      console.log(chalk.dim("  Dry run — no changes made"))
    } else if (totalAbsorbed > 0) {
      console.log(chalk.green(`  ${totalAbsorbed} articles compiled across ${agents.length} agent(s)`))
    }
    console.log()
  })

// agentx wiki entries
wiki
  .command("entries")
  .description("list raw entries")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "filter by agent")
  .action((opts) => {
    const hub = getHub(opts.dir)
    const shared = hub.getSharedStore()
    let entries = shared.listEntries()

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

// agentx wiki serve
wiki
  .command("serve")
  .description("start a local web server to browse agent wikis")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "serve only this agent's wiki")
  .option("--port <n>", "port number", "4200")
  .action((opts) => {
    const dir = opts.dir || resolve(process.cwd(), ".agentx/wiki")
    const port = parseInt(opts.port)

    console.log()
    console.log(chalk.bold("  AgentX Wiki Server"))
    console.log()
    console.log(`  ${chalk.green(">")} http://localhost:${port}`)
    if (opts.agent) {
      console.log(`  Agent: ${chalk.cyan(opts.agent)}`)
    } else {
      console.log(`  Mode: ${chalk.cyan("Hub")} (all agents)`)
    }
    console.log(chalk.dim(`  Wiki: ${dir}`))
    console.log(chalk.dim("  Press Ctrl+C to stop"))
    console.log()

    startWikiServer(dir, port, opts.agent)
  })

// agentx wiki search <query>
wiki
  .command("search <query>")
  .description("search wiki articles")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "search specific agent's wiki")
  .action((query, opts) => {
    const hub = getHub(opts.dir)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()

    console.log()
    let found = 0

    for (const agentId of agents) {
      const store = hub.getAgentWiki(agentId)
      const results = store.findRelevant(query, undefined, 10)

      if (results.length > 0) {
        console.log(chalk.bold(`  ${chalk.cyan(agentId)}:`))
        for (const r of results) {
          console.log(`    ${r.meta.title} (${r.meta.type})`)
          console.log(chalk.dim(`      ${r.path} — ${r.content.slice(0, 100)}...`))
        }
        found += results.length
      }
    }

    if (found === 0) console.log(chalk.dim("  No matching articles"))
    console.log()
  })
