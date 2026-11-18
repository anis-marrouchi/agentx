// --- The situation chip (#1892 phase 2) ---
//
// One row per chat the agent talks in: a chip with the situation and its
// phase ("Conversation · ending"), why the phase moved and when, and two
// buttons: End (the talk is over: further thanks and goodbyes are held)
// and Not this (the talk is not ending: back to during, and closers no
// longer end it). The agent page's script calls these through injectFns,
// so each function is self-contained and escapes on its own.

/** One row as GET /situations returns it (situations/api.ts). */
export interface SituationChipRow {
  id: string
  channel: string
  chatId: string
  template: string
  phase: "during" | "ending" | "ended"
  endReason: string | null
  setBy: "rule" | "person"
  why: string
  phaseChangedAt: number
  override: string | null
}

/** "Conversation · ending", "Conversation · ended (person)". */
export function situationPhaseLabel(r: SituationChipRow): string {
  const name = String(r.template || "conversation")
  const head = name.charAt(0).toUpperCase() + name.slice(1)
  return head + " · " + r.phase + (r.phase === "ended" && r.endReason ? " (" + r.endReason + ")" : "")
}

/** The rows as HTML. `now` is the time to measure "2 min ago" from. */
export function situationRowsHtml(rows: SituationChipRow[], now: number): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string))
  const ago = (t: number) => {
    const m = Math.max(0, Math.round((now - t) / 60000))
    if (m < 1) return "just now"
    if (m < 60) return m + " min ago"
    const h = Math.round(m / 60)
    return h < 48 ? h + " h ago" : Math.round(h / 24) + " days ago"
  }
  if (!rows.length) {
    return '<div class="ax-sit__empty">No conversations yet. A chat appears here after its first message on Telegram, WhatsApp, Discord or Slack.</div>'
  }
  const tone: Record<string, string> = { during: "ok", ending: "warn", ended: "off" }
  const name = (r: SituationChipRow) => {
    const n = String(r.template || "conversation")
    return n.charAt(0).toUpperCase() + n.slice(1)
  }
  return '<ul class="ax-sit" role="list">' + rows.map((r) => {
    const label = name(r) + " · " + r.phase + (r.phase === "ended" && r.endReason ? " (" + r.endReason + ")" : "")
    const chat = r.channel + " " + r.chatId
    const who = r.setBy === "person" ? " · set by a person" : ""
    const end = r.phase === "ended" ? "" :
      '<button type="button" class="ax-btn ax-btn--ghost ax-sit__btn" data-sit-act="end" data-sit-id="' + esc(r.id) + '" aria-label="End this talk: ' + esc(chat) + '">End</button>'
    const notThis = (r.phase === "during" && r.override === "not-this") ? "" :
      '<button type="button" class="ax-btn ax-btn--ghost ax-sit__btn" data-sit-act="not-this" data-sit-id="' + esc(r.id) + '" aria-label="Not this: keep the talk going: ' + esc(chat) + '">Not this</button>'
    return '<li class="ax-sit__row">' +
      '<span class="ax-pill ax-pill--' + (tone[r.phase] || "off") + ' ax-sit__chip"><span class="ax-pill__dot"></span>' + esc(label) + "</span>" +
      '<span class="ax-sit__chat mono" title="' + esc(chat) + '">' + esc(chat) + "</span>" +
      '<span class="ax-sit__why">' + esc(r.why || "") + '<span class="muted"> · ' + esc(ago(r.phaseChangedAt)) + esc(who) + "</span></span>" +
      '<span class="ax-sit__acts">' + end + notThis + "</span>" +
      "</li>"
  }).join("") + "</ul>"
}
