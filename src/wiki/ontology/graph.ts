// --- One entity per real thing, across every agent's wiki (#811) ---
//
// Agents each keep their own pages, so the same person or server can
// have several. The graph merges pages that share a name (title or
// alias) into one entity, gives it a type from the ontology, and turns
// statements and plain links into edges both ways. It is rebuilt only
// when a page or the ontology changed.

import type { WikiArticle } from "../types"
import type { WikiHub } from "../hub"
import { classifyPage } from "./classify"
import { rosterMatch, type AgentRoster } from "./roster"
import type { Importance, Ontology, WikiStatement } from "./types"

export interface GraphPage {
  agentId: string
  article: WikiArticle
}

export interface EntityStatement extends WikiStatement {
  /** Entity id of the value when it names a page. */
  target?: string
  page: GraphPage
}

export interface Entity {
  id: string
  type: string
  pillar: string
  title: string
  pages: GraphPage[]
  statements: EntityStatement[]
  /** YYYY-MM-DD: the event date, else the first page's creation date. */
  date: string
  updated: string
  importance: Importance
  rolledUpInto?: string
  /** Raw entry ids the pages were written from. */
  sources: string[]
  /** Why the type needs a person to check it (#819). */
  review?: string
}

export interface Edge {
  from: string
  to: string
  property: string
  statement?: EntityStatement
}

export interface WikiGraph {
  ontology: Ontology
  entities: Map<string, Entity>
  outgoing: Map<string, Edge[]>
  incoming: Map<string, Edge[]>
  /** Normalised name or path → entity id, for links. */
  names: Map<string, string>
}

