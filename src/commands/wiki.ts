import { Command } from "commander"
import { claudeCliEnv } from "@/utils/workspace-env"
import chalk from "chalk"
import { WikiHub } from "@/wiki"
import type { WikiMode } from "@/wiki/hub"
import { startWikiServer } from "@/wiki/serve"
import type { WikiPeer } from "@/wiki/article-sync"
import type { WikiQuerySettings } from "@/wiki/query-settings"
import { buildAbsorbPrompt } from "@/wiki/prompts"
import { absorbModel, parseAbsorbResponse } from "@/wiki/absorb-response"
import { droppedFacts, findCoveringArticles, renderCoveringBlock, absorbTargetPath } from "@/wiki/absorb-context"
import { patchProblems } from "@/wiki/fact-guard"
import { envelopeUsage, type AbsorbCallRecord, type AbsorbRunRecord } from "@/wiki/absorb-eval"
import { applyNoteAnswers, noteSource, parseNoteAnswers, renderAbsorbNotesBlock } from "@/wiki/absorb-notes"
import { NoteStore, type WikiNote } from "@/wiki/notes"
import { absorbOffAgents, absorbSkipMessage, selectAbsorbAgents } from "@/wiki/absorb-agents"
import { runPromotion } from "@/wiki/promote"
import { GraphStore } from "@/graph"
import { registerWikiFacts } from "./wiki-facts"
import { registerWikiNotes } from "./wiki-notes"
import { registerWikiOntology } from "./wiki-ontology"
import { registerWikiEnrich } from "./wiki-enrich"
import { registerWikiEvents } from "./wiki-events"
import { registerWikiSummarize } from "./wiki-summarize"
import { resolve, relative, dirname } from "path"
import { exec, execSync } from "child_process"
import { promisify } from "util"
import { appendFileSync, statSync, writeFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, existsSync } from "fs"

const execAsync = promisify(exec)

function getHub(dir?: string, mode?: WikiMode): WikiHub {
  return new WikiHub(wikiDir(dir), undefined, mode || "graph")
}

/**
 * Mesh peers for the wiki commands, each with the token its /wiki/* routes
 * ask for. A --peer URL takes the token of the configured peer at that URL.
 */
async function wikiPeers(urls?: string[]): Promise<WikiPeer[]> {
  let configured: WikiPeer[] = []
  try {
    const { loadDaemonConfig } = await import("@/daemon/config")
    configured = (loadDaemonConfig().mesh?.peers || []).map((p) => ({ url: p.url, token: p.token }))
  } catch { /* no config: --peer URLs go without a token */ }
  if (!urls?.length) return configured
  const strip = (u: string) => u.replace(/\/$/, "")
  return urls.map((url) => ({ url, token: configured.find((p) => strip(p.url) === strip(url))?.token }))
}

/** Agents this node runs, from its daemon config; null when there is none. */
async function localAgentIds(): Promise<Set<string> | null> {
  try {
    const { loadDaemonConfig } = await import("@/daemon/config")
    const ids = Object.keys(loadDaemonConfig().agents || {})
    return ids.length ? new Set(ids) : null
  } catch {
    return null
  }
}

/** This node's wiki notes settings when absorb should read the inbox
 *  (#831): notes on, with an inbox and a `wikiNotes.absorbAgent`. */
async function absorbNotesConfig(): Promise<{ inbox: string; absorbAgent: string; max: number; maxDeferrals: number } | null> {
  try {
    const { loadDaemonConfig } = await import("@/daemon/config")
    const n = loadDaemonConfig().wikiNotes
    if (!n?.enabled || !n.inbox || !n.absorbAgent) return null
    return { inbox: n.inbox, absorbAgent: n.absorbAgent, max: n.maxNotesPerRun, maxDeferrals: n.maxDeferrals }
  } catch {
    return null
  }
}

/** Agents with the bulk absorb turned off in agentx.json (#850). Empty
 *  when there is no config to read. */
async function absorbOffAgentIds(): Promise<Set<string>> {
  try {
    const { loadDaemonConfig } = await import("@/daemon/config")
    return absorbOffAgents(loadDaemonConfig().agents || {})
  } catch {
    return new Set()
  }
}

/** True, with a message, when the agent's articles are a read-only copy
 *  from a peer: the next sync would overwrite any edit made here. */
function refuseCopiedAgent(hub: WikiHub, agentId: string): boolean {
  const from = hub.syncedFrom(agentId)
  if (!from) return false
  console.log(chalk.yellow(`  ${agentId}'s articles are copied from ${from.node} and read-only here; change them on ${from.node}.`))
  process.exitCode = 1
  return true
}

/** `wiki.query.shared` from agentx.json; on when there is no config. */
async function sharedQueryOn(): Promise<boolean> {
  const { sharedQueryEnabled } = await import("@/wiki/query")
  return sharedQueryEnabled()
}

/** `wiki.query` settings with the `--method`, `--no-live`, `--linked` and
 *  `--no-notes` flags applied; null, with a message, when a flag's value is wrong. */
async function querySettingsFor(opts: { method?: string; live?: boolean; linked?: string; notes?: boolean }): Promise<WikiQuerySettings | null> {
  const { loadQuerySettings } = await import("@/wiki/query-settings")
  const settings = await loadQuerySettings()
  if (opts.method && !["auto", "summaries", "catalog"].includes(opts.method)) {
    console.log(chalk.red(`  --method takes auto, summaries or catalog, not "${opts.method}".`))
    process.exitCode = 1
    return null
  }
  const linked = opts.linked === undefined ? settings.summaries.linkedPages : Number(opts.linked)
  if (!Number.isInteger(linked) || linked < 0 || linked > 10) {
    console.log(chalk.red(`  --linked takes a whole number from 0 to 10, not "${opts.linked}".`))
    process.exitCode = 1
    return null
  }
  const live = { ...settings.summaries.live, enabled: settings.summaries.live.enabled && opts.live !== false }
  const notes = { ...settings.notes, enabled: settings.notes.enabled && opts.notes !== false }
  return { ...settings, method: (opts.method as WikiQuerySettings["method"]) ?? settings.method, summaries: { ...settings.summaries, linkedPages: linked, live }, notes }
}

/** The wiki root, resolved the same way everywhere that needs it. */
function wikiDir(dir?: string): string {
  return dir || resolve(process.cwd(), ".agentx/wiki")
}

function modeLabel(mode: WikiMode): string {
  if (mode === "graph") return "Knowledge Graph"
  if (mode === "flat") return "Karpathy Flat"
  return "Unified"
}

export const wiki = new Command()
  .name("wiki")
  .description("wiki knowledge base management")

