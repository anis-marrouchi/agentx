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
          console.log(chalk.dim(`      - ${a.title} [${(a.tags || []).slice(0, 3).join(", ")}]`))
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

      // Build context: existing articles + worldview
      const existingIndex = agentWiki.rebuildIndex()
      const existingList = existingIndex.articles.length > 0
        ? `\nExisting articles:\n${existingIndex.articles.map(a => `- ${a.title} [${(a.tags || []).join(", ")}] (${a.path})`).join("\n")}\n`
        : ""

      // Read worldview from both agent wiki and shared wiki
      const worldview = agentWiki.getWorldview() || hub.getSharedStore().getWorldview() || ""
      const worldviewSection = worldview
        ? `\n## Worldview (the user's mental model — use this to understand context)\n\n${worldview}\n`
        : ""

      const entryTexts = unabsorbed.map(e =>
        `--- ENTRY ${e.id} [${e.date} ${e.agentId} via ${e.source}] ---\n${e.content}\n--- END ENTRY ---`
      ).join("\n\n")

      const prompt = `You are a wiki editor for the "${agentId}" agent. Compile raw entries into a personal wiki.

## Karpathy Pattern

- Plain markdown files. YOU choose the path and structure — it emerges from the data.
- Tag AGGRESSIVELY. Tags are the #1 mechanism for context narrowing.
- Use [[wikilinks]] to cross-reference between articles.
- Synthesize — distill conversations into factual wiki articles, don't copy-paste.
- If an existing article covers the topic, produce an UPDATE with full merged content.
${worldviewSection}${existingList}
## Tagging Rules

Tag every article with ALL relevant dimensions:
- WHO: people, agents, teams involved (e.g., "nadia", "devops-agent", "anis")
- WHAT: project, client, topic, technology (e.g., "mtgl", "seo", "gitlab", "deploy")
- WHEN: dates, periods (e.g., "2026-04-06", "week-14")
- WHERE: server, environment, channel (e.g., "staging", "telegram", "production")
- HOW: type of knowledge (e.g., "process", "incident", "report", "decision")

Use section tags for subsections: \`<!-- tags: runbook, staging -->\`

## Gap Detection

After compiling, add a "gaps" array — topics MENTIONED but not yet covered.
Example: if entries mention "production server" but no article exists for it, flag it.

## Output — ONLY valid JSON, no markdown fencing

{
  "articles": [
    {
      "path": "mtgl/staging-deploy.md",
      "title": "MTGL Staging Deployment",
      "tags": ["mtgl", "deploy", "staging", "devops", "process", "2026-04-06"],
      "content": "How we deploy MTGL to staging...\\n\\nSee also [[MTGL Project]]\\n\\n## Steps\\n<!-- tags: runbook, staging -->\\n1. ...",
      "sources": ["entry-id-1", "entry-id-2"]
    }
  ],
  "gaps": [
    "MTGL production server — mentioned but no article exists",
    "Hasana project — referenced but undocumented"
  ]
}

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
            `cat '${promptPath}' | claude -p - --output-format json --max-turns 3 --model sonnet --allowedTools ""`,
            { encoding: "utf-8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
          )
        } catch (execErr: any) {
          rawOutput = execErr.stdout || ""
          if (!rawOutput) throw execErr
        }

        // Parse Claude's response — may be JSON envelope or raw text
        let responseText = rawOutput

        // Try to extract "result" from Claude's JSON envelope
        try {
          const envelope = JSON.parse(rawOutput)
          responseText = envelope.result || envelope.content || ""
          if (!responseText) {
            console.log(chalk.dim(`    Claude envelope keys: ${Object.keys(envelope).join(", ")}`))
            console.log(chalk.dim(`    is_error: ${envelope.is_error}, stop_reason: ${envelope.stop_reason}`))
          }
        } catch {
          // Not a JSON envelope — use as-is
        }

        // Parse response — could be { articles: [...], gaps: [...] } or bare [...]
        let articles: Array<{ path: string; title: string; tags: string[]; content: string; sources: string[] }>
        let gaps: string[] = []

        // Find outermost JSON object or array
        const objStart = responseText.indexOf("{")
        const arrStart = responseText.indexOf("[")
        const jsonStart = (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) ? objStart : arrStart

        if (jsonStart === -1) {
          console.log(chalk.red(`    No JSON found in response`))
          console.log(chalk.dim(responseText.slice(0, 500)))
          continue
        }

        const openChar = responseText[jsonStart]
        const closeChar = openChar === "{" ? "}" : "]"
        let depth = 0
        let jsonEnd = -1
        for (let i = jsonStart; i < responseText.length; i++) {
          if (responseText[i] === openChar) depth++
          else if (responseText[i] === closeChar) { depth--; if (depth === 0) { jsonEnd = i + 1; break } }
        }

        if (jsonEnd === -1) { console.log(chalk.red(`    Unbalanced JSON`)); continue }

        const jsonStr = responseText.slice(jsonStart, jsonEnd)
        try {
          const parsed = JSON.parse(jsonStr)
          if (Array.isArray(parsed)) {
            articles = parsed
          } else {
            articles = parsed.articles || []
            gaps = parsed.gaps || []
          }
        } catch (parseErr: any) {
          console.log(chalk.red(`    JSON parse error: ${parseErr.message}`))
          console.log(chalk.dim(`    First 300 chars: ${jsonStr.slice(0, 300)}`))
          continue
        }

        for (const article of articles) {
          const now = new Date().toISOString().slice(0, 10)
          agentWiki.writeArticle(article.path, {
            title: article.title,
            tags: article.tags || [],
            owner: agentId,
            access: "public",
            created: now,
            lastUpdated: now,
            sources: article.sources || [],
          }, article.content, agentId)

          const tagStr = (article.tags || []).slice(0, 5).join(", ")
          console.log(`    ${chalk.green("+")} ${article.path}: ${article.title}`)
          if (tagStr) console.log(chalk.dim(`       [${tagStr}]`))
          totalAbsorbed++
        }

        // Show gaps (missing puzzle pieces)
        if (gaps.length > 0) {
          console.log()
          console.log(chalk.yellow(`    Gaps detected (${gaps.length} missing pieces):`))
          for (const gap of gaps) {
            console.log(chalk.yellow(`      ? ${gap}`))
          }
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
          console.log(`    ${r.meta.title} [${(r.meta.tags || []).slice(0, 3).join(", ")}]`)
          console.log(chalk.dim(`      ${r.path} — ${r.content.slice(0, 100)}...`))
        }
        found += results.length
      }
    }

    if (found === 0) console.log(chalk.dim("  No matching articles"))
    console.log()
  })
