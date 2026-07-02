import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { AgentMemory, type MemoryRecord, type MemoryType } from "../agents/agent-memory"
import { WikiStore } from "./store"
import { buildMemoryPromotePrompt } from "./prompts"
import { isWikiArticleType, type WikiIndex } from "./types"

// --- Memory → wiki promotion ---
//
// Finishes the architecture documented in agent-memory.ts: memory is
// experiential / per-agent; the wiki is authoritative / cross-agent. This
// module reads per-agent memories, decides (via an LLM judge) which are
// durable and fleet-relevant, and writes them as [[wikilinked]] articles
// in the SHARED wiki store.
//
// Idempotency has two layers, both keyed on the versioned stamp
// `memory:<agentId>/<type>_<name>@<updatedAt>`:
//
//   1. Promoted memories: the stamp is recorded in the target article's
//      `sources[]` frontmatter (same pattern as getUnabsorbedEntries).
//   2. Skipped memories: recorded in `.agentx/wiki/_memory-promotions.json`
//      so permanently-irrelevant memories aren't re-judged every night.
//
// A bumped `updatedAt` beats both — an edited memory re-enters the
// pipeline, and mergeSources() replaces the stale stamp for its key so
// frontmatter stays bounded (one stamp per memory, not per edit).

export const PROMOTER_OWNER = "memory-promoter"
export const DEFAULT_PROMOTE_TYPES: MemoryType[] = ["project", "reference", "feedback"]
export const PROMOTION_LEDGER_FILE = "_memory-promotions.json"

const STAMP_PREFIX = "memory:"
const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"]

export interface MemoryCandidate {
  agentId: string
  memory: MemoryRecord
  /** Identity without version: `<agentId>/<type>_<name>` */
  key: string
  /** Identity + version: `memory:<key>@<updatedAt>` */
  stamp: string
}

export interface PromotionLedgerEntry {
  stamp: string
  decision: "promoted" | "skipped"
  /** Article path when promoted. */
  article?: string
  /** LLM skip reason. */
  reason?: string
  /** ISO run timestamp. */
  at: string
}

export type PromotionLedger = PromotionLedgerEntry[]

// --- Stamps -------------------------------------------------------------

export function memoryKey(agentId: string, m: Pick<MemoryRecord, "type" | "name">): string {
  return `${agentId}/${m.type}_${m.name}`
}

export function memoryStamp(agentId: string, m: Pick<MemoryRecord, "type" | "name" | "updatedAt">): string {
  return `${STAMP_PREFIX}${memoryKey(agentId, m)}@${m.updatedAt}`
}

/** Parse a `memory:<agentId>/<type>_<name>@<updatedAt>` source stamp.
 *  Returns null for anything else (raw entry ids, malformed stamps) so
 *  callers can filter article `sources[]` safely. */
export function parseMemoryStamp(s: string): {
  agentId: string
  type: MemoryType
  name: string
  updatedAt: string
  key: string
} | null {
  if (!s.startsWith(STAMP_PREFIX)) return null
  const rest = s.slice(STAMP_PREFIX.length)
  const slash = rest.indexOf("/")
  const at = rest.lastIndexOf("@")
  if (slash <= 0 || at <= slash) return null
  const agentId = rest.slice(0, slash)
  const typeName = rest.slice(slash + 1, at)
  const updatedAt = rest.slice(at + 1)
  if (!updatedAt) return null
  const underscore = typeName.indexOf("_")
  if (underscore <= 0) return null
  const type = typeName.slice(0, underscore) as MemoryType
  const name = typeName.slice(underscore + 1)
  if (!MEMORY_TYPES.includes(type) || !name) return null
  return { agentId, type, name, updatedAt, key: `${agentId}/${typeName}` }
}

/** Merge new promotion stamps into an article's existing sources: a new
 *  stamp REPLACES any prior stamp sharing its key (one stamp per memory,
 *  not one per edit); everything else (raw entry ids, other memories'
 *  stamps) is kept. Deduped, order-stable. */
export function mergeSources(existing: string[] | undefined, newStamps: string[]): string[] {
  const newKeys = new Set<string>()
  for (const s of newStamps) {
    const parsed = parseMemoryStamp(s)
    if (parsed) newKeys.add(parsed.key)
  }
  const out: string[] = []
  for (const s of existing ?? []) {
    const parsed = parseMemoryStamp(s)
    if (parsed && newKeys.has(parsed.key)) continue // superseded
    if (!out.includes(s)) out.push(s)
  }
  for (const s of newStamps) {
    if (!out.includes(s)) out.push(s)
  }
  return out
}

