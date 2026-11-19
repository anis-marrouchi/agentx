import type Database from "better-sqlite3"
import { createHmac, timingSafeEqual } from "crypto"
import { LEARNED_PREFIX, oneLine, situationTemplate, type SituationTemplate } from "./templates"

// --- Learned templates: the one home of drafts and approvals (#1892 phase 8) ---
//
// The weekly `situation-learn` run (learn.ts) drafts templates from ended
// talks. Each draft lives here, in the daemon's SQLite file, with its
// status: draft → active (the approver said yes) or rejected (no), and
// active → retired (the owner took it back). Nothing else holds them.
//
// What a learned template may carry, and only this (a fixed schema, the
// columns below): a title, a "when" line, one prompt rule per phase and
// one line of closing-note guidance, on top of a base template from the
// hand-written catalog. It never carries a code gate, an outward send, a
// note home or promise owners: there is no column for them, and the lint
// refuses text that asks for them. Its closing steps are the base's.
//
// Agents run as the same user and can write this file. So a status is
// not proof:
//   - a draft counts only with its draft seal, written when the daemon
//     drafted it;
//   - an active row counts only with its approval seal, written when the
//     approver's own review run (started by the daemon, learn.ts) said
//     yes, over the exact text it read.
// Both seals are HMACs under a key derived from the operator key
// (.agentx/operator.key, which the guard keeps agents from reading,
// #1979). A row an agent wrote or changed has no valid seal and is never
// reviewed or used. No operator key: nothing is drafted or used.

export const LEARNED_BASES = ["meeting", "meeting.external", "job.production", "hand-off"] as const
export type LearnedBase = (typeof LEARNED_BASES)[number]

export const LEARNED_LIMITS = { slug: 40, title: 60, when: 160, rule: 200, guidance: 200, why: 300, verdictWhy: 300 } as const

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
  /** The daemon drafted it (its draft seal checks out). */
  sealed: boolean
}

/** Text a learned template may not hold. Each pattern names what it
 *  guards: the template adds sentences, nothing else. */
