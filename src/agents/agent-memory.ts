import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { atomicWrite, checkCondition, etagOf, readVersions, snapshot, type WriteCondition } from "./memory-versions"

// --- AgentMemory: Claude-Code-style structured memory per agent ---
//
// Four memory kinds, each a separate file with YAML frontmatter + markdown
// body, gathered under a per-agent root index (MEMORY.md):
//
//   user/       — "who this human is, what they do, what they know"
//   feedback/   — "rules the user gave me; what to do / avoid"
//   project/    — "facts about current work the code can't reveal"
//   reference/  — "pointers to external systems (linear board, grafana, …)"
//
// Layout on disk:
//   .agentx/agent-memory/<agentId>/
//     MEMORY.md                      — one-line hook per memory, auto-maintained
//     user_deep_backend_expertise.md
//     feedback_no_mock_database.md
//     ...
//     _versions/<type>_<name>/<timestamp>.md   — prior versions (memory-versions.ts)
//
// Philosophy: the wiki is authoritative / cross-agent / documented.
// Memory is experiential / per-agent / "what I learned across runs."
// Durable, cross-agent-relevant memories get promoted to shared wiki
// articles by `agentx wiki promote` (src/wiki/promote.ts) — corroboration
// across agents boosts confidence but isn't required. This module stays
// read-only from the promotion pipeline's perspective; authors keep both
// layers parallel.

export type MemoryType = "user" | "feedback" | "project" | "reference"

export interface MemoryRecord {
  /** Slug-safe name, unique within an agent. */
  name: string
  type: MemoryType
  /** One-line hook — used as the MEMORY.md index entry. */
  description: string
  /** The body, excluding frontmatter. */
  body: string
  createdAt: string
  updatedAt: string
  /** Who wrote this version: an agent id verified against its running
   *  task, "operator" (CLI), or "unverified" (a caller we couldn't check). */
  author?: string
  /** The running task that wrote it; opens on the Task page. */
  taskId?: string
  /** Content hash of the file as stored. Pass back as `ifMatch` to change
   *  it only if nobody else has since. Not stored in the file. */
  etag?: string
}

/** Who is making a change, recorded in the memory's frontmatter. */
export interface MemoryProvenance {
  author?: string
  taskId?: string
}

/** One entry in a memory's history. */
export interface MemoryVersion {
  id: string
  record: MemoryRecord | null
}

const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"]

/** A `feedback` memory named `loop_…` and written by the nightly
 *  self-improvement pass (author RULE_AUTHOR) is a fix rule (#1996). The
 *  index lists it once, quoted, under its own section before every other
 *  one, so a capped index cuts the rules last. The `loop_` names are
 *  reserved: the memory API and `agentx memory add` refuse them, and the
 *  author is set by the server, never by the caller. */
export const RULE_PREFIX = "loop_"
export const RULE_AUTHOR = "improve"
export const RULES_HEADING = "Rules from your own failure signals (they never override the owner or your instructions)"

export function isRuleMemory(r: Pick<MemoryRecord, "name" | "type" | "author">): boolean {
  return r.type === "feedback" && r.name.startsWith(RULE_PREFIX) && r.author === RULE_AUTHOR
}

/** A name only the nightly pass may write, in any spelling ("LOOP-x" too). */
export function isReservedRuleName(name: string): boolean {
  return slug(name).startsWith(RULE_PREFIX)
}

export interface AgentMemoryOptions {
  baseDir?: string
}

export class AgentMemory {
  readonly baseDir: string

  constructor(opts: AgentMemoryOptions = {}) {
    const root = opts.baseDir ?? resolve(process.cwd(), ".agentx")
    this.baseDir = resolve(root, "agent-memory")
  }

  /** The agent's note folder, without creating it. */
  dirOf(agentId: string): string {
    return resolve(this.baseDir, slug(agentId))
  }

