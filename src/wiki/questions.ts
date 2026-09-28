import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { assertPerson } from "./facts/person"

// The gaps a lookup cannot close.
//
// Two things were producing gap signal and throwing it away. Absorb has
// always emitted a `gaps` array — entities it referenced but has no
// article for — and the command printed it and moved on, so the signal
// lived in a cron log nobody reads. And the field grader can now name a
// missing `role` or `ourOwner` that no system of record holds.
//
// Both are the same thing: a question only a person can answer. They
// get one queue rather than two, because a second parallel store is
// precisely what the wiki-as-source-of-truth decision rules out.
//
// Stored as JSON beside the other wiki sidecars (_index.json,
// _backlinks.json), because this is derived state that is rebuilt and
// rewritten, not knowledge. The knowledge is what lands in the article
// once the question is answered.

export type QuestionStatus = "open" | "answered" | "dismissed"

export interface WikiQuestion {
  id: string
  /** "field" — a named gap in an existing article.
   *  "article" — absorb referenced something with no article at all.
   *  "contradiction" — a write disagreed with a wiki fact and could not
   *  replace it (facts/ledger.ts); the answer is the true value. */
  kind: "field" | "article" | "contradiction"
  agentId: string
  /** Article path for a field question; empty for a missing article. */
  path: string
  /** Article title, or the referenced name for a missing article. */
  subject: string
  /** Required-field key, for `kind: "field"`. */
  field?: string
  /** What tier of the build this gap sits at, so asking can be ordered. */
  tier?: string
  question: string
  /** For a contradiction: the wiki fact and the value that was refused. */
  factId?: string
  proposed?: { value: string; source: string; verifiedAt: string; verifiedBy: string }
  status: QuestionStatus
  asked: string
  answered?: string
  answer?: string
}

export interface QuestionsFile {
  version: 1
  questions: WikiQuestion[]
  /** The file exists but could not be read. It is then never written. */
  unreadable?: string
}

/**
 * Stable across runs, so re-grading the same article does not ask the
 * same question twice and cannot resurrect one already dismissed.
 */
export function questionId(kind: string, agentId: string, subject: string, field?: string): string {
  return createHash("sha1")
    .update([kind, agentId, subject.toLowerCase().trim(), field ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 12)
}

export class QuestionStore {
  private readonly file: string

  constructor(wikiDir: string) {
    this.file = resolve(wikiDir, "_questions.json")
  }

  get path(): string { return this.file }

  load(): QuestionsFile {
    if (!existsSync(this.file)) return { version: 1, questions: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<QuestionsFile>
      if (!Array.isArray(parsed?.questions)) return { version: 1, questions: [], unreadable: "no questions list" }
      return { version: 1, questions: parsed.questions as WikiQuestion[] }
    } catch (e) {
      // A corrupt queue must not stop an absorb, and must not be
      // replaced by an empty one on the next save either: reads see no
      // questions, writes are refused until a person repairs the file.
      return { version: 1, questions: [], unreadable: String((e as Error)?.message ?? e) }
    }
  }

  private refuse(f: QuestionsFile): boolean {
    if (!f.unreadable) return false
    console.error(`[wiki-questions] ${this.file} is unreadable (${f.unreadable}); not writing to it. Repair or move it aside.`)
    return true
  }

  private save(f: QuestionsFile): void {
    if (f.unreadable) throw new Error(`${this.file} is unreadable; not writing to it`)
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(f, null, 2)}\n`)
  }

  list(status?: QuestionStatus): WikiQuestion[] {
    const all = this.load().questions
    return status ? all.filter((q) => q.status === status) : all
  }

  /**
   * Add questions that are not already on the queue.
   *
   * An existing id is left completely alone — including an answered or
   * dismissed one. Re-asking something a person has already dealt with
   * is how a queue becomes noise and then becomes ignored.
   */
  add(items: Array<Omit<WikiQuestion, "id" | "status" | "asked">>): { added: number; skipped: number } {
    const f = this.load()
    if (this.refuse(f)) return { added: 0, skipped: items.length }
    const seen = new Set(f.questions.map((q) => q.id))
    let added = 0, skipped = 0
    const now = new Date().toISOString()

    for (const item of items) {
      const id = questionId(item.kind, item.agentId, item.subject, item.field)
      if (seen.has(id)) { skipped++; continue }
      seen.add(id)
      f.questions.push({ ...item, id, status: "open", asked: now })
      added++
    }
    if (added > 0) this.save(f)
    return { added, skipped }
  }

  /** Returns the question so the caller can act on its subject/field. */
  resolve(id: string, status: "answered" | "dismissed", answer?: string): WikiQuestion | null {
    const f = this.load()
    const q = f.questions.find((x) => x.id === id || x.id.startsWith(id))
    if (!q) return null
    // A fact disagreement is the owner's signal that an agent's check
    // differs from a confirmed value: an agent may not close it, answered
    // or dismissed.
    if (q.kind === "contradiction") assertPerson(`${status === "dismissed" ? "dismiss" : "answer"} a fact disagreement`)
    q.status = status
    q.answered = new Date().toISOString()
    if (answer !== undefined) q.answer = answer
    this.save(f)
    return q
  }
}