// --- Cross-agent memory enumeration --------------------------------------

/** List every agent's memories. AgentMemory has no cross-agent API — we
 *  enumerate the agent subdirs of `.agentx/agent-memory/` ourselves.
 *  `memoryRoot` is the `.agentx` directory (AgentMemory's baseDir root). */
export function listAllAgentMemories(
  memoryRoot: string = resolve(process.cwd(), ".agentx"),
): Array<{ agentId: string; memory: MemoryRecord }> {
  const store = new AgentMemory({ baseDir: memoryRoot })
  if (!existsSync(store.baseDir)) return []
  const out: Array<{ agentId: string; memory: MemoryRecord }> = []
  for (const entry of readdirSync(store.baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue
    for (const memory of store.list(entry.name)) {
      out.push({ agentId: entry.name, memory })
    }
  }
  return out
}

// --- Skip ledger ----------------------------------------------------------

export function readPromotionLedger(wikiBaseDir: string): PromotionLedger {
  const path = resolve(wikiBaseDir, PROMOTION_LEDGER_FILE)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is PromotionLedgerEntry =>
        e && typeof e.stamp === "string" && (e.decision === "promoted" || e.decision === "skipped"),
    )
  } catch {
    // Corrupt ledger → treat as empty. Worst case: skipped memories are
    // re-judged once. Promoted memories stay deduped via article sources.
    return []
  }
}

/** Append entries and compact: keep only the newest entry per memory key
 *  so the ledger stays bounded. */
export function appendPromotionLedger(wikiBaseDir: string, entries: PromotionLedgerEntry[]): void {
  const merged = [...readPromotionLedger(wikiBaseDir), ...entries]
  const byKey = new Map<string, PromotionLedgerEntry>()
  for (const e of merged) {
    const parsed = parseMemoryStamp(e.stamp)
    const key = parsed?.key ?? e.stamp
    const prev = byKey.get(key)
    if (!prev || (parsed && (parseMemoryStamp(prev.stamp)?.updatedAt ?? "") <= parsed.updatedAt)) {
      byKey.set(key, e)
    }
  }
  writeFileSync(
    resolve(wikiBaseDir, PROMOTION_LEDGER_FILE),
    JSON.stringify([...byKey.values()], null, 2),
  )
}

// --- Clustering -------------------------------------------------------------

export interface PromotionCluster {
  /** ≥1 candidate; >1 when the same `<type>_<name>` exists on several agents. */
  candidates: MemoryCandidate[]
  corroboratingAgents: string[]
  /** 0.5 base + 0.15 per extra corroborating agent + 0.05 for
   *  project|reference types, capped at 0.95. Advisory only — shown to
   *  the LLM judge, never a hard gate (mirrors clusterWorkflowCandidates). */
  confidence: number
}

/** Group candidates that share `<type>_<name>` across agents. Exact-match
 *  clustering only — two agents naming a memory identically is treated as
 *  corroboration; fuzzy matching is future work. */
export function groupCandidates(cands: MemoryCandidate[]): PromotionCluster[] {
  const byName = new Map<string, MemoryCandidate[]>()
  for (const c of cands) {
    const k = `${c.memory.type}_${c.memory.name}`
    const list = byName.get(k) ?? []
    list.push(c)
    byName.set(k, list)
  }
  return [...byName.values()].map((candidates) => {
    const corroboratingAgents = [...new Set(candidates.map((c) => c.agentId))].sort()
    const typeBoost = ["project", "reference"].includes(candidates[0].memory.type) ? 0.05 : 0
    const confidence = Math.min(0.95, 0.5 + 0.15 * (corroboratingAgents.length - 1) + typeBoost)
    return { candidates, corroboratingAgents, confidence }
  })
}

// --- LLM response parsing ----------------------------------------------------

export interface PromotedArticle {
  path: string
  title: string
  type?: string
  related?: string[]
  tags: string[]
  content: string
  /** Validated stamps of the memories this article was promoted from. */
  promotedFrom: string[]
}

export interface PromotionResponse {
  articles: PromotedArticle[]
  skipped: Array<{ stamp: string; reason: string }>
  gaps: string[]
  /** Stamp refs the LLM emitted that weren't in the offered set, plus
   *  articles dropped for having zero valid stamps. For the report. */
  warnings: string[]
}

