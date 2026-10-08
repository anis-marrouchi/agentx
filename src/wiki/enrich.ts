import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { isAgentSender } from "@/a2a/initiator"
import type { WikiHub } from "./hub"
import type { WikiAccess, WikiArticle, WikiArticleMeta, WikiEntry } from "./types"
import { buildGraph, normName, slugify, type Entity, type GraphPage, type WikiGraph } from "./ontology/graph"
import { lensFor } from "./ontology/lens"
import { loadOntology, panelFrom, panelSource } from "./ontology/load"
import type { Importance, WikiStatement } from "./ontology/types"

// --- Scheduled enrichment of entity pages (#820) ---
//
// Agents kept looking up the same facts about the same people again and
// again. This run brings one entity page at a time up to the level of
// the best hand-curated page: an overview that tells the relationship
// story in full, typed statements with a source each (role at, client
// of, contact for), and a History whose items link down to event pages.
//
// The agent named in `wikiEnrich.agent` does the reading and writing, so
// the run costs what that agent costs and uses its tier and model. It
// only ever writes into its own wiki: a page it already holds for the
// entity, or a new page with the same title, which the graph merges into
// the same entity. Writes go through WikiStore.writeArticle, which keeps
// the old text under `_versions/`.
//
// What the model returns is a claim. Every statement must cite a source
// the run gave it and link to a page that exists, or it is dropped;
// statements are written `proposed` until the owner confirms them, and
// keep the access level of the page they are on. No personal analysis
// is generated.
//
// A page is refreshed only when its inputs changed since the last run:
// the pages, the pages that link to it, and the messages that mention
// it. The state lives in `_enrich.json` beside the other wiki sidecars.

export const ENRICH_FILE = "_enrich.json"

/** Where a run may read. `entries` is the node's message history. */
export const ENRICH_SOURCES = ["entries", "contacts", "wacli", "gitlab", "gog", "web"] as const
export type EnrichSource = (typeof ENRICH_SOURCES)[number]
export const FACT_SOURCES: readonly EnrichSource[] = ["contacts", "wacli", "gitlab", "gog"]

/** People and organisations first, then projects, places and assets.
 *  Agents are not people (#819) and are never enriched as one. */
export const DEFAULT_ENRICH_TYPES = ["person", "organization", "project", "place", "device", "server", "app", "domain", "account"]

export interface EnrichSettings {
  enabled: boolean
  /** Agent that runs the enrichment and owns the pages it writes. */
  agent: string
  types: string[]
  sources: EnrichSource[]
  /** Most pages refreshed in one run. */
  maxPages: number
  /** Spending cap per run, in US dollars. 0 means no cap beyond maxPages. */
  maxSpendUsd: number
  /** Most messages given for one page. */
  maxEntriesPerPage: number
  /** Most new event pages one page may create in a run. */
  maxNewEvents: number
  /** Model for the agent's calls. Unset, the agent's own model is used. */
  model?: string
}

export const ENRICH_LIMITS = {
  overview: 1500,
  value: 300,
  role: 80,
  basis: 200,
  eventTitle: 120,
  eventSummary: 600,
  entryChars: 700,
  promptEntryChars: 24_000,
  pageChars: 6000,
  runsKept: 20,
  /** Failed runs in a row, on the same inputs, before a page is left
   *  alone until its inputs change. */
  maxFailures: 3,
} as const

/** Properties a page of each type may state about itself. The other side
 *  of a relation is written on the other page: a person's `role_at`
 *  shows on the organisation as "people". Types not listed use the
 *  statements panels of their lens. */
const SUBJECT_PROPS: Record<string, string[]> = {
  person: ["role_at", "member_of", "founded", "works_with", "reports_to", "client_of", "contact_for", "works_on", "owns", "uses", "subject_to", "located_in", "contact"],
  organization: ["client_of", "works_with", "member_of", "registered_with", "located_in", "identifier", "legal_form", "subject_to", "owns", "uses", "contact"],
  project: ["client", "uses", "located_in", "subject_to", "runs_on"],
  offering: ["client"],
  place: ["located_in"],
  device: ["located_in"],
  server: ["located_in"],
  app: ["installed_on", "runs_on", "licensed_by"],
  domain: ["registrar"],
  account: ["licensed_by"],
}

/** Never written as statements: plain links and readings. */
const NOT_STATED = new Set(["related", "reading"])

/** Properties whose value is a plain value, not a link to a page. Every
 *  other value must name a page that exists. */
const LITERAL_PROPS = new Set(["contact", "identifier", "legal_form", "registrar", "amount", "notice", "starts", "renews", "due", "status"])

/** Parties whose relations must not name an agent (#819). */
const PARTY_TYPES = new Set(["person", "organization"])

// --- Selection ---

