// --- The Jobs page in the Hub (#1861) ---
//
// One row per job of the ledger (src/jobs): a piece of assigned work,
// whatever door it came through. The main thing on a row is its status
// line, which the daemon derives from facts (src/jobs/status.ts) and the
// page shows as sent. Chips pick the state, a select picks the door, and
// a row opens its details: full text, runs, parent and children.
//
// Reads GET /api/admin/job-ledger (jobsHubReply, src/jobs/hub-api.ts).
//
// Shipped to the browser through injectFns, so each function is
// self-contained: the only calls between them are to other injected
// functions of this file. Every piece of job text goes through jlEsc.

/** A job as the API sends it, with the machine that keeps it. */
export interface HubJob {
  id: string
  door: string
  state: string
  status: string
  requester: string | null
  assignee: string
  text: string
  headline: string | null
  home: { kind: string; link: string } | null
  parentId: string | null
  updatedAt: number
  createdAt?: number
  ownerRequest?: boolean
  /** Who a waiting job waits on: "owner" when it waits on the reader. */
  waitingOn?: string | null
  /** The machine its agent runs on, when not the one that keeps this row. */
  peer?: string | null
  /** Its id on that machine, once read from there. */
  remoteId?: string | null
  /** "" for this machine, else the peer's name. */
  node?: string
  /** The machine's name, shown when more than one is read. */
  nodeName?: string
}
export interface HubJobRun { runId: string; status: string | null; startedAt: number | null; finishedAt: number | null; costUsd: number | null; error?: string | null }
export interface HubJobDetail {
  job: HubJob; runs: HubJobRun[]; parent: HubJob | null; children: HubJob[]
  /** A job handed to another machine: the same job as that machine keeps
   *  it, read from there (the tree across machines). */
  remote?: { peer: string; detail: HubJobDetail | null; err: string } | null
}
export interface JobLedgerModel {
  /** null while the first read is out. */
  list: HubJob[] | null
  counts: Record<string, number> | null
  total: number
  state: string
  door: string
  /** The job opened, and what was read for it. */
  open: string
  /** The machine the opened job is on: "" for this one. */
  node?: string
  detail: HubJobDetail | null
  detailErr: string
  missed: Array<{ name: string; why: string }>
  error: string
  /** More than one machine is read: rows name theirs. */
  multi: boolean
  now: number
  /** The queue with its computed times, one line per agent (#1909). Empty
   *  where due times are off. */
  queue?: HubQueueLine[]
  /** Agent id → the name the side menu shows (#2556). Unset: the id. */
  names?: Record<string, string>
}

/** One agent's queue as a machine computes it (src/requests/due-report.ts). */
export interface HubQueueLine { agentId: string; jobs: number; minutes: number; nextEndAt: number; clearsAt: number; factor: number; nodeName?: string }

/** The queue block: one line per agent, its open jobs, their minutes, when
 *  the next ends and when it is clear, and its correction factor. */
export function jlQueueHtml(lines: HubQueueLine[] | undefined, multi: boolean, now: number, names?: Record<string, string>): string {
  if (!lines || !lines.length) return ""
  const at = (ms: number) => '<time datetime="' + jlEsc(new Date(ms).toISOString()) + '">in ' + jlSpan(ms - now) + "</time>"
  const rows = lines.map((q) => "<li><b title=\"" + jlEsc(q.agentId) + "\">" + jlEsc(jlName(q.agentId, names)) + "</b>" + (multi && q.nodeName ? ' <span class="k">' + jlEsc(q.nodeName) + "</span>" : "") +
    " · " + q.jobs + (q.jobs === 1 ? " job" : " jobs") + ", " + jlSpan(q.minutes * 60000) + " of work" +
    " · next ends " + at(q.nextEndAt) + " · clear " + at(q.clearsAt) +
    (q.factor !== 1 ? ' · <span title="its work takes this many times its estimates">correction ×' + jlEsc(q.factor) + "</span>" : "") + "</li>").join("")
  return '<section class="wjl__queue" aria-label="Queue: computed due times per agent"><p class="wjl__qh">Queue <span class="k">computed by the daemon from estimates, priorities and capacity</span></p><ul>' + rows + "</ul></section>"
}

/** HTML-escape text for the page. */
export function jlEsc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
}

