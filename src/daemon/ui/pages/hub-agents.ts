// --- The Hub's left column: every agent, grouped by state (#2101 P4, V1) ---
//
// The v3 mock (V1) opens the Hub with the agents, not the pages: filter
// chips All · Working · Done, then one agent list (R26) grouped Working,
// Needs you and Done today. Needs you is a group, not a chip (R27). Each
// row is a face (letter in the agent's colour, state dot on the corner),
// the agent, its computer, its last line,
// how long ago it moved and how many questions it has for you. One click
// opens its chat (#page=chat&agent=, which opens its latest conversation);
// a working agent's row opens its live run instead (#2270, #2101 R26).
// ⌘K opens a switcher over the same rows (V3).
//
// One model, two readers: the Hub draws it in the browser from what the
// page already polls (/api/live and the Needs you list), and
// GET /api/admin/hub/agents sends the same rows, and GET /api/app/hub/agents
// to the paired phone app (C1a, app-agents.client.ts).
//
// Shipped to the browser through injectFns (see ../inject.ts): each
// function is self-contained and calls only other functions of this file;
// a run's title and plain text come in as arguments (wall-tree.ts ltTitle
// and ltPlain), never through an import.

import type { LtNode, LtTask, LtWorkCount } from "./wall-tree"

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
  /** How many runs it has going: its own and the workers it started (#2145). */
  runs: number
  /** Runs started today, from the snapshot's hourly counts (haRunsToday). */
  today: number
  /** Its other runs going, newest first, each shown under the row (#2328). */
  more?: HaRun[]
}

/** A run of a working agent besides the one its row names (#2328). */
export interface HaRun {
  taskId: string
  /** Where it came from: "Voice", "Agent to agent", … */
  channel: string
  line: string
}

/** Runs started since `dayStart`, from a 24-slot hourly count whose last
 *  slot ends at `now` (registry.ts getHourlySparkline). A slot counts when
 *  any of its hour is today, so a run up to 59 min before midnight can
 *  count; one that started today is never missed (#2145). */
export function haRunsToday(hourly: unknown, now: number, dayStart: number): number {
  if (!Array.isArray(hourly)) return 0
  let n = 0
  for (let i = 0; i < hourly.length; i++) {
    const end = now - (hourly.length - 1 - i) * 3600_000
    const v = Number(hourly[i])
    if (end > dayStart && Number.isFinite(v) && v > 0) n += v
  }
  return n
}

/** A channel, said plainly (as wall-tree.ts ltPlace names them). */
export function haChannelLabel(ch: unknown): string {
  const c = String(ch || "")
  const names: Record<string, string> = { a2a: "Agent to agent", workflow: "Workflow", cron: "Schedule", app: "App chat", requests: "Request", telegram: "Telegram", whatsapp: "WhatsApp", gitlab: "GitLab", github: "GitHub", discord: "Discord", voice: "Voice" }
  return names[c] || c
}

/** When a run last moved, ms: `lastActivity` is the run's last output line
 *  on the daemon, not a time, so it counts only when it parses as one;
 *  else its start (#2328). 0 when neither is known. */
