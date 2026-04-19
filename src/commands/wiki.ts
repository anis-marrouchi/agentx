import { Command } from "commander"
import chalk from "chalk"
import { WikiHub } from "@/wiki"
import type { WikiMode } from "@/wiki/hub"
import { startWikiServer } from "@/wiki/serve"
import { buildAbsorbPrompt } from "@/wiki/prompts"
import { resolve, relative, dirname } from "path"
import { execSync } from "child_process"
import { writeFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, existsSync } from "fs"

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
  .option("--mode <mode>", "graph (default, canonical) | unified | flat (legacy, back-compat)", "graph")
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
      console.log(chalk.dim(`  ${totalUnabsorbed} raw entries on disk. Absorb is deprecated — see 'agentx wiki absorb --help'.`))
      console.log()
    }
  })

// agentx wiki lint
wiki
  .command("lint")
  .description("check wiki for issues per agent")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph (default, canonical) | unified | flat (legacy, back-compat)", "graph")
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

// agentx wiki absorb — Farzapedia-faithful compilation.
// Reads unabsorbed raw entries, classifies by type, writes articles with
// wikilinked `related`, updates the catalog. Phase 4 un-gated this after
// the query + prune layers landed; see docs/blog/wiki-karpathy-review.
wiki
  .command("absorb")
  .description("compile unabsorbed entries into typed per-agent wiki articles (Farzapedia-faithful)")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph (default, canonical) | unified | flat (legacy, back-compat)", "graph")
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

        // Find outermost JSON object or array. New prompt emits { articles, gaps };
        // legacy arrays are tolerated for back-compat during migration.
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
            type: article.type as any,
            related: Array.isArray(article.related) ? article.related : undefined,
            tags: article.tags || [],
            owner: agentId,
            access: "public",
            created: now,
            lastUpdated: now,
            sources: article.sources || [],
          }, article.content, agentId)

          const typeTag = article.type ? chalk.magenta(`[${article.type}]`) + " " : ""
          const relStr = Array.isArray(article.related) && article.related.length
            ? ` → ${article.related.slice(0, 3).join(", ")}${article.related.length > 3 ? ", …" : ""}`
            : ""
          console.log(`    ${chalk.green("+")} ${typeTag}${article.path}: ${article.title}${chalk.dim(relStr)}`)
          const tagStr = (article.tags || []).slice(0, 4).join(", ")
          if (tagStr) console.log(chalk.dim(`       tags: ${tagStr}`))
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

// agentx wiki ab-test — compare old BM25 preload vs new agentic query on
// real messages pulled from .agentx/task-history. Emits a markdown report
// with both retrieval paths side-by-side so the operator can rate.
wiki
  .command("ab-test")
  .description("side-by-side comparison: BM25 preload (old) vs agentic query (new) on real task-history messages")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "which agent to test against (required)")
  .option("--history <path>", "task-history root", resolve(process.cwd(), ".agentx/task-history"))
  .option("--n <n>", "number of messages to sample (newest first)", "10")
  .option("--out <path>", "markdown output file (default: stdout)")
  .option("--selector-model <m>", "agentic selector model", "haiku")
  .option("--synth-model <m>", "agentic synthesis model", "sonnet")
  .action(async (opts) => {
    const { agenticQuery } = await import("@/wiki/query")
    const { readdirSync: rd, readFileSync: rf, existsSync: ex } = await import("fs")
    const { resolve: rv, join: jn } = await import("path")

    const hub = getHub(opts.dir)
    const agentId = opts.agent
    if (!agentId) {
      console.log(chalk.red("  --agent <id> is required"))
      return
    }
    const store = hub.getAgentWiki(agentId)
    const n = parseInt(opts.n)

    // Gather recent task messages from .agentx/task-history/<agent>/<YYYY-MM-DD>/*.json
    const agentHistDir = rv(opts.history, agentId)
    if (!ex(agentHistDir)) {
      console.log(chalk.yellow(`  no task-history at ${agentHistDir}`))
      return
    }
    type Task = { id: string; message: string; ts: string }
    const tasks: Task[] = []
    const days = rd(agentHistDir).sort().reverse()  // newest day first
    for (const day of days) {
      const dayDir = jn(agentHistDir, day)
      let files: string[] = []
      try { files = rd(dayDir).filter(f => f.endsWith(".json")).sort().reverse() } catch { continue }
      for (const f of files) {
        if (tasks.length >= n) break
        try {
          const rec = JSON.parse(rf(jn(dayDir, f), "utf-8"))
          const msg = rec.message || rec.task?.message
          if (typeof msg === "string" && msg.trim().length > 10) {
            tasks.push({ id: rec.id || f.replace(".json", ""), message: msg.trim(), ts: rec.at || rec.timestamp || day })
          }
        } catch {}
      }
      if (tasks.length >= n) break
    }

    if (tasks.length === 0) {
      console.log(chalk.yellow(`  no task messages found under ${agentHistDir}`))
      return
    }

    console.log()
    console.log(chalk.bold(`  A/B harness — ${tasks.length} messages from ${agentId}`))
    console.log(chalk.dim(`  OLD: findRelevant() BM25 over title+tags+content, top 3 truncated`))
    console.log(chalk.dim(`  NEW: agenticQuery() catalog+wikilink walk (selector=${opts.selectorModel}, synth=${opts.synthModel})`))
    console.log()

    const lines: string[] = [
      `# Wiki A/B: ${agentId}`,
      "",
      `_Generated ${new Date().toISOString()} · ${tasks.length} messages sampled_`,
      "",
      "For each message, the OLD BM25 retrieval (what Layer 10 used to preload) is shown alongside the NEW agentic query's selected articles + synthesized answer. Rate each pair on relevance 0–2 in the notes column.",
      "",
    ]

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]
      process.stdout.write(chalk.dim(`  [${i + 1}/${tasks.length}] querying... `))

      // OLD
      const old = store.findRelevant(t.message, agentId, 3)
      const oldTitles = old.map(a => `- **${a.meta.title}** [${a.meta.type || "?"}] (${a.path})`).join("\n") || "_(none returned)_"

      // NEW
      let newBlock: string
      try {
        const q = await agenticQuery(t.message, store, agentId, {
          selectorModel: opts.selectorModel,
          synthModel: opts.synthModel,
        })
        if (q.status !== "ok") {
          newBlock = `_(status: ${q.status}${q.error ? " — " + q.error : ""})_`
        } else {
          const cites = q.citations.map(c => `\`${c.title}\` [${c.type || "?"}]`).join(", ")
          newBlock = `**Answer:**\n\n${q.answer}\n\n**Citations:** ${cites}`
        }
      } catch (e: any) {
        newBlock = `_(error: ${e.message})_`
      }
      console.log(chalk.dim("done"))

      lines.push(
        `## ${i + 1}. ${t.id}`,
        "",
        `> ${t.message.replace(/\n/g, " ").slice(0, 400)}${t.message.length > 400 ? "…" : ""}`,
        "",
        "### OLD — BM25 preload (top 3)",
        "",
        oldTitles,
        "",
        "### NEW — agentic query",
        "",
        newBlock,
        "",
        "| Path | Rating 0–2 | Notes |",
        "|---|---|---|",
        "| OLD |   |   |",
        "| NEW |   |   |",
        "",
      )
    }

    const out = lines.join("\n")
    if (opts.out) {
      (await import("fs")).writeFileSync(opts.out, out)
      console.log()
      console.log(chalk.green(`  Wrote ${out.length} bytes to ${opts.out}`))
    } else {
      console.log()
      console.log(out)
    }
  })

