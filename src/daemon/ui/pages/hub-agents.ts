// --- The Hub's left column: every agent, grouped by state (#2101 P4, V1) ---
//
// The v3 mock (V1) opens the Hub with the agents, not the pages: filter
// chips All · Working · Needs you · Done, then the agents grouped Working,
// Needs you and Done today. Each row is a face (letter in the agent's
// colour, state dot on the corner), the agent, its computer, its last line,
// how long ago it moved and how many questions it has for you. One click
// opens its chat (#page=chat&agent=, which opens its latest conversation).
// ⌘K opens a switcher over the same rows (V3).
//
// One model, two readers: the Hub draws it in the browser from what the
// page already polls (/api/live and the Needs you list), and
// GET /api/admin/hub/agents sends the same rows to the phone app (C1a).
//
// Shipped to the browser through injectFns (see ../inject.ts): each
// function is self-contained and calls only other functions of this file;
// a run's title and plain text come in as arguments (wall-tree.ts ltTitle
// and ltPlain), never through an import.

import type { LtNode, LtTask } from "./wall-tree"

/** One thing that waits on the owner, as the Needs you list has it. */
export interface HaNeed {
  key: string
  title?: string
  agent?: string
  /** When it was asked, ms. */
  at?: number
  /** Put off (Later): not counted. */
  snoozed?: number
}

export type HaState = "working" | "needs" | "done" | "idle"

export interface HaRow {
  id: string
  name: string
  /** The computer it runs on (node name). */
  node: string
  nodeUrl: string
  color: string | null
  /** The letter on its face. */
  face: string
  state: HaState
  /** Its last line: the run it is on, the question it asks, or its last summary. */
  line: string
  /** ms since it last moved; -1 when unknown. */
  ageMs: number
  /** Questions it has for the owner (not put off). */
  unread: number
  /** The run it is on, when working: for a link to its Task page. */
  taskId: string
  /** How many runs it has going. */
  runs: number
}

export interface HaModel {
  rows: HaRow[]
  counts: { all: number; working: number; needs: number; done: number; idle: number }
}

/** The face letter: the first letter of the name, upper case. */
export function haFace(name: unknown): string {
  const s = String(name || "").replace(/[^\p{L}\p{N}]/gu, "")
  return s ? s.charAt(0).toUpperCase() : "?"
}

/**
 * Every agent of every node that answers, one row each (the first node
 * that has it wins, as the agent list does). Working: a run is going.
 * Needs you: nothing running, a question for the owner open. Done: its
 * last run ended since `dayStart`. Idle: the rest. Order inside a group:
 * most recent first; Needs you oldest question first, as the Needs you
 * page orders it. `title` names a run (wall-tree.ts ltTitle) and `plain`
 * strips the daemon's markers (ltPlain).
 */
export function hubAgentRows(nodes: LtNode[], needs: HaNeed[], now: number, dayStart: number,
  title: (t: LtTask) => string, plain: (s: unknown) => string): HaModel {
  const asked: Record<string, { n: number; title: string; at: number }> = {}
  for (const q of needs || []) {
    if (!q || q.snoozed || !q.agent) continue
    const a = asked[q.agent] || (asked[q.agent] = { n: 0, title: "", at: 0 })
    a.n++
    const at = q.at || 0
    if (!a.title || (at && (!a.at || at < a.at))) { a.title = String(q.title || "A question"); a.at = at }
  }
  const seen: Record<string, boolean> = {}
  const rows: HaRow[] = []
  for (const n of nodes || []) {
    if (!n || n.reachable === false) continue
    for (const a of n.agents || []) {
      if (!a || !a.id || seen[a.id]) continue
      seen[a.id] = true
      const runs = (a.runningTasks || []).filter(Boolean) as LtTask[]
      const t = runs.slice().sort((x, y) => (Date.parse(y.lastActivity || y.startedAt || "") || 0) - (Date.parse(x.lastActivity || x.startedAt || "") || 0))[0]
      const q = asked[a.id]
      const sumAt = a.lastSummary ? Date.parse(a.lastSummary.at) || 0 : 0
      const lastAt = t ? (Date.parse(t.lastActivity || t.startedAt || "") || 0) : Math.max(sumAt, Date.parse(a.lastActive || "") || 0, q && q.at || 0)
      let state: HaState = "idle"
      let line = ""
      if (t) { state = "working"; line = title(t) }
      else if (q) { state = "needs"; line = q.title }
      else if (sumAt && sumAt >= dayStart) { state = "done"; line = plain(a.lastSummary && a.lastSummary.text) }
      else line = a.lastSummary ? plain(a.lastSummary.text) : ""
      rows.push({
        id: a.id, name: a.name || a.id, node: n.name || n.url || "", nodeUrl: n.url || "",
        color: a.color || null, face: haFace(a.name || a.id), state, line: line.slice(0, 140),
        ageMs: lastAt ? Math.max(0, now - lastAt) : -1, unread: q ? q.n : 0,
        taskId: t ? t.id : "", runs: runs.length,
      })
    }
  }
  const rank: Record<string, number> = { working: 0, needs: 1, done: 2, idle: 3 }
  rows.sort((x, y) => {
    if (x.state !== y.state) return rank[x.state] - rank[y.state]
    if (x.state === "needs") return (asked[x.id].at || Infinity) - (asked[y.id].at || Infinity)
    const ax = x.ageMs < 0 ? Infinity : x.ageMs, ay = y.ageMs < 0 ? Infinity : y.ageMs
    return ax - ay || x.name.localeCompare(y.name)
  })
  const c = { all: 0, working: 0, needs: 0, done: 0, idle: 0 }
  for (const r of rows) c[r.state]++
  c.all = c.working + c.needs + c.done
  return { rows, counts: c }
}

