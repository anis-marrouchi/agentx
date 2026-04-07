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
  return mode === "graph" ? "Knowledge Graph" : "Karpathy Flat"
}

export const wiki = new Command()
  .name("wiki")
  .description("wiki knowledge base management")

// agentx wiki status
wiki
  .command("status")
  .description("show wiki status per agent")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "compilation mode: graph (default) or flat", "graph")
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
  .option("--mode <mode>", "graph or flat", "graph")
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
  .option("--mode <mode>", "graph (default) or flat", "graph")
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
  .description("start a local web server to browse agent wikis (local + mesh)")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph (default) or flat", "graph")
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
  .option("--mode <mode>", "graph or flat", "graph")
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

// agentx wiki compare — deterministic comparison of flat vs graph
wiki
  .command("compare")
  .description("compare flat vs graph compilation for an agent")
  .option("--dir <path>", "wiki directory")
  .requiredOption("--agent <id>", "agent to compare")
  .action((opts) => {
    const dir = opts.dir || resolve(process.cwd(), ".agentx/wiki")
    const flatHub = new WikiHub(dir, undefined, "flat")
    const graphHub = new WikiHub(dir, undefined, "graph")
    const agentId = opts.agent

    const flatWiki = flatHub.getAgentWiki(agentId)
    const graphWiki = graphHub.getAgentWiki(agentId)
    const flatIndex = flatWiki.rebuildIndex()
    const graphIndex = graphWiki.rebuildIndex()
    const entries = flatHub.getAgentEntries(agentId)
    const flatUnabsorbed = flatHub.getUnabsorbedEntries(agentId)
    const graphUnabsorbed = graphHub.getUnabsorbedEntries(agentId)

    console.log()
    console.log(chalk.bold(`  Wiki Compare: ${agentId}`))
    console.log()
    console.log(`  Raw entries: ${entries.length}`)
    console.log()

    // Side by side stats
    const w = 35
    console.log(`  ${"Karpathy Flat".padEnd(w)} ${"Knowledge Graph".padEnd(w)}`)
    console.log(`  ${"─".repeat(w)} ${"─".repeat(w)}`)
    console.log(`  ${"Articles: " + flatIndex.articles.length}${" ".repeat(w - ("Articles: " + flatIndex.articles.length).length)} ${"Articles: " + graphIndex.articles.length}`)
    console.log(`  ${"Unabsorbed: " + flatUnabsorbed.length}${" ".repeat(w - ("Unabsorbed: " + flatUnabsorbed.length).length)} ${"Unabsorbed: " + graphUnabsorbed.length}`)

    // Flat tags
    const flatTags = new Set<string>()
    for (const a of flatIndex.articles) for (const t of (a.tags || [])) flatTags.add(t)
    const graphTags = new Set<string>()
    for (const a of graphIndex.articles) for (const t of (a.tags || [])) graphTags.add(t)
    console.log(`  ${"Unique tags: " + flatTags.size}${" ".repeat(w - ("Unique tags: " + flatTags.size).length)} ${"Unique tags: " + graphTags.size}`)

    // Average tags per article
    const flatAvg = flatIndex.articles.length > 0
      ? (flatIndex.articles.reduce((s, a) => s + (a.tags?.length || 0), 0) / flatIndex.articles.length).toFixed(1)
      : "0"
    const graphAvg = graphIndex.articles.length > 0
      ? (graphIndex.articles.reduce((s, a) => s + (a.tags?.length || 0), 0) / graphIndex.articles.length).toFixed(1)
      : "0"
    console.log(`  ${"Avg tags/article: " + flatAvg}${" ".repeat(w - ("Avg tags/article: " + flatAvg).length)} ${"Avg tags/article: " + graphAvg}`)

    // Directory structure
    const flatDirs = new Set(flatIndex.articles.map(a => a.path.includes("/") ? a.path.split("/")[0] : "/"))
    const graphDirs = new Set(graphIndex.articles.map(a => a.path.includes("/") ? a.path.split("/")[0] : "/"))
    console.log(`  ${"Directories: " + flatDirs.size}${" ".repeat(w - ("Directories: " + flatDirs.size).length)} ${"Directories: " + graphDirs.size}`)

    console.log()

    // List articles side by side
    if (flatIndex.articles.length > 0 || graphIndex.articles.length > 0) {
      console.log(chalk.bold("  Articles:"))
      console.log()

      const maxLen = Math.max(flatIndex.articles.length, graphIndex.articles.length)
      for (let i = 0; i < maxLen; i++) {
        const f = flatIndex.articles[i]
        const g = graphIndex.articles[i]
        const fStr = f ? `${f.title.slice(0, 30)}` : ""
        const gStr = g ? `${g.title.slice(0, 30)}` : ""
        console.log(`  ${fStr.padEnd(w)} ${gStr}`)
        const fTags = f ? chalk.dim(`[${(f.tags || []).slice(0, 3).join(", ")}]`) : ""
        const gTags = g ? chalk.dim(`[${(g.tags || []).slice(0, 3).join(", ")}]`) : ""
        console.log(`  ${fTags}${"".padEnd(Math.max(0, w - (fTags.length - 10)))} ${gTags}`)
      }
    }

    // Overlap: articles covering similar topics (by shared sources)
    const flatSourceMap = new Map<string, string[]>()
    for (const a of flatIndex.articles) {
      for (const s of (a.sources || [])) {
        const list = flatSourceMap.get(s) || []
        list.push(a.title)
        flatSourceMap.set(s, list)
      }
    }
    const graphSourceMap = new Map<string, string[]>()
    for (const a of graphIndex.articles) {
      for (const s of (a.sources || [])) {
        const list = graphSourceMap.get(s) || []
        list.push(a.title)
        graphSourceMap.set(s, list)
      }
    }

    // Find entries covered by both
    const bothCovered = [...flatSourceMap.keys()].filter(s => graphSourceMap.has(s))
    const flatOnly = [...flatSourceMap.keys()].filter(s => !graphSourceMap.has(s))
    const graphOnly = [...graphSourceMap.keys()].filter(s => !flatSourceMap.has(s))

    console.log()
    console.log(chalk.bold("  Coverage:"))
    console.log(`  Entries covered by both: ${bothCovered.length}`)
    console.log(`  Flat-only coverage:      ${flatOnly.length}`)
    console.log(`  Graph-only coverage:     ${graphOnly.length}`)
    console.log()
  })
