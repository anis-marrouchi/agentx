// --- Who the Org page shows: Everyone, People or Agents (#1681, item 6) ---
//
// A switch on the Chart and Departments views of /org and the Hub's Org
// page. Members are keyed like relations: "person:<id>" is a person, any
// other key ("agent:<id>", "agent:<node>/<id>") an agent. The cards are
// filtered before layout: a hidden card's reports move up to its nearest
// shown boss, so the chart keeps its shape with no gap and no orphan. In
// the Departments view a hidden head becomes a text line.
//
// The pages run these in the browser too (injectFns), so they stay
// self-contained: no import used at run time.

export type OrgWho = "everyone" | "people" | "agents"

/** The setting from a link's `who=`: "people", "agents", else "everyone". */
export function orgWhoOf(raw: string | null | undefined): OrgWho {
  return raw === "people" || raw === "agents" ? raw : "everyone"
}

/** Does `who` show the member keyed `key`? */
export function orgWhoKeeps(key: string, who: OrgWho): boolean {
  if (who !== "people" && who !== "agents") return true
  return (who === "people") === (String(key).indexOf("person:") === 0)
}

/** The members `who` shows, in their order, each with its nearest shown
 *  reports-to boss: a hidden boss is skipped, however deep the chain, and a
 *  member with no shown boss above it goes to the top. A loop ends the climb. */
export function orgWhoFilter(members: Array<{ key: string; boss?: string }>, who: OrgWho): Array<{ key: string; boss?: string }> {
  const bossOf = new Map(members.map((m) => [m.key, m.boss]))
  const out: Array<{ key: string; boss?: string }> = []
  for (const m of members) {
    if (!orgWhoKeeps(m.key, who)) continue
    const seen = new Set([m.key])
    let boss = m.boss
    while (boss && !seen.has(boss) && bossOf.has(boss) && !orgWhoKeeps(boss, who)) {
      seen.add(boss)
      boss = bossOf.get(boss)
    }
    out.push(boss && !seen.has(boss) && bossOf.has(boss) ? { key: m.key, boss } : { key: m.key })
  }
  return out
}

/** One department box as `who` shows it: the head's card, or `hiddenHead`
 *  (its key) for a text line when the switch hides it; members and also-
 *  members filtered; `shown` of `total` counts the head and the members. */
export interface OrgWhoBox {
  id: string
  name: string
  head?: string
  hiddenHead?: string
  members: string[]
  also?: Array<{ key: string; home: string }>
  shown: number
  total: number
}

/** The Departments view (departmentBoxes) as `who` shows it. `restTotal` is
 *  how many "Not in a department" holds before the filter. */
export function orgWhoDepartments(
  by: { boxes: Array<{ id: string; name: string; head?: string; members: string[]; also?: Array<{ key: string; home: string }> }>; rest: string[] },
  who: OrgWho,
): { boxes: OrgWhoBox[]; rest: string[]; restTotal: number } {
  const keeps = (k: string) => orgWhoKeeps(k, who)
  const boxes = (by.boxes || []).map((dep) => {
    const members = dep.members.filter(keeps)
    const also = (dep.also || []).filter((a) => keeps(a.key))
    const head = dep.head && keeps(dep.head) ? dep.head : undefined
    return {
      id: dep.id, name: dep.name,
      ...(head ? { head } : {}), ...(dep.head && !head ? { hiddenHead: dep.head } : {}),
      members, ...(also.length ? { also } : {}),
      shown: members.length + (head ? 1 : 0), total: dep.members.length + (dep.head ? 1 : 0),
    }
  })
  return { boxes, rest: (by.rest || []).filter(keeps), restTotal: (by.rest || []).length }
}
