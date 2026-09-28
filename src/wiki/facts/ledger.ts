import { createHash } from "crypto"
import { existsSync, statSync } from "fs"
import { resolve } from "path"
import { readLedger, withLock, writeLedger } from "./ledger-file"
import { classifyAttribute, classifyFact, isFactClass, isPastTtl, type FactClass, type Provenance } from "@/agents/fact-freshness"
import type { ContradictionIssue } from "../lint-contradictions"
import { assertPerson, QuestionStore, questionId } from "../questions"

export { assertPerson }

// --- The wiki fact ledger: durable facts with provenance (#273) ---
//
// Articles are prose. A fact an agent states to a person ("the vendor
// account is past due") needs more than prose: where it came from, when
// it was last checked, by whom, and how long it stays true. This is that
// record — one small JSON sidecar beside `_questions.json`, skipped by the
// article index like every `_` file.
//
// Every other store references it: memory lines that restate a ledger
// fact are replaced by a reference at injection (agents/memory-context),
// and memo claims wait here as proposals (fact-proposals.ts) instead of
// becoming memory.
//
// Overwrite safety: a write that disagrees with the current value needs a
// check newer than the current one, or a person's confirmation. Otherwise
// the old value stays and a contradiction question joins the wiki's
// question queue (`agentx wiki questions`), where the answer is written
// back through here.

export interface WikiFact extends Provenance {
  id: string
  subject: string
  attribute: string
  value: string
  createdAt: string
  updatedAt: string
  /** Set when a person confirmed the value over a newer-dated one. */
  confirmedBy?: string
  /** Recorded with no check time: never counts as checked, so it is
   *  always shown UNVERIFIED until a dated check or a person confirms it. */
  undated?: true
  /** Earlier values, newest last. Nothing is replaced silently. */
  history?: Array<{ value: string; source: string; verifiedAt: string; verifiedBy: string; replacedAt: string }>
}

export interface FactInput {
  subject: string
  attribute: string
  value: string
  source: string
  verifiedBy: string
  /** When the source was checked (ISO date, or "now"). Without it the
   *  write is undated and never counts as newer than an existing fact. */
  verifiedAt?: string
  volatility?: FactClass
  ttlDays?: number
}

export type WriteStatus = "created" | "verified" | "unchanged" | "updated" | "contradiction"

export interface WriteResult {
  status: WriteStatus
  fact: WikiFact
  /** The queued question, for a contradiction. */
  questionId?: string
}

export interface LedgerFile {
  version: 1
  facts: WikiFact[]
  proposals: import("./fact-proposals").FactProposal[]
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()


/** Stable per subject and attribute, so a re-check lands on the same fact. */
export function factId(subject: string, attribute: string): string {
  return "f-" + createHash("sha1").update(`${norm(subject)}\u0000${norm(attribute)}`).digest("hex").slice(0, 10)
}

export class FactLedger {
  readonly file: string
  private cache?: { mtimeMs: number; data: LedgerFile }
  private reported?: number

  constructor(readonly wikiDir: string) {
    this.file = resolve(wikiDir, "_facts.json")
  }

  /** The ledger as stored. Throws LedgerCorruptError on a file that does
   *  not parse: it is never read as empty, so it is never overwritten. */
  load(): LedgerFile {
    if (!existsSync(this.file)) return { version: 1, facts: [], proposals: [] }
    const mtimeMs = statSync(this.file).mtimeMs
    if (this.cache?.mtimeMs === mtimeMs) return structuredClone(this.cache.data)
    let raw
    try {
      raw = readLedger(this.file)
    } catch (e) {
      // Once per version of the bad file, not once per prompt.
      if (this.reported !== mtimeMs) {
        this.reported = mtimeMs
        console.error(`[wiki-facts] ${(e as Error).message}`)
      }
      throw e
    }
    const data: LedgerFile = { version: 1, facts: (raw?.facts ?? []) as WikiFact[], proposals: (raw?.proposals ?? []) as LedgerFile["proposals"] }
    this.cache = { mtimeMs, data }
    return structuredClone(data)
  }

  /**
   * Load, change and save under the ledger's lock, so concurrent writers
   * (a daemon proposing memo claims, a CLI `set`) can't drop each other's
   * change. `fn` returns whether to save, and a result.
   */
  update<T>(fn: (data: LedgerFile) => { save: boolean; result: T }): T {
    return withLock(this.file, () => {
      this.cache = undefined
      const data = this.load()
      const { save, result } = fn(data)
      if (save) {
        writeLedger(this.file, data)
        this.cache = undefined
      }
      return result
    })
  }

  list(): WikiFact[] { return this.load().facts }

  get(id: string): WikiFact | null {
    return this.list().find((f) => f.id === id || (id.length >= 6 && f.id.startsWith(id))) ?? null
  }

