// --- Rule pages: one page per obligation, with deadline, penalty, source and check date (#811) ---
//
// Agents research the same rule again and again (a filing deadline, a
// late fee) because the answer stays inside the page or chat where it
// came up. This job reads the pages that state rules: legal sources,
// obligation pages agents wrote, and any other page whose text speaks of
// deadlines, penalties or filings. One model call per source page
// returns the rules it states. Each rule is checked against what the
// call was shown, then written once as an obligation page:
//   - statements for the obligation lens (action, bearer, due, amount,
//     authority, created by, procedure), each with its source and the
//     date of that source, marked proposed until the owner confirms them;
//   - a penalty page linked to it with `penalty_for`;
//   - `subject_to` on the page of each person or organization that must
//     follow it, so their Obligations panel lists it.
// A later source that states less keeps what an earlier one stated: a
// field is replaced only when the new source gives it. The model gets no
// tools and every write goes through the store, which keeps the old version.

import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { WikiHub } from "./hub"
import type { WikiArticleMeta, WikiEntry } from "./types"
import { normName, slugify, type Entity, type GraphPage, type WikiGraph } from "./ontology/graph"
import type { WikiStatement } from "./ontology/types"
import { bodyOf } from "./ontology/view-entity"
import { parseEnrichReply, readableAlongside, targetPage, withOverview, type EnrichCall } from "./enrich"

export const RULES_BY = "wiki-rules"
/** Tag on the pages this job creates; they are never read as a source. */
export const RULES_TAG = "wiki-rules"

/** Words that mark a page as stating a rule. Stems, matched at a word start. */
export const DEFAULT_RULE_WORDS = [
  "deadline", "due date", "due by", "penalt", "late fee", "fine of", "fined", "must file", "must pay", "must declare",
  "must submit", "filing", "obligation", "compliance", "tax return",
  "échéance", "date limite", "délai", "pénalit", "amende", "majoration", "déclaration", "obligation",
  "غرامة", "أجل", "آجال", "تصريح", "خطية",
]

/** Types never read as a rule source: things that happen or run, not rules. */
const SKIP_TYPES = new Set(["event", "agent", "device", "server", "app", "domain", "account", "penalty", "relief", "due_date", "person"])
/** Types a rule's bearer may link to; anything else stays text. */
const BEARER_TYPES = new Set(["person", "organization"])