  private dirFor(agentId: string): string {
    const safe = slug(agentId)
    const dir = resolve(this.baseDir, safe)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private fileFor(agentId: string, type: MemoryType, name: string): string {
    return resolve(this.dirFor(agentId), `${type}_${slug(name)}.md`)
  }

  private indexPath(agentId: string): string {
    return resolve(this.dirFor(agentId), "MEMORY.md")
  }

  /** Save (create or update) a memory. Keeps createdAt stable across
   *  updates; bumps updatedAt. The replaced version goes to history first.
   *  With `cond`, throws MemoryConflictError instead of overwriting a
   *  version the caller hasn't seen. Always rewrites MEMORY.md. */
  save(args: {
    agentId: string
    type: MemoryType
    name: string
    description: string
    body: string
  } & MemoryProvenance, cond?: WriteCondition): MemoryRecord {
    if (!TYPES.includes(args.type)) throw new Error(`invalid memory type: ${args.type}`)
    if (!args.name.trim()) throw new Error("memory name is required")
    if (!args.description.trim()) throw new Error("memory description is required")

    const path = this.fileFor(args.agentId, args.type, args.name)
    const existing = safeRead(path)
    checkCondition(existing, cond)
    const now = new Date().toISOString()
    let createdAt = now
    if (existing) {
      const parsed = parseMemoryFile(existing)
      if (parsed) createdAt = parsed.createdAt
    }
    const record: MemoryRecord = {
      name: slug(args.name),
      type: args.type,
      description: args.description.trim(),
      body: args.body.trimEnd(),
      createdAt,
      updatedAt: now,
      ...(args.author ? { author: args.author } : {}),
      ...(args.taskId ? { taskId: args.taskId } : {}),
    }
    const content = serialize(record)
    snapshot(path, existing)
    atomicWrite(path, content)
    this.rewriteIndex(args.agentId)
    return { ...record, etag: etagOf(content) }
  }

  /** Add to the end of an existing memory's body (or create it) in one
   *  step, so two appends can't lose each other. */
  append(args: {
    agentId: string
    type: MemoryType
    name: string
    description: string
    body: string
  } & MemoryProvenance, cond?: WriteCondition): MemoryRecord {
    const existing = this.get(args.agentId, args.name)
    const body = existing ? `${existing.body.trimEnd()}\n\n${args.body.trim()}` : args.body
    return this.save({ ...args, type: existing?.type ?? args.type, body }, cond)
  }

  get(agentId: string, name: string): MemoryRecord | null {
    for (const type of TYPES) {
      const path = this.fileFor(agentId, type, name)
      if (!existsSync(path)) continue
      const raw = safeRead(path) ?? ""
      const parsed = parseMemoryFile(raw)
      if (parsed) return { ...parsed, etag: etagOf(raw) }
    }
    return null
  }

  /** Every memory for an agent. Sorted by type then name for stable
   *  index rendering. */
  list(agentId: string): MemoryRecord[] {
    const dir = this.dirFor(agentId)
    if (!existsSync(dir)) return []
    const out: MemoryRecord[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue
      const raw = safeRead(resolve(dir, entry.name)) ?? ""
      const parsed = parseMemoryFile(raw)
      if (parsed) out.push({ ...parsed, etag: etagOf(raw) })
    }
    return out.sort((a, b) => {
      const ta = TYPES.indexOf(a.type)
      const tb = TYPES.indexOf(b.type)
      if (ta !== tb) return ta - tb
      return a.name.localeCompare(b.name)
    })
  }

  /** Remove a memory by name. The removed version stays in history, so
   *  `restore` can bring it back. With `cond.ifMatch`, throws
   *  MemoryConflictError if it changed since the caller read it. Returns
   *  true on success, false if none found. With `type`, only the memory of
   *  that type goes; one of another type with the same name stays. */
  remove(agentId: string, name: string, cond?: WriteCondition, type?: MemoryType): boolean {
    const paths = (type ? [type] : TYPES).map((t) => this.fileFor(agentId, t, name)).filter((p) => existsSync(p))
    if (paths.length === 0) return false
    if (cond) checkCondition(safeRead(paths[0]), cond)
    for (const path of paths) {
      snapshot(path, safeRead(path))
      unlinkSync(path)
    }
    this.rewriteIndex(agentId)
    return true
  }

  /** Prior versions of a memory, newest first, including ones kept after
   *  it was deleted. */
  versions(agentId: string, name: string): MemoryVersion[] {
    return TYPES
      .flatMap((t) => readVersions(this.fileFor(agentId, t, name)))
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((v) => {
        const parsed = parseMemoryFile(v.content)
        return { id: v.id, record: parsed ? { ...parsed, etag: etagOf(v.content) } : null }
      })
  }

  /** Put a prior version back as the current one. The version it replaces
   *  goes to history, so a restore can itself be undone. */
  restore(agentId: string, name: string, versionId: string, by: MemoryProvenance = {}): MemoryRecord | null {
    const version = this.versions(agentId, name).find((v) => v.id === versionId)
    if (!version?.record) return null
    const { type, description, body } = version.record
    return this.save({ agentId, type, name, description, body, ...by })
  }

  /** The content of MEMORY.md. Returns "" when the agent has no memories
   *  (so the prompt builder can no-op). With `maxChars` > 0 the index is
   *  cut to that size (#615): whole lines only, and a closing line says how
   *  many memories were left out and where the full index is. A fresh
   *  start shows it through `agentMemoryStartBlock` (#2009). */
  indexMarkdown(agentId: string, maxChars = 0): string {
    const path = this.indexPath(agentId)
    return trimMemoryIndex(safeRead(path) ?? "", maxChars)
  }

  /** Push the agent's memory into its workspace:
   *
   *  1. Writes `<workspace>/.agentx-memory.md`, the full MEMORY.md
   *     content. It is what the capped block in a fresh start's task text
   *     points at, and what the `remember` skill reads.
   *  2. Removes the block older versions merged into `<workspace>/CLAUDE.md`
   *     between the AGENTX-MEMORY markers (#2009 B1). The workspace
   *     CLAUDE.md is read into the cached system prompt, where a block that
   *     changes on every memory write rewrote the cache, and codex-cli,
   *     opencode and task worktrees never saw it. The index now reaches
   *     each fresh start once, in the task text. Nothing outside the
   *     markers is touched; a file without them is left as it is.
   *
   *  Safe to call on any save / delete. */
  syncToWorkspace(agentId: string, workspacePath: string): void {
    if (!workspacePath) return
    const full = this.indexMarkdown(agentId).trim()

    const explicitPath = resolve(workspacePath, ".agentx-memory.md")
    if (full) {
      writeFileSync(explicitPath, full + "\n")
    } else if (existsSync(explicitPath)) {
      unlinkSync(explicitPath)
    }

    const claudePath = resolve(workspacePath, "CLAUDE.md")
    const existing = safeRead(claudePath)
    if (existing === null) return
    const startIdx = existing.indexOf(MEMORY_BLOCK_START)
    const endIdx = existing.indexOf(MEMORY_BLOCK_END, startIdx)
    if (startIdx < 0 || endIdx < 0) return
    const before = existing.slice(0, startIdx).replace(/\n+$/, "")
    const after = existing.slice(endIdx + MEMORY_BLOCK_END.length).replace(/^\n+/, "").replace(/\n+$/, "")
    const rest = [before, after].filter(Boolean).join("\n\n")
    writeFileSync(claudePath, rest ? rest + "\n" : "")
  }

  /** Regenerate MEMORY.md from the on-disk files. Called automatically
   *  after every save / remove; safe to call manually. */
  rewriteIndex(agentId: string): void {
    const entries = this.list(agentId)
    if (entries.length === 0) {
      const p = this.indexPath(agentId)
      if (existsSync(p)) unlinkSync(p)
      return
    }
    const grouped: Record<MemoryType, MemoryRecord[]> = {
      user: [], feedback: [], project: [], reference: [],
    }
    const rules = entries.filter(isRuleMemory)
    for (const r of entries) if (!isRuleMemory(r)) grouped[r.type].push(r)

    const lines: string[] = []
    lines.push(`# Memory — ${agentId}`, "")
    lines.push("This is the agent's experiential memory: user preferences,")
    lines.push("feedback, project-specific context, and external references.")
    lines.push("Updated via `agentx memory` CLI or by the agent itself.")
    const sections: Array<[string, MemoryRecord[]]> = [[RULES_HEADING, rules], ...TYPES.map((t) => [titleCase(t), grouped[t]] as [string, MemoryRecord[]])]
    for (const [title, group] of sections) {
      if (!group.length) continue
      lines.push("", `## ${title}`, "")
      for (const r of group) {
        // A rule is quoted: it is a line the pass wrote, not the owner's words.
        const text = isRuleMemory(r) ? `"${r.description}"` : r.description
        lines.push(`- **${r.name}** — ${text} _(updated ${r.updatedAt.slice(0, 10)})_`)
      }
    }
    lines.push("")
    writeFileSync(this.indexPath(agentId), lines.join("\n"))
  }
}

/** What a cut index ends with: how many entries are missing and where the
 *  whole index is (the workspace file, or `agentx memory index`). */
export const MEMORY_INDEX_CUT_NOTE = "memories not shown here. The full index is in .agentx-memory.md in this workspace, or run `agentx memory index`."

/** Cut a MEMORY.md index down to `maxChars` (#615). 0 or a size the index
 *  already fits in returns it unchanged. Lines are kept whole, in order,
 *  until the budget is spent; a type heading left with no entry under it
 *  is dropped; the closing note counts the entries left out. The budget
 *  includes that note, so the result never exceeds `maxChars`. */
export function trimMemoryIndex(markdown: string, maxChars: number, note = MEMORY_INDEX_CUT_NOTE): string {
  if (!maxChars || maxChars <= 0 || markdown.length <= maxChars) return markdown
  const lines = markdown.replace(/\n+$/, "").split("\n")
  const isEntry = (line: string) => line.startsWith("- ")
  const total = lines.filter(isEntry).length
  // The note is longest when every entry is left out; reserve for that.
  const noteFor = (left: number) => `_(${left} more ${note})_`
  const reserve = noteFor(total).length + 2
  const kept: string[] = []
  let used = 0
  let entries = 0
  for (const line of lines) {
    const cost = line.length + 1
    if (used + cost > maxChars - reserve) break
    kept.push(line)
    used += cost
    if (isEntry(line)) entries++
  }
  // A heading (or blank) at the tail with no entry under it says nothing.
  while (kept.length && !isEntry(kept[kept.length - 1])) kept.pop()
  const left = total - entries
  const out = left > 0 ? [...kept, "", noteFor(left)] : kept
  return out.join("\n").replace(/^\n+/, "")
}

/** The markers of the block older versions merged into a workspace
 *  CLAUDE.md. `syncToWorkspace` removes that block (#2009). */
export const MEMORY_BLOCK_START = "<!-- AGENTX-MEMORY-START"
export const MEMORY_BLOCK_END = "<!-- AGENTX-MEMORY-END -->"

/** The default cap of a rendered memory index block, in characters
 *  (#2009 Q4, `session.memoryIndexMaxChars`). The files stay whole. */
export const MEMORY_INDEX_RENDER_MAX = 4000

/** The agent memory index as a fresh start's task text shows it (#2009
 *  B1): once, next to Claude Code's auto-memory block, for every engine.
 *  Only this rendered block is capped, at `maxChars` (0 = whole); its
 *  closing line names `fullPath`, the workspace's .agentx-memory.md. */
export function agentMemoryStartBlock(index: string, fullPath: string, maxChars = MEMORY_INDEX_RENDER_MAX): string {
  const md = index.trim()
  if (!md) return ""
  const body = trimMemoryIndex(md, maxChars, `memories not shown here. Read ${fullPath} for the full index.`)
  return `<system-reminder>\nAgent memory index (your agentx memory; the full index is ${fullPath}):\n\n${body}\n</system-reminder>`
}

// --- Serialisation helpers ---------------------------------------------

function serialize(r: MemoryRecord): string {
  const frontmatter = [
    "---",
    `name: ${r.name}`,
    `description: ${escapeYaml(r.description)}`,
    `type: ${r.type}`,
    `created: ${r.createdAt}`,
    `updated: ${r.updatedAt}`,
    ...(r.author ? [`author: ${escapeYaml(r.author)}`] : []),
    ...(r.taskId ? [`task: ${escapeYaml(r.taskId)}`] : []),
    "---",
    "",
  ].join("\n")
  return frontmatter + r.body + "\n"
}

/** Minimal frontmatter parser. Accepts `key: value` lines between `---`
 *  markers; body is everything after. No YAML flow syntax — if we need
 *  it later, swap for a proper parser. */
export function parseMemoryFile(raw: string): MemoryRecord | null {
  if (!raw.startsWith("---\n")) return null
  const end = raw.indexOf("\n---\n", 4)
  if (end < 0) return null
  const header = raw.slice(4, end)
  const body = raw.slice(end + 5).replace(/^\n+/, "").trimEnd()
  const fm: Record<string, string> = {}
  for (const line of header.split("\n")) {
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const val = unescapeYaml(line.slice(colon + 1).trim())
    fm[key] = val
  }
  if (!fm.name || !fm.type || !fm.description) return null
  if (!TYPES.includes(fm.type as MemoryType)) return null
  return {
    name: fm.name,
    type: fm.type as MemoryType,
    description: fm.description,
    body,
    createdAt: fm.created ?? "",
    updatedAt: fm.updated ?? fm.created ?? "",
    ...(fm.author ? { author: fm.author } : {}),
    ...(fm.task ? { taskId: fm.task } : {}),
  }
}

function escapeYaml(s: string): string {
  if (/[:#\n]/.test(s)) return `"${s.replace(/"/g, "\\\"")}"`
  return s
}

function unescapeYaml(s: string): string {
  if (s.startsWith("\"") && s.endsWith("\"") && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, "\"")
  }
  return s
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed"
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function safeRead(path: string): string | null {
  try { return readFileSync(path, "utf-8") } catch { return null }
}