export function normName(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\.md$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

export function slugify(s: string): string {
  return normName(s).replace(/ /g, "-").slice(0, 80) || "page"
}

const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g

function eventDate(a: WikiArticle): string {
  if (a.meta.date) return a.meta.date
  const base = a.path.split("/").pop() ?? ""
  const fromPath = base.match(/^(\d{4}-\d{2}-\d{2})/)
  if (fromPath) return fromPath[1]
  const fromTitle = a.meta.title.match(/(\d{4}-\d{2}-\d{2})/)
  if (fromTitle) return fromTitle[1]
  return (a.meta.created || a.meta.lastUpdated || "").slice(0, 10)
}

/**
 * Pages named after one of the fleet's agents are agents, not people
 * (#819). A page's own `class` still wins. When the name is also the
 * first name of a person page ("Sam" next to "Sam Lee"), the page keeps
 * its type and is flagged instead of guessed.
 */
function applyRoster(entities: Map<string, Entity>, roster: AgentRoster, o: Ontology): void {
  if (roster.size === 0 || !o.types.some(t => t.id === "agent")) return
  const agentPillar = o.types.find(t => t.id === "agent")!.pillar
  const firstNames = new Set<string>()
  for (const e of entities.values()) {
    const words = normName(e.title).split(" ")
    if (e.type === "person" && words.length > 1) firstNames.add(words[0])
  }
  for (const e of entities.values()) {
    // Only people and untyped pages: a project or client can share an agent's name.
    if ((e.type !== "person" && e.type !== o.fallback_type) || e.pages.some(p => p.article.meta.class)) continue
    const agent = rosterMatch(roster, [e.title])
    if (!agent) {
      // An alias is weaker evidence: a person can have a nickname that is
      // also an agent's name. Flag it, never retype it.
      const byAlias = rosterMatch(roster, e.pages.flatMap(p => p.article.meta.aliases ?? []))
      if (byAlias) e.review ??= `an alias matches agent ${byAlias}; set class on the page to decide`
      continue
    }
    if (e.type === "person" && firstNames.has(normName(e.title))) {
      e.review = `shares a name with agent ${agent} and with a person; set class on the page to decide`
      continue
    }
    e.type = "agent"
    e.pillar = agentPillar
  }
}

/** Build the graph from pages. Pure: tests call it directly. */
export function buildGraph(pages: GraphPage[], o: Ontology, roster: AgentRoster = new Map()): WikiGraph {
  const typeDef = new Map(o.types.map(t => [t.id, t]))
  const names = new Map<string, string>()
  const groups = new Map<string, GraphPage[]>()
  const usedIds = new Set<string>()

  for (const page of pages) {
    const keys = [page.article.meta.title, ...(page.article.meta.aliases ?? [])].map(normName).filter(Boolean)
    if (keys.length === 0) continue
    let id = keys.map(k => names.get(k)).find(Boolean)
    if (!id) {
      id = slugify(page.article.meta.title)
      for (let n = 2; usedIds.has(id); n++) id = `${slugify(page.article.meta.title)}-${n}`
      usedIds.add(id)
      groups.set(id, [])
    }
    groups.get(id)!.push(page)
    for (const k of keys) if (!names.has(k)) names.set(k, id)
    const pathKey = normName(page.article.path)
    if (!names.has(pathKey)) names.set(pathKey, id)
  }

  const entities = new Map<string, Entity>()
  for (const [id, group] of groups) {
    const votes = new Map<string, number>()
    for (const p of group) {
      const t = classifyPage(p.article.meta, p.article.path, o)
      // An explicit class outvotes any number of inferred ones.
      const weight = p.article.meta.class === t ? 1000 : t === o.fallback_type ? 0.5 : 1
      votes.set(t, (votes.get(t) ?? 0) + weight)
    }
    const type = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const first = group[0].article
    const dated = group.map(p => eventDate(p.article)).filter(Boolean).sort()
    const importance = group.map(p => p.article.meta.importance).find(Boolean) ?? o.importance.default
    entities.set(id, {
      id,
      type,
      pillar: typeDef.get(type)?.pillar ?? "topics",
      title: first.meta.title,
      pages: group,
      statements: [],
      date: dated[0] ?? "",
      updated: group.map(p => p.article.meta.lastUpdated || "").sort().pop() ?? "",
      importance: group.some(p => p.article.meta.importance === "major") ? "major" : importance,
      rolledUpInto: group.map(p => p.article.meta.rolledUpInto).find(Boolean),
      sources: [...new Set(group.flatMap(p => p.article.meta.sources ?? []))],
    })
  }
  applyRoster(entities, roster, o)

  const resolveName = (s: string): string | undefined => names.get(normName(s))
  const outgoing = new Map<string, Edge[]>()
  const incoming = new Map<string, Edge[]>()
  const addEdge = (e: Edge): void => {
    if (e.from === e.to) return
    const out = outgoing.get(e.from) ?? []
    if (e.property === "related" && out.some(x => x.to === e.to)) return
    out.push(e)
    outgoing.set(e.from, out)
    const inc = incoming.get(e.to) ?? []
    inc.push(e)
    incoming.set(e.to, inc)
  }

  for (const entity of entities.values()) {
    for (const page of entity.pages) {
      for (const s of page.article.meta.statements ?? []) {
        const st: EntityStatement = { ...s, page, target: resolveName(s.value) }
        entity.statements.push(st)
        if (st.target) addEdge({ from: entity.id, to: st.target, property: s.property, statement: st })
      }
    }
  }
  // Plain links after typed ones, so a typed edge wins over "related".
  for (const entity of entities.values()) {
    for (const page of entity.pages) {
      const linked = new Set(page.article.meta.related ?? [])
      for (const m of page.article.content.matchAll(WIKILINK)) linked.add(m[1].trim())
      for (const name of linked) {
        const to = resolveName(name)
        if (to) addEdge({ from: entity.id, to, property: "related" })
      }
    }
  }
  for (const e of entities.values()) {
    if (e.rolledUpInto) e.rolledUpInto = resolveName(e.rolledUpInto)
  }
  return { ontology: o, entities, outgoing, incoming, names }
}

/** Builds from a hub, reusing the last graph while no page changed. */
export class GraphCache {
  private last: { refs: WikiArticle[]; ontology: Ontology; roster: string; graph: WikiGraph } | null = null

  get(hub: WikiHub, o: Ontology, roster: AgentRoster = new Map()): WikiGraph {
    const pages: GraphPage[] = []
    for (const agentId of hub.listAgents([])) {
      for (const article of hub.getAgentWiki(agentId).listAllArticles()) pages.push({ agentId, article })
    }
    // The store hands back the same objects while files are unchanged.
    const refs = pages.map(p => p.article)
    const rosterKey = [...roster].join("\n")
    const last = this.last
    if (last && last.ontology === o && last.roster === rosterKey && last.refs.length === refs.length && last.refs.every((r, i) => r === refs[i])) {
      return last.graph
    }
    const graph = buildGraph(pages, o, roster)
    this.last = { refs, ontology: o, roster: rosterKey, graph }
    return graph
  }
}