  /**
   * Record a checked fact. Refuses a fact with no source. A different value
   * replaces the current one only with a dated check newer than the current
   * one, or `confirmedBy`. A value a person confirmed is replaced only by
   * another confirmation. Otherwise the current value stays and a
   * contradiction question is raised.
   *
   * A write with no `verifiedAt` is undated: it can create a fact, but it
   * never counts as newer than a fact already there.
   */
  write(input: FactInput, opts: { confirmedBy?: string; now?: number } = {}): WriteResult {
    if (opts.confirmedBy) assertPerson("confirm a fact")
    const now = opts.now ?? Date.now()
    const nowIso = new Date(now).toISOString()
    if (!input.source?.trim()) throw new Error("a fact needs a source: a system, URL, command or \"owner said\"")
    if (!input.subject?.trim() || !input.attribute?.trim() || !input.value?.trim()) {
      throw new Error("a fact needs a subject, an attribute and a value")
    }
    const checked = input.verifiedAt === "now" ? now : Date.parse(input.verifiedAt ?? "")
    const dated = Number.isFinite(checked)
    // A check can't be dated after it happened.
    const verifiedAt = dated ? new Date(Math.min(checked, now)).toISOString() : nowIso
    const volatility = isFactClass(input.volatility)
      ? input.volatility
      : classifyAttribute(input.attribute, `${input.subject} ${input.attribute} is ${input.value}`)
    const provenance: Provenance = {
      source: input.source.trim(), verifiedAt, verifiedBy: input.verifiedBy || "unknown", volatility,
      ...(typeof input.ttlDays === "number" ? { ttlDays: input.ttlDays } : {}),
    }
    const id = factId(input.subject, input.attribute)

    const out = this.update<WriteResult | { contradiction: WikiFact }>((data) => {
      const existing = data.facts.find((f) => f.id === id)
      if (!existing) {
        const fact: WikiFact = {
          id, subject: input.subject.trim(), attribute: input.attribute.trim(), value: input.value.trim(),
          ...provenance, createdAt: nowIso, updatedAt: nowIso,
          ...(!dated && !opts.confirmedBy ? { undated: true as const } : {}),
          ...(opts.confirmedBy ? { confirmedBy: opts.confirmedBy } : {}),
        }
        data.facts.push(fact)
        return { save: true, result: { status: "created", fact } }
      }

      const prior = Date.parse(existing.verifiedAt)
      // Any dated check beats a fact that was never dated.
      const newer = dated && (existing.undated || !Number.isFinite(prior) || Date.parse(verifiedAt) > prior)
      if (norm(existing.value) === norm(input.value)) {
        if (!newer && !opts.confirmedBy) return { save: false, result: { status: "unchanged", fact: existing } }
        Object.assign(existing, provenance, { updatedAt: nowIso }, opts.confirmedBy ? { confirmedBy: opts.confirmedBy } : {})
        delete existing.undated
        return { save: true, result: { status: "verified", fact: existing } }
      }

      // A person's confirmation outranks any agent's date.
      if (!opts.confirmedBy && (!newer || existing.confirmedBy)) {
        return { save: false, result: { contradiction: existing } }
      }

      existing.history = [...(existing.history ?? []), {
        value: existing.value, source: existing.source, verifiedAt: existing.verifiedAt,
        verifiedBy: existing.verifiedBy, replacedAt: nowIso,
      }].slice(-10)
      existing.value = input.value.trim()
      Object.assign(existing, provenance, { updatedAt: nowIso })
      delete existing.undated
      if (opts.confirmedBy) existing.confirmedBy = opts.confirmedBy
      else delete existing.confirmedBy
      return { save: true, result: { status: "updated", fact: existing } }
    })

    if ("contradiction" in out) {
      const questionId = raiseContradiction(this.wikiDir, out.contradiction, { ...input, verifiedAt: dated ? verifiedAt : "undated" })
      return { status: "contradiction", fact: out.contradiction, questionId }
    }
    return out
  }
}

function raiseContradiction(wikiDir: string, current: WikiFact, input: FactInput & { verifiedAt: string }): string | undefined {
  const store = new QuestionStore(wikiDir)
  const item = {
    kind: "contradiction" as const,
    agentId: input.verifiedBy || "unknown",
    path: "_facts.json",
    subject: current.subject,
    // One question per refused value: a second, different claim is a new
    // question, while repeating the same claim does not ask twice.
    field: `${current.attribute}=${norm(input.value)}`,
    tier: "pillar",
    factId: current.id,
    proposed: { value: input.value.trim(), source: input.source.trim(), verifiedAt: input.verifiedAt, verifiedBy: input.verifiedBy },
    question:
      `${current.subject} · ${current.attribute}: the wiki says "${current.value}" ` +
      `(${current.source}, checked ${current.verifiedAt.slice(0, 10)}), but ${input.verifiedBy} reports ` +
      `"${input.value.trim()}" (${input.source.trim()}, checked ${input.verifiedAt.slice(0, 10)}). Which is true?`,
  }
  const id = questionId(item.kind, item.agentId, item.subject, item.field)
  store.add([item])
  // Undefined when the queue could not take it (an unreadable file): the
  // old value still stands, and the caller says the question is missing.
  return store.list().some((q) => q.id === id) ? id : undefined
}

/** Open fact contradictions, in the shape `wiki lint` reports. */
export function factContradictions(wikiDir: string): ContradictionIssue[] {
  return new QuestionStore(wikiDir).list("open")
    .filter((q) => q.kind === "contradiction")
    .map((q) => ({
      type: "contradiction" as const,
      articles: [`_facts.json#${q.factId ?? "?"}`],
      message: `[${q.id}] ${q.question}`,
      confidence: "high" as const,
    }))
}

/** A fact is stale when it is past its class TTL. */
export function isStaleFact(f: WikiFact, now = Date.now()): boolean {
  return f.undated === true || isPastTtl(f, now)
}

/**
 * The ledger fact a memory line restates, if any. The line must name the
 * fact's subject, and either repeat its value, share its volatility class,
 * or name its attribute.
 */
export function matchFact(content: string, facts: WikiFact[]): WikiFact | null {
  const text = norm(content)
  let best: WikiFact | null = null
  for (const f of facts) {
    const subject = norm(f.subject)
    if (subject.length < 3 || !text.includes(subject)) continue
    const attrWords = norm(f.attribute).split(" ").filter((w) => w.length > 2)
    const hit = text.includes(norm(f.value))
      || (f.volatility !== "stable" && classifyFact(content) === f.volatility)
      || (attrWords.length > 0 && attrWords.every((w) => text.includes(w)))
    if (hit && (!best || f.subject.length > best.subject.length)) best = f
  }
  return best
}