const PAGE_CHARS = 6000
const ENTRY_CHARS = 900
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "")
/** Frontmatter keeps a title on one quoted line. */
const cleanTitle = (s: string) => str(s).replace(/["\[\]]/g, "").slice(0, 120).trim()

export function ruleWordsPattern(words: string[] = DEFAULT_RULE_WORDS): RegExp {
  const escaped = words.map(w => w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean)
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped.join("|")})`, "iu")
}

export interface RulesContext {
  /** The entity whose page is read. */
  source: Entity
  page: GraphPage
  entries: WikiEntry[]
  /** Obligation pages that already exist, so a known rule is updated, not doubled. */
  known: Entity[]
  /** Legal source pages a rule may cite as its basis. */
  laws: Entity[]
  /** People and organizations the page links or names. */
  parties: Entity[]
  /** Organizations a rule may name as its authority. */
  authorities: Entity[]
}

export interface RuleDraft {
  title: string
  /** Set when the rule matches an existing obligation page. */
  existing?: Entity
  action: string
  bearers: string[]
  deadline: string
  amount: string
  authority: string
  penalty: string
  basis: string
  procedure: string
  source: string
}

export interface RulesResult {
  rules: RuleDraft[]
  dropped: string[]
}

/** True when the page reads like it states a rule. */
export function statesRules(page: GraphPage, words: RegExp): boolean {
  return words.test(`${page.article.meta.title}\n${bodyOf(page.article.content)}`)
}

/**
 * Entities whose page this job reads: legal sources and obligation pages
 * first, then any other page whose text matches the rule words. Pages
 * this job created are skipped.
 */
export function ruleSources(g: WikiGraph, words: RegExp, only: string[] = []): Entity[] {
  const wanted = new Set(only.map(normName))
  const ours = (e: Entity) => e.pages.every(p => (p.article.meta.tags ?? []).includes(RULES_TAG))
  const rank = (e: Entity) => (e.type === "legal_source" ? 0 : e.type === "obligation" ? 1 : 2)
  return [...g.entities.values()]
    .filter(e => !ours(e))
    .filter(e => wanted.size
      ? wanted.has(normName(e.id)) || wanted.has(normName(e.title))
      : e.type === "legal_source" || e.type === "obligation" || (!SKIP_TYPES.has(e.type) && e.pages.some(p => statesRules(p, words))))
    .sort((a, b) => rank(a) - rank(b) || b.sources.length - a.sources.length || a.title.localeCompare(b.title))
}

/** Entities of a type whose title appears in the text, or linked to `e`. */
function partiesOf(g: WikiGraph, e: Entity, text: string, types: Set<string>): Entity[] {
  const hay = ` ${normName(text)} `
  const linked = new Set([...(g.outgoing.get(e.id) ?? []).map(x => x.to), ...(g.incoming.get(e.id) ?? []).map(x => x.from)])
  return [...g.entities.values()]
    .filter(x => types.has(x.type) && x.id !== e.id)
    .filter(x => linked.has(x.id) || (normName(x.title).length >= 3 && hay.includes(` ${normName(x.title)} `)))
    .slice(0, 40)
}

/** What one call for `source` may read: its page and the entries behind it. */
export function rulesContext(g: WikiGraph, source: Entity, page: GraphPage, readEntries: (ids: string[]) => WikiEntry[]): RulesContext {
  const text = `${page.article.meta.title}\n${bodyOf(page.article.content)}`
  const entries = readEntries(page.article.meta.sources ?? []).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10)
  const all = `${text}\n${entries.map(x => x.content).join("\n")}`
  const visible = (x: Entity) => x.pages.some(p => readableAlongside(p.article.meta, page.article.meta))
  const of = (type: string) => [...g.entities.values()].filter(x => x.type === type && x.id !== source.id && visible(x))
  return {
    source,
    page,
    entries,
    known: of("obligation").slice(0, 60),
    laws: of("legal_source").slice(0, 40),
    parties: partiesOf(g, source, all, BEARER_TYPES).filter(visible),
    authorities: partiesOf(g, source, all, new Set(["organization"])).filter(visible),
  }
}

/** Changes when the source page's text or the entries behind it change.
 *  A `subject_to` link this job adds to the page does not change it. */
export function rulesFingerprint(page: GraphPage): string {
  const parts = [`${page.agentId}/${page.article.path}`, bodyOf(page.article.content), ...(page.article.meta.sources ?? []).slice().sort()]
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16)
}

function knownLine(g: WikiGraph, e: Entity): string {
  const facts = e.statements.filter(s => ["action", "due_rule"].includes(s.property)).map(s => `${s.property}: ${s.value}`)
  return `- ${e.title}${facts.length ? ` (${facts.join("; ")})` : ""}`
}

export function buildRulesPrompt(g: WikiGraph, ctx: RulesContext, today: string): string {
  const p = ctx.page
  const lines = [
    `You are writing the rules one wiki page states, so nobody has to research them again. Today is ${today}.`,
    "",
    `## The page: ${p.agentId}/${p.article.path}: "${p.article.meta.title}"`,
    clip(bodyOf(p.article.content), PAGE_CHARS),
    "",
    "## Source entries behind the page (newest first)",
  ]
  for (const en of ctx.entries) lines.push(`### entry ${en.id} (${en.date}, ${en.agentId})`, clip(en.content.trim(), ENTRY_CHARS), "")
  lines.push("## Rule pages that already exist", ...ctx.known.map(e => knownLine(g, e)), "")
  lines.push("## Legal source pages", ...ctx.laws.map(e => `- ${e.title}`), "")
  lines.push("## People and organizations it names", ...ctx.parties.map(e => `- ${e.title} (${e.type})`), "")
  lines.push(
    "## Task",
    "List each rule the page or the entries state: something a person or organization must do, by a deadline or on a schedule, often with a penalty when they do not.",
    "Return one JSON object and nothing else:",
    `{"rules": [{"title": "…", "action": "…", "bearer": ["…"], "deadline": "…", "amount": "…", "authority": "…", "penalty": "…", "basis": "…", "procedure": "…", "source": "…"}]}`,
    "",
    "Rules:",
    "- title: a short name for the rule, such as \"Monthly payroll tax filing\". When it is one of the rule pages that already exist, use that title exactly.",
    "- action: what must be done, in one sentence. A rule without one is dropped.",
    "- bearer: who must do it. Use a listed person or organization title when it is one, else a short description such as \"every employer\".",
    "- deadline: when, as the rule says it (\"by the 15th of the following month\"), not a computed date.",
    "- amount: what is paid or declared, if the rule says. authority: who it is filed with or paid to.",
    "- penalty: what happens when it is late or missing, as stated.",
    "- basis: the law, article or document it comes from. Use a listed legal source title when it is one.",
    "- procedure: how it is done, in one sentence, if stated.",
    "- source: the entry id or the page (agent/path) the rule comes from. A rule without one is dropped.",
    "- Leave a field empty when the page and entries do not state it. Never guess a deadline, an amount or a penalty.",
    "- Do not list one-time tasks, reminders or plans; only standing rules.",
    "- Write in the language the page is written in.",
    "- No rules on the page: return {\"rules\": []}.",
  )
  return lines.join("\n")
}

