import { createHash } from "crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { resolve } from "path"
import type Database from "better-sqlite3"
import { buildIndex, scoreAll } from "@/memory/bm25"
import { getTrace, listTraces } from "@/storage/traces"
import { FactLedger } from "./facts/ledger"
import { lostStructuredFacts } from "./fact-guard"
import type { WikiHub } from "./hub"
import type { WikiStore } from "./store"
import { isWikiArticleType, type WikiArticle, type WikiArticleType } from "./types"

// --- Daily per-agent wiki contributions (#824) ---
//
// Only the central absorb wrote the wiki, and it missed what agents learn
// while working: a fleet test found money and status facts weeks stale
// although the owning agent had checked the current values that day.
//
// So each opted-in agent reviews its own work once a day (its chat turns
// and its task traces, with the tool calls it ran) and proposes small,
// sourced patches:
//
//   add      one fact line for a page
//   correct  the page states an old value; give the exact old text and
//            the new value
//   create   a short page for an entity that has none
//
// Every patch needs a source and a check date; one without is dropped.
// There is no field for a page body, so an agent cannot rewrite a page:
// rewrites are what lost facts in the test.
//
// One merge a day applies them all. Facts go through the fact ledger
// (facts/ledger.ts), so the newest check wins and the older value stays
// in the fact's history; pages keep every earlier body in `_versions/`.
// A patch that removes a fact, or an edit that would lose a phone number,
// email, role, contact marker, link or number, is held for a person.
//
// Storage, all skipped by the article index (`_` prefix):
//   _contributions/state.json            per-agent cursor
//   _contributions/pending/<run>.json    one batch per agent run
//   _contributions/merged/<run>.json     batches a merge consumed
//   _contributions/reports/<time>.json   what each merge did
//   _contributions/held.json             patches waiting for a person

export type ContributionKind = "add" | "correct" | "create" | "remove"

export interface ContributionPatch {
  /** Stable for the same agent, page, attribute, value and check. */
  id: string
  kind: ContributionKind
  /** Title of the page the patch is about. */
  page: string
  /** For `create`: the article type. */
  pageType?: WikiArticleType
  /** For `create`: other names the subject goes by. */
  aliases?: string[]
  /** "phone", "billing status", "main contact"… */
  attribute?: string
  value?: string
  /** For `correct` and `remove`: the exact text on the page that is wrong. */
  previous?: string
  /** For `create`: one sentence saying what the entity is. */
  summary?: string
  /** Where the agent checked it: a system, command, URL or "owner said". */
  source: string
  /** When it was checked (ISO). */
  checkedAt: string
  agentId: string
}

export interface ContributionBatch {
  id: string
  agentId: string
  runAt: string
  model: string
  /** Chat entries and task traces the run read. */
  workIds: string[]
  patches: ContributionPatch[]
  costUsd: number
  calls: number
  /** Why the run stopped before reading all of the agent's new work. */
  stoppedBy?: "max-patches" | "max-cost" | "max-items"
}

export interface ContributionLimits {
  /** Patches one run may submit. */
  maxPatches: number
  /** Model spend one run may reach, in USD. Each call is capped at what
   *  is left, and no call starts once it is spent. */
  maxCostUsd: number
  /** Chat entries and task traces one run reads. */
  maxItems: number
}

export const DEFAULT_CONTRIBUTION_LIMITS: ContributionLimits = { maxPatches: 30, maxCostUsd: 0.5, maxItems: 60 }

/** Work items sent to the model per call. */
const ITEMS_PER_CALL = 12
const ITEM_CHARS = 2000
const PAGE_CHARS = 1500
const PAGES_PER_CALL = 8
const FIELD_CHARS = 300
const STEPS_PER_TRACE = 12
export const FACTS_HEADING = "## Checked facts"

// --- Storage -----------------------------------------------------------------

export function contributionsDir(wikiDir: string): string {
  return resolve(wikiDir, "_contributions")
}

