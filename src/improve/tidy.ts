// --- Memory tidy run log: every fact cleanup can be listed and undone (#2117) ---
//
// A cleanup of an agent's facts (today `MemoryStore.prune`, later the
// nightly tidy) writes one run log before it rewrites the facts file:
// `.agentx/memory/_tidy/<runId>.json`. The log keeps the full text of each
// fact it dropped or merged, so undo does not depend on any backup. The
// facts file is also copied to `.agentx/memory/_backup/` first.
//
// Undo puts a dropped fact back under its own id, once: a fact whose id is
// already in the file is not added again. A merge's kept fact that changed
// after the run (its etag differs) is left alone unless `force`.
//
// Bounded, per agent (C1, #2117 review): a log goes when it is older than
// RUN_KEEP_DAYS, so a tidy log always outlives its 7-day approvals item.
// Prune logs are also capped at MAX_RUNS per agent, oldest first, but never
// one younger than RUN_FLOOR_HOURS: a night's logs are still there for the
// next morning's review. Per agent and cleanup kind, at most MAX_BACKUPS
// backups.
//
// Note changes (store "note") are put back through AgentMemory.save, so the
// note's own history keeps the merged version too.

import { createHash } from "crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { basename, dirname, resolve } from "path"
import type { MemoryFact, MemoryStore } from "@/agents/memory-store"
import { MAX_MEMORIES } from "@/agents/memory-limits"
import type { AgentMemory, MemoryRecord } from "@/agents/agent-memory"

/** Prune logs kept per agent, past RUN_FLOOR_HOURS. */
export const MAX_RUNS = 500
export const MAX_BACKUPS = 10
/** A run log older than this goes: longer than an approvals item lives (7 days). */
export const RUN_KEEP_DAYS = 14
/** No log younger than this goes for the count cap: one night's logs wait
 *  for the next morning's review. */
export const RUN_FLOOR_HOURS = 36
const HOUR_MS = 3_600_000

interface ChangeBase {
  /** 1-based, the number `undo --change <n>` takes. */
  n: number
  action: "merge" | "drop"
  /** Why, in a word or two: "expired", "over-cap", "duplicate", "stale". */
  reason?: string
  afterEtag: string | null
  undoneAt?: string
}

export interface FactChange extends ChangeBase {
  store: "fact"
  /** The full records before the change. */
  before: MemoryFact[]
  /** The record kept by a merge; null for a drop. */
  after: MemoryFact | null
}

export interface NoteChange extends ChangeBase {
  store: "note"
  /** The notes as they were, etag left out. */
  before: MemoryRecord[]
  /** The note a merge kept, as saved; its etag is afterEtag. */
  after: MemoryRecord | null
}

export type TidyChange = FactChange | NoteChange

export interface TidyRun {
  runId: string
  agent: string
  at: string
  /** What made the change. */
  by: "prune" | "tidy"
  /** The copy of the facts file taken before the rewrite. */
  backup?: string
  changes: TidyChange[]
  /** The owner's answer on the run's approvals item (#2117 PR 3). */
  review?: TidyReview
}

export interface TidyReview {
  /** yes = keep the changes, no = the run was undone. */
  answer: "yes" | "no"
  by: string
  at: string
}

export interface UndoResult {
  runId: string
  restored: number[]
  skipped: Array<{ n: number; why: string }>
}

const RUN_ID = /^[A-Za-z0-9_-]+$/

/** A short hash of a fact as stored: changes when any field changes. */
export function factEtag(fact: MemoryFact): string {
  return createHash("sha256").update(JSON.stringify(fact)).digest("hex").slice(0, 16)
}

function tidyDir(store: MemoryStore): string {
  return resolve(store.memoryRoot(), "_tidy")
}

function stampOf(at: string): string {
  return at.replace(/[-:.]/g, "")
}

/** Copy the agent's facts file to `_backup/` before a rewrite. `tag`
 *  names the cleanup; with `keep`, older backups of that tag go. */