/** "40 s", "12 min", "3 h", "2 d": a span of time, as the status lines write it. */
export function jlSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return s + " s"
  const m = Math.round(s / 60)
  if (m < 90) return m + " min"
  const h = Math.round(m / 60)
  return h < 48 ? h + " h" : Math.round(h / 24) + " d"
}

/** One name per agent (#2556, W5): the name the side menu shows, never
 *  `@agent-id`. "owner" is the reader; a schedule says so. */
export function jlName(id: string | null | undefined, names?: Record<string, string>): string {
  const raw = String(id || "").trim()
  if (!raw) return ""
  if (/^(owner|you)$/i.test(raw)) return "you"
  if (/^cron:/.test(raw)) return "schedule " + raw.slice(5)
  const bare = raw.replace(/^agent:/, "")
  const at = bare.indexOf("@")
  const who = at > 0 ? bare.slice(0, at) : bare
  const name = (names && names[who]) || who
  return at > 0 ? name + " on " + bare.slice(at + 1) : name
}

/** A status line in plain words (W6): agent ids as their names, no
 *  dlg-/req-/prm-/job- ids. The line as sent stays in the tooltip. */
export function jlPlain(status: string, names?: Record<string, string>): string {
  let t = String(status || "").replace(/\s*\(?\b(?:dlg|req|prm|job|run)-[A-Za-z0-9_-]+\)?/g, "")
  // Whole ids only: "pm-agent" is not changed inside "xpm-agent".
  if (names) for (const id of Object.keys(names)) {
    if (!id || !names[id] || names[id] === id) continue
    t = t.replace(new RegExp("(^|[^\\w-])" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])", "g"), (_m: string, pre: string) => pre + names[id])
  }
  return t.replace(/\s+([,.:;])/g, "$1").replace(/\s{2,}/g, " ").trim()
}

/** Where a job goes on the open list (W1): it needs the reader, it is
 *  moving, or it is stuck with nobody on it. */
export function jlGroup(j: { state: string; status: string; waitingOn?: string | null }): "you" | "moving" | "stuck" {
  if (j.state === "blocked" || (j.state === "waiting" && /^(owner|you)$/i.test(String(j.waitingOn || "")))) return "you"
  return jlTone(j) === "stalled" ? "stuck" : "moving"
}

/** What would move a blocked or stuck job, in one line (W8). */
export function jlMoves(j: { state: string; status: string; assignee: string; waitingOn?: string | null }, names?: Record<string, string>): string {
  const who = jlName(j.assignee, names)
  if (j.state === "blocked") return "Moves when what it names is cleared; then " + who + " goes on."
  if (j.state === "waiting" && /^(owner|you)$/i.test(String(j.waitingOn || ""))) return "Moves when you answer " + who + "."
  if (jlTone(j) === "stalled") return "Moves when " + who + " picks it up again, or it is closed."
  return ""
}

