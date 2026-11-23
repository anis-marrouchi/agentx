import { useState } from "react"

// AI Elements' Reasoning: the agent's thinking, folded to one line.
export function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const first = text.split("\n")[0]
  return (
    <div className="axc-reason">
      <button type="button" className="axc-reason__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="axc-tool__chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="axc-reason__label">Thought</span>
        {!open ? <span className="axc-reason__peek">{first}</span> : null}
      </button>
      {open ? <div className="axc-reason__body">{text}</div> : null}
    </div>
  )
}
