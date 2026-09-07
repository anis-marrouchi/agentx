import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactElement } from "react"
import type { Workflow } from "./types"

// --- Workflow-builder chat widget ---
//
// Floating pill bottom-right of the workflow editor. Expands to a ~380×520
// chat panel. Messages post to POST /api/workflows/editor/chat which packs
// the V2 schema + environment (agents, actors, channels, existing
// workflows) into an agent prompt and returns { reply, workflow? }.
//
// When the reply contains a workflow JSON, an "Apply to canvas" button
// replaces the current graph via the onApplyWorkflow callback.

interface Message {
  role: "user" | "assistant"
  content: string
  workflow?: Workflow
  error?: string
  pending?: boolean
}

export interface ChatWidgetProps {
  /** Current workflow on canvas — sent along so the agent can iterate. */
  currentWorkflow: Workflow
  /** Called when the user clicks "Apply" on a generated workflow. */
  onApplyWorkflow: (wf: Workflow) => void
  /** Optional override of the authoring agent id. */
  agentId?: string
}

const STORAGE_KEY = "agentx.editor.chat.v1"

export function ChatWidget({ currentWorkflow, onApplyWorkflow, agentId }: ChatWidgetProps) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>(() => loadMessages())
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Persist non-pending messages only.
  useEffect(() => {
    const persistable = messages.filter((m) => !m.pending).map((m) => ({ role: m.role, content: m.content }))
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistable)) } catch { /* quota, etc */ }
  }, [messages])

  // Autoscroll to bottom on new message.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  // Focus input when opening.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    const history = messages.filter((m) => !m.pending).map((m) => ({ role: m.role, content: m.content }))
    const next: Message[] = [
      ...messages,
      { role: "user" as const, content: text },
      { role: "assistant" as const, content: "…", pending: true },
    ]
    setMessages(next)
    setInput("")
    setBusy(true)
    try {
      const r = await fetch("/api/workflows/editor/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          // CSRF gate on the board-dashboard server. Required on every
          // write to /api/*; safe no-op on the main daemon.
          "X-Requested-With": "agentx-board",
        },
        body: JSON.stringify({
          messages: [...history, { role: "user", content: text }],
          currentWorkflow,
          agentId,
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        setMessages((cur) => replaceLast(cur, { role: "assistant", content: "", error: data.error || `HTTP ${r.status}` }))
      } else {
        setMessages((cur) => replaceLast(cur, {
          role: "assistant",
          content: data.reply || "",
          workflow: data.workflow || undefined,
        }))
      }
    } catch (e: any) {
      setMessages((cur) => replaceLast(cur, { role: "assistant", content: "", error: e?.message || "network error" }))
    } finally {
      setBusy(false)
    }
  }, [agentId, busy, currentWorkflow, input, messages])

  const clear = () => {
    setMessages([])
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* */ }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send() }
  }

  const emptyPlaceholder = useMemo(() => [
    "Describe the process you want — I'll generate the workflow.",
    "",
    "Examples:",
    `• "Expense approval: employee submits form, manager approves over $500 otherwise auto-approve"`,
    `• "Telegram bot that classifies messages as billing/bug/other and routes to the right agent"`,
    `• "Triage a GitLab issue: label 'bug' → dev agent; label 'feature' → product agent; otherwise close"`,
  ].join("\n"), [])

  return (
    <>
      {!open && (
        <button
          className="ax-chat__pill"
          aria-label="Open workflow assistant"
          onClick={() => setOpen(true)}
        >
          <span className="ax-chat__pill-glyph">✨</span>
          <span className="ax-chat__pill-text">Ask AI to build…</span>
        </button>
      )}
      {open && (
        <div className="ax-chat__panel" role="dialog" aria-label="Workflow assistant">
          <header className="ax-chat__head">
            <div className="ax-chat__title">
              <span className="ax-chat__dot" /> Workflow assistant
            </div>
            <div className="ax-chat__head-actions">
              <button className="ax-chat__iconbtn" onClick={clear} title="Clear conversation">⌫</button>
              <button className="ax-chat__iconbtn" onClick={() => setOpen(false)} title="Collapse">▼</button>
            </div>
          </header>
          <div className="ax-chat__body" ref={listRef}>
            {messages.length === 0 && (
              <pre className="ax-chat__empty">{emptyPlaceholder}</pre>
            )}
            {messages.map((m, i) => (
              <MessageBubble key={i} m={m} onApply={onApplyWorkflow} />
            ))}
          </div>
          <footer className="ax-chat__foot">
            <textarea
              ref={inputRef}
              className="ax-chat__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Describe the workflow you want…  (Enter to send, Shift+Enter for newline)"
              rows={2}
              disabled={busy}
            />
            <button
              className="ax-chat__send"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
            >
              {busy ? "…" : "Send"}
            </button>
          </footer>
        </div>
      )}
      <style>{CSS}</style>
    </>
  )
}