/** Parse the promotion LLM's reply. Balanced-JSON extraction (adapted from
 *  the wiki absorb CLI): find the outermost `{...}`, depth-scan to its
 *  close, JSON.parse, then validate. Stamps not present in `offeredStamps`
 *  are hallucinations — dropped; an article left with zero valid stamps is
 *  dropped entirely (nothing to dedupe against on the next run). Any
 *  failure returns `{error}` — the caller must write nothing. */
export function parsePromotionResponse(
  text: string,
  offeredStamps: Set<string>,
): PromotionResponse | { error: string } {
  const start = text.indexOf("{")
  if (start === -1) return { error: "no JSON object in response" }
  let depth = 0
  let end = -1
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === "\\") { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end === -1) return { error: "unbalanced JSON in response" }

  let parsed: any
  try {
    parsed = JSON.parse(text.slice(start, end))
  } catch (e: any) {
    return { error: `JSON parse error: ${e.message}` }
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.articles)) {
    return { error: "response JSON missing articles array" }
  }

  const warnings: string[] = []
  const articles: PromotedArticle[] = []
  for (const a of parsed.articles) {
    if (!a || typeof a.path !== "string" || typeof a.title !== "string" || typeof a.content !== "string") {
      warnings.push(`article missing path/title/content — dropped`)
      continue
    }
    const raw = Array.isArray(a.promotedFrom) ? a.promotedFrom.filter((s: unknown) => typeof s === "string") : []
    const promotedFrom = raw.filter((s: string) => offeredStamps.has(s))
    for (const s of raw) {
      if (!offeredStamps.has(s)) warnings.push(`article "${a.path}" references unknown stamp "${s}" — dropped`)
    }
    if (promotedFrom.length === 0) {
      warnings.push(`article "${a.path}" has no valid promotedFrom stamps — dropped`)
      continue
    }
    articles.push({
      path: a.path,
      title: a.title,
      type: typeof a.type === "string" ? a.type : undefined,
      related: Array.isArray(a.related) ? a.related.filter((r: unknown) => typeof r === "string") : undefined,
      tags: Array.isArray(a.tags) ? a.tags.filter((t: unknown) => typeof t === "string") : [],
      content: a.content,
      promotedFrom,
    })
  }

  const skipped: Array<{ stamp: string; reason: string }> = []
  for (const s of Array.isArray(parsed.skipped) ? parsed.skipped : []) {
    const stamp = typeof s?.memory === "string" ? s.memory : typeof s?.stamp === "string" ? s.stamp : ""
    if (!offeredStamps.has(stamp)) {
      if (stamp) warnings.push(`skip references unknown stamp "${stamp}" — dropped`)
      continue
    }
    skipped.push({ stamp, reason: typeof s.reason === "string" ? s.reason : "" })
  }

  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps.filter((g: unknown) => typeof g === "string") : []
  return { articles, skipped, gaps, warnings }
}

// --- Candidate selection ---------------------------------------------------

export interface UnpromotedOptions {
  /** Memory types to consider. Default: project, reference, feedback. */
  types?: MemoryType[]
  /** Only memories updated within this window (ms before `now`). */
  sinceMs?: number
  /** Only this agent's memories. */
  agentFilter?: string
  /** Reference clock for `sinceMs` (injectable for tests). Default Date.now(). */
  now?: number
  /** Cap on returned candidates (newest first). Default 20. */
  max?: number
}

/** Diff all agent memories against what's already been promoted (article
 *  `sources[]` stamps across the shared index) or deliberately skipped
 *  (ledger). A memory is a candidate iff its key is unseen OR its
 *  `updatedAt` is newer than the recorded one — ISO-8601 strings compare
 *  lexicographically, so plain `>` is safe. */
