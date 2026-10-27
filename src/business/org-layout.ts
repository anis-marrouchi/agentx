// --- The Org diagram's layout (#1419) ---
//
// Where each box of /org sits, and which lines join them. Members are
// people and agents, keyed "person:<id>" and "agent:<id>"; relations are
// typed. `reports-to` builds the levels: the top row is whoever reports to
// no one, each report sits one row under its boss. The other types are
// drawn between boxes already placed and never move them.
//
// Columns are half-slots: every leaf of the reporting tree gets one slot
// (two half-columns) and a boss is centred over its reports, so two boxes
// never share a cell and the page can place them with a plain CSS grid.

export type OrgMemberKind = "agent" | "person"
export const ORG_RELATION_TYPES = ["reports-to", "dotted-line", "acts-for"] as const
export type OrgRelationType = (typeof ORG_RELATION_TYPES)[number]

export interface OrgRelation {
  /** The member the relation starts from: the report, or the agent acting. */
  from: string
  /** The boss, or the person acted for. */
  to: string
  type: OrgRelationType
}

export interface OrgPlacement {
  key: string
  /** 0 is the top row. */
  level: number
  /** First half-column, from 1; a box spans two. */
  col: number
}

export interface OrgLayout {
  boxes: OrgPlacement[]
  /** The lines to draw. A `reports-to` that would close a loop is left out. */
  edges: OrgRelation[]
  /** Half-columns in the grid. */
  columns: number
  levels: number
}

export function orgKey(kind: OrgMemberKind, id: string): string {
  return `${kind}:${id}`
}

export function layoutOrg(members: Array<{ key: string; name: string }>, relations: OrgRelation[]): OrgLayout {
  const names = new Map(members.map((m) => [m.key, m.name]))
  const byName = (a: string, b: string) => names.get(a)!.localeCompare(names.get(b)!) || a.localeCompare(b)

  // One boss each: the first reports-to wins.
  const boss = new Map<string, string>()
  for (const r of relations) {
    if (r.type === "reports-to" && r.from !== r.to && names.has(r.from) && names.has(r.to) && !boss.has(r.from)) boss.set(r.from, r.to)
  }
  // A boss that reaches back to its report is a loop: both ends go to the top.
  const reaches = (from: string, target: string) => {
    const seen = new Set<string>()
    for (let cur: string | undefined = from; cur && !seen.has(cur); cur = boss.get(cur)) {
      if (cur === target) return true
      seen.add(cur)
    }
    return false
  }
  const kept = new Map([...boss].filter(([report, b]) => !reaches(b, report)))

  const reports = new Map<string, string[]>()
  for (const [report, b] of kept) reports.set(b, [...(reports.get(b) ?? []), report])
  const roots = [...names.keys()].filter((k) => !kept.has(k)).sort(byName)

  const boxes: OrgPlacement[] = []
  let slot = 0
  let levels = 0
  const place = (key: string, level: number): [number, number] => {
    levels = Math.max(levels, level + 1)
    const under = (reports.get(key) ?? []).sort(byName)
    const at = boxes.push({ key, level, col: 0 }) - 1
    let first = slot
    let last = slot
    if (under.length) {
      const spans = under.map((k) => place(k, level + 1))
      first = spans[0][0]
      last = spans[spans.length - 1][1]
    } else slot++
    boxes[at].col = first + last + 1
    return [first, last]
  }
  for (const r of roots) place(r, 0)

  const edges: OrgRelation[] = [...kept].map(([from, to]) => ({ from, to, type: "reports-to" as const }))
  const seen = new Set(edges.map((e) => `${e.type} ${e.from} ${e.to}`))
  for (const r of relations) {
    const id = `${r.type} ${r.from} ${r.to}`
    if (r.type === "reports-to" || !ORG_RELATION_TYPES.includes(r.type) || r.from === r.to || !names.has(r.from) || !names.has(r.to) || seen.has(id)) continue
    seen.add(id)
    edges.push({ from: r.from, to: r.to, type: r.type })
  }
  const order = (t: OrgRelationType) => ORG_RELATION_TYPES.indexOf(t)
  edges.sort((a, b) => order(a.type) - order(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  return { boxes, edges, columns: slot * 2, levels }
}
