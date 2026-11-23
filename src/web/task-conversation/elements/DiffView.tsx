import { diffLines } from "diff"
import type { EditDiff } from "../tools"

// The diff an edit step made: removed lines red, added lines green, with
// line numbers counted from the start of the changed text. Orca shows edits
// the same way (a diff viewer, not the raw tool input).

export interface DiffRow { kind: "add" | "del" | "same"; text: string; a?: number; b?: number }

/** Rows for a before/after pair. Long unchanged runs fold to 3 lines each side. */
export function diffRows(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = []
  let a = 1, b = 1
  for (const ch of diffLines(before, after)) {
    const lines = ch.value.replace(/\n$/, "").split("\n")
    for (const text of lines) {
      if (ch.added) rows.push({ kind: "add", text, b: b++ })
      else if (ch.removed) rows.push({ kind: "del", text, a: a++ })
      else rows.push({ kind: "same", text, a: a++, b: b++ })
    }
  }
  return rows
}

export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0, removed = 0
  for (const r of rows) { if (r.kind === "add") added++; else if (r.kind === "del") removed++ }
  return { added, removed }
}

export function DiffView({ diff, rows }: { diff: EditDiff; rows: DiffRow[] }) {
  return (
    <div className="axc-diff" role="table" aria-label={`Changes to ${diff.file || "the file"}`}>
      {diff.file ? <div className="axc-diff__file">{diff.file}{diff.isNew ? " (new file)" : ""}</div> : null}
      <pre className="axc-diff__body">
        {rows.map((r, i) => (
          <div key={i} className={`axc-diff__row axc-diff__row--${r.kind}`} role="row">
            <span className="axc-diff__n" aria-hidden="true">{r.a ?? ""}</span>
            <span className="axc-diff__n" aria-hidden="true">{r.b ?? ""}</span>
            <span className="axc-diff__sign" aria-hidden="true">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
            <span className="axc-diff__text">{r.text || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}
