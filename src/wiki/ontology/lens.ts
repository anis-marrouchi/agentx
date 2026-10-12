// --- Panel contents for an entity, per its type's lens (#811) ---
//
// A lens lists panels; each panel reads one side of the entity from the
// graph. At Z2 a panel shows its first few items, at Z3 all of them.
// This file only selects and orders; the view decides how it looks.

import type { WikiEntry } from "../types"
import type { Entity, EntityStatement, WikiGraph } from "./graph"
import { panelFrom, panelSource } from "./load"
import type { Importance, LensPanel, TypeDef } from "./types"

export interface PanelItem {
  label: string
  /** Entity id when the item is a page. */
  entityId?: string
  /** Type of the other end, for its icon and sub-line. */
  type?: string
  /** Relation labels: property, role. */
  chips: string[]
  sub?: string
  since?: string
  until?: string
  date?: string
  importance?: Importance
  status?: string
  /** Masked at Z2 and Z3; the value shows at Z4 only. */
  private?: boolean
  /** Index in entity.statements, for the Z4 link. */
  statement?: number
}

export interface PanelData {
  def: LensPanel
  title: string
  items: PanelItem[]
  /** Items before paging. */
  total: number
  /** History: minor events folded under the shown ones. */
  folded: PanelItem[]
  /** History: one line per recurring burst of minor events. */
  rollups: string[]
  ownerOnly: boolean
}

export function lensFor(g: WikiGraph, type: string): LensPanel[] {
  return g.ontology.types.find((t: TypeDef) => t.id === type)?.lens ?? [{ panel: "notes", source: "notes", show: 1 }]
}

function propLabel(g: WikiGraph, id: string, inverse: boolean): string {
  const p = g.ontology.properties.find(x => x.id === id)
  if (!p) return id.replace(/_/g, " ")
  return inverse ? (p.inverse ?? p.label) : p.label
}

function byRecent(a: PanelItem, b: PanelItem): number {
  const da = a.until ?? a.date ?? a.since ?? ""
  const db = b.until ?? b.date ?? b.since ?? ""
  if (da !== db) return db.localeCompare(da)
  return a.label.localeCompare(b.label)
}

function statementItem(g: WikiGraph, e: Entity, st: EntityStatement, inverse: boolean, from?: Entity): PanelItem {
  const other = inverse ? from : (st.target ? g.entities.get(st.target) : undefined)
  const chips = [propLabel(g, st.property, inverse)]
  // A long role would squeeze the name out of the row.
  if (st.role) chips.unshift(st.role.length > 40 ? `${st.role.slice(0, 39)}…` : st.role)
  return {
    label: other?.title ?? st.value,
    entityId: other?.id,
    type: other?.type,
    chips,
    since: st.since,
    until: st.until,
    status: st.status,
    private: st.access === "private",
    statement: inverse ? undefined : e.statements.indexOf(st),
    sub: st.note,
  }
}

function statementsPanel(g: WikiGraph, e: Entity, def: LensPanel): PanelItem[] {
  const from = new Set(panelFrom(def))
  const types = def.types ? new Set(def.types) : null
  const items: PanelItem[] = []
  const seen = new Set<string>()
  const keep = (other?: Entity): boolean => !types || (!!other && types.has(other.type))

  for (const st of e.statements) {
    if (!from.has(st.property)) continue
    const other = st.target ? g.entities.get(st.target) : undefined
    if (!keep(other)) continue
    items.push(statementItem(g, e, st, false))
    if (other) seen.add(other.id)
  }
  for (const edge of g.incoming.get(e.id) ?? []) {
    if (!from.has(edge.property)) continue
    const other = g.entities.get(edge.from)
    if (!other || !keep(other)) continue
    if (edge.statement) items.push(statementItem(g, e, edge.statement, true, other))
    else if (!seen.has(other.id)) items.push({ label: other.title, entityId: other.id, type: other.type, chips: [propLabel(g, "related", true)], date: other.updated })
    seen.add(other.id)
  }
  if (from.has("related")) {
    for (const edge of g.outgoing.get(e.id) ?? []) {
      if (edge.property !== "related" || seen.has(edge.to)) continue
      const other = g.entities.get(edge.to)
      if (!other || !keep(other)) continue
      items.push({ label: other.title, entityId: other.id, type: other.type, chips: [propLabel(g, "related", false)], date: other.updated })
      seen.add(other.id)
    }
  }
  // Typed relations first, then plain links; each part newest first.
  const typed = items.filter(i => !i.chips.includes(propLabel(g, "related", false)))
  const plain = items.filter(i => i.chips.includes(propLabel(g, "related", false)))
  return [...typed.sort(byRecent), ...plain.sort(byRecent)]
}

