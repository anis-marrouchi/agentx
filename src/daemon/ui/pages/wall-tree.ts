// --- The live sidebar tree in the Hub (#2101 PR 1c) ---
//
// Anis, 2026-11-23: the main part is "that visibility and those icons, and
// these loading or animated progress about agents that are active, right
// from the sidebar" (Orca's chat mode). So the Hub's left column opens with
// a tree of the whole fleet at work:
//
//   machine (count badge) → project → work item → one row per agent run
//
// Each agent row carries its provider icon, a short task title, the model
// and how long ago it moved ("now", "3m", "2h"); a spinner while it works,
// a green dot once it is done or idle: every agent of a machine that answers
// has a row, idle ones folded under "N idle", so the whole fleet can be
// seen without opening a chat (Anis's scope, Hakim post-merge review of
// #2138). Order in a machine: working, done in the last hour, idle. A
// machine that does not answer says "not checked" (C3 of the v4 review):
// its rows are not shown as idle.
//
// Reads only what the page already has: the live snapshot (/api/live and
// /api/live/stream, every 2 s) for the runs, and the Hub posts (requests)
// for a run's project and title. No new SQL, no new route.
//
// Shipped to the browser through injectFns, so each function is
// self-contained: the only calls between them are to other injected
// functions of this file, never to an import (it would not be bound in
// the browser, see ../inject.ts).
// Every piece of fleet text goes through ltEsc.

/** One run on one agent, as the live snapshot sends it. */
export interface LtTask {
  id: string
  traceId?: string
  messagePreview?: string
  channel?: string
  chatId?: string
  sender?: string
  startedAt?: string
  lastActivity?: string
  /** The run that started it, and the workers it started (#2145,
   *  wall-tree-workers.ts). */
  parent?: { taskId: string; agentId: string; node?: string }
  workers?: import("./wall-tree-workers").LtWorkerIn[]
}
export interface LtAgent {
  id: string
  name?: string
  model?: string
  color?: string
  lastActive?: string
  lastSummary?: { text: string; at: string; ok: boolean }
  runningTasks?: LtTask[]
}
export interface LtNode {
  id?: string
  name: string
  url?: string
  reachable?: boolean
  error?: string
  checking?: boolean
  agents?: LtAgent[]
}
/** The few fields of a Hub post the tree reads. */
export interface LtPost {
  id: string
  headline?: string
  project?: string | null
  repo?: string | null
  home?: string | null
  owner?: string
  group?: { channel?: string; chatId?: string } | null
}

export interface LtRow {
  agentId: string
  agentName: string
  color: string | null
  model: string
  provider: string
  title: string
  /** ms since it last moved; -1 when it never did (an idle agent). */
  ageMs: number
  state: "working" | "done" | "idle"
  /** The run, for a link to its Task page; none on a done or idle row. */
  task: LtTask | null
  /** What the run started (ltAddWorkers, #2145). */
  workers?: import("./wall-tree-workers").LtWorker[]
}
export interface LtItem { key: string; label: string; rows: LtRow[] }
export interface LtProject { key: string; label: string; items: LtItem[] }
export interface LtMachine {
  key: string
  name: string
  url: string
  /** up, checking (slow, asked again) or silent (does not answer: "not checked"). */
  state: "up" | "checking" | "silent"
  error: string
  working: number
  projects: LtProject[]
  /** Agents that finished in the last hour, with nothing running now. */
  done: LtRow[]
  /** Every other agent: nothing running, nothing in the last hour. */
  idle: LtRow[]
}

/** Escape for HTML text and attributes. */
export function ltEsc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
}

/** A text without the daemon's [agentx:…] markers (a preview may be cut
 *  inside one), first line only. The full wording is plainMarkerText's;
 *  the tree only needs the words that are left. */
export function ltPlain(text: unknown): string {
  return String(text == null ? "" : text).replace(/\[agentx:[^\]\n]*(?:\]|$)/gm, "").trim().split("\n")[0].trim()
}

/** How long ago, short: "now" under a minute, then 4m, 3h, 2d. */
export function ltAge(ms: number): string {
  if (!(ms >= 0) || ms < 60_000) return "now"
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + "m"
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h"
  return Math.floor(ms / 86_400_000) + "d"
}

/** The model, short: claude-opus-5-5 → opus-5.5; others as they are. */
export function ltModel(model: unknown): string {
  const m = String(model || "")
  const c = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m)
  if (c) return c[1] + "-" + c[2] + (c[3] ? "." + c[3] : "")
  return m
}

