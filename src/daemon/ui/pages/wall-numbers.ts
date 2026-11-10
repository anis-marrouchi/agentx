// --- The Numbers page in the Hub (#1826 N2) ---
//
// Every tracked number (src/numbers) on every machine the Hub reads: its
// newest reading, a small trend of its recent readings, its status in
// words, its tags and owner. A card per department (or per owner when the
// org has no departments) counts how its numbers stand. Tags narrow the
// list, and the list can be grouped by department, owner or a tag's kind
// (`channel:` or `product:`).
//
// A failed read is "no reading", never 0: the value line says so and the
// trend leaves a gap for it.
//
// Reads GET /api/admin/numbers (numbersHubReply, src/numbers/hub-api.ts),
// whose sources are already masked the way the agents' /numbers masks them.
// Shipped to the browser through injectFns, so each function is
// self-contained: the only calls between them are to other injected
// functions of this file (numEsc, numFmt, numTargetText, numPeriodText).

/** A reading as the API sends it. */
export interface HubReading { value: number | null; error?: string | null; readAt: number; periodStart: number; periodEnd: number; by?: string; note?: string | null }
/** A number as the API sends it, with the machine that keeps it. */
export interface HubNumber {
  id: string
  name: string
  ownerAgent: string | null
  unit: string | null
  target: { value: number; direction: "up" | "down" } | null
  rhythm: string
  source: { kind: string; [k: string]: unknown }
  tags: string[]
  origin?: string
  status: string
  statusWords: string
  latest: HubReading | null
  readings?: HubReading[]
  node?: string
}
/** Department of an owner agent: by agent id, or "node/id" for one on another machine. */
export type DeptOf = Record<string, { id: string; name: string }>

/** HTML-escape text for the page. */
export function numEsc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
}

/** A value for people, as src/numbers/model.ts formatValue writes it (a
 *  copy, so the page needs no import at run time; a test keeps them equal). */
export function numFmt(value: number | null, unit?: string | null): string {
  if (value === null) return "no reading"
  const v = Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 })
  return unit ? (unit === "%" ? v + "%" : v + " " + unit) : v
}

/** "≥ 1,000 views", as model.ts describeTarget. */
export function numTargetText(t: { value: number; direction: "up" | "down" }, unit?: string | null): string {
  return (t.direction === "down" ? "≤" : "≥") + " " + numFmt(t.value, unit)
}

/** "2026-11-02..2026-11-08", as model.ts describePeriod. */
export function numPeriodText(p: { start: number; end: number }): string {
  const first = new Date(p.start).toISOString().slice(0, 10)
  const last = new Date(Math.max(p.start, p.end - 1)).toISOString().slice(0, 10)
  return first === last ? first : first + ".." + last
}

/** How urgent a status is: missed twice first, no target last. */
export function numRank(status: string): number {
  const order = ["missed_twice", "missed", "no_reading", "on_target", "no_target"]
  const i = order.indexOf(status)
  return i < 0 ? order.length : i
}

/** Every machine's numbers as one list, each with its machine; the urgent
 *  ones first, then by name. */
export function numMerge(replies: Array<{ node: string; numbers?: HubNumber[] | null }>): HubNumber[] {
  const out: HubNumber[] = []
  for (const r of replies) for (const n of r.numbers || []) out.push(Object.assign({}, n, { node: r.node }))
  return out.sort((a, b) => numRank(a.status) - numRank(b.status) || String(a.name).localeCompare(String(b.name)) || String(a.node).localeCompare(String(b.node)))
}

/** The tags on any of the numbers, sorted. */
export function numTagsOf(list: HubNumber[]): string[] {
  const seen: Record<string, true> = {}
  for (const n of list) for (const t of n.tags || []) seen[t] = true
  return Object.keys(seen).sort()
}

/** The numbers that carry every tag of `tags`. */
export function numFilter(list: HubNumber[], tags: string[]): HubNumber[] {
  return tags.length ? list.filter((n) => tags.every((t) => (n.tags || []).indexOf(t) >= 0)) : list
}

/** How many numbers stand at each status. */
export function numCounts(list: HubNumber[]): Record<string, number> {
  const c: Record<string, number> = { on_target: 0, missed: 0, missed_twice: 0, no_reading: 0, no_target: 0 }
  for (const n of list) c[n.status] = (c[n.status] || 0) + 1
  return c
}

/** The department of a number's owner, if the org puts it in one. */
export function numDeptOf(n: HubNumber, deptOf: DeptOf): { id: string; name: string } | null {
  if (!n.ownerAgent) return null
  return (n.node && deptOf[n.node + "/" + n.ownerAgent]) || deptOf[n.ownerAgent] || null
}