registerWikiFacts(wiki)
registerWikiNotes(wiki)
registerWikiOntology(wiki)
registerWikiEnrich(wiki)
registerWikiEvents(wiki)
registerWikiSummarize(wiki)

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
      console.log(chalk.dim(`    Cited by an article: ${agent.cited}  Read, not cited: ${agent.readNotCited}`))

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
      console.log(chalk.dim(`  ${totalUnabsorbed} raw entries wait for absorb — run 'agentx wiki absorb'.`))
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
  .action(async (opts) => {
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

    // Facts that disagree and could not replace each other (#273).
    const { factContradictions } = await import("@/wiki/facts/ledger")
    const contradictions = factContradictions(wikiDir(opts.dir))
    totalIssues += contradictions.length
    if (contradictions.length > 0) {
      console.log(`  ${chalk.cyan("facts")}: ${chalk.yellow(`${contradictions.length} contradiction(s)`)}`)
      for (const c of contradictions) console.log(`    [!] ${chalk.dim(c.type)} ${c.articles[0]}: ${c.message}`)
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
  .option("--no-facts", "skip the system-of-record lookups")
  .option("--max <n>", "max entries per agent", "10")
  .option("--since <date>", "only entries dated on or after YYYY-MM-DD")
  .option("--until <date>", "only entries dated on or before YYYY-MM-DD")
  .option("--model <model>", "compile model (default: AGENTX_WIKI_ABSORB_MODEL, else sonnet)")
  .option("--run-label <label>", "tag this run's lines in _absorb-runs.jsonl, for `wiki absorb-runs`")
  .option("--no-notes", "do not read the wiki notes inbox, even for wikiNotes.absorbAgent")
  .action(async (opts) => {
    const mode = opts.mode as WikiMode
    let model: string
    try {
      model = absorbModel(opts.model)
    } catch (err: any) {
      console.log(chalk.red(`  ${err.message}`))
      process.exitCode = 1
      return
    }
    const hub = getHub(opts.dir, mode)
    // Each node absorbs its own agents. A peer's agents are absorbed on the
    // peer and reach this node through `wiki sync --articles`.
    const local = await localAgentIds()
    // Agents with agents.<id>.wiki.absorb.enabled false are left out
    // unless named with --agent (#850).
    const { agents: selected, skipped } = selectAbsorbAgents(
      hub.listAgents().filter((id) => !local || local.has(id)),
      { only: opts.agent, off: await absorbOffAgentIds() },
    )
    // Say when the skipped agent is the one that reads the notes inbox (#885).
    const notesAbsorbAgent = skipped.length && opts.notes !== false ? (await absorbNotesConfig())?.absorbAgent : undefined
    for (const id of skipped) {
      console.log(`  ${chalk.cyan(id)}: ${chalk.dim(absorbSkipMessage(id, notesAbsorbAgent))}`)
    }
    const agents = selected
      .filter((id) => {
        const from = hub.syncedFrom(id)
        if (from) console.log(`  ${chalk.cyan(id)}: ${chalk.dim(`copied from ${from.node}, read-only here; absorb it there`)}`)
        return !from
      })
    const maxEntries = parseInt(opts.max)

    // Build a lookup so each absorbed article can carry the intent path
    // its source entries were classified into. Without this, graphPath stays
    // empty and the wiki retrieval scorer multiplies the graph weight by 0.
    // Best-effort: graph may be disabled, store may be empty — we just fall
    // through to legacy behaviour (graphPath undefined) in those cases.
    const graphStore = (() => {
      try {
        const baseDir = resolve(process.cwd(), ".agentx/graph")
        if (!existsSync(baseDir)) return null
        return new GraphStore({ baseDir })
      } catch { return null }
    })()
    const fpToPath = new Map<string, string[]>()
    if (graphStore) {
      try {
        const idx = graphStore.loadIndex()
        for (const [fp, e] of Object.entries(idx.entries)) {
          fpToPath.set(fp, (e as any).path)
        }
      } catch { /* leave map empty */ }
    }
    // Built once for the whole absorb, not per agent: it reads every
    // article on the fleet.
    let knownPeople: string[] | undefined
    const lookupPath = (entry: { content: string; source?: string; meta?: Record<string, unknown> }): string[] | undefined => {
      // Preferred: entry was stamped with the classifier's path at creation
      // time (registry.ts addEntry call). Free, exact, no fingerprint dance.
      const stamped = (entry.meta as any)?.intentPath
      if (Array.isArray(stamped) && stamped.every((s: unknown) => typeof s === "string") && stamped.length > 0) {
        return stamped
      }
      // Fallback for legacy entries: try the fingerprint cache. Often misses
      // because entry.content has a "User: " prefix and entry.source can
      // include @<node>; surfaced here for completeness, not as a guarantee.
      if (!graphStore || fpToPath.size === 0) return undefined
      const sender = String((entry.meta as any)?.sender ?? "")
      const fp = graphStore.fingerprint({
        text: entry.content,
        channel: entry.source,
        sender,
      })
      return fpToPath.get(fp)
    }
    const pickGraphPath = (sources: string[], entries: Array<{ id: string; content: string; source: string; meta?: Record<string, unknown> }>): string[] | undefined => {
      const counts = new Map<string, { path: string[]; n: number }>()
      for (const sid of sources) {
        const entry = entries.find((e) => e.id === sid)
        if (!entry) continue
        const path = lookupPath(entry)
        if (!path?.length) continue
        const key = path.join("/")
        const cur = counts.get(key)
        if (cur) cur.n++
        else counts.set(key, { path, n: 1 })
      }
      if (counts.size === 0) return undefined
      let best: { path: string[]; n: number } | undefined
      for (const v of counts.values()) if (!best || v.n > best.n) best = v
      return best?.path
    }

    let totalAbsorbed = 0
    let totalWithPath = 0
    // Compile calls that failed: thrown, unparseable, or reported an error.
    // Any one makes the command exit 1, so a command schedule sees it (#603).
    let failedCalls = 0

    // One line per compile call in _absorb-runs.jsonl: time, cost, tokens
    // and prompt size, so a change to the pipeline can be measured (#808).
    // No entry or article text goes in it.
    const telemetryPath = resolve(hub.getBaseDir(), "_absorb-runs.jsonl")
    const label = typeof opts.runLabel === "string" && opts.runLabel.trim() ? opts.runLabel.trim() : undefined
    const writeTelemetry = (record: AbsorbCallRecord | AbsorbRunRecord) => {
      if (opts.dryRun) return
      try {
        appendFileSync(telemetryPath, `${JSON.stringify(record)}\n`)
      } catch {
        // Telemetry never fails an absorb.
      }
    }
    const startedAt = new Date().toISOString()
    // The wiki notes inbox (#831): read by the absorb pass of one agent,
    // set as wikiNotes.absorbAgent on the node that keeps the inbox.
    const notesCfg = opts.notes === false ? null : await absorbNotesConfig()
    const noteStore = notesCfg ? new NoteStore(hub.getBaseDir()) : null

    for (const agentId of agents) {
      const agentStart = Date.now()
      // Oldest-first, so without a floor absorb spends every run on the
      // earliest entries. Those predate intent-path stamping — devops-agent
      // has 367 entries from April with no intentPath and 1,728 from May
      // onward with one — so an unfiltered run compiles articles that can
      // never carry graphPath, zeroing 0.6 of their retrieval score.
      const sinceDate = typeof opts.since === "string" ? opts.since.trim() : ""
      const untilDate = typeof opts.until === "string" ? opts.until.trim() : ""
      const unabsorbed = hub
        .getUnabsorbedEntries(agentId)
        .filter((e) => !sinceDate || (e.date ?? "") >= sinceDate)
        .filter((e) => !untilDate || (e.date ?? "").slice(0, 10) <= untilDate)
        .slice(0, maxEntries)

      // Notes are taken (and marked as given to this run) only for a real
      // run; a dry run counts them.
      const readsNotes = Boolean(notesCfg && noteStore && notesCfg.absorbAgent === agentId)
      const noteRunId = `absorb/${agentId}/${startedAt.replace(/[:.]/g, "-")}`
      let notes: WikiNote[] = []
      if (readsNotes && opts.dryRun) {
        notes = noteStore!.peekForRun(notesCfg!.inbox, notesCfg!.max, notesCfg!.maxDeferrals)
      } else if (readsNotes) {
        notes = noteStore!.takeForRun(notesCfg!.inbox, noteRunId, notesCfg!.max, notesCfg!.maxDeferrals)
      }

      if (unabsorbed.length === 0 && notes.length === 0) {
        console.log(`  ${chalk.cyan(agentId)}: ${chalk.green("all absorbed")}`)
        continue
      }

      console.log()
      console.log(chalk.bold(`  ${chalk.cyan(agentId)}: ${unabsorbed.length} entries to absorb`))
      for (const e of unabsorbed.slice(0, 3)) {
        console.log(chalk.dim(`    [${e.date} via ${e.source}] ${e.content.slice(0, 80)}...`))
      }
      if (unabsorbed.length > 3) console.log(chalk.dim(`    ... and ${unabsorbed.length - 3} more`))
      if (notes.length > 0) console.log(chalk.dim(`    Wiki notes: ${notes.length} from the ${notesCfg!.inbox} inbox${opts.dryRun ? "" : ` (run ${noteRunId})`}`))

      if (opts.dryRun) continue

      // Get this agent's wiki store
      const agentWiki = hub.getAgentWiki(agentId)

      // Build prompt using mode-specific template
      const existingIndex = agentWiki.rebuildIndex()
      const worldview = agentWiki.getWorldview() || hub.getSharedStore().getWorldview() || ""
      const entryTexts = unabsorbed.map(e =>
        `--- ENTRY ${e.id} [${e.date} ${e.agentId} via ${e.source}] ---\n${e.content}\n--- END ENTRY ---`
      ).join("\n\n")

      // Look up the people this batch names in the systems that actually
      // hold their identifiers. Absorb cannot write down a contact value
      // that nobody typed into a chat, and nobody types their own.
      let factsBlock = ""
      if (opts.facts !== false) {
        const { extractHints, resolveFacts, mergeRecords, renderFactsBlock, installPrompts, defaultSources, recordsFromEntries } =
          await import("@/wiki/facts")
        // The dictionary is fleet-wide, not per-agent. The wiki is one
        // shared source of truth, so a person another agent has an
        // article for is still a person here — and scoping it to the
        // current agent's six person articles found nobody. Across a
        // month of entries the fleet dictionary raised hints from 4 to
        // 10, and the six it added were all body-only mentions.
        if (!knownPeople) {
          const names = new Set<string>()
          for (const a of hub.listAgents()) {
            for (const art of hub.getAgentWiki(a).listArticles(a)) {
              if (art.meta.type === "person") names.add(art.meta.title)
            }
          }
          knownPeople = [...names]
        }
        const hints = extractHints(
          unabsorbed.map((e) => ({
            context: e.sourceContext,
            content: e.content,
            sender: typeof e.meta?.sender === "string" ? e.meta.sender : undefined,
          })),
          { known: knownPeople },
        )
        // The entries' own stamped identifiers come first: they are the
        // platform's record of who sent this message, so unlike a
        // directory lookup there is no name to resolve and nothing to
        // mismatch. Directory results fill in around them.
        const fromEntries = recordsFromEntries(unabsorbed)
        if (hints.length > 0 || fromEntries.length > 0) {
          const sources = defaultSources()
          const { records, results } = hints.length > 0
            ? await resolveFacts(hints, { sources })
            : { records: [], results: [] }
          const merged = mergeRecords([...fromEntries, ...records])
          factsBlock = renderFactsBlock(merged)
          const got = [
            ...(fromEntries.length > 0 ? [`entries:${fromEntries.length}`] : []),
            ...results.filter((r) => r.records.length > 0).map((r) => `${r.source}:${r.records.length}`),
          ]
          console.log(chalk.dim(`    Facts: ${hints.length} entities → ${merged.length} resolved${got.length ? ` (${got.join(" ")})` : ""}`))
          for (const p of installPrompts(results, sources)) {
            // A source nobody knows is missing becomes a permanent hole
            // in the corpus shaped like the tool that was never installed.
            console.log(chalk.yellow(`    ! ${p.source} ${p.kind} — would supply ${p.provides.join(", ")}`))
            console.log(chalk.dim(`      ${p.hint}`))
          }
        }
      }

      // The articles these entries are about, in full, so the model
      // updates them instead of rewriting them blind or filing a
      // duplicate beside them (#801).
      const catalog = existingIndex.articles.filter((a) => a.path && !a.path.includes("/_versions/"))
      // A note looks up the articles it is about the same way an entry
      // does: a note may only patch an article the model has read in full.
      const covering = await findCoveringArticles(
        [...unabsorbed, ...notes.map((n) => ({ id: noteSource(n.id), content: n.change }))],
        agentWiki, agentId, catalog,
      )
      if (covering.length > 0) {
        console.log(chalk.dim(`    Existing: ${covering.map((a) => a.path).join(", ")}`))
      }

      const coveringBlock = renderCoveringBlock(covering)
      const notesBlock = renderAbsorbNotesBlock(notes)
      const prompt = buildAbsorbPrompt(mode, agentId, worldview, existingIndex.articles, entryTexts, unabsorbed.length, factsBlock, coveringBlock, notesBlock)
      console.log(chalk.dim(`    Mode: ${modeLabel(mode)}`))

      // Write prompt and run Claude
      const tmpDir = resolve(agentWiki["baseDir"], "_tmp")
      mkdirSync(tmpDir, { recursive: true })
      const promptPath = resolve(tmpDir, "absorb-prompt.txt")
      writeFileSync(promptPath, prompt)

      console.log(chalk.dim(`    Compiling with Claude (${model})...`))

      const call: AbsorbCallRecord = {
        kind: "call", at: "", label, agent: agentId, model,
        entries: unabsorbed.length, articles: 0, refused: 0, failed: true, wallMs: 0,
        promptChars: prompt.length,
        promptParts: {
          entries: entryTexts.length,
          // The catalog lists every article title; its share is the prompt
          // minus the same prompt built without it.
          catalog: prompt.length - buildAbsorbPrompt(mode, agentId, worldview, [], entryTexts, unabsorbed.length, factsBlock, coveringBlock, notesBlock).length,
          catalogArticles: existingIndex.articles.length,
          covering: coveringBlock.length,
          facts: factsBlock.length,
          worldview: worldview.length,
          notes: notesBlock.length,
        },
        ...(notes.length ? { notes: notes.length } : {}),
      }
      const callStart = Date.now()
      call.prepMs = callStart - agentStart

      try {
        let rawOutput: string
        // Whatever it printed, a run that exited non-zero or reported an
        // error must not mark its entries as read (#762).
        let runFailed = false
        try {
          rawOutput = execSync(
            `cat '${promptPath}' | claude -p - --output-format json --max-turns 3 --model '${model}' --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`,
            { env: claudeCliEnv(), encoding: "utf-8", timeout: 900_000, maxBuffer: 10 * 1024 * 1024 },
          )
        } catch (execErr: any) {
          rawOutput = execErr.stdout || ""
          if (!rawOutput) throw execErr
          runFailed = true
        }

        // Parse Claude's response — may be JSON envelope or raw text
        let responseText = rawOutput

        // Try to extract "result" from Claude's JSON envelope
        try {
          const envelope = JSON.parse(rawOutput)
          Object.assign(call, envelopeUsage(envelope))
          if (envelope.is_error === true) runFailed = true
          responseText = envelope.result || envelope.content || ""
          if (!responseText) {
            console.log(chalk.dim(`    Claude envelope keys: ${Object.keys(envelope).join(", ")}`))
            console.log(chalk.dim(`    is_error: ${envelope.is_error}, stop_reason: ${envelope.stop_reason}`))
          }
        } catch {
          // Not a JSON envelope — use as-is
        }

        // { articles, gaps }, or a legacy bare array of articles.
        const response = parseAbsorbResponse(responseText)
        if ("error" in response) {
          if (notes.length > 0) console.log(chalk.yellow(`    ${notes.length} wiki note(s) stay waiting`))
          console.log(chalk.red(`    ${response.error}`))
          console.log(chalk.dim(`    First 500 chars: ${responseText.slice(0, 500)}`))
          continue
        }
        const { articles, gaps } = response
        // Entries behind a refused save stay queued for the next run.
        const held = new Set<string>()
        const saved = new Set<string>()
        const batchIds = new Set(unabsorbed.map((e) => e.id))

        for (const article of articles) {
          const now = new Date().toISOString().slice(0, 10)
          const cited = Array.isArray(article.sources) ? article.sources : []
          // A note only patches, through its edits below. With notes in
          // the prompt, an article must cite an entry from this batch: one
          // citing nothing, or only notes, was written from a note and is
          // refused (#832 review). In a notes-only run that is every
          // article.
          const sources = notes.length > 0 ? cited.filter((s) => batchIds.has(s)) : cited
          if (notes.length > 0 && sources.length === 0) {
            console.log(chalk.yellow(`    ! refused ${article.path}: cites no entry from this batch; a wiki note only patches`))
            call.refused++
            continue
          }
          // Same title as an existing article: same subject, same file.
          const target = absorbTargetPath(article, catalog)
          if (target !== article.path) {
            console.log(chalk.dim(`    ~ ${article.path} → ${target} (an article with this title exists)`))
            article.path = target
          }
          const previous = agentWiki.readArticle(article.path)
          if (previous) {
            const dropped = droppedFacts(previous.content, String(article.content ?? ""))
            if (dropped.length > 0) {
              console.log(chalk.yellow(`    ! refused ${article.path}: the rewrite drops ${dropped.length} fact(s) the article has`))
              console.log(chalk.dim(`       ${dropped.slice(0, 8).join("; ")}${dropped.length > 8 ? "; …" : ""}`))
              for (const id of sources) held.add(id)
              call.refused++
              continue
            }
          }
          const graphPath = pickGraphPath(sources, unabsorbed) ?? previous?.meta.graphPath
          agentWiki.writeArticle(article.path, {
            title: article.title,
            type: article.type as any,
            related: Array.isArray(article.related) ? article.related : undefined,
            tags: article.tags || [],
            owner: agentId,
            access: previous?.meta.access ?? "public",
            sharedWith: previous?.meta.sharedWith?.length ? previous.meta.sharedWith : undefined,
            created: previous?.meta.created || now,
            lastUpdated: now,
            // An update cites what the old article cited as well.
            sources: [...new Set([...(previous?.meta.sources ?? []), ...sources])],
            graphPath,
          }, article.content, agentId)

          const typeTag = article.type ? chalk.magenta(`[${article.type}]`) + " " : ""
          const relStr = Array.isArray(article.related) && article.related.length
            ? ` → ${article.related.slice(0, 3).join(", ")}${article.related.length > 3 ? ", …" : ""}`
            : ""
          console.log(`    ${chalk.green(previous ? "~" : "+")} ${typeTag}${article.path}: ${article.title}${chalk.dim(relStr)}`)
          const tagStr = (article.tags || []).slice(0, 4).join(", ")
          if (tagStr) console.log(chalk.dim(`       tags: ${tagStr}`))
          if (graphPath?.length) {
            console.log(chalk.dim(`       graphPath: ${graphPath.join(" › ")}`))
            totalWithPath++
          }
          totalAbsorbed++
          call.articles++
          for (const id of sources) saved.add(id)
        }
        // Answer the wiki notes: apply the patches the model proposed,
        // then record each note's outcome with this run's id. A failed run
        // records nothing: its notes stay waiting and come back.
        if (notes.length > 0 && !runFailed) {
          // A schedule reading the same inbox may have answered a note
          // while this call ran; its answer stands. Checked before any
          // patch is applied, so a note it rejected never edits a page.
          const stillOurs = notes.filter((n) => {
            const now = noteStore!.get(n.id)
            if (now && now.status !== "open" && now.status !== "deferred") {
              console.log(chalk.dim(`    note ${n.id} already ${now.status} by ${now.handled?.by ?? "another run"}; left as it is`))
              return false
            }
            if (now?.handled && now.handled.at > startedAt) {
              console.log(chalk.dim(`    note ${n.id} already deferred by ${now.handled.by} during this run; left as it is`))
              return false
            }
            return true
          })
          // Only the articles shown in full may be patched.
          const results = applyNoteAnswers(stillOurs, parseNoteAnswers(response.notes), agentWiki, {
            agentId,
            paths: new Set(covering.map((a) => a.path)),
          })
          let recorded = 0
          for (const r of results) {
            try {
              noteStore!.handle(r.id, r.outcome, r.reason, agentId, noteRunId)
              recorded++
            } catch (e: any) {
              console.log(chalk.yellow(`    ! note ${r.id}: could not record ${r.outcome}: ${e?.message ?? e}`))
            }
            const mark = r.outcome === "patched" ? chalk.green("~") : r.outcome === "rejected" ? chalk.red("x") : chalk.yellow("…")
            console.log(`    ${mark} note ${r.id} ${r.outcome}: ${chalk.dim(r.reason.slice(0, 160))}`)
          }
          call.notesPatched = results.filter((r) => r.outcome === "patched").length
          call.notesRecorded = recorded
        } else if (notes.length > 0) {
          console.log(chalk.yellow(`    ${notes.length} wiki note(s) stay waiting`))
        }

        call.failed = runFailed
        // A held entry another saved article cites counts as absorbed and
        // is not offered again (#808), so the refused update is lost.
        call.heldCited = [...held].filter((id) => saved.has(id)).length

        // Every entry the model read leaves the queue, cited or not.
        // Otherwise uncited entries come back on every run (#762).
        if (runFailed) {
          console.log(chalk.yellow(`    Run reported an error — ${unabsorbed.length} entries stay queued`))
        } else {
          const done = unabsorbed.map((e) => e.id).filter((id) => !held.has(id))
          if (held.size > 0) console.log(chalk.yellow(`    ${unabsorbed.length - done.length} entries stay queued behind refused saves`))
          hub.markProcessed(agentId, done, articles.flatMap((a) => a.sources || []).filter((id) => !held.has(id)))
        }

        // Gaps: entities absorb referenced but has no article for.
        //
        // These were printed and dropped. Absorb runs on a cron, so the
        // one signal the wiki produces about its own holes was landing
        // in a log nobody reads. They go on the same queue as the field
        // gaps a lookup cannot close — one list of things needing a
        // person, not two.
        if (gaps.length > 0) {
          console.log()
          console.log(chalk.yellow(`    Gaps detected (${gaps.length} missing pieces):`))
          for (const gap of gaps) {
            console.log(chalk.yellow(`      ? ${gap}`))
          }
          try {
            const { QuestionStore } = await import("@/wiki/questions")
            const q = new QuestionStore(wikiDir(opts.dir)).add(
              gaps.map((gap) => ({
                kind: "article" as const,
                agentId,
                path: "",
                subject: String(gap).slice(0, 120),
                question: `No article yet for: ${String(gap).slice(0, 160)}`,
              })),
            )
            if (q.added > 0) console.log(chalk.dim(`    queued ${q.added} for follow-up (agentx wiki questions)`))
          } catch {
            // Queueing is best-effort; never fail an absorb over it.
          }
        }

        agentWiki.rebuildIndex()
      } catch (e: any) {
        console.log(chalk.red(`    Absorb failed: ${e.message?.slice(0, 200)}`))
        if (e.stderr) console.log(chalk.dim(String(e.stderr).slice(0, 300)))
        if (e.stdout) console.log(chalk.dim("stdout: " + String(e.stdout).slice(0, 300)))
      } finally {
        call.at = new Date().toISOString()
        call.wallMs = Date.now() - callStart
        if (call.failed) failedCalls++
        writeTelemetry(call)
      }
    }
    writeTelemetry({ kind: "run", label, startedAt, endedAt: new Date().toISOString(), max: maxEntries, model, failed: failedCalls })

    console.log()
    if (opts.dryRun) {
      console.log(chalk.dim("  Dry run — no changes made"))
    } else if (totalAbsorbed > 0) {
      console.log(chalk.green(`  ${totalAbsorbed} articles compiled across ${agents.length} agent(s)`))
      if (graphStore) {
        const pct = totalAbsorbed > 0 ? Math.round((totalWithPath / totalAbsorbed) * 100) : 0
        console.log(chalk.dim(`  ${totalWithPath}/${totalAbsorbed} carry graphPath (${pct}%) — wiki retrieval graph weight is now non-zero for those`))
      }
    }
    if (failedCalls > 0) {
      console.log(chalk.red(`  ${failedCalls} absorb call(s) failed; their entries stay queued`))
      process.exitCode = 1
    }
    console.log()
  })

// agentx wiki absorb-eval — the absorb scorecard (#808). A seeded sample
// of absorbed articles checked against the entries they cite: citations,
// ungrounded and lost identifiers, likely duplicates, and optionally a
// model judge for claim support and wrong merges.
wiki
  .command("absorb-eval")
  .description("score absorbed articles against the entries they cite")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph | unified | flat", "graph")
  .option("--agent <id>", "only this agent's articles")
  .option("--since <date>", "only articles last updated on or after YYYY-MM-DD")
  .option("--changed-after <time>", "only articles whose file changed after this time (ISO, e.g. 2026-10-07T20:05:00Z)")
  .option("--n <n>", "articles in the sample", "40")
  .option("--seed <seed>", "sample seed; the same seed picks the same articles", "absorb-eval")
  .option("--sample <file>", "reuse the sample saved in this file, or save it there on first use")
  .option("--judge", "also ask a model to check each article's claims (one call per article)")
  .option("--judge-model <model>", "model for --judge", "sonnet")
  .option("--out <file>", "write the scorecard as Markdown to this file")
  .option("--json", "print the scorecard and every article's checks as JSON")
  .action(async (opts) => {
    const { pickSample, checkArticle, findDuplicates, buildJudgePrompt, parseJudgeReply, buildScorecard, renderScorecard, uncitedWithFacts } =
      await import("@/wiki/absorb-eval")
    const { extractJson } = await import("@/utils/extract-json")
    const hub = getHub(opts.dir, opts.mode as WikiMode)
    const agents: string[] = opts.agent ? [opts.agent] : hub.listAgents()
    const since = typeof opts.since === "string" ? opts.since.trim() : ""
    const changedAfter = typeof opts.changedAfter === "string" && opts.changedAfter.trim() ? new Date(opts.changedAfter.trim()) : null
    if (changedAfter && Number.isNaN(changedAfter.getTime())) {
      console.log(chalk.red(`  not a time: ${opts.changedAfter}`)); process.exitCode = 1; return
    }
    // Version files are named by when they were saved, as 2026-10-07T20:05:00-000Z.
    const windowStart = changedAfter ? changedAfter.toISOString().slice(0, 19) : since

    const entries = new Map<string, { id: string; date?: string; content: string }>()
    for (const e of hub.getSharedStore().listEntries()) entries.set(e.id, { id: e.id, date: e.date, content: e.content })

    // Every article on the node, keyed agent/path, so a fact moved to a
    // sibling article is not counted as lost.
    type Row = { key: string; agent: string; article: ReturnType<ReturnType<WikiHub["getAgentWiki"]>["listArticles"]>[number] }
    const rows: Row[] = []
    for (const agent of agents) {
      for (const a of hub.getAgentWiki(agent).listArticles(agent)) rows.push({ key: `${agent}/${a.path}`, agent, article: a })
    }
    const citers = new Map<string, string[]>()
    for (const r of rows) for (const id of r.article.meta.sources ?? []) {
      const list = citers.get(id)
      if (list) list.push(r.article.content)
      else citers.set(id, [r.article.content])
    }

    const changedSince = (r: Row) => {
      if (!changedAfter) return true
      try { return statSync(resolve(hub.getAgentWiki(r.agent).baseDir, r.article.path)).mtimeMs > changedAfter.getTime() } catch { return false }
    }
    const candidates = rows
      .filter((r) => !since || (r.article.meta.lastUpdated ?? "") >= since.slice(0, 10))
      .filter(changedSince)
    let seed = String(opts.seed)
    let picked: Row[]
    if (opts.sample && existsSync(opts.sample)) {
      const saved = JSON.parse(readFileSync(opts.sample, "utf-8")) as { seed?: string; keys: string[] }
      seed = saved.seed ?? seed
      const byKey = new Map(rows.map((r) => [r.key, r]))
      picked = saved.keys.map((k) => byKey.get(k)).filter((r): r is Row => !!r)
      const gone = saved.keys.length - picked.length
      if (gone > 0) console.error(chalk.yellow(`  ${gone} sampled article(s) no longer exist`))
    } else {
      picked = pickSample(candidates.map((r) => ({ ...r, path: r.key })), parseInt(opts.n), seed)
      if (opts.sample) {
        writeFileSync(opts.sample, `${JSON.stringify({ seed, since: windowStart || undefined, keys: picked.map((r) => r.key) }, null, 2)}\n`)
        console.error(chalk.dim(`  sample saved to ${opts.sample}`))
      }
    }
    if (picked.length === 0) {
      console.log(chalk.yellow(`  no articles${windowStart ? ` changed since ${windowStart}` : ""} to score`))
      return
    }

    // The article as it stood before the window: the oldest version saved
    // after the window opened (each version is the content an absorb replaced).
    const stripFrontmatter = (raw: string) => raw.replace(/^---\n[\s\S]*?\n---\n?/, "")
    const previousOf = (r: Row): string | undefined => {
      const versions = hub.getAgentWiki(r.agent).getVersions(r.article.path)
      const inWindow = windowStart ? versions.filter((v) => v.timestamp >= windowStart) : versions.slice(0, 1)
      const v = inWindow[inWindow.length - 1]
      if (!v) return undefined
      try { return stripFrontmatter(readFileSync(v.path, "utf-8")) } catch { return undefined }
    }

    const evalArticles = picked.map((r) => ({
      path: r.key,
      title: r.article.meta.title,
      type: r.article.meta.type,
      content: r.article.content,
      sources: r.article.meta.sources ?? [],
      lastUpdated: r.article.meta.lastUpdated,
      previous: previousOf(r),
    }))
    const checks = evalArticles.map((a) => checkArticle(a, entries, (id) => citers.get(id) ?? []))

    const focus = new Set(picked.map((r) => r.key))
    const duplicates = agents.flatMap((agent) =>
      findDuplicates(
        rows.filter((r) => r.agent === agent).map((r) => ({
          path: r.key, title: r.article.meta.title, type: r.article.meta.type, sources: r.article.meta.sources,
        })),
        focus,
      ),
    )

    const judged: Array<{ path: string; verdict: NonNullable<ReturnType<typeof parseJudgeReply>> }> = []
    if (opts.judge) {
      let judgeModel: string
      try { judgeModel = absorbModel(opts.judgeModel) } catch (err: any) {
        console.log(chalk.red(`  ${err.message}`)); process.exitCode = 1; return
      }
      const tmpDir = resolve(hub.getBaseDir(), "_tmp")
      mkdirSync(tmpDir, { recursive: true })
      const queue = evalArticles.map((a, i) => ({ a, i }))
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          const { a, i } = item
          const cited = a.sources.map((id) => entries.get(id)).filter((e): e is { id: string; date?: string; content: string } => !!e)
          const promptPath = resolve(tmpDir, `absorb-eval-${process.pid}-${i}.txt`)
          writeFileSync(promptPath, buildJudgePrompt(a, cited))
          try {
            const { stdout } = await execAsync(
              `cat '${promptPath}' | claude -p - --output-format json --max-turns 1 --model '${judgeModel}' --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`,
              { env: claudeCliEnv(), encoding: "utf-8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
            )
            let text = stdout
            try { text = JSON.parse(stdout).result ?? stdout } catch { /* raw text */ }
            const verdict = parseJudgeReply(extractJson(text))
            if (verdict) judged.push({ path: a.path, verdict })
            else console.error(chalk.yellow(`  judge reply for ${a.path} was not usable`))
          } catch (e: any) {
            console.error(chalk.yellow(`  judge failed for ${a.path}: ${String(e?.message ?? e).slice(0, 160)}`))
          } finally {
            rmSync(promptPath, { force: true })
          }
        }
      }))
      judged.sort((x, y) => x.path.localeCompare(y.path))
    }

    // Entries the ledger says absorb read in the window, cited by no article.
    const citedIds = new Set(rows.flatMap((r) => r.article.meta.sources ?? []))
    const uncited: Array<{ id: string; date?: string; content: string }> = []
    for (const agent of agents) {
      const file = resolve(hub.getBaseDir(), "agents", agent, "_absorbed.json")
      if (!existsSync(file)) continue
      let ledger: Record<string, { at?: string }> = {}
      try { ledger = JSON.parse(readFileSync(file, "utf-8")).entries ?? {} } catch { continue }
      for (const [id, rec] of Object.entries(ledger)) {
        if (citedIds.has(id)) continue
        if (windowStart && String(rec.at ?? "") < windowStart) continue
        const entry = entries.get(id)
        if (entry) uncited.push(entry)
      }
    }
    const allText = rows.map((r) => r.article.content).join("\n")
    const lostUncited = uncitedWithFacts(uncited, allText)

    const card = buildScorecard(checks, duplicates, { seed, since: windowStart || undefined }, judged, 5, {
      entries: uncited.length, lost: lostUncited,
    })
    const md = renderScorecard(card)
    if (opts.out) writeFileSync(opts.out, md)
    if (opts.json) console.log(JSON.stringify({ card, checks }, null, 2))
    else if (opts.out) console.log(chalk.green(`  scorecard written to ${opts.out}`))
    else console.log(md)
  })

