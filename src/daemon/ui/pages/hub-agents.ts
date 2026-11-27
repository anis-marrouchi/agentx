// --- The Hub's left column: every agent, grouped by state (#2101 P4, V1) ---
//
// One agent list (R26), grouped by state in the one order of orca-design
// recipes §9 (the approved side-menu mock, #2101): Needs you (waiting on
// you, then failed today), Working, Done today, Not working today. No
// filter chips and no machine tag (the mock dropped both). Each row is two
// lines: a neutral face (initials) and the name with its age, then the
// state icon and what it is doing. One click opens its chat
// (#page=chat&agent=, which opens its latest conversation); a working
// agent's row opens its live run instead (#2270, #2101 R26). Stop and the
// row menu sit at the row's end on hover or focus, and always on touch.
// The 641-1180 px icon rail draws the same rows as faces (haRailHtml), and
// ⌘K searches the same rows (V3).
//
// Icons are lucide (hub-lucide.ts), handed in as a map `ic` by name, since
// an injected function cannot import.
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

/** working | needs (waiting on you) | failed (its last run today failed) |
 *  done (today) | idle. One set with one icon, word and colour each
 *  (orca-design recipes §9, haStateIcon). */
export type HaState = "working" | "needs" | "failed" | "done" | "idle"

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
  /** When it last moved, ms since 1970; 0 when unknown. */
  at?: number
  /** Questions it has for the owner (not put off). */
  unread: number
  /** The run it is on, when working: for a link to its Task page. */
  taskId: string
  /** How many runs of its own it has going (#2145). The workers a run
   *  started are their own agents' runs, so they count on those rows. */
  runs: number
  /** Runs started today: the finished ones from the snapshot's hourly
   *  counts (haRunsToday) plus the ones going that started since dayStart. */
  today: number
  /** Its other runs going, newest first, each shown under the row (#2328). */
  more?: HaRun[]
  /** Its questions for the owner, oldest first (#2505): the row's title is
   *  the first, its link opens the first, the chat lists them all. */
  asks?: HaAsk[]
  /** ms the oldest of them has waited; -1 when its time is unknown (#2505). */
  askMs?: number
}

/** One question an agent has for the owner (#2505): the Needs you key
 *  (an inbox key or `request:<id>`), its title and when it was asked (ms). */
