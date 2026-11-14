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
  /** "" for this machine, else the peer's name. */
  node?: string
  /** The machine's name, shown when more than one is read. */
  nodeName?: string
}
export interface HubJobRun { runId: string; status: string | null; startedAt: number | null; finishedAt: number | null; costUsd: number | null; error?: string | null }
export interface HubJobDetail { job: HubJob; runs: HubJobRun[]; parent: HubJob | null; children: HubJob[] }
export interface JobLedgerModel {
  /** null while the first read is out. */
  list: HubJob[] | null
  counts: Record<string, number> | null
  total: number
  state: string
  door: string
  /** The job opened, and what was read for it. */
  open: string
  detail: HubJobDetail | null
  detailErr: string
  missed: Array<{ name: string; why: string }>
  error: string
  /** More than one machine is read: rows name theirs. */
  multi: boolean
  now: number
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

/** What a row is called: its headline, else the start of its text. */
export function jlTitle(j: { headline: string | null; text: string; id: string }): string {
  const t = String(j.headline || j.text || "").replace(/\s+/g, " ").trim()
  if (!t) return j.id
  return t.length > 100 ? t.slice(0, 99).trimEnd() + "…" : t
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
export function jlLinkHtml(j: HubJob, node: string): string {
  return '<button type="button" class="wjl__link" data-jlopen="' + jlEsc(j.id) + '" data-jlnode="' + jlEsc(node) + '">' + jlEsc(jlTitle(j)) + "</button>" +
    ' <small>@' + jlEsc(j.assignee) + '</small> <span class="wjl__st is-' + jlTone(j) + '">' + jlEsc(j.status) + "</span>"
}

/** What opens under a row: full text, the tree and the runs. */
export function jlDetailHtml(d: HubJobDetail | null, err: string, node: string, now: number): string {
  if (err) return '<div class="wjl__d"><p role="alert">Could not read this job: ' + jlEsc(err) + ".</p></div>"
  if (!d) return '<div class="wjl__d"><p>Loading…</p></div>'
  const runs = (d.runs || []).map((r) => {
    const live = r.status === "in-flight"
    const took = r.startedAt == null ? "—" : r.finishedAt != null ? jlSpan(r.finishedAt - r.startedAt) : live ? jlSpan(now - r.startedAt) + " so far" : "—"
    return "<tr><td><code>" + jlEsc(r.runId) + "</code></td><td>" + jlEsc(live ? "running" : r.status || "not known") + (r.error ? ' <span class="is-err">' + jlEsc(r.error) + "</span>" : "") + "</td>" +
      "<td>" + (r.startedAt == null ? "—" : '<time datetime="' + jlEsc(new Date(r.startedAt).toISOString()) + '">' + jlSpan(now - r.startedAt) + " ago</time>") + "</td>" +
      "<td>" + took + "</td><td>" + (r.costUsd == null ? "—" : "$" + Number(r.costUsd).toFixed(2)) + "</td></tr>"
  }).join("")
  const kids = d.children || []
  return '<div class="wjl__d">' +
    '<p class="wjl__text">' + jlEsc(d.job.text) + "</p>" +
    (d.parent ? '<p><span class="k">Part of</span> ' + jlLinkHtml(d.parent, node) + "</p>" : "") +
    (kids.length ? '<p class="k">Handed out from this job (' + kids.length + ')</p><ul class="wjl__kids">' + kids.map((c) => "<li>" + jlLinkHtml(c, node) + "</li>").join("") + "</ul>" : "") +
    (runs ? '<div class="wjl__scroll"><table class="wjl__runs"><thead><tr><th>Run</th><th>Status</th><th>Started</th><th>Took</th><th>Cost</th></tr></thead><tbody>' + runs + "</tbody></table></div>"
      : '<p class="k">No run is linked to this job yet.</p>') +
    '<p class="k">Job <code>' + jlEsc(d.job.id) + "</code></p></div>"
}

/** One job: the row, its facts line and, when opened, its details. */
export function jlRowHtml(j: HubJob, o: { open: boolean; detail: HubJobDetail | null; detailErr: string; multi: boolean; now: number }): string {
  const node = j.node || ""
  const home = jlHomeHtml(j.home)
  const facts = [
    "<span>" + jlEsc(j.requester || "not known") + " → @" + jlEsc(j.assignee) + "</span>",
    "<span>" + jlEsc(jlDoorLabel(j.door)) + "</span>",
    home ? "<span>" + home + "</span>" : "",
    j.parentId ? "<span>part of another job</span>" : "",
    o.multi && j.nodeName ? "<span>" + jlEsc(j.nodeName) + "</span>" : "",
    '<span>updated <time datetime="' + jlEsc(new Date(j.updatedAt).toISOString()) + '">' + jlSpan(o.now - j.updatedAt) + " ago</time></span>",
    j.ownerRequest ? '<span><span class="wjl__tag">Your request</span> <a href="#status=open&amp;view=decide" data-dkind="requests">See it in Requests</a></span>' : "",
  ].filter(Boolean).join(" ")
  return '<article class="wjl is-' + jlTone(j) + (o.open ? " is-open" : "") + '">' +
    '<button type="button" class="wjl__row" data-jlopen="' + jlEsc(j.id) + '" data-jlnode="' + jlEsc(node) + '" aria-expanded="' + (o.open ? "true" : "false") + '">' +
    '<span class="wjl__h">' + jlEsc(jlTitle(j)) + "</span>" +
    '<span class="wjl__st is-' + jlTone(j) + '">' + jlEsc(j.status) + "</span></button>" +
    '<p class="wjl__facts">' + facts + "</p>" +
    (o.open ? jlDetailHtml(o.detail, o.detailErr, node, o.now) : "") + "</article>"
}

/** The whole page. */
export function jobLedgerPageHtml(m: JobLedgerModel): string {
  const counts = m.counts
  const chips = jlStates().map((s) => {
    const n = counts ? s[2].reduce((sum, k) => sum + (counts[k] || 0), 0) : null
    return '<button type="button" data-jlstate="' + s[0] + '" class="is-' + s[0] + '" aria-pressed="' + (m.state === s[0] ? "true" : "false") + '">' + s[1] +
      (n == null ? "" : ' <span class="n">' + n + "</span>") + "</button>"
  }).join("")
  const doors = jlDoors().map((d) => '<option value="' + d[0] + '"' + (m.door === d[0] ? " selected" : "") + ">" + d[1] + "</option>").join("")
  const tools = '<div class="wjl__tools"><div class="wjl__chips" role="group" aria-label="Jobs by state">' + chips + "</div>" +
    '<label class="wjl__by">Door <select id="jl-door">' + doors + "</select></label></div>"
  const warn = m.missed.length ? '<p class="wjl__warn" role="status">Not read: ' + m.missed.map((x) => jlEsc(x.name) + " " + jlEsc(x.why)).join("; ") + ".</p>" : ""
  if (m.error) return tools + '<p class="ax-wall__empty" role="alert">Could not read the jobs: ' + jlEsc(m.error) + ". Select Refresh to try again.</p>"
  if (!m.list) return tools + warn + '<p class="ax-wall__empty">Loading…</p>'
  const opts = (j: HubJob) => ({ open: m.open === j.id, detail: m.detail, detailErr: m.detailErr, multi: m.multi, now: m.now })
  // A parent or child opened from a row may not be in this list: it shows on top.
  const away = m.open && !m.list.some((j) => j.id === m.open)
  const top = !away ? "" : m.detail ? jlRowHtml(m.detail.job, opts(m.detail.job))
    : '<article class="wjl is-open">' + jlDetailHtml(null, m.detailErr, "", m.now) + "</article>"
  const empty = m.state === "open" && !m.door ? "No open jobs: no assigned work is unfinished." : "No jobs match this state and door."
  const rows = m.list.map((j) => jlRowHtml(j, opts(j))).join("")
  const more = m.total > m.list.length ? '<p class="wjl__foot">Showing the ' + m.list.length + " most recently active of " + m.total + ".</p>" : ""
  return tools + warn + (top ? '<div class="wjl__list wjl__top">' + top + "</div>" : "") +
    (rows ? '<div class="wjl__list">' + rows + "</div>" : '<p class="ax-wall__empty">' + empty + "</p>") + more
}
