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
// Bounded: at most MAX_RUNS logs (oldest go first) and, per agent and
// cleanup kind, at most MAX_BACKUPS backups.

import { createHash } from "crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { basename, dirname, resolve } from "path"
import type { MemoryFact, MemoryStore } from "@/agents/memory-store"

export const MAX_RUNS = 500
export const MAX_BACKUPS = 10

export interface TidyChange {
  /** 1-based, the number `undo --change <n>` takes. */
  n: number
  store: "fact"
  action: "merge" | "drop"
  /** Why, in a word or two: "expired", "over-cap", "duplicate". */
  reason?: string
  /** The full records before the change. */
  before: MemoryFact[]
  /** The record kept by a merge; null for a drop. */
  after: MemoryFact | null
  afterEtag: string | null
  undoneAt?: string
}

export interface TidyRun {
  runId: string
  agent: string
  at: string
  /** What made the change. */
  by: "prune" | "tidy"
  /** The copy of the facts file taken before the rewrite. */
  backup?: string
  changes: TidyChange[]
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

/** Write a run log. Call it before the facts file is rewritten. */
export function recordRun(
  store: MemoryStore, agent: string, by: TidyRun["by"],
  changes: Array<Omit<TidyChange, "n" | "afterEtag">>,
  opts: { at?: string; backup?: string } = {},
): TidyRun {
  const at = opts.at ?? new Date().toISOString()
  const runId = `${stampOf(at)}-${agent.replace(/[^A-Za-z0-9_-]/g, "_")}-${Math.random().toString(36).slice(2, 6)}`
  const run: TidyRun = {
    runId, agent, at, by,
    ...(opts.backup ? { backup: opts.backup } : {}),
    changes: changes.map((c, i) => ({ ...c, n: i + 1, afterEtag: c.after ? factEtag(c.after) : null })),
  }
  const dir = tidyDir(store)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${runId}.json`), JSON.stringify(run, null, 2) + "\n")
  const all = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
  for (const f of all.slice(0, Math.max(0, all.length - MAX_RUNS))) rmSync(resolve(dir, f), { force: true })
  return run
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

/** Undo a run, or one change of it. Each change is undone at most once. */
export function undoRun(
  store: MemoryStore, runId: string, opts: { change?: number; force?: boolean; now?: number } = {},
): UndoResult {
  const run = showRun(store, runId)
  if (!run) throw new Error(`no tidy run ${runId}`)
  if (opts.change !== undefined && !run.changes.some((c) => c.n === opts.change)) {
    throw new Error(`tidy run ${runId} has no change ${opts.change}`)
  }
  const result: UndoResult = { runId, restored: [], skipped: [] }
  const undoneAt = new Date(opts.now ?? Date.now()).toISOString()
  let facts = store.getAll(run.agent)
  let changed = false

  for (const c of run.changes) {
    if (opts.change !== undefined && c.n !== opts.change) continue
    if (c.undoneAt) { result.skipped.push({ n: c.n, why: "already undone" }); continue }
    const byId = new Map(facts.map((f) => [f.id, f]))
    if (c.after) {
      const now = byId.get(c.after.id)
      if (!opts.force && (!now || factEtag(now) !== c.afterEtag)) {
        result.skipped.push({ n: c.n, why: now ? "the kept fact changed after the tidy" : "the kept fact is gone" })
        continue
      }
    }
    // A merge keeps one of its own facts: put that one back as it was.
    const keepId = c.after?.id
    const back = c.before.filter((b) => b.id === keepId || !byId.has(b.id))
    if (back.length === 0) { result.skipped.push({ n: c.n, why: "the facts are already there" }); continue }
    const replaced = new Set(back.map((b) => b.id))
    facts = placeByAge(facts.filter((f) => !replaced.has(f.id) && f.id !== keepId), back)
    c.undoneAt = undoneAt
    result.restored.push(c.n)
    changed = true
  }

  if (changed) {
    if (existsSync(store.fileFor(run.agent))) {
      backupFacts(store, run.agent, { at: undoneAt, tag: "undo", keep: MAX_BACKUPS })
    }
    store.rewrite(run.agent, facts)
    writeFileSync(resolve(tidyDir(store), `${runId}.json`), JSON.stringify(run, null, 2) + "\n")
  }
  return result
}
