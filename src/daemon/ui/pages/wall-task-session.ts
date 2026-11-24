// --- The Task page's session thread (#2101 R4), pure parts ---
//
// A Task page opened on a follow-up shows its whole chat: the first request,
// the turns before it, the selected run (its own stream, below) and any turns
// after it. The server reads the session (task-session.ts, GET /api/task/
// history?session=1); these turn its page into HTML. Injected into the Wall's
// script with injectFns, so each one stands alone: no imports, no closures.

/** One turn as the session API returns it. */
export interface TsTurn {
  id: string
  n?: number
  sender?: string
  message: string
  startedAt?: string
  ok?: boolean
  error?: string
  responseText?: string
  running?: boolean
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
 *  that turn's own page with its full log. */
export function tsTurnHtml(t: TsTurn, o: { agent: string; href: string; md: (s: string) => string; plain: (s: string) => string; when: (iso: string) => string }): string {
  const ask = o.plain(t.message || "").trim()
  const reply = o.plain(t.responseText || "").trim()
  const err = !t.running && t.ok === false
  const replyHtml = t.running
    ? '<div class="wsess__reply is-running"><span class="ax-ev__label ax-ev__label--text">' + tsEsc(o.agent) + "</span> working now…</div>"
    : '<div class="wsess__reply' + (err ? " is-err" : "") + '"><div class="wsess__head"><span class="ax-ev__label ax-ev__label--text">' + tsEsc(o.agent) + "</span></div>" +
      '<div class="wsess__body ax-ev__text">' + (reply ? o.md(reply) : err ? tsEsc(t.error || "failed") : '<span class="wsess__none">No reply text.</span>') + "</div></div>"
  return '<article class="wsess__turn" data-turn="' + tsEsc(t.id) + '">' +
    '<div class="wsess__ask"><div class="wsess__head"><span class="ax-ev__label ax-ev__label--soft">turn ' + tsEsc(t.n || "") + "</span>" +
    (t.sender ? '<span class="wsess__who">' + tsEsc(t.sender) + "</span>" : "") +
    '<span class="wsess__when">' + tsEsc(t.startedAt ? o.when(t.startedAt) : "") + "</span></div>" +
    '<div class="wsess__body">' + (ask ? o.md(ask) : '<span class="wsess__none">No request text.</span>') + "</div></div>" +
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
