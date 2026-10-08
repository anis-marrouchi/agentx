// --- Bring entity pages up to a full overview, typed facts and history (#820) ---
//
// For each person, organisation, project, place or asset in the typed
// graph, one model call reads every agent's page about it, the event and
// project pages linked to it, and the raw entries the pages came from.
// It returns:
//   - an overview: who they are to us, how it started, what changed, where
//     it stands now;
//   - typed statements (role at, client of, owns…), each with a source;
//   - the event and project pages its History should link to.
// Everything is checked against what the call was shown before one page
// is written through the store, which keeps the old version. Only
// entities whose sources or links changed since the last run are redone,
// and a run stops before the next call once its spending cap is reached.

import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { WikiHub } from "./hub"
import { isWikiArticleType, type WikiArticleMeta, type WikiEntry } from "./types"
import { normName, type Entity, type GraphPage, type WikiGraph } from "./ontology/graph"
import { linkedEntities } from "./ontology/lens"
import { panelFrom, panelSource } from "./ontology/load"
import type { WikiStatement } from "./ontology/types"
import { bodyOf, OVERVIEW_END, overviewSpan } from "./ontology/view-entity"

export const ENRICH_BY = "wiki-enrich"

export const ENRICH_TYPES =["person", "organization", "project", "place", "device", "server", "app", "domain", "account"]

/** Types a person's relation may point at; never an agent (#819). */
const PERSON_RELATION_TYPES = new Set(["person", "organization", "project", "place"])

export interface EnrichContext {
  entity: Entity
  pages: GraphPage[]
  /** Property id → label, the typed relations this type's lens shows. */
  properties: Map<string, string>
  /** Property id → the types its value may be, where the ontology says. */
  ranges: Map<string, string[]>
  /** Other entities the page may name, by title. */
  neighbours: Entity[]
  events: Entity[]
  projects: Entity[]
  entries: WikiEntry[]
  /** Other pages that name the subject in their text, with the passage. */
  mentions: Array<{ page: GraphPage; excerpt: string }>
}

export interface EnrichResult {
  overview: string
  statements: WikiStatement[]
  /** Titles of event and project pages to link. */
  links: string[]
  /** What the checks removed, for the run log. */
  dropped: string[]
}

export interface EnrichState {
  entities: Record<string, { fingerprint: string; at: string; costUsd?: number }>
}

const PAGE_CHARS = 3500
const ENTRY_CHARS = 700

/** Typed properties the entity's lens shows, without plain links. */
export function lensProperties(g: WikiGraph, type: string): Map<string, string> {
  const lens = g.ontology.types.find(t => t.id === type)?.lens ?? []
  const out = new Map<string, string>()
  for (const panel of lens) {
    if (panelSource(panel) !== "statements") continue
    for (const id of panelFrom(panel)) {
      if (id === "related" || out.has(id)) continue
      const def = g.ontology.properties.find(p => p.id === id)
      // An organisation's "people" panel reads role_at from person pages.
      if (def?.domain && !def.domain.includes(type)) continue
      out.set(id, def?.label ?? id.replace(/_/g, " "))
    }
  }
  return out
}

/** Events whose title names the entity, for pages that never linked them. */
function namedIn(g: WikiGraph, e: Entity, type: string): Entity[] {
  const name = normName(e.title)
  if (name.length < 4) return []
  return [...g.entities.values()].filter(x => x.type === type && x.id !== e.id && ` ${normName(x.title)} `.includes(` ${name} `))
}

export function enrichContext(g: WikiGraph, e: Entity, readEntries: (ids: string[]) => WikiEntry[]): EnrichContext {
  const linked = linkedEntities(g, e, null)
  const byId = (list: Entity[]) => [...new Map(list.map(x => [x.id, x])).values()]
  const events = byId([...linked.filter(x => x.type === "event"), ...namedIn(g, e, "event")])
    .sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 30)
  const projects = byId([...linked.filter(x => x.type === "project"), ...namedIn(g, e, "project")]).slice(0, 12)
  const neighbours = linked
    .filter(x => x.type !== "event" && x.type !== "project")
    .filter(x => e.type !== "person" || PERSON_RELATION_TYPES.has(x.type))
    .slice(0, 40)
  const entries = readEntries(e.sources).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14)
  const properties = lensProperties(g, e.type)
  const ranges = new Map<string, string[]>()
  for (const id of properties.keys()) {
    const range = g.ontology.properties.find(p => p.id === id)?.range
    if (range?.length) ranges.set(id, range)
  }
  return { entity: e, pages: e.pages, properties, ranges, neighbours, events, projects, entries, mentions: mentionsOf(g, e) }
}