export interface HaAsk {
  key: string
  title: string
  at: number
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

/** When a run started, ms; 0 when unknown. `haRunAt` is when it last
 *  moved, so "runs today" reads the start itself (#2145). */
export function haRunStart(t: LtTask): number {
  const started = Date.parse((t && t.startedAt) || "")
  return Number.isFinite(started) ? started : 0
}

export interface HaModel {
  rows: HaRow[]
  counts: { all: number; working: number; needs: number; failed: number; done: number; idle: number }
  /** The machines that do not answer: their agents are not listed. */
  down?: string[]
}

/** The face: the first letter of the name's first two words, upper case
 *  ("Dev Session" DS, "graph-agent" GA, "Hakim" H). */
export function haFace(name: unknown): string {
  const words = String(name || "").split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (!words.length) return "?"
  return words.slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("")
}

/**
 * Every agent of every reachable node, one row each (the first up node
 * that has it wins, else the first node). Where an agent counts comes from
 * `work` (wall-tree.ts liveWorkCount, #2260), the same count the "At work
 * now" tree shows, so the two numbers agree: an agent of a node that is
 * checking or answered with an error is listed, never as working.
 * Working: a run is going.
 * Needs you: nothing running, a question for the owner open. Failed:
 * nothing running or asked, and its last run since `dayStart` failed.
 * Done: its last run ended well since `dayStart`. Idle: the rest. Order inside a group:
 * most recent first; Needs you oldest question first, as the Needs you
 * page orders it. `title` names a run (wall-tree.ts ltTitle) and `plain`
 * strips the daemon's markers (ltPlain).
 */
export function hubAgentRows(nodes: LtNode[], needs: HaNeed[], now: number, dayStart: number,
  title: (t: LtTask) => string, plain: (s: unknown) => string, work: LtWorkCount): HaModel {
  // Each agent's questions, oldest first (an unknown time last), so the
  // row's title, its link and the chat's list name the same question (#2505).
  const asked: Record<string, { n: number; title: string; at: number; list: HaAsk[] }> = {}
  for (const q of needs || []) {
    if (!q || q.snoozed || !q.agent) continue
    const a = asked[q.agent] || (asked[q.agent] = { n: 0, title: "", at: 0, list: [] })
    a.list.push({ key: String(q.key || ""), title: String(q.title || "A question"), at: q.at || 0 })
  }
  for (const id in asked) {
    const a = asked[id]
    a.list.sort((x, y) => (x.at || Infinity) - (y.at || Infinity))
    a.n = a.list.length; a.title = a.list[0].title; a.at = a.list[0].at
  }
  const seen: Record<string, boolean> = {}
  const rows: HaRow[] = []
  const down: string[] = []
  for (const n of nodes || []) {
    if (n && n.reachable === false) down.push(n.name || n.url || "A machine")
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
      else if (sumAt && sumAt >= dayStart) {
        const failed = !!a.lastSummary && a.lastSummary.ok === false
        state = failed ? "failed" : "done"
        line = (failed ? "Run failed: " : "") + plain(a.lastSummary && a.lastSummary.text)
      }
      else line = a.lastSummary ? plain(a.lastSummary.text) : ""
      rows.push({
        id: a.id, name: a.name || a.id, node: n.name || n.url || "", nodeUrl: n.url || "",
        color: a.color || null, face: haFace(a.name || a.id), state, line: line.slice(0, 140),
        ageMs: lastAt ? Math.max(0, now - lastAt) : -1, at: lastAt || 0, unread: q ? q.n : 0,
        taskId: t ? t.id : "", runs: runs.length, // hourlyTasks holds only finished runs (persistTaskRecord), so the runs
        // going now that started today are added: a first run shows 1 today.
        today: haRunsToday(a.hourlyTasks, now, dayStart) + runs.filter((r) => haRunStart(r) >= dayStart).length,
        ...(sorted.length > 1 ? { more: sorted.slice(1).map((r) => ({ taskId: r.id, channel: haChannelLabel(r.channel), line: title(r).slice(0, 140) })) } : {}),
        ...(q ? { asks: q.list.map((x) => ({ key: x.key, title: x.title.slice(0, 140), at: x.at })), askMs: q.at ? Math.max(0, now - q.at) : -1 } : {}),
      })
    }
  }
  // The state order of orca-design recipes §9: what needs the owner first.
  const rank: Record<string, number> = { needs: 0, failed: 1, working: 2, done: 3, idle: 4 }
  rows.sort((x, y) => {
    if (x.state !== y.state) return rank[x.state] - rank[y.state]
    if (x.state === "needs") return (asked[x.id].at || Infinity) - (asked[y.id].at || Infinity)
    const ax = x.ageMs < 0 ? Infinity : x.ageMs, ay = y.ageMs < 0 ? Infinity : y.ageMs
    return ax - ay || x.name.localeCompare(y.name)
  })
  const c = { all: 0, working: 0, needs: 0, failed: 0, done: 0, idle: 0 }
  for (const r of rows) c[r.state]++
  c.all = c.working + c.needs + c.failed + c.done
  return { rows, counts: c, ...(down.length ? { down } : {}) }
}

/** An agent's chat link: what a row opens when it has no live run to show
 *  (also the ⌘K switcher and ⌘1…9, #2101 R26). */
export function haChatHref(r: HaRow): string {
  return "#page=chat&agent=" + encodeURIComponent(r.id)
}

/** A state's lucide icon, word and order (orca-design recipes §9). */
export function haStateIcon(state: string, ic?: Record<string, string>, cls?: string): string {
  const name = ({ needs: "circle-alert", failed: "circle-x", working: "loader-circle", done: "circle-check", idle: "circle" } as Record<string, string>)[state] || "circle"
  const svg = (ic && ic[name]) || ""
  return svg ? '<span class="ha__si is-' + state + (cls ? " " + cls : "") + '" aria-hidden="true">' + svg + "</span>" : ""
}

/** A state in words, the same on every page (orca-design C17, C27). */
export function haStateWord(state: string): string {
  return ({ needs: "Waiting on you", failed: "Failed", working: "Working", done: "Done", idle: "Idle" } as Record<string, string>)[state] || "Idle"
}

