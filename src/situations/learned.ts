import type Database from "better-sqlite3"
import { createHash, createHmac, timingSafeEqual } from "crypto"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname } from "path"
import { LEARNED_PREFIX, oneLine, situationTemplate, stripInvisible, type LearnedTemplateSource, type SituationTemplate } from "./templates"

// --- Learned templates: the one home of drafts and approvals (#1892 phase 8) ---
//
// The weekly `situation-learn` run (learn.ts) drafts templates from ended
// talks. The text of each draft lives in `situation_learned_templates`;
// every decision about it lives in one sealed STATE (a row of
// `situation_learned_settings`): its status (draft, active, rejected,
// retired), how often the approver was asked, who decided and when, the
// hash of the exact text decided on, the approver the owner named, the
// owner's picks of a learned template for a talk, and a generation
// counter that only goes up. Nothing else holds them.
//
// What a learned template may carry, and only this (a fixed schema, the
// columns below): a title, a "when" line, one prompt rule per phase and
// one line of closing-note guidance, on top of a base template from the
// hand-written catalog. It never carries a code gate, an outward send, a
// note home or promise owners: there is no column for them, and the lint
// refuses text that asks for them. Its closing steps are the base's.
//
// Agents run as the same user and can write this database. So:
//   - the state is an HMAC-sealed document under a key derived from the
//     operator key (.agentx/operator.key, which the guard keeps agents
//     from reading, #1979). A row's own status columns are a copy for
//     people to read; they decide nothing;
//   - an edited state has no valid seal: then nothing learned is drafted,
//     asked or used until the owner resets it (docs);
//   - an older sealed state put back (to undo a retire, a no or a new
//     approver) has a lower generation: this daemon refuses it while it
//     runs. After a restart it cannot tell: a rollback of the whole
//     database is the one thing left, and the docs say so;
//   - a draft is used only while the hash of its text, its evidence
//     summary included, still matches the state's.
// No operator key: nothing is drafted or used.

export const LEARNED_BASES = ["meeting", "meeting.external", "job.production", "hand-off"] as const
export type LearnedBase = (typeof LEARNED_BASES)[number]

export const LEARNED_LIMITS = { slug: 40, title: 60, when: 160, rule: 200, guidance: 200, why: 300, verdictWhy: 300, evidence: 12_000 } as const

export type LearnedStatus = "draft" | "active" | "rejected" | "retired"

export interface LearnedDraft {
  slug: string
  base: LearnedBase
  title: string
  when: string
  rules: Partial<Record<"during" | "ending" | "ended", string>>
  noteGuidance?: string
  /** The ended talks it was drafted from (situation ids). */
  evidence: string[]
  /** What the approver reads of that evidence: built by the daemon at
   *  draft time from checked values, and sealed with the draft. */
  evidenceSummary?: string
  why: string
}

export interface LearnedRow {
  id: string
  base: string
  title: string
  when: string
  rules: Partial<Record<"during" | "ending" | "ended", string>>
  noteGuidance: string
  evidence: string[]
  evidenceSummary: string
  why: string
  status: LearnedStatus
  createdAt: number
  reviewAttempts: number
  lastReviewAt: number | null
  reviewer: string | null
  verdictWhy: string | null
  decidedAt: number | null
  retiredAt: number | null
  retiredBy: string | null
  /** The daemon drafted it and its text is the one the state holds. */
  sealed: boolean
}

// --- The lint ---


const NUMBER_WORDS = "zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen"

/** Text a learned template may not hold. Each pattern names what it
 *  guards: the template adds sentences, nothing else. */