// agentx wiki query-runs — how many queries ran, failed and how long they
// took, from _query-runs.jsonl (#603).
wiki
  .command("query-runs")
  .description("count wiki queries by outcome, with timing")
  .option("--dir <path>", "wiki directory")
  .option("--since <date>", "only queries on or after this date or time (ISO)")
  .option("--json", "print the summary as JSON")
  .action(async (opts) => {
    const { QUERY_RUNS_FILE, summariseQueryRuns } = await import("@/wiki/query-runs")
    const file = resolve(wikiDir(opts.dir), QUERY_RUNS_FILE)
    if (!existsSync(file)) {
      console.log(chalk.yellow(`  no queries recorded yet (${file})`))
      return
    }
    const s = summariseQueryRuns(readFileSync(file, "utf-8"), typeof opts.since === "string" ? opts.since.trim() : undefined)
    if (opts.json) { console.log(JSON.stringify(s, null, 2)); return }
    console.log()
    console.log(chalk.bold(`  ${s.total} queries · ${s.failed} failed · p50 ${(s.wallMsP50 / 1000).toFixed(1)} s · p95 ${(s.wallMsP95 / 1000).toFixed(1)} s`))
    for (const [status, n] of Object.entries(s.byStatus).sort((a, b) => b[1] - a[1])) console.log(`  ${status.padEnd(14)} ${n}`)
    console.log(chalk.dim(`  from: ${Object.entries(s.bySource).map(([src, n]) => `${src} ${n}`).join(" · ")}`))
    console.log()
  })

// agentx wiki absorb-runs — time and cost per absorb run label, from
// _absorb-runs.jsonl. The before/after half of #808.
wiki
  .command("absorb-runs")
  .description("time, cost and throughput of absorb runs, grouped by --run-label")
  .option("--dir <path>", "wiki directory")
  .option("--label <label>", "only this run label")
  .option("--json", "print the summary as JSON")
  .action(async (opts) => {
    const { summariseRuns } = await import("@/wiki/absorb-eval")
    const file = resolve(wikiDir(opts.dir), "_absorb-runs.jsonl")
    if (!existsSync(file)) {
      console.log(chalk.yellow(`  no absorb runs recorded yet (${file})`))
      return
    }
    const records = readFileSync(file, "utf-8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)] } catch { return [] }
    }).filter((r) => !opts.label || (r.label || "(none)") === opts.label)
    const summary = summariseRuns(records)
    if (opts.json) { console.log(JSON.stringify(summary, null, 2)); return }
    if (summary.length === 0) { console.log(chalk.yellow("  no matching runs")); return }
    const cols: Array<[string, (s: (typeof summary)[number]) => string]> = [
      ["label", (s) => s.label],
      ["calls", (s) => `${s.calls}${s.failed ? ` (${s.failed} failed)` : ""}`],
      ["entries", (s) => String(s.entries)],
      ["articles", (s) => `${s.articles}${s.refused ? ` (${s.refused} refused${s.heldCited ? `, ${s.heldCited} held entries lost` : ""})` : ""}`],
      ["wall", (s) => `${(s.wallMs / 60_000).toFixed(1)} min`],
      ["call p50/p95", (s) => `${Math.round(s.callMsP50 / 1000)}/${Math.round(s.callMsP95 / 1000)} s`],
      ["entries/min", (s) => s.entriesPerMinute.toFixed(1)],
      ["prep", (s) => `${(s.prepMs / 60_000).toFixed(1)} min`],
      ["cost", (s) => `$${s.costUsd.toFixed(2)}`],
      ["$/entry", (s) => `$${s.costPerEntry.toFixed(3)}`],
    ]
    const cells = summary.map((s) => cols.map(([, f]) => f(s)))
    const w = cols.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
    console.log()
    console.log(chalk.bold(cols.map(([h], i) => h.padEnd(w[i])).join("  ")))
    for (const c of cells) console.log(c.map((v, i) => v.padEnd(w[i])).join("  "))
    console.log()
  })

// agentx wiki promote — memory→wiki promotion. Reads per-agent memories
// (.agentx/agent-memory/), has an LLM judge which are durable and
// cross-agent relevant, and proposes them as [[wikilinked]] articles for
// the SHARED store (owner "memory-promoter"); `wiki proposals approve`
// writes them. Idempotent via stamps in
// article sources[] + the _memory-promotions.json skip ledger — the
// planned follow-up documented in agents/agent-memory.ts.
wiki
  .command("promote")
  .description("promote per-agent memories into shared, authoritative wiki articles")
  .option("--dir <path>", "wiki directory (default .agentx/wiki)")
  .option("--memory-dir <path>", "the .agentx dir holding agent-memory/ (default .agentx)")
  .option("--since <duration>", "memory window, e.g. 24h, 7d", "7d")
  .option("--agent <id>", "only this agent's memories")
  .option("--types <list>", "comma-separated memory types", "project,reference,feedback")
  .option("--max <n>", "max candidate memories per run", "20")
  .option("--via <agentId>", "route the LLM call through an agent — uses the agent's own session, no API key")
  .option("--model <model>", "direct Anthropic API — needs ANTHROPIC_API_KEY")
  .option("--daemon <url>", "daemon API base URL for --via", "http://127.0.0.1:18800")
  .option("--reviews", "also promote findings from session-monitor reviews")
  .option("--review-kinds <list>", "which review kinds", "decisions,warnings,friction,context")
  .option("--failures", "also propose lessons from failures that recur across sessions")
  .option("--min-sessions <n>", "sessions a failure must recur in for --failures", "3")
  .option("--commit", "judge and write proposals for review (default: dry-run)", false)
  .option("--budget <tokens>", "max estimated tokens for the judge prompt", "60000")
  .action(async (opts) => {
    const sinceMs = parsePromoteSince(opts.since)
    const types = String(opts.types).split(",").map((t: string) => t.trim()).filter(Boolean)
    const validTypes = ["user", "feedback", "project", "reference"]
    const badType = types.find((t: string) => !validTypes.includes(t))
    if (badType) {
      console.log(chalk.red(`  Invalid memory type "${badType}". Valid: ${validTypes.join(", ")}`))
      process.exit(1)
    }
    if (opts.commit && !opts.via && !opts.model) {
      console.log(chalk.red("  --commit needs an LLM: pass --via <agentId> or --model <model>"))
      process.exit(1)
    }

    console.log()
    console.log(chalk.bold("  Memory → Wiki Promotion"))
    console.log()

    // The monitor has been producing structured findings all along and
    // none of them ever reached the wiki. They are not conversation, so
    // absorb was never going to see them; they are already-formed
    // claims, which is exactly what promotion is for.
    let extraCandidates: import("@/wiki/promote").MemoryCandidate[] = []
    if (opts.reviews) {
      const { reviewsToCandidates } = await import("@/wiki/review-candidates")
      const { default: Database } = await import("better-sqlite3")
      const dbPath = resolve(process.cwd(), ".agentx/db.sqlite")
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow(`  --reviews: no ${dbPath}`))
      } else {
        const db = new Database(dbPath, { readonly: true })
        try {
          const rows = db.prepare(
            "SELECT id, session_id, agent, source, updated_at, result FROM session_reviews WHERE status='ready' AND result IS NOT NULL AND updated_at >= ? ORDER BY updated_at DESC",
          ).all(Date.now() - (sinceMs ?? 7 * 864e5)) as never[]
          extraCandidates = reviewsToCandidates(rows, {
            kinds: String(opts.reviewKinds).split(",").map((k: string) => k.trim()).filter(Boolean),
          })
          const recurring = (extraCandidates as Array<{ occurrences?: number }>).filter((c) => (c.occurrences ?? 1) > 1).length
          console.log(chalk.dim(`  ${rows.length} review(s) in window → ${extraCandidates.length} candidate finding(s), ${recurring} seen in more than one session`))
          const top = (extraCandidates as Array<{ occurrences?: number; memory: { description: string } }>)[0]
          if (top && (top.occurrences ?? 1) > 1) {
            console.log(chalk.dim(`  most recurrent (${top.occurrences} sessions): ${top.memory.description.slice(0, 84)}`))
          }
        } finally {
          db.close()
        }
      }
    }

    // Successes are mined and memories are promoted; failures were read by
    // nothing. Only failure signatures that recur across sessions are
    // offered — a one-off failure is session state, not a lesson.
    if (opts.failures) {
      const minSessions = Number(opts.minSessions)
      if (!Number.isInteger(minSessions) || minSessions < 2) {
        console.log(chalk.red(`  Invalid --min-sessions "${opts.minSessions}". Use a whole number of 2 or more.`))
        process.exit(1)
      }
      const { loadFailedTraces, failuresToCandidates } = await import("@/wiki/failure-candidates")
      const { default: Database } = await import("better-sqlite3")
      const dbPath = resolve(process.cwd(), ".agentx/db.sqlite")
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow(`  --failures: no ${dbPath}`))
      } else {
        const db = new Database(dbPath, { readonly: true })
        try {
          const failed = loadFailedTraces(db, { since: Date.now() - (sinceMs ?? 7 * 864e5) })
          const recurring = failuresToCandidates(failed, { minSessions })
          console.log(chalk.dim(`  ${failed.length} failed run(s) in window → ${recurring.length} failure(s) seen in ${minSessions}+ sessions`))
          const top = recurring[0]
          if (top) console.log(chalk.dim(`  most recurrent (${top.occurrences} sessions, ${top.failure.runs} runs): ${top.memory.description.slice(0, 84)}`))
          extraCandidates = [...extraCandidates, ...recurring]
        } finally {
          db.close()
        }
      }
    }

    const report = await runPromotion({
      extraCandidates,
      wikiDir: opts.dir ? resolve(opts.dir) : undefined,
      memoryRoot: opts.memoryDir ? resolve(opts.memoryDir) : undefined,
      sinceMs,
      agentFilter: opts.agent,
      types: types as import("@/agents/agent-memory").MemoryType[],
      max: Number(opts.max) || 20,
      viaAgent: opts.via,
      model: opts.model,
      daemonUrl: opts.daemon,
      commit: opts.commit,
      budgetTokens: Number(opts.budget) || undefined,
      log: (msg) => console.log(chalk.dim(`  ${msg}`)),
    })

    if (report.candidates.length === 0) {
      console.log(chalk.dim("  Nothing unpromoted in window"))
      console.log()
      return
    }

    console.log(`  ${report.candidates.length} candidate(s) in ${report.clusters.length} cluster(s):`)
    for (const cluster of report.clusters) {
      const c = cluster.candidates[0]
      const corr = cluster.corroboratingAgents.length > 1
        ? chalk.green(` ×${cluster.corroboratingAgents.length} agents`)
        : ""
      console.log(`    ${chalk.cyan(`[${c.memory.type}]`)} ${c.memory.name}${corr} ${chalk.dim(`(${cluster.corroboratingAgents.join(", ")}, conf ${cluster.confidence.toFixed(2)})`)}`)
      console.log(chalk.dim(`      ${c.memory.description}`))
    }
    console.log()

    if (report.dryRun) {
      console.log(chalk.dim("  Dry run — pass --commit to judge and propose"))
      console.log()
      return
    }

    for (const p of report.proposed) {
      const typeTag = p.type ? chalk.magenta(`[${p.type}]`) + " " : ""
      const backing = `${p.agents.length} agent(s)${p.occurrences > 1 ? `, seen in ${p.occurrences} sessions` : ""}`
      console.log(`  ${chalk.green("?")} ${typeTag}${p.path}: ${p.title} ${chalk.dim(`(${backing})`)}`)
      console.log(chalk.dim(`     proposal ${p.id}`))
    }
    for (const s of report.skipped) {
      console.log(`  ${chalk.yellow("-")} ${s.stamp} ${chalk.dim(`— ${s.reason}`)}`)
    }
    if (report.gaps.length) {
      console.log()
      console.log(chalk.yellow(`  Gaps (${report.gaps.length}):`))
      for (const gap of report.gaps) console.log(chalk.yellow(`    ? ${gap}`))
    }
    for (const wmsg of report.warnings) console.log(chalk.dim(`  ! ${wmsg}`))
    for (const err of report.errors) console.log(chalk.red(`  x ${err}`))
    console.log()
    console.log(
      report.errors.length
        ? chalk.red(`  ${report.proposed.length} proposed, ${report.errors.length} error(s)`)
        : chalk.green(`  ${report.proposed.length} proposed, ${report.skipped.length} skipped`),
    )
    if (report.proposed.length) console.log(chalk.dim("  Nothing is in the wiki yet. Review with: agentx wiki proposals list"))
    console.log()
    if (report.errors.length) process.exit(1)
  })