export function backupFacts(
  store: MemoryStore, agentId: string, opts: { at: string; tag?: string; keep?: number },
): string {
  const file = store.fileFor(agentId)
  const dir = resolve(dirname(file), "_backup")
  mkdirSync(dir, { recursive: true })
  const prefix = `${basename(file, ".jsonl")}.${opts.tag ? `${opts.tag}.` : ""}`
  let backup = resolve(dir, `${prefix}${opts.at.replace(/[:.]/g, "-")}.jsonl`)
  for (let n = 1; existsSync(backup); n++) backup = backup.replace(/(\.\d+)?\.jsonl$/, `.${n}.jsonl`)
  copyFileSync(file, backup)
  if (opts.tag && opts.keep !== undefined) {
    const old = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort()
    for (const f of old.slice(0, Math.max(0, old.length - opts.keep))) rmSync(resolve(dir, f), { force: true })
  }
  return backup
}

type NewChange =
  | Omit<FactChange, "n" | "afterEtag">
  | (Omit<NoteChange, "n" | "afterEtag"> & { afterEtag: string | null })

const safeAgent = (agent: string) => agent.replace(/[^A-Za-z0-9_-]/g, "_")

/** Write a run log. Call it before the facts file is rewritten. A note
 *  change brings its own afterEtag (the note's etag as saved). */
