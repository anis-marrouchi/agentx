import type { Part } from "../parse"
import { Message } from "./Message"
import { Response } from "./Response"
import { Tool } from "./Tool"
import { ThinkingLoader } from "./ThinkingLoader"
import { Reasoning } from "./Reasoning"
import { When } from "./When"

// The run's output as its parts, one row each. Used by the old Task page's
// island (../main.tsx) and the Hub's Task page (src/hub/task, #2101 T2).
// Parts are keyed by kind and place: the stream only ever adds at the end,
// so a tool step the reader opened keeps its state while the run goes on
// (#2175), and never hands it to a part of another kind.
// Each part sits in a row with its time in one column on the right (#2306).
export function Parts({ parts, live }: { parts: Part[]; live: boolean }) {
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
