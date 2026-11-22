// --- A unified diff, parsed for the Hub's Diff view (#2102) ---
//
// What GitHub's `application/vnd.github.diff` answers and what the GitLab
// review gate stitches from merge_requests/:iid/diffs (unifiedDiff): one or
// more files, each with its hunks. Each line keeps its old and new line
// numbers, so a comment can name `file:line` on either side. A binary file
// is listed with no hunks. "\ No newline at end of file" is not a line.

export type DiffLineKind = "add" | "del" | "ctx"

export interface DiffLine {
  kind: DiffLineKind
  /** Its number in the old file: context and deleted lines. */
  oldLine?: number
  /** Its number in the new file: context and added lines. */
  newLine?: number
  text: string
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export type DiffFileStatus = "added" | "removed" | "modified" | "renamed" | "binary"

export interface DiffFile {
  /** Its path: the new one, or the old one when it was removed. */
  file: string
  /** Its path before a rename. */
  oldFile?: string
  status: DiffFileStatus
  hunks: DiffHunk[]
  /** Some of its lines were left out to keep the answer bounded. */
  truncated?: boolean
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const GIT_HEADER = /^diff --git a\/(.*) b\/(.*)$/

const strip = (p: string): string => p.replace(/\t.*$/, "").replace(/^[ab]\//, "")

/** Every file of a unified diff, in order. */
interface FileDraft { from: string | null; to: string | null; added: boolean; removed: boolean; renamed: boolean; binary: boolean; hunks: DiffHunk[] }

/** Every file of a unified diff, in order. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: FileDraft[] = []
  let f: FileDraft | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0
  const start = (from: string | null, to: string | null): FileDraft => {
    const next: FileDraft = { from, to, added: false, removed: false, renamed: false, binary: false, hunks: [] }
    files.push(next)
    hunk = null
    oldLeft = newLeft = 0
    return next
  }
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "")
    // Inside a hunk, its counts say which lines are its own: a deleted
    // line that reads "-- x" is not a file header.
    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      const h: DiffHunk = hunk
      if (line.startsWith("\\")) continue
      const sign = line[0]
      const rest = line.slice(1)
      if (sign === "+") { h.lines.push({ kind: "add", newLine: newNo++, text: rest }); newLeft--; continue }
      if (sign === "-") { h.lines.push({ kind: "del", oldLine: oldNo++, text: rest }); oldLeft--; continue }
      if (sign === " " || line === "") { h.lines.push({ kind: "ctx", oldLine: oldNo++, newLine: newNo++, text: rest }); oldLeft--; newLeft--; continue }
      // Anything else ends the hunk early; read it as a header below.
      hunk = null
    }
    if (line.startsWith("\\")) continue
    const git = line.match(GIT_HEADER)
    if (git) { f = start(git[1], git[2]); continue }
    if (line.startsWith("--- ") && (!f || f.hunks.length > 0)) f = start(null, null)
    if (!f) continue
    const m = line.match(HUNK)
    if (m) {
      hunk = { header: line, lines: [] }
      f.hunks.push(hunk)
      oldNo = Number(m[1]); newNo = Number(m[3])
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
      continue
    }
    if (line.startsWith("--- ")) { const p = line.slice(4); if (p.startsWith("/dev/null")) f.added = true; else f.from = strip(p); continue }
    if (line.startsWith("+++ ")) { const p = line.slice(4); if (p.startsWith("/dev/null")) f.removed = true; else f.to = strip(p); continue }
    if (line.startsWith("new file mode")) { f.added = true; continue }
    if (line.startsWith("deleted file mode")) { f.removed = true; continue }
    if (line.startsWith("rename from ")) { f.from = line.slice(12); f.renamed = true; continue }
    if (line.startsWith("rename to ")) { f.to = line.slice(10); f.renamed = true; continue }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") { f.binary = true; continue }
  }
  return files.map((x) => {
    const file = (x.removed ? x.from ?? x.to : x.to ?? x.from) ?? ""
    const status: DiffFileStatus = x.binary ? "binary" : x.added ? "added" : x.removed ? "removed"
      : x.renamed || (x.from && x.to && x.from !== x.to) ? "renamed" : "modified"
    const out: DiffFile = { file, status, hunks: x.binary ? [] : x.hunks }
    if (x.from && x.to && x.from !== x.to && !x.added && !x.removed) out.oldFile = x.from
    return out
  }).filter((x) => x.file)
}

/** Files with at most `max` lines in all, cut file by file: a file past
 *  the limit keeps what fits and is marked, later files keep their header. */
export function capDiff(files: DiffFile[], max: number): { files: DiffFile[]; truncated: boolean } {
  let left = max
  let truncated = false
  const out = files.map((f) => {
    const total = f.hunks.reduce((n, h) => n + h.lines.length, 0)
    if (total <= left) { left -= total; return f }
    truncated = true
    const hunks: DiffHunk[] = []
    for (const h of f.hunks) {
      if (left <= 0) break
      const lines = h.lines.slice(0, left)
      left -= lines.length
      hunks.push({ header: h.header, lines })
    }
    return { ...f, hunks, truncated: true }
  })
  return { files: out, truncated }
}
