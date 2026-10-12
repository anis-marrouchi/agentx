import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { resolve } from "path"

// --- Reading an agent's notes (#850) ---
//
// An agent's notes are small markdown files with frontmatter, one fact or
// one current state each. They live in one of two places:
//
//   - the AgentX note store, `.agentx/agent-memory/<agent>/<type>_<name>.md`
//     (src/agents/agent-memory.ts), with `name`, `description`, `type`,
//     `created` and `updated`;
//   - a notes folder another tool keeps, such as the one a `claude-code`
//     agent writes outside AgentX: `<name>.md` with `name`, `description`
//     and `type`, sometimes with extra fields under a `metadata:` block.
//
// Both are read the same way. Two more fields say whether a note can be
// trusted as written: `source` (where it was checked) and `checked` (the
// date it was checked). They are read from the top level or from under
// `metadata:`, never guessed from the prose. A note without them is still
// returned, with `missing` naming what it lacks.
//
// Read only: nothing here writes a note.

export type NoteField = "source" | "checked"

export interface AgentNote {
  /** Frontmatter `name`, else the file name without `.md`. */
  name: string
  /** File name inside the notes folder. */
  file: string
  /** `user`, `feedback`, `project`, `reference`, or what the file says. */
  type?: string
  /** One line saying what the note holds. */
  description: string
  body: string
  /** Where the note's content was checked. */
  source?: string
  /** When it was checked, YYYY-MM-DD. */
  checked?: string
  /** When the note was last written, as the file says. */
  updated?: string
  /** `source` and `checked`, when absent or unreadable. */
  missing: NoteField[]
  /** Why a field present in the file could not be used. */
  problems: string[]
}

export interface NotesRead {
  dir: string
  notes: AgentNote[]
  /** Files that are not notes, with the reason. */
  skipped: Array<{ file: string; reason: string }>
}

/** The index files tools keep next to the notes; not notes themselves. */
const INDEX_FILES = new Set(["memory.md"])

/**
 * Every note in `dir`, sorted by name. Only `*.md` files directly in the
 * folder are read; sub-folders (such as `_versions/`) and the `MEMORY.md`
 * index are not notes. A folder that does not exist reads as empty.
 */
export function readNotes(dir: string): NotesRead {
  const out: NotesRead = { dir, notes: [], skipped: [] }
  if (!existsSync(dir)) return out
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md") || file.startsWith(".") || INDEX_FILES.has(file.toLowerCase())) continue
    const path = resolve(dir, file)
    let raw: string
    try {
      if (!statSync(path).isFile()) continue
      raw = readFileSync(path, "utf-8")
    } catch (err) {
      out.skipped.push({ file, reason: `unreadable: ${(err as Error).message}` })
      continue
    }
    const note = parseNote(raw, file)
    if (note) out.notes.push(note)
    else out.skipped.push({ file, reason: "empty" })
  }
  out.notes.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file))
  return out
}

/**
 * One note from its file content. A file without frontmatter is still a
 * note: its first line is its description, and it has no source or check
 * date. Returns null for an empty file.
 */
export function parseNote(raw: string, file: string): AgentNote | null {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n")
  const { fields, metadata, body } = splitFrontmatter(text)
  if (!body.trim() && Object.keys(fields).length === 0) return null

  const pick = (key: string): string | undefined => {
    const v = fields[key] ?? metadata[key]
    return v && v.trim() ? v.trim() : undefined
  }
  const firstLine = body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? ""
  const note: AgentNote = {
    name: pick("name") ?? file.replace(/\.md$/, ""),
    file,
    description: pick("description") ?? firstLine,
    body: body.trim(),
    missing: [],
    problems: [],
  }
  const type = pick("type")
  if (type) note.type = type
  const updated = pick("updated") ?? pick("created")
  if (updated) note.updated = updated

  const source = pick("source")
  if (source) note.source = source
  else note.missing.push("source")

  const checkedRaw = pick("checked")
  const checked = checkedRaw ? checkDate(checkedRaw) : undefined
  if (checked) note.checked = checked
  else {
    note.missing.push("checked")
    if (checkedRaw) note.problems.push(`checked "${checkedRaw}" is not a date (use YYYY-MM-DD)`)
  }
  return note
}

/** YYYY-MM-DD from a date or an ISO date and time; undefined otherwise. */
function checkDate(v: string): string | undefined {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/)
  if (!m) return undefined
  const day = `${m[1]}-${m[2]}-${m[3]}`
  const t = Date.parse(`${day}T00:00:00Z`)
  // Rejects 2026-02-30 and the like, which Date.parse rolls over.
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day ? day : undefined
}

/**
 * Top-level `key: value` lines, and the indented `key: value` lines of a
 * `metadata:` block. No other YAML: lists, nested blocks other than
 * `metadata:` and multi-line values are ignored, not misread.
 */
function splitFrontmatter(text: string): { fields: Record<string, string>; metadata: Record<string, string>; body: string } {
  const fields: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  if (!text.startsWith("---\n")) return { fields, metadata, body: text }
  const end = text.indexOf("\n---", 4)
  if (end < 0) return { fields, metadata, body: text }
  const after = text.indexOf("\n", end + 4)
  const body = after < 0 ? "" : text.slice(after + 1)

  let block: string | undefined
  for (const line of text.slice(4, end).split("\n")) {
    const nested = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/)
    if (nested) {
      if (block === "metadata") metadata[nested[1]] = unquote(nested[2])
      continue
    }
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!top) continue
    if (top[2].trim() === "") { block = top[1]; continue }
    block = undefined
    fields[top[1]] = unquote(top[2])
  }
  return { fields, metadata, body }
}

function unquote(v: string): string {
  const s = v.trim()
  if (s.length >= 2 && s.startsWith("\"") && s.endsWith("\"")) return s.slice(1, -1).replace(/\\"/g, "\"")
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  return s
}