interface ContributionState {
  agents: Record<string, { lastRunAt: string; processed: string[] }>
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T
  } catch (err) {
    // A damaged file read as empty would be overwritten on the next save.
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`)
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(resolve(file, ".."), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, file)
}

function readState(wikiDir: string): ContributionState {
  const s = readJson<ContributionState>(resolve(contributionsDir(wikiDir), "state.json"), { agents: {} })
  return { agents: s.agents ?? {} }
}

export function listPendingBatches(wikiDir: string): ContributionBatch[] {
  const dir = resolve(contributionsDir(wikiDir), "pending")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => readJson<ContributionBatch | null>(resolve(dir, f), null))
    .filter((b): b is ContributionBatch => !!b)
}

export interface HeldPatch {
  id: string
  patch: ContributionPatch
  reason: string
  /** Facts the change would have lost. */
  lost?: string[]
  heldAt: string
  status: "held" | "approved" | "rejected"
  decidedBy?: string
  decidedAt?: string
}

function heldFile(wikiDir: string): string {
  return resolve(contributionsDir(wikiDir), "held.json")
}

/** Held patches; only those still waiting unless `all`. */
export function listHeld(wikiDir: string, opts: { all?: boolean } = {}): HeldPatch[] {
  const list = readJson<HeldPatch[]>(heldFile(wikiDir), [])
  return opts.all ? list : list.filter((h) => h.status === "held")
}

export function latestReport(wikiDir: string): MergeReport | null {
  const dir = resolve(contributionsDir(wikiDir), "reports")
  if (!existsSync(dir)) return null
  const last = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().pop()
  return last ? readJson<MergeReport | null>(resolve(dir, last), null) : null
}

// --- What a run reads --------------------------------------------------------

/** One piece of the agent's work: a chat turn or a task it ran. */
export interface WorkItem {
  id: string
  /** ISO time (or date) the work happened. */
  at: string
  kind: "chat" | "task"
  title: string
  text: string
}

/**
 * The agent's work since its last run, oldest first: its chat entries
 * from the wiki's raw pool and, given the trace database, the tasks it ran
 * with their tool calls and results. On a first run `since` (default:
 * the day before `now`) bounds the window.
 */
export function pendingWork(
  hub: WikiHub, wikiDir: string, agentId: string,
  opts: { db?: Database.Database; since?: string; now?: number } = {},
): WorkItem[] {
  const state = readState(wikiDir).agents[agentId]
  const now = opts.now ?? Date.now()
  const since = opts.since ?? state?.lastRunAt ?? new Date(now - 86_400_000).toISOString()
  const sinceDay = since.slice(0, 10)
  const done = new Set(state?.processed ?? [])
  const items: WorkItem[] = []

  for (const e of hub.getAgentEntries(agentId)) {
    if (e.date < sinceDay || done.has(e.id)) continue
    items.push({ id: e.id, at: e.date, kind: "chat", title: [e.source, e.sourceContext].filter(Boolean).join(" · "), text: e.content })
  }

  if (opts.db) {
    const sinceMs = Date.parse(since)
    for (const t of listTraces(opts.db, { agentId, since: Number.isFinite(sinceMs) ? sinceMs : undefined, limit: 500 })) {
      if (t.status === "in-flight" || done.has(t.taskId)) continue
      const steps = getTrace(opts.db, t.taskId)?.steps ?? []
      const tools = steps
        .filter((s) => s.name === "tool_use" || s.action)
        .slice(0, STEPS_PER_TRACE)
        .map((s) => `- ${s.action ?? s.name}${s.inputSummary ? ` ${clip(s.inputSummary, 160)}` : ""}${s.outputSummary ? ` → ${clip(s.outputSummary, 240)}` : ""}${s.error ? ` ✗ ${clip(s.error, 120)}` : ""}`)
      const text = [
        `Request: ${clip(t.originalMessage ?? t.messagePreview ?? "", 600)}`,
        tools.length ? `Tool calls:\n${tools.join("\n")}` : "",
        t.finalResponse ? `Reply: ${clip(t.finalResponse, 800)}` : "",
      ].filter(Boolean).join("\n")
      items.push({ id: t.taskId, at: new Date(t.startedAt).toISOString(), kind: "task", title: `task ${t.taskId}${t.channel ? ` · ${t.channel}` : ""}`, text })
    }
  }
  return items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

function saveCursor(wikiDir: string, agentId: string, read: WorkItem[], unread: WorkItem[], now: number): void {
  const state = readState(wikiDir)
  const prev = state.agents[agentId]
  // The cursor stays on the oldest item not read yet, so a run cut short
  // by a cap picks up there tomorrow; ids read at or after it are skipped.
  const lastRunAt = unread.length ? unread[0].at : new Date(now).toISOString()
  const processed = [...new Set([...(prev?.processed ?? []), ...read.map((w) => w.id)])].slice(-5000)
  state.agents[agentId] = { lastRunAt, processed }
  writeJson(resolve(contributionsDir(wikiDir), "state.json"), state)
}

// --- The run -----------------------------------------------------------------

/** One model call: the reply text and what it cost. `maxCostUsd` is what
 *  is left of the run's cap; the call must not spend more. */
export type ContributionCall = (prompt: string, maxCostUsd: number) => Promise<{ text: string; costUsd?: number }>

export interface ContributeOptions extends Partial<ContributionLimits> {
  model: string
  call: ContributionCall
  db?: Database.Database
  since?: string
  now?: number
  /** Compute the batch without saving it or moving the cursor. */
  dryRun?: boolean
}

/**
 * Review an agent's work since its last run and queue sourced patches
 * for the daily merge. Stops at the patch cap, the cost cap or the item
 * cap, whichever comes first.
 */
export async function runContribution(hub: WikiHub, wikiDir: string, agentId: string, opts: ContributeOptions): Promise<ContributionBatch> {
  const limits: ContributionLimits = {
    maxPatches: opts.maxPatches ?? DEFAULT_CONTRIBUTION_LIMITS.maxPatches,
    maxCostUsd: opts.maxCostUsd ?? DEFAULT_CONTRIBUTION_LIMITS.maxCostUsd,
    maxItems: opts.maxItems ?? DEFAULT_CONTRIBUTION_LIMITS.maxItems,
  }
  const now = opts.now ?? Date.now()
  const all = pendingWork(hub, wikiDir, agentId, { db: opts.db, since: opts.since, now })
  const pages = all.length ? readablePages(hub, agentId) : []
  const batch: ContributionBatch = {
    id: `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${agentId.replace(/[^\w-]+/g, "_")}`,
    agentId, runAt: new Date(now).toISOString(), model: opts.model,
    workIds: [], patches: [], costUsd: 0, calls: 0,
  }

  const read: WorkItem[] = []
  const seen = new Set<string>()
  while (read.length < all.length) {
    if (batch.patches.length >= limits.maxPatches) { batch.stoppedBy = "max-patches"; break }
    if (batch.costUsd >= limits.maxCostUsd) { batch.stoppedBy = "max-cost"; break }
    if (read.length >= limits.maxItems) { batch.stoppedBy = "max-items"; break }
    const chunk = all.slice(read.length, read.length + Math.min(ITEMS_PER_CALL, limits.maxItems - read.length))
    const prompt = buildContributionPrompt(agentId, chunk, relevantPages(pages, chunk), limits.maxPatches - batch.patches.length)
    const reply = await opts.call(prompt, Math.max(0.01, limits.maxCostUsd - batch.costUsd))
    batch.calls++
    batch.costUsd += reply.costUsd ?? 0
    read.push(...chunk)
    for (const p of parseContributionPatches(reply.text, agentId, { now })) {
      if (batch.patches.length >= limits.maxPatches) break
      if (seen.has(p.id)) continue
      seen.add(p.id)
      batch.patches.push(p)
    }
  }
  batch.workIds = read.map((w) => w.id)
  batch.costUsd = Math.round(batch.costUsd * 10_000) / 10_000

  if (!opts.dryRun) {
    if (batch.patches.length) writeJson(resolve(contributionsDir(wikiDir), "pending", `${batch.id}.json`), batch)
    saveCursor(wikiDir, agentId, read, all.slice(read.length), now)
  }
  return batch
}

interface PageRef {
  title: string
  aliases: string[]
  type?: WikiArticleType
  lastUpdated?: string
  content: string
}

/** Every page the agent may read: its own, then the shared wiki's. */
function readablePages(hub: WikiHub, agentId: string): PageRef[] {
  const out: PageRef[] = []
  const add = (store: WikiStore, skip?: (p: string) => boolean) => {
    for (const a of store.listArticles(agentId)) {
      if (a.path.includes("/_versions/") || skip?.(a.path)) continue
      out.push({ title: a.meta.title, aliases: a.meta.aliases ?? [], type: a.meta.type, lastUpdated: a.meta.lastUpdated, content: a.content })
    }
  }
  add(hub.getAgentWiki(agentId))
  for (const s of hub.sharedScope(agentId)) add(s.store, s.skip)
  return out
}

/**
 * Pages the work most likely touches: half by title and alias, half by
 * body. Titles alone missed a stale page whose title was worded
 * differently from the work, and the model created a duplicate instead
 * of correcting it (#824 review).
 */
function relevantPages(pages: PageRef[], items: WorkItem[]): PageRef[] {
  if (pages.length === 0) return []
  const text = items.map((w) => `${w.title} ${w.text}`).join("\n")
  const byTitle = scoreAll(text, buildIndex(pages.map((p) => [p.title, ...p.aliases].join(" "))))
  const byBody = scoreAll(text, buildIndex(pages.map((p) => `${p.title} ${p.aliases.join(" ")} ${clip(p.content, 4000)}`)))
  const picked: number[] = []
  const half = Math.ceil(PAGES_PER_CALL / 2)
  for (const r of byTitle.slice(0, half)) picked.push(r.docIndex)
  for (const r of byBody) {
    if (picked.length >= PAGES_PER_CALL) break
    if (!picked.includes(r.docIndex)) picked.push(r.docIndex)
  }
  for (const r of byTitle.slice(half)) {
    if (picked.length >= PAGES_PER_CALL) break
    if (!picked.includes(r.docIndex)) picked.push(r.docIndex)
  }
  return picked.map((i) => pages[i])
}

export function buildContributionPrompt(agentId: string, items: WorkItem[], pages: PageRef[], maxPatches: number): string {
  const work = items.map((w) => `### ${w.at.slice(0, 16)} · ${w.kind} · ${w.title}\n${clip(w.text, ITEM_CHARS)}`).join("\n\n")
  const wiki = pages.length
    ? pages.map((p) => `### ${p.title}${p.type ? ` [${p.type}]` : ""}${p.lastUpdated ? ` (updated ${p.lastUpdated})` : ""}\n${clip(p.content, PAGE_CHARS)}`).join("\n\n")
    : "(no matching pages)"
  return `You are agent "${agentId}". Below is your own work since your last wiki contribution (chat turns, and tasks with the tool calls you ran and what they returned) and the wiki pages it seems to touch. Propose small, sourced patches to the shared wiki from what you actually used or checked.

## Your work

${work}

## Current wiki pages

${wiki}

## Patch kinds

- "add": a fact you used or checked that the page lacks.
- "correct": the page states something your work shows is wrong or out of date. Put the exact wrong text from the page in "previous", and the right value in "value".
- "create": an entity (person, organization, project, invoice, place…) you dealt with that has no page. Give a one-sentence "summary"; add its facts as separate "add" patches on the same page title.

## Rules

- Only facts your work shows you checked (a tool result, a system you read) or were told by someone who knows. No guesses, no inferences, nothing from general knowledge.
- Every patch names its "source": the system, command, URL or person (e.g. "invoice list in the billing app", "owner said in chat"). A patch without a source is dropped.
- "checkedAt" is the date and time of the work that shows the check (ISO). A patch without it is dropped.
- One fact per patch: an "attribute" ("phone", "role", "billing status", "due date") and its "value", copied exactly.
- Never rewrite or summarise a page, and never propose removing a fact.
- Skip facts a page already states with the same value.
- Put each fact on the page about its subject. If a page above is about the same thing under another name, use that page (with "correct" when it is out of date) instead of creating a new one. Create a page only when none of the pages above is about the subject.
- State the fact itself, not the story of how you found it.
- Do not record facts about the wiki, AgentX, this contribution run or your own tools, unless that is your job.
- Skip anything you could not verify. "Not checked" or "unknown" is not a fact.
- At most ${maxPatches} patches. Return [] when there is nothing worth adding.

Return ONLY a JSON array, no prose, no code fences:

[
  {"kind": "add", "page": "Exact Page Title", "attribute": "phone", "value": "+1 555 0100", "source": "contacts app", "checkedAt": "2026-01-31T10:00:00Z"},
  {"kind": "correct", "page": "Exact Page Title", "attribute": "billing status", "previous": "overdue", "value": "paid", "source": "invoice list", "checkedAt": "2026-01-31T10:00:00Z"},
  {"kind": "create", "page": "New Entity Name", "pageType": "person", "summary": "One sentence.", "source": "chat with the owner", "checkedAt": "2026-01-31T10:00:00Z"}
]`
}

