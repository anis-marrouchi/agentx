import { useMemo, useState } from "react"
import type { Part } from "../parse"
import { editDiff, prettyInput, toolSummary } from "../tools"
import { DiffView, diffCounts, diffRows } from "./DiffView"

// AI Elements' Tool: one folded line per step (what it did, on what, and
// its state); open it for the input and the result. An edit shows its diff
// and is open by default, so the change is read without a click.

// The compact status treatment is adapted from affectUI’s clean Tool Call Card.
const stateLabels = { running: "Running", done: "Completed", stopped: "No result", error: "Failed" }

type ToolPart = Extract<Part, { kind: "tool" }>

export function Tool({ part, running }: { part: ToolPart; running: boolean }) {
  const { verb, object } = toolSummary(part.name, part.input)
  const diff = useMemo(() => editDiff(part.name, part.input), [part.name, part.input])
  const rows = useMemo(() => (diff ? diffRows(diff.before, diff.after) : null), [diff])
  const counts = rows ? diffCounts(rows) : null
  const [open, setOpen] = useState<boolean>(Boolean(diff))
  const state = part.error ? "error" : part.done ? "done" : running ? "running" : "stopped"
  return (
    <div className={`axc-tool axc-tool--${state}`}>
      <button type="button" className="axc-tool__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="axc-tool__chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="axc-tool__verb">{verb}</span>
        {object ? <span className="axc-tool__obj">{object}</span> : null}
        {counts ? (
          <span className="axc-tool__counts">
            <span className="axc-add">+{counts.added}</span> <span className="axc-del">−{counts.removed}</span>
          </span>
        ) : null}
        <span className="axc-tool__state ax-af-state" data-state={state}>
          {stateLabels[state]}
        </span>
      </button>
      {open ? (
        <div className="axc-tool__body">
          {diff && rows ? <DiffView diff={diff} rows={rows} /> : part.input ? (
            <pre className="axc-code axc-tool__input">{prettyInput(part.input)}</pre>
          ) : null}
          {part.result != null ? (
            <pre className={`axc-code axc-tool__result${part.error ? " is-err" : ""}`}>{part.result || "(empty)"}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
