// --- The Task page's session thread (#2101 R4), pure parts ---
//
// A Task page opened on a follow-up shows its whole chat: the first request,
// the turns before it, the selected run (its own stream, below) and any turns
// after it. The server reads the session (task-session.ts, GET /api/task/
// history?session=1); these turn its page into HTML. Injected into the Wall's
// script with injectFns, so each one stands alone: no imports, no closures.

/** "Call answered" / "Call ended" for the daemon's own call prompt, else ""
 *  (#2101). A copy of calls/call-note.ts callNote: an injected function
 *  cannot import (test/call-note.test.ts keeps the copies equal). */
export function tsCallNote(text: unknown): string {
  const s = String(text == null ? "" : text).trimStart()
  if (s.indexOf("[Call answered]") === 0) return "Call answered"
  if (s.indexOf("[Call ended]") === 0) return "Call ended"
  return ""
}

/** One turn as the session API returns it. */
export interface TsTurn {
  id: string
  n?: number
  sender?: string
  message: string
  startedAt?: string
  endedAt?: string
  ok?: boolean
  error?: string
  responseText?: string
  running?: boolean
}

/**
 * When something happened, as the Task page shows it (#2306): "14:05" when
 * it was today in the viewer's time, "24 Nov 14:05" another day this year,
 * "24 Nov 2025 14:05" before that. `full` is the whole local date and time
 * for the hover title, `iso` the machine form for <time datetime>. Null for
 * no time: nothing is shown rather than a made-up one.
 */
export function tsWhen(ms: number, now: number): { short: string; full: string; iso: string } | null {
  if (!(ms > 0)) return null
  const d = new Date(ms), n = new Date(now)
  if (isNaN(d.getTime())) return null
  const p2 = (x: number) => (x < 10 ? "0" : "") + x
  const hm = p2(d.getHours()) + ":" + p2(d.getMinutes())
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]
  const sameYear = d.getFullYear() === n.getFullYear()
  const today = sameYear && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  const short = today ? hm : d.getDate() + " " + mon + (sameYear ? "" : " " + d.getFullYear()) + " " + hm
  return { short, full: d.toLocaleString(), iso: d.toISOString() }
}

/** tsWhen as a <time> element; "" for no time. */
export function tsTimeHtml(ms: number, now: number, cls?: string): string {
  const w = tsWhen(ms, now)
  if (!w) return ""
  const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  return '<time class="' + esc(cls || "ax-time") + '" datetime="' + esc(w.iso) + '" title="' + esc(w.full) + '">' + esc(w.short) + "</time>"
}

export function tsEsc(x: unknown): string {
  return String(x == null ? "" : x).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
}

/** The header line: where the selected run sits in its chat. "" alone. */
export function tsTurnLabel(n: number, total: number): string {
  if (!total || total < 2 || !n) return ""
  return (n > 1 ? "Follow-up · turn " : "First turn · ") + n + " of " + total + " in this chat"
}

/** One earlier or later turn: what was asked, what came back, and a link to
 *  that turn's own page with its full log. `when` gives a time's HTML
 *  (tsTimeHtml): the ask at its start, the reply at its end. */
export function tsTurnHtml(t: TsTurn, o: { agent: string; href: string; md: (s: string) => string; plain: (s: string) => string; when: (iso: string) => string }): string {
  const ask = o.plain(t.message || "").trim()
  // The daemon's own call prompt (#2101): a system line, not the owner's words.
  const note = tsCallNote(ask)
  const reply = o.plain(t.responseText || "").trim()
  const err = !t.running && t.ok === false
  const replyHtml = t.running
    ? '<div class="wsess__reply is-running"><span class="ax-ev__label ax-ev__label--text">' + tsEsc(o.agent) + "</span> working now…</div>"
    : '<div class="wsess__reply' + (err ? " is-err" : "") + '"><div class="wsess__head"><span class="ax-ev__label ax-ev__label--text">' + tsEsc(o.agent) + "</span>" +
      (t.endedAt ? '<span class="wsess__when">' + o.when(t.endedAt) + "</span>" : "") + "</div>" +
      '<div class="wsess__body ax-ev__text">' + (reply ? o.md(reply) : err ? tsEsc(t.error || "failed") : '<span class="wsess__none">No reply text.</span>') + "</div></div>"
  return '<article class="wsess__turn" data-turn="' + tsEsc(t.id) + '">' +
    '<div class="wsess__ask"><div class="wsess__head"><span class="ax-ev__label ax-ev__label--soft">turn ' + tsEsc(t.n || "") + "</span>" +
    (note ? '<span class="wsess__who">from AgentX</span>' : t.sender ? '<span class="wsess__who">' + tsEsc(t.sender) + "</span>" : "") +
    '<span class="wsess__when">' + (t.startedAt ? o.when(t.startedAt) : "") + "</span></div>" +
    '<div class="wsess__body">' + (note ? '<span class="wsess__note">' + tsEsc(note) + "</span>" : ask ? o.md(ask) : '<span class="wsess__none">No request text.</span>') + "</div></div>" +
    replyHtml +
    '<a class="wsess__open" href="' + tsEsc(o.href) + '">View log</a></article>'
}

/** The turns before the selected run: the first one pinned when the page
 *  starts later, a gap with "Load earlier turns", then the rest. */
export function tsBeforeHtml(p: { first: TsTurn | null; before: TsTurn[]; olderBefore: string | null; loading?: boolean; error?: string }, turn: (t: TsTurn) => string): string {
  if (!p.first && !p.before.length && !p.error) return ""
  let h = ""
  if (p.first) h += turn(p.first)
  if (p.olderBefore) {
    h += '<div class="wsess__gap">' + (p.loading
      ? '<span class="wsess__none">Loading…</span>'
      : '<button type="button" class="ax-btn ax-btn--ghost" data-session-older="' + tsEsc(p.olderBefore) + '">Load earlier turns</button>') + "</div>"
  }
  h += p.before.map(turn).join("")
  if (p.error) h += '<p class="wsess__none">' + tsEsc(p.error) + "</p>"
  return h
}

/**
 * The selected run's stream came back after a drop (#2175): its `start`
 * event carries the run's whole output again. `have` is what the page
 * already shows, `all` what the node sent. Add only the new part, so
 * nothing shows twice and a tool step the reader opened stays open; when
 * the node kept less than the page has, draw it again from `all`.
 */
export function tsCatchUp(have: string, all: string): { add: string } | { reset: string } {
  const h = String(have || ""), a = String(all || "")
  if (a.indexOf(h) === 0) return { add: a.slice(h.length) }
  return { reset: a }
}

/** An earlier turn folded to one line, its ask; one click opens the whole
 *  turn (#2101, Orca's chat). `html` is the turn from tsTurnHtml. */
export function tsFoldHtml(t: TsTurn, html: string, open: boolean, plain: (s: string) => string): string {
  const esc = (x: unknown) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  const ask = tsCallNote(t.message) || plain(t.message || "").replace(/\s+/g, " ").trim()
  const line = ask.length > 110 ? ask.slice(0, 109) + "…" : ask || "No request text."
  return '<details class="wsess__fold" data-turn-fold="' + esc(t.id) + '"' + (open ? " open" : "") + ">" +
    '<summary><span class="wsess__foldn">turn ' + esc(t.n || "") + '</span><span class="wsess__foldask">' + esc(line) + "</span>" +
    (t.running ? '<span class="wsess__foldn">working now</span>' : t.ok === false ? '<span class="wsess__foldn">failed</span>' : "") +
    "</summary>" + html + "</details>"
}