export function entityNames(e: Entity): string[] {
  const names = new Set<string>()
  for (const p of e.pages) {
    names.add(p.article.meta.title)
    for (const a of p.article.meta.aliases ?? []) names.add(a)
  }
  return [...names].map(n => n.trim()).filter(n => n.length >= 3)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Messages the pages were written from, or that name the entity, newest
 *  first. A name matches as a whole word, case-insensitive. */
export function matchEntries(e: Entity, all: WikiEntry[], max: number): WikiEntry[] {
  const cited = new Set(e.sources)
  const names = entityNames(e)
  const res = names.map(n => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "iu"))
  const keys = new Set(names.map(normName))
  return all
    .filter(en => cited.has(en.id)
      || (en.sourceContext && keys.has(normName(en.sourceContext)))
      || res.some(re => re.test(en.content)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
    .slice(0, max)
}

/** Changes when anything the run reads for this entity changes. */
export function entitySignature(g: WikiGraph, e: Entity, entries: WikiEntry[]): string {
  const h = createHash("sha256")
  const pages = [...e.pages].sort((a, b) => `${a.agentId}/${a.article.path}`.localeCompare(`${b.agentId}/${b.article.path}`))
  for (const p of pages) {
    const m = p.article.meta
    h.update(`${p.agentId}\0${p.article.path}\0${m.access}\0${JSON.stringify(m.statements ?? [])}\0${p.article.content}\n`)
  }
  const linking = new Set<string>()
  for (const edge of g.incoming.get(e.id) ?? []) {
    const from = g.entities.get(edge.from)
    if (from) linking.add(`${normName(from.title)}:${edge.property}`)
  }
  h.update([...linking].sort().join("|"))
  h.update("\n")
  h.update(entries.map(en => en.id).sort().join("|"))
  return h.digest("hex").slice(0, 16)
}

export interface Candidate {
  entity: Entity
  signature: string
  entries: WikiEntry[]
  /** Never enriched, its inputs changed since, or the last run on it
   *  failed. */
  reason: "new" | "changed" | "retry"
}

export interface PickOptions {
  types: string[]
  maxEntriesPerPage: number
  /** Only this entity, by title or alias. */
  only?: string
  /** Refresh even when nothing changed. */
  force?: boolean
}

/** Entities due a refresh: never done first, then changed ones; within
 *  each, by type order, then the most recent activity first. */
export function pickCandidates(g: WikiGraph, entries: WikiEntry[], state: EnrichFile, opts: PickOptions): { due: Candidate[]; unchanged: number; givenUp: number } {
  const types = new Set(opts.types.filter(t => t !== "agent"))
  const onlyId = opts.only ? g.names.get(normName(opts.only)) : undefined
  if (opts.only && !onlyId) return { due: [], unchanged: 0, givenUp: 0 }
  const due: Array<Candidate & { activity: string }> = []
  let unchanged = 0
  let givenUp = 0
  for (const e of g.entities.values()) {
    if (onlyId ? e.id !== onlyId : !types.has(e.type)) continue
    if (e.type === "agent") continue
    const matched = matchEntries(e, entries, opts.maxEntriesPerPage)
    const signature = entitySignature(g, e, matched)
    const last = state.pages[stateKey(e)]
    if (!opts.force && last?.signature === signature) { unchanged++; continue }
    const failing = last?.outcome === "failed"
    // A page that keeps failing on the same inputs is left alone until they
    // change, so it cannot eat every run's budget.
    if (!opts.force && failing && (last.failures ?? 1) >= ENRICH_LIMITS.maxFailures && last.failedSignature === signature) { givenUp++; continue }
    const activity = [matched[0]?.date ?? "", e.updated].sort().pop() ?? ""
    const reason = failing ? "retry" : last?.signature ? "changed" : "new"
    due.push({ entity: e, signature, entries: matched, reason, activity })
  }
  // Never done first, then changed, then failed last time. Within each
  // group, types in the order the settings list them: people first, then
  // organisations, and so on.
  const group = { new: 0, changed: 1, retry: 2 }
  const rank = (t: string) => { const i = opts.types.indexOf(t); return i === -1 ? opts.types.length : i }
  due.sort((a, b) => group[a.reason] - group[b.reason]
    || rank(a.entity.type) - rank(b.entity.type)
    || b.activity.localeCompare(a.activity) || a.entity.title.localeCompare(b.entity.title))
  return { due: due.map(({ activity: _a, ...c }) => c), unchanged, givenUp }
}

export function stateKey(e: Entity): string {
  return normName(e.title)
}

// --- The prompt ---

export function allowedProperties(g: WikiGraph, type: string): string[] {
  const known = new Set(g.ontology.properties.map(p => p.id))
  const listed = SUBJECT_PROPS[type]
    ?? lensFor(g, type).filter(p => panelSource(p) === "statements").flatMap(panelFrom)
  return [...new Set(listed)].filter(p => known.has(p) && !NOT_STATED.has(p))
}

const ACCESS_RANK: Record<WikiAccess, number> = { public: 0, shared: 1, private: 2 }

/** The page the run writes for this entity, and the access it carries. */
export function targetFor(e: Entity, agentId: string): { page: GraphPage | null; path: string; access: WikiAccess; sharedWith?: string[] } {
  const own = e.pages.find(p => p.agentId === agentId && p.article.meta.owner === agentId && p.article.meta.access !== "private")
  if (own) return { page: own, path: own.article.path, access: own.article.meta.access, sharedWith: own.article.meta.sharedWith }
  // A new page is as private as the strictest page it is written from.
  const strictest = [...e.pages].sort((a, b) => ACCESS_RANK[b.article.meta.access] - ACCESS_RANK[a.article.meta.access])[0]
  const access = strictest?.article.meta.access ?? "shared"
  return { page: null, path: `entities/${slugify(e.title)}.md`, access, sharedWith: access === "shared" ? strictest?.article.meta.sharedWith : undefined }
}

export interface FactLine {
  field: string
  value: string
  source: string
}

export interface BriefInput {
  g: WikiGraph
  e: Entity
  entries: WikiEntry[]
  facts: FactLine[]
  sources: EnrichSource[]
  agentId: string
  today: string
  maxNewEvents: number
}

function propLine(g: WikiGraph, id: string): string {
  const p = g.ontology.properties.find(x => x.id === id)
  return `- \`${id}\`: "${p?.label ?? id}"${p?.range?.length ? ` (value is usually a ${p.range.join(" or ")})` : ""}`
}

export function buildEnrichPrompt(b: BriefInput): string {
  const { g, e } = b
  const typeLabel = g.ontology.types.find(t => t.id === e.type)?.label ?? e.type
  const target = targetFor(e, b.agentId)
  const party = PARTY_TYPES.has(e.type)
  const lines: string[] = []
  lines.push(`You are refreshing one wiki page so that an agent can learn what it needs about this ${typeLabel.toLowerCase()} in a single lookup.`)
  lines.push("", `Page: "${e.title}" (${typeLabel})`, `Today: ${b.today}`)

  // Only pages at least as open as the page being written, so nothing
  // from a private page leaks onto a shared one.
  const readable = e.pages.filter(p => ACCESS_RANK[p.article.meta.access] <= ACCESS_RANK[target.access])
  lines.push("", "## The page today")
  if (readable.length === 0) lines.push("(no text yet)")
  for (const p of readable) {
    const body = p.article.content.length > ENRICH_LIMITS.pageChars ? `${p.article.content.slice(0, ENRICH_LIMITS.pageChars)}\n…` : p.article.content
    lines.push(`<page agent="${p.agentId}" path="${p.article.path}" updated="${p.article.meta.lastUpdated}">`, body, "</page>")
  }

  const stated = readable.flatMap(p => (p.article.meta.statements ?? []).filter(s => s.access !== "private"))
  if (stated.length) {
    lines.push("", "## Statements already recorded")
    for (const s of stated) lines.push(`- ${s.property}: ${s.value}${s.role ? ` (${s.role})` : ""}${s.since || s.until ? ` [${s.since ?? "…"} → ${s.until ?? "now"}]` : ""}${s.status ? ` · ${s.status}` : ""}${s.source ? ` · source ${s.source}` : ""}`)
  }

  const linked = new Map<string, Entity>()
  for (const edge of [...(g.outgoing.get(e.id) ?? []), ...(g.incoming.get(e.id) ?? [])]) {
    const other = g.entities.get(edge.from === e.id ? edge.to : edge.from)
    if (!other || other.id === e.id) continue
    if (party && other.type === "agent") continue
    linked.set(other.id, other)
  }
  const events = [...linked.values()].filter(o => o.type === "event").sort((a, b) => b.date.localeCompare(a.date))
  const others = [...linked.values()].filter(o => o.type !== "event")
  if (others.length) {
    lines.push("", "## Pages linked to it")
    for (const o of others.slice(0, 40)) lines.push(`- ${o.title} (${g.ontology.types.find(t => t.id === o.type)?.label ?? o.type})`)
  }
  lines.push("", "## Event pages linked to it")
  if (events.length === 0) lines.push("(none yet)")
  for (const ev of events.slice(0, 40)) lines.push(`- ${ev.date || "undated"} · ${ev.importance} · ${ev.title}`)

  if (b.sources.includes("entries")) {
    const dates = b.entries.map(en => en.date).filter(Boolean).sort()
    lines.push("", `## Messages that mention it (${b.entries.length}${dates.length ? `, from ${dates[0]} to ${dates[dates.length - 1]}` : ""})`)
    if (b.entries.length === 0) lines.push("(none)")
    let used = 0
    for (const en of b.entries) {
      const text = en.content.length > ENRICH_LIMITS.entryChars ? `${en.content.slice(0, ENRICH_LIMITS.entryChars)}…` : en.content
      const sender = typeof en.meta?.sender === "string" ? en.meta.sender : ""
      const who = sender ? (isAgentSender(sender) ? " · sent by an agent" : ` · from ${sender}`) : ""
      const block = `[entry:${en.id}] ${en.date} · ${en.source}${en.sourceContext ? ` · ${en.sourceContext}` : ""}${who}\n${text}`
      if (used + block.length > ENRICH_LIMITS.promptEntryChars) break
      used += block.length
      lines.push(block)
    }
  }

  if (b.facts.length) {
    lines.push("", "## Records from systems of record")
    for (const f of b.facts) lines.push(`- ${f.field}: ${f.value} [records:${f.source}]`)
  }

  const props = allowedProperties(g, e.type)
  const sourceForms = ["`entry:<id>` for a message above", "`page:<title>` for a wiki page"]
  if (b.facts.length) sourceForms.push("`records:<source>` for a record above")
  if (b.sources.includes("web")) sourceForms.push("`web:<url>` for a web page you read")

  lines.push("", "## What to return", "",
    "Return ONLY one JSON object, no other text:",
    "```json",
    JSON.stringify({
      overview: "3 to 6 full sentences.",
      basis: "based on 14 messages from 2026-01-02 to 2026-09-30",
      statements: [{ property: props[0] ?? "related", value: "Page title or value", role: "optional role", since: "YYYY-MM", until: "YYYY-MM", source: "entry:<id>" }],
      history: [{ date: "YYYY-MM-DD", title: "What happened", event: "Title of its event page, if it has one", source: "entry:<id>" }],
      newEvents: [{ title: "Short event title", date: "YYYY-MM-DD", summary: "One or two full sentences.", source: "entry:<id>", importance: "normal" }],
    }, null, 2),
    "```",
    "",
    "Rules:",
    `- \`overview\`: the story of ${e.title} for us, in 3 to 6 complete sentences: ${party ? "who they are to us, how it started, what changed, and where it stands now" : "what it is to us, how it started, what changed, and where it stands now"}. Plain prose, no list. Never stop mid-sentence.`,
    "- `basis`: what the overview rests on, with counts and dates.",
    `- \`statements\`: typed facts about ${e.title} itself. Use only these properties:`,
    ...props.map(p => propLine(g, p)),
    `  The value of every property except ${[...LITERAL_PROPS].filter(p => props.includes(p)).map(p => `\`${p}\``).join(", ") || "none"} must be the exact title of a page listed above; any other value is dropped.`,
    `- Every statement needs a \`source\`: ${sourceForms.join(", ")}. A statement without one is dropped.`,
    "- Agents (bots and AI assistants) are not people: never name one as a person's or organisation's relation.",
    "- `history`: one item per event, newest first. Set `event` to the title of its event page when it has one; otherwise give a `source` in the same forms as statements. An item with neither is dropped. Items already in the page's History are kept as they are, so return only what is new or what you can link to an event page.",
    `- \`newEvents\`: an event page for a History item that has none yet, at most ${b.maxNewEvents}. Each needs a date and a source. Importance is \`minor\` or \`normal\`.`,
    "- State only what the sources support. Leave out what you are not sure of. An empty list is a fine answer.",
    b.sources.includes("web") ? "- You may search the web for public facts; cite each page you use as `web:<url>`." : "- Do not search the web or use any other tool. Work only from what is above.",
  )
  return lines.join("\n")
}

