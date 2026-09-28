// --- Fact freshness: verify-or-ask (#273) ---
//
// The one rule every agent follows about stated facts. A stored fact is a
// note of what was true when it was checked, not ground truth. Each fact
// has a volatility class: account, billing, outage and deploy state change
// on their own and expire after a TTL; names, decisions and paths are
// stable. Past its TTL, an agent re-checks a fact against its source, or
// says it is unverified and asks the owner.
//
// The class replaces slice 1's single keyword regex, which flagged lasting
// notes ("deploy path is …", "wrote it down"). The patterns below match
// statements of *state* ("is past due", "went down", "deployed to"), not
// topics. A fact that carries provenance uses its own class and date.

export type FactClass = "billing" | "account" | "outage" | "deploy" | "work-state" | "stable"

/** Days a fact of each class is trusted without a re-check; null = no expiry. */
export const FACT_TTL_DAYS: Record<FactClass, number | null> = {
  billing: 2, account: 2, outage: 2, deploy: 2, "work-state": 2, stable: null,
}

/** Kept for callers of slice 1. */
export const VOLATILE_TTL_DAYS = 2

export const FACT_CLASSES = Object.keys(FACT_TTL_DAYS) as FactClass[]

export function isFactClass(s: unknown): s is FactClass {
  return typeof s === "string" && (FACT_CLASSES as string[]).includes(s)
}

/** Where a fact came from and when it was last checked. */
export interface Provenance {
  /** A system, URL or command, or "owner said". */
  source: string
  verifiedAt: string
  /** The agent or person who checked it. */
  verifiedBy: string
  volatility: FactClass
  /** Overrides the class TTL. */
  ttlDays?: number
}

const words = (list: string[]) => new RegExp(list.map((w) => `\\b(?:${w})\\b`).join("|"), "i")

const STATE = "is|are|was|were|has been|have been|got|gets|went|goes|go|stays?|still|seems?|now|keeps?"

const PATTERNS: Array<[FactClass, RegExp]> = [
  ["billing", words([
    "past[- ]due", "overdue", "unpaid", "outstanding (?:invoice|balance|payment|bill)s?",
    "invoices? (?:is |are |was |were )?(?:due|unpaid|paid|outstanding|overdue)",
    "payments? (?:has |have )?(?:failed|declined|bounced|due|pending|overdue|received)",
    "(?:credit|account|remaining|wallet|prepaid) balance", "balance (?:is|was|of) [$€£]?\\d",
    "credits? (?:left|remaining|exhausted|used up|ran out|run out)", "out of credits?", "refund(?:ed)?",
    "subscription (?:is |was |has )?(?:active|cancell?ed|expired|lapsed|paused|renew\\w*)",
    "(?:free )?trial (?:ends|ended|expires|expired|period)", "on (?:a |the )?(?:free )?trial",
    "billing (?:issue|problem|error|failed|failure|blocked|hold)",
    "(?:plan|tier) (?:was |is |got )?(?:downgraded|upgraded|cancell?ed)",
    "quota (?:is |was )?(?:exceeded|reached|hit|exhausted)", "rate[- ]limited",
  ])],
  ["account", words([
    "(?:account|api key|key|token|license|licence|certificate|cert|domain|seat)s? " +
      "(?:is |are |was |were |has been |got )?(?:suspended|deactivated|disabled|locked|banned|revoked|expired|inactive|active|closed|frozen|restricted|blocked)",
    "suspended", "deactivated", "locked out", "banned", "revoked",
    "expired", "expir(?:es|ing) (?:on|in|at|soon)",
    `(?:${STATE}) blocked`, "blocked (?:by|on|until|since)",
    "(?:not |un)authori[sz]ed", "credentials? (?:expired|invalid|rejected)",
  ])],
  ["outage", words([
    "outage", `(?:${STATE}) (?:down|offline)`, "down (?:since|for|again)", "offline", "unreachable",
    "not (?:responding|reachable|working)", `(?:${STATE}) (?:broken|failing|crashing|erroring)`,
    "degraded", "5\\d\\d (?:errors?|responses?)",
    `(?:${STATE}) (?:back )?(?:up|online|healthy|operational|reachable)`,
    "(?:up|online|healthy|operational|active) (?:again )?(?:per|via|according to)",
  ])],
  ["deploy", words([
    "(?:re)?deployed", "deploy(?:ment)? (?:failed|succeeded|pending|in progress|rolled back|is (?:done|running|stuck|pending|live))",
    "(?:is|are|now|went|goes) live", "live on", "rolled (?:out|back)",
    "(?:currently|now) running (?:v|version)", "in prod(?:uction)? (?:now|since)",
  ])],
]