/** The group a number goes in. by: "department", "owner", or "tag:<kind>"
 *  for the part after `<kind>:` of its tags (a number with two such tags is
 *  in two groups). */
export function numGroups(list: HubNumber[], by: string, deptOf: DeptOf): Array<{ key: string; label: string; numbers: HubNumber[] }> {
  const groups: Record<string, { key: string; label: string; numbers: HubNumber[] }> = {}
  const order: string[] = []
  const put = (key: string, label: string, n: HubNumber) => {
    if (!groups[key]) { groups[key] = { key, label, numbers: [] }; order.push(key) }
    groups[key].numbers.push(n)
  }
  const kind = by.indexOf("tag:") === 0 ? by.slice(4) : ""
  for (const n of list) {
    if (by === "department") {
      const d = numDeptOf(n, deptOf)
      if (d) put("d:" + d.id, d.name, n)
      else put("~", "Not in a department", n)
    } else if (by === "owner") {
      if (n.ownerAgent) put("o:" + n.ownerAgent, "@" + n.ownerAgent, n)
      else put("~", "No owner", n)
    } else if (kind) {
      const vals = (n.tags || []).filter((t) => t.indexOf(kind + ":") === 0).map((t) => t.slice(kind.length + 1))
      if (vals.length) for (const v of vals) put("t:" + v, kind + ": " + v, n)
      else put("~", "No " + kind + " tag", n)
    } else put("all", "", n)
  }
  // Named groups by name; the leftover group last.
  return order.sort((a, b) => (a === "~" ? 1 : 0) - (b === "~" ? 1 : 0) || groups[a].label.localeCompare(groups[b].label)).map((k) => groups[k])
}

/** The tag kinds the numbers use (`channel` for `channel:video`), sorted. */
export function numTagKinds(list: HubNumber[]): string[] {
  const seen: Record<string, true> = {}
  for (const n of list) for (const t of n.tags || []) { const i = t.indexOf(":"); if (i > 0) seen[t.slice(0, i)] = true }
  return Object.keys(seen).sort()
}

/** A small trend of the readings (newest first in, oldest drawn left). A
 *  failed read is a gap in the line, never a drop to 0. Empty with fewer
 *  than two values. */
export function numSparkSvg(readings: HubReading[], status: string, unit?: string | null): string {
  const rs = (readings || []).slice().reverse()
  const vals = rs.map((r) => (r.value === null || r.value === undefined ? null : r.value))
  const nums = vals.filter((v): v is number => v !== null)
  if (nums.length < 2) return '<span class="wnm__spark is-none" aria-hidden="true"></span>'
  const W = 96, H = 24, P = 2
  const min = Math.min.apply(null, nums), max = Math.max.apply(null, nums)
  const x = (i: number) => (rs.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (rs.length - 1))
  const y = (v: number) => (max === min ? H / 2 : H - P - ((v - min) * (H - 2 * P)) / (max - min))
  const lines: string[] = []
  let seg: string[] = []
  vals.forEach((v, i) => {
    if (v === null) { if (seg.length) lines.push(seg.join(" ")); seg = []; return }
    seg.push(x(i).toFixed(1) + "," + y(v).toFixed(1))
  })
  if (seg.length) lines.push(seg.join(" "))
  let last = -1
  vals.forEach((v, i) => { if (v !== null) last = i })
  const words = vals.map((v) => (v === null ? "no reading" : numFmt(v, unit))).join(", ")
  return '<svg class="wnm__spark is-' + numEsc(status) + '" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + numEsc("Trend, oldest first: " + words) + '">' +
    lines.map((pts) => (pts.indexOf(" ") < 0 ? '<circle r="1.5" cx="' + pts.split(",")[0] + '" cy="' + pts.split(",")[1] + '"/>' : '<polyline points="' + pts + '"/>')).join("") +
    '<circle class="wnm__dot" r="2.5" cx="' + x(last).toFixed(1) + '" cy="' + y(vals[last] as number).toFixed(1) + '"/></svg>'
}

/** The status in words, as a chip. */
export function numStatusHtml(status: string, words: string): string {
  return '<span class="wnm__st is-' + numEsc(status) + '">' + numEsc(words || status) + "</span>"
}

/** The source in a line: its kind and its (already masked) fields. */
export function numSourceText(s: { kind: string; [k: string]: unknown } | null | undefined): string {
  if (!s || !s.kind) return "manual"
  const rest: Record<string, unknown> = {}
  for (const k of Object.keys(s)) if (k !== "kind") rest[k] = s[k]
  const keys = Object.keys(rest)
  return keys.length ? s.kind + " " + JSON.stringify(rest) : s.kind
}

