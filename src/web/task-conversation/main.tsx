import css from "./styles.css"
import { createRoot, type Root } from "react-dom/client"
import { parseStream, type Part } from "./parse"
import { Conversation } from "./elements/Conversation"
import { Message } from "./elements/Message"
import { Response } from "./elements/Response"
import { Tool } from "./elements/Tool"
import { Reasoning } from "./elements/Reasoning"

// --- The Task page's conversation, as a React island (#2101 R16) ---
//
// The Task page (wall-task.client.ts mountTaskPage) loads this bundle and
// hands it the run's live output as it arrives from GET /api/task/stream.
// It renders with parts adapted from Vercel AI Elements (elements/NOTICE.md):
// the reply as markdown with highlighted code (Streamdown + Shiki), each
// tool step as one folded line, an edit as a diff, thinking folded.
// If the bundle does not load, the page keeps its own plain renderer.

export interface Conv {
  /** More of the run's output. */
  append(text: string): void
  /** The run ended (or the record of a finished run was loaded). */
  end(): void
  unmount(): void
}

function injectStyles(id: string, text: string): void {
  if (document.getElementById(id)) return
  const style = document.createElement("style")
  style.id = id
  style.textContent = text
  document.head.appendChild(style)
}

function Parts({ parts, live }: { parts: Part[]; live: boolean }) {
  const lastText = parts.map((p) => p.kind).lastIndexOf("text")
  return (
    <Message from="assistant">
      {parts.map((p, i) => {
        const tail = i === parts.length - 1
        switch (p.kind) {
          case "text": return <div key={i} className="axc-reply"><Response md={p.md} streaming={live && i === lastText && tail} /></div>
          case "tool": return <Tool key={i} part={p} running={live && tail} />
          case "thought": return <Reasoning key={i} text={p.text} />
          case "error": return <div key={i} className="axc-error" role="alert"><strong>Error</strong> {p.text}</div>
          case "system": return <div key={i} className="axc-system">{p.text}</div>
        }
      })}
      {live && parts.length === 0 ? <div className="axc-system">Waiting for the first words…</div> : null}
    </Message>
  )
}

function mount(el: HTMLElement, opts: { plain?: (s: string) => string } = {}): Conv {
  injectStyles("axc-styles", css as unknown as string)
  const host = document.createElement("div")
  host.className = "axc"
  el.appendChild(host)
  const root: Root = createRoot(host)
  let raw = ""
  let live = true
  let tick = 0
  let raf = 0
  const paint = () => {
    raf = 0
    tick++
    const parts = parseStream(raw, { plain: opts.plain, final: !live })
    root.render(<Conversation scroller={el} tick={tick}><Parts parts={parts} live={live} /></Conversation>)
  }
  // One paint per frame: a chatty run sends hundreds of chunks a second.
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint) }
  paint()
  return {
    append(text: string) { if (!text) return; raw += text; schedule() },
    end() { live = false; if (raf) cancelAnimationFrame(raf); paint() },
    unmount() { if (raf) cancelAnimationFrame(raf); root.unmount(); host.remove() },
  }
}

declare global {
  interface Window { AXTaskConversation?: { mount: typeof mount } }
}

window.AXTaskConversation = { mount }
// The Task page may have asked before the script arrived.
document.dispatchEvent(new Event("ax:task-conversation-ready"))