const LINT: Array<[RegExp, string]> = [
  [/https?:|www\.|\b[\w-]+\.(?:com|net|org|io|dev|app|tn|fr|de|uk)\b/i, "a link"],
  [/@/, "an address or handle"],
  [/\d{3,}/, "a number"],
  [/["`{}<>$\\|]|\[\[/, "quotes, code or markup"],
  [/\b(?:send|sends|sent|post|posts|posted|publish|forward|e-?mail|dm|sms|whatsapp|telegram|slack|discord|notify|text them|call them|call back|webhook|curl)\b/i, "a send to anyone"],
  [/\b(?:issue|merge request|pull request|ticket|wiki|repo|repository|home)\b/i, "a note home"],
  [/\b(?:assign|assigned|owned by|owner is|owners are|promise (?:to|for)|due (?:on|by))\b/i, "a promise owner or due time"],
  [/\b(?:ignore|disregard|override|bypass|instruction|instructions|system prompt|prompt|the owner (?:says|said|wants|asks|told)|operator|daemon|agentx|tool|tools|approve|approval|gate|permission|secret|password|token|key)\b/i, "an instruction to the system"],
]

/** Why this learned text is refused, or null when it may be used. */
export function lintLearnedText(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim()
  if (!t) return "empty"
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
export function lintDraft(d: Pick<LearnedDraft, "title" | "when" | "rules" | "noteGuidance">): string[] {
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
  if (!d.rules.during && !d.rules.ending && !d.rules.ended && !d.noteGuidance) out.push("no rule and no guidance")
  return out
}

/** What a reviewer reads of a draft, to tell whether it changed since. */
export function learnedContent(r: Pick<LearnedRow, "id" | "base" | "title" | "when" | "rules" | "noteGuidance" | "evidence">): string {
  return JSON.stringify([r.id, r.base, r.title, r.when, r.rules.during ?? "", r.rules.ending ?? "", r.rules.ended ?? "", r.noteGuidance, r.evidence])
}

type Raw = {
  id: string; base: string; title: string; when_text: string; rule_during: string | null; rule_ending: string | null; rule_ended: string | null
  note_guidance: string | null; evidence: string; why: string; status: LearnedStatus; created_at: number; draft_mac: string | null
  review_attempts: number; last_review_at: number | null; reviewer: string | null; verdict_why: string | null; decided_at: number | null
  approval_mac: string | null; retired_at: number | null; retired_by: string | null
}

/** A review may be tried again only this long after a failed one, and
 *  at most this many times in all: asking again cannot reroll a no. */
export const REVIEW_RETRY_MS = 6 * 24 * 3600_000
export const MAX_REVIEW_ATTEMPTS = 2

export class LearnedTemplateStore {
  private readonly now: () => number

  constructor(private readonly db: Database.Database, private readonly opts: { key: () => string | null; now?: () => number }) {
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
        why TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        draft_mac TEXT,
        review_attempts INTEGER NOT NULL DEFAULT 0,
        last_review_at INTEGER,
        reviewer TEXT,
        verdict_why TEXT,
        decided_at INTEGER,
        approval_mac TEXT,
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
    return k ? createHmac("sha256", k).update("agentx situations.learned v1").digest() : null
  }

  /** Can this node seal (it has an operator key)? */
  canSeal(): boolean {
    return !!this.sealKey()
  }

  private seal(kind: "draft" | "active", r: Raw, extra: string): string | null {
    const key = this.sealKey()
    if (!key) return null
    const content = JSON.stringify([r.id, r.base, r.title, r.when_text, r.rule_during ?? "", r.rule_ending ?? "", r.rule_ended ?? "", r.note_guidance ?? "", r.evidence])
    return createHmac("sha256", key).update(`${kind}\n${content}\n${extra}`).digest("hex")
  }

  private sealMatches(kind: "draft" | "active", r: Raw, extra: string, given: string | null): boolean {
    const want = this.seal(kind, r, extra)
    if (!want || !given || given.length !== want.length) return false
    return timingSafeEqual(Buffer.from(given), Buffer.from(want))
  }

  /** The draft seal also covers how often the approver was asked: each
   *  ask re-seals it, so setting the count back (to ask again after a
   *  no) breaks the seal and the draft is never asked or used again. */
  private draftSealed(r: Raw): boolean {
    return this.sealMatches("draft", r, `${r.created_at}\n${r.review_attempts}`, r.draft_mac)
  }

  private approvalSealed(r: Raw): boolean {
    return r.status === "active" && !!r.reviewer && r.decided_at !== null
      && this.draftSealed(r) && this.sealMatches("active", r, `${r.reviewer}\n${r.decided_at}`, r.approval_mac)
  }

  // --- The approver: set by the owner with the operator key, sealed ---
  //
  // Not a setting in agentx.json, which agents can edit: the owner names
  // it with `agentx situation learned approver <agent>` (operator key).
  // A template is used only while its sealed reviewer is still the
  // sealed approver.

  private settingMac(name: string, value: string): string | null {
    const key = this.sealKey()
    return key ? createHmac("sha256", key).update(`setting\n${name}\n${value}`).digest("hex") : null
  }

  /** Name the approver (owner only: the route checks the operator key).
   *  Null clears it. */
  setApprover(agentId: string | null): boolean {
    if (agentId === null) { this.db.prepare("DELETE FROM situation_learned_settings WHERE name = 'approver'").run(); return true }
    const mac = this.settingMac("approver", agentId)
    if (!mac) return false
    this.db.prepare("INSERT INTO situation_learned_settings (name, value, mac) VALUES ('approver', ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, mac = excluded.mac")
      .run(agentId, mac)
    return true
  }

  /** The approver the owner named, or null (none, or its seal is wrong). */
  approver(): string | null {
    const r = this.db.prepare("SELECT value, mac FROM situation_learned_settings WHERE name = 'approver'").get() as { value: string; mac: string } | undefined
    if (!r) return null
    const want = this.settingMac("approver", r.value)
    if (!want || r.mac?.length !== want.length || !timingSafeEqual(Buffer.from(r.mac), Buffer.from(want))) return null
    return r.value
  }

  private raw(id: string): Raw | null {
    return (this.db.prepare("SELECT * FROM situation_learned_templates WHERE id = ?").get(id) as Raw | undefined) ?? null
  }

  private toRow(r: Raw): LearnedRow {
    let evidence: string[] = []
    try { const v = JSON.parse(r.evidence); if (Array.isArray(v)) evidence = v.filter((x): x is string => typeof x === "string") } catch { evidence = [] }
    return {
      id: r.id, base: r.base, title: r.title, when: r.when_text,
      rules: { ...(r.rule_during ? { during: r.rule_during } : {}), ...(r.rule_ending ? { ending: r.rule_ending } : {}), ...(r.rule_ended ? { ended: r.rule_ended } : {}) },
      noteGuidance: r.note_guidance ?? "", evidence, why: r.why, status: r.status, createdAt: r.created_at,
      reviewAttempts: r.review_attempts, lastReviewAt: r.last_review_at, reviewer: r.reviewer, verdictWhy: r.verdict_why,
      decidedAt: r.decided_at, retiredAt: r.retired_at, retiredBy: r.retired_by, sealed: this.draftSealed(r),
    }
  }

  /** Write a draft the daemon made. Refused without the operator key, for
   *  an id used before (in any status) or for text the lint refuses. */
  addDraft(d: LearnedDraft): { ok: true; id: string } | { ok: false; error: string } {
    if (!this.sealKey()) return { ok: false, error: "no operator key on this node (.agentx/operator.key): nothing is drafted" }
    if (!(LEARNED_BASES as readonly string[]).includes(d.base)) return { ok: false, error: `base must be one of ${LEARNED_BASES.join(", ")}` }
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(d.slug)) return { ok: false, error: "slug must be lower-case letters, digits and dashes" }
    const lint = lintDraft(d)
    if (lint.length) return { ok: false, error: lint.join("; ") }
    const id = `${LEARNED_PREFIX}${d.slug}`
    if (this.raw(id)) return { ok: false, error: `${id} was drafted before` }
    // A sentence the approver turned down (or the owner retired) does not
    // come back under another name.
    const said = new Set<string>()
    for (const old of this.db.prepare("SELECT rule_during, rule_ending, rule_ended, note_guidance FROM situation_learned_templates WHERE status IN ('rejected', 'retired')").all() as Array<Record<string, string | null>>) {
      for (const v of Object.values(old)) if (v) said.add(v.toLowerCase())
    }
    const again = [d.rules.during, d.rules.ending, d.rules.ended, d.noteGuidance].find((v) => v && said.has(oneLine(v, 1000).toLowerCase()))
    if (again) return { ok: false, error: "a sentence of it was turned down or retired before" }
    const r: Raw = {
      id, base: d.base, title: oneLine(d.title, LEARNED_LIMITS.title), when_text: oneLine(d.when, LEARNED_LIMITS.when),
      rule_during: d.rules.during ? oneLine(d.rules.during, LEARNED_LIMITS.rule) : null,
      rule_ending: d.rules.ending ? oneLine(d.rules.ending, LEARNED_LIMITS.rule) : null,
      rule_ended: d.rules.ended ? oneLine(d.rules.ended, LEARNED_LIMITS.rule) : null,
      note_guidance: d.noteGuidance ? oneLine(d.noteGuidance, LEARNED_LIMITS.guidance) : null,
      evidence: JSON.stringify([...new Set(d.evidence)].slice(0, 50)), why: oneLine(d.why, LEARNED_LIMITS.why),
      status: "draft", created_at: this.now(), draft_mac: null, review_attempts: 0, last_review_at: null, reviewer: null,
      verdict_why: null, decided_at: null, approval_mac: null, retired_at: null, retired_by: null,
    }
    r.draft_mac = this.seal("draft", r, `${r.created_at}\n0`)
    this.db.prepare(`INSERT INTO situation_learned_templates (id, base, title, when_text, rule_during, rule_ending, rule_ended, note_guidance, evidence, why, status, created_at, draft_mac)
      VALUES (@id, @base, @title, @when_text, @rule_during, @rule_ending, @rule_ended, @note_guidance, @evidence, @why, @status, @created_at, @draft_mac)`).run(r)
    return { ok: true, id }
  }

  get(id: string): LearnedRow | null {
    const r = this.raw(id)
    return r ? this.toRow(r) : null
  }

  /** Newest first. */
  list(status?: LearnedStatus): LearnedRow[] {
    const rows = (status
      ? this.db.prepare("SELECT * FROM situation_learned_templates WHERE status = ? ORDER BY created_at DESC, id LIMIT 200").all(status)
      : this.db.prepare("SELECT * FROM situation_learned_templates ORDER BY created_at DESC, id LIMIT 200").all()) as Raw[]
    return rows.map((r) => this.toRow(r))
  }

  /** Drafts the approver may be asked about now: sealed by the daemon,
   *  passing the lint, never answered, and not asked too often. */
  reviewable(): LearnedRow[] {
    const now = this.now()
    return (this.db.prepare("SELECT * FROM situation_learned_templates WHERE status = 'draft' ORDER BY created_at, rowid").all() as Raw[])
      .filter((r) => this.draftSealed(r) && lintDraft(this.toRow(r)).length === 0)
      .filter((r) => r.review_attempts === 0 || (r.review_attempts < MAX_REVIEW_ATTEMPTS && (r.last_review_at ?? 0) <= now - REVIEW_RETRY_MS))
      .map((r) => this.toRow(r))
  }

  /** Count a review attempt before the approver is asked. False: the
   *  draft is no longer reviewable (another run took it). */
  startReview(id: string): boolean {
    const now = this.now()
    const r = this.raw(id)
    if (!r || r.status !== "draft" || !this.draftSealed(r)) return false
    if (r.review_attempts !== 0 && !(r.review_attempts < MAX_REVIEW_ATTEMPTS && (r.last_review_at ?? 0) <= now - REVIEW_RETRY_MS)) return false
    const next = { ...r, review_attempts: r.review_attempts + 1 }
    const mac = this.seal("draft", next, `${r.created_at}\n${next.review_attempts}`)
    return this.db.prepare(`UPDATE situation_learned_templates SET review_attempts = ?, last_review_at = ?, draft_mac = ?
      WHERE id = ? AND status = 'draft' AND review_attempts = ? AND draft_mac = ?`)
      .run(next.review_attempts, now, mac, id, r.review_attempts, r.draft_mac).changes > 0
  }

  /** The approver said yes in its review run. Only learn.ts calls this,
   *  in the daemon, with the verdict of the run it started. `seen` is the
   *  draft as the approver read it: a draft changed since is not approved. */
  approve(id: string, reviewer: string, why: string, seen?: LearnedRow): boolean {
    const r = this.raw(id)
    if (!r || r.status !== "draft" || !this.draftSealed(r) || lintDraft(this.toRow(r)).length) return false
    if (seen && learnedContent(this.toRow(r)) !== learnedContent(seen)) return false
    const decidedAt = this.now()
    const mac = this.seal("active", r, `${reviewer}\n${decidedAt}`)
    if (!mac) return false
    return this.db.prepare(`UPDATE situation_learned_templates SET status = 'active', reviewer = ?, verdict_why = ?, decided_at = ?, approval_mac = ?
      WHERE id = ? AND status = 'draft' AND draft_mac = ?`).run(reviewer, oneLine(why, LEARNED_LIMITS.verdictWhy), decidedAt, mac, id, r.draft_mac).changes > 0
  }

  /** The approver said no. A no needs no seal: it only keeps a draft out. */
  reject(id: string, reviewer: string, why: string): boolean {
    return this.db.prepare(`UPDATE situation_learned_templates SET status = 'rejected', reviewer = ?, verdict_why = ?, decided_at = ?
      WHERE id = ? AND status = 'draft'`).run(reviewer, oneLine(why, LEARNED_LIMITS.verdictWhy), this.now(), id).changes > 0
  }

  /** The owner takes an approved template back (or drops a draft). */
  retire(id: string, by: string): boolean {
    return this.db.prepare(`UPDATE situation_learned_templates SET status = 'retired', retired_at = ?, retired_by = ?
      WHERE id = ? AND status IN ('draft', 'active')`).run(this.now(), oneLine(by, 100), id).changes > 0
  }

  /** The template as it is used: only an active row whose seals check
   *  out and whose text still passes the lint. Null otherwise. */
  template(id: string): SituationTemplate | null {
    const r = this.raw(id)
    if (!r || !this.approvalSealed(r) || r.reviewer !== this.approver()) return null
    const row = this.toRow(r)
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

  /** When the last weekly drafting run started. */
  lastRunAt(): number | null {
    const r = this.db.prepare("SELECT MAX(at) AS at FROM situation_learn_runs").get() as { at: number | null }
    return r.at ?? null
  }

  /** Book a drafting run, before its model call. */
  recordRun(note: string): void {
    this.db.prepare("INSERT INTO situation_learn_runs (at, note) VALUES (?, ?)").run(this.now(), note.slice(0, 300))
  }
}