function MessageBubble({ m, onApply }: { m: Message; onApply: (wf: Workflow) => void }): ReactElement {
  if (m.error) {
    return <div className="ax-chat__msg ax-chat__msg--err">⚠ {m.error}</div>
  }
  if (m.pending) {
    return <div className="ax-chat__msg ax-chat__msg--assistant ax-chat__msg--pending">
      <span className="ax-chat__typing"><span/><span/><span/></span>
    </div>
  }
  const cls = m.role === "user" ? "ax-chat__msg ax-chat__msg--user" : "ax-chat__msg ax-chat__msg--assistant"
  const content = stripAppliedJson(m.content, !!m.workflow)
  const html = m.role === "assistant" ? renderMarkdown(content) : escapeHtml(content)
  return (
    <div className={cls}>
      <div className="ax-chat__text" dangerouslySetInnerHTML={{ __html: html }} />
      {m.workflow && (
        <div className="ax-chat__apply">
          <button className="ax-chat__applybtn" onClick={() => onApply(m.workflow!)}>
            Apply to canvas
          </button>
          <span className="ax-chat__apply-hint">replaces the current workflow</span>
        </div>
      )}
    </div>
  )
}

/** Strip the JSON block when we extracted a workflow — the Apply button
 *  handles that payload, so showing the raw JSON is clutter. */
function stripAppliedJson(raw: string, hasWorkflow: boolean): string {
  if (!hasWorkflow) return raw
  return raw.replace(/```(?:json)?\s*\n[\s\S]*?```/g, "").trim()
}

/** Escape HTML entities so user text renders verbatim (no injection). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Minimal, inline markdown → HTML. Covers the subset that actually
 *  shows up in authoring-agent replies: code blocks, inline code, bold,
 *  italic, H1–H3, unordered + ordered lists, links, paragraphs.
 *
 *  Everything is HTML-escaped before the inline transforms run, so user
 *  / agent text can't inject tags. Code blocks are escaped + wrapped in
 *  <pre><code> with no further transforms. */
function renderMarkdown(src: string): string {
  // Extract fenced code blocks first so inline rules don't touch them.
  const codeBlocks: string[] = []
  let working = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
    const safe = escapeHtml(body.replace(/\n+$/, ""))
    const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : ""
    codeBlocks.push(`<pre><code${cls}>${safe}</code></pre>`)
    return ` CODE${codeBlocks.length - 1} `
  })

  working = escapeHtml(working)

  // Inline code (single backticks).
  working = working.replace(/`([^`\n]+)`/g, (_m, inner) => `<code>${inner}</code>`)
  // Links [text](url) — URL is still escaped from the HTML pass.
  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const safeHref = /^https?:\/\/|^\//.test(href) ? href : "#"
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${text}</a>`
  })
  // Bold + italic (bold first so ** wins over *).
  working = working.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
  working = working.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")

  // Block structure: headings, lists, paragraphs.
  const lines = working.split("\n")
  const out: string[] = []
  let listKind: "ul" | "ol" | null = null
  const closeList = () => { if (listKind) { out.push(`</${listKind}>`); listKind = null } }
  let paraBuf: string[] = []
  const flushPara = () => {
    if (!paraBuf.length) return
    const text = paraBuf.join(" ").trim()
    if (text) out.push(`<p>${text}</p>`)
    paraBuf = []
  }
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (/^\s*$/.test(line)) { flushPara(); closeList(); continue }
    const h = /^(#{1,3})\s+(.+)/.exec(line)
    if (h) { flushPara(); closeList(); const lvl = h[1].length + 2; out.push(`<h${lvl}>${h[2]}</h${lvl}>`); continue }
    const ul = /^\s*[-*]\s+(.+)/.exec(line)
    if (ul) {
      flushPara()
      if (listKind !== "ul") { closeList(); out.push("<ul>"); listKind = "ul" }
      out.push(`<li>${ul[1]}</li>`); continue
    }
    const ol = /^\s*\d+\.\s+(.+)/.exec(line)
    if (ol) {
      flushPara()
      if (listKind !== "ol") { closeList(); out.push("<ol>"); listKind = "ol" }
      out.push(`<li>${ol[1]}</li>`); continue
    }
    closeList()
    paraBuf.push(line)
  }
  flushPara(); closeList()

  let html = out.join("\n")
  // Restore fenced code-block placeholders.
  html = html.replace(/ CODE(\d+) /g, (_m, idx) => codeBlocks[Number(idx)] || "")
  return html
}

