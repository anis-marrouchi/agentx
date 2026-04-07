import { Command } from "commander"
import chalk from "chalk"
import { WikiHub } from "@/wiki"
import type { WikiMode } from "@/wiki/hub"
import { startWikiServer } from "@/wiki/serve"
import { buildAbsorbPrompt } from "@/wiki/prompts"
import { resolve } from "path"
import { execSync } from "child_process"
import { writeFileSync, mkdirSync } from "fs"

function getHub(dir?: string, mode?: WikiMode): WikiHub {
  return new WikiHub(dir || resolve(process.cwd(), ".agentx/wiki"), undefined, mode || "graph")
}

function modeLabel(mode: WikiMode): string {
  if (mode === "graph") return "Knowledge Graph"
  if (mode === "flat") return "Karpathy Flat"
  return "Unified"
}

export const wiki = new Command()
  .name("wiki")
  .description("wiki knowledge base management")

// agentx wiki status
wiki
  .command("status")
  .description("show wiki status per agent")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "unified (default), graph, or flat", "unified")
  .action((opts) => {
    const mode = opts.mode as WikiMode
    const hub = getHub(opts.dir, mode)
    const agents = hub.summary()
    const shared = hub.getSharedStore()
    const totalEntries = shared.listEntries().length

    console.log()
    console.log(chalk.bold(`  Wiki Hub Status [${modeLabel(mode)}]`))
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
  .option("--mode <mode>", "unified (default), graph, or flat", "unified")
  .option("--agent <id>", "lint a specific agent's wiki")
  .action((opts) => {
    const hub = getHub(opts.dir, opts.mode as WikiMode)
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
  .option("--mode <mode>", "unified (default), graph, or flat", "unified")
  .option("--agent <id>", "absorb only this agent")
  .option("--dry-run", "preview without running")
  .option("--max <n>", "max entries per agent", "20")
  .action(async (opts) => {
    const mode = opts.mode as WikiMode
    const hub = getHub(opts.dir, mode)
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

      // Build prompt using mode-specific template
      const existingIndex = agentWiki.rebuildIndex()
      const worldview = agentWiki.getWorldview() || hub.getSharedStore().getWorldview() || ""
      const entryTexts = unabsorbed.map(e =>
        `--- ENTRY ${e.id} [${e.date} ${e.agentId} via ${e.source}] ---\n${e.content}\n--- END ENTRY ---`
      ).join("\n\n")

      const prompt = buildAbsorbPrompt(mode, agentId, worldview, existingIndex.articles, entryTexts, unabsorbed.length)
      console.log(chalk.dim(`    Mode: ${modeLabel(mode)}`))

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
            `cat '${promptPath}' | claude -p - --output-format json --max-turns 3 --model sonnet --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`,
            { encoding: "utf-8", timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
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
  .description("start a local web server to browse agent wikis (local + mesh)")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "unified (default), graph, or flat", "unified")
  .option("--agent <id>", "serve only this agent's wiki")
  .option("--port <n>", "port number", "4200")
  .option("--peer <urls...>", "mesh peer URLs to federate")
  .action(async (opts) => {
    const dir = opts.dir || resolve(process.cwd(), ".agentx/wiki")
    const port = parseInt(opts.port)

    // Auto-discover peers from daemon config if not specified
    let peerUrls: string[] = opts.peer || []
    if (peerUrls.length === 0) {
      try {
        const { loadDaemonConfig } = await import("@/daemon/config")
        const config = loadDaemonConfig()
        peerUrls = (config.mesh?.peers || []).map((p: any) => p.url)
      } catch { /* no config */ }
    }

    console.log()
    console.log(chalk.bold("  AgentX Wiki Server"))
    console.log()
    console.log(`  ${chalk.green(">")} http://localhost:${port}`)
    if (opts.agent) {
      console.log(`  Agent: ${chalk.cyan(opts.agent)}`)
    } else {
      console.log(`  Mode: ${chalk.cyan("Hub")} (all agents)`)
    }
    if (peerUrls.length > 0) {
      console.log(`  Mesh: ${chalk.cyan(peerUrls.length + " peer(s)")} — ${peerUrls.join(", ")}`)
    }
    console.log(chalk.dim(`  Wiki: ${dir}`))
    console.log(chalk.dim("  Press Ctrl+C to stop"))
    console.log()

    startWikiServer(dir, port, opts.agent, peerUrls, opts.mode as WikiMode)
  })

// agentx wiki search <query>
wiki
  .command("search <query>")
  .description("search wiki articles")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "unified (default), graph, or flat", "unified")
  .option("--agent <id>", "search specific agent's wiki")
  .action((query, opts) => {
    const hub = getHub(opts.dir, opts.mode as WikiMode)
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

// agentx wiki sync — pull entries from mesh peers
wiki
  .command("sync")
  .description("pull raw entries from mesh peers into local wiki")
  .option("--dir <path>", "wiki directory")
  .option("--peer <url>", "sync from a specific peer URL (e.g., http://100.67.108.119:19900)")
  .option("--dry-run", "show what would be synced without writing")
  .action(async (opts) => {
    const hub = getHub(opts.dir)
    const shared = hub.getSharedStore()

    // Discover peers: from --peer flag, or from local daemon config
    let peerUrls: string[] = []

    if (opts.peer) {
      peerUrls = [opts.peer]
    } else {
      // Try to read mesh peers from local daemon
      try {
        const { loadDaemonConfig } = await import("@/daemon/config")
        const config = loadDaemonConfig()
        peerUrls = (config.mesh?.peers || []).map((p: any) => p.url)
      } catch {
        console.log(chalk.red("  No --peer specified and no daemon config found"))
        console.log(chalk.dim("  Usage: agentx wiki sync --peer http://100.67.108.119:19900"))
        return
      }
    }

    if (peerUrls.length === 0) {
      console.log(chalk.dim("  No mesh peers configured"))
      return
    }

    // Get existing entry IDs to avoid duplicates
    const existingIds = new Set(shared.listEntries().map(e => e.id))

    let totalSynced = 0

    for (const peerUrl of peerUrls) {
      console.log()
      console.log(chalk.bold(`  Syncing from ${peerUrl}...`))

      try {
        // Fetch entries from peer
        const res = await fetch(`${peerUrl}/wiki/entries`, { signal: AbortSignal.timeout(10000) })
        if (!res.ok) {
          console.log(chalk.red(`    HTTP ${res.status}`))
          continue
        }

        const data = await res.json() as any
        const entries = data.entries || []
        const nodeId = data.nodeId || "unknown"

        console.log(chalk.dim(`    Node: ${nodeId} — ${entries.length} entries`))

        let newCount = 0
        for (const entry of entries) {
          if (existingIds.has(entry.id)) continue

          if (!opts.dryRun) {
            shared.addEntry({
              id: entry.id,
              date: entry.date,
              agentId: entry.agentId,
              source: `${entry.source}@${nodeId}`,  // Tag source with node
              sourceContext: entry.sourceContext,
              content: entry.content,
            })
            existingIds.add(entry.id)
          }
          newCount++
        }

        if (newCount > 0) {
          console.log(chalk.green(`    ${newCount} new entries${opts.dryRun ? " (dry run)" : " synced"}`))
        } else {
          console.log(chalk.dim("    Already up to date"))
        }

        totalSynced += newCount

        // Also show remote agents summary
        try {
          const agentsRes = await fetch(`${peerUrl}/wiki/agents`, { signal: AbortSignal.timeout(5000) })
          if (agentsRes.ok) {
            const agentsData = await agentsRes.json() as any
            for (const agent of (agentsData.agents || [])) {
              if (agent.totalEntries > 0) {
                console.log(chalk.dim(`      ${agent.agentId}: ${agent.totalEntries} entries, ${agent.totalArticles} articles`))
              }
            }
          }
        } catch { /* optional */ }

      } catch (e: any) {
        if (e.cause?.code === "ECONNREFUSED") {
          console.log(chalk.red(`    Connection refused`))
        } else {
          console.log(chalk.red(`    ${e.message}`))
        }
      }
    }

    console.log()
    if (totalSynced > 0 && !opts.dryRun) {
      console.log(chalk.green(`  ${totalSynced} entries synced. Run 'agentx wiki absorb' to compile.`))
    } else if (totalSynced > 0) {
      console.log(chalk.dim(`  ${totalSynced} entries would be synced (dry run)`))
    } else {
      console.log(chalk.dim("  All peers up to date"))
    }
    console.log()
  })

// agentx wiki compare — deterministic comparison of all three modes
wiki
  .command("compare")
  .description("compare all wiki compilation modes for an agent")
  .option("--dir <path>", "wiki directory")
  .requiredOption("--agent <id>", "agent to compare")
  .action((opts) => {
    const dir = opts.dir || resolve(process.cwd(), ".agentx/wiki")
    const agentId = opts.agent
    const modes: WikiMode[] = ["flat", "graph", "unified"]

    // Collect stats per mode
    const stats = modes.map(mode => {
      const hub = new WikiHub(dir, undefined, mode)
      const wiki = hub.getAgentWiki(agentId)
      const index = wiki.rebuildIndex()
      const entries = hub.getAgentEntries(agentId)
      const unabsorbed = hub.getUnabsorbedEntries(agentId)

      const tags = new Set<string>()
      let totalTags = 0
      const sources = new Set<string>()
      for (const a of index.articles) {
        for (const t of (a.tags || [])) tags.add(t)
        totalTags += (a.tags?.length || 0)
        for (const s of (a.sources || [])) sources.add(s)
      }
      const dirs = new Set(index.articles.map(a => a.path.includes("/") ? a.path.split("/")[0] : "/"))

      return {
        mode,
        label: modeLabel(mode),
        articles: index.articles.length,
        entries: entries.length,
        unabsorbed: unabsorbed.length,
        uniqueTags: tags.size,
        avgTags: index.articles.length > 0 ? (totalTags / index.articles.length).toFixed(1) : "0",
        dirs: dirs.size,
        coverage: sources.size,
        articleList: index.articles,
      }
    })

    console.log()
    console.log(chalk.bold(`  Wiki Compare: ${agentId}`))
    console.log(`  Raw entries: ${stats[0].entries}`)
    console.log()

    // Table header
    const w = 22
    console.log(`  ${"".padEnd(20)} ${stats.map(s => s.label.padEnd(w)).join(" ")}`)
    console.log(`  ${"─".repeat(20)} ${stats.map(() => "─".repeat(w)).join(" ")}`)

    const rows: Array<[string, (s: typeof stats[0]) => string]> = [
      ["Articles", s => String(s.articles)],
      ["Unabsorbed", s => String(s.unabsorbed)],
      ["Unique tags", s => String(s.uniqueTags)],
      ["Avg tags/article", s => s.avgTags],
      ["Directories", s => String(s.dirs)],
      ["Entry coverage", s => `${s.coverage}/${s.entries}`],
    ]

    for (const [label, fn] of rows) {
      const vals = stats.map(s => fn(s).padEnd(w))
      console.log(`  ${label.padEnd(20)} ${vals.join(" ")}`)
    }

    console.log()

    // Best in each category
    const best = (key: "uniqueTags" | "articles" | "coverage", label: string) => {
      const max = Math.max(...stats.map(s => s[key] as number))
      const winners = stats.filter(s => (s[key] as number) === max).map(s => s.label)
      if (max > 0) console.log(chalk.dim(`  Best ${label}: ${winners.join(", ")} (${max})`))
    }
    best("uniqueTags", "tag richness")
    best("articles", "article count")
    best("coverage", "entry coverage")

    console.log()
  })