/** One agent row (a link to its chat). `cur` is the agent in view. */
export function haRowHtml(r: HaRow, cur: string, esc: (s: unknown) => string, age: (ms: number) => string): string {
  const word = ({ working: "working", needs: "waiting on you", done: "done today", idle: "idle" } as Record<string, string>)[r.state]
  const bg = r.color && /^#[0-9a-f]{3,8}$/i.test(r.color) ? ' style="--ha-c:' + r.color + '"' : ""
  const when = r.ageMs >= 0 ? "<time>" + esc(age(r.ageMs)) + "</time>" : ""
  const unread = r.unread ? '<b class="ha__n" title="' + r.unread + (r.unread === 1 ? " question" : " questions") + ' for you">' + r.unread + "</b>" : ""
  const busy = r.state === "working" ? '<span class="ha__bar" aria-hidden="true"></span>' : ""
  return '<a class="ha__row is-' + r.state + (r.id === cur ? " is-cur" : "") + '" href="#page=chat&amp;agent=' + encodeURIComponent(r.id) + '" data-ha-agent="' + esc(r.id) + '"' +
    (r.id === cur ? ' aria-current="true"' : "") + ' title="' + esc(r.name + " on " + r.node + ", " + word + (r.line ? ": " + r.line : "")) + '">' +
    '<span class="ha__face"' + bg + ' aria-hidden="true">' + esc(r.face) + '<i class="ha__dot"></i></span>' +
    '<span class="ha__txt"><span class="ha__top"><b class="ha__name">' + esc(r.name) + "</b>" + (r.node ? '<span class="ha__node">' + esc(r.node) + "</span>" : "") + when + "</span>" +
    '<span class="ha__line">' + esc(r.line || (r.state === "idle" ? "Nothing going" : "")) + "</span>" + busy + "</span>" + unread +
    '<span class="ax-sr"> (' + word + ")</span></a>"
}

/** The chips and the grouped list. `filter` is all | working | needs | done. */
export function haListHtml(m: HaModel, filter: string, cur: string, idleOpen: boolean, esc: (s: unknown) => string, age: (ms: number) => string): string {
  const c = m.counts
  const chip = (k: string, label: string, n: number) => '<button type="button" class="ha__chip is-' + k + '" data-ha-filter="' + k + '" aria-pressed="' + (filter === k) + '">' +
    (k === "all" ? "" : '<i class="ha__cdot" aria-hidden="true"></i>') + label + " <b>" + n + "</b></button>"
  const chips = '<div class="ha__chips" role="group" aria-label="Show agents">' + chip("all", "All", c.all) + chip("working", "Working", c.working) +
    chip("needs", "Needs you", c.needs) + chip("done", "Done", c.done) + "</div>"
  const groups: Array<[HaState, string]> = [["working", "Working"], ["needs", "Needs you"], ["done", "Done today"]]
  let body = ""
  for (const [k, label] of groups) {
    if (filter !== "all" && filter !== k) continue
    const rows = m.rows.filter((r) => r.state === k)
    if (!rows.length) continue
    body += '<h3 class="ha__h">' + label + " <span>" + rows.length + "</span></h3>" + rows.map((r) => haRowHtml(r, cur, esc, age)).join("")
  }
  const idle = m.rows.filter((r) => r.state === "idle")
  if (filter === "all" && idle.length) {
    body += '<details class="ha__idle" data-ha-idle' + (idleOpen ? " open" : "") + '><summary class="ha__h">Not working today <span>' + idle.length + "</span></summary>" +
      idle.map((r) => haRowHtml(r, cur, esc, age)).join("") + "</details>"
  }
  if (!body) body = '<p class="ha__empty">' + (m.rows.length ? "No agent here right now." : "No agents yet.") + "</p>"
  return chips + body
}

/** One page the switcher can open (#2101 R22): its nav key, name and link. */
export interface HaPage { key: string; label: string; href: string }