/** One number as a row that opens on its readings. `open`: shown opened. */
export function numRowHtml(n: HubNumber, open: boolean): string {
  const latest = n.latest
  const value = latest && latest.value !== null && latest.value !== undefined ? numFmt(latest.value, n.unit) : "no reading"
  const window = latest ? numPeriodText({ start: latest.periodStart, end: latest.periodEnd }) : "never read"
  const tags = (n.tags || []).map((t) => '<span class="wnm__tag">' + numEsc(t) + "</span>").join("")
  const meta = [n.ownerAgent ? "@" + n.ownerAgent : "no owner", n.rhythm, n.target ? "target " + numTargetText(n.target, n.unit) : "no target", n.node || ""].filter(Boolean)
  const rows = (n.readings || (latest ? [latest] : [])).map((r) =>
    "<tr><td>" + numEsc(numPeriodText({ start: r.periodStart, end: r.periodEnd })) + "</td>" +
    (r.value === null || r.value === undefined
      ? '<td class="is-none">no reading</td><td colspan="2" class="is-err">' + numEsc(r.error || "the read failed") + "</td>"
      : "<td>" + numEsc(numFmt(r.value, n.unit)) + "</td><td>" + numEsc(r.by || "") + "</td><td>" + numEsc(r.note || "") + "</td>") + "</tr>").join("")
  return '<details class="wnm is-' + numEsc(n.status) + '" id="num-' + numEsc(n.id) + '" data-num="' + numEsc(n.id) + '"' + (open ? " open" : "") + "><summary>" +
    '<span class="wnm__n"><b>' + numEsc(n.name) + "</b><small>" + numEsc(meta.join(" · ")) + "</small>" + (tags ? '<span class="wnm__tags">' + tags + "</span>" : "") + "</span>" +
    '<span class="wnm__v"><b' + (value === "no reading" ? ' class="is-none"' : "") + ">" + numEsc(value) + "</b><small>" + numEsc(window) + "</small></span>" +
    numSparkSvg(n.readings || [], n.status, n.unit) +
    numStatusHtml(n.status, n.statusWords) +
    "</summary><div class=\"wnm__d\">" +
    "<p><span class=\"k\">Id</span> <code>" + numEsc(n.id) + "</code> · <span class=\"k\">Source</span> <code>" + numEsc(numSourceText(n.source)) + "</code></p>" +
    (rows ? '<div class="wnm__scroll"><table class="wnm__rd"><thead><tr><th>Window</th><th>Value</th><th>By</th><th>Note</th></tr></thead><tbody>' + rows + "</tbody></table></div>"
      : '<p class="ax-wall__empty">No reading yet.</p>') +
    "</div></details>"
}

/** A card per department (or per owner when no number's owner is in one):
 *  how its numbers stand, the urgent ones named. */
export function numDeptCardsHtml(list: HubNumber[], deptOf: DeptOf): string {
  if (!list.length) return ""
  const anyDept = list.some((n) => !!numDeptOf(n, deptOf))
  const groups = numGroups(list, anyDept ? "department" : "owner", deptOf)
  const SHOW = ["missed_twice", "missed", "no_reading", "on_target"]
  const WORDS: Record<string, string> = { missed_twice: "missed twice", missed: "missed", no_reading: "no reading", on_target: "on target" }
  return '<section class="wnd" aria-label="' + (anyDept ? "Numbers by department" : "Numbers by owner") + '">' + groups.map((g) => {
    const c = numCounts(g.numbers)
    const bad = g.numbers.filter((n) => numRank(n.status) <= 2).slice(0, 3)
    return '<article class="wnd__card"><h3>' + numEsc(g.label) + " <small>" + g.numbers.length + (g.numbers.length === 1 ? " number" : " numbers") + "</small></h3>" +
      '<p class="wnd__counts">' + SHOW.filter((s) => c[s]).map((s) => '<span class="wnm__st is-' + s + '">' + c[s] + " " + WORDS[s] + "</span>").join("") +
        (c.no_target ? '<span class="wnm__st is-no_target">' + c.no_target + " no target</span>" : "") + "</p>" +
      (bad.length ? '<ul class="wnd__bad">' + bad.map((n) => '<li><a href="#page=numbers&amp;num=' + encodeURIComponent(n.id) + '">' + numEsc(n.name) + "</a> " + numEsc(n.statusWords) + "</li>").join("") + "</ul>" : "") +
      "</article>"
  }).join("") + "</section>"
}