// agentx wiki interview — interactive write-side for the wiki.
// Operator answers a short question bank per article type; an LLM
// synthesizes a Farzapedia-shape article from the transcript. Accounts
// for the "absorb only captures what's already been said in channels"
// gap — this is where knowledge lives in your head.
wiki
  .command("interview")
  .description("interactive interview session — Q&A with an LLM synthesizer, produces one typed wiki article")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "which agent's wiki to write to (required)")
  .option("--topic <text>", "what to interview about (e.g. 'MTGL deployment procedure')")
  .option("--type <t>", "article type hint (person|project|place|concept|event|decision|pattern)")
  .option("--model <m>", "synthesis model", "sonnet")
  .option("--no-commit", "show the draft but don't write")
  .option("--answers <path>", "non-interactive: one answer per line (same order as questions); last line = save|edit|scrap")
  .action(async (opts) => {
    const readline = await import("node:readline/promises")
    const { randomUUID } = await import("node:crypto")
    const { WIKI_ARTICLE_TYPES } = await import("@/wiki/types")

    // --answers: read all lines up front; feed them to each `ask()`.
    // Avoids readline/stdin interaction entirely for scripted runs.
    const scripted = opts.answers
      ? (readFileSync(opts.answers, "utf-8").split(/\r?\n/).filter(l => l.length > 0))
      : null
    let scriptCursor = 0

    if (!opts.agent) {
      console.log(chalk.red("  --agent <id> is required. The article will be owned by this agent."))
      return
    }
    const hub = getHub(opts.dir)
    let store
    try { store = hub.getAgentWiki(opts.agent) } catch (e: any) {
      console.log(chalk.red(`  can't open wiki for agent "${opts.agent}": ${e.message}`))
      return
    }

    const rl = scripted
      ? null
      : readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask = async (prompt: string): Promise<string> => {
      if (scripted) {
        const answer = scripted[scriptCursor++] ?? ""
        process.stdout.write(prompt + chalk.dim(`[scripted] ${answer.slice(0, 80)}${answer.length > 80 ? "…" : ""}`) + "\n")
        return answer.trim()
      }
      return (await rl!.question(prompt)).trim()
    }

    console.log()
    console.log(chalk.bold("  Wiki Interview"))
    console.log(chalk.dim("  One article per session. Empty answer = skip field. /done = stop & synthesize. /abort = quit."))
    console.log()

    // Topic
    let topic = opts.topic || ""
    if (!topic) {
      topic = await ask(chalk.cyan("  Topic? ") + chalk.dim("(a person, a procedure, a past event, …) "))
      if (!topic || topic === "/abort") { rl?.close(); return }
    }

    // Type
    let type = (opts.type || "").toLowerCase()
    const validTypes = new Set(WIKI_ARTICLE_TYPES as readonly string[])
    if (!validTypes.has(type)) {
      console.log(chalk.dim(`  Types: ${WIKI_ARTICLE_TYPES.join(" | ")}`))
      const picked = await ask(chalk.cyan("  Type? "))
      if (picked === "/abort") { rl?.close(); return }
      if (!validTypes.has(picked)) {
        console.log(chalk.yellow(`  "${picked}" isn't a valid type. Falling back to "concept".`))
        type = "concept"
      } else {
        type = picked
      }
    }

    // Question bank per type
    const QUESTIONS: Record<string, string[]> = {
      person: [
        "Full name (and any aliases / Telegram handle / GitLab username)?",
        "Role or title?",
        "Which org or team are they part of (use the article title if you have one)?",
        "Key responsibilities in OUR work?",
        "Preferred channel to reach them (Telegram, email, in-person, …)?",
        "Who do they report to? (skip if none)",
        "Notable decisions, events, or patterns they're involved in?",
        "Anything quirky we should remember (timezone, working hours, style)?",
      ],
      project: [
        "One-line description — what is this project?",
        "Who owns it? (person article title)",
        "Tech stack or key tools involved?",
        "Current status (active / paused / archived)?",
        "Repo / URL / path on disk?",
        "Two or three key decisions made so far?",
        "Any open blockers, risks, or known issues?",
        "Related projects or patterns?",
      ],
      place: [
        "Kind — office / server / environment / domain / URL?",
        "Address — URL, IP, hostname, or physical location?",
        "Owner (person or team)?",
        "How to access it (SSH host, login, VPN, …)?",
        "What lives there (services, people, data)?",
        "Known quirks (timezone, uptime, access restrictions)?",
      ],
      concept: [
        "Define it in one sentence — what does this term mean in OUR work?",
        "Where did we first adopt it (origin story, date)?",
        "Two or three concrete examples from our team?",
        "What does it replace or extend (older concept, related concept)?",
        "Common misunderstandings to avoid?",
      ],
      event: [
        "Date (YYYY-MM-DD)?",
        "One-line summary — what happened?",
        "Who was involved?",
        "Timeline — key moments (start → resolution)?",
        "Impact — what broke, what got delivered, who was affected?",
        "Resolution / outcome?",
        "Follow-ups or lessons captured?",
      ],
      decision: [
        "Context — what was the situation forcing a choice?",
        "Options that were considered?",
        "Chosen option — and one-sentence why?",
        "Alternatives rejected — and one-sentence why not?",
        "Who decided, and when (date)?",
        "Is this reversible, and what would trigger a revisit?",
      ],
      pattern: [
        "Trigger — when should someone follow this pattern?",
        "Inputs required (what do you need before starting)?",
        "Steps in order — keep it tight, one line per step?",
        "Expected output — how do you know it worked?",
        "Common failure modes?",
        "Related patterns, decisions, or runbooks?",
      ],
    }
    const questions = QUESTIONS[type] || QUESTIONS.concept

    // Ask each question
    console.log()
    console.log(chalk.bold(`  Topic: ${chalk.cyan(topic)}  ·  Type: ${chalk.magenta(type)}`))
    console.log(chalk.dim(`  ${questions.length} questions. Skip with empty answer. /done to stop early.`))
    console.log()

    type QA = { q: string; a: string }
    const qas: QA[] = []
    let aborted = false
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const a = await ask(`  ${chalk.dim(`[${i + 1}/${questions.length}]`)} ${q}\n  ${chalk.green(">")} `)
      if (a === "/abort") { aborted = true; break }
      if (a === "/done") break
      if (a === "/skip") continue
      if (a) qas.push({ q, a })
    }

    // Always ask for anything extra
    if (!aborted) {
      const extra = await ask(`\n  ${chalk.dim("Anything else worth capturing?")}\n  ${chalk.green(">")} `)
      if (extra && extra !== "/abort" && extra !== "/done") qas.push({ q: "Anything else worth capturing?", a: extra })
    }

    if (aborted || qas.length === 0) {
      console.log(chalk.yellow("\n  Nothing captured. Exiting."))
      rl?.close()
      return
    }

    // Build the catalog slice for wikilink grounding (first 40 titles max)
    const existingArticles = store.listArticles(opts.agent).slice(0, 40)
    const catalogLines = existingArticles
      .map(a => `- ${a.meta.title} [${a.meta.type || "?"}]`)
      .join("\n")

    const synthesisPrompt = [
      `You are compiling one Farzapedia-style wiki article from an operator interview transcript.`,
      ``,
      `**Topic:** ${topic}`,
      `**Type:** ${type}`,
      `**Owning agent:** ${opts.agent}`,
      ``,
      `## Transcript`,
      ...qas.map(x => `\nQ: ${x.q}\nA: ${x.a}`),
      ``,
      `## Existing articles (use [[Title]] wikilinks when referencing these)`,
      catalogLines || "(none yet)",
      ``,
      `## Output rules`,
      `- Output EXACTLY one markdown file: frontmatter (---) + body. No code fences, no preamble.`,
      `- Frontmatter fields in this exact order: title, type, related, tags, owner, access, created, last_updated, sources.`,
      `  - \`title\`: "…"`,
      `  - \`type\`: ${type}`,
      `  - \`related\`: ["Article Title", …]   (titles that exist in the catalog above; drop if none)`,
      `  - \`tags\`: 2-4 specific tags, lowercase-kebab — no dates unless type=event`,
      `  - \`owner\`: ${opts.agent}`,
      `  - \`access\`: public (unless the content is sensitive)`,
      `  - \`created\`: ${new Date().toISOString().slice(0, 10)}`,
      `  - \`last_updated\`: ${new Date().toISOString().slice(0, 10)}`,
      `  - \`sources\`: ["interview-${new Date().toISOString().slice(0, 10)}"]`,
      `- Body: 20-80 lines, Wikipedia-style, organized by theme (not by question), synthesized (not verbatim Q&A).`,
      `- Use [[Title]] inline every time you reference something that has an article in the catalog.`,
      `- Do NOT invent facts. If the transcript didn't cover something, skip that sub-topic.`,
    ].join("\n")

    // Write prompt to tmp, run claude -p
    const tmpDir = resolve(store.baseDir, "_tmp")
    mkdirSync(tmpDir, { recursive: true })
    const promptPath = resolve(tmpDir, `interview-${randomUUID().slice(0, 8)}.txt`)
    writeFileSync(promptPath, synthesisPrompt)

    console.log()
    console.log(chalk.dim(`  Synthesizing draft with ${opts.model}...`))

    let draft = ""
    try {
      const cmd = `cat '${promptPath}' | claude -p - --output-format json --max-turns 1 --model ${opts.model} --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`
      const raw = execSync(cmd, { encoding: "utf-8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
      try {
        const envelope = JSON.parse(raw)
        draft = String(envelope.result || envelope.content || "")
      } catch {
        draft = raw
      }
    } catch (e: any) {
      console.log(chalk.red(`  synthesis failed: ${e.message?.slice(0, 200)}`))
      rl?.close()
      return
    }

    // Strip any wrapping code fences / preamble
    draft = draft.trim()
    const fence = draft.match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
    if (fence) draft = fence[1].trim()
    // If there's a preamble before the `---`, drop it
    const fmStart = draft.indexOf("---")
    if (fmStart > 0) draft = draft.slice(fmStart)

    // Parse frontmatter to extract title + type
    const fmMatch = draft.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!fmMatch) {
      console.log(chalk.red("  LLM output is not a valid frontmatter+body article:"))
      console.log(draft.slice(0, 600))
      rl?.close()
      return
    }
    const fm: Record<string, string> = {}
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (m) fm[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1")
    }
    const body = fmMatch[2]
    const title = fm.title || topic
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
    const articlePath = `${type}s/${slug}.md`

    console.log()
    console.log(chalk.bold("  === Draft preview ==="))
    console.log(chalk.dim(`  Path: ${articlePath}`))
    console.log()
    console.log(draft)
    console.log()

    const choice = await ask(`  ${chalk.green("save")} / ${chalk.yellow("edit (opens $EDITOR)")} / ${chalk.red("scrap")} ? `)
    rl?.close()

    if (choice === "scrap" || choice === "/abort") {
      console.log(chalk.dim("  Discarded."))
      return
    }
    if (!opts.commit) {
      console.log(chalk.dim("  --no-commit: not writing."))
      console.log(chalk.dim(`  Draft kept at ${promptPath} (prompt only; no article file)`))
      return
    }

    // Optional editor pass
    let finalContent = body
    let finalMeta: Record<string, any> = {
      title,
      type: fm.type || type,
      related: fm.related
        ? fm.related.replace(/^\[|\]$/g, "").split(",").map(s => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)
        : undefined,
      tags: fm.tags
        ? fm.tags.replace(/^\[|\]$/g, "").split(",").map(s => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)
        : [],
      owner: opts.agent,
      access: fm.access || "public",
      created: fm.created || new Date().toISOString().slice(0, 10),
      lastUpdated: fm.last_updated || new Date().toISOString().slice(0, 10),
      sources: [`interview-${new Date().toISOString().slice(0, 10)}`],
    }

    if (choice === "edit") {
      const editor = process.env.EDITOR || "vi"
      const editPath = resolve(tmpDir, `draft-${randomUUID().slice(0, 8)}.md`)
      writeFileSync(editPath, draft)
      try {
        execSync(`${editor} '${editPath}'`, { stdio: "inherit" })
        const edited = require("fs").readFileSync(editPath, "utf-8")
        const m = edited.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
        if (m) {
          const ef: Record<string, string> = {}
          for (const line of m[1].split("\n")) {
            const mm = line.match(/^(\w+):\s*(.+)$/)
            if (mm) ef[mm[1]] = mm[2].trim().replace(/^"(.*)"$/, "$1")
          }
          finalContent = m[2]
          finalMeta = {
            ...finalMeta,
            title: ef.title || finalMeta.title,
            type: ef.type || finalMeta.type,
            access: ef.access || finalMeta.access,
            related: ef.related
              ? ef.related.replace(/^\[|\]$/g, "").split(",").map(s => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)
              : finalMeta.related,
            tags: ef.tags
              ? ef.tags.replace(/^\[|\]$/g, "").split(",").map(s => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)
              : finalMeta.tags,
          }
        }
      } catch (e: any) {
        console.log(chalk.red(`  editor failed: ${e.message}`))
        return
      }
    }

    // Write via the store — type validation kicks in
    const written = store.writeArticle(articlePath, finalMeta as any, finalContent, opts.agent)
    if (!written) {
      console.log(chalk.red("  write failed (permission?)"))
      return
    }
    store.rebuildIndex()
    console.log(chalk.green(`  ✓ ${articlePath} saved.`))

    // Suggest next topics from wikilinks in the body that don't yet exist
    const referenced = store.extractWikilinks(finalContent)
    const titleIdx = new Map<string, boolean>()
    for (const a of store.listArticles(opts.agent)) titleIdx.set(a.meta.title.toLowerCase(), true)
    const gaps = referenced.filter(r => !titleIdx.has(r.toLowerCase()))
    if (gaps.length) {
      console.log()
      console.log(chalk.bold("  Gaps referenced but not yet covered:"))
      for (const g of gaps.slice(0, 8)) {
        console.log(chalk.dim(`    - ${g}`))
      }
      console.log(chalk.dim(`  Run \`agentx wiki interview --agent ${opts.agent} --topic "<title>"\` for any of these.`))
    }
  })

