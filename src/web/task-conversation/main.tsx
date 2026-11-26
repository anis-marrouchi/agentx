import css from "./styles.css"
import { createRoot, type Root } from "react-dom/client"
import { parseStream, type Part } from "./parse"
import { Conversation } from "./elements/Conversation"
import { Message } from "./elements/Message"
import { Response } from "./elements/Response"
import { Tool } from "./elements/Tool"
import { ThinkingLoader } from "./elements/ThinkingLoader"
import { Reasoning } from "./elements/Reasoning"
import { When } from "./elements/When"
import type { OutStamp } from "../../agents/output-stamps"

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
  /** The whole output again, after the stream came back (#2175). Parts
   *  that read the same keep their place, so an opened step stays open. */
  reset(text: string): void
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

// Parts are keyed by kind and place: the stream only ever adds at the end,
// so a tool step the reader opened keeps its state while the run goes on
// (#2175), and never hands it to a part of another kind.
// Each part sits in a row with its time in one column on the right (#2306).
function Parts({ parts, live }: { parts: Part[]; live: boolean }) {
  const lastText = parts.map((p) => p.kind).lastIndexOf("text")
  const now = Date.now()
  const body = (p: Part, i: number) => {
    const tail = i === parts.length - 1
    switch (p.kind) {
      case "text": return <div className="axc-reply"><Response md={p.md} streaming={live && i === lastText && tail} /></div>
      case "tool": return <Tool part={p} running={live && tail} />
      case "thought": return <Reasoning text={p.text} />
      case "error": return <div className="axc-error" role="alert"><strong>Error</strong> {p.text}</div>
      case "system": return <div className="axc-system">{p.text}</div>
    }
  }
  return (
    <Message from="assistant">
      {parts.map((p, i) => (
        <div key={p.kind + i} className={`axc-row axc-row--${p.kind}`}>
          <div className="axc-row__main">{body(p, i)}</div>
          <When at={p.at} now={now} />
        </div>
      ))}
      {live && parts.length === 0 ? <ThinkingLoader /> : null}
    </Message>
  )
}

/** opts.stamps: when each line of the output came in, kept by the page
 *  as the stream arrives (output-stamps.ts); read at each paint. */
function mount(el: HTMLElement, opts: { plain?: (s: string) => string; stamps?: () => OutStamp[] } = {}): Conv {
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
    const parts = parseStream(raw, { plain: opts.plain, final: !live, stamps: opts.stamps ? opts.stamps() : null })
    root.render(<Conversation scroller={el} tick={tick}><Parts parts={parts} live={live} /></Conversation>)
  }
  // One paint per frame: a chatty run sends hundreds of chunks a second.
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint) }
  paint()
  return {
    append(text: string) { if (!text) return; raw += text; schedule() },
    reset(text: string) { raw = String(text || ""); schedule() },
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