// --- Reading the reply ---

export interface HistoryItem {
  date?: string
  text: string
  /** Title of the event page the item links to. */
  event?: string
  /** Where it comes from, when it has no event page. */
  source?: string
}

export interface NewEvent {
  title: string
  date: string
  summary: string
  source: string
  importance: Importance
}

export interface EnrichResult {
  overview?: string
  basis?: string
  statements: WikiStatement[]
  history: HistoryItem[]
  newEvents: NewEvent[]
  /** What was left out, and why. */
  dropped: string[]
}

export interface ReplyContext {
  g: WikiGraph
  e: Entity
  entryIds: Set<string>
  factSources: Set<string>
  sources: EnrichSource[]
  /** Agent names on this node, normalised; never a party's relation. */
  agentIds: Set<string>
  today: string
  maxNewEvents: number
}

const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function str(v: unknown, max: number): string {
  if (typeof v !== "string") return ""
  const t = v.replace(/\s+/g, " ").trim()
  return t.length > max ? "" : t
}

/** A page title the model chose. It goes into `title: "..."` frontmatter
 *  and into wikilinks, so quotes, backslashes and brackets are removed. */
function titleOf(v: unknown, max: number): string {
  return str(typeof v === "string" ? v.replace(/["\\[\]|#]/g, "") : v, max)
}

/** Whole sentences only. A trailing fragment is dropped; text with no
 *  full sentence at all is refused (#820: "not cut off mid-sentence"). */
export function wholeSentences(text: string, max: number): string {
  let t = text.replace(/\s+/g, " ").trim().replace(/(\.\.\.|…)$/, "").trim()
  if (t.length > max) t = t.slice(0, max)
  const end = /[.!?]["'’”)]?$/
  if (end.test(t)) return t
  const ends = [...t.matchAll(/[.!?]["'’”)]?(?=\s)/g)].map(m => (m.index ?? 0) + m[0].length)
  const last = ends.pop()
  return last ? t.slice(0, last).trim() : ""
}

/** The JSON object in a reply, fenced or bare. */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  const text = fenced ? fenced[1] : raw
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

export function validSource(src: string, ctx: ReplyContext): boolean {
  const m = src.match(/^(entry|records|web|page):(.+)$/)
  if (!m) return false
  const [, kind, rest] = m
  if (kind === "entry") return ctx.entryIds.has(rest.trim())
  if (kind === "records") return ctx.factSources.has(rest.trim())
  if (kind === "web") return ctx.sources.includes("web") && /^https?:\/\/\S+$/.test(rest.trim())
  return ctx.g.names.has(normName(rest))
}

function namesAnAgent(value: string, ctx: ReplyContext): boolean {
  if (isAgentSender(value) || ctx.agentIds.has(normName(value))) return true
  const id = ctx.g.names.get(normName(value))
  return !!id && ctx.g.entities.get(id)?.type === "agent"
}

export function parseEnrichReply(raw: string, ctx: ReplyContext): EnrichResult | { error: string } {
  const obj = extractJson(raw)
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { error: "the reply held no JSON object" }
  const o = obj as Record<string, unknown>
  const dropped: string[] = []
  const out: EnrichResult = { statements: [], history: [], newEvents: [], dropped }

  if (typeof o.overview === "string" && o.overview.trim()) {
    const ov = wholeSentences(o.overview, ENRICH_LIMITS.overview)
    if (ov) out.overview = ov
    else dropped.push("overview: no complete sentence")
  }
  const basis = str(o.basis, ENRICH_LIMITS.basis)
  if (out.overview && basis) out.basis = basis

  const allowed = new Set(allowedProperties(ctx.g, ctx.e.type))
  const party = PARTY_TYPES.has(ctx.e.type)
  const seen = new Set<string>()
  for (const s of Array.isArray(o.statements) ? o.statements : []) {
    if (!s || typeof s !== "object") continue
    const r = s as Record<string, unknown>
    const property = str(r.property, 60)
    const value = str(r.value, ENRICH_LIMITS.value)
    const source = str(r.source, 400)
    const label = `${property || "?"}: ${value || "?"}`
    if (!allowed.has(property)) { dropped.push(`${label}: property not allowed on a ${ctx.e.type}`); continue }
    if (!value) { dropped.push(`${label}: no value`); continue }
    if (!source || !validSource(source, ctx)) { dropped.push(`${label}: no source the run can check`); continue }
    if (normName(value) === normName(ctx.e.title)) { dropped.push(`${label}: names the page itself`); continue }
    if (party && namesAnAgent(value, ctx)) { dropped.push(`${label}: agents are not people (#819)`); continue }
    const target = ctx.g.names.get(normName(value))
    if (!LITERAL_PROPS.has(property) && !target) { dropped.push(`${label}: no page with that title`); continue }
    // A link is written with the page's own title.
    const st: WikiStatement = { property, value: target && !LITERAL_PROPS.has(property) ? ctx.g.entities.get(target)!.title : value, source, status: "proposed", checked_at: ctx.today }
    const role = str(r.role, ENRICH_LIMITS.role)
    if (role) st.role = role
    const since = str(r.since, 10)
    const until = str(r.until, 10)
    if (since && DATE_RE.test(since)) st.since = since
    if (until && DATE_RE.test(until)) st.until = until
    const key = `${property}|${normName(value)}|${normName(role)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.statements.push(st)
  }

  const majorOk = ctx.g.ontology.importance.major_set_by === "anyone"
  const titles = new Set<string>()
  for (const ev of Array.isArray(o.newEvents) ? o.newEvents : []) {
    if (out.newEvents.length >= ctx.maxNewEvents) { dropped.push("newEvents: over the per-page cap"); break }
    if (!ev || typeof ev !== "object") continue
    const r = ev as Record<string, unknown>
    const title = titleOf(r.title, ENRICH_LIMITS.eventTitle)
    const date = str(r.date, 10)
    const summary = typeof r.summary === "string" ? wholeSentences(r.summary, ENRICH_LIMITS.eventSummary) : ""
    const source = str(r.source, 400)
    if (!title || !DAY_RE.test(date)) { dropped.push(`event ${title || "?"}: needs a title and a YYYY-MM-DD date`); continue }
    if (!source || !validSource(source, ctx)) { dropped.push(`event ${title}: no source the run can check`); continue }
    if (ctx.g.names.has(normName(title)) || titles.has(normName(title))) continue // already a page: linked below
    titles.add(normName(title))
    const imp = r.importance === "minor" ? "minor" : r.importance === "major" && majorOk ? "major" : "normal"
    out.newEvents.push({ title, date, summary: summary || `${title}.`, source, importance: imp })
  }

  const rawHistory = (Array.isArray(o.history) ? o.history : []).filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
  // New event pages some item names outright; never matched by date alone.
  const named = new Set(rawHistory.flatMap(r => [str(r.event, 200), str(r.title, 200)]).filter(Boolean).map(normName))
  for (const h of rawHistory) {
    const r = h
    const text = str(r.title, 200)
    if (!text) continue
    const date = str(r.date, 10)
    const item: HistoryItem = { text }
    if (date && DATE_RE.test(date)) item.date = date
    for (const name of [str(r.event, 200), text]) {
      if (!name) continue
      const id = ctx.g.names.get(normName(name))
      const ent = id ? ctx.g.entities.get(id) : undefined
      if (ent?.type === "event") { item.event = ent.title; break }
      const made = out.newEvents.find(n => normName(n.title) === normName(name))
      if (made) { item.event = made.title; break }
    }
    // An item worded apart from its new event page still links to it when
    // they share the date and no other item took that page.
    if (!item.event && item.date) {
      const free = out.newEvents.filter(n => n.date === item.date && !named.has(normName(n.title)) && !out.history.some(x => x.event === n.title))
      if (free.length === 1) item.event = free[0].title
    }
    const source = str(r.source, 400)
    if (source && validSource(source, ctx)) item.source = source
    if (!item.event && !item.source) { dropped.push(`history ${text}: no event page and no source the run can check`); continue }
    out.history.push(item)
  }
  // A new event page belongs in the History even when the reply forgot it.
  for (const n of out.newEvents) {
    if (!out.history.some(h => h.event === n.title)) out.history.push({ date: n.date, text: n.title, event: n.title })
  }
  out.history.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))

  return out
}

export function isEmptyResult(r: EnrichResult): boolean {
  return !r.overview && r.statements.length === 0 && r.history.length === 0
}

// --- Writing ---

/** Replace a `## Heading` section, or add it at the top or the end. */
export function replaceSection(body: string, heading: string, text: string, where: "top" | "end"): string {
  const lines = body.split("\n")
  const start = lines.findIndex(l => l.trim().toLowerCase() === `## ${heading}`.toLowerCase())
  const block = [`## ${heading}`, "", text.trim(), ""]
  if (start === -1) {
    const trimmed = body.trim()
    if (!trimmed) return block.join("\n").trim()
    return where === "top" ? `${block.join("\n")}\n${trimmed}` : `${trimmed}\n\n${block.join("\n").trim()}`
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end === -1) end = lines.length
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

function link(g: WikiGraph, value: string, extra: Set<string>): string {
  const id = g.names.get(normName(value))
  if (id) {
    const title = g.entities.get(id)!.title
    return title === value ? `[[${title}]]` : `[[${title}|${value}]]`
  }
  return extra.has(normName(value)) ? `[[${value}]]` : value
}

/** Merge new statements over old: same property, value and role replace a
 *  proposed one; a confirmed one is kept as it is. */
export function mergeStatements(old: WikiStatement[], fresh: WikiStatement[]): WikiStatement[] {
  const key = (s: WikiStatement) => `${s.property}|${normName(s.value)}|${normName(s.role ?? "")}`
  const out = [...old]
  for (const s of fresh) {
    const at = out.findIndex(x => key(x) === key(s))
    if (at === -1) out.push(s)
    else if (out[at].status !== "confirmed") out[at] = { ...out[at], ...s }
  }
  return out
}

function shownStatements(statements: WikiStatement[]): WikiStatement[] {
  return statements.filter(s => s.access !== "private" && !NOT_STATED.has(s.property) && s.property !== "reading" && !s.metric)
}

/** The start of a statement's line: "- Label [[Value]]". */
function statementHead(g: WikiGraph, s: WikiStatement, extra: Set<string>): string {
  const label = g.ontology.properties.find(p => p.id === s.property)?.label ?? s.property.replace(/_/g, " ")
  return `- ${label[0].toUpperCase()}${label.slice(1)} ${link(g, s.value, extra)}`
}

export function statementsSection(g: WikiGraph, statements: WikiStatement[], extra: Set<string>): string {
  return shownStatements(statements).map(s => {
    const when = s.since || s.until ? `, ${s.since ?? "…"} to ${s.until ?? "now"}` : ""
    return `${statementHead(g, s, extra)}${s.role ? ` (${s.role}${when})` : when ? ` (${when.slice(2)})` : ""}. Source: ${s.source ?? "not given"}.`
  }).join("\n")
}

function historyLine(h: HistoryItem): string {
  const text = h.event ? (h.event === h.text ? `[[${h.event}]]` : `[[${h.event}|${h.text}]]`) : h.text
  return `- ${h.date ? `${h.date} — ` : ""}${text}${!h.event && h.source ? ` _(${h.source})_` : ""}`
}

export function historySection(items: HistoryItem[]): string {
  return items.map(historyLine).join("\n")
}

/** The text under a `## Heading`, or null when the page has none. */
export function sectionOf(body: string, heading: string): string | null {
  const lines = body.split("\n")
  const start = lines.findIndex(l => l.trim().toLowerCase() === `## ${heading}`.toLowerCase())
  if (start === -1) return null
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end === -1) end = lines.length
  return lines.slice(start + 1, end).join("\n").trim()
}

const LIST_ITEM = /^\s*[-*]\s+/
const HISTORY_ITEM = /^\s*[-*]\s+(?:(\d{4}(?:-\d{2}){0,2})\s*(?:—|–|-|:)?\s*)?(.*)$/

/** Merge the run's History items into the History already on the page.
 *  Nothing written there is lost: a line the reply did not return stays
 *  as it is. An item the page already has (same event page, or same date
 *  and wording) keeps the page's own line; when that line had no link,
 *  it gains the link to the event page and keeps its words. An unlinked
 *  line also takes the one new event page of its date when no other line
 *  of that date could. Lines are kept newest first. */
export function mergeHistory(existing: string, items: HistoryItem[]): string {
  const prose: string[] = []
  const rows: Array<{ date: string; line: string; event?: string; text: string }> = []
  for (const line of existing.split("\n")) {
    if (!line.trim()) continue
    const m = LIST_ITEM.test(line) ? line.match(HISTORY_ITEM) : null
    if (!m) { prose.push(line); continue }
    const linked = wikilinks(m[2])[0]
    rows.push({ date: m[1] ?? "", line: line.trimEnd(), ...(linked ? { event: normName(linked) } : {}), text: m[2] })
  }
  const plain = (t: string) => normName(t.replace(/\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g, (_x, a, b) => b || a))
  const linkInto = (row: (typeof rows)[number], h: HistoryItem) => {
    row.line = historyLine({ date: row.date || h.date, text: row.text.trim(), event: h.event })
    row.event = normName(h.event!)
  }
  const fresh: HistoryItem[] = []
  for (const h of items) {
    const ev = h.event ? normName(h.event) : ""
    const same = rows.find(r => (ev && r.event === ev) || (r.date === (h.date ?? "") && plain(r.text) === plain(h.text)))
    if (!same) { fresh.push(h); continue }
    if (ev && !same.event) linkInto(same, h)
  }
  const left: HistoryItem[] = []
  for (const h of fresh) {
    const sameDay = h.event && h.date ? rows.filter(r => r.date === h.date) : []
    if (sameDay.length === 1 && !sameDay[0].event && fresh.filter(x => x.date === h.date).length === 1) linkInto(sameDay[0], h)
    else left.push(h)
  }
  for (const h of left) rows.push({ date: h.date ?? "", line: historyLine(h), ...(h.event ? { event: normName(h.event) } : {}), text: h.text })
  // Newest first; undated lines keep their order after the dated ones.
  const dated = rows.filter(r => r.date).sort((a, b) => b.date.localeCompare(a.date))
  const undated = rows.filter(r => !r.date)
  return [...prose, ...(prose.length && rows.length ? [""] : []), ...[...dated, ...undated].map(r => r.line)].join("\n")
}

/** A line the run writes from a statement: "- Label value. Source: x." It
 *  is rebuilt from the page's statements on every run. */
const STATEMENT_LINE = /^\s*[-*]\s+.*\. Source: [^\n]+\.\s*$/

/** Lines in "Roles and relations" the run does not rebuild: anything a
 *  person wrote, including a line shaped like a statement line that no
 *  statement on the page accounts for. */
function handWritten(g: WikiGraph, section: string | null, statements: WikiStatement[], extra: Set<string>): string[] {
  const heads = shownStatements(statements).map(s => statementHead(g, s, extra))
  return (section ?? "").split("\n").filter(l => l.trim() && !(STATEMENT_LINE.test(l) && heads.some(h => l.trim().startsWith(h))))
}

/** An Overview the run wrote ends with its basis line. */
const RUN_OVERVIEW = /Refreshed \d{4}-\d{2}-\d{2}\._\s*$/

/** The page text a refresh must never lose: everything but the Overview
 *  and the lines the run rebuilds from statements. */
export function keptText(body: string): { lines: number; chars: number } {
  const all = body.split("\n")
  const start = all.findIndex(l => l.trim().toLowerCase() === "## overview")
  let end = start === -1 ? -1 : all.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (start !== -1 && end === -1) end = all.length
  const lines = all.filter((_l, i) => start === -1 || i < start || i >= end)
    .map(l => l.trim()).filter(l => l && !STATEMENT_LINE.test(l))
  return { lines: lines.length, chars: lines.join("").replace(/\s+/g, "").length }
}

export class ShrinkError extends Error {}

/** Throws when `after` holds fewer lines or characters than `before`,
 *  leaving out the Overview and the statement lines. */
export function assertNoShrink(before: string, after: string, path: string): void {
  const a = keptText(before)
  const b = keptText(after)
  if (b.lines < a.lines || b.chars < a.chars) {
    throw new ShrinkError(`refused: the refresh would shorten ${path} (${a.lines} → ${b.lines} lines, ${a.chars} → ${b.chars} characters outside the Overview)`)
  }
}

function wikilinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(m => m[1].trim())
}

function entryIdsOf(statements: WikiStatement[]): string[] {
  return statements.map(s => s.source?.match(/^entry:(.+)$/)?.[1]?.trim()).filter((x): x is string => !!x)
}

export interface Written {
  /** Paths written, relative to the agent's wiki. */
  paths: string[]
  created: string[]
  statements: number
  events: number
  /** What the page kept instead of the reply's version, and why. */
  kept: string[]
}

export function applyEnrichment(hub: WikiHub, agentId: string, g: WikiGraph, e: Entity, r: EnrichResult, today: string): Written {
  const store = hub.getAgentWiki(agentId)
  const target = targetFor(e, agentId)
  const out: Written = { paths: [], created: [], statements: r.statements.length, events: 0, kept: [] }
  const created = new Set(r.newEvents.map(n => normName(n.title)))

  const base: WikiArticle = target.page?.article ?? {
    path: target.path,
    content: "",
    meta: {
      title: e.title, tags: ["enriched"], owner: agentId, access: target.access,
      ...(target.sharedWith?.length ? { sharedWith: target.sharedWith } : {}),
      created: today, lastUpdated: today, sources: [], class: e.type,
    },
  }
  // A new path must not land on another page's file.
  let path = base.path
  if (!target.page) {
    for (let n = 2; store.readArticle(path) && store.readArticle(path)!.meta.title !== e.title; n++) path = `entities/${slugify(e.title)}-${n}.md`
    const onDisk = store.readArticle(path)
    if (onDisk) { base.content = onDisk.content; base.meta = onDisk.meta }
  }

  const statements = mergeStatements(base.meta.statements ?? [], r.statements)
  let body = base.content
  if (r.overview) {
    // A hand-written Overview is only replaced by one at least as long.
    const old = sectionOf(body, "Overview")
    const text = r.overview + (r.basis ? `\n\n_${r.basis[0].toUpperCase()}${r.basis.slice(1)}. Refreshed ${today}._` : "")
    if (!old || RUN_OVERVIEW.test(old) || text.length >= old.length) body = replaceSection(body, "Overview", text, "top")
    else out.kept.push("overview: the page's own Overview is longer and was written by hand")
  }
  // Statement lines are rebuilt from the merged statements; lines a person
  // added to the section stay.
  const facts = [statementsSection(g, statements, created), ...handWritten(g, sectionOf(body, "Roles and relations"), statements, created)].filter(Boolean).join("\n")
  if (facts) body = replaceSection(body, "Roles and relations", facts, "end")
  if (r.history.length) body = replaceSection(body, "History", mergeHistory(sectionOf(body, "History") ?? "", r.history), "end")

  // Last line of defence: a refresh adds to a page, it never shortens it.
  assertNoShrink(base.content, body, path)

  const meta: WikiArticleMeta = {
    ...base.meta,
    statements: statements.length ? statements : undefined,
    related: [...new Set([...(base.meta.related ?? []), ...wikilinks(body)])],
    sources: [...new Set([...(base.meta.sources ?? []), ...entryIdsOf(r.statements)])],
    lastUpdated: today,
  }
  if (!meta.related?.length) meta.related = undefined
  if (!store.writeArticle(path, meta, body, agentId)) throw new Error(`${agentId} may not write ${path}`)
  out.paths.push(path)
  if (!target.page) out.created.push(path)

  for (const ev of r.newEvents) {
    const evPath = `events/${ev.date}-${slugify(ev.title)}.md`
    if (store.readArticle(evPath)) continue
    const evMeta: WikiArticleMeta = {
      title: ev.title, type: "event", class: "event", tags: ["enriched"], owner: agentId,
      access: meta.access, ...(meta.sharedWith?.length ? { sharedWith: meta.sharedWith } : {}),
      created: today, lastUpdated: today, sources: entryIdsOf([{ property: "involves", value: e.title, source: ev.source }]),
      date: ev.date, importance: ev.importance, related: [e.title],
      statements: [{ property: "involves", value: e.title, source: ev.source, status: "proposed", checked_at: today }],
    }
    const evBody = `${ev.summary}\n\nPart of the history of [[${e.title}]]. Source: ${ev.source}.`
    if (store.writeArticle(evPath, evMeta, evBody, agentId)) {
      out.paths.push(evPath)
      out.created.push(evPath)
      out.events++
    }
  }

  return out
}

// --- State ---

export type PageOutcome = "refreshed" | "nothing-new" | "failed"

export interface EnrichPageState {
  title: string
  type: string
  /** Inputs at the end of the last run; empty after a failure, so the
   *  next run tries again. */
  signature: string
  at: string
  runId: string
  outcome: PageOutcome
  reason?: string
  costUsd?: number
  /** Failed runs in a row; reset by a run that does not fail. */
  failures?: number
  /** Inputs when it last failed. A page that failed `maxFailures` times
   *  on the same inputs is left alone until they change. */
  failedSignature?: string
}

export interface EnrichRunItem {
  title: string
  type: string
  outcome: PageOutcome
  reason?: string
  costUsd?: number
  statements?: number
  events?: number
  dropped?: number
  paths?: string[]
  /** On a dry run: what would be written. */
  plan?: EnrichPlan
}

export interface EnrichPlan {
  overview?: string
  statements: string[]
  history: string[]
  newEvents: string[]
  dropped: string[]
}

export function planOf(r: EnrichResult): EnrichPlan {
  return {
    ...(r.overview ? { overview: r.overview } : {}),
    statements: r.statements.map(s => `${s.property}: ${s.value}${s.role ? ` (${s.role})` : ""}${s.since || s.until ? ` [${s.since ?? "…"} → ${s.until ?? "now"}]` : ""} · ${s.source}`),
    history: r.history.map(h => `${h.date ?? "undated"} ${h.text}${h.event ? ` → ${h.event}` : ""}`),
    newEvents: r.newEvents.map(n => `${n.date} ${n.title} (${n.importance}) · ${n.source}`),
    dropped: r.dropped,
  }
}

export interface EnrichRunRecord {
  id: string
  at: string
  agent: string
  dryRun?: boolean
  /** Pages due a refresh when the run started. */
  due: number
  /** Pages skipped because nothing changed. */
  unchanged: number
  /** Pages skipped because they failed too often on the same inputs. */
  givenUp?: number
  refreshed: number
  failed: number
  spentUsd: number
  /** Calls whose cost the agent's runtime did not report. */
  costUnknown: number
  stoppedBy?: "max pages" | "spend cap"
  items: EnrichRunItem[]
}

export interface EnrichFile {
  version: 1
  pages: Record<string, EnrichPageState>
  runs: EnrichRunRecord[]
  /** The file exists but could not be read. It is then never written. */
  unreadable?: string
}

export class EnrichState {
  readonly file: string
  constructor(wikiDir: string) {
    this.file = resolve(wikiDir, ENRICH_FILE)
  }

  load(): EnrichFile {
    if (!existsSync(this.file)) return { version: 1, pages: {}, runs: [] }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8"))
      if (!raw || typeof raw !== "object" || typeof raw.pages !== "object" || !Array.isArray(raw.runs)) throw new Error("unexpected shape")
      return { version: 1, pages: raw.pages ?? {}, runs: raw.runs ?? [] }
    } catch (err) {
      return { version: 1, pages: {}, runs: [], unreadable: (err as Error).message }
    }
  }

  save(data: EnrichFile): void {
    if (data.unreadable) throw new Error(`${this.file} could not be read (${data.unreadable}); fix or move it first`)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, pages: data.pages, runs: data.runs.slice(-ENRICH_LIMITS.runsKept) }, null, 2))
    renameSync(tmp, this.file)
  }
}

// --- One run ---

export interface AskReply {
  text: string
  costUsd?: number
  error?: string
}

export interface RunOptions {
  hub: WikiHub
  settings: EnrichSettings
  /** Hands the prompt to the enrichment agent. */
  ask: (prompt: string, e: Entity) => Promise<AskReply>
  /** Records from systems of record for one entity. */
  lookupFacts?: (e: Entity, sources: EnrichSource[]) => Promise<FactLine[]>
  /** Ids, names and persona names of the agents this node knows. */
  agentIds?: string[]
  today?: string
  now?: Date
  dryRun?: boolean
  only?: string
  force?: boolean
  /** Lower than maxPages for this run. */
  limit?: number
  log?: (msg: string) => void
}

export function graphOf(hub: WikiHub, agentNames: string[] = []): WikiGraph {
  const { ontology } = loadOntology(hub.getBaseDir())
  const pages: GraphPage[] = []
  for (const agentId of hub.listAgents([])) {
    for (const article of hub.getAgentWiki(agentId).listAllArticles()) pages.push({ agentId, article })
  }
  return buildGraph(pages, ontology, agentNames)
}

export async function runEnrichment(o: RunOptions): Promise<EnrichRunRecord> {
  const { hub, settings } = o
  const log = o.log ?? (() => {})
  const now = o.now ?? new Date()
  const today = o.today ?? now.toISOString().slice(0, 10)
  const runId = `wiki-enrich/${now.toISOString().replace(/[:.]/g, "-")}`
  const stateStore = new EnrichState(hub.getBaseDir())
  const state = stateStore.load()
  if (state.unreadable && !o.dryRun) throw new Error(`${stateStore.file} could not be read (${state.unreadable}); fix or move it first`)

  const g = graphOf(hub, o.agentIds)
  const entries = settings.sources.includes("entries") ? hub.getSharedStore().listEntries() : []
  const { due, unchanged, givenUp } = pickCandidates(g, entries, state, {
    types: settings.types, maxEntriesPerPage: settings.maxEntriesPerPage, only: o.only, force: o.force,
  })
  const record: EnrichRunRecord = {
    id: runId, at: now.toISOString(), agent: settings.agent, ...(o.dryRun ? { dryRun: true } : {}),
    due: due.length, unchanged, ...(givenUp ? { givenUp } : {}), refreshed: 0, failed: 0, spentUsd: 0, costUnknown: 0, items: [],
  }
  // A limit that is not a whole number of pages is a caller's mistake; it
  // must never lift the page cap (Math.min with NaN is NaN).
  if (o.limit !== undefined && !(Number.isInteger(o.limit) && o.limit >= 1)) throw new Error("limit must be a whole number of pages, 1 or more")
  const maxPages = Math.min(settings.maxPages, o.limit ?? Infinity)
  const factSources = settings.sources.filter(s => FACT_SOURCES.includes(s))
  const agentIds = new Set((o.agentIds ?? []).map(normName))
  const done: Array<{ c: Candidate; item: EnrichRunItem }> = []

  for (const c of due) {
    if (record.items.length >= maxPages) { record.stoppedBy = "max pages"; break }
    const asked = record.items.length - record.costUnknown
    const avg = asked > 0 ? record.spentUsd / asked : 0
    if (settings.maxSpendUsd > 0 && record.spentUsd + avg > settings.maxSpendUsd) { record.stoppedBy = "spend cap"; break }

    const e = c.entity
    const item: EnrichRunItem = { title: e.title, type: e.type, outcome: "failed" }
    record.items.push(item)
    try {
      const facts = factSources.length && o.lookupFacts ? await o.lookupFacts(e, factSources) : []
      const prompt = buildEnrichPrompt({ g, e, entries: c.entries, facts, sources: settings.sources, agentId: settings.agent, today, maxNewEvents: settings.maxNewEvents })
      const reply = await o.ask(prompt, e)
      if (typeof reply.costUsd === "number") { item.costUsd = reply.costUsd; record.spentUsd += reply.costUsd } else record.costUnknown++
      if (reply.error) throw new Error(reply.error)
      const parsed = parseEnrichReply(reply.text, {
        g, e, entryIds: new Set(c.entries.map(en => en.id)), factSources: new Set(facts.map(f => f.source)),
        sources: settings.sources, agentIds, today, maxNewEvents: settings.maxNewEvents,
      })
      if ("error" in parsed) throw new Error(parsed.error)
      item.dropped = parsed.dropped.length
      if (parsed.dropped.length) log(`${e.title}: left out ${parsed.dropped.length}: ${parsed.dropped.slice(0, 3).join("; ")}`)
      if (isEmptyResult(parsed)) {
        item.outcome = "nothing-new"
        item.reason = "the reply held nothing the run could use"
      } else {
        item.statements = parsed.statements.length
        item.events = parsed.newEvents.length
        if (o.dryRun) item.plan = planOf(parsed)
        else {
          const w = applyEnrichment(hub, settings.agent, g, e, parsed, today)
          item.paths = w.paths
          item.events = w.events
          for (const k of w.kept) log(`${e.title}: kept ${k}`)
        }
        item.outcome = "refreshed"
        record.refreshed++
      }
      log(`${e.title}: ${item.outcome}${item.statements ? `, ${item.statements} statements` : ""}${item.events ? `, ${item.events} new events` : ""}`)
    } catch (err) {
      item.outcome = "failed"
      item.reason = String((err as Error)?.message ?? err).slice(0, 300)
      record.failed++
      log(`${e.title}: failed: ${item.reason}`)
    }
    done.push({ c, item })
  }

  if (o.dryRun) return record

  // Signatures after the writes, so the run's own edits do not make the
  // page look changed next time.
  const after = done.some(d => d.item.paths?.length) ? graphOf(hub, o.agentIds) : g
  for (const { c, item } of done) {
    const key = stateKey(c.entity)
    const id = after.names.get(key) ?? c.entity.id
    const e = after.entities.get(id) ?? c.entity
    const failed = item.outcome === "failed"
    const signature = failed ? "" : entitySignature(after, e, matchEntries(e, entries, settings.maxEntriesPerPage))
    // Failures count up only while the inputs stay the same.
    const prev = state.pages[key]
    const failures = failed ? (prev?.outcome === "failed" && prev.failedSignature === c.signature ? (prev.failures ?? 1) : 0) + 1 : 0
    state.pages[key] = {
      title: c.entity.title, type: c.entity.type, signature, at: record.at, runId, outcome: item.outcome,
      ...(item.reason ? { reason: item.reason } : {}), ...(item.costUsd !== undefined ? { costUsd: item.costUsd } : {}),
      ...(failed ? { failures, failedSignature: c.signature } : {}),
    }
  }
  if (after !== g) {
    try { hub.getAgentWiki(settings.agent).rebuildIndex() } catch { /* the catalog catches up on the next rebuild */ }
  }
  state.runs.push(record)
  stateStore.save(state)
  return record
}