// agentx wiki quiz — reverse interview: operator asks, agent answers
// via agenticQuery, operator grades with /ok /correct /add /link and the
// cited article gets patched. Grows the wiki through dialogue instead
// of structured extraction.
wiki
  .command("quiz")
  .description("reverse interview — ask the wiki questions and patch cited articles with corrections, additions, or links")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "which agent's wiki to quiz (required)")
  .option("--selector-model <m>", "candidate-selection model", "haiku")
  .option("--synth-model <m>", "answer synthesis model", "sonnet")
  .option("--patch-model <m>", "article patch model", "sonnet")
  .option("--rounds <n>", "stop after N rounds", "20")
  .option("--script <path>", "non-interactive: question line + /verdict line per entry, entries separated by blank lines")
  .option("--no-commit", "show proposed patches but don't write")
  .option("--out <path>", "write a session transcript as markdown")
  .action(async (opts) => {
    const readline = await import("node:readline/promises")
    const { randomUUID } = await import("node:crypto")
    const { agenticQuery } = await import("@/wiki/query")

    if (!opts.agent) {
      console.log(chalk.red("  --agent <id> is required."))
      return
    }
    const hub = getHub(opts.dir)
    let store
    try { store = hub.getAgentWiki(opts.agent) } catch (e: any) {
      console.log(chalk.red(`  can't open wiki for agent "${opts.agent}": ${e.message}`))
      return
    }

    type Script = { q: string; verdict: string }[]
    let script: Script | null = null
    if (opts.script) {
      const raw = readFileSync(opts.script, "utf-8")
      const entries = raw.split(/\n\s*\n/).map(e => e.trim()).filter(Boolean)
      script = []
      for (const entry of entries) {
        const lines = entry.split(/\r?\n/).filter(l => l.trim())
        if (lines.length < 2) continue
        const q = lines[0].replace(/^Q:\s*/i, "").trim()
        const verdict = lines.slice(1).join(" ").trim()
        if (q && verdict) script.push({ q, verdict })
      }
    }

    const rl = script
      ? null
      : readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask = async (prompt: string): Promise<string> => {
      if (rl) return (await rl.question(prompt)).trim()
      return ""
    }

    const rounds = Math.min(parseInt(opts.rounds) || 20, script?.length ?? 999)
    const commit = opts.commit !== false

    console.log()
    console.log(chalk.bold("  Wiki Quiz"))
    console.log(chalk.dim(`  Agent: ${opts.agent}  ·  Rounds: ${rounds}  ·  ${commit ? "commit" : "dry-run"}  ·  ${script ? `scripted (${script.length})` : "interactive"}`))
    console.log(chalk.dim("  Verdicts: /ok  /correct <note>  /add <note>  /link <url>  /skip  /done"))
    console.log()

    type Entry = { q: string; answer: string; citations: Array<{ title: string; path: string; type?: string }>; verdict: string; patched?: string }
    const transcript: Entry[] = []
    let applied = 0

    for (let i = 0; i < rounds; i++) {
      let q: string
      let verdict: string
      if (script) {
        const entry = script[i]
        if (!entry) break
        q = entry.q
        verdict = entry.verdict
        console.log(chalk.cyan(`  [${i + 1}] Q: `) + q)
      } else {
        q = await ask(chalk.cyan(`  [${i + 1}] Q: `))
        if (!q || q === "/done" || q === "/abort") break
        verdict = ""
      }

      process.stdout.write(chalk.dim("      querying... "))
      let result
      try {
        result = await agenticQuery(q, store, opts.agent, {
          selectorModel: opts.selectorModel,
          synthModel: opts.synthModel,
        })
      } catch (e: any) {
        console.log(chalk.red(`failed: ${e.message?.slice(0, 120)}`))
        continue
      }
      console.log(chalk.dim("done"))

      if (result.status !== "ok") {
        console.log(chalk.yellow(`      (status: ${result.status}${result.error ? " — " + result.error : ""})`))
      } else {
        const cites = result.citations.map(c => `${c.title} [${c.type || "?"}]`).join(" · ")
        console.log()
        console.log(chalk.dim("      A: ") + result.answer.replace(/\n/g, "\n         "))
        console.log(chalk.dim("      citations: " + cites))
      }

      if (!script) {
        verdict = await ask(chalk.cyan("      verdict > "))
      }
      console.log(chalk.dim("      verdict: ") + verdict)

      const entry: Entry = { q, answer: result.answer, citations: result.citations, verdict }

      const m = verdict.match(/^(\/ok|\/correct|\/add|\/link|\/skip)(?:\s+(.+))?$/i)
      if (!m) {
        console.log(chalk.yellow("      (verdict not recognised — treating as /skip)"))
        transcript.push(entry)
        continue
      }
      const action = m[1].toLowerCase()
      const note = (m[2] || "").trim()
      transcript.push(entry)

      if (action === "/ok" || action === "/skip") continue
      if (!note) {
        console.log(chalk.yellow(`      ${action} without note — skipping.`))
        continue
      }

      const primary = result.citations[0]
      if (!primary) {
        console.log(chalk.yellow("      no cited article to patch."))
        continue
      }

      const article = store.readArticle(primary.path)
      if (!article) {
        console.log(chalk.red(`      can't read ${primary.path} to patch.`))
        continue
      }

      console.log(chalk.dim(`      patching ${primary.title} (${primary.path})...`))
      const patchPrompt = buildQuizPatchPrompt(article.content, action, note, article.meta.title, article.meta.type)
      const tmpDir = resolve(store.baseDir, "_tmp")
      mkdirSync(tmpDir, { recursive: true })
      const promptPath = resolve(tmpDir, `quiz-patch-${randomUUID().slice(0, 8)}.txt`)
      writeFileSync(promptPath, patchPrompt)

      let patched = ""
      try {
        const cmd = `cat '${promptPath}' | claude -p - --output-format json --max-turns 1 --model ${opts.patchModel} --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`
        const raw = execSync(cmd, { encoding: "utf-8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
        try {
          const envelope = JSON.parse(raw)
          patched = String(envelope.result || envelope.content || "")
        } catch { patched = raw }
        const fence = patched.trim().match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
        if (fence) patched = fence[1].trim()
        patched = patched.trim()
      } catch (e: any) {
        console.log(chalk.red(`      patch failed: ${e.message?.slice(0, 120)}`))
        continue
      }

      if (!patched || patched.length < 20) {
        console.log(chalk.yellow("      patch returned nothing usable."))
        continue
      }

      const before = article.content.split("\n").length
      const after = patched.split("\n").length
      console.log(chalk.dim(`      diff: ${before} → ${after} lines (${after - before >= 0 ? "+" : ""}${after - before})`))

      if (!commit) {
        console.log(chalk.dim("      (--no-commit: patch not written)"))
        entry.patched = primary.path + " (dry)"
        continue
      }

      const ok = store.writeArticle(primary.path, { ...article.meta, lastUpdated: new Date().toISOString().slice(0, 10) }, patched, opts.agent)
      if (!ok) {
        console.log(chalk.red("      write failed (permission?)"))
        continue
      }
      applied++
      entry.patched = primary.path
      console.log(chalk.green(`      ✓ patched ${primary.path}`))
    }

    if (rl) rl.close()
    if (applied > 0 && commit) store.rebuildIndex()

    console.log()
    console.log(chalk.bold(`  Session done: ${transcript.length} rounds, ${applied} patches applied.`))

    if (opts.out) {
      const lines: string[] = [
        `# Wiki Quiz — ${opts.agent}`,
        "",
        `_Generated ${new Date().toISOString()} · ${transcript.length} rounds · ${applied} patches_`,
        "",
      ]
      for (let i = 0; i < transcript.length; i++) {
        const e = transcript[i]
        lines.push(
          `## ${i + 1}. Q: ${e.q}`, "",
          `**A:** ${e.answer}`, "",
          `**Citations:** ${e.citations.map(c => `\`${c.title}\``).join(", ") || "_(none)_"}`, "",
          `**Verdict:** \`${e.verdict}\`` + (e.patched ? ` → patched \`${e.patched}\`` : ""), "",
        )
      }
      writeFileSync(opts.out, lines.join("\n"))
      console.log(chalk.dim(`  Transcript written to ${opts.out}`))
    }
  })