/** Which provider runs the model, for its icon. */
export function ltProvider(model: unknown): string {
  const m = String(model || "").toLowerCase()
  if (/^claude|^anthropic|opus|sonnet|haiku|fable/.test(m)) return "anthropic"
  if (/^gpt|^o\d|codex|openai/.test(m)) return "openai"
  if (/gemini|google/.test(m)) return "google"
  return "other"
}

/** The request a run works for: its chat on the requests channel, or
 *  the id= of a marker in its message (plan steps, reopened requests). */
export function ltRequestId(t: LtTask): string {
  if (t.channel === "requests" && t.chatId) return t.chatId
  const m = /\[agentx:[a-z-]+[^\]\n]*\bid=((?:req|prm)-[A-Za-z0-9-]+)/.exec(String(t.messagePreview || ""))
  return m ? m[1] : ""
}

/** The first issue or PR named in a text: an issue/PR/MR link, owner/repo#12 or repo#12. */
export function ltIssueRef(text: unknown): string {
  const u = /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:-\/)?(?:issues|pull|merge_requests)\/(\d+)/.exec(String(text || ""))
  if (u) return u[1] + (/merge_requests/.test(u[0]) ? "!" : "#") + u[2]
  const m = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z][A-Za-z0-9_.-]*)[#!](\d+)\b/.exec(String(text || ""))
  return m ? m[0] : ""
}

/** A short title for a run, without the daemon's markers and preambles. */
export function ltTitle(t: LtTask, post: LtPost | null): string {
  if (post && post.headline) return String(post.headline).split("\n")[0].slice(0, 120)
  const raw = String(t.messagePreview || "")
  // A plan step names its step in quotes: use that.
  const step = /plan for the owner's request [^:]*: "([^"\n]+)/.exec(raw)
  if (step) return step[1].slice(0, 120)
  const from = String(t.sender || "").replace(/^agent:/, "")
  // A scheduled run: its schedule id says which job it is.
  if (t.channel === "cron" && t.chatId) {
    const job = String(t.chatId).replace(/^cron:/, "").trim()
    if (job) return job.slice(0, 120)
  }
  // The job-state reminder is a preamble the daemon puts first: say who asked.
  if (/^\s*\[Job state\]/.test(raw)) return from && from !== "agent" ? "Job for " + from : "A job check"
  let s = ltPlain(raw).replace(/^\s*(\[[^\]\n]{1,40}\]\s*)+/, "").trim()
  s = s.split("\n")[0].trim()
  return (s || (from ? "From " + from : "A run")).slice(0, 120)
}