// agentx wiki proposals — review what `wiki promote` wants to add to the
// shared wiki. Nothing reaches the wiki (or any agent) until approved.
const proposals = wiki
  .command("proposals")
  .description("review lessons proposed for the shared wiki (list, show, approve, reject)")

function proposalWikiDir(dir?: string): string {
  return dir ? resolve(dir) : resolve(process.cwd(), ".agentx", "wiki")
}

proposals
  .command("list")
  .description("list proposals (pending by default)")
  .option("--all", "include approved and rejected")
  .option("--dir <path>", "wiki directory (default .agentx/wiki)")
  .action(async (opts: { all?: boolean; dir?: string }) => {
    const { listProposals } = await import("@/wiki/proposals")
    const list = listProposals(proposalWikiDir(opts.dir), opts.all ? undefined : "pending")
    if (list.length === 0) { console.log(chalk.dim(opts.all ? "  no proposals" : "  nothing pending")); return }
    for (const p of list) {
      const e = p.evidence
      const failure = e.sources.some((src) => src.kind === "failure") ? " · from a recurring failure" : ""
      const backing = `${e.agents.join(", ")}${e.occurrences > 1 ? ` · seen in ${e.occurrences} sessions` : ""} · ${e.sources.length} source(s)${failure}`
      const state = p.status === "pending" ? "" : chalk.dim(` [${p.status}]`)
      const kind = p.replaces ? chalk.yellow("update") : chalk.green("new")
      console.log(`  ${chalk.cyan(p.id)}${state}`)
      console.log(`    ${kind} ${p.article.path}: ${p.article.title}`)
      console.log(chalk.dim(`    ${backing}`))
    }
  })

proposals
  .command("show")
  .description("the proposed article and the evidence behind it")
  .argument("<id>", "proposal id")
  .option("--dir <path>", "wiki directory (default .agentx/wiki)")
  .action(async (id: string, opts: { dir?: string }) => {
    const { readProposal } = await import("@/wiki/proposals")
    const p = readProposal(proposalWikiDir(opts.dir), id)
    if (!p) { console.error(chalk.red(`  no proposal "${id}"`)); process.exitCode = 1; return }
    console.log(chalk.bold(`  ${p.article.title}`) + chalk.dim(`  → ${p.article.path} (${p.replaces ? "updates an existing article" : "new article"}, ${p.status})`))
    console.log()
    console.log(p.article.content.split("\n").map((l) => `    ${l}`).join("\n"))
    console.log()
    console.log(chalk.bold("  Evidence"))
    for (const src of p.evidence.sources) {
      const who = src.author ? `${src.author}${src.taskId ? ` · task ${src.taskId}` : ""}` : src.agentId
      const seen = src.occurrences && src.occurrences > 1 ? ` · seen in ${src.occurrences} sessions` : ""
      console.log(`  - ${chalk.cyan(src.kind)} ${src.type}/${src.name} ${chalk.dim(`(${who}, ${src.updatedAt.slice(0, 10)}${seen})`)}`)
      console.log(chalk.dim(`    ${src.description}`))
      if (src.failure) console.log(chalk.dim(`    failing tool: ${src.failure.tool} · error: ${src.failure.errorClass} · ${src.failure.runs} run(s)`))
      if (src.sessions?.length) console.log(chalk.dim(`    sessions: ${src.sessions.join(", ")}`))
      if (src.tasks?.length) console.log(chalk.dim(`    runs: ${src.tasks.join(", ")} (agentx trace show <id>)`))
    }
  })

proposals
  .command("approve")
  .description("write the proposed article into the shared wiki")
  .argument("<id>", "proposal id")
  .option("--force", "approve even if the article changed since the proposal")
  .option("--dir <path>", "wiki directory (default .agentx/wiki)")
  .action(async (id: string, opts: { force?: boolean; dir?: string }) => {
    const { approveProposal } = await import("@/wiki/promote")
    const r = approveProposal(proposalWikiDir(opts.dir), id, { force: opts.force })
    if (!r.ok) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
    console.log(chalk.green(`  ✓ ${r.proposal.article.path} written to the shared wiki`))
  })

proposals
  .command("reject")
  .description("decline a proposal; its sources aren't judged again until they change")
  .argument("<id>", "proposal id")
  .option("--reason <text>", "why, kept with the decision")
  .option("--dir <path>", "wiki directory (default .agentx/wiki)")
  .action(async (id: string, opts: { reason?: string; dir?: string }) => {
    const { rejectProposal } = await import("@/wiki/promote")
    const r = rejectProposal(proposalWikiDir(opts.dir), id, { reason: opts.reason })
    if (!r.ok) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
    console.log(chalk.green(`  ✓ ${id} rejected`))
  })

/** "24h" / "7d" / "30m" → window in ms. (Same grammar as workflow absorb's
 *  parseSince, but returns the window size — runPromotion applies the clock.) */