export interface NumbersPageModel {
  /** Every machine's numbers, merged (numMerge); null while loading. */
  list: HubNumber[] | null
  /** Tags picked: only numbers with every one. */
  tags: string[]
  /** Group the list by: "", "department", "owner" or "tag:<kind>". */
  by: string
  /** The id of the number to show opened. */
  open: string
  deptOf: DeptOf
  /** Machines not read, with why. */
  missed: Array<{ name: string; why: string }>
  error?: string
}

/** The whole page: counts, department cards, tag chips, group by, the list. */
export function numbersPageHtml(m: NumbersPageModel): string {
  const missed = m.missed.length ? '<p class="wnm__warn">Not read: ' + m.missed.map((x) => numEsc(x.name + " " + x.why)).join("; ") + ".</p>" : ""
  if (m.error) return '<p class="ax-wall__empty" role="alert">Could not read the numbers: ' + numEsc(m.error) + ". Select Refresh to try again.</p>" + missed
  if (!m.list) return '<p class="ax-wall__empty">Loading…</p>'
  if (!m.list.length) {
    return '<div class="wnm__none"><p><b>No numbers yet.</b> A number is a measure your team follows over time, such as views per channel or sign-ups per product.</p>' +
      "<p>Add one in a terminal with <code>agentx numbers add</code>, in <code>agentx.json</code> under <code>numbers.items</code>, or let an agent make one with its <code>agentx_numbers</code> tool.</p></div>" + missed
  }
  const tags = numTagsOf(m.list)
  const picked = m.tags.filter((t) => tags.indexOf(t) >= 0)
  const shown = numFilter(m.list, picked)
  const c = numCounts(shown)
  const summary = '<dl class="wnm__sum">' + [["on_target", "on target"], ["missed", "missed"], ["missed_twice", "missed twice"], ["no_reading", "no reading"]].map((s) =>
    '<div class="is-' + s[0] + '"><dt>' + s[1] + "</dt><dd>" + (c[s[0]] || 0) + "</dd></div>").join("") + "</dl>"
  const chips = tags.length ? '<div class="wnm__chips" role="group" aria-label="Only numbers with these tags">' + tags.map((t) =>
    '<button type="button" data-ntag="' + numEsc(t) + '" aria-pressed="' + (picked.indexOf(t) >= 0 ? "true" : "false") + '">' + numEsc(t) + "</button>").join("") +
    (picked.length ? '<button type="button" data-nclear class="is-clear">All tags</button>' : "") + "</div>" : ""
  const kinds = numTagKinds(m.list)
  const opts = [["", "nothing"], ["department", "department"], ["owner", "owner"]].concat(kinds.map((k) => ["tag:" + k, "tag " + k]))
  const by = opts.some((o) => o[0] === m.by) ? m.by : ""
  const tools = '<div class="wnm__tools">' + chips + '<label class="wnm__by">Group by <select id="n-by">' +
    opts.map((o) => '<option value="' + numEsc(o[0]) + '"' + (o[0] === by ? " selected" : "") + ">" + numEsc(o[1]) + "</option>").join("") + "</select></label></div>"
  const groups = numGroups(shown, by, m.deptOf)
  const list = !shown.length ? '<p class="ax-wall__empty">No number has every tag picked.</p>'
    : groups.map((g) => (g.label ? '<h3 class="wnm__gh">' + numEsc(g.label) + " <small>" + g.numbers.length + "</small></h3>" : "") +
      '<div class="wnm__list">' + g.numbers.map((n) => numRowHtml(n, n.id === m.open)).join("") + "</div>").join("")
  return summary + numDeptCardsHtml(shown, m.deptOf) + tools + missed + list +
    '<p class="ax-wall__count wnm__foot">Newest reading of each number, with its last readings as a trend. A failed read is no reading, never 0.</p>'
}

/** A job's value line names a number (crons.<id>.value.number): its newest
 *  reading and status beside the line. `n`: that number, if read. */
export function numJobHtml(id: string, n: HubNumber | null, loaded: boolean): string {
  if (!id) return ""
  const link = '<a href="#page=numbers&amp;num=' + encodeURIComponent(id) + '">' + numEsc(n ? n.name : id) + "</a>"
  if (!n) return ' <span class="ax-cron-value">· Number: ' + link + (loaded ? ' <span class="is-missing">not found</span>' : "") + "</span>"
  const v = n.latest && n.latest.value !== null && n.latest.value !== undefined ? numFmt(n.latest.value, n.unit) : "no reading"
  return ' <span class="ax-cron-value wnm__job">· Number: ' + link + " <b>" + numEsc(v) + "</b> " + numStatusHtml(n.status, n.statusWords) + "</span>"
}