// agentx wiki edit — direct $EDITOR on a known article.
// Resolves <title-or-path> against the catalog, opens the file in
// $EDITOR, rebuilds the catalog on exit. No LLM, no confirm step,
// just the fastest path from "I see a typo" to "it's fixed".
wiki
  .command("edit <agent> <titleOrPath>")
  .description("open an article in $EDITOR (resolves by title or path), rebuild catalog on exit")
  .option("--dir <path>", "wiki directory")
  .option("--editor <cmd>", "override $EDITOR for this run")
  .action((agentId, titleOrPath, opts) => {
    const hub = getHub(opts.dir)
    let store
    try { store = hub.getAgentWiki(agentId) } catch (e: any) {
      console.log(chalk.red(`  can't open wiki for agent "${agentId}": ${e.message}`))
      return
    }

    const relPath = resolveArticlePath(store, titleOrPath, agentId)
    if (!relPath) {
      console.log(chalk.yellow(`  no article matches "${titleOrPath}" in ${agentId}'s wiki.`))
      console.log(chalk.dim(`  Tip: ${chalk.green("agentx wiki status")} lists agents; ${chalk.green(`agentx wiki search "term" --agent ${agentId}`)} finds by content.`))
      return
    }

    const absPath = resolve(store.baseDir, relPath)
    const editor = opts.editor || process.env.EDITOR || "vi"
    console.log(chalk.dim(`  opening ${relPath} in ${editor}...`))
    try {
      execSync(`${editor} '${absPath}'`, { stdio: "inherit" })
    } catch (e: any) {
      console.log(chalk.red(`  editor exited with error: ${e.message?.slice(0, 150)}`))
      return
    }

    // Rebuild catalog so related/title changes propagate
    try {
      store.rebuildIndex()
      console.log(chalk.green(`  ✓ ${relPath} saved. Catalog rebuilt.`))
    } catch (e: any) {
      console.log(chalk.yellow(`  saved, but catalog rebuild failed: ${e.message?.slice(0, 100)}`))
    }
  })

