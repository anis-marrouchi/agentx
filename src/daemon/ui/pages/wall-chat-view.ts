// --- Hub chat panel: what it draws (#1528, design notes/design/hub-chat-panel.md) ---
//
// Shipped to the browser through injectFns, so each function is
// self-contained: it escapes on its own and gets the markdown renderer as
// an argument. wall-chat.client.ts calls them; the tests call them directly.

/** "Call answered" / "Call ended" for the daemon's own call prompt, else ""
 *  (#2101). A copy of calls/call-note.ts callNote: an injected function
 *  cannot import (test/call-note.test.ts keeps the copies equal). */
export function chatCallNote(text: unknown): string {
  const s = String(text == null ? "" : text).trimStart()
  if (s.indexOf("[Call answered]") === 0) return "Call answered"
  if (s.indexOf("[Call ended]") === 0) return "Call ended"
  return ""
}

/** One message as GET /api/assistant/thread returns it (assistant-store.ts). */
export interface ChatMessage {
  role: "user" | "assistant"
  content: string
  status: "pending" | "done" | "error"
  /** The run answering a pending message, once it has started. */
  taskId?: string | null
  /** ms; a pending answer's "Working for …" counts from it. */
  createdAt?: number
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

/** A user message's text and the files it carried: the daemon ends such a
 *  message with "Attached: a.png, b.pdf" (assistant-upload.ts attachedLine). */
export function chatAttached(content: string): { text: string; files: string[] } {
  const m = /\n\nAttached: ([^\n]+)$/.exec(String(content || ""))
  if (!m) return { text: String(content || ""), files: [] }
  return { text: String(content).slice(0, m.index), files: m[1].split(", ").filter(Boolean) }
}

/** The tool steps of one answer, as the thread read sends them (assistant-runs.ts). */
export interface ChatRun { ms: number | null; steps: Array<{ tool: string; input: string; error: boolean; result?: string }> }
/** The fold functions (wall-chat-fold.ts), passed in so this file stays self-contained. */
export interface ChatFold {
  parse: (text: string) => { steps: ChatRun["steps"]; errors: string[]; answer: string }
  html: (o: { key: string; steps: ChatRun["steps"]; ms: number | null; live?: boolean; open?: boolean }) => string
}

/**
 * A pending answer's live part (#2101 R14): the fold of its tool steps so
 * far, each "[error] …" line as a notice, then the answer as it is written.
 * Raw tool, init and thought lines never show. Null when nothing came yet.
 */
export function chatLiveHtml(live: string, o: { key: string; fold?: ChatFold; md?: (s: string) => string; ms?: number | null; open?: boolean }): string | null {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string))
  const p = o.fold ? o.fold.parse(live || "") : { steps: [], errors: [], answer: String(live || "") }
  if (!p.steps.length && !p.errors.length && !p.answer) return null
  let body = ""
  if (p.answer) { body = esc(p.answer); if (o.md) { try { body = o.md(p.answer) } catch { /* plain text above */ } } }
  return (o.fold && p.steps.length ? o.fold.html({ key: o.key, steps: p.steps, ms: o.ms ?? null, live: true, open: o.open }) : "") +
    p.errors.map((e) => '<div class="hc__notice" role="alert"><b>Error</b>' + esc(e) + "</div>").join("") +
    (p.answer ? '<div class="b">' + body + "</div>" : "")
}

/**
 * The conversation as HTML. `agent` is the display name of who answers;
 * `md` renders a reply's markdown (it escapes first). `notSent` is a
 * message the node did not take: it shows with "Not sent", and its text
 * stays in the composer. `notSentWhy` is the node's own error when it
 * answered and refused (#2238); without it the node did not answer. A failed reply offers Try again and Ask another
 * agent when it is the last message. A pending answer whose run has
 * started shows `live`, the run's output so far (chatLiveHtml), with Stop
 * and, when `runHref` names it, Open the run (`stopFailed`: a Stop that
 * did not take, so its button says so). Its part sits in `[data-hc-live]`,
 * so a new chunk repaints that alone and leaves Stop as it is. A finished
 * answer with tool steps in `runs` shows them folded above it (R14).
 */