const LINT: Array<[RegExp, string]> = [
  [/[^\p{Script=Latin} .,;:!?'()-]/u, "characters other than Latin letters, spaces and plain punctuation"],
  [/\bh(?:tt|xx)ps?\b|www|\b\w+\.\w{2,}\b|\bdot (?:com|net|org|io|dev|app)\b|\[\.\]|\(\.\)/i, "a link"],
  [new RegExp(`\\b(?:${NUMBER_WORDS})\\b`, "i"), "a number"],
  [/\b(?:send|sends|sent|post|posts|posted|publish|forward|e-?mail|dm|sms|whatsapp|telegram|slack|discord|notify|text them|call them|call back|webhook|curl)\b/i, "a send to anyone"],
  [/\b(?:issue|merge request|pull request|ticket|wiki|repo|repository|home)\b/i, "a note home"],
  [/\b(?:assign|assigned|owned by|owner is|owners are|promise (?:to|for)|due (?:on|by))\b/i, "a promise owner or due time"],
  [/\b(?:the owners? (?:says|said|wants|wanted|asks|asked|told|approved|allows|allowed)|owner's (?:wish|wishes|order|orders|instruction|instructions|word|words|request)|boss|manager|admin|administrator|the user (?:wants|says|said|asks|asked)|user wants|already (?:approved|agreed|allowed)|pre-?approved|authori[sz]ed|on behalf)\b/i, "a claim of someone's authority"],
  [/\b(?:ignore|disregard|override|bypass|instruction|instructions|system prompt|prompt|operator|daemon|agentx|tool|tools|approve|approved|approval|gate|permission|secret|password|token|key|reviewer|verdict)\b/i, "an instruction to the system"],
]

/** Why this learned text is refused, or null when it may be used. */
export function lintLearnedText(text: string): string | null {
  if (text !== stripInvisible(text)) return "holds invisible or direction characters"
  const t = text.normalize("NFKC").replace(/\s+/g, " ").trim()
  if (!t) return "empty"
  if (t !== text.replace(/\s+/g, " ").trim()) return "holds look-alike characters"
  for (const [re, what] of LINT) if (re.test(t)) return `holds ${what}`
  // A capitalised word inside a sentence looks like a name (all capitals,
  // such as HR, is a role).
  const words = t.split(" ")
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/^[(']+|[),.;:!?']+$/g, "")
    if (/^\p{Lu}\p{Ll}/u.test(w) && !/[.!?]$/.test(words[i - 1])) return "holds what looks like a name"
  }
  return null
}

/** Every refusal for a draft's text fields. */
export function lintDraft(d: Pick<LearnedDraft, "title" | "when" | "rules" | "noteGuidance"> & { why?: string }): string[] {
  const out: string[] = []
  const check = (label: string, text: string | undefined, max: number) => {
    if (text === undefined || text === "") return
    if (text.length > max) { out.push(`${label}: longer than ${max} characters`); return }
    const why = lintLearnedText(text)
    if (why) out.push(`${label}: ${why}`)
  }
  check("title", d.title, LEARNED_LIMITS.title)
  check("when", d.when, LEARNED_LIMITS.when)
  for (const p of ["during", "ending", "ended"] as const) check(`rules.${p}`, d.rules[p], LEARNED_LIMITS.rule)
  check("noteGuidance", d.noteGuidance, LEARNED_LIMITS.guidance)
  check("why", d.why, LEARNED_LIMITS.why)
  if (!d.rules.during && !d.rules.ending && !d.rules.ended && !d.noteGuidance) out.push("no rule and no guidance")
  return out
}

/** What a reviewer reads of a draft, to tell whether it changed since. */
export function learnedContent(r: Pick<LearnedRow, "id" | "base" | "title" | "when" | "rules" | "noteGuidance" | "evidence" | "evidenceSummary" | "why">): string {
  return JSON.stringify([r.id, r.base, r.title, r.when, r.rules.during ?? "", r.rules.ending ?? "", r.rules.ended ?? "", r.noteGuidance, r.evidence, r.evidenceSummary, r.why])
}

type Raw = {
  id: string; base: string; title: string; when_text: string; rule_during: string | null; rule_ending: string | null; rule_ended: string | null
  note_guidance: string | null; evidence: string; evidence_summary: string; why: string; status: string; created_at: number
  review_attempts: number; last_review_at: number | null; reviewer: string | null; verdict_why: string | null; decided_at: number | null
  retired_at: number | null; retired_by: string | null
}

/** One draft's decisions, in the sealed state. */
interface Entry {
  /** status */ s: LearnedStatus
  /** hash of the text decided on (content and created_at) */ h: string
  /** times the approver was asked */ n: number
  /** last ask */ at: number | null
  /** who decided */ by: string | null
  /** when */ d: number | null
  /** the decision's reason */ w: string | null
  /** retired by, at */ rb: string | null; ra: number | null
}

interface State {
  v: 1
  /** Goes up with every change; a lower one is refused while running. */
  gen: number
  approver: string | null
  lastRun: number | null
  t: Record<string, Entry>
  /** Hashes of sentences turned down or retired: never drafted again. */
  no: string[]
  /** The owner's picks: situation id → learned template id. */
  picks: Record<string, string>
}

const STATE_ROW = "state"
const PICKS_MAX = 500
const NO_MAX = 2000

/** A review may be tried again only this long after a failed one, and
 *  at most this many times in all: asking again cannot reroll a no. */
export const REVIEW_RETRY_MS = 6 * 24 * 3600_000
export const MAX_REVIEW_ATTEMPTS = 2

const sentenceHash = (v: string) => createHash("sha256").update(oneLine(v, 1000).toLowerCase()).digest("hex").slice(0, 32)

export class LearnedTemplateStore {
  private readonly now: () => number
  /** The highest generation this process has seen. */
  private highGen = 0

  constructor(private readonly db: Database.Database, private readonly opts: { key: () => string | null; now?: () => number; genFile?: string }) {
    this.now = opts.now ?? Date.now
    db.exec(`
      CREATE TABLE IF NOT EXISTS situation_learned_templates (
        id TEXT PRIMARY KEY,
        base TEXT NOT NULL,
        title TEXT NOT NULL,
        when_text TEXT NOT NULL,
        rule_during TEXT,
        rule_ending TEXT,
        rule_ended TEXT,
        note_guidance TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        evidence_summary TEXT NOT NULL DEFAULT '',
        why TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        review_attempts INTEGER NOT NULL DEFAULT 0,
        last_review_at INTEGER,
        reviewer TEXT,
        verdict_why TEXT,
        decided_at INTEGER,
        retired_at INTEGER,
        retired_by TEXT
      );
      CREATE TABLE IF NOT EXISTS situation_learned_settings (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        mac TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS situation_learn_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      );
    `)
  }

  /** The seal key: derived from the operator key, for this use only. */
  private sealKey(): Buffer | null {
    const k = this.opts.key()
    return k ? createHmac("sha256", k).update("agentx situations.learned v2").digest() : null
  }

  /** Can this node seal (it has an operator key)? */
  canSeal(): boolean {
    return !!this.sealKey()
  }

  private mac(kind: string, text: string): string | null {
    const key = this.sealKey()
    return key ? createHmac("sha256", key).update(`${kind}\n${text}`).digest("hex") : null
  }

  private same(a: string | null | undefined, b: string | null): boolean {
    return !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  }

  private contentHash(r: Raw): string | null {
    return this.mac("content", JSON.stringify([learnedContent(this.text(r)), r.created_at]))
  }

  // --- The sealed state ---

  /** The state, or null with the reason it cannot be trusted. */
  // The highest generation is also kept outside the database, in
  // `.agentx/learned.gen` (sealed; the guard rule `learned-gen-write`
  // keeps agents off it), so an older copy of the database put back is
  // noticed after a restart too.

  /** The generation file: its sealed number, missing, or changed. */
  private readGen(): { gen: number } | { missing: true } | { bad: true } | null {
    const path = this.opts.genFile
    if (!path) return null
    let text: string
    try { text = readFileSync(path, "utf-8").trim() } catch { return { missing: true } }
    const [n, mac] = text.split(/\s+/)
    const gen = Number(n)
    if (!Number.isSafeInteger(gen) || gen < 0 || !this.same(mac, this.mac("gen", String(gen)))) return { bad: true }
    return { gen }
  }

  private writeGen(gen: number): void {
    const path = this.opts.genFile
    const mac = this.mac("gen", String(gen))
    if (!path || !mac) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${gen} ${mac}\n`, { mode: 0o600 })
    } catch { /* the database still holds it; the next change tries again */ }
  }

  private load(): { state: State } | { state: null; why: string } {
    if (!this.sealKey()) return { state: null, why: "no operator key on this node (.agentx/operator.key)" }
    const file = this.readGen()
    if (file && "bad" in file) return { state: null, why: "the generation file .agentx/learned.gen was changed outside AgentX" }
    const floor = Math.max(this.highGen, file && "gen" in file ? file.gen : 0)
    const r = this.db.prepare("SELECT value, mac FROM situation_learned_settings WHERE name = ?").get(STATE_ROW) as { value: string; mac: string } | undefined
    if (!r) {
      const rows = (this.db.prepare("SELECT COUNT(*) AS n FROM situation_learned_templates").get() as { n: number }).n
      if (floor > 0 || rows > 0) return { state: null, why: "the sealed state is missing (deleted, or an older copy of the database was put back)" }
      return { state: { v: 1, gen: 0, approver: null, lastRun: null, t: {}, no: [], picks: {} } }
    }
    if (!this.same(r.mac, this.mac("state", r.value))) return { state: null, why: "the sealed state was changed outside AgentX" }
    let s: State
    try { s = JSON.parse(r.value) as State } catch { return { state: null, why: "the sealed state does not read" } }
    if (s?.v !== 1 || typeof s.gen !== "number") return { state: null, why: "the sealed state does not read" }
    // A state with no generation file beside it: the file was removed
    // (or both were put back from before the first change).
    if (file && "missing" in file && s.gen > 0) return { state: null, why: "the generation file .agentx/learned.gen is missing" }
    if (s.gen < floor) return { state: null, why: `an older sealed state was put back (generation ${s.gen}, newest seen ${floor})` }
    this.highGen = s.gen
    return { state: s }
  }

  private state(): State | null {
    return this.load().state
  }

  /** Why nothing learned can be drafted, asked or used now, or null. */
  problem(): string | null {
    const l = this.load()
    return l.state ? null : l.why
  }

  /** Change the state: read, check, change, seal, all in one transaction.
   *  False when the state cannot be trusted or `fn` declined. */
  private change(fn: (s: State) => boolean): boolean {
    const ok = this.db.transaction(() => {
      const s = this.state()
      if (!s || !fn(s)) return false
      s.gen += 1
      const value = JSON.stringify(s)
      const mac = this.mac("state", value)
      if (!mac) return false
      this.db.prepare("INSERT INTO situation_learned_settings (name, value, mac) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, mac = excluded.mac")
        .run(STATE_ROW, value, mac)
      this.highGen = s.gen
      return true
    })()
    // After the commit: a file ahead of the database would read as a
    // rollback.
    if (ok) this.writeGen(this.highGen)
    return ok
  }

  /** Copy an entry's decision onto the row, for people to read. */
  private mirror(id: string, e: Entry): void {
    this.db.prepare(`UPDATE situation_learned_templates SET status = ?, review_attempts = ?, last_review_at = ?, reviewer = ?, verdict_why = ?,
      decided_at = ?, retired_at = ?, retired_by = ? WHERE id = ?`).run(e.s, e.n, e.at, e.by, e.w, e.d, e.ra, e.rb, id)
  }

  // --- The approver: named by the owner with the operator key ---
  //
  // Not a setting in agentx.json, which agents can edit: the owner names
  // it with `agentx situation learned approver <agent>` (operator key).
  // A template is used only while the reviewer who said yes is still the
  // approver.

  /** Name the approver (owner only: the route checks the operator key).
   *  Null clears it. */
  setApprover(agentId: string | null): boolean {
    return this.change((s) => { s.approver = agentId; return true })
  }

  /** The approver the owner named, or null (none, or the state cannot be trusted). */
  approver(): string | null {
    return this.state()?.approver ?? null
  }

  private raw(id: string): Raw | null {
    return (this.db.prepare("SELECT * FROM situation_learned_templates WHERE id = ?").get(id) as Raw | undefined) ?? null
  }

  private text(r: Raw): Pick<LearnedRow, "id" | "base" | "title" | "when" | "rules" | "noteGuidance" | "evidence" | "evidenceSummary" | "why"> {
    let evidence: string[] = []
    try { const v = JSON.parse(r.evidence); if (Array.isArray(v)) evidence = v.filter((x): x is string => typeof x === "string") } catch { evidence = [] }
    return {
      id: r.id, base: r.base, title: r.title, when: r.when_text,
      rules: { ...(r.rule_during ? { during: r.rule_during } : {}), ...(r.rule_ending ? { ending: r.rule_ending } : {}), ...(r.rule_ended ? { ended: r.rule_ended } : {}) },
      noteGuidance: r.note_guidance ?? "", evidence, evidenceSummary: r.evidence_summary ?? "", why: r.why,
    }
  }

  /** The entry for a row whose text is the one the state holds, or null. */
  private entry(s: State | null, r: Raw): Entry | null {
    const e = s?.t[r.id]
    return e && this.same(e.h, this.contentHash(r)) ? e : null
  }

  private toRow(r: Raw, s: State | null): LearnedRow {
    const e = this.entry(s, r)
    return {
      ...this.text(r), createdAt: r.created_at,
      // Without a matching entry the row's own columns are shown, but it
      // is not sealed and never asked about or used.
      status: e ? e.s : (["draft", "active", "rejected", "retired"].includes(r.status) ? r.status as LearnedStatus : "draft"),
      reviewAttempts: e ? e.n : r.review_attempts, lastReviewAt: e ? e.at : r.last_review_at,
      reviewer: e ? e.by : r.reviewer, verdictWhy: e ? e.w : r.verdict_why, decidedAt: e ? e.d : r.decided_at,
      retiredAt: e ? e.ra : r.retired_at, retiredBy: e ? e.rb : r.retired_by, sealed: !!e,
    }
  }

  /** Write a draft the daemon made. Refused without the operator key, for
   *  an id used before (in any status) or for text the lint refuses. */
  addDraft(d: LearnedDraft): { ok: true; id: string } | { ok: false; error: string } {
    if (!this.sealKey()) return { ok: false, error: "no operator key on this node (.agentx/operator.key): nothing is drafted" }
    const problem = this.problem()
    if (problem) return { ok: false, error: problem }
    if (!(LEARNED_BASES as readonly string[]).includes(d.base)) return { ok: false, error: `base must be one of ${LEARNED_BASES.join(", ")}` }
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(d.slug)) return { ok: false, error: "slug must be lower-case letters, digits and dashes" }
    const lint = lintDraft(d)
    if (lint.length) return { ok: false, error: lint.join("; ") }
    const id = `${LEARNED_PREFIX}${d.slug}`
    if (this.raw(id) || this.state()?.t[id]) return { ok: false, error: `${id} was drafted before` }
    const r: Raw = {
      id, base: d.base, title: oneLine(d.title, LEARNED_LIMITS.title), when_text: oneLine(d.when, LEARNED_LIMITS.when),
      rule_during: d.rules.during ? oneLine(d.rules.during, LEARNED_LIMITS.rule) : null,
      rule_ending: d.rules.ending ? oneLine(d.rules.ending, LEARNED_LIMITS.rule) : null,
      rule_ended: d.rules.ended ? oneLine(d.rules.ended, LEARNED_LIMITS.rule) : null,
      note_guidance: d.noteGuidance ? oneLine(d.noteGuidance, LEARNED_LIMITS.guidance) : null,
      evidence: JSON.stringify([...new Set(d.evidence)].slice(0, 50)), evidence_summary: String(d.evidenceSummary ?? "").slice(0, LEARNED_LIMITS.evidence),
      why: oneLine(d.why, LEARNED_LIMITS.why), status: "draft", created_at: this.now(), review_attempts: 0, last_review_at: null, reviewer: null,
      verdict_why: null, decided_at: null, retired_at: null, retired_by: null,
    }
    const h = this.contentHash(r)
    if (!h) return { ok: false, error: "no operator key on this node (.agentx/operator.key): nothing is drafted" }
    const sentences = [r.rule_during, r.rule_ending, r.rule_ended, r.note_guidance].filter((v): v is string => !!v)
    let error = ""
    const ok = this.change((s) => {
      // A sentence the approver turned down (or the owner retired) does
      // not come back under another name.
      if (sentences.some((v) => s.no.includes(sentenceHash(v)))) { error = "a sentence of it was turned down or retired before"; return false }
      s.t[id] = { s: "draft", h, n: 0, at: null, by: null, d: null, w: null, rb: null, ra: null }
      this.db.prepare(`INSERT INTO situation_learned_templates (id, base, title, when_text, rule_during, rule_ending, rule_ended, note_guidance, evidence, evidence_summary, why, status, created_at)
        VALUES (@id, @base, @title, @when_text, @rule_during, @rule_ending, @rule_ended, @note_guidance, @evidence, @evidence_summary, @why, @status, @created_at)`).run(r)
      return true
    })
    return ok ? { ok: true, id } : { ok: false, error: error || "the sealed state could not be written" }
  }

  get(id: string): LearnedRow | null {
    const r = this.raw(id)
    return r ? this.toRow(r, this.state()) : null
  }

  /** Newest first. A status filter goes by the sealed state. */
  list(status?: LearnedStatus): LearnedRow[] {
    const s = this.state()
    const rows = this.db.prepare("SELECT * FROM situation_learned_templates ORDER BY created_at DESC, id LIMIT 200").all() as Raw[]
    return rows.map((r) => this.toRow(r, s)).filter((r) => !status || (r.sealed && r.status === status))
  }

  /** Drafts the approver may be asked about now: drafted by the daemon,
   *  unchanged, passing the lint, never answered, not asked too often. */
  reviewable(): LearnedRow[] {
    const s = this.state()
    if (!s) return []
    const now = this.now()
    return (this.db.prepare("SELECT * FROM situation_learned_templates ORDER BY created_at, rowid").all() as Raw[])
      .filter((r) => {
        const e = this.entry(s, r)
        return !!e && e.s === "draft" && lintDraft(this.text(r)).length === 0
          && (e.n === 0 || (e.n < MAX_REVIEW_ATTEMPTS && (e.at ?? 0) <= now - REVIEW_RETRY_MS))
      })
      .map((r) => this.toRow(r, s))
  }

  /** Count a review attempt before the approver is asked. False: the
   *  draft is no longer reviewable (another run took it). */
  startReview(id: string): boolean {
    const now = this.now()
    const r = this.raw(id)
    if (!r) return false
    return this.change((s) => {
      const e = this.entry(s, r)
      if (!e || e.s !== "draft") return false
      if (e.n !== 0 && !(e.n < MAX_REVIEW_ATTEMPTS && (e.at ?? 0) <= now - REVIEW_RETRY_MS)) return false
      e.n += 1
      e.at = now
      this.mirror(id, e)
      return true
    })
  }

  /** The approver's answer, from the review run this daemon started. */
  private decide(id: string, reviewer: string, why: string, to: "active" | "rejected", seen?: LearnedRow): boolean {
    const r = this.raw(id)
    if (!r) return false
    if (seen && learnedContent(this.text(r)) !== learnedContent(seen)) return false
    if (to === "active" && lintDraft(this.text(r)).length) return false
    return this.change((s) => {
      const e = this.entry(s, r)
      if (!e || e.s !== "draft" || e.n === 0) return false
      e.s = to
      e.by = reviewer
      e.d = this.now()
      e.w = oneLine(why, LEARNED_LIMITS.verdictWhy)
      if (to === "rejected") this.remember(s, r)
      this.mirror(id, e)
      return true
    })
  }

  private remember(s: State, r: Raw): void {
    for (const v of [r.rule_during, r.rule_ending, r.rule_ended, r.note_guidance]) {
      if (v && !s.no.includes(sentenceHash(v))) s.no.push(sentenceHash(v))
    }
    if (s.no.length > NO_MAX) s.no = s.no.slice(-NO_MAX)
  }

  /** The approver said yes. Only learn.ts calls this, in the daemon,
   *  with the verdict of the run it started. `seen` is the draft as the
   *  approver read it: a draft changed since is not approved. */
  approve(id: string, reviewer: string, why: string, seen?: LearnedRow): boolean {
    return this.decide(id, reviewer, why, "active", seen)
  }

  /** The approver said no. Sealed and final: it is never asked again. */
  reject(id: string, reviewer: string, why: string): boolean {
    return this.decide(id, reviewer, why, "rejected")
  }

  /** The owner takes an approved template back (or drops a draft). Final. */
  retire(id: string, by: string): boolean {
    const r = this.raw(id)
    return this.change((s) => {
      const e = s.t[id]
      if (!e || (e.s !== "draft" && e.s !== "active")) return false
      e.s = "retired"
      e.rb = oneLine(by, 100)
      e.ra = this.now()
      for (const [sit, t] of Object.entries(s.picks)) if (t === id) delete s.picks[sit]
      if (r) { this.remember(s, r); this.mirror(id, e) }
      return true
    })
  }

  /** The template as it is used: only one the state holds as active,
   *  approved by the approver the owner names now, with its text
   *  unchanged and still passing the lint. Null otherwise. */
  template(id: string): SituationTemplate | null {
    const r = this.raw(id)
    if (!r) return null
    const s = this.state()
    const e = this.entry(s, r)
    if (!s || !e || e.s !== "active" || !e.by || e.by !== s.approver) return null
    const row = this.text(r)
    if (lintDraft(row).length) return null
    const base = situationTemplate(r.base)
    if (!base || base.source === "learned" || !(LEARNED_BASES as readonly string[]).includes(base.id)) return null
    return {
      id: r.id, kind: base.kind, version: 1, source: "learned", title: row.title, rules: row.rules,
      closing: base.closing, agentMay: false, ...(row.noteGuidance ? { noteGuidance: row.noteGuidance } : {}),
    }
  }

  /** Every template that is used now. */
  templates(): SituationTemplate[] {
    return this.list("active").map((r) => this.template(r.id)).filter((t): t is SituationTemplate => !!t)
  }

  /** The owner named this learned template for a talk (the closing route,
   *  owner only). A talk uses a learned template only when picked here:
   *  a template id written onto the talk's row by anything else is not. */
  pick(situationId: string, templateId: string): boolean {
    if (!this.template(templateId)) return false
    return this.change((s) => {
      delete s.picks[situationId]
      s.picks[situationId] = templateId
      const keys = Object.keys(s.picks)
      for (const k of keys.slice(0, Math.max(0, keys.length - PICKS_MAX))) delete s.picks[k]
      return true
    })
  }

  picked(situationId: string, templateId: string): boolean {
    return this.state()?.picks[situationId] === templateId
  }

  /** The owner starts over (operator key, `agentx situation learned
   *  reset`), only when the state cannot be trusted: every draft and
   *  decision is dropped, the approver too. A newer generation than any
   *  seen, so an older copy is still refused. */
  reset(): boolean {
    if (!this.sealKey() || this.problem() === null) return false
    const file = this.readGen()
    const gen = Math.max(this.highGen, file && "gen" in file ? file.gen : 0) + 1
    const s: State = { v: 1, gen, approver: null, lastRun: null, t: {}, no: [], picks: {} }
    const value = JSON.stringify(s)
    const mac = this.mac("state", value)
    if (!mac) return false
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM situation_learned_templates").run()
      this.db.prepare("INSERT INTO situation_learned_settings (name, value, mac) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, mac = excluded.mac")
        .run(STATE_ROW, value, mac)
    })()
    this.highGen = gen
    this.writeGen(gen)
    return true
  }

  /** When the last weekly drafting run started. Unknown (the state
   *  cannot be trusted): now, so no run starts. */
  lastRunAt(): number | null {
    const s = this.state()
    return s ? s.lastRun : this.now()
  }

  /** Book a drafting run, before its model call. False: not booked. */
  recordRun(note: string): boolean {
    const at = this.now()
    const ok = this.change((s) => { s.lastRun = at; return true })
    if (ok) this.db.prepare("INSERT INTO situation_learn_runs (at, note) VALUES (?, ?)").run(at, note.slice(0, 300))
    return ok
  }
}

/** The learned templates as the situations code sees them (templates.ts):
 *  nothing while `on()` is false. */
export function learnedSource(store: LearnedTemplateStore, on: () => boolean): LearnedTemplateSource {
  return {
    get: (id) => (on() ? store.template(id) : null),
    list: () => (on() ? store.templates() : []),
    picked: (situationId, id) => on() && store.picked(situationId, id),
    pick: (situationId, id) => { if (on()) store.pick(situationId, id) },
  }
}