// agentx wiki patch — LLM-driven minimal edit from a free-form
// instruction. "quiz without the question" — when you already know
// what's wrong and just want the patch applied without hunting for
// the specific line to change.
wiki
  .command("patch <agent> <titleOrPath> <instruction>")
  .description("LLM-patch an article from a free-form instruction; shows diff + confirms before writing")
  .option("--dir <path>", "wiki directory")
  .option("--patch-model <m>", "patch model", "sonnet")
  .option("--yes", "skip confirmation and write immediately")
  .option("--no-commit", "show the patched body but don't write")
  .action(async (agentId, titleOrPath, instruction, opts) => {
    const readline = await import("node:readline/promises")
    const { randomUUID } = await import("node:crypto")
    const hub = getHub(opts.dir)
    let store
    try { store = hub.getAgentWiki(agentId) } catch (e: any) {
      console.log(chalk.red(`  can't open wiki for agent "${agentId}": ${e.message}`))
      return
    }

    const relPath = resolveArticlePath(store, titleOrPath, agentId)
    if (!relPath) {
      console.log(chalk.yellow(`  no article matches "${titleOrPath}" in ${agentId}'s wiki.`))
      return
    }
    const article = store.readArticle(relPath)
    if (!article) {
      console.log(chalk.red(`  can't read ${relPath}.`))
      return
    }

    const prompt = buildWikiPatchPrompt(article.content, article.meta.title, article.meta.type, instruction)
    const tmpDir = resolve(store.baseDir, "_tmp")
    mkdirSync(tmpDir, { recursive: true })
    const promptPath = resolve(tmpDir, `patch-${randomUUID().slice(0, 8)}.txt`)
    writeFileSync(promptPath, prompt)

    console.log()
    console.log(chalk.dim(`  Target: ${article.meta.title} (${relPath})`))
    console.log(chalk.dim(`  Patching with ${opts.patchModel}...`))

    let patched = ""
    try {
      const cmd = `cat '${promptPath}' | claude -p - --output-format json --max-turns 1 --model ${opts.patchModel} --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`
      const raw = execSync(cmd, { encoding: "utf-8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
      try {
        const envelope = JSON.parse(raw)
        patched = String(envelope.result || envelope.content || "")
      } catch { patched = raw }
      const fence = patched.trim().match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
      if (fence) patched = fence[1].trim()
      patched = patched.trim()
    } catch (e: any) {
      console.log(chalk.red(`  patch failed: ${e.message?.slice(0, 150)}`))
      return
    }

    if (!patched || patched.length < 20) {
      console.log(chalk.yellow("  patch returned nothing usable."))
      return
    }

    const before = article.content.split("\n").length
    const after = patched.split("\n").length
    console.log()
    console.log(chalk.bold("  === Patched preview ==="))
    console.log(chalk.dim(`  diff: ${before} → ${after} lines (${after - before >= 0 ? "+" : ""}${after - before})`))
    console.log()
    console.log(patched)
    console.log()

    if (!opts.commit) {
      console.log(chalk.dim("  --no-commit: preview only, not written."))
      return
    }

    let go = !!opts.yes
    if (!go) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const ans = (await rl.question(chalk.cyan("  apply? [y/N] "))).trim().toLowerCase()
      rl.close()
      go = ans === "y" || ans === "yes"
    }
    if (!go) {
      console.log(chalk.dim("  aborted."))
      return
    }

    const ok = store.writeArticle(relPath, { ...article.meta, lastUpdated: new Date().toISOString().slice(0, 10) }, patched, agentId)
    if (!ok) {
      console.log(chalk.red("  write failed (permission?)"))
      return
    }
    store.rebuildIndex()
    console.log(chalk.green(`  ✓ ${relPath} patched.`))
  })

/**
 * Resolve a user-provided "title or path" to a valid article path within
 * the given store. Matches by:
 *   1. Exact case-insensitive title
 *   2. If the arg looks like a path (has '/' or ends in '.md'), tries that
 *      path against the store directly
 *   3. Slug-of-title match (case-insensitive)
 * Returns the relative path on success, null on no match.
 */
function resolveArticlePath(store: any, titleOrPath: string, agentId: string): string | null {
  const arg = titleOrPath.trim()
  const articles = store.listArticles(agentId)

  // 1. Exact title match (case-insensitive)
  const lower = arg.toLowerCase()
  const byTitle = articles.find((a: any) => a.meta.title.toLowerCase() === lower)
  if (byTitle) return byTitle.path

  // 2. Path-like: try direct lookup
  if (arg.includes("/") || arg.endsWith(".md")) {
    const normPath = arg.endsWith(".md") ? arg : `${arg}.md`
    const byPath = articles.find((a: any) => a.path === normPath || a.path === arg)
    if (byPath) return byPath.path
  }

  // 3. Slug match — both sides slugified, prefix or equality
  const argSlug = arg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  const bySlug = articles.find((a: any) => {
    const titleSlug = a.meta.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    return titleSlug === argSlug || titleSlug.includes(argSlug) || a.path.toLowerCase().includes(argSlug)
  })
  if (bySlug) return bySlug.path

  return null
}

function buildWikiPatchPrompt(content: string, title: string, type: string | undefined, instruction: string): string {
  return [
    `You are editing a single wiki article to incorporate an operator instruction.`,
    ``,
    `## Article: "${title}" (type: ${type || "untyped"})`,
    ``,
    `<article-body>`,
    content,
    `</article-body>`,
    ``,
    `## Operator instruction`,
    instruction,
    ``,
    `## Rules`,
    `- Output ONLY the modified article body (content between the --- frontmatter markers).`,
    `- Do NOT output frontmatter (title, type, tags, etc.) — the serializer handles that.`,
    `- Do NOT wrap the output in code fences.`,
    `- Do NOT prepend any preamble like "Here's the updated article:".`,
    `- Preserve existing wikilinks, markdown formatting, and section structure unless the instruction requires changing them.`,
    `- Make the MINIMUM edit that satisfies the instruction — don't rewrite untouched sections.`,
    `- If the instruction is ambiguous or can't be applied, return the original body unchanged.`,
  ].join("\n")
}

function buildQuizPatchPrompt(content: string, action: string, note: string, title: string, type?: string): string {
  const instructions: Record<string, string> = {
    "/correct": `The operator says the article contains an error:\n\n    ${note}\n\nEdit the article to correct ONLY this mistake. Do not rewrite untouched sections. Keep the existing prose style. If the correction invalidates a larger passage, revise the minimum that must change.`,
    "/add": `The operator wants to add this detail:\n\n    ${note}\n\nIncorporate it into the most relevant existing section, or create a short new section if nothing fits. Keep the prose encyclopedic and under 100 additional words.`,
    "/link": `The operator wants to add this resource:\n\n    ${note}\n\nAdd it as a Markdown link in the most relevant section, or append a "## References" section at the end if none exists. If it looks like a URL, use it as-is; otherwise treat it as a wikilink target and use [[${note}]].`,
  }

  return [
    `You are editing a single wiki article to incorporate operator feedback.`,
    ``,
    `## Article: "${title}" (type: ${type || "untyped"})`,
    ``,
    `<article-body>`,
    content,
    `</article-body>`,
    ``,
    `## Edit instruction`,
    instructions[action] || `Make a minimal edit per: ${note}`,
    ``,
    `## Rules`,
    `- Output ONLY the modified article body (content between the --- frontmatter markers).`,
    `- Do NOT output frontmatter (title, type, tags, etc.) — the serializer handles that.`,
    `- Do NOT wrap the output in code fences.`,
    `- Do NOT prepend any preamble like "Here's the updated article:".`,
    `- Preserve existing wikilinks, markdown formatting, and section structure unless the edit requires changing them.`,
    `- If no meaningful edit can be made from the operator's feedback, return the original body unchanged.`,
  ].join("\n")
}

// agentx wiki prune — Phase 3 cleanup before un-gating absorb.
// Collapses legacy per-mode dirs (flat/, unified/) into canonical graph/.
// Title-level dedup: for each title, the best copy wins (prefer typed,
// then newer `last_updated`); losers are archived to `_versions/`.
wiki
  .command("prune")
  .description("collapse legacy flat/unified mode dirs into graph/ (dedup by title; losers archived)")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "prune only this agent's wiki")
  .option("--commit", "execute moves + archives (default: dry-run)")
  .action(async (opts) => {
    const hub = getHub(opts.dir)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()
    const commit = !!opts.commit
    const wikiRoot = opts.dir ? resolve(opts.dir) : resolve(process.cwd(), ".agentx/wiki")
    const CANONICAL = "graph"
    const LEGACY_MODES = ["flat", "unified"]

    console.log()
    console.log(chalk.bold(commit ? "  Pruning (commit)" : "  Pruning (dry-run)"))
    console.log(chalk.dim(`  Canonical: ${CANONICAL}/  ·  Legacy to collapse: ${LEGACY_MODES.join("/, ")}/`))

    let totalLegacy = 0
    let totalPromote = 0
    let totalUpgrade = 0
    let totalArchive = 0

    for (const agentId of agents) {
      const agentRoot = resolve(wikiRoot, "agents", agentId)
      if (!existsSync(agentRoot)) continue

      const canonicalDir = resolve(agentRoot, CANONICAL)
      const legacyEntries = LEGACY_MODES
        .map(m => ({ mode: m, dir: resolve(agentRoot, m) }))
        .filter(e => existsSync(e.dir))

      if (legacyEntries.length === 0) continue

      // Build a title → {relPath, type, lastUpdated} index of the canonical dir.
      const canonIdx = new Map<string, { relPath: string; type?: string; lastUpdated: string }>()
      walkMd(canonicalDir, (abs) => {
        const rel = relative(canonicalDir, abs)
        if (rel.startsWith("_") || rel.startsWith("raw/") || rel.includes("_tmp/")) return
        const parsed = parseWikiFrontmatter(readFileSync(abs, "utf-8"))
        if (!parsed?.meta.title) return
        canonIdx.set(parsed.meta.title.trim().toLowerCase(), {
          relPath: rel,
          type: parsed.meta.type,
          lastUpdated: parsed.meta.lastUpdated || "",
        })
      })

      // Enumerate legacy articles.
      type Legacy = {
        mode: string
        relPath: string
        absPath: string
        title: string
        type?: string
        lastUpdated: string
      }
      const legacy: Legacy[] = []
      for (const e of legacyEntries) {
        walkMd(e.dir, (abs) => {
          const rel = relative(e.dir, abs)
          if (rel.startsWith("_") || rel.startsWith("raw/") || rel.includes("_tmp/")) return
          const parsed = parseWikiFrontmatter(readFileSync(abs, "utf-8"))
          if (!parsed?.meta.title) return
          legacy.push({
            mode: e.mode,
            relPath: rel,
            absPath: abs,
            title: parsed.meta.title.trim(),
            type: parsed.meta.type,
            lastUpdated: parsed.meta.lastUpdated || "",
          })
        })
      }
      totalLegacy += legacy.length

      if (legacy.length === 0) continue

      console.log()
      const modeStr = legacyEntries.map(e => e.mode).join("+")
      console.log(chalk.bold(`  ${chalk.cyan(agentId)}: ${legacy.length} legacy article(s) across ${modeStr}`))

      for (const la of legacy) {
        const key = la.title.toLowerCase()
        const existing = canonIdx.get(key)

        // Decide: promote (new), upgrade (beat canonical), or archive (lose to canonical)
        let action: "promote" | "upgrade" | "archive"
        if (!existing) action = "promote"
        else if (!existing.type && la.type) action = "upgrade"
        else if (!!existing.type === !!la.type && la.lastUpdated && existing.lastUpdated &&
                 la.lastUpdated > existing.lastUpdated) action = "upgrade"
        else action = "archive"

        const typeTag = la.type ? chalk.magenta(`[${la.type}]`) : chalk.yellow("[untyped]")
        const arrow = action === "promote" ? chalk.green("→ promote  ")
                    : action === "upgrade" ? chalk.cyan("⟳ upgrade  ")
                    : chalk.dim("✗ archive  ")
        const where = la.relPath.length > 46 ? la.relPath.slice(0, 43) + "..." : la.relPath.padEnd(46)
        console.log(`    ${arrow} ${typeTag} ${chalk.dim(la.mode + "/")}${where}`)
        if (action === "upgrade") console.log(chalk.dim(`      (replaces ${existing!.relPath}, old version kept under _versions/)`))

        if (!commit) {
          if (action === "promote") totalPromote++
          else if (action === "upgrade") totalUpgrade++
          else totalArchive++
          continue
        }

        try {
          if (action === "promote") {
            const target = resolve(canonicalDir, la.relPath)
            if (existsSync(target)) {
              console.log(chalk.yellow(`      ! target path already exists, archiving instead: ${la.relPath}`))
              archiveLegacy(agentRoot, la)
              totalArchive++
            } else {
              mkdirSync(dirname(target), { recursive: true })
              renameSync(la.absPath, target)
              canonIdx.set(key, { relPath: la.relPath, type: la.type, lastUpdated: la.lastUpdated })
              totalPromote++
            }
          } else if (action === "upgrade") {
            const target = resolve(canonicalDir, existing!.relPath)
            if (existsSync(target)) {
              const verDir = resolve(agentRoot, "_versions", existing!.relPath.replace(/\.md$/, ""))
              mkdirSync(verDir, { recursive: true })
              const ts = new Date().toISOString().replace(/[:.]/g, "-")
              renameSync(target, resolve(verDir, `${ts}.md`))
            }
            mkdirSync(dirname(target), { recursive: true })
            renameSync(la.absPath, target)
            canonIdx.set(key, { relPath: existing!.relPath, type: la.type, lastUpdated: la.lastUpdated })
            totalUpgrade++
          } else {
            archiveLegacy(agentRoot, la)
            totalArchive++
          }
        } catch (e: any) {
          console.log(chalk.red(`      ! ${action} failed: ${e.message?.slice(0, 120)}`))
        }
      }

      if (commit) {
        // Delete the now-empty legacy mode dirs (they will also contain obsolete
        // _index.md, _schema.md, log.md etc.; rmSync -f nukes the whole subtree).
        for (const e of legacyEntries) {
          try { rmSync(e.dir, { recursive: true, force: true }) } catch {}
        }
        // Rebuild the canonical catalog so _index.md reflects the merged corpus.
        try {
          hub.getAgentWiki(agentId).rebuildIndex()
        } catch (e: any) {
          console.log(chalk.dim(`      (catalog rebuild skipped: ${e.message?.slice(0, 80)})`))
        }
      }
    }

    console.log()
    console.log(chalk.dim(`  Legacy scanned: ${totalLegacy}`))
    if (commit) {
      console.log(chalk.green(`  Promoted: ${totalPromote} · Upgraded canonical: ${totalUpgrade} · Archived: ${totalArchive}`))
      console.log(chalk.dim("  Archived losers preserved under <agent>/_versions/. Legacy mode dirs deleted."))
    } else {
      console.log(chalk.dim(`  Would: promote ${totalPromote} · upgrade ${totalUpgrade} · archive ${totalArchive}`))
      console.log(chalk.dim("  Dry-run — add --commit to execute"))
    }
    console.log()
  })

