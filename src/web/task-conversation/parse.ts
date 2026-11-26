// --- The Task page's stream, as conversation parts (#2101 R16) ---
//
// The daemon writes a run's live output as text with a marker at the start
// of each event line (registry.ts makeStreamEventFormatter):
//
//   → Name({json})      a tool call (input clipped)
//   ← text / ← [error]  its result (newlines inside it are U+2028, R16)
//   💭 text             thinking
//   · text / . text     a system line (init, done, codex/opencode notes)
//   > codex … / < codex …  a codex item started / finished
//   [error] text        an error
//   [task finished]     the end marker
//
// Everything else is the reply, in markdown. A daemon before R16 wrote a
// multi-line result or thought over several lines; its later lines read as
// reply text, as on the old page: they cannot be told from the reply.
//
// Each part carries `at`, when its first line came in, read from the
// stream's stamps (output-stamps.ts, #2306); none when no stamp covers it.
//
// Pure: no DOM, so the tests run it in Node.

import { outStampAt, type OutStamp } from "../../agents/output-stamps"

export type Part = (
  | { kind: "text"; md: string }
  | { kind: "tool"; name: string; input: string; result?: string; error?: boolean; done: boolean }
  | { kind: "thought"; text: string }
  | { kind: "error"; text: string }
  | { kind: "system"; text: string }
) & { at?: number }

const LS = "\u2028"

/** One tool call line: `Name({json})`, input possibly clipped. */
export function splitToolLine(s: string): { name: string; input: string } {
  const o = s.indexOf("(")
  if (o <= 0) return { name: s.trim(), input: "" }
  const c = s.lastIndexOf(")")
  return { name: s.slice(0, o).trim(), input: c > o ? s.slice(o + 1, c) : s.slice(o + 1) }
}

export function parseStream(raw: string, opts: { plain?: (s: string) => string; final?: boolean; stamps?: OutStamp[] | null } = {}): Part[] {
  const plain = opts.plain || ((s: string) => s)
  const parts: Part[] = []
  // While the run goes, the last line may be half written: a marker line is
  // held back until its newline; reply text shows as it comes.
  const lines = raw.split("\n")
  let tail = ""
  if (!opts.final) tail = lines.pop() ?? ""
  let mode: "text" | "thought" | "other" = "text"
  const last = () => parts[parts.length - 1]
  const text = (line: string) => {
    const p = last()
    if (p && p.kind === "text") p.md += "\n" + line
    else parts.push({ kind: "text", md: line })
    mode = "text"
  }
  const openTool = (): Extract<Part, { kind: "tool" }> | undefined => {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      if (p.kind === "tool" && !p.done) return p
      if (p.kind === "text") break
    }
    return undefined
  }
  const marker = (line: string): boolean => {
    if (line.startsWith("→ ")) {
      const { name, input } = splitToolLine(line.slice(2))
      parts.push({ kind: "tool", name, input, done: false })
      mode = "other"
      return true
    }
    if (line.startsWith("← ")) {
      let body = line.slice(2)
      const error = body.startsWith("[error] ")
      if (error) body = body.slice(8)
      body = body.split(LS).join("\n")
      const t = openTool()
      if (t) { t.result = body; t.error = error; t.done = true }
      else parts.push({ kind: "tool", name: "tool", input: "", result: body, error, done: true })
      mode = "other"
      return true
    }
    if (line.startsWith("💭 ")) {
      const p = last()
      // "💭" is two UTF-16 units: the marker is three long.
      const body = line.slice("💭 ".length)
      if (p && p.kind === "thought" && mode === "thought") p.text += "\n" + body
      else parts.push({ kind: "thought", text: body })
      mode = "thought"
      return true
    }
    if (line.startsWith("[error] ")) { parts.push({ kind: "error", text: line.slice(8) }); mode = "other"; return true }
    if (line.startsWith("[task finished]")) { parts.push({ kind: "system", text: "task finished" }); mode = "other"; return true }
    if (line.startsWith("· ") || line.startsWith(". ")) { parts.push({ kind: "system", text: line.slice(2) }); mode = "other"; return true }
    if (line.startsWith("> codex ")) {
      parts.push({ kind: "tool", name: "codex", input: line.slice(8), done: false }); mode = "other"; return true
    }
    if (line.startsWith("< codex ")) {
      const t = openTool()
      if (t) { t.result = line.slice(8); t.done = true } else parts.push({ kind: "system", text: line.slice(2) })
      mode = "other"
      return true
    }
    return false
  }
  // Parts a line starts take the time that line came in.
  let off = 0
  const timed = (from: number, at: number) => {
    if (at) for (let k = from; k < parts.length; k++) parts[k].at = at
  }
  for (const line of lines) {
    const from = parts.length, at = opts.stamps ? outStampAt(opts.stamps, off) : 0
    off += line.length + 1
    // A blank line between events is not a reply.
    if (!marker(line) && !(line === "" && mode !== "text")) text(line)
    timed(from, at)
  }
  if (tail && !/^(→ |← |💭 |· |\. |> codex |< codex |\[error\] |\[task finished\])/.test(tail)) {
    const from = parts.length
    text(tail)
    timed(from, opts.stamps ? outStampAt(opts.stamps, off) : 0)
  }
  // Trim and clean reply parts; drop the empty ones.
  const out: Part[] = []
  for (const p of parts) {
    if (p.kind === "text") {
      const md = plain(p.md).replace(/^\n+|\s+$/g, "")
      if (md) out.push(p.at ? { kind: "text", md, at: p.at } : { kind: "text", md })
    } else out.push(p)
  }
  return out
}