function parsePromoteSince(input: string | undefined): number | undefined {
  if (!input) return undefined
  const m = /^(\d+)\s*([smhd])$/.exec(input.trim())
  if (!m) {
    console.log(chalk.red(`  Invalid --since "${input}". Use "30m", "24h", or "7d".`))
    process.exit(1)
  }
  const n = Number(m[1])
  const unit = m[2]
  return n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3600_000 : 86_400_000)
}

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
  .option("--topic <text>", "what to interview about (e.g. 'Globex deployment procedure')")
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
    if (refuseCopiedAgent(hub, opts.agent)) return
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
      const raw = execSync(cmd, { env: claudeCliEnv(), encoding: "utf-8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
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
    // Use canonical per-type directory names. Most types pluralise with +s,
    // but "person" goes in "people/" (English irregular plural — and matches
    // what Farzapedia / our catalog groupings use everywhere else).
    const TYPE_DIR: Record<string, string> = {
      person: "people", project: "projects", place: "places",
      concept: "concepts", event: "events", decision: "decisions", pattern: "patterns",
    }
    const articlePath = `${TYPE_DIR[type] || type + "s"}/${slug}.md`

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
        const edited = readFileSync(editPath, "utf-8")
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
    if (opts.commit !== false && refuseCopiedAgent(hub, opts.agent)) return
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
        const raw = execSync(cmd, { env: claudeCliEnv(), encoding: "utf-8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
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
    if (refuseCopiedAgent(hub, agentId)) return
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

    // Sync `related` from body wikilinks if the user added/removed any.
    // Read back the article, compare wikilinks, rewrite frontmatter if drift.
    const after = store.readArticle(relPath)
    if (after) {
      const seenLinks = new Set<string>()
      const bodyLinks = store.extractWikilinks(after.content).filter((w: string) => {
        if (seenLinks.has(w)) return false
        seenLinks.add(w); return true
      })
      const currentRelated = after.meta.related || []
      const drift = bodyLinks.some(b => !currentRelated.includes(b)) ||
                    currentRelated.some(r => !bodyLinks.includes(r))
      if (drift) {
        store.writeArticle(relPath, {
          ...after.meta,
          related: bodyLinks.length ? bodyLinks : undefined,
          lastUpdated: new Date().toISOString().slice(0, 10),
        }, after.content, agentId)
        console.log(chalk.dim(`  (synced frontmatter.related from body: ${bodyLinks.length} wikilink${bodyLinks.length === 1 ? "" : "s"})`))
      }
    }

    // Rebuild catalog so related/title changes propagate
    try {
      store.rebuildIndex()
      console.log(chalk.green(`  ✓ ${relPath} saved. Catalog rebuilt.`))
    } catch (e: any) {
      console.log(chalk.yellow(`  saved, but catalog rebuild failed: ${e.message?.slice(0, 100)}`))
    }
  })

// agentx wiki curate / versions / restore / curator — the page curator
// (#818) from the terminal. `curate` asks the running daemon, which runs
// the agent and writes the page exactly as the bubble on the page does.
async function curatorDaemon(): Promise<{ url: string; headers: Record<string, string> }> {
  const { loadDaemonConfig } = await import("@/daemon/config")
  const cfg = loadDaemonConfig()
  const url = cfg.dashboard?.daemonUrl?.replace(/\/+$/, "") || "http://127.0.0.1:18800"
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (cfg.dashboard?.token) headers.Authorization = `Bearer ${cfg.dashboard.token}`
  return { url, headers }
}

function printCuratorEdit(edit: any): void {
  console.log(chalk.bold(`  Page changed: +${edit.added} / −${edit.removed} lines`))
  for (const l of edit.diff || []) {
    const line = `    ${l.op === " " ? " " : l.op} ${l.text}`
    console.log(l.op === "+" ? chalk.green(line) : l.op === "-" ? chalk.red(line) : chalk.dim(line))
  }
  if (edit.sources?.length) {
    console.log(chalk.bold("  Sources"))
    for (const s of edit.sources) console.log(`    - ${s}`)
  } else {
    console.log(chalk.yellow("  No sources were cited for this change."))
  }
  if (edit.version) console.log(chalk.dim(`  Undo: agentx wiki restore <agent> <page> ${edit.version}`))
}

wiki
  .command("curate <agent> <titleOrPath> <instruction>")
  .description("ask the page curator agent to research and edit one page (needs the daemon)")
  .option("--dir <path>", "wiki directory")
  .option("--timeout <minutes>", "stop waiting after this long", "30")
  .action(async (agentId, titleOrPath, instruction, opts) => {
    const hub = getHub(opts.dir)
    if (refuseCopiedAgent(hub, agentId)) return
    const relPath = resolveArticlePath(hub.getAgentWiki(agentId), titleOrPath, agentId)
    if (!relPath) {
      console.log(chalk.yellow(`  no page matches "${titleOrPath}" in ${agentId}'s wiki.`))
      process.exitCode = 1
      return
    }
    const { url, headers } = await curatorDaemon()
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(url + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
      const data: any = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      return data
    }
    let started: any
    try {
      started = await call("POST", "/api/wiki/curate", { agent: agentId, path: relPath, message: instruction })
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message?.includes("fetch failed") ? `the daemon at ${url} is not running` : e.message}`))
      process.exitCode = 1
      return
    }
    console.log(chalk.dim(`  ${started.curator} is working on ${relPath}…`))
    const qs = `?agent=${encodeURIComponent(agentId)}&path=${encodeURIComponent(relPath)}`
    const deadline = Date.now() + Number(opts.timeout || 30) * 60_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000))
      const state = await call("GET", `/api/wiki/curate${qs}`).catch(() => null)
      const msg = state?.messages?.find((m: any) => m.id === started.id)
      if (!msg || msg.status === "pending") continue
      console.log(msg.status === "error" ? chalk.red(`  ${msg.text}`) : `  ${msg.text}`)
      if (msg.edit && (msg.edit.added || msg.edit.removed)) printCuratorEdit(msg.edit)
      if (msg.status === "error") process.exitCode = 1
      return
    }
    console.log(chalk.yellow("  still working; the result will show in the chat on the page."))
  })

wiki
  .command("versions <agent> <titleOrPath>")
  .description("list the saved earlier versions of one page, newest first")
  .option("--dir <path>", "wiki directory")
  .action((agentId, titleOrPath, opts) => {
    const store = getHub(opts.dir).getAgentWiki(agentId)
    const relPath = resolveArticlePath(store, titleOrPath, agentId)
    if (!relPath) { console.log(chalk.yellow(`  no page matches "${titleOrPath}" in ${agentId}'s wiki.`)); process.exitCode = 1; return }
    const versions = store.getVersions(relPath)
    if (!versions.length) { console.log(chalk.dim(`  ${relPath} has no earlier versions.`)); return }
    console.log(chalk.bold(`  ${relPath}`))
    for (const v of versions) console.log(`    ${v.timestamp}`)
  })

wiki
  .command("restore <agent> <titleOrPath> [version]")
  .description("put a page back to an earlier version (default: the newest); the current text is kept as a version")
  .option("--dir <path>", "wiki directory")
  .action((agentId, titleOrPath, version, opts) => {
    const hub = getHub(opts.dir)
    if (refuseCopiedAgent(hub, agentId)) return
    const store = hub.getAgentWiki(agentId)
    const relPath = resolveArticlePath(store, titleOrPath, agentId)
    if (!relPath) { console.log(chalk.yellow(`  no page matches "${titleOrPath}" in ${agentId}'s wiki.`)); process.exitCode = 1; return }
    const target = version || store.getVersions(relPath)[0]?.timestamp
    if (!target || !store.restoreVersion(relPath, target)) {
      console.log(chalk.red(`  no version ${target ? `"${target}" ` : ""}of ${relPath}; see agentx wiki versions ${agentId} "${titleOrPath}"`))
      process.exitCode = 1
      return
    }
    console.log(chalk.green(`  ✓ ${relPath} restored to ${target}.`))
  })

wiki
  .command("curator")
  .description("show or change the page curator: the chat bubble on wiki pages")
  .option("--on", "show the bubble on wiki pages")
  .option("--off", "hide the bubble and refuse curator requests")
  .option("--agent <id>", "agent that answers on every page")
  .option("--owner", "let each page's owner agent answer (the default)")
  .action(async (opts) => {
    if (opts.on && opts.off) { console.log(chalk.red("  pick --on or --off, not both")); process.exitCode = 1; return }
    if (opts.agent && opts.owner) { console.log(chalk.red("  pick --agent or --owner, not both")); process.exitCode = 1; return }
    const { loadDaemonConfig } = await import("@/daemon/config")
    if (opts.on || opts.off || opts.agent || opts.owner) {
      if (opts.agent) {
        const agents = Object.keys(loadDaemonConfig().agents || {})
        if (!agents.includes(opts.agent)) { console.log(chalk.red(`  no agent "${opts.agent}" in agentx.json`)); process.exitCode = 1; return }
      }
      const { mutateAgentxConfig } = await import("@/daemon/config-mutate")
      mutateAgentxConfig((cfg) => {
        cfg.wiki = cfg.wiki || {}
        cfg.wiki.curator = cfg.wiki.curator || {}
        if (opts.on) cfg.wiki.curator.enabled = true
        if (opts.off) cfg.wiki.curator.enabled = false
        if (opts.agent) cfg.wiki.curator.agent = opts.agent
        if (opts.owner) delete cfg.wiki.curator.agent
        return "wiki.curator updated"
      })
    }
    const c = loadDaemonConfig().wiki?.curator ?? { enabled: true }
    console.log(`  Page curator: ${c.enabled ? chalk.green("on") : chalk.yellow("off")}`)
    console.log(`  Answers:      ${c.agent ? c.agent : "each page's owner agent"}`)
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
  .option("--allow-fact-loss", "save even when the patch shrinks the article or drops a phone number, email, role, link or number it had")
  .action(async (agentId, titleOrPath, instruction, opts) => {
    const readline = await import("node:readline/promises")
    const { randomUUID } = await import("node:crypto")
    const hub = getHub(opts.dir)
    if (refuseCopiedAgent(hub, agentId)) return
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
      const raw = execSync(cmd, { env: claudeCliEnv(), encoding: "utf-8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
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

    // A patch is a small edit. One that shrinks the page, pastes the
    // model's reasoning into it or drops facts it had is a rewrite, and
    // rewrites are what lost phone numbers and roles (#824).
    const problems = patchProblems(article.content, patched)
    if (problems.length) {
      for (const p of problems) console.log(chalk.yellow(`  ! ${p}`))
      if (opts.commit && !opts.allowFactLoss) {
        console.log(chalk.yellow("  not saved. If this change is intended, run again with --allow-fact-loss."))
        process.exitCode = 1
        return
      }
    }

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

    // Two patches on one page at once each read the old body; the second
    // write silently undid the first (#824). Refuse when the page changed.
    if (store.readArticle(relPath)?.content !== article.content) {
      console.log(chalk.yellow(`  ${relPath} changed while this patch was made (another patch or edit). Not saved; run the patch again.`))
      process.exitCode = 1
      return
    }

    // Add the body's new wikilinks to `related`, and keep the ones it had:
    // a patch pruning them silently cut pages out of the graph (#824).
    const syncedRelated = [...new Set([...(article.meta.related || []), ...store.extractWikilinks(patched)])]
    const ok = store.writeArticle(relPath, {
      ...article.meta,
      related: syncedRelated.length ? syncedRelated : undefined,
      lastUpdated: new Date().toISOString().slice(0, 10),
    }, patched, agentId)
    if (!ok) {
      console.log(chalk.red("  write failed (permission?)"))
      return
    }
    store.rebuildIndex()
    console.log(chalk.green(`  ✓ ${relPath} patched.`))
  })

// agentx wiki contribute — each agent's daily, sourced patches (#824).
// Reads the agent's work since its last run (chat turns, and task traces
// with the tool calls it ran) and queues small patches (add a fact,
// correct a value, create a page for an entity with none) for the daily
// `wiki contributions merge`. Never rewrites a page.
const contribute = wiki
  .command("contribute")
  .description("queue sourced wiki patches from an agent's work since its last run (enable, disable)")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "contribute for this agent")
  .option("--all", "every agent with wiki.contribute.enabled in agentx.json")
  .option("--since <time>", "first run only: read work from this date or time (default: the last 24 hours)")
  .option("--max-patches <n>", "patches per agent per run (default: the agent's setting, else 30)")
  .option("--max-cost <usd>", "model spend per agent per run, in USD (default: the agent's setting, else wiki.contributions.maxCostUsd, else 0.5)")
  .option("--max-items <n>", "chat entries and tasks read per agent per run", "60")
  .option("--model <model>", "model (default: the agent's setting, else wiki.contributions.model, else sonnet)")
  .option("--db <path>", "trace database with the agents' task runs", ".agentx/db.sqlite")
  .option("--dry-run", "show the patches without queueing them or moving the cursor")
  .option("--json", "print the batches as JSON")
  .action(async (opts) => {
    const { runContribution } = await import("@/wiki/contributions")
    const hub = getHub(opts.dir)
    const dir = wikiDir(opts.dir)
    type Setting = { enabled?: boolean; maxPatches?: number; maxCostUsd?: number; model?: string }
    let settings: Record<string, Setting | undefined> = {}
    let defaults: { maxCostUsd?: number; model?: string } = {}
    try {
      const { loadDaemonConfig } = await import("@/daemon/config")
      const config = loadDaemonConfig()
      settings = Object.fromEntries(Object.entries(config.agents || {}).map(([id, a]) => [id, a.wiki?.contribute]))
      defaults = config.wiki.contributions
    } catch { /* no config: --agent still works */ }

    const ids: string[] = opts.agent
      ? [opts.agent]
      : opts.all ? Object.keys(settings).filter((id) => settings[id]?.enabled).sort() : []
    if (ids.length === 0) {
      console.log(chalk.yellow(opts.all
        ? "  No agent has wiki.contribute.enabled. Turn one on with `agentx wiki contribute enable <agent>`."
        : "  Name an agent with --agent <id>, or use --all."))
      if (!opts.all) process.exitCode = 1
      return
    }

    // Task traces carry the tool calls an agent ran; without the
    // database a run reads chat turns only.
    let db: import("better-sqlite3").Database | undefined
    const dbPath = resolve(process.cwd(), opts.db)
    if (existsSync(dbPath)) {
      const Database = (await import("better-sqlite3")).default
      db = new Database(dbPath, { readonly: true })
    } else if (!opts.json) {
      console.log(chalk.dim(`  no trace database at ${dbPath}; reading chat turns only`))
    }

    const callWith = (model: string) => async (prompt: string, maxCostUsd: number) => {
      const tmpDir = resolve(dir, "_tmp")
      mkdirSync(tmpDir, { recursive: true })
      const promptPath = resolve(tmpDir, `contribute-${process.pid}-${Date.now()}.txt`)
      writeFileSync(promptPath, prompt)
      try {
        const { stdout } = await execAsync(
          `cat '${promptPath}' | claude -p - --output-format json --max-turns 1 --max-budget-usd ${maxCostUsd.toFixed(2)} --model ${model} --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`,
          { env: claudeCliEnv(), timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
        )
        try {
          const envelope = JSON.parse(stdout)
          return { text: String(envelope.result || envelope.content || ""), costUsd: envelopeUsage(envelope).costUsd }
        } catch {
          return { text: stdout }
        }
      } finally {
        rmSync(promptPath, { force: true })
      }
    }

    const batches = []
    try {
      for (const id of ids) {
        if (refuseCopiedAgent(hub, id)) continue
        const s = settings[id]
        const model = opts.model || s?.model || defaults.model || process.env.AGENTX_WIKI_CONTRIBUTE_MODEL || "sonnet"
        try {
          const batch = await runContribution(hub, dir, id, {
            model, call: callWith(model), db, since: opts.since, dryRun: !!opts.dryRun,
            maxPatches: opts.maxPatches ? parseInt(opts.maxPatches) : s?.maxPatches,
            maxCostUsd: opts.maxCost ? parseFloat(opts.maxCost) : s?.maxCostUsd ?? defaults.maxCostUsd,
            maxItems: parseInt(opts.maxItems),
          })
          batches.push(batch)
          if (opts.json) continue
          const stop = batch.stoppedBy ? chalk.yellow(` · stopped at ${batch.stoppedBy}`) : ""
          console.log(`  ${chalk.cyan(id)}: ${batch.patches.length} patch(es) from ${batch.workIds.length} item(s) of work · $${batch.costUsd.toFixed(4)}${stop}${opts.dryRun ? chalk.dim(" · dry run, not queued") : ""}`)
          for (const p of batch.patches) {
            const what = p.attribute ? `${p.attribute}: ${p.previous ? `${p.previous} → ` : ""}${p.value ?? ""}` : p.summary ?? ""
            console.log(chalk.dim(`    ${p.kind.padEnd(8)} ${p.page} · ${what} (${p.source}, ${p.checkedAt.slice(0, 10)})`))
          }
        } catch (e: any) {
          console.log(chalk.red(`  ${id}: ${e.message?.slice(0, 200)}`))
          process.exitCode = 1
        }
      }
    } finally {
      db?.close()
    }
    if (opts.json) console.log(JSON.stringify(batches, null, 2))
    else if (!opts.dryRun && batches.some((b) => b.patches.length)) console.log(chalk.dim("  queued; `agentx wiki contributions merge` applies them."))
  })

for (const [name, on] of [["enable", true], ["disable", false]] as const) {
  contribute
    .command(`${name} <agent>`)
    .description(on ? "turn on an agent's daily wiki contribution in agentx.json" : "turn off an agent's daily wiki contribution")
    .option("--max-cost <usd>", "model spend per run, in USD")
    .option("--max-patches <n>", "patches per run")
    .option("-c, --config <path>", "path to agentx.json")
    .action(async (agentId: string, opts) => {
      // Same path as `agentx config set`: validated against the schema,
      // written with a backup, and the daemon reloads.
      const { applyConfigMutation } = await import("@/daemon/config-mutator")
      const r = await applyConfigMutation((cfg: any) => {
        const agent = cfg.agents?.[agentId]
        if (!agent) throw new Error(`no agent "${agentId}" in agentx.json`)
        agent.wiki ??= {}
        agent.wiki.contribute ??= {}
        agent.wiki.contribute.enabled = on
        // `contribute` has the same flags, and commander hands them to it.
        const flags = { ...contribute.opts(), ...opts }
        if (flags.maxCost) agent.wiki.contribute.maxCostUsd = parseFloat(flags.maxCost)
        if (flags.maxPatches) agent.wiki.contribute.maxPatches = parseInt(flags.maxPatches)
      }, { configPath: opts.config })
      if (!r.success) {
        console.log(chalk.red(`  ✗ ${r.error}`))
        process.exitCode = 1
        return
      }
      console.log(chalk.green(`  ✓ ${agentId}: daily wiki contribution ${on ? "on" : "off"}`))
      if (on) console.log(chalk.dim("  The daily jobs wiki-contribute and wiki-contribute-merge now show in `agentx schedule list`."))
    })
}

const contributions = wiki
  .command("contributions")
  .description("the daily merge of agents' wiki patches (list, merge, held, approve, reject)")

contributions
  .command("list", { isDefault: true })
  .description("patches waiting for the merge, and what the last merge did")
  .option("--dir <path>", "wiki directory")
  .option("--json")
  .action(async (opts) => {
    const { listPendingBatches, latestReport, listHeld } = await import("@/wiki/contributions")
    const dir = wikiDir(opts.dir)
    const pending = listPendingBatches(dir)
    const last = latestReport(dir)
    const held = listHeld(dir)
    if (opts.json) {
      console.log(JSON.stringify({ pending, lastMerge: last, held: held.length }, null, 2))
      return
    }
    console.log()
    console.log(chalk.bold(`  Waiting for the merge: ${pending.reduce((n, b) => n + b.patches.length, 0)} patch(es) in ${pending.length} batch(es)`))
    for (const b of pending) console.log(chalk.dim(`    ${b.agentId} · ${b.runAt.slice(0, 16)} · ${b.patches.length} patch(es) · $${b.costUsd.toFixed(4)}`))
    if (last) {
      console.log(chalk.bold(`  Last merge ${last.at.slice(0, 16)}:`) + ` ${last.applied.length} fact(s) applied, ${last.pagesUpdated.length} page(s) updated, ${last.pagesCreated.length} created, ${last.contradictions.length} contradiction(s), ${last.held.length} held`)
      if (last.duplicates.length) console.log(chalk.yellow(`  ${last.duplicates.length} subject(s) have more than one page: ${last.duplicates.slice(0, 5).map((d) => d.title).join(", ")}${last.duplicates.length > 5 ? ", …" : ""}`))
    } else {
      console.log(chalk.dim("  No merge has run yet."))
    }
    if (held.length) console.log(chalk.yellow(`  ${held.length} patch(es) held for a person: agentx wiki contributions held`))
    console.log()
  })

contributions
  .command("merge")
  .description("apply the queued patches: newest checked fact wins, fact-losing changes are held")
  .option("--dir <path>", "wiki directory")
  .option("--dry-run", "show what would change without writing")
  .option("--json", "print the report as JSON")
  .action(async (opts) => {
    const { mergeContributions } = await import("@/wiki/contributions")
    const report = mergeContributions(getHub(opts.dir), wikiDir(opts.dir), { dryRun: !!opts.dryRun, log: (m) => console.error(m) })
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log()
    if (report.batches.length === 0) {
      console.log(chalk.dim("  Nothing to merge."))
      console.log()
      return
    }
    console.log(chalk.bold(`  ${report.patches} patch(es) from ${report.agents.join(", ")}${report.dryRun ? chalk.dim(" (dry run, nothing written)") : ""}`))
    console.log(`  ${report.applied.length} fact(s) applied · ${report.pagesUpdated.length} page(s) updated · ${report.pagesCreated.length} page(s) created`)
    for (const p of report.pagesCreated) console.log(chalk.green(`    + ${p}`))
    for (const p of report.pagesUpdated) console.log(chalk.dim(`    ~ ${p}`))
    for (const c of report.contradictions) {
      console.log(chalk.yellow(`  ? ${c.page} · ${c.attribute}: ${c.by} reports "${c.value}" with an older check than the wiki's; a person is asked${c.questionId ? ` (${c.questionId})` : ""}`))
    }
    for (const h of report.held) {
      console.log(chalk.yellow(`  ! held ${h.id} · ${h.page}${h.attribute ? ` · ${h.attribute}` : ""} from ${h.by}: ${h.reason}${h.lost?.length ? ` (${h.lost.slice(0, 4).join(", ")})` : ""}`))
    }
    for (const d of report.duplicates.slice(0, 10)) console.log(chalk.yellow(`  = ${d.title}: ${d.pages.join(" · ")}`))
    console.log()
  })

contributions
  .command("held")
  .description("patches the merge held for a person, with the reason")
  .option("--dir <path>", "wiki directory")
  .option("--all", "include approved and rejected")
  .option("--json")
  .action(async (opts) => {
    const { listHeld } = await import("@/wiki/contributions")
    const held = listHeld(wikiDir(opts.dir), { all: !!opts.all })
    if (opts.json) {
      console.log(JSON.stringify(held, null, 2))
      return
    }
    console.log()
    if (held.length === 0) console.log(chalk.dim("  Nothing held."))
    for (const h of held) {
      const p = h.patch
      const state = h.status === "held" ? "" : chalk.dim(` [${h.status}]`)
      console.log(`  ${chalk.bold(h.id)}${state} · ${chalk.cyan(p.agentId)} · ${p.kind} · ${p.page}${p.attribute ? ` · ${p.attribute}` : ""}${p.value ? `: ${p.value}` : ""}`)
      console.log(chalk.dim(`    ${h.reason}${h.lost?.length ? `: ${h.lost.join(", ")}` : ""} · source: ${p.source}, checked ${p.checkedAt.slice(0, 10)}`))
    }
    if (held.some((h) => h.status === "held")) console.log(chalk.dim("\n  agentx wiki contributions approve <id>  ·  agentx wiki contributions reject <id>"))
    console.log()
  })

contributions
  .command("approve <id>")
  .description("apply a held patch as it is")
  .option("--dir <path>", "wiki directory")
  .action(async (id: string, opts) => {
    const { approveHeld } = await import("@/wiki/contributions")
    const r = approveHeld(getHub(opts.dir), wikiDir(opts.dir), id, { by: process.env.USER || "operator" })
    if (!r.ok) {
      console.log(chalk.red(`  ${r.error}`))
      process.exitCode = 1
      return
    }
    console.log(chalk.green(`  ✓ ${id} applied${r.page ? ` to ${r.page}` : ""}. The page's previous version is kept.`))
  })

contributions
  .command("reject <id>")
  .description("drop a held patch")
  .option("--dir <path>", "wiki directory")
  .action(async (id: string, opts) => {
    const { rejectHeld } = await import("@/wiki/contributions")
    const r = rejectHeld(wikiDir(opts.dir), id, { by: process.env.USER || "operator" })
    if (!r.ok) {
      console.log(chalk.red(`  ${r.error}`))
      process.exitCode = 1
      return
    }
    console.log(chalk.green(`  ✓ ${id} rejected.`))
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
          const rawOutput = execSync(cmd, { env: claudeCliEnv(), encoding: "utf-8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
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
    const peers = await wikiPeers(opts.peer)
    const peerUrls = peers.map((p) => p.url)

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

    startWikiServer(dir, port, opts.agent, peers, opts.mode as WikiMode)
  })

// agentx wiki query <question> — Phase 3 agentic query.
// Walks _index.md → picks candidate articles → walks `related` wikilinks
// → synthesizes an answer with citations. This is the Farzapedia-faithful
// retrieval path; `wiki search` stays as the raw BM25 escape hatch.
wiki
  .command("grade")
  .description("grade absorbed articles with the article-quality seat")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph | unified | flat", "graph")
  .option("--agent <id>", "grade only this agent's wiki")
  .option("--limit <n>", "articles to grade", "20")
  .option("--min <n>", "only show articles scoring below this", "3")
  .option("--fields", "also check the required fields for each article's type")
  .option("--type <t>", "grade only articles of this type (person, place, project, …)")
  .option("--json")
  .action(async (opts) => {
    const { articleQualityQuestionsFor, articleQualityState, gradeArticle, ARTICLE_QUALITY_SEAT } =
      await import("@/decisions/seats/article-quality")
    const { fieldQuestions, reportFields } = await import("@/decisions/seats/article-fields")
    const { askSeat } = await import("@/decisions/seat")
    const hub = getHub(opts.dir, opts.mode as WikiMode)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()
    const limit = parseInt(opts.limit)
    const min = parseFloat(opts.min)

    const rows: any[] = []
    outer: for (const agentId of agents) {
      const store = hub.getAgentWiki(agentId)
      for (const meta of store.listArticles(agentId)) {
        if (rows.length >= limit) break outer
        const article = store.readArticle(meta.path)
        if (!article) continue
        if (opts.type && article.meta.type !== opts.type) continue
        // One state, every question. The rubric and the per-type field
        // checklist ride in the same call — a Jev fan-out costs the same
        // whether it answers four questions or seventeen.
        const questions = {
          ...articleQualityQuestionsFor(article.meta.type),
          ...(opts.fields ? fieldQuestions(article.meta.type) : {}),
        }
        const res = await askSeat(
          ARTICLE_QUALITY_SEAT,
          articleQualityState({
            path: meta.path, title: article.meta.title,
            type: article.meta.type, tags: article.meta.tags, body: article.content,
          }),
          questions,
          { links: [{ kind: "article", id: meta.path }], features: { agent: agentId, type: article.meta.type ?? "?" } },
        )
        if (!res) {
          console.log(chalk.yellow("  seat is off or unavailable — set decisions.seats.article-quality.mode"))
          return
        }
        const v = gradeArticle(res.answers as never)
        const fr = opts.fields ? reportFields(article.meta.type, res.answers as never) : null
        // A missing critical field is a finding regardless of the score:
        // an article can read well, score 2.8, and still lack the one
        // fact it exists to carry.
        if (v.completeness >= min && !(fr && !fr.fit)) continue
        rows.push({
          agent: agentId, type: article.meta.type ?? "?",
          score: v.completeness.toFixed(2),
          standsAlone: v.standsAlone.toFixed(2),
          gap: v.biggestGap,
          ...(fr ? { missing: fr.missingCritical.join(",") || "-", cov: `${Math.round(fr.coverage * 100)}%` } : {}),
          title: article.meta.title.slice(0, 44),
        })
      }
    }
    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return }
    if (rows.length === 0) { console.log(chalk.green("  no articles below the threshold")); return }
    rows.sort((a, b) => parseFloat(a.score) - parseFloat(b.score))
    const cols = opts.fields
      ? ["score", "cov", "missing", "type", "gap", "agent", "title"]
      : ["score", "standsAlone", "type", "gap", "agent", "title"]
    const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)))
    const fmt = (cells: any[]) => cells.map((v, i) => String(v).padEnd(w[i])).join("  ")
    console.log()
    console.log(chalk.bold(fmt(cols)))
    for (const r of rows) console.log(fmt(cols.map((c) => r[c])))
    if (opts.fields) {
      const unfit = rows.filter((r) => r.missing !== "-").length
      console.log(chalk.dim(`\n  ${rows.length} article(s) flagged; ${unfit} missing a required field.`))
      console.log(chalk.dim("  'missing' is the actionable column — a named field beats a score."))
    } else {
      console.log(chalk.dim(`\n  ${rows.length} article(s) below ${min}. standsAlone is the one that matters:`))
      console.log(chalk.dim("  an article can open with a tidy identity line and still send the reader back to the source."))
    }
  })

wiki
  .command("query <question>")
  .description("agentic wiki query — picks pages from their one-line summaries, reads live state at the source, then answers; walks the catalog + wikilink graph where no summaries exist")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "which agent's wiki to search first (default: the calling agent, else the first one with a catalog)")
  .option("--method <m>", "how pages are picked: auto, summaries or catalog (default: wiki.query.method)")
  .option("--no-live", "skip the live read of the summaries method")
  .option("--linked <n>", "also open up to n pages linked from the picked pages (summaries method; default: wiki.query.linkedPages)")
  .option("--no-notes", "leave the agent's own notes out (wiki.query.notes)")
  .option("--selector-model <m>", "candidate-selection model (default haiku)")
  .option("--synth-model <m>", "synthesis model (default sonnet)")
  .option("--max-candidates <n>", "candidates from selector (catalog method)", "3")
  .option("--max-hops <n>", "wikilink hops from candidates (catalog method)", "2")
  .option("--max-articles <n>", "cap on total articles walked (catalog method)", "8")
  .option("--json", "emit full result as JSON (for A/B harnesses)")
  .option("--trace", "print selector + walk trace")
  .option("--own-only", "search only the agent's own articles, not the shared wiki")
  .action(async (question, opts) => {
    const { agenticQuery } = await import("@/wiki/query")
    const { noteSourceFor } = await import("@/wiki/query-settings")
    const { QUERY_RUNS_FILE, queryFailed, recordQueryRun, timedQuery } = await import("@/wiki/query-runs")
    const settings = await querySettingsFor(opts)
    if (!settings) return
    const hub = getHub(opts.dir)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()
    // Every query leaves one line in _query-runs.jsonl, and one that could
    // not run exits 1, so a failure is counted and a caller can see it (#603).
    const runsFile = resolve(hub.getBaseDir(), QUERY_RUNS_FILE)
    const queryStart = Date.now()

    // The named (or calling) agent, or the first one that has a catalog. A named agent
    // with no articles of its own still searches the shared wiki.
    const named = opts.agent || process.env.AGENTX_AGENT_ID
    let chosen: string | null = named && !opts.ownOnly && (await sharedQueryOn()) ? named : null
    for (const id of chosen ? [] : agents) {
      const s = hub.getAgentWiki(id)
      const cat = resolve(s.baseDir, "_index.md")
      try {
        if ((await import("fs")).existsSync(cat)) { chosen = id; break }
      } catch {}
    }
    if (!chosen) {
      console.log(chalk.yellow("  No agent has a catalog yet. Run `agentx wiki status` or migrate first."))
      recordQueryRun(runsFile, { at: new Date().toISOString(), agent: named || "", status: "no-catalog", source: "cli", wallMs: Date.now() - queryStart })
      process.exitCode = 1
      return
    }

    const agent = chosen
    const store = hub.getAgentWiki(agent)
    const shared = opts.ownOnly || !(await sharedQueryOn()) ? undefined : hub.sharedScope(agent)
    const result = await timedQuery(runsFile, agent, "cli", () => agenticQuery(question, store, agent, {
      selectorModel: opts.selectorModel,
      synthModel: opts.synthModel,
      maxCandidates: parseInt(opts.maxCandidates),
      maxHops: parseInt(opts.maxHops),
      maxArticles: parseInt(opts.maxArticles),
      shared,
      method: settings.method,
      summaries: settings.summaries,
      notes: noteSourceFor(settings, agent),
    }))
    if (queryFailed(result.status)) process.exitCode = 1

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
    if (result.basis === "search") {
      console.log(chalk.dim("  No wiki page was used: the answer comes from a search at the source."))
      console.log()
    }
    if (result.citations.length) {
      console.log(chalk.dim("  Citations:"))
      for (const c of result.citations) {
        const type = c.type ? chalk.magenta(` [${c.type}]`) : ""
        console.log(chalk.dim(`    - ${c.title}${type}  (${c.path})`))
      }
      console.log()
    }
    if (result.live?.length) {
      console.log(chalk.dim("  Read live at the source:"))
      for (const l of result.live) console.log(chalk.dim(`    - ${l.line}`))
      console.log()
    }

    if (opts.trace && result.trace) {
      if (result.method === "summaries") {
        console.log(chalk.dim(`  method: summaries   live reads: ${result.liveAsked ?? 0} asked, ${result.live?.length ?? 0} answered   plan: ${result.trace.planMs ?? 0}ms   reads: ${result.trace.liveMs ?? 0}ms`))
      }
      console.log(chalk.dim(`  selector: ${result.trace.selectorMs}ms   synthesis: ${result.trace.synthesisMs}ms`))
      console.log(chalk.dim(`  candidates: ${result.candidates.map(c => c.title).join(" | ") || "(none)"}`))
      if (result.walked.length > result.candidates.length) {
        const follow = result.walked.filter(w => !result.candidates.some(c => c.path === w.path))
        console.log(chalk.dim(`  followed: ${follow.map(w => `${w.title}@h${w.hop}`).join(" | ")}`))
      }
      console.log()
    }
  })

// agentx wiki score — run a question set through `wiki query` and check
// each answer for the facts it should contain (#824). Run it before and
// after a change and compare the two reports.
wiki
  .command("score")
  .description("score the wiki's answers to a question set; compare two reports")
  .option("--dir <path>", "wiki directory")
  .option("--questions <file>", "question set: JSON array or JSON lines of {id, question, expect: [facts]}")
  .option("--agent <id>", "ask as this agent (its own wiki first, then the shared wiki)")
  .option("--own-only", "search only the agent's own articles, to measure without the shared wiki")
  .option("--out <file>", "write the report as JSON to this file")
  .option("--compare <files...>", "compare two saved reports (before after) instead of running")
  .option("--method <m>", "how pages are picked: auto, summaries or catalog (default: wiki.query.method)")
  .option("--no-live", "skip the live read of the summaries method")
  .option("--linked <n>", "also open up to n pages linked from the picked pages (summaries method; default: wiki.query.linkedPages)")
  .option("--no-notes", "leave the agent's own notes out (wiki.query.notes)")
  .option("--selector-model <m>", "candidate-selection model (default haiku)")
  .option("--synth-model <m>", "synthesis model (default sonnet)")
  .option("--json", "print the report as JSON")
  .action(async (opts) => {
    const { parseQuestionSet, buildReport, compareReports, runCost } = await import("@/wiki/score")
    const pct = (n: number) => `${Math.round(n * 100)}%`
    const secs = (ms?: number) => (ms === undefined ? "?" : `${(ms / 1000).toFixed(1)}s`)
    const usd = (n?: number) => (n === undefined ? "?" : `$${n.toFixed(3)}`)
    const costLine = (c: { meanMs?: number; meanCostUsd?: number; unpriced: number }) =>
      `${secs(c.meanMs)} and ${usd(c.meanCostUsd)} per question${c.unpriced ? ` (${c.unpriced} without a cost)` : ""}`

    if (opts.compare) {
      if (opts.compare.length !== 2) {
        console.log(chalk.red("  --compare takes two report files: before after"))
        process.exitCode = 1
        return
      }
      const [a, b] = opts.compare.map((f: string) => JSON.parse(readFileSync(resolve(f), "utf-8")))
      const diff = compareReports(a, b)
      if (opts.json) { console.log(JSON.stringify(diff, null, 2)); return }
      console.log()
      console.log(chalk.bold(`  ${pct(diff.before)} → ${pct(diff.after)}`))
      console.log(chalk.dim(`  before: ${costLine(diff.cost.before)}`))
      console.log(chalk.dim(`  after:  ${costLine(diff.cost.after)}`))
      if (diff.changed === "unknown") {
        console.log(chalk.yellow("  ! A report records no settings, so what changed between the runs is unknown."))
      } else {
        console.log(chalk.dim(`  changed: ${diff.changed.join("; ") || "nothing"}`))
        if (diff.changed.length > 1) console.log(chalk.yellow("  ! More than one setting changed: the difference can't be put down to one of them."))
      }
      if (diff.onlyBefore.length || diff.onlyAfter.length) {
        console.log(chalk.yellow(`  ! The runs asked different questions. Only before: ${diff.onlyBefore.join(", ") || "none"}. Only after: ${diff.onlyAfter.join(", ") || "none"}.`))
      }
      for (const d of diff.deltas) {
        if (d.before === d.after) continue
        const mark = d.after > d.before ? chalk.green("▲") : chalk.red("▼")
        console.log(`  ${mark} ${d.id} ${pct(d.before)} → ${pct(d.after)}  ${chalk.dim(d.question.slice(0, 80))}`)
        if (d.gained.length) console.log(chalk.green(`      + ${d.gained.join(", ")}`))
        if (d.lost.length) console.log(chalk.red(`      - ${d.lost.join(", ")}`))
      }
      console.log()
      return
    }

    if (!opts.questions) {
      console.log(chalk.red("  --questions <file> is required (or --compare before.json after.json)."))
      process.exitCode = 1
      return
    }
    const agent = opts.agent || process.env.AGENTX_AGENT_ID
    if (!agent) {
      console.log(chalk.red("  --agent <id> is required: the score is for one agent's view of the wiki."))
      process.exitCode = 1
      return
    }
    const questions = parseQuestionSet(readFileSync(resolve(opts.questions), "utf-8"))
    const { agenticQuery } = await import("@/wiki/query")
    const { noteSourceFor } = await import("@/wiki/query-settings")
    const { meteredModelCall } = await import("@/wiki/model-call")
    const settings = await querySettingsFor(opts)
    if (!settings) return
    const hub = getHub(opts.dir)
    const shared = !opts.ownOnly
    const answers = []
    for (const q of questions) {
      // Each question gets its own meter. Only the summaries method's calls
      // go through it; the catalog method's cost stays unknown.
      const spend = { calls: 0, usd: 0, unpriced: 0 }
      const started = Date.now()
      const r = await agenticQuery(q.question, hub.getAgentWiki(agent), agent, {
        selectorModel: opts.selectorModel,
        synthModel: opts.synthModel,
        shared: shared ? hub.sharedScope(agent) : undefined,
        method: settings.method,
        summaries: settings.summaries,
        notes: noteSourceFor(settings, agent),
        call: meteredModelCall(spend),
      })
      const ms = Date.now() - started
      const costUsd = r.method === "summaries" && spend.unpriced === 0 ? spend.usd : undefined
      answers.push({ q, answer: r.answer || r.error || "", status: r.status, citations: r.citations.map((c) => c.path), method: r.method ?? "catalog", ms, costUsd })
      if (!opts.json) process.stderr.write(chalk.dim(`  ${q.id} ${r.status} ${secs(ms)} ${usd(costUsd)}\n`))
    }
    const report = buildReport({
      questions: opts.questions, agent, shared,
      settings: {
        method: settings.method,
        linkedPages: settings.summaries.linkedPages,
        linkedChars: settings.summaries.linkedChars,
        live: settings.summaries.live.enabled,
        notes: settings.notes.enabled,
        navigatorModel: opts.selectorModel ?? settings.summaries.navigatorModel,
        answerModel: opts.synthModel ?? settings.summaries.answerModel,
      },
    }, answers)
    if (opts.out) writeFileSync(resolve(opts.out), `${JSON.stringify(report, null, 2)}\n`)
    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return }
    console.log()
    console.log(chalk.bold(`  ${agent}: ${pct(report.score)} · ${report.full}/${report.results.length} questions fully answered${shared ? "" : " (own articles only)"}`))
    console.log(chalk.dim(`  ${costLine(runCost(report))}`))
    for (const r of report.results) {
      const mark = r.missing.length === 0 ? chalk.green("✓") : r.found.length ? chalk.yellow("~") : chalk.red("✗")
      console.log(`  ${mark} ${r.id} ${pct(r.score)}  ${chalk.dim(r.question.slice(0, 80))}`)
      if (r.missing.length) console.log(chalk.dim(`      missing: ${r.missing.join(", ")}`))
    }
    if (opts.out) console.log(chalk.dim(`\n  report saved to ${opts.out}`))
    console.log()
  })

// agentx wiki search <query>
wiki
  .command("search <query>")
  .description("search wiki articles")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph (default, canonical) | unified | flat (legacy, back-compat)", "graph")
  .option("--agent <id>", "search specific agent's wiki")
  .action(async (query, opts) => {
    const hub = getHub(opts.dir, opts.mode as WikiMode)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()

    console.log()
    let found = 0

    for (const agentId of agents) {
      const store = hub.getAgentWiki(agentId)
      const results = await store.findRelevantReranked(query, undefined, 10)

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

// agentx wiki backfill-graphpath — populate graphPath on existing articles
//
// Reads each article's `sources[]`, looks the source entries up by id, computes
// the graph fingerprint from each entry's (content, channel, sender), and if
// the cache hits, picks the most-common path among the article's sources and
// writes it as `graph_path:` in frontmatter. Without this, the wiki retrieval
// score function multiplies the graph weight (0.6 by default) by 0 for every
// pre-existing article — the graph half of the hybrid score is dead weight.
wiki
  .command("backfill-graphpath")
  .description("populate graphPath on existing articles by looking up source-entry classifications")
  .option("--dir <path>", "wiki directory")
  .option("--agent <id>", "backfill only this agent")
  .option("--dry-run", "preview without writing", false)
  .action((opts) => {
    const hub = getHub(opts.dir)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()

    const baseDir = resolve(process.cwd(), ".agentx/graph")
    if (!existsSync(baseDir)) {
      console.log(chalk.red(`  No graph store at ${baseDir} — nothing to backfill against.`))
      return
    }
    const graphStore = new GraphStore({ baseDir })
    const idx = graphStore.loadIndex()
    const fpToPath = new Map<string, string[]>()
    for (const [fp, e] of Object.entries(idx.entries)) {
      fpToPath.set(fp, (e as any).path)
    }
    if (fpToPath.size === 0) {
      console.log(chalk.yellow(`  Graph index is empty — nothing to look up.`))
      return
    }
    console.log(chalk.dim(`  Loaded ${fpToPath.size} fingerprint -> path entries from .agentx/graph/index.json`))

    let totalArticles = 0
    let totalEligible = 0   // articles with empty graphPath that COULD be looked up
    let totalMatched = 0    // articles where at least one source matched
    let totalWritten = 0

    for (const agentId of agents) {
      const store = hub.getAgentWiki(agentId)
      const articles = store.listArticles(agentId)
      const sharedEntries = hub.getSharedStore().listEntries()
      const entriesById = new Map(sharedEntries.map((e) => [e.id, e]))

      let agentEligible = 0
      let agentMatched = 0
      let agentWritten = 0

      for (const article of articles) {
        totalArticles++
        if (article.meta.graphPath?.length) continue
        if (!article.meta.sources?.length) continue
        agentEligible++
        totalEligible++

        const counts = new Map<string, { path: string[]; n: number }>()
        for (const sid of article.meta.sources) {
          const entry = entriesById.get(sid)
          if (!entry) continue
          const sender = String((entry.meta as any)?.sender ?? "")
          const fp = graphStore.fingerprint({
            text: entry.content,
            channel: entry.source,
            sender,
          })
          const path = fpToPath.get(fp)
          if (!path?.length) continue
          const key = path.join("/")
          const cur = counts.get(key)
          if (cur) cur.n++
          else counts.set(key, { path, n: 1 })
        }
        if (counts.size === 0) continue
        agentMatched++
        totalMatched++

        let best: { path: string[]; n: number } | undefined
        for (const v of counts.values()) if (!best || v.n > best.n) best = v
        if (!best) continue

        if (opts.dryRun) {
          continue
        }
        // Write through writeArticle so frontmatter renders consistently.
        store.writeArticle(article.path, {
          ...article.meta,
          graphPath: best.path,
        }, article.content, agentId)
        agentWritten++
        totalWritten++
      }

      console.log(`  ${chalk.cyan(agentId)}: ${chalk.bold(articles.length)} articles · ${agentEligible} eligible · ${agentMatched} matched · ${chalk.green(agentWritten)} written`)
    }

    console.log()
    console.log(chalk.bold(`  Total: ${totalArticles} articles, ${totalEligible} missing graphPath, ${totalMatched} matched (${Math.round((totalMatched / Math.max(1, totalEligible)) * 100)}%), ${totalWritten} written`))
    if (opts.dryRun) console.log(chalk.dim(`  Dry-run — re-run without --dry-run to commit.`))
    console.log()
  })

// agentx wiki sync — pull entries from mesh peers
wiki
  .command("sync")
  .description("pull raw entries from mesh peers into local wiki, or with --articles copy their agents' articles (read-only)")
  .option("--dir <path>", "wiki directory")
  .option("--peer <url>", "sync from a specific peer URL (e.g., http://100.64.0.11:19900)")
  .option("--articles", "copy the articles of agents this node does not run, instead of raw entries")
  .option("--dry-run", "show what would be synced without writing")
  .action(async (opts) => {
    const hub = getHub(opts.dir)
    const shared = hub.getSharedStore()

    // Discover peers: from --peer flag, or from local daemon config
    const peers = await wikiPeers(opts.peer ? [opts.peer] : undefined)
    if (peers.length === 0) {
      console.log(chalk.dim("  No mesh peers configured"))
      console.log(chalk.dim("  Usage: agentx wiki sync --peer http://100.64.0.11:19900"))
      return
    }

    if (opts.articles) {
      const local = await localAgentIds()
      if (!local) {
        // Without the list, a peer's copy could overwrite this node's own agents.
        console.log(chalk.red("  No agents in this node's daemon config; run it where agentx.json is."))
        process.exitCode = 1
        return
      }
      const { syncPeerArticles } = await import("@/wiki/article-sync")
      for (const peer of peers) {
        console.log()
        console.log(chalk.bold(`  Copying articles from ${peer.url}...`))
        try {
          const result = await syncPeerArticles({ hub, peer, localAgents: local, dryRun: opts.dryRun })
          console.log(chalk.dim(`    Node: ${result.node}`))
          for (const a of result.agents) {
            if (a.skipped === "local") { console.log(chalk.dim(`      ${a.agentId}: runs here, not copied`)); continue }
            if (a.skipped) { console.log(chalk.yellow(`      ${a.agentId}: skipped (${a.skipped})`)); continue }
            const parts = [`${a.copied} ${opts.dryRun ? "to copy" : "copied"}`, `${a.unchanged} unchanged`]
            if (a.removed) parts.push(`${a.removed} removed (gone on the peer)`)
            if (a.rejected) parts.push(`${a.rejected} refused`)
            console.log(`      ${chalk.cyan(a.agentId)}: ${parts.join(", ")}${a.error ? chalk.red(` — stopped: ${a.error}`) : ""}`)
            if (a.error) process.exitCode = 1
          }
        } catch (e: any) {
          console.log(chalk.red(`    ${e.cause?.code === "ECONNREFUSED" ? "Connection refused" : e.message}`))
          process.exitCode = 1
        }
      }
      console.log()
      return
    }

    // Get existing entry IDs to avoid duplicates
    const existingIds = new Set(shared.listEntries().map(e => e.id))

    let totalSynced = 0

    for (const { url: peerUrl, token } of peers) {
      console.log()
      console.log(chalk.bold(`  Syncing from ${peerUrl}...`))
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

      try {
        // Fetch entries from peer
        const res = await fetch(`${peerUrl}/wiki/entries`, { headers, signal: AbortSignal.timeout(120000) })
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
          const agentsRes = await fetch(`${peerUrl}/wiki/agents`, { headers, signal: AbortSignal.timeout(5000) })
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

// ---------------------------------------------------------------------------
// agentx wiki export / import — bulk tarball backup of .agentx/wiki/
//
// Closes the audit gap: no operator-facing way to back up wiki content
// before a risky migration or move it between installs. Tarball is the
// safest portable shape; we don't ship a sync tool yet (see `wiki migrate`
// for in-place schema changes).

wiki
  .command("export [output]")
  .description("export the entire wiki tree to a .tar.gz")
  .option("--dir <path>", "wiki directory to archive (default: .agentx/wiki)")
  .option("--include-raw", "also include raw entries (.agentx/wiki/raw/) — bigger archive")
  .action(async (output, opts) => {
    const wikiDir = opts.dir ? resolve(process.cwd(), opts.dir) : resolve(process.cwd(), ".agentx/wiki")
    if (!existsSync(wikiDir)) {
      console.log(chalk.red(`  Wiki dir not found: ${wikiDir}`))
      process.exit(1)
    }
    const date = new Date().toISOString().slice(0, 10)
    const out = output ? resolve(process.cwd(), output) : resolve(process.cwd(), `agentx-wiki-${date}.tar.gz`)
    const parent = resolve(wikiDir, "..")
    const base = wikiDir.split("/").pop() || "wiki"
    const args = ["-C", parent, "-czf", out]
    if (!opts.includeRaw) args.push("--exclude=" + base + "/raw")
    args.push(base)
    console.log(chalk.dim(`  tar ${args.join(" ")}`))
    const { spawnSync } = await import("child_process")
    const r = spawnSync("tar", args, { stdio: "inherit" })
    if (r.status !== 0) {
      console.log(chalk.red(`  tar exited with ${r.status}`))
      process.exit(r.status || 1)
    }
    const { statSync } = await import("fs")
    const size = existsSync(out) ? statSync(out).size : 0
    console.log()
    console.log(chalk.green(`  ✓ wrote ${out} (${formatWikiBytes(size)})`))
    console.log(chalk.dim(`  Restore on another node: agentx wiki import ${out}`))
    console.log()
  })

// The post-absorb work list.
//
// Absorb writes an article once and never looks at it again, which
// assumes one pass over a batch of conversation can see everything worth
// keeping. It cannot: much of what an article needs was never in the
// conversation. This turns the grader's per-field verdict into the next
// pass's input, ordered by how much of the article rests on each gap, so
// the corpus gets built up in layers instead of being declared finished
// at the first draft.
wiki
  .command("gaps")
  .description("what each article still needs, most load-bearing first")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph | unified | flat", "graph")
  .option("--agent <id>", "only this agent's wiki")
  .option("--type <t>", "only articles of this type")
  .option("--max-tier <tier>", "stop at this layer: foundation|pillar|walls|openings|furniture", "pillar")
  .option("--limit <n>", "articles to check", "40")
  .option("--auto", "only gaps a system of record can close without asking anyone")
  .option("--ask", "queue the gaps that need a person onto the questions list")
  .option("--notify", "push the load-bearing ones to notifications.destination")
  .option("--notify-tier <tier>", "tier at or above which to push", "pillar")
  .option("--unclear", "include fields the grader was unsure about")
  .option("--json")
  .action(async (opts) => {
    // Its own seat, not article-quality's. Both ask about the same
    // articles, but a per-field yes/no and a 0-3 rubric calibrate
    // differently, and pooling them would average two unrelated error
    // profiles into one meaningless reliability curve.
    const { fieldQuestions, reportFields, articleFieldsState, nextActions, TIER_MEANING, ARTICLE_FIELDS_SEAT } =
      await import("@/decisions/seats/article-fields")
    const { askSeat } = await import("@/decisions/seat")
    const { QuestionStore } = await import("@/wiki/questions")
    const hub = getHub(opts.dir, opts.mode as WikiMode)
    const pending: Array<Parameters<InstanceType<typeof QuestionStore>["add"]>[0][number]> = []
    const agents = opts.agent ? [opts.agent] : hub.listAgents()
    const limit = parseInt(opts.limit)

    let checked = 0
    const rows: any[] = []
    outer: for (const agentId of agents) {
      const store = hub.getAgentWiki(agentId)
      for (const meta of store.listArticles(agentId)) {
        if (checked >= limit) break outer
        const article = store.readArticle(meta.path)
        if (!article) continue
        if (opts.type && article.meta.type !== opts.type) continue
        checked++
        const res = await askSeat(
          ARTICLE_FIELDS_SEAT,
          articleFieldsState({ title: article.meta.title, type: article.meta.type, body: article.content }),
          fieldQuestions(article.meta.type),
          { links: [{ kind: "article", id: meta.path }], features: { agent: agentId, type: article.meta.type ?? "?" } },
        )
        if (!res) {
          console.log(chalk.yellow("  seat is off or unavailable — set decisions.seats.article-fields.mode"))
          return
        }
        const report = reportFields(article.meta.type, res.answers as never)
        for (const a of nextActions(report, { maxTier: opts.maxTier, includeUnclear: Boolean(opts.unclear) })) {
          if (opts.auto && a.needsHuman) continue
          if (opts.ask && a.needsHuman) {
            pending.push({
              kind: "field", agentId, path: meta.path, subject: article.meta.title,
              field: a.field, tier: a.tier,
              question: `${article.meta.title} (${article.meta.type ?? "?"}) — ${a.label}?`,
            })
          }
          rows.push({
            tier: a.tier,
            need: a.field,
            how: a.needsHuman ? chalk.yellow("ask") : a.sources.join("/"),
            uncertain: a.uncertain ? "?" : "",
            agent: agentId,
            article: article.meta.title.slice(0, 40),
          })
        }
      }
    }

    let queued = { added: 0, skipped: 0 }
    if (opts.ask && pending.length > 0) {
      queued = new QuestionStore(wikiDir(opts.dir)).add(pending)
    }

    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return }
    if (rows.length === 0) {
      console.log(chalk.green(`  ${checked} article(s) checked — nothing missing at or above ${opts.maxTier}`))
      return
    }
    const cols = ["tier", "need", "how", "uncertain", "agent", "article"]
    const plain = (v: any) => String(v).replace(/\u001b\[[0-9;]*m/g, "")
    const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => plain(r[c]).length)))
    const pad = (v: any, i: number) => String(v) + " ".repeat(Math.max(0, w[i] - plain(v).length))
    console.log()
    console.log(chalk.bold(cols.map((c, i) => pad(c, i)).join("  ")))
    for (const r of rows) console.log(cols.map((c, i) => pad(r[c], i)).join("  "))

    const auto = rows.filter((r) => r.how !== chalk.yellow("ask")).length
    console.log()
    console.log(chalk.dim(`  ${rows.length} gap(s) across ${checked} article(s).`))
    console.log(chalk.dim(`  ${auto} can be closed by a lookup; ${rows.length - auto} need a person.`))
    const worst = rows[0]?.tier
    if (worst) console.log(chalk.dim(`  Start at ${worst} — ${TIER_MEANING[worst as keyof typeof TIER_MEANING]}.`))
    if (opts.ask) {
      console.log(chalk.cyan(`  Queued ${queued.added} question(s) for a person (${queued.skipped} already asked).`))
      console.log(chalk.dim("  agentx wiki questions   ·   agentx wiki answer <id> \"<value>\""))
    }

    // Interrupting someone is itself a decision, and until now the only
    // one agentx made on that was "did the task run for 30 seconds".
    // Tier is a better basis: a missing foundation fact makes an article
    // describe nothing, and a missing piece of furniture can wait for
    // whenever somebody opens the queue.
    if (opts.ask && opts.notify && queued.added > 0) {
      const { TIER_RANK } = await import("@/decisions/seats/article-fields")
      const floor = TIER_RANK[opts.notifyTier as keyof typeof TIER_RANK] ?? TIER_RANK.pillar
      const worth = pending.filter((q) => (TIER_RANK[(q.tier ?? "furniture") as keyof typeof TIER_RANK] ?? 9) <= floor)
      if (worth.length === 0) {
        console.log(chalk.dim(`  Nothing at or above ${opts.notifyTier} — not interrupting anyone.`))
      } else {
        const { loadDaemonConfig } = await import("@/daemon/config")
        const cfg: any = loadDaemonConfig()
        const dest = cfg?.notifications?.destination
        if (!dest?.channel || !dest?.chatId) {
          console.log(chalk.yellow("  --notify: no notifications.destination configured — questions are queued but nobody was told."))
        } else {
          const lines = worth.slice(0, 10).map((q) => `• ${q.question}`).join("\n")
          const more = worth.length > 10 ? `\n…and ${worth.length - 10} more` : ""
          const text = `${worth.length} wiki gap(s) need you (${opts.notifyTier}+):\n${lines}${more}\n\nagentx wiki questions`
          const port = cfg?.daemon?.port ?? cfg?.port ?? 18800
          try {
            const r = await fetch(`http://127.0.0.1:${port}/channel/send`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ channel: dest.channel, chatId: dest.chatId, accountId: dest.accountId, text }),
            })
            console.log(r.ok
              ? chalk.cyan(`  Pushed ${worth.length} question(s) to ${dest.channel}.`)
              : chalk.yellow(`  Push failed (${r.status}) — questions are still queued.`))
          } catch (e: any) {
            // The queue is the durable thing; the push is a courtesy.
            console.log(chalk.yellow(`  Push failed (${String(e?.message ?? e).slice(0, 80)}) — questions are still queued.`))
          }
        }
      }
    }
  })

// Closing the gaps that need no judgement.
//
// `wiki gaps` reports that an article has no contact value and that a
// system of record can supply one. This writes it. Only identity fields
// are eligible — verbatim strings a directory handed us — because
// copying those involves no reading of the world. Status, reasoning and
// ownership stay on the report where a person can answer them.
//
// Dry-run by default. Every applied edit versions the prior article
// into _versions/ first, so a bad run is one `git`-less restore away.
wiki
  .command("backfill")
  .description("write resolved identifiers into articles that are missing them")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph | unified | flat", "graph")
  .option("--agent <id>", "only this agent's wiki")
  .option("--limit <n>", "articles to consider", "40")
  .option("--apply", "write the changes (default: show them only)")
  .option("--json")
  .action(async (opts) => {
    const { fieldQuestions, reportFields, articleFieldsState, ARTICLE_FIELDS_SEAT, BACKFILL_ORDER } =
      await import("@/decisions/seats/article-fields")
    const { askSeat } = await import("@/decisions/seat")
    const { resolveFacts, mergeRecords, installPrompts, defaultSources, recordsFromEntries } =
      await import("@/wiki/facts")
    const { backfillArticle } = await import("@/wiki/backfill")

    const hub = getHub(opts.dir, opts.mode as WikiMode)
    const agents = opts.agent ? [opts.agent] : hub.listAgents()
    const limit = parseInt(opts.limit)
    const sources = defaultSources()

    // Identifiers already stamped on captured entries. These need no
    // tool and no token, so on a node with neither wacli nor a GitLab
    // token this is the only source there is — and it is the most
    // reliable one, because the platform recorded who sent the message
    // rather than us matching a name against a directory.
    const stamped = mergeRecords(recordsFromEntries((hub.getSharedStore() as never as {
      listEntries: () => Array<{ source?: string; meta?: Record<string, unknown> }>
    }).listEntries()))
    const stampedByName = new Map(stamped.map((e) => [e.name.toLowerCase().trim(), e]))

    let considered = 0
    let written = 0
    const rows: any[] = []
    let promptedInstall = false

    outer: for (const agentId of agents) {
      const store = hub.getAgentWiki(agentId)
      for (const meta of store.listArticles(agentId)) {
        if (considered >= limit) break outer
        // Only people. The backfillable fields are all person fields,
        // and grading a project article to discover that is a wasted call.
        if (meta.meta.type !== "person") continue
        const article = store.readArticle(meta.path)
        if (!article) continue
        considered++

        const res = await askSeat(
          ARTICLE_FIELDS_SEAT,
          articleFieldsState({ title: article.meta.title, type: article.meta.type, body: article.content }),
          fieldQuestions(article.meta.type),
          { links: [{ kind: "article", id: meta.path }], features: { agent: agentId, op: "backfill" } },
        )
        if (!res) {
          console.log(chalk.yellow("  seat is off or unavailable — set decisions.seats.article-fields.mode"))
          return
        }
        const report = reportFields(article.meta.type, res.answers as never)
        const wanted = report.missing.filter((f) => (BACKFILL_ORDER as readonly string[]).includes(f))
        if (wanted.length === 0) continue

        const { records, results } = await resolveFacts([{ name: article.meta.title, type: "person" }], { sources })
        const own = stampedByName.get(article.meta.title.toLowerCase().trim())
        if (!promptedInstall) {
          for (const p of installPrompts(results, sources)) {
            console.log(chalk.yellow(`  ! ${p.source} ${p.kind} — would supply ${p.provides.join(", ")}`))
            console.log(chalk.dim(`    ${p.hint}`))
          }
          promptedInstall = true
        }
        // Stamped identifiers win over directory hits: same reasoning as
        // absorb, there is no name resolution step to get wrong.
        const merged = mergeRecords([
          ...(own ? [{ name: own.name, source: "entries", fields: Object.fromEntries(Object.entries(own.fields).map(([k, v]) => [k, v.value])) }] : []),
          ...records,
        ])
        if (merged.length === 0) continue

        const { content, edits } = backfillArticle(article.content, merged[0], wanted)
        if (edits.length === 0) continue

        for (const e of edits) {
          rows.push({
            agent: agentId,
            article: article.meta.title.slice(0, 32),
            field: e.field,
            action: e.replaced ? "replace" : "add",
            // Values are identifiers; show that one was found, not what it is.
            got: `${e.value.split(";").length} value(s)`,
          })
        }
        if (opts.apply) {
          const ok = store.writeArticle(meta.path, article.meta, content, agentId)
          if (ok) written++
          else console.log(chalk.red(`  could not write ${meta.path}`))
        }
      }
    }

    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return }
    if (rows.length === 0) {
      console.log(chalk.green(`  ${considered} person article(s) considered — nothing to backfill`))
      return
    }
    const cols = ["agent", "article", "field", "action", "got"]
    const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)))
    const fmt = (cells: any[]) => cells.map((v, i) => String(v).padEnd(w[i])).join("  ")
    console.log()
    console.log(chalk.bold(fmt(cols)))
    for (const r of rows) console.log(fmt(cols.map((c) => r[c])))
    console.log()
    if (opts.apply) {
      console.log(chalk.green(`  ${rows.length} field(s) written across ${written} article(s).`))
      console.log(chalk.dim("  Prior versions are in _versions/ if any of this is wrong."))
    } else {
      console.log(chalk.dim(`  ${rows.length} field(s) would be written across ${considered} article(s) considered.`))
      console.log(chalk.dim("  Re-run with --apply to write them."))
    }
  })