/** How a list is drawn: a working row's run link, the icons by lucide name
 *  (hub-lucide.ts hubIconMap), and whether rows carry Stop and the row menu
 *  (the Hub's side menu; the phone app's Agents tab has neither). */
export interface HaDraw {
  runHref?: (r: HaRow) => string
  ic?: Record<string, string>
  acts?: boolean
}

/** Where a row goes: a working row its run's Task page, `runHref(row)`
 *  (#2270), as the chat only streams runs started from it; every other
 *  row, and a working row whose run has no link, the agent's chat. */
export function haRowHref(r: HaRow, runHref?: (r: HaRow) => string): string {
  const run = r.state === "working" && r.taskId && runHref ? runHref(r) : ""
  // A Needs you row opens its first question in the chat (#2505).
  const ask = r.state === "needs" && r.asks && r.asks.length && r.asks[0].key ? "&ask=" + encodeURIComponent(r.asks[0].key) : ""
  return run || "#page=chat&agent=" + encodeURIComponent(r.id) + ask
}

/** A Needs you row's words (#2505): "4 for you", and since when the oldest
 *  question waits ("Waiting on you · asked 40m"). Empty for other rows. */
export function haAskWords(r: HaRow, age: (ms: number) => string): { count: string; since: string } {
  if (r.state !== "needs" || !r.unread) return { count: "", since: "" }
  const ms = r.askMs === undefined ? -1 : r.askMs
  return { count: r.unread + " for you", since: "Waiting on you" + (ms >= 0 ? " · asked " + age(ms) : "") }
}

/** One agent row: two lines (name and age; state icon and what it is
 *  doing), then its open questions and, on hover or focus (always on
 *  touch), Stop and the row menu. `cur` is the agent in view. Keyed by
 *  `data-key`, so a refresh patches it in place (hub-nav.client.ts). */
export function haRowHtml(r: HaRow, cur: string, esc: (s: unknown) => string, age: (ms: number) => string, o?: HaDraw): string {
  const d = o || {}
  const ic = d.ic || {}
  const word = haStateWord(r.state)
  const href = haRowHref(r, d.runHref)
  const isRun = href.indexOf("#page=chat&") !== 0
  const when = r.ageMs >= 0
    ? (r.at ? '<time datetime="' + new Date(r.at).toISOString() + '">' : "<time>") + esc(age(r.ageMs)) + "</time>"
    : ""
  // A Needs you row says its numbers in words (#2505): "4 for you" in the
  // chip, and "Waiting on you · asked 40m" under its question.
  // haAskWords, written out: an injected function cannot call one not injected.
  const askOn = r.state === "needs" && !!r.unread, askMs = r.askMs === undefined ? -1 : r.askMs
  const ask = { count: askOn ? r.unread + " for you" : "", since: askOn ? "Waiting on you" + (askMs >= 0 ? " · asked " + age(askMs) : "") : "" }
  const unread = r.unread ? '<b class="ax-af-count ha__n" data-tone="warn" data-n="' + r.unread + '">' + (ask.count ? esc(ask.count) : r.unread + '<span class="ax-sr">' + (r.unread === 1 ? " question" : " questions") + " for you</span>") + "</b>" : ""
  const tip = (s: string) => ' data-tip="' + esc(s) + '"'
  // Its numbers next to its name (#2145): runs going now and runs today,
  // each left out at zero; the words are in the tooltip and for screen
  // readers, so the name keeps its room. A Needs you row leaves them out:
  // what counts there is what waits on the owner (#2505).
  const going = ask.since ? 0 : r.runs || 0, today = ask.since ? 0 : r.today || 0
  const words = [going ? going + " running now" : "", today ? today + (today === 1 ? " run" : " runs") + " today" : ""].filter(Boolean).join(", ")
  const stats = going || today
    ? '<span class="ha__stats"' + tip(words) + ">" +
      (going ? '<span data-stat="now">' + (ic.activity || "") + going + "</span>" : "") +
      (today ? '<span data-stat="today">' + (ic.history || "") + today + "</span>" : "") +
      '<span class="ax-sr">' + esc(words) + "</span></span>"
    : ""
  const acts = d.acts
    ? '<span class="ha__acts">' +
      (r.state === "working" && r.runs ? '<button type="button" class="ha__act" data-ha-stop="' + esc(r.id) + '" aria-label="' + esc("Stop " + (r.runs === 1 ? "the run" : r.runs + " runs") + " of " + r.name) + '"' + tip(r.runs === 1 ? "Stop the run" : "Stop " + r.runs + " runs") + ">" + (ic.square || "") + "</button>" : "") +
      '<button type="button" class="ha__act" data-ha-menu="' + esc(r.id) + '" aria-haspopup="menu" aria-expanded="false" aria-label="' + esc("More for " + r.name) + '"' + tip("More") + ">" + (ic.ellipsis || "") + "</button></span>"
    : ""
  return '<div class="ha__row is-' + r.state + (r.id === cur ? " is-cur" : "") + '" data-key="a:' + esc(r.id) + '" data-ha-agent="' + esc(r.id) + '">' +
    '<a class="ha__link" href="' + esc(href) + '"' + (isRun ? " data-ha-run" : "") + (r.id === cur ? ' aria-current="true"' : "") + ">" +
    '<span class="ha__face" aria-hidden="true">' + esc(r.face) + "</span>" +
    '<span class="ha__txt"><span class="ha__top"><b class="ha__name">' + esc(r.name) + "</b>" + stats + (ask.since ? "" : when) + "</span>" +
    '<span class="ha__line">' + haStateIcon(r.state, ic) + '<span class="ha__lt">' + esc(r.line || (r.state === "idle" ? "Nothing going" : word)) + "</span></span>" +
    (ask.since ? '<span class="ha__since">' + esc(ask.since) + "</span>" : "") + "</span>" +
    '<span class="ax-sr"> (' + word + ")</span></a>" + unread + acts + "</div>" +
    (r.state === "working" ? haRunsHtml(r, esc, d.runHref) : "")
}