/** Non-event pages whose text names the subject: what a new or thin page
 *  can be written from. The newest first, a passage around the first hit. */
export function mentionsOf(g: WikiGraph, e: Entity, max = 12): Array<{ page: GraphPage; excerpt: string }> {
  const names = [e.title, ...e.pages.flatMap(p => p.article.meta.aliases ?? [])].filter(n => n.trim().length >= 3)
  if (names.length === 0) return []
  const escaped = names.map(n => n.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped.join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu")
  const out: Array<{ page: GraphPage; excerpt: string; at: string }> = []
  for (const other of g.entities.values()) {
    if (other.id === e.id || other.type === "event") continue
    for (const page of other.pages) {
      const body = bodyOf(page.article.content)
      const m = re.exec(body)
      if (!m) continue
      const start = Math.max(0, m.index - 250)
      out.push({ page, excerpt: body.slice(start, m.index + 450).replace(/\s+/g, " ").trim(), at: page.article.meta.lastUpdated || "" })
      break
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max).map(({ page, excerpt }) => ({ page, excerpt }))
}

/** Changes when the entity gains a source, a page or a linked event. */
export function fingerprint(ctx: EnrichContext): string {
  const parts = [
    ...ctx.pages.map(p => `${p.agentId}/${p.article.path}`),
    ...ctx.entity.sources,
    ...ctx.events.map(x => x.id),
    ...ctx.projects.map(x => x.id),
    ...ctx.mentions.map(m => `${m.page.agentId}/${m.page.article.path}`),
  ].sort()
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16)
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

export function buildEnrichPrompt(ctx: EnrichContext, typeLabel: string, today: string): string {
  const e = ctx.entity
  const lines: string[] = [
    `You are bringing one wiki page up to date. Today is ${today}.`,
    `Subject: "${e.title}" (${typeLabel}).`,
    "",
    "## What the agents' pages say",
  ]
  for (const p of ctx.pages) {
    lines.push(`### page ${p.agentId}/${p.article.path} (updated ${p.article.meta.lastUpdated || "?"})`, clip(bodyOf(p.article.content), PAGE_CHARS), "")
  }
  if (ctx.mentions.length) {
    lines.push("## Other pages that name the subject")
    for (const m of ctx.mentions) lines.push(`### page ${m.page.agentId}/${m.page.article.path}: "${m.page.article.meta.title}"`, m.excerpt, "")
  }
  lines.push("## Source entries (newest first)")
  for (const en of ctx.entries) lines.push(`### entry ${en.id} (${en.date}, ${en.agentId}, ${en.source})`, clip(en.content.trim(), ENTRY_CHARS), "")
  lines.push("## Event pages", ...ctx.events.map(x => `- ${x.date || "?"} · ${x.title}`), "")
  lines.push("## Project pages", ...ctx.projects.map(x => `- ${x.title}`), "")
  lines.push("## Other pages it may name", ...ctx.neighbours.map(x => `- ${x.title} (${x.type})`), "")
  lines.push(
    `## Properties you may use (the subject is always ${e.title})`,
    ...[...ctx.properties].map(([id, label]) => `- ${id}: "${e.title} ${label} <value>"${ctx.ranges.get(id) ? `, value is a ${ctx.ranges.get(id)!.join(" or ")}` : ""}`),
    "",
  )
  lines.push(
    "## Task",
    "Return one JSON object and nothing else:",
    `{"overview": "…", "statements": [{"property": "…", "value": "…", "role": "…", "since": "YYYY-MM-DD", "until": "YYYY-MM-DD", "source": "…"}], "history": ["event page title"], "projects": ["project page title"]}`,
    "",
    "Rules:",
    `- overview: 3 to 6 full sentences telling the story of the relationship: who ${e.title} is to us, how it started, what changed, and where it stands now, with dates. Plain prose. Link pages as [[Exact Title]] only when the title is listed above. Never stop mid-sentence.`,
    "- statements: only facts the pages or entries state. Use only the listed properties. value is a listed page title when it names one, else a short literal. role, since and until only when stated.",
    "- source: the entry id, the page (agent/path) or the event title the fact comes from. A statement without one of these is dropped.",
    "- Do not list an AI agent or bot as a person's relation.",
    "- history: titles of the listed event pages that are about the subject. projects: listed project titles it takes part in.",
    "- Leave out anything you could not verify. Do not write 'unknown' or 'not captured' as a fact.",
    "- Write in the language the pages are written in.",
  )
  return lines.join("\n")
}

/** The JSON object in the reply, fenced or not. */
export function parseEnrichReply(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

const DATE = /^\d{4}-\d{2}(-\d{2})?$/
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

/** Keep only what the call was shown and allowed to write. */
export function checkEnrichment(raw: Record<string, unknown>, ctx: EnrichContext, g: WikiGraph): EnrichResult {
  const dropped: string[] = []
  const e = ctx.entity
  let overview = str(raw.overview)
  if (overview && !/[.!?؟)»"']$/.test(overview)) {
    // A cut-off last sentence is worse than a shorter overview.
    const end = Math.max(overview.lastIndexOf(". "), overview.lastIndexOf("? "), overview.lastIndexOf("! "))
    overview = end > 0 ? overview.slice(0, end + 1) : ""
    dropped.push("overview: unfinished last sentence removed")
  }

  const sourceIds = [
    ...ctx.entries.map(x => x.id),
    ...ctx.pages.map(p => `${p.agentId}/${p.article.path}`),
    ...ctx.pages.map(p => p.article.path),
    ...ctx.mentions.map(m => `${m.page.agentId}/${m.page.article.path}`),
    ...ctx.mentions.map(m => m.page.article.path),
    ...ctx.events.map(x => x.title),
  ]
  const statements: WikiStatement[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(raw.statements) ? raw.statements : []) {
    const s = (item ?? {}) as Record<string, unknown>
    const property = str(s.property)
    const value = str(s.value)
    const source = str(s.source)
    const label = `${property} ${value}`
    if (!ctx.properties.has(property)) { dropped.push(`${label}: property not allowed`); continue }
    if (!value || /^(unknown|not (given|known|captured|recorded))\b/i.test(value)) { dropped.push(`${label}: no value`); continue }
    if (!source || !sourceIds.some(id => source.includes(id))) { dropped.push(`${label}: source not among those given`); continue }
    const targetId = g.names.get(normName(value))
    const target = targetId ? g.entities.get(targetId) : undefined
    if (target?.id === e.id) { dropped.push(`${label}: points at itself`); continue }
    if (e.type === "person" && target?.type === "agent") { dropped.push(`${label}: an agent is not a person's relation`); continue }
    const range = ctx.ranges.get(property)
    if (range && target && !range.includes(target.type)) { dropped.push(`${label}: value is a ${target.type}, expected ${range.join(" or ")}`); continue }
    const key = `${property}\n${normName(value)}`
    if (seen.has(key)) continue
    seen.add(key)
    const st: WikiStatement = { property, value: target?.title ?? value, source: clip(source, 200) }
    const role = str(s.role)
    if (role) st.role = clip(role, 80)
    if (DATE.test(str(s.since))) st.since = str(s.since)
    if (DATE.test(str(s.until))) st.until = str(s.until)
    statements.push(st)
  }

  const allowed = new Map([...ctx.events, ...ctx.projects].map(x => [normName(x.title), x.title]))
  const links: string[] = []
  for (const t of [...(Array.isArray(raw.history) ? raw.history : []), ...(Array.isArray(raw.projects) ? raw.projects : [])]) {
    // The prompt lists events as "date · title"; a reply may copy the date.
    const title = allowed.get(normName(str(t).replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, "")))
    if (title && !links.includes(title)) links.push(title)
    else if (!title && str(t)) dropped.push(`link ${str(t)}: no such page`)
  }
  return { overview, statements, links, dropped }
}

/** Put the overview at the top of the body, replacing an older one. */
export function withOverview(content: string, overview: string): string {
  const section = `## Overview\n\n${overview.trim()}\n\n${OVERVIEW_END}\n`
  const span = overviewSpan(content)
  if (span) {
    const ours = content.slice(span.end, span.after) === OVERVIEW_END
    const followed = /^#{1,2}[ \t]/m.test(content.slice(span.end, span.end + 4))
    // Replace the old text only when its end is certain: this job's
    // marker or a heading. Otherwise keep it below, so nothing is lost.
    const rest = (ours || followed ? content.slice(span.after) : content.slice(span.textStart)).trim()
    return `${content.slice(0, span.start)}${section}${rest ? `\n${rest}\n` : ""}`
  }
  return `${section}\n${content.trim()}\n`
}

/** Page meta with the new statements and links merged in. */
export function mergedMeta(meta: WikiArticleMeta, r: EnrichResult, today: string): WikiArticleMeta {
  const key = (s: WikiStatement) => `${s.property}\n${normName(s.value)}`
  const fresh = new Set(r.statements.map(key))
  // This job's earlier facts are replaced as a whole; others' are kept.
  const statements = [
    ...(meta.statements ?? []).filter(s => s.by !== ENRICH_BY && !fresh.has(key(s))),
    ...r.statements.map(s => ({ ...s, checked_at: today, by: ENRICH_BY })),
  ]
  const related = [...new Set([...(meta.related ?? []), ...r.links])]
  return { ...meta, statements: statements.length ? statements : undefined, related: related.length ? related : undefined, lastUpdated: today }
}

/** The page the result is written to: one this node owns, with the most sources. */
export function targetPage(hub: Pick<WikiHub, "syncedFrom">, e: Entity): GraphPage | undefined {
  return e.pages
    .filter(p => !hub.syncedFrom(p.agentId))
    .sort((a, b) => (b.article.meta.sources?.length ?? 0) - (a.article.meta.sources?.length ?? 0) || b.article.content.length - a.article.content.length)[0]
}

const FOLDERS: Record<string, string> = { person: "people", organization: "organizations", project: "projects", place: "places" }

/**
 * A new page for a thing the wiki only names in other pages, typed with
 * `class` so the graph does not have to guess. The enrichment that
 * follows writes its overview and facts from the pages that mention it.
 * Returns the page path, or null when the owner already has that title.
 */
export function createEntityPage(hub: WikiHub, title: string, type: string, owner: string, today: string): string | null {
  const store = hub.getAgentWiki(owner)
  if (store.listAllArticles().some(a => normName(a.meta.title) === normName(title))) return null
  const path = `${FOLDERS[type] ?? `${type}s`}/${normName(title).replace(/ /g, "-").slice(0, 80) || "page"}.md`
  const legacy = isWikiArticleType(type) ? type : undefined
  const meta: WikiArticleMeta = { title, type: legacy, class: type, tags: [], owner, access: "shared", created: today, lastUpdated: today, sources: [] }
  return store.writeArticle(path, meta, `${title}.\n`, owner) ? path : null
}

export function loadEnrichState(wikiDir: string): EnrichState {
  const file = resolve(wikiDir, "_enrich", "state.json")
  if (!existsSync(file)) return { entities: {} }
  try {
    const v = JSON.parse(readFileSync(file, "utf-8"))
    return v && typeof v.entities === "object" ? v : { entities: {} }
  } catch {
    return { entities: {} }
  }
}

export function saveEnrichState(wikiDir: string, state: EnrichState): void {
  mkdirSync(resolve(wikiDir, "_enrich"), { recursive: true })
  writeFileSync(resolve(wikiDir, "_enrich", "state.json"), JSON.stringify(state, null, 2))
}

export interface EnrichCall {
  (prompt: string): Promise<{ text: string; costUsd: number }>
}

export interface EnrichOptions {
  types: string[]
  /** Entity ids or titles; empty means every entity of the types. */
  only: string[]
  max: number
  maxCostUsd: number
  dryRun: boolean
  /** Redo entities whose sources did not change. */
  force: boolean
  today: string
}

export interface EnrichOutcome {
  entity: string
  title: string
  page?: string
  status: "written" | "dry-run" | "unchanged" | "no-page" | "no-reply" | "nothing-new" | "failed"
  statements: number
  links: number
  overview: boolean
  costUsd: number
  dropped: string[]
  /** Dry runs: the body that would be written, and the facts. */
  preview?: string
  facts?: WikiStatement[]
}

export interface EnrichRun {
  outcomes: EnrichOutcome[]
  costUsd: number
  /** Set when the run stopped at its spending cap. */
  capped: boolean
}

export async function runEnrich(hub: WikiHub, g: WikiGraph, call: EnrichCall, opts: EnrichOptions, state: EnrichState): Promise<EnrichRun> {
  const types = new Set(opts.types)
  const only = new Set(opts.only.map(normName))
  const candidates = [...g.entities.values()]
    .filter(e => types.has(e.type))
    .filter(e => only.size === 0 || only.has(normName(e.id)) || only.has(normName(e.title)))
    .sort((a, b) => b.sources.length + b.pages.length - (a.sources.length + a.pages.length))
  const readEntries = (ids: string[]) => hub.getSharedStore().readEntries(ids)
  const run: EnrichRun = { outcomes: [], costUsd: 0, capped: false }
  let calls = 0

  for (const e of candidates) {
    if (calls >= opts.max) break
    const base = { entity: e.id, title: e.title, statements: 0, links: 0, overview: false, costUsd: 0, dropped: [] as string[] }
    const ctx = enrichContext(g, e, readEntries)
    const fp = fingerprint(ctx)
    if (!opts.force && state.entities[e.id]?.fingerprint === fp) {
      if (only.size) run.outcomes.push({ ...base, status: "unchanged" })
      continue
    }
    const page = targetPage(hub, e)
    if (!page) { run.outcomes.push({ ...base, status: "no-page" }); continue }
    if (run.costUsd >= opts.maxCostUsd) { run.capped = true; break }

    calls++
    const label = g.ontology.types.find(t => t.id === e.type)?.label ?? e.type
    let reply: { text: string; costUsd: number }
    try {
      reply = await call(buildEnrichPrompt(ctx, label, opts.today))
    } catch (err) {
      run.outcomes.push({ ...base, page: `${page.agentId}/${page.article.path}`, status: "failed", dropped: [(err as Error).message.slice(0, 200)] })
      continue
    }
    run.costUsd += reply.costUsd
    const parsed = parseEnrichReply(reply.text)
    const outcome: EnrichOutcome = { ...base, page: `${page.agentId}/${page.article.path}`, status: "no-reply", costUsd: reply.costUsd }
    if (!parsed) { run.outcomes.push(outcome); continue }
    const r = checkEnrichment(parsed, ctx, g)
    Object.assign(outcome, { statements: r.statements.length, links: r.links.length, overview: !!r.overview, dropped: r.dropped })
    if (!r.overview && r.statements.length === 0 && r.links.length === 0) { outcome.status = "nothing-new"; run.outcomes.push(outcome); continue }

    const content = r.overview ? withOverview(page.article.content, r.overview) : page.article.content
    const meta = mergedMeta(page.article.meta, r, opts.today)
    if (opts.dryRun) {
      run.outcomes.push({ ...outcome, status: "dry-run", preview: content, facts: r.statements })
      continue
    }
    const store = hub.getAgentWiki(page.agentId)
    const ok = store.writeArticle(page.article.path, meta, content, page.article.meta.owner || page.agentId)
    if (!ok) { outcome.status = "failed"; outcome.dropped.push("write refused"); run.outcomes.push(outcome); continue }
    store.rebuildIndex()
    state.entities[e.id] = { fingerprint: fp, at: new Date().toISOString(), costUsd: reply.costUsd }
    outcome.status = "written"
    run.outcomes.push(outcome)
  }
  return run
}