// The questions only a person can answer, and the way back in.
//
// Everything a lookup could close is closed by `wiki backfill`. What is
// left is judgement — a preferred language, who owns a relationship,
// why a decision was made — and no amount of machinery produces it.
// These two commands are the whole human path: see what is being
// asked, answer it, and have the answer land in the source of truth
// rather than in a chat log.
wiki
  .command("questions")
  .alias("ask")
  .description("gaps waiting on a person")
  .option("--dir <path>", "wiki directory")
  .option("--status <s>", "open | answered | dismissed", "open")
  .option("--json")
  .action(async (opts) => {
    const { QuestionStore } = await import("@/wiki/questions")
    const { TIER_RANK } = await import("@/decisions/seats/article-fields")
    const qs = new QuestionStore(wikiDir(opts.dir)).list(opts.status as never)
    if (opts.json) { console.log(JSON.stringify(qs, null, 2)); return }
    if (qs.length === 0) { console.log(chalk.green(`  no ${opts.status} questions`)); return }

    // Most load-bearing first, same order the articles should be built in.
    qs.sort((a, b) =>
      (TIER_RANK[(a.tier ?? "furniture") as keyof typeof TIER_RANK] ?? 9) -
      (TIER_RANK[(b.tier ?? "furniture") as keyof typeof TIER_RANK] ?? 9))

    console.log()
    for (const q of qs) {
      const tier = q.tier ? chalk.dim(`[${q.tier}]`) : ""
      console.log(`  ${chalk.cyan(q.id)} ${tier} ${q.question}`)
      if (q.answer) console.log(chalk.dim(`    → ${q.answer}`))
    }
    console.log()
    console.log(chalk.dim(`  ${qs.length} ${opts.status}.  agentx wiki answer <id> "<value>"  ·  --dismiss to drop one`))
  })

