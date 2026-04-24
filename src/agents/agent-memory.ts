import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"

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
//
// Philosophy: the wiki is authoritative / cross-agent / documented.
// Memory is experiential / per-agent / "what I learned across runs." A
// memory can be promoted to a wiki article (planned follow-up) after
// multiple agents confirm the same fact, but we don't enforce that
// here. Authors keep both layers parallel.

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
   *  updates; bumps updatedAt. Always rewrites MEMORY.md. */
  save(args: {
    agentId: string
    type: MemoryType
    name: string
    description: string
    body: string
  }): MemoryRecord {
    if (!TYPES.includes(args.type)) throw new Error(`invalid memory type: ${args.type}`)
    if (!args.name.trim()) throw new Error("memory name is required")
    if (!args.description.trim()) throw new Error("memory description is required")

    const path = this.fileFor(args.agentId, args.type, args.name)
    const now = new Date().toISOString()
    let createdAt = now
    const existing = safeRead(path)
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
    }
    writeFileSync(path, serialize(record))
    this.rewriteIndex(args.agentId)
    return record
  }

  get(agentId: string, name: string): MemoryRecord | null {
    for (const type of TYPES) {
      const path = this.fileFor(agentId, type, name)
      if (!existsSync(path)) continue
      const parsed = parseMemoryFile(safeRead(path) ?? "")
      if (parsed) return parsed
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
      const parsed = parseMemoryFile(safeRead(resolve(dir, entry.name)) ?? "")
      if (parsed) out.push(parsed)
    }
    return out.sort((a, b) => {
      const ta = TYPES.indexOf(a.type)
      const tb = TYPES.indexOf(b.type)
      if (ta !== tb) return ta - tb
      return a.name.localeCompare(b.name)
    })
  }

  /** Remove a memory by name. Returns true on success, false if none found. */
  remove(agentId: string, name: string): boolean {
    let removed = false
    for (const type of TYPES) {
      const path = this.fileFor(agentId, type, name)
      if (existsSync(path)) { unlinkSync(path); removed = true }
    }
    if (removed) this.rewriteIndex(agentId)
    return removed
  }

  /** The content of MEMORY.md — used at prompt-build time to inline into
   *  the agent's system prompt. Returns "" when the agent has no
   *  memories (so the prompt builder can no-op). */
  indexMarkdown(agentId: string): string {
    const path = this.indexPath(agentId)
    return safeRead(path) ?? ""
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