export function haRunAt(t: LtTask): number {
  const moved = Date.parse(t.lastActivity || "")
  if (Number.isFinite(moved)) return moved
  const started = Date.parse(t.startedAt || "")
  return Number.isFinite(started) ? started : 0
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
 * Every agent of every reachable node, one row each (the first up node
 * that has it wins, else the first node). Where an agent counts comes from
 * `work` (wall-tree.ts liveWorkCount, #2260), the same count the "At work
 * now" tree shows, so the two numbers agree: an agent of a node that is
 * checking or answered with an error is listed, never as working.
 * Working: a run is going.
 * Needs you: nothing running, a question for the owner open. Done: its
 * last run ended since `dayStart`. Idle: the rest. Order inside a group:
 * most recent first; Needs you oldest question first, as the Needs you
 * page orders it. `title` names a run (wall-tree.ts ltTitle) and `plain`
 * strips the daemon's markers (ltPlain).
 */
export function hubAgentRows(nodes: LtNode[], needs: HaNeed[], now: number, dayStart: number,
  title: (t: LtTask) => string, plain: (s: unknown) => string, work: LtWorkCount): HaModel {
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
    // wall-tree.ts ltNodeKey: written out, an injected function cannot import.
    const key = String(n.url || n.id || n.name)
    for (const a of n.agents || []) {
      if (!a || !a.id || seen[a.id]) continue
      // An agent an up machine lists has its row there (#2260 C1).
      const home = work.home[a.id]
      if (home && home !== key) continue
      seen[a.id] = true
      // A machine that is checking or answered with an error still lists its
      // agents, but its runs are not counted: they show as not working.
      const runs = (home === key ? (a.runningTasks || []).filter(Boolean) : []) as LtTask[]
      // Newest first; the row names the newest, the others are listed under
      // it, so a voice turn beside an older job still shows (#2328).
      const sorted = runs.slice().sort((x, y) => haRunAt(y) - haRunAt(x))
      const t = sorted[0]
      const q = asked[a.id]
      const sumAt = a.lastSummary ? Date.parse(a.lastSummary.at) || 0 : 0
      const lastAt = t ? haRunAt(t) : Math.max(sumAt, Date.parse(a.lastActive || "") || 0, q && q.at || 0)
      let state: HaState = "idle"
      let line = ""
      // A voice turn says so: it is a live call (#2328).
      if (t) { state = "working"; line = (t.channel === "voice" ? "Voice · " : "") + title(t) }
      else if (q) { state = "needs"; line = q.title }
      else if (sumAt && sumAt >= dayStart) { state = "done"; line = plain(a.lastSummary && a.lastSummary.text) }
      else line = a.lastSummary ? plain(a.lastSummary.text) : ""
      rows.push({
        id: a.id, name: a.name || a.id, node: n.name || n.url || "", nodeUrl: n.url || "",
        color: a.color || null, face: haFace(a.name || a.id), state, line: line.slice(0, 140),
        ageMs: lastAt ? Math.max(0, now - lastAt) : -1, unread: q ? q.n : 0,
        taskId: t ? t.id : "", runs: runs.length, today: haRunsToday(a.hourlyTasks, now, dayStart),
        ...(sorted.length > 1 ? { more: sorted.slice(1).map((r) => ({ taskId: r.id, channel: haChannelLabel(r.channel), line: title(r).slice(0, 140) })) } : {}),
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

/** An agent's chat link: what a row opens when it has no live run to show
 *  (also the ⌘K switcher and ⌘1…9, #2101 R26). */
export function haChatHref(r: HaRow): string {
  return "#page=chat&agent=" + encodeURIComponent(r.id)
}

/** One agent row. `cur` is the agent in view. A working row opens its run's
 *  Task page, `runHref(row)` (#2270): the chat only streams runs started from
 *  it, so a run from another channel left it blank. Every other row, and a
 *  working row whose run has no link, opens the agent's chat. */
export function haRowHtml(r: HaRow, cur: string, esc: (s: unknown) => string, age: (ms: number) => string, runHref?: (r: HaRow) => string): string {
  const word = ({ working: "working", needs: "waiting on you", done: "done today", idle: "idle" } as Record<string, string>)[r.state]
  const bg = r.color && /^#[0-9a-f]{3,8}$/i.test(r.color) ? ' style="--ha-c:' + r.color + '"' : ""
  const when = r.ageMs >= 0 ? "<time>" + esc(age(r.ageMs)) + "</time>" : ""
  const unread = r.unread ? '<b class="ax-af-count" data-tone="warn" data-n="' + r.unread + '" title="' + r.unread + (r.unread === 1 ? " question" : " questions") + ' for you">' + r.unread + "</b>" : ""
  // Its numbers next to its name (#2145): runs going now and runs today, each
  // left out at zero. Needs you is the orange count at the row's end.
  // A lucide icon and the number; the words are in the tooltip and for
  // screen readers, so the name keeps its room in the side menu.
  const going = r.runs || 0, today = r.today || 0
  const svg = (d: string) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>"
  const words = [going ? going + " running now" : "", today ? today + (today === 1 ? " run" : " runs") + " today" : ""].filter(Boolean).join(", ")
  const stats = going || today
    ? '<span class="ha__stats" title="' + esc(words) + '">' +
      (going ? '<span data-stat="now">' + svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>') + going + "</span>" : "") +
      (today ? '<span data-stat="today">' + svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>') + today + "</span>" : "") +
      '<span class="ax-sr">' + esc(words) + "</span></span>"
    : ""
  const run = r.state === "working" && r.taskId && runHref ? runHref(r) : ""
  const href = run ? esc(run) : "#page=chat&amp;agent=" + encodeURIComponent(r.id)
  const opens = run ? ". Opens its live run" : ""
  return '<a class="ha__row is-' + r.state + (r.id === cur ? " is-cur" : "") + '" href="' + href + '" data-ha-agent="' + esc(r.id) + '"' + (run ? " data-ha-run" : "") +
    (r.id === cur ? ' aria-current="true"' : "") + ' title="' + esc(r.name + " on " + r.node + ", " + word + (r.line ? ": " + r.line : "") + opens) + '">' +
    '<span class="ha__face"' + bg + ' aria-hidden="true">' + esc(r.face) + '<i class="ha__dot"></i></span>' +
    '<span class="ha__txt"><span class="ha__top"><b class="ha__name">' + esc(r.name) + "</b>" + (r.node ? '<span class="ha__node">' + esc(r.node) + "</span>" : "") + stats + when + "</span>" +
    '<span class="ha__line">' + esc(r.line || (r.state === "idle" ? "Nothing going" : "")) + "</span></span>" + unread +
    '<span class="ax-sr"> (' + word + ")</span></a>" + (r.state === "working" ? haRunsHtml(r, esc, runHref) : "")
}

/** A working agent's other runs, one line each under its row: the channel
 *  and the run, opening that run (#2328). The first 3, then how many more. */
export function haRunsHtml(r: HaRow, esc: (s: unknown) => string, runHref?: (r: HaRow) => string): string {
  const more = r.more || []
  if (!more.length) return ""
  const shown = more.slice(0, 3).map((x) => {
    const href = runHref ? runHref({ ...r, taskId: x.taskId }) : ""
    const inner = '<b class="ha__rch">' + esc(x.channel || "Run") + "</b> " + esc(x.line || "A run")
    const tip = ' title="' + esc(r.name + ", " + (x.channel || "run") + ": " + x.line + (href ? ". Opens this run" : "")) + '"'
    return href ? '<a class="ha__run" href="' + esc(href) + '" data-ha-run' + tip + ">" + inner + "</a>" : '<span class="ha__run"' + tip + ">" + inner + "</span>"
  }).join("")
  const rest = more.length > 3 ? '<span class="ha__run is-rest">+' + (more.length - 3) + " more " + (more.length - 3 === 1 ? "run" : "runs") + "</span>" : ""
  return '<div class="ha__runs" role="group" aria-label="' + esc(r.name) + ' runs">' + shown + rest + "</div>"
}

/** What the reader opened in the side menu (Anis 2026-11-26): every part
 *  starts closed on a fresh load. */
export interface HaOpen {
  /** Needs you shows its rows (collapsed by default, header shows the count). */
  needs?: boolean
  /** Working shows every row, not the first 3. */
  working?: boolean
  /** Not working today shows its rows. */
  idle?: boolean
  /** Working shows its rows (open unless false: it is the live group). */
  work?: boolean
  /** Done today shows its rows (folded by default: it only grows). */
  done?: boolean
  /** Needs you shows every row, not the first 3. */
  needsAll?: boolean
}

/**
 * The chips and the grouped list. `filter` is all | working | done. Needs
 * you is a group only, not a chip: what waits on the owner shows once in
 * the side menu, here and as Desk's count (#2101 R27). `runHref` links a
 * working row to its run (haRowHtml).
 *
 * So the menu stays short (Anis 2026-11-26): in the All view every group
 * is a fold with its count (Working open unless `open.work === false`,
 * Needs you and Done today closed unless `open.needs` / `open.done`), and
 * Working and Needs you show their first 3 rows and a "Show all (N)"
 * button, unless `open.working` / `open.needsAll`. The Working chip shows
 * every working agent: it is the reader asking for them. A boolean `open`
 * is the old idleOpen.
 */
export function haListHtml(m: HaModel, filter: string, cur: string, open: boolean | HaOpen, esc: (s: unknown) => string, age: (ms: number) => string, runHref?: (r: HaRow) => string): string {
  const o: HaOpen = typeof open === "object" && open ? open : { idle: !!open }
  // Rows before Show all; here, as an injected function cannot read a module const.
  const cap = 3
  const c = m.counts
  // A choice saved before R27 (needs) or unknown shows everything.
  if (filter !== "working" && filter !== "done") filter = "all"
  const chip =(k: string, label: string, n: number) => '<button type="button" class="ha__chip is-' + k + '" data-ha-filter="' + k + '" aria-pressed="' + (filter === k) + '">' +
    (k === "all" ? "" : '<i class="ha__cdot" aria-hidden="true"></i>') + label + " <b>" + n + "</b></button>"
  const chips = '<div class="ha__chips" role="group" aria-label="Show agents">' + chip("all", "All", c.all) + chip("working", "Working", c.working) +
    chip("done", "Done", c.done) + "</div>"
  const groups: Array<[HaState, string]> = [["working", "Working"], ["needs", "Needs you"], ["done", "Done today"]]
  let body = ""
  for (const [k, label] of groups) {
    if (filter !== "all" && filter !== k) continue
    const all = m.rows.filter((r) => r.state === k)
    if (!all.length) continue
    // In the All view (#2352, orca-design C22): every group is a fold with
    // its count, and the live ones (Working, Needs you) show their first 3
    // rows, then Show all (N). A chip is the reader asking for that group:
    // it shows every row, with a plain header.
    const allView = filter === "all"
    const moreKey = k === "working" ? "working" : k === "needs" ? "needsAll" : ""
    const capped = allView && !!moreKey && !o[moreKey as keyof HaOpen] && all.length > cap
    const rows = capped ? all.slice(0, cap) : all
    // Working groups by machine, as the "At work now" tree does (#2258):
    // each agent once, on the machine it counts on (hubAgentRows).
    // Keyed by the machine's URL, so two machines with one name stay apart.
    const order: string[] = []
    const byNode: Record<string, HaRow[]> = {}
    for (const r of rows) { const key = r.nodeUrl || r.node; (byNode[key] || (order.push(key), byNode[key] = [])).push(r) }
    const list = k === "working" && order.length > 1
      ? order.map((n) => '<h4 class="ha__m">' + esc(byNode[n][0].node || "?") + ' <span class="ax-af-count" data-n="' + byNode[n].length + '">' + byNode[n].length + "</span></h4>" + byNode[n].map((r) => haRowHtml(r, cur, esc, age, runHref)).join("")).join("")
      : rows.map((r) => haRowHtml(r, cur, esc, age, runHref)).join("")
    const more = allView && moreKey && all.length > cap
      ? '<button type="button" class="ha__more" data-ha-more="' + k + '" aria-expanded="' + !capped + '">' + (capped ? "Show all (" + all.length + ")" : "Show fewer") + "</button>"
      : ""
    if (!allView) { body += '<h3 class="ha__h">' + label + ' <span class="ax-af-count" data-n="' + all.length + '">' + all.length + "</span></h3>" + list; continue }
    // Working starts open, Needs you and Done today folded.
    const foldKey = k === "working" ? "work" : k
    const isOpen = k === "working" ? o.work !== false : !!o[foldKey as keyof HaOpen]
    body += '<details class="ha__fold" data-ha-open="' + foldKey + '"' + (isOpen ? " open" : "") + '><summary class="ha__h">' + label + ' <span class="ax-af-count" data-n="' + all.length + '">' + all.length + "</span></summary>" + list + more + "</details>"
  }
  const idle = m.rows.filter((r) => r.state === "idle")
  if (filter === "all" && idle.length) {
    body += '<details class="ha__idle ha__fold" data-ha-idle data-ha-open="idle"' + (o.idle ? " open" : "") + '><summary class="ha__h">Not working today <span class="ax-af-count" data-n="' + idle.length + '">' + idle.length + "</span></summary>" +
      idle.map((r) => haRowHtml(r, cur, esc, age, runHref)).join("") + "</details>"
  }
  // Empty, with its action (#2152): back to every agent, or set the first one up.
  if (!body) body = m.rows.length
    ? '<div class="ax-af-empty"><strong>No agent here right now.</strong><span>None of the agents is in this view.</span><button type="button" class="ax-btn ax-btn--ghost" data-ha-filter="all">Show all agents</button></div>'
    : '<div class="ax-af-empty"><strong>No agents yet.</strong><span>An agent answers your messages and runs your work.</span><a class="ax-btn ax-btn--ghost" href="#page=agents">Set up an agent</a></div>'
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

/** The switcher's list. `sel` is the index of the chosen hit (agents, then requests). `href` as haRowHtml. */
export function haSwitchHtml(hits: HaHits, sel: number, esc: (s: unknown) => string, href?: (r: HaRow) => string): string {
  let i = 0
  let html = ""
  if (hits.agents.length) {
    html += '<h3 class="hk__h">Agents</h3>' + hits.agents.map((r, n) => {
      const bg = r.color && /^#[0-9a-f]{3,8}$/i.test(r.color) ? ' style="--ha-c:' + r.color + '"' : ""
      const on = i++ === sel
      return '<a class="hk__hit is-' + r.state + (on ? " is-sel" : "") + '" role="option" aria-selected="' + on + '" href="' + esc(href ? href(r) : haChatHref(r)) + '" data-hk-i="' + (i - 1) + '">' +
        '<span class="ha__face"' + bg + ' aria-hidden="true">' + esc(r.face) + '<i class="ha__dot"></i></span>' +
        '<span class="ha__txt"><span class="ha__top"><b class="ha__name">' + esc(r.name) + '</b><span class="ha__node">' + esc(r.node) + "</span></span>" +
        '<span class="ha__line">' + esc(r.line) + "</span></span>" + (r.unread ? '<b class="ax-af-count" data-tone="warn" data-n="' + r.unread + '">' + r.unread + "</b>" : "") +
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