export function recordRun(
  store: MemoryStore, agent: string, by: TidyRun["by"],
  changes: NewChange[],
  opts: { at?: string; backup?: string; now?: number } = {},
): TidyRun {
  const at = opts.at ?? new Date().toISOString()
  const runId = `${stampOf(at)}-${safeAgent(agent)}-${Math.random().toString(36).slice(2, 6)}`
  const run: TidyRun = {
    runId, agent, at, by,
    ...(opts.backup ? { backup: opts.backup } : {}),
    changes: changes.map((c, i) => c.store === "note"
      ? { ...c, n: i + 1 }
      : { ...c, n: i + 1, afterEtag: c.after ? factEtag(c.after) : null }),
  }
  const dir = tidyDir(store)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${runId}.json`), JSON.stringify(run, null, 2) + "\n")
  trimRuns(store, agent, opts.now ?? Date.now())
  return run
}

/** `<stamp>-<agent>-<4 chars>` → its time and agent. */
function parseRunFile(f: string): { at: number; agent: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-(.+)-[a-z0-9]+\.json$/.exec(f)
  if (!m) return null
  return { at: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]), agent: m[8] }
}

/** Drop one agent's run logs past their keep (C1 and the floor, above). */
export function trimRuns(store: MemoryStore, agent: string, now = Date.now()): string[] {
  const dir = tidyDir(store)
  let files: string[] = []
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")) } catch { return [] }
  const own = files
    .map((f) => ({ f, p: parseRunFile(f) }))
    .filter((x): x is { f: string; p: { at: number; agent: string } } => x.p !== null && x.p.agent === safeAgent(agent))
    .sort((a, b) => b.p.at - a.p.at) // newest first
  const gone: string[] = []
  let prunes = 0
  for (const { f, p } of own) {
    const age = now - p.at
    if (age > RUN_KEEP_DAYS * 24 * HOUR_MS) { gone.push(f); continue }
    // The count cap is for prune logs only: a tidy log stays its full keep,
    // since its approvals item points at it.
    if (own.length <= MAX_RUNS) continue // under the cap: no need to read the log
    if (runBy(dir, f) !== "prune") continue
    prunes++
    if (prunes > MAX_RUNS && age > RUN_FLOOR_HOURS * HOUR_MS) gone.push(f)
  }
  for (const f of gone) rmSync(resolve(dir, f), { force: true })
  return gone
}

function runBy(dir: string, f: string): TidyRun["by"] | null {
  try { return (JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as TidyRun).by } catch { return null }
}

/** One run log, or null when there is none by that id. */
export function showRun(store: MemoryStore, runId: string): TidyRun | null {
  if (!RUN_ID.test(runId)) return null
  try {
    return JSON.parse(readFileSync(resolve(tidyDir(store), `${runId}.json`), "utf-8")) as TidyRun
  } catch { return null }
}

/** Run logs, newest first; only one agent's with `agent`. */
export function listRuns(store: MemoryStore, agent?: string): TidyRun[] {
  let files: string[] = []
  try { files = readdirSync(tidyDir(store)).filter((f) => f.endsWith(".json")).sort().reverse() } catch { return [] }
  return files
    .map((f) => showRun(store, f.slice(0, -".json".length)))
    .filter((r): r is TidyRun => r !== null && (!agent || r.agent === agent))
}

/** Put restored facts back where their createdAt puts them, not at the
 *  end: prune's cap keeps the last facts in the file as the newest. */
function placeByAge(facts: MemoryFact[], back: MemoryFact[]): MemoryFact[] {
  const out = facts.slice()
  const age = (f: MemoryFact) => Date.parse(f.createdAt)
  for (const b of back.slice().sort((x, y) => age(x) - age(y))) {
    const i = out.findIndex((f) => age(f) > age(b))
    out.splice(i === -1 ? out.length : i, 0, b)
  }
  return out
}

/** Why an over-cap drop is not put back (C2, #2117 review): the file is
 *  still at its cap, so the next prune would drop the same fact again. */
export const OVER_CAP_SKIP = `the facts file is at its ${MAX_MEMORIES}-fact cap: the next prune would drop it again (--force puts it back anyway)`

/** The note shown next to an over-cap drop in `show` and in the review item. */
export function changeNote(c: TidyChange): string | undefined {
  if (c.store === "fact" && c.reason === "over-cap" && !c.undoneAt) {
    return `undo skips it while the agent has ${MAX_MEMORIES} facts or more`
  }
  return undefined
}

/** Undo a run, or one change of it. Each change is undone at most once.
 *  Facts are read and rewritten under the agent's facts lock. A note
 *  change needs `notes`, the agents' AgentMemory. */
export function undoRun(
  store: MemoryStore, runId: string,
  opts: { change?: number; force?: boolean; now?: number; notes?: AgentMemory; review?: TidyReview } = {},
): UndoResult {
  const first = showRun(store, runId)
  if (!first) throw new Error(`no tidy run ${runId}`)
  // The log is read, undone and written back under the agent's facts lock
  // (C4, #2117 review), so two undos of one run never both put it back.
  return store.withFactsLock(first.agent, () => undoRunLocked(store, runId, opts))
}

function undoRunLocked(
  store: MemoryStore, runId: string,
  opts: { change?: number; force?: boolean; now?: number; notes?: AgentMemory; review?: TidyReview },
): UndoResult {
  const run = showRun(store, runId)
  if (!run) throw new Error(`no tidy run ${runId}`)
  if (opts.change !== undefined && !run.changes.some((c) => c.n === opts.change)) {
    throw new Error(`tidy run ${runId} has no change ${opts.change}`)
  }
  const result: UndoResult = { runId, restored: [], skipped: [] }
  const undoneAt = new Date(opts.now ?? Date.now()).toISOString()
  const picked = run.changes.filter((c) => opts.change === undefined || c.n === opts.change)

  const facts = picked.filter((c): c is FactChange => c.store === "fact")
  if (facts.length > 0) undoFacts(store, run.agent, facts, result, undoneAt, !!opts.force)
  for (const c of picked) {
    if (c.store !== "note") continue
    if (!opts.notes) { result.skipped.push({ n: c.n, why: "a note change needs the agents' memory" }); continue }
    undoNote(opts.notes, run.agent, c, result, undoneAt, !!opts.force)
  }
  result.restored.sort((a, b) => a - b)
  result.skipped.sort((a, b) => a.n - b.n)
  if (opts.review) run.review = opts.review
  if (result.restored.length > 0 || opts.review) writeRun(store, run)
  return result
}

function writeRun(store: MemoryStore, run: TidyRun): void {
  writeFileSync(resolve(tidyDir(store), `${run.runId}.json`), JSON.stringify(run, null, 2) + "\n")
}

/** Record the owner's yes on a run: its changes stay. Under the facts
 *  lock, like undo. False when there is no such run. */
export function markReviewed(store: MemoryStore, runId: string, review: TidyReview): boolean {
  const first = showRun(store, runId)
  if (!first) return false
  return store.withFactsLock(first.agent, () => {
    const run = showRun(store, runId)
    if (!run) return false
    run.review = review
    writeRun(store, run)
    return true
  })
}

/** Age out the logs of every agent, also one that no longer prunes or is
 *  tidied (C4, #2117 review): trimRuns otherwise runs only on a new run. */
export function trimAllRuns(store: MemoryStore, now = Date.now()): string[] {
  let files: string[] = []
  try { files = readdirSync(tidyDir(store)) } catch { return [] }
  const agents = new Set(files.map(parseRunFile).filter((p) => p !== null).map((p) => p!.agent))
  return [...agents].flatMap((a) => trimRuns(store, a, now))
}

/** What a change touched, in one line: the facts' text or the notes' names. */
export function changeWhat(c: TidyChange, max = 100): string {
  return c.store === "fact"
    ? c.before.map((f) => f.content.slice(0, max)).join(" | ")
    : c.before.map((n) => n.name).join(" + ")
}

function undoFacts(
  store: MemoryStore, agent: string, changes: FactChange[], result: UndoResult, undoneAt: string, force: boolean,
): void {
  let facts = store.getAll(agent)
  let changed = false
  for (const c of changes) {
    if (c.undoneAt) { result.skipped.push({ n: c.n, why: "already undone" }); continue }
    const byId = new Map(facts.map((f) => [f.id, f]))
    if (c.after) {
      const now = byId.get(c.after.id)
      if (!force && (!now || factEtag(now) !== c.afterEtag)) {
        result.skipped.push({ n: c.n, why: now ? "the kept fact changed after the tidy" : "the kept fact is gone" })
        continue
      }
    }
    // A merge keeps one of its own facts: put that one back as it was.
    const keepId = c.after?.id
    const back = c.before.filter((b) => b.id === keepId || !byId.has(b.id))
    if (back.length === 0) { result.skipped.push({ n: c.n, why: "the facts are already there" }); continue }
    if (!force && c.reason === "over-cap" && facts.length + back.length > MAX_MEMORIES) {
      result.skipped.push({ n: c.n, why: OVER_CAP_SKIP })
      continue
    }
    const replaced = new Set(back.map((b) => b.id))
    facts = placeByAge(facts.filter((f) => !replaced.has(f.id) && f.id !== keepId), back)
    c.undoneAt = undoneAt
    result.restored.push(c.n)
    changed = true
  }
  if (!changed) return
  if (existsSync(store.fileFor(agent))) {
    backupFacts(store, agent, { at: undoneAt, tag: "undo", keep: MAX_BACKUPS })
  }
  store.rewrite(agent, facts)
}

/** Put a merge's notes back: the kept note as it was, the removed one(s)
 *  again. Skipped when the kept note changed since, unless `force`; a
 *  removed note whose name is taken again is left alone. */
function undoNote(
  notes: AgentMemory, agent: string, c: NoteChange, result: UndoResult, undoneAt: string, force: boolean,
): void {
  if (c.undoneAt) { result.skipped.push({ n: c.n, why: "already undone" }); return }
  if (c.after) {
    const now = notes.get(agent, c.after.name)
    if (!force && (!now || now.etag !== c.afterEtag)) {
      result.skipped.push({ n: c.n, why: now ? "the kept note changed after the tidy" : "the kept note is gone" })
      return
    }
  }
  const back = c.before.filter((b) => b.name === c.after?.name || !notes.get(agent, b.name))
  if (back.length === 0) { result.skipped.push({ n: c.n, why: "the notes are already there" }); return }
  for (const b of back) {
    notes.save({ agentId: agent, type: b.type, name: b.name, description: b.description, body: b.body, author: "tidy-undo" })
  }
  c.undoneAt = undoneAt
  result.restored.push(c.n)
}