export function chatLogHtml(msgs: ChatMessage[], o: {
  agent: string; md?: (s: string) => string; notSent?: string; notSentWhy?: string; live?: string; runHref?: string; stopFailed?: boolean
  runs?: Record<string, ChatRun>; fold?: ChatFold; open?: Record<string, boolean>; now?: number
  /** Fold each earlier turn (an ask and its answers) to one line; the newest stays open (#2101). */
  foldTurns?: boolean; openTurns?: Record<string, boolean>
}): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string))
  const who = esc(o.agent || "The agent")
  const me = (t: string) => {
    const a = chatAttached(t)
    let body = esc(a.text)
    if (o.md && a.text) { try { body = o.md(a.text) } catch { /* plain text above */ } }
    return '<div class="hc__me hc__md"><div class="b">' + body + "</div>" +
      (a.files.length ? '<div class="hc__files">' + a.files.map((f) => '<span class="hc__file">' + esc(f) + "</span>").join("") + "</div>" : "") + "</div>"
  }
  const them = (cls: string, body: string, meta: string, live?: boolean, pre?: string) =>
    '<div class="hc__them' + (cls ? " " + cls : "") + '">' + (pre || "") + (live ? "<div data-hc-live>" + body + "</div>" : '<div class="b">' + body + "</div>") +
    (meta ? '<div class="hc__meta">' + meta + "</div>" : "") + "</div>"
  const foldOf = (m: ChatMessage) => {
    const r = m.taskId && o.runs ? o.runs[m.taskId] : null
    return r && o.fold && r.steps && r.steps.length ? o.fold.html({ key: String(m.taskId), steps: r.steps, ms: r.ms, open: !!(o.open && o.open[String(m.taskId)]) }) : ""
  }
  if (!msgs.length && !o.notSent) {
    return '<div class="hc__empty"><b>Ask ' + who + '</b>Type, attach a file or record a voice message. Each agent keeps its own conversation: pick another and come back, it is still here.</div>'
  }
  const out = msgs.map((m, i) => {
    if (m.role === "user") {
      // The daemon's own call prompt is not the owner's message (#2101).
      const note = chatCallNote(m.content)
      return note ? '<div class="hc__note" data-hc-note>' + esc(note) + "</div>" : me(m.content)
    }
    if (m.status === "pending") {
      const run = m.taskId
        ? '<button type="button" class="hc__stop" data-hc-stop="' + esc(m.taskId) + '">' + (o.stopFailed ? "Not stopped. Try again" : "Stop") + "</button>" +
          (o.runHref ? '<a class="hc__run" href="' + esc(o.runHref) + '">Open the run</a>' : "")
        : ""
      const ms = m.createdAt && o.now ? Math.max(0, o.now - m.createdAt) : null
      const live = o.live ? chatLiveHtml(o.live, { key: String(m.taskId || ""), fold: o.fold, md: o.md, ms, open: !!(o.open && o.open[String(m.taskId)]) }) : null
      return them(live ? "hc__md" : "hc__wait", live || '<div class="b">Thinking…</div>', '<span class="hc__live">' + who + " is answering</span>" + run, true)
    }
    if (m.status === "error") {
      const last = i === msgs.length - 1 && !o.notSent
      return them("hc__err", "<b>" + who + " could not answer</b>" + esc(m.content), "", false, foldOf(m)) +
        (last ? '<div class="hc__btnrow"><button type="button" class="ax-btn ax-btn--ghost" data-hc-retry>Try again</button><button type="button" class="ax-btn ax-btn--ghost" data-hc-other>Ask another agent</button></div>' : "")
    }
    let body = esc(m.content || "(no reply)")
    if (o.md && m.content) { try { body = o.md(m.content) } catch { /* plain text above */ } }
    return them("hc__md", body, "", false, foldOf(m))
  })
  if (o.foldTurns) {
    // A turn starts at each ask. Every turn before the last one folds to
    // one line with its ask; a click opens it. Key: the ask's index.
    const asks = msgs.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0)
    for (let k = asks.length - 2; k >= 0; k--) {
      const from = asks[k], to = asks[k + 1]
      const ask = chatCallNote(msgs[from].content) || chatAttached(msgs[from].content).text.replace(/\s+/g, " ").trim()
      const line = ask.length > 110 ? ask.slice(0, 109) + "…" : ask || "(attached files)"
      const key = String(from)
      const n = to - from - 1
      out.splice(from, to - from, '<details class="hc__turn" data-hc-turn="' + key + '"' + (o.openTurns && o.openTurns[key] ? " open" : "") + ">" +
        '<summary><span class="hc__turnask">' + esc(line) + '</span><span class="hc__turnn">' + (n === 1 ? "1 reply" : n + " replies") + "</span></summary>" +
        '<div class="hc__turnbody">' + out.slice(from, to).join("") + "</div></details>")
    }
  }
  if (o.notSent) {
    out.push(me(o.notSent), them("hc__err", o.notSentWhy
      ? "<b>Not sent</b>" + esc(o.notSentWhy.replace(/[.\s]+$/, "")) + ". Your message is kept below; send it again."
      : "<b>Not sent</b>This node does not answer just now. Your message is kept below; send it again when it is back.", ""))
  }
  return out.join("")
}