/** What the switcher lists: agents, then requests, then pages. */
export interface HaHits { agents: HaRow[]; reqs: HaReq[]; pages?: HaPage[] }

/** One request the switcher can open, from the Hub posts. */
export interface HaReq { id: string; title: string; owner?: string; sub?: string }

/** Lower case, accents and spaces folded, for the switcher's match. */
export function haFold(s: unknown): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim()
}

/**
 * The ⌘K switcher's hits (V3): agents first (name or id starts with the
 * words first, then contains them; the agents that need you on top when
 * there are no words), then up to five requests whose title has them.
 */
export function haSwitchHits(rows: HaRow[], reqs: HaReq[], q: string, pages: HaPage[] = []): HaHits {
  const w = haFold(q)
  const score = (r: HaRow) => {
    if (!w) return r.state === "needs" ? 0 : r.state === "working" ? 1 : r.state === "done" ? 2 : 3
    const n = haFold(r.name), id = haFold(r.id)
    if (n.indexOf(w) === 0 || id.indexOf(w) === 0) return 0
    if (n.indexOf(w) >= 0 || id.indexOf(w) >= 0) return 1
    if (haFold(r.line).indexOf(w) >= 0) return 2
    return -1
  }
  const agents = (rows || []).map((r) => ({ r, s: score(r) })).filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || b.r.unread - a.r.unread).map((x) => x.r).slice(0, 9)
  const hits = w ? (reqs || []).filter((r) => haFold(r.title).indexOf(w) >= 0 || haFold(r.id) === w).slice(0, 5) : (reqs || []).slice(0, 3)
  // Pages (#2101 R22): the side menu keeps only Desk, Jobs, Workflows,
  // Mobile and Settings; every other page is here, by its name.
  const pageHits = w ? (pages || []).filter((p) => haFold(p.label).indexOf(w) >= 0 || haFold(p.key).indexOf(w) === 0) : (pages || [])
  return { agents, reqs: hits, pages: pageHits }
}

/** The switcher's list. `sel` is the index of the chosen hit (agents, then requests). */
export function haSwitchHtml(hits: HaHits, sel: number, esc: (s: unknown) => string): string {
  let i = 0
  let html = ""
  if (hits.agents.length) {
    html += '<h3 class="hk__h">Agents</h3>' + hits.agents.map((r, n) => {
      const bg = r.color && /^#[0-9a-f]{3,8}$/i.test(r.color) ? ' style="--ha-c:' + r.color + '"' : ""
      const on = i++ === sel
      return '<a class="hk__hit is-' + r.state + (on ? " is-sel" : "") + '" role="option" aria-selected="' + on + '" href="#page=chat&amp;agent=' + encodeURIComponent(r.id) + '" data-hk-i="' + (i - 1) + '">' +
        '<span class="ha__face"' + bg + ' aria-hidden="true">' + esc(r.face) + '<i class="ha__dot"></i></span>' +
        '<span class="ha__txt"><span class="ha__top"><b class="ha__name">' + esc(r.name) + '</b><span class="ha__node">' + esc(r.node) + "</span></span>" +
        '<span class="ha__line">' + esc(r.line) + "</span></span>" + (r.unread ? '<b class="ha__n">' + r.unread + "</b>" : "") +
        (n < 9 ? '<kbd class="hk__kbd">⌘' + (n + 1) + "</kbd>" : "") + "</a>"
    }).join("")
  }
  if (hits.reqs.length) {
    html += '<h3 class="hk__h">Requests</h3>' + hits.reqs.map((r) => {
      const on = i++ === sel
      return '<a class="hk__hit hk__req' + (on ? " is-sel" : "") + '" role="option" aria-selected="' + on + '" href="#status=open&amp;post=' + encodeURIComponent(r.id) + '" data-hk-i="' + (i - 1) + '">' +
        '<span class="hk__ico" aria-hidden="true">≡</span><span class="ha__txt"><b class="ha__name">' + esc(r.title) + "</b>" +
        '<span class="ha__line">' + esc(r.sub || r.owner || "") + "</span></span></a>"
    }).join("")
  }
  const pages = hits.pages || []
  if (pages.length) {
    html += '<h3 class="hk__h">Pages</h3>' + pages.map((p) => {
      const on = i++ === sel
      return '<a class="hk__hit hk__page' + (on ? " is-sel" : "") + '" role="option" aria-selected="' + on + '" href="' + esc(p.href) + '" data-hk-i="' + (i - 1) + '">' +
        '<span class="hk__ico" aria-hidden="true">↗</span><span class="ha__txt"><b class="ha__name">' + esc(p.label) + "</b></span></a>"
    }).join("")
  }
  return html || '<p class="ha__empty">No agent, request or page has these words.</p>'
}

/** How many hits the switcher shows, for the arrow keys. */
export function haHitCount(hits: HaHits | null): number {
  return hits ? hits.agents.length + hits.reqs.length + (hits.pages || []).length : 0
}