/** Keep only rules with an action and a source the call was shown. */
export function checkRules(raw: Record<string, unknown>, ctx: RulesContext, g: WikiGraph): RulesResult {
  const dropped: string[] = []
  const p = ctx.page
  const sourceIds = [...ctx.entries.map(x => x.id), `${p.agentId}/${p.article.path}`, p.article.path]
  const known = new Map(ctx.known.map(e => [normName(e.title), e]))
  const rules: RuleDraft[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(raw.rules) ? raw.rules : []) {
    const r = (item ?? {}) as Record<string, unknown>
    const title = cleanTitle(str(r.title))
    const action = clip(str(r.action), 400)
    const source = str(r.source)
    if (!title) { dropped.push("a rule with no title"); continue }
    if (!action) { dropped.push(`${title}: no action`); continue }
    if (!source || !sourceIds.some(id => source.includes(id))) { dropped.push(`${title}: source not among those given`); continue }
    if (seen.has(normName(title))) continue
    seen.add(normName(title))
    const existing = known.get(normName(title))
    const taken = g.names.get(normName(title))
    const clash = !existing && taken ? g.entities.get(taken) : undefined
    if (clash && clash.type !== "obligation") { dropped.push(`${title}: a page of type ${clash.type} already has this title`); continue }
    const bearers = (Array.isArray(r.bearer) ? r.bearer : [r.bearer]).map(b => clip(str(b), 120)).filter(Boolean)
    rules.push({
      title: existing?.title ?? clash?.title ?? title,
      existing: existing ?? clash,
      action,
      bearers: [...new Set(bearers)].slice(0, 5),
      deadline: clip(str(r.deadline), 200),
      amount: clip(str(r.amount), 200),
      authority: clip(str(r.authority), 120),
      penalty: clip(str(r.penalty), 300),
      basis: clip(str(r.basis), 200),
      procedure: clip(str(r.procedure), 400),
      source: clip(source, 200),
    })
  }
  return { rules, dropped }
}

/** The title of a listed page when `value` names one, else the value. */
function asPage(value: string, list: Entity[]): string {
  const hit = list.find(e => normName(e.title) === normName(value))
  return hit?.title ?? value
}

