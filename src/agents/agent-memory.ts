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

export interface AgentMemoryOptions {
  baseDir?: string
}

export class AgentMemory {
  readonly baseDir: string

  constructor(opts: AgentMemoryOptions = {}) {
    const root = opts.baseDir ?? resolve(process.cwd(), ".agentx")
    this.baseDir = resolve(root, "agent-memory")
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
   *  true on success, false if none found. */
  remove(agentId: string, name: string, cond?: WriteCondition): boolean {
    const paths = TYPES.map((t) => this.fileFor(agentId, t, name)).filter((p) => existsSync(p))
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

  /** The content of MEMORY.md — used at prompt-build time to inline into
   *  the agent's system prompt. Returns "" when the agent has no
   *  memories (so the prompt builder can no-op). */
  indexMarkdown(agentId: string): string {
    const path = this.indexPath(agentId)
    return safeRead(path) ?? ""
  }

  /** Push the agent's memory into its workspace so Claude Code sessions
   *  pick it up automatically. Does two things:
   *
   *  1. Writes `<workspace>/.agentx-memory.md` — full MEMORY.md content,
   *     explicit file the skill can `Read` at session start.
   *  2. Merges that same content into `<workspace>/CLAUDE.md` between
   *     sentinel comments so Claude Code auto-loads it into the cached
   *     system context on every session. Idempotent: subsequent syncs
   *     replace the sentinel block.
   *
   *  Never touches content outside the sentinel block — if the file
   *  doesn't exist, creates it with just the sentinels. Safe to call
   *  on any save / delete. */
  syncToWorkspace(agentId: string, workspacePath: string): void {
    if (!workspacePath) return
    const memory = this.indexMarkdown(agentId).trim()

    // 1. Explicit file for the `remember` skill to Read if it wants to.
    const explicitPath = resolve(workspacePath, ".agentx-memory.md")
    if (memory) {
      writeFileSync(explicitPath, memory + "\n")
    } else if (existsSync(explicitPath)) {
      unlinkSync(explicitPath)
    }

    // 2. Sentinel-merged into CLAUDE.md for auto-inject.
    const claudePath = resolve(workspacePath, "CLAUDE.md")
    const start = "<!-- AGENTX-MEMORY-START — auto-managed by agentx; edit via `agentx memory` -->"
    const end   = "<!-- AGENTX-MEMORY-END -->"
    const block = memory
      ? `${start}\n${memory}\n${end}`
      : ""

    const existing = safeRead(claudePath) ?? ""
    const startIdx = existing.indexOf(start)
    const endIdx   = existing.indexOf(end)

    let next: string
    if (startIdx >= 0 && endIdx > startIdx) {
      // Replace existing sentinel block (or remove it if memory is empty).
      const before = existing.slice(0, startIdx).replace(/\n+$/, "")
      const after  = existing.slice(endIdx + end.length).replace(/^\n+/, "")
      next = block
        ? [before, block, after].filter(Boolean).join("\n\n") + "\n"
        : [before, after].filter(Boolean).join("\n\n") + (before || after ? "\n" : "")
    } else if (block) {
      // No prior block — append to the end of CLAUDE.md (creates the file
      // if needed). Keeps any existing content untouched.
      next = existing
        ? existing.replace(/\n+$/, "") + "\n\n" + block + "\n"
        : block + "\n"
    } else {
      // Empty memory + no prior block → nothing to do.
      return
    }
    writeFileSync(claudePath, next)
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
    for (const r of entries) grouped[r.type].push(r)

    const lines: string[] = []
    lines.push(`# Memory — ${agentId}`, "")
    lines.push("This is the agent's experiential memory: user preferences,")
    lines.push("feedback, project-specific context, and external references.")
    lines.push("Updated via `agentx memory` CLI or by the agent itself.")
    for (const type of TYPES) {
      const group = grouped[type]
      if (!group.length) continue
      lines.push("", `## ${titleCase(type)}`, "")
      for (const r of group) {
        lines.push(`- **${r.name}** — ${r.description} _(updated ${r.updatedAt.slice(0, 10)})_`)
      }
    }
    lines.push("")
    writeFileSync(this.indexPath(agentId), lines.join("\n"))
  }
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