export function getUnpromotedMemories(
  all: Array<{ agentId: string; memory: MemoryRecord }>,
  index: WikiIndex,
  ledger: PromotionLedger,
  opts: UnpromotedOptions = {},
): MemoryCandidate[] {
  const types = opts.types ?? DEFAULT_PROMOTE_TYPES
  const now = opts.now ?? Date.now()
  const max = opts.max ?? 20

  // key → newest updatedAt already handled (promoted or skipped)
  const seen = new Map<string, string>()
  const record = (stamp: string) => {
    const parsed = parseMemoryStamp(stamp)
    if (!parsed) return
    const prev = seen.get(parsed.key)
    if (!prev || parsed.updatedAt > prev) seen.set(parsed.key, parsed.updatedAt)
  }
  for (const article of index.articles) {
    for (const s of article.sources ?? []) record(s)
  }
  for (const e of ledger) record(e.stamp)

  const candidates: MemoryCandidate[] = []
  for (const { agentId, memory } of all) {
    if (!types.includes(memory.type)) continue
    if (opts.agentFilter && agentId !== opts.agentFilter) continue
    if (opts.sinceMs !== undefined) {
      const updated = Date.parse(memory.updatedAt)
      if (!Number.isFinite(updated) || updated < now - opts.sinceMs) continue
    }
    const key = memoryKey(agentId, memory)
    const handled = seen.get(key)
    if (handled && memory.updatedAt <= handled) continue
    candidates.push({ agentId, memory, key, stamp: memoryStamp(agentId, memory) })
  }

  return candidates
    .sort((a, b) => b.memory.updatedAt.localeCompare(a.memory.updatedAt))
    .slice(0, max)
}

// --- LLM transport -----------------------------------------------------------

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_VERSION = "2023-06-01"

export interface PromotionLlmOptions {
  /** Route through the daemon: POST /task to this agent. No API key needed —
   *  the agent's own session handles auth (mirrors architectWorkflowViaAgent). */
  viaAgent?: string
  /** Direct Anthropic API model. Requires ANTHROPIC_API_KEY. */
  model?: string
  daemonUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Stable chat id so a retry's --resume replay sees the first reply. */
  chatId?: string
}

/** Run the promotion prompt through an LLM and return the raw reply text.
 *  Throws on transport failure — the caller decides whether to retry.
 *  `feedback` turns the call into a correction round: the via-agent branch
 *  resumes the same session; the direct branch replays the conversation. */