/** Where a run sits in the tree: its project and work item. */
export function ltPlace(t: LtTask, post: LtPost | null): { project: string; item: string; itemKey: string } {
  const ref = ltIssueRef((post && post.home) || "") || ltIssueRef(t.messagePreview)
  const refRepo = ref.indexOf("/") > 0 ? ref.split(/[#!]/)[0] : ""
  const project = (post && (post.project || post.repo)) || refRepo || ""
  if (post) {
    const label = ref || String(post.headline || post.id).split("\n")[0].slice(0, 60)
    return { project, item: label, itemKey: "post:" + post.id }
  }
  if (ref) return { project, item: ref, itemKey: "ref:" + ref }
  const ch = String(t.channel || "")
  const names: Record<string, string> = { a2a: "Agent to agent", workflow: "Workflows", cron: "Schedules", app: "App chat", requests: "Requests", telegram: "Telegram", whatsapp: "WhatsApp", gitlab: "GitLab", github: "GitHub", discord: "Discord", voice: "Voice" }
  return { project, item: names[ch] || ch || "Other", itemKey: "ch:" + ch }
}

/** The tree, from the live snapshot and the Hub posts. `now` in ms. */
export function liveTreeModel(nodes: LtNode[], posts: LtPost[], now: number): LtMachine[] {
  const byId: Record<string, LtPost> = {}
  const byChat: Record<string, LtPost> = {}
  for (const p of posts || []) {
    if (!p || !p.id) continue
    byId[p.id] = p
    if (p.group && p.group.channel && p.group.chatId) byChat[p.group.channel + "|" + p.group.chatId] = p
  }
  const DONE_WINDOW = 3_600_000
  return (nodes || []).map((n) => {
    const silent = (!n.reachable || !!n.error) && !n.checking
    const m: LtMachine = {
      // The URL first: a node still being asked has its URL as id, and its
      // real id once it answers, so an id key would reopen a folded machine.
      key: String(n.url || n.id || n.name), name: String(n.name || n.url || "?"), url: String(n.url || ""),
      state: n.checking ? "checking" : silent ? "silent" : "up", error: String(n.error || ""),
      working: 0, projects: [], done: [], idle: [],
    }
    if (m.state !== "up") return m
    const projects: Record<string, LtProject> = {}
    for (const a of n.agents || []) {
      const base = {
        agentId: a.id, agentName: String(a.name || a.id), color: a.color || null,
        model: ltModel(a.model), provider: ltProvider(a.model),
      }
      const running = a.runningTasks || []
      for (const t of running) {
        const rid = ltRequestId(t)
        const post = (rid && byId[rid]) || byChat[(t.channel || "") + "|" + (t.chatId || "")] || null
        const place = ltPlace(t, post)
        const pk = place.project || "-"
        const proj = projects[pk] || (projects[pk] = { key: pk, label: place.project || "No project", items: [] })
        let item = proj.items.find((i) => i.key === place.itemKey)
        if (!item) { item = { key: place.itemKey, label: place.item, rows: [] }; proj.items.push(item) }
        const moved = Date.parse(t.lastActivity || t.startedAt || "")
        item.rows.push({ ...base, title: ltTitle(t, post), ageMs: Number.isFinite(moved) ? Math.max(0, now - moved) : 0, state: "working", task: t })
        m.working++
      }
      const last = Date.parse(a.lastActive || "")
      if (!running.length && Number.isFinite(last) && now - last <= DONE_WINDOW) {
        // A summary that is data, not words (<json>, {, [), says nothing to a person.
        let sum = a.lastSummary && a.lastSummary.text ? ltPlain(a.lastSummary.text) : ""
        if (/^\s*(<json>|[[{])/.test(sum)) sum = ""
        m.done.push({ ...base, title: (sum || "Finished a run").slice(0, 120), ageMs: Math.max(0, now - last), state: "done", task: null })
      } else if (!running.length) {
        m.idle.push({ ...base, title: "Idle", ageMs: Number.isFinite(last) ? Math.max(0, now - last) : -1, state: "idle", task: null })
      }
    }
    // Named projects first, by name; "No project" last. Rows newest move first.
    m.projects = Object.keys(projects).map((k) => projects[k])
      .sort((x, y) => (x.key === "-" ? 1 : 0) - (y.key === "-" ? 1 : 0) || x.label.localeCompare(y.label))
    for (const p of m.projects) for (const i of p.items) i.rows.sort((x, y) => x.ageMs - y.ageMs)
    m.done.sort((x, y) => x.ageMs - y.ageMs)
    // Idle: the latest to have moved first, never-moved last, then by name.
    m.idle.sort((x, y) => (x.ageMs < 0 ? 1 : 0) - (y.ageMs < 0 ? 1 : 0) || x.ageMs - y.ageMs || x.agentName.localeCompare(y.agentName))
    return m
  })
}

/** The provider's icon: a small glyph of our own, not a brand logo. */
export function ltSvg(body: string): string {
  return '<svg class="lt__prov" viewBox="0 0 16 16" aria-hidden="true">' + body + "</svg>"
}

/** A foldable group; `closed` keeps the reader's choice across snapshots
 *  (true folded, false open). Unset, it is open unless `startFolded`. */
export function ltFold(key: string, cls: string, head: string, body: string, closed: Record<string, boolean>, startFolded?: boolean): string {
  const folded = closed[key] === undefined ? !!startFolded : closed[key]
  return '<details class="' + cls + '" data-lt-key="' + ltEsc(key) + '"' + (folded ? "" : " open") + "><summary>" + head + "</summary>" + body + "</details>"
}

export function ltProviderIcon(provider: string): string {
  if (provider === "anthropic") return ltSvg('<path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>')
  if (provider === "openai") return ltSvg('<path d="M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>')
  if (provider === "google") return ltSvg('<path d="M8 1.5c.6 3.5 3 5.9 6.5 6.5-3.5.6-5.9 3-6.5 6.5-.6-3.5-3-5.9-6.5-6.5 3.5-.6 5.9-3 6.5-6.5z" fill="currentColor"/>')
  return ltSvg('<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/>')
}

/** One agent row. `href(row)` gives its link (the run's Task page). */
export function ltRowHtml(r: LtRow, href: string): string {
  const live = r.state === "working"
  const word = live ? "working" : r.state === "idle" ? "idle" : "done"
  const mark = live ? '<span class="lt__spin" role="img" aria-label="working"></span>' : '<span class="lt__dot" role="img" aria-label="' + word + '"></span>'
  const tint = r.color && /^#[0-9a-fA-F]{6}$/.test(r.color) ? ' style="color:' + r.color + '"' : ""
  const sub = '<span class="lt__who"' + tint + ">" + ltEsc(r.agentName) + "</span>" + (r.model ? " · " + ltEsc(r.model) : "") + (r.ageMs >= 0 ? ' · <time>' + ltAge(r.ageMs) + "</time>" : "")
  const inner = mark + '<span class="lt__ico">' + ltProviderIcon(r.provider) + "</span>" +
    '<span class="lt__txt"><span class="lt__title">' + ltEsc(r.title) + '</span><span class="lt__sub">' + sub + "</span></span>"
  const label = ltEsc(r.agentName + ", " + word + (r.state === "idle" ? "" : ": " + r.title))
  return href ? '<a class="lt__row' + (live ? " is-live" : " is-done") + '" href="' + ltEsc(href) + '" title="' + label + '">' + inner + "</a>"
    : '<div class="lt__row is-done" title="' + label + '">' + inner + "</div>"
}

/** The whole tree. `hrefOf(row, machine)` links a row; `closed` holds the
 *  keys of folded groups, so a fold survives the next snapshot; `under(row,
 *  machine)`, when given, draws what goes under a row (its workers, #2145). */
export function liveTreeHtml(machines: LtMachine[], hrefOf: (r: LtRow, m: LtMachine) => string, closed: Record<string, boolean>, under?: (r: LtRow, m: LtMachine) => string): string {
  if (!machines.length) return '<p class="lt__empty">Loading the machines…</p>'
  return machines.map((m) => {
    const badge = m.state === "silent" ? '<span class="lt__badge is-silent" title="' + ltEsc(m.error || "does not answer") + '">not checked</span>'
      : m.state === "checking" ? '<span class="lt__badge">checking…</span>'
      : '<span class="lt__badge' + (m.working ? " is-live" : "") + '" title="' + m.working + ' working now">' + m.working + "</span>"
    const head = '<span class="lt__mach">' + ltEsc(m.name) + "</span>" + badge
    if (m.state !== "up") {
      return ltFold("m:" + m.key, "lt__m", head, '<p class="lt__idle">' + (m.state === "silent" ? "Does not answer, so its agents are not shown." : "Slow to answer; asking again.") + "</p>", closed)
    }
    const projects = m.projects.map((p) => ltFold("p:" + m.key + "|" + p.key, "lt__p", '<span class="lt__proj">' + ltEsc(p.label) + "</span>",
      p.items.map((i) => '<div class="lt__i"><div class="lt__item">' + ltEsc(i.label) + "</div>" + i.rows.map((r) => ltRowHtml(r, hrefOf(r, m)) + (under ? under(r, m) : "")).join("") + "</div>").join(""), closed)).join("")
    const done = m.done.length ? ltFold("d:" + m.key, "lt__p lt__done", '<span class="lt__proj">Done in the last hour</span><span class="lt__n">' + m.done.length + "</span>",
      m.done.slice(0, 6).map((r) => ltRowHtml(r, hrefOf(r, m))).join("") +
      (m.done.length > 6 ? '<a class="lt__more" href="#page=activity">+' + (m.done.length - 6) + " more</a>" : ""), closed, true) : ""
    // Idle agents: one green-dot row each, folded under "N idle" so the
    // tree stays short and the working rows of every machine show first.
    const idle = m.idle.length ? ltFold("i:" + m.key, "lt__p lt__done", '<span class="lt__proj">' + m.idle.length + " idle</span>",
      m.idle.map((r) => ltRowHtml(r, hrefOf(r, m))).join(""), closed, true) : ""
    const none = m.projects.length || m.done.length ? "" : '<p class="lt__idle">' + (m.idle.length ? "Nothing running." : "No agents.") + "</p>"
    return ltFold("m:" + m.key, "lt__m", head, none + projects + done + idle, closed)
  }).join("")
}