/** The class a statement's wording implies. Statements of state, not topics. */
export function classifyFact(text: string): FactClass {
  for (const [cls, re] of PATTERNS) if (re.test(text)) return cls
  return "stable"
}

const STABLE_ATTR = /\b(?:path|target|url|host|owner|name|email|phone|handle|id|role|decision|decided|policy)\b/i
const ATTR_CLASS: Array<[FactClass, RegExp]> = [
  ["billing", /\b(?:billing|payment|invoice|plan|subscription|credits?|balance|quota)\b/i],
  ["account", /\b(?:account|access|licen[cs]e|key|token)\b/i],
  ["outage", /\b(?:status|uptime|health|outage|availability)\b/i],
  ["deploy", /\b(?:deploy(?:ment)?|version|release)\b/i],
]

/** Class for a structured fact: its wording first, then what it is about. */
export function classifyAttribute(attribute: string, statement = ""): FactClass {
  const worded = classifyFact(statement)
  if (worded !== "stable") return worded
  if (STABLE_ATTR.test(attribute)) return "stable"
  for (const [cls, re] of ATTR_CLASS) if (re.test(attribute)) return cls
  return "stable"
}

export function ttlOf(p: { volatility: FactClass; ttlDays?: number }): number | null {
  return typeof p.ttlDays === "number" && p.ttlDays >= 0 ? p.ttlDays : FACT_TTL_DAYS[p.volatility]
}

/** Whole days since `iso`; null when unreadable. */
export function daysSince(iso: string | undefined, now = Date.now()): number | null {
  const t = Date.parse(iso ?? "")
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null
}

/** A checked fact past its TTL, or one whose check date is unreadable. */
export function isPastTtl(p: { volatility: FactClass; ttlDays?: number; verifiedAt?: string }, now = Date.now()): boolean {
  const ttl = ttlOf(p)
  if (ttl === null) return false
  const age = daysSince(p.verifiedAt, now)
  return age === null || age >= ttl
}

// --- Memory-shaped facts ---

export interface FreshnessFields {
  content: string
  createdAt: string
  source: { sender: string }
  provenance?: Partial<Provenance>
  /** Set by the one-off migration: stated with no source. */
  unverified?: { since: string; reason: string }
}

/** Session summaries are work state whatever they say. */
export function factClassOf(f: FreshnessFields): FactClass {
  if (isFactClass(f.provenance?.volatility)) return f.provenance!.volatility!
  if (f.source.sender === "system:rotation") return "work-state"
  return classifyFact(f.content)
}

export function isVolatile(f: FreshnessFields): boolean {
  return factClassOf(f) !== "stable"
}

/** Days since the fact was last checked (or written, when never checked). */
export function ageDays(f: FreshnessFields, now = Date.now()): number | null {
  return daysSince(f.provenance?.verifiedAt ?? f.createdAt, now)
}

export function needsRecheck(f: FreshnessFields, now = Date.now()): boolean {
  if (f.unverified) return true
  return isPastTtl({
    volatility: factClassOf(f),
    ttlDays: f.provenance?.ttlDays,
    verifiedAt: f.provenance?.verifiedAt ?? f.createdAt,
  }, now)
}

/** The rule injected with every memory block that holds a flagged line. */
export const VERIFY_OR_ASK_RULE =
  "[These are notes, not checked facts. Before you state one marked UNVERIFIED to a person or act on it, " +
  "re-check it against its source (API, CLI, dashboard) and record it with `agentx wiki facts set`. " +
  "If you can't, say it is unverified and ask the owner.]"

// --- Session summaries ---

/**
 * Split a rotation or continuity memo into work state (what the session
 * was doing) and claims about outside systems. Claims leave the memo for
 * the wiki's proposal queue; only work state is kept as memory.
 */
export function splitMemo(memo: string): { workState: string[]; claims: string[] } {
  const workState: string[] = []
  const claims: string[] = []
  for (const raw of memo.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const text = line.replace(/^[-*•]\s*/, "")
    // A line citing a check is a claim about an outside system: the memo
    // prompt only lets a summary cite checks for those.
    const claim = classifyFact(text) !== "stable" || citedCheck(text) !== null
    ;(claim ? claims : workState).push(line)
  }
  return { workState, claims }
}

/** The check a memo line cites, e.g. "active per GET /v1/user, 2026-09-28". */
export function citedCheck(line: string): { source: string; verifiedAt?: string } | null {
  const m = line.match(/\b(?:per|via|according to|checked (?:with|via|using))\s+([^,;()]+?)(?:,\s*(\d{4}-\d{2}-\d{2}))?\s*(?:[;)]|$)/i)
  if (!m) return null
  return { source: m[1].trim(), ...(m[2] ? { verifiedAt: `${m[2]}T00:00:00.000Z` } : {}) }
}