/** The full local stamp, for a tooltip. */
export function jlStamp(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** The state chips, in order: [key, label, the states it counts]. */
export function jlStates(): Array<[string, string, string[]]> {
  return [
    ["open", "Open", ["working", "continue", "waiting", "blocked", "stalled"]],
    ["working", "Working", ["working"]],
    ["continue", "Sleeping", ["continue"]],
    ["waiting", "Waiting", ["waiting"]],
    ["blocked", "Blocked", ["blocked"]],
    ["stalled", "Stalled", ["stalled"]],
    ["done", "Done", ["done"]],
    ["all", "All", ["working", "continue", "waiting", "blocked", "stalled", "done", "dropped"]],
  ]
}

/** The doors, in order: [key, label]. */
export function jlDoors(): Array<[string, string]> {
  return [["", "All doors"], ["owner", "Owner"], ["a2a", "Agent hand-off"], ["mention", "Issue mention"], ["cron", "Cron"], ["workflow", "Workflow"], ["api", "API"]]
}

export function jlDoorLabel(door: string): string {
  const d = jlDoors().find((x) => x[0] === door)
  return d && door ? d[1] : door || "Owner"
}

/** The tone of a status line. An open job nobody holds reads as stalled. */
export function jlTone(j: { state: string; status: string }): string {
  if (/^nobody on it/.test(j.status || "")) return "stalled"
  return /^(working|continue|waiting|blocked|stalled|done|dropped)$/.test(j.state) ? j.state : "working"
}

/** What a row is called: the headline its sender wrote. Never the start
 *  of its text cut short (#2555): with none, "Untitled job from <who>",
 *  so the gap shows and is counted. */
export function jlTitle(j: { headline: string | null; requester?: string | null; assignee?: string }): string {
  const t = String(j.headline || "").replace(/\s+/g, " ").trim()
  if (t) return t
  const who = String(j.requester || "").replace(/^agent:/, "").replace(/^cron:/, "schedule ").trim()
  return who ? "Untitled job from " + who : "Untitled job for " + (j.assignee || "an agent")
}

/** The title as HTML: muted when the job has no headline. */
export function jlTitleHtml(j: { headline: string | null; requester?: string | null; assignee?: string }): string {
  const untitled = !String(j.headline || "").trim()
  return untitled ? '<span class="wjl__untitled">' + jlEsc(jlTitle(j)) + "</span>" : jlEsc(jlTitle(j))
}

/** The job's home: a link when it is a web address, text otherwise. */
export function jlHomeHtml(home: { kind: string; link: string } | null): string {
  const link = home && String(home.link || "").trim()
  if (!link) return ""
  if (!/^https?:\/\//i.test(link)) return jlEsc(link)
  const short = link.replace(/^https?:\/\//i, "")
  return '<a href="' + jlEsc(link) + '" target="_blank" rel="noopener noreferrer">' + jlEsc(short.length > 60 ? short.slice(0, 59) + "…" : short) + "</a>"
}

/** A button that opens another job: a parent or a child. */
export function jlLinkHtml(j: HubJob, node: string, names?: Record<string, string>): string {
  return '<button type="button" class="wjl__link" data-jlopen="' + jlEsc(j.id) + '" data-jlnode="' + jlEsc(node) + '">' + jlTitleHtml(j) + "</button>" +
    ' <small title="' + jlEsc(j.assignee) + '">' + jlEsc(jlName(j.assignee, names)) + '</small> <span class="wjl__st is-' + jlTone(j) + '" title="' + jlEsc(j.status) + '">' + jlEsc(jlPlain(j.status, names)) + "</span>"
}

/** What opens under a row: full text, the tree and the runs. */
export function jlDetailHtml(d: HubJobDetail | null, err: string, node: string, now: number, names?: Record<string, string>): string {
  if (err) return '<div class="wjl__d"><p role="alert">Could not read this job: ' + jlEsc(err) + ".</p></div>"
  if (!d) return '<div class="wjl__d"><p>Loading…</p></div>'
  const runs = (d.runs || []).map((r) => {
    const live = r.status === "in-flight"
    const took = r.startedAt == null ? "—" : r.finishedAt != null ? jlSpan(r.finishedAt - r.startedAt) : live ? jlSpan(now - r.startedAt) + " so far" : "—"
    return "<tr><td><code>" + jlEsc(r.runId) + "</code></td><td>" + jlEsc(live ? "running" : r.status || "") + (r.error ? ' <span class="is-err">' + jlEsc(r.error) + "</span>" : "") + "</td>" +
      "<td>" + (r.startedAt == null ? "—" : '<time datetime="' + jlEsc(new Date(r.startedAt).toISOString()) + '">' + jlSpan(now - r.startedAt) + " ago</time>") + "</td>" +
      "<td>" + took + "</td><td>" + (r.costUsd == null ? "—" : "$" + Number(r.costUsd).toFixed(2)) + "</td></tr>"
  }).join("")
  const kids = d.children || []
  // The same job on the machine it was handed to: its line there, and
  // what it handed out there. Those open on that machine.
  const far = d.remote
  const farKids = far && far.detail ? far.detail.children || [] : []
  const farHtml = !far ? "" : '<div class="wjl__far"><p class="k">On ' + jlEsc(far.peer) + "</p>" +
    (far.detail
      ? "<p>" + jlLinkHtml(far.detail.job, far.peer, names) + "</p>" +
        (farKids.length ? '<p class="k">Handed out there (' + farKids.length + ')</p><ul class="wjl__kids">' + farKids.map((c) => "<li>" + jlLinkHtml(c, far.peer, names) + "</li>").join("") + "</ul>" : "")
      : "<p>Not read from " + jlEsc(far.peer) + ": " + jlEsc(far.err || "no answer") + ".</p>") + "</div>"
  return '<div class="wjl__d">' +
    '<p class="wjl__text">' + jlEsc(d.job.text) + "</p>" +
    (d.parent ? '<p><span class="k">Part of</span> ' + jlLinkHtml(d.parent, node, names) + "</p>" : "") +
    (kids.length ? '<p class="k">Handed out from this job (' + kids.length + ')</p><ul class="wjl__kids">' + kids.map((c) => "<li>" + jlLinkHtml(c, node, names) + "</li>").join("") + "</ul>" : "") +
    farHtml +
    (runs ?'<div class="wjl__scroll"><table class="wjl__runs"><thead><tr><th>Run</th><th>Status</th><th>Started</th><th>Took</th><th>Cost</th></tr></thead><tbody>' + runs + "</tbody></table></div>"
      : '<p class="k">No run is linked to this job yet.</p>') +
    '<details class="wjl__ids"><summary class="k">Ids</summary><p class="k">Job <code>' + jlEsc(d.job.id) + "</code></p></details></div>"
}

/** One job: the row, its facts line and, when opened, its details. */
export function jlRowHtml(j: HubJob, o: { open: boolean; detail: HubJobDetail | null; detailErr: string; multi: boolean; now: number; names?: Record<string, string> }): string {
  const node = j.node || ""
  const home = jlHomeHtml(j.home)
  const names = o.names
  const who = '<span title="' + jlEsc(j.assignee) + '">' + jlEsc(jlName(j.assignee, names)) + "</span>"
  const facts = [
    // No requester recorded: the line names only the assignee, never "not known".
    "<span>" + (j.requester ? '<span title="' + jlEsc(j.requester) + '">' + jlEsc(jlName(j.requester, names)) + "</span> → " : "") + who + "</span>",
    "<span>" + jlEsc(jlDoorLabel(j.door)) + "</span>",
    home ? "<span>" + home + "</span>" : "",
    j.parentId ? "<span>part of another job</span>" : "",
    o.multi && j.nodeName ? "<span>" + jlEsc(j.nodeName) + "</span>" : "",
    '<span>updated <time datetime="' + jlEsc(new Date(j.updatedAt).toISOString()) + '" title="' + jlEsc(jlStamp(j.updatedAt)) + '">' + jlSpan(o.now - j.updatedAt) + " ago</time></span>",
    j.ownerRequest ? '<span><span class="wjl__tag">Your request</span> <a href="#status=open&amp;view=decide" data-dkind="requests">See it in Requests</a></span>' : "",
  ].filter(Boolean).join(" ")
  const moves = jlMoves(j, names)
  return '<article class="wjl is-' + jlTone(j) + (o.open ? " is-open" : "") + '">' +
    '<button type="button" class="wjl__row" data-jlopen="' + jlEsc(j.id) + '" data-jlnode="' + jlEsc(node) + '" aria-expanded="' + (o.open ? "true" : "false") + '">' +
    '<span class="wjl__h">' + jlTitleHtml(j) + "</span>" +
    '<span class="wjl__st is-' + jlTone(j) + '" title="' + jlEsc(j.status) + '">' + jlEsc(jlPlain(j.status, names)) + "</span></button>" +
    (moves ? '<p class="wjl__moves">' + jlEsc(moves) + "</p>" : "") +
    '<p class="wjl__facts">' + facts + "</p>" +
    (o.open ? jlDetailHtml(o.detail, o.detailErr, node, o.now, names) : "") + "</article>"
}

/** A group of the open list (W1): a fold with its count. A capped group
 *  shows 3 rows, then "Show all (N)" (hub-folds.ts). */
export function jlGroupHtml(key: string, title: string, rows: string[], o: { cap?: boolean; closed?: boolean; empty?: string }): string {
  const body = rows.length ? '<div class="wjl__list"' + (o.cap ? ' data-cap="jobs.' + key + '"' : "") + ">" + rows.join("") + "</div>"
    : '<p class="wjl__none">' + jlEsc(o.empty || "") + "</p>"
  return '<details class="axp-fold wjl__group" data-fold="jobs.' + key + '"' + (o.closed ? ' data-fold-start="closed"' : "") + ' open><summary class="axp-fold__h">' +
    '<span class="axp-fold__t">' + jlEsc(title) + '</span><span class="axp-fold__n">' + rows.length + "</span></summary>" + body + "</details>"
}

/** The whole page. On the open list the work comes first, grouped by
 *  what it needs (W1), and the counts and the queue follow it (W7). A
 *  list the reader picked (another state or a door) keeps its picker on top. */
export function jobLedgerPageHtml(m: JobLedgerModel): string {
  const counts = m.counts
  const names = m.names
  let on = "", onN: number | null = null
  const chips = jlStates().map((s) => {
    const n = counts ? s[2].reduce((sum, k) => sum + (counts[k] || 0), 0) : null
    if (m.state === s[0]) { on = s[1]; onN = n }
    return '<button type="button" data-jlstate="' + s[0] + '" class="is-' + s[0] + '" aria-pressed="' + (m.state === s[0] ? "true" : "false") + '">' + s[1] +
      (n == null ? "" : ' <span class="n">' + n + "</span>") + "</button>"
  }).join("")
  const doors = jlDoors().map((d) => '<option value="' + d[0] + '"' + (m.door === d[0] ? " selected" : "") + ">" + d[1] + "</option>").join("")
  // The chips fold from a header that keeps the state picked and its count (#2352, hub-folds.ts).
  const tools = '<div class="wjl__tools"><details class="axp-fold wjl__fold" data-fold="jobs.states" open><summary class="axp-fold__h"><span class="axp-fold__t">State' + (on ? ": " + on : "") + "</span>" +
    (onN == null ? "" : '<span class="axp-fold__n">' + onN + "</span>") + '</summary><div class="wjl__chips" role="group" aria-label="Jobs by state">' + chips + "</div></details>" +
    '<label class="wjl__by">Door <select id="jl-door">' + doors + "</select></label></div>"
  const warn = m.missed.length ? '<p class="wjl__warn" role="status">Not read: ' + m.missed.map((x) => jlEsc(x.name) + " " + jlEsc(x.why)).join("; ") + ".</p>" : ""
  if (m.error) return '<p class="ax-wall__empty" role="alert">Could not read the jobs: ' + jlEsc(m.error) + ". Select Refresh to try again.</p>" + tools
  if (!m.list) return warn + '<p class="ax-wall__empty">Loading…</p>' + tools
  // A job handed to another machine has the same id on both: the row
  // that is open is the one on the machine it was opened on.
  const isOpen = (j: HubJob) => m.open === j.id && (j.node || "") === (m.node || "")
  const opts = (j: HubJob) => ({ open: isOpen(j), detail: m.detail, detailErr: m.detailErr, multi: m.multi, now: m.now, names })
  // A parent or child opened from a row may not be in this list: it shows on top.
  const away = m.open && !m.list.some(isOpen)
  const top = !away ? "" : m.detail ? jlRowHtml(m.detail.job, opts(m.detail.job))
    : '<article class="wjl is-open">' + jlDetailHtml(null, m.detailErr, "", m.now, names) + "</article>"
  const topHtml = top ? '<div class="wjl__list wjl__top">' + top + "</div>" : ""
  const queue = jlQueueHtml(m.queue, m.multi, m.now, names)
  const more = m.total > m.list.length ? '<p class="wjl__foot">Showing the ' + m.list.length + " most recently active of " + m.total + ".</p>" : ""
  if (m.state === "open" && !m.door) {
    const g: Record<string, string[]> = { you: [], moving: [], stuck: [] }
    for (const j of m.list) g[jlGroup(j)].push(jlRowHtml(j, opts(j)))
    const work = !m.list.length
      ? '<p class="ax-wall__empty">No open jobs. Work shows here as soon as an agent takes it.</p>'
      : jlGroupHtml("you", "Needs you", g.you, { empty: "Nothing waits on you." }) +
        jlGroupHtml("moving", "Moving", g.moving, { cap: true, empty: "Nothing is moving right now." }) +
        (g.stuck.length ? jlGroupHtml("stuck", "Nobody on it", g.stuck, { cap: true, closed: true }) : "")
    return warn + topHtml + work + more + tools + queue
  }
  const empty = m.door ? "No jobs came through this door in this state. Pick All doors to see the rest." : "No jobs in this state. Pick Open to see the work under way."
  const rows = m.list.map((j) => jlRowHtml(j, opts(j))).join("")
  return tools + warn + topHtml + (rows ? '<div class="wjl__list">' + rows + "</div>" : '<p class="ax-wall__empty">' + empty + "</p>") + more + queue
}
