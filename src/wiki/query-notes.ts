// --- An agent's own notes in the `wiki query` pool (#862) ---
//
// Facts an agent keeps only in its notes were out of reach of `wiki
// query` (#855 score). Here each note becomes one more entry of the
// summaries method: its `description` is its summary line, its body is
// the page that is opened. Notes are read with note-reader.ts (#850),
// never written.
//
// Read permissions are those of the notes themselves: a note is private
// to the agent that wrote it, so only the requester's own notes join its
// pool. A note of an excluded type, or one that holds what looks like a
// secret, is left out entirely, summary line included.

import { containsSecret } from "@/agents/memory-trust"
import { readNotes, type AgentNote } from "./note-reader"
import type { SummaryCandidate } from "./query-summaries"
import type { WikiArticle } from "./types"

/** Pool paths of notes start with this, so they never meet a page path. */
export const NOTE_PREFIX = "note:"

export const isNotePath = (path: string): boolean => path.startsWith(NOTE_PREFIX)

/** Where one agent's notes are and which of them may be searched. */
export interface NoteSource {
  /** The agent the notes belong to. Only that agent's queries read them. */
  owner: string
  dir: string
  /** Note types searched, such as `project` and `reference`. */
  types: string[]
}

export interface NotePool {
  pool: SummaryCandidate[]
  /** Summary line of each note, keyed by its pool path. */
  summaries: Map<string, string>
  read(path: string): WikiArticle | null
}

/** The notes of `source` that a query may offer, as pool entries. */
export function notePool(source: NoteSource): NotePool {
  const types = new Set(source.types)
  const byPath = new Map<string, AgentNote>()
  for (const note of readNotes(source.dir).notes) {
    if (!note.type || !types.has(note.type)) continue
    if (!note.description && !note.body) continue
    if (containsSecret(`${note.description}\n${note.body}`)) continue
    byPath.set(`${NOTE_PREFIX}${note.file}`, note)
  }
  const pool: SummaryCandidate[] = []
  const summaries = new Map<string, string>()
  for (const [path, note] of byPath) {
    pool.push({ path, title: note.name, type: "note", tags: [note.type!], owner: source.owner, lastUpdated: note.checked })
    summaries.set(path, note.description || note.body.split("\n")[0])
  }
  return {
    pool,
    summaries,
    read(path) {
      const note = byPath.get(path)
      return note ? noteArticle(path, note, source.owner) : null
    },
  }
}

/** A note shaped as a page, with its source and check date on top. It
 *  has no page type: callers tell a note by its path. */
function noteArticle(path: string, note: AgentNote, owner: string): WikiArticle {
  const checked = note.checked ? `Checked: ${note.checked}` : "Checked: not recorded"
  const source = note.source ? `Source: ${note.source}` : "Source: not recorded"
  const day = note.checked ?? note.updated?.slice(0, 10) ?? ""
  return {
    path,
    content: `${source}\n${checked}\n\n${note.body}`,
    meta: {
      title: note.name,
      tags: [note.type ?? "note"],
      owner,
      access: "private",
      created: day,
      lastUpdated: note.checked ?? "",
      sources: note.source ? [note.source] : [],
    },
  }
}