/** A working agent's other runs, one line each under its row: the channel
 *  and the run, opening that run (#2328). The first 3, then how many more. */
export function haRunsHtml(r: HaRow, esc: (s: unknown) => string, runHref?: (r: HaRow) => string): string {
  const more = r.more || []
  if (!more.length) return ""
  const shown = more.slice(0, 3).map((x) => {
    const href = runHref ? runHref({ ...r, taskId: x.taskId }) : ""
    const inner = '<b class="ha__rch">' + esc(x.channel || "Run") + "</b> " + esc(x.line || "A run")
    return href ? '<a class="ha__run" href="' + esc(href) + '" data-ha-run>' + inner + "</a>" : '<span class="ha__run">' + inner + "</span>"
  }).join("")
  const rest = more.length > 3 ? '<span class="ha__run is-rest">+' + (more.length - 3) + " more " + (more.length - 3 === 1 ? "run" : "runs") + "</span>" : ""
  return '<div class="ha__runs" role="group" data-key="rr:' + esc(r.id) + '" aria-label="' + esc(r.name) + ' runs">' + shown + rest + "</div>"
}

/** What the reader opened or folded in the side menu, kept per browser.
 *  Needs you and Working start open (the approved orca mock, #2101). */
export interface HaOpen {
  /** Needs you shows its rows (open unless false: what waits on you). */
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

/** The groups, in the state order of orca-design recipes §9: the key its
 *  fold is saved under, the "Show all" key (capped groups), its title and
 *  the states it holds. A failed run sits under Needs you. */
export function haGroups(): Array<{ id: string; fold: string; more: string; label: string; states: string[] }> {
  return [
    { id: "needs", fold: "needs", more: "needsAll", label: "Needs you", states: ["needs", "failed"] },
    { id: "working", fold: "work", more: "working", label: "Working", states: ["working"] },
    { id: "done", fold: "done", more: "", label: "Done today", states: ["done"] },
    { id: "idle", fold: "idle", more: "", label: "Not working today", states: ["idle"] },
  ]
}

/**
 * The grouped list (no chips: the approved mock dropped them). Every group
 * is a fold with its count, the chevron leading the title (orca-design
 * C22): Needs you and Working open unless `open.needs` / `open.work` is
 * false, the others folded
 * unless opened. Needs you and Working show their first 3 rows and
 * "Show all (N)" unless `open.needsAll` / `open.working`. A boolean `open`
 * is the old idleOpen. Every part carries `data-key`, so the side menu
 * patches a refresh in place (hub-nav.client.ts haPatch).
 */
export function haListHtml(m: HaModel, cur: string, open: boolean | HaOpen, esc: (s: unknown) => string, age: (ms: number) => string, o?: HaDraw): string {
  const op: HaOpen = typeof open === "object" && open ? open : { idle: !!open }
  const ic = (o && o.ic) || {}
  // Rows before Show all; here, as an injected function cannot read a module const.
  const cap = 3
  let body = ""
  for (const g of haGroups()) {
    const all = m.rows.filter((r) => g.states.indexOf(r.state) >= 0)
    if (!all.length) continue
    const capped = !!g.more && !op[g.more as keyof HaOpen] && all.length > cap
    const rows = capped ? all.slice(0, cap) : all
    // Working groups by machine, as the "At work now" tree does (#2258):
    // each agent once, on the machine it counts on (hubAgentRows).
    // Keyed by the machine's URL, so two machines with one name stay apart.
    const order: string[] = []
    const byNode: Record<string, HaRow[]> = {}
    for (const r of rows) { const key = r.nodeUrl || r.node; (byNode[key] || (order.push(key), byNode[key] = [])).push(r) }
    const list = g.id === "working" && order.length > 1
      ? order.map((n) => '<h4 class="ha__m" data-key="m:' + esc(n) + '">' + esc(byNode[n][0].node || "?") + ' <span class="ha__hn">' + byNode[n].length + "</span></h4>" + byNode[n].map((r) => haRowHtml(r, cur, esc, age, o)).join("")).join("")
      : rows.map((r) => haRowHtml(r, cur, esc, age, o)).join("")
    const more = g.more && all.length > cap
      ? '<button type="button" class="ha__more" data-key="more:' + g.id + '" data-ha-more="' + g.id + '" aria-expanded="' + !capped + '">' + (capped ? "Show all (" + all.length + ")" : "Show fewer") + "</button>"
      : ""
    // Needs you and Working start open, as in the approved mock; the rest start folded.
    const isOpen = g.id === "needs" || g.id === "working" ? op[g.fold as keyof HaOpen] !== false : !!op[g.fold as keyof HaOpen]
    body += '<details class="ha__fold" data-key="g:' + g.id + '" data-ha-open="' + g.fold + '"' + (isOpen ? " open" : "") + ">" +
      '<summary class="ha__h">' + (ic["chevron-right"] ? '<span class="ha__chev" aria-hidden="true">' + ic["chevron-right"] + "</span>" : "") +
      '<span class="ha__ht">' + g.label + '</span><span class="ha__hn" data-n="' + all.length + '">' + all.length + "</span></summary>" + list + more + "</details>"
  }
  // Empty, with its action (#2152): set the first agent up.
  if (!body) body = '<div class="ax-af-empty" data-key="empty"><strong>No agents yet.</strong><span>An agent answers your messages and runs your work.</span><a class="ax-btn ax-btn--ghost" href="#page=agents">Set up an agent</a></div>'
  return body
}

/** The 641-1180 px icon rail (orca-design C26): every agent as its face
 *  with its state icon on the corner, in the same groups and order as the
 *  list, a hairline between groups. The name, state and line are in its
 *  tooltip and its label. Folds and "Show all" do not apply: the rail is
 *  short enough to list everyone. */
export function haRailHtml(m: HaModel, cur: string, esc: (s: unknown) => string, o?: HaDraw): string {
  const ic = (o && o.ic) || {}
  let html = ""
  for (const g of haGroups()) {
    const rows = m.rows.filter((r) => g.states.indexOf(r.state) >= 0)
    if (!rows.length) continue
    if (html) html += '<hr class="ha__rsep" data-key="rs:' + g.id + '">'
    html += rows.map((r) => {
      const word = haStateWord(r.state)
      const tip = r.name + " · " + word + (r.line ? ": " + r.line : "")
      return '<a class="ha__ri is-' + r.state + (r.id === cur ? " is-cur" : "") + '" data-key="r:' + esc(r.id) + '" href="' + esc(haRowHref(r, o && o.runHref)) + '"' +
        (r.id === cur ? ' aria-current="true"' : "") + ' aria-label="' + esc(r.name + ", " + word) + '" data-tip="' + esc(tip) + '" data-tip-side="right">' +
        '<span class="ha__face" aria-hidden="true">' + esc(r.face) + haStateIcon(r.state, ic, "ha__fsi") + "</span></a>"
    }).join("")
  }
  return html
}

/** The machines that do not answer, said once above the list with where to
 *  look instead (the approved mock; orca-design C15). "" when all answer. */
export function haDownHtml(down: string[] | undefined, esc: (s: unknown) => string, ic?: Record<string, string>): string {
  const d = down || []
  if (!d.length) return ""
  const who = d.length === 1 ? d[0] : d.slice(0, -1).join(", ") + " and " + d[d.length - 1]
  return '<p class="ha__down" data-key="down" role="status">' + ((ic && ic.unplug) || "") + "<span>" + esc(who) + (d.length === 1 ? " is" : " are") +
    ' not answering, so ' + (d.length === 1 ? "its" : "their") + ' agents are not listed. <a href="#page=running">Open Running now</a></span></p>'
}

/** One page the switcher can open (#2101 R22): its nav key, name and link. */
export interface HaPage { key: string; label: string; href: string; icon?: string }

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
    if (!w) return ({ needs: 0, failed: 1, working: 2, done: 3 } as Record<string, number>)[r.state] ?? 4
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

/** The switcher's list. `sel` is the index of the chosen hit (agents, then
 *  requests, then pages). `href` as haRowHref. `o.ic`: the icons (a page
 *  shows its own nav icon, `p.icon`); `o.mod`: the shortcut's modifier
 *  for this platform ("⌘" on a Mac, "Alt+" elsewhere). */
export function haSwitchHtml(hits: HaHits, sel: number, esc: (s: unknown) => string, href?: (r: HaRow) => string, o?: { ic?: Record<string, string>; mod?: string }): string {
  const ic = (o && o.ic) || {}
  const mod = (o && o.mod) || "⌘"
  let i = 0
  let html = ""
  const hit = (cls: string, url: string, inner: string) => {
    const on = i++ === sel
    return '<a class="hk__hit' + cls + (on ? " is-sel" : "") + '" id="hk-h' + (i - 1) + '" role="option" aria-selected="' + on + '" href="' + esc(url) + '" data-hk-i="' + (i - 1) + '">' + inner + "</a>"
  }
  if (hits.agents.length) {
    html += '<h3 class="hk__h">Agents</h3>' + hits.agents.map((r, n) => hit(" is-" + r.state, href ? href(r) : haChatHref(r),
      '<span class="ha__face" aria-hidden="true">' + esc(r.face) + "</span>" +
      '<span class="ha__txt"><b class="ha__name">' + esc(r.name) + "</b>" +
      '<span class="ha__line">' + haStateIcon(r.state, ic) + '<span class="ha__lt">' + esc(r.line || haStateWord(r.state)) + '</span><span class="ax-sr"> (' + haStateWord(r.state) + ")</span></span></span>" +
      (r.unread ? '<b class="ax-af-count" data-tone="warn" data-n="' + r.unread + '">' + r.unread + "</b>" : "") +
      (n < 9 ? '<kbd class="hk__kbd">' + esc(mod) + (n + 1) + "</kbd>" : ""))).join("")
  }
  if (hits.reqs.length) {
    html += '<h3 class="hk__h">Requests</h3>' + hits.reqs.map((r) => hit(" hk__req", "#status=open&post=" + encodeURIComponent(r.id),
      '<span class="hk__ico" aria-hidden="true">' + (ic["message-square-text"] || "") + '</span><span class="ha__txt"><b class="ha__name">' + esc(r.title) + "</b>" +
      '<span class="ha__line"><span class="ha__lt">' + esc(r.sub || r.owner || "") + "</span></span></span>")).join("")
  }
  const pages = hits.pages || []
  if (pages.length) {
    html += '<h3 class="hk__h">Pages</h3>' + pages.map((p) => hit(" hk__page", p.href,
      '<span class="hk__ico" aria-hidden="true">' + (ic[p.icon || ""] || ic["arrow-up-right"] || "") + '</span><span class="ha__txt"><b class="ha__name">' + esc(p.label) + "</b></span>")).join("")
  }
  return html || '<p class="ha__empty">No agent, request or page has these words.</p>'
}

/** How many hits the switcher shows, for the arrow keys. */
export function haHitCount(hits: HaHits | null): number {
  return hits ? hits.agents.length + hits.reqs.length + (hits.pages || []).length : 0
}