/**
 * The date of what the rule was read from: the entry it cites, else the
 * newest entry behind the page, else the day the page was created. Never
 * the run date: nothing was checked at the law or the authority.
 */
export function sourceDate(r: Pick<RuleDraft, "source">, ctx: RulesContext): string | undefined {
  const day = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : undefined)
  const cited = ctx.entries.filter(x => r.source.includes(x.id)).map(x => day(x.date)).filter(Boolean).sort()
  return cited.at(-1) ?? day(ctx.entries[0]?.date) ?? day(ctx.page.article.meta.created)
}

/** Statements an obligation page gets for one rule, proposed until the owner confirms them. */
export function ruleStatements(r: RuleDraft, ctx: RulesContext): WikiStatement[] {
  const checked = sourceDate(r, ctx)
  const st = (property: string, value: string): WikiStatement => ({
    property, value, source: r.source, ...(checked ? { checked_at: checked } : {}), status: "proposed", by: RULES_BY,
  })
  const out = [st("action", r.action)]
  for (const b of r.bearers) out.push(st("bearer", asPage(b, ctx.parties)))
  if (r.deadline) out.push(st("due_rule", r.deadline))
  if (r.amount) out.push(st("amount_rule", r.amount))
  if (r.authority) out.push(st("authority", asPage(r.authority, ctx.authorities)))
  out.push(st("created_by", r.basis ? asPage(r.basis, ctx.laws) : ctx.page.article.meta.title))
  if (r.procedure) out.push(st("procedure", r.procedure))
  return out
}

/** Properties a rule holds one value of; `bearer` may hold several. */
const SINGLE = new Set(["action", "due_rule", "amount_rule", "authority", "created_by", "procedure"])

/**
 * This job's statements for a rule after reading one more source: a
 * field the new source states replaces the earlier one; a field it leaves
 * empty keeps the earlier value with its own source and date. A basis the
 * new source does not name (`created_by` set to the page read) does not
 * replace a law an earlier source named. Bearers add up.
 */
export function mergeRuleStatements(earlier: WikiStatement[], fresh: WikiStatement[], r: Pick<RuleDraft, "basis">): WikiStatement[] {
  const prev = earlier.filter(s => s.by === RULES_BY)
  const stated = new Set(fresh.filter(s => s.property !== "created_by" || r.basis || !prev.some(p => p.property === "created_by")).map(s => s.property))
  const out = fresh.filter(s => stated.has(s.property))
  for (const s of prev) {
    if (SINGLE.has(s.property) ? !stated.has(s.property) : !out.some(o => o.property === s.property && normName(o.value) === normName(s.value))) out.push(s)
  }
  return out
}

/** Statements merged in: this job's earlier ones replaced, others kept. A
 *  statement the owner confirmed stays, and wins over a new value. */
export function withRuleStatements(meta: WikiArticleMeta, statements: WikiStatement[], today: string): WikiArticleMeta {
  const kept = (meta.statements ?? []).filter(s => s.by !== RULES_BY || s.status === "confirmed")
  const confirmed = new Set(kept.filter(s => s.status === "confirmed" && SINGLE.has(s.property)).map(s => s.property))
  const key = (s: WikiStatement) => `${s.property}\n${normName(s.value)}`
  const taken = new Set(kept.map(key))
  const all = [...kept, ...statements.filter(s => !confirmed.has(s.property) && !taken.has(key(s)))]
  return { ...meta, statements: all.length ? all : undefined, lastUpdated: today }
}

/** A penalty as stated, with where it was read and that source's date. */
export interface PenaltyFact {
  value: string
  source?: string
  checked_at?: string
}

const missing = "not found in the sources yet"

/** The plain-words summary at the top of an obligation page, built from
 *  the statements the page holds after the merge. */