export async function callPromotionLlm(
  prompt: string,
  opts: PromotionLlmOptions,
  feedback: string | null = null,
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 180_000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    if (opts.viaAgent) {
      const daemonUrl = (opts.daemonUrl ?? "http://127.0.0.1:18800").replace(/\/+$/, "")
      const message = feedback
        ? `Your previous response failed validation: ${feedback}\nRe-emit the FULL corrected JSON object — same structure, fixed issues, valid JSON only.`
        : prompt
      const res = await fetchImpl(`${daemonUrl}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: opts.viaAgent,
          message,
          // First call gets a fresh session; the retry resumes it so the
          // agent can fix its own output instead of starting over.
          freshSession: feedback === null,
          context: { channel: "api", chatId: opts.chatId ?? "memory-promote" },
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const errBody = await res.text().catch(() => "")
        throw new Error(`agent /task ${res.status}: ${errBody.slice(0, 500)}`)
      }
      const body: any = await res.json()
      if (body.error) throw new Error(`agent reported error: ${body.error}`)
      const content = String(body.content ?? "").trim()
      if (!content) throw new Error("agent returned empty content")
      return content
    }

    if (!opts.model) throw new Error("callPromotionLlm: viaAgent or model is required")
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set; use --via <agentId> instead")
    const messages: Array<{ role: string; content: string }> = [{ role: "user", content: prompt }]
    if (feedback) {
      messages.push({ role: "assistant", content: "(previous attempt; will retry with corrections)" })
      messages.push({ role: "user", content: `Your previous response failed validation: ${feedback}\nRe-emit the FULL corrected JSON object.` })
    }
    const res = await fetchImpl(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model: opts.model, max_tokens: 8000, messages }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      throw new Error(`anthropic API ${res.status}: ${errBody.slice(0, 500)}`)
    }
    const body: any = await res.json()
    const blocks = Array.isArray(body.content) ? body.content : []
    const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim()
    if (!text) throw new Error("anthropic API returned no text content")
    return text
  } finally {
    clearTimeout(timer)
  }
}

// --- Orchestrator ------------------------------------------------------------

export interface RunPromotionOptions extends PromotionLlmOptions {
  /** Wiki base dir (the shared store). Default `.agentx/wiki`. */
  wikiDir?: string
  /** The `.agentx` dir holding `agent-memory/`. Default `.agentx`. */
  memoryRoot?: string
  sinceMs?: number
  agentFilter?: string
  types?: MemoryType[]
  max?: number
  /** Write articles + ledger. Default false (dry-run). */
  commit?: boolean
  log?: (msg: string) => void
  /** Injectable clock (tests). */
  now?: number
}

export interface PromotionReport {
  candidates: MemoryCandidate[]
  clusters: PromotionCluster[]
  written: Array<{ path: string; title: string; type?: string; related?: string[]; stamps: string[] }>
  skipped: Array<{ stamp: string; reason: string }>
  gaps: string[]
  warnings: string[]
  errors: string[]
  dryRun: boolean
}

/** End-to-end promotion run: enumerate memories → diff against promoted/
 *  skipped → cluster → (dry-run stops here) → LLM judge → write articles
 *  with merged sources → ledger → rebuild index. Parses the full response
 *  before any write — a bad reply writes nothing, and idempotency makes
 *  the next scheduled run retry for free. */
export async function runPromotion(opts: RunPromotionOptions = {}): Promise<PromotionReport> {
  const wikiDir = opts.wikiDir ?? resolve(process.cwd(), ".agentx", "wiki")
  const memoryRoot = opts.memoryRoot ?? resolve(process.cwd(), ".agentx")
  const log = opts.log ?? (() => {})
  const now = opts.now ?? Date.now()
  const report: PromotionReport = {
    candidates: [], clusters: [], written: [], skipped: [],
    gaps: [], warnings: [], errors: [], dryRun: !opts.commit,
  }

  const store = new WikiStore(wikiDir, (...args: unknown[]) => log(args.map(String).join(" ")))
  const index = store.rebuildIndex()
  const ledger = readPromotionLedger(wikiDir)
  const all = listAllAgentMemories(memoryRoot)

  report.candidates = getUnpromotedMemories(all, index, ledger, {
    types: opts.types,
    sinceMs: opts.sinceMs,
    agentFilter: opts.agentFilter,
    now,
    max: opts.max,
  })
  if (report.candidates.length === 0) {
    log("no unpromoted memories in window")
    return report
  }
  report.clusters = groupCandidates(report.candidates)
  log(`${report.candidates.length} candidate(s) in ${report.clusters.length} cluster(s)`)
  if (report.dryRun) return report

  const prompt = buildMemoryPromotePrompt(
    PROMOTER_OWNER,
    report.clusters,
    index.articles.map((a) => ({ title: a.title, path: a.path, type: a.type })),
    store.getWorldview() ?? "",
  )
  const offered = new Set(report.candidates.map((c) => c.stamp))
  const chatId = opts.chatId ?? `memory-promote-${new Date(now).toISOString().slice(0, 10)}`

  let parsed = parsePromotionResponse(await callPromotionLlm(prompt, { ...opts, chatId }), offered)
  if ("error" in parsed) {
    log(`parse failed (${parsed.error}) — retrying with feedback`)
    parsed = parsePromotionResponse(await callPromotionLlm(prompt, { ...opts, chatId }, parsed.error), offered)
  }
  if ("error" in parsed) {
    report.errors.push(`LLM response unusable after retry: ${parsed.error}`)
    return report
  }
  report.warnings.push(...parsed.warnings)
  report.gaps = parsed.gaps

  const today = new Date(now).toISOString().slice(0, 10)
  const at = new Date(now).toISOString()
  const ledgerEntries: PromotionLedgerEntry[] = []

  for (const article of parsed.articles) {
    const existing = store.readArticle(article.path)
    const ok = store.writeArticle(
      article.path,
      {
        title: article.title,
        type: isWikiArticleType(article.type) ? article.type : undefined,
        related: article.related,
        tags: article.tags,
        owner: PROMOTER_OWNER,
        access: "public",
        created: existing?.meta.created ?? today,
        lastUpdated: today,
        sources: mergeSources(existing?.meta.sources, article.promotedFrom),
      },
      article.content,
      PROMOTER_OWNER,
    )
    if (!ok) {
      // Owned by another agent — a human resolves; stamps stay unledgered
      // so the memory is retried after the standoff clears.
      report.errors.push(`write denied for "${article.path}" (owned by ${existing?.meta.owner ?? "?"})`)
      continue
    }
    report.written.push({
      path: article.path, title: article.title, type: article.type,
      related: article.related, stamps: article.promotedFrom,
    })
    for (const stamp of article.promotedFrom) {
      ledgerEntries.push({ stamp, decision: "promoted", article: article.path, at })
    }
  }

  for (const s of parsed.skipped) {
    ledgerEntries.push({ stamp: s.stamp, decision: "skipped", reason: s.reason, at })
    report.skipped.push(s)
  }

  if (ledgerEntries.length) appendPromotionLedger(wikiDir, ledgerEntries)
  store.rebuildIndex()
  return report
}