wiki
  .command("answer <id> [value]")
  .description("answer a queued question; writes it into the article")
  .option("--dir <path>", "wiki directory")
  .option("--mode <mode>", "graph | unified | flat", "graph")
  .option("--dismiss", "close the question without answering it")
  .action(async (id, value, opts) => {
    const { QuestionStore } = await import("@/wiki/questions")
    const { patchIdentityField } = await import("@/wiki/backfill")
    const { IDENTITY_SLOTS } = await import("@/decisions/seats/article-fields")
    const store = new QuestionStore(wikiDir(opts.dir))

    // A fact disagreement a person already settled stays settled: say so
    // rather than re-open it or throw at an agent.
    const closed = store.list().find((x) => (x.id === id || x.id.startsWith(id)) && x.status !== "open" && x.kind === "contradiction")
    if (closed && !store.list("open").some((x) => x.id === id || x.id.startsWith(id))) {
      console.log(chalk.dim(`  already ${closed.status}: ${closed.question}`))
      return
    }
    if (opts.dismiss) {
      try {
        const q = store.resolve(id, "dismissed")
        console.log(q ? chalk.dim(`  dismissed: ${q.question}`) : chalk.red(`  no question matching "${id}"`))
      } catch (e: any) {
        console.log(chalk.red(`  ${e?.message ?? e}`))
        console.log(chalk.yellow("  the question stays open."))
        process.exitCode = 1
      }
      return
    }
    if (!value) { console.log(chalk.red("  give a value, or pass --dismiss")); return }

    // A fact contradiction: the answer is the true value, confirmed by a
    // person, so it is written to the fact ledger over either side. The
    // ledger is written first: an unreadable ledger leaves the question open.
    const pendingQ = store.list("open").find((x) => x.id === id || x.id.startsWith(id))
    if (pendingQ?.kind === "contradiction" && pendingQ.factId) {
      const { FactLedger } = await import("@/wiki/facts/ledger")
      const ledger = new FactLedger(wikiDir(opts.dir))
      try {
        const fact = ledger.get(pendingQ.factId)
        if (fact) {
          const r = ledger.write(
            { subject: fact.subject, attribute: fact.attribute, value, source: "owner said", verifiedBy: "operator", volatility: fact.volatility },
            { confirmedBy: "operator" },
          )
          console.log(chalk.green(`  ${r.status}: ${fact.id} ${fact.subject} · ${fact.attribute}: ${r.fact.value}`))
        } else {
          console.log(chalk.yellow(`  fact ${pendingQ.factId} is gone; answer recorded only.`))
        }
      } catch (e: any) {
        if (e?.name !== "LedgerCorruptError") console.log(chalk.red(`  ${e?.message ?? e}`))
        console.log(chalk.yellow("  the question stays open."))
        process.exitCode = 1
        return
      }
      store.resolve(pendingQ.id, "answered", value)
      console.log(chalk.green(`  answered: ${pendingQ.question}`))
      return
    }

    let q
    try {
      q = store.resolve(id, "answered", value)
    } catch (e: any) {
      console.log(chalk.red(`  ${e?.message ?? e}`))
      console.log(chalk.yellow("  nothing changed."))
      process.exitCode = 1
      return
    }
    if (!q) { console.log(chalk.red(`  no question matching "${id}"`)); return }
    console.log(chalk.green(`  answered: ${q.question}`))

    // An answer to a missing-article question is a note, not a patch —
    // there is no article yet to write it into. Absorb will create one
    // when the entries justify it.
    if (q.kind !== "field" || !q.field || !q.path) {
      console.log(chalk.dim("  recorded. No article to patch yet."))
      return
    }
    // Only the identity fields have a defined place in the article. For
    // anything else the answer is recorded and a person decides where
    // it belongs — guessing a location in the source of truth is worse
    // than leaving the answer on the queue.
    if (!IDENTITY_SLOTS[q.field]) {
      console.log(chalk.dim(`  recorded against ${q.path}. "${q.field}" has no fixed slot, so nothing was rewritten.`))
      return
    }

    const hub = getHub(opts.dir, opts.mode as WikiMode)
    const store2 = hub.getAgentWiki(q.agentId)
    const article = store2.readArticle(q.path)
    if (!article) { console.log(chalk.yellow(`  article gone: ${q.path}`)); return }

    const patched = patchIdentityField(article.content, q.field, `${value} (answered by operator)`)
    if (!patched) { console.log(chalk.dim("  already present — nothing to write.")); return }
    const ok = store2.writeArticle(q.path, article.meta, patched.content, q.agentId)
    console.log(ok
      ? chalk.green(`  wrote ${q.field} into ${q.path} (prior version kept)`)
      : chalk.red(`  could not write ${q.path}`))
  })