export function ruleOverview(statements: WikiStatement[], penalty: PenaltyFact | undefined, readFrom: string): string {
  const all = (p: string) => statements.filter(s => s.property === p)
  const one = (p: string) => statements.find(s => s.property === p)
  const action = one("action")
  // A field read from another source than the action says which.
  const from = (s?: { source?: string; checked_at?: string }) =>
    s && s.source && s.source !== action?.source ? ` (from ${s.source}${s.checked_at ? `, ${s.checked_at}` : ""})` : ""
  const line = (label: string, s?: WikiStatement) => `- **${label}:** ${s ? `${s.value}${from(s)}` : missing}`
  const sources = [...new Set([...statements, ...(penalty ? [penalty] : [])].map(s => s.source).filter((x): x is string => !!x))]
  const dates = [...statements.filter(s => ["action", "due_rule"].includes(s.property)), ...(penalty ? [penalty] : [])]
    .map(s => s.checked_at).filter((x): x is string => !!x).sort()
  const basis = one("created_by")?.value
  return [
    line("What to do", action),
    `- **Who:** ${all("bearer").length ? all("bearer").map(s => s.value).join(", ") : missing}`,
    line("Deadline", one("due_rule")),
    ...(one("amount_rule") ? [line("Amount", one("amount_rule"))] : []),
    ...(one("authority") ? [line("Filed with", one("authority"))] : []),
    `- **Penalty:** ${penalty ? `${penalty.value}${from(penalty)}` : missing}`,
    `- **Source:** ${basis ? `${basis}, ` : ""}last read from [[${readFrom}]]${sources.length ? ` (sources: ${sources.join(", ")})` : ""}`,
    `- **Source date:** ${dates[0] ?? "not known"}. Not yet checked with the law or the authority.`,
  ].join("\n")
}

const SUMMARY_HEAD = "## Rule summary"
const SUMMARY_END = "<!-- /rule-summary -->"

/**
 * The summary on a page this job did not create. It goes in its own
 * section, which only this job rewrites, so the page's own Overview is
 * never replaced.
 */
export function withRuleSummary(content: string, summary: string): string {
  const section = `${SUMMARY_HEAD}\n\n${summary.trim()}\n\n${SUMMARY_END}\n`
  const start = content.indexOf(`${SUMMARY_HEAD}\n`)
  const end = start < 0 ? -1 : content.indexOf(SUMMARY_END, start)
  if (start >= 0 && end >= 0) return `${content.slice(0, start)}${section}${content.slice(end + SUMMARY_END.length).replace(/^\n/, "")}`
  return `${section}\n${content.trim()}\n`
}

export interface RulesState {
  sources: Record<string, { fingerprint: string; at: string; costUsd?: number; failures?: number }>
}

export function loadRulesState(wikiDir: string): RulesState {
  const file = resolve(wikiDir, "_rules", "state.json")
  if (!existsSync(file)) return { sources: {} }
  try {
    const v = JSON.parse(readFileSync(file, "utf-8"))
    return v && typeof v.sources === "object" ? v : { sources: {} }
  } catch {
    return { sources: {} }
  }
}

export function saveRulesState(wikiDir: string, state: RulesState): void {
  mkdirSync(resolve(wikiDir, "_rules"), { recursive: true })
  writeFileSync(resolve(wikiDir, "_rules", "state.json"), JSON.stringify(state, null, 2))
}

export interface RulesOptions {
  /** Entity ids or titles; empty means every page that states rules. */
  only: string[]
  words: RegExp
  max: number
  maxCostUsd: number
  dryRun: boolean
  force: boolean
  today: string
  save?: (state: RulesState) => void
}

export interface RuleWrite {
  title: string
  /** agent/path of the obligation page. */
  page: string
  created: boolean
  deadline: boolean
  penalty: boolean
  /** Bearer pages that got a `subject_to` link. */
  linked: string[]
  /** Dry runs: the summary that would be written. */
  preview?: string
}

export interface RulesOutcome {
  source: string
  title: string
  page?: string
  status: "written" | "dry-run" | "unchanged" | "no-page" | "no-reply" | "no-rules" | "failed"
  rules: RuleWrite[]
  costUsd: number
  dropped: string[]
}