/** Entities linked to `e` either way, of the given types. */
export function linkedEntities(g: WikiGraph, e: Entity, types: Set<string> | null): Entity[] {
  const ids = new Set<string>()
  for (const edge of g.outgoing.get(e.id) ?? []) ids.add(edge.to)
  for (const edge of g.incoming.get(e.id) ?? []) ids.add(edge.from)
  const out: Entity[] = []
  for (const id of ids) {
    const other = g.entities.get(id)
    if (other && (!types || types.has(other.type))) out.push(other)
  }
  return out.sort((a, b) => (b.date || b.updated).localeCompare(a.date || a.updated))
}

function entityItem(other: Entity): PanelItem {
  return { label: other.title, entityId: other.id, type: other.type, chips: [], date: other.date, importance: other.importance }
}

function historyPanel(g: WikiGraph, e: Entity, def: LensPanel): { shown: PanelItem[]; folded: PanelItem[]; rollups: string[] } {
  const events = linkedEntities(g, e, new Set(["event"])).map(entityItem)
  const shownLevels = new Set<Importance>(def.importance ?? ["major", "normal", "minor"])
  const shown = events.filter(i => shownLevels.has(i.importance ?? g.ontology.importance.default))
  const folded = def.fold ? events.filter(i => i.importance === def.fold) : []
  const rollups: string[] = []
  const rule = def.rollup ?? g.ontology.importance.rollup
  if (folded.length >= rule.min && folded[0].date) {
    const newest = Date.parse(folded[0].date)
    const recent = folded.filter(i => i.date && newest - Date.parse(i.date) <= rule.days * 86_400_000)
    if (recent.length >= rule.min) rollups.push(`${recent.length} minor events in ${rule.days} days up to ${folded[0].date}`)
  }
  return { shown, folded, rollups }
}

function readingsPanel(e: Entity, latestOnly: boolean): PanelItem[] {
  const readings = e.statements
    .map((st, i) => ({ st, i }))
    .filter(({ st }) => st.property === "reading" || !!st.metric)
    .sort((a, b) => (b.st.at ?? "").localeCompare(a.st.at ?? ""))
  const seen = new Set<string>()
  const out: PanelItem[] = []
  for (const { st, i } of readings) {
    const metric = st.metric ?? "reading"
    if (latestOnly && seen.has(metric)) continue
    seen.add(metric)
    out.push({ label: `${metric.replace(/_/g, " ")}: ${st.value}`, chips: [], date: st.at, statement: i, private: st.access === "private" })
  }
  return out
}

function discussedPanel(e: Entity, readEntries: (ids: string[]) => WikiEntry[]): PanelItem[] {
  return readEntries(e.sources)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(en => {
      const line = en.content.split("\n").map(l => l.trim()).find(Boolean) ?? ""
      return {
        label: line.length > 120 ? `${line.slice(0, 117)}…` : line,
        chips: [],
        date: en.date,
        // The panel is owner-only as a whole; its rows are not masked.
        sub: `${en.date} · ${en.agentId} · ${en.source}`,
      }
    })
}

export interface PanelOpts {
  full: boolean
  page?: number
  pageSize?: number
  readEntries: (ids: string[]) => WikiEntry[]
}

export function panelData(g: WikiGraph, e: Entity, def: LensPanel, opts: PanelOpts): PanelData {
  const source = panelSource(def)
  let items: PanelItem[] = []
  let folded: PanelItem[] = []
  let rollups: string[] = []
  if (source === "statements") items = statementsPanel(g, e, def)
  else if (source === "linked") items = linkedEntities(g, e, def.types ? new Set(def.types) : null).map(entityItem)
  else if (source === "readings") items = readingsPanel(e, !opts.full && def.latest !== false)
  else if (source === "discussed") items = discussedPanel(e, opts.readEntries)
  else if (source === "history") {
    const h = historyPanel(g, e, def)
    // Z3 shows every level, minor ones unfolded.
    items = opts.full ? linkedEntities(g, e, new Set(["event"])).map(entityItem) : h.shown
    folded = opts.full ? [] : h.folded
    rollups = h.rollups
  }
  const total = items.length
  if (opts.full) {
    const size = opts.pageSize ?? 50
    const page = Math.max(1, opts.page ?? 1)
    items = items.slice((page - 1) * size, page * size)
  } else {
    items = items.slice(0, def.show ?? 5)
  }
  return {
    def,
    title: def.title ?? def.panel.replace(/_/g, " "),
    items,
    total,
    folded,
    rollups,
    ownerOnly: def.access === "owner",
  }
}