function replaceLast(cur: Message[], replacement: Message): Message[] {
  const next = [...cur]
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].pending || next[i].role === "assistant") {
      next[i] = replacement
      return next
    }
  }
  next.push(replacement)
  return next
}

function loadMessages(): Message[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
  } catch {
    return []
  }
}

const CSS = `
.ax-chat__pill {
  position: fixed; bottom: 18px; right: 18px; z-index: 40;
  display: flex; align-items: center; gap: 8px;
  background: linear-gradient(135deg, #6b5bff, #8b5cf6); color: white;
  border: 0; border-radius: 999px; padding: 10px 18px;
  font: 600 13px/1 system-ui, -apple-system, sans-serif;
  box-shadow: 0 10px 28px rgba(107,91,255,0.35);
  cursor: pointer; transition: transform 120ms ease, box-shadow 120ms ease;
}
.ax-chat__pill:hover { transform: translateY(-1px); box-shadow: 0 14px 34px rgba(107,91,255,0.45); }
.ax-chat__pill-glyph { font-size: 16px; line-height: 1; }

.ax-chat__panel {
  position: fixed; bottom: 18px; right: 18px; z-index: 40;
  width: 380px; height: 540px; max-height: calc(100vh - 40px);
  display: flex; flex-direction: column;
  background: var(--ax-bg, #fff); color: var(--ax-fg, #111);
  border: 1px solid var(--ax-border, rgba(0,0,0,0.15));
  border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0,0,0,0.25);
  overflow: hidden;
}
.ax-chat__head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ax-border, rgba(0,0,0,0.1));
  background: linear-gradient(135deg, rgba(107,91,255,0.08), rgba(139,92,246,0.04));
}
.ax-chat__title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
.ax-chat__dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; display: inline-block; }
.ax-chat__head-actions { display: flex; gap: 4px; }
.ax-chat__iconbtn {
  background: transparent; border: 0; cursor: pointer;
  padding: 4px 8px; font-size: 14px; color: var(--ax-muted, #666);
  border-radius: 4px;
}
.ax-chat__iconbtn:hover { background: rgba(127,127,127,0.15); color: var(--ax-fg); }

.ax-chat__body {
  flex: 1; overflow-y: auto; padding: 12px;
  display: flex; flex-direction: column; gap: 10px;
  font-size: 13px; line-height: 1.45;
}
.ax-chat__empty {
  font-size: 12px; color: var(--ax-muted, #777); white-space: pre-wrap;
  font-family: inherit; margin: 0;
}

.ax-chat__msg { max-width: 88%; padding: 8px 12px; border-radius: 10px; word-break: break-word; }
.ax-chat__msg--user {
  align-self: flex-end;
  background: linear-gradient(135deg, #6b5bff, #8b5cf6); color: white;
  border-bottom-right-radius: 2px;
}
.ax-chat__msg--assistant {
  align-self: flex-start;
  background: rgba(127,127,127,0.12);
  border-bottom-left-radius: 2px;
}
.ax-chat__msg--err { align-self: center; background: rgba(192,57,43,0.15); color: #c0392b; font-size: 12px; max-width: 100%; text-align: center; }
.ax-chat__msg--pending { min-height: 20px; }
.ax-chat__typing { display: inline-flex; gap: 4px; }
.ax-chat__typing span {
  width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.5;
  animation: axchatblink 1s infinite ease-in-out;
}
.ax-chat__typing span:nth-child(2) { animation-delay: 0.15s; }
.ax-chat__typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes axchatblink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

.ax-chat__text { margin: 0; }
.ax-chat__msg--user .ax-chat__text { white-space: pre-wrap; }

/* Assistant markdown surface ------------------------------------------- */
.ax-chat__msg--assistant .ax-chat__text > :first-child { margin-top: 0; }
.ax-chat__msg--assistant .ax-chat__text > :last-child  { margin-bottom: 0; }
.ax-chat__msg--assistant .ax-chat__text p { margin: 6px 0; }
.ax-chat__msg--assistant .ax-chat__text h3,
.ax-chat__msg--assistant .ax-chat__text h4,
.ax-chat__msg--assistant .ax-chat__text h5 {
  margin: 10px 0 4px; font-weight: 700; font-size: 13px;
}
.ax-chat__msg--assistant .ax-chat__text ul,
.ax-chat__msg--assistant .ax-chat__text ol {
  margin: 4px 0; padding-left: 20px;
}
.ax-chat__msg--assistant .ax-chat__text li { margin: 2px 0; }
.ax-chat__msg--assistant .ax-chat__text a {
  color: #6b5bff; text-decoration: underline; word-break: break-all;
}
.ax-chat__msg--assistant .ax-chat__text code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  background: rgba(0,0,0,0.08);
  padding: 1px 5px; border-radius: 4px;
}
.ax-chat__msg--assistant .ax-chat__text pre {
  margin: 6px 0; padding: 8px 10px;
  background: rgba(0,0,0,0.08);
  border-radius: 6px;
  overflow-x: auto; max-width: 100%;
}
.ax-chat__msg--assistant .ax-chat__text pre code {
  background: transparent; padding: 0; border-radius: 0;
  font-size: 11px; line-height: 1.45; white-space: pre;
}
@media (prefers-color-scheme: dark) {
  .ax-chat__msg--assistant .ax-chat__text code,
  .ax-chat__msg--assistant .ax-chat__text pre { background: rgba(255,255,255,0.06); }
}

.ax-chat__apply { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.ax-chat__applybtn {
  background: #22c55e; color: white; border: 0; border-radius: 6px;
  padding: 6px 10px; font: 600 12px/1 system-ui; cursor: pointer;
}
.ax-chat__applybtn:hover { background: #16a34a; }
.ax-chat__apply-hint { font-size: 10px; color: var(--ax-muted, #888); }

.ax-chat__foot {
  display: flex; gap: 8px; padding: 10px;
  border-top: 1px solid var(--ax-border, rgba(0,0,0,0.1));
}
.ax-chat__input {
  flex: 1; resize: none;
  font: inherit; padding: 8px 10px;
  border: 1px solid var(--ax-border, rgba(0,0,0,0.15));
  border-radius: 8px; background: var(--ax-bg); color: var(--ax-fg);
}
.ax-chat__input:focus { outline: 2px solid #8b5cf6; outline-offset: -1px; }
.ax-chat__send {
  background: #6b5bff; color: white; border: 0; border-radius: 8px;
  padding: 0 14px; font: 600 12px/1 system-ui; cursor: pointer;
}
.ax-chat__send:disabled { opacity: 0.4; cursor: not-allowed; }
.ax-chat__send:hover:not(:disabled) { background: #5b4bf0; }

@media (prefers-color-scheme: dark) {
  .ax-chat__panel { background: #1a1a1a; color: #eee; border-color: rgba(255,255,255,0.1); }
  .ax-chat__head { background: linear-gradient(135deg, rgba(107,91,255,0.15), rgba(139,92,246,0.08)); }
  .ax-chat__input { background: #2a2a2a; color: #eee; border-color: rgba(255,255,255,0.15); }
}
`