/** Valid patches from a model reply; anything malformed is dropped. */
export function parseContributionPatches(raw: string, agentId: string, opts: { now?: number } = {}): ContributionPatch[] {
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) return []
  let parsed: unknown
  try { parsed = JSON.parse(match[0]) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const now = opts.now ?? Date.now()
  const out: ContributionPatch[] = []
  for (const x of parsed) {
    if (!x || typeof x !== "object") continue
    const r = x as Record<string, unknown>
    const kind = r.kind
    if (kind !== "add" && kind !== "correct" && kind !== "create" && kind !== "remove") continue
    const page = clean(r.page, 120)
    // The fact line adds "checked <date> by <agent>" itself.
    const rawSource = clean(r.source, FIELD_CHARS)
    const source = rawSource.replace(/[\s,;(–—-]*\bchecked\b[^;]*$/i, "").replace(/[\s,;(]+$/, "") || rawSource
    const checked = typeof r.checkedAt === "string" ? Date.parse(r.checkedAt) : NaN
    if (!page || !source || !Number.isFinite(checked)) continue
    const attribute = clean(r.attribute, 60)
    const value = clean(r.value, FIELD_CHARS)
    const previous = clean(r.previous, FIELD_CHARS)
    const summary = clean(r.summary, FIELD_CHARS)
    if ((kind === "add" || kind === "correct") && (!attribute || !value)) continue
    if (kind === "remove" && !attribute && !previous) continue
    if (kind === "create" && !summary) continue
    const aliases = Array.isArray(r.aliases) ? r.aliases.map((a) => clean(a, 120)).filter(Boolean).slice(0, 10) : []
    // A check can't be dated after the run.
    const checkedAt = new Date(Math.min(checked, now)).toISOString()
    const body = { kind, page, attribute, value, previous, summary, source, checkedAt, agentId }
    out.push({
      id: createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 12),
      kind, page, source, checkedAt, agentId,
      ...(attribute ? { attribute } : {}),
      ...(value ? { value } : {}),
      ...(previous && kind !== "add" && kind !== "create" ? { previous } : {}),
      ...(summary && kind === "create" ? { summary } : {}),
      ...(kind === "create" && isWikiArticleType(r.pageType) ? { pageType: r.pageType } : {}),
      ...(kind === "create" && aliases.length ? { aliases } : {}),
    })
  }
  return out
}

/** One line, trimmed, capped; "" for anything not a string. */
function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : ""
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// --- The daily merge -----------------------------------------------------------

export interface MergeReport {
  at: string
  batches: string[]
  agents: string[]
  patches: number
  /** Facts the ledger took as new, newer or re-checked. */
  applied: Array<{ page: string; attribute: string; value: string; by: string; status: string }>
  /** Pages that got a new or changed fact. */
  pagesUpdated: string[]
  pagesCreated: string[]
  /** Patches with an older check than the wiki's: a question was raised. */
  contradictions: Array<{ page: string; attribute: string; value: string; by: string; questionId?: string }>
  held: Array<{ id: string; page: string; attribute?: string; by: string; reason: string; lost?: string[] }>
  /** Several pages for one subject: listed for a person to merge. */
  duplicates: Array<{ title: string; pages: string[] }>
  dryRun?: boolean
}

interface PageTarget {
  agentId: string
  store: WikiStore
  path: string
  article: WikiArticle
}

/** Title or alias, without case or punctuation. */
export function pageKey(title: string): string {
  return (title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

/** Every page by title and alias, across agents. Copied agents are read-only here. */
function pageTargets(hub: WikiHub): Map<string, PageTarget[]> {
  const targets = new Map<string, PageTarget[]>()
  for (const id of hub.listAgents()) {
    if (hub.syncedFrom(id)) continue
    const store = hub.getAgentWiki(id)
    for (const article of store.listAllArticles()) {
      if (article.path.includes("/_versions/")) continue
      const keys = new Set([article.meta.title, ...(article.meta.aliases ?? [])].map(pageKey).filter(Boolean))
      for (const k of keys) {
        const list = targets.get(k) ?? []
        list.push({ agentId: id, store, path: article.path, article })
        targets.set(k, list)
      }
    }
  }
  return targets
}

/**
 * Apply every pending batch. The newest checked fact wins (the fact
 * ledger keeps the older one in its history), new pages for one subject
 * become one page, and a change that would lose a fact is held.
 */
export function mergeContributions(hub: WikiHub, wikiDir: string, opts: { now?: number; dryRun?: boolean; log?: (m: string) => void } = {}): MergeReport {
  const now = opts.now ?? Date.now()
  const nowIso = new Date(now).toISOString()
  const today = nowIso.slice(0, 10)
  const batches = listPendingBatches(wikiDir)
  // Oldest check first, so the ledger takes each newer value over the
  // last and keeps the older one in its history.
  const patches = batches.flatMap((b) => b.patches).sort((a, b) => a.checkedAt.localeCompare(b.checkedAt))
  const report: MergeReport = {
    at: nowIso, batches: batches.map((b) => b.id), agents: [...new Set(batches.map((b) => b.agentId))].sort(),
    patches: patches.length, applied: [], pagesUpdated: [], pagesCreated: [], contradictions: [], held: [], duplicates: [],
    ...(opts.dryRun ? { dryRun: true } : {}),
  }
  const held: HeldPatch[] = []
  const hold = (patch: ContributionPatch, reason: string, lost?: string[]) => {
    const id = `h-${patch.id}`
    held.push({ id, patch, reason, heldAt: nowIso, status: "held", ...(lost?.length ? { lost } : {}) })
    report.held.push({ id, page: patch.page, attribute: patch.attribute, by: patch.agentId, reason, ...(lost?.length ? { lost } : {}) })
  }

  const targets = pageTargets(hub)
  for (const [, list] of targets) {
    const distinct = [...new Map(list.map((t) => [`${t.agentId}:${t.path}`, t])).values()]
    const title = distinct[0]?.article.meta.title
    if (distinct.length > 1 && title && !report.duplicates.some((d) => d.title === title)) {
      report.duplicates.push({ title, pages: distinct.map((t) => `${t.agentId}/${t.path}`) })
    }
  }

  // New pages: one per subject, however many agents proposed it. A page
  // that already exists (by title or alias) takes the facts instead.
  const newPages = new Map<string, NewPage>()
  for (const p of patches) {
    if (p.kind !== "create") continue
    const key = pageKey(p.page)
    if (targets.has(key)) continue
    const draft = newPages.get(key) ?? { title: p.page, owner: p.agentId, summaries: [], sources: [], aliases: [], at: p.checkedAt }
    draft.type ??= p.pageType
    if (p.summary && !draft.summaries.includes(p.summary)) draft.summaries.push(p.summary)
    if (!draft.sources.includes(p.source)) draft.sources.push(p.source)
    for (const a of p.aliases ?? []) if (!draft.aliases.includes(a)) draft.aliases.push(a)
    newPages.set(key, draft)
  }
  for (const p of patches) {
    const key = pageKey(p.page)
    if ((p.kind === "add" || p.kind === "correct") && !targets.has(key) && !newPages.has(key)) {
      // A fact about a subject with no page and no `create`: start one.
      newPages.set(key, { title: p.page, owner: p.agentId, summaries: [], sources: [p.source], aliases: [], at: p.checkedAt })
    }
  }

  // A new page whose title is a near match of an existing one is probably
  // that page under a longer or shorter name; creating it is how the
  // first trial duplicated a stale page instead of correcting it.
  const existing = [...targets.values()].map((list) => list[0])
  const duplicateOf = new Map<string, string>()
  for (const [key, draft] of newPages) {
    const match = possibleDuplicate(draft.title, draft.type, existing.map((t) => ({ title: t.article.meta.title, type: t.article.meta.type, ref: `${t.agentId}/${t.path}` })))
    if (match) duplicateOf.set(key, match)
  }
  for (const key of duplicateOf.keys()) newPages.delete(key)

  const ledger = new FactLedger(wikiDir)
  // Keyed by the page itself, not by the name a patch used: a title patch
  // and an alias patch to one page each started from the same stored
  // body, and the second write dropped the first one's lines.
  const edits = new Map<string, PageEdit[]>()
  const editTargets = new Map<string, PageTarget>()
  const editKey = (key: string) => {
    const t = targets.get(key)?.[0]
    if (!t) return `new:${key}`
    const k = `page:${t.agentId}:${t.path}`
    editTargets.set(k, t)
    return k
  }
  for (const p of patches) {
    const key = pageKey(p.page)
    const dup = duplicateOf.get(key)
    if (dup && p.kind !== "remove") { hold(p, `possible duplicate of ${dup}`); continue }
    if (p.kind === "create") continue
    if (p.kind === "remove") { hold(p, "removes a fact"); continue }
    const target = targets.get(key)?.[0]
    if (target && !target.store.canRead(target.article.meta, p.agentId)) {
      hold(p, "the contributing agent cannot read this page")
      continue
    }
    const subject = target?.article.meta.title ?? newPages.get(key)!.title
    let status = "planned"
    let value = p.value!
    if (!opts.dryRun) {
      const r = ledger.write({ subject, attribute: p.attribute!, value, source: p.source, verifiedBy: p.agentId, verifiedAt: p.checkedAt }, { now })
      status = r.status
      if (r.status === "contradiction") {
        report.contradictions.push({ page: subject, attribute: p.attribute!, value, by: p.agentId, questionId: r.questionId })
        continue
      }
      if (r.status === "unchanged") continue
      value = r.fact.value
    }
    report.applied.push({ page: subject, attribute: p.attribute!, value, by: p.agentId, status })
    const list = edits.get(editKey(key)) ?? []
    const previous = p.kind === "correct" ? p.previous : undefined
    list.push({ line: { attribute: p.attribute!, value, source: p.source, checkedAt: p.checkedAt, by: p.agentId, previous }, previous, patch: p })
    edits.set(editKey(key), list)
  }

  const touched = new Set<WikiStore>()
  for (const [key, list] of edits) {
    const target = editTargets.get(key)
    if (!target) continue
    const r = updatePage(target, list, { guard: true, today, dryRun: opts.dryRun })
    if (r.lost) for (const e of list) hold(e.patch, "the change would lose facts the page has", r.lost)
    else if (r.denied) for (const e of list) hold(e.patch, `write denied for ${target.agentId}/${target.path}`)
    else if (r.changed) {
      report.pagesUpdated.push(`${target.agentId}/${target.path}`)
      if (!opts.dryRun) touched.add(target.store)
    }
  }

  for (const [key, draft] of newPages) {
    const list = edits.get(`new:${key}`) ?? []
    if (!draft.summaries.length && !list.length) continue
    const store = hub.getAgentWiki(draft.owner)
    const path = newPagePath(store, draft.title, draft.type)
    report.pagesCreated.push(`${draft.owner}/${path}`)
    if (opts.dryRun) continue
    if (createPage(store, path, draft, list.map((e) => e.line), today)) touched.add(store)
  }

  if (!opts.dryRun) {
    for (const store of touched) {
      try { store.rebuildIndex() } catch (err) { opts.log?.(`index rebuild failed: ${(err as Error).message}`) }
    }
    const dir = contributionsDir(wikiDir)
    if (held.length) {
      const known = listHeld(wikiDir, { all: true })
      writeJson(heldFile(wikiDir), [...known, ...held.filter((h) => !known.some((k) => k.id === h.id))])
    }
    mkdirSync(resolve(dir, "merged"), { recursive: true })
    for (const b of batches) renameSync(resolve(dir, "pending", `${b.id}.json`), resolve(dir, "merged", `${b.id}.json`))
    writeJson(resolve(dir, "reports", `${nowIso.replace(/[:.]/g, "-")}.json`), report)
  }
  return report
}

function createPage(store: WikiStore, path: string, draft: NewPage, lines: FactLine[], today: string): boolean {
  const intro = draft.summaries.length ? draft.summaries.join(" ") : `${draft.title}.`
  const { body } = applyFactLines(`${intro}\n\n_Sources: ${draft.sources.join("; ")}._`, lines)
  return store.writeArticle(path, {
    title: draft.title,
    ...(draft.type ? { type: draft.type } : {}),
    ...(draft.aliases.length ? { aliases: draft.aliases } : {}),
    tags: [],
    owner: draft.owner,
    access: "public",
    created: today,
    lastUpdated: today,
    sources: [contributionStamp(draft.owner, draft.at), ...lines.map((l) => contributionStamp(l.by, l.checkedAt))]
      .filter((s, i, a) => a.indexOf(s) === i),
  }, body, draft.owner)
}

const TITLE_STOPWORDS = new Set(["the", "and", "for", "with", "von", "des", "les", "der", "die", "das", "une", "pour", "page", "of", "de", "la", "le", "du", "et"])

function titleTokens(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => (t.length > 2 || /\d/.test(t)) && !TITLE_STOPWORDS.has(t)))
}

/**
 * The existing page a new title most likely means, or undefined. A match
 * shares at least two significant words and most of the shorter title's
 * words ("Tax Payment Plan" and "Tax Payment Plan Engagement 4471"). A
 * person page never matches a page of another type, and titles carrying
 * different numbers never match.
 */
export function possibleDuplicate(
  title: string, type: WikiArticleType | undefined,
  pages: Array<{ title: string; type?: WikiArticleType; ref: string }>,
): string | undefined {
  const mine = titleTokens(title)
  if (mine.size < 2) return undefined
  let best: { ref: string; title: string; score: number } | undefined
  for (const p of pages) {
    if (type && p.type && (type === "person") !== (p.type === "person")) continue
    const theirs = titleTokens(p.title)
    if (theirs.size < 2) continue
    // Two numbered things (invoices, issues) with different numbers are
    // different things, however alike the rest of the title.
    const nums = (set: Set<string>) => [...set].filter((t) => /\d/.test(t))
    const [a, b] = [nums(mine), nums(theirs)]
    if (a.length && b.length && !a.some((n) => b.includes(n))) continue
    let shared = 0
    for (const t of mine) if (theirs.has(t)) shared++
    const score = shared / Math.min(mine.size, theirs.size)
    if (shared >= 2 && score >= 0.75 && (!best || score > best.score)) best = { ref: p.ref, title: p.title, score }
  }
  return best ? `"${best.title}" (${best.ref})` : undefined
}

interface NewPage {
  title: string
  type?: WikiArticleType
  owner: string
  summaries: string[]
  sources: string[]
  aliases: string[]
  /** Earliest check behind it. */
  at: string
}

interface PageEdit {
  line: FactLine
  /** For a correction the ledger accepted: the exact wrong text to replace in place. */
  previous?: string
  patch: ContributionPatch
}

/**
 * Write a page's fact lines and in-place corrections. With `guard`, an
 * edit that would lose a structured fact is not written and the lost
 * facts are returned.
 */
function updatePage(
  target: PageTarget, list: PageEdit[],
  opts: { guard: boolean; today: string; dryRun?: boolean; remove?: { attribute?: string; text?: string } },
): { changed: boolean; lost?: string[]; denied?: boolean } {
  const before = target.article.content
  let { body, superseded } = applyFactLines(before, list.map((e) => e.line))
  for (const e of list) {
    if (!e.previous || e.previous === e.line.value) continue
    const fixed = replaceOnce(body, e.previous, e.line.value)
    if (fixed !== body) { body = fixed; superseded.push(e.previous) }
  }
  if (opts.remove) body = removeFact(body, opts.remove)
  if (body === before) return { changed: false }
  if (opts.guard) {
    const lost = lostStructuredFacts(before, body, superseded)
    if (lost.length) return { changed: false, lost }
  }
  if (opts.dryRun) return { changed: true }
  const meta = target.article.meta
  const stamps = list.map((e) => contributionStamp(e.line.by, e.line.checkedAt))
  const ok = target.store.writeArticle(target.path, {
    ...meta,
    lastUpdated: opts.today,
    sources: [...meta.sources, ...stamps].filter((s, i, a) => a.indexOf(s) === i),
  }, body, meta.owner)
  return ok ? { changed: true } : { changed: false, denied: true }
}

/** Replace `old` with `next` when it occurs exactly once, as whole words,
 *  outside the "Checked facts" section; anything else is ambiguous and
 *  left alone. Whole words, so "paid" is not rewritten inside "unpaid". */
export function replaceOnce(body: string, old: string, next: string): string {
  if (!old) return body
  const at = body.indexOf(FACTS_HEADING)
  const prose = at === -1 ? body : body.slice(0, at)
  const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const hits = [...prose.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"))]
  if (hits.length !== 1) return body
  const first = hits[0].index!
  return body.slice(0, first) + next + body.slice(first + old.length)
}

function removeFact(body: string, remove: { attribute?: string; text?: string }): string {
  let out = body
  if (remove.attribute) {
    const attr = remove.attribute.toLowerCase()
    out = out.split("\n").filter((l) => l.match(LINE_RE)?.[1].toLowerCase() !== attr).join("\n")
  }
  if (remove.text) out = replaceOnce(out, remove.text, "")
  return out
}

// --- Held patches: a person decides ----------------------------------------

export type HeldDecision = { ok: true; held: HeldPatch; page?: string } | { ok: false; error: string }

/**
 * Apply a held patch as it is, without the fact-loss guard: a person
 * looked at it. A removal deletes the attribute's fact line and the
 * exact text it names; the page's previous body stays in `_versions/`.
 */
export function approveHeld(hub: WikiHub, wikiDir: string, id: string, opts: { by?: string; now?: number } = {}): HeldDecision {
  const all = listHeld(wikiDir, { all: true })
  const h = all.find((x) => x.id === id)
  if (!h) return { ok: false, error: `no held patch "${id}"` }
  if (h.status !== "held") return { ok: false, error: `"${id}" is already ${h.status}` }
  const p = h.patch
  const now = opts.now ?? Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const target = pageTargets(hub).get(pageKey(p.page))?.[0]
  if (!target) {
    // A held `create` (a possible duplicate), or a fact for the page it
    // would have made: a person said it is a new subject after all.
    if (p.kind === "remove") return { ok: false, error: `no page "${p.page}" (it may have been renamed)` }
    const lines: FactLine[] = []
    if (p.attribute && p.value) {
      const w = new FactLedger(wikiDir).write({ subject: p.page, attribute: p.attribute, value: p.value, source: p.source, verifiedBy: p.agentId, verifiedAt: p.checkedAt }, { now })
      if (w.status === "contradiction") return { ok: false, error: `the wiki has a newer check of ${p.attribute}; answer question ${w.questionId ?? "(see wiki questions)"} instead` }
      lines.push({ attribute: p.attribute, value: w.fact.value, source: p.source, checkedAt: p.checkedAt, by: p.agentId })
    }
    const store = hub.getAgentWiki(p.agentId)
    const path = newPagePath(store, p.page, p.pageType)
    const draft: NewPage = { title: p.page, type: p.pageType, owner: p.agentId, summaries: p.summary ? [p.summary] : [], sources: [p.source], aliases: p.aliases ?? [], at: p.checkedAt }
    if (!createPage(store, path, draft, lines, today)) return { ok: false, error: `write denied for ${p.agentId}/${path}` }
    try { store.rebuildIndex() } catch { /* the page is written; the next rebuild indexes it */ }
    return decide(wikiDir, all, h, "approved", opts.by, now, `${p.agentId}/${path}`)
  }

  let r: { changed: boolean; denied?: boolean }
  if (p.kind === "remove") {
    r = updatePage(target, [], { guard: false, today, remove: { attribute: p.attribute, text: p.previous } })
  } else {
    if (!p.attribute || !p.value) return { ok: false, error: `"${id}" carries no fact to apply` }
    const w = new FactLedger(wikiDir).write({ subject: target.article.meta.title, attribute: p.attribute, value: p.value, source: p.source, verifiedBy: p.agentId, verifiedAt: p.checkedAt }, { now })
    if (w.status === "contradiction") return { ok: false, error: `the wiki has a newer check of ${p.attribute}; answer question ${w.questionId ?? "(see wiki questions)"} instead` }
    const previous = p.kind === "correct" ? p.previous : undefined
    r = updatePage(target, [{ line: { attribute: p.attribute, value: w.fact.value, source: p.source, checkedAt: p.checkedAt, by: p.agentId, previous }, previous, patch: p }], { guard: false, today })
  }
  if (r.denied) return { ok: false, error: `write denied for ${target.agentId}/${target.path}` }
  if (r.changed) {
    try { target.store.rebuildIndex() } catch { /* the page is written; the next rebuild indexes it */ }
  }
  return decide(wikiDir, all, h, "approved", opts.by, now, `${target.agentId}/${target.path}`)
}

export function rejectHeld(wikiDir: string, id: string, opts: { by?: string; now?: number } = {}): HeldDecision {
  const all = listHeld(wikiDir, { all: true })
  const h = all.find((x) => x.id === id)
  if (!h) return { ok: false, error: `no held patch "${id}"` }
  if (h.status !== "held") return { ok: false, error: `"${id}" is already ${h.status}` }
  return decide(wikiDir, all, h, "rejected", opts.by, opts.now ?? Date.now())
}

function decide(wikiDir: string, all: HeldPatch[], h: HeldPatch, status: "approved" | "rejected", by: string | undefined, now: number, page?: string): HeldDecision {
  const decided: HeldPatch = { ...h, status, decidedBy: by ?? "operator", decidedAt: new Date(now).toISOString() }
  writeJson(heldFile(wikiDir), all.map((x) => (x.id === h.id ? decided : x)))
  return { ok: true, held: decided, ...(page ? { page } : {}) }
}

// --- Page text -----------------------------------------------------------------

export interface FactLine {
  attribute: string
  value: string
  source: string
  checkedAt: string
  by: string
  previous?: string
}

const LINE_RE = /^- \*\*(.+?):\*\* /

/**
 * Add or update one line per attribute in the page's "Checked facts"
 * section. Nothing outside that section changes. A changed value keeps
 * the old one on its line as "previously", so a correction never drops a
 * fact from the page.
 *
 * `superseded` holds the replaced lines: their older parts live on in the
 * ledger's history and the page's versions, so the guard lets them go.
 */
export function applyFactLines(body: string, lines: FactLine[]): { body: string; superseded: string[] } {
  if (lines.length === 0) return { body, superseded: [] }
  const all = body.replace(/\s+$/, "").split("\n")
  const start = all.findIndex((l) => l.trim() === FACTS_HEADING)
  let head = all
  let section: string[] = []
  let tail: string[] = []
  if (start !== -1) {
    head = all.slice(0, start)
    const rest = all.slice(start + 1)
    const end = rest.findIndex((l) => /^#{1,2} /.test(l))
    section = (end === -1 ? rest : rest.slice(0, end)).filter((l) => l.trim())
    tail = end === -1 ? [] : rest.slice(end)
  }

  const superseded: string[] = []
  for (const l of lines) {
    const at = section.findIndex((s) => s.match(LINE_RE)?.[1].toLowerCase() === l.attribute.toLowerCase())
    const old = at === -1 ? undefined : parseFactLine(section[at])
    if (at !== -1) superseded.push(section[at])
    // A re-check of the same value refreshes the line and keeps its history.
    const previous = old && old.value === l.value ? old.previous : old ? `${old.value}, checked ${old.checkedAt}` : l.previous
    // An existing line keeps its spelling of the attribute.
    const attribute = section[at]?.match(LINE_RE)?.[1] ?? l.attribute
    const line = renderFactLine({ ...l, attribute, previous })
    if (at === -1) section.push(line)
    else section[at] = line
  }

  const out = [...(head.some((l) => l.trim()) ? [...head, ""] : []), FACTS_HEADING, "", ...section]
  if (tail.length) out.push("", ...tail)
  return { body: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), superseded }
}

function renderFactLine(l: FactLine): string {
  const prev = l.previous ? ` (previously: ${l.previous})` : ""
  return `- **${l.attribute}:** ${l.value} — ${l.source}; checked ${l.checkedAt.slice(0, 10)} by ${l.by}${prev}`
}

function parseFactLine(line: string): { value: string; checkedAt: string; previous?: string } | undefined {
  const m = line.match(/^- \*\*.+?:\*\* (.*?) — .*?; checked (\S+) by \S+(?: \(previously: (.*)\))?$/)
  return m ? { value: m[1], checkedAt: m[2], ...(m[3] ? { previous: m[3] } : {}) } : undefined
}

function contributionStamp(agentId: string, at: string): string {
  return `contribution:${agentId}@${at.slice(0, 10)}`
}

const TYPE_FOLDER: Record<WikiArticleType, string> = {
  person: "people", project: "projects", place: "places", concept: "concepts",
  event: "events", decision: "decisions", pattern: "patterns",
}

function newPagePath(store: WikiStore, title: string, type?: WikiArticleType): string {
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page"
  const folder = type ? TYPE_FOLDER[type] : "contributions"
  let path = `${folder}/${slug}.md`
  for (let n = 2; store.readArticle(path); n++) path = `${folder}/${slug}-${n}.md`
  return path
}
