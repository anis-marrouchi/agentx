// --- What a tool step says in one line, and the diff an edit makes (#2101 R16) ---
//
// A tool call arrives as `Name({json})` with its input clipped (registry.ts:
// 400 characters, 8000 for edits), so the JSON may not parse. The one-line
// summary reads fields with a pattern that works on clipped JSON too.

export interface EditDiff { file: string; before: string; after: string; isNew: boolean }

function field(input: string, key: string): string {
  const m = input.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))
  if (!m) return ""
  try { return JSON.parse(`"${m[1]}"`) } catch { return m[1] }
}

function short(s: string, max = 90): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > max ? one.slice(0, max - 1) + "…" : one
}

function base(path: string): string {
  return path.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "")
}

/** `mcp__server__tool` → `tool (server)`. */
function toolLabel(name: string): string {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/)
  return m ? `${m[2]} (${m[1]})` : name
}

/** The verb and object a step reads as: "Read src/a.ts", "Ran npm test". */
export function toolSummary(name: string, input: string): { verb: string; object: string } {
  const file = field(input, "file_path") || field(input, "notebook_path") || field(input, "path")
  switch (name) {
    case "Read": return { verb: "Read", object: base(file) }
    case "Edit": case "MultiEdit": return { verb: "Edited", object: base(file) }
    case "Write": return { verb: "Wrote", object: base(file) }
    case "NotebookEdit": return { verb: "Edited notebook", object: base(file) }
    case "Bash": return { verb: "Ran", object: short(field(input, "description") || field(input, "command")) }
    case "Grep": return { verb: "Searched", object: short(field(input, "pattern"), 60) }
    case "Glob": return { verb: "Listed", object: short(field(input, "pattern"), 60) }
    case "WebFetch": return { verb: "Fetched", object: short(field(input, "url"), 70) }
    case "WebSearch": return { verb: "Searched the web", object: short(field(input, "query"), 70) }
    case "Task": case "Agent": return { verb: "Asked a helper", object: short(field(input, "description")) }
    case "TodoWrite": return { verb: "Updated the plan", object: "" }
    case "codex": return { verb: "Codex", object: short(input) }
    case "tool": return { verb: "Tool", object: "" }
    default: return { verb: toolLabel(name), object: short(field(input, "description") || field(input, "query") || field(input, "message") || "", 70) }
  }
}

/** The before and after of an edit, when its input is complete enough. */
export function editDiff(name: string, input: string): EditDiff | null {
  let obj: any
  try { obj = JSON.parse(input) } catch { return null }
  if (!obj || typeof obj !== "object") return null
  const file = String(obj.file_path || obj.notebook_path || "")
  if (name === "Edit" && typeof obj.old_string === "string" && typeof obj.new_string === "string") {
    return { file, before: obj.old_string, after: obj.new_string, isNew: false }
  }
  if (name === "MultiEdit" && Array.isArray(obj.edits)) {
    const before = obj.edits.map((e: any) => String(e?.old_string ?? "")).join("\n⋯\n")
    const after = obj.edits.map((e: any) => String(e?.new_string ?? "")).join("\n⋯\n")
    return { file, before, after, isNew: false }
  }
  if (name === "Write" && typeof obj.content === "string") return { file, before: "", after: obj.content, isNew: true }
  if (name === "NotebookEdit" && typeof obj.new_source === "string") return { file, before: "", after: obj.new_source, isNew: false }
  return null
}

/** The input as indented JSON when it parses, else as it came. */
export function prettyInput(input: string): string {
  try { return JSON.stringify(JSON.parse(input), null, 2) } catch { return input }
}