export interface RulesRun {
  outcomes: RulesOutcome[]
  costUsd: number
  capped: boolean
}

interface Target {
  agentId: string
  path: string
  meta: WikiArticleMeta
  content: string
  created: boolean
}

/**
 * Where a rule is written: the existing obligation page when one is
 * owned here and no wider audience than the source can read it, else a
 * new page in the source page's wiki with the source page's access.
 */
function ruleTarget(hub: WikiHub, r: RuleDraft, ctx: RulesContext, made: Map<string, Target>, today: string): Target | string {
  const src = ctx.page
  const again = made.get(normName(r.title))
  if (again) return readableAlongside(src.article.meta, again.meta) ? again : "the rule page is readable by agents who cannot read the source"
  if (r.existing) {
    const page = targetPage(hub, r.existing)
    if (!page) return "the rule page was copied from another machine"
    if (!readableAlongside(src.article.meta, page.article.meta)) return "the rule page is readable by agents who cannot read the source"
    return { agentId: page.agentId, path: page.article.path, meta: page.article.meta, content: page.article.content, created: false }
  }
  const owner = src.article.meta.owner || src.agentId
  const store = hub.getAgentWiki(src.agentId)
  let path = `obligations/${slugify(r.title)}.md`
  for (let n = 2; store.readArticle(path); n++) path = `obligations/${slugify(r.title)}-${n}.md`
  const meta: WikiArticleMeta = {
    title: r.title, class: "obligation", tags: [RULES_TAG], owner, access: src.article.meta.access,
    sharedWith: src.article.meta.sharedWith, created: today, lastUpdated: today, sources: [],
  }
  return { agentId: src.agentId, path, meta, content: `${r.title}.\n`, created: true }
}

const penaltyPath = (title: string) => `penalties/${slugify(cleanTitle(`${title} penalty`))}.md`

/**
 * The penalty a rule already has: on the page this job wrote for it, else
 * on any penalty page linked to it with `penalty_for`.
 */
function knownPenalty(hub: WikiHub, g: WikiGraph, title: string, t: Target): PenaltyFact | undefined {
  const fact = (statements?: WikiStatement[]) => {
    const s = statements?.find(x => x.property === "amount_rule")
    return s?.value ? { value: s.value, source: s.source, checked_at: s.checked_at } : undefined
  }
  const own = hub.getAgentWiki(t.agentId).readArticle(penaltyPath(title))
  if (own && (own.meta.tags ?? []).includes(RULES_TAG)) return fact(own.meta.statements)
  for (const e of g.entities.values()) {
    if (e.type !== "penalty" || !e.statements.some(s => s.property === "penalty_for" && normName(s.value) === normName(title))) continue
    const page = e.pages.find(p => readableAlongside(t.meta, p.article.meta))
    const f = page && fact(page.article.meta.statements)
    if (f) return f
  }
  return undefined
}

function penaltyPage(r: RuleDraft, t: Target, ctx: RulesContext, today: string): { path: string; meta: WikiArticleMeta; content: string } {
  const title = cleanTitle(`${r.title} penalty`)
  const checked = sourceDate(r, ctx)
  const st = (property: string, value: string): WikiStatement => ({
    property, value, source: r.source, ...(checked ? { checked_at: checked } : {}), status: "proposed", by: RULES_BY,
  })
  const statements = [st("penalty_for", r.title), st("amount_rule", r.penalty), st("created_by", r.basis ? asPage(r.basis, ctx.laws) : ctx.page.article.meta.title)]
  return {
    path: penaltyPath(r.title),
    meta: {
      title, class: "penalty", tags: [RULES_TAG], owner: t.meta.owner, access: t.meta.access, sharedWith: t.meta.sharedWith,
      created: today, lastUpdated: today, sources: t.meta.sources, statements, related: [r.title],
    },
    content: `## Overview\n\n${r.penalty}\n\nFor [[${r.title}]]. Source: ${r.source}${checked ? `, dated ${checked}` : ""}. Not yet checked with the law or the authority.\n`,
  }
}

