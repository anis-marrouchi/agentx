// --- Hub chat panel: what it draws (#1528, design notes/design/hub-chat-panel.md) ---
//
// Shipped to the browser through injectFns, so each function is
// self-contained: it escapes on its own and gets the markdown renderer as
// an argument. wall-chat.client.ts calls them; the tests call them directly.

/** One message as GET /api/assistant/thread returns it (assistant-store.ts). */
export interface ChatMessage {
  role: "user" | "assistant"
  content: string
  status: "pending" | "done" | "error"
}

/** What the Hub's window.axPageContext returns (wall.client.ts). */
export interface ChatPageContext {
  page?: string
  view?: string
  status?: string
  post?: { id: string; headline: string }
  inView?: string[]
  count?: number
}

/** The short line under the composer: "Hub · Failed · 2 posts in view". */
export function chatContextLine(c: ChatPageContext | null | undefined): string {
  if (!c) return "this page"
  const TABS: Record<string, string> = { open: "Open", in_progress: "Working", waiting: "Waiting", done: "Done", failed: "Failed", "": "All" }
  const bits: string[] = []
  if (c.page) bits.push(c.page)
  if (c.status != null) bits.push(TABS[c.status] ?? c.status.replace(/_/g, " "))
  if (c.post) bits.push("post “" + c.post.headline + "”")
  else if (typeof c.count === "number") bits.push(c.count + (c.count === 1 ? " post" : " posts") + " in view")
  return bits.join(" · ") || "this page"
}

/**
 * The conversation as HTML. `agent` is the display name of who answers;
 * `md` renders a reply's markdown (it escapes first). `notSent` is a
 * message the node did not take: it shows with "Not sent", and its text
 * stays in the composer. A failed reply offers Try again and Ask another
 * agent when it is the last message.
 */
export function chatLogHtml(msgs: ChatMessage[], o: { agent: string; md?: (s: string) => string; notSent?: string }): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string))
  const who = esc(o.agent || "The agent")
  const me = (t: string) => '<div class="hc__me"><div class="b">' + esc(t) + "</div></div>"
  const them = (cls: string, body: string, meta: string) =>
    '<div class="hc__them' + (cls ? " " + cls : "") + '"><div class="b">' + body + "</div>" + (meta ? '<div class="hc__meta">' + meta + "</div>" : "") + "</div>"
  if (!msgs.length && !o.notSent) {
    return '<div class="hc__empty"><b>Ask about what you see</b>The page you are on and what is in view go with your message. Answers stay here when you move to another page.</div>'
  }
  const out = msgs.map((m, i) => {
    if (m.role === "user") return me(m.content)
    if (m.status === "pending") return them("hc__wait", "Thinking…", '<span class="hc__live">' + who + " is answering</span>")
    if (m.status === "error") {
      const last = i === msgs.length - 1 && !o.notSent
      return them("hc__err", "<b>" + who + " could not answer</b>" + esc(m.content), "") +
        (last ? '<div class="hc__btnrow"><button type="button" class="ax-btn ax-btn--ghost" data-hc-retry>Try again</button><button type="button" class="ax-btn ax-btn--ghost" data-hc-other>Ask another agent</button></div>' : "")
    }
    let body = esc(m.content || "(no reply)")
    if (o.md && m.content) { try { body = o.md(m.content) } catch { /* plain text above */ } }
    return them("hc__md", body, "")
  })
  if (o.notSent) {
    out.push(me(o.notSent), them("hc__err", "<b>Not sent</b>This node does not answer just now. Your message is kept below; send it again when it is back.", ""))
  }
  return out.join("")
}
