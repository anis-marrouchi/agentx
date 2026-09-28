import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { classifyAttribute, classifyFact, isFactClass, isPastTtl, type FactClass, type Provenance } from "@/agents/fact-freshness"
import type { ContradictionIssue } from "../lint-contradictions"
import { QuestionStore, questionId } from "../questions"

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
  /** Earlier values, newest last. Nothing is replaced silently. */
  history?: Array<{ value: string; source: string; verifiedAt: string; verifiedBy: string; replacedAt: string }>
}

export interface FactInput {
  subject: string
  attribute: string
  value: string
  source: string
  verifiedBy: string
  /** When the source was checked. Default: now. */
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

  constructor(readonly wikiDir: string) {
    this.file = resolve(wikiDir, "_facts.json")
  }

  load(): LedgerFile {
    if (!existsSync(this.file)) return { version: 1, facts: [], proposals: [] }
    try {
      const mtimeMs = statSync(this.file).mtimeMs
      if (this.cache?.mtimeMs === mtimeMs) return structuredClone(this.cache.data)
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<LedgerFile>
      const data: LedgerFile = {
        version: 1,
        facts: Array.isArray(raw?.facts) ? raw.facts : [],
        proposals: Array.isArray(raw?.proposals) ? raw.proposals : [],
      }
      this.cache = { mtimeMs, data }
      return structuredClone(data)
    } catch {
      return { version: 1, facts: [], proposals: [] }
    }
  }

  save(f: LedgerFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n")
    renameSync(tmp, this.file)
    this.cache = undefined
  }

  list(): WikiFact[] { return this.load().facts }

  get(id: string): WikiFact | null {
    return this.list().find((f) => f.id === id || (id.length >= 6 && f.id.startsWith(id))) ?? null
  }

  /**
   * Record a checked fact. Refuses a fact with no source. A different value
   * replaces the current one only with a newer check or `confirmedBy`;
   * otherwise it raises a contradiction and the current value stays.
   */
  write(input: FactInput, opts: { confirmedBy?: string; now?: number } = {}): WriteResult {
    const now = opts.now ?? Date.now()
    const nowIso = new Date(now).toISOString()
    if (!input.source?.trim()) throw new Error("a fact needs a source: a system, URL, command or \"owner said\"")
    if (!input.subject?.trim() || !input.attribute?.trim() || !input.value?.trim()) {
      throw new Error("a fact needs a subject, an attribute and a value")
    }
    const checked = Date.parse(input.verifiedAt ?? "")
    // A check can't be dated after it happened.
    const verifiedAt = Number.isFinite(checked) ? new Date(Math.min(checked, now)).toISOString() : nowIso
    const volatility = isFactClass(input.volatility)
      ? input.volatility
      : classifyAttribute(input.attribute, `${input.subject} ${input.attribute} is ${input.value}`)
    const provenance: Provenance = {
      source: input.source.trim(), verifiedAt, verifiedBy: input.verifiedBy || "unknown", volatility,
      ...(typeof input.ttlDays === "number" ? { ttlDays: input.ttlDays } : {}),
    }

    const data = this.load()
    const id = factId(input.subject, input.attribute)
    const existing = data.facts.find((f) => f.id === id)

    if (!existing) {
      const fact: WikiFact = {
        id, subject: input.subject.trim(), attribute: input.attribute.trim(), value: input.value.trim(),
        ...provenance, createdAt: nowIso, updatedAt: nowIso,
        ...(opts.confirmedBy ? { confirmedBy: opts.confirmedBy } : {}),
      }
      data.facts.push(fact)
      this.save(data)
      return { status: "created", fact }
    }

    const newer = Date.parse(verifiedAt) > Date.parse(existing.verifiedAt) || !Number.isFinite(Date.parse(existing.verifiedAt))
    if (norm(existing.value) === norm(input.value)) {
      if (!newer && !opts.confirmedBy) return { status: "unchanged", fact: existing }
      Object.assign(existing, provenance, { updatedAt: nowIso }, opts.confirmedBy ? { confirmedBy: opts.confirmedBy } : {})
      this.save(data)
      return { status: "verified", fact: existing }
    }

    if (!newer && !opts.confirmedBy) {
      const questionId = raiseContradiction(this.wikiDir, existing, { ...input, verifiedAt })
      return { status: "contradiction", fact: existing, questionId }
    }

    existing.history = [...(existing.history ?? []), {
      value: existing.value, source: existing.source, verifiedAt: existing.verifiedAt,
      verifiedBy: existing.verifiedBy, replacedAt: nowIso,
    }].slice(-10)
    existing.value = input.value.trim()
    Object.assign(existing, provenance, { updatedAt: nowIso })
    if (opts.confirmedBy) existing.confirmedBy = opts.confirmedBy
    else delete existing.confirmedBy
    this.save(data)
    return { status: "updated", fact: existing }
  }
}

function raiseContradiction(wikiDir: string, current: WikiFact, input: FactInput & { verifiedAt: string }): string {
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
  store.add([item])
  return questionId(item.kind, item.agentId, item.subject, item.field)
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
  return isPastTtl(f, now)
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