/** Add `subject_to` to each bearer's page that may show the rule. */
function linkBearers(hub: WikiHub, r: RuleDraft, ctx: RulesContext, t: Target, today: string, dryRun: boolean, dropped: string[]): string[] {
  const linked: string[] = []
  for (const b of r.bearers) {
    const e = ctx.parties.find(x => normName(x.title) === normName(b))
    if (!e) continue
    const page = targetPage(hub, e)
    if (!page) { dropped.push(`${r.title} → ${e.title}: page copied from another machine`); continue }
    // The link shows the rule's title on the bearer's page.
    if (!readableAlongside(t.meta, page.article.meta)) { dropped.push(`${r.title} → ${e.title}: page readable by agents who cannot read the rule`); continue }
    const has = (page.article.meta.statements ?? []).some(s => s.property === "subject_to" && normName(s.value) === normName(r.title))
    if (has) continue
    linked.push(e.title)
    if (dryRun) continue
    const statements = [...(page.article.meta.statements ?? []), { property: "subject_to", value: r.title, source: r.source, ...(sourceDate(r, ctx) ? { checked_at: sourceDate(r, ctx) } : {}), status: "proposed" as const, by: RULES_BY }]
    const meta = { ...page.article.meta, statements, lastUpdated: today }
    if (hub.getAgentWiki(page.agentId).writeArticle(page.article.path, meta, page.article.content, page.article.meta.owner || page.agentId)) {
      page.article.meta = meta
    } else {
      linked.pop()
      dropped.push(`${r.title} → ${e.title}: write refused`)
    }
  }
  return linked
}