function walkMd(dir: string, cb: (absPath: string) => void): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name)
    if (entry.isDirectory()) walkMd(abs, cb)
    else if (entry.isFile() && entry.name.endsWith(".md")) cb(abs)
  }
}

function parseWikiFrontmatter(raw: string): { meta: Record<string, any> } | null {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return null
  const meta: Record<string, any> = {}
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/)
    if (!m) continue
    const key = m[1] === "last_updated" ? "lastUpdated" : m[1]
    meta[key] = m[2].trim().replace(/^"(.*)"$/, "$1")
  }
  return { meta }
}

function archiveLegacy(
  agentRoot: string,
  la: { mode: string; relPath: string; absPath: string },
): void {
  const verDir = resolve(agentRoot, "_versions", `legacy-${la.mode}`, la.relPath.replace(/\.md$/, ""))
  mkdirSync(verDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  renameSync(la.absPath, resolve(verDir, `${ts}.md`))
}

// agentx wiki migrate — Phase 2 of the Karpathy-alignment plan.
// Backfills `type` + `related` on legacy articles so Phase 3's agentic
// query has a corpus with a usable `_index.md` + wikilink graph.
wiki
  .command("migrate")
  .description("backfill type + related on legacy articles (one-shot)")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "migrate only this agent's articles")
  .option("--commit", "write changes (default: dry-run, reports what would change)")
  .option("--batch <n>", "articles per LLM call", "10")
  .option("--max <n>", "cap articles this run (for spot-checks)")
  .option("--model <m>", "classifier model", "sonnet")
  .action(async (opts) => {
    const hub = getHub(opts.dir)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()
    const batchSize = Math.max(1, parseInt(opts.batch) || 10)
    const maxArticles = opts.max ? parseInt(opts.max) : Infinity
    const commit = !!opts.commit

    console.log()
    console.log(chalk.bold(commit ? "  Migrating (commit)" : "  Migrating (dry-run)"))
    console.log(chalk.dim(`  Batch size: ${batchSize}  ·  Model: ${opts.model}`))
    console.log()

    let totalScanned = 0
    let totalNeeds = 0
    let totalApplied = 0

    for (const agentId of agents) {
      const agentWiki = hub.getAgentWiki(agentId)
      const articles = agentWiki.listArticles(agentId)
      const needs = articles.filter(a => !a.meta.type)
      totalScanned += articles.length
      totalNeeds += needs.length

      if (needs.length === 0) {
        console.log(`  ${chalk.cyan(agentId)}: ${chalk.green("all typed")} (${articles.length} articles)`)
        continue
      }

      const remaining = Math.max(0, maxArticles - totalApplied)
      const limit = Math.min(needs.length, remaining)
      if (limit === 0) {
        console.log(chalk.dim(`  ${agentId}: skipped (--max reached)`))
        continue
      }

      console.log()
      console.log(chalk.bold(`  ${chalk.cyan(agentId)}: ${limit}/${needs.length} untyped articles`))

      const baseDir = agentWiki["baseDir"]
      const tmpDir = resolve(baseDir, "_tmp")
      mkdirSync(tmpDir, { recursive: true })

      for (let i = 0; i < limit; i += batchSize) {
        const batch = needs.slice(i, Math.min(i + batchSize, limit))
        const prompt = buildMigratePrompt(batch)
        const promptPath = resolve(tmpDir, "migrate-prompt.txt")
        writeFileSync(promptPath, prompt)

        let classifications: Array<{ path: string; type: string }>
        try {
          const cmd = `cat '${promptPath}' | claude -p - --output-format json --max-turns 1 --model ${opts.model} --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`
          const rawOutput = execSync(cmd, { encoding: "utf-8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
          const envelope = JSON.parse(rawOutput)
          const responseText = String(envelope.result || envelope.content || "")
          const arrMatch = responseText.match(/\[[\s\S]*\]/)
          if (!arrMatch) throw new Error("no JSON array in classifier response")
          classifications = JSON.parse(arrMatch[0])
        } catch (e: any) {
          console.log(chalk.red(`    LLM classify failed: ${e.message?.slice(0, 150)}`))
          continue
        }

        for (const article of batch) {
          const c = classifications.find((x) => x.path === article.path)
          const norm = normalizeWikiType(c?.type)
          if (!c || !norm) {
            console.log(chalk.yellow(`    ? ${article.path}: unclassified${c ? ` (got "${c.type}")` : ""}`))
            continue
          }
          const related = agentWiki.extractWikilinks(article.content)
          const newMeta = {
            ...article.meta,
            type: norm.type as any,
            related: related.length ? related : undefined,
            lastUpdated: new Date().toISOString().slice(0, 10),
          }
          const relStr = related.length ? chalk.dim(` → ${related.slice(0, 3).join(", ")}${related.length > 3 ? ", …" : ""}`) : ""
          const aliasNote = norm.alias ? chalk.dim(` (from "${norm.alias}")`) : ""
          console.log(`    ${chalk.green("+")} ${chalk.magenta("[" + norm.type + "]")}${aliasNote} ${article.path}${relStr}`)

          if (commit) {
            agentWiki.writeArticle(article.path, newMeta, article.content, agentId)
            totalApplied++
          }
        }
      }

      if (commit) agentWiki.rebuildIndex()
    }

    console.log()
    console.log(chalk.dim(`  Scanned ${totalScanned} articles; ${totalNeeds} needed migration`))
    if (commit) {
      console.log(chalk.green(`  Applied ${totalApplied} patches.`))
    } else {
      console.log(chalk.dim("  Dry-run — add --commit to write changes."))
    }
    console.log()
  })

/**
 * Map the classifier's output to the 7-type enum. The LLM often volunteers
 * domain-specific types (issue, MR, runbook, agent…). Rather than reject
 * and re-run, map them to the nearest valid enum value. Caller gets back
 * {type, alias?} — alias is the raw LLM output when it wasn't an exact
 * match, for logging.
 */
function normalizeWikiType(raw: string | undefined): { type: string; alias?: string } | null {
  if (!raw) return null
  const key = String(raw).trim().toLowerCase().replace(/^[\s"'`]+|[\s"'`]+$/g, "")
  if (!key) return null
  const ALIASES: Record<string, string> = {
    // Exact enum values
    person: "person", project: "project", place: "place", concept: "concept",
    event: "event", decision: "decision", pattern: "pattern",
    // Plurals
    people: "person", projects: "project", places: "place", concepts: "concept",
    events: "event", decisions: "decision", patterns: "pattern",
    // Domain variants → enum equivalents
    agent: "project", bot: "project", service: "project", product: "project",
    tool: "project", repo: "project", repository: "project", app: "project",
    application: "project", team: "project", organization: "project", company: "project",
    issue: "event", mr: "event", "merge-request": "event", "merge_request": "event",
    ticket: "event", incident: "event", deploy: "event", deployment: "event",
    launch: "event", release: "event",
    process: "pattern", procedure: "pattern", workflow: "pattern",
    runbook: "pattern", recipe: "pattern", template: "pattern", sop: "pattern",
    infrastructure: "place", infra: "place", server: "place", environment: "place",
    env: "place", location: "place", host: "place",
    decisionrecord: "decision", adr: "decision", "decision-record": "decision",
  }
  const mapped = ALIASES[key]
  if (!mapped) return null
  return mapped === key ? { type: mapped } : { type: mapped, alias: key }
}

function buildMigratePrompt(articles: Array<{ path: string; meta: { title: string; tags?: string[] }; content: string }>): string {
  const items = articles.map((a, i) => {
    const body = a.content.replace(/\s+/g, " ").slice(0, 400)
    const tags = (a.meta.tags || []).slice(0, 8).join(", ")
    return `${i + 1}. path: "${a.path}"\n   title: "${a.meta.title}"\n   tags: [${tags}]\n   body: ${body}${a.content.length > 400 ? "…" : ""}`
  }).join("\n\n")

  return `Classify each of these ${articles.length} wiki articles into EXACTLY ONE type from this closed set (no synonyms, no plurals, no new values):

  person | project | place | concept | event | decision | pattern

What each type means:
- person: an individual human (team member, stakeholder, contact)
- project: a named initiative, repo, product, service, bot, agent, team, or org
- place: a physical or logical location (office, server, environment, infrastructure)
- concept: a recurring idea, philosophy, methodology, or thinking pattern
- event: a specific dated thing that happened (incident, deploy, launch, GitLab issue, MR)
- decision: a specific choice made and why (architecture decision, policy, ADR)
- pattern: a reusable workflow, template, recipe, procedure, runbook, or SOP

Explicit mappings (you WILL be tempted to volunteer these — don't; use the right-hand value):
- "agent" / "bot" / "service" / "repo" / "team"       → project
- "issue" / "MR" / "ticket" / "incident" / "deploy"   → event
- "process" / "procedure" / "runbook" / "workflow"    → pattern
- "infrastructure" / "server" / "environment"         → place
- "ADR" / "decision record"                            → decision

Rules:
- Return EXACTLY one type per article, by path, from the 7 allowed values above.
- Do not invent new types. Do not return plurals. Do not return synonyms.
- If the title is a person's name, it's person. If it's a repo/product/bot name, it's project. If it's dated + past tense, it's event.
- If you genuinely cannot decide, pick "concept" as the fallback.
- Output ONLY valid JSON, no markdown fencing, no prose.

Articles:

${items}

Output (JSON array, one entry per input article, same order):
[
  {"path": "path/to/article.md", "type": "project"},
  ...
]`
}

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
  .option("--mode <mode>", "graph (default, canonical) | unified | flat (legacy, back-compat)", "graph")
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

// agentx wiki query <question> — Phase 3 agentic query.
// Walks _index.md → picks candidate articles → walks `related` wikilinks
// → synthesizes an answer with citations. This is the Farzapedia-faithful
// retrieval path; `wiki search` stays as the raw BM25 escape hatch.
wiki
  .command("query <question>")
  .description("agentic wiki query — walks the catalog + wikilink graph, synthesizes an answer")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "which agent's wiki to query (default: first one with a catalog)")
  .option("--selector-model <m>", "candidate-selection model", "haiku")
  .option("--synth-model <m>", "synthesis model", "sonnet")
  .option("--max-candidates <n>", "candidates from selector", "3")
  .option("--max-hops <n>", "wikilink hops from candidates", "2")
  .option("--max-articles <n>", "cap on total articles walked", "8")
  .option("--json", "emit full result as JSON (for A/B harnesses)")
  .option("--trace", "print selector + walk trace")
  .action(async (question, opts) => {
    const { agenticQuery } = await import("@/wiki/query")
    const hub = getHub(opts.dir)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()

    // Find the first agent that actually has a catalog.
    let chosen: string | null = null
    for (const id of agents) {
      const s = hub.getAgentWiki(id)
      const cat = resolve(s.baseDir, "_index.md")
      try {
        if ((await import("fs")).existsSync(cat)) { chosen = id; break }
      } catch {}
    }
    if (!chosen) {
      console.log(chalk.yellow("  No agent has a catalog yet. Run `agentx wiki status` or migrate first."))
      return
    }

    const store = hub.getAgentWiki(chosen)
    const result = await agenticQuery(question, store, chosen, {
      selectorModel: opts.selectorModel,
      synthModel: opts.synthModel,
      maxCandidates: parseInt(opts.maxCandidates),
      maxHops: parseInt(opts.maxHops),
      maxArticles: parseInt(opts.maxArticles),
    })

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log()
    console.log(chalk.bold(`  Q: ${question}`))
    console.log(chalk.dim(`  agent: ${chosen}  ·  status: ${result.status}  ·  walked: ${result.walked.length}`))
    console.log()

    if (result.status !== "ok") {
      console.log(chalk.yellow(`  (no answer) ${result.error || result.status}`))
      return
    }

    console.log(result.answer)
    console.log()
    if (result.citations.length) {
      console.log(chalk.dim("  Citations:"))
      for (const c of result.citations) {
        const type = c.type ? chalk.magenta(` [${c.type}]`) : ""
        console.log(chalk.dim(`    - ${c.title}${type}  (${c.path})`))
      }
      console.log()
    }

    if (opts.trace && result.trace) {
      console.log(chalk.dim(`  selector: ${result.trace.selectorMs}ms   synthesis: ${result.trace.synthesisMs}ms`))
      console.log(chalk.dim(`  candidates: ${result.candidates.map(c => c.title).join(" | ") || "(none)"}`))
      if (result.walked.length > result.candidates.length) {
        const follow = result.walked.filter(w => !result.candidates.some(c => c.path === w.path))
        console.log(chalk.dim(`  followed: ${follow.map(w => `${w.title}@h${w.hop}`).join(" | ")}`))
      }
      console.log()
    }
  })

// agentx wiki search <query>
wiki
  .command("search <query>")
  .description("search wiki articles")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph (default, canonical) | unified | flat (legacy, back-compat)", "graph")
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
      console.log(chalk.green(`  ${totalSynced} entries synced.`))
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