// Does the triage gate actually work? Measured, not assumed.
//
// The seat has existed unwired for a while because nothing could say
// whether it was right. The corpus answers that: absorb has already
// judged 5,626 entries, so the gate can be run against its verdicts
// before it is allowed to drop anything.
wiki
  .command("triage-backtest")
  .description("grade the entry-triage gate against what absorb actually kept")
  .option("--dir <path>", "wiki directory")
  .option("--n <n>", "entries to sample (half positive, half negative)", "200")
  .option("--min-worth <n>", "P(useful in six months) required to keep")
  .option("--min-durability <n>", "expected durability required to keep")
  .option("--min-type <n>", "type confidence required to keep")
  .option("--sweep", "search thresholds for the most filtering that still keeps ~all positives")
  .option("--min-recall <n>", "recall floor for --sweep", "0.95")
  .option("--save <file>", "write the graded outcomes so sweeps can be re-run for free")
  .option("--load <file>", "re-sweep saved outcomes without paying for the calls again")
  .option("--json")
  .action(async (opts) => {
    const { ENTRY_TRIAGE_SEAT, entryTriageQuestions, triageState, triage } =
      await import("@/decisions/seats/entry-triage")
    const { askSeat } = await import("@/decisions/seat")
    const { labelEntries, sample, scoreBacktest, toGradedRows, sweepPolicies } = await import("@/wiki/triage-backtest")
    const { calibrationReport } = await import("@/decisions/calibration")

    const hub = getHub(opts.dir, "graph")
    const shared = hub.getSharedStore() as never as {
      listEntries: () => Array<{ id: string; date?: string; source?: string; sourceContext?: string; content: string }>
      getUnabsorbedEntries: () => Array<{ id: string }>
    }
    const all = shared.listEntries()
    const unabsorbed = new Set(shared.getUnabsorbedEntries().map((e) => e.id))
    const { labeled, backlog } = labelEntries(all, unabsorbed)
    const picked = sample(labeled, (e) => e.absorbed, parseInt(opts.n))

    const policy = {
      minWorth: opts.minWorth ? parseFloat(opts.minWorth) : undefined,
      minDurability: opts.minDurability ? parseFloat(opts.minDurability) : undefined,
      minTypeConfidence: opts.minType ? parseFloat(opts.minType) : undefined,
    }

    const outcomes: Array<{ entry: typeof picked[number]; verdict: ReturnType<typeof triage>; citeWorthy?: number }> = []
    let failures = 0
    const t0 = Date.now()

    // Model calls are the expensive part; thresholds are free to vary
    // afterwards. Caching them turns a 74-second sweep into an instant one.
    if (opts.load) {
      const { readFileSync } = await import("fs")
      outcomes.push(...JSON.parse(readFileSync(opts.load, "utf-8")))
      console.log(chalk.dim(`  re-sweeping ${outcomes.length} saved outcome(s) — no calls made`))
    } else {
      console.log(chalk.dim(`  ${labeled.length} labelled (${backlog} in backlog) — grading ${picked.length}`))
    }

    for (const entry of opts.load ? [] : picked) {
      const res = await askSeat(ENTRY_TRIAGE_SEAT, triageState(entry), entryTriageQuestions, {
        features: { source: entry.source ?? "", absorbed: entry.absorbed },
      })
      if (!res) { failures++; continue }
      const a = res.answers as never as { citeWorthy?: { noul: number } }
      outcomes.push({
        entry,
        verdict: triage(res.answers as never, policy),
        citeWorthy: a.citeWorthy?.noul,
      })
    }

    if (outcomes.length === 0) {
      console.log(chalk.yellow("  seat is off or unavailable — set decisions.seats.entry-triage.mode"))
      return
    }

    if (opts.save) {
      const { writeFileSync } = await import("fs")
      writeFileSync(opts.save, JSON.stringify(outcomes))
      console.log(chalk.dim(`  saved ${outcomes.length} outcome(s) to ${opts.save}`))
    }

    const report = scoreBacktest(outcomes, {
      minType: policy.minTypeConfidence, minWorth: policy.minWorth, minDurability: policy.minDurability,
    })
    // The seat records backend and model per call in its own store; the
    // backtest only needs the rows to carry a consistent tag.
    const rows = toGradedRows(outcomes, "seat", "seat")
    const cal = calibrationReport(rows, { minN: 50 })
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

    if (opts.json) {
      console.log(JSON.stringify({ report, calibration: cal, failures, elapsed }, null, 2))
      return
    }

    const pct = (x: number) => `${(x * 100).toFixed(1)}%`
    console.log()
    console.log(chalk.bold("  entry-triage vs absorb's own verdicts"))
    console.log(`    graded        ${report.n}  (${report.positives} kept by absorb, ${report.negatives} passed over)`)
    console.log(`    recall        ${pct(report.recall)}   ${chalk.dim("of what absorb kept, the gate would keep")}`)
    console.log(`    precision     ${pct(report.precision)}   ${chalk.dim("of what the gate keeps, absorb agreed")}`)
    console.log(`    filtered      ${pct(report.filtered)}   ${chalk.dim("never reaches the writing model")}`)
    console.log(`    ${report.lostPositives > 0 ? chalk.yellow(`lost          ${report.lostPositives} article(s) absorb would have written`) : chalk.green("lost          0 — nothing absorb kept was dropped")}`)
    if (!("insufficient" in cal) || !cal.insufficient) {
      console.log(`    ECE           ${(cal as { ece: number }).ece?.toFixed(3) ?? "n/a"}   ${chalk.dim("on P(worth keeping)")}`)
    }
    if (report.lostPositives > 0) {
      const d = report.droppedBy
      console.log(chalk.dim(`    dropped by:   type ${d.type} · worth ${d.worth} · durability ${d.durability}  (a positive can fail several)`))
    }
    const m = report.positiveMeans
    console.log(chalk.dim(`    positives avg: worth ${m.worth.toFixed(2)} · durability ${m.durability.toFixed(2)} · typeConf ${m.typeConfidence.toFixed(2)}`))
    console.log(chalk.dim(`    ${elapsed}s, ${failures} seat failure(s)`))
    console.log()
    console.log(chalk.dim("    Recall is the number that decides this: a dropped positive is"))
    console.log(chalk.dim("    knowledge destroyed silently. Filtered is only the prize."))

    if (opts.sweep) {
      // Free: the calls are already paid for, only the thresholds vary.
      const floor = parseFloat(opts.minRecall)
      const { best, points } = sweepPolicies(outcomes, { minRecall: floor })
      console.log()
      console.log(chalk.bold(`  threshold sweep (${points.length} policies, recall floor ${pct(floor)})`))
      if (!best) {
        console.log(chalk.red(`    No policy reaches ${pct(floor)} recall — not even keeping everything typed.`))
        const loosest = points.slice().sort((a, b) => b.recall - a.recall)[0]
        if (loosest) {
          console.log(chalk.dim(`    Best recall available: ${pct(loosest.recall)} at ${loosest.requireTyped ? `type>=${loosest.minType}` : "type gate OFF"} worth>=${loosest.minWorth} dur>=${loosest.minDurability}, filtering ${pct(loosest.filtered)}`))
        }
        console.log(chalk.yellow("    The gate is not safe to run in active mode on this evidence."))
      } else {
        console.log(`    best: ${best.requireTyped ? `typed & type>=${best.minType}` : "type gate OFF"}  worth>=${best.minWorth}  durability>=${best.minDurability}`)
        console.log(`          recall ${pct(best.recall)} · filtered ${pct(best.filtered)} · precision ${pct(best.precision)} · lost ${best.lostPositives}`)
        console.log(chalk.dim("    Filtering here is the real saving; anything above it costs articles."))
      }
    }
  })

wiki
  .command("import <archive>")
  .description("restore a wiki archive (created with `agentx wiki export`)")
  .option("--dir <path>", "where to restore (default: .agentx/wiki)")
  .option("--force", "overwrite existing wiki without prompting")
  .action(async (archive, opts) => {
    const archivePath = resolve(process.cwd(), archive)
    if (!existsSync(archivePath)) {
      console.log(chalk.red(`  archive not found: ${archivePath}`))
      process.exit(1)
    }
    const target = opts.dir ? resolve(process.cwd(), opts.dir) : resolve(process.cwd(), ".agentx/wiki")
    if (existsSync(target) && !opts.force) {
      console.log(chalk.yellow(`  ${target} already exists.`))
      console.log(chalk.yellow(`  Re-run with --force to overwrite (existing files where the archive has them; others stay).`))
      process.exit(1)
    }
    const parent = resolve(target, "..")
    const { mkdirSync } = await import("fs")
    mkdirSync(parent, { recursive: true })
    const args = ["-C", parent, "-xzf", archivePath]
    console.log(chalk.dim(`  tar ${args.join(" ")}`))
    const { spawnSync } = await import("child_process")
    const r = spawnSync("tar", args, { stdio: "inherit" })
    if (r.status !== 0) {
      console.log(chalk.red(`  tar exited with ${r.status}`))
      process.exit(r.status || 1)
    }
    console.log()
    console.log(chalk.green(`  ✓ restored to ${target}`))
    console.log(chalk.dim(`  Restart the daemon (or POST /reload) for the wiki hub to pick up the new content.`))
    console.log()
  })

function formatWikiBytes(b: number): string {
  if (b < 1024) return b + "B"
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + "K"
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + "M"
  return (b / 1024 / 1024 / 1024).toFixed(2) + "G"
}