export async function runRules(hub: WikiHub, g: WikiGraph, call: EnrichCall, opts: RulesOptions, state: RulesState): Promise<RulesRun> {
  const failures = (e: Entity) => state.sources[e.id]?.failures ?? 0
  const candidates = ruleSources(g, opts.words, opts.only).sort((a, b) => failures(a) - failures(b))
  const readEntries = (ids: string[]) => hub.getSharedStore().readEntries(ids)
  const run: RulesRun = { outcomes: [], costUsd: 0, capped: false }
  const made = new Map<string, Target>()
  let calls = 0
  const remember = (id: string, fp: string, costUsd: number, failed = false) => {
    if (opts.dryRun) return
    const prev = state.sources[id]
    state.sources[id] = failed
      ? { fingerprint: prev?.fingerprint ?? "", at: new Date().toISOString(), costUsd, failures: (prev?.failures ?? 0) + 1 }
      : { fingerprint: fp, at: new Date().toISOString(), costUsd }
    opts.save?.(state)
  }

  for (const e of candidates) {
    if (calls >= opts.max) break
    const base = { source: e.id, title: e.title, rules: [] as RuleWrite[], costUsd: 0, dropped: [] as string[] }
    const page = targetPage(hub, e)
    if (!page) { if (opts.only.length) run.outcomes.push({ ...base, status: "no-page" }); continue }
    const ctx = rulesContext(g, e, page, readEntries)
    let fp = rulesFingerprint(page)
    if (!opts.force && state.sources[e.id]?.fingerprint === fp) {
      if (opts.only.length) run.outcomes.push({ ...base, status: "unchanged" })
      continue
    }
    if (run.costUsd >= opts.maxCostUsd) { run.capped = true; break }

    calls++
    const where = `${page.agentId}/${page.article.path}`
    let reply: { text: string; costUsd: number }
    try {
      reply = await call(buildRulesPrompt(g, ctx, opts.today))
    } catch (err) {
      run.outcomes.push({ ...base, page: where, status: "failed", dropped: [(err as Error).message.slice(0, 200)] })
      remember(e.id, fp, 0, true)
      continue
    }
    run.costUsd += reply.costUsd
    const outcome: RulesOutcome = { ...base, page: where, status: "no-reply", costUsd: reply.costUsd }
    const parsed = parseEnrichReply(reply.text)
    if (!parsed) { run.outcomes.push(outcome); remember(e.id, fp, reply.costUsd); continue }
    const checked = checkRules(parsed, ctx, g)
    outcome.dropped = checked.dropped
    if (checked.rules.length === 0) {
      outcome.status = "no-rules"
      run.outcomes.push(outcome)
      remember(e.id, fp, reply.costUsd)
      continue
    }

    let failed = false
    for (const r of checked.rules) {
      const t = ruleTarget(hub, r, ctx, made, opts.today)
      if (typeof t === "string") { outcome.dropped.push(`${r.title}: ${t}`); continue }
      // What an earlier source stated stays when this one leaves it out.
      const statements = mergeRuleStatements(t.meta.statements ?? [], ruleStatements(r, ctx), r)
      const meta0 = withRuleStatements(t.meta, statements, opts.today)
      const penalty = r.penalty
        ? { value: r.penalty, source: r.source, checked_at: sourceDate(r, ctx) }
        : knownPenalty(hub, g, r.title, t)
      const summary = ruleOverview(meta0.statements ?? [], penalty, page.article.meta.title)
      // A page this job did not create keeps its own Overview.
      const ours = (t.meta.tags ?? []).includes(RULES_TAG)
      const content = ours ? withOverview(t.content, summary) : withRuleSummary(t.content, summary)
      const related = [...new Set([...(t.meta.related ?? []), page.article.meta.title, ...(penalty ? [cleanTitle(`${r.title} penalty`)] : [])])]
      const sources = [...new Set([...(t.meta.sources ?? []), ...ctx.entries.filter(x => r.source.includes(x.id)).map(x => x.id)])]
      const meta = { ...meta0, related, sources }
      const write: RuleWrite = {
        title: r.title, page: `${t.agentId}/${t.path}`, created: t.created,
        deadline: (meta.statements ?? []).some(s => s.property === "due_rule"), penalty: !!penalty, linked: [],
      }
      if (opts.dryRun) {
        write.preview = summary
        write.linked = linkBearers(hub, r, ctx, t, opts.today, true, outcome.dropped)
        outcome.rules.push(write)
        continue
      }
      const store = hub.getAgentWiki(t.agentId)
      if (!store.writeArticle(t.path, meta, content, t.meta.owner || t.agentId)) {
        outcome.dropped.push(`${r.title}: write refused`)
        failed = true
        continue
      }
      made.set(normName(r.title), { ...t, meta, content, created: false })
      if (r.penalty) {
        const pen = penaltyPage(r, { ...t, meta }, ctx, opts.today)
        const old = store.readArticle(pen.path)
        // A penalty page someone else wrote at that path is left alone.
        if (!old || (old.meta.tags ?? []).includes(RULES_TAG)) store.writeArticle(pen.path, old ? { ...pen.meta, created: old.meta.created } : pen.meta, pen.content, pen.meta.owner)
        else outcome.dropped.push(`${r.title}: ${pen.path} already exists`)
      }
      write.linked = linkBearers(hub, r, ctx, { ...t, meta }, opts.today, false, outcome.dropped)
      store.rebuildIndex()
      outcome.rules.push(write)
    }
    outcome.status = opts.dryRun ? "dry-run" : outcome.rules.length ? "written" : failed ? "failed" : "no-rules"
    run.outcomes.push(outcome)
    // A rule written onto the source page itself changes its text; the
    // next run must not pay to read back what this one wrote.
    const now = opts.dryRun ? null : hub.getAgentWiki(page.agentId).readArticle(page.article.path)
    if (now) fp = rulesFingerprint({ agentId: page.agentId, article: now })
    remember(e.id, fp, reply.costUsd, failed && outcome.rules.length === 0)
  }
  return run
}
